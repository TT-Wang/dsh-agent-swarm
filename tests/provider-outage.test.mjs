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
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { classifyProviderOutage } from '../lib/scheduler.js'
import { FakeWorkers, eventually, makeRuntime } from './faults/harness.mjs'

class OutageWorkers extends FakeWorkers {
  autoIdle = true
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  checks = []
  failFor
  failWith
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start(spec) {
    if (spec.member.id === this.failFor) throw this.failWith ?? Object.assign(new Error('provider unavailable'), { status: 503 })
    this.started.push(spec.member.id)
  }
}

async function fixture(t, workers = new OutageWorkers()) {
  // The runtime clock can be moved past a provider outage window (5 min).
  const clock = { skew: 0 }
  const { dir: directory, runtime, budget } = await makeRuntime(t, { workers,
    config: { maxMessageChars: 10000, maxEvents: 500, checkTimeoutMs: undefined, now: () => Date.now() + clock.skew },
    budget: { maxTokens: 100000, maxSteps: 1000, maxDurationMs: 3600000, maxTasks: 100 } })
  await runtime.start()
  const owner = { sessionId: 'outage-owner' }
  const mission = runtime.create(owner, { title: 'Outage', objective: 'Route around a provider outage', workspace: '/source', scope: ['**'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const first = await runtime.addMember(owner, mission.id, { name: 'First', role: 'implementation' })
  const second = await runtime.addMember(owner, mission.id, { name: 'Second', role: 'implementation' })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Work', objective: 'Work', kind: 'implementation',
    scope: ['**'], acceptance: ['works'], checks: ['test'], assigneeId: first.id, maxRecoveryAttempts: 1, ...extra })
  return { directory, runtime, workers, owner, mission, first, second, propose, clock }
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
  }, 'the outage did not re-route the task to the live member', 4000)
  assert.equal(routed.recoveryCount ?? 0, 0, 'the outage spends no recovery credit')
  const events = f.runtime.store.events(f.mission.id, 500)
  assert.ok(events.some(event => event.type === 'provider/outage' && event.data.class === 'quota'))
  const startFailed = events.filter(event => event.type === 'task/start-failed')
  assert.ok(startFailed.length >= 1)
  assert.equal(startFailed[0].data.quiescent, true, 'the start-failure row is marked as an outage, not a member fault')
  assert.ok(events.some(event => event.type === 'task/reassigned' && event.data.to === f.second.id))
  assert.notEqual(f.runtime.store.get('members', f.first.id).status, 'stopped', 'a quiescent route stays live for a later retry')
  // Recovery clears the marker durably once the route answers again. A route
  // inside its outage window is probed once per window, so move past it.
  workers.failFor = undefined
  f.clock.skew += 5 * 60_000 + 1
  const recovered = await eventually(() => f.runtime.store.events(f.mission.id, 500).find(event => event.type === 'provider/recovered'), 'the recovered route was not recorded', 4000)
  assert.equal(recovered.data.memberId, f.first.id)
  assert.equal(f.runtime.store.get('members', f.first.id).providerOutage, undefined)
})
