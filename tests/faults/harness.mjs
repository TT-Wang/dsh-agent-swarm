/**
 * The one shared runtime test fixture: the fault-injection suite (F1-F21) and
 * the node:test files under tests/ both import it from here, so a new runtime
 * or adapter dependency is added to a fixture once. It stays under faults/
 * because the scenario modules and two dozen test files already import this
 * path; a re-export module would only add a second spelling of every symbol.
 *
 *  - `FakeWorkers`: the recording `WorkerAdapter` (behaviour-neutral no-ops for
 *    the optional methods, never `prepareBaseline`/`checkEnvelope`).
 *  - `makeRuntime(t, ...)`: a runtime on a temp dir with the shared config and
 *    budget, cleaned up by `t.after`; it creates no mission, member or event.
 *  - `setup(...)`: the same runtime config, started, with a mission and two
 *    members, for the fault scenarios (which have no node:test context).
 *  - `makeWorkspaces(dir, overrides)` / `workspaceOptions(dir, overrides)`: the
 *    real Workspaces engine behind the subprocess seam.
 *  - `makeRuntimeStub(overrides)`: a partial runtime for one component.
 *  - `eventually(read, message, timeoutMs)`, `FakeClock`.
 *
 * The suite asserts from durable state, never from logs. Two seams are used:
 *  - Tier A drives the real `SwarmRuntime` with a controllable `WorkerAdapter`
 *    (the only replaced boundary), optionally delegating capture/verify to a
 *    real `Workspaces` instance so checkpoints and artifacts are real commits.
 *  - Tier B boots the real Harness Loader composition with a scripted LLM
 *    adapter for provider faults; it lives in `loader.mjs`.
 *
 * Host limitation (documented, not a weakened assertion): this environment
 * cannot apply `sandbox-exec` (exit 71, Operation not permitted), so Tier B
 * registers an identity sandbox provider and an unsandboxed shell. The
 * provider-fault invariants do not depend on OS confinement.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempDirectory } from '../temp-root.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { subprocessSeam } from '../subprocess-seam.mjs'

const execute = promisify(execFile)
export const PROJECT = fileURLToPath(new URL('../../', import.meta.url))
export const { SwarmRuntime } = await import(pathToFileURL(join(PROJECT, 'lib/runtime.js')).href)
export const { Workspaces, runProcess } = await import(pathToFileURL(join(PROJECT, 'lib/workspaces.js')).href)
const { PolicyError } = await import(pathToFileURL(join(PROJECT, 'lib/policy-error.js')).href)

export const budget = { maxTokens: 500_000, maxSteps: 500, maxWorkers: 3, maxDurationMs: 600_000, maxTasks: 30, maxExperiments: 0 }
export const MISSION_ACCEPTANCE = ['fault recovery is proven from durable state']

/**
 * A hand-driven runtime clock: pass `now` as `RuntimeConfig.now` (or the
 * clock itself as `setup({ clock })`) and move time with `advance(ms)`.
 */
export class FakeClock {
  #at
  constructor(start = Date.now()) { this.#at = start }
  now = () => this.#at
  advance(ms) { this.#at += ms; return this.#at }
}

/** Poll a synchronous reader; fail loudly instead of hanging. */
export async function eventually(read, message, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`Timed out after ${timeoutMs}ms: ${message}`)
}

export const events = (runtime, missionId, type) => runtime.store.events(missionId, 5_000).filter(event => event.type === type)
export const taskOf = (runtime, taskId) => runtime.store.get('tasks', taskId)
export const clone = value => structuredClone(value)
export const json = value => JSON.parse(JSON.stringify(value))

export async function git(cwd, ...args) {
  const result = await runProcess(['git', '-c', 'user.name=Fault Suite', '-c', 'user.email=faults@example.invalid', ...args], { subprocess: subprocessSeam, cwd, timeoutMs: 30_000, maxBytes: 200_000 })
  assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.output}`)
  return result.output.trim()
}

/** A scratch git repository with one committed file. */
export async function makeRepo(prefix, files = { 'src/answer.txt': 'base\n' }) {
  const root = await realpath(await tempDirectory(`${prefix}-`))
  const source = join(root, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(source, path, '..'), { recursive: true })
    await writeFile(join(source, path), content)
  }
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'fixture baseline')
  return { root, source, head: await git(source, 'rev-parse', 'HEAD') }
}

export const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
export const writeJson = async (file, value) => { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, JSON.stringify(value)) }

/** Spawn a node child without throwing: crash scenarios assert on code/signal. */
export function runNode(args, options = {}) {
  return new Promise(resolve => {
    execFile(process.execPath, args, { cwd: PROJECT, timeout: options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : error?.signal ? null : 0,
        signal: error?.signal ?? null,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

/**
 * The external execution boundary only: every call is recorded so a scenario
 * can prove its injection fired. `autoIdle` lets the runtime reassign work.
 *
 * `overrides` replaces any field or method on the instance, e.g.
 * `new FakeWorkers({ checks: [], autoIdle: true })` or `new FakeWorkers({ async
 * prepareWorkspace(mission, id) { return join(mission.workspace, id) } })`. A
 * subclass's own field initializers run after this constructor and win.
 *
 * The optional adapter methods do what the runtime does when a method is
 * absent: `inspectArtifact` keeps the stored artifact, `checkpointTask`,
 * `compactAtBoundary` and `invalidateComposition` do nothing,
 * `checkSyntaxPreflight` finds no issue and the delivery pair refuses with the
 * runtime's own `delivery_unsupported` error. They answer synchronously, so an
 * `await workers.method?.()` call site takes the same microtask it takes for an
 * absent method. (`checkpointTask`'s presence also makes a stop whose recorded
 * owner has no member row fail instead of re-pending; the store never deletes a
 * member.)
 *
 * Three methods are deliberately different:
 *  - `prepareBaseline` and `checkEnvelope` are NOT implemented. Their presence
 *    adds `workspace/snapshot` and `task/check-envelope` events that the
 *    seq/count assertions and the replay digest do not expect; a test that
 *    needs them passes them as overrides (or uses `WorkspaceWorkers`).
 *  - `currentActivity` IS implemented and reads `activity`, so an operation is
 *    live only while the adapter reports it. `reportActivity(id, activity)`
 *    moves the adapter's view and the durable member activity together. A test
 *    whose stub had no `currentActivity` and that records activity, where the
 *    durable row alone counted as live, keeps its own stub.
 */
export class FakeWorkers {
  callbacks
  deliveries = []
  stopped = []
  started = []
  captured = []
  verified = []
  prepared = []
  idle = new Set()
  autoIdle = false
  activity
  artifact = { commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/answer.txt'] }
  checks = [{ command: 'host-check', exitCode: 0, output: 'ok' }]
  captureGate
  startError

  constructor(overrides = {}) { Object.assign(this, overrides) }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start(spec) { this.started.push(spec.member.id); if (this.startError) throw this.startError }
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, ...json(delivery) }) }
  async stop(id) { this.stopped.push(id) }
  isIdle(id) { return this.autoIdle || this.idle.has(id) }
  async captureArtifact(member, task) {
    this.captured.push({ memberId: member.id, taskId: task.id, epoch: task.epoch, attemptId: task.attempt?.id })
    if (this.captureGate) await this.captureGate()
    return { ...this.artifact }
  }
  async verifyArtifact(member, source, artifact) {
    this.verified.push({ memberId: member.id, sourceId: source.id, commit: artifact.commit })
    return this.checks
  }
  async prepareTask(member, task) { this.prepared.push({ memberId: member.id, taskId: task.id, epoch: task.epoch }) }
  currentActivity() { return this.activity }
  /** Report a live operation (or its end, with `undefined`) the way the Harness adapter does. */
  reportActivity(id, activity) { this.activity = activity; this.callbacks?.activity?.(id, activity) }
  inspectArtifact(_member, artifact) { return artifact }
  checkpointTask() {}
  compactAtBoundary() {}
  invalidateComposition() {}
  checkSyntaxPreflight() { return [] }
  inspectDelivery() { throw new PolicyError('delivery_unsupported', 'tool_error', 'This worker adapter does not support delivery inspection') }
  applyDelivery() { throw new PolicyError('delivery_unsupported', 'tool_error', 'This worker adapter does not support applying results') }
  async dispose() {}
}

/**
 * Capture and host checks run on the real Workspaces engine, so a checkpoint is
 * a real git commit and a submission captures the real member worktree.
 */
export class WorkspaceWorkers extends FakeWorkers {
  constructor(workspaces) { super(); this.workspaces = workspaces }
  async prepareBaseline(mission, signal) { return await this.workspaces.prepareBaseline(mission, signal) }
  async prepareWorkspace(mission, id) { return await this.workspaces.prepareWorkspace(mission, id) }
  async captureArtifact(member, task) {
    this.captured.push({ memberId: member.id, taskId: task.id, epoch: task.epoch, attemptId: task.attempt?.id })
    if (this.captureGate) await this.captureGate()
    const artifact = await this.workspaces.captureArtifact(member, task)
    this.captured.at(-1).commit = artifact.commit
    return artifact
  }
  async verifyArtifact(member, source, artifact, signal) {
    this.verified.push({ memberId: member.id, sourceId: source.id, commit: artifact.commit })
    return await this.workspaces.verifyArtifact(member, source, artifact, signal)
  }
  async prepareTask(member, task, dependencies, reviewSource) { this.prepared.push({ memberId: member.id, taskId: task.id, epoch: task.epoch }); await this.workspaces.prepareTask(member, task, dependencies, reviewSource) }
}

/**
 * The RuntimeConfig every fixture runtime starts from; `overrides` wins. With a
 * `clock` the runtime reads it and runs no tick timer (see `setup`).
 */
function runtimeConfig(dir, overrides, clock) {
  return {
    statePath: join(dir, 'swarm.sqlite'), leaseMs: 60_000, tickMs: 10, maxMessageChars: 16_000,
    maxEvents: 5_000, maxTasksPerMember: 3, checkTimeoutMs: 30_000,
    ...(clock === undefined ? {} : { manualTick: true, now: clock.now, stallPassTimeoutMs: 60_000 }), ...overrides,
  }
}

/**
 * A runtime on a fresh temp dir with the shared config and budget, disposed and
 * removed by `t.after` (a node:test context). It is not started and holds no
 * mission, member or event until the test creates one, so every event count and
 * seq a test asserts is its own. `budget` is the default merged with the
 * overrides, ready for `runtime.create`; `config` is the exact RuntimeConfig, for
 * reopening the same state file. A `clock` (FakeClock) works as in `setup`.
 * `storeOptions` is the runtime's third argument (the SQLite writer's busy
 * timeout and retries), for a test that holds the writer lock itself.
 */
export async function makeRuntime(t, { workers = new FakeWorkers(), config = {}, budget: overrides = {}, clock, storeOptions } = {}) {
  const dir = await realpath(await tempDirectory('swarm-runtime-'))
  const runtimeSettings = runtimeConfig(dir, config, clock)
  const runtime = new SwarmRuntime(runtimeSettings, workers, storeOptions)
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  return { dir, config: runtimeSettings, runtime, workers, budget: { ...budget, ...overrides }, clock }
}

/**
 * The options every fixture `Workspaces` engine shares: the host subprocess seam,
 * worktrees under `<dir>/worktrees`, and an identity `confineCheck`, so checks
 * run unconfined (a suite that tests confinement passes its own). `overrides`
 * wins, e.g. `{ checkConcurrency: 1 }`, a recording `confineCheck` or another
 * subprocess seam.
 */
export const workspaceOptions = (dir, overrides = {}) => ({
  subprocess: subprocessSeam, workspacesRoot: join(dir, 'worktrees'), checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000,
  confineCheck: argv => argv, ...overrides,
})

/** The real Workspaces engine with `workspaceOptions(dir, overrides)`; the caller disposes it. */
export const makeWorkspaces = (dir, overrides) => new Workspaces(workspaceOptions(dir, overrides))

/**
 * A partial runtime for a unit test that builds one component (Scheduling,
 * Attempts, RefusalRegistry, Notices, WorkspaceAdmission, OwnerReplyGuard, the
 * tool layer) without a store. It always carries `now()`, so a runtime
 * dependency every component reads is added here once; `overrides` supplies
 * the rest and wins.
 */
export const makeRuntimeStub = (overrides = {}) => ({ now: () => Date.now(), ...overrides })

/**
 * Runtime + mission + two members + a propose helper. The runtime, store,
 * admission, scheduler and outbox are real; only the adapter is controlled.
 * With a `clock` (a FakeClock) the runtime reads it and runs no tick timer
 * (`manualTick`): the test drives `runtime.tick()`, `runtime.settle(missionId)`
 * and `clock.advance(ms)`. `tickMs` stays 10, the unit of the tick-derived
 * windows the clock moves through. The pass bound then defaults to a minute of
 * clock time, which the real timers that share it never reach within a test.
 */
export async function setup({ workers = new FakeWorkers(), config = {}, budget: overrides = {}, acceptance = MISSION_ACCEPTANCE, checks = ['test -d .'], workspace, clock } = {}) {
  const dir = await realpath(await tempDirectory('swarm-faults-'))
  const runtime = new SwarmRuntime(runtimeConfig(dir, config, clock), workers)
  await runtime.start()
  const owner = { sessionId: 'fault-owner' }
  const mission = runtime.create(owner, { title: 'Fault injection', objective: 'Prove the injected fault fired and recovery holds', workspace: workspace ?? dir, scope: ['**'], acceptance, budget: { ...budget, ...overrides } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Faults', objective: 'Exercise the fault path' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation', maxOutputTokens: 5_000 })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification', maxOutputTokens: 5_000 })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, {
    outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement the scoped change',
    kind: 'implementation', scope: ['**'], acceptance, checks, assigneeId: author.id, ...extra,
  })
  const cleanup = async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) }
  return { dir, runtime, workers, owner, mission, stream, author, reviewer, actor, propose, cleanup, clock }
}

/** Drive a task to blocked through a real independent rejection. */
export async function blockThroughReview(f, task) {
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate rejected by the injected fault' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    outputs: [], workstreamId: f.stream.id, title: `Review ${task.title}`, objective: 'Independent review', kind: 'verification',
    reviewOf: task.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'reject', reason: 'The injected fault makes the candidate unacceptable' })
  assert.equal(taskOf(f.runtime, task.id).status, 'blocked', 'the reviewed source is blocked')
  return review
}

/** Drive a task to accepted through a real independent verification. */
export async function acceptThroughReview(f, task) {
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate accepted after host checks' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    outputs: [], workstreamId: f.stream.id, title: `Review ${task.title}`, objective: 'Independent review', kind: 'verification',
    reviewOf: task.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Independent host checks validate the submitted artifact' })
  assert.equal(taskOf(f.runtime, task.id).status, 'accepted', 'the reviewed source is accepted')
  return review
}

/** Every scenario proves its fault fired, then asserts recovery, then reports. */
export async function runScenario({ id, title, invariants, body }) {
  const started = Date.now()
  try {
    const evidence = await body()
    process.stdout.write(`FAULT_OK ${JSON.stringify({ id, title, invariants, ms: Date.now() - started, evidence: evidence ?? {} })}\n`)
  } catch (error) {
    process.stderr.write(`FAULT_FAIL ${id} ${title}\n${error?.stack ?? String(error)}\n`)
    process.exitCode = 1
  }
}
