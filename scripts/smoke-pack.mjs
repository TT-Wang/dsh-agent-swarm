import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
import { assertSandboxPrerequisite } from './sandbox-prerequisite.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, readdir, realpath, rm, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { harnessCatalog, linkHarnessPeers } from '../tests/fixtures/built-harness.mjs'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const harnessRoot = resolveHarnessRoot()
const temporary = await mkdtemp(join(tmpdir(), 'dsh-swarm-pack-'))
const npmCache = join(temporary, 'npm-cache')

/** Materialize the tracked working tree (no ignored build output, no dependencies) into a clean checkout. */
async function materializeTrackedTree(source, destination) {
  const { stdout } = await execute('git', ['ls-files', '-z'], { cwd: source, maxBuffer: 16 * 1024 * 1024 })
  const tracked = stdout.split('\0').filter(Boolean)
  assert(tracked.length > 0, 'clean-checkout pack requires a tracked source tree')
  for (const relative of tracked) {
    const target = join(destination, relative)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(source, relative), target)
  }
}

try {
  const { stdout } = await execute('npm', ['pack', '--ignore-scripts', '--json', '--cache', npmCache, '--pack-destination', temporary], {
    cwd: project, maxBuffer: 4 * 1024 * 1024,
  })
  const [packed] = JSON.parse(stdout)
  const files = packed.files.map(file => file.path)
  assert(files.includes('package.json'))
  assert(files.some(file => /^(lib|dist)\/.*\.js$/.test(file)), 'tarball must contain built JavaScript')
  assert(files.includes('lib/index.js'), 'tarball must contain the declared main entry lib/index.js')
  assert(files.includes('lib/client.js'), 'tarball must contain the declared browser bundle lib/client.js')
  assert(!files.some(file => /(^|\/)\.env($|\.)|(^|\/)node_modules\//.test(file)), 'tarball contains private/local files')
  // A clean checkout has no built lib/ (it is gitignored). Packing it with lifecycle
  // scripts enabled must run the prepack build hook and ship the declared entry points.
  const cleanCheckout = join(temporary, 'clean-checkout')
  await materializeTrackedTree(project, cleanCheckout)
  assert(!existsSync(join(cleanCheckout, 'lib')), 'clean checkout must start without built lib output')
  const dependencySource = join(project, 'node_modules')
  assert(existsSync(dependencySource), 'clean-checkout pack needs the linked dependencies (run npm run link:dsh first)')
  await symlink(await realpath(dependencySource), join(cleanCheckout, 'node_modules'), 'dir')
  const cleanPack = join(temporary, 'clean-pack')
  await mkdir(cleanPack)
  await execute('npm', ['pack', '--cache', npmCache, '--pack-destination', cleanPack], {
    cwd: cleanCheckout, timeout: 180_000, maxBuffer: 4 * 1024 * 1024,
  })
  const cleanTarballs = (await readdir(cleanPack)).filter(entry => entry.endsWith('.tgz'))
  assert.equal(cleanTarballs.length, 1, 'clean-checkout npm pack must produce exactly one tarball')
  const listing = (await execute('tar', ['-tzf', join(cleanPack, cleanTarballs[0])], { maxBuffer: 16 * 1024 * 1024 }))
    .stdout.split('\n').filter(Boolean)
  assert(listing.includes('package/lib/index.js'), 'clean-checkout pack must run prepack and include lib/index.js')
  assert(listing.includes('package/lib/client.js'), 'clean-checkout pack must run prepack and include lib/client.js')
  process.stdout.write(`Clean-checkout pack ran prepack and contains both declared entry points (${listing.length} archive entries).\n`)
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
  await assertSandboxPrerequisite('npm run test:pack')
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
