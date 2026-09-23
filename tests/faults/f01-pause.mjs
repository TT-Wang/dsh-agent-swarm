/**
 * F1: owner pauses mid-attempt, then resumes. The task re-pends without spending a recovery credit.
 *
 * Since 69211b9 a pause fences the attempt through the stop barrier: the task is
 * `blocked` with a stop marker until the old handle's stop is confirmed, and only
 * that confirmation re-pends it (design.md, "Task quiescence lives on
 * `Task.resumeAfterStop`"). The old handle's stop is held on a gate, so a
 * barrier that re-pends before the stop settles, or stops the handle only
 * after the re-pend, leaves the task pending while the gate is still closed.
 */
import assert from 'node:assert/strict'
import { setup, eventually, events, taskOf, runScenario } from './harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

await runScenario({
  id: 'F1', title: 'Owner pause mid-attempt re-pends without spending a recovery credit', invariants: ['I1', 'I2'],
  body: async () => {
    const f = await setup()
    let release
    const gate = new Promise(resolve => { release = resolve })
    try {
      const planned = f.author
      const task = f.propose()
      const claimed = await f.runtime.claim(f.actor(planned), f.mission.id, task.id)
      assert.equal(claimed.status, 'running', 'the attempt is live before the fault')
      const attemptA = claimed.attempt.id
      const creditsBefore = taskOf(f.runtime, task.id).recoveryCount ?? 0
      // The old handle's stop settles only when the gate opens; every stop is recorded.
      const stops = []
      f.workers.stop = async id => {
        const stop = { id, settled: false }
        stops.push(stop)
        if (id === planned.id) await gate
        stop.settled = true
        f.workers.stopped.push(id)
      }
      // Injection: the owner pauses while the attempt is running.
      f.runtime.control(f.owner, f.mission.id, 'pause', 'F1: owner pauses mid-attempt')
      const fenced = taskOf(f.runtime, task.id)
      assert.equal(fenced.attempt, undefined, 'the paused attempt is fenced')
      assert.equal(fenced.epoch, claimed.epoch + 1, 'the epoch fences the interrupted attempt')
      assert.deepEqual(fenced.resumeAfterStop && { epoch: fenced.resumeAfterStop.epoch, memberId: fenced.resumeAfterStop.memberId }, { epoch: fenced.epoch, memberId: planned.id }, 'the fence owes the old handle a stop')
      await eventually(() => stops.some(stop => stop.id === planned.id), 'the old handle is stopped')
      await sleep(100) // many ticks while the old handle's stop is unconfirmed
      const held = taskOf(f.runtime, task.id)
      assert.equal(held.status, 'blocked', 'the task stays fenced while the old handle\'s stop is unconfirmed')
      assert.equal(held.resumeAfterStop?.epoch, fenced.epoch, 'the stop marker holds the fenced epoch until the stop is confirmed')
      assert.equal(events(f.runtime, f.mission.id, 'task/handoff-ready').length, 0, 'nothing releases the task before the stop is confirmed')
      const seqAtRelease = f.runtime.store.events(f.mission.id, 1).at(-1).seq
      release()
      const paused = await eventually(() => {
        const current = taskOf(f.runtime, task.id)
        return current.status === 'pending' ? current : undefined
      }, 'the paused task re-pends once the old handle has stopped')
      const [ready] = events(f.runtime, f.mission.id, 'task/handoff-ready').filter(event => event.data.taskId === task.id)
      assert(ready && ready.seq > seqAtRelease && ready.data.memberId === planned.id, 'the re-pend follows the confirmed stop of the old handle')
      assert(stops.filter(stop => stop.id === planned.id).every(stop => stop.settled), 'every stop of the old handle settled')
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
      assert.equal(resumed.attempt.ownerId, planned.id, 'I2: the planned assignee survives the pause')
      assert.equal(resumed.assigneeId, planned.id)
      assert.equal(resumed.recoveryCount ?? 0, creditsBefore, 'I1: resume spends no recovery credit')
      assert.equal(events(f.runtime, f.mission.id, 'task/claimed').length, 2, 'a fresh claim follows the resume')
      return { attemptFenced: attemptA, attemptResumed: resumed.attempt.id, credits: resumed.recoveryCount ?? 0, releasedAtSeq: ready.seq }
    } finally { release(); await f.cleanup() }
  },
})
