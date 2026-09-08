import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
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

test('dirty source state is rejected without dropping tracked or untracked user changes', async t => {
  const { source, workspaces } = await fixture(t)
  await writeFile(path.join(source, 'notes.txt'), 'user work\n')
  await assert.rejects(workspaces.prepareWorkspace({ id: 'mission-dirty', workspace: source }, 'member-dirty'), /uncommitted or untracked/)
  assert.equal(await readFile(path.join(source, 'notes.txt'), 'utf8'), 'user work\n')
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
