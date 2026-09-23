/**
 * The one supervisor behind start-preview, start-lab, update-preview and round.
 *
 * A root's host is the process listening on 127.0.0.1:<port> whose command
 * line is the dsh web host these scripts launch for that root:
 * <harness>/apps/cli/lib/bin.js ... --profile web ... --patch <root>/<file>.
 * Nothing trusts a recorded pid, which goes stale when a host is restarted by
 * hand and can be reused by an unrelated process; and nothing signals a
 * listener that is not the root's host (another program, another root's host).
 *
 *   findHost(port, root)      that host as { pid, command, harness }, or undefined
 *                             when the port is free; refuses any other listener
 *   stopHost(port, root)      TERM that host, KILL it after a grace period,
 *                             re-checking its command line before each signal
 *   startHost({ root, ... })  refuse a held port, give the host a fresh
 *                             <root>/server.log, spawn it detached
 *   awaitLaunchUrl(...)       the launch URL that host prints, kept in <root>/launch.url
 *
 * server.log only ever holds the current boot (the previous one is renamed to
 * server-<stamp>.log), so the first launch URL in it is this host's: no offsets.
 * Every process call goes through `system`, which the tests replace.
 */
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
export const system = {
  lsof: args => execFileSync('lsof', args, quiet),
  ps: args => execFileSync('ps', args, quiet),
  kill: (pid, signal) => process.kill(pid, signal),
  spawn: (args, options) => spawn(process.execPath, args, options),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/** The pids listening on 127.0.0.1:<port>. The host binds only that address, so a listener on ::1, 0.0.0.0 or :: is never it. */
function listeners(port, sys) {
  let out
  try { out = sys.lsof(['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t']) }
  catch (error) { if (error.status === 1) return []; throw error } // lsof exits 1 when nothing matches
  return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))]
}

/** A live pid's command line; '' once it has exited. */
function commandOf(pid, sys) {
  try { return sys.ps(['-ww', '-o', 'command=', '-p', String(pid)]).trim() }
  catch (error) { if (error.status === 1) return ''; throw error } // ps exits 1 for a pid that is gone
}

const ENTRY = '/apps/cli/lib/bin.js'
/** The Harness checkout when `command` is the dsh web host of `root` as these scripts launch it, else undefined. */
export function hostHarness(command, root) {
  const argv = command.split(/\s+/)
  const entry = argv.findIndex(arg => isAbsolute(arg) && arg.endsWith(ENTRY))
  const option = name => { const at = argv.indexOf(name, entry + 1); return at > entry ? argv[at + 1] : undefined }
  if (entry < 0 || option('--profile') !== 'web' || dirname(option('--patch') ?? '') !== root) return undefined
  return argv[entry].slice(0, -ENTRY.length)
}

/**
 * The host of `root` on the port as { pid, command, harness }, or undefined when nothing listens
 * on 127.0.0.1:<port>. Any other listener is refused by pid and command line, never returned.
 */
export function findHost(port, root, sys = system) {
  const pids = listeners(port, sys)
  if (pids.length > 1) throw new Error(`port ${port} has ${pids.length} listeners (${pids.join(', ')}); stop the extra ones by hand`)
  const [pid] = pids
  const command = pid === undefined ? '' : commandOf(pid, sys)
  if (!command) return undefined // free, or the listener exited since the lookup
  const harness = hostHarness(command, root)
  if (!harness) throw new Error(`port ${port} is held by process ${pid} (${command}), which is not the dsh host of ${root}; stop it by hand or choose another --port`)
  return { pid, command, harness }
}

const alive = (pid, sys) => { try { sys.kill(pid, 0); return true } catch { return false } }

/** Stop the host of `root` on the port and wait until it is gone. Resolves with its pid, or undefined for a free port. */
export async function stopHost(port, root, { graceMs = 12_000, onStop = () => {} } = {}, sys = system) {
  const host = findHost(port, root, sys)
  if (host === undefined) return undefined
  onStop(host.pid)
  for (const [signal, boundMs] of [['SIGTERM', graceMs], ['SIGKILL', 5_000]]) {
    // Checked again right before each signal: a pid that exited, or that another program now owns, is left alone.
    if (hostHarness(commandOf(host.pid, sys), root)) try { sys.kill(host.pid, signal) } catch { /* already gone */ }
    for (let waited = 0; waited < boundMs && alive(host.pid, sys); waited += 200) await sys.sleep(200)
    if (!alive(host.pid, sys)) return host.pid
  }
  throw new Error(`host ${host.pid} on port ${port} is still running after SIGKILL`)
}

/** Start a host on a free port with a fresh server.log. Returns the child; the caller owns it. */
export function startHost({ root, port, cli, patch, cwd, env }, sys = system) {
  const holders = listeners(port, sys)
  if (holders.length) throw new Error(`port ${port} is held by process ${holders.join(', ')}; stop it before starting a host`)
  const logPath = join(root, 'server.log')
  try { renameSync(logPath, join(root, `server-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const out = openSync(logPath, 'wx', 0o600)
  try {
    const child = sys.spawn(['--expose-internals', cli, '--profile', 'web', '--patch', patch, '--port', String(port), '--no-open'], { cwd, env, detached: true, stdio: ['ignore', out, out] })
    child.unref()
    return child
  } finally { closeSync(out) }
}

/** The launch URL `child` prints into server.log, also written to launch.url; undefined if it exits or the time runs out first. */
export async function awaitLaunchUrl({ root, port, child, timeoutMs }, sys = system) {
  const pattern = new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[A-Za-z0-9_.-]+`)
  for (let waited = 0; waited <= timeoutMs; waited += 200) {
    let text = ''
    try { text = readFileSync(join(root, 'server.log'), 'utf8') } catch { /* not created yet */ }
    const url = text.match(pattern)?.[0]
    if (url) { writeFileSync(join(root, 'launch.url'), url + '\n', { mode: 0o600 }); return url }
    if (child.exitCode !== null || child.signalCode !== null) return undefined
    await sys.sleep(200)
  }
  return undefined
}

/** The host's environment: its own homes, no telemetry, and never the caller's API key (the host reads its seeded credential). */
export function hostEnv(root, home = join(root, 'home')) {
  const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }
  for (const [key, dir] of [['DSH_AGENTS_HOME', 'agents-home'], ['DSH_BUNDLED_SKILL_DIR', 'bundled-skills']]) if (existsSync(join(root, dir))) env[key] = join(root, dir)
  delete env.DEEPSEEK_API_KEY
  return env
}

export const readServer = root => existsSync(join(root, 'server.json')) ? JSON.parse(readFileSync(join(root, 'server.json'), 'utf8')) : undefined
export const writeServer = (root, record) => writeFileSync(join(root, 'server.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
