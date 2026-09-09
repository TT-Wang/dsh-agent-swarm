/**
 * Round-4 sibling-retirement regressions: a review of work that can no longer
 * be reviewed is retired whether it is pending, running or quiescence-parked,
 * both when a verdict lands and when the source is cancelled, and every
 * retirement is a durable event. Pre-fix `verify` cancelled only `pending`
 * siblings, so a running sibling kept its attempt and lease until expiry and
 * burned model/host-check tokens against closed work.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
async function eventually(read, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

class ReviewWorkers {
  prepared = []; stopped = []
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-retire-'))
  const workers = new ReviewWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'retire-owner' }
  const mission = runtime.create(owner, { title: 'Retire', objective: 'Retire moot reviews', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const first = await runtime.addMember(owner, mission.id, { name: 'Reviewer One', role: 'verification' })
  const second = await runtime.addMember(owner, mission.id, { name: 'Reviewer Two', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  const proposeReview = (source, title = 'Review') => runtime.propose(owner, mission.id, { workstreamId: stream.id, title, objective: 'Independent review',
    kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: source.id })
  async function submittedSource() {
    const source = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
      kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'] })
    const claimed = await runtime.claim(actor(author), mission.id, source.id)
    await runtime.submit(actor(author), mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    return source
  }
  async function submittedSourceWithEvidence(outcome = 'supported') {
    const source = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement with evidence', objective: 'Implement',
      kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'] })
    const claimed = await runtime.claim(actor(author), mission.id, source.id)
    const runId = await workers.callbacks.toolRun(author.id, { tool: 'bash', arguments: { command: 'true' }, result: { exitCode: 0 }, isError: false })
    const evidence = runtime.publish(actor(author), mission.id, { taskId: source.id, attemptId: claimed.attempt.id, claim: 'Durably named claim', outcome, toolRunIds: [runId] })
    await runtime.submit(actor(author), mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    return { source, evidence }
  }
  return { runtime, workers, owner, mission, stream, author, first, second, actor, current, events, proposeReview, submittedSource, submittedSourceWithEvidence }
}

test('an accepting verdict retires a running sibling, a pending sibling and a parked sibling with durable events', async t => {
  const f = await fixture(t)
  const source = await f.submittedSource()
  const verdict = f.proposeReview(source, 'Verdict review')
  const sibling = f.proposeReview(source, 'Running sibling')
  const pending = f.proposeReview(source, 'Pending review')
  const parked = f.proposeReview(source, 'Parked review')
  const claimedVerdict = await f.runtime.claim(f.actor(f.first), f.mission.id, verdict.id)
  await f.runtime.claim(f.actor(f.second), f.mission.id, sibling.id)
  const parkedRecord = f.current(parked.id)
  parkedRecord.status = 'blocked'; parkedRecord.epoch++
  parkedRecord.resumeAfterStop = { epoch: parkedRecord.epoch, reason: 'lease-expired' }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', parkedRecord))
  assert.equal(f.current(sibling.id).status, 'running')
  assert.equal(f.current(pending.id).status, 'pending')
  await f.runtime.verify(f.actor(f.first), f.mission.id, { taskId: verdict.id, attemptId: claimedVerdict.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
  assert.equal(f.current(source.id).status, 'accepted')
  assert.equal(f.current(verdict.id).status, 'accepted', 'the verdict task itself is accepted')
  for (const [task, previous] of [[f.current(sibling.id), 'running'], [f.current(pending.id), 'pending'], [f.current(parked.id), 'blocked']]) {
    assert.equal(task.status, 'cancelled', 'a sibling that can no longer reach a verdict is retired')
    assert.equal(task.attempt, undefined, 'the retired attempt is fenced')
    assert.equal(task.resumeAfterStop, undefined, 'a retired review cannot re-pend')
    assert.match(task.output, /Superseded/)
  }
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).members.find(member => member.id === f.second.id).status, 'idle', 'the retired reviewer is released')
  const retireEvents = f.events('task/review-retired')
  assert.equal(retireEvents.length, 3, 'each retirement is durable')
  assert.deepEqual(new Set(retireEvents.map(event => event.data.taskId)), new Set([sibling.id, pending.id, parked.id]))
  for (const event of retireEvents) {
    assert.equal(event.data.reviewOf, source.id)
    assert.match(event.data.reason, /was accepted by review/)
  }
  const siblingEvent = retireEvents.find(event => event.data.taskId === sibling.id)
  assert.equal(siblingEvent.data.previousStatus, 'running')
  assert.equal(typeof siblingEvent.data.attemptId, 'string')
  assert.equal(siblingEvent.data.ownerId, f.second.id)
  assert.equal(f.events('task/lease-expired').filter(event => event.data.taskId === parked.id).length, 0)
  await eventually(() => f.workers.stopped.includes(f.second.id), 'the retired reviewer handle is stopped')
  // A later scheduling pass must not re-pend or re-claim the retired sibling.
  f.workers.callbacks.idle(f.second.id)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(f.current(sibling.id).status, 'cancelled')
  assert.equal(f.events('task/claimed').length, 3, 'the source, the verdict review and the sibling were claimed; no review is re-claimed')
})

test('a rejecting verdict retires a running sibling review too', async t => {
  const f = await fixture(t)
  const source = await f.submittedSource()
  const verdict = f.proposeReview(source, 'Verdict review')
  const sibling = f.proposeReview(source, 'Running sibling')
  const claimedVerdict = await f.runtime.claim(f.actor(f.first), f.mission.id, verdict.id)
  await f.runtime.claim(f.actor(f.second), f.mission.id, sibling.id)
  f.workers.checks = [{ command: 'test', exitCode: 1, output: 'host check failed' }]
  await f.runtime.verify(f.actor(f.first), f.mission.id, { taskId: verdict.id, attemptId: claimedVerdict.attempt.id, verdict: 'accept', reason: 'Host checks reject the candidate' })
  assert.equal(f.current(source.id).status, 'blocked')
  const retired = f.current(sibling.id)
  assert.equal(retired.status, 'cancelled')
  assert.equal(retired.attempt, undefined)
  const [event] = f.events('task/review-retired')
  assert.equal(event.data.taskId, sibling.id)
  assert.equal(event.data.previousStatus, 'running')
  assert.match(event.data.reason, /was rejected by review/)
})

test('a verdict durably names the evidence it verified and the reviews it retired', async t => {
  const f = await fixture(t)
  const { source, evidence } = await f.submittedSourceWithEvidence()
  const verdict = f.proposeReview(source, 'Verdict review')
  const sibling = f.proposeReview(source, 'Running sibling')
  const claimedVerdict = await f.runtime.claim(f.actor(f.first), f.mission.id, verdict.id)
  await f.runtime.claim(f.actor(f.second), f.mission.id, sibling.id)
  await f.runtime.verify(f.actor(f.first), f.mission.id, { taskId: verdict.id, attemptId: claimedVerdict.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
  assert.equal(f.current(source.id).status, 'accepted')
  const [verified] = f.events('evidence/verified')
  assert.ok(verified, 'the verdict names the claim it verified')
  assert.equal(verified.data.evidenceId, evidence.id)
  assert.equal(verified.data.outcome, 'supported')
  assert.equal(verified.data.taskId, source.id)
  assert.equal(verified.data.verificationTaskId, verdict.id)
  assert.deepEqual(verified.data.retired, [sibling.id], 'the event names the retired sibling')
})

test('a rejecting verdict durably refutes the evidence by id', async t => {
  const f = await fixture(t)
  const { source, evidence } = await f.submittedSourceWithEvidence()
  const verdict = f.proposeReview(source, 'Verdict review')
  const claimedVerdict = await f.runtime.claim(f.actor(f.first), f.mission.id, verdict.id)
  f.workers.checks = [{ command: 'test', exitCode: 1, output: 'host check failed' }]
  await f.runtime.verify(f.actor(f.first), f.mission.id, { taskId: verdict.id, attemptId: claimedVerdict.attempt.id, verdict: 'accept', reason: 'Host checks reject the candidate' })
  assert.equal(f.current(source.id).status, 'blocked')
  const [refuted] = f.events('evidence/refuted')
  assert.ok(refuted, 'the rejected verdict names the claim it refuted')
  assert.equal(refuted.data.evidenceId, evidence.id)
  assert.equal(refuted.data.taskId, source.id)
  assert.equal(refuted.data.verificationTaskId, verdict.id)
  assert.match(refuted.data.reason, /Host checks reject the candidate/)
})

test('cancelling a source retires its running reviews with a durable event', async t => {
  const f = await fixture(t)
  const source = await f.submittedSource()
  const first = f.proposeReview(source, 'First review')
  const second = f.proposeReview(source, 'Second review')
  const claimedFirst = await f.runtime.claim(f.actor(f.first), f.mission.id, first.id)
  const claimedSecond = await f.runtime.claim(f.actor(f.second), f.mission.id, second.id)
  assert.equal(f.current(first.id).status, 'running')
  assert.equal(f.current(second.id).status, 'running')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: source.id, reason: 'Source withdrawn' })
  assert.equal(f.current(source.id).status, 'cancelled')
  for (const [task, attempt] of [[f.current(first.id), claimedFirst], [f.current(second.id), claimedSecond]]) {
    assert.equal(task.status, 'cancelled', 'a running review of withdrawn work is retired')
    assert.equal(task.attempt, undefined)
    assert.equal(task.resumeAfterStop, undefined)
  }
  const retireEvents = f.events('task/review-retired')
  assert.equal(retireEvents.length, 2, 'each cancellation retirement is durable')
  assert.deepEqual(new Set(retireEvents.map(event => event.data.taskId)), new Set([first.id, second.id]))
  for (const event of retireEvents) {
    assert.equal(event.data.previousStatus, 'running')
    assert.equal(event.data.reviewOf, source.id)
    assert.match(event.data.reason, /cancelled by the mission owner/)
  }
  await eventually(() => f.workers.stopped.includes(f.first.id) && f.workers.stopped.includes(f.second.id), 'both retired reviewer handles are stopped')
  // A later scheduling pass must not re-pend or reassign either review.
  f.workers.callbacks.idle(f.first.id)
  f.workers.callbacks.idle(f.second.id)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(f.current(first.id).status, 'cancelled')
  assert.equal(f.current(second.id).status, 'cancelled')
  assert.equal(f.events('task/claimed').length, 3, 'no review is re-claimed after retirement')
})
