/**
 * Stand-in for the Harness CLI (apps/cli/lib/bin.js) in the host tests, so they
 * never boot dsh. `plugin ...` and `--dump-config` exit 0. Otherwise it serves
 * HTTP on 127.0.0.1:<--port>, writes the swarm store lock the plugin would
 * (statePath from the --patch overlay) and prints a launch URL whose token is
 * its own pid, so a test can tell which boot printed it. It refuses the live
 * host ports and exits by itself after two minutes, so a crashed test cannot
 * leave it behind.
 */
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined
if (args[0] === 'plugin' || args.includes('--dump-config')) process.exit(0)
const port = Number(option('--port'))
if (!(port >= 6100)) { console.error(`fake host refuses port ${port}; use a throwaway port >= 6100`); process.exit(2) }
setTimeout(() => process.exit(0), 120_000).unref()
const server = createServer((request, response) => response.end('<script type="module" src="/plugins/dsh-agent-swarm/client.js"></script>'))
server.on('error', error => { console.error(`fake host: ${error.message}`); process.exit(1) })
server.listen(port, '127.0.0.1', () => {
  const patch = option('--patch')
  const statePath = patch && JSON.parse(readFileSync(patch, 'utf8')).find(row => row.id === 'dsh-external-agent-swarm')?.config?.statePath
  if (statePath) writeFileSync(`${statePath}.lock`, JSON.stringify({ pid: process.pid }))
  console.log(`dsh web: http://127.0.0.1:${port}/?token=t${process.pid}`)
})
