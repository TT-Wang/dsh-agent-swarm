/**
 * M-3: a trace span is valid by construction, so recording it cannot change a
 * command's result.
 *
 * Driven through the real tool wrapper (`registerTools`) on a real runtime
 * (`makeRuntime`). Every clause of the D6 span contract now holds where its
 * value is made: the mission scope is an existing mission row (anything else
 * is an unscoped call), the actor is the id the session guard requires,
 * `endedAt` is `startedAt` plus a monotonic duration, and a parent read back
 * from the durable rows is used only when it is a valid span id. Recording then
 * has one failure policy for every sink, the host telemetry link's: a failed
 * write is contained and counted (`bindHostTelemetry(runtime).counts()`),
 * never thrown. The wrapper settles the command once, records exactly one span
 * with that outcome and rethrows exactly the command's own error.
 *
 * PRE-CHANGE FAILURE (a65f837): an empty missionId throws a TraceContractError
 * instead of the command's error, and an unknown one writes a span under a
 * mission that does not exist; a failing span write turns a committed command
 * into a tool error and replaces a failing command's error; a wall clock that
 * steps back mid-command throws a TraceContractError; a malformed stored span id
 * becomes a parent and throws; an agent with an empty id passes the session
 * guard; a snapshot failure after a committed command records a second, error
 * span.
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
  const mission = f.runtime.create(owner, { title: 'Trace', objective: 'Record every call', workspace: f.dir, scope: ['**'], acceptance: ['works'], budget: f.budget })
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.budget)
  const exec = (sessionId = owner.sessionId) => ({ agent: { id: sessionId, session: { header: { cwd: f.dir } } }, signal: new AbortController().signal })
  const call = (name, args, sessionId) => definitions.get(name).execute(args, exec(sessionId))
  const spans = (missionId = mission.id) => f.runtime.store.events(missionId, 1000, 0).filter(event => event.type === 'trace/span').map(event => event.data)
  const unscoped = async () => (await call('swarm_observe', { missionId: mission.id, trace: true })).result.trace.unscopedSteps
  /** Every durable span write fails from here on; the runtime's own events still commit. */
  const failSpanWrites = () => {
    const write = f.runtime.store.event.bind(f.runtime.store)
    f.runtime.store.event = (missionId, type, ...rest) => {
      if (type === 'trace/span') throw new Error('span store unavailable')
      return write(missionId, type, ...rest)
    }
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
  f.failSpanWrites()
  const created = await f.call('swarm_workstream', { missionId: f.mission.id, ...stream })
  assert.equal(created.result.title, 'Core', 'the tool returns the committed result')
  assert.deepEqual(f.runtime.store.list('workstreams', f.mission.id).map(row => row.id), [created.result.id])
  assert.deepEqual(f.link.counts(), { emitted: 0, failed: 1 }, 'exactly one span write was attempted, and its failure is counted')
  assert.deepEqual(f.spans(), [])
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
})

test('beyond the span window, a malformed stored parent is ignored too', () => {
  // More rows than the window holds, so parent lookup reads the durable rows.
  const malformed = { type: 'trace/span', data: { spanId: 'NOT-A-SPAN-ID', taskId: 'task', attemptId: 'attempt', step: 'swarm_claim' } }
  const rows = Array.from({ length: 20_001 }, () => malformed)
  const store = { events: () => [], traceEvents: (_missionId, limit) => rows.slice(-limit), event() {}, transaction: body => body() }
  const recorder = new TraceRecorder(store)
  assert.equal(recorder.windowFor('m').truncated, true)
  assert.equal(recorder.parentFor({ step: 'swarm_publish', missionId: 'm', taskId: 'task', attemptId: 'attempt' }), undefined)
  assert.equal(recorder.parentFor({ step: 'swarm_verify', missionId: 'm', taskId: 'review', reviewOfTaskId: 'task' }), undefined)
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
