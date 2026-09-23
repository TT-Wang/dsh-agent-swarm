/**
 * A repair inherits the acceptance of the task it replaces. The host already
 * holds the replaced task's criteria, so `swarm_propose { replaces }` stores
 * them itself: each replaced task's list in order, then any criteria the
 * proposal adds, without duplicates. Pre-fix the proposal had to copy them
 * verbatim or be refused, and a repair that omitted acceptance was refused.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

class RepairWorkers {
  deliveries = []
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push({ to: member.id, ...delivery }) }
  async stop() {}
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-inherit-'))
  const workers = new RepairWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'inherit-owner' }
  const mission = runtime.create(owner, { title: 'Inherit', objective: 'Repair rejected work', workspace: directory,
    scope: ['src/'], acceptance: ['works', 'is documented'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const stored = task => runtime.store.get('tasks', task.id)
  // Built without an `acceptance` key unless one is passed, so omission is real.
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], checks: ['test'], ...extra })
  async function verdict(task, value) {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    await runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: `Review ${task.title}`, objective: 'Independent review',
      kind: 'verification', scope: ['src/'], acceptance: ['independent review'], checks: [], reviewOf: task.id })
    const claimedReview = await runtime.claim(actor(reviewer), mission.id, review.id)
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: value, reason: `Independent host checks ${value}` })
    return stored(task)
  }
  return { runtime, owner, mission, propose, stored, verdict }
}

test('a repair proposed with no acceptance inherits exactly the replaced task\'s list', async t => {
  const f = await fixture(t)
  const original = f.propose({ title: 'Original', acceptance: ['works', 'is documented'] })
  assert.equal((await f.verdict(original, 'reject')).status, 'blocked')
  const repair = f.propose({ title: 'Repair', replaces: [original.id] })
  assert.deepEqual(repair.acceptance, ['works', 'is documented'])
  assert.deepEqual(f.stored(repair).acceptance, ['works', 'is documented'], 'the durable row carries the inherited obligations')
  assert.deepEqual(f.stored(original).acceptance, ['works', 'is documented'], 'the replaced record is unchanged')
})

test('a repair adding one criterion stores the replaced list first, then the addition, without duplicates', async t => {
  const f = await fixture(t)
  const original = f.propose({ title: 'Original', acceptance: ['works', 'is documented'] })
  await f.verdict(original, 'reject')
  const repair = f.propose({ title: 'Repair', replaces: [original.id], acceptance: ['handles empty input', 'works'] })
  assert.deepEqual(f.stored(repair).acceptance, ['works', 'is documented', 'handles empty input'])
})

test('a repair of several withdrawn tasks inherits each list in order, de-duplicated across them', async t => {
  const f = await fixture(t)
  const first = f.propose({ title: 'First', acceptance: ['works', 'shared'] })
  const second = f.propose({ title: 'Second', acceptance: ['shared', 'is documented'] })
  for (const task of [first, second]) f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'Merged into one repair' })
  const repair = f.propose({ title: 'Merged repair', replaces: [first.id, second.id], acceptance: ['is documented', 'new'] })
  assert.deepEqual(f.stored(repair).acceptance, ['works', 'shared', 'is documented', 'new'])
})

test('mission completion coverage sees the criteria a repair inherited', async t => {
  const f = await fixture(t)
  const original = f.propose({ title: 'Original', acceptance: ['works', 'is documented'] })
  await f.verdict(original, 'reject')
  const current = () => f.runtime.store.get('missions', f.mission.id)
  assert.match(f.runtime.completionError(current()), /unfinished or blocked/)
  const repair = f.propose({ title: 'Repair', replaces: [original.id] })
  assert.equal((await f.verdict(repair, 'accept')).status, 'accepted')
  assert.equal(f.stored(original).status, 'cancelled', 'the accepted repair retires the blocked original')
  assert.equal(f.runtime.completionError(current()), undefined, 'the inherited criteria cover the mission acceptance')
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'Accepted inherited repair').status, 'completed')
})
