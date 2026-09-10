/**
 * Round 14 guard state machines: the generated board space, the transition
 * relation and the reachable closure, shared by `tests/guard-terminals.test.mjs`
 * (the guard-terminal property test) and `tests/dead-end-census.test.mjs` (the
 * dead-end census). One generator, so the census is a classification over the
 * same state space the property is asserted on, not a second model of the board.
 *
 * Extracted verbatim from `tests/guard-terminals.test.mjs` (S4r); the dimensions,
 * the transition relation and the documented limits are unchanged.
 */

/** The seven control-path chains whose terminal element must escalate. */
export const CHAINS = ['budget', 'workspace', 'attempt_lease', 'task_ceiling', 'review_admission', 'dispatch_preconditions', 'admission']

export const TASK_STATUS = ['pending', 'running', 'submitted', 'blocked', 'accepted', 'cancelled']
export const ATTEMPTS = [{ label: 'no-attempt' }, { label: 'live-attempt', attempt: { leaseLive: true } }, { label: 'lapsed-attempt', attempt: { leaseLive: false } }]
export const WORKSPACES = ['authorized', 'revoked', 'dirty', 'unprovisioned']
export const MEMBER_STATUS = ['idle', 'working', 'waiting', 'stopped']
export const BUDGETS = [{ label: 'clear' }, { label: 'paused', budgetPaused: true }, { label: 'blocked', budgetBlocked: 'token budget exhausted (9/9)' }]
/**
 * The conditions that are not one of the five named dimensions, but that decide
 * which chain the terminal names. Each becomes its own seed for the reachable
 * closure below, so every chain is exercised without pretending these flags are
 * freely reachable from a healthy board.
 */
export const FLAGS = [
  { label: 'plain' },
  { label: 'ceiling-exhausted', ceilingExhausted: true },
  { label: 'preparation-exhausted', preparationExhausted: true },
  { label: 'assumed-content', assumedContent: true },
  { label: 'review-dead', reviewOf: 'task_source', reviewSourceLive: false },
  { label: 'review-live', reviewOf: 'task_source', reviewSourceLive: true },
  { label: 'dependency-unsatisfied', dependenciesSatisfied: false },
  { label: 'dependency-dead', dependenciesDead: true },
]
export const MISSION_BASE = { status: 'active', workspace: 'authorized' }
/** S4r-D5: mission status is a generated dimension, including `blocked` (a budget stop). */
export const MISSION_STATUS = ['active', 'blocked', 'paused', 'staged', 'completed', 'stopped']
export const TASK_ID = 'task_generated'
export const MEMBER_ID = 'member_generated'

export const budgetFields = budget => (budget.budgetPaused === true ? { budgetPaused: true } : budget.budgetBlocked === undefined ? {} : { budgetBlocked: budget.budgetBlocked })
export const flagFields = flag => {
  const fields = {}
  if (flag.ceilingExhausted) fields.ceilingExhausted = true
  if (flag.preparationExhausted) fields.preparationExhausted = true
  if (flag.assumedContent) fields.assumedContent = true
  if (flag.dependenciesSatisfied === false) fields.dependenciesSatisfied = false
  if (flag.dependenciesDead === true) fields.dependenciesDead = true
  if (flag.reviewOf !== undefined) { fields.reviewOf = flag.reviewOf; fields.reviewSourceLive = flag.reviewSourceLive }
  return fields
}

/** The full enumerated cross product: the state space the generator considers. */
export function generatedBoards() {
  const boards = []
  for (const status of TASK_STATUS) for (const attempt of ATTEMPTS) for (const workspace of WORKSPACES)
    for (const member of MEMBER_STATUS) for (const budget of BUDGETS) for (const flag of FLAGS) for (const missionStatus of MISSION_STATUS) {
      boards.push({
        mission: { ...MISSION_BASE, status: missionStatus, workspace, ...budgetFields(budget) },
        // DEAD: the attempt dimension is `attempt: { leaseLive }` on the task, as
        // `GuardTask` declares it. Spreading the inner object (the S4r form) put
        // `leaseLive` at the top level, so the enumerated space contained no
        // attempt at all and the "unreached states" comparison silently ignored
        // the dimension it names.
        tasks: [{ id: TASK_ID, status, ...(attempt.attempt === undefined ? {} : { attempt: attempt.attempt }), ...flagFields(flag) }],
        members: [{ id: MEMBER_ID, status: member }],
      })
    }
  return boards
}

export const keyOf = board => JSON.stringify([board.mission, board.tasks, board.members])
/**
 * One transition relation over the five named dimensions. It is the closure of
 * board changes a real scheduler and its actors can make: work is dispatched,
 * an attempt's lease lapses, a lapsed attempt is recovered to blocked or
 * pending, running work is submitted, a verdict accepts or a rejection blocks
 * the source, blocked work is re-pended or withdrawn, the budget is paused or
 * blocked, the workspace state moves, and a member stops, parks, idles or works.
 * It is deliberately permissive: over-approximating reachability asserts the
 * property on *more* states than a real board can take, which is the safe
 * direction for this property.
 */
export function nextStates(board) {
  const next = []
  const task = board.tasks[0]
  const push = patch => next.push({ ...board, ...patch })
  for (const workspace of WORKSPACES) if (workspace !== board.mission.workspace) push({ mission: { ...board.mission, workspace } })
  for (const budget of BUDGETS) push({ mission: { ...board.mission, ...budgetFields(budget) } })
  // S4r-D5: the mission can leave `active` for a non-terminal status (a budget
  // stop blocks it) or reach a terminal one; both are part of the closure now.
  for (const status of MISSION_STATUS) if (status !== board.mission.status) push({ mission: { ...board.mission, status } })
  for (const status of MEMBER_STATUS) if (status !== board.members[0].status) push({ members: [{ ...board.members[0], status }] })
  if (task.status === 'running' && task.attempt?.leaseLive === true) push({ tasks: [{ ...task, attempt: { leaseLive: false } }] })
  if (task.status === 'running' && task.attempt !== undefined && task.attempt.leaseLive === false) {
    push({ tasks: [{ ...task, status: 'blocked', attempt: undefined }] })
    push({ tasks: [{ ...task, status: 'pending', attempt: undefined }] })
  }
  if (task.status === 'pending') {
    push({ tasks: [{ ...task, status: 'running', attempt: { leaseLive: true } }] })
    push({ tasks: [{ ...task, status: 'cancelled', attempt: undefined }] })
  }
  if (task.status === 'running') {
    if (task.attempt?.leaseLive === true) push({ tasks: [{ ...task, status: 'submitted', attempt: undefined }] })
    push({ tasks: [{ ...task, status: 'blocked', attempt: undefined }] })
  }
  if (task.status === 'submitted') {
    push({ tasks: [{ ...task, status: 'accepted', attempt: undefined }] })
    push({ tasks: [{ ...task, status: 'blocked', attempt: undefined }] })
  }
  if (task.status === 'blocked') {
    push({ tasks: [{ ...task, status: 'pending' }] })
    push({ tasks: [{ ...task, status: 'cancelled' }] })
  }
  return next
}

/** Breadth-first closure from one seed, bounded so a future transition loop cannot hang the suite. */
export function reachableFrom(seed, limit = 4000) {
  const seen = new Map([[keyOf(seed), seed]])
  const queue = [seed]
  while (queue.length > 0 && seen.size < limit) {
    const board = queue.shift()
    for (const candidate of nextStates(board)) if (!seen.has(keyOf(candidate))) { seen.set(keyOf(candidate), candidate); queue.push(candidate) }
  }
  return seen
}

/**
 * The closure the property test and the census both use: every flag seed at
 * every mission status, merged. Returned as a Map keyed by the canonical board
 * key so a caller can dedupe and count.
 */
export function reachableClosure() {
  const reachable = new Map()
  for (const flag of FLAGS) for (const missionStatus of MISSION_STATUS) {
    const seed = {
      mission: { ...MISSION_BASE, status: missionStatus },
      tasks: [{ id: TASK_ID, status: 'pending', ...flagFields(flag) }],
      members: [{ id: MEMBER_ID, status: 'idle' }],
    }
    for (const [key, board] of reachableFrom(seed)) if (!reachable.has(key)) reachable.set(key, board)
  }
  return reachable
}

/**
 * What this generator does NOT reach, stated rather than implied:
 *  - multi-task boards: dependency graphs, review-task pairs, several members,
 *    and two tasks competing for one admission slot;
 *  - concurrency and interleaving: a lease that expires mid-await, a writer-busy
 *    transaction, a pass released by the watchdog, adapter start failures;
 *  - wall-clock behaviour: the review grace window and the no-progress window
 *    are inputs here, not durations;
 *  - the terminal task states accepted/cancelled with an attempt attached, which
 *    the transition relation cannot produce because no actor can attach one.
 *    (Mission status IS a generated dimension since S4r: active, blocked, paused,
 *    staged, completed and stopped are all reached, and the tests assert that the
 *    closure includes a budget-blocked mission — the state that hid S4r-D5.)
 * The runtime-level tests cover the first two classes for the real pairs; the
 * remaining gaps are named in the round's hand-off notes.
 */
export const generatorLimits = {
  unreachedExample: { mission: { ...MISSION_BASE }, tasks: [{ id: TASK_ID, status: 'accepted', attempt: { leaseLive: true } }], members: [{ id: MEMBER_ID, status: 'idle' }] },
}
