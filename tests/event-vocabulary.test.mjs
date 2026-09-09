/**
 * Round 9-C integration: the event vocabulary names every type the runtime can
 * emit, and `eventVocabularyReport` reports none of them as unrecognized.
 *
 * The scan below derives the emitted set from `src/*.ts`, so adding a new
 * emitter without registering its type fails this suite. Types built from a
 * template literal at the emit site cannot be derived statically and are
 * enumerated explicitly.
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
  const emitted = new Set()
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith('.ts')) continue
    const text = readFileSync(new URL(file, SRC), 'utf8')
    for (const match of text.matchAll(/\.event\(\s*[^,]+,\s*'([^']+)'/g)) emitted.add(match[1])
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
