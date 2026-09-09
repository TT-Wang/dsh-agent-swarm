/**
 * R11-13 regression: a declared check cannot read uncommitted source state
 * through the materialised dependency directory. The effective default is a
 * copy, so `node_modules/..` resolves inside the disposable checkout; the
 * read-through link is only used with the explicit unsafe opt-in.
 *
 * Pre-fix head: the default was a symlink to the source directory, so
 * `cat node_modules/../UNCOMMITTED.txt` printed the source's uncommitted file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}

/** A real (not symlinked) gitignored dependency directory plus an uncommitted source file. */
async function fixture(t, options = {}) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-dep-link-')))
  const source = path.join(temp, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, '.gitignore'), 'node_modules/\n')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'fixture baseline')
  await mkdir(path.join(source, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(path.join(source, 'node_modules', 'pkg', 'file.txt'), 'toolchain\n')
  const workspaces = new Workspaces({ workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000,
    confineCheck: argv => argv, ...options })
  const mission = { id: 'mission-dep', workspace: source }
  const member = { id: 'member-dep', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-dep') }
  const task = { id: 'task-dep', missionId: mission.id, epoch: 1, title: 'Dependency link', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), 'member work\n')
  const artifact = await workspaces.captureArtifact(member, task)
  // Uncommitted host state created AFTER the artifact was captured: it is not in
  // the baseline snapshot, the artifact commit or the verification checkout, so
  // only a read-through link can expose it.
  await writeFile(path.join(source, 'UNCOMMITTED.txt'), 'SECRET-SOURCE-STATE\n')
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, workspaces, member, task, artifact }
}

const runCheck = async (f, check) => (await f.workspaces.verifyArtifact(f.member, { ...f.task, checks: [check] }, f.artifact))[0]

test('R11-13: the default materialisation is a copy, so a check cannot read the source through the dependency directory', async t => {
  const f = await fixture(t)
  const direct = await runCheck(f, 'cat node_modules/../UNCOMMITTED.txt')
  assert.notEqual(direct.exitCode, 0, 'node_modules/.. must resolve inside the checkout, not the source')
  assert.doesNotMatch(direct.output, /SECRET-SOURCE-STATE/, 'the uncommitted source file is not readable')
  const nested = await runCheck(f, 'cat node_modules/pkg/../../UNCOMMITTED.txt')
  assert.notEqual(nested.exitCode, 0, 'node_modules/pkg/../.. must not escape through a copied entry either')
  assert.doesNotMatch(nested.output, /SECRET-SOURCE-STATE/)
  const toolchain = await runCheck(f, 'cat node_modules/pkg/file.txt')
  assert.equal(toolchain.exitCode, 0, 'the copied toolchain is still available to the check')
  assert.match(toolchain.output, /toolchain/, 'the dependency content is materialised')
  // The source is untouched: the ignored directory is still a real directory and
  // the uncommitted file is still there for the human owner.
  assert.equal(await readFile(path.join(f.source, 'UNCOMMITTED.txt'), 'utf8'), 'SECRET-SOURCE-STATE\n')
  assert.equal((await readFile(path.join(f.source, 'node_modules', 'pkg', 'file.txt'), 'utf8')), 'toolchain\n')
})

test('R11-13: a configured link mode without the explicit opt-in still copies', async t => {
  // This is exactly the value src/index.ts Config supplies in production.
  const f = await fixture(t, { verificationDependencyMode: 'link' })
  const direct = await runCheck(f, 'cat node_modules/../UNCOMMITTED.txt')
  assert.notEqual(direct.exitCode, 0, 'the production link value is not enough to expose the source')
  assert.doesNotMatch(direct.output, /SECRET-SOURCE-STATE/)
  assert.equal((await runCheck(f, 'cat node_modules/pkg/file.txt')).exitCode, 0)
})

test('R11-13: the explicit unsafe opt-in reproduces the read-through channel (documented residual)', async t => {
  const f = await fixture(t, { verificationDependencyMode: 'link', allowDependencyLinkReads: true })
  const direct = await runCheck(f, 'cat node_modules/../UNCOMMITTED.txt')
  assert.equal(direct.exitCode, 0, 'the opt-in link reads through to the source')
  assert.match(direct.output, /SECRET-SOURCE-STATE/)
  assert.equal((await runCheck(f, 'cat node_modules/pkg/file.txt')).exitCode, 0)
})
