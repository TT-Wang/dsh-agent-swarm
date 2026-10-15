/**
 * The src value-import graph has no strongly connected component: every module
 * a seam imports for a value sits below it. A type-only import (`import type`,
 * or a specifier list whose every name is `type`) is erased at build time and
 * is not an edge. The seams once formed one value cycle (attempts, notices,
 * scheduling, workspace-admission): each imported a pure helper or a pass
 * stamp from another, so no one of them could be built or read alone. The
 * helpers now live in leaves (`task-graph.ts`, `kernel.ts`, `scheduler.ts`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { sourceTree } from './source-semantics.mjs'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

/** Each src module and the local modules it imports a value from. */
function valueImports() {
  const files = []
  const walk = directory => { for (const entry of readdirSync(directory, { withFileTypes: true })) entry.isDirectory() ? walk(join(directory, entry.name)) : /\.tsx?$/.test(entry.name) && files.push(join(directory, entry.name)) }
  walk(SRC)
  const graph = new Map()
  for (const file of files) {
    const edges = new Set()
    for (const statement of sourceTree(readFileSync(file, 'utf8'), file).statements) {
      const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined
      const specifier = (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) ? statement.moduleSpecifier : undefined
      if (specifier === undefined || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue
      const value = ts.isImportDeclaration(statement)
        ? clause === undefined || (!clause.isTypeOnly && (clause.name !== undefined || clause.namedBindings === undefined || ts.isNamespaceImport(clause.namedBindings) || clause.namedBindings.elements.some(element => !element.isTypeOnly)))
        : !statement.isTypeOnly && (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause) || statement.exportClause.elements.some(element => !element.isTypeOnly))
      if (value) edges.add(relative(SRC, normalize(join(dirname(file), specifier.text))).replace(/\.js$/, '.ts'))
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

test('the src value-import graph has no cycle', () => {
  const graph = valueImports()
  assert.ok(graph.size > 30 && graph.get('notices.ts')?.has('task-graph.ts'), 'the scan reads the real src graph')
  assert.deepEqual(cycles(graph), [])
})

test('the cycle check names a cycle and passes an acyclic graph', () => {
  assert.deepEqual(cycles(new Map([['a.ts', new Set(['b.ts'])], ['b.ts', new Set(['c.ts'])], ['c.ts', new Set(['a.ts'])], ['d.ts', new Set()]])), [['a.ts', 'b.ts', 'c.ts']])
  assert.deepEqual(cycles(new Map([['a.ts', new Set(['b.ts'])], ['b.ts', new Set()]])), [])
})
