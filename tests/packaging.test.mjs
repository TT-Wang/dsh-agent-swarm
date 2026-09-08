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
