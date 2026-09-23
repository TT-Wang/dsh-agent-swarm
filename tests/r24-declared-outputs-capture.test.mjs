/**
 * R24: a task's declared `outputs` is the one capture rule.
 *
 * Rounds 4-19 read a task's deliverables out of its objective and acceptance
 * prose with a write-verb heuristic, and every consumer carried its own patch
 * for what the guess got wrong: an undeclared-deliverable gate
 * (`[deliverable_uncaptured]`, and `[deliverable_gate_unavailable]` when its
 * `git check-ignore` did not answer), an `uncapturedPaths` field and a
 * completion note for it, on-disk spelling for hinted names, a verify-side gate
 * and a recovery step that un-tracked preserved hints. R20 made every planned
 * task declare `outputs`; capture now force-adds exactly the declared outputs
 * plus the `deliverables` a submission lists, and a declared output that was
 * never written is refused with `[output_missing]` while the attempt stays
 * running. A stored row without the field declares nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'
import { assessRefusal, assessText, diagnosticProducers, refusalSites, toolSchemaIndex } from './refusal-inventory.mjs'

const schemaIndex = await toolSchemaIndex()
const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxTasks: 12, maxExperiments: 0, maxDurationMs: 600000 }
const SECRET = 'DATABASE_URL=postgres://user:SECRET@db/prod\n'

/** True when the temp filesystem folds case (macOS default); the spelling test needs that. */
async function caseInsensitiveTemp() {
  const dir = await mkdtemp(path.join(tmpdir(), 'swarm-r24-case-'))
  try {
    await writeFile(path.join(dir, 'probe'), '')
    return await lstat(path.join(dir, 'PROBE')).then(() => true, () => false)
  } finally { await rm(dir, { recursive: true, force: true }) }
}

/** The typed refusal for declared outputs that are not regular files, naming each one and both repairs. */
function outputMissing(error, paths, tool = 'swarm_submit') {
  assert.equal(error.name, 'PolicyError', error.message)
  assert.equal(error.code, 'output_missing')
  assert.equal(error.category, 'validation_error')
  assert.ok(error.message.startsWith('[output_missing] '), error.message)
  for (const name of paths) assert.ok(error.message.includes(JSON.stringify(name)), `${error.message} names ${name}`)
  assert.ok(error.message.includes(`retry \`${tool}\` with the same \`taskId\``), `${error.message}: the first repair is writing the file and retrying ${tool}`)
  assert.match(error.message, /the owner amends `outputs` with `swarm_control`/, 'the second repair is amending the declaration')
  assert.deepEqual(assessText(error.message, schemaIndex), [], `the rendered refusal satisfies the refusal contract: ${error.message}`)
  return true
}

async function repository(root) {
  const source = path.join(root, 'source')
  for (const dir of ['docs', 'notes', 'src']) await mkdir(path.join(source, dir), { recursive: true })
  const run = (cwd, argv) => runProcess(argv, { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 200000 })
  const git = async (cwd, ...args) => {
    const result = await run(cwd, ['git', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', ...args])
    assert.equal(result.exitCode, 0, result.output)
    return result.output.trim()
  }
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
  return { source, run, git, workspaces }
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r24-outputs-')))
  const { source, run, git, workspaces } = await repository(root)
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
  const propose = extra => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Report', objective: 'Inspect the repository', scope: ['docs/', 'notes/'], acceptance: ['Reviewed'], kind: 'research', checks: [], ...extra })
  const readEvidence = async (member, task, file) => {
    const result = await readFile(path.join(member.workspace, file), 'utf8')
    await workers.callbacks.toolRun(member.id, { tool: 'read', arguments: { path: file }, result, isError: false })
    const runs = runtime.observe(actor(member), mission.id, { taskId: task.id }).toolRuns
    return runtime.publish(actor(member), mission.id, { taskId: task.id, attemptId: task.attempt.id, claim: `Read ${file}`, outcome: 'supported', toolRunIds: [runs.at(-1).id] })
  }
  const submit = (member, task, input = {}) => runtime.submit(actor(member), mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Done', ...input })
  const accept = async (task, file) => {
    const review = await runtime.claim(actor(reviewer), mission.id, propose({ kind: 'verification', reviewOf: task.id, scope: ['**'], outputs: [] }).id)
    await readEvidence(reviewer, review, file)
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Read the immutable artifact' })
    return runtime.snapshot(owner, mission.id)
  }
  const taskRow = id => runtime.store.get('tasks', id)
  const artifacts = path.join(root, 'worktrees', mission.id, 'artifacts.git')
  const inCommit = async (commit, file) => (await run(source, ['git', 'cat-file', '-e', `${commit}:${file}`])).exitCode === 0
  const show = (commit, file) => git(artifacts, 'show', `${commit}:${file}`)
  /** Every ref under `prefix` in the mission's durable artifact repository whose tree carries `file`. */
  const refsCarrying = async (file, prefix) => {
    const carrying = []
    for (const line of (await git(artifacts, 'for-each-ref', '--format=%(refname) %(objectname)', prefix)).split('\n').filter(Boolean)) {
      const [ref, sha] = line.split(' ')
      if ((await run(artifacts, ['git', 'cat-file', '-e', `${sha}:${file}`])).exitCode === 0) carrying.push(ref)
    }
    return carrying
  }
  return { root, source, run, git, runtime, workers, workspaces, owner, mission, author, peer, reviewer, actor, propose, readEvidence, submit, accept, taskRow, inCommit, show, refsCarrying }
}

test('a checkpoint capture carries a written declared output past ignore rules and skips one still owed; requireOutputs refuses the owed one', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r24-capture-')))
  const { source, git, workspaces } = await repository(root)
  t.after(async () => { await workspaces.dispose(); await rm(root, { recursive: true, force: true }) })
  const mission = { id: 'capture', workspace: source }
  const member = { id: 'writer', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'writer') }
  const task = { id: 'report', missionId: mission.id, epoch: 1, title: 'Report', kind: 'research', scope: ['docs/', 'notes/'], checks: [], status: 'running',
    objective: 'Audit the scheduler', acceptance: ['Reviewed'], outputs: ['docs/report.md', 'docs/appendix.md'] }
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'docs', 'report.md'), '# Report\n')
  await writeFile(path.join(member.workspace, '.env'), SECRET)
  const checkpoint = await workspaces.captureArtifact(member, task)
  assert.deepEqual(checkpoint.files.map(file => file.path), ['docs/report.md'], 'the written declared output is captured although docs/ ignores it')
  assert.deepEqual(checkpoint.changedPaths, ['docs/report.md'], 'the owed output is skipped and the undeclared .env is never captured')
  await assert.rejects(workspaces.captureArtifact(member, task, [], { requireOutputs: true }), error => {
    outputMissing(error, ['docs/appendix.md'])
    assert.doesNotMatch(error.message, /docs\/report\.md/, 'only the owed output is named')
    return true
  })
  await writeFile(path.join(member.workspace, 'docs', 'appendix.md'), '# Appendix\n')
  const submitted = await workspaces.captureArtifact(member, task, [], { requireOutputs: true })
  assert.deepEqual(submitted.files.map(file => file.path), ['docs/report.md', 'docs/appendix.md'])
  assert.equal(await git(member.workspace, 'show', `${submitted.commit}:docs/appendix.md`), '# Appendix')
  const envCommitted = await runProcess(['git', 'cat-file', '-e', `${submitted.commit}:.env`], { subprocess: subprocessSeam, cwd: member.workspace, timeoutMs: 30000, maxBytes: 1000 })
  assert.notEqual(envCommitted.exitCode, 0, 'the undeclared .env is in neither capture')
})

for (const kind of ['research', 'implementation']) {
  test(`(${kind}) an ignored declared output is captured without being listed in deliverables, and the artifact is accepted`, async t => {
    const f = await fixture(t)
    const extra = kind === 'research' ? {} : { kind, checks: ['test -s docs/report.md'], checkTimeoutMs: 30000 }
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Audit the scheduler', outputs: ['docs/report.md'], ...extra }).id)
    await writeFile(path.join(f.author.workspace, 'docs', 'report.md'), '# Report\n\nfindings\n')
    await f.readEvidence(f.author, task, 'docs/report.md')
    const submitted = await f.submit(f.author, task)
    assert.equal(submitted.status, 'submitted')
    assert.deepEqual(submitted.artifact.files.map(file => file.path), ['docs/report.md'])
    assert.deepEqual(submitted.artifact.changedPaths, ['docs/report.md'])
    const snapshot = await f.accept(task, 'docs/report.md')
    assert.equal(await readFile(path.join(f.reviewer.workspace, 'docs', 'report.md'), 'utf8'), '# Report\n\nfindings\n', 'the reviewer reads the captured report')
    assert.equal(f.taskRow(task.id).status, 'accepted')
    assert.equal(snapshot.completion.eligible, true, snapshot.completion.reason)
  })
}

test('the output_missing refusal is in the refusal inventory and satisfies its contract', async () => {
  const file = 'src/workspaces.ts'
  const sites = refusalSites(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), file)
  const typed = sites.filter(site => site.code === 'output_missing')
  assert.deepEqual(typed.map(site => [site.kind, site.errorClass, site.codes]), [['coded-throw', 'PolicyError', ['output_missing']]], 'one capture-time refusal serves submit and verify')
  assert.deepEqual(assessRefusal(typed[0], { ...schemaIndex, diagnosticProducers: diagnosticProducers([sites]) }), [], typed[0].text)
  const runtimeSites = refusalSites(await readFile(new URL('../src/runtime.ts', import.meta.url), 'utf8'), 'src/runtime.ts')
  assert.deepEqual(runtimeSites.filter(site => site.code === 'deliverable_uncaptured'), [], 'neither submit nor verify keeps the gate on hinted names')
})

for (const kind of ['research', 'implementation']) {
  test(`(${kind}) a declared output never written is refused with output_missing and the attempt stays running; writing it and resubmitting is accepted`, async t => {
    const f = await fixture(t)
    const extra = kind === 'research' ? {} : { kind, checks: ['test -s docs/report.md'], checkTimeoutMs: 30000 }
    const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Audit the scheduler', outputs: ['docs/report.md'], ...extra }).id)
    await writeFile(path.join(f.author.workspace, 'notes', 'scratch.md'), 'working notes\n')
    await f.readEvidence(f.author, task, 'notes/scratch.md')
    for (const deliverables of [undefined, [], ['notes/scratch.md']]) {
      await assert.rejects(f.submit(f.author, task, deliverables === undefined ? {} : { deliverables }), error => outputMissing(error, ['docs/report.md']))
      const current = f.taskRow(task.id)
      assert.equal(current.status, 'running', 'the refusal keeps the attempt running so the member can resubmit')
      assert.equal(current.attempt.id, task.attempt.id)
      assert.equal(current.artifact, undefined)
    }
    assert.ok(!f.runtime.store.events(f.mission.id, 200).some(event => event.type === 'task/submitted'), 'no submission is recorded while the declared output is missing')
    assert.deepEqual(await f.refsCarrying('notes/scratch.md', 'refs/artifacts/'), [], 'a refused submission publishes no artifact ref')
    await writeFile(path.join(f.author.workspace, 'docs', 'report.md'), '# Report\n')
    const submitted = await f.submit(f.author, task)
    assert.equal(submitted.status, 'submitted')
    assert.deepEqual(submitted.artifact.files.map(file => file.path), ['docs/report.md'])
    assert.deepEqual([...submitted.artifact.changedPaths].sort(), ['docs/report.md', 'notes/scratch.md'])
    const snapshot = await f.accept(task, 'docs/report.md')
    assert.equal(f.taskRow(task.id).status, 'accepted', 'an accepted artifact carries every declared output')
    assert.equal(snapshot.completion.eligible, true, snapshot.completion.reason)
  })
}

test('a declared review output is captured in reviewArtifact.files without being listed, and one never written is refused with the review attempt live', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Audit the scheduler', outputs: ['docs/report.md'] }).id)
  await writeFile(path.join(f.author.workspace, 'docs', 'report.md'), '# Report\n')
  await f.readEvidence(f.author, task, 'docs/report.md')
  assert.equal((await f.submit(f.author, task)).status, 'submitted')
  const review = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, f.propose({ kind: 'verification', reviewOf: task.id, scope: ['**'], objective: 'Review the report', outputs: ['docs/review.md'] }).id)
  await writeFile(path.join(f.reviewer.workspace, 'docs', 'other.md'), 'other notes\n')
  await f.readEvidence(f.reviewer, review, 'docs/report.md')
  const verify = deliverables => f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Read the immutable artifact', ...(deliverables === undefined ? {} : { deliverables }) })
  for (const deliverables of [undefined, ['docs/other.md']]) {
    await assert.rejects(verify(deliverables), error => {
      outputMissing(error, ['docs/review.md'], 'swarm_verify')
      assert.doesNotMatch(error.message, /docs\/other\.md/, 'a listed deliverable that exists is not an omission')
      return true
    })
    assert.equal(f.taskRow(review.id).status, 'running', 'the refusal keeps the review attempt live')
    assert.equal(f.taskRow(review.id).attempt.id, review.attempt.id)
    assert.equal(f.taskRow(review.id).reviewArtifact, undefined)
    assert.equal(f.taskRow(task.id).status, 'submitted', 'no verdict was recorded')
  }
  await writeFile(path.join(f.reviewer.workspace, 'docs', 'review.md'), 'looks fine\n')
  const verified = await verify(['docs/other.md'])
  assert.equal(verified.status, 'accepted')
  assert.deepEqual(verified.reviewArtifact.files.map(file => file.path), ['docs/other.md', 'docs/review.md'])
  assert.equal(await f.show(verified.reviewArtifact.commit, 'docs/review.md'), 'looks fine')
  assert.equal(f.taskRow(task.id).status, 'accepted')
})

test('an undeclared ignored file is never captured, even a member-created .env the objective names', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Update notes/config.md to read DATABASE_URL from .env', scope: ['**'], outputs: ['notes/config.md'] }).id)
  await writeFile(path.join(f.author.workspace, 'notes', 'config.md'), 'DATABASE_URL comes from .env\n')
  await writeFile(path.join(f.author.workspace, '.env'), SECRET)
  await f.readEvidence(f.author, task, 'notes/config.md')
  const submitted = await f.submit(f.author, task)
  assert.equal(submitted.status, 'submitted', 'an undeclared ignored file is not an obligation and not a refusal')
  assert.deepEqual(submitted.artifact.changedPaths, ['notes/config.md'])
  assert.deepEqual(submitted.artifact.files.map(file => file.path), ['notes/config.md'])
  assert.equal(await f.inCommit(submitted.artifact.commit, '.env'), false, 'the secret never entered the immutable artifact')
  assert.deepEqual(await f.refsCarrying('.env', 'refs/'), [], 'no durable ref carries the secret')
  assert.equal(await readFile(path.join(f.author.workspace, '.env'), 'utf8'), SECRET, 'the member file stays on disk untouched')
})

test('an undeclared report in a tracked directory is still captured by the whole-tree add', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Write notes/report.md', outputs: [] }).id)
  await writeFile(path.join(f.author.workspace, 'notes', 'report.md'), 'A useful finding\n')
  await f.readEvidence(f.author, task, 'notes/report.md')
  const submitted = await f.submit(f.author, task)
  assert.deepEqual(submitted.artifact.changedPaths, ['notes/report.md'])
  assert.equal(submitted.artifact.files, undefined, 'nothing was declared, so nothing is listed as a file output')
})

test('a declared output written under a different case is captured under its on-disk spelling', { skip: (await caseInsensitiveTemp()) ? false : 'the temp filesystem is case-sensitive' }, async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Audit the scheduler', outputs: ['docs/Report.md'] }).id)
  await writeFile(path.join(f.author.workspace, 'docs', 'report.md'), '# Report\n')
  await f.readEvidence(f.author, task, 'docs/report.md')
  const submitted = await f.submit(f.author, task)
  assert.equal(submitted.status, 'submitted')
  assert.deepEqual(submitted.artifact.files.map(file => file.path), ['docs/report.md'], 'the file is recorded under the spelling git stores')
  assert.equal(await f.inCommit(submitted.artifact.commit, 'docs/report.md'), true)
})

test('a deliverable inside an ignored dependency directory or the member scratch root is refused as a path, never force-captured', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Write notes/summary.md', scope: ['**'], outputs: ['notes/summary.md'] }).id)
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
  const submitted = await f.submit(f.author, task)
  assert.equal(submitted.status, 'submitted')
  assert.deepEqual(submitted.artifact.changedPaths, ['notes/summary.md'])
  for (const name of ['node_modules/foo/README.md', '.swarm-scratch/report.md']) assert.equal(await f.inCommit(submitted.artifact.commit, name), false)
})

test('analysis-only research that declares outputs [] completes on evidence alone', async t => {
  const f = await fixture(t)
  const task = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ objective: 'Inspect the repository and report findings as evidence', outputs: [] }).id)
  await f.readEvidence(f.author, task, 'README.md')
  const submitted = await f.submit(f.author, task)
  assert.deepEqual(submitted.artifact.changedPaths, [])
  assert.equal(submitted.artifact.commit, submitted.artifact.baseCommit)
  assert.equal(submitted.artifact.files, undefined)
  const snapshot = await f.accept(task, 'README.md')
  assert.equal(f.taskRow(task.id).status, 'accepted')
  assert.equal(snapshot.completion.eligible, true, snapshot.completion.reason)
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'Evidence reviewed').status, 'completed')
})
