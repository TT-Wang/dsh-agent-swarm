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
 *   - the host is the preview's own dsh host listening on the port
 *     (scripts/host.mjs), never a recorded pid: a host restarted by hand is
 *     still the one stopped, and the new host starts only once the port is
 *     free. Any other listener (another program, another root's host) is
 *     refused by pid and command line, here before the build and again in the
 *     worker right before it signals, and is never stopped.
 *
 * Usage:
 *   node scripts/update-preview.mjs [options]
 *
 * Options:
 *   --preview <dir>   preview root (default: ~/.dsh/agent-swarm-v41)
 *   --plugin <dir>    linked plugin snapshot (default: realpath of <preview>/plugin)
 *   --port <n>        host port (default: port from <preview>/server.json)
 *   --harness <dir>   Harness checkout to boot (default: the one recorded in
 *                     <preview>/server.json; required once for a preview whose
 *                     record predates it)
 *   --patch <file>    patch overlay (default: <preview>/preview.patch.yml)
 *   --home <dir>      DSH_HOME (default: <preview>/home)
 *   --workspace <dir> host working directory (default: <preview>/workspace)
 *   --skip-build      reuse the current lib/ instead of running npm run build
 *   --no-restart      build, sync and preflight only; never stop the host
 *   --no-sync         the linked plugin IS this checkout: build, preflight and
 *                     restart only; no snapshot copy, no backup
 *   --dry-run         report what would change; write nothing
 *   --delay <ms>      wait before stopping the old host (default: 2000)
 *   --launch-timeout-ms <ms>
 *                     how long the detached worker waits for the new host to
 *                     publish its launch URL before it rolls the snapshot back
 *                     (default 300000). The first release's fixed 90s window
 *                     mis-read a loaded machine's slow boot as a failure: it
 *                     rolled a working snapshot back and left server.json
 *                     "failed" while the host was still booting and later
 *                     published its URL.
 */
import { cpSync, copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { awaitLaunchUrl, findHost, hostEnv, readServer, startHost, stopHost, writeServer } from './host.mjs'
import { changedPaths, summarizePaths } from './preview-log.mjs'

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
const server = readServer(preview) ?? {}
const pluginDir = noSync ? (args.includes('--plugin') ? resolve(value('--plugin')) : undefined) : resolve(value('--plugin', realpathSync(join(preview, 'plugin'))))
if (pluginDir !== undefined && !existsSync(join(pluginDir, 'package.json'))) fail(`plugin snapshot has no package.json: ${pluginDir}`)
const port = Number(value('--port', server.url ? new URL(server.url).port : '0'))
if (!Number.isInteger(port) || port < 1024 || port > 65535) fail('choose a port from 1024 through 65535 with --port')
// The host this update replaces must be this preview's own before anything is built or synced.
let oldHost
if (!noRestart) try { oldHost = findHost(port, preview) } catch (error) { fail(error.message) }
const patch = resolve(value('--patch', join(preview, 'preview.patch.yml')))
const home = resolve(value('--home', join(preview, 'home')))
const workspace = resolve(value('--workspace', join(preview, 'workspace')))
const logPath = join(preview, 'restart.log')
const log = message => { const line = `[${now()}] ${message}`; if (dryRun) process.stdout.write(line + '\n'); else appendFileSync(logPath, line + '\n') }
const recordedHarness = args.includes('--harness') ? value('--harness') : server.harness
if (!recordedHarness) fail(`${join(preview, 'server.json')} does not record the Harness this preview boots; pass --harness <checkout> once (it is recorded from then on)`)
const harnessRoot = resolve(recordedHarness)
const cli = join(harnessRoot, 'apps/cli/lib/bin.js')
if (!existsSync(cli)) fail(`harness CLI not found: ${cli} (pass --harness <checkout>)`)

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
log('preflighting composed profile')
try {
  if (!dryRun) execFileSync(process.execPath, [cli, '--profile', 'web', '--patch', patch, '--dump-config'], { cwd: workspace, env: hostEnv(preview, home), stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 })
} catch (error) {
  if (!dryRun && existsSync(backup)) { copyEntries(backup, pluginDir, entries); log('preflight failed; snapshot restored from ' + backup) }
  fail(`profile preflight failed: ${String(error.stderr ?? error.message).slice(0, 400)}`)
}

const summary = { preview, plugin: pluginDir, port, harness: harnessRoot, backup: existsSync(backup) ? backup : undefined, changed, before, after, dryRun, restarted: false }
if (noRestart) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); process.exit(0) }

// ---------------------------------------------------------------- restart
// The worker looks the host up again when it runs, so nothing here records a
// pid; the lookup above only names that host in the log.
if (!dryRun) {
  writeServer(preview, { status: 'restarting', url: `http://127.0.0.1:${port}`, port, home, plugin: pluginDir, harness: harnessRoot, model: server.model, startedAt: now() })
  const statePath = join(preview, `.update-preview-${stamp()}.json`)
  writeFileSync(statePath, JSON.stringify({ preview, pluginDir, backup, entries, port, harnessRoot, cli, patch, home, workspace, model: server.model, delayMs: Number(value('--delay', '2000')), launchTimeoutMs: Number(value('--launch-timeout-ms', '300000')) }, null, 2) + '\n', { mode: 0o600 })
  const out = openSync(logPath, 'a', 0o600)
  const worker = spawn(process.execPath, [self, '--restart-worker', '--state', statePath], { detached: true, stdio: ['ignore', out, out] })
  worker.unref()
  closeSync(out)
  summary.restarted = true
  summary.workerPid = worker.pid
  summary.state = statePath
  log(`restart worker ${worker.pid} scheduled; old host ${oldHost?.pid ?? 'none'} will stop in ${Number(value('--delay', '2000'))}ms`)
}
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')

/**
 * Detached half. Runs in its own session so it survives the host it stops.
 * Order: wait, stop this preview's host on the port, start, wait for the launch
 * URL, bookkeep.
 * On failure it restores the previous snapshot and tries exactly once more.
 */
async function runWorker(statePath) {
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const log = message => appendFileSync(join(state.preview, 'restart.log'), `[${now()}] ${message}\n`)
  const record = fields => writeServer(state.preview, { url: `http://127.0.0.1:${state.port}`, port: state.port, home: state.home, plugin: state.pluginDir, harness: state.harnessRoot, model: state.model, startedAt: now(), ...fields })
  const host = { root: state.preview, port: state.port, cli: state.cli, patch: state.patch, cwd: state.workspace, env: hostEnv(state.preview, state.home) }
  const stop = () => stopHost(state.port, state.preview, { onStop: pid => log(`stopping host ${pid}`) })
  // A loaded host (this machine runs the preview AND the agent session that
  // deploys it) can take minutes to print its launch URL. Waiting too little is
  // worse than waiting long: the old 90s window declared a healthy boot a
  // failure and rolled a working snapshot back.
  const boot = async () => {
    const child = startHost(host)
    log(`started host ${child.pid}`)
    return { child, url: await awaitLaunchUrl({ ...host, child, timeoutMs: state.launchTimeoutMs }) }
  }

  try {
    await sleep(state.delayMs)
    await stop()
    let { child, url } = await boot()
    if (!url) {
      log(`new host did not publish a launch url within ${state.launchTimeoutMs}ms; rolling back the plugin snapshot`)
      await stop()
      // A boot that hung before listening is not on the port; it is still ours to end.
      child.kill('SIGKILL')
      while (child.exitCode === null && child.signalCode === null) await sleep(200)
      if (state.backup && existsSync(state.backup)) copyEntries(state.backup, state.pluginDir, state.entries)
      ;({ child, url } = await boot())
    }
    if (url) { record({ status: 'running', pid: child.pid, launchUrl: url }); log(`restart complete: ${url}`) }
    else { record({ status: 'failed' }); log('restart failed: inspect server.log; snapshot backup at ' + state.backup) }
  } catch (error) {
    log(`restart worker error: ${String(error && error.stack ? error.stack : error)}`)
  } finally {
    rmSync(statePath, { force: true })
  }
}
