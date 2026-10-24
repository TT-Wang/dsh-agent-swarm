/**
 * T1: one gate manifest, the `gate` block of package.json, that `npm run
 * verify`, the round gate and CI all run (scripts/gate.mjs).
 *
 * The 2026-10-22 self-review found the gate kept by hand in three places that
 * had drifted apart: verify ran eight commands, round.mjs gate hard-coded its
 * optional suites and so left out test:oracle (added in batch 15) although its
 * own comment said the list existed so that no suite could stay outside, and
 * promote took any record with `green: true`. test:isolation and test:load ran
 * in none of the batch gates kept outside the repository for six weeks. Here
 * every test:* script must be in the manifest, verify and the round gate must
 * run its one runner, and promote must read a record against the manifest of
 * the commit it promotes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withLocalImports } from './fixtures/local-imports.mjs'
import { PREREQUISITES, gateManifest, gateVerdict, planGate, probePrerequisites, readManifest } from '../scripts/gate.mjs'
import { TIERS, tierEnvironment } from '../scripts/test-tiers.mjs'

const PROJECT = fileURLToPath(new URL('..', import.meta.url))
const packageJson = JSON.parse(readFileSync(join(PROJECT, 'package.json'), 'utf8'))
const manifest = readManifest()
const OPT_IN = Object.keys(PREREQUISITES).filter(name => PREREQUISITES[name].optIn)
const [{ version: RELEASE }] = JSON.parse(readFileSync(join(PROJECT, 'compatibility.json'), 'utf8')).supportedHosts
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('the manifest lists every test:* script once, after typecheck and the hermetic tier, with prerequisites the gate defines', () => {
  const testScripts = Object.keys(packageJson.scripts).filter(name => name.startsWith('test:'))
  const suites = Object.keys(manifest)
  assert.deepEqual(suites.slice(0, 2), ['typecheck', 'test'], 'typecheck, then the build and the hermetic tier that every later suite reads lib/ from')
  assert.deepEqual([...suites.slice(2)].sort(), [...testScripts].sort(), 'every test:* script is a gate suite, and every gate suite after the first two is a test:* script')
  for (const [suite, needs] of Object.entries(manifest)) {
    assert.equal(new Set(needs).size, needs.length, `${suite} names a prerequisite twice`)
    if (needs.includes('browser')) assert.ok(needs.includes('harness'), `${suite} drives the checkout's Playwright, so it needs the checkout`)
  }
  // The two test tiers (scripts/test-tiers.mjs) are suites of the manifest, with the tiers' own prerequisites.
  assert.deepEqual(manifest.test, [], 'the hermetic tier needs only what npm ci installs')
  assert.deepEqual(manifest['test:bundle'], ['harness'], 'the host tier needs the built checkout')
  assert.equal(PREREQUISITES.harness.description, TIERS.host)
  // Billable and third-party suites never run by default, and a complete gate does not need them.
  assert.deepEqual(OPT_IN, ['provider', 'better-sidebar'])
  for (const suite of ['test:deepseek', 'test:command-deepseek']) assert.ok(manifest[suite].includes('provider'), `${suite} makes billable provider requests`)
  assert.ok(manifest['test:sidebar-service'].includes('better-sidebar'))
  for (const suite of ['test:oracle', 'test:isolation', 'test:load']) assert.ok(suite in manifest, `${suite} is a gate suite`)
})

test('gateManifest refuses a manifest that is missing or names what does not exist', () => {
  assert.throws(() => gateManifest({ scripts: { test: 'x' } }), /declares no gate manifest/)
  assert.throws(() => gateManifest({ scripts: { test: 'x' }, gate: { test: [], 'test:gone': [] } }), /lists test:gone, which package\.json does not define/)
  assert.throws(() => gateManifest({ scripts: { test: 'x' }, gate: { test: ['gpu'] } }), /names "gpu"; the prerequisites are harness, sandbox, browser, provider, better-sidebar/)
  assert.throws(() => gateManifest({ scripts: { test: 'x' }, gate: { test: 'harness' } }), /is not a list of prerequisites/)
})

test('npm run verify is the gate runner, and a suite runs exactly when it lacks no prerequisite', async () => {
  assert.equal(packageJson.scripts.verify, 'node scripts/gate.mjs')
  const all = Object.fromEntries(Object.keys(PREREQUISITES).map(name => [name, { present: true }]))
  assert.deepEqual(planGate(manifest, all).filter(suite => suite.missing.length), [], 'with every prerequisite, every suite runs')
  const none = planGate(manifest, {})
  assert.deepEqual(none.map(suite => suite.name), Object.keys(manifest), 'the plan keeps the manifest order')
  for (const suite of none) assert.deepEqual(suite.missing, manifest[suite.name])
  assert.deepEqual(none.filter(suite => !suite.missing.length).map(suite => suite.name), ['typecheck', 'test', 'test:packed', 'test:replay', 'test:oracle', 'test:load'], 'the suites a fresh clone runs')
})

test('the probe reads only the environment it is given: a fresh clone\'s finds no checkout and no browser, and a named checkout is used or stops the gate', async t => {
  // Probed in a fresh clone's environment, whatever environment runs this file
  // (a developer's shell exports DSH_HARNESS_ROOT): no checkout, so no browser
  // either, and an opt-in only when named. Only what a suite needs is probed.
  const fresh = tierEnvironment('hermetic')
  const needs = { 'test:host': ['harness'], 'test:web': ['harness', 'browser'], 'test:billable': ['provider'] }
  const found = await probePrerequisites(needs, [], fresh)
  assert.deepEqual(Object.keys(found), ['harness', 'browser', 'provider'], 'a prerequisite no suite needs is not probed')
  assert.equal(found.harness.present, false)
  assert.match(found.harness.reason, /hermetic test tier has no Harness checkout/)
  assert.deepEqual(found.browser, { present: false, reason: "the browser suites drive the Harness checkout's Playwright, and there is no checkout" })
  assert.deepEqual(found.provider, { present: false, reason: 'opt-in: run with --with provider' })
  assert.equal((await probePrerequisites(needs, ['provider'], fresh)).provider.present, true)

  // The same environment naming a checkout: the probe takes the one it names, whatever this process's environment says.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-probe-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const checkout = join(root, 'harness')
  mkdirSync(checkout)
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ version: RELEASE }))
  const host = { 'test:host': ['harness'] }
  assert.deepEqual(await probePrerequisites(host, [], { ...fresh, DSH_HARNESS_ROOT: checkout }), { harness: { present: true, root: checkout, version: RELEASE, commit: null } })
  // A named checkout that does not exist is the gate's configuration error, never a quiet skip.
  const missing = join(root, 'no-such-harness')
  await assert.rejects(probePrerequisites(host, [], { ...fresh, DSH_SOURCE: missing }), { message: new RegExp(`^DSH_HARNESS_ROOT or DSH_SOURCE names ${escape(missing)}, which the gate cannot use: ENOENT`) })
})

test('gateVerdict: a record is complete only when it lists the manifest and every suite a complete gate needs passed', () => {
  const small = { typecheck: [], 'test:host': ['harness'], 'test:billable': ['harness', 'provider'] }
  const record = (suites, extra = {}) => ({ commit: 'c1', dirty: false, prerequisites: { harness: { present: false, reason: 'no checkout here' }, provider: { present: false, reason: 'opt-in' } }, suites, ...extra })
  const pass = name => ({ name, status: 'pass', exitCode: 0 })
  const complete = record([pass('typecheck'), pass('test:host'), { name: 'test:billable', status: 'skipped', missing: ['provider'] }])
  assert.deepEqual(gateVerdict(small, complete, { commit: 'c1' }), { complete: true, problems: [], reasons: {} })
  // The record a dormant round gate wrote: green, and silent about which suites it ran.
  assert.deepEqual(gateVerdict(small, { commit: 'c1', green: true, results: [{ name: 'typecheck', exitCode: 0 }] }).problems, ["the record lists no suites: the gate manifest's runner (scripts/gate.mjs) did not write it"])
  assert.deepEqual(gateVerdict(small, record([pass('typecheck'), pass('test:billable')])).problems, ['the record lacks test:host, which the manifest lists'])
  assert.deepEqual(gateVerdict(small, record([...complete.suites, pass('test:old')])).problems, ['the record has test:old, which the manifest does not list'])
  const hostSkipped = gateVerdict(small, record([pass('typecheck'), { name: 'test:host', status: 'skipped', missing: ['harness'] }, pass('test:billable')]))
  assert.deepEqual([hostSkipped.problems, hostSkipped.reasons], [['test:host was skipped: no harness'], { harness: 'no checkout here' }])
  const bothSkipped = gateVerdict(small, record([pass('typecheck'), pass('test:host'), { name: 'test:billable', status: 'skipped', missing: ['harness', 'provider'] }]))
  assert.deepEqual([bothSkipped.problems, bothSkipped.reasons], [['test:billable was skipped: no harness, provider'], { harness: 'no checkout here', provider: 'opt-in' }], 'an opt-in suite that also lacked a host prerequisite is not excused')
  assert.deepEqual(gateVerdict(small, record([{ name: 'typecheck', status: 'fail', exitCode: 2 }, { name: 'test:host', status: 'not-run' }, pass('test:billable')])).problems, ['typecheck failed (exit 2)', 'test:host did not run: an earlier suite failed'])
  assert.deepEqual(gateVerdict(small, { ...complete, commit: 'c2', dirty: true }, { commit: 'c1' }).problems, ['the record is of commit c2, not c1', 'the record is of a tree with uncommitted changes, not of the commit alone'])
})

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Gate Test', '-c', 'user.email=gate@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** A scratch repository holding `entry` with its local imports and a package.json whose gate block is `gate`. */
async function scratchRepo(t, entry, scripts, gate) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-manifest-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  // As in the repository, node_modules is ignored: the round gate links it into its checkout.
  const files = { ...await withLocalImports(PROJECT, entry), 'compatibility.json': readFileSync(join(PROJECT, 'compatibility.json'), 'utf8'), '.gitignore': 'node_modules\n' }
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(source, path)), { recursive: true }); writeFileSync(join(source, path), content) }
  const commit = (scriptsNow, gateNow, message) => {
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'gate-fixture', version: '0.0.0', private: true, scripts: scriptsNow, gate: gateNow }, null, 2) + '\n')
    git(source, 'add', '-A'); git(source, 'commit', '-q', '-m', message)
    return git(source, 'rev-parse', 'HEAD')
  }
  git(source, 'init', '-q', '-b', 'main')
  return { root, source, head: commit(scripts, gate, 'baseline'), commit }
}

/** Run node as a fresh clone would (no checkout named, none searched for), whatever machine runs this file. */
const run = (args, cwd) => new Promise(resolve => {
  execFile(process.execPath, args, { cwd, env: tierEnvironment('hermetic'), timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })
  })
})

const ok = 'node -e ""'

test('the gate records every suite: passed, skipped with what it lacked, failed, or not run after a failure', async t => {
  const scripts = { typecheck: ok, test: ok, 'test:host': ok, 'test:broken': 'node -e "process.exit(3)"', 'test:after': ok, 'test:billable': ok }
  const repo = await scratchRepo(t, 'scripts/gate.mjs', scripts, { typecheck: [], test: [], 'test:host': ['harness'], 'test:broken': [], 'test:after': [], 'test:billable': ['provider'] })
  const recordPath = join(repo.root, 'record.json')
  const result = await run(['scripts/gate.mjs', '--record', recordPath], repo.source)
  assert.equal(result.code, 1, `a failed suite fails the run: ${result.stderr}`)
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  assert.equal(record.commit, repo.head)
  assert.equal(record.dirty, false)
  assert.equal(record.harness, null)
  assert.equal(record.green, false)
  assert.equal(record.complete, false)
  assert.deepEqual(record.suites.map(({ name, status, missing, exitCode }) => ({ name, status, ...(missing && { missing }), ...(exitCode !== undefined && { exitCode }) })), [
    { name: 'typecheck', status: 'pass', exitCode: 0 },
    { name: 'test', status: 'pass', exitCode: 0 },
    { name: 'test:host', status: 'skipped', missing: ['harness'] },
    { name: 'test:broken', status: 'fail', exitCode: 3 },
    { name: 'test:after', status: 'not-run' },
    { name: 'test:billable', status: 'skipped', missing: ['provider'] },
  ])
  assert.match(record.prerequisites.harness.reason, /hermetic test tier has no Harness checkout/)
  assert.match(result.stdout, /gate: 2 passed, 1 failed, 2 skipped, 1 not run/)
  assert.match(result.stdout, /skipped for:\n {2}harness: The hermetic test tier has no Harness checkout/)
  assert.match(result.stdout, /incomplete:\n {2}test:host was skipped: no harness\n {2}test:broken failed \(exit 3\)\n {2}test:after did not run: an earlier suite failed\n/)
})

test('the round gate runs the commit\'s own gate, and promote takes its record only when it is complete for that commit\'s manifest', async t => {
  const repo = await scratchRepo(t, 'scripts/round.mjs', { typecheck: ok, test: ok, 'test:host': ok }, { typecheck: [], test: [], 'test:host': ['harness'] })
  const lab = join(repo.root, 'lab')
  const round = (...args) => run([join(repo.source, 'scripts/round.mjs'), ...args, '--lab', lab], repo.source)
  const recordOf = sha => JSON.parse(readFileSync(join(lab, 'gates', `${sha}.json`), 'utf8'))

  // A host without the checkout: the gate records the skip, and neither it nor promote calls that complete.
  const incomplete = await round('gate', '--commit', repo.head)
  assert.equal(incomplete.code, 1, incomplete.stderr)
  const reported = JSON.parse(incomplete.stdout.slice(incomplete.stdout.lastIndexOf('{\n  "command"')))
  assert.deepEqual([reported.problems, reported.reasons], [['test:host was skipped: no harness'], { harness: recordOf(repo.head).prerequisites.harness.reason }])
  assert.deepEqual(recordOf(repo.head).suites.map(suite => [suite.name, suite.status]), [['typecheck', 'pass'], ['test', 'pass'], ['test:host', 'skipped']], 'the record lists the commit\'s manifest, in its order')
  const refused = await round('promote', '--commit', repo.head, '--dry-run')
  assert.equal(refused.code, 2)
  assert.match(refused.stderr, new RegExp(`the recorded gate for ${repo.head.slice(0, 12)} is not a complete gate of its manifest:\\n- test:host was skipped: no harness\\n- harness: The hermetic test tier has no Harness checkout`))

  // The next commit gives its host suite only an opt-in prerequisite: the same host now gates it completely.
  const next = repo.commit({ typecheck: ok, test: ok, 'test:host': ok }, { typecheck: [], test: [], 'test:host': ['provider'] }, 'opt-in host suite')
  const complete = await round('gate', '--commit', next)
  assert.equal(complete.code, 0, complete.stderr)
  const promoted = await round('promote', '--commit', next, '--dry-run')
  assert.equal(promoted.code, 0, promoted.stderr)
  assert.equal(JSON.parse(promoted.stdout).gated, true)

  // A record that is green but names no suites, as the round gate wrote until the manifest, proves nothing about them.
  const later = repo.commit({ typecheck: ok, test: ok, 'test:host': ok, 'test:oracle': ok }, { typecheck: [], test: [], 'test:host': ['provider'], 'test:oracle': [] }, 'a new suite')
  writeFileSync(join(lab, 'gates', `${later}.json`), JSON.stringify({ commit: later, green: true, results: [{ name: 'typecheck', exitCode: 0 }], at: 'then' }))
  const dormant = await round('promote', '--commit', later, '--dry-run')
  assert.equal(dormant.code, 2)
  assert.match(dormant.stderr, /the record lists no suites/)
  // Nor does a record of the previous manifest: the suite the commit added is not in it.
  writeFileSync(join(lab, 'gates', `${later}.json`), JSON.stringify({ ...recordOf(next), commit: later }))
  const stale = await round('promote', '--commit', later, '--dry-run')
  assert.equal(stale.code, 2)
  assert.match(stale.stderr, /the record lacks test:oracle, which the manifest lists/)
})

test('CI runs the same gate as a fresh clone: npm ci, then npm run verify, with no secrets, provider or opt-in', () => {
  const workflow = readFileSync(join(PROJECT, '.github/workflows/verify.yml'), 'utf8')
  const runs = [...workflow.matchAll(/^\s*(?:- )?run: (.+)$/gm)].map(match => match[1].trim())
  assert.deepEqual(runs, ['npm ci', 'npm run verify'])
  assert.doesNotMatch(workflow, /secrets\.|DEEPSEEK|DSH_HARNESS_ROOT|DSH_SOURCE|--with/)
  assert.match(workflow, /permissions:\n\s+contents: read/)
})
