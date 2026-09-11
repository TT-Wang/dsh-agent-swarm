/**
 * F-C1: a symlink chain that leaves the workspace is refused by capture and by
 * delivery even when the base tree already contains an escaping link, while a
 * contained chain is still accepted. F-29: a declared verification check runs
 * only under full host enforcement. The real-sandbox boundary is proven
 * host-side by `npm run test:isolation`; these are the deterministic guards.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { applyDelivery } from '../lib/delivery.js'
import { confinedCheckArgv } from '../lib/harness-workers.js'
import { subprocessSeam } from './subprocess-seam.mjs'

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', '-c', 'commit.gpgsign=false', ...args], { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}
const exists = async file => await lstat(file).then(() => true, () => false)
async function commit(worker, message = 'result') {
  await git(worker, 'add', '-A')
  await git(worker, 'commit', '--no-verify', '-m', message)
  return await git(worker, 'rev-parse', 'HEAD')
}
/** Member workspace whose base tree already contains the given committed links. */
async function workspaceFixture(t, { links = {}, options = {} } = {}) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-isolation-')))
  const source = path.join(temp, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await writeFile(path.join(source, 'inside.txt'), 'inside\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  if (Object.keys(links).length > 0) {
    for (const [name, target] of Object.entries(links)) {
      await mkdir(path.dirname(path.join(source, name)), { recursive: true })
      await symlink(target, path.join(source, name))
    }
    await git(source, 'add', '-A')
    await git(source, 'commit', '-m', 'baseline links')
  }
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv, ...options })
  const mission = { id: 'mission-isolation', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Isolation guard', kind: 'implementation', scope: ['**'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  await workspaces.prepareTask(member, task, [])
  return { temp, source, workspaces, member, task }
}
/** Delivery fixture: `baselineLinks` are committed before HEAD, `sourceLinks` are untracked user-local links. */
async function deliveryFixture(t, { baselineLinks = {}, sourceLinks = {} } = {}) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-isolation-delivery-')))
  const source = path.join(temporary, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await writeFile(path.join(source, 'inside.txt'), 'inside\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  if (Object.keys(baselineLinks).length > 0) {
    for (const [name, target] of Object.entries(baselineLinks)) {
      await mkdir(path.dirname(path.join(source, name)), { recursive: true })
      await symlink(target, path.join(source, name))
    }
    await git(source, 'add', '-A')
    await git(source, 'commit', '-m', 'baseline links')
  }
  const head = await git(source, 'rev-parse', 'HEAD')
  const worker = path.join(temporary, 'worker')
  await git(source, 'worktree', 'add', '--detach', worker, head)
  for (const [name, target] of Object.entries(sourceLinks)) {
    await mkdir(path.dirname(path.join(source, name)), { recursive: true })
    await symlink(target, path.join(source, name))
  }
  t.after(async () => { await rm(temporary, { recursive: true, force: true }) })
  return { temporary, source, worker, head }
}

test('F-C1: capture refuses a chain through a pre-existing absolute escaping link', async t => {
  const { workspaces, member, task } = await workspaceFixture(t, { links: { escape: '/etc/hosts' } })
  // `../escape` is lexically inside the workspace; only the chain reveals the escape.
  await symlink('../escape', path.join(member.workspace, 'src', 'chain'))
  await assert.rejects(workspaces.captureArtifact(member, task), /symlink escapes the mission workspace: src\/chain/)
})

test('F-C1: capture resolves every hop through a relative baseline chain', async t => {
  const { workspaces, member, task } = await workspaceFixture(t, { links: { a: 'b', b: '../../outside' } })
  await symlink('../a', path.join(member.workspace, 'src', 'chain'))
  await assert.rejects(workspaces.captureArtifact(member, task), /symlink escapes the mission workspace: src\/chain/)
})

test('F-C1: capture refuses an unresolved symlink cycle', async t => {
  const { workspaces, member, task } = await workspaceFixture(t, { links: { loop: 'loop' } })
  await symlink('../loop', path.join(member.workspace, 'src', 'chain'))
  await assert.rejects(workspaces.captureArtifact(member, task), /does not resolve within 40 links/)
})

test('F-C1: capture still accepts a chain that stays inside the workspace', async t => {
  const { workspaces, member, task } = await workspaceFixture(t, { links: { a: 'b', b: 'inside.txt', alias: 'inside.txt' } })
  await symlink('../a', path.join(member.workspace, 'src', 'chain'))
  await symlink('../alias', path.join(member.workspace, 'src', 'direct'))
  const artifact = await workspaces.captureArtifact(member, task)
  assert.ok(artifact.changedPaths.includes('src/chain'), JSON.stringify(artifact.changedPaths))
  assert.ok(artifact.changedPaths.includes('src/direct'), JSON.stringify(artifact.changedPaths))
})

test('F-C1: delivery refuses a chain through an escaping baseline link before writing', async t => {
  const { source, worker, head } = await deliveryFixture(t, { baselineLinks: { escape: '/etc/hosts' } })
  await symlink('../escape', path.join(worker, 'src', 'chain'))
  const resultCommit = await commit(worker)
  await assert.rejects(applyDelivery({ source, baselineCommit: head, resultCommit }), /Delivery symlink escapes the repository: src\/chain/)
  assert.equal(await exists(path.join(source, 'src', 'chain')), false, 'nothing is materialized before the refusal')
})

test('F-C1: delivery follows an untracked user-local link the artifact would traverse', async t => {
  const { source, worker, head } = await deliveryFixture(t, { sourceLinks: { escape: '/etc/hosts' } })
  await symlink('../escape', path.join(worker, 'src', 'chain'))
  const resultCommit = await commit(worker)
  await assert.rejects(applyDelivery({ source, baselineCommit: head, resultCommit }), /Delivery symlink escapes the repository: src\/chain/)
  assert.equal(await exists(path.join(source, 'src', 'chain')), false)
})

test('F-C1: delivery materializes a chain that stays inside the repository', async t => {
  const { source, worker, head } = await deliveryFixture(t, { baselineLinks: { a: 'b', b: 'inside.txt' } })
  await symlink('../a', path.join(worker, 'src', 'chain'))
  const resultCommit = await commit(worker)
  assert.deepEqual(await applyDelivery({ source, baselineCommit: head, resultCommit }), { status: 'applied', changedPaths: ['src/chain'], conflicts: [] })
  assert.equal(await readlink(path.join(source, 'src', 'chain')), '../a')
})

test('F-29: a declared check runs only when the host reports full enforcement', () => {
  const calls = []
  const full = { confine: (argv, policy) => { calls.push({ argv, policy }); return { argv: ['wrapped', ...argv], enforcement: 'full' } } }
  assert.deepEqual(confinedCheckArgv(full, ['/bin/sh', '-c', 'true'], '/checkout'), ['wrapped', '/bin/sh', '-c', 'true'])
  assert.deepEqual(calls[0].policy, { mode: 'workspace-write', workspaceRoot: '/checkout' }, 'the check is confined to the verification checkout, not the source')
  for (const enforcement of ['partial', 'none', undefined]) {
    let ran = false
    const refusing = { confine: argv => { ran = true; return { argv, enforcement } } }
    assert.throws(() => confinedCheckArgv(refusing, ['/bin/sh', '-c', 'true'], '/checkout'), /full sandbox enforcement/, String(enforcement))
    assert.equal(ran, true, 'the provider is consulted, never bypassed')
  }
})

test('F-C1: capture never records an escaping chain, even after an unrelated retry', async t => {
  const { workspaces, member, task } = await workspaceFixture(t, { links: { escape: '/etc/hosts' } })
  await symlink('../escape', path.join(member.workspace, 'src', 'chain'))
  await assert.rejects(workspaces.captureArtifact(member, task), /symlink escapes the mission workspace/)
  // The refusal is durable: the artifact ref is never published.
  const ref = await runProcess(['git', 'rev-parse', '--verify', '--quiet', 'refs/swarm/mission-isolation/task-one/1'], { subprocess: subprocessSeam, cwd: member.workspace, timeoutMs: 30000, maxBytes: 10000 })
  assert.notEqual(ref.exitCode, 0, 'no artifact ref exists after a refused capture')
  assert.equal(await readFile(path.join(member.workspace, 'src', 'answer.txt'), 'utf8'), 'base\n')
})
