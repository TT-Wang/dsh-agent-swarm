/**
 * F1: owner pauses mid-attempt, then resumes. The task re-pends without spending a recovery credit.
 *
 * Since 69211b9 a pause fences the attempt through the stop barrier: the task is
 * `blocked` with a stop marker until the old handle's stop is confirmed, and only
 * that confirmation re-pends it (design.md, "Task quiescence lives on
 * `Task.resumeAfterStop`").
 */
import assert from 'node:assert/strict'
import { setup, eventually, events, taskOf, runScenario } from './harness.mjs'

await runScenario({
  id: 'F1', title: 'Owner pause mid-attempt re-pends without spending a recovery credit', invariants: ['I1', 'I2'],
  body: async () => {
    const f = await setup()
    try {
      const task = f.propose()
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      assert.equal(claimed.status, 'running', 'the attempt is live before the fault')
      const attemptA = claimed.attempt.id
      const creditsBefore = taskOf(f.runtime, task.id).recoveryCount ?? 0
      // Injection: the owner pauses while the attempt is running.
      f.runtime.control(f.owner, f.mission.id, 'pause', 'F1: owner pauses mid-attempt')
      const fenced = taskOf(f.runtime, task.id)
      assert.equal(fenced.attempt, undefined, 'the paused attempt is fenced')
      assert.equal(fenced.epoch, claimed.epoch + 1, 'the epoch fences the interrupted attempt')
      assert.deepEqual(fenced.resumeAfterStop && { epoch: fenced.resumeAfterStop.epoch, memberId: fenced.resumeAfterStop.memberId }, { epoch: fenced.epoch, memberId: f.author.id }, 'the fence owes the old handle a stop')
      const paused = await eventually(() => {
        const current = taskOf(f.runtime, task.id)
        return current.status === 'pending' ? current : undefined
      }, 'the paused task re-pends once the old handle has stopped')
      assert(f.workers.stopped.includes(f.author.id), 'the re-pend follows a confirmed stop of the old handle')
      assert.equal(paused.resumeAfterStop, undefined, 'the stop marker is released')
      assert.equal(paused.epoch, claimed.epoch + 1, 'the barrier keeps the fenced epoch')
      assert.equal(paused.recoveryCount ?? 0, creditsBefore, 'I1: pause spends no recovery credit')
      assert.equal(events(f.runtime, f.mission.id, 'mission/pause').length, 1, 'the pause is durable')
      assert.equal(events(f.runtime, f.mission.id, 'task/claimed').length, 1, 'the interrupted claim is preserved')
      // Recovery: resume re-claims the same task on the planned member.
      f.workers.autoIdle = true
      f.runtime.control(f.owner, f.mission.id, 'resume', 'F1: fault cleared')
      const resumed = await eventually(() => {
        const current = taskOf(f.runtime, task.id)
        return current.status === 'running' && current.attempt?.id !== attemptA ? current : undefined
      }, 'the task is re-claimed after resume')
      assert.equal(resumed.attempt.ownerId, f.author.id, 'I2: the planned assignee survives the pause')
      assert.equal(resumed.assigneeId, f.author.id)
      assert.equal(resumed.recoveryCount ?? 0, creditsBefore, 'I1: resume spends no recovery credit')
      assert.equal(events(f.runtime, f.mission.id, 'task/claimed').length, 2, 'a fresh claim follows the resume')
      return { attemptFenced: attemptA, attemptResumed: resumed.attempt.id, credits: resumed.recoveryCount ?? 0 }
    } finally { await f.cleanup() }
  },
})
