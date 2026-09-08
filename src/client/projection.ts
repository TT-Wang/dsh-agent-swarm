import type { Snapshot, Task, Evidence } from '../types.ts'

export type BoardLane = 'ready' | 'active' | 'review' | 'done' | 'blocked'
export const LANES: readonly { id: BoardLane; label: string }[] = [
  { id: 'ready', label: 'Ready' }, { id: 'active', label: 'In progress' },
  { id: 'review', label: 'Awaiting acceptance' }, { id: 'done', label: 'Accepted' },
  { id: 'blocked', label: 'Blocked / cancelled' },
]

/** Dependent pending work is visibly blocked instead of advertised as dispatchable. */
export function taskLane(task: Task, tasks: readonly Task[]): BoardLane {
  if (task.status === 'accepted') return 'done'
  if (task.status === 'running') return 'active'
  if (task.status === 'submitted') return 'review'
  if (task.status === 'blocked' || task.status === 'cancelled') return 'blocked'
  if (task.reviewOf && tasks.find(item => item.id === task.reviewOf)?.status !== 'submitted') return 'blocked'
  return task.dependencies.some(id => tasks.find(item => item.id === id)?.status !== 'accepted') ? 'blocked' : 'ready'
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
  if (!['maxTokens', 'maxSteps', 'maxWorkers', 'maxTasks', 'maxExperiments'].every(key => finite((mission.budget as Record<string, unknown>)[key]))) return undefined
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
