/**
 * Provision (or restart) an isolated "lab" host that runs this plugin checkout
 * directly, so the improvement loop can mount a new build without touching the
 * controller host that serves the user's session.
 *
 * Isolation: its own DSH_HOME, agents home, bundled-skill dir, swarm state DB,
 * worktree root and port. The plugin is linked with `link:` from --plugin
 * (default: this checkout), so `npm run build` + a restart mounts new code.
 *
 * Usage:
 *   node scripts/start-lab.mjs [options]
 *
 * Options:
 *   --root <dir>       lab root (default: ~/.dsh/agent-swarm-lab)
 *   --port <n>         host port (default: 5292)
 *   --plugin <dir>     plugin checkout to link (default: this repository)
 *   --harness <dir>    Harness checkout to boot (default: resolveHarnessRoot())
 *   --no-start         provision only; never launch the host
 *   --dry-run          print the plan; write nothing
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, chmodSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { resolveHarnessRoot } from './harness-target.mjs'
import { importHarness } from '../tests/fixtures/built-harness.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const flag = name => args.includes(name)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const fail = message => { process.stderr.write(`start-lab: ${message}\n`); process.exit(1) }

if (flag('--help') || args.includes('-h')) { process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].slice(3) + '\n'); process.exit(0) }
const dryRun = flag('--dry-run')
const noStart = flag('--no-start') || dryRun
const root = resolve(value('--root', join(homedir(), '.dsh/agent-swarm-lab')))
const port = Number(value('--port', '5292'))
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('choose a port from 1024 through 65535')
const plugin = resolve(value('--plugin', project))
if (!existsSync(join(plugin, 'package.json'))) fail(`plugin checkout has no package.json: ${plugin}`)
const harnessRoot = resolve(args.includes('--harness') ? value('--harness') : resolveHarnessRoot())
const cli = join(harnessRoot, 'apps/cli/lib/bin.js')
if (!existsSync(cli)) fail(`harness CLI not found: ${cli}`)

const home = join(root, 'home')
const workspace = join(root, 'workspace')
const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents-home'), DSH_BUNDLED_SKILL_DIR: join(root, 'bundled-skills'), DSH_TELEMETRY_DISABLED: '1' }
const patch = join(root, 'lab.patch.yml')
const serverPath = join(root, 'server.json')
const logPath = join(root, 'server.log')
const log = message => { const line = `[${new Date().toISOString()}] ${message}\n`; if (dryRun) process.stdout.write(line); else appendFileSync(join(root, 'lab.log'), line) }

const plan = { root, port, plugin, harness: harnessRoot, home, workspace, patch, serverPath }
if (dryRun) { process.stdout.write(JSON.stringify({ ...plan, dryRun: true }, null, 2) + '\n'); process.exit(0) }

// ---------------------------------------------------------------- provision
mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700)
for (const dir of [home, workspace, join(root, 'agents-home'), join(root, 'bundled-skills'), join(root, 'worktrees')]) mkdirSync(dir, { recursive: true, mode: 0o700 })
log(`provisioning lab at ${root} (plugin ${plugin})`)

// Credentials are seeded once through the native provider, like start-preview.
const credentials = join(home, '.credentials.yaml')
if (!existsSync(credentials)) {
  const config = parseEnv(readFileSync(resolve(value('--env', join(homedir(), '.dsh/.env'))), 'utf8'))
  if (!config.DEEPSEEK_API_KEY) fail('DeepSeek credential is unavailable; set DEEPSEEK_API_KEY in ~/.dsh/.env')
  const { Context } = await importHarness(harnessRoot, '@deepseek-ai/cordis')
  const { LocalCredentialProvider } = await importHarness(harnessRoot, '@deepseek-ai/dsh-credentials-local')
  const { credentialRef } = await importHarness(harnessRoot, '@deepseek-ai/dsh-credentials')
  const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await importHarness(harnessRoot, '@deepseek-ai/dsh-launch-environment')
  const host = new Context()
  host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
  try {
    await host.plugin(LocalCredentialProvider, { path: credentials, watch: false })
    await host.credentials.set(credentialRef('DEEPSEEK_API_KEY'), config.DEEPSEEK_API_KEY)
  } finally { await host.fiber.dispose() }
  log('seeded lab credentials')
}

// Link the plugin checkout into the lab profile (idempotent).
const profileManifest = join(home, 'profiles/web/package.json')
const alreadyLinked = existsSync(profileManifest) && readFileSync(profileManifest, 'utf8').includes(`link:${plugin}`)
if (!alreadyLinked) {
  log(`linking ${plugin} into the lab web profile`)
  execFileSync(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', `link:${plugin}`, '--offline', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store')], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 })
}

// Isolated state: never share the controller's swarm DB or worktrees.
const patchBody = [
  { id: 'directory-picker', disabled: true },
  { id: 'dsh-external-agent-swarm', config: { statePath: join(root, 'swarm.sqlite'), workspacesRoot: join(root, 'worktrees') } },
  { id: 'llm-deepseek', config: { models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'deepseek-v4.1-flash-expires-on-0910', name: 'DeepSeek-V4.1-Flash (preview, expires 09-10)' },
  ] } },
  { insert: [
    { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
    { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
  ] },
]
writeFileSync(patch, JSON.stringify(patchBody, null, 2) + '\n', { mode: 0o600 })

// A tiny git workspace keeps smoke tasks self-contained.
if (!existsSync(join(workspace, '.git'))) {
  writeFileSync(join(workspace, 'value.cjs'), 'module.exports = 1\n')
  writeFileSync(join(workspace, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2); console.log('VERIFIED_TWO')\n")
  for (const command of [['init', '--quiet'], ['config', 'user.name', 'Swarm Lab'], ['config', 'user.email', 'swarm-lab@example.invalid'], ['add', '.'], ['commit', '--quiet', '-m', 'Lab baseline']]) execFileSync('git', command, { cwd: workspace })
}

// ---------------------------------------------------------------- restart
const previous = existsSync(serverPath) ? JSON.parse(readFileSync(serverPath, 'utf8')) : {}
if (Number.isInteger(previous.pid) && previous.pid > 1) {
  log(`stopping previous lab host ${previous.pid}`)
  try { process.kill(previous.pid, 'SIGTERM') } catch { /* already gone */ }
  for (let attempt = 0; attempt < 50; attempt++) { try { process.kill(previous.pid, 0) } catch { break } await sleep(200) }
  try { process.kill(previous.pid, 'SIGKILL') } catch { /* already gone */ }
  await sleep(1200)
}
if (noStart) { process.stdout.write(JSON.stringify({ ...plan, started: false }, null, 2) + '\n'); process.exit(0) }

writeFileSync(serverPath, JSON.stringify({ status: 'starting', pid: null, url: `http://127.0.0.1:${port}`, root, home, plugin, port, startedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 })
const out = openSync(logPath, 'a', 0o600)
const child = spawn(process.execPath, ['--expose-internals', cli, '--profile', 'web', '--patch', patch, '--port', String(port), '--no-open'], { cwd: workspace, env, detached: true, stdio: ['ignore', out, out] })
child.unref(); closeSync(out)
log(`started lab host ${child.pid} on ${port}`)
let launchUrl
for (let attempt = 0; attempt < 450; attempt++) {
  await sleep(200)
  try { launchUrl = readFileSync(logPath, 'utf8').match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[A-Za-z0-9_.-]+`, 'g'))?.at(-1) } catch { /* log not ready */ }
  if (launchUrl) break
  try { process.kill(child.pid, 0) } catch { fail(`lab host exited early; inspect ${logPath}`) }
}
if (!launchUrl) fail(`lab host did not publish a launch url; inspect ${logPath}`)
writeFileSync(join(root, 'launch.url'), launchUrl + '\n', { mode: 0o600 })
writeFileSync(serverPath, JSON.stringify({ status: 'running', pid: child.pid, url: `http://127.0.0.1:${port}`, root, home, plugin, port, startedAt: new Date().toISOString(), launchUrl }, null, 2) + '\n', { mode: 0o600 })
process.stdout.write(JSON.stringify({ ...plan, started: true, pid: child.pid, launchUrl }, null, 2) + '\n')
