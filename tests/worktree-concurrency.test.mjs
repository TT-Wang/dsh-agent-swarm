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
async function fixture(t, options = {}) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-worktree-')))
  const source = path.join(temp, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  await mkdir(path.join(source, 'src'))
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const head = await git(source, 'rev-parse', 'HEAD')
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv, ...options })
  const mission = { id: 'mission-race', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Race answer', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, head, workspaces, mission, member, task }
}
const isMutation = args => args[0] === 'worktree' && ['add', 'remove', 'prune', 'move'].includes(args[1])
const commondir = async (source, name) => (await readFile(path.join(source, '.git', 'worktrees', name, 'commondir'), 'utf8')).trim()

test('W4: concurrent worktree creation and removal in one repository is serialized', async t => {
  const { source, workspaces, mission, member, task } = await fixture(t)
  const nativeGit = workspaces.git.bind(workspaces)
  let active = 0
  let maxActive = 0
  let mutations = 0
  let arrivals = 0
  let release
  const secondArrived = new Promise(resolve => { release = resolve })
  // Hold the first worktree metadata mutation until a second one arrives (or
  // the bounded wait expires). Before the fix two preparations for one
  // repository run `git worktree add` concurrently and this barrier releases
  // immediately; after the fix the lock makes the second arrival impossible
  // while the first is held, so the wait expires and the operations serialize.
  const waitForOverlap = async () => {
    arrivals++
    if (arrivals >= 2) { release(); return }
    await Promise.race([secondArrived, new Promise(resolve => setTimeout(resolve, 500))])
  }
  workspaces.git = async (cwd, args, signal, overrides, maxBytes, raw) => {
    const mutating = isMutation(args)
    if (mutating) { mutations++; active++; maxActive = Math.max(maxActive, active); await waitForOverlap() }
    try { return await nativeGit(cwd, args, signal, overrides, maxBytes, raw) }
    finally { if (mutating) active-- }
  }
  const [baseline, first, second] = await Promise.all([
    workspaces.prepareBaseline(mission), workspaces.prepareWorkspace(mission, 'first'), workspaces.prepareWorkspace(mission, 'second'),
  ])
  // A disposable verification checkout adds and removes a worktree while a new
  // member workspace is prepared in the same repository.
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), '42\n')
  const artifact = await workspaces.captureArtifact(member, task)
  const [, late] = await Promise.all([
    workspaces.verifyArtifact(member, { ...task, checks: ['test "$(cat src/answer.txt)" = 42'] }, artifact),
    workspaces.prepareWorkspace(mission, 'late'),
  ])
  assert.ok(mutations >= 5, `expected several worktree metadata mutations, saw ${mutations}`)
  assert.equal(maxActive, 1, 'git worktree metadata mutation must be serialized per repository')
  assert.equal(await git(first, 'rev-parse', 'HEAD'), baseline.snapshotCommit)
  assert.equal(await git(second, 'rev-parse', 'HEAD'), baseline.snapshotCommit)
  assert.equal(await git(late, 'rev-parse', 'HEAD'), baseline.snapshotCommit)
  for (const name of ['planning', 'first', 'second', 'late']) {
    assert.equal(await commondir(source, name), '../..', `worktree metadata for ${name} is complete`)
  }
})

test('W4: two missions and many members prepare worktrees on one repository without git 128', async t => {
  const { source, workspaces, mission } = await fixture(t)
  const other = { id: 'mission-race-two', workspace: source }
  const names = ['a', 'b', 'c', 'd']
  const [one, two] = await Promise.all([workspaces.prepareBaseline(mission), workspaces.prepareBaseline(other)])
  assert.notEqual(one.planningWorkspace, two.planningWorkspace)
  const pairs = await Promise.all(names.map(async name => {
    const [left, right] = await Promise.all([
      workspaces.prepareWorkspace(mission, `one-${name}`),
      workspaces.prepareWorkspace(other, `two-${name}`),
    ])
    return { left, right }
  }))
  for (const [index, pair] of pairs.entries()) {
    assert.equal(await git(pair.left, 'rev-parse', 'HEAD'), one.snapshotCommit, `mission one member ${names[index]} starts at its snapshot`)
    assert.equal(await git(pair.right, 'rev-parse', 'HEAD'), two.snapshotCommit, `mission two member ${names[index]} starts at its snapshot`)
    for (const prefix of ['one-', 'two-']) {
      assert.equal(await commondir(source, `${prefix}${names[index]}`), '../..', `${prefix}${names[index]} metadata is complete`)
    }
  }
})
