import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmStore } from '../lib/store.js'
import { TraceRecorder, ReplayTruncationError, orchestratorCommands, traceMetrics, readEventHistory, traceIdFor, traceparentFor, spanOperation, digestText } from '../lib/trace.js'
import { traceFixture } from './fixtures/trace-runtime.mjs'

const ref = { digest: digestText('{}'), bytes: 2, stored: false }
const span = (number, step, extra = {}) => {
  const spanId = number.toString(16).padStart(16, '0'), traceId = traceIdFor('m')
  return { traceId, spanId, traceparent: traceparentFor(traceId, spanId), missionId: 'm', step,
    operation: spanOperation(step), status: 'ok', actor: 'owner', startedAt: 1, endedAt: 2, input: ref, output: ref, ...extra }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-r12-trace-'))
  const store = new SwarmStore(join(root, 'state.sqlite'))
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  return { store }
}

test('M1-T1: restart seeds bounded trace rows despite more than 20,000 newer ordinary events', async t => {
  const f = await fixture(t)
  const proposed = span(1, 'swarm_propose', { taskId: 'task' })
  const claimed = span(2, 'swarm_claim', { taskId: 'task', attemptId: 'attempt', parentSpanId: proposed.spanId })
  f.store.transaction(() => {
    f.store.event('m', 'trace/span', 'owner', proposed)
    f.store.event('m', 'trace/span', 'worker', claimed)
    for (let i = 0; i < 20_010; i++) f.store.event('m', 'member/activity', 'worker', { index: i })
  })
  const recorder = new TraceRecorder(f.store)
  assert.equal(recorder.parentFor({ step: 'swarm_publish', missionId: 'm', taskId: 'task', attemptId: 'attempt' }), claimed.spanId)
  assert.deepEqual(recorder.spansFor('m').map(span => span.spanId), [proposed.spanId, claimed.spanId])
  assert.equal(recorder.windowFor('m').truncated, false)
  assert.equal(recorder.windowFor('m').source, 'trace-spans')
})

test('M1-T1: older scoped parents remain correct beyond the span window and metrics label partial history', async t => {
  const f = await fixture(t)
  const proposed = span(1, 'swarm_propose', { taskId: 'source' })
  const claimed = span(2, 'swarm_claim', { taskId: 'source', attemptId: 'old-attempt' })
  const submitted = span(3, 'swarm_submit', { taskId: 'source', attemptId: 'old-attempt' })
  f.store.transaction(() => {
    for (const value of [proposed, claimed, submitted]) f.store.event('m', 'trace/span', 'worker', value)
    for (let i = 4; i <= 20_010; i++) f.store.event('m', 'trace/span', 'worker', span(i, 'swarm_publish', { taskId: 'unrelated', attemptId: 'other-attempt' }))
  })
  const reads = [], original = f.store.traceEvents.bind(f.store)
  f.store.traceEvents = (...args) => { reads.push(args); return original(...args) }
  const recorder = new TraceRecorder(f.store)
  assert.equal(recorder.parentFor({ step: 'swarm_publish', missionId: 'm', taskId: 'source', attemptId: 'old-attempt' }), claimed.spanId)
  assert.equal(recorder.parentFor({ step: 'swarm_verify', missionId: 'm', taskId: 'review', reviewOfTaskId: 'source' }), submitted.spanId)
  assert.equal(recorder.parentFor({ step: 'swarm_claim', missionId: 'm', taskId: 'source' }), submitted.spanId)
  assert.equal(recorder.parentFor({ step: 'swarm_publish', missionId: 'm', taskId: 'missing', attemptId: 'missing-attempt' }), undefined, 'missing scoped provenance never borrows an unrelated latest span')
  assert.equal(recorder.parentFor({ step: 'swarm_claim', missionId: 'm', taskId: 'missing' }), undefined)
  assert.equal(recorder.spansFor('m').length, 20_000)
  const metrics = await traceMetrics(recorder.spansFor('m'), { window: recorder.windowFor('m') })
  assert.equal(metrics.window.truncated, true)
  assert.equal(metrics.window.limit, 20_000)
  assert.equal(metrics.window.spans, metrics.spans)
  assert.ok(reads.every(([, limit]) => limit === 20_001 || limit === 1), 'no unbounded history scan')
  await recorder.record({ missionId: 'm', actor: 'worker', step: 'swarm_publish', taskId: 'source', attemptId: 'old-attempt', input: {}, output: {}, status: 'ok', startedAt: Date.now() })
  assert.equal(recorder.spansFor('m').length, 20_000, 'live recording also keeps the index bounded')
  assert.equal(recorder.spansFor('m').at(-1).parentSpanId, claimed.spanId)
})

test('M1-T1: observer metrics expose window completeness through the actual tool result', async t => {
  const f = await traceFixture(t)
  const result = await f.call('swarm_observe', { missionId: f.missionId, trace: true }, f.owner)
  assert.equal(result.trace.window.truncated, false)
  assert.equal(result.trace.window.source, 'trace-spans')
  assert.equal(result.trace.window.spans, result.trace.spans)
})

test('M1-T2: a later dispatch cannot hide a missing close for an earlier attempt of the same task', () => {
  const event = (seq, type, data) => ({ seq, missionId: 'm', type, data, actor: 'worker', createdAt: seq })
  const claim = (seq, id) => event(seq, 'task/claimed', { taskId: 'task', attempt: { id, ownerId: 'worker', epoch: seq } })
  const missing = [claim(1, 'first'), claim(2, 'second'), event(3, 'task/submitted', { taskId: 'task' })]
  assert.throws(() => orchestratorCommands(missing), error => error instanceof ReplayTruncationError && error.unresolved[0] === 'task#first')
  assert.throws(() => orchestratorCommands([claim(1, 'first'), claim(2, 'first'), event(3, 'task/submitted', { taskId: 'task' })]), ReplayTruncationError)
  const complete = [claim(1, 'first'), event(2, 'task/restart-repended', { taskId: 'task' }), claim(3, 'second'), event(4, 'task/submitted', { taskId: 'task' })]
  assert.deepEqual(orchestratorCommands(complete).unresolved, [])
  assert.equal(orchestratorCommands(complete).commands.filter(command => command.kind === 'dispatch').length, 2)
})

test('M1-T3: history distinguishes exactly 100,000 retained events from an actually truncated window', () => {
  const rows = Array.from({ length: 100_001 }, (_, index) => ({ seq: index + 1, missionId: 'm', type: 'event', actor: 'worker', data: {}, createdAt: index }))
  for (const count of [100_000, 100_001]) {
    const calls = [], store = { events(_mission, limit) { calls.push(limit); return rows.slice(0, count).slice(-limit) } }
    const history = readEventHistory(store, 'm', { limit: 3 })
    assert.equal(history.truncated, count > 100_000)
    assert.equal(history.total, 100_000, 'the sentinel is not reported as part of the retained window')
    assert.equal(history.events.at(-1).seq, count)
    assert.deepEqual(calls, [100_001])
  }
})
