/**
 * H5: the published package must ship built code, and the build must be wired as
 * a pack lifecycle hook so a clean `npm pack` cannot ship an empty tarball.
 *
 * The manifest check runs with --ignore-scripts on purpose: sibling test files
 * import lib/ concurrently, so rebuilding lib/ from inside the suite would race
 * them. scripts/smoke-pack.mjs proves the hook itself end-to-end in a clean
 * checkout (materialize tracked files, link dependencies, `npm pack` with
 * lifecycle scripts enabled, assert package/lib/index.js and package/lib/client.js).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SWARM_TOOLS } from '../lib/tools.js'
import { SWARM_WEB_ENDPOINTS } from '../lib/types.js'

const root = new URL('..', import.meta.url)

test('H5: package.json declares a build hook that runs during npm pack', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  const hook = pkg.scripts?.prepack ?? pkg.scripts?.prepare
  assert.equal(typeof hook, 'string', 'package.json must declare a prepack or prepare hook')
  assert.match(hook, /npm run build/, 'the pack hook must run the build')
  assert.equal(pkg.main, 'lib/index.js', 'main must point at the built entry point')
})

test('H5: the pack manifest ships both declared entry points', () => {
  // A pack that is never built is the defect; fail loudly instead of skipping.
  assert.ok(existsSync(new URL('lib/index.js', root)), 'run the build before the suite (npm run build)')
  const cache = mkdtempSync(join(tmpdir(), 'swarm-pack-cache-'))
  try {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    })
    const [manifest] = JSON.parse(output)
    const files = new Set(manifest.files.map(file => file.path))
    assert.ok(files.has('lib/index.js'), 'lib/index.js must be in the tarball')
    assert.ok(files.has('lib/client.js'), 'lib/client.js must be in the tarball')
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
})

test('F-21: the packed artifact ships the smoke it declares and documents the repository requirement', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
  assert.equal(pkg.scripts?.['test:packed'], 'node scripts/packed-smoke.mjs', 'the packed-artifact smoke must be declared')
  const cache = mkdtempSync(join(tmpdir(), 'swarm-pack-cache-'))
  try {
    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
    })
    const [manifest] = JSON.parse(output)
    const files = new Set(manifest.files.map(file => file.path))
    assert.ok(files.has('scripts/packed-smoke.mjs'), 'the packed-artifact smoke script must be in the tarball')
    const shippedDocs = readFileSync(new URL('README.md', root), 'utf8') + readFileSync(new URL('docs/known-limitations.md', root), 'utf8')
    const documented = /requires the repository checkout/.test(shippedDocs)
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      if (name === 'test:packed') continue
      const referenced = /(?:^|\s)((?:scripts|tests)\/[^\s'"]+)/.exec(command)?.[1]
      if (referenced === undefined || files.has(referenced)) continue
      assert.ok(documented, `${name} needs ${referenced}, which is not packed; the shipped docs must state the repository requirement`)
    }
  } finally {
    rmSync(cache, { recursive: true, force: true })
  }
})

test('F-21: the packed-artifact smoke passes on the built tree', () => {
  assert.ok(existsSync(new URL('lib/index.js', root)), 'run the build before the suite (npm run build)')
  const output = execFileSync(process.execPath, ['scripts/packed-smoke.mjs'], { cwd: root, encoding: 'utf8' })
  assert.match(output, /packed-smoke: \d+ export target\(s\)/)
})

test('the naming manifest declares exactly the surface this package registers', () => {
  // The 2026-09-11 reviews found the manifest at 18 of 24 tools with no test
  // reading it, so the drift was silent. It is a published file, so it is pinned
  // against the registry rather than hand-kept.
  const naming = JSON.parse(readFileSync(new URL('../dsh-plugin.naming.json', import.meta.url), 'utf8'))
  assert.deepEqual([...naming.names.tools].sort(), [...SWARM_TOOLS].sort(), 'every registered tool is declared, and nothing else')
  assert.deepEqual([...naming.names.pluginNames].sort(), ['agent-swarm', 'agent-swarm-client'], 'both plugin halves are named')
  assert.deepEqual(naming.names.services, ['swarm'], 'the service the plugin provides')
  assert.deepEqual(naming.names.commands, ['agent-swarm'], 'the native command')
  assert.deepEqual(naming.names.routes, [{
    kind: 'fetch', channel: '/api', path: '/api/agent-swarm/<endpoint>', methods: ['POST'], endpoints: SWARM_WEB_ENDPOINTS,
  }], 'the RPC surface is one exact route per endpoint on the host shared channel')
  // The declared list and the handler's dispatch must not drift, and the client
  // must address the same prefix the server registers.
  const source = readFileSync(new URL('../src/web-api.ts', import.meta.url), 'utf8')
  const dispatched = [...source.matchAll(/case '([a-z-]+)':/g)].map(match => match[1])
  assert.deepEqual([...dispatched].sort(), [...SWARM_WEB_ENDPOINTS].sort(), 'every declared endpoint has a dispatch case')
  const client = readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.match(client, /rpc\.call\(SWARM_RPC_CHANNEL, `\$\{SWARM_RPC_PREFIX\}\$\{endpoint\}`/, 'the client addresses the registered prefix')
})
