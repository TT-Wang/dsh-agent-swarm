/** Acceptance text cannot erase an admitted report or its independent review. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { FakeWorkers, eventually, makeRuntime } from './faults/harness.mjs'

const acceptance = ['Audit the code', 'Deliver the independently reviewed report']
class Workers extends FakeWorkers {
  checks = []
  async prepareBaseline() { return { sourceHead: 'b'.repeat(40), snapshotCommit: 'b'.repeat(40), planningWorkspace: '/planning', changedPaths: [], createdAt: Date.now() } }
  async prepareWorkspace(mission, id) { return join(mission.workspace, id) }
  async captureArtifact(member, task) {
    return { commit: `captured-${task.id}`, baseCommit: 'b'.repeat(40), workspace: member.workspace, changedPaths: ['docs/reviews/audit.md'] }
  }
}
async function fixture(t) {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, {
    workers: new Workers(),
    config: { maxEvents: 500, maxTasksPerMember: 20, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2, maxDurationMs: 3600000, maxTasks: 20, maxExperiments: 1 },
  })
  const owner = { sessionId: 'report-owner' }
  const common = { workstreamKey: 'audit', scope: ['docs/reviews/'], acceptance, outputs: [], maxRecoveryAttempts: 3 }
  const research = (key, dependencies = []) => ({ ...common, key, title: key, objective: key,
    kind: 'research', assigneeKey: 'author', dependencies })
  const review = (key, reviewOf) => ({ ...common, key, title: key, objective: key,
    kind: 'verification', assigneeKey: 'reviewer', reviewOf })
  const request = runtime.requestStart(owner, { commandId: 'review-command', goal: 'Audit and deliver a final report', workspace: directory })
  const snapshot = await runtime.startPlan(owner, request.id, {
    title: 'Deep review', objective: 'Audit and deliver a final report', workspace: directory, scope: ['docs/reviews/'], acceptance, budget,
    members: [{ key: 'author', name: 'Author', role: 'research', maxOutputTokens: 2048 },
      { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'audit', title: 'Audit and synthesis', objective: 'Produce the final report' }],
    tasks: [research('r_main'), review('v_main', 'r_main'), research('r_tests'), review('v_tests', 'r_tests'),
      research('s_report', ['r_main', 'r_tests']), review('v_report', 's_report')],
  })
  const missionId = snapshot.mission.id
  const author = snapshot.members.find(member => member.name === 'Author')
  const reviewer = snapshot.members.find(member => member.name === 'Reviewer')
  const actor = member => ({ sessionId: member.sessionId })
  const task = key => runtime.store.list('tasks', missionId).find(item => item.id.endsWith(`_${key}`))
  const current = id => runtime.store.get('tasks', id)
  const events = type => runtime.store.events(missionId, 500).filter(event => event.type === type)
  async function submit(source) {
    const claimed = await runtime.claim(actor(author), missionId, source.id)
    const runId = await workers.callbacks.toolRun(author.id, { tool: 'read_file', arguments: { path: 'docs/reviews/audit.md' }, result: 'Recorded audit evidence', isError: false })
    runtime.publish(actor(author), missionId, { taskId: source.id, attemptId: claimed.attempt.id, claim: 'Host-backed audit findings', outcome: 'supported', toolRunIds: [runId] })
    await runtime.submit(actor(author), missionId, { taskId: source.id, attemptId: claimed.attempt.id, output: `Preserved work for ${source.title}` })
    return current(source.id)
  }
  async function accept(source) {
    const review = runtime.store.list('tasks', missionId).find(item => item.reviewOf === source.id && item.status === 'pending')
    const claimed = await runtime.claim(actor(reviewer), missionId, review.id)
    await workers.callbacks.toolRun(reviewer.id, { tool: 'read_file', arguments: { path: 'docs/reviews/audit.md' }, result: 'Independently checked the submitted report', isError: false })
    await runtime.verify(actor(reviewer), missionId, { taskId: review.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'Independent evidence supports the artifact' })
  }
  async function strandReport() {
    await submit(task('r_main')); await accept(task('r_main'))
    const tests = await submit(task('r_tests'))
    runtime.cancel(owner, missionId, { taskId: tests.id, reason: 'Owner withdraws the source whose host verdict is unavailable' })
    return tests
  }
  return { runtime, workers, owner, missionId, author, reviewer, actor, task, current, events, submit, accept, strandReport }
}

test('covered audit text cannot auto-complete or manually complete a stranded report; amend recovers the same report chain', async t => {
  const f = await fixture(t)
  const captured = await f.strandReport()
  const report = f.task('s_report'), review = f.task('v_report')
  const notice = await eventually(() => f.workers.deliveries.find(item => item.to === 'owner' && /Mission stalled/.test(item.content)
    && item.content.includes(report.id)), 'the owner must be notified of the unfinished report', 3000)
  assert.match(notice.content, new RegExp(review.id))
  const snapshot = f.runtime.snapshot(f.owner, f.missionId)
  assert.deepEqual(f.task('r_main').acceptance, acceptance, 'an accepted audit already repeats every mission criterion')
  assert.equal(snapshot.mission.status, 'active', 'no runnable task is not completion')
  assert.equal(snapshot.completion.eligible, false)
  assert.match(snapshot.completion.reason, new RegExp(report.id))
  assert.throws(() => f.runtime.control(f.owner, f.missionId, 'complete', 'All acceptance strings appear in accepted audits'),
    error => error.code === 'mission_completion_pending' && error.message === snapshot.completion.reason)
  assert.deepEqual(f.current(report.id), report, 'failed completion preserves the report id, dependency graph and work')
  assert.deepEqual(f.current(review.id), review, 'failed completion preserves the independent review')
  assert.deepEqual(f.current(captured.id).artifact, captured.artifact, 'withdrawing a prerequisite preserves its captured work')
  assert.deepEqual(f.current(captured.id).evidenceIds, captured.evidenceIds)
  assert.equal(f.events('automatic/completed').length, 0)
  assert.equal(f.events('task/cancelled-at-completion').length, 0)
  assert.equal(f.workers.deliveries.filter(item => /Completed Deep review/.test(item.content)).length, 0)

  const amended = f.runtime.controlTask(f.owner, f.missionId, report.id, 'amend', { dependencies: [f.task('r_main').id] },
    'Use the accepted audit evidence; document the explicitly withdrawn track')
  assert.equal(amended.id, report.id)
  assert.equal(f.task('v_report').id, review.id)
  await f.submit(amended)
  assert.equal(f.runtime.snapshot(f.owner, f.missionId).completion.eligible, false, 'the submitted final report still requires independent acceptance')
  await f.accept(amended)
  await eventually(() => f.runtime.store.get('missions', f.missionId).status === 'completed', 'the original chain completes after its actual deliverable is accepted', 3000)
  assert.equal(f.current(report.id).status, 'accepted')
  assert.equal(f.current(review.id).status, 'accepted')
  assert.equal(f.runtime.snapshot(f.owner, f.missionId).completion.eligible, true)
  assert.equal(f.events('automatic/completed').length, 1)
  assert.equal(f.events('task/cancelled-at-completion').length, 0)
})

test('an owner may explicitly withdraw a redundant report chain and complete the remaining accepted plan', async t => {
  const f = await fixture(t)
  await f.strandReport()
  const report = f.task('s_report'), review = f.task('v_report')
  assert.equal(f.runtime.snapshot(f.owner, f.missionId).completion.eligible, false)
  f.runtime.cancel(f.owner, f.missionId, { taskId: report.id, reason: 'Owner explicitly changes the deliverable to the accepted audit artifact' })
  await eventually(() => f.runtime.store.get('missions', f.missionId).status === 'completed', 'explicit withdrawal permits completion', 3000)
  assert.match(f.current(report.id).output, /Cancelled by the mission owner/)
  assert.equal(f.current(review.id).status, 'cancelled', 'review retirement follows its explicit source withdrawal')
  assert.equal(f.events('task/cancelled-at-completion').length, 0)
})

test('an accepted replacement satisfies the original prerequisite without replacing the report chain', async t => {
  const f = await fixture(t)
  await f.strandReport()
  const original = f.task('r_tests'), report = f.task('s_report')
  const common = { workstreamId: report.workstreamId, scope: report.scope, acceptance, maxRecoveryAttempts: 3 }
  const replacement = f.runtime.propose(f.owner, f.missionId, { ...common, title: 'Repair the tests audit', objective: 'Recover the withdrawn track',
    kind: 'research', assigneeId: f.author.id, replaces: [original.id] })
  f.runtime.propose(f.owner, f.missionId, { outputs: [], ...common, title: 'Review the repair', objective: 'Verify the repaired audit',
    kind: 'verification', assigneeId: f.reviewer.id, reviewOf: replacement.id })
  await f.submit(replacement); await f.accept(replacement)
  assert.deepEqual(f.current(report.id).dependencies, report.dependencies, 'original dependency ids resolve through the accepted replacement')
  assert.equal(f.runtime.snapshot(f.owner, f.missionId).completion.eligible, false, 'replacement coverage cannot skip the final report')
  await f.submit(report); await f.accept(report)
  await eventually(() => f.runtime.store.get('missions', f.missionId).status === 'completed', 'accepted replacement and the original report chain complete normally', 3000)
  assert.equal(f.current(replacement.id).status, 'accepted')
  assert.equal(f.current(report.id).status, 'accepted')
  assert.equal(f.task('v_report').status, 'accepted')
})

test('a blocked optional experiment keeps its evidence and status when the required plan completes', async t => {
  const f = await fixture(t)
  const report = f.task('s_report')
  const experiment = f.runtime.propose(f.owner, f.missionId, { outputs: [], workstreamId: report.workstreamId, scope: report.scope,
    acceptance: ['Explore an optional hypothesis'], title: 'Optional experiment', objective: 'Explore a non-required alternative',
    kind: 'research', experiment: true, maxSteps: 1, maxRecoveryAttempts: 3, assigneeId: f.author.id })
  const claimed = await f.runtime.claim(f.actor(f.author), f.missionId, experiment.id)
  const runId = await f.workers.callbacks.toolRun(f.author.id, { tool: 'read_file', arguments: { path: 'docs/reviews/audit.md' }, result: 'Partial experimental result', isError: false })
  f.runtime.publish(f.actor(f.author), f.missionId, { taskId: experiment.id, attemptId: claimed.attempt.id,
    claim: 'Preserve the partial experiment', outcome: 'supported', toolRunIds: [runId] })
  await f.workers.callbacks.beforeStep(f.author.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.author.id), false)
  await eventually(() => !f.current(experiment.id).resumeAfterStop, 'the experimental worker stops before other work resumes', 3000)
  const blocked = f.current(experiment.id)
  assert.equal(blocked.status, 'blocked')
  await f.strandReport()
  f.runtime.cancel(f.owner, f.missionId, { taskId: report.id, reason: 'Owner explicitly accepts the audit artifact as the deliverable' })
  await eventually(() => f.runtime.store.get('missions', f.missionId).status === 'completed', 'a blocked optional experiment does not hold required completion open', 3000)
  assert.equal(f.current(experiment.id).status, 'blocked', 'completion does not silently cancel even optional work')
  assert.deepEqual(f.current(experiment.id).evidenceIds, blocked.evidenceIds)
  assert.equal(f.current(experiment.id).usedSteps, blocked.usedSteps)
  assert.equal(f.events('task/cancelled-at-completion').length, 0)
})
