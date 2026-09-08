/** Clean verification checkouts see the source project's installed toolchain without changing the artifact. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}
async function fixture(t, options = {}) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-verify-deps-')))
  const source = path.join(temp, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, '.gitignore'), 'node_modules/\nlib/\n')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await writeFile(path.join(source, 'package.json'), '{"name":"fixture","scripts":{"test":"toolchain-check"}}\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  // An installed, ignored toolchain: a bin shim plus a nested package node_modules, and an ignored build output that must never be linked.
  await mkdir(path.join(source, 'node_modules', '.bin'), { recursive: true })
  await writeFile(path.join(source, 'node_modules', '.bin', 'toolchain-check'), '#!/bin/sh\necho "toolchain from $(pwd)"; test -f src/answer.txt\n')
  await chmod(path.join(source, 'node_modules', '.bin', 'toolchain-check'), 0o755)
  await mkdir(path.join(source, 'packages', 'inner', 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(source, 'packages', 'inner', 'node_modules', 'dep', 'index.js'), 'module.exports = 42\n')
  await writeFile(path.join(source, 'packages', 'inner', 'index.js'), 'console.log(require("dep"))\n')
  await git(source, 'add', 'packages/inner/index.js')
  await git(source, 'commit', '-m', 'inner package')
  await mkdir(path.join(source, 'lib'))
  await writeFile(path.join(source, 'lib', 'stale.js'), 'stale build output\n')
  const workspaces = new Workspaces({ workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv, ...options })
  const mission = { id: 'mission-one', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Implement answer', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), '42\n')
  const artifact = await workspaces.captureArtifact(member, task)
  return { temp, source, workspaces, member, task, artifact }
}

test('ignored dependency directories are linked at every depth into the clean checkout; build outputs are not', async t => {
  const seen = []
  const { source, workspaces, member, task, artifact, temp } = await fixture(t, { confineCheck: (argv, cwd) => { seen.push(cwd); return argv } })
  const results = await workspaces.verifyArtifact(member, { ...task, checks: [
    'PATH="$PWD/node_modules/.bin:$PATH" toolchain-check',
    'node packages/inner/index.js',
    'test ! -e lib/stale.js && echo no-build-output',
    'test -L node_modules && test -L packages/inner/node_modules && echo linked',
  ] }, artifact)
  assert.deepEqual(results.map(result => result.exitCode), [0, 0, 0, 0], JSON.stringify(results, null, 2))
  assert.match(results[0].output, new RegExp(`toolchain from ${seen[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'the check runs in the checkout, not the source')
  assert.match(results[1].output, /42/); assert.match(results[2].output, /no-build-output/); assert.match(results[3].output, /linked/)
  assert.deepEqual(await readdir(path.join(temp, 'worktrees', 'mission-one', 'verification')), [], 'the checkout and its links are removed')
  assert.equal(await readFile(path.join(source, 'src', 'answer.txt'), 'utf8'), 'base\n', 'the source is untouched')
  assert.equal((await lstat(path.join(source, 'node_modules'))).isDirectory(), true, 'the source toolchain remains a real directory')
  const tree = await git(source, 'ls-tree', '-r', '--name-only', artifact.commit)
  assert(!tree.includes('node_modules'), 'linked dependencies never enter the committed artifact')
})

test('a missing command is diagnosed as an environment failure, and linking can be disabled', async t => {
  const { workspaces, member, task, artifact } = await fixture(t, { verificationDependencyDirs: [] })
  const results = await workspaces.verifyArtifact(member, { ...task, checks: ['test ! -e node_modules && echo unlinked', 'toolchain-check'] }, artifact)
  assert.equal(results[0].exitCode, 0); assert.match(results[0].output, /unlinked/)
  assert.equal(results[1].exitCode, 127)
  assert.match(results[1].output, /exit 127: a command in this check was not found in the clean verification checkout\. Linked dependency directories from the source: none/)
})
