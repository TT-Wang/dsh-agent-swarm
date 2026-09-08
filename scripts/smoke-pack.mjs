import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { harnessCatalog, linkHarnessPeers } from '../tests/fixtures/built-harness.mjs'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const harnessRoot = resolveHarnessRoot()
const temporary = await mkdtemp(join(tmpdir(), 'dsh-swarm-pack-'))
try {
  const { stdout } = await execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
    cwd: project, maxBuffer: 4 * 1024 * 1024,
  })
  const [packed] = JSON.parse(stdout)
  const files = packed.files.map(file => file.path)
  assert(files.includes('package.json'))
  assert(files.some(file => /^(lib|dist)\/.*\.js$/.test(file)), 'tarball must contain built JavaScript')
  assert(!files.some(file => /(^|\/)\.env($|\.)|(^|\/)node_modules\//.test(file)), 'tarball contains private/local files')
  await execute('tar', ['-xzf', join(temporary, packed.filename), '-C', temporary])
  const artifactRoot = join(temporary, 'package')
  await linkHarnessPeers(artifactRoot, harnessRoot)
  const manifest = JSON.parse(await readFile(join(artifactRoot, 'package.json'), 'utf8'))
  const catalog = await harnessCatalog(harnessRoot)
  const compatibility = JSON.parse(await readFile(join(artifactRoot, 'compatibility.json'), 'utf8'))
  const actualCommit = (await execute('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot })).stdout.trim()
  assertSupportedHarness(harnessRoot, artifactRoot)
  for (const [name, exported] of Object.entries(manifest.exports)) {
    const targets = typeof exported === 'string' ? [exported] : Object.values(exported)
    for (const target of targets) {
      assert.equal(typeof target, 'string', `Unsupported export condition in ${name}`)
      await readFile(join(artifactRoot, target))
    }
  }
  // Resolve non-Harness dependencies exactly as the local installation already did.
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    if (catalog.has(name)) continue
    const destination = join(artifactRoot, 'node_modules', name)
    await mkdir(dirname(destination), { recursive: true })
    await symlink(await realpath(join(project, 'node_modules', name)), destination, 'dir')
  }
  const result = await execute(process.execPath, [
    '--expose-internals', join(project, 'tests/harness-composition.mjs'),
    '--artifact', artifactRoot, '--harness', harnessRoot,
  ], { cwd: temporary, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
  process.stdout.write(`Packed artifact smoke passed (${files.length} published files).\n`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
