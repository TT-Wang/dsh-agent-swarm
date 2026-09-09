/**
 * Round-4 advisory regressions.
 *
 * A1: `checkpointAbandonedTask` read the shared task record, decided, and wrote
 * without mutual exclusion, so a checkpoint overlapping an ownership switch
 * could clobber the newer owner's record. The fix serializes the read-check-write
 * with a per-record lock; this test holds that lock and proves the checkpoint
 * waits, then declines to write over the newer owner.
 *
 * A2: `git status --untracked-files=all` lists the files inside an untracked
 * dependency directory and never the directory name, so the `isDirectory`
 * branch was unreachable for the ordinary case: a real untracked `node_modules`
 * directory blocked preparation and was captured as out-of-scope work. The fix
 * walks ancestors; a regular file that merely shares the name is still refused.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}
async function fixture(t, options = {}) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-advisory-')))
  const source = path.join(temp, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  await mkdir(path.join(source, 'src'))
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const head = await git(source, 'rev-parse', 'HEAD')
  const workspaces = new Workspaces({ workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv, ...options })
  const mission = { id: 'mission-advisory', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Prepare', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, head, workspaces, mission, member, task }
}
const taskRecordPath = (temp, missionId, taskId) => path.join(temp, 'worktrees', missionId, 'tasks', `${taskId}.json`)
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
const peer = async (mission, workspaces, id) => ({ id, missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, id) })

test('A1: a checkpoint waits for the task-record lock and never clobbers a newer owner', async t => {
  const { temp, head, workspaces, mission, member: first, task } = await fixture(t)
  await workspaces.prepareTask(first, task, [])
  const second = await peer(mission, workspaces, 'member-two')
  const recordPath = taskRecordPath(temp, mission.id, task.id)
  const before = await readJson(recordPath)
  // Hold the record lock exactly as a competing owner's write would.
  await writeFile(`${recordPath}.lock`, 'competing owner')
  let finished = false
  const switching = workspaces.prepareTask(first, { ...task, id: 'task-next' }, []).then(() => { finished = true })
  // Synchronize on the observable, never on a fixed sleep: the pre-fix
  // checkpoint writes the shared record without honouring the lock, while the
  // fixed checkpoint blocks until the lock is released. Poll the record for a
  // generous bounded interval so a slow pre-fix write cannot escape detection
  // (the verifier measured the pre-fix blind write well inside 3 s).
  const waitUntil = Date.now() + 5000
  let changedWhileLockHeld = false
  while (!changedWhileLockHeld && !finished && Date.now() < waitUntil) {
    changedWhileLockHeld = await readJson(recordPath).then(current => JSON.stringify(current) !== JSON.stringify(before), () => true)
    if (!changedWhileLockHeld && !finished) await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(changedWhileLockHeld, false, 'the abandoned-task checkpoint must not write the shared record while the lock is held')
  assert.equal(finished, false, 'the abandoned-task checkpoint waits instead of writing blind')
  // The newer owner's record lands while the checkpoint waits.
  await writeFile(recordPath, JSON.stringify({ version: 1, missionId: mission.id, memberId: second.id, workspace: second.workspace,
    task: { taskId: task.id, epoch: 2, baseCommit: head } }))
  await rm(`${recordPath}.lock`, { force: true })
  await switching
  const after = await readJson(recordPath)
  assert.equal(after.memberId, second.id, 'the newer owner keeps the task record')
  assert.equal(after.task.epoch, 2)
  assert.equal(after.task.capturedCommit, undefined, 'the stale checkpoint never wrote its base over the new owner')
  const memberRecord = await readJson(path.join(temp, 'worktrees', mission.id, `${first.id}.workspace.json`))
  assert.equal(memberRecord.task.taskId, 'task-next', 'the switching member still moves on to its next task')
})

test('A2: a real untracked dependency directory is excluded from preparation and capture', async t => {
  const { temp, workspaces, mission, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  await mkdir(path.join(member.workspace, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(member.workspace, 'node_modules', 'dep', 'value.txt'), 'toolchain\n')
  assert.match(await git(member.workspace, 'status', '--porcelain=v1', '--untracked-files=all'), /\?\? node_modules\/dep\/value\.txt/, 'the dependency directory is untracked and not ignored')
  // Pre-fix this refused with "Member workspace has uncommitted work".
  const next = { ...task, id: 'task-next' }
  await workspaces.prepareTask(member, next, [])
  const record = await readJson(path.join(temp, 'worktrees', mission.id, `${member.id}.workspace.json`))
  assert.equal(record.task.taskId, 'task-next')
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'scoped work\n')
  const artifact = await workspaces.captureArtifact(member, next)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'], 'dependency content is never an artifact change')
  assert.equal(await git(member.workspace, 'ls-files', '--', 'node_modules'), '', 'the dependency directory is never committed')
  const shown = await runProcess(['git', 'show', `${artifact.commit}:node_modules/dep/value.txt`], { cwd: member.workspace, timeoutMs: 30000, maxBytes: 10000 })
  assert.notEqual(shown.exitCode, 0, 'the commit contains no dependency file')
  assert.equal(await readFile(path.join(member.workspace, 'node_modules', 'dep', 'value.txt'), 'utf8'), 'toolchain\n', 'the dependency directory stays in the workspace')
})

test('A2: a staged dependency directory is unstaged, while lookalike files and unrelated paths still refuse', async t => {
  const { workspaces, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  await mkdir(path.join(member.workspace, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(member.workspace, 'node_modules', 'dep', 'value.txt'), 'toolchain\n')
  // Simulate a previous capture attempt that staged the dependency directory.
  await git(member.workspace, 'add', '--', 'node_modules')
  assert.equal(await git(member.workspace, 'diff', '--cached', '--name-only', '--', 'node_modules'), 'node_modules/dep/value.txt')
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'work after a failed capture\n')
  const artifact = await workspaces.captureArtifact(member, task)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'])
  assert.equal(await git(member.workspace, 'ls-files', '--', 'node_modules'), '', 'the staged dependency content is unstaged before the commit')
  // A nested dependency directory is recognized by its ancestor component.
  await rm(path.join(member.workspace, 'node_modules'), { recursive: true, force: true })
  await mkdir(path.join(member.workspace, 'vendor', 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(member.workspace, 'vendor', 'node_modules', 'dep', 'value.txt'), 'nested toolchain\n')
  const nested = { ...task, id: 'task-nested' }
  await workspaces.prepareTask(member, nested, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'nested work\n')
  const nestedArtifact = await workspaces.captureArtifact(member, nested)
  assert.deepEqual(nestedArtifact.changedPaths, ['src/answer.txt'])
  // A regular file that merely shares a dependency name is ordinary work.
  await rm(path.join(member.workspace, 'vendor'), { recursive: true, force: true })
  await writeFile(path.join(member.workspace, 'node_modules'), 'not a directory\n')
  await assert.rejects(workspaces.prepareTask(member, { ...task, id: 'task-lookalike' }, []), /uncommitted work/)
})
