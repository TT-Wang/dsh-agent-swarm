/**
 * W18 regression: a workspace or worker preparation failure during dispatch is
 * recoverable. Pre-fix the dispatch catch set the task straight to `blocked`
 * with no recovery credit, so only the owner could revive it. The fix mirrors
 * the attempt-failure, close-out and lease-expiry policy: one recovery credit
 * per failure, re-pend while the limit is not exhausted, block only then, keep
 * the reason in `task.output` and record a durable `task/preparation-failed`.
 */
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
    if (this.calls <= this.failures) throw new Error(`dirty workspace ${this.calls}`)
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

test('W18: a preparation failure spends one recovery credit and re-pends until it succeeds', async t => {
  const f = await setup(t)
  f.workers.failures = 1
  let release
  f.workers.gate = new Promise(resolve => { release = resolve })
  const proposed = f.propose({ maxRecoveryAttempts: 2 })
  await eventually(() => f.task(proposed.id).recoveryCount === 1, 'the first preparation failure did not spend a recovery credit')
  const repended = f.task(proposed.id)
  assert.equal(repended.status, 'pending', 'a recoverable preparation failure re-pends the task')
  assert.equal(repended.recoveryCount, 1)
  assert.match(repended.output, /Workspace or worker preparation failed: (Error: )?dirty workspace 1/)
  const failed = f.events('task/preparation-failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].data.taskId, proposed.id)
  assert.equal(failed[0].data.recoveryCount, 1)
  assert.equal(failed[0].data.maxRecoveryAttempts, 2)
  assert.equal(failed[0].data.status, 'pending')
  assert.equal(failed[0].data.epoch, repended.epoch, 'the event names the failed attempt epoch')
  assert.match(failed[0].data.reason, /dirty workspace 1/)
  assert.equal(f.events('task/blocked').length, 0, 'the first failure does not block the task')
  release()
  await eventually(() => f.task(proposed.id).status === 'running', 'the task was not re-dispatched once preparation succeeded')
  assert.equal(f.task(proposed.id).recoveryCount, 1, 'a successful dispatch spends no further credit')
  assert.equal(f.workers.calls, 2)
})

test('W18: a preparation failure blocks only when the recovery limit is exhausted', async t => {
  const f = await setup(t)
  f.workers.failures = Number.POSITIVE_INFINITY
  const proposed = f.propose({ maxRecoveryAttempts: 2 })
  await eventually(() => f.task(proposed.id).status === 'blocked', 'the task never blocked after exhausting its recovery limit')
  const blocked = f.task(proposed.id)
  assert.equal(blocked.recoveryCount, 2)
  assert.match(blocked.output, /Workspace or worker preparation failed: (Error: )?dirty workspace 2/)
  const failed = f.events('task/preparation-failed')
  assert.deepEqual(failed.map(event => event.data.status), ['pending', 'blocked'])
  assert.deepEqual(failed.map(event => event.data.recoveryCount), [1, 2])
  assert.equal(failed.at(-1).data.taskId, proposed.id)
  assert.match(failed.at(-1).data.reason, /dirty workspace 2/)
  const blockEvents = f.events('task/blocked').filter(event => event.data.taskId === proposed.id)
  assert.equal(blockEvents.length, 1)
  assert.match(blockEvents[0].data.reason, /Workspace or worker preparation failed/)
  assert.equal(f.workers.calls, 2, 'no further preparation attempts after the block')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.workers.calls, 2, 'a blocked task is not dispatchable again')
})
