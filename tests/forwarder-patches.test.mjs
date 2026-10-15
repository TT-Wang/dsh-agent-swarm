/**
 * A test that patches a member through a runtime (`runtime.kick = …`,
 * `f.runtime.notices.pumpOutbox = …`, or `scheduling.closePass = …` with
 * `scheduling` read off a runtime) intercepts its callers only while the object
 * that path reaches has that member. Once a forwarder is deleted, or a method
 * leaves its seam, the same assignment creates a property nothing reads, and
 * the test keeps passing for the wrong reason. So every assignment in tests/
 * and scripts/ whose receiver is a property path from a runtime is resolved on
 * a live runtime, and the member must exist on the object the path reaches.
 * A path that reaches no object on a live runtime is not checked: assigning
 * through it throws when the test runs, so it cannot pass silently.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { sourceTree } from './source-semantics.mjs'
import { makeRuntime } from './faults/harness.mjs'

const PROJECT = fileURLToPath(new URL('../', import.meta.url))

/** The names the suite gives a runtime (or a stub of one) whose members it patches. */
const RUNTIME_NAMES = new Set(['runtime', 'rt', 'restored'])

/** The initializer of the nearest `const|let <name> = …` in the blocks around `node`; none past a parameter of that name. */
function initializerOf(name, node) {
  for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters.some(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === name)) return undefined
    for (const statement of scope.statements ?? []) {
      if (!ts.isVariableStatement(statement)) continue
      const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name)
      if (declaration !== undefined) return declaration.initializer
    }
  }
  return undefined
}

/** The property path from a runtime a receiver names (`f.runtime.notices` -> ['notices']), or undefined when it names none. */
function runtimePath(node) {
  if (ts.isPropertyAccessExpression(node)) {
    if (RUNTIME_NAMES.has(node.name.text)) return []
    const path = runtimePath(node.expression)
    return path === undefined ? undefined : [...path, node.name.text]
  }
  if (!ts.isIdentifier(node)) return undefined
  if (RUNTIME_NAMES.has(node.text)) return []
  const initializer = initializerOf(node.text, node)
  return initializer === undefined ? undefined : runtimePath(initializer)
}

/** Every `<receiver>.<member> = …` in one source whose receiver is a path from a runtime, with `file:line receiver.member`. */
function runtimeAssignments(text, filename = 'probe.mjs') {
  const tree = sourceTree(text, filename), found = []
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const path = runtimePath(node.left.expression)
      if (path !== undefined) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree))
        found.push({ path, member: node.left.name.text, site: `${filename}:${line + 1} ${node.left.getText(tree)}` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

/** The sites whose path reaches an object on `runtime` that lacks the assigned member. */
function unpatched(runtime, found) {
  return found.filter(({ path, member }) => {
    const target = path.reduce((object, key) => object?.[key], runtime)
    return (typeof target === 'object' || typeof target === 'function') && target !== null && !(member in target)
  }).map(({ site }) => site)
}

function sources() {
  const files = []
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (entry.name !== 'fixtures' && entry.name !== 'node_modules') walk(join(directory, entry.name)) }
      else if (/\.m?js$/.test(entry.name)) files.push(join(directory, entry.name))
    }
  }
  walk(join(PROJECT, 'tests'))
  walk(join(PROJECT, 'scripts'))
  return files.flatMap(file => runtimeAssignments(readFileSync(file, 'utf8'), relative(PROJECT, file)))
}

test('every member a test or script assigns through a runtime exists on the object that path reaches on a live runtime', async t => {
  const { runtime } = await makeRuntime(t)
  const missing = unpatched(runtime, sources())
  assert.deepEqual(missing, [], `a patch on a member its object does not have intercepts nothing; patch the object that owns it:\n${missing.join('\n')}`)
})

test('the scan resolves paths through a runtime and its seams, and names a member the reached object lacks', async t => {
  const { runtime } = await makeRuntime(t)
  const found = runtimeAssignments([
    'runtime.pumpOutbox = () => {}',
    'f.runtime.notices.pumpOutbox = () => {}',
    'rt.scheduling.escalateGuardTerminal = () => {}',
    'const scheduling = f.runtime.scheduling',
    'scheduling.closePass = () => {}',
    'function hand(scheduling) { scheduling.gone = () => {} }',
    'restored.attempt.ownerId = "member"',
    'const notices = f.runtime.store.list("deliveries")',
    'notices.extra = 1',
  ].join('\n'))
  assert.deepEqual(found.map(({ path, member }) => [...path, member].join('.')),
    ['pumpOutbox', 'notices.pumpOutbox', 'scheduling.escalateGuardTerminal', 'scheduling.closePass', 'attempt.ownerId'],
    'a seam read into a local is a path from the runtime; a parameter or a value a call returned is not')
  assert.deepEqual(unpatched(runtime, found), ['probe.mjs:1 runtime.pumpOutbox', 'probe.mjs:3 rt.scheduling.escalateGuardTerminal'],
    'a deleted runtime forwarder and a method its seam lost are named; a path that reaches nothing throws when it runs')
})
