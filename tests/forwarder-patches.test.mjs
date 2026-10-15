/**
 * A test that patches a runtime method (`runtime.pumpOutbox = () => {}`)
 * intercepts every caller only while the runtime has that method. Once the
 * forwarder is deleted, the same assignment creates a property nothing calls,
 * and the test keeps passing for the wrong reason. Two checks close that:
 *  - every forwarder deleted from `SwarmRuntime` is listed with the seam field
 *    that owns the method now (none when the method itself is gone): a live
 *    runtime has no such member, the owning seam has it, and no test or script
 *    assigns the name on any receiver but that seam;
 *  - every member a test or script assigns on a receiver the suite names for a
 *    runtime (`runtime`, `f.runtime`, `rt`, `restored`) is a member of a live
 *    runtime, so deleting a forwarder that is still patched fails here even
 *    before the forwarder is listed.
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
  admissionDecision: 'refusals',
  admissionRecord: 'refusals',
  recordRefusal: 'refusals',
  upsertBudgetRefusals: 'refusals',
  upsertAdmission: 'refusals',
  recordWriterBusyRecovery: 'refusals',
  sweepSilentAttempts: 'scheduling',
  refuseProposal: null,
  dependencyUnfinished: null,
}
/** The names the suite gives a runtime (or a stub of one) whose members it patches. */
const RUNTIME_NAMES = new Set(['runtime', 'rt', 'restored'])

/** The last name of a receiver expression: `f.runtime.notices` -> notices, `rt` -> rt. */
const lastName = node => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined

/** Every `<receiver>.<name> = …` in one source: the member, the receiver's last name, and `file:line receiver.name`. */
function assignments(text, filename = 'probe.mjs') {
  const tree = sourceTree(text, filename), found = []
  const visit = node => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree))
      found.push({ name: node.left.name.text, receiver: lastName(node.left.expression), site: `${filename}:${line + 1} ${node.left.getText(tree)}` })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

/** The assignments of a deleted forwarder on any receiver but the seam that owns it. */
const strayPatches = found => found.filter(({ name, receiver }) => Object.hasOwn(DELETED_FORWARDERS, name) && receiver !== DELETED_FORWARDERS[name]).map(({ site }) => site)

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
  return files.flatMap(file => assignments(readFileSync(file, 'utf8'), relative(PROJECT, file)))
}

test('no test or script patches a deleted runtime forwarder: each patch targets the seam that owns the method', () => {
  const stray = strayPatches(sources())
  assert.deepEqual(stray, [], `a patch on a deleted forwarder intercepts nothing; patch the owning seam instead:\n${stray.join('\n')}`)
})

test('every runtime member a test patches exists on a live runtime, and a deleted forwarder is owned by its seam', async t => {
  const { runtime } = await makeRuntime(t)
  const missing = sources().filter(({ name, receiver }) => RUNTIME_NAMES.has(receiver) && !(name in runtime)).map(({ site }) => site)
  assert.deepEqual(missing, [], `a patch on a member the runtime does not have intercepts nothing:\n${missing.join('\n')}`)
  for (const [name, seam] of Object.entries(DELETED_FORWARDERS)) {
    assert.equal(name in runtime, false, `${name} is a runtime member again; remove it from the deleted list or delete it`)
    if (seam !== null) assert.equal(typeof runtime[seam][name], 'function', `runtime.${seam} owns ${name}`)
  }
})

test('the patch scan names a patch on a runtime and passes a patch on the owning seam', () => {
  const found = assignments([
    'runtime.pumpOutbox = () => {}',
    'f.runtime.pumpOutbox = () => {}',
    'f.runtime.notices.pumpOutbox = () => {}',
    'notices.pumpOutbox = () => {}',
    'rt.kick = () => {}',
    'rt.dependencyUnfinished = () => false',
    'if (runtime.pumpOutbox === undefined) {}',
  ].join('\n'))
  assert.deepEqual(strayPatches(found), ['probe.mjs:1 runtime.pumpOutbox', 'probe.mjs:2 f.runtime.pumpOutbox', 'probe.mjs:6 rt.dependencyUnfinished'])
  assert.deepEqual(found.filter(({ receiver }) => RUNTIME_NAMES.has(receiver)).map(({ name }) => name), ['pumpOutbox', 'pumpOutbox', 'kick', 'dependencyUnfinished'])
})
