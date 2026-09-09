/**
 * W12 regressions: cancellation is terminal for the withdrawn record, not for
 * the obligation it carried. A cancelled task admits exactly one live repair,
 * dependents admitted before the withdrawal resolve to that repair instead of
 * being stranded, and newly admitted dependents can name the cancelled task
 * again. Pre-fix only `blocked` work could be replaced, so a cancel dead-ended
 * the whole downstream subtree.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
async function eventually(read, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

class RepairWorkers {
  prepared = []; deliveries = []; stopped = []
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push({ to: member.id, ...delivery }) }
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-w12-'))
  const workers = new RepairWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'w12-owner' }
  const mission = runtime.create(owner, { title: 'W12', objective: 'Repair withdrawn obligations', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const research = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Analyse', objective: 'Analyse',
    kind: 'research', scope: ['src/'], acceptance: ['works'], ...extra })
  async function accept(task) {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    await runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: `Review ${task.title}`, objective: 'Independent review',
      kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: task.id })
    const claimedReview = await runtime.claim(actor(reviewer), mission.id, review.id)
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
    return current(task)
  }
  return { runtime, workers, owner, mission, stream, author, reviewer, actor, current, events, propose, research, accept }
}

test('W12: cancelling a task admits one live repair and re-resolves its dependents', async t => {
  const f = await fixture(t)
  const original = f.propose({ title: 'Withdrawn work' })
  const admitted = f.research({ title: 'Already admitted dependent', dependencies: [original.id] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'Wrong scope for this task' })
  assert.equal(f.current(original.id).status, 'cancelled')
  const [cancelled] = f.events('task/cancelled')
  assert.deepEqual(cancelled.data.strandedDependents, [admitted.id], 'the durable event names the stranded dependent')
  await eventually(() => f.workers.deliveries.find(delivery => delivery.to === 'owner' && /stranded admitted dependents/.test(delivery.content)), 'the owner is told to repair the withdrawal')
  // A new dependent is still refused while no live repair exists.
  assert.throws(() => f.research({ title: 'New dependent', dependencies: [original.id] }), /no live replacement/)
  // The repair must keep the original acceptance obligations verbatim.
  assert.throws(() => f.propose({ title: 'Bad repair', replaces: [original.id], acceptance: ['other'] }), /Missing: \["works"\]/)
  const before = structuredClone(f.current(original.id))
  const repair = f.propose({ title: 'Corrected repair', replaces: [original.id] })
  assert.equal(repair.status, 'pending', 'a cancelled task admits one live repair')
  assert.deepEqual(repair.replaces, [original.id])
  assert.deepEqual(f.current(original.id), before, 'the cancelled record is byte-for-byte unchanged by the repair')
  assert.throws(() => f.propose({ title: 'Second repair', replaces: [original.id] }), /already replaced by/)
  // Both the pre-existing dependent and a newly admitted one resolve to the repair.
  const fresh = f.research({ title: 'New dependent', dependencies: [original.id] })
  for (const dependent of [admitted, fresh]) {
    assert.equal(f.runtime.observe(f.actor(f.reviewer), f.mission.id, { taskId: dependent.id }).dependencies[0].id, repair.id)
  }
  // Accepting the repair makes the dependents dispatchable without re-proposing them.
  await f.accept(repair)
  assert.equal(f.current(repair.id).status, 'accepted')
  assert.equal(f.current(original.id).status, 'cancelled', 'acceptance of the repair never revives the withdrawn record')
  for (const dependent of [admitted, fresh]) {
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, dependent.id)
    assert.equal(claimed.status, 'running', 'the dependent becomes ready through the repair lineage')
    // Release the author for the next dependent; the claim itself is the assertion.
    f.runtime.handoff(f.actor(f.author), f.mission.id, { taskId: dependent.id, attemptId: claimed.attempt.id, to: f.reviewer.id, summary: 'Continue elsewhere' })
  }
})

test('W12: the repair path keeps one live replacement and still refuses accepted or running work', async t => {
  const f = await fixture(t)
  const accepted = f.propose({ title: 'Accepted work' })
  await f.accept(accepted)
  assert.throws(() => f.propose({ title: 'Repair accepted work', replaces: [accepted.id] }), /is accepted, and only blocked work can be replaced/)
  const running = f.propose({ title: 'Running work' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, running.id)
  assert.throws(() => f.propose({ title: 'Repair running work', replaces: [running.id] }), /only blocked or cancelled work can be replaced/)
  f.runtime.cancel(f.owner, f.mission.id, { taskId: running.id, reason: 'Withdraw the running attempt' })
  const repair = f.propose({ title: 'Repair the running work', replaces: [running.id] })
  assert.equal(repair.status, 'pending')
  // A cancelled replacement is no longer live, so a corrected repair is admitted.
  f.runtime.cancel(f.owner, f.mission.id, { taskId: repair.id, reason: 'Wrong scope again' })
  const corrected = f.propose({ title: 'Corrected repair', replaces: [running.id] })
  assert.equal(corrected.status, 'pending')
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.filter(task => task.replaces?.includes(running.id) && task.status !== 'cancelled').length, 1)
})
