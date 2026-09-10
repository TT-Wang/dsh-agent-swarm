/**
 * The persisted trace contract, held still across the R17-G10 host-contract
 * adoption.
 *
 * `src/trace.ts` gained a host telemetry sink and a bounded payload spill, and
 * the acceptance forbids losing anything observable: "the persisted span/trace
 * contract that `scripts/replay` and the trace tests depend on keeps working".
 * This file is the consumer-pair regression for that promise, run on a real
 * mission through the real tools:
 *
 *  - every `trace/span` row is still contract-valid and still carries exactly the
 *    recorded fields (`tests/reader-census.test.mjs` row `trace/span`, whose
 *    reader is `src/tools.ts`, and the payload-field census);
 *  - a payload reference is still exactly `{ digest, bytes, stored }` with a
 *    `sha256:` digest, and the payload bytes still never enter the event log;
 *  - the replay gate still re-derives the orchestrator's decision sequence from
 *    the durable rows, deterministically, with no provider call;
 *  - the metrics still verify every stored digest, now with the spill instrument
 *    attached (`payloads.spill`), and the declared bound is the store's default
 *    rather than an implicit number.
 *
 * Everything here passes on the pre-change tree and must keep passing after it:
 * a change that breaks any assertion has changed an observable contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_TRACE_SPILL_LIMITS, EVENT_VOCABULARY, TracePayloadStore, digestText, orchestratorCommands,
  spanContractViolation, traceMetrics,
} from '../lib/trace.js'
import { traceFixture } from './fixtures/trace-runtime.mjs'

/** Every field a durable span row may carry; the census reads this contract. */
const SPAN_FIELDS = new Set(['traceId', 'spanId', 'parentSpanId', 'missionId', 'attemptId', 'taskId', 'operation', 'step',
  'status', 'errorType', 'startedAt', 'endedAt', 'traceparent', 'actor', 'input', 'output'])
/** Fields every span row must carry for replay, metrics and the reader census. */
const SPAN_REQUIRED = ['traceId', 'spanId', 'missionId', 'operation', 'step', 'status', 'startedAt', 'endedAt', 'traceparent', 'actor', 'input', 'output']

test('every durable span row keeps the recorded field set and a digest reference payload', async t => {
  const f = await traceFixture(t)
  const spans = f.events().filter(event => event.type === 'trace/span').map(event => event.data)
  assert(spans.length >= 12, `expected a span per orchestration step, saw ${spans.length}`)
  for (const span of spans) {
    assert.equal(spanContractViolation(span), undefined, JSON.stringify(span))
    for (const field of Object.keys(span)) assert(SPAN_FIELDS.has(field), `unrecorded span field ${field}`)
    for (const field of SPAN_REQUIRED) assert(Object.hasOwn(span, field), `missing recorded span field ${field}`)
    for (const key of ['input', 'output']) {
      assert.deepEqual(Object.keys(span[key]).sort(), ['bytes', 'digest', 'stored'], `${key} must stay a digest reference`)
      assert.match(span[key].digest, /^sha256:[0-9a-f]{64}$/)
    }
  }
  // The payload stays outside the log by construction.
  const log = JSON.stringify(spans)
  assert(!log.includes(f.bigClaim), 'payload bytes must never enter the event log')
  const stored = spans.find(span => span.step === 'swarm_publish' && span.output.stored)
  assert(stored !== undefined, 'the publish step stores the claim payload')
  const bytes = await f.payloads.read(stored.output.digest)
  assert(bytes !== undefined)
  assert.equal(digestText(bytes), stored.output.digest, 'a persisted reference still resolves to the bytes it names')
  assert(EVENT_VOCABULARY['trace/span'], 'the reader census still names trace/span as a kept, read kind')
})

test('the replay gate still derives the decision sequence from the durable log', async t => {
  const f = await traceFixture(t)
  const events = f.events()
  const replayed = orchestratorCommands(events)
  assert(replayed.commands.some(command => command.kind === 'dispatch'))
  assert(replayed.commands.some(command => command.kind === 'verify'))
  assert.equal(orchestratorCommands(structuredClone(events)).digest, replayed.digest, 'replay stays deterministic')
  // The metrics path the tool and the replay script both read.
  const spans = events.filter(event => event.type === 'trace/span').map(event => event.data)
  const metrics = await traceMetrics(spans, { payloads: f.payloads })
  assert.equal(metrics.contractCompliance, 1)
  assert.equal(metrics.firstViolatingStep, undefined)
  assert.equal(metrics.payloads.stored, metrics.payloads.verified)
  assert.equal(metrics.payloads.missing, 0)
  assert.equal(metrics.payloads.mismatched, 0)
  // R17-G10: the same read now also carries the declared spill bound and what a
  // sweep would reclaim, measured without touching the directory.
  assert.equal(metrics.payloads.spill.maxFiles, DEFAULT_TRACE_SPILL_LIMITS.maxFiles)
  assert.equal(metrics.payloads.spill.maxBytes, DEFAULT_TRACE_SPILL_LIMITS.maxBytes)
  assert(metrics.payloads.spill.files > 0)
  assert.equal(metrics.payloads.spill.cleanable, 0, 'a fresh mission is inside the bound')
})

test('the payload reference guard is unchanged (pair: valid ref accepted, malformed refused)', () => {
  const base = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), missionId: 'm', operation: 'tool', step: 'swarm_publish',
    status: 'ok', startedAt: 1, endedAt: 2, traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, actor: 'member-1' }
  const ref = { digest: `sha256:${'c'.repeat(64)}`, bytes: 12, stored: true }
  assert.equal(spanContractViolation({ ...base, input: ref, output: ref }), undefined)
  const refused = [
    { ...ref, digest: 'sha256:not-hex' },
    { ...ref, bytes: -1 },
    { ...ref, stored: 'yes' },
    null,
  ]
  for (const bad of refused) assert.notEqual(spanContractViolation({ ...base, input: bad, output: ref }), undefined, JSON.stringify(bad))
})

test('the declared spill bound is the store default and the omission guard still holds', async t => {
  const f = await traceFixture(t)
  assert.deepEqual(new TracePayloadStore(f.payloads.directory).limits, DEFAULT_TRACE_SPILL_LIMITS)
  // Pair: a payload larger than the per-payload cap is omitted (`stored: false`)
  // and `verify` returns true for it without inventing a file, while a stored
  // payload verifies against the bytes actually on disk.
  const small = new TracePayloadStore(join(f.payloads.directory, 'bound-probe'), 8)
  const omitted = await small.put('x'.repeat(64))
  assert.equal(omitted.stored, false)
  assert.equal(await small.verify(omitted), true)
  const stored = await small.put({ ok: 1 })
  assert.equal(stored.stored, true)
  assert.equal(await small.verify(stored), true)
  assert.equal((await readdir(join(f.payloads.directory, 'bound-probe'))).length, 1)
})
