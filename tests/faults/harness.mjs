/**
 * Shared fixtures for the fault-injection suite (F1-F14).
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

const execute = promisify(execFile)
export const PROJECT = fileURLToPath(new URL('../../', import.meta.url))
export const { SwarmRuntime } = await import(pathToFileURL(join(PROJECT, 'lib/runtime.js')).href)
export const { Workspaces, runProcess } = await import(pathToFileURL(join(PROJECT, 'lib/workspaces.js')).href)

export const budget = { maxTokens: 500_000, maxSteps: 500, maxWorkers: 3, maxDurationMs: 600_000, maxTasks: 30, maxExperiments: 0 }
export const MISSION_ACCEPTANCE = ['fault recovery is proven from durable state']

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
  const result = await runProcess(['git', '-c', 'user.name=Fault Suite', '-c', 'user.email=faults@example.invalid', ...args], { cwd, timeoutMs: 30_000, maxBytes: 200_000 })
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
 * Runtime + mission + two members + a propose helper. The runtime, store,
 * admission, scheduler and outbox are real; only the adapter is controlled.
 */
export async function setup({ workers = new FakeWorkers(), config = {}, budget: overrides = {}, acceptance = MISSION_ACCEPTANCE, checks = ['true'], workspace } = {}) {
  const dir = await realpath(await tempDirectory('swarm-faults-'))
  const runtime = new SwarmRuntime({
    statePath: join(dir, 'swarm.sqlite'), leaseMs: 60_000, tickMs: 10, maxMessageChars: 16_000,
    maxEvents: 5_000, maxTasksPerMember: 3, checkTimeoutMs: 30_000, ...config,
  }, workers)
  await runtime.start()
  const owner = { sessionId: 'fault-owner' }
  const mission = runtime.create(owner, { title: 'Fault injection', objective: 'Prove the injected fault fired and recovery holds', workspace: workspace ?? dir, scope: ['**'], acceptance, budget: { ...budget, ...overrides } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Faults', objective: 'Exercise the fault path' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation', maxOutputTokens: 5_000 })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification', maxOutputTokens: 5_000 })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, {
    workstreamId: stream.id, title: 'Implement', objective: 'Implement the scoped change',
    kind: 'implementation', scope: ['**'], acceptance, checks, assigneeId: author.id, ...extra,
  })
  const cleanup = async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) }
  return { dir, runtime, workers, owner, mission, stream, author, reviewer, actor, propose, cleanup }
}

/** Drive a task to blocked through a real independent rejection. */
export async function blockThroughReview(f, task) {
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate rejected by the injected fault' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: `Review ${task.title}`, objective: 'Independent review', kind: 'verification',
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
    workstreamId: f.stream.id, title: `Review ${task.title}`, objective: 'Independent review', kind: 'verification',
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
