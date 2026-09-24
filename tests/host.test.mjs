/**
 * scripts/host.mjs: a root's host is its own dsh host on the port, known by its
 * command line. Every test here runs against a stubbed process layer;
 * tests/host-scripts.test.mjs runs the same code live through the scripts,
 * against a fake Harness on a throwaway port.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { awaitLaunchUrl, findHost, hostHarness, startHost, stopHost } from '../scripts/host.mjs'

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'host-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const ROOT = '/roots/lab'
/** The command line of the host these scripts launch for `root`. */
const hostCommand = (root = ROOT, harness = '/code/harness') => `/usr/local/bin/node --expose-internals ${harness}/apps/cli/lib/bin.js --profile web --patch ${root}/lab.patch.yml --port 6101 --no-open`

/**
 * Process layer with `listeners` ({ port: pid or [pids] }) on 127.0.0.1, `commands` ({ pid: command line },
 * ROOT's host by default) and `parents` ({ pid: ppid }); `others` are live pids on no port.
 */
function stubSystem({ listeners = {}, commands = {}, parents = {}, others = [], ignoresTerm = [], immortal = [] } = {}) {
  const living = new Set([...Object.values(listeners).flat(), ...others])
  const signals = [], spawned = [], lsofCalls = []
  return {
    signals, spawned, lsofCalls,
    ps: args => {
      const pid = Number(args.at(-1))
      if (!living.has(pid)) throw Object.assign(new Error('ps found nothing'), { status: 1 })
      return `${parents[pid] ?? 1} ${commands[pid] ?? hostCommand()}\n`
    },
    lsof: args => {
      lsofCalls.push(args)
      const pids = [listeners[Number(args.find(arg => arg.startsWith('-iTCP@127.0.0.1:')).slice('-iTCP@127.0.0.1:'.length))]].flat().filter(pid => living.has(pid))
      if (!pids.length) throw Object.assign(new Error('lsof found nothing'), { status: 1 })
      return pids.map(pid => `${pid}\n`).join('')
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

test('findHost: this root\'s host is the pid lsof reports for 127.0.0.1:<port>; a free port is undefined; a missing lsof is an error', () => {
  const sys = stubSystem({ listeners: { 6101: 4242 } })
  assert.deepEqual(findHost(6101, ROOT, sys), { pid: 4242, pids: [4242], command: hostCommand(), harness: '/code/harness' })
  assert.deepEqual(sys.lsofCalls[0], ['-nP', '-iTCP@127.0.0.1:6101', '-sTCP:LISTEN', '-t'], 'only the address the host binds: a listener on ::1, 0.0.0.0 or :: is not it')
  assert.equal(findHost(6102, ROOT, sys), undefined)
  assert.equal(findHost(6103, ROOT, { ...sys, lsof: () => '4242\n4242\n' }).pid, 4242, 'one process listed twice is one host')
  assert.throws(() => findHost(6104, ROOT, { lsof: () => { throw Object.assign(new Error('spawnSync lsof ENOENT'), { code: 'ENOENT' }) } }), /ENOENT/,
    'a missing lsof is an error, never "the port is free"')
})

test('stopHost signals only the process on the port, never a recorded pid, and escalates to SIGKILL', async () => {
  const recorded = 777 // server.json's pid after a hand restart: alive, but some other process now
  const sys = stubSystem({ listeners: { 6101: 4242 }, others: [recorded], ignoresTerm: [4242] })
  const announced = []
  assert.equal(await stopHost(6101, ROOT, { graceMs: 1000, onStop: pid => announced.push(pid) }, sys), 4242)
  assert.deepEqual(announced, ['4242'])
  assert.deepEqual(sys.signals, [[4242, 'SIGTERM'], [4242, 'SIGKILL']])
  assert.equal(await stopHost(6101, ROOT, {}, sys), undefined, 'a free port stops nothing')
  assert.equal(sys.signals.length, 2)

  const polite = stubSystem({ listeners: { 6102: 5151 } })
  assert.equal(await stopHost(6102, ROOT, {}, polite), 5151)
  assert.deepEqual(polite.signals, [[5151, 'SIGTERM']], 'a host that exits on SIGTERM is never sent SIGKILL')

  const stuck = stubSystem({ listeners: { 6103: 6161 }, immortal: [6161] })
  await assert.rejects(stopHost(6103, ROOT, { graceMs: 400 }, stuck), /host 6161 on port 6103 is still running after SIGKILL/)
})

test('hostHarness: only the dsh web host these scripts launch for this very root', () => {
  assert.equal(hostHarness(hostCommand(), ROOT), '/code/harness')
  assert.equal(hostHarness('node /h2/apps/cli/lib/bin.js --port 6101 --patch /roots/lab/preview.patch.yml --profile web', ROOT), '/h2', 'option order is free')
  for (const [command, why] of [
    [hostCommand('/roots/other'), 'another root\'s host'],
    [hostCommand('/roots/lab/nested'), 'a host of a root inside this one'],
    [hostCommand('/roots/lab2'), 'a root whose path merely starts with this one'],
    ['node /code/harness/apps/cli/lib/bin.js --profile web --port 6101', 'a host started without the root\'s patch'],
    ['node /code/harness/apps/cli/lib/bin.js --profile cli --patch /roots/lab/lab.patch.yml', 'another profile'],
    ['node apps/cli/lib/bin.js --profile web --patch /roots/lab/lab.patch.yml', 'a relative entry, whose Harness is unknown'],
    ['node -e require("http").createServer().listen(6101) --profile web --patch /roots/lab/lab.patch.yml', 'another program'],
    ['', 'a process that has exited'],
  ]) assert.equal(hostHarness(command, ROOT), undefined, why)
})

test('a listener that is not this root\'s host is refused by pid and command line and never signalled', async () => {
  for (const command of ['/usr/local/bin/node -e require("http").createServer().listen(6101)', hostCommand('/roots/other')]) {
    const sys = stubSystem({ listeners: { 6101: 4242 }, commands: { 4242: command } })
    const refusal = { message: `port 6101 is held by process 4242 (${command}), which is not the dsh host of /roots/lab; stop it by hand or choose another --port` }
    assert.throws(() => findHost(6101, ROOT, sys), refusal)
    await assert.rejects(stopHost(6101, ROOT, { onStop: () => assert.fail('announced a stop') }, sys), refusal)
    assert.deepEqual(sys.signals, [])
  }
})

test('stopHost checks the command line again right before each signal: a pid another program took over is never signalled', async () => {
  // Reused between the lookup and SIGTERM.
  const reused = stubSystem({ listeners: { 6101: 4242 } })
  const lookup = reused.ps
  let psCalls = 0
  reused.ps = args => psCalls++ === 0 ? lookup(args) : '1 python3 -m http.server 6101\n'
  await assert.rejects(stopHost(6101, ROOT, { graceMs: 400 }, reused), /still running after SIGKILL/)
  assert.deepEqual(reused.signals, [], 'neither SIGTERM nor SIGKILL reaches the new owner')

  // The host ignores SIGTERM, then its pid is reused before SIGKILL.
  const late = stubSystem({ listeners: { 6102: 5151 }, ignoresTerm: [5151] })
  const hostPs = late.ps
  late.ps = args => late.signals.length ? '1 python3 -m http.server 6102\n' : hostPs(args)
  await assert.rejects(stopHost(6102, ROOT, { graceMs: 400 }, late), /still running after SIGKILL/)
  assert.deepEqual(late.signals, [[5151, 'SIGTERM']], 'SIGKILL is not sent to the process that took the pid over')
})

test('several listeners are one host when the others are forks of the parent; stopHost stops them all', async () => {
  const forked = stubSystem({ listeners: { 6101: [4242, 4243] }, parents: { 4243: 4242 } })
  assert.deepEqual(findHost(6101, ROOT, forked), { pid: 4242, pids: [4242, 4243], command: hostCommand(), harness: '/code/harness' }, 'the parent is the host')
  const announced = []
  assert.equal(await stopHost(6101, ROOT, { onStop: pids => announced.push(pids) }, forked), 4242)
  assert.deepEqual(announced, ['4242, 4243'])
  assert.deepEqual(forked.signals, [[4242, 'SIGTERM'], [4243, 'SIGTERM']])

  const joined = stubSystem({ listeners: { 6102: [4242, 4243] }, parents: { 4243: 4242 }, commands: { 4243: '/usr/bin/python3 -m http.server 6102' } })
  assert.throws(() => findHost(6102, ROOT, joined), { message: 'port 6102 is held by process 4243 (/usr/bin/python3 -m http.server 6102), which is not the dsh host of /roots/lab; stop it by hand or choose another --port' })
  await assert.rejects(stopHost(6102, ROOT, {}, joined), /held by process 4243/)
  assert.deepEqual(joined.signals, [], 'a foreign listener next to the host stops nothing')

  const separate = stubSystem({ listeners: { 6103: [11, 12] } })
  assert.throws(() => findHost(6103, ROOT, separate), { message: `port 6103 has 2 separate hosts of /roots/lab (11, 12); stop them by hand` })
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
