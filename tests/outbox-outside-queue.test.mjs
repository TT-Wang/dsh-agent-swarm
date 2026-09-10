/**
 * S2: the outbox pump runs outside the mission queue.
 *
 * Why: notifications were delivered only from inside the scheduling pass
 * (`flushOutbox` was awaited by `schedule()`), so the notice path shared the fate
 * of the thing it had to report on. When the pass wedged for 120 minutes the
 * owner received nothing. `beginBudgetStop` already used the correct shape
 * (defer + a queue-external flush); these tests prove the generalized pump
 * delivers durable notices while the mission lock is held and while a pass is
 * stalled, without the wedged pass ever returning.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeWorkers, setup, eventually, events, budget } from './faults/harness.mjs'

/** The only replaced boundary: one `start` call never resolves once armed. */
class WedgeStartWorkers extends FakeWorkers {
  wedgeNext = false
  async start(spec) {
    this.started.push(spec.member.id)
    if (this.wedgeNext) { this.wedgeNext = false; await new Promise(() => {}) }
    if (this.startError) throw this.startError
  }
}

/** One listed delivery never settles in `deliver`; every other delivery behaves. */
class WedgeDeliverWorkers extends WedgeStartWorkers {
  hung = new Set()
  async deliver(member, delivery) {
    if (this.hung.has(delivery.id)) await new Promise(() => {})
    return await super.deliver(member, delivery)
  }
}

const passRow = f => f.runtime.store.get('passes', `pass_${f.mission.id}`)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Hold the mission lock: arm the wedge, wait until a pass owns the guard, and prove it never returns. */
async function holdLock(f) {
  f.workers.wedgeNext = true
  const row = await eventually(() => {
    const current = passRow(f)
    return current?.status === 'running' ? current : undefined
  }, 'a pass must hold the mission guard', 4_000)
  await sleep(120) // more than ten ticks with the row unchanged: the body is wedged, not busy
  const held = passRow(f)
  assert.equal(held.runId, row.runId, 'the same pass still owns the guard: the mission lock is held')
  assert.equal(held.status, 'running', 'a wedged pass is still running, not silently released')
  return held
}

test('S2: a durable owner notice is delivered by the tick pump while the mission lock is held', async () => {
  const workers = new WedgeStartWorkers()
  const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: 60_000, stallPasses: 50 } })
  try {
    const held = await holdLock(f)
    // A durable notice exactly as `notify` records it: the store is the only channel.
    const notice = {
      id: 'msg_s2_lock_held', missionId: f.mission.id, from: 'runtime', to: 'owner', kind: 'control',
      content: 'S2 fixture: delivered while the mission lock is held', createdAt: Date.now(),
    }
    f.runtime.store.transaction(() => f.runtime.store.put('deliveries', notice))
    await eventually(() => f.workers.deliveries.some(item => item.memberId === 'owner' && item.content === notice.content),
      'the queue-external pump must deliver a durable owner notice while the pass is wedged', 4_000)
    assert.ok(f.runtime.store.get('deliveries', notice.id).deliveredAt !== undefined,
      'the delivery ledger records the claimed delivery durably')
    // The wedged pass never returned, so the pass cannot have delivered it.
    assert.equal(passRow(f).runId, held.runId, 'the delivery did not come from a completed pass')
    assert.equal(passRow(f).status, 'running', 'the mission lock is still held after the delivery')
  } finally { await f.cleanup() }
})

test('S2: a stalled pass still delivers the owner escalation inside the declared bound', async () => {
  const workers = new WedgeStartWorkers()
  const boundMs = 60
  const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: boundMs, stallPasses: 50 } })
  try {
    f.propose()
    // Arm only once the open pass started from the exact current board, so the
    // pass that wedges is the one the injection targets (the same discipline F21
    // uses); otherwise an older queued pass consumes the wedge and the
    // "advanced no durable state" claim would be about a concurrent proposal.
    await eventually(() => {
      const row = passRow(f)
      return row?.status === 'running' && row.fingerprintBefore === f.runtime.fingerprint(f.mission.id) ? true : undefined
    }, 'a pass must open on the current durable board before the wedge is armed', 4_000)
    f.workers.wedgeNext = true
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'scheduling-pass' && item.data.wedged === true).at(-1),
      'the wedge detector must escalate within the declared bound', 6_000)
    assert.equal(event.data.boundMs, boundMs)
    // Only the watchdog can produce a `pass-timeout` escalation: a pass that
    // returned would have closed itself. So the wedged body never completed.
    assert.equal(event.data.stateUnchanged, true)
    assert.equal(event.data.ownerNotified, true)
    const delivered = await eventually(() => f.workers.deliveries
      .find(item => item.memberId === 'owner' && /did not return within 60ms/.test(item.content)),
      'the escalation notice must be delivered while the pass is stalled', 4_000)
    assert.ok(delivered.content.length > 0)
    // The alarm never depended on the pass returning: the escalation came from
    // the tick-time watchdog while the body was still inside its never-settling
    // adapter call, and the guard has already moved on.
    assert.notEqual(passRow(f).runId, event.data.runId, 'the wedged pass was released instead of completing')
  } finally { await f.cleanup() }
})

test('S2: one never-settling adapter deliver cannot starve a notice for another mission', async () => {
  const workers = new WedgeDeliverWorkers()
  const boundMs = 60
  const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: boundMs, stallPasses: 50 } })
  try {
    // A second mission in the SAME runtime: the defect was one global pump
    // flag, so cross-mission delivery is what proves the bound.
    const other = f.runtime.create(f.owner, {
      title: 'Other mission', objective: 'Prove the pump is not globally locked', workspace: f.dir, scope: ['**'],
      acceptance: f.mission.acceptance, budget: { ...budget, maxTasks: 10 },
    })
    const hung = { id: 'msg_s2b_hung', missionId: f.mission.id, from: 'runtime', to: 'owner', kind: 'control', content: 'notice whose delivery never settles', createdAt: Date.now() }
    workers.hung.add(hung.id)
    f.runtime.store.transaction(() => f.runtime.store.put('deliveries', hung))
    // The attempt is abandoned at its bound and the starvation is recorded.
    await eventually(() => f.runtime.store.get('missions', f.mission.id).outboxStarved?.deliveryId === hung.id,
      'an attempt the adapter never settles is abandoned at its bound and recorded durably', 4_000)
    // A notice for the other mission must still be delivered by the same pump.
    const later = { id: 'msg_s2b_later', missionId: other.id, from: 'runtime', to: 'owner', kind: 'control', content: 'later notice for the other mission', createdAt: Date.now() }
    f.runtime.store.transaction(() => f.runtime.store.put('deliveries', later))
    await eventually(() => workers.deliveries.some(item => item.memberId === 'owner' && item.content === later.content),
      'a later notice for another mission must be delivered while the first deliver hangs', 4_000)
    assert.ok(f.runtime.store.get('deliveries', later.id).deliveredAt !== undefined, 'the later delivery is recorded durably')
    // The hung delivery is retried rather than lost: the attempt count grows.
    await eventually(() => (f.runtime.store.get('missions', f.mission.id).outboxStarved?.attempts ?? 0) >= 2,
      'the starved delivery is retried by a later pump', 4_000)
  } finally { await f.cleanup() }
})
