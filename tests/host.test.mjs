/**
 * scripts/host.mjs: the port is the host's identity. Every test here runs
 * against a stubbed process layer; tests/host-scripts.test.mjs runs the same
 * code live through the scripts, against a fake Harness on a throwaway port.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { awaitLaunchUrl, findHost, startHost, stopHost } from '../scripts/host.mjs'

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'host-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** Process layer with `listeners` ({ port: pid }); `others` are live pids on no port. */
function stubSystem({ listeners = {}, others = [], ignoresTerm = [], immortal = [] } = {}) {
  const living = new Set([...Object.values(listeners), ...others])
  const signals = [], spawned = [], lsofCalls = []
  return {
    signals, spawned, lsofCalls,
    lsof: args => {
      lsofCalls.push(args)
      const pid = listeners[Number(args.find(arg => arg.startsWith('-iTCP@127.0.0.1:')).slice('-iTCP@127.0.0.1:'.length))]
      if (!living.has(pid)) throw Object.assign(new Error('lsof found nothing'), { status: 1 })
      return `${pid}\n`
    },
    kill: (pid, signal) => {
      if (!living.has(pid)) throw Object.assign(new Error(`kill ${pid}: ESRCH`), { code: 'ESRCH' })
      if (signal === 0) return
      signals.push([pid, signal])
      if (immortal.includes(pid)) return
      if (signal === 'SIGKILL' || !ignoresTerm.includes(pid)) living.delete(pid)
    },
    spawn: (args, options) => { spawned.push({ args, options }); return { pid: 99999, exitCode: null, signalCode: null, unref() {} } },
    sleep: async () => {},
  }
}

test('findHost: the one pid lsof reports for the port; a free port is undefined; two listeners are refused', () => {
  const sys = stubSystem({ listeners: { 6101: 4242 } })
  assert.equal(findHost(6101, sys), 4242)
  assert.deepEqual(sys.lsofCalls[0], ['-nP', '-iTCP@127.0.0.1:6101', '-sTCP:LISTEN', '-t'], 'only the address the host binds: a listener on ::1, 0.0.0.0 or :: is not it')
  assert.equal(findHost(6102, sys), undefined)
  assert.equal(findHost(6103, { lsof: () => '11\n11\n' }), 11, 'one process on IPv4 and IPv6 is one host')
  assert.throws(() => findHost(6103, { lsof: () => '11\n12\n' }), /port 6103 has 2 listeners \(11, 12\); stop the extra ones by hand/)
  assert.throws(() => findHost(6104, { lsof: () => { throw Object.assign(new Error('spawnSync lsof ENOENT'), { code: 'ENOENT' }) } }), /ENOENT/,
    'a missing lsof is an error, never "the port is free"')
})

test('stopHost signals only the process on the port, never a recorded pid, and escalates to SIGKILL', async () => {
  const recorded = 777 // server.json's pid after a hand restart: alive, but some other process now
  const sys = stubSystem({ listeners: { 6101: 4242 }, others: [recorded], ignoresTerm: [4242] })
  const announced = []
  assert.equal(await stopHost(6101, { graceMs: 1000, onStop: pid => announced.push(pid) }, sys), 4242)
  assert.deepEqual(announced, [4242])
  assert.deepEqual(sys.signals, [[4242, 'SIGTERM'], [4242, 'SIGKILL']])
  assert.equal(await stopHost(6101, {}, sys), undefined, 'a free port stops nothing')
  assert.equal(sys.signals.length, 2)

  const polite = stubSystem({ listeners: { 6102: 5151 } })
  assert.equal(await stopHost(6102, {}, polite), 5151)
  assert.deepEqual(polite.signals, [[5151, 'SIGTERM']], 'a host that exits on SIGTERM is never sent SIGKILL')

  const stuck = stubSystem({ listeners: { 6103: 6161 }, immortal: [6161] })
  await assert.rejects(stopHost(6103, { graceMs: 400 }, stuck), /host 6161 on port 6103 is still running after SIGKILL/)
})

test('startHost refuses a held port: nothing is spawned and the old log is left alone', t => {
  const root = tempRoot(t)
  writeFileSync(join(root, 'server.log'), 'previous boot\n')
  const sys = stubSystem({ listeners: { 6101: 4242 } })
  assert.throws(() => startHost({ root, port: 6101, cli: 'bin.js', patch: 'p.yml', cwd: root, env: {} }, sys), /port 6101 is held by process 4242; stop it before starting a host/)
  assert.deepEqual(sys.spawned, [])
  assert.deepEqual(readdirSync(root), ['server.log'])
  assert.equal(readFileSync(join(root, 'server.log'), 'utf8'), 'previous boot\n')
})

test('startHost gives each boot a fresh server.log, so only the new boot\'s launch URL is taken (R7-02)', async t => {
  const root = tempRoot(t)
  writeFileSync(join(root, 'server.log'), 'dsh web: http://127.0.0.1:6101/?token=previous-boot\n')
  const sys = stubSystem()
  const host = { root, port: 6101, cli: '/harness/apps/cli/lib/bin.js', patch: '/root/preview.patch.yml', cwd: root, env: { DSH_HOME: '/root/home' } }
  const child = startHost(host, sys)
  assert.deepEqual(sys.spawned[0].args, ['--expose-internals', host.cli, '--profile', 'web', '--patch', host.patch, '--port', '6101', '--no-open'])
  assert.equal(sys.spawned[0].options.detached, true)
  const rotated = readdirSync(root).filter(name => /^server-.+\.log$/.test(name))
  assert.equal(rotated.length, 1, 'the previous boot keeps its log')
  assert.match(readFileSync(join(root, rotated[0]), 'utf8'), /previous-boot/)
  assert.equal(readFileSync(join(root, 'server.log'), 'utf8'), '', 'the new boot starts from an empty log')

  let polls = 0
  const booting = { ...sys, sleep: async () => { if (++polls === 3) appendFileSync(join(root, 'server.log'), 'dsh web: http://127.0.0.1:6101/?token=new-boot\n') } }
  assert.equal(await awaitLaunchUrl({ root, port: 6101, child, timeoutMs: 5_000 }, booting), 'http://127.0.0.1:6101/?token=new-boot')
  assert.equal(polls, 3, 'the previous boot\'s token was never a candidate')
  assert.equal(readFileSync(join(root, 'launch.url'), 'utf8'), 'http://127.0.0.1:6101/?token=new-boot\n')
})

test('awaitLaunchUrl gives up at once when the host has exited, and after the timeout when it stays silent', async t => {
  const root = tempRoot(t)
  writeFileSync(join(root, 'server.log'), 'dsh web: http://127.0.0.1:6102/?token=other-port-only\n')
  let polls = 0
  const sys = { sleep: async () => { polls++ } }
  assert.equal(await awaitLaunchUrl({ root, port: 6101, child: { exitCode: 3, signalCode: null }, timeoutMs: 5_000 }, sys), undefined)
  assert.equal(polls, 0)
  assert.equal(await awaitLaunchUrl({ root, port: 6101, child: { exitCode: null, signalCode: null }, timeoutMs: 1_000 }, sys), undefined)
  assert.equal(polls, 6, 'a 1000 ms timeout polls every 200 ms')
  assert.deepEqual(readdirSync(root), ['server.log'], 'no launch.url is written without a token for this port')
})
