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
}
export interface Member {
  id: string
  missionId: string
  name: string
  role: string
  sessionId: string
  workspace: string
  status: MemberStatus
  subscriptions: string[]
  model?: string
  provider?: string
  reasoningEffort?: string
  /** Primary-agent-selected output allowance for each model request. */
  maxOutputTokens?: number
  /** Last authoritative cumulative token total applied to the mission budget. */
  accountedTokens?: number
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
  attempt?: Attempt
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
  createdAt: number
}
export interface ToolRun {
  id: string
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
  createdAt: number
  updatedAt: number
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
  idle(memberId: string): void
  /** Called before each model step. False parks gracefully; errors deny execution. Fresh input excludes generated runtime context. */
  beforeStep(memberId: string, hasFreshInput?: boolean): Promise<void | false>
  usage(memberId: string, tokens: number): Promise<void>
  /** Optional idempotent accounting path; cumulative persisted session total, never a delta. */
  usageSnapshot?(memberId: string, totalTokens: number): Promise<void>
  /** Reject a revoked assignment by its durable delivery id; other peer messages retain their context. */
  admitDelivery?(memberId: string, deliveryId: string): boolean
  toolRun(memberId: string, run: Omit<ToolRun, 'id' | 'missionId' | 'memberId' | 'taskId' | 'attemptId' | 'createdAt'>): Promise<void>
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
}
