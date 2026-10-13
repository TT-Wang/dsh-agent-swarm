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
import { guardActions, guardBoard, guardTerminalChain } from './guard-model.mjs'
import { assessText, toolSchemaIndex } from './refusal-inventory.mjs'

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

test('an authored review is assigned and shown everything its source must satisfy, then its own criteria, and the registry lists each checklist', async t => {
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
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id, { taskId: review.id }).task.acceptance, checklist, 'and the owner reads them')
  assert.deepEqual(f.runtime.store.get('tasks', review.id).acceptance, ['reads the diff'], 'nothing is copied onto the stored review')
  const registered = f.runtime.artifacts(f.owner, { missionId: f.mission.id }).artifacts.find(row => row.taskId === source.id)
  assert.deepEqual([registered.acceptance, registered.missionAcceptance], [['value is two', 'adds a test'], ['value is two']], 'the registry row carries the source\'s checklist')
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
    && error.message === '[plan_task_acceptance_required] tasks[0] (code) has neither covers nor acceptance. Add to `covers` the mission criterion ids it satisfies, or give it its own `acceptance`, and relaunch the complete plan.')
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
  assert.match(f.runtime.completionError(f.runtime.mission(f.mission.id)), /: c1 "works"\. Propose a deliverable/, 'the review\'s text never covered c1')
})

test('the completion reason\'s exit, performed as it names it through the registered swarm_propose, makes the mission completable', async t => {
  const f = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(f.cleanup)
  const first = f.propose({ acceptance: [], covers: ['c1'] })
  await acceptThroughReview(f, first)
  assert.equal(f.runtime.completionError(f.runtime.mission(f.mission.id)), 'Accepted tasks do not cover every mission acceptance criterion: c2 "is documented". Propose a deliverable that names them in `covers` with `swarm_propose`; an accepted task cannot gain covers')
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
  const propose = async args => (await definitions.get('swarm_propose').execute({ missionId: f.mission.id, workstreamId: f.stream.id, scope: ['**'], outputs: [], ...args }, { signal: new AbortController().signal, agent: { id: f.owner.sessionId } })).result
  // A review cannot take the criterion on; its refusal names the same exit.
  await assert.rejects(propose({ title: 'Review again', objective: 'Review', kind: 'verification', reviewOf: first.id, covers: ['c2'] }), /^Error: \[covers_invalid\] .*name the criterion in `covers` of a deliverable/)
  const named = await propose({ title: 'Document it', objective: 'Document the change', kind: 'integration', dependencies: [first.id], covers: ['c2'], checks: ['test -d .'] })
  assert.deepEqual([named.acceptance, named.covers], [[], ['c2']], 'the exit needs no criterion text')
  await acceptThroughReview(f, named)
  assert.equal(f.runtime.completionError(f.runtime.mission(f.mission.id)), undefined)
})

test('the review-admission terminal names the fields a review needs, and its exit performed through the registered swarm_propose admits a review with no acceptance', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const source = f.propose({ title: 'Submitted source' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  for (const review of f.runtime.store.list('tasks', f.mission.id).filter(task => task.reviewOf === source.id)) f.runtime.cancel(f.owner, f.mission.id, { taskId: review.id, reason: 'Withdraw the review path' })
  const [terminal, ...others] = guardActions(guardBoard(f.runtime, f.mission.id))
  assert.deepEqual([terminal.chain, others], ['review_admission', []])
  assert.equal(terminal.message, `[review_admission_terminal] Submitted work ${source.id} has no live independent review path, so no verdict can ever land. Admit a review with \`swarm_propose\` by passing \`kind\`, \`reviewOf\`, \`scope\` and \`outputs\` ([] for a review), or withdraw the source with \`swarm_cancel\` and its \`taskId\`.`)
  assert.deepEqual(assessText(terminal.message, await toolSchemaIndex()), [], 'it names only tools and parameters the published schemas declare')
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
  // Exactly the fields it names, beside the ones every proposal carries; no criteria of its own.
  const review = (await definitions.get('swarm_propose').execute({ missionId: f.mission.id, workstreamId: f.stream.id, title: 'Review', objective: 'Independent review',
    kind: 'verification', reviewOf: source.id, scope: ['**'], outputs: [] }, { signal: new AbortController().signal, agent: { id: f.owner.sessionId } })).result
  assert.deepEqual([review.reviewOf, review.acceptance, review.status], [source.id, [], 'pending'])
  assert.notEqual(guardTerminalChain(guardBoard(f.runtime, f.mission.id)), 'review_admission', 'the source has a live review path again')
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
  assert.equal(f.runtime.completionError(f.runtime.mission(f.mission.id)), undefined)
  const g = await setup({ clock: new FakeClock(), acceptance: ['works', 'is documented'] })
  t.after(g.cleanup)
  await acceptThroughReview(g, g.propose({ covers: ['c1'] }))
  g.runtime.cancel(g.owner, g.mission.id, { taskId: g.propose({ covers: ['c2'] }).id, reason: 'Withdrawn' })
  assert.match(g.runtime.completionError(g.runtime.mission(g.mission.id)), /criterion: c2 "is documented"\. /)
})

test('workers see criterion text, never bare ids; the owner also reads each task\'s covers and a fresh overview maps each id to its criterion', async t => {
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
  for (const record of owned) assert.deepEqual([record.acceptance, record.covers], [['is documented', 'has a test'], ['c2']], 'the owner who cites ids reads them beside their text')
  const overview = f.runtime.observe(f.owner, f.mission.id)
  assert.deepEqual(overview.mission.criteria, { c1: 'works', c2: 'is documented' })
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
  assert.deepEqual(runtime.observe(owner, launched.mission.id, { taskId: code.id }).task.acceptance, ['works', 'is documented', 'keeps the API'], 'its checklist lists them in mission order')
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
  for (const row of [v3Mission('done', ['a1', 'a2']), v3Mission('stalled', ['b1', 'b2']), v3Mission('repaired', ['p1', 'p2']), v3Mission('guarded', [PRIOR])]) insert('missions', row)
  for (const row of [
    v3Task('t1', 'done', 'research', 'accepted', ['a1', 'own']), v3Task('t2', 'done', 'research', 'accepted', ['a2']),
    v3Task('r1', 'done', 'verification', 'accepted', ['a1', 'own'], { reviewOf: 't1' }),
    v3Task('u1', 'stalled', 'research', 'accepted', ['b1']), v3Task('ru', 'stalled', 'verification', 'accepted', ['b1', 'b2'], { reviewOf: 'u1' }),
    // A repair admitted before acceptance inheritance: it stored only its own list.
    v3Task('p', 'repaired', 'research', 'cancelled', ['p1', 'p2']), v3Task('q', 'repaired', 'research', 'accepted', ['p1'], { replaces: ['p'] }),
    // A pending deliverable that copied a criterion assuming prior work, and the task that carries that work.
    v3Task('carrier', 'guarded', 'research', 'accepted', ['own']), v3Task('g', 'guarded', 'implementation', 'pending', [PRIOR], { dependencies: ['carrier'] }),
  ]) insert('tasks', row)
  insert('drafts', { id: 'draft', ownerSessionId: 'owner', revision: 1, status: 'draft', createdAt: 1, updatedAt: 1,
    input: { ...plan('/repo'), acceptance: ['x1', 'x2'], tasks: [{ ...plan('/repo').tasks[0], acceptance: ['x2', 'own'], covers: undefined }, { ...plan('/repo').tasks[1], acceptance: ['x1', 'x2'], covers: undefined }] } })
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
  assert.deepEqual(['t1', 't2', 'r1', 'u1', 'ru', 'p', 'q'].map(covers), [['c1'], ['c2'], undefined, ['c1'], undefined, ['c1', 'c2'], ['c1']])
  assert.deepEqual(['t1', 'r1', 'q', 'g'].map(id => opened.store.get('tasks', id).acceptance), [['own'], ['a1', 'own'], [], []], 'a cited criterion leaves the own list; a review keeps its text')
  assert.deepEqual(taskGraphIndex(opened.store.list('tasks', 'done')).checklist('t1', ['a1', 'a2']), ['a1', 'own'], 'what its worker and reviewers check is unchanged')
  // The amend guard reads the migrated row's own criteria, as it reads a v4 row that cites the same id.
  assert.deepEqual(opened.controlTask({ sessionId: 'owner' }, 'guarded', 'g', 'amend', { dependencies: [] }, 'the criterion is cited, not copied').dependencies, [])
  assert.equal(opened.store.get('tasks', 't1').revision, undefined, 'the upgrade is not a task write')
  assert.deepEqual(opened.store.get('drafts', 'draft').input.tasks.map(task => [task.covers, task.acceptance]), [[['c2'], ['own']], [undefined, ['x1', 'x2']]])
  const reason = id => opened.completionError(opened.store.get('missions', id))
  assert.equal(reason('done'), undefined, 'covered before, covered after')
  assert.match(reason('stalled'), /criterion: c2 "b2"\. /, 'uncovered before, uncovered after; a review\'s text still covers nothing')
  // The one change: a repair admitted before inheritance answers for what it replaced.
  assert.equal(reason('repaired'), undefined)
  const probe = new DatabaseSync(config.statePath, { readOnly: true })
  assert.equal(probe.prepare('PRAGMA user_version').get().user_version, 4)
  probe.close()
  // Once: a v4 store is not cited again, so a row without covers stays without.
  opened.store.transaction(() => { const row = opened.store.get('tasks', 't2'); delete row.covers; opened.store.put('tasks', row) })
  await opened.dispose()
  const reopened = new SwarmRuntime(config, new FakeWorkers())
  t.after(() => reopened.dispose())
  assert.equal(reopened.store.get('tasks', 't2').covers, undefined)
  await reopened.dispose()
  // Restoring a v3 snapshot, or an unversioned one, upgrades it the same way.
  for (const version of [3, 0]) {
    const snapshot = join(dir, `v${version}.sqlite`)
    if (version === 0) { copyFileSync(join(dir, 'v3.sqlite'), snapshot); const db = new DatabaseSync(snapshot); db.exec('PRAGMA user_version=0'); db.close() }
    SwarmStore.restore(config.statePath, snapshot)
    const restored = new SwarmRuntime(config, new FakeWorkers())
    assert.deepEqual(restored.store.get('tasks', 'q').covers, ['c1'], `v${version}`)
    await restored.dispose()
  }
  // A store from a later schema fails closed, as a v3 build refuses this one.
  const future = new DatabaseSync(config.statePath); future.exec('PRAGMA user_version=5'); future.close()
  assert.throws(() => new SwarmRuntime(config, new FakeWorkers()), /Unsupported swarm schema 5; expected 4/)
})

test('the v4 upgrade commits like any other change: a draft it rewrites moves to its next revision, so a page that still holds the v3 draft cannot save over the cited ids, and the state cursor names what changed', async t => {
  const clock = new FakeClock()
  const { dir, config, runtime } = await makeRuntime(t, { clock })
  await runtime.dispose()
  writeV3(config.statePath)
  // Beside the draft that copied a criterion: one whose tasks copied none, which the upgrade leaves as it is.
  const db = new DatabaseSync(config.statePath)
  const held = JSON.parse(db.prepare('SELECT value FROM drafts WHERE id=?').get('draft').value)
  const plain = { ...held, id: 'plain', input: { ...held.input, tasks: held.input.tasks.map(task => ({ ...task, acceptance: ['own'] })) } }
  db.prepare('INSERT INTO drafts(id,mission_id,value) VALUES(?,?,?)').run(plain.id, plain.id, JSON.stringify(plain))
  const before = Number(db.prepare('SELECT revision FROM state_revision WHERE id=1').get().revision)
  db.close()
  clock.advance(5000)
  const opened = new SwarmRuntime(config, new FakeWorkers())
  t.after(() => opened.dispose())
  const owner = { sessionId: 'owner' }, claim = { grantRoot: dir, source: 'session' }
  const upgraded = opened.store.get('drafts', 'draft')
  assert.deepEqual([upgraded.revision, upgraded.updatedAt, upgraded.input.tasks[0].covers], [held.revision + 1, clock.now(), ['c2']], 'the rewritten draft is a new revision, written at the upgrade')
  assert.deepEqual(opened.store.get('drafts', 'plain'), plain, 'a draft that copied no criterion is not rewritten')
  // What the open page sends: the revision and the plan it loaded before the restart.
  assert.throws(() => opened.updateDraft(owner, held.id, held.revision, held.input, claim), error => error.code === 'draft_revision_conflict')
  assert.deepEqual(opened.store.get('drafts', 'draft').input.tasks[0].covers, ['c2'], 'the cited ids survive the stale save')
  // The page's watch cursor is the revision it last saw: the upgrade is one change after it, naming the owner and each mission whose rows it rewrote.
  assert.equal(opened.store.revision(), before + 1)
  const [change, ...more] = opened.store.changesSince(before)
  assert.deepEqual([change.revision, [...change.scopes].sort(), more], [before + 1, ['done', 'draft', 'guarded', 'owner', 'repaired', 'stalled'], []])
  await opened.dispose()
  // Once: reopening the v4 store rewrites nothing and moves no cursor.
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
