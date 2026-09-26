/**
 * Acceptance by reference: a mission criterion is identified by its position
 * (`criterionId`), a deliverable cites the ids it satisfies in `covers`, and the
 * host derives what each worker and reviewer checks (`checklist`) and what a
 * deliverable answers for (`criteriaOf`) through review and replacement
 * lineage, so no criterion text is ever copied from one row to another.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { taskGraphIndex } from '../lib/task-graph.js'
import { criterionId } from '../lib/types.js'

const criteria = ['value is two', 'docs mention two', 'no other file changes']
const row = (id, extra = {}) => ({ id, missionId: 'm', workstreamId: 's', title: id, objective: id, kind: 'implementation', status: 'pending', dependencies: [], scope: ['src/'], acceptance: [], checks: [], priority: 50, experiment: false, epoch: 0, evidenceIds: [], createdAt: 1, ...extra })

test('a criterion id is its position in the mission list, counted from c1', () => {
  assert.deepEqual(criteria.map((_, index) => criterionId(index)), ['c1', 'c2', 'c3'])
})

test('a deliverable answers for its own covers and those of every task it replaces, both parents of a two-parent repair included', () => {
  const graph = taskGraphIndex([
    row('a', { status: 'blocked', covers: ['c1'] }), row('b', { status: 'cancelled', covers: ['c3'] }),
    row('repair', { covers: ['c2'], replaces: ['a', 'b'] }), row('review', { kind: 'verification', reviewOf: 'repair', covers: ['c1', 'c2', 'c3'] }),
  ])
  assert.deepEqual([...graph.criteriaOf('repair')].sort(), ['c1', 'c2', 'c3'])
  assert.deepEqual([...graph.criteriaOf('a')], ['c1'], 'a replaced task answers only for itself')
  assert.deepEqual([...graph.criteriaOf('unknown')], [])
})

test('a deliverable checks its covered criteria in mission order, then the own criteria of its lineage, each once', () => {
  const graph = taskGraphIndex([
    row('a', { status: 'blocked', covers: ['c3'], acceptance: ['keeps the API'] }),
    row('repair', { covers: ['c1'], acceptance: ['adds a test', 'keeps the API'], replaces: ['a'] }),
  ])
  assert.deepEqual(graph.checklist('repair', criteria), ['value is two', 'no other file changes', 'adds a test', 'keeps the API'])
})

test('a review checks its source\'s checklist, then its own review-only criteria', () => {
  const graph = taskGraphIndex([
    row('source', { covers: ['c2'], acceptance: ['adds a test'] }),
    row('review', { kind: 'verification', reviewOf: 'source', acceptance: ['reads the diff', 'adds a test'] }),
  ])
  assert.deepEqual(graph.checklist('review', criteria), ['docs mention two', 'adds a test', 'reads the diff'])
})

test('a copy-era row without covers checks exactly its stored list, and so does the review the host added with a copy of it', () => {
  // Before ids, a deliverable stored the mission text, and a repair stored the
  // union of its predecessors' lists and its own, in that order.
  const stored = ['value is two', 'adds a test']
  const graph = taskGraphIndex([
    row('a', { status: 'blocked', acceptance: ['value is two'] }),
    row('repair', { acceptance: stored, replaces: ['a'] }),
    row('review', { kind: 'verification', reviewOf: 'repair', acceptance: [...stored] }),
  ])
  assert.deepEqual(graph.checklist('repair', criteria), stored)
  assert.deepEqual(graph.checklist('review', criteria), stored)
})
