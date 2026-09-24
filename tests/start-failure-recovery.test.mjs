/**
 * R5-02 regression: a `workers.start` failure is a recoverable interruption, not
 * a permanent block. Pre-fix the scheduler catch marked the member `stopped` and
 * set every pending/running task of that member to `blocked` with no recovery
 * credit and no re-route, emitting only `member/resume-failed`; the stopped
 * member was never restarted and no other member could claim the blocked work.
 *
 * Post-fix: route startup is infrastructure recovery, so a start failure spends
 * no task recovery credit (69211b9) and re-pends the task. The same member is
 * retried for `START_FAILURE_REROUTE_LIMIT` consecutive failures, then the route
 * is retired and the work re-routed to another capable live member with a
 * durable `task/reassigned` event. A successful start resets the member's
 * consecutive failure counter, and a verification task is never re-routed to
 * the author of the source it reviews. The bound is k failed starts per route:
 * when every route that could start a task is retired, the owner is told by
 * name. A classified provider outage neither counts nor retires a route; its
 * starts are paced to one probe per outage window and the owner is told once.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

/** Must match START_FAILURE_REROUTE_LIMIT in src/runtime.ts. */
const K = 3
const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

async function eventually(read, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(message)
}

/** Only the external execution adapter is replaced; start fails on demand for one member. */
class StartFailureWorkers {
  failMember
  /** Every member in this set fails its start, with `failWith` when set. */
  failMembers = new Set()
  failWith
  starts = []
  deliveries = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return `/isolated/${memberId}` }
  async start(spec) {
    this.starts.push(spec.member.id)
    // Deliberately not provider-outage wording: R11-01 classifies "provider
    // unavailable" as a quiescent outage with its own recovery policy and its
    // own regression (tests/provider-outage.test.mjs). This suite tests the
    // generic start-failure policy.
    if (spec.member.id === this.failMember) throw new Error(`worker bootstrap failed for ${spec.member.name}`)
    if (this.failMembers.has(spec.member.id)) throw this.failWith ?? new Error(`worker bootstrap failed for ${spec.member.name}`)
  }
  async deliver(member, delivery) { this.deliveries.push(delivery) }
  async stop() {}
  isIdle() { return true }
  async prepareTask() {}
  async captureArtifact() { return { commit: 'start-failure', baseCommit: 'base', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async dispose() {}
}

async function setup(t, { gamma = false, tickMs = 20 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-start-failure-'))
  const workers = new StartFailureWorkers()
  // The runtime clock can be moved past a provider outage window.
  const clock = { skew: 0 }
  const runtime = new SwarmRuntime({ statePath: join(dir, 'state.sqlite'), leaseMs: 60000, tickMs,
    maxMessageChars: 10000, maxEvents: 1000, maxTasksPerMember: 100, now: () => Date.now() + clock.skew }, workers)
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const owner = { sessionId: 'start-owner' }
  const mission = runtime.create(owner, { title: 'Start failure', objective: 'Recover a worker start failure', workspace: '/source',
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const alpha = await runtime.addMember(owner, mission.id, { name: 'Alpha', role: 'implementation' })
  const beta = await runtime.addMember(owner, mission.id, { name: 'Beta', role: 'implementation' })
  const memberGamma = gamma ? await runtime.addMember(owner, mission.id, { name: 'Gamma', role: 'implementation' }) : undefined
  const propose = (extra = {}) => runtime.propose(owner, mission.id, {
    outputs: [], workstreamId: stream.id, title: 'Fix', objective: 'Fix', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const task = id => runtime.store.get('tasks', id)
  const member = id => runtime.store.get('members', id)
  const events = type => runtime.snapshot(owner, mission.id).events.filter(event => event.type === type)
  const ownerNotices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
  return { runtime, workers, mission, owner, alpha, beta, gamma: memberGamma, propose, task, member, events, ownerNotices, clock }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const startsOf = (f, memberId) => f.workers.starts.filter(id => id === memberId).length
/** Must match PROVIDER_OUTAGE_WINDOW_MS in src/runtime.ts. */
const OUTAGE_WINDOW_MS = 5 * 60_000

test('R5-02: a start failure preserves task credit, re-pends, and re-routes after k consecutive failures', async t => {
  // A tick longer than the poll, so a loaded host cannot pass the one-failure state unseen.
  const f = await setup(t, { tickMs: 100 })
  const proposed = f.propose({ assigneeId: f.alpha.id, maxRecoveryAttempts: 5 })
  // Fail only the assigned member's route; Beta stays healthy and capable.
  f.workers.failMember = f.alpha.id
  await f.runtime.start()

  const repended = await eventually(() => f.events('task/start-failed').length === 1 && f.task(proposed.id),
    'the first start failure was not recorded')
  assert.equal(repended.status, 'pending', 'a recoverable start failure re-pends the task')
  assert.equal(repended.assigneeId, f.alpha.id, 'below the re-route limit the same live member retries')
  assert.match(repended.output, /Worker could not start: (Error: )?worker bootstrap failed for Alpha/)
  const first = f.events('task/start-failed')
  assert.equal(first.length, 1, 'the start failure emits a durable task transition, not only member/resume-failed')
  assert.equal(first[0].data.taskId, proposed.id)
  assert.equal(first[0].data.recoveryCount, 0)
  assert.equal(first[0].data.consecutiveFailures, 1)
  assert.equal(first[0].data.status, 'pending')
  assert.equal(f.events('task/blocked').length, 0, 'the first failure does not block the task')

  const reassigned = await eventually(() => f.events('task/reassigned').find(event => event.data.taskId === proposed.id),
    'the task was not re-routed after k consecutive start failures')
  assert.equal(reassigned.data.from, f.alpha.id)
  assert.equal(reassigned.data.to, f.beta.id)
  assert.equal(reassigned.data.consecutiveFailures, K)
  assert.match(reassigned.data.reason, /worker bootstrap failed for Alpha/)
  const credits = f.events('task/start-failed').filter(event => event.data.taskId === proposed.id)
  assert.deepEqual(credits.map(event => event.data.recoveryCount), [0, 0, 0], 'startup failures preserve execution recovery credit')
  assert.deepEqual(credits.map(event => event.data.consecutiveFailures), [1, 2, 3])
  assert.equal(f.member(f.alpha.id).status, 'stopped', 'the route is retired after k consecutive failures')
  assert.notEqual(f.member(f.beta.id).status, 'stopped')
  assert.equal(f.events('task/blocked').length, 0, 're-routing rescues the task before its recovery limit')

  const running = await eventually(() => f.task(proposed.id).status === 'running' && f.task(proposed.id),
    'the re-routed task was not re-dispatched to the other member')
  assert.equal(running.attempt.ownerId, f.beta.id)
  assert.equal(running.assigneeId, f.beta.id)
  assert.equal(running.recoveryCount ?? 0, 0, 'a successful dispatch spends no further credit')
  assert(f.workers.starts.includes(f.beta.id))
})

test('R16: a small task recovery allowance cannot block infrastructure rerouting', async t => {
  const f = await setup(t)
  const proposed = f.propose({ assigneeId: f.alpha.id, maxRecoveryAttempts: 1 })
  f.workers.failMember = f.alpha.id
  await f.runtime.start()
  const running = await eventually(() => f.task(proposed.id).status === 'running' && f.task(proposed.id), 'healthy route did not resume the obligation')
  assert.equal(running.assigneeId, f.beta.id)
  assert.equal(running.recoveryCount ?? 0, 0)
  assert.equal(f.events('task/blocked').length, 0)
  assert.deepEqual(f.events('task/start-failed').map(event => event.data.consecutiveFailures), [1, 2, 3])
})

test('R5-02: a successful start resets the consecutive failure counter', async t => {
  const f = await setup(t, { tickMs: 100 })
  const proposed = f.propose({ assigneeId: f.alpha.id, maxRecoveryAttempts: 8 })
  f.workers.failMember = f.alpha.id
  await f.runtime.start()
  await eventually(() => f.events('task/start-failed').length >= 2, 'two start failures were not recorded')
  assert.equal(f.task(proposed.id).status, 'pending')

  // Heal the route: the same member starts and takes its work back.
  f.workers.failMember = undefined
  const recovered = await eventually(() => f.task(proposed.id).status === 'running' && f.task(proposed.id),
    'the member did not recover after the transient start failure')
  assert.equal(recovered.attempt.ownerId, f.alpha.id)
  assert.equal(recovered.recoveryCount ?? 0, 0)

  // Fail once more. Without the reset this is consecutive failure 3 and would
  // re-route; with the reset it is failure 1 of a new run and stays with Alpha.
  f.workers.failMember = f.alpha.id
  await eventually(() => f.events('task/start-failed').length >= 3, 'the post-recovery start failure was not recorded')
  f.workers.failMember = undefined
  const after = f.task(proposed.id)
  assert.equal(after.status, 'pending')
  assert.equal(after.assigneeId, f.alpha.id, 'a reset counter keeps the same member below k')
  assert.equal(f.events('task/reassigned').length, 0, 'a successful start resets the consecutive failure counter')
  assert.equal(f.events('task/start-failed')[2].data.consecutiveFailures, 1, 'the post-recovery failure counts from one')
  const rerun = await eventually(() => f.task(proposed.id).status === 'running' && f.task(proposed.id),
    'the healed member did not take the task again')
  assert.equal(rerun.attempt.ownerId, f.alpha.id)
  assert.equal(rerun.recoveryCount ?? 0, 0, 'a successful start spends no credit')
})

test('R5-02: re-route never picks the author of the verification source it would review', async t => {
  const f = await setup(t, { gamma: true })
  const source = f.propose({ assigneeId: f.beta.id })
  const sourceRun = await eventually(() => f.task(source.id).status === 'running' && f.task(source.id),
    'the source task was not dispatched')
  await f.runtime.submit({ sessionId: f.beta.sessionId }, f.mission.id,
    { taskId: source.id, attemptId: sourceRun.attempt.id, output: 'source done' })
  assert.equal(f.task(source.id).status, 'submitted')
  const review = f.propose({ kind: 'verification', reviewOf: source.id, assigneeId: f.alpha.id, checks: [] })
  await eventually(() => f.task(review.id).status === 'running', 'the review was not dispatched to the assigned reviewer')

  f.workers.failMember = f.alpha.id
  await f.runtime.start()
  const reassigned = await eventually(() => f.events('task/reassigned').find(event => event.data.taskId === review.id),
    'the review was not re-routed after k consecutive start failures')
  assert.equal(reassigned.data.from, f.alpha.id)
  assert.equal(reassigned.data.to, f.gamma.id, 'the source author is not a valid re-route target')
  assert.notEqual(reassigned.data.to, f.beta.id)
  const rerun = await eventually(() => f.task(review.id).status === 'running' && f.task(review.id),
    'the re-routed review was not re-dispatched')
  assert.equal(rerun.attempt.ownerId, f.gamma.id)
})

test('R5-02: when every route fails to start, starts stop at k per route and the owner is told the task, each retired route and the exits', async t => {
  const f = await setup(t)
  const proposed = f.propose({ assigneeId: f.alpha.id, maxRecoveryAttempts: 2 })
  f.workers.failMembers = new Set([f.alpha.id, f.beta.id])
  f.workers.starts = [] // count only the starts after admission
  await f.runtime.start()
  await eventually(() => f.member(f.alpha.id).phase === 'stopped' && f.member(f.beta.id).phase === 'stopped', 'both failing routes were not retired')
  // The bound: k failed starts per route, then nothing retries the task.
  await sleep(300)
  assert.equal(startsOf(f, f.alpha.id), K, 'the first route is bounded by k failed starts')
  assert.equal(startsOf(f, f.beta.id), K, 'the last route is bounded by k failed starts')
  const stranded = f.task(proposed.id)
  assert.equal(stranded.status, 'pending', 'a start failure never blocks the task')
  assert.equal(stranded.assigneeId, undefined, 'the work is released to any route the owner admits')
  assert.equal(stranded.recoveryCount ?? 0, 0, 'a start failure spends no task execution credit')
  assert.equal(f.events('task/blocked').length, 0)
  // The named, undeduplicated owner notice.
  const named = f.ownerNotices().filter(delivery => /No live member can start/.test(delivery.content))
  assert.equal(named.length, 1, 'exactly one owner notice names the stranded task')
  const [notice] = named
  assert.ok(notice.content.includes(proposed.id), 'the notice names the task')
  for (const retired of [f.alpha, f.beta]) {
    assert.ok(notice.content.includes(`${retired.name} (${retired.id}): ${K} consecutive start failures, last error: Error: worker bootstrap failed for ${retired.name}`),
      `the notice names ${retired.name} with its consecutive start failures and last error`)
  }
  assert.match(notice.content, /swarm_add_member/, 'the notice names the add-member exit')
  assert.match(notice.content, /swarm_control\(taskId, action: "amend"/, 'the notice names the reassign exit')
  assert.ok((notice.notice?.subjects ?? notice.subjects ?? []).some(subject => subject.startsWith(`${proposed.id}@`)), 'the notice is attributed to the task')
  // The exit works: a route the owner admits claims the released work.
  const gamma = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Gamma', role: 'implementation' })
  const running = await eventually(() => f.task(proposed.id).status === 'running' && f.task(proposed.id), 'the admitted route did not claim the released work')
  assert.equal(running.attempt.ownerId, gamma.id)
  assert.equal(running.recoveryCount ?? 0, 0)
})

test('R11-01: a provider outage on every route is paced to one start probe per outage window and told once per outage', async t => {
  const f = await setup(t)
  const proposed = f.propose({ assigneeId: f.alpha.id, maxRecoveryAttempts: 2 })
  f.workers.failWith = Object.assign(new Error('provider unavailable (HTTP 503)'), { status: 503 })
  f.workers.failMembers = new Set([f.alpha.id, f.beta.id])
  f.workers.starts = [] // count only the starts after admission
  await f.runtime.start()
  await eventually(() => f.member(f.alpha.id).providerOutage && f.member(f.beta.id).providerOutage, 'both outages were not recorded')
  const outageNotices = () => f.ownerNotices().filter(delivery => /provider unavailable outage/.test(delivery.content)).map(delivery => delivery.from).sort()
  // Many ticks inside the window: no further start attempt on either route.
  await sleep(300)
  assert.equal(startsOf(f, f.alpha.id), 1, 'no start attempt while the outage window is open')
  assert.equal(startsOf(f, f.beta.id), 1, 'no start attempt while the outage window is open')
  assert.deepEqual(outageNotices(), [f.alpha.id, f.beta.id].sort(), 'the owner is told once per route outage')
  // The next window allows exactly one probe per route, and tells the owner nothing new.
  f.clock.skew += OUTAGE_WINDOW_MS + 1
  await eventually(() => startsOf(f, f.alpha.id) === 2 && startsOf(f, f.beta.id) === 2, 'each route did not probe once in the next window')
  await sleep(300)
  assert.equal(startsOf(f, f.alpha.id), 2, 'one probe per window')
  assert.equal(startsOf(f, f.beta.id), 2, 'one probe per window')
  assert.deepEqual(outageNotices(), [f.alpha.id, f.beta.id].sort(), 'a continuing outage is not re-announced')
  assert.notEqual(f.member(f.alpha.id).phase, 'stopped', 'an outage never retires a route')
  assert.equal(f.task(proposed.id).recoveryCount ?? 0, 0, 'an outage spends no task execution credit')
  // Recovery is found by the next probe.
  f.workers.failMembers = new Set()
  f.clock.skew += OUTAGE_WINDOW_MS + 1
  const running = await eventually(() => f.task(proposed.id).status === 'running' && f.task(proposed.id), 'the recovered route did not take the work')
  assert.equal(running.recoveryCount ?? 0, 0)
})

test('R11-01: work leaving an outage route prefers a live route outside its outage window', async t => {
  const f = await setup(t, { gamma: true })
  const proposed = f.propose({ assigneeId: f.alpha.id, maxRecoveryAttempts: 2 })
  f.workers.failWith = Object.assign(new Error('provider unavailable (HTTP 503)'), { status: 503 })
  f.workers.failMembers = new Set([f.alpha.id, f.beta.id])
  f.workers.starts = [] // count only the starts after admission
  await f.runtime.start()
  // Alpha and Beta share the failing provider and each probe once per window;
  // Gamma is healthy, so the work must reach it inside the first window.
  const running = await eventually(() => f.task(proposed.id).status === 'running' && f.task(proposed.id), 'the work waited behind a paced outage route', 2000)
  assert.equal(running.attempt.ownerId, f.gamma.id)
  assert.equal(running.recoveryCount ?? 0, 0)
})
