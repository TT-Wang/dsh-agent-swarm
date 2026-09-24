/**
 * Stand-in for the Harness CLI (apps/cli/lib/bin.js) in the host and web smoke
 * runner tests, so they never boot dsh. `plugin ... add <spec>` records the
 * plugin in $DSH_HOME's web profile manifest; `plugin ...` and `--dump-config`
 * exit 0. Otherwise it serves HTTP on 127.0.0.1:<--port> (0 picks a free
 * port), answering 401 without a token, writes the swarm store lock the plugin
 * would (statePath from the --patch overlay) and prints a launch URL whose
 * token is its own pid, so a test can tell which boot printed it. With
 * FAKE_HOST_FORK=1 it also hands its listening socket to a child with the same
 * command line, as a forked worker would. It refuses the live host ports and
 * exits by itself after two minutes, so a crashed test cannot leave it behind.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
if (args[0] === 'plugin' && args.includes('add') && process.env.DSH_HOME) {
  mkdirSync(join(process.env.DSH_HOME, 'profiles/web'), { recursive: true })
  writeFileSync(join(process.env.DSH_HOME, 'profiles/web/package.json'), JSON.stringify({ dependencies: { '@dsh-external/dsh-agent-swarm': option('add') }, dsh: { profile: { bundles: ['@dsh-external/dsh-agent-swarm'] } } }))
}
if (args[0] === 'plugin' || args.includes('--dump-config')) process.exit(0)
const port = Number(option('--port'))
if (port !== 0 && !(port >= 6100)) { console.error(`fake host refuses port ${port}; use a throwaway port >= 6100 or 0`); process.exit(2) }
setTimeout(() => process.exit(0), 120_000).unref()
const server = createServer((request, response) => {
  response.statusCode = new URL(request.url, 'http://host').searchParams.has('token') ? 200 : 401
  response.end('<script type="module" src="/plugins/dsh-agent-swarm/client.js"></script>')
})
if (process.env.FAKE_HOST_FORK === 'child') process.once('message', (message, socket) => server.listen(socket)) // the forked worker serves its parent's socket
else {
  server.on('error', error => { console.error(`fake host: ${error.message}`); process.exit(1) })
  server.listen(port, '127.0.0.1', () => {
    const patch = option('--patch')
    const statePath = patch && JSON.parse(readFileSync(patch, 'utf8')).find(row => row.id === 'dsh-external-agent-swarm')?.config?.statePath
    if (statePath) writeFileSync(`${statePath}.lock`, JSON.stringify({ pid: process.pid }))
    console.log(`dsh web: http://127.0.0.1:${server.address().port}/?token=t${process.pid}`)
    if (process.env.FAKE_HOST_FORK === '1') spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { env: { ...process.env, FAKE_HOST_FORK: 'child' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }).send('socket', server)
  })
}
