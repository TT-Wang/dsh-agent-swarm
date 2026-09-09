/** F11: owner cancels a pending and a running duplicate replacement; terminal cancelled, member freed, lineage resolves to the survivor. */
import assert from 'node:assert/strict'
import { setup, blockThroughReview, acceptThroughReview, clone, events, eventually, runScenario, taskOf, MISSION_ACCEPTANCE } from './harness.mjs'

await runScenario({
  id: 'F11', title: 'Owner cancel withdraws pending and running replacements and frees the member', invariants: ['I10', 'I6'],
  body: async () => {
    const f = await setup()
    const g = await setup({ config: { leaseMs: 100 } })
    try {
      const task = f.propose()
      await blockThroughReview(f, task)
      const survivor = f.propose({ title: 'Surviving repair', replaces: [task.id] })
      // Imported duplicate history: a second live replacement exists (the state
      // the pre-fix admission allowed), so lineage must pick one deterministically.
      const duplicate = {
        id: 'imported_duplicate', missionId: f.mission.id, workstreamId: f.stream.id, title: 'Duplicate replacement', objective: 'Imported duplicate',
        kind: 'implementation', dependencies: [], scope: ['**'], acceptance: clone(MISSION_ACCEPTANCE), checks: ['true'], status: 'pending', priority: 0,
        experiment: false, epoch: 0, evidenceIds: [], replaces: [task.id], createdAt: Date.now() + 1, assigneeId: f.author.id,
      }
      f.runtime.store.transaction(() => f.runtime.store.put('tasks', duplicate))
      // The author has ended its turn since submitting the blocked work.
      f.workers.callbacks.idle(f.author.id)
      assert.equal(f.runtime.store.get('members', f.author.id).status, 'idle', 'the author is idle before the withdrawal')
      const liveBefore = f.runtime.snapshot(f.owner, f.mission.id).tasks.filter(item => item.replaces?.includes(task.id) && item.status !== 'cancelled')
      assert.equal(liveBefore.length, 2, 'the injected duplicate replacement exists')
      assert.deepEqual(f.runtime.lineage(f.mission.id, task.id).map(item => item.id), [task.id, survivor.id], 'lineage is deterministic even with imported duplicates')
      // Cancel the pending duplicate.
      const cancelledPending = f.runtime.cancel(f.owner, f.mission.id, { taskId: duplicate.id, reason: 'F11: withdraw the duplicate pending replacement' })
      assert.equal(cancelledPending.status, 'cancelled')
      const pendingEvent = events(f.runtime, f.mission.id, 'task/cancelled').at(-1)
      assert.equal(pendingEvent.data.taskId, duplicate.id)
      assert.equal(pendingEvent.data.previousStatus, 'pending')
      assert.equal(f.runtime.store.get('members', f.author.id).status, 'idle', 'I10: the member is freed')
      assert.deepEqual(f.runtime.lineage(f.mission.id, task.id).map(item => item.id), [task.id, survivor.id], 'I6: lineage resolves to the surviving replacement')
      // Replay is idempotent: a cancelled task is never re-audited.
      const replay = f.runtime.cancel(f.owner, f.mission.id, { taskId: duplicate.id, reason: 'F11 replay' })
      assert.equal(replay.status, 'cancelled')
      assert.equal(events(f.runtime, f.mission.id, 'task/cancelled').length, 1, 'I10: the withdrawal is audited exactly once')
      // Cancel a running replacement.
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, survivor.id)
      assert.equal(taskOf(f.runtime, survivor.id).status, 'running')
      const cancelledRunning = f.runtime.cancel(f.owner, f.mission.id, { taskId: survivor.id, reason: 'F11: withdraw the running replacement' })
      assert.equal(cancelledRunning.status, 'cancelled')
      assert.equal(cancelledRunning.attempt, undefined, 'I10: the running attempt is released immediately')
      const runningEvent = events(f.runtime, f.mission.id, 'task/cancelled').at(-1)
      assert.equal(runningEvent.data.previousStatus, 'running')
      assert.equal(runningEvent.data.attemptId, claimed.attempt.id)
      assert.equal(runningEvent.data.ownerId, f.author.id)
      assert.equal(f.runtime.store.get('members', f.author.id).status, 'idle', 'I10: the running member is freed')
      await eventually(() => f.workers.stopped.includes(f.author.id), 'the withdrawn worker handle is stopped')
      assert.throws(() => f.propose({ title: 'Dependent on withdrawn work', dependencies: [task.id] }), /no live replacement/, 'I6: dependents are not stalled on a phantom replacement')
      // Accepted work is immutable and needs a replacement instead.
      const accepted = f.propose({ title: 'Accepted work' })
      await acceptThroughReview(f, accepted)
      assert.throws(() => f.runtime.cancel(f.owner, f.mission.id, { taskId: accepted.id, reason: 'F11: too late' }), /accepted; accepted work is immutable/, 'I10: withdrawal refuses accepted work')
      // Race injection: owner cancel lands while the lease-expiry checkpoint is in flight.
      const raced = g.propose()
      const racedClaim = await g.runtime.claim(g.actor(g.author), g.mission.id, raced.id)
      let releaseCapture
      g.workers.captureGate = () => new Promise(resolve => { releaseCapture = resolve })
      g.workers.idle.add(g.author.id)
      const stale = taskOf(g.runtime, raced.id)
      stale.attempt.leaseUntil = Date.now() + 1
      g.runtime.store.transaction(() => g.runtime.store.put('tasks', stale))
      await eventually(() => g.workers.captured.length >= 1, 'the lease-expiry checkpoint is in flight')
      g.runtime.cancel(g.owner, g.mission.id, { taskId: raced.id, reason: 'F11: cancel during the lease-expiry checkpoint' })
      releaseCapture()
      await eventually(() => events(g.runtime, g.mission.id, 'task/cancelled').length === 1, 'the racing cancel is durable')
      await new Promise(resolve => setTimeout(resolve, 200))
      const racedFinal = taskOf(g.runtime, raced.id)
      assert.equal(racedFinal.status, 'cancelled', 'the cancel wins the race')
      assert.equal(racedFinal.attempt, undefined)
      assert.equal(racedFinal.checkpoint, undefined, 'a cancelled task never gains a recovery checkpoint')
      assert.equal(events(g.runtime, g.mission.id, 'task/lease-expired').length, 0, 'no lease-expired after cancel')
      assert.equal(events(g.runtime, g.mission.id, 'task/checkpointed').length, 0, 'the late checkpoint is not recorded')
      assert.equal(events(g.runtime, g.mission.id, 'task/claimed').length, 1, 'no re-claim after cancel')
      return {
        cancelledPending: duplicate.id, cancelledRunning: survivor.id, racedAttempt: racedClaim.attempt.id,
        cancelledEvents: events(f.runtime, f.mission.id, 'task/cancelled').length, stopped: f.workers.stopped.length,
      }
    } finally { await f.cleanup(); await g.cleanup() }
  },
})
