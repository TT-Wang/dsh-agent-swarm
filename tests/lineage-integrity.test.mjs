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
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  /** Drive one real proposal through independent rejection so the task is durably blocked. */
  async function block(task) {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    await runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: `Review ${task.title}`, objective: 'Independent review',
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

test('replacement admission rejects a cycle before persisting the task or check-change events', async t => {
  const f = await fixture(t)
  const original = f.propose({ title: 'Original' })
  const dependent = f.propose({ title: 'Dependent', dependencies: [original.id] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'Revise implementation' })
  const before = f.runtime.store.list('tasks', f.mission.id)
  const events = f.runtime.store.events(f.mission.id, 500)
  assert.throws(() => f.propose({ title: 'Cyclic repair', replaces: [original.id], dependencies: [dependent.id], checks: ['other-check'] }),
    /\[task_graph_cycle\]/)
  assert.deepEqual(f.runtime.store.list('tasks', f.mission.id), before, 'rejected admission changes no durable task')
  assert.deepEqual(f.runtime.store.events(f.mission.id, 500), events, 'rejected admission publishes neither a proposal nor a check change')
  const repair = f.propose({ title: 'Acyclic repair', replaces: [original.id] })
  assert.deepEqual(f.runtime.effectiveDependencies(f.mission.id, dependent).map(task => task.id), [repair.id])
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, repair.id)
  assert.equal(claimed.status, 'running', 'the corrected repair remains executable')
})

test('replacement admission follows transitive repairs and dependencies before checking cycles', async t => {
  const f = await fixture(t)
  const original = f.propose({ title: 'Original' })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'Revise implementation' })
  const firstRepair = f.propose({ title: 'First repair', replaces: [original.id] })
  const first = f.propose({ title: 'First dependent', dependencies: [original.id] })
  const second = f.propose({ title: 'Second dependent', dependencies: [first.id] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: firstRepair.id, reason: 'Revise repair' })
  assert.throws(() => f.propose({ title: 'Cyclic second repair', replaces: [firstRepair.id], dependencies: [second.id] }),
    /\[task_graph_cycle\]/)
  const repair = f.propose({ title: 'Corrected second repair', replaces: [firstRepair.id] })
  assert.deepEqual(f.runtime.effectiveDependencies(f.mission.id, first).map(task => task.id), [repair.id])
  assert.equal(f.current(original).status, 'cancelled')
  assert.equal(f.current(firstRepair).status, 'cancelled')
})

test('replacement cycle validation includes the exact review-source edge', async t => {
  const f = await fixture(t)
  const original = f.propose({ title: 'Original' })
  const dependent = f.propose({ title: 'Dependent', dependencies: [original.id] })
  const review = f.propose({ title: 'Review dependent', kind: 'verification', reviewOf: dependent.id, checks: [] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'Revise implementation' })
  assert.throws(() => f.propose({ title: 'Repair waiting for its own downstream review', replaces: [original.id], dependencies: [review.id] }),
    /\[task_graph_cycle\]/)
  assert.equal(f.current(review).reviewOf, dependent.id, 'admission never rewrites a review to a different artifact')
  assert.equal(f.current(dependent).dependencies[0], original.id, 'admission preserves declared dependency identities')
})

test('a combined repair preserves obsolete dependency and review edges without reviving their waits', async t => {
  const f = await fixture(t)
  const original = f.propose({ title: 'Original' })
  const withdrawn = f.propose({ title: 'Withdrawn dependent', dependencies: [original.id] })
  const rejectedReview = await f.block(original)
  const dependent = f.propose({ title: 'Dependent', dependencies: [withdrawn.id] })
  const obsoleteReview = f.propose({ title: 'Obsolete review', kind: 'verification', reviewOf: withdrawn.id, checks: [] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: withdrawn.id, reason: 'Combine work into one repair' })
  const historical = [original, rejectedReview, withdrawn, obsoleteReview].map(task => f.current(task))
  const repair = f.propose({ title: 'Combined repair', replaces: [original.id, withdrawn.id] })
  assert.deepEqual([original, rejectedReview, withdrawn, obsoleteReview].map(task => f.current(task)), historical,
    'blocked sources, completed verdicts and cancelled reviews remain unchanged')
  assert.deepEqual(f.runtime.effectiveDependencies(f.mission.id, dependent).map(task => task.id), [repair.id])
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, repair.id)
  assert.equal(claimed.status, 'running', 'obsolete waits do not prevent a valid combined repair')
})

test('an unrelated historical graph defect does not prevent an independent repair', async t => {
  const f = await fixture(t)
  const original = f.propose({ title: 'Original' })
  const one = f.propose({ title: 'Imported first' })
  const two = f.propose({ title: 'Imported second', dependencies: [one.id] })
  const imported = f.current(one)
  imported.dependencies = [two.id]
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', imported))
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'Revise independent work' })
  const repair = f.propose({ title: 'Independent repair', replaces: [original.id] })
  assert.equal(repair.status, 'pending')
  assert.deepEqual(f.current(one).dependencies, [two.id], 'an unrelated import is neither rewritten nor used to block recovery')
})
