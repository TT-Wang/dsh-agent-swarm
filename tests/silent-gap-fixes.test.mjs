/**
 * Silent-gap regressions: the no-silent-state fixes that are not a single board
 * condition. Each test fails on the pre-fix head:
 *  - R10-15: `swarm_wait` parked a running attempt (stranding it until lease
 *    expiry and spending a recovery credit).
 *  - R10-16/R11-16: a challenge re-opened an accepted research source, cancelled
 *    its review, and no replacement was admitted because reviewability was
 *    derived from the declared kind.
 *  - R11-16: reviewability now comes from the captured artifact.
 *  - R11-18: the rejection reason and repair path never reached the author.
 *  - R11-03: the integration diagnostic first appeared at completion time.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptThroughReview, eventually, setup, taskOf } from './faults/harness.mjs'

const MISSION_ACCEPTANCE = ['fault recovery is proven from durable state']
const ownerNotices = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.kind === 'control')
const events = (f, type) => f.runtime.store.events(f.mission.id, 500).filter(event => event.type === type)
const reviewsOf = (f, sourceId) => f.runtime.store.list('tasks', f.mission.id).filter(task => task.kind === 'verification' && task.reviewOf === sourceId)
const publishEvidence = (f, task, attemptId) => {
  const run = { id: `run_silent_${Math.random().toString(16).slice(2)}`, seq: 1, missionId: f.mission.id, memberId: f.author.id,
    taskId: task.id, attemptId, tool: 'bash', arguments: {}, result: {}, isError: false, createdAt: Date.now() }
  f.runtime.store.transaction(() => f.runtime.store.put('tool_runs', run))
  return f.runtime.publish(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId, claim: 'Host-backed claim', outcome: 'supported', toolRunIds: [run.id] })
}
const proposeResearch = (f, extra = {}) => f.runtime.propose(f.owner, f.mission.id, {
  workstreamId: f.stream.id, title: 'Research the change', objective: 'Read-only audit of the change', kind: 'research',
  scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.author.id, ...extra,
})

test('F(S) is a stable, order-independent digest that excludes wall-clock fields', async () => {
  const { missionFingerprint } = await import('../lib/runtime.js')
  const board = {
    status: 'active',
    tasks: [
      { id: 'task_b', status: 'pending', ready: false, unreviewed: false },
      { id: 'task_a', status: 'running', attemptOwner: 'member_1', ready: false, unreviewed: false },
    ],
    members: [{ id: 'member_2', status: 'idle' }, { id: 'member_1', status: 'working' }],
    pendingDeliveries: 2,
    challengedEvidence: 1,
    ceilings: ['task:task_a:maxSteps'],
  }
  const first = missionFingerprint(board)
  assert.match(first, /^[a-f0-9]{32}$/)
  assert.equal(missionFingerprint({ ...board, tasks: [...board.tasks].reverse(), members: [...board.members].reverse() }), first, 'order never changes F(S)')
  assert.notEqual(missionFingerprint({ ...board, status: 'blocked' }), first, 'mission status is part of F(S)')
  assert.notEqual(missionFingerprint({ ...board, tasks: board.tasks.map(task => task.id === 'task_a' ? { ...task, status: 'submitted' } : task) }), first, 'task status is part of F(S)')
  assert.notEqual(missionFingerprint({ ...board, pendingDeliveries: 3 }), first, 'pending deliveries are part of F(S)')
  assert.notEqual(missionFingerprint({ ...board, challengedEvidence: 0 }), first, 'unresolved challenges are part of F(S)')
  assert.notEqual(missionFingerprint({ ...board, ceilings: [] }), first, 'ceilings hit are part of F(S)')
})

test('R10-15: swarm_wait refuses to park a running attempt, and parks once it is released', async t => {
  const f = await setup({ config: { leaseMs: 60_000 } })
  t.after(f.cleanup)
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  assert.throws(() => f.runtime.wait(f.actor(f.author), f.mission.id), error => {
    assert.match(error.message, /running attempt/)
    assert.match(error.message, /swarm_submit|swarm_handoff/)
    return true
  }, 'a park while holding a running attempt must be refused')
  assert.equal(taskOf(f.runtime, task.id).status, 'running', 'the refusal does not touch the attempt')
  assert.equal(taskOf(f.runtime, task.id).recoveryCount ?? 0, 0, 'no recovery credit is spent by the refusal')
  // The supported exit releases the attempt, after which parking is allowed.
  await f.runtime.handoff(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, summary: 'release before parking' })
  assert.equal(f.runtime.wait(f.actor(f.author), f.mission.id).waiting, true, 'a member without a running attempt may park')
  assert.equal(f.runtime.store.get('members', f.author.id).status, 'waiting')
})

test('R10-16/R11-16: a challenge to research evidence admits an independent replacement review', async t => {
  const f = await setup()
  t.after(f.cleanup)
  const source = proposeResearch(f)
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  const evidence = publishEvidence(f, source, claimed.attempt.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'Research artifact' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Review the research', objective: 'Independent review', kind: 'verification',
    reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Independent check passes' })
  assert.equal(taskOf(f.runtime, source.id).status, 'accepted')
  f.runtime.challenge(f.actor(f.reviewer), f.mission.id, { evidenceId: evidence.id, reason: 'Counter-evidence overturns the accepted claim', toolRunIds: [] })
  assert.equal(taskOf(f.runtime, source.id).status, 'submitted', 'the challenged source reopens')
  assert.equal(taskOf(f.runtime, review.id).status, 'cancelled', 'the stale review is retired')
  const replacement = await eventually(() => reviewsOf(f, source.id).find(task => task.id !== review.id),
    'a challenged research source must get a live independent review automatically')
  assert.equal(replacement.status, 'pending')
  assert.equal(replacement.assigneeId, undefined, 'the replacement is left unassigned for any independent member')
  assert.ok(events(f, 'task/review-missing').some(event => event.data.taskId === source.id), 'the missing review is recorded durably')
})

test('R11-16: reviewability is derived from the captured artifact, not the declared kind', async t => {
  const f = await setup()
  t.after(f.cleanup)
  f.runtime.store.transaction(() => {
    const reviewer = f.runtime.store.get('members', f.reviewer.id)
    // R17-G7: the durable phase is what stops a member; the live status is derived.
    reviewer.phase = 'stopped'
    f.runtime.store.put('members', reviewer)
  })
  const source = proposeResearch(f)
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  publishEvidence(f, source, claimed.attempt.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'Research artifact' })
  const missing = await eventually(() => events(f, 'task/review-missing').find(event => event.data.taskId === source.id),
    'a submitted research artifact without a review path must be reported')
  assert.equal(missing.data.kind, 'research')
  assert.match(missing.data.reason, /reviewOf/)
  const blocked = await eventually(() => events(f, 'task/review-blocked').find(event => event.data.taskId === source.id),
    'the unreviewable research artifact must wake the owner')
  assert.match(blocked.data.reason, /no live member other than the author/)
})

test('R11-18: the rejection reason and repair path reach the source author', async t => {
  const f = await setup()
  t.after(f.cleanup)
  const source = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Review', objective: 'Independent review', kind: 'verification',
    reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'reject', reason: 'The artifact does not meet its acceptance criteria' })
  const delivery = await eventually(() => f.runtime.store.list('deliveries', f.mission.id)
    .find(item => item.to === f.author.id && item.kind === 'control' && /rejected by independent verification/.test(item.content)),
  'the source author must receive the rejection')
  assert.match(delivery.content, /does not meet its acceptance criteria/, 'the author sees the reviewer reason')
  assert.match(delivery.content, new RegExp(`replaces: \\["${source.id}"\\]`), 'the author is given the exact repair path')
})

test('R10-09/S3: a task ready only for a waiting member is dispatched and woken', async t => {
  const f = await setup()
  t.after(f.cleanup)
  await f.runtime.wait(f.actor(f.author), f.mission.id)
  assert.equal(f.runtime.store.get('members', f.author.id).status, 'waiting')
  const task = f.propose()
  const running = await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? taskOf(f.runtime, task.id) : undefined,
    'a waiting member must still be dispatched')
  assert.equal(running.attempt.ownerId, f.author.id)
  assert.ok(f.workers.deliveries.some(item => item.kind === 'assignment' && item.taskId === task.id), 'the wake is a durable assignment delivery')
  assert.equal(await f.workers.callbacks.beforeStep(f.author.id, true), undefined, 'fresh input lets the woken member take its next step')
})

test('R10-14: a coverage-complete owner-assembled mission announces readiness once and stays active', async t => {
  const f = await setup()
  t.after(f.cleanup)
  const task = f.propose()
  await acceptThroughReview(f, task)
  const notice = await eventually(() => ownerNotices(f).find(delivery => /ready to complete/.test(delivery.content)),
    'a coverage-complete board must announce readiness instead of returning silently')
  assert.match(notice.content, /every acceptance criterion is independently covered/)
  assert.equal(f.runtime.store.get('missions', f.mission.id).status, 'active', 'the owner keeps the completion decision')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(ownerNotices(f).filter(delivery => /ready to complete/.test(delivery.content)).length, 1, 'an unchanged state does not spam')
})

test('R11-03: a second implementation branch without an integration task warns at admission', async t => {
  const f = await setup()
  t.after(f.cleanup)
  f.propose({ title: 'Branch one' })
  assert.deepEqual(ownerNotices(f).filter(item => /Coding missions require/.test(item.content)), [], 'one implementation branch is a complete code plan')
  f.propose({ title: 'Branch two' })
  const notice = await eventually(() => ownerNotices(f).find(item => /Coding missions require/.test(item.content)), 'admitting a second branch must warn immediately')
  assert.match(notice.content, /Coding missions require an independently accepted integration artifact, or exactly one independently accepted implementation artifact when the plan has no integration task/)
  assert.match(notice.content, /integration task depending on every branch/)
  assert.equal(f.runtime.store.get('missions', f.mission.id).witness.fingerprint, f.runtime.fingerprint(f.mission.id), 'the diagnostic is a W2 witness for the current F(S)')
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(ownerNotices(f).filter(item => /Coding missions require/.test(item.content)).length, 1, 'an unchanged board does not repeat the admission diagnostic')
})
