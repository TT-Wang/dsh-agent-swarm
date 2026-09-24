/**
 * ENV regression: the declared-check envelope states the environment the host
 * check runs in, it is delivered with the assignment of an implementing and a
 * verifying attempt. swarm_verify compares that envelope with the environments
 * the host recorded on the declared checks it ran, binds acceptance to those
 * supporting host checks, and a failed check stays attributable from durable
 * state ahead of truncation.
 *
 * Both sides of the comparison are host-measured structs: the runtime builds the
 * envelope and runs the declared checks itself in a clean checkout. Nothing is
 * inferred from a member's command text, so a reviewer's own diagnostic can
 * neither veto nor rescue a verdict.
 *
 * Pre-fix head: `workspaces.checkEnvelope()` reported only the measured
 * concurrency, the assignment delivery carried no environment facts, a
 * verification accepted an artifact whose check environment differed from the
 * envelope's, and the bounded check output lost the failing test name, the TAP
 * summary and the stage that failed because they arrive after the bound.
 *
 * The check execution is real throughout: a committed `node --test` file that
 * fails, run through `Workspaces.verifyArtifact` in a clean verification
 * checkout, truncated at the host's output bound.
 *
 * R16-B: every fixture in this file uses `tests/temp-root.mjs`, because the host
 * check runner inherits TMPDIR from a directory its sandbox denies (the measured
 * round-15 shape: 2/22 pass, every fixture `mkdtemp` EPERM), and the declared
 * check itself now receives TMPDIR/TMP/TEMP inside the disposable checkout,
 * pinned by the R16-B tests below.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { compareCheckEnvironments } from '../lib/runtime.js'
import { checkTempEnvironment, runProcess } from '../lib/workspaces.js'
import { tempDirectory } from './temp-root.mjs'
import { subprocessSeam } from './subprocess-seam.mjs'
import { FakeWorkers, makeRepo, makeRuntime, makeWorkspaces } from './faults/harness.mjs'

const FIXTURE_TEST = 'tests/fixture-failing.test.mjs'
const DEFAULT_DEPENDENCY_DIRS = ['node_modules', '.venv', 'venv', 'vendor', '.tox']

/** A real failing node:test file whose interesting lines arrive after any small bound. */
const FAILING_SUITE = [
  "import test from 'node:test'",
  "import assert from 'node:assert/strict'",
  'for (let index = 0; index < 120; index += 1) test(`passing case ${index}`, () => { assert.equal(1, 1); console.log(`noise line ${index} `.repeat(24)) })',
  "test('the-real-failure', () => { assert.equal('actual', 'expected') })",
  '',
].join('\n')

/** The check the fixture declares: a named stage, then the real failing suite. */
const FAILING_CHECK = `echo "# stage: fixture-failing-suite" && node --test ${FIXTURE_TEST}`
/** Successful controls still inspect the real artifact under the host envelope. */
const PASSING_CHECK = 'test -s src/answer.txt'

/**
 * R16-B: a real check that fails unless TMPDIR/TMP/TEMP name one writable
 * directory inside the checkout it runs in. This is the measured round-15 shape:
 * the check sandbox is rooted at the checkout and denies the member scratch root
 * the session overlay names as TMPDIR, so every fixture `mkdtemp` died with EPERM.
 */
const TMP_PROBE = 'tests/tmp-root-probe.mjs'
const TMP_PROBE_CHECK = `node ${TMP_PROBE}`
const TMP_PROBE_SOURCE = [
  "import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'",
  "import { tmpdir } from 'node:os'",
  "import { join, sep } from 'node:path'",
  "const dir = process.env.TMPDIR",
  "const tmp = process.env.TMP",
  "const temp = process.env.TEMP",
  "if (!dir || !tmp || !temp) { console.error(`unset temp root TMPDIR=${dir} TMP=${tmp} TEMP=${temp}`); process.exit(3) }",
  "if (dir !== tmp || dir !== temp) { console.error(`temp roots disagree TMPDIR=${dir} TMP=${tmp} TEMP=${temp}`); process.exit(4) }",
  "if (tmpdir() !== dir) { console.error(`tmpdir()=${tmpdir()} TMPDIR=${dir}`); process.exit(5) }",
  "const cwd = process.cwd()",
  "if (dir !== cwd && !dir.startsWith(cwd + sep)) { console.error(`TMPDIR ${dir} is outside the checkout ${cwd}`); process.exit(6) }",
  "const probe = mkdtempSync(join(dir, 'swarm-tmp-probe-'))",
  "writeFileSync(join(probe, 'ok'), 'ok')",
  "rmSync(probe, { recursive: true, force: true })",
  "console.log(`tmp-root-ok ${dir}`)",
  '',
].join('\n')

/**
 * The check environment with an explicit HOME. The variables this suite itself
 * runs under are removed: a nested `node --test` inherits `NODE_TEST_CONTEXT`
 * and silently reports success without running the file, which the deployment's
 * own check env must not leak either (recorded as a hand-off, `checkEnv` is
 * authored by the adapter).
 */
const checkEnvFor = home => {
  const env = { ...process.env, HOME: home }
  for (const name of ['XDG_CACHE_HOME', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[name]
  return env
}

/** The environment facts of a directory that exists (a warm user cache) or does not. */
async function cacheHome(root, warm) {
  const home = path.join(root, 'check-home')
  await mkdir(path.join(home, '.cache'), { recursive: true })
  if (warm) await mkdir(path.join(home, '.cache', 'huggingface', 'models--fixture'), { recursive: true })
  return home
}

/**
 * A real source repository plus a real `Workspaces`. `checkEnv` decides the
 * environment the host check runs under, which the envelope states and the
 * executed check records.
 */
async function workspaceFixture(t, options = {}) {
  const { root: temp, source } = await makeRepo('swarm-check-envelope', { 'src/answer.txt': 'base\n', [FIXTURE_TEST]: FAILING_SUITE, [TMP_PROBE]: TMP_PROBE_SOURCE })
  const workspaces = makeWorkspaces(temp, {
    maxCheckOutputBytes: options.maxCheckOutputBytes ?? 4096,
    checkEnv: options.checkEnv ?? checkEnvFor(process.env.HOME),
    ...(options.checkConcurrency === undefined ? {} : { checkConcurrency: options.checkConcurrency }),
  })
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, workspaces }
}

/** The adapter the runtime drives, with every effectful workspace call really executed by `Workspaces`. */
class EnvelopeWorkers extends FakeWorkers {
  // Never idle (FakeWorkers' default): the fixture claims its tasks explicitly, so the tick must not race the test.
  constructor(workspaces) { super(); this.workspaces = workspaces; this.verifications = [] }
  async prepareWorkspace(mission, memberId) { return await this.workspaces.prepareWorkspace(mission, memberId) }
  async prepareTask(member, task, dependencies, reviewSource) { await this.workspaces.prepareTask(member, task, dependencies, reviewSource) }
  async captureArtifact(member, task) {
    await writeFile(path.join(member.workspace, 'src', 'answer.txt'), `answer ${task.id}\n`)
    return await this.workspaces.captureArtifact(member, task)
  }
  async verifyArtifact(member, source, artifact, signal) {
    const record = { memberId: member.id, sourceTaskId: source.id, checks: source.checks, results: [] }
    this.verifications.push(record)
    record.results = await this.workspaces.verifyArtifact(member, source, artifact, signal)
    return record.results
  }
  /**
   * ENV: the most recent completed check, read from the `CheckResult` rows the
   * host really returned (and that the runtime persists as `tool_runs`). A
   * check's own environment and attribution live on its row; `Workspaces` keeps
   * no second copy of them.
   */
  lastCheck() {
    for (const verification of [...this.verifications].reverse()) {
      const last = verification.results.at(-1)
      if (last !== undefined) return last
    }
    return undefined
  }
  checkEnvelope() { return this.workspaces.checkEnvelope() }
  async dispose() { await this.workspaces.dispose() }
}

/** One mission with an implementation task, an independently submitted artifact and N review tasks. */
async function missionFixture(t, options = {}) {
  const base = await workspaceFixture(t, options)
  const { runtime, workers, budget } = await makeRuntime(t, { workers: new EnvelopeWorkers(base.workspaces),
    config: { leaseMs: 120000, tickMs: 50, maxMessageChars: 20000, maxEvents: 500, maxTasksPerMember: 5, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100 } })
  await runtime.start()
  const owner = { sessionId: 'envelope-owner' }
  const mission = runtime.create(owner, { title: 'Envelope', objective: 'State the check environment', workspace: base.source, scope: ['**'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewers = []
  for (const name of options.reviewerNames ?? ['Reviewer']) reviewers.push(await runtime.addMember(owner, mission.id, { name, role: 'verification' }))
  const source = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Source', objective: 'Source', kind: 'implementation',
    scope: ['**'], acceptance: ['works'], checks: options.sourceChecks ?? [PASSING_CHECK], assigneeId: author.id })
  const sourceClaim = await runtime.claim({ sessionId: author.sessionId }, mission.id, source.id)
  await runtime.submit({ sessionId: author.sessionId }, mission.id, { taskId: source.id, attemptId: sourceClaim.attempt.id, output: 'ready for review' })
  const reviews = []
  for (const reviewer of reviewers) {
    const review = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: `Review ${reviewer.id}`, objective: 'Review', kind: 'verification',
      reviewOf: source.id, scope: ['**'], acceptance: ['works'], checks: options.reviewChecks ?? options.sourceChecks ?? [PASSING_CHECK], checkTimeoutMs: 30000, assigneeId: reviewer.id })
    const claim = await runtime.claim({ sessionId: reviewer.sessionId }, mission.id, review.id)
    reviews.push({ review, claim, reviewer })
  }
  return { ...base, runtime, workers, owner, mission, stream, author, source, sourceClaim, reviews,
    ready: () => runtime.store.get('tasks', source.id), events: () => runtime.store.events(mission.id, 2000),
    deliveries: () => runtime.store.list('deliveries', mission.id), toolRuns: () => runtime.store.list('tool_runs', mission.id) }
}

/* ------------------------------------------------------------------ *
 * The envelope records the environment the host check runs under.
 * ------------------------------------------------------------------ */

test('ENV: the envelope states HOME, the user cache roots, the sandbox policy and the dependency links', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await workspaceFixture(t, { checkEnv: checkEnvFor(home) })
  const envelope = fixture.workspaces.checkEnvelope()
  assert.equal(envelope.environment.home, home, 'the check HOME is recorded')
  assert.equal(envelope.environment.userCacheDir, path.join(home, '.cache'), 'the user cache directory is recorded')
  assert.equal(envelope.environment.huggingfaceCacheDir, path.join(home, '.cache', 'huggingface'), 'its huggingface subdirectory is recorded')
  assert.equal(envelope.environment.userCacheDirExists, true)
  assert.equal(envelope.environment.huggingfaceCacheDirExists, true, 'the warm model cache is reported as present')
  assert.equal(envelope.environment.sandboxPolicy.mode, 'workspace-write', 'the confinement policy is recorded')
  assert.equal(envelope.environment.sandboxPolicy.enforcement, 'full')
  assert.equal(envelope.environment.dependencyLinks.mode, 'copy', 'the effective dependency materialisation is recorded')
  assert.deepEqual(envelope.environment.dependencyLinks.dirs, DEFAULT_DEPENDENCY_DIRS)
  assert.match(envelope.environment.checkCacheRoot, /\.swarm-check-cache$/, 'the scoped cache root is declared')
  assert.equal(envelope.selfRunEnvironment.home, process.env.HOME, 'the self-run baseline is the ambient HOME')
  assert.notEqual(envelope.selfRunEnvironment.home, envelope.environment.home, 'this fixture is the divergence the guard must catch')
  // The measured concurrency envelope is unchanged by the environment facts.
  assert.equal(typeof envelope.limit, 'number')
})

test('ENV: dependency directory comparison uses sets without weakening membership or materialisation checks', () => {
  const environment = dirs => ({
    home: null, userCacheDir: null, huggingfaceCacheDir: null,
    userCacheDirExists: false, huggingfaceCacheDirExists: false, xdgCacheHome: null,
    sandboxPolicy: { mode: 'workspace-write', enforcement: 'full', workspaceRoot: null },
    dependencyLinks: { mode: 'copy', dirs }, checkCacheRoot: null, checkCacheRoots: {},
  })
  const declared = Object.freeze([...DEFAULT_DEPENDENCY_DIRS])
  const measured = Object.freeze([...declared].reverse().concat(declared[0]))
  assert.deepEqual(compareCheckEnvironments(environment(declared), environment(measured)).blocking, [],
    'enumeration order and duplicate declarations do not change the dependency set')
  assert.deepEqual(declared, DEFAULT_DEPENDENCY_DIRS, 'comparison leaves durable declarations unchanged')
  for (const dirs of [declared.slice(1), [...declared, 'extra']]) {
    const mismatches = compareCheckEnvironments(environment(declared), environment(dirs)).blocking
    assert.deepEqual(mismatches.map(item => item.field), ['dependencyLinks.dirs'], 'a genuine addition or removal still blocks')
  }
  const copied = environment(declared)
  const linked = { ...copied, dependencyLinks: { mode: 'link', dirs: [...declared].reverse() } }
  assert.deepEqual(compareCheckEnvironments(copied, linked).blocking.map(item => item.field), ['dependencyLinks.mode'],
    'copy and link remain distinct even when the directory sets agree')
  assert.deepEqual(compareCheckEnvironments(environment(['a, b', 'c']), environment(['a', 'b, c'])).blocking.map(item => item.field),
    ['dependencyLinks.dirs'], 'directory names containing the old display separator cannot conceal a changed set')
})

test('ENV: real host verification accepts dependency directories enumerated in Git order', async t => {
  const fixture = await missionFixture(t)
  const sourceRoot = fixture.mission.workspace
  // Materialise every declared candidate so this test isolates order from a
  // genuinely changed dependency set. Git enumerates these in lexical order.
  await writeFile(path.join(sourceRoot, '.git', 'info', 'exclude'), DEFAULT_DEPENDENCY_DIRS.map(name => `/${name}/`).join('\n') + '\n')
  for (const name of DEFAULT_DEPENDENCY_DIRS) {
    await mkdir(path.join(sourceRoot, name), { recursive: true })
    await writeFile(path.join(sourceRoot, name, 'fixture.txt'), 'installed dependency\n')
  }
  const reviewer = fixture.reviews[0]
  const accepted = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, {
    taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review with the declared dependencies',
  })
  assert.equal(accepted.status, 'accepted', 'passing host checks settle the review despite declaration/enumeration order')
  assert.equal(fixture.ready().status, 'accepted', 'the source verdict is persisted')
  const dependencies = fixture.workers.lastCheck().environment.dependencyLinks
  const measured = dependencies.materializedPaths
  assert.deepEqual(dependencies.dirs, DEFAULT_DEPENDENCY_DIRS, 'the configured candidates remain distinct from materialised paths')
  assert.deepEqual(measured, [...DEFAULT_DEPENDENCY_DIRS].sort(), 'the evidence retains the real Git enumeration order')
  assert.notDeepEqual(measured, DEFAULT_DEPENDENCY_DIRS, 'the regression exercises differing orders on the actual check path')
})

test('ENV: a partially installed dependency set preserves policy and verifies the actual toolchain', async t => {
  const fixture = await missionFixture(t, { sourceChecks: [PASSING_CHECK, 'test -s node_modules/fixture.txt'] })
  const sourceRoot = fixture.mission.workspace
  await writeFile(path.join(sourceRoot, '.git', 'info', 'exclude'), '/node_modules/\n')
  await mkdir(path.join(sourceRoot, 'node_modules'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'node_modules', 'fixture.txt'), 'installed dependency\n')
  const reviewer = fixture.reviews[0]
  const accepted = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, {
    taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review with the installed toolchain',
  })
  assert.equal(accepted.status, 'accepted', 'absent optional toolchain candidates do not create an environment mismatch')
  assert.equal(fixture.ready().status, 'accepted', 'the real host verdict settles the source')
  const observed = fixture.workers.lastCheck()
  assert.equal(observed.attribution.command, 'test -s node_modules/fixture.txt', 'the host check read the materialised dependency')
  assert.deepEqual(observed.environment.dependencyLinks.dirs, DEFAULT_DEPENDENCY_DIRS, 'the policy still permits all five candidates')
  assert.deepEqual(observed.environment.dependencyLinks.materializedPaths, ['node_modules'], 'the execution records only the directory actually installed')
})

test('ENV: a completed check records the environment it ran under and its attribution', async t => {
  const fixture = await workspaceFixture(t)
  const mission = { id: 'mission-one', workspace: fixture.source }
  const member = { id: 'member-one', missionId: mission.id, workspace: await fixture.workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'task-one', missionId: mission.id, epoch: 1, title: 'Check', kind: 'implementation', scope: ['**'], checks: [], status: 'running' }
  await fixture.workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'answer.txt'), '42\n')
  const artifact = await fixture.workspaces.captureArtifact(member, task)
  const results = await fixture.workspaces.verifyArtifact(member, { ...task, checks: [FAILING_CHECK] }, artifact)
  assert.equal(results[0].exitCode, 1, 'the fixture check really fails')
  assert.equal(results[0].environment.sandboxPolicy.mode, 'workspace-write', 'the check carries the environment it ran under')
  assert.notEqual(results[0].environment.checkCacheRoot, undefined)
  assert.equal(results[0].attribution.command, FAILING_CHECK, 'the row names the check it attributes')
  assert.deepEqual(results[0].attribution.failingTests, ['the-real-failure'], 'and the failure it attributed')
  assert.match(results[0].environment.checkCacheRoot, /verification/, 'the scoped cache root is inside a real verification checkout')
  assert.equal(fixture.workspaces.checkEnvelope().completed, 1, 'the run really passed through the semaphore')
  // Each verification returns its own rows, so a later passing check cannot
  // carry a stale attribution from an earlier failing run.
  const passing = await fixture.workspaces.verifyArtifact(member, { ...task, checks: ['test -d .'] }, artifact)
  assert.equal(passing[0].exitCode, 0)
  assert.deepEqual(passing[0].attribution.failingTests, [], 'the second run reports its own attribution')
  assert.notEqual(passing[0].environment.checkCacheRoot, results[0].environment.checkCacheRoot, 'and its own verification checkout')
})

/* ------------------------------------------------------------------ *
 * Attribution ahead of the output bound.
 * ------------------------------------------------------------------ */

test('ENV: the spec reporter Node 24 emits by default is attributed too, not just TAP', async t => {
  // Node 24's `node --test` writes the spec reporter even when piped (`✔`/`✖`/`ℹ`),
  // so reading TAP alone produced exit codes with NO attribution on a runtime
  // `engines` declares supported — the silent evidence loss the 2026-09-11 review
  // measured. This check forces the same reporter deterministically on any Node.
  const temp = await realpath(await tempDirectory('swarm-env-spec-'))
  t.after(async () => rm(temp, { recursive: true, force: true }))
  await mkdir(path.join(temp, 'tests'), { recursive: true })
  await writeFile(path.join(temp, FIXTURE_TEST), FAILING_SUITE)
  const command = `echo "▶ fixture-spec-suite" && node --test --test-reporter=spec ${FIXTURE_TEST}`
  const result = await runProcess(['/bin/sh', '-c', command], { subprocess: subprocessSeam, cwd: temp, timeoutMs: 30000, maxBytes: 4096, captureAttribution: true, env: checkEnvFor(process.env.HOME) })
  assert.equal(result.exitCode, 1, 'the run really fails')
  assert.deepEqual(result.attribution.failingTests, ['the-real-failure'], 'the spec failure marker is attributed')
  assert.equal(result.attribution.failingTestCount, 1)
  assert.ok(result.attribution.tapSummary.some(line => /^ℹ fail 1$/.test(line)), `the spec summary survives: ${JSON.stringify(result.attribution.tapSummary)}`)
  assert.ok(result.attribution.tapSummary.some(line => /^ℹ tests \d+$/.test(line)), 'the spec summary carries the test count')
  assert.equal(result.attribution.stage, 'fixture-spec-suite', 'the ▶ suite marker names the failing stage')
})

test('ENV: truncating a real failing run at the bound keeps the failing test, the TAP summary and the stage', async t => {
  const temp = await realpath(await tempDirectory('swarm-env-tap-'))
  t.after(async () => rm(temp, { recursive: true, force: true }))
  await mkdir(path.join(temp, 'tests'), { recursive: true })
  await writeFile(path.join(temp, FIXTURE_TEST), FAILING_SUITE)
  const result = await runProcess(['/bin/sh', '-c', FAILING_CHECK], { subprocess: subprocessSeam, cwd: temp, timeoutMs: 30000, maxBytes: 4096, captureAttribution: true, env: checkEnvFor(process.env.HOME) })
  assert.equal(result.exitCode, 1, 'the run really fails')
  assert.equal(result.truncated, true, 'the stored output was cut at the bound')
  assert(!result.output.includes('the-real-failure'), 'the bound removed the failing test name from the stored output')
  assert(!result.output.includes('# fail 1'), 'the bound removed the TAP summary from the stored output')
  assert.deepEqual(result.attribution.failingTests, ['the-real-failure'], 'the failing test name survives the bound')
  assert.equal(result.attribution.failingTestCount, 1)
  assert.ok(result.attribution.tapSummary.some(line => line === '# fail 1'), `the TAP summary survives: ${JSON.stringify(result.attribution.tapSummary)}`)
  assert.ok(result.attribution.tapSummary.some(line => /^# tests \d+$/.test(line)), 'the TAP summary carries the test count')
  assert.equal(result.attribution.stage, 'fixture-failing-suite', 'the stage that failed survives the bound')
  assert.equal(result.attribution.subtest, 'the-real-failure')
  assert.equal(result.attribution.outputTruncated, true)
})

test('ENV: a failed declared check is attributable from durable state ahead of the output', async t => {
  // The host runs the reviewed artifact's own declared checks (the source task's).
  const fixture = await missionFixture(t, { sourceChecks: [FAILING_CHECK], reviewChecks: [PASSING_CHECK] })
  const reviewer = fixture.reviews[0]
  const rejected = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'reject', reason: 'The declared check fails' })
  assert.equal(rejected.status, 'blocked', 'the failing declared check blocks the source')
  assert.match(rejected.output, /Host check failed/, 'the rejection carries the failing check')
  const row = fixture.toolRuns().find(run => run.tool === 'swarm.host_verification')
  assert.ok(row, 'the failing check has a durable tool-run row')
  const attribution = row.result.attribution
  assert.deepEqual(attribution.failingTests, ['the-real-failure'], 'the durable row names the failing test')
  assert.ok(attribution.tapSummary.includes('# fail 1'), 'the durable row carries the TAP summary line')
  assert.equal(attribution.stage, 'fixture-failing-suite', 'the durable row carries the stage that failed')
  assert.equal(row.result.truncated, true, 'the stored output really was truncated')
  assert(!row.result.output.includes('the-real-failure'), 'the failing test is beyond the stored output')
  const serialized = JSON.stringify(row.result)
  assert.ok(serialized.indexOf('"attribution"') < serialized.indexOf('"output"'), 'the attribution precedes the free-form output in the durable row')
  const rejection = fixture.events().filter(event => event.type === 'task/rejected').at(-1)
  assert.ok(rejection, 'the rejection is durable')
  assert.deepEqual(rejection.data.checkFailures[0].attribution.failingTests, ['the-real-failure'], 'the durable verdict event carries the failing test')
  assert.ok(JSON.stringify(rejection.data.checkFailures[0]).indexOf('"attribution"') < JSON.stringify(rejection.data.checkFailures[0]).indexOf('"output"'))
  // The measured envelope is durable too; the failing check's attribution lives
  // on its own tool-run row and the verdict event above, not a second copy here.
  const envelopeEvent = fixture.events().filter(event => event.type === 'task/check-envelope' && typeof event.data?.completed === 'number').at(-1)
  assert.ok(envelopeEvent, 'the measured envelope is durable')
  assert.equal(envelopeEvent.data.sourceTaskId, fixture.source.id, 'and names the task whose checks were measured')
})

/* ------------------------------------------------------------------ *
 * Delivery to the assignee of the implementing and the verifying attempt.
 * ------------------------------------------------------------------ */

test('ENV: the assignment of an implementing and a verifying attempt delivers the envelope facts', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(home) })
  const assignmentFor = taskId => fixture.deliveries().filter(delivery => delivery.kind === 'assignment' && delivery.taskId === taskId).at(-1)
  for (const [label, taskId] of [['implementing', fixture.source.id], ['verifying', fixture.reviews[0].review.id]]) {
    const delivery = assignmentFor(taskId)
    assert.ok(delivery, `${label} attempt has an assignment delivery`)
    const content = JSON.parse(delivery.content)
    const environment = content.checkEnvironment?.environment
    assert.ok(environment, `${label} assignment carries the declared-check envelope`)
    assert.equal(environment.home, home, `${label} assignment states HOME`)
    assert.equal(environment.userCacheDir, path.join(home, '.cache'), `${label} assignment states the user cache root`)
    assert.equal(environment.huggingfaceCacheDir, path.join(home, '.cache', 'huggingface'), `${label} assignment states the huggingface root`)
    assert.equal(environment.sandboxPolicy.mode, 'workspace-write', `${label} assignment states the sandbox policy`)
    assert.deepEqual(environment.dependencyLinks.dirs, DEFAULT_DEPENDENCY_DIRS, `${label} assignment states the dependency links`)
    assert.equal(content.checkEnvironment.selfRun.home, process.env.HOME, `${label} assignment states the self-run baseline`)
  }
})

/* ------------------------------------------------------------------ *
 * The envelope is compared with the environments the HOST recorded on
 * the declared checks. Both sides are host-measured structs: the runtime
 * constructs the envelope and runs the checks itself, so a reviewer's own
 * diagnostic command cannot move either side of this comparison.
 * ------------------------------------------------------------------ */

test('ENV: the supporting host checks are the environment the envelope is compared with', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(home) })
  const reviewer = fixture.reviews[0]
  // A reviewer diagnostic under a different HOME is recorded as an ordinary
  // tool run and carries no environment claim of its own.
  const runId = await fixture.workers.callbacks.toolRun(reviewer.reviewer.id, { tool: 'bash', arguments: { command: `HOME=/elsewhere node --test ${FIXTURE_TEST}` }, result: { output: 'ok' }, isError: false })
  assert.ok(runId, 'the diagnostic is recorded')
  assert.equal(fixture.runtime.store.get('tool_runs', runId).checkEnvironment, undefined, 'no environment is inferred from the command text')
  assert.equal((await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' })).status, 'accepted', 'the supporting host checks pass under the declared envelope')
  assert.equal(fixture.ready().status, 'accepted', 'an unrelated diagnostic does not veto the host check')
  const events = fixture.events().filter(event => event.type === 'task/check-envelope')
  const record = events.find(event => event.data?.reproduction === 'check-environment-mismatch')
  assert.ok(record, 'the comparison is durable')
  assert.equal(record.data.selfRunSource, 'host-check', 'the record names the host check as the compared execution')
  assert.equal(record.data.envelope.home, home, 'the envelope states the declared check HOME')
  assert.equal(record.data.selfRun.home, home, 'the host check really ran under it')
  assert.deepEqual(record.data.blocking, [], `a host check that reproduces the envelope blocks nothing: ${JSON.stringify(record.data.blocking)}`)
  assert.ok(fixture.workers.verifications.length >= 1, 'the host check really ran')
  const review = fixture.runtime.store.get('tasks', reviewer.review.id)
  assert.equal(review.status, 'accepted', 'the review is decided by its supporting host checks')
})

test('ENV: a cold user cache is recorded as advisory and never refuses an acceptance', async t => {
  const coldHome = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), false)
  t.after(async () => rm(path.dirname(coldHome), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(process.env.HOME) })
  // The envelope promises a warm cache root; the self-run facts (the ambient
  // host) do not have one. The paths agree, so this is advisory only.
  const envelope = fixture.workers.workspaces.checkEnvelope()
  const warm = { ...envelope.environment, huggingfaceCacheDirExists: true }
  const comparison = (await import('../lib/runtime.js')).compareCheckEnvironments(warm, { ...envelope.selfRunEnvironment, huggingfaceCacheDirExists: false })
  assert.deepEqual(comparison.blocking, [], 'a cache that went cold is not a wrong environment')
  assert.ok(comparison.advisory.some(field => field.field === 'huggingfaceCacheDirExists'), 'the cold cache is still reported')
  const reviewer = fixture.reviews[0]
  const accepted = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  assert.equal(accepted.status, 'accepted', 'an acceptance proceeds when the environment reproduces')
  assert.equal(fixture.ready().status, 'accepted')
  assert.equal(coldHome.length > 0, true)
})

/* ------------------------------------------------------------------ *
 * The guard's pairs: the check semaphore and the rejection path.
 * ------------------------------------------------------------------ */

test('ENV × check-semaphore: host acceptance after a queued check hands its slot back', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, {
    checkEnv: checkEnvFor(home),
    checkConcurrency: 1,
    reviewerNames: ['Reviewer A', 'Reviewer B'],
    sourceChecks: [`sleep 1.5 && ${PASSING_CHECK}`],
    reviewChecks: [PASSING_CHECK],
  })
  const outcomes = await Promise.allSettled(fixture.reviews.map((reviewer, index) =>
    fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: `Independent review ${index}` })))
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1, 'one exact review wins; the competing review is retired')
  assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1)
  const envelope = fixture.workers.workspaces.checkEnvelope()
  assert.equal(envelope.completed, 2, 'both declared checks ran')
  assert.equal(envelope.maxActive, 1, 'the semaphore serialized them')
  assert.ok(envelope.maxWaitMs > 0, `the second check was queued, saw maxWaitMs=${envelope.maxWaitMs}`)
  assert.equal(envelope.active, 0, 'the mismatch refusal left no slot held')
  assert.equal(envelope.queued, 0, 'the queue drained')
  assert.equal(fixture.ready().status, 'accepted', 'host success accepts the exact source')
})

test('ENV × rejection: a failing check still blocks the source and records the mismatch', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(home), sourceChecks: [FAILING_CHECK], reviewChecks: [PASSING_CHECK] })
  const reviewer = fixture.reviews[0]
  const rejected = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'reject', reason: 'The artifact fails its declared check' })
  assert.equal(rejected.status, 'blocked', 'the failing check blocks the verification task')
  assert.equal(fixture.ready().status, 'blocked', 'the failing check blocks the source')
  assert.match(rejected.output, /Host check failed/, 'the rejection names the failing check')
  const events = fixture.events()
  const rejection = events.filter(event => event.type === 'task/rejected').at(-1)
  assert.deepEqual(rejection.data.checkFailures[0].attribution.failingTests, ['the-real-failure'])
  const mismatch = events.filter(event => event.type === 'task/check-envelope').find(event => event.data?.reproduction === 'check-environment-mismatch')
  assert.ok(mismatch, 'the environment divergence is durable even on the rejection path')
  assert.ok(mismatch.data.attribution.failingTests.includes('the-real-failure'), 'the mismatch record carries the failing test')
  assert.equal(events.some(event => event.type === 'task/accepted'), false, 'the divergent environment accepted nothing')
})

test('ENV × rejection: an accept with a failing check is blocked by the failure, never accepted', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(home), sourceChecks: [FAILING_CHECK], reviewChecks: [PASSING_CHECK] })
  const reviewer = fixture.reviews[0]
  const verdict = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  assert.equal(verdict.status, 'blocked')
  assert.equal(fixture.ready().status, 'blocked', 'a failing declared check blocks the source even for an accept verdict')
  assert.equal(fixture.events().some(event => event.type === 'task/accepted'), false)
})

test('ENV: the scoped check roots are reported as advisory divergences, never silently ignored', async t => {
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(process.env.HOME) })
  const reviewer = fixture.reviews[0]
  const accepted = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  assert.equal(accepted.status, 'accepted', 'the roots the envelope provides never refuse an acceptance')
  const record = fixture.events().filter(event => event.type === 'task/check-envelope' && event.data?.reproduction === 'check-environment-mismatch').at(-1)
  assert.ok(record, 'the divergence is durable even when nothing blocks')
  assert.deepEqual(record.data.blocking, [], 'the provided scoped roots are not blocking')
  const fields = record.data.advisory.map(field => field.field)
  assert.ok(fields.includes('checkCacheRoot'), `the scoped cache root is named: ${JSON.stringify(fields)}`)
  assert.ok(fields.includes('checkCacheRoots'), `the package-manager roots are named: ${JSON.stringify(fields)}`)
  const scoped = record.data.advisory.find(field => field.field === 'checkCacheRoot')
  // The envelope names the placeholder checkout the assignee is told about; the
  // executed check names the disposable checkout it really ran in. Both values
  // are recorded, so the difference is visible rather than silently equal.
  assert.match(scoped.envelope, /\.swarm-check-cache$/, 'the envelope value names the provided root')
  assert.match(scoped.selfRun, /\.swarm-check-cache$/, 'the executed check names the root it really received')
  assert.notEqual(scoped.selfRun, scoped.envelope, 'the two roots are different directories, and both are shown')
  // A missing scoped root is still reported rather than hidden.
  const comparison = compareCheckEnvironments(
    { ...fixture.workers.workspaces.checkEnvelope().environment, checkCacheRoot: '/checkout/.swarm-check-cache' },
    { ...fixture.workers.workspaces.checkEnvelope().environment, checkCacheRoot: null })
  assert.deepEqual(comparison.blocking, [])
  assert.ok(comparison.advisory.some(field => field.field === 'checkCacheRoot' && field.selfRun === 'absent'), 'an execution with no scoped root is still reported')
})

/* ------------------------------------------------------------------ *
 * R16-B: the scoped temp root, the envelope decision, and the blocking half.
 * ------------------------------------------------------------------ */

test('R16-B: the scoped temp environment is one directory beside the cache roots', () => {
  assert.deepEqual(checkTempEnvironment('/checkout/.swarm-check-cache'), {
    TMPDIR: '/checkout/.swarm-check-cache/tmp',
    TMP: '/checkout/.swarm-check-cache/tmp',
    TEMP: '/checkout/.swarm-check-cache/tmp',
  })
})

test('R16-B: a real check runs with TMPDIR/TMP/TEMP inside the checkout even when the overlay names the member scratch root', async t => {
  const hostile = path.join(await realpath(await tempDirectory('swarm-hostile-scratch-')), 'member-scratch')
  await mkdir(hostile, { recursive: true, mode: 0o700 })
  t.after(async () => rm(path.dirname(hostile), { recursive: true, force: true }))
  const fixture = await missionFixture(t, {
    // The production shape: the adapter's per-member overlay names the member's
    // own scratch root as TMPDIR, and the check sandbox rooted at the checkout
    // denies it.
    checkEnv: { ...checkEnvFor(process.env.HOME), TMPDIR: hostile, TMP: hostile, TEMP: hostile },
    sourceChecks: [TMP_PROBE_CHECK],
  })
  const reviewer = fixture.reviews[0]
  const accepted = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent host checks validate the submitted artifact' })
  assert.equal(accepted.status, 'accepted', 'the probe check passes under the redirected temp root')
  const probe = fixture.toolRuns().filter(run => run.taskId === reviewer.review.id).at(-1)
  assert.match(String(probe.result.output), /tmp-root-ok /, 'the check itself observed the redirected temp root')
  // Pair: the scoped roots live in the disposable verification checkout, never in
  // the member worktree, so the capture path that excludes dependency links never
  // sees them and no artifact can record a check's temp state.
  await assert.rejects(stat(path.join(fixture.author.workspace, '.swarm-check-cache')), /ENOENT/, 'no scoped check root is written into the member worktree')
  // The envelope decision, made explicit: the scoped roots it records are still
  // exactly the five package-manager roots. TMPDIR/TMP/TEMP are deliberately not
  // envelope fields: a self-run cannot reproduce a disposable checkout path.
  const environment = fixture.workers.workspaces.checkEnvelope().environment
  assert.deepEqual(Object.keys(environment.checkCacheRoots).sort(), ['GOCACHE', 'PIP_CACHE_DIR', 'XDG_CACHE_HOME', 'YARN_CACHE_FOLDER', 'npm_config_cache'])
  assert.equal(Object.keys(environment).some(field => /temp|tmp/i.test(field)), false, 'no temp field is added to the delivered envelope')
  // The blocking half stays empty on this real accept path: the redirect is a
  // scoped root, exactly like the cache roots the comparison already treats as
  // advisory.
  const record = fixture.events().filter(event => event.type === 'task/check-envelope' && event.data?.reproduction === 'check-environment-mismatch').at(-1)
  assert.ok(record, 'the reproduction comparison is durable')
  assert.deepEqual(record.data.blocking, [], `the redirect adds no blocking divergence: ${JSON.stringify(record.data.blocking)}`)
})

/* ------------------------------------------------------------------ *
 * ENV-R2: every assignment for an attempt carries the envelope.
 * ------------------------------------------------------------------ */

test('ENV-R2: the budget-resume assignment carries the check envelope too', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(home) })
  const reviewer = fixture.reviews[0]
  const review = fixture.runtime.store.get('tasks', reviewer.review.id)
  review.budgetResume = { pauseId: 'pause-1', attemptId: review.attempt.id, epoch: review.epoch }
  fixture.runtime.store.put('tasks', review)
  const mission = fixture.runtime.store.get('missions', fixture.mission.id)
  mission.status = 'blocked'
  mission.reason = 'Aggregate mission budget exhausted: maxTokens'
  mission.budgetPause = { id: 'pause-1', quiesced: true }
  fixture.runtime.store.put('missions', mission)

  fixture.runtime.control(fixture.owner, fixture.mission.id, 'resume', 'Budget raised')
  const until = Date.now() + 5000
  let resumed
  while (Date.now() < until && resumed === undefined) {
    resumed = fixture.deliveries().find(delivery => delivery.kind === 'assignment' && delivery.taskId === reviewer.review.id
      && delivery.content.includes('Resume this same task and attempt'))
    if (resumed === undefined) await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.ok(resumed, 'the resumed attempt gets a fresh assignment delivery')
  const content = JSON.parse(resumed.content)
  assert.ok(content.checkEnvironment?.environment, 'the budget-resume assignment carries the declared-check envelope')
  assert.equal(content.checkEnvironment.environment.home, home, 'it states the check HOME')
  assert.deepEqual(content.checkEnvironment.environment.dependencyLinks.dirs, DEFAULT_DEPENDENCY_DIRS, 'it states the dependency links')
  assert.equal(content.checkEnvironment.selfRun.home, process.env.HOME, 'it states the self-run baseline')
  assert.equal(fixture.runtime.store.get('tasks', reviewer.review.id).status, 'running', 'the same attempt resumes')
})
