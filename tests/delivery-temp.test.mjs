/**
 * R15-F5 — the production temp root survives a hostile ambient root.
 *
 * `src/delivery.ts` created its scratch directory with a bare
 * `mkdtemp(path.join(tmpdir(), 'dsh-swarm-delivery-'))` while every fixture used
 * `tests/temp-root.mjs`. On a hostile ambient root — the host check sandbox
 * denies the member scratch root, a `TMPDIR` can be missing (ENOENT) or a file
 * (ENOTDIR), and a mode-0500 directory denies (EACCES) — the fixture falls back
 * and the production path died. Measured by verifier-2 (T2r2v) and reproduced
 * here before the fix: `TMPDIR=/nonexistent-swarm-tmp npm run test:faults -- --only F8`
 * failed with `ENOENT … mkdtemp`, 23/24 for the suite.
 *
 * The fix is one exported helper (`tempDirectory` in `src/delivery.ts`) that
 * production and `tests/temp-root.mjs` both use. This file is its pair test.
 *
 * CO-FIRING GUARDS, each with the test below that exercises the pair:
 *   1. the production temp-root fallback × the fixtures' `temp-root.mjs` policy —
 *      test 1 drives BOTH helpers under the same hostile roots, and requires the
 *      fallback directory, the per-call isolation and the cleanup of each.
 *   2. the fallback root × capture's dependency-link/ignored-path exclusion (a
 *      scratch directory must never be captured as work) — test 2 pins the
 *      git-ignored `.swarm/` root of the fixture helper, and test 3 proves on a
 *      real delivery that production anchors its own fallback inside the
 *      repository metadata (`.git/…`), which capture never reads, and leaves
 *      nothing in the worktree.
 *   3. the fault suite's F8 scenario — test 4 reruns F8 itself under a hostile
 *      ambient root and requires its validated `FAULT_OK` record; this is the
 *      scenario that was 23/24 before the fallback existed.
 *   4. the census's proof-path and compatibility-label coverage checks — those
 *      pair tests live in tests/reader-census.test.mjs, which the declared check
 *      runs beside this file.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { tempDirectory } from './temp-root.mjs'
import { parseFaultOk } from '../scripts/faults/record.mjs'

const execute = promisify(execFile)
const PROJECT = fileURLToPath(new URL('..', import.meta.url))
/** Physical checkout path: the child's `process.cwd()` resolves symlinks, and the fallback assertion compares against it. */
const ROOT = await realpath(PROJECT)
const LIB = pathToFileURL(join(ROOT, 'lib', 'delivery.js')).href
const FIXTURE_HELPER = pathToFileURL(join(ROOT, 'tests', 'temp-root.mjs')).href
/** A TMPDIR that does not exist: mkdtemp fails with ENOENT on every host. */
const MISSING_ROOT = '/nonexistent-swarm-tmp'

/** Spawn a node child without throwing, so a failure message can carry its output. */
function runNode(args, env, timeout = 240_000) {
  return new Promise(resolve => {
    execFile(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : error ? String(error.code) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })
}

const hostile = root => ({ TMPDIR: root, TMP: root, TEMP: root })

test('the shared fallback policy serves production and the fixtures under a missing, file and denied ambient root', async t => {
  const scratch = await tempDirectory('swarm-delivery-hostile-')
  t.after(async () => { await chmod(scratch, 0o700).catch(() => undefined); await rm(scratch, { recursive: true, force: true }) })
  const fileRoot = join(scratch, 'not-a-directory')
  await writeFile(fileRoot, 'a TMPDIR that is a file\n')
  const deniedRoot = join(scratch, 'denied')
  await mkdir(deniedRoot, { recursive: true })
  await chmod(deniedRoot, 0o500)

  // The probe imports the two helpers by absolute URL and calls each twice, so
  // isolation is observable as two distinct directories per helper.
  const probe = `
    const production = await import(${JSON.stringify(LIB)})
    const fixture = await import(${JSON.stringify(FIXTURE_HELPER)})
    const { stat } = await import('node:fs/promises')
    const paths = []
    for (const helper of [production.tempDirectory, fixture.tempDirectory]) {
      for (let index = 0; index < 2; index++) {
        const directory = await helper(index === 0 ? 'dsh-swarm-probe-' : 'swarm-probe-')
        if (!(await stat(directory)).isDirectory()) throw new Error('not a directory: ' + directory)
        paths.push(directory)
      }
    }
    process.stdout.write(JSON.stringify(paths))
  `
  const fallbackRoot = join(ROOT, '.swarm', 'test-tmp')
  const cases = [
    ['a missing ambient root (ENOENT)', MISSING_ROOT, true],
    ['an ambient root that is a file (ENOTDIR)', fileRoot, true],
    // A privileged host can write into a 0500 directory; that case asserts only
    // that the call still succeeds and stays isolated, and the hostile-root run
    // of the whole fault suite records the denial on this host as evidence.
    ['an ambient root that denies writes (EACCES)', deniedRoot, false],
  ]
  for (const [label, root, exactFallback] of cases) {
    const child = await runNode(['--input-type=module', '-e', probe], hostile(root))
    assert.equal(child.code, 0, `${label}: the probe must survive the hostile root: ${child.stderr.slice(0, 400)}`)
    const paths = JSON.parse(child.stdout.trim())
    assert.equal(paths.length, 4, `${label}: both helpers called twice`)
    assert.equal(new Set(paths).size, paths.length, `${label}: every scratch directory is isolated`)
    for (const directory of paths) {
      assert.ok(existsSync(directory), `${label}: ${directory} exists`)
      assert.notEqual(directory, root, `${label}: the scratch directory is not the root itself`)
      if (exactFallback) {
        assert.ok(!directory.startsWith(root + sep), `${label}: the denied root was not used: ${directory}`)
        assert.ok(directory.startsWith(fallbackRoot + sep), `${label}: fell back to the checkout-local root, got ${directory}`)
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('the fixture fallback root is the git-ignored `.swarm/`, so capture can never read a scratch directory as work', async () => {
  const ignore = await readFile(join(ROOT, '.gitignore'), 'utf8')
  assert.match(ignore, /^\.swarm\/$/m, 'the checkout-local fallback root must be declared ignored in .gitignore')
  const fallbackRoot = join(ROOT, '.swarm', 'test-tmp')
  assert.ok(fallbackRoot.startsWith(join(ROOT, '.swarm') + sep), 'the fixture fallback root lives under the ignored directory')
})

test('applyDelivery uses the shared fallback under a hostile ambient root, keeps its isolation and removes its scratch directory', async t => {
  const root = await realpath(await tempDirectory('swarm-delivery-prod-'))
  const source = join(root, 'source')
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  const git = async (...args) => (await execute('git', ['-c', 'user.name=Delivery Temp Test', '-c', 'user.email=delivery@localhost', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: source })).stdout.trim()
  await mkdir(source, { recursive: true })
  await git('init', '-b', 'main')
  await writeFile(join(source, 'value.cjs'), 'module.exports = 1\n')
  await git('add', '-A')
  await git('commit', '-m', 'baseline')
  const baselineCommit = await git('rev-parse', 'HEAD')
  await writeFile(join(source, 'value.cjs'), 'module.exports = 2\n')
  await git('add', '-A')
  await git('commit', '-m', 'result')
  const resultCommit = await git('rev-parse', 'HEAD')
  // The source working tree goes back to the baseline; delivery materializes the result.
  await git('checkout', '--detach', baselineCommit)

  const script = `
    const { applyDelivery } = await import(${JSON.stringify(LIB)})
    const result = await applyDelivery(${JSON.stringify({ source, baselineCommit, resultCommit })})
    process.stdout.write(JSON.stringify(result))
  `
  for (const ambient of [MISSING_ROOT, join(root, 'not-a-directory')]) {
    if (ambient !== MISSING_ROOT) await writeFile(ambient, 'a TMPDIR that is a file\n')
    const child = await runNode(['--input-type=module', '-e', script], hostile(ambient))
    assert.equal(child.code, 0, `applyDelivery must survive TMPDIR=${ambient}: ${child.stderr.slice(0, 600)}`)
    const applied = JSON.parse(child.stdout.trim())
    assert.equal(applied.status, 'applied', `applyDelivery applied under TMPDIR=${ambient}`)
    assert.deepEqual(applied.changedPaths, ['value.cjs'])
    assert.equal(await readFile(join(source, 'value.cjs'), 'utf8'), 'module.exports = 2\n', 'the result is materialized')
    // Production anchors the fallback inside its own private metadata directory
    // (inside `.git`), which capture never reads, and removes the scratch again.
    const metadataTmp = join(source, '.git', 'dsh-agent-swarm-delivery', 'tmp')
    assert.ok(existsSync(metadataTmp), `the delivery scratch root is the private metadata directory under TMPDIR=${ambient}`)
    assert.deepEqual(await readdir(metadataTmp), [], `the scratch directory is removed after the delivery under TMPDIR=${ambient}`)
    const fixtureRoot = join(ROOT, '.swarm', 'test-tmp')
    const strays = existsSync(fixtureRoot) ? (await readdir(fixtureRoot)).filter(name => name.startsWith('dsh-swarm-delivery-')) : []
    assert.deepEqual(strays, [], 'production never creates its scratch directory in the fixture fallback root')
  }
})

test('the fault suite F8 scenario passes with a hostile ambient root (the scenario that failed without the fallback)', async t => {
  const child = await runNode(['tests/faults/f08-crash-delivery.mjs'], hostile(MISSING_ROOT))
  const parsed = parseFaultOk(child.stdout, 'F8')
  assert.equal(parsed.error, undefined, `F8 must record a valid FAULT_OK under TMPDIR=${MISSING_ROOT}: ${parsed.error ?? ''}\n${child.stderr.slice(0, 600)}`)
  assert.equal(child.code, 0, `F8 exits cleanly under TMPDIR=${MISSING_ROOT}: ${child.stderr.slice(0, 400)}`)
  assert.equal(parsed.record.evidence.crashedAfter, 'applied', 'the injected crash still lands after the delivery effect')
})
