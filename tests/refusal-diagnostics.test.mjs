/**
 * S3 lint (T2): the refusal inventory of the tool and admission surface is
 * walked from the sources, and every refusal it finds must carry a stable
 * `[diagnostic_code]` and an imperative next step whose named tool and
 * parameter resolve in the schema the production registration path installs.
 *
 * Why it is mechanical: `refusalSites` (tests/refusal-inventory.mjs) enumerates
 * every `throw new Error(...)` message and every object literal carrying
 * `code` + `message`/`reason`; the throw count is cross-checked against the raw
 * `throw new Error(` count, and every `code:` literal must be either covered by
 * a message site or a classification marker, so a new refusal cannot be added
 * without appearing here. The schema index is captured by calling the real
 * `registerTools` with a recording context — never by hand-listing properties.
 *
 * The motivating defect: the durable `task_ceiling_exhausted` refusal told the
 * owner to raise a task's ceiling while `swarm_propose` exposed no `maxSteps` or
 * `maxFindings`, so the only executable half of the advice was "replace the
 * task". This test fails on that head: the message names `maxSteps`, which no
 * tool schema declared.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  refusalSites, assessRefusal, diagnosticProducers, toolSchemaIndex, applyAllowlist,
  uncoveredCodeLiterals, formatSite, DELEGATED_MESSAGES,
} from './refusal-inventory.mjs'
import { formatDiagnostic } from '../lib/admission.js'
import { workspaceAuthorizationDiagnostic } from '../lib/authorization.js'

const IN_SCOPE_SOURCES = ['src/tools.ts', 'src/admission.ts']
/**
 * S3's acceptance is an empty allowlist. The mechanism exists for the refusal
 * sites this branch may not edit (the runtime/workspace paths), and the
 * serialized T3 task drives that deferred list to empty; those sites are
 * reported by the last test from live source, not pinned here by line, because
 * T1 and T3 edit those files in parallel and a hard-coded line would go stale.
 */
const ALLOWLIST = []

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')

async function inventory() {
  const index = await toolSchemaIndex()
  index.probes = {
    workspaceAuthorizationDiagnostic: () => workspaceAuthorizationDiagnostic('probe', { grants: [], loadedAt: 0, unresolved: [] }),
    // The declared composer of the missing-review exit must really carry it.
    reviewPathExit: () => /swarm_propose[\s\S]{0,400}reviewOf/.test(read('src/runtime.ts')),
  }
  const sitesByFile = IN_SCOPE_SOURCES.map(file => refusalSites(read(file), file))
  index.diagnosticProducers = diagnosticProducers(sitesByFile)
  return { index, sitesByFile, sites: sitesByFile.flat() }
}

const assess = (site, index) => assessRefusal(site, { ...index, diagnosticProducers: index.diagnosticProducers })

test('the inventory walks every refusal in the tool and admission surface, not a hand-picked sample', async () => {
  const { sitesByFile, sites } = await inventory()
  assert.deepEqual(sitesByFile.map(group => group.length > 0), [true, true], 'both surfaces produce refusals')
  assert.ok(sites.length >= 20, `the inventory must be the full set, found ${sites.length}`)
  for (const [index, file] of IN_SCOPE_SOURCES.entries()) {
    const source = read(file)
    const rawThrows = [...source.matchAll(/throw new Error\(/g)].length
    const found = sitesByFile[index].filter(site => site.kind === 'throw').length
    assert.equal(found, rawThrows, `${file}: every throw call site is inventoried (${found}/${rawThrows})`)
    const uncovered = uncoveredCodeLiterals(source, sitesByFile[index])
    for (const entry of uncovered) {
      const classificationMarker = entry.keys.includes('runnable') || entry.keys.includes('requirement')
      assert.ok(classificationMarker || entry.optional,
        `${file}:${entry.line} code literal ${entry.code} carries a message/reason but was not inventoried; make it a message site`)
    }
  }
  // The durable ceiling reason is the motivating refusal; it must be in the walk.
  assert.ok(sites.some(site => site.code === 'task_ceiling_exhausted'), 'the durable ceiling refusal is inventoried')
})

test('every in-scope refusal is coded and its next step names a parameter that resolves in the tool schema', async () => {
  const { index, sites } = await inventory()
  const failures = []
  for (const site of sites) {
    const violations = assess(site, index)
    if (violations.length) failures.push(`${formatSite(site)}: ${violations.join('; ')}`)
  }
  assert.deepEqual(failures, [], `refusals must carry a code and an executable exit:\n${failures.join('\n')}`)
  const applied = applyAllowlist(sites, ALLOWLIST, site => assess(site, index))
  assert.deepEqual(applied.stale, [], 'the allowlist has no stale entry')
  assert.equal(applied.checked.length, sites.length, 'nothing is exempted: the allowlist is empty')
})

test('the motivating refusal names maxSteps and maxFindings, which resolve on swarm_propose', async () => {
  const { index, sites } = await inventory()
  const ceiling = sites.find(site => site.code === 'task_ceiling_exhausted')
  assert.ok(ceiling, 'the ceiling refusal is inventoried')
  assert.deepEqual(ceiling.tools, ['swarm_propose'])
  for (const parameter of ['replaces', 'maxSteps', 'maxFindings']) {
    assert.ok(ceiling.params.includes(parameter), `the ceiling exit names ${parameter}`)
    assert.ok(index.ownProperties.get('swarm_propose').has(parameter), `swarm_propose declares ${parameter}`)
  }
  // Both plan entry points expose the same per-task ceilings.
  for (const name of ['swarm_propose', 'swarm_stage', 'swarm_launch']) {
    const properties = name === 'swarm_propose' ? index.definitions.get(name).parameters.properties : index.definitions.get(name).parameters.properties.tasks.items.properties
    for (const parameter of ['maxSteps', 'maxFindings']) {
      assert.equal(properties[parameter].type, 'integer', `${name} exposes ${parameter} to the model`)
    }
  }
})

test('the allowlist can only shrink: an entry whose refusal is already compliant fails, and a real one is honoured', async () => {
  const { index, sites } = await inventory()
  const compliant = sites[0]
  const staleCompliant = applyAllowlist(sites, [{ file: compliant.file, line: compliant.line, reason: 'stale' }], site => assess(site, index))
  assert.equal(staleCompliant.stale.length, 1)
  assert.match(staleCompliant.stale[0].reason, /already coded and actionable/)
  assert.equal(staleCompliant.checked.length, sites.length, 'a stale entry exempts nothing')

  const missing = applyAllowlist(sites, [{ file: 'src/tools.ts', line: 999999, reason: 'gone' }], site => assess(site, index))
  assert.match(missing.stale[0].reason, /no refusal site/)

  // An uncoded fixture site is the only thing an entry may exempt.
  const fixture = refusalSites(`export function f() {\n  throw new Error('plain refusal without a code')\n}\n`, 'src/fixture.ts')
  const fixtureIndex = { ...index, diagnosticProducers: new Set() }
  const honoured = applyAllowlist(fixture, [{ file: 'src/fixture.ts', line: fixture[0].line, reason: 'deferred' }], site => assess(site, fixtureIndex))
  assert.equal(honoured.stale.length, 0)
  assert.equal(honoured.checked.length, 0)
  assert.ok(assess(fixture[0], fixtureIndex).length > 0, 'the deferred fixture really is uncoded')

  assert.equal(ALLOWLIST.length, 0, 'S3 delivers an empty allowlist')
})

test('the lint fails the pre-fix ceiling advice and other non-executable exits', async () => {
  const { index } = await inventory()
  const probe = async body => {
    const sites = refusalSites(`export function probe() {\n  ${body}\n}\n`, 'src/probe.ts')
    assert.equal(sites.length, 1, 'the fixture has exactly one refusal site')
    return assess(sites[0], { ...index, diagnosticProducers: new Set() })
  }
  // The pre-fix durable message: coded but with no parameter-bearing next step.
  const prefix = await probe("throw new Error('[task_ceiling_exhausted] Task ceiling exhausted: maxSteps 150/150. Raise this task\\'s ceiling or replace the task.')")
  assert.ok(prefix.some(violation => /names no parameter/.test(violation)), `pre-fix ceiling advice must fail: ${prefix.join('; ')}`)
  // Advice that names a parameter no tool schema declares.
  const phantom = await probe("throw new Error('[probe_code] Retry the same request with `maxStepsCeiling` set to a lower value.')")
  assert.ok(phantom.some(violation => /no registered tool schema declares/.test(violation)), phantom.join('; '))
  // Advice that names a tool without naming one of its parameters.
  const toolOnly = await probe("throw new Error('[probe_code] Retry with `swarm_propose` after correcting the request.')")
  assert.ok(toolOnly.some(violation => /without naming one of its parameters/.test(violation)), toolOnly.join('; '))
  // Advice that names a tool that does not exist.
  const unknownTool = await probe("throw new Error('[probe_code] Retry with `swarm_nonexistent` and `missionId`.')")
  assert.ok(unknownTool.some(violation => /unknown tool/.test(violation)), unknownTool.join('; '))
  // A refusal without a stable code.
  const uncoded = await probe("throw new Error('Correct `checks` and retry the same request.')")
  assert.ok(uncoded.some(violation => /no \[diagnostic_code\]/.test(violation)), uncoded.join('; '))
})

test('the code the throw renderer prefixes is the diagnostic code itself', () => {
  const rendered = formatDiagnostic({ code: 'probe_code', location: 'task "t"', message: 'message body' })
  assert.match(rendered, /^\[probe_code\] task "t": message body$/)
  for (const entry of DELEGATED_MESSAGES) assert.ok(entry.authoredIn.endsWith('.ts'), 'a delegate names the file that authors its message')
})

test('refusals outside this branch are inventoried through the same helper and reported, never pinned by line', async t => {
  const { index } = await inventory()
  const deferredSources = ['src/runtime.ts', 'src/workspaces.ts', 'src/authorization.ts', 'src/plans.ts', 'src/planner.ts', 'src/store.ts', 'src/web-api.ts']
  let total = 0
  let uncoded = 0
  for (const file of deferredSources) {
    const source = read(file)
    const sites = refusalSites(source, file)
    assert.ok(sites.length > 0, `${file}: the shared helper enumerates its refusals`)
    const rawThrows = [...source.matchAll(/throw new Error\(/g)].length
    assert.equal(sites.filter(site => site.kind === 'throw').length, rawThrows,
      `${file}: every throw call site is inventoried (${sites.filter(site => site.kind === 'throw').length}/${rawThrows})`)
    const producers = diagnosticProducers([sites])
    for (const site of sites) {
      total++
      if (assess(site, { ...index, diagnosticProducers: producers }).length) uncoded++
    }
  }
  assert.ok(total >= 280, `the shared helper covers the runtime and workspace surfaces (${total} sites)`)
  // No count assertion: the serialized T3 branch annotates these files and
  // drives the deferred count to zero, and this test must stay green on the
  // assembled artifact. The count is reported for that task's inventory.
  t.diagnostic(`deferred refusal inventory: ${total} refusal sites in ${deferredSources.length} out-of-scope files, ${uncoded} not yet coded`)
})
