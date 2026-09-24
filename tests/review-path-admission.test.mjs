/** F2 unit coverage for the shared review-path predicate and its diagnostic. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDiagnostic, liveReviewFor, missingReviewDiagnostic } from '../lib/admission.js'

const pending = extra => ({ id: 'review-1', kind: 'verification', status: 'pending', reviewOf: 'source-1', ...extra })
/** A source authored by `assigneeId`; independence is decided by `canOwnReview` over its whole author set. */
const source = (assigneeId, extra = {}) => ({ id: 'source-1', assigneeId, ...extra })

test('only an independent, still-startable verification counts as a live review path', () => {
  const live = new Set(['reviewer'])
  assert.equal(liveReviewFor([pending({ assigneeId: 'reviewer' })], source('author'), live).id, 'review-1')
  assert.equal(liveReviewFor([pending({})], source('author'), live).id, 'review-1', 'an unassigned review is live for every independent member')
  assert.equal(liveReviewFor([pending({ status: 'running' })], source('author'), live).id, 'review-1')
  assert.equal(liveReviewFor([pending({ assigneeId: 'reviewer' })], source('reviewer'), live), undefined, 'the source author cannot review itself')
  assert.equal(liveReviewFor([pending({})], source('author', { priorOwnerIds: ['reviewer'] }), live), undefined, 'a prior owner of the source is an author too')
  assert.equal(liveReviewFor([pending({ assigneeId: 'retired' })], source('author'), live), undefined, 'a review pinned to a retired member cannot start')
  assert.equal(liveReviewFor([pending({ status: 'cancelled' })], source('author'), live), undefined)
  assert.equal(liveReviewFor([pending({ status: 'accepted' })], source('author'), live), undefined)
  assert.equal(liveReviewFor([pending({ status: 'blocked' })], source('author'), live), undefined, 'a parked review is not live unless the caller marks its quiescence transition')
  assert.equal(liveReviewFor([pending({ status: 'blocked' })], source('author'), live, review => review.status !== 'cancelled').id, 'review-1')
  assert.equal(liveReviewFor([pending({ reviewOf: 'source-2' })], source('author'), live), undefined, 'a review of another source is not a path')
  assert.equal(liveReviewFor([pending({ kind: 'implementation' })], source('author'), live), undefined)
  assert.equal(liveReviewFor([], source('author'), live), undefined)
})

test('the missing-review diagnostic is machine-checkable and names the task', () => {
  const diagnostic = missingReviewDiagnostic('task_1', 'no live review')
  assert.equal(diagnostic.code, 'review_path_missing')
  assert.equal(diagnostic.location, 'task "task_1"')
  assert.equal(formatDiagnostic(diagnostic), '[review_path_missing] task "task_1": no live review')
})
