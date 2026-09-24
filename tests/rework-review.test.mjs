/**
 * A rework re-opens its source's review in place, not only the source: the
 * review whose rejection the owner answered is re-pended for the next
 * submission, with its verdict archived on its own history and the rejecting
 * reviewer as its assignee, and every other open review of the source is
 * retired in the same transaction. The resubmission is reviewed at once by its
 * paired review, so no automatic review is minted and no task slot is spent per
 * rework, a busy board does not hold it back, a deferred review of the rejected
 * commit cannot block completion, and an automatic review of an earlier
 * submission is never read as withdrawn from this one (automatic reviews are
 * keyed on the submission, so an unchanged resubmission cannot collide).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FakeClock, FakeWorkers, WorkspaceWorkers, makeRepo, makeRuntime, makeWorkspaces, setup } from './faults/harness.mjs'

/** Every attempt captures its own commit unless `fixedCommit` pins one (an unchanged resubmission). */
class ReworkWorkers extends FakeWorkers {
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  fixedCommit
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async captureArtifact(member, task) {
    const commit = this.fixedCommit ?? createHash('sha1').update(`${task.id}@${task.epoch}`).digest('hex')
    return { commit, baseCommit: 'b'.repeat(40), workspace: member.workspace, changedPaths: ['src/a.ts'] }
  }
}

async function fixture(t, { members = ['Author', 'Reviewer'], maxTasks = 100 } = {}) {
  const clock = new FakeClock()
  const workers = new ReworkWorkers()
  const { dir, runtime, budget } = await makeRuntime(t, { workers, clock, config: { maxEvents: 5000, maxTasksPerMember: 100, checkTimeoutMs: undefined }, budget: { maxTasks } })
  await runtime.start()
  const owner = { sessionId: 'rework-review-owner' }
  const mission = runtime.create(owner, { title: 'Rework review', objective: 'Review reworked work once', workspace: dir, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const m = []
  for (const name of members) m.push(await runtime.addMember(owner, mission.id, { name, role: 'implementation' }))
  const actor = member => ({ sessionId: member.sessionId })
  const current = task => runtime.store.get('tasks', task.id)
  const events = type => runtime.store.events(mission.id, 5000).filter(event => event.type === type)
  const reviewsOf = source => runtime.store.list('tasks', mission.id).filter(task => task.reviewOf === source.id)
  const live = source => reviewsOf(source).filter(task => task.status === 'pending' || task.status === 'running')
  const ownerNotices = pattern => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner' && pattern.test(delivery.content))
  const propose = (title, extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title,
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: m[0].id, ...extra })
  const proposeReview = (source, extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: `Review ${source.title}`,
    objective: 'Independent review', kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: source.id, ...extra })
  async function submit(member, task) {
    const claimed = await runtime.claim(actor(member), mission.id, task.id)
    await runtime.submit(actor(member), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
  }
  async function verify(member, review, verdict, reason = 'The artifact misses the acceptance criterion') {
    const claimed = await runtime.claim(actor(member), mission.id, review.id)
    return runtime.verify(actor(member), mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict, reason })
  }
  const resume = task => runtime.controlTask(owner, mission.id, task.id, 'resume', {}, 'Rework the rejected artifact')
  async function pastReviewGrace(times = 1) { for (let i = 0; i < times; i++) { clock.advance(1001); await runtime.tick(); await runtime.settle(mission.id) } }
  return { runtime, workers, clock, owner, mission, stream, m, actor, current, events, reviewsOf, live, ownerNotices, propose, proposeReview, submit, verify, resume, pastReviewGrace }
}

test('a rework re-pends its rejecting review, which reviews the resubmission at once on a busy board and spends no task slot', async t => {
  const clock = new FakeClock()
  const workers = new ReworkWorkers()
  const { dir, runtime } = await makeRuntime(t, { clock, workers, config: { checkTimeoutMs: undefined } })
  await runtime.start()
  const owner = { sessionId: 'busy-owner' }
  // The host pairs the deliverable with its review at launch; the plan has no
  // task slot to spare, so a review admitted per rework could not fit.
  const snapshot = await runtime.startPlan(owner, runtime.requestStart(owner, { commandId: 'busy-1', goal: 'g', workspace: dir }).id, {
    title: 'Busy', objective: 'Busy board', workspace: dir, scope: ['src/'], acceptance: ['works'],
    budget: { maxTokens: 100_000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 3_600_000, maxTasks: 4, maxExperiments: 0 },
    members: [{ key: 'builder', name: 'Builder', role: 'implementation', maxOutputTokens: 4096 }, { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }, { key: 'other', name: 'Other', role: 'research', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [
      { key: 'long', workstreamKey: 'main', title: 'Long', objective: 'Audit the module at length', kind: 'research', outputs: [], scope: ['src/'], acceptance: ['works'], assigneeKey: 'other', maxRecoveryAttempts: 2, assignmentMode: 'pinned' },
      { key: 'impl', workstreamKey: 'main', title: 'Impl', objective: 'Implement the change', kind: 'implementation', outputs: [], scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['test'], maxRecoveryAttempts: 4, checkTimeoutMs: 45_000 },
    ],
  })
  const missionId = snapshot.mission.id
  const member = key => snapshot.members.find(candidate => candidate.id.endsWith(`_${key}`))
  const as = key => ({ sessionId: member(key).sessionId })
  const source = snapshot.tasks.find(task => task.kind === 'implementation')
  const review = runtime.store.list('tasks', missionId).find(task => task.reviewOf === source.id)
  const tasks = () => runtime.store.list('tasks', missionId)
  const eventsOf = type => runtime.store.events(missionId, 5000).filter(event => event.type === type)
  const submit = async () => { const claimed = await runtime.claim(as('builder'), missionId, source.id); await runtime.submit(as('builder'), missionId, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' }) }
  const verdict = async (verdict, reason) => { const claimed = await runtime.claim(as('reviewer'), missionId, review.id); await runtime.verify(as('reviewer'), missionId, { taskId: review.id, attemptId: claimed.attempt.id, verdict, reason }) }
  // The rest of the board keeps running for the whole test.
  await runtime.claim(as('other'), missionId, tasks().find(task => task.id.endsWith('_long')).id)

  await submit()
  await verdict('reject', 'Misses the acceptance criterion')
  const rejected = runtime.store.get('tasks', source.id).artifact.commit
  const decision = runtime.store.list('deliveries', missionId).find(delivery => delivery.to === 'owner' && delivery.content.includes(`(${source.id}) was blocked by independent verification`))
  assert.ok(decision.content.includes(`review ${review.id} re-reviews the resubmission`), 'the owner is told which review re-reviews the rework')
  const reopened = runtime.controlTask(owner, missionId, source.id, 'resume', {}, 'Rework it')
  assert.equal(reopened.status, 'pending')
  const paired = runtime.store.get('tasks', review.id)
  assert.equal(paired.status, 'pending', 'the rejecting review re-opens with its source')
  assert.equal(paired.assigneeId, member('reviewer').id, 'the rejecting reviewer stays its assignee')
  assert.deepEqual(paired.rejections.map(entry => [entry.commit, entry.reason]), [[rejected, 'Misses the acceptance criterion']])
  await submit()
  assert.notEqual(runtime.store.get('tasks', source.id).artifact.commit, rejected)
  assert.deepEqual(tasks().filter(task => task.reviewOf === source.id && ['pending', 'running'].includes(task.status)).map(task => task.id), [review.id], 'exactly one live review of the resubmission')
  // No grace, no whole-board stall: the paired review can start at once.
  await verdict('accept', 'The rework meets the criterion')
  assert.equal(runtime.store.get('tasks', source.id).status, 'accepted')
  assert.equal(runtime.store.get('tasks', review.id).status, 'accepted')
  assert.equal(tasks().length, 4, 'the rework spent no task slot')
  assert.deepEqual(eventsOf('task/review-missing'), [])
  assert.deepEqual(eventsOf('task/review-admitted'), [])
  assert.deepEqual(runtime.store.list('deliveries', missionId).filter(delivery => delivery.to === 'owner' && /no live independent review path|review_path_missing/.test(delivery.content)), [])
})

test('a deferred review of the rejected commit is retired with the rework, so the accepted rework completes the mission', async t => {
  const f = await fixture(t)
  const [author, reviewer] = f.m
  const source = f.propose('Implement')
  await f.submit(author, source)
  const deferred = f.proposeReview(source)
  f.workers.checks = [{ command: 'test', exitCode: 124, output: 'timed out' }]
  await f.verify(reviewer, deferred, 'accept', 'checks timed out')
  f.workers.checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  assert.equal(f.current(deferred).status, 'blocked')
  assert.ok(f.current(deferred).verificationRecovery)
  const rejecting = f.proposeReview(source)
  await f.verify(reviewer, rejecting, 'reject')
  f.resume(source)
  assert.equal(f.current(deferred).status, 'cancelled', 'the deferred review of the rejected commit is retired')
  assert.ok(f.events('task/review-retired').some(event => event.data.taskId === deferred.id && event.data.previousStatus === 'blocked'))
  assert.equal(f.current(rejecting).status, 'pending')
  await f.submit(author, source)
  assert.deepEqual(f.live(source).map(task => task.id), [rejecting.id], 'exactly one live review of the resubmission')
  await f.verify(reviewer, rejecting, 'accept', 'The rework meets the criterion')
  assert.equal(f.current(source).status, 'accepted')
  assert.equal(f.runtime.completionError(f.runtime.mission(f.mission.id)), undefined)
})

test('a re-opened review re-reviews with a fresh review\'s step allowance; the rejecting round\'s steps are history', async t => {
  const f = await fixture(t)
  const [author, reviewer] = f.m
  const step = async () => (await f.workers.callbacks.beforeStep(reviewer.id)) === false ? 'refused' : 'charged'
  const source = f.propose('Implement')
  await f.submit(author, source)
  const review = f.proposeReview(source, { maxSteps: 3, assigneeId: reviewer.id })
  const first = await f.runtime.claim(f.actor(reviewer), f.mission.id, review.id)
  assert.deepEqual([await step(), await step(), await step()], ['charged', 'charged', 'charged'], 'the rejecting round spends the whole allowance')
  await f.runtime.verify(f.actor(reviewer), f.mission.id, { taskId: review.id, attemptId: first.attempt.id, verdict: 'reject', reason: 'Misses the criterion' })
  assert.equal(f.current(review).usedSteps, 3)
  f.resume(source)
  const reopened = f.current(review)
  assert.equal(reopened.usedSteps, undefined, 'the re-opened review starts from zero, as a freshly admitted one would')
  assert.equal(reopened.ceiling, undefined)
  assert.deepEqual(reopened.rejections.at(-1).spent, { usedSteps: 3, recoveryCount: 0 }, 'what the round spent is kept with its verdict')
  await f.submit(author, source)
  const second = await f.runtime.claim(f.actor(reviewer), f.mission.id, review.id)
  assert.equal(await step(), 'charged', 'the first step of the re-review is not refused by the previous round\'s spend')
  assert.deepEqual([f.current(review).status, f.current(review).usedSteps, f.current(review).ceiling], ['running', 1, undefined])
  assert.deepEqual(f.ownerNotices(/task_ceiling_terminal/), [])
  await f.runtime.verify(f.actor(reviewer), f.mission.id, { taskId: review.id, attemptId: second.attempt.id, verdict: 'accept', reason: 'The rework meets the criterion' })
  assert.equal(f.current(source).status, 'accepted')
})

test('a re-opened automatic review regains its recovery credit, so one lease expiry per round never blocks it', async t => {
  const f = await fixture(t)
  const [author, reviewer] = f.m
  const source = f.propose('Implement')
  await f.submit(author, source)
  await f.pastReviewGrace()
  const [review] = f.live(source)
  assert.match(review.id, /^task_auto_review_/)
  const max = review.maxRecoveryAttempts
  assert.equal(max, 2)
  async function expireOnce() {
    await f.runtime.claim(f.actor(reviewer), f.mission.id, review.id)
    f.clock.advance(f.runtime.config.leaseMs + 10); await f.runtime.tick(); await f.runtime.settle(f.mission.id)
    for (let i = 0; i < 5 && f.current(review).status !== 'pending'; i++) { f.clock.advance(20); await f.runtime.tick(); await f.runtime.settle(f.mission.id) }
    return [f.current(review).status, f.current(review).recoveryCount]
  }
  assert.deepEqual(await expireOnce(), ['pending', 1], 'the rejecting round spends one recovery credit')
  await f.verify(reviewer, f.current(review), 'reject')
  f.resume(source)
  assert.equal(f.current(review).recoveryCount, undefined)
  assert.equal(f.current(review).rejections.at(-1).spent.recoveryCount, 1)
  await f.submit(author, source)
  assert.deepEqual(await expireOnce(), ['pending', 1], 'the re-review spends its own credit, not the rejecting round\'s')
  assert.deepEqual(f.ownerNotices(new RegExp(`${review.id} \\(blocked\\)`)), [], 'no owner notice names the review blocked')
  await f.verify(reviewer, f.current(review), 'accept', 'The rework meets the criterion')
  assert.equal(f.current(source).status, 'accepted')
})

test('an automatic review of the rejected submission is never read as withdrawn from an unchanged resubmission', async t => {
  const f = await fixture(t, { members: ['Author', 'Reviewer', 'Third'] })
  const [author, reviewer] = f.m
  // A real capture of an unedited worktree reproduces the rejected commit.
  f.workers.fixedCommit = 'c'.repeat(40)
  const source = f.propose('Implement')
  await f.submit(author, source)
  await f.pastReviewGrace()
  const automatic = f.live(source)[0]
  assert.match(automatic.id, /^task_auto_review_/)
  // Another review rejects first, so the automatic one is retired as its sibling.
  const manual = f.proposeReview(source, { assigneeId: reviewer.id })
  await f.verify(reviewer, manual, 'reject')
  assert.equal(f.current(automatic).status, 'cancelled')
  f.resume(source)
  assert.equal(f.current(manual).status, 'pending', 'the rejecting review re-opens')
  await f.submit(author, source)
  assert.equal(f.current(source).artifact.commit, 'c'.repeat(40), 'the resubmission is the rejected commit, unchanged')
  await f.pastReviewGrace(3)
  assert.deepEqual(f.live(source).map(task => task.id), [manual.id], 'the paired review reviews the resubmission; none is admitted')
  assert.deepEqual(f.events('task/review-blocked'), [])
  // The owner withdraws the paired review: the runtime admits one automatic
  // review for this submission instead of reading the earlier one as withdrawn.
  f.runtime.cancel(f.owner, f.mission.id, { taskId: manual.id, reason: 'Use another reviewer' })
  await f.pastReviewGrace(3)
  const fresh = f.live(source)
  assert.equal(fresh.length, 1)
  assert.match(fresh[0].id, /^task_auto_review_/)
  assert.notEqual(fresh[0].id, automatic.id, 'an automatic review is keyed on the submission, not the commit alone')
  assert.deepEqual(f.events('task/review-blocked'), [])
  assert.deepEqual(f.ownerNotices(/was withdrawn/), [])
})

test('a real unchanged resubmission is re-reviewed by the automatic review that rejected it', async t => {
  const repo = await makeRepo('rework-review-real')
  const workspaces = makeWorkspaces(repo.root)
  const clock = new FakeClock()
  const f = await setup({ workers: new WorkspaceWorkers(workspaces), workspace: repo.source, clock })
  t.after(async () => { await f.cleanup(); await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  const settle = async (n = 6) => { for (let i = 0; i < n; i++) { clock.advance(1500); await f.runtime.tick(); await f.runtime.settle(f.mission.id) } }
  const source = f.propose({ title: 'Implement' })
  const reviews = () => f.runtime.store.list('tasks', f.mission.id).filter(task => task.reviewOf === source.id)
  const submit = async edit => {
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
    if (edit) await writeFile(join(f.author.workspace, 'src/answer.txt'), 'draft\n')
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    return f.runtime.store.get('tasks', source.id).artifact.commit
  }
  const verdict = async (review, verdict, reason) => {
    const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict, reason })
  }
  const first = await submit(true)
  await settle()
  const [automatic] = reviews()
  assert.match(automatic.id, /^task_auto_review_/)
  await verdict(automatic, 'reject', 'Reviewer judged it wrong')
  f.runtime.controlTask(f.owner, f.mission.id, source.id, 'resume', {}, 'The author disputes the rejection; resubmit as is')
  const second = await submit(false)
  assert.equal(second, first, 'no edit captures the rejected commit again')
  await settle(8)
  assert.deepEqual(reviews().map(task => [task.id, task.status]), [[automatic.id, 'pending']], 'the same review, re-opened, is the only review')
  assert.deepEqual(f.runtime.store.events(f.mission.id, 5000).filter(event => event.type === 'task/review-blocked'), [])
  assert.deepEqual(f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && /review_path_missing/.test(delivery.content)), [])
  await verdict(reviews()[0], 'accept', 'On a second look the draft meets the criterion')
  assert.equal(f.runtime.store.get('tasks', source.id).status, 'accepted')
})

test('a reworked task stays pinned to its author through a failed start, so the only other member can still review it', async t => {
  const f = await fixture(t)
  const [author, reviewer] = f.m
  const source = f.propose('Implement')
  await f.submit(author, source)
  const review = f.proposeReview(source)
  await f.verify(reviewer, review, 'reject')
  const reopened = f.resume(source)
  assert.equal(reopened.assignmentMode, 'pinned')
  assert.equal(reopened.assigneeId, author.id)
  // The owner can still move the rework, but never to the member its paired review is assigned to.
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, source.id, 'amend', { assigneeId: reviewer.id }, 'Let the reviewer rework it'), error => {
    assert.equal(error.code, 'review_independence_required')
    assert.ok(error.message.startsWith('[review_independence_required] '), error.message)
    assert.ok(error.message.includes(`review ${review.id}`), error.message)
    return true
  })
  // The author's provider is rate-limited before it starts the rework, then it
  // fails outright: a reroute would hand the rework to the reviewer.
  const outage = f.workers.start
  let failure = Object.assign(new Error('429 Too Many Requests: rate limit'), { status: 429 })
  f.workers.start = async spec => { f.workers.started.push(spec.member.id); if (spec.member.id === author.id && failure) throw failure }
  for (let i = 0; i < 4; i++) { f.clock.advance(50); await f.runtime.tick(); await f.runtime.settle(f.mission.id) }
  failure = new Error('worker could not start')
  for (let i = 0; i < 4; i++) { f.clock.advance(50); await f.runtime.tick(); await f.runtime.settle(f.mission.id) }
  assert.ok(f.events('task/start-failed').some(event => event.data.taskId === source.id), 'the author route failed to start the rework')
  assert.equal(f.current(source).assigneeId, author.id, 'the rework stays with its author')
  assert.deepEqual(f.events('task/reassigned').filter(event => event.data.taskId === source.id), [])
  f.workers.start = outage
})

test('a missing review path names every author of a reworked artifact', async t => {
  const f = await fixture(t)
  const [author, reviewer] = f.m
  const source = f.propose('Implement')
  await f.submit(author, source)
  const review = f.proposeReview(source)
  await f.verify(reviewer, review, 'reject')
  f.resume(source)
  // The owner withdraws the paired review and moves the rework to the reviewer.
  f.runtime.cancel(f.owner, f.mission.id, { taskId: review.id, reason: 'Hand the rework over' })
  f.runtime.controlTask(f.owner, f.mission.id, source.id, 'amend', { assigneeId: reviewer.id }, 'The author is unavailable')
  await f.submit(reviewer, source)
  const blocker = f.runtime.reviewPathBlocker(f.runtime.mission(f.mission.id), f.current(source), f.runtime.store.list('members', f.mission.id))
  assert.match(blocker, /^no live member other than the author \(/)
  assert.ok(blocker.includes(author.id) && blocker.includes(reviewer.id), `both authors are named: ${blocker}`)
})
