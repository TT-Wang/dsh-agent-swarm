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
import { setup, eventually, events, taskOf, FakeWorkers, FakeClock, SwarmRuntime, budget, MISSION_ACCEPTANCE } from './faults/harness.mjs'
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

test('S1: every body that wedges is named once, also when an earlier named body left the board unchanged', async () => {
  // Before, the durable wedge key (the board fingerprint) outlived the named
  // body: closePass cleared it only when the board changed during that body.
  // H's every start hangs to its bound, and the second hung body changes
  // nothing, so the third body wedged on the board the key still named: every
  // tick's naming was refused by the key and that wedge got no event, no owner
  // notice and no wedged mark. A named body that settles now clears the key.
  class HangEveryStartWorkers extends FakeWorkers {
    names = new Map()
    hangs = []
    async start(spec, signal) {
      this.started.push(spec.member.id)
      if (this.names.get(spec.member.id) !== 'H') return
      const hang = { from: Date.now() }
      this.hangs.push(hang)
      try { await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })) }
      finally { hang.to = Date.now() }
    }
  }
  const workers = new HangEveryStartWorkers()
  workers.autoIdle = true
  const f = await setup({ workers, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000, workerStartTimeoutMs: 400 } })
  try {
    const scheduling = f.runtime.scheduling
    const closed = []
    const closePass = scheduling.closePass.bind(scheduling)
    scheduling.closePass = (missionId, pass) => {
      closed.push({ runId: pass.operationId, heldMs: Date.now() - pass.startedAt, named: pass.escalatedAt !== undefined, unchanged: f.runtime.fingerprint(missionId) === pass.fingerprintBefore })
      return closePass(missionId, pass)
    }
    const h = await f.runtime.addMember(f.owner, f.mission.id, { name: 'H', role: 'implementation', maxOutputTokens: 5_000 })
    workers.names.set(h.id, 'H')
    f.propose({ title: 'Work for H', assigneeId: h.id })
    await eventually(() => workers.hangs.length >= 3 && workers.hangs.every(hang => hang.to !== undefined) && scheduling.passes.get(f.mission.id) === undefined ? true : undefined,
      'H\'s three hung starts settle and the start-failure limit retires it', 6_000)
    const wedged = closed.filter(body => body.heldMs >= 300)
    assert.equal(wedged.length, 3, `each of H's three hung starts held one body past its bound (${JSON.stringify(closed.filter(body => body.heldMs >= 100))})`)
    assert.ok(wedged.slice(0, -1).some(body => body.unchanged), 'an earlier wedged body left the board it named unchanged')
    const runIds = wedgeEvents(f).map(item => item.data.runId)
    assert.deepEqual(wedged.map(body => body.named), [true, true, true], 'every wedged body was named')
    assert.deepEqual(runIds, wedged.map(body => body.runId), 'once each, in order, by one wedge event per body')
  } finally { await f.cleanup() }
})

test('S1: under a recorded provider outage, the renaming of bodies that wedge on an unchanged board stops at the first naming the notice dedup suppressed', async () => {
  // Before, a named body that settled always cleared the wedge key. A start
  // under a recorded outage is never counted, so start-failure retirement never
  // capped the renaming: every body that wedged in H's hung start was named
  // again, about three per second, and each mission/stalled event claimed
  // ownerNotified: true although the notice dedup had suppressed the row. The
  // key is now cleared only when the naming reached the owner, and the event
  // states what notify did.
  class HangEveryStartWorkers extends FakeWorkers {
    names = new Map()
    hangH = false
    hangs = 0
    async start(spec, signal) {
      this.started.push(spec.member.id)
      if (this.names.get(spec.member.id) !== 'H' || !this.hangH) return
      this.hangs += 1
      await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
  }
  const workers = new HangEveryStartWorkers()
  workers.autoIdle = true
  const f = await setup({ workers, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPasses: 1_000, workerStartTimeoutMs: 300 } })
  try {
    const h = await f.runtime.addMember(f.owner, f.mission.id, { name: 'H', role: 'implementation', maxOutputTokens: 5_000 })
    workers.names.set(h.id, 'H')
    const task = f.propose({ title: 'Work for H', assigneeId: h.id })
    await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? true : undefined, 'the task dispatches to H', 4_000)
    const armedAt = Date.now()
    f.runtime.onProviderOutage(h.id, { class: 'unavailable', message: 'provider unavailable' })
    workers.hangH = true
    await eventually(() => workers.hangs >= 7 ? true : undefined, 'H\'s starts keep hanging under the outage', 6_000)
    const namings = wedgeEvents(f).filter(item => item.createdAt >= armedAt)
    assert.ok(workers.hangs >= namings.length + 3, `bodies kept wedging (${workers.hangs} hung starts) after the last naming`)
    assert.equal(f.runtime.store.get('members', h.id).phase, 'active', 'the outage keeps H live: start-failure retirement never caps the renaming')
    assert.ok(namings.length >= 2, `the bodies are named until the notice dedup suppresses one (${namings.length})`)
    assert.deepEqual(namings.map(item => item.data.ownerNotified), [...namings.slice(0, -1).map(() => true), false],
      'every naming reached the owner except the last, a repeat the notice dedup suppressed; nothing is named after it')
    const rows = f.runtime.store.list('deliveries', f.mission.id).filter(item => item.to === 'owner' && item.notice?.trigger === 'scheduling-pass' && item.createdAt >= armedAt)
    assert.equal(rows.length, namings.length - 1, 'each naming that claims ownerNotified has its owner row')
  } finally { await f.cleanup() }
})

test('S1: a naming whose commit fails once is retried by a later tick, and the wedge is named exactly once', async () => {
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
  const workers = new HeldStartWorkers()
  const dir = await realpath(await tempDirectory('swarm-pass-busy-'))
  const statePath = join(dir, 'swarm.sqlite')
  const runtime = new SwarmRuntime({ statePath, leaseMs: 60_000, tickMs: 10, manualTick: true, now: clock.now, maxMessageChars: 16_000, maxEvents: 5_000, maxTasksPerMember: 3, checkTimeoutMs: 30_000,
    stallPassTimeoutMs: bound, stallPasses: 1_000 }, workers, { busyTimeoutMs: 5, writerAttempts: 1, writerDelayMs: 0 })
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

test('S1/R17-G5: a start that fails past the bound stamps the body before it commits the failure, so no dispatch question is asked about the next member\'s ready task', async () => {
  // Before, the body stamped its progress only once startWorker's promise had
  // settled, but startWorker commits the start failure (onStartFailure) before
  // that. The failure's publication read a stamp from before the hung start,
  // took the wedged branch and asked "has an eligible idle member but was not
  // dispatched this tick" about task T, which the next body dispatched a few
  // milliseconds later. Live work keeps the body live inside its release
  // bound, so the watchdog never names it.
  const startBoundMs = 400
  class HangOnceWorkers extends FakeWorkers {
    names = new Map()
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
  }
  const workers = new HangOnceWorkers()
  const f = await setup({ workers, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPassLiveGraceMs: 20_000, stallPasses: 1_000, workerStartTimeoutMs: startBoundMs, attemptSilenceBoundMs: 0 } })
  try {
    const h = await f.runtime.addMember(f.owner, f.mission.id, { name: 'H', role: 'implementation', maxOutputTokens: 5_000 })
    const b = await f.runtime.addMember(f.owner, f.mission.id, { name: 'B', role: 'implementation', maxOutputTokens: 5_000 })
    workers.names.set(h.id, 'H')
    workers.idle.add(f.author.id)
    const live = f.propose({ title: 'Live work' })
    await eventually(() => taskOf(f.runtime, live.id).status === 'running' ? true : undefined, 'the live work dispatches', 4_000)
    workers.idle.delete(f.author.id)
    workers.idle.add(h.id); workers.idle.add(b.id)
    await sleep(60)
    // One synchronous step: the next body waits in H's start, and T is ready for B, swept after H.
    workers.hangH = true
    const t = f.propose({ title: 'T for B', assigneeId: b.id })
    await eventually(() => taskOf(f.runtime, t.id).status === 'running' ? true : undefined, 'T dispatches', 4_000)
    await sleep(100)
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
  class SlowRecoveryWorkers extends FakeWorkers {
    slowFor
    async prepareTask(member, task) {
      if (member.id === this.slowFor) {
        this.slowFor = undefined
        await sleep(150)
        this.callbacks.recoveryFallback({ missionId: member.missionId, taskId: task.id, epoch: task.epoch, memberId: member.id, previousOwnerId: 'member_previous', commit: 'c'.repeat(40), preserved: true, reason: 'capture refused' })
      }
      return super.prepareTask(member, task)
    }
  }
  const workers = new SlowRecoveryWorkers()
  const f = await setup({ workers, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPassLiveGraceMs: 20_000, stallPasses: 1_000, attemptSilenceBoundMs: 0 } })
  try {
    const b = await f.runtime.addMember(f.owner, f.mission.id, { name: 'B', role: 'implementation', maxOutputTokens: 5_000 })
    workers.idle.add(f.author.id)
    const live = f.propose({ title: 'Live work' })
    await eventually(() => taskOf(f.runtime, live.id).status === 'running' ? true : undefined, 'the live work dispatches', 4_000)
    workers.idle.delete(f.author.id)
    workers.idle.add(b.id)
    await sleep(60)
    workers.slowFor = b.id
    const t = f.propose({ title: 'T for B', assigneeId: b.id })
    await eventually(() => taskOf(f.runtime, t.id).status === 'running' ? true : undefined, 'T dispatches', 4_000)
    await sleep(50)
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
  class SlowOwnerWorkers extends FakeWorkers {
    slowOwnerMs = 0
    async deliver(member, delivery) {
      if (member.id === 'owner' && this.slowOwnerMs > 0) await sleep(this.slowOwnerMs)
      return super.deliver(member, delivery)
    }
  }
  const workers = new SlowOwnerWorkers()
  const f = await setup({ workers, budget: { maxWorkers: 8 }, config: { tickMs: 10, stallPassTimeoutMs: 100, stallPassLiveGraceMs: 20_000, stallPasses: 1_000, attemptSilenceBoundMs: 0 } })
  try {
    // Only the body delivers: the queue-external pump is off.
    f.runtime.notices.pumpOutbox = () => {}
    const b = await f.runtime.addMember(f.owner, f.mission.id, { name: 'B', role: 'implementation', maxOutputTokens: 5_000 })
    workers.idle.add(f.author.id)
    const live = f.propose({ title: 'Live work' })
    const t = f.propose({ title: 'T for busy B', assigneeId: b.id })
    await eventually(() => taskOf(f.runtime, live.id).status === 'running' ? true : undefined, 'the live work dispatches', 4_000)
    workers.idle.delete(f.author.id)
    await sleep(300)
    workers.slowOwnerMs = 60
    const startedAt = Date.now()
    for (const n of [1, 2, 3]) f.runtime.commit(f.mission.id, () => f.runtime.notify(f.mission.id, `Owner fact ${n}`, [`mission:${f.mission.id}`], { from: 'runtime', dedupKey: `flush-fact-${n}` }))
    f.runtime.kick(f.mission.id)
    const last = await eventually(() => f.runtime.store.list('deliveries', f.mission.id).find(item => item.content === 'Owner fact 3' && item.deliveredAt !== undefined), 'the body delivers the three facts', 4_000)
    assert.ok(last.deliveredAt - startedAt >= 100, `the flush carried the body past its bound (${last.deliveredAt - startedAt}ms)`)
    await sleep(50)
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
  // One stop is tolerated for a pause of the whole process under suite load;
  // the round-4 rule stops most bodies here.
  class ComputingStartWorkers extends FakeWorkers {
    async start(spec) {
      this.started.push(spec.member.id)
      const end = Date.now() + 4
      while (Date.now() < end) { /* the adapter's synchronous work */ }
    }
    isIdle() { return false }
  }
  const workers = new ComputingStartWorkers()
  const f = await setup({ workers, budget: { maxWorkers: 24 }, config: { tickMs: 10, stallPassTimeoutMs: 60, stallPasses: 1_000 } })
  try {
    for (let n = 0; n < 16; n += 1) await f.runtime.addMember(f.owner, f.mission.id, { name: `Busy ${n}`, role: 'implementation', maxOutputTokens: 5_000 })
    const members = f.runtime.store.list('members', f.mission.id).map(member => member.id)
    await sleep(200)
    const watched = watchBodies(f)
    const firstStart = workers.started.length
    await sleep(1_500)
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
    assert.ok(bodies.some(body => body.stopped), 'bodies did stop early past their bound')
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
