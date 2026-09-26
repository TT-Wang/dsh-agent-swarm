/**
 * M-3: a trace span is valid by construction, so recording it cannot change a
 * command's result.
 *
 * Driven through the real tool wrapper (`registerTools`) on a real runtime
 * (`makeRuntime`). Every clause of the D6 span contract now holds where its
 * value is made: the mission scope is an existing mission row (anything else
 * is an unscoped call), the actor is the id the session guard requires,
 * `endedAt` is `startedAt` plus a monotonic duration, and a parent read back
 * from the durable rows is used only when it is a valid span id (the row itself
 * stays in the metrics window, which reports its violation). Recording is best
 * effort under the host telemetry link's one policy: a failure resolving,
 * building or writing a span is contained and counted
 * (`bindHostTelemetry(runtime).counts()`), never thrown. The wrapper settles
 * the command once, records exactly one span (or one unscoped count) with that
 * outcome and rethrows exactly the command's own error.
 *
 * PRE-CHANGE FAILURE (a65f837): an empty missionId throws a TraceContractError
 * instead of the command's error, and an unknown one writes a span under a
 * mission that does not exist; a failing span write, or a failing scope read,
 * turns a committed command into a tool error, and a failing write replaces a
 * failing command's error; a prelaunch request with no mission records a span
 * under the request id; a call refused at the workspace binding is neither
 * recorded nor counted; a wall clock that steps back mid-command throws a
 * TraceContractError; a malformed stored span id becomes a parent and throws
 * (and e6b8cfa, which dropped the row from the index, reports a clean metrics
 * window over it; dfc0825 still drops a row whose id is not a string); an agent
 * with an empty id passes the session guard; a snapshot failure after a
 * committed command records a second, error span.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools.js'
import { TraceRecorder, bindHostTelemetry, spanContractViolation } from '../lib/trace.js'
import { FakeClock, makeRuntime } from './faults/harness.mjs'

/** A real runtime with one mission created directly, and its registered tools. */
async function fixture(t) {
  const f = await makeRuntime(t)
  const owner = { sessionId: 'trace-owner' }
  const mission = f.runtime.create(owner, { title: 'Trace', objective: 'Record every call', workspace: f.dir, scope: ['**'], acceptance: ['works'], budget: f.budget }, { grantRoot: f.dir, source: 'session' })
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.budget)
  const exec = (sessionId = owner.sessionId) => ({ agent: { id: sessionId, session: { header: { cwd: f.dir } } }, signal: new AbortController().signal })
  const call = (name, args, sessionId) => definitions.get(name).execute(args, exec(sessionId))
  const spans = (missionId = mission.id) => f.runtime.store.events(missionId, 1000, 0).filter(event => event.type === 'trace/span').map(event => event.data)
  const unscoped = async () => (await call('swarm_observe', { missionId: mission.id, trace: true })).result.trace.unscopedSteps
  /** Every durable span write fails until the returned restore runs; the runtime's own events still commit. */
  const failSpanWrites = () => {
    const write = f.runtime.store.event.bind(f.runtime.store)
    f.runtime.store.event = (missionId, type, ...rest) => {
      if (type === 'trace/span') throw new Error('span store unavailable')
      return write(missionId, type, ...rest)
    }
    return () => { f.runtime.store.event = write }
  }
  return { ...f, owner, mission, definitions, exec, call, spans, unscoped, failSpanWrites, link: bindHostTelemetry(f.runtime) }
}

const stream = { title: 'Core', objective: 'Deliver the module' }

test('a call naming an empty or unknown mission throws its own error and counts one unscoped call', async t => {
  const f = await fixture(t)
  await assert.rejects(f.call('swarm_observe', { missionId: '' }), /^Error: \[tool_argument_invalid\] missionId must be a non-empty string/)
  await assert.rejects(f.call('swarm_observe', { missionId: 'mission_unknown' }), /Unknown mission/)
  assert.deepEqual(await f.unscoped(), { swarm_observe: 2 }, 'both calls are unscoped, never a contract violation')
  assert.deepEqual(f.spans('mission_unknown'), [], 'no span is written under a mission that does not exist')
  assert.deepEqual(f.spans(''), [])
  // Pair: a call naming the existing mission is scoped and records its span.
  await f.call('swarm_observe', { missionId: f.mission.id })
  assert.equal(f.spans().filter(span => span.step === 'swarm_observe').length, 2, 'the trace read and this read each record one span')
  assert.deepEqual(await f.unscoped(), { swarm_observe: 2 })
})

test('a span write that fails after a committed command is counted: the tool returns the result and records no error span', async t => {
  const f = await fixture(t)
  const restore = f.failSpanWrites()
  const created = await f.call('swarm_workstream', { missionId: f.mission.id, ...stream })
  assert.equal(created.result.title, 'Core', 'the tool returns the committed result')
  assert.deepEqual(f.runtime.store.list('workstreams', f.mission.id).map(row => row.id), [created.result.id])
  assert.deepEqual(f.link.counts(), { emitted: 0, failed: 1 }, 'exactly one span write was attempted, and its failure is counted')
  assert.deepEqual(f.spans(), [])
  // Pair: with writes succeeding again the next call records its span, and the
  // unwritten span left no index entry, so every parent is a span the log holds.
  restore()
  await f.call('swarm_workstream', { missionId: f.mission.id, title: 'Docs', objective: 'Document the module' })
  const spans = f.spans()
  assert.deepEqual(spans.map(span => span.step), ['swarm_workstream'])
  const dangling = spans.map(span => span.parentSpanId).filter(id => id !== undefined && !spans.some(span => span.spanId === id))
  assert.deepEqual(dangling, [], 'no span names a parent the durable log never held')
})

test('a scope read that fails after a committed command is contained like a failed write: the result returns and no span is written', async t => {
  const f = await fixture(t)
  // The member read in the span's scope resolution (spanContext, after the
  // command settled) fails once; the runtime's own reads are untouched.
  const list = f.runtime.store.list.bind(f.runtime.store)
  let injected = 0
  f.runtime.store.list = (table, ...rest) => {
    if (table === 'members' && injected === 0 && new Error().stack.includes('spanContext')) { injected++; throw new Error('members unavailable') }
    return list(table, ...rest)
  }
  const created = await f.call('swarm_workstream', { missionId: f.mission.id, ...stream })
  assert.equal(injected, 1, 'the scope read failed')
  assert.equal(created.result.title, 'Core', 'the tool returns the committed result')
  assert.deepEqual(f.runtime.store.list('workstreams', f.mission.id).map(row => row.id), [created.result.id])
  assert.deepEqual(f.link.counts(), { emitted: 0, failed: 1 }, 'the failed resolution is counted')
  assert.deepEqual(f.spans(), [])
  // Pair: with the store readable again, the same step records its span.
  await f.call('swarm_workstream', { missionId: f.mission.id, title: 'Docs', objective: 'Document the module' })
  assert.deepEqual(f.spans().map(span => span.step), ['swarm_workstream'])
})

test('a prelaunch request with no mission yet is an unscoped call, never a span under the request id', async t => {
  const f = await fixture(t)
  const now = Date.now()
  const request = { id: 'start_trace', ownerSessionId: f.owner.sessionId, commandId: 'trace', goal: 'Trace the request', workspace: f.dir, status: 'planning', createdAt: now, updatedAt: now }
  f.runtime.store.transaction(() => f.runtime.store.put('starts', request))
  assert.equal((await f.call('swarm_observe', { requestId: request.id })).result.request.id, request.id)
  assert.deepEqual(f.spans(request.id), [], 'a request id is not a mission')
  assert.deepEqual(await f.unscoped(), { swarm_observe: 1 })
  // Pair: once the request names its mission, the same read is scoped to it.
  f.runtime.store.transaction(() => f.runtime.store.put('starts', { ...request, missionId: f.mission.id }))
  await f.call('swarm_observe', { requestId: request.id })
  assert.equal(f.spans().filter(span => span.step === 'swarm_observe').length, 2, 'the trace read and this read')
  assert.deepEqual(await f.unscoped(), { swarm_observe: 1 })
})

test('a planning call refused at the workspace binding throws its own error and counts one unscoped call', async t => {
  const f = await fixture(t)
  const fields = { title: 'Unbound', objective: 'Bind the workspace', workspace: f.dir, scope: ['**'], acceptance: ['works'], budget: f.budget }
  const sessionWithoutCwd = { agent: { id: f.owner.sessionId, session: { header: {} } }, signal: new AbortController().signal }
  await assert.rejects(f.definitions.get('swarm_create').execute(fields, sessionWithoutCwd), /^Error: \[session_workspace_missing\]/)
  assert.deepEqual(await f.unscoped(), { swarm_create: 1 }, 'the refused call is recorded, not skipped')
  // Pair: from a session with a workspace the same call creates its mission and records its span there.
  const created = await f.call('swarm_create', fields)
  assert.deepEqual(f.spans(created.result.id).map(span => [span.step, span.status]), [['swarm_create', 'ok']])
  assert.deepEqual(await f.unscoped(), { swarm_create: 1 })
})

test('a failing command whose span write also fails throws the command\'s own error', async t => {
  const f = await fixture(t)
  f.failSpanWrites()
  // Refused by the schema check, before the runtime runs.
  await assert.rejects(f.call('swarm_workstream', { missionId: f.mission.id, title: 'No objective' }),
    /^Error: \[tool_arguments_invalid\] swarm_workstream was called with arguments its parameters schema refuses: `objective` is required/)
  // Refused by the runtime itself: the same error the runtime throws directly.
  const own = (() => { try { f.runtime.cancel(f.owner, f.mission.id, { taskId: 'task_missing', reason: 'withdraw' }) } catch (error) { return error } })()
  assert.ok(own instanceof Error, 'the runtime refuses an unknown task')
  await assert.rejects(f.call('swarm_cancel', { missionId: f.mission.id, taskId: 'task_missing', reason: 'withdraw' }), { message: own.message })
  assert.deepEqual(f.link.counts(), { emitted: 0, failed: 2 }, 'one span write per call, each contained')
  assert.deepEqual(f.spans(), [])
})

test('a wall clock that steps backwards during a command still records an ordered span', async t => {
  const f = await fixture(t)
  const clock = new FakeClock()
  t.mock.method(Date, 'now', clock.now)
  const workstream = f.runtime.workstream.bind(f.runtime)
  f.runtime.workstream = (...args) => { clock.advance(-3_600_000); return workstream(...args) }
  await f.call('swarm_workstream', { missionId: f.mission.id, ...stream })
  const recorded = f.spans().filter(span => span.step === 'swarm_workstream')
  assert.equal(recorded.length, 1)
  assert.ok(recorded[0].endedAt >= recorded[0].startedAt, JSON.stringify(recorded[0]))
  assert.equal(spanContractViolation(recorded[0]), undefined)
})

test('a malformed span id read back from the durable rows is never a parent', async t => {
  const f = await fixture(t)
  f.runtime.store.transaction(() => f.runtime.store.event(f.mission.id, 'trace/span', 'legacy', { spanId: 'NOT-A-SPAN-ID', step: 'swarm_create' }))
  await f.call('swarm_workstream', { missionId: f.mission.id, ...stream })
  const recorded = f.spans().filter(span => span.step === 'swarm_workstream')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].parentSpanId, undefined, 'the malformed row is ignored, so the step is a root')
  assert.equal(spanContractViolation(recorded[0]), undefined)
  // Pair: a well-formed stored span is still the parent of the next step.
  await f.call('swarm_workstream', { missionId: f.mission.id, title: 'Docs', objective: 'Document the module' })
  assert.equal(f.spans().filter(span => span.step === 'swarm_workstream')[1].parentSpanId, recorded[0].spanId)
  // Only parent choice ignores the row: it stays in the metrics window, so the
  // trace report still counts its contract violation (F-44).
  const report = (await f.call('swarm_observe', { missionId: f.mission.id, trace: true })).result.trace
  assert.deepEqual([report.spans, report.window.spans], [3, 3])
  assert.deepEqual(report.violations.map(violation => [violation.spanId, violation.reason]), [['NOT-A-SPAN-ID', 'trace_id must be 32 lowercase hex characters']])
})

test('beyond the span window, a malformed stored parent is ignored too', () => {
  // More rows than the window holds, so parent lookup reads the durable rows.
  const malformed = { type: 'trace/span', data: { spanId: 'NOT-A-SPAN-ID', taskId: 'task', attemptId: 'attempt', step: 'swarm_claim' } }
  const rows = Array.from({ length: 20_001 }, () => malformed)
  const store = { events: () => [], traceEvents: (_missionId, limit) => rows.slice(-limit), event() {}, transaction: body => body() }
  const recorder = new TraceRecorder(store)
  assert.equal(recorder.windowFor('m').truncated, true)
  const scope = { taskId: 'task', attemptId: 'attempt' }
  assert.equal(recorder.parentFor({ step: 'swarm_publish', missionId: 'm', ...scope }), 'NOT-A-SPAN-ID', 'the durable lookup finds the stored row')
  const record = (step, call) => recorder.record(step, () => ({ ...call, missionId: 'm', actor: 'worker', input: {}, output: {}, status: 'ok', startedAt: 0, durationMs: 0 }))
  for (const [step, call] of [['swarm_publish', scope], ['swarm_verify', { taskId: 'review', reviewOfTaskId: 'task' }]]) {
    const span = record(step, call)
    assert.equal(span.parentSpanId, undefined, 'the recorded span treats it as absent')
    assert.equal(spanContractViolation(span), undefined)
  }
})

test('a stored span row whose id is not a string is judged like any malformed row: in the metrics window, never a parent', async t => {
  const f = await fixture(t)
  f.runtime.store.transaction(() => f.runtime.store.event(f.mission.id, 'trace/span', 'legacy', { step: 'swarm_create' }))
  await f.call('swarm_workstream', { missionId: f.mission.id, ...stream })
  assert.equal(f.spans().find(span => span.step === 'swarm_workstream').parentSpanId, undefined)
  const report = (await f.call('swarm_observe', { missionId: f.mission.id, trace: true })).result.trace
  assert.deepEqual([report.spans, report.window.spans], [2, 2], 'the row stays in the metrics window')
  assert.deepEqual(report.violations.map(violation => [violation.step, violation.reason]), [['swarm_create', 'trace_id must be 32 lowercase hex characters']])
  // Parent choice reads it as it reads a malformed string id: the newest row
  // has no valid id, so the next span is a root, not a child of an older span.
  const rows = [{ type: 'trace/span', data: { spanId: '0123456789abcdef', step: 'swarm_create' } }, { type: 'trace/span', data: { step: 'swarm_launch' } }]
  const recorder = new TraceRecorder({ events: () => rows, event() {}, transaction: body => body() })
  const span = recorder.record('swarm_workstream', () => ({ missionId: 'm', actor: 'owner', input: {}, output: {}, status: 'ok', startedAt: 0, durationMs: 0 }))
  assert.equal(span.parentSpanId, undefined)
  assert.deepEqual(recorder.spansFor('m').map(row => row.step), ['swarm_create', 'swarm_launch', 'swarm_workstream'])
})

/** A recorder over `rows`, all inside its span window. */
const windowed = rows => new TraceRecorder({ events: () => rows, event() {}, transaction: body => body() })
/** A recorder over `before` and `after` around more rows of another attempt than the window holds, so parent lookup reads the durable rows by scope. */
function beyondWindow(before, after = []) {
  const filler = { type: 'trace/span', data: { spanId: 'fedcba9876543210', attemptId: 'other', step: 'swarm_publish' } }
  const rows = [...before, ...Array.from({ length: 20_001 }, () => filler), ...after]
  const traceEvents = (_missionId, limit, filter = {}) => rows.filter(row => Object.entries(filter).every(([key, value]) => row.data[key] === value)).slice(-limit)
  const recorder = new TraceRecorder({ events: () => [], traceEvents, event() {}, transaction: body => body() })
  assert.equal(recorder.windowFor('m').truncated, true)
  return recorder
}
const call = scope => () => ({ missionId: 'm', actor: 'worker', ...scope, input: {}, output: {}, status: 'ok', startedAt: 0, durationMs: 0 })

test('an attempt whose stored claim row has no string id gives its next span no parent, in the window and beyond it', () => {
  // The attempt's claim is its scoped parent; a valid publish of the same
  // attempt is only the fallback when no claim row exists.
  const claim = { type: 'trace/span', data: { attemptId: 'a', step: 'swarm_claim' } }
  const publish = { type: 'trace/span', data: { spanId: '0123456789abcdef', attemptId: 'a', step: 'swarm_publish' } }
  const submit = call({ attemptId: 'a' })
  assert.equal(windowed([claim, publish]).record('swarm_submit', submit).parentSpanId, undefined, 'the indexed claim row is the parent, and it has no valid id')
  assert.equal(beyondWindow([], [claim, publish]).record('swarm_submit', submit).parentSpanId, undefined, 'the durable claim row is the parent, and it has no valid id')
})

test('a new proposal whose newest mission-level row has no string id gets no parent, in the window and beyond it', () => {
  // A proposal joins the newest mission-level setup span; an older valid
  // setup row is not a fallback for it.
  const create = { type: 'trace/span', data: { spanId: '0123456789abcdef', step: 'swarm_create' } }
  const launch = { type: 'trace/span', data: { step: 'swarm_launch' } }
  const propose = call({ taskId: 'new' })
  assert.equal(windowed([create, launch]).record('swarm_propose', propose).parentSpanId, undefined, 'the indexed launch row is the parent, and it has no valid id')
  // Beyond the window no setup row is indexed; the durable lookup reads it by step.
  assert.equal(beyondWindow([create, launch]).record('swarm_propose', propose).parentSpanId, undefined, 'the durable launch row is the parent, and it has no valid id')
})

test('a verdict whose reviewed submission row has no string id gets no parent, in the window and beyond it', () => {
  // A verdict joins the reviewed task's submission; a later valid row of that
  // task is only the fallback when no submission row exists.
  const submit = { type: 'trace/span', data: { taskId: 't', attemptId: 'a', step: 'swarm_submit' } }
  const challenge = { type: 'trace/span', data: { spanId: '0123456789abcdef', taskId: 't', step: 'swarm_challenge' } }
  const verify = call({ taskId: 'review', reviewOfTaskId: 't' })
  assert.equal(windowed([submit, challenge]).record('swarm_verify', verify).parentSpanId, undefined, 'the indexed submission row is the parent, and it has no valid id')
  assert.equal(beyondWindow([submit, challenge]).record('swarm_verify', verify).parentSpanId, undefined, 'the durable submission row is the parent, and it has no valid id')
})

test('an agent without an id is refused at the session guard, so a span actor is never empty', async t => {
  const f = await fixture(t)
  await assert.rejects(f.definitions.get('swarm_observe').execute({}, { agent: { id: '' }, signal: new AbortController().signal }), /^Error: \[session_required\]/)
  // Pair: the same call from a session with an id runs.
  assert.ok(Array.isArray((await f.call('swarm_observe', {})).result.missions))
})

test('a committed command whose output snapshot fails records exactly one span, with the command\'s outcome', async t => {
  const f = await fixture(t)
  t.mock.method(f.runtime, 'snapshot', () => { throw new Error('snapshot unavailable') })
  await assert.rejects(f.call('swarm_workstream', { missionId: f.mission.id, ...stream }), /snapshot unavailable/)
  assert.equal(f.runtime.store.list('workstreams', f.mission.id).length, 1, 'the command committed')
  assert.deepEqual(f.spans().map(span => [span.step, span.status]), [['swarm_workstream', 'ok']])
})
