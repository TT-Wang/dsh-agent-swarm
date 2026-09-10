/**
 * S1 (progress-or-terminate) and the first half of S5 (in-memory gate sets on
 * the scheduling path are caches, never evidence).
 *
 * The Round-13 defect: `Runtime.kick()` deduplicated a mission with the
 * in-memory `scheduled` Set, so a pass wedged in an adapter call swallowed the
 * tick timer's only liveness action and the mission produced zero durable events
 * for 120 minutes while the same process served another mission. These tests
 * assert the replacement mechanism from durable state only:
 *  - the guard is a durable per-mission `passes` row, re-read from the store;
 *  - a row older than the declared bound does not gate: the watchdog escalates,
 *    releases the guard and later ticks proceed;
 *  - a live lease renewed by recorded operations is progress, never a stall;
 *  - clearing the in-memory caches changes no durable outcome (S5), because
 *    every gate either re-reads the store or is pure duplicate suppression.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, eventually, events, taskOf } from './faults/harness.mjs'

const keyOf = missionId => `pass_${missionId}`
const writePass = (f, fields) => {
  const key = keyOf(f.mission.id)
  const row = {
    // The row carries this runtime instance's identity; a foreign row never gates.
    id: key, runId: 'test-guard', instanceId: f.runtime.instanceId, missionId: f.mission.id, status: 'running', startedAt: Date.now(),
    revisionBefore: f.runtime.store.revision(), fingerprintBefore: f.runtime.fingerprint(f.mission.id), noProgressPasses: 0,
    ...fields,
  }
  f.runtime.store.transaction(() => f.runtime.store.put('passes', row))
  return row
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('S1/S5: the scheduling guard is a durable pass row re-read from the store, and an expired row cannot swallow a tick', async () => {
  const f = await setup({ config: { tickMs: 20, stallPassTimeoutMs: 200, stallPasses: 50 } })
  try {
    // The row exists, keyed per mission, with a per-run identity for fencing.
    const opened = f.runtime.store.get('passes', keyOf(f.mission.id))
    assert.ok(opened, 'a scheduling pass leaves a durable row')
    assert.equal(opened.id, keyOf(f.mission.id), 'the row key is the guard identity')
    assert.ok(typeof opened.runId === 'string' && opened.runId.length > 0, 'each pass run has its own identity')
    assert.match(opened.fingerprintBefore, /^[0-9a-f]{32}$/, 'the pass records the durable-state digest it started from')

    // A fresh running row holds the guard: no new pass is opened for the mission.
    const fresh = writePass(f)
    await sleep(120)
    const held = f.runtime.store.get('passes', keyOf(f.mission.id))
    assert.equal(held.runId, fresh.runId, 'a fresh durable pass row still gates scheduling')

    // An expired row does NOT gate: the watchdog releases it, escalates and the
    // next tick opens a new pass — the tick timer is never swallowed.
    const stale = writePass(f, { runId: 'test-stale', startedAt: Date.now() - 60_000 })
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'scheduling-pass').at(-1),
      'an expired pass row must be escalated by the watchdog', 4_000)
    assert.match(String(event.data.reason), /did not return within its 200ms bound/)
    assert.equal(event.data.wedged, true)
    assert.equal(event.data.boundMs, 200, 'the declared bound is named in the event')
    assert.ok(event.data.runId !== stale.runId || event.data.passId === keyOf(f.mission.id))
    const released = await eventually(() => {
      const row = f.runtime.store.get('passes', keyOf(f.mission.id))
      return row !== undefined && row.runId !== stale.runId ? row : undefined
    }, 'a later tick must open a new pass after the release', 4_000)
    assert.notEqual(released.runId, stale.runId, 'the released guard no longer blocks later ticks')
  } finally { await f.cleanup() }
})

test('S1: a long pass with a live lease is progress and is never abandoned or reported as a stall', async () => {
  const f = await setup({ config: { tickMs: 20, stallPassTimeoutMs: 100, stallPasses: 2 } })
  try {
    const task = f.propose()
    await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    assert.equal(taskOf(f.runtime, task.id).status, 'running')
    // Simulate a pass that has been inside an adapter await for far longer than
    // the bound while a worker holds a live lease (recorded renewals = progress).
    const long = writePass(f, { runId: 'test-live', startedAt: Date.now() - 10_000 })
    await sleep(300)
    const row = f.runtime.store.get('passes', keyOf(f.mission.id))
    assert.equal(row.runId, long.runId, 'a pass with live work keeps its guard')
    assert.equal(row.status, 'running', 'the live pass is not marked stalled')
    assert.deepEqual(events(f.runtime, f.mission.id, 'mission/stalled'), [],
      'a live attempt is progress: no false stall notice may be emitted')
  } finally { await f.cleanup() }
})

test('S5: clearing every in-memory scheduling cache leaves the durable outcome unchanged', async () => {
  const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 200, stallPasses: 50 } })
  try {
    f.workers.autoIdle = true
    // The cache-only entries enumerated on the scheduling path.
    f.runtime.queues.clear()
    f.runtime.idleSignals.clear()
    f.runtime.startFailures.clear()
    f.runtime.budgetStops.clear()
    f.runtime.releasedPasses.clear()
    f.runtime.parkedNotices.clear()
    f.runtime.reviewPathNotices.clear()
    f.runtime.reviewPathReported.clear()
    f.runtime.integrationGapWarned.clear()
    f.runtime.autoReviewAdmissions.clear()
    f.runtime.fingerprintCache.clear()
    const task = f.propose()
    const running = await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? taskOf(f.runtime, task.id) : undefined,
      'dispatch must not depend on any in-memory gate', 4_000)
    assert.equal(running.attempt.ownerId, f.author.id)
    // Exactly one attempt: a cleared queue cache cannot double-dispatch.
    await sleep(120)
    const after = taskOf(f.runtime, task.id)
    assert.equal(after.attempt.id, running.attempt.id, 'no duplicate assignment after the cache is cleared')
    assert.equal(f.runtime.store.get('missions', f.mission.id).isolationRefusal, undefined, 'isolation holds without caches')
  } finally { await f.cleanup() }
})

test('S5: a withdrawn automatic review is not re-admitted after the in-memory cache is cleared', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    // Keep the independent reviewer live: the automatic review needs one, and the
    // withdrawal below is what makes the source unreviewable again.
    const task = f.propose()
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate without a review path' })
    const admitted = await eventually(() => events(f.runtime, f.mission.id, 'task/review-admitted').at(-1),
      'an unreviewable submitted artifact is given an automatic review', 6_000)
    const reviewId = admitted.data.taskId
    // The runtime signature is cancel(actor, missionId, { taskId, reason }).
    f.runtime.cancel(f.owner, f.mission.id, { taskId: reviewId, reason: 'owner withdrew the automatic review' })
    // The durable `task/review-admitted` event is the gate; clearing the cache
    // must not admit a second review for the same source.
    f.runtime.autoReviewAdmissions.clear()
    const blocked = await eventually(() => events(f.runtime, f.mission.id, 'task/review-blocked').at(-1),
      'a withdrawn automatic review must be reported, not silently re-admitted', 8_000)
    assert.match(String(blocked.data.reason), /withdrawn/, 'the durable gate names the withdrawn review')
    assert.equal(events(f.runtime, f.mission.id, 'task/review-admitted').length, 1,
      'no second automatic review is admitted after the cache is lost')
    assert.equal(f.runtime.store.list('tasks', f.mission.id).filter(item => item.reviewOf === task.id).length, 1,
      'exactly one review task exists for the source')
  } finally { await f.cleanup() }
})

test('S5: the durable notice ledger dedups decision notices when the in-memory set is cleared', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    f.runtime.store.transaction(() => {
      const reviewer = f.runtime.store.get('members', f.reviewer.id)
      reviewer.status = 'stopped'
      f.runtime.store.put('members', reviewer)
    })
    const task = f.propose()
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate without a review path' })
    const first = await eventually(() => f.runtime.store.list('deliveries', f.mission.id)
      .find(delivery => delivery.to === 'owner' && delivery.notice?.dedupKey?.startsWith('review-blocked:')), 'the blocker notice is recorded', 8_000)
    // Drop the in-memory dedup set: the durable ledger must still suppress a repeat.
    f.runtime.reviewPathNotices.clear()
    await sleep(200)
    const duplicates = f.runtime.store.list('deliveries', f.mission.id)
      .filter(delivery => delivery.to === 'owner' && delivery.notice?.dedupKey === first.notice.dedupKey)
    assert.equal(duplicates.length, 1, 'the durable notice ledger is the gate, not the cleared set')
  } finally { await f.cleanup() }
})
