/**
 * The completion refusal's last branch: a live dispute holds an otherwise
 * complete mission open (`completionError`, src/board.ts).
 *
 * Through the tools this branch is reached only by a claim of completion-exempt
 * work. A challenge re-opens accepted work (`submitted`, so the unfinished-work
 * branch answers first), and the verdict that accepts it again verifies every
 * current claim, so the dispute ends with it; a claim of cancelled work, or one a
 * rework archived, never blocks. A blocked optional experiment is the work whose
 * claims outlive it: its block holds nothing open, and a challenge of its claim
 * changes no task status.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeClock, acceptThroughReview, setup } from './faults/harness.mjs'
import { ownerTools } from './refusal-inventory.mjs'

/** An otherwise complete mission whose blocked optional experiment published a claim the reviewer then challenged. */
async function challengedExperiment(t) {
  const f = await setup({ clock: new FakeClock(), budget: { maxExperiments: 1 } })
  t.after(f.cleanup)
  const { runtime, mission } = f
  await acceptThroughReview(f, f.propose())
  const experiment = f.propose({ title: 'Optional experiment', objective: 'Explore a non-required alternative', kind: 'research',
    experiment: true, covers: undefined, acceptance: ['Explore an optional hypothesis'], maxSteps: 1 })
  const claimed = await runtime.claim(f.actor(f.author), mission.id, experiment.id)
  const runId = await f.workers.callbacks.toolRun(f.author.id, { tool: 'read_file', arguments: { path: 'notes.md' }, result: 'Partial experimental result', isError: false })
  const claim = runtime.publish(f.actor(f.author), mission.id, { taskId: experiment.id, attemptId: claimed.attempt.id,
    claim: 'The alternative holds', outcome: 'supported', toolRunIds: [runId] })
  // The step ceiling blocks the experiment; its stop settles on the mission queue.
  await f.workers.callbacks.beforeStep(f.author.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.author.id), false, 'the experiment meets its step ceiling')
  await runtime.settle(mission.id)
  assert.equal(runtime.store.get('tasks', experiment.id).status, 'blocked')
  assert.deepEqual(runtime.snapshot(f.owner, mission.id).completion, { eligible: true }, 'a blocked optional experiment holds no completion open')

  runtime.challenge(f.actor(f.reviewer), mission.id, { evidenceId: claim.id, reason: 'The partial result does not hold', toolRunIds: [] })
  assert.equal(runtime.store.get('evidence', claim.id).status, 'challenged')
  assert.equal(runtime.store.get('tasks', experiment.id).status, 'blocked', 'the challenge re-opens no task')
  return { f, experiment, claim }
}

test('an open challenge of a blocked optional experiment\'s claim is the one reason an otherwise complete mission cannot complete', async t => {
  const { f: { runtime, mission, owner }, claim } = await challengedExperiment(t)
  const reason = `Unresolved evidence challenges prevent completion: ${claim.id}`
  assert.deepEqual(runtime.snapshot(owner, mission.id).completion, { eligible: false, reason }, 'the open dispute is the completion refusal')
  assert.throws(() => runtime.control(owner, mission.id, 'complete', 'Every required task is accepted'),
    error => error.code === 'mission_completion_pending' && error.message === reason)
  assert.equal(runtime.store.get('missions', mission.id).status, 'active', 'the refused completion leaves the mission active')
})

test('a challenged claim of work the owner cancelled holds nothing open: after swarm_cancel the mission completes', async t => {
  const { f, experiment, claim } = await challengedExperiment(t)
  const { runtime, mission, owner } = f
  const tool = await ownerTools(f)
  await tool('swarm_cancel', { taskId: experiment.id, reason: 'Withdraw the optional experiment whose claim is disputed' })
  assert.equal(runtime.store.get('tasks', experiment.id).status, 'cancelled')
  assert.equal(runtime.store.get('evidence', claim.id).status, 'challenged', 'the cancellation resolves no dispute itself')
  assert.deepEqual(runtime.snapshot(owner, mission.id).completion, { eligible: true }, 'a claim of cancelled work no longer supports any result, so its dispute blocks nothing')
  await tool('swarm_control', { action: 'complete', reason: 'Every required task is accepted' })
  assert.equal(runtime.store.get('missions', mission.id).status, 'completed', 'the owner completes the mission')
})
