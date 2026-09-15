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
      const accepted = candidates.filter(task => task.status === 'accepted')
      if (accepted.length > 1) {
        chain.push({ ...current, status: 'blocked', output: `Ambiguous accepted replacements ${accepted.map(task => task.id).sort().join(', ')} for ${current.id}` })
        break
      }
      const next = accepted[0] ?? oldest(candidates.filter(task => ['pending', 'running', 'submitted'].includes(task.status)))
        ?? oldest(candidates.filter(task => ['blocked', 'cancelled'].includes(task.status)))
      if (!next) break
      chain.push(next)
    }
    chains.set(id, chain)
    return chain
  }
  const effective = (id: string): Task | undefined => lineage(id).at(-1)
  const identities = (id: string): Set<string> => new Set(lineage(id).map(task => task.id))
  const dependencyMet = (id: string): boolean => effective(id)?.status === 'accepted'
  // Reviews always name the exact submitted source; replacement lineage is only for ordinary dependencies.
  const reviewSource = (task: Pick<Task, 'reviewOf'>): Task | undefined => task.reviewOf === undefined ? undefined : byId.get(task.reviewOf)
  const covers = (task: Task, sourceId: string, seen = new Set<string>()): boolean => {
    if (seen.has(task.id)) return false
    seen.add(task.id)
    return task.dependencies.some(id => {
      const chain = lineage(id)
      // An ambiguous/unfinished carrier cannot establish delivered artifact coverage.
      if (chain.at(-1)?.status !== 'accepted') return false
      return chain.some(parent => parent.id === sourceId || covers(parent, sourceId, seen))
    })
  }
  return { byId, lineage, effective, identities, dependencyMet, reviewSource, covers }
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
