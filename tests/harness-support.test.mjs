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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHarnessRoot as resolveFaultHarness } from './faults/loader.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))
const UNSUPPORTED = /Unsupported Harness 0\.1\.6-alpha\.2; supported: 0\.1\.5-rc\.3, 0\.1\.7-rc\.1/

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
  assert.match(allowed.stderr, /^update-preview: WARNING: Unsupported Harness 0\.1\.6-alpha\.2; supported: 0\.1\.5-rc\.3, 0\.1\.7-rc\.1/m)
  assert.match(allowed.stdout, /preflighting composed profile/)
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
  mkdirSync(join(copy, 'scripts'), { recursive: true })
  for (const script of ['round.mjs', 'host.mjs']) copyFileSync(join(project, 'scripts', script), join(copy, 'scripts', script))
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
