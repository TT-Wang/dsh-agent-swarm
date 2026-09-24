/**
 * A blocked task that carries an artifact resume cannot rework (a rejected
 * experiment, or submitted work invalidated after submission) can only be
 * repaired by a replacement. Owner task control used to accept `resume` on it:
 * the first resume bumped the epoch and fenced the historical author's handle,
 * the second re-pended work whose artifact is immutable. Both are refused with a
 * coded next step naming `swarm_propose` with `replaces`; the existing
 * `task_refuted` guard is pinned beside it. An independently rejected
 * non-experiment re-opens in place instead (tests/rework-in-place.test.mjs).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { PolicyError } from '../lib/policy-error.js'
import { assessText, toolSchemaIndex } from './refusal-inventory.mjs'
import { FakeWorkers, eventually, makeRuntime } from './faults/harness.mjs'

const settle = () => new Promise(resolve => setTimeout(resolve, 30))

async function fixture(t) {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, {
    workers: new FakeWorkers({
      checks: [{ command: 'test', exitCode: 0, output: 'ok' }],
      artifact: { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] },
      async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) },
    }),
    config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 10 },
  })
  const owner = { sessionId: 'replacement-owner' }
  const mission = runtime.create(owner, { title: 'Replacement', objective: 'Repair rejected work', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  /** Claim, optionally publish host-backed evidence, submit, and have an independent review reject it on a failing host check. */
  async function reject(task, { publish = false } = {}) {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    if (publish) {
      const runId = await workers.callbacks.toolRun(author.id, { tool: 'bash', arguments: { command: 'node --test' }, result: { exitCode: 0, output: 'ok' }, isError: false })
      runtime.publish(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, claim: 'The change works', outcome: 'supported', toolRunIds: [runId] })
    }
    await runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: `Review ${task.title}`, objective: 'Independent review',
      kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: task.id })
    const claimedReview = await runtime.claim(actor(reviewer), mission.id, review.id)
    workers.checks = [{ command: 'test', exitCode: 1, output: 'host check failed' }]
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Host checks reject the candidate' })
    workers.checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
    const rejected = current(task)
    assert.equal(rejected.status, 'blocked')
    assert.ok(rejected.artifact, 'the rejected source keeps its immutable artifact')
    return rejected
  }
  return { runtime, workers, owner, mission, stream, author, reviewer, actor, propose, current, events, reject }
}

const needsReplacement = taskId => error => {
  assert.ok(error instanceof PolicyError, 'the refusal is typed')
  assert.equal(error.code, 'task_needs_replacement')
  assert.equal(error.category, 'conflict_error')
  assert.ok(error.message.startsWith('[task_needs_replacement] '), error.message)
  assert.match(error.message, /`swarm_propose`[^.]*`replaces`/)
  const resumeAt = error.message.indexOf('`action` resume')
  assert.ok(resumeAt >= 0 && resumeAt < error.message.indexOf('`swarm_propose`'), 'the in-place rework is named before the replacement')
  assert.ok(error.message.includes(`["${taskId}"]`), 'the exit names the task the replacement must cover')
  return true
}

test('resume of a rejected experiment is refused every time: no epoch bump, no author stop, never pending', async t => {
  const f = await fixture(t)
  const task = f.propose({ experiment: true })
  const rejected = await f.reject(task)
  const stopsBefore = f.workers.stopped.length
  for (const attempt of [1, 2]) {
    assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, task.id, 'resume', {}, `Retry the rejected work (${attempt})`), needsReplacement(task.id))
    await settle()
    const after = f.current(task)
    assert.equal(after.status, 'blocked', `resume ${attempt} leaves the rejected source blocked`)
    assert.equal(after.epoch, rejected.epoch, `resume ${attempt} does not bump the epoch`)
    assert.equal(after.resumeAfterStop, undefined, `resume ${attempt} records no stop obligation`)
    assert.equal(after.artifact.commit, rejected.artifact.commit)
  }
  assert.deepEqual(f.workers.stopped.slice(stopsBefore), [], 'the historical author is never stopped')
  assert.equal(f.workers.stopped.includes(f.author.id), false)
  assert.deepEqual(f.events('task/amended'), [], 'a refused resume records no amendment')
  assert.equal(f.events('task/handoff-ready').length, 0)
})

test('an amendment that would implicitly resume a rejected experiment is refused the same way', async t => {
  const f = await fixture(t)
  const task = f.propose({ experiment: true })
  const rejected = await f.reject(task)
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { maxRecoveryAttempts: 5 }, 'More recovery room'), needsReplacement(task.id))
  await settle()
  const after = f.current(task)
  assert.equal(after.status, 'blocked')
  assert.equal(after.epoch, rejected.epoch)
  assert.equal(after.maxRecoveryAttempts, rejected.maxRecoveryAttempts, 'nothing of the refused amendment is written')
  assert.equal(f.workers.stopped.includes(f.author.id), false)
  // An amendment that does not resume is still allowed on the blocked source.
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { checkTimeoutMs: 5000 }, 'Allow a slower check for the replacement')
  assert.equal(f.current(task).status, 'blocked')
  assert.equal(f.current(task).checkTimeoutMs, 5000)
})

test('resume of submitted work invalidated after submission is refused and the work stays blocked', async t => {
  const f = await fixture(t)
  const source = f.propose({ title: 'Previously accepted source' })
  Object.assign(source, { status: 'accepted', artifact: { ...f.workers.artifact }, evidenceIds: ['e-source'] })
  f.runtime.store.transaction(() => {
    f.runtime.store.put('tasks', source)
    f.runtime.store.put('evidence', { id: 'e-source', missionId: f.mission.id, taskId: source.id, workstreamId: f.stream.id,
      authorId: f.reviewer.id, claim: 'previous finding', outcome: 'supported', status: 'verified', toolRunIds: [], supersedes: [], challenges: [], createdAt: Date.now() })
  })
  const dependent = f.propose({ title: 'Dependent', dependencies: [source.id] })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, dependent.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: dependent.id, attemptId: claimed.attempt.id, output: 'candidate' })
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'e-source', reason: 'counterexample', toolRunIds: [] })
  const invalidated = f.current(dependent)
  assert.equal(invalidated.status, 'blocked')
  assert.ok(invalidated.artifact)
  assert.equal(invalidated.resumeAfterStop, undefined, 'submitted work has no live handle to stop')
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, dependent.id, 'resume', {}, 'Re-run against the challenged prerequisite'), needsReplacement(dependent.id))
  await settle()
  assert.equal(f.current(dependent).status, 'blocked')
  assert.equal(f.current(dependent).epoch, invalidated.epoch)
})

test('a resume while the stop is still pending stays the cleanup retry and keeps the blocked outcome', async t => {
  const f = await fixture(t)
  const task = f.propose()
  const rejected = await f.reject(task)
  // A stop obligation recorded on the rejected source (for example by the
  // resume this change now refuses) whose preservation failed deterministically:
  // the owner's resume is the only retry, and it must still run.
  rejected.resumeAfterStop = { epoch: rejected.epoch, memberId: f.author.id, reason: 'handoff', at: Date.now(), failure: { message: 'preservation conflict', deterministic: true } }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', rejected))
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'resume', {}, 'Workspace preservation repaired')
  await eventually(() => f.current(task).resumeAfterStop === undefined, 'the cleanup retry must clear the stop obligation', 2500)
  assert.equal(f.current(task).status, 'blocked', 'the barrier keeps the rejected source blocked')
  assert.ok(f.workers.stopped.includes(f.author.id), 'the cleanup retry stops the recorded handle')
})

test('task_refuted: a rejected experiment whose evidence was refuted refuses resume and amendment', async t => {
  const f = await fixture(t)
  const task = f.propose({ experiment: true })
  const rejected = await f.reject(task, { publish: true })
  assert.equal(rejected.evidenceIds.length, 1)
  assert.equal(f.runtime.store.get('evidence', rejected.evidenceIds[0]).status, 'refuted')
  for (const [action, changes] of [['resume', {}], ['amend', { checkTimeoutMs: 5000 }]]) {
    assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, task.id, action, changes, 'Retry refuted work'), error => {
      assert.ok(error instanceof PolicyError)
      assert.equal(error.code, 'task_refuted')
      assert.equal(error.message, 'Refuted work requires a replacement preserving its original acceptance')
      return true
    })
  }
  await settle()
  assert.equal(f.current(task).status, 'blocked')
  assert.equal(f.current(task).epoch, rejected.epoch)
  assert.equal(f.current(task).checkTimeoutMs, rejected.checkTimeoutMs)
  assert.equal(f.workers.stopped.includes(f.author.id), false)
})

test('a structural amendment of a rejected task names the resume before the replacement and meets the refusal contract', async t => {
  const f = await fixture(t)
  const task = f.propose()
  await f.reject(task)
  let message
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { checks: ['test', 'test -d .'] }, 'Stronger checks before the rework'), error => {
    assert.equal(error.code, 'artifact_policy_immutable')
    assert.ok(error.message.startsWith('[artifact_policy_immutable] '), error.message)
    const resumeAt = error.message.indexOf('`action` resume')
    assert.ok(resumeAt >= 0 && resumeAt < error.message.indexOf('`swarm_propose`'), error.message)
    message = error.message
    return true
  })
  assert.deepEqual(assessText(message, await toolSchemaIndex()), [])
  assert.deepEqual(f.current(task).checks, ['test'], 'nothing of the refused amendment is written')
})

test('the task_needs_replacement refusal meets the refusal contract against the real tool schema', async t => {
  const f = await fixture(t)
  const task = f.propose({ experiment: true })
  await f.reject(task)
  let message
  try { f.runtime.controlTask(f.owner, f.mission.id, task.id, 'resume', {}, 'Retry') } catch (error) { message = error.message }
  assert.ok(message)
  assert.deepEqual(assessText(message, await toolSchemaIndex()), [])
})
