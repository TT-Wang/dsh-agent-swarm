/** D6 span contract: closed vocabulary, digest-addressed payloads, causal closure and metrics. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SWARM_TOOLS } from '../lib/tools.js'
import { TRACE_OPERATIONS, TRACE_STEPS, TRACE_ERROR_TYPES, isTraceOperation, isTraceStep, spanContractViolation, traceIdFor, traceMetrics, digestText } from '../lib/trace.js'
import { traceFixture } from './fixtures/trace-runtime.mjs'

test('the span vocabulary is closed and covers every orchestration step', () => {
  assert.deepEqual([...TRACE_OPERATIONS], ['agent', 'tool', 'llm', 'retrieval', 'review', 'merge'])
  for (const tool of SWARM_TOOLS) assert(TRACE_STEPS.includes(tool), `${tool} must be a closed-enum trace step`)
  assert(!isTraceOperation('bogus')); assert(!isTraceStep('swarm_bogus'))
  assert(TRACE_ERROR_TYPES.includes('validation_error'))
})

test('every orchestration step emits a contract-valid span with digests outside the log', async t => {
  const f = await traceFixture(t)
  const spans = f.events().filter(event => event.type === 'trace/span').map(event => event.data)
  assert(spans.length >= 12, `expected a span per orchestration step, saw ${spans.length}`)
  for (const span of spans) assert.equal(spanContractViolation(span), undefined, JSON.stringify(span))
  const find = (step, match) => {
    const span = spans.find(candidate => candidate.step === step && Object.entries(match).every(([key, value]) => candidate[key] === value))
    assert(span, `missing ${step} span for ${JSON.stringify(match)}`)
    return span
  }
  const create = find('swarm_create', {})
  const lastAddMember = spans.filter(span => span.step === 'swarm_add_member').at(-1)
  const sourcePropose = find('swarm_propose', { taskId: f.source.id })
  const sourceClaim = find('swarm_claim', { attemptId: f.claim.attempt.id })
  const publish = find('swarm_publish', { attemptId: f.claim.attempt.id })
  const submit = find('swarm_submit', { attemptId: f.claim.attempt.id })
  const verify = find('swarm_verify', { taskId: f.review.id })

  // Closed-enum operation mapping and W3C trace context shared by every hop.
  assert.equal(create.operation, 'agent')
  assert.equal(sourcePropose.operation, 'tool')
  assert.equal(sourceClaim.operation, 'agent')
  assert.equal(verify.operation, 'review')
  const traceId = traceIdFor(f.missionId)
  for (const span of spans) {
    assert.equal(span.traceId, traceId, 'worker hops join the orchestrator trace')
    assert.equal(span.traceparent, `00-${span.traceId}-${span.spanId}-01`)
  }

  // Causal closure across worker hops: root -> proposal -> claim -> worker -> verdict.
  assert.equal(create.parentSpanId, undefined)
  assert.equal(sourcePropose.parentSpanId, lastAddMember.spanId)
  assert.equal(sourceClaim.parentSpanId, sourcePropose.spanId)
  assert.equal(publish.parentSpanId, sourceClaim.spanId)
  assert.equal(submit.parentSpanId, sourceClaim.spanId)
  assert.equal(verify.parentSpanId, submit.spanId, 'the reviewer joins the reviewed submission')
  const ids = new Set(spans.map(span => span.spanId))
  for (const span of spans) if (span.parentSpanId !== undefined) assert(ids.has(span.parentSpanId), `orphan parent ${span.parentSpanId}`)

  // Payloads are content-addressed outside the log: the log holds only digests.
  assert.equal(await f.payloads.verify(publish.input), true)
  assert.equal(await f.payloads.verify(publish.output), true)
  const input = await f.payloads.read(publish.input.digest)
  assert.match(input, /swarm_publish/)
  assert(input.includes(f.bigClaim), 'the input payload file carries the claim bytes')
  const spanLog = JSON.stringify(f.events().filter(event => event.type === 'trace/span'))
  assert(!spanLog.includes(f.bigClaim), 'payload bytes must never enter the event log')
  assert.equal(digestText(input), publish.input.digest)

  // Trace-level metrics (F-44).
  const metrics = await traceMetrics(spans, { payloads: f.payloads })
  assert.equal(metrics.contractCompliance, 1)
  assert.equal(metrics.firstViolatingStep, undefined)
  assert.equal(metrics.causalClosure, 1)
  assert.equal(metrics.orphanParents, 0)
  assert(metrics.payloads.stored > 0)
  assert.equal(metrics.payloads.verified, metrics.payloads.stored)
  assert.equal(metrics.payloads.missing, 0)
  assert.equal(metrics.operations.agent > 0 && metrics.operations.review > 0, true)
})

test('a failed orchestration step records an error span with a closed error.type', async t => {
  const f = await traceFixture(t)
  const before = f.events().length
  await assert.rejects(f.raw('swarm_claim', { missionId: f.missionId, taskId: f.review2.id }, f.builder.sessionId), /not ready/)
  const spans = f.events().slice(before).filter(event => event.type === 'trace/span').map(event => event.data)
  assert.equal(spans.length, 1)
  assert.equal(spans[0].status, 'error')
  assert(TRACE_ERROR_TYPES.includes(spans[0].errorType), `closed error.type, got ${spans[0].errorType}`)
  assert.equal(spanContractViolation(spans[0]), undefined)
  // Compliance is measured over the whole window; the error row is well-formed.
  const all = f.events().filter(event => event.type === 'trace/span').map(event => event.data)
  const metrics = await traceMetrics(all, { payloads: f.payloads })
  assert.equal(metrics.contractCompliance, 1, 'a well-formed error span still satisfies the contract')
  assert.equal(metrics.operations.agent > 0, true)
})
