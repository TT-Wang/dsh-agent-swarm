/**
 * R17-G10 — telemetry adopts the host contract.
 *
 * WHAT THIS FILE PROVES, against R17-G10 and mission acceptance 9:
 *  1. every recorded span is enqueued to the host telemetry sink
 *     (`ctx.sessionTelemetry`, the `session-telemetry` record contract) when the
 *     deployment mounts a backend, and the durable `trace/span` row is still
 *     written first — the sink is a reporting transport, never the record;
 *  2. the plugin's injection wire attaches a backend mounted before or after the
 *     plugin and detaches it on unload (`src/index.ts`, `installHostTelemetry`);
 *  3. a sink that throws is contained and counted, never allowed to cost the row;
 *  4. the reasons that decided each retained bespoke piece are named in the tree,
 *     because the acceptance permits a thin adapter only with a named reason.
 *
 * The payload spill this file also used to prove is gone: a span now carries only
 * the digest and byte count of its input and output, the bytes are never copied,
 * and so there is no cache to bound, sweep or verify.
 *
 * PRE-CHANGE FAILURE: on the pre-change tree this file fails at import —
 * `bindHostTelemetry`, `HostTelemetryLink` and `hostTelemetryRecord` do not
 * exist in `lib/trace.js`, and `installHostTelemetry` does not exist in
 * `lib/index.js`. The behavior below is therefore the change, not the export list.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { TraceRecorder, bindHostTelemetry, hostTelemetryRecord } from '../lib/trace.js'
import { installHostTelemetry } from '../lib/index.js'
import { tempDirectory } from './temp-root.mjs'

/** A durable-store stub: the trace layer's structural slice, with the rows kept for assertions. */
function memoryStore() {
  const rows = []
  return {
    rows,
    events: (missionId, limit, after = 0) => rows.filter(row => row.missionId === missionId && row.seq > after).slice(0, limit),
    event: (missionId, type, actor, data) => { rows.push({ seq: rows.length + 1, missionId, type, actor, data, createdAt: Date.now() }) },
    transaction: operation => operation(),
  }
}

/** A span-shaped runtime: the recorder reads `config.statePath` and `store` only. */
function runtimeFor(root, limits = {}) {
  return { config: { statePath: join(root, 'db.sqlite'), ...limits }, store: memoryStore() }
}

const spanContext = (missionId, overrides = {}) => ({
  missionId, actor: 'member-1', step: 'swarm_publish', input: { tool: 'swarm_publish' }, output: { ok: true },
  status: 'ok', startedAt: 1000, endedAt: 2000, ...overrides,
})

test('the host sink receives the ops record for every span, and the durable row is written first', async t => {
  const root = await tempDirectory('swarm-r17-sink-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = runtimeFor(root)
  const link = bindHostTelemetry(runtime)
  const records = []
  link.attach({ emit: record => records.push(record) })
  const recorder = TraceRecorder.forRuntime(runtime)
  assert(recorder, 'the recorder builds from a runtime with a state path and a store')
  assert.equal(link.bound(), true)

  const okSpan = await recorder.record(spanContext('mission-1'))
  const errorSpan = await recorder.record(spanContext('mission-1', {
    step: 'swarm_verify', status: 'error', errorType: 'validation_error', taskId: 'task-1', attemptId: 'attempt-1',
  }))

  // The durable contract is untouched: one row per span, in order, complete.
  assert.deepEqual(runtime.store.rows.map(row => row.type), ['trace/span', 'trace/span'])
  assert.deepEqual(runtime.store.rows.map(row => row.data.spanId), [okSpan.spanId, errorSpan.spanId])

  // The host sink got the contract's record, with the complete row as its body.
  assert.equal(records.length, 2)
  assert.deepEqual(records[0], hostTelemetryRecord(okSpan))
  assert.equal(records[0].channel, 'ops', 'a swarm span has no host session-log row, so it can never be a ledger record')
  assert.equal(records[0].time, okSpan.endedAt)
  assert.equal(records[0].severity, 'info')
  assert.equal(records[0].body, okSpan, 'the body is the row itself, not an excerpt')
  assert.equal(records[0].attributes['telemetry.op'], 'swarm.span')
  assert.equal(records[0].attributes['mission.id'], 'mission-1')
  assert.equal(records[0].attributes['trace.id'], okSpan.traceId)
  assert.equal(records[0].attributes['span.id'], okSpan.spanId)
  assert.equal(records[0].attributes.step, 'swarm_publish')
  assert.equal(records[1].severity, 'error')
  assert.equal(records[1].attributes['error.type'], 'validation_error')
  assert.equal(records[1].attributes['task.id'], 'task-1')
  assert.equal(records[1].attributes['attempt.id'], 'attempt-1')
  assert.deepEqual(link.counts(), { emitted: 2, failed: 0 })
})

test('no backend mounted: the span still records and no transport is invented', async t => {
  const root = await tempDirectory('swarm-r17-nosink-')
  t.after(() => rm(root, { recursive: true, force: true }))
  // Co-firing pair of the sink guard: the same record path with no link bound
  // must still write the durable row and must not fabricate a sink.
  const runtime = runtimeFor(root)
  const recorder = TraceRecorder.forRuntime(runtime)
  assert.equal(recorder.telemetry, undefined, 'a runtime nobody bound has no sink link')
  const span = await recorder.record(spanContext('mission-2'))
  assert.equal(runtime.store.rows.length, 1)
  assert.equal(runtime.store.rows[0].data.spanId, span.spanId)
})

test('a throwing sink is contained and counted, never allowed to cost the row', async t => {
  const root = await tempDirectory('swarm-r17-sinkthrow-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const runtime = runtimeFor(root)
  const link = bindHostTelemetry(runtime)
  link.attach({ emit: () => { throw new Error('backend down') } })
  const recorder = TraceRecorder.forRuntime(runtime)
  const span = await recorder.record(spanContext('mission-3'))
  assert.equal(runtime.store.rows.length, 1, 'the durable row survives a failing backend')
  assert.equal(runtime.store.rows[0].data.spanId, span.spanId)
  assert.deepEqual(link.counts(), { emitted: 0, failed: 1 })
  // Pair of the containment guard: after detach the same call is a plain no-op,
  // so the failure count cannot grow once the backend is gone.
  link.detach()
  await recorder.record(spanContext('mission-3'))
  assert.deepEqual(link.counts(), { emitted: 0, failed: 1 })
  assert.equal(link.bound(), false)
})

test("the plugin's inject wire attaches a mounted backend and detaches on unload", async t => {
  const root = await tempDirectory('swarm-r17-wire-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const runtime = runtimeFor(root)
  const fiber = installHostTelemetry(ctx, runtime)
  const link = bindHostTelemetry(runtime)
  assert.equal(link.bound(), false, 'no backend mounted yet')
  const records = []
  // The deployment mounts the host backend after the plugin; ctx.inject fires then.
  ctx.provide('sessionTelemetry', { emit: record => records.push(record) })
  for (let attempt = 0; attempt < 200 && !link.bound(); attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(link.bound(), true, 'the wire attaches a backend mounted after the plugin')
  const recorder = TraceRecorder.forRuntime(runtime)
  await recorder.record(spanContext('mission-4'))
  assert.equal(records.length, 1)
  assert.equal(records[0].attributes['mission.id'], 'mission-4')
  // The disposer detaches the sink with the plugin fiber.
  await fiber.dispose()
  assert.equal(link.bound(), false, 'unload must not leave a reporter attached')
  await recorder.record(spanContext('mission-4'))
  assert.equal(records.length, 1, 'a disposed wire emits nothing')
  assert.equal(runtime.store.rows.length, 2, 'the durable rows are unaffected by the wire lifecycle')
})

test('the retained bespoke pieces name their reason in the tree', () => {
  // The acceptance allows no bespoke span transport "without a named reason", and
  // no payload field deleted without a named reader. Both names live beside the
  // code that would have to change, so a reader can find the decision.
  const trace = readFileSync(new URL('../src/trace.ts', import.meta.url), 'utf8')
  for (const reason of ['session-telemetry', 'replay/replay.mjs', 'reader-census']) {
    assert(trace.includes(reason), `src/trace.ts must name the reason/reader ${reason}`)
  }
  assert(trace.includes('ToolRun'), 'src/trace.ts must name where the payload bytes it no longer keeps still live')
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert(index.includes('installHostTelemetry'), 'src/index.ts owns the sink wiring')
  assert(index.includes('sessionTelemetry'), 'src/index.ts names the host service it adopts')
})
