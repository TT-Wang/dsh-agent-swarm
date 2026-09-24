/** O5: a live model stream is lease liveness with output-token headroom; a stale activity is not. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWorkers, eventually, makeRuntime } from './faults/harness.mjs'

test('a live model stream renews the lease with output-token headroom; a stale activity expires once', async t => {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, {
    workers: new FakeWorkers({ artifact: { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] }, checks: [] }),
    config: { leaseMs: 400, maxEvents: 100, checkTimeoutMs: undefined },
    budget: { maxTokens: 10000, maxSteps: 100, maxTasks: 20, maxExperiments: 2 },
  })
  await runtime.start()
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Live', objective: 'Keep the lease', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Keep the lease' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5000 })
  const actor = { sessionId: member.sessionId }
  const task = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Stream', objective: 'Long generation', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: member.id })
  await runtime.claim(actor, mission.id, task.id)

  const activity = { id: 'model-op', kind: 'model', startedAt: Date.now(), updatedAt: Date.now() }
  workers.reportActivity(member.id, activity)
  const before = Date.now()
  const stored = runtime.store.get('tasks', task.id)
  stored.attempt.leaseUntil = Date.now() + 10
  runtime.store.transaction(() => runtime.store.put('tasks', stored))
  const renewed = await eventually(() => {
    const value = runtime.store.get('tasks', task.id).attempt?.leaseUntil ?? 0
    return value > Date.now() + 400 ? value : undefined
  }, 'a live model stream must renew the lease', 2500)
  assert(renewed >= before + 400 + Math.floor(5000 * 20 * 0.5), 'the renewal scales with maxOutputTokens')
  assert.equal(runtime.store.events(mission.id, 100).some(event => event.type === 'task/lease-expiring'), false)

  // The adapter no longer reports the operation: renewal stops, one warning is emitted, then expiry.
  workers.activity = undefined
  const shortened = runtime.store.get('tasks', task.id)
  shortened.attempt.leaseUntil = Date.now() + 5
  runtime.store.transaction(() => runtime.store.put('tasks', shortened))
  await eventually(() => runtime.store.get('tasks', task.id).status !== 'running', 'a stale activity must not keep the lease alive', 2500)
  assert.equal(runtime.store.get('tasks', task.id).attempt, undefined)
  assert.equal(runtime.store.get('tasks', task.id).recoveryCount, 1)
  assert.equal(runtime.store.events(mission.id, 100).filter(event => event.type === 'task/lease-expiring').length, 1)
})
