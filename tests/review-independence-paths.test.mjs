/**
 * Reviewer independence has one rule, `canOwnReview` over `authorIdsOf`
 * (src/assignment.ts), and every assignment path applies it. The Round-18 bug
 * was one path (swarm_handoff) that forgot its own copy of the check, so each
 * path gets its own test here. The reviewer offered at each path is a PRIOR
 * owner of the source, never its current assignee or attempt owner, so a path
 * that checked only the latest owner would admit it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { authorIdsOf, canOwnReview } from '../lib/assignment.js'
import { arenaView, pendingReadiness } from '../lib/arena.js'
import { validatePlan } from '../lib/plans.js'
import { boardIndex } from '../lib/types/client/projection.js'
import { FakeClock, MISSION_ACCEPTANCE, setup, taskOf } from './faults/harness.mjs'

const coded = code => error => { assert.equal(error.code, code, error.message); return true }

/** A submitted source whose author is `author` and whose earlier attempt `prior` owned. */
async function coauthored(t) {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const prior = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Prior', role: 'implementation', maxOutputTokens: 5_000 })
  const created = f.propose({ title: 'Co-authored change' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, created.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: created.id, attemptId: claimed.attempt.id, output: 'candidate' })
  // The durable record a handoff, lease expiry or reroute leaves behind
  // (tests/prior-owner-independence.test.mjs pins each of those recorders).
  const row = taskOf(f.runtime, created.id)
  row.priorOwnerIds = [prior.id]
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', row))
  const source = taskOf(f.runtime, created.id)
  assert.equal(source.status, 'submitted')
  assert.notEqual(source.assigneeId, prior.id, 'the prior owner is not the current assignee')
  assert.notEqual(source.attempt?.ownerId, prior.id, 'nor the current attempt owner')
  const review = (extra = {}) => f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Review', objective: 'Independent review',
    kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, ...extra })
  /** Leave only the source's authors live, so no independent member remains. */
  const stopReviewer = () => {
    const member = f.runtime.store.get('members', f.reviewer.id)
    member.phase = 'stopped'
    f.runtime.store.transaction(() => f.runtime.store.put('members', member))
  }
  return { ...f, prior, source, review, stopReviewer }
}

test('authorIdsOf is the assignee, the attempt owner and every prior owner; canOwnReview excludes exactly them', () => {
  const source = { assigneeId: 'assignee', attempt: { ownerId: 'running' }, priorOwnerIds: ['first', 'second'] }
  assert.deepEqual([...authorIdsOf(source)].sort(), ['assignee', 'first', 'running', 'second'])
  for (const author of authorIdsOf(source)) assert.equal(canOwnReview(source, author), false, author)
  assert.equal(canOwnReview(source, 'independent'), true)
  assert.equal(canOwnReview(undefined, 'anyone'), true, 'a task that reviews nothing excludes no one')
  assert.deepEqual([...authorIdsOf({})], [], 'an untouched task has no author')
})

test('propose: a review cannot be admitted for a prior owner of its source', async t => {
  const f = await coauthored(t)
  assert.throws(() => f.review({ assigneeId: f.prior.id }), coded('review_assignee_not_independent'))
  assert.equal(f.review({ assigneeId: f.reviewer.id }).assigneeId, f.reviewer.id, 'an independent assignee is admitted')
})

test('claim (capabilityBlocker): a prior owner cannot claim an open review of its source', async t => {
  const f = await coauthored(t)
  const open = f.review()
  await assert.rejects(f.runtime.claim(f.actor(f.prior), f.mission.id, open.id), /authored review source/)
  assert.equal(f.runtime.scheduling.capable(taskOf(f.runtime, open.id), f.prior), false, 'the dispatcher and reroute share the refusal')
  assert.equal(f.runtime.scheduling.capable(taskOf(f.runtime, open.id), f.reviewer), true)
})

test('handoff: a review cannot be handed to a prior owner of its source', async t => {
  const f = await coauthored(t)
  const review = f.review({ assigneeId: f.reviewer.id })
  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  assert.throws(() => f.runtime.handoff(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimed.attempt.id, to: f.prior.id, summary: 'over to you' }),
    coded('review_independence_required'))
  assert.equal(taskOf(f.runtime, review.id).status, 'running', 'the refused handoff changed nothing')
})

test('amend: the owner cannot reassign a review to a prior owner of its source', async t => {
  const f = await coauthored(t)
  const review = f.review({ assigneeId: f.reviewer.id })
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, review.id, 'amend', { assigneeId: f.prior.id }, 'reassign the review'), coded('review_independence_required'))
  assert.equal(taskOf(f.runtime, review.id).assigneeId, f.reviewer.id)
})

test('verify: a prior owner holding a review attempt cannot record a verdict', async t => {
  const f = await coauthored(t)
  const review = f.review({ assigneeId: f.reviewer.id })
  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  // Forge the attempt onto the prior owner: verify is defence in depth behind claim.
  const forged = taskOf(f.runtime, review.id)
  forged.attempt.ownerId = f.prior.id
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', forged))
  await assert.rejects(f.runtime.verify(f.actor(f.prior), f.mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'self review' }),
    coded('verification_not_independent'))
  assert.equal(taskOf(f.runtime, f.source.id).status, 'submitted', 'the source keeps waiting for an independent verdict')
})

test('liveReview: a pending review only a prior owner could take is not a live review path', async t => {
  const f = await coauthored(t)
  const open = f.review()
  assert.equal(f.runtime.liveReview(f.mission.id, taskOf(f.runtime, f.source.id))?.id, open.id, 'an independent live member makes it live')
  f.stopReviewer()
  assert.equal(f.runtime.liveReview(f.mission.id, taskOf(f.runtime, f.source.id)), undefined)
})

test('reviewPathBlocker: a prior owner does not count as the independent member an automatic review needs', async t => {
  const f = await coauthored(t)
  const members = () => f.runtime.store.list('members', f.mission.id)
  assert.equal(f.runtime.reviewPathBlocker(f.runtime.mission(f.mission.id), taskOf(f.runtime, f.source.id), members()), undefined)
  f.stopReviewer()
  assert.match(f.runtime.reviewPathBlocker(f.runtime.mission(f.mission.id), taskOf(f.runtime, f.source.id), members()), /no live member other than the author/)
})

test('unschedulable: a pending review whose only live candidates authored its source is dead', async t => {
  const f = await coauthored(t)
  const open = f.review()
  const dead = () => f.runtime.scheduling.unschedulable(f.runtime.mission(f.mission.id), f.runtime.store.list('tasks', f.mission.id), f.runtime.store.list('members', f.mission.id)).map(task => task.id)
  assert.equal(dead().includes(open.id), false)
  f.stopReviewer()
  assert.equal(dead().includes(open.id), true)
})

/** Pure board rows: a submitted source a prior owner co-authored, and its pending open review. */
const board = () => {
  const row = extra => ({ status: 'pending', kind: 'implementation', dependencies: [], priority: 50, createdAt: 1, epoch: 0, priorOwnerIds: [], evidenceIds: [], ...extra })
  const source = row({ id: 'source', status: 'submitted', assigneeId: 'author', priorOwnerIds: ['prior'] })
  const review = row({ id: 'review', kind: 'verification', reviewOf: 'source' })
  const member = id => ({ id, name: id, role: 'verification', status: 'idle', phase: 'active', subscriptions: [] })
  return { tasks: [source, review], review, member }
}

test('arena: readiness and the member projection never offer a review to a prior owner of its source', () => {
  const { tasks, member } = board()
  assert.deepEqual(pendingReadiness(tasks, [member('prior')]), { ready: 0, notReady: 1 })
  assert.deepEqual(pendingReadiness(tasks, [member('independent')]), { ready: 1, notReady: 0 })
  const view = arenaView({ missionId: 'mission', now: 2, leaseMs: 1_000, mission: { status: 'active' }, tasks, members: [member('prior'), member('independent')], evidence: [], deliveries: [] })
  assert.equal(view.members.find(entry => entry.id === 'prior').pendingTaskId, undefined)
  assert.equal(view.members.find(entry => entry.id === 'independent').pendingTaskId, 'review')
})

test('client projection: a review only a prior owner could take is shown blocked, not ready', () => {
  const { tasks, review, member } = board()
  assert.equal(boardIndex(tasks).lane(review, [member('prior')]), 'blocked')
  assert.equal(boardIndex(tasks).lane(review, [member('prior'), member('independent')]), 'ready')
})

test('plan admission: a planned review cannot be assigned to its source\'s assignee', () => {
  const plan = {
    title: 'Plan', objective: 'Deliver', workspace: '/workspace', scope: ['src/'], acceptance: ['works'],
    budget: { maxTokens: 1000, maxSteps: 10, maxWorkers: 2, maxDurationMs: 60_000, maxTasks: 4, maxExperiments: 0 },
    members: [{ key: 'builder', role: 'implementation' }, { key: 'reviewer', role: 'verification' }],
    workstreams: [{ key: 'main', title: 'Main', objective: 'Deliver' }],
    tasks: [
      { key: 'deliver', workstreamKey: 'main', title: 'Deliver', objective: 'Implement', kind: 'research', scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder' },
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify', kind: 'verification', scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', reviewOf: 'deliver' },
    ],
  }
  assert.throws(() => validatePlan(plan), coded('plan_review_independence_required'))
  plan.tasks[1].assigneeKey = 'reviewer'
  assert.doesNotThrow(() => validatePlan(plan))
})

test('no other source file derives review authorship from priorOwnerIds on its own', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const root = new URL('../src/', import.meta.url)
  const files = readdirSync(root, { recursive: true }).filter(name => /\.tsx?$/.test(name))
  // assignment.ts owns the rule; attempts.ts records the history; types.ts declares it.
  const offenders = files.filter(name => !['assignment.ts', 'attempts.ts', 'types.ts'].includes(name))
    .filter(name => /\.priorOwnerIds\b/.test(readFileSync(new URL(name, root), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
  assert.deepEqual(offenders, [], 'read authorship through authorIdsOf/canOwnReview')
})
