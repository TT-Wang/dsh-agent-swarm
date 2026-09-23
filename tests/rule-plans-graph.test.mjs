import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orchestratorCommands, ReplayGraphError, ReplayTruncationError } from '../lib/trace.js'
import { SwarmRuntime } from '../lib/runtime.js'
import { validatePlan, planAdvisories } from '../lib/plans.js'
import { classifyCheck, taskCeilingExhaustion } from '../lib/admission.js'
import { taskGraphIndex, selectAcceptedDelivery } from '../lib/task-graph.js'
import { liveCarrier, proposalAllowance } from '../lib/arena.js'
import { boardIndex, deliverableTask } from '../lib/types/client/projection.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 12, maxExperiments: 2 }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
class Workers {
  prepared = []; starts = []; stopped = []; delivered = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, id) { this.prepared.push(id); return join(mission.workspace, id) }
  async start(spec) { this.starts.push(spec) }
  async stop(id) { this.stopping?.resolve(); if (this.stopGate) await this.stopGate; this.stopped.push(id) }
  async prepareTask() {}
  async deliver(member, delivery) { this.delivered.push({ member, delivery }) }
  isIdle() { return false }
  async dispose() {}
}
function plan(workspace) {
  return { title: 'Saved request', objective: 'Deliver verified code', workspace, scope: ['src/'], acceptance: ['works'], budget: { ...budget },
    members: [{ key: 'builder', name: 'Builder', role: 'implementation', maxOutputTokens: 4096 }, { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete change' }],
    tasks: [{ key: 'code', workstreamKey: 'main', title: 'Code', objective: 'Implement final change', kind: 'implementation', scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node old.cjs'], maxRecoveryAttempts: 2, checkTimeoutMs: 1000 },
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify artifact', kind: 'verification', scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'code', maxRecoveryAttempts: 2 }] }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-rule-plan-'))
  const workers = new Workers(), runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  const owner = { sessionId: 'owner' }, input = plan(directory)
  t.after(async () => { workers.stopGate = undefined; await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { directory, workers, runtime, owner, input }
}
function failAfterAdmission(f) {
  const propose = f.runtime.propose.bind(f.runtime)
  f.runtime.propose = (...args) => { const task = propose(...args); if (task.kind === 'verification') throw new Error('assembly fixture failure'); return task }
  return () => { f.runtime.propose = propose }
}

test('plans retain an optional fixed deadline through validation, draft editing and launch', async t => {
  const f = await fixture(t), deadlineAt = Date.now() + 7_200_000
  f.input.budget.deadlineAt = deadlineAt
  assert.equal(validatePlan(f.input).budget.deadlineAt, deadlineAt)
  const draft = f.runtime.createDraft(f.owner, f.input)
  assert.equal(draft.input.budget.deadlineAt, deadlineAt)
  const revised = f.runtime.updateDraft(f.owner, draft.id, draft.revision, { ...draft.input, title: 'Same deadline' })
  assert.equal(revised.input.budget.deadlineAt, deadlineAt)
  const launched = await f.runtime.launchDraft(f.owner, revised.id, revised.revision)
  assert.equal(launched.mission.budget.deadlineAt, deadlineAt)
  for (const invalid of [null, 'tomorrow', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validatePlan({ ...f.input, budget: { ...f.input.budget, deadlineAt: invalid } }), /Invalid budget deadlineAt/)
  }
  assert.equal(validatePlan(plan(f.directory)).budget.deadlineAt, undefined)
})

test('R08 corrected automatic input repairs the same staged admissions and keeps consumption', async t => {
  const f = await fixture(t), restore = failAfterAdmission(f)
  const request = f.runtime.requestStart(f.owner, { commandId: 'launch', goal: 'Deliver change', workspace: f.directory })
  await assert.rejects(f.runtime.startPlan(f.owner, request.id, f.input), /assembly fixture failure/)
  restore()
  const saved = f.runtime.starts(f.owner)[0], before = f.runtime.store.list('tasks', saved.missionId)
  const mission = f.runtime.store.get('missions', saved.missionId)
  mission.usedSteps = 4; mission.usedTokens = 50; f.runtime.store.put('missions', mission)
  const code = before.find(task => task.kind === 'implementation'); code.usedSteps = 2; f.runtime.store.put('tasks', code)
  const corrected = structuredClone(f.input)
  corrected.title = 'Corrected saved request'; corrected.tasks[0].checks = ['node corrected.cjs']; corrected.tasks[0].checkTimeoutMs = 5000; corrected.budget.maxSteps = 150
  const snapshot = await f.runtime.startPlan(f.owner, request.id, corrected)
  assert.equal(snapshot.mission.id, saved.missionId)
  assert.equal(snapshot.mission.title, corrected.title)
  assert.equal(snapshot.mission.usedSteps, 4); assert.equal(snapshot.mission.usedTokens, 50)
  assert.deepEqual(snapshot.tasks.map(task => task.id).sort(), before.map(task => task.id).sort())
  const repaired = snapshot.tasks.find(task => task.id === code.id)
  assert.deepEqual(repaired.checks, ['node corrected.cjs']); assert.equal(repaired.usedSteps, 2); assert.equal(repaired.checkTimeoutMs, 5000)
  assert.equal(f.workers.prepared.length, 2)
  const draft = f.runtime.drafts(f.owner)[0]
  assert.equal(draft.id, saved.draftId)
  assert.ok(f.runtime.store.events(draft.id, 100).some(event => event.type === 'plan/edited' && event.data.previousInput.tasks[0].checks[0] === 'node old.cjs'))
})

test('R08 member configuration changes await stop acknowledgement and retain compatible identities', async t => {
  const f = await fixture(t), restore = failAfterAdmission(f), draft = f.runtime.createDraft(f.owner, f.input)
  await assert.rejects(f.runtime.launchDraft(f.owner, draft.id, draft.revision), /assembly fixture/); restore()
  const failed = f.runtime.drafts(f.owner)[0], before = f.runtime.store.list('members', failed.missionId)
  const changed = structuredClone(f.input); changed.members[0].model = 'correct-route'
  const revised = f.runtime.updateDraft(f.owner, failed.id, failed.revision, changed)
  assert.ok(revised.revision > failed.revision)
  assert.throws(() => f.runtime.updateDraft(f.owner, revised.id, failed.revision, changed), /Draft changed/)
  const gate = deferred(); f.workers.stopGate = gate.promise; f.workers.stopping = deferred()
  const launch = f.runtime.launchDraft(f.owner, revised.id, revised.revision)
  await f.workers.stopping.promise
  assert.equal(f.runtime.store.get('missions', failed.missionId).status, 'staged')
  assert.equal(f.workers.delivered.length, 0)
  gate.resolve(); const snapshot = await launch
  assert.deepEqual(snapshot.members.map(member => member.id).sort(), before.map(member => member.id).sort())
  const builder = snapshot.members.find(member => member.name === 'Builder'), reviewer = snapshot.members.find(member => member.name === 'Reviewer')
  assert.equal(builder.model, 'correct-route'); assert.notEqual(builder.sessionId, before.find(member => member.id === builder.id).sessionId)
  assert.equal(reviewer.sessionId, before.find(member => member.id === reviewer.id).sessionId)
  assert.deepEqual(f.workers.stopped, [builder.id]); assert.equal(f.workers.prepared.length, 2)
})

test('R08 repairing a failed draft cannot rewrite a submitted artifact or drop acceptance', async t => {
  const f = await fixture(t), restore = failAfterAdmission(f), draft = f.runtime.createDraft(f.owner, f.input)
  await assert.rejects(f.runtime.launchDraft(f.owner, draft.id, draft.revision), /assembly fixture/); restore()
  const failed = f.runtime.drafts(f.owner)[0], code = f.runtime.store.list('tasks', failed.missionId).find(task => task.kind === 'implementation')
  code.status = 'submitted'; code.artifact = { commit: 'immutable', baseCommit: 'base', workspace: f.directory, changedPaths: ['src/x'] }; f.runtime.store.put('tasks', code)
  const changed = structuredClone(f.input); changed.tasks[0].checks = ['node different.cjs']
  assert.throws(() => f.runtime.updateDraft(f.owner, failed.id, failed.revision, changed), /immutable evidence/)
  assert.throws(() => f.runtime.updateDraft(f.owner, failed.id, failed.revision, { ...f.input, acceptance: ['different'] }), /original acceptance/)
  assert.deepEqual(f.runtime.store.get('tasks', code.id).artifact, code.artifact)
})

test('R19 actual target scripts decide confinement; unresolved names are advisory', async t => {
  const f = await fixture(t)
  await writeFile(join(f.directory, 'package.json'), JSON.stringify({ scripts: { verify: 'node --test', 'test:web': 'node --test', nested: 'sandbox-exec -p rule node --test', indirect: 'npm run nested' } }))
  for (const name of ['verify', 'test:web']) { f.input.tasks[0].checks = [`npm run ${name}`]; assert.doesNotThrow(() => validatePlan(f.input)) }
  f.input.tasks[0].checks = ['npm run indirect']; assert.throws(() => validatePlan(f.input), /nested sandbox/)
  assert.equal(f.workers.prepared.length, 0)
  f.input.tasks[0].checks = ['npm run unknown']; assert.doesNotThrow(() => validatePlan(f.input)); assert.ok(planAdvisories(f.input).some(item => item.code === 'check_preflight'))
  assert.ok(f.runtime.createDraft(f.owner, f.input).advisories.some(note => note.includes('check_preflight')))
  assert.equal(classifyCheck('npm run verify').runnable, 'worker')
})

test('R20 reference paths neither refuse nor widen actual scope; R10 findings preserve submission room', async t => {
  const f = await fixture(t); f.input.tasks[0].objective = 'Update src/a.ts using docs/spec.md'
  assert.doesNotThrow(() => validatePlan(f.input))
  assert.ok(planAdvisories(f.input).every(item => item.code === 'check_preflight'), 'a read reference in prose yields no path hint')
  f.input.tasks[0].scope = ['../escape']; assert.throws(() => validatePlan(f.input), /scope_selector_invalid/)
  assert.equal(taskCeilingExhaustion({ maxFindings: 1, evidenceIds: ['one'], maxSteps: 10, usedSteps: 1 }), undefined)
  assert.equal(taskCeilingExhaustion({ maxSteps: 1, usedSteps: 1 }).dimension, 'maxSteps')
})

const task = (id, kind, status, extra = {}) => ({ id, missionId: 'm', workstreamId: 's', title: id, objective: id, kind, status, dependencies: [], scope: ['src/'], acceptance: ['works'], checks: [], priority: 50, experiment: false, epoch: 0, evidenceIds: [], proposedBy: 'owner', createdAt: 1, ...extra })
const accepted = (id, kind = 'implementation', dependencies = []) => task(id, kind, 'accepted', { dependencies, artifact: { commit: id, baseCommit: 'base', workspace: '/repo', changedPaths: ['src/x'] } })

test('R25 all projections reject ambiguity and cross-kind replacements, with exact review sources', () => {
  const source = task('source', 'implementation', 'cancelled'), repair = accepted('repair'), second = accepted('second')
  repair.replaces = ['source']; second.replaces = ['source']
  const review = task('review', 'verification', 'pending', { reviewOf: source.id })
  for (const rows of [[source, repair, second, review], [source, { ...repair, kind: 'research' }, review]]) {
    assert.equal(taskGraphIndex(rows).dependencyMet(source.id), false)
    assert.notEqual(liveCarrier(rows, source.id)?.status, 'accepted')
    assert.equal(boardIndex(rows).dependencyMet(source.id), false)
  }
  repair.status = 'submitted'
  const rows = [source, repair, review]
  assert.equal(taskGraphIndex(rows).reviewSource(review).id, source.id)
  assert.equal(boardIndex(rows).lane(review), 'blocked')
})

test('R23/R24 completion and delivery share unique artifact coverage before terminal state', async t => {
  const f = await fixture(t), mission = f.runtime.create(f.owner, { ...f.input, title: 'graph' })
  const rows = [accepted('code'), accepted('one', 'integration', ['code']), accepted('two', 'integration', ['code'])].map(row => ({ ...row, missionId: mission.id }))
  for (const row of rows) f.runtime.store.put('tasks', row)
  assert.match(f.runtime.completionError(mission), /unique accepted integration/)
  assert.throws(() => f.runtime.control(f.owner, mission.id, 'complete', 'finish'), /unique accepted integration/)
  assert.equal(f.runtime.store.get('missions', mission.id).status, 'active')
  assert.equal(deliverableTask({ tasks: rows }), undefined)
  for (const id of ['one', 'two']) { const row = f.runtime.store.get('tasks', id); row.status = 'cancelled'; f.runtime.store.put('tasks', row) }
  const remaining = f.runtime.store.list('tasks', mission.id)
  assert.equal(selectAcceptedDelivery(remaining).id, 'code')
  assert.equal(f.runtime.completionError(mission), undefined)
  assert.equal(deliverableTask({ tasks: remaining }).id, 'code')
  const missingCoverage = [accepted('a'), accepted('b'), accepted('integration', 'integration', ['a'])]
  assert.throws(() => selectAcceptedDelivery(missingCoverage), /all implementation results/)
})

test('R11 worker expansion leaves aggregate proposal safety unchanged', () => {
  const rows = Array.from({ length: 6 }, (_, i) => task(`t${i}`, 'research', 'pending'))
  const before = proposalAllowance({ budget: { ...budget, maxTasks: 40, maxWorkers: 4 } }, [], rows, 'worker')
  const after = proposalAllowance({ budget: { ...budget, maxTasks: 40, maxWorkers: 8 } }, [], rows, 'worker')
  assert.equal(before.limit, 40); assert.equal(after.limit, 40); assert.equal(after.admitted, 6)
})


test('amended dependency graphs are checked by durable replay', () => {
  const event = (seq, type, data) => ({ seq, missionId: 'm', actor: 'owner', createdAt: seq, type, data })
  const log = [event(1, 'task/proposed', task('a', 'research', 'pending')), event(2, 'task/proposed', task('b', 'research', 'pending', { dependencies: ['a'] }))]
  assert.doesNotThrow(() => orchestratorCommands(log))
  assert.throws(() => orchestratorCommands([...log, event(3, 'task/amended', { taskId: 'a', changes: { dependencies: ['b'] } })]), ReplayGraphError)
  assert.doesNotThrow(() => orchestratorCommands([...log, event(3, 'task/amended', { taskId: 'b', changes: { dependencies: [], checks: ['node --test'] } })]))
})


test('replay closes only the precise attempt fenced by a structural amendment', () => {
  const event = (seq, type, data) => ({ seq, missionId: 'm', actor: 'owner', createdAt: seq, type, data })
  const log = [event(1, 'task/proposed', task('a', 'research', 'running')), event(2, 'task/claimed', { taskId: 'a', attempt: { id: 'attempt-a', ownerId: 'member' } })]
  assert.throws(() => orchestratorCommands([...log, event(3, 'task/amended', { taskId: 'a', changes: { maxSteps: 200 } })]), ReplayTruncationError)
  assert.doesNotThrow(() => orchestratorCommands([...log, event(3, 'task/amended', { taskId: 'a', changes: { dependencies: [] }, fencedAttemptId: 'attempt-a' })]))
  assert.throws(() => orchestratorCommands([...log, event(3, 'task/amended', { taskId: 'a', changes: {}, fencedAttemptId: 'other-attempt' })]), ReplayTruncationError)
})
