/**
 * Drive one improvement round of the self-review loop.
 *
 * The swarm missions themselves are agent-driven; this script owns the
 * deterministic half so a round cannot skip them:
 *   gate    - prove a commit green in a clean checkout (typecheck, build, full
 *             unit suite, clean-pack assertion, plus every declared optional
 *             suite: test:faults, test:replay, test:load, test:isolation)
 *             before anything is promoted;
 *   mount   - build + preflight + restart the lab host from the linked checkout
 *             (never the controller host that serves the user's session);
 *   new     - open a round record;
 *   record  - close a round record and append the human ledger;
 *   status  - show the lab host and the current round.
 *
 * Usage:
 *   node scripts/round.mjs <gate|promote|mount|soak|new|record|status> [options]
 *
 * Common options: --lab <dir> (default ~/.dsh/agent-swarm-lab), --round <n>
 * gate:    --commit <sha> (default HEAD); --full adds the Loader composition,
 *          profile and pack smokes; --browser adds the live browser smokes
 * promote: --commit <sha> --dry-run; requires a recorded green gate for that
 *          exact commit and a clean tree in its paths; never commits by itself
 * mount:   --harness <dir> (default: inferred from the lab host)
 * soak:    verifies the lab is alive, loaded the plugin and started after the build
 * new:     --scope "one-line round scope"
 * record:  --gate pass|fail --revision <sha> --findings <n> --fixed <n> --notes "..."
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const command = args[0]
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const q = value => `'${String(value).replaceAll("'", `'\\''`)}'`
const lab = resolve(value('--lab', join(homedir(), '.dsh/agent-swarm-lab')))
const roundsPath = join(lab, 'rounds.json')
const ledgerPath = join(project, 'docs/improvement-rounds.md')
const readRounds = () => existsSync(roundsPath) ? JSON.parse(readFileSync(roundsPath, 'utf8')) : []
const writeRounds = rounds => { mkdirSync(lab, { recursive: true }); writeFileSync(roundsPath, JSON.stringify(rounds, null, 2) + '\n', { mode: 0o600 }) }
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const fail = message => { process.stderr.write(`round: ${message}\n`); process.exit(2) }
const stamp = () => new Date().toISOString()

if (!command || command === '--help' || command === '-h') { process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].slice(3) + '\n'); process.exit(0) }

if (command === 'status') {
  const server = existsSync(join(lab, 'server.json')) ? JSON.parse(readFileSync(join(lab, 'server.json'), 'utf8')) : undefined
  const rounds = readRounds()
  process.stdout.write(JSON.stringify({ lab, host: server ? { ...server, alive: alive(server.pid) } : null, rounds: rounds.slice(-3), roundCount: rounds.length }, null, 2) + '\n')
  process.exit(0)
}

if (command === 'new') {
  const round = Number(value('--round', String(readRounds().length + 1)))
  const rounds = readRounds().filter(entry => entry.round !== round)
  rounds.push({ round, scope: value('--scope', ''), status: 'open', openedAt: stamp() })
  writeRounds(rounds.sort((a, b) => a.round - b.round))
  process.stdout.write(JSON.stringify({ opened: round, scope: value('--scope', '') }, null, 2) + '\n')
  process.exit(0)
}

if (command === 'record') {
  const round = Number(value('--round', '0'))
  if (!round) fail('--round <n> is required')
  const record = {
    round,
    revision: value('--revision', ''),
    gate: value('--gate', 'fail'),
    findings: Number(value('--findings', '0')),
    fixed: Number(value('--fixed', '0')),
    notes: value('--notes', ''),
    recordedAt: stamp(),
  }
  const rounds = readRounds().filter(entry => entry.round !== round)
  rounds.push({ ...record, status: 'closed' })
  writeRounds(rounds.sort((a, b) => a.round - b.round))
  if (!existsSync(ledgerPath)) writeFileSync(ledgerPath, '# Improvement rounds\n\nEach round: audit -> implement -> independent verification -> integration -> gate -> mount on the lab host. Promote only when the gate is green.\n\n| Round | Revision | Gate | Findings | Fixed | Scope / notes |\n|---|---|---|---|---|---|\n')
  appendFileSync(ledgerPath, `| ${record.round} | \`${record.revision.slice(0, 12)}\` | ${record.gate} | ${record.findings} | ${record.fixed} | ${record.notes.replaceAll('|', '\\|')} |\n`)
  process.stdout.write(JSON.stringify(record, null, 2) + '\n')
  process.exit(0)
}

if (command === 'mount') {
  const server = existsSync(join(lab, 'server.json')) ? JSON.parse(readFileSync(join(lab, 'server.json'), 'utf8')) : undefined
  if (!server) fail(`no lab host provisioned at ${lab}; run: node scripts/start-lab.mjs`)
  const patch = existsSync(join(lab, 'lab.patch.yml')) ? join(lab, 'lab.patch.yml') : join(lab, 'preview.patch.yml')
  const harness = value('--harness', '')
  const update = join(project, 'scripts/update-preview.mjs')
  const argv = [update, '--preview', lab, '--no-sync', '--patch', patch, '--port', String(server.port), '--delay', value('--delay', '1500')]
  if (harness) argv.push('--harness', harness)
  const result = spawnSync(process.execPath, argv, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

if (command === 'gate') {
  const commit = value('--commit', 'HEAD')
  const sha = execFileSync('git', ['-C', project, 'rev-parse', commit], { encoding: 'utf8' }).trim()
  const checkout = mkdtempSync(join(tmpdir(), 'swarm-round-gate-'))
  const results = []
  const commands = [
    ['typecheck', 'npm run typecheck'],
    ['build', 'npm run build'],
    ['unit', 'node --test tests/*.test.mjs'],
    ['pack', 'npm pack --dry-run --json --cache "$(mktemp -d)" | node -e \'const d=JSON.parse(require("node:fs").readFileSync(0,"utf8"));const p=d[0].files.map(f=>f.path);if(!p.includes("lib/index.js")||!p.includes("lib/client.js")){console.error("tarball missing built code");process.exit(1)}\''],
    ...(args.includes('--full') || args.includes('--browser') ? [
      ['harness', 'npm run test:harness'],
      ['profile', 'npm run test:profile'],
      ['pack-smoke', 'npm run test:pack'],
    ] : []),
    ...(args.includes('--browser') ? [
      ['web', 'npm run test:web'],
      ['command-web', 'npm run test:command-web'],
    ] : []),
  ]
  try {
    // A real worktree, not a `git archive` extraction: the repository's own
    // acceptance commands include `npm run test:pack`, which materializes the
    // tracked tree with `git ls-files` and therefore needs a live repository.
    rmSync(checkout, { recursive: true, force: true })
    execFileSync('git', ['-C', project, 'worktree', 'add', '--detach', checkout, sha], { stdio: ['ignore', 'pipe', 'inherit'] })
    symlinkSync(join(project, 'node_modules'), join(checkout, 'node_modules'), 'dir')
    // Optional suites: run any the artifact declares, so a new suite cannot
    // silently stay outside the gate the way round-2's test:faults did.
    const optionalSuites = ['test:faults', 'test:replay', 'test:load', 'test:isolation']
    const declaredScripts = new Set(Object.keys(JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).scripts ?? {}))
    for (const name of optionalSuites) if (declaredScripts.has(name)) commands.push([name, `npm run ${name}`])
    for (const [name, shell] of commands) {
      const started = Date.now()
      const result = spawnSync('sh', ['-c', shell], { cwd: checkout, env: { ...process.env, npm_config_cache: join(checkout, '.npm-cache') }, stdio: 'inherit' })
      results.push({ name, exitCode: result.status ?? 1, durationMs: Date.now() - started })
      if ((result.status ?? 1) !== 0) break
    }
  } finally {
    spawnSync('git', ['-C', project, 'worktree', 'remove', '--force', checkout], { stdio: 'ignore' })
    spawnSync('git', ['-C', project, 'worktree', 'prune'], { stdio: 'ignore' })
    rmSync(checkout, { recursive: true, force: true })
  }
  const green = results.length === commands.length && results.every(result => result.exitCode === 0)
  mkdirSync(join(lab, 'gates'), { recursive: true })
  writeFileSync(join(lab, 'gates', `${sha}.json`), JSON.stringify({ commit: sha, green, results, at: stamp() }, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ command: 'gate', commit: sha, green, results }, null, 2) + '\n')
  process.exit(green ? 0 : 1)
}

if (command === 'promote') {
  const commit = value('--commit', 'HEAD')
  const sha = execFileSync('git', ['-C', project, 'rev-parse', commit], { encoding: 'utf8' }).trim()
  // The recorded green gate is the precondition, so refuse before any
  // history-dependent work: a shallow clone may not contain the artifact's
  // parent, and the refusal must still name the missing gate (fault F4).
  const gateFile = join(lab, 'gates', `${sha}.json`)
  const gate = existsSync(gateFile) ? JSON.parse(readFileSync(gateFile, 'utf8')) : undefined
  if (gate?.green !== true) fail(`no recorded green gate for ${sha.slice(0, 12)}; run: node scripts/round.mjs gate --commit ${sha.slice(0, 12)} --full`)
  // An integration artifact's parent may be an internal merge commit, so its
  // delta is not its content. --base names the mission baseline the artifact is
  // authoritative against; default stays the parent for simple task artifacts.
  const baseSpec = value('--base', `${sha}^`)
  let base
  try { base = execFileSync('git', ['-C', project, 'rev-parse', '--verify', `${baseSpec}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch { fail(`cannot resolve --base ${baseSpec}; a shallow clone may not contain the artifact's parent, so pass --base <commit> explicitly`) }
  const paths = execFileSync('git', ['-C', project, 'diff', '--name-only', base, sha], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const dirty = execFileSync('git', ['-C', project, 'status', '--porcelain', '--', ...paths], { encoding: 'utf8' }).trim()
  if (dirty) fail(`working tree is dirty in promoted paths:\n${dirty}`)
  if (args.includes('--dry-run')) { process.stdout.write(JSON.stringify({ command: 'promote', commit: sha, base, gated: true, paths, dryRun: true }, null, 2) + '\n'); process.exit(0) }
  // Exact content, not a patch: the artifact's tree is authoritative for these
  // paths, and a three-way cherry-pick would conflict when the artifact's parent
  // is an internal merge commit.
  const restore = spawnSync('git', ['-C', project, 'restore', `--source=${sha}`, '--staged', '--worktree', '--', ...paths], { stdio: 'inherit' })
  if ((restore.status ?? 1) !== 0) fail('applying the artifact failed; the working tree was left unchanged')
  process.stdout.write(JSON.stringify({ command: 'promote', commit: sha, base, applied: true, stagedPaths: paths, note: 'review and commit; nothing was committed automatically' }, null, 2) + '\n')
  process.exit(0)
}

if (command === 'soak') {
  const server = existsSync(join(lab, 'server.json')) ? JSON.parse(readFileSync(join(lab, 'server.json'), 'utf8')) : undefined
  if (!server) fail(`no lab host provisioned at ${lab}`)
  const lockPath = join(lab, 'swarm.sqlite.lock')
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : undefined
  const buildPath = join(project, 'lib/index.js')
  const buildMtime = existsSync(buildPath) ? statSync(buildPath).mtimeMs : 0
  const startedAt = server.startedAt ? Date.parse(server.startedAt) : 0
  const checks = [
    { name: 'host-alive', ok: alive(server.pid), detail: `pid ${server.pid}` },
    { name: 'plugin-loaded', ok: lock?.pid === server.pid, detail: `store lock owner ${lock?.pid ?? 'none'}` },
    { name: 'mounted-after-build', ok: startedAt > buildMtime, detail: `build ${new Date(buildMtime).toISOString()} < host ${server.startedAt}` },
  ]
  const launchUrl = existsSync(join(lab, 'launch.url')) ? readFileSync(join(lab, 'launch.url'), 'utf8').trim() : server.launchUrl
  if (launchUrl) {
    const jar = join(lab, '.soak-cookies')
    const page = spawnSync('curl', ['-s', '-m', '10', '-L', '-c', jar, '-b', jar, launchUrl], { encoding: 'utf8' })
    const served = page.status === 0 && /dsh-agent-swarm\/client\.js/.test(page.stdout)
    checks.push({ name: 'client-bundle-served', ok: served, detail: served ? 'page references the swarm client bundle' : `curl exit ${page.status ?? 'n/a'}` })
  } else checks.push({ name: 'client-bundle-served', ok: false, detail: 'no launch url recorded' })
  const green = checks.every(check => check.ok)
  process.stdout.write(JSON.stringify({ command: 'soak', lab, green, checks }, null, 2) + '\n')
  process.exit(green ? 0 : 1)
}

fail(`unknown command ${JSON.stringify(command)}`)
