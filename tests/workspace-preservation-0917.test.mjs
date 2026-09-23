/** Orchestration recovery regressions, using real disposable Git worktrees. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}
async function fixture(t) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-ignored-recovery-')))
  const source = path.join(temp, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, '.gitignore'), 'review/\n.env\nnode_modules/\n')
  await writeFile(path.join(source, 'tracked.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  await writeFile(path.join(source, '.env'), 'source secret not for swarm\n')
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv })
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  const mission = { id: 'mission-preserve', workspace: source }
  const member = { id: 'first', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'first') }
  const peer = { id: 'second', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'second') }
  // R24: the draft is preserved because the task declares it, not because the prose names it.
  const task = { id: 'draft', missionId: mission.id, epoch: 1, title: 'Draft review', objective: 'Write review/final.md', acceptance: ['Deliver review/final.md'], outputs: ['review/final.md'], kind: 'research', scope: ['review/'], checks: [], status: 'running' }
  const taskPath = taskId => path.join(temp, 'worktrees', mission.id, 'tasks', `${taskId}.json`)
  const memberPath = memberId => path.join(temp, 'worktrees', mission.id, `${memberId}.workspace.json`)
  const read = async file => JSON.parse(await readFile(file, 'utf8'))
  const report = async (owner, content) => { await mkdir(path.join(owner.workspace, 'review'), { recursive: true }); await writeFile(path.join(owner.workspace, 'review/final.md'), content) }
  return { temp, source, workspaces, mission, member, peer, task, taskPath, memberPath, read, report }
}

test('checkpoint preserves a named ignored draft privately; handoff restores it without source secrets', async t => {
  const f = await fixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await f.report(f.member, 'unique draft\n')
  await writeFile(path.join(f.member.workspace, '.env'), 'local secret\n')
  const index = await readFile(path.resolve(f.member.workspace, await git(f.member.workspace, 'rev-parse', '--git-path', 'index')))
  const head = await git(f.member.workspace, 'rev-parse', 'HEAD')
  await f.workspaces.checkpointTask(f.member, { ...f.task, epoch: 2 })
  const saved = await f.read(f.taskPath(f.task.id))
  assert.equal(await git(f.member.workspace, 'show', `${saved.task.preservedCommit}:review/final.md`), 'unique draft')
  assert.equal(await git(f.member.workspace, 'rev-parse', 'HEAD'), head)
  assert.deepEqual(await readFile(path.resolve(f.member.workspace, await git(f.member.workspace, 'rev-parse', '--git-path', 'index'))), index)
  assert.equal(await git(f.member.workspace, 'ls-tree', '-r', '--name-only', saved.task.preservedCommit, '--', '.env'), '')
  assert.equal(await git(f.source, 'ls-tree', '-r', '--name-only', head, '--', '.env'), '')
  await f.workspaces.prepareTask(f.peer, { ...f.task, epoch: 2 }, [])
  assert.equal(await readFile(path.join(f.peer.workspace, 'review/final.md'), 'utf8'), 'unique draft\n')
  await assert.rejects(readFile(path.join(f.peer.workspace, '.env')), { code: 'ENOENT' })
  assert.equal(await git(path.join(f.temp, 'worktrees', f.mission.id, 'artifacts.git'), 'for-each-ref', '--format=%(refname)', 'refs/artifacts/'), '', 'preserving a draft does not submit an artifact')
})

test('legacy metadata gets its preservation paths from the checkpoint task\'s declared outputs', async t => {
  const f = await fixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  for (const filename of [f.memberPath(f.member.id), f.taskPath(f.task.id)]) {
    const record = await f.read(filename)
    delete record.task.preservationPaths
    await writeFile(filename, JSON.stringify(record))
  }
  await f.report(f.member, 'legacy ignored draft\n')
  await f.workspaces.checkpointTask(f.member, { ...f.task, epoch: 2 })
  const saved = await f.read(f.taskPath(f.task.id))
  assert.equal(await git(f.member.workspace, 'show', `${saved.task.preservedCommit}:review/final.md`), 'legacy ignored draft')
})

test('switching to a same-path review preserves the latest ignored draft before overwrite', async t => {
  const f = await fixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await f.report(f.member, 'first draft\n')
  await f.workspaces.checkpointTask(f.member, { ...f.task, epoch: 2 })
  await f.report(f.member, 'latest ignored draft\n')
  const source = { ...f.task, id: 'published' }
  await f.workspaces.prepareTask(f.peer, source, [])
  await f.report(f.peer, 'published by other task\n')
  const artifact = await f.workspaces.captureArtifact(f.peer, source, ['review/final.md'])
  const review = { ...f.task, id: 'review-published', kind: 'verification', reviewOf: source.id }
  await f.workspaces.prepareTask(f.member, review, [], { ...source, status: 'submitted', artifact })
  assert.equal(await readFile(path.join(f.member.workspace, 'review/final.md'), 'utf8'), 'published by other task\n')
  const saved = await f.read(f.taskPath(f.task.id))
  assert.equal(await git(f.member.workspace, 'show', `${saved.task.preservedCommit}:review/final.md`), 'latest ignored draft')
  await f.workspaces.prepareTask(f.peer, { ...f.task, epoch: 2 }, [])
  assert.equal(await readFile(path.join(f.peer.workspace, 'review/final.md'), 'utf8'), 'latest ignored draft\n')
})

for (const operation of ['checkout', 'dependency merge']) test(`unclaimed ignored-file collision refuses ${operation} without changing contents`, async t => {
  const f = await fixture(t)
  const source = { ...f.task, id: 'published' }
  await f.workspaces.prepareTask(f.peer, source, [])
  await f.report(f.peer, 'published by peer\n')
  const artifact = await f.workspaces.captureArtifact(f.peer, source, ['review/final.md'])
  // This path is not a declared output of any task on the receiving member.
  await f.report(f.member, 'unowned ignored content\n')
  const head = await git(f.member.workspace, 'rev-parse', 'HEAD')
  const next = { ...f.task, id: 'next', objective: 'Inspect existing work', acceptance: [], outputs: [], ...(operation === 'checkout' ? { kind: 'verification', reviewOf: source.id } : { kind: 'integration' }) }
  await assert.rejects(operation === 'checkout'
    ? f.workspaces.prepareTask(f.member, next, [], { ...source, status: 'submitted', artifact })
    : f.workspaces.prepareTask(f.member, next, [{ ...source, status: 'accepted', artifact }]), error => error.code === 'workspace_ignored_collision')
  assert.equal(await readFile(path.join(f.member.workspace, 'review/final.md'), 'utf8'), 'unowned ignored content\n')
  assert.equal(await git(f.member.workspace, 'rev-parse', 'HEAD'), head)
  assert.equal((await f.read(f.memberPath(f.member.id))).task, undefined)
})

test('legacy moved-owner stop accepts a proven preceding-epoch checkpoint without touching current work', async t => {
  const f = await fixture(t)
  await f.workspaces.prepareTask(f.member, f.task, [])
  await f.report(f.member, 'saved old task\n')
  await f.workspaces.checkpointTask(f.member, { ...f.task, epoch: 2 })
  const next = { ...f.task, id: 'next', objective: 'Write tracked.txt', acceptance: [], scope: ['tracked.txt'] }
  await f.workspaces.prepareTask(f.member, next, [])
  await writeFile(path.join(f.member.workspace, 'tracked.txt'), 'current task WIP\n')
  const memberMetadata = await readFile(f.memberPath(f.member.id))
  const taskMetadata = await readFile(f.taskPath(f.task.id))
  await f.workspaces.checkpointTask(f.member, { ...f.task, epoch: 2 })
  assert.deepEqual(await readFile(f.memberPath(f.member.id)), memberMetadata)
  assert.deepEqual(await readFile(f.taskPath(f.task.id)), taskMetadata)
  assert.equal(await readFile(path.join(f.member.workspace, 'tracked.txt'), 'utf8'), 'current task WIP\n')
  await assert.rejects(f.workspaces.checkpointTask(f.member, { ...f.task, epoch: 3 }), error => error.code === 'WORKSPACE_OWNERSHIP_CONFLICT')
  const saved = await f.read(f.taskPath(f.task.id))
  saved.task.preservedCommit = 'f'.repeat(40)
  await writeFile(f.taskPath(f.task.id), JSON.stringify(saved))
  await assert.rejects(f.workspaces.checkpointTask(f.member, { ...f.task, epoch: 2 }), error => error.code === 'WORKSPACE_OWNERSHIP_CONFLICT')
  delete saved.task.preservedCommit
  delete saved.task.capturedCommit
  await writeFile(f.taskPath(f.task.id), JSON.stringify(saved))
  await assert.rejects(f.workspaces.checkpointTask(f.member, { ...f.task, epoch: 2 }), error => error.code === 'WORKSPACE_OWNERSHIP_CONFLICT')
  assert.equal(await readFile(path.join(f.member.workspace, 'tracked.txt'), 'utf8'), 'current task WIP\n')
})
