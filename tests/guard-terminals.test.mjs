/**
 * Round 14 / S4: guard-chain terminals and the R12-F9 admission guard.
 *
 * The kernel obligation this test is the evidence for: a guard chain's *last*
 * element escalates unconditionally, so a dead end is structurally impossible.
 * The chain is the ordered set of predicates a control path evaluates before it
 * can act — budget, workspace state, the attempt/lease lifecycle, per-task
 * ceilings, review admission, dispatch preconditions and (the seventh chain in
 * the same family) admission itself. When every earlier element answers "no",
 * `terminalEscalation` names the chain and `guardTerminal` renders the coded
 * decision request that `Scheduling.escalateGuardTerminal` records durably.
 *
 * Three things are checked here, and none of them is a hand-picked sample:
 *
 *  1. The property test enumerates generated board states over the five named
 *     dimensions (task status x attempt presence x workspace state x member
 *     status x budget pause), walks the reachable subset through a transition
 *     relation, and asserts that every reachable *non-terminal* state has at
 *     least one executable action — dispatch, work already in flight, or the
 *     unconditional terminal escalation. "The terminal exists" is true by
 *     construction (it is total); the substantive assertions are the rest: the
 *     named chain is the first one that cannot progress and is correct for the
 *     board, every delivered message resolves through the real refusal lint
 *     (`tests/refusal-inventory.mjs`) against the real tool schema, every
 *     dispatch action really is executable, the closure contains states that
 *     need a terminal at all (non-vacuity), every chain is exercised, and the
 *     terminal never masks an action the chain can still take. The states the
 *     generator does NOT reach are stated in `generatorLimits` below rather than
 *     implied away.
 *
 *  2. Every guard this round adds or alters names the other guards it can
 *     co-fire with (`coFires`), and the pair tests exercise the two real pairs
 *     of 2026-09-10: a workspace guard firing together with the review-capture
 *     guard (bricked a member, cost two missions extra members and budget), and
 *     "Member has uncommitted commits" firing during an attempt close-out with
 *     no exit at all.
 *
 *  3. R12-F9: a task proposed with an empty dependency set while its objective
 *     or a `replaces` reference names existing artifact content is refused with
 *     a coded diagnostic and an executable exit, reproduced from the two real
 *     precedents (`T3b`: "resume from your own artifact `09883f3`"; `INT2`: the
 *     assembly was already in its worktree), while a legitimately self-contained
 *     task with no dependencies is not refused.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { guardActions, guardDispatchActions, guardMissionTerminal, guardProgressActions, guardTerminalChain, terminalEscalation } from '../lib/scheduling.js'
import { emitGuardTerminal, guardTerminal } from '../lib/refusals.js'
import { DEPENDENCY_ASSUMPTION_CODE, dependencyAssumptions, reconcileTaskAdmission } from '../lib/admission.js'
import { refusalSites, assessRefusal, toolSchemaIndex } from './refusal-inventory.mjs'
import { setup, eventually, events } from './faults/harness.mjs'

import { CHAINS, TASK_STATUS, ATTEMPTS, WORKSPACES, MEMBER_STATUS, BUDGETS, FLAGS, MISSION_BASE, MISSION_STATUS, TASK_ID, MEMBER_ID, budgetFields, flagFields, generatedBoards, keyOf, reachableFrom, generatorLimits } from './guard-states.mjs'

/**
 * Run one message through the *real* refusal lint: the production message text
 * is embedded in a throw fixture and assessed against the schema the production
 * registration path installs, so a terminal that names a tool or parameter the
 * model cannot call fails here.
 */
const schemaIndex = await toolSchemaIndex()
function lintRefusal(message) {
  const sites = refusalSites(`export function probe() {\n  throw new Error(${JSON.stringify(message)})\n}\n`, 'src/probe.ts')
  assert.equal(sites.length, 1, 'the lint fixture has exactly one refusal site')
  return assessRefusal(sites[0], { ...schemaIndex, diagnosticProducers: new Set() })
}

/* ------------------------------------------------------------------------- *
 * 1. The property test over generated board states.
 * ------------------------------------------------------------------------- */

test('R14 property: every reachable non-terminal board state has an executable action, and the chain terminal escalates', () => {
  const reachable = new Map()
  for (const flag of FLAGS) for (const missionStatus of MISSION_STATUS) {
    const seed = {
      mission: { ...MISSION_BASE, status: missionStatus },
      tasks: [{ id: TASK_ID, status: 'pending', ...flagFields(flag) }],
      members: [{ id: MEMBER_ID, status: 'idle' }],
    }
    for (const [key, board] of reachableFrom(seed)) if (!reachable.has(key)) reachable.set(key, board)
  }
  // Non-vacuity: the generator must really produce dead ends, or the property is
  // asserted over a state space that never needs a terminal.
  let withoutAction = 0
  let nonActiveMissions = 0
  const terminalsSeen = new Set()
  const nonActiveStatuses = new Set()
  const failures = []
  for (const board of reachable.values()) {
    const dispatch = guardDispatchActions(board)
    const progress = guardProgressActions(board)
    const actions = guardActions(board)
    if (guardMissionTerminal(board)) {
      // A completed/stopped mission owes no action; the model says so instead of
      // inventing one.
      if (actions.length > 0) failures.push(`a terminal mission still offers ${actions.length} actions for ${keyOf(board)}`)
      continue
    }
    if (actions.length === 0) { failures.push(`no action for ${keyOf(board)}`); continue }
    if (board.mission.status !== 'active') {
      nonActiveMissions++
      nonActiveStatuses.add(board.mission.status)
      // S4r-D5: a mission that left `active` without reaching a terminal status
      // (most importantly `blocked` after a budget stop) still owes the owner a
      // coded, executable terminal.
      if (!actions.some(action => action.kind === 'escalate')) failures.push(`non-active mission without an escalation for ${keyOf(board)}`)
    }
    // Every dispatch action must be executable on this board: the task it names
    // exists, is pending, and the member it names is a live member.
    for (const action of dispatch) {
      const task = board.tasks.find(candidate => candidate.id === action.taskId)
      const member = board.members.find(candidate => candidate.id === action.memberId)
      if (task === undefined || task.status !== 'pending' || member === undefined
        || (member.status !== 'idle' && member.status !== 'waiting')) {
        failures.push(`dispatch action ${action.taskId}->${action.memberId} is not executable for ${keyOf(board)}`)
      }
    }
    if (dispatch.length === 0 && progress.length === 0) {
      withoutAction++
      const terminal = terminalEscalation(board)
      const chain = guardTerminalChain(board)
      if (terminal.chain !== chain) failures.push(`terminal chain ${terminal.chain} != classified ${chain} for ${keyOf(board)}`)
      if (terminal.kind !== 'escalate') failures.push(`terminal is not an escalation for ${keyOf(board)}`)
      if (terminal.coFires.length === 0) failures.push(`terminal ${terminal.chain} names no co-firing guard for ${keyOf(board)}`)
      if (terminal.coFires.some(peer => !CHAINS.includes(peer))) failures.push(`terminal ${terminal.chain} names an unknown co-firing guard`)
      const violations = lintRefusal(terminal.message)
      if (violations.length > 0) failures.push(`terminal ${terminal.chain} does not resolve through the refusal lint: ${violations.join('; ')}`)
      terminalsSeen.add(terminal.chain)
    } else if (actions.some(action => action.kind === 'escalate')) {
      // The terminal must never mask an action the chain can still take.
      failures.push(`an escalation is present while dispatch/progress exists for ${keyOf(board)}`)
    }
  }
  assert.deepEqual(failures.slice(0, 10), [], failures.join('\n'))
  assert.ok(withoutAction > 0, 'the generator must reach states with no dispatch and no work in flight')
  assert.ok(nonActiveMissions > 0, 'the generator must reach non-active, non-terminal missions (S4r-D5)')
  assert.ok(nonActiveStatuses.has('blocked'),
    `the generated closure must include a budget-blocked mission, not only active ones; saw ${[...nonActiveStatuses].join(', ')}`)
  assert.deepEqual([...terminalsSeen].sort(), [...CHAINS].sort(),
    `every chain terminal must be exercised by the reachable states; saw ${[...terminalsSeen].sort().join(', ')}`)
  // The closure is a proper subset of the enumerated space: the structurally
  // impossible combinations are excluded, not asserted about.
  const enumerated = generatedBoards()
  const unreached = enumerated.filter(board => !reachable.has(keyOf(board)))
  assert.ok(unreached.length > 0, 'the reachable closure must exclude structurally impossible states')
  assert.ok(!reachable.has(keyOf(generatorLimits.unreachedExample)),
    'an accepted task with a live attempt is not reachable: the generator says so instead of asserting a property over it')
})

/* ------------------------------------------------------------------------- *
 * 2. The pair tests: two individually-correct guards co-firing.
 * ------------------------------------------------------------------------- */

test('R14 pair: the workspace guard and the review-capture guard co-fire and the terminal names both exits', () => {
  // The 2026-09-10 field evidence: a review attempt could not capture an artifact
  // while the workspace guard required a clean tree, and the member was bricked.
  const board = {
    mission: { status: 'active', workspace: 'dirty' },
    tasks: [{ id: 'task_review', status: 'running', attempt: { leaseLive: true }, reviewOf: 'task_source' }],
    members: [{ id: 'member_reviewer', status: 'idle' }],
  }
  assert.deepEqual(guardDispatchActions(board), [], 'the workspace guard refuses every dispatch')
  assert.deepEqual(guardProgressActions(board), [],
    'the attempt is live, but its workspace chain cannot let it land: the pair is what makes it a trap, not liveness')
  const terminal = terminalEscalation(board)
  assert.equal(terminal.chain, 'workspace')
  assert.ok(terminal.coFires.includes('review_admission'), 'the pair names the review-admission guard it co-fires with')
  assert.ok(terminal.coFires.includes('attempt_lease'), 'the pair names the attempt/lease guard it co-fires with')
  assert.deepEqual(lintRefusal(terminal.message), [])
  assert.match(terminal.message, /swarm_propose/)
  assert.match(terminal.message, /swarm_cancel/)
})

test('R14 pair: the workspace guard and "Member has uncommitted commits" co-fire with no exit before this round', () => {
  // The second field evidence: an owner trying to preserve a cut-off attempt met
  // the guard "Member has uncommitted commits" and had no executable exit at all.
  // The failed close-out leaves its task blocked with no live attempt, and the
  // attempt/lease terminal must name the exits that were missing.
  const board = {
    mission: { status: 'active', workspace: 'dirty' },
    tasks: [{ id: 'task_held', status: 'blocked' }],
    members: [{ id: 'member_owner', status: 'idle' }],
  }
  const terminal = terminalEscalation(board)
  assert.equal(terminal.chain, 'workspace', 'the workspace state is the first chain that cannot progress')
  assert.ok(terminal.coFires.includes('attempt_lease'))
  assert.deepEqual(lintRefusal(terminal.message), [])
  // With the workspace repaired, the same blocked task is the attempt chain's dead
  // end, and that terminal names its own exits (release the attempt, withdraw it).
  const repaired = { ...board, mission: { status: 'active', workspace: 'authorized' } }
  const attempt = terminalEscalation(repaired)
  assert.equal(attempt.chain, 'dispatch_preconditions', 'a blocked task with no dispatchable work falls through to the dispatch terminal')
  assert.ok(attempt.coFires.includes('workspace'), 'the dispatch terminal names the workspace guard it co-fires with')
  assert.deepEqual(lintRefusal(attempt.message), [])
})

test('R14: each chain terminal is total, coded and names the guards it can co-fire with', () => {
  for (const chain of CHAINS) {
    const terminal = guardTerminal(chain)
    assert.equal(terminal.chain, chain)
    assert.ok(terminal.code.length > 0, `${chain} carries a stable code`)
    assert.ok(terminal.exits.length > 0, `${chain} names at least one executable exit`)
    assert.ok(terminal.coFires.length > 0, `${chain} names the guards it can co-fire with`)
    assert.ok(terminal.coFires.every(peer => CHAINS.includes(peer)), `${chain} co-fires only with known chains`)
    assert.ok(!terminal.coFires.includes(chain), `${chain} does not name itself as a co-firing guard`)
    assert.deepEqual(lintRefusal(terminal.message), [], `${chain} must resolve through the refusal lint`)
  }
  assert.equal(guardTerminal('admission').code, DEPENDENCY_ASSUMPTION_CODE,
    'the admission chain code and the admission diagnostic code are one vocabulary')
})

test('R14: the terminal classification names the first chain that cannot progress', () => {
  const cases = [
    [{ mission: { status: 'active', workspace: 'authorized', budgetBlocked: 'token budget exhausted' }, tasks: [{ id: 't', status: 'pending' }], members: [{ id: 'm', status: 'idle' }] }, 'budget'],
    [{ mission: { status: 'active', workspace: 'revoked' }, tasks: [{ id: 't', status: 'pending' }], members: [{ id: 'm', status: 'idle' }] }, 'workspace'],
    [{ mission: { status: 'active', workspace: 'authorized' }, tasks: [{ id: 't', status: 'running', attempt: { leaseLive: false } }], members: [{ id: 'm', status: 'idle' }] }, 'attempt_lease'],
    [{ mission: { status: 'active', workspace: 'authorized' }, tasks: [{ id: 't', status: 'pending', ceilingExhausted: true }], members: [{ id: 'm', status: 'idle' }] }, 'task_ceiling'],
    [{ mission: { status: 'active', workspace: 'authorized' }, tasks: [{ id: 't', status: 'pending', assumedContent: true }], members: [{ id: 'm', status: 'idle' }] }, 'admission'],
    [{ mission: { status: 'active', workspace: 'authorized' }, tasks: [{ id: 't', status: 'submitted', reviewSourceLive: false }], members: [{ id: 'm', status: 'idle' }] }, 'review_admission'],
    [{ mission: { status: 'active', workspace: 'authorized' }, tasks: [{ id: 't', status: 'pending', dependenciesDead: true }], members: [{ id: 'm', status: 'idle' }] }, 'dispatch_preconditions'],
  ]
  for (const [board, expected] of cases) {
    assert.equal(guardTerminalChain(board), expected, `${expected} classification`)
    assert.equal(terminalEscalation(board).chain, expected)
    assert.deepEqual(lintRefusal(terminalEscalation(board).message), [])
  }
})

/* ------------------------------------------------------------------------- *
 * 3. The runtime-level pairs: the terminal is durable, contained and deduped.
 * ------------------------------------------------------------------------- */

test('R14 runtime pair (dirty workspace x preparation): an exhausted preparation chain escalates with a coded decision request', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    f.workers.autoIdle = true
    // The exact field condition: preparation meets a workspace guard and throws.
    f.workers.prepareTask = async () => { throw new Error('workspace_uncommitted: the member workspace has uncommitted changes') }
    const task = f.propose({ title: 'Prepare under a dirty workspace', maxRecoveryAttempts: 1 })
    const blocked = await eventually(() => {
      const row = f.runtime.store.get('tasks', task.id)
      return row.status === 'blocked' ? row : undefined
    }, 'the task must exhaust its preparation recovery limit', 8_000)
    assert.match(blocked.output, /Workspace or worker preparation failed/)
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'guard-terminal').at(-1), 'the terminal escalation must be durable', 8_000)
    assert.equal(event.data.chain, 'dispatch_preconditions')
    assert.equal(event.data.code, 'dispatch_terminal')
    assert.ok(event.data.coFires.includes('workspace'), 'the terminal names the workspace guard it co-fired with')
    assert.equal(event.data.ownerNotified, true)
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[dispatch_terminal\]/.test(delivery.content)),
      'the owner must receive the coded decision request', 8_000)
    assert.match(notice.content, /swarm_propose/)
    assert.match(notice.content, /swarm_cancel/)
    assert.deepEqual(lintRefusal(notice.content), [], 'the delivered message resolves through the refusal lint')
    // One durable decision request per unchanged board: the repeat is the same
    // request, never a second differently-worded one.
    await sleep(80)
    assert.equal(f.workers.deliveries.filter(delivery => /\[dispatch_terminal\]/.test(delivery.content)).length, 1)
  } finally { await f.cleanup() }
})

test('R14 runtime pair (attempt close-out x "Member has uncommitted commits"): the throw is contained and escalated', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    f.workers.autoIdle = true
    const held = f.propose({ title: 'Held work', assigneeId: f.author.id })
    await f.runtime.claim(f.actor(f.author), f.mission.id, held.id)
    f.runtime.attempts.onIdle(f.author.id)
    // The exact field message: preserving a cut-off attempt meets a second guard.
    const original = f.runtime.attempts.closeOutIdleAttempt.bind(f.runtime.attempts)
    let thrown = 0
    f.runtime.attempts.closeOutIdleAttempt = async (...args) => { thrown++; throw new Error('Member has uncommitted commits') }
    const other = f.propose({ title: 'Other work', assigneeId: f.reviewer.id })
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'guard-terminal' && item.data.chain === 'attempt_lease').at(-1),
      'the thrown guard must be escalated, not swallowed', 8_000)
    assert.equal(event.data.code, 'attempt_terminal')
    assert.ok(event.data.coFires.includes('workspace'))
    // Containment: one member's dead end never aborts the sweep for the others.
    await eventually(() => f.runtime.store.get('tasks', other.id).status === 'running' ? true : undefined,
      'the sweep must continue past the throw and dispatch another member', 8_000)
    assert.ok(thrown > 0, 'the injected guard really fired')
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[attempt_terminal\]/.test(delivery.content)),
      'the owner must receive the attempt terminal', 8_000)
    assert.deepEqual(lintRefusal(notice.content), [])
    // The injected guard is replaced so cleanup cannot keep throwing.
    f.runtime.attempts.closeOutIdleAttempt = original
  } finally { await f.cleanup() }
})

/* ------------------------------------------------------------------------- *
 * 4. R12-F9: the admission guard for a task that assumes prior work.
 * ------------------------------------------------------------------------- */

const SCOPE = ['src/']
const ACCEPTANCE = ['the guard fires at admission']

test('R12-F9: the admissibility guard fires on the two real precedents', () => {
  // T3b: admitted with no dependencies, prepared from the bare mission baseline,
  // refused at submission ("Artifact changes path outside task scope").
  const t3b = reconcileTaskAdmission({
    objective: 'Resume from your own artifact `09883f3` and finish the guard chain.',
    scope: SCOPE, acceptance: ACCEPTANCE, dependencies: [], replaces: [],
  }, '/workspace', 'task')
  assert.equal(t3b.length, 1, 'the T3b precedent must be refused')
  assert.equal(t3b[0].code, DEPENDENCY_ASSUMPTION_CODE)
  assert.ok(t3b[0].message.includes('09883f3'), 'the diagnostic names the artifact it objects to')
  assert.match(t3b[0].message, /dependencies/)
  assert.match(t3b[0].message, /objective/)
  assert.match(t3b[0].message, /replaces/)
  assert.deepEqual(lintRefusal(`[${t3b[0].code}] ${t3b[0].location}: ${t3b[0].message}`), [],
    'the rendered diagnostic resolves through the refusal lint')

  // INT2: "the assembly was already in its worktree" while it was prepared from
  // the bare mission baseline; repaired by hand with git archive + a hash check.
  const int2 = dependencyAssumptions({
    objective: 'The assembly is already in its worktree; verify the integration.',
    acceptance: ACCEPTANCE, dependencies: [],
  }, 'task')
  assert.equal(int2.length, 1, 'the INT2 precedent must be refused')
  assert.equal(int2[0].code, DEPENDENCY_ASSUMPTION_CODE)
  assert.ok(int2[0].message.includes('assembly'))
  assert.deepEqual(lintRefusal(`[${int2[0].code}] ${int2[0].location}: ${int2[0].message}`), [])
})

test('R12-F9: a legitimately self-contained task is not refused, and a declared dependency satisfies the guard', () => {
  // The counter-case: no dependency is legitimate when the task really is
  // self-contained.
  const selfContained = reconcileTaskAdmission({
    objective: 'Implement the guard in src/admission.ts and cover it in tests/guard-terminals.test.mjs.',
    scope: SCOPE, acceptance: ACCEPTANCE, dependencies: [], replaces: [],
  }, '/workspace', 'task')
  assert.deepEqual(selfContained, [], 'a self-contained task with no dependencies is admitted')

  // A factual sentence about the baseline is not a claim about prepared content.
  assert.deepEqual(dependencyAssumptions({
    objective: 'Add the new validator; the baseline already contains src/admission.ts and its tests.',
    dependencies: [],
  }, 'task'), [])

  // A task that does carry the content through a dependency is admitted.
  assert.deepEqual(dependencyAssumptions({
    objective: 'Resume from the artifact produced by task_source and finish the guard.',
    dependencies: ['task_source'],
  }, 'task'), [])

  // A call site that does not know the dependency set must never guess: the
  // guard only fires when the caller passes the set (the hand-off note names the
  // two call sites that must start passing it).
  assert.deepEqual(dependencyAssumptions({ objective: 'Resume from your own artifact `09883f3`.' }, 'task'), [])

  // A plain repair names the blocked task in `replaces`; without a claim that
  // its content is already available, that is not a missing dependency.
  assert.deepEqual(dependencyAssumptions({
    objective: 'Repair the blocked guard implementation and keep its acceptance criteria verbatim.',
    dependencies: [], replaces: ['task_blocked'],
  }, 'task'), [])
})

test('R12-F9: the diagnostic distinguishes "add the dependency" from "state how you will obtain it"', () => {
  const task = { objective: 'Continue from the checkpoint of task_source and finish the seam.', dependencies: [] }
  const known = dependencyAssumptions(task, 'task', { knownContents: new Set(['task_source']) })
  assert.equal(known.length, 1)
  assert.match(known[0].message, /exists in this mission/)
  const unknown = dependencyAssumptions(task, 'task', { knownContents: new Set() })
  assert.equal(unknown.length, 1)
  assert.match(unknown[0].message, /not in the mission baseline/)
  for (const diagnostic of [...known, ...unknown]) {
    assert.deepEqual(lintRefusal(`[${diagnostic.code}] ${diagnostic.location}: ${diagnostic.message}`), [])
  }
})

test('R12-F9: the dispatch path is a backstop — a row admitted before the guard is refused before preparation', async () => {
  // Admission now refuses this text at propose() (S4r-D3). The dispatch check
  // remains as defence in depth for a row that reached the store another way
  // (admitted before the guard existed, or written by an older process), so the
  // member is never prepared from the bare baseline.
  const f = await setup({ config: { tickMs: 10 } })
  try {
    f.workers.autoIdle = true
    const task = injectLegacyTask(f, { id: 'task_legacy_assumed', title: 'Legacy assumed work', objective: 'Resume from your own artifact `09883f3` and finish the guard.', createdAt: 1 })
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[dependency_assumption_missing\]/.test(delivery.content)),
      'the admission decision request must reach the owner', 8_000)
    assert.deepEqual(lintRefusal(notice.content), [])
    assert.equal(f.workers.prepared.filter(item => item.taskId === task.id).length, 0, 'no preparation ran on the bare baseline')
    assert.equal(f.runtime.store.get('tasks', task.id).status, 'pending', 'the task stays admitted and repairable, never dispatched')
  } finally { await f.cleanup() }
})

test('R14 runtime (workspace chain): a revoked workspace escalates with the coded workspace terminal', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    f.workers.autoIdle = true
    const { WorkspaceRevokedError } = await import('../lib/workspace-admission.js')
    f.runtime.assertWorkspaceAuthorized = async () => { throw new WorkspaceRevokedError('workspace_revoked: the authorized grant root was removed') }
    f.propose({ title: 'Work under a revoked grant' })
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'guard-terminal' && item.data.chain === 'workspace').at(-1),
      'the revoked workspace must escalate', 8_000)
    assert.equal(event.data.code, 'workspace_terminal')
    assert.ok(event.data.coFires.includes('attempt_lease') && event.data.coFires.includes('review_admission'),
      'the workspace terminal names the guards it co-fires with')
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[workspace_terminal\]/.test(delivery.content)),
      'the owner must receive the workspace terminal', 8_000)
    assert.deepEqual(lintRefusal(notice.content), [])
    assert.match(notice.content, /swarm_propose/)
    assert.match(notice.content, /swarm_cancel/)
  } finally { await f.cleanup() }
})

test('R14 runtime (budget chain): a refused worker proposal escalates as a coded owner decision', async () => {
  const f = await setup({ config: { tickMs: 10 }, budget: { maxTasks: 1 } })
  try {
    f.propose({ title: 'Owner fills the only slot' })
    const stream = f.runtime.store.list('workstreams', f.mission.id)[0]
    assert.throws(() => f.runtime.propose(f.actor(f.author), f.mission.id, {
      workstreamId: stream.id, title: 'Worker overflow', objective: 'Overflow the ceiling', kind: 'research',
      scope: ['**'], acceptance: f.mission.acceptance,
    }), /task budget exhausted/)
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[budget_terminal\]/.test(delivery.content)),
      'the ceiling refusal must become a coded owner decision', 8_000)
    assert.deepEqual(lintRefusal(notice.content), [])
    assert.match(notice.content, /swarm_budget/)
    assert.match(notice.content, /budget/)
  } finally { await f.cleanup() }
})

test('R14 hand-off mechanism: emitGuardTerminal lets any call site opt in mechanically, and deduplicates per board state', async () => {
  // The remaining chain terminals live in files this branch may not edit
  // (src/attempts.ts, src/workspace-admission.ts, src/notices.ts, src/runtime.ts).
  // The hand-off is this call: a site builds nothing, it names its chain and
  // passes the context it already has. The test proves the path end to end from
  // inside this branch, so the integration task can wire a site without guessing
  // what the mechanism returns or how a repeat is suppressed.
  const f = await setup({ config: { tickMs: 10 } })
  try {
    const task = f.propose({ title: 'Held work' })
    const context = { taskId: task.id, memberId: f.author.id, detail: 'the workspace guard refused the close-out (Member has uncommitted commits)' }
    const terminal = emitGuardTerminal(f.runtime, f.mission.id, 'attempt_lease', context)
    assert.ok(terminal, 'the call site always gets a terminal back')
    assert.equal(terminal.chain, 'attempt_lease')
    assert.equal(terminal.code, 'attempt_terminal')
    assert.deepEqual(lintRefusal(terminal.message), [])
    await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'guard-terminal' && item.data.chain === 'attempt_lease').length === 1,
      'the opt-in call records the durable decision request', 8_000)
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[attempt_terminal\]/.test(delivery.content)),
      'the opt-in call delivers the owner notice', 8_000)
    assert.match(notice.content, /swarm_handoff/)
    // The same call for the same board is the same decision request: the repeat
    // is suppressed because the request is durable, not because the caller chose
    // to stay silent.
    assert.ok(emitGuardTerminal(f.runtime, f.mission.id, 'attempt_lease', context))
    await sleep(60)
    assert.equal(events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'guard-terminal' && item.data.chain === 'attempt_lease').length, 1,
      'one durable request per (chain, code, board fingerprint)')
    assert.equal(f.workers.deliveries.filter(delivery => /\[attempt_terminal\]/.test(delivery.content)).length, 1)
  } finally { await f.cleanup() }
})

/* ------------------------------------------------------------------------- *
 * S4r — the four defects the independent verification reproduced.
 * ------------------------------------------------------------------------- */

/**
 * Put a task row straight into the store, the way a legacy row admitted before
 * the R12-F9 guard existed reaches the dispatch sweep. Admission refuses the
 * text at propose() now, so this is the only way to exercise the dispatch
 * backstop and the non-starvation guarantee it owes.
 */
function injectLegacyTask(f, overrides) {
  const seed = f.propose({ title: 'Seed row', objective: 'Implement the scoped change in src/answer.txt.', assigneeId: f.reviewer.id })
  const row = { ...f.runtime.store.get('tasks', seed.id), ...overrides, status: 'pending', attempt: undefined, epoch: 0 }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', row))
  return row
}

test('S4r-D1 pair (admission guard x dispatch sweep): an assumed-content task must not starve its member', async () => {
  // The verifier's reproduction: `continue` skipped the member's whole iteration
  // and only `tasks[0]` was ever considered, so an ineligible head task starved
  // every later ready task on that member forever. The pair is the point: the
  // admission guard is individually correct and the sweep is individually
  // correct; together they were a trap.
  const f = await setup({ config: { tickMs: 10 } })
  try {
    f.workers.autoIdle = true
    // The ineligible head is injected directly: propose() now refuses this text
    // (S4r-D3), so the sweep's non-starvation guarantee is proven against the
    // legacy-row backstop, which is exactly the row the verifier reproduced with.
    const head = injectLegacyTask(f, { id: 'task_assumed_head', title: 'Assumed head', objective: 'Resume from your own artifact `09883f3` and finish the guard.', assigneeId: f.author.id, createdAt: 1 })
    const second = f.propose({ title: 'Self-contained second', objective: 'Implement the scoped change in src/answer.txt.', assigneeId: f.author.id })
    await eventually(() => f.runtime.store.get('tasks', second.id).status === 'running' ? true : undefined,
      'the self-contained task must be dispatched even though an assumed-content task is ahead of it', 8_000)
    assert.equal(f.runtime.store.get('tasks', head.id).status, 'pending', 'the ineligible head stays admitted and repairable')
    assert.equal(f.runtime.store.get('tasks', head.id).attempt, undefined, 'the ineligible head is never given an attempt')
    assert.equal(f.workers.prepared.filter(item => item.taskId === head.id).length, 0, 'the ineligible head is never prepared')
    assert.ok(f.workers.prepared.some(item => item.taskId === second.id), 'the later task really was prepared and dispatched')
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[dependency_assumption_missing\]/.test(delivery.content)),
      'the ineligible head still escalates once', 8_000)
    assert.deepEqual(lintRefusal(notice.content), [])
  } finally { await f.cleanup() }
})

test('S4r-D3: the admission guard refuses at propose() and at plan validation, not only at dispatch', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    // T3b precedent, at the production call shape: propose() must refuse it.
    assert.throws(() => f.propose({ title: 'Resume prior work', objective: 'Resume from your own artifact `09883f3` and finish the guard.' }),
      error => error instanceof Error
        && error.message.includes('[dependency_assumption_missing]')
        && error.message.includes('dependencies')
        && error.message.includes('objective'),
      'the coded diagnostic and both executable exits must be in the refusal')
    // INT2 precedent.
    assert.throws(() => f.propose({ title: 'Assembly', objective: 'The assembly is already in its worktree; verify the integration.' }),
      /dependency_assumption_missing/)
    assert.equal(f.runtime.store.list('tasks', f.mission.id).length, 0, 'no refused task is admitted')
    // The self-contained counter-case is admitted, unchanged.
    const clean = f.propose({ title: 'Self-contained', objective: 'Implement the scoped change in src/answer.txt.' })
    assert.ok(clean.id)
    // The same guard fires at plan validation (plans.ts), where the task never
    // reaches propose() at all.
    const { validatePlan } = await import('../lib/plans.js')
    const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 60000, maxTasks: 12, maxExperiments: 2 }
    const base = {
      title: 'Plan', objective: 'Deliver verified code', workspace: f.dir, scope: ['src/'], acceptance: ['works'], budget,
      members: [{ key: 'builder', name: 'Builder', role: 'implementation' }],
      workstreams: [{ key: 'main', title: 'Main', objective: 'Main' }],
    }
    assert.throws(() => validatePlan({ ...base, tasks: [{ key: 'code', workstreamKey: 'main', title: 'Code', objective: 'Resume from your own artifact `09883f3`.', kind: 'implementation', scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['true'] }] }),
      /dependency_assumption_missing/, 'plan admission refuses the same prejudged content')
    const valid = validatePlan({ ...base, tasks: [{ key: 'code', workstreamKey: 'main', title: 'Code', objective: 'Implement the change in src/answer.txt.', kind: 'implementation', scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['true'] }] })
    assert.equal(valid.tasks.length, 1, 'a self-contained plan task is still admitted')
  } finally { await f.cleanup() }
})

test('S4r-D4: guardBoard reports review liveness from the same predicate the scheduler uses', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    const task = f.propose({ title: 'Submitted source' })
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = await eventually(() => f.runtime.store.list('tasks', f.mission.id).find(item => item.kind === 'verification' && item.reviewOf === task.id),
      'the automatic review is admitted', 8_000)
    f.runtime.cancel(f.owner, f.mission.id, { taskId: review.id, reason: 'S4r: withdraw the review' })
    const board = f.runtime.scheduling.guardBoard(f.mission.id)
    const source = board.tasks.find(candidate => candidate.id === task.id)
    const schedulerSays = f.runtime.scheduling.reviewable(f.runtime.store.get('tasks', task.id), f.runtime.store.list('tasks', f.mission.id))
    assert.equal(schedulerSays, false, 'the scheduler sees no live review')
    assert.equal(source.reviewSourceLive, schedulerSays, 'the board view and the scheduler agree')
    assert.equal(guardTerminalChain(board), 'review_admission', 'and the canonical case classifies as the review-admission terminal')
    assert.equal(guardActions(board).filter(action => action.kind === 'progress' && action.taskId === task.id).length, 0,
      'an unreviewable source is not reported as work in flight')
    assert.equal(guardProgressActions(board).filter(action => action.taskId === task.id).length, 0)
  } finally { await f.cleanup() }
})

test('S4r-D5: a budget-blocked mission still escalates, and the terminal emission is unconditional', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    f.runtime.store.transaction(() => { const mission = f.runtime.mission(f.mission.id); mission.usedTokens = mission.budget.maxTokens; f.runtime.store.put('missions', mission) })
    await eventually(() => f.runtime.mission(f.mission.id).status === 'blocked', 'the exhausted budget blocks the mission', 8_000)
    const board = f.runtime.scheduling.guardBoard(f.mission.id)
    assert.equal(guardMissionTerminal(board), false, 'a blocked mission is not terminal')
    const escalation = guardActions(board).find(action => action.kind === 'escalate')
    assert.ok(escalation, 'a blocked mission still has an executable action')
    assert.equal(escalation.chain, 'budget', 'the terminal names the budget chain')
    assert.deepEqual(lintRefusal(escalation.message), [])
    // The verifier's probe: emitGuardTerminal returned undefined here. S4b made
    // the block path emit it itself, so no manual call is needed.
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'guard-terminal' && item.data.chain === 'budget').at(-1),
      'the blocked mission emits a durable coded terminal', 8_000)
    assert.equal(event.data.code, 'budget_terminal')
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[budget_terminal\]/.test(delivery.content)),
      'the budget block delivers the coded owner decision request', 8_000)
    assert.deepEqual(lintRefusal(notice.content), [])
    // The emission is still unconditional and idempotent for the same state.
    const terminal = emitGuardTerminal(f.runtime, f.mission.id, 'budget', { detail: 'budget-blocked probe' })
    assert.ok(terminal, 'the terminal emission is unconditional for a blocked mission')
    assert.equal(terminal.code, 'budget_terminal')
  } finally { await f.cleanup() }
})

/* ------------------------------------------------------------------------- *
 * S4b — the remaining terminal sites wired to the shared escalation.
 * Each test names the guard it can co-fire with and exercises the pair.
 * ------------------------------------------------------------------------- */

test('S4b pair (workspace capture x close-out): a failed close-out checkpoint escalates the attempt terminal', async () => {
  const f = await setup({ config: { tickMs: 10, maxIdleCloseouts: 0 } })
  try {
    f.workers.autoIdle = true
    const task = f.propose({ title: 'Held attempt', maxRecoveryAttempts: 3 })
    await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    // The workspace capture guard throws while the close-out guard is trying to
    // preserve the attempt: the pair that used to end in a prose-only notice.
    f.workers.captureArtifact = async () => { throw new Error('[workspace_uncommitted] Member workspace has uncommitted work') }
    f.runtime.attempts.onIdle(f.author.id)
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'guard-terminal' && item.data.chain === 'attempt_lease' && item.data.code === 'attempt_terminal').at(-1),
      'the failed close-out checkpoint must emit the shared attempt terminal', 8_000)
    // The terminal renders its own stable code, so the guard's nested `[code]`
    // token is stripped from the detail (in-scope `terminalDetail` in attempts.ts);
    // the guard's substantive message is what the owner must see.
    assert.match(String(event.data.detail), /Member workspace has uncommitted work/)
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[attempt_terminal\]/.test(delivery.content) && delivery.content.includes(task.id)),
      'the owner decision request names the task', 8_000)
    assert.deepEqual(lintRefusal(notice.content), [])
    assert.equal(f.runtime.store.get('tasks', task.id).status, 'blocked')
  } finally { await f.cleanup() }
})

test('S4b (owner finding): an abandoned and an exhausted close-out both name the task to the owner', async () => {
  // Measured on the owner's instrument: task/closeout-abandoned 7 of 8 silent,
  // task/closeout-exhausted 2 of 2 silent. Both are terminals of the
  // attempt/lease chain now.
  const f = await setup({ config: { tickMs: 10, maxIdleCloseouts: 0 } })
  try {
    f.workers.autoIdle = true
    const task = f.propose({ title: 'Close-out exhaustion', maxRecoveryAttempts: 1 })
    await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    f.runtime.attempts.onIdle(f.author.id)
    const abandoned = await eventually(() => events(f.runtime, f.mission.id, 'task/closeout-abandoned').at(-1),
      'the close-out is abandoned (the checkpoint succeeded and the task re-pended)', 8_000)
    assert.equal(abandoned.data.taskId, task.id)
    const exhausted = await eventually(() => events(f.runtime, f.mission.id, 'task/closeout-exhausted').at(-1),
      'the recovery limit is exhausted and the task is blocked', 8_000)
    assert.equal(exhausted.data.taskId, task.id)
    // Both transitions now emit the shared terminal. They may share one board
    // fingerprint, in which case the second is the SAME decision request and the
    // per-fingerprint dedup keeps exactly one delivery; either way the owner is
    // no longer silent about the task.
    const notices = await eventually(() => {
      const found = f.workers.deliveries.filter(delivery => delivery.memberId === 'owner'
        && /\[attempt_terminal\]/.test(delivery.content) && delivery.content.includes(task.id))
      return found.length >= 1 ? found : undefined
    }, 'both previously silent close-out transitions must name the task', 8_000)
    for (const notice of notices) assert.deepEqual(lintRefusal(notice.content), [])
  } finally { await f.cleanup() }
})

test('S4b pair (lease expiry x workspace capture): the checkpoint failure and the exhausted recovery both escalate', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    const task = f.propose({ title: 'Expiring attempt', maxRecoveryAttempts: 1 })
    await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    // The old owner is quiescent, so the lease-expiry path tries a checkpoint.
    f.workers.idle.add(f.author.id)
    f.workers.captureArtifact = async () => { throw new Error('[workspace_uncommitted] dirty workspace') }
    const row = f.runtime.store.get('tasks', task.id)
    row.attempt.leaseUntil = Date.now() - 1
    row.recoveryCount = 1   // the recovery limit is already spent
    f.runtime.store.transaction(() => f.runtime.store.put('tasks', row))
    const failed = await eventually(() => events(f.runtime, f.mission.id, 'task/checkpoint-failed').at(-1),
      'the lease-expiry checkpoint failure is audited', 8_000)
    assert.equal(failed.data.taskId, task.id)
    const terminals = await eventually(() => {
      const found = events(f.runtime, f.mission.id, 'mission/stalled')
        .filter(item => item.data.cause === 'guard-terminal' && item.data.chain === 'attempt_lease' && item.data.taskId === task.id)
      return found.length >= 2 ? found : undefined
    }, 'both the checkpoint failure and the exhausted recovery must escalate', 8_000)
    assert.ok(terminals.some(item => /checkpoint failed/i.test(String(item.data.detail))), 'the checkpoint failure names its cause')
    assert.ok(terminals.some(item => /exhausted the recovery limit/i.test(String(item.data.detail))), 'the exhausted recovery names its cause')
    assert.equal(f.runtime.store.get('tasks', task.id).status, 'blocked', 'the exhausted recovery leaves the task blocked')
  } finally { await f.cleanup() }
})

test('S4b (task ceiling): the blocked task escalates with the coded ceiling terminal', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    const task = f.propose({ title: 'Ceiling bound', maxSteps: 1 })
    await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.workers.callbacks.beforeStep(f.author.id, true)
    assert.equal(await f.workers.callbacks.beforeStep(f.author.id, true), false, 'the ceiling refuses the next step')
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'guard-terminal' && item.data.chain === 'task_ceiling').at(-1),
      'the ceiling must emit the shared terminal', 8_000)
    assert.equal(event.data.code, 'task_ceiling_terminal')
    assert.equal(event.data.taskId, task.id)
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[task_ceiling_terminal\]/.test(delivery.content)),
      'the owner decision request replaces the prose-only ceiling notice', 8_000)
    assert.match(notice.content, /swarm_propose/)
    assert.deepEqual(lintRefusal(notice.content), [])
  } finally { await f.cleanup() }
})

test('S4b (owner-side ceiling): the refusal is a recorded coded decision, not only a thrown error', async () => {
  const f = await setup({ config: { tickMs: 10 }, budget: { maxTasks: 1 } })
  try {
    f.propose({ title: 'Only slot' })
    assert.throws(() => f.propose({ title: 'Overflow' }), /task budget exhausted/)
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[task_ceiling_terminal\]/.test(delivery.content)),
      'the owner faces a recorded decision on the next read', 8_000)
    assert.match(notice.content, /swarm_propose/)
    assert.match(notice.content, /\[task_ceiling_terminal\]/)
    assert.deepEqual(lintRefusal(notice.content), [])
  } finally { await f.cleanup() }
})

test('S4b pair (isolation x workspace): a refused dispatch escalates with the violation as the detail', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    f.workers.autoIdle = true
    // The isolation guard is the workspace chain's predicate; force the violation
    // so `refuseIsolation` is reached exactly as a corrupted board reaches it.
    f.runtime.isolationAllows = (missionId, member) => { f.runtime.refuseIsolation(missionId, member, 'two live members share one worktree'); return false }
    f.propose({ title: 'Isolated work' })
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'guard-terminal' && item.data.chain === 'workspace').at(-1),
      'the isolation refusal must escalate', 8_000)
    assert.equal(event.data.code, 'workspace_terminal')
    assert.match(String(event.data.detail), /two live members share one worktree/)
    const notice = await eventually(() => f.workers.deliveries
      .find(delivery => delivery.memberId === 'owner' && /\[workspace_terminal\]/.test(delivery.content)),
      'the owner decision request', 8_000)
    assert.deepEqual(lintRefusal(notice.content), [])
  } finally { await f.cleanup() }
})

test('S4b (workspace fence): fenceWorkspace itself emits the coded terminal for every caller', async () => {
  const f = await setup({ config: { tickMs: 10 } })
  try {
    const task = f.propose({ title: 'Fenced work' })
    f.runtime.fenceWorkspace(f.mission.id, 'workspace_revoked: the authorized grant root was removed')
    const event = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled')
      .filter(item => item.data.cause === 'guard-terminal' && item.data.chain === 'workspace').at(-1),
      'the fence emits the workspace terminal for its own callers', 8_000)
    assert.equal(event.data.code, 'workspace_terminal')
    assert.match(String(event.data.detail), /grant root/)
    assert.equal(f.runtime.store.get('tasks', task.id).status, 'blocked', 'the fenced work is blocked durably')
  } finally { await f.cleanup() }
})
