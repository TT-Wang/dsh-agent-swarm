/**
 * F21 (S1): a scheduling pass that never returns must not be able to hide the
 * mission from its own watchdog.
 *
 * Round-13 first-party evidence: the only active mission produced ZERO durable
 * events for 120 minutes after `task/lease-expired` while the same runtime kept
 * serving another mission (77 events in 25 s). The in-memory `scheduled` Set in
 * `Runtime.kick()` swallowed the tick timer's only liveness action, so a pass
 * wedged inside `workers.start` owned the mission's entire control path.
 *
 * Injection: the adapter's `start` never resolves on its own for the first call
 * after the injection is armed; like the real adapter (`HarnessWorkers.start`
 * cancels its opening when the runtime aborts it) it settles only when the
 * runtime's declared start bound (`workerStartTimeoutMs`) aborts it. The bound
 * is set well past the pass bound, so the pass body is wedged for the whole
 * window the watchdog must cover. Assertions are read from durable state only:
 *  I1 the durable `mission/scheduling-stalled` event is committed within the
 *     declared bound (`stallPassTimeoutMs`) and names the pass, the bound, the
 *     unchanged state digest and what was unschedulable;
 *  I2 the owner notice is recorded AND delivered while the pass is still
 *     wedged — the notice path must not share the fate of the pass it reports on;
 *  I3 the work the wedge blocked is dispatched by a later tick once the wedged
 *     await reaches its own bound (the mission queue owns that physical
 *     operation until it settles), without re-arming the stall;
 *  I4 fingerprint dedup keeps one escalation per unchanged board.
 *
 * The earlier fixture let the hung `start` ignore its abort and expected a pass
 * opened after the watchdog release to dispatch while that call still hung. That
 * premise was removed on purpose by two later changes: the watchdog no longer
 * deletes the mission queue tail and a queue waiter is refused rather than run
 * past its bound (a released pass may still own a checkout), and a member whose
 * native start never settles stays fenced from a second start. The scenario now
 * injects the wedge the runtime actually bounds.
 */
import assert from 'node:assert/strict'
import { FakeWorkers, setup, eventually, events, runScenario, taskOf } from './harness.mjs'

/**
 * The external boundary only: one `start` call hangs until the runtime aborts it
 * at its declared start bound (recording when it settled), later ones behave.
 */
class WedgeStartWorkers extends FakeWorkers {
  wedgeNext = false
  wedgeSettledAt
  async start(spec, signal) {
    this.started.push(spec.member.id)
    if (this.wedgeNext) {
      this.wedgeNext = false
      try { await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) }
      finally { this.wedgeSettledAt = Date.now() }
    }
    if (this.startError) throw this.startError
  }
}

await runScenario({
  id: 'F21',
  title: 'A scheduling pass that never returns escalates within the declared bound and releases the guard',
  invariants: ['I1', 'I2', 'I3', 'I4'],
  body: async () => {
    const workers = new WedgeStartWorkers()
    const boundMs = 60
    // The wedged await's own bound: far past the pass bound, so I1 and I2 are
    // observed while the pass body is still wedged.
    const startBoundMs = 1_500
    const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: boundMs, stallPasses: 30, workerStartTimeoutMs: startBoundMs } })
    try {
      const task = f.propose()
      const key = `pass_${f.mission.id}`
      // Arm only once the open pass was itself opened on the current durable
      // board: then "the wedged pass advanced no durable state" is a claim about
      // that pass, not about a concurrent proposal landing mid-pass.
      await eventually(() => {
        const row = f.runtime.store.get('passes', key)
        return row?.status === 'running' && row.fingerprintBefore === f.runtime.fingerprint(f.mission.id) ? true : undefined
      }, 'a pass must open on the current durable board before the wedge is armed', 4_000)
      const fingerprintAtWedge = f.runtime.fingerprint(f.mission.id)
      f.workers.wedgeNext = true

      // I1: the durable stall event inside the declared bound.
      const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled').filter(item => item.data.cause === 'scheduling-pass').filter(item => item.data.wedged === true).at(-1),
        'I1: a pass wedged in a never-resolving adapter start must escalate within the declared bound', 6_000)
      assert.equal(event.data.cause, 'scheduling-pass', 'I1: the pass-level stall is distinguishable from a board stall')
      assert.match(String(event.data.reason), /did not return within its 60ms bound/, 'I1: the wedge path reports the pass timeout')
      assert.equal(event.data.wedged, true, 'I1: the event names the pass as wedged')
      assert.equal(event.data.boundMs, boundMs, 'I1: the declared bound is named')
      assert.equal(event.data.missionFingerprint, fingerprintAtWedge, 'I1: the unchanged state digest is named')
      assert.equal(event.data.stateUnchanged, true, 'I1: the wedged pass advanced no durable state')
      assert.equal(event.data.passId, key, 'I1: the pass row id is named')
      assert.ok(typeof event.data.runId === 'string' && event.data.runId.length > 0, 'I1: the pass execution identity is named')
      assert.ok(Number.isSafeInteger(event.data.revisionBefore) && Number.isSafeInteger(event.data.revisionAtStall), 'I1: the revision window is named')
      assert.ok(Array.isArray(event.data.unschedulable), 'I1: what was unschedulable is named')
      assert.equal(event.data.ownerNotified, true, 'I1: the escalation is the notice witness for this state')
      assert.equal(events(f.runtime, f.mission.id, 'mission/stalled').filter(item => item.data.cause === 'scheduling-pass').filter(item => item.data.wedged === true).length, 1,
        'I4: fingerprint dedup keeps exactly one wedge escalation per unchanged board')

      // I2: the owner notice is durable and delivered without the wedged queue.
      const content = new RegExp(`did not return within ${boundMs}ms`)
      const notice = f.runtime.store.list('deliveries', f.mission.id)
        .find(delivery => delivery.to === 'owner' && content.test(delivery.content))
      assert.ok(notice !== undefined, 'I2: the owner notice is recorded durably')
      const delivered = await eventually(() => f.workers.deliveries.some(item => item.memberId === 'owner' && item.content === notice.content),
        'I2: the owner notice is delivered even though the mission queue is wedged', 4_000)
      assert.equal(delivered, true)
      assert.equal(f.workers.wedgeSettledAt, undefined, 'I2: the notice was delivered while the pass body was still wedged')

      // I3: later ticks are not swallowed. The mission queue owns the physical
      // start until it settles, so the task is dispatched only after the wedged
      // await reaches its own bound, by the next pass.
      assert.equal(taskOf(f.runtime, task.id).status, 'pending', 'I3: the wedged pass never dispatched the task')
      f.workers.autoIdle = true
      const running = await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? taskOf(f.runtime, task.id) : undefined,
        'I3: work blocked by the wedge becomes dispatchable once the wedged start reaches its bound', 6_000)
      assert.equal(running.attempt.ownerId, f.author.id, 'I3: the next pass dispatches normally')
      const claimed = events(f.runtime, f.mission.id, 'task/claimed').find(item => item.data.taskId === task.id)
      assert.ok(claimed !== undefined && f.workers.wedgeSettledAt !== undefined && claimed.createdAt >= f.workers.wedgeSettledAt,
        'I3: the task was dispatched only after the wedged start settled')
      assert.equal(events(f.runtime, f.mission.id, 'mission/stalled').filter(item => item.data.cause === 'scheduling-pass').filter(item => item.data.wedged === true).length, 1,
        'I4: the released guard produced exactly one wedge escalation for the wedged state')

      return {
        passId: event.data.passId, boundMs, wedgedPassStalled: true, stateUnchanged: true,
        ownerNotified: delivered, deliveredWhileWedged: true, dispatchedAfterRelease: task.id, dispatchedAfterSettle: true, escalations: 1,
      }
    } finally { await f.cleanup() }
  },
})
