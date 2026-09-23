/** Round 12 recovery and workspace regressions. No model/provider calls. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { subprocessSeam } from './subprocess-seam.mjs'

// Source mode permits parallel development without rebuilding shared lib/.
const sourceMode = process.env.SWARM_TEST_SOURCE === '1'
const moduleOf = name => import(new URL(`../${sourceMode ? 'src' : 'lib'}/${name}.${sourceMode ? 'ts' : 'js'}`, import.meta.url))
const { Scheduling } = await moduleOf('scheduling')
const { Workspaces, runProcess } = await moduleOf('workspaces')
const { WorkspaceAdmission, isolationIssues } = await moduleOf('workspace-admission')
const { SwarmStore } = await moduleOf('store')
const { captureGitSnapshot } = await moduleOf('git-snapshot')
const git = (cwd, args, env) => execFileSync('git', ['-c', 'user.name=R12 Test', '-c', 'user.email=r12@example.invalid', ...args], {
  cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
}).trim()

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r12-workspaces-')))
  const source = path.join(root, 'source')
  await mkdir(source)
  git(source, ['init', '-b', 'main'])
  await writeFile(path.join(source, 'answer.txt'), 'base\n')
  await writeFile(path.join(source, '.gitignore'), 'node_modules\nignored.txt\n')
  git(source, ['add', '.']); git(source, ['commit', '-m', 'baseline'])
  const baseline = git(source, ['rev-parse', 'HEAD'])
  const options = { subprocess: subprocessSeam, workspacesRoot: path.join(root, 'workspaces'), checkTimeoutMs: 10000, maxCheckOutputBytes: 32000, confineCheck: argv => argv }
  const workspaces = new Workspaces(options)
  const mission = { id: 'mission', workspace: source }
  const member = { id: 'member', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member') }
  const task = { id: 'task', missionId: mission.id, epoch: 1, title: 'Implement answer', objective: 'Implement answer', kind: 'implementation', scope: ['answer.txt'], checks: [], dependencies: [], acceptance: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, source, baseline, options, workspaces, mission, member, task }
}

test('M2-1: no-progress and pass-timeout each record once on the same board', () => {
  const mission = { id: 'mission', status: 'active' }, records = []
  const rt = { store: { get: () => structuredClone(mission), list: () => [], put: (_table, row) => Object.assign(mission, row), event: (_m, _t, _a, data) => records.push(data) },
    isMissionTerminal: () => false, commit: (_id, fn) => fn(), expectWedgedRelease() {}, notify() {}, pumpOutbox() {} }
  const scheduling = new Scheduling(rt)
  const info = { pass: { id: 'pass', operationId: 'one', startedAt: 0, fingerprintBefore: 'same', revisionBefore: 0, noProgressPasses: 3 }, unschedulable: [], reason: 'no-progress', boundMs: 1000, revisionNow: 0, fingerprintNow: 'same' }
  for (const reason of ['no-progress', 'pass-timeout', 'no-progress', 'pass-timeout']) scheduling.escalateSchedulingStall('mission', { ...info, reason })
  assert.deepEqual(records.map(row => row.wedged), [false, true])
})

test('M2-2: submission grace survives newer unrelated events without aging a new submission', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'swarm-r12-events-'))
  const store = new SwarmStore(path.join(root, 'state.db'), { snapshotIntervalMs: 0 })
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const clock = Date.now
  try {
    Date.now = () => clock() - 10000
    store.transaction(() => store.event('mission', 'task/submitted', 'runtime', { taskId: 'old' }))
  } finally { Date.now = clock }
  store.transaction(() => { for (let index = 0; index < 5; index++) store.event('mission', 'message/sent', 'runtime', { index }) })
  const scheduling = new Scheduling({ store, config: { tickMs: 100, maxEvents: 1 } })
  assert.equal(scheduling.unreviewedStall('mission', [{ id: 'old' }]), true)
  store.transaction(() => store.event('mission', 'task/submitted', 'runtime', { taskId: 'new' }))
  assert.equal(scheduling.unreviewedStall('mission', [{ id: 'new' }]), false)
})

test('M2-3: dispatch explanations name dependencies/isolation without inventing budget refusals', () => {
  const rt = { workers: { isIdle: () => true }, scopesOverlap: () => true }
  const scheduling = new Scheduling(rt); scheduling.ready = () => true
  const member = { id: 'one', name: 'One', phase: 'ready', status: 'idle', workspace: '/one' }
  const task = { id: 't', title: 'Work', epoch: 0, objective: 'The assembly is already in its worktree; verify the integration.', acceptance: [], dependencies: [], scope: ['**'] }
  const assumed = scheduling.dispatchQuestion('m', [task], [member], [task])
  assert.match(assumed.message, /dependency assumptions require repair/)
  const independent = { ...task, objective: 'Write a new file from the baseline.' }
  const isolated = scheduling.dispatchQuestion('m', [independent], [{ ...member, workspace: '' }], [independent])
  assert.match(isolated.message, /Workspace isolation prevents dispatch/)
  const unknown = scheduling.dispatchQuestion('m', [independent], [member], [independent])
  assert.match(unknown.message, /idle handle alone does not identify the dispatch blocker/)
})

test('stop recovery owns its member until quiescence, including before native startup', async () => {
  const member = { id: 'old-owner', name: 'Old owner', phase: 'active', status: 'idle', workspace: '/owned' }
  const stopping = { id: 'old-task', status: 'blocked', epoch: 3, resumeAfterStop: { epoch: 3, memberId: member.id } }
  const ready = { id: 'new-task', title: 'New task', epoch: 0, status: 'pending', dependencies: [], acceptance: [], scope: ['**'], objective: 'New work' }
  let starts = 0
  const rt = { store: { list: () => [stopping, ready] }, interpretation: () => ({ members: [member], tasks: [stopping, ready] }), mission: () => ({ status: 'active' }), startWorker: async () => { starts++ }, workers: { isIdle: () => true } }
  const scheduling = new Scheduling(rt); scheduling.ready = () => true
  assert.equal(await scheduling.dispatch({ status: 'active' }, 'm'), true)
  assert.equal(starts, 0)
  assert.equal(scheduling.dispatchQuestion('m', [stopping, ready], [member], [ready]), undefined)
})

test('M2-4: a pruned source artifact is fetched from the mission repo before dependency preparation', async t => {
  const f = await fixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await writeFile(path.join(f.member.workspace, 'answer.txt'), 'artifact\n')
  const artifact = await f.workspaces.captureArtifact(f.member, f.task)
  await f.workspaces.prepareTask(f.member, { ...f.task, id: 'next' }, [])
  git(f.source, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'])
  git(f.source, ['gc', '--prune=now'])
  assert.throws(() => git(f.source, ['cat-file', '-e', `${artifact.commit}^{commit}`]))
  git(path.join(f.options.workspacesRoot, f.mission.id, 'artifacts.git'), ['cat-file', '-e', `${artifact.commit}^{commit}`])
  await f.workspaces.prepareTask(f.member, { ...f.task, id: 'integrate' }, [{ ...f.task, status: 'accepted', artifact }])
  assert.equal(await readFile(path.join(f.member.workspace, 'answer.txt'), 'utf8'), 'artifact\n')
  assert.equal(git(f.source, ['for-each-ref', '--format=%(refname)', 'refs/swarm/']), '')
  await assert.rejects(readFile(path.join(f.source, '.git', 'FETCH_HEAD')), { code: 'ENOENT' })
})

test('M2-5/6: shell stages and repeated names are counted, but the spec footer is not', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'swarm-r12-attribution-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const text = '$ command\n✖ duplicate (1ms)\n✖ duplicate (2ms)\nℹ fail 2\n✖ failing tests:\n✖ duplicate (1ms)\n✖ duplicate (2ms)\n'
  const output = await runProcess([process.execPath, '-e', `process.stdout.write(${JSON.stringify(text)})`], { cwd: root, timeoutMs: 3000, maxBytes: 4096, captureAttribution: true, subprocess: subprocessSeam })
  assert.equal(output.attribution.stage, 'command')
  assert.equal(output.attribution.failingTestCount, 2)
  assert.deepEqual(output.attribution.failingTests, ['duplicate', 'duplicate'])
})

test('M2-7: interrupted workspace creation adopts only the same clean repository baseline', async t => {
  const f = await fixture(t)
  const workspace = path.join(f.options.workspacesRoot, f.mission.id, 'members', 'interrupted')
  git(f.source, ['worktree', 'add', '--detach', workspace, f.baseline])
  assert.equal(await f.workspaces.prepareWorkspace(f.mission, 'interrupted'), workspace)
  const dirty = path.join(f.options.workspacesRoot, f.mission.id, 'members', 'dirty')
  git(f.source, ['worktree', 'add', '--detach', dirty, f.baseline]); await writeFile(path.join(dirty, 'answer.txt'), 'user work\n')
  await assert.rejects(f.workspaces.prepareWorkspace(f.mission, 'dirty'), /workspace_recovery_requires_inspection/)
  assert.equal(await readFile(path.join(dirty, 'answer.txt'), 'utf8'), 'user work\n')
  const branch = path.join(f.options.workspacesRoot, f.mission.id, 'members', 'branched')
  git(f.source, ['worktree', 'add', '-b', 'user-branch', branch, f.baseline])
  await assert.rejects(f.workspaces.prepareWorkspace(f.mission, 'branched'), /workspace_recovery_requires_inspection/)
  assert.equal(git(branch, ['branch', '--show-current']), 'user-branch')
})

test('M2-8: corrupt artifact marker is repaired after validation with refs and damaged marker preserved', async t => {
  const f = await fixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await writeFile(path.join(f.member.workspace, 'answer.txt'), 'artifact\n')
  const artifact = await f.workspaces.captureArtifact(f.member, f.task)
  const repo = path.join(f.options.workspacesRoot, f.mission.id, 'artifacts.git')
  await writeFile(path.join(repo, 'swarm-artifacts.json'), '{"version":')
  const restarted = new Workspaces(f.options); t.after(() => restarted.dispose())
  await restarted.prepareWorkspace(f.mission, 'restored')
  assert.equal(git(repo, ['rev-parse', 'refs/artifacts/task/1']), artifact.commit)
  assert.deepEqual(JSON.parse(await readFile(path.join(repo, 'swarm-artifacts.json'), 'utf8')), { version: 1, missionId: f.mission.id })
  assert.equal((await readdir(repo)).filter(name => name.startsWith('swarm-artifacts.json.corrupt-')).length, 1)
})

test('artifact recovery disconnects a legacy alternate only after all referenced objects are local', async t => {
  const f = await fixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await writeFile(path.join(f.member.workspace, 'answer.txt'), 'artifact\n')
  const artifact = await f.workspaces.captureArtifact(f.member, f.task)
  const repo = path.join(f.options.workspacesRoot, f.mission.id, 'artifacts.git')
  await rename(repo, `${repo}.original`)
  git(f.source, ['clone', '--bare', '--shared', f.source, repo])
  git(repo, ['update-ref', 'refs/artifacts/task/1', artifact.commit])
  await writeFile(path.join(repo, 'swarm-artifacts.json'), JSON.stringify({ version: 1, missionId: f.mission.id }))
  const restarted = new Workspaces(f.options); t.after(() => restarted.dispose())
  await restarted.prepareWorkspace(f.mission, 'restored')
  await assert.rejects(readFile(path.join(repo, 'objects', 'info', 'alternates')), { code: 'ENOENT' })
  assert.equal(git(repo, ['rev-parse', 'refs/artifacts/task/1']), artifact.commit)
  await f.workspaces.prepareTask(f.member, { ...f.task, id: 'next' }, [])
  git(f.source, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'])
  git(f.source, ['gc', '--prune=now'])
  assert.throws(() => git(f.source, ['cat-file', '-e', `${artifact.commit}^{commit}`]))
  assert.equal(git(repo, ['show', `${artifact.commit}:answer.txt`]), 'artifact')
})

test('M2-9: symlinked dependency roots are copied and internal absolute links are relocated', async t => {
  const f = await fixture(t)
  const dependency = path.join(f.root, 'installed-dependencies'); await mkdir(dependency)
  await mkdir(path.join(dependency, 'pkg')); await writeFile(path.join(dependency, 'pkg', 'index.js'), 'package\n')
  await symlink(path.join(dependency, 'pkg'), path.join(dependency, 'alias'))
  await symlink(dependency, path.join(f.source, 'node_modules'))
  const checkout = path.join(f.root, 'checkout'); await mkdir(checkout)
  assert.deepEqual(await f.workspaces.linkDependencyDirs(f.source, checkout, new AbortController().signal), ['node_modules'])
  assert.equal(await readFile(path.join(checkout, 'node_modules', 'alias', 'index.js'), 'utf8'), 'package\n')
  assert.equal(await readlink(path.join(checkout, 'node_modules', 'alias')), 'pkg')
  assert.equal(await realpath(path.join(checkout, 'node_modules')), path.join(checkout, 'node_modules'))
})

test('M2-9: escaping dependency links refuse explicitly without publishing a partial copy', async t => {
  const f = await fixture(t)
  await chmod(path.join(f.source, 'answer.txt'), 0o755)
  await mkdir(path.join(f.source, 'node_modules'))
  await symlink('../answer.txt', path.join(f.source, 'node_modules', 'host-state'))
  const checkout = path.join(f.root, 'checkout'); await mkdir(checkout)
  await assert.rejects(f.workspaces.linkDependencyDirs(f.source, checkout, new AbortController().signal), /dependency_copy_escape/)
  assert.deepEqual(await readdir(checkout), [])
  assert.equal(await readFile(path.join(f.source, 'answer.txt'), 'utf8'), 'base\n')
  await rm(path.join(f.source, 'node_modules'), { recursive: true })
  await symlink(path.join(f.root, 'missing-installation'), path.join(f.source, 'node_modules'))
  await assert.rejects(f.workspaces.linkDependencyDirs(f.source, checkout, new AbortController().signal), /dependency_directory_unavailable/)
})

test('M2-9: copied Python virtualenv materializes its external interpreter and retains its own prefix', async t => {
  let interpreter
  try { interpreter = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 10000 }).trim() }
  catch { t.skip('python3 is unavailable; generic external executable coverage still runs'); return }
  const f = await fixture(t)
  await writeFile(path.join(f.source, '.gitignore'), '.venv/\n')
  execFileSync(interpreter, ['-m', 'venv', '--without-pip', '--symlinks', path.join(f.source, '.venv')], { encoding: 'utf8', timeout: 30000 })
  const checkout = path.join(f.root, 'checkout'); await mkdir(checkout)
  assert.deepEqual(await f.workspaces.linkDependencyDirs(f.source, checkout, new AbortController().signal), ['.venv'])
  const binary = path.join(checkout, '.venv', 'bin', 'python')
  assert.equal((await lstat(binary)).isFile(), true)
  assert.ok((await lstat(binary)).mode & 0o111)
  const prefix = execFileSync(binary, ['-c', 'import sys; print(sys.prefix)'], { encoding: 'utf8', timeout: 10000 }).trim()
  assert.equal(await realpath(prefix), path.join(checkout, '.venv'))
})

test('M2-9: external executables are frozen files; external directory/data and cyclic links stay refused', async t => {
  const f = await fixture(t)
  const external = path.join(f.root, 'external'); await mkdir(external)
  const executable = path.join(external, 'interpreter')
  await writeFile(executable, '#!/bin/sh\nprintf original\n', { mode: 0o755 })
  const dependencies = path.join(f.source, 'node_modules'); await mkdir(dependencies)
  await symlink(executable, path.join(dependencies, 'interpreter'))
  const checkout = path.join(f.root, 'checkout'); await mkdir(checkout)
  await f.workspaces.linkDependencyDirs(f.source, checkout, new AbortController().signal)
  const copy = path.join(checkout, 'node_modules', 'interpreter')
  assert.equal((await lstat(copy)).isFile(), true)
  assert.equal((await lstat(copy)).mode & 0o777, 0o755)
  await writeFile(executable, '#!/bin/sh\nprintf changed\n')
  assert.match(await readFile(copy, 'utf8'), /original/)
  await writeFile(path.join(external, 'data'), 'private data\n')
  for (const [name, target] of [['directory', external], ['data', path.join(external, 'data')], ['cycle', 'cycle'], ['broken', 'missing']]) {
    await rm(path.join(dependencies, 'interpreter'), { force: true })
    await symlink(target, path.join(dependencies, name))
    const rejected = path.join(f.root, `rejected-${name}`); await mkdir(rejected)
    await assert.rejects(f.workspaces.linkDependencyDirs(f.source, rejected, new AbortController().signal), /dependency_copy_escape/)
    assert.deepEqual(await readdir(rejected), [])
    await rm(path.join(dependencies, name))
  }
})

test('M2-10: inline # remains word data, while actual shell comments remain ignored', () => {
  const admission = new WorkspaceAdmission({})
  const classify = command => admission.deniedGitWrite({ tool: 'bash', arguments: { command }, result: 'Operation not permitted', isError: true })
  for (const command of ['echo foo#bar; git add .', 'curl http://h/p#frag && git commit -m x', 'echo foo\\ #bar; git add .', 'echo foo\\\n#bar; git add .']) assert.equal(classify(command), command)
  for (const command of ['echo foo # git add .', 'echo "# git add ."', '# git add .']) assert.equal(classify(command), undefined)
})

test('M2-11: isolation uses explicit member IDs including task workspace conflicts', () => {
  const members = [{ id: 'bad', name: 'victim', workspace: '', status: 'idle' }, { id: 'victim', name: 'Safe', workspace: '/safe', status: 'idle' }]
  const admission = new WorkspaceAdmission({ store: { list: table => table === 'members' ? members : [], get: () => undefined }, refuseIsolation() {}, scopesOverlap: () => false })
  assert.equal(admission.isolationAllows('m', members[1]), true)
  assert.equal(admission.isolationAllows('m', members[0]), false)
  const tasks = ['a', 'b'].map(id => ({ id, status: 'running', scope: ['**'], attempt: { ownerId: 'victim' } }))
  const issues = isolationIssues(members, tasks, () => true)
  assert.ok(issues.some(issue => issue.memberIds.includes('victim') && issue.message.includes('concurrently running tasks')))
})

test('M2-12: current-index trackedness excludes untracked ignored content without changing the real index', async t => {
  const f = await fixture(t)
  await writeFile(path.join(f.source, '.gitignore'), 'answer.txt\nignored.txt\nnode_modules\n')
  git(f.source, ['rm', '--cached', 'answer.txt'])
  await writeFile(path.join(f.source, 'ignored.txt'), 'intentionally tracked despite ignore\n'); git(f.source, ['add', '-f', 'ignored.txt'])
  await writeFile(path.join(f.source, 'new.txt'), 'ordinary untracked\n')
  const index = await readFile(path.join(f.source, '.git', 'index'))
  const snapshot = await captureGitSnapshot(f.source, path.join(f.root, 'snapshot'), async (args, env) => git(f.source, args, env))
  assert.throws(() => git(f.source, ['show', `${snapshot.snapshotCommit}:answer.txt`]))
  assert.equal(git(f.source, ['show', `${snapshot.snapshotCommit}:ignored.txt`]), 'intentionally tracked despite ignore')
  assert.equal(git(f.source, ['show', `${snapshot.snapshotCommit}:new.txt`]), 'ordinary untracked')
  assert.deepEqual(await readFile(path.join(f.source, '.git', 'index')), index)
})

test('M2-13: a transient edit captured by add but reverted before the second digest is retried', async t => {
  const f = await fixture(t); let adds = 0
  const snapshot = await captureGitSnapshot(f.source, path.join(f.root, 'snapshot'), async (args, env) => {
    if (args[0] === 'add' && args[1] === '--all' && adds++ === 0) {
      await writeFile(path.join(f.source, 'answer.txt'), 'transient\n')
      const result = git(f.source, args, env)
      await writeFile(path.join(f.source, 'answer.txt'), 'base\n')
      return result
    }
    return git(f.source, args, env)
  })
  assert.equal(adds, 2)
  assert.equal(snapshot.snapshotCommit, f.baseline)
  let contested = 0
  await assert.rejects(captureGitSnapshot(f.source, path.join(f.root, 'contested'), async (args, env) => {
    if (args[0] === 'add' && args[1] === '--all') {
      contested++
      await writeFile(path.join(f.source, 'answer.txt'), 'transient\n')
      const result = git(f.source, args, env)
      await writeFile(path.join(f.source, 'answer.txt'), 'base\n')
      return result
    }
    return git(f.source, args, env)
  }), /Workspace kept changing/)
  assert.equal(contested, 3)
})
