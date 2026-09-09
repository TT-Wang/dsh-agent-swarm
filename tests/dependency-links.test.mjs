import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}
async function fixture(t, options = {}) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-deps-')))
  const source = path.join(temp, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  await mkdir(path.join(source, 'src'))
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  // Directory-only ignore patterns: a symlink of the same name stays untracked,
  // which is exactly the state a member creates to run its declared checks.
  await writeFile(path.join(source, '.gitignore'), 'node_modules/\nvendor/\n')
  await mkdir(path.join(source, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(source, 'node_modules', 'dep', 'value.txt'), 'toolchain\n')
  await mkdir(path.join(source, 'vendor', 'dep'), { recursive: true })
  await writeFile(path.join(source, 'vendor', 'dep', 'value.txt'), 'vendored\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const workspaces = new Workspaces({ workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv, ...options })
  const mission = { id: 'mission-deps', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Run checks', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, workspaces, mission, member, task }
}
const memberRecordPath = (temp, missionId, memberId) => path.join(temp, 'worktrees', missionId, `${memberId}.workspace.json`)
const readJson = async file => JSON.parse(await readFile(file, 'utf8'))

test('W10: a member dependency symlink does not block the next task preparation', async t => {
  const { temp, source, workspaces, mission, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  const link = path.join(member.workspace, 'node_modules')
  await symlink(path.join(source, 'node_modules'), link)
  assert.match(await git(member.workspace, 'status', '--porcelain=v1', '--untracked-files=all'), /\?\? node_modules/)
  await workspaces.prepareTask(member, { ...task, id: 'task-next' }, [])
  const record = await readJson(memberRecordPath(temp, mission.id, member.id))
  assert.equal(record.task.taskId, 'task-next', 'preparation proceeds past the dependency link')
  assert.equal((await lstat(link)).isSymbolicLink(), true, 'the dependency link is left untouched')
  assert.equal(await readFile(path.join(member.workspace, 'src', 'answer.txt'), 'utf8'), 'base\n')
})

test('W10: the clean-workspace guard still refuses real work and lookalike paths', async t => {
  const { workspaces, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  const next = { ...task, id: 'task-next' }
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'modified tracked work\n')
  await assert.rejects(workspaces.prepareTask(member, next, []), /uncommitted work/)
  await git(member.workspace, 'checkout', '--', 'src/answer.txt')
  await writeFile(path.join(member.workspace, 'stray.txt'), 'untracked real work\n')
  await assert.rejects(workspaces.prepareTask(member, next, []), /uncommitted work/)
  await rm(path.join(member.workspace, 'stray.txt'))
  // A regular file that merely shares a dependency directory's name is not a
  // plugin-linked dependency directory.
  await writeFile(path.join(member.workspace, 'node_modules'), 'not a link\n')
  await assert.rejects(workspaces.prepareTask(member, next, []), /uncommitted work/)
  await rm(path.join(member.workspace, 'node_modules'))
  await symlink('src', path.join(member.workspace, 'unrelated-link'))
  await assert.rejects(workspaces.prepareTask(member, next, []), /uncommitted work/)
})

test('W10: configured verification dependency names are honored exactly', async t => {
  const { temp, source, workspaces, mission, member, task } = await fixture(t, { verificationDependencyDirs: ['vendor'] })
  await workspaces.prepareTask(member, task, [])
  await symlink(path.join(source, 'vendor'), path.join(member.workspace, 'vendor'))
  await workspaces.prepareTask(member, { ...task, id: 'task-vendor' }, [])
  const record = await readJson(memberRecordPath(temp, mission.id, member.id))
  assert.equal(record.task.taskId, 'task-vendor', 'the configured dependency link is ignored')
  // node_modules is not configured here, so its link is ordinary untracked work.
  await symlink(path.join(source, 'node_modules'), path.join(member.workspace, 'node_modules'))
  await assert.rejects(workspaces.prepareTask(member, { ...task, id: 'task-next' }, []), /uncommitted work/)
})

test('W11: a dependency link is excluded from capture under narrow and broad scopes', async t => {
  const { source, workspaces, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  const link = path.join(member.workspace, 'node_modules')
  await symlink(path.join(source, 'node_modules'), link)
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'narrow work\n')
  const narrow = await workspaces.captureArtifact(member, task)
  assert.deepEqual(narrow.changedPaths, ['src/answer.txt'], 'the link is not an artifact change')
  const broad = { ...task, id: 'task-broad', scope: ['**'] }
  await workspaces.prepareTask(member, broad, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'broad work\n')
  const captured = await workspaces.captureArtifact(member, broad)
  assert.deepEqual(captured.changedPaths, ['src/answer.txt'])
  assert.equal((await lstat(link)).isSymbolicLink(), true, 'the dependency link stays in the workspace')
  assert.equal(await git(member.workspace, 'ls-files', '--', 'node_modules'), '', 'the link is never committed')
})

test('W11: an already-staged dependency link is unstaged before the artifact commit', async t => {
  const { source, workspaces, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'work after a failed capture\n')
  const link = path.join(member.workspace, 'node_modules')
  await symlink(path.join(source, 'node_modules'), link)
  // Simulate a previous capture attempt that staged the link before failing.
  await git(member.workspace, 'add', '--', 'node_modules')
  assert.equal(await git(member.workspace, 'diff', '--cached', '--name-only', '--', 'node_modules'), 'node_modules')
  const artifact = await workspaces.captureArtifact(member, task)
  assert.deepEqual(artifact.changedPaths, ['src/answer.txt'])
  assert.equal(await git(member.workspace, 'ls-files', '--', 'node_modules'), '', 'the staged link is unstaged')
  const shown = await runProcess(['git', 'show', `${artifact.commit}:node_modules`], { cwd: member.workspace, timeoutMs: 30000, maxBytes: 10000 })
  assert.notEqual(shown.exitCode, 0, 'the commit contains no dependency link')
  assert.equal((await lstat(link)).isSymbolicLink(), true, 'the link stays in the workspace')
})

test('W11: the M5 symlink-escape guard still rejects a worker-created escaping symlink', async t => {
  const { workspaces, member, task } = await fixture(t)
  await workspaces.prepareTask(member, task, [])
  await symlink('/etc/hosts', path.join(member.workspace, 'src', 'escape'))
  await assert.rejects(workspaces.captureArtifact(member, task), /symlink escapes the mission workspace: src\/escape/)
})
