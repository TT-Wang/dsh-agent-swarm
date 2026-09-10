/**
 * S3 runtime half: the control-path refusals in `src/runtime.ts` and
 * `src/workspaces.ts` carry stable diagnostic codes and imperative next steps
 * whose named tool/parameter resolve in the real tool schema.
 *
 * The inventory itself is inherited from T2 (`tests/refusal-inventory.mjs`);
 * this test asserts the branch's own contribution:
 *  - every code this branch added is present exactly once and compliant;
 *  - the uncoded count on the two serialized files only shrinks (235 before this
 *    branch; the inherited lint's deferred report is the running inventory);
 *  - the inherited allowlist stays empty, so a stale exemption cannot appear.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { refusalSites, assessRefusal, diagnosticProducers, toolSchemaIndex, applyAllowlist, formatSite } from './refusal-inventory.mjs'

/** Codes this branch added, with the file they live in. */
const ANNOTATED = {
  'src/runtime.ts': [
    'owner_cannot_claim', 'evidence_tool_runs_required', 'invalid_evidence_outcome', 'supersede_foreign_evidence',
    'supersede_unrelated_evidence', 'verification_requires_verify', 'research_evidence_required', 'not_a_verification_task',
    'artifact_changed_during_verification', 'evidence_changed_during_verification',
  ],
  'src/workspaces.ts': [
    'workspace_not_repository_root', 'workspace_not_owned', 'verification_source_required', 'review_source_not_verification',
    'workspace_uncommitted', 'commits_unsubmitted', 'workspace_baseline_missing',
  ],
}
/** Uncoded refusal sites on these two files before this branch (measured on the merge baseline 34e8a20). */
const PRE_BRANCH_UNCODED = 235
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

test('S3: the uncoded refusal count on the serialized files only shrinks, and the allowlist stays empty', async () => {
  const index = await toolSchemaIndex()
  let uncoded = 0
  let total = 0
  const sitesByFile = {}
  for (const file of Object.keys(ANNOTATED)) {
    const sites = refusalSites(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), file)
    const producers = diagnosticProducers([sites])
    sitesByFile[file] = sites
    for (const site of sites) {
      total++
      if (assessRefusal(site, { ...index, diagnosticProducers: producers }).length) uncoded++
    }
  }
  assert.equal(total, 235, 'the two serialized files still expose every refusal site (186 + 49)')
  assert.ok(uncoded < PRE_BRANCH_UNCODED,
    `this branch must shrink the uncoded inventory (pre-branch ${PRE_BRANCH_UNCODED}, now ${uncoded})`)
  assert.equal(uncoded, PRE_BRANCH_UNCODED - Object.values(ANNOTATED).flat().length,
    'the shrink equals the number of codes this branch added')
  const applied = applyAllowlist([...sitesByFile['src/runtime.ts'], ...sitesByFile['src/workspaces.ts']], ALLOWLIST,
    site => assessRefusal(site, { ...index, diagnosticProducers: diagnosticProducers([sitesByFile[site.file] ?? []]) }))
  assert.deepEqual(applied.stale, [], 'the allowlist handed over by T2 is empty and stays empty')
})
