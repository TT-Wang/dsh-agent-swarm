/** F-12/F-13/F-14: verdict and retired-review events, older-event reads and event vocabulary. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVENT_VOCABULARY, eventVocabularyReport, readEventHistory, verdictRows } from '../lib/trace.js'
import { traceFixture } from './fixtures/trace-runtime.mjs'

const UNSURFACED = ['task/cancelled', 'task/checkpointed', 'task/checkpoint-failed', 'task/closeout-nudged', 'task/closeout-abandoned', 'task/closeout-failed', 'task/git-write-denied']
/** Types the runtime emits that the round-4 read path previously did not name. */
const RUNTIME_EMITTED = ['automatic/requested', 'automatic/failed', 'member/failure', 'member/subscribed', 'member/waiting', 'mission/budget-exhausted', 'mission/budget-quiesced', 'mission/budget-warning', 'plan/edited', 'plan/launched', 'plan/staged', 'task/budget-resumed', 'task/lease-expiring', 'task/ceiling-exhausted']

test('F-12: the verdict event names the evidence, the verdict and the retired reviews', async t => {
  const f = await traceFixture(t)
  const events = f.events()
  // Normalized client contract from the tool layer: { evidenceId, verdict, retired }.
  const verdicts = events.filter(event => event.type === 'evidence/verdict')
  assert.equal(verdicts.length, 1, 'one normalized verdict row per evidence id')
  const verdict = verdicts[0].data
  assert.equal(verdict.evidenceId, f.task(f.source.id).evidenceIds[0])
  assert.equal(verdict.verdict, 'verified')
  assert.equal(verdict.outcome, 'supported')
  assert.equal(verdict.taskId, f.source.id)
  assert.equal(verdict.verificationTaskId, f.review.id)
  assert(Array.isArray(verdict.retired))

  // T1's runtime adds evidence/verified|refuted and running-sibling retirement.
  // When those capabilities are present the normalized row must name the
  // retired sibling; verdictRows is unit-tested below so the mapping holds on
  // every baseline, and the vocabulary test below proves the read path surfaces
  // the retired-review event itself.
  const retired = events.filter(event => event.type === 'task/review-retired')
  const verified = events.filter(event => event.type === 'evidence/verified')
  if (retired.length || verified.length) {
    assert.equal(retired.length, 1, 'the verdict retires exactly the sibling review')
    assert.equal(retired[0].data.taskId, f.review2.id)
    assert.equal(retired[0].data.reviewOf, f.source.id)
    assert.equal(retired[0].data.ownerId, f.reviewer2.id)
    assert.deepEqual(verdict.retired, [f.review2.id], 'the cancelled sibling review is named in the verdict event')
    assert.equal(verified[0].data.evidenceId, verdict.evidenceId)
    assert.equal(f.runtime.store.get('tasks', f.review2.id).status, 'cancelled')
  }
})

test('verdictRows maps every evidence id and retired sibling into the client contract', () => {
  const rows = verdictRows({ sourceTaskId: 'task-1', verificationTaskId: 'task-2', verdict: 'refuted', reason: 'checks failed',
    evidence: [{ id: 'evidence-1', outcome: 'supported' }, { id: 'evidence-2', outcome: 'inconclusive' }], retired: ['review-9'] })
  assert.deepEqual(rows.map(row => [row.evidenceId, row.verdict, row.retired, row.taskId, row.verificationTaskId]),
    [['evidence-1', 'refuted', ['review-9'], 'task-1', 'task-2'], ['evidence-2', 'refuted', ['review-9'], 'task-1', 'task-2']])
})

test('F-13: the read path pages older events with a before cursor instead of tail-only', async t => {
  const f = await traceFixture(t)
  const total = f.events().length
  const newest = readEventHistory(f.runtime.store, f.missionId, { limit: 4 })
  assert.equal(newest.events.length, 4)
  assert.equal(newest.total, total)
  assert.equal(newest.events.at(-1).seq, f.events().at(-1).seq, 'the first page is the newest window')
  assert.equal(newest.hasOlder, true)
  assert.equal(newest.nextBefore, newest.events[0].seq)

  const older = readEventHistory(f.runtime.store, f.missionId, { before: newest.nextBefore, limit: 4 })
  assert(older.events.length > 0)
  assert(older.events.every(event => event.seq < newest.nextBefore), 'older pages are strictly before the cursor')
  assert.equal(older.events.at(-1).seq, newest.nextBefore - 1)

  // Walking the cursor reaches the beginning and preserves full durable data.
  const seen = []
  let cursor
  for (let page = 0; page < 50; page++) {
    const history = readEventHistory(f.runtime.store, f.missionId, { ...(cursor === undefined ? {} : { before: cursor }), limit: 5 })
    seen.push(...history.events)
    if (history.nextBefore === undefined) break
    cursor = history.nextBefore
  }
  assert.equal(seen.length, total, 'every retained event is reachable')
  const verdict = seen.find(event => event.type === 'evidence/verdict')
  assert(verdict, 'older pages still carry verdict events')
  assert(Array.isArray(verdict.data.retired), 'history returns the complete event data, not an excerpt')

  // The model tool exposes the same older-event read and vocabulary report.
  const tool = (await f.raw('swarm_observe', { missionId: f.missionId, before: newest.nextBefore, eventLimit: 3, vocabulary: true }, f.owner)).result
  assert.equal(tool.events.length, 3)
  assert.equal(tool.events.at(-1).seq, newest.nextBefore - 1)
  assert(tool.historyWindow.total === total && tool.historyWindow.hasOlder === true)
  assert(tool.eventVocabulary.recognized.includes('task/claimed'))
})

test('F-14: every previously unsurfaced event type is recognized by the read path', () => {
  for (const type of UNSURFACED) assert(EVENT_VOCABULARY[type], `${type} must be named in the vocabulary`)
  for (const type of RUNTIME_EMITTED) assert(EVENT_VOCABULARY[type], `${type} must be named in the vocabulary`)
  for (const type of ['evidence/verified', 'evidence/refuted', 'evidence/verdict', 'task/review-retired', 'trace/span']) assert(EVENT_VOCABULARY[type], `${type} must be named in the vocabulary`)
  const synthetic = [...UNSURFACED, ...RUNTIME_EMITTED].map((type, index) => ({ seq: index + 1, missionId: 'm', type, actor: 'runtime', data: { reason: `${type} reason` }, createdAt: Date.now() }))
  const report = eventVocabularyReport(synthetic)
  assert.deepEqual(report.unrecognized, [], 'no emitted type is unknown')
  assert.deepEqual([...report.recognized].sort(), [...UNSURFACED, ...RUNTIME_EMITTED].sort())
  for (const item of report.types) assert.equal(typeof item.description, 'string')
  const unknown = eventVocabularyReport([{ seq: 1, missionId: 'm', type: 'future/event', actor: 'runtime', data: {}, createdAt: Date.now() }])
  assert.deepEqual(unknown.unrecognized, ['future/event'], 'unknown types are reported, never silently dropped')
})
