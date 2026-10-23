/** Durable swarm records and the execution adapter shared by runtime and Harness. */
import type { EventKind } from './events.ts'
export type MissionStatus = 'staged' | 'active' | 'paused' | 'blocked' | 'completed' | 'stopped'
export type TaskKind = 'research' | 'implementation' | 'verification' | 'integration'
export type TaskStatus = 'pending' | 'running' | 'submitted' | 'accepted' | 'blocked' | 'cancelled'
/**
 * R17-G7: the live member status. It is DERIVED, never durable: `SwarmStore`
 * strips it from every member write and re-derives it on every member read from
 * the durable `MemberPhase` plus the tasks that name the member as the owner of
 * a running attempt (`src/projection.ts`, `deriveMemberStatus`). No stored field
 * can therefore mirror a live fact, which is what makes the R15-F2 seam — a
 * durable row saying `idle` while a live attempt exists — impossible by
 * construction instead of repaired by reconciliation.
 */
export type MemberStatus = 'idle' | 'working' | 'waiting' | 'stopped'
/**
 * R17-G7: the durable member lifecycle phase — the only member lifecycle state
 * the store persists. `active` is the default (and what every row written
 * before the phase existed means); `parked` is the member's own `swarm_wait`
 * intent, which survives a restart; `stopped` is terminal.
 */
export type MemberPhase = 'active' | 'parked' | 'stopped'
export type EvidenceStatus = 'unverified' | 'verified' | 'challenged' | 'refuted'
/** Per-task effort dimensions that block the task itself instead of draining the mission budget. */
export type TaskCeilingDimension = 'maxSteps' | 'maxFindings'
/** Saved values keep origin labels truthful when canonical drafts are edited. */
export type TaskCeilingProvenance = Partial<Record<TaskCeilingDimension, { source: 'agent' | 'default'; value: number }>>
/**
 * Durable per-task ceiling exhaustion. The runtime blocks the task at its own
 * limit and records this reason, so a runaway task never consumes the mission
 * budget first and the owner can raise or replace it explicitly.
 */
export interface TaskCeiling {
  dimension: TaskCeilingDimension
  limit: number
  used: number
  /** Stable machine-checkable reason code; never reword without a migration. */
  code: 'task_ceiling_exhausted'
  reason: string
  at: number
}
export interface Budget {
  maxTokens: number
  maxSteps: number
  maxWorkers: number
  maxDurationMs: number
  maxTasks: number
  maxExperiments: number
  /** Optional absolute user deadline, distinct from the execution-time estimate. */
  deadlineAt?: number
}
/**
 * Provider-reported usage split into billing buckets. `outputTokens` already
 * includes `reasoningTokens`; cache buckets are disjoint from uncached input.
 * `requests` counts physical model requests carrying usage, not logical steps.
 */
export interface UsageBuckets {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  requests: number
}
/** Host session generation, persisted before creating a replacement native log. */
export interface UsageSnapshotSource {
  generation: number
  /** Only used to migrate a member written before session-specific watermarks existed. */
  restored: boolean
}
/** Host-created immutable starting point; never supplied by a model plan. */
export interface WorkspaceBaseline {
  sourceHead: string
  snapshotCommit: string
  planningWorkspace: string
  changedPaths: string[]
  createdAt: number
}
export interface DeliveryInspection {
  baselineCommit: string
  resultCommit: string
  changedPaths: string[]
  diff: string
  truncated: boolean
}
export interface DeliveryApplication {
  status: 'applied' | 'conflicts'
  changedPaths: string[]
  conflicts: string[]
}
/**
 * R11-01: closed provider-outage classes. The adapter classifies an HTTP/class
 * condition (402/429/5xx, quota, provider-unavailable, a signed-out or refused
 * account credential) into one of these so the runtime can pause, route or
 * re-assign without parsing provider text. `PROVIDER_FAILURE_CODES` in
 * `scheduler.ts` maps each Harness failure code it decides to one of them.
 */
export type ProviderOutageClass = 'quota' | 'rate-limit' | 'unavailable' | 'credential'
/** R11-01: one classified provider outage; `status` is the HTTP status when known. */
export interface ProviderOutage {
  class: ProviderOutageClass
  status?: number
  message: string
}
/** The last classified outage observed for a member, used to avoid spending recovery credit. */
export interface MemberProviderOutage extends ProviderOutage { at: number }
/**
 * A model step the member's own route refused (`PROVIDER_FAILURE_CODES` class
 * `member` in `scheduler.ts`): the Harness failure code and the host's text. A
 * member's route is fixed for its session, so no wait, retry or recovery of
 * that member runs it again.
 */
export interface MemberRouteRefusal { code: string; message: string }
/** The route fields one member admission names; each one it omits is inherited from the owner's conversation. */
export type MemberRouteInput = Pick<PlanMember, 'provider' | 'model' | 'reasoningEffort'>
/**
 * The host's answer for one member's route, resolved as its worker will run it
 * and prepared as its model step prepares it (`memberRoutes`,
 * src/model-selection.ts). Accepted; refused for its reasoning effort, with the
 * efforts the route declares (none when its model declares no reasoning);
 * model-refused, the route refusing its model with a `member`-class code
 * (`MemberRouteRefusal`) other than the effort's, as the DeepSeek account
 * catalog does with MODEL_UNSUPPORTED and CLIENT_UPGRADE_REQUIRED; or
 * unavailable, a route the host does not resolve at all. `provider` and `model`
 * are the route the worker would run, inherited ones included; the host's own
 * text is never carried.
 */
export type MemberRoute =
  | { verdict: 'accepted' }
  | { verdict: 'effort-unsupported'; provider: string; model: string; effort: string; efforts: string[] }
  | { verdict: 'model-refused'; provider: string; model: string; code: string }
  | { verdict: 'unavailable'; provider: string; model: string }
/** R11-01: how long a classified provider outage keeps a member's route quiescent. */
export const PROVIDER_OUTAGE_WINDOW_MS = 5 * 60_000
/**
 * R11-01: the member's route is quiescent only inside the outage window of its
 * last classified outage: the window reading of `Member.providerOutage` (the
 * field states both of its readings). The start failure's classification,
 * start pacing, re-routing and the live-work panel ask it.
 */
export function providerQuiescent(member: Pick<Member, 'providerOutage'>, now: number): MemberProviderOutage | undefined {
  const outage = member.providerOutage
  return outage !== undefined && now - outage.at <= PROVIDER_OUTAGE_WINDOW_MS ? outage : undefined
}
/**
 * R11-19: the host's measured declared-check envelope. Structural mirror of the
 * `Workspaces` value so the adapter interface never imports the Node-only
 * workspace module.
 */
export interface CheckEnvelope {
  limit: number
  active: number
  queued: number
  maxActive: number
  completed: number
  totalWaitMs: number
  maxWaitMs: number
  totalRunMs: number
  maxRunMs: number
}
/** One declared check's outcome as the host recorded it; `failureKind`, classified where the row is produced, marks one that decides no verdict: the host's check deadline (stored as exit 124), a host that could not execute it, or exit 126/127 (it could not run in the checkout). */
export interface CheckResult { command: string; exitCode: number; output: string; truncated?: boolean
  failureKind?: 'timeout' | 'infrastructure' | 'unrunnable'
  /** ENV: failure attribution captured ahead of the output bound; durable with the check row. */
  attribution?: CheckAttribution
  /** ENV: the environment this check actually ran under. */
  environment?: CheckEnvironment }
/**
 * ENV: the environment a declared check runs under, stated as facts instead of
 * folklore, so the assignee knows which environment the host check will use and
 * a verification can tell when the executed check did not reproduce it.
 *
 * `home`, the two user cache roots, the sandbox policy and the dependency links
 * are what an execution must reproduce. `checkCacheRoot`/`checkCacheRoots` are the
 * scoped roots the envelope itself provides inside the disposable checkout: they
 * differ by design on every run and are excluded from the reproduction
 * comparison. Existence flags are recorded and reported but never refuse an
 * acceptance: a check must not depend on the ambient cache staying warm.
 *
 * Declared beside `CheckEnvelope` for the same reason: the adapter interface
 * and the runtime read it without importing the Node-only workspace module,
 * which re-exports it.
 */
export interface CheckEnvironment {
  /** HOME the check process receives; null when it inherits none. */
  home: string | null
  /** User-level cache directory the check's HOME resolves (`<home>/.cache`); null without a HOME. */
  userCacheDir: string | null
  /** `<userCacheDir>/huggingface`, where a user-level model cache lives; null without a HOME. */
  huggingfaceCacheDir: string | null
  /** Whether the two user cache roots existed when these facts were recorded. */
  userCacheDirExists: boolean
  huggingfaceCacheDirExists: boolean
  /** XDG_CACHE_HOME in force for this environment (the scoped root for a check). */
  xdgCacheHome: string | null
  /** The confinement the host applies: workspace-write rooted at the checkout, full enforcement. */
  sandboxPolicy: { mode: string; enforcement: string; workspaceRoot: string | null }
  /** Dependency materialisation policy. dirs is the configured set of directory names. */
  dependencyLinks: { mode: 'link' | 'copy'; dirs: string[];
    /** Actual relative paths found and materialised in this execution; absent before execution. */
    materializedPaths?: string[] }
  /** Scoped cache root the envelope provides inside the checkout; null for a self-run. */
  checkCacheRoot: string | null
  /** Package-manager cache roots the check sets below `checkCacheRoot`. */
  checkCacheRoots: Record<string, string>
}
/** ENV: one check's failure attribution, captured before the output bound can cut it off. */
export interface CheckAttribution {
  /** 1-based position of the failing check in the declared sequence. */
  index: number
  command: string
  /** The last stage banner (`> script`, `$ command`, `# stage: name`) before the first failure. */
  stage: string | null
  /** The last `# Subtest:` heading before the first failure (the suite that failed). */
  subtest: string | null
  /** TAP `not ok` names seen in the stream, bounded; the count is every name seen. */
  failingTests: string[]
  failingTestCount: number
  /** TAP summary lines (`1..N`, `# tests/# pass/# fail/...`), latest value per key. */
  tapSummary: string[]
  /** True when the stored output was cut at the host's output bound. */
  outputTruncated: boolean
}
export interface Mission {
  id: string
  ownerSessionId: string
  workspace: string
  /**
   * Durable human-authorization anchor for `workspace`: the calling session's
   * cwd for a session workspace, or the configured `authorizedWorkspaces` root
   * the workspace resolved inside. Recorded at admission and re-validated at
   * every workspace preparation and verification checkout, so removing a root
   * fences the mission instead of letting it continue against an unauthorized
   * root. Absent only on missions recorded before this feature existed.
   */
  workspaceGrantRoot?: string
  /**
   * Host-derived origin of the workspace authorization: `session` when the
   * workspace is the calling session's own cwd, `grant` when it was accepted
   * because it sits inside a configured root. Recorded at admission and never
   * taken from model input; it decides whether removal of a root fences the
   * mission (a grant) or must not (a session workspace). Absent on missions
   * recorded before this field existed.
   */
  workspaceAuthorizationSource?: 'session' | 'grant'
  title: string
  objective: string
  scope: string[]
  acceptance: string[]
  status: MissionStatus
  budget: Budget
  usedTokens: number
  usedSteps: number
  createdAt: number
  updatedAt: number
  deadline: number
  /** Active execution time; paused, idle and resource-waiting time is excluded. */
  executionTime?: { usedMs: number; since?: number }
  coordinatorId?: string
  reason?: string
  baseline?: WorkspaceBaseline
  /**
   * S5r: the durable stop claim. `stopping` is written before the deferred stop
   * touches the adapter, so a second request cannot re-run a stop that is
   * already in flight. A claim from another runtime instance, or one older than
   * the declared pass bound, is a crashed stop and does not gate a fresh attempt.
   */
  budgetPause?: { id: string; quiesced: boolean; stopping?: { instanceId: string; at: number } }
  /** Bucketed worker usage behind `usedTokens`; absent on missions recorded before bucket accounting. */
  workerUsage?: UsageBuckets
  /** Owner-session usage attributed by time window (planning and coordination). Outside the worker pool budget. */
  ownerUsage?: UsageBuckets
  /** When the owner last set the mission budget: a mission-root budget notice recorded before it is resolved. */
  budgetReviewedAt?: number
  /** Last successful delivery application; projected for the client after the event window scrolls. */
  appliedDelivery?: { resultCommit: string; appliedAt: number }
  /**
   * S2: the last outbox delivery attempt the pump abandoned at its bound (the
   * adapter call did not settle). Durable so a starved notice is visible without
   * the hung call ever returning; cleared by the next successful delivery.
   */
  outboxStarved?: { deliveryId: string; attempts: number; at: number }
}
/** Host-observed operation; lifecycle timestamps are not a completion estimate. */
export interface WorkerActivity {
  id: string
  kind: 'model' | 'tool' | 'verification' | 'retry'
  startedAt: number
  updatedAt: number
  tool?: string
  retryAt?: number
  retryAttempt?: number
  attemptId?: string
}
export interface Member {
  id: string
  missionId: string
  name: string
  role: string
  sessionId: string
  workspace: string
  /**
   * R17-G7: durable lifecycle phase. Absent means `active` (rows written before
   * the phase existed), which keeps old state files readable without a
   * migration. Every writer that used to set a live `status` now sets this.
   */
  phase?: MemberPhase
  /**
   * R17-G7: the derived live status (see {@link MemberStatus}). It is present on
   * every member record — a store read re-derives it and an in-memory record
   * carries the value its builder computed — but it is never written to the
   * store: `SwarmStore.put('members')` drops it, so a caller that assigns it
   * changes nothing durable. The one derivation lives in `src/projection.ts` and
   * is what the scheduler, the owner views and the guard board read.
   */
  status: MemberStatus
  activity?: WorkerActivity
  subscriptions: string[]
  model?: string
  provider?: string
  reasoningEffort?: string
  /** Primary-agent-selected output allowance for each model request. */
  maxOutputTokens?: number
  /** Lifetime authoritative token charge applied to the mission budget, across native sessions. */
  accountedTokens?: number
  /** Lifetime bucketed usage across this worker's native sessions. */
  usage?: UsageBuckets
  /** Current native session's cumulative watermarks, separate from lifetime usage. */
  usageSession?: { generation: number; accountedTokens: number; usage?: UsageBuckets }
  /**
   * R11-01: the last provider outage classified for this member, kept until a
   * start opens the member's session. It is read two ways:
   * - Present, it is an outage not yet proved recovered: the opening start
   *   (`recordStarted`) records `provider/recovered` and deletes it, and a
   *   report of its class within 30 s of it writes no second `provider/outage`
   *   event (`recordProviderOutage`).
   * - Inside its window it is quiescence (`providerQuiescent`): a start failure
   *   is the outage, spending no recovery credit and not counted, starts are
   *   paced to one probe per window, re-routed work prefers other members, and
   *   the live-work panel shows the member as waiting for provider recovery.
   */
  providerOutage?: MemberProviderOutage
  /** S5c: consecutive `workers.start` failures and the last one's error, cleared by the next successful start; a restart continues the count. */
  startFailures?: number
  startError?: string
}
/**
 * R17-G12 (mission acceptance 12): the fixed pool a worker name is drawn from,
 * in assignment order. Human English given names only — no vendor or product
 * name (Claude was removed from the pool at the user's direction) — and more
 * than any mission's worker budget, so a name-less admission never exhausts the
 * pool before the budget does. The name is a display identity: `role` keeps the
 * responsibility text unchanged and every protocol address stays the member id.
 */
export const WORKER_NAME_POOL = [
  'Ada', 'Alan', 'Anita', 'Barbara', 'Beatrice', 'Ben', 'Carol', 'Dennis', 'Dora', 'Ed',
  'Edsger', 'Elena', 'Emmy', 'Erik', 'Frances', 'Grace', 'Hedy', 'Ivan', 'Jean', 'Ken',
  'Linus', 'Margaret', 'Maria', 'Nadia', 'Niels', 'Olga', 'Omar', 'Peter', 'Radia', 'Raj',
  'Rich', 'Rita', 'Rosa', 'Ruth', 'Sophie', 'Tim', 'Vera', 'Vint', 'Wanda', 'Yukihiro',
] as const
/**
 * The next unused name in assignment order, or undefined when every name is
 * taken. `used` is every name the mission's members already carry — including a
 * stopped member — because a name is never reused while the mission is active,
 * and the runtime passes the mission's whole durable roster.
 */
export function nextWorkerName(used: Iterable<string>): string | undefined {
  const taken = new Set(used)
  return WORKER_NAME_POOL.find(name => !taken.has(name))
}
/** A mission criterion's id: c1 is the first acceptance item. The list is frozen once the mission exists, so the id is stable. */
export const criterionId = (index: number): string => `c${index + 1}`
export interface Workstream {
  id: string
  missionId: string
  title: string
  objective: string
  coordinatorId?: string
}
/**
 * One attempt on a task, and what happened to it while it ran. A submission or
 * a verdict keeps it on the row as its record; whatever ends it takes it off
 * the row, and these facts with it, so a row never carries one of another
 * attempt.
 */
export interface Attempt {
  id: string
  epoch: number
  ownerId: string
  leaseUntil: number
  /** Immutable source selected when a verification attempt was assigned. */
  sourceCommit?: string
  /** The budget pause (`Mission.budgetPause.id`) that preserved this attempt; that pause's resume continues it. */
  pausedBy?: string
  /** Its owner ended a turn while this attempt was open (`onIdle`): the idle close-out acts on it, asking `turnEnded`, its one reader. */
  idleSignal?: { at: number }
  /** Idle close-out nudges already delivered; an owner resume restarts them. */
  closeout?: { nudges: number; at: number }
  /** The lease value already warned about, so a lease-expiring event is emitted once per lease. */
  leaseWarned?: number
  /** The sandbox denied its worker a git write. */
  gitWriteDenied?: { command: string; runId?: string; at: number }
}
/**
 * W1: an attempt that ended in a submission or a verdict and was then ended (a
 * rework, an owner resume), as the next attempt on its task is recovered from
 * it: that attempt's epoch, and the commit its submission or verdict captured
 * (absent when the verdict captured none). The runtime names it to
 * `WorkerAdapter.prepareTask` because the workspace engine cannot tell it from
 * its own record: a submission refused after its capture (`[rework_unchanged]`,
 * a missing host check) records a captured commit at an epoch whose attempt
 * runs on.
 */
export interface FinishedAttempt { epoch: number; capture?: string }
export interface Artifact {
  commit: string
  baseCommit: string
  workspace: string
  changedPaths: string[]
  /** The declared outputs and listed deliverables, read back from this commit (never the mutable worktree). */
  files?: Array<{ path: string; blob: string; bytes: number }>
  /** Changed executable files, symlinks or submodules in either tree, including deletions. */
  executablePaths?: string[]
}
/** Owner revisions keep the obligation and history; submitted artifacts stay immutable. */
export interface TaskAmendment {
  scope?: string[]
  outputs?: string[]
  dependencies?: string[]
  checks?: string[]
  assigneeId?: string | null
  maxSteps?: number
  maxFindings?: number
  maxRecoveryAttempts?: number
  checkTimeoutMs?: number
  maxRework?: number
}
/**
 * One independent rejection a task was re-opened from: the rejected artifact
 * commit, the task epoch it was submitted at, the review that rejected it and
 * that review's reason, and the claims the rejection refuted (history, not a
 * block cause, once the task is reworked). On the review row a rework re-opens,
 * the same record archives its own verdict: the commit it rejected, its epoch,
 * itself, its reason, the claims its reviewer published in that round, the
 * review artifact it captured, and what that round consumed (`spent`).
 */
export interface TaskRejection {
  commit: string; epoch: number; reviewTaskId: string; reason: string; evidenceIds: string[]; reviewArtifact?: Artifact
  /**
   * On a review's own entry: what the rejecting round consumed. The re-opened
   * review starts the next round with a fresh review's allowance, so this is
   * history only; no ceiling or recovery limit reads it.
   */
  spent?: { usedSteps: number; recoveryCount: number; ceiling?: TaskCeiling }
}
export interface Task {
  id: string
  missionId: string
  workstreamId: string
  title: string
  objective: string
  kind: TaskKind
  dependencies: string[]
  scope: string[]
  /** This task's own criteria; on a review, review-only ones. What its worker and reviewers check is derived (`checklist`). */
  acceptance: string[]
  /** Ids of the mission criteria this deliverable satisfies (see `criterionId`); absent means none. A repair also answers for the covers of the tasks it replaces. A plan's review may name them for its source; a stored review never carries them. */
  covers?: string[]
  /**
   * The repository-relative files this task must produce, declared by whoever
   * planned it instead of inferred from the objective prose. An empty array is
   * a declaration ("this task writes no file"); absent means the row predates
   * the field or came from a manual assembly that omitted it, and it reads as
   * `[]`. Capture force-adds and preservation carries exactly these files, and
   * submit and verify refuse one that was never written (`[output_missing]`).
   */
  outputs?: string[]
  checks: string[]
  status: TaskStatus
  priority: number
  experiment: boolean
  /**
   * S5: this task's own revision. Every detached record read from the store
   * carries the revision it was read at, and `SwarmStore.put('tasks', …)`
   * accepts the write only when the presented revision equals the durable one
   * (then stamps `current + 1` onto the caller's object). A writer that read the
   * task before another accepted write presents a disagreeing value and is
   * refused with `StaleTaskRevisionError`, which names the current revision and
   * the imperative next step (re-read, retry once). Absent only on rows written
   * before per-task revisions existed; the first accepted write stamps one.
   *
   * This is what makes an update lost-update-free without an in-memory flag: the
   * compare happens against the durable row inside the caller's transaction, so
   * the serialized decision path cannot overwrite a decision it never read.
   */
  revision?: number
  assigneeId?: string
  /** Only preferred tasks that have never started may be borrowed. Absent preserves legacy binding. */
  assignmentMode?: 'preferred' | 'pinned'
  /** Initial plan owner; a preferred task fixes this to its first actual owner for recovery. */
  plannedAssigneeId?: string
  attempt?: Attempt
  epoch: number
  output?: string
  recoveryCount?: number
  /** Primary-agent choice; absent only on legacy/manual tasks. */
  maxRecoveryAttempts?: number
  /** Owner re-opens of this task after an independent rejection, bounded by `maxRework` (default 2). */
  reworkCount?: number
  maxRework?: number
  /** Rejections this task was re-opened from, oldest first; on a review, the verdicts a rework of its source archived. */
  rejections?: TaskRejection[]
  /**
   * W1: the attempt an owner resume last re-opened this review from, which had
   * ended in its deferred or rejecting verdict: its epoch, and the review
   * artifact that verdict captured. A rework records the same in `rejections`.
   */
  resumedFrom?: FinishedAttempt
  /** Per-task model-step ceiling admitted with the task; the runtime blocks the task at this limit. */
  maxSteps?: number
  /** Per-task finding (published evidence) ceiling admitted with the task. */
  maxFindings?: number
  /** Explicit agent choices or admission fallbacks; absent on legacy tasks. */
  ceilingProvenance?: TaskCeilingProvenance
  /** Steps charged to this task's live attempt; durable so a restart cannot reset the ceiling. */
  usedSteps?: number
  /** Durable block reason when the task exhausted one of its own ceilings. */
  ceiling?: TaskCeiling
  preparationFailure?: { reason: string; transient: boolean; attempts: number; retryAt?: number }
  /**
   * A review's deferred verdict on its source's exact artifact. `toolRunIds`
   * are the durable host-verification rows of the pass that decided to defer,
   * in recorded order: the rows its `task/verification-deferred` event names
   * as `checks`, and the only rows the deferral's exit is composed from
   * (`reviewPathBlocker`, src/board.ts). The review's other rows are not that
   * pass: a failed first pass before its retry, an earlier attempt's passes,
   * or a pass a fenced attempt recorded after the deferral.
   */
  verificationRecovery?: { sourceTaskId: string; commit: string; reason: string; at: number; toolRunIds: string[] }
  /** Per-command host verification timeout chosen for this task. */
  checkTimeoutMs?: number
  /** Durable quiescence transition; epoch matching prevents reopening invalidated work. */
  resumeAfterStop?: { epoch: number; memberId?: string; reason: 'handoff' | 'lease-expired' | 'worker-closeout' | 'resource' | 'invalidated'; /** R14-F2(d): when the stop began, so a waited-on stop has a durable bound. */ at?: number; /** Deterministic preservation failures retain the fence until an explicit resume retries them. */ failure?: { message: string; deterministic: boolean } }
  /** Durable workspace checkpoint captured before an abandoned attempt was reassigned. */
  checkpoint?: { commit: string; at: number }
  /**
   * H-3: the last cross-owner recovery that could not capture the previous
   * owner's workspace as an artifact. `preserved` means the replacement attempt
   * inherited that worktree's WIP (in-scope and out-of-scope alike) from the
   * preservation snapshot `commit`; otherwise it started from the last durable
   * checkpoint or the task base and the WIP is still only in the previous
   * owner's worktree. Written together with the `task/recovery-fallback` event
   * and the owner notice, and projected by `swarm_observe`.
   */
  recovery?: { epoch: number; previousOwnerId: string; commit: string; preserved: boolean; reason: string; at: number }
  artifact?: Artifact
  /** Captured reviewer-authored record; never a dependency deliverable or independent verdict on its own contents. */
  reviewArtifact?: Artifact
  /**
   * Authenticated proposer key (`owner` or a member id). Set at admission so
   * the per-member proposal allowance is counted from durable records and can
   * never be raised by the member it bounds.
   */
  proposedBy?: string
  evidenceIds: string[]
  reviewOf?: string
  reviewedCommit?: string
  /** Blocked or cancelled tasks this repair replaces; their acceptance and covers apply to it through the lineage. */
  replaces?: string[]
  /**
   * Set on an accepted replacement once its replaced lineage was retired, in
   * the verdict's transaction (or once by host recovery for a store accepted
   * before that rule). Recovery replays the retirement only without it.
   */
  lineageRetired?: true
  /**
   * X1 (P0): every member that ever owned an attempt on this task. Independence
   * is decided from the union of the current attempt owner and this list, so a
   * handoff, lease expiry, idle close-out, start-failure reroute, cancellation
   * or host restart cannot make an earlier owner eligible to review the work.
   */
  priorOwnerIds?: string[]
  handoff?: string
  createdAt: number
}
export interface Evidence {
  id: string
  missionId: string
  workstreamId: string
  taskId: string
  authorId: string
  claim: string
  outcome: 'supported' | 'disproved' | 'inconclusive'
  status: EvidenceStatus
  toolRunIds: string[]
  artifact?: Artifact
  challenges: Array<{ authorId: string; reason: string; toolRunIds: string[] }>
  supersedes: string[]
  /** Evidence that independently refuted this claim; explicit durable lineage for supersession. */
  refutedBy?: string
  createdAt: number
}
export interface ToolRun {
  id: string
  /** Per-mission monotonic position; absent on runs recorded before cursors existed. */
  seq?: number
  missionId: string
  memberId: string
  taskId: string
  attemptId: string
  tool: string
  arguments: unknown
  result: unknown
  isError: boolean
  createdAt: number
}
/**
 * Sanctioned mission-board post kinds. A post is durable cross-task visibility:
 * it carries provenance (sender, task/attempt, evidence and host run ids) and is
 * filterable, but it is data only — it never grants authority, never changes a
 * task's state and its body is never an instruction to the runtime.
 */
export type PostKind = 'ASK' | 'ANSWER' | 'IDEA' | 'ALERT' | 'ARTIFACT' | 'HANDOFF'
/** Durable, immutable board post. `seq` is host-assigned and monotonic for delta reads. */
export interface Post {
  id: string
  missionId: string
  /** Host-assigned monotonic position; never supplied by the model. */
  seq: number
  kind: PostKind
  /** Authenticated sender key: a member id or `owner`. */
  fromMemberId: string
  /** Absent means mission-wide; otherwise a member id or `owner`. */
  toMemberId?: string
  taskId?: string
  attemptId?: string
  body: string
  /** Host-recorded evidence ids in this mission; cited, never promoted by posting. */
  evidenceIds: string[]
  /** Host-recorded tool run ids in this mission. */
  toolRunIds: string[]
  replyTo?: string
  createdAt: number
  /** Optional lifetime in milliseconds; expiry is computed on read, never enforced by mutation. */
  ttlMs?: number
}
/** Model input for one board post; sender and sequence come from the host. */
/** `swarm_message` input: one delivery, optionally bound to the question it answers. */
export interface MessageInput {
  to: string
  kind: 'question' | 'finding'
  content: string
  topic?: string
  /**
   * L1: the question delivery this message answers. Answering is a durable
   * receipt on that row, not a convention about prose.
   */
  replyTo?: string
  /** L1: close the referenced question without sending a message (`content` is the reason). */
  dismiss?: boolean
}
export interface PostInput {
  kind: PostKind
  body: string
  to?: string
  taskId?: string
  attemptId?: string
  evidenceIds?: string[]
  toolRunIds?: string[]
  replyTo?: string
  ttlMs?: number
}
/** Bounded board read. `to: 'me'` is the inbox view: addressed to the caller or mission-wide. */
export interface BoardQuery {
  kind?: PostKind
  to?: string
  taskId?: string
  after?: number
  limit?: number
  /** Read one full post record instead of a page. */
  postId?: string
}
/**
 * Closed owner-notice classes. A notice is deduplicated on the deliveries
 * ledger by (class, key, sender); escalations are never deduplicated.
 */
export type NoticeClass = 'decision' | 'blocker' | 'failure' | 'budget' | 'stall' | 'progress' | 'completion' | 'escalation'
/**
 * Delivery lifecycle of one owner notice. `sent` is the durable record,
 * `queued` is the outbox entry awaiting the owner session, and `claimed` is the
 * adapter delivery that put it in front of the owner. The dedup key is the
 * identity of the fact the notice tells (an escalation, never deduplicated,
 * carries its own id), so the ledger proves which facts were announced.
 */
export interface NoticeEnvelope {
  dedupKey: string
  class: NoticeClass
  sentAt: number
  queuedAt: number
  claimedAt?: number
  /** Receipt or failed delivery whose current state decides whether this notice still applies. */
  questionId?: string
  deliveryFailureId?: string
  /** Original notice identities carried by a wake summary, independent of its transport identity. */
  aggregatedIdentities?: Array<{ class: NoticeClass; dedupKey: string; from: string; contentDigest: string }>
  /** Structured constituents let a queued wake summary recheck each original obligation. */
  aggregatedFacts?: Array<{
    class: NoticeClass; dedupKey: string; from: string; factStart: number; factCount: number
    subjects: string[]; trigger: string; reason: string; createdAt: number
    questionId?: string; deliveryFailureId?: string; escalation?: Escalation
    /** Reminders spent on this constituent: each summarized fact has its own allowance. */
    followupCount?: number
  }>
  /** First transport handoff freezes the rendered summary across uncertain retries. */
  handoffAt?: number
}
/**
 * Typed durable owner escalation raised by a mission member. A board post is
 * visibility only; an escalation is a first-class record that reaches the owner
 * through the notice path. It carries the authenticated sender plus the task
 * and attempt it was raised against, and it grants no authority: recording one
 * changes no task, member or budget state.
 */
export interface Escalation {
  id: string
  missionId: string
  /** Authenticated sender member id; never model-supplied. */
  fromMemberId: string
  taskId?: string
  attemptId?: string
  body: string
  /** Its own identity on the deliveries ledger, `escalation:<id>`: an escalation is never deduplicated. */
  dedupKey: string
  createdAt: number
}
export interface Delivery {
  id: string
  missionId: string
  from: string
  to: string
  kind: 'assignment' | 'question' | 'finding' | 'challenge' | 'handoff' | 'control' | 'escalation'
  content: string
  topic?: string
  createdAt: number
  deliveredAt?: number
  /**
   * When the owner session admitted this owner-addressed delivery, a notice or
   * a question alike: actual host message consumption, independent of transport
   * acknowledgement timing. Written once, only by `Notices.recordConsumption`.
   */
  consumedAt?: number
  deliveryFailure?: { reason: string; at: number }
  taskId?: string
  attemptId?: string
  /**
   * R14-F2(a): the tasks this notice is about, as `taskId@epoch`, written in the
   * same transaction as the state transition that produced it. A notice can then
   * be deduplicated against other notices about the same task instead of being
   * consumed by an unrelated one.
   */
  subjects?: string[]
  /** Present on owner notices: dedup key and sent/queued/claimed lifecycle. */
  notice?: NoticeEnvelope
  /**
   * L0 receipt: this delivery asks a question, so it stays open until an answer
   * is bound to its id. Written in the same transaction as the delivery itself;
   * deliveries written by older builds carry no flag and are never retro-open.
   */
  replyExpected?: boolean
  /** The question delivery this one answers, when it answers one. */
  inReplyTo?: string
  /** Receipt state of a `replyExpected` delivery. */
  state?: 'open' | 'answered' | 'dismissed'
  /** The member/owner key that answered or dismissed it, written once. */
  answeredBy?: string
  answeredAt?: number
  /**
   * L2: owner-reply nudges already spent on this question. Durable, so the bound
   * survives a restart and a repeated turn cannot nudge forever.
   */
  replyNudges?: number
  /** Present when this delivery carries a typed owner escalation. */
  escalation?: Escalation
}
/**
 * The host's shared browser-transport channel and this plugin's endpoint prefix
 * inside it.
 *
 * The connection plugin owns the sole `/api` route of the Web carrier, and the
 * plugin's endpoints are exact routes under it (`registerWebApi`, which says why
 * neither the channel's interceptor nor a plugin-owned channel serves them). The
 * client posts to `<channel>/<endpoint>`, so both halves agree on
 * `SWARM_RPC_CHANNEL` plus `SWARM_RPC_PREFIX` in front of the endpoint.
 */
export const SWARM_RPC_CHANNEL = '/api'
export const SWARM_RPC_PREFIX = 'agent-swarm/'

/**
 * Every endpoint the panel may call, and therefore every exact route the host is
 * asked for: the shared channel admits one interceptor, which the API gateway
 * holds, so the plugin registers one route per endpoint instead. The list, the
 * handler's dispatch and the naming manifest are pinned together by tests.
 */
export const SWARM_WEB_ENDPOINTS: readonly string[] = [
  'state', 'watch', 'models', 'control', 'cancel', 'delivery', 'apply-delivery', 'worker-history',
  'create-draft', 'update-draft', 'discard-draft', 'launch-draft', 'add-member', 'propose',
]

/**
 * The owner-only tool surface: management and runtime modification that a
 * worker session must never reach. Declared ONCE, because two enforcement points
 * read it and they had drifted: the role projection hides exactly this set from
 * a worker's schemas (`src/tools.ts`), and the runtime's synchronous final guard
 * refuses exactly this set on every dispatch surface (`src/runtime.ts`). The
 * guard's hand-written copy had lost `swarm_registry`, so the projection hid a
 * tool the guard would have allowed.
 */
export const OWNER_ONLY_TOOLS: readonly string[] = [
  'swarm_stage', 'swarm_launch', 'swarm_budget', 'swarm_create', 'swarm_add_member',
  'swarm_control', 'swarm_cancel', 'swarm_registry', 'swarm_restore',
]

/**
 * Host tools that take a worker session out of its confinement: its member
 * worktree and its current attempt. Declared once and read by the same two
 * enforcement points as `OWNER_ONLY_TOOLS`: the worker projection hides each
 * one the host registers (`src/tools.ts`), and the runtime guard refuses every
 * one of them (`src/runtime.ts`). A name a host does not register costs nothing
 * to deny. Harness registers them where a profile mounts them:
 *  - `working_directory` moves the session's durable working directory, which
 *    bash, file tools and the model's directory context follow, out of the
 *    worktree (the base bundle mounts it for every session);
 *  - `create_worktree` (the experimental worktree tool, a GUI opt-in) creates a
 *    branch and a second checkout and moves the session's working directory
 *    into it;
 *  - `schedule_create`, `schedule_update`, `schedule_list` and
 *    `schedule_delete` (the Web Standard, Creator and PTC presets) manage
 *    reminders, and a due reminder wakes the session that set it: a resident
 *    worker after its attempt, a non-resident one resumed outside this adapter.
 */
export const UNCONFINED_HOST_TOOLS: readonly string[] = [
  'working_directory', 'create_worktree',
  'schedule_create', 'schedule_update', 'schedule_list', 'schedule_delete',
]

/**
 * Every durable event that fences a running attempt, and therefore closes the
 * attempt interval both readers reconstruct from the log:
 *  - the replay decoder (`src/trace.ts`) opens one attempt per `task/claimed`
 *    and refuses the whole log with `ReplayTruncationError` when one never
 *    closes;
 *  - the scheduling board model (`src/scheduling.ts`) ends the attempt interval
 *    with the same set.
 *
 * The two readers used to carry hand-mirrored copies. They drifted: neither had
 * `task/restart-repended` (emitted when a host restart re-pends a running task,
 * `src/runtime.ts`) nor `task/ceiling-exhausted` (emitted when a task blocks at
 * its own ceiling, `src/runtime.ts`), so a log containing either made the replay
 * refuse its own mission as truncated. One list, both readers.
 */
export const ATTEMPT_FENCING_EVENTS: readonly EventKind[] = [
  // `attempt/fenced` is the uniform closer every fence writes through
  // `Attempts.fenceForStop`. Mission pause/stop and challenge closed attempts
  // with only their own domain event, so a log this runtime wrote was refused as
  // truncated by its own replay; `task/start-failed` drops the attempt too and
  // had the same gap.
  'attempt/fenced', 'task/start-failed',
  'task/submitted', 'task/blocked', 'task/verification-deferred', 'task/cancelled', 'task/cancelled-at-completion',
  'task/lease-expired', 'task/restart-repended', 'task/ceiling-exhausted',
  'task/handoff-started', 'task/invalidated', 'task/review-retired',
  'task/closeout-abandoned', 'task/closeout-failed', 'task/accepted', 'task/rejected',
]

export interface SwarmEvent {
  seq: number
  missionId: string
  type: string
  actor: string
  data: unknown
  createdAt: number
}
/**
 * S6: critical-path accounting for one mission, projected next to its total
 * spend. `length` is the number of tasks in the longest chain of dependent
 * steps, so a worker that does not shorten the longest branch earns nothing;
 * `remaining` is how much of that chain is still open. Pure accounting: the
 * numbers never change budget enforcement.
 */
export interface CriticalPath {
  /** Tasks in the longest chain of dependent steps (1 when every task is independent). */
  length: number
  /** Tasks on that chain that are neither accepted nor cancelled. */
  remaining: number
  /** Steps charged to the chain's tasks: the part of the spend the chain owns. */
  usedSteps: number
  /** The chain itself, dependency-first. */
  taskIds: string[]
}
export interface Snapshot {
  mission: Mission
  members: Member[]
  workstreams: Workstream[]
  tasks: Task[]
  evidence: Evidence[]
  events: SwarmEvent[]
  pendingDeliveries: number
  /** Runtime-selected deliverable; identical rule to applyDelivery, so the client never re-derives it. */
  deliveryTarget?: { taskId: string; commit: string }
  /** Whether control('complete') would be accepted now, with the exact rejection reason. */
  completion?: { eligible: boolean; reason?: string }
  /** S6: longest chain of dependent steps, reported beside the mission's spend. */
  criticalPath?: CriticalPath
  /** Last successful apply, projected past the bounded event window. */
  appliedDelivery?: { resultCommit: string; appliedAt?: number }
}
export interface CreateMissionInput {
  title: string
  objective: string
  workspace: string
  scope: string[]
  acceptance: string[]
  budget: Budget
}
/** Editable browser plan. Keys are local references resolved atomically before execution. */
export interface PlanMember {
  key: string
  name: string
  role: string
  provider?: string
  model?: string
  reasoningEffort?: string
  maxOutputTokens?: number
}
export interface PlanWorkstream { key: string; title: string; objective: string }
export interface PlanTask extends Pick<Task, 'covers'> {
  key: string
  workstreamKey: string
  title: string
  objective: string
  kind: TaskKind
  scope: string[]
  acceptance: string[]
  /** Declared deliverable files; see `Task.outputs`. */
  outputs?: string[]
  checks?: string[]
  maxRecoveryAttempts?: number
  /** Per-task step ceiling; admission derives a bounded default when the plan omits it. */
  maxSteps?: number
  /** Per-task finding ceiling; admission derives a bounded default when the plan omits it. */
  maxFindings?: number
  ceilingProvenance?: TaskCeilingProvenance
  checkTimeoutMs?: number
  priority?: number
  experiment?: boolean
  assigneeKey?: string
  assignmentMode?: 'preferred' | 'pinned'
  dependencies?: string[]
  reviewOf?: string
  /**
   * On a deliverable no verification task names in `reviewOf`: fields of the
   * one independent review the host adds for it. Consumed when that review is
   * added, so a saved or launched plan carries the review row instead.
   */
  review?: PlanReviewOverride
}
/** The planner's choices for a host-added review; every other field derives from its source. */
export interface PlanReviewOverride {
  assigneeKey?: string
  objective?: string
  /** Review-only criteria, checked after everything the source must satisfy. */
  acceptance?: string[]
  maxSteps?: number
  maxRecoveryAttempts?: number
}
export interface PlanInput extends CreateMissionInput {
  members: PlanMember[]
  workstreams: PlanWorkstream[]
  tasks: PlanTask[]
}
export interface DraftPlan extends Pick<Mission, 'workspaceGrantRoot' | 'workspaceAuthorizationSource'> {
  id: string
  ownerSessionId: string
  revision: number
  status: 'draft' | 'launching' | 'launched' | 'failed' | 'discarded'
  /** Validated plan exactly as supplied; the authorization anchor lives beside it, never inside. */
  input: PlanInput
  /** Bounded advisory preflight notes; they never change launch eligibility. */
  advisories?: string[]
  createdAt: number
  updatedAt: number
  missionId?: string
  error?: string
}
/** Durable authorization for one natural-language automatic swarm request. */
export interface RequestStartInput {
  commandId: string
  goal: string
  workspace: string
  /** Optional legacy hint. The primary agent supplies the actual plan budget. */
  budget?: Budget
}
export interface AutoStart extends RequestStartInput, Pick<Mission, 'workspaceGrantRoot' | 'workspaceAuthorizationSource'> {
  id: string
  ownerSessionId: string
  status: 'planning' | 'launching' | 'running' | 'completed' | 'failed' | 'stopped'
  /** Durable generation fences late planners after a retry or stop. Legacy rows are epoch 1. */
  planningEpoch?: number
  planningDeadlineAt?: number
  /** A durable deadline-review notice; transport acknowledgement keeps the request active. */
  planningWarning?: { deadline: number; threshold: number; deliveredAt?: number }
  planningFenced?: boolean
  /** Durable inbox work, replayed by the native planner when the owner is available. */
  planningDispatchPending?: boolean
  recoveryNoticePending?: boolean
  draftId?: string
  missionId?: string
  error?: string
  baseline?: WorkspaceBaseline
  /** Owner usage during planning, folded into the launched mission's ownerUsage. */
  ownerUsage?: UsageBuckets
  createdAt: number
  updatedAt: number
}
/** Bounded, focused reads for the model; the complete board stays in the UI projection. */
export interface ObserveQuery {
  /** Owner compact board baseline from nextCursor; missing/stale cursors return a full compact reset. */
  cursor?: string
  /** Owner-only exact read of a durable notification or question and its facts. */
  deliveryId?: string
  /** Return only events after this sequence number. */
  after?: number
  /** Return only this participant's visible tool runs after this per-mission position. */
  afterRun?: number
  /** Focus one task: its full record, evidence and tool-run references. */
  taskId?: string
  /** Read one stored tool run in full, paged by `offset` characters. */
  runId?: string
  offset?: number
  /** Read one evidence record including challenges. */
  evidenceId?: string
  /** `full` includes complete task records, evidence claims and the owner arena instruments. */
  detail?: 'summary' | 'full'
}
export interface ProposeTaskInput extends Pick<Task, 'covers'> {
  workstreamId: string
  title: string
  objective: string
  kind: TaskKind
  dependencies?: string[]
  scope: string[]
  /** This task's own criteria. A new deliverable needs these or `covers`; a repair also answers for the criteria of the tasks it replaces. */
  acceptance?: string[]
  /** Declared deliverable files; see `Task.outputs`. Required, except that a repair omitting them inherits every replaced task's declaration (in order, de-duplicated); explicit outputs replace that list. */
  outputs?: string[]
  checks?: string[]
  maxRecoveryAttempts?: number
  /** Per-task step ceiling; admission derives a bounded default when the proposal omits it. */
  maxSteps?: number
  /** Per-task finding ceiling; admission derives a bounded default when the proposal omits it. */
  maxFindings?: number
  ceilingProvenance?: TaskCeilingProvenance
  checkTimeoutMs?: number
  priority?: number
  experiment?: boolean
  assigneeId?: string
  assignmentMode?: 'preferred' | 'pinned'
  reviewOf?: string
  replaces?: string[]
}
export interface PublishInput {
  taskId: string
  attemptId: string
  claim: string
  outcome: 'supported' | 'disproved' | 'inconclusive'
  toolRunIds: string[]
  supersedes?: string[]
}
/** Callers are resolved by the host from the executing session, never model arguments. */
export interface Actor { sessionId: string; signal?: AbortSignal }
export interface WorkerSpec {
  mission: Mission
  member: Member
  /** Exact owner session used only to seed initial composition; resume must be owner-independent. */
  ownerSessionId: string
}
/**
 * H-3: one cross-owner recovery whose `captureArtifact` refused the previous
 * owner's worktree. `preserved` says whether the replacement (`memberId`)
 * inherited that worktree's WIP through a preservation snapshot (`commit` is
 * then the snapshot) or started from the last durable checkpoint or the task
 * base with the WIP left behind.
 */
export interface RecoveryFallback { missionId: string; taskId: string; epoch: number; memberId: string; previousOwnerId: string; commit: string; preserved: boolean; reason: string }
/**
 * H-3 follow-up: a disposable verification checkout the host could not remove
 * after `taskId`'s declared checks ran under `memberId`. `reason` is the
 * removal failure; the tree may still sit under the mission's `verification/`
 * directory or as a stale worktree registration in the source repository. The
 * check results were already returned; this never changes the verdict.
 */
export interface VerificationCleanupFailure { missionId: string; taskId: string; memberId: string; checkout: string; reason: string }
export interface WorkerCallbacks {
  /** Optional for adapters without live execution observation. */
  activity?(memberId: string, activity?: WorkerActivity): void
  idle(memberId: string): void
  /** Called before each model step. False parks gracefully; errors deny execution. Fresh input excludes generated runtime context. */
  beforeStep(memberId: string, hasFreshInput?: boolean): Promise<void | false>
  usage(memberId: string, tokens: number): Promise<void>
  /** Optional idempotent accounting path; cumulative persisted session total, never a delta. */
  usageSnapshot?(memberId: string, totalTokens: number, usage?: UsageBuckets, source?: UsageSnapshotSource): Promise<void>
  /** Optional owner-session usage report, attributed by the runtime to that owner's live missions or planning requests. */
  ownerUsage?(sessionId: string, usage: UsageBuckets): void
  /** Reject a revoked assignment by its durable delivery id; other peer messages retain their context. */
  admitDelivery?(memberId: string, deliveryId: string): boolean
  /** Record a host-observed execution; resolves to the durable run id, or undefined when no owned attempt exists. */
  toolRun(memberId: string, run: Omit<ToolRun, 'id' | 'seq' | 'missionId' | 'memberId' | 'taskId' | 'attemptId' | 'createdAt'>): Promise<string | undefined>
  /** Synchronous final guard on all tools, including alternate dispatch surfaces. */
  guard(memberId: string, toolName: string): string | undefined
  failure(memberId: string, error: string): void
  /**
   * H-3: a cross-owner recovery could not capture the previous owner's
   * workspace as an artifact. The adapter's `Workspaces` reports it; the
   * runtime records the durable event, the owner notice and the task summary.
   */
  recoveryFallback?(info: RecoveryFallback): void
  /**
   * H-3 follow-up: a verification checkout could not be removed after its
   * checks ran. The adapter's `Workspaces` reports it; the runtime records the
   * durable event and the owner notice. The verdict is never affected.
   */
  verificationCleanupFailure?(info: VerificationCleanupFailure): void
  /**
   * R11-01: a classified provider outage (quota, rate limit, provider
   * unavailable, account credential). The adapter classifies, and this is the error's one report
   * (never also a `failure`); the runtime emits the durable event, keeps the
   * attempt alive and never spends recovery credit on the pause.
   */
  providerOutage(memberId: string, outage: ProviderOutage): void
  /**
   * A model step the member's own route refused (`MemberRouteRefusal`). The
   * adapter classifies, and this is the error's one report (never also a
   * `failure`); the runtime retires the member and releases its work.
   */
  routeRefused(memberId: string, refusal: MemberRouteRefusal): void
}
/** One declared check `/bin/sh` could not parse: its position in the probed list and the parser's own diagnostic. */
export interface CheckSyntaxIssue { index: number; message: string }
/** Worker handles and all effectful execution remain owned by the adapter. */
export interface WorkerAdapter {
  bind(callbacks: WorkerCallbacks): void
  /** Freeze once before planning; optional only for adapters without Git execution. */
  prepareBaseline?(mission: Pick<Mission, 'id' | 'workspace'>, signal?: AbortSignal): Promise<WorkspaceBaseline>
  inspectDelivery(mission: Mission, resultCommit: string, signal?: AbortSignal): Promise<DeliveryInspection>
  applyDelivery(mission: Mission, resultCommit: string, signal?: AbortSignal): Promise<DeliveryApplication>
  prepareWorkspace(mission: Mission, memberId: string): Promise<string>
  /** Resolves true when it adopted the member's session already running: that start opened nothing. */
  start(spec: WorkerSpec, signal?: AbortSignal): Promise<boolean>
  deliver(member: Member, delivery: Delivery): Promise<void>
  stop(memberId: string): Promise<void>
  /** Only returns operations still owned by a live, uncancelled adapter execution. */
  currentActivity(memberId: string): WorkerActivity | undefined
  /** A unit of work closed for this member; the adapter may compact its history when idle and over its pressure threshold. */
  compactAtBoundary(memberId: string): void
  /**
   * The durable worker identity changed (a staged-plan repair rotated the
   * member's sessionId), so the adapter's persisted composition for that member
   * must not be reused. Called after the previous handle has stopped; the next
   * start composes a fresh session for the new identity instead of refusing a
   * composition that belongs to the replaced one.
   */
  invalidateComposition(missionId: string, memberId: string): Promise<void>
  /**
   * Parse every declared check without executing it, so a plan whose check is a
   * shell syntax error is refused before any worker, worktree or model step
   * exists. The result is located, not input-aligned: one entry per unparsable
   * command, in plan order, whose `index` is that command's position in
   * `checks`; a command that parses has no entry, so callers pair by `index`.
   */
  checkSyntaxPreflight(checks: readonly string[], cwd: string, signal?: AbortSignal): Promise<CheckSyntaxIssue[]>
  /**
   * Resolve each member's model route as its worker will run it, the owner
   * session's current selection under the member's own route fields, and ask
   * the host whether that route takes its model and reasoning effort, the
   * question its model step asks, without a model request. One answer per
   * member, in input order; no worker, worktree or session is touched.
   * Admission decides on the answers.
   */
  memberRoutes(ownerSessionId: string, members: readonly MemberRouteInput[], signal?: AbortSignal): Promise<MemberRoute[]>
  /**
   * Whether the member's handle could take an assignment now. A question:
   * asking it changes nothing, so a decision may ask it any number of times. An
   * idle handle holding input no driver will claim is startable: an
   * assignment's waking delivery carries that input with it.
   */
  isIdle(memberId: string): boolean
  /**
   * R15-A5: wake the input an idle handle holds that no driver will claim (a
   * stranded inbox), so it is consumed instead of stranding the member. The
   * adapter's own step, run by the runtime at one point: the start of each
   * dispatch sweep of an active mission, for each member of the board whose
   * handle a decision may ask about. A throw ends that member's chain in the
   * sweep: its guard terminal, and no step for that member; the sweep goes on.
   */
  drainStrandedInbox(memberId: string): void
  /**
   * Capture the member worktree plus `deliverables` and the task's declared
   * `outputs`; with `requireOutputs` (submit and verify) a declared output that
   * is not a regular file is refused with `[output_missing]`.
   */
  captureArtifact(member: Member, task: Task, deliverables?: string[], options?: { requireOutputs?: boolean }): Promise<Artifact>
  /** Preserve any owned WIP after stop without treating it as an accepted artifact. */
  checkpointTask(member: Member, task: Task, options?: { ifOwned?: boolean }): Promise<void>
  /** Read authoritative immutable Git facts, including fields absent from older stored records. */
  inspectArtifact(member: Member, artifact: Artifact, signal?: AbortSignal): Promise<Artifact>
  /** Verify in an isolated checkout of the exact artifact; records are host-produced. */
  verifyArtifact(member: Member, task: Task, artifact: Artifact, signal?: AbortSignal): Promise<CheckResult[]>
  /** R11-19: the host's measured declared-check envelope, when the adapter runs checks. */
  checkEnvelope?(): CheckEnvelope
  /**
   * Materialize accepted dependencies or a prior task checkpoint. The runtime
   * stops and fences an attempt a handle may still be running before it
   * prepares a later epoch. An attempt that ended in a submission or a verdict
   * owes no stop: `finished` names the newest such attempt on the task
   * (`finishedAttempt`). A task record of that epoch is that attempt's, and the
   * work is recovered from the capture it recorded, never from its worktree,
   * which its handle may still be writing, and never by capturing that epoch
   * again. A record of a later epoch is an attempt that did not end in a
   * capture, and recovers as before.
   */
  prepareTask(member: Member, task: Task, dependencies: Task[], reviewSource?: Task, finished?: FinishedAttempt): Promise<void>
  dispose(): Promise<void>
}
export interface RuntimeConfig {
  statePath: string
  leaseMs: number
  /**
   * Tick timer period, and the unit of every tick-derived window (the review
   * grace, the back-off bound, the start retry).
   */
  tickMs: number
  /**
   * Run no tick timer, so a test drives `SwarmRuntime.tick()` by hand; `tickMs`
   * stays the tick unit. The plugin never sets it from the profile.
   */
  manualTick?: boolean
  /**
   * The runtime clock. Every wall-clock read that decides runtime behaviour
   * (leases, bounds, back-offs, silence, stall and wedge ages, wake budgets,
   * follow-up timing, event `createdAt`) reads it; defaults to `Date.now`.
   * Only a function is taken, and the plugin never sets it from the profile.
   */
  now?: () => number
  /** Prelaunch watchdog fallback; the owner can extend it with a reason. */
  planningTimeoutMs?: number
  /** Bound for native worker startup; independent of model/task execution budgets. */
  workerStartTimeoutMs?: number
  maxMessageChars: number
  maxEvents: number
  maxTasksPerMember: number
  /** Host verification timeout applied when a task does not choose one; index.ts Config supplies it. */
  checkTimeoutMs?: number
  /** Idle close-out nudges before an open attempt is checkpointed and abandoned; defaults to 2. */
  maxIdleCloseouts?: number
  /** Owner-reply nudges before the guard terminal; defaults to 2. */
  maxOwnerReplyNudges?: number
  /** Approaching-limit fractions per budget dimension; defaults to [0.7, 0.9]. */
  budgetWarnAt?: number[]
  /**
   * S1: bound on one scheduling pass before the runtime declares it wedged and
   * escalates it. Defaults to 30 × `tickMs`. While the mission has a live lease
   * or an in-flight quiescence the escalation waits a further bounded window: a
   * lease renewed by recorded operations is progress, not a stall.
   */
  stallPassTimeoutMs?: number
  /**
   * R16-D: the further window a pass past `stallPassTimeoutMs` stays live
   * (unnamed) while the mission has live work. Defaults to the pass bound
   * itself; `0` names it at the first bound.
   */
  stallPassLiveGraceMs?: number
  /** R16-D: the bound on a live attempt that records nothing durable before it is escalated by name; `0` disables it. */
  attemptSilenceBoundMs?: number
  /** F1: the bound on one in-flight operation that records nothing before it stops counting as liveness; `0` disables it. */
  operationBoundMs?: number
  /**
   * The human-authorized roots, loaded once from plugin configuration at
   * start (`loadWorkspaceGrants`; no configured root loads an empty snapshot,
   * which authorizes only the calling session's own directory): the one
   * representation every admission and re-validation reads, judged at `now`,
   * the runtime clock's instant. The runtime re-validates a mission before
   * every adapter call that can reach its workspace (worker start, baseline,
   * worktree, task preparation, verification checkout, launch preflight,
   * delivery) and fences one no configured root authorizes any more. Never
   * re-loaded at runtime and never a model-callable surface.
   */
  grants: WorkspaceGrantSnapshot
  /**
   * The dependency directory names the host's workspace engine treats as
   * toolchain state (the plugin `verificationDependencyDirs`). Admission checks
   * declared outputs against the same set capture excludes; absent means the
   * engine default.
   */
  verificationDependencyDirs?: readonly string[]
}

/**
 * One human-configured root and the set loaded at start. They live here, not in
 * `src/authorization.ts`, so the browser typecheck (which includes this file)
 * never pulls in Node built-ins. `note` is audit metadata; past `expiresAt`
 * (epoch ms) a root is no longer consulted. `unresolved` names configured roots
 * that did not resolve or had already expired at start.
 */
export interface WorkspaceGrant { path: string; note?: string; expiresAt?: number }
export interface WorkspaceGrantSnapshot { grants: readonly WorkspaceGrant[]; unresolved: readonly string[] }
