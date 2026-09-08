import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}
async function fixture(t, options = {}) {
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
  const workspaces = new Workspaces({ workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv, ...options })
  const mission = { id: 'mission-one', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Implement answer', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, head, workspaces, mission, member, task }
}

test('member work and artifact commit never change the source branch or files', async t => {
  const { source, head, workspaces, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), '42\n')
  const artifact = await workspaces.captureArtifact(member, task)
  assert.notEqual(artifact.commit, head)
  assert.equal(artifact.baseCommit, head)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'])
  assert.equal(await readFile(path.join(source, 'src', 'answer.txt'), 'utf8'), 'base\n')
  assert.equal(await git(source, 'rev-parse', 'HEAD'), head)
  assert.equal(await git(source, 'status', '--porcelain'), '')
  assert.equal(await git(source, 'rev-parse', 'refs/swarm/mission-one/task-one/1'), artifact.commit)
})

test('scope enforcement sees staged, committed and untracked files before capture', async t => {
  const { workspaces, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'outside.txt'), 'not permitted\n')
  await git(member.workspace, 'add', 'outside.txt')
  await assert.rejects(workspaces.captureArtifact(member, task), /outside task scope: outside.txt/)
  await git(member.workspace, 'commit', '-m', 'worker attempted outside scope')
  await assert.rejects(workspaces.captureArtifact(member, task), /outside task scope: outside.txt/)
})

test('dirty snapshots preserve the real index and include working content, ignored tracked additions, modes, links and binary files', async t => {
  const { source, head, workspaces } = await fixture(t)
  await writeFile(path.join(source, '.gitignore'), '.env\nlocal-*\n')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'staged user answer\n')
  await writeFile(path.join(source, 'local-tracked'), 'already staged despite ignore\n')
  await git(source, 'add', 'src/answer.txt')
  await git(source, 'add', '--force', 'local-tracked')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'latest unstaged user answer\n')
  await chmod(path.join(source, 'src', 'answer.txt'), 0o755)
  await writeFile(path.join(source, 'notes with space.txt'), 'untracked notes\n')
  const binary = Buffer.from([0, 255, 1, 128, 10, 0])
  await writeFile(path.join(source, 'src', 'binary.bin'), binary)
  await symlink('answer.txt', path.join(source, 'src', 'answer-link'))
  await writeFile(path.join(source, '.env'), 'ignored local fixture\n')
  await rm(path.join(source, 'outside.txt'))
  const index = await readFile(path.join(source, '.git', 'index'))
  const mission = { id: 'mission-dirty', workspace: source }
  const baseline = await workspaces.prepareBaseline(mission)
  assert.equal(baseline.sourceHead, head)
  assert.notEqual(baseline.snapshotCommit, head)
  assert.deepEqual(await readFile(path.join(source, '.git', 'index')), index, 'real staging bytes are unchanged')
  assert.equal(await git(source, 'rev-parse', 'HEAD'), head)
  assert.equal(await git(source, 'rev-parse', 'refs/swarm/mission-dirty/baseline'), baseline.snapshotCommit)
  assert.equal(await git(source, 'show', ':src/answer.txt'), 'staged user answer')
  assert.equal(await readFile(path.join(source, 'src', 'answer.txt'), 'utf8'), 'latest unstaged user answer\n')
  assert.equal(await readFile(path.join(baseline.planningWorkspace, 'src', 'answer.txt'), 'utf8'), 'latest unstaged user answer\n')
  assert.equal((await lstat(path.join(baseline.planningWorkspace, 'src', 'answer.txt'))).mode & 0o111, 0o111)
  assert.equal(await readlink(path.join(baseline.planningWorkspace, 'src', 'answer-link')), 'answer.txt')
  assert.deepEqual(await readFile(path.join(baseline.planningWorkspace, 'src', 'binary.bin')), binary)
  assert.equal(await readFile(path.join(baseline.planningWorkspace, 'local-tracked'), 'utf8'), 'already staged despite ignore\n')
  assert.equal(await readFile(path.join(baseline.planningWorkspace, 'notes with space.txt'), 'utf8'), 'untracked notes\n')
  await assert.rejects(readFile(path.join(baseline.planningWorkspace, '.env')), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(baseline.planningWorkspace, 'outside.txt')), { code: 'ENOENT' })
  assert.ok(baseline.changedPaths.includes('outside.txt'))
  assert.ok(!baseline.changedPaths.includes('.env'))
  const member = { id: 'dirty-worker', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'dirty-worker') }
  const task = { id: 'snapshot-change', missionId: mission.id, epoch: 1, title: 'Only new work', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'new agent answer\n')
  const artifact = await workspaces.captureArtifact(member, task)
  assert.equal(artifact.baseCommit, baseline.snapshotCommit)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'], 'preexisting user changes are baseline, not agent output')
})

test('concurrent members and restarted workspace managers reuse the exact original snapshot', async t => {
  const { source, workspaces, temp } = await fixture(t)
  await writeFile(path.join(source, 'src', 'answer.txt'), 'snapshot one\n')
  const mission = { id: 'mission-shared', workspace: source }
  const [baseline, first, second] = await Promise.all([
    workspaces.prepareBaseline(mission), workspaces.prepareWorkspace(mission, 'first'), workspaces.prepareWorkspace(mission, 'second'),
  ])
  assert.equal(await git(first, 'rev-parse', 'HEAD'), baseline.snapshotCommit)
  assert.equal(await git(second, 'rev-parse', 'HEAD'), baseline.snapshotCommit)
  await writeFile(path.join(source, 'src', 'answer.txt'), 'later source edits\n')
  const resumed = new Workspaces({ workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv })
  try {
    assert.deepEqual(await resumed.prepareBaseline(mission), baseline)
    const third = await resumed.prepareWorkspace(mission, 'third')
    assert.equal(await readFile(path.join(third, 'src', 'answer.txt'), 'utf8'), 'snapshot one\n')
    assert.equal(await readFile(path.join(source, 'src', 'answer.txt'), 'utf8'), 'later source edits\n')
  } finally { await resumed.dispose() }
})

test('legacy mission manifests retain their original baseline after source changes', async t => {
  const { source, head, workspaces, temp } = await fixture(t)
  const mission = { id: 'mission-legacy', workspace: source }
  const directory = path.join(temp, 'worktrees', mission.id)
  await mkdir(directory)
  await writeFile(path.join(directory, 'mission.json'), JSON.stringify({ version: 1, missionId: mission.id, source, baseCommit: head }))
  await writeFile(path.join(source, 'src', 'answer.txt'), 'unrelated later edits\n')
  const baseline = await workspaces.prepareBaseline(mission)
  assert.equal(baseline.snapshotCommit, head)
  assert.deepEqual(baseline.changedPaths, [])
  assert.equal(await readFile(path.join(baseline.planningWorkspace, 'src', 'answer.txt'), 'utf8'), 'base\n')
})

test('snapshot metadata can exceed the small check-output limit on a real repository', async t => {
  const { source, workspaces } = await fixture(t)
  const filenames = Array.from({ length: 192 }, (_, index) => `${String(index).padStart(3, '0')}-${'x'.repeat(180)}.txt`)
  await Promise.all(filenames.map(filename => writeFile(path.join(source, 'src', filename), `tracked ${filename}\n`)))
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'wide tracked tree')
  const head = await git(source, 'rev-parse', 'HEAD')
  assert.ok(Buffer.byteLength(await git(source, 'ls-tree', '-rz', '--full-tree', head)) > 32000)
  await writeFile(path.join(source, 'src', filenames.at(-1)), 'latest wide-tree edit\n')
  const index = await readFile(path.join(source, '.git', 'index'))
  const baseline = await workspaces.prepareBaseline({ id: 'mission-wide', workspace: source })
  assert.equal(baseline.sourceHead, head)
  assert.deepEqual(baseline.changedPaths, [`src/${filenames.at(-1)}`])
  assert.equal(await readFile(path.join(baseline.planningWorkspace, 'src', filenames.at(-1)), 'utf8'), 'latest wide-tree edit\n')
  assert.deepEqual(await readFile(path.join(source, '.git', 'index')), index)
})

test('snapshot retries edits during private-index capture and rejects a continuously changing source', async t => {
  const { source, workspaces, temp } = await fixture(t)
  await writeFile(path.join(source, 'src', 'answer.txt'), 'before capture\n')
  const index = await readFile(path.join(source, '.git', 'index'))
  const nativeGit = workspaces.git.bind(workspaces)
  let captures = 0
  let churn = false
  workspaces.git = async (cwd, args, signal, env) => {
    const result = await nativeGit(cwd, args, signal, env)
    if (env?.GIT_INDEX_FILE && args[0] === 'add') {
      captures++
      if (captures === 1 || churn) await writeFile(path.join(source, 'src', 'answer.txt'), `during capture ${captures}\n`)
    }
    return result
  }
  const baseline = await workspaces.prepareBaseline({ id: 'mission-race', workspace: source })
  assert.ok(captures >= 2)
  assert.equal(await readFile(path.join(baseline.planningWorkspace, 'src', 'answer.txt'), 'utf8'), 'during capture 1\n')
  assert.deepEqual(await readFile(path.join(source, '.git', 'index')), index)
  churn = true
  await assert.rejects(workspaces.prepareBaseline({ id: 'mission-churn', workspace: source }), /kept changing/)
  assert.deepEqual(await readFile(path.join(source, '.git', 'index')), index)
  assert.deepEqual(await readdir(path.join(temp, 'worktrees', 'mission-churn')), [], 'failed captures leave neither private index nor published baseline')
})

test('unresolved Git conflicts are refused without modifying the user index or conflict contents', async t => {
  const { source, head, workspaces } = await fixture(t)
  await git(source, 'checkout', '-b', 'conflicting')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'branch answer\n')
  await git(source, 'commit', '-am', 'branch')
  await git(source, 'checkout', 'main')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'main answer\n')
  await git(source, 'commit', '-am', 'main')
  const merged = await runProcess(['git', 'merge', 'conflicting'], { cwd: source, timeoutMs: 30000, maxBytes: 10000 })
  assert.equal(merged.exitCode, 1)
  const index = await readFile(path.join(source, '.git', 'index'))
  const content = await readFile(path.join(source, 'src', 'answer.txt'))
  await assert.rejects(workspaces.prepareBaseline({ id: 'mission-conflict', workspace: source }), /merge conflicts/)
  assert.deepEqual(await readFile(path.join(source, '.git', 'index')), index)
  assert.deepEqual(await readFile(path.join(source, 'src', 'answer.txt')), content)
  assert.notEqual(await git(source, 'rev-parse', 'HEAD'), head)
})

test('an interrupted planning checkout publication resumes its saved snapshot without recapturing later source edits', async t => {
  const { source, workspaces, temp } = await fixture(t)
  await writeFile(path.join(source, 'src', 'answer.txt'), 'frozen before interruption\n')
  const nativeGit = workspaces.git.bind(workspaces)
  workspaces.git = async (cwd, args, signal, env) => {
    if (args[0] === 'worktree' && args[1] === 'add' && args[3].endsWith('/planning')) throw new Error('fixture publication interrupted')
    return await nativeGit(cwd, args, signal, env)
  }
  const mission = { id: 'mission-interrupted', workspace: source }
  await assert.rejects(workspaces.prepareBaseline(mission), /publication interrupted/)
  const saved = JSON.parse(await readFile(path.join(temp, 'worktrees', mission.id, 'mission.json'), 'utf8')).baseline
  await writeFile(path.join(source, 'src', 'answer.txt'), 'later editor content\n')
  workspaces.git = nativeGit
  const resumed = await workspaces.prepareBaseline(mission)
  assert.deepEqual(resumed, saved)
  assert.equal(await readFile(path.join(resumed.planningWorkspace, 'src', 'answer.txt'), 'utf8'), 'frozen before interruption\n')
  assert.equal(await readFile(path.join(source, 'src', 'answer.txt'), 'utf8'), 'later editor content\n')
})

test('canceling a snapshot drains its private index and permits a clean retry', async t => {
  const { source, workspaces, temp } = await fixture(t)
  await writeFile(path.join(source, 'src', 'answer.txt'), 'cancel-safe user edit\n')
  const index = await readFile(path.join(source, '.git', 'index'))
  const nativeGit = workspaces.git.bind(workspaces)
  const controller = new AbortController()
  workspaces.git = async (cwd, args, signal, env) => {
    const result = await nativeGit(cwd, args, signal, env)
    if (env?.GIT_INDEX_FILE && args[0] === 'add') controller.abort(new Error('snapshot canceled'))
    return result
  }
  const mission = { id: 'mission-canceled', workspace: source }
  await assert.rejects(workspaces.prepareBaseline(mission, controller.signal), /snapshot canceled/)
  assert.deepEqual(await readdir(path.join(temp, 'worktrees', mission.id)), [])
  assert.deepEqual(await readFile(path.join(source, '.git', 'index')), index)
  workspaces.git = nativeGit
  const baseline = await workspaces.prepareBaseline(mission)
  assert.equal(await readFile(path.join(baseline.planningWorkspace, 'src', 'answer.txt'), 'utf8'), 'cancel-safe user edit\n')
})

test('dirty submodules are refused without changing nested user work', async t => {
  const { source, workspaces, temp } = await fixture(t)
  const nested = path.join(temp, 'nested-source')
  await mkdir(nested)
  await git(nested, 'init', '-b', 'main')
  await writeFile(path.join(nested, 'nested.txt'), 'nested base\n')
  await git(nested, 'add', '.')
  await git(nested, 'commit', '-m', 'nested')
  await git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', nested, 'nested')
  await git(source, 'commit', '-am', 'add submodule')
  await writeFile(path.join(source, 'nested', 'nested.txt'), 'nested user edits\n')
  const index = await readFile(path.join(source, '.git', 'index'))
  await assert.rejects(workspaces.prepareBaseline({ id: 'mission-submodule', workspace: source }), /Dirty submodule/)
  assert.deepEqual(await readFile(path.join(source, '.git', 'index')), index)
  assert.equal(await readFile(path.join(source, 'nested', 'nested.txt'), 'utf8'), 'nested user edits\n')
})

test('accepted dependency commits are integrated and unrelated previous work does not leak', async t => {
  const { workspaces, mission, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'first task\n')
  const artifact = await workspaces.captureArtifact(member, task)
  const peer = { id: 'member-peer', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-peer') }
  await workspaces.prepareTask(peer, { ...task, id: 'task-peer' }, [{ ...task, status: 'accepted', artifact }])
  assert.equal(await readFile(path.join(peer.workspace, 'src', 'answer.txt'), 'utf8'), 'first task\n')
  await workspaces.prepareTask(member, { ...task, id: 'task-unrelated' }, [])
  assert.equal(await readFile(path.join(member.workspace, 'src', 'answer.txt'), 'utf8'), 'base\n')
})

test('conflicting dependencies stop with an explicit conflict and no unresolved merge', async t => {
  const { workspaces, mission, member, task } = await fixture(t)
  const other = { id: 'member-two', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-two') }
  const integration = { id: 'member-integration', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-integration') }
  const artifacts = []
  for (const [i, writer] of [member, other].entries()) {
    const writerTask = { ...task, id: `task-writer-${i}` }
    await workspaces.prepareTask(writer, writerTask, [])
    await writeFile(path.join(writer.workspace, 'src', 'answer.txt'), `conflicting ${i}\n`)
    artifacts.push({ ...writerTask, status: 'accepted', artifact: await workspaces.captureArtifact(writer, writerTask) })
  }
  await assert.rejects(workspaces.prepareTask(integration, { ...task, id: 'task-integration' }, artifacts), /Dependency integration conflict/)
  assert.equal(await git(integration.workspace, 'ls-files', '-u'), '')
})

test('checks run against exact immutable commit in a separate disposable worktree', async t => {
  const seen = []
  const { source, workspaces, member, task, temp } = await fixture(t, { confineCheck: (argv, cwd) => { seen.push(cwd); return argv } })
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), '42\n')
  const artifact = await workspaces.captureArtifact(member, task)
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'uncommitted later work\n')
  const results = await workspaces.verifyArtifact(member, { ...task, checks: ['test "$(cat src/answer.txt)" = 42 && echo verified'] }, artifact)
  assert.equal(results[0].exitCode, 0)
  assert.match(results[0].output, /verified/)
  assert.notEqual(seen[0], member.workspace)
  assert.notEqual(seen[0], source)
  assert.equal(await readFile(path.join(member.workspace, 'src', 'answer.txt'), 'utf8'), 'uncommitted later work\n')
  assert.deepEqual(await readdir(path.join(temp, 'worktrees', 'mission-one', 'verification')), [])
})

test('primary-selected check timeout overrides the host fallback and removes the verification worktree', async t => {
  let commandAdmitted = false
  const { workspaces, member, task, temp } = await fixture(t, {
    // Infrastructure Git operations retain a generous fixture deadline.
    // The primary-selected task policy owns the much shorter check timeout.
    checkTimeoutMs: 30000,
    confineCheck: argv => { commandAdmitted = true; return argv },
  })
  await workspaces.prepareTask(member, task, [])
  const artifact = await workspaces.captureArtifact(member, task)
  await assert.rejects(workspaces.verifyArtifact(member, { ...task, checkTimeoutMs: 100, checks: ['while :; do sleep 60; done'] }, artifact), /timed out after 100ms/)
  assert.equal(commandAdmitted, true, 'the declared check must start before the tested timeout')
  assert.deepEqual(await readdir(path.join(temp, 'worktrees', 'mission-one', 'verification')), [])
})

test('bounded UTF-8 output counts the truncation marker in its byte budget', async t => {
  const { temp } = await fixture(t)
  const result = await runProcess([process.execPath, '-e', 'process.stdout.write("界".repeat(500))'], { cwd: temp, timeoutMs: 30000, maxBytes: 65 })
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.output) <= 65)
  assert.match(result.output, /output truncated/)
})

test('caller cancellation drains checks and removes their temporary worktree', async t => {
  const controller = new AbortController()
  const { workspaces, member, task, temp } = await fixture(t, { confineCheck: argv => { setTimeout(() => controller.abort('user stopped'), 50); return argv } })
  await workspaces.prepareTask(member, task, [])
  const artifact = await workspaces.captureArtifact(member, task)
  await assert.rejects(workspaces.verifyArtifact(member, { ...task, checks: ['sleep 5'] }, artifact, controller.signal), /Execution cancelled/)
  assert.deepEqual(await readdir(path.join(temp, 'worktrees', 'mission-one', 'verification')), [])
})

test('same-task restart keeps dirty progress and the original artifact baseline across epochs', async t => {
  const { workspaces, member, task, head } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'partial before restart\n')
  const retry = { ...task, epoch: 3 }
  await workspaces.prepareTask(member, retry, [])
  assert.equal(await readFile(path.join(member.workspace, 'src', 'answer.txt'), 'utf8'), 'partial before restart\n')
  const artifact = await workspaces.captureArtifact(member, retry)
  assert.equal(artifact.baseCommit, head)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'])
})

test('handoff checkpoints partial work, and a later handoff back uses the latest owner progress', async t => {
  const { workspaces, mission, member, task, head } = await fixture(t)
  const peer = { id: 'member-peer', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-peer') }
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'first owner progress\n')
  await workspaces.prepareTask(peer, { ...task, epoch: 3 }, [])
  assert.equal(await readFile(path.join(peer.workspace, 'src', 'answer.txt'), 'utf8'), 'first owner progress\n')
  await writeFile(path.join(peer.workspace, 'src', 'answer.txt'), 'second owner progress\n')
  await workspaces.prepareTask(member, { ...task, epoch: 5 }, [])
  assert.equal(await readFile(path.join(member.workspace, 'src', 'answer.txt'), 'utf8'), 'second owner progress\n')
  const artifact = await workspaces.captureArtifact(member, { ...task, epoch: 5 })
  assert.equal(artifact.baseCommit, head)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'])
})

test('handoff scope failure preserves previous owner files and leaves the new owner untouched', async t => {
  const { workspaces, mission, member, task } = await fixture(t)
  const peer = { id: 'member-peer', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-peer') }
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'outside.txt'), 'out of scope partial edit\n')
  await assert.rejects(workspaces.prepareTask(peer, { ...task, epoch: 3 }, []), /outside task scope/)
  assert.equal(await readFile(path.join(member.workspace, 'outside.txt'), 'utf8'), 'out of scope partial edit\n')
  assert.equal(await readFile(path.join(peer.workspace, 'outside.txt'), 'utf8'), 'original\n')
})

test('reviewer reads the submitted exact commit while its edits cannot change the source artifact', async t => {
  const { workspaces, mission, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'proposed change\n')
  const artifact = await workspaces.captureArtifact(member, task)
  const source = { ...task, status: 'submitted', artifact }
  const reviewer = { id: 'reviewer', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'reviewer') }
  const review = { ...task, id: 'task-review', kind: 'verification', reviewOf: task.id }
  await assert.rejects(workspaces.prepareTask(reviewer, review, []), /exact submitted review source/)
  await workspaces.prepareTask(reviewer, review, [], source)
  assert.equal(await git(reviewer.workspace, 'rev-parse', 'HEAD'), artifact.commit)
  assert.equal(await readFile(path.join(reviewer.workspace, 'src', 'answer.txt'), 'utf8'), 'proposed change\n')
  await writeFile(path.join(reviewer.workspace, 'src', 'answer.txt'), 'reviewer experiment\n')
  assert.equal(await readFile(path.join(member.workspace, 'src', 'answer.txt'), 'utf8'), 'proposed change\n')
  assert.equal(await git(member.workspace, 'show', `${artifact.commit}:src/answer.txt`), 'proposed change')
})
