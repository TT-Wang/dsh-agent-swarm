/** W2 regressions: duplicate replacement admission and deterministic repair lineage. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

/** Only the external execution adapter is replaced; admission, lineage and store stay real. */
class LineageWorkers {
  prepared = []
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  artifact = { commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return false }
  async prepareTask(member, task, dependencies, reviewSource) {
    this.prepared.push(structuredClone({ member: member.id, task, dependencies: dependencies.map(item => item.id), reviewSource: reviewSource?.id }))
  }
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-lineage-'))
  const workers = new LineageWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 200, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'lineage-owner' }
  const mission = runtime.create(owner, { title: 'Lineage', objective: 'Keep repair lineage deterministic', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  /** Drive one real proposal through independent rejection so the task is durably blocked. */
  async function block(task) {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    await runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: `Review ${task.title}`, objective: 'Independent review',
      kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: task.id })
    const claimedReview = await runtime.claim(actor(reviewer), mission.id, review.id)
    workers.checks = [{ command: 'test', exitCode: 1, output: 'host check failed' }]
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Host checks reject the candidate' })
    workers.checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
    assert.equal(current(task).status, 'blocked')
    return review
  }
  return { runtime, workers, owner, mission, stream, author, reviewer, actor, propose, block, current }
}

test('a blocked task admits exactly one live replacement and rejects a duplicate at admission', async t => {
  const f = await fixture(t)
  const original = f.propose()
  await f.block(original)
  const repair = f.propose({ title: 'Repair' , replaces: [original.id] })
  assert.equal(repair.status, 'pending')
  const admitted = f.runtime.snapshot(f.owner, f.mission.id).tasks.length
  // Pre-fix this second replacement was admitted while the first was live; two
  // accepted replacements then made lineage fail closed for every dependent.
  assert.throws(() => f.propose({ title: 'Duplicate repair', replaces: [original.id] }),
    /already replaced by .*\(pending\)/)
  const after = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(after.tasks.length, admitted, 'the rejected duplicate is never admitted')
  const replacements = after.tasks.filter(task => task.replaces?.includes(original.id))
  assert.deepEqual(replacements.map(task => task.id), [repair.id], 'one blocked obligation keeps exactly one live replacement')
  assert.equal(f.current(original.id).status, 'blocked', 'rejection does not mutate the blocked original')
})

test('lineage resolves deterministically to the oldest live replacement for imported history', async t => {
  const f = await fixture(t)
  const original = f.propose()
  await f.block(original)
  const first = f.propose({ title: 'First repair', replaces: [original.id] })
  // Imported or pre-fix durable state may still carry two live replacements.
  const firstRecord = f.current(first)
  const second = { ...structuredClone(firstRecord), id: 'task_imported_second_repair', title: 'Second repair',
    createdAt: firstRecord.createdAt + 1, evidenceIds: [], attempt: undefined, artifact: undefined, output: undefined }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', second))
  const dependent = f.propose({ title: 'Dependent synthesis', kind: 'research', checks: undefined, dependencies: [original.id] })
  const view = () => f.runtime.observe(f.actor(f.reviewer), f.mission.id, { taskId: dependent.id })
  // Pre-fix newest-wins resolved this to the second repair, so the effective
  // prerequisite changed as the newer candidate advanced through its lifecycle.
  assert.equal(view().dependencies[0].id, first.id, 'the oldest live replacement is the deterministic effective dependency')
  assert.equal(view().dependencies[0].status, 'pending')
  assert.deepEqual(view().dependencies[0].replacementOf, [original.id])
  assert.deepEqual(view(), view(), 'repeated resolution is identical')
})
