/** Select a local released Harness without assuming one developer checkout name. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { TIER_ENV } from './test-tiers.mjs'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/**
 * An explicit root is taken as given. Otherwise the candidates are the
 * installed source `~/.dsh/source/current`, then the sibling checkout named
 * for the release compatibility.json supports, without its dots and hyphens
 * (0.2.1-rc.2 is `deepseek-harness-021rc2`).
 * A candidate is taken only when it is a supported release and built (its CLI
 * entry exists), so an unbuilt checkout never shadows a built sibling.
 * The hermetic test tier (scripts/test-tiers.mjs) searches nowhere: it runs as
 * a fresh clone would, where no checkout exists.
 */
export function resolveHarnessRoot(explicit) {
  const supplied = explicit ?? process.env.DSH_HARNESS_ROOT ?? process.env.DSH_SOURCE
  if (supplied) return realpathSync(resolve(supplied))
  if (process.env[TIER_ENV] === 'hermetic') throw new Error('The hermetic test tier has no Harness checkout; a test that needs one belongs to the host tier (HOST_TIER in scripts/test-tiers.mjs)')
  const supported = new Set(JSON.parse(readFileSync(join(project, 'compatibility.json'), 'utf8')).supportedHosts.map(host => host.version))
  const siblings = [...supported].map(version => join(project, `../deepseek-harness-${version.replace(/[.-]/g, '')}`))
  for (const candidate of [join(homedir(), '.dsh/source/current'), ...siblings]) {
    const manifest = join(candidate, 'package.json')
    if (existsSync(manifest) && existsSync(join(candidate, 'apps/cli/lib/bin.js')) && supported.has(JSON.parse(readFileSync(manifest, 'utf8')).version)) return realpathSync(candidate)
  }
  throw new Error('Set DSH_HARNESS_ROOT to a built supported Harness checkout; see compatibility.json')
}

/** Verification binds each result to a released source revision, not just a version string. */
export function assertSupportedHarness(root, packageRoot = project) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  const compatibility = JSON.parse(readFileSync(join(packageRoot, 'compatibility.json'), 'utf8'))
  const target = compatibility.supportedHosts.find(host => host.version === version)
  assert(target, `Unsupported Harness ${version}; supported: ${compatibility.supportedHosts.map(host => host.version).join(', ')}`)
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  assert.equal(commit, target.commit, `Harness ${version} verification requires its declared release revision; do not label a newer master build as the release`)
  return { ...target, root, commit }
}
