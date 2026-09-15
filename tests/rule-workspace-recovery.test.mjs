/** Rule audit: exact-artifact recovery, conflict delivery, and abandoned WIP preservation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { SwarmRuntime } from '../lib/runtime.js'
import { subprocessSeam } from './subprocess-seam.mjs'
const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}
async function workspaceFixture(t, options = {}) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-workspaces-')))
  const source = path.join(temp, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  await mkdir(path.join(source, 'src'))
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await writeFile(path.join(source, 'outside.txt'), 'original\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const head = await git(source, 'rev-parse', 'HEAD')
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv, ...options })
  const mission = { id: 'mission-one', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Implement answer', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, head, workspaces, mission, member, task }
}

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
async function eventually(read, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

class GitWorkers {
  prepared = []; stopped = []; deliveries = []; verifyCount = 0
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  artifact = { commit: 'e'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, delivery }) }
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle() { return false }
  async prepareTask(member, task) { this.prepared.push(structuredClone({ member: member.id, task })) }
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { this.verifyCount++; return this.checks }
  async dispose() {}
}

const deniedCommit = {
  tool: 'bash',
  arguments: { command: 'git commit -m "integrate branches"' },
  result: { isError: true, content: [{ type: 'text', text: "fatal: Unable to create '/repo/.git/worktrees/author/index.lock': Operation not permitted" }] },
  isError: true,
}

async function runtimeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-gitwrite-'))
  const workers = new GitWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 300, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'git-owner' }
  const mission = runtime.create(owner, { title: 'Git write', objective: 'Surface the sandbox boundary', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  return { runtime, workers, owner, mission, author, reviewer, actor, propose, events }
}


async function reviewFixture(t) {
  const f = await runtimeFixture(t)
  const source = await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: source.attempt.id, output: 'ready' })
  const review = f.propose({ title: 'Review', kind: 'verification', reviewOf: source.id, assigneeId: f.reviewer.id })
  const claim = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  return { ...f, source, review, claim, verify: () => f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claim.attempt.id, verdict: 'accept', reason: 'independent check' }) }
}

test('R13: repeated timeouts preserve the submitted source and both real runs for same-task recovery', async t => {
  const f = await reviewFixture(t)
  f.workers.checks = [{ command: 'test', exitCode: 124, failureKind: 'timeout', output: 'host deadline elapsed' }]
  const result = await f.verify()
  assert.equal(result.status, 'blocked')
  assert.equal(f.workers.verifyCount, 2)
  assert.equal(f.runtime.store.get('tasks', f.source.id).status, 'submitted')
  assert.equal(result.verificationRecovery.commit, f.workers.artifact.commit)
  assert.equal(result.verificationRecovery.sourceTaskId, f.source.id)
  assert.match(result.output, /swarm_control/)
  assert.equal(f.events('task/rejected').length, 0)
  assert.equal(f.events('task/accepted').length, 0)
  const runs = f.runtime.store.list('tool_runs', f.mission.id).filter(row => row.tool === 'swarm.host_verification')
  assert.deepEqual(runs.map(run => run.arguments.attempt), [1, 2])
  assert.ok(runs.every(run => run.arguments.commit === f.workers.artifact.commit && run.isError))
  f.workers.checks = [{ command: 'test', exitCode: 0, output: 'passed after environment repair' }]
  // The real owner recovery API keeps the original review and immutable source.
  await f.runtime.controlTask(f.owner, f.mission.id, result.id, 'resume', {}, 'check environment repaired')
  await eventually(() => f.runtime.store.get('tasks', result.id).status === 'pending', 'owner recovery makes the same review pending')
  const retry = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, result.id)
  const accepted = await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: retry.id, attemptId: retry.attempt.id, verdict: 'accept', reason: 'repaired host check passed' })
  assert.equal(accepted.status, 'accepted')
  assert.equal(f.runtime.store.get('tasks', f.source.id).artifact.commit, f.workers.artifact.commit)
})

test('R13: repeated assertion failures still reject the source instead of becoming infrastructure recovery', async t => {
  const f = await reviewFixture(t)
  f.workers.checks = [{ command: 'test', exitCode: 1, output: 'not ok 1 - expected true' }]
  const result = await f.verify()
  assert.equal(result.status, 'blocked')
  assert.equal(result.verificationRecovery, undefined)
  assert.equal(f.runtime.store.get('tasks', f.source.id).status, 'blocked')
  assert.equal(f.events('task/rejected').length, 1)
})

test('R15: ordinary failed Git writes do not claim a sandbox denial, and EPERM does not disable editing', async t => {
  const f = await runtimeFixture(t)
  await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose().id)
  await f.workers.callbacks.toolRun(f.author.id, { ...deniedCommit, result: { output: 'nothing to commit, working tree clean' } })
  assert.equal(f.events('task/git-write-denied').length, 0)
  await f.workers.callbacks.toolRun(f.author.id, deniedCommit)
  assert.equal(f.events('task/git-write-denied').length, 1)
  for (const tool of ['read', 'edit', 'bash', 'swarm_submit']) assert.equal(f.workers.callbacks.guard(f.author.id, tool), undefined)
})

test('R17: a deterministic preparation fault blocks once with owner recovery and does not consume task credits', async t => {
  const f = await runtimeFixture(t)
  f.workers.isIdle = () => true
  let calls = 0
  f.workers.prepareTask = async () => { calls++; throw new Error('[workspace_uncommitted] preserved conflict requires resolution') }
  const task = f.propose({ assigneeId: f.author.id })
  await f.runtime.schedule(f.mission.id)
  const blocked = f.runtime.store.get('tasks', task.id)
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.preparationFailure.transient, false)
  assert.equal(blocked.recoveryCount ?? 0, 0)
  assert.match(blocked.output, /swarm_control/)
  await f.runtime.schedule(f.mission.id)
  assert.equal(calls, 1)
})

test('R17: a typed transient preparation failure backs off and keeps the task identity', async t => {
  const f = await runtimeFixture(t)
  f.workers.isIdle = () => true
  let calls = 0
  f.workers.prepareTask = async () => { if (++calls < 2) throw Object.assign(new Error('temporarily busy'), { code: 'EBUSY' }) }
  const task = f.propose({ assigneeId: f.author.id })
  await f.runtime.schedule(f.mission.id)
  const pending = f.runtime.store.get('tasks', task.id)
  assert.equal(pending.status, 'pending')
  assert.ok(pending.preparationFailure.retryAt > Date.now())
  await f.runtime.schedule(f.mission.id)
  assert.equal(calls, 1)
  pending.preparationFailure.retryAt = Date.now() - 1
  f.runtime.store.put('tasks', pending)
  await f.runtime.schedule(f.mission.id)
  assert.equal(f.runtime.store.get('tasks', task.id).status, 'running')
  assert.equal(calls, 2)
})

test('R18: switching abandoned tasks preserves dirty out-of-scope WIP without accepting or leaking it', async t => {
  const f = await workspaceFixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await writeFile(path.join(f.member.workspace, 'src/answer.txt'), 'unfinished answer\n')
  await writeFile(path.join(f.member.workspace, 'outside.txt'), 'out of scope but must survive\n')
  await writeFile(path.join(f.member.workspace, 'draft.txt'), 'untracked work\n')
  await f.workspaces.prepareTask(f.member, { ...f.task, id: 'new-task' }, [])
  assert.equal(await readFile(path.join(f.member.workspace, 'outside.txt'), 'utf8'), 'original\n')
  assert.equal(await git(f.member.workspace, 'status', '--porcelain'), '')
  const previous = JSON.parse(await readFile(path.join(f.temp, 'worktrees', f.mission.id, 'tasks', `${f.task.id}.json`), 'utf8'))
  assert.ok(previous.task.preservedCommit)
  const commit = previous.task.preservedCommit
  assert.equal(await git(f.member.workspace, 'show', `${commit}:outside.txt`), 'out of scope but must survive')
  assert.equal(await git(f.member.workspace, 'show', `${commit}:draft.txt`), 'untracked work')
  assert.equal(await git(path.join(f.temp, 'worktrees', f.mission.id, 'artifacts.git'), 'for-each-ref', '--format=%(refname)', `refs/artifacts/${f.task.id}`), '')
  const peer = { id: 'recovering', missionId: f.mission.id, workspace: await f.workspaces.prepareWorkspace(f.mission, 'recovering') }
  await f.workspaces.prepareTask(peer, { ...f.task, epoch: 2 }, [])
  assert.equal(await readFile(path.join(peer.workspace, 'outside.txt'), 'utf8'), 'out of scope but must survive\n')
  await assert.rejects(f.workspaces.captureArtifact(peer, { ...f.task, epoch: 2 }), /outside task scope/)
})

test('R18: stop checkpoint preserves dirty WIP while leaving the live checkout and index untouched', async t => {
  const f = await workspaceFixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await writeFile(path.join(f.member.workspace, 'outside.txt'), 'preserved only\n')
  const status = await git(f.member.workspace, 'status', '--porcelain')
  const head = await git(f.member.workspace, 'rev-parse', 'HEAD')
  await f.workspaces.checkpointTask(f.member, { ...f.task, epoch: 2 })
  assert.equal(await git(f.member.workspace, 'status', '--porcelain'), status)
  assert.equal(await git(f.member.workspace, 'rev-parse', 'HEAD'), head)
})

test('R14: integration gets recorded conflict files, resolves without Git writes, and retains every dependency', async t => {
  const f = await workspaceFixture(t)
  const deps = []
  for (let i = 0; i < 3; i++) {
    const member = { id: `writer-${i}`, missionId: f.mission.id, workspace: await f.workspaces.prepareWorkspace(f.mission, `writer-${i}`) }
    const task = { ...f.task, id: `dependency-${i}` }
    await f.workspaces.prepareTask(member, task, [])
    await writeFile(path.join(member.workspace, 'src/answer.txt'), `answer ${i}\n`)
    deps.push({ ...task, status: 'accepted', artifact: await f.workspaces.captureArtifact(member, task) })
  }
  const task = { ...f.task, id: 'integration', kind: 'integration' }
  await f.workspaces.prepareTask(f.member, task, deps)
  const manifest = path.join(f.member.workspace, '.swarm-integration-conflicts.json')
  assert.equal(JSON.parse(await readFile(manifest, 'utf8')).conflicts.length, 2)
  assert.equal(await git(f.member.workspace, 'ls-files', '-u'), '', 'worker does not need to repair Git index metadata')
  await assert.rejects(f.workspaces.captureArtifact(f.member, task), /recorded dependency conflicts/)
  await rm(manifest)
  await assert.rejects(f.workspaces.captureArtifact(f.member, task), /conflict markers/)
  await writeFile(path.join(f.member.workspace, 'src/answer.txt'), 'integrated answer\n=======\n')
  const artifact = await f.workspaces.captureArtifact(f.member, task)
  for (const dep of deps) await git(f.member.workspace, 'merge-base', '--is-ancestor', dep.artifact.commit, artifact.commit)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'])
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), f.head)
})

test('R22: a divergent actual supporting host-check environment still refuses acceptance and retains its execution', async t => {
  const f = await reviewFixture(t)
  const environment = { home: '/stable', userCacheDir: '/stable/.cache', huggingfaceCacheDir: '/stable/.cache/huggingface',
    userCacheDirExists: false, huggingfaceCacheDirExists: false, xdgCacheHome: '/check/.cache',
    sandboxPolicy: { mode: 'workspace-write', enforcement: 'full', workspaceRoot: '/check' },
    dependencyLinks: { mode: 'copy', dirs: [] }, checkCacheRoot: '/check/.cache', checkCacheRoots: {} }
  f.workers.checkEnvelope = () => ({ environment, selfRunEnvironment: environment })
  f.workers.checks = [{ command: 'test', exitCode: 0, output: 'ok', environment },
    { command: 'second-check', exitCode: 0, output: 'ok', environment: { ...environment, home: '/different' } }]
  await assert.rejects(f.verify(), error => error.code === 'check_environment_mismatch')
  assert.equal(f.runtime.store.get('tasks', f.source.id).status, 'submitted')
  const rows = f.runtime.store.list('tool_runs', f.mission.id).filter(run => run.tool === 'swarm.host_verification')
  assert.equal(rows.length, 2)
  assert.equal(rows[1].result.environment.home, '/different')
})

test('R07/R18: dependency amendment keeps original task WIP and isolates added dependency content from task scope', async t => {
  const f = await workspaceFixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await writeFile(path.join(f.member.workspace, 'src/answer.txt'), 'unfinished scoped answer\n')
  const peer = { id: 'new-dependency-author', missionId: f.mission.id, workspace: await f.workspaces.prepareWorkspace(f.mission, 'new-dependency-author') }
  const dependency = { ...f.task, id: 'new-dependency', scope: ['outside.txt'] }
  await f.workspaces.prepareTask(peer, dependency, [])
  await writeFile(path.join(peer.workspace, 'outside.txt'), 'new accepted prerequisite\n')
  const accepted = { ...dependency, status: 'accepted', artifact: await f.workspaces.captureArtifact(peer, dependency) }
  const amended = { ...f.task, epoch: 2 }
  await f.workspaces.prepareTask(f.member, amended, [accepted])
  assert.equal(await readFile(path.join(f.member.workspace, 'src/answer.txt'), 'utf8'), 'unfinished scoped answer\n')
  assert.equal(await readFile(path.join(f.member.workspace, 'outside.txt'), 'utf8'), 'new accepted prerequisite\n')
  const artifact = await f.workspaces.captureArtifact(f.member, amended)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'])
  await git(f.member.workspace, 'merge-base', '--is-ancestor', accepted.artifact.commit, artifact.commit)
  // Removing that execution dependency also transplants only this task's WIP.
  await f.workspaces.prepareTask(f.member, { ...amended, epoch: 3 }, [])
  assert.equal(await readFile(path.join(f.member.workspace, 'src/answer.txt'), 'utf8'), 'unfinished scoped answer\n')
  assert.equal(await readFile(path.join(f.member.workspace, 'outside.txt'), 'utf8'), 'original\n')
})

test('R07/R17: conflicting ordinary dependency amendment preserves WIP and can resume after correcting the condition', async t => {
  const f = await workspaceFixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await writeFile(path.join(f.member.workspace, 'src/answer.txt'), 'original WIP\n')
  const peer = { id: 'conflicting-author', missionId: f.mission.id, workspace: await f.workspaces.prepareWorkspace(f.mission, 'conflicting-author') }
  const dependency = { ...f.task, id: 'conflicting-dependency' }
  await f.workspaces.prepareTask(peer, dependency, [])
  await writeFile(path.join(peer.workspace, 'src/answer.txt'), 'different accepted choice\n')
  const accepted = { ...dependency, status: 'accepted', artifact: await f.workspaces.captureArtifact(peer, dependency) }
  await assert.rejects(f.workspaces.prepareTask(f.member, { ...f.task, epoch: 2 }, [accepted]), /Preserved WIP conflicts/)
  assert.equal(await readFile(path.join(f.member.workspace, 'src/answer.txt'), 'utf8'), 'original WIP\n')
  await f.workspaces.prepareTask(f.member, { ...f.task, epoch: 3 }, [])
  const recovered = await f.workspaces.captureArtifact(f.member, { ...f.task, epoch: 3 })
  assert.equal(await git(f.member.workspace, 'show', `${recovered.commit}:src/answer.txt`), 'original WIP')
})

test('integration WIP replay records conflicts while retaining its amended dependency baseline', async t => {
  const f = await workspaceFixture(t)
  const task = { ...f.task, kind: 'integration' }
  await f.workspaces.prepareTask(f.member, task, [])
  await writeFile(path.join(f.member.workspace, 'src/answer.txt'), 'preserved integration WIP\n')
  const peer = { id: 'replay-author', missionId: f.mission.id, workspace: await f.workspaces.prepareWorkspace(f.mission, 'replay-author') }
  const dependency = { ...f.task, id: 'replay-dependency', scope: ['src/', 'outside.txt'] }
  await f.workspaces.prepareTask(peer, dependency, [])
  await writeFile(path.join(peer.workspace, 'src/answer.txt'), 'accepted dependency choice\n')
  await writeFile(path.join(peer.workspace, 'outside.txt'), 'accepted dependency context\n')
  const accepted = { ...dependency, status: 'accepted', artifact: await f.workspaces.captureArtifact(peer, dependency) }
  const amended = { ...task, epoch: 2 }
  await f.workspaces.prepareTask(f.member, amended, [accepted])
  const manifest = path.join(f.member.workspace, '.swarm-integration-conflicts.json')
  const recorded = JSON.parse(await readFile(manifest, 'utf8'))
  assert.deepEqual(recorded.dependencyCommits, [accepted.artifact.commit])
  assert.equal(recorded.conflicts[0].dependencyId, task.id)
  assert.deepEqual(recorded.conflicts[0].paths, ['src/answer.txt'])
  assert.equal(await git(f.member.workspace, 'ls-files', '-u'), '')
  await assert.rejects(f.workspaces.captureArtifact(f.member, amended), /recorded dependency conflicts/)
  await writeFile(path.join(f.member.workspace, 'src/answer.txt'), 'resolved integration WIP\n')
  await rm(manifest)
  const artifact = await f.workspaces.captureArtifact(f.member, amended)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'], 'accepted dependency context stays outside the task delta')
  await git(f.member.workspace, 'merge-base', '--is-ancestor', accepted.artifact.commit, artifact.commit)
  assert.equal(await git(f.source, 'rev-parse', 'HEAD'), f.head)
})

test('R13: host preparation infrastructure failures are recorded without pretending the declared command executed', async t => {
  const f = await reviewFixture(t)
  f.workers.verifyArtifact = async () => { throw Object.assign(new Error('verification checkout temporarily unavailable'), { code: 'EACCES' }) }
  const deferred = await f.verify()
  assert.equal(deferred.status, 'blocked')
  assert.equal(f.runtime.store.get('tasks', f.source.id).status, 'submitted')
  const rows = f.runtime.store.list('tool_runs', f.mission.id).filter(run => run.tool === 'swarm.host_verification')
  assert.equal(rows.length, 2)
  assert.ok(rows.every(run => run.result.command === '(verification preparation)' && run.isError))
  assert.equal(f.events('task/accepted').length, 0)
})

test('declared checks cannot be accepted from an empty host result even with unrelated successful evidence', async t => {
  const f = await reviewFixture(t)
  await f.workers.callbacks.toolRun(f.reviewer.id, { tool: 'read', arguments: { path: 'src/a.ts' }, result: 'inspection only', isError: false })
  f.workers.checks = []
  await assert.rejects(f.verify(), /Declared host checks returned no execution evidence/)
  assert.equal(f.runtime.store.get('tasks', f.source.id).status, 'submitted')
})

test('overlapping preparation of one member and epoch reuses its workspace after the first preparation settles', async t => {
  const f = await workspaceFixture(t)
  await Promise.all(Array.from({ length: 4 }, () => f.workspaces.prepareTask(f.member, f.task, [])))
  assert.equal(f.workspaces.preparations.size, 0, 'all in-flight gates are released')
  await writeFile(path.join(f.member.workspace, 'src/answer.txt'), 'work after preparation\n')
  const artifact = await f.workspaces.captureArtifact(f.member, f.task)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'])
})

test('queued preparation is aborted before workspace I/O when the member stops', async t => {
  const f = await workspaceFixture(t)
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.workspaces.preparations.set(f.member.id, gate)
  const preparing = f.workspaces.prepareTask(f.member, f.task, [])
  f.workspaces.cancel(f.member.id)
  release()
  await assert.rejects(preparing)
  assert.equal(f.workspaces.preparations.size, 0)
  await assert.rejects(readFile(path.join(f.temp, 'worktrees', f.mission.id, 'tasks', `${f.task.id}.json`)), error => error.code === 'ENOENT')
})

test('optional ownership checkpoint skips unprepared and unrelated task workspaces while normal mismatch rejects', async t => {
  const f = await workspaceFixture(t)
  await f.workspaces.checkpointTask(f.member, f.task, { ifOwned: true })
  const unrelated = { ...f.task, id: 'unrelated-task' }
  await f.workspaces.prepareTask(f.member, unrelated, [])
  await writeFile(path.join(f.member.workspace, 'src/answer.txt'), 'unrelated WIP\n')
  await assert.rejects(f.workspaces.checkpointTask(f.member, f.task), /owned by another task/)
  await f.workspaces.checkpointTask(f.member, f.task, { ifOwned: true })
  const record = JSON.parse(await readFile(path.join(f.temp, 'worktrees', f.mission.id, `${f.member.id}.workspace.json`), 'utf8'))
  assert.equal(record.task.taskId, unrelated.id)
  assert.equal(record.task.preservedCommit, undefined, 'an unrelated workspace is not captured by the scan')
  assert.equal(await readFile(path.join(f.member.workspace, 'src/answer.txt'), 'utf8'), 'unrelated WIP\n')
})

test('optional ownership checkpoint does not suppress workspace metadata I/O failure', async t => {
  const f = await workspaceFixture(t)
  const metadata = path.join(f.temp, 'worktrees', f.mission.id, `${f.member.id}.workspace.json`)
  await rm(metadata)
  await mkdir(metadata)
  await assert.rejects(f.workspaces.checkpointTask(f.member, f.task, { ifOwned: true }), error => error.code === 'EISDIR')
})

test('optional ownership checkpoint still rejects stale task epoch metadata', async t => {
  const f = await workspaceFixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await writeFile(path.join(f.member.workspace, 'src/answer.txt'), 'preserved WIP\n')
  const taskPath = path.join(f.temp, 'worktrees', f.mission.id, 'tasks', `${f.task.id}.json`)
  const newer = JSON.parse(await readFile(taskPath, 'utf8'))
  newer.task.epoch++
  await writeFile(taskPath, JSON.stringify(newer))
  await assert.rejects(f.workspaces.checkpointTask(f.member, f.task, { ifOwned: true }), /ownership changed while preserving WIP/)
  assert.equal(JSON.parse(await readFile(taskPath, 'utf8')).task.epoch, newer.task.epoch)
  assert.equal(await readFile(path.join(f.member.workspace, 'src/answer.txt'), 'utf8'), 'preserved WIP\n')
})
