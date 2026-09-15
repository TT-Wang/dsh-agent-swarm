import type { Member, Snapshot, SwarmEvent, Task, WorkerActivity } from '../types.ts'
import { recentProgress, type ConnectionState } from './progress.ts'

export type LiveWorkState = 'observed' | 'quiet' | 'waiting' | 'idle' | 'stale' | 'paused' | 'stopped' | 'complete'
export interface LiveWorkRow {
  member: Member
  task?: Task
  activity?: WorkerActivity
  state: LiveWorkState
  label: string
  /** Native operation observation, not a completed-work timestamp. */
  observedAt?: number
  ageMs?: number
  operationDurationMs?: number
  /** Animation means a recently observed native operation, never estimated progress. */
  animate: boolean
}
export interface LiveWorkEvent {
  /** Durable identity remains the same after reconnect and reload. */
  id: string
  seq: number
  createdAt: number
  kind: 'milestone' | 'activity' | 'tool'
  label: string
  detail?: string
  memberId?: string
  taskId?: string
}
export interface LiveWorkProjection {
  rows: LiveWorkRow[]
  /** One presentation reference shared by the mission focus and member rows. */
  referenceTime: number
  connection: ConnectionState
  live: boolean
  /** Last successful snapshot read; this can advance without work advancing. */
  observedAt?: number
  workingCount: number
  /** Observed concurrency in the retained snapshot, for explicitly historical copy. */
  lastObservedWorkingCount: number
  counts: { accepted: number; submitted: number; pending: number; running: number; blocked: number; cancelled: number; total: number }
  /** Last semantic milestone or host-recorded tool result; excludes liveness touches. */
  lastProgressAt?: number
  /** Most recent valid native observation; liveness, not a new unit of progress. */
  lastActivityAt?: number
  recentEvents: LiveWorkEvent[]
}
export interface LiveWorkOptions {
  connection: ConnectionState
  now: number
  /** Pass monitor.updatedAt. Without it, offline intervals end at each activity's last observation. */
  observedAt?: number
  /** Presentation confidence window only; does not declare a stall or alter runtime recovery. */
  freshnessWindowMs?: number
  eventLimit?: number
}

const labels: Record<WorkerActivity['kind'], string> = {
  model: 'Agent is thinking', tool: 'Running a tool', verification: 'Verification in progress', retry: 'Waiting to retry',
}
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.slice(0, 400) : undefined }
function activityOf(value: unknown): WorkerActivity | undefined {
  const activity = record(value)
  if (typeof activity.id !== 'string' || !activity.id || typeof activity.kind !== 'string' || !Object.hasOwn(labels, activity.kind)
    || !timestamp(activity.startedAt) || !timestamp(activity.updatedAt)
    || activity.updatedAt < activity.startedAt
    || (activity.attemptId !== undefined && (typeof activity.attemptId !== 'string' || !activity.attemptId))) return undefined
  return value as WorkerActivity
}
function currentActivity(member: Member, task: Task | undefined): WorkerActivity | undefined {
  const activity = activityOf(member.activity)
  if (!activity) return undefined
  if (task) {
    const attempt = task.attempt
    if (!attempt || attempt.ownerId !== member.id || !Number.isSafeInteger(task.epoch)
      || attempt.epoch !== task.epoch || activity.attemptId !== attempt.id) return undefined
  } else if (activity.attemptId !== undefined) return undefined
  // Unscoped native operations can occur while a worker prepares to claim work.
  return activity
}
function restingState(snapshot: Snapshot, member: Member): { state: LiveWorkState; label: string } | undefined {
  if (snapshot.mission.status === 'completed') return { state: 'complete', label: 'Collaboration completed' }
  if (snapshot.mission.status === 'stopped' || member.phase === 'stopped' || member.status === 'stopped') return { state: 'stopped', label: 'Stopped' }
  if (snapshot.mission.status === 'paused' || snapshot.mission.budgetPause) return { state: 'paused', label: 'Mission paused' }
  if (snapshot.mission.status === 'staged') return { state: 'waiting', label: 'Preparing collaboration' }
  if (snapshot.mission.status === 'blocked') return { state: 'waiting', label: 'Mission needs attention' }
  if (member.providerOutage) return { state: 'waiting', label: 'Waiting for provider recovery' }
  if (member.phase === 'parked' || member.status === 'waiting') return { state: 'waiting', label: 'Waiting for work' }
  return undefined
}

/** UI-only projection: no timers, scheduling decisions, generated events or completion estimates. */
export function projectLiveWork(snapshot: Snapshot, options: LiveWorkOptions): LiveWorkProjection {
  const now = timestamp(options.now) ? options.now : snapshot.mission.updatedAt
  const observedAt = timestamp(options.observedAt) ? Math.min(now, options.observedAt) : undefined
  const connected = options.connection === 'connected'
  const freshnessWindowMs = timestamp(options.freshnessWindowMs) ? options.freshnessWindowMs : 10_000
  const tasks = snapshot.tasks.filter(task => task.missionId === snapshot.mission.id)
  const running = new Map<string, Task>()
  for (const task of tasks) {
    const owner = task.attempt?.ownerId ?? task.assigneeId
    if (task.status === 'running' && owner && !running.has(owner)) running.set(owner, task)
  }
  let lastObservedWorkingCount = 0
  const rows = snapshot.members.filter(member => member.missionId === snapshot.mission.id).map((member): LiveWorkRow => {
    const task = running.get(member.id)
    const resting = restingState(snapshot, member)
    const activity = resting ? undefined : currentActivity(member, task)
    const referenceTime = connected ? now : observedAt ?? activity?.updatedAt ?? now
    const ageMs = activity ? Math.max(0, referenceTime - activity.updatedAt) : undefined
    const operationDurationMs = activity ? Math.max(0, referenceTime - activity.startedAt) : undefined
    const leaseValid = task === undefined || (timestamp(task.attempt?.leaseUntil) && task.attempt.leaseUntil > referenceTime)
    const fresh = activity !== undefined && ageMs !== undefined && ageMs <= freshnessWindowMs && leaseValid
    let state: LiveWorkState = resting?.state ?? (activity?.kind === 'retry' ? 'waiting' : fresh ? 'observed'
      : task || activity || member.status === 'working' ? 'quiet' : 'idle')
    let label = resting?.label ?? (activity?.kind === 'retry' ? labels.retry : state === 'observed' ? labels[activity!.kind]
      : state === 'quiet' ? 'Waiting for activity confirmation' : 'Ready for work')
    if (state === 'observed') lastObservedWorkingCount++
    if (!connected && !['complete', 'stopped', 'paused'].includes(state)) { state = 'stale'; label = 'Last observed state' }
    return { member, ...(task ? { task } : {}), ...(activity ? { activity, observedAt: activity.updatedAt, ageMs, operationDurationMs } : {}),
      state, label, animate: state === 'observed' }
  })
  const counts = { accepted: 0, submitted: 0, pending: 0, running: 0, blocked: 0, cancelled: 0, total: tasks.length }
  for (const task of tasks) counts[task.status]++
  const events = projectEvents(snapshot)
  const lastProgressAt = events.filter(event => event.kind !== 'activity').reduce<number | undefined>((latest, event) => Math.max(latest ?? 0, event.createdAt), undefined)
  const lastActivityAt = rows.reduce<number | undefined>((latest, row) => row.observedAt === undefined ? latest : Math.max(latest ?? 0, row.observedAt), undefined)
  const eventLimit = timestamp(options.eventLimit) ? Math.min(20, Math.floor(options.eventLimit)) : 6
  return { rows, referenceTime: connected ? now : observedAt ?? snapshot.mission.updatedAt, connection: options.connection, live: connected && snapshot.mission.status === 'active' && !snapshot.mission.budgetPause,
    ...(observedAt === undefined ? {} : { observedAt }), workingCount: rows.filter(row => row.state === 'observed').length,
    lastObservedWorkingCount, counts, ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }), recentEvents: events.slice(0, eventLimit) }
}

function projectEvents(snapshot: Snapshot): LiveWorkEvent[] {
  const unique = new Map<number, SwarmEvent>()
  for (const event of snapshot.events) if (event.missionId === snapshot.mission.id && Number.isSafeInteger(event.seq) && event.seq >= 0 && timestamp(event.createdAt) && !unique.has(event.seq)) unique.set(event.seq, event)
  const events = [...unique.values()].sort((a, b) => b.seq - a.seq)
  const milestones = new Map(recentProgress({ ...snapshot, events }, events.length).map(event => [event.seq, event]))
  const members = new Map(snapshot.members.map(member => [member.id, member]))
  const tasks = new Map(snapshot.tasks.map(task => [task.id, task]))
  return events.flatMap((event): LiveWorkEvent[] => {
    const base = { id: `${snapshot.mission.id}:${event.seq}`, seq: event.seq, createdAt: event.createdAt }
    const data = record(event.data), type = event.type.replaceAll('.', '/')
    const milestone = milestones.get(event.seq)
    if (milestone) return [{ ...base, kind: 'milestone', label: milestone.label, ...(milestone.detail ? { detail: milestone.detail } : {}) }]
    if (type === 'tool/recorded' && text(data.runId) && text(data.tool)) {
      const taskId = text(data.taskId), task = taskId ? tasks.get(taskId) : undefined
      return [{ ...base, kind: 'tool', label: data.isError === true ? 'Tool reported an error' : 'Tool result recorded',
        detail: [text(data.tool), task?.title].filter(Boolean).join(' · '), memberId: event.actor, ...(taskId ? { taskId } : {}) }]
    }
    if (type !== 'member/activity') return []
    const memberId = text(data.memberId), member = memberId ? members.get(memberId) : undefined
    const activity = activityOf(data.activity)
    if (!member || !activity) return []
    // Native touches do not create events. Reject stale attempt attribution here too.
    const task = activity.attemptId === undefined ? undefined : snapshot.tasks.find(task => task.attempt !== undefined && task.attempt.id === activity.attemptId
      && task.attempt.ownerId === member.id && Number.isSafeInteger(task.epoch) && task.attempt.epoch === task.epoch)
    if (activity.attemptId !== undefined && !task) return []
    return [{ ...base, kind: 'activity', label: labels[activity.kind], memberId: member.id,
      ...(task ? { taskId: task.id } : {}), detail: [member.name, activity.tool, task?.title].filter(Boolean).join(' · ').slice(0, 400) }]
  })
}
