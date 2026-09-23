/**
 * S3 runtime half: the control-path refusals in `src/runtime.ts` and
 * `src/workspaces.ts` carry stable diagnostic codes and imperative next steps
 * whose named tool/parameter resolve in the real tool schema.
 *
 * The inventory itself is inherited from T2 (`tests/refusal-inventory.mjs`);
 * this test asserts the branch's own contribution:
 *  - every code this branch added is present exactly once and compliant;
 *  - every current control-path file is scanned, without freezing historical
 *    implementation counts or conflating host lifecycle errors with model exits;
 *  - the inherited allowlist stays empty, so a stale exemption cannot appear;
 *  - a refusal thrown through a coded Error subclass stays in the inventory.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { refusalSites, assessRefusal, diagnosticProducers, toolSchemaIndex, applyAllowlist, formatSite } from './refusal-inventory.mjs'

/** Codes this branch added, with the file they live in. */
const ANNOTATED = {
  'src/runtime.ts': [
    // invalid_evidence_outcome left with the runtime check: swarm_publish's
    // schema enum refuses an unknown outcome as [tool_arguments_invalid].
    'owner_cannot_claim', 'evidence_tool_runs_required', 'supersede_foreign_evidence',
    'supersede_unrelated_evidence', 'verification_requires_verify', 'research_evidence_required', 'not_a_verification_task',
    'artifact_changed_during_verification', 'evidence_changed_during_verification',
    // L0-L2 owner-reply receipts: every refusal names the id to pass instead.
    'reply_target_required', 'unknown_reply_target', 'reply_target_not_question', 'reply_target_not_recipient',
  ],
  'src/workspaces.ts': [
    'workspace_not_repository_root', 'workspace_not_owned', 'verification_source_required', 'review_source_not_verification',
    'workspace_uncommitted', 'workspace_baseline_missing',
  ],
}
/**
 * Codes thrown through an Error subclass that takes the code as its first
 * argument (R19-H2 moved these two out of `throw new Error('[code] …')`). They
 * are pinned by presence: the inventory must still walk them, whether or not
 * their next step yet satisfies the parameter contract.
 */
const CODED_CLASS_REFUSALS = {
  'src/workspaces.ts': ['dependency_directory_unavailable', 'dependency_copy_escape'],
}
/** Enumerate the whole split control path; named diagnostic contracts below are stable across added lifecycle guards. */
const INVENTORY_SOURCES = [...Object.keys(ANNOTATED), 'src/attempts.ts', 'src/notices.ts', 'src/refusals.ts', 'src/gates.ts', 'src/declared-checks.ts', 'src/workspace-admission.ts', 'src/scheduling.ts']
const ALLOWLIST = []

test('S3: every refusal code this branch added is present exactly once and compliant', async () => {
  const index = await toolSchemaIndex()
  const failures = []
  const seen = new Set()
  for (const [file, codes] of Object.entries(ANNOTATED)) {
    const sites = refusalSites(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), file)
    const producers = diagnosticProducers([sites])
    for (const code of codes) {
      const matches = sites.filter(site => site.codes.includes(code))
      if (matches.length !== 1) { failures.push(`${file}: ${code} appears ${matches.length} time(s), expected exactly one`); continue }
      seen.add(code)
      const violations = assessRefusal(matches[0], { ...index, diagnosticProducers: producers })
      if (violations.length) failures.push(`${formatSite(matches[0])}: ${violations.join('; ')}`)
    }
  }
  assert.deepEqual(failures, [], `annotated refusals must carry a code and an executable exit:\n${failures.join('\n')}`)
  assert.equal(seen.size, Object.values(ANNOTATED).flat().length, 'every declared code was found')
})

test('S3: the split control path is fully scanned and no diagnostic is exempted by an allowlist', async () => {
  const index = await toolSchemaIndex()
  const sitesByFile = Object.fromEntries(INVENTORY_SOURCES.map(file => [file,
    refusalSites(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), file)]))
  for (const file of ['src/runtime.ts', 'src/workspaces.ts', 'src/attempts.ts', 'src/refusals.ts']) {
    assert.ok(sitesByFile[file].length > 0, `${file}: the source scanner must inspect this live control path`)
  }
  const sites = Object.values(sitesByFile).flat()
  const applied = applyAllowlist(sites, ALLOWLIST,
    site => assessRefusal(site, { ...index, diagnosticProducers: diagnosticProducers([sitesByFile[site.file] ?? []]) }))
  assert.deepEqual(applied.stale, [], 'no stale exemption may hide a regression')
  assert.equal(applied.checked.length, sites.length, 'every current site is assessed without exemptions')
  assert.deepEqual(ALLOWLIST, [])
})

test('S3: a refusal thrown through a coded Error subclass stays in the inventory', () => {
  for (const [file, codes] of Object.entries(CODED_CLASS_REFUSALS)) {
    const sites = refusalSites(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), file)
    for (const code of codes) {
      const matches = sites.filter(site => site.kind === 'coded-throw' && site.code === code)
      assert.equal(matches.length, 1, `${file}: ${code} is inventoried exactly once through its error class`)
      assert.deepEqual(matches[0].codes, [code], 'the class renders the code token the site declares')
    }
  }
})
