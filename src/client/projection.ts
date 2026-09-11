import type { Member, Snapshot, SwarmEvent, Task, Evidence } from '../types.ts'

export type BoardLane = 'ready' | 'queued' | 'active' | 'review' | 'blocked' | 'cancelled' | 'done'
/**
 * OWNER PASS 2026-09-11: blocked and cancelled were one lane and one label
 * ("Blocked / cancelled"), which read every withdrawal as a defect and every
 * dependency wait as a failure. They are four different facts and the board now
 * says which one it is:
 *  - `queued`: waiting on work that is still alive and will advance by itself;
 *  - `blocked`: cannot advance without an owner decision (a dead dependency, a
 *    stopped assignee, a review whose source is gone);
 *  - `cancelled`: withdrawn, with the reason classified on the card by
 *    {@link cancellationNotes} (superseded repair, retired review, end of
 *    mission, owner withdrawal, or an unrecorded cause).
 */
export const LANES: readonly { id: BoardLane; label: string }[] = [
  { id: 'ready', label: 'Ready' }, { id: 'queued', label: 'Queued' },
  { id: 'active', label: 'In progress' }, { id: 'review', label: 'Awaiting acceptance' },
  { id: 'blocked', label: 'Blocked' }, { id: 'cancelled', label: 'Cancelled' },
  { id: 'done', label: 'Accepted' },
]

/** A dependency on a replaced task is met by its accepted repair, mirroring the runtime's lineage rule. */
export interface BoardIndex {
  byId: ReadonlyMap<string, Task>
  /** The task a dependency reference currently stands for after repair lineage, or undefined. */
  effective(id: string): Task | undefined
  dependencyMet(id: string): boolean
  blockedDependencies(task: Task): string[]
  lane(task: Task, members?: readonly Member[]): BoardLane
}

function oldest(tasks: readonly Task[]): Task | undefined {
  let best: Task | undefined
  for (const task of tasks) {
    if (best === undefined || task.createdAt < best.createdAt
      || (task.createdAt === best.createdAt && task.id < best.id)) best = task
  }
  return best
}

/**
 * One pass over the task list that resolves every lane and lineage question
 * through maps. The board and graph call this once per render, so their cost
 * stays O(tasks + edges) instead of rescanning the task array per task and per
 * edge (F-34). The lineage rule matches the runtime exactly: two accepted
 * repairs for one obligation is ambiguous history and fails closed, otherwise
 * the oldest live repair wins with the id as a total tie-break.
 */
export function boardIndex(tasks: readonly Task[]): BoardIndex {
  const byId = new Map<string, Task>()
  const replacements = new Map<string, Task[]>()
  for (const task of tasks) {
    byId.set(task.id, task)
    for (const target of task.replaces ?? []) {
      const list = replacements.get(target)
      if (list === undefined) replacements.set(target, [task])
      else list.push(task)
    }
  }
  const resolved = new Map<string, Task | undefined>()
  const effective = (id: string): Task | undefined => {
    if (resolved.has(id)) return resolved.get(id)
    let current = byId.get(id)
    const seen = new Set<string>()
    while (current && (current.status === 'cancelled' || current.status === 'blocked') && !seen.has(current.id)) {
      seen.add(current.id)
      const candidates = (replacements.get(current.id) ?? []).filter(task => task.kind === current!.kind && !seen.has(task.id))
      const accepted = candidates.filter(task => task.status === 'accepted')
      // Two accepted artifacts for one obligation is ambiguous history: no arbitrary artifact is trusted.
      const next = accepted.length > 1 ? undefined
        : (accepted[0] ?? oldest(candidates.filter(task => ['pending', 'running', 'submitted'].includes(task.status)))
          ?? oldest(candidates.filter(task => task.status === 'blocked' || task.status === 'cancelled')))
      if (!next) break
      current = next
    }
    resolved.set(id, current)
    return current
  }
  const dependencyMet = (id: string): boolean => effective(id)?.status === 'accepted'
  const blockedDependencies = (task: Task): string[] => task.dependencies.filter(id => !dependencyMet(id))
  // A task is still alive while it can reach an acceptance or a verdict on its
  // own; only a dead one makes its dependents blocked rather than queued.
  const alive = (status: string): boolean => status === 'pending' || status === 'running' || status === 'submitted'
  const lane = (task: Task, members?: readonly Member[]): BoardLane => {
    if (task.status === 'accepted') return 'done'
    if (task.status === 'running') return 'active'
    if (task.status === 'submitted') return 'review'
    if (task.status === 'cancelled') return 'cancelled'
    if (task.status === 'blocked') return 'blocked'
    // A review waits while its source is still in flight and is blocked when the
    // source can no longer become submitted (the runtime calls the latter
    // unschedulable); a pending task assigned to a stopped member has no live
    // owner either way.
    if (task.reviewOf !== undefined) {
      const source = effective(task.reviewOf)
      if (source?.status !== 'submitted') return source !== undefined && alive(source.status) ? 'queued' : 'blocked'
    }
    const unmet = blockedDependencies(task)
    if (unmet.length > 0) return unmet.every(id => { const dependency = effective(id); return dependency !== undefined && alive(dependency.status) }) ? 'queued' : 'blocked'
    if (members !== undefined && task.assigneeId !== undefined
      && !members.some(member => member.id === task.assigneeId && member.status !== 'stopped')) return 'blocked'
    return 'ready'
  }
  return { byId, effective, dependencyMet, blockedDependencies, lane }
}

/** Compatibility wrapper for a single lineage query; render paths reuse one `boardIndex`. */
export function dependencyMet(id: string, tasks: readonly Task[]): boolean {
  return boardIndex(tasks).dependencyMet(id)
}

/** Dependent pending work is visibly blocked instead of advertised as dispatchable. */
export function taskLane(task: Task, tasks: readonly Task[]): BoardLane {
  return boardIndex(tasks).lane(task)
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
    || (mission.reason !== undefined && typeof mission.reason !== 'string')
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
  if (candidate.pendingDeliveries !== undefined && !finite(candidate.pendingDeliveries)) return undefined
  // S6: the critical-path projection is rendered, so it is validated like every
  // other rendered field; a malformed projection is dropped, not rendered.
  if (candidate.criticalPath !== undefined && !(record(candidate.criticalPath)
    && finite(candidate.criticalPath.length) && finite(candidate.criticalPath.remaining)
    && finite(candidate.criticalPath.usedSteps) && strings(candidate.criticalPath.taskIds))) return undefined
  // Every field a renderer dereferences is validated here: a malformed or
  // version-skewed snapshot must be rejected instead of throwing mid-render.
  if (!(candidate.tasks as unknown[]).every(task => record(task) && typeof task.id === 'string'
    && typeof task.title === 'string' && typeof task.status === 'string' && typeof task.kind === 'string'
    && strings(task.dependencies) && strings(task.evidenceIds) && strings(task.scope)
    && (task.output === undefined || typeof task.output === 'string')
    && (task.objective === undefined || typeof task.objective === 'string')
    && (task.workstreamId === undefined || typeof task.workstreamId === 'string')
    && (task.assigneeId === undefined || typeof task.assigneeId === 'string')
    && (task.reviewOf === undefined || typeof task.reviewOf === 'string')
    && (task.reviewedCommit === undefined || typeof task.reviewedCommit === 'string')
    && (task.replaces === undefined || strings(task.replaces))
    && (task.checks === undefined || strings(task.checks))
    && (task.acceptance === undefined || strings(task.acceptance))
    && (task.experiment === undefined || typeof task.experiment === 'boolean')
    && (task.priority === undefined || finite(task.priority))
    && (task.epoch === undefined || finite(task.epoch))
    && (task.createdAt === undefined || finite(task.createdAt))
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
    && typeof stream.title === 'string'
    && (stream.objective === undefined || typeof stream.objective === 'string'))) return undefined
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

export interface DurableVerdict { seq: number; type: string }

/** The latest durable verdict event per evidence id, built in one pass over the events (F-34). */
export function durableVerdicts(snapshot: Snapshot): Map<string, DurableVerdict> {
  const verdicts = new Map<string, DurableVerdict>()
  for (const event of snapshot.events) {
    if (!record(event.data)) continue
    const type = event.type.replaceAll('.', '/')
    if (!/(?:verdict|verified|refuted|challenged)/.test(type)) continue
    const named = typeof event.data.evidenceId === 'string' ? event.data.evidenceId
      : type.startsWith('evidence/') && typeof event.data.id === 'string' ? event.data.id : undefined
    if (named === undefined) continue
    const previous = verdicts.get(named)
    if (previous === undefined || event.seq >= previous.seq) verdicts.set(named, { seq: event.seq, type })
  }
  return verdicts
}

/**
 * The durable event that names this evidence's verdict, if any. `verify`
 * mutates `evidence.status` without emitting an event naming the evidence id
 * (round-3 F-12, owned by the runtime trace task); until such an event exists
 * the panel must not present the state change as recorded history. Any
 * `evidence/*` verdict event carrying this evidence id is accepted, so the
 * projection starts working as soon as the runtime emits one.
 */
export function durableVerdict(snapshot: Snapshot, evidenceId: string): DurableVerdict | undefined {
  return durableVerdicts(snapshot).get(evidenceId)
}

export interface RetiredReview { id: string; title: string }

/** Withdrawn verification tasks per reviewed source, built in one pass over tasks (F-34). */
/**
 * Why a task is sitting in the cancelled lane. Four causes were collapsed into
 * one label before this pass, and the board could not tell a healthy repair from
 * a real withdrawal:
 *  - `superseded`: another task names it in `replaces` (the repair lineage the
 *    runtime resolves through);
 *  - `retired-review`: a verification withdrawn because its source reached a
 *    verdict (the runtime retires sibling reviews);
 *  - `at-completion`: a mission completed with this task still queued;
 *  - `withdrawn`: the durable `task/cancelled` event names the owner as actor,
 *    with the recorded reason as the detail;
 *  - `unrecorded`: the snapshot carries no cause, stated rather than guessed.
 */
export type CancellationKind = 'superseded' | 'retired-review' | 'at-completion' | 'withdrawn' | 'unrecorded'
export interface CancellationNote { kind: CancellationKind; detail?: string }
export function cancellationNotes(snapshot: Snapshot): Map<string, CancellationNote> {
  const index = boardIndex(snapshot.tasks)
  const replacement = new Map<string, Task>()
  for (const task of snapshot.tasks) for (const target of task.replaces ?? []) if (!replacement.has(target)) replacement.set(target, task)
  const withdrawn = new Map<string, string>()
  for (const event of snapshot.events) {
    if (event.type !== 'task/cancelled' || event.actor !== 'owner') continue
    const data = event.data as { taskId?: unknown; reason?: unknown } | undefined
    if (typeof data?.taskId === 'string' && !withdrawn.has(data.taskId)) withdrawn.set(data.taskId, typeof data.reason === 'string' ? data.reason : '')
  }
  const notes = new Map<string, CancellationNote>()
  for (const task of snapshot.tasks) {
    if (task.status !== 'cancelled') continue
    const repair = replacement.get(task.id)
    if (repair !== undefined) { notes.set(task.id, { kind: 'superseded', detail: repair.title }); continue }
    if (task.kind === 'verification' && task.reviewOf !== undefined) {
      notes.set(task.id, { kind: 'retired-review', detail: index.byId.get(task.reviewOf)?.title }); continue
    }
    if (snapshot.mission.status === 'completed') { notes.set(task.id, { kind: 'at-completion' }); continue }
    if (withdrawn.has(task.id)) { notes.set(task.id, { kind: 'withdrawn', ...(withdrawn.get(task.id) ? { detail: withdrawn.get(task.id)! } : {}) }); continue }
    notes.set(task.id, { kind: 'unrecorded', ...(task.output ? { detail: task.output.slice(0, 160) } : {}) })
  }
  return notes
}

export function retiredReviewsBySource(snapshot: Snapshot): Map<string, RetiredReview[]> {
  const retired = new Map<string, RetiredReview[]>()
  for (const task of snapshot.tasks) {
    if (task.kind !== 'verification' || task.reviewOf === undefined || task.status !== 'cancelled') continue
    const list = retired.get(task.reviewOf)
    const review = { id: task.id, title: task.title }
    if (list === undefined) retired.set(task.reviewOf, [review])
    else list.push(review)
  }
  return retired
}

/** Verification tasks of one source that the owner or runtime withdrew (F-12 sibling surface). */
export function retiredReviews(snapshot: Snapshot, sourceTaskId: string): RetiredReview[] {
  return retiredReviewsBySource(snapshot).get(sourceTaskId) ?? []
}

/**
 * OWNER PASS 2026-09-11: the Activity tab used to be one flat newest-first list
 * in which the runtime, the owner and every worker were interleaved, so the
 * answer to "what has Atlas been doing?" required reading every row. Events are
 * grouped by their durable actor instead — newest group first, newest event
 * first inside a group — in one pass over the retained window (F-34). An actor
 * that is a member carries the member row so the group header can draw the same
 * sprite as the roster; the non-member writers get a stable role label instead of
 * a raw key.
 */
const ACTOR_LABELS: Record<string, string> = {
  owner: 'Owner conversation', runtime: 'Runtime', config: 'Configuration', host: 'Harness',
}
export interface ActivityGroup { actor: string; name: string; member?: Member; events: SwarmEvent[] }
export function activityGroups(snapshot: Snapshot): ActivityGroup[] {
  const members = new Map(snapshot.members.map(member => [member.id, member]))
  const groups = new Map<string, ActivityGroup>()
  for (const event of snapshot.events) {
    let group = groups.get(event.actor)
    if (group === undefined) {
      const member = members.get(event.actor)
      group = { actor: event.actor, name: member?.name ?? ACTOR_LABELS[event.actor] ?? shortId(event.actor),
        ...(member === undefined ? {} : { member }), events: [] }
      groups.set(event.actor, group)
    }
    group.events.push(event)
  }
  for (const group of groups.values()) group.events.sort((a, b) => b.seq - a.seq)
  return [...groups.values()].sort((a, b) => b.events[0]!.seq - a.events[0]!.seq)
}

/**
 * No raw tool arguments/results in the event list; display bounded, inert JSON
 * only. `command`/`runId` name a denied git write and `outcome`/`verdict` name
 * a verdict, so the compact activity list can be reconstructed without the
 * raw event payload (F-14). `previousChecks`/`checks`/`reviewOf` carry the
 * R11-09 check-change and review-link payload; the workspace-audit keys carry
 * the authorization binding and revocation (grant root, resolved path, source).
 */
export function eventSummary(data: unknown): string {
  if (!record(data)) return ''
  return Object.entries(data).filter(([key]) => ['taskId', 'memberId', 'reason', 'status', 'evidenceId', 'title', 'kind',
    'runId', 'command', 'outcome', 'verdict', 'commit', 'resultCommit', 'previousStatus',
    'previousChecks', 'checks', 'reviewOf', 'workspace', 'path', 'grantRoot', 'loaded', 'source', 'blockedTasks',
    'escalationId', 'deliveryId', 'dedupKey', 'bodyChars', 'limit', 'class'].includes(key))
    .map(([key, value]) => `${key}: ${String(value).slice(0, 160)}`).join(' · ')
}
