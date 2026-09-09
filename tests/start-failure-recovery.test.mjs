/**
 * R5-02 regression: a `workers.start` failure is a recoverable interruption, not
 * a permanent block. Pre-fix the scheduler catch marked the member `stopped` and
 * set every pending/running task of that member to `blocked` with no recovery
 * credit and no re-route, emitting only `member/resume-failed`; the stopped
 * member was never restarted and no other member could claim the blocked work.
 *
 * Post-fix mirrors the established policy: exactly one recovery credit per start
 * failure, re-pend while the task's recovery limit is not exhausted, block only
 * at the limit (reason in `task.output`), retry the same member for
 * `START_FAILURE_REROUTE_LIMIT` consecutive failures, then re-route the work to
 * another capable live member with a durable `task/reassigned` event. A
 * successful start resets the member's consecutive failure counter, and a
 * verification task is never re-routed to the author of the source it reviews.
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
  const runtime = new SwarmRuntime({ statePath: join(dir, 'state.sqlite'), leaseMs: 60000, tickMs,
    maxMessageChars: 10000, maxEvents: 1000, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const owner = { sessionId: 'start-owner' }
  const mission = runtime.create(owner, { title: 'Start failure', objective: 'Recover a worker start failure', workspace: '/source',
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const alpha = await runtime.addMember(owner, mission.id, { name: 'Alpha', role: 'implementation' })
  const beta = await runtime.addMember(owner, mission.id, { name: 'Beta', role: 'implementation' })
  const memberGamma = gamma ? await runtime.addMember(owner, mission.id, { name: 'Gamma', role: 'implementation' }) : undefined
  const propose = (extra = {}) => runtime.propose(owner, mission.id, {
    workstreamId: stream.id, title: 'Fix', objective: 'Fix', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const task = id => runtime.store.get('tasks', id)
  const member = id => runtime.store.get('members', id)
  const events = type => runtime.snapshot(owner, mission.id).events.filter(event => event.type === type)
  return { runtime, workers, mission, owner, alpha, beta, gamma: memberGamma, propose, task, member, events }
}

test('R5-02: a start failure spends one credit, re-pends, and re-routes after k consecutive failures', async t => {
  const f = await setup(t)
  const proposed = f.propose({ assigneeId: f.alpha.id, maxRecoveryAttempts: 5 })
  // Fail only the assigned member's route; Beta stays healthy and capable.
  f.workers.failMember = f.alpha.id
  await f.runtime.start()

  const repended = await eventually(() => f.task(proposed.id).recoveryCount === 1 && f.task(proposed.id),
    'the first start failure did not spend a recovery credit')
  assert.equal(repended.status, 'pending', 'a recoverable start failure re-pends the task')
  assert.equal(repended.assigneeId, f.alpha.id, 'below the re-route limit the same live member retries')
  assert.match(repended.output, /Worker could not start: (Error: )?worker bootstrap failed for Alpha/)
  const first = f.events('task/start-failed')
  assert.equal(first.length, 1, 'the start failure emits a durable task transition, not only member/resume-failed')
  assert.equal(first[0].data.taskId, proposed.id)
  assert.equal(first[0].data.recoveryCount, 1)
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
  assert.deepEqual(credits.map(event => event.data.recoveryCount), [1, 2, 3], 'each start failure spends exactly one credit')
  assert.deepEqual(credits.map(event => event.data.consecutiveFailures), [1, 2, 3])
  assert.equal(f.member(f.alpha.id).status, 'stopped', 'the route is retired after k consecutive failures')
  assert.notEqual(f.member(f.beta.id).status, 'stopped')
  assert.equal(f.events('task/blocked').length, 0, 're-routing rescues the task before its recovery limit')

  const running = await eventually(() => f.task(proposed.id).status === 'running' && f.task(proposed.id),
    'the re-routed task was not re-dispatched to the other member')
  assert.equal(running.attempt.ownerId, f.beta.id)
  assert.equal(running.assigneeId, f.beta.id)
  assert.equal(running.recoveryCount, 3, 'a successful dispatch spends no further credit')
  assert(f.workers.starts.includes(f.beta.id))
})

test('R5-02: a start failure blocks only when the task recovery limit is exhausted', async t => {
  const f = await setup(t)
  const proposed = f.propose({ assigneeId: f.alpha.id, maxRecoveryAttempts: 2 })
  f.workers.failMember = f.alpha.id
  await f.runtime.start()

  const blocked = await eventually(() => f.task(proposed.id).status === 'blocked' && f.task(proposed.id),
    'the task never blocked after exhausting its recovery limit')
  assert.equal(blocked.recoveryCount, 2)
  assert.match(blocked.output, /Worker could not start: (Error: )?worker bootstrap failed for Alpha/)
  const credits = f.events('task/start-failed').filter(event => event.data.taskId === proposed.id)
  assert.deepEqual(credits.map(event => event.data.status), ['pending', 'blocked'], 'the task re-pends until the limit and blocks only then')
  assert.deepEqual(credits.map(event => event.data.recoveryCount), [1, 2])
  const blockEvents = f.events('task/blocked').filter(event => event.data.taskId === proposed.id)
  assert.equal(blockEvents.length, 1)
  assert.match(blockEvents[0].data.reason, /Worker could not start/)
  assert.equal(f.events('task/reassigned').length, 0, 'a task blocks at its own limit before the member re-route threshold')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.task(proposed.id).status, 'blocked', 'later start failures cannot revive a blocked task')
  assert.equal(f.task(proposed.id).recoveryCount, 2)
})

test('R5-02: a successful start resets the consecutive failure counter', async t => {
  const f = await setup(t, { tickMs: 100 })
  const proposed = f.propose({ assigneeId: f.alpha.id, maxRecoveryAttempts: 8 })
  f.workers.failMember = f.alpha.id
  await f.runtime.start()
  await eventually(() => f.task(proposed.id).recoveryCount >= 2, 'two start failures did not spend two credits')
  assert.equal(f.task(proposed.id).status, 'pending')

  // Heal the route: the same member starts and takes its work back.
  f.workers.failMember = undefined
  const recovered = await eventually(() => f.task(proposed.id).status === 'running' && f.task(proposed.id),
    'the member did not recover after the transient start failure')
  assert.equal(recovered.attempt.ownerId, f.alpha.id)
  assert.equal(recovered.recoveryCount, 2)

  // Fail once more. Without the reset this is consecutive failure 3 and would
  // re-route; with the reset it is failure 1 of a new run and stays with Alpha.
  f.workers.failMember = f.alpha.id
  await eventually(() => f.task(proposed.id).recoveryCount >= 3, 'the post-recovery start failure did not spend a credit')
  f.workers.failMember = undefined
  const after = f.task(proposed.id)
  assert.equal(after.status, 'pending')
  assert.equal(after.assigneeId, f.alpha.id, 'a reset counter keeps the same member below k')
  assert.equal(f.events('task/reassigned').length, 0, 'a successful start resets the consecutive failure counter')
  assert.equal(f.events('task/start-failed')[2].data.consecutiveFailures, 1, 'the post-recovery failure counts from one')
  const rerun = await eventually(() => f.task(proposed.id).status === 'running' && f.task(proposed.id),
    'the healed member did not take the task again')
  assert.equal(rerun.attempt.ownerId, f.alpha.id)
  assert.equal(rerun.recoveryCount, 3, 'a successful start spends no credit')
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
