/**
 * Round 14 DEAD: the dead-end census, as a repository fact.
 *
 * The owner's prototype censuses every live task as RECOVERABLE, OWNER-GATED or
 * DEAD END. This file makes that census checkable from the state machines
 * instead of running it by hand, over the *same* generated board space and the
 * *same* guard vocabulary the dispatch path uses (`guardActions`,
 * `guardMissionTerminal`, `terminalEscalation` in `src/scheduling.ts`,
 * `guardTerminal` in `src/refusals.ts`; the generator lives in
 * tests/guard-states.mjs, shared with tests/guard-terminals.test.mjs). No second
 * model of the board is grown here.
 *
 * Classification, per live task (a task is live while it is neither accepted nor
 * cancelled): the census projects the board to that one task and asks the
 * production model for its actions —
 *  - an escalation is emitted  -> OWNER-GATED (the unconditional terminal names
 *    the coded, executable exits);
 *  - a dispatch/progress action -> RECOVERABLE;
 *  - nothing at all            -> DEAD END.
 * DEADr/D1: the projection is TASK-SCOPED. Only actions that name the subject
 * count — dispatch actions (they carry `taskId`) and task-scoped progress
 * (`action.taskId === task.id`). `guardActions` also emits a member-scoped
 * `progress/dispatch_preconditions` action for any working member (only
 * `memberId`, no taskId); that is board-level liveness, not recovery for the
 * task under classification, and counting it made one unrelated working member
 * turn a blocked review from OWNER-GATED into RECOVERABLE. The subject's
 * projection therefore keeps only members that can act on it (`idle`/`waiting`
 * — the same set the production dispatch predicate considers), and the emitted
 * actions are filtered to the task. The model stays the production
 * `guardActions` (mutant-injectable); no second model of the board is grown.
 * The projection is what makes the classification per task; the model is the
 * production one, so a source mutation that removes the terminal element turns
 * every owner-gated task into a dead end and this file fails (the reviewer's
 * mutation experiment). The classifier is also exercised with injected mutants
 * in the non-vacuity test below, so the DEAD END branch is shown to be
 * representable rather than asserted about.
 *
 * Reference values. On this round's board the owner's prototype reported
 * **0 dead ends and 4 owner-gated**, the four being the blocked reviews whose
 * sources were rejected, each naming a real exit pair. That board is
 * reconstructed here from durable rows through the production projection
 * (`SwarmRuntime.scheduling.guardBoard`) and must classify as 0 dead ends and
 * exactly 4 owner-gated. Over the whole reachable closure the corrected
 * (task-scoped) census reports **60 recoverable / 12740 owner-gated / 0 dead
 * ends**; before the D1 fix it reported 86/12714/0, the difference being the
 * states whose only "action" was an unrelated member's `working` status. The
 * *discriminating* number is the owner-gated count (0 dead ends is structural:
 * the terminal element of every chain is unconditional).
 *
 * The qualification the owner's census earned, stated: the DEAD END branch is
 * reachable only for a state the runtime does not produce — the terminal element
 * of every chain is unconditional, so for any real board a live task with no
 * action is covered by an escalation. The *discriminating* number is therefore
 * the owner-gated count, not the dead-end count. What this file makes checkable:
 * the classification and the counts, the reachability of the DEAD END branch
 * (by mutation), and the well-formedness of every escalation's exits. What stays
 * a lint property: whether the named tools and parameters resolve in the real
 * tool schema — that is `assessRefusal` over `toolSchemaIndex`
 * (tests/refusal-inventory.mjs), which this file runs over the census's own
 * terminals so a drifted exit fails here too.
 *
 * The same validator runs on every path that can write state: `taskGraphDefects`
 * (src/admission.ts) is called by `reconcileTaskAdmission` at admission and by
 * `orchestratorCommands` (src/trace.ts) on replay, and this file pins both.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { guardActions, guardMissionTerminal } from '../lib/scheduling.js'
import { reconcileTaskAdmission } from '../lib/admission.js'
import { ReplayGraphError, orchestratorCommands } from '../lib/trace.js'
import { assessRefusal, refusalSites, toolSchemaIndex } from './refusal-inventory.mjs'
import { setup } from './faults/harness.mjs'
import { CHAINS, generatedBoards, generatorLimits, keyOf, reachableClosure } from './guard-states.mjs'

export const RECOVERABLE = 'RECOVERABLE'
export const OWNER_GATED = 'OWNER-GATED'
export const DEAD_END = 'DEAD END'

/**
 * The actions that belong to ONE task under classification. `guardActions` is
 * the production model and is board-level by design: besides task-scoped
 * actions it emits a member-scoped `progress/dispatch_preconditions` action for
 * any working member (`{ kind: 'progress', memberId }`, no taskId). That action
 * says "some member is busy"; it says nothing about the task in front of us, and
 * DEADr's verifier reproduced the consequence — with it counted, an unrelated
 * working member turned a blocked review that has no task-local recovery from
 * OWNER-GATED into RECOVERABLE.
 *
 * The projection therefore keeps only actions that name the subject:
 *  - escalations (the terminal is the subject's own chain terminal; the
 *    projection has exactly one task, so it is task-scoped by construction);
 *  - dispatch actions, which name `taskId`;
 *  - progress actions whose `taskId` is the subject.
 * Member-scoped progress is board-level liveness and is dropped. The model stays
 * the production `guardActions` (mutant-injectable); no second model is grown.
 */
export function taskScopedActions(task, projected, actions) {
  return actions(projected).filter(action =>
    action.kind === 'escalate'
    || (action.kind === 'dispatch' && action.taskId === task.id)
    || (action.kind === 'progress' && action.taskId === task.id))
}

/**
 * Census one board. `actions` is injectable so the non-vacuity test can mutate
 * the model without editing it: the default is the production `guardActions`,
 * which is what the dispatch path calls.
 */
export function census(board, actions = guardActions) {
  const live = board.tasks.filter(task => task.status !== 'accepted' && task.status !== 'cancelled')
  const perTask = []
  for (const task of live) {
    // The subject's projection: this one task, and the members that can act on
    // it. A `working` member is executing something else (or, from this task's
    // point of view, is not available), and its liveness must not be attributed
    // to this task — the same reason the member-scoped progress action is
    // dropped below. A `stopped` member cannot act at all. What remains is the
    // set the production dispatch predicate itself considers (`idle`/`waiting`),
    // so no second model of the board is grown: the production `guardActions`
    // still answers every question.
    const projected = {
      ...board,
      tasks: [task],
      members: board.members.filter(member => member.status === 'idle' || member.status === 'waiting'),
    }
    const emitted = taskScopedActions(task, projected, actions)
    if (emitted.some(action => action.kind === 'escalate')) { perTask.push({ taskId: task.id, status: task.status, outcome: OWNER_GATED, terminal: emitted.find(action => action.kind === 'escalate') }); continue }
    if (emitted.length > 0) { perTask.push({ taskId: task.id, status: task.status, outcome: RECOVERABLE }); continue }
    perTask.push({ taskId: task.id, status: task.status, outcome: DEAD_END })
  }
  const totals = { [RECOVERABLE]: 0, [OWNER_GATED]: 0, [DEAD_END]: 0 }
  for (const entry of perTask) totals[entry.outcome] += 1
  return { perTask, totals, liveTasks: live.length }
}

/** The production message text goes through the real refusal lint, as in tests/guard-terminals.test.mjs. */
const schemaIndex = await toolSchemaIndex()
function exitViolations(message) {
  const sites = refusalSites(`export function probe() {\n  throw new Error(${JSON.stringify(message)})\n}\n`, 'src/probe.ts')
  assert.equal(sites.length, 1, 'the lint fixture has exactly one refusal site')
  return assessRefusal(sites[0], { ...schemaIndex, diagnosticProducers: new Set() })
}

test('DEAD census: every reachable non-terminal board state is RECOVERABLE or OWNER-GATED, and the reachable set is the generator\'s closure', () => {
  const reachable = reachableClosure()
  const totals = { [RECOVERABLE]: 0, [OWNER_GATED]: 0, [DEAD_END]: 0 }
  const ownerGatedChains = new Set()
  const deadEnds = []
  const malformed = []
  for (const board of reachable.values()) {
    if (guardMissionTerminal(board)) continue
    const result = census(board)
    for (const outcome of Object.keys(totals)) totals[outcome] += result.totals[outcome]
    for (const entry of result.perTask) {
      if (entry.outcome !== OWNER_GATED) continue
      const terminal = entry.terminal
      if (terminal.exits.length === 0) malformed.push(`no exit for ${keyOf(board)}`)
      if (typeof terminal.code !== 'string' || terminal.code.length === 0) malformed.push(`no code for ${keyOf(board)}`)
      if (!CHAINS.includes(terminal.chain)) malformed.push(`unknown chain ${terminal.chain} for ${keyOf(board)}`)
      const violations = exitViolations(terminal.message)
      if (violations.length > 0) malformed.push(`terminal ${terminal.chain} does not resolve through the refusal lint: ${violations.join('; ')}`)
      ownerGatedChains.add(terminal.chain)
    }
    if (result.totals[DEAD_END] > 0) deadEnds.push(keyOf(board))
  }
  assert.deepEqual(malformed.slice(0, 5), [], malformed.join('\n'))
  assert.equal(totals[DEAD_END], 0, `the census must report 0 dead ends, saw ${totals[DEAD_END]}: ${deadEnds.slice(0, 3).join(' | ')}`)
  assert.ok(totals[OWNER_GATED] > 0, 'the closure must exercise the owner-gated outcome, or the census never needs the terminal')
  assert.ok(totals[RECOVERABLE] > 0, 'the closure must exercise the recoverable outcome')
  // The unreached states, listed rather than implied (the full list is the
  // hand-off note in tests/guard-states.mjs): the closure is a proper subset of
  // the enumerated cross product and excludes the structurally impossible
  // combinations. The named representatives below are the ones the transition
  // relation provably cannot produce.
  const enumerated = generatedBoards()
  const unreached = enumerated.filter(board => !reachable.has(keyOf(board)))
  assert.ok(unreached.length > 0, 'the reachable closure must exclude structurally impossible states')
  assert.ok(!reachable.has(keyOf(generatorLimits.unreachedExample)), 'an accepted task with a live attempt is not reachable')
  const attemptLabel = task => task.attempt === undefined ? 'no-attempt' : task.attempt.leaseLive ? 'live-attempt' : 'lapsed-attempt'
  const unreachedPairs = new Set(unreached.map(board => `${board.tasks[0].status}/${attemptLabel(board.tasks[0])}`))
  assert.ok(unreachedPairs.has('running/no-attempt'), 'a running task without an attempt is not reachable')
  assert.ok(unreachedPairs.has('accepted/live-attempt'), 'an accepted task with a live attempt is not reachable')
  assert.ok(unreachedPairs.has('cancelled/live-attempt'), 'a cancelled task with a live attempt is not reachable')
  assert.ok(!unreachedPairs.has('pending/no-attempt'), 'a pending task without an attempt is reachable (it is the seed)')
  assert.ok(!unreachedPairs.has('blocked/no-attempt'), 'a blocked task without an attempt is reachable (a rejection blocks its source)')
  assert.ok(unreached.length < enumerated.length, 'and the closure is not the whole enumerated space')
  // The reported count: a repository fact in the run output, so a rise is
  // visible without re-deriving the census by hand.
  console.log(`DEAD CENSUS: ${reachable.size} reachable states enumerated, ${enumerated.length} in the cross product; live-task outcomes: ${totals[RECOVERABLE]} recoverable, ${totals[OWNER_GATED]} owner-gated, ${totals[DEAD_END]} dead ends; owner-gated chains: ${[...ownerGatedChains].sort().join(', ')}`)
})

/**
 * The round's board shape as durable rows: four blocked reviews whose sources
 * were rejected and withdrawn (`cancelled`) exactly as this round withdrew and
 * replaced them. Shared by the reference test and the DEADr D1 regression.
 */
function putReferenceBoard(f) {
  const reviews = []
  for (let index = 0; index < 4; index += 1) {
    const sourceId = `task_source_${index}`
    const reviewId = `task_review_${index}`
    reviews.push(reviewId)
    f.runtime.store.transaction(() => {
      f.runtime.store.put('tasks', {
        id: sourceId, missionId: f.mission.id, workstreamId: f.stream.id, title: `Source ${index}`, objective: 'Implement the scoped change',
        kind: 'implementation', dependencies: [], scope: ['**'], acceptance: ['works'], checks: [], status: 'cancelled', priority: 0, experiment: false, epoch: 2, evidenceIds: [], plannedAssigneeId: f.author.id,
        output: 'Independent verification rejected the source artifact',
      })
      f.runtime.store.put('tasks', {
        id: reviewId, missionId: f.mission.id, workstreamId: f.stream.id, title: `Review ${index}`, objective: 'Independently verify the source',
        kind: 'verification', dependencies: [], scope: ['**'], acceptance: ['works'], checks: [], status: 'blocked', priority: 0, experiment: false, epoch: 1, evidenceIds: [], reviewOf: sourceId,
      })
    })
  }
  return reviews
}

test('DEAD census reference: this round\'s board shape reports 0 dead ends and 4 owner-gated blocked reviews naming real exits', async t => {
  const f = await setup({ config: { tickMs: 10_000 } })
  try {
    const reviews = putReferenceBoard(f)
    const board = f.runtime.scheduling.guardBoard(f.mission.id)
    const result = census(board)
    assert.equal(result.totals[DEAD_END], 0, 'this round\'s board has no dead ends')
    const ownerGated = result.perTask.filter(entry => entry.outcome === OWNER_GATED)
    assert.equal(result.totals[OWNER_GATED], 4, `exactly the four blocked reviews are owner-gated, saw ${JSON.stringify(result.perTask.map(entry => [entry.taskId, entry.outcome]))}`)
    assert.deepEqual(ownerGated.map(entry => entry.taskId).sort(), [...reviews].sort(), 'the owner-gated tasks are exactly the blocked reviews')
    for (const entry of ownerGated) {
      assert.ok(entry.terminal.exits.length >= 2, `the terminal for ${entry.taskId} names a real exit pair`)
      assert.deepEqual(exitViolations(entry.terminal.message), [], `the exits for ${entry.taskId} resolve in the tool schema`)
      assert.ok(entry.terminal.code.length > 0)
    }
    console.log(`DEAD CENSUS reference board (${result.liveTasks} live tasks): ${result.totals[OWNER_GATED]} owner-gated, ${result.totals[RECOVERABLE]} recoverable, ${result.totals[DEAD_END]} dead ends; exit pairs resolve in the tool schema`)
  } finally { await f.cleanup() }
})

test('DEAD non-vacuity: the classifier returns DEAD END under the documented mutations, and the production model never does', async t => {
  // (1) The branch is representable: a model that emits nothing at all — the
  // mutation "remove the terminal element" — makes every live task a dead end.
  const f = await setup({ config: { tickMs: 10_000 } })
  let board
  try {
    f.runtime.store.transaction(() => {
      f.runtime.store.put('tasks', {
        id: 'task_blocked_review', missionId: f.mission.id, workstreamId: f.stream.id, title: 'Blocked review', objective: 'Verify',
        kind: 'verification', dependencies: [], scope: ['**'], acceptance: ['works'], checks: [], status: 'blocked', priority: 0, experiment: false, epoch: 1, evidenceIds: [], reviewOf: 'task_blocked_source',
      })
      f.runtime.store.put('tasks', {
        id: 'task_blocked_source', missionId: f.mission.id, workstreamId: f.stream.id, title: 'Rejected source', objective: 'Implement',
        kind: 'implementation', dependencies: [], scope: ['**'], acceptance: ['works'], checks: [], status: 'blocked', priority: 0, experiment: false, epoch: 1, evidenceIds: [],
      })
    })
    board = f.runtime.scheduling.guardBoard(f.mission.id)
    // The production model on the real board: no dead ends.
    assert.equal(census(board).totals[DEAD_END], 0, 'the production model never reports a dead end on a real board')
    // Mutant A: no terminal, no actions at all.
    const withoutTerminal = census(board, () => [])
    assert.equal(withoutTerminal.totals[DEAD_END], withoutTerminal.liveTasks, 'removing every action makes every live task a dead end')
    // Mutant B: remove the terminal element but keep dispatch/progress. This is
    // the source mutation a reviewer would make; the census must fail under it.
    const stripEscalation = actions => board => actions(board).filter(action => action.kind !== 'escalate')
    const mutantBoard = board
    const stripped = census(mutantBoard, stripEscalation(guardActions))
    assert.ok(stripped.totals[DEAD_END] > 0, 'a model without its terminal element must report dead ends, so the census assertion is sensitive to that mutation')
  } finally { await f.cleanup() }

  // (2) The reachable closure: a model missing dispatch actions must change the
  // classification of a dispatchable state, so the "0 dead ends" assertion is
  // not vacuous over a space that never had an action to lose.
  const reachable = reachableClosure()
  const dispatchable = [...reachable.values()].find(candidate => !guardMissionTerminal(candidate)
    && guardActions(candidate).some(action => action.kind === 'dispatch'))
  assert.ok(dispatchable !== undefined, 'the closure must contain a dispatchable state')
  assert.equal(census(dispatchable).totals[RECOVERABLE], 1, 'the dispatchable state is recoverable under the production model')
  const withoutDispatch = actions => board => actions(board).filter(action => action.kind !== 'dispatch')
  assert.notEqual(census(dispatchable, withoutDispatch(guardActions)).totals[RECOVERABLE], 1,
    'removing the dispatch actions changes the classification, so the recoverable count is load-bearing')
  assert.ok(generatedBoards().length > reachable.size, 'the enumerated space is larger than the reachable closure, so the census does not assert over impossible states')
})

test('DEAD pair: the same graph validator refuses an illegal graph at admission and on replay', () => {
  const workspace = '/tmp/dead-census-workspace'
  const location = 'task'
  const source = { objective: 'Implement the scoped change in src/admission.ts.', scope: ['src/'], acceptance: ['the graph is validated'] }
  // Admission: the same defect the replay path refuses.
  const dangling = reconcileTaskAdmission({ ...source, dependencies: ['task_never_admitted'] }, workspace, location, { dependencies: ['task_never_admitted'], knownContents: new Set(['task_real']) })
  const danglingDefects = dangling.filter(diagnostic => diagnostic.code.startsWith('task_graph'))
  assert.equal(danglingDefects.length, 1, `admission must refuse the dangling edge, saw ${JSON.stringify(dangling)}`)
  assert.equal(danglingDefects[0].code, 'task_graph_unknown_edge')
  assert.match(danglingDefects[0].message, /swarm_propose/, 'the admission diagnostic names an executable exit')
  // A known dependency is graph-legal: the validator does not double-refuse.
  const legal = reconcileTaskAdmission({ ...source, dependencies: ['task_real'] }, workspace, location, { dependencies: ['task_real'], knownContents: new Set(['task_real']) })
  assert.deepEqual(legal.filter(diagnostic => diagnostic.code.startsWith('task_graph')), [], 'a known edge is admitted')
  // Co-firing guards, named and shown disjoint rather than double-refusing:
  //  - the R12-F9 admission guard (a task whose text assumes prior work while it
  //    declares no dependency) fires on an empty edge set, which the graph
  //    validator cannot object to;
  //  - the graph validator fires on an edge to an identity no task carries,
  //    which the R12-F9 guard does not read;
  //  - cancellation and replacement lineage are the runtime's own guards: a
  //    `replaces` id is not a graph edge, and a cancelled dependency is a known
  //    identity, so the graph validator stays silent for both.
  const assumed = reconcileTaskAdmission({ objective: 'Resume from your own artifact `09883f3` and finish it.', scope: ['src/'], acceptance: ['works'], dependencies: [] }, workspace, location,
    { dependencies: [], replaces: [], knownContents: new Set(['task_real']) })
  assert.ok(assumed.some(diagnostic => diagnostic.code === 'dependency_assumption_missing'), 'the R12-F9 guard fires on an empty edge set')
  assert.deepEqual(assumed.filter(diagnostic => diagnostic.code.startsWith('task_graph')), [], 'and the graph validator stays silent there')
  assert.deepEqual(dangling.filter(diagnostic => diagnostic.code === 'dependency_assumption_missing'), [], 'the R12-F9 guard stays silent on a dangling edge')
  const repair = reconcileTaskAdmission({ ...source, dependencies: [], replaces: ['task_blocked'] }, workspace, location, { dependencies: [], replaces: ['task_blocked'], knownContents: new Set(['task_blocked']) })
  assert.deepEqual(repair.filter(diagnostic => diagnostic.code.startsWith('task_graph')), [], 'a `replaces` lineage is not a graph edge')
  // A call site that does not know the mission's identities must never guess.
  const blind = reconcileTaskAdmission({ ...source, dependencies: ['task_never_admitted'] }, workspace, location, { dependencies: ['task_never_admitted'] })
  assert.deepEqual(blind.filter(diagnostic => diagnostic.code.startsWith('task_graph')), [], 'without known identities the graph guard cannot judge an edge and stays silent')

  // Replay: the same defects, from a durable log, refused before any command.
  const log = (tasks) => tasks.map((task, index) => ({ seq: index + 1, missionId: 'mission_dead', type: 'task/proposed', actor: 'owner', data: task, createdAt: 1_000 + index }))
  const base = [{ id: 'task_a', dependencies: [] }, { id: 'task_b', dependencies: ['task_a'], reviewOf: undefined }]
  assert.equal(orchestratorCommands(log(base)).commands.length, 0, 'a legal graph replays (it carries no dispatch commands)')
  const rejected = (tasks) => { try { orchestratorCommands(log(tasks)); return undefined } catch (error) { return error } }
  const danglingReplay = rejected([{ id: 'task_a', dependencies: ['task_missing'] }])
  assert.ok(danglingReplay instanceof ReplayGraphError, 'a dangling edge is refused on replay')
  assert.deepEqual(danglingReplay.defects.map(defect => defect.code), ['task_graph_unknown_edge'])
  const cycleReplay = rejected([{ id: 'task_a', dependencies: ['task_b'] }, { id: 'task_b', dependencies: ['task_a'] }])
  assert.ok(cycleReplay instanceof ReplayGraphError, 'a cycle is refused on replay')
  assert.deepEqual(cycleReplay.defects.map(defect => defect.code), ['task_graph_cycle'])
  const selfReplay = rejected([{ id: 'task_a', dependencies: ['task_a'] }])
  assert.ok(selfReplay instanceof ReplayGraphError, 'a self edge is refused on replay')
  assert.deepEqual(selfReplay.defects.map(defect => defect.code), ['task_graph_self_edge'])
  const duplicateReplay = rejected([{ id: 'task_a', dependencies: [] }, { id: 'task_a', dependencies: [] }])
  assert.ok(duplicateReplay instanceof ReplayGraphError, 'a duplicated identity is refused on replay')
  assert.deepEqual(duplicateReplay.defects.map(defect => defect.code), ['task_graph_duplicate'])
  // Cancellation and replacement lineage are not graph defects: those guards are
  // the runtime's own (a cancelled dependency and a `replaces` id are known
  // identities), so the graph validator must not report them.
  assert.deepEqual(rejected([{ id: 'task_a', dependencies: [] }, { id: 'task_b', dependencies: ['task_a'], reviewOf: 'task_a' }]), undefined,
    'a legal review edge and a repair-shaped graph are replayed, not refused')
})

/**
 * DEADr D1: the classification is per task, from the SUBJECT's own activities.
 * The verifier's reproduction: `guardActions` emits a member-scoped
 * `progress/dispatch_preconditions` action for any working member, and the
 * census kept it, so one UNRELATED working member turned {OWNER-GATED: 4,
 * RECOVERABLE: 0} into {OWNER-GATED: 0, RECOVERABLE: 4} on the reference board.
 */
test('DEADr D1 pair: an unrelated working member is not this task\'s recovery', async t => {
  const f = await setup({ config: { tickMs: 10_000 } })
  try {
    const reviews = putReferenceBoard(f)
    const idleBoard = f.runtime.scheduling.guardBoard(f.mission.id)
    const baseline = census(idleBoard)
    assert.equal(baseline.totals[OWNER_GATED], 4, 'the four blocked reviews are owner-gated while every member is idle')
    assert.equal(baseline.totals[RECOVERABLE], 0)
    assert.equal(baseline.totals[DEAD_END], 0)

    // ONE unrelated member goes to `working`. Nothing about the reviews changes.
    f.runtime.store.transaction(() => {
      const reviewer = f.runtime.store.get('members', f.reviewer.id)
      reviewer.status = 'working'
      f.runtime.store.put('members', reviewer)
    })
    const after = census(f.runtime.scheduling.guardBoard(f.mission.id))  // re-read after the flip
    assert.equal(after.totals[OWNER_GATED], 4, 'an unrelated working member must not change the owner-gated count')
    assert.equal(after.totals[RECOVERABLE], 0, 'and must not invent recovery for a blocked review')
    assert.equal(after.totals[DEAD_END], 0, 'and must not invent a dead end either')
    assert.deepEqual(after.perTask.map(entry => entry.taskId).sort(), [...reviews].sort(), 'the same reviews are classified')

    // The mutation the verifier reproduced against: the pre-D1 census keeps the
    // member-scoped action, so the same board flips. This is what makes the split
    // assertion load-bearing rather than decorative.
    const preFixCensus = board => {
      const live = board.tasks.filter(task => task.status !== 'accepted' && task.status !== 'cancelled')
      const perTask = []
      for (const task of live) {
        const emitted = guardActions({ ...board, tasks: [task] })
        if (emitted.some(action => action.kind === 'escalate')) { perTask.push({ taskId: task.id, outcome: OWNER_GATED }); continue }
        if (emitted.length > 0) { perTask.push({ taskId: task.id, outcome: RECOVERABLE }); continue }
        perTask.push({ taskId: task.id, outcome: DEAD_END })
      }
      const totals = { [RECOVERABLE]: 0, [OWNER_GATED]: 0, [DEAD_END]: 0 }
      for (const entry of perTask) totals[entry.outcome] += 1
      return { perTask, totals }
    }
    const mutantBaseline = preFixCensus(idleBoard)
    assert.equal(mutantBaseline.totals[OWNER_GATED], 4, 'with every member idle the pre-D1 census agrees, so the flip is caused by the working member alone')
    const workingBoard = f.runtime.scheduling.guardBoard(f.mission.id)
    const mutantAfter = preFixCensus(workingBoard)
    assert.equal(mutantAfter.totals[OWNER_GATED], 0, 'without the task-scoped projection the unrelated working member flips every review')
    assert.equal(mutantAfter.totals[RECOVERABLE], 4, 'and reports them as recoverable on a member that is not working on them')

    // The closure split, pinned. Making every member idle removes only
    // member-scoped liveness and adds dispatch eligibility for a pending task;
    // the fixed census may therefore move OWNER-GATED -> RECOVERABLE for a
    // pending task, but it must NEVER move RECOVERABLE -> OWNER-GATED — which is
    // exactly what the pre-D1 census does, 24 times (the verifier's 24 of 86).
    const reachable = reachableClosure()
    const forceIdle = board => ({ ...board, members: board.members.map(member => member.status === 'stopped' ? member : { ...member, status: 'idle' }) })
    const outcomes = (board, fn) => fn(board).perTask.map(entry => entry.outcome).join(',')
    let towardOwner = 0
    let towardRecoverable = 0
    let mutantTowardOwner = 0
    for (const board of reachable.values()) {
      if (guardMissionTerminal(board)) continue
      const fixedBefore = outcomes(board, census)
      const fixedAfter = outcomes(forceIdle(board), census)
      if (fixedBefore === RECOVERABLE && fixedAfter === OWNER_GATED) towardOwner += 1
      if (fixedBefore === OWNER_GATED && fixedAfter === RECOVERABLE) {
        towardRecoverable += 1
        assert.equal(board.tasks[0].status, 'pending', 'the only legitimate movement is a pending task gaining a dispatchable member')
      }
      const mutantBefore = outcomes(board, preFixCensus)
      const mutantAfter = outcomes(forceIdle(board), preFixCensus)
      if (mutantBefore === RECOVERABLE && mutantAfter === OWNER_GATED) mutantTowardOwner += 1
    }
    assert.equal(towardOwner, 0, 'member-scoped liveness must play no part in the split')
    assert.ok(towardRecoverable > 0, 'the dispatchability movement is real, not assumed away')
    assert.ok(mutantTowardOwner > 0, 'the pre-D1 census moves toward OWNER-GATED, so the pin discriminates')
    console.log(`DEADr D1: fixed census moves ${towardRecoverable} classification(s) toward RECOVERABLE when members are forced idle (all pending-task dispatchability, none toward OWNER-GATED); the pre-D1 census moves ${mutantTowardOwner} toward OWNER-GATED`)
  } finally { await f.cleanup() }
})
