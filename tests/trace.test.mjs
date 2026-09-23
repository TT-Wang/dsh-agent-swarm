/**
 * The persisted trace contract, held still across the R17-G10 host-contract
 * adoption.
 *
 * `src/trace.ts` gained a host telemetry sink, and the acceptance forbids losing
 * anything observable: "the persisted span/trace contract that `scripts/replay`
 * and the trace tests depend on keeps working".
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
 *  - the metrics still count every payload reference in the window.
 *
 * Everything here passes on the pre-change tree and must keep passing after it:
 * a change that breaks any assertion has changed an observable contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EVENT_VOCABULARY, TraceRecorder, canonicalJson, digestText, orchestratorCommands, payloadRef, spanContractViolation, traceMetrics } from '../lib/trace.js'
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
  // Nothing retains the bytes any more, so every recorded reference is a pure
  // digest of what the step was called with.
  for (const span of spans) for (const key of ['input', 'output']) assert.equal(span[key].stored, false, `${span.step}.${key} must not spill payload bytes`)
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
  const metrics = await traceMetrics(spans)
  assert.equal(metrics.contractCompliance, 1)
  assert.equal(metrics.firstViolatingStep, undefined)
  assert.equal(metrics.payloads.referenced, spans.length * 2, 'every span names an input and an output reference')
  assert.equal(metrics.payloads.stored, 0)
  assert.equal(metrics.payloads.omitted, metrics.payloads.referenced)
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

test('a payload reference is the canonical digest of its payload and retains no bytes', () => {
  const ref = payloadRef({ b: 2, a: 1 })
  assert.deepEqual(Object.keys(ref).sort(), ['bytes', 'digest', 'stored'])
  assert.equal(ref.stored, false, 'nothing is written anywhere, so nothing can be read back')
  assert.equal(ref.digest, digestText(canonicalJson({ a: 1, b: 2 })), 'key order cannot change the digest')
  assert.equal(ref.bytes, Buffer.byteLength(canonicalJson({ a: 1, b: 2 }), 'utf8'))
  assert.notEqual(payloadRef({ a: 1 }).digest, ref.digest, 'a different payload gets a different digest')
})

test('a recorder removes the payload directory earlier builds kept beside the state file', async t => {
  // Builds before round 20 spilled span payloads into <state dir>/trace-payloads
  // and bounded it with a startup sweep. The spill and the sweep are gone, so an
  // upgraded host would otherwise keep those copies of swarm_* arguments forever.
  const directory = await mkdtemp(join(tmpdir(), 'trace-legacy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const legacy = join(directory, 'trace-payloads', 'ab')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'cdef.json'), '{"tool":"swarm_publish"}')
  const store = { event() {}, transaction(body) { return body() }, events() { return [] } }
  const recorder = TraceRecorder.forRuntime({ config: { statePath: join(directory, 'state.sqlite') }, store })
  assert.ok(recorder, 'a runtime with a durable store and state path gets a recorder')
  await recorder.legacyCleanup
  await assert.rejects(stat(join(directory, 'trace-payloads')), { code: 'ENOENT' }, 'the legacy payload directory is gone')
  // A host that never had the directory starts the same way.
  const fresh = TraceRecorder.forRuntime({ config: { statePath: join(directory, 'state.sqlite') }, store })
  await fresh.legacyCleanup
})
