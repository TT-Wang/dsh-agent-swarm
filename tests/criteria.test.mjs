/**
 * Acceptance by reference: a mission criterion is identified by its position
 * (`criterionId`), a deliverable cites the ids it satisfies in `covers`, and the
 * host derives what each worker and reviewer checks (`checklist`) and what a
 * deliverable answers for (`criteriaOf`) through review and replacement
 * lineage, so no criterion text is ever copied from one row to another.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { taskGraphIndex } from '../lib/task-graph.js'
import { criterionId } from '../lib/types.js'
import { validatePlan } from '../lib/plans.js'
import { SwarmStore } from '../lib/store.js'
import { OWNER_PROMPT, registerTools } from '../lib/tools.js'
import { FakeClock, FakeWorkers, SwarmRuntime, acceptThroughReview, blockThroughReview, budget, makeRuntime, makeRuntimeStub, setup } from './faults/harness.mjs'
import { completionError } from '../lib/board.js'

const criteria = ['value is two', 'docs mention two', 'no other file changes']
const row = (id, extra = {}) => ({ id, missionId: 'm', workstreamId: 's', title: id, objective: id, kind: 'implementation', status: 'pending', dependencies: [], scope: ['src/'], acceptance: [], checks: [], priority: 50, experiment: false, epoch: 0, evidenceIds: [], createdAt: 1, ...extra })

test('a criterion id is its position in the mission list, counted from c1', () => {
  assert.deepEqual(criteria.map((_, index) => criterionId(index)), ['c1', 'c2', 'c3'])
})

test('a deliverable answers for its own covers and those of every task it replaces, both parents of a two-parent repair included', () => {
  const graph = taskGraphIndex([
    row('a', { status: 'blocked', covers: ['c1'] }), row('b', { status: 'cancelled', covers: ['c3'] }),
    row('repair', { covers: ['c2'], replaces: ['a', 'b'] }), row('review', { kind: 'verification', reviewOf: 'repair', covers: ['c1', 'c2', 'c3'] }),
  ])
  assert.deepEqual([...graph.criteriaOf('repair')].sort(), ['c1', 'c2', 'c3'])
  assert.deepEqual([...graph.criteriaOf('a')], ['c1'], 'a replaced task answers only for itself')
  assert.deepEqual([...graph.criteriaOf('unknown')], [])
})

test('a deliverable checks its covered criteria in mission order, then the own criteria of its lineage, each once', () => {
  const graph = taskGraphIndex([
    row('a', { status: 'blocked', covers: ['c3'], acceptance: ['keeps the API'] }),
    row('repair', { covers: ['c1'], acceptance: ['adds a test', 'keeps the API'], replaces: ['a'] }),
  ])
  assert.deepEqual(graph.checklist('repair', criteria), ['value is two', 'no other file changes', 'adds a test', 'keeps the API'])
  // A plan's fold appends a review's ids after its source's, so covers need not be in mission order.
  assert.deepEqual(taskGraphIndex([row('folded', { covers: ['c3', 'c1'] })]).checklist('folded', criteria), ['value is two', 'no other file changes'])
})

test('a review checks its source\'s checklist, then its own review-only criteria', () => {
  const graph = taskGraphIndex([
    row('source', { covers: ['c2'], acceptance: ['adds a test'] }),
    row('review', { kind: 'verification', reviewOf: 'source', acceptance: ['reads the diff', 'adds a test'] }),
  ])
  assert.deepEqual(graph.checklist('review', criteria), ['docs mention two', 'adds a test', 'reads the diff'])
})

test('a copy-era row without covers checks exactly its stored list, and so does the review the host added with a copy of it', () => {
  // Before ids, a deliverable stored the mission text, and a repair stored the
  // union of its predecessors' lists and its own, in that order.
  const stored = ['value is two', 'adds a test']
  const graph = taskGraphIndex([
    row('a', { status: 'blocked', acceptance: ['value is two'] }),
    row('repair', { acceptance: stored, replaces: ['a'] }),
    row('review', { kind: 'verification', reviewOf: 'repair', acceptance: [...stored] }),
  ])
  assert.deepEqual(graph.checklist('repair', criteria), stored)
  assert.deepEqual(graph.checklist('review', criteria), stored)
})

test('an authored review is assigned and shown everything its source must satisfy, then its own criteria, while the owner and the registry read the stored rows', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['value is two'] })
  t.after(f.cleanup)
  // The source cites c1 and stores only its own criterion, so its checklist is not its stored list.
  const source = f.propose({ acceptance: ['adds a test'] })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Review', objective: 'Independent review',
    kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: ['reads the diff'], assigneeId: f.reviewer.id })
  await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  const checklist = ['value is two', 'adds a test', 'reads the diff']
  const assignment = f.runtime.store.list('deliveries', f.mission.id).find(delivery => delivery.kind === 'assignment' && delivery.taskId === review.id)
  assert.deepEqual(JSON.parse(assignment.content).task.acceptance, checklist, 'the reviewer is assigned its source\'s criteria')
  assert.deepEqual(f.runtime.observe(f.actor(f.reviewer), f.mission.id).current.task.acceptance, checklist, 'and observes them')
  assert.deepEqual(f.runtime.store.get('tasks', review.id).acceptance, ['reads the diff'], 'nothing is copied onto the stored review')
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id, { taskId: review.id }).task.acceptance, ['reads the diff'], 'and the owner reads that row')
  const registered = f.runtime.artifacts(f.owner, { missionId: f.mission.id }).artifacts.find(row => row.taskId === source.id)
  assert.deepEqual([registered.acceptance, registered.covers, registered.missionAcceptance], [['adds a test'], ['c1'], ['value is two']], 'the registry row is the stored source beside the criteria its ids name')
})

const plan = (workspace, tasks) => ({ title: 'Plan', objective: 'Deliver', workspace, scope: ['src/'], acceptance: ['works', 'is documented'], budget,
  members: [{ key: 'builder', role: 'implementation', maxOutputTokens: 1000 }, { key: 'reviewer', role: 'verification', maxOutputTokens: 1000 }],
  workstreams: [{ key: 'main', title: 'Main', objective: 'Deliver' }],
  tasks: tasks ?? [
    { key: 'code', workstreamKey: 'main', title: 'Code', objective: 'Write it', kind: 'implementation', outputs: [], scope: ['src/'], acceptance: ['has a test'], covers: ['c1'], checks: ['node --test'], assigneeKey: 'builder', maxRecoveryAttempts: 1, checkTimeoutMs: 1000 },
    { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Review it', kind: 'verification', outputs: [], scope: ['src/'], acceptance: ['reads the diff'], covers: ['c2'], reviewOf: 'code', assigneeKey: 'reviewer', maxRecoveryAttempts: 1 },
  ] })

test('a plan cites criteria by distinct minted ids, on the stage and the launch path alike', () => {
  for (const [covers, shown] of [[['c3'], '["c3"]'], [['c1', 'c1'], '["c1","c1"]'], [['works'], '["works"]'], [[1], '[1]'], ['c1', '"c1"'], [['C1'], '["C1"]'], [['c0'], '["c0"]']]) {
    for (const options of [{}, { launch: true }]) {
      const input = plan('/repo'); input.tasks[0].covers = covers
      assert.throws(() => validatePlan(input, options), error => error.code === 'covers_invalid' && error.category === 'validation_error'
        && error.message === `[covers_invalid] tasks[0] (code).covers must list distinct ids of the mission acceptance criteria, c1 for the first through c2 for the last; it has ${shown}. Pass \`covers\` with each id this task satisfies once, never the criterion text, and retry the same task/request.`, JSON.stringify(covers))
    }
  }
})

test('a plan deliverable needs covers or its own acceptance once its review\'s covers moved onto it; a review needs neither', () => {
  const bare = plan('/repo').tasks.map(({ acceptance: _own, ...task }) => task)
  const refused = validatePlan.bind(undefined, plan('/repo', bare.map(({ covers: _cited, ...task }) => task)), { launch: true })
  assert.throws(refused, error => error.code === 'plan_task_acceptance_required' && error.category === 'validation_error'
    && error.message === '[plan_task_acceptance_required] tasks[0] (code) has neither covers nor acceptance. Add to `covers` the ids of the mission criteria it satisfies, or, when it satisfies none, give it its own `acceptance`, and relaunch the complete plan.')
  const folded = validatePlan(plan('/repo', bare.map(task => task.kind === 'verification' ? task : { ...task, covers: undefined })), { launch: true })
  assert.deepEqual(folded.tasks.map(task => [task.key, task.acceptance, task.covers]), [['code', [], ['c2']], ['review', [], undefined]], 'an omitted list is canonical []; the review\'s covers give its source criteria')
})

test('a review\'s covers move onto its source, once, so validating again and comparing a retry as JSON are stable', () => {
  const folded = validatePlan(plan('/repo'))
  assert.deepEqual(folded.tasks.map(task => [task.key, task.covers]), [['code', ['c1', 'c2']], ['review', undefined]])
  assert.equal(JSON.stringify(validatePlan(folded)), JSON.stringify(folded), 'a second validation sees the folded plan')
  assert.equal(JSON.stringify(validatePlan(plan('/repo'))), JSON.stringify(folded))
  const reversed = plan('/repo'); reversed.tasks.reverse()
  assert.deepEqual(validatePlan(reversed).tasks.map(task => [task.key, task.covers]), [['review', undefined], ['code', ['c1', 'c2']]], 'a review listed before its source folds the same way')
})

test('a criterion a deliverable and its review both cite is cited once on the deliverable, so the saved draft validates again and launches', async t => {
  const shared = workspace => { const input = plan(workspace); for (const task of input.tasks) task.covers = ['c1', 'c2']; return input }
  const folded = validatePlan(shared('/repo'))
  assert.deepEqual(folded.tasks.map(task => [task.key, task.covers]), [['code', ['c1', 'c2']], ['review', undefined]])
  assert.equal(JSON.stringify(validatePlan(folded)), JSON.stringify(folded), 'a second validation sees the folded plan')
  const { dir, runtime } = await makeRuntime(t, { workers: new FakeWorkers(), config: { tickMs: 60000, checkTimeoutMs: undefined } })
  const owner = { sessionId: 'owner' }
  const draft = runtime.createDraft(owner, shared(dir), { grantRoot: dir, source: 'session' })
  assert.deepEqual(draft.input.tasks.map(task => task.covers), [['c1', 'c2'], undefined], 'the saved draft holds each id once')
  const launched = await runtime.launchDraft(owner, draft.id, draft.revision)
  assert.deepEqual([launched.mission.status, launched.tasks.find(task => task.kind === 'implementation').covers], ['active', ['c1', 'c2']])
})

test('citing nothing has one representation, no covers at all: a plan that spells it [] validates to the plan that omits it, and the row is the same whether a launch proposes the task, swarm_propose is handed [] itself or a staged repair rewrites it', async t => {
  const citing = (workspace, covers) => { const input = plan(workspace); for (const task of input.tasks) task.covers = covers; return input }
  // The deliverable keeps its own criterion, so it is admissible with no covers.
  const omitted = validatePlan(citing('/repo', undefined))
  assert.equal(JSON.stringify(validatePlan(citing('/repo', []))), JSON.stringify(omitted), 'a retry that writes [] is the saved plan')
  assert.deepEqual(omitted.tasks.map(task => task.covers), [undefined, undefined])
  const { dir, runtime } = await makeRuntime(t, { workers: new FakeWorkers(), config: { tickMs: 60000, checkTimeoutMs: undefined } })
  const owner = { sessionId: 'owner' }, claim = { grantRoot: dir, source: 'session' }
  const rows = snapshot => snapshot.tasks.map(task => [task.kind, task.acceptance, 'covers' in task ? task.covers : 'no covers'])
  // Launched: the plan writes [], and its validation has fixed the shape before swarm_propose sees the task.
  const fresh = runtime.createDraft(owner, citing(dir, []), claim)
  const proposed = await runtime.launchDraft(owner, fresh.id, fresh.revision)
  // Proposed as written: the registered swarm_propose is handed [] itself, for the same deliverable and for its review.
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  const call = async args => (await definitions.get('swarm_propose').execute({ missionId: proposed.mission.id, workstreamId: proposed.workstreams[0].id, scope: ['src/'], outputs: [], covers: [], maxRecoveryAttempts: 1, ...args },
    { signal: new AbortController().signal, agent: { id: owner.sessionId } })).result
  const code = await call({ title: 'Code again', objective: 'Write it', kind: 'implementation', acceptance: ['has a test'], checks: ['node --test'], checkTimeoutMs: 1000 })
  const returned = [code, await call({ title: 'Review again', objective: 'Review it', kind: 'verification', acceptance: ['reads the diff'], reviewOf: code.id })]
  assert.deepEqual(rows({ tasks: returned }), rows(proposed), 'the task swarm_propose returns has no covers')
  assert.deepEqual(rows({ tasks: returned.map(task => runtime.store.get('tasks', task.id)) }), rows(proposed), 'and neither has the row it stored')
  // Rewritten by the staged repair: the assembly fails once the deliverable exists citing c1, and the repaired plan writes [] for it.
  const propose = runtime.propose.bind(runtime)
  runtime.propose = (...args) => { const task = propose(...args); if (task.kind === 'verification') throw new Error('assembly fixture failure'); return task }
  const first = citing(dir, undefined); first.tasks[0].covers = ['c1']
  const draft = runtime.createDraft(owner, first, claim)
  await assert.rejects(runtime.launchDraft(owner, draft.id, draft.revision), /assembly fixture failure/)
  runtime.propose = propose
  const failed = runtime.drafts(owner).find(saved => saved.id === draft.id)
  assert.deepEqual(runtime.store.list('tasks', failed.missionId).map(task => task.covers), [['c1'], undefined], 'the staged deliverable cites c1')
  const repaired = runtime.updateDraft(owner, failed.id, failed.revision, citing(dir, []), claim)
  const rewritten = await runtime.launchDraft(owner, repaired.id, repaired.revision)
  assert.deepEqual(rows(rewritten), rows(proposed))
  assert.deepEqual(rows(proposed), [['implementation', ['has a test'], 'no covers'], ['verification', ['reads the diff'], 'no covers']])
})

test('a review\'s covers are checked where the plan wrote them and move onto its source only afterwards, so a refusal names each field once and never one the plan did not write', () => {
  const located = error => error.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.location])
  // The review is listed before its source and names an unknown id: one diagnostic, at the review.
  const reversed = plan('/repo'); reversed.tasks.reverse(); reversed.tasks[0].covers = ['c2', 'c9']
  assert.throws(() => validatePlan(reversed), error => { assert.deepEqual(located(error), [['covers_invalid', 'tasks[0] (review).covers']]); return true })
  // The review is refused for sharing its source's assignee. Its covers still count for that source, which has no criteria of its own and is not called bare.
  const shared = plan('/repo'); shared.tasks[0].acceptance = []; shared.tasks[0].covers = undefined; shared.tasks[1].assigneeKey = 'builder'
  assert.throws(() => validatePlan(shared), error => { assert.deepEqual(located(error), [['plan_review_independence_required', 'tasks[1] (review).assigneeKey']]); return true })
  // A malformed list on the source is refused as written, whatever its review names.
  const malformed = plan('/repo'); malformed.tasks[0].covers = 5
  assert.throws(() => validatePlan(malformed), error => { assert.deepEqual(located(error), [['covers_invalid', 'tasks[0] (code).covers']]); return true })
})

test('propose stores a deliverable\'s ids as given and refuses unknown ids and any id on a review, so a later review cannot add coverage', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  assert.throws(() => f.propose({ covers: ['c3'] }), error => error.code === 'covers_invalid' && /^\[covers_invalid\] covers must list distinct ids .* c1 for the first through c2 for the last; it has \["c3"\]/.test(error.message))
  const source = f.propose({ covers: ['c2'] })
  assert.deepEqual(f.runtime.store.get('tasks', source.id).covers, ['c2'])
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.propose({ kind: 'verification', reviewOf: source.id, checks: [], assigneeId: f.reviewer.id })
  const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  // While the first review runs, a second one may not widen what the source answers for.
  const refused = error => error.code === 'covers_invalid' && error.message === '[covers_invalid] A verification task checks what its source covers and cannot cover a criterion itself. Omit `covers` on the review; name the criterion in `covers` of a deliverable, or of a repair naming `replaces`, with `swarm_propose`, then retry.'
  assert.throws(() => f.propose({ kind: 'verification', reviewOf: source.id, checks: [], covers: ['c1'] }), refused)
  assert.equal(f.runtime.store.list('tasks', f.mission.id).length, 2, 'nothing was admitted')
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
  assert.match(completionError(f.runtime.boardOf(f.mission.id)), /: c1 "works"\. Propose a deliverable/, 'the review\'s text never covered c1')
})

test('the completion reason\'s exit, performed as it names it through the registered swarm_propose, makes the mission completable', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  const first = f.propose({ acceptance: [], covers: ['c1'] })
  await acceptThroughReview(f, first)
  assert.equal(completionError(f.runtime.boardOf(f.mission.id)), 'Accepted tasks do not cover every mission acceptance criterion: c2 "is documented". Propose a deliverable that names them in `covers` with `swarm_propose`; an accepted task cannot gain covers')
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
  const propose = async args => (await definitions.get('swarm_propose').execute({ missionId: f.mission.id, workstreamId: f.stream.id, scope: ['**'], outputs: [], ...args }, { signal: new AbortController().signal, agent: { id: f.owner.sessionId } })).result
  // A review cannot take the criterion on; its refusal names the same exit.
  await assert.rejects(propose({ title: 'Review again', objective: 'Review', kind: 'verification', reviewOf: first.id, covers: ['c2'] }), /^Error: \[covers_invalid\] .*name the criterion in `covers` of a deliverable/)
  const named = await propose({ title: 'Document it', objective: 'Document the change', kind: 'integration', dependencies: [first.id], covers: ['c2'], checks: ['test -d .'] })
  assert.deepEqual([named.acceptance, named.covers], [[], ['c2']], 'the exit needs no criterion text')
  await acceptThroughReview(f, named)
  assert.equal(completionError(f.runtime.boardOf(f.mission.id)), undefined)
})

test('each exit the bare-deliverable and covers refusals name is performed through the registered swarm_propose', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
  const propose = async args => (await definitions.get('swarm_propose').execute({ missionId: f.mission.id, workstreamId: f.stream.id, objective: 'Implement the scoped change', kind: 'implementation', scope: ['**'], checks: ['test -d .'], ...args },
    { signal: new AbortController().signal, agent: { id: f.owner.sessionId } })).result
  const tasks = () => f.runtime.store.list('tasks', f.mission.id).length
  const checklist = task => f.runtime.observe(f.actor(f.reviewer), f.mission.id, { taskId: task.id }).task.acceptance
  // A deliverable with no criteria at all: the refusal names three exits.
  await assert.rejects(propose({ title: 'Bare', outputs: [] }), error => error.message === '[task_acceptance_required] A new deliverable needs criteria. Pass `covers` with the ids of the mission criteria it satisfies (c1 is the mission\'s first acceptance item), or `acceptance` as its own nonempty criteria, with `swarm_propose`; or name the rejected task in `replaces` to inherit its criteria, then retry.')
  // An id that is unknown, repeated, or the criterion's text: one refusal, whose exit is each id once.
  for (const [covers, shown] of [[['c9'], '["c9"]'], [['c1', 'c1'], '["c1","c1"]'], [['works'], '["works"]']]) {
    await assert.rejects(propose({ title: 'Miscited', covers, outputs: [] }), error => error.message === `[covers_invalid] covers must list distinct ids of the mission acceptance criteria, c1 for the first through c2 for the last; it has ${shown}. Pass \`covers\` with each id this task satisfies once, never the criterion text, and retry the same task/request.`, shown)
  }
  assert.equal(tasks(), 0, 'no refusal admitted anything')
  const cited = await propose({ title: 'Cited', covers: ['c1'], outputs: [] })
  const own = await propose({ title: 'Own criteria', acceptance: ['keeps the API'], outputs: [] })
  assert.deepEqual([cited, own].map(task => [task.status, task.acceptance, task.covers]), [['pending', [], ['c1']], ['pending', ['keeps the API'], undefined]], 'covers alone and acceptance alone each admit a deliverable')
  // The third exit: a repair that names the rejected task needs no criteria of its own.
  await blockThroughReview(f, cited)
  const inheriting = await propose({ title: 'Repair', replaces: [cited.id] })
  assert.deepEqual([inheriting.status, inheriting.acceptance, inheriting.covers, checklist(inheriting)], ['pending', [], undefined, ['works']], 'it answers for what the task it replaces cited')
  // The review-covers refusal's other exit: the criterion no review may take on is cited by a repair naming `replaces`.
  await blockThroughReview(f, own)
  const citing = await propose({ title: 'Repair that also documents', replaces: [own.id], covers: ['c2'] })
  assert.deepEqual([citing.covers, checklist(citing)], [['c2'], ['is documented', 'keeps the API']])
  await acceptThroughReview(f, inheriting); await acceptThroughReview(f, citing)
  await acceptThroughReview(f, await propose({ title: 'Integrate', kind: 'integration', dependencies: [inheriting.id, citing.id], acceptance: ['merges both repairs'], outputs: [] }))
  assert.equal(completionError(f.runtime.boardOf(f.mission.id)), undefined, 'both criteria are covered by accepted repairs')
})

test('a repair answers for the ids its lineage cites, and a withdrawn deliverable\'s ids count for nothing', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  const original = f.propose({ covers: ['c1', 'c2'] })
  await blockThroughReview(f, original)
  const repair = f.propose({ title: 'Repair', replaces: [original.id], covers: undefined })
  assert.equal(repair.covers, undefined, 'the repair cites nothing itself')
  await acceptThroughReview(f, repair)
  assert.equal(f.runtime.store.get('tasks', original.id).status, 'cancelled')
  assert.equal(completionError(f.runtime.boardOf(f.mission.id)), undefined)
  const g = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(g.cleanup)
  await acceptThroughReview(g, g.propose({ covers: ['c1'] }))
  // Research needs no artifact, so nothing but its status keeps the withdrawn task from covering c2.
  g.runtime.cancel(g.owner, g.mission.id, { taskId: g.propose({ kind: 'research', checks: [], covers: ['c2'] }).id, reason: 'Withdrawn' })
  assert.match(completionError(g.runtime.boardOf(g.mission.id)), /criterion: c2 "is documented"\. /)
})

test('workers see criterion text, never bare ids; the owner reads the stored row with its covers, and a fresh overview maps each id to its criterion', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  const task = f.propose({ acceptance: ['has a test'], covers: ['c2'] })
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  const assignment = JSON.parse(f.runtime.store.list('deliveries', f.mission.id).find(delivery => delivery.kind === 'assignment').content).task
  assert.deepEqual(assignment.acceptance, ['is documented', 'has a test'])
  assert.equal('covers' in assignment, false)
  for (const record of [f.runtime.observe(f.actor(f.author), f.mission.id).current.task, f.runtime.observe(f.actor(f.author), f.mission.id, { taskId: task.id }).task]) {
    assert.deepEqual(record.acceptance, ['is documented', 'has a test']); assert.equal('covers' in record, false)
  }
  const owned = [f.runtime.observe(f.owner, f.mission.id, { taskId: task.id }).task, f.runtime.observe(f.owner, f.mission.id, { detail: 'full' }).board.find(row => row.id === task.id)]
  for (const record of owned) assert.deepEqual([record.acceptance, record.covers], [['has a test'], ['c2']], 'the owner reads the row it stored: the task\'s own criterion and the ids it cites')
  const overview = f.runtime.observe(f.owner, f.mission.id)
  assert.deepEqual(overview.mission.criteria, { c1: 'works', c2: 'is documented' }, 'and resolves each id through the map its fresh overview carries')
  assert.equal(f.runtime.observe(f.owner, f.mission.id, { cursor: overview.nextCursor }).mission.criteria, undefined, 'a delta omits the unchanging criteria')
})

test('a worker reads its checklist in every result of its own calls: the registered swarm_claim, swarm_submit and swarm_verify return the task as its assignment delivers it', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
  const call = async (name, member, args) => (await definitions.get(name).execute({ missionId: f.mission.id, ...args }, { signal: new AbortController().signal, agent: { id: member.sessionId } })).result
  // Neither row stores a criterion's text: the deliverable cites both ids, the review has no criteria of its own.
  const source = f.propose({ acceptance: [] })
  const review = f.propose({ kind: 'verification', reviewOf: source.id, checks: [], acceptance: [], assigneeId: f.reviewer.id })
  assert.deepEqual([source, review].map(task => [f.runtime.store.get('tasks', task.id).acceptance, f.runtime.store.get('tasks', task.id).covers]), [[[], ['c1', 'c2']], [[], undefined]])
  const assigned = taskId => JSON.parse(f.runtime.store.list('deliveries', f.mission.id).findLast(delivery => delivery.kind === 'assignment' && delivery.taskId === taskId).content).task
  const claimed = await call('swarm_claim', f.author, { taskId: source.id })
  assert.deepEqual(claimed, assigned(source.id), 'a claim returns the assignment it delivered')
  const submitted = await call('swarm_submit', f.author, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const reviewing = await call('swarm_claim', f.reviewer, { taskId: review.id })
  assert.deepEqual(reviewing, assigned(review.id))
  const verified = await call('swarm_verify', f.reviewer, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
  for (const [name, result] of Object.entries({ claimed, submitted, reviewing, verified })) {
    assert.deepEqual(result.acceptance, ['works', 'is documented'], `${name} lists the text of every criterion the task answers for`)
    assert.equal('covers' in result, false, `${name} carries no bare id`)
  }
  assert.deepEqual([submitted.status, verified.status, f.runtime.store.get('tasks', source.id).covers], ['submitted', 'accepted', ['c1', 'c2']], 'the stored rows keep the ids')
})

test('a member reads its checklist in the task its own swarm_propose returns: a review proposed with no criteria lists what its source must satisfy, and only the owner reads the stored row', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
  const propose = async (proposer, args) => (await definitions.get('swarm_propose').execute({ missionId: f.mission.id, workstreamId: f.stream.id, scope: ['**'], outputs: [], ...args }, { signal: new AbortController().signal, agent: { id: proposer.sessionId } })).result
  // The source only cites both ids; its author proposes the review with the fields a review needs and no criteria.
  const source = f.propose({ acceptance: [] })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = await propose(f.author, { title: 'Review', objective: 'Independent review', kind: 'verification', reviewOf: source.id, assigneeId: f.reviewer.id })
  assert.deepEqual([review.acceptance, 'covers' in review, f.runtime.store.get('tasks', review.id).acceptance], [['works', 'is documented'], false, []], 'the row stores none of the text the member reads')
  const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  assert.deepEqual(reviewing.acceptance, review.acceptance, 'the proposer read the checklist the reviewer is assigned')
  // A member that cites an id reads the criterion's text back; the owner, who decides coverage, reads the row it stored.
  const deliverable = { title: 'Document it', objective: 'Document the change', kind: 'research', acceptance: ['has an example'], covers: ['c2'] }
  const cited = await propose(f.author, deliverable)
  assert.deepEqual([cited.acceptance, 'covers' in cited, f.runtime.store.get('tasks', cited.id).covers], [['is documented', 'has an example'], false, ['c2']])
  const owned = await propose(f.owner, { ...deliverable, title: 'Document it again' })
  assert.deepEqual([owned.acceptance, owned.covers], [['has an example'], ['c2']])
})

// One projection per reader, whichever tool answers. `read` is what the caller's model reads: the rendered result of its own call.
function reader(f) {
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
  return async (name, caller, args = {}) => {
    const definition = definitions.get(name)
    const executed = await definition.execute({ missionId: f.mission.id, ...args }, { signal: new AbortController().signal, agent: { id: caller.sessionId } })
    return JSON.parse(definition.output.render(args, executed)[0].text).result
  }
}

test('the owner reads the stored row at every exit: a deliverable that only cites ids, and the repair that replaces it, read the same in the result of swarm_propose, swarm_control and swarm_cancel, in swarm_observe, in the snapshot and in swarm_registry', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  const read = reader(f)
  const proposal = { workstreamId: f.stream.id, title: 'Deliver', objective: 'Implement the scoped change', kind: 'implementation', scope: ['**'], outputs: [], checks: ['test -d .'], assigneeId: f.author.id }
  const criteria = row => [row.acceptance, row.covers, row.replaces]
  // Every read of one task that is not the result of a write: by id, on the full board, in the UI snapshot, and each registry row of its artifacts.
  const reads = async task => ({
    observe: [(await read('swarm_observe', f.owner, { taskId: task.id })).task],
    board: (await read('swarm_observe', f.owner, { detail: 'full' })).board.filter(row => row.id === task.id),
    snapshot: JSON.parse(JSON.stringify(f.runtime.snapshot(f.owner, f.mission.id))).tasks.filter(row => row.id === task.id),
    registry: (await read('swarm_registry', f.owner)).artifacts.filter(row => row.taskId === task.id),
  })
  const agree = async (task, written, stored) => {
    assert.deepEqual(criteria(f.runtime.store.get('tasks', task.id)), stored, 'the durable row')
    for (const [exit, rows] of Object.entries({ ...written, ...await reads(task) })) {
      assert.ok(rows.length > 0, `${task.title}: ${exit} returns the task`)
      for (const row of rows) assert.deepEqual(criteria(row), stored, `${task.title}: ${exit} reads the stored row`)
    }
  }
  // The deliverable stores no criterion text, only the ids it cites; a review rejects it.
  const original = await read('swarm_propose', f.owner, { ...proposal, acceptance: [], covers: ['c1', 'c2'] })
  await blockThroughReview(f, original)
  await agree(original, { propose: [original] }, [[], ['c1', 'c2'], undefined])
  // Its repair stores nothing but the lineage: no text, no id.
  const repair = await read('swarm_propose', f.owner, { ...proposal, title: 'Repair', replaces: [original.id] })
  const amended = await read('swarm_control', f.owner, { taskId: repair.id, action: 'amend', changes: { maxRecoveryAttempts: 3 }, reason: 'Allow one more recovery' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, repair.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: repair.id, attemptId: claimed.attempt.id, output: 'repaired candidate' })
  await agree(repair, { propose: [repair], amend: [amended] }, [[], undefined, [original.id]])
  const cancelled = await read('swarm_cancel', f.owner, { taskId: repair.id, reason: 'Withdrawn after the comparison' })
  await agree(repair, { cancel: [cancelled] }, [[], undefined, [original.id]])
  // The ids resolve through what the owner already holds: the criteria map of a fresh overview, and the mission list beside each registry row.
  assert.deepEqual((await read('swarm_observe', f.owner)).mission.criteria, { c1: 'works', c2: 'is documented' })
  for (const row of (await read('swarm_registry', f.owner)).artifacts) assert.deepEqual(row.missionAcceptance, ['works', 'is documented'])
})

test('a member reads its checklist and never an id at every exit: its assignment, the result of its own swarm_claim, swarm_propose, swarm_submit and swarm_verify, and every swarm_observe view of its task, its review source and another member\'s task', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  const read = reader(f)
  const keys = value => value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keys(item)]) : []
  const both = ['works', 'is documented']
  // Each task a member's call returned must list the criterion text, and nothing in the whole result may carry `covers`.
  const exit = async (name, member, args, task, checklist) => {
    const result = await read(name, member, args), shown = task(result)
    assert.deepEqual([shown.acceptance, keys(result).includes('covers')], [checklist, false], `${name} ${JSON.stringify(args)}`)
    return shown
  }
  const itself = result => result, current = result => result.current.task, byId = result => result.task
  // Neither row stores a criterion's text: the deliverable only cites both ids, and its repair only names it.
  const source = f.propose({ acceptance: [] })
  assert.equal((await read('swarm_observe', f.author)).current, null, 'the author\'s first read is the focused view, before any assignment')
  const claimed = await exit('swarm_claim', f.author, { taskId: source.id }, itself, both)
  await exit('swarm_observe', f.author, {}, current, both)
  await exit('swarm_observe', f.author, { taskId: source.id }, byId, both)
  const proposal = { workstreamId: f.stream.id, scope: ['**'], outputs: [] }
  await exit('swarm_propose', f.author, { ...proposal, title: 'Document it', objective: 'Document the change', kind: 'research', acceptance: ['has an example'], covers: ['c2'] }, itself, ['is documented', 'has an example'])
  const review = await exit('swarm_propose', f.author, { ...proposal, title: 'Review', objective: 'Independent review', kind: 'verification', reviewOf: source.id, assigneeId: f.reviewer.id }, itself, both)
  await exit('swarm_submit', f.author, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' }, itself, both)
  const reviewing = await exit('swarm_claim', f.reviewer, { taskId: review.id }, itself, both)
  await exit('swarm_observe', f.reviewer, {}, current, both)
  await exit('swarm_observe', f.reviewer, { taskId: source.id }, byId, both)
  await exit('swarm_verify', f.reviewer, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'reject', reason: 'The candidate does not document the change' }, itself, both)
  // The repair reaches its worker through the lineage alone, in the claim result and in the delta that names the changed assignment.
  const repair = f.propose({ title: 'Repair', replaces: [source.id], acceptance: undefined, covers: undefined })
  assert.deepEqual([f.runtime.store.get('tasks', repair.id).acceptance, f.runtime.store.get('tasks', repair.id).covers], [[], undefined])
  await exit('swarm_claim', f.author, { taskId: repair.id }, itself, both)
  assert.equal((await exit('swarm_observe', f.author, {}, current, both)).id, repair.id, 'the delta carries the new assignment')
  const assignments = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.kind === 'assignment').map(delivery => JSON.parse(delivery.content))
  assert.deepEqual(assignments.map(body => [body.task.id, body.task.acceptance, keys(body).includes('covers')]), [source, review, repair].map(task => [task.id, both, false]), 'each assignment delivers the same checklist')
  assert.deepEqual(f.runtime.store.get('tasks', source.id).covers, ['c1', 'c2'], 'the ids stay on the stored row, for the owner')
})

test('a reviewer reads its source as it reads its own task: observe().current.reviewSource lists the source\'s checklist and carries no covers, in the delta that names the new assignment and in the focused view', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  // The source cites c2 beside its own criterion; the review adds one of its own.
  const source = f.propose({ acceptance: ['adds a test'], covers: ['c2'] })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.propose({ kind: 'verification', reviewOf: source.id, checks: [], acceptance: ['reads the diff'], assigneeId: f.reviewer.id })
  assert.equal(f.runtime.observe(f.actor(f.reviewer), f.mission.id).current, null, 'the reviewer\'s first read precedes its assignment')
  await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  const delta = f.runtime.observe(f.actor(f.reviewer), f.mission.id), focused = f.runtime.observe(f.actor(f.reviewer), f.mission.id, { after: 0 })
  assert.deepEqual([delta.delta, focused.delta, focused.member.id], [true, undefined, f.reviewer.id])
  for (const [name, view] of Object.entries({ delta, focused })) {
    const shown = view.current.reviewSource
    assert.deepEqual([shown.id, shown.status, shown.acceptance, 'covers' in shown], [source.id, 'submitted', ['is documented', 'adds a test'], false], `${name}: the source's checklist, the cited criterion as text before its own, and no id`)
    assert.deepEqual([view.current.task.acceptance, 'covers' in view.current.task], [['is documented', 'adds a test', 'reads the diff'], false], `${name}: the review checks that list, then its own criterion`)
  }
  assert.deepEqual([f.runtime.store.get('tasks', source.id).acceptance, f.runtime.store.get('tasks', source.id).covers], [['adds a test'], ['c2']], 'the stored source keeps its own criterion and the id')
})

test('a budget resume delivers the task as its first assignment did: a deliverable that only cites ids and a review with no criteria of its own read the criterion text again, never a bare id', async t => {
  for (const reviewing of [false, true]) {
    const clock = new FakeClock(), f = await setup({ clock, budget: { maxTokens: 40, maxSteps: 100 }, acceptance: ['works', 'is documented'] })
    t.after(f.cleanup)
    // Neither row stores a criterion's text.
    const source = f.propose({ acceptance: [] })
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
    let task = source, member = f.author
    if (reviewing) {
      await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
      task = f.propose({ kind: 'verification', reviewOf: source.id, checks: [], acceptance: [], assigneeId: f.reviewer.id }); member = f.reviewer
      await f.runtime.claim(f.actor(member), f.mission.id, task.id)
    }
    const pass = async () => { await f.runtime.tick(); await f.runtime.settle(f.mission.id) }
    // A usage report exhausts maxTokens and the mission quiesces; the owner raises the ceiling and resumes the same attempt.
    await f.workers.callbacks.usage(member.id, 40)
    await pass(); await pass()
    assert.equal(f.runtime.mission(f.mission.id).budgetPause?.quiesced, true, 'the exhausted mission quiesced')
    f.runtime.updateBudget(f.owner, f.mission.id, { ...budget, maxTokens: 100_000 }, 'Raise the exhausted ceiling')
    f.runtime.control(f.owner, f.mission.id, 'resume', 'Budget raised')
    await pass(); await pass()
    const [first, resumed, ...others] = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.kind === 'assignment' && delivery.taskId === task.id).map(delivery => JSON.parse(delivery.content))
    assert.deepEqual([others, resumed.instructions.startsWith('Resume this same task and attempt'), resumed.task.attempt.id], [[], true, first.task.attempt.id], 'the same attempt is assigned again')
    assert.deepEqual([first.task.acceptance, resumed.task.acceptance], [['works', 'is documented'], ['works', 'is documented']], `${task.kind}: the resume lists the text its first assignment listed`)
    assert.deepEqual([Object.keys(resumed), Object.keys(resumed.task).sort()], [Object.keys(first), Object.keys(first.task).sort()], 'and is the same view of the task, with no bare id')
    assert.equal('covers' in resumed.task, false)
    assert.deepEqual(f.runtime.store.get('tasks', source.id).covers, ['c1', 'c2'], 'the stored deliverable keeps the ids')
  }
})

test('the propose guard reads only the proposal\'s own objective and acceptance: a prior-work criterion of its own needs a dependency, while the same kind of criterion cited by id from the mission, or inherited from the task a repair replaces, is admitted without one', async t => {
  // The mission itself states a prior-work criterion, as c1.
  const prior = 'The parser from the prior work is already in the worktree and still passes'
  const f = await setup({ clock: new FakeClock(), acceptance: [prior, 'the reader is wired into the command'] })
  t.after(f.cleanup)
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
  const propose = async args => (await definitions.get('swarm_propose').execute({ missionId: f.mission.id, workstreamId: f.stream.id, objective: 'Wire the reader into the command', kind: 'implementation', scope: ['**'], checks: ['test -d .'], outputs: [], ...args },
    { signal: new AbortController().signal, agent: { id: f.owner.sessionId } })).result
  const tasks = () => f.runtime.store.list('tasks', f.mission.id).length
  const checklist = task => f.runtime.observe(f.actor(f.author), f.mission.id, { taskId: task.id }).task.acceptance
  // Its own: the proposal states the assumption, so it needs the dependency that carries that work.
  const inherited = 'The lexer from the prior work is already in the worktree and still passes'
  for (const own of [prior, inherited]) await assert.rejects(propose({ title: 'Assumes prior work', acceptance: [own] }), error => error.message.startsWith('[dependency_assumption_missing] task: the acceptance[0] assumes '))
  assert.equal(tasks(), 0, 'nothing was admitted')
  // Cited: the mission states c1 and the proposal states nothing, so it is admitted with no dependency; its worker reads the text.
  const citing = await propose({ title: 'Parser', covers: ['c1'] })
  assert.deepEqual([citing.status, citing.acceptance, citing.covers, citing.dependencies, checklist(citing)], ['pending', [], ['c1'], [], [prior]])
  // Inherited, as the replaced task's own criterion: the repair drops the dependency and states no such criterion itself.
  const original = await propose({ title: 'Reader', acceptance: [inherited], dependencies: [citing.id] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'Withdrawn for a narrower repair' })
  const repair = await propose({ title: 'Reader repair', acceptance: ['unrelated'], replaces: [original.id] })
  assert.deepEqual([repair.status, repair.acceptance, repair.dependencies, checklist(repair)], ['pending', ['unrelated'], [], ['unrelated', inherited]], 'its worker still checks the criterion it inherits')
  // Inherited, as an id the replaced task cited: the repair states nothing at all.
  f.runtime.cancel(f.owner, f.mission.id, { taskId: citing.id, reason: 'Withdrawn for a repair' })
  const reciting = await propose({ title: 'Parser repair', replaces: [citing.id] })
  assert.deepEqual([reciting.status, reciting.acceptance, reciting.covers, reciting.dependencies, checklist(reciting)], ['pending', [], undefined, [], [prior]])
})

test('a staged mission\'s criteria are fixed: a repair may change covers and task criteria, never the mission list', async t => {
  const workers = new FakeWorkers()
  const { dir, runtime } = await makeRuntime(t, { workers, config: { tickMs: 60000, checkTimeoutMs: undefined } })
  const owner = { sessionId: 'owner' }, claim = { grantRoot: dir, source: 'session' }
  // The assembly fails after the mission and the deliverable exist, leaving both staged.
  const propose = runtime.propose.bind(runtime)
  runtime.propose = (...args) => { const task = propose(...args); if (task.kind === 'verification') throw new Error('assembly fixture failure'); return task }
  const draft = runtime.createDraft(owner, plan(dir), claim)
  await assert.rejects(runtime.launchDraft(owner, draft.id, draft.revision), /assembly fixture failure/)
  runtime.propose = propose
  const failed = runtime.drafts(owner)[0]
  const refused = error => error.code === 'draft_repair_criteria_changed' && error.message.startsWith(`[draft_repair_criteria_changed] Mission ${failed.missionId} is staged, so its acceptance criteria are fixed: ["works","is documented"]. Resend \`acceptance\` unchanged`)
  for (const acceptance of [['works', 'is documented', 'appended'], ['is documented', 'works'], ['works', 'is documented well']]) {
    assert.throws(() => runtime.updateDraft(owner, failed.id, failed.revision, { ...failed.input, acceptance }, claim), refused, JSON.stringify(acceptance))
  }
  const edited = structuredClone(failed.input)
  edited.tasks[0].covers = ['c2']; edited.tasks[0].acceptance = ['keeps the API']; edited.tasks[1].covers = ['c1']
  const repaired = runtime.updateDraft(owner, failed.id, failed.revision, edited, claim)
  const launched = await runtime.launchDraft(owner, repaired.id, repaired.revision)
  const code = launched.tasks.find(task => task.kind === 'implementation')
  assert.deepEqual([code.covers, code.acceptance], [['c2', 'c1'], ['keeps the API']], 'the staged row takes the repaired covers and criteria')
  assert.deepEqual(taskGraphIndex(launched.tasks).checklist(code.id, launched.mission.acceptance), ['works', 'is documented', 'keeps the API'], 'its checklist lists them in mission order')
  assert.deepEqual(launched.mission.acceptance, ['works', 'is documented'])
})

test('model-visible schemas name criteria by id, and covers is declared but never universally required', () => {
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, makeRuntimeStub(), budget)
  for (const name of ['swarm_stage', 'swarm_launch']) {
    const task = definitions.get(name).parameters.properties.tasks.items
    assert.match(task.properties.covers.description, /^Ids of the mission acceptance criteria this task satisfies \(c1 is the first\)/)
    assert.equal(task.required.includes('covers'), false, `${name} requires only what admission requires of every task`)
    assert.match(definitions.get(name).parameters.properties.acceptance.description, /numbered c1, c2, … in this order/)
  }
  assert.match(definitions.get('swarm_create').parameters.properties.acceptance.description, /numbered c1, c2, … in this order/)
  assert.match(definitions.get('swarm_propose').parameters.properties.covers.description, /^Deliverables only: .*Refused on a verification task/)
  assert.ok(OWNER_PROMPT.includes(' Several implementation branches need an integration depending on all of them. Acceptance criteria are c1, c2, … in order; deliverables cite ids they satisfy in covers, never text; cover every id. Declare files a task writes in outputs per schema;'), 'the owner protocol tells the planner to cite every criterion by id, among its planning rules')
  assert.doesNotMatch(OWNER_PROMPT, /verbatim|paraphrase/)
  assert.doesNotMatch(JSON.stringify([...definitions.values()].map(definition => definition.parameters)), /copied exactly|paraphrase does not match/)
})

// Rows as a v3 build wrote them: each deliverable copied the criteria it covered as text.
const PRIOR = 'The parser from the prior work is already in the worktree and still passes'
const v3Mission = (id, acceptance) => ({ id, ownerSessionId: 'owner', workspace: '/repo', title: id, objective: id, scope: ['**'], acceptance, status: 'active', budget, usedTokens: 0, usedSteps: 0, createdAt: 1, updatedAt: 1, deadline: 9e15 })
const v3Task = (id, missionId, kind, status, acceptance, extra = {}) => ({ id, missionId, workstreamId: 's', title: id, objective: id, kind, status, dependencies: [], scope: ['**'], acceptance, checks: [], priority: 50, experiment: false, epoch: 0, evidenceIds: [], createdAt: 1, ...extra })
function writeV3(path, version = 3) {
  const db = new DatabaseSync(path)
  const insert = (table, row) => db.prepare(`INSERT INTO ${table}(id,mission_id,value) VALUES(?,?,?)`).run(row.id, row.missionId ?? row.id, JSON.stringify(row))
  for (const row of [v3Mission('done', ['a1', 'a2']), v3Mission('stalled', ['b1', 'b2']), v3Mission('repaired', ['p1', 'p2']), v3Mission('guarded', [PRIOR]), v3Mission('inherited', ['m1'])]) insert('missions', row)
  for (const row of [
    v3Task('t1', 'done', 'research', 'accepted', ['a1', 'own']), v3Task('t2', 'done', 'research', 'accepted', ['a2']),
    v3Task('r1', 'done', 'verification', 'accepted', ['a1', 'own'], { reviewOf: 't1' }),
    v3Task('u1', 'stalled', 'research', 'accepted', ['b1']), v3Task('ru', 'stalled', 'verification', 'accepted', ['b1', 'b2'], { reviewOf: 'u1' }),
    // A repair admitted before acceptance inheritance: it stored only its own list.
    v3Task('p', 'repaired', 'research', 'cancelled', ['p1', 'p2']), v3Task('q', 'repaired', 'research', 'accepted', ['p1'], { replaces: ['p'] }),
    // A pending deliverable that copied a criterion assuming prior work, and the task that carries that work.
    v3Task('carrier', 'guarded', 'research', 'accepted', ['own']), v3Task('g', 'guarded', 'implementation', 'pending', [PRIOR], { dependencies: ['carrier'] }),
    // A repair as a v3 build stored it: every criterion of the task it replaces, then the one its proposal added; and the review the host added with a copy of that list.
    v3Task('dep', 'inherited', 'research', 'accepted', ['dep own']), v3Task('h1', 'inherited', 'implementation', 'blocked', ['m1', PRIOR], { dependencies: ['dep'] }),
    v3Task('h2', 'inherited', 'implementation', 'pending', ['m1', PRIOR, 'extra'], { dependencies: ['dep'], replaces: ['h1'] }),
    v3Task('hr', 'inherited', 'verification', 'pending', ['m1', PRIOR, 'extra'], { reviewOf: 'h2' }),
  ]) insert('tasks', row)
  insert('drafts', { id: 'draft', ownerSessionId: 'owner', revision: 1, status: 'draft', createdAt: 1, updatedAt: 1,
    input: { ...plan('/repo'), acceptance: ['x1', 'x2'], tasks: [{ ...plan('/repo').tasks[0], acceptance: ['x2', 'own'], covers: undefined }, { ...plan('/repo').tasks[1], acceptance: ['x1', 'x2'], covers: undefined },
      // A second deliverable that copied a criterion: every task of a draft is cited, not only the first that changes.
      { ...plan('/repo').tasks[0], key: 'docs', title: 'Docs', acceptance: ['x1', 'docs own'], covers: undefined }] } })
  db.exec(`PRAGMA user_version=${version}`)
  db.close()
}

test('a v3 store cites the criteria its deliverables copied, once at open, and keeps every completion verdict the copies decided', async t => {
  const { dir, config, runtime } = await makeRuntime(t)
  await runtime.dispose()
  writeV3(config.statePath)
  copyFileSync(config.statePath, join(dir, 'v3.sqlite'))
  const opened = new SwarmRuntime(config, new FakeWorkers())
  t.after(() => opened.dispose())
  const covers = id => opened.store.get('tasks', id).covers
  assert.deepEqual(['t1', 't2', 'r1', 'u1', 'ru', 'p', 'q'].map(covers), [['c1'], ['c2'], undefined, ['c1'], undefined, ['c1', 'c2'], undefined], 'a repair cites nothing its lineage already cites')
  assert.deepEqual(['t1', 'r1', 'ru', 'q', 'g'].map(id => opened.store.get('tasks', id).acceptance), [['own'], [], ['b2'], [], []], 'a cited criterion leaves the own list; a review keeps only what its source does not supply')
  assert.deepEqual(taskGraphIndex(opened.store.list('tasks', 'done')).checklist('t1', ['a1', 'a2']), ['a1', 'own'], 'what its worker and reviewers check is unchanged')
  // The amend guard reads the migrated row's own criteria, as it reads a v4 row that cites the same id.
  assert.deepEqual(opened.controlTask({ sessionId: 'owner' }, 'guarded', 'g', 'amend', { dependencies: [] }, 'the criterion is cited, not copied').dependencies, [])
  assert.equal(opened.store.get('tasks', 't1').revision, undefined, 'the upgrade is not a task write')
  assert.deepEqual(opened.store.get('drafts', 'draft').input.tasks.map(task => [task.key, task.covers, task.acceptance]), [['code', ['c2'], ['own']], ['review', undefined, ['x1']], ['docs', ['c1'], ['docs own']]],
    'both draft deliverables cite what they copied and keep only their own text; the review keeps only its review-only text')
  const reason = id => completionError(opened.boardOf(id))
  assert.equal(reason('done'), undefined, 'covered before, covered after')
  assert.match(reason('stalled'), /criterion: c2 "b2"\. /, 'uncovered before, uncovered after; a review\'s text still covers nothing')
  // The one change: a repair admitted before inheritance answers for what it replaced.
  assert.equal(reason('repaired'), undefined)
  const probe = new DatabaseSync(config.statePath, { readOnly: true })
  assert.equal(probe.prepare('PRAGMA user_version').get().user_version, 8)
  probe.close()
  // Once: an upgraded store is not cited again. A v4 deliverable may hold a criterion's text as its own and cite nothing;
  // reopening leaves that row as it is and moves no state revision.
  opened.store.transaction(() => { const { covers: _cited, ...row } = opened.store.get('tasks', 't2'); opened.store.put('tasks', { ...row, acceptance: ['a2'] }) })
  await opened.dispose()
  // Read from the closed file: whatever the runtime wrote while it ran is behind this revision.
  const closed = new DatabaseSync(config.statePath, { readOnly: true })
  const revision = Number(closed.prepare('SELECT revision FROM state_revision WHERE id=1').get().revision)
  closed.close()
  const reopened = new SwarmRuntime(config, new FakeWorkers())
  t.after(() => reopened.dispose())
  const kept = reopened.store.get('tasks', 't2')
  assert.deepEqual([kept.acceptance, kept.covers, reopened.store.revision()], [['a2'], undefined, revision], 'the text stays its own, uncited, and nothing was written')
  await reopened.dispose()
  // Restoring a v3 snapshot, or an unversioned one, upgrades it the same way.
  for (const version of [3, 0]) {
    const snapshot = join(dir, `v${version}.sqlite`)
    if (version === 0) { copyFileSync(join(dir, 'v3.sqlite'), snapshot); const db = new DatabaseSync(snapshot); db.exec('PRAGMA user_version=0'); db.close() }
    SwarmStore.restore(config.statePath, snapshot)
    const restored = new SwarmRuntime(config, new FakeWorkers())
    assert.deepEqual(restored.store.get('tasks', 't1').covers, ['c1'], `v${version}`)
    await restored.dispose()
  }
  // A store from a later schema fails closed, as a v3 build refuses this one.
  const future = new DatabaseSync(config.statePath); future.exec('PRAGMA user_version=9'); future.close()
  assert.throws(() => new SwarmRuntime(config, new FakeWorkers()), /Unsupported swarm schema 9; expected 8/)
})

test('the v4 upgrade leaves every row as a v4 build would have written it: a repair keeps only the criteria its proposal added and a review only its review-only ones, so the amend guard answers the same whatever the row\'s age', async t => {
  const { config, runtime } = await makeRuntime(t)
  await runtime.dispose()
  writeV3(config.statePath)
  const opened = new SwarmRuntime(config, new FakeWorkers())
  t.after(() => opened.dispose())
  const stored = id => { const { acceptance, covers } = opened.store.get('tasks', id); return [acceptance, covers] }
  // What a v4 swarm_propose stores for the same three proposals: the original cites c1 beside its own criterion, the repair names it in `replaces` and adds one, the review copies nothing.
  assert.deepEqual(['h1', 'h2', 'hr'].map(stored), [[[PRIOR], ['c1']], [['extra'], undefined], [[], undefined]])
  const graph = taskGraphIndex(opened.store.list('tasks', 'inherited'))
  for (const id of ['h2', 'hr']) assert.deepEqual(graph.checklist(id, ['m1']), ['m1', 'extra', PRIOR], `${id}: its worker still checks every criterion the v3 row listed`)
  // The repair no longer holds the inherited criterion that assumes prior work, so dropping its dependency is admitted, as it is for a v4 repair that only inherits it.
  assert.deepEqual(opened.controlTask({ sessionId: 'owner' }, 'inherited', 'h2', 'amend', { dependencies: [] }, 'the criterion is inherited, not its own').dependencies, [])
  // The original states that criterion itself and is carried by its repair, so it is not amended at all.
  assert.throws(() => opened.controlTask({ sessionId: 'owner' }, 'inherited', 'h1', 'amend', { dependencies: [] }, 'carried'), error => error.code === 'task_replaced')
})

test('the v4 upgrade commits like any other change: a draft it rewrites, by citing an id or only by dropping a review\'s copy of its source, moves to its next revision, so a page that still holds the v3 draft cannot save over it, and the state cursor names what changed', async t => {
  const clock = new FakeClock()
  const { dir, config, runtime } = await makeRuntime(t, { clock })
  await runtime.dispose()
  writeV3(config.statePath)
  // Beside the draft that copied a criterion, two that copied none. In `echoed` the review holds a copy of its source's own
  // criterion, which its checklist takes from that source; in `plain` every task holds only its own, and the upgrade leaves it as it is.
  const db = new DatabaseSync(config.statePath)
  const held = JSON.parse(db.prepare('SELECT value FROM drafts WHERE id=?').get('draft').value)
  const holding = (id, own) => ({ ...held, id, input: { ...held.input, tasks: held.input.tasks.map(task => ({ ...task, acceptance: [own(task)] })) } })
  const echoed = holding('echoed', () => 'own'), plain = holding('plain', task => task.kind === 'verification' ? 'reads the diff' : 'own')
  for (const draft of [echoed, plain]) db.prepare('INSERT INTO drafts(id,mission_id,value) VALUES(?,?,?)').run(draft.id, draft.id, JSON.stringify(draft))
  const before = Number(db.prepare('SELECT revision FROM state_revision WHERE id=1').get().revision)
  db.close()
  clock.advance(5000)
  const opened = new SwarmRuntime(config, new FakeWorkers())
  t.after(() => opened.dispose())
  const owner = { sessionId: 'owner' }, claim = { grantRoot: dir, source: 'session' }
  const upgraded = opened.store.get('drafts', 'draft')
  assert.deepEqual([upgraded.revision, upgraded.updatedAt, upgraded.input.tasks[0].covers], [held.revision + 1, clock.now(), ['c2']], 'the rewritten draft is a new revision, written at the upgrade')
  const dropped = opened.store.get('drafts', 'echoed')
  assert.deepEqual([dropped.revision, dropped.updatedAt, dropped.input.tasks.map(task => [task.key, task.acceptance, task.covers])], [held.revision + 1, clock.now(), [['code', ['own'], undefined], ['review', [], undefined], ['docs', ['own'], undefined]]],
    'a draft in which only the review changed is rewritten too: the review keeps nothing its source supplies, and no deliverable cites anything')
  assert.deepEqual(opened.store.get('drafts', 'plain'), plain, 'a draft whose tasks hold only their own criteria is not rewritten')
  // What the open page sends: the revision and the plan it loaded before the restart.
  for (const stale of [held, echoed]) assert.throws(() => opened.updateDraft(owner, stale.id, stale.revision, stale.input, claim), error => error.code === 'draft_revision_conflict', stale.id)
  assert.deepEqual(opened.store.get('drafts', 'draft').input.tasks[0].covers, ['c2'], 'the cited ids survive the stale save')
  assert.deepEqual(opened.store.get('drafts', 'echoed'), dropped, 'and so does the review that copies nothing')
  // The page's watch cursor is the revision it last saw: the upgrade is one change after it, naming the owner and each mission whose rows it rewrote.
  assert.equal(opened.store.revision(), before + 1)
  const [change, ...more] = opened.store.changesSince(before)
  assert.deepEqual([change.revision, [...change.scopes].sort(), more], [before + 1, ['done', 'draft', 'echoed', 'guarded', 'inherited', 'owner', 'repaired', 'stalled'], []])
  await opened.dispose()
  // Once: reopening the upgraded store rewrites nothing and moves no cursor.
  const reopened = new SwarmRuntime(config, new FakeWorkers())
  t.after(() => reopened.dispose())
  assert.deepEqual([reopened.store.revision(), reopened.store.get('drafts', 'draft').revision], [before + 1, held.revision + 1])
})

test('a staged mission a v3 build left behind a longer saved draft takes that draft\'s criteria at the upgrade, so its relaunch goes through', async t => {
  const { dir, config, runtime } = await makeRuntime(t, { config: { tickMs: 60000, checkTimeoutMs: undefined } })
  const owner = { sessionId: 'owner' }, claim = { grantRoot: dir, source: 'session' }
  const propose = runtime.propose.bind(runtime)
  runtime.propose = (...args) => { const task = propose(...args); if (task.kind === 'verification') throw new Error('assembly fixture failure'); return task }
  const input = plan(dir); input.acceptance = ['works']; input.tasks[0].covers = ['c1']; delete input.tasks[1].covers
  const draft = runtime.createDraft(owner, input, claim)
  await assert.rejects(runtime.launchDraft(owner, draft.id, draft.revision), /assembly fixture failure/)
  runtime.propose = propose
  await runtime.dispose()
  // What a v3 build saved next: a repair appended a criterion the deliverable copied, and no row cites an id.
  // Its relaunch would have written the draft's criteria onto the staged mission.
  const db = new DatabaseSync(config.statePath)
  const rows = table => db.prepare(`SELECT value FROM ${table}`).all().map(row => JSON.parse(row.value))
  const [saved] = rows('drafts')
  saved.input.acceptance = ['works', 'is documented']
  saved.input.tasks = saved.input.tasks.map(({ covers: _cited, ...task }) => task.kind === 'verification' ? task : { ...task, acceptance: ['works', 'is documented'] })
  db.prepare('UPDATE drafts SET value=? WHERE id=?').run(JSON.stringify(saved), saved.id)
  for (const { covers: _cited, ...task } of rows('tasks')) db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify(task), task.id)
  db.exec('PRAGMA user_version=3'); db.close()
  const opened = new SwarmRuntime(config, new FakeWorkers())
  t.after(() => opened.dispose())
  assert.deepEqual(opened.store.get('missions', saved.missionId).acceptance, ['works', 'is documented'], 'the staged mission takes the criteria its relaunch would have written')
  const upgraded = opened.drafts(owner)[0]
  assert.deepEqual(upgraded.input.tasks.map(task => [task.covers, task.acceptance]), [[['c1', 'c2'], []], [undefined, ['reads the diff']]])
  const launched = await opened.launchDraft(owner, upgraded.id, upgraded.revision)
  assert.deepEqual([launched.mission.status, launched.mission.acceptance], ['active', ['works', 'is documented']])
  assert.deepEqual(launched.tasks.find(task => task.kind === 'implementation').covers, ['c1', 'c2'])
  // Without the mission write the relaunch went through silently on the shorter list, and c2 named no criterion.
  const minted = launched.mission.acceptance.map((_, index) => criterionId(index))
  assert.deepEqual(launched.tasks.flatMap(task => task.covers ?? []).filter(id => !minted.includes(id)), [], 'every cited id names a mission criterion')
})
