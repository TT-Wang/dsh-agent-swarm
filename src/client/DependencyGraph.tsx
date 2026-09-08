import { useId, useState } from 'react'
import type { Snapshot, Task } from '../types.ts'
import { taskLane } from './projection.ts'
import { useCopy } from './locale.tsx'

/** Rank dependencies plus review edges; tolerate historical missing/cyclic entries. */
export function graphLayout(tasks: readonly Task[]) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const ranks = new Map<string, number>()
  const rank = (id: string, seen = new Set<string>()): number => {
    if (ranks.has(id)) return ranks.get(id)!
    if (seen.has(id)) return 0
    const task = byId.get(id)
    if (!task) return 0
    const next = new Set(seen).add(id)
    const deps = [...task.dependencies, ...(task.reviewOf ? [task.reviewOf] : [])].filter(dep => byId.has(dep))
    const value = deps.length ? 1 + Math.max(...deps.map(dep => rank(dep, next))) : 0
    ranks.set(id, value)
    return value
  }
  const rows = new Map<number, number>()
  const nodes = tasks.map(task => {
    const column = rank(task.id), row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    return { task, x: 20 + column * 228, y: 20 + row * 108 }
  })
  return { nodes, width: Math.max(460, ...nodes.map(node => node.x + 216)), height: Math.max(145, ...nodes.map(node => node.y + 100)) }
}

export function DependencyGraph({ snapshot, tasks }: { snapshot: Snapshot; tasks: Task[] }) {
  const t = useCopy(), [selected, setSelected] = useState<string>()
  const markerId = `sw-arrow-${useId().replaceAll(':', '')}`
  const layout = graphLayout(tasks)
  const focused = tasks.find(task => task.id === selected)
  return <section className="sw-graph-section"><h3>{t('Dependency graph')}</h3>
    <div className="sw-graph-scroll"><div className="sw-graph" style={{ width: layout.width, height: layout.height }}>
      <svg width={layout.width} height={layout.height} aria-hidden="true"><defs><marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7Z" fill="currentColor" /></marker></defs>
        {layout.nodes.flatMap(node => [...node.task.dependencies.map(id => ({ id, review: false })), ...(node.task.reviewOf ? [{ id: node.task.reviewOf, review: true }] : [])].map(edge => {
          const source = layout.nodes.find(item => item.task.id === edge.id)
          if (!source) return null
          return <path key={`${node.task.id}-${edge.id}`} d={`M${source.x + 194} ${source.y + 38} C${source.x + 211} ${source.y + 38} ${node.x - 20} ${node.y + 38} ${node.x - 4} ${node.y + 38}`} fill="none" stroke="currentColor" strokeDasharray={edge.review ? '4 4' : undefined} markerEnd={`url(#${markerId})`} />
        }))}
      </svg>
      {layout.nodes.map(node => <button key={node.task.id} className="sw-graph-node" data-lane={taskLane(node.task, snapshot.tasks)}
        aria-pressed={selected === node.task.id} onClick={() => setSelected(node.task.id)} style={{ left: node.x, top: node.y }}>
        <small>{node.task.kind} · {node.task.status}</small><strong>{node.task.title}</strong>
      </button>)}
    </div></div>
    {focused ? <div className="sw-graph-detail"><strong>{focused.title}</strong><p>{focused.objective}</p>
      <p>{t('Prerequisites')}: {[...focused.dependencies, ...(focused.reviewOf ? [focused.reviewOf] : [])].map(id => snapshot.tasks.find(task => task.id === id)?.title ?? id).join('; ') || t('None')}</p>
      {focused.attempt && <p>Attempt {focused.attempt.epoch} · {snapshot.members.find(member => member.id === focused.attempt?.ownerId)?.name}</p>}
      {focused.output && <p>{focused.output}</p>}</div> : <p className="sw-small">{t('Select a task to inspect its prerequisites, attempt and output.')}</p>}
  </section>
}
