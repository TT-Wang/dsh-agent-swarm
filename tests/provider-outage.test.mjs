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
import { PROVIDER_OUTAGE_WINDOW_MS } from '../lib/types.js'
import { FakeClock, FakeWorkers, eventually, makeRuntime } from './faults/harness.mjs'

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
  const mission = runtime.create(owner, { title: 'Outage', objective: 'Route around a provider outage', workspace: directory, scope: ['**'], acceptance: ['works'], budget }, { grantRoot: directory, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const first = await runtime.addMember(owner, mission.id, { name: 'First', role: 'implementation' })
  const second = await runtime.addMember(owner, mission.id, { name: 'Second', role: 'implementation' })
  // The members' starts re-validate the workspace on disk; their passes settle before a test claims by hand.
  await runtime.settle(mission.id)
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

test('R11-01: a reroute that passes over a name-first candidate inside its outage window takes the first live candidate in store order', async t => {
  const clock = new FakeClock()
  const workers = new OutageWorkers()
  const { dir: directory, runtime, budget } = await makeRuntime(t, { workers, clock,
    config: { maxMessageChars: 10000, maxEvents: 500, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100 } })
  await runtime.start()
  const owner = { sessionId: 'outage-owner' }
  const mission = runtime.create(owner, { title: 'Outage', objective: 'Route around a provider outage', workspace: directory, scope: ['**'], acceptance: ['works'], budget }, { grantRoot: directory, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const failing = await runtime.addMember(owner, mission.id, { name: 'Failing', role: 'implementation' })
  // Store order (Cat, Bob, Amy) is the reverse of name order.
  const cat = await runtime.addMember(owner, mission.id, { name: 'Cat', role: 'implementation' })
  const bob = await runtime.addMember(owner, mission.id, { name: 'Bob', role: 'implementation' })
  const amy = await runtime.addMember(owner, mission.id, { name: 'Amy', role: 'implementation' })
  await runtime.settle(mission.id)
  // Amy, the first candidate by name, is inside her outage window when the
  // failing route's start is classified as an outage.
  workers.callbacks.providerOutage(amy.id, { class: 'quota', status: 402, message: 'insufficient quota' })
  workers.failFor = failing.id
  workers.failWith = new LlmError('insufficient quota for this account', 'QUOTA', { status: 402 })
  const task = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Work', objective: 'Work', kind: 'implementation',
    scope: ['**'], acceptance: ['works'], checks: ['test'], assigneeId: failing.id, maxRecoveryAttempts: 1 })
  await runtime.settle(mission.id)
  const reassigned = runtime.store.events(mission.id, 500).filter(event => event.type === 'task/reassigned')
  assert.deepEqual(reassigned.map(event => [event.data.from, event.data.to]), [[failing.id, cat.id]],
    `the work moved to Cat, first in store order outside an outage window, not to Bob, first by name (${JSON.stringify({ cat: cat.id, bob: bob.id, amy: amy.id })})`)
  assert.equal(runtime.store.get('tasks', task.id).assigneeId, cat.id)
})

/**
 * One native session per member, as the Harness adapter keeps it: a start of a
 * member whose session is running adopts it and resolves true, opening nothing,
 * so the outage the member's provider reported stays recorded.
 */
class ResidentWorkers extends OutageWorkers {
  sessions = new Set()
  /** A member's next start throws this error once. */
  nextStartFault = new Map()
  async start(spec) {
    if (spec.member.id === this.failFor) throw this.failWith
    const fault = this.nextStartFault.get(spec.member.id)
    if (fault !== undefined) { this.nextStartFault.delete(spec.member.id); throw fault }
    this.started.push(spec.member.id)
    const adopted = this.sessions.has(spec.member.id)
    this.sessions.add(spec.member.id)
    return adopted
  }
}

test('R11-01: a recorded outage quiets its route only inside its window: past it, re-routed work takes the member and its start failure is counted', async t => {
  const clock = new FakeClock()
  const workers = new ResidentWorkers()
  const { dir: directory, runtime, budget } = await makeRuntime(t, { workers, clock,
    config: { maxMessageChars: 10000, maxEvents: 500, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100 } })
  await runtime.start()
  const owner = { sessionId: 'outage-owner' }
  const mission = runtime.create(owner, { title: 'Outage', objective: 'Route around a provider outage', workspace: directory, scope: ['**'], acceptance: ['works'], budget }, { grantRoot: directory, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const failing = await runtime.addMember(owner, mission.id, { name: 'Failing', role: 'implementation' })
  // Store order (Cat, Bob, Amy) is the reverse of name order.
  const cat = await runtime.addMember(owner, mission.id, { name: 'Cat', role: 'implementation' })
  const bob = await runtime.addMember(owner, mission.id, { name: 'Bob', role: 'implementation' })
  const amy = await runtime.addMember(owner, mission.id, { name: 'Amy', role: 'implementation' })
  await runtime.settle(mission.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  const ids = JSON.stringify({ cat: cat.id, bob: bob.id, amy: amy.id })

  // Amy's provider reports an outage while her session runs. The passes after
  // its window adopt her session, so the outage stays recorded past the window.
  workers.callbacks.providerOutage(amy.id, { class: 'rate-limit', status: 429, message: 'Rate limit reached for requests' })
  const startsOfAmy = () => workers.started.filter(id => id === amy.id).length
  const before = startsOfAmy()
  clock.advance(PROVIDER_OUTAGE_WINDOW_MS + 1)
  await runtime.tick()
  await runtime.settle(mission.id)
  assert.ok(startsOfAmy() > before, 'a pass past the window started Amy, adopting her running session')
  assert.equal(runtime.store.get('members', amy.id).providerOutage?.class, 'rate-limit', 'an adopting start leaves the outage recorded')
  assert.deepEqual(events('provider/recovered'), [], 'and records no recovery')

  // Work leaving a route in its own outage goes to Amy, first by name: past
  // her window her recorded outage no longer makes her the last resort.
  workers.failFor = failing.id
  workers.failWith = new LlmError('insufficient quota for this account', 'QUOTA', { status: 402 })
  const task = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Work', objective: 'Work', kind: 'implementation',
    scope: ['**'], acceptance: ['works'], checks: ['test'], assigneeId: failing.id, maxRecoveryAttempts: 1 })
  await runtime.settle(mission.id)
  assert.deepEqual(events('task/reassigned').map(event => [event.data.from, event.data.to]), [[failing.id, amy.id]], `the work moved to Amy, not past her (${ids})`)
  assert.equal(runtime.store.get('tasks', task.id).assigneeId, amy.id)

  // Amy's next start fails with an ordinary error. Past her window it is her
  // failure, not the outage: counted, the owner told failure 1 of 3, and the
  // work kept on her route below the retirement bound.
  workers.nextStartFault.set(amy.id, new Error('worker bootstrap failed for Amy'))
  await runtime.tick()
  await runtime.settle(mission.id)
  const failed = events('member/resume-failed').filter(event => event.data.memberId === amy.id)
  assert.deepEqual(failed.map(event => [event.data.consecutiveFailures, event.data.outage]), [[1, undefined]], 'the failure is counted, not read as the recorded outage')
  assert.equal(runtime.store.get('members', amy.id).startFailures, 1)
  assert.deepEqual(events('task/start-failed').filter(event => event.data.taskId === task.id && /bootstrap/.test(event.data.reason)).map(event => event.data.quiescent), [false])
  assert.ok(runtime.store.list('deliveries', mission.id).some(delivery => /Amy could not start \(failure 1 of 3\)/.test(delivery.content)), 'the owner is told the counted failure')
  assert.equal(runtime.store.get('tasks', task.id).assigneeId, amy.id, 'a counted failure below the bound keeps the work on the route')
})
