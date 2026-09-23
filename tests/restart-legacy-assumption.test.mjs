/**
 * R12-F9 across a build boundary. The dependency-assumption guard refuses
 * where a dependency set is written and dispatch reads no prose, but the build
 * before it (d81a3fb) let the owner amend a task that resumes from prior work
 * to `dependencies: []` and relied on a dispatch-time backstop. A row it stored
 * that way must not be prepared from the bare mission baseline when this build
 * reopens the store: the open holds it and asks the owner once.
 *
 * Pre-fix head (5347f5b): the reopened row is dispatched and prepared with no
 * escalation at all.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { tempDirectory } from './temp-root.mjs'
import { FakeWorkers, SwarmRuntime, eventually } from './faults/harness.mjs'

const budget = { maxTokens: 500_000, maxSteps: 500, maxWorkers: 3, maxDurationMs: 600_000, maxTasks: 30, maxExperiments: 0 }
const RESUMES = 'Resume from your own artifact `09883f3` and finish the guard.'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The first host writes the store; the injected rows are what d81a3fb's amendment left. */
async function legacyStore(dir) {
  const config = { statePath: join(dir, 'swarm.sqlite'), leaseMs: 60_000, tickMs: 60_000, maxMessageChars: 16_000, maxEvents: 5_000, maxTasksPerMember: 3, checkTimeoutMs: 30_000 }
  const runtime = new SwarmRuntime(config, new FakeWorkers())
  await runtime.start()
  const owner = { sessionId: 'legacy-owner' }
  const mission = runtime.create(owner, { title: 'Legacy', objective: 'Reopen a store an earlier build wrote', workspace: dir, scope: ['**'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation', maxOutputTokens: 5_000 })
  const resumer = await runtime.addMember(owner, mission.id, { name: 'Resumer', role: 'implementation', maxOutputTokens: 5_000 })
  const task = extra => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, kind: 'implementation', scope: ['**'], acceptance: ['works'], checks: ['test -d .'], ...extra })
  const source = task({ title: 'Source', objective: 'Implement the scoped change in src/answer.txt.', assigneeId: author.id })
  // Admitted with the carrying edge, as this build requires, then stripped of it
  // exactly as d81a3fb's `changes.dependencies: []` amendment stored it.
  const resumed = task({ title: 'Resume', objective: RESUMES, assigneeId: resumer.id, dependencies: [source.id] })
  const withdrawn = task({ title: 'Withdraw', objective: 'Continue from the checkpoint `a1b2c3d4` already in your worktree.', assigneeId: resumer.id, dependencies: [source.id] })
  const overridden = task({ title: 'Override', objective: 'Start from the commit `5e6f7a8b` and extend it.', assigneeId: resumer.id, dependencies: [source.id] })
  runtime.store.transaction(() => {
    for (const id of [resumed.id, withdrawn.id, overridden.id]) runtime.store.put('tasks', { ...runtime.store.get('tasks', id), dependencies: [] })
  })
  await runtime.dispose()
  return { config, owner, mission, source, resumed, withdrawn, overridden }
}

async function reopen(t, config, { idle = false } = {}) {
  const workers = new FakeWorkers()
  workers.autoIdle = idle
  const runtime = new SwarmRuntime({ ...config, tickMs: 10 }, workers)
  t.after(async () => { await runtime.dispose().catch(() => undefined) })
  await runtime.start()
  return { runtime, workers }
}

const decisions = (runtime, missionId, taskId) => runtime.store.list('deliveries', missionId)
  .filter(delivery => delivery.to === 'owner' && delivery.notice?.dedupKey === `dependency-assumption:${missionId}:${taskId}`)

test('a stored task that assumes prior work with no carrying edge is held on open, not dispatched from the bare baseline, and the owner is asked once', async t => {
  const dir = await realpath(await tempDirectory('swarm-legacy-assumption-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const legacy = await legacyStore(dir)
  const { runtime, workers } = await reopen(t, legacy.config, { idle: true })
  // The source is dispatched as usual, so the scheduler did run; the legacy row is not.
  await eventually(() => workers.prepared.some(item => item.taskId === legacy.source.id), 'the unaffected source task is dispatched')
  await sleep(200)
  for (const id of [legacy.resumed.id, legacy.withdrawn.id, legacy.overridden.id]) {
    const held = runtime.store.get('tasks', id)
    assert.equal(held.status, 'blocked', 'held from dispatch')
    assert.equal(held.attempt, undefined)
    assert.equal(workers.prepared.some(item => item.taskId === id), false, 'never prepared from the bare mission baseline')
    assert.deepEqual([...runtime.taskBlockCauses(held)], ['preparation-failed'], 'an existing block cause the owner repairs')
    assert.match(held.preparationFailure.reason, /^\[dependency_assumption_missing\] Task /)
    const asked = decisions(runtime, legacy.mission.id, id)
    assert.equal(asked.length, 1, 'one owner decision')
    assert.equal(asked[0].notice.class, 'decision')
    assert.match(asked[0].content, new RegExp(`^\\[dependency_assumption_missing\\] Task ${id} `))
    for (const exit of ['`swarm_control`', '`dependencies`', '`swarm_cancel`', '`swarm_propose`']) assert.ok(asked[0].content.includes(exit), `${exit} named`)
  }
  assert.match(decisions(runtime, legacy.mission.id, legacy.resumed.id)[0].content, /"09883f3"/, 'the notice names the assumed content')
  await runtime.dispose()

  // A second open neither asks again nor re-holds what the owner decides.
  const second = await reopen(t, legacy.config)
  await sleep(100)
  assert.equal(decisions(second.runtime, legacy.mission.id, legacy.resumed.id).length, 1, 'the decision is recorded once')
  assert.equal(second.runtime.store.get('tasks', legacy.resumed.id).status, 'blocked')
  // An amendment that still carries nothing is refused by the amendment guard.
  assert.throws(() => second.runtime.controlTask(legacy.owner, legacy.mission.id, legacy.resumed.id, 'amend', { dependencies: [] }, 'drop the edge again'), /\[dependency_assumption_missing\]/)
  assert.equal(second.runtime.store.get('tasks', legacy.resumed.id).status, 'blocked')
  // Amending a carrying dependency releases it: pending, waiting on its source.
  const amended = second.runtime.controlTask(legacy.owner, legacy.mission.id, legacy.resumed.id, 'amend', { dependencies: [legacy.source.id] }, 'restore the carrying edge')
  assert.equal(amended.status, 'pending')
  assert.equal(amended.preparationFailure, undefined)
  assert.deepEqual([...second.runtime.taskBlockCauses(second.runtime.store.get('tasks', legacy.resumed.id))], [])
  // Cancelling withdraws the other one.
  second.runtime.cancel(legacy.owner, legacy.mission.id, { taskId: legacy.withdrawn.id, reason: 'withdraw and re-propose with its content' })
  assert.equal(second.runtime.store.get('tasks', legacy.withdrawn.id).status, 'cancelled')
  // An explicit owner resume (for example after checking the baseline already
  // holds the named commit) is an override the next open respects.
  assert.equal(second.runtime.controlTask(legacy.owner, legacy.mission.id, legacy.overridden.id, 'resume', {}, 'the baseline already contains 5e6f7a8b').status, 'pending')
  await second.runtime.dispose()

  const third = await reopen(t, legacy.config)
  await sleep(100)
  assert.equal(third.runtime.store.get('tasks', legacy.resumed.id).status, 'pending', 'a released task is not held again')
  assert.equal(third.runtime.store.get('tasks', legacy.overridden.id).status, 'pending', 'an owner override is not re-held on the next open')
  assert.equal(decisions(third.runtime, legacy.mission.id, legacy.overridden.id).length, 1, 'and the owner is not asked again')
})
