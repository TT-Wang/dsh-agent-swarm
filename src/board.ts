/**
 * The board every decision reads, and the declared bounds it is judged against.
 *
 * A board is one mission's rows read at one instant (`readBoard`): the mission
 * with its execution clock applied, its tasks, its members and the task graph
 * over them (`graph`, whose lineage queries a decision asks of it). The
 * scheduling and review-admission decisions below are functions of it, and so
 * are the stall classifiers, F(S) and the interpretation the board classifiers
 * read (`interpret`), so a reader builds the board where it decides
 * and every predicate it asks sees those rows; none re-reads a row. Three
 * inputs are not rows and are never snapshotted: the clock (`clock`, read where
 * a decision needs the time), the adapter (`view`, asked where a decision needs
 * its answer) and the durable log (`records`: task events, tool runs, the
 * deliveries ledger and evidence, read where a decision reads it).
 */
import { createHash } from 'node:crypto'
import type { SwarmStore } from './store.ts'
import { PolicyError } from './policy-error.ts'
import { executionClock } from './resource-time.ts'
import { assignmentAllows, authorIdsOf, canBorrowTask, canOwnReview, strandedReview } from './assignment.ts'
import { memberPhaseOf } from './projection.ts'
import { recoveryExit } from './check-results.ts'
import { scopeKeysOverlap } from './scheduler.ts'
import { TERMINAL_STATES, blockCauses, completionExempt, holdsOpenAttempt, missionSubject, openAttempt, pendingStopOwner, quiescencePending, selectAcceptedDelivery, stopPending, subjectsOfTasks, taskGraphIndex, taskSubject, terminal, uncoveredCriteria, type HeldTask, type TaskGraphIndex } from './task-graph.ts'
import { providerQuiescent, type AutoStart, type CheckResult, type Delivery, type Evidence, type Member, type Mission, type RuntimeConfig, type Task, type WorkerActivity } from './types.ts'

/**
 * S1: the bound on one scheduling pass before the runtime names it wedged, in
 * `tickMs` (RuntimeConfig.`stallPassTimeoutMs`), never a constant a wedged pass
 * can be trapped behind.
 */
const DEFAULT_STALL_PASS_TIMEOUT_TICKS = 30
/**
 * R16-D: the additional declared window a wedged scheduling pass stays live
 * (unnamed) while the mission still has live work, in pass bounds. The default
 * is the pass bound itself (so a wedge is named after at most 2 ×
 * `stallPassTimeoutMs`), and it is configuration: `stallPassLiveGraceMs`, `0`
 * meaning "name it at the first bound". Without it the naming was unbounded: a
 * wedged pass waited for every unrelated lease to lapse, exactly the silent
 * blocking round 16 removes.
 */
const DEFAULT_STALL_PASS_LIVE_GRACE_TICKS = 1
/**
 * R16-D: the declared bound on how long a live attempt may record no durable
 * progress before the runtime escalates it by name (`attempt-silent:`). The
 * default matches the longest wait this host itself treats as bounded (F1's
 * operation bound, the harness's 600 s `maxWaitTimeoutMs`): an attempt that
 * has recorded nothing at all for that long is past the point where a live lease
 * can still be read as progress.
 */
const DEFAULT_ATTEMPT_SILENCE_BOUND_MS = 10 * 60_000
/**
 * F1: the declared bound on how long one in-flight operation may hold an
 * attempt without recording anything. Inside the bound an operation is
 * plausibly bounded (a long build, a declared check, one generation) and the
 * lease-renewal rule is right; past it "bounded" stops being plausible, so the
 * operation stops counting as liveness and the owner is told exactly which
 * member, task and tool went silent. The default matches the longest wait this
 * host itself treats as bounded (the harness's `maxWaitTimeoutMs` of 600 s),
 * while an operation that declares a longer bound of its own is judged by that
 * bound instead.
 */
const DEFAULT_OPERATION_BOUND_MS = 10 * 60_000

/**
 * The declared bounds of one configuration, each a window on the runtime clock.
 * Configuration, never a constant the runtime is trapped behind: an invalid
 * value keeps the default.
 */
export interface Bounds {
  /** The tick unit every tick-derived window is measured in. */
  tickMs: number
  /** S1: how long one scheduling pass may hold its mission before it is wedged. */
  stallPassTimeoutMs: number
  /** R16-D: how much longer live work keeps a wedged pass unnamed. */
  stallPassLiveGraceMs: number
  /**
   * R16-D: the total bound a wedged pass is measured against once it has live
   * work to progress. Past it the pass is named even though the live work
   * remains: the work is preserved and named, generation is not held hostage.
   */
  stallPassReleaseBoundMs: number
  /** R16-D: how long a live attempt may record nothing durable; `0` disables the guard. */
  attemptSilenceBoundMs: number
  /** F1: how long one in-flight operation may record nothing; `0` disables the guard. */
  operationBoundMs: number
}

/** The bounds `config` declares. A caller reads them where it decides, so a config changed after construction is the one judged. */
export function bounds(config: RuntimeConfig): Bounds {
  const pass = Math.trunc(config.stallPassTimeoutMs ?? config.tickMs * DEFAULT_STALL_PASS_TIMEOUT_TICKS)
  const stallPassTimeoutMs = Number.isSafeInteger(pass) && pass >= config.tickMs ? pass : config.tickMs
  const grace = config.stallPassLiveGraceMs
  const stallPassLiveGraceMs = typeof grace === 'number' && Number.isFinite(grace) && grace >= 0 ? Math.floor(grace) : stallPassTimeoutMs * DEFAULT_STALL_PASS_LIVE_GRACE_TICKS
  return {
    tickMs: config.tickMs, stallPassTimeoutMs, stallPassLiveGraceMs, stallPassReleaseBoundMs: stallPassTimeoutMs + stallPassLiveGraceMs,
    attemptSilenceBoundMs: declaredBound(config.attemptSilenceBoundMs, DEFAULT_ATTEMPT_SILENCE_BOUND_MS),
    operationBoundMs: declaredBound(config.operationBoundMs, DEFAULT_OPERATION_BOUND_MS),
  }
}

/** A guard's declared bound: `0` disables the guard, an invalid value keeps the default rather than reverting to 0. */
function declaredBound(value: number | undefined, fallback: number): number {
  if (value === 0) return 0
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * The adapter's answers a decision asks. Each call goes straight through to the
 * adapter at the instant the decision asks it, never memoized: a handle's answer
 * changes as its turns start and end. Asking changes nothing (`WorkerAdapter.isIdle`).
 */
export interface AdapterView {
  /** Whether the member's worker handle can take an assignment now (`WorkerAdapter.isIdle`). */
  startable(memberId: string): boolean
  /** What the member's worker handle is doing now (`WorkerAdapter.currentActivity`). */
  activity(memberId: string): WorkerActivity | undefined
}

/**
 * The durable log a board reads where a decision reads it: task events (and
 * the mission's progress clock over them), tool runs, the deliveries ledger,
 * evidence and the start request that launched the mission, if one did. It
 * lists those three tables only: the board's own rows (its mission, tasks and
 * members) are its fields, so no predicate can read one again through the log.
 */
export interface BoardRecords extends Pick<SwarmStore, 'latestTaskEvent' | 'progressAt' | 'toolRuns'> {
  list(table: 'deliveries', missionId: string): Delivery[]
  list(table: 'evidence', missionId: string): Evidence[]
  list(table: 'starts', missionId: string): AutoStart[]
}

/** One mission's rows at one instant, with the clock, the bounds, the adapter view and the log every decision over them reads. */
export interface Board {
  missionId: string
  /** The mission row with its execution clock applied (`readMission`). */
  mission: Mission
  tasks: Task[]
  members: Member[]
  /** The task graph over `tasks`. */
  graph: TaskGraphIndex
  clock: () => number
  bounds: Bounds
  view: AdapterView
  records: BoardRecords
}

/** A mission row as every reader sees it: its execution clock applied while it is not terminal. An unknown id is refused. */
export function readMission(store: Pick<SwarmStore, 'get'>, missionId: string, clock: () => number): Mission {
  const mission = store.get('missions', missionId)
  if (!mission) throw new PolicyError('mission_unknown', 'validation_error', 'Unknown mission')
  if (mission.executionTime !== undefined && !terminal(mission)) executionClock(mission, mission.executionTime.since !== undefined, clock())
  return mission
}

/** The board of one mission as the store holds it now. */
export function readBoard(store: Pick<SwarmStore, 'get' | 'list' | 'latestTaskEvent' | 'progressAt' | 'toolRuns'>, missionId: string, clock: () => number, bounds: Bounds, view: AdapterView): Board {
  const mission = readMission(store, missionId, clock)
  const tasks = store.list('tasks', missionId)
  return { missionId, mission, tasks, members: store.list('members', missionId), graph: taskGraphIndex(tasks), clock, bounds, view, records: store }
}

/* ----------------------------------------------------------------------- *
 * The scheduling predicates: readiness, capability, the dispatchable work,
 * the unschedulable work and the stall.
 * ----------------------------------------------------------------------- */

/**
 * R15-A4/A5: the dispatcher's startability question for one member, shared by
 * the sweep and by the explanation the dispatch question gives the owner, so
 * both answer with the same predicate.
 *
 * Guards it can co-fire with:
 * - the parked-member hatch (`asksHandle`, R10-09/S3): a parked member is
 *   startable even when the adapter reports its handle busy, so the hatch wins
 *   here exactly as it does in `Scheduling.dispatch`;
 * - the adapter's `isIdle` precondition (`HarnessWorkers.isIdle`), which answers
 *   an idle handle holding stranded input startable instead of stranding the
 *   member; the dispatch sweep has the adapter wake that input before it asks
 *   (`WorkerAdapter.drainStrandedInbox`, R15-A5);
 * - the W6 open-attempt close-out, which owns a member that already has a
 *   running attempt: `dispatch` handles that member before it dispatches, and
 *   the dispatch question refuses to answer for a task with an open attempt.
 */
export function startBlocker(view: AdapterView, member: Member): 'handle-busy' | undefined {
  if (!asksHandle(member)) return undefined
  return view.startable(member.id) ? undefined : 'handle-busy'
}

/**
 * R10-09/S3, the parked-member hatch: whether a decision asks the adapter about
 * this member's handle. It never asks about a parked member's: an assignment is
 * exactly the fresh input that unparks it, so its handle's answer cannot leave
 * the board silent. A row alone.
 */
export function asksHandle(member: Member): boolean { return memberPhaseOf(member) !== 'parked' }

/** Whether a decision can hand this member work: it is not stopped and owes no stop. Rows alone. */
export function takesWork(tasks: readonly Task[], member: Member): boolean { return memberPhaseOf(member) !== 'stopped' && !pendingStopOwner(tasks, member.id) }

/**
 * The tokens `members` are spending in model requests that have reported no
 * usage yet, each estimated at its worker's average request, rounded up: the
 * budget gate's and the owner's in-flight token projection, read where they
 * read it. A request counts only while its worker reports it.
 */
export function inFlightEstimate(view: AdapterView, members: readonly Member[]): number {
  let total = 0
  for (const member of members) {
    if (memberPhaseOf(member) === 'stopped') continue
    if (view.activity(member.id)?.kind !== 'model') continue
    const requests = member.usage?.requests ?? 0
    if (requests > 0) total += Math.ceil((member.accountedTokens ?? 0) / requests)
  }
  return total
}

/**
 * The members the budget gate's step projection counts with a model request in
 * flight, one step each: a live member whose worker reports a model operation
 * or, when its worker reports none, whose durable activity records one (R06).
 */
export function stepsInFlight(view: AdapterView, members: readonly Member[]): Member[] {
  return members.filter(member => memberPhaseOf(member) !== 'stopped' && (view.activity(member.id) ?? member.activity)?.kind === 'model')
}

export function ready(board: Board, task: Task, member: Member): boolean {
  return readinessBlocker(board, task, member) === undefined
}

/** The dispatcher's eligibility, which every reader of a dispatchable task asks: a member that takes work (`takesWork`), for which the task is ready. */
export function eligible(board: Board, task: Task, member: Member): boolean { return takesWork(board.tasks, member) && ready(board, task, member) }

/**
 * The fresh-row rule a choice made before an await asks after it, because
 * other mutators commit outside the mission queue during the await: the row
 * chosen, as this board holds it, while its epoch and its assignment are
 * unchanged; otherwise undefined, and the choice no longer stands. Readiness
 * is each caller's own: the dispatch sweep asks `eligible`, the predicate that
 * chose (`stillDispatchable`), and a claim asks `ready`, leaving a stop owed to
 * the admission.
 */
export function stillChosen(board: Board, chosen: Task): Task | undefined {
  const fresh = board.tasks.find(task => task.id === chosen.id)
  return fresh !== undefined && fresh.epoch === chosen.epoch && fresh.assigneeId === chosen.assigneeId
    && fresh.plannedAssigneeId === chosen.plannedAssigneeId && fresh.assignmentMode === chosen.assignmentMode ? fresh : undefined
}

/**
 * The dispatch sweep's choice after its preparation await: the chosen row
 * (`stillChosen`) while the member is still `eligible` for it; otherwise
 * undefined, and the work waits for a later sweep. The sweep asks it before
 * the assignment and before it records a preparation failure, so a stop the
 * member came to owe during the await drops the choice on either outcome.
 */
export function stillDispatchable(board: Board, chosen: Task, member: Member): Task | undefined {
  const fresh = stillChosen(board, chosen)
  return fresh !== undefined && eligible(board, fresh, member) ? fresh : undefined
}

/** Spec §2: the dispatchable work, each pending task an idle or waiting member is eligible for; a working member is already busy. */
export function dispatchable(board: Board): Task[] {
  const runnable = board.members.filter(member => member.status === 'idle' || member.status === 'waiting')
  return board.tasks.filter(task => task.status === 'pending' && runnable.some(member => eligible(board, task, member)))
}

/** The same readiness decision supplies a concrete refusal without another policy model. */
export function readinessBlocker(board: Board, task: Task, member: Member): string | undefined {
  if (task.status !== 'pending') return `task ${task.id} is ${task.status}; inspect its current attempt, artifact or recovery condition with swarm_observe(taskId)`
  if ((task.preparationFailure?.retryAt ?? 0) > board.clock()) return `preparation is backing off until ${task.preparationFailure!.retryAt}: ${task.preparationFailure!.reason}`
  if (task.assigneeId === member.id) return capabilityBlocker(board, task, member)
  if (task.assigneeId !== undefined && !canBorrowTask(task)) return `task is bound to member ${task.assigneeId}; the owner can amend assigneeId when reassignment is appropriate`
  const all = board.tasks
  if (!assignmentAllows(task, member.id, all)) return `member ${member.id} is the assignee of review ${strandedReview(all, task.id, { assigneeId: member.id })?.id} of this task, so owning this task would make it that review's author; another member can take it, or the owner can amend that review's assigneeId with swarm_control`
  const incapable = capabilityBlocker(board, task, member)
  if (incapable !== undefined || task.assigneeId === undefined) return incapable
  // Keep useful context on the preferred member when it can take this work
  // now. A busy, stopping, retired or non-independent preference cannot reserve
  // an untouched task while another member is idle. This adds no reservation.
  const preferred = board.members.find(candidate => candidate.id === task.assigneeId)
  const availableForBorrowing = preferred === undefined || !eligible(board, task, preferred)
    || openAttempt(all, preferred.id) !== undefined
    || startBlocker(board.view, preferred) !== undefined
  return availableForBorrowing ? undefined : `preferred member ${task.assigneeId} is available for this task; the owner can amend assigneeId to change the preference`
}

/**
 * R5-02: whether a member could take this task if it were pending and
 * unassigned. Same prerequisites and review-independence guard as `ready`,
 * without the status/assignee pin, so a start-failure re-route can evaluate
 * candidates before committing the re-pend. The author check matches
 * admission's definition (`attempt?.ownerId ?? assigneeId`), so a re-route can
 * never assign a verification to the author of the source it reviews.
 */
export function capable(board: Board, task: Task, member: Member): boolean {
  return capabilityBlocker(board, task, member) === undefined
}

function capabilityBlocker(board: Board, task: Task, member: Member): string | undefined {
  // An edge that names no task can never be met, so it is named before any
  // unmet edge that still can be.
  const dangling = board.graph.danglingReference(task)
  if (dangling !== undefined) return task.dependencies.includes(dangling)
    ? `dependency ${dangling} names no task in this mission, so the task can never be ready; the owner can amend its dependencies with swarm_control(action: "amend", taskId, changes, reason) or withdraw it with swarm_cancel(taskId, reason)`
    : `review source ${dangling} names no task in this mission, so the review can never begin; the owner can withdraw it with swarm_cancel(taskId, reason)`
  for (const dependency of task.dependencies) {
    const effective = board.graph.effective(dependency)
    if (effective !== undefined && effective.status !== 'accepted') return `dependency ${dependency}${effective.id === dependency ? '' : ` (effective replacement ${effective.id})`} is ${effective.status}, not accepted; inspect it or amend the dependency plan`
  }
  const source = board.graph.reviewSource(task)
  if (source === undefined) return undefined
  if (source.status !== 'submitted') return `review source ${source.id} is ${source.status}; review begins only after its artifact is submitted`
  if (!canOwnReview(source, member.id)) return `member ${member.id} authored review source ${source.id}; assign an independent reviewer`
  return undefined
}

/**
 * Tasks that cannot be dispatched under the current plan: pending work whose dependency
 * lineage or review source is dead or names no task, reviews assigned to their own author,
 * pending work no live member may take (`assignmentAllows`: a source only its
 * own bound reviewer is left to take included), and blocked work. This is a
 * diagnostic for owner repair, not permission to
 * cancel obligations or mark the mission complete.
 */
export function unschedulable(board: Board): Task[] {
  const tasks = board.tasks
  const live = board.members.filter(member => memberPhaseOf(member) !== 'stopped')
  // W15: a blocked task with a matching stop marker is alive, not dead. Handoff,
  // worker close-out and lease expiry hold the task at `blocked` +
  // `resumeAfterStop` only until `workers.stop()` resolves; treating it as
  // unschedulable lets `control complete` cancel recoverable work.
  const dead = new Set(tasks.filter(task => task.status === 'blocked' && !quiescencePending(task)).map(task => task.id))
  // Fixpoint: work holding an id that names no task (`danglingReference`) is
  // dead, and so is work waiting on dead prerequisites or an unreachable review source.
  for (let changed = true; changed;) {
    changed = false
    for (const task of tasks) {
      if (dead.has(task.id) || task.status !== 'pending') continue
      const source = board.graph.reviewSource(task)
      const stuck = board.graph.danglingReference(task) !== undefined
        || board.graph.effectiveDependencies(task).some(effective => effective.status === 'cancelled' || dead.has(effective.id))
        || (source !== undefined && (TERMINAL_STATES.has(source.status) || dead.has(source.id)
          || !live.some(member => assignmentAllows(task, member.id, tasks) && canOwnReview(source, member.id))))
        || !live.some(member => assignmentAllows(task, member.id, tasks))
      if (stuck) { dead.add(task.id); changed = true }
    }
  }
  return tasks.filter(task => dead.has(task.id))
}

/**
 * The one live-review rule: the review of `source` that can still reach a
 * verdict. Its status is pending or running, or it is parked behind a stop at
 * its own epoch (`quiescencePending`), so it re-pends once the stop settles;
 * and at least one live member may own it: independently (`canOwnReview`) and
 * by assignment (`assignmentAllows`). A review nobody live may own is no path.
 * The dispatcher's stall, the owner notices, the arena digest and the
 * runtime's own review admission all answer from this, through `reviewable`.
 */
export function liveReviewFor(reviews: readonly Task[], source: Task, liveMemberIds: ReadonlySet<string>): Task | undefined {
  return reviews.find(review => review.kind === 'verification' && review.reviewOf === source.id
    && (review.status === 'pending' || review.status === 'running' || quiescencePending(review))
    && [...liveMemberIds].some(memberId => canOwnReview(source, memberId) && assignmentAllows(review, memberId, reviews)))
}

/**
 * A submitted task is progress only while a live review can still accept it,
 * under the one live-review rule (`liveReviewFor`). A review that was never
 * admitted or was retired leaves the submission unreviewable forever;
 * counting it as progress hid a stalled board from the owner (Round-8 F1).
 * So does a review no live member may own: counting it silenced the owner's
 * review-blocked decision. A parked review (blocked with a matching stop
 * marker) re-pends after the stop acknowledgement, so it still counts.
 */
export function reviewable(board: Board, task: Task): boolean {
  return liveReviewFor(board.tasks, task, new Set(board.members.filter(member => memberPhaseOf(member) !== 'stopped').map(member => member.id))) !== undefined
}

/**
 * F2: the board makes no progress except for submitted work. Unlike `stalled`,
 * a submitted task is not progress: an artifact whose review path is broken
 * can never reach a verdict by itself.
 */
export function reviewPathStalled(board: Board): boolean {
  if (board.tasks.some(task => task.status === 'running' || quiescencePending(task))) return false
  const live = board.members.filter(member => memberPhaseOf(member) !== 'stopped')
  return !board.tasks.some(task => task.status === 'pending' && live.some(member => ready(board, task, member)))
}

/**
 * Nothing is running, reviewably submitted or dispatchable, and no unreviewable
 * submission (`unreviewable`) awaits the review admission
 * (`awaitsReviewAdmission`, the admission's own rule): workers would stay idle
 * forever. An empty board is a mission the owner has not planned yet.
 */
export function stalled(board: Board): boolean {
  return board.tasks.length > 0 && reviewPathStalled(board) && !unreviewable(board).some(task => awaitsReviewAdmission(board, task))
}

/**
 * R16-D: the board's live work, which may be progress while nothing is
 * recorded: a task in its durable stop transition (`quiescencePending`), or one
 * holding an open attempt whose lease has not lapsed at the board's clock. A
 * scheduling body past its bound stays live while the board has some, inside
 * its release bound, and its naming names these as the work that held it
 * (`wedgeVerdict`, src/scheduling.ts). A lapsed lease is not live work, so a
 * body wedged until every lease lapsed is named at its first bound. This is not
 * the stall's running-or-stopping work (`reviewPathStalled`), which counts a
 * running row whatever its lease: the lease path owns a lapsed one.
 */
export function liveWork(board: Pick<Board, 'tasks' | 'clock'>): Task[] {
  const now = board.clock()
  return board.tasks.filter(task => quiescencePending(task) || (holdsOpenAttempt(task) && task.attempt.leaseUntil >= now))
}

/**
 * R5-02: the live members a failed attempt may be re-routed to, in store
 * order: capable of the task, and never the member one of its own reviews is
 * bound to (`strandedReview`), whom a reroute would make that review's author.
 */
function rerouteCandidates(board: Board, task: Task, failedId: string): Member[] {
  return board.members.filter(member => member.id !== failedId && memberPhaseOf(member) !== 'stopped'
    && capable(board, task, member) && strandedReview(board.tasks, task.id, { assigneeId: member.id }) === undefined)
}

/**
 * R5-02: the deterministic next live member for re-routed work: the planned
 * assignee when it is a candidate, else the first candidate by name. R11-01: a
 * route inside its provider outage window waits for its next probe, so it is the
 * last resort: the first candidate outside an outage window, in store order,
 * takes the work before it.
 */
export function rerouteTarget(board: Board, task: Task, failedId: string): Member | undefined {
  const candidates = rerouteCandidates(board, task, failedId)
  const planned = task.plannedAssigneeId === undefined ? undefined : candidates.find(member => member.id === task.plannedAssigneeId)
  const target = planned ?? [...candidates].sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  if (target === undefined || providerQuiescent(target, board.clock()) === undefined) return target
  return candidates.find(member => providerQuiescent(member, board.clock()) === undefined) ?? target
}

/** One breach of the isolation invariant: the members it lists and the text that names it. */
export interface IsolationIssue { memberIds: string[]; message: string }

/**
 * S7: the isolation invariant over one board's members and tasks, decided
 * from durable state only, each breach with the members it lists:
 *  - live workers ≤ provisioned isolated worktrees: every non-stopped member
 *    owns a provisioned workspace and no two live members share one, so the
 *    number of worker handles the runtime may hold can never exceed the number
 *    of distinct isolated worktrees;
 *  - two concurrently running tasks that share one isolated worktree must
 *    declare disjoint scope: the dispatch path admits at most one running task
 *    per worktree and refuses a second whose scope overlaps.
 * It asserts the isolation the runtime already has; it never weakens
 * per-member worktrees, it refuses a dispatch that would lose them. Dispatch
 * refuses a listed member (`isolationViolation`) and records the refusal
 * (`WorkspaceAdmission.recordIsolation`), and the workspace terminal a breach
 * raised is outstanding while the invariant still lists it
 * (`Notices.openGuardTerminal`).
 */
export function isolationIssues(board: Pick<Board, 'members' | 'tasks'>): IsolationIssue[] {
  const violations: IsolationIssue[] = []
  const live = board.members.filter(member => member.status !== 'stopped')
  const byWorkspace = new Map<string, Member[]>()
  for (const member of live) {
    if (!member.workspace) { violations.push({ memberIds: [member.id], message: `member ${member.id} (${member.name}) has no provisioned isolated worktree` }); continue }
    byWorkspace.set(member.workspace, [...(byWorkspace.get(member.workspace) ?? []), member])
  }
  for (const [workspace, group] of byWorkspace) {
    if (group.length > 1) violations.push({ memberIds: group.map(member => member.id), message: `live workers ${group.map(member => member.id).join(', ')} share one provisioned worktree (${workspace}); live workers must never exceed provisioned worktrees` })
  }
  const byTaskWorkspace = new Map<string, HeldTask[]>()
  for (const task of board.tasks.filter(holdsOpenAttempt)) {
    const owner = board.members.find(member => member.id === task.attempt.ownerId)
    if (owner === undefined || owner.status === 'stopped') { violations.push({ memberIds: [task.attempt.ownerId], message: `running task ${task.id} has no live owner (${task.attempt.ownerId})` }); continue }
    byTaskWorkspace.set(owner.workspace, [...(byTaskWorkspace.get(owner.workspace) ?? []), task])
  }
  for (const [workspace, group] of byTaskWorkspace) {
    if (group.length > 1) violations.push({ memberIds: group.map(task => task.attempt.ownerId), message: `concurrently running tasks ${group.map(task => task.id).join(', ')} share worktree ${workspace}` })
    for (let left = 0; left < group.length; left++) {
      for (let right = left + 1; right < group.length; right++) {
        if (group[left]!.scope.some(a => group[right]!.scope.some(b => scopeKeysOverlap(a, b)))) {
          violations.push({ memberIds: [group[left]!.attempt.ownerId, group[right]!.attempt.ownerId], message: `concurrently running tasks ${group[left]!.id} and ${group[right]!.id} declare overlapping scope in worktree ${workspace}` })
        }
      }
    }
  }
  return violations
}

/** The dispatch's isolation decision for one member: the first breach on the board that lists it, or undefined when the invariant admits its dispatch. */
export function isolationViolation(board: Pick<Board, 'members' | 'tasks'>, member: Pick<Member, 'id'>): IsolationIssue | undefined {
  return isolationIssues(board).find(issue => issue.memberIds.includes(member.id))
}

/* ----------------------------------------------------------------------- *
 * F2: the review admission's rule. A submitted artifact no live review can
 * accept gets a bounded independent review admitted by the host, or its
 * blocker named to the owner, once per review need.
 * ----------------------------------------------------------------------- */

/** Only the review admission (`SwarmRuntime.admitAutomaticReview`) mints a task id with this prefix, followed by the review need's id. */
export const AUTOMATIC_REVIEW_PREFIX = 'task_auto_review_'
/** The exits a review-path blocker may name beside its own cause's (admit the review, naming the recovery limit a launched mission's admission requires and every mission accepts; or withdraw the source), the blocker while the host's own review waits for the board, and the statement a refused host review is recorded with, before its refusal. */
export const ADMIT_REVIEW = 'admit a review with swarm_propose(kind: "verification", reviewOf, outputs: [], maxRecoveryAttempts)'
export const WITHDRAW_SOURCE = 'withdraw the source with swarm_cancel(taskId, reason)'
export const BOARD_RUNNING = `it has no live independent review path and cannot reach a verdict while the rest of the board keeps running: ${ADMIT_REVIEW}, or ${WITHDRAW_SOURCE}`
export const ADMISSION_REFUSED = `automatic review admission failed: ${ADMIT_REVIEW} correcting what its refusal names, or ${WITHDRAW_SOURCE}. The refusal: `
/** The source's newest recorded review blocker (its `task/review-blocked` row): the reason last recorded, with the row's sequence. */
export const newestReviewBlock = (store: Pick<SwarmStore, 'latestTaskEvent'>, missionId: string, sourceId: string): { seq: number; reason: string | undefined } | undefined => {
  const row = store.latestTaskEvent(missionId, sourceId, 'task/review-blocked')
  return row && { seq: row.seq, reason: (row.data as { reason?: string }).reason }
}

/**
 * F2: one review need of a submitted source (`reviewNeed`). `ripe` is the one
 * review grace: the need is older than one scheduler period, at least 1 s (the
 * author may propose its own review in the turn it submitted; the floor keeps a
 * fast tick from turning a same-turn proposal into a race), or has no dated row
 * to show it is not, which the board's classifiers read
 * (`awaitsReviewAdmission`). `recorded` is the admission's own record: a
 * `task/review-missing` row newer than the row that opened the need.
 */
export interface ReviewNeed { id: string; seq: number; ripe: boolean; recorded: boolean }

/**
 * F2: the review need of one submitted source, the one identity every
 * missing-review fact is keyed on. The need is the submission (the epoch
 * fences every resubmission, even of an unchanged commit) and each review of
 * it a challenge took away (the one that accepted it or one in progress: its
 * `task/invalidated` row), which re-opens it. `id` keys its automatic review
 * and its blocker decisions; `seq` is that of the newest row that opened
 * it, from which its grace (`ripe`, the one grace every reader asks), its
 * missing-review record (`recorded`) and an owner withdrawal are dated. S5:
 * derived from the log, so a restart or a lost cache re-derives the same need.
 */
export function reviewNeed(board: Board, source: Task): ReviewNeed {
  const records = board.records
  const submitted = records.latestTaskEvent(source.missionId, source.id, 'task/submitted')
  const reopened = board.tasks.filter(review => review.reviewOf === source.id)
    .flatMap(review => records.latestTaskEvent(source.missionId, review.id, 'task/invalidated') ?? []).filter(row => row.seq > (submitted?.seq ?? 0)).sort((a, b) => a.seq - b.seq)
  const opened = reopened.at(-1) ?? submitted
  const seq = opened?.seq ?? 0
  return { id: createHash('sha256').update([source.missionId, source.id, source.epoch, source.artifact?.commit ?? '', ...reopened.map(row => row.seq)].join(':')).digest('hex').slice(0, 32),
    seq, ripe: opened === undefined || board.clock() - opened.createdAt >= Math.max(board.bounds.tickMs, 1000),
    recorded: (records.latestTaskEvent(source.missionId, source.id, 'task/review-missing')?.seq ?? 0) > seq }
}

/**
 * Why the host cannot give this unreviewable source a live review under this
 * need, each cause with the exit that removes it, or undefined when it
 * admits one now. A review the owner admits needs a task slot and an
 * independent member, so the host's own review that cannot reach a verdict
 * is named after those: the one it admitted for this need (it admits one), or
 * one the owner withdrew, an automatic review (host-minted id) with a durable
 * `task/cancelled` row newer than the row that opened the need (a verdict, rework or challenge retires a review without cancelling it),
 * or the one admission refused for this need: the source's newest recorded blocker is newer than that row and states the refusal (`ADMISSION_REFUSED`).
 * The host's own admission reviews on a board with nothing else to do (`stalled`, as the admission pass judged it).
 */
export function reviewPathBlocker(board: Board, source: Task, need: ReviewNeed, stalled?: boolean): string | undefined {
  const { mission, tasks, members, records } = board
  const deferred = tasks.find(task => task.status === 'blocked' && task.reviewOf === source.id && task.verificationRecovery !== undefined && task.verificationRecovery.commit === source.artifact?.commit)
  if (deferred !== undefined) return `review ${deferred.id} deferred its verdict on this artifact: ${recoveryExit(records.toolRuns(mission.id, { taskId: deferred.id }).filter(run => run.tool === 'swarm.host_verification').map(run => run.result as CheckResult))}`
  if (tasks.length >= mission.budget.maxTasks) return `the mission task budget is exhausted (${tasks.length}/${mission.budget.maxTasks} admitted tasks), so no verification task can be admitted: raise maxTasks with swarm_budget(budget, reason), or ${WITHDRAW_SOURCE}`
  const authors = [...authorIdsOf(source)]
  if (!members.some(member => memberPhaseOf(member) !== 'stopped' && canOwnReview(source, member.id))) return `no live member other than the author (${authors.join(', ') || 'unknown'}) can review this artifact independently: add an independent member with swarm_add_member(role, maxOutputTokens), or ${WITHDRAW_SOURCE}`
  const automatic = tasks.find(review => review.id === `${AUTOMATIC_REVIEW_PREFIX}${need.id}` || (review.reviewOf === source.id && review.status === 'cancelled'
    && review.id.startsWith(AUTOMATIC_REVIEW_PREFIX) && (records.latestTaskEvent(mission.id, review.id, 'task/cancelled')?.seq ?? 0) > need.seq))
  if (automatic !== undefined) return `the automatically admitted review ${automatic.id} ${automatic.status === 'cancelled' ? 'was withdrawn' : `is ${automatic.status} and cannot reach a verdict`}: ${ADMIT_REVIEW}, or ${WITHDRAW_SOURCE}`
  const recorded = newestReviewBlock(records, mission.id, source.id)
  if (recorded !== undefined && recorded.seq > need.seq && recorded.reason?.startsWith(ADMISSION_REFUSED)) return recorded.reason
  return (stalled ?? reviewPathStalled(board)) ? undefined : BOARD_RUNNING
}

/** The submissions the review admission speaks for: submitted artifacts. A submission an older build left without an artifact is ordinary stuck work. */
const admissionSpeaksFor = (task: Task): boolean => task.status === 'submitted' && task.artifact !== undefined
/** The submissions no live review can accept (`reviewable`): F(S)'s unreviewed work (`fingerprintBoard`), the stall's waits on the review admission (`stalled`), and, those with an artifact, the admission's sources. */
const unreviewable = (board: Board): Task[] => board.tasks.filter(task => task.status === 'submitted' && !reviewable(board, task))
/** The review admission's sources, the one set its admission, its decisions and the interpretation read: the unreviewable submissions it speaks for (before the grace is applied). */
export const unreviewedSources = (board: Board): Task[] => unreviewable(board).filter(admissionSpeaksFor)
/** Whether the host can still advance an unreviewable submission, the review admission's own rule, which the stall predicate and the waiting classifier read: inside its review grace (`ReviewNeed.ripe`), or, for a source the admission speaks for, while the admission names no blocker under the board's own stall (`reviewPathBlocker`): the next pass on a stalled board admits its review. */
export const awaitsReviewAdmission = (board: Board, task: Task): boolean => { const need = reviewNeed(board, task); return !need.ripe || (admissionSpeaksFor(task) && reviewPathBlocker(board, task, need) === undefined) }

/* ----------------------------------------------------------------------- *
 * What a notice names and whether the mission may complete.
 * ----------------------------------------------------------------------- */

/**
 * R15-A1: the subjects of a notice that is scoped to a task, a member or the
 * mission itself. A task-scoped notice names that task at its epoch; a
 * member-scoped notice names the member's unfinished work; the mission root is
 * the fallback only when neither exists, so a notice is never anonymous.
 * Guard pair: member-scoped notice x task-scoped notice — a member's notice
 * never borrows another task's subject, which is what keeps one subject's clock
 * independent of a healthy sibling (R15-A4).
 */
export function noticeSubjectsFor(board: Pick<Board, 'missionId' | 'tasks'>, scope: { taskId?: string; memberId?: string } = {}): string[] {
  const tasks = board.tasks
  if (scope.taskId !== undefined) {
    const task = tasks.find(candidate => candidate.id === scope.taskId)
    if (task !== undefined) return [taskSubject(task)]
  }
  if (scope.memberId !== undefined) {
    const owned = tasks.filter(task => (task.attempt?.ownerId === scope.memberId || task.assigneeId === scope.memberId) && !TERMINAL_STATES.has(task.status))
    if (owned.length) return subjectsOfTasks(owned, { id: board.missionId })
  }
  return [missionSubject({ id: board.missionId })]
}

/** Why the mission may not complete yet, or undefined when every obligation is accepted, covered and undisputed. */
export function completionError(board: Board): string | undefined {
  const { mission, tasks, graph } = board
  if (!tasks.length) return 'Mission still has unfinished or blocked required work'
  const unfinished = tasks.filter(task => !TERMINAL_STATES.has(task.status) && !completionExempt(task, tasks))
  if (unfinished.length) return `Mission still has unfinished or blocked required work: ${unfinished.map(task => `${task.id} (${task.status})`).join(', ')}`
  // Only accepted deliverable work covers a mission criterion, by the ids its
  // replacement lineage cites; code deliverables need an artifact.
  const deliverables = tasks.filter(task => task.status === 'accepted' && task.kind !== 'verification' && (task.kind === 'research' || task.artifact !== undefined))
  const uncovered = uncoveredCriteria(mission.acceptance, new Set(deliverables.flatMap(task => [...graph.criteriaOf(task.id)])))
  if (uncovered.length) return `Accepted tasks do not cover every mission acceptance criterion: ${uncovered.join(', ')}. Propose a deliverable that names them in \`covers\` with \`swarm_propose\`; an accepted task cannot gain covers`
  if (tasks.some(task => ['implementation', 'integration'].includes(task.kind) && task.status !== 'cancelled')) {
    try { selectAcceptedDelivery(tasks) }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  // Evidence of explicitly cancelled work no longer supports an accepted result,
  // and a claim a rework archived is history of a rejected commit that no
  // verdict judges again; live disputes still block.
  const dead = new Set(tasks.filter(task => task.status === 'cancelled').map(task => task.id))
  const archived = new Set(tasks.flatMap(task => task.rejections?.flatMap(rejection => rejection.evidenceIds) ?? []))
  const disputed = board.records.list('evidence', mission.id).filter(evidence => evidence.status === 'challenged' && !dead.has(evidence.taskId) && !archived.has(evidence.id))
  if (disputed.length) return `Unresolved evidence challenges prevent completion: ${disputed.map(evidence => evidence.id).join(', ')}`
  return undefined
}

/* ----------------------------------------------------------------------- *
 * The stall classifiers: which blocked work is a root the owner repairs, what
 * depends on it, and which unfinished work waits on something still alive.
 * ----------------------------------------------------------------------- */

/**
 * R16-A: the ids whose obligation is carried by a live task through `replaces`,
 * transitively. Shared by `stallRoots` (a covered task is not a root) and
 * `waitsLegitimately` (a covered task is waiting on its repair), so the two
 * classifiers cannot disagree about a task that is inside a live lineage.
 * Co-fires with: the lineage-resolved dependency rule (both read the same durable
 * `replaces` edges the dispatcher's `effectiveDependency` walks) and the
 * fall-through, which may name a subject only when this set does not contain it.
 * The walk is the board graph's `replacedLineage`.
 */
function replacementCoverage(board: Pick<Board, 'tasks' | 'graph'>): Set<string> {
  const replaced = new Set<string>()
  for (const task of board.tasks) if (!TERMINAL_STATES.has(task.status)) for (const origin of board.graph.replacedLineage(task.id).slice(1)) replaced.add(origin.id)
  return replaced
}

/**
 * R14-F2v D2 / R15-A3: a pending stop is inside its declared bound. Its marker
 * records when the stop began, and no more than `stallPassTimeoutMs` has passed
 * since. A marker with no recorded start (a pre-upgrade durable row) is
 * unbounded: the bound cannot be shown to hold, so it is never inside it.
 * Waiting on a stop inside its bound is progress; any other stop is a root.
 */
function stopInBound(board: Pick<Board, 'clock' | 'bounds'>, marker: Pick<NonNullable<Task['resumeAfterStop']>, 'at'>): boolean {
  return marker.at !== undefined && board.clock() - marker.at <= board.bounds.stallPassTimeoutMs
}

/**
 * The owner-facing fact of a blocked task whose pending stop is not inside its
 * declared bound (`stopInBound`): how long the stop has been awaited, or that
 * it carries no recorded start. Undefined for any other task, so no notice can
 * state a stop inside its bound as past it.
 */
export function overdueStop(board: Pick<Board, 'clock' | 'bounds'>, task: Task): string | undefined {
  if (!quiescencePending(task) || stopInBound(board, task.resumeAfterStop)) return undefined
  const bound = board.bounds.stallPassTimeoutMs, at = task.resumeAfterStop.at
  return at === undefined
    ? `its stop carries no recorded start, so the declared bound (${bound}ms) cannot be shown to hold`
    : `its stop has been awaited for ${Math.max(0, board.clock() - at)}ms, past the declared bound (${bound}ms)`
}

/**
 * R14-F2(b): the stall roots of one board, in board order. Purely a function of
 * durable rows, so the pass, the timer-driven notice path, the delivery-time
 * relevance check and a test all classify the same board identically.
 */
export function stallRoots(board: Pick<Board, 'tasks' | 'graph' | 'clock' | 'bounds'>): Task[] {
  // A live replacement marks every id in its transitive lineage as covered.
  const replaced = replacementCoverage(board)
  return board.tasks.filter(task => {
    if (task.status !== 'blocked' || replaced.has(task.id)) return false
    // A verdict record is not a repairable root: its source carries the repair.
    if (task.reviewOf !== undefined) return false
    return !stopPending(task) || !stopInBound(board, task.resumeAfterStop)
  })
}

/**
 * R14-F2(b): the tasks that depend on one root, transitively, still unfinished.
 *
 * R16-A: the edge set is the durable one the board really has — `dependencies`,
 * `replaces` AND `reviewOf`. A blocked source's notice now enumerates the
 * pending review that waits on it, so the review's subject is not left out of
 * the decision the source's repair owes. Co-fires with: the stall-root
 * classifier (whose roots this is asked of) and the review-grace rule in
 * `waitsLegitimately` (a review whose source is terminal is dead and named;
 * while the source is live this enumeration is how its notice names the review).
 */
export function dependentsOf(board: Pick<Board, 'tasks'>, root: Task): Task[] {
  const found = new Map<string, Task>()
  let grew = true
  while (grew) {
    grew = false
    for (const task of board.tasks) {
      if (task.id === root.id || TERMINAL_STATES.has(task.status) || found.has(task.id)) continue
      const dependsOnRoot = [root.id, ...found.keys()].some(id => task.dependencies.includes(id) || (task.replaces ?? []).includes(id) || task.reviewOf === id)
      if (dependsOnRoot) { found.set(task.id, task); grew = true }
    }
  }
  return [...found.values()]
}

/**
 * R14-F2(c) / R16-A: whether an unfinished task is waiting on something still
 * alive — a live lease, the bounded review grace, a stop inside its bound, a
 * live repair carrying its obligation, or an unfinished EFFECTIVE predecessor.
 * Anything else is unnamed silence and must escalate. One implementation for
 * the classifiers and the delivery-time relevance check (`ownerDeliveryRelevant`).
 *
 * R16-A: the predecessor edge is resolved through the dispatcher's own lineage
 * seam (`unfinishedDependencies`), never the raw id, so a task whose
 * cancelled dependency has a live running repair is waiting, not dead. And a
 * task whose own obligation is carried by a live replacement is waiting too,
 * read from the same coverage `stallRoots` uses, so the fall-through can name a
 * subject only when its whole lineage is terminal.
 *
 * Co-firing guards, named: this classifier x the stall-root classifier (a
 * blocked predecessor is the ROOT's subject, named by the root notice with its
 * dependents, never re-named here) x the review grace (`reviewable` and the
 * review-blocked emitter: a pending review follows its SOURCE identity, so a
 * cancelled source with a live repair still has no review path) x the
 * wedged-pass classification (D1/D2: the wedge changes who generates the
 * decision, never which boards are waiting).
 */
export function waitsLegitimately(board: Board, task: Task): boolean {
  const tasks = board.tasks
  if (TERMINAL_STATES.has(task.status)) return false
  // R16-A: a task whose obligation is carried by a live replacement has a live
  // path whatever its own row says — the repair advances it.
  const covered = replacementCoverage(board)
  if (covered.has(task.id)) return true
  // R17-G3: a running task with a live attempt row is NOT dead — the lease path
  // owns its expiry (fence, re-pend, re-route). Only a running row with no
  // attempt at all is unrecognised.
  if (task.status === 'running') return task.attempt !== undefined
  // Submission remains in this state for the entire independent review: the
  // dispatcher's live-review rule (an admitted or parked review included), or
  // a need the review admission would still serve (`awaitsReviewAdmission`).
  if (task.status === 'submitted') return reviewable(board, task) || awaitsReviewAdmission(board, task)
  if (task.status === 'blocked') {
    // A blocked verdict record is not outstanding on its own while its source
    // speaks for it: a live replacement carries the repair, or the source is a
    // stall root whose notice lists this record as a dependent. Naming the
    // record again (a W3 reminder, a fall-through) repeats the root's decision.
    if (task.reviewOf !== undefined && (covered.has(task.reviewOf)
      || stallRoots(board).some(root => root.id === task.reviewOf))) return true
    if (stopPending(task)) return stopInBound(board, task.resumeAfterStop)
    return board.graph.unfinishedDependencies(task).length > 0
  }
  if (task.status === 'pending') {
    // An id the task holds that names no task (`danglingReference`, the rule
    // `unschedulable` holds it dead by) is a prerequisite nothing can meet: the
    // task waits on nothing, whatever else it also waits on.
    if (board.graph.danglingReference(task) !== undefined) return false
    // Reviews wait on their exact source; no worker stop can repair a terminal
    // source, and a review path no live member may own (the one live-review
    // rule, `reviewable`) waits on nothing. Ordinary prerequisites keep the
    // shared lineage rule.
    const source = board.graph.reviewSource(task)
    if (source !== undefined) return !TERMINAL_STATES.has(source.status) && reviewable(board, source)
    if (board.graph.unfinishedDependencies(task).length > 0) return true
    if (!board.graph.dependenciesMet(task)) return false
    // A preparation failure the host will not retry is a block cause the owner
    // repairs (`blockCauses` owns that distinction). One carrying `retryAt` is the
    // host's own bounded back-off: a live wait until one tick past `retryAt`.
    // Past that bound the back-off explains nothing and the task is judged like
    // any other ready work below.
    const failure = task.preparationFailure
    if (failure !== undefined) {
      if (blockCauses(task, () => undefined, Number.POSITIVE_INFINITY).has('preparation-failed')) return false
      if (failure.retryAt !== undefined && board.clock() <= failure.retryAt + board.bounds.tickMs) return true
    }
    // The same marker that fences dispatch is a live wait only while every
    // matching stop is inside its bound. An unknown owner reserves all members.
    const memberId = task.assigneeId ?? task.plannedAssigneeId
    const stops = tasks.flatMap(candidate => stopPending(candidate)
      && (candidate.id === task.id || candidate.resumeAfterStop.memberId === undefined
        || (memberId !== undefined && candidate.resumeAfterStop.memberId === memberId)) ? [candidate.resumeAfterStop] : [])
    if (stops.length > 0) return stops.every(marker => stopInBound(board, marker))
    // Once the stop settles, another live attempt may take the selected member
    // first. Its bounded lease provides the next chance to run this ready work.
    const held = memberId === undefined ? undefined : openAttempt(tasks, memberId)
    return held !== undefined && held.attempt.leaseUntil >= board.clock()
  }
  return false
}

/* ----------------------------------------------------------------------- *
 * F(S): the stable digest of the owner-observable board
 * (docs/no-silent-state-spec.md §4), the owner instruments' fingerprint and an
 * audit field of the stall events. The kernel caches it per store revision
 * (`Kernel.fingerprint`).
 * ----------------------------------------------------------------------- */

/** The owner-observable board slice `missionFingerprint` digests (spec §4). */
export interface MissionFingerprintBoard {
  status: Mission['status']
  tasks: readonly MissionFingerprintTask[]
  members: ReadonlyArray<{ id: string; status: Member['status'] }>
  /** Undelivered worker outbox rows whose recipient can no longer receive them. */
  pendingDeliveries: number
  challengedEvidence: number
  /** Ceilings already hit: the budget pause id and each task's exhausted dimension. */
  ceilings: readonly string[]
}

/**
 * One task's owner-observable slice of the no-silent-state board. `ready` and
 * `unreviewed` are derived by the runtime (`dispatchable` and the live review
 * path); they are never supplied by a caller's claim.
 */
interface MissionFingerprintTask {
  id: string
  status: Task['status']
  /** The attempt owner only; a planned assignee is not an observed owner. */
  attemptOwner?: string
  /** A pending task at least one idle or waiting member can run right now. */
  ready: boolean
  /** A submitted task no live independent review can accept. */
  unreviewed: boolean
}

/**
 * Stable digest `F(S)` of the owner-observable board. No field is a wall-clock
 * time, so the digest moves only when a field does. It is an owner instrument
 * and an audit field, never a notice's identity. Pure so a test can recompute
 * it from the board.
 */
export function missionFingerprint(board: MissionFingerprintBoard): string {
  const order = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const tasks = [...board.tasks].sort(order).map(task => [task.id, task.status, task.attemptOwner ?? null, task.ready ? 1 : 0, task.unreviewed ? 1 : 0])
  const members = [...board.members].sort(order).map(member => [member.id, member.status])
  const canonical = JSON.stringify({
    status: board.status,
    tasks,
    ready: board.tasks.filter(task => task.ready).length,
    notReady: board.tasks.filter(task => task.status === 'pending' && !task.ready).length,
    unreviewed: board.tasks.filter(task => task.unreviewed).length,
    members,
    pendingDeliveries: board.pendingDeliveries,
    challengedEvidence: board.challengedEvidence,
    ceilings: [...board.ceilings].sort(),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/**
 * The slice F(S) digests of one board. Its readiness and review are the board's
 * own sets (`dispatchable`, `unreviewable`), the definitions the interpretation
 * and the scheduler read, so the digest cannot disagree with the board; it
 * builds no interpretation. Readiness asks the adapter's idleness and the clock
 * (a preparation back-off), not only durable rows.
 */
export function fingerprintBoard(board: Board): MissionFingerprintBoard {
  const { missionId, mission, tasks, members } = board
  const ready = new Set(dispatchable(board).map(task => task.id))
  const unreviewed = new Set(unreviewable(board).map(task => task.id))
  return {
    status: mission.status,
    tasks: tasks.map(task => ({ id: task.id, status: task.status,
      ...(task.attempt?.ownerId === undefined ? {} : { attemptOwner: task.attempt.ownerId }),
      ready: ready.has(task.id), unreviewed: unreviewed.has(task.id) })),
    members: members.map(member => ({ id: member.id, status: member.status })),
    // Owner-observable outbox backlog only: a delivery to a live member is the
    // wake channel and is flushed in the same scheduling pass, and an owner
    // notice is the ledger's record of a fact told about this board, not
    // board state, so telling one never moves the digest.
    pendingDeliveries: board.records.list('deliveries', missionId).filter(delivery => delivery.deliveredAt === undefined
      && delivery.to !== 'owner'
      && !members.some(member => member.id === delivery.to && member.status !== 'stopped')).length,
    challengedEvidence: board.records.list('evidence', missionId).filter(evidence => evidence.status === 'challenged').length,
    ceilings: [
      ...(mission.budgetPause === undefined ? [] : [`budget:${mission.budgetPause.id}`]),
      ...tasks.filter(task => task.ceiling !== undefined).map(task => `task:${task.id}:${task.ceiling!.dimension}`),
    ],
  }
}

/* ----------------------------------------------------------------------- *
 * R17-G1: the interpretation, the one judgement of a board the board
 * classifiers read. A reader of rows alone reads the board.
 * ----------------------------------------------------------------------- */

/** Whether a durably parked member holds this task's open attempt (the R10-15 holder family): rows alone, so asking asks the adapter nothing. */
export function heldByParkedMember(members: readonly Member[], task: Task): task is HeldTask {
  return holdsOpenAttempt(task) && members.some(member => member.id === task.attempt.ownerId && memberPhaseOf(member) === 'parked')
}

/** One board, and what the dispatcher's predicates answer over it. */
export interface Interpretation extends Board {
  nonTerminal: Task[]
  stallRoots: Task[]
  /** The dispatchable work (`dispatchable`), the dispatcher's question. */
  dispatchable: Task[]
  /** The review admission's sources (`unreviewedSources`). */
  unreviewed: Task[]
  /** The dispatcher's unschedulable set for this board. */
  unschedulable: Task[]
  /** The scheduler's stalled predicate for this board. */
  stalled: boolean
}

/**
 * R17-G1: the ONE shared interpretation of a board. Every board classifier
 * (`judge` in src/notices.ts, the obligation follow-ups and the relevance of a
 * board fact) reads it instead of re-reading raw rows and re-deriving its own
 * answer: it is the board, so the dispatcher's own predicates (`eligible`,
 * `reviewable`, `completionError`) are asked of it directly, and beside it what
 * they answer over it once (`dispatchable`, `unschedulable`, `stalled`), so a
 * notice can never describe a board the dispatcher would act on differently. A
 * value of the board alone: it writes nothing, holds no cache, and asks the
 * adapter exactly where its predicates ask it. A reader that needs no judged
 * field reads the board instead: the dispatch sweep, which asks its predicates
 * where it decides; the absence net, until a follow-up is due; and a notice
 * naming the tasks it is about (`subjectsOfTasks`), which asks the adapter nothing.
 */
export function interpret(board: Board): Interpretation {
  return {
    ...board,
    nonTerminal: board.tasks.filter(task => !TERMINAL_STATES.has(task.status)),
    stallRoots: stallRoots(board),
    dispatchable: dispatchable(board),
    unreviewed: unreviewedSources(board),
    unschedulable: unschedulable(board),
    stalled: stalled(board),
  }
}
