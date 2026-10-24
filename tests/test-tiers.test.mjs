/**
 * T2: the behavioral suite has two tiers in one manifest, scripts/test-tiers.mjs.
 * `npm test` runs the hermetic tier, which needs only what `npm ci` installs,
 * and runs it as a fresh clone would; `npm run test:bundle` runs the host tier,
 * whose files boot a real host from a built Harness checkout.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TIER_ENV } from '../scripts/harness-target.mjs'
import { withLocalImports } from './fixtures/local-imports.mjs'
import { HOST_TIER, TIERS, ancestorNodeModules, ancestorRefusal, tierEnvironment, tierFiles } from '../scripts/test-tiers.mjs'

const PROJECT = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the two tiers split tests/*.test.mjs: a file is in the host tier only by being listed there', () => {
  const all = readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.test.mjs')).map(name => `tests/${name}`).sort()
  const hermetic = tierFiles('hermetic'), host = tierFiles('host')
  assert.deepEqual(Object.keys(TIERS), ['hermetic', 'host'])
  assert.deepEqual(host, HOST_TIER)
  assert.deepEqual([...hermetic, ...host].sort(), all, 'every file is in exactly one tier')
  assert.ok(host.includes('tests/r17-profile.test.mjs'), 'r17-profile boots a real dsh host, so it is a host-tier file')
  assert.ok(hermetic.includes('tests/ui-clock.test.mjs'), 'a jsdom UI test needs no checkout')
  assert.throws(() => tierFiles('everything'), /Unknown test tier "everything"; the tiers are hermetic, host/)
})

test('the hermetic tier runs as a fresh clone would: no checkout is named and the search is off; the host tier never inherits that', () => {
  const env = tierEnvironment('hermetic', { PATH: '/bin', DSH_HARNESS_ROOT: '/harness', DSH_SOURCE: '/source', DSH_HOME: '/home/dsh' })
  assert.deepEqual(env, { PATH: '/bin', DSH_HOME: '/home/dsh', [TIER_ENV]: 'hermetic' })
  assert.deepEqual(tierEnvironment('host', { DSH_HARNESS_ROOT: '/harness' }), { DSH_HARNESS_ROOT: '/harness' })
  // A host-tier run started from a hermetic one, or by an operator who exported the variable, still searches for its checkout.
  assert.deepEqual(tierEnvironment('host', { PATH: '/bin', [TIER_ENV]: 'hermetic' }), { PATH: '/bin' })
})

test('npm test runs the hermetic tier after the build, and test:bundle runs the host tier', () => {
  assert.equal(manifest.scripts.test, 'npm run build && node scripts/test-tiers.mjs hermetic')
  assert.equal(manifest.scripts['test:bundle'], 'node scripts/test-tiers.mjs host')
  const listed = execFileSync(process.execPath, ['scripts/test-tiers.mjs', 'host', '--list'], { cwd: PROJECT, encoding: 'utf8' })
  assert.deepEqual(listed.trim().split('\n'), HOST_TIER)
})

test('the tier marker belongs to harness-target, which reads it: the operator scripts that select a release import no test runner', async () => {
  const closure = Object.keys(await withLocalImports(PROJECT, 'scripts/harness-target.mjs'))
  assert.ok(!closure.includes('scripts/test-tiers.mjs'), `harness-target imports ${closure.join(', ')}`)
  assert.ok(Object.keys(await withLocalImports(PROJECT, 'scripts/test-tiers.mjs')).includes('scripts/harness-target.mjs'), 'the runner takes the marker from harness-target')
})

/** A test file whose tests named `selected...` write the tier environment they saw to <project>/<name>.json, and whose other test writes unselected.json. */
const ENV_PROBE = name => `import test from 'node:test'
import { writeFileSync } from 'node:fs'
const seen = file => writeFileSync(new URL('../' + file + '.json', import.meta.url), JSON.stringify({ root: process.env.DSH_HARNESS_ROOT ?? null, source: process.env.DSH_SOURCE ?? null, tier: process.env.${TIER_ENV} ?? null }))
test('selected: the environment', () => seen(${JSON.stringify(name)}))
test('unselected', () => seen('unselected'))
`

test('the runner gives each tier its environment and its files, forwards node --test options, and exits with the run\'s failure', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-tiers-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    ...await withLocalImports(PROJECT, 'scripts/test-tiers.mjs'),
    'tests/a-hermetic.test.mjs': ENV_PROBE('hermetic'),
    'tests/b-failing.test.mjs': "import test from 'node:test'\ntest('selected: a failure', () => { throw new Error('this file fails') })\n",
    ...Object.fromEntries(HOST_TIER.map(file => [file, ENV_PROBE('host')])),
  }
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  const seen = name => existsSync(join(root, `${name}.json`)) ? JSON.parse(readFileSync(join(root, `${name}.json`), 'utf8')) : undefined
  // A caller that exported a checkout and the marker; no node:test context, so the runner's node --test runs its files.
  const caller = { PATH: process.env.PATH, HOME: process.env.HOME, DSH_HARNESS_ROOT: '/named/checkout', DSH_SOURCE: '/named/source', [TIER_ENV]: 'elsewhere' }
  const runner = tier => new Promise(done => execFile(process.execPath, ['scripts/test-tiers.mjs', tier, '--test-name-pattern=^selected'], { cwd: root, env: caller, timeout: 60_000 }, (error, stdout, stderr) => done({ code: error ? error.code : 0, output: `${stdout}${stderr}` })))

  const hermetic = await runner('hermetic')
  assert.equal(hermetic.code, 1, `a failing file fails the run: ${hermetic.output}`)
  assert.deepEqual(seen('hermetic'), { root: null, source: null, tier: 'hermetic' }, 'the hermetic tier runs as a fresh clone would, whatever the caller exported')
  assert.equal(seen('unselected'), undefined, 'the node --test options reach the run')
  assert.equal(seen('host'), undefined, 'a host-tier file is not in the hermetic tier')
  assert.match(hermetic.output, /this file fails/)

  rmSync(join(root, 'tests/b-failing.test.mjs'))
  const host = await runner('host')
  assert.equal(host.code, 0, host.output)
  assert.deepEqual(seen('host'), { root: '/named/checkout', source: '/named/source', tier: null }, 'the host tier keeps the caller\'s checkout and never the marker')
  assert.equal(seen('unselected'), undefined)
})

test('the hermetic tier refuses a checkout with node_modules above it, found by the path given or the real path, before any file runs; the host tier does not', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-tiers-ancestors-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.deepEqual(ancestorNodeModules(root), [], 'precondition: nothing above the temporary directory supplies packages')
  const project = join(root, 'outer', 'checkout')
  const files = { ...await withLocalImports(PROJECT, 'scripts/test-tiers.mjs'), 'tests/a-hermetic.test.mjs': ENV_PROBE('hermetic'), ...Object.fromEntries(HOST_TIER.map(file => [file, ENV_PROBE('host')])) }
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), content) }
  const seen = name => existsSync(join(project, `${name}.json`)) ? JSON.parse(readFileSync(join(project, `${name}.json`), 'utf8')) : undefined
  const runner = tier => new Promise(done => execFile(process.execPath, ['scripts/test-tiers.mjs', tier, '--test-name-pattern=^selected'], { cwd: project, env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 60_000 }, (error, stdout, stderr) => done({ code: error ? error.code : 0, output: `${stdout}${stderr}` })))

  assert.deepEqual(ancestorNodeModules(project), [])
  assert.equal(ancestorRefusal(project), undefined)
  const clean = await runner('hermetic')
  assert.equal(clean.code, 0, clean.output)
  assert.equal(seen('hermetic')?.tier, 'hermetic')
  rmSync(join(project, 'hermetic.json'))

  // A link to a full install above the checkout, as /private/tmp/node_modules was on 2026-10-24.
  const install = join(root, 'install')
  mkdirSync(install)
  const above = join(root, 'outer', 'node_modules')
  symlinkSync(install, above)
  assert.deepEqual(ancestorNodeModules(project), [above])
  const refused = await runner('hermetic')
  assert.equal(refused.code, 2, refused.output)
  assert.equal(refused.output, `test-tiers: refusing the hermetic tier: ${above} is above this checkout. Node and TypeScript find a package npm ci did not install in any node_modules above the file that imports it, so a run here is not a fresh clone's: remove it, or use a checkout with none above it.\n`)
  assert.equal(seen('hermetic'), undefined, 'no hermetic file ran')
  const host = await runner('host')
  assert.equal(host.code, 0, `the host tier runs on the checkout the host provides: ${host.output}`)
  assert.equal(seen('host')?.tier, null)
  assert.match(ancestorRefusal(project), /is above this checkout/)

  // A checkout reached through a link: the node_modules above its real path count, and so do those above the path given.
  const linked = join(root, 'elsewhere', 'checkout')
  mkdirSync(dirname(linked))
  symlinkSync(project, linked)
  assert.deepEqual(ancestorNodeModules(linked), [above], 'the node_modules above the real path')
  rmSync(above)
  mkdirSync(join(root, 'elsewhere', 'node_modules'))
  assert.deepEqual(ancestorNodeModules(linked), [join(root, 'elsewhere', 'node_modules')], 'the node_modules above the path given')
  assert.deepEqual(ancestorNodeModules(project), [])
  // Only a directory supplies packages: neither a file of that name nor a link to nothing does.
  writeFileSync(above, '')
  symlinkSync(join(root, 'gone'), join(root, 'node_modules'))
  assert.deepEqual(ancestorNodeModules(project), [])
  rmSync(join(root, 'node_modules'))
  mkdirSync(join(root, 'node_modules'))
  assert.match(ancestorRefusal(project), new RegExp(`^${join(root, 'node_modules').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is above this checkout\\. .* remove it, or`))
})
