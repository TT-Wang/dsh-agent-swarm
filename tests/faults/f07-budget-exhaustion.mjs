/** F7: budget exhausted mid-round, then the ceiling is raised. The reason names the dimension and consumed work survives. */
import assert from 'node:assert/strict'
import { setup, budget as defaultBudget, eventually, events, taskOf, runScenario } from './harness.mjs'

await runScenario({
  id: 'F7', title: 'Budget exhaustion names the dimension and preserves consumed work across a raise', invariants: ['I5'],
  body: async () => {
    const f = await setup({ budget: { maxTokens: 40, maxSteps: 100 } })
    try {
      const task = f.propose()
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      // Injection: a provider usage report pushes the mission over maxTokens.
      await f.workers.callbacks.usage(f.author.id, 40)
      const exhausted = await eventually(() => {
        const mission = f.runtime.snapshot(f.owner, f.mission.id).mission
        return mission.budgetPause?.quiesced ? mission : undefined
      }, 'the exhausted mission quiesces')
      assert.match(exhausted.reason, /maxTokens/, 'I5: the reason names the exhausted dimension')
      const marker = events(f.runtime, f.mission.id, 'mission/budget-exhausted')
      assert.equal(marker.length, 1, 'the exhaustion is durable')
      assert.deepEqual(marker[0].data.dimensions, ['maxTokens'], 'the exhausted dimension is recorded exactly')
      const paused = taskOf(f.runtime, task.id)
      assert.equal(paused.status, 'running', 'I5: the in-flight attempt is preserved, not discarded')
      assert.equal(paused.attempt.id, claimed.attempt.id, 'I5: consumed work keeps its attempt')
      assert.equal(paused.budgetResume.attemptId, claimed.attempt.id, 'I5: the resume marker names the consumed attempt')
      assert.equal(paused.recoveryCount ?? 0, 0, 'a budget pause is host policy, not a recovery failure')
      assert(f.workers.stopped.includes(f.author.id), 'the exhausted mission stopped worker activity')
      const usedBefore = f.runtime.snapshot(f.owner, f.mission.id).mission.usedTokens
      assert.equal(usedBefore, 40, 'I5: consumption is preserved exactly')
      // Recovery: raise the ceiling and resume; the same attempt continues.
      f.runtime.updateBudget(f.owner, f.mission.id, { ...defaultBudget, maxTokens: 100_000, maxSteps: 500 }, 'F7: raise the exhausted ceiling')
      f.runtime.control(f.owner, f.mission.id, 'resume', 'F7: budget raised')
      const resumed = await eventually(() => events(f.runtime, f.mission.id, 'task/budget-resumed')[0], 'the preserved attempt resumes')
      assert.equal(resumed.data.attemptId, claimed.attempt.id, 'I5: the same attempt resumes, not a fresh one')
      const current = taskOf(f.runtime, task.id)
      assert.equal(current.status, 'running')
      assert.equal(current.attempt.id, claimed.attempt.id, 'I5: no recovery credit is spent on a budget resume')
      assert.equal(current.recoveryCount ?? 0, 0)
      assert.equal(f.runtime.snapshot(f.owner, f.mission.id).mission.usedTokens, usedBefore, 'I5: consumed work is not reset by the raise')
      return { dimension: marker[0].data.dimensions[0], usedTokens: usedBefore, attempt: claimed.attempt.id }
    } finally { await f.cleanup() }
  },
})
