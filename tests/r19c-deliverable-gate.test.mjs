/**
 * Round-19 C: four verified gaps in the `[deliverable_uncaptured]` gate.
 *
 * F1: workspace preservation force-includes hinted ignored files (a member's
 *     `.env`, a report draft) into the private snapshot so they survive a
 *     handoff, and the replacement's worktree was checked out AT that snapshot,
 *     so the files were TRACKED there: `git check-ignore` never reports tracked
 *     files, the gate saw nothing, and an undeclared submit published the
 *     secret into the immutable artifact. Recovery now un-tracks every hinted
 *     path the snapshot force-included (present in the index, ignored by
 *     pattern, absent from the task base), so it is back to untracked+ignored on
 *     disk and the gate flags it unless declared.
 * F2: on a case-insensitive filesystem the text's spelling (`docs/Report.md`)
 *     and the on-disk spelling (`docs/report.md`) were two different names to
 *     the gate and to `git add`, so neither declaration could get through.
 * F3: `swarm_verify` with `deliverables` captured a review artifact without the
 *     gate, so a hinted ignored review report could be silently left out.
 * F4: a hinted path inside an ignored dependency directory or the member
 *     scratch root was an obligation (and force-captured when declared).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { ignoredDeliverablePaths } from '../lib/admission.js'
import { subprocessSeam } from './subprocess-seam.mjs'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxTasks: 12, maxExperiments: 0, maxDurationMs: 600000 }
const SECRET = 'DATABASE_URL=postgres://user:SECRET@db/prod\n'
async function eventually(read, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = read()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(message)
}
/** True when the temp filesystem folds case (macOS default); the F2 regression needs that. */
async function caseInsensitiveTemp() {
  const dir = await mkdtemp(path.join(tmpdir(), 'swarm-r19c-case-'))
  try {
    await writeFile(path.join(dir, 'probe'), '')
    return await lstat(path.join(dir, 'PROBE')).then(() => true, () => false)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r19c-gate-')))
  const source = path.join(root, 'source')
  for (const dir of ['docs', 'notes', 'src']) await mkdir(path.join(source, dir), { recursive: true })
  const run = (cwd, argv) => runProcess(argv, { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 200000 })
  const command = async (cwd, argv) => {
    const result = await run(cwd, argv)
    assert.equal(result.exitCode, 0, result.output)
    return result.output.trim()
  }
  const git = (cwd, ...args) => command(cwd, ['git', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args])
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, 'README.md'), 'Fixture\n')
  // The shape this repository ships plus the two toolchain roots: docs/ ignores
  // everything but named files, the root ignores the local environment file,
  // the dependency directory and the member scratch root.
  await writeFile(path.join(source, '.gitignore'), '.env\nnode_modules/\n.swarm-scratch/\n')
  await writeFile(path.join(source, 'docs', '.gitignore'), '*\n!.gitignore\n')
  await writeFile(path.join(source, 'notes', '.gitkeep'), '')
  await writeFile(path.join(source, 'src', 'index.js'), 'export const answer = 42\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'baseline')
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: path.join(root, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv })
  // Production-shaped: the stop barrier reaches Workspaces.checkpointTask exactly as HarnessWorkers forwards it.
  const workers = {
    bind(callbacks) { this.callbacks = callbacks },
    prepareBaseline: (...args) => workspaces.prepareBaseline(...args),
    prepareWorkspace: (...args) => workspaces.prepareWorkspace(...args),
    prepareTask: (...args) => workspaces.prepareTask(...args),
    checkpointTask: (...args) => workspaces.checkpointTask(...args),
    captureArtifact: (...args) => workspaces.captureArtifact(...args),
    inspectArtifact: (...args) => workspaces.inspectArtifact(...args),
    verifyArtifact: (...args) => workspaces.verifyArtifact(...args),
    start: async () => {}, stop: async () => {}, deliver: async () => {}, isIdle: () => false,
    dispose: () => workspaces.dispose(),
  }
  const runtime = new SwarmRuntime({ statePath: path.join(root, 'state.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 200, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Report', objective: 'Report on the project', workspace: source, scope: ['**'], acceptance: ['Reviewed'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Report', objective: 'Report on the project' })
  const author = await runtime.addMember(owner, mission.id, { role: 'research' })
  const peer = await runtime.addMember(owner, mission.id, { role: 'research' })
  const reviewer = await runtime.addMember(owner, mission.id, { role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = extra => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Report', objective: 'Inspect the repository', scope: ['**'], acceptance: ['Reviewed'], kind: 'research', checks: [], ...extra })
  const readEvidence = async (member, task, file) => {
    const result = await readFile(path.join(member.workspace, file), 'utf8')
    await workers.callbacks.toolRun(member.id, { tool: 'read', arguments: { path: file }, result, isError: false })
    const runs = runtime.observe(actor(member), mission.id, { taskId: task.id }).toolRuns
    return runtime.publish(actor(member), mission.id, { taskId: task.id, attemptId: task.attempt.id, claim: `Read ${file}`, outcome: 'supported', toolRunIds: [runs.at(-1).id] })
  }
  const submit = (member, task, input) => runtime.submit(actor(member), mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Done', ...input })
  const taskRow = id => runtime.store.get('tasks', id)
  const artifacts = path.join(root, 'worktrees', mission.id, 'artifacts.git')
  const inCommit = async (commit, file) => (await run(source, ['git', 'cat-file', '-e', `${commit}:${file}`])).exitCode === 0
  /** Every ref under `prefix` in the mission's durable artifact repository whose tree carries `file`. */
  const refsCarrying = async (file, prefix = 'refs/artifacts/') => {
    const carrying = []
    for (const line of (await git(artifacts, 'for-each-ref', '--format=%(refname) %(objectname)', prefix)).split('\n').filter(Boolean)) {
      const [ref, sha] = line.split(' ')
      if ((await run(artifacts, ['git', 'cat-file', '-e', `${sha}:${file}`])).exitCode === 0) carrying.push(ref)
    }
    return carrying
  }
  const refused = (error, paths, tool = 'swarm_submit') => {
    assert.equal(error.name, 'PolicyError', error.message)
    assert.equal(error.code, 'deliverable_uncaptured')
    assert.ok(error.message.startsWith('[deliverable_uncaptured]'), error.message)
    for (const name of paths) assert.ok(error.message.includes(JSON.stringify(name)), `${error.message} names ${name}`)
    assert.ok(error.message.includes(`retry \`${tool}\` with \`deliverables\`: ${JSON.stringify(paths)}`), `${error.message} offers the declare repair for ${tool}`)
    assert.ok(error.message.includes(`remove them from your worktree and retry \`${tool}\``), `${error.message}: the second repair is removal`)
    assert.doesNotMatch(error.message, /input/i, 'the refusal never suggests declaring an input')
    return true
  }
  return { root, source, run, git, runtime, workers, workspaces, owner, mission, author, peer, reviewer, actor, propose, readEvidence, submit, taskRow, inCommit, refsCarrying, refused }
}

test('F1: a hinted ignored .env and report draft survive a handoff on disk but untracked, so the replacement is refused until it declares the report and removes the secret, and no artifact ref ever carries the secret', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Update notes/config.md to read DATABASE_URL from .env', acceptance: ['Write docs/report.md'] }).id)
  await writeFile(path.join(f.author.workspace, 'notes', 'config.md'), 'DATABASE_URL comes from .env\n')
  await writeFile(path.join(f.author.workspace, '.env'), SECRET)
  await writeFile(path.join(f.author.workspace, 'docs', 'report.md'), '# Draft by the first owner\n')
  await f.readEvidence(f.author, task, 'notes/config.md')
  // The production stop barrier: handoff -> stop -> Workspaces.checkpointTask (preservation snapshot) -> pending.
  f.runtime.handoff(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: task.attempt.id, to: f.peer.id, summary: 'Handing the config work over' })
  await eventually(() => f.taskRow(task.id).status === 'pending', 'the stop barrier checkpointed the first owner and released the task')
  assert.ok((await f.refsCarrying('.env', 'refs/preservation/')).length >= 1, 'the private preservation snapshot carries the hinted draft across the handoff (the feature stays)')
  const recovered = await f.runtime.claim(f.actor(f.peer), f.mission.id, task.id)
  assert.equal(recovered.attempt.ownerId, f.peer.id)
  // Both hinted ignored files are on disk in the replacement's worktree, but untracked and ignored again.
  assert.equal(await readFile(path.join(f.peer.workspace, '.env'), 'utf8'), SECRET)
  assert.equal(await readFile(path.join(f.peer.workspace, 'docs', 'report.md'), 'utf8'), '# Draft by the first owner\n')
  assert.equal(await readFile(path.join(f.peer.workspace, 'notes', 'config.md'), 'utf8'), 'DATABASE_URL comes from .env\n', 'ordinary WIP is inherited as before')
  assert.equal(await f.git(f.peer.workspace, 'ls-files', '--', '.env', 'docs/report.md'), '', 'the hinted ignored files are not tracked in the recovered worktree')
  assert.equal(await f.git(f.peer.workspace, 'check-ignore', '.env', 'docs/report.md'), '.env\ndocs/report.md', 'they are ignored again')
  await assert.rejects(f.submit(f.peer, recovered, {}), error => f.refused(error, ['.env', 'docs/report.md']))
  assert.equal(f.taskRow(task.id).status, 'running')
  assert.equal(f.taskRow(task.id).attempt.id, recovered.attempt.id)
  await assert.rejects(f.submit(f.peer, recovered, { deliverables: ['docs/report.md'] }), error => f.refused(error, ['.env']))
  assert.deepEqual(await f.refsCarrying('.env'), [], 'no artifact ref carries the secret after the refusals')
  await rm(path.join(f.peer.workspace, '.env'))
  const submitted = await f.submit(f.peer, recovered, { deliverables: ['docs/report.md'] })
  assert.equal(submitted.status, 'submitted')
  assert.deepEqual(submitted.artifact.files.map(file => file.path), ['docs/report.md'])
  assert.ok(submitted.artifact.changedPaths.includes('docs/report.md') && submitted.artifact.changedPaths.includes('notes/config.md'), JSON.stringify(submitted.artifact.changedPaths))
  assert.ok(!submitted.artifact.changedPaths.includes('.env'))
  assert.equal(submitted.artifact.uncapturedPaths, undefined)
  assert.equal(await f.inCommit(submitted.artifact.commit, '.env'), false, 'the secret never entered the immutable artifact')
  assert.equal(await f.inCommit(submitted.artifact.commit, 'docs/report.md'), true)
  assert.deepEqual(await f.refsCarrying('.env'), [], 'no artifact ref carries the secret after the submission')
  assert.equal(await readFile(path.join(f.author.workspace, '.env'), 'utf8'), SECRET, 'the previous owner worktree is untouched')
})

test('F1: a member switching away from the task and back recovers the hinted ignored file untracked, so capture still reports it', async t => {
  const f = await fixture(t)
  const mission = { id: 'switch-back', workspace: f.source }
  const member = { id: 'switcher', missionId: mission.id, workspace: await f.workspaces.prepareWorkspace(mission, 'switcher') }
  const first = { id: 'config', missionId: mission.id, epoch: 1, title: 'Config', kind: 'research', scope: ['**'], checks: [], status: 'running', objective: 'Update notes/config.md to read DATABASE_URL from .env', acceptance: [] }
  const other = { ...first, id: 'other', objective: 'Write notes/other.md' }
  await f.workspaces.prepareTask(member, first, [])
  await writeFile(path.join(member.workspace, 'notes', 'config.md'), 'uses .env\n')
  await writeFile(path.join(member.workspace, '.env'), SECRET)
  await f.workspaces.prepareTask(member, other, [])
  await f.workspaces.prepareTask(member, { ...first, epoch: 2 }, [])
  assert.equal(await readFile(path.join(member.workspace, '.env'), 'utf8'), SECRET, 'the hinted ignored file is back on disk')
  assert.equal(await readFile(path.join(member.workspace, 'notes', 'config.md'), 'utf8'), 'uses .env\n')
  assert.equal(await f.git(member.workspace, 'ls-files', '--', '.env'), '', 'but it is not tracked')
  const artifact = await f.workspaces.captureArtifact(member, { ...first, epoch: 2 })
  assert.deepEqual(artifact.uncapturedPaths, ['.env'])
  assert.deepEqual(artifact.changedPaths, ['notes/config.md'])
  assert.equal(await f.inCommit(artifact.commit, '.env'), false)
  assert.equal(await readFile(path.join(member.workspace, '.env'), 'utf8'), SECRET, 'capture leaves the file on disk for the member to declare or remove')
})

test('F2: on a case-insensitive filesystem the on-disk spelling is the one the gate names and either spelling declares it', { skip: (await caseInsensitiveTemp()) ? false : 'the temp filesystem is case-sensitive' }, async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Write docs/Report.md' }).id)
  await writeFile(path.join(f.author.workspace, 'docs', 'report.md'), '# Report\n')
  await f.readEvidence(f.author, task, 'docs/report.md')
  await assert.rejects(f.submit(f.author, task, {}), error => {
    f.refused(error, ['docs/report.md'])
    assert.doesNotMatch(error.message, /docs\/Report\.md/, 'the refusal names the on-disk spelling, not the text spelling')
    return true
  })
  assert.equal(f.taskRow(task.id).status, 'running')
  const declaredAsWritten = await f.submit(f.author, task, { deliverables: ['docs/Report.md'] })
  assert.equal(declaredAsWritten.status, 'submitted')
  assert.deepEqual(declaredAsWritten.artifact.files.map(file => file.path), ['docs/report.md'], 'the captured file is recorded under its on-disk spelling')
  assert.equal(declaredAsWritten.artifact.uncapturedPaths, undefined)
  assert.equal(await f.inCommit(declaredAsWritten.artifact.commit, 'docs/report.md'), true)
  const second = await f.runtime.claim(f.actor(f.peer), f.mission.id, f.propose({ objective: 'Write docs/Summary.md' }).id)
  await writeFile(path.join(f.peer.workspace, 'docs', 'summary.md'), '# Summary\n')
  await f.readEvidence(f.peer, second, 'docs/summary.md')
  const declaredOnDisk = await f.submit(f.peer, second, { deliverables: ['docs/summary.md'] })
  assert.equal(declaredOnDisk.status, 'submitted')
  assert.deepEqual(declaredOnDisk.artifact.files.map(file => file.path), ['docs/summary.md'])
  assert.equal(declaredOnDisk.artifact.uncapturedPaths, undefined)
})

test('F3: swarm_verify with deliverables is gated the same way: an undeclared hinted ignored review report is refused with the attempt live; declaring it captures it in reviewArtifact.files', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Write docs/report.md' }).id)
  await writeFile(path.join(f.author.workspace, 'docs', 'report.md'), '# Report\n')
  await f.readEvidence(f.author, task, 'docs/report.md')
  const submitted = await f.submit(f.author, task, { deliverables: ['docs/report.md'] })
  assert.equal(submitted.status, 'submitted')
  const review = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id, objective: 'Review docs/report.md and record findings in docs/review.md', acceptance: ['Record findings in docs/review.md'] }).id)
  await writeFile(path.join(f.reviewer.workspace, 'docs', 'review.md'), 'looks fine\n')
  await writeFile(path.join(f.reviewer.workspace, 'docs', 'other.md'), 'other notes\n')
  await f.readEvidence(f.reviewer, review, 'docs/report.md')
  const verify = deliverables => f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Read the immutable artifact', deliverables })
  await assert.rejects(verify(['docs/other.md']), error => f.refused(error, ['docs/review.md'], 'swarm_verify'))
  assert.equal(f.taskRow(review.id).status, 'running', 'the refusal keeps the review attempt live')
  assert.equal(f.taskRow(review.id).attempt.id, review.attempt.id)
  assert.equal(f.taskRow(review.id).reviewArtifact, undefined)
  assert.equal(f.taskRow(task.id).status, 'submitted', 'no verdict was recorded')
  const verified = await verify(['docs/review.md', 'docs/other.md'])
  assert.equal(verified.status, 'accepted')
  assert.deepEqual(verified.reviewArtifact.files.map(file => file.path).sort(), ['docs/other.md', 'docs/review.md'])
  assert.equal(verified.reviewArtifact.uncapturedPaths, undefined)
  assert.equal(await f.inCommit(verified.reviewArtifact.commit, 'docs/review.md'), true)
  assert.equal(f.taskRow(task.id).status, 'accepted')
})

test('F4: a hinted path inside an ignored dependency directory or the member scratch root is neither an obligation nor a deliverable', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Write notes/summary.md', acceptance: ['Write node_modules/foo/README.md', 'Write .swarm-scratch/report.md'] }).id)
  await mkdir(path.join(f.author.workspace, 'node_modules', 'foo'), { recursive: true })
  await writeFile(path.join(f.author.workspace, 'node_modules', 'foo', 'README.md'), 'installed package\n')
  await mkdir(path.join(f.author.workspace, '.swarm-scratch'), { recursive: true })
  await writeFile(path.join(f.author.workspace, '.swarm-scratch', 'report.md'), 'scratch\n')
  await writeFile(path.join(f.author.workspace, 'notes', 'summary.md'), 'summary\n')
  await f.readEvidence(f.author, task, 'notes/summary.md')
  for (const name of ['node_modules/foo/README.md', '.swarm-scratch/report.md']) {
    await assert.rejects(f.submit(f.author, task, { deliverables: [name] }), error => error.code === 'invalid_deliverable_path' && error.message.includes(JSON.stringify(name)))
    assert.equal(f.taskRow(task.id).status, 'running')
  }
  const submitted = await f.submit(f.author, task, {})
  assert.equal(submitted.status, 'submitted')
  assert.deepEqual(submitted.artifact.changedPaths, ['notes/summary.md'])
  assert.equal(submitted.artifact.uncapturedPaths, undefined)
  for (const name of ['node_modules/foo/README.md', '.swarm-scratch/report.md']) assert.equal(await f.inCommit(submitted.artifact.commit, name), false)
})

test('ignoredDeliverablePaths reports a failed git check-ignore to its caller instead of silently returning nothing', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'swarm-r19c-norepo-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const failures = []
  assert.deepEqual(ignoredDeliverablePaths(dir, ['docs/report.md'], reason => failures.push(reason)), [])
  assert.equal(failures.length, 1)
  assert.match(failures[0], /check-ignore/)
  assert.deepEqual(ignoredDeliverablePaths(dir, ['docs/report.md']), [], 'without a callback the advisory admission path is unchanged')
})
