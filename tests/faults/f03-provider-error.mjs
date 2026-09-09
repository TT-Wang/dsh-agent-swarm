/** F3: provider error during a worker turn. Retry stays in the same epoch; no duplicate artifact ref. */
import assert from 'node:assert/strict'
import { setup, eventually, events, taskOf, runScenario } from './harness.mjs'

await runScenario({
  id: 'F3', title: 'Provider error retries inside the same epoch without a duplicate artifact', invariants: ['I1', 'I3'],
  body: async () => {
    const f = await setup()
    try {
      const task = f.propose()
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      const creditsBefore = taskOf(f.runtime, task.id).recoveryCount ?? 0
      const epochBefore = taskOf(f.runtime, task.id).epoch
      // Injection: the adapter reports a provider error for this live attempt.
      await f.workers.callbacks.failure(f.author.id, 'provider stream failed: injected F3 error')
      const failure = events(f.runtime, f.mission.id, 'member/failure')
      assert.equal(failure.length, 1, 'the injected provider error is durably recorded')
      assert.match(failure[0].data.error, /injected F3 error/)
      const afterFailure = taskOf(f.runtime, task.id)
      assert.equal(afterFailure.status, 'running', 'I1: the attempt survives the provider error')
      assert.equal(afterFailure.attempt.id, claimed.attempt.id, 'I1: the same attempt is retried')
      assert.equal(afterFailure.epoch, epochBefore, 'I1: no new epoch is spent on a provider error')
      assert.equal(afterFailure.recoveryCount ?? 0, creditsBefore, 'I1: recoveryCount is unchanged')
      assert.equal(afterFailure.artifact, undefined, 'I3: no partial artifact is trusted')
      // R11-01: the adapter's classified outage callback records a typed durable
      // event and still spends no recovery credit on the quiescence pause.
      f.workers.callbacks.providerOutage(f.author.id, { class: 'unavailable', status: 503, message: 'provider unavailable: injected F3 outage' })
      const outage = events(f.runtime, f.mission.id, 'provider/outage')
      assert.equal(outage.length, 1, 'the classified outage is durably recorded as its own typed event')
      assert.equal(outage[0].data.class, 'unavailable')
      assert.equal(outage[0].data.status, 503)
      assert.deepEqual(outage[0].data.taskIds, [task.id], 'the outage names the running task it affects')
      const afterOutage = taskOf(f.runtime, task.id)
      assert.equal(afterOutage.status, 'running', 'I1: the quiescence pause preserves the attempt')
      assert.equal(afterOutage.attempt.id, claimed.attempt.id, 'I1: the same attempt is retried after the outage')
      assert.equal(afterOutage.recoveryCount ?? 0, creditsBefore, 'I1: a provider outage spends no recovery credit')
      // Recovery: the retry continues the same attempt and captures one artifact.
      await f.workers.callbacks.toolRun(f.author.id, { tool: 'bash', arguments: { command: 'true' }, result: { exitCode: 0, output: '' }, isError: false })
      const submitted = await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'recovered after the provider error' })
      assert.equal(submitted.status, 'submitted')
      assert.equal(events(f.runtime, f.mission.id, 'task/submitted').length, 1, 'I3: exactly one artifact reference is published')
      assert.equal(f.workers.captured.length, 1, 'the artifact is captured once')
      assert.equal(f.workers.captured[0].attemptId, claimed.attempt.id, 'the artifact belongs to the retried attempt')
      return { attempt: claimed.attempt.id, epoch: epochBefore, credits: creditsBefore, captures: f.workers.captured.length }
    } finally { await f.cleanup() }
  },
})
