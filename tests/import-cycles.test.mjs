/**
 * The src import graph has no strongly connected component, even when a
 * type-only import (`import type`, or a specifier list whose every name is
 * `type`) counts as an edge: every module another imports, for a value or a
 * type, sits below it.
 *
 * The seams once formed one value cycle (attempts, notices, scheduling,
 * workspace-admission): each imported a pure helper or a pass stamp from
 * another, so no one of them could be built or read alone; the helpers now
 * live in leaves (`task-graph.ts`, `kernel.ts`, `scheduler.ts`). Each seam
 * also held the whole runtime (`rt: SwarmRuntime`), one type cycle through
 * runtime.ts and every seam; a seam now stands on the `Kernel` interface
 * (src/kernel.ts) and the collaborators below it, and since the runtime
 * imports every seam it builds, a seam that imported runtime.ts, even for a
 * type, would be a cycle here. The pure functions of a check result row live
 * in a leaf (`check-results.ts`), so the board and the workspace engine do not
 * import the declared-check seam, and the browser's progress line names only
 * the part of a live-work row it reads.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { sourceTree } from './source-semantics.mjs'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Each src module and the local modules it imports or re-exports, for a value or only for a type. */
function localImports() {
  const files = []
  const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) entry.isDirectory() ? walk(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) && files.push(join(directory, entry.name)) }
  walk(SRC)
  const graph = new Map()
  for (const file of files) {
    const edges = new Set()
    for (const statement of sourceTree(readFileSync(file, 'utf8'), file).statements) {
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ? statement.moduleSpecifier : undefined
      if (specifier === undefined || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue
      edges.add(relative(SRC, normalize(join(dirname(file), specifier.text))).replace(/\.js$/, '.ts'))
    }
    graph.set(relative(SRC, file), edges)
  }
  return graph
}

/** Tarjan's strongly connected components of more than one module, or of one module importing itself. */
function cycles(graph) {
  let next = 0
  const index = new Map(), low = new Map(), stack = [], onStack = new Set(), found = []
  const visit = node => {
    index.set(node, next); low.set(node, next); next++
    stack.push(node); onStack.add(node)
    for (const target of graph.get(node) ?? []) {
      if (!graph.has(target)) continue
      if (!index.has(target)) { visit(target); low.set(node, Math.min(low.get(node), low.get(target))) }
      else if (onStack.has(target)) low.set(node, Math.min(low.get(node), index.get(target)))
    }
    if (low.get(node) !== index.get(node)) return
    const component = []
    let member
    do { member = stack.pop(); onStack.delete(member); component.push(member) } while (member !== node)
    if (component.length > 1 || graph.get(node).has(node)) found.push(component.sort())
  }
  for (const node of graph.keys()) if (!index.has(node)) visit(node)
  return found
}

test('the src import graph has no cycle, even when a type-only import counts as an edge', () => {
  const graph = localImports()
  assert.ok(graph.size > 30 && graph.get('notices.ts')?.has('task-graph.ts'), 'the scan reads the real src graph')
  assert.ok(graph.get('kernel.ts')?.has('board.ts') && graph.get('runtime.ts')?.has('scheduling.ts'), 'a type-only import is an edge (the kernel names the board\'s types), and the runtime imports the seams it builds')
  assert.deepEqual(cycles(graph), [])
})

test('the cycle check names a cycle and passes an acyclic graph', () => {
  assert.deepEqual(cycles(new Map([['a.ts', new Set(['b.ts'])], ['b.ts', new Set(['c.ts'])], ['c.ts', new Set(['a.ts'])], ['d.ts', new Set()]])), [['a.ts', 'b.ts', 'c.ts']])
  assert.deepEqual(cycles(new Map([['a.ts', new Set(['b.ts'])], ['b.ts', new Set()]])), [])
})
