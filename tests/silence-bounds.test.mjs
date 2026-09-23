/**
 * R16-D — bound the release of a wedged pass, and make an attempt that stops
 * reporting escalate by name.
 *
 * The round's rule: nothing may be both silent and unnamed, and work must not
 * stay blocked behind a named wedge with no bounded successor.
 *
 *  1. Round 15 closed the NAMING half of the wedged pass (R15-D1/D2): a pass
 *     hung inside `workers.start`/`workers.stop` is named inside its own clock
 *     even while a sibling's live lease keeps `hasLiveWork` true. The RELEASE
 *     half stayed open: `livePass` kept the row as the guard for as long as any
 *     unrelated lease lived, so the tick timer's only liveness action was
 *     swallowed with no bound. R16-D bounds it: past
 *     `stallPassReleaseBoundMs` (= `stallPassTimeoutMs` + `stallPassLiveGraceMs`)
 *     the pass is named even with live work, the durable event records the
 *     bound and the live work, and the escalation names both the wedged pass and
 *     the live work it preserved. The pass guard is now the in-memory record of
 *     the body the mission queue holds: no body runs beside a wedged one, so
 *     there is no release to record and no fence to keep; the body releases the
 *     guard when its own bounded await settles.
 *  2. An attempt whose durable progress passed its declared bound escalates with
 *     its own subject (`taskId@epoch`) and member, from the queue-external tick,
 *     so a wedged pass cannot hide it. The clock is durable rows only: a lease
 *     renewal is liveness bookkeeping, not progress.
 *
 * Every guard altered here names its co-firing guards in src/scheduling.ts and
 * each pair has a test below that exercises the PAIR, not one side:
 *  - bounded release x off-pass wedged classification x the notice dedup key
 *    (R16-D1, R16-D2);
 *  - the naming x `livePass`/`kick` (R16-D3: a control-path kick neither
 *    supersedes nor duplicates a wedged body);
 *  - attempt bound x F1 operation silence and x the lease renewal that
 *    legitimately keeps a producing attempt alive (R16-D4, R16-D6);
 *  - attempt bound x the W6 idle close-out, which must not double-report the
 *    same attempt (R16-D5);
 *  - attempt bound x the wedged pass (R16-D7);
 *  - both instruments, quoted from the durable store alone (R16-D8).
 *
 * Pre-fix evidence: R16-D1/D2/D3 fail on the composed base without
 * `src/scheduling.ts`'s bounded release (the pass row stays `running` for as long
 * as the sibling lease lives); R16-D4..D8 fail without the attempt guard and the
 * projection. Verified on a scratch checkout of the base (run ids in the
 * submission).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { tempDirectory } from './temp-root.mjs'
import { silenceReport } from './instruments.mjs'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const eventually = async (read, message, timeoutMs = 5000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) { const value = read(); if (value) return value; await sleep(5) }
  assert.fail(message)
}

/** The only external boundary the runtime talks to; every host operation is controlled by the test. */
class Workers {
  constructor(options = {}) { this.options = options; this.started = []; this.deliveries = [] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start(spec) { this.started.push(spec.member.id); if (this.options.hangStart === true) return new Promise(() => {}) }
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, content: delivery.content, kind: delivery.kind }) }
  async stop() { if (this.options.hangStop === true) return new Promise(() => {}) }
  isIdle(memberId) { return this.options.idle === undefined ? true : this.options.idle(memberId) }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}

async function scenario(t, { workers = new Workers(), config = {} } = {}) {
  const directory = await tempDirectory('swarm-silence-bounds-')
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60000, tickMs: 25, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 9, ...config }, workers)
  await runtime.start()
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'silence-bounds' }
  const mission = runtime.create(owner, { title: 'Silence bounds', objective: 'Bound the release and the report', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const addMember = name => runtime.addMember(owner, mission.id, { name, role: 'implementation' })
  const actorFor = member => ({ sessionId: member.sessionId })
  const propose = (title, input = {}) => runtime.propose(owner, mission.id, {
    outputs: [], workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...input })
  const notices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
  const staleEvents = type => runtime.store.events(mission.id, runtime.config.maxEvents).filter(event => event.type === type)
  return {
    directory, runtime, workers, owner, mission, stream, addMember, actorFor, propose, notices, staleEvents,
    passKey: runtime.scheduling.passKey(mission.id),
    pass: () => runtime.scheduling.passes.get(mission.id),
    escalations: prefix => notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith(prefix)),
  }
}

/** Open a pass and wedge it in `workers.start`, then return the wedged pass record. */
async function wedgeNextPass(f, workers) {
  // Arm only once the board is quiet: the pass opened by the last `kick` must
  // have settled, so the NEXT pass is the one that hangs.
  await eventually(() => f.pass() === undefined ? true : undefined, 'the current pass must finish before the wedge is armed')
  workers.options.hangStart = true
  f.runtime.kick(f.mission.id)
  const wedged = await eventually(() => {
    const pass = f.pass()
    return pass !== undefined && f.runtime.scheduling.passWedged(f.mission.id) ? pass : undefined
  }, 'a pass must wedge past its declared bound')
  return wedged
}

test('R16-D1: a pass wedged on live work is named inside its declared live-work bound, and both subjects are named', async t => {
  const workers = new Workers({ idle: () => false })
  const f = await scenario(t, { workers, config: { stallPassTimeoutMs: 120, stallPassLiveGraceMs: 120 } })
  const builder = await f.addMember('Builder')
  // The healthy sibling: a running attempt whose lease is live for the whole
  // release window. This is the work that used to hold the guard forever.
  const sibling = f.propose('Healthy sibling', { assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, sibling.id)
  const held = f.runtime.store.get('tasks', sibling.id)
  const pending = f.propose('Waiting behind the wedge', { assigneeId: builder.id })

  const wedged = await wedgeNextPass(f, workers)
  // The naming must land inside the declared bound, not whenever the sibling
  // lease happens to lapse (it never does inside this test). The durable event
  // is the record of it.
  const event = await eventually(() => f.staleEvents('mission/stalled').filter(item => item.data.wedged === true && item.data.runId === wedged.operationId).at(-1),
    'the wedged pass must be named while the sibling lease is still live', 3000)
  const age = event.data.releaseGapMs
  assert.ok(age >= 240, `the release waits for the whole declared live-work bound (released after ${age}ms)`)
  assert.ok(age <= 240 + 4 * f.runtime.config.tickMs, `the release is bounded by the declared live-work bound, not by the lease (released after ${age}ms)`)
  // R16-D1(a): the release preserved the work it was held by.
  const after = f.runtime.store.get('tasks', sibling.id)
  assert.equal(after.status, 'running', 'the sibling task is still running')
  assert.equal(after.attempt.id, held.attempt.id, 'the sibling attempt was not stopped, dropped or reassigned')
  assert.equal(after.attempt.leaseUntil, held.attempt.leaseUntil, 'no lease was changed by the release')
  assert.equal(f.runtime.store.get('tasks', pending.id).status, 'pending', 'the work the wedged pass never reached is still there to dispatch')
  // R16-D1(b): the naming is recorded durably with the bound it was measured
  // against, and the live work that held it.
  assert.equal(event.data.reason, `scheduling pass did not return within its 120ms bound and advanced no durable state`)
  assert.deepEqual(event.data.liveSubjects, [`${sibling.id}@${held.epoch}`], 'the held-by subject is the live sibling')
  assert.equal(event.data.releasedWhileLive, true)
  assert.equal(event.data.releaseBoundMs, 240)
  assert.equal(event.data.releasedAt, wedged.startedAt + age)
  // R16-D1(c): the durable event and the owner notice name the wedged pass and
  // the preserved work.
  const notice = f.notices().find(delivery => typeof delivery.content === 'string' && delivery.content.includes('live-work bound') && delivery.content.includes(wedged.operationId))
  assert.ok(notice, `the owner notice names the release and the bound: ${JSON.stringify(f.notices().map(delivery => delivery.content.slice(0, 80)))}`)
  assert.match(notice.content, /preserved untouched/, 'the notice states the work was preserved')
  assert.match(notice.content, new RegExp(`${sibling.id}@${held.epoch} held by ${builder.id}`), 'the notice names the subject and the member holding it')
  assert.ok(notice.subjects.includes(`${sibling.id}@${held.epoch}`), 'the notice carries the held-by subject in its durable row')
  assert.ok(notice.subjects.includes(`${pending.id}@${f.runtime.store.get('tasks', pending.id).epoch}`), 'and the work the pass never reached')
  // R16-D1(d): the named body no longer owns generation: the mission publishes
  // as wedged, not as inside a live pass, while the sibling lease still lives.
  // No second body is queued behind the one the queue still owns.
  assert.deepEqual(f.runtime.passState(f.mission.id), { passLive: false, wedged: true }, 'the sibling lease does not keep the named pass live')
  assert.equal(f.pass(), wedged, 'no later tick queued a second body behind the wedged one')
})

test('R16-D2 pair: a wedged pass is announced exactly once and no second body overlaps it', async t => {
  const workers = new Workers({ idle: () => false })
  const f = await scenario(t, { workers, config: { stallPassTimeoutMs: 120, stallPassLiveGraceMs: 120 } })
  const builder = await f.addMember('Builder')
  const sibling = f.propose('Healthy sibling', { assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, sibling.id)
  const wedged = await wedgeNextPass(f, workers)
  const event = await eventually(() => f.staleEvents('mission/stalled').filter(item => item.data.wedged === true && item.data.runId === wedged.operationId).at(-1),
    'the wedged pass must be named', 3000)
  assert.ok(event.data.releaseGapMs >= 200, `the event keeps the whole wedge measured at its naming (${event.data.releaseGapMs}ms)`)
  const nativeStarts = workers.started.length
  // Pair 1: the mission queue. The wedged body is the only body: no later tick
  // queues another one behind it, and none starts a physical operation beside
  // the hung native call.
  // Pair 2: the notice dedup key. One wedged body is named once, by its own
  // operation id, while the off-pass watchdog keeps running.
  await sleep(500)
  const wedgedEvents = f.staleEvents('mission/stalled').filter(item => item.data.wedged === true)
  assert.equal(wedgedEvents.filter(item => item.data.runId === wedged.operationId).length, 1, 'the wedged body is witnessed exactly once')
  assert.equal(f.notices().filter(delivery => typeof delivery.content === 'string' && delivery.content.includes(`run ${wedged.operationId}`)).length, 1,
    'the wedged body is announced to the owner exactly once')
  assert.equal(wedgedEvents.length, 1, `an unchanged board is not re-announced: ${JSON.stringify(wedgedEvents.map(item => item.data.runId))}`)
  assert.equal(f.pass(), wedged, 'no second body was queued behind the wedged one')
  assert.equal(workers.started.length, nativeStarts, 'no pass body overlaps the still-running native startup')
  assert.equal(f.runtime.store.get('tasks', sibling.id).status, 'running', 'and the preserved work is untouched')
})

test('R16-D3 pair: a control-path kick neither supersedes nor duplicates a wedged body, and the watchdog names it', async t => {
  // The tick timer runs every 1000ms and the fabricated body is already 5s past
  // its live-work bound: the between-ticks window a control-path `kick` can hit.
  // The kick must leave the wedged body in place (the queue could not run a
  // second one before it settles), and the watchdog names it.
  const workers = new Workers({ idle: () => false })
  const f = await scenario(t, { workers, config: { tickMs: 1000, stallPassTimeoutMs: 1000, stallPassLiveGraceMs: 0 } })
  const builder = await f.addMember('Builder')
  const sibling = f.propose('Healthy sibling', { assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, sibling.id)
  const held = f.runtime.store.get('tasks', sibling.id)
  // The wedged body's record, in exactly the shape the watchdog sees: held on
  // the mission queue, past the live-work bound.
  await eventually(() => f.pass() === undefined ? true : undefined, 'the passes the claim kicked must settle')
  const wedged = {
    id: f.passKey, operationId: 'operation_wedged_probe', missionId: f.mission.id,
    startedAt: Date.now() - 5000, revisionBefore: f.runtime.store.revision(),
    fingerprintBefore: f.runtime.fingerprint(f.mission.id), noProgressPasses: 0,
  }
  f.runtime.scheduling.passes.set(f.mission.id, wedged)
  t.after(() => f.runtime.scheduling.closePass(f.mission.id, wedged))
  assert.equal(f.runtime.scheduling.livePass(f.mission.id), undefined, 'past the live-work bound the body no longer owns generation')
  assert.equal(f.runtime.scheduling.passWedged(f.mission.id), true, 'but it is still the wedged subject')
  f.runtime.kick(f.mission.id)
  assert.equal(f.pass(), wedged, 'the kick neither superseded nor duplicated the wedged body')
  f.runtime.scheduling.checkSchedulingPasses()
  assert.equal(f.runtime.store.get('tasks', sibling.id).status, 'running', 'the live work is preserved')
  assert.equal(f.runtime.store.get('tasks', sibling.id).attempt.id, held.attempt.id)
  const event = f.staleEvents('mission/stalled').filter(item => item.data.wedged === true && item.data.runId === wedged.operationId)
  assert.equal(event.length, 1, 'the watchdog names the wedged pass durably')
  assert.equal(event[0].data.releaseBoundMs, 1000, 'against the declared bound in force')
  assert.equal(event[0].data.releasedWhileLive, true, 'and names the live work present at the naming')
  const notice = f.notices().find(delivery => typeof delivery.content === 'string' && delivery.content.includes(`run ${wedged.operationId}`))
  assert.ok(notice, 'and the owner is told which pass execution is wedged')
  assert.match(notice.content, /released the mission's scheduling guard/)
  f.runtime.scheduling.checkSchedulingPasses()
  assert.equal(f.staleEvents('mission/stalled').filter(item => item.data.wedged === true && item.data.runId === wedged.operationId).length, 1, 'a later tick does not name the same body again')
})

test('R16-D4: an attempt with no durable progress past its bound escalates with its own subject and member', async t => {
  const f = await scenario(t, { config: { attemptSilenceBoundMs: 150 } })
  const builder = await f.addMember('Builder')
  const task = f.propose('Silent attempt', { assigneeId: builder.id })
  const claimed = await f.runtime.claim(f.actorFor(builder), f.mission.id, task.id)
  const attemptId = claimed.attempt.id
  const claimedAt = f.staleEvents('task/claimed').find(event => event.data?.attempt?.id === attemptId)?.createdAt
  assert.ok(claimedAt, 'the dispatch is durable')
  // Inside the bound nothing escalates: the dispatch itself is the clock's floor.
  assert.equal(f.runtime.silentAttempt(f.runtime.store.get('tasks', task.id), f.runtime.store.get('missions', f.mission.id)), undefined,
    'a freshly claimed attempt is inside its bound')
  const escalation = await eventually(() => f.escalations('attempt-silent:')[0], 'the silence must escalate inside the declared bound plus one tick', 3000)
  assert.equal(escalation.notice.class, 'stall', 'the escalation is a liveness notice')
  assert.equal(escalation.notice.dedupKey, `attempt-silent:${attemptId}:${claimedAt}`, 'the dedup key is the attempt and the instant its silence began')
  assert.deepEqual(escalation.subjects, [`${task.id}@${claimed.epoch}`], 'the subject is the attempt task at its epoch')
  assert.match(escalation.content, new RegExp(`Builder \\(${builder.id}\\)`), 'the member is named')
  assert.match(escalation.content, new RegExp(`attempt ${attemptId}`), 'the attempt is named')
  assert.match(escalation.content, /\[witness: attempt-silent, subject \S+@\d+, attempt \S+, member \S+, lastDurableAt \d+, silentMs \d+, boundMs 150\]/, 'the witness token carries the bound and the instant measured from')
  assert.match(escalation.content, /no durable event, no task state transition and no recorded tool run/, 'the notice states what the bound measured')
  // The escalation names, it does not kill: the work stays live for the owner.
  const live = f.runtime.store.get('tasks', task.id)
  assert.equal(live.status, 'running', 'the attempt is not stopped or re-pended by the notice')
  assert.equal(live.attempt.id, attemptId)
  // One silence escalates once.
  await sleep(250)
  assert.equal(f.escalations('attempt-silent:').length, 1, 'an unchanged silence never repeats')
  assert.ok(f.runtime.silentAttempt(f.runtime.store.get('tasks', task.id), f.runtime.store.get('missions', f.mission.id)) !== undefined,
    'the attempt is still silent: the escalation names it, it does not stop the clock')
  // Pair with the lease renewal that legitimately keeps a producing attempt
  // alive: a recorded tool run is durable progress and re-arms the clock.
  const recorded = await f.workers.callbacks.toolRun(builder.id, { tool: 'bash', arguments: {}, result: { ok: true }, isError: false })
  assert.equal(typeof recorded, 'string', 'the tool run is recorded durably')
  const rearmed = f.runtime.store.get('tasks', task.id)
  assert.equal(f.runtime.silentAttempt(rearmed, f.runtime.store.get('missions', f.mission.id)), undefined,
    'the recording re-arms the attempt clock even though the lease renewal alone would not')
  const runAt = f.runtime.store.toolRuns(f.mission.id, { attemptId }).at(-1).createdAt
  const eventAt = f.staleEvents('tool/recorded').at(-1).createdAt
  const lastDurableAt = Math.max(runAt, eventAt)
  const renewed = await eventually(() => f.escalations('attempt-silent:').find(delivery => delivery.notice.dedupKey === `attempt-silent:${attemptId}:${lastDurableAt}`),
    'a later silence is a new actionable state with a new key', 3000)
  assert.notEqual(renewed.notice.dedupKey, escalation.notice.dedupKey)
  assert.equal(f.escalations('attempt-silent:').length, 2, 'each distinct silence escalates exactly once')
})

test('R16-D5 pair: an attempt whose turn ended is the close-out\'s subject, never double-reported', async t => {
  const f = await scenario(t, { config: { attemptSilenceBoundMs: 100, tickMs: 25, maxIdleCloseouts: 2 } })
  const idleMember = await f.addMember('Idle')
  const silentMember = await f.addMember('Silent')
  const idleTask = f.propose('Turn ended', { assigneeId: idleMember.id })
  const silentTask = f.propose('No signal', { assigneeId: silentMember.id })
  const idleAttempt = (await f.runtime.claim(f.actorFor(idleMember), f.mission.id, idleTask.id)).attempt.id
  const silentAttempt = (await f.runtime.claim(f.actorFor(silentMember), f.mission.id, silentTask.id)).attempt.id
  // The adapter reports the first member's turn ended while it still owns the
  // attempt: the durable idle signal the W6 close-out reads.
  f.runtime.workers.callbacks.idle(idleMember.id)
  await sleep(600)
  // Close-out side of the pair: the nudge is durable and re-arms the clock.
  const nudged = f.staleEvents('task/closeout-nudged').some(event => event.data.taskId === idleTask.id)
  assert.ok(nudged, 'the idle attempt is handled by the bounded close-out nudge')
  assert.ok(f.workers.deliveries.some(delivery => delivery.memberId === idleMember.id && /still open but your turn ended/.test(delivery.content)),
    'and the member is told to finish it')
  assert.deepEqual(f.escalations('attempt-silent:').filter(delivery => delivery.notice.dedupKey.startsWith(`attempt-silent:${idleAttempt}:`)), [],
    'the attempt reporting bound never double-reports the attempt the close-out owns')
  // The other side of the pair, same fixture: without the idle signal the very
  // same shape is silence and must be named.
  const named = f.escalations('attempt-silent:').find(delivery => delivery.notice.dedupKey.startsWith(`attempt-silent:${silentAttempt}:`))
  assert.ok(named, 'the attempt with no idle signal is named by the reporting bound')
  assert.deepEqual(named.subjects, [`${silentTask.id}@${f.runtime.store.get('tasks', silentTask.id).epoch}`])
})

test('R16-D6 pair: F1\'s operation silence owns the clock while an operation is recorded', async t => {
  const f = await scenario(t, { config: { operationBoundMs: 120, attemptSilenceBoundMs: 120 } })
  const builder = await f.addMember('Builder')
  const task = f.propose('Stuck call', { assigneeId: builder.id })
  const claimed = await f.runtime.claim(f.actorFor(builder), f.mission.id, task.id)
  // F1's shape: one in-flight operation recorded on the member that has
  // recorded nothing since it started.
  const member = f.runtime.store.get('members', builder.id)
  member.activity = { id: 'activity_stuck', kind: 'tool', tool: 'bash', startedAt: Date.now() - 500, attemptId: claimed.attempt.id }
  f.runtime.store.put('members', member)
  assert.equal(f.runtime.sweepSilentAttempts(f.mission.id), 0, 'the attempt bound yields to the in-flight operation')
  const operation = await eventually(() => f.escalations('operation-silent:')[0], 'F1 names the stuck operation', 3000)
  assert.equal(operation.notice.dedupKey, `operation-silent:${claimed.attempt.id}:activity_stuck:${member.activity.startedAt}`)
  await sleep(250)
  assert.deepEqual(f.escalations('attempt-silent:'), [], 'the same attempt is never reported twice by two guards')
})

test('R16-D7 pair: the attempt bound fires from the queue-external tick while the pass is wedged', async t => {
  const workers = new Workers({ idle: () => false })
  const f = await scenario(t, { workers, config: { stallPassTimeoutMs: 120, stallPassLiveGraceMs: 1000, attemptSilenceBoundMs: 200 } })
  const builder = await f.addMember('Builder')
  const task = f.propose('Silent while the pass is wedged', { assigneeId: builder.id })
  const claimed = await f.runtime.claim(f.actorFor(builder), f.mission.id, task.id)
  const wedged = await wedgeNextPass(f, workers)
  assert.equal(f.runtime.scheduling.passWedged(f.mission.id), true, 'the pass really is wedged')
  const escalation = await eventually(() => f.escalations('attempt-silent:').find(delivery => delivery.notice.dedupKey.startsWith(`attempt-silent:${claimed.attempt.id}:`)),
    'the tick names the attempt even though the in-pass recovery sweep cannot run', 3000)
  assert.match(escalation.content, new RegExp(`scheduling pass ${wedged.operationId} is wedged past its 120ms bound`),
    'the notice names the wedged pass that cannot report it')
  assert.equal(f.runtime.scheduling.passWedged(f.mission.id), true, 'and the pass is still wedged: its body has not settled')
})

test('R16-D8: the silence projection reads both gaps, the wedge record and the unreported ends from the store alone', async t => {
  const workers = new Workers({ idle: () => false })
  const f = await scenario(t, { workers, config: { stallPassTimeoutMs: 100, stallPassLiveGraceMs: 100, attemptSilenceBoundMs: 200 } })
  const builder = await f.addMember('Builder')
  const other = await f.addMember('Other')
  const held = f.propose('Held sibling', { assigneeId: builder.id })
  const claimedHeld = await f.runtime.claim(f.actorFor(builder), f.mission.id, held.id)
  // An attempt that ends with nothing durable after its dispatch: the second
  // member claims, then the row is re-pended without any event naming the
  // attempt (the lost-process shape the counter exists for). Claimed before the
  // wedge so the queue wait is a settled predecessor, never the never-settling
  // wedged pass.
  const quietly = f.propose('Ends quietly', { assigneeId: other.id })
  const gone = await f.runtime.claim(f.actorFor(other), f.mission.id, quietly.id)
  const goneAttempt = gone.attempt.id
  const dropped = f.runtime.store.get('tasks', quietly.id)
  dropped.status = 'pending'; delete dropped.attempt; delete dropped.assigneeId
  f.runtime.store.put('tasks', dropped)
  const wedged = await wedgeNextPass(f, workers)
  // The durable event is the record of the wedge.
  const named = await eventually(() => f.staleEvents('mission/stalled').filter(item => item.data.wedged === true && item.data.runId === wedged.operationId).at(-1),
    'the wedge is named inside its bound', 3000)
  const escalated = await eventually(() => f.escalations('attempt-silent:').find(delivery => delivery.notice.dedupKey.startsWith(`attempt-silent:${claimedHeld.attempt.id}:`)),
    'the silence is escalated', 3000)

  const report = silenceReport(f.runtime, f.mission.id)
  assert.equal(report.missionId, f.mission.id)
  assert.deepEqual(report.bounds, { passMs: 100, passReleaseMs: 200, attemptMs: 200 }, 'the declared bounds are reported with the numbers')
  // Subject gap 1: the wedged pass, against the bound it was named under.
  const passSubject = report.subjects.find(subject => subject.kind === 'scheduling-pass')
  assert.ok(passSubject, `the wedge is a measured subject: ${JSON.stringify(report.subjects)}`)
  assert.equal(passSubject.subject, `pass:${wedged.operationId}`)
  assert.equal(passSubject.boundMs, 200, 'measured against the live-work bound it was named under')
  assert.equal(passSubject.gapMs, named.data.releaseGapMs)
  assert.ok(passSubject.gapMs >= 200, `the wedged pass really exceeded its bound (${passSubject.gapMs}ms)`)
  // Subject gap 2: the escalated attempt, against the attempt reporting bound.
  const attemptSubject = report.subjects.find(subject => subject.kind === 'attempt' && subject.subject === `${held.id}@${claimedHeld.epoch}`)
  assert.ok(attemptSubject, 'the attempt escalation is a measured subject')
  assert.equal(attemptSubject.boundMs, 200)
  assert.equal(attemptSubject.gapMs, escalated.createdAt - Number(escalated.notice.dedupKey.split(':').at(-1)))
  assert.equal(report.attemptSilenceEscalations, report.subjects.filter(subject => subject.kind === 'attempt').length)
  assert.equal(report.worstSubjectSilence.gapMs, Math.max(...report.subjects.map(subject => subject.gapMs)), 'the worst subject gap is the widest measured')
  // The worst per-attempt reporting gap is per attempt, and the ended-unreported
  // count names exactly the attempt that ended with nothing after its dispatch.
  assert.ok(report.worstAttemptReportingGap, 'the projection reports the worst per-attempt reporting gap')
  assert.ok(report.worstAttemptReportingGap.gapMs >= 200)
  const quietAttempt = report.attempts.find(attempt => attempt.attemptId === goneAttempt)
  assert.ok(quietAttempt, 'the dropped attempt is reconstructed from the durable log')
  assert.equal(quietAttempt.endedUnreported, true, 'it ended with no durable report or escalation')
  assert.equal(quietAttempt.lastDurableAt, quietAttempt.claimedAt)
  assert.deepEqual(quietAttempt.escalations, [])
  const escalatedReport = report.attempts.find(attempt => attempt.attemptId === claimedHeld.attempt.id)
  assert.ok(escalatedReport, 'the escalated attempt is reconstructed too')
  assert.equal(escalatedReport.endedUnreported, false, 'an attempt the runtime escalated is reported')
  assert.equal(escalatedReport.escalations.length, 1)
  assert.equal(report.attemptsEndedUnreported, 1, 'exactly one attempt ended with no durable report or escalation')
  assert.ok(report.attemptsEnded >= 1)
  assert.equal(report.passReleases.count, 1, 'the wedge count comes from the durable stall events')
  assert.equal(report.passReleases.worst.runId, wedged.operationId)
})
