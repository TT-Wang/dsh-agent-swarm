/** Select a local released Harness without assuming one developer checkout name. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function resolveHarnessRoot(explicit) {
  const supplied = explicit ?? process.env.DSH_HARNESS_ROOT ?? process.env.DSH_SOURCE
  if (supplied) return realpathSync(resolve(supplied))
  for (const candidate of [join(homedir(), '.dsh/source/current'), join(project, '../deepseek-harness-rc1'), join(project, '../deepseek-harness-latest')]) {
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
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
