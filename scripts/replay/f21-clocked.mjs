/**
 * The clocked variant of F21 (tests/faults/f21-scheduling-pass-wedge.mjs, I1-I4)
 * for the full-log oracle: it runs only in oracle mode (`SWARM_ORACLE`, see
 * scripts/replay/oracle.mjs), on the oracle's FakeClock with `manualTick`.
 *
 * F21 lets the runtime's real start timer end the wedge, which no clocked run
 * can reproduce exactly. Here the hung `start` settles only when the scenario
 * releases it, after the watchdog has named the pass on the clock and the
 * owner notice was delivered, so every step happens in the same order on every
 * run. The pass bound is the clock fixture's (a minute of clock time); the
 * clock jumps over it in one step, so the wedge is named by one tick.
 */
import assert from 'node:assert/strict'
import { FakeWorkers, events, now, runScenario, setup, taskOf } from '../../tests/faults/harness.mjs'

if (process.env.SWARM_ORACLE === undefined) throw new Error('f21-clocked runs only under scripts/replay/oracle.mjs (SWARM_ORACLE)')

const wedgeEvents = (runtime, missionId) => events(runtime, missionId, 'mission/stalled').filter(item => item.data.cause === 'scheduling-pass' && item.data.wedged === true)

/** One `start` call hangs until the scenario releases it; later ones behave. */
class WedgeStartWorkers extends FakeWorkers {
  wedgeNext = false
  release
  async start(spec, signal) {
    this.started.push(spec.member.id)
    if (!this.wedgeNext) return
    this.wedgeNext = false
    await new Promise((_resolve, reject) => {
      this.release = () => reject(new Error('Worker startup timed out (released by the scenario)'))
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
}

await runScenario({
  id: 'F21', title: 'Clocked: a wedged scheduling pass is named on the clock and the mission resumes when the body settles', invariants: ['I1', 'I2', 'I3', 'I4'],
  body: async () => {
    const workers = new WedgeStartWorkers()
    const f = await setup({ workers, config: { workerStartTimeoutMs: 3_600_000 } })
    try {
      const bound = f.runtime.stallPassTimeoutMs
      // The proposal kicks a body; it is open on the current board before it
      // runs, so the wedge armed now hangs its first start.
      const task = f.propose()
      assert.ok(f.runtime.scheduling.passes.get(f.mission.id) !== undefined, 'a body is open for the proposal')
      const fingerprintAtWedge = f.runtime.fingerprint(f.mission.id)
      workers.wedgeNext = true
      // The body re-validates the workspace on disk before it starts the member.
      for (let turns = 0; turns < 10_000 && workers.release === undefined; turns++) await new Promise(resolve => setImmediate(resolve))
      assert.ok(workers.release !== undefined, 'the body is wedged in its start')
      // I1/I2: one tick past the bound names the wedge and delivers the notice.
      f.clock.advance(bound + f.runtime.config.tickMs)
      await f.runtime.tick()
      const [event] = wedgeEvents(f.runtime, f.mission.id)
      assert.ok(event !== undefined, 'I1: the wedged pass is named past its bound')
      assert.equal(event.data.missionFingerprint, fingerprintAtWedge, 'I1: the unchanged state digest is named')
      const notice = f.runtime.store.list('deliveries', f.mission.id).find(delivery => delivery.notice?.dedupKey === event.data.noticeKey)
      assert.ok(notice?.deliveredAt !== undefined, 'I2: the owner notice is delivered while the body is wedged')
      // A later tick inside the wedge names nothing new.
      f.clock.advance(f.runtime.config.tickMs)
      await f.runtime.tick()
      assert.equal(wedgeEvents(f.runtime, f.mission.id).length, 1, 'I4: one escalation per naming fact')
      // I3: the released start ends the body; the next pass dispatches.
      assert.equal(taskOf(f.runtime, task.id).status, 'pending', 'I3: the wedged pass never dispatched the task')
      workers.autoIdle = true
      workers.release()
      await f.runtime.settle(f.mission.id)
      f.clock.advance(f.runtime.config.tickMs)
      await f.runtime.tick()
      await f.runtime.settle(f.mission.id)
      const running = taskOf(f.runtime, task.id)
      assert.equal(running.status, 'running', 'I3: the next pass dispatches the task')
      assert.equal(running.attempt.ownerId, f.author.id)
      assert.equal(wedgeEvents(f.runtime, f.mission.id).length, 1, 'I4: the wedge was named once')
      return { passId: event.data.passId, boundMs: bound, namedAt: now() }
    } finally { await f.cleanup() }
  },
})
