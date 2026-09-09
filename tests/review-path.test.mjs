/**
 * F2 regressions: a submitted implementation/integration task with no live
 * review path is recorded, repaired by an automatic independent review when the
 * board can afford one, and escalated to the owner with the exact task id when
 * it cannot. The normal two-step owner flow (admit the source, then its review)
 * keeps working, and the launch-time plan validation still rejects a code
 * deliverable without an assigned independent review.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

async function eventually(read, message, timeout = 3000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

class ReviewWorkers {
  deliveries = []; prepared = []; stopped = []
  checks = [{ command: 'npm test', exitCode: 0, output: 'ok' }]
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return path.join(mission.workspace, memberId) }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, delivery }) }
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle() { return false }
  async prepareTask(member, task) { this.prepared.push(task.id) }
  async captureArtifact(member, task) { return { commit: createHash('sha1').update(task.id).digest('hex'), baseCommit: 'b'.repeat(40), workspace: member.workspace, changedPaths: ['src/a.ts'] } }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

async function fixture(t, { members = ['author', 'reviewer'], budget: overrides = {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'swarm-review-path-'))
  const workers = new ReviewWorkers()
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 10,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }, workers)
  const owner = { sessionId: 'review-path-owner' }
  const mission = runtime.create(owner, { title: 'Review path', objective: 'Keep submitted work reviewable', workspace: directory,
    scope: ['src/'], acceptance: ['done'], budget: { ...budget, ...overrides } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Keep submitted work reviewable' })
  const added = {}
  for (const name of members) {
    added[name] = await runtime.addMember(owner, mission.id, { name: name[0].toUpperCase() + name.slice(1), role: name === 'reviewer' ? 'verification' : 'implementation' })
  }
  // Production liveness: the periodic scheduler tick is what repairs or
  // escalates an unreviewable submission, so the regression must run it.
  await runtime.start()
  const actor = name => ({ sessionId: added[name].sessionId })
  const propose = (title, extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title, objective: title,
    kind: 'implementation', assigneeId: added.author.id, scope: ['src/'], acceptance: ['done'], checks: ['npm test'], ...extra })
  const submit = async (task, name = 'author') => {
    const claimed = await runtime.claim(actor(name), mission.id, task.id)
    return runtime.submit(actor(name), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'Candidate artifact' })
  }
  const review = async (task, verdict = 'accept', name = 'reviewer') => {
    const reviewTask = propose(`Review ${task.title}`, { kind: 'verification', reviewOf: task.id, assigneeId: added[name].id, checks: [] })
    const claimed = await runtime.claim(actor(name), mission.id, reviewTask.id)
    await runtime.verify(actor(name), mission.id, { taskId: reviewTask.id, attemptId: claimed.attempt.id, verdict, reason: `Independent ${verdict} of the exact artifact` })
    return runtime.store.get('tasks', reviewTask.id)
  }
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const tasks = () => runtime.store.list('tasks', mission.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  const ownerNotices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner' && delivery.kind === 'control')
  const reviewPathNotices = () => ownerNotices().filter(delivery => /review_path_missing/.test(delivery.content))
  const reviewsOf = source => tasks().filter(task => task.kind === 'verification' && task.reviewOf === source.id)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { runtime, workers, owner, mission, stream, added, actor, propose, submit, review, current, tasks, events, ownerNotices, reviewPathNotices, reviewsOf }
}

test('a submitted implementation with no live review is recorded and automatically reviewed once the board would otherwise stall', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement the change')
  await f.submit(source)
  const submitted = f.events('task/submitted').find(event => event.data.taskId === source.id)
  assert.equal(submitted.data.reviewPath?.missing, true, 'the submission records the missing review path atomically')
  assert.match(submitted.data.reviewPath.reason, /reviewOf/)
  const missing = await eventually(() => f.events('task/review-missing').find(event => event.data.taskId === source.id), 'the missing review was never recorded durably')
  assert.equal(missing.data.kind, 'implementation')
  assert.match(missing.data.reason, new RegExp(source.id))
  assert.match(missing.data.reason, /reviewOf/)
  const review = await eventually(() => f.reviewsOf(source)[0], 'an independent review was never admitted for the submitted artifact')
  assert.equal(review.status, 'pending')
  assert.equal(review.assigneeId, undefined, 'the review is left unassigned so any independent member can claim it')
  assert.equal(review.maxRecoveryAttempts, 2)
  assert.deepEqual(review.checks, source.checks, 'the review inherits the source acceptance commands')
  assert.deepEqual(review.scope, source.scope)
  assert.deepEqual(review.acceptance, source.acceptance)
  assert.equal(review.workstreamId, source.workstreamId)
  const admitted = f.events('task/review-admitted')
  assert.equal(admitted.length, 1, 'the automatic admission is durable and names the new review')
  assert.equal(admitted[0].data.taskId, review.id)
  assert.equal(admitted[0].data.reviewOf, source.id)
  assert.equal(admitted[0].data.maxRecoveryAttempts, 2)
  assert.deepEqual(f.reviewPathNotices(), [], 'the runtime repaired the gap without waking the owner')
  // The auto-admitted review is a real, independent review path.
  const claimed = await f.runtime.claim(f.actor('reviewer'), f.mission.id, review.id)
  await f.runtime.verify(f.actor('reviewer'), f.mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'Independently checked the exact submitted artifact' })
  assert.equal(f.current(source).status, 'accepted')
  assert.equal(f.current(review).reviewedCommit, f.current(source).artifact.commit)
})

test('the two-step owner flow keeps its own review and the runtime never duplicates it', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement the change')
  const review = f.propose('Independent review', { kind: 'verification', reviewOf: source.id, assigneeId: f.added.reviewer.id, checks: [] })
  await f.submit(source)
  assert.equal(f.events('task/review-missing').length, 0, 'a live review path is never reported missing')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(f.reviewsOf(source).map(task => task.id), [review.id], 'an existing live review is never duplicated')
  assert.equal(f.events('task/review-admitted').length, 0)
  const claimed = await f.runtime.claim(f.actor('reviewer'), f.mission.id, review.id)
  await f.runtime.verify(f.actor('reviewer'), f.mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'Independently checked the exact submitted artifact' })
  assert.equal(f.current(source).status, 'accepted')
  assert.deepEqual(f.reviewPathNotices(), [])
})

test('a replaces repair gets the same detection and automatic review as a fresh implementation', async t => {
  const f = await fixture(t)
  const original = f.propose('Original implementation')
  const originalReview = f.propose('Review the original', { kind: 'verification', reviewOf: original.id, assigneeId: f.added.reviewer.id, checks: [] })
  await f.submit(original)
  assert.equal(f.events('task/review-missing').length, 0, 'the original has a live review')
  const claimedReview = await f.runtime.claim(f.actor('reviewer'), f.mission.id, originalReview.id)
  await f.runtime.verify(f.actor('reviewer'), f.mission.id, { taskId: originalReview.id, attemptId: claimedReview.attempt.id, verdict: 'reject', reason: 'The original does not meet its acceptance criteria' })
  assert.equal(f.current(original).status, 'blocked')
  const repair = f.propose('Repair the implementation', { replaces: [original.id] })
  await f.submit(repair)
  const submitted = f.events('task/submitted').filter(event => event.data.taskId === repair.id).at(-1)
  assert.equal(submitted.data.reviewPath?.missing, true, 'the repair submission records the missing review path atomically')
  const missing = await eventually(() => f.events('task/review-missing').find(event => event.data.taskId === repair.id), 'the repair was never recorded as missing a review')
  assert.equal(missing.data.kind, 'implementation')
  const automatic = await eventually(() => f.reviewsOf(repair)[0], 'the repair was never automatically reviewed')
  assert.equal(automatic.maxRecoveryAttempts, 2)
  assert.deepEqual(automatic.checks, repair.checks)
  assert.deepEqual(f.events('task/review-admitted').map(event => event.data.reviewOf), [repair.id])
  const claimed = await f.runtime.claim(f.actor('reviewer'), f.mission.id, automatic.id)
  await f.runtime.verify(f.actor('reviewer'), f.mission.id, { taskId: automatic.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'Independently checked the repair artifact' })
  assert.equal(f.current(repair).status, 'accepted')
  assert.equal(f.current(original).status, 'cancelled', 'accepting the repair supersedes the blocked original')
  assert.match(f.current(original).output, /Superseded/)
})

test('an unreviewable submission wakes the owner once with the task id when no independent member exists', async t => {
  const f = await fixture(t, { members: ['author'] })
  const source = f.propose('Implement alone')
  await f.submit(source)
  const missing = await eventually(() => f.events('task/review-missing').find(event => event.data.taskId === source.id), 'the missing review was never recorded durably')
  assert.equal(missing.data.taskId, source.id)
  const blocked = await eventually(() => f.events('task/review-blocked').find(event => event.data.taskId === source.id), 'the unreviewable submission never blocked')
  assert.match(blocked.data.reason, /no live member other than the author/)
  assert.equal(f.reviewsOf(source).length, 0, 'no review is admitted without an independent member')
  const notice = await eventually(() => f.reviewPathNotices().find(delivery => delivery.content.includes(source.id)), 'the owner notice must name the task id')
  assert.match(notice.content, /\[review_path_missing\]/)
  assert.match(notice.content, new RegExp(`reviewOf ${source.id}`))
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(f.reviewPathNotices().length, 1, 'a persistent blocker wakes the owner exactly once')
})

test('an exhausted task budget blocks automatic review and tells the owner why', async t => {
  const f = await fixture(t, { budget: { maxTasks: 1 } })
  const source = f.propose('Implement alone')
  await f.submit(source)
  const blocked = await eventually(() => f.events('task/review-blocked').find(event => event.data.taskId === source.id), 'the exhausted task budget never blocked')
  assert.match(blocked.data.reason, /task budget is exhausted/)
  assert.equal(f.reviewsOf(source).length, 0)
  const notice = await eventually(() => f.reviewPathNotices().find(delivery => delivery.content.includes(source.id)), 'the owner notice must name the task id')
  assert.match(notice.content, /task budget is exhausted/)
})

test('replacing a verification task no longer claims a review starts by itself', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement the change')
  const review = f.propose('Review it', { kind: 'verification', reviewOf: source.id, assigneeId: f.added.reviewer.id, checks: [] })
  assert.throws(() => f.propose('Repair the review', { kind: 'verification', reviewOf: source.id, replaces: [review.id], assigneeId: f.added.reviewer.id, checks: [] }), error => {
    assert.doesNotMatch(error.message, /starts automatically when the repair is submitted/, 'the runtime must not claim a review starts automatically when none is created')
    assert.match(error.message, /detects the missing review and admits an independent verification task automatically/, 'the message must describe what the runtime actually does')
    return true
  })
})

test('an unreviewable submission survives a host restart and is repaired on recovery', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'swarm-review-path-restart-'))
  const config = { statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }
  const owner = { sessionId: 'restart-owner' }
  let first = new SwarmRuntime(config, new ReviewWorkers())
  let second
  t.after(async () => { await first.dispose(); await second?.dispose(); await rm(directory, { recursive: true, force: true }) })
  const mission = first.create(owner, { title: 'Restart review path', objective: 'Keep submitted work reviewable', workspace: directory,
    scope: ['src/'], acceptance: ['done'], budget: { ...budget } })
  const stream = first.workstream(owner, mission.id, { title: 'Main', objective: 'Keep submitted work reviewable' })
  const author = await first.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  await first.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const source = first.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement before restart', objective: 'Implement before restart',
    kind: 'implementation', assigneeId: author.id, scope: ['src/'], acceptance: ['done'], checks: ['npm test'] })
  const claimed = await first.claim({ sessionId: author.sessionId }, mission.id, source.id)
  await first.submit({ sessionId: author.sessionId }, mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'Candidate before restart' })
  await first.dispose()
  second = new SwarmRuntime(config, new ReviewWorkers())
  await second.start()
  const missing = await eventually(() => second.store.events(mission.id, 500).find(event => event.type === 'task/review-missing' && event.data.taskId === source.id),
    'the recovered runtime never recorded the missing review')
  assert.equal(missing.data.kind, 'implementation')
  const review = await eventually(() => second.store.list('tasks', mission.id).find(task => task.kind === 'verification' && task.reviewOf === source.id),
    'the recovered runtime never admitted an independent review')
  assert.equal(review.maxRecoveryAttempts, 2)
  assert.deepEqual(review.checks, ['npm test'])
  assert.equal(review.status, 'pending')
})

test('automatic plan admission still rejects a code deliverable without an assigned independent review', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'swarm-review-path-plan-'))
  const workers = new ReviewWorkers()
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 10 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'plan-owner' }
  const request = runtime.requestStart(owner, { commandId: 'command-1', goal: 'Deliver verified code', workspace: directory })
  const plan = { title: 'Automatic delivery', objective: 'Deliver verified code', workspace: directory, scope: ['src/'], acceptance: ['works'],
    budget: { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 12, maxExperiments: 2 },
    members: [{ key: 'builder', name: 'Builder', role: 'implementation', maxOutputTokens: 4096 }, { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [{ key: 'deliver', workstreamKey: 'main', title: 'Deliver', objective: 'Implement final change', kind: 'integration', scope: ['src/'], acceptance: ['works'],
      assigneeKey: 'builder', checks: ['node check.cjs'], maxRecoveryAttempts: 5, checkTimeoutMs: 45000 }] }
  await assert.rejects(runtime.startPlan(owner, request.id, plan), /requires an assigned independent verification task/)
  plan.tasks.push({ key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify immutable artifact', kind: 'verification', scope: ['src/'],
    acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'deliver', maxRecoveryAttempts: 5 })
  const snapshot = await runtime.startPlan(owner, request.id, plan)
  assert.equal(snapshot.mission.status, 'active')
})
