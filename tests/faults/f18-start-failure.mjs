/**
 * F18 (R5-02): a worker-start failure is a recoverable interruption.
 *
 * Injection: after admission, every `start` of the member assigned the task
 * fails. Pre-fix the scheduler marked the member `stopped` and blocked the task
 * with zero recovery credit and no re-route, so the work was permanently
 * unschedulable. The contract asserted here is the established recovery policy:
 * exactly one recovery credit per start failure, re-pend while the limit is not
 * exhausted, and after `k` consecutive failures re-route to another capable live
 * member with a durable `task/reassigned` event.
 */
import assert from 'node:assert/strict'
import { setup, events, eventually, runScenario, taskOf } from './harness.mjs'

await runScenario({
  id: 'F18', title: 'A worker-start failure spends bounded recovery credit and re-routes after k consecutive failures', invariants: ['I18'],
  body: async () => {
    const f = await setup({ config: { tickMs: 20, maxTasksPerMember: 100 } })
    try {
      const task = f.propose({ maxRecoveryAttempts: 5 })
      f.workers.autoIdle = true
      // Injection: the assigned member's route is down after admission.
      const start = f.workers.start.bind(f.workers)
      f.workers.start = async spec => {
        if (spec.member.id === f.author.id) { f.workers.started.push(spec.member.id); throw new Error('injected provider outage at worker start') }
        return await start(spec)
      }
      const reassigned = await eventually(() => events(f.runtime, f.mission.id, 'task/reassigned')[0],
        'the task was not re-routed after k consecutive start failures')
      assert(f.workers.started.filter(id => id === f.author.id).length >= 3, 'the injected fault fired on every start attempt')
      assert.equal(reassigned.data.taskId, task.id)
      assert.equal(reassigned.data.from, f.author.id)
      assert.equal(reassigned.data.to, f.reviewer.id, 'a capable live member receives the work')
      assert.equal(reassigned.data.consecutiveFailures, 3)
      assert.match(reassigned.data.reason, /injected provider outage at worker start/)
      const current = taskOf(f.runtime, task.id)
      assert.equal(current.recoveryCount, 3, 'I18: exactly one recovery credit per start failure')
      assert.equal(current.status, 'running', 'the re-routed task is dispatched to the live member')
      assert.equal(current.attempt.ownerId, f.reviewer.id)
      assert.equal(current.assigneeId, f.reviewer.id)
      assert.equal(events(f.runtime, f.mission.id, 'task/blocked').length, 0, 'the task never blocks before its recovery limit')
      assert(events(f.runtime, f.mission.id, 'task/start-failed').length >= 3, 'every start failure emits a durable task transition')
      assert.equal(events(f.runtime, f.mission.id, 'member/resume-failed').length, 3, 'each failed start is durably reported')
      return { credits: current.recoveryCount, from: reassigned.data.from, to: reassigned.data.to, consecutiveFailures: reassigned.data.consecutiveFailures, newOwner: current.attempt.ownerId }
    } finally { await f.cleanup() }
  },
})
