/**
 * The board every decision reads, and the declared bounds it is judged against.
 *
 * A board is one mission's rows read at one instant (`readBoard`): the mission
 * with its execution clock applied, its tasks, its members and the task graph
 * over them (`graph`, whose lineage queries a decision asks of it). The
 * scheduling and review-admission decisions below are functions of it, so a
 * reader builds the board where it decides and every predicate it asks sees
 * those rows; none re-reads a row. Three inputs are not
 * rows and are never snapshotted: the clock (`clock`, read where a decision
 * needs the time), the adapter (`view`, asked where a decision needs its
 * answer) and the durable log (`records`: task events, tool runs, the
 * deliveries ledger and evidence, read where a decision reads it).
 */
import { createHash } from 'node:crypto'
import type { SwarmStore } from './store.ts'
import { PolicyError } from './policy-error.ts'
import { executionClock } from './resource-time.ts'
import { assignmentAllows, authorIdsOf, canBorrowTask, canOwnReview, strandedReview } from './assignment.ts'
import { liveReviewFor } from './admission.ts'
import { memberPhaseOf } from './projection.ts'
import { recoveryExit } from './declared-checks.ts'
import { TERMINAL_STATES, completionExempt, missionSubject, pendingStopOwner, quiescencePending, selectAcceptedDelivery, subjectsOfTasks, taskGraphIndex, taskSubject, terminal, uncoveredCriteria, type TaskGraphIndex } from './task-graph.ts'
import type { CheckResult, Delivery, Evidence, Member, Mission, RuntimeConfig, Task } from './types.ts'

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
 * adapter at the instant the decision asks it, never memoized: asking whether a
 * handle is idle can drain a stranded inbox item (`WorkerAdapter.isIdle`, R15-A5).
 */
export interface AdapterView {
  /** Whether the member's worker handle can take an assignment now (`WorkerAdapter.isIdle`). */
  startable(memberId: string): boolean
}

/**
 * The durable log a board reads where a decision reads it: task events, tool
 * runs, the deliveries ledger and evidence. It lists those two tables only: the
 * board's own rows (its mission, tasks and members) are its fields, so no
 * predicate can read one again through the log.
 */
export interface BoardRecords extends Pick<SwarmStore, 'latestTaskEvent' | 'toolRuns'> {
  list(table: 'deliveries', missionId: string): Delivery[]
  list(table: 'evidence', missionId: string): Evidence[]
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
export function readBoard(store: Pick<SwarmStore, 'get' | 'list' | 'latestTaskEvent' | 'toolRuns'>, missionId: string, clock: () => number, bounds: Bounds, view: AdapterView): Board {
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
 * - the parked-member hatch (`memberPhaseOf(member) === 'parked'`, R10-09/S3): a
 *   parked member is startable even when the adapter reports a pending inbox item,
 *   so the hatch wins here exactly as it does in `Scheduling.dispatch`;
 * - the adapter's `isIdle` precondition (`HarnessWorkers.isIdle`), which drains a
 *   stranded `nextStep` item instead of stranding the member (R15-A5);
 * - the W6 open-attempt close-out, which owns a member that already has a
 *   running attempt: `dispatch` handles that member before it dispatches, and
 *   the dispatch question refuses to answer for a task with an open attempt.
 */
export function startBlocker(view: AdapterView, member: Member): 'handle-busy' | undefined {
  if (memberPhaseOf(member) === 'parked') return undefined
  return view.startable(member.id) ? undefined : 'handle-busy'
}

export function ready(board: Board, task: Task, member: Member): boolean {
  return readinessBlocker(board, task, member) === undefined
}

/** The dispatcher's eligibility, which every reader of a dispatchable task asks: a live member that owes no stop, for which the task is ready. */
export function eligible(board: Board, task: Task, member: Member): boolean { return memberPhaseOf(member) !== 'stopped' && !pendingStopOwner(board.tasks, member.id) && ready(board, task, member) }

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
    || all.some(candidate => candidate.status === 'running' && candidate.attempt?.ownerId === preferred.id)
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
  const waiting = task.dependencies.find(dependency => !board.graph.dependencyMetOf(dependency))
  if (waiting !== undefined) {
    const effective = board.graph.effectiveOf(waiting)
    return `dependency ${waiting}${effective.id === waiting ? '' : ` (effective replacement ${effective.id})`} is ${effective.status}, not accepted; inspect it or amend the dependency plan`
  }
  if (task.reviewOf) {
    const source = board.graph.taskOf(task.reviewOf)
    if (source.status !== 'submitted') return `review source ${source.id} is ${source.status}; review begins only after its artifact is submitted`
    if (!canOwnReview(source, member.id)) return `member ${member.id} authored review source ${source.id}; assign an independent reviewer`
  }
  return undefined
}

/**
 * Tasks that cannot be dispatched under the current plan: pending work whose dependency
 * lineage or review source is dead, reviews assigned to their own author,
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
  // Fixpoint: work waiting on dead prerequisites or an unreachable review source is dead too.
  for (let changed = true; changed;) {
    changed = false
    for (const task of tasks) {
      if (dead.has(task.id) || task.status !== 'pending') continue
      const stuck = task.dependencies.some(dependency => { const effective = board.graph.effectiveOf(dependency); return effective.status === 'cancelled' || dead.has(effective.id) })
        || (task.reviewOf !== undefined && (() => {
          const source = board.graph.taskOf(task.reviewOf)
          return TERMINAL_STATES.has(source.status) || dead.has(source.id)
            || !live.some(member => assignmentAllows(task, member.id, tasks) && canOwnReview(source, member.id))
        })())
        || !live.some(member => assignmentAllows(task, member.id, tasks))
      if (stuck) { dead.add(task.id); changed = true }
    }
  }
  return tasks.filter(task => dead.has(task.id))
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
 * Nothing is running, reviewably submitted or dispatchable, and no submission
 * with no live review awaits the review admission (`awaitsReviewAdmission`,
 * the admission's own rule): workers would stay idle forever. An empty board
 * is a mission the owner has not planned yet.
 */
export function stalled(board: Board): boolean {
  return board.tasks.length > 0 && reviewPathStalled(board)
    && !board.tasks.some(task => task.status === 'submitted' && !reviewable(board, task) && awaitsReviewAdmission(board, task))
}

/** R11-01: how long a classified provider outage keeps a member's route quiescent. */
export const PROVIDER_OUTAGE_WINDOW_MS = 5 * 60_000
/** R11-01: the member's route is quiescent only inside the outage window. */
export function providerQuiescent(member: Member, now: number): Member['providerOutage'] {
  const outage = member.providerOutage
  return outage !== undefined && now - outage.at <= PROVIDER_OUTAGE_WINDOW_MS ? outage : undefined
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
/** The review admission's sources, the one set its admission, its decisions and the interpretation read: the submissions it speaks for that no live review can accept (before the grace is applied). */
export const unreviewedSources = (board: Board): Task[] => board.tasks.filter(task => admissionSpeaksFor(task) && !reviewable(board, task))
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
