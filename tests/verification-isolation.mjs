/**
 * HOST-ONLY isolation proof (D7 / F-C2 / F-29) — `npm run test:isolation`.
 *
 * This suite is deliberately NOT part of `tests/*.test.mjs`: a worker session
 * already runs inside a workspace-write sandbox, where macOS refuses a nested
 * `sandbox_apply` (`sandbox-exec: sandbox_apply: Operation not permitted`), so
 * the real boundary can only be proven on the host that runs the gate. It
 * requires a built supported Harness checkout (tier B) for the real
 * `@deepseek-ai/dsh-sandbox-local` provider.
 *
 * It proves the documented boundary, not a green path:
 * - every declared check is wrapped by `confinedCheckArgv` (the production
 *   `src/harness-workers.ts` path) and is refused unless the host reports FULL
 *   enforcement (F-29);
 * - a check that writes to an absolute path in the source checkout is refused;
 * - the default `verificationDependencyMode: 'copy'` materialises a private
 *   directory, so a check reads the copied toolchain and cannot read the source
 *   through `node_modules/..` (R11-13);
 * - the explicit `verificationDependencyMode: 'link'` + `allowDependencyLinkReads`
 *   opt-in reads the source toolchain, but a write through that link resolves
 *   into the source and is refused by the full-enforcement sandbox (F-C2);
 * - a check may still write inside its own verification checkout;
 * - `copy` mode isolates the write without relying on the sandbox.
 *
 * The fixture lives under `$HOME`, never under `/tmp` or the per-user temp dir:
 * `workspace-write` grants those temp areas (DSH `writableRoots`), so a source
 * checkout placed there would be writable by design.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { confinedCheckArgv } from '../lib/harness-workers.js'
import { resolveHarnessRoot, assertSupportedHarness } from '../scripts/harness-target.mjs'
import { importHarness } from './fixtures/built-harness.mjs'

const harnessRoot = resolveHarnessRoot(undefined)
assertSupportedHarness(harnessRoot)
const { Context } = await importHarness(harnessRoot, '@deepseek-ai/cordis')
const { default: LocalSandboxProvider } = await importHarness(harnessRoot, '@deepseek-ai/dsh-sandbox-local')
const ctx = new Context()
await ctx.plugin(LocalSandboxProvider, {})
const sandbox = ctx.get('sandbox')
assert.ok(sandbox, 'the Harness sandbox provider did not register')
/** The exact production wrapping: full enforcement or the check does not run. */
const confineCheck = (argv, cwd) => confinedCheckArgv(sandbox, argv, cwd)
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const exists = async file => await lstat(file).then(() => true, () => false)
const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Isolation', '-c', 'user.email=isolation@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}
async function fixture(t, options = {}) {
  const scratch = await realpath(await mkdtemp(path.join(homedir(), '.dsh-swarm-isolation-')))
  const tempRoot = await realpath(tmpdir())
  assert.ok(!scratch.startsWith(tempRoot + path.sep) && scratch !== tempRoot && !scratch.startsWith('/tmp/') && scratch !== '/tmp',
    `the isolation fixture must live outside the sandbox-granted temp areas (set HOME to a non-temp directory): ${scratch}`)
  const source = path.join(scratch, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, '.gitignore'), 'node_modules/\n')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  // An installed, ignored toolchain the check reads through the dependency link.
  await mkdir(path.join(source, 'node_modules', 'dep'), { recursive: true })
  await writeFile(path.join(source, 'node_modules', 'dep', 'tool.txt'), 'toolchain\n')
  const workspaces = new Workspaces({ workspacesRoot: path.join(scratch, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck, ...options })
  const mission = { id: 'mission-isolation', workspace: source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Isolation proof', kind: 'implementation', scope: ['**'], checks: [], status: 'running' }
  t.after(async () => { await workspaces.dispose(); await rm(scratch, { recursive: true, force: true }) })
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), '42\n')
  const artifact = await workspaces.captureArtifact(member, task)
  return { scratch, source, workspaces, member, task, artifact }
}
const runCheck = async (workspaces, member, task, artifact, command) => {
  const results = await workspaces.verifyArtifact(member, { ...task, checks: [command] }, artifact)
  assert.equal(results.length, 1, JSON.stringify(results))
  return results[0]
}

test('host prerequisite: the real provider fully enforces workspace-write', async t => {
  const scratch = await realpath(await mkdtemp(path.join(homedir(), '.dsh-swarm-isolation-probe-')))
  t.after(async () => { await rm(scratch, { recursive: true, force: true }) })
  // confinedCheckArgv is the production path: it throws unless the host
  // reports full enforcement, so reaching runProcess proves enforcement.
  const argv = confinedCheckArgv(sandbox, ['/bin/sh', '-c', 'true'], scratch)
  const probe = await runProcess(argv, { cwd: scratch, timeoutMs: 30000, maxBytes: 32000 })
  assert.equal(probe.exitCode, 0, `the host cannot apply the real sandbox (nested-sandbox worker hosts are excluded by design): ${probe.output}`)
})

test('a verification check cannot write into the source checkout', async t => {
  const { source, workspaces, member, task, artifact } = await fixture(t)
  const sentinel = path.join(source, 'outside-sentinel')
  const result = await runCheck(workspaces, member, task, artifact, `touch ${quote(sentinel)}`)
  assert.notEqual(result.exitCode, 0, `the out-of-workspace write must be refused: ${JSON.stringify(result)}`)
  assert.equal(await exists(sentinel), false, 'the refused write left no file in the source checkout')
})

test('the default copy mode reads the toolchain but not uncommitted source state through node_modules/..', async t => {
  const { source, workspaces, member, task, artifact } = await fixture(t)
  const read = await runCheck(workspaces, member, task, artifact, 'test -d node_modules && test ! -L node_modules && cat node_modules/dep/tool.txt && echo private-copy-ok')
  assert.equal(read.exitCode, 0, JSON.stringify(read))
  assert.match(read.output, /toolchain/)
  assert.match(read.output, /private-copy-ok/)
  // Uncommitted source state created after the artifact was captured is not in
  // the checkout, and the copied dependency directory cannot point at the source.
  await writeFile(path.join(source, 'UNCOMMITTED.txt'), 'SECRET-SOURCE-STATE\n')
  const escape = await runCheck(workspaces, member, task, artifact, 'cat node_modules/../UNCOMMITTED.txt')
  assert.notEqual(escape.exitCode, 0, `the source read must fail closed: ${JSON.stringify(escape)}`)
  assert.doesNotMatch(escape.output, /SECRET-SOURCE-STATE/)
})

test('the explicit link opt-in reads the source toolchain but cannot write through it', async t => {
  const { source, workspaces, member, task, artifact } = await fixture(t, { verificationDependencyMode: 'link', allowDependencyLinkReads: true })
  const read = await runCheck(workspaces, member, task, artifact, 'test -L node_modules && cat node_modules/dep/tool.txt && echo read-through-ok')
  assert.equal(read.exitCode, 0, JSON.stringify(read))
  assert.match(read.output, /toolchain/)
  assert.match(read.output, /read-through-ok/)
  const escaped = path.join(source, 'node_modules', 'dep', 'escaped-sentinel')
  const write = await runCheck(workspaces, member, task, artifact, 'touch node_modules/dep/escaped-sentinel')
  assert.notEqual(write.exitCode, 0, `a write through the link resolves into the source and must be refused: ${JSON.stringify(write)}`)
  assert.equal(await exists(escaped), false, 'the source toolchain was not modified through the link')
})

test('a check may still write inside its own verification checkout', async t => {
  const { workspaces, member, task, artifact } = await fixture(t)
  const result = await runCheck(workspaces, member, task, artifact, 'echo local > local-sentinel && test -f local-sentinel && echo local-write-ok')
  assert.equal(result.exitCode, 0, JSON.stringify(result))
  assert.match(result.output, /local-write-ok/)
})

test('copy mode isolates a dependency-directory write without relying on the sandbox', async t => {
  const { source, workspaces, member, task, artifact } = await fixture(t, { verificationDependencyMode: 'copy' })
  const result = await runCheck(workspaces, member, task, artifact, 'echo changed > node_modules/dep/tool.txt && cat node_modules/dep/tool.txt')
  assert.equal(result.exitCode, 0, JSON.stringify(result))
  assert.match(result.output, /changed/)
  assert.equal(await readFile(path.join(source, 'node_modules', 'dep', 'tool.txt'), 'utf8'), 'toolchain\n', 'the source toolchain is untouched in copy mode')
})
