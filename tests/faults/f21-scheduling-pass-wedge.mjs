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
 * The pass guard is in memory again (`Scheduling.passes`, the one body queued or
 * running on the mission's serial queue) and nothing releases it early: the
 * queue keeps a wedged body until it settles. The Row-13 guarantee that a pass
 * which "never returns" cannot hide the mission therefore rests on two things:
 * every await in the body carries its own bound (`workerStartTimeoutMs`, the
 * per-attempt delivery bound, each git subprocess's `HOST_GIT_TIMEOUT_MS`), so
 * the body does return; and the queue-external tick names the body past its
 * bound while it still waits, so the owner hears of it before it returns.
 *
 * Injection: the adapter's `start` never resolves on its own for the first call
 * after the injection is armed; like the real adapter (`HarnessWorkers.start`
 * cancels its opening when the runtime aborts it) it settles only when the
 * runtime's declared start bound (`workerStartTimeoutMs`) aborts it. The bound
 * is set well past the pass bound, so the pass body is wedged for the whole
 * window the watchdog must cover. Assertions are read from durable state only:
 *  I1 the durable `mission/stalled` event (`cause: 'scheduling-pass'`,
 *     `wedged: true`) is committed within the declared bound
 *     (`stallPassTimeoutMs`) and names the pass, the bound, the unchanged state
 *     digest and what was unschedulable;
 *  I2 the owner notice is recorded AND delivered while the pass is still
 *     wedged — the notice path must not share the fate of the pass it reports on;
 *  I3 the work the wedge blocked is dispatched by a later tick once the wedged
 *     await reaches its own bound (the mission queue owns that physical
 *     operation until it settles), without re-arming the stall;
 *  I4 fingerprint dedup keeps one escalation per unchanged board.
 * Two variants cover a naming that cannot land on its first tick:
 *  I5 the naming tick's commit fails once (a real SQLite writer lock held by a
 *     second connection for exactly that tick): a later tick names the wedge
 *     while the body is still wedged, exactly once;
 *  I6 the owner pauses the mission while the body waits and resumes it after
 *     the bound (neither goes through the mission queue): the still-wedged body
 *     is named after the resume, exactly once.
 *
 * The earlier fixture let the hung `start` ignore its abort and expected a pass
 * opened after the watchdog release to dispatch while that call still hung. That
 * premise was removed on purpose by two later changes: the watchdog no longer
 * deletes the mission queue tail and a queue waiter is refused rather than run
 * past its bound (a named pass may still own a checkout), and a member whose
 * native start never settles stays fenced from a second start. The scenario now
 * injects the wedge the runtime actually bounds.
 */
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { FakeWorkers, MISSION_ACCEPTANCE, budget, setup, makeRuntime, eventually, events, runScenario, taskOf } from './harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const wedgeEvents = (runtime, missionId) => events(runtime, missionId, 'mission/stalled').filter(item => item.data.cause === 'scheduling-pass' && item.data.wedged === true)

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

/** The external boundary only: the first task preparation waits `ms`, recording when it settled. */
class SlowPrepareWorkers extends FakeWorkers {
  armed = true
  enteredAt
  settledAt
  constructor(ms) { super(); this.ms = ms }
  async prepareTask(member, task) {
    if (this.armed) { this.armed = false; this.enteredAt = Date.now(); await sleep(this.ms); this.settledAt = Date.now() }
    await super.prepareTask(member, task)
  }
}

/** I5: the first naming tick runs while a second connection holds the SQLite writer lock. */
async function namingCommitFailsOnce() {
  const workers = new WedgeStartWorkers()
  // fixture gap: makeRuntime takes a node:test context and a scenario has none, so its cleanup is collected here and run in finally.
  let cleanup
  const { dir, config: { statePath }, runtime } = await makeRuntime({ after: fn => { cleanup = fn } }, { workers,
    config: { stallPassTimeoutMs: 60, stallPasses: 30, workerStartTimeoutMs: 1_500 }, storeOptions: { busyTimeoutMs: 5, writerAttempts: 1, writerDelayMs: 0 } })
  const tickFailures = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => { if (/tick failed/.test(String(chunk))) { tickFailures.push(String(chunk)); return true } return write(chunk, ...rest) }
  try {
    await runtime.start()
    const owner = { sessionId: 'fault-owner' }
    const mission = runtime.create(owner, { title: 'Fault injection', objective: 'A wedge naming whose first commit fails', workspace: dir, scope: ['**'], acceptance: MISSION_ACCEPTANCE, budget })
    const stream = runtime.workstream(owner, mission.id, { title: 'Faults', objective: 'Exercise the fault path' })
    const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation', maxOutputTokens: 5_000 })
    const scheduling = runtime.scheduling
    const check = scheduling.checkSchedulingPasses.bind(scheduling)
    let locked
    // Keyed on the watchdog's own predicate at the tick's own instant.
    scheduling.checkSchedulingPasses = (now = Date.now()) => {
      const pass = scheduling.passes.get(mission.id)
      if (locked !== undefined || pass === undefined || !scheduling.pastBound(pass, now)) return check(now)
      const other = new DatabaseSync(statePath)
      other.exec('BEGIN IMMEDIATE')
      try { return check(now) } finally { other.exec('ROLLBACK'); other.close(); locked = { events: wedgeEvents(runtime, mission.id).length } }
    }
    workers.wedgeNext = true
    const task = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement the scoped change',
      kind: 'implementation', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: ['test -d .'], assigneeId: author.id })
    await eventually(() => locked, 'I5: the first naming tick must run under the writer lock', 4_000)
    assert.equal(locked.events, 0, 'I5: the naming tick under the writer lock committed nothing')
    assert.ok(tickFailures.some(line => /WriterBusyError/.test(line)), 'I5: the injection fired: the naming commit met the busy writer')
    const event = await eventually(() => wedgeEvents(runtime, mission.id)[0], 'I5: a later tick must name the wedge once the writer is free', 4_000)
    assert.equal(workers.wedgeSettledAt, undefined, 'I5: the retried naming landed while the body was still wedged')
    workers.autoIdle = true
    await eventually(() => taskOf(runtime, task.id).status === 'running' ? true : undefined, 'I5: the task dispatches once the wedged start settles', 4_000)
    await sleep(100)
    assert.equal(wedgeEvents(runtime, mission.id).length, 1, 'I5: the wedge is named exactly once')
    return { namedAfterFailedCommit: true, runId: event.data.runId, escalations: 1 }
  } finally {
    process.stderr.write = write
    await cleanup()
  }
}

/** I6: the owner pauses while the body waits in a long preparation and resumes after the bound. */
async function pauseAndResumeAcrossTheBound() {
  const workers = new SlowPrepareWorkers(1_500)
  workers.autoIdle = true
  const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: 60, stallPasses: 30, workerStartTimeoutMs: 5_000 } })
  try {
    const task = f.propose()
    await eventually(() => workers.enteredAt !== undefined ? true : undefined, 'I6: the pass body must enter its long preparation', 4_000)
    f.runtime.control(f.owner, f.mission.id, 'pause', 'owner pause while the pass body waits')
    await sleep(200)
    assert.equal(f.runtime.scheduling.passWedged(f.mission.id), true, 'I6: the body passed its bound while the mission was paused')
    assert.equal(wedgeEvents(f.runtime, f.mission.id).length, 0, 'I6: a paused mission is not named')
    const resumedAt = Date.now()
    f.runtime.control(f.owner, f.mission.id, 'resume', 'owner resumes')
    const event = await eventually(() => wedgeEvents(f.runtime, f.mission.id)[0], 'I6: the still-wedged body must be named after the resume', 1_000)
    assert.ok(event.createdAt >= resumedAt && workers.settledAt === undefined, 'I6: named after the resume, while the body still waited')
    await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? true : undefined, 'I6: the body dispatches once its preparation settles', 4_000)
    await sleep(100)
    assert.equal(wedgeEvents(f.runtime, f.mission.id).length, 1, 'I6: the wedge is named exactly once')
    return { namedAfterResume: true, runId: event.data.runId, escalations: 1 }
  } finally { await f.cleanup() }
}

await runScenario({
  id: 'F21',
  title: 'A wedged scheduling pass is named within its bound and the mission resumes when the body settles',
  invariants: ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'],
  body: async () => {
    const workers = new WedgeStartWorkers()
    const boundMs = 60
    // The wedged await's own bound: far past the pass bound, so I1 and I2 are
    // observed while the pass body is still wedged.
    const startBoundMs = 1_500
    const f = await setup({ workers, config: { tickMs: 10, stallPassTimeoutMs: boundMs, stallPasses: 30, workerStartTimeoutMs: startBoundMs } })
    let evidence
    try {
      const task = f.propose()
      const key = `pass_${f.mission.id}`
      // Arm only once the queued or running pass was itself opened on the
      // current durable board: then "the wedged pass advanced no durable state"
      // is a claim about that pass, not about a concurrent proposal landing
      // mid-pass. (The arming reads the in-memory pass record; every assertion
      // below reads durable state.)
      await eventually(() => {
        const pass = f.runtime.scheduling.passes.get(f.mission.id)
        return pass !== undefined && pass.fingerprintBefore === f.runtime.fingerprint(f.mission.id) ? true : undefined
      }, 'a pass must open on the current durable board before the wedge is armed', 4_000)
      const fingerprintAtWedge = f.runtime.fingerprint(f.mission.id)
      f.workers.wedgeNext = true

      // I1: the durable stall event inside the declared bound.
      const event = await eventually(() => wedgeEvents(f.runtime, f.mission.id).at(-1),
        'I1: a pass wedged in a never-resolving adapter start must escalate within the declared bound', 6_000)
      assert.equal(event.data.cause, 'scheduling-pass', 'I1: the pass-level stall is distinguishable from a board stall')
      assert.match(String(event.data.reason), /did not return within its 60ms bound/, 'I1: the wedge path reports the pass timeout')
      assert.equal(event.data.wedged, true, 'I1: the event names the pass as wedged')
      assert.equal(event.data.boundMs, boundMs, 'I1: the declared bound is named')
      assert.equal(event.data.missionFingerprint, fingerprintAtWedge, 'I1: the unchanged state digest is named')
      assert.equal(event.data.stateUnchanged, true, 'I1: the wedged pass advanced no durable state')
      assert.equal(event.data.passId, key, 'I1: the mission\'s pass is named')
      assert.ok(typeof event.data.runId === 'string' && event.data.runId.length > 0, 'I1: the pass execution identity is named')
      assert.ok(Number.isSafeInteger(event.data.revisionBefore) && Number.isSafeInteger(event.data.revisionAtStall), 'I1: the revision window is named')
      assert.ok(Array.isArray(event.data.unschedulable), 'I1: what was unschedulable is named')
      assert.equal(event.data.ownerNotified, true, 'I1: the escalation is the notice witness for this state')
      assert.equal(wedgeEvents(f.runtime, f.mission.id).length, 1,
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
      assert.equal(wedgeEvents(f.runtime, f.mission.id).length, 1,
        'I4: the named wedge produced exactly one escalation for the wedged state')

      evidence = {
        passId: event.data.passId, boundMs, wedgedPassStalled: true, stateUnchanged: true,
        ownerNotified: delivered, deliveredWhileWedged: true, dispatchedTask: task.id, dispatchedAfterSettle: true, escalations: 1,
      }
    } finally { await f.cleanup() }
    return { ...evidence, namingCommitFailsOnce: await namingCommitFailsOnce(), pauseAndResumeAcrossTheBound: await pauseAndResumeAcrossTheBound() }
  },
})
