/**
 * ENV regression: the declared-check envelope states the environment the host
 * check runs in, it is delivered with the assignment of an implementing and a
 * verifying attempt, a verification whose self-run cannot reproduce it reports
 * the mismatch instead of accepting the artifact, and a failed check stays
 * attributable from durable state ahead of truncation.
 *
 * Pre-fix head: `workspaces.checkEnvelope()` reported only the measured
 * concurrency, the assignment delivery carried no environment facts, a
 * verification accepted an artifact whose self-run environment differed from the
 * check's, and the bounded check output lost the failing test name, the TAP
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
import { SwarmRuntime, compareCheckEnvironments, selfRunEnvironmentSource, selfRunEnvironmentFacts, SELF_RUN_EXTRACTOR_LIMITATIONS } from '../lib/runtime.js'
import { Workspaces, checkTempEnvironment, runProcess } from '../lib/workspaces.js'
import { tempDirectory } from './temp-root.mjs'
import { subprocessSeam } from './subprocess-seam.mjs'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
const FIXTURE_TEST = 'tests/fixture-failing.test.mjs'
const DEFAULT_DEPENDENCY_DIRS = ['node_modules', '.venv', 'venv', 'vendor', '.tox']

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}

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
 * environment the host check runs under, which is what a self-run must
 * reproduce.
 */
async function workspaceFixture(t, options = {}) {
  const temp = await realpath(await tempDirectory('swarm-check-envelope-'))
  const source = path.join(temp, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await mkdir(path.join(source, 'tests'), { recursive: true })
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await writeFile(path.join(source, FIXTURE_TEST), FAILING_SUITE)
  await writeFile(path.join(source, TMP_PROBE), TMP_PROBE_SOURCE)
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'fixture baseline')
  const workspaces = new Workspaces({ subprocess: subprocessSeam,
    workspacesRoot: path.join(temp, 'worktrees'),
    checkTimeoutMs: 30000,
    maxCheckOutputBytes: options.maxCheckOutputBytes ?? 4096,
    confineCheck: argv => argv,
    checkEnv: options.checkEnv ?? checkEnvFor(process.env.HOME),
    ...(options.checkConcurrency === undefined ? {} : { checkConcurrency: options.checkConcurrency }),
  })
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, workspaces }
}

/** The adapter the runtime drives, with every effectful workspace call really executed by `Workspaces`. */
class EnvelopeWorkers {
  constructor(workspaces) { this.workspaces = workspaces; this.verifications = []; this.binds = 0 }
  bind(callbacks) { this.callbacks = callbacks; this.binds++ }
  async prepareWorkspace(mission, memberId) { return await this.workspaces.prepareWorkspace(mission, memberId) }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return false } // the fixture claims its tasks explicitly, so the tick must not race the test
  async prepareTask(member, task, dependencies, reviewSource) { await this.workspaces.prepareTask(member, task, dependencies, reviewSource) }
  async captureArtifact(member, task) {
    await writeFile(path.join(member.workspace, 'src', 'answer.txt'), `answer ${task.id}\n`)
    return await this.workspaces.captureArtifact(member, task)
  }
  async verifyArtifact(member, source, artifact, signal) {
    this.verifications.push({ memberId: member.id, sourceTaskId: source.id, checks: source.checks })
    return await this.workspaces.verifyArtifact(member, source, artifact, signal)
  }
  checkEnvelope() { return this.workspaces.checkEnvelope() }
  async dispose() { await this.workspaces.dispose() }
}

/** One mission with an implementation task, an independently submitted artifact and N review tasks. */
async function missionFixture(t, options = {}) {
  const base = await workspaceFixture(t, options)
  const workers = new EnvelopeWorkers(base.workspaces)
  const directory = path.join(base.temp, 'state')
  await mkdir(directory, { recursive: true })
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'state.sqlite'), leaseMs: 120000, tickMs: 50, maxMessageChars: 20000, maxEvents: 500, maxTasksPerMember: 5 }, workers)
  await runtime.start()
  t.after(async () => { await runtime.dispose() })
  const owner = { sessionId: 'envelope-owner' }
  const mission = runtime.create(owner, { title: 'Envelope', objective: 'State the check environment', workspace: base.source, scope: ['**'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewers = []
  for (const name of options.reviewerNames ?? ['Reviewer']) reviewers.push(await runtime.addMember(owner, mission.id, { name, role: 'verification' }))
  const source = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Source', objective: 'Source', kind: 'implementation',
    scope: ['**'], acceptance: ['works'], checks: options.sourceChecks ?? ['true'], assigneeId: author.id })
  const sourceClaim = await runtime.claim({ sessionId: author.sessionId }, mission.id, source.id)
  await runtime.submit({ sessionId: author.sessionId }, mission.id, { taskId: source.id, attemptId: sourceClaim.attempt.id, output: 'ready for review' })
  const reviews = []
  for (const reviewer of reviewers) {
    const review = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: `Review ${reviewer.id}`, objective: 'Review', kind: 'verification',
      reviewOf: source.id, scope: ['**'], acceptance: ['works'], checks: options.reviewChecks ?? options.sourceChecks ?? ['true'], checkTimeoutMs: 30000, assigneeId: reviewer.id })
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
  const envelope = fixture.workspaces.checkEnvelope()
  assert.equal(envelope.observed.memberId, member.id)
  assert.equal(envelope.observed.taskId, task.id)
  assert.equal(envelope.observed.environment.checkCacheRoot, results[0].environment.checkCacheRoot, 'the observed facts are the run the semaphore produced')
  assert.match(envelope.observed.environment.checkCacheRoot, /verification/, 'the observed scoped cache root is inside a real verification checkout')
  // A later passing check replaces the observation: the envelope never carries a
  // stale attribution from an earlier failing run.
  const passing = await fixture.workspaces.verifyArtifact(member, { ...task, checks: ['true'] }, artifact)
  assert.equal(passing[0].exitCode, 0)
  assert.deepEqual(fixture.workspaces.checkEnvelope().observed.attribution.failingTests, [], 'the observation is the most recent check')
})

/* ------------------------------------------------------------------ *
 * Attribution ahead of the output bound.
 * ------------------------------------------------------------------ */

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
  const fixture = await missionFixture(t, { sourceChecks: [FAILING_CHECK], reviewChecks: ['true'] })
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
  const envelopeEvent = fixture.events().filter(event => event.type === 'task/check-envelope' && event.data?.observed !== undefined).at(-1)
  assert.ok(envelopeEvent, 'the measured envelope is durable')
  assert.deepEqual(envelopeEvent.data.observed.attribution.failingTests, ['the-real-failure'], 'the envelope carries the failing test')
  assert.ok(JSON.stringify(envelopeEvent.data.observed).indexOf('"attribution"') < JSON.stringify(envelopeEvent.data.observed).indexOf('"output"'), 'the envelope puts the attribution ahead of the output')
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
 * A self-run that cannot reproduce the envelope reports the mismatch.
 * ------------------------------------------------------------------ */

test('ENV: a verification whose self-run cannot reproduce the envelope reports the mismatch instead of accepting', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(home) })
  const reviewer = fixture.reviews[0]
  await assert.rejects(
    fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' }),
    error => {
      assert.equal(error.code, 'check_environment_mismatch')
      assert.match(error.message, /\[check_environment_mismatch\]/, 'the refusal carries a stable code')
      assert.match(error.message, /home: /, 'the refusal names the divergent field')
      assert.match(error.message, /swarm_verify/, 'the refusal names the executable exit')
      assert.ok(error.message.includes(`envelope ${home}`), `the refusal names the envelope value: ${error.message}`)
      assert.ok(error.message.includes(`self-run ${process.env.HOME}`), `the refusal names the self-run value: ${error.message}`)
      return true
    })
  assert.equal(fixture.ready().status, 'submitted', 'the artifact is not accepted under a different environment')
  const events = fixture.events().filter(event => event.type === 'task/check-envelope')
  const mismatch = events.find(event => event.data?.reproduction === 'check-environment-mismatch')
  assert.ok(mismatch, 'the mismatch is durable')
  assert.ok(mismatch.data.blocking.some(field => field.field === 'home'), `the durable record names the divergent field: ${JSON.stringify(mismatch.data.blocking)}`)
  assert.equal(mismatch.data.selfRunSource, 'host-ambient', 'the record names where the self-run facts came from')
  assert.equal(mismatch.data.envelope.home, home)
  assert.equal(mismatch.data.selfRun.home, process.env.HOME)
  assert.equal(fixture.ready().status, 'submitted')
  assert.ok(fixture.workers.verifications.length >= 1, 'the host check really ran before the refusal')
  const review = fixture.runtime.store.get('tasks', reviewer.review.id)
  assert.equal(review.status, 'running', 'the attempt survives so the reviewer can rerun under the envelope')
})

test('ENV: an attempt whose recorded tool runs cannot reproduce the envelope is reported with that evidence', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(home) })
  const reviewer = fixture.reviews[0]
  // The reviewer's own host-recorded self-run: the row carries the ambient facts.
  const runId = await fixture.workers.callbacks.toolRun(reviewer.reviewer.id, { tool: 'bash', arguments: { command: `node --test ${FIXTURE_TEST}` }, result: { output: 'ok' }, isError: false })
  assert.ok(runId, 'the self-run is recorded')
  const row = fixture.runtime.store.get('tool_runs', runId)
  assert.equal(row.checkEnvironment.home, process.env.HOME, 'the durable row carries the environment the self-run ran under')
  await assert.rejects(
    fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' }),
    error => {
      assert.equal(error.code, 'check_environment_mismatch')
      assert.match(error.message, /host-recorded tool runs/, 'the refusal names the self-run evidence')
      return true
    })
  const mismatch = fixture.events().filter(event => event.type === 'task/check-envelope').find(event => event.data?.reproduction === 'check-environment-mismatch')
  assert.equal(mismatch.data.selfRunSource, 'tool-run')
  assert.equal(mismatch.data.selfRun.home, process.env.HOME)
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

test('ENV × check-semaphore: a mismatch refusal after a queued check hands its slot back', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, {
    checkEnv: checkEnvFor(home),
    checkConcurrency: 1,
    reviewerNames: ['Reviewer A', 'Reviewer B'],
    sourceChecks: ['sleep 1.5 && true'],
    reviewChecks: ['true'],
  })
  const outcomes = await Promise.allSettled(fixture.reviews.map((reviewer, index) =>
    fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: `Independent review ${index}` })))
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 'rejected', 'the acceptance is refused under a non-reproducing environment')
    assert.equal(outcome.reason.code, 'check_environment_mismatch')
  }
  const envelope = fixture.workers.workspaces.checkEnvelope()
  assert.equal(envelope.completed, 2, 'both declared checks ran')
  assert.equal(envelope.maxActive, 1, 'the semaphore serialized them')
  assert.ok(envelope.maxWaitMs > 0, `the second check was queued, saw maxWaitMs=${envelope.maxWaitMs}`)
  assert.equal(envelope.active, 0, 'the mismatch refusal left no slot held')
  assert.equal(envelope.queued, 0, 'the queue drained')
  assert.equal(fixture.ready().status, 'submitted', 'nothing was accepted')
})

test('ENV × rejection: a failing check still blocks the source and records the mismatch', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(home), sourceChecks: [FAILING_CHECK], reviewChecks: ['true'] })
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
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(home), sourceChecks: [FAILING_CHECK], reviewChecks: ['true'] })
  const reviewer = fixture.reviews[0]
  const verdict = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  assert.equal(verdict.status, 'blocked')
  assert.equal(fixture.ready().status, 'blocked', 'a failing declared check blocks the source even for an accept verdict')
  assert.equal(fixture.events().some(event => event.type === 'task/accepted'), false)
})

/* ------------------------------------------------------------------ *
 * ENV-R: the self-run facts are the EXECUTED command's environment.
 * ------------------------------------------------------------------ */

test('ENV-R: the extractor reads only the environment a command declares for itself', async () => {
  const facts = source => Object.fromEntries(source.operations.map(operation => [operation.name, operation.value]))
  assert.deepEqual(facts(selfRunEnvironmentSource('HOME=/a npm test')), { HOME: '/a' }, 'a segment-initial assignment is read')
  assert.deepEqual(facts(selfRunEnvironmentSource('a && XDG_CACHE_HOME=/b b')), { XDG_CACHE_HOME: '/b' }, 'an assignment after && is read')
  assert.deepEqual(facts(selfRunEnvironmentSource('a || GOCACHE=/c c')), { GOCACHE: '/c' }, 'an assignment after || is read')
  assert.deepEqual(facts(selfRunEnvironmentSource('(HOME=/d; npm test)')), { HOME: '/d' }, 'an assignment after ( is read')
  assert.deepEqual(facts(selfRunEnvironmentSource('npm run x | HOME=/e node y')), { HOME: '/e' }, 'an assignment after | is read')
  assert.deepEqual(facts(selfRunEnvironmentSource('export PIP_CACHE_DIR=/f')), { PIP_CACHE_DIR: '/f' }, 'export is read')
  assert.deepEqual(facts(selfRunEnvironmentSource('env YARN_CACHE_FOLDER=/g npm test')), { YARN_CACHE_FOLDER: '/g' }, 'env arguments are read')
  assert.deepEqual(facts(selfRunEnvironmentSource("sh -c 'HOME=/h npm test'")), { HOME: '/h' }, 'a shell -c body is read')
  assert.deepEqual(facts(selfRunEnvironmentSource('env -u HOME node x')), { HOME: null }, 'env -u removes a name')
  assert.deepEqual(facts(selfRunEnvironmentSource('unset HOME')), { HOME: null }, 'unset removes a name')
  assert.deepEqual(facts(selfRunEnvironmentSource('HOME=/i VERSION=1 npm test')), { HOME: '/i' }, 'only the names the envelope records are kept')
  // The negative direction: a mention is not an override.
  assert.deepEqual(facts(selfRunEnvironmentSource('grep "HOME=/j" f')), {}, 'a quoted mention is an argument, not an override')
  assert.deepEqual(facts(selfRunEnvironmentSource("grep 'HOME=/k' f")), {}, 'a single-quoted mention is an argument')
  assert.deepEqual(facts(selfRunEnvironmentSource('echo HOME=/l')), {}, 'a non-initial word is an argument')
  assert.deepEqual(facts(selfRunEnvironmentSource('HOME=/m npm test 2>/dev/null')), { HOME: '/m' }, 'the assignment still reads with a trailing redirect')
  assert.equal(selfRunEnvironmentSource('env -i node x').cleared, true, 'env -i clears the environment')
  assert.equal(selfRunEnvironmentSource('HOME=/n npm test').cleared, false)
  assert.equal(selfRunEnvironmentSource(undefined).operations.length, 0, 'a tool with no command declares nothing')

  const ambient = { home: '/ambient', userCacheDir: '/ambient/.cache', huggingfaceCacheDir: '/ambient/.cache/huggingface',
    userCacheDirExists: true, huggingfaceCacheDirExists: true, xdgCacheHome: null,
    sandboxPolicy: { mode: 'workspace-write', enforcement: 'full', workspaceRoot: null },
    dependencyLinks: { mode: 'copy', dirs: [] }, checkCacheRoot: null, checkCacheRoots: {} }
  const overridden = selfRunEnvironmentFacts(ambient, selfRunEnvironmentSource('HOME=/other npm test'))
  assert.equal(overridden.home, '/other')
  assert.equal(overridden.userCacheDir, '/other/.cache', 'the user cache root is re-derived for the overridden HOME')
  assert.equal(overridden.huggingfaceCacheDir, '/other/.cache/huggingface')
  assert.equal(overridden.userCacheDirExists, false, 'an absent overridden cache root is recorded as absent')
  const cleared = selfRunEnvironmentFacts(ambient, selfRunEnvironmentSource('env -i node x'))
  assert.equal(cleared.home, null, 'a cleared environment has no HOME unless the command sets one')
  assert.equal(cleared.userCacheDir, null)
  const managerRoot = selfRunEnvironmentFacts(ambient, selfRunEnvironmentSource('npm_config_cache=/m npm test'))
  assert.equal(managerRoot.checkCacheRoots.npm_config_cache, '/m', 'a package-manager cache root the command sets is carried')
})

test('ENV-R: a recorded self-run command that overrides HOME refuses the acceptance with its own environment', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  const other = await realpath(await tempDirectory('swarm-env-other-'))
  await mkdir(path.join(other, '.cache'), { recursive: true })
  t.after(async () => { await rm(path.dirname(home), { recursive: true, force: true }); await rm(other, { recursive: true, force: true }) })
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(home) })
  const reviewer = fixture.reviews[0]
  const command = `HOME=${other} node -e "process.stdout.write(process.env.HOME ?? '')"`
  // The command really executes under its own HOME; the row must record that
  // environment rather than the ambient host sample it never ran with.
  const executed = await runProcess(['/bin/sh', '-c', command], { subprocess: subprocessSeam, cwd: path.join(fixture.temp, 'source'), timeoutMs: 30000, maxBytes: 4096, env: checkEnvFor(home) })
  assert.equal(executed.exitCode, 0, executed.output)
  assert.ok(executed.output.includes(other), `the self-run really ran with the HOME its command declares: ${executed.output.slice(0, 200)}`)
  const runId = await fixture.workers.callbacks.toolRun(reviewer.reviewer.id, { tool: 'bash', arguments: { command }, result: { output: executed.output.trim() }, isError: false })
  assert.ok(runId, 'the self-run is recorded')
  const row = fixture.runtime.store.get('tool_runs', runId)
  assert.equal(row.checkEnvironment.home, other, "the durable row carries the command's HOME")
  assert.equal(row.checkEnvironment.userCacheDir, path.join(other, '.cache'), 'its cache root is re-derived')
  assert.equal(row.checkEnvironmentSource.from, 'command', 'the row states how its facts were derived')
  assert.deepEqual(row.checkEnvironmentSource.operations, [{ name: 'HOME', value: other }])

  await assert.rejects(
    fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' }),
    error => {
      assert.equal(error.code, 'check_environment_mismatch')
      assert.match(error.message, /home: /, 'the refusal names the divergent field')
      assert.ok(error.message.includes(`envelope ${home}`), `the refusal names the envelope value: ${error.message}`)
      assert.ok(error.message.includes(`self-run ${other}`), `the refusal names the executed command's value: ${error.message}`)
      return true
    })
  assert.equal(fixture.ready().status, 'submitted', 'the artifact is not accepted under a different environment')
  assert.equal(fixture.runtime.store.get('tasks', reviewer.review.id).status, 'running', 'the attempt survives so the reviewer can rerun under the envelope')
  const mismatch = fixture.events().filter(event => event.type === 'task/check-envelope').find(event => event.data?.reproduction === 'check-environment-mismatch')
  assert.ok(mismatch, 'the mismatch is durable')
  assert.equal(mismatch.data.selfRunSource, 'tool-run', 'the record names the recorded self-run as its evidence')
  assert.equal(mismatch.data.envelope.home, home)
  assert.equal(mismatch.data.selfRun.home, other)
  assert.ok(mismatch.data.blocking.some(field => field.field === 'home' && field.envelope === home && field.selfRun === other),
    `the durable record names both values: ${JSON.stringify(mismatch.data.blocking)}`)
})

test('ENV-R: a quoted mention of HOME is not an override and the acceptance proceeds', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  const other = await realpath(await tempDirectory('swarm-env-other-'))
  t.after(async () => { await rm(path.dirname(home), { recursive: true, force: true }); await rm(other, { recursive: true, force: true }) })
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(process.env.HOME) })
  const reviewer = fixture.reviews[0]
  const command = `grep -n "HOME=${other}" src/answer.txt ; true`
  const executed = await runProcess(['/bin/sh', '-c', command], { subprocess: subprocessSeam, cwd: path.join(fixture.temp, 'source'), timeoutMs: 30000, maxBytes: 4096, env: checkEnvFor(process.env.HOME) })
  assert.equal(executed.exitCode, 0, executed.output)
  const runId = await fixture.workers.callbacks.toolRun(reviewer.reviewer.id, { tool: 'bash', arguments: { command }, result: { output: executed.output }, isError: false })
  const row = fixture.runtime.store.get('tool_runs', runId)
  assert.equal(row.checkEnvironment.home, process.env.HOME, 'a quoted mention leaves the ambient facts in place')
  assert.equal(row.checkEnvironmentSource, undefined, 'no override is recorded for a quoted mention')
  const accepted = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  assert.equal(accepted.status, 'accepted', 'an environment that reproduces the envelope is not refused')
  assert.equal(fixture.ready().status, 'accepted')
  assert.equal(home.length > 0, true)
})

test('ENV-R: the scoped check roots are reported as advisory divergences, never silently ignored', async t => {
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
  assert.match(scoped.envelope, /\.swarm-check-cache$/, 'the envelope value names the provided root')
  assert.equal(scoped.selfRun, 'absent', 'the self-run value is recorded as absent, not hidden')
  const comparison = compareCheckEnvironments(
    { ...fixture.workers.workspaces.checkEnvelope().environment, checkCacheRoot: '/checkout/.swarm-check-cache' },
    { ...fixture.workers.workspaces.checkEnvelope().selfRunEnvironment, checkCacheRoot: null })
  assert.deepEqual(comparison.blocking, [])
  assert.ok(comparison.advisory.some(field => field.field === 'checkCacheRoot'), 'a self-run with no scoped root is still reported')
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
  // envelope fields: a self-run cannot reproduce a disposable checkout path, and
  // recording the temp root as a scoped root would make `selfRunEnvironmentFacts`
  // spread it into every self-run as if the member's own run had used it.
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

/* ------------------------------------------------------------------ *
 * ENV-R3: the two extractor defects the reviewer reproduced.
 * ------------------------------------------------------------------ */

test('ENV-R3: unset option forms that act on functions record no variable removal', async () => {
  const facts = source => Object.fromEntries(source.operations.map(operation => [operation.name, operation.value]))
  assert.deepEqual(facts(selfRunEnvironmentSource('unset -f HOME')), {}, 'unset -f removes a function, not the variable')
  assert.deepEqual(facts(selfRunEnvironmentSource('unset -n HOME')), {}, 'unset -n removes a nameref')
  assert.deepEqual(facts(selfRunEnvironmentSource('unset -fv HOME')), {}, 'a combined non-variable option records nothing')
  assert.deepEqual(facts(selfRunEnvironmentSource('unset -f HOME; echo HOME=$HOME')), {}, 'the whole command is read, not only its first word')
  assert.deepEqual(facts(selfRunEnvironmentSource('unset -v HOME')), { HOME: null }, 'unset -v removes the variable')
  assert.deepEqual(facts(selfRunEnvironmentSource('unset -- HOME')), { HOME: null }, '-- ends option processing')
  assert.deepEqual(facts(selfRunEnvironmentSource('unset HOME')), { HOME: null }, 'a bare name removes the variable')
  assert.deepEqual(facts(selfRunEnvironmentSource('unset -f HOME XDG_CACHE_HOME')), {}, 'no name after a function option is a variable removal')
})

test('ENV-R3: a quoted NAME=VALUE after env or export is an assignment; at segment start it is not', async () => {
  const facts = source => Object.fromEntries(source.operations.map(operation => [operation.name, operation.value]))
  assert.deepEqual(facts(selfRunEnvironmentSource('env "HOME=/a" cmd')), { HOME: '/a' }, 'env parses its operand after quote removal')
  assert.deepEqual(facts(selfRunEnvironmentSource("env 'HOME=/b' cmd")), { HOME: '/b' }, 'single quotes too')
  assert.deepEqual(facts(selfRunEnvironmentSource('env -i "HOME=/c" cmd')), { HOME: '/c' }, 'and with a cleared environment')
  assert.deepEqual(facts(selfRunEnvironmentSource('export "HOME=/d"')), { HOME: '/d' }, 'export parses its operand the same way')
  assert.deepEqual(facts(selfRunEnvironmentSource('"HOME=/e" cmd')), {}, 'a quoted segment-initial word is a command name, not an assignment')
  assert.deepEqual(facts(selfRunEnvironmentSource('env -C /tmp "HOME=/f" cmd')), { HOME: '/f' }, "an env option's argument is consumed, not read as a command")
  assert.deepEqual(facts(selfRunEnvironmentSource('env "HOME=/g" "XDG_CACHE_HOME=/h" cmd')), { HOME: '/g', XDG_CACHE_HOME: '/h' }, 'several quoted operands')
})

test('ENV-R3: every documented extractor limitation is pinned to the direction it claims', async () => {
  const facts = source => Object.fromEntries(source.operations.map(operation => [operation.name, operation.value]))
  assert.equal(SELF_RUN_EXTRACTOR_LIMITATIONS.length, 3, 'the list is exactly what these three cases pin')
  // 1. A non-literal value is recorded literally, so the divergence is REPORTED.
  assert.deepEqual(facts(selfRunEnvironmentSource('HOME=$OTHER cmd')), { HOME: '$OTHER' }, 'an unexpanded value is recorded as the text it is')
  assert.deepEqual(facts(selfRunEnvironmentSource('HOME=$(pwd) cmd')), { HOME: '$(pwd)' }, 'command substitution is recorded as text')
  // 2. `set -a`/`source`/functions/heredocs are not followed: absent (permissive).
  assert.deepEqual(facts(selfRunEnvironmentSource('. ./env.sh && npm test')), {}, 'a sourced file is not followed')
  assert.deepEqual(facts(selfRunEnvironmentSource('set -a; npm test')), {}, 'set -a exports later values the extractor does not follow')
  assert.deepEqual(facts(selfRunEnvironmentSource('f() { HOME=/x; }; f; npm test')), {}, 'a function body is not followed')
  assert.deepEqual(facts(selfRunEnvironmentSource('cat <<DOC\nHOME=/x\nDOC\nnpm test')), {}, 'a heredoc body is not followed')
  // ENV-R5: the same clause holds for a heredoc nested inside a shell -c body.
  // The top-level scanner cannot see the redirect (it sits inside a quote on the
  // `sh -c '...` line), so the recursion has to apply the strip itself.
  assert.deepEqual(facts(selfRunEnvironmentSource("sh -c 'cat <<DOC\nHOME=/x\nDOC'")), {}, 'a nested heredoc body is not followed either')
  assert.deepEqual(facts(selfRunEnvironmentSource('sh -c "cat <<DOC\nHOME=/x\nDOC"')), {}, 'nor in a double-quoted -c body')
  // 3. `env -S` / `export -n`: absent (permissive).
  assert.deepEqual(facts(selfRunEnvironmentSource('env -S "HOME=/x node y"')), {}, 'env -S is not split')
  assert.deepEqual(facts(selfRunEnvironmentSource('export -n HOME')), {}, 'export -n is not modelled')
})

test('ENV-R5: a heredoc body nested inside a shell -c body is not read as code either', () => {
  const facts = source => Object.fromEntries(source.operations.map(operation => [operation.name, operation.value]))
  // The reviewer's falsified shapes: the redirect lives inside the quoted -c
  // body, so the top-level scanner cannot strip it; every one of these must read
  // as an empty environment rather than as an override.
  const shapes = [
    ['single-quoted -c', "sh -c 'cat <<DOC\nHOME=/x\nDOC'"],
    ['double-quoted -c', 'sh -c "cat <<DOC\nHOME=/x\nDOC"'],
    ['bash -c', "bash -c 'cat <<DOC\nHOME=/x\nDOC'"],
    ['tab-indented <<-DOC', "sh -c 'cat <<-DOC\n\tHOME=/x\n\tDOC'"],
    ['a preceding command in the body', "sh -c 'cat <<DOC\nHOME=/x; echo hi\nDOC'"],
    ['the redirect on a later line', "sh -c 'cat\n<<DOC\nHOME=/x\nDOC'"],
  ]
  for (const [label, command] of shapes) {
    assert.deepEqual(facts(selfRunEnvironmentSource(command)), {}, `${label}: a nested heredoc body is data, not code`)
  }
  // The fix must not silence a real override written as code in the nested body.
  assert.deepEqual(facts(selfRunEnvironmentSource("sh -c 'HOME=/x npm test'")), { HOME: '/x' }, 'a nested assignment in code is still recorded')
  assert.deepEqual(facts(selfRunEnvironmentSource("sh -c 'export HOME=/x && npm test'")), { HOME: '/x' }, 'a nested export in code is still recorded')
  assert.deepEqual(facts(selfRunEnvironmentSource("sh -c 'cat <<DOC\nHOME=/x\nDOC\nHOME=/y npm test'")), { HOME: '/y' },
    'only the code after the stripped body counts')
})

test('ENV-R5: the reviewer\'s nested shape really runs with the ambient HOME and is accepted, with the body printed as data', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  const other = await realpath(await tempDirectory('swarm-env-other-'))
  t.after(async () => { await rm(path.dirname(home), { recursive: true, force: true }); await rm(other, { recursive: true, force: true }) })
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(process.env.HOME) })
  const reviewer = fixture.reviews[0]
  // The nested body is printed by `cat` as data while the shell itself reports
  // the ambient HOME; the body contains what LOOKS like an export.
  const command = `sh -c "echo \\"shell HOME=\\$HOME\\"; cat <<DOC
x; export HOME=${other}
DOC"`
  const executed = await runProcess(['/bin/sh', '-c', command], { subprocess: subprocessSeam, cwd: path.join(fixture.temp, 'source'), timeoutMs: 30000, maxBytes: 4096, env: checkEnvFor(home) })
  assert.equal(executed.exitCode, 0, executed.output)
  assert.ok(executed.output.includes(`shell HOME=${home}`), `the shell really ran with the check HOME: ${executed.output}` )
  assert.ok(executed.output.includes(`x; export HOME=${other}`), `the heredoc body really was printed as data: ${executed.output}`)
  const runId = await fixture.workers.callbacks.toolRun(reviewer.reviewer.id, { tool: 'bash', arguments: { command }, result: { output: executed.output }, isError: false })
  const row = fixture.runtime.store.get('tool_runs', runId)
  assert.equal(row.checkEnvironment.home, process.env.HOME, 'the durable row keeps the ambient facts')
  assert.equal(row.checkEnvironmentSource, undefined, 'no override is recorded for a nested heredoc body')
  const accepted = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  assert.equal(accepted.status, 'accepted', 'a command that really ran with the ambient HOME is accepted, not refused')
  assert.equal(fixture.ready().status, 'accepted')
  assert.equal(home.length > 0, true)
})

test('ENV-R3: a command that leaves HOME untouched is not refused, and one that removes or overrides it is', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  const other = await realpath(await tempDirectory('swarm-env-other-'))
  t.after(async () => { await rm(path.dirname(home), { recursive: true, force: true }); await rm(other, { recursive: true, force: true }) })
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(process.env.HOME) })
  const reviewer = fixture.reviews[0]
  const record = async command => {
    const executed = await runProcess(['/bin/sh', '-c', command], { subprocess: subprocessSeam, cwd: path.join(fixture.temp, 'source'), timeoutMs: 30000, maxBytes: 4096, env: checkEnvFor(home) })
    assert.equal(executed.exitCode, 0, executed.output)
    const runId = await fixture.workers.callbacks.toolRun(reviewer.reviewer.id, { tool: 'bash', arguments: { command }, result: { output: executed.output }, isError: false })
    return { executed, row: fixture.runtime.store.get('tool_runs', runId) }
  }

  // D2: `unset -f HOME` acts on a function. The command really runs with HOME
  // set (its own stdout proves it) and must not be recorded as a removal.
  const untouched = await record('unset -f HOME; echo HOME=$HOME')
  assert.ok(untouched.executed.output.includes(home), `the command really ran with HOME set: ${untouched.executed.output}`)
  assert.equal(untouched.row.checkEnvironment.home, process.env.HOME, 'the row keeps the ambient facts')
  assert.equal(untouched.row.checkEnvironmentSource, undefined, 'no removal is recorded')
  const accepted = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  assert.equal(accepted.status, 'accepted', 'a command that overrides nothing in the blocking set is not refused')
  assert.equal(fixture.ready().status, 'accepted')

  // The counter-case stays: `unset -v HOME` really removes the variable and is
  // recorded as a blocking divergence against an envelope that has a HOME.
  // (A separate fixture: the acceptance above closed this fixture's attempt.)
  const clearedFixture = await missionFixture(t, { checkEnv: checkEnvFor(home) })
  const clearedReviewer = clearedFixture.reviews[0]
  const removal = await runProcess(['/bin/sh', '-c', 'unset -v HOME; echo "HOME=[$HOME]"'], { subprocess: subprocessSeam, cwd: path.join(clearedFixture.temp, 'source'), timeoutMs: 30000, maxBytes: 4096, env: checkEnvFor(home) })
  assert.equal(removal.exitCode, 0, removal.output)
  assert.ok(removal.output.includes('HOME=[]'), `the variable really was removed: ${removal.output}`)
  const removalRun = await clearedFixture.workers.callbacks.toolRun(clearedReviewer.reviewer.id, { tool: 'bash', arguments: { command: 'unset -v HOME; echo "HOME=[$HOME]"' }, result: { output: removal.output }, isError: false })
  const removalRow = clearedFixture.runtime.store.get('tool_runs', removalRun)
  assert.equal(removalRow.checkEnvironment.home, null, 'the row records the removal')
  assert.deepEqual(removalRow.checkEnvironmentSource.operations, [{ name: 'HOME', value: null }])
  await assert.rejects(
    clearedFixture.runtime.verify({ sessionId: clearedReviewer.reviewer.sessionId }, clearedFixture.mission.id, { taskId: clearedReviewer.review.id, attemptId: clearedReviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' }),
    error => error.code === 'check_environment_mismatch' && /home: /.test(error.message))
  assert.equal(clearedFixture.ready().status, 'submitted', 'a real removal still refuses the acceptance')

  // D1: `env "HOME=<other>"` really overrides HOME after quote removal and must
  // be recorded with that HOME rather than accepted.
  const overrideFixture = await missionFixture(t, { checkEnv: checkEnvFor(process.env.HOME) })
  const overrideReviewer = overrideFixture.reviews[0]
  const command = `env "HOME=${other}" sh -c 'echo HOME=$HOME'`
  const executed = await runProcess(['/bin/sh', '-c', command], { subprocess: subprocessSeam, cwd: path.join(overrideFixture.temp, 'source'), timeoutMs: 30000, maxBytes: 4096, env: checkEnvFor(home) })
  assert.equal(executed.exitCode, 0, executed.output)
  assert.ok(executed.output.includes(other), `the command really ran with the overridden HOME: ${executed.output}`)
  const runId = await overrideFixture.workers.callbacks.toolRun(overrideReviewer.reviewer.id, { tool: 'bash', arguments: { command }, result: { output: executed.output }, isError: false })
  const row = overrideFixture.runtime.store.get('tool_runs', runId)
  assert.equal(row.checkEnvironment.home, other, 'a quoted env operand is recorded as the override it is')
  assert.deepEqual(row.checkEnvironmentSource.operations, [{ name: 'HOME', value: other }])
  await assert.rejects(
    overrideFixture.runtime.verify({ sessionId: overrideReviewer.reviewer.sessionId }, overrideFixture.mission.id, { taskId: overrideReviewer.review.id, attemptId: overrideReviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' }),
    error => error.code === 'check_environment_mismatch' && error.message.includes(`self-run ${other}`))
  assert.equal(overrideFixture.ready().status, 'submitted', 'an executed override is refused, not accepted')
})

/* ------------------------------------------------------------------ *
 * ENV-R4: a heredoc body is never an assignment; export -n declares nothing.
 * ------------------------------------------------------------------ */

test('ENV-R4: a heredoc body is not read as an assignment under any preceding shell state', async () => {
  const facts = source => Object.fromEntries(source.operations.map(operation => [operation.name, operation.value]))
  // The reviewer's shape: a preceding `export` segment must not make the body
  // read as an export operand.
  assert.deepEqual(facts(selfRunEnvironmentSource('export FOO=bar\ncat <<DOC\nHOME=/x\nDOC')), {}, 'a body after an export segment is not an operand')
  assert.deepEqual(facts(selfRunEnvironmentSource('cat <<DOC\nx; export HOME=/x\nDOC')), {}, 'an assignment inside a body is body text')
  assert.deepEqual(facts(selfRunEnvironmentSource('cat <<DOC\nHOME=/x\nDOC\nnpm test')), {}, 'the previously pinned shape stays unpinned to code')
  assert.deepEqual(facts(selfRunEnvironmentSource('cat <<-DOC\n\tHOME=/x\n\tDOC\nnpm test')), {}, 'a <<- body with tab indentation is stripped')
  assert.deepEqual(facts(selfRunEnvironmentSource("cat <<'DOC'\nHOME=/x\nDOC\nnpm test")), {}, 'a quoted delimiter still names the terminator')
  assert.deepEqual(facts(selfRunEnvironmentSource('cat <<DOC\nHOME=/x\nDOC\nHOME=/y npm test')), { HOME: '/y' }, 'code after the terminator is read again')
  assert.deepEqual(facts(selfRunEnvironmentSource('cat <<A <<B\nHOME=/x\nA\nHOME=/y\nB')), {}, 'two heredocs in one command are consumed in order')
  assert.deepEqual(facts(selfRunEnvironmentSource('grep foo <<< "HOME=/z"')), {}, 'a here-string is not a heredoc and is not code either')
  assert.deepEqual(facts(selfRunEnvironmentSource('cat <<"DOC"\nHOME=/x\nDOC')), {}, 'a double-quoted delimiter is stripped')
})

test('ENV-R4: export -n declares nothing, for the value form and the no-value form alike', async () => {
  const facts = source => Object.fromEntries(source.operations.map(operation => [operation.name, operation.value]))
  assert.deepEqual(facts(selfRunEnvironmentSource('export -n HOME=/x')), {}, 'the value form leaves the child without HOME, so it is not an assignment')
  assert.deepEqual(facts(selfRunEnvironmentSource('export -n HOME')), {}, 'the no-value form removes the export attribute')
  assert.deepEqual(facts(selfRunEnvironmentSource('export -n XDG_CACHE_HOME=/y')), {}, 'the same for every recorded name')
  assert.deepEqual(facts(selfRunEnvironmentSource('export -nf HOME=/x')), {}, 'a combined option word declares nothing either')
  assert.deepEqual(facts(selfRunEnvironmentSource('export -f HOME')), {}, 'export -f exports a function, not a variable')
  assert.deepEqual(facts(selfRunEnvironmentSource('export -p')), {}, 'export -p prints')
  assert.deepEqual(facts(selfRunEnvironmentSource('export HOME=/x')), { HOME: '/x' }, 'a plain export still assigns')
  assert.deepEqual(facts(selfRunEnvironmentSource('export -- HOME=/x')), { HOME: '/x' }, '-- ends option processing and the assignment stands')
})

test('ENV-R4: a command whose heredoc body mentions HOME really runs with the ambient HOME and is not refused', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(process.env.HOME) })
  const reviewer = fixture.reviews[0]
  const command = 'echo "shell HOME=$HOME"; cat <<DOC\nx; export HOME=/x\nDOC'
  const executed = await runProcess(['/bin/sh', '-c', command], { subprocess: subprocessSeam, cwd: path.join(fixture.temp, 'source'), timeoutMs: 30000, maxBytes: 4096, env: checkEnvFor(home) })
  assert.equal(executed.exitCode, 0, executed.output)
  assert.ok(executed.output.includes(`shell HOME=${home}`), `the shell really ran with the check HOME: ${executed.output}`)
  assert.ok(executed.output.includes('export HOME=/x'), 'the body is printed as data, never executed')
  const runId = await fixture.workers.callbacks.toolRun(reviewer.reviewer.id, { tool: 'bash', arguments: { command }, result: { output: executed.output }, isError: false })
  const row = fixture.runtime.store.get('tool_runs', runId)
  assert.equal(row.checkEnvironment.home, process.env.HOME, 'the body did not become an override')
  assert.equal(row.checkEnvironmentSource, undefined, 'no provenance is recorded for a body')
  const accepted = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  assert.equal(accepted.status, 'accepted', 'a command that overrides nothing in the blocking set is accepted')
  assert.equal(fixture.ready().status, 'accepted')
})

test('ENV-R4: export -n HOME=/x really runs without HOME in the child and records no override', async t => {
  const home = await cacheHome(await realpath(await tempDirectory('swarm-env-home-')), true)
  t.after(async () => rm(path.dirname(home), { recursive: true, force: true }))
  const fixture = await missionFixture(t, { checkEnv: checkEnvFor(process.env.HOME) })
  const reviewer = fixture.reviews[0]
  const command = 'export -n HOME=/x; printenv HOME || echo "child HOME absent"'
  const executed = await runProcess(['/bin/sh', '-c', command], { subprocess: subprocessSeam, cwd: path.join(fixture.temp, 'source'), timeoutMs: 30000, maxBytes: 4096, env: checkEnvFor(home) })
  assert.equal(executed.exitCode, 0, executed.output)
  assert.ok(executed.output.includes('child HOME absent'), `the executed child really has no HOME: ${executed.output}`)
  const runId = await fixture.workers.callbacks.toolRun(reviewer.reviewer.id, { tool: 'bash', arguments: { command }, result: { output: executed.output }, isError: false })
  const row = fixture.runtime.store.get('tool_runs', runId)
  assert.equal(row.checkEnvironment.home, process.env.HOME, 'no override is recorded: the unexported value is never seen by a child')
  assert.equal(row.checkEnvironmentSource, undefined)
  const accepted = await fixture.runtime.verify({ sessionId: reviewer.reviewer.sessionId }, fixture.mission.id, { taskId: reviewer.review.id, attemptId: reviewer.claim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  assert.equal(accepted.status, 'accepted', 'the documented permissive direction holds')
})
