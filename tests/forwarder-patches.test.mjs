/**
 * A test that patches a runtime method (`runtime.pumpOutbox = () => {}`)
 * intercepts every caller only while the runtime has that method. Once the
 * forwarder is deleted, the same assignment creates a property nothing calls,
 * and the test keeps passing for the wrong reason. Every forwarder deleted from
 * `SwarmRuntime` is listed here with the seam field that owns the method now
 * (none when the method itself is gone): a live runtime has no such member, the
 * owning seam has it, and no test or script assigns the name on any receiver
 * but that seam.
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

/** Deleted runtime forwarder -> the runtime field of the seam that owns the method, or null when nothing does. */
const DELETED_FORWARDERS = {
  pumpOutbox: 'notices',
  upsertAdmission: 'refusals',
  recordWriterBusyRecovery: 'refusals',
  sweepSilentAttempts: 'scheduling',
  dependencyUnfinished: null,
}

/** The last name of a receiver expression: `f.runtime.notices` -> notices, `rt` -> rt. */
const lastName = node => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined

/** Every `<receiver>.<deleted forwarder> = …` whose receiver is not the owning seam, as `file:line receiver.name`. */
function strayPatches(text, filename = 'probe.mjs') {
  const tree = sourceTree(text, filename), found = []
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const name = node.left.name.text
      if (Object.hasOwn(DELETED_FORWARDERS, name) && lastName(node.left.expression) !== DELETED_FORWARDERS[name]) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree))
        found.push(`${filename}:${line + 1} ${node.left.getText(tree)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
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
  return files
}

test('no test or script patches a deleted runtime forwarder: each patch targets the seam that owns the method', () => {
  const stray = sources().flatMap(file => strayPatches(readFileSync(file, 'utf8'), relative(PROJECT, file)))
  assert.deepEqual(stray, [], `a patch on a deleted forwarder intercepts nothing; patch the owning seam instead:\n${stray.join('\n')}`)
})

test('a deleted forwarder is absent from a live runtime, and the seam that owns it has the method', async t => {
  const { runtime } = await makeRuntime(t)
  for (const [name, seam] of Object.entries(DELETED_FORWARDERS)) {
    assert.equal(name in runtime, false, `${name} is a runtime member again; remove it from the deleted list or delete it`)
    if (seam !== null) assert.equal(typeof runtime[seam][name], 'function', `runtime.${seam} owns ${name}`)
  }
})

test('the patch scan names a patch on a runtime and passes a patch on the owning seam', () => {
  assert.deepEqual(strayPatches([
    'runtime.pumpOutbox = () => {}',
    'f.runtime.pumpOutbox = () => {}',
    'f.runtime.notices.pumpOutbox = () => {}',
    'notices.pumpOutbox = () => {}',
    'rt.kick = () => {}',
    'rt.dependencyUnfinished = () => false',
    'if (runtime.pumpOutbox === undefined) {}',
  ].join('\n')), ['probe.mjs:1 runtime.pumpOutbox', 'probe.mjs:2 f.runtime.pumpOutbox', 'probe.mjs:6 rt.dependencyUnfinished'])
})
