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
import { DatabaseSync } from 'node:sqlite'
import { setup, makeRuntime, events, taskOf, FakeWorkers, FakeClock, SwarmRuntime, MISSION_ACCEPTANCE } from './faults/harness.mjs'

/** `count` ticks of the timer a fake-clock runtime does not run, one tick unit of clock time apart. */
async function ticks(f, count) { for (let n = 0; n < count; n += 1) { f.clock.advance(f.runtime.config.tickMs); await f.runtime.tick() } }
/** Tick until `read` returns a value, as the timer would until it holds; fail after `limit` ticks. */
async function ticksUntil(f, read, message, limit = 200) {
  for (let n = 0; n <= limit; n += 1) { const value = read(); if (value) return value; if (n < limit) await ticks(f, 1) }
  assert.fail(`not within ${limit} ticks: ${message}`)
}
/**
 * An adapter await the test holds: `entered` resolves once the adapter is inside
 * it, and the test ends it (`release`) as the await's own declared bound would.
 */
function hold() {
  const held = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  held.release.promise.catch(() => {})
  return held
}
/**
 * Tick until a body a tick kicked is inside `held`. Such a tick does not return
 * while its body is held, so it is raced against the hold; fail after `limit` ticks.
 */
async function ticksUntilHeld(f, held, message, limit = 50) {
  let inside = false
  void held.entered.promise.then(() => { inside = true })
  for (let n = 0; n < limit && !inside; n += 1) { f.clock.advance(f.runtime.config.tickMs); await Promise.race([f.runtime.tick(), held.entered.promise]) }
  assert.ok(inside, `not within ${limit} ticks: ${message}`)
}
/**
 * An adapter await of `ms` clock time, as the tick timer sees it: the clock moves one tick unit
 * at a time, each step after whatever is already runnable, and the timer's tick (its guards: the
 * outbox pump, the watchdog, sweepDecisions, the mission kicks) runs at each step while the caller
 * stays suspended in the await. The tick is not awaited, as the timer's is not, so a body held
 * past its bound inside the await is named, or held live, exactly as in production.
 */
async function clockWait(f, ms) {
  const step = f.runtime.config.tickMs
  for (let left = ms; left > 0; left -= step) {
    await new Promise(resolve => setImmediate(resolve))
    f.clock.advance(Math.min(step, left))
    void f.runtime.tick()
  }
}
const wedgeEvents = f => events(f.runtime, f.mission.id, 'mission/stalled').filter(item => item.data.cause === 'scheduling-pass' && item.data.wedged === true)

/**
 * The adapter boundary only: once armed (`arm`), the next `start` hangs until
 * the test ends it at its declared start bound, as the runtime's abort ends the
 * hang in `HarnessWorkers.start`. Its instants are the runtime's clock, which
 * it is constructed with (`{ clock }`).
 */
class WedgeStartWorkers extends FakeWorkers {
  wedge
  wedgedAt
  wedgeSettledAt
  arm() { this.wedge = hold(); return this.wedge }
  async start(spec) {
    this.started.push(spec.member.id)
    const wedge = this.wedge
    if (wedge === undefined) return
    this.wedge = undefined
    this.wedgedAt = this.clock.now()
    wedge.entered.resolve()
    try { await wedge.release.promise } finally { this.wedgeSettledAt = this.clock.now() }
  }
}

test('S1/S5: a body wedged past its bound is named while it holds the mission, and releases the guard when its own await settles', async () => {
  // The clock and the ticks are driven by hand, and the wedged start hangs until
  // the test ends it at its declared start bound (900ms of clock).
  const startBoundMs = 900
  const clock = new FakeClock()
  const workers = new WedgeStartWorkers({ clock })
  const f = await setup({ workers, clock, config: { tickMs: 20, stallPassTimeoutMs: 200, stallPasses: 50 } })
  try {
    const scheduling = f.runtime.scheduling
    await f.runtime.settle(f.mission.id)
    const opened = []
    const openPass = scheduling.openPass.bind(scheduling)
    scheduling.openPass = missionId => { const pass = openPass(missionId); if (pass !== undefined) opened.push(pass); return pass }
    const wedge = workers.arm()
    f.runtime.kick(f.mission.id)
    await wedge.entered.promise
    const wedged = scheduling.passes.get(f.mission.id)
    assert.ok(wedged !== undefined, 'a pass body must wedge in start')
    assert.equal(wedged.id, `pass_${f.mission.id}`, 'the mission pass keeps its stable name')
    assert.ok(typeof wedged.operationId === 'string' && wedged.operationId.length > 0, 'each body has its own identity')
    assert.match(wedged.fingerprintBefore, /^[0-9a-f]{32}$/, 'the pass records the durable-state digest it started from')
    const event = await ticksUntil(f, () => wedgeEvents(f).at(-1), 'the watchdog must name the body past its bound', startBoundMs / 20)
    assert.match(String(event.data.reason), /did not return within its 200ms bound/)
    assert.equal(event.data.boundMs, 200, 'the declared bound is named in the event')
    assert.equal(event.data.runId, wedged.operationId, 'the event names the wedged body')
    assert.equal(workers.wedgeSettledAt, undefined, 'it was named while the body still held the mission')
    assert.deepEqual(f.runtime.passState(f.mission.id), { passLive: false, wedged: true }, 'the mission publishes as wedged, not as inside a live pass')
    assert.equal(scheduling.passes.get(f.mission.id), wedged, 'no later tick replaced the body the queue still owns')
    await ticks(f, (workers.wedgedAt + startBoundMs - clock.now()) / 20)
    assert.equal(scheduling.passes.get(f.mission.id), wedged, 'no tick up to the start bound replaced it either')
    wedge.release.reject(new Error(`Worker startup timed out after ${startBoundMs}ms`))
    await f.runtime.settle(f.mission.id)
    const next = await ticksUntil(f, () => opened.find(pass => pass !== wedged && pass.startedAt >= workers.wedgeSettledAt), 'a later tick must open a new pass once the wedged await settles', 10)
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
  //
  // The clock and the ticks are driven by hand, and the wedged start hangs until
  // the test ends it at its declared start bound (700ms of clock). The mission
  // queue's own bound, which refused each successor, is a real timer
  // (stallPassTimeoutMs of wall time) that no clock models; a tick waits for the
  // bodies it kicks, so a successor refused at that bound is recorded before its
  // tick returns, however slow the host is.
  const startBoundMs = 700
  const clock = new FakeClock()
  const workers = new WedgeStartWorkers({ clock })
  const f = await setup({ workers, clock, config: { tickMs: 10, stallPassTimeoutMs: 60, stallPasses: 50 } })
  try {
    await f.runtime.settle(f.mission.id)
    const wedge = workers.arm()
    f.runtime.kick(f.mission.id)
    await wedge.entered.promise
    // Every tick past the 60ms pass bound, up to the start bound, finds the body held.
    await ticks(f, startBoundMs / 10)
    assert.equal(workers.wedgeSettledAt, undefined, 'the body held the mission up to its start bound')
    wedge.release.reject(new Error(`Worker startup timed out after ${startBoundMs}ms`))
    await f.runtime.settle(f.mission.id)
    await ticks(f, 10)
    const refusals = events(f.runtime, f.mission.id, 'mission/stalled').filter(item => item.data.cause === 'guard-terminal' && /mission_operation_pending/.test(String(item.data.detail)))
    assert.deepEqual(refusals.map(item => item.data.detail), [], 'no successor pass was queued and refused behind the wedged body')
    assert.equal(wedgeEvents(f).length, 1, 'the wedge itself is named exactly once')
  } finally { await f.cleanup() }
})

test('S1: every body that wedges is named once, also when an earlier named body left the board unchanged', async () => {
  // Before, the durable wedge key (the board fingerprint) outlived the named
  // body: closePass cleared it only when the board changed during that body.
  // H's every start hangs to its bound, and the second hung body changes
  // nothing, so the third body wedged on the board the key still named: every
  // tick's naming was refused by the key and that wedge got no event, no owner
  // notice and no wedged mark. A named body that settles now clears the key.
  //
  // The clock and the ticks are driven by hand, and each of H's starts hangs
  // until the test ends it at its declared start bound (400ms of clock).
  const startBoundMs = 400
  const clock = new FakeClock()
  class HangEveryStartWorkers extends FakeWorkers {
    names = new Map()
    hangs = []
    /** The hold H's next start enters. */
    next = hold()
    async start(spec) {
      this.started.push(spec.member.id)
      if (this.names.get(spec.member.id) !== 'H') return
      const hang = this.next
      this.next = hold()
      hang.from = clock.now()
      this.hangs.push(hang)
      hang.entered.resolve()
      try { await hang.release.promise } finally { hang.to = clock.now() }
    }
  }
  const workers = new HangEveryStartWorkers()
  workers.autoIdle = true
  const f = await setup({ workers, clock, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000 } })
  try {
    const scheduling = f.runtime.scheduling
    const closed = []
    const closePass = scheduling.closePass.bind(scheduling)
    scheduling.closePass = (missionId, pass) => {
      closed.push({ runId: pass.operationId, heldMs: clock.now() - pass.startedAt, named: pass.escalatedAt !== undefined, unchanged: f.runtime.fingerprint(missionId) === pass.fingerprintBefore })
      return closePass(missionId, pass)
    }
    const h = await f.runtime.addMember(f.owner, f.mission.id, { name: 'H', role: 'implementation', maxOutputTokens: 5_000 })
    // The body addMember kicked is the first to reach H's start, after this step.
    workers.names.set(h.id, 'H')
    f.propose({ title: 'Work for H', assigneeId: h.id })
    for (let n = 0; n < 3; n += 1) {
      const hang = workers.next
      // The failed start is retried one tick unit later, by the body the next tick kicks.
      if (n > 0) await ticksUntilHeld(f, hang, `H's start ${n + 1} hangs`)
      await hang.entered.promise
      await ticks(f, startBoundMs / 10)
      hang.release.reject(new Error(`Worker startup timed out after ${startBoundMs}ms`))
      await f.runtime.settle(f.mission.id)
    }
    await Promise.race([ticks(f, 10), workers.next.entered.promise])
    assert.deepEqual({ hangs: workers.hangs.length, open: scheduling.passes.get(f.mission.id) }, { hangs: 3, open: undefined },
      'H\'s three hung starts settle and the start-failure limit retires it')
    const wedged = closed.filter(body => body.heldMs >= 300)
    assert.equal(wedged.length, 3, `each of H's three hung starts held one body past its bound (${JSON.stringify(closed.filter(body => body.heldMs >= 100))})`)
    assert.ok(wedged.slice(0, -1).some(body => body.unchanged), 'an earlier wedged body left the board it named unchanged')
    const runIds = wedgeEvents(f).map(item => item.data.runId)
    assert.deepEqual(wedged.map(body => body.named), [true, true, true], 'every wedged body was named')
    assert.deepEqual(runIds, wedged.map(body => body.runId), 'once each, in order, by one wedge event per body')
  } finally { await f.cleanup() }
})

test('S1: the renaming of bodies that wedge on an unchanged board stops at the first naming the notice dedup suppressed', async () => {
  // Before, a named body that settled always cleared the wedge key. A start
  // under a recorded outage was never counted, so start-failure retirement never
  // capped the renaming: every body that wedged in H's hung start was named
  // again, about three per second, and each mission/stalled event claimed
  // ownerNotified: true although the notice dedup had suppressed the row. The
  // key is now cleared only when the naming reached the owner, and the event
  // states what notify did. A start under a recorded outage is now also paced to
  // one probe per outage window (tests/start-failure-recovery.test.mjs), so the
  // recurring wedge here is a start that outlives the pass bound and then
  // succeeds: never a failure, so never counted and never retired.
  //
  // Each slow start takes 250ms of the runtime's clock, which it moves while
  // the timer's tick runs (clockWait), and the other ticks are driven by hand.
  class HangEveryStartWorkers extends FakeWorkers {
    names = new Map()
    hangH = false
    hangs = 0
    async start(spec) {
      this.started.push(spec.member.id)
      if (this.names.get(spec.member.id) !== 'H' || !this.hangH) return
      this.hangs += 1
      await clockWait(f, 250)
    }
  }
  const workers = new HangEveryStartWorkers()
  workers.autoIdle = true
  const clock = new FakeClock()
  const f = await setup({ workers, clock, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000 } })
  try {
    const h = await f.runtime.addMember(f.owner, f.mission.id, { name: 'H', role: 'implementation', maxOutputTokens: 5_000 })
    workers.names.set(h.id, 'H')
    const task = f.propose({ title: 'Work for H', assigneeId: h.id })
    await ticksUntil(f, () => taskOf(f.runtime, task.id).status === 'running', 'the task dispatches to H', 400)
    const armedAt = clock.now()
    workers.hangH = true
    await ticksUntil(f, () => workers.hangs >= 7, 'H\'s starts keep outliving the pass bound', 600)
    const namings = wedgeEvents(f).filter(item => item.createdAt >= armedAt)
    assert.ok(workers.hangs >= namings.length + 3, `bodies kept wedging (${workers.hangs} slow starts) after the last naming`)
    assert.equal(f.runtime.store.get('members', h.id).phase, 'active', 'a slow start never fails, so start-failure retirement never caps the renaming')
    assert.ok(namings.length >= 2, `the bodies are named until the notice dedup suppresses one (${namings.length})`)
    assert.deepEqual(namings.map(item => item.data.ownerNotified), [...namings.slice(0, -1).map(() => true), false],
      'every naming reached the owner except the last, a repeat the notice dedup suppressed; nothing is named after it')
    const rows = f.runtime.store.list('deliveries', f.mission.id).filter(item => item.to === 'owner' && item.notice?.trigger === 'scheduling-pass' && item.createdAt >= armedAt)
    assert.equal(rows.length, namings.length - 1, 'each naming that claims ownerNotified has its owner row')
  } finally { await f.cleanup() }
})

test('S1: a naming whose commit fails once is retried by a later tick, and the wedge is named exactly once', async t => {
  // Before, the watchdog marked the body named before its durable write, so a
  // naming that failed on its one tick (here a real SQLite writer lock held by a
  // second connection for exactly that tick) left the wedge unnamed for the rest
  // of the body's life: passState {passLive: false, wedged: true}, no event, no
  // owner notice. The naming now counts only once it has committed. The clock
  // and the ticks are driven by hand, and the author's start stays wedged until
  // the test releases it, so every tick below sees the body at a known age.
  const bound = 10_000
  const clock = new FakeClock()
  class HeldStartWorkers extends FakeWorkers {
    hold
    async start(spec) {
      this.started.push(spec.member.id)
      const hold = this.hold
      if (hold === undefined || hold.entered.done) return
      hold.entered.done = true
      hold.entered.resolve()
      try { await hold.release.promise } finally { hold.settledAt = clock.now() }
    }
  }
  // The writer gives up at once, so the one locked tick fails its commit instead of waiting it out.
  const { dir, runtime, workers, budget, config: { statePath } } = await makeRuntime(t, { workers: new HeldStartWorkers(), clock,
    config: { stallPassTimeoutMs: bound, stallPasses: 1_000 }, storeOptions: { busyTimeoutMs: 5, writerAttempts: 1, writerDelayMs: 0 } })
  const tickFailures = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => { if (/tick failed/.test(String(chunk))) { tickFailures.push(String(chunk)); return true } return write(chunk, ...rest) }
  const hold = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
  hold.release.promise.catch(() => {})
  try {
    await runtime.start()
    const owner = { sessionId: 'pass-owner' }
    const mission = runtime.create(owner, { title: 'Busy naming', objective: 'Name a wedge whose first naming commit fails', workspace: dir, scope: ['**'], acceptance: MISSION_ACCEPTANCE, budget })
    const stream = runtime.workstream(owner, mission.id, { title: 'S', objective: 'S' })
    const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation', maxOutputTokens: 5_000 })
    const wedges = () => events(runtime, mission.id, 'mission/stalled').filter(item => item.data.cause === 'scheduling-pass' && item.data.wedged === true)
    const scheduling = runtime.scheduling
    await runtime.settle(mission.id)
    workers.hold = hold
    const task = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement the scoped change',
      kind: 'implementation', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: ['test -d .'], assigneeId: author.id })
    await hold.entered.promise
    clock.advance(bound)
    // The tick that first finds the body past its bound runs its watchdog under
    // the lock, and only its watchdog.
    const check = scheduling.checkSchedulingPasses.bind(scheduling)
    scheduling.checkSchedulingPasses = now => {
      const other = new DatabaseSync(statePath)
      other.exec('BEGIN IMMEDIATE')
      try { return check(now) } finally { other.exec('ROLLBACK'); other.close() }
    }
    await runtime.tick()
    delete scheduling.checkSchedulingPasses
    assert.deepEqual({ events: wedges().length, escalatedAt: scheduling.passes.get(mission.id)?.escalatedAt }, { events: 0, escalatedAt: undefined },
      'the locked naming committed nothing and did not count as a naming')
    assert.ok(tickFailures.some(line => /WriterBusyError/.test(line)), `the naming commit failed on the busy writer: ${tickFailures.join(' | ')}`)
    await runtime.tick()
    const [event] = wedges()
    assert.ok(event !== undefined, 'the next tick names the wedge once the writer is free')
    assert.equal(hold.settledAt, undefined, 'the retry named the body while it was still wedged')
    assert.ok(runtime.store.list('deliveries', mission.id).some(item => item.to === 'owner' && item.content.includes(`run ${event.data.runId}`)), 'the owner notice committed with the event')
    workers.autoIdle = true
    hold.release.reject(new Error('Worker startup timed out'))
    await runtime.settle(mission.id)
    // The failed start may retry one tick unit later, when the next tick comes.
    clock.advance(runtime.config.tickMs)
    await runtime.tick()
    assert.equal(taskOf(runtime, task.id).status, 'running', 'the task dispatches once the wedged start settles')
    await runtime.tick()
    assert.equal(wedges().length, 1, 'the wedge is named exactly once')
  } finally {
    process.stderr.write = write
    hold.release.reject(new Error('test ended'))
  }
})

test('S1: a wedge that passes its bound while the owner has the mission paused is named after the resume, exactly once', async () => {
  // Pause and resume do not go through the mission queue, so the body keeps
  // waiting inside its bounded await across them. Before, the watchdog marked
  // the body named while the mission was paused (the naming itself returned
  // early for a mission that is not active), and after the resume the wedge was
  // never named: the owner heard nothing until the await's own bound.
  //
  // The clock and the ticks are driven by hand, and the long preparation lasts
  // until the test ends it (1500ms of clock, its own bound).
  const prepareMs = 1_500
  const clock = new FakeClock()
  class SlowPrepareWorkers extends FakeWorkers {
    held = hold()
    enteredAt
    settledAt
    async prepareTask(member, task) {
      const held = this.held
      if (held !== undefined) { this.held = undefined; this.enteredAt = clock.now(); held.entered.resolve(); await held.release.promise; this.settledAt = clock.now() }
      await super.prepareTask(member, task)
    }
  }
  const workers = new SlowPrepareWorkers()
  workers.autoIdle = true
  const held = workers.held
  const f = await setup({ workers, clock, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000 } })
  try {
    await f.runtime.settle(f.mission.id)
    const task = f.propose()
    await held.entered.promise
    f.runtime.control(f.owner, f.mission.id, 'pause', 'owner pause while the body is inside prepareTask')
    await ticks(f, 25)
    assert.equal(f.runtime.scheduling.passWedged(f.mission.id), true, 'the body is past its bound while the mission is paused')
    assert.equal(wedgeEvents(f).length, 0, 'a paused mission is not named')
    const resumedAt = clock.now()
    f.runtime.control(f.owner, f.mission.id, 'resume', 'owner resumes')
    const event = await ticksUntil(f, () => wedgeEvents(f)[0], 'the still-wedged body must be named after the resume', 100)
    assert.ok(event.createdAt >= resumedAt, 'named after the resume')
    assert.equal(workers.settledAt, undefined, 'and while the body was still inside its bounded await')
    await ticks(f, (workers.enteredAt + prepareMs - clock.now()) / 10)
    held.release.resolve()
    await f.runtime.settle(f.mission.id)
    await ticksUntil(f, () => taskOf(f.runtime, task.id).status === 'running', 'the body dispatches once its await settles', 400)
    await ticks(f, 10)
    assert.equal(wedgeEvents(f).length, 1, 'the wedge is named exactly once')
  } finally { await f.cleanup() }
})

test('S1/R17-G5: a named body\'s own commits never publish with the wedged branch, so no dispatch question is asked about work the sweep then dispatches', async () => {
  // The body is named while it waits in the Author's long preparation. When
  // that await settles it keeps sweeping: it claims task A, then prepares and
  // claims task B. Before, the claim of A published with the wedged branch
  // (the body was still named and past its bound), which asked "has an eligible
  // idle member but was not dispatched this tick" about B about 30ms before
  // the same sweep claimed B. A commit the body makes itself proves it is not
  // sitting in the wedged await.
  //
  // Each preparation takes its time of the runtime's clock, which it moves
  // while the timer's tick runs (clockWait), so the watchdog names the body in
  // the Author's preparation; the other ticks are driven by hand.
  class SlowPrepareWorkers extends FakeWorkers {
    names = new Map()
    authorFirst = true
    async prepareTask(member, task) {
      const name = this.names.get(member.id)
      if (name === 'Author' && this.authorFirst) { this.authorFirst = false; await clockWait(f, 150) }
      else if (name === 'Builder') await clockWait(f, 30)
      await super.prepareTask(member, task)
    }
  }
  const workers = new SlowPrepareWorkers()
  workers.autoIdle = true
  const f = await setup({ workers, clock: new FakeClock(), config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000 } })
  try {
    const builder = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5_000 })
    for (const member of [f.author, f.reviewer, builder]) workers.names.set(member.id, member.name)
    await f.runtime.settle(f.mission.id)
    const a = f.propose({ title: 'Task A', assigneeId: f.author.id })
    const b = f.propose({ title: 'Task B', assigneeId: builder.id })
    await ticksUntil(f, () => taskOf(f.runtime, a.id).status === 'running' && taskOf(f.runtime, b.id).status === 'running', 'both tasks dispatch', 400)
    await ticks(f, 15)
    const wedge = wedgeEvents(f)[0]
    assert.ok(wedge !== undefined, 'the body was named while it waited in the long preparation')
    const claimedB = events(f.runtime, f.mission.id, 'task/claimed').find(item => item.data.taskId === b.id)
    assert.ok(claimedB.createdAt > wedge.createdAt, 'task B was dispatched after the naming')
    const questions = f.runtime.store.list('deliveries', f.mission.id).filter(item => item.to === 'owner' && item.notice?.dedupKey?.startsWith('dispatch-question:'))
    assert.deepEqual(questions.filter(item => item.notice.dedupKey.includes(b.id)).map(item => item.content), [],
      'no dispatch question is asked about task B, which the sweep dispatched without any blocker')
  } finally { await f.cleanup() }
})

test('S1/R17-G5: a start that fails past the bound stamps the body before it commits the failure, so no dispatch question is asked about the next member\'s ready task', async () => {
  // Before, the body stamped its progress only once startWorker's promise had
  // settled, but startWorker commits the start failure (onStartFailure) before
  // that. The failure's publication read a stamp from before the hung start,
  // took the wedged branch and asked "has an eligible idle member but was not
  // dispatched this tick" about task T, which the next body dispatched a few
  // milliseconds later. Live work keeps the body live inside its release
  // bound, so the watchdog never names it.
  //
  // The clock and the ticks are driven by hand, and H's start hangs until the
  // test ends it at its declared start bound (400ms of clock).
  const startBoundMs = 400
  const clock = new FakeClock()
  class HangOnceWorkers extends FakeWorkers {
    names = new Map()
    /** The hold H's next start enters. */
    armed
    hang
    async start(spec) {
      this.started.push(spec.member.id)
      const hang = this.armed
      if (this.names.get(spec.member.id) !== 'H' || hang === undefined) return
      this.armed = undefined
      this.hang = hang
      hang.from = clock.now()
      hang.entered.resolve()
      try { await hang.release.promise } finally { hang.to = clock.now() }
    }
  }
  const workers = new HangOnceWorkers()
  const f = await setup({ workers, clock, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPassLiveGraceMs: 20_000, stallPasses: 1_000, attemptSilenceBoundMs: 0 } })
  try {
    const h = await f.runtime.addMember(f.owner, f.mission.id, { name: 'H', role: 'implementation', maxOutputTokens: 5_000 })
    const b = await f.runtime.addMember(f.owner, f.mission.id, { name: 'B', role: 'implementation', maxOutputTokens: 5_000 })
    workers.names.set(h.id, 'H')
    workers.idle.add(f.author.id)
    const live = f.propose({ title: 'Live work' })
    await ticksUntil(f, () => taskOf(f.runtime, live.id).status === 'running', 'the live work dispatches', 400)
    workers.idle.delete(f.author.id)
    workers.idle.add(h.id); workers.idle.add(b.id)
    await ticks(f, 6)
    // One synchronous step: the next body waits in H's start, and T is ready for B, swept after H.
    const hang = workers.armed = hold()
    const t = f.propose({ title: 'T for B', assigneeId: b.id })
    await hang.entered.promise
    // Every tick up to the start bound finds the body past its pass bound, held live by the live work.
    await ticks(f, startBoundMs / 10)
    hang.release.reject(new Error(`Worker startup timed out after ${startBoundMs}ms`))
    await f.runtime.settle(f.mission.id)
    await ticksUntil(f, () => taskOf(f.runtime, t.id).status === 'running', 'T dispatches', 400)
    await ticks(f, 10)
    const failed = events(f.runtime, f.mission.id, 'member/resume-failed').find(item => item.data.memberId === h.id)
    assert.ok(workers.hang?.to !== undefined && failed !== undefined, 'H\'s start hung and its failure was committed')
    const heldMs = workers.hang.to - workers.hang.from
    assert.ok(heldMs >= 100 && heldMs < 100 + 20_000, `the start failed between the pass bound and the release bound (${heldMs}ms)`)
    assert.deepEqual(wedgeEvents(f), [], 'live work kept the body live: it was never named')
    const questions = f.runtime.store.list('deliveries', f.mission.id).filter(item => item.to === 'owner' && item.notice?.dedupKey?.startsWith(`dispatch-question:${f.mission.id}:${t.id}@`))
    assert.deepEqual(questions.map(item => item.content), [], 'no dispatch question is asked about T, which the sweep dispatched')
  } finally { await f.cleanup() }
})

test('S1/R17-G5: a recovery fallback reported from inside the body\'s preparation stamps the body before it commits, so no dispatch question is asked about the task being prepared', async () => {
  // The adapter reports a recovery fallback from inside prepareTask, and the
  // runtime commits it at once. Before, that commit published against the
  // stamp from before the preparation: past the bound it took the wedged
  // branch and asked about T, the very task the body was preparing.
  //
  // The slow preparation takes 150ms of the runtime's clock, which it moves
  // while the timer's tick runs (clockWait); the other ticks are driven by hand.
  class SlowRecoveryWorkers extends FakeWorkers {
    slowFor
    async prepareTask(member, task) {
      if (member.id === this.slowFor) {
        this.slowFor = undefined
        await clockWait(f, 150)
        this.callbacks.recoveryFallback({ missionId: member.missionId, taskId: task.id, epoch: task.epoch, memberId: member.id, previousOwnerId: 'member_previous', commit: 'c'.repeat(40), preserved: true, reason: 'capture refused' })
      }
      return super.prepareTask(member, task)
    }
  }
  const workers = new SlowRecoveryWorkers()
  const f = await setup({ workers, clock: new FakeClock(), budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPassLiveGraceMs: 20_000, stallPasses: 1_000, attemptSilenceBoundMs: 0 } })
  try {
    const b = await f.runtime.addMember(f.owner, f.mission.id, { name: 'B', role: 'implementation', maxOutputTokens: 5_000 })
    workers.idle.add(f.author.id)
    const live = f.propose({ title: 'Live work' })
    await ticksUntil(f, () => taskOf(f.runtime, live.id).status === 'running', 'the live work dispatches', 400)
    workers.idle.delete(f.author.id)
    workers.idle.add(b.id)
    await ticks(f, 6)
    workers.slowFor = b.id
    const t = f.propose({ title: 'T for B', assigneeId: b.id })
    await ticksUntil(f, () => taskOf(f.runtime, t.id).status === 'running', 'T dispatches', 400)
    await ticks(f, 5)
    assert.equal(events(f.runtime, f.mission.id, 'task/recovery-fallback').length, 1, 'the fallback was committed from inside the preparation')
    assert.deepEqual(wedgeEvents(f), [], 'live work kept the body live: it was never named')
    const questions = f.runtime.store.list('deliveries', f.mission.id).filter(item => item.to === 'owner' && item.notice?.dedupKey?.startsWith(`dispatch-question:${f.mission.id}:${t.id}@`))
    assert.deepEqual(questions.map(item => item.content), [], 'no dispatch question is asked about T, which the body was preparing')
  } finally { await f.cleanup() }
})

test('S1/R17-G5: the body stamps each delivery of its own pass-end outbox flush, so a flush past the bound asks no dispatch question', async () => {
  // Before, the pass-end flushOutbox awaited workers.deliver without stamping
  // the body. Deliveries that carried it past its bound published their
  // deliveredAt commits against the stamp of the last member boundary: the
  // wedged branch skipped the rule that an all-busy board is working and named
  // B's busy handle as the holder of T.
  //
  // Each owner delivery waits 60ms of the runtime's clock, which the adapter
  // moves one tick unit at a time while the body is suspended in the delivery,
  // running the timer's tick at each step, and the other ticks are driven by
  // hand: the flush of three facts holds the body for exactly 180ms against its
  // 100ms bound, and the watchdog sees it past that bound, held live by the
  // running live work.
  const clock = new FakeClock()
  class SlowOwnerWorkers extends FakeWorkers {
    slowOwnerMs = 0
    async deliver(member, delivery) {
      if (member.id === 'owner' && this.slowOwnerMs > 0) await clockWait(f, this.slowOwnerMs)
      return super.deliver(member, delivery)
    }
  }
  const workers = new SlowOwnerWorkers()
  const f = await setup({ workers, clock, budget: { maxWorkers: 8 }, config: { stallPassTimeoutMs: 100, stallPassLiveGraceMs: 20_000, stallPasses: 1_000, attemptSilenceBoundMs: 0 } })
  try {
    // Only the body delivers: the queue-external pump is off.
    f.runtime.notices.pumpOutbox = () => {}
    const b = await f.runtime.addMember(f.owner, f.mission.id, { name: 'B', role: 'implementation', maxOutputTokens: 5_000 })
    workers.idle.add(f.author.id)
    const live = f.propose({ title: 'Live work' })
    const t = f.propose({ title: 'T for busy B', assigneeId: b.id })
    await f.runtime.settle(f.mission.id)
    assert.equal(taskOf(f.runtime, live.id).status, 'running', 'the live work dispatches')
    workers.idle.delete(f.author.id)
    await ticks(f, 30)
    workers.slowOwnerMs = 60
    const startedAt = clock.now()
    for (const n of [1, 2, 3]) f.runtime.commit(f.mission.id, () => f.runtime.notify(f.mission.id, `Owner fact ${n}`, [`mission:${f.mission.id}`], { from: 'runtime', dedupKey: `flush-fact-${n}` }))
    f.runtime.kick(f.mission.id)
    await f.runtime.settle(f.mission.id)
    const last = f.runtime.store.list('deliveries', f.mission.id).find(item => item.content === 'Owner fact 3' && item.deliveredAt !== undefined)
    assert.ok(last !== undefined, 'the body delivers the three facts')
    assert.ok(last.deliveredAt - startedAt >= 100, `the flush carried the body past its bound (${last.deliveredAt - startedAt}ms)`)
    await ticks(f, 5)
    assert.equal(taskOf(f.runtime, t.id).status, 'pending', 'T waits for B\'s busy handle')
    const questions = f.runtime.store.list('deliveries', f.mission.id).filter(item => item.to === 'owner' && item.notice?.dedupKey?.startsWith(`dispatch-question:${f.mission.id}:${t.id}@`))
    assert.deepEqual(questions.map(item => item.content), [], 'no question: every eligible handle is busy, so the board is working')
  } finally { await f.cleanup() }
})

test('S1/R17-G5: a worker turn the body woke inside an adapter call keeps committing, but only the body\'s own progress keeps it live, so the wedge publishes and the owner is asked about new work', async () => {
  // The real adapter's isIdle drains a stranded inbox item by waking a Harness
  // turn, which runs in the caller's async context. Called from the body's
  // startBlocker, that turn's heartbeats committed inside the body's context,
  // and every one of them stamped the body's progress: the body sat in H's hung
  // start for the whole start bound, published as a live pass, and the owner
  // was never asked about task Z proposed for idle member I until the start
  // settled. Only the body's own awaits and member boundaries count as its
  // progress now.
  //
  // The clock and the ticks are driven by hand, and H's start hangs until the
  // test ends it at its declared start bound (1500ms of clock). The woken turn
  // is the Harness turn's shape: it runs in the async context of the isIdle
  // call that woke it, inside the body, and its tool republishes the member's
  // activity at each beat, one every 40ms of clock (`beat`).
  const startBoundMs = 1_500
  const clock = new FakeClock()
  class StrandedInboxWorkers extends FakeWorkers {
    names = new Map()
    busy = new Set()
    stranded = new Set()
    turns = 0
    heartbeats = 0
    beats = Promise.withResolvers()
    ended = false
    /** The hold H's next start enters. */
    armed
    hang
    async start(spec) {
      this.started.push(spec.member.id)
      const hang = this.armed
      if (this.names.get(spec.member.id) !== 'H' || hang === undefined) return
      this.armed = undefined
      this.hang = hang
      hang.from = clock.now()
      hang.entered.resolve()
      try { await hang.release.promise } finally { hang.to = clock.now() }
    }
    isIdle(id) {
      if (this.stranded.delete(id)) { this.wake(id); return true }
      return !this.busy.has(id)
    }
    /** The woken turn: its running tool republishes the member's activity at every beat. */
    wake(id) {
      const startedAt = clock.now()
      this.busy.add(id)
      this.turns += 1
      void (async () => {
        for (;;) {
          await this.beats.promise
          if (this.ended) return
          this.heartbeats += 1
          this.callbacks.activity(id, { id: 'op-tool', kind: 'tool', tool: 'bash', startedAt, updatedAt: clock.now() })
        }
      })()
    }
    /** One beat of every woken turn's tool. */
    beat() { const beats = this.beats; this.beats = Promise.withResolvers(); beats.resolve() }
  }
  const workers = new StrandedInboxWorkers()
  /** Tick through `ms` of clock, the woken turn beating every 40ms of it. */
  const beating = async ms => { for (let at = 0; at < ms; at += 40) { await ticks(f, 4); workers.beat(); await new Promise(resolve => setImmediate(resolve)) } }
  const f = await setup({ workers, clock, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000 } })
  try {
    const h = await f.runtime.addMember(f.owner, f.mission.id, { name: 'H', role: 'implementation', maxOutputTokens: 5_000 })
    const i = await f.runtime.addMember(f.owner, f.mission.id, { name: 'I', role: 'implementation', maxOutputTokens: 5_000 })
    workers.names.set(h.id, 'H')
    const running = f.propose({ title: 'Author work' })
    await ticksUntil(f, () => taskOf(f.runtime, running.id).status === 'running', 'the Author task dispatches', 400)
    await ticks(f, 5)
    // Armed in one synchronous step: the next body's startBlocker(Author) drains
    // the stranded item and wakes the turn, then the body waits in H's start.
    workers.stranded.add(f.author.id)
    const hang = workers.armed = hold()
    await ticksUntilHeld(f, hang, 'the body waits in H\'s hung start')
    let named
    while (named === undefined && clock.now() - hang.from < startBoundMs - 200) { await beating(40); named = wedgeEvents(f)[0] }
    assert.ok(named !== undefined, 'the body is named while it waits in H\'s start')
    assert.equal(hang.to, undefined, 'named while H\'s start still hangs')
    assert.equal(workers.turns, 1, 'the stranded drain woke one turn from inside the body')
    const beatsAtNaming = workers.heartbeats
    await beating(100)
    assert.ok(workers.heartbeats > beatsAtNaming, 'the woken turn keeps committing its heartbeats during the wedge')
    assert.deepEqual(f.runtime.passState(f.mission.id), { passLive: false, wedged: true }, 'yet the body publishes as wedged, not as a live pass')
    const z = f.propose({ title: 'Z work for idle I', assigneeId: i.id })
    const zQuestion = () => f.runtime.store.list('deliveries', f.mission.id)
      .find(item => item.to === 'owner' && item.notice?.dedupKey?.startsWith(`dispatch-question:${f.mission.id}:${z.id}@`))
    let question = zQuestion()
    while (question === undefined && clock.now() - hang.from < startBoundMs - 40) { await beating(40); question = zQuestion() }
    assert.ok(question !== undefined, 'the owner is asked about Z during the wedge')
    assert.equal(hang.to, undefined, 'the question was asked while the body still waited in H\'s start')
    assert.ok(question.createdAt > named.createdAt, 'after the naming')
    assert.ok(clock.now() - hang.from < startBoundMs, 'all inside H\'s start bound')
  } finally {
    workers.ended = true
    workers.beat()
    workers.armed = undefined
    workers.hang?.release.reject(new Error('test ended'))
    await f.cleanup()
  }
})

test('S1: a body past its bound stops at the next member boundary, so lease recovery waits for one long await, not for every member\'s', async () => {
  // Three members whose first native start hangs for four pass bounds, and a
  // healthy member X whose running task's lease expires meanwhile. Before, the
  // named body swept every member and then flushed, so lease-expiry recovery
  // (the first step of every body) waited for all three hung starts: about
  // (N-1) start bounds after the lease expired. A body past its bound now stops
  // at the next member boundary; the next body starts from lease recovery and
  // sweeps from the member the previous one stopped before.
  //
  // The clock is driven by hand and each hang ends when the test releases it,
  // as the declared start bound would end it. The hangs are armed in the same
  // synchronous step that proposes X, so one body claims X (its lease starts)
  // and then enters A's hang; the lease expires half-way through B's hang. An
  // early-stopping body has recovered the lease by the time the sweep reaches
  // C's hang, at the instant B's hang ended; a full sweep has not.
  const bound = 10_000
  const hangMs = 4 * bound
  const leaseMs = 1.5 * hangMs
  const clock = new FakeClock()
  class HangFirstStartWorkers extends FakeWorkers {
    hangs = new Map()
    arm(memberId) {
      const hang = { entered: Promise.withResolvers(), release: Promise.withResolvers() }
      hang.release.promise.catch(() => {})
      this.hangs.set(memberId, hang)
    }
    async start(spec) {
      this.started.push(spec.member.id)
      const hang = this.hangs.get(spec.member.id)
      if (hang === undefined || hang.index !== undefined) return
      hang.index = this.started.length - 1
      hang.from = clock.now()
      hang.entered.resolve()
      try { await hang.release.promise } finally { hang.to = clock.now() }
    }
    /** End a hung start as its start bound would: `ms` of clock time after it began. */
    end(memberId, ms) {
      clock.advance(ms)
      this.hangs.get(memberId).release.reject(new Error('Worker startup timed out'))
    }
  }
  const workers = new HangFirstStartWorkers()
  workers.autoIdle = true
  const f = await setup({ workers, clock, budget: { maxWorkers: 8 }, config: { leaseMs, stallPassTimeoutMs: bound, stallPasses: 1_000 } })
  try {
    const hanging = []
    for (const name of ['A', 'B', 'C']) hanging.push(await f.runtime.addMember(f.owner, f.mission.id, { name, role: 'implementation', maxOutputTokens: 5_000 }))
    await f.runtime.settle(f.mission.id)
    const [a, b, c] = hanging
    for (const member of hanging) workers.arm(member.id)
    const task = f.propose({ title: 'Task X' })
    await workers.hangs.get(a.id).entered.promise
    const { leaseUntil } = taskOf(f.runtime, task.id).attempt
    assert.equal(leaseUntil, workers.hangs.get(a.id).from + leaseMs, 'the body claimed X before it entered A\'s hang')
    workers.end(a.id, hangMs)
    await workers.hangs.get(b.id).entered.promise
    assert.equal(workers.started[workers.hangs.get(a.id).index + 1], b.id, 'the body after A\'s hung start sweeps first from B, the member the stopped body did not reach')
    workers.end(b.id, hangMs)
    await workers.hangs.get(c.id).entered.promise
    const hangB = workers.hangs.get(b.id)
    assert.ok(hangB.from < leaseUntil && leaseUntil < hangB.to, 'the lease expired while B\'s start hung')
    const expired = events(f.runtime, f.mission.id, 'task/lease-expired').find(item => item.data.taskId === task.id)
    assert.ok(expired !== undefined, 'the lease was recovered before the sweep reached C\'s hung start, not after a further start bound')
    assert.equal(expired.createdAt, hangB.to, 'at the instant the hang in flight at the expiry ended')
    assert.equal(workers.started[hangB.index + 1], c.id, 'and the body after B\'s sweeps from C')
    workers.end(c.id, hangMs)
    await f.runtime.settle(f.mission.id)
    // C's failed start may retry one tick unit later, when the next tick comes.
    clock.advance(f.runtime.config.tickMs)
    await f.runtime.tick()
    assert.deepEqual(hanging.filter(member => workers.started.lastIndexOf(member.id) <= workers.hangs.get(member.id).index).map(member => member.name), [],
      'every member is started again after its hung start settles')
  } finally {
    for (const hang of workers.hangs.values()) hang.release.reject(new Error('test ended'))
    await f.cleanup()
  }
})

/** Record every scheduling body as it closes, with the pass-end steps it ran, and count the outbox flushes. */
function watchBodies(f) {
  const scheduling = f.runtime.scheduling
  const bodies = []
  const ran = new WeakMap()
  const mark = (missionId, step) => { const pass = scheduling.passes.get(missionId); if (pass !== undefined) ran.set(pass, { ...ran.get(pass), [step]: true }) }
  let flushes = 0
  const closePass = scheduling.closePass.bind(scheduling)
  scheduling.closePass = (missionId, pass) => {
    bodies.push({ stopped: pass.stoppedBefore !== undefined, sweepFrom: pass.sweepFrom, witnessed: ran.get(pass)?.witnessed === true, flushed: ran.get(pass)?.flushed === true })
    return closePass(missionId, pass)
  }
  const ensureWitness = f.runtime.ensureWitness.bind(f.runtime)
  f.runtime.ensureWitness = (missionId, ...rest) => { mark(missionId, 'witnessed'); return ensureWitness(missionId, ...rest) }
  const flushOutbox = f.runtime.flushOutbox.bind(f.runtime)
  f.runtime.flushOutbox = (missionId, ...rest) => { flushes += 1; mark(missionId, 'flushed'); return flushOutbox(missionId, ...rest) }
  return { bodies, flushes: () => flushes }
}

test('S1: a body whose members each take less than a bound is not stopped early, however long its sweep takes', async () => {
  // Round 3 stopped a body early only when the event loop had idled since its
  // previous stamp, which any I/O await satisfies; round 4 stopped any body
  // past its bound, which turned a sweep of quick members into a chain of
  // bodies and halved the sweep rate. A body now stops early only when the
  // member it just swept held it for a whole bound: here the adapter start of
  // each of sixteen more members computes for 4ms against a 60ms bound, so every
  // sweep runs past the bound while no member comes near holding it for one.
  // The computation is 4ms of the runtime's clock, which the start moves itself,
  // and the ticks are driven by hand, so no process pause lengthens a member and
  // the one stop the assertion tolerates is never used. The round-4 rule stops
  // the first body of every tick here, half of all bodies.
  const clock = new FakeClock()
  class ComputingStartWorkers extends FakeWorkers {
    async start(spec) {
      this.started.push(spec.member.id)
      clock.advance(4) // the adapter's synchronous work
    }
    isIdle() { return false }
  }
  const workers = new ComputingStartWorkers()
  const f = await setup({ workers, clock, budget: { maxWorkers: 24 }, config: { stallPassTimeoutMs: 60, stallPasses: 1_000 } })
  try {
    for (let n = 0; n < 16; n += 1) await f.runtime.addMember(f.owner, f.mission.id, { name: `Busy ${n}`, role: 'implementation', maxOutputTokens: 5_000 })
    const members = f.runtime.store.list('members', f.mission.id).map(member => member.id)
    await ticks(f, 20)
    const watched = watchBodies(f)
    const firstStart = workers.started.length
    // Each tick runs one body, whose sweep of eighteen members takes 72ms of clock.
    await ticks(f, 8)
    const bodies = [...watched.bodies]
    assert.ok(bodies.length >= 5, `bodies ran: ${bodies.length}`)
    const stopped = bodies.filter(body => body.stopped)
    assert.ok(stopped.length <= 1, `members that each take less than a bound stop no body (${stopped.length} of ${bodies.length} stopped)`)
    assert.deepEqual(bodies.filter(body => !body.stopped && (!body.witnessed || !body.flushed)), [], 'every body that completes its sweep runs ensureWitness and flushOutbox')
    assert.deepEqual(members.filter(id => !workers.started.slice(firstStart).includes(id)), [], 'every member is started')
  } finally { await f.cleanup() }
})

test('S1: a chain of early-stopped bodies covers one rotation, and the body that completes it runs the pass-end steps and leaves the next body to the tick', async () => {
  // Before, a body that stopped early queued the next at once however far the
  // chain had come. When no body could sweep the whole rotation within its
  // bound (here every member's start waits 40ms against a 30ms bound) the
  // chain never ended: no body ran ensureWitness or flushOutbox, and bodies
  // ran back to back without the tick. A chained body now ends its sweep
  // before the member its chain started from.
  //
  // Each start waits 40ms of the runtime's clock, which the adapter moves one
  // tick unit at a time while the body is suspended in the start, running the
  // timer's tick at each step, so the watchdog names a body held past its bound
  // as in production; the other ticks are driven by hand. A tick waits for the
  // chain it kicks, so a chain that never ends (the defect) is cut once there
  // are more bodies than the driven ticks' rotations hold, and the assertions
  // below then fail on it.
  const clock = new FakeClock()
  class SlowStartWorkers extends FakeWorkers {
    slow = false
    async start(spec) {
      this.started.push(spec.member.id)
      if (this.slow) await clockWait(f, 40)
    }
  }
  const workers = new SlowStartWorkers()
  const f = await setup({ workers, clock, budget: { maxWorkers: 8 }, config: { stallPassTimeoutMs: 30, stallPasses: 1_000 } })
  try {
    for (const name of ['C', 'D']) await f.runtime.addMember(f.owner, f.mission.id, { name, role: 'implementation', maxOutputTokens: 5_000 })
    const members = f.runtime.store.list('members', f.mission.id).length
    await ticks(f, 10)
    workers.slow = true
    await f.runtime.settle(f.mission.id)
    assert.equal(f.runtime.scheduling.passes.get(f.mission.id), undefined, 'the body that saw the fast starts settles')
    const watched = watchBodies(f)
    const driven = 3
    const cut = Promise.withResolvers()
    const closePass = f.runtime.scheduling.closePass
    f.runtime.scheduling.closePass = (missionId, pass) => { const closed = closePass(missionId, pass); if (watched.bodies.length > driven * members) cut.resolve(); return closed }
    for (let n = 0; n < driven; n += 1) await Promise.race([ticks(f, 1), cut.promise])
    const bodies = [...watched.bodies]
    const completed = bodies.filter(body => !body.stopped).length
    assert.ok(completed >= 2, `chains end: ${completed} of ${bodies.length} bodies completed the rotation`)
    assert.ok(watched.flushes() >= completed, 'and each completing body ran the pass-end steps')
    let chain = 0
    for (const [index, body] of bodies.entries()) {
      if (index > 0 && !bodies[index - 1].stopped) assert.equal(body.sweepFrom, undefined, 'the body after a completed rotation is a fresh one from the tick, not a continuation')
      chain = body.stopped ? chain + 1 : 0
      assert.ok(chain <= members - 1, `a chain of ${chain} early stops stays within one rotation of ${members} members`)
    }
    assert.ok(bodies.some(body => body.stopped), 'bodies did stop early past their bound')
  } finally { await f.cleanup() }
})

test('S1: the watchdog, passWedged and livePass read one bound predicate, so they agree at exactly the bound', async () => {
  // Before, the watchdog named a body once its age reached the bound while
  // passWedged reported it wedged only past the bound. At age == bound a body
  // was named while passWedged still read false, so the writer-lock wrappers
  // keyed on passWedged (the naming-retry test above and F21 I5) let that
  // naming tick run unlocked and commit. The runtime's clock stands still for
  // each instant: it moves only by hand.
  const clock = new FakeClock()
  const f = await setup({ clock, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000 } })
  const scheduling = f.runtime.scheduling
  let pass
  try {
    await f.runtime.settle(f.mission.id)
    assert.equal(scheduling.passes.get(f.mission.id), undefined, 'the setup passes settle')
    const fixed = clock.now()
    pass = { id: scheduling.passKey(f.mission.id), operationId: 'operation_test_boundary', missionId: f.mission.id, startedAt: fixed - 99,
      revisionBefore: f.runtime.store.revision(), fingerprintBefore: f.runtime.fingerprint(f.mission.id), noProgressPasses: 0 }
    scheduling.passes.set(f.mission.id, pass)
    const before = { wedged: scheduling.passWedged(f.mission.id), live: scheduling.livePass(f.mission.id) === pass }
    scheduling.checkSchedulingPasses()
    assert.deepEqual({ ...before, named: pass.escalatedAt !== undefined }, { wedged: false, live: true, named: false }, 'one tick inside the bound: live, not wedged, not named')
    pass.startedAt = fixed - 100
    const at = { wedged: scheduling.passWedged(f.mission.id), live: scheduling.livePass(f.mission.id) === pass }
    scheduling.checkSchedulingPasses()
    assert.deepEqual({ ...at, named: pass.escalatedAt !== undefined }, { wedged: true, live: false, named: true },
      'at exactly the bound the body is wedged, no longer live, and the watchdog names it')
    assert.equal(wedgeEvents(f).filter(item => item.data.runId === pass.operationId).length, 1, 'named once')
  } finally {
    if (pass !== undefined) scheduling.closePass(f.mission.id, pass)
    await f.cleanup()
  }
})

test('S1/R16-D: a long pass inside its declared live-work bound is progress and is never named; past that bound it is named with its live work preserved', async () => {
  // Inside `stallPassReleaseBoundMs` (= stallPassTimeoutMs + stallPassLiveGraceMs,
  // both declared) a live lease is progress: the pass stays live and no stall is
  // reported. Past it the pass is named once, and the live work it was held by
  // is preserved untouched. The record below stands for a body that has been
  // inside an adapter await for 150ms of a declared 200ms live-work window.
  // The clock and the ticks are driven by hand.
  const clock = new FakeClock()
  const f = await setup({ clock, config: { tickMs: 20, stallPassTimeoutMs: 100, stallPasses: 2 } })
  const scheduling = f.runtime.scheduling
  let long
  try {
    const task = f.propose()
    await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    assert.equal(taskOf(f.runtime, task.id).status, 'running')
    const attemptId = taskOf(f.runtime, task.id).attempt.id
    await f.runtime.settle(f.mission.id)
    assert.equal(scheduling.passes.get(f.mission.id), undefined, 'the passes the claim kicked must settle')
    long = { id: scheduling.passKey(f.mission.id), operationId: 'operation_test_live', missionId: f.mission.id, startedAt: clock.now() - 150,
      revisionBefore: f.runtime.store.revision(), fingerprintBefore: f.runtime.fingerprint(f.mission.id), noProgressPasses: 0 }
    scheduling.passes.set(f.mission.id, long)
    await ticks(f, 1)
    assert.equal(scheduling.livePass(f.mission.id), long, 'a pass inside its declared live-work bound stays live')
    assert.deepEqual(events(f.runtime, f.mission.id, 'mission/stalled'), [],
      'a live attempt is progress: no false stall notice may be emitted inside the bound')
    const named = await ticksUntil(f, () => wedgeEvents(f).find(item => item.data.runId === long.operationId), 'the pass must be named once past its live-work bound', 200)
    assert.equal(named.data.releasedWhileLive, true, 'the notice names the live work that held it')
    assert.equal(named.data.releaseBoundMs, 200, 'and the declared bound it was measured against')
    assert.ok(named.data.releaseGapMs >= 200, `named after the whole live-work bound (${named.data.releaseGapMs}ms)`)
    assert.deepEqual(named.data.liveSubjects, [`${task.id}@${taskOf(f.runtime, task.id).epoch}`])
    assert.equal(scheduling.livePass(f.mission.id), undefined, 'a named pass no longer owns generation')
    assert.equal(scheduling.passWedged(f.mission.id), true, 'it is wedged until its body settles')
    await ticks(f, 5)
    assert.equal(wedgeEvents(f).filter(item => item.data.runId === long.operationId).length, 1, 'the body is named exactly once')
    const held = taskOf(f.runtime, task.id)
    assert.equal(held.status, 'running', 'the live lease survives the naming')
    assert.equal(held.attempt.id, attemptId, 'and the attempt is not stopped, dropped or reassigned by it')
    assert.ok(held.attempt.leaseUntil > clock.now(), 'with a lease still in the future')
  } finally { if (long !== undefined) scheduling.closePass(f.mission.id, long); await f.cleanup() }
})

test('S5: clearing every in-memory scheduling cache leaves the durable outcome unchanged', async () => {
  // The clock and the ticks are driven by hand.
  const f = await setup({ clock: new FakeClock(), config: { tickMs: 10, stallPassTimeoutMs: 200, stallPasses: 50 } })
  try {
    f.workers.autoIdle = true
    // The cache-only entries enumerated on the scheduling path, cleared while
    // the bodies the setup kicked may still be queued.
    f.runtime.queues.clear()
    f.runtime.idleSignals.clear()
    f.runtime.startFailures.clear()
    f.runtime.budgetStops.clear()
    f.runtime.reviewPathReported.clear()
    f.runtime.fingerprintCache.clear()
    const task = f.propose()
    const running = await ticksUntil(f, () => taskOf(f.runtime, task.id).status === 'running' ? taskOf(f.runtime, task.id) : undefined,
      'dispatch must not depend on any in-memory gate', 400)
    assert.equal(running.attempt.ownerId, f.author.id)
    // Exactly one attempt: a cleared queue cache cannot double-dispatch.
    await ticks(f, 12)
    const after = taskOf(f.runtime, task.id)
    assert.equal(after.attempt.id, running.attempt.id, 'no duplicate assignment after the cache is cleared')
    assert.equal(f.runtime.store.get('missions', f.mission.id).isolationRefusal, undefined, 'isolation holds without caches')
  } finally { await f.cleanup() }
})

test('S5: a withdrawn automatic review is not re-admitted when its admission falls outside the observation window', async () => {
  // The clock and the ticks are driven by hand.
  const f = await setup({ clock: new FakeClock(), config: { tickMs: 10 } })
  try {
    // Keep the independent reviewer live: the automatic review needs one, and the
    // withdrawal below is what makes the source unreviewable again.
    const task = f.propose()
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate without a review path' })
    const admitted = await ticksUntil(f, () => events(f.runtime, f.mission.id, 'task/review-admitted').at(-1),
      'an unreviewable submitted artifact is given an automatic review', 600)
    const reviewId = admitted.data.taskId
    // The runtime signature is cancel(actor, missionId, { taskId, reason }).
    f.runtime.cancel(f.owner, f.mission.id, { taskId: reviewId, reason: 'owner withdrew the automatic review' })
    // The durable exact admission lookup is independent of the UI window.
    f.runtime.config.maxEvents = 1
    const blocked = await ticksUntil(f, () => events(f.runtime, f.mission.id, 'task/review-blocked').at(-1),
      'a withdrawn automatic review must be reported, not silently re-admitted', 800)
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
  // The clock and the ticks are driven by hand, for the restarted runtime too.
  const clock = new FakeClock()
  const f = await setup({ clock, config: { tickMs: 10 } })
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
    const first = await ticksUntil(f, () => f.runtime.store.list('deliveries', f.mission.id)
      .find(delivery => delivery.to === 'owner' && delivery.notice?.dedupKey?.startsWith('review-blocked:')), 'the blocker notice is recorded', 800)
    const recorded = runtime => ({
      deliveries: runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice?.dedupKey === first.notice.dedupKey).length,
      events: events(runtime, f.mission.id, 'task/review-blocked').filter(event => event.data.taskId === task.id).length,
    })
    await ticks(f, 20)
    assert.deepEqual(recorded(f.runtime), { deliveries: 1, events: 1 }, 'repeated passes in one process read the durable row')
    await f.runtime.dispose()
    restarted = new SwarmRuntime({ statePath: join(f.dir, 'swarm.sqlite'), leaseMs: 60_000, tickMs: 10, maxMessageChars: 16_000,
      maxEvents: 5_000, maxTasksPerMember: 3, checkTimeoutMs: 30_000, manualTick: true, now: clock.now, stallPassTimeoutMs: 60_000 }, new FakeWorkers())
    await restarted.start()
    await restarted.settle(f.mission.id)
    await ticks({ clock, runtime: restarted }, 30)
    assert.equal(restarted.store.get('tasks', task.id).status, 'submitted', 'the blocker persists across the restart')
    assert.deepEqual(recorded(restarted), { deliveries: 1, events: 1 }, 'a restart does not re-emit the blocker the ledger already records')
  } finally { if (restarted !== undefined) await restarted.dispose(); await f.cleanup() }
})

test('manualTick runs no timer while tickMs stays the tick unit: settle() returns once the kicked body has settled, tick() runs the guards once and waits for the body it kicked, and a tick-derived window elapses on the clock', async () => {
  // Before, every runtime installed a tick timer and had no awaitable pass, so
  // a test could only poll real time for the effects of a kick or a tick. Then
  // tickMs 0 meant both "no timer" and "a tick unit of 0", so every fake-clock
  // runtime ran each tick-derived window at zero and no test could reach one.
  const clock = new FakeClock()
  const f = await setup({ clock, config: { stallPasses: 1_000 } })
  const scheduling = f.runtime.scheduling
  try {
    assert.equal(f.runtime.timer, undefined, 'no tick timer is installed')
    const { tickMs } = f.runtime.config
    assert.equal(tickMs, 10, 'the tick unit is unchanged')
    await f.runtime.settle(f.mission.id)
    assert.equal(scheduling.passes.has(f.mission.id), false, 'the setup kicks have settled')
    f.workers.autoIdle = true
    const task = f.propose()
    assert.equal(scheduling.passes.has(f.mission.id), true, 'the proposal kicked a body')
    await f.runtime.settle(f.mission.id)
    assert.equal(scheduling.passes.has(f.mission.id), false, 'settle returns once that body has settled')
    assert.equal(taskOf(f.runtime, task.id).status, 'running', 'and the body dispatched the task')
    let checks = 0
    const check = scheduling.checkSchedulingPasses.bind(scheduling)
    scheduling.checkSchedulingPasses = (...args) => { checks += 1; return check(...args) }
    await f.runtime.tick()
    assert.equal(checks, 1, 'one tick runs the watchdog once')
    assert.equal(scheduling.passes.has(f.mission.id), false, 'and returns once the body it kicked has settled')
    // The unreviewed-submission grace is 30 tick units (at most 1 s) of clock
    // time from the durable submission, so a submission is not a stall inside it.
    const claimed = taskOf(f.runtime, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const unreviewed = () => f.runtime.scheduling.unreviewedStall(f.mission.id, [taskOf(f.runtime, task.id)])
    assert.equal(unreviewed(), false, 'a submission is not a stall at its own instant')
    clock.advance(30 * tickMs - 1)
    assert.equal(unreviewed(), false, 'nor one clock millisecond inside the grace')
    clock.advance(1)
    assert.equal(unreviewed(), true, 'it is one once the grace has elapsed on the clock')
  } finally { await f.cleanup() }
})

test('settle() is not quiescence: a kick coalesced into an open body is run by the next tick, as the timer would run it', async () => {
  // The body sweeps the author, then the reviewer, whose start the test holds.
  // T2 for the author is proposed while that body is open and past the author,
  // so its kick is coalesced into the body and dropped.
  class HeldReviewerWorkers extends FakeWorkers {
    hold
    async start(spec) {
      this.started.push(spec.member.id)
      const hold = this.hold
      if (hold === undefined || spec.member.id !== hold.memberId || hold.entered.done) return
      hold.entered.done = true
      hold.entered.resolve()
      await hold.release.promise
    }
  }
  const workers = new HeldReviewerWorkers()
  const f = await setup({ workers, clock: new FakeClock() })
  try {
    await f.runtime.settle(f.mission.id)
    workers.autoIdle = true
    workers.hold = { memberId: f.reviewer.id, entered: Promise.withResolvers(), release: Promise.withResolvers() }
    const t1 = f.propose({ title: 'T1 for the reviewer', assigneeId: f.reviewer.id })
    await workers.hold.entered.promise
    const t2 = f.propose({ title: 'T2 for the author' })
    workers.hold.release.resolve()
    await f.runtime.settle(f.mission.id)
    assert.deepEqual([t1, t2].map(task => taskOf(f.runtime, task.id).status), ['running', 'pending'], 'settle() returns with the coalesced kick undone')
    await f.runtime.tick()
    assert.equal(taskOf(f.runtime, t2.id).status, 'running', 'the next tick runs it')
  } finally { await f.cleanup() }
})
