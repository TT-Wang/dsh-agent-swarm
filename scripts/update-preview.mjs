/**
 * Update an existing isolated preview in place: build this plugin checkout,
 * sync the packaged files into the preview's linked plugin snapshot (keeping
 * its linked node_modules), preflight the composed profile, then restart the
 * preview host on the same port.
 *
 * Two details make the restart survive the process it replaces:
 *   - the worker is spawned detached (POSIX setsid), so it is not in the
 *     process group of the host it stops — launching this script from inside
 *     that host no longer kills the restart half-way;
 *   - bookkeeping is written *before* anything is stopped, so a crashed worker
 *     leaves a recoverable `status: "restarting"` record instead of stale
 *     `pid`/`launch.url` values that point at a dead process.
 *
 * Usage:
 *   node scripts/update-preview.mjs [options]
 *
 * Options:
 *   --preview <dir>   preview root (default: ~/.dsh/agent-swarm-v41)
 *   --plugin <dir>    linked plugin snapshot (default: realpath of <preview>/plugin)
 *   --port <n>        host port (default: port from <preview>/server.json)
 *   --harness <dir>   Harness checkout to boot (default: infer from the running
 *                     host, else resolveHarnessRoot())
 *   --patch <file>    patch overlay (default: <preview>/preview.patch.yml)
 *   --home <dir>      DSH_HOME (default: <preview>/home)
 *   --workspace <dir> host working directory (default: <preview>/workspace)
 *   --skip-build      reuse the current lib/ instead of running npm run build
 *   --no-restart      build, sync and preflight only; never stop the host
 *   --no-sync         the linked plugin IS this checkout: build, preflight and
 *                     restart only; no snapshot copy, no backup
 *   --dry-run         report what would change; write nothing
 *   --delay <ms>      wait before stopping the old host (default: 2000)
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHarnessRoot } from './harness-target.mjs'
import { changedPaths, selectLaunchUrl, summarizePaths } from './preview-log.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
const self = fileURLToPath(import.meta.url)
const args = process.argv.slice(2)
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const flag = name => args.includes(name)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const now = () => new Date().toISOString()
/** Filesystem-safe timestamp for per-restart bookkeeping files. */
const stamp = () => now().replaceAll(':', '-').replaceAll('.', '-')
const fail = message => { process.stderr.write(`update-preview: ${message}\n`); process.exit(1) }

if (flag('--restart-worker')) { await runWorker(value('--state', '')); process.exit(0) }
if (flag('--help') || args.includes('-h')) { process.stdout.write(readFileSync(self, 'utf8').split('*/')[0].split('/**')[1] + '\n'); process.exit(0) }

const preview = resolve(value('--preview', join(homedir(), '.dsh/agent-swarm-v41')))
const dryRun = flag('--dry-run')
const skipBuild = flag('--skip-build')
const noSync = flag('--no-sync')
const noRestart = flag('--no-restart') || dryRun
if (!existsSync(preview)) fail(`preview root does not exist: ${preview}`)
const serverPath = join(preview, 'server.json')
const server = existsSync(serverPath) ? JSON.parse(readFileSync(serverPath, 'utf8')) : {}
// A crashed or interrupted restart leaves status "restarting" with pid null while
// the old host may still be alive and serving. Recover it from previousPid plus
// the store lock, otherwise a retry would start a second host on the same port.
if (server.pid === null || server.pid === undefined) {
  const lockPath = join(preview, 'swarm.sqlite.lock')
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : undefined
  const candidate = Number(server.previousPid)
  if (Number.isInteger(candidate) && candidate > 0 && lock?.pid === candidate) {
    try { process.kill(candidate, 0); server.pid = candidate; server.status = 'running' } catch { /* previous host is gone */ }
  }
}
const pluginDir = noSync ? (args.includes('--plugin') ? resolve(value('--plugin')) : undefined) : resolve(value('--plugin', realpathSync(join(preview, 'plugin'))))
if (pluginDir !== undefined && !existsSync(join(pluginDir, 'package.json'))) fail(`plugin snapshot has no package.json: ${pluginDir}`)
const port = Number(value('--port', server.url ? new URL(server.url).port : '0'))
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('choose a port from 1024 through 65535 with --port')
const patch = resolve(value('--patch', join(preview, 'preview.patch.yml')))
const home = resolve(value('--home', join(preview, 'home')))
const workspace = resolve(value('--workspace', join(preview, 'workspace')))
const logPath = join(preview, 'restart.log')
const log = message => { const line = `[${now()}] ${message}`; if (dryRun) process.stdout.write(line + '\n'); else appendFileSync(logPath, line + '\n') }
const harnessRoot = resolve(args.includes('--harness') ? value('--harness') : (inferHarness(server.pid) ?? resolveHarnessRoot()))
const cli = join(harnessRoot, 'apps/cli/lib/bin.js')
if (!existsSync(cli)) fail(`harness CLI not found: ${cli} (pass --harness <checkout>)`)

/** Prefer the harness the running host was actually booted from. */
function inferHarness(pid) {
  if (!Number.isInteger(pid) || pid < 1) return undefined
  const candidates = []
  try {
    const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find(line => line.startsWith('n'))
    if (cwd) candidates.push(cwd.slice(1))
  } catch { /* lsof unavailable or the process is gone */ }
  try {
    const open = execFileSync('lsof', ['-p', String(pid)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    for (const line of open.split('\n')) { const match = line.match(/(\/[^\s]*?\/deepseek-harness[^/\s]*)\//); if (match) candidates.push(match[1]) }
  } catch { /* the host may already be gone */ }
  for (const candidate of candidates) if (existsSync(join(candidate, 'apps/cli/lib/bin.js'))) return candidate
  return undefined
}

/** Exactly the paths the published tarball carries, so the snapshot mirrors a release. */
function packagedEntries() {
  const manifest = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
  const entries = new Set(['package.json', ...(manifest.files ?? ['lib'])])
  return [...entries]
}
function copyEntries(from, to, entries) {
  for (const relative of entries) {
    const source = join(from, relative), target = join(to, relative)
    if (!existsSync(source)) continue
    const stat = statSync(source)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    if (stat.isDirectory()) cpSync(source, target, { recursive: true })
    else copyFileSync(source, target)
  }
}

// ---------------------------------------------------------------- build
// The sync entry list is known before the build, so the before-summary and the
// built-summary hash exactly the same packaged paths.
const entries = noSync ? [] : packagedEntries()
const before = noSync ? {} : summarizePaths(pluginDir, entries)
if (skipBuild) log('skipping build (--skip-build)')
else {
  log('building plugin from ' + project)
  if (!dryRun) execFileSync('npm', ['run', 'build'], { cwd: project, stdio: 'inherit' })
}
for (const required of ['lib/index.js', 'lib/client.js']) if (!existsSync(join(project, required))) fail(`build did not produce ${required}`)
const built = noSync ? {} : summarizePaths(project, entries)

// ---------------------------------------------------------------- sync
let backup
if (!noSync) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  backup = join(dirname(pluginDir), `plugin.bak-${stamp}`)
  log(`syncing ${entries.length} packaged paths into ${pluginDir}`)
  if (!dryRun) {
    copyEntries(pluginDir, backup, entries)
    copyEntries(project, pluginDir, entries)
    for (const stale of readdirSync(dirname(pluginDir)).filter(name => /^plugin\.bak-/.test(name)).sort().slice(0, -3)) rmSync(join(dirname(pluginDir), stale), { recursive: true, force: true })
  }
} else log('linked checkout (--no-sync): skipping snapshot copy')
const after = noSync ? {} : summarizePaths(pluginDir, entries)
const changed = noSync ? [] : changedPaths(before, built)

// ---------------------------------------------------------------- preflight
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const [key, dir] of [['DSH_AGENTS_HOME', join(preview, 'agents-home')], ['DSH_BUNDLED_SKILL_DIR', join(preview, 'bundled-skills')]]) if (existsSync(dir)) env[key] = dir
delete env.DEEPSEEK_API_KEY
log('preflighting composed profile')
try {
  if (!dryRun) execFileSync(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--dump-config'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
} catch (error) {
  if (!dryRun && existsSync(backup)) { copyEntries(backup, pluginDir, entries); log('preflight failed; snapshot restored from ' + backup) }
  fail(`profile preflight failed: ${String(error.stderr ?? error.message).slice(0, 400)}`)
}

const summary = { preview, plugin: pluginDir, port, harness: harnessRoot, backup: existsSync(backup) ? backup : undefined, changed, before, after, dryRun, restarted: false }
if (noRestart) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); process.exit(0) }

// ---------------------------------------------------------------- restart
// Bookkeeping first: a worker that dies before the new host is up must leave a
// recoverable record, never a stale pid or launch url.
const previousPid = server.pid
if (!dryRun) {
  writeFileSync(serverPath, JSON.stringify({ status: 'restarting', pid: null, previousPid, url: `http://127.0.0.1:${port}`, home, plugin: pluginDir, model: server.model, port, startedAt: now() }, null, 2) + '\n', { mode: 0o600 })
  const statePath = join(preview, `.update-preview-${stamp()}.json`)
  writeFileSync(statePath, JSON.stringify({ preview, pluginDir, backup, entries, port, harnessRoot, cli, patch, home, workspace, previousPid, model: server.model, delayMs: Number(value('--delay', '2000')) }, null, 2) + '\n', { mode: 0o600 })
  const out = openSync(logPath, 'a', 0o600)
  const worker = spawn(process.execPath, [self, '--restart-worker', '--state', statePath], { detached: true, stdio: ['ignore', out, out] })
  worker.unref()
  closeSync(out)
  summary.restarted = true
  summary.workerPid = worker.pid
  summary.state = statePath
  log(`restart worker ${worker.pid} scheduled; old host ${previousPid} will stop in ${Number(value('--delay', '2000'))}ms`)
}
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')

/**
 * Detached half. Runs in its own session so it survives the host it stops.
 * Order: wait, record intent, stop, start, wait for the launch URL, bookkeep.
 * On failure it restores the previous snapshot and tries exactly once more.
 */
async function runWorker(statePath) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const log = message => appendFileSync(join(state.preview, 'restart.log'), `[${now()}] ${message}\n`)
  const env = { ...process.env, DSH_HOME: state.home, DSH_TELEMETRY_DISABLED: '1' }
  for (const [key, dir] of [['DSH_AGENTS_HOME', join(state.preview, 'agents-home')], ['DSH_BUNDLED_SKILL_DIR', join(state.preview, 'bundled-skills')]]) if (existsSync(dir)) env[key] = dir
  delete env.DEEPSEEK_API_KEY
  const serverPath = join(state.preview, 'server.json')
  const launchPath = join(state.preview, 'launch.url')
  const serverLogPath = join(state.preview, 'server.log')
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  // Read as text so the offset is a string offset: it stays stable across
  // appends even when previous log lines contain multibyte characters.
  const logLength = () => { try { return readFileSync(serverLogPath, 'utf8').length } catch { return 0 } }

  const stop = async pid => {
    if (!Number.isInteger(pid) || pid < 1) return
    log(`stopping host ${pid}`)
    try { process.kill(pid, 'SIGTERM') } catch (error) { log(`SIGTERM ${pid}: ${String(error)}`) }
    for (let attempt = 0; attempt < 60; attempt++) { try { process.kill(pid, 0) } catch { return } await sleep(200) }
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    await sleep(1500)
  }
  const start = async () => {
    // Append-only server.log: its length captured before this host is spawned is
    // the only trustworthy boundary between this host's token and every
    // previous host's. Without it, awaitLaunchUrl would immediately return the
    // old token that the log still carries and the link would 401.
    const sinceOffset = logLength()
    const out = openSync(serverLogPath, 'a', 0o600)
    const child = spawn(process.execPath, ['--expose-internals', state.cli, '--profile', 'web', '--patch', state.patch, '--port', String(state.port), '--no-open'], { cwd: state.workspace, env, detached: true, stdio: ['ignore', out, out] })
    child.unref(); closeSync(out)
    log(`started host ${child.pid}`)
    writeFileSync(serverPath, JSON.stringify({ status: 'starting', pid: child.pid, url: `http://127.0.0.1:${state.port}`, home: state.home, plugin: state.pluginDir, model: state.model, port: state.port, startedAt: now() }, null, 2) + '\n', { mode: 0o600 })
    return { child, sinceOffset }
  }
  const awaitLaunchUrl = async (child, sinceOffset) => {
    for (let attempt = 0; attempt < 450; attempt++) {
      await sleep(200)
      try {
        const found = selectLaunchUrl(readFileSync(serverLogPath, 'utf8'), sinceOffset, state.port)
        if (found) { writeFileSync(launchPath, found + '\n', { mode: 0o600 }); return found }
      } catch { /* the log may not exist yet */ }
      try { process.kill(child.pid, 0) } catch { return undefined }
    }
    return undefined
  }
  const commit = (child, launchUrl) => writeFileSync(serverPath, JSON.stringify({ status: 'running', pid: child.pid, url: `http://127.0.0.1:${state.port}`, home: state.home, plugin: state.pluginDir, model: state.model, port: state.port, startedAt: now(), launchUrl }, null, 2) + '\n', { mode: 0o600 })

  try {
    await sleep(state.delayMs)
    await stop(state.previousPid)
    let { child, sinceOffset } = await start()
    let url = await awaitLaunchUrl(child, sinceOffset)
    if (!url) {
      log('new host did not publish a launch url; rolling back the plugin snapshot')
      await stop(child.pid)
      if (state.backup && existsSync(state.backup)) {
        for (const relative of state.entries) {
          const source = join(state.backup, relative), target = join(state.pluginDir, relative)
          if (!existsSync(source)) continue
          rmSync(target, { recursive: true, force: true }); mkdirSync(dirname(target), { recursive: true })
          if (statSync(source).isDirectory()) cpSync(source, target, { recursive: true }); else copyFileSync(source, target)
        }
      }
      // A fresh offset for the retry: the first host's token, if it ever
      // printed one, must not be mistaken for the retried host's.
      ;({ child, sinceOffset } = await start())
      url = await awaitLaunchUrl(child, sinceOffset)
    }
    if (url) { commit(child, url); log(`restart complete: ${url}`) }
    else { writeFileSync(serverPath, JSON.stringify({ status: 'failed', pid: null, previousPid: state.previousPid, url: `http://127.0.0.1:${state.port}`, home: state.home, plugin: state.pluginDir, port: state.port, startedAt: now() }, null, 2) + '\n', { mode: 0o600 }); log('restart failed: inspect server.log; snapshot backup at ' + state.backup) }
  } catch (error) {
    log(`restart worker error: ${String(error && error.stack ? error.stack : error)}`)
  } finally {
    rmSync(statePath, { force: true })
  }
}
