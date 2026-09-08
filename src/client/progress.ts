import type { Member, Snapshot, Task, WorkerActivity } from '../types.ts'

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'paused'
export interface CurrentProgress { label: string; note?: string; member?: Member; task?: Task; activity?: WorkerActivity; observedAt?: number; stale: boolean }
export const activityLabels = { model: 'Agent is thinking', tool: 'Running a tool', verification: 'Running verification', retry: 'Waiting to retry' } as const
const statusLabels: Record<string, string> = { staged: 'Preparing collaboration', paused: 'Mission paused', blocked: 'Mission needs attention', stopped: 'Mission stopped', completed: 'Collaboration completed' }
const activityPriority = { verification: 4, tool: 3, retry: 2, model: 1 } as const

export function memberActivity(member: Member, tasks: Task[]): WorkerActivity | undefined {
  const activity = member.activity
  if (!activity || typeof activity.id !== 'string' || !Object.hasOwn(activityLabels, activity.kind) || !Number.isFinite(activity.startedAt) || !Number.isFinite(activity.updatedAt)) return undefined
  const task = tasks.find(task => task.status === 'running' && (task.attempt?.ownerId ?? task.assigneeId) === member.id)
  if (activity.attemptId && activity.attemptId !== task?.attempt?.id) return undefined
  return activity
}

/** A transport refresh is not work. Only native activity and persisted task state drive this projection. */
export function currentProgress(snapshot: Snapshot, connection: ConnectionState = 'connected'): CurrentProgress {
  const { mission } = snapshot
  const stale = connection !== 'connected'
  if (statusLabels[mission.status]) return { label: statusLabels[mission.status]!, note: mission.reason, stale }
  const observed = snapshot.members.flatMap(member => {
    const activity = memberActivity(member, snapshot.tasks)
    if (!activity) return []
    const task = snapshot.tasks.find(task => task.status === 'running' && (task.attempt?.ownerId ?? task.assigneeId) === member.id)
    // A lifecycle notification for a revoked attempt cannot describe the current task.
    return [{ member, activity, task }]
  }).sort((a, b) => activityPriority[b.activity.kind] - activityPriority[a.activity.kind]
    || b.activity.startedAt - a.activity.startedAt || a.member.id.localeCompare(b.member.id) || a.activity.id.localeCompare(b.activity.id))
  const latest = observed[0]
  if (latest) return { label: activityLabels[latest.activity.kind], ...latest, observedAt: latest.activity.updatedAt, stale }
  const running = snapshot.tasks.find(task => task.status === 'running')
  if (running) return { label: 'Task in progress', task: running, note: 'Waiting for the next observed activity.', stale }
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
  'evidence/published': 'A finding was recorded', 'evidence/challenged': 'A finding was challenged',
  'mission/pause': 'Mission paused', 'mission/resume': 'Mission resumed', 'mission/stop': 'Mission stopped',
  'mission/complete': 'Collaboration completed', 'automatic/completed': 'Collaboration completed',
  'mission/budget-exhausted': 'Resource limit reached', 'member/failure': 'Worker reported a failure',
  'member/failed': 'Worker could not start', 'automatic/failed': 'Collaboration could not start',
  'delivery/applied': 'Result applied to project', 'delivery/conflicts': 'Result needs conflict resolution',
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function brief(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.slice(0, 200) : undefined }

/** Deliberately omit tool counters, heartbeat/accounting and transport events. */
export function recentProgress(snapshot: Snapshot, limit = 3): ProgressEvent[] {
  return [...snapshot.events].sort((a, b) => b.seq - a.seq).flatMap(event => {
    if (!Number.isFinite(event.seq) || !Number.isFinite(event.createdAt)) return []
    const label = meaningfulEvents[event.type.replaceAll('.', '/')]
    if (!label) return []
    const data = record(event.data)
    const taskId = data.sourceTaskId ?? data.taskId
    const task = snapshot.tasks.find(item => item.id === taskId)
    const evidence = snapshot.evidence.find(item => item.id === data.evidenceId)
    const detail = task?.title ?? brief(data.reason) ?? evidence?.claim ?? brief(data.title) ?? brief(data.claim)
    return [{ seq: event.seq, createdAt: event.createdAt, label, ...(detail ? { detail: detail.slice(0, 200) } : {}) }]
  }).slice(0, Math.max(0, limit))
}

export function acceptanceSummary(snapshot: Snapshot): { accepted: number; total: number; reviews: number; outputs: Task[] } {
  const accepted = snapshot.tasks.filter(task => task.status === 'accepted')
  const integrations = accepted.filter(task => task.kind === 'integration')
  const outputs = (integrations.length ? integrations : accepted.filter(task => task.kind !== 'verification')).filter(task => task.output)
  return { accepted: accepted.length, total: snapshot.tasks.length, reviews: accepted.filter(task => task.kind === 'verification').length, outputs: outputs.slice(-3) }
}
