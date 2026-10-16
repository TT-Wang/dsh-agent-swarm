/**
 * A task's prerequisites are met only when every one is met
 * (`graph.dependenciesMet`): an accepted prerequisite never stands in for
 * another that is not. Four readers ask the rule: an owner cancel's stranded
 * dependents, the waiting classifier (`waitsLegitimately`, which decides what
 * the fall-through names), the worker step guard and a worker tool's authority
 * over its attempt (`ownAttempt`). Each test gives them a task with two
 * prerequisites, one accepted and one not met.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownerTools } from './refusal-inventory.mjs'
import { FakeClock, acceptThroughReview, setup, taskOf } from './faults/harness.mjs'

async function fixture(t) {
  const f = await setup({ clock: new FakeClock() })
  t.after(() => f.cleanup())
  return { ...f, tool: await ownerTools(f) }
}

/** One tick of the runtime clock, settled. */
async function tick(f) {
  f.clock.advance(f.runtime.config.tickMs)
  await f.runtime.tick()
  await f.runtime.settle(f.mission.id)
}

const ownerNotices = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner')

test('an owner cancel of one of two prerequisites strands the dependent although the other is accepted: the cancel names it, and the fall-through names it while its assignee holds a live lease', async t => {
  const f = await fixture(t)
  const accepted = f.propose({ title: 'Accepted prerequisite' })
  await acceptThroughReview(f, accepted)
  // The dependent's assignee holds a live lease elsewhere, which the waiting
  // classifier would read as a live wait for ready work.
  const running = f.propose({ title: 'Running work' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, running.id)
  const withdrawn = f.propose({ title: 'Withdrawn prerequisite' })
  const dependent = f.propose({ title: 'Needs both', dependencies: [accepted.id, withdrawn.id] })
  const cancelled = await f.tool('swarm_cancel', { taskId: withdrawn.id, reason: 'mistaken work' })
  assert.deepEqual(cancelled.strandedDependents, [dependent.id], 'the cancel names the dependent')
  await tick(f)
  const named = ownerNotices(f).find(delivery => /no live path will advance/.test(delivery.content))
  assert.ok(named?.subjects.includes(`${dependent.id}@0`), `the fall-through names it: ${JSON.stringify(ownerNotices(f).map(delivery => delivery.subjects))}`)
  assert.equal(taskOf(f.runtime, dependent.id).status, 'pending', 'and it stays pending for the owner to repair')
})

test('running work one of whose two prerequisites is not met, the other accepted: the guard stops its tools and submit is refused as a revoked prerequisite', async t => {
  const f = await fixture(t)
  const accepted = f.propose({ title: 'Accepted prerequisite' })
  await acceptThroughReview(f, accepted)
  const work = f.propose({ title: 'Running work' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, work.id)
  const unmet = f.propose({ title: 'Unmet prerequisite' })
  // Written as only a corrupted store holds it: a challenge that re-opens a
  // prerequisite fences its running dependents in the same commit.
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', { ...taskOf(f.runtime, work.id), dependencies: [accepted.id, unmet.id] }))
  assert.equal(f.workers.callbacks.guard(f.author.id, 'read'), 'A prerequisite was invalidated; stop work and inspect the challenge')
  await assert.rejects(f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: work.id, attemptId: claimed.attempt.id, output: 'done' }), error => error.code === 'task_prerequisite_revoked')
})
