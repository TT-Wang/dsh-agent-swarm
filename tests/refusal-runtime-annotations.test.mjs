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
    // L0-L2 owner-reply receipts: every refusal names the id to pass instead.
    'reply_target_required', 'unknown_reply_target', 'reply_target_not_question', 'reply_target_not_recipient',
  ],
  'src/workspaces.ts': [
    'workspace_not_repository_root', 'workspace_not_owned', 'verification_source_required', 'review_source_not_verification',
    'workspace_uncommitted', 'commits_unsubmitted', 'workspace_baseline_missing',
  ],
}
/** Uncoded refusal sites on these two files before this branch (measured on the merge baseline 34e8a20). */
const PRE_BRANCH_UNCODED = 235
/**
 * M1a split the two serialized control-path files into modules. The inventory is
 * the union, so the "every site is still exposed" property is asserted over the
 * same total site set (235) rather than the shrinking subset that stayed put.
 */
const INVENTORY_SOURCES = [...Object.keys(ANNOTATED), 'src/attempts.ts', 'src/notices.ts', 'src/refusals.ts', 'src/gates.ts', 'src/declared-checks.ts', 'src/workspace-admission.ts', 'src/scheduling.ts']
/**
 * R17-G12 added exactly one site to this set: `[worker_name_pool_exhausted]` in
 * `src/runtime.ts` (`addMember` refuses a name-less admission once every pool
 * name is taken, with the explicit-`name` exit named). It is coded and
 * compliant, so it does not move the uncoded count below; the total is raised by
 * one so the "every site is still exposed" property keeps covering the union.
 *
 * The 2026-09-11 subprocess adoption nets one more, which is why the total now
 * sits two above the pre-branch 235: `runProcess` gained two coded refusals
 * (`[subprocess_service_required]`, `[subprocess_pipes_missing]`) and lost the
 * POSIX-only launcher's platform refusal, because the provider behind
 * `ctx.subprocess` owns process ranges on every platform (+2 −1). Both new sites
 * are coded and compliant, so the uncoded count is unchanged and the branch's
 * shrink equation still holds.
 */
/**
 * Two later owner passes moved the total again, and both are counted rather than
 * absorbed into a number:
 *  - the 2026-09-11 subprocess adoption added two coded refusals
 *    (`[subprocess_service_required]`, `[subprocess_pipes_missing]`) and deleted
 *    the POSIX-only launcher's uncoded platform refusal, because the provider
 *    behind `ctx.subprocess` owns process ranges on every platform it supports;
 *  - the 2026-09-11 orphan sweep deleted one more uncoded refusal with the dead
 *    `Workspaces.assertRecordAuthorized` (`'Mission source workspace changed'` —
 *    its protection lives on at `workspaces.ts:1358`).
 *
 * Net against the pre-branch 235: three coded sites added, two uncoded sites
 * deleted. Every added site is coded and compliant, so the shrink equation below
 * carries the deletions as their own term instead of pretending a diagnostic code
 * was added for a refusal that no longer exists.
 */
const ADDED_SITES = 7
const REMOVED_UNCODED_SITES = 2
/**
 * Declared codes that REPLACED a previously-uncoded site (the earlier branch's
 * contribution). The four owner-reply codes this branch declares are new refusal
 * sites, not conversions: they add to the total site count via ADDED_SITES and
 * leave the uncoded count exactly where the previous branch left it.
 */
const CONVERTED_UNCODED_SITES = 17
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
  for (const file of INVENTORY_SOURCES) {
    const sites = refusalSites(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), file)
    const producers = diagnosticProducers([sites])
    sitesByFile[file] = sites
    for (const site of sites) {
      total++
      if (assessRefusal(site, { ...index, diagnosticProducers: producers }).length) uncoded++
    }
  }
  assert.equal(total, 235 + ADDED_SITES - REMOVED_UNCODED_SITES, 'the split control-path files still expose every refusal site (186 + 49, plus this round\'s coded site)')
  assert.ok(uncoded < PRE_BRANCH_UNCODED,
    `this branch must shrink the uncoded inventory (pre-branch ${PRE_BRANCH_UNCODED}, now ${uncoded})`)
  assert.equal(uncoded, PRE_BRANCH_UNCODED - CONVERTED_UNCODED_SITES - REMOVED_UNCODED_SITES,
    'the uncoded inventory stays at the converted-and-deleted shrink: this branch declares new coded sites, so it converts none')
  const applied = applyAllowlist(INVENTORY_SOURCES.flatMap(file => sitesByFile[file]), ALLOWLIST,
    site => assessRefusal(site, { ...index, diagnosticProducers: diagnosticProducers([sitesByFile[site.file] ?? []]) }))
  assert.deepEqual(applied.stale, [], 'the allowlist handed over by T2 is empty and stays empty')
})
