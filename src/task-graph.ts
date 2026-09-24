/** Pure task identity selectors shared by runtime and read-only projections. */
import type { Task } from './types.ts'

const oldest = (tasks: readonly Task[]): Task | undefined => [...tasks].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]

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
  // Reviews always name the exact submitted source; replacement lineage is only for ordinary dependencies.
  const reviewSource = (task: Pick<Task, 'reviewOf'>): Task | undefined => task.reviewOf === undefined ? undefined : byId.get(task.reviewOf)
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
  return { byId, lineage, effective, identities, dependencyMet, reviewSource, covers, replacementDescendants, replacedLineage }
}

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
