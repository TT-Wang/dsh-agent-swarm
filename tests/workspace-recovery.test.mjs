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
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-recovery-')))
  const source = path.join(temp, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  await mkdir(path.join(source, 'src'))
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const head = await git(source, 'rev-parse', 'HEAD')
  const workspaces = new Workspaces({ workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv, ...options })
  const mission = { id: 'mission-recovery', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Recover answer', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, head, workspaces, mission, member, task }
}
const taskRecordPath = (temp, missionId, taskId) => path.join(temp, 'worktrees', missionId, 'tasks', `${taskId}.json`)
const memberRecordPath = (temp, missionId, memberId) => path.join(temp, 'worktrees', missionId, `${memberId}.workspace.json`)
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
async function member(mission, workspaces, id) {
  return { id, missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, id) }
}
/** Persist the durable task record the pre-fix build left behind: base, no checkpoint. */
async function writeLegacyTaskRecord(temp, mission, owner, task, baseCommit) {
  await writeFile(taskRecordPath(temp, mission.id, task.id), JSON.stringify({
    version: 1, missionId: mission.id, memberId: owner.id, workspace: owner.workspace,
    task: { taskId: task.id, epoch: task.epoch, baseCommit },
  }))
}

test('W1: a task whose recorded owner moved on recovers from its recorded base instead of dead-ending', async t => {
  const { temp, head, workspaces, mission, member: first, task } = await fixture(t)
  await workspaces.prepareTask(first, task, [])
  // The member moves on to another task before the task is captured. The old
  // task record is then exactly the pre-fix durable state: a base commit and no
  // captured commit, with its recorded owner now working elsewhere.
  await workspaces.prepareTask(first, { ...task, id: 'task-next' }, [])
  await writeLegacyTaskRecord(temp, mission, first, task, head)
  const second = await member(mission, workspaces, 'member-two')
  await workspaces.prepareTask(second, { ...task, epoch: 2 }, [])
  assert.equal(await git(second.workspace, 'rev-parse', 'HEAD'), head, 'the replacement attempt starts at the recorded base')
  const recovered = await readJson(taskRecordPath(temp, mission.id, task.id))
  assert.equal(recovered.memberId, second.id, 'the recovered task record names the new attempt owner')
  assert.equal(recovered.task.taskId, task.id)
  assert.equal(recovered.task.epoch, 2)
  assert.equal(recovered.task.baseCommit, head)
})

test('W1: an ownership switch checkpoints the abandoned task base so the dead state cannot recur', async t => {
  const { temp, head, workspaces, mission, member: first, task } = await fixture(t)
  await workspaces.prepareTask(first, task, [])
  const prepared = await readJson(taskRecordPath(temp, mission.id, task.id))
  assert.equal(prepared.task.capturedCommit, undefined, 'a freshly prepared task has no captured commit yet')
  await workspaces.prepareTask(first, { ...task, id: 'task-next' }, [])
  const checkpoint = await readJson(taskRecordPath(temp, mission.id, task.id))
  assert.equal(checkpoint.memberId, first.id)
  assert.equal(checkpoint.task.baseCommit, head)
  assert.equal(checkpoint.task.capturedCommit, head, 'leaving the task records its quiescent base as the checkpoint')
  const second = await member(mission, workspaces, 'member-two')
  await workspaces.prepareTask(second, { ...task, epoch: 2 }, [])
  assert.equal(await git(second.workspace, 'rev-parse', 'HEAD'), head)
  const recovered = await readJson(memberRecordPath(temp, mission.id, second.id))
  assert.equal(recovered.task.taskId, task.id)
  assert.equal(recovered.task.epoch, 2)
})

test('W1: recovery keeps the recorded task base rather than the mission base', async t => {
  const { temp, head, workspaces, mission, member: first, task } = await fixture(t)
  // A dependency merge makes the task base a commit of its own, distinct from
  // the mission base; a fallback to the mission base would silently drop it.
  await workspaces.prepareTask(first, task, [])
  await writeFile(path.join(first.workspace, 'src', 'answer.txt'), 'dependency work\n')
  const artifact = await workspaces.captureArtifact(first, task)
  const dependent = { ...task, id: 'task-dependent' }
  await workspaces.prepareTask(first, dependent, [{ ...task, status: 'accepted', artifact }])
  const taskBase = await git(first.workspace, 'rev-parse', 'HEAD')
  assert.notEqual(taskBase, head)
  assert.equal(await readFile(path.join(first.workspace, 'src', 'answer.txt'), 'utf8'), 'dependency work\n')
  await workspaces.prepareTask(first, { ...task, id: 'task-next' }, [])
  await writeLegacyTaskRecord(temp, mission, first, dependent, taskBase)
  const second = await member(mission, workspaces, 'member-two')
  await workspaces.prepareTask(second, { ...dependent, epoch: 2 }, [])
  assert.equal(await git(second.workspace, 'rev-parse', 'HEAD'), taskBase, 'recovery checks out the recorded task base, not the mission base')
  assert.equal(await readFile(path.join(second.workspace, 'src', 'answer.txt'), 'utf8'), 'dependency work\n', 'dependency content carried by the task base survives recovery')
})

test('W1: an abandoned-task checkpoint never overwrites a newer owner record', async t => {
  const { temp, head, workspaces, mission, member: first, task } = await fixture(t)
  await workspaces.prepareTask(first, task, [])
  const second = await member(mission, workspaces, 'member-two')
  // The handoff makes the second member the durable owner of the task.
  await workspaces.prepareTask(second, { ...task, epoch: 2 }, [])
  const owned = await readJson(taskRecordPath(temp, mission.id, task.id))
  assert.equal(owned.memberId, second.id)
  assert.equal(owned.task.epoch, 2)
  assert.equal(owned.task.capturedCommit, undefined, 'the new owner starts a fresh un-captured record')
  // Restore the first member's stale pre-handoff record, as a concurrent
  // handoff can leave behind: it still names the task and has no checkpoint,
  // while the durable task record now belongs to the newer owner.
  await writeFile(memberRecordPath(temp, mission.id, first.id), JSON.stringify({
    version: 1, missionId: mission.id, memberId: first.id, workspace: first.workspace,
    task: { taskId: task.id, epoch: 1, baseCommit: head },
  }))
  await workspaces.prepareTask(first, { ...task, id: 'task-next' }, [])
  const after = await readJson(taskRecordPath(temp, mission.id, task.id))
  assert.equal(after.memberId, second.id, 'the newer owner keeps the task record')
  assert.equal(after.task.epoch, 2)
  assert.equal(after.task.capturedCommit, undefined)
})

test('W1: a split member/task record is repaired before an ownership switch so captured work survives', async t => {
  const { temp, head, workspaces, mission, member: first, task } = await fixture(t)
  await workspaces.prepareTask(first, task, [])
  await writeFile(path.join(first.workspace, 'src', 'answer.txt'), 'captured before the crash\n')
  const artifact = await workspaces.captureArtifact(first, task)
  assert.notEqual(artifact.commit, head)
  const saved = await readJson(taskRecordPath(temp, mission.id, task.id))
  assert.equal(saved.task.capturedCommit, artifact.commit)
  // saveTaskWorkspace persists the member record before the task record, so a
  // crash or failed write between the two leaves the member record holding the
  // captured commit while the task record still names only the base.
  await writeFile(taskRecordPath(temp, mission.id, task.id), JSON.stringify({
    ...saved, task: { taskId: task.id, epoch: task.epoch, baseCommit: saved.task.baseCommit },
  }))
  // The owner moves on. The switch repairs the split task record before any
  // later attempt can fall back to the recorded base.
  await workspaces.prepareTask(first, { ...task, id: 'task-next' }, [])
  const repaired = await readJson(taskRecordPath(temp, mission.id, task.id))
  assert.equal(repaired.task.capturedCommit, artifact.commit, 'the split task record is repaired before the switch')
  const second = await member(mission, workspaces, 'member-two')
  await workspaces.prepareTask(second, { ...task, epoch: 2 }, [])
  assert.equal(await git(second.workspace, 'rev-parse', 'HEAD'), artifact.commit, 'the replacement starts at the captured commit, not the base')
  assert.equal(await readFile(path.join(second.workspace, 'src', 'answer.txt'), 'utf8'), 'captured before the crash\n')
})

test('W1: a live owner partial work is still captured instead of falling back to the base', async t => {
  const { head, workspaces, mission, member: first, task } = await fixture(t)
  await workspaces.prepareTask(first, task, [])
  await writeFile(path.join(first.workspace, 'src', 'answer.txt'), 'partial from the first owner\n')
  // The recorded owner still owns this task, so recovery must checkpoint its
  // partial work; the base fallback applies only after the owner moved on.
  const second = await member(mission, workspaces, 'member-two')
  await workspaces.prepareTask(second, { ...task, epoch: 2 }, [])
  assert.equal(await readFile(path.join(second.workspace, 'src', 'answer.txt'), 'utf8'), 'partial from the first owner\n')
  const recovered = await workspaces.captureArtifact(second, { ...task, epoch: 2 })
  assert.equal(recovered.baseCommit, head)
  assert.deepEqual(recovered.changedPaths, ['src/answer.txt'])
})
