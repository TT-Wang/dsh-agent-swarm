/**
 * RPC refusal-classification boundary guard (S3 repair, T3b).
 *
 * Typed PolicyError refusals carry an authored code/category separately from
 * presentation text. Legacy Error refusals still use the sanitizer's anchored
 * message allowlist: annotating those messages can downgrade a useful refusal
 * to internal-error. Inventory both paths without freezing their relative
 * counts as control paths migrate. Native RPC tests in web-api.test.mjs cover
 * exposure, translated prose, unsafe host detail, and forged error shapes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { PolicyError } from '../lib/policy-error.js'
import { errorTypeFor, TRACE_ERROR_TYPES } from '../lib/trace.js'
import { refusalSites } from './refusal-inventory.mjs'
import { sourceTree } from './source-semantics.mjs'

// M1a split the control path: the same inventory now spans the modules that
// received its refusal sites, covering both legacy and typed authored refusals.
const SOURCES = ['src/runtime.ts', 'src/workspaces.ts', 'src/attempts.ts', 'src/notices.ts', 'src/refusals.ts', 'src/gates.ts', 'src/declared-checks.ts', 'src/workspace-admission.ts', 'src/scheduling.ts']

function policySites(source, file) {
  const tree = sourceTree(source, file), sites = []
  const visit = node => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'PolicyError') {
      const args = node.arguments ?? []
      sites.push({
        location: `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`,
        arity: args.length,
        code: args[0] && ts.isStringLiteralLike(args[0]) ? args[0].text : undefined,
        category: args[1] && ts.isStringLiteralLike(args[1]) ? args[1].text : undefined,
        message: args[2] && ts.isStringLiteralLike(args[2]) ? args[2].text : undefined,
        expression: args[2]?.getText(tree),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return sites
}

/** Extract the regex literals of `actionableMessages` from the sanitizer source. */
function allowlistPatterns() {
  const source = readFileSync(new URL('../src/web-api.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const actionableMessages: readonly RegExp[] = [')
  const end = source.indexOf(']\n/** Host-derived detail', start)
  assert.ok(start !== -1 && end > start, 'the sanitizer allowlist is present and bounded')
  return [...source.slice(start, end).matchAll(/^\s*(\/(?:[^/\n\\]|\\.)+\/[a-z]*),?\s*$/gm)].map(match => {
    const literal = match[1]
    const last = literal.lastIndexOf('/')
    return new RegExp(literal.slice(1, last), literal.slice(last + 1))
  })
}

const ACTIONABLE = allowlistPatterns()
const classified = message => ACTIONABLE.some(pattern => pattern.test(message))

test('the sanitizer allowlist is extracted from the source and classifies the authored refusal', () => {
  assert.ok(ACTIONABLE.length > 0, 'the source allowlist must not be empty')
  assert.ok(classified('Task is not in this mission'), 'the cancel RPC refusal is RPC-actionable')
  assert.ok(!classified('[task_not_in_mission] Task is not in this mission. Correct `taskId` and retry.'),
    'the annotated form of that refusal is NOT classified: annotating it downgrades the RPC')
})

test('no refusal the sanitizer classifies carries a diagnostic prefix, and no annotated refusal is a template', () => {
  const conflicts = []
  let classifiedCount = 0
  for (const file of SOURCES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    for (const site of refusalSites(source, file)) {
      if (site.kind !== 'throw') continue
      const message = String(site.message ?? site.text ?? '')
      const annotated = site.codes.length > 0
      if (classified(message)) {
        classifiedCount++
        if (annotated) conflicts.push(`${file}:${site.line} ${site.codes.join(',')} is RPC-classified and must keep the allowlist's authored text: ${message.slice(0, 90)}`)
      }
      // A template's rendering cannot be proven against the allowlist: the
      // status/kind it interpolates may itself complete an anchored pattern.
      if (annotated && String(site.expression).trim().startsWith('`')) {
        conflicts.push(`${file}:${site.line} ${site.codes.join(',')} annotates a template message whose rendering the allowlist may own`)
      }
    }
  }
  assert.deepEqual(conflicts, [], `RPC-classified refusals must stay actionable:\n${conflicts.join('\n')}`)
  assert.ok(classifiedCount > 0, 'legacy refusals must still be exercised while their sanitizer path exists')
})

test('typed refusal sites retain authored codes, categories, and messages independently of legacy prose', () => {
  const fixture = policySites([
    "// new PolicyError('ignored', 'conflict_error', 'comment')",
    "throw new Error('legacy');",
    "throw new PolicyError('literal', 'conflict_error', 'Authored message');",
    "throw new PolicyError('template', 'validation_error', `${key} is invalid`);",
    "throw new PolicyError('computed', 'budget_error', reason);",
  ].join('\n'), 'fixture.ts')
  assert.deepEqual(fixture.map(site => site.code), ['literal', 'template', 'computed'])
  assert.equal(fixture[0].message, 'Authored message')
  assert.equal(fixture[1].expression, '`${key} is invalid`')
  assert.equal(fixture[2].expression, 'reason')

  const sites = SOURCES.flatMap(file => policySites(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), file))
  assert.ok(sites.length > 0, 'the typed control refusal path must be exercised')
  for (const site of sites) {
    assert.equal(site.arity, 3, `${site.location}: code, category, and message are explicit`)
    assert.match(site.code ?? '', /^[a-z][a-z0-9_]{0,79}$/, `${site.location}: stable public policy code`)
    assert.ok(TRACE_ERROR_TYPES.includes(site.category), `${site.location}: category belongs to the trace contract`)
    assert.ok(site.expression, `${site.location}: authored message expression is present`)
    if (site.message !== undefined) assert.ok(site.message.length > 0 && site.message.length <= 4000, `${site.location}: literal message fits the public RPC boundary`)
    const message = site.message ?? '当前状态需要更新后重试。'
    const refusal = new PolicyError(site.code, site.category, message)
    assert.equal(refusal.message, message, `${site.location}: authored prose is preserved`)
    assert.equal(refusal.code, site.code)
    assert.equal(errorTypeFor(refusal), site.category, `${site.location}: category does not depend on an English regex`)
    assert.equal(errorTypeFor(new PolicyError(site.code, site.category, '请按当前状态重试。')), site.category)
  }
})
