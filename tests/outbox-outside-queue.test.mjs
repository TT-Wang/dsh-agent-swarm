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
import { FakeWorkers, FakeClock, setup, eventually, events, budget } from './faults/harness.mjs'

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

/** The scheduling body queued or running on the mission's queue (in memory). */
const passOf = f => f.runtime.scheduling.passes.get(f.mission.id)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Hold the mission lock: arm the wedge, wait until a pass owns the guard, and prove it never returns. */
async function holdLock(f) {
  f.workers.wedgeNext = true
  const pass = await eventually(() => passOf(f), 'a pass must hold the mission guard', 4_000)
  await sleep(120) // more than ten ticks with the record unchanged: the body is wedged, not busy
  const held = passOf(f)
  assert.equal(held, pass, 'the same pass still owns the guard: the mission lock is held')
  return held
}

test('S2: a durable owner notice is delivered by the tick pump while the mission lock is held', async () => {
  const workers = new WedgeStartWorkers()
  const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: 60_000 } })
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
    assert.equal(passOf(f), held, 'the delivery did not come from a completed pass: the mission lock is still held')
  } finally { await f.cleanup() }
})

test('S2: a stalled pass still delivers the owner escalation inside the declared bound', async () => {
  const workers = new WedgeStartWorkers()
  const boundMs = 60
  const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: boundMs } })
  try {
    f.propose()
    // The body that dispatches the proposal re-validates the workspace on disk,
    // so it settles first: no pass that still changes the board takes the wedge.
    await f.runtime.settle(f.mission.id)
    // Arm only once the open pass started from the exact current board, so the
    // pass that wedges is the one the injection targets (the same discipline F21
    // uses); otherwise an older queued pass consumes the wedge and the
    // "advanced no durable state" claim would be about a concurrent proposal.
    await eventually(() => {
      const pass = passOf(f)
      return pass !== undefined && pass.fingerprintBefore === f.runtime.fingerprint(f.mission.id) ? true : undefined
    }, 'a pass must open on the current durable board before the wedge is armed', 4_000)
    f.workers.wedgeNext = true
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'scheduling-pass' && item.data.wedged === true).at(-1),
      'the wedge detector must escalate within the declared bound', 6_000)
    assert.equal(event.data.boundMs, boundMs)
    // Only the watchdog can produce a `pass-timeout` escalation: a pass that
    // returned would have closed itself. So the wedged body never completed.
    assert.equal(event.data.stateUnchanged, true)
    const row = f.runtime.store.list('deliveries', f.mission.id).find(item => item.to === 'owner' && item.notice?.dedupKey === event.data.noticeKey)
    assert.equal(row?.notice.trigger, 'scheduling-pass', 'the escalation names its owner row')
    const delivered = await eventually(() => f.workers.deliveries
      .find(item => item.memberId === 'owner' && /did not return within 60ms/.test(item.content)),
      'the escalation notice must be delivered while the pass is stalled', 4_000)
    assert.ok(delivered.content.length > 0)
    // The alarm never depended on the pass returning: the escalation came from
    // the tick-time watchdog while the body was still inside its never-settling
    // adapter call, which still holds the mission.
    assert.equal(passOf(f)?.operationId, event.data.runId, 'the wedged pass was named while it still held the mission, not after completing')
  } finally { await f.cleanup() }
})

test('S2: one never-settling adapter deliver cannot starve a notice for another mission', async () => {
  const workers = new WedgeDeliverWorkers()
  const boundMs = 60
  const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: boundMs } })
  try {
    // A second mission in the SAME runtime: the defect was one global pump
    // flag, so cross-mission delivery is what proves the bound.
    const other = f.runtime.create(f.owner, {
      title: 'Other mission', objective: 'Prove the pump is not globally locked', workspace: f.dir, scope: ['**'],
      acceptance: f.mission.acceptance, budget: { ...budget, maxTasks: 10 },
    }, { grantRoot: f.dir, source: 'session' })
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

test('S2: pump requests made before a pump starts share that pump, and a request after it starts is a pump of its own', async () => {
  // A request is a pending start, and every request made before that start runs
  // is covered by it: the start reads the outbox after all of them. A tick's
  // outbox guard and a guard terminal the same tick tells are two such requests.
  // The row's recipient is not on the roster, so a pump attempts it without any
  // adapter call and records one more starvation attempt each time it does.
  const clock = new FakeClock()
  const f = await setup({ clock })
  try {
    await f.runtime.settle(f.mission.id)
    const row = { id: 'msg_s2_unrostered', missionId: f.mission.id, from: 'runtime', to: 'member_gone', kind: 'control', content: 'A message to a member missing from the roster', createdAt: clock.now() }
    f.runtime.store.transaction(() => f.runtime.store.put('deliveries', row))
    const attempts = () => f.runtime.store.get('missions', f.mission.id).outboxStarved?.attempts
    for (let request = 0; request < 5; request += 1) f.runtime.notices.pumpOutbox()
    await f.runtime.settle(f.mission.id)
    assert.equal(attempts(), 1, 'five requests in one synchronous span start one pump, which attempts the row once')
    f.runtime.notices.pumpOutbox()
    await f.runtime.settle(f.mission.id)
    assert.equal(attempts(), 2, 'a request made after that pump started is a pump of its own')
    assert.equal(f.runtime.store.get('deliveries', row.id).deliveryFailure?.reason, 'Recipient member_gone is missing from the durable member roster')
  } finally { await f.cleanup() }
})

test('S2: a pump past its bound is superseded, ends with the flush in flight, and leaves the requests it held and every later one to its successor', async () => {
  // Two owner rows hang in deliver until the test releases them, so each pump
  // that reaches one stays in flight. The row before them is addressed to a
  // member missing from the roster: every sweep attempts it without any adapter
  // call and records one more starvation attempt, so the attempts count sweeps.
  const clock = new FakeClock()
  const workers = new FakeWorkers()
  const holds = new Map(['msg_s2_held_first', 'msg_s2_held_second'].map(id => [id, { entered: Promise.withResolvers(), release: Promise.withResolvers() }]))
  workers.deliver = async (member, delivery) => {
    const held = holds.get(delivery.id)
    if (held !== undefined) { held.entered.resolve(); await held.release.promise }
    return await FakeWorkers.prototype.deliver.call(workers, member, delivery)
  }
  const f = await setup({ workers, clock })
  const releaseAll = () => { for (const held of holds.values()) held.release.resolve() }
  try {
    const bound = f.runtime.config.stallPassTimeoutMs
    await f.runtime.settle(f.mission.id)
    const row = (id, to) => ({ id, missionId: f.mission.id, from: 'runtime', to, kind: 'control', content: `S2 fixture ${id}`, createdAt: clock.now() })
    f.runtime.store.transaction(() => {
      f.runtime.store.put('deliveries', row('msg_s2_unrostered', 'member_gone'))
      for (const id of holds.keys()) f.runtime.store.put('deliveries', row(id, 'owner'))
    })
    const attempts = () => f.runtime.store.get('missions', f.mission.id).outboxStarved?.attempts
    const delivered = id => f.runtime.store.get('deliveries', id).deliveredAt !== undefined
    /** One request; resolves to the operation its deferred start runs as. */
    const request = () => { const before = new Set(f.runtime.operations); f.runtime.notices.pumpOutbox(); return [...f.runtime.operations].find(operation => !before.has(operation)) }
    const [first, second] = holds.values()
    const superseded = request()
    await first.entered.promise
    assert.equal(attempts(), 1, 'the first pump swept the unrostered row and holds the first owner row')
    await request()
    assert.equal(attempts(), 1, 'a request inside its bound joins it and starts no sweep')
    clock.advance(bound)
    const successor = request()
    await second.entered.promise
    assert.equal(attempts(), 2, 'a request past its bound starts a successor, which sweeps while the first pump is held')
    first.release.resolve()
    await superseded
    assert.ok(delivered('msg_s2_held_first'), 'the superseded pump finished the attempt in flight')
    assert.equal(attempts(), 2, 'and ended with its flush: the request it held is its successor\'s')
    await request()
    assert.equal(attempts(), 2, 'a request inside the successor\'s bound joins the successor: the superseded pump\'s end left it the current pump')
    second.release.resolve()
    await successor
    assert.ok(delivered('msg_s2_held_second'), 'the successor finished its sweep')
    assert.equal(attempts(), 3, 'and swept once more for the request that joined it')
  } finally { releaseAll(); await f.runtime.settle(f.mission.id); await f.cleanup() }
})

test('S2: only the current pump starts a mission\'s flush, so a superseded pump starts no flush its successor\'s sweep covers', async () => {
  // The first mission's owner row hangs in deliver until released, so the pump
  // that reaches it stays in flight there. The second mission's row is addressed
  // to a member missing from the roster: each flush of that mission attempts it
  // without an adapter call and records one more starvation attempt, so its
  // attempts count the flushes of the second mission.
  const clock = new FakeClock()
  const workers = new FakeWorkers()
  const held = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  workers.deliver = async (member, delivery) => {
    if (delivery.id === 'msg_s2_held') { held.entered.resolve(); await held.release.promise }
    return await FakeWorkers.prototype.deliver.call(workers, member, delivery)
  }
  const f = await setup({ workers, clock })
  try {
    const bound = f.runtime.config.stallPassTimeoutMs
    const other = f.runtime.create(f.owner, {
      title: 'Other mission', objective: 'A second outbox the pump sweeps after the first', workspace: f.dir, scope: ['**'],
      acceptance: f.mission.acceptance, budget: { ...budget, maxTasks: 10 },
    }, { grantRoot: f.dir, source: 'session' })
    await f.runtime.settle(f.mission.id); await f.runtime.settle(other.id)
    const [first, second] = f.runtime.store.list('missions').map(mission => mission.id)
    const row = (id, missionId, to) => ({ id, missionId, from: 'runtime', to, kind: 'control', content: `S2 fixture ${id}`, createdAt: clock.now() })
    f.runtime.store.transaction(() => {
      f.runtime.store.put('deliveries', row('msg_s2_held', first, 'owner'))
      f.runtime.store.put('deliveries', row('msg_s2_unrostered', second, 'member_gone'))
    })
    const attempts = () => f.runtime.store.get('missions', second).outboxStarved?.attempts
    /** One request; resolves to the operation its deferred start runs as. */
    const request = () => { const before = new Set(f.runtime.operations); f.runtime.notices.pumpOutbox(); return [...f.runtime.operations].find(operation => !before.has(operation)) }
    const superseded = request()
    await held.entered.promise
    assert.equal(attempts(), undefined, 'the first pump is held in the first mission and has not reached the second')
    clock.advance(bound)
    await request()
    assert.equal(attempts(), 1, 'its successor passed the held row, which the first pump is still attempting, and flushed the second mission')
    held.release.resolve()
    await superseded
    assert.ok(f.runtime.store.get('deliveries', 'msg_s2_held').deliveredAt !== undefined, 'the superseded pump finished the attempt in flight')
    assert.equal(attempts(), 1, 'and started no flush of the second mission, which its successor\'s sweep had covered')
  } finally { held.release.resolve(); await f.runtime.settle(f.mission.id); await f.cleanup() }
})

test('S2: a row told while a pump sweeps is delivered by that pump\'s next sweep, and the bound a request is judged against is that sweep\'s', async () => {
  // A request that joins a pump asks it for one more sweep, because the sweep in
  // flight may have read the outbox before the request's rows existed. The
  // declared bound measures the sweep in flight, not the pump: a pump sweeping
  // again for a request is not superseded by a request inside that sweep's bound.
  // The first row is addressed to a member missing from the roster, so the
  // starvation attempts count sweeps; the owner rows hang until released.
  const clock = new FakeClock()
  const workers = new FakeWorkers()
  const holds = new Map(['msg_s2_held_first', 'msg_s2_held_later'].map(id => [id, { entered: Promise.withResolvers(), release: Promise.withResolvers() }]))
  workers.deliver = async (member, delivery) => {
    const held = holds.get(delivery.id)
    if (held !== undefined) { held.entered.resolve(); await held.release.promise }
    return await FakeWorkers.prototype.deliver.call(workers, member, delivery)
  }
  const f = await setup({ workers, clock })
  try {
    const bound = f.runtime.config.stallPassTimeoutMs
    await f.runtime.settle(f.mission.id)
    const row = (id, to) => ({ id, missionId: f.mission.id, from: 'runtime', to, kind: 'control', content: `S2 fixture ${id}`, createdAt: clock.now() })
    const put = (id, to) => f.runtime.store.transaction(() => f.runtime.store.put('deliveries', row(id, to)))
    put('msg_s2_unrostered', 'member_gone')
    put('msg_s2_held_first', 'owner')
    const attempts = () => f.runtime.store.get('missions', f.mission.id).outboxStarved?.attempts
    const delivered = id => f.runtime.store.get('deliveries', id).deliveredAt !== undefined
    /** One request; resolves to the operation its deferred start runs as. */
    const request = () => { const before = new Set(f.runtime.operations); f.runtime.notices.pumpOutbox(); return [...f.runtime.operations].find(operation => !before.has(operation)) }
    const [first, later] = holds.values()
    const pump = request()
    await first.entered.promise
    clock.advance(bound - 1)
    put('msg_s2_held_later', 'owner')
    await request()
    assert.equal(attempts(), 1, 'the request joined the pump, whose sweep read the outbox before the later row existed')
    first.release.resolve()
    await later.entered.promise
    assert.ok(delivered('msg_s2_held_first'))
    assert.equal(attempts(), 2, 'the pump swept again for the request that joined it, and holds the later row')
    clock.advance(2)
    await request()
    assert.equal(attempts(), 2, 'one bound after the pump started but inside its second sweep\'s, a request joins it')
    later.release.resolve()
    await pump
    assert.ok(delivered('msg_s2_held_later'), 'the row told while the pump swept was delivered by that pump, with no other request')
    assert.equal(attempts(), 3, 'which swept once more for the request that joined its second sweep')
  } finally { for (const held of holds.values()) held.release.resolve(); await f.runtime.settle(f.mission.id); await f.cleanup() }
})
