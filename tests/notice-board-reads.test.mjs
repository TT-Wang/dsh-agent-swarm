/**
 * S11: a notice that names only board rows (the tasks it is about, its
 * subjects) reads the board, never the interpretation, so writing it asks the
 * adapter nothing.
 *
 * Every case runs on a board an interpretation must ask the adapter about: work
 * preferred to a third member, Busy, whose handle cannot start, which an idle
 * member may borrow only once the adapter has said so (`readinessBlocker`).
 * For each notice the case first shows that the interpretation of the board it
 * names would ask whether Busy can start, then that the notice asked nothing:
 * a notice written inside a commit, that its commit asked nothing before it was
 * written; a notice told in a commit of its own, that nothing was asked while
 * it was decided.
 *
 * The automatic completion notice is not a case: completion admits no pending
 * work (`completionError`), and the interpretation asks the adapter only about
 * pending work preferred to a member, so no board it names could make it ask.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { interpret } from '../lib/board.js'
import { FakeClock, MISSION_ACCEPTANCE, acceptThroughReview, setup, taskOf } from './faults/harness.mjs'

/**
 * The shared fixture plus Busy and the work preferred to it (the lowest
 * priority, so no case's own work waits behind it). `watch(methods)` records
 * every idleness and activity ask; for each owner notice written inside a
 * commit, the asks that commit made before it (`asked`) and the asks the
 * interpretation of the board it saw makes (`judged`); and for each named
 * Notices method, the asks made while it ran and the asks the interpretation of
 * the board it saw makes. The commit funnel's own ask, the execution clock it
 * settles after a commit's body for each running attempt's owner (a kept
 * interleaving), is no notice's and is not recorded.
 */
async function preferredToBusy(t, options = {}) {
  const f = await setup({ clock: new FakeClock(), ...options })
  t.after(() => f.cleanup())
  const busy = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Busy', role: 'implementation', maxOutputTokens: 5_000 })
  const preferred = f.propose({ title: 'Preferred to Busy', assigneeId: busy.id, assignmentMode: 'preferred', priority: 1 })
  await f.runtime.settle(f.mission.id)
  const watch = (methods = []) => {
    const notices = [], calls = []
    const asked = [], opened = []
    let judging
    for (const question of ['isIdle', 'currentActivity']) {
      const answer = f.workers[question].bind(f.workers)
      f.workers[question] = memberId => {
        if (judging !== undefined || f.runtime.commitDepth === opened.length) (judging ?? asked).push([question, memberId])
        return answer(memberId)
      }
    }
    // A commit's body is open while its depth is counted here too; past it, inside the same transaction, the funnel runs.
    const commit = f.runtime.commit.bind(f.runtime)
    f.runtime.commit = (missionId, fn) => commit(missionId, () => { opened.push(asked.length); try { return fn() } finally { opened.pop() } })
    const judge = () => { judging = []; try { interpret(f.runtime.boardOf(f.mission.id)); return judging } finally { judging = undefined } }
    const notify = f.runtime.notices.notify.bind(f.runtime.notices)
    f.runtime.notices.notify = (missionId, content, subjects, options) => {
      if (opened.length) notices.push({ trigger: options.trigger, content, asked: asked.slice(opened.at(-1)), judged: judge() })
      return notify(missionId, content, subjects, options)
    }
    for (const name of methods) {
      const method = f.runtime.notices[name].bind(f.runtime.notices)
      f.runtime.notices[name] = (...args) => {
        const judged = judge(), from = asked.length
        const result = method(...args)
        calls.push({ name, asked: asked.slice(from), judged })
        return result
      }
    }
    return { notices, calls, asked }
  }
  return { ...f, busy, preferred, watch }
}

/** Each record names Busy in what the interpretation of its board asks, and recorded no ask of its own. */
function assertAskedNothing(f, records, label) {
  assert.ok(records.length > 0, `${label} was written`)
  for (const { asked, judged } of records) {
    assert.ok(judged.some(([question, memberId]) => question === 'isIdle' && memberId === f.busy.id), `${label}: the interpretation of the board it names would ask whether Busy can start`)
    assert.deepEqual(asked, [], `${label}: it asked the adapter nothing`)
  }
}

/** One deliverable of the author's, claimed and submitted, under a review the reviewer has claimed. */
async function underReview(f, title) {
  const source = f.propose({ title })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    outputs: [], workstreamId: f.stream.id, title: `Review ${title}`, objective: 'Independent review', kind: 'verification',
    reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  const verify = (verdict, reason) => f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict, reason })
  return { source, review, verify }
}

test('a challenge is told inside its commit, and an integration gap is warned of, without one adapter ask', async t => {
  const f = await preferredToBusy(t)
  const source = f.propose({ title: 'Accepted source' })
  f.runtime.commit(f.mission.id, () => {
    f.runtime.store.put('tasks', { ...taskOf(f.runtime, source.id), status: 'accepted', artifact: { ...f.workers.artifact }, evidenceIds: ['e-source'] })
    f.runtime.store.put('evidence', { id: 'e-source', missionId: f.mission.id, taskId: source.id, workstreamId: f.stream.id, authorId: f.author.id,
      claim: 'the source works', outcome: 'supported', status: 'verified', toolRunIds: [], supersedes: [], challenges: [], createdAt: f.clock.now() })
  })
  await f.runtime.settle(f.mission.id)
  const { notices, calls } = f.watch(['warnIntegrationGap'])
  // The owner disputes the source's claim: the notice names the source.
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'e-source', reason: 'a counterexample', toolRunIds: [] })
  assertAskedNothing(f, notices.filter(notice => notice.trigger === 'evidence/challenged'), 'the challenge')
  // A third implementation branch with no integration task: the warning names every branch.
  const third = f.propose({ title: 'Third implementation' })
  assert.ok(f.runtime.store.list('deliveries', f.mission.id).some(delivery => delivery.notice?.dedupKey === `integration-gap:${f.mission.id}:3` && delivery.subjects.includes(`${third.id}@${third.epoch}`)),
    'the integration gap was told, naming the new branch')
  assertAskedNothing(f, calls, 'the integration-gap warning')
})

test('a provider outage is told inside its commit without one adapter ask', async t => {
  const f = await preferredToBusy(t)
  const { notices } = f.watch()
  f.workers.callbacks.providerOutage(f.author.id, { class: 'rate-limit', status: 429, message: 'Rate limit reached for requests' })
  assertAskedNothing(f, notices.filter(notice => notice.trigger === 'provider/outage'), 'the outage')
})

test('work a retired route strands is told inside the retirement\'s commit without one adapter ask', async t => {
  const f = await preferredToBusy(t)
  const pinned = f.propose({ title: 'Pinned to the author', assignmentMode: 'pinned' })
  await f.runtime.settle(f.mission.id)
  const { notices } = f.watch()
  for (let failure = 0; failure < 3; failure++) f.runtime.onStartFailure(f.runtime.mission(f.mission.id), f.runtime.store.get('members', f.author.id), new Error('worker could not start'))
  const stranded = notices.filter(notice => notice.content.startsWith('No live member can start'))
  assert.ok(stranded.every(notice => notice.content.includes(pinned.id)), 'the notice names the pinned work')
  assertAskedNothing(f, stranded, 'the stranded work')
})

test('a deferred verdict is told inside its commit without one adapter ask', async t => {
  const f = await preferredToBusy(t)
  const { verify } = await underReview(f, 'Deferred source')
  f.workers.checks = [{ command: 'test -d .', exitCode: 127, failureKind: 'infrastructure', output: 'test: command not found' }]
  const { notices } = f.watch()
  await verify('accept', 'Independent host checks validate the submitted artifact')
  assertAskedNothing(f, notices.filter(notice => notice.trigger === 'task/verification-deferred'), 'the deferral')
})

test('a rejection is told inside its commit without one adapter ask', async t => {
  const f = await preferredToBusy(t)
  const { source, verify } = await underReview(f, 'Rejected source')
  const { notices } = f.watch()
  await verify('reject', 'The candidate is unacceptable')
  assert.equal(taskOf(f.runtime, source.id).status, 'blocked', 'the rejection blocked the source')
  assertAskedNothing(f, notices.filter(notice => notice.trigger === 'task/rejected'), 'the rejection')
})

test('a duplicate carrier is told inside the acceptance\'s commit without one adapter ask', async t => {
  const f = await preferredToBusy(t, { budget: { maxWorkers: 4 } })
  const builder = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5_000 })
  // Imported history the admission no longer produces: a repair of work still running.
  const live = f.propose({ title: 'Live original', assigneeId: builder.id })
  await f.runtime.claim(f.actor(builder), f.mission.id, live.id)
  const repair = f.propose({ title: 'Repair' })
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', { ...taskOf(f.runtime, repair.id), replaces: [live.id] }))
  const { notices } = f.watch()
  await acceptThroughReview(f, repair)
  assertAskedNothing(f, notices.filter(notice => notice.trigger === 'task/duplicate-carrier'), 'the duplicate carrier')
})

test('a preparation failure is told inside the dispatch sweep\'s commit without one adapter ask', async t => {
  const f = await preferredToBusy(t)
  const own = f.propose({ title: 'Own work' })
  await f.runtime.settle(f.mission.id)
  const prepare = f.workers.prepareTask.bind(f.workers)
  f.workers.prepareTask = async (member, task, ...rest) => {
    if (task.id === own.id) throw new Error('the workspace cannot be prepared')
    return await prepare(member, task, ...rest)
  }
  const { notices } = f.watch()
  f.workers.idle.add(f.author.id)
  f.runtime.kick(f.mission.id)
  await f.runtime.settle(f.mission.id)
  assert.equal(taskOf(f.runtime, own.id).status, 'blocked', 'the permanent failure blocked the work')
  assertAskedNothing(f, notices.filter(notice => notice.trigger === 'task/preparation-failed'), 'the preparation failure')
})

test('a parked holder the lease sweep finds is told without one adapter ask', async t => {
  const f = await preferredToBusy(t)
  const held = f.propose({ title: 'Held' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, held.id)
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.author.id), phase: 'parked' }))
  const { calls } = f.watch(['notifyParkedHolder'])
  f.runtime.kick(f.mission.id)
  await f.runtime.settle(f.mission.id)
  assert.ok(f.runtime.store.list('deliveries', f.mission.id).some(delivery => delivery.notice?.dedupKey === `parked:${f.mission.id}:${held.id}:${taskOf(f.runtime, held.id).epoch}`), 'the parked holder was told')
  assertAskedNothing(f, calls, 'the parked holder')
})

test('a review-blocked source is told without one adapter ask', async t => {
  const f = await preferredToBusy(t)
  const source = f.propose({ title: 'Submitted source' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const { calls } = f.watch(['notifyReviewBlocked'])
  f.runtime.notices.notifyReviewBlocked(f.runtime.mission(f.mission.id), taskOf(f.runtime, source.id), 'need', 'no live independent review admits it')
  assert.ok(f.runtime.store.list('deliveries', f.mission.id).some(delivery => delivery.notice?.dedupKey?.startsWith(`review-blocked:${f.mission.id}:${source.id}:`)), 'the review-blocked source was told')
  assertAskedNothing(f, calls, 'the review-blocked source')
})

test('a parked notice is outstanding exactly while a parked member holds its task, and judging that asks the adapter nothing', async t => {
  const f = await preferredToBusy(t)
  const held = f.propose({ title: 'Held' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, held.id)
  const phase = value => f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.author.id), phase: value }))
  phase('parked')
  f.runtime.kick(f.mission.id)
  await f.runtime.settle(f.mission.id)
  const notice = f.runtime.store.list('deliveries', f.mission.id).find(delivery => delivery.notice?.dedupKey === `parked:${f.mission.id}:${held.id}:${taskOf(f.runtime, held.id).epoch}`)
  assert.ok(notice, 'the parked holder was told')
  const { asked } = f.watch()
  const judged = () => interpret(f.runtime.boardOf(f.mission.id))
  /** The notice's relevance, and what judging it asked of the adapter. */
  const relevance = () => { const from = asked.length; const relevant = f.runtime.notices.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), notice); return [relevant, asked.slice(from)] }
  judged()
  assert.ok(asked.some(([question, memberId]) => question === 'isIdle' && memberId === f.busy.id), 'the interpretation of this board asks whether Busy can start')
  assert.deepEqual(relevance(), [true, []], 'outstanding while the parked author holds the task')
  phase('active')
  assert.deepEqual(relevance(), [false, []], 'not while the author that holds it is active')
  phase('parked')
  assert.deepEqual(relevance(), [true, []], 'outstanding again once the author parks again')
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: held.id, attemptId: claimed.attempt.id, output: 'candidate' })
  assert.equal(taskOf(f.runtime, held.id).status, 'submitted', 'the attempt ended in a submission, and the task is unfinished')
  assert.deepEqual(relevance(), [false, []], 'not once the parked author holds no open attempt on it')
})
