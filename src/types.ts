/** Durable swarm records and the execution adapter shared by runtime and Harness. */
export type MissionStatus = 'staged' | 'active' | 'paused' | 'blocked' | 'completed' | 'stopped'
export type TaskKind = 'research' | 'implementation' | 'verification' | 'integration'
export type TaskStatus = 'pending' | 'running' | 'submitted' | 'accepted' | 'blocked' | 'cancelled'
export type MemberStatus = 'idle' | 'working' | 'waiting' | 'stopped'
export type EvidenceStatus = 'unverified' | 'verified' | 'challenged' | 'refuted'
/** Per-task effort dimensions that block the task itself instead of draining the mission budget. */
export type TaskCeilingDimension = 'maxSteps' | 'maxFindings'
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
 * condition (402/429/5xx, quota, provider-unavailable) into one of these so the
 * runtime can pause, route or re-assign without parsing provider text.
 */
export type ProviderOutageClass = 'quota' | 'rate-limit' | 'unavailable'
/** R11-01: one classified provider outage; `status` is the HTTP status when known. */
export interface ProviderOutage {
  class: ProviderOutageClass
  status?: number
  message: string
}
/** The last classified outage observed for a member, used to avoid spending recovery credit. */
export interface MemberProviderOutage extends ProviderOutage { at: number }
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
  coordinatorId?: string
  reason?: string
  baseline?: WorkspaceBaseline
  /** Durable gate while budget exhaustion stops the previous worker activity. */
  budgetPause?: { id: string; quiesced: boolean }
  /** Bucketed worker usage behind `usedTokens`; absent on missions recorded before bucket accounting. */
  workerUsage?: UsageBuckets
  /** Owner-session usage attributed by time window (planning and coordination). Outside the worker pool budget. */
  ownerUsage?: UsageBuckets
  /** Fingerprint of the last stalled state the owner was notified about; suppresses repeats. */
  stallNotice?: string
  /**
   * S1: fingerprint of the last state the scheduling-pass watchdog escalated.
   * Kept separate from `stallNotice` so the pass-level witness (a pass that
   * neither advanced nor terminated, or one that never returned) does not
   * silence the board-level stall notice, while still deduplicating repeats for
   * one unchanged board. Cleared when a pass advances durable state.
   */
  schedulingStallNotice?: string
  /**
   * No-silent-state witness (docs/no-silent-state-spec.md §2): the fingerprint
   * `F(S)` of the board state at the moment the last owner-decision notice was
   * emitted, and its witness class. A notice is fresh only for the fingerprint
   * it was emitted for, so an unchanged board never re-notifies and a board that
   * changes and changes back does. Wall-clock `at` is never part of `F(S)`.
   */
  witness?: { fingerprint: string; kind: 'W2' | 'W3'; at: number }
  /** R10-14: fingerprint of the coverage-complete state the owner was told about. */
  coverageNotice?: string
  /** Highest approaching-limit threshold already warned per budget dimension. */
  budgetWarned?: Record<string, number>
  /** Last successful delivery application; projected for the client after the event window scrolls. */
  appliedDelivery?: { resultCommit: string; appliedAt: number }
  /**
   * S2: the last outbox delivery attempt the pump abandoned at its bound (the
   * adapter call did not settle). Durable so a starved notice is visible without
   * the hung call ever returning; cleared by the next successful delivery.
   */
  outboxStarved?: { deliveryId: string; attempts: number; at: number }
  /**
   * S7: the isolation invariant refusal already recorded for this mission
   * (`<memberId>:<violation>`). Dedup only: an unchanged violation is not
   * re-announced, and a changed one is.
   */
  isolationRefusal?: string
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
  status: MemberStatus
  activity?: WorkerActivity
  subscriptions: string[]
  model?: string
  provider?: string
  reasoningEffort?: string
  /** Primary-agent-selected output allowance for each model request. */
  maxOutputTokens?: number
  /** Last authoritative cumulative token total applied to the mission budget. */
  accountedTokens?: number
  /** Cumulative bucketed usage from this worker's persisted session log. */
  usage?: UsageBuckets
  /**
   * R11-01: the last provider outage classified for this member. Present means
   * the member's route is quiescent (capacity/quota/availability), so a start
   * failure or stop must not spend the task's recovery credit; it is cleared by
   * a successful start or a successful operation.
   */
  providerOutage?: MemberProviderOutage
}
export interface Workstream {
  id: string
  missionId: string
  title: string
  objective: string
  coordinatorId?: string
}
export interface Attempt {
  id: string
  epoch: number
  ownerId: string
  leaseUntil: number
}
export interface Artifact {
  commit: string
  baseCommit: string
  workspace: string
  changedPaths: string[]
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
  acceptance: string[]
  checks: string[]
  status: TaskStatus
  priority: number
  experiment: boolean
  assigneeId?: string
  /** Plan-intended owner; restored when a lease expiry re-pends the task and the member is still live. */
  plannedAssigneeId?: string
  attempt?: Attempt
  /** Lease value already warned about, so a lease-expiring event is emitted once per lease. */
  leaseWarned?: number
  epoch: number
  output?: string
  recoveryCount?: number
  /** Primary-agent choice; absent only on legacy/manual tasks. */
  maxRecoveryAttempts?: number
  /** Per-task model-step ceiling admitted with the task; the runtime blocks the task at this limit. */
  maxSteps?: number
  /** Per-task finding (published evidence) ceiling admitted with the task. */
  maxFindings?: number
  /** Steps charged to this task's live attempt; durable so a restart cannot reset the ceiling. */
  usedSteps?: number
  /** Durable block reason when the task exhausted one of its own ceilings. */
  ceiling?: TaskCeiling
  /** Per-command host verification timeout chosen for this task. */
  checkTimeoutMs?: number
  /** Same-owner resume preserves attempt provenance after budget quiescence. */
  budgetResume?: { pauseId: string; attemptId: string; epoch: number }
  /** Durable quiescence transition; epoch matching prevents reopening invalidated work. */
  resumeAfterStop?: { epoch: number; reason: 'handoff' | 'lease-expired' | 'worker-closeout' }
  /** Idle close-out nudges already delivered for this attempt; cleared when a new attempt starts. */
  closeout?: { nudges: number; at: number }
  /**
   * S5: durable form of the adapter's "this member ended a turn while still
   * owning this attempt" signal. The scheduling path re-reads it from the store
   * instead of trusting the in-memory `idleSignals` map, which is now only a
   * cache: a lost cache delays the bounded close-out until lease expiry, it
   * cannot make the close-out wrong. Attempt-scoped, so a stale signal is inert.
   */
  idleSignal?: { attemptId: string; at: number }
  /** Durable workspace checkpoint captured before an abandoned attempt was reassigned. */
  checkpoint?: { commit: string; at: number }
  /** Sandbox denial of a worker-side git write on this attempt; cleared when a new attempt starts. */
  gitWriteDenied?: { command: string; runId?: string; at: number }
  artifact?: Artifact
  /**
   * Authenticated proposer key (`owner` or a member id). Set at admission so
   * the per-member proposal allowance is counted from durable records and can
   * never be raised by the member it bounds.
   */
  proposedBy?: string
  evidenceIds: string[]
  reviewOf?: string
  reviewedCommit?: string
  /** Blocked tasks whose acceptance obligations this replacement covers. */
  replaces?: string[]
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
 * Closed owner-notice classes. The runtime dedups its own budget/ceiling
 * refusals per (class, mission-state fingerprint, sender) so an unchanged board
 * cannot spam the owner; decision notices carry the liveness engine's own
 * witness dedup and are always recorded, so a state that changes and returns
 * can re-notify. Escalations are never deduplicated.
 */
export type NoticeClass = 'decision' | 'blocker' | 'failure' | 'budget' | 'stall' | 'progress' | 'completion' | 'escalation'
/**
 * Delivery lifecycle of one owner notice. `sent` is the durable record,
 * `queued` is the outbox entry awaiting the owner session, and `claimed` is the
 * adapter delivery that put it in front of the owner. The dedup key is the
 * mission-state fingerprint the notice was emitted for, so the ledger proves
 * which states were announced and which are still silent.
 */
export interface NoticeEnvelope {
  dedupKey: string
  class: NoticeClass
  sentAt: number
  queuedAt: number
  claimedAt?: number
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
  /** Mission-state fingerprint F(S) at raise time. */
  dedupKey: string
  createdAt: number
  /** Delivery record that carries it to the owner through the notice path. */
  deliveryId: string
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
  taskId?: string
  attemptId?: string
  /** Present on owner notices: dedup key and sent/queued/claimed lifecycle. */
  notice?: NoticeEnvelope
  /** Present when this delivery carries a typed owner escalation. */
  escalation?: Escalation
}
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
  /**
   * Human-authorization anchor for `workspace`, computed by the admission site
   * from the session cwd or a configured `authorizedWorkspaces` root. Model
   * tools never supply it directly: `boundPlanWorkspace` overwrites the
   * workspace and passes the host-derived root, and the runtime re-derives it
   * through `RuntimeConfig.authorizeWorkspace` when that check is configured.
   */
  workspaceGrantRoot?: string
  /** Host-derived authorization origin, computed with `workspaceGrantRoot` at admission. */
  workspaceAuthorizationSource?: 'session' | 'grant'
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
export interface PlanTask {
  key: string
  workstreamKey: string
  title: string
  objective: string
  kind: TaskKind
  scope: string[]
  acceptance: string[]
  checks?: string[]
  maxRecoveryAttempts?: number
  /** Per-task step ceiling; admission derives a bounded default when the plan omits it. */
  maxSteps?: number
  /** Per-task finding ceiling; admission derives a bounded default when the plan omits it. */
  maxFindings?: number
  checkTimeoutMs?: number
  priority?: number
  experiment?: boolean
  assigneeKey?: string
  dependencies?: string[]
  reviewOf?: string
}
export interface PlanInput extends CreateMissionInput {
  members: PlanMember[]
  workstreams: PlanWorkstream[]
  tasks: PlanTask[]
}
export interface DraftPlan {
  id: string
  ownerSessionId: string
  revision: number
  status: 'draft' | 'launching' | 'launched' | 'failed' | 'discarded'
  /** Validated plan exactly as supplied; the authorization anchor lives beside it, never inside. */
  input: PlanInput
  /** Human-authorization anchor captured at staging; carried into the launched mission. */
  workspaceGrantRoot?: string
  /** Host-derived authorization origin captured with the anchor; never inside `input`. */
  workspaceAuthorizationSource?: 'session' | 'grant'
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
  /** Human-authorization anchor for `workspace`; defaults to the workspace itself. */
  workspaceGrantRoot?: string
  /** Host-derived authorization origin; defaults from the anchor for automatic starts. */
  workspaceAuthorizationSource?: 'session' | 'grant'
  /** Optional legacy hint. The primary agent supplies the actual plan budget. */
  budget?: Budget
}
export interface AutoStart extends RequestStartInput {
  id: string
  ownerSessionId: string
  status: 'planning' | 'launching' | 'running' | 'completed' | 'failed' | 'stopped'
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
export interface ProposeTaskInput {
  workstreamId: string
  title: string
  objective: string
  kind: TaskKind
  dependencies?: string[]
  scope: string[]
  acceptance: string[]
  checks?: string[]
  maxRecoveryAttempts?: number
  /** Per-task step ceiling; admission derives a bounded default when the proposal omits it. */
  maxSteps?: number
  /** Per-task finding ceiling; admission derives a bounded default when the proposal omits it. */
  maxFindings?: number
  checkTimeoutMs?: number
  priority?: number
  experiment?: boolean
  assigneeId?: string
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
export interface WorkerCallbacks {
  /** Optional for adapters without live execution observation. */
  activity?(memberId: string, activity?: WorkerActivity): void
  idle(memberId: string): void
  /** Called before each model step. False parks gracefully; errors deny execution. Fresh input excludes generated runtime context. */
  beforeStep(memberId: string, hasFreshInput?: boolean): Promise<void | false>
  usage(memberId: string, tokens: number): Promise<void>
  /** Optional idempotent accounting path; cumulative persisted session total, never a delta. */
  usageSnapshot?(memberId: string, totalTokens: number, usage?: UsageBuckets): Promise<void>
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
   * R11-01: a classified provider outage (quota, rate limit, provider
   * unavailable). The adapter classifies; the runtime emits the durable event,
   * keeps the attempt alive and never spends recovery credit on the pause.
   */
  providerOutage?(memberId: string, outage: ProviderOutage): void
}
/** Worker handles and all effectful execution remain owned by the adapter. */
export interface WorkerAdapter {
  bind(callbacks: WorkerCallbacks): void
  /** Freeze once before planning; optional only for adapters without Git execution. */
  prepareBaseline?(mission: Pick<Mission, 'id' | 'workspace' | 'workspaceGrantRoot' | 'workspaceAuthorizationSource'>, signal?: AbortSignal): Promise<WorkspaceBaseline>
  inspectDelivery?(mission: Mission, resultCommit: string, signal?: AbortSignal): Promise<DeliveryInspection>
  applyDelivery?(mission: Mission, resultCommit: string, signal?: AbortSignal): Promise<DeliveryApplication>
  prepareWorkspace(mission: Mission, memberId: string): Promise<string>
  start(spec: WorkerSpec): Promise<void>
  deliver(member: Member, delivery: Delivery): Promise<void>
  stop(memberId: string): Promise<void>
  /** Only returns operations still owned by a live, uncancelled adapter execution. */
  currentActivity?(memberId: string): WorkerActivity | undefined
  /** A unit of work closed for this member; the adapter may compact its history when idle and over its pressure threshold. */
  compactAtBoundary?(memberId: string): void
  isIdle(memberId: string): boolean
  captureArtifact(member: Member, task: Task): Promise<Artifact>
  /** Verify in an isolated checkout of the exact artifact; records are host-produced. */
  verifyArtifact(member: Member, task: Task, artifact: Artifact, signal?: AbortSignal): Promise<Array<{ command: string; exitCode: number; output: string }>>
  /** R11-19: the host's measured declared-check envelope, when the adapter runs checks. */
  checkEnvelope?(): CheckEnvelope
  /** Materialize accepted dependencies or a prior task checkpoint. Stop/fence the old owner before preparing a later epoch. */
  prepareTask(member: Member, task: Task, dependencies: Task[], reviewSource?: Task): Promise<void>
  dispose(): Promise<void>
}
/**
 * S1: one durable scheduling-pass record per mission (`pass_<missionId>`, the
 * row is overwritten by each pass). The scheduling guard is this row, re-read
 * from the store; the in-memory `scheduled` Set it replaces could swallow the
 * tick timer's only liveness action and leave a mission invisible for 120
 * minutes. A row whose status is `running` older than the configured bound is
 * *not* a guard: the watchdog releases it, commits the stall event and lets
 * later ticks proceed.
 */
export interface SchedulingPass {
  /** Stable row key (`pass_<missionId>`): the guard, re-read from the store. */
  id: string
  /** Identity of this pass execution; a released body is fenced by it, never by the stable key. */
  runId: string
  /** Runtime process that opened the pass. A row from another instance never gates. */
  instanceId: string
  missionId: string
  status: 'running' | 'finished'
  startedAt: number
  finishedAt?: number
  /** Store revisions around the pass body (the pass's own bookkeeping excluded). */
  revisionBefore: number
  revisionAfter?: number
  /** Mission-scoped durable-state digest before and after the pass body. */
  fingerprintBefore: string
  fingerprintAfter?: string
  /** Consecutive passes that changed no durable mission state and terminated nothing. */
  noProgressPasses: number
  /** Set when the pass neither advanced nor terminated within the declared bound. */
  stalled?: { reason: 'pass-timeout' | 'no-progress'; at: number; boundMs: number; unschedulable: string[] }
}
export interface RuntimeConfig {
  statePath: string
  leaseMs: number
  tickMs: number
  maxMessageChars: number
  maxEvents: number
  maxTasksPerMember: number
  /** Host verification timeout applied when a task does not choose one; index.ts Config supplies it. */
  checkTimeoutMs?: number
  /** Idle close-out nudges before an open attempt is checkpointed and abandoned; defaults to 2. */
  maxIdleCloseouts?: number
  /** Approaching-limit fractions per budget dimension; defaults to [0.7, 0.9]. */
  budgetWarnAt?: number[]
  /**
   * S1: consecutive scheduling passes that advance no durable mission state and
   * terminate nothing before the mission escalates. Defaults to 3, i.e. a
   * window of 3 × `tickMs`; the count and the window are configuration, never a
   * constant a stalled board can be trapped behind.
   */
  stallPasses?: number
  /**
   * S1: bound on one scheduling pass before the runtime declares it wedged,
   * escalates and releases the guard. Defaults to 30 × `tickMs`. A pass is only
   * declared wedged when the mission has no live lease or in-flight quiescence:
   * a lease renewed by recorded operations is progress, not a stall.
   */
  stallPassTimeoutMs?: number
  /**
   * Human-authorized workspace predicate, loaded once from plugin configuration
   * at start. When present the runtime re-derives every mission's grant root
   * from it and fences a mission whose root was revoked; when absent (unit
   * runtimes and adapters without Git) the recorded admission result stands.
   * It is a value on the runtime's own config, never a model-callable surface.
   */
  authorizeWorkspace?: (workspace: string, sessionCwd: string | undefined) => Promise<WorkspaceAuthorization>
  /**
   * The roots `authorizeWorkspace` closes over, carried so revocation fencing
   * can name the recorded root without re-reading configuration. Never
   * re-loaded at runtime.
   */
  grants?: WorkspaceGrantSnapshot
}

/**
 * Structural mirror of the authorization types in `src/authorization.ts`. They
 * live here so the browser typecheck (which includes this file) never pulls in
 * Node built-ins; the runtime values are assignable to these shapes.
 */
export interface WorkspaceGrant { path: string; note?: string; expiresAt?: number }
export interface WorkspaceGrantSnapshot { grants: readonly WorkspaceGrant[]; loadedAt: number; unresolved: readonly string[] }
export interface WorkspaceAuthorization {
  ok: boolean
  workspace?: string
  source?: 'session' | 'grant'
  grantRoot?: string
  grant?: WorkspaceGrant
  diagnostic?: string
}
