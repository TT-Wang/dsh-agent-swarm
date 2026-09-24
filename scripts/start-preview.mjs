/** Start an isolated, persistent preview from a fixed built plugin snapshot. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
import { importHarness, linkHarnessPeers } from '../tests/fixtures/built-harness.mjs'
import { awaitLaunchUrl, hostEnv, startHost, writeServer } from './host.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const harnessRoot = resolveHarnessRoot()
const host = assertSupportedHarness(harnessRoot)
const port = Number(value('--port', '5190'))
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a local port from 1024 through 65535')
const preview = resolve(value('--root', join(homedir(), '.dsh/agent-swarm-preview-v040')))
// A fixed copy prevents subsequent development relinks from changing a running host.
if (existsSync(join(preview, 'server.json')) || existsSync(join(preview, 'plugin'))) throw new Error('Preview already exists; choose a new --root to preserve its state')
mkdirSync(preview, { recursive: true, mode: 0o700 })
chmodSync(preview, 0o700)
const config = parseEnv(readFileSync(resolve(value('--env', join(homedir(), '.dsh/.env'))), 'utf8'))
const apiKey = config.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY
if (!apiKey) throw new Error('DeepSeek credential is unavailable')
for (const dir of ['home', 'agents-home', 'bundled-skills']) mkdirSync(join(preview, dir), { recursive: true, mode: 0o700 })
const env = hostEnv(preview)
if (config.DEEPSEEK_BASE_URL) env.DEEPSEEK_BASE_URL = config.DEEPSEEK_BASE_URL
// Seed this new preview through the native provider, so later restarts do not depend on
// inheriting a transient shell variable. The caller's home and credentials are untouched.
const { Context } = await importHarness(harnessRoot, '@deepseek-ai/cordis')
const { LocalCredentialProvider } = await importHarness(harnessRoot, '@deepseek-ai/dsh-credentials-local')
const { credentialRef } = await importHarness(harnessRoot, '@deepseek-ai/dsh-credentials')
const { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } = await importHarness(harnessRoot, '@deepseek-ai/dsh-launch-environment')
const credentialHost = new Context()
credentialHost.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([]))
try {
  await credentialHost.plugin(LocalCredentialProvider, { path: join(env.DSH_HOME, '.credentials.yaml'), watch: false })
  await credentialHost.credentials.set(credentialRef('DEEPSEEK_API_KEY'), apiKey)
} finally { await credentialHost.fiber.dispose() }
const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', preview], { cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0]
const plugin = join(preview, 'plugin')
mkdirSync(plugin)
execFileSync('tar', ['-xzf', join(preview, packed.filename), '--strip-components=1', '-C', plugin])
await linkHarnessPeers(plugin, harnessRoot)
const workspace = join(preview, 'workspace')
mkdirSync(workspace)
writeFileSync(join(workspace, 'value.cjs'), 'module.exports = 1\n')
writeFileSync(join(workspace, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2); console.log('VERIFIED_TWO')\n")
for (const command of [['init', '--quiet'], ['config', 'user.name', 'Swarm Preview'], ['config', 'user.email', 'swarm-preview@example.invalid'], ['add', '.'], ['commit', '--quiet', '-m', 'Preview baseline']]) execFileSync('git', command, { cwd: workspace })
const cli = join(harnessRoot, 'apps/cli/lib/bin.js')
execFileSync(process.execPath, [cli, 'plugin', '--profile', 'web', 'add', `link:${plugin}`, '--offline', '--ignore-scripts', '--store-dir', join(preview, 'pnpm-store')], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 })
const patch = join(preview, 'preview.patch.yml')
writeFileSync(patch, JSON.stringify([
  { id: 'directory-picker', disabled: true },
  { id: 'dsh-external-agent-swarm', config: { statePath: join(preview, 'swarm.sqlite'), workspacesRoot: join(preview, 'worktrees') } },
  { insert: [{ id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' }, { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' }] },
], null, 2) + '\n', { mode: 0o600 })
const logPath = join(preview, 'server.log')
const child = startHost({ root: preview, port, cli, patch, cwd: workspace, env })
const manifest = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8'))
const server = { pid: child.pid, url: `http://127.0.0.1:${port}`, port, workspace, plugin, harness: harnessRoot, packageVersion: manifest.version, harnessVersion: host.version, harnessCommit: host.commit, tarballIntegrity: packed.integrity, startedAt: new Date().toISOString() }
writeServer(preview, server)
if (!await awaitLaunchUrl({ root: preview, port, child, timeoutMs: 90_000 })) throw new Error(child.exitCode === null && child.signalCode === null ? `Preview is still starting; inspect private log ${logPath}` : `Preview exited; inspect private log ${logPath}`)
writeFileSync(join(preview, 'TRY.md'), `# Agent Swarm v${manifest.version} 试用\n\nHarness ${host.version} (${host.commit})。\n\n用本目录的 launch.url 原生登录地址打开；认证后地址自动变为 ${server.url}。新浏览器需重新通过原生登录地址建立 Cookie。\n\n选择工作区 \`${workspace}\`，然后发送一次：\n\n\`\`\`text\n/agent-swarm 把 value.cjs 改为导出 2，不要修改 check.cjs。运行 node check.cjs，并安排独立审查。\n\`\`\`\n\n主 agent 自行选择预算、分工和检查策略。右侧栏显示进展。独立工作区中的成果提交保留待审查，原工作目录仍为基线。\n`, { mode: 0o600 })
process.stdout.write(JSON.stringify({ ...server, launchUrlFile: join(preview, 'launch.url'), guidance: join(preview, 'TRY.md') }, null, 2) + '\n')
