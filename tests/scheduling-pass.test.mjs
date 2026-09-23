/**
 * S1 (progress-or-terminate) and the first half of S5 (in-memory gate sets on
 * the scheduling path are caches, never evidence).
 *
 * The Round-13 defect: `Runtime.kick()` deduplicated a mission with the
 * in-memory `scheduled` Set, so a pass wedged in an adapter call swallowed the
 * tick timer's only liveness action and the mission produced zero durable events
 * for 120 minutes while the same process served another mission. The pass guard
 * is again in memory (`Scheduling.passes`: the one body queued or running on the
 * mission's serial queue), with the two properties that incident lacked, and
 * these tests assert them from durable state and from the adapter boundary:
 *  - every await in the pass body is bounded, so a wedged body settles and
 *    releases the record, and a later tick schedules normally;
 *  - the tick watchdog reads the record's start time and names a body past its
 *    bound while the body still holds the mission queue;
 *  - while a body is held no second body is queued behind it, so a wedge is
 *    named once and never followed by refused successor passes;
 *  - a live lease renewed by recorded operations is progress, never a stall;
 *  - clearing the in-memory caches changes no durable outcome (S5), because
 *    every gate either re-reads the store or is pure duplicate suppression.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setup, eventually, events, taskOf, FakeWorkers, SwarmRuntime } from './faults/harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const wedgeEvents = f => events(f.runtime, f.mission.id, 'mission/stalled').filter(item => item.data.cause === 'scheduling-pass' && item.data.wedged === true)

/**
 * The adapter boundary only: once armed, the next `start` hangs until the
 * runtime aborts it at its declared start bound, as `HarnessWorkers.start` does.
 */
class WedgeStartWorkers extends FakeWorkers {
  wedgeNext = false
  wedgedAt
  wedgeSettledAt
  async start(spec, signal) {
    this.started.push(spec.member.id)
    if (!this.wedgeNext) return
    this.wedgeNext = false
    this.wedgedAt = Date.now()
    try { await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) }
    finally { this.wedgeSettledAt = Date.now() }
  }
}

test('S1/S5: a body wedged past its bound is named while it holds the mission, and releases the guard when its own await settles', async () => {
  const workers = new WedgeStartWorkers()
  const f = await setup({ workers, config: { tickMs: 20, stallPassTimeoutMs: 200, stallPasses: 50, workerStartTimeoutMs: 900 } })
  try {
    const scheduling = f.runtime.scheduling
    const opened = []
    const openPass = scheduling.openPass.bind(scheduling)
    scheduling.openPass = missionId => { const pass = openPass(missionId); if (pass !== undefined) opened.push(pass); return pass }
    workers.wedgeNext = true
    const wedged = await eventually(() => workers.wedgedAt !== undefined ? scheduling.passes.get(f.mission.id) : undefined, 'a pass body must wedge in start', 4_000)
    assert.equal(wedged.id, `pass_${f.mission.id}`, 'the mission pass keeps its stable name')
    assert.ok(typeof wedged.operationId === 'string' && wedged.operationId.length > 0, 'each body has its own identity')
    assert.match(wedged.fingerprintBefore, /^[0-9a-f]{32}$/, 'the pass records the durable-state digest it started from')
    const event = await eventually(() => wedgeEvents(f).at(-1), 'the watchdog must name the body past its bound', 4_000)
    assert.match(String(event.data.reason), /did not return within its 200ms bound/)
    assert.equal(event.data.boundMs, 200, 'the declared bound is named in the event')
    assert.equal(event.data.runId, wedged.operationId, 'the event names the wedged body')
    assert.equal(workers.wedgeSettledAt, undefined, 'it was named while the body still held the mission')
    assert.deepEqual(f.runtime.passState(f.mission.id), { passLive: false, wedged: true }, 'the mission publishes as wedged, not as inside a live pass')
    assert.equal(scheduling.passes.get(f.mission.id), wedged, 'no later tick replaced the body the queue still owns')
    const next = await eventually(() => opened.find(pass => pass !== wedged && pass.startedAt >= workers.wedgeSettledAt), 'a later tick must open a new pass once the wedged await settles', 4_000)
    assert.ok(next.startedAt >= workers.wedgeSettledAt, 'the guard was released by the body settling')
    assert.equal(opened.filter(pass => pass.startedAt < workers.wedgeSettledAt && pass !== wedged && pass.startedAt > wedged.startedAt).length, 0,
      'no pass was opened while the wedged body was held')
    assert.equal(wedgeEvents(f).length, 1, 'the wedge is named once')
  } finally { await f.cleanup() }
})

test('S1: a wedged body is not followed by refused successor passes, so the owner hears the wedge once', async () => {
  // Before, every tick past the bound opened another pass behind the wedged
  // body; the mission queue refused each one at its own bound
  // (`mission_operation_pending`) and the refusal became a second owner
  // escalation for the same wedge. A successor could never run before the
  // wedged body settled, so the skipped kick loses nothing.
  const workers = new WedgeStartWorkers()
  const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: 60, stallPasses: 50, workerStartTimeoutMs: 700 } })
  try {
    workers.wedgeNext = true
    await eventually(() => workers.wedgedAt !== undefined ? true : undefined, 'a pass body must wedge in start', 4_000)
    await eventually(() => workers.wedgeSettledAt !== undefined ? true : undefined, 'the wedged start settles at its own bound', 4_000)
    await sleep(100)
    const refusals = events(f.runtime, f.mission.id, 'mission/stalled').filter(item => item.data.cause === 'guard-terminal' && /mission_operation_pending/.test(String(item.data.detail)))
    assert.deepEqual(refusals.map(item => item.data.detail), [], 'no successor pass was queued and refused behind the wedged body')
    assert.equal(wedgeEvents(f).length, 1, 'the wedge itself is named exactly once')
  } finally { await f.cleanup() }
})

test('S1/R16-D: a long pass inside its declared live-work bound is progress and is never named; past that bound it is named with its live work preserved', async () => {
  // Inside `stallPassReleaseBoundMs` (= stallPassTimeoutMs + stallPassLiveGraceMs,
  // both declared) a live lease is progress: the pass stays live and no stall is
  // reported. Past it the pass is named once, and the live work it was held by
  // is preserved untouched. The record below stands for a body that has been
  // inside an adapter await for 150ms of a declared 200ms live-work window.
  const f = await setup({ config: { tickMs: 20, stallPassTimeoutMs: 100, stallPasses: 2 } })
  const scheduling = f.runtime.scheduling
  let long
  try {
    const task = f.propose()
    await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    assert.equal(taskOf(f.runtime, task.id).status, 'running')
    const attemptId = taskOf(f.runtime, task.id).attempt.id
    await eventually(() => scheduling.passes.get(f.mission.id) === undefined ? true : undefined, 'the passes the claim kicked must settle')
    long = { id: scheduling.passKey(f.mission.id), operationId: 'operation_test_live', missionId: f.mission.id, startedAt: Date.now() - 150,
      revisionBefore: f.runtime.store.revision(), fingerprintBefore: f.runtime.fingerprint(f.mission.id), noProgressPasses: 0 }
    scheduling.passes.set(f.mission.id, long)
    await sleep(20)
    assert.equal(scheduling.livePass(f.mission.id), long, 'a pass inside its declared live-work bound stays live')
    assert.deepEqual(events(f.runtime, f.mission.id, 'mission/stalled'), [],
      'a live attempt is progress: no false stall notice may be emitted inside the bound')
    const named = await eventually(() => wedgeEvents(f).find(item => item.data.runId === long.operationId), 'the pass must be named once past its live-work bound', 4_000)
    assert.equal(named.data.releasedWhileLive, true, 'the notice names the live work that held it')
    assert.equal(named.data.releaseBoundMs, 200, 'and the declared bound it was measured against')
    assert.ok(named.data.releaseGapMs >= 200, `named after the whole live-work bound (${named.data.releaseGapMs}ms)`)
    assert.deepEqual(named.data.liveSubjects, [`${task.id}@${taskOf(f.runtime, task.id).epoch}`])
    assert.equal(scheduling.livePass(f.mission.id), undefined, 'a named pass no longer owns generation')
    assert.equal(scheduling.passWedged(f.mission.id), true, 'it is wedged until its body settles')
    await sleep(100)
    assert.equal(wedgeEvents(f).filter(item => item.data.runId === long.operationId).length, 1, 'the body is named exactly once')
    const held = taskOf(f.runtime, task.id)
    assert.equal(held.status, 'running', 'the live lease survives the naming')
    assert.equal(held.attempt.id, attemptId, 'and the attempt is not stopped, dropped or reassigned by it')
    assert.ok(held.attempt.leaseUntil > Date.now(), 'with a lease still in the future')
  } finally { if (long !== undefined) scheduling.closePass(f.mission.id, long); await f.cleanup() }
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
    f.runtime.reviewPathReported.clear()
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

test('S5: a withdrawn automatic review is not re-admitted when its admission falls outside the observation window', async () => {
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
    // The durable exact admission lookup is independent of the UI window.
    f.runtime.config.maxEvents = 1
    const blocked = await eventually(() => events(f.runtime, f.mission.id, 'task/review-blocked').at(-1),
      'a withdrawn automatic review must be reported, not silently re-admitted', 8_000)
    assert.match(String(blocked.data.reason), /withdrawn/, 'the durable gate names the withdrawn review')
    assert.equal(events(f.runtime, f.mission.id, 'task/review-admitted').length, 1,
      'no second automatic review is admitted outside the observation window')
    assert.equal(f.runtime.store.list('tasks', f.mission.id).filter(item => item.reviewOf === task.id).length, 1,
      'exactly one review task exists for the source')
  } finally { await f.cleanup() }
})

test('S5: the durable notice ledger alone dedups a decision notice, within one process and across a restart', async () => {
  // The notice-dedup Sets (parked, integration-gap, review-blocked) are gone.
  // Within one process the delivery row is written synchronously in the call
  // that emits it, so the next pass reads it; after a restart it is the only
  // record there is. Before, an empty set after a restart let the persistent
  // blocker re-run its site, writing a second `task/review-blocked` event.
  const f = await setup({ config: { tickMs: 10 } })
  let restarted
  try {
    f.runtime.store.transaction(() => {
      const reviewer = f.runtime.store.get('members', f.reviewer.id)
      // R17-G7: the durable phase is what stops a member; the live status is derived.
      reviewer.phase = 'stopped'
      f.runtime.store.put('members', reviewer)
    })
    const task = f.propose()
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate without a review path' })
    const first = await eventually(() => f.runtime.store.list('deliveries', f.mission.id)
      .find(delivery => delivery.to === 'owner' && delivery.notice?.dedupKey?.startsWith('review-blocked:')), 'the blocker notice is recorded', 8_000)
    const recorded = runtime => ({
      deliveries: runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice?.dedupKey === first.notice.dedupKey).length,
      events: events(runtime, f.mission.id, 'task/review-blocked').filter(event => event.data.taskId === task.id).length,
    })
    await sleep(200)
    assert.deepEqual(recorded(f.runtime), { deliveries: 1, events: 1 }, 'repeated passes in one process read the durable row')
    await f.runtime.dispose()
    restarted = new SwarmRuntime({ statePath: join(f.dir, 'swarm.sqlite'), leaseMs: 60_000, tickMs: 10, maxMessageChars: 16_000,
      maxEvents: 5_000, maxTasksPerMember: 3, checkTimeoutMs: 30_000 }, new FakeWorkers())
    await restarted.start()
    await sleep(300)
    assert.equal(restarted.store.get('tasks', task.id).status, 'submitted', 'the blocker persists across the restart')
    assert.deepEqual(recorded(restarted), { deliveries: 1, events: 1 }, 'a restart does not re-emit the blocker the ledger already records')
  } finally { if (restarted !== undefined) await restarted.dispose(); await f.cleanup() }
})
