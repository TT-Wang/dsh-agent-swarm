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
import { constructorArguments, errorClasses, extendsClass, sourceErrorClasses, sourceTree } from './source-semantics.mjs'

// Every server source, not a hand list: M1a moved refusal sites between modules,
// and a list of nine files left admission.ts, plans.ts and model-selection.ts out.
const SOURCES = readdirSync(new URL('../src/', import.meta.url)).filter(file => file.endsWith('.ts')).sort().map(file => `src/${file}`)
/** The class declarations in src/, so a refusal class is matched by what it extends, never by a name list. */
const CLASSES = sourceErrorClasses()

const unwrap = node => { while (node && (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node))) node = node.expression; return node }

/**
 * Every construction of PolicyError or of a class that extends it. Code,
 * category and message are read where the class declarations put them
 * (`constructorArguments`): AdmissionError takes them as its first three
 * arguments like PolicyError, TaskGraphAdmissionError and
 * ObserveDetailRefusedError pass them to `super` themselves.
 */
function policySites(source, file, classes = CLASSES) {
  const tree = sourceTree(source, file), sites = []
  const visit = node => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && extendsClass(classes, node.expression.text, 'PolicyError')) {
      const args = node.arguments ?? [], slots = constructorArguments(classes, node.expression.text)
      const at = name => { const slot = slots.get(name); return slot === undefined ? undefined : slot.node ?? args[slot.index] }
      const [code, category, message] = ['code', 'category', 'message'].map(at)
      const literal = expression => { expression = unwrap(expression); return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined }
      sites.push({
        location: `${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`,
        errorClass: node.expression.text,
        codeNode: code, categoryNode: category, messageNode: message, diagnostics: at('diagnostics'),
        code: literal(code), category: literal(category), message: literal(message),
        expression: message?.getText(),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return sites
}

/**
 * Where a refusal's code comes from: each branch is a code literal, or — the
 * one computed form allowed — a `.code` read from a diagnostic the same refusal
 * carries in its `diagnostics` argument: an element of that array literal
 * (`new AdmissionError(absolute.code, …, [absolute])`) or an index into that
 * array (`diagnostics[0]!.code` with `diagnostics`). Undefined for any other
 * computed code, so a code can only be authored or copied from the diagnostic
 * the RPC boundary already exposes.
 */
function codeOrigins(code, diagnostics) {
  const node = unwrap(code)
  if (node === undefined) return undefined
  if (ts.isConditionalExpression(node)) {
    const [whenTrue, whenFalse] = [node.whenTrue, node.whenFalse].map(branch => codeOrigins(branch, diagnostics))
    return whenTrue && whenFalse && [...whenTrue, ...whenFalse]
  }
  if (ts.isStringLiteralLike(node)) return [{ literal: node.text }]
  const carried = unwrap(diagnostics)
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== 'code' || carried === undefined) return undefined
  const holder = unwrap(node.expression)
  const read = ts.isArrayLiteralExpression(carried)
    ? carried.elements.some(element => unwrap(element).getText() === holder.getText())
    : ts.isElementAccessExpression(holder) && unwrap(holder.expression).getText() === carried.getText()
  return read ? [{ diagnostic: holder.getText() }] : undefined
}

/**
 * The category literals an expression can take: a literal, a conditional, a
 * `const` binding in scope, an array literal's elements and `<array>.find(…)`
 * over one (plans.ts picks the aggregate category from CATEGORY_PRECEDENCE).
 * Undefined when any part is not traceable to literals.
 */
function categoryLiterals(expression) {
  const node = unwrap(expression)
  if (node === undefined) return undefined
  if (ts.isStringLiteralLike(node)) return [node.text]
  const all = parts => { const found = parts.map(categoryLiterals); return found.every(Boolean) ? found.flat() : undefined }
  if (ts.isConditionalExpression(node)) return all([node.whenTrue, node.whenFalse])
  if (ts.isArrayLiteralExpression(node)) return all([...node.elements])
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'find') return categoryLiterals(node.expression.expression)
  if (!ts.isIdentifier(node)) return undefined
  for (let scope = node.parent; scope; scope = scope.parent) {
    for (const statement of scope.statements ?? []) {
      if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue
      const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === node.text)
      if (declaration?.initializer) return categoryLiterals(declaration.initializer)
    }
  }
  return undefined
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
  const source = [
    "// new PolicyError('ignored', 'conflict_error', 'comment')",
    "throw new Error('legacy');",
    "throw new PolicyError('literal', 'conflict_error', 'Authored message');",
    "throw new PolicyError('template', 'validation_error', `${key} is invalid`);",
    "throw new PolicyError('computed', 'budget_error', reason);",
    "throw new AdmissionError('admitted', 'budget_error', 'Admission message', 'plan');",
    "throw new AdmissionError(absolute.code, 'validation_error', formatDiagnostic(absolute), absolute.location, [absolute]);",
    "throw new AdmissionError(diagnostics.length === 1 ? diagnostics[0]!.code : 'plan_invalid', category, joined, 'plan', diagnostics);",
    "throw new AdmissionError(other.code, 'validation_error', 'uncarried', 'plan', [absolute]);",
    "throw new PolicyError(absolute.code, 'tool_error', 'no diagnostics argument');",
    'class FixedRefusal extends PolicyError { constructor(readonly taskId: string) { super(\'fixed_code\', \'lease_error\', `task ${taskId} is fixed`) } }',
    "throw new FixedRefusal(id);",
    "class Forwarding extends AdmissionError {}",
    "throw new Forwarding('forwarded', 'conflict_error', 'Forwarded message', 'task');",
  ].join('\n')
  const fixture = policySites(source, 'fixture.ts', new Map([...CLASSES, ...errorClasses([{ text: source, filename: 'fixture.ts' }])]))
  assert.deepEqual(fixture.map(site => [site.errorClass, site.code, site.category]), [
    ['PolicyError', 'literal', 'conflict_error'], ['PolicyError', 'template', 'validation_error'], ['PolicyError', 'computed', 'budget_error'],
    ['AdmissionError', 'admitted', 'budget_error'], ['AdmissionError', undefined, 'validation_error'], ['AdmissionError', undefined, undefined],
    ['AdmissionError', undefined, 'validation_error'], ['PolicyError', undefined, 'tool_error'],
    ['FixedRefusal', 'fixed_code', 'lease_error'], ['Forwarding', 'forwarded', 'conflict_error'],
  ], 'every class that extends PolicyError is read at its declared argument positions, and a comment is not a site')
  assert.equal(fixture[0].message, 'Authored message')
  assert.equal(fixture[1].expression, '`${key} is invalid`')
  assert.equal(fixture[2].expression, 'reason')
  assert.equal(fixture[3].message, 'Admission message')
  assert.equal(fixture[8].expression, '`task ${taskId} is fixed`', 'a message the class passes to super is read from the class')
  assert.equal(fixture[9].message, 'Forwarded message', 'a class without a constructor takes its parent\'s positions')
  // A computed code is allowed only when it is read from a diagnostic the refusal carries.
  assert.deepEqual(codeOrigins(fixture[4].codeNode, fixture[4].diagnostics), [{ diagnostic: 'absolute' }])
  assert.deepEqual(codeOrigins(fixture[5].codeNode, fixture[5].diagnostics), [{ diagnostic: 'diagnostics[0]' }, { literal: 'plan_invalid' }])
  assert.equal(codeOrigins(fixture[6].codeNode, fixture[6].diagnostics), undefined, 'a diagnostic the refusal does not carry')
  assert.equal(codeOrigins(fixture[7].codeNode, fixture[7].diagnostics), undefined, 'a refusal with no diagnostics argument')

  const family = [...CLASSES.keys()].filter(name => extendsClass(CLASSES, name, 'PolicyError'))
  for (const name of ['PolicyError', 'AdmissionError', 'TaskGraphAdmissionError', 'ObserveDetailRefusedError']) assert.ok(family.includes(name), `${name} is in the PolicyError family`)
  const sitesByFile = SOURCES.map(file => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), found = policySites(text, file)
    const raw = [...text.matchAll(new RegExp(`\\bnew (?:${family.join('|')})\\(`, 'g'))].length
    assert.equal(found.length, raw, `${file}: every construction of a PolicyError class is walked (${found.length}/${raw})`)
    return found
  })
  const sites = sitesByFile.flat()
  const walked = new Set(sites.map(site => `${site.location.replace(/:\d+$/, '')} ${site.errorClass}`))
  for (const expected of ['src/admission.ts AdmissionError', 'src/plans.ts AdmissionError', 'src/model-selection.ts PolicyError', 'src/runtime.ts TaskGraphAdmissionError', 'src/runtime.ts ObserveDetailRefusedError']) {
    assert.ok(walked.has(expected), `${expected} refusals are checked`)
  }
  for (const site of sites) {
    assert.ok(site.codeNode && site.categoryNode && site.messageNode, `${site.location}: code, category, and message are explicit`)
    const codes = codeOrigins(site.codeNode, site.diagnostics)
    assert.ok(codes, `${site.location}: code ${site.codeNode.getText()} is a literal or read from a diagnostic the refusal carries`)
    const literals = codes.flatMap(origin => origin.literal ?? [])
    for (const code of literals) assert.match(code, /^[a-z][a-z0-9_]{0,79}$/, `${site.location}: stable public policy code`)
    const categories = categoryLiterals(site.categoryNode)
    assert.ok(categories?.length > 0, `${site.location}: category ${site.categoryNode.getText()} resolves to authored literals`)
    for (const category of categories) assert.ok(TRACE_ERROR_TYPES.includes(category), `${site.location}: category ${category} belongs to the trace contract`)
    assert.ok(site.expression, `${site.location}: authored message expression is present`)
    if (site.message !== undefined) assert.ok(site.message.length > 0 && site.message.length <= 4000, `${site.location}: literal message fits the public RPC boundary`)
    const message = site.message ?? '当前状态需要更新后重试。'
    // A code copied from a diagnostic is that diagnostic's token; a stable stand-in exercises the type.
    for (const code of literals.length === codes.length ? literals : [...literals, 'diagnostic_code']) for (const category of categories) {
      const refusal = new PolicyError(code, category, message)
      assert.equal(refusal.message, message, `${site.location}: authored prose is preserved`)
      assert.equal(refusal.code, code)
      assert.equal(errorTypeFor(refusal), category, `${site.location}: category does not depend on an English regex`)
      assert.equal(errorTypeFor(new PolicyError(code, category, '请按当前状态重试。')), category)
    }
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
