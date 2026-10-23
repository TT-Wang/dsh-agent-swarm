/**
 * Every entry point that boots or composes a Harness refuses a checkout whose
 * release compatibility.json does not list, with harness-target's one message,
 * even when that checkout is supplied explicitly (--harness, DSH_HARNESS_ROOT).
 * The checkout here is a directory whose package.json says 0.1.6-alpha.2 and
 * whose CLI only exits 1: no dsh, no provider, no credential and no port is
 * used, and nothing reaches ~/.dsh (HOME is a scratch directory).
 * update-preview, and round mount through it, may proceed on such a checkout
 * only with --allow-unsupported-harness, and then warn.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHarnessRoot as resolveFaultHarness } from './faults/loader.mjs'
import { withLocalImports } from './fixtures/local-imports.mjs'
import { TIER_ENV } from '../scripts/harness-target.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
const compatibility = JSON.parse(readFileSync(join(project, 'compatibility.json'), 'utf8'))
/** harness-target's refusal of the 0.1.6-alpha.2 checkout below, naming the release compatibility.json supports. */
const UNSUPPORTED = new RegExp(`Unsupported Harness 0\\.1\\.6-alpha\\.2; supported: ${compatibility.supportedHosts.map(host => host.version).join(', ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

/** A scratch root holding an unsupported Harness checkout and a HOME. */
function scene(t) {
  const root = mkdtempSync(join(tmpdir(), 'harness-support-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const harness = join(root, 'harness-016')
  mkdirSync(join(harness, 'apps/cli/lib'), { recursive: true })
  writeFileSync(join(harness, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.1.6-alpha.2' }))
  writeFileSync(join(harness, 'apps/cli/lib/bin.js'), 'process.exit(1)\n')
  mkdirSync(join(root, 'home'))
  const env = { ...process.env, HOME: join(root, 'home'), DSH_HARNESS_ROOT: harness }
  for (const name of ['DSH_SOURCE', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) delete env[name]
  return {
    root, harness,
    run(argv, cwd = project) {
      return new Promise(resolve => execFile(process.execPath, argv, { cwd, env, timeout: 120_000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })))
    },
  }
}

const refusing = [
  ['test:harness', s => ['--expose-internals', join(project, 'tests/harness-composition.mjs'), '--harness', s.harness]],
  ['test:deepseek', s => ['--expose-internals', join(project, 'scripts/smoke-deepseek.mjs'), '--harness', s.harness]],
  ['test:command-deepseek', s => ['--expose-internals', join(project, 'scripts/smoke-command-deepseek.mjs'), '--harness', s.harness]],
  ['check-cancel-freeze', s => [join(project, 'scripts/check-cancel-freeze.mjs'), '--harness', s.harness, '--report', join(s.root, 'report.json')]],
  ['start-lab --dry-run', s => [join(project, 'scripts/start-lab.mjs'), '--root', join(s.root, 'lab'), '--port', '6199', '--harness', s.harness, '--dry-run']],
]
for (const [name, argv] of refusing) {
  test(`${name} refuses an explicitly supplied unsupported Harness with the one clear message`, async t => {
    const s = scene(t)
    const result = await s.run(argv(s))
    assert.notEqual(result.code, 0, `${name} accepted 0.1.6-alpha.2:\n${result.stdout}`)
    assert.match(result.stderr, UNSUPPORTED, `${name} must say why:\n${result.stderr}`)
  })
}

test('test:faults refuses a Tier B run with the one clear message before any scenario runs', async t => {
  const s = scene(t)
  const result = await s.run([join(project, 'scripts/faults/run.mjs'), '--only', 'F1,F3A'])
  assert.equal(result.code, 1)
  assert.match(result.stderr, /^faults: Unsupported Harness 0\.1\.6-alpha\.2/m)
  assert.doesNotMatch(result.stdout, /F1|F3A/, 'no scenario ran')
})

test('the fault loader refuses an explicit unsupported checkout instead of booting it', t => {
  const s = scene(t)
  assert.throws(() => resolveFaultHarness(s.harness), UNSUPPORTED)
})

test('update-preview refuses an unsupported Harness before building, and proceeds only with --allow-unsupported-harness, warning', async t => {
  const s = scene(t)
  const preview = join(s.root, 'preview')
  mkdirSync(preview)
  const argv = [join(project, 'scripts/update-preview.mjs'), '--preview', preview, '--harness', s.harness, '--no-sync', '--skip-build', '--dry-run', '--port', '6199']
  const refused = await s.run(argv)
  assert.equal(refused.code, 1, refused.stdout)
  assert.match(refused.stderr, UNSUPPORTED)
  assert.match(refused.stderr, /pass --allow-unsupported-harness/)
  assert.doesNotMatch(refused.stdout, /preflighting/, 'refused before the build and preflight')
  const allowed = await s.run([...argv, '--allow-unsupported-harness'])
  assert.equal(allowed.code, 0, allowed.stderr)
  assert.match(allowed.stderr, new RegExp(`^update-preview: WARNING: ${UNSUPPORTED.source}`, 'm'))
  assert.match(allowed.stdout, /preflighting composed profile/)
})

test('update-preview boots a plugin snapshot only on the release whose Harness SDK it links', async t => {
  const s = scene(t)
  const preview = join(s.root, 'preview')
  const plugin = join(preview, 'plugin')
  mkdirSync(join(plugin, 'node_modules/@deepseek-ai'), { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-external-agent-swarm', version: '0.0.0' }))
  const argv = [join(project, 'scripts/update-preview.mjs'), '--preview', preview, '--harness', s.harness, '--allow-unsupported-harness', '--skip-build', '--dry-run', '--port', '6199']
  // A snapshot without its own SDK link loads the host's packages.
  const unlinked = await s.run(argv)
  assert.equal(unlinked.code, 0, unlinked.stderr)
  assert.match(unlinked.stdout, /preflighting composed profile/)
  // start-preview links the snapshot's SDK packages to the checkout it started on (linkHarnessPeers).
  const sdk = (checkout, version) => {
    const directory = join(checkout, 'packages/core/session')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version }))
    return directory
  }
  const session = join(plugin, 'node_modules/@deepseek-ai/dsh-session')
  symlinkSync(sdk(join(s.root, 'harness-017'), '0.1.7-rc.1'), session, 'dir')
  const refused = await s.run(argv)
  assert.equal(refused.code, 1, refused.stdout)
  assert.match(refused.stderr, /plugin links the Harness 0\.1\.7-rc\.1 SDK, which the update keeps, so it boots only on Harness 0\.1\.7-rc\.1, not on 0\.1\.6-alpha\.2; start a new preview root for 0\.1\.6-alpha\.2/)
  assert.doesNotMatch(refused.stdout, /skipping build|syncing|preflighting/, 'refused before the build, sync and preflight')
  rmSync(session)
  symlinkSync(sdk(s.harness, '0.1.6-alpha.2'), session, 'dir')
  const same = await s.run(argv)
  assert.equal(same.code, 0, same.stderr)
  assert.match(same.stdout, /preflighting composed profile/)
})

test('round mount refuses an unsupported Harness through update-preview before building anything', async t => {
  const s = scene(t)
  const lab = join(s.root, 'lab')
  mkdirSync(lab)
  writeFileSync(join(lab, 'server.json'), JSON.stringify({ status: 'stopped', url: 'http://127.0.0.1:6199', port: 6199 }))
  const result = await s.run([join(project, 'scripts/round.mjs'), 'mount', '--lab', lab, '--harness', s.harness])
  assert.equal(result.code, 1, result.stdout)
  assert.match(result.stderr, UNSUPPORTED)
  assert.equal(existsSync(join(lab, 'restart.log')), false, 'no build, sync or restart was started')
})

test('round mount forwards --allow-unsupported-harness to update-preview, and only when given', async t => {
  const s = scene(t)
  const copy = join(s.root, 'project')
  for (const [path, source] of Object.entries(await withLocalImports(project, 'scripts/round.mjs'))) { mkdirSync(dirname(join(copy, path)), { recursive: true }); writeFileSync(join(copy, path), source) }
  writeFileSync(join(copy, 'scripts/update-preview.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
  const lab = join(s.root, 'lab')
  mkdirSync(lab)
  writeFileSync(join(lab, 'server.json'), JSON.stringify({ status: 'stopped', url: 'http://127.0.0.1:6199', port: 6199 }))
  const mount = async extra => {
    const result = await s.run([join(copy, 'scripts/round.mjs'), 'mount', '--lab', lab, '--harness', s.harness, ...extra], copy)
    assert.equal(result.code, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  assert.ok((await mount(['--allow-unsupported-harness'])).includes('--allow-unsupported-harness'))
  assert.ok(!(await mount([])).includes('--allow-unsupported-harness'))
})

test('the fault loader keeps the real cause for a supplied root it cannot use, and the generic message only for an empty default search', async t => {
  const s = scene(t)
  // A copy with no sibling checkouts and a scratch HOME, so the default search finds nothing.
  const copy = join(s.root, 'project')
  for (const [path, source] of Object.entries(await withLocalImports(project, 'tests/faults/loader.mjs'))) { mkdirSync(dirname(join(copy, path)), { recursive: true }); writeFileSync(join(copy, path), source) }
  copyFileSync(join(project, 'compatibility.json'), join(copy, 'compatibility.json'))
  for (const entry of ['lib', 'node_modules']) symlinkSync(join(project, entry), join(copy, entry))
  const probe = `import(${JSON.stringify(join(copy, 'tests/faults/loader.mjs'))}).then(({ resolveHarnessRoot }) => { try { resolveHarnessRoot(process.argv[1]); console.log('resolved') } catch (error) { console.log(error.message) } })`
  const missing = join(s.root, 'missing/harness')
  const resolve = async (explicit, env) => {
    const result = await new Promise(done => execFile(process.execPath, ['-e', probe, ...(explicit ? [explicit] : [])], { env: { PATH: process.env.PATH, HOME: join(s.root, 'home'), ...env } }, (error, stdout, stderr) => done({ error, stdout, stderr })))
    assert.equal(result.error, null, result.stderr)
    return result.stdout.trim()
  }
  for (const [label, message] of [
    ['DSH_HARNESS_ROOT', await resolve(undefined, { DSH_HARNESS_ROOT: missing })],
    ['DSH_SOURCE', await resolve(undefined, { DSH_SOURCE: missing })],
    ['an explicit root', await resolve(missing, {})],
  ]) {
    assert.match(message, new RegExp(`^The fault suite cannot use the Harness checkout ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: ENOENT`), `${label}: ${message}`)
    assert.doesNotMatch(message, /set DSH_HARNESS_ROOT/, label)
  }
  assert.equal(await resolve(undefined, {}), 'The fault suite needs a built Harness checkout; set DSH_HARNESS_ROOT (see compatibility.json)')
})

test('the default search takes a built checkout of the supported release and skips an unbuilt one or one of another release; the hermetic test tier searches nowhere', async t => {
  const s = scene(t)
  // harness-target resolves its siblings from its own project, so a copy puts them in the scratch root.
  const copy = join(s.root, 'project')
  for (const [path, source] of Object.entries(await withLocalImports(project, 'scripts/harness-target.mjs'))) { mkdirSync(dirname(join(copy, path)), { recursive: true }); writeFileSync(join(copy, path), source) }
  copyFileSync(join(project, 'compatibility.json'), join(copy, 'compatibility.json'))
  const [{ version: release }] = compatibility.supportedHosts
  const checkout = (dir, built, version = release) => {
    mkdirSync(join(dir, 'apps/cli/lib'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
    if (built) writeFileSync(join(dir, 'apps/cli/lib/bin.js'), '')
    return realpathSync(dir)
  }
  const unbuilt = checkout(join(s.root, 'unbuilt'), false)
  mkdirSync(join(s.root, 'home/.dsh/source'), { recursive: true })
  symlinkSync(unbuilt, join(s.root, 'home/.dsh/source/current'))
  const probe = `import(${JSON.stringify(join(copy, 'scripts/harness-target.mjs'))}).then(({ resolveHarnessRoot }) => { try { console.log(resolveHarnessRoot()) } catch (error) { console.log(error.message) } })`
  const resolve = (env = {}) => new Promise(done => execFile(process.execPath, ['-e', probe], { env: { PATH: process.env.PATH, HOME: join(s.root, 'home'), ...env } }, (error, stdout, stderr) => { assert.equal(error, null, stderr); done(stdout.trim()) }))
  const none = 'Set DSH_HARNESS_ROOT to a built supported Harness checkout; see compatibility.json'
  assert.equal(await resolve(), none, 'an unbuilt checkout alone is no candidate')
  // The supported release's sibling, built from a release that is no longer supported.
  const sibling = join(s.root, `deepseek-harness-${release.replace(/[.-]/g, '')}`)
  checkout(sibling, true, '0.1.7-rc.1')
  assert.equal(await resolve(), none, 'a built checkout of an unsupported release is no candidate, whatever its directory name')
  const built = checkout(sibling, true)
  assert.equal(await resolve(), built, 'the built sibling, not the unbuilt ~/.dsh/source/current ahead of it')
  // The hermetic tier runs as a fresh clone would: the built sibling is not found, and the
  // message names the tier, not a variable whose value the tier's runner removes.
  assert.equal(await resolve({ [TIER_ENV]: 'hermetic' }), 'The hermetic test tier has no Harness checkout; a test that needs one belongs to the host tier (HOST_TIER in scripts/test-tiers.mjs)')
  assert.equal(await resolve({ [TIER_ENV]: 'hermetic', DSH_HARNESS_ROOT: built }), built, 'a checkout the test supplies itself is taken as given')
})
