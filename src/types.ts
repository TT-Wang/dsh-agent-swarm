/** Durable swarm records and the execution adapter shared by runtime and Harness. */
export type MissionStatus = 'staged' | 'active' | 'paused' | 'blocked' | 'completed' | 'stopped'
export type TaskKind = 'research' | 'implementation' | 'verification' | 'integration'
export type TaskStatus = 'pending' | 'running' | 'submitted' | 'accepted' | 'blocked' | 'cancelled'
export type MemberStatus = 'idle' | 'working' | 'waiting' | 'stopped'
export type EvidenceStatus = 'unverified' | 'verified' | 'challenged' | 'refuted'
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
export interface Mission {
  id: string
  ownerSessionId: string
  workspace: string
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
  /** Highest approaching-limit threshold already warned per budget dimension. */
  budgetWarned?: Record<string, number>
  /** Last successful delivery application; projected for the client after the event window scrolls. */
  appliedDelivery?: { resultCommit: string; appliedAt: number }
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
  /** Per-command host verification timeout chosen for this task. */
  checkTimeoutMs?: number
  /** Same-owner resume preserves attempt provenance after budget quiescence. */
  budgetResume?: { pauseId: string; attemptId: string; epoch: number }
  /** Durable quiescence transition; epoch matching prevents reopening invalidated work. */
  resumeAfterStop?: { epoch: number; reason: 'handoff' | 'lease-expired' }
  artifact?: Artifact
  evidenceIds: string[]
  reviewOf?: string
  reviewedCommit?: string
  /** Blocked tasks whose acceptance obligations this replacement covers. */
  replaces?: string[]
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
export interface Delivery {
  id: string
  missionId: string
  from: string
  to: string
  kind: 'assignment' | 'question' | 'finding' | 'challenge' | 'handoff' | 'control'
  content: string
  topic?: string
  createdAt: number
  deliveredAt?: number
  taskId?: string
  attemptId?: string
}
export interface SwarmEvent {
  seq: number
  missionId: string
  type: string
  actor: string
  data: unknown
  createdAt: number
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
  input: PlanInput
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
  /** `full` includes complete task records and evidence claims for the whole board. */
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
}
/** Worker handles and all effectful execution remain owned by the adapter. */
export interface WorkerAdapter {
  bind(callbacks: WorkerCallbacks): void
  /** Freeze once before planning; optional only for adapters without Git execution. */
  prepareBaseline?(mission: Pick<Mission, 'id' | 'workspace'>, signal?: AbortSignal): Promise<WorkspaceBaseline>
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
  /** Materialize accepted dependencies or a prior task checkpoint. Stop/fence the old owner before preparing a later epoch. */
  prepareTask(member: Member, task: Task, dependencies: Task[], reviewSource?: Task): Promise<void>
  dispose(): Promise<void>
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
  /** Approaching-limit fractions per budget dimension; defaults to [0.7, 0.9]. */
  budgetWarnAt?: number[]
}
