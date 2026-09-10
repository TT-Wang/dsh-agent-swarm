/**
 * RPC refusal-classification boundary guard (S3 repair, T3b).
 *
 * The browser sanitizer in `src/web-api.ts` classifies a refusal as actionable
 * by matching its message against an ANCHORED allowlist (`actionableMessages`).
 * A diagnostic prefix or an appended exit sentence changes the message, so an
 * annotated refusal the allowlist owns is silently downgraded to a generic
 * `internal-error` (the exact defect independent verification found in the T3
 * artifact: the cancel RPC returned `internal-error` instead of `bad-request`
 * because `Task is not in this mission` became a `[task_not_in_mission]`-prefixed
 * sentence with advice).
 *
 * The rule enforced here is mechanical, not a list of samples: every message
 * the sanitizer classifies must stay byte-identical to the authored text the
 * allowlist names, so it must carry no `[diagnostic_code]` prefix and no
 * appended exit. Refusals outside the allowlist may still be annotated (that is
 * the S3 goal); templates are refused because their rendering cannot be proven
 * against the allowlist mechanically.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { refusalSites } from './refusal-inventory.mjs'

const SOURCES = ['src/runtime.ts', 'src/workspaces.ts']
/** The RPC-actionable inventory measured on the merge baseline 34e8a20. */
const BASELINE_CLASSIFIED = 103

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
  assert.ok(ACTIONABLE.length >= 60, `the allowlist must be the real set, saw ${ACTIONABLE.length} patterns`)
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
  assert.ok(classifiedCount >= BASELINE_CLASSIFIED,
    `the RPC-actionable inventory must not shrink (${classifiedCount} < ${BASELINE_CLASSIFIED} measured on 34e8a20)`)
})
