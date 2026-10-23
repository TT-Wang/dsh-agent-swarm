/**
 * T2: the behavioral suite has two tiers in one manifest, scripts/test-tiers.mjs.
 * `npm test` runs the hermetic tier, which needs only what `npm ci` installs,
 * and runs it as a fresh clone would; `npm run test:bundle` runs the host tier,
 * whose files boot a real host from a built Harness checkout.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { HOST_TIER, TIERS, TIER_ENV, tierEnvironment, tierFiles } from '../scripts/test-tiers.mjs'

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

test('the hermetic tier runs as a fresh clone would: no checkout is named and the search is off', () => {
  const env = tierEnvironment('hermetic', { PATH: '/bin', DSH_HARNESS_ROOT: '/harness', DSH_SOURCE: '/source', DSH_HOME: '/home/dsh' })
  assert.deepEqual(env, { PATH: '/bin', DSH_HOME: '/home/dsh', [TIER_ENV]: 'hermetic' })
  assert.deepEqual(tierEnvironment('host', { DSH_HARNESS_ROOT: '/harness' }), { DSH_HARNESS_ROOT: '/harness' })
})

test('npm test runs the hermetic tier after the build, and test:bundle runs the host tier', () => {
  assert.equal(manifest.scripts.test, 'npm run build && node scripts/test-tiers.mjs hermetic')
  assert.equal(manifest.scripts['test:bundle'], 'node scripts/test-tiers.mjs host')
  const listed = execFileSync(process.execPath, ['scripts/test-tiers.mjs', 'host', '--list'], { cwd: PROJECT, encoding: 'utf8' })
  assert.deepEqual(listed.trim().split('\n'), HOST_TIER)
})
