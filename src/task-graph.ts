/**
 * Pure functions of task and mission rows, shared by the runtime seams and the
 * read-only projections. Every read takes an id as the rows hold it: one that
 * names no task of the mission reads as no task (no row, an empty lineage, no
 * effective task, a prerequisite never met). An id a caller supplies is refused
 * where it enters (`SwarmRuntime.task`, the admission graph check), never here.
 */
import { criterionId, type EvidenceStatus, type Mission, type Task } from './types.ts'

const oldest = (tasks: readonly Task[]): Task | undefined => [...tasks].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]

/**
 * The edges of one task: its dependencies, in order, then its review source,
 * which `prepareTask` merges into the worktree like a dependency. The graph
 * validator, the board's dangling-edge rule, the plan order and the runtime's
 * admission checks all read a task's edges here.
 */
export function taskEdges(node: { readonly dependencies: readonly string[]; readonly reviewOf?: string | undefined }): string[] {
  return [...node.dependencies, ...(node.reviewOf === undefined ? [] : [node.reviewOf])]
}

export function taskGraphIndex(tasks: readonly Task[]) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const replacements = new Map<string, Task[]>()
  for (const task of tasks) for (const target of task.replaces ?? []) {
    const list = replacements.get(target) ?? []
    list.push(task); replacements.set(target, list)
  }
  const replacementDescendants = (id: string): Task[] => {
    const seen = new Set<string>([id])
    const result: Task[] = []
    const pending = [...(replacements.get(id) ?? [])]
    for (let index = 0; index < pending.length; index++) {
      const task = pending[index]!
      if (seen.has(task.id)) continue
      seen.add(task.id); result.push(task)
      pending.push(...(replacements.get(task.id) ?? []))
    }
    return result
  }
  /**
   * A replacement of `id`, direct or transitive, that is not cancelled. While
   * one exists it carries `id`'s obligation, so `id` is admitted no second
   * repair and is neither resumed, amended nor re-pended by a host restart.
   */
  const liveReplacement = (id: string): Task | undefined => replacementDescendants(id).find(task => task.status !== 'cancelled')
  /**
   * `id` and every task it replaces, transitively: the one backward walk over
   * `replaces`, both parents of a `replaces: [a, b]` repair included, in
   * breadth-first order from `id`. Only indexed rows are returned, so an id
   * outside this mission ends its branch. Evidence supersession, the owner-notice
   * coverage and the retirement an accepted replacement performs all read it.
   */
  const replacedLineage = (id: string): Task[] => {
    const start = byId.get(id)
    if (start === undefined) return []
    const result = [start], seen = new Set([id])
    for (let index = 0; index < result.length; index++) for (const previousId of result[index]!.replaces ?? []) {
      const previous = byId.get(previousId)
      if (previous === undefined || seen.has(previousId)) continue
      seen.add(previousId); result.push(previous)
    }
    return result
  }
  // A cancelled branch may converge with another branch on the same accepted
  // repair. Count accepted task identities, not the number of incoming paths.
  // Live rows stop this traversal: an accepted historical descendant behind a
  // pending/running/submitted row is not the effective result of that branch.
  const frontiers = new Map<string, Map<string, Task>>()
  const acceptedFrontier = (id: string, parents?: Map<string, Set<string>>) => {
    const cached = frontiers.get(id)
    if (cached && parents === undefined) return cached
    const targets = new Map<string, Task>()
    const pending = [id], seen = new Set<string>()
    for (let index = 0; index < pending.length; index++) {
      const currentId = pending[index]!
      if (seen.has(currentId)) continue
      seen.add(currentId)
      const current = byId.get(currentId)
      if (!current) continue
      if (current.status === 'accepted') { targets.set(current.id, current); continue }
      if (!['blocked', 'cancelled'].includes(current.status)) continue
      for (const next of replacements.get(current.id) ?? []) {
        if (next.kind !== current.kind) continue
        if (parents !== undefined) {
          const predecessors = parents.get(next.id) ?? new Set<string>()
          predecessors.add(current.id); parents.set(next.id, predecessors)
        }
        pending.push(next.id)
      }
    }
    frontiers.set(id, targets)
    return targets
  }
  const chains = new Map<string, Task[]>()
  /**
   * Follow repair lineage from a referenced dependency to the task that now
   * carries its obligations. A blocked or cancelled task replaced by a live
   * repair resolves to that repair, recursively; the original identity in a
   * dependent's `dependencies` therefore keeps working after replacement. An id
   * outside the index has no chain.
   */
  const lineage = (id: string): Task[] => {
    const cached = chains.get(id)
    if (cached) return cached
    const source = byId.get(id)
    const chain = source ? [source] : []
    const seen = new Set<string>()
    while (chain.length) {
      const current = chain.at(-1)!
      if (!['blocked', 'cancelled'].includes(current.status) || seen.has(current.id)) break
      seen.add(current.id)
      const candidates = (replacements.get(current.id) ?? []).filter(task => task.kind === current.kind && !seen.has(task.id))
      // Legacy forks may have an accepted repair behind a cancelled parent.
      // A new direct pending branch must not silently hide that accepted work.
      const accepted = acceptedFrontier(current.id)
      if (accepted.size > 1) {
        chain.push({ ...current, status: 'blocked', output: `Ambiguous accepted replacements ${[...accepted.keys()].sort().join(', ')} for ${current.id}` })
        break
      }
      const acceptedId = accepted.keys().next().value
      const acceptedBranch = acceptedId === undefined ? undefined : oldest(candidates.filter(task => acceptedFrontier(task.id).has(acceptedId)))
      const next = acceptedBranch ?? oldest(candidates.filter(task => ['pending', 'running', 'submitted'].includes(task.status)))
        ?? oldest(candidates.filter(task => ['blocked', 'cancelled'].includes(task.status)))
      if (!next) break
      chain.push(next)
    }
    chains.set(id, chain)
    return chain
  }
  const effective = (id: string): Task | undefined => lineage(id).at(-1)
  const identities = (id: string): Set<string> => {
    const chain = lineage(id), endpoint = chain.at(-1)
    if (endpoint?.status !== 'accepted') return new Set(chain.map(task => task.id))
    // Keep every obligation on convergent paths, although lineage itself has a
    // deterministic canonical path for callers that need an ordered chain.
    const parents = new Map<string, Set<string>>()
    acceptedFrontier(id, parents)
    const result = new Set<string>(), pending = [endpoint.id]
    for (let index = 0; index < pending.length; index++) {
      const current = pending[index]!
      if (result.has(current)) continue
      result.add(current); pending.push(...(parents.get(current) ?? []))
    }
    return result
  }
  const dependencyMet = (id: string): boolean => effective(id)?.status === 'accepted'
  /**
   * The first edge of `task` (`taskEdges`) that names no task of the mission.
   * No work can ever meet such an edge, so the board's readers share this one
   * rule: readiness refuses the task naming it, `unschedulable` holds the
   * pending task dead, and `waitsLegitimately` holds that it waits on nothing,
   * whatever else it also waits on.
   */
  const danglingReference = (task: Pick<Task, 'dependencies' | 'reviewOf'>): string | undefined => taskEdges(task).find(id => !byId.has(id))
  /**
   * The effective task of each dependency that names one, an accepted repair
   * covering several originals merged once: the prerequisites workspace
   * preparation merges, and the ones `unschedulable` judges.
   */
  const effectiveDependencies = (task: Pick<Task, 'dependencies'>): Task[] => {
    const seen = new Set<string>()
    return task.dependencies.flatMap(dependency => effective(dependency) ?? []).filter(dependency => !seen.has(dependency.id) && seen.add(dependency.id))
  }
  /**
   * R16-A: the EFFECTIVE unfinished prerequisites of one task, deduplicated in
   * reference order. This is the one seam the waking classifier reads, so a notice
   * and the scheduler resolve a replaced dependency through the same lineage.
   */
  const unfinishedDependencies = (task: Pick<Task, 'dependencies'>): Task[] => {
    const seen = new Set<string>()
    const unfinished: Task[] = []
    for (const dependency of task.dependencies) {
      const endpoint = effective(dependency)
      if (endpoint === undefined || TERMINAL_STATES.has(endpoint.status) || seen.has(endpoint.id)) continue
      seen.add(endpoint.id)
      unfinished.push(endpoint)
    }
    return unfinished
  }
  // Reviews always name the exact submitted source; replacement lineage is only for ordinary dependencies.
  const reviewSource = (task: Pick<Task, 'reviewOf'>): Task | undefined => task.reviewOf === undefined ? undefined : byId.get(task.reviewOf)
  /** The mission criteria `id` answers for: its covers and those of every task it replaces. */
  const criteriaOf = (id: string): Set<string> => new Set(replacedLineage(id).flatMap(row => row.covers ?? []))
  /** What `id`'s worker and every reviewer check: its review source's checklist, the mission `criteria` it covers in mission order, then its lineage's own criteria. */
  const checklist = (id: string, criteria: readonly string[]): string[] => {
    const source = byId.get(id)?.reviewOf, covered = criteriaOf(id)
    return [...new Set([...(source === undefined ? [] : checklist(source, criteria)), ...criteria.filter((_, index) => covered.has(criterionId(index))), ...replacedLineage(id).flatMap(row => row.acceptance)])]
  }
  /**
   * Delivered-artifact coverage: is `sourceId`'s accepted content physically in
   * the artifact composed for `task`?
   *
   * The composition itself (`prepareTask`) merges, for every DECLARED dependency
   * of a task, that dependency's lineage ENDPOINT commit — a repair replaces its
   * predecessor's content (its `replaces` set is the owner's assertion that it
   * subsumes it), it never inherits the predecessor's own dependencies. The
   * predicate follows exactly those edges:
   *
   *  - the endpoint itself covers it, and so does every identity the endpoint
   *    subsumes through an accepted replacement (`identities`, which keeps the
   *    whole convergent obligation set: a legacy fork whose branches converge on
   *    one accepted repair is one dependency in practice);
   *  - beyond that, only the endpoint's OWN declared dependencies carry content.
   *
   * It used to expand `identities(id)` and then recurse into each identity's
   * dependencies, so a cancelled intermediate's plan counted as delivered content
   * even when the repair that replaced it never merged what that plan produced:
   * an integration behind a repaired task could complete and deliver an artifact
   * that silently omitted an accepted implementation (round 18, F1).
   */
  const covers = (task: Task, sourceId: string, seen = new Set<string>()): boolean => {
    if (seen.has(task.id)) return false
    seen.add(task.id)
    return task.dependencies.some(id => {
      const endpoint = effective(id)
      // An ambiguous/unfinished carrier cannot establish delivered artifact coverage.
      if (endpoint === undefined || endpoint.status !== 'accepted') return false
      return identities(id).has(sourceId) || covers(endpoint, sourceId, seen)
    })
  }
  return { byId, lineage, effective, identities, dependencyMet, danglingReference, effectiveDependencies, unfinishedDependencies,
    reviewSource, covers, replacementDescendants, liveReplacement, replacedLineage, criteriaOf, checklist }
}

/** Each mission criterion whose id `covered` lacks, as the id and its quoted text (`c2 "text"`), in mission order. */
export const uncoveredCriteria = (criteria: readonly string[], covered: ReadonlySet<string>): string[] =>
  criteria.flatMap((text, index) => covered.has(criterionId(index)) ? [] : [`${criterionId(index)} ${JSON.stringify(text)}`])

/** Reuse only while the indexed task rows remain unchanged within one synchronous read. */
export type TaskGraphIndex = ReturnType<typeof taskGraphIndex>

/** A single delivery predicate; withdrawn integration rows carry history, not an obligation. */
export function selectAcceptedDelivery(tasks: readonly Task[]): Task {
  const graph = taskGraphIndex(tasks)
  const implementations = tasks.filter(task => task.kind === 'implementation' && task.status === 'accepted')
  if (!tasks.some(task => task.kind === 'integration' && task.status !== 'cancelled')) {
    if (implementations.length === 1 && implementations[0]!.artifact) return implementations[0]!
    throw new Error('A unique independently accepted implementation artifact is required when no integration obligation remains')
  }
  const candidates = tasks.filter(task => task.kind === 'integration' && task.status === 'accepted' && task.artifact
    && implementations.every(source => graph.covers(task, source.id)))
  const finals = candidates.filter(candidate => !candidates.some(other => other.id !== candidate.id && graph.covers(other, candidate.id)))
  if (finals.length !== 1) throw new Error('A unique accepted integration of all implementation results is required; repair or combine the current delivery obligations before completing')
  return finals[0]!
}

/**
 * Completion's one exemption: a blocked optional experiment, and a blocked
 * review of one, which inherits it. A review is not itself an experiment (the
 * host-added one never is), yet when it rejects the experiment it only records
 * that the optional work failed, so it cannot hold the mission open either.
 */
export function completionExempt(task: Pick<Task, 'status' | 'experiment' | 'reviewOf'>, tasks: readonly Task[]): boolean {
  if (task.status !== 'blocked') return false
  if (task.experiment) return true
  const source = task.reviewOf === undefined ? undefined : tasks.find(candidate => candidate.id === task.reviewOf)
  return source !== undefined && completionExempt(source, tasks)
}

/** The states that leave a task no future. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set(['accepted', 'cancelled'])

/** The mission is terminal: no further scheduling or fencing applies. */
export const terminal = (mission: Pick<Mission, 'status'>): boolean => mission.status === 'stopped' || mission.status === 'completed'

/** R14-F2(a): the durable identity of one task at one epoch, as notices carry it. */
export function taskSubject(task: Pick<Task, 'id' | 'epoch'>): string { return `${task.id}@${task.epoch}` }
/**
 * R15-A1: the mission-scoped subject for a decision that names no single task (a
 * wedged scheduling pass, a failed member with no assigned work, an escalation).
 * It is the exact lineage root of such a decision, never a placeholder, so an
 * owner-facing notice always has something to be attributed to.
 */
export function missionSubject(mission: Pick<Mission, 'id'>): string { return `mission:${mission.id}` }
/**
 * R15-A1: the subjects of a set of tasks, with the mission root as the honest
 * fallback when the set is empty. Deduplicated and order-preserving.
 */
export function subjectsOfTasks(tasks: readonly Pick<Task, 'id' | 'epoch'>[], mission: Pick<Mission, 'id'>): string[] {
  const subjects: string[] = []
  for (const task of tasks) { const subject = taskSubject(task); if (!subjects.includes(subject)) subjects.push(subject) }
  return subjects.length ? subjects : [missionSubject(mission)]
}

/**
 * A fence this task still owes: a stop marker recorded at the task's OWN epoch.
 * A marker at an older epoch belongs to a fence a later epoch already replaced,
 * so it obliges nothing. This one comparison was written out at roughly twenty
 * call sites across the runtime, the attempt accounting, the scheduling pass and
 * the notices; naming it is what lets a reader see that they all ask the same
 * question rather than four similar ones.
 */
export function stopPending<T extends Pick<Task, 'epoch' | 'resumeAfterStop'>>(task: T): task is T & { resumeAfterStop: NonNullable<T['resumeAfterStop']> } {
  return task.resumeAfterStop?.epoch === task.epoch
}

/**
 * A durable stop transition is in flight: the task is blocked only until the
 * old worker handle acknowledges the stop, then it re-pends. Every scheduler
 * and completion decision treats it as live work.
 */
export function quiescencePending<T extends Pick<Task, 'status' | 'epoch' | 'resumeAfterStop'>>(task: T): task is T & { resumeAfterStop: NonNullable<T['resumeAfterStop']> } { return task.status === 'blocked' && stopPending(task) }

/** A fenced handle must finish stopping before that member can own new work. */
export function pendingStopOwner(tasks: readonly Task[], memberId: string): boolean {
  return tasks.some(task => {
    if (!stopPending(task)) return false
    const marker = task.resumeAfterStop
    if (marker.memberId !== undefined) return marker.memberId === memberId
    // An unresolved legacy owner is a conservative stop of every mission
    // handle; reserve every member until the complete scan confirms quiescence.
    return true
  })
}

/**
 * Why a task is, or on its next confirmed stop would be, blocked. A `blocked`
 * status has several causes that can hold together and clear independently (a
 * restart retires an obsolete finding ceiling while a preparation failure still
 * needs repair), so the set is derived from the task's own fields whenever a
 * reader asks, never stored as one discriminant.
 */
export type BlockCause = 'task-ceiling' | 'preparation-failed' | 'review-deferred' | 'needs-replacement' | 'refuted' | 'recovery-exhausted'

/**
 * The claims of the task's current attempt generation. A rework archives the
 * claims its rejection refuted in `rejections`: they stay refuted, but they no
 * longer block the task and no later submission or verdict touches them.
 */
export function currentEvidenceIds(task: Pick<Task, 'evidenceIds' | 'rejections'>): string[] {
  const archived = new Set(task.rejections?.flatMap(rejection => rejection.evidenceIds))
  return (task.evidenceIds ?? []).filter(evidenceId => !archived.has(evidenceId))
}

/**
 * The block causes holding for `task` now. `evidenceStatusOf` reads an evidence
 * row's current status; `defaultMaxRecoveryAttempts` is the limit of a task
 * without its own `maxRecoveryAttempts` (the runtime's `maxTasksPerMember`). A
 * preparation failure still inside its backoff retry is not a cause: that task
 * is pending and the host retries it.
 */
export function blockCauses(
  task: Pick<Task, 'status' | 'ceiling' | 'preparationFailure' | 'verificationRecovery' | 'artifact' | 'evidenceIds' | 'recoveryCount' | 'maxRecoveryAttempts' | 'rejections'>,
  evidenceStatusOf: (evidenceId: string) => EvidenceStatus | undefined,
  defaultMaxRecoveryAttempts: number,
): Set<BlockCause> {
  const causes = new Set<BlockCause>()
  if (task.ceiling !== undefined) causes.add('task-ceiling')
  if (task.preparationFailure !== undefined && task.preparationFailure.retryAt === undefined) causes.add('preparation-failed')
  if (task.verificationRecovery !== undefined) causes.add('review-deferred')
  // A rejected source, or submitted work invalidated after submission: its
  // artifact is immutable. Only an owner rework (a rejected non-experiment,
  // whose artifact then moves into history) or a replacement repairs it.
  if (task.status === 'blocked' && task.artifact !== undefined) causes.add('needs-replacement')
  if (currentEvidenceIds(task).some(evidenceId => evidenceStatusOf(evidenceId) === 'refuted')) causes.add('refuted')
  if ((task.recoveryCount ?? 0) >= (task.maxRecoveryAttempts ?? defaultMaxRecoveryAttempts)) causes.add('recovery-exhausted')
  return causes
}
