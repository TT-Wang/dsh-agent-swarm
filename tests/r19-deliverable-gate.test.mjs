/**
 * Round-19 H-1: an undeclared, ignored deliverable is refused at submit, and
 * completion re-checks the named deliverables of accepted research work.
 *
 * Pre-fix, a research task whose text named `docs/report.md` (hidden by a
 * `docs/.gitignore` of `*`) was accepted with an artifact that omitted the
 * report when the member left `deliverables` empty: capture returned the
 * omission only as the advisory `artifact.uncapturedPaths`, nothing gated it,
 * and the owner was told every deliverable was independently accepted while
 * the report existed only in the member worktree.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r19-deliverable-')))
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'docs'), { recursive: true })
  await mkdir(path.join(source, 'notes'), { recursive: true })
  await mkdir(path.join(source, 'src'), { recursive: true })
  const command = async (cwd, argv) => {
    const result = await runProcess(argv, { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 })
    assert.equal(result.exitCode, 0, result.output)
    return result.output.trim()
  }
  await command(source, ['git', 'init', '-b', 'main'])
  await writeFile(path.join(source, 'README.md'), 'Fixture\n')
  // The shape this repository ships: docs/ ignores everything but named files.
  await writeFile(path.join(source, 'docs', '.gitignore'), '*\n!.gitignore\n')
  await writeFile(path.join(source, 'notes', '.gitkeep'), '')
  await writeFile(path.join(source, 'src', 'index.js'), 'export const answer = 42\n')
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
  const runtime = new SwarmRuntime({ statePath: path.join(root, 'state.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 200, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Report', objective: 'Report on the project', workspace: source, scope: ['**'], acceptance: ['Reviewed'], budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2, maxTasks: 12, maxExperiments: 0, maxDurationMs: 600000 } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Report', objective: 'Report on the project' })
  const author = await runtime.addMember(owner, mission.id, { role: 'research' })
  const reviewer = await runtime.addMember(owner, mission.id, { role: 'verification' })
  const a = { sessionId: author.sessionId }, b = { sessionId: reviewer.sessionId }
  const propose = extra => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Report', objective: 'Inspect the repository', scope: ['docs/', 'notes/'], acceptance: ['Reviewed'], kind: 'research', checks: [], ...extra })
  const readEvidence = async (member, actor, task, file) => {
    const result = await readFile(path.join(member.workspace, file), 'utf8')
    await workers.callbacks.toolRun(member.id, { tool: 'read', arguments: { path: file }, result, isError: false })
    const runs = runtime.observe(actor, mission.id, { taskId: task.id }).toolRuns
    return runtime.publish(actor, mission.id, { taskId: task.id, attemptId: task.attempt.id, claim: `Read ${file}`, outcome: 'supported', toolRunIds: [runs.at(-1).id] })
  }
  const submit = (task, input) => runtime.submit(a, mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Done', ...input })
  const accept = async (task, file) => {
    const review = await runtime.claim(b, mission.id, propose({ kind: 'verification', reviewOf: task.id, scope: ['**'] }).id)
    await readEvidence(reviewer, b, review, file)
    await runtime.verify(b, mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Read the immutable artifact' })
    return runtime.snapshot(owner, mission.id)
  }
  const taskRow = id => runtime.snapshot(owner, mission.id).tasks.find(row => row.id === id)
  return { root, source, runtime, workers, workspaces, owner, mission, author, reviewer, a, b, propose, readEvidence, submit, accept, taskRow }
}

test('H-1: a hinted ignored report omitted from deliverables is refused with the repair; the attempt stays live and the declared resubmission is accepted', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose({ objective: 'Write docs/report.md' }).id)
  await writeFile(path.join(f.author.workspace, 'docs', 'report.md'), '# Report\n\nfindings\n')
  await f.readEvidence(f.author, f.a, task, 'docs/report.md')
  for (const deliverables of [[], undefined]) {
    await assert.rejects(f.submit(task, deliverables === undefined ? {} : { deliverables }), error => {
      assert.equal(error.name, 'PolicyError')
      assert.equal(error.code, 'deliverable_uncaptured')
      assert.ok(error.message.startsWith('[deliverable_uncaptured]'), error.message)
      assert.match(error.message, /"docs\/report\.md"/)
      assert.match(error.message, /retry `swarm_submit` with `deliverables`: \["docs\/report\.md"\]/i)
      return true
    })
    const current = f.taskRow(task.id)
    assert.equal(current.status, 'running', 'the refusal keeps the attempt running so the member can resubmit')
    assert.equal(current.attempt.id, task.attempt.id)
    assert.equal(current.artifact, undefined)
  }
  assert.ok(!f.runtime.store.events(f.mission.id, 200).some(event => event.type === 'task/submitted'), 'no submission is recorded until the report is captured')
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).completion.eligible, false)
  const submitted = await f.submit(task, { deliverables: ['docs/report.md'] })
  assert.equal(submitted.status, 'submitted')
  assert.deepEqual(submitted.artifact.files.map(file => file.path), ['docs/report.md'])
  assert.equal(submitted.artifact.uncapturedPaths, undefined)
  assert.ok(submitted.artifact.changedPaths.includes('docs/report.md'))
  const snapshot = await f.accept(task, 'docs/report.md')
  assert.equal(await readFile(path.join(f.reviewer.workspace, 'docs', 'report.md'), 'utf8'), '# Report\n\nfindings\n')
  assert.equal(f.taskRow(task.id).status, 'accepted')
  assert.equal(snapshot.completion.eligible, true, snapshot.completion.reason)
})

test('an undeclared report in a tracked directory is captured by the whole-tree add and accepted', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose({ objective: 'Write notes/report.md' }).id)
  await writeFile(path.join(f.author.workspace, 'notes', 'report.md'), 'A useful finding\n')
  await f.readEvidence(f.author, f.a, task, 'notes/report.md')
  const submitted = await f.submit(task, {})
  assert.deepEqual(submitted.artifact.changedPaths, ['notes/report.md'])
  assert.equal(submitted.artifact.files, undefined)
  assert.equal(submitted.artifact.uncapturedPaths, undefined)
  const snapshot = await f.accept(task, 'notes/report.md')
  assert.equal(f.taskRow(task.id).status, 'accepted')
  assert.equal(snapshot.completion.eligible, true, snapshot.completion.reason)
})

test('a research task that names no path still completes on evidence alone', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose({ objective: 'Inspect the repository and report findings as evidence' }).id)
  await f.readEvidence(f.author, f.a, task, 'README.md')
  const submitted = await f.submit(task, {})
  assert.deepEqual(submitted.artifact.changedPaths, [])
  assert.equal(submitted.artifact.commit, submitted.artifact.baseCommit)
  const snapshot = await f.accept(task, 'README.md')
  assert.equal(f.taskRow(task.id).status, 'accepted')
  assert.equal(snapshot.completion.eligible, true, snapshot.completion.reason)
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'Evidence reviewed').status, 'completed')
})

test('a research task that names an in-scope output it never wrote is refused with the same code; an out-of-scope name is only a reference', async t => {
  const f = await fixture(t)
  // "Update" precedes both paths, so the heuristic names src/index.js too; it is
  // outside the task scope, so capture could never include it and it is not required.
  const task = await f.runtime.claim(f.a, f.mission.id, f.propose({ objective: 'Update notes/summary.md from src/index.js' }).id)
  await f.readEvidence(f.author, f.a, task, 'README.md')
  await assert.rejects(f.submit(task, {}), error => {
    assert.equal(error.code, 'deliverable_uncaptured')
    assert.match(error.message, /"notes\/summary\.md"/)
    assert.doesNotMatch(error.message, /src\/index\.js/)
    return true
  })
  assert.equal(f.taskRow(task.id).status, 'running')
  await writeFile(path.join(f.author.workspace, 'notes', 'summary.md'), 'Summary\n')
  const submitted = await f.submit(task, {})
  assert.deepEqual(submitted.artifact.changedPaths, ['notes/summary.md'])
})

test('completion defense: an accepted research task whose text names a path its artifact lacks is not eligible until the artifact carries it', async t => {
  const f = await fixture(t)
  const row = { id: 'task_legacy_report', missionId: f.mission.id, workstreamId: 'stream', title: 'Legacy report', objective: 'Write docs/report.md', kind: 'research',
    dependencies: [], scope: ['docs/'], acceptance: ['Reviewed'], checks: [], status: 'accepted', priority: 50, experiment: false, epoch: 1, evidenceIds: [],
    artifact: { commit: 'a'.repeat(40), baseCommit: 'a'.repeat(40), workspace: '/isolated', changedPaths: [] } }
  // Task rows are compare-and-swapped, so every rewrite starts from the durable row.
  const put = changes => f.runtime.store.transaction(() => f.runtime.store.put('tasks', { ...(f.runtime.store.get('tasks', row.id) ?? row), ...changes }))
  put({})
  const blocked = f.runtime.snapshot(f.owner, f.mission.id).completion
  assert.equal(blocked.eligible, false)
  assert.match(blocked.reason, /task_legacy_report/)
  assert.match(blocked.reason, /"docs\/report\.md"/)
  assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'Report accepted'), /docs\/report\.md/)
  // The declared blob manifest satisfies the obligation exactly as a changed path does.
  put({ artifact: { ...row.artifact, files: [{ path: 'docs/report.md', blob: 'b'.repeat(40), bytes: 9 }] } })
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).completion.eligible, true)
  put({ artifact: { ...row.artifact, changedPaths: ['docs/report.md'] } })
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).completion.eligible, true)
  // A pure-analysis row with an empty artifact is still covered by its evidence.
  put({ objective: 'Inspect the repository', artifact: { ...row.artifact } })
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).completion.eligible, true)
})
