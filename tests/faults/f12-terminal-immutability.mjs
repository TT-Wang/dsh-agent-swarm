/** F12: re-claim, re-submit or re-verify a terminal task is refused and the durable record is unchanged. */
import assert from 'node:assert/strict'
import { setup, acceptThroughReview, clone, events, json, runScenario, taskOf } from './harness.mjs'

await runScenario({
  id: 'F12', title: 'Terminal tasks are immutable to re-claim, re-submit, re-verify and replacement', invariants: ['I11'],
  body: async () => {
    const f = await setup()
    try {
      const accepted = f.propose({ title: 'Accepted work' })
      const review = await acceptThroughReview(f, accepted)
      const cancelled = f.propose({ title: 'Withdrawn work' })
      f.runtime.cancel(f.owner, f.mission.id, { taskId: cancelled.id, reason: 'F12: withdraw before it runs' })
      const before = {
        accepted: clone(taskOf(f.runtime, accepted.id)), review: clone(taskOf(f.runtime, review.id)), cancelled: clone(taskOf(f.runtime, cancelled.id)),
      }
      assert.equal(before.accepted.status, 'accepted')
      assert.equal(before.cancelled.status, 'cancelled')
      let refusals = 0
      const rejected = async (promise, pattern, label) => {
        refusals += 1
        await assert.rejects(promise, pattern, label)
      }
      await rejected(f.runtime.claim(f.actor(f.author), f.mission.id, accepted.id), /not ready/i, 'an accepted task cannot be re-claimed')
      await rejected(f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: accepted.id, attemptId: before.accepted.attempt?.id ?? 'terminal', output: 'late' }), /Stale|unauthorized|terminal/i, 'an accepted task cannot be re-submitted')
      await rejected(f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: before.review.attempt?.id ?? 'terminal', verdict: 'accept', reason: 'late' }), /Stale|unauthorized|terminal/i, 'an accepted review cannot be re-verified')
      await rejected(f.runtime.claim(f.actor(f.author), f.mission.id, cancelled.id), /not ready/i, 'a cancelled task cannot be re-claimed')
      await rejected(f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: cancelled.id, attemptId: 'terminal-attempt', output: 'late' }), /Stale|unauthorized|terminal/i, 'a cancelled task cannot be re-submitted')
      refusals += 1
      assert.throws(() => f.propose({ title: 'Replacement for accepted work', replaces: [accepted.id] }), /only blocked work can be replaced/, 'accepted work needs a replacement path, not a repair')
      // W12: cancellation is terminal for the withdrawn record but not for the
      // obligation; exactly one live repair restores the lineage, and a second
      // replacement is still refused.
      const repair = f.propose({ title: 'Repair for withdrawn work', replaces: [cancelled.id] })
      assert.equal(repair.status, 'pending', 'a cancelled task admits one live repair')
      assert.deepEqual(repair.replaces, [cancelled.id])
      refusals += 1
      assert.throws(() => f.propose({ title: 'Second replacement for withdrawn work', replaces: [cancelled.id] }), /already replaced by/, 'only one live repair per cancelled task')
      assert.deepEqual(json(taskOf(f.runtime, accepted.id)), json(before.accepted), 'I11: the accepted record is byte-for-byte unchanged')
      assert.deepEqual(json(taskOf(f.runtime, review.id)), json(before.review), 'I11: the accepted review record is unchanged')
      assert.deepEqual(json(taskOf(f.runtime, cancelled.id)), json(before.cancelled), 'I11: the cancelled record is unchanged')
      assert.equal(events(f.runtime, f.mission.id, 'task/submitted').length, 1, 'no late submission is recorded')
      assert.equal(events(f.runtime, f.mission.id, 'task/accepted').length, 1, 'no late acceptance is recorded')
      assert.equal(events(f.runtime, f.mission.id, 'task/cancelled').length, 1, 'no late cancellation is recorded')
      return { refusals, accepted: accepted.id, cancelled: cancelled.id }
    } finally { await f.cleanup() }
  },
})
