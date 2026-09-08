import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
import { assertSandboxPrerequisite } from './sandbox-prerequisite.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const harnessRoot = resolveHarnessRoot()
const bin = join(harnessRoot, 'apps/cli/lib/bin.js')
await access(bin)
const home = await realpath(await mkdtemp(join(tmpdir(), 'dsh-swarm-profile-')))
const profileDir = join(home, 'profiles', 'headless')
const env = {
  ...process.env,
  DSH_HOME: home,
  DSH_TELEMETRY_DISABLED: '1',
  COREPACK_ENABLE_NETWORK: '0',
  npm_config_registry: 'http://127.0.0.1:9',
}
try {
  const compatibility = JSON.parse(await readFile(join(project, 'compatibility.json'), 'utf8'))
  const head = (await execute('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot })).stdout.trim()
  assertSupportedHarness(harnessRoot)
  const manifest = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'))
  // link: consumes the already-built local plugin and its pinned local peers.
  // --offline plus a closed registry endpoint prevents accidental registry fallback.
  await execute(process.execPath, [
    bin, 'plugin', '--profile', 'headless', 'add', `link:${project}`,
    '--offline', '--ignore-scripts', '--store-dir', join(home, 'pnpm-store'),
  ], { cwd: project, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert(Object.hasOwn(profile.dependencies, manifest.name), 'actual CLI plugin add must install the package by its declared name')
  assert.deepEqual(profile.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', manifest.name], 'actual CLI reconciliation must append the installed bundle')
  assert.equal(await realpath(join(profileDir, 'node_modules', manifest.name)), await realpath(project), 'profile must resolve the intended local plugin')
  const settings = await readFile(join(profileDir, 'pnpm-workspace.yaml'), 'utf8')
  assert(settings.includes('autoInstallPeers: false'), 'profile must retain Harness peer sharing')
  const dump = await execute(process.execPath, [bin, '--profile', 'headless', '--dump-config'], {
    cwd: project, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  })
  assert(dump.stdout.includes(`name: '${manifest.name}'`), 'dump-config must compose the installed swarm row')
  assert(dump.stdout.includes('dsh-external-agent-swarm'), 'dump-config must preserve the shipped bundle entry identity')
  assert(dump.stdout.includes('@deepseek-ai/dsh-agent-loop'), 'profile must retain its real Harness base composition')
  await assertSandboxPrerequisite('npm run test:profile')
  const run = await execute(process.execPath, [
    '--expose-internals', join(project, 'tests/harness-composition.mjs'),
    '--artifact', project, '--harness', harnessRoot, '--bundle-profile', profileDir,
  ], { cwd: home, env, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
  process.stdout.write(run.stdout)
  process.stderr.write(run.stderr)
  process.stdout.write('Real dsh CLI profile smoke passed: offline local plugin add, installed bundle reconciliation, composed config dump, and full Loader lifecycle through the installed bundle.\n')
} finally {
  await rm(home, { recursive: true, force: true })
}
