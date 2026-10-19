/**
 * F1: one attempt fence. An attempt ends in one of two named operations, and
 * whatever is scoped to the attempt leaves the row with it:
 *
 *  - `Attempts.fenceForStop`, when a handle may still be running the attempt: the
 *    attempt ends, the handle owes a stop, and `attempt/fenced` closes the
 *    attempt in the same transaction as the site's own closer event. Lease
 *    expiry, an idle close-out (checkpointed or not), a handoff, an owner
 *    amendment, a task ceiling and the legacy stop-owner recovery each used to
 *    assemble the fence by hand, each clearing a different subset of the
 *    attempt-scoped markers, and none wrote `attempt/fenced`;
 *  - `endAttempt`, when no handle owes a stop: a host restart, a rework (the
 *    source and its re-opened review) and a failed worker start, which cleared
 *    yet other subsets.
 *
 * Those markers are fields of the attempt (`Attempt`), so they leave the row
 * with it by construction. The budget pause that preserved an attempt is one
 * of them (`pausedBy`): a fence during a budget pause takes it, and the resume
 * finds no stale marker to skip. A store an older build wrote, which kept them
 * on the row beside the attempt, is rewritten once when it is opened (schema
 * 7). Each fence test here fails on the hand-assembled fences (b462a61); the
 * last pins what the fence is not: an owner resume keeps a running attempt and
 * restarts its idle close-out.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { FakeClock, FakeWorkers, SwarmRuntime, blockThroughReview, budget, events, setup, taskOf } from './faults/harness.mjs'
import { orchestratorCommands } from '../lib/trace.js'
import { SwarmStore } from '../lib/store.js'

/** The facts an attempt records while it runs, its own fields. */
const MARKERS = ['pausedBy', 'closeout', 'idleSignal', 'gitWriteDenied', 'leaseWarned']
/** Where a build before schema 7 kept them: on the task row, the pause and the idle signal naming their attempt. */
const ROW_MARKERS = ['budgetResume', 'closeout', 'idleSignal', 'gitWriteDenied', 'leaseWarned']
/** Every marker a row carries, on its attempt or, in the shape before schema 7, beside it. */
const markersOf = row => [...ROW_MARKERS.filter(key => row[key] !== undefined).map(key => `row.${key}`), ...MARKERS.filter(key => row.attempt?.[key] !== undefined)]

async function fixture(t) {
  const f = await setup({ clock: new FakeClock() })
  t.after(() => f.cleanup())
  const claim = async (extra = {}) => {
    const task = f.propose(extra)
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    return { task, attemptId: claimed.attempt.id }
  }
  /** Every marker on the attempt the row holds, as that attempt would have written them. */
  const mark = taskId => {
    const row = taskOf(f.runtime, taskId)
    const at = f.clock.now()
    Object.assign(row.attempt, {
      pausedBy: 'budget-pause-earlier', closeout: { nudges: 2, at }, idleSignal: { at },
      gitWriteDenied: { command: 'git commit -m wip', at }, leaseWarned: row.attempt.leaseUntil,
    })
    f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', row))
  }
  const member = () => f.runtime.store.get('members', f.author.id)
  return { ...f, claim, mark, member }
}

/**
 * The fence's own writes: the attempt and every marker are gone, its owner is
 * recorded, and one `attempt/fenced` naming the cause lands immediately before
 * the site's closer, in the same transaction.
 */
function assertFenced(f, taskId, attemptId, cause, closer) {
  const row = taskOf(f.runtime, taskId)
  assert.deepEqual(markersOf(row), [], `${cause}: every attempt-scoped marker left the row with its attempt`)
  assert.equal(row.attempt, undefined, `${cause}: the attempt is off the row`)
  assert.ok(row.priorOwnerIds.includes(f.author.id), `${cause}: the outgoing owner is recorded`)
  const all = f.runtime.store.events(f.mission.id, 5_000)
  const fenced = all.filter(event => event.type === 'attempt/fenced' && event.data.taskId === taskId)
  assert.deepEqual(fenced.map(event => [event.data.attemptId, event.data.cause]), [[attemptId, cause]], `${cause}: one closer names the fenced attempt and its cause`)
  const own = all.find(event => event.type === closer && (event.data.taskId === taskId))
  assert.equal(own?.seq, fenced[0].seq + 1, `${cause}: the closer follows the fence in one transition`)
}

test('a handoff fences its attempt: every marker goes and attempt/fenced precedes task/handoff-started', async t => {
  const f = await fixture(t)
  const { task, attemptId } = await f.claim()
  f.mark(task.id)
  f.runtime.handoff(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId, summary: 'Passing the work on' })
  const row = taskOf(f.runtime, task.id)
  assert.deepEqual([row.status, row.resumeAfterStop?.epoch, row.resumeAfterStop?.memberId, row.resumeAfterStop?.reason], ['blocked', row.epoch, f.author.id, 'handoff'])
  assertFenced(f, task.id, attemptId, 'handoff', 'task/handoff-started')
})

test('a challenge that fences a dependent whose handoff stop is still in flight keeps that barrier, makes it invalidated, and the dependent stays blocked', async t => {
  const f = await fixture(t)
  const source = f.propose({ title: 'Accepted prerequisite' })
  f.runtime.commit(f.mission.id, () => {
    f.runtime.store.put('tasks', { ...taskOf(f.runtime, source.id), status: 'accepted', artifact: { ...f.workers.artifact }, evidenceIds: ['e-source'] })
    f.runtime.store.put('evidence', { id: 'e-source', missionId: f.mission.id, taskId: source.id, workstreamId: f.stream.id, authorId: f.reviewer.id,
      claim: 'the prerequisite holds', outcome: 'supported', status: 'verified', toolRunIds: [], supersedes: [], challenges: [], createdAt: f.clock.now() })
  })
  const { task, attemptId } = await f.claim({ title: 'Dependent', dependencies: [source.id] })
  // The handoff's stop stays in flight until the test releases it.
  let release
  const stopping = new Promise(resolve => { release = resolve })
  const stop = f.workers.stop.bind(f.workers)
  f.workers.stop = async id => { await stopping; return await stop(id) }
  f.runtime.handoff(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId, summary: 'Passing the work on' })
  const barrier = taskOf(f.runtime, task.id).resumeAfterStop
  assert.deepEqual([barrier.reason, barrier.memberId, barrier.epoch], ['handoff', f.author.id, taskOf(f.runtime, task.id).epoch])
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'e-source', reason: 'counterexample', toolRunIds: [] })
  const challenged = taskOf(f.runtime, task.id)
  assert.deepEqual([challenged.status, challenged.resumeAfterStop], ['blocked', { ...barrier, reason: 'invalidated' }], 'the barrier keeps its epoch, owner and start, and becomes invalidated')
  release()
  await f.runtime.settle(f.mission.id)
  const settled = taskOf(f.runtime, task.id)
  assert.ok(f.workers.stopped.includes(f.author.id), 'the barrier stopped the handle it owed')
  assert.deepEqual([settled.resumeAfterStop, settled.status], [undefined, 'blocked'], 'the acknowledged stop leaves the invalidated work blocked instead of re-pending it')
})

test('an expired lease fences its attempt: every marker goes and attempt/fenced precedes task/lease-expired', async t => {
  const f = await fixture(t)
  const { task, attemptId } = await f.claim()
  f.mark(task.id)
  f.clock.advance(f.runtime.config.leaseMs + 1)
  await f.runtime.tick()
  assert.equal(events(f.runtime, f.mission.id, 'task/lease-expired').length, 1, 'the lease expired')
  assertFenced(f, task.id, attemptId, 'lease-expired', 'task/lease-expired')
})

test('an idle close-out fences its attempt, checkpointed or not: every marker goes and attempt/fenced precedes its closer', async t => {
  for (const captured of [true, false]) {
    const f = await fixture(t)
    const { task, attemptId } = await f.claim()
    f.mark(task.id)
    if (!captured) f.workers.captureArtifact = async () => { throw new Error('the workspace could not be captured') }
    await f.runtime.attempts.closeOutIdleAttempt(f.runtime.mission(f.mission.id), f.member(), taskOf(f.runtime, task.id))
    assert.equal(taskOf(f.runtime, task.id).status, 'blocked')
    assertFenced(f, task.id, attemptId, captured ? 'closeout-abandoned' : 'closeout-failed', captured ? 'task/closeout-abandoned' : 'task/closeout-failed')
    await f.runtime.settle(f.mission.id)
  }
})

test('an owner amendment fences the running attempt: every marker goes and attempt/fenced precedes task/amended', async t => {
  const f = await fixture(t)
  const { task, attemptId } = await f.claim()
  f.mark(task.id)
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { checks: ['test -e .'] }, 'Tighten the host check')
  assert.equal(taskOf(f.runtime, task.id).resumeAfterStop?.memberId, f.author.id, 'the amended attempt owes its stop')
  assertFenced(f, task.id, attemptId, 'owner-amend', 'task/amended')
  // attempt/fenced is the one record of the fenced attempt: the amendment does
  // not repeat it, and the replay closes the attempt from the fence alone.
  assert.equal(Object.hasOwn(events(f.runtime, f.mission.id, 'task/amended').at(-1).data, 'fencedAttemptId'), false)
  assert.doesNotThrow(() => orchestratorCommands(f.runtime.store.events(f.mission.id, 5_000)), 'the replay finds no attempt left open')
})

test('a task ceiling fences its attempt: every marker goes and attempt/fenced precedes task/ceiling-exhausted', async t => {
  const f = await fixture(t)
  const { task, attemptId } = await f.claim({ maxSteps: 1 })
  await f.workers.callbacks.beforeStep(f.author.id)
  f.mark(task.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.author.id), false, 'the step past the ceiling is refused')
  assert.equal(taskOf(f.runtime, task.id).resumeAfterStop?.reason, 'resource')
  assertFenced(f, task.id, attemptId, 'task-ceiling', 'task/ceiling-exhausted')
})

test('the legacy stop-owner recovery fences each live peer: every marker goes and attempt/fenced precedes task/handoff-started', async t => {
  const f = await fixture(t)
  const { task, attemptId } = await f.claim({ title: 'Live peer' })
  f.mark(task.id)
  // A stop an older build recorded without the owner it stops, on a task no event attributes.
  const legacy = f.propose({ title: 'Legacy stop' })
  const stopped = { ...taskOf(f.runtime, legacy.id), status: 'blocked' }
  stopped.resumeAfterStop = { epoch: stopped.epoch, reason: 'handoff' }
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', stopped))
  f.runtime.attempts.resumeStoppedAttempt(f.mission.id, taskOf(f.runtime, legacy.id))
  assert.equal(taskOf(f.runtime, task.id).resumeAfterStop?.memberId, f.author.id, 'the peer owes its own stop')
  assertFenced(f, task.id, attemptId, 'stop-owner-unresolved', 'task/handoff-started')
  await f.runtime.settle(f.mission.id)
})

test('a fence during a budget pause takes the pause marker with the attempt, so the resume finds no stale marker', async t => {
  const f = await fixture(t)
  const { task, attemptId } = await f.claim()
  await f.workers.callbacks.usage(f.author.id, budget.maxTokens + 1)
  assert.ok(taskOf(f.runtime, task.id).attempt.pausedBy, 'the pause preserved the running attempt')
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { checks: ['test -e .'] }, 'Amend the paused task')
  assert.deepEqual(markersOf(taskOf(f.runtime, task.id)), [], 'the pause left the row with the fenced attempt')
  assertFenced(f, task.id, attemptId, 'owner-amend', 'task/amended')
  f.runtime.updateBudget(f.owner, f.mission.id, { ...f.runtime.mission(f.mission.id).budget, maxTokens: budget.maxTokens * 4 })
  f.runtime.control(f.owner, f.mission.id, 'resume', 'Budget raised')
  for (let tick = 0; tick < 20 && f.runtime.mission(f.mission.id).budgetPause !== undefined; tick++) { f.clock.advance(10); await f.runtime.tick() }
  assert.equal(f.runtime.mission(f.mission.id).budgetPause, undefined, 'the resume cleared the pause')
  assert.deepEqual(events(f.runtime, f.mission.id, 'task/budget-resume-skipped'), [], 'no marker outlived its attempt, so none is skipped')
  assert.deepEqual(events(f.runtime, f.mission.id, 'task/budget-resumed'), [], 'the fenced attempt is not resumed')
  assert.equal(taskOf(f.runtime, task.id).recoveryCount, undefined, 'the fence spent no recovery credit')
})

test('a lease the sweep fences after a budget pause landed during its checkpoint capture spends no recovery credit', async t => {
  const f = await fixture(t)
  const { task, attemptId } = await f.claim()
  await f.runtime.settle(f.mission.id)
  // The owner is quiescent, so the sweep captures a checkpoint before it fences the expired lease.
  f.workers.idle.add(f.author.id)
  let reached, release
  const capturing = new Promise(resolve => { reached = resolve })
  const gate = new Promise(resolve => { release = resolve })
  f.workers.captureGate = () => { reached(); return gate }
  f.clock.advance(f.runtime.config.leaseMs + 1)
  const ticking = f.runtime.tick()
  await capturing
  // Usage accounting commits outside the mission queue: the pause lands while the sweep awaits.
  await f.workers.callbacks.usage(f.author.id, budget.maxTokens + 1)
  const preserved = taskOf(f.runtime, task.id).attempt
  assert.deepEqual([preserved.id, preserved.pausedBy], [attemptId, f.runtime.mission(f.mission.id).budgetPause.id], 'the pause preserved the attempt the sweep is about to fence')
  release()
  await ticking
  assert.equal(events(f.runtime, f.mission.id, 'task/lease-expired').length, 1, 'the sweep fenced the expired lease')
  assert.equal(taskOf(f.runtime, task.id).recoveryCount, undefined, 'a lease fenced while the pause holds spends no recovery credit')
})

test('a store an older build wrote is rewritten once, at open: each marker moves onto the attempt it belongs to, and one that belongs to none the row holds is dropped (schema 7)', async t => {
  // A schema 6 store (the previous version), and a schema 5 one, which a v6 build would have settled first.
  for (const version of [6, 5]) {
    const f = await fixture(t)
    const { task: held } = await f.claim({ title: 'Held attempt' })
    const heldRow = taskOf(f.runtime, held.id)
    const fenced = f.propose({ title: 'Fenced by an older build' })
    const submitted = f.propose({ title: 'Submitted after an older assignment' })
    const plain = f.propose({ title: 'No markers' })
    const at = f.clock.now()
    const closeout = { nudges: 1, at }, gitWriteDenied = { command: 'git commit -m wip', at }
    // What an older build left on its rows: the held attempt's markers beside
    // it; a fence that took the attempt off the row and kept its markers; and
    // an assignment that carried an earlier attempt's pause and idle signal
    // into the attempt a submission then kept as its record.
    const older = [
      { ...heldRow, budgetResume: { pauseId: 'budget-pause-held', attemptId: heldRow.attempt.id }, closeout, idleSignal: { attemptId: heldRow.attempt.id, at }, gitWriteDenied, leaseWarned: heldRow.attempt.leaseUntil },
      { ...taskOf(f.runtime, fenced.id), priorOwnerIds: [f.author.id], budgetResume: { pauseId: 'budget-pause-earlier', attemptId: 'attempt-fenced' },
        closeout, idleSignal: { attemptId: 'attempt-fenced', at }, gitWriteDenied, leaseWarned: at },
      { ...taskOf(f.runtime, submitted.id), status: 'submitted', attempt: { id: 'attempt-submitted', epoch: 2, ownerId: f.author.id, leaseUntil: at },
        budgetResume: { pauseId: 'budget-pause-earlier', attemptId: 'attempt-earlier' }, idleSignal: { attemptId: 'attempt-earlier', at }, gitWriteDenied },
    ]
    const plainRow = taskOf(f.runtime, plain.id)
    await f.runtime.dispose()
    const { statePath } = f.runtime.config
    const write = (rows, schema) => {
      const db = new DatabaseSync(statePath)
      try { for (const row of rows) db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(row), row.id); db.exec(`PRAGMA user_version=${schema}`) } finally { db.close() }
    }
    const read = sql => { const db = new DatabaseSync(statePath, { readOnly: true }); try { return Object.values(db.prepare(sql).get())[0] } finally { db.close() } }
    write(older, version)
    const snapshot = `${statePath}.v${version}.sqlite`
    copyFileSync(statePath, snapshot)
    const before = read('SELECT revision FROM state_revision WHERE id=1')
    const opened = new SwarmRuntime(f.runtime.config, new FakeWorkers())
    t.after(() => opened.dispose())
    const strip = ({ budgetResume: _pause, idleSignal: _idle, closeout: _closeout, gitWriteDenied: _denied, leaseWarned: _warned, ...row }) => row
    const upgraded = { ...heldRow, attempt: { ...heldRow.attempt, pausedBy: 'budget-pause-held', idleSignal: { at }, closeout, gitWriteDenied, leaseWarned: heldRow.attempt.leaseUntil } }
    assert.deepEqual(taskOf(opened, held.id), upgraded, `v${version}: every marker of the held attempt moves onto it, the pause as its pausedBy`)
    assert.deepEqual(taskOf(opened, fenced.id), strip(older[1]), `v${version}: a row that holds no attempt keeps none of its markers`)
    assert.deepEqual(taskOf(opened, submitted.id), { ...strip(older[2]), attempt: { ...older[2].attempt, gitWriteDenied } },
      `v${version}: a pause and an idle signal naming another attempt leave; the held attempt keeps its own`)
    assert.deepEqual(taskOf(opened, plain.id), plainRow, `v${version}: a row without markers is not rewritten`)
    assert.deepEqual(opened.store.changesSince(before).map(change => change.scopes), [[f.mission.id]], `v${version}: the upgrade is one recorded change`)
    assert.equal(read('PRAGMA user_version'), 7)
    await opened.dispose()
    // Once: a schema 7 store is not rewritten again (only an older build writes such a row), and nothing is written.
    write(older.slice(0, 1), 7)
    const revision = read('SELECT revision FROM state_revision WHERE id=1')
    const reopened = new SwarmRuntime(f.runtime.config, new FakeWorkers())
    t.after(() => reopened.dispose())
    assert.deepEqual([markersOf(taskOf(reopened, held.id)), reopened.store.revision()], [ROW_MARKERS.map(key => `row.${key}`), revision], `v${version}: reopening moves nothing`)
    await reopened.dispose()
    // A restored snapshot of the older store is rewritten the same way when it is opened.
    SwarmStore.restore(statePath, snapshot)
    const restored = new SwarmRuntime(f.runtime.config, new FakeWorkers())
    t.after(() => restored.dispose())
    assert.deepEqual(taskOf(restored, held.id), upgraded, `v${version}: the restored snapshot is upgraded at open`)
    await restored.dispose()
  }
})

test('a failed worker start ends the attempt it was assigned, with every marker', async t => {
  const f = await fixture(t)
  const { task } = await f.claim()
  f.mark(task.id)
  f.runtime.onStartFailure(f.runtime.mission(f.mission.id), f.member(), new Error('worker could not start'))
  const row = taskOf(f.runtime, task.id)
  assert.deepEqual([row.status, row.attempt, markersOf(row)], ['pending', undefined, []])
})

test('a host restart ends the running attempt it re-pends, with every marker', async t => {
  const f = await fixture(t)
  const { task } = await f.claim()
  f.mark(task.id)
  await f.runtime.dispose()
  const reopened = new SwarmRuntime(f.runtime.config, new FakeWorkers())
  try {
    await reopened.start()
    const row = taskOf(reopened, task.id)
    assert.deepEqual([row.status, row.attempt, markersOf(row)], ['pending', undefined, []])
    assert.equal(events(reopened, f.mission.id, 'task/restart-repended').length, 1)
  } finally { await reopened.dispose() }
})

test('a rework ends the rejected attempt and its review\'s, with every marker', async t => {
  const f = await fixture(t)
  const task = f.propose()
  const review = await blockThroughReview(f, task)
  f.mark(task.id); f.mark(review.id)
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'resume', {}, 'Rework the rejected commit')
  for (const id of [task.id, review.id]) {
    const row = taskOf(f.runtime, id)
    assert.deepEqual([row.attempt, markersOf(row)], [undefined, []], `${id}: the re-opened row carries nothing of its finished attempt`)
  }
  assert.equal(taskOf(f.runtime, task.id).reworkCount, 1, 'the source was re-opened for rework')
})

test('an owner resume is not a fence: the running attempt keeps running with its turn end, and its idle close-out restarts from the first nudge', async t => {
  const f = await fixture(t)
  const { task, attemptId } = await f.claim()
  const closeOut = () => f.runtime.attempts.closeOutIdleAttempt(f.runtime.mission(f.mission.id), f.member(), taskOf(f.runtime, task.id))
  const nudges = () => events(f.runtime, f.mission.id, 'task/closeout-nudged').filter(event => event.data.taskId === task.id).map(event => event.data.nudges)
  // The worker ends its turn with the attempt open, and the close-out spends every nudge it allows.
  f.runtime.attempts.onIdle(f.author.id)
  await closeOut(); await closeOut()
  assert.deepEqual([nudges(), taskOf(f.runtime, task.id).attempt.closeout?.nudges], [[1, 2], 2], 'the close-out spent its nudges')
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'resume', {}, 'Retry after the environment repair')
  const resumed = taskOf(f.runtime, task.id)
  assert.deepEqual([resumed.status, resumed.attempt?.id, resumed.attempt?.closeout, resumed.attempt?.idleSignal !== undefined], ['running', attemptId, undefined, true],
    'the resume keeps the attempt and the turn end that armed its close-out, and forgets the nudges')
  // The close-out still owns the attempt, so past its silence bound the
  // attempt reporting bound leaves it to the close-out (R16-D5).
  const past = f.clock.now() + f.runtime.bounds.attemptSilenceBoundMs + 1
  assert.equal(f.runtime.scheduling.silentAttempt(resumed, f.runtime.mission(f.mission.id), past), undefined,
    'the reporting bound does not name the resumed attempt the close-out acts on')
  // The next idle turn is nudged from the first nudge again, instead of abandoning the attempt.
  await closeOut()
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(nudges(), [1, 2, 1])
  assert.equal(taskOf(f.runtime, task.id).attempt?.id, attemptId, 'the attempt is still held')
  assert.deepEqual([...events(f.runtime, f.mission.id, 'attempt/fenced'), ...events(f.runtime, f.mission.id, 'task/closeout-abandoned')], [], 'nothing fenced or abandoned the attempt')
})
