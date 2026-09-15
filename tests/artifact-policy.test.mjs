import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { requireHostChecks } from '../lib/admission.js'
import { artifactNeedsChecks } from '../lib/artifact-policy.js'
import { subprocessSeam } from './subprocess-seam.mjs'

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
  await command(source, ['git', 'add', '.'])
  await command(source, ['git', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'baseline'])
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: path.join(root, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv })
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
  const propose = extra => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Review', objective: 'Inspect project', scope: ['**'], acceptance: ['Reviewed'], kind: 'research', checks: [], ...extra })
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
