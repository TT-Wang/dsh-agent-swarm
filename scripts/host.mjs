/**
 * The one supervisor behind start-preview, start-lab, update-preview and round.
 *
 * The port is the host's identity: whatever process listens on it IS the host,
 * no matter who started it. Nothing trusts a recorded pid, which goes stale when
 * a host is restarted by hand and can be reused by an unrelated process.
 *
 *   findHost(port)            the pid listening on the port, or undefined
 *   stopHost(port)            TERM that pid, KILL it after a grace period
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
import { join } from 'node:path'

export const system = {
  lsof: args => execFileSync('lsof', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  kill: (pid, signal) => process.kill(pid, signal),
  spawn: (args, options) => spawn(process.execPath, args, options),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

/** The pid listening on 127.0.0.1:<port>, or undefined when it is free. The host binds only that address, so a listener on ::1, 0.0.0.0 or :: is never it. */
export function findHost(port, sys = system) {
  let out
  try { out = sys.lsof(['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t']) }
  catch (error) { if (error.status === 1) return undefined; throw error } // lsof exits 1 when nothing matches
  const pids = [...new Set(out.split(/\s+/).filter(Boolean).map(Number))]
  if (pids.length > 1) throw new Error(`port ${port} has ${pids.length} listeners (${pids.join(', ')}); stop the extra ones by hand`)
  return pids[0]
}

const alive = (pid, sys) => { try { sys.kill(pid, 0); return true } catch { return false } }

/** Stop whatever listens on the port and wait until it is gone. Resolves with its pid, or undefined for a free port. */
export async function stopHost(port, { graceMs = 12_000, onStop = () => {} } = {}, sys = system) {
  const pid = findHost(port, sys)
  if (pid === undefined) return undefined
  onStop(pid)
  for (const [signal, boundMs] of [['SIGTERM', graceMs], ['SIGKILL', 5_000]]) {
    try { sys.kill(pid, signal) } catch { /* already gone */ }
    for (let waited = 0; waited < boundMs && alive(pid, sys); waited += 200) await sys.sleep(200)
    if (!alive(pid, sys)) return pid
  }
  throw new Error(`host ${pid} on port ${port} is still running after SIGKILL`)
}

/** Start a host on a free port with a fresh server.log. Returns the child; the caller owns it. */
export function startHost({ root, port, cli, patch, cwd, env }, sys = system) {
  const holder = findHost(port, sys)
  if (holder !== undefined) throw new Error(`port ${port} is held by process ${holder}; stop it before starting a host`)
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
