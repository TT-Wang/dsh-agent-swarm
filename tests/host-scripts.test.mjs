/**
 * update-preview, start-lab and round identify the host as the root's own dsh
 * host on its port, run live against tests/fixtures/fake-host.mjs as the
 * Harness CLI on a throwaway port >= 6100 with a temporary root and HOME: never
 * dsh, ~/.dsh or the live hosts. A hand-started host runs the fake Harness's
 * apps/cli/lib/bin.js with the root's patch, the command line the scripts
 * launch.
 *
 * The first two tests replay the 2026-09-18 incident: the host was restarted by
 * hand, so server.json records a pid that some other process (the decoy) now
 * owns, while the real host holds the port. The pid-file supervisor killed the
 * decoy and started a second host on the held port. The hand-started host and the decoy
 * are this process's children, so a script's "is it gone yet" poll waits for
 * this process to reap them: their exit status is settled once a script
 * returns. This file uses no helper from scripts/host.mjs, so the same
 * assertions run against the scripts before it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const fakeHost = fileURLToPath(new URL('./fixtures/fake-host.mjs', import.meta.url))
const noLsof = spawnSync('lsof', ['-h']).error ? 'lsof is not installed' : false
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const running = child => child.exitCode === null && child.signalCode === null
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/** The pid on 127.0.0.1:<port>, the host's one address. Independent of scripts/host.mjs on purpose. */
function listener(port) {
  const pid = spawnSync('lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.trim()
  return pid ? Number(pid) : undefined
}

async function until(check, what, timeoutMs = 60_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(100)) if (check()) return
  throw new Error(`timed out waiting for ${what}`)
}

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => port >= 6100 ? resolve(port) : reject(new Error(`ephemeral port ${port} is below 6100`)))
  })
})

/** A temporary root and port, a fake Harness checkout, and cleanup of every process the test caused. */
async function scene(t) {
  const root = mkdtempSync(join(tmpdir(), 'host-scripts-'))
  const port = await freePort()
  const harness = join(root, 'harness')
  mkdirSync(join(harness, 'apps/cli/lib'), { recursive: true })
  copyFileSync(fakeHost, join(harness, 'apps/cli/lib/bin.js'))
  const children = []
  t.after(() => {
    for (const child of children) child.kill('SIGKILL')
    const host = listener(port)
    if (host) process.kill(host, 'SIGKILL') // the scripts' host is detached, not our child
    rmSync(root, { recursive: true, force: true })
  })
  const env = { ...process.env, HOME: join(root, 'home') }
  return {
    root, port, harness,
    patch(name) {
      const path = join(root, name)
      writeFileSync(path, JSON.stringify([{ id: 'dsh-external-agent-swarm', config: { statePath: join(root, 'swarm.sqlite'), workspacesRoot: join(root, 'worktrees') } }]) + '\n')
      return path
    },
    /** A live process that owns the pid server.json recorded, on no port. */
    decoy() {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      children.push(child)
      return child
    },
    /** An unrelated program listening on `address`:<port>. */
    async foreign(address) {
      const child = spawn(process.execPath, ['-e', `setTimeout(() => process.exit(0), 120_000).unref(); require('node:http').createServer((q, r) => r.end()).listen(${port}, ${JSON.stringify(address)}, () => console.log('ready'))`], { stdio: ['ignore', 'pipe', 'inherit'] })
      children.push(child)
      await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error(`the listener on ${address}:${port} exited ${code}`))) })
      return child
    },
    /** The host someone restarted by hand: it holds the port and prints its token into `log`. */
    async handStart(patch, log) {
      const out = openSync(join(root, log), 'a')
      const child = spawn(process.execPath, [join(harness, 'apps/cli/lib/bin.js'), '--profile', 'web', '--patch', patch, '--port', String(port), '--no-open'], { stdio: ['ignore', out, out] })
      closeSync(out)
      children.push(child)
      await until(() => listener(port) === child.pid, `the hand-started host on ${port}`, 20_000)
      return child
    },
    run(script, args) {
      return new Promise(resolve => execFile(process.execPath, [join(project, 'scripts', script), ...args], { cwd: project, env }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })))
    },
  }
}

test('update-preview restarts the host that holds the port, not the pid server.json recorded', { skip: noLsof }, async t => {
  const s = await scene(t)
  for (const dir of ['home', 'workspace']) mkdirSync(join(s.root, dir), { recursive: true })
  const patch = s.patch('preview.patch.yml')
  const decoy = s.decoy()
  const hand = await s.handStart(patch, 'server.log')
  writeFileSync(join(s.root, 'server.json'), JSON.stringify({ status: 'running', pid: decoy.pid, url: `http://127.0.0.1:${s.port}`, port: s.port, home: join(s.root, 'home'), harness: s.harness }))

  const update = await s.run('update-preview.mjs', ['--preview', s.root, '--harness', s.harness, '--no-sync', '--skip-build', '--port', String(s.port), '--delay', '0', '--launch-timeout-ms', '20000'])
  assert.equal(update.code, 0, update.stderr)
  assert.equal(JSON.parse(update.stdout).restarted, true)
  await until(() => !readdirSync(s.root).some(name => name.startsWith('.update-preview-')), 'the detached restart worker')

  const server = readJson(join(s.root, 'server.json'))
  const restartLog = readFileSync(join(s.root, 'restart.log'), 'utf8')
  assert.ok(running(decoy), `the recorded pid belongs to another process by now and must survive\n${restartLog}`)
  assert.equal(running(hand), false, 'the host that held the port is the one stopped')
  assert.match(restartLog, new RegExp(`old host ${hand.pid} will stop`))
  assert.match(restartLog, new RegExp(`stopping host ${hand.pid}\\n`))
  assert.equal(server.status, 'running', restartLog)
  assert.equal(listener(s.port), server.pid, 'the recorded host is the one on the port')
  assert.equal(server.launchUrl, `http://127.0.0.1:${s.port}/?token=t${server.pid}`)
  assert.equal(readFileSync(join(s.root, 'launch.url'), 'utf8'), server.launchUrl + '\n')
  assert.match(restartLog, new RegExp(`restart complete: ${server.launchUrl.replace(/[?.]/g, '\\$&')}`))
  assert.equal(server.harness, s.harness, 'the Harness is recorded, so the next update needs no inference')
})

test('start-lab restarts a hand-restarted lab by its port with a fresh token; round status and soak judge the host by port', { skip: noLsof }, async t => {
  const s = await scene(t)
  mkdirSync(join(s.root, 'home'), { recursive: true })
  writeFileSync(join(s.root, 'home/.credentials.yaml'), '') // already seeded: start-lab reads no .env
  const decoy = s.decoy()
  const hand = await s.handStart(s.patch('lab.patch.yml'), 'server.log') // its token is the previous boot's
  writeFileSync(join(s.root, 'server.json'), JSON.stringify({ status: 'running', pid: decoy.pid, url: `http://127.0.0.1:${s.port}`, root: s.root, port: s.port }))

  const lab = await s.run('start-lab.mjs', ['--root', s.root, '--port', String(s.port), '--harness', s.harness])
  assert.ok(running(decoy), `the recorded pid belongs to another process by now and must survive\n${lab.stdout}${lab.stderr}`)
  assert.equal(running(hand), false, 'the host that held the port is the one stopped')
  assert.equal(lab.code, 0, lab.stderr)
  const started = JSON.parse(lab.stdout)
  assert.equal(started.started, true)
  assert.equal(started.launchUrl, `http://127.0.0.1:${s.port}/?token=t${started.pid}`, 'the new boot\'s token, not the previous boot\'s')
  assert.equal(listener(s.port), started.pid)
  const server = readJson(join(s.root, 'server.json'))
  assert.equal(server.status, 'running')
  assert.equal(server.harness, s.harness)

  // Restarted by hand once more: server.json now names a pid that holds nothing.
  process.kill(started.pid, 'SIGTERM')
  await until(() => listener(s.port) === undefined, 'the lab host to stop', 20_000)
  const again = await s.handStart(join(s.root, 'lab.patch.yml'), 'hand.log')
  const status = await s.run('round.mjs', ['status', '--lab', s.root])
  assert.equal(status.code, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).host.alive, true)
  assert.equal(JSON.parse(status.stdout).host.pid, again.pid)
  const soak = await s.run('round.mjs', ['soak', '--lab', s.root])
  assert.deepEqual(JSON.parse(soak.stdout).checks.map(check => [check.name, check.ok]),
    [['host-alive', true], ['plugin-loaded', true], ['mounted-after-build', true], ['client-bundle-served', true]], soak.stdout)
  assert.equal(soak.code, 0)
})

test('the host is the listener on 127.0.0.1: unrelated listeners on ::1 and 0.0.0.0 are neither counted nor stopped', { skip: noLsof }, async t => {
  const s = await scene(t)
  for (const dir of ['home', 'workspace']) mkdirSync(join(s.root, dir), { recursive: true })
  const hand = await s.handStart(s.patch('preview.patch.yml'), 'server.log')
  const others = [await s.foreign('::1'), await s.foreign('0.0.0.0')]
  writeFileSync(join(s.root, 'server.json'), JSON.stringify({ status: 'running', pid: hand.pid, url: `http://127.0.0.1:${s.port}`, port: s.port, home: join(s.root, 'home'), harness: s.harness }))

  const status = await s.run('round.mjs', ['status', '--lab', s.root])
  assert.equal(status.code, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).host.pid, hand.pid, 'the listeners on other addresses are not a second host')
  const update = await s.run('update-preview.mjs', ['--preview', s.root, '--no-sync', '--skip-build', '--delay', '0', '--launch-timeout-ms', '20000'])
  assert.equal(update.code, 0, update.stderr)
  await until(() => !readdirSync(s.root).some(name => name.startsWith('.update-preview-')), 'the detached restart worker')
  const restartLog = readFileSync(join(s.root, 'restart.log'), 'utf8')
  assert.equal(running(hand), false, restartLog)
  assert.ok(others.every(running), `a listener on ::1 or 0.0.0.0 never conflicts with the host and is never signalled\n${restartLog}`)
  const server = readJson(join(s.root, 'server.json'))
  assert.equal(server.status, 'running', restartLog)
  assert.equal(listener(s.port), server.pid)
})

test('update-preview and start-lab refuse a listener that is not this root\'s host, by pid and command line, and never signal it', { skip: noLsof }, async t => {
  const s = await scene(t)
  for (const dir of ['home', 'workspace', 'other']) mkdirSync(join(s.root, dir), { recursive: true })
  writeFileSync(join(s.root, 'home/.credentials.yaml'), '') // already seeded: start-lab reads no .env
  const record = JSON.stringify({ status: 'running', pid: 1, url: `http://127.0.0.1:${s.port}`, port: s.port, home: join(s.root, 'home'), harness: s.harness })
  writeFileSync(join(s.root, 'server.json'), record)
  const update = () => s.run('update-preview.mjs', ['--preview', s.root, '--no-sync', '--skip-build', '--delay', '0'])

  const lab = extra => s.run('start-lab.mjs', ['--root', s.root, '--port', String(s.port), '--harness', s.harness, ...extra])
  async function refusedBy(victim, what) {
    for (const [name, result] of [['update-preview', await update()], ['start-lab', await lab([])], ['start-lab --no-start', await lab(['--no-start'])]]) {
      assert.equal(result.code, 1, `${name} over ${what}: ${result.stdout}`)
      assert.match(result.stderr, new RegExp(`port ${s.port} is held by process ${victim.pid} \\(.+\\), which is not the dsh host of ${s.root}`), `${name} names ${what}`)
      assert.ok(running(victim), `${name} never signals ${what}`)
    }
    const status = await s.run('round.mjs', ['status', '--lab', s.root])
    assert.equal(status.code, 0, `round status reports ${what} instead of crashing: ${status.stderr}`)
    assert.deepEqual([JSON.parse(status.stdout).host.alive, JSON.parse(status.stdout).host.error.includes(`process ${victim.pid} (`)], [false, true])
  }
  const unrelated = await s.foreign('127.0.0.1')
  await refusedBy(unrelated, 'an unrelated program')
  unrelated.kill('SIGKILL')
  await until(() => listener(s.port) === undefined, 'the unrelated program to exit')
  await refusedBy(await s.handStart(s.patch('other/preview.patch.yml'), 'other/server.log'), 'another root\'s host')
  assert.equal(readFileSync(join(s.root, 'server.json'), 'utf8'), record, 'update-preview refused before recording a restart')
  assert.equal(existsSync(join(s.root, 'restart.log')), false, 'and before building, syncing or scheduling a worker')
})

test('the restart worker checks the port again: a program that took it during the delay is refused, never signalled', { skip: noLsof }, async t => {
  const s = await scene(t)
  for (const dir of ['home', 'workspace']) mkdirSync(join(s.root, dir), { recursive: true })
  const hand = await s.handStart(s.patch('preview.patch.yml'), 'server.log')
  writeFileSync(join(s.root, 'server.json'), JSON.stringify({ status: 'running', pid: hand.pid, url: `http://127.0.0.1:${s.port}`, port: s.port, home: join(s.root, 'home'), harness: s.harness }))
  const update = await s.run('update-preview.mjs', ['--preview', s.root, '--no-sync', '--skip-build', '--delay', '3000'])
  assert.equal(update.code, 0, update.stderr)
  hand.kill('SIGTERM')
  await until(() => listener(s.port) === undefined, 'the host to exit during the delay', 20_000)
  const taker = await s.foreign('127.0.0.1')
  await until(() => !readdirSync(s.root).some(name => name.startsWith('.update-preview-')), 'the detached restart worker')
  const restartLog = readFileSync(join(s.root, 'restart.log'), 'utf8')
  assert.ok(running(taker), `the program that took the port is never signalled\n${restartLog}`)
  assert.match(restartLog, new RegExp(`port ${s.port} is held by process ${taker.pid} \\(.+\\), which is not the dsh host of ${s.root}`))
  assert.doesNotMatch(restartLog, /stopping host|started host/)
})
