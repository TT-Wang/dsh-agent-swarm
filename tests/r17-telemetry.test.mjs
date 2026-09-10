/**
 * R17-G10 — telemetry adopts the host contract, and the leaked payload spill is
 * bounded, swept and proven.
 *
 * WHAT THIS FILE PROVES, against R17-G10 and mission acceptance 9:
 *  1. every recorded span is enqueued to the host telemetry sink
 *     (`ctx.sessionTelemetry`, the `session-telemetry` record contract) when the
 *     deployment mounts a backend, and the durable `trace/span` row is still
 *     written first — the sink is a reporting transport, never the record;
 *  2. the plugin's injection wire attaches a backend mounted before or after the
 *     plugin and detaches it on unload (`src/index.ts`, `installHostTelemetry`);
 *  3. the payload spill beside the state file is bounded by a declared
 *     `maxFiles`/`maxBytes` plus an age-retention cutoff, swept oldest-first,
 *     measured without side effects by a dry run, and re-bounded at every host
 *     start (the bound survives a restart);
 *  4. the bound is a CEILING on the put path, not a cadence (R17-G10 repair):
 *     after every accepted `put` resolves the root holds at most `maxFiles`
 *     files and `maxBytes` bytes — the reviewer's 255-write construction is
 *     re-run and checked after each write — a payload above the whole bound is
 *     omitted rather than written, and concurrent puts cannot overtake the
 *     serialized headroom check;
 *  5. the sweep guard pairings hold: age and bound eviction never double-charge a
 *     file; a symlink or a directory is never followed or deleted while a regular
 *     expired file in the same directory is; a fresh file survives the age guard;
 *  6. a sink that throws is contained and counted, and an evicted payload is
 *     reported as `missing` by the metrics instrument instead of disappearing
 *     silently;
 *  7. the reasons that decided each retained bespoke piece are named in the tree,
 *     because the acceptance permits a thin adapter only with a named reason.
 *
 * PRE-CHANGE FAILURE: on the pre-change tree this file fails at import —
 * `sweepTraceSpill`, `DEFAULT_TRACE_SPILL_LIMITS`, `bindHostTelemetry`,
 * `HostTelemetryLink`, `hostTelemetryRecord` and `traceSpillLimits` do not exist
 * in `lib/trace.js`, and `installHostTelemetry` does not exist in `lib/index.js`.
 * The behavior below is therefore the change, not the export list.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_TRACE_SPILL_LIMITS, TRACE_SPILL_RETENTION_DAYS, TracePayloadStore, TraceRecorder,
  bindHostTelemetry, canonicalJson, hostTelemetryRecord, sweepTraceSpill, traceSpillLimits, traceMetrics,
} from '../lib/trace.js'
import { installHostTelemetry } from '../lib/index.js'
import { tempDirectory } from './temp-root.mjs'

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

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

/** Seed a spill root with regular files whose mtimes are `ageMinutes` old. */
async function seedSpill(root, entries) {
  const now = Date.now()
  await mkdir(root, { recursive: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    await writeFile(path, 'x'.repeat(entry.bytes))
    await utimes(path, (now - entry.ageMinutes * MINUTE) / 1000, (now - entry.ageMinutes * MINUTE) / 1000)
  }
  await utimes(root, now / 1000, now / 1000)
}

const regularFiles = async root => (await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name).sort()
const directoryBytes = async root => {
  let bytes = 0
  for (const name of await regularFiles(root)) bytes += (await stat(join(root, name))).size
  return bytes
}
/** The live ceiling measurement: regular files and payload bytes currently in the root. */
const measureSpill = async root => ({ files: (await regularFiles(root)).length, bytes: await directoryBytes(root) })

test('the sweep enforces the declared bound oldest-first (pair: age and bound never double-charge)', async t => {
  const root = await tempDirectory('swarm-r17-bound-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await seedSpill(root, [
    { name: 'a.json', bytes: 100, ageMinutes: 6 }, { name: 'b.json', bytes: 100, ageMinutes: 5 },
    { name: 'c.json', bytes: 100, ageMinutes: 4 }, { name: 'd.json', bytes: 100, ageMinutes: 3 },
    { name: 'e.json', bytes: 100, ageMinutes: 2 }, { name: 'f.json', bytes: 100, ageMinutes: 1 },
  ])
  const bounded = await sweepTraceSpill({ root, limits: { maxFiles: 3, maxBytes: 300, retentionMs: 0 } })
  assert.equal(bounded.expired, 0, 'age retention is disabled by retentionMs 0')
  assert.equal(bounded.evicted, 3)
  assert.equal(bounded.deleted, 3)
  assert.equal(bounded.filesAfter, 3)
  assert.equal(bounded.bytesAfter, 300)
  assert.deepEqual(await regularFiles(root), ['d.json', 'e.json', 'f.json'], 'the oldest files are evicted, the newest window survives')
  assert.deepEqual(bounded.errors, [])

  // Age and bound co-fire on the same directory: three files expire and the
  // bound still does not hold, so one more is evicted. The overlap guard is that
  // a file reclaimed for age is never charged to eviction.
  await seedSpill(root, [
    { name: 'g.json', bytes: 100, ageMinutes: 40 }, { name: 'h.json', bytes: 100, ageMinutes: 35 },
    { name: 'i.json', bytes: 100, ageMinutes: 30 }, { name: 'j.json', bytes: 100, ageMinutes: 1 },
  ])
  const mixed = await sweepTraceSpill({ root, limits: { maxFiles: 3, maxBytes: 300, retentionMs: 10 * MINUTE } })
  assert.equal(mixed.expired, 3, 'the three aged files are reclaimed for age')
  assert.equal(mixed.evicted, 1, 'the bound evicts exactly one more file')
  assert.equal(mixed.deleted, mixed.expired + mixed.evicted, 'no file is charged twice when both guards fire')
  assert.equal(mixed.filesAfter, 3)
  assert(mixed.bytesAfter <= 300)
  assert.deepEqual(await regularFiles(root), ['e.json', 'f.json', 'j.json'])
})

test('the sweep never follows or deletes a symlink and never reclaims a fresh file (pair: the age guard)', async t => {
  const root = await tempDirectory('swarm-r17-symlink-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const outside = await tempDirectory('swarm-r17-outside-')
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(join(outside, 'target.json'), 'outside bytes')
  await seedSpill(root, [{ name: 'fresh.json', bytes: 50, ageMinutes: 0 }, { name: 'aged.json', bytes: 50, ageMinutes: 30 }])
  await symlink(join(outside, 'target.json'), join(root, 'link.json'))
  await mkdir(join(root, 'nested'), { recursive: true })

  const report = await sweepTraceSpill({ root, limits: { maxFiles: 100, maxBytes: 100000, retentionMs: 10 * MINUTE } })
  assert.equal(report.expired, 1, 'the expired regular file in the same directory is reclaimed')
  assert.equal(report.deleted, 1)
  assert.equal(report.skipped, 2, 'the symlink and the directory are counted, not touched')
  assert.deepEqual(await regularFiles(root), ['fresh.json'], 'the fresh file survives the age guard')
  assert.equal(await readFile(join(outside, 'target.json'), 'utf8'), 'outside bytes', 'a planted symlink cannot redirect the sweep')
  assert.equal((await readdir(root)).includes('link.json'), true, 'the symlink itself is never deleted')
})

test('a dry run measures the same sweep without touching a file', async t => {
  const root = await tempDirectory('swarm-r17-dry-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await seedSpill(root, [
    { name: 'a.json', bytes: 100, ageMinutes: 9 }, { name: 'b.json', bytes: 100, ageMinutes: 8 },
    { name: 'c.json', bytes: 100, ageMinutes: 7 }, { name: 'd.json', bytes: 100, ageMinutes: 6 },
    { name: 'e.json', bytes: 100, ageMinutes: 5 }, { name: 'f.json', bytes: 100, ageMinutes: 4 },
  ])
  const before = await regularFiles(root)
  const measured = await sweepTraceSpill({ root, limits: { maxFiles: 2, maxBytes: 200, retentionMs: 0 }, dryRun: true })
  assert.equal(measured.dryRun, true)
  assert.equal(measured.evicted, 4)
  assert.equal(measured.deleted, 4)
  assert.equal(measured.filesAfter, 2)
  assert.deepEqual(await regularFiles(root), before, 'a dry run removes nothing')
  // Pair: the real sweep on the same directory produces the measured counts.
  const swept = await sweepTraceSpill({ root, limits: { maxFiles: 2, maxBytes: 200, retentionMs: 0 } })
  assert.equal(swept.deleted, measured.deleted)
  assert.equal(swept.filesAfter, measured.filesAfter)
  assert.deepEqual(await regularFiles(root), ['e.json', 'f.json'])
})

test('a failed delete and a throwing warn sink are contained and named (pair: the ENOENT idempotency guard)', async t => {
  const root = await tempDirectory('swarm-r17-contained-')
  t.after(async () => { await chmod(root, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }) })
  await seedSpill(root, [{ name: 'a.json', bytes: 10, ageMinutes: 30 }, { name: 'b.json', bytes: 10, ageMinutes: 30 }])
  // A root without write permission makes every unlink fail: the sweep must
  // contain it, name it, and still report honestly what remains.
  await chmod(root, 0o500)
  const report = await sweepTraceSpill({
    root, limits: { maxFiles: 100, maxBytes: 1000, retentionMs: MINUTE },
    warn: () => { throw new Error('the warn sink itself is down') },
  })
  assert.equal(report.expired, 2, 'both aged files are selected')
  assert.equal(report.deleted, 0, 'nothing was deleted')
  assert.equal(report.filesAfter, 2)
  assert.equal(report.errors.length, 2, 'every failed unlink is named, not swallowed')
  assert(report.errors.every(message => message.includes('failed to delete')), report.errors.join('; '))
  assert.deepEqual(await regularFiles(root), ['a.json', 'b.json'], 'a contained failure never removes anything else')
})

test('the bound survives a restart: every recorder start re-applies it', async t => {
  const root = await tempDirectory('swarm-r17-restart-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const config = { traceSpillMaxBytes: 800, traceSpillMaxFiles: 2, traceSpillRetentionDays: 30 }
  const payloadDir = join(root, 'trace-payloads')
  await seedSpill(payloadDir, [
    { name: '1.json', bytes: 400, ageMinutes: 6 }, { name: '2.json', bytes: 400, ageMinutes: 5 },
    { name: '3.json', bytes: 400, ageMinutes: 4 }, { name: '4.json', bytes: 400, ageMinutes: 3 },
    { name: '5.json', bytes: 400, ageMinutes: 2 }, { name: '6.json', bytes: 400, ageMinutes: 1 },
  ])
  // First host start: the recorder built from the runtime carries the bound.
  const first = TraceRecorder.forRuntime(runtimeFor(root, config))
  const firstReport = await first.startupSweep
  assert.equal(firstReport.limits.maxFiles, 2)
  assert.equal(firstReport.limits.maxBytes, 800)
  assert.equal(firstReport.limits.retentionMs, 30 * DAY)
  assert(firstReport.filesAfter <= 2, `startup left ${firstReport.filesAfter} files`)
  assert(firstReport.bytesAfter <= 800, `startup left ${firstReport.bytesAfter} bytes`)
  // More work lands (5 more payloads) and the host restarts: a fresh recorder
  // re-applies the same bound without any operator action.
  await seedSpill(payloadDir, [
    { name: '7.json', bytes: 400, ageMinutes: 5 }, { name: '8.json', bytes: 400, ageMinutes: 4 },
    { name: '9.json', bytes: 400, ageMinutes: 3 }, { name: '10.json', bytes: 400, ageMinutes: 2 },
    { name: '11.json', bytes: 400, ageMinutes: 1 },
  ])
  assert((await regularFiles(payloadDir)).length > 2, 'the fixture really exceeds the bound before the restart')
  const second = TraceRecorder.forRuntime(runtimeFor(root, config))
  const secondReport = await second.startupSweep
  assert(secondReport.filesAfter <= 2, `restart left ${secondReport.filesAfter} files`)
  assert((await directoryBytes(payloadDir)) <= 800, 'the bound still holds after the restart')
  // The configured bound is a ceiling on the put path too, not only at start:
  // a write through the recorder's store reserves its room before writing.
  const grown = await second.payloads.put({ after: 'restart' })
  assert.equal(grown.stored, true)
  const afterPut = await measureSpill(payloadDir)
  assert(afterPut.files <= 2, `configured maxFiles left ${afterPut.files} files`)
  assert(afterPut.bytes <= 800, `configured maxBytes left ${afterPut.bytes} bytes`)
  // The config mapping itself: explicit values win, omitted or invalid ones fall
  // back to the declared default (the schema in src/index.ts defaults to these).
  assert.deepEqual(traceSpillLimits(runtimeFor(root, config).config), { maxBytes: 800, maxFiles: 2, retentionMs: 30 * DAY })
  assert.deepEqual(traceSpillLimits({}), DEFAULT_TRACE_SPILL_LIMITS)
  assert.deepEqual(traceSpillLimits({ traceSpillMaxBytes: -1, traceSpillMaxFiles: 1.5, traceSpillRetentionDays: 0 }), { ...DEFAULT_TRACE_SPILL_LIMITS, retentionMs: 0 })
  assert.equal(TRACE_SPILL_RETENTION_DAYS, DEFAULT_TRACE_SPILL_LIMITS.retentionMs / DAY)
})

test('the declared bound is a ceiling on every accepted put, not a cadence', async t => {
  const root = await tempDirectory('swarm-r17-ceiling-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TracePayloadStore(root)
  const limits = store.limits
  assert.equal(limits.maxBytes, DEFAULT_TRACE_SPILL_LIMITS.maxBytes)
  assert.equal(limits.maxFiles, DEFAULT_TRACE_SPILL_LIMITS.maxFiles)
  // The reviewer's falsified construction: 255 consecutive accepted 192 KiB
  // writes used to leave 50,137,335 B (2.99x maxBytes) because the cadence sweep
  // only fired on the 256th put. The ceiling must hold after EVERY put.
  const payload = 'x'.repeat(192 * 1024)
  let evicted = 0
  const counted = new Set()
  for (let index = 0; index < 255; index++) {
    const ref = await store.put({ index, payload })
    assert.equal(ref.stored, true, `put ${index} must be accepted below the bound`)
    const held = await measureSpill(root)
    assert(held.files <= limits.maxFiles, `put ${index} left ${held.files} files (max ${limits.maxFiles})`)
    assert(held.bytes <= limits.maxBytes, `put ${index} left ${held.bytes} bytes (max ${limits.maxBytes})`)
    const report = store.lastSweep
    if (report !== undefined && !counted.has(report)) { counted.add(report); evicted += report.evicted }
  }
  assert(evicted > 0, 'the construction must actually reach the bound and evict, not just stay small')
  const held = await measureSpill(root)
  assert(held.files > 1, `the directory should hold many payloads at the bound, saw ${held.files}`)
})

test('the largest accepted payload obeys the same ceiling, and a payload above the whole bound is omitted', async t => {
  const root = await tempDirectory('swarm-r17-ceiling-large-')
  t.after(() => rm(root, { recursive: true, force: true }))
  // The largest payload the per-payload cap admits is exactly 262,144 bytes of
  // canonical JSON — the reviewer's worst case. Every accepted write must leave
  // the default 16 MiB root within its bound.
  const store = new TracePayloadStore(root)
  const largestPayload = index => {
    const base = Buffer.byteLength(canonicalJson({ blob: '', index }), 'utf8')
    return { index, blob: 'y'.repeat(262_144 - base) }
  }
  assert.equal(Buffer.byteLength(canonicalJson(largestPayload(0)), 'utf8'), 262_144)
  for (let index = 0; index < 120; index++) {
    const ref = await store.put(largestPayload(index))
    assert.equal(ref.stored, true, `write ${index} of the largest accepted payload`)
    const held = await measureSpill(root)
    assert(held.bytes <= store.limits.maxBytes, `write ${index} left ${held.bytes} bytes (max ${store.limits.maxBytes})`)
    assert(held.files <= store.limits.maxFiles)
  }
  // A single payload above the whole bound can never be retained under it: the
  // put is omitted, no file is written, and `verify` still reports true for an
  // omitted reference (pair: the per-payload omission guard).
  const tiny = new TracePayloadStore(join(root, 'tiny'), 600_000, { limits: { maxFiles: 8, maxBytes: 400_000, retentionMs: 0 } })
  const overBound = await tiny.put({ blob: 'z'.repeat(500_000) })
  assert.equal(overBound.stored, false)
  assert.equal(await tiny.verify(overBound), true)
  assert.equal((await readdir(join(root, 'tiny')).catch(() => [])).length, 0, 'an omitted payload writes nothing')
})

test('concurrent puts cannot overtake the headroom check (pair: the serialized put queue)', async t => {
  const root = await tempDirectory('swarm-r17-ceiling-concurrent-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TracePayloadStore(root, 4096, { limits: { maxFiles: 2, maxBytes: 1500, retentionMs: 0 } })
  const refs = await Promise.all([0, 1, 2, 3, 4].map(index => store.put({ index, blob: 'c'.repeat(700) })))
  assert.deepEqual(refs.map(ref => ref.stored), [true, true, true, true, true], 'each concurrent put reserves its own room')
  const held = await measureSpill(root)
  assert(held.files <= 2, `${held.files} files after concurrent puts`)
  assert(held.bytes <= 1500, `${held.bytes} bytes after concurrent puts`)
  assert.equal(await store.verify(refs.at(-1)), true, 'the last accepted payload is still on disk')
})

test('the store keeps the digest contract under the bound, and an eviction is reported, never silent', async t => {
  const root = await tempDirectory('swarm-r17-store-')
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new TracePayloadStore(root, 64, { limits: { maxFiles: 2, maxBytes: 1_000_000, retentionMs: 0 } })
  assert.deepEqual(store.limits, { maxFiles: 2, maxBytes: 1_000_000, retentionMs: 0 })
  // Pair: the per-payload size guard and the verify guard — an omitted payload
  // is `stored: false` and verifies true because there is no file to check.
  const omitted = await store.put('a'.repeat(100))
  assert.equal(omitted.stored, false)
  assert.equal(await store.verify(omitted), true)
  // Accepted puts keep the ceiling: the third payload needs the room the first
  // one holds, so the put path evicts it (co-firing guards: the headroom
  // reservation and the oldest-first eviction) instead of ever holding three.
  const now = Date.now()
  const refs = []
  for (const index of [1, 2, 3]) {
    const ref = await store.put({ index })
    refs.push(ref)
    // Pin the mtimes so "oldest first" is deterministic rather than a
    // millisecond tie broken by the digest name.
    await utimes(store.pathFor(ref.digest), (now - (4 - index) * 1000) / 1000, (now - (4 - index) * 1000) / 1000)
  }
  assert.deepEqual(refs.map(ref => ref.stored), [true, true, true])
  assert.equal(await store.verify(refs[0]), false, 'the oldest payload was evicted by the put that needed its room')
  assert.equal(await store.verify(refs[2]), true, 'the newest payload survives')
  assert.equal(store.lastSweep.evicted, 1)
  assert.equal(store.lastSweep.deleted, 1)
  assert.equal(await readFile(store.pathFor(refs[2].digest), 'utf8'), '{"index":3}')
  const before = await store.spillState()
  assert.equal(before.files, 2)
  assert.equal(before.cleanable, 0, 'the ceiling leaves nothing over the bound to clean')
  assert.equal(before.maxFiles, 2)

  // The metrics report the loss loudly (missing/mismatched) and carry the live
  // spill instrument, so an operator sees the bound working instead of bytes
  // vanishing.
  const span = {
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), missionId: 'mission-5', attemptId: 'attempt-1',
    operation: 'tool', step: 'swarm_publish', status: 'ok', startedAt: 1, endedAt: 2,
    traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`, actor: 'member-1', input: refs[0], output: refs[2],
  }
  const metrics = await traceMetrics([span], { payloads: store })
  assert.equal(metrics.payloads.stored, 2)
  assert.equal(metrics.payloads.verified, 1)
  assert.equal(metrics.payloads.missing, 1)
  assert.equal(metrics.payloads.mismatched, 1)
  assert.equal(metrics.payloads.spill.files, 2)
  assert.equal(metrics.payloads.spill.maxFiles, 2)
  assert.equal(metrics.payloads.spill.cleanable, 0)
  assert.equal(metrics.payloads.spill.lastSweep.deleted, 1)
})

test('the retained bespoke pieces name their reason in the tree', () => {
  // The acceptance allows no bespoke span transport "without a named reason", and
  // no payload field deleted without a named reader. Both names live beside the
  // code that would have to change, so a reader can find the decision.
  const trace = readFileSync(new URL('../src/trace.ts', import.meta.url), 'utf8')
  for (const reason of ['session-telemetry', 'dsh-spill-local', 'sweepSpillRoots', 'replay/replay.mjs', 'reader-census']) {
    assert(trace.includes(reason), `src/trace.ts must name the reason/reader ${reason}`)
  }
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert(index.includes('installHostTelemetry'), 'src/index.ts owns the sink wiring')
  assert(index.includes('sessionTelemetry'), 'src/index.ts names the host service it adopts')
  assert(index.includes('traceSpillMaxBytes') && index.includes('traceSpillMaxFiles'), 'the bound is declared in the plugin schema, not hard-coded silently')
})
