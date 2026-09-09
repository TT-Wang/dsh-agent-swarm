/**
 * R11-01 regression: provider failures are classified at the adapter boundary,
 * recorded durably, never spend recovery credit, and route the work to another
 * live member when one exists.
 *
 * Pre-fix head: every start failure spent one recovery credit and no typed
 * outage event existed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { SwarmRuntime } from '../lib/runtime.js'
import { classifyProviderOutage } from '../lib/scheduler.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

class OutageWorkers {
  started = []
  failFor
  failWith
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start(spec) {
    if (spec.member.id === this.failFor) throw this.failWith ?? Object.assign(new Error('provider unavailable'), { status: 503 })
    this.started.push(spec.member.id)
  }
  async deliver() {}
  async stop() {}
  isIdle() { return true }
  async prepareTask() {}
  async captureArtifact() { return { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] } }
  async verifyArtifact() { return [] }
  async dispose() {}
}

async function fixture(t, workers = new OutageWorkers()) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-outage-'))
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 3 }, workers)
  await runtime.start()
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'outage-owner' }
  const mission = runtime.create(owner, { title: 'Outage', objective: 'Route around a provider outage', workspace: '/source', scope: ['**'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const first = await runtime.addMember(owner, mission.id, { name: 'First', role: 'implementation' })
  const second = await runtime.addMember(owner, mission.id, { name: 'Second', role: 'implementation' })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Work', objective: 'Work', kind: 'implementation',
    scope: ['**'], acceptance: ['works'], checks: ['test'], assigneeId: first.id, maxRecoveryAttempts: 1, ...extra })
  return { directory, runtime, workers, owner, mission, first, second, propose }
}

const eventually = async (read, message, timeoutMs = 4000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

test('R11-01: the adapter classifier maps HTTP status and Harness codes to the closed outage vocabulary', () => {
  assert.deepEqual(classifyProviderOutage(new LlmError('payment required', 'QUOTA', { status: 402 })), { class: 'quota', status: 402, message: 'payment required' })
  assert.equal(classifyProviderOutage(new LlmError('slow down', 'RATE_LIMIT', { status: 429 }))?.class, 'rate-limit')
  assert.equal(classifyProviderOutage(new LlmError('bad gateway', 'SERVER', { status: 502 }))?.class, 'unavailable')
  assert.equal(classifyProviderOutage(new LlmError('provider is unavailable', 'PROVIDER_UNAVAILABLE'))?.class, 'unavailable')
  assert.equal(classifyProviderOutage(new LlmError('insufficient quota', 'QUOTA'))?.class, 'quota')
  assert.equal(classifyProviderOutage(Object.assign(new Error('fetch failed'), { code: 'TRANSPORT' }))?.class, 'unavailable')
  assert.equal(classifyProviderOutage(new Error('the test command failed')), undefined, 'an ordinary task failure is not an outage')
  assert.equal(classifyProviderOutage(new Error('quota exceeded for this project'))?.class, 'quota', 'provider quota wording is classified even when the adapter supplies no code')
  assert.equal(classifyProviderOutage(new Error('assertion failed in check')), undefined)
})

test('R11-01: a classified outage is durable, keeps the running attempt, and spends no recovery credit', async t => {
  const f = await fixture(t)
  const task = f.propose()
  const claimed = await f.runtime.claim({ sessionId: f.first.sessionId }, f.mission.id, task.id)
  f.workers.callbacks.providerOutage(f.first.id, { class: 'quota', status: 402, message: 'insufficient quota' })
  const outages = f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'provider/outage')
  assert.equal(outages.length, 1)
  assert.equal(outages[0].data.class, 'quota')
  assert.equal(outages[0].data.status, 402)
  assert.deepEqual(outages[0].data.taskIds, [task.id], 'the event names the affected running task')
  const member = f.runtime.store.get('members', f.first.id)
  assert.equal(member.providerOutage?.class, 'quota')
  const after = f.runtime.store.get('tasks', task.id)
  assert.equal(after.status, 'running', 'the attempt is preserved; the adapter retries it in place')
  assert.equal(after.attempt.id, claimed.attempt.id)
  assert.equal(after.recoveryCount ?? 0, 0, 'a quiescence pause spends no recovery credit')
  // One durable row and one notice per class transition, not one per retry.
  f.workers.callbacks.providerOutage(f.first.id, { class: 'quota', status: 402, message: 'insufficient quota' })
  assert.equal(f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'provider/outage').length, 1)
  f.workers.callbacks.providerOutage(f.first.id, { class: 'unavailable', status: 503, message: 'upstream down' })
  assert.equal(f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'provider/outage').length, 2, 'a new class is a new durable row')
})

test('R11-01: a start failure classified as an outage re-routes without spending credit', async t => {
  const workers = new OutageWorkers()
  const f = await fixture(t, workers)
  const task = f.propose()
  workers.failFor = f.first.id
  workers.failWith = new LlmError('insufficient quota for this account', 'QUOTA', { status: 402 })
  const routed = await eventually(() => {
    const current = f.runtime.store.get('tasks', task.id)
    return current.assigneeId === f.second.id && current.status === 'running' ? current : undefined
  }, 'the outage did not re-route the task to the live member')
  assert.equal(routed.recoveryCount ?? 0, 0, 'the outage spends no recovery credit')
  const events = f.runtime.store.events(f.mission.id, 500)
  assert.ok(events.some(event => event.type === 'provider/outage' && event.data.class === 'quota'))
  const startFailed = events.filter(event => event.type === 'task/start-failed')
  assert.ok(startFailed.length >= 1)
  assert.equal(startFailed[0].data.quiescent, true, 'the start-failure row is marked as an outage, not a member fault')
  assert.ok(events.some(event => event.type === 'task/reassigned' && event.data.to === f.second.id))
  assert.notEqual(f.runtime.store.get('members', f.first.id).status, 'stopped', 'a quiescent route stays live for a later retry')
  // Recovery clears the marker durably once the route answers again.
  workers.failFor = undefined
  const recovered = await eventually(() => f.runtime.store.events(f.mission.id, 500).find(event => event.type === 'provider/recovered'), 'the recovered route was not recorded')
  assert.equal(recovered.data.memberId, f.first.id)
  assert.equal(f.runtime.store.get('members', f.first.id).providerOutage, undefined)
})
