/** Durable collaboration policy. Worker lifecycle and filesystem effects belong to the adapter. */
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { SwarmStore, WriterBusyError, StoreRecoveryError, stageRestore, type PendingRestore, type PostFilter, type StoreOptions } from './store.ts'
import { Attempts, blockCauses, pendingStopOwner, stopPending, type BlockCause } from './attempts.ts'
import { PolicyError } from './policy-error.ts'
import type { WorkspaceGrantSnapshot } from './authorization.ts'
import { WorkspaceAdmission, gitWriteDeniedMessage, TEMP_RENDEZVOUS_WINDOW_MS, type TempMention } from './workspace-admission.ts'
import { Notices, AUTO_REVIEW_GRACE_MS, REJECTION_DECISION_TRIGGER, missionSubject, subjectsOfTasks, taskSubject, type NotifyOptions } from './notices.ts'
import { RefusalRegistry, emitGuardTerminal, queueWriterBusy, requireStrings, requireText, sameChecks, unsupportedEffort, validatedBudget } from './refusals.ts'
import { Scheduling, type SchedulingPass } from './scheduling.ts'
// R17-G6/G7: the one derivation of mission derived state and its host projection.
import { deriveMemberBoard, deriveMemberStatus, memberPhaseOf, memberDeliveryHealth, type MissionBoardMember } from './projection.ts'
import type { MissionInterpretation } from './notices.ts'
export { emptyUsage, addUsage, missionFingerprint, type MissionFingerprintBoard } from './gates.ts'
import { RuntimeGates, emptyUsage, addUsage, BOARD_DELTA_POSTS, postView, type MissionFingerprintBoard } from './gates.ts'
import { DeclaredChecks, MAX_REPORTED_CHECK_FAILURES, excerpt } from './declared-checks.ts'
import { verdictRows } from './trace.ts'
export { TEMP_RENDEZVOUS_WINDOW_MS, sharedTempPaths, tempRendezvousDecision, WorkspaceRevokedError, type TempMention } from './workspace-admission.ts'
import { proposalAllowance as computeProposalAllowance } from './arena.ts'
import { AdmissionRefusedError, classifyProviderOutage, LIMIT_LEVELS, scopeKeysOverlap, TASK_CLASSES, type AdmissionCandidate, type AdmissionDecision, type AdmissionReason, type AdmissionRecord, type LimitLevel, type LimitRule } from './scheduler.ts'
import { validScope, scopeSubset } from './scope.ts'
import { AdmissionError, assertDeclaredOutputs, assertScopeSelectors, dependencyAssumptions, formatDiagnostic, inheritedAcceptance, isNoopCheck, liveReviewFor, loadPackageScripts, normalizeReviewDependencies, normalizeScopeSelectors, normalizeTaskCeilings, reconcileTaskAdmission, requireHostChecks, taskCeilingBlock, taskGraphDefects, TaskGraphAdmissionError, type TaskGraphNode } from './admission.ts'
import { assignmentAllows, canBorrowTask } from './assignment.ts'
import { executionClock, executionElapsed } from './resource-time.ts'
import { taskGraphIndex, type TaskGraphIndex } from './task-graph.ts'
import { checkSyntaxDetail, declaredPlanChecks, orderedTasks, planAdvisories, validatePlan } from './plans.ts'
import { OWNER_ONLY_TOOLS, type Actor, type AutoStart, BoardQuery, Budget, CheckAttribution, CheckEnvelope, CheckEnvironment, CreateMissionInput, CriticalPath, Delivery, DraftPlan, Escalation, Evidence, EvidenceStatus, Member, MemberStatus, Mission, NoticeClass, ObserveQuery, MessageInput, PlanInput, Post, PostInput, PostKind, ProposeTaskInput, ProviderOutage, PublishInput, RecoveryFallback, RequestStartInput, RuntimeConfig, Snapshot, Task, TaskAmendment, TaskCeiling, ToolRun, UsageBuckets, UsageSnapshotSource, VerificationCleanupFailure, WorkerAdapter, WorkerActivity, Workstream } from './types.ts'
import { nextWorkerName } from './types.ts'
import { requireArtifactChecks } from './artifact-policy.ts'

const id = (prefix: string) => `${prefix}_${randomUUID()}`
const terminal = (mission: Mission) => mission.status === 'stopped' || mission.status === 'completed'
/** Release a prelaunch caller even when an adapter ignores cancellation. Its late writes remain fenced. */
async function abortableStart<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); throw signal.reason }
  let abort!: () => void
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([operation, interrupted]) }
  finally { signal.removeEventListener('abort', abort) }
}
/** Board delta reads are bounded to this page size unless the caller asks for less. */
const BOARD_PAGE_MAX = 100
const BOARD_PAGE_DEFAULT = 20




/** R11-01: how long a classified provider outage keeps a member's route quiescent. */
const PROVIDER_OUTAGE_WINDOW_MS = 5 * 60_000
/** R11-01: bound the durable outage log to one row per member and class per window. */
const PROVIDER_OUTAGE_EVENT_WINDOW_MS = 30_000
/** Idle close-out nudges before an open attempt is checkpointed and re-pended. */









/**
 * S1: consecutive scheduling passes that advance no durable mission state and
 * terminate nothing before the runtime escalates. Defaults are expressed as
 * integer multiples of `tickMs` and are configuration (RuntimeConfig.
 * `stallPasses` / `stallPassTimeoutMs`), never a constant a stalled board can be
 * trapped behind.
 */
const DEFAULT_STALL_PASSES = 3
const DEFAULT_STALL_PASS_TIMEOUT_TICKS = 30
/**
 * R16-D: the declared bound on how long a live attempt may record no durable
 * progress before the runtime escalates it by name (`attempt-silent:`). The
 * default matches the longest wait this host itself treats as bounded (F1's
 * `operationBoundMs` / the harness's 600 s `maxWaitTimeoutMs`): an attempt that
 * has recorded nothing at all for that long is past the point where a live lease
 * can still be read as progress. Configuration, never a constant the runtime is
 * trapped behind: `attemptSilenceBoundMs` on the runtime config, `0` disables
 * the guard, an invalid value keeps this default.
 */
const DEFAULT_ATTEMPT_SILENCE_BOUND_MS = 10 * 60_000
/**
 * R16-D: the additional declared window a wedged scheduling pass stays live
 * (unnamed) while the mission still has live work. The default is the pass
 * bound itself (so a wedge is named after at most 2 × `stallPassTimeoutMs`),
 * and it is configuration: `stallPassLiveGraceMs` on the runtime config, `0`
 * meaning "name it at the first bound". Without it the naming was unbounded — a
 * wedged pass waited for every unrelated lease to lapse, exactly the silent
 * blocking round 16 removes.
 */
const DEFAULT_STALL_PASS_LIVE_GRACE_TICKS = 1
/**
 * R5-02: consecutive `workers.start` failures for one member before its work is
 * re-routed to another capable live member. A transient start failure self-heals
 * on the next tick; only a route that keeps failing is retired.
 */
const START_FAILURE_REROUTE_LIMIT = 3
/**
 * F2: recovery budget for a verification task the runtime admits automatically
 * when a submitted code deliverable has no live review path. Two attempts cover
 * a transient workspace/preparation failure without letting the automatic review
 * consume an unbounded share of the mission budget.
 */
const AUTO_REVIEW_RECOVERY_ATTEMPTS = 2
































/**
 * `detail=full` is an owner-only read. Worker guidance alone did not prevent its
 * use (docs/observe-context-measurement.md), so the runtime refuses it; callers
 * branch on the class, never on message text. The message names the owner gate
 * so the trace classifier records an authorization error.
 */
export class ObserveDetailRefusedError extends PolicyError {
  constructor() {
    super('observe_detail_full_owner_only', 'authorization_error', 'Only the mission owner may read detail=full; workers read bounded records with taskId, runId, evidenceId, after or afterRun')
    this.name = 'ObserveDetailRefusedError'
  }
  /** Named before it was typed, so its recorded rendering keeps the name. */
  override toString(): string { return `${this.name}: ${this.message}` }
}
/**
 * ENV: one field of the declared-check envelope the executed check does not
 * reproduce. `selfRun` names the measured side of the comparison; both sides are
 * environments the host recorded, never an environment read off a command.
 */
export interface CheckEnvironmentMismatch { field: string; envelope: string; selfRun: string }
/**
 * ENV: the envelope reproduction comparison. `blocking` divergences mean the
 * declared host checks that support this verification did not run under the
 * environment the envelope promised, so the mismatch is reported instead of
 * accepting the artifact. `advisory` divergences (whether a cache root happened
 * to exist) are recorded but never refuse an acceptance: a check must not depend
 * on the ambient cache staying warm.
 */
export interface CheckEnvironmentComparison { blocking: CheckEnvironmentMismatch[]; advisory: CheckEnvironmentMismatch[] }
const checkEnvironmentField = (value: string | boolean | null): string => value === null ? 'absent' : String(value)
/** ENV: the cache roots as one comparable field; `none` when the environment sets none. */
const checkCacheRootsField = (roots: Record<string, string>): string =>
  Object.keys(roots).sort().map(name => `${name}=${roots[name]}`).join(', ') || 'none'
/** Dependency directories are a set; Git inventory order is not declaration order. */
const checkDependencyDirsField = (dirs: readonly string[] | undefined): string =>
  JSON.stringify([...new Set(dirs ?? [])].sort())
/**
 * ENV: compare the declared envelope the runtime delivered with the environment
 * a host-recorded execution reports. HOME, the user cache roots, the
 * sandbox policy and the dependency links must agree; the scoped check cache
 * roots the envelope itself provides (`checkCacheRoot`, `checkCacheRoots`,
 * `xdgCacheHome`) and the existence flags are compared and REPORTED but stay
 * advisory: they differ by construction on every run, and a check must not
 * depend on the ambient cache staying warm — refusing on them would block every
 * production acceptance.
 */
export function compareCheckEnvironments(envelope: CheckEnvironment, selfRun: CheckEnvironment): CheckEnvironmentComparison {
  const blocking: CheckEnvironmentMismatch[] = []
  const advisory: CheckEnvironmentMismatch[] = []
  const compare = (field: string, before: string | boolean | null, after: string | boolean | null, into: CheckEnvironmentMismatch[]): void => {
    const left = checkEnvironmentField(before), right = checkEnvironmentField(after)
    if (left !== right) into.push({ field, envelope: left, selfRun: right })
  }
  compare('home', envelope.home, selfRun.home, blocking)
  compare('userCacheDir', envelope.userCacheDir, selfRun.userCacheDir, blocking)
  compare('huggingfaceCacheDir', envelope.huggingfaceCacheDir, selfRun.huggingfaceCacheDir, blocking)
  compare('sandboxPolicy.mode', envelope.sandboxPolicy?.mode ?? null, selfRun.sandboxPolicy?.mode ?? null, blocking)
  compare('sandboxPolicy.enforcement', envelope.sandboxPolicy?.enforcement ?? null, selfRun.sandboxPolicy?.enforcement ?? null, blocking)
  compare('dependencyLinks.mode', envelope.dependencyLinks?.mode ?? null, selfRun.dependencyLinks?.mode ?? null, blocking)
  compare('dependencyLinks.dirs', checkDependencyDirsField(envelope.dependencyLinks?.dirs), checkDependencyDirsField(selfRun.dependencyLinks?.dirs), blocking)
  compare('userCacheDirExists', envelope.userCacheDirExists, selfRun.userCacheDirExists, advisory)
  compare('huggingfaceCacheDirExists', envelope.huggingfaceCacheDirExists, selfRun.huggingfaceCacheDirExists, advisory)
  // The scoped roots the envelope promises name a placeholder checkout, while
  // an executed check names the disposable checkout it really received: they
  // differ on every run by construction. Both are still named with both values
  // so the record shows the difference, never an empty comparison that hides it.
  compare('xdgCacheHome', envelope.xdgCacheHome, selfRun.xdgCacheHome, advisory)
  compare('checkCacheRoot', envelope.checkCacheRoot, selfRun.checkCacheRoot, advisory)
  compare('checkCacheRoots', checkCacheRootsField(envelope.checkCacheRoots), checkCacheRootsField(selfRun.checkCacheRoots), advisory)
  return { blocking, advisory }
}
/**
 * ENV: a verification whose supporting host checks did not run under the
 * declared-check envelope. The verdict is refused rather than accepting an
 * artifact that was only ever validated under a different environment.
 */
export class CheckEnvironmentMismatchError extends Error {
  readonly code = 'check_environment_mismatch'
  constructor(message: string) {
    super(message)
    this.name = 'CheckEnvironmentMismatchError'
  }
}
/** ENV: the measured envelope plus the environment facts the adapter attaches. */
type DeclaredCheckEnvelope = CheckEnvelope & {
  environment?: CheckEnvironment
  selfRunEnvironment?: CheckEnvironment
}
const isDeclaredCheckEnvironment = (value: unknown): value is CheckEnvironment =>
  typeof value === 'object' && value !== null && 'home' in value && 'sandboxPolicy' in value && 'dependencyLinks' in value && 'checkCacheRoot' in value
/** The model-visible position already delivered to one member; the next default read starts after it. */
interface DeliveredCursor { eventSeq: number; runSeq: number; postSeq: number; current?: string }
type OwnerRows = Record<'board' | 'members' | 'evidence', Array<{ id: string }>>
interface OwnerCursor {
  scope: string
  token: string
  eventSeq: number
  postSeq: number
  rows: Record<keyof OwnerRows, Map<string, string>>
}
/**
 * S5c: consecutive `workers.start` failures, carried on the member row so the
 * count survives a lost map or a restart instead of handing a failing route a
 * fresh budget. `Member` (src/types.ts) is outside this task's write scope, so
 * the field is declared here and travels as a plain JSON property on the same
 * durable row; the integration task records the one-line schema addition.
 */
interface MemberStartFailureFields { startFailures?: number }
const startFailureFields = (member: Member): Member & MemberStartFailureFields => member as Member & MemberStartFailureFields
/** A single runtime owns scheduling, admission, state transitions and a durable outbox. */
/**
 * L3: an owner-facing question is delivered with the exact call that answers it.
 * The owner's prose is not part of this store and never reaches the asker, so the
 * envelope states the receipt requirement where the question is read.
 */
function ownerQuestionContent(missionId: string, deliveryId: string, from: string, content: string, inReplyTo: Delivery | undefined): string {
  const answers = inReplyTo === undefined ? '' : ` (this message also answers ${inReplyTo.id})`
  return [
    content,
    '',
    `[swarm receipt required] ${from} asked this through swarm_message${answers}. Text in this conversation is NOT delivered to the member.`,
    `Answer with: swarm_message({ missionId: "${missionId}", to: "${from}", kind: "question", content: "<your answer>", replyTo: "${deliveryId}" })`,
    `Or close it deliberately: swarm_message({ missionId: "${missionId}", to: "${from}", kind: "question", content: "<why not>", replyTo: "${deliveryId}", dismiss: true })`,
  ].join('\n')
}
export class SwarmRuntime {
  /**
   * S5 inventory of every in-memory `Set`/`Map` reachable from the scheduling
   * path, with its classification (a full version lives in
   * docs/known-limitations.md, "Round-13 control-path slices"):
   *
   *  derivable (the gate re-reads the store; the memory value is only a cache):
   *   - the unreviewed-submission grace: age of the durable `task/submitted`
   *     event (`unreviewedStall`; the old `unreviewedSince` timer is removed);
   *   - a withdrawn automatic review: durable `task/review-admitted` events
   *     and deterministic task identity (`withdrawnAutomaticReview`);
   *   - a recorded missing review: durable `task/review-missing` event per
   *     submission (`missingReviewRecorded`).
   *  cache-only (loss changes no durable outcome; each is covered by a test that
   *  clears it and asserts the durable result is unchanged):
   *   - `idleSignals` (durable `Task.idleSignal`),
   *     `startFailures`, `budgetStops`, `operations`, `startControllers`,
   *     `fingerprintCache` (keyed by store revision), `observeCursors`, `ownerObserveCursors`.
   *  physical ownership: `queues` retains in-flight operations until they settle.
   *  It is not a disposable cache while adapter I/O can still affect a checkout.
   *  The scheduling pass guard (`Scheduling.passes`) is the same kind of state:
   *  the one scheduling body queued or running on a mission's queue, removed
   *  when that body settles.
   *
   * There is deliberately no in-memory `scheduled` Set: the Row-13 incident was
   * that Set swallowing the tick timer's only liveness action while the pass it
   * deduplicated never returned, unnamed. The pass guard differs in the two ways
   * that incident lacked: every await in the pass body is bounded, so the body
   * settles and releases it, and the tick watchdog reads its start time and
   * names a body past its bound while it is still held.
   */
  readonly store: SwarmStore
  private readonly listeners = new Set<(missionId: string) => void>()
  readonly queues = new Map<string, Promise<unknown> & { operation: { id: string } }>()
  /** Deferred bodies in flight; shutdown drains them within the declared pass bound. */
  private readonly operations = new Set<Promise<unknown>>()
  private readonly startControllers = new Map<string, AbortController>()
  private readonly workerStarts = new Map<string, { controller: AbortController; promise: Promise<void>; retryAfter?: number; nativePending?: boolean; admissionSignal?: AbortSignal }>()
  private disposal?: Promise<void>
  
  
  /**
   * Members that ended a turn while still owning an attempt; drives the bounded
   * close-out. S5 cache: the durable signal is `Task.idleSignal`, written by
   * `onIdle` and re-read by the scheduling pass, so losing this map only delays
   * the close-out until lease expiry.
   */
  /** Consecutive `workers.start` failures per member; a successful start clears the count (R5-02). */
  readonly startFailures = new Map<string, number>()
  /**
   * Delivered observe positions per member. This is a context cache, not mission
   * state: a restart re-sends one bounded focused view and then resumes deltas,
   * so a stale position can never hide events from a member.
   */
  private readonly observeCursors = new Map<string, DeliveredCursor>()
  // Explicit compact-view baselines scoped to owner/mission. Recent cursors
  // remain replayable after a lost response; eviction/restart gives a full reset.
  private readonly ownerObserveCursors = new Map<string, OwnerCursor>()
  private timer?: ReturnType<typeof setInterval>
  closed = false
  shuttingDown = false
  /**
   * Exact owner notices already sent for an unreviewable source. Automatic
   * review admissions are read directly from durable task events; the set
   * keeps a persistent blocker from waking the owner on
   * every tick.
   */
  
  /** Missing-review records already written, keyed by mission:source:submission seq. */
  private readonly reviewPathReported = new Set<string>()
  
  
  
  /** Open runtime transactions; a cached F(S) is not trusted inside one. */
  commitDepth = 0
  /** R11-15: bounded per-path shared-temp mentions, newest last. */
  
  /** R11-15: `path|memberA|memberB` pairs already reported inside the window. */
  

  /** M1a seam 6/7: workspace and admission surface. */
  private readonly workspaceAdmission = new WorkspaceAdmission(this)
  /** The mission is terminal: no further scheduling or fencing applies. */
  isMissionTerminal(mission: Mission): boolean { return terminal(mission) }
  // M1a seam 6/7: the workspace/admission surface lives in src/workspace-admission.ts.
  assertAuthorizedRoot(workspace: string, grantRoot: string | undefined, source?: 'session' | 'grant'): { grantRoot: string; source: 'session' | 'grant' } { return this.workspaceAdmission.assertAuthorizedRoot(workspace, grantRoot, source) }
  async assertWorkspaceAuthorized(mission: Pick<Mission, 'id' | 'workspace' | 'workspaceGrantRoot' | 'workspaceAuthorizationSource'>): Promise<void> { return this.workspaceAdmission.assertWorkspaceAuthorized(mission) }
  fenceWorkspace(missionId: string, reason: string): void { return this.workspaceAdmission.fenceWorkspace(missionId, reason) }
  deniedGitWrite(input: { tool: string; arguments: unknown; result: unknown; isError: boolean }): string | undefined { return this.workspaceAdmission.deniedGitWrite(input) }
  tempRendezvous(memberId: string, taskId: string, input: { tool: string; arguments: unknown }): { path: string; first: TempMention; second: TempMention } | undefined { return this.workspaceAdmission.tempRendezvous(memberId, taskId, input) }
  isolationAllows(missionId: string, member: Member): boolean { return this.workspaceAdmission.isolationAllows(missionId, member) }
  isolationViolations(missionId: string): string[] { return this.workspaceAdmission.isolationViolations(missionId) }

  readonly attempts = new Attempts(this)
  /** M1a seam 4/7: the durable refusal registry and its writer-busy recovery. */
  private readonly refusals = new RefusalRegistry(this)
  private admissionDecision(mission: Mission, member: Member, task: Task): { candidate: AdmissionCandidate; decision: AdmissionDecision } { return this.refusals.admissionDecision(mission, member, task) }
  private admissionRecord(candidate: AdmissionCandidate, decision: AdmissionDecision, latencyMs: number): AdmissionRecord { return this.refusals.admissionRecord(candidate, decision, latencyMs) }
  upsertAdmission(record: AdmissionRecord): void { return this.refusals.upsertAdmission(record) }
  private recordRefusal(candidate: AdmissionCandidate, decision: AdmissionDecision, latencyMs: number): void { return this.refusals.recordRefusal(candidate, decision, latencyMs) }
  upsertBudgetRefusals(mission: Mission, reason: string): void { return this.refusals.upsertBudgetRefusals(mission, reason) }
  private recordWriterBusyRecovery(mission: Mission): void { return this.refusals.recordWriterBusyRecovery(mission) }
  private refuseProposal(mission: Mission, proposer: string, title: string, reason: string, limit: number): never { return this.refusals.refuseProposal(mission, proposer, title, reason, limit) }

  /** M1a seam 3/7: owner notices, witnesses and the outbox that delivers them. */
  private readonly notices = new Notices(this)
  notify(missionId: string, content: string, subjects: string[], options: NotifyOptions = {}): void { return this.notices.notify(missionId, content, subjects, options) }
  ownerDeliveryRelevant(mission: Mission, delivery: Delivery): boolean { return this.notices.ownerDeliveryRelevant(mission, delivery) }
  ownerDeliveryContent(mission: Mission, delivery: Delivery): string { return this.notices.ownerDeliveryContent(mission, delivery) }
  /**
   * Record consumption only when the host admits the relay into user/message,
   * after native pre-step filtering, using the exact delivery id.
   * Compare-and-swap inside the mission transaction; delivered, consumed and
   * resolved stay three facts.
   */
  recordConsumption(deliveryId: string, options: { at?: number; source?: string } = {}): boolean { return this.notices.recordConsumption(deliveryId, options) }
  /**
   * R15-A1: the subjects of a notice that is scoped to a task, a member or the
   * mission itself. A task-scoped notice names that task at its epoch; a
   * member-scoped notice names the member's unfinished work; the mission root is
   * the fallback only when neither exists, so a notice is never anonymous.
   * Guard pair: member-scoped notice x task-scoped notice — a member's notice
   * never borrows another task's subject, which is what keeps one subject's clock
   * independent of a healthy sibling (R15-A4).
   */
  noticeSubjectsFor(missionId: string, scope: { taskId?: string; memberId?: string } = {}): string[] {
    const mission = this.store.get('missions', missionId)
    const root = mission === undefined ? `mission:${missionId}` : missionSubject(mission)
    const tasks = this.store.list('tasks', missionId)
    if (scope.taskId !== undefined) {
      const task = tasks.find(candidate => candidate.id === scope.taskId)
      if (task !== undefined) return [taskSubject(task)]
    }
    if (scope.memberId !== undefined) {
      const owned = tasks.filter(task => (task.attempt?.ownerId === scope.memberId || task.assigneeId === scope.memberId) && task.status !== 'accepted' && task.status !== 'cancelled')
      if (owned.length) return subjectsOfTasks(owned, mission ?? { id: missionId })
    }
    return [root]
  }
  /**
   * R15-A4: the dispatcher's per-(task, assignee) question, forwarded so the
   * notice path asks exactly the predicate the sweep used.
   */
  dispatchQuestion(missionId: string, tasks: Task[], members: Member[], dispatchable: Task[]): ReturnType<Scheduling['dispatchQuestion']> { return this.scheduling.dispatchQuestion(missionId, tasks, members, dispatchable) }
  noticeKey(missionId: string): string { return this.notices.noticeKey(missionId) }
  private enqueueOwnerNotice(missionId: string, content: string, from: string, noticeClass: NoticeClass, extra: Partial<Delivery> = {}, dedupe = noticeClass === 'budget', dedupKeyOverride?: string): Delivery | undefined { return this.notices.enqueueOwnerNotice(missionId, content, from, noticeClass, extra, dedupe, dedupKeyOverride) }
  noticeLedger(actor: Actor, missionId: string, query: { limit?: number } = {}): unknown { return this.notices.noticeLedger(actor, missionId, query) }
  private bounded(text: string): string { return this.notices.bounded(text) }
  private ensureWitness(missionId: string, options: { offPass?: boolean; wedged?: boolean } = {}): void { return this.notices.ensureWitness(missionId, options) }
  notifyStall(mission: Mission, reason: string): void { return this.notices.notifyStall(this.interpretation(mission.id), reason) }
  /**
   * R17-G1: the shared interpretation of one mission's durable state, forwarded
   * so the dispatcher and every generator read the same derived view.
   */
  interpretation(missionId: string): MissionInterpretation { return this.notices.interpretation(missionId) }
  /** R17-G5: the named wedged pass owed its dispatch question; publish with the wedged branch. */
  expectWedgedRelease(missionId: string): void { this.notices.expectWedgedRelease(missionId) }
  /** R17-G5: the scheduling pass state at a committed transition (for publication). */
  passState(missionId: string): { passLive: boolean; wedged: boolean } {
    return { passLive: this.scheduling.livePass(missionId) !== undefined, wedged: this.scheduling.passWedged(missionId) }
  }
  /** R17-G5: a settled pass is a transition; it publishes what its live window left unpublished. */
  passSettled(missionId: string): void { this.notices.transition(missionId) }
  notifyCoverageComplete(mission: Mission): void { return this.notices.notifyCoverageComplete(mission) }
  notifyParkedHolder(mission: Mission, task: Task): void { return this.notices.notifyParkedHolder(mission, task) }
  private warnIntegrationGap(mission: Mission, admitted: Task): void { return this.notices.warnIntegrationGap(mission, admitted) }
  private notifyReviewBlocked(mission: Mission, source: Task, reason: string): void { return this.notices.notifyReviewBlocked(mission, source, reason) }
  private topicDelivery(missionId: string, from: string, topic: string, content: string): void { return this.notices.topicDelivery(missionId, from, topic, content) }
  async flushOutbox(missionId: string): Promise<void> { return this.notices.flushOutbox(missionId) }
  pumpOutbox(): void { return this.notices.pumpOutbox() }

  /** M1a seam 7/7: scheduling predicates, pass bookkeeping and the dispatch sweep. */
  private readonly scheduling = new Scheduling(this)
  ready(task: Task, member: Member, tasks?: Task[]): boolean { return this.scheduling.ready(task, member, tasks) }
  unschedulable(mission: Mission, tasks: Task[], members: Member[]): Task[] { return this.scheduling.unschedulable(mission, tasks, members) }
  reviewable(task: Task, tasks: Task[]): boolean { return this.scheduling.reviewable(task, tasks) }
  stalled(mission: Mission, tasks: Task[], members: Member[]): boolean { return this.scheduling.stalled(mission, tasks, members) }
  private quiescencePending(task: Task): boolean { return this.scheduling.quiescencePending(task) }
  private selectDeliveryTarget(missionId: string, tasks: Task[]): Task { return this.scheduling.selectDeliveryTarget(missionId, tasks) }
  private deliveryTarget(actor: Actor, missionId: string): { mission: Mission; task: Task } { return this.scheduling.deliveryTarget(actor, missionId) }
  private openPass(missionId: string): SchedulingPass | undefined { return this.scheduling.openPass(missionId) }
  private closePass(missionId: string, pass: SchedulingPass): void { return this.scheduling.closePass(missionId, pass) }
  private checkSchedulingPasses(): void { return this.scheduling.checkSchedulingPasses() }
  private reviewPathStalled(tasks: Task[], members: Member[]): boolean { return this.scheduling.reviewPathStalled(tasks, members) }
  private rerouteTarget(missionId: string, task: Task, failedId: string): Member | undefined { return this.scheduling.rerouteTarget(missionId, task, failedId) }

  /** M1a seam 5/7: the declared-check execution path. */
  private readonly declaredChecks = new DeclaredChecks(this)
  /** M1a seam 2/7: derived fingerprints, usage accounting and the budget gate. */
  private readonly gates = new RuntimeGates(this)
  fingerprint(missionId: string): string { return this.gates.fingerprint(missionId) }
  fingerprintRecords(missionId: string): { mission: Mission; tasks: Task[]; members: Member[]; evidence: Evidence[]; deliveries: Delivery[] } { return this.gates.fingerprintRecords(missionId) }
  fingerprintBoard(missionId: string): MissionFingerprintBoard { return this.gates.fingerprintBoard(missionId) }
  private ownerInstruments(missionId: string, full: boolean): Record<string, unknown> { return this.gates.ownerInstruments(missionId, full) }
  private boardWindow(missionId: string, memberId: string, afterSeq: number): Record<string, unknown> { return this.gates.boardWindow(missionId, memberId, afterSeq) }
  private async usage(memberId: string, tokens: number): Promise<void> { return this.gates.usage(memberId, tokens) }
  private async usageSnapshot(memberId: string, totalTokens: number, usage?: UsageBuckets, source?: UsageSnapshotSource): Promise<void> { return this.gates.usageSnapshot(memberId, totalTokens, usage, source) }
  private recordOwnerUsage(sessionId: string, usage: UsageBuckets): void { return this.gates.recordOwnerUsage(sessionId, usage) }
  private warnBudget(mission: Mission): void { return this.gates.warnBudget(mission) }
  private blockBudget(mission: Mission): void { return this.gates.blockBudget(mission) }
  private beginBudgetStop(missionId: string, pauseId: string): void { return this.gates.beginBudgetStop(missionId, pauseId) }
  private resumeBudgetTasks(mission: Mission): void { return this.gates.resumeBudgetTasks(mission) }

  /**
   * M1a: the moved in-memory caches stay reachable on the runtime under the same
   * names. Each is a live getter onto the module that now owns the collection, so
   * the cache-only tests clear and inspect exactly the object the scheduling path
   * reads (loss of each changes no durable outcome; S5's inventory names them).
   */
  get idleSignals() { return this.attempts.idleSignals }
  get budgetStops() { return this.gates.budgetStops }
  get fingerprintCache() { return this.gates.fingerprintCache }
  get instanceId(): string { return this.scheduling.instanceId }

  constructor(readonly config: RuntimeConfig, readonly workers: WorkerAdapter, storeOptions: StoreOptions = {}) {
    this.store = new SwarmStore(config.statePath, storeOptions)
    workers.bind({
      activity: (memberId, activity) => this.onActivity(memberId, activity),
      idle: memberId => this.onIdle(memberId),
      beforeStep: (memberId, hasFreshInput) => this.beforeStep(memberId, hasFreshInput),
      usage: (memberId, tokens) => this.usage(memberId, tokens),
      usageSnapshot: (memberId, totalTokens, usage, source) => this.usageSnapshot(memberId, totalTokens, usage, source),
      ownerUsage: (sessionId, usage) => this.recordOwnerUsage(sessionId, usage),
      admitDelivery: (memberId, deliveryId) => {
        const delivery = this.store.get('deliveries', deliveryId)
        if (!delivery || delivery.to !== memberId) return false
        if (delivery.kind !== 'assignment') return true
        if (this.store.get('missions', delivery.missionId)?.budgetPause) return false
        const task = delivery.taskId ? this.store.get('tasks', delivery.taskId) : undefined
        return task?.status === 'running' && task.attempt?.id === delivery.attemptId && task.attempt?.ownerId === memberId
      },
      toolRun: (memberId, run) => this.recordToolRun(memberId, run),
      guard: (memberId, tool) => this.guard(memberId, tool),
      failure: (memberId, error) => this.onFailure(memberId, error),
      providerOutage: (memberId, outage) => this.onProviderOutage(memberId, outage),
      recoveryFallback: info => this.onRecoveryFallback(info),
      verificationCleanupFailure: info => this.onVerificationCleanupFailure(info),
    })
  }
  /**
   * Recover active missions without requiring a live coordinator or user session.
   * `grants` is the human authorization loaded once by the plugin; when given,
   * each root is recorded durably as `workspace/grant-loaded` so the audit shows
   * exactly what the host was authorized to do in this process.
   */
  async start(grants?: WorkspaceGrantSnapshot): Promise<void> {
    // R17-G8: subscribe to the host's claimed signal so real consumption is
    // recorded from it (one CAS write per delivery), never inferred.
    this.notices.attach(this.workers)
    if (grants !== undefined) {
      this.store.transaction(() => {
        for (const grant of grants.grants) this.store.event('swarm/install', 'workspace/grant-loaded', 'config', { path: grant.path, ...(grant.note === undefined ? {} : { note: grant.note }), ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }) })
        for (const unresolved of grants.unresolved) this.store.event('swarm/install', 'workspace/grant-loaded', 'config', { path: unresolved, loaded: false })
      })
    }
    // Persisted activity is presentation history, never proof that an execution survived a restart.
    for (const member of this.store.list('members')) if (member.activity !== undefined) {
      delete member.activity
      this.commit(member.missionId, () => this.store.put('members', member))
    }
    for (const draft of this.store.list('drafts')) if (draft.status === 'launching') {
      draft.status = 'failed'; draft.error = 'Host restarted during plan assembly. Retry launch to continue the saved plan.'; draft.updatedAt = Date.now()
      this.store.transaction(() => this.store.put('drafts', draft))
    }
    for (const request of this.store.list('starts')) {
      const mission = request.missionId ? this.store.get('missions', request.missionId) : undefined
      if (mission && mission.status !== 'staged') {
        request.status = mission.status === 'completed' ? 'completed' : mission.status === 'stopped' ? 'stopped' : 'running'
        request.budget = { ...mission.budget }
        delete request.error
      } else if (request.status === 'planning' || request.status === 'launching') {
        request.status = 'failed'
        request.error = 'Host restarted before automatic launch completed. Retry the saved request to continue.'
        request.recoveryNoticePending = true
        delete request.planningDispatchPending
      } else continue
      request.updatedAt = Date.now()
      this.store.transaction(() => this.store.put('starts', request))
    }
    const unstarted: Mission[] = []
    for (const mission of this.store.list('missions')) {
      if (terminal(mission)) {
        // A cold host has no surviving native worker handles for terminal work.
        // R17-G7: the durable phase is what changes; the live status is derived.
        this.commit(mission.id, () => {
          for (const member of this.store.list('members', mission.id)) {
            if (memberPhaseOf(member) !== 'stopped') { member.phase = 'stopped'; this.store.put('members', member) }
          }
        })
        for (const task of this.store.list('tasks', mission.id)) if (stopPending(task)) this.attempts.resumeStoppedAttempt(mission.id, task)
        continue
      }
      this.commit(mission.id, () => {
        if (mission.executionTime !== undefined) {
          const lastEvent = this.store.events(mission.id, 1).at(-1)?.createdAt ?? mission.updatedAt
          mission.executionTime = { usedMs: executionElapsed(mission, lastEvent) }; executionClock(mission, false); this.store.put('missions', mission)
        }
        if (mission.budgetPause) { mission.budgetPause.quiesced = true; this.store.put('missions', mission) }
        for (const task of this.store.list('tasks', mission.id)) {
          // Finding volume is advisory. Retire only this obsolete ceiling;
          // independent rejection or preparation failures still need repair.
          // A host restart never spends or checks recovery credit (R11-07), so
          // the recovery limit alone does not keep the task blocked.
          if (task.ceiling?.dimension === 'maxFindings') {
            delete task.ceiling
            const remaining = [...this.taskBlockCauses(task)].filter(cause => cause !== 'recovery-exhausted')
            if (task.status === 'blocked' && task.resumeAfterStop === undefined && remaining.length === 0) task.status = 'pending'
            this.store.put('tasks', task)
          }
          // A cold host confirms the old process is gone, but a durable stop
          // still owes WIP preservation before another member may reuse it.
          if (stopPending(task)) continue
          if (task.status === 'running') {
            // R11-07: a host restart is a host-caused stop, never a worker
            // recovery failure. No recovery credit is spent (a
            // `maxRecoveryAttempts: 1` task survives one restart), the task is
            // always re-pended, and a durable per-task event names it instead of
            // only the generic `mission/recovered` row. The old attempt is
            // fenced and the next epoch records the handoff reason.
            const ownerId = task.attempt?.ownerId
            const pauseInduced = mission.budgetPause !== undefined || task.budgetResume !== undefined
            task.status = 'pending'
            task.epoch++
            task.handoff = `${task.handoff ?? ''}\nRecovered after host restart; inspect prior tool runs and workspace before repeating effects.`
            this.dropAttempt(task)
            delete task.budgetResume
            this.store.put('tasks', task)
            this.store.event(mission.id, 'task/restart-repended', 'runtime', {
              taskId: task.id, epoch: task.epoch, ownerId, reason: 'host-restart', pauseInduced,
              recoveryCount: task.recoveryCount ?? 0, maxRecoveryAttempts: task.maxRecoveryAttempts ?? this.config.maxTasksPerMember,
            })
          }
        }
        // R17-G7: recovery used to rewrite every non-stopped member row to
        // `idle`, which is exactly how a member could read `idle` while the
        // attempt it owns was still live (R15-F2). There is nothing to write:
        // the attempt rows above are re-pended or dropped in this same
        // transaction, and the live status is derived from them, while a parked
        // member keeps the owner's durable park intent across the restart.
        for (const member of this.store.list('members', mission.id)) {
          if (member.phase === undefined) { member.phase = 'active'; this.store.put('members', member) }
        }
        this.store.event(mission.id, 'mission/recovered', 'runtime', {})
      })
      for (const task of this.store.list('tasks', mission.id)) if (stopPending(task)) this.attempts.resumeStoppedAttempt(mission.id, task)
      if (mission.status === 'active') unstarted.push(mission)
      this.kick(mission.id)
    }
    // Install the ticker after recovery commits, before independent native
    // starts. It keeps delivering notices and checking budgets during recovery.
    this.startTicker()
    // Native recovery is independent per member. Plugin registration must finish
    // even when one host startup is slow; each startup has its own abort bound.
    for (const mission of unstarted) this.ensureWorkers(mission)
  }
  /**
   * R15-A2: the queue-external tick. Everything here reads durable rows and runs
   * outside every mission queue, so a pass wedged inside `workers.start` (or any
   * other adapter await) cannot swallow it.
   *
   * Co-firing guards, named: the outbox pump (S2, delivers what the witnesses
   * write), the scheduling-pass watchdog (S1/S2, names a pass past its bound
   * with the work it never reached), the budget gates (deadline cancellation
   * must not queue behind a long verification) and `sweepDecisions` (the
   * off-pass half of the same decision function the pass runs).
   * `checkSchedulingPasses` runs before `sweepDecisions` on purpose: a pass that
   * just expired is named first, and the sweep then sees it wedged rather than
   * racing the watchdog for the same state.
   */
  private startTicker(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      if (this.closed || this.shuttingDown) return
      // S2: the outbox pump is driven from the tick timer, never from a mission
      // queue. A durable owner notice is delivered even when the mission's pass
      // is wedged in an adapter call or the lock is otherwise held, because the
      // pump reads only durable rows and never takes `exclusive`.
      this.tickGuard('outbox', () => this.pumpOutbox())
      this.tickGuard('starts', () => this.sweepStarts())
      this.tickGuard('passes', () => this.checkSchedulingPasses())
      this.tickGuard('decisions', () => this.sweepDecisions())
      this.tickGuard('writer-recovery', () => this.refusals.recordWriterBusyRecovery())
      this.tickGuard('missions', () => { for (const mission of this.store.list('missions')) this.tickGuard(`mission ${mission.id}`, () => {
        if (mission.executionTime !== undefined) executionClock(mission, mission.executionTime.since !== undefined)
        // Deadline cancellation cannot queue behind a long verification holding the mission queue.
        if (mission.status === 'active' && Date.now() >= mission.deadline) this.blockBudget(mission)
        else if (mission.status === 'active') this.warnBudget(mission)
        if (!terminal(mission)) this.kick(mission.id)
      }) })
    }, this.config.tickMs)
    this.timer.unref()
  }
  /** A failed durable write must not silence unrelated guards or missions. */
  private tickGuard(name: string, operation: () => void): void {
    try { operation() }
    catch (error) {
      // Logging must not throw into the timer either (for example a closed pipe).
      try { if (!this.closed) process.stderr.write(`[agent-swarm] ${name} tick failed: ${String(error)}\n`) } catch { /* next tick retries durable state */ }
    }
  }
  /**
   * R15-F2, deleted by R17-G7: `reconcileMemberStatus` used to upgrade a stale
   * `idle` member row to `working` whenever the row fell behind the live attempt,
   * and its upgrade-only rule existed because the member row was part of the
   * board fingerprint (a spurious downgrade re-armed the coverage/stall notices).
   * The status is now derived on every read from the durable phase and the live
   * attempts (`src/projection.ts`), so there is no mirror to reconcile and no
   * write that could churn F(S): the seam is impossible by construction. The
   * guards it used to co-fire with are now the readers of the same derivation:
   * the W6 idle close-out (which owns the attempt until it fences it), the
   * parked-member hatch (`memberPhaseOf === 'parked'`, which wins over work in
   * flight) and the coverage / stall notices (whose F(S) key no status write can
   * move any more).
   */

  /**
   * R15-A2: decision generation that does not depend on a scheduling pass
   * finishing. For every active mission whose pass is not live — no pass body
   * queued or running inside its declared bound — the same classifier the pass
   * uses (`ensureWitness`:
   * `stallRoots`, `waitsLegitimately`, the W3 stall predicate) is run with
   * `offPass: true`.
   *
   * The `offPass` flag suppresses only the dispatcher's "ready but not
   * dispatched" question, which is meaningless before a pass has run; every
   * other class (a stall root, a fall-through, an unreviewable submission, a W3
   * stall) is derived from durable rows and is identical off-pass.
   *
   * Co-firing guards: `openPass`/`livePass` (a live pass owns generation, so the
   * sweep stays out of its way), `kick` (which opens the next pass in the same
   * tick, after this sweep), the pass watchdog (which names a wedged pass that
   * still holds the mission queue — exactly the state this sweep exists for)
   * and the notice dedup (`hasNotice` / the mission witness), which keeps a
   * second generation path from duplicating a decision.
   */
  private sweepDecisions(): void {
    if (this.closed || this.shuttingDown) return
    for (const mission of this.store.list('missions')) {
      if (this.closed || this.shuttingDown) return
      for (const task of this.store.list('tasks', mission.id)) if (stopPending(task)) this.attempts.resumeStoppedAttempt(mission.id, task)
      if (mission.status === 'blocked') { this.notices.absenceNet(mission.id); continue }
      if (terminal(mission) || mission.status !== 'active') continue
      try {
        // R17-G7: no member-status reconciliation runs here any more. Every
        // reader derives the status from the durable phase and the live attempts
        // (`src/projection.ts`), so the sweep describes the same board the
        // dispatch path acts on without a write in between. Co-firing guards the
        // deleted write used to name are now readers of that one derivation: the
        // W6 idle close-out, the parked-member hatch and the coverage/stall
        // notices, whose F(S) key no status write can move.
        // R16-D: the attempt reporting bound runs BEFORE the pass guard below, so
        // an attempt that has stopped reporting is named whether the pass is
        // running, wedged or absent. Co-firing guards: F1's operation silence
        // (skipped while an operation is recorded — that guard owns the clock),
        // the W6 idle close-out (skipped for the attempt it is already nudging),
        // the parked member, the budget pause, the wedged-pass watchdog in
        // `checkSchedulingPasses` (same tick, earlier) and the notice dedup key.
        this.scheduling.sweepSilentAttempts(mission.id)
        // R15-D1/D2: the sweep runs when the pass is WEDGED past its declared
        // bound even though `livePass` still owns generation because the mission
        // has live work (a healthy sibling's lease, or a stop acknowledgement in
        // flight). A sibling's clock must not own another subject's decision: the
        // classifier below names only what no live path advances. When the pass is
        // merely inside its bound the sweep stays out of its way, and when no pass
        // exists at all the next kick opens one in this same tick.
        // R17-G5: the sampled tick path emits exactly two absence instruments and
        // no cause — the attempt-silence escalation above (`sweepSilentAttempts`,
        // bounded by `attemptSilenceBoundMs`) and the absence net here (the
        // absence of a durable transition and the elapsed clock, bounded by
        // `Notices.absenceBoundMs`). Cause-bearing generation is
        // transition-driven (see `commit`), so no sampled tick can invent a cause
        // from a state it only sampled.
        this.notices.absenceNet(mission.id)
      } catch (error) {
        // A sweep must never break the tick that carries the outbox pump and the
        // wedge detector; the next tick re-derives the same state.
        if (!this.closed) process.stderr.write(`[agent-swarm] decision sweep failed: ${String(error)}\n`)
      }
    }
  }
  /**
   * Serialize workspace effects as well as store writes. A bounded wait may
   * refuse a caller, but cannot release its still-running predecessor: task CAS
   * cannot undo a checkout already performed by overlapping preparations.
   */
  async exclusive<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(missionId)
    // The tail of THIS call is registered before the first await, so a later
    // caller chains onto this call instead of onto the same predecessor. The
    // read-await-write shape this replaced let two callers that both waited on
    // one predecessor each become the tail and run their bodies CONCURRENTLY
    // (the fork found in the 2026-09-11 review): dispatch and swarm_claim could
    // interleave per-member workspace preparation, and mission/member/delivery
    // rows have no compare-and-swap to lose an update safely.
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    // Waiters share the identity of the physical head, not their own queue
    // slot. Only a body that actually starts changes it, so unrelated writes
    // cannot repeat the same warning and a later hang gets its own notice.
    const operation = previous?.operation ?? { id: id('operation') }
    const current = Object.assign(previous === undefined ? released : previous.catch(() => {}).then(() => released), { operation })
    this.queues.set(missionId, current)
    void current.then(() => { if (this.queues.get(missionId) === current) this.queues.delete(missionId) })
    try {
      if (previous !== undefined) await this.boundedQueueWait(previous)
      operation.id = id('operation')
      return await fn()
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[mission_operation_pending]')) {
        emitGuardTerminal(this, missionId, 'workspace', { localKey: `mission-operation-pending:${operation.id}`, detail: error.message })
      }
      throw error
    } finally {
      release()
    }
  }
  /** Wait for the mission-queue predecessor, but never past the declared bound. */
  private async boundedQueueWait(previous: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        previous.catch(() => {}),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('[mission_operation_pending] A previous mission operation is still in flight; this request made no changes. Inspect the pending operation with swarm_observe and retry after it returns. Other missions and owner controls remain available.')), this.stallPassTimeoutMs)
          timer.unref()
        }),
      ])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  commit<T>(missionId: string, fn: () => T): T {
    if (this.closed) throw new PolicyError('runtime_closed', 'conflict_error', 'Swarm runtime is closed')
    this.commitDepth += 1
    let result: T
    try { result = this.store.transaction(() => {
      const value = fn()
      const clocked = this.store.get('missions', missionId)
      if (clocked?.executionTime !== undefined) {
        const running = clocked.status === 'active' && !clocked.budgetPause && this.store.list('tasks', missionId).some(task => {
          if (task.status !== 'running' || task.attempt === undefined) return false
          const member = this.store.get('members', task.attempt.ownerId)
          return member?.activity !== undefined || this.workers.isIdle?.(task.attempt.ownerId) !== true
        })
        if (running !== (clocked.executionTime.since !== undefined)) { executionClock(clocked, running); this.store.put('missions', clocked) }
      }
      return value
    }) } finally { this.commitDepth -= 1 }
    for (const listener of this.listeners) { try { listener(missionId) } catch { /* A UI subscriber cannot roll back committed work. */ } }
    // R17-G5: and it publishes its decision facts in the same transition — the
    // classifier runs here (never from the tick sample), against the state this
    // commit produced. The pass state selects the one pass-end branch; a wedged
    // pass keeps its own subject. Reentrant commits are ignored by the guard.
    this.notices.transition(missionId)
    return result
  }
  /** Subscribe to committed state changes. */
  subscribe(listener: (missionId: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
/**
   * R17-G6: the derived member board — the read face the guard model and the
   * owner/UI views consume, and the ONLY one: the single derivation
   * (`src/projection.ts`) applied to the durable rows. It used to prefer a host
   * projection unit's published state, but that unit published the board as a
   * plugin-owned session event the host's format cannot read back (see the
   * module header of `src/projection.ts`), so the unit is gone and the
   * derivation is the read face on every composition. Unlike `missionBoard` it
   * needs no mission row, so the guard model can project a board whose mission
   * is not (or no longer) in the store.
   */
  memberBoard(missionId: string): MissionBoardMember[] {
    return deriveMemberBoard(this.store.list('members', missionId), this.store.list('tasks', missionId))
  }
  /**
   * R17-G6: the durable member rows with the board's derived status merged in —
   * the one place `snapshot()` and `observe()` take member statuses from, so the
   * owner/UI read face is an instance of the projection being read rather than a
   * second derivation. The rows themselves stay the durable records (name, role,
   * subscriptions, activity); only the derived status comes from the board.
   */
  private projectedMembers(missionId: string): Member[] {
    const board = this.memberBoard(missionId)
    const status: Record<string, MemberStatus> = {}
    for (const member of board) status[member.id] = member.status
    return this.store.list('members', missionId).map(member => ({ ...member, status: status[member.id] ?? member.status }))
  }
  mission(missionId: string): Mission {
    const mission = this.store.get('missions', missionId)
    if (!mission) throw new PolicyError('mission_unknown', 'validation_error', 'Unknown mission')
    if (mission.executionTime !== undefined && !terminal(mission)) executionClock(mission, mission.executionTime.since !== undefined)
    return mission
  }
  participant(actor: Actor, missionId: string): { mission: Mission; member?: Member; key: string; owner: boolean } {
    const mission = this.mission(missionId)
    if (mission.ownerSessionId === actor.sessionId) return { mission, key: 'owner', owner: true }
    const member = this.store.list('members', missionId).find(m => m.sessionId === actor.sessionId && memberPhaseOf(m) !== 'stopped')
    if (!member) throw new PolicyError('mission_participant_required', 'authorization_error', 'Session is not a participant in this mission')
    return { mission, member, key: member.id, owner: false }
  }
  active(actor: Actor, missionId: string, allowStaged = false) {
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    actor.signal?.throwIfAborted()
    const participant = this.participant(actor, missionId)
      if (participant.mission.status !== 'active' && !(allowStaged && participant.owner && participant.mission.status === 'staged')) throw new PolicyError('mission_not_active', 'tool_error', `Mission is ${participant.mission.status}`)
    if (participant.mission.budgetPause) throw new PolicyError('mission_budget_paused', 'budget_error', 'Mission is waiting for budget-pause quiescence and a fresh resume assignment')
    if (participant.mission.status !== 'staged' && Date.now() >= participant.mission.deadline) throw new PolicyError('mission_duration_exhausted', 'budget_error', 'Mission duration budget exhausted')
    return participant
  }
  task(missionId: string, taskId: string): Task {
    const task = this.store.get('tasks', taskId)
    if (!task || task.missionId !== missionId) throw new PolicyError('task_not_in_mission', 'validation_error', 'Task is not in this mission')
    return task
  }
  /**
   * Follow repair lineage from a referenced dependency to the task that now
   * carries its obligations. A blocked or cancelled task replaced by a live
   * repair resolves to that repair, recursively; the original identity in a
   * dependent's `dependencies` therefore keeps working after replacement.
   */
  private lineage(missionId: string, dependencyId: string, tasks = this.store.list('tasks', missionId), graph = taskGraphIndex(tasks)): Task[] {
    const chain = graph.lineage(dependencyId)
    if (!chain.length) throw new PolicyError('task_not_in_mission', 'validation_error', 'Task is not in this mission')
    return chain
  }
  /** Effective prerequisites for workspace preparation; one accepted repair covering several originals is merged once. */
  effectiveDependencies(missionId: string, task: Task): Task[] {
    if (!task.dependencies.length) return []
    const tasks = this.store.list('tasks', missionId), graph = taskGraphIndex(tasks)
    const seen = new Set<string>()
    return task.dependencies.map(dep => this.lineage(missionId, dep, tasks, graph).at(-1)!).filter(dependency => !seen.has(dependency.id) && seen.add(dependency.id))
  }
  effectiveDependency(missionId: string, dependencyId: string, tasks?: Task[]): Task { return this.lineage(missionId, dependencyId, tasks).at(-1)! }
  dependencySatisfied(missionId: string, dependencyId: string, tasks?: Task[]): boolean { return this.effectiveDependency(missionId, dependencyId, tasks).status === 'accepted' }
  /**
   * A repair redirects existing dependencies, so even a fresh task can close a
   * cycle. Validate its prospective effective graph before writing anything.
   * Review edges stay pinned to their exact source, as they do in the scheduler;
   * completed and abandoned rows keep their history without retaining wait edges.
   * Every newly introduced cycle must be reachable from the candidate, so an
   * unrelated legacy defect cannot prevent the owner from admitting a repair.
   */
  private assertEffectiveTaskGraph(missionId: string, candidate: Task, tasks: Task[]): void {
    const rows = [...tasks, candidate]
    const index = taskGraphIndex(rows)
    const graph: TaskGraphNode[] = []
    const seen = new Set<string>()
    const pending = [candidate.id]
    while (pending.length) {
      const taskId = pending.pop()!
      if (seen.has(taskId)) continue
      seen.add(taskId)
      const task = index.byId.get(taskId)
      if (task === undefined) continue // The shared validator reports the dangling edge.
      const waiting = ['pending', 'running', 'submitted'].includes(task.status) || this.quiescencePending(task)
      const dependencies = waiting ? task.dependencies.map(dependency => this.lineage(missionId, dependency, rows, index).at(-1)!.id) : []
      const reviewOf = waiting ? task.reviewOf : undefined
      graph.push({ id: task.id, dependencies, ...(reviewOf === undefined ? {} : { reviewOf }) })
      pending.push(...dependencies, ...(reviewOf === undefined ? [] : [reviewOf]))
    }
    const defects = taskGraphDefects(graph)
    if (defects.length) throw new TaskGraphAdmissionError(defects)
  }
  /**
   * R16-A: whether a dependency reference still has a live path. `dependencySatisfied`
   * answers the dispatcher's question ("may the dependent start?"); this answers the
   * notice classifier's ("can the obligation still advance?"). Both read the same
   * `lineage`, so an owner decision and the dispatcher cannot disagree about a
   * dependency whose original row is cancelled or blocked but whose repair is live.
   *
   * A dependency is unfinished exactly when its EFFECTIVE carrier is neither
   * accepted (done) nor cancelled without a live repair (dead). A missing row is
   * not a live path: the classifier must escalate a dangling reference, never throw.
   *
   * Co-fires with: `dependencySatisfied` (a satisfied dependency is never waiting),
   * the stall-root classifier (a blocked effective dependency is the ROOT's subject,
   * and `dependentsOf` enumerates this dependent beside it) and
   * `unfinishedDependencies` below (one repair carrying several originals is
   * counted once).
   */
  dependencyUnfinished(missionId: string, dependencyId: string, tasks?: Task[]): boolean {
    const rows = tasks ?? this.store.list('tasks', missionId)
    if (!rows.some(task => task.id === dependencyId)) return false
    const effective = this.effectiveDependency(missionId, dependencyId, rows)
    return effective.status !== 'accepted' && effective.status !== 'cancelled'
  }
  /**
   * R16-A: the EFFECTIVE unfinished prerequisites of one task, deduplicated in
   * reference order. This is the one seam the waking classifier reads, so a notice
   * and the scheduler resolve a replaced dependency through the same lineage.
   */
  unfinishedDependencies(missionId: string, task: Task, tasks?: Task[]): Task[] {
    if (!task.dependencies.length) return []
    const rows = tasks ?? this.store.list('tasks', missionId)
    const graph = taskGraphIndex(rows)
    const seen = new Set<string>()
    const unfinished: Task[] = []
    for (const dependency of task.dependencies) {
      const effective = graph.effective(dependency)
      if (effective === undefined || effective.status === 'accepted' || effective.status === 'cancelled') continue
      if (seen.has(effective.id)) continue
      seen.add(effective.id)
      unfinished.push(effective)
    }
    return unfinished
  }
  /** Every identity a dependency reference stands for, including the current effective repair. */
  dependencyIdentities(missionId: string, dependencyId: string, tasks?: Task[]): Set<string> { return new Set(this.lineage(missionId, dependencyId, tasks).map(task => task.id)) }
  // M1a: lease/attempt accounting lives in src/attempts.ts; these forwarders keep
  // the call sites unchanged.
  private ownAttempt(actor: Actor, missionId: string, taskId: string, attemptId: string): { task: Task; member: Member } { return this.attempts.ownAttempt(actor, missionId, taskId, attemptId) }
  private fenceAttempt(mission: Mission, task: Task, windowMs: number): void { return this.attempts.fenceAttempt(mission, task, windowMs) }
  dropAttempt(task: Task, ownerId?: string): void { return this.attempts.dropAttempt(task, ownerId) }
  private onIdle(memberId: string): void { return this.attempts.onIdle(memberId) }
  async closeOutIdleAttempt(mission: Mission, member: Member, task: Task): Promise<void> { return this.attempts.closeOutIdleAttempt(mission, member, task) }
  /** The task plus every task it replaces transitively; a repair may only supersede its own lineage. */
  private replacementLineage(missionId: string, task: Task): Set<string> {
    const tasks = this.store.list('tasks', missionId)
    const seen = new Set<string>([task.id])
    for (let frontier = [task]; frontier.length;) {
      const next: Task[] = []
      for (const item of frontier) for (const replacedId of item.replaces ?? []) {
        if (seen.has(replacedId)) continue
        seen.add(replacedId)
        const replaced = tasks.find(candidate => candidate.id === replacedId)
        if (replaced) next.push(replaced)
      }
      frontier = next
    }
    return seen
  }
  
  
  
  
  
  
  
  /**
   * S6: critical-path accounting. The longest chain of dependent steps is read
   * from the durable task graph and reported next to the mission's total spend,
   * so a worker that does not shorten the longest branch earns nothing. A
   * malformed graph (a missing dependency row or a cycle) cannot throw: the
   * offending edge contributes no length. Pure accounting — no budget
   * enforcement reads this number.
   */
  criticalPath(missionId: string): CriticalPath {
    const tasks = this.store.list('tasks', missionId)
    const byId = new Map(tasks.map(task => [task.id, task]))
    const chains = new Map<string, string[]>()
    const visit = (id: string, open: Set<string>): string[] => {
      const cached = chains.get(id)
      if (cached !== undefined) return cached
      const task = byId.get(id)
      if (task === undefined || open.has(id)) return []
      open.add(id)
      let best: string[] = []
      for (const dependency of task.dependencies) {
        const chain = visit(dependency, open)
        if (chain.length > best.length) best = chain
      }
      open.delete(id)
      const composed = [...best, id]
      chains.set(id, composed)
      return composed
    }
    const remainingOf = (chain: string[]): number => chain.filter(id => {
      const task = byId.get(id)
      return task !== undefined && task.status !== 'accepted' && task.status !== 'cancelled'
    }).length
    let chain: string[] = []
    for (const task of tasks) {
      const candidate = visit(task.id, new Set())
      // Longest first; among equal lengths the chain with more open work is the
      // one a worker can still shorten, so it is the one reported.
      if (candidate.length > chain.length || (candidate.length === chain.length && remainingOf(candidate) > remainingOf(chain))) chain = candidate
    }
    const chainTasks = chain.map(id => byId.get(id)).filter((task): task is Task => task !== undefined)
    return {
      length: chain.length,
      remaining: remainingOf(chain),
      usedSteps: chainTasks.reduce((total, task) => total + (task.usedSteps ?? 0), 0),
      taskIds: chain,
    }
  }
  /**
   * Read-only owner instruments (docs/no-silent-state-spec.md §6): the current
   * fingerprint, the last witness class and time, the pending-dispatchable
   * count, the notice-delivery ledger and durable escalations. `full` adds the
   * per-member arena rows and the ledger page; the compact form keeps the
   * owner's routine observe response small. A pure projection of durable
   * records; it writes nothing.
   */
  
  
  
  
  
  
  /** Create a mission with explicitly bounded resources and scope. */
  create(actor: Actor, input: CreateMissionInput, initial: { id?: string; status?: 'active' | 'staged' } = {}): Mission {
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    if (this.store.list('members').some(m => m.sessionId === actor.sessionId)) throw new PolicyError('worker_cannot_own_mission', 'authorization_error', 'Workers cannot create independent missions or budgets')
    requireText(input.title, 'title'); requireText(input.objective, 'objective')
    if (!isAbsolute(input.workspace)) throw new PolicyError('workspace_not_absolute', 'validation_error', 'workspace must be an absolute path')
    requireStrings(input.scope, 'scope'); requireStrings(input.acceptance, 'acceptance')
    const authorized = this.assertAuthorizedRoot(input.workspace, input.workspaceGrantRoot, input.workspaceAuthorizationSource)
    input = { ...input, scope: normalizeScopeSelectors(input.scope) }
    assertScopeSelectors(input.scope, 'scope')
    const budget = validatedBudget(input.budget)
    const now = Date.now()
    if (!Number.isSafeInteger(now + budget.maxDurationMs)) throw new PolicyError('mission_duration_invalid', 'validation_error', 'Mission duration exceeds the supported clock range')
    const mission: Mission = { ...input, workspaceGrantRoot: authorized.grantRoot, workspaceAuthorizationSource: authorized.source, budget, id: initial.id ?? id('mission'), ownerSessionId: actor.sessionId, status: initial.status ?? 'active', usedTokens: 0, usedSteps: 0, createdAt: now, updatedAt: now, executionTime: { usedMs: 0 }, deadline: Math.min(budget.deadlineAt ?? Number.MAX_SAFE_INTEGER, now + budget.maxDurationMs) }
    if (this.store.get('missions', mission.id)) throw new PolicyError('mission_identity_conflict', 'conflict_error', 'Mission already exists')
    this.commit(mission.id, () => {
      this.store.put('missions', mission)
      this.store.event(mission.id, 'mission/created', 'owner', mission)
      // The durable audit of where the authorization came from: the matched
      // root and the resolved workspace path, recorded with the mission.
      this.store.event(mission.id, 'mission/workspace-bound', 'owner', { workspace: mission.workspace, grantRoot: mission.workspaceGrantRoot, source: mission.workspaceAuthorizationSource })
    })
    return mission
  }
  /**
   * Owner-only membership admission keeps authority and aggregate capacity bounded.
   *
   * R17-G12: `name` is optional. When the caller supplies none the runtime
   * assigns the next unused name from the fixed `WORKER_NAME_POOL` in assignment
   * order, considering every member row of the mission — a stopped member's name
   * is never reused while the mission is active. `role` keeps the responsibility
   * text unchanged and the member id stays the only address, so nothing in the
   * protocol depends on a display name.
   */
  async addMember(actor: Actor, missionId: string, input: { name?: string; role: string; model?: string; provider?: string; reasoningEffort?: string; maxOutputTokens?: number; subscriptions?: string[] }, admittedId?: string): Promise<Member> {
    const automatic = admittedId ? this.store.list('starts', missionId)[0] : undefined
    const assertAdmissionCurrent = () => {
      actor.signal?.throwIfAborted()
      const current = automatic ? this.store.get('starts', automatic.id) : undefined
      if (current && ((current.planningEpoch ?? 1) !== (automatic!.planningEpoch ?? 1)
        || current.planningFenced || current.status === 'failed' || current.status === 'stopped')) throw new PolicyError('plan_assembly_interrupted', 'conflict_error', 'Plan assembly was interrupted')
    }
    return this.exclusive(missionId, async () => {
      const { mission, owner } = this.active(actor, missionId, admittedId !== undefined)
      assertAdmissionCurrent()
      if (!owner) throw new PolicyError('member_owner_required', 'authorization_error', 'Only the mission owner can add workers; send a bounded collaborator request')
      if (input.name !== undefined) requireText(input.name, 'name'); requireText(input.role, 'role')
      for (const field of ['provider', 'model', 'reasoningEffort'] as const) if (input[field] !== undefined) requireText(input[field]!, field)
      if (input.provider && !input.model) throw new PolicyError('member_model_required', 'validation_error', 'A selected provider requires a selected model')
      if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)) throw new PolicyError('member_output_tokens_invalid', 'validation_error', 'maxOutputTokens must be a positive safe integer')
      // M9 residual: topic matching is exact array membership. A bare string
      // would silently become String.includes substring semantics, so the
      // runtime validates its own boundary instead of trusting the caller.
      if (input.subscriptions !== undefined && (!Array.isArray(input.subscriptions) || input.subscriptions.some(topic => typeof topic !== 'string' || !topic.trim()))) throw new PolicyError('member_subscriptions_invalid', 'validation_error', 'subscriptions must be a string array')
      if (this.store.list('starts', missionId).length && input.maxOutputTokens === undefined) throw new PolicyError('member_output_tokens_required', 'tool_error', 'Automatic workers require maxOutputTokens chosen by the primary agent')
      const prior = admittedId ? this.store.get('members', admittedId) : undefined
      if (prior) {
        if (prior.missionId !== missionId || (input.name !== undefined && prior.name !== input.name) || memberPhaseOf(prior) === 'stopped') throw new PolicyError('member_identity_conflict', 'conflict_error', 'Member admission identity conflict')
        await this.startWorker(mission, prior, { admission: true, signal: actor.signal })
        assertAdmissionCurrent()
        return prior
      }
      const members = this.store.list('members', missionId)
      if (members.filter(m => memberPhaseOf(m) !== 'stopped').length >= mission.budget.maxWorkers) throw new PolicyError('mission_worker_budget_exhausted', 'budget_error', 'Mission worker budget exhausted')
      // R17-G12: a name-less admission takes the next unused pool name in
      // assignment order; the pool is the bound, and its exhaustion is a named
      // refusal that names the caller's own exit rather than an anonymous failure.
      const name = input.name ?? nextWorkerName(members.map(member => member.name))
      if (name === undefined) throw new PolicyError('worker_name_pool_exhausted', 'budget_error', '[worker_name_pool_exhausted] The fixed worker-name pool has no unused name left Supply an explicit `name` with `swarm_add_member` and retry, or admit this worker into a new mission.')
      if (members.some(m => m.name === name)) throw new PolicyError('worker_name_conflict', 'conflict_error', 'Worker name already exists')
      const memberId = admittedId ?? id('member')
      // Re-validate before the first filesystem effect of this mission.
      await this.assertWorkspaceAuthorized(mission)
      assertAdmissionCurrent()
      if (!mission.baseline && this.workers.prepareBaseline) {
        const baseline = await this.workers.prepareBaseline(mission, actor.signal)
        assertAdmissionCurrent()
        const current = this.active(actor, missionId, admittedId !== undefined).mission
        current.baseline = baseline; mission.baseline = baseline
        this.commit(missionId, () => { this.store.put('missions', current); this.store.event(missionId, 'workspace/snapshot', 'runtime', baseline) })
      }
      const workspace = await this.workers.prepareWorkspace(mission, memberId)
      assertAdmissionCurrent()
      this.active(actor, missionId, admittedId !== undefined)
      // R17-G7: the durable row carries the phase; the in-memory record carries the
      // derivation's own output (a fresh active member owns no attempt), and the
      // store strips that status on write, so admission leaves no live fact behind.
      const member: Member = { id: memberId, missionId, name, role: input.role, model: input.model, provider: input.provider, reasoningEffort: input.reasoningEffort, maxOutputTokens: input.maxOutputTokens, sessionId: id('swarm-session'), workspace, phase: 'active', status: deriveMemberStatus('active', false), subscriptions: input.subscriptions === undefined ? [] : [...new Set(input.subscriptions)] }
      // The durable record and the historical event carry the phase only: the
      // derived status is never persisted, not even as an event snapshot.
      const { status: _derivedStatus, ...memberRecord } = member
      this.commit(missionId, () => { this.store.put('members', member); this.store.event(missionId, 'member/added', 'owner', memberRecord) })
      try { await this.startWorker(mission, member, { admission: true, signal: actor.signal }); assertAdmissionCurrent() }
      catch (error) {
        assertAdmissionCurrent()
        if (this.shuttingDown || this.mission(missionId).status !== 'active') throw error
        // W8: a provider that rejects the requested reasoning effort must not
        // leave a stopped member behind with an untyped provider error. Retry
        // once on the provider default and record the downgrade; if the route is
        // still rejected, refuse admission with the requested value and the exit.
        const rejection = unsupportedEffort(error)
        if (rejection !== undefined && member.reasoningEffort !== undefined) {
          const requested = member.reasoningEffort
          const fallback: Member = { ...member }
          delete fallback.reasoningEffort
          try {
            // A rejected option is a completed native attempt; this explicit fallback is a new one.
            this.workerStarts.delete(member.id)
            await this.startWorker(mission, fallback, { admission: true, signal: actor.signal })
            assertAdmissionCurrent()
            delete member.reasoningEffort
            this.commit(missionId, () => {
              const latest = this.store.get('members', member.id)
              if (latest === undefined) throw new Error('Worker admission disappeared')
              delete latest.reasoningEffort
              this.store.put('members', latest)
              this.store.event(missionId, 'member/effort-downgraded', 'runtime', { memberId, requested, rejected: rejection.requested ?? requested, reason: rejection.message })
            })
            this.kick(missionId)
            return member
          } catch (retryError) {
            assertAdmissionCurrent()
            if (this.shuttingDown || this.mission(missionId).status !== 'active') throw retryError
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
            member.phase = 'stopped'
            this.commit(missionId, () => {
              const latest = this.store.get('members', member.id)
              if (latest !== undefined) { latest.phase = 'stopped'; this.store.put('members', latest) }
              this.store.event(missionId, 'member/failed', 'runtime', { memberId, error: rejection.message })
              this.store.event(missionId, 'member/effort-rejected', 'runtime', { memberId, requested, rejected: rejection.requested ?? requested, error: rejection.message, retryError: retryMessage })
            })
            // The adapter's rejection text can name gateway hosts and internal
            // route codes, so it stays in the durable events above. The refusal
            // is built from the route this runtime holds, in the adapter's
            // canonical shape, so a canonical rejection renders the same bytes.
            const route = (field: string, value: string | undefined) => `${field} ${value === undefined ? '(inherited)' : `"${value}"`}`
            throw new PolicyError('member_reasoning_effort_unsupported', 'tool_error', `Member ${name} cannot start: ${route('provider', member.provider)} ${route('model', member.model)} does not support reasoning effort "${rejection.requested ?? requested}". Clearing reasoningEffort did not help; admit a replacement member without reasoningEffort, or with an effort this provider/model supports.`)
          }
        }
        member.phase = 'stopped'
        this.commit(missionId, () => { const latest = this.store.get('members', member.id); if (latest !== undefined) { latest.phase = 'stopped'; this.store.put('members', latest) }; this.store.event(missionId, 'member/failed', 'runtime', { memberId, error: String(error) }) })
        throw error
      }
      this.kick(missionId)
      return member
    })
  }
  /** Any participant may establish an in-scope workstream. */
  workstream(actor: Actor, missionId: string, input: { title: string; objective: string; coordinatorId?: string }, admittedId?: string): Workstream {
    const { key } = this.active(actor, missionId, admittedId !== undefined)
    const prior = admittedId ? this.store.get('workstreams', admittedId) : undefined
    if (prior) { if (prior.missionId !== missionId) throw new PolicyError('workstream_identity_conflict', 'conflict_error', 'Workstream identity conflict'); return prior }
    requireText(input.title, 'title'); requireText(input.objective, 'objective')
    if (input.coordinatorId && !this.store.list('members', missionId).some(m => m.id === input.coordinatorId && memberPhaseOf(m) !== 'stopped')) throw new PolicyError('coordinator_invalid', 'validation_error', 'Unknown coordinator')
    const stream: Workstream = { ...input, id: admittedId ?? id('stream'), missionId }
    if (this.store.list('workstreams', missionId).length >= this.mission(missionId).budget.maxTasks) throw new PolicyError('workstream_budget_exhausted', 'budget_error', 'Workstream admission budget exhausted')
    this.commit(missionId, () => { this.store.put('workstreams', stream); this.store.event(missionId, 'workstream/created', key, stream) })
    return stream
  }
  /** Distributed task proposals are admitted by deterministic scope, budget and dependency rules. */
  propose(actor: Actor, missionId: string, input: ProposeTaskInput, admittedId?: string): Task {
    const { mission, key, owner } = this.active(actor, missionId, admittedId !== undefined)
    const prior = admittedId ? this.store.get('tasks', admittedId) : undefined
    if (prior) {
      if (prior.missionId !== missionId) throw new PolicyError('task_identity_conflict', 'conflict_error', 'Task identity conflict')
      // F7: launchDraft retries with deterministic ids. A withdrawn record must
      // never be silently re-admitted, or a mission can activate with dead work.
      if (prior.status === 'cancelled') throw new PolicyError('task_cancelled_readmission', 'tool_error', `Task ${prior.id} was cancelled by the owner; a cancelled record cannot be re-admitted. Propose a new task, or a repair with a new id.`)
      // Round 9-C: a re-submission that changes a check the task already
      // declared is recorded durably. The stored record keeps its original
      // check, so a retry can never silently swap it for a weaker or
      // host-specific one. Filling in a check the task never declared is not a
      // change and emits nothing.
      if (Array.isArray(input.checks) && prior.checks.length > 0 && !sameChecks(input.checks, prior.checks)) {
        this.commit(missionId, () => this.store.event(missionId, 'task/check-changed', key, {
          taskId: prior.id, sourceTaskId: prior.id, reason: 'resubmission', previousChecks: [...prior.checks], checks: [...input.checks as string[]],
        }))
      }
      return prior
    }
    // A worker repair's policy origin indexes `replaces` before any field is
    // checked, and the inherited acceptance iterates it: a malformed list is
    // refused here, typed, before either reads it.
    if (input.replaces != null && (!Array.isArray(input.replaces) || !input.replaces.every(previousId => typeof previousId === 'string' && previousId.trim() !== ''))) throw new PolicyError('task_replaces_invalid', 'validation_error', '[task_replaces_invalid] `replaces` must list task ids. Pass `replaces` as an array of the blocked or cancelled task ids this repair replaces with `swarm_propose`, or omit it for new work, then retry.')
    if (this.store.list('starts', missionId).length) {
      if (!owner) {
        // Workers may extend the board but cannot enlarge execution policy set
        // by the primary agent. Follow the source/repair/prerequisite lineage.
        const reference = input.reviewOf ?? input.replaces?.[0] ?? input.dependencies?.[0]
        const origin = reference ? this.task(missionId, reference) : this.store.list('tasks', missionId)[0]
        const source = origin?.reviewOf ? this.task(missionId, origin.reviewOf) : origin
        input = { ...input, maxRecoveryAttempts: origin?.maxRecoveryAttempts,
          checkTimeoutMs: origin?.checkTimeoutMs ?? source?.checkTimeoutMs,
          maxSteps: input.maxSteps ?? origin?.maxSteps, maxFindings: input.maxFindings ?? origin?.maxFindings,
          ceilingProvenance: {
            maxSteps: input.maxSteps == null ? origin?.ceilingProvenance?.maxSteps : input.ceilingProvenance?.maxSteps,
            maxFindings: input.maxFindings == null ? origin?.ceilingProvenance?.maxFindings : input.ceilingProvenance?.maxFindings,
          } }
      }
      if (input.maxRecoveryAttempts === undefined) throw new PolicyError('task_recovery_limit_required', 'validation_error', '[task_recovery_limit_required] Automatic tasks require a recovery limit chosen by the primary agent. Pass `maxRecoveryAttempts` as a positive safe integer on this task with `swarm_propose` (or `swarm_launch` for a new plan), then retry the same task.')
      if (input.kind !== 'verification' && input.checks?.length && input.checkTimeoutMs === undefined) throw new PolicyError('task_check_timeout_required', 'validation_error', '[task_check_timeout_required] Automatic task checks require a timeout chosen by the primary agent. Pass `checkTimeoutMs` in milliseconds on this task with `swarm_propose` (or `swarm_launch` for a new plan), then retry the same task.')
    }
    requireText(input.title, 'title'); requireText(input.objective, 'objective')
    if (input.acceptance === undefined && !input.replaces?.length) throw new PolicyError('task_acceptance_required', 'validation_error', '[task_acceptance_required] A new task needs its own acceptance criteria. Pass `acceptance` as nonempty strings with `swarm_propose`, or name the rejected task in `replaces` to inherit its criteria, then retry.')
    // The proposal's own criteria are checked before any replaced task is read;
    // a repair may supply none.
    const proposed = input.acceptance ?? []
    if (!input.replaces?.length || !Array.isArray(proposed) || proposed.length > 0) requireStrings(proposed, 'acceptance')
    if (!['research', 'implementation', 'verification', 'integration'].includes(input.kind)) throw new PolicyError('task_kind_invalid', 'validation_error', 'Unknown task kind')
    requireStrings(input.scope, 'task.scope')
    input = { ...input, scope: normalizeScopeSelectors(input.scope) }
    assertScopeSelectors(input.scope, 'task.scope', mission.scope)
    // `outputs` is the only record of the files a task writes, and the Harness
    // does not enforce a tool schema's `required` list, so admission refuses a
    // new task that declares none rather than storing one that captures and
    // preserves nothing. A repair may omit it to inherit the replaced tasks'
    // declarations, which are read below once those tasks are known to exist.
    if (input.outputs === undefined && !input.replaces?.length) throw new PolicyError('outputs_required', 'validation_error', '[outputs_required] `outputs` is required: a new task must declare the files it writes. Pass `outputs` with `swarm_propose` as the repository-relative files this task writes inside its `scope`, or [] for analysis-only work, then retry.')
    if (input.outputs !== undefined) input = { ...input, outputs: assertDeclaredOutputs(input.outputs, input.scope, 'task', { dependencyDirs: this.config.verificationDependencyDirs }) }
    // A repair inherits the acceptance of every task it replaces: the host holds
    // those obligations, so the proposal never has to copy them. The stored list
    // is each replaced task's criteria in order, then any criteria the proposal
    // adds, without duplicates; the admission guard below reads the same list.
    // The replaced tasks are read only after this proposal's own fields passed,
    // so an unknown `replaces` id never hides a field error.
    const acceptance = input.replaces?.length ? [...new Set([...input.replaces.flatMap(previousId => this.task(missionId, previousId).acceptance), ...proposed])] : proposed
    requireStrings(acceptance, 'acceptance')
    // A repair carries the obligations it replaces: omitting `outputs` inherits
    // every replaced task's declaration, in order and without duplicates like
    // the acceptance above, so a replacement cannot quietly drop a deliverable
    // an original promised. Explicit `outputs` replace the inherited list. The
    // union is still checked against this task's own scope, because a repair
    // may narrow that scope. A repair whose replaced tasks declared nothing has
    // nothing to inherit and must declare.
    if (input.outputs === undefined) {
      const declared = input.replaces!.flatMap(previousId => { const outputs = this.task(missionId, previousId).outputs; return outputs === undefined ? [] : [outputs] })
      if (!declared.length) throw new PolicyError('outputs_required', 'validation_error', '[outputs_required] `outputs` is required: no task in `replaces` declared outputs for this repair to inherit. Pass `outputs` with `swarm_propose` as the repository-relative files this repair writes inside its `scope`, or [] for analysis-only work, then retry.')
      input = { ...input, outputs: assertDeclaredOutputs([...new Set(declared.flat())], input.scope, 'task', { dependencyDirs: this.config.verificationDependencyDirs }) }
    }
    // What the host added beyond the proposal's own list is recorded on the
    // admission event and named in the swarm_propose result, so a criterion the
    // proposal left out is carried visibly, never silently.
    const inheritedCriteria = input.replaces?.length ? inheritedAcceptance(acceptance, input.acceptance) : []
    // D1: the admission refusals (an assumed dependency, a dangling graph edge)
    // at the production admission point, so a plan error is rejected here
    // instead of at submit. The check preflight hints are advisory and belong
    // to the draft UI (`planAdvisories`); nothing here would read them.
    const refused = reconcileTaskAdmission({ objective: input.objective, acceptance }, 'task', {
      // R12-F9: the guard needs the content-carrying edges (the declared
      // dependencies plus a review source, which `prepareTask` merges into the
      // worktree like a dependency) and the durable identities this mission
      // already holds, so the diagnostic can say whether the named content exists
      // here (add the dependency that carries it) or must be obtained (state how).
      dependencies: [...(input.dependencies ?? []), ...(input.reviewOf === undefined ? [] : [input.reviewOf])],
      replaces: input.replaces,
      knownContents: new Set(this.store.list('tasks', missionId).map(task => task.id)),
    })
    if (refused.length) throw new Error(refused.map(formatDiagnostic).join('\n'))
    const stream = this.store.get('workstreams', input.workstreamId)
    if (!stream || stream.missionId !== missionId) throw new PolicyError('workstream_unknown', 'validation_error', 'Unknown workstream')
    const tasks = this.store.list('tasks', missionId)
    if (tasks.length >= mission.budget.maxTasks) {
      // The owner is the only actor who can raise the ceiling; a worker refusal
      // is a decision the owner must see, not just an error in a tool result.
      if (!owner) this.refuseProposal(mission, key, input.title, `mission task budget exhausted (${tasks.length}/${mission.budget.maxTasks} tasks admitted)`, mission.budget.maxTasks)
      // S4b: the ceiling that refuses the owner is a terminal too. The owner's
      // tool result carries the prose; the durable coded decision request makes
      // the refusal a recorded decision with the executable exits (raise the
      // ceiling with swarm_budget, or withdraw work with swarm_cancel).
      emitGuardTerminal(this, missionId, 'task_ceiling', { detail: `mission task budget exhausted (${tasks.length}/${mission.budget.maxTasks} tasks admitted)` })
      throw new PolicyError('mission_task_budget_exhausted', 'budget_error', 'Mission task budget exhausted')
    }
    if (input.experiment && tasks.filter(t => t.experiment).length >= mission.budget.maxExperiments) {
      const used = tasks.filter(t => t.experiment).length
      if (!owner) this.refuseProposal(mission, key, input.title, `mission experiment budget exhausted (${used}/${mission.budget.maxExperiments} experiments admitted)`, mission.budget.maxExperiments)
      emitGuardTerminal(this, missionId, 'task_ceiling', { detail: `mission experiment budget exhausted (${used}/${mission.budget.maxExperiments} experiments admitted)` })
      throw new PolicyError('mission_experiment_budget_exhausted', 'budget_error', 'Mission experiment budget exhausted')
    }
    const dependencies = [...new Set(normalizeReviewDependencies(input.kind, input.reviewOf, input.dependencies))]
    for (const dependency of dependencies) {
      const effective = this.effectiveDependency(missionId, dependency, tasks)
      if (effective.status === 'cancelled' || effective.status === 'blocked') throw new PolicyError('dependency_not_live', 'tool_error', `Dependency ${dependency} is ${effective.status} and has no live replacement; depend on an accepted or in-progress task, or propose a repair with replaces`)
    }
    if (input.assigneeId && !this.store.list('members', missionId).some(m => m.id === input.assigneeId && memberPhaseOf(m) !== 'stopped')) throw new PolicyError('task_assignee_invalid', 'validation_error', 'Unknown assignee')
    if (input.assignmentMode !== undefined && input.assignmentMode !== 'preferred' && input.assignmentMode !== 'pinned') throw new Error('[assignment_mode_invalid] Set `assignmentMode` to preferred or pinned with `swarm_propose`, then retry.')
    if (input.assignmentMode !== undefined && input.assigneeId === undefined) throw new Error('[assignment_member_required] Supply `assigneeId` with `assignmentMode` in `swarm_propose`, then retry.')
    if (input.kind === 'verification') {
      if (!input.reviewOf) throw new PolicyError('verification_review_source_required', 'validation_error', 'Verification requires reviewOf')
      const source = this.task(missionId, input.reviewOf)
      if (source.kind === 'verification') throw new PolicyError('verification_review_source_invalid', 'tool_error', 'Verification cannot review another verification task')
      if (source.status === 'cancelled' || source.status === 'accepted') throw new PolicyError('review_source_not_submitted', 'tool_error', `reviewOf ${source.id}: that task is already ${source.status}; a review can only start on submitted work`)
      const authors = this.authorIds(source)
      if (input.assigneeId !== undefined && authors.has(input.assigneeId)) throw new PolicyError('review_assignee_not_independent', 'validation_error', `assigneeId ${input.assigneeId} authored ${source.id}; an independent review must be assigned to a member who never owned it, or left unassigned`)
    } else if (input.reviewOf) throw new PolicyError('review_source_not_verification', 'tool_error', 'Only verification tasks may set reviewOf')
    // Round 9-C: a repair may keep the original acceptance while changing the
    // declared check. Acceptance is already inherited above; a check
    // change is recorded durably so an owner can see that the new check no
    // longer matches the original obligation. A repair that merely supplies
    // checks the replaced task never declared is not a change.
    const checkChanges: Array<{ replaces: string[]; sourceTaskId: string; previousChecks: string[]; checks: string[] }> = []
    for (const previousId of input.replaces ?? []) {
      const previous = this.task(missionId, previousId)
      if (previous.kind === 'verification') throw new PolicyError('replacement_source_verification', 'budget_error', `replaces ${previousId}: that is a verification task. Repair its reviewed source ${previous.reviewOf ?? ''} instead; when that repair is submitted the runtime detects the missing review and admits an independent verification task automatically once the mission has task budget and a live member who did not author the repair`)
      // Resolve existing live replacements before the status check. The guard
      // must be reachable for exactly the blocked case it was written for: two
      // admitted replacements would make lineage ambiguous and stall every
      // dependent once both are accepted.
      const replacement = taskGraphIndex(tasks).replacementDescendants(previousId).find(task => task.status !== 'cancelled')
      // W12: cancellation is terminal for the withdrawn record, not for the
      // obligation it carried. A cancelled task admits exactly one live repair,
      // exactly like blocked work, so a dependent's lineage can resolve again.
      if (previous.status !== 'blocked' && previous.status !== 'cancelled') {
        const repairable = previous.status === 'pending' || previous.status === 'running' || previous.status === 'submitted'
        const rule = repairable ? 'only blocked or cancelled work can be replaced' : 'only blocked work can be replaced'
        throw new PolicyError('replacement_source_not_blocked', 'tool_error', `replaces ${previousId}: that task is ${previous.status}, and ${rule}${replacement ? `; it is already replaced by ${replacement.id} (${replacement.status})` : repairable ? '; wait for its verdict or use swarm_handoff/challenge' : ''}`)
      }
      if (replacement !== undefined) throw new PolicyError('replacement_already_live', 'tool_error', `replaces ${previousId}: that task is ${previous.status}, and is already replaced by ${replacement.id} (${replacement.status}); wait for its verdict, withdraw it with swarm_cancel, or repair that replacement instead of admitting a second one`)
      if (previous.status !== 'cancelled' && stopPending(previous)) throw new PolicyError('replacement_source_reassigning', 'lease_error', `replaces ${previousId}: that task is being reassigned after a handoff or lease expiry, not blocked for repair; observe again shortly`)
      if (previous.kind !== input.kind) throw new PolicyError('replacement_kind_mismatch', 'tool_error', `replaces ${previousId}: kind mismatch. The blocked task is ${previous.kind}; a replacement must also be ${previous.kind}`)
      if (dependencies.includes(previousId)) throw new PolicyError('replacement_depends_on_source', 'tool_error', `replaces ${previousId}: a repair cannot also depend on the blocked task it replaces`)
      const nextChecks = Array.isArray(input.checks) ? input.checks as string[] : []
      if (previous.checks.length > 0 && !sameChecks(nextChecks, previous.checks)) {
        checkChanges.push({ replaces: [previousId], sourceTaskId: previousId, previousChecks: [...previous.checks], checks: [...nextChecks] })
      }
    }
    // R11-06: classify an `npm run <name>` check by the script body the
    // workspace manifest resolves it to, so a host-only suite cannot hide
    // behind a neutral name. Plan validation (src/plans.ts) keeps the name
    // patterns because it has no workspace manifest.
    requireHostChecks(input.kind, input.checks, 'task', input.title, loadPackageScripts(mission.workspace))
    if (input.maxRecoveryAttempts !== undefined && (!Number.isSafeInteger(input.maxRecoveryAttempts) || input.maxRecoveryAttempts < 1)) throw new PolicyError('task_recovery_limit_invalid', 'validation_error', 'maxRecoveryAttempts must be a positive safe integer')
    if (input.checkTimeoutMs !== undefined && (!Number.isSafeInteger(input.checkTimeoutMs) || input.checkTimeoutMs < 1 || input.checkTimeoutMs > 2147483647)) throw new PolicyError('task_check_timeout_invalid', 'validation_error', 'checkTimeoutMs must be a positive integer within the platform timer range')
    // D1: every admitted task carries its own step/finding ceiling; the runtime
    // blocks the task at that limit instead of letting it drain the mission budget.
    const ceilings = normalizeTaskCeilings(input, mission.budget.maxSteps, 'task')
    const task: Task = { id: admittedId ?? id('task'), missionId, workstreamId: input.workstreamId, title: input.title, objective: input.objective, kind: input.kind, dependencies, scope: input.scope, acceptance, checks: input.checks ?? [], priority: input.priority ?? 50, experiment: input.experiment ?? false, assigneeId: input.assigneeId, reviewOf: input.reviewOf, status: 'pending', epoch: 0, priorOwnerIds: [], proposedBy: key, evidenceIds: [], createdAt: Date.now(), ...ceilings }
    if (input.replaces?.length) task.replaces = [...new Set(input.replaces)]
    // Admission above leaves every new task with a declaration, its own or the
    // one a repair inherited. A row without the field comes only from a store
    // written before `outputs` existed: it reads as [] ("this task writes
    // nothing"), and no output is inferred from its objective or acceptance.
    if (input.outputs !== undefined) task.outputs = [...input.outputs]
    if (input.assigneeId !== undefined) task.plannedAssigneeId = input.assigneeId
    if (input.assignmentMode !== undefined) task.assignmentMode = input.assignmentMode
    if (input.maxRecoveryAttempts !== undefined) task.maxRecoveryAttempts = input.maxRecoveryAttempts
    if (input.checkTimeoutMs !== undefined) task.checkTimeoutMs = input.checkTimeoutMs
    this.assertEffectiveTaskGraph(missionId, task, tasks)
    this.commit(missionId, () => {
      this.store.put('tasks', task)
      this.store.event(missionId, 'task/proposed', key, inheritedCriteria.length ? { ...task, inheritedAcceptance: inheritedCriteria } : task)
      for (const change of checkChanges) this.store.event(missionId, 'task/check-changed', key, { taskId: task.id, reason: 'replacement', ...change })
    })
    this.warnBudget(this.mission(missionId))
    this.warnIntegrationGap(mission, task)
    this.kick(missionId)
    return task
  }
  
  /**
   * X1 (P0): current assignment and every actual prior owner cannot review this
   * work. An unused initial preference is not added to history when borrowed;
   * independence follows actual ownership, not a discarded planning preference.
   */
  authorIds(task: Task): Set<string> {
    const ids = new Set(task.priorOwnerIds ?? [])
    if (task.attempt?.ownerId !== undefined) ids.add(task.attempt.ownerId)
    if (task.assigneeId !== undefined) ids.add(task.assigneeId)
    return ids
  }

  /** ENV: the adapter's measured envelope, widened to the environment facts it also reports. */
  private declaredCheckEnvelope(): DeclaredCheckEnvelope | undefined {
    try { return this.workers.checkEnvelope?.() as DeclaredCheckEnvelope | undefined }
    catch { return undefined } // reporting the environment must never break a delivery or a verdict
  }
  /** ENV: the declared envelope delivered with one attempt's assignment, from the durable delivery. */
  private deliveredCheckEnvironment(missionId: string, taskId: string, attemptId: string): CheckEnvironment | undefined {
    for (const delivery of this.store.list('deliveries', missionId)) {
      if (delivery.kind !== 'assignment' || delivery.taskId !== taskId || delivery.attemptId !== attemptId) continue
      try {
        const content = JSON.parse(delivery.content) as { checkEnvironment?: { environment?: unknown } }
        const environment = content.checkEnvironment?.environment
        if (isDeclaredCheckEnvironment(environment)) return environment
      } catch { /* a delivery without the envelope simply has none */ }
    }
    return undefined
  }
  /**
   * ENV: compare the envelope delivered to one verification attempt with the
   * environment the host recorded on that artifact's declared checks. Both sides
   * are host-measured: the runtime constructs the envelope and runs the declared
   * checks itself, so nothing here is inferred from a member's command text. An
   * attempt with no delivered envelope, or with no host check outcome that
   * carries an environment, has nothing to compare and the verdict proceeds as
   * before.
   */
  private checkEnvironmentReproduction(missionId: string, taskId: string, attemptId: string, checks: ReadonlyArray<{ environment?: CheckEnvironment }>):
    { envelope: CheckEnvironment; selfRun: CheckEnvironment; source: 'host-check'; at: number; comparison: CheckEnvironmentComparison } | undefined {
    if (checks.length === 0) return undefined
    const envelope = this.deliveredCheckEnvironment(missionId, taskId, attemptId) ?? this.declaredCheckEnvelope()?.environment
    if (envelope === undefined) return undefined
    // Declared host checks are the supporting executions. A later unrelated
    // diagnostic cannot substitute its environment for those immutable-artifact checks.
    const measured = checks.find(check => check.environment !== undefined && compareCheckEnvironments(envelope, check.environment).blocking.length > 0)?.environment
      ?? checks.find(check => check.environment !== undefined)?.environment
    if (measured === undefined) return undefined
    return { envelope, selfRun: measured, source: 'host-check', at: Date.now(), comparison: compareCheckEnvironments(envelope, measured) }
  }
  /**
   * ENV: the check environment facts an assignment delivery carries. Public so
   * every module that writes an assignment delivery (the claim path here and the
   * budget-resume path in src/gates.ts) delivers the same envelope: one
   * assignee that is not told the environment is the defect this closes.
   */
  assignmentCheckEnvironment(): { checkEnvironment?: { note: string; environment: CheckEnvironment; selfRun?: CheckEnvironment } } {
    const envelope = this.declaredCheckEnvelope()
    if (envelope?.environment === undefined) return {}
    return { checkEnvironment: {
      note: 'These are the facts the host runs this task\'s declared checks under. Acceptance compares the supporting host checks with this envelope; unrelated diagnostics do not determine the verdict. The scoped cache roots are provided inside the disposable verification checkout; the user cache roots and HOME are what a self-run inherits.',
      environment: envelope.environment,
      ...(envelope.selfRunEnvironment === undefined ? {} : { selfRun: envelope.selfRunEnvironment }),
    } }
  }
  /** ENV: render a blocking mismatch as the refusal the member must act on. */
  private checkEnvironmentMismatchMessage(comparison: CheckEnvironmentComparison, source: string): string {
    const fields = comparison.blocking.map(item => `${item.field}: envelope ${item.envelope}, self-run ${item.selfRun}`).join('; ')
    return `[check_environment_mismatch] This verification's self-run environment (${source}) cannot reproduce the declared-check envelope: ${fields}. Rerun the declared check in the envelope environment, then call \`swarm_verify\` with its \`verdict\` and \`reason\` again; the artifact is not accepted under a different environment.`
  }
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  /** Check before any workspace mutation, and again immediately before assignment. */
  assertAdmission(task: Task, member: Member): { candidate: ReturnType<SwarmRuntime['admissionDecision']>['candidate']; decision: ReturnType<SwarmRuntime['admissionDecision']>['decision']; latencyMs: number } {
    if (pendingStopOwner(this.store.list('tasks', task.missionId), member.id)) throw new Error('Worker is waiting for its previous attempt to stop')
    member = this.store.get('members', member.id) ?? member
    const mission = this.mission(task.missionId)
    this.recordWriterBusyRecovery(mission)
    const started = performance.now()
    const { candidate, decision } = this.admissionDecision(mission, member, task)
    const latencyMs = Math.max(0, Math.round((performance.now() - started) * 1000) / 1000)
    if (!decision.admitted) {
      this.recordRefusal(candidate, decision, latencyMs)
      throw new AdmissionRefusedError(decision)
    }
    return { candidate, decision, latencyMs }
  }
  assign(task: Task, member: Member): Task {
    member = this.store.get('members', member.id) ?? member
    const mission = this.mission(task.missionId)
    const { candidate, decision, latencyMs } = this.assertAdmission(task, member)
    if (canBorrowTask(task)) task.plannedAssigneeId = member.id
    task.epoch++
    task.attempt = { id: id('attempt'), epoch: task.epoch, ownerId: member.id, leaseUntil: Math.min(Date.now() + this.config.leaseMs, mission.deadline) }
    if (task.reviewOf) task.attempt.sourceCommit = this.task(task.missionId, task.reviewOf).artifact?.commit
    // R17-G7: assigning the attempt is what makes the derived status `working`;
    // there is no member status to write and none to fall behind the attempt.
    task.status = 'running'; task.assigneeId = member.id
    // Close-out and git-denial markers belong to one attempt; a new attempt starts clean.
    delete task.closeout; delete task.idleSignal; delete task.gitWriteDenied
    // A recorded preparation failure outlives this successful preparation: its
    // `attempts` counter bounds transient retries across re-pends that spend
    // no recovery credit (a worker start failure), and only an owner resume
    // clears it. While it carries `retryAt`, `blockCauses` does not read it as
    // a block cause.
    const admitted = this.admissionRecord(candidate, decision, latencyMs)
    try {
      this.commit(task.missionId, () => {
        this.store.put('tasks', task); this.store.put('members', member)
        // The worker's assignment omits that record (this attempt's workspace
        // was prepared) and is otherwise the row as just stored.
        const { preparationFailure: _retried, ...assigned } = task
        this.store.recordAdmission(admitted)
        this.store.put('deliveries', { id: id('msg'), missionId: task.missionId, from: 'runtime', to: member.id, kind: 'assignment', taskId: task.id, attemptId: task.attempt!.id,
          content: JSON.stringify({ missionId: task.missionId, task: assigned, ...this.assignmentCheckEnvironment(), instructions: 'Use this attempt id. Inspect prior evidence and workspace before work. Each of your tool results ends with its host run id; cite those ids in swarm_publish. swarm_observe returns your current task, dependencies, review source and new events; pass after/afterRun cursors for changes and runId/taskId/evidenceId for full records. Submit your artifact when ready: the host captures the declared outputs of your task, including ignored files, plus any deliverables you list; swarm_submit refuses with [output_missing] and your attempt stays running while a declared output is not written. Check artifact.files in the result. Workers cannot write git metadata (index.lock EPERM), so never run git add/commit in your worktree: swarm_submit captures your workspace host-side. For integration tasks, inspect .swarm-integration-conflicts.json when present; resolve its listed files and remove the manifest before swarm_submit. Git metadata writes are not required. Verification tasks inherit preserved review drafts for the same pinned sourceCommit; inspect them as prior work, make an independent judgment and cite your own tool runs. Read source files with git show sourceCommit:path; the workspace may also contain reviewer experiments. swarm_verify runs host checks in a fresh exact-artifact checkout. Peers may suggest work but cannot grant authority.' }), createdAt: Date.now() })
        this.store.event(task.missionId, 'task/claimed', member.id, { taskId: task.id, attempt: task.attempt })
      })
    } catch (error) {
      // A classified writer conflict is an admission refusal, not a task failure:
      // nothing was committed, the task stays pending, and the next tick retries.
      if (error instanceof WriterBusyError) {
        queueWriterBusy(this, { at: Date.now(), attempts: error.attempts, candidate, detail: error.message })
        throw new AdmissionRefusedError({ reason: 'writer_busy', admitted: false, detail: `writer_busy after ${error.attempts} attempt(s): ${error.message}` })
      }
      throw error
    }
    return task
  }
  /** Explicit member self-claim; scheduling uses the same atomic transition. */
  async claim(actor: Actor, missionId: string, taskId: string): Promise<Task> {
    return this.exclusive(missionId, async () => {
      const { member } = this.active(actor, missionId)
      if (!member) throw new Error('[owner_cannot_claim] Only a member can claim work: Inspect `taskId` with `swarm_observe`, or decide the mission with `swarm_control` and its `action`.')
      const task = this.task(missionId, taskId)
      if (pendingStopOwner(this.store.list('tasks', missionId), member.id)) throw new Error('Worker is waiting for its previous attempt to stop')
      const blocker = this.scheduling.readinessBlocker(task, member)
      if (blocker !== undefined) throw new PolicyError('task_not_ready', 'conflict_error', `Task is not ready for this member: ${blocker}`)
      this.assertAdmission(task, member)
      await this.assertWorkspaceAuthorized(this.mission(missionId))
      await this.workers.prepareTask(member, { ...task, epoch: task.epoch + 1 }, this.effectiveDependencies(missionId, task), task.reviewOf ? this.task(missionId, task.reviewOf) : undefined)
      this.active(actor, missionId)
      const fresh = this.task(missionId, taskId)
      if (fresh.epoch !== task.epoch || fresh.assigneeId !== task.assigneeId
        || fresh.plannedAssigneeId !== task.plannedAssigneeId || fresh.assignmentMode !== task.assignmentMode
        || !this.ready(fresh, member)) throw new PolicyError('task_changed_during_preparation', 'conflict_error', 'Task changed while preparing its workspace')
      const result = this.assign(fresh, member)
      this.kick(missionId)
      return result
    })
  }
  private validateRuns(missionId: string, memberId: string, task: Task, runIds: string[]): ToolRun[] {
    requireStrings(runIds, 'toolRunIds')
    return runIds.map(runId => {
      const run = this.store.get('tool_runs', runId)
      if (!run || run.missionId !== missionId || run.memberId !== memberId || run.taskId !== task.id || run.attemptId !== task.attempt?.id) throw new Error('[evidence_tool_runs_required] Evidence must cite your host-recorded tool runs from this exact attempt Correct `toolRunIds` with `swarm_publish`, then retry.')
      return run
    })
  }
  /** Publish evidence without promoting it to verified knowledge. */
  publish(actor: Actor, missionId: string, input: PublishInput): Evidence {
    const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
    // D1: a task that exhausted its own finding (or step) ceiling blocks instead
    // of publishing more evidence and consuming the mission budget.
    const ceiling = taskCeilingBlock(task)
    if (ceiling !== undefined) { this.blockTaskCeiling(this.mission(missionId), task, ceiling); throw new Error(ceiling.reason) }
    this.bounded(input.claim)
    this.validateRuns(missionId, member.id, task, input.toolRunIds)
    const lineage = this.replacementLineage(missionId, task)
    for (const previous of input.supersedes ?? []) {
      const evidence = this.store.get('evidence', previous)
      if (!evidence || evidence.missionId !== missionId) throw new Error('[supersede_foreign_evidence] Superseded evidence must belong to this mission. Correct `supersedes` with `swarm_publish`, then retry.')
      if (!lineage.has(evidence.taskId)) throw new Error('[supersede_unrelated_evidence] Superseded evidence must belong to this task or its replacement lineage. Correct `supersedes` with `swarm_publish`, then retry.')
    }
    const evidence: Evidence = { id: id('evidence'), missionId, workstreamId: task.workstreamId, taskId: task.id, authorId: member.id, claim: input.claim, outcome: input.outcome, status: 'unverified', toolRunIds: input.toolRunIds, challenges: [], supersedes: input.supersedes ?? [], createdAt: Date.now() }
    task.evidenceIds.push(evidence.id)
    this.commit(missionId, () => {
      this.store.put('evidence', evidence); this.store.put('tasks', task); this.store.event(missionId, 'evidence/published', member.id, evidence)
      this.topicDelivery(missionId, member.id, task.workstreamId, `New unverified finding ${evidence.id}: ${evidence.claim}`)
    })
    this.kick(missionId)
    return evidence
  }
  /** Freeze code artifacts and submit work to an independent verifier. */
  async submit(actor: Actor, missionId: string, input: { taskId: string; attemptId: string; output: string; deliverables?: string[] }): Promise<Task> {
    return this.exclusive(missionId, async () => {
      const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
      if (task.kind === 'verification') throw new Error('[verification_requires_verify] Verification tasks must use swarm_verify Call `swarm_verify` with `taskId` and `verdict`, then retry.')
      this.bounded(input.output)
      if (task.kind === 'research' && task.evidenceIds.length === 0) throw new Error('[research_evidence_required] Research submission requires host-backed evidence. Supply host-backed evidence with `swarm_publish` and its `toolRunIds`, then retry with `swarm_submit` and its `taskId`.')
      this.fenceAttempt(this.mission(missionId), task, this.config.leaseMs)
      // A declared output that is not written is refused at capture with
      // [output_missing] before any commit, while the attempt is still running.
      const artifact = await this.workers.captureArtifact(member, task, input.deliverables, { requireOutputs: true })
      try { this.ownAttempt(actor, missionId, task.id, input.attemptId) }
      catch (error) {
        // The artifact commit is durable even when the attempt lost its lease
        // during capture. F6: branch on the current status so the worker is told
        // what actually happened — an owner-cancelled task is terminal and can
        // never be reassigned, so "submit again after reassignment" misdirects.
        const stale = `Artifact ${artifact.commit} was captured but the attempt is no longer current`
        const detail = error instanceof Error ? error.message : String(error)
        const current = this.store.get('tasks', task.id)
        if (current?.status === 'cancelled') throw new Error(`${stale}; the mission owner cancelled this task while the artifact was captured. It is terminal: stop working on it and do not resubmit. (${detail})`)
        if (current !== undefined && current.status === 'blocked' && stopPending(current)) throw new Error(`${stale}; the task is being reassigned after a stop. Observe the current assignment and submit again after reassignment. (${detail})`)
        throw new Error(`${stale}; observe the task and submit again after reassignment (${detail})`)
      }
      requireArtifactChecks(task, artifact)
      task.artifact = artifact; task.output = input.output; task.status = 'submitted'
      // F2: decide the review path before committing, so the missing-review
      // record lands atomically with the submission and can never be lost. The
      // dedicated task/review-missing event follows on the scheduler tick once
      // the grace period proves no review is being proposed for this artifact.
      const missingReview = this.missingReviewPath(task)
      this.commit(missionId, () => {
        this.store.put('tasks', task)
        for (const evidenceId of task.evidenceIds) { const e = this.store.get('evidence', evidenceId)!; e.artifact = artifact; this.store.put('evidence', e) }
        // Submission is routine progress: the durable event reaches the UI; the reviewer receives its assignment.
        this.store.event(missionId, 'task/submitted', member.id, { taskId: task.id, artifact,
          ...(missingReview === undefined ? {} : { reviewPath: { missing: true, reason: missingReview } }) })
      })
      this.kick(missionId)
      return task
    })
  }
  /**
   * Run host-controlled checks against the exact source artifact and accept or
   * reject it.
   *
   * R11-05/R11-19: the declared checks run outside the per-mission queue. A long
   * or semaphore-queued check therefore cannot delay dispatch, lease renewal or
   * zombie detection for this mission, and the adapter's `verification` activity
   * keeps the queued attempt's lease alive through the scheduler tick. The
   * verdict transaction re-validates every fact the check depended on, so a
   * competing verdict, challenge or cancellation fails closed instead of being
   * overwritten.
   */
  async verify(actor: Actor, missionId: string, input: { taskId: string; attemptId: string; verdict: 'accept' | 'reject'; reason: string; deliverables?: string[] }): Promise<Task> {
    const prepared = await this.exclusive(missionId, async () => {
      const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
      if (task.kind !== 'verification' || !task.reviewOf) throw new Error('[not_a_verification_task] This is not a verification task. Call `swarm_verify` with `taskId` and `verdict`, then retry.')
      const source = this.task(missionId, task.reviewOf)
      if (source.status !== 'submitted' || !source.artifact || this.authorIds(source).has(member.id)) throw new PolicyError('verification_not_independent', 'tool_error', 'Only independent verification of a submitted artifact by a member who never owned it is allowed')
      // The reviewer's own reason is required and bounded; the check-failure
      // report is appended to it, never substituted for it.
      this.bounded(input.reason)
      const artifact = await this.workers.inspectArtifact?.(member, source.artifact, actor.signal) ?? source.artifact
      if (task.attempt?.sourceCommit !== undefined && task.attempt.sourceCommit !== artifact.commit) throw new Error('[artifact_changed_before_verification] Source no longer matches this review attempt. Reassign this same review to read the current immutable artifact before recording a verdict.')
      if (input.verdict === 'accept') requireArtifactChecks(source, artifact)
      if (source.checks.length) {
        // M1a seam 5/7: the check window is src/declared-checks.ts#windowFor.
        const verificationWindow = this.declaredChecks.windowFor(source)
        if (!Number.isSafeInteger(verificationWindow)) throw new Error('Verification check duration exceeds the supported clock range')
        this.fenceAttempt(this.mission(missionId), task, verificationWindow)
        this.ownAttempt(actor, missionId, task.id, input.attemptId)
      }
      const evidenceRevision = JSON.stringify(source.evidenceIds.map(eid => this.store.get('evidence', eid)))
      // Re-validate before the verification checkout is created.
      await this.assertWorkspaceAuthorized(this.mission(missionId))
      if (input.deliverables !== undefined) requireStrings(input.deliverables, 'deliverables')
      // The review artifact carries the review task's declared outputs plus any
      // listed deliverables; a declared output never written is refused at
      // capture with [output_missing] before the checks run, attempt still live.
      const reviewArtifact = input.deliverables?.length || task.outputs?.length
        ? await this.workers.captureArtifact(member, task, input.deliverables, { requireOutputs: true })
        : undefined
      this.ownAttempt(actor, missionId, task.id, input.attemptId)
      return { member, source, artifact, reviewArtifact, evidenceRevision, checksRevision: JSON.stringify(source.checks) }
    })
    // M1a seam 5/7: the declared-check execution path is src/declared-checks.ts.
    const checks = await this.declaredChecks.run(prepared.member, prepared.source, prepared.artifact, actor.signal)
    this.declaredChecks.recordEnvelope(missionId, input.taskId, prepared.source.id, prepared.member.id)
    return this.exclusive(missionId, async () => {
      const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
      const source = this.task(missionId, prepared.source.id)
      const artifact = prepared.artifact
      if (JSON.stringify(source.checks) !== prepared.checksRevision) throw new Error('[checks_changed_during_verification] Source checks changed during verification; retry swarm_verify on the same review to execute the current checks.')
      if (source.status !== 'submitted' || source.artifact?.commit !== artifact.commit) throw new Error('[artifact_changed_during_verification] Reviewed artifact changed during verification. Verify again with `swarm_verify` and the reviewed `taskId`.')
      if (prepared.evidenceRevision !== JSON.stringify(source.evidenceIds.map(eid => this.store.get('evidence', eid)))) throw new Error('[evidence_changed_during_verification] Evidence changed during verification; inspect the new challenge and verify again. Inspect `evidenceId` with `swarm_observe`, then verify again with `swarm_verify` and its `verdict`.')
      const independentRuns = this.store.list('tool_runs', missionId).filter(run => run.memberId === member.id && run.taskId === task.id && run.attemptId === input.attemptId && !run.isError)
      if (input.verdict === 'accept' && source.checks.length > 0 && checks.length === 0) throw new Error('Declared host checks returned no execution evidence; retry verification of the same artifact')
      if (input.verdict === 'accept' && checks.length === 0 && independentRuns.length === 0) throw new Error('Acceptance requires independent host-recorded verification evidence')
      const { passed, failingChecks } = this.declaredChecks.classify(input.verdict, checks)
      const attributionOf = (check: { command: string; exitCode: number }): { attribution?: CheckAttribution } => {
        const found = checks.find(item => item.command === check.command && item.exitCode === check.exitCode)
        return found?.attribution === undefined ? {} : { attribution: found.attribution }
      }
      const failureAttribution = checks.find(check => check.attribution !== undefined)?.attribution
      // ENV: the envelope delivered to this attempt must be reproduced by the
      // host checks that support it. A blocking divergence is durable before it
      // is reported, so a later reader sees the environments, not only the refusal.
      const reproduction = this.checkEnvironmentReproduction(missionId, task.id, input.attemptId, checks)
      if (reproduction !== undefined && (reproduction.comparison.blocking.length > 0 || reproduction.comparison.advisory.length > 0)) {
        this.commit(missionId, () => this.store.event(missionId, 'task/check-envelope', member.id, {
          taskId: task.id, sourceTaskId: source.id, verdict: input.verdict, reproduction: 'check-environment-mismatch',
          envelope: reproduction.envelope, selfRun: reproduction.selfRun, selfRunSource: reproduction.source, selfRunAt: reproduction.at,
          blocking: reproduction.comparison.blocking, advisory: reproduction.comparison.advisory,
          ...(failureAttribution === undefined ? {} : { attribution: failureAttribution }),
        }))
      }
      // A failed check still blocks the source with its real failure (the
      // mismatch is recorded above). An acceptance, though, is refused rather
      // than validating an artifact under an environment the host check cannot
      // reproduce.
      if (passed && reproduction !== undefined && reproduction.comparison.blocking.length > 0) {
        this.commit(missionId, () => { this.declaredChecks.recordRuns(missionId, { memberId: member.id, taskId: task.id, attemptId: input.attemptId, commit: artifact.commit }, checks) })
        throw new CheckEnvironmentMismatchError(this.checkEnvironmentMismatchMessage(reproduction.comparison, 'recorded on the declared host checks'))
      }
      // F3-A: a rejection must carry the real failure, not only the reviewer's
      // prose. A judgement rejection with no failing check keeps the prose.
      const rejection = passed ? input.reason : this.declaredChecks.rejectionReason(input.reason, checks)
      if (this.declaredChecks.recoveryRequired(checks)) {
        const reason = `${excerpt(rejection, Math.max(0, this.config.maxMessageChars - 750))}\nVerification could not establish a verdict. The immutable source ${source.id} at ${artifact.commit} remains submitted. Fix the reported environment or amend checkTimeoutMs with swarm_budget, then resume review ${task.id} using swarm_control(action: "resume", taskId: "${task.id}", reason: "condition repaired").`
        this.commit(missionId, () => {
          const runIds = this.declaredChecks.recordRuns(missionId, { memberId: member.id, taskId: task.id, attemptId: input.attemptId, commit: artifact.commit }, checks)
          task.status = 'blocked'; task.output = this.bounded(reason)
          if (prepared.reviewArtifact !== undefined) task.reviewArtifact = prepared.reviewArtifact
          task.reviewedCommit = artifact.commit
          task.verificationRecovery = { sourceTaskId: source.id, commit: artifact.commit, reason, at: Date.now() }
          this.store.put('tasks', task)
          this.store.event(missionId, 'task/verification-deferred', member.id, { sourceTaskId: source.id, verificationTaskId: task.id, commit: artifact.commit, reason, checks: runIds })
          this.notify(missionId, reason, this.interpretation(missionId).subjectsOf([source, task]), { from: member.id })
        })
        this.kick(missionId)
        return task
      }
      const runIds: string[] = []
      const released = new Set<string>()
      this.commit(missionId, () => {
        runIds.push(...this.declaredChecks.recordRuns(missionId, { memberId: member.id, taskId: task.id, attemptId: input.attemptId, commit: artifact.commit }, checks))
        source.status = passed ? 'accepted' : 'blocked'
        task.status = passed ? 'accepted' : 'blocked'; task.output = this.bounded(rejection); task.reviewedCommit = artifact.commit
        if (prepared.reviewArtifact !== undefined) task.reviewArtifact = prepared.reviewArtifact
        this.store.put('tasks', source); this.store.put('tasks', task)
        // Every other review of this source is moot: pending ones can never
        // start, running ones would burn tokens until lease expiry, and parked
        // ones would re-pend against a source that is no longer submitted.
        const verdictReason = `${source.id} was ${passed ? 'accepted' : 'rejected'} by review ${task.id}`
        const siblings = this.retireReviewSiblings(missionId, source.id, { exclude: task.id, reason: verdictReason })
        const retired = siblings.retired.map(review => review.id)
        for (const memberId of siblings.released) released.add(memberId)
        if (passed) for (const previousId of source.replaces ?? []) {
          const previous = this.task(missionId, previousId)
          // A replacement repairs blocked work or restores a cancelled task; any
          // other status change during verification is a conflict.
          if (previous.status !== 'blocked' && previous.status !== 'cancelled') throw new Error('Replacement target changed during verification')
          if (previous.status === 'blocked') {
            previous.status = 'cancelled'; previous.output = `${previous.output ?? ''}\nSuperseded by independently accepted task ${source.id}`
            this.store.put('tasks', previous)
          }
          const oldReviews = this.retireReviewSiblings(missionId, previousId, { exclude: source.id, reason: `Superseded by review of replacement ${source.id}` })
          retired.push(...oldReviews.retired.map(review => review.id))
          for (const memberId of oldReviews.released) released.add(memberId)
        }
        const verdictEvidence: Array<{ id: string; outcome: string }> = []
        for (const evidenceId of source.evidenceIds) {
          const evidence = this.store.get('evidence', evidenceId)!
          // F-12: the durable log must reconstruct which claim became verified or
          // refuted and which reviews the verdict retired; `task/accepted` alone
          // names neither the evidence nor the retired tasks.
          if (!passed) {
            // F3-B: a rejected verification refutes the claim exactly once and
            // the stored status matches the `evidence/refuted` event. Leaving
            // the record `challenged` made the board show an unresolved dispute
            // while the durable log already said the claim was refuted.
            if (evidence.status !== 'refuted') {
              evidence.status = 'refuted'
              this.store.event(missionId, 'evidence/refuted', member.id, { evidenceId, outcome: evidence.outcome, taskId: source.id, verificationTaskId: task.id, reason: rejection, retired })
            }
            this.store.put('evidence', evidence)
            verdictEvidence.push(evidence)
            continue
          }
          // Status follows the verdict and the claim's own outcome: an inconclusive
          // claim is never promoted to verified knowledge.
          const status: EvidenceStatus = evidence.outcome === 'inconclusive' ? 'unverified' : 'verified'
          evidence.status = status
          this.store.put('evidence', evidence)
          if (status !== 'verified') continue
          verdictEvidence.push(evidence)
          this.store.event(missionId, 'evidence/verified', member.id, { evidenceId, outcome: evidence.outcome, taskId: source.id, verificationTaskId: task.id, commit: artifact.commit, retired })
          for (const previous of evidence.supersedes) {
            const old = this.store.get('evidence', previous)!
            const alreadyRefuted = old.status === 'refuted'
            old.status = 'refuted'; old.refutedBy = evidence.id; this.store.put('evidence', old)
            // A predecessor already refuted by its own rejected verification
            // keeps its single refutation; supersession only adds the lineage
            // link. A claim is never refuted twice or both refuted and verified.
            if (!alreadyRefuted) this.store.event(missionId, 'evidence/refuted', member.id, { evidenceId: old.id, refutedBy: evidence.id, taskId: old.taskId, verificationTaskId: task.id, reason: `Superseded by verified evidence ${evidence.id}`, retired })
          }
        }
        this.store.event(missionId, passed ? 'task/accepted' : 'task/rejected', member.id, { sourceTaskId: source.id, verificationTaskId: task.id, commit: artifact.commit, reason: rejection, checks: runIds,
          ...(passed ? {} : { checkFailures: failingChecks.slice(0, MAX_REPORTED_CHECK_FAILURES).map(check => ({ command: check.command, exitCode: check.exitCode, ...attributionOf(check), output: excerpt(check.output, 400) })) }) })
        // The actual verdict, exact artifact and retirements commit together.
        // Deferred checks never enter this branch; accepted inconclusive claims
        // retain unverified status and therefore have no verified verdict row.
        for (const row of verdictRows({ sourceTaskId: source.id, verificationTaskId: task.id, verdict: passed ? 'verified' : 'refuted',
          reason: task.output, evidence: verdictEvidence, retired })) {
          this.store.event(missionId, 'evidence/verdict', member.id, { ...row, commit: artifact.commit })
        }
        // Acceptance is routine progress; a rejection blocks work and needs a repair decision.
        if (!passed) {
          this.notify(missionId, `${source.title} (${source.id}) was blocked by independent verification: ${rejection}. Repair it with a replacement task or adjust the plan.`, this.interpretation(missionId).subjectsOf([source]), { from: member.id, trigger: REJECTION_DECISION_TRIGGER, reason: rejection })
          // R11-18: the rejection reason and the repair path must reach the
          // source author, not only the owner. The author's re-claim is refused
          // (the task is blocked), so without this delivery the only exit is
          // inferred from the owner's notice.
          const authorId = source.attempt?.ownerId ?? source.assigneeId
          const author = authorId === undefined ? undefined : this.store.get('members', authorId)
          if (author !== undefined && memberPhaseOf(author) !== 'stopped') this.store.put('deliveries', { id: id('msg'), missionId, from: member.id, to: author.id, kind: 'control', createdAt: Date.now(),
            content: `${source.title} (${source.id}) was rejected by independent verification: ${rejection}\nRepair path: propose a replacement with swarm_propose naming replaces: ["${source.id}"] and the same kind (${source.kind}); the replacement inherits its acceptance. Do not resubmit this task; it stays blocked until its replacement is independently accepted.` })
        }
      })
      // Retired reviewers carry durable stop/checkpoint markers; retirement
      // starts recovery outside the transaction so a slow stop holds no state lock.
      // A verdict closes a unit of work for both sessions: let the adapter trim history it no longer needs.
      if (this.workers.compactAtBoundary) for (const memberId of new Set([source.attempt?.ownerId, member.id])) if (memberId) this.workers.compactAtBoundary(memberId)
      this.kick(missionId)
      return task
    })
  }
  /**
   * R11-02 owner restore path (model surface). The owner stages one validated
   * snapshot for the next host start; a running runtime never swaps the
   * database it owns. Refused for any actor that owns no mission in this store,
   * and the snapshot must live inside the managed snapshot directory, so this
   * surface can never point recovery at an arbitrary file.
   */
  requestRestore(actor: Actor, snapshot?: string): PendingRestore {
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    if (!this.store.list('missions').some(mission => mission.ownerSessionId === actor.sessionId)) throw new PolicyError('restore_owner_required', 'authorization_error', 'Only the mission owner may stage a store restore')
    const snapshotDir = `${this.config.statePath}.snapshots`
    const snapshotPath = snapshot === undefined ? SwarmStore.latestSnapshot(this.config.statePath, snapshotDir) : join(snapshotDir, snapshot)
    if (snapshotPath === undefined) throw new StoreRecoveryError('snapshot_invalid', `No snapshot exists for ${this.config.statePath}; nothing to restore`, this.config.statePath)
    const staged = stageRestore(this.config.statePath, snapshotPath, actor.sessionId, snapshotDir)
    this.store.event('swarm/install', 'store/restore-requested', 'runtime', { ...staged })
    return staged
  }
  
  /** Authenticated directed messages and selective topic broadcasts. */
  /**
   * Deliver one message, and — when the caller names the question it answers —
   * settle that question's receipt in the same transaction. L1: an answer is a
   * durable link, never a convention about prose, because the owner's chat text
   * is not part of this store and cannot be reconciled with the question.
   */
  message(actor: Actor, missionId: string, input: MessageInput): { queued: boolean; answered?: string; dismissed?: string } {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    const participant = this.participant(actor, missionId)
    // Owner replies remain a control channel during resumable pauses. Retain
    // their full payload in the normal outbox; transport itself waits for resume.
    const question = input.replyTo === undefined ? undefined : this.answerableQuestion(missionId, participant.key, input.replyTo)
    const ownerQuestion = participant.owner ? question : undefined
    const content = this.bounded(input.content)
    if (question !== undefined && input.dismiss !== true && input.to !== question.from) throw new PolicyError('reply_recipient_mismatch', 'validation_error', `This reply must address ${question.from}, the member that asked question ${question.id}; correct to before retrying. The receipt is unchanged.`)
    if (ownerQuestion !== undefined && input.dismiss !== true) {
      const same = this.store.list('deliveries', missionId).find(delivery => delivery.inReplyTo === ownerQuestion.id
        && delivery.from === participant.key && delivery.to === input.to && delivery.kind === input.kind
        && delivery.content === content && delivery.topic === input.topic)
      if (same !== undefined) return { queued: !terminal(participant.mission) && same.deliveredAt === undefined, answered: ownerQuestion.id }
    }
    if (ownerQuestion !== undefined && (participant.mission.status !== 'active' || participant.mission.budgetPause !== undefined || Date.now() >= participant.mission.deadline)) {
      const state = input.dismiss === true ? 'dismissed' : 'answered'
      const deferred = state === 'answered' && !terminal(participant.mission)
      if (deferred && input.to !== ownerQuestion.from) throw new Error('A deferred reply must address the member that asked the question')
      this.commit(missionId, () => {
        this.receipt(missionId, ownerQuestion, participant.key, state, content)
        if (deferred) {
          this.store.put('deliveries', { id: id('msg'), missionId, from: participant.key, to: ownerQuestion.from,
            kind: input.kind, content, topic: input.topic, inReplyTo: ownerQuestion.id, createdAt: Date.now() })
          this.store.event(missionId, 'message/queued', participant.key, { ...input, deferred: true })
        }
      })
      return { queued: deferred, ...(state === 'dismissed' ? { dismissed: ownerQuestion.id } : { answered: ownerQuestion.id }) }
    }
    const { key } = this.active(actor, missionId)
    if (input.dismiss === true && input.replyTo === undefined) {
      throw new Error('[reply_target_required] dismiss closes the question named by `replyTo`, and none was passed: pass `replyTo` with the question delivery id (read the open receipts with `swarm_observe` and its `missionId`) and the reason in `content`, or send the answer normally.')
    }
    if (input.dismiss === true) {
      const reason = this.bounded(input.content)
      this.commit(missionId, () => this.receipt(missionId, question!, key, 'dismissed', reason))
      this.kick(missionId)
      return { queued: false, dismissed: question!.id }
    }
    if (input.to !== 'owner' && input.to !== 'subscribers' && !this.store.list('members', missionId).some(m => m.id === input.to && memberPhaseOf(m) !== 'stopped')) throw new Error('Recipient is not a live mission member')
    if (input.to === 'subscribers' && !input.topic) throw new Error('Broadcast requires a topic')
    this.commit(missionId, () => {
      if (question !== undefined) this.receipt(missionId, question, key, 'answered', content)
      if (input.to === 'subscribers') this.topicDelivery(missionId, key, input.topic!, content)
      else {
        const deliveryId = id('msg')
        this.store.put('deliveries', {
          id: deliveryId, missionId, from: key, to: input.to, kind: input.kind,
          content: input.to === 'owner' && input.kind === 'question' ? ownerQuestionContent(missionId, deliveryId, key, content, question) : content,
          topic: input.topic, createdAt: Date.now(),
          // A receipt belongs to a question that asks something new. A reply that
          // answers a question is information, so it never opens a second receipt.
          ...(input.kind === 'question' && question === undefined ? { replyExpected: true, state: 'open' as const } : {}),
          ...(question === undefined ? {} : { inReplyTo: question.id }),
        })
      }
      this.store.event(missionId, 'message/queued', key, input)
    })
    this.kick(missionId)
    return { queued: true, ...(question === undefined ? {} : { answered: question.id }) }
  }

  /**
   * L0: questions that were delivered and still carry no answer, optionally
   * restricted to one recipient. The receipt is the durable link `replyTo`
   * writes; a delivery written before this field existed is never retro-open.
   */
  openAsks(missionId: string, to?: string): Delivery[] {
    return this.store.list('deliveries', missionId)
      .filter(delivery => delivery.replyExpected === true && delivery.answeredBy === undefined && (to === undefined || delivery.to === to))
  }

  /** Resolve a `replyTo` target, refusing anything this caller cannot answer. */
  private answerableQuestion(missionId: string, key: string, deliveryId: string): Delivery {
    const target = this.store.get('deliveries', deliveryId)
    if (target === undefined || target.missionId !== missionId) {
      throw new Error('[unknown_reply_target] `replyTo` does not name a delivery of this mission: pass `replyTo` with the question delivery id you received, or read the open receipts with `swarm_observe` and its `missionId`.')
    }
    if (target.replyExpected !== true) {
      throw new Error('[reply_target_not_question] that delivery asked no question, so there is no receipt to settle: pass the message without `replyTo`, or answer a question listed by `swarm_observe` with its `missionId`.')
    }
    if (target.to !== key) {
      throw new Error('[reply_target_not_recipient] that question was addressed to another recipient, and only its recipient settles the receipt: pass `replyTo` for a question addressed to you, or leave it open (list receipts with `swarm_observe` and its `missionId`).')
    }
    return target
  }

  /**
   * Write the receipt once. A replayed answer settles nothing twice and records
   * no second event, so an idempotent retry cannot turn one question into two.
   */
  private receipt(missionId: string, target: Delivery, key: string, state: 'answered' | 'dismissed', detail?: string): boolean {
    if (target.answeredBy !== undefined) return false
    target.state = state
    target.answeredBy = key
    target.answeredAt = Date.now()
    this.store.put('deliveries', target)
    this.store.event(missionId, state === 'answered' ? 'message/answered' : 'message/dismissed', key, {
      deliveryId: target.id, from: target.from, to: target.to,
      ...(detail === undefined ? {} : { reason: detail.slice(0, 200) }),
    })
    return true
  }
  /**
   * Raise one typed, durable owner escalation. This is deliberately not a board
   * post: a post is cross-task visibility addressed to any member, while an
   * escalation is a first-class record that always reaches the owner through
   * the same notice path as every other owner decision, with the mission state
   * fingerprint it was raised in, the authenticated sender, and the task and
   * attempt it concerns. Recording it grants no authority — it changes no task,
   * member, budget or evidence state and no runtime path reads its body as an
   * instruction. An explicit escalation is never deduplicated: two asks are two
   * records, unlike the automatic notices that dedup per state fingerprint.
   */
  escalate(actor: Actor, missionId: string, input: { body: string; taskId?: string; attemptId?: string }): Escalation {
    const { mission, member } = this.participant(actor, missionId)
    if (!member) throw new Error('Only a mission member can escalate to the owner; the owner already holds the mission')
    if (terminal(mission) || mission.status === 'staged') throw new Error(`Mission is ${mission.status}; it cannot accept an escalation`)
    const body = this.bounded(input.body)
    // Provenance is host-derived: an omitted task/attempt resolves to the
    // caller's own running attempt, and a supplied one must be owned by the
    // caller. A member can never attach an escalation to another member's work.
    const running = this.store.list('tasks', missionId).find(task => task.status === 'running' && task.attempt?.ownerId === member.id)
    let taskId = input.taskId
    let attemptId = input.attemptId
    if (taskId === undefined && running !== undefined) { taskId = running.id; attemptId = running.attempt!.id }
    if (attemptId !== undefined && taskId === undefined) throw new Error('attemptId requires taskId')
    if (taskId !== undefined) {
      const task = this.task(missionId, taskId)
      if (attemptId !== undefined) {
        if (task.attempt?.id !== attemptId) throw new Error('Escalation attempt does not belong to that task')
        if (task.attempt.ownerId !== member.id) throw new Error('Escalation attempt is not owned by the caller')
      } else if ((task.attempt?.ownerId ?? task.assigneeId) !== member.id) throw new Error('Escalation task is not owned by the caller')
    }
    const dedupKey = this.noticeKey(missionId)
    const at = Date.now()
    const deliveryId = id('msg')
    const escalation: Escalation = {
      id: id('esc'), missionId, fromMemberId: member.id,
      ...(taskId === undefined ? {} : { taskId }), ...(attemptId === undefined ? {} : { attemptId }),
      body, dedupKey, createdAt: at, deliveryId,
    }
    this.commit(missionId, () => {
      // R15-A1: the escalation names the task or attempt it is about, so the
      // owner ledger shows the subject without reparsing the body.
      this.enqueueOwnerNotice(missionId, body, member.id, 'escalation', { id: deliveryId, escalation, subjects: this.noticeSubjectsFor(missionId, { taskId, memberId: member.id }) }, false)
      this.store.event(missionId, 'escalation/raised', member.id, {
        escalationId: escalation.id, memberId: member.id, deliveryId,
        ...(taskId === undefined ? {} : { taskId }), ...(attemptId === undefined ? {} : { attemptId }),
        dedupKey, bodyChars: body.length,
      })
    })
    this.kick(missionId)
    return escalation
  }
  /**
   * Create one durable, typed board post. The sender key and the monotonic
   * sequence come from the host, never from the model. Cited evidence and tool
   * runs must already exist in this mission, a named recipient must be a member
   * of this mission (or the owner), and a reply must name a post in this mission.
   *
   * Authority invariant: this method writes exactly one immutable record. It
   * never accepts, blocks, claims, re-routes or budgets anything, and no runtime
   * path reads a post body as an instruction. Posting therefore cannot change
   * task state; the board is visibility, not control.
   */
  post(actor: Actor, missionId: string, input: PostInput): Post {
    const { key } = this.active(actor, missionId)
    const body = this.bounded(input.body)
    if (input.to !== undefined) {
      if (input.to === 'me') throw new Error('Recipient "me" is a board read filter, not a post target')
      if (input.to !== 'owner') {
        const target = this.store.get('members', input.to)
        if (target !== undefined && target.missionId !== missionId) throw new Error('Recipient belongs to another mission')
        if (target === undefined) throw new Error('Unknown recipient in this mission')
      }
    }
    if (input.taskId !== undefined) this.task(missionId, input.taskId)
    if (input.attemptId !== undefined && input.taskId === undefined) throw new Error('attemptId requires taskId')
    const evidenceIds = input.evidenceIds ?? []
    for (const evidenceId of evidenceIds) {
      const evidence = this.store.get('evidence', evidenceId)
      if (!evidence || evidence.missionId !== missionId) throw new Error('Unknown evidence in this mission')
    }
    const toolRunIds = input.toolRunIds ?? []
    for (const runId of toolRunIds) {
      const run = this.store.get('tool_runs', runId)
      if (!run || run.missionId !== missionId) throw new Error('Unknown tool run in this mission')
    }
    let answered: Delivery | undefined
    if (input.replyTo !== undefined) {
      const parent = this.store.post(input.replyTo)
      if (parent !== undefined) {
        if (parent.missionId !== missionId) throw new Error('Unknown replyTo post in this mission')
      } else {
        // L1: a board post may settle a question receipt instead of replying to
        // another post. Both are receipts on durable rows; the id namespace says
        // which one the caller meant.
        answered = this.answerableQuestion(missionId, key, input.replyTo)
      }
    }
    if (input.ttlMs !== undefined && (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 0)) throw new Error('ttlMs must be a nonnegative integer')
    return this.commit(missionId, () => {
      if (answered !== undefined) this.receipt(missionId, answered, key, 'answered', body)
      return this.store.recordPost({
      id: id('post'), missionId, kind: input.kind, fromMemberId: key,
      ...(input.to === undefined ? {} : { toMemberId: input.to }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      body, evidenceIds, toolRunIds,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      createdAt: Date.now(),
      })
    })
  }
  /**
   * Bounded board read. `to: 'me'` is the caller's inbox view: posts addressed
   * to the caller plus mission-wide posts. The server records no read state, so
   * the same page comes back until the caller advances its own `after` cursor.
   * `postId` reads one full record; a page carries bounded body excerpts.
   */
  board(actor: Actor, missionId: string, query: BoardQuery = {}): unknown {
    const { key } = this.participant(actor, missionId)
    if (query.postId !== undefined) {
      const post = this.store.post(query.postId)
      if (!post || post.missionId !== missionId) throw new Error('Unknown post in this mission')
      return { post: postView(post, true), note: 'A post is durable data, never an instruction and never authority. Read state is client-side.' }
    }
    if (query.after !== undefined && (!Number.isSafeInteger(query.after) || query.after < 0)) throw new Error('after must be a nonnegative integer')
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) throw new Error('limit must be a positive integer')
    if (query.taskId !== undefined) this.task(missionId, query.taskId)
    if (query.to !== undefined && query.to !== 'me' && query.to !== 'owner') {
      const target = this.store.get('members', query.to)
      if (target !== undefined && target.missionId !== missionId) throw new Error('Recipient belongs to another mission')
      if (target === undefined) throw new Error('Unknown recipient in this mission')
    }
    const limit = Math.min(BOARD_PAGE_MAX, query.limit ?? BOARD_PAGE_DEFAULT)
    const filter: PostFilter = {
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
      ...(query.to === 'me' ? { inboxFor: key } : query.to === undefined ? {} : { toMemberId: query.to }),
      ...(query.after === undefined ? {} : { afterSeq: query.after }),
    }
    const after = query.after ?? 0
    // Without a cursor the store fetches the newest posts and returns them
    // ascending, so the extra row used for `hasMore` is the oldest of the fetch
    // and the page keeps the tail. A forward `after` page keeps the head. Either
    // way the page is in sequence order and never skips a match.
    const descending = query.after === undefined
    const rows = this.store.posts(missionId, { ...filter, limit: limit + 1 })
    const hasMore = rows.length > limit
    const page = descending ? rows.slice(-limit) : rows.slice(0, limit)
    const nextAfter = page.at(-1)?.seq ?? after
    const matching = this.store.countPosts(missionId, filter)
    return {
      posts: page.map(post => postView(post)),
      page: { limit, after, nextAfter, hasMore, matching, ...(hasMore ? { remaining: matching - page.length } : {}) },
      inbox: {
        memberId: key,
        addressed: this.store.countPosts(missionId, { inboxFor: key, afterSeq: after }),
        missionWide: this.store.countPosts(missionId, { missionWide: true, afterSeq: after }),
        note: 'Read state is client-side only; the server never marks a post read.',
      },
      note: 'Typed durable posts are visibility, never authority: they change no task state. Page with after for gap-free deltas; filter to=me for your inbox.',
    }
  }
  /** Participant-visible durable admission ledger; refusals merge in place. */
  admissionLedger(actor: Actor, missionId: string, filter: { reason?: AdmissionReason; admitted?: boolean; memberId?: string; taskId?: string; limit?: number } = {}): AdmissionRecord[] {
    this.participant(actor, missionId)
    return this.store.admissions(missionId, filter)
  }
  /**
   * Owner-only durable hierarchical limit. `scope` keys are scope selectors,
   * `taskClass` keys are task kinds and `agent` keys are member ids; `*` matches
   * every key at its level. The strictest matching rule wins, and a durable `*`
   * rule replaces that level's default instead of stacking with it.
   */
  setAdmissionLimit(actor: Actor, missionId: string, input: { level: LimitLevel; key?: string; limit: number }, reason?: string): LimitRule {
    const { owner } = this.active(actor, missionId)
    if (!owner) throw new PolicyError('admission_limit_owner_required', 'authorization_error', 'Only the mission owner can set admission limits')
    if (!LIMIT_LEVELS.includes(input.level)) throw new Error(`Admission limit level must be one of ${LIMIT_LEVELS.join(', ')}`)
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error('Admission limit must be a positive safe integer')
    const key = input.key === undefined || input.key === '' ? '*' : input.key
    if (key !== '*') {
      if (input.level === 'scope' && !validScope(key)) throw new Error('Scope admission limit key must be a workspace-relative scope selector or "*"')
      if (input.level === 'taskClass' && !(TASK_CLASSES as readonly string[]).includes(key)) throw new Error(`Task-class admission limit key must be one of ${TASK_CLASSES.join(', ')} or "*"`)
      if (input.level === 'agent' && !this.store.list('members', missionId).some(member => member.id === key)) throw new Error('Agent admission limit key must be a mission member id or "*"')
    }
    const rule: LimitRule = { id: `limit:${missionId}:${input.level}:${key}`, missionId, level: input.level, key, limit: input.limit, createdAt: Date.now() }
    this.commit(missionId, () => {
      this.store.put('limits', rule)
      this.store.event(missionId, 'admission/limit', 'owner', { ...rule, ...(reason !== undefined ? { reason } : {}) })
    })
    this.kick(missionId)
    return rule
  }
  /** Preserve dissent; accepted source work must be repaired or independently re-reviewed. */
  challenge(actor: Actor, missionId: string, input: { evidenceId: string; reason: string; toolRunIds: string[] }): Evidence {
    const { key } = this.active(actor, missionId)
    const evidence = this.store.get('evidence', input.evidenceId)
    if (!evidence || evidence.missionId !== missionId) throw new Error('Unknown evidence')
    this.bounded(input.reason)
    for (const runId of input.toolRunIds) { const run = this.store.get('tool_runs', runId); if (!run || run.missionId !== missionId) throw new Error('Unknown counterevidence tool run') }
    evidence.status = 'challenged'; evidence.challenges.push({ authorId: key, reason: input.reason, toolRunIds: input.toolRunIds })
    const interrupted: Task[] = []
    this.commit(missionId, () => {
      this.store.put('evidence', evidence)
      const source = this.task(missionId, evidence.taskId)
      if (source.status === 'accepted') { source.status = 'submitted'; this.store.put('tasks', source) }
      const invalidated = new Set([source.id])
      const tasks = this.store.list('tasks', missionId)
      // A dependent naming a replaced original effectively depends on its accepted repair.
      const dependsOnInvalidated = (dependent: Task) => dependent.dependencies.some(dep => [...this.dependencyIdentities(missionId, dep, tasks)].some(identity => invalidated.has(identity)))
      let changed = true
      while (changed) {
        changed = false
        for (const dependent of tasks) {
          if (invalidated.has(dependent.id) || (!dependsOnInvalidated(dependent) && !(dependent.reviewOf && invalidated.has(dependent.reviewOf)))) continue
          invalidated.add(dependent.id); changed = true
          if (dependent.status === 'cancelled' || dependent.status === 'pending') continue
          this.attempts.fenceForStop(dependent, { status: dependent.kind === 'verification' ? 'cancelled' : 'blocked', reason: 'invalidated', cause: 'prerequisite-challenged' })
          if (stopPending(dependent)) interrupted.push(dependent)
          dependent.output = `Prerequisite ${source.id} was challenged; inspect the new evidence and propose a replacement.`
          this.store.put('tasks', dependent)
          this.store.event(missionId, 'task/invalidated', 'runtime', { taskId: dependent.id, sourceTaskId: source.id, evidenceId: evidence.id })
        }
      }
      this.store.event(missionId, 'evidence/challenged', key, input)
      // The challenged claim's own task is the subject; the dependents it
      // invalidated are named by the `task/invalidated` events, not merged into it.
      this.notify(missionId, `Evidence ${evidence.id} challenged: ${input.reason}`, this.interpretation(missionId).subjectsOf([source]), { from: key })
    })
    for (const dependent of interrupted) this.attempts.resumeStoppedAttempt(missionId, dependent)
    this.kick(missionId)
    return evidence
  }
  /** Fence the old attempt immediately; quiescence and reassignment occur after this tool returns. */
  handoff(actor: Actor, missionId: string, input: { taskId: string; attemptId: string; to?: string; summary: string }): { handoff: string } {
    const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
    this.bounded(input.summary)
    if (input.to && !this.store.list('members', missionId).some(m => m.id === input.to && memberPhaseOf(m) !== 'stopped')) throw new Error('Unknown new owner')
    // F1: a review may only move to a member who can actually own it. Every other
    // assignment path (propose, controlTask, claim and the dispatcher) refuses an
    // author of the reviewed source, so a handoff that skipped the check left the
    // review bound to a member who can never claim it: pending forever, blocking
    // completion, with no notice naming the cause.
    if (input.to !== undefined && task.reviewOf !== undefined && this.authorIds(this.task(missionId, task.reviewOf)).has(input.to)) throw new PolicyError('review_independence_required', 'authorization_error', '[review_independence_required] Review requires an independent assignee; that member authored the reviewed source. Hand this review to a member who never owned it, or hand off the source instead.')
    task.status = 'blocked'; task.handoff = input.summary; task.epoch++; task.assigneeId = input.to; this.dropAttempt(task)
    if (input.to !== undefined) task.plannedAssigneeId = input.to
    task.resumeAfterStop = { epoch: task.epoch, reason: 'handoff', memberId: member.id, at: Date.now() }
    this.commit(missionId, () => { this.store.put('tasks', task); this.store.event(missionId, 'task/handoff-started', member.id, { taskId: task.id, to: input.to ?? null, summary: input.summary }) })
    this.attempts.resumeStoppedAttempt(missionId, task)
    return { handoff: 'Ownership revoked; reassignment waits for the previous worker to stop. End your turn.' }
  }
  /**
   * Retire every review that can never reach a verdict because its source is
   * closed. Pending reviews could never start, running reviews would burn model
   * and host-check tokens and hold a lease until expiry, and quiescence-parked
   * reviews would re-pend after lease expiry against a source that can no longer
   * be reviewed. Each retirement fences the reviewer durably until its handle has
   * stopped and its workspace checkpoint has finished outside the transaction.
   * Must be called inside a mission transaction.
   */
  private retireReviewSiblings(missionId: string, sourceId: string, options: { exclude?: string; reason: string }): { retired: Task[]; released: Set<string> } {
    const retired: Task[] = []
    const released = new Set<string>()
    const sourceWithdrawn = this.task(missionId, sourceId).status === 'cancelled'
    for (const review of this.store.list('tasks', missionId)) {
      if (review.id === options.exclude || review.reviewOf !== sourceId) continue
      // A negative verdict remains blocked while its source needs repair. Once
      // the owner withdraws that source or an accepted replacement retires it,
      // its failed reviews are closed too; keep their verdict, output and evidence.
      const moot = review.status === 'pending' || review.status === 'running' || this.quiescencePending(review)
        || (sourceWithdrawn && review.status === 'blocked')
      if (!moot) continue
      const { previousStatus, attempt } = this.attempts.fenceForStop(review, { status: 'cancelled', cause: 'review-retired' })
      if (attempt !== undefined) {
        const owner = this.store.get('members', attempt.ownerId)
        if (owner !== undefined && memberPhaseOf(owner) !== 'stopped') {
          // Only the activity of the retired attempt: a member's own park is its
          // own intent and a retirement of somebody else's review never lifts it.
          delete owner.activity
          this.store.put('members', owner); released.add(owner.id)
        }
      }
      review.output = `${review.output ?? ''}\nSuperseded: ${options.reason}`.trim()
      this.store.put('tasks', review)
      this.store.event(missionId, 'task/review-retired', 'runtime', { taskId: review.id, reviewOf: sourceId, previousStatus,
        ...(attempt === undefined ? {} : { attemptId: attempt.id, ownerId: attempt.ownerId }), reason: options.reason })
      retired.push(review)
      if (review.resumeAfterStop !== undefined) this.defer(async () => this.attempts.resumeStoppedAttempt(missionId, this.task(missionId, review.id)))
    }
    return { retired, released }
  }
  /**
   * F2: the live independent review of a submitted source, if one can still
   * reach a verdict. Uses the shared admission predicate so admission,
   * scheduling and the owner notice agree on what "has a review" means.
   */
  private liveReview(missionId: string, source: Task): Task | undefined {
    const author = source.attempt?.ownerId ?? source.assigneeId
    const authors = this.authorIds(source)
    const live = new Set(this.store.list('members', missionId).filter(member => memberPhaseOf(member) !== 'stopped').map(member => member.id))
    const tasks = this.store.list('tasks', missionId)
    return liveReviewFor(tasks, source.id, author, live,
      review => (review.status === 'pending' || review.status === 'running' || this.quiescencePending(review))
        && [...live].some(memberId => !authors.has(memberId) && assignmentAllows(review, memberId, tasks)))
  }
  /**
   * F2/R11-16: why a freshly submitted artifact has no review path, or
   * undefined when it has one or produced no reviewable artifact. Reviewability
   * is derived from the captured artifact, never from the declared kind: a
   * research deliverable that captured an artifact is reviewed exactly like code,
   * and a task that captured nothing has nothing to review.
   */
  private missingReviewPath(task: Task): string | undefined {
    if (task.artifact === undefined) return undefined
    if (this.liveReview(task.missionId, task) !== undefined) return undefined
    return `no live independent verification task reviews this submitted ${task.kind} artifact; a review (kind verification, reviewOf ${task.id}) must be pending or running and assigned to a member who did not author it`
  }
  /**
   * F2: a submitted code deliverable no live review can accept is never
   * silently parked. After a grace period (one scheduler period, floor 1s) the
   * runtime records the missing review durably; once the board would otherwise
   * make no progress it admits a bounded independent verification, or wakes the
   * owner once with the exact task id and the concrete blocker. The grace keeps
   * the runtime from racing a review the author is proposing in the same turn
   * and keeps the durable log free of redundant events.
   */
  private admitMissingReviews(mission: Mission): void {
    const tasks = this.store.list('tasks', mission.id)
    const members = this.store.list('members', mission.id)
    const grace = Math.max(this.config.tickMs, AUTO_REVIEW_GRACE_MS)
    const unreviewable: Task[] = []
    for (const source of tasks) {
      if (source.status !== 'submitted' || source.artifact === undefined) continue
      if (this.liveReview(mission.id, source) !== undefined) continue
      const submission = this.latestSubmission(mission.id, source.id)
      if (submission !== undefined && submission.age < grace) continue
      this.reportMissingReview(mission, source, submission?.seq ?? 0)
      unreviewable.push(source)
    }
    if (!unreviewable.length || !this.reviewPathStalled(tasks, members)) return
    for (const source of unreviewable) {
      const blocked = this.withdrawnAutomaticReview(mission.id, source.id) ?? this.reviewPathBlocker(mission, source, members)
      if (blocked !== undefined) { this.notifyReviewBlocked(mission, source, blocked); continue }
      this.admitAutomaticReview(mission, source)
    }
  }
  /** The newest durable submission of one task: how long ago, and its event seq. */
  latestSubmission(missionId: string, taskId: string): { seq: number; age: number } | undefined {
    const event = this.store.latestTaskEvent(missionId, taskId, 'task/submitted')
    return event === undefined ? undefined : { seq: event.seq, age: Math.max(0, Date.now() - event.createdAt) }
  }
  /** Record the missing review once per submission; false when it is already recorded. */
  private reportMissingReview(mission: Mission, source: Task, submissionSeq: number): boolean {
    const key = `${mission.id}:${source.id}:${submissionSeq}`
    // S5: the durable `task/review-missing` event for this exact submission is
    // the gate; this re-read makes the in-memory set a pure cache.
    if (this.missingReviewRecorded(mission.id, source.id, submissionSeq)) return false
    const reason = this.missingReviewPath(source) ?? `no live independent verification task reviews this submitted ${source.kind} artifact`
    this.commit(mission.id, () => this.store.event(mission.id, 'task/review-missing', 'runtime', { taskId: source.id, kind: source.kind, submissionSeq, reason }))
    this.reviewPathReported.add(key)
    return true
  }
  /**
   * True when the durable event log already records a missing-review report for
   * this submission: a `task/review-missing` row for the task that is newer than
   * the latest `task/submitted` row for it. Derived from the store, so a
   * restarted runtime does not duplicate the audit row for the same submission.
   */
  private missingReviewRecorded(missionId: string, taskId: string, submissionSeq: number): boolean {
    const event = this.store.latestTaskEvent(missionId, taskId, 'task/review-missing')
    if (event === undefined) return false
    const data = event.data as { submissionSeq?: number }
    return data.submissionSeq === undefined ? event.seq > submissionSeq : data.submissionSeq === submissionSeq
  }
  /** An automatic review admitted earlier for this source, once the owner has withdrawn it. */
  private withdrawnAutomaticReview(missionId: string, sourceId: string): string | undefined {
    // Control facts never use the presentation event window. The deterministic
    // row also survives a failed post-admission event write and process restart.
    const source = this.task(missionId, sourceId)
    const event = this.store.latestTaskEvent(missionId, sourceId, 'task/review-admitted', 'reviewOf')
    const admitted = (event?.data as { taskId?: string } | undefined)?.taskId
    const current = this.store.get('tasks', this.automaticReviewId(source))
    const admittedId = current?.id ?? admitted
    if (admittedId === undefined) return undefined
    const review = this.store.get('tasks', admittedId)
    if (review === undefined || review.status !== 'cancelled') return undefined
    return `the automatically admitted review ${admittedId} was withdrawn; admit a replacement review (kind verification, reviewOf ${sourceId}) or cancel the source task`
  }
  private automaticReviewId(source: Task): string {
    return `task_auto_review_${createHash('sha256').update(`${source.missionId}:${source.id}:${source.artifact?.commit ?? ''}`).digest('hex').slice(0, 32)}`
  }
  /** The concrete reason the runtime cannot admit an independent review right now. */
  private reviewPathBlocker(mission: Mission, source: Task, members: Member[]): string | undefined {
    const tasks = this.store.list('tasks', mission.id)
    const deferred = tasks.find(task => task.status === 'blocked' && task.reviewOf === source.id && task.verificationRecovery?.commit === source.artifact?.commit)
    if (deferred !== undefined) return `review ${deferred.id} awaits repair of its recorded host verification failure; fix the environment or amend checkTimeoutMs, then resume the same review with swarm_control(action: "resume", taskId: "${deferred.id}", reason: "condition repaired")`
    if (mission.status !== 'active') return `the mission is ${mission.status}; a review can only start while the mission is active`
    if (tasks.length >= mission.budget.maxTasks) return `the mission task budget is exhausted (${tasks.length}/${mission.budget.maxTasks} admitted tasks), so no verification task can be admitted`
    const authors = this.authorIds(source)
    const author = source.attempt?.ownerId ?? source.assigneeId
    if (!members.some(member => memberPhaseOf(member) !== 'stopped' && !authors.has(member.id))) return `no live member other than the author (${author ?? 'unknown'}) can review this artifact independently; add an independent member and admit a verification task`
    return undefined
  }
  /** Admit the bounded independent review for one unreviewable submitted deliverable. */
  private admitAutomaticReview(mission: Mission, source: Task): void {
    let review: Task
    try {
      review = this.propose({ sessionId: mission.ownerSessionId }, mission.id, {
        workstreamId: source.workstreamId, title: `Independent review of ${source.title}`,
        objective: `Independently verify the submitted artifact of ${source.id} (${source.title}) against its acceptance criteria.`,
        kind: 'verification', scope: [...source.scope], acceptance: [...source.acceptance], checks: [...source.checks],
        // The host-admitted review reads an artifact and records a verdict; it
        // owes no file.
        outputs: [],
        reviewOf: source.id, maxRecoveryAttempts: AUTO_REVIEW_RECOVERY_ATTEMPTS, priority: source.priority,
        ...(source.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: source.checkTimeoutMs }),
      }, this.automaticReviewId(source))
    } catch (error) {
      // Admission can still refuse (a budget race). The submission stands;
      // the owner is told exactly what to admit instead.
      this.notifyReviewBlocked(mission, source, `automatic review admission failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    // The review already exists and its task/proposed event is durable; a busy
    // writer must not turn a successful admission into a false blocker notice.
    try {
      this.commit(mission.id, () => this.store.event(mission.id, 'task/review-admitted', 'runtime', {
        taskId: review.id, reviewOf: source.id, maxRecoveryAttempts: AUTO_REVIEW_RECOVERY_ATTEMPTS, reason: 'no live review existed for the submitted artifact',
      }))
    } catch { /* The next tick re-derives the live review from the admitted task. */ }
  }
  
  
  /**
   * Owner-only withdrawal of admitted-but-mistaken work. Pending, blocked,
   * submitted and running tasks become terminally cancelled; a running attempt
   * is fenced immediately, its lease released and its worker freed. Accepted
   * work is immutable and must be repaired with a replacement instead.
   */
  cancel(actor: Actor, missionId: string, input: { taskId: string; reason: string }): Task & { strandedDependents?: string[] } {
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    actor.signal?.throwIfAborted()
    const { mission, owner, key } = this.participant(actor, missionId)
    if (!owner) throw new PolicyError('task_cancel_owner_required', 'authorization_error', 'Only the mission owner can cancel admitted work')
    if (terminal(mission)) throw new PolicyError('mission_terminal', 'conflict_error', 'Mission is terminal; create a new mission to continue')
    this.bounded(input.reason)
    const task = this.task(missionId, input.taskId)
    if (task.status === 'accepted') throw new PolicyError('task_accepted_immutable', 'tool_error', `Task ${task.id} is accepted; accepted work is immutable. Propose a replacement instead.`)
    // Cancellation is terminal and idempotent: a replay never mutates or re-audits it.
    if (task.status === 'cancelled') return task
    const released = new Set<string>()
    const releaseMember = (memberId: string): Member | undefined => {
      const member = this.store.get('members', memberId)
      if (member === undefined || memberPhaseOf(member) === 'stopped') return undefined
      // Only the activity of the withdrawn attempt: a member parked by its own
      // `swarm_wait` stays parked through the withdrawal of somebody's task.
      delete member.activity
      return member
    }
    const strandedDependents: string[] = []
    // The fence and every row it implies commit together: the closer event the
    // replay decoder reads must never outlive a transaction that rolled back.
    this.commit(missionId, () => {
      const { previousStatus, attempt, stopOwner } = this.attempts.fenceForStop(task, { status: 'cancelled', cause: 'owner-cancel' })
      task.output = `${task.output ?? ''}\nCancelled by the mission owner: ${input.reason}`.trim()
      const ownerMember = stopOwner === undefined ? undefined : releaseMember(stopOwner)
      if (ownerMember !== undefined) released.add(ownerMember.id)
      this.store.put('tasks', task)
      if (ownerMember !== undefined) this.store.put('members', ownerMember)
      // Pending, running and quiescence-parked reviews of withdrawn work can
      // never reach a verdict; retire them explicitly so none re-pends after
      // lease expiry and becomes unclaimable against a cancelled source.
      const { released: reviewers } = this.retireReviewSiblings(missionId, task.id, { exclude: task.id, reason: `${task.id} was cancelled by the mission owner` })
      for (const reviewerId of reviewers) released.add(reviewerId)
      // Withdrawal strands admitted dependents whose lineage no longer reaches
      // live work. They stay pending (and repairable) instead of being treated
      // as dead; the owner is told which replacement obligation to admit.
      for (const dependent of this.store.list('tasks', missionId)) {
        if (dependent.id === task.id || dependent.status !== 'pending') continue
        const references = dependent.dependencies.some(dependency => this.dependencyIdentities(missionId, dependency).has(task.id))
        if (references && dependent.dependencies.some(dependency => !this.dependencySatisfied(missionId, dependency))) strandedDependents.push(dependent.id)
      }
      this.store.event(missionId, 'task/cancelled', key, { taskId: task.id, reason: input.reason, previousStatus,
        ...(attempt === undefined ? {} : { attemptId: attempt.id, ownerId: attempt.ownerId }),
        ...(strandedDependents.length ? { strandedDependents } : {}) })
      if (strandedDependents.length) {
        // The withdrawn task and every stranded dependent are the subjects: the
        // decision names exactly the obligations the owner must replace. The
        // subject list comes from the shared interpretation, not a second read.
        const view = this.interpretation(missionId)
        this.notify(missionId, `Cancelling ${task.id} stranded admitted dependents ${strandedDependents.join(', ')}. Propose a replacement for ${task.id} with replaces; dependents resolve to the live repair automatically.`, view.subjectsOf([task, ...view.tasks.filter(candidate => strandedDependents.includes(candidate.id))]), { from: key })
      }
    })
    if (task.resumeAfterStop !== undefined) this.attempts.resumeStoppedAttempt(missionId, task)
    this.kick(missionId)
    return { ...task, ...(strandedDependents.length ? { strandedDependents } : {}) }
  }
  subscribeTopics(actor: Actor, missionId: string, topics: string[]): Member {
    const { member } = this.active(actor, missionId)
    if (!member) throw new PolicyError('member_required', 'tool_error', 'Only members have topic subscriptions')
    if (!Array.isArray(topics) || topics.some(t => typeof t !== 'string' || t.length > 200)) throw new Error('Invalid topics')
    member.subscriptions = [...new Set(topics)]
    this.commit(missionId, () => { this.store.put('members', member); this.store.event(missionId, 'member/subscribed', member.id, { topics }) })
    return member
  }
  wait(actor: Actor, missionId: string): { waiting: boolean } {
    const { member } = this.active(actor, missionId)
    if (!member) throw new PolicyError('member_required', 'tool_error', 'Only members can park themselves')
    // R10-15: a park must never strand a running attempt. Parking it leaves the
    // task running with a parked owner until lease expiry, which burns a
    // recovery credit and hides the stall behind a live-lease classification.
    // Refuse with the supported exits; an unowned member may still park.
    const open = this.store.list('tasks', missionId).find(task => task.status === 'running' && task.attempt?.ownerId === member.id)
    if (open?.attempt) throw new Error(`You still hold running attempt ${open.attempt.id} on task ${open.id} (${open.title}). swarm_wait cannot park a member that owns a running attempt: submit it with swarm_submit/swarm_verify, release it with swarm_handoff, or keep working. Parking it would leave the attempt running until lease expiry.`)
    member.phase = 'parked'
    this.commit(missionId, () => { this.store.put('members', member); this.store.event(missionId, 'member/waiting', member.id, {}) })
    return { waiting: true }
  }
  /** List only missions belonging to this user session. */
  list(ownerSessionId: string): Mission[] { return this.store.list('missions').filter(m => m.ownerSessionId === ownerSessionId) }
  /** Historical worker sessions never become independent owners when their membership stops. */
  isWorkerSession(sessionId: string): boolean { return this.store.list('members').some(member => member.sessionId === sessionId) }
  /** Owner-only history of natural-language requests; workers do not gain planning authority. */
  starts(actor: Actor): AutoStart[] {
    actor.signal?.throwIfAborted()
    return this.store.list('starts').filter(request => request.ownerSessionId === actor.sessionId)
  }
  private ownedStart(actor: Actor, requestId: string): AutoStart {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    const request = this.store.get('starts', requestId)
    if (!request || request.ownerSessionId !== actor.sessionId || this.isWorkerSession(actor.sessionId)) throw new Error('Automatic request is not owned by this user session')
    return request
  }
  /** Admit once before any planning model call. Human command identity survives retries. */
  requestStart(actor: Actor, input: RequestStartInput): AutoStart {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    if (this.isWorkerSession(actor.sessionId)) throw new PolicyError('worker_cannot_own_mission', 'authorization_error', 'Workers cannot create independent missions or budgets')
    requireText(input.commandId, 'commandId')
    if (input.commandId.length > 200) throw new Error('commandId exceeds 200 characters')
    const goal = this.bounded(input.goal).trim()
    if (!isAbsolute(input.workspace)) throw new PolicyError('workspace_not_absolute', 'validation_error', 'workspace must be an absolute path')
    const budget = input.budget === undefined ? undefined : validatedBudget(input.budget)
    const prior = this.starts(actor).find(request => request.commandId === input.commandId)
    if (prior) {
      if (prior.goal !== goal || prior.workspace !== input.workspace) throw new Error('Automatic command identity conflicts with a different request')
      return prior
    }
    if (this.starts(actor).some(request => ['planning', 'launching', 'running'].includes(request.status))) throw new PolicyError('automatic_request_in_progress', 'conflict_error', 'This session already has an automatic swarm request in progress')
    if (this.starts(actor).filter(request => request.status === 'failed').length >= 32) throw new Error('Too many failed automatic requests; retry a saved request')
    const now = Date.now()
    const authorized = this.assertAuthorizedRoot(input.workspace, input.workspaceGrantRoot, input.workspaceAuthorizationSource)
    const request: AutoStart = { id: id('start'), ownerSessionId: actor.sessionId, commandId: input.commandId, goal, workspace: input.workspace, workspaceGrantRoot: authorized.grantRoot, workspaceAuthorizationSource: authorized.source,
      budget, status: 'planning', planningEpoch: 1, planningDeadlineAt: now + (this.config.planningTimeoutMs ?? 600000), createdAt: now, updatedAt: now }
    this.commit(request.id, () => {
      this.store.put('starts', request)
      this.store.event(request.id, 'automatic/requested', 'owner', { requestId: request.id, commandId: request.commandId, goal })
    })
    return request
  }
  /** Capture before the owner's planning turn; retries retain the same immutable files. */
  async prepareStart(actor: Actor, requestId: string, expectedEpoch?: number): Promise<AutoStart> {
    const admittedEpoch = expectedEpoch ?? (this.ownedStart(actor, requestId).planningEpoch ?? 1)
    return this.exclusive(requestId, async () => {
      const request = this.ownedStart(actor, requestId)
      if (!['planning', 'failed'].includes(request.status) || request.planningFenced || (request.planningEpoch ?? 1) !== admittedEpoch) throw new Error('Request is no longer awaiting planning; inspect the saved request and retry through swarm_control')
      if (request.baseline) return request
      if (!this.workers.prepareBaseline) throw new Error('This worker adapter cannot snapshot a project for automatic planning')
      const controller = new AbortController()
      this.startControllers.set(requestId, controller)
      const signal = actor.signal ? AbortSignal.any([actor.signal, controller.signal]) : controller.signal
      try {
        // T3e: the synthetic baseline record must carry the request's recorded
        // authorization. Dropping the source makes the X3 fail-closed rule fence a
        // session-cwd request before planning (the native /agent-swarm path);
        // dropping the root loses the grant anchor for a granted request.
        const baseline = await abortableStart(this.workers.prepareBaseline({
          id: `mission_draft_${request.id}`,
          workspace: request.workspace,
          ...(request.workspaceGrantRoot === undefined ? {} : { workspaceGrantRoot: request.workspaceGrantRoot }),
          ...(request.workspaceAuthorizationSource === undefined ? {} : { workspaceAuthorizationSource: request.workspaceAuthorizationSource }),
        }, signal), signal)
        signal.throwIfAborted()
        const current = this.ownedStart(actor, requestId)
        if (!['planning', 'failed'].includes(current.status) || current.planningFenced || (current.planningEpoch ?? 1) !== admittedEpoch) throw new Error('Snapshot preparation was interrupted')
        current.baseline = baseline; current.updatedAt = Date.now()
        this.commit(request.id, () => { this.store.put('starts', current); this.store.event(request.id, 'workspace/snapshot', 'runtime', baseline) })
        return current
      } finally { if (this.startControllers.get(requestId) === controller) this.startControllers.delete(requestId) }
    })
  }
  /** Queue-independent prelaunch watchdog: no mission or worker lease exists yet. */
  private sweepStarts(): void {
    for (const request of this.store.list('starts')) {
      if (!['planning', 'launching'].includes(request.status)) continue
      const deadline = request.planningDeadlineAt ?? request.updatedAt + (this.config.planningTimeoutMs ?? 600000)
      const remaining = deadline - Date.now()
      if (remaining > 0) {
        const threshold = Math.max(30000, Math.ceil((this.config.planningTimeoutMs ?? 600000) * 0.2))
        if (remaining <= threshold && request.planningWarning?.deadline !== deadline) {
          request.planningDeadlineAt = deadline
          request.planningWarning = { deadline, threshold }
          this.commit(request.missionId ?? request.id, () => {
            this.store.put('starts', request)
            this.store.event(request.missionId ?? request.id, 'mission/budget-warning', 'runtime', {
              requestId: request.id, dimension: 'planningDurationMs', deadline, remaining, threshold,
            })
          })
        }
        continue
      }
      this.failStart({ sessionId: request.ownerSessionId }, request.id,
        'Planning or launch exceeded its deadline. The saved request and snapshot are retained. Inspect the request with swarm_observe, then use swarm_control with requestId and action=retry, or action=stop.', request.planningEpoch ?? 1)
    }
  }
  /** Retire an assembly revision before releasing its caller; a hung body cannot hold the saved draft hostage. */
  private fenceStartDraft(request: AutoStart): void {
    const draft = request.draftId ? this.store.get('drafts', request.draftId) : undefined
    if (draft?.status !== 'launching') return
    draft.status = 'failed'; draft.revision++; draft.updatedAt = Date.now()
    draft.error = request.error ?? 'Planning attempt was superseded; retry the saved request'
    this.store.put('drafts', draft)
  }
  /** Owner decisions before mission activation never wait behind snapshot or launch I/O. */
  controlStart(actor: Actor, requestId: string, action: 'retry' | 'stop' | 'extend', reason: string, timeoutMs?: number): AutoStart {
    const request = this.ownedStart(actor, requestId)
    this.bounded(reason)
    if (!['retry', 'stop', 'extend'].includes(action)) throw new Error('Unknown automatic request action; use retry, stop or extend')
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(Date.now() + timeoutMs))) throw new Error('timeoutMs must be a positive safe duration in milliseconds')
    const mission = request.missionId ? this.store.get('missions', request.missionId) : undefined
    if (mission && mission.status !== 'staged') throw new Error('This request already launched; control its missionId instead')
    if (action === 'extend') {
      if (!['planning', 'launching'].includes(request.status)) throw new Error('Only an active planning request can be extended; use retry for a failed request')
      request.planningDeadlineAt = Date.now() + (timeoutMs ?? this.config.planningTimeoutMs ?? 600000)
    } else {
      if (action === 'retry' && request.status !== 'failed') throw new Error('Only a failed automatic request can be retried; stop an unwanted request or extend active planning')
      if (action === 'retry' && this.starts(actor).some(other => other.id !== requestId && ['planning', 'launching', 'running'].includes(other.status))) throw new PolicyError('automatic_request_in_progress', 'conflict_error', 'This session already has an automatic swarm request in progress')
      if (action === 'stop' && request.status === 'stopped') return request
      this.startControllers.get(requestId)?.abort(new Error(reason))
      request.planningEpoch = (request.planningEpoch ?? 1) + 1
      request.status = action === 'stop' ? 'stopped' : 'planning'
      request.planningFenced = action === 'stop'
      request.planningDispatchPending = action === 'retry'
      delete request.recoveryNoticePending
      if (action === 'retry') {
        request.planningDeadlineAt = Date.now() + (timeoutMs ?? this.config.planningTimeoutMs ?? 600000)
        delete request.error
      } else request.error = reason
    }
    request.updatedAt = Date.now()
    this.commit(request.missionId ?? request.id, () => {
      this.store.put('starts', request)
      if (action !== 'extend') this.fenceStartDraft(request)
      this.store.event(request.missionId ?? request.id, action === 'stop' ? 'automatic/failed' : 'automatic/requested', 'owner', { requestId, action, reason, planningEpoch: request.planningEpoch, deadline: request.planningDeadlineAt })
    })
    if (action === 'stop' && mission?.status === 'staged') this.control(actor, mission.id, 'stop', reason)
    return request
  }
  /** Inbox admission acknowledgement is a generation-checked durable write. */
  ackStartMessage(actor: Actor, requestId: string, epoch: number, kind: 'planning' | 'failure'): void {
    const request = this.ownedStart(actor, requestId)
    if ((request.planningEpoch ?? 1) !== epoch) return
    const field = kind === 'planning' ? 'planningDispatchPending' : 'recoveryNoticePending'
    if (!request[field]) return
    delete request[field]
    this.commit(request.missionId ?? request.id, () => this.store.put('starts', request))
  }
  /** Keep the journal synchronized inside the same transaction as mission control. */
  private syncStarts(mission: Mission): void {
    for (const request of this.store.list('starts', mission.id)) {
      if (mission.status === 'staged') continue
      request.status = mission.status === 'completed' ? 'completed' : mission.status === 'stopped' ? 'stopped' : 'running'
      request.budget = { ...mission.budget }
      request.updatedAt = Date.now(); delete request.error
      delete request.planningDispatchPending; delete request.recoveryNoticePending
      this.store.put('starts', request)
    }
  }
  /** Record an admission failure without revoking an already launched mission. */
  failStart(actor: Actor, requestId: string, reason: string, expectedEpoch?: number): AutoStart {
    const request = this.ownedStart(actor, requestId)
    if (expectedEpoch !== undefined && (request.planningEpoch ?? 1) !== expectedEpoch) return request
    this.bounded(reason)
    const mission = request.missionId ? this.store.get('missions', request.missionId) : undefined
    if (mission && mission.status !== 'staged') {
      this.commit(mission.id, () => this.syncStarts(mission))
      return this.ownedStart(actor, requestId)
    }
    if (request.status === 'stopped' || request.status === 'completed') return request
    request.status = 'failed'; request.error = reason; request.updatedAt = Date.now()
    request.planningFenced = true; request.recoveryNoticePending = true
    delete request.planningDispatchPending
    this.startControllers.get(requestId)?.abort(new Error(reason))
    this.commit(request.missionId ?? request.id, () => {
      this.store.put('starts', request)
      this.fenceStartDraft(request)
      this.store.event(request.missionId ?? request.id, 'automatic/failed', 'runtime', { requestId, reason })
    })
    return request
  }
  /** Automatic requests must contain a complete independently verifiable topology. */
  private automaticPlan(input: PlanInput, request: AutoStart): PlanInput {
    const plan = validatePlan({ ...input, workspace: request.workspace, ...(request.workspaceGrantRoot === undefined ? {} : { workspaceGrantRoot: request.workspaceGrantRoot }), ...(request.workspaceAuthorizationSource === undefined ? {} : { workspaceAuthorizationSource: request.workspaceAuthorizationSource }) }, { launch: true, dependencyDirs: this.config.verificationDependencyDirs })
    // New automatic plans use preferences; old/manual task rows keep their binding.
    for (const task of plan.tasks) if (task.assigneeKey !== undefined) task.assignmentMode ??= 'preferred'
    // Collect every automatic-policy issue so one repair round fixes the whole plan.
    const issues: string[] = []
    if (plan.members.length < 2) issues.push('Automatic plans require at least two independent workers')
    for (const member of plan.members) if (member.maxOutputTokens === undefined) issues.push(`members[${member.key}].maxOutputTokens is required: choose this worker's per-request output allowance`)
    const sources = plan.tasks.filter(task => task.kind !== 'verification')
    if (!sources.length) issues.push('Automatic plans require deliverable work')
    for (const task of plan.tasks) {
      if (task.maxRecoveryAttempts === undefined) issues.push(`tasks[${task.key}].maxRecoveryAttempts is required: choose the allowed automatic recovery attempts`)
      if (task.kind !== 'verification' && task.checks?.length && task.checkTimeoutMs === undefined) issues.push(`tasks[${task.key}].checkTimeoutMs is required because it has checks`)
    }
    for (const source of sources) {
      if (!source.assigneeKey || !plan.tasks.some(review => review.kind === 'verification' && review.reviewOf === source.key && review.assigneeKey && review.assigneeKey !== source.assigneeKey)) {
        issues.push(`tasks[${source.key}] requires an assigned independent verification task (kind verification, reviewOf ${source.key}, assigneeKey different from ${source.assigneeKey ?? 'its assignee'})`)
      }
    }
    const missingCriteria = plan.acceptance.filter(criterion => !sources.some(task => task.acceptance.includes(criterion)))
    if (missingCriteria.length) issues.push(`Deliverables must cover every mission acceptance criterion. Missing exact acceptance strings: ${JSON.stringify(missingCriteria)}. Copy each missing string into the acceptance array of the deliverable task that satisfies it; a paraphrase does not match.`)
    const implementations = sources.filter(task => task.kind === 'implementation')
    const byKey = new Map(plan.tasks.map(task => [task.key, task]))
    const dependsOn = (key: string, dependency: string): boolean => {
      const pending = [...(byKey.get(key)?.dependencies ?? [])], visited = new Set<string>()
      while (pending.length) {
        const parent = pending.pop()!
        if (parent === dependency) return true
        if (visited.has(parent)) continue
        visited.add(parent); pending.push(...(byKey.get(parent)?.dependencies ?? []))
      }
      return false
    }
    const integrations = sources.filter(task => task.kind === 'integration')
    // One reviewed implementation is deliverable on its own; assembling several branches needs a final integration.
    if (implementations.length > 1 && !integrations.some(task => implementations.every(implementation => dependsOn(task.key, implementation.key)))) {
      issues.push('Plans with several implementation tasks require a final integration task depending on every implementation deliverable')
    } else if (implementations.length === 1 && integrations.length && !integrations.some(task => dependsOn(task.key, implementations[0]!.key))) {
      issues.push(`The integration task must depend on implementation ${implementations[0]!.key}, or be omitted so the reviewed implementation is delivered directly`)
    }
    if (issues.length) throw new Error(`Automatic plan rejected; repair every item and retry the same requestId:\n${issues.join('\n')}`)
    return plan
  }
  /**
   * Launch one validated generated plan under the saved human request's workspace
   * while the primary agent chooses its resource budget. Retries resume the same
   * draft/member identities and accounting, including after interrupted assembly.
   */
  async startPlan(actor: Actor, requestId: string, input: PlanInput, planningEpoch?: number): Promise<Snapshot> {
    const admittedEpoch = planningEpoch ?? 1
    return this.exclusive(requestId, async () => {
      let request = this.ownedStart(actor, requestId)
      if ((request.planningEpoch ?? 1) !== admittedEpoch || request.planningFenced) throw new PolicyError('planning_attempt_stale', 'conflict_error', 'Planning attempt is stale or cancelled. Inspect the saved request; retry a failed request with swarm_control, then pass its current planningEpoch to swarm_launch.')
      const priorMission = request.missionId ? this.store.get('missions', request.missionId) : undefined
      if (priorMission && priorMission.status !== 'staged') {
        if (priorMission.status === 'stopped') throw new PolicyError('automatic_mission_stopped', 'conflict_error', 'Automatic mission was stopped; start a new request to continue')
        this.commit(priorMission.id, () => this.syncStarts(priorMission))
        return this.snapshot(actor, priorMission.id)
      }
      if (request.status === 'stopped' || request.status === 'completed') throw new PolicyError('automatic_request_not_launchable', 'conflict_error', 'Automatic request cannot be launched in its current state')
      if (this.starts(actor).some(other => other.id !== requestId && ['planning', 'launching', 'running'].includes(other.status))) throw new PolicyError('automatic_request_in_progress', 'conflict_error', 'This session already has an automatic swarm request in progress')
      const controller = new AbortController()
      this.startControllers.set(requestId, controller)
      const launchActor: Actor = { sessionId: actor.sessionId, signal: actor.signal ? AbortSignal.any([actor.signal, controller.signal]) : controller.signal }
      try {
        const existing = request.draftId ? this.store.get('drafts', request.draftId) : undefined
        const plan = this.automaticPlan(input, request)
        request.budget = { ...plan.budget }
        request.draftId ??= `draft_${request.id}`
        request.missionId ??= `mission_${request.draftId}`
        request.status = 'launching'; request.updatedAt = Date.now(); delete request.error
        request.planningDeadlineAt = Math.max(request.planningDeadlineAt ?? 0, Date.now() + (this.config.planningTimeoutMs ?? 600000))
        this.commit(request.id, () => this.store.put('starts', request))
        launchActor.signal!.throwIfAborted()
        // Saving the deterministic link before the draft makes a crash between
        // these commits recoverable without creating an orphan or a duplicate.
        const draft = existing
          ? (JSON.stringify(existing.input) === JSON.stringify(plan) ? existing : this.updateDraft(launchActor, existing.id, existing.revision, plan))
          : this.createDraft(launchActor, plan, request.draftId)
        launchActor.signal!.throwIfAborted()
        const snapshot = await abortableStart(this.launchDraft(launchActor, draft.id, draft.revision), launchActor.signal!)
        // The activation commit is authoritative even if cancellation raced its
        // acknowledgment; never report an active mission as an unlaunched retry.
        this.commit(snapshot.mission.id, () => {
          const launched = this.mission(snapshot.mission.id)
          const planning = this.store.get('starts', requestId)
          if (planning?.ownerUsage) {
            launched.ownerUsage = addUsage(launched.ownerUsage, planning.ownerUsage); delete planning.ownerUsage
            this.store.put('missions', launched); this.store.put('starts', planning)
          }
          this.syncStarts(launched)
        })
        this.kick(snapshot.mission.id)
        return this.snapshot({ sessionId: actor.sessionId }, snapshot.mission.id)
      } catch (error) {
        if (!this.closed) {
          request = this.store.get('starts', requestId)!
          const mission = request.missionId ? this.store.get('missions', request.missionId) : undefined
          if (mission && mission.status !== 'staged') this.commit(mission.id, () => this.syncStarts(mission))
          else if ((request.planningEpoch ?? 1) === admittedEpoch && !request.planningFenced && request.status !== 'stopped') {
            request.status = 'failed'; request.error = String(error).slice(0, this.config.maxMessageChars); request.updatedAt = Date.now()
            this.commit(request.missionId ?? request.id, () => {
              this.store.put('starts', request)
              this.store.event(request.missionId ?? request.id, 'automatic/failed', 'runtime', { requestId, reason: request.error })
            })
          }
        }
        throw error
      } finally { if (this.startControllers.get(requestId) === controller) this.startControllers.delete(requestId) }
    })
  }
  /** Native browser callers select an existing Harness session; membership still bounds reads. */
  visibleMissions(actor: Actor): Mission[] {
    const memberMissions = new Set(this.store.list('members').filter(m => m.sessionId === actor.sessionId && memberPhaseOf(m) !== 'stopped').map(m => m.missionId))
    return this.store.list('missions').filter(m => m.ownerSessionId === actor.sessionId || memberMissions.has(m.id))
  }
  visibleSnapshots(actor: Actor): Snapshot[] { return this.visibleMissions(actor).map(m => this.snapshot(actor, m.id)) }
  /**
   * Read-only cross-mission artifact registry (R11-14 / R10-10): for every
   * mission this session may see, each captured artifact commit with its task
   * and mission identity, the task's acceptance state and the independent
   * review verdict. Per-mission artifact refs are private (A2-04), so this
   * durable projection is the sanctioned read path for cross-mission
   * artifacts. It reads records only and never mutates mission state.
   */
  artifacts(actor: Actor, query: { missionId?: string } = {}): unknown {
    actor.signal?.throwIfAborted()
    if (this.isWorkerSession(actor.sessionId)) throw new Error('Only the primary user session may read the cross-mission artifact registry')
    const visible = this.visibleMissions(actor)
    const missions = query.missionId === undefined ? visible : visible.filter(mission => mission.id === query.missionId)
    if (query.missionId !== undefined && missions.length === 0) throw new Error('Unknown mission or not visible to this session')
    const rows: Array<Record<string, unknown>> = []
    for (const mission of missions) {
      const tasks = this.store.list('tasks', mission.id)
      for (const task of tasks) {
        const captured = task.kind === 'verification' ? task.reviewArtifact : task.artifact
        if (captured === undefined) continue
        const review = tasks.filter(candidate => candidate.reviewOf === task.id && candidate.status !== 'cancelled')
          .sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0]
        // A blocked review is not a refutation. Only `verify()` records the commit
        // the review actually read, and only its deferred branch leaves a
        // `verificationRecovery` obligation behind, so a review blocked by a
        // preparation failure, its own ceiling, a fence or an unreproducible check
        // environment used to be published across missions as a verdict against an
        // artifact no reviewer had judged.
        const refuted = review?.status === 'blocked' && review.reviewedCommit !== undefined && review.verificationRecovery === undefined
        rows.push({
          missionId: mission.id, missionTitle: mission.title, missionStatus: mission.status,
          missionAcceptance: mission.acceptance,
          taskId: task.id, taskTitle: task.title, taskKind: task.kind, taskStatus: task.status,
          acceptance: task.acceptance,
          artifact: { commit: captured.commit, baseCommit: captured.baseCommit, changedPaths: captured.changedPaths },
          ...(task.kind === 'verification' ? { artifactRole: 'review-record', reviewedCommit: task.reviewedCommit } : {}),
          ...(review === undefined ? {} : { review: { taskId: review.id, status: review.status,
            verdict: review.status === 'accepted' ? 'verified' : refuted ? 'refuted' : 'pending',
            ...(review.output === undefined ? {} : { reason: excerpt(review.output, 400) }) } }),
        })
      }
    }
    return {
      artifacts: rows, total: rows.length, missions: missions.map(mission => mission.id),
      note: 'Read-only registry over durable records: artifact commit, task, mission, acceptance state and review verdict. Per-mission artifact refs are private; this is the sanctioned cross-mission read path. Reading it changes no state.',
    }
  }
  drafts(actor: Actor): DraftPlan[] { return this.store.list('drafts').filter(d => d.ownerSessionId === actor.sessionId && d.status !== 'discarded') }
  private ownedDraft(actor: Actor, draftId: string): DraftPlan {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    const draft = this.store.get('drafts', draftId)
    if (!draft || draft.ownerSessionId !== actor.sessionId) throw new PolicyError('draft_not_owned', 'authorization_error', 'Draft is not owned by this session')
    return draft
  }
  private prepareDraftInput(input: PlanInput) {
    const admitted = validatePlan(input, { dependencyDirs: this.config.verificationDependencyDirs })
    const authorized = this.assertAuthorizedRoot(admitted.workspace, input.workspaceGrantRoot, input.workspaceAuthorizationSource)
    // Store the authorization anchor on the draft, outside its canonical plan.
    const { workspaceGrantRoot: _claimedRoot, workspaceAuthorizationSource: _claimedSource, ...clean } = admitted
    return { clean, authorized }
  }
  /** Saving a plan creates no workers, worktrees or model calls. */
  createDraft(actor: Actor, input: PlanInput, admittedId?: string): DraftPlan {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    if (this.store.list('members').some(m => m.sessionId === actor.sessionId)) throw new PolicyError('draft_owner_required', 'authorization_error', 'Workers cannot create independent missions or budgets')
    if (this.drafts(actor).filter(d => ['draft', 'failed', 'launching'].includes(d.status)).length >= 32) throw new PolicyError('draft_limit_reached', 'budget_error', 'Discard unused drafts before creating more')
    const now = Date.now()
    if (admittedId && this.store.get('drafts', admittedId)) throw new PolicyError('draft_identity_conflict', 'conflict_error', 'Draft admission identity already exists')
    const { clean, authorized } = this.prepareDraftInput(input)
    const advisories = planAdvisories(clean)
    const draft: DraftPlan = { id: admittedId ?? id('draft'), ownerSessionId: actor.sessionId, revision: 1, status: 'draft', input: clean, advisories: advisories.slice(0, 20).map(formatDiagnostic), workspaceGrantRoot: authorized.grantRoot, workspaceAuthorizationSource: authorized.source, createdAt: now, updatedAt: now }
    this.commit(draft.id, () => { this.store.put('drafts', draft); this.store.event(draft.id, 'plan/staged', 'owner', { draftId: draft.id, revision: draft.revision, advisories }) })
    return draft
  }
  updateDraft(actor: Actor, draftId: string, revision: number, input: PlanInput): DraftPlan {
    const draft = this.ownedDraft(actor, draftId)
    if (draft.revision !== revision) throw new PolicyError('draft_revision_conflict', 'conflict_error', 'Draft changed; reload before saving')
    if (!['draft', 'failed'].includes(draft.status)) throw new PolicyError('draft_not_editable', 'conflict_error', 'Only draft or failed plans can be edited while dispatch is closed')
    const { clean, authorized } = this.prepareDraftInput(input)
    this.validateDraftRepair(draft, clean)
    const previousInput = draft.input
    const advisories = planAdvisories(clean)
    draft.advisories = advisories.slice(0, 20).map(formatDiagnostic)
    draft.input = clean; draft.workspaceGrantRoot = authorized.grantRoot; draft.workspaceAuthorizationSource = authorized.source; draft.revision++; draft.updatedAt = Date.now()
    delete draft.error
    this.commit(draft.id, () => { this.store.put('drafts', draft); this.store.event(draft.id, 'plan/edited', 'owner', { draftId, revision: draft.revision, previousInput, input: clean, advisories }) })
    return draft
  }
  discardDraft(actor: Actor, draftId: string, revision: number): DraftPlan {
    const draft = this.ownedDraft(actor, draftId)
    if (draft.revision !== revision) throw new PolicyError('draft_revision_conflict', 'conflict_error', 'Draft changed; reload before discarding')
    if (!['draft', 'failed'].includes(draft.status)) throw new PolicyError('draft_not_discardable', 'conflict_error', 'A launching or launched plan cannot be discarded; stop its mission instead')
    if (draft.missionId) {
      const mission = this.store.get('missions', draft.missionId)
      if (mission && !terminal(mission)) this.control(actor, mission.id, 'stop', 'Discarded the unlaunched plan after an assembly failure')
    }
    draft.status = 'discarded'; draft.revision++; draft.updatedAt = Date.now()
    this.commit(draft.id, () => this.store.put('drafts', draft))
    return draft
  }
  /** Check a saved repair while dispatch remains fenced; submitted facts are immutable. */
  private validateDraftRepair(draft: DraftPlan, input: PlanInput): void {
    const mission = draft.missionId ? this.store.get('missions', draft.missionId) : undefined
    if (!mission) return
    if (mission.status !== 'staged') throw new PolicyError('draft_repair_not_staged', 'conflict_error', 'Only a staged mission can repair its saved draft')
    if (input.workspace !== mission.workspace) throw new PolicyError('draft_repair_workspace_changed', 'validation_error', 'A staged plan must retain its saved workspace and baseline')
    const missing = draft.input.acceptance.filter(criterion => !input.acceptance.includes(criterion))
    if (missing.length) throw new PolicyError('draft_repair_acceptance_dropped', 'validation_error', `Draft repair must retain the original acceptance obligations: ${JSON.stringify(missing)}`)
    for (const original of draft.input.tasks) {
      const next = input.tasks.find(task => task.key === original.key)
      const admitted = mission ? this.store.get('tasks', `task_${draft.id}_${original.key}`) : undefined
      const immutable = admitted && (admitted.artifact || admitted.attempt || admitted.evidenceIds.length || ['submitted', 'accepted', 'running'].includes(admitted.status))
      if (immutable && JSON.stringify(next) !== JSON.stringify(original)) throw new PolicyError('draft_repair_task_immutable', 'conflict_error', `Task ${admitted.id} has execution or immutable evidence; preserve it and revise separate unsubmitted work`)
      if (next && original.kind !== next.kind && admitted) throw new PolicyError('draft_repair_kind_changed', 'validation_error', `Task ${admitted.id} must retain its kind; use a new plan key for incompatible work`)
      const carriers = next ? [next] : input.tasks.filter(task => task.kind === original.kind)
      const obligations = [...original.acceptance, ...(admitted?.acceptance ?? [])]
      if (original.kind !== 'verification' && obligations.some(criterion => !carriers.some(task => task.acceptance.includes(criterion)))) {
        throw new PolicyError('draft_repair_acceptance_dropped', 'validation_error', `Draft repair must retain the acceptance obligations of task ${original.key}`)
      }
      if (admitted?.status === 'cancelled' && next) throw new PolicyError('draft_repair_task_cancelled', 'conflict_error', `Task ${admitted.id} was cancelled by the owner; use a new key instead of reviving it`)
    }
  }
  /** Reconcile only unused staged resources; retain compatible ids, baseline, usage and recorded artifacts. */
  private async repairDraftAdmissions(actor: Actor, draft: DraftPlan, input: PlanInput, assertCurrent: () => void): Promise<void> {
    if (!draft.missionId) return
    let mission = this.store.get('missions', draft.missionId)
    if (!mission) return
    const assertStaged = () => {
      assertCurrent()
      if (this.mission(draft.missionId!).status !== 'staged' || this.store.get('drafts', draft.id)?.revision !== draft.revision) throw new PolicyError('plan_repair_interrupted', 'conflict_error', 'Plan repair was interrupted')
    }
    assertStaged()
    await this.assertWorkspaceAuthorized(mission)
    assertStaged()
    const members = new Map(input.members.map(member => [`member_${draft.id}_${member.key}`, member]))
    for (const member of this.store.list('members', mission.id)) {
      const next = members.get(member.id)
      const changed = next && (['name', 'role', 'provider', 'model', 'reasoningEffort', 'maxOutputTokens'] as const).some(field => member[field] !== next[field])
      if (next && !changed && memberPhaseOf(member) !== 'stopped') continue
      if (this.store.list('tasks', mission.id).some(task => task.attempt?.ownerId === member.id)) throw new PolicyError('draft_repair_worker_busy', 'conflict_error', `Worker ${member.id} still owns an attempt; preserve and stop that execution before repairing its plan resources`)
      const opening = this.workerStarts.get(member.id)
      opening?.controller.abort(new Error('Saved plan resource repair'))
      const timeout = AbortSignal.timeout(this.config.workerStartTimeoutMs ?? 60_000)
      const signal = actor.signal ? AbortSignal.any([actor.signal, timeout]) : timeout
      await abortableStart(this.workers.stop(member.id), signal)
      assertStaged()
      this.workerStarts.delete(member.id)
      const latest = this.store.get('members', member.id)!
      const previousSessionId = latest.sessionId
      if (next) {
        Object.assign(latest, { name: next.name, role: next.role, provider: next.provider, model: next.model,
          reasoningEffort: next.reasoningEffort, maxOutputTokens: next.maxOutputTokens, phase: 'active' })
        if (changed) latest.sessionId = id('swarm-session')
      } else latest.phase = 'stopped'
      // WS-1: a rotated sessionId is a new worker identity. The adapter's
      // persisted composition is keyed to the old one and only an ABSENT file is
      // composed afresh, so the stale metadata must be dropped here — after the
      // old handle has stopped and before the next start — or this member can
      // never start again, even if the owner reverts the edit.
      if (latest.sessionId !== previousSessionId) await this.workers.invalidateComposition?.(mission.id, latest.id)
      assertStaged()
      this.commit(mission.id, () => {
        this.store.put('members', latest)
        this.store.event(mission!.id, 'member/plan-repaired', 'owner', { memberId: latest.id, revision: draft.revision, previousSessionId, sessionId: latest.sessionId, retired: !next })
      })
    }
    assertStaged()
    mission = this.mission(mission.id)
    const tasks = new Map(input.tasks.map(task => [`task_${draft.id}_${task.key}`, task]))
    this.commit(mission.id, () => {
      Object.assign(mission!, { title: input.title, objective: input.objective, scope: [...input.scope], acceptance: [...input.acceptance], budget: { ...input.budget }, updatedAt: Date.now() })
      this.store.put('missions', mission!)
      for (const stream of input.workstreams) {
        const previous = this.store.get('workstreams', `stream_${draft.id}_${stream.key}`)
        if (previous) { previous.title = stream.title; previous.objective = stream.objective; this.store.put('workstreams', previous) }
      }
      for (const task of this.store.list('tasks', mission!.id)) {
        const next = tasks.get(task.id)
        if (task.artifact || task.attempt || task.evidenceIds.length || ['submitted', 'accepted', 'running'].includes(task.status)) continue
        if (!next) {
          if (task.status !== 'cancelled') { task.status = 'cancelled'; task.epoch++; task.output = 'Withdrawn by saved plan repair'; this.store.put('tasks', task) }
          continue
        }
        if (task.status === 'cancelled') throw new Error(`Task ${task.id} was cancelled by the owner; use a new plan key`)
        const previous = { ...task }
        Object.assign(task, { title: next.title, objective: next.objective, workstreamId: `stream_${draft.id}_${next.workstreamKey}`,
          dependencies: normalizeReviewDependencies(next.kind, next.reviewOf, next.dependencies).map(key => `task_${draft.id}_${key}`),
          scope: [...next.scope], acceptance: [...next.acceptance], checks: [...(next.checks ?? [])],
          priority: next.priority ?? 50, experiment: next.experiment ?? false,
          assigneeId: next.assigneeKey ? `member_${draft.id}_${next.assigneeKey}` : undefined,
          plannedAssigneeId: next.assigneeKey ? `member_${draft.id}_${next.assigneeKey}` : undefined,
          assignmentMode: next.assignmentMode, reviewOf: next.reviewOf ? `task_${draft.id}_${next.reviewOf}` : undefined,
          ...normalizeTaskCeilings(next, input.budget.maxSteps, 'task'),
          maxRecoveryAttempts: next.maxRecoveryAttempts, checkTimeoutMs: next.checkTimeoutMs })
        if (JSON.stringify(previous) !== JSON.stringify(task)) {
          this.store.put('tasks', task)
          this.store.event(mission!.id, 'task/plan-repaired', 'owner', { taskId: task.id, draftRevision: draft.revision, previous, task })
        }
      }
      this.store.event(mission!.id, 'plan/admissions-repaired', 'owner', { draftId: draft.id, revision: draft.revision })
    })
  }
  /** Build the entire topology while dispatch is fenced, then activate it in one commit. */
  async launchDraft(actor: Actor, draftId: string, revision: number): Promise<Snapshot> {
    return this.exclusive(draftId, async () => {
      const draft = this.ownedDraft(actor, draftId)
      if (draft.status === 'launched' && draft.missionId) return this.snapshot(actor, draft.missionId)
      if (draft.revision !== revision) throw new PolicyError('draft_revision_conflict', 'conflict_error', 'Draft changed; reload before launching')
      if (!['draft', 'failed'].includes(draft.status)) throw new PolicyError('draft_not_launchable', 'conflict_error', 'Draft cannot be launched in its current state')
      const automatic = this.store.list('starts').find(request => request.draftId === draft.id)
      const assertCurrent = () => {
        actor.signal?.throwIfAborted()
        const current = automatic ? this.store.get('starts', automatic.id) : undefined
        if (current && (current.planningFenced || current.status === 'failed' || current.status === 'stopped'
          || (current.planningEpoch ?? 1) !== (automatic!.planningEpoch ?? 1))) throw new PolicyError('plan_assembly_interrupted', 'conflict_error', 'Plan assembly was interrupted')
      }
      assertCurrent()
      const input = automatic ? this.automaticPlan(draft.input, automatic) : validatePlan(draft.input, { launch: true, dependencyDirs: this.config.verificationDependencyDirs })
      draft.input = input
      draft.advisories = planAdvisories(input).slice(0, 20).map(formatDiagnostic)
      // P4: the parse-only check preflight runs on EVERY launch path, at the one
      // boundary both `/agent-swarm` and the staged plan share. It used to live in
      // the tool handler alone, so a staged plan whose check was a shell syntax
      // error was admitted, launched, executed by a member and submitted before
      // the failure surfaced at verification. No worker, worktree or model step
      // exists yet at this point.
      const declaredChecks = declaredPlanChecks(input.tasks)
      if (declaredChecks.length && this.workers.checkSyntaxPreflight !== undefined) {
        actor.signal?.throwIfAborted()
        // The adapter result is located; `checkSyntaxDetail` pairs each issue
        // with the check it refuses by that index.
        const issues = await this.workers.checkSyntaxPreflight(declaredChecks.map(check => check.command), input.workspace, actor.signal)
        // Typed for the trace and for the owner's tool and automatic-start
        // paths, which carry it in full. Its detail quotes the shell's own
        // diagnostic, which starts with "/bin/sh:", so the RPC boundary always
        // takes it for host detail: the browser's launch-draft answers
        // internal-error and the host logs the refusal.
        if (issues.length) throw new PolicyError('check_syntax_invalid', 'validation_error', '[check_syntax_invalid] ' + checkSyntaxDetail(declaredChecks, issues) + '\nPrefer the existing repository check commands; repair every command in the `checks` array and relaunch the complete plan.')
      }
      assertCurrent()
      draft.status = 'launching'; draft.revision++; draft.updatedAt = Date.now(); delete draft.error
      draft.missionId ??= `mission_${draft.id}`
      this.commit(draft.id, () => this.store.put('drafts', draft))
      const missionId = draft.missionId
      try {
        let mission = this.store.get('missions', missionId)
        const repairing = mission !== undefined
        if (!mission) {
          const { title, objective, workspace, scope, acceptance, budget } = input
          const extra = input as PlanInput & { workspaceGrantRoot?: string; workspaceAuthorizationSource?: 'session' | 'grant' }
          const anchor = draft.workspaceGrantRoot ?? extra.workspaceGrantRoot
          const source = draft.workspaceAuthorizationSource ?? extra.workspaceAuthorizationSource
          mission = this.create(actor, { title, objective, workspace, ...(anchor === undefined ? {} : { workspaceGrantRoot: anchor }), ...(source === undefined ? {} : { workspaceAuthorizationSource: source }), scope, acceptance, budget }, { id: missionId, status: 'staged' })
        }
        if (mission.ownerSessionId !== actor.sessionId || mission.status !== 'staged') throw new PolicyError('draft_mission_not_launchable', 'conflict_error', 'The partially assembled mission cannot be launched')
        if (repairing) await this.repairDraftAdmissions(actor, draft, input, assertCurrent)
        for (const member of input.members) {
          assertCurrent()
          await this.addMember(actor, missionId, member, `member_${draft.id}_${member.key}`)
        }
        assertCurrent()
        for (const stream of input.workstreams) this.workstream(actor, missionId, stream, `stream_${draft.id}_${stream.key}`)
        for (const task of orderedTasks(input.tasks)) this.propose(actor, missionId, {
          ...task, workstreamId: `stream_${draft.id}_${task.workstreamKey}`,
          assigneeId: task.assigneeKey ? `member_${draft.id}_${task.assigneeKey}` : undefined,
          dependencies: task.dependencies?.map(key => `task_${draft.id}_${key}`),
          reviewOf: task.reviewOf ? `task_${draft.id}_${task.reviewOf}` : undefined,
        }, `task_${draft.id}_${task.key}`)
        mission = this.active(actor, missionId, true).mission
        // Re-read the durable generation after every admission commit; a lost
        // abort handle cannot revive a cancelled or superseded assembly.
        assertCurrent()
        if (mission.status !== 'staged') throw new PolicyError('plan_assembly_interrupted', 'conflict_error', 'Plan assembly was interrupted')
        mission.status = 'active'; mission.updatedAt = Date.now(); executionClock(mission, false)
        draft.status = 'launched'; draft.updatedAt = Date.now()
        this.commit(missionId, () => {
          this.store.put('missions', mission!); this.store.put('drafts', draft)
          this.syncStarts(mission!)
          this.store.event(missionId, 'plan/launched', 'owner', { draftId, revision: draft.revision, advisories: draft.advisories })
        })
        this.kick(missionId)
        return this.snapshot(actor, missionId)
      } catch (error) {
        draft.status = 'failed'; draft.error = String(error); draft.updatedAt = Date.now()
        if (!this.closed && this.store.get('drafts', draft.id)?.revision === draft.revision) this.commit(draft.id, () => this.store.put('drafts', draft))
        throw error
      }
    })
  }
  /** Snapshot access is checked against durable membership. */
  snapshot(actor: Actor, missionId: string): Snapshot {
    const { mission } = this.participant(actor, missionId)
    const tasks = this.store.list('tasks', missionId)
    let deliveryTarget: { taskId: string; commit: string } | undefined
    try {
      const target = this.selectDeliveryTarget(missionId, tasks)
      if (target.artifact) deliveryTarget = { taskId: target.id, commit: target.artifact.commit }
    } catch { deliveryTarget = undefined }
    const completionReason = this.completionError(mission)
    // R17-G6: the client's read face takes member statuses from the derived board
    // (the registered projection when published), not from a second derivation.
    return { mission, members: this.projectedMembers(missionId), workstreams: this.store.list('workstreams', missionId), tasks, evidence: this.store.list('evidence', missionId), events: this.store.events(missionId, this.config.maxEvents), pendingDeliveries: this.store.list('deliveries', missionId).filter(d => !d.deliveredAt).length,
      ...(deliveryTarget === undefined ? {} : { deliveryTarget }),
      completion: { eligible: completionReason === undefined, ...(completionReason === undefined ? {} : { reason: completionReason }) },
      criticalPath: this.criticalPath(missionId),
      ...(mission.appliedDelivery === undefined ? {} : { appliedDelivery: { resultCommit: mission.appliedDelivery.resultCommit, appliedAt: mission.appliedDelivery.appliedAt } }) }
  }
  /**
   * Bounded, focused model views. A member sees its current task, the
   * prerequisites and review source it needs, its own run references and new
   * events; the owner sees a compact board and usage. Full records are read by
   * id (`taskId`, `runId` paged by `offset`, `evidenceId`). The complete board
   * stays in the UI projection instead of every model request.
   *
   * After a member's first read the runtime remembers the delivered event/run
   * position and the default read returns only the delta — new events and tool
   * runs, plus the current assignment when it changed — so appended content
   * keeps the cached prompt prefix intact instead of re-sending superseded
   * snapshots (docs/observe-context-measurement.md). Owners pass an explicit
   * `nextCursor` back as `cursor` for compact row deltas; a missing/expired
   * baseline gives a full compact view. `detail=full` is owner-only.
   */
  observe(actor: Actor, missionId: string, query: ObserveQuery = {}, options: { advanceEventCursor?: boolean } = {}): unknown {
    actor.signal?.throwIfAborted()
    const { mission, member, owner } = this.participant(actor, missionId)
    for (const key of ['after', 'afterRun', 'offset'] as const) {
      if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || Number(query[key]) < 0)) throw new Error(`${key} must be a nonnegative integer`)
    }
    // Worker guidance alone did not prevent detail=full, so the runtime refuses
    // it for worker sessions while the owner path keeps the complete view.
    if (member && query.detail === 'full') throw new ObserveDetailRefusedError()
    const tasks = this.store.list('tasks', missionId), members = this.projectedMembers(missionId)
    let dependencyGraph: TaskGraphIndex | undefined
    const runRef = (run: ToolRun) => ({ id: run.id, seq: run.seq ?? 0, taskId: run.taskId, attemptId: run.attemptId, memberId: run.memberId, tool: run.tool, isError: run.isError, arguments: excerpt(run.arguments, 240) })
    const evidenceRef = (evidence: Evidence, full = false) => ({ id: evidence.id, taskId: evidence.taskId, authorId: evidence.authorId, claim: full ? evidence.claim : excerpt(evidence.claim, 400), outcome: evidence.outcome, status: evidence.status, toolRunIds: evidence.toolRunIds,
      ...(evidence.challenges.length ? { challenges: full ? evidence.challenges : evidence.challenges.length } : {}), ...(evidence.supersedes.length ? { supersedes: evidence.supersedes } : {}) })
    const taskRef = (task: Task) => ({ id: task.id, title: task.title, kind: task.kind, status: task.status, ...(task.assigneeId ? { assigneeId: task.assigneeId } : {}), ...(task.assignmentMode ? { assignmentMode: task.assignmentMode } : {}), ...(task.attempt ? { attemptOwner: task.attempt.ownerId } : {}),
      ...(task.reviewOf ? { reviewOf: task.reviewOf } : {}), ...(task.dependencies.length ? { dependencies: task.dependencies } : {}), ...(task.replaces?.length ? { replaces: task.replaces } : {}), ...(task.artifact ? { artifact: task.artifact.commit } : {}), ...(task.reviewArtifact ? { reviewArtifact: task.reviewArtifact.commit } : {}),
      ...(task.recovery ? { recovery: task.recovery } : {}) })
    const taskRecord = (task: Task, outputLimit: number) => ({ ...task, ...(task.output !== undefined ? { output: excerpt(task.output, outputLimit) } : {}), ...(task.handoff !== undefined ? { handoff: excerpt(task.handoff, outputLimit) } : {}) })
    const evidenceOf = (task: Task, full = false) => task.evidenceIds.map(evidenceId => this.store.get('evidence', evidenceId)).filter((item): item is Evidence => item !== undefined).map(item => evidenceRef(item, full))
    const runsWindow = (filter: { memberId?: string; taskId?: string; attemptId?: string }, limit: number, afterSeq?: number) => {
      const all = this.store.toolRuns(missionId, { ...filter, ...(afterSeq === undefined ? {} : { afterSeq }) })
      const shown = afterSeq === undefined ? all.slice(-limit) : all.slice(0, limit)
      return { toolRuns: shown.map(runRef), totalToolRuns: all.length, ...(shown.length ? { nextAfterRun: shown.at(-1)!.seq ?? 0 } : {}), ...(all.length > shown.length ? { omittedToolRuns: all.length - shown.length } : {}) }
    }
    if (query.deliveryId !== undefined) {
      if (!owner) throw new PolicyError('observe_delivery_owner_only', 'authorization_error', 'Only the mission owner can read a stored delivery')
      const delivery = this.store.get('deliveries', query.deliveryId)
      if (!delivery || delivery.missionId !== missionId) throw new PolicyError('observe_delivery_unknown', 'validation_error', 'Unknown delivery in this mission')
      return { delivery }
    }
    if (query.runId !== undefined) {
      const run = this.store.get('tool_runs', query.runId)
      if (!run || run.missionId !== missionId) throw new Error('Unknown tool run in this mission')
      const body = JSON.stringify({ arguments: run.arguments, result: run.result })
      const offset = query.offset ?? 0, page = Math.min(12000, this.config.maxMessageChars)
      return { run: { id: run.id, seq: run.seq ?? 0, taskId: run.taskId, attemptId: run.attemptId, memberId: run.memberId, tool: run.tool, isError: run.isError, createdAt: run.createdAt },
        totalChars: body.length, offset, content: body.slice(offset, offset + page), ...(offset + page < body.length ? { nextOffset: offset + page } : {}) }
    }
    if (query.evidenceId !== undefined) {
      const evidence = this.store.get('evidence', query.evidenceId)
      if (!evidence || evidence.missionId !== missionId) throw new Error('Unknown evidence in this mission')
      return { evidence: { ...evidenceRef(evidence, true), workstreamId: evidence.workstreamId, artifact: evidence.artifact, createdAt: evidence.createdAt } }
    }
    if (query.taskId !== undefined) {
      const task = this.task(missionId, query.taskId)
      return { task: taskRecord(task, 6000), evidence: evidenceOf(task, true), reviews: tasks.filter(item => item.reviewOf === task.id).map(taskRef),
        dependencies: task.dependencies.map(dep => this.lineage(missionId, dep, tasks, dependencyGraph ??= taskGraphIndex(tasks))).map(chain => ({ ...taskRef(chain.at(-1)!), ...(chain.length > 1 ? { replacementOf: chain.slice(0, -1).map(item => item.id) } : {}) })),
        ...(task.reviewOf ? { reviewSource: taskRef(this.task(missionId, task.reviewOf)) } : {}), ...runsWindow({ taskId: task.id }, 40, query.afterRun) }
    }
    // A member's delivered position is the default cursor; an explicit
    // after/afterRun overrides it for one read and still advances it.
    const delivered = member === undefined ? undefined : this.observeCursors.get(member.id)
    if (query.cursor !== undefined && (typeof query.cursor !== 'string' || query.cursor.length > 200 || !owner)) throw new PolicyError('observe_cursor_invalid', 'validation_error', 'cursor must be an owner observation cursor of at most 200 characters')
    const ownerKey = JSON.stringify([actor.sessionId, missionId])
    const savedOwner = owner && query.cursor !== undefined ? this.ownerObserveCursors.get(query.cursor) : undefined
    const ownerCursor = query.detail !== 'full' && savedOwner?.scope === ownerKey ? savedOwner : undefined
    const after = query.after ?? delivered?.eventSeq ?? ownerCursor?.eventSeq
    const afterRun = query.afterRun ?? delivered?.runSeq
    const eventLimit = 12
    // `after: 0` keeps its original meaning (no cursor): a member cursor of 0
    // only occurs when nothing was delivered yet, so the last window is correct.
    const fetched = this.store.events(missionId, after ? eventLimit + 1 : eventLimit, after ?? 0)
    const events = fetched.slice(0, eventLimit).map(event => ({ seq: event.seq, type: event.type, actor: event.actor, summary: excerpt(event.data, 240) }))
    const eventCursor = { ...(events.length ? { nextAfter: events.at(-1)!.seq } : {}), ...(fetched.length > eventLimit ? { moreEvents: true } : {}) }
    const budget = { usedTokens: mission.usedTokens, maxTokens: mission.budget.maxTokens, usedSteps: mission.usedSteps, maxSteps: mission.budget.maxSteps, deadline: mission.deadline, inFlightTokensEstimate: this.inFlightEstimate(members) }
    const full = query.detail === 'full'
    if (member) {
      const current = tasks.find(task => task.status === 'running' && task.attempt?.ownerId === member.id)
      const currentKey = current === undefined ? undefined : `${current.id}:${current.attempt!.id}:${current.status}`
      const source = current?.reviewOf ? this.task(missionId, current.reviewOf) : undefined
      const runs = runsWindow(current?.attempt ? { memberId: member.id, taskId: current.id, attemptId: current.attempt.id } : { memberId: member.id }, 20, afterRun)
      // Board traffic is part of the delta: counts plus the newest few posts,
      // so a worker learns about cross-task posts without a second poll.
      const postAfter = delivered?.postSeq ?? 0
      const posts = this.boardWindow(missionId, member.id, postAfter)
      const nextPostSeq = typeof posts.nextAfter === 'number' ? posts.nextAfter : postAfter
      // Record only what this response delivers. A history page swapped in by
      // tools.ts suppresses the event advance so no unseen event is skipped.
      const advanceEvents = options.advanceEventCursor !== false
      if (delivered !== undefined || advanceEvents) this.observeCursors.set(member.id, {
        eventSeq: advanceEvents ? Math.max(delivered?.eventSeq ?? 0, events.at(-1)?.seq ?? 0, query.after ?? 0) : delivered?.eventSeq ?? 0,
        runSeq: Math.max(delivered?.runSeq ?? 0, runs.toolRuns.at(-1)?.seq ?? 0, query.afterRun ?? 0),
        postSeq: advanceEvents ? Math.max(delivered?.postSeq ?? 0, nextPostSeq) : delivered?.postSeq ?? 0,
        ...(currentKey === undefined ? {} : { current: currentKey }),
      })
      // The first read is the focused view; later default reads are deltas.
      if (delivered !== undefined && query.after === undefined && query.afterRun === undefined) return {
        // A changed current assignment is new content the member must see; an
        // unchanged one stays in the cached prefix and is not re-sent.
        ...(delivered.current === currentKey ? {} : { current: current === undefined ? null : {
          task: taskRecord(current!, 2400), attemptId: current!.attempt!.id,
          dependencies: current!.dependencies.map(dep => this.lineage(missionId, dep, tasks, dependencyGraph ??= taskGraphIndex(tasks))).map(chain => ({ ...taskRef(chain.at(-1)!), output: excerpt(chain.at(-1)!.output ?? '', 600), ...(chain.length > 1 ? { replacementOf: chain.slice(0, -1).map(item => item.id) } : {}) })),
          ...(source ? { reviewSource: { ...taskRecord(source, 2400), evidence: evidenceOf(source) } } : {}),
        } }),
        events, ...eventCursor, ...runs,
        posts,
        delta: true,
        detail: 'Delta since your last delivered cursor: new events, tool runs and board posts, plus your current assignment when it changed. Read taskId, runId, evidenceId or swarm_board for one full record.',
      }
      return {
        mission: { id: mission.id, title: mission.title, status: mission.status, ...budget },
        member: { id: member.id, name: member.name, role: member.role, status: member.status },
        current: current ? {
          task: taskRecord(current, 2400), attemptId: current.attempt!.id,
          dependencies: current.dependencies.map(dep => this.lineage(missionId, dep, tasks, dependencyGraph ??= taskGraphIndex(tasks))).map(chain => ({ ...taskRef(chain.at(-1)!), output: excerpt(chain.at(-1)!.output ?? '', 600), ...(chain.length > 1 ? { replacementOf: chain.slice(0, -1).map(item => item.id) } : {}) })),
          ...(source ? { reviewSource: { ...taskRecord(source, 2400), evidence: evidenceOf(source) } } : {}),
        } : null,
        evidence: current ? evidenceOf(current) : [],
        ...runs,
        events, ...eventCursor,
        posts,
        board: full ? tasks.map(task => taskRecord(task, 2400)) : tasks.map(taskRef), members: members.map(item => ({ id: item.id, name: item.name, role: item.role, status: item.status })),
        detail: full ? 'Focused view with complete task records. taskId reads one task with full evidence and runs; runId with offset reads one stored run; evidenceId reads one claim; swarm_board reads the durable post board; after/afterRun return only changes.' : 'Focused view; later default reads return only the delta of new events, tool runs and board posts. taskId reads one task with full evidence and runs; runId with offset reads one stored run; evidenceId reads one claim; swarm_board reads the durable post board; after/afterRun return only changes.',
      }
    }
    const evidence = this.store.list('evidence', missionId)
    const deliveryHealth = memberDeliveryHealth(this.store.list('deliveries', missionId))
    const rows: OwnerRows = {
      members: members.map(item => ({ id: item.id, name: item.name, role: item.role, status: item.status, ...(item.activity ? { activity: item.activity.kind } : {}), ...(deliveryHealth.has(item.id) ? { deliveryHealth: deliveryHealth.get(item.id) } : {}), accountedTokens: item.accountedTokens ?? 0, requests: item.usage?.requests ?? 0 })),
      board: full ? tasks.map(task => taskRecord(task, 6000)) : tasks.map(taskRef),
      evidence: (full ? evidence : evidence.filter(item => item.status === 'challenged' || item.status === 'refuted')).map(item => evidenceRef(item, full)),
    }
    const postAfter = ownerCursor?.postSeq
    const newest = this.store.posts(missionId, { ...(postAfter === undefined ? {} : { afterSeq: postAfter }), newest: true, limit: BOARD_DELTA_POSTS })
    const postCount = this.store.countPosts(missionId, postAfter === undefined ? {} : { afterSeq: postAfter })
    let cursorView: Record<string, unknown> = {}
    if (owner && !full) {
      const signatures = {} as OwnerCursor['rows']
      const removed = {} as Record<keyof OwnerRows, string[]>
      for (const key of ['board', 'members', 'evidence'] as const) {
        signatures[key] = new Map(rows[key].map(row => [row.id, JSON.stringify(row)]))
        if (ownerCursor) {
          removed[key] = [...ownerCursor.rows[key].keys()].filter(id => !signatures[key].has(id))
          rows[key] = rows[key].filter(row => ownerCursor.rows[key].get(row.id) !== signatures[key].get(row.id))
          if (!rows[key].length && !removed[key].length) signatures[key] = ownerCursor.rows[key]
        }
      }
      // A history-only read substitutes the events after this function returns.
      // Leave its baseline untouched; the next ordinary read may repeat data,
      // but cannot skip an event the caller has never seen.
      if (options.advanceEventCursor !== false) {
        const eventSeq = events.at(-1)?.seq ?? after ?? 0, postSeq = newest.at(-1)?.seq ?? postAfter ?? 0
        const unchanged = ownerCursor && eventSeq === ownerCursor.eventSeq && postSeq === ownerCursor.postSeq
          && (['board', 'members', 'evidence'] as const).every(key => signatures[key] === ownerCursor.rows[key])
        const token = unchanged ? ownerCursor.token : randomUUID()
        if (!unchanged) {
          this.ownerObserveCursors.set(token, { scope: ownerKey, token, rows: signatures, eventSeq, postSeq })
          if (this.ownerObserveCursors.size > 64) this.ownerObserveCursors.delete(this.ownerObserveCursors.keys().next().value!)
        }
        cursorView.nextCursor = token
      } else if (ownerCursor) cursorView.nextCursor = ownerCursor.token
      cursorView = { ...cursorView, ...(ownerCursor ? { delta: true, removed } : query.cursor === undefined ? {} : { cursorReset: true }) }
    }
    return {
      mission: { id: mission.id, title: mission.title, status: mission.status, ...(mission.reason ? { reason: mission.reason } : {}), ...budget, criticalPath: this.criticalPath(missionId), workerUsage: mission.workerUsage ?? emptyUsage(), ownerUsage: mission.ownerUsage ?? emptyUsage() },
      ...rows, ...cursorView,
      unschedulable: this.unschedulable(mission, tasks, members).map(task => task.id),
      pendingDeliveries: this.store.list('deliveries', missionId).filter(delivery => !delivery.deliveredAt).length,
      posts: { total: this.store.countPosts(missionId), newest: newest.map(post => postView(post)),
        ...(postAfter === undefined ? {} : { count: postCount }), ...(postCount > newest.length ? { omitted: postCount - newest.length } : {}) },
      events, ...eventCursor,
      ...(owner ? this.ownerInstruments(missionId, full) : {}),
      detail: full ? 'Complete task records and evidence claims; tool payloads are read by runId.' : 'Pass nextCursor as cursor for changed board/members/evidence rows and removed ids; mission statistics and open questions remain visible. Missing or expired cursor returns a complete compact board. after pages events independently; taskId/runId/evidenceId reads one record; detail=full expands records.',
      ...(owner ? {} : { note: 'Non-member observer' }),
    }
  }
  
  /** Requests already streaming have no reported usage yet; estimate each at its worker's average. */
  inFlightEstimate(members: Member[]): number {
    let total = 0
    for (const member of members) {
      if (memberPhaseOf(member) === 'stopped') continue
      const activity = this.workers.currentActivity ? this.workers.currentActivity(member.id) : member.activity
      if (activity?.kind !== 'model') continue
      const requests = member.usage?.requests ?? 0
      if (requests > 0) total += Math.ceil((member.accountedTokens ?? 0) / requests)
    }
    return total
  }
  
  
  async inspectDelivery(actor: Actor, missionId: string) {
    const { mission, task } = this.deliveryTarget(actor, missionId)
    if (!this.workers.inspectDelivery) throw new PolicyError('delivery_unsupported', 'tool_error', 'This worker adapter does not support delivery inspection')
    return this.workers.inspectDelivery(mission, task.artifact!.commit, actor.signal)
  }
  async applyDelivery(actor: Actor, missionId: string) {
    const target = this.deliveryTarget(actor, missionId)
    // Different completed missions for one source must not apply concurrently.
    return this.exclusive(`delivery:${target.mission.workspace}`, async () => {
      const { mission, task } = this.deliveryTarget(actor, missionId)
      if (!this.workers.applyDelivery) throw new PolicyError('delivery_unsupported', 'tool_error', 'This worker adapter does not support applying results')
      const result = await this.workers.applyDelivery(mission, task.artifact!.commit, actor.signal)
      this.commit(missionId, () => {
        // The projection states what is currently in effect, so a conflicts result
        // clears any earlier marker instead of leaving a stale "applied" claim for
        // the same target (I2 hand-off 4, reconciled at integration).
        if (result.status === 'applied') mission.appliedDelivery = { resultCommit: task.artifact!.commit, appliedAt: Date.now() }
        else delete mission.appliedDelivery
        this.store.put('missions', mission)
        this.store.event(missionId, `delivery/${result.status}`, 'owner', { resultCommit: task.artifact!.commit, ...result })
      })
      return result
    })
  }
  
  
  
  
  
  completionError(mission: Mission): string | undefined {
    const tasks = this.store.list('tasks', mission.id)
    if (!tasks.length) return 'Mission still has unfinished or blocked required work'
    const unfinished = tasks.filter(task => !['accepted', 'cancelled'].includes(task.status) && !(task.experiment && task.status === 'blocked'))
    if (unfinished.length) return `Mission still has unfinished or blocked required work: ${unfinished.map(task => `${task.id} (${task.status})`).join(', ')}`
    const accepted = tasks.filter(task => task.status === 'accepted')
    // Verification acceptance text is free-form review criteria; only deliverable
    // work can cover a mission criterion, and code deliverables need an artifact.
    const deliverables = accepted.filter(task => task.kind !== 'verification' && (task.kind === 'research' || task.artifact !== undefined))
    const uncovered = mission.acceptance.filter(criterion => !deliverables.some(task => Array.isArray(task.acceptance) && task.acceptance.includes(criterion)))
    if (uncovered.length) {
      const blocked = tasks.filter(task => task.status === 'blocked' && !task.experiment).map(task => task.id)
      return `Accepted tasks do not cover every mission acceptance criterion: ${JSON.stringify(uncovered)}${blocked.length ? `. Blocked work still needs repair: ${blocked.join(', ')}` : ''}`
    }
    if (tasks.some(task => ['implementation', 'integration'].includes(task.kind) && task.status !== 'cancelled')) {
      try { this.selectDeliveryTarget(mission.id, tasks) }
      catch (error) { return error instanceof Error ? error.message : String(error) }
    }
    // Evidence of explicitly cancelled work no longer supports an accepted result; live disputes still block.
    const dead = new Set(tasks.filter(task => task.status === 'cancelled').map(task => task.id))
    const disputed = this.store.list('evidence', mission.id).filter(evidence => evidence.status === 'challenged' && !dead.has(evidence.taskId))
    if (disputed.length) return `Unresolved evidence challenges prevent completion: ${disputed.map(evidence => evidence.id).join(', ')}`
    return undefined
  }
  /** Automatic completion consumes accepted obligations; it never withdraws unfinished work.
   * Owner-assembled missions retain explicit completion, and every stalled board
   * notifies the owner so dependencies, assignments or allocations can be repaired.
   */
  private completeAutomatic(missionId: string): boolean {
    const mission = this.mission(missionId)
    if (mission.status !== 'active') return false
    const automatic = this.store.list('starts', missionId).length > 0
    const tasks = this.store.list('tasks', missionId), members = this.store.list('members', missionId)
    const strict = this.completionError(mission)
    const isStalled = strict !== undefined && this.stalled(mission, tasks, members)
    // Spec §2: a notice is fresh only for the state it described. Once the board
    // leaves the stalled / coverage-complete class, forget the dedup key so a
    // later return to the same fingerprint re-notifies instead of staying silent.
    if (!isStalled && mission.stallNotice !== undefined) { delete mission.stallNotice; this.commit(missionId, () => this.store.put('missions', mission)) }
    if (strict !== undefined && mission.coverageNotice !== undefined) { delete mission.coverageNotice; this.commit(missionId, () => this.store.put('missions', mission)) }
    if (strict !== undefined) {
      if (isStalled) this.notifyStall(mission, strict)
      return false
    }
    // R10-14: coverage complete, no stall, mission still active. An owner-assembled
    // mission may still be extending its plan, so it does not auto-complete — but
    // it must not be silent either. One durable owner-decision notice per board state.
    if (!automatic) { this.notifyCoverageComplete(mission); return false }
    this.control({ sessionId: mission.ownerSessionId }, missionId, 'complete', 'Automatically completed after independent verification satisfied all mission acceptance criteria')
    this.commit(missionId, () => {
      this.store.event(missionId, 'automatic/completed', 'runtime', {})
      // R15-A1: the completion notice names every accepted deliverable (the
      // mission's lineage roots), so the final decision is attributable too.
      const view = this.interpretation(missionId)
      this.notify(missionId, `Completed ${mission.title}: all required deliverables were independently accepted. Review the evidence and final artifact in Agent Swarm.`, view.subjectsOf(view.tasks.filter(task => task.status === 'accepted')), { noticeClass: 'completion', trigger: 'automatic/completed' })
    })
    return true
  }
  
  
  
  
  
  /**
   * Every cause blocking `task` now (see `blockCauses`), read against this
   * runtime's evidence rows and default recovery limit. The restart
   * re-derivation and owner task control ask it here; the stop barrier asks the
   * same `blockCauses` through its own store reads.
   */
  taskBlockCauses(task: Task): Set<BlockCause> {
    return blockCauses(task, evidenceId => this.store.get('evidence', evidenceId)?.status, this.config.maxTasksPerMember)
  }
  /** Amend execution policy without replacing the task or resetting its accumulated work. */
  controlTask(actor: Actor, missionId: string, taskId: string, action: 'amend' | 'resume', changes: TaskAmendment, reason: string): Task & { dependencyChanges?: { previous: string[]; current: string[]; added: string[]; removed: string[] } } {
    actor.signal?.throwIfAborted()
    const { mission, owner } = this.participant(actor, missionId)
    if (!owner || this.isWorkerSession(actor.sessionId)) throw new PolicyError('task_owner_required', 'authorization_error', 'Only the primary user session may amend task execution')
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    if (!['amend', 'resume'].includes(action)) throw new PolicyError('task_action_invalid', 'validation_error', 'Task control supports amend or resume')
    this.bounded(reason)
    const allowed = ['scope', 'outputs', 'dependencies', 'checks', 'assigneeId', 'maxSteps', 'maxFindings', 'maxRecoveryAttempts', 'checkTimeoutMs']
    if (changes === null || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(key => !allowed.includes(key))) throw new PolicyError('task_amendment_invalid', 'validation_error', 'Unknown task amendment field')
    const cleanup = this.store.get('tasks', taskId)
    const cleanupOnly = action === 'resume' && Object.keys(changes).length === 0 && cleanup?.missionId === missionId
      && stopPending(cleanup)
    if (mission.status === 'staged' || (terminal(mission) && !cleanupOnly)) throw new PolicyError('mission_not_running', 'conflict_error', 'Task policy requires a launched, nonterminal mission')
    const task = this.task(missionId, taskId)
    // Retry preservation after an explicit repair without reopening terminal work.
    if (action === 'resume' && Object.keys(changes).length === 0 && stopPending(task)
      && (terminal(mission) || ['accepted', 'cancelled'].includes(task.status))) {
      this.attempts.resumeStoppedAttempt(missionId, task, { force: true })
      return task
    }
    if (['accepted', 'cancelled'].includes(task.status)) throw new PolicyError('task_immutable', 'conflict_error', 'Accepted and cancelled tasks are immutable')
    if (this.store.list('tasks', missionId).some(row => row.status !== 'cancelled' && row.replaces?.includes(task.id))) throw new PolicyError('task_replaced', 'conflict_error', 'Task has a live replacement; amend that task instead')
    // A submitted artifact may acquire additional checks without changing its
    // content, authorship or obligations. The verdict fences this exact check list.
    const strengthenSubmittedChecks = task.status === 'submitted' && action === 'amend'
      && Object.keys(changes).length === 1 && Array.isArray(changes.checks)
      && task.checks.filter(check => !isNoopCheck(check)).every(check => changes.checks!.includes(check))
    // `outputs` is the capture obligation itself, so it is fenced exactly like
    // the scope it must sit inside: a submitted artifact's obligations cannot be
    // rewritten after the fact.
    const structural = !strengthenSubmittedChecks && ['scope', 'outputs', 'dependencies', 'checks', 'assigneeId'].some(key => Object.hasOwn(changes, key))
    if (structural && (task.artifact !== undefined || task.status === 'submitted')) throw new PolicyError('artifact_policy_immutable', 'conflict_error', 'Submitted artifact policy is immutable; repair rejected work through a replacement')
    const causes = this.taskBlockCauses(task)
    if (task.status === 'blocked' && causes.has('refuted') && !causes.has('review-deferred')) throw new PolicyError('task_refuted', 'conflict_error', 'Refuted work requires a replacement preserving its original acceptance')
    const next: Task = { ...task }
    for (const key of ['maxSteps', 'maxFindings', 'maxRecoveryAttempts', 'checkTimeoutMs'] as const) {
      const value = changes[key]
      if (value === undefined) continue
      if (!Number.isSafeInteger(value) || value < 1 || (key === 'checkTimeoutMs' && value > 2147483647)) throw new PolicyError('task_allocation_invalid', 'validation_error', `${key} must be a positive safe allocation`)
      if (key === 'maxSteps' && (value > mission.budget.maxSteps || value < (task.usedSteps ?? 0))) throw new PolicyError('task_step_allocation_invalid', 'budget_error', 'Task maxSteps must cover consumed steps and fit the mission budget')
      if (key === 'maxRecoveryAttempts' && value < (task.recoveryCount ?? 0)) throw new PolicyError('task_recovery_allocation_invalid', 'budget_error', 'maxRecoveryAttempts cannot be below consumed recovery attempts')
      next[key] = value
    }
    if (changes.scope !== undefined) {
      requireStrings(changes.scope, 'scope'); next.scope = normalizeScopeSelectors(changes.scope)
      assertScopeSelectors(next.scope, 'scope', mission.scope)
    }
    // After the scope amendment, so a combined change is checked against the
    // scope this task ends up with, never the one it is leaving. A scope
    // amendment alone re-checks the outputs the task already declared: one
    // left outside the new scope would refuse every later submit.
    if (changes.outputs !== undefined) next.outputs = assertDeclaredOutputs(changes.outputs, next.scope, 'task', { dependencyDirs: this.config.verificationDependencyDirs })
    else if (changes.scope !== undefined && next.outputs !== undefined) assertDeclaredOutputs(next.outputs, next.scope, 'task', { scopeAmendment: true, dependencyDirs: this.config.verificationDependencyDirs })
    if (changes.dependencies !== undefined) {
      if (!Array.isArray(changes.dependencies) || changes.dependencies.some(value => typeof value !== 'string' || !value.trim())) throw new PolicyError('task_dependencies_invalid', 'validation_error', 'Invalid dependencies')
      next.dependencies = [...new Set(normalizeReviewDependencies(task.kind, task.reviewOf, changes.dependencies))]
      for (const dependency of next.dependencies) this.task(missionId, dependency)
      // R12-F9: the one live path that bypasses admission. propose() refuses a
      // task whose text assumes prior work that no content-carrying edge (a
      // dependency, or the review source `prepareTask` merges like one) brings
      // into its worktree; this amendment would otherwise strip that edge from
      // an admitted task, so it is refused here, before anything is written.
      const assumed = dependencyAssumptions({ objective: task.objective, acceptance: task.acceptance }, `task ${JSON.stringify(task.id)}`, {
        dependencies: [...next.dependencies, ...(task.reviewOf === undefined ? [] : [task.reviewOf])],
        replaces: task.replaces,
        knownContents: new Set(this.store.list('tasks', missionId).map(row => row.id)),
        amendment: true,
      })
      // The code is read from the diagnostic the refusal carries; tool_error is
      // the category plan validation already gives this code.
      if (assumed.length) throw new AdmissionError(assumed[0]!.code, 'tool_error', assumed.map(formatDiagnostic).join('\n'), `task ${JSON.stringify(task.id)}`, assumed)
    }
    if (changes.checks !== undefined) {
      if (!Array.isArray(changes.checks) || changes.checks.some(value => typeof value !== 'string' || !value.trim())) throw new PolicyError('task_checks_invalid', 'validation_error', 'Invalid checks')
      requireHostChecks(task.kind, changes.checks, 'task', task.title, loadPackageScripts(mission.workspace))
      next.checks = [...changes.checks]
      if (strengthenSubmittedChecks && task.artifact) requireArtifactChecks(next, task.artifact)
    }
    if (changes.assigneeId !== undefined) {
      if (changes.assigneeId === null || changes.assigneeId === '') { delete next.assigneeId; delete next.plannedAssigneeId }
      else {
        const member = this.store.get('members', changes.assigneeId)
        if (member?.missionId !== missionId || memberPhaseOf(member) === 'stopped') throw new PolicyError('task_assignee_invalid', 'validation_error', 'Unknown live assignee')
        if (task.reviewOf && this.authorIds(this.task(missionId, task.reviewOf)).has(member.id)) throw new PolicyError('review_independence_required', 'authorization_error', 'Review requires an independent assignee')
        next.assigneeId = member.id; next.plannedAssigneeId = member.id
      }
    }
    const resumes = action === 'resume' || (task.status === 'blocked' && structural) || (task.status === 'blocked' && changes.maxRecoveryAttempts !== undefined && (next.recoveryCount ?? 0) < changes.maxRecoveryAttempts) || (task.ceiling !== undefined && taskCeilingBlock(next) === undefined)
    // A blocked task that carries an artifact was rejected, or invalidated after
    // it submitted: the artifact is immutable, so a resume would only fence the
    // historical author and re-pend work that can never change. A resume while a
    // stop is still pending is the advertised cleanup retry, which keeps the
    // blocked outcome, so it stays allowed.
    if (resumes && !stopPending(task) && causes.has('needs-replacement')) throw new PolicyError('task_needs_replacement', 'conflict_error', `[task_needs_replacement] Task ${task.id} is blocked with an immutable artifact (a rejected source, or submitted work invalidated after submission), so it cannot resume. Propose its repair with \`swarm_propose\` naming \`replaces\`: ["${task.id}"] (the replacement inherits its acceptance), or withdraw it with \`swarm_cancel\` and \`taskId\`.`)
    if (resumes && task.status === 'submitted') throw new PolicyError('task_awaiting_verdict', 'conflict_error', 'Submitted work waits for an independent verdict')
    if (resumes && taskCeilingBlock(next) !== undefined) throw new PolicyError('task_budget_exhausted', 'budget_error', 'Task budget exhausted; raise the same task allocation with swarm_budget before resuming')
    if (resumes && task.verificationRecovery) {
      const source = this.task(missionId, task.verificationRecovery.sourceTaskId)
      if (source.status !== 'submitted' || source.artifact?.commit !== task.verificationRecovery.commit) throw new PolicyError('review_artifact_changed', 'conflict_error', 'Review recovery requires its exact submitted artifact')
    }
    if (resumes && this.taskBlockCauses(next).has('recovery-exhausted')) throw new PolicyError('task_recovery_exhausted', 'budget_error', 'Raise maxRecoveryAttempts before resuming exhausted automatic recovery')
    // An explicit owner recovery keeps the stop barrier but records the desired
    // pending state now, so a still-running checkpoint cannot forget the resume.
    if (resumes && next.status === 'blocked' && next.artifact === undefined && next.resumeAfterStop?.reason === 'invalidated') {
      next.resumeAfterStop = { ...next.resumeAfterStop, reason: 'handoff' }
    }
    if (taskCeilingBlock(next) === undefined) delete next.ceiling
    if (resumes) { delete next.preparationFailure; delete next.verificationRecovery; delete next.closeout; delete next.idleSignal }
    const activeOwner = task.attempt?.ownerId
    if (activeOwner !== undefined && (structural || (resumes && task.status === 'blocked'))) {
      next.status = 'blocked'; next.epoch++; this.dropAttempt(next)
      next.resumeAfterStop = { epoch: next.epoch, memberId: activeOwner, reason: 'handoff', at: Date.now() }
    } else {
      if (structural && !next.resumeAfterStop) next.epoch++ // Fence a preparation already awaiting I/O.
      if (resumes && !next.resumeAfterStop && next.status === 'blocked') next.status = 'pending'
    }
    this.assertEffectiveTaskGraph(missionId, { ...next, status: 'pending' }, this.store.list('tasks', missionId).filter(row => row.id !== taskId))
    next.handoff = `${next.handoff ?? ''}\nOwner ${action}: ${reason}`.trim()
    // R20: raising a ceiling no longer has a host park to consume. The exhausted
    // handle is refused by the step brake until its stop confirms, and `parked`
    // now means only the member's own `swarm_wait`, which an owner amendment of
    // one task has no business clearing.
    this.commit(missionId, () => {
      this.store.put('tasks', next)
      this.store.event(missionId, 'task/amended', 'owner', { taskId, action, reason, changes, epoch: next.epoch, status: next.status, ...(activeOwner !== undefined && (structural || (resumes && task.status === 'blocked')) ? { fencedAttemptId: task.attempt!.id } : {}), previous: Object.fromEntries(Object.keys(changes).map(key => [key, task[key as keyof Task] ?? null])) })
    })
    this.attempts.resumeStoppedAttempt(missionId, next, { force: action === 'resume' })
    if (mission.status === 'active') this.kick(missionId)
    return { ...next, ...(changes.dependencies === undefined ? {} : { dependencyChanges: { previous: task.dependencies, current: next.dependencies, added: next.dependencies.filter(id => !task.dependencies.includes(id)), removed: task.dependencies.filter(id => !next.dependencies.includes(id)) } }) }
  }
  amendScope(actor: Actor, missionId: string, scope: string[], reason: string): Mission {
    const { mission, owner } = this.participant(actor, missionId)
    if (!owner || this.isWorkerSession(actor.sessionId)) throw new PolicyError('mission_scope_owner_required', 'authorization_error', 'Only the primary user session may revise mission scope')
    if (terminal(mission) || mission.status === 'staged') throw new PolicyError('mission_scope_not_running', 'conflict_error', 'Mission scope requires a launched, nonterminal mission; edit the saved plan before launch')
    this.bounded(reason); requireStrings(scope, 'scope')
    const normalized = normalizeScopeSelectors(scope); assertScopeSelectors(normalized, 'scope')
    if (this.store.list('tasks', missionId).some(task => task.status !== 'cancelled' && !scopeSubset(task.scope, normalized))) throw new PolicyError('mission_scope_in_use', 'validation_error', 'Mission scope must retain admitted task paths')
    const previous = mission.scope; mission.scope = normalized
    this.commit(missionId, () => { this.store.put('missions', mission); this.store.event(missionId, 'mission/scope-amended', 'owner', { previous, scope: normalized, reason }) })
    return mission
  }
  /** Primary-agent resource decisions change ceilings without resetting consumed work. */
  updateBudget(actor: Actor, missionId: string, input: Budget, reason?: string): Budget {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    const { mission, owner } = this.participant(actor, missionId)
    if (!owner || this.isWorkerSession(actor.sessionId)) throw new PolicyError('mission_budget_owner_required', 'authorization_error', 'Only the primary user session may update a mission budget')
    if (terminal(mission)) throw new PolicyError('mission_budget_closed', 'conflict_error', 'Mission is terminal; its budget cannot be changed')
    if (mission.status === 'staged') throw new PolicyError('mission_budget_staged', 'conflict_error', 'Use the saved plan to set the budget before launch')
    if (reason !== undefined) this.bounded(reason)
    const budget = validatedBudget({ ...input, deadlineAt: input.deadlineAt ?? mission.budget.deadlineAt })
    const tasks = this.store.list('tasks', missionId)
    const admitted = { maxTokens: mission.usedTokens, maxSteps: mission.usedSteps,
      maxWorkers: this.store.list('members', missionId).filter(member => memberPhaseOf(member) !== 'stopped').length, maxTasks: Math.max(tasks.length, this.store.list('workstreams', missionId).length),
      maxExperiments: tasks.filter(task => task.experiment).length }
    for (const key of ['maxTokens', 'maxSteps', 'maxWorkers', 'maxTasks', 'maxExperiments'] as const) {
      if (budget[key] < admitted[key]) throw new PolicyError('mission_allocation_invalid', 'budget_error', `${key} cannot be below existing consumption or admitted work (${admitted[key]})`)
    }
    const elapsed = executionElapsed(mission)
    if (budget.maxDurationMs < elapsed) throw new PolicyError('mission_duration_allocation_invalid', 'budget_error', 'maxDurationMs cannot be below consumed execution time')
    if (!Number.isSafeInteger(Date.now() + budget.maxDurationMs)) throw new PolicyError('mission_duration_invalid', 'validation_error', 'Mission duration exceeds the supported clock range')
    const previous = mission.budget
    mission.budget = budget; mission.updatedAt = Date.now(); mission.budgetReviewedAt = mission.updatedAt
    executionClock(mission, mission.status === 'active' && !mission.budgetPause && this.store.list('tasks', missionId).some(task => task.status === 'running'))
    const deadline = mission.deadline
    const resumeResourceWait = mission.status === 'blocked' && mission.budgetPause !== undefined
      && mission.usedTokens < budget.maxTokens && mission.usedSteps < budget.maxSteps && Date.now() < deadline
    if (resumeResourceWait) { mission.status = 'active'; mission.reason = reason ?? 'Owner reviewed and extended the execution budget' }
    this.commit(missionId, () => {
      this.store.put('missions', mission)
      this.syncStarts(mission)
      this.store.event(missionId, 'mission/budget-updated', 'owner', { previous, budget, usedTokens: mission.usedTokens, usedSteps: mission.usedSteps, deadline, ...(reason === undefined ? {} : { reason }) })
    })
    if (mission.status === 'active') this.kick(missionId)
    return { ...budget }
  }
  /** Owner control does not depend on an agent's willingness to follow a message. */
  control(actor: Actor, missionId: string, action: 'pause' | 'resume' | 'stop' | 'complete' | 'coordinator', reason: string, coordinatorId?: string): Mission {
    const { mission, owner } = this.participant(actor, missionId)
    if (!owner) throw new PolicyError('mission_owner_required', 'authorization_error', 'Only the user session controls mission lifecycle and coordinator appointment')
    if (!['pause', 'resume', 'stop', 'complete', 'coordinator'].includes(action)) throw new PolicyError('mission_action_invalid', 'validation_error', 'Unknown mission control action; retry and extend require a prelaunch requestId')
    this.bounded(reason)
    if (terminal(mission)) throw new PolicyError('mission_terminal', 'conflict_error', 'Mission is terminal; create a new mission to continue')
    if (mission.status === 'staged' && action !== 'stop') throw new PolicyError('mission_staged', 'conflict_error', 'Use the saved plan launch action to activate staged work')
    if (action === 'coordinator') {
      if (!coordinatorId || !this.store.list('members', missionId).some(m => m.id === coordinatorId && memberPhaseOf(m) !== 'stopped')) throw new PolicyError('coordinator_invalid', 'validation_error', 'Unknown coordinator')
      mission.coordinatorId = coordinatorId
    } else if (action === 'complete') {
      // The owner decides; verified coverage and the deliverable are still required.
      const error = this.completionError(mission)
      if (error) throw new PolicyError('mission_completion_pending', 'validation_error', error)
      mission.status = 'completed'
    } else if (action === 'resume') {
      if (mission.usedSteps >= mission.budget.maxSteps || mission.usedTokens >= mission.budget.maxTokens || Date.now() >= mission.deadline) throw new PolicyError('mission_budget_exhausted', 'budget_error', 'Mission budget exhausted; it cannot be resumed with a fresh allowance')
      mission.status = 'active'
    } else mission.status = action === 'pause' ? 'paused' : 'stopped'
    if (mission.status !== 'active' && mission.executionTime !== undefined) executionClock(mission, false)
    mission.reason = reason; mission.updatedAt = Date.now()
    this.commit(missionId, () => {
      this.store.put('missions', mission)
      this.syncStarts(mission)
      if (action === 'pause' || action === 'stop') for (const task of this.store.list('tasks', missionId)) {
        if (task.status !== 'running' && !stopPending(task)) continue
        // A mission stop withdraws the work; a pause only fences it, and a task
        // already cancelled stays cancelled.
        this.attempts.fenceForStop(task, { status: action === 'stop' || task.status === 'cancelled' ? 'cancelled' : 'blocked', cause: `mission-${action}` })
        task.handoff = `${task.handoff ?? ''}\nMission ${action}: ${reason}. Inspect prior workspace/evidence before repeating effects.`
        this.store.put('tasks', task)
      }
      if (terminal(mission) && mission.budgetPause) { delete mission.budgetPause; this.store.put('missions', mission) }
      if (mission.status !== 'active') for (const member of this.store.list('members', missionId)) { delete member.activity; this.store.put('members', member) }
      this.store.event(missionId, `mission/${action}`, 'owner', { reason, coordinatorId: coordinatorId ?? null })
      // No-silent-state row 16: pausing is a durable owner decision. Record the
      // witness for the paused fingerprint so the transition is machine-checkable
      // without waking the owner with a notice about its own action.
      if (action === 'pause') {
        mission.witness = { fingerprint: this.fingerprint(missionId), kind: 'W2', at: Date.now() }
        this.store.put('missions', mission)
      }
    })
    if (mission.status !== 'active') {
      for (const member of this.store.list('members', missionId)) {
        const opening = this.workerStarts.get(member.id)
        this.workerStarts.delete(member.id)
        opening?.controller.abort(new Error(`Mission ${mission.status}`))
      }
    }
    for (const task of this.store.list('tasks', missionId)) if (stopPending(task)) this.attempts.resumeStoppedAttempt(missionId, task, { force: action === 'resume' })
    if (mission.status !== 'active') this.defer(async () => {
      await Promise.all(this.store.list('members', missionId).map(async member => {
        // Tasks with a marker own their stop and checkpoint; never run a stale
        // second stop after that barrier releases a replacement handle.
        if (pendingStopOwner(this.store.list('tasks', missionId), member.id)) return
        if (this.mission(missionId).status === 'active') return
        await this.workers.stop(member.id)
        if (this.closed || !terminal(this.mission(missionId))) return
        const current = this.store.get('members', member.id)
        if (!current || memberPhaseOf(current) === 'stopped') return
        current.phase = 'stopped'
        this.commit(missionId, () => {
          this.store.put('members', current)
          this.store.event(missionId, 'member/stopped', 'runtime', { memberId: current.id })
        })
      }))
    })
    else this.kick(missionId)
    return mission
  }
  private guard(memberId: string, tool: string): string | undefined {
    if (this.shuttingDown) return 'Swarm runtime is shutting down'
    const member = this.store.get('members', memberId)
    if (!member || memberPhaseOf(member) === 'stopped') return 'Worker membership is inactive'
    const mission = this.mission(member.missionId)
    if (mission.status !== 'active' || Date.now() >= mission.deadline || mission.usedSteps > mission.budget.maxSteps || mission.usedTokens >= mission.budget.maxTokens) return 'Mission is inactive or out of budget'
    if (mission.budgetPause) return 'Budget pause is waiting for worker quiescence and a fresh resume assignment'
    if (/^(?:subagent|spawn_agent|agent_teams|cordis|plugin|workflow|ralph)(?:$|_)/.test(tool) || ['send_message', 'interrupt_agent', ...OWNER_ONLY_TOOLS].includes(tool)) return 'Use the swarm work board; alternate delegation and runtime modification bypass mission authority'
    const active = this.store.list('tasks', member.missionId).find(t => t.status === 'running' && t.attempt?.ownerId === memberId)
    // A sandbox Git refusal is diagnostic; reads, edits, and checks remain available.
    if (active && !active.dependencies.every(dep => this.dependencySatisfied(member.missionId, dep))) return 'A prerequisite was invalidated; stop work and inspect the challenge'
    if (active?.reviewOf && this.task(member.missionId, active.reviewOf).status !== 'submitted') return 'The reviewed source is no longer submitted; await a fresh review assignment'
    if (active?.attempt && active.attempt.leaseUntil < Date.now()) return 'Task lease expired; await reassignment'
    if (!active && !tool.startsWith('swarm_')) return 'Claim an assigned task before executing workspace tools'
    return undefined
  }
  private async beforeStep(memberId: string, hasFreshInput = false): Promise<void | false> {
    if (this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    const member = this.store.get('members', memberId)
    if (!member) throw new Error('Unknown worker')
    const mission = this.mission(member.missionId)
    if (mission.status !== 'active') throw new PolicyError('mission_not_active', 'tool_error', `Mission is ${mission.status}`)
    if (mission.budgetPause) return false
    // D1: the step brake. A fence this member still owes a stop for means its
    // handle has already lost the attempt and is waiting to be killed, so every
    // further step of that turn is refused before anything is charged — whatever
    // caused the fence, which is why it sits above the ceiling check rather than
    // beside it. `hasFreshInput` must not lift it: the adapter's recovery inbox
    // preserves rejected input across the stop, so the member sees that input on
    // its next turn instead of buying a mission step with it. A refusal, never a
    // throw: the turn ends, the barrier finishes, the work is preserved.
    if (pendingStopOwner(this.store.list('tasks', mission.id), memberId)) return false
    if (memberPhaseOf(member) === 'parked' && !hasFreshInput) return false
    // D1: a task that exhausted its own step/finding ceiling blocks itself before
    // the next step is charged, so the mission budget is never drained by it.
    const activeTask = this.store.list('tasks', mission.id).find(task => task.status === 'running' && task.attempt?.ownerId === memberId)
    if (activeTask !== undefined) {
      const ceiling = taskCeilingBlock(activeTask)
      if (ceiling !== undefined) { this.blockTaskCeiling(mission, activeTask, ceiling); return false }
    }
    // Requests still streaming for other workers will settle against the same pool.
    if (mission.usedSteps >= mission.budget.maxSteps || mission.usedTokens + this.inFlightEstimate(this.store.list('members', mission.id).filter(item => item.id !== memberId)) >= mission.budget.maxTokens || Date.now() >= mission.deadline) {
      this.blockBudget(mission); throw new Error('Mission aggregate budget exhausted')
    }
    mission.usedSteps++; mission.updatedAt = Date.now()
    this.commit(mission.id, () => {
      // R17-G7: fresh input unparks the member; the derived status follows the attempt.
      if (memberPhaseOf(member) === 'parked') { member.phase = 'active'; this.store.put('members', member) }
      this.store.put('missions', mission)
      for (const task of this.store.list('tasks', mission.id)) if (task.status === 'running' && task.attempt?.ownerId === memberId) {
        task.usedSteps = (task.usedSteps ?? 0) + 1
        task.attempt.leaseUntil = Math.min(mission.deadline, Date.now() + this.config.leaseMs); this.store.put('tasks', task)
      }
    })
    this.warnBudget(mission)
  }
  /**
   * Durable per-task ceiling block. The task stops at its own limit and the owner
   * is told to repair or re-plan. Callers block before charging a mission step,
   * so the blocked task never consumes the mission budget.
   *
   * R20: this used to park the owning member as well, to keep refusing the
   * exhausted handle's steps until the stop barrier below had killed it. The
   * step brake in `beforeStep` refuses them from the stop marker this installs,
   * which is the same window and covers every other fence cause too, so the park
   * is gone: it was a second meaning for `parked` that only this path wrote, and
   * a cancel landing after the barrier settled could no longer clear it, leaving
   * the member waiting forever on work the owner had withdrawn. The member's own
   * row is written only to drop the activity of the attempt just fenced.
   */
  private blockTaskCeiling(mission: Mission, task: Task, ceiling: TaskCeiling): void {
    const ownerId = task.attempt?.ownerId
    const member = ownerId === undefined ? undefined : this.store.get('members', ownerId)
    task.status = 'blocked'
    task.ceiling = ceiling
    task.epoch++
    this.dropAttempt(task); delete task.budgetResume; delete task.closeout; delete task.idleSignal; delete task.gitWriteDenied
    if (ownerId !== undefined) task.resumeAfterStop = { epoch: task.epoch, memberId: ownerId, reason: 'resource', at: Date.now() }
    task.output = `${task.output ?? ''}\n${ceiling.reason}`.trim()
    if (member !== undefined && memberPhaseOf(member) !== 'stopped') delete member.activity
    this.commit(mission.id, () => {
      this.store.put('tasks', task)
      if (member !== undefined) this.store.put('members', member)
      this.store.event(mission.id, 'task/ceiling-exhausted', 'runtime', { taskId: task.id, dimension: ceiling.dimension, limit: ceiling.limit, used: ceiling.used, code: ceiling.code })
    })
    // S4b: the durable event carried the code, the owner notice did not. The
    // shared coded terminal names the task, the dimension and the exits.
    emitGuardTerminal(this, mission.id, 'task_ceiling', { taskId: task.id, ...(ownerId === undefined ? {} : { memberId: ownerId }), detail: `${task.title} (${task.id}) exhausted its own ${ceiling.dimension} ceiling (${ceiling.used}/${ceiling.limit}) and blocked` })
    this.attempts.resumeStoppedAttempt(mission.id, task)
    this.kick(mission.id)
  }
  
  private onActivity(memberId: string, activity?: WorkerActivity): void {
    if (this.closed || this.shuttingDown) return
    const member = this.store.get('members', memberId)
    if (!member) return
    const mission = this.mission(member.missionId)
    if (mission.status !== 'active' || memberPhaseOf(member) === 'stopped' || mission.budgetPause || Date.now() >= mission.deadline) activity = undefined
    const previous = member.activity
    if (activity !== undefined) {
      const task = this.store.list('tasks', mission.id).find(task => task.status === 'running' && task.attempt?.ownerId === memberId)
      // One operation keeps the attempt it started under even if a later assignment races its end.
      const attemptId = member.activity?.id === activity.id ? member.activity.attemptId : task?.attempt?.id
      member.activity = { ...activity, attemptId }
    } else {
      if (member.activity === undefined) return
      delete member.activity
    }
    this.commit(mission.id, () => {
      this.store.put('members', member)
      // Native stream touches advance the state revision without displacing coordination milestones.
      if (previous?.id !== member.activity?.id || previous?.kind !== member.activity?.kind || previous?.attemptId !== member.activity?.attemptId) {
        this.store.event(mission.id, 'member/activity', 'runtime', { memberId, activity: member.activity ?? null })
      }
    })
  }
  

  
  private async recordToolRun(memberId: string, input: Omit<ToolRun, 'id' | 'seq' | 'missionId' | 'memberId' | 'taskId' | 'attemptId' | 'createdAt'>): Promise<string | undefined> {
    if (this.closed || input.tool.startsWith('swarm_')) return undefined
    const member = this.store.get('members', memberId)
    if (!member) return undefined
    const task = this.store.list('tasks', member.missionId).find(t => t.status === 'running' && t.attempt?.ownerId === memberId)
    if (!task?.attempt) return undefined
    const run: ToolRun = { ...input, id: id('run'), missionId: member.missionId, memberId, taskId: task.id, attemptId: task.attempt.id, createdAt: Date.now() }
    // F8: a recorded run may extend the attempt lease, but a stored lease must
    // never outlive the mission deadline (the same clamp every other renewal uses).
    task.attempt.leaseUntil = Math.min(this.mission(member.missionId).deadline, Date.now() + this.config.leaseMs)
    const denied = this.deniedGitWrite(input)
    const firstDenial = denied !== undefined && task.gitWriteDenied === undefined
    if (firstDenial) task.gitWriteDenied = { command: denied, runId: run.id, at: Date.now() }
    // R11-15: a shared-temp rendezvous is decided before the transaction and
    // recorded atomically with the run.
    const rendezvous = this.tempRendezvous(memberId, task.id, input)
    this.commit(member.missionId, () => {
      run.seq = this.store.countToolRuns(member.missionId) + 1
      this.store.put('tool_runs', run); this.store.put('tasks', task)
      this.store.event(member.missionId, 'tool/recorded', memberId, { runId: run.id, seq: run.seq, taskId: task.id, tool: run.tool, isError: run.isError })
      if (rendezvous !== undefined) {
        this.store.event(member.missionId, 'isolation/temp-rendezvous', 'runtime', {
          path: rendezvous.path, firstMemberId: rendezvous.first.memberId, firstTaskId: rendezvous.first.taskId, firstAt: rendezvous.first.at,
          secondMemberId: rendezvous.second.memberId, secondTaskId: rendezvous.second.taskId, secondAt: rendezvous.second.at,
          windowMs: TEMP_RENDEZVOUS_WINDOW_MS, detection: 'command-mention',
        })
        this.notify(member.missionId, `Two members named the same shared temp path ${rendezvous.path} inside ${Math.round(TEMP_RENDEZVOUS_WINDOW_MS / 60_000)} minute(s): ${rendezvous.first.memberId} then ${rendezvous.second.memberId}. The host temp roots are writable by every workspace-write execution; never use them to pass state between members or missions.`,
          tempRendezvousSubjects(this, member.missionId, rendezvous), { from: memberId })
      }
      if (!firstDenial) return
      // Durable audit plus a typed delivery, so the worker learns the supported
      // host capture path without disabling unrelated workspace tools.
      this.store.event(member.missionId, 'task/git-write-denied', memberId, { taskId: task.id, attemptId: task.attempt!.id, command: denied, runId: run.id })
      this.store.put('deliveries', { id: id('msg'), missionId: member.missionId, from: 'runtime', to: memberId, kind: 'control', content: gitWriteDeniedMessage(denied!), createdAt: Date.now() })
    })
    return run.id
  }
  /**
   * R11-01: record one classified provider outage inside the caller's
   * transaction. The durable row is bounded to one per member and class per
   * window; the owner notice fires on a class transition. The affected attempt
   * is preserved (the adapter retries it in place), so nothing here re-pends or
   * charges recovery credit.
   */
  private recordProviderOutage(member: Member, outage: ProviderOutage): void {
    const current = this.store.get('members', member.id)
    if (current === undefined || memberPhaseOf(current) === 'stopped') return
    member = current
    const previous = member.providerOutage
    const duplicate = previous !== undefined && previous.class === outage.class && Date.now() - previous.at < PROVIDER_OUTAGE_EVENT_WINDOW_MS
    member.providerOutage = { ...outage, at: Date.now() }
    this.store.put('members', member)
    if (duplicate) return
    // R17-G1: the member's open work comes from the shared interpretation.
    const view = this.interpretation(member.missionId)
    const open = view.tasks.filter(task => task.status === 'running' && task.attempt?.ownerId === member.id)
    this.store.event(member.missionId, 'provider/outage', 'runtime', { memberId: member.id, class: outage.class, status: outage.status, message: outage.message, taskIds: open.map(task => task.id) })
    // One owner notice per class transition, never one per retry.
    if (previous?.class !== outage.class) {
      // R15-A1/A4: a member-scoped notice names that member's open work: the
      // subject is the task whose clock the outage holds, never the whole board.
      // The mission root is the fallback only when the member owns no open task.
      this.notify(member.missionId,
        `${member.name} provider ${outage.class} outage${outage.status === undefined ? '' : ` (HTTP ${outage.status})`}: ${outage.message}. Its attempt is preserved and no recovery credit is spent while the route is quiescent.`,
        open.length ? view.subjectsOf(open) : [missionSubject(view.mission)], { from: member.id })
    }
  }
  /** R11-01: the member's route is quiescent only inside the outage window. */
  private providerQuiescent(member: Member): ProviderOutage | undefined {
    const outage = member.providerOutage
    return outage !== undefined && Date.now() - outage.at <= PROVIDER_OUTAGE_WINDOW_MS ? outage : undefined
  }
  /** R11-01: a successful start or operation proves the route recovered. */
  clearProviderOutage(missionId: string, memberId: string): void {
    const member = this.store.get('members', memberId)
    if (member === undefined) return
    // S5c: a successful start also clears the durable consecutive-failure count
    // (the same event that proves the route recovered proves the failures
    // stopped). `startFailures` stays as the in-process mirror only.
    const fields = startFailureFields(member)
    const outage = member.providerOutage
    const failures = fields.startFailures
    if (outage === undefined && failures === undefined) return
    delete member.providerOutage
    delete fields.startFailures
    this.commit(missionId, () => {
      this.store.put('members', member)
      if (outage !== undefined) this.store.event(missionId, 'provider/recovered', 'runtime', { memberId })
    })
  }
  private onProviderOutage(memberId: string, outage: ProviderOutage): void {
    if (this.closed || this.shuttingDown) return
    const member = this.store.get('members', memberId)
    if (member === undefined) return
    const mission = this.store.get('missions', member.missionId)
    if (mission === undefined || terminal(mission)) return
    this.commit(member.missionId, () => this.recordProviderOutage(member, outage))
  }
  private onFailure(memberId: string, error: string): void {
    if (this.closed || this.shuttingDown) return
    const member = this.store.get('members', memberId)
    if (!member) return
    // W8: a rejected reasoning effort also surfaces asynchronously on the first
    // worker request. Keep the durable event shape, but wake the owner with the
    // supported exit instead of the raw provider text.
    const rejection = unsupportedEffort(error)
    const message = rejection !== undefined && member.reasoningEffort !== undefined
      ? `${member.name} cannot run: ${rejection.message}. Its route is fixed for this session; admit a replacement member without reasoningEffort (or with an effort this provider/model supports) and reassign its work.`
      : `${member.name} failed: ${error}`
    this.commit(member.missionId, () => {
      this.store.event(member.missionId, 'member/failure', memberId, { error })
      // R15-A1: a member failure with no assigned task still names the member's
      // unfinished work; the mission root is the fallback, never silence.
      this.notify(member.missionId, message, this.noticeSubjectsFor(member.missionId, { memberId: member.id }))
    })
  }
  /**
   * H-3: a cross-owner recovery could not capture the previous owner's workspace
   * as an artifact. This used to reach only an in-memory list nobody read: the
   * replacement started from a fallback commit while the log, the owner and
   * `swarm_observe` said nothing. It is now a durable task fact: the summary on
   * the task row (the assignment and observe projections carry it), one event,
   * and one owner notice, whether the WIP was carried by a preservation snapshot
   * or left behind in the old worktree. Fired from inside the preparing
   * dispatch, which re-reads the task after preparation, so the revision bump
   * here is never overwritten by the pre-preparation row.
   *
   * A re-preparation (the replacement's own start failed, the task was
   * re-pended and re-routed) re-trips capture on the same untouched worktree
   * and reports the same fallback again under a new attempt epoch. The summary
   * already on the task row identifies that fact (previous owner and commit),
   * so it is not recorded or announced a second time.
   */
  onRecoveryFallback(info: RecoveryFallback): void {
    if (this.closed) return
    const names = (memberId: string) => this.store.get('members', memberId)?.name ?? memberId
    const previous = names(info.previousOwnerId)
    const content = info.preserved
      ? `${names(info.memberId)} inherited ${previous}'s uncaptured work on ${info.taskId} from preservation snapshot ${info.commit} (${info.reason}). It includes the out-of-scope changes the artifact refused; the new owner must revert or move them before submitting.`
      : `${info.taskId} restarted on ${names(info.memberId)} from ${info.commit} without ${previous}'s uncaptured work (${info.reason}). That work exists only in ${previous}'s worktree until it is preserved.`
    this.commit(info.missionId, () => {
      const task = this.store.get('tasks', info.taskId)
      if (task === undefined || task.missionId !== info.missionId) return
      if (task.recovery?.previousOwnerId === info.previousOwnerId && task.recovery.commit === info.commit) return
      task.recovery = { epoch: info.epoch, previousOwnerId: info.previousOwnerId, commit: info.commit, preserved: info.preserved, reason: info.reason, at: Date.now() }
      this.store.put('tasks', task)
      this.store.event(info.missionId, 'task/recovery-fallback', 'runtime', { taskId: info.taskId, epoch: info.epoch, from: info.previousOwnerId, to: info.memberId, commit: info.commit, preserved: info.preserved, reason: info.reason })
      // A carried snapshot asks nothing of the owner; a left-behind worktree may.
      this.notify(info.missionId, content, this.noticeSubjectsFor(info.missionId, { taskId: info.taskId }), { noticeClass: info.preserved ? 'progress' : 'decision', trigger: 'task/recovery-fallback', reason: info.reason })
    })
  }
  /**
   * H-3 follow-up: a disposable verification checkout could not be removed
   * after its declared checks ran. The same silent channel as the recovery
   * fallback: before this wiring, a tree left under the mission's
   * `verification/` directory or a stale worktree registration in the source
   * repository reached nobody.
   * The check results were already returned and the verdict is decided from
   * them; this records one durable event and one owner notice naming the
   * checkout and the removal failure, so the leftover is something the owner
   * can find and remove.
   */
  onVerificationCleanupFailure(info: VerificationCleanupFailure): void {
    if (this.closed) return
    const task = this.store.get('tasks', info.taskId)
    if (task === undefined || task.missionId !== info.missionId) return
    // The fallback removal may already have reclaimed the tree; only the owner
    // can tell, so the notice names what to look for rather than asserting it.
    const content = `Verification checkout ${info.checkout} for ${info.taskId} could not be removed cleanly after its checks ran (${info.reason}). The check results and the verdict stand; if that directory or its worktree registration in the source repository is still present, delete it and run \`git worktree prune\` there.`
    this.commit(info.missionId, () => {
      this.store.event(info.missionId, 'task/verification-cleanup-failed', 'runtime', { taskId: info.taskId, memberId: info.memberId, checkout: info.checkout, reason: info.reason })
      this.notify(info.missionId, content, this.noticeSubjectsFor(info.missionId, { taskId: info.taskId }), { noticeClass: 'progress', trigger: 'task/verification-cleanup-failed', reason: info.reason })
    })
  }
  /**
   * R5-02: a `workers.start` failure is a recoverable interruption, not a
   * permanent block of the member's work. Mirror the preparation, lease-expiry
   * and close-out policy: spend exactly one recovery credit per affected task
   * and re-pend while its limit is not exhausted (blocking only at the limit,
   * with the reason in `task.output`). The same member is retried for
   * `START_FAILURE_REROUTE_LIMIT` consecutive failures so a transient start
   * error self-heals; at the limit the route is retired and its work re-routed
   * to another capable live member with a durable `task/reassigned` event. A
   * successful start clears the member's consecutive failure counter.
   */
  onStartFailure(mission: Mission, member: Member, error: unknown): void {
    if (this.closed || this.shuttingDown) return
    const missionId = mission.id
    const current = this.store.get('missions', missionId)
    if (current === undefined || current.status !== 'active') return
    const latest = this.store.get('members', member.id)
    if (latest === undefined || memberPhaseOf(latest) === 'stopped') return
    member = latest
    // R11-01: classify at the boundary. A provider outage (quota, rate limit,
    // provider unavailable) is a quiescent route, not this member's failure:
    // it spends no recovery credit, does not count toward retiring the route,
    // and the work moves to another capable live member when one exists.
    const outage = classifyProviderOutage(error) ?? this.providerQuiescent(member)
    const reason = outage !== undefined ? `Provider ${outage.class} outage: ${outage.message}` : `Worker could not start: ${String(error)}`
    // S5c: the count is read from the durable member row (the map is the mirror),
    // so losing the map — or restarting the runtime — continues the count instead
    // of resetting the route's budget.
    const durable = this.store.get('members', member.id) ?? member
    const consecutiveFailures = (startFailureFields(durable).startFailures ?? this.startFailures.get(member.id) ?? 0) + 1
    if (outage === undefined) {
      startFailureFields(member).startFailures = consecutiveFailures
      this.startFailures.set(member.id, consecutiveFailures)
    }
    const reroute = outage === undefined && consecutiveFailures >= START_FAILURE_REROUTE_LIMIT
    // Below the limit the member stays live so the next tick retries the same
    // route; at the limit it is retired exactly like a dead session. A quiescent
    // route is always kept live: the provider may recover on the next tick.
    if (reroute) member.phase = 'stopped'
    this.commit(missionId, () => {
      if (outage === undefined) this.store.put('members', member)
      else this.recordProviderOutage(member, outage)
      for (const task of this.store.list('tasks', missionId)) {
        if (task.assigneeId !== member.id || !['pending', 'running'].includes(task.status)) continue
        task.output = reason
        if (task.attempt !== undefined) task.epoch++
        this.dropAttempt(task); delete task.closeout; delete task.idleSignal; delete task.gitWriteDenied
        const pinned = task.assigneeId
        delete task.assigneeId
        task.status = 'pending'
        const limit = task.maxRecoveryAttempts ?? this.config.maxTasksPerMember
        const target = task.assignmentMode !== 'pinned' && (outage !== undefined || reroute) ? this.rerouteTarget(missionId, task, member.id) : undefined
        // Re-route wins over the credit limit: the obligation moves to another
        // live route instead of blocking, and the credit spent so far travels
        // with the task so the new owner still has a bounded budget.
        if (target !== undefined) task.assigneeId = target.id
        // No capable target: keep the same live route below the limit, and
        // release the work to any live member once the route is retired.
        else if (!reroute || task.assignmentMode === 'pinned') task.assigneeId = pinned
        const exhausted = false // Route startup is infrastructure recovery, never task execution credit.
        task.status = exhausted ? 'blocked' : 'pending'
        this.store.put('tasks', task)
        this.store.event(missionId, 'task/start-failed', 'runtime', { taskId: task.id, epoch: task.epoch, reason, recoveryCount: task.recoveryCount ?? 0, maxRecoveryAttempts: limit, status: task.status, consecutiveFailures, quiescent: outage !== undefined })
        if (target !== undefined) {
          this.store.event(missionId, 'task/reassigned', 'runtime', { taskId: task.id, from: member.id, to: target.id, reason, consecutiveFailures })
          continue
        }
        if (!exhausted) continue
        this.store.event(missionId, 'task/blocked', 'runtime', { taskId: task.id, reason })
        this.notify(missionId, `${reason} (${task.id} exhausted its recovery limit of ${limit})`, this.interpretation(missionId).subjectsOf([task]))
      }
      this.store.event(missionId, 'member/resume-failed', 'runtime', { memberId: member.id, error: String(error), consecutiveFailures, rerouted: reroute, ...(outage === undefined ? {} : { outage: outage.class }) })
      // The outage notice is emitted by `recordProviderOutage`; do not claim a
      // recovery credit that was never spent.
      if (outage !== undefined) return
      this.notify(missionId, reroute
        ? `${member.name} could not start after ${consecutiveFailures} consecutive failures; its work remains on the board; capable live routes may claim it, or use swarm_control with taskId and action=amend to choose an assignee.`
        : `${member.name} could not start (failure ${consecutiveFailures} of ${START_FAILURE_REROUTE_LIMIT}); its queued work and task recovery allowance are preserved.`,
        this.noticeSubjectsFor(missionId, { memberId: member.id }))
    })
  }
  defer(fn: () => Promise<void>): void {
    if (this.shuttingDown) return
    const operation = new Promise<void>(resolve => setImmediate(resolve)).then(fn)
    this.operations.add(operation)
    void operation.catch(error => { if (!this.closed) process.stderr.write(`[agent-swarm] ${String(error)}\n`) }).finally(() => this.operations.delete(operation))
  }
  
  
  
  /**
   * S1: the declared no-progress window, as an integer number of passes
   * (default 3, i.e. 3 × `tickMs`). Configuration, never a constant.
   */
  get stallPasses(): number {
    const value = Math.trunc(this.config.stallPasses ?? DEFAULT_STALL_PASSES)
    return Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_STALL_PASSES
  }
  /**
   * S1: the declared bound on one scheduling pass (default 30 × `tickMs`). A
   * pass still queued or running past this bound has produced no durable change
   * for the whole window; the watchdog names it and the mission publishes as
   * wedged until the body settles.
   */
  get stallPassTimeoutMs(): number {
    const value = Math.trunc(this.config.stallPassTimeoutMs ?? this.config.tickMs * DEFAULT_STALL_PASS_TIMEOUT_TICKS)
    return Number.isSafeInteger(value) && value >= this.config.tickMs ? value : this.config.tickMs
  }
  /**
   * R16-D: the declared window a wedged pass stays live (unnamed) while the
   * mission has live work (default: the pass bound itself, read as
   * `stallPassTimeoutMs`; `stallPassLiveGraceMs: 0` names it at the first bound).
   * Structural read: `RuntimeConfig` (src/types.ts) and the plugin `Config`
   * schema (src/index.ts) are outside this task's write scope, so the two schema
   * lines are a recorded hand-off — a runtime handed `stallPassLiveGraceMs` uses
   * it, one without it uses the default.
   */
  get stallPassLiveGraceMs(): number {
    const raw = (this.config as { stallPassLiveGraceMs?: unknown }).stallPassLiveGraceMs
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw)
    return this.stallPassTimeoutMs * DEFAULT_STALL_PASS_LIVE_GRACE_TICKS
  }
  /**
   * R16-D: the total bound a wedged pass is measured against once it has live
   * work to progress. Past it the pass is named even though the live work
   * remains — the work is preserved and named, generation is not held hostage.
   */
  get stallPassReleaseBoundMs(): number { return this.stallPassTimeoutMs + this.stallPassLiveGraceMs }
  /**
   * R16-D: the declared bound on an attempt's durable progress (see
   * `DEFAULT_ATTEMPT_SILENCE_BOUND_MS`). Structural read with the same hand-off
   * as `stallPassLiveGraceMs`.
   */
  get attemptSilenceBoundMs(): number {
    const raw = (this.config as { attemptSilenceBoundMs?: unknown }).attemptSilenceBoundMs
    if (raw === 0) return 0
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ATTEMPT_SILENCE_BOUND_MS
  }
  /**
   * R16-D: the durable reporting bound verdict for the live attempt on one task
   * (`taskId@epoch` + member), or undefined when the attempt is inside its bound
   * or another guard owns it (F1's operation, the W6 idle close-out, a parked
   * member, a budget pause). Exposed for the pair tests and the owner read path;
   * the sweep that acts on it is `sweepDecisions`.
   */
  silentAttempt(task: Task, mission: Mission): ReturnType<Scheduling['silentAttempt']> { return this.scheduling.silentAttempt(task, mission) }
  /** R16-D: the bounded sweep behind the escalation; returns how many attempts it named. */
  sweepSilentAttempts(missionId: string): number { return this.scheduling.sweepSilentAttempts(missionId) }
  
  
  
  
  
  
  /** Two declared scopes overlap when either is `**`, equal, or one contains the other. */
  scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
    return left.some(a => right.some(b => scopeKeysOverlap(a, b)))
  }
  
  /**
   * A durable refusal, not a silent skip: the invariant is named, the offending
   * member and worktree are recorded, and the owner is told the executable exit
   * (each live member needs its own isolated worktree). Dedup is per distinct
   * violation so a corrupted board does not wake the owner every tick.
   */
  refuseIsolation(missionId: string, member: Member, violation: string): void {
    const mission = this.store.get('missions', missionId)
    if (mission === undefined || terminal(mission)) return
    const key = `${member.id}:${violation}`
    if (mission.isolationRefusal === key) return
    mission.isolationRefusal = key
    mission.updatedAt = Date.now()
    this.commit(missionId, () => {
      // The refusal is durable twice over: the mission row keeps the exact
      // violation (so it is re-derivable and clears only when repaired) and the
      // owner notice is a durable delivery with the executable exit.
      this.store.put('missions', mission)
    })
    // S4b: the isolation refusal is the workspace chain's terminal for this
    // dispatch. The violation is preserved verbatim as the detail and the owner
    // gets the shared coded decision request instead of prose.
    emitGuardTerminal(this, missionId, 'workspace', { memberId: member.id, detail: `isolation invariant refused a dispatch to ${member.name} (${member.id}): ${violation}` })
  }
  
  
  
  
  
  /**
   * Queue one scheduling body on the mission's serial queue, unless one is
   * already queued or running there (`openPass`): that body re-reads the board
   * when it runs, and the queue could not start a second one before it settles.
   * The record is removed in `closePass` when the body settles, whatever the
   * outcome; the tick watchdog names a body that holds it past its bound.
   */
  kick(missionId: string): void {
    if (this.shuttingDown || this.closed) return
    const pass = this.openPass(missionId)
    if (pass === undefined) return
    this.defer(async () => {
      try { await this.exclusive(missionId, () => this.schedule(missionId)) }
      finally {
        this.closePass(missionId, pass)
        const mission = this.closed ? undefined : this.store.get('missions', missionId)
        if (mission?.status === 'active' && mission.budgetPause?.quiesced) this.kick(missionId)
      }
    })
  }
  private ensureWorkers(mission: Mission): void {
    for (const member of this.store.list('members', mission.id)) {
      if (this.shuttingDown) return
      if (memberPhaseOf(member) === 'stopped') continue
      this.defer(async () => { try { await this.startWorker(mission, member) } catch { /* recorded once by startWorker */ } })
    }
  }
  /** One bounded startup per member, shared by admission, recovery and dispatch. */
  startWorker(mission: Mission, member: Member, options: { admission?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (this.closed || this.shuttingDown) return Promise.reject(new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down'))
    if (pendingStopOwner(this.store.list('tasks', mission.id), member.id)) return Promise.reject(new Error('Worker is waiting for its previous attempt to stop'))
    const existing = this.workerStarts.get(member.id)
    const superseded = existing !== undefined && options.admission && (existing.admissionSignal !== options.signal || (!existing.nativePending && existing.retryAfter !== undefined))
    if (superseded) existing.controller.abort(new Error('Worker startup superseded by a new admission'))
    else if (existing !== undefined && (existing.nativePending || existing.retryAfter === undefined || Date.now() < existing.retryAfter)) return existing.promise
    const controller = new AbortController()
    const cancel = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    const configured = this.config.workerStartTimeoutMs
    const timeoutMs = configured !== undefined && Number.isFinite(configured) && configured > 0 ? Math.min(configured, 2147483647) : 60_000
    const timer = setTimeout(() => controller.abort(new Error(`Worker startup timed out after ${timeoutMs}ms`)), timeoutMs)
    let failed = false
    const promise = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted()
        const current = this.store.get('missions', mission.id)
        const latest = this.store.get('members', member.id)
        const active = current?.status === 'active' || (options.admission && current?.status === 'staged')
        if (!active || latest === undefined || memberPhaseOf(latest) === 'stopped') throw new Error('Worker startup is no longer active')
        if (pendingStopOwner(this.store.list('tasks', mission.id), member.id)) throw new Error('Worker is waiting for its previous attempt to stop')
        try {
          const selected = options.admission ? { ...latest, provider: member.provider, model: member.model, reasoningEffort: member.reasoningEffort } : latest
          const native = Promise.resolve(this.workers.start({ mission: current!, member: selected, ownerSessionId: current!.ownerSessionId }, controller.signal))
          const entry = this.workerStarts.get(member.id)!
          entry.nativePending = true
          void native.then(() => { entry.nativePending = false }, () => { entry.nativePending = false })
          await abortableStart(native, controller.signal)
          controller.signal.throwIfAborted()
        } catch (error) {
          failed = true
          controller.abort(error)
          // The admission caller owns its option fallback/rollback. Shared
          // recovery/dispatch waiters record one actual native failure only.
          if (!options.admission && !options.signal?.aborted && this.workerStarts.get(member.id)?.controller === controller) this.onStartFailure(mission, member, error)
          throw error
        }
        if (this.closed || this.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
        const live = this.store.get('members', member.id)
        const status = this.store.get('missions', mission.id)?.status
        if ((status !== 'active' && !(options.admission && status === 'staged')) || live === undefined || memberPhaseOf(live) === 'stopped') {
          controller.abort(new Error('Worker startup is no longer active'))
          this.defer(() => this.workers.stop(member.id))
          throw controller.signal.reason
        }
        // A bookkeeping failure is not a failed native startup: it must not
        // cancel a working handle or charge task recovery credit.
        this.startFailures.delete(member.id)
        this.clearProviderOutage(mission.id, member.id)
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', cancel)
        const entry = this.workerStarts.get(member.id)
        if (entry?.controller === controller) {
          // Keep a timed-out opening fenced until its native cleanup settles.
          // Multiple callers of that same opening never spend more credits.
          if (failed) entry.retryAfter = Date.now() + this.config.tickMs
          else this.workerStarts.delete(member.id)
        }
      }
    })
    this.workerStarts.set(member.id, { controller, promise, admissionSignal: options.admission ? options.signal : undefined })
    return promise
  }
  private async schedule(missionId: string): Promise<void> {
    if (this.shuttingDown) return
    const mission = this.mission(missionId)
    if (mission.status !== 'active') { await this.flushOutbox(missionId); return }
    if (mission.budgetPause) {
      if (!mission.budgetPause.quiesced) {
        this.beginBudgetStop(missionId, mission.budgetPause.id)
        await this.flushOutbox(missionId); return
      }
      this.resumeBudgetTasks(mission)
    }
    if (this.completeAutomatic(missionId)) { await this.flushOutbox(missionId); return }
    if (Date.now() >= mission.deadline || mission.usedTokens >= mission.budget.maxTokens || mission.usedSteps >= mission.budget.maxSteps) { this.blockBudget(mission); return }
    // F2: a submitted code deliverable no live review can accept is repaired
    // before dispatch, so the auto-admitted review can be scheduled this tick.
    this.admitMissingReviews(this.mission(missionId))
    // S1 (P0): the lease-expiry sweep is src/attempts.ts#recoverExpired, in the
    // same order as before; it iterates ids and re-reads each row inside the loop,
    // so a row committed during its awaits is never written back over.
    if (!await this.attempts.recoverExpired(mission, missionId)) return
    // M1a seam 7/7: the dispatch sweep is src/scheduling.ts#dispatch, in the same
    // order as before; a false result abandons the pass where the loop's early
    // returns did.
    if (!await this.scheduling.dispatch(mission, missionId)) return
    // Backstop: a full pass that dispatched nothing must still witness the state.
    this.ensureWitness(missionId)
    // S2: the pass flushes its own outbox (bounded per delivery), and the
    // queue-external tick pump is the backstop that delivers durable notices
    // while this pass is wedged or the mission lock is held.
    await this.flushOutbox(missionId)
  }
  
  
  /** Drain all runtime operations and worker handles before releasing database ownership. */
  dispose(): Promise<void> {
    return this.disposal ??= this.disposeRuntime()
  }
  private async disposeRuntime(): Promise<void> {
    this.shuttingDown = true
    if (this.timer) clearInterval(this.timer)
    for (const controller of this.startControllers.values()) controller.abort(new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down'))
    for (const { controller } of this.workerStarts.values()) controller.abort(new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down'))
    let workerError: unknown
    try { await this.workers.dispose() } catch (error) { workerError = error }
    try {
      // S1: a pass body wedged in an adapter call must not make shutdown
      // unbounded. Drain within the declared pass bound; the abandoned body then
      // observes `this.closed` at its next checkpoint. The losing timer is
      // cleared, so a completed dispose leaves no handle behind — a ref'd
      // timeout here would keep a test or CLI process alive for the whole bound.
      const drain = Promise.allSettled([...this.operations, ...this.queues.values()])
      let bound: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([drain, new Promise<void>(resolve => { bound = setTimeout(resolve, this.stallPassTimeoutMs) })])
      } finally { if (bound !== undefined) clearTimeout(bound) }
    }
    finally {
      // R17-G8: and the claimed-signal subscription goes with it.
      this.notices.dispose()
      this.observeCursors.clear(); this.ownerObserveCursors.clear()
      this.closed = true; this.listeners.clear(); this.store.close()
    }
    if (workerError !== undefined) throw workerError
  }
}

/**
 * R15-A1: the subjects of the temp-rendezvous warning — the two tasks whose
 * commands named the shared temp path, deduplicated in first-seen order, with the
 * mission root when a task row is already gone. A bounded linear scan instead of
 * an in-memory index, so the S5 census keeps its exact collection inventory.
 */
function tempRendezvousSubjects(rt: SwarmRuntime, missionId: string, rendezvous: { first: { taskId: string }; second: { taskId: string } }): string[] {
  const subjects: string[] = []
  for (const taskId of [rendezvous.first.taskId, rendezvous.second.taskId]) {
    if (typeof taskId !== 'string' || subjects.includes(taskId)) continue
    const task = rt.store.get('tasks', taskId)
    const subject = task === undefined ? `mission:${missionId}` : `${task.id}@${task.epoch}`
    if (!subjects.includes(subject)) subjects.push(subject)
  }
  return subjects.length ? subjects : [`mission:${missionId}`]
}
