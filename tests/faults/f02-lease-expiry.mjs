/** F2: lease expiry during an active model stream. Liveness renewal prevents expiry; if it occurs the planned assignee survives. */
import assert from 'node:assert/strict'
import { setup, eventually, events, taskOf, runScenario } from './harness.mjs'

await runScenario({
  id: 'F2', title: 'Lease expiry during a live stream renews, and a stalled stream preserves the planned assignee', invariants: ['I1', 'I2'],
  body: async () => {
    const f = await setup({ config: { leaseMs: 400 } })
    try {
      const task = f.propose()
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      // Injection 1: the adapter reports a live model operation.
      const activity = { id: 'model-op', kind: 'model', startedAt: Date.now(), updatedAt: Date.now() }
      f.workers.activity = activity
      f.workers.callbacks.activity(f.author.id, activity)
      const before = Date.now()
      const shortened = taskOf(f.runtime, task.id)
      shortened.attempt.leaseUntil = Date.now() + 10
      f.runtime.store.transaction(() => f.runtime.store.put('tasks', shortened))
      const renewed = await eventually(() => {
        const value = taskOf(f.runtime, task.id).attempt?.leaseUntil ?? 0
        return value > Date.now() + 400 ? value : undefined
      }, 'a live model stream must renew the lease')
      // src/runtime.ts renews to now + leaseMs + ceil(maxOutputTokens * LEASE_MS_PER_OUTPUT_TOKEN), LEASE_MS_PER_OUTPUT_TOKEN = 20.
      assert(renewed >= before + 400 + 5_000 * 20, 'renewal grants the full output-token allowance')
      assert.equal(events(f.runtime, f.mission.id, 'task/lease-expiring').length, 0, 'a live stream never warns about expiry')
      // Injection 2: the stream stalls, so liveness can no longer hold the lease.
      f.workers.activity = undefined
      f.workers.callbacks.activity(f.author.id, undefined)
      const stale = taskOf(f.runtime, task.id)
      stale.attempt.leaseUntil = Date.now() + 5
      f.runtime.store.transaction(() => f.runtime.store.put('tasks', stale))
      const expired = await eventually(() => {
        const current = taskOf(f.runtime, task.id)
        return current.status !== 'running' ? current : undefined
      }, 'a stalled stream must expire once')
      assert.equal(events(f.runtime, f.mission.id, 'task/lease-expiring').length, 1, 'the expiry warning fired once')
      assert.equal(events(f.runtime, f.mission.id, 'task/lease-expired').length, 1, 'the lease expired once')
      assert.equal(expired.recoveryCount, 1, 'I1: exactly one recovery credit for the expired attempt')
      assert.equal(expired.plannedAssigneeId, f.author.id, 'I2: the planned assignee survives expiry')
      assert.equal(expired.assigneeId, f.author.id, 'I2: the task is still assigned to the planned member')
      // Recovery: the planned member resumes the task.
      f.workers.autoIdle = true
      const resumed = await eventually(() => {
        const current = taskOf(f.runtime, task.id)
        return current.status === 'running' ? current : undefined
      }, 'the planned member resumes after expiry')
      assert.equal(resumed.attempt.ownerId, f.author.id, 'I2: no unplanned member ever ran the task')
      return { renewedHeadroomMs: renewed - before, attemptExpired: claimed.attempt.id, attemptResumed: resumed.attempt.id, credits: expired.recoveryCount }
    } finally { await f.cleanup() }
  },
})
