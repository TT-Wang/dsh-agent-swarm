/** Preparation failures preserve task identity and use bounded retries only for typed transient causes. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

async function eventually(read, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(message)
}

/** Only the external execution adapter is replaced; preparation fails on demand. */
class PrepWorkers {
  calls = 0
  failures = 0
  transient = true
  gate
  deliveries = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return `/isolated/${memberId}` }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push(delivery) }
  async stop() {}
  isIdle() { return true }
  async prepareTask() {
    this.calls++
    if (this.calls <= this.failures) throw Object.assign(new Error(`workspace condition ${this.calls}`), this.transient ? { code: 'EBUSY' } : {})
    if (this.gate) await this.gate
  }
  async captureArtifact() { return { commit: 'prep', baseCommit: 'base', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async dispose() {}
}

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-prep-'))
  const workers = new PrepWorkers()
  const runtime = new SwarmRuntime({ statePath: join(dir, 'state.sqlite'), leaseMs: 60000, tickMs: 20,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const owner = { sessionId: 'prep-owner' }
  const mission = runtime.create(owner, { title: 'Preparation', objective: 'Recover a preparation failure', workspace: '/source',
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  await runtime.start()
  const propose = (extra = {}) => runtime.propose(owner, mission.id, {
    workstreamId: stream.id, title: 'Fix', objective: 'Fix', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const task = id => runtime.store.get('tasks', id)
  const events = type => runtime.snapshot(owner, mission.id).events.filter(event => event.type === type)
  return { runtime, workers, mission, owner, member, propose, task, events }
}

test('R17: a transient preparation failure backs off and re-pends without spending task recovery credit', async t => {
  const f = await setup(t)
  f.workers.failures = 1
  let release
  f.workers.gate = new Promise(resolve => { release = resolve })
  const proposed = f.propose({ maxRecoveryAttempts: 2 })
  await eventually(() => f.task(proposed.id).preparationFailure?.attempts === 1, 'the first preparation failure was not recorded')
  const repended = f.task(proposed.id)
  assert.equal(repended.status, 'pending', 'a recoverable preparation failure re-pends the task')
  assert.equal(repended.recoveryCount ?? 0, 0)
  assert.ok(repended.preparationFailure.retryAt > Date.now())
  assert.match(repended.output, /Workspace or worker preparation failed: (Error: )?workspace condition 1/)
  const failed = f.events('task/preparation-failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].data.taskId, proposed.id)
  assert.equal(failed[0].data.attempts, 1)
  assert.equal(failed[0].data.transient, true)
  assert.equal(failed[0].data.status, 'pending')
  assert.equal(failed[0].data.epoch, repended.epoch, 'the event names the failed attempt epoch')
  assert.match(failed[0].data.reason, /workspace condition 1/)
  assert.equal(f.events('task/blocked').length, 0, 'the first failure does not block the task')
  release()
  await eventually(() => f.task(proposed.id).status === 'running', 'the task was not re-dispatched once preparation succeeded')
  assert.equal(f.task(proposed.id).recoveryCount ?? 0, 0, 'preparation never spends task execution credit')
  assert.equal(f.workers.calls, 2)
})

test('R17: transient preparation retries are bounded and end in owner-resumable wait', async t => {
  const f = await setup(t)
  f.workers.failures = Number.POSITIVE_INFINITY
  const proposed = f.propose({ maxRecoveryAttempts: 2 })
  await eventually(() => f.task(proposed.id).status === 'blocked', 'the task never blocked after exhausting its recovery limit')
  const blocked = f.task(proposed.id)
  assert.equal(blocked.recoveryCount ?? 0, 0)
  assert.equal(blocked.preparationFailure.attempts, 2)
  assert.match(blocked.output, /swarm_control/)
  assert.match(blocked.output, /Workspace or worker preparation failed: (Error: )?workspace condition 2/)
  const failed = f.events('task/preparation-failed')
  assert.deepEqual(failed.map(event => event.data.status), ['pending', 'blocked'])
  assert.deepEqual(failed.map(event => event.data.attempts), [1, 2])
  assert.equal(failed.at(-1).data.taskId, proposed.id)
  assert.match(failed.at(-1).data.reason, /workspace condition 2/)
  const blockEvents = f.events('task/blocked').filter(event => event.data.taskId === proposed.id)
  assert.equal(blockEvents.length, 1)
  assert.match(blockEvents[0].data.reason, /Workspace or worker preparation failed/)
  assert.equal(f.workers.calls, 2, 'no further preparation attempts after the block')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.workers.calls, 2, 'a blocked task is not dispatchable again')
})

test('R17: deterministic preparation failures wait immediately for cause-changing owner recovery', async t => {
  const f = await setup(t)
  f.workers.transient = false
  f.workers.failures = Number.POSITIVE_INFINITY
  const proposed = f.propose({ maxRecoveryAttempts: 4 })
  await eventually(() => f.task(proposed.id).status === 'blocked', 'deterministic failure should become resumable wait')
  assert.equal(f.workers.calls, 1)
  assert.equal(f.task(proposed.id).recoveryCount ?? 0, 0)
  assert.match(f.task(proposed.id).output, /swarm_control/)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.workers.calls, 1, 'unchanged deterministic failure is not retried every tick')
})

test('a handoff after a successful preparation retry re-pends the task and never hands the worker the retried failure', async t => {
  const f = await setup(t)
  f.workers.failures = 1
  const proposed = f.propose({ maxRecoveryAttempts: 2 })
  await eventually(() => f.task(proposed.id).preparationFailure?.attempts === 1, 'the first preparation failure was not recorded')
  const running = await eventually(() => { const row = f.task(proposed.id); return row.status === 'running' ? row : undefined },
    'the task was not re-dispatched once the preparation retry succeeded')
  assert.equal(f.workers.calls, 2)
  assert.equal(running.preparationFailure?.attempts, 1, 'the recovered failure keeps its retry count until an owner resume')
  const assignment = f.runtime.store.list('deliveries', f.mission.id).filter(row => row.kind === 'assignment' && row.attemptId === running.attempt.id)
  assert.equal(assignment.length, 1)
  assert.equal(JSON.parse(assignment[0].content).task.preparationFailure, undefined, 'the worker is not handed the retried failure')
  // Keep the handed-off task observable as pending: no member is dispatchable.
  f.workers.isIdle = () => false
  f.runtime.handoff({ sessionId: f.member.sessionId }, f.mission.id, { taskId: proposed.id, attemptId: running.attempt.id, summary: 'Continue elsewhere' })
  await eventually(() => f.events('task/handoff-ready').some(event => event.data.taskId === proposed.id), 'the handoff stop barrier did not confirm')
  const handedOff = f.task(proposed.id)
  assert.equal(handedOff.status, 'pending', 'a handoff after a recovered preparation re-pends the task instead of blocking it')
  assert.equal(handedOff.preparationFailure?.attempts, 1, 'the retry count survives the handoff')
  assert.equal(f.events('task/blocked').filter(event => event.data.taskId === proposed.id).length, 0)
})

test('a flapping preparation keeps its retry count across start-failure re-pends and blocks on the third failure', async t => {
  const f = await setup(t)
  // Every odd preparation fails with a typed transient code; every even one
  // succeeds, and the worker start then fails because the member holds a
  // running attempt. A start failure re-pends the task without spending task
  // recovery credit, so only the preparation count can bound this loop.
  f.workers.prepareTask = async () => {
    f.workers.calls++
    if (f.workers.calls % 2 === 1) throw Object.assign(new Error(`workspace busy ${f.workers.calls}`), { code: 'EBUSY' })
  }
  f.workers.start = async ({ member }) => {
    if (f.runtime.store.list('tasks', f.mission.id).some(row => row.status === 'running' && row.attempt?.ownerId === member.id)) {
      throw Object.assign(new Error('worker start failed'), { code: 'EMFILE' })
    }
  }
  const proposed = f.propose({ maxRecoveryAttempts: 3 })
  const blocked = await eventually(() => { const row = f.task(proposed.id); return row.status === 'blocked' ? row : undefined },
    'the flapping preparation never blocked the task', 20000)
  const failed = f.events('task/preparation-failed').filter(event => event.data.taskId === proposed.id)
  assert.deepEqual(failed.map(event => event.data.attempts), [1, 2, 3], 'the count survives each successful preparation')
  assert.deepEqual(failed.map(event => event.data.status), ['pending', 'pending', 'blocked'], 'the third failure blocks')
  assert.ok(f.events('task/start-failed').some(event => event.data.taskId === proposed.id), 'a start failure re-pended the task between preparations')
  assert.equal(blocked.recoveryCount ?? 0, 0, 'no task recovery credit was spent')
  assert.equal(blocked.preparationFailure.attempts, 3)
  assert.equal(blocked.preparationFailure.retryAt, undefined)
  assert.match(blocked.output, /workspace busy 5[\s\S]*swarm_control\(action: "resume"/)
  const blockEvents = f.events('task/blocked').filter(event => event.data.taskId === proposed.id)
  assert.equal(blockEvents.length, 1)
  const notified = f.runtime.store.list('deliveries', f.mission.id).filter(row => row.to === 'owner' && row.content === blocked.output)
  assert.equal(notified.length, 1, 'the owner is notified of the block with its resume path')
  const calls = f.workers.calls
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.workers.calls, calls, 'a blocked task is not prepared again')
})

test('the assignment of a task that never failed preparation embeds its stored row unchanged', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-prep-shape-'))
  const runtime = new SwarmRuntime({ statePath: join(dir, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }, new PrepWorkers())
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const owner = { sessionId: 'shape-owner' }
  const mission = runtime.create(owner, { title: 'Shape', objective: 'Assignment shape', workspace: '/source',
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const proposed = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Fix', objective: 'Fix', kind: 'implementation',
    scope: ['src/'], acceptance: ['works'], checks: ['test'], maxRecoveryAttempts: 2 })
  const claimed = await runtime.claim({ sessionId: member.sessionId }, mission.id, proposed.id)
  const [assignment] = runtime.store.list('deliveries', mission.id).filter(row => row.kind === 'assignment' && row.attemptId === claimed.attempt.id)
  const stored = runtime.store.get('tasks', proposed.id)
  assert.equal(stored.preparationFailure, undefined)
  // Key order included: the worker receives exactly the row the claim stored.
  assert.equal(JSON.stringify(JSON.parse(assignment.content).task), JSON.stringify(stored))
})
