/**
 * F1: one attempt fence. An attempt ends in one of two named operations, and
 * whatever is scoped to the attempt leaves the row with it:
 *
 *  - `Attempts.fenceRow`, when a handle may still be running the attempt: the
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
 * The budget-resume marker is one of those markers, so it never outlives the
 * attempt it names: a fence during a budget pause takes it, and the resume
 * finds no stale marker to skip. Each test here fails on the hand-assembled
 * fences (b462a61), except the last, which pins what the fence is not: an
 * owner resume keeps a running attempt and restarts its idle close-out.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeClock, FakeWorkers, SwarmRuntime, blockThroughReview, budget, events, setup, taskOf } from './faults/harness.mjs'
import { orchestratorCommands } from '../lib/trace.js'

const MARKERS = ['budgetResume', 'closeout', 'idleSignal', 'gitWriteDenied', 'leaseWarned']
const markersOf = row => MARKERS.filter(key => row[key] !== undefined)

async function fixture(t) {
  const f = await setup({ clock: new FakeClock() })
  t.after(() => f.cleanup())
  const claim = async (extra = {}) => {
    const task = f.propose(extra)
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    return { task, attemptId: claimed.attempt.id }
  }
  /** Every attempt-scoped marker on the row, as the attempt it holds would have written them. */
  const mark = taskId => {
    const row = taskOf(f.runtime, taskId)
    const at = f.clock.now()
    Object.assign(row, {
      budgetResume: { pauseId: 'budget-pause-earlier', attemptId: row.attempt.id },
      closeout: { nudges: 2, at }, idleSignal: { attemptId: row.attempt.id, at },
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
  assert.ok(taskOf(f.runtime, task.id).budgetResume, 'the pause preserved the running attempt')
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { checks: ['test -e .'] }, 'Amend the paused task')
  assert.equal(taskOf(f.runtime, task.id).budgetResume, undefined, 'the marker left the row with the fenced attempt')
  assertFenced(f, task.id, attemptId, 'owner-amend', 'task/amended')
  f.runtime.updateBudget(f.owner, f.mission.id, { ...f.runtime.mission(f.mission.id).budget, maxTokens: budget.maxTokens * 4 })
  f.runtime.control(f.owner, f.mission.id, 'resume', 'Budget raised')
  for (let tick = 0; tick < 20 && f.runtime.mission(f.mission.id).budgetPause !== undefined; tick++) { f.clock.advance(10); await f.runtime.tick() }
  assert.equal(f.runtime.mission(f.mission.id).budgetPause, undefined, 'the resume cleared the pause')
  assert.deepEqual(events(f.runtime, f.mission.id, 'task/budget-resume-skipped'), [], 'no marker outlived its attempt, so none is skipped')
  assert.deepEqual(events(f.runtime, f.mission.id, 'task/budget-resumed'), [], 'the fenced attempt is not resumed')
  assert.equal(taskOf(f.runtime, task.id).recoveryCount, undefined, 'the fence spent no recovery credit')
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

test('an owner resume is not a fence: the running attempt keeps running, and its idle close-out restarts from the first nudge', async t => {
  const f = await fixture(t)
  const { task, attemptId } = await f.claim()
  const closeOut = () => f.runtime.attempts.closeOutIdleAttempt(f.runtime.mission(f.mission.id), f.member(), taskOf(f.runtime, task.id))
  const nudges = () => events(f.runtime, f.mission.id, 'task/closeout-nudged').filter(event => event.data.taskId === task.id).map(event => event.data.nudges)
  // The worker ends its turn with the attempt open, and the close-out spends every nudge it allows.
  f.runtime.attempts.onIdle(f.author.id)
  await closeOut(); await closeOut()
  assert.deepEqual([nudges(), taskOf(f.runtime, task.id).closeout?.nudges], [[1, 2], 2], 'the close-out spent its nudges')
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'resume', {}, 'Retry after the environment repair')
  const resumed = taskOf(f.runtime, task.id)
  assert.deepEqual([resumed.status, resumed.attempt?.id, resumed.closeout, resumed.idleSignal], ['running', attemptId, undefined, undefined], 'the resume keeps the attempt and forgets its close-out')
  // The next idle turn is nudged from the first nudge again, instead of abandoning the attempt.
  await closeOut()
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(nudges(), [1, 2, 1])
  assert.equal(taskOf(f.runtime, task.id).attempt?.id, attemptId, 'the attempt is still held')
  assert.deepEqual([...events(f.runtime, f.mission.id, 'attempt/fenced'), ...events(f.runtime, f.mission.id, 'task/closeout-abandoned')], [], 'nothing fenced or abandoned the attempt')
})
