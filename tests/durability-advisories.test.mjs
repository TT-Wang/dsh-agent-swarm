/**
 * Round-4 advisory regressions.
 *
 * A1: a task record is shared by the previous attempt, the recovering attempt
 * and capture. A checkpoint that read the record, decided it still owned it and
 * wrote after a newer attempt's write would clobber that write. Every writer of
 * a task record runs in this process (the store's runtime lock admits one per
 * store and a mission belongs to one store), so the writes of one record are
 * serialized in memory: this test holds an older checkpoint inside its write and
 * proves the newer attempt's write waits behind it instead of being lost.
 *
 * A2: `git status --untracked-files=all` lists the files inside an untracked
 * dependency directory and never the directory name, so the `isDirectory`
 * branch was unreachable for the ordinary case: a real untracked `node_modules`
 * directory blocked preparation and was captured as out-of-scope work. The fix
 * walks ancestors; a regular file that merely shares the name is still refused.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import filesystem, { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runProcess } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'
import { eventually, makeWorkspaces } from './faults/harness.mjs'

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 })
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
  const workspaces = makeWorkspaces(temp, options)
  const mission = { id: 'mission-advisory', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Prepare', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, head, workspaces, mission, member, task }
}
const taskRecordPath = (temp, missionId, taskId) => path.join(temp, 'worktrees', missionId, 'tasks', `${taskId}.json`)
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))

/**
 * Hold the first write of `file` in flight until released: a private JSON write
 * publishes by renaming its temporary over the record. `landed` lists the epoch
 * of each write of the record in the order the writes took effect.
 */
function holdFirstWrite(t, file) {
  const rename = filesystem.rename
  let reach, release
  const reached = new Promise(resolve => { reach = resolve })
  const released = new Promise(resolve => { release = resolve })
  const landed = []
  filesystem.rename = async (from, to) => {
    if (to !== file) return await rename(from, to)
    const epoch = JSON.parse(await readFile(from, 'utf8')).task.epoch
    if (reach !== undefined) { const signal = reach; reach = undefined; signal(); await released }
    await rename(from, to)
    landed.push(epoch)
  }
  syncBuiltinESMExports()
  t.after(() => { filesystem.rename = rename; syncBuiltinESMExports() })
  return { reached, release, landed }
}

test('A1: writes of one task record serialize in this process, so an older checkpoint never lands over a newer attempt', async t => {
  const { temp, workspaces, mission, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  const recordPath = taskRecordPath(temp, mission.id, task.id)
  const write = holdFirstWrite(t, recordPath)
  // Attempt 1's checkpoint has read the record and decided it still owns it; its write is in flight.
  const checkpoint = workspaces.checkpointTask(member, task)
  await write.reached
  // Attempt 2 of the same task takes the record over while that write is in flight.
  const takeover = workspaces.prepareTask(member, { ...task, epoch: 2 }, [])
  const memberRecord = path.join(temp, 'worktrees', mission.id, `${member.id}.workspace.json`)
  await eventually(async () => (await readJson(memberRecord)).task.epoch === 2, 'attempt 2 reaches its task record write')
  assert.equal((await readJson(recordPath)).task.epoch, 1, 'the newer write waits behind the one in flight')
  write.release()
  await Promise.all([checkpoint, takeover])
  assert.deepEqual(write.landed, [1, 2], 'the writes took effect one at a time, in the order they began')
  const after = await readJson(recordPath)
  assert.equal(after.task.epoch, 2, 'the newer attempt keeps the record: no lost update')
  assert.match(after.task.preservedCommit, /^[a-f0-9]{40,64}$/, 'the checkpoint it waited behind is carried forward')
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
  const shown = await runProcess(['git', 'show', `${artifact.commit}:node_modules/dep/value.txt`], { subprocess: subprocessSeam, cwd: member.workspace, timeoutMs: 30000, maxBytes: 10000 })
  assert.notEqual(shown.exitCode, 0, 'the commit contains no dependency file')
  assert.equal(await readFile(path.join(member.workspace, 'node_modules', 'dep', 'value.txt'), 'utf8'), 'toolchain\n', 'the dependency directory stays in the workspace')
})

test('A2: a staged dependency directory is unstaged while ordinary lookalike work is preserved before moving on', async t => {
  const { temp, mission, workspaces, member, task } = await fixture(t)
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
  await workspaces.prepareTask(member, { ...task, id: 'task-lookalike' }, [])
  const saved = JSON.parse(await readFile(path.join(temp, 'worktrees', mission.id, 'tasks', `${nested.id}.json`), 'utf8'))
  assert.equal(await git(member.workspace, 'show', `${saved.task.preservedCommit}:node_modules`), 'not a directory')
})
