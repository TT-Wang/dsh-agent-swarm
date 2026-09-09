import type { Evidence, Member, Snapshot, Task, WorkerActivity } from '../types.ts'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'paused'
export interface CurrentProgress { label: string; note?: string; member?: Member; task?: Task; activity?: WorkerActivity; observedAt?: number; stale: boolean }
export const activityLabels = { model: 'Agent is thinking', tool: 'Running a tool', verification: 'Running verification', retry: 'Waiting to retry' } as const
const statusLabels: Record<string, string> = { staged: 'Preparing collaboration', paused: 'Mission paused', blocked: 'Mission needs attention', stopped: 'Mission stopped', completed: 'Collaboration completed' }
const activityPriority = { verification: 4, tool: 3, retry: 2, model: 1 } as const

/** Running task per owner id, built in one pass so per-member activity lookup is O(1) (F-34). */
export function runningByOwner(tasks: readonly Task[]): Map<string, Task> {
  const running = new Map<string, Task>()
  for (const task of tasks) {
    if (task.status !== 'running') continue
    const owner = task.attempt?.ownerId ?? task.assigneeId
    if (owner !== undefined && !running.has(owner)) running.set(owner, task)
  }
  return running
}

function isRunningMap(value: readonly Task[] | ReadonlyMap<string, Task>): value is ReadonlyMap<string, Task> {
  return !Array.isArray(value)
}

export function memberActivity(member: Member, tasks: readonly Task[] | ReadonlyMap<string, Task>): WorkerActivity | undefined {
  const activity = member.activity
  if (!activity || typeof activity.id !== 'string' || !Object.hasOwn(activityLabels, activity.kind) || !Number.isFinite(activity.startedAt) || !Number.isFinite(activity.updatedAt)) return undefined
  const task = isRunningMap(tasks) ? tasks.get(member.id)
    : tasks.find(task => task.status === 'running' && (task.attempt?.ownerId ?? task.assigneeId) === member.id)
  if (activity.attemptId && activity.attemptId !== task?.attempt?.id) return undefined
  return activity
}

/** A transport refresh is not work. Only native activity and persisted task state drive this projection. */
export function currentProgress(snapshot: Snapshot, connection: ConnectionState = 'connected'): CurrentProgress {
  const { mission } = snapshot
  const stale = connection !== 'connected'
  if (statusLabels[mission.status]) return { label: statusLabels[mission.status]!, note: mission.reason, stale }
  const running = runningByOwner(snapshot.tasks)
  const observed = snapshot.members.flatMap(member => {
    const activity = memberActivity(member, running)
    if (!activity) return []
    // A lifecycle notification for a revoked attempt cannot describe the current task.
    return [{ member, activity, task: running.get(member.id) }]
  }).sort((a, b) => activityPriority[b.activity.kind] - activityPriority[a.activity.kind]
    || b.activity.startedAt - a.activity.startedAt || a.member.id.localeCompare(b.member.id) || a.activity.id.localeCompare(b.activity.id))
  const latest = observed[0]
  if (latest) return { label: activityLabels[latest.activity.kind], ...latest, observedAt: latest.activity.updatedAt, stale }
  const firstRunning = running.values().next().value as Task | undefined
  if (firstRunning) return { label: 'Task in progress', task: firstRunning, note: 'Waiting for the next observed activity.', stale }
  if (snapshot.tasks.some(task => task.status === 'submitted')) return { label: 'Waiting for acceptance', note: 'Submitted work is waiting for independent review.', stale }
  if (snapshot.tasks.length > 0 && snapshot.tasks.every(task => ['accepted', 'cancelled'].includes(task.status) || (task.experiment && task.status === 'blocked'))) return { label: 'Preparing the final result', stale }
  return { label: 'Waiting for worker activity', note: mission.reason ?? 'No current worker activity has been observed.', stale }
}

/** Elapsed wall time describes an observed operation; it is never a completion estimate. */
export function activityDuration(startedAt: number, now: number): { minutes: number; seconds: number } {
  const elapsed = Number.isFinite(startedAt) && Number.isFinite(now) ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
  return { minutes: Math.floor(elapsed / 60), seconds: elapsed % 60 }
}

export interface ProgressEvent { seq: number; createdAt: number; label: string; detail?: string }
const meaningfulEvents: Record<string, string> = {
  'workspace/snapshot': 'Project snapshot saved', 'plan/launched': 'Collaboration started',
  'task/claimed': 'Task started', 'attempt/started': 'Task started', 'task/submitted': 'Work submitted for review',
  'task/accepted': 'Work accepted', 'task/rejected': 'Review requested changes', 'task/blocked': 'Task needs attention',
  'task/invalidated': 'Dependent work needs another review', 'task/handoff-started': 'Task handoff started',
  'task/handoff-ready': 'Task handoff completed', 'task/lease-expired': 'Task execution expired',
  // Round-2 recovery and owner-control events (F-14): these were emitted but invisible on the compact panel.
  'task/cancelled': 'Task cancelled', 'task/cancelled-at-completion': 'Task cancelled at completion',
  'task/checkpointed': 'Task workspace checkpointed', 'task/checkpoint-failed': 'Task workspace checkpoint failed',
  'task/closeout-nudged': 'Worker asked to close out', 'task/closeout-abandoned': 'Abandoned task workspace recovered',
  'task/closeout-failed': 'Task close-out failed', 'task/git-write-denied': 'Worker git write denied',
  'mission/stalled': 'Mission stalled',
  'evidence/published': 'A finding was recorded', 'evidence/challenged': 'A finding was challenged',
  'evidence/verified': 'A finding was verified', 'evidence/refuted': 'A finding was refuted',
  'task/review-retired': 'A redundant review was retired', 'member/effort-downgraded': 'Worker reasoning effort downgraded',
  'mission/recovered': 'Mission recovered', 'mission/budget-warning': 'Budget warning',
  'task/closeout-ready': 'Task ready to close out', 'task/closeout-exhausted': 'Task close-out limit reached',
  'task/lease-expiring': 'Task lease expiring', 'task/quiescence-recovered': 'Task recovered after quiescence',
  'task/ceiling-exhausted': 'Task ceiling reached',
  'task/preparation-failed': 'Task preparation failed',
  'task/budget-resumed': 'Task resumed after budget pause', 'task/budget-resume-skipped': 'Task resume skipped',
  'member/added': 'Worker added', 'member/subscribed': 'Worker subscriptions updated',
  'mission/pause': 'Mission paused', 'mission/resume': 'Mission resumed', 'mission/stop': 'Mission stopped',
  'mission/complete': 'Collaboration completed', 'automatic/completed': 'Collaboration completed',
  'mission/budget-exhausted': 'Resource limit reached', 'member/failure': 'Worker reported a failure',
  'member/failed': 'Worker could not start', 'automatic/failed': 'Collaboration could not start',
  'delivery/applied': 'Result applied to project', 'delivery/conflicts': 'Result needs conflict resolution',
  // R11-08: the review-path, check-change and workspace-authorization families
  // were emitted but invisible on the compact panel.
  'task/review-missing': 'Submitted work has no review', 'task/review-admitted': 'Independent review admitted',
  'task/review-blocked': 'Submitted work cannot be reviewed', 'task/check-changed': 'A declared check changed',
  // Restart/re-route recovery: a member or task that could not resume is not silent.
  'member/resume-failed': 'Worker could not resume after restart', 'task/start-failed': 'Task failed to start',
  'task/reassigned': 'Task re-routed to another member', 'mission/coordinator': 'Mission coordinator set',
  // The promoted authorized-workspace feature's durable audit events.
  'workspace/grant-loaded': 'Authorized workspace root loaded', 'mission/workspace-bound': 'Mission bound to an authorized workspace',
  'mission/workspace-revoked': 'Mission workspace authorization revoked',
  // T3 integration: the arena-protocol and host-cap emitters (R11-01/07/14/15/17).
  'escalation/raised': 'A worker escalated to the owner', 'task/proposal-refused': 'Work proposal refused',
  'provider/outage': 'Provider route paused', 'provider/recovered': 'Provider route recovered',
  'task/restart-repended': 'Task re-pended after host restart', 'isolation/temp-rendezvous': 'Members shared a temp path',
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function brief(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.slice(0, 200) : undefined }
function present(value: string | undefined): value is string { return value !== undefined }
/** Events whose reason is the owner-facing detail; the task title is only a fallback. */
const reasonFirst = new Set(['task/blocked', 'task/cancelled', 'task/cancelled-at-completion', 'task/checkpoint-failed', 'task/closeout-failed', 'mission/stalled',
  'task/review-blocked', 'mission/workspace-revoked'])
/** A bounded preview of a changed check list; the Activity view carries the full summary. */
function checkPreview(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const checks = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  if (!checks.length) return undefined
  const shown = checks.slice(0, 2).join(' && ')
  return checks.length > 2 ? `${shown} …` : shown
}
function recoveryCredit(data: Record<string, unknown>): string | undefined {
  return typeof data.recoveryCount === 'number' && typeof data.maxRecoveryAttempts === 'number'
    ? `recovery ${data.recoveryCount}/${data.maxRecoveryAttempts}` : undefined
}
/**
 * The owner-facing detail for one compact event. Existing branches are
 * unchanged; the R11-08 families name their payload instead of falling back to
 * the task title (the review block reason, the changed check, the route, the
 * authorization path).
 */
function eventDetail(type: string, data: Record<string, unknown>, task: Task | undefined, evidence: Evidence | undefined, reason: string | undefined): string | undefined {
  if (type === 'task/git-write-denied') return [brief(data.command), brief(data.runId)].filter(present).join(' · ') || task?.title
  if (type === 'task/ceiling-exhausted') {
    return [brief(data.dimension), typeof data.used === 'number' && typeof data.limit === 'number' ? `${data.used}/${data.limit}` : undefined, brief(data.code)]
      .filter(present).join(' · ') || task?.title
  }
  if (type === 'task/preparation-failed' || type === 'task/start-failed') return [reason, recoveryCredit(data)].filter(present).join(' · ') || task?.title
  if (type === 'task/check-changed') return [reason, checkPreview(data.checks)].filter(present).join(' · ') || task?.title
  if (type === 'task/reassigned') {
    const route = brief(data.from) !== undefined || brief(data.to) !== undefined ? `${brief(data.from) ?? '?'} → ${brief(data.to) ?? '?'}` : undefined
    return [route, reason].filter(present).join(' · ') || task?.title
  }
  if (type === 'member/resume-failed') return brief(data.error) ?? task?.title
  if (type === 'mission/coordinator') return brief(data.coordinatorId) ?? task?.title
  if (type === 'workspace/grant-loaded') return [brief(data.path), data.loaded === false ? 'unresolved' : undefined].filter(present).join(' · ')
  if (type === 'mission/workspace-bound') return brief(data.workspace) ?? brief(data.grantRoot) ?? task?.title
  // T3 integration: the new arena/host-cap families name their own payload.
  if (type === 'escalation/raised') return [brief(data.memberId), brief(data.escalationId)].filter(present).join(' · ') || task?.title
  if (type === 'task/proposal-refused') return [reason, typeof data.limit === 'number' ? `limit ${data.limit}` : undefined].filter(present).join(' · ') || task?.title
  if (type === 'provider/outage') return [brief(data.class), typeof data.status === 'number' ? `HTTP ${data.status}` : undefined].filter(present).join(' · ') || task?.title
  if (type === 'task/restart-repended') return [reason, recoveryCredit(data)].filter(present).join(' · ') || task?.title
  if (type === 'isolation/temp-rendezvous') return brief(data.path) ?? task?.title
  if (reasonFirst.has(type)) return reason ?? task?.title ?? evidence?.claim
  return task?.title ?? reason ?? evidence?.claim ?? brief(data.title) ?? brief(data.claim)
}

/** Deliberately omit tool counters, heartbeat/accounting and transport events. */
export function recentProgress(snapshot: Snapshot, limit = 3): ProgressEvent[] {
  // One task/evidence map per call; a linear scan per event made this Theta(events x tasks) (F-34).
  const tasks = new Map(snapshot.tasks.map(task => [task.id, task]))
  const evidenceById = new Map(snapshot.evidence.map(item => [item.id, item]))
  return [...snapshot.events].sort((a, b) => b.seq - a.seq).flatMap(event => {
    if (!Number.isFinite(event.seq) || !Number.isFinite(event.createdAt)) return []
    const type = event.type.replaceAll('.', '/')
    const label = meaningfulEvents[type]
    if (!label) return []
    const data = record(event.data)
    const taskId = data.sourceTaskId ?? data.taskId
    const task = typeof taskId === 'string' ? tasks.get(taskId) : undefined
    const evidence = typeof data.evidenceId === 'string' ? evidenceById.get(data.evidenceId) : undefined
    const reason = brief(data.reason)
    // The blocked/cancelled reason is the actionable owner detail (W9); a git
    // denial names the exact command and host run id that was refused; a ceiling
    // block names the dimension and the exhausted limit; a preparation failure
    // names the cause and how much recovery credit it spent. The R11-08
    // families name their own payload instead of falling back to the title.
    const detail = eventDetail(type, data, task, evidence, reason)
    return [{ seq: event.seq, createdAt: event.createdAt, label, ...(detail ? { detail: detail.slice(0, 200) } : {}) }]
  }).slice(0, Math.max(0, limit))
}

export function acceptanceSummary(snapshot: Snapshot): { accepted: number; total: number; reviews: number; outputs: Task[] } {
  const accepted = snapshot.tasks.filter(task => task.status === 'accepted')
  const integrations = accepted.filter(task => task.kind === 'integration')
  const outputs = (integrations.length ? integrations : accepted.filter(task => task.kind !== 'verification')).filter(task => task.output)
  return { accepted: accepted.length, total: snapshot.tasks.length, reviews: accepted.filter(task => task.kind === 'verification').length, outputs: outputs.slice(-3) }
}

/**
 * The latest owner-facing reason per task from durable recovery/control events.
 * The W9 preparation failure, checkpoints, close-outs and git denials carry the
 * only actionable explanation; the board surfaces it on the card instead of
 * leaving it in the raw event stream (F-14/F-35).
 */
export function taskReasons(snapshot: Snapshot): Map<string, string> {
  const reasons = new Map<string, string>()
  for (const event of [...snapshot.events].sort((a, b) => a.seq - b.seq)) {
    const type = event.type.replaceAll('.', '/')
    if (!reasonFirst.has(type) && type !== 'task/git-write-denied') continue
    const data = record(event.data)
    if (typeof data.taskId !== 'string') continue
    const detail = type === 'task/git-write-denied'
      ? [brief(data.command), brief(data.runId)].filter((part): part is string => part !== undefined).join(' · ')
      : brief(data.reason)
    if (detail) reasons.set(data.taskId, detail)
  }
  return reasons
}
