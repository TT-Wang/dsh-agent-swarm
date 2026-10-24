#!/usr/bin/env node
/**
 * The gate: every suite this repository checks itself with, from one manifest,
 * the `gate` block of package.json. Each entry is an npm script and the
 * prerequisites it needs beyond the packages `npm ci` installs (PREREQUISITES):
 * `[]` needs nothing more. The manifest lists every `test:*` script
 * (tests/gate-manifest.test.mjs), in the order a run takes them.
 *
 * `npm run verify` is this script. It runs, in manifest order, every suite
 * whose prerequisites are present, stops at the first failure, and writes a
 * record of the run: the commit, the Harness release and commit, each
 * prerequisite as found, and each suite as `pass`, `fail`, `skipped` (with the
 * prerequisites it lacked) or `not-run` (after a failure). Its exit status is
 * 1 when a suite failed. `node scripts/round.mjs gate` runs the gated commit's
 * own copy of this script in a clean checkout, and `promote` accepts its record
 * only when gateVerdict finds it complete for that commit's manifest.
 *
 * A prerequisite that is not opt-in is the machine's: it is probed, and a gate
 * is complete only when every suite that needs it ran. An opt-in prerequisite is
 * present only when the operator names it with --with, because its suites make
 * billable provider requests or need a third-party install; no run makes them
 * by default, and a complete gate does not need them.
 *
 * A Harness checkout named by DSH_HARNESS_ROOT or DSH_SOURCE that cannot be
 * found stops the run before any suite (exit 2): a named checkout is never
 * skipped quietly. The suites then run with DSH_HARNESS_ROOT set to the checkout
 * the probe found, so the record names the checkout every suite used.
 *
 *   node scripts/gate.mjs [--with provider,better-sidebar] [--record <file>] [--plan]
 *
 * --record defaults to artifacts/gate/<commit>.json; --plan probes and prints
 * the plan without running a suite or writing a record.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NamedHarnessRootError, resolveHarnessRoot } from './harness-target.mjs'
import { sandboxPrerequisite } from './sandbox-prerequisite.mjs'
import { TIERS } from './test-tiers.mjs'
import { launchSmokeBrowser } from './web-smoke-browser.mjs'

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * What a suite can need beyond `npm ci`, in the order they are probed (browser
 * after harness). A probe reads only the environment it is given.
 */
export const PREREQUISITES = {
  harness: {
    description: TIERS.host,
    probe: (found, env) => harnessPrerequisite(env),
  },
  sandbox: {
    description: 'the macOS sandbox, with a nested sandbox_apply permitted (scripts/sandbox-prerequisite.mjs)',
    probe: (found, env) => sandboxPrerequisite(env),
  },
  browser: {
    description: "a browser the Harness checkout's Playwright launches (DSH_SMOKE_BROWSER, default chrome)",
    probe: (found, env) => browserPrerequisite(found.harness, env),
  },
  provider: {
    description: 'a live DeepSeek provider key (DEEPSEEK_API_KEY): the suites make billable requests',
    optIn: true,
  },
  'better-sidebar': {
    description: 'an installed Better Sidebar 0.18.0 (DSH_BETTER_SIDEBAR_ROOT, else the web profile\'s)',
    optIn: true,
  },
}

/**
 * The manifest of a package.json: { script: [prerequisite, ...] } in run
 * order. Throws when it is missing or names a script or prerequisite that does
 * not exist, so no reader works from a malformed one.
 */
export function gateManifest(packageJson) {
  const gate = packageJson?.gate
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) throw new Error('package.json declares no gate manifest (its "gate" block)')
  for (const [script, needs] of Object.entries(gate)) {
    if (typeof packageJson.scripts?.[script] !== 'string') throw new Error(`the gate manifest lists ${script}, which package.json does not define`)
    if (!Array.isArray(needs)) throw new Error(`the gate manifest's entry for ${script} is not a list of prerequisites`)
    for (const need of needs) if (!Object.hasOwn(PREREQUISITES, need)) throw new Error(`the gate manifest's entry for ${script} names ${JSON.stringify(need)}; the prerequisites are ${Object.keys(PREREQUISITES).join(', ')}`)
  }
  return gate
}

/** The manifest of the package.json at `project` (this checkout by default). */
export const readManifest = (project = PROJECT) => gateManifest(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')))

/**
 * Probe the prerequisites the manifest needs, each once: { name: { present,
 * reason | detail } }. An opt-in prerequisite is present only when `optIns`
 * names it. Every probe reads `env`, the environment the suites will run in,
 * and nothing else: what is found depends on that input, not on the process
 * that probes.
 */
export async function probePrerequisites(manifest, optIns = [], env = process.env) {
  const needed = new Set(Object.values(manifest).flat())
  const found = {}
  for (const [name, prerequisite] of Object.entries(PREREQUISITES)) {
    if (!needed.has(name)) continue
    if (prerequisite.optIn) found[name] = optIns.includes(name) ? { present: true, detail: `named with --with ${name}` } : { present: false, reason: `opt-in: run with --with ${name}` }
    else found[name] = await prerequisite.probe(found, env)
  }
  return found
}

/** Each manifest suite with the prerequisites it lacks here: it runs when it lacks none. */
export function planGate(manifest, found) {
  return Object.entries(manifest).map(([name, needs]) => ({ name, needs: [...needs], missing: needs.filter(need => found[need]?.present !== true) }))
}

/**
 * Whether a run record is a complete gate of `manifest`: it lists exactly the
 * manifest's suites, and every suite passed, except one skipped only for
 * opt-in prerequisites the manifest gives it. With `commit`, the record must
 * also be of that commit and an unmodified tree. Returns { complete, problems,
 * reasons }: `reasons` is why the record found each prerequisite a problem's
 * skipped suite lacked.
 */
export function gateVerdict(manifest, record, { commit } = {}) {
  if (!Array.isArray(record?.suites)) return { complete: false, problems: ['the record lists no suites: the gate manifest\'s runner (scripts/gate.mjs) did not write it'], reasons: {} }
  const problems = [], reasons = {}
  if (commit !== undefined && record.commit !== commit) problems.push(`the record is of commit ${record.commit ?? 'none'}, not ${commit}`)
  if (commit !== undefined && record.dirty !== false) problems.push('the record is of a tree with uncommitted changes, not of the commit alone')
  const expected = Object.keys(manifest)
  const recorded = record.suites.map(suite => suite?.name)
  const lacking = expected.filter(name => !recorded.includes(name))
  const extra = recorded.filter(name => !expected.includes(name))
  if (lacking.length) problems.push(`the record lacks ${lacking.join(', ')}, which the manifest lists`)
  if (extra.length) problems.push(`the record has ${extra.join(', ')}, which the manifest does not list`)
  for (const suite of record.suites) {
    if (!expected.includes(suite?.name) || suite.status === 'pass') continue
    const missing = Array.isArray(suite.missing) ? suite.missing : []
    if (suite.status === 'skipped' && missing.length && missing.every(need => PREREQUISITES[need]?.optIn && manifest[suite.name].includes(need))) continue
    if (suite.status === 'skipped') {
      problems.push(`${suite.name} was skipped: ${missing.length ? `no ${missing.join(', ')}` : 'no missing prerequisite recorded'}`)
      for (const need of missing) reasons[need] = record.prerequisites?.[need]?.reason ?? 'no reason recorded'
    } else if (suite.status === 'fail') problems.push(`${suite.name} failed (exit ${suite.exitCode})`)
    else if (suite.status === 'not-run') problems.push(`${suite.name} did not run: an earlier suite failed`)
    else problems.push(`${suite.name} has status ${JSON.stringify(suite.status)}`)
  }
  return { complete: problems.length === 0, problems, reasons }
}

function harnessPrerequisite(env) {
  let root
  try { root = resolveHarnessRoot(undefined, env) } catch (error) {
    if (error instanceof NamedHarnessRootError) throw new GateConfigurationError(`DSH_HARNESS_ROOT or DSH_SOURCE names ${error.named}, which the gate cannot use: ${error.message}`)
    return { present: false, reason: error.message }
  }
  const version = (() => { try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null } catch { return null } })()
  return { present: true, root, version, commit: gitOutput(root, 'rev-parse', 'HEAD') }
}

async function browserPrerequisite(harness, env) {
  if (harness?.present !== true) return { present: false, reason: "the browser suites drive the Harness checkout's Playwright, and there is no checkout" }
  let browser
  try { browser = await launchSmokeBrowser(harness.root, env) } catch (error) {
    return { present: false, reason: `the checkout's Playwright launches no browser here: ${String(error?.message ?? error).split('\n')[0]}` }
  }
  const detail = `${browser.browserType().name()} ${browser.version()}`
  // A self-updating Chrome can hold the closed browser's pipes for minutes (docs/known-limitations.md); the probe does not wait for them.
  await Promise.race([browser.close(), new Promise(settle => setTimeout(settle, 10_000).unref())])
  return { present: true, detail }
}

class GateConfigurationError extends Error {}

function gitOutput(cwd, ...args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}

function parseArguments(argv) {
  const options = { optIns: [], record: undefined, plan: false }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--plan') options.plan = true
    else if (argument === '--record' && argv[index + 1]) options.record = resolve(argv[++index])
    else if (argument === '--with' && argv[index + 1]) options.optIns.push(...argv[++index].split(',').map(name => name.trim()).filter(Boolean))
    else throw new GateConfigurationError(`unknown argument ${JSON.stringify(argument)}; usage: node scripts/gate.mjs [--with provider,better-sidebar] [--record <file>] [--plan]`)
  }
  for (const name of options.optIns) if (!PREREQUISITES[name]?.optIn) throw new GateConfigurationError(`--with names ${JSON.stringify(name)}; the opt-in prerequisites are ${Object.keys(PREREQUISITES).filter(key => PREREQUISITES[key].optIn).join(', ')}`)
  return options
}

const seconds = ms => `${(ms / 1000).toFixed(1)} s`

/** One line per suite, then the reason for each prerequisite a skipped suite lacked. */
function suiteTable(suites, found) {
  const width = Math.max(...suites.map(suite => suite.name.length))
  const lines = suites.map(suite => {
    const tail = suite.missing?.length ? `no ${suite.missing.join(', ')}` : suite.durationMs === undefined ? '' : seconds(suite.durationMs)
    return `  ${suite.status.padEnd(8)} ${suite.name.padEnd(width)}  ${tail}`.trimEnd()
  })
  const lacked = [...new Set(suites.flatMap(suite => suite.missing ?? []))]
  if (lacked.length) lines.push('skipped for:', ...lacked.map(name => `  ${name}: ${found[name].reason}`))
  return lines
}

function summary(record, verdict, recordPath) {
  const counts = status => record.suites.filter(suite => suite.status === status).length
  return [
    '',
    `gate: ${counts('pass')} passed, ${counts('fail')} failed, ${counts('skipped')} skipped, ${counts('not-run')} not run (commit ${record.commit ?? 'unknown'}${record.dirty ? ', with uncommitted changes' : ''}; Harness ${record.harness ? `${record.harness.version} at ${record.harness.commit}` : 'none'})`,
    ...suiteTable(record.suites, record.prerequisites),
    ...(verdict.complete ? ['complete: every suite a complete gate needs passed'] : ['incomplete:', ...verdict.problems.map(problem => `  ${problem}`)]),
    `record: ${relative(process.cwd(), recordPath) || recordPath}`,
  ].join('\n') + '\n'
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const manifest = readManifest()
  // The tree is read before any suite runs: what a suite writes is not what was gated.
  const commit = gitOutput(PROJECT, 'rev-parse', 'HEAD')
  const status = commit === null ? null : gitOutput(PROJECT, 'status', '--porcelain')
  const found = await probePrerequisites(manifest, options.optIns, process.env)
  const plan = planGate(manifest, found)
  if (options.plan) {
    process.stdout.write(suiteTable(plan.map(suite => ({ ...suite, status: suite.missing.length ? 'skip' : 'run' })), found).join('\n') + '\n')
    return 0
  }
  // The suites run in the environment the probe read, with DSH_HARNESS_ROOT set to the checkout it found.
  const env = { ...process.env, ...(found.harness?.present ? { DSH_HARNESS_ROOT: found.harness.root } : {}) }
  const suites = []
  let failed = false
  for (const suite of plan) {
    if (suite.missing.length) { suites.push({ name: suite.name, needs: suite.needs, status: 'skipped', missing: suite.missing }); continue }
    if (failed) { suites.push({ name: suite.name, needs: suite.needs, status: 'not-run' }); continue }
    process.stdout.write(`\ngate: ${suite.name}\n`)
    const started = Date.now()
    const run = spawnSync('npm', ['run', suite.name], { cwd: PROJECT, env, stdio: 'inherit' })
    const exitCode = run.status ?? 1
    suites.push({ name: suite.name, needs: suite.needs, status: exitCode === 0 ? 'pass' : 'fail', exitCode, ...(run.signal ? { signal: run.signal } : {}), durationMs: Date.now() - started })
    failed ||= exitCode !== 0
  }
  const prerequisites = Object.fromEntries(Object.entries(found).map(([name, { root, version, commit, ...rest }]) => [name, rest]))
  const record = {
    commit, dirty: status === null ? null : status !== '',
    harness: found.harness?.present ? { root: found.harness.root, version: found.harness.version, commit: found.harness.commit } : null,
    node: process.version, platform: `${process.platform}-${process.arch}`, at: new Date().toISOString(),
    prerequisites, suites, green: !failed,
  }
  const verdict = gateVerdict(manifest, record)
  record.complete = verdict.complete
  const recordPath = options.record ?? join(PROJECT, 'artifacts/gate', `${commit ?? 'no-commit'}.json`)
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
  process.stdout.write(summary(record, verdict, recordPath))
  return failed ? 1 : 0
}

// Real paths on both sides: the round gate starts this file by an absolute path that can run through a
// symbolic link (macOS's /var is one), and the module's own URL is always the real one.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), error => {
    process.stderr.write(`gate: ${error instanceof GateConfigurationError ? error.message : error?.stack ?? error}\n`)
    process.exit(2)
  })
}
