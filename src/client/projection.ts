import type { Snapshot, Task, Evidence } from '../types.ts'

export type BoardLane = 'ready' | 'active' | 'review' | 'done' | 'blocked'
export const LANES: readonly { id: BoardLane; label: string }[] = [
  { id: 'ready', label: 'Ready' }, { id: 'active', label: 'In progress' },
  { id: 'review', label: 'Awaiting acceptance' }, { id: 'done', label: 'Accepted' },
  { id: 'blocked', label: 'Blocked / cancelled' },
]

/** A dependency on a replaced task is met by its accepted repair, mirroring the runtime's lineage rule. */
export function dependencyMet(id: string, tasks: readonly Task[]): boolean {
  let current = tasks.find(item => item.id === id)
  const seen = new Set<string>()
  while (current && (current.status === 'cancelled' || current.status === 'blocked') && !seen.has(current.id)) {
    seen.add(current.id)
    const replacements = tasks.filter(item => item.replaces?.includes(current!.id) && item.kind === current!.kind && !seen.has(item.id))
    current = replacements.find(item => item.status === 'accepted') ?? replacements.find(item => item.status !== 'cancelled') ?? undefined
  }
  return current?.status === 'accepted'
}

/** Dependent pending work is visibly blocked instead of advertised as dispatchable. */
export function taskLane(task: Task, tasks: readonly Task[]): BoardLane {
  if (task.status === 'accepted') return 'done'
  if (task.status === 'running') return 'active'
  if (task.status === 'submitted') return 'review'
  if (task.status === 'blocked' || task.status === 'cancelled') return 'blocked'
  if (task.reviewOf && tasks.find(item => item.id === task.reviewOf)?.status !== 'submitted') return 'blocked'
  return task.dependencies.some(id => !dependencyMet(id, tasks)) ? 'blocked' : 'ready'
}

export function remainingPercent(used: number, limit: number): number {
  return limit <= 0 ? 0 : Math.max(0, Math.min(100, 100 - used / limit * 100))
}

export function shortId(id: string): string { return id.length > 12 ? id.slice(0, 8) : id }
export function compactNumber(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m`
    : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }
function artifact(value: unknown): boolean {
  return value === undefined || (record(value) && typeof value.commit === 'string'
    && typeof value.baseCommit === 'string' && strings(value.changedPaths))
}
function attempt(value: unknown): boolean {
  return value === undefined || (record(value) && typeof value.id === 'string'
    && typeof value.ownerId === 'string' && finite(value.epoch) && finite(value.leaseUntil))
}
/**
 * Runtime-projected fields this client consumes. The runtime task lands the
 * declarations in `types.ts`; reading them through a validating accessor keeps
 * this projection honest about untrusted payloads and independent of that landing.
 */
export interface DeliveryTargetProjection { taskId: string; commit: string }
export interface CompletionProjection { eligible: boolean; reason?: string }
export interface AppliedDeliveryProjection { resultCommit: string; appliedAt?: number }
function projected(snapshot: Snapshot, key: string): unknown {
  return (snapshot as unknown as Record<string, unknown>)[key]
}
/** The unique maximal accepted integration the runtime will deliver; undefined on legacy snapshots. */
export function readDeliveryTarget(snapshot: Snapshot): DeliveryTargetProjection | undefined {
  const value = projected(snapshot, 'deliveryTarget')
  return record(value) && typeof value.taskId === 'string' && typeof value.commit === 'string'
    ? { taskId: value.taskId, commit: value.commit } : undefined
}
/** Runtime completion eligibility and its blocking reason; undefined on legacy snapshots. */
export function readCompletion(snapshot: Snapshot): CompletionProjection | undefined {
  const value = projected(snapshot, 'completion')
  return record(value) && typeof value.eligible === 'boolean' && (value.reason === undefined || typeof value.reason === 'string')
    ? { eligible: value.eligible, ...(value.reason === undefined ? {} : { reason: value.reason }) } : undefined
}
/** Durable applied-delivery receipt recorded by the runtime; undefined until a result was applied. */
export function readAppliedDelivery(snapshot: Snapshot): AppliedDeliveryProjection | undefined {
  const value = projected(snapshot, 'appliedDelivery')
  return record(value) && typeof value.resultCommit === 'string' && (value.appliedAt === undefined || finite(value.appliedAt))
    ? { resultCommit: value.resultCommit, ...(value.appliedAt === undefined ? {} : { appliedAt: value.appliedAt as number }) } : undefined
}

/** Treat historical payloads as untrusted, including malformed or incompatible versions. */
export function readSnapshot(value: unknown): Snapshot | undefined {
  const candidate = record(value) && 'swarmSnapshot' in value ? value.swarmSnapshot
    : record(value) && 'snapshot' in value ? value.snapshot : value
  if (!record(candidate) || !record(candidate.mission)) return undefined
  const mission = candidate.mission
  if (mission.baseline !== undefined && (!record(mission.baseline)
    || typeof mission.baseline.snapshotCommit !== 'string' || typeof mission.baseline.sourceHead !== 'string'
    || typeof mission.baseline.planningWorkspace !== 'string' || !strings(mission.baseline.changedPaths)
    || !finite(mission.baseline.createdAt))) return undefined
  if (typeof mission.id !== 'string' || typeof mission.title !== 'string'
    || typeof mission.objective !== 'string' || typeof mission.status !== 'string'
    || !finite(mission.updatedAt) || !finite(mission.createdAt) || !finite(mission.deadline)
    || !finite(mission.usedSteps) || !finite(mission.usedTokens)
    || !record(mission.budget) || !strings(mission.scope) || !strings(mission.acceptance)) return undefined
  if (!['maxTokens', 'maxSteps', 'maxWorkers', 'maxDurationMs', 'maxTasks', 'maxExperiments'].every(key => finite((mission.budget as Record<string, unknown>)[key]))) return undefined
  if (candidate.deliveryTarget !== undefined && !(record(candidate.deliveryTarget)
    && typeof candidate.deliveryTarget.taskId === 'string' && typeof candidate.deliveryTarget.commit === 'string')) return undefined
  if (candidate.completion !== undefined && !(record(candidate.completion)
    && typeof candidate.completion.eligible === 'boolean'
    && (candidate.completion.reason === undefined || typeof candidate.completion.reason === 'string'))) return undefined
  if (candidate.appliedDelivery !== undefined && !(record(candidate.appliedDelivery)
    && typeof candidate.appliedDelivery.resultCommit === 'string'
    && (candidate.appliedDelivery.appliedAt === undefined || finite(candidate.appliedDelivery.appliedAt)))) return undefined
  if (!['members', 'tasks', 'workstreams', 'evidence', 'events'].every(key => Array.isArray(candidate[key]))) return undefined
  if (!(candidate.tasks as unknown[]).every(task => record(task) && typeof task.id === 'string'
    && typeof task.title === 'string' && typeof task.status === 'string' && typeof task.kind === 'string'
    && strings(task.dependencies) && strings(task.evidenceIds) && strings(task.scope)
    && attempt(task.attempt) && artifact(task.artifact))) return undefined
  if (!(candidate.members as unknown[]).every(member => record(member) && typeof member.id === 'string'
    && typeof member.name === 'string' && typeof member.role === 'string' && typeof member.status === 'string')) return undefined
  if (!(candidate.evidence as unknown[]).every(evidence => record(evidence) && typeof evidence.claim === 'string'
    && typeof evidence.id === 'string' && typeof evidence.authorId === 'string' && typeof evidence.taskId === 'string'
    && typeof evidence.status === 'string' && typeof evidence.outcome === 'string' && artifact(evidence.artifact)
    && strings(evidence.toolRunIds) && strings(evidence.supersedes)
    && Array.isArray(evidence.challenges) && evidence.challenges.every(challenge => record(challenge)
      && typeof challenge.reason === 'string' && typeof challenge.authorId === 'string' && strings(challenge.toolRunIds)))) return undefined
  if (!(candidate.workstreams as unknown[]).every(stream => record(stream) && typeof stream.id === 'string'
    && typeof stream.title === 'string')) return undefined
  if (!(candidate.events as unknown[]).every(event => record(event) && typeof event.seq === 'number'
    && typeof event.type === 'string' && typeof event.createdAt === 'number')) return undefined
  return candidate as unknown as Snapshot
}

/** UI-only native tool metadata takes precedence; text JSON remains a compatibility path. */
export function snapshotFromResult(meta: unknown, content: unknown): Snapshot | undefined {
  const privateSnapshot = readSnapshot(meta)
  if (privateSnapshot !== undefined) return privateSnapshot
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!record(block)) continue
    if (block.type === 'tool-result' && block.isError !== true) {
      const nested = snapshotFromResult(undefined, block.content)
      if (nested) return nested
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      try { const snapshot = readSnapshot(JSON.parse(block.text)); if (snapshot) return snapshot } catch { /* Ordinary prose. */ }
    }
  }
  return undefined
}

/**
 * The deliverable the runtime will apply. The runtime projects its unique maximal
 * accepted integration as `deliveryTarget`; only a legacy snapshot without that
 * projection falls back to the historical local rule (first accepted integration,
 * or the single accepted implementation when the plan needed no assembly step).
 */
export function deliverableTask(snapshot: Snapshot): Task | undefined {
  const target = readDeliveryTarget(snapshot)
  if (target) return snapshot.tasks.find(task => task.id === target.taskId)
  const accepted = snapshot.tasks.filter(task => task.status === 'accepted' && task.artifact)
  const integration = accepted.find(task => task.kind === 'integration')
  if (integration) return integration
  if (snapshot.tasks.some(task => task.kind === 'integration')) return undefined
  const implementations = accepted.filter(task => task.kind === 'implementation')
  return implementations.length === 1 ? implementations[0] : undefined
}

/** The projected runtime target commit is authoritative; the local rule is a legacy fallback only. */
export function deliverableCommit(snapshot: Snapshot): string | undefined {
  return readDeliveryTarget(snapshot)?.commit ?? deliverableTask(snapshot)?.artifact?.commit
}

/**
 * A result is applied when the durable receipt projected by the runtime matches the
 * delivered commit. A projected receipt is authoritative. A runtime snapshot always
 * projects `completion`, so once that field is present an absent `appliedDelivery`
 * means "not currently applied" (the runtime clears it on a conflicts result) and the
 * bounded event window must not override it. The event window is only a fallback for
 * legacy snapshots that predate both projections.
 */
export function deliveryApplied(snapshot: Snapshot, resultCommit: string | undefined): boolean {
  if (!resultCommit) return false
  if (projected(snapshot, 'appliedDelivery') !== undefined) return readAppliedDelivery(snapshot)?.resultCommit === resultCommit
  if (projected(snapshot, 'completion') !== undefined) return false
  return snapshot.events.some(event => event.type === 'delivery/applied' && record(event.data) && event.data.resultCommit === resultCommit)
}

/**
 * Why the runtime would refuse `complete`. The runtime's projected eligibility is
 * authoritative; a legacy snapshot without it keeps the historical terminal-work rule.
 */
export function completionBlocker(snapshot: Snapshot): string | undefined {
  const completion = readCompletion(snapshot)
  if (completion) return completion.eligible ? undefined : completion.reason || 'Mission is not eligible to complete'
  if (!snapshot.tasks.length) return 'Mission still has unfinished or blocked required work'
  const unfinished = snapshot.tasks.some(task => !['accepted', 'cancelled'].includes(task.status) && !(task.experiment && task.status === 'blocked'))
  return unfinished ? 'Mission still has unfinished or blocked required work' : undefined
}

export function evidenceCounts(evidence: readonly Evidence[]): { verified: number; challenged: number; total: number } {
  return { verified: evidence.filter(item => item.status === 'verified').length,
    challenged: evidence.filter(item => item.status === 'challenged').length, total: evidence.length }
}

/** No raw tool arguments/results in the event list; display bounded, inert JSON only. */
export function eventSummary(data: unknown): string {
  if (!record(data)) return ''
  return Object.entries(data).filter(([key]) => ['taskId', 'memberId', 'reason', 'status', 'evidenceId', 'title', 'kind'].includes(key))
    .map(([key, value]) => `${key}: ${String(value).slice(0, 160)}`).join(' · ')
}
