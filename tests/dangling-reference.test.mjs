/**
 * T1: an id a stored row holds that names no task of its mission (a dependency
 * or a review source a corrupted store left dangling) is stuck work the owner
 * is told about, never a refusal the runtime throws at itself.
 *
 * Before, the task graph had a second, refusing form of its reads
 * (`taskOf`/`lineageOf`/`effectiveOf`/`dependencyMetOf`, which threw
 * `task_not_in_mission`) and the decisions over stored rows asked it: one such
 * row made readiness, `unschedulable` and observe throw, so every tick logged
 * "decision sweep failed", no pass finished, no owner notice was told, and the
 * owner's own exits (cancelling other work, a challenge) threw too. Now the
 * graph has one plain form: an id that names no task reads as no task, so it
 * is an unmet prerequisite, `unschedulable` holds its task as dead, the board
 * names it, and observe renders the edge as `{ id, status: 'missing' }`. A
 * caller's id is still refused where it enters (`SwarmRuntime.task`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertNamedCalls, ownerTools } from './refusal-inventory.mjs'
import { FakeClock, MISSION_ACCEPTANCE, events, setup, taskOf } from './faults/harness.mjs'

/**
 * A fixture runtime on the fake clock, with every line the runtime logs
 * collected: a failed tick, a failed decision sweep, and a deferred scheduling
 * pass that threw (`Kernel.defer` logs it as `[agent-swarm] <error>`).
 */
async function fixture(t, options = {}) {
  const f = await setup({ clock: new FakeClock(), ...options })
  const failures = [], write = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => { if (String(chunk).startsWith('[agent-swarm] ')) { failures.push(String(chunk)); return true } return write(chunk, ...rest) }
  t.after(async () => { process.stderr.write = write; await f.cleanup() })
  return { ...f, failures, tool: await ownerTools(f) }
}

/** One tick of the runtime clock, settled. */
async function tick(f) {
  f.clock.advance(f.runtime.config.tickMs)
  await f.runtime.tick()
  await f.runtime.settle(f.mission.id)
}

/** A fresh pending row copied from `from` with `fields`, written as only a corrupted store holds it: no runtime path admits a dangling edge. */
function inject(f, from, fields) {
  const row = { ...taskOf(f.runtime, from.id), status: 'pending', epoch: 0, attempt: undefined, assigneeId: undefined, plannedAssigneeId: undefined,
    artifact: undefined, evidenceIds: [], output: undefined, ...fields }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', row))
  return row
}

const ownerNotices = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner')
const missing = id => ({ id, status: 'missing' })
/** The error a call is refused with; the call must be refused. */
const refusal = promise => promise.then(value => assert.fail(`not refused: ${JSON.stringify(value)}`), error => error)
/** The repair both notices name ("admit a repair or review with swarm_propose"), proposed through the owner's registered tool. */
const repair = (f, task) => f.tool('swarm_propose', { workstreamId: f.stream.id, title: `Repair ${task.title}`, objective: 'Implement the scoped change', kind: 'implementation',
  scope: ['**'], outputs: [], acceptance: MISSION_ACCEPTANCE, covers: MISSION_ACCEPTANCE.map((_, index) => `c${index + 1}`), checks: ['test -d .'], replaces: [task.id] })

test('a stored dependency or review source that names no task on an idle board: within one tick the owner is told, no pass fails, and observe and snapshot answer', async t => {
  const f = await fixture(t)
  const template = f.propose({ title: 'Withdrawn first' })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: template.id, reason: 'leave the board idle' })
  const dangling = inject(f, template, { id: 'task_dangling', title: 'Depends on nothing', dependencies: ['task_missing'] })
  const review = inject(f, template, { id: 'task_dangling_review', title: 'Reviews nothing', kind: 'verification', reviewOf: 'task_missing_source', covers: undefined })
  await tick(f)
  assert.deepEqual(f.failures, [], 'no pass fails on the board')
  const stall = events(f.runtime, f.mission.id, 'mission/stalled').at(-1)
  assert.deepEqual([...stall?.data.unschedulable ?? []].sort(), [dangling.id, review.id], `the W3 stall holds both as unschedulable: ${JSON.stringify(stall?.data)}`)
  const notice = ownerNotices(f).find(delivery => delivery.notice?.dedupKey === stall.data.noticeKey)
  assert.ok(notice?.subjects.includes(`${dangling.id}@0`) && notice.subjects.includes(`${review.id}@0`), 'the owner notice names both')
  assert.match(notice.content, /task_dangling \(implementation, pending, depends on task_missing\)/, 'and the edge that names no task')
  assert.match(notice.content, /task_dangling_review \(verification, pending, reviews task_missing_source\)/, 'and the review source that names no task')
  const board = f.runtime.observe(f.owner, f.mission.id)
  assert.deepEqual([...board.unschedulable].sort(), [dangling.id, review.id], 'the owner board names both unschedulable')
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id, { taskId: dangling.id }).dependencies, [missing('task_missing')], 'the dependency renders as missing')
  assert.ok(f.runtime.snapshot(f.owner, f.mission.id).tasks.some(task => task.id === dangling.id && task.dependencies[0] === 'task_missing'), 'the snapshot carries the row as stored')
})

test('the readiness refusal names the missing dependency, and the owner\'s amendment exit makes the task ready', async t => {
  const f = await fixture(t)
  const dangling = inject(f, f.propose({ title: 'Template' }), { id: 'task_dangling', title: 'Depends on nothing', dependencies: ['task_missing'] })
  const refused = await refusal(f.runtime.claim(f.actor(f.author), f.mission.id, dangling.id))
  assert.equal(refused.code, 'task_not_ready')
  assert.ok(refused.message.includes('dependency task_missing names no task in this mission'), refused.message)
  await assertNamedCalls(refused.message, ['swarm_control', 'swarm_cancel'])
  // A proposal reaching the edge is refused by the one graph validator, which names it.
  assert.throws(() => f.propose({ title: 'Behind the dangling task', dependencies: [dangling.id] }), error => error.code === 'task_graph_invalid'
    && error.diagnostics.some(diagnostic => diagnostic.code === 'task_graph_unknown_edge' && diagnostic.path === 'task_missing'), 'the unknown edge is named')
  await f.tool('swarm_control', { action: 'amend', taskId: dangling.id, changes: { dependencies: [] }, reason: 'the prerequisite does not exist' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, dangling.id)
  assert.equal(claimed.status, 'running', 'the amended task is ready and claimed')
})

test('a review source that names no task under running work: the fall-through names it, its refusal names the withdrawal, and withdrawing it leaves other dangling work standing', async t => {
  const f = await fixture(t)
  const running = f.propose({ title: 'Running work' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, running.id)
  const review = inject(f, running, { id: 'task_dangling_review', title: 'Reviews nothing', kind: 'verification', reviewOf: 'task_missing_source', covers: undefined })
  const dependent = inject(f, running, { id: 'task_dangling_dependent', title: 'Depends on nothing', dependencies: ['task_missing'] })
  await tick(f)
  assert.deepEqual(f.failures, [], 'no tick fails on the board')
  const named = ownerNotices(f).find(delivery => /no live path will advance/.test(delivery.content))
  assert.ok(named?.subjects.includes(`${review.id}@0`) && named.subjects.includes(`${dependent.id}@0`), `the fall-through names both: ${JSON.stringify(named?.subjects)}`)
  const refused = await refusal(f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id))
  assert.equal(refused.code, 'task_not_ready')
  assert.ok(refused.message.includes('review source task_missing_source names no task in this mission'), refused.message)
  await assertNamedCalls(refused.message, ['swarm_cancel'])
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id, { taskId: review.id }).reviewSource, missing('task_missing_source'), 'the review source renders as missing')
  await f.tool('swarm_cancel', { taskId: review.id, reason: 'its source does not exist' })
  assert.equal(taskOf(f.runtime, review.id).status, 'cancelled', 'the withdrawal exit works while another dangling row stands')
  await f.tool('swarm_cancel', { taskId: dependent.id, reason: 'its prerequisite does not exist' })
  assert.equal(taskOf(f.runtime, dependent.id).status, 'cancelled')
})

test('the exits the W3 stall names for dangling work, performed with the owner\'s registered tools: the swarm_propose repair is refused for pending work, while amending away the dependency makes the task ready and withdrawing the review retires it', async t => {
  const f = await fixture(t)
  const template = f.propose({ title: 'Withdrawn first' })
  await f.tool('swarm_cancel', { taskId: template.id, reason: 'leave the board idle' })
  const dangling = inject(f, template, { id: 'task_dangling', title: 'Depends on nothing', dependencies: ['task_missing'] })
  const review = inject(f, template, { id: 'task_dangling_review', title: 'Reviews nothing', kind: 'verification', reviewOf: 'task_missing_source', covers: undefined })
  await tick(f)
  const stall = ownerNotices(f).find(delivery => delivery.notice?.dedupKey === events(f.runtime, f.mission.id, 'mission/stalled').at(-1)?.data.noticeKey)
  assert.ok(stall?.subjects.includes(`${dangling.id}@0`) && stall.subjects.includes(`${review.id}@0`), 'the W3 stall names both')
  assert.match(stall.content, /amend the existing task dependencies or assignee with swarm_control/, 'it names the amendment')
  assert.match(stall.content, /withdraw it explicitly with swarm_cancel/, 'and the withdrawal')
  assert.match(stall.content, /admit a repair or review with swarm_propose/, 'and a repair')
  // Only blocked or cancelled work can be replaced, so the repair clears nothing here.
  assert.equal((await refusal(repair(f, dangling))).code, 'replacement_source_not_blocked', 'the repair of pending work is refused')
  assert.deepEqual([...(await f.tool('swarm_observe', {})).unschedulable].sort(), [dangling.id, review.id], 'and both stay unschedulable')
  await f.tool('swarm_control', { action: 'amend', taskId: dangling.id, changes: { dependencies: [] }, reason: 'the prerequisite does not exist' })
  await f.tool('swarm_cancel', { taskId: review.id, reason: 'its source does not exist' })
  await tick(f)
  assert.deepEqual(f.failures, [], 'no pass fails on the board')
  assert.deepEqual((await f.tool('swarm_observe', {})).unschedulable, [], 'the owner board holds nothing unschedulable')
  assert.equal(taskOf(f.runtime, review.id).status, 'cancelled', 'the review is withdrawn')
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, dangling.id)
  assert.equal(claimed.status, 'running', 'the amended task is ready and claimed')
})

test('the exits the fall-through names for a dependency that names no task, performed with the owner\'s registered tools: the swarm_propose repair is refused for pending work, inspecting the board shows the edge missing, and amending it away with swarm_control takes the task off the unschedulable list', async t => {
  const f = await fixture(t)
  const running = f.propose({ title: 'Running work' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, running.id)
  const dangling = inject(f, running, { id: 'task_dangling', title: 'Depends on nothing', dependencies: ['task_missing'] })
  await tick(f)
  const named = ownerNotices(f).find(delivery => /no live path will advance/.test(delivery.content))
  assert.ok(named?.subjects.includes(`${dangling.id}@0`), `the fall-through names it: ${JSON.stringify(named?.subjects)}`)
  assert.ok(named.content.includes('Inspect the board, admit a repair or review with swarm_propose, decide with swarm_control, or withdraw the stuck work with swarm_cancel(taskId, reason)'),
    'it names inspecting the board, a repair, a swarm_control decision and the withdrawal')
  // Only blocked or cancelled work can be replaced, so the repair clears nothing here.
  assert.equal((await refusal(repair(f, dangling))).code, 'replacement_source_not_blocked', 'the repair of pending work is refused')
  assert.deepEqual((await f.tool('swarm_observe', { taskId: dangling.id })).dependencies, [missing('task_missing')], 'the board shows the edge that names no task')
  assert.ok((await f.tool('swarm_observe', {})).unschedulable.includes(dangling.id), 'and holds the task unschedulable')
  await f.tool('swarm_control', { action: 'amend', taskId: dangling.id, changes: { dependencies: [] }, reason: 'the prerequisite does not exist' })
  await tick(f)
  assert.deepEqual(f.failures, [], 'no pass fails on the board')
  assert.ok(!(await f.tool('swarm_observe', {})).unschedulable.includes(dangling.id), 'the amended task is no longer unschedulable')
  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, dangling.id)
  assert.equal(claimed.status, 'running', 'and is ready')
})

test('the exits the fall-through names for a pending review whose source names no task, performed with the owner\'s registered tools: the swarm_propose repair and the swarm_control amendment are refused, and withdrawing the stuck work with swarm_cancel(taskId, reason) clears it and retires the fall-through', async t => {
  const f = await fixture(t)
  const running = f.propose({ title: 'Running work' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, running.id)
  const review = inject(f, running, { id: 'task_dangling_review', title: 'Reviews nothing', kind: 'verification', reviewOf: 'task_missing_source', covers: undefined })
  await tick(f)
  const named = ownerNotices(f).find(delivery => /no live path will advance/.test(delivery.content))
  assert.deepEqual(named?.subjects, [`${review.id}@0`], 'the fall-through names the review')
  // The one exit written as a call is checked against the published swarm_cancel schema.
  await assertNamedCalls(named.content, ['swarm_cancel'])
  const outstanding = () => f.runtime.notices.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), f.runtime.store.get('deliveries', named.id))
  assert.equal(outstanding(), true, 'the fall-through is outstanding')
  assert.equal((await refusal(repair(f, review))).code, 'replacement_source_verification', 'a repair of the review is refused')
  const amended = await refusal(f.tool('swarm_control', { action: 'amend', taskId: review.id, changes: { assigneeId: f.author.id }, reason: 'reassign the review' }))
  assert.ok(amended.code === 'task_graph_invalid' && amended.diagnostics.some(diagnostic => diagnostic.code === 'task_graph_unknown_edge' && diagnostic.path === 'task_missing_source'),
    'an amendment is refused naming the edge')
  assert.deepEqual([(await f.tool('swarm_observe', {})).unschedulable, outstanding()], [[review.id], true], 'the refused exits clear nothing')
  await f.tool('swarm_cancel', { taskId: review.id, reason: 'its source does not exist' })
  assert.equal(taskOf(f.runtime, review.id).status, 'cancelled', 'the withdrawal clears the review')
  assert.equal(outstanding(), false, 'and retires the fall-through')
  await tick(f)
  assert.deepEqual(f.failures, [], 'no pass fails on the board')
  assert.deepEqual((await f.tool('swarm_observe', {})).unschedulable, [], 'the owner board holds nothing unschedulable')
  assert.deepEqual(ownerNotices(f).filter(delivery => /no live path will advance/.test(delivery.content)).map(delivery => delivery.id), [named.id], 'and no further fall-through is told')
})

test('pending work holding an id that names no task beside live edges is dead whatever else it waits on: the fall-through names it within one tick, and its refusal names that edge first', async t => {
  const f = await fixture(t)
  const source = f.propose({ title: 'Submitted source' })
  const sourceAttempt = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: sourceAttempt.attempt.id, output: 'candidate' })
  const running = f.propose({ title: 'Running work' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, running.id)
  // One prerequisite still runs and one names no task.
  const mixed = inject(f, running, { id: 'task_mixed', title: 'Waits on live work and on nothing', dependencies: [running.id, 'task_missing'] })
  // A review whose source is submitted and live, behind a prerequisite that names no task.
  const review = inject(f, running, { id: 'task_review_behind_nothing', title: 'Reviews behind nothing', kind: 'verification', reviewOf: source.id,
    dependencies: ['task_missing'], covers: undefined, assigneeId: f.reviewer.id })
  await tick(f)
  assert.deepEqual(f.failures, [], 'no pass fails on the board')
  const named = ownerNotices(f).find(delivery => /no live path will advance/.test(delivery.content))
  assert.ok(named?.subjects.includes(`${mixed.id}@0`) && named.subjects.includes(`${review.id}@0`), `the fall-through names both: ${JSON.stringify(named?.subjects)}`)
  const unschedulable = f.runtime.observe(f.owner, f.mission.id).unschedulable
  assert.ok(unschedulable.includes(mixed.id) && unschedulable.includes(review.id), `the owner board holds both dead: ${JSON.stringify(unschedulable)}`)
  const refused = await refusal(f.runtime.claim(f.actor(f.reviewer), f.mission.id, mixed.id))
  assert.equal(refused.code, 'task_not_ready')
  assert.ok(refused.message.includes('dependency task_missing names no task in this mission'), `the edge no work can meet is named before the running one: ${refused.message}`)
})

test('a challenge reads past a dangling row: the disputed source re-opens', async t => {
  const f = await fixture(t)
  const source = f.propose({ title: 'Accepted source' })
  f.runtime.commit(f.mission.id, () => {
    f.runtime.store.put('tasks', { ...taskOf(f.runtime, source.id), status: 'accepted', artifact: { ...f.workers.artifact }, evidenceIds: ['e-source'] })
    f.runtime.store.put('evidence', { id: 'e-source', missionId: f.mission.id, taskId: source.id, workstreamId: f.stream.id, authorId: f.author.id,
      claim: 'the source works', outcome: 'supported', status: 'verified', toolRunIds: [], supersedes: [], challenges: [], createdAt: f.clock.now() })
  })
  inject(f, source, { id: 'task_dangling', title: 'Depends on nothing', dependencies: ['task_missing'] })
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'e-source', reason: 'a counterexample', toolRunIds: [] })
  assert.equal(taskOf(f.runtime, source.id).status, 'submitted', 'the challenge re-opened the source')
})

test('running work whose dependency comes to name no task: the member sees it missing, the guard stops its tools, and submit is refused as a revoked prerequisite', async t => {
  const f = await fixture(t)
  const work = f.propose({ title: 'Running work' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, work.id)
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', { ...taskOf(f.runtime, work.id), dependencies: ['task_missing'] }))
  assert.deepEqual(f.runtime.observe(f.actor(f.author), f.mission.id).current.dependencies, [missing('task_missing')], 'the current assignment renders the dependency as missing')
  assert.equal(f.workers.callbacks.guard(f.author.id, 'read'), 'A prerequisite was invalidated; stop work and inspect the challenge')
  await assert.rejects(f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: work.id, attemptId: claimed.attempt.id, output: 'done' }), error => error.code === 'task_prerequisite_revoked')
})

test('a running review whose source comes to name no task gets one answer from every reader: the guard and verify hold the source unsubmitted, observe renders it missing, an amendment is refused naming the edge, and the reviewer can hand the review off', async t => {
  const f = await fixture(t)
  const source = f.propose({ title: 'Submitted source' })
  const sourceAttempt = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: sourceAttempt.attempt.id, output: 'candidate' })
  const review = f.propose({ title: 'Review', kind: 'verification', reviewOf: source.id, assigneeId: f.reviewer.id, checks: [] })
  const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', { ...taskOf(f.runtime, review.id), reviewOf: 'task_missing_source' }))
  assert.equal(f.workers.callbacks.guard(f.reviewer.id, 'read'), 'The reviewed source is no longer submitted; await a fresh review assignment', 'the guard stops the reviewer\'s tools')
  assert.deepEqual(f.runtime.observe(f.actor(f.reviewer), f.mission.id).current.reviewSource, missing('task_missing_source'), 'the current assignment renders the source as missing')
  await assert.rejects(f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' }),
    error => error.code === 'verification_not_independent', 'verify holds the source unsubmitted, as the guard does')
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, review.id, 'amend', { assigneeId: f.author.id }, 'reassign the review'),
    error => error.code === 'task_graph_invalid' && error.diagnostics.some(diagnostic => diagnostic.code === 'task_graph_unknown_edge' && diagnostic.path === 'task_missing_source'),
    'the amendment reaches the graph check, which names the edge')
  // No source names an author, so no member is kept from the review.
  const handed = f.runtime.handoff(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, to: f.author.id, summary: 'its source names no task' })
  assert.match(handed.handoff, /Ownership revoked/)
  assert.equal(taskOf(f.runtime, review.id).assigneeId, f.author.id)
  // A deferred review's recovery reads its source the same way.
  const deferred = inject(f, source, { id: 'task_deferred_review', title: 'Deferred review', kind: 'verification', reviewOf: 'task_missing_source', covers: undefined, status: 'blocked',
    verificationRecovery: { sourceTaskId: 'task_missing_source', commit: f.workers.artifact.commit, reason: 'deferred', at: f.clock.now() } })
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, deferred.id, 'resume', {}, 'retry the review'), error => error.code === 'review_artifact_changed',
    'its exact submitted artifact is gone')
})

test('a worker\'s proposal behind a review whose source names no task is refused by the graph check naming that edge', async t => {
  const f = await fixture(t)
  f.runtime.store.transaction(() => f.runtime.store.put('starts', { id: 'start_dangling', ownerSessionId: f.owner.sessionId, commandId: 'dangling',
    goal: 'an automatic plan', workspace: f.dir, status: 'running', createdAt: f.clock.now(), updatedAt: f.clock.now(), missionId: f.mission.id }))
  const template = f.propose({ title: 'Template', maxRecoveryAttempts: 1, checkTimeoutMs: 30_000 })
  const review = inject(f, template, { id: 'task_dangling_review', title: 'Reviews nothing', kind: 'verification', reviewOf: 'task_missing_source', covers: undefined })
  assert.throws(() => f.runtime.propose(f.actor(f.author), f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Behind the review', objective: 'Implement the scoped change',
    kind: 'implementation', scope: ['**'], acceptance: ['the change works'], checks: ['test -d .'], dependencies: [review.id] }),
  error => error.code === 'task_graph_invalid' && error.diagnostics.some(diagnostic => diagnostic.code === 'task_graph_unknown_edge' && diagnostic.path === 'task_missing_source'))
})

test('one rule decides whether an assignment delivery is current: the host admits the claim\'s own, and the outbox marks moot, never sends, and the host never admits one whose task names no task, is another mission\'s, is not named, or runs the named attempt for another member', async t => {
  const f = await fixture(t)
  const work = f.propose({ title: 'Running work' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, work.id)
  const current = f.runtime.store.list('deliveries', f.mission.id).find(delivery => delivery.kind === 'assignment' && delivery.attemptId === claimed.attempt.id)
  const assignment = (id, fields) => ({ id, missionId: f.mission.id, from: 'runtime', to: f.author.id, kind: 'assignment', content: '{}', createdAt: f.clock.now(), ...fields })
  f.runtime.store.transaction(() => {
    // Another mission's row that runs an attempt this member owns.
    f.runtime.store.put('tasks', { ...taskOf(f.runtime, work.id), id: 'task_elsewhere', missionId: 'mission_elsewhere', attempt: { ...claimed.attempt, id: 'attempt_elsewhere' } })
    f.runtime.store.put('deliveries', assignment('msg_dangling', { taskId: 'task_missing', attemptId: 'attempt_missing' }))
    f.runtime.store.put('deliveries', assignment('msg_elsewhere', { taskId: 'task_elsewhere', attemptId: 'attempt_elsewhere' }))
    f.runtime.store.put('deliveries', assignment('msg_taskless', {}))
    // The task runs the named attempt, but the author owns it, not this recipient.
    f.runtime.store.put('deliveries', assignment('msg_other_owner', { to: f.reviewer.id, taskId: work.id, attemptId: claimed.attempt.id }))
  })
  const corrupted = ['msg_dangling', 'msg_elsewhere', 'msg_taskless', 'msg_other_owner']
  /** The host's answer when the delivery's own recipient asks to admit it. */
  const admitted = id => f.workers.callbacks.admitDelivery(f.runtime.store.get('deliveries', id).to, id)
  assert.equal(admitted(current.id), true, 'the claim\'s own assignment is current')
  for (const id of corrupted) assert.equal(admitted(id), false, `the host does not admit ${id}`)
  await tick(f)
  assert.deepEqual(f.failures, [], 'no pass fails on the outbox')
  for (const id of corrupted) {
    assert.notEqual(f.runtime.store.get('deliveries', id).deliveredAt, undefined, `the outbox marks ${id} moot`)
    assert.ok(!f.workers.deliveries.some(delivery => delivery.id === id), `and never sends ${id}`)
  }
})
