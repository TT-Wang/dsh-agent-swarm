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
 *     the pass is released even with live work, the release is recorded durably
 *     on the row, the abandoned body stays fenced, and the escalation names both
 *     the wedged pass and the live work the release preserved.
 *  2. An attempt whose durable progress passed its declared bound escalates with
 *     its own subject (`taskId@epoch`) and member, from the queue-external tick,
 *     so a wedged pass cannot hide it. The clock is durable rows only: a lease
 *     renewal is liveness bookkeeping, not progress.
 *
 * Every guard altered here names its co-firing guards in src/scheduling.ts and
 * each pair has a test below that exercises the PAIR, not one side:
 *  - bounded release x off-pass wedged classification x the notice dedup key
 *    (R16-D1, R16-D2);
 *  - release x `livePass`/`kick` x the fence (R16-D3, supersede path);
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
    workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...input })
  const notices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
  const staleEvents = type => runtime.store.events(mission.id, runtime.config.maxEvents).filter(event => event.type === type)
  return {
    directory, runtime, workers, owner, mission, stream, addMember, actorFor, propose, notices, staleEvents,
    passKey: runtime.scheduling.passKey(mission.id),
    passRow: () => runtime.store.get('passes', runtime.scheduling.passKey(mission.id)),
    escalations: prefix => notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith(prefix)),
  }
}

/** Open a pass and wedge it in `workers.start`, then return the wedged row. */
async function wedgeNextPass(f, workers) {
  // Arm only once the board is quiet: the pass opened by the last `kick` must
  // have finished, so the NEXT pass is the one that hangs.
  await eventually(() => f.passRow()?.status !== 'running' ? true : undefined, 'the current pass must finish before the wedge is armed')
  workers.options.hangStart = true
  f.runtime.kick(f.mission.id)
  const wedged = await eventually(() => {
    const row = f.passRow()
    return row?.status === 'running' && f.runtime.scheduling.passWedged(f.mission.id) ? row : undefined
  }, 'a pass must wedge past its declared bound')
  return wedged
}

test('R16-D1: a pass wedged on live work is released inside its declared live-work bound, and both subjects are named', async t => {
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
  // The release must land inside the declared bound, not whenever the sibling
  // lease happens to lapse (it never does inside this test). The durable event
  // is the stable record of it: the row is already overwritten by the next pass
  // carrying the release forward.
  const event = await eventually(() => f.staleEvents('mission/stalled').filter(item => item.data.wedged === true && item.data.runId === wedged.runId).at(-1),
    'the wedged pass must be released while the sibling lease is still live', 3000)
  const age = event.data.releaseGapMs
  assert.ok(age >= 240, `the release waits for the whole declared live-work bound (released after ${age}ms)`)
  assert.ok(age <= 240 + 4 * f.runtime.config.tickMs, `the release is bounded by the declared live-work bound, not by the lease (released after ${age}ms)`)
  // R16-D1(a): the release preserved the work it was held by.
  const after = f.runtime.store.get('tasks', sibling.id)
  assert.equal(after.status, 'running', 'the sibling task is still running')
  assert.equal(after.attempt.id, held.attempt.id, 'the sibling attempt was not stopped, dropped or reassigned')
  assert.equal(after.attempt.leaseUntil, held.attempt.leaseUntil, 'no lease was changed by the release')
  assert.equal(f.runtime.store.get('tasks', pending.id).status, 'pending', 'the work the wedged pass never reached is still there to dispatch')
  // R16-D1(b): the release is recorded durably with the bound it was measured
  // against, and the live work that held it.
  assert.equal(event.data.reason, `scheduling pass did not return within its 120ms bound and advanced no durable state`)
  assert.equal(f.passRow().releasedRunId, wedged.runId, 'the durable row names the released run')
  assert.ok(f.passRow().releases >= 1, 'the durable row counts the release')
  assert.equal(f.passRow().worstRelease.heldByLiveWork, true, 'the accumulated record names the live work that held it')
  assert.equal(f.passRow().worstRelease.boundMs, 240, 'the release was measured against the live-work bound')
  assert.deepEqual(event.data.liveSubjects, [`${sibling.id}@${held.epoch}`], 'the held-by subject is the live sibling')
  assert.equal(event.data.releasedWhileLive, true)
  assert.equal(event.data.releaseBoundMs, 240)
  assert.equal(event.data.releasedAt, wedged.startedAt + age)
  // R16-D1(c): the durable event and the owner notice name the wedged pass and
  // the preserved work.
  const notice = f.notices().find(delivery => typeof delivery.content === 'string' && delivery.content.includes('live-work bound') && delivery.content.includes(wedged.runId))
  assert.ok(notice, `the owner notice names the release and the bound: ${JSON.stringify(f.notices().map(delivery => delivery.content.slice(0, 80)))}`)
  assert.match(notice.content, /preserved untouched/, 'the notice states the work was preserved')
  assert.match(notice.content, new RegExp(`${sibling.id}@${held.epoch} held by ${builder.id}`), 'the notice names the subject and the member holding it')
  assert.ok(notice.subjects.includes(`${sibling.id}@${held.epoch}`), 'the notice carries the held-by subject in its durable row')
  assert.ok(notice.subjects.includes(`${pending.id}@${f.runtime.store.get('tasks', pending.id).epoch}`), 'and the work the pass never reached')
  // R16-D1(d): the guard is free, so a later tick opens a new pass instead of
  // being swallowed by the wedged body.
  const next = await eventually(() => f.passRow()?.runId !== wedged.runId ? f.passRow() : undefined, 'a later pass must open after the release', 3000)
  assert.notEqual(next.runId, wedged.runId, 'the guard was released, not held by the sibling lease')
})

test('R16-D2 pair: a released pass is fenced durably and its own run is announced exactly once', async t => {
  const workers = new Workers({ idle: () => false })
  const f = await scenario(t, { workers, config: { stallPassTimeoutMs: 120, stallPassLiveGraceMs: 120 } })
  const builder = await f.addMember('Builder')
  const sibling = f.propose('Healthy sibling', { assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, sibling.id)
  const wedged = await wedgeNextPass(f, workers)
  // The durable event is the stable record of the release: the row is already
  // overwritten by the next pass, which carries the release forward.
  await eventually(() => f.staleEvents('mission/stalled').filter(item => item.data.wedged === true && item.data.runId === wedged.runId).at(-1),
    'the wedged pass must be released', 3000)
  // Pair 1: the fence. The abandoned body is stopped by the durable record even
  // though the in-memory fast path is cleared (the S5c verifier reproduction).
  assert.equal(f.runtime.scheduling.passReleased(wedged), true, 'the durable row fences the released body')
  f.runtime.releasedPasses.clear()
  assert.equal(f.runtime.scheduling.passReleased(wedged), true, 'the fence survives a cleared in-memory Set')
  // Pair 2: the notice dedup key. One released run is named once, by its own run
  // id; the later wedges of the same unchanged board are not re-announced, while
  // the durable release count keeps rising.
  await sleep(500)
  const wedgedEvents = f.staleEvents('mission/stalled').filter(item => item.data.wedged === true)
  assert.equal(wedgedEvents.filter(item => item.data.runId === wedged.runId).length, 1, 'the released run is witnessed exactly once')
  assert.equal(f.notices().filter(delivery => typeof delivery.content === 'string' && delivery.content.includes(`run ${wedged.runId}`)).length, 1,
    'the released run is announced to the owner exactly once')
  assert.equal(wedgedEvents.length, 1, `an unchanged board is not re-announced by later releases: ${JSON.stringify(wedgedEvents.map(item => item.data.runId))}`)
  // The later wedges of the same unchanged board keep the release record and
  // never erase it: the row still names a released run and its widening record.
  const row = f.passRow()
  assert.ok(row.releases >= 2, `the durable row counts every release, including the deduped ones (${row.releases})`)
  assert.ok(row.worstRelease.gapMs >= 200, `the accumulated record keeps the widest release (${row.worstRelease.gapMs}ms)`)
  assert.equal(typeof row.worstRelease.runId, 'string', 'the durable row still names a released run')
  assert.equal(f.runtime.store.get('tasks', sibling.id).status, 'running', 'and the preserved work is untouched')
})

test('R16-D3 pair: a pass that supersedes a wedged row releases and names it without the watchdog', async t => {
  // The tick timer opens every 1000ms and the fabricated row is already 5s past
  // the release bound, so the watchdog cannot be the releaser here: the release
  // must come from `openPass` itself, or the guard would be silently overwritten
  // by the row write (the between-ticks window a control-path `kick` can hit).
  const workers = new Workers({ idle: () => false })
  const f = await scenario(t, { workers, config: { tickMs: 1000, stallPassTimeoutMs: 1000, stallPassLiveGraceMs: 0 } })
  const builder = await f.addMember('Builder')
  const sibling = f.propose('Healthy sibling', { assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, sibling.id)
  const held = f.runtime.store.get('tasks', sibling.id)
  // The wedged row, in exactly the shape the watchdog sees: running, this
  // instance, past the release bound.
  const wedged = {
    id: f.passKey, runId: 'run_wedged_probe', instanceId: f.runtime.instanceId, missionId: f.mission.id,
    status: 'running', startedAt: Date.now() - 5000, revisionBefore: f.runtime.store.revision(),
    fingerprintBefore: f.runtime.fingerprint(f.mission.id), noProgressPasses: 0,
  }
  f.runtime.store.transaction(() => f.runtime.store.put('passes', wedged))
  assert.equal(f.runtime.scheduling.livePass(f.mission.id), undefined, 'past the release bound the row is no longer a guard')
  assert.equal(f.runtime.scheduling.passWedged(f.mission.id), true, 'but it is still the wedged subject')
  f.runtime.kick(f.mission.id)
  const row = f.passRow()
  assert.notEqual(row.runId, wedged.runId, 'a new pass opened')
  assert.equal(row.releasedRunId, wedged.runId, 'the superseded row was released, not silently overwritten')
  assert.equal(row.releases, 1, 'the release is counted durably')
  assert.equal(row.status, 'running', 'and the new pass owns the guard')
  assert.equal(f.runtime.scheduling.passReleased(wedged), true, 'the superseded body is fenced')
  assert.equal(f.runtime.store.get('tasks', sibling.id).status, 'running', 'the live work is preserved')
  assert.equal(f.runtime.store.get('tasks', sibling.id).attempt.id, held.attempt.id)
  const event = f.staleEvents('mission/stalled').filter(item => item.data.wedged === true && item.data.runId === wedged.runId)
  assert.equal(event.length, 1, 'the supersede path names the wedged pass durably')
  assert.equal(event[0].data.releaseBoundMs, 1000, 'against the declared bound in force')
  assert.equal(event[0].data.releasedWhileLive, true, 'and names the live work present at the release')
  const notice = f.notices().find(delivery => typeof delivery.content === 'string' && delivery.content.includes(`run ${wedged.runId}`))
  assert.ok(notice, 'and the owner is told which pass execution was released')
  assert.match(notice.content, /released the mission's scheduling guard/)
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
  assert.match(escalation.content, new RegExp(`scheduling pass ${wedged.runId} is wedged past its 120ms bound`),
    'the notice names the wedged pass that cannot report it')
  assert.equal(f.runtime.scheduling.passWedged(f.mission.id), true, 'and the pass is still wedged: the release bound was not reached')
})

test('R16-D8: the silence projection reads both gaps, the release record and the unreported ends from the store alone', async t => {
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
  // The durable event is the stable record of the release; the row is already
  // overwritten by the next pass carrying the release forward.
  await eventually(() => f.staleEvents('mission/stalled').filter(item => item.data.wedged === true && item.data.runId === wedged.runId).at(-1),
    'the wedge is released inside its bound', 3000)
  const released = f.passRow()
  const releasedRecord = { releases: released.releases, worstRelease: released.worstRelease }
  const escalated = await eventually(() => f.escalations('attempt-silent:').find(delivery => delivery.notice.dedupKey.startsWith(`attempt-silent:${claimedHeld.attempt.id}:`)),
    'the silence is escalated', 3000)

  const report = f.runtime.silenceReport(f.mission.id)
  assert.equal(report.missionId, f.mission.id)
  assert.deepEqual(report.bounds, { passMs: 100, passReleaseMs: 200, attemptMs: 200 }, 'the declared bounds are reported with the numbers')
  // Subject gap 1: the released wedged pass, against the bound it was released under.
  const passSubject = report.subjects.find(subject => subject.kind === 'scheduling-pass')
  assert.ok(passSubject, `the release is a measured subject: ${JSON.stringify(report.subjects)}`)
  assert.equal(passSubject.subject, `pass:${wedged.runId}`)
  assert.equal(passSubject.boundMs, 200, 'measured against the live-work bound it was released under')
  assert.equal(passSubject.gapMs, releasedRecord.worstRelease.gapMs)
  assert.ok(passSubject.gapMs >= 200, `the released pass really exceeded its bound (${passSubject.gapMs}ms)`)
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
  assert.ok(report.passReleases.count >= releasedRecord.releases, 'the release count comes from the durable pass row')
  assert.equal(report.passReleases.worst.runId, wedged.runId)
  assert.match(report.note, /Read-only projection/)
})
