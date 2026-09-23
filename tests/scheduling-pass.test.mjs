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
import { realpath, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { setup, eventually, events, taskOf, FakeWorkers, SwarmRuntime, budget, MISSION_ACCEPTANCE } from './faults/harness.mjs'
import { tempDirectory } from './temp-root.mjs'

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

test('S1: a naming whose commit fails once is retried by a later tick, and the wedge is named exactly once', async () => {
  // Before, the watchdog marked the body named before its durable write, so a
  // naming that failed on its one tick (here a real SQLite writer lock held by a
  // second connection for exactly that tick) left the wedge unnamed for the rest
  // of the body's life: passState {passLive: false, wedged: true}, no event, no
  // owner notice. The naming now counts only once it has committed.
  const workers = new WedgeStartWorkers()
  const dir = await realpath(await tempDirectory('swarm-pass-busy-'))
  const statePath = join(dir, 'swarm.sqlite')
  const runtime = new SwarmRuntime({ statePath, leaseMs: 60_000, tickMs: 10, maxMessageChars: 16_000, maxEvents: 5_000, maxTasksPerMember: 3, checkTimeoutMs: 30_000,
    stallPassTimeoutMs: 100, stallPasses: 1_000, workerStartTimeoutMs: 1_500 }, workers, { busyTimeoutMs: 5, writerAttempts: 1, writerDelayMs: 0 })
  const tickFailures = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => { if (/tick failed/.test(String(chunk))) { tickFailures.push(String(chunk)); return true } return write(chunk, ...rest) }
  try {
    await runtime.start()
    const owner = { sessionId: 'pass-owner' }
    const mission = runtime.create(owner, { title: 'Busy naming', objective: 'Name a wedge whose first naming commit fails', workspace: dir, scope: ['**'], acceptance: MISSION_ACCEPTANCE, budget })
    const stream = runtime.workstream(owner, mission.id, { title: 'S', objective: 'S' })
    const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation', maxOutputTokens: 5_000 })
    const wedges = () => events(runtime, mission.id, 'mission/stalled').filter(item => item.data.cause === 'scheduling-pass' && item.data.wedged === true)
    const scheduling = runtime.scheduling
    const check = scheduling.checkSchedulingPasses.bind(scheduling)
    let locked
    // The lock is keyed on the watchdog's own predicate at the tick's own
    // instant, so the tick that first finds the body past its bound is exactly
    // the one that runs under the lock.
    scheduling.checkSchedulingPasses = (now = Date.now()) => {
      const pass = scheduling.passes.get(mission.id)
      if (locked !== undefined || pass === undefined || !scheduling.pastBound(pass, now)) return check(now)
      const other = new DatabaseSync(statePath)
      other.exec('BEGIN IMMEDIATE')
      try { return check(now) } finally {
        other.exec('ROLLBACK'); other.close()
        locked = { events: wedges().length, escalatedAt: scheduling.passes.get(mission.id)?.escalatedAt }
      }
    }
    workers.wedgeNext = true
    const task = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement the scoped change',
      kind: 'implementation', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: ['test -d .'], assigneeId: author.id })
    await eventually(() => locked, 'the first naming tick must run under the writer lock', 4_000)
    assert.deepEqual(locked, { events: 0, escalatedAt: undefined }, 'the locked naming committed nothing and did not count as a naming')
    assert.ok(tickFailures.some(line => /WriterBusyError/.test(line)), `the naming commit failed on the busy writer: ${tickFailures.join(' | ')}`)
    const event = await eventually(() => wedges()[0], 'a later tick must name the wedge once the writer is free', 4_000)
    assert.equal(workers.wedgeSettledAt, undefined, 'the retry named the body while it was still wedged')
    assert.ok(runtime.store.list('deliveries', mission.id).some(item => item.to === 'owner' && item.content.includes(`run ${event.data.runId}`)), 'the owner notice committed with the event')
    workers.autoIdle = true
    await eventually(() => taskOf(runtime, task.id).status === 'running' ? true : undefined, 'the task dispatches once the wedged start settles', 4_000)
    await sleep(100)
    assert.equal(wedges().length, 1, 'the wedge is named exactly once')
  } finally {
    process.stderr.write = write
    await runtime.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})

test('S1: a wedge that passes its bound while the owner has the mission paused is named after the resume, exactly once', async () => {
  // Pause and resume do not go through the mission queue, so the body keeps
  // waiting inside its bounded await across them. Before, the watchdog marked
  // the body named while the mission was paused (the naming itself returned
  // early for a mission that is not active), and after the resume the wedge was
  // never named: the owner heard nothing until the await's own bound.
  const prepareMs = 1_500
  class SlowPrepareWorkers extends FakeWorkers {
    armed = true
    enteredAt
    settledAt
    async prepareTask(member, task) {
      if (this.armed) { this.armed = false; this.enteredAt = Date.now(); await sleep(prepareMs); this.settledAt = Date.now() }
      await super.prepareTask(member, task)
    }
  }
  const workers = new SlowPrepareWorkers()
  workers.autoIdle = true
  const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000, workerStartTimeoutMs: 5_000 } })
  try {
    const task = f.propose()
    await eventually(() => workers.enteredAt !== undefined ? true : undefined, 'the pass body must enter its long preparation', 4_000)
    f.runtime.control(f.owner, f.mission.id, 'pause', 'owner pause while the body is inside prepareTask')
    await sleep(250)
    assert.equal(f.runtime.scheduling.passWedged(f.mission.id), true, 'the body is past its bound while the mission is paused')
    assert.equal(wedgeEvents(f).length, 0, 'a paused mission is not named')
    const resumedAt = Date.now()
    f.runtime.control(f.owner, f.mission.id, 'resume', 'owner resumes')
    const event = await eventually(() => wedgeEvents(f)[0], 'the still-wedged body must be named after the resume', 1_000)
    assert.ok(event.createdAt >= resumedAt, 'named after the resume')
    assert.equal(workers.settledAt, undefined, 'and while the body was still inside its bounded await')
    await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? true : undefined, 'the body dispatches once its await settles', 4_000)
    await sleep(100)
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
  class SlowPrepareWorkers extends FakeWorkers {
    names = new Map()
    authorFirst = true
    async prepareTask(member, task) {
      const name = this.names.get(member.id)
      if (name === 'Author' && this.authorFirst) { this.authorFirst = false; await sleep(150) }
      else if (name === 'Builder') await sleep(30)
      await super.prepareTask(member, task)
    }
  }
  const workers = new SlowPrepareWorkers()
  workers.autoIdle = true
  const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000, workerStartTimeoutMs: 5_000 } })
  try {
    const builder = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5_000 })
    for (const member of [f.author, f.reviewer, builder]) workers.names.set(member.id, member.name)
    const a = f.propose({ title: 'Task A', assigneeId: f.author.id })
    const b = f.propose({ title: 'Task B', assigneeId: builder.id })
    await eventually(() => taskOf(f.runtime, a.id).status === 'running' && taskOf(f.runtime, b.id).status === 'running' ? true : undefined, 'both tasks dispatch', 4_000)
    await sleep(150)
    const wedge = wedgeEvents(f)[0]
    assert.ok(wedge !== undefined, 'the body was named while it waited in the long preparation')
    const claimedB = events(f.runtime, f.mission.id, 'task/claimed').find(item => item.data.taskId === b.id)
    assert.ok(claimedB.createdAt > wedge.createdAt, 'task B was dispatched after the naming')
    const questions = f.runtime.store.list('deliveries', f.mission.id).filter(item => item.to === 'owner' && item.notice?.dedupKey?.startsWith('dispatch-question:'))
    assert.deepEqual(questions.filter(item => item.notice.dedupKey.includes(b.id)).map(item => item.content), [],
      'no dispatch question is asked about task B, which the sweep dispatched without any blocker')
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
  const startBoundMs = 1_500
  class StrandedInboxWorkers extends FakeWorkers {
    names = new Map()
    busy = new Set()
    stranded = new Set()
    beats = []
    heartbeats = 0
    hangH = false
    hang
    async start(spec, signal) {
      this.started.push(spec.member.id)
      if (this.names.get(spec.member.id) !== 'H' || !this.hangH) return
      this.hangH = false
      this.hang = { from: Date.now() }
      try { await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) }
      finally { this.hang.to = Date.now() }
    }
    isIdle(id) {
      if (this.stranded.delete(id)) { this.wake(id); return true }
      return !this.busy.has(id)
    }
    /** The woken turn: its running tool republishes the member's activity every 40ms. */
    wake(id) {
      const startedAt = Date.now()
      this.busy.add(id)
      this.beats.push(setInterval(() => {
        this.heartbeats += 1
        this.callbacks.activity(id, { id: 'op-tool', kind: 'tool', tool: 'bash', startedAt, updatedAt: Date.now() })
      }, 40))
    }
  }
  const workers = new StrandedInboxWorkers()
  const f = await setup({ workers, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000, workerStartTimeoutMs: startBoundMs } })
  try {
    const h = await f.runtime.addMember(f.owner, f.mission.id, { name: 'H', role: 'implementation', maxOutputTokens: 5_000 })
    const i = await f.runtime.addMember(f.owner, f.mission.id, { name: 'I', role: 'implementation', maxOutputTokens: 5_000 })
    workers.names.set(h.id, 'H')
    const running = f.propose({ title: 'Author work' })
    await eventually(() => taskOf(f.runtime, running.id).status === 'running' ? true : undefined, 'the Author task dispatches', 4_000)
    await sleep(50)
    // Armed in one synchronous step: the next body's startBlocker(Author) drains
    // the stranded item and wakes the turn, then the body waits in H's start.
    workers.stranded.add(f.author.id)
    workers.hangH = true
    await eventually(() => workers.hang !== undefined ? true : undefined, 'the body waits in H\'s hung start', 4_000)
    const named = await eventually(() => wedgeEvents(f)[0], 'the body is named while it waits in H\'s start', 4_000)
    assert.equal(workers.hang.to, undefined, 'named while H\'s start still hangs')
    assert.equal(workers.beats.length, 1, 'the stranded drain woke one turn from inside the body')
    const beatsAtNaming = workers.heartbeats
    await sleep(100)
    assert.ok(workers.heartbeats > beatsAtNaming, 'the woken turn keeps committing its heartbeats during the wedge')
    assert.deepEqual(f.runtime.passState(f.mission.id), { passLive: false, wedged: true }, 'yet the body publishes as wedged, not as a live pass')
    const z = f.propose({ title: 'Z work for idle I', assigneeId: i.id })
    const question = await eventually(() => f.runtime.store.list('deliveries', f.mission.id)
      .find(item => item.to === 'owner' && item.notice?.dedupKey?.startsWith(`dispatch-question:${f.mission.id}:${z.id}@`)), 'the owner is asked about Z during the wedge', 1_000)
    assert.equal(workers.hang.to, undefined, 'the question was asked while the body still waited in H\'s start')
    assert.ok(question.createdAt > named.createdAt, 'after the naming')
  } finally {
    for (const beat of workers.beats) clearInterval(beat)
    await f.cleanup()
  }
})

test('S1: a body past its bound stops at the next member boundary, so lease recovery waits for one long await, not for every member\'s', async () => {
  // Three members whose first native start hangs until the declared start
  // bound aborts it, and a healthy member X whose running task's lease expires
  // meanwhile. Before, the named body swept every member and then flushed, so
  // lease-expiry recovery (the first step of every body) waited for all three
  // hung starts: about (N-1) start bounds after the lease expired. A body past
  // its bound now stops at the next member boundary; the next body starts from
  // lease recovery and sweeps from the member the previous one stopped before.
  const startBoundMs = 400
  const leaseMs = 450
  class HangFirstStartWorkers extends FakeWorkers {
    armed = new Set()
    hung = new Map()
    async start(spec, signal) {
      this.started.push(spec.member.id)
      if (!this.armed.has(spec.member.id) || this.hung.has(spec.member.id)) return
      const hang = { from: Date.now(), index: this.started.length - 1 }
      this.hung.set(spec.member.id, hang)
      try { await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) }
      finally { hang.to = Date.now() }
    }
  }
  const workers = new HangFirstStartWorkers()
  workers.autoIdle = true
  const f = await setup({ workers, budget: { maxWorkers: 8 }, config: { tickMs: 10, leaseMs, stallPassTimeoutMs: 100, stallPasses: 1_000, workerStartTimeoutMs: startBoundMs } })
  try {
    const hanging = []
    for (const name of ['A', 'B', 'C']) hanging.push(await f.runtime.addMember(f.owner, f.mission.id, { name, role: 'implementation', maxOutputTokens: 5_000 }))
    const task = f.propose({ title: 'Task X' })
    const running = await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? taskOf(f.runtime, task.id) : undefined, 'X is dispatched', 4_000)
    for (const member of hanging) workers.armed.add(member.id)
    const expired = await eventually(() => events(f.runtime, f.mission.id, 'task/lease-expired').find(item => item.data.taskId === task.id), 'the lease expiry is recovered', 10_000)
    const latency = expired.createdAt - running.attempt.leaseUntil
    assert.ok(latency <= startBoundMs + 150, `lease recovery ran ${latency}ms after the lease expired, within one start bound (${startBoundMs}ms) and a tick`)
    const settled = await eventually(() => hanging.every(member => workers.hung.get(member.id)?.to !== undefined) ? true : undefined, 'every member reaches its hung start', 6_000)
    assert.equal(settled, true)
    const [a, b, c] = hanging
    assert.equal(workers.started[workers.hung.get(a.id).index + 1], b.id, 'the body after A\'s hung start sweeps first from B, the member the stopped body did not reach')
    assert.equal(workers.started[workers.hung.get(b.id).index + 1], c.id, 'and the one after B\'s from C')
    await eventually(() => hanging.every(member => workers.started.lastIndexOf(member.id) > workers.hung.get(member.id).index) ? true : undefined,
      'every member is started again after its hung start settles', 4_000)
  } finally { await f.cleanup() }
})

/** Record every scheduling body as it closes, and count the pass-end outbox flushes. */
function watchBodies(f) {
  const scheduling = f.runtime.scheduling
  const bodies = []
  let flushes = 0
  const closePass = scheduling.closePass.bind(scheduling)
  scheduling.closePass = (missionId, pass) => { bodies.push({ stopped: pass.stoppedBefore !== undefined, sweepFrom: pass.sweepFrom }); return closePass(missionId, pass) }
  const flushOutbox = f.runtime.flushOutbox.bind(f.runtime)
  f.runtime.flushOutbox = missionId => { flushes += 1; return flushOutbox(missionId) }
  return { bodies, flushes: () => flushes }
}

test('S1: a body past its bound only by computing is not stopped early, so every body still runs the pass-end steps', async () => {
  // Before, the early stop applied to any body past its bound at a member
  // boundary. When the members' synchronous work alone outlasted the bound
  // (here eight members whose adapter start computes for 3ms, against a 10ms
  // bound) every body stopped early and queued the next at once: no body ever
  // reached ensureWitness or flushOutbox, and bodies ran back to back without
  // the tick. Only a body that waited past its bound in one of its own awaits
  // stops early now; another body cannot shorten computation.
  class ComputingStartWorkers extends FakeWorkers {
    async start(spec) {
      this.started.push(spec.member.id)
      const end = Date.now() + 3
      while (Date.now() < end) { /* the adapter's synchronous work */ }
    }
    isIdle() { return false }
  }
  const f = await setup({ workers: new ComputingStartWorkers(), budget: { maxWorkers: 10 }, config: { tickMs: 10, stallPassTimeoutMs: 10, stallPasses: 1_000 } })
  try {
    for (let n = 0; n < 6; n += 1) await f.runtime.addMember(f.owner, f.mission.id, { name: `Busy ${n}`, role: 'implementation', maxOutputTokens: 5_000 })
    await sleep(100)
    const watched = watchBodies(f)
    await sleep(500)
    const bodies = [...watched.bodies]
    assert.ok(bodies.length >= 3, `bodies kept running (${bodies.length})`)
    assert.deepEqual(bodies.filter(body => body.stopped), [], 'no body past its bound on computation alone stopped early')
    assert.ok(watched.flushes() >= bodies.length - 1, `every body ran the pass-end steps (${watched.flushes()} flushes for ${bodies.length} bodies)`)
  } finally { await f.cleanup() }
})

test('S1: a chain of early-stopped bodies covers one rotation, and the body that completes it runs the pass-end steps and leaves the next body to the tick', async () => {
  // Before, a body that stopped early queued the next at once however far the
  // chain had come. When no body could sweep the whole rotation within its
  // bound (here every member's start waits 40ms against a 30ms bound) the
  // chain never ended: no body ran ensureWitness or flushOutbox, and bodies
  // ran back to back without the tick. A chained body now ends its sweep
  // before the member its chain started from.
  class SlowStartWorkers extends FakeWorkers {
    slow = false
    async start(spec) {
      this.started.push(spec.member.id)
      if (this.slow) await sleep(40)
    }
  }
  const workers = new SlowStartWorkers()
  const f = await setup({ workers, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 30, stallPasses: 1_000 } })
  try {
    for (const name of ['C', 'D']) await f.runtime.addMember(f.owner, f.mission.id, { name, role: 'implementation', maxOutputTokens: 5_000 })
    const members = f.runtime.store.list('members', f.mission.id).length
    await sleep(100)
    workers.slow = true
    await eventually(() => f.runtime.scheduling.passes.get(f.mission.id) === undefined ? true : undefined, 'the body that saw the fast starts settles')
    const watched = watchBodies(f)
    await sleep(1_000)
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
    assert.ok(bodies.some(body => body.stopped), 'bodies did stop early after waiting past their bound')
  } finally { await f.cleanup() }
})

test('S1: the watchdog, passWedged and livePass read one bound predicate, so they agree at exactly the bound', async () => {
  // Before, the watchdog named a body once its age reached the bound while
  // passWedged reported it wedged only past the bound. At age == bound a body
  // was named while passWedged still read false, so the writer-lock wrappers
  // keyed on passWedged (the naming-retry test above and F21 I5) let that
  // naming tick run unlocked and commit. The clock is frozen for each instant.
  const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000 } })
  const scheduling = f.runtime.scheduling
  const realNow = Date.now
  let pass
  try {
    await eventually(() => scheduling.passes.get(f.mission.id) === undefined ? true : undefined, 'the setup passes settle')
    const fixed = realNow()
    pass = { id: scheduling.passKey(f.mission.id), operationId: 'operation_test_boundary', missionId: f.mission.id, startedAt: fixed - 99,
      revisionBefore: f.runtime.store.revision(), fingerprintBefore: f.runtime.fingerprint(f.mission.id), noProgressPasses: 0 }
    scheduling.passes.set(f.mission.id, pass)
    Date.now = () => fixed
    const before = { wedged: scheduling.passWedged(f.mission.id), live: scheduling.livePass(f.mission.id) === pass }
    scheduling.checkSchedulingPasses()
    assert.deepEqual({ ...before, named: pass.escalatedAt !== undefined }, { wedged: false, live: true, named: false }, 'one tick inside the bound: live, not wedged, not named')
    pass.startedAt = fixed - 100
    const at = { wedged: scheduling.passWedged(f.mission.id), live: scheduling.livePass(f.mission.id) === pass }
    scheduling.checkSchedulingPasses()
    Date.now = realNow
    assert.deepEqual({ ...at, named: pass.escalatedAt !== undefined }, { wedged: true, live: false, named: true },
      'at exactly the bound the body is wedged, no longer live, and the watchdog names it')
    assert.equal(wedgeEvents(f).filter(item => item.data.runId === pass.operationId).length, 1, 'named once')
  } finally {
    Date.now = realNow
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
