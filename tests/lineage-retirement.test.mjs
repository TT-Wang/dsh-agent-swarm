/**
 * An independently accepted replacement carries every obligation of its whole
 * replaced lineage: the `replaces` chain back to its roots, both parents of a
 * multi-parent repair included. Pre-fix only the task it named directly was
 * retired, so in a chain A, R1, R2 accepting R2 cancelled R1 but left A and A's
 * rejecting review blocked, and completion was refused until the owner
 * cancelled them (docs/known-limitations.md, round 23).
 *
 * Guards: accepted, running, submitted and stopping rows are never retired; a
 * live sibling replacement (a fork) is left alone and named; host recovery
 * replays the retirement once, only for an acceptance recorded before the rule
 * (no `lineageRetired` marker), and before it re-pends anything, so a restart
 * never retires work the verdict left live.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeClock, MISSION_ACCEPTANCE, SwarmRuntime, FakeWorkers, acceptThroughReview, blockThroughReview, events, makeRuntime, taskOf } from './faults/harness.mjs'

async function fixture(t) {
  const made = await makeRuntime(t, { clock: new FakeClock(), budget: { maxWorkers: 4 } })
  const owner = { sessionId: 'lineage-owner' }
  const f = { ...made, owner, actor: member => ({ sessionId: member.sessionId }) }
  await f.runtime.start()
  f.mission = f.runtime.create(owner, { title: 'Lineage retirement', objective: 'Retire superseded repair chains', workspace: made.dir, scope: ['**'], acceptance: MISSION_ACCEPTANCE, budget: made.budget })
  f.stream = f.runtime.workstream(owner, f.mission.id, { title: 'Main', objective: 'Main' })
  f.author = await f.runtime.addMember(owner, f.mission.id, { name: 'Author', role: 'implementation', maxOutputTokens: 5_000 })
  f.reviewer = await f.runtime.addMember(owner, f.mission.id, { name: 'Reviewer', role: 'verification', maxOutputTokens: 5_000 })
  f.propose = (extra = {}) => f.runtime.propose(owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Implement', objective: 'Implement the scoped change',
    kind: 'implementation', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: ['test -d .'], assigneeId: f.author.id, ...extra })
  f.status = id => taskOf(f.runtime, id).status
  f.superseded = () => events(f.runtime, f.mission.id, 'task/superseded').map(event => event.data)
  f.write = (id, change) => { const row = taskOf(f.runtime, id); f.runtime.store.transaction(() => f.runtime.store.put('tasks', { ...row, ...change })) }
  /** Reopen the same state file, as a host restart does; the caller disposes the last runtime. */
  f.restart = async () => {
    await f.runtime.dispose()
    f.runtime = new SwarmRuntime(f.config, new FakeWorkers())
    await f.runtime.start()
  }
  return f
}

/** A, rejected; R1 replacing A, rejected; R2 replacing R1, still pending. */
async function rejectedChain(f) {
  const a = f.propose({ title: 'Original' })
  const reviewA = await blockThroughReview(f, a)
  const r1 = f.propose({ title: 'First repair', replaces: [a.id] })
  const reviewR1 = await blockThroughReview(f, r1)
  const r2 = f.propose({ title: 'Second repair', replaces: [r1.id] })
  return { a, reviewA, r1, reviewR1, r2 }
}

test('an accepted second repair retires the whole chain, and the mission completes with no owner cancel', async t => {
  const f = await fixture(t)
  const { a, reviewA, r1, reviewR1, r2 } = await rejectedChain(f)
  const verdictA = structuredClone(taskOf(f.runtime, reviewA.id))
  const earlier = new Set(f.runtime.store.list('deliveries', f.mission.id).map(delivery => delivery.id))
  await acceptThroughReview(f, r2)
  await f.runtime.settle(f.mission.id)
  for (const task of [a, reviewA, r1, reviewR1]) assert.equal(f.status(task.id), 'cancelled', `${task.title} is retired by the accepted repair`)
  assert.ok(taskOf(f.runtime, reviewA.id).output.startsWith(verdictA.output), 'the historical rejection verdict is kept')
  assert.equal(taskOf(f.runtime, reviewA.id).reviewedCommit, verdictA.reviewedCommit)
  assert.deepEqual(f.superseded().map(data => [data.taskId, data.supersededBy, data.previousStatus]).sort(),
    [[a.id, r2.id, 'blocked'], [r1.id, r2.id, 'blocked']].sort(), 'one durable event per retired task names the accepted replacement')
  // Retired rows are terminal, so the owner-notice classifiers stop naming them.
  const tasks = f.runtime.store.list('tasks', f.mission.id)
  assert.deepEqual(f.runtime.notices.stallRoots(tasks).map(task => task.id), [], 'no retired row is a stall root')
  await f.runtime.tick(); await f.runtime.settle(f.mission.id)
  const retiredIds = [a.id, reviewA.id, r1.id, reviewR1.id]
  const naming = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => !earlier.has(delivery.id)
    && /^(stall-root|fallthrough):/.test(delivery.notice?.dedupKey ?? '') && (delivery.subjects ?? []).some(subject => retiredIds.some(id => subject.startsWith(`${id}@`))))
  assert.deepEqual(naming.map(delivery => delivery.notice.dedupKey), [], 'no stall-root or fall-through notice names a retired row')
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'The accepted repair covers the mission').status, 'completed')
})

test('a multi-parent repair retires both parents and the chain behind them', async t => {
  const f = await fixture(t)
  const a = f.propose({ title: 'Original' })
  const reviewA = await blockThroughReview(f, a)
  const a1 = f.propose({ title: 'Repair of the original', replaces: [a.id] })
  const reviewA1 = await blockThroughReview(f, a1)
  const b = f.propose({ title: 'Sibling' })
  const reviewB = await blockThroughReview(f, b)
  const merged = f.propose({ title: 'Merged repair', replaces: [a1.id, b.id] })
  await acceptThroughReview(f, merged)
  for (const task of [a, reviewA, a1, reviewA1, b, reviewB]) assert.equal(f.status(task.id), 'cancelled', `${task.title} is retired`)
  assert.deepEqual(f.superseded().map(data => data.taskId).sort(), [a.id, a1.id, b.id].sort(), 'each retired task has exactly one event')
  assert.ok(f.superseded().every(data => data.supersededBy === merged.id), 'every event names the merged repair')
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'The merged repair covers the mission').status, 'completed')
})

test('a fork: a live sibling replacement is left alone and named, while the blocked root is retired', async t => {
  const f = await fixture(t)
  const builder = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5_000 })
  const a = f.propose({ title: 'Original' })
  const reviewA = await blockThroughReview(f, a)
  const r1 = f.propose({ title: 'First repair', replaces: [a.id] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: r1.id, reason: 'Wrong approach' })
  const sibling = f.propose({ title: 'Sibling repair', replaces: [a.id], assigneeId: builder.id })
  const claimed = await f.runtime.claim(f.actor(builder), f.mission.id, sibling.id)
  const r2 = f.propose({ title: 'Repair of the withdrawn repair', replaces: [r1.id] })
  await acceptThroughReview(f, r2)
  assert.equal(f.status(a.id), 'cancelled', 'the blocked root is carried by the accepted repair')
  assert.equal(f.status(reviewA.id), 'cancelled', 'its rejecting review is retired with it')
  const live = taskOf(f.runtime, sibling.id)
  assert.equal(live.status, 'running', 'the sibling replacement keeps running')
  assert.equal(live.attempt?.id, claimed.attempt.id, 'its attempt is untouched')
  assert.equal(live.epoch, claimed.epoch)
  assert.deepEqual(f.superseded(), [{ taskId: a.id, supersededBy: r2.id, previousStatus: 'blocked', liveReplacements: [sibling.id] }],
    'only the row retired now has an event, and it names the live sibling')
  assert.match(taskOf(f.runtime, a.id).output, new RegExp(`live replacement ${sibling.id} left alone`))
  assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'premature'),
    error => error.message.includes(sibling.id) && !error.message.includes(`${a.id} (`), 'completion waits on the live sibling only')
})

test('accepted, running and submitted rows in a lineage are never retired, and the verdict still records', async t => {
  const f = await fixture(t)
  const builder = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5_000 })
  const { a, reviewA, r1, r2 } = await rejectedChain(f)
  const done = f.propose({ title: 'Accepted work' })
  await acceptThroughReview(f, done)
  const running = f.propose({ title: 'Running work', assigneeId: builder.id })
  const claimed = await f.runtime.claim(f.actor(builder), f.mission.id, running.id)
  // Imported history: the first repair came back as a submitted fork, and the
  // accepted repair also names accepted and running rows as its parents.
  f.write(r1.id, { status: 'submitted' })
  f.write(r2.id, { replaces: [r1.id, done.id, running.id] })
  await acceptThroughReview(f, r2)
  assert.equal(f.status(r1.id), 'submitted', 'a submitted fork awaits its own review')
  assert.equal(f.status(done.id), 'accepted', 'accepted work is immutable')
  assert.equal(taskOf(f.runtime, running.id).attempt?.id, claimed.attempt.id, 'a running attempt is untouched')
  assert.equal(f.status(a.id), 'cancelled', 'the blocked root behind the fork is still carried by the accepted repair')
  assert.equal(f.status(reviewA.id), 'cancelled')
  assert.deepEqual(f.superseded().map(data => data.taskId), [a.id])
})

test('restart in the middle of a chain: the retirement reads only durable rows', async t => {
  const f = await fixture(t)
  const { a, reviewA, r1, reviewR1, r2 } = await rejectedChain(f)
  await f.restart()
  try {
    await acceptThroughReview(f, r2)
    for (const task of [a, reviewA, r1, reviewR1]) assert.equal(f.status(task.id), 'cancelled', `${task.title} is retired after the restart`)
    assert.deepEqual(f.superseded().map(data => data.taskId).sort(), [a.id, r1.id].sort())
  } finally { await f.runtime.dispose() }
})

test('a store left with an accepted repair and a blocked chain is retired at restart, and a second restart replays nothing', async t => {
  const f = await fixture(t)
  const { a, reviewA, r1, reviewR1, r2 } = await rejectedChain(f)
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, r2.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: r2.id, attemptId: claimed.attempt.id, output: 'accepted before this rule existed' })
  // The durable state a build without whole-lineage retirement left behind.
  f.write(r2.id, { status: 'accepted' })
  await f.restart()
  try {
    for (const task of [a, reviewA, r1, reviewR1]) assert.equal(f.status(task.id), 'cancelled', `${task.title} is retired on recovery`)
    assert.deepEqual(f.superseded().map(data => [data.taskId, data.supersededBy]).sort(), [[a.id, r2.id], [r1.id, r2.id]].sort())
    const rows = () => f.runtime.store.list('tasks', f.mission.id)
    const retirements = () => f.runtime.store.events(f.mission.id, 5_000).filter(event => ['task/superseded', 'task/review-retired'].includes(event.type)).length
    const [board, written] = [rows(), retirements()]
    await f.restart()
    assert.deepEqual(rows(), board, 'a replay changes no row')
    assert.equal(retirements(), written, 'a replay writes no second retirement')
    assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'The accepted repair covers the mission').status, 'completed')
  } finally { await f.runtime.dispose() }
})

/** Imported history admission no longer produces: `task` claimed by `member`, then left mid-handoff with its stop still owed. */
async function stopping(f, task, member) {
  const claimed = await f.runtime.claim(f.actor(member), f.mission.id, task.id)
  const epoch = claimed.epoch + 1
  f.write(task.id, { status: 'blocked', epoch, attempt: undefined, resumeAfterStop: { epoch, memberId: member.id, reason: 'handoff', at: f.clock.now() } })
}

test('work still running or stopping when its carrier is accepted stays live through the verdict and a restart', async t => {
  const f = await fixture(t)
  const builder = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5_000 })
  const helper = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Helper', role: 'implementation', maxOutputTokens: 5_000 })
  const running = f.propose({ title: 'Running original', assigneeId: builder.id })
  const claimed = await f.runtime.claim(f.actor(builder), f.mission.id, running.id)
  const handingOff = f.propose({ title: 'Stopping original', assigneeId: helper.id })
  await stopping(f, handingOff, helper)
  const repair = f.propose({ title: 'Repair of both' })
  f.write(repair.id, { replaces: [running.id, handingOff.id] })
  await acceptThroughReview(f, repair)
  assert.equal(taskOf(f.runtime, running.id).attempt?.id, claimed.attempt.id, 'the verdict leaves the running attempt alone')
  assert.notEqual(f.status(handingOff.id), 'cancelled', 'the verdict never retires a row whose stop is still owed')
  assert.equal(taskOf(f.runtime, repair.id).lineageRetired, true, 'the verdict marks the acceptance whose lineage it retired')
  await f.restart()
  try {
    assert.equal(f.status(running.id), 'pending', 'recovery re-pends the running row like any other and does not retire it')
    assert.notEqual(f.status(handingOff.id), 'cancelled', 'recovery finishes the owed stop and does not retire the row')
    assert.deepEqual(f.superseded(), [], 'neither the verdict nor recovery retired live work')
  } finally { await f.runtime.dispose() }
})

test('recovery replays the retirement once, only for an acceptance recorded before the rule, and spares work live at the crash', async t => {
  const f = await fixture(t)
  const builder = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5_000 })
  const helper = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Helper', role: 'implementation', maxOutputTokens: 5_000 })
  const { a, r1, r2 } = await rejectedChain(f)
  const running = f.propose({ title: 'Running original', assigneeId: builder.id })
  await f.runtime.claim(f.actor(builder), f.mission.id, running.id)
  const handingOff = f.propose({ title: 'Stopping original', assigneeId: helper.id })
  await stopping(f, handingOff, helper)
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, r2.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: r2.id, attemptId: claimed.attempt.id, output: 'accepted before this rule existed' })
  // The durable state a build without whole-lineage retirement left: accepted, unmarked.
  f.write(r2.id, { status: 'accepted', replaces: [r1.id, running.id, handingOff.id] })
  await f.restart()
  try {
    for (const task of [a, r1]) assert.equal(f.status(task.id), 'cancelled', `${task.title}, blocked at the crash, is retired`)
    assert.equal(f.status(running.id), 'pending', 'the row running at the crash is re-pended, not retired')
    assert.notEqual(f.status(handingOff.id), 'cancelled', 'the row stopping at the crash is not retired')
    assert.equal(taskOf(f.runtime, r2.id).lineageRetired, true, 'the replay marks the acceptance it repaired')
    assert.deepEqual(f.superseded().map(data => data.taskId).sort(), [a.id, r1.id].sort())
    await f.restart()
    assert.equal(f.status(running.id), 'pending', 'a second restart replays nothing, so the re-pended row is still not retired')
    assert.deepEqual(f.superseded().map(data => data.taskId).sort(), [a.id, r1.id].sort())
  } finally { await f.runtime.dispose() }
})
