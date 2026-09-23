/**
 * RPC refusal-classification boundary guard (S3 repair, T3b).
 *
 * Typed PolicyError refusals carry an authored code/category separately from
 * presentation text, and the RPC boundary decides what the browser sees by that
 * type alone: the English message allowlist it used to match is gone. Native
 * RPC tests in web-api.test.mjs and web-api-sanitize.test.mjs cover exposure,
 * translated prose, unsafe host detail, forged error shapes and plain Errors
 * whose text matches a retired pattern.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { PolicyError } from '../lib/policy-error.js'
import { AdmissionError, TaskGraphAdmissionError } from '../lib/admission.js'
import { errorTypeFor, TRACE_ERROR_TYPES } from '../lib/trace.js'
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

test('the RPC boundary decides visibility by type: no message allowlist, one scrub-exempt flag', () => {
  const file = 'src/web-api.ts'
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  assert.doesNotMatch(source, /actionableMessages|actionableMessage\b/, 'no English message pattern grants browser visibility')
  const tree = sourceTree(source, file), calls = []
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'exposed') {
      calls.push({ line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, flag: node.arguments[1]?.getText(tree), operation: node.arguments[0].getText(tree) })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  assert.ok(calls.length >= 10, 'the collaborator calls are wrapped')
  for (const call of calls) assert.ok(call.flag === undefined || call.flag === 'true', `${file}:${call.line} passes only the boolean scrub-exempt flag`)
  // Only the two validators that echo the caller's own input are scrub-exempt.
  assert.deepEqual(calls.filter(call => call.flag === 'true').map(call => /validatePlan|workerModelSelection/.exec(call.operation)?.[0]).sort(), ['validatePlan', 'workerModelSelection'])
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

test('a refusal code is typed with one category wherever it is raised', () => {
  const sites = []
  for (const file of readdirSync(new URL('../src/', import.meta.url)).filter(name => name.endsWith('.ts')).map(name => `src/${name}`)) {
    const tree = sourceTree(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), file)
    const visit = node => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && ['PolicyError', 'AdmissionError'].includes(node.expression.text)) {
        const [code, category] = node.arguments ?? []
        if (code && category && ts.isStringLiteralLike(code) && ts.isStringLiteralLike(category)) {
          sites.push({ code: code.text, category: category.text, location: `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}` })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  assert.ok(sites.length > 100, `the typed refusal sites are walked (found ${sites.length})`)
  const categories = new Map()
  for (const site of sites) categories.set(site.code, [...(categories.get(site.code) ?? []), site])
  const split = [...categories].filter(([, found]) => new Set(found.map(site => site.category)).size > 1)
    .map(([code, found]) => `${code}: ${found.map(site => `${site.category} at ${site.location}`).join(', ')}`)
  assert.deepEqual(split, [], 'a caller branching on the code sees one category')
})

test('a typed refusal is recorded exactly as the plain Error it was typed from', () => {
  // Automatic request reasons, draft launch failures and guard-terminal details
  // store String(error), and the planner's recovery notice quotes the reason to
  // the model, so typing a refusal must not change that rendering.
  assert.equal(String(new PolicyError('mission_not_active', 'tool_error', 'Mission is paused')), 'Error: Mission is paused')
  assert.equal(`${new AdmissionError('plan_text_invalid', 'validation_error', 'Title must be nonempty text of at most 16000 characters', 'Title')}`,
    'Error: Title must be nonempty text of at most 16000 characters')
  assert.equal(errorTypeFor(new PolicyError('mission_not_active', 'tool_error', 'Mission is paused')), errorTypeFor(new Error('Mission is paused')),
    'a text the classifier left as tool_error keeps that trace category once typed')
  // A class that carried its own name before it was typed keeps it.
  const graph = new TaskGraphAdmissionError([{ code: 'task_graph_self_edge', taskId: 'a', target: 'a', message: 'task "a" declares an edge to itself.' }])
  assert.equal(String(graph), `TaskGraphAdmissionError: ${graph.message}`)
})
