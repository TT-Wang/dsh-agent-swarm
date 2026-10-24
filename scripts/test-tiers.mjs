#!/usr/bin/env node
/**
 * The behavioral suite (`tests/*.test.mjs`, node:test) in two tiers, by what a
 * file needs beyond this repository:
 *
 * - hermetic: only the packages `npm ci` installs from package-lock.json, so it
 *   runs from a fresh clone with no Harness checkout. `npm test` runs it.
 * - host: a built Harness checkout of the supported release as well
 *   (DSH_HARNESS_ROOT, scripts/harness-target.mjs), because the file boots a
 *   real host from that checkout. `npm run test:bundle` runs it.
 *
 * A file is in the host tier only by being listed in HOST_TIER; every other
 * `tests/*.test.mjs` is hermetic. The hermetic tier runs as a fresh clone would:
 * DSH_HARNESS_ROOT and DSH_SOURCE are removed from its environment and
 * DSH_SWARM_TEST_TIER=hermetic stops harness-target's search for a checkout,
 * so a hermetic file that reaches for one fails on every machine. The host
 * tier's environment never carries that marker. Nor does the hermetic tier run
 * from a checkout with a node_modules directory above it (ancestorNodeModules):
 * it exits 2 before any file runs.
 *
 *   node scripts/test-tiers.mjs <hermetic|host> [node --test options]
 *   node scripts/test-tiers.mjs <hermetic|host> --list
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TIER_ENV } from './harness-target.mjs'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The node_modules directories above `project`, by its path as given and by
 * its real path. Node and TypeScript look for a package in the node_modules of
 * every directory above the file that imports it, and npm puts each one's
 * `.bin` on a script's PATH, so a package or tool `npm ci` did not install is
 * found in any of them: a run in such a checkout is not a fresh clone's,
 * whatever it passes. On 2026-10-24 a clean clone under /private/tmp passed the
 * typecheck and this tier only because /private/tmp/node_modules linked to a
 * full install, while CI's fresh clone failed the typecheck.
 */
export function ancestorNodeModules(project = PROJECT) {
  const found = new Set()
  for (const start of new Set([resolve(project), realpathSync(project)])) {
    for (let directory = dirname(start); ; directory = dirname(directory)) {
      const candidate = join(directory, 'node_modules')
      try { if (statSync(candidate).isDirectory()) found.add(candidate) } catch {}
      if (dirname(directory) === directory) break
    }
  }
  return [...found]
}

/** Why a run in `project` would not be a fresh clone's, or undefined when nothing above it supplies packages. */
export function ancestorRefusal(project = PROJECT) {
  const found = ancestorNodeModules(project)
  if (!found.length) return undefined
  return `${found.join(', ')} ${found.length === 1 ? 'is' : 'are'} above this checkout. Node and TypeScript find a package npm ci did not install in any node_modules above the file that imports it, so a run here is not a fresh clone's: remove ${found.length === 1 ? 'it' : 'them'}, or use a checkout with none above it.`
}

/** What each tier needs from the machine it runs on. */
export const TIERS = {
  hermetic: 'the packages npm ci installs from package-lock.json',
  host: 'a built Harness checkout of the supported release (DSH_HARNESS_ROOT), linked with npm run link:dsh',
}

/** The node:test files that boot a real host from a built Harness checkout. */
export const HOST_TIER = ['tests/r17-profile.test.mjs']

/** The tier's files, relative to the project: the host tier's as HOST_TIER lists them, the hermetic tier's sorted by name. */
export function tierFiles(tier, project = PROJECT) {
  if (!Object.hasOwn(TIERS, tier)) throw new Error(`Unknown test tier ${JSON.stringify(tier)}; the tiers are ${Object.keys(TIERS).join(', ')}`)
  for (const file of HOST_TIER) if (!existsSync(join(project, file))) throw new Error(`The host tier lists ${file}, which does not exist`)
  if (tier === 'host') return [...HOST_TIER]
  return readdirSync(join(project, 'tests')).filter(name => name.endsWith('.test.mjs')).sort()
    .map(name => `tests/${name}`).filter(file => !HOST_TIER.includes(file))
}

/**
 * The environment a tier's run gets. The tier marker is set by the tier, never
 * inherited: the hermetic tier has no Harness checkout to find, and the host
 * tier searches for its checkout even when started from a hermetic run or by an
 * operator who exported the marker.
 */
export function tierEnvironment(tier, env = process.env) {
  const environment = { ...env }
  delete environment[TIER_ENV]
  if (tier === 'hermetic') {
    delete environment.DSH_HARNESS_ROOT
    delete environment.DSH_SOURCE
    environment[TIER_ENV] = 'hermetic'
  }
  return environment
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tier, ...options] = process.argv.slice(2)
  let files
  try { files = tierFiles(tier) } catch (error) {
    process.stderr.write(`test-tiers: ${error.message}\n`)
    process.exit(2)
  }
  const refusal = tier === 'hermetic' ? ancestorRefusal() : undefined
  if (options.includes('--list')) {
    process.stdout.write(files.join('\n') + '\n')
  } else if (refusal) {
    process.stderr.write(`test-tiers: refusing the hermetic tier: ${refusal}\n`)
    process.exit(2)
  } else {
    const child = spawn(process.execPath, ['--test', ...options, ...files], { cwd: PROJECT, env: tierEnvironment(tier), stdio: 'inherit' })
    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal)
      else process.exit(code ?? 1)
    })
  }
}
