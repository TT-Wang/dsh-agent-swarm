import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { runProcess } from '../lib/workspaces.js'
import { requireHostChecks } from '../lib/admission.js'
import { artifactNeedsChecks } from '../lib/artifact-policy.js'
import { subprocessSeam } from './subprocess-seam.mjs'
import { makeWorkspaces } from './faults/harness.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-artifact-policy-')))
  const source = path.join(root, 'source')
  await mkdir(source)
  const command = async (cwd, argv) => {
    const result = await runProcess(argv, { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 })
    assert.equal(result.exitCode, 0, result.output)
    return result.output.trim()
  }
  await command(source, ['git', 'init', '-b', 'main'])
  await writeFile(path.join(source, 'README.md'), 'Fixture\n')
  await writeFile(path.join(source, '.gitignore'), 'reviews/\n')
  await command(source, ['git', 'add', '.'])
  await command(source, ['git', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'baseline'])
  const workspaces = makeWorkspaces(root)
  const workers = {
    bind(callbacks) { this.callbacks = callbacks },
    prepareBaseline: (...args) => workspaces.prepareBaseline(...args),
    prepareWorkspace: (...args) => workspaces.prepareWorkspace(...args),
    prepareTask: (...args) => workspaces.prepareTask(...args),
    captureArtifact: (...args) => workspaces.captureArtifact(...args),
    inspectArtifact: (...args) => workspaces.inspectArtifact(...args),
    verifyArtifact: (...args) => workspaces.verifyArtifact(...args),
    start: async () => {}, stop: async () => {}, deliver: async () => {}, isIdle: () => false,
    dispose: () => workspaces.dispose(),
  }
  const runtime = new SwarmRuntime({ statePath: path.join(root, 'state.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Review', objective: 'Inspect project', workspace: source, scope: ['**'], acceptance: ['Reviewed'], budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2, maxTasks: 12, maxExperiments: 0, maxDurationMs: 600000 } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Review', objective: 'Inspect project' })
  const author = await runtime.addMember(owner, mission.id, { role: 'author' })
  const reviewer = await runtime.addMember(owner, mission.id, { role: 'reviewer' })
  const a = { sessionId: author.sessionId }, b = { sessionId: reviewer.sessionId }
  const propose = extra => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Review', objective: 'Inspect project', scope: ['**'], acceptance: ['Reviewed'], kind: 'research', checks: [], ...extra })
  const readEvidence = async (member, actor, task, file) => {
    const result = await readFile(path.join(member.workspace, file), 'utf8')
    await workers.callbacks.toolRun(member.id, { tool: 'read', arguments: { path: file }, result, isError: false })
    const runs = runtime.observe(actor, mission.id, { taskId: task.id }).toolRuns
    return runtime.publish(actor, mission.id, { taskId: task.id, attemptId: task.attempt.id, claim: `Read ${file}`, outcome: 'supported', toolRunIds: [runs.at(-1).id] })
  }
  return { root, source, runtime, workers, workspaces, owner, mission, author, reviewer, a, b, propose, readEvidence }
}

test('research label cannot submit real JS changes without checks; captured work and evidence survive', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose().id)
  await writeFile(path.join(f.author.workspace, 'change.js'), 'export const answer = 42\n')
  await f.readEvidence(f.author, f.a, task, 'change.js')
  await assert.rejects(f.runtime.submit(f.a, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Research complete', deliverables: ['change.js'] }), /artifact_checks_required/)
  const current = f.runtime.snapshot(f.owner, f.mission.id).tasks.find(row => row.id === task.id)
  assert.equal(current.status, 'running')
  assert.equal(current.evidenceIds.length, 1)
  assert.equal(await readFile(path.join(f.author.workspace, 'change.js'), 'utf8'), 'export const answer = 42\n')
  const captured = await f.workspaces.captureArtifact(f.author, current, ['change.js'])
  assert.ok(captured.files[0].blob)
  assert.deepEqual(captured.changedPaths, ['change.js'])
  const amended = f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { checks: ['node --check change.js'] }, 'Check actual code without replacing the task')
  assert.equal(amended.id, task.id)
  assert.deepEqual(amended.acceptance, ['Reviewed'])
  assert.deepEqual(amended.checks, ['node --check change.js'])
})

test('a real report retains evidence plus independent review without declared commands', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose().id)
  await writeFile(path.join(f.author.workspace, 'report.md'), 'A useful finding\n')
  await f.readEvidence(f.author, f.a, task, 'report.md')
  const source = await f.runtime.submit(f.a, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Report', deliverables: ['report.md'] })
  const review = await f.runtime.claim(f.b, f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id }).id)
  assert.equal(review.attempt.sourceCommit, source.artifact.commit)
  await assert.rejects(f.runtime.verify(f.b, f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'No supporting read' }), /independent host-recorded/)
  await f.readEvidence(f.reviewer, f.b, review, 'report.md')
  await f.runtime.verify(f.b, f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Read the immutable report' })
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'Reviewed').status, 'completed')
})

test('legacy submitted code replaces obsolete no-op checks on the same artifact before acceptance', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose().id)
  await writeFile(path.join(f.author.workspace, 'change.js'), 'export const answer = 42\n')
  await f.readEvidence(f.author, f.a, task, 'change.js')
  const artifact = await f.workspaces.captureArtifact(f.author, task)
  f.runtime.commit(f.mission.id, () => {
    const current = f.runtime.store.get('tasks', task.id)
    current.status = 'submitted'; current.artifact = artifact; current.checks = ['true']
    f.runtime.store.put('tasks', current)
  })
  const review = await f.runtime.claim(f.b, f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id }).id)
  await assert.rejects(f.runtime.verify(f.b, f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Code is research' }), /artifact_checks_required/)
  const amended = f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { checks: ['node --check change.js'] }, 'Add missing checks to the frozen artifact')
  assert.equal(amended.status, 'submitted')
  assert.equal(amended.artifact.commit, artifact.commit)
  await assert.rejects(Promise.resolve().then(() => f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { checks: [] }, 'Remove checks')), /immutable/)
  await f.runtime.verify(f.b, f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Run the added code check' })
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(row => row.id === task.id).status, 'accepted')
})

test('legacy executable report metadata is read from the commit before accepting', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose().id)
  await writeFile(path.join(f.author.workspace, 'report.txt'), '#!/bin/sh\necho changed\n')
  await chmod(path.join(f.author.workspace, 'report.txt'), 0o755)
  await f.readEvidence(f.author, f.a, task, 'report.txt')
  const { executablePaths, ...oldArtifact } = await f.workspaces.captureArtifact(f.author, task)
  assert.deepEqual(executablePaths, ['report.txt'])
  f.runtime.commit(f.mission.id, () => {
    const current = f.runtime.store.get('tasks', task.id)
    current.status = 'submitted'; current.artifact = oldArtifact
    f.runtime.store.put('tasks', current)
  })
  const review = await f.runtime.claim(f.b, f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id }).id)
  await f.readEvidence(f.reviewer, f.b, review, 'report.txt')
  await assert.rejects(f.runtime.verify(f.b, f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Looks like a report' }), /artifact_checks_required/)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(row => row.id === task.id).status, 'submitted')
})

test('legacy code with no-op checks can still be independently rejected', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose().id)
  await writeFile(path.join(f.author.workspace, 'change.js'), 'export const answer = 0\n')
  await f.readEvidence(f.author, f.a, task, 'change.js')
  const artifact = await f.workspaces.captureArtifact(f.author, task)
  f.runtime.commit(f.mission.id, () => {
    const current = f.runtime.store.get('tasks', task.id)
    current.status = 'submitted'; current.artifact = artifact; current.checks = ['true']
    f.runtime.store.put('tasks', current)
  })
  const review = await f.runtime.claim(f.b, f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id }).id)
  await f.readEvidence(f.reviewer, f.b, review, 'change.js')
  await f.runtime.verify(f.b, f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'reject', reason: 'Answer is incorrect and true does not check it' })
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(row => row.id === task.id).status, 'blocked')
})

test('adding source checks during verification fences the old verdict, then the same review retries', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose({ checks: ['node --check change.js'] }).id)
  await writeFile(path.join(f.author.workspace, 'change.js'), 'export const answer = 42\n')
  await f.readEvidence(f.author, f.a, task, 'change.js')
  await f.runtime.submit(f.a, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Ready', deliverables: ['change.js'] })
  const review = await f.runtime.claim(f.b, f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id }).id)
  let started, release
  const entered = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const verify = f.workers.verifyArtifact
  f.workers.verifyArtifact = async (...args) => { started(); await gate; return verify(...args) }
  const input = { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Checks pass' }
  const pending = f.runtime.verify(f.b, f.mission.id, input)
  const rejected = assert.rejects(pending, /checks_changed_during_verification/)
  await entered
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { checks: ['node --check change.js', 'test -s change.js'] }, 'Add content assertion')
  release()
  await rejected
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(row => row.id === task.id).status, 'submitted')
  await f.runtime.verify(f.b, f.mission.id, input)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(row => row.id === task.id).status, 'accepted')
})

test('captured executable report modes require checks and literal no-ops are refused', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose().id)
  await writeFile(path.join(f.author.workspace, 'report.txt'), '#!/bin/sh\nexit 0\n')
  await chmod(path.join(f.author.workspace, 'report.txt'), 0o755)
  const artifact = await f.workspaces.captureArtifact(f.author, task)
  assert.deepEqual(artifact.executablePaths, ['report.txt'])
  assert.equal(artifactNeedsChecks(artifact), true)
  for (const command of ['true', ' : ', 'exit 0;', 'true;']) assert.throws(() => requireHostChecks('implementation', [command], 'task'), /check_noop/)
  requireHostChecks('implementation', ['node --check change.js'], 'task')
})

test('verification optionally captures an ignored report without changing the reviewed source', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose().id)
  await writeFile(path.join(f.author.workspace, 'report.md'), 'Immutable source finding\n')
  await f.readEvidence(f.author, f.a, task, 'report.md')
  const source = await f.runtime.submit(f.a, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Report', deliverables: ['report.md'] })
  const review = await f.runtime.claim(f.b, f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id }).id)
  await f.readEvidence(f.reviewer, f.b, review, 'report.md')
  await mkdir(path.join(f.reviewer.workspace, 'reviews'))
  const report = 'Independent verification with recorded evidence\n'
  await writeFile(path.join(f.reviewer.workspace, 'reviews', 'verdict.md'), report)
  const result = await f.runtime.verify(f.b, f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Checked immutable source', deliverables: ['reviews/verdict.md'] })
  assert.equal(result.status, 'accepted')
  assert.equal(result.reviewedCommit, source.artifact.commit)
  assert.notEqual(result.reviewArtifact.commit, source.artifact.commit)
  assert.ok(result.reviewArtifact.files.some(file => file.path === 'reviews/verdict.md' && file.blob))
  const contents = await runProcess(['git', 'show', `${result.reviewArtifact.commit}:reviews/verdict.md`], { subprocess: subprocessSeam, cwd: f.reviewer.workspace, timeoutMs: 30000, maxBytes: 10000 })
  assert.equal(contents.exitCode, 0); assert.equal(contents.output, report)
  assert.equal(f.runtime.store.get('tasks', source.id).artifact.commit, source.artifact.commit)
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'Reviewed').status, 'completed')
})

test('out-of-scope review report is refused before the source verdict changes', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose({ scope: ['report.md'] }).id)
  await writeFile(path.join(f.author.workspace, 'report.md'), 'Finding\n')
  await f.readEvidence(f.author, f.a, task, 'report.md')
  await f.runtime.submit(f.a, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Report', deliverables: ['report.md'] })
  const review = await f.runtime.claim(f.b, f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id, scope: ['report.md'] }).id)
  await f.readEvidence(f.reviewer, f.b, review, 'report.md')
  await writeFile(path.join(f.reviewer.workspace, 'outside.md'), 'Still retained\n')
  await assert.rejects(f.runtime.verify(f.b, f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Review', deliverables: ['outside.md'] }), { code: 'invalid_deliverable_path' })
  assert.equal(f.runtime.store.get('tasks', task.id).status, 'submitted')
  assert.equal(f.runtime.store.get('tasks', review.id).status, 'running')
  assert.equal(await readFile(path.join(f.reviewer.workspace, 'outside.md'), 'utf8'), 'Still retained\n')
})


test('captured review report survives deferred checks and reassignment without locking recovery', async t => {
  const f = await fixture(t)
  f.runtime.kick = () => {}
  f.workers.checkpointTask = (...args) => f.workspaces.checkpointTask(...args)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose({ checks: ['test -s report.md'] }).id)
  await writeFile(path.join(f.author.workspace, 'report.md'), 'Source remains immutable')
  await f.readEvidence(f.author, f.a, task, 'report.md')
  const source = await f.runtime.submit(f.a, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Ready', deliverables: ['report.md'] })
  const review = await f.runtime.claim(f.b, f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id }).id)
  await mkdir(path.join(f.reviewer.workspace, 'reviews'))
  await writeFile(path.join(f.reviewer.workspace, 'reviews/verdict.md'), 'Preserved first reviewer record')
  const verify = f.workers.verifyArtifact
  f.workers.verifyArtifact = async () => [{ command: 'test -s report.md', exitCode: 124, output: 'Host timed out', failureKind: 'timeout' }]
  const blocked = await f.runtime.verify(f.b, f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Checks unavailable', deliverables: ['reviews/verdict.md'] })
  assert.equal(blocked.status, 'blocked'); assert.ok(blocked.verificationRecovery)
  assert.ok(blocked.reviewArtifact); assert.equal(blocked.artifact, undefined)
  assert.equal(f.runtime.task(f.mission.id, task.id).artifact.commit, source.artifact.commit)
  f.workers.verifyArtifact = verify
  f.runtime.updateBudget(f.owner, f.mission.id, { ...f.runtime.mission(f.mission.id).budget, maxWorkers: 3 }, 'Replacement reviewer availability')
  const nextReviewer = await f.runtime.addMember(f.owner, f.mission.id, { role: 'independent replacement reviewer' })
  f.runtime.controlTask(f.owner, f.mission.id, review.id, 'resume', { assigneeId: nextReviewer.id }, 'Host repaired; reviewer unavailable')
  // The stop barrier checkpoints the reviewer's workspace with real git before it
  // re-pends the review; wait for the barrier itself, however long git takes,
  // instead of reading a status the barrier has not decided yet.
  await f.runtime.settle(f.mission.id)
  assert.equal(f.runtime.task(f.mission.id, review.id).resumeAfterStop, undefined, 'the stop barrier settled')
  assert.equal(f.runtime.task(f.mission.id, review.id).status, 'pending', 'saved review record is not a rejected deliverable exhaustion gate')
  const nextActor = { sessionId: nextReviewer.sessionId }
  const resumed = await f.runtime.claim(nextActor, f.mission.id, review.id)
  assert.equal(await readFile(path.join(nextReviewer.workspace, 'reviews/verdict.md'), 'utf8'), 'Preserved first reviewer record')
  await writeFile(path.join(nextReviewer.workspace, 'reviews/verdict.md'), 'Replacement reviewer verified the exact original source')
  const accepted = await f.runtime.verify(nextActor, f.mission.id, { taskId: resumed.id, attemptId: resumed.attempt.id, verdict: 'accept', reason: 'Host checks now pass', deliverables: ['reviews/verdict.md'] })
  assert.equal(accepted.status, 'accepted'); assert.equal(accepted.reviewedCommit, source.artifact.commit)
  assert.notEqual(accepted.reviewArtifact.commit, blocked.reviewArtifact.commit)
  assert.equal(accepted.artifact, undefined)
  const row = f.runtime.artifacts(f.owner, { missionId: f.mission.id }).artifacts.find(row => row.taskId === review.id)
  assert.equal(row.artifactRole, 'review-record')
  assert.equal(row.reviewedCommit, source.artifact.commit)
})

test('review report capture cannot promote reviewer experiments through a dependency edge', async t => {
  const f = await fixture(t)
  f.runtime.kick = () => {}
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose().id)
  await writeFile(path.join(f.author.workspace, 'report.md'), 'Source finding')
  await f.readEvidence(f.author, f.a, task, 'report.md')
  const source = await f.runtime.submit(f.a, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Ready', deliverables: ['report.md'] })
  const review = await f.runtime.claim(f.b, f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id }).id)
  await f.readEvidence(f.reviewer, f.b, review, 'report.md')
  await mkdir(path.join(f.reviewer.workspace, 'reviews'))
  await writeFile(path.join(f.reviewer.workspace, 'reviews/verdict.md'), 'Reviewer record')
  await writeFile(path.join(f.reviewer.workspace, 'reviewer-experiment.js'), 'throw new Error("not a deliverable")')
  const accepted = await f.runtime.verify(f.b, f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Read source', deliverables: ['reviews/verdict.md'] })
  assert.ok(accepted.reviewArtifact.changedPaths.includes('reviewer-experiment.js'))
  const followup = await f.runtime.claim(f.a, f.mission.id, f.propose({ dependencies: [source.id, review.id] }).id)
  assert.equal(followup.status, 'running')
  assert.equal(await readFile(path.join(f.author.workspace, 'report.md'), 'utf8'), 'Source finding')
  await assert.rejects(readFile(path.join(f.author.workspace, 'reviewer-experiment.js'), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(f.author.workspace, 'reviews/verdict.md'), 'utf8'), { code: 'ENOENT' })
})
