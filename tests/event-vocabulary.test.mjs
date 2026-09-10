/**
 * Round 9-C integration: the event vocabulary names every type the runtime can
 * emit, and `eventVocabularyReport` reports none of them as unrecognized.
 *
 * The scan below derives the emitted set from `src/*.ts`, so adding a new
 * emitter without registering its type fails this suite. Types built from a
 * template literal at the emit site cannot be derived statically and are
 * enumerated explicitly.
 *
 * S5c: a type emitted through a shared exported constant
 * (`this.event(missionId, STALE_TASK_REFUSAL_EVENT, …)`) used to be invisible
 * here, so the durable `task/stale-revision-refused` row reached the mission log
 * with no vocabulary entry and `eventVocabularyReport` reported it as
 * unrecognized. The scan resolves `export const NAME = '...'` declarations in
 * every source file, so a constant emission is enforced exactly like a literal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { EVENT_VOCABULARY, eventVocabularyReport } from '../lib/trace.js'

const SRC = new URL('../src/', import.meta.url)

/** Emitted as `mission/${action}` / `delivery/${result.status}` at the call site. */
const DYNAMIC = [
  'mission/pause', 'mission/stop', 'mission/complete', 'mission/resume', 'mission/coordinator',
  'delivery/applied', 'delivery/conflicts',
]

function emittedFromSource() {
  const sources = readdirSync(SRC).filter(file => file.endsWith('.ts'))
    .map(file => readFileSync(new URL(file, SRC), 'utf8'))
  // Shared type-argument constants, e.g. `export const STALE_TASK_REFUSAL_EVENT = 'task/stale-revision-refused'`.
  const constants = new Map()
  for (const text of sources) for (const match of text.matchAll(/export const ([A-Za-z0-9_]+)\s*=\s*'([^']+)'/g)) constants.set(match[1], match[2])
  const emitted = new Set()
  for (const text of sources) {
    // Any second argument: a literal, or an identifier resolved to its constant.
    for (const match of text.matchAll(/\.event\(\s*[^,]+,\s*([^,]+?)\s*,/g)) {
      const argument = match[1].trim()
      if (argument.startsWith("'") && argument.endsWith("'")) { emitted.add(argument.slice(1, -1)); continue }
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argument) && constants.has(argument)) emitted.add(constants.get(argument))
    }
    for (const match of text.matchAll(/\.event\(\s*[^,]+,\s*[^,?]+\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
      emitted.add(match[1]); emitted.add(match[2])
    }
  }
  return [...emitted].sort()
}

test('every event type the runtime can emit is registered in the vocabulary', () => {
  const emitted = emittedFromSource()
  assert(emitted.length >= 50, `the scanner must see the runtime emitters, saw ${emitted.length}`)
  for (const type of emitted) assert(EVENT_VOCABULARY[type], `${type} is emitted but not named in EVENT_VOCABULARY`)
  for (const type of DYNAMIC) assert(EVENT_VOCABULARY[type], `${type} is emitted dynamically but not named in EVENT_VOCABULARY`)

  const all = [...new Set([...emitted, ...DYNAMIC])]
  const synthetic = all.map((type, index) => ({ seq: index + 1, missionId: 'm', type, actor: 'runtime', data: {}, createdAt: Date.now() }))
  const report = eventVocabularyReport(synthetic)
  assert.deepEqual(report.unrecognized, [], 'no emitted event type may be unrecognized')
  assert.deepEqual([...report.recognized].sort(), all.sort(), 'every emitted type must be recognized')
  for (const item of report.types) assert.equal(typeof item.description, 'string', `${item.type} must carry a description`)
  assert.equal(report.types.length, all.length, 'the report counts every emitted type once')
})
