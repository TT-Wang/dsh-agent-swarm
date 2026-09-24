/**
 * Round 14: the guard-chain board model, a TEST instrument.
 *
 * The kernel obligation is structural: every guard chain ends in an escalation
 * that has no conditions of its own, so a dead end is impossible. In production
 * that terminal element is `emitGuardTerminal` (src/refusals.ts), which every
 * chain calls directly with `guardTerminal`'s coded request. This module is the
 * vocabulary the property test and the dead-end census use to CHECK that claim
 * over a generated board space: `guardDispatchActions` and `guardProgressActions`
 * describe every action an earlier element of a chain can still produce;
 * `guardTerminalChain` names the chain whose earlier elements have all answered
 * "no"; `terminalEscalation` turns that into the same coded, actionable
 * `guardTerminal` request production emits.
 *
 * It lived in src/scheduling.ts until nothing in src/ called it: the dispatch
 * path decides with its own predicates and escalates through
 * `Scheduling.escalateGuardTerminal` -> `emitGuardTerminal`, never through
 * `guardActions`. Moving it here keeps the census and the property test while
 * shipping no decision code production does not run.
 *
 * The model is pure: no store, no clock, no cache. `guardBoard` is the one
 * reader of a live runtime: it projects the durable rows into the board shape,
 * using the scheduler's own `reviewable` predicate and the runtime's derived
 * member board, so a test can classify a real board.
 */
import { guardTerminal } from '../lib/refusals.js'
import { taskCeilingExhaustion } from '../lib/admission.js'
import { authorIdsOf } from '../lib/assignment.js'

/**
 * The durable board as the guard-chain model sees it. Every field is derived
 * from a durable row (or a durable event), never from an in-memory gate.
 */
export function guardBoard(runtime, missionId, mission) {
  const row = mission ?? runtime.store.get('missions', missionId)
  const tasks = runtime.store.list('tasks', missionId)
  const now = Date.now()
  const revoked = runtime.store.events(missionId, 1000).some(event => event.type === 'mission/workspace-revoked')
  return {
    mission: {
      status: row?.status ?? 'active',
      workspace: revoked ? 'revoked' : 'authorized',
      ...(row?.budgetPause === undefined ? {} : { budgetPaused: true }),
    },
    tasks: tasks.map(task => {
      const exhaustion = taskCeilingExhaustion(task)
      const source = task.reviewOf === undefined ? undefined : runtime.task(missionId, task.reviewOf)
      const reviewSourceLive = task.reviewOf === undefined
        ? (task.status === 'submitted' ? runtime.reviewable(task, tasks) : undefined)
        // A review whose named source is missing can never be dispatched: the
        // scheduler's `capable` reads the source row, so a dangling review is
        // reported as no live source rather than omitted.
        : source !== undefined && source.status === 'submitted'
      return {
        id: task.id, status: task.status,
        ...(task.attempt === undefined ? {} : { attempt: { leaseLive: task.attempt.leaseUntil >= now } }),
        ...(exhaustion === undefined ? {} : { ceilingExhausted: true }),
        dependenciesSatisfied: task.dependencies.every(dependency => runtime.dependencySatisfied(missionId, dependency, tasks)),
        dependenciesDead: task.dependencies.some(dependency => runtime.effectiveDependency(missionId, dependency, tasks).status === 'cancelled'),
        ...(task.reviewOf === undefined ? {} : { reviewOf: task.reviewOf }),
        // S4r-D4: `reviewSourceLive` is the SAME predicate the scheduler uses. A
        // review task is live exactly while its source is submitted (`capable`);
        // a submitted source is live exactly while `reviewable` finds a live
        // independent review.
        ...(reviewSourceLive === undefined ? {} : { reviewSourceLive }),
        ...(source === undefined ? {} : { authorMemberIds: [...authorIdsOf(source)] }),
        // The recorded preparation failure, not the prose of `task.output`,
        // which a later transition rewrites or leaves stale.
        preparationExhausted: task.status === 'blocked' && runtime.taskBlockCauses(task).has('preparation-failed'),
      }
    }),
    // R17-G6/G7: the member half is READ from the runtime's derived member board,
    // so the model is an instance of the projection being read, not a second
    // interpretation of the rows. A dead lease stays the model's own
    // classification (`guardTerminalChain` reads the task rows).
    members: runtime.memberBoard(missionId).map(member => ({ id: member.id, status: member.status })),
  }
}

const isLiveMember = member => member.status === 'idle' || member.status === 'waiting'

/**
 * Every (task, member) pair an earlier element of the dispatch-precondition
 * chain can still act on. A task is dispatchable only when the whole chain
 * before the terminal answered "yes": the mission is active, the budget is not
 * paused or exhausted, the workspace is authorized, the task is pending, it has
 * not spent its own ceiling or its preparation recovery, its dependency lineage
 * is alive and satisfied, its review source is live when it is a review, and a
 * live member who did not author that source can take it.
 */
export function guardDispatchActions(board) {
  const mission = board.mission
  if (mission.status !== 'active' || mission.budgetPaused === true || mission.budgetBlocked !== undefined || mission.workspace !== 'authorized') return []
  const actions = []
  for (const task of board.tasks) {
    if (task.status !== 'pending' || task.ceilingExhausted === true || task.preparationExhausted === true) continue
    if (task.dependenciesSatisfied === false || task.dependenciesDead === true) continue
    if (task.reviewOf !== undefined && task.reviewSourceLive === false) continue
    const member = board.members.find(candidate => isLiveMember(candidate) && candidate.isolated !== false
      && !(task.authorMemberIds ?? []).includes(candidate.id))
    if (member !== undefined) actions.push({ kind: 'dispatch', chain: 'dispatch_preconditions', taskId: task.id, memberId: member.id })
  }
  return actions
}

/**
 * Work already in flight. A live lease, a working member or a submitted source
 * whose review is still live is progress, so the board is not a dead end and no
 * terminal escalation is owed. Deliberately derived from the board, not from the
 * terminal function, so the property test cannot be circular.
 *
 * "In flight" is only progress while the chains that gate it can still let it
 * land: an attempt whose workspace cannot produce an artifact, or whose mission
 * is paused or out of budget, is executing but can never reach its terminal
 * step — that is exactly the 2026-09-10 trap, and it counts as a dead end
 * rather than as liveness.
 */
export function guardProgressActions(board) {
  const mission = board.mission
  if (mission.status !== 'active' || mission.budgetPaused === true || mission.budgetBlocked !== undefined || mission.workspace !== 'authorized') return []
  const actions = []
  for (const task of board.tasks) {
    if (task.status === 'running' && task.attempt !== undefined && task.attempt.leaseLive) {
      actions.push({ kind: 'progress', chain: 'attempt_lease', taskId: task.id, detail: 'a running attempt holds a live lease' })
    }
    if (task.status === 'submitted' && task.reviewOf === undefined && task.reviewSourceLive !== false) {
      actions.push({ kind: 'progress', chain: 'review_admission', taskId: task.id, detail: 'a submitted source has a live review path' })
    }
  }
  for (const member of board.members) {
    if (member.status === 'working') actions.push({ kind: 'progress', chain: 'dispatch_preconditions', memberId: member.id, detail: 'the member is working' })
  }
  return actions
}

/**
 * The chain whose earlier elements have all answered "no". Ordered so the
 * classification names the *first* chain that cannot progress: a board with an
 * exhausted budget and a revoked workspace is a budget decision first, because
 * no lease can be admitted until the ceiling moves.
 */
export function guardTerminalChain(board) {
  const live = board.tasks.filter(task => task.status !== 'accepted' && task.status !== 'cancelled')
  if (board.mission.budgetBlocked !== undefined || board.mission.budgetPaused === true) return 'budget'
  if (live.length > 0 && board.mission.workspace !== 'authorized') return 'workspace'
  if (board.tasks.some(task => task.status === 'running' && task.attempt !== undefined && !task.attempt.leaseLive)) return 'attempt_lease'
  if (board.tasks.some(task => task.ceilingExhausted === true && task.status !== 'accepted' && task.status !== 'cancelled')) return 'task_ceiling'
  if (board.tasks.some(task => task.status === 'submitted' && task.reviewSourceLive === false)) return 'review_admission'
  return 'dispatch_preconditions'
}

/**
 * The unconditional terminal element: total by construction. It takes a board
 * and always returns an escalation built by production's `guardTerminal` — the
 * only branch that carries no earlier failure is the generic "no executable
 * action remains" one — so no board can end its chain with nothing emitted.
 */
export function terminalEscalation(board) {
  const chain = guardTerminalChain(board)
  const task = board.tasks.find(candidate => candidate.status !== 'accepted' && candidate.status !== 'cancelled')
  const member = board.members.find(candidate => candidate.status === 'working') ?? board.members[0]
  const terminal = guardTerminal(chain, { ...(task === undefined ? {} : { taskId: task.id }), ...(member === undefined ? {} : { memberId: member.id }) })
  return { kind: 'escalate', ...terminal, ...(task === undefined ? {} : { taskId: task.id }) }
}

/**
 * True only for the mission statuses no actor can bring back: `completed` and
 * `stopped`. Everything else — including `blocked` (a budget stop) and `paused` —
 * still owes the owner an executable action, which is the whole point of the
 * terminal element (`emitGuardTerminal` bails only on a terminal mission).
 */
export function guardMissionTerminal(board) {
  return board.mission.status === 'completed' || board.mission.status === 'stopped'
}

/** Every action the model can see: dispatch, progress, or the unconditional terminal. */
export function guardActions(board) {
  const dispatch = guardDispatchActions(board)
  const progress = guardProgressActions(board)
  // S4r-D5: the terminal is appended for every non-terminal mission status, not
  // only for `active`. A budget-blocked mission (`status: 'blocked'`,
  // `budgetPause` set) is exactly when the owner needs the coded exit.
  if (dispatch.length > 0 || progress.length > 0 || guardMissionTerminal(board)) return [...dispatch, ...progress]
  return [...dispatch, ...progress, terminalEscalation(board)]
}
