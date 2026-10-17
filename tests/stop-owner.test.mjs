/**
 * F2: one stop-owner rule. The handle holding the row's open attempt owes the
 * stop; an attempt that ended in a submission or a verdict owes none.
 *
 * Before F2 the owner's task control named the stop owner itself: a resume or
 * a structural amendment of a blocked row still holding its finished attempt
 * (a review that deferred its verdict, or one that rejected) fenced that row
 * with a stop laid on the reviewer, whose handle by then could be running
 * other work. The stop barrier stopped that handle, checkpointed the review's
 * workspace from it, and only then re-pended the review. An owner cancel of the
 * same review already laid no stop.
 *
 * Now the fence reads the stop owner from the row (`Attempts.fenceForStop`, as
 * the cancel does): the finished attempt ends with its `attempt/fenced` closer
 * and the row re-pends in the same transition. No stop is owed, the
 * reviewer's handle and its other work are left alone, and the review is
 * dispatchable at once. Each test here fails on the pre-F2 head, except the
 * last, which pins what stays: a structural amendment of running work fences
 * it, and the stop is owed by the handle holding its open attempt.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeClock, blockThroughReview, events, setup, taskOf } from './faults/harness.mjs'
import { orchestratorCommands } from '../lib/trace.js'
import { stopPending } from '../lib/task-graph.js'

const PASS = [{ command: 'test -d .', exitCode: 0, output: 'ok' }]
const TIMEOUT = [{ command: 'test -d .', exitCode: 124, failureKind: 'timeout', output: '[swarm] Execution timed out after 30000ms' }]

async function fixture(t) {
  const f = await setup({ clock: new FakeClock(), budget: { maxWorkers: 3 } })
  t.after(() => f.cleanup())
  /** A submitted source whose review, claimed by the reviewer, defers its verdict on a host check that timed out. */
  const deferredReview = async () => {
    const source = f.propose({ title: 'Source' })
    const authored = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: authored.attempt.id, output: 'candidate' })
    const review = f.propose({ title: 'Review', kind: 'verification', reviewOf: source.id, assigneeId: f.reviewer.id })
    const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    f.workers.checks = TIMEOUT
    const deferred = await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Review against acceptance' })
    f.workers.checks = PASS
    assert.equal(deferred.status, 'blocked', 'the review deferred its verdict')
    assert.equal(taskOf(f.runtime, review.id).attempt?.id, reviewing.attempt.id, 'the deferred review still holds the attempt that ended in its verdict')
    return { source, review, attemptId: reviewing.attempt.id }
  }
  return { ...f, deferredReview }
}

/**
 * The finished attempt was fenced with no stop owed and the row re-pended in
 * the owner's own transition: one `attempt/fenced` naming the owner's decision
 * immediately before `task/amended`, which records the row pending.
 */
function assertEndedAndRepended(f, review, before, cause, label) {
  const row = taskOf(f.runtime, review.id)
  assert.deepEqual([row.status, row.attempt, row.resumeAfterStop], ['pending', undefined, undefined], `${label}: the review re-pends at once, owing no stop`)
  assert.equal(row.epoch, before.epoch + 1, `${label}: the epoch bump that ends the finished attempt is the only one`)
  assert.ok(row.priorOwnerIds.includes(f.reviewer.id), `${label}: the reviewer is recorded as a prior owner`)
  assert.equal(row.verificationRecovery, undefined, `${label}: the deferral is cleared`)
  const all = f.runtime.store.events(f.mission.id, 5_000)
  const fenced = all.filter(event => event.type === 'attempt/fenced' && event.data.taskId === review.id)
  assert.deepEqual(fenced.map(event => [event.data.attemptId, event.data.cause]), [[before.attempt.id, cause]], `${label}: one closer names the finished attempt and the owner's decision`)
  const amended = all.find(event => event.type === 'task/amended' && event.data.taskId === review.id)
  assert.deepEqual([amended?.seq, amended?.data.status, amended?.data.epoch], [fenced[0].seq + 1, 'pending', row.epoch], `${label}: the amendment records the re-pended row in the same transition`)
}

test('an owner resume of a deferred review ends its finished attempt and re-pends it, and the reviewer, running other work, is not stopped', async t => {
  const f = await fixture(t)
  const { source, review } = await f.deferredReview()
  const other = f.propose({ title: 'Other work', assigneeId: f.reviewer.id })
  const working = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, other.id)
  const before = taskOf(f.runtime, review.id)

  f.runtime.controlTask(f.owner, f.mission.id, review.id, 'resume', {}, 'The host check deadline was repaired')
  assertEndedAndRepended(f, review, before, 'owner-resume', 'resume')
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(f.workers.stopped, [], 'no handle was stopped')
  const still = taskOf(f.runtime, other.id)
  assert.deepEqual([still.status, still.attempt?.id], ['running', working.attempt.id], 'the reviewer\'s other work runs on, on its own attempt')
  assert.equal(taskOf(f.runtime, review.id).status, 'pending', 'the review stays pending: no barrier decides it later')

  // Dispatchable: once the reviewer is free it takes the review again and decides it.
  f.workers.artifact = { ...f.workers.artifact, commit: 'c'.repeat(40) }
  await f.runtime.submit(f.actor(f.reviewer), f.mission.id, { taskId: other.id, attemptId: working.attempt.id, output: 'other work done' })
  const retaken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  const accepted = await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: retaken.attempt.id, verdict: 'accept', reason: 'Host checks pass after the repair' })
  assert.equal(accepted.status, 'accepted')
  assert.equal(taskOf(f.runtime, source.id).status, 'accepted', 'the same immutable source is accepted')
  // The deferral closed the attempt in the log, so no fence has to: the replay finds none left open.
  assert.doesNotThrow(() => orchestratorCommands(f.runtime.store.events(f.mission.id, 5_000)))
})

test('an owner\'s structural amendment of a deferred review ends its finished attempt and re-pends it for the new assignee, with no stop on the old reviewer', async t => {
  const f = await fixture(t)
  const { source, review } = await f.deferredReview()
  const next = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Next reviewer', role: 'verification', maxOutputTokens: 5_000 })
  await f.runtime.settle(f.mission.id)
  const before = taskOf(f.runtime, review.id)

  f.runtime.controlTask(f.owner, f.mission.id, review.id, 'amend', { assigneeId: next.id }, 'The first reviewer is busy')
  assertEndedAndRepended(f, review, before, 'owner-amend', 'amend')
  assert.equal(taskOf(f.runtime, review.id).assigneeId, next.id)
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(f.workers.stopped, [], 'the old reviewer\'s handle was not stopped')

  const taken = await f.runtime.claim(f.actor(next), f.mission.id, review.id)
  const accepted = await f.runtime.verify(f.actor(next), f.mission.id, { taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason: 'Host checks pass for the new reviewer' })
  assert.equal(accepted.status, 'accepted')
  assert.equal(taskOf(f.runtime, source.id).status, 'accepted')
})

test('an owner resume of a rejecting review ends the attempt that ended in its verdict and re-pends it, with no stop on the reviewer', async t => {
  const f = await fixture(t)
  const review = await blockThroughReview(f, f.propose({ title: 'Rejected source' }))
  const before = taskOf(f.runtime, review.id)
  assert.deepEqual([before.status, before.attempt?.ownerId], ['blocked', f.reviewer.id], 'the rejecting review holds the attempt that ended in its verdict')

  f.runtime.controlTask(f.owner, f.mission.id, review.id, 'resume', {}, 'Review it again')
  assertEndedAndRepended(f, review, before, 'owner-resume', 'rejecting resume')
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(f.workers.stopped, [], 'no handle was stopped')
})

test('a structural amendment of running work still fences it, with the stop owed by the handle holding its open attempt', async t => {
  const f = await fixture(t)
  const work = f.propose({ title: 'Running work' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, work.id)
  f.runtime.controlTask(f.owner, f.mission.id, work.id, 'amend', { checks: ['test -e .'] }, 'Tighten the host check')
  const row = taskOf(f.runtime, work.id)
  assert.deepEqual([row.status, row.attempt, row.resumeAfterStop?.memberId, row.resumeAfterStop?.reason], ['blocked', undefined, f.author.id, 'handoff'])
  assert.deepEqual(events(f.runtime, f.mission.id, 'attempt/fenced').filter(event => event.data.taskId === work.id).map(event => [event.data.attemptId, event.data.cause]), [[claimed.attempt.id, 'owner-amend']])
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(f.workers.stopped, [f.author.id], 'the barrier stopped the handle that held the open attempt')
  assert.equal(taskOf(f.runtime, work.id).status, 'pending', 'and re-pended the work after it')
})

/**
 * A stop is owed only when `stopPending` says so: a marker at an older epoch
 * than its row belongs to a fence a later epoch replaced, and obliges nothing.
 * A store the pre-F2 build wrote holds such a marker on a deferred review when
 * the owner resumed the review while it was rejecting (which laid a stop on
 * the reviewer), reworked its source before that stop finished (which
 * re-opened the review at the next epoch), and the reviewer then claimed it
 * again and deferred. Each owner control asks the same question of that row as
 * of one without a marker.
 */
const markEarlierEpoch = (f, taskId) => f.runtime.commit(f.mission.id, () => {
  const row = taskOf(f.runtime, taskId)
  f.runtime.store.put('tasks', { ...row, resumeAfterStop: { epoch: row.epoch - 1, memberId: f.reviewer.id, reason: 'handoff', at: f.clock.now() } })
})

test('an owner resume re-pends a deferred review whose stop marker is of an earlier epoch: that marker obliges nothing', async t => {
  const f = await fixture(t)
  const { source, review } = await f.deferredReview()
  markEarlierEpoch(f, review.id)
  const before = taskOf(f.runtime, review.id)
  assert.equal(stopPending(before), false, 'the marker is of an earlier epoch')

  f.runtime.controlTask(f.owner, f.mission.id, review.id, 'resume', {}, 'The host check deadline was repaired')
  const row = taskOf(f.runtime, review.id)
  assert.deepEqual([row.status, row.attempt, row.epoch, stopPending(row)], ['pending', undefined, before.epoch + 1, false], 'the review re-pends at once, owing no stop')
  assert.deepEqual(events(f.runtime, f.mission.id, 'task/amended').filter(event => event.data.taskId === review.id).map(event => event.data.status), ['pending'])
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(f.workers.stopped, [], 'no handle was stopped')
  assert.equal(taskOf(f.runtime, review.id).status, 'pending', 'no barrier decides it later')

  const retaken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  const accepted = await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: retaken.attempt.id, verdict: 'accept', reason: 'Host checks pass after the repair' })
  assert.equal(accepted.status, 'accepted')
  assert.equal(taskOf(f.runtime, source.id).status, 'accepted', 'the dispatchable review decides its source')
})

test('a structural amendment of pending work whose stop marker is of an earlier epoch fences a preparation already awaiting I/O', async t => {
  const f = await fixture(t)
  const work = f.propose({ title: 'Pending work' })
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', { ...taskOf(f.runtime, work.id), epoch: 1 }))
  markEarlierEpoch(f, work.id)
  const before = taskOf(f.runtime, work.id)
  assert.deepEqual([before.status, stopPending(before)], ['pending', false])
  let entered, release
  const preparing = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const prepare = f.workers.prepareTask.bind(f.workers)
  f.workers.prepareTask = async (...args) => { entered(); await gate; return prepare(...args) }

  const claim = f.runtime.claim(f.actor(f.author), f.mission.id, work.id)
  await preparing
  f.runtime.controlTask(f.owner, f.mission.id, work.id, 'amend', { checks: ['test -e .'] }, 'Tighten the host check')
  assert.equal(taskOf(f.runtime, work.id).epoch, before.epoch + 1, 'the amendment moves the epoch the preparation was chosen at')
  release()
  await assert.rejects(claim, error => error.code === 'task_changed_during_preparation', 'the preparation awaiting I/O is fenced')
  const row = taskOf(f.runtime, work.id)
  assert.deepEqual([row.status, row.attempt, row.checks], ['pending', undefined, ['test -e .']])

  f.workers.prepareTask = prepare
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, work.id)
  assert.deepEqual([claimed.status, claimed.checks], ['running', ['test -e .']], 'the amended work is claimed at its new epoch')
})
