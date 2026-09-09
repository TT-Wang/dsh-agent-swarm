/**
 * Deterministic replay scenario: drives the real SwarmRuntime through the real
 * model tools with a recording worker adapter that never calls a provider.
 *
 * The recording adapter is the only observation point for the orchestrator's
 * externally visible commands (dispatch, stop, verify). Those commands are
 * compared against the sequence replayed from the durable event log, so the log
 * is proven sufficient to reconstruct every orchestration decision.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SwarmRuntime } from '../../lib/runtime.js'
import { registerTools } from '../../lib/tools.js'

const BUDGET = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 20, maxExperiments: 0 }
/**
 * Long enough that no publish/submit can lose the lease race under host load.
 * The lease-expiry path is exercised by forcing `attempt.leaseUntil` into the
 * past through durable state, never by waiting for a short lease to elapse.
 */
const LEASE_MS = 60000

/** Records every adapter command and counts any provider invocation (always zero). */
export class RecordingWorkers {
  constructor(root) { this.root = root; this.commands = []; this.providerCalls = 0; this.deliveries = []; this.checks = [{ command: 'replay-check', exitCode: 0, output: 'ok' }]; this.artifacts = 0 }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, memberId) { return join(this.root, 'worktrees', memberId) }
  async start() {}
  async deliver(_member, delivery) { this.deliveries.push(delivery) }
  async stop(memberId) { this.commands.push({ kind: 'stop', memberId }) }
  isIdle() { return true }
  async captureArtifact() { this.artifacts++; return { commit: `commit-${this.artifacts}`, baseCommit: 'base', workspace: join(this.root, 'worktrees', 'capture'), changedPaths: ['src/a.ts'] } }
  async verifyArtifact(_member, source) { this.commands.push({ kind: 'verify', sourceTaskId: source.id }); return this.checks }
  async prepareTask(member, task) { this.commands.push({ kind: 'dispatch', taskId: task.id, memberId: member.id }) }
  async dispose() {}
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function eventually(read, message, timeout = 5000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = read(); if (value) return value; await sleep(5) }
  throw new Error(`replay scenario did not settle: ${message}`)
}

/**
 * Run the scenario and return its durable identities plus the recorded command
 * sequence. The runtime is disposed before returning so the caller can open the
 * state file and replay its event log.
 */
export async function runScenario(options = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'swarm-replay-'))
  const ownsRoot = options.root === undefined
  const workspace = await realpath(await mkdtemp(join(root, 'workspace-')))
  const statePath = join(root, 'replay.sqlite')
  const workers = new RecordingWorkers(root)
  const runtime = new SwarmRuntime({ statePath, leaseMs: LEASE_MS, tickMs: 60000, maxMessageChars: 16000, maxEvents: 200, maxTasksPerMember: 3 }, workers)
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, BUDGET)
  const exec = sessionId => ({ agent: { id: sessionId, session: { header: { cwd: workspace } } }, signal: new AbortController().signal })
  const call = async (name, args, sessionId) => {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`Unknown tool ${name}`)
    return await definition.execute(args, exec(sessionId))
  }
  const taskOf = id => runtime.store.get('tasks', id)
  const running = async id => eventually(() => { const task = taskOf(id); return task?.status === 'running' ? task : undefined }, `${id} to be dispatched`)
  const attemptOf = id => taskOf(id)?.attempt?.id
  const owner = 'replay-owner-session'
  try {
    const mission = (await call('swarm_create', { title: 'Replay mission', objective: 'Reconstruct every decision', workspace, scope: ['src/'], acceptance: ['works'], budget: BUDGET }, owner)).result
    const stream = (await call('swarm_workstream', { missionId: mission.id, title: 'Core', objective: 'Deliver the module' }, owner)).result
    const builder = (await call('swarm_add_member', { missionId: mission.id, name: 'Builder', role: 'implementation' }, owner)).result
    const reviewer = (await call('swarm_add_member', { missionId: mission.id, name: 'Reviewer', role: 'verification' }, owner)).result
    const missionId = mission.id
    const propose = async (extra, sessionId = owner) => (await call('swarm_propose', { missionId, workstreamId: stream.id, scope: ['src/'], acceptance: ['works'], ...extra }, sessionId)).result
    const publish = async (taskId, sessionId) => {
      const runId = await workers.callbacks.toolRun(builder.id, { tool: 'bash', arguments: { command: 'true' }, result: { output: 'ok' }, isError: false })
      await call('swarm_publish', { missionId, taskId, attemptId: attemptOf(taskId), claim: `Evidence for ${taskId}`, outcome: 'supported', toolRunIds: [runId] }, sessionId)
    }

    // Task 1: dispatch, evidence, submission.
    const first = await propose({ title: 'Implement one', objective: 'Deliver one', kind: 'implementation', checks: ['replay-check'], assigneeId: builder.id })
    await running(first.id)
    await publish(first.id, builder.sessionId)
    await call('swarm_submit', { missionId, taskId: first.id, attemptId: attemptOf(first.id), output: 'first candidate' }, builder.sessionId)

    // Task 2: dispatch, lease expiry (checkpoint + stop + re-dispatch), submission.
    const second = await propose({ title: 'Implement two', objective: 'Deliver two', kind: 'implementation', checks: ['replay-check'], assigneeId: builder.id })
    const firstAttempt = (await running(second.id)).attempt.id
    // Drive lease expiry from durable state, not from a wall-clock sleep: the
    // scheduler's recovery path reads `attempt.leaseUntil`, so writing it into
    // the past produces the identical checkpoint/stop/re-dispatch commands
    // without racing the host's scheduling latency.
    const expiring = runtime.store.get('tasks', second.id)
    expiring.attempt.leaseUntil = Date.now() - 1
    runtime.store.transaction(() => runtime.store.put('tasks', expiring))
    await call('swarm_control', { missionId, action: 'resume', reason: 'replay: drive lease expiry' }, owner)
    const redispatch = await eventually(() => { const task = taskOf(second.id); return task?.status === 'running' && task.attempt?.id !== firstAttempt ? task : undefined }, 'the expired attempt to be re-dispatched')
    await publish(second.id, builder.sessionId)
    await call('swarm_submit', { missionId, taskId: second.id, attemptId: redispatch.attempt.id, output: 'second candidate' }, builder.sessionId)

    // Independent verification of task 2.
    const review = await propose({ title: 'Review two', objective: 'Independent review', kind: 'verification', checks: [], reviewOf: second.id, assigneeId: reviewer.id })
    await running(review.id)
    await call('swarm_verify', { missionId, taskId: review.id, attemptId: attemptOf(review.id), verdict: 'accept', reason: 'Independent accept' }, reviewer.sessionId)

    const commands = workers.commands
    const providerCalls = workers.providerCalls
    await runtime.dispose()
    return { root, ownsRoot, workspace, statePath, payloadDir: join(dirname(statePath), 'trace-payloads'), missionId,
      commands, providerCalls, builderId: builder.id, reviewerId: reviewer.id, tasks: { first: first.id, second: second.id, review: review.id } }
  } catch (error) {
    await runtime.dispose().catch(() => {})
    if (ownsRoot) await rm(root, { recursive: true, force: true })
    throw error
  }
}
