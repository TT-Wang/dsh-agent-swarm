/**
 * F3b: the normalized `evidence/verdict` row must record the runtime outcome,
 * never the requested tool verdict.
 *
 * Round-8 benchmark shape: a reviewer calls `swarm_verify` with verdict=accept
 * while the declared check cannot run (exit 127). The runtime honestly blocks
 * the source and emits `evidence/refuted`, but the tool layer used to emit a
 * normalized `evidence/verdict {verdict:"verified"}` for the same evidence id
 * afterwards. `durableVerdicts` then projects the later row as that evidence's
 * latest verdict, so one evidence id is simultaneously refuted and verified.
 * These tests drive the real tool-level `swarm_verify` through registerTools +
 * execute, exactly as the model does.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { durableVerdicts } from '../lib/types/client/projection.js'
import { traceFixture } from './fixtures/trace-runtime.mjs'

const FAILING_CHECK = [{ command: 'npm run typecheck && npm run build', exitCode: 127, output: 'sh: npm: command not found' }]
const rowsFor = (f, evidenceId) => f.events().filter(event => event.type === 'evidence/verdict' && event.data.evidenceId === evidenceId)

test('F3b: an accepted tool verdict whose declared check fails emits exactly one refuted normalized row', async t => {
  const f = await traceFixture(t, { checks: FAILING_CHECK })
  const source = f.task(f.source.id)
  const evidenceId = source.evidenceIds[0]
  assert.ok(evidenceId !== undefined, 'the fixture publishes exactly one claim to normalize')

  // The requested verdict was accept, but the durable outcome is a rejection:
  // the runtime blocked the source and recorded a refutation, never a verification.
  const events = f.events()
  const refuted = events.filter(event => event.type === 'evidence/refuted' && event.data.evidenceId === evidenceId)
  const verified = events.filter(event => event.type === 'evidence/verified' && event.data.evidenceId === evidenceId)
  assert.equal(refuted.length, 1, 'the runtime records exactly one refutation for the evidence id')
  assert.equal(verified.length, 0, 'a failed declared check never verifies evidence')
  assert.equal(source.status, 'blocked', 'the failed check blocks the reviewed source')
  assert.notEqual(f.task(f.review.id).status, 'accepted', 'the verification task itself is not accepted')

  // Exactly one normalized row, and it carries the runtime outcome.
  const rows = rowsFor(f, evidenceId)
  assert.equal(rows.length, 1, 'one normalized verdict row per evidence id')
  const row = rows[0].data
  const outcome = events.find(event => (event.type === 'task/accepted' || event.type === 'task/rejected') && event.data.verificationTaskId === f.review.id)
  assert.ok(outcome, 'the runtime records an accepted/rejected outcome event for this verification')
  assert.equal(outcome.type, 'task/rejected', 'the durable outcome event for this verification is a rejection')
  assert.equal(row.verdict, outcome.type === 'task/accepted' ? 'verified' : 'refuted', 'the normalized row follows the durable outcome event')
  assert.equal(row.verdict, 'refuted', 'the normalized row must not contradict the runtime evidence/refuted event')
  assert.equal(row.evidenceId, evidenceId)
  assert.equal(row.taskId, f.source.id)
  assert.equal(row.verificationTaskId, f.review.id)

  // The row agrees with the stored evidence status. The stored status is the
  // runtime's refuted-family status: `challenged` on baselines that predate the
  // F3 status rename, `refuted` once that fix lands. It is never `verified`.
  const evidence = f.runtime.store.get('evidence', evidenceId)
  assert.notEqual(evidence.status, 'verified', 'refuted evidence must not be stored as verified')
  assert.ok(['refuted', 'challenged'].includes(evidence.status), `unexpected refuted evidence status ${evidence.status}`)

  // The client projection resolves each evidence id to its latest verdict
  // event, so this tool-layer row is the one whose data wins for the id: before
  // the fix that was the contradictory `verified` row.
  const projected = durableVerdicts({ events }).get(evidenceId)
  assert.equal(projected.type, 'evidence/verdict', 'the normalized row is the latest verdict event for the id')
  assert.equal(events.find(event => event.seq === projected.seq).data.verdict, 'refuted')
})

test('F3b: an accepted tool verdict with passing checks still emits one verified normalized row', async t => {
  const f = await traceFixture(t)
  const evidenceId = f.task(f.source.id).evidenceIds[0]
  const rows = rowsFor(f, evidenceId)
  assert.equal(rows.length, 1, 'one normalized verdict row per evidence id')
  assert.equal(rows[0].data.verdict, 'verified', 'the F-12 contract is unchanged for accepted verifications')
  assert.equal(f.runtime.store.get('evidence', evidenceId).status, 'verified')
})

test('F3b: a rejected tool verdict with passing checks emits one refuted normalized row', async t => {
  const f = await traceFixture(t, { verdict: 'reject', reason: 'Independent reject despite passing checks' })
  const evidenceId = f.task(f.source.id).evidenceIds[0]
  const rows = rowsFor(f, evidenceId)
  assert.equal(rows.length, 1, 'one normalized verdict row per evidence id')
  assert.equal(rows[0].data.verdict, 'refuted', 'a requested reject stays refuted even when the checks pass')
  assert.notEqual(f.runtime.store.get('evidence', evidenceId).status, 'verified')
})
