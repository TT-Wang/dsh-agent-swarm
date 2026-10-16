/**
 * Deterministic replay scenario: drives the real SwarmRuntime through the real
 * model tools with a recording worker adapter that never calls a provider.
 *
 * The recording adapter is the only observation point for the orchestrator's
 * externally visible commands (dispatch, stop, verify). Those commands are
 * compared against the sequence replayed from the durable event log, so the log
 * is proven sufficient to reconstruct every orchestration decision.
 *
 * The runtime runs on a FakeClock with `manualTick`: the scenario settles the
 * mission after each step and moves the clock itself, so every decision is
 * taken at the same clock instant on every run, and the runtime's full log
 * (tests/faults/oracle.mjs) is returned with the command sequence.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../../lib/runtime.js'
import { registerTools } from '../../lib/tools.js'
import { FakeClock, FakeWorkers, NO_GRANTS } from '../../tests/faults/harness.mjs'
import { ORACLE_EPOCH, oracleLog, traceAdapter } from '../../tests/faults/oracle.mjs'

const BUDGET = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 20, maxExperiments: 0 }
/**
 * Long enough that no publish/submit can lose the lease race under host load.
 * The lease-expiry path is exercised by forcing `attempt.leaseUntil` into the
 * past through durable state, never by waiting for a short lease to elapse.
 */
const LEASE_MS = 60000

/**
 * Records every adapter command and counts any provider invocation (always
 * zero); the shared FakeWorkers answers every other adapter method. Like it,
 * this adapter deliberately has no `prepareBaseline` and no `checkEnvelope`:
 * either would add `workspace/snapshot` or `task/check-envelope` events to the
 * durable log the golden digest is taken from.
 */
export class RecordingWorkers extends FakeWorkers {
  commands = []
  providerCalls = 0
  checks = [{ command: 'replay-check', exitCode: 0, output: 'ok' }]
  artifacts = 0
  autoIdle = true
  constructor(root) { super(); this.root = root }
  async prepareWorkspace(_mission, memberId) { return join(this.root, 'worktrees', memberId) }
  async stop(memberId) { this.commands.push({ kind: 'stop', memberId }) }
  async captureArtifact() { this.artifacts++; return { commit: `commit-${this.artifacts}`, baseCommit: 'base', workspace: join(this.root, 'worktrees', 'capture'), changedPaths: ['src/a.ts'] } }
  async verifyArtifact(_member, source) { this.commands.push({ kind: 'verify', sourceTaskId: source.id }); return this.checks }
  async prepareTask(member, task) { this.commands.push({ kind: 'dispatch', taskId: task.id, memberId: member.id }) }
}

/** One step of scenario time between the tool calls, as a model turn would take. */
const STEP_MS = 1000

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
  const clock = new FakeClock(ORACLE_EPOCH)
  const { adapter, calls } = traceAdapter(workers)
  const runtime = new SwarmRuntime({ statePath, leaseMs: LEASE_MS, tickMs: 60000, manualTick: true, now: clock.now, stallPassTimeoutMs: 60000, maxMessageChars: 16000, maxEvents: 200, maxTasksPerMember: 3, grants: NO_GRANTS }, adapter)
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, BUDGET)
  const exec = sessionId => ({ agent: { id: sessionId, session: { header: { cwd: workspace } } }, signal: new AbortController().signal })
  // Every tool call is one step: the clock moves, the call runs, and the bodies
  // it kicked settle before the scenario reads what they decided.
  let missionId
  const call = async (name, args, sessionId) => {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`Unknown tool ${name}`)
    clock.advance(STEP_MS)
    const result = await definition.execute(args, exec(sessionId))
    if (missionId !== undefined) await runtime.settle(missionId)
    return result
  }
  const taskOf = id => runtime.store.get('tasks', id)
  const until = (read, message) => { const value = read(); if (!value) throw new Error(`replay scenario did not settle: ${message}`); return value }
  const running = id => until(() => { const task = taskOf(id); return task?.status === 'running' ? task : undefined }, `${id} to be dispatched`)
  const attemptOf = id => taskOf(id)?.attempt?.id
  const owner = 'replay-owner-session'
  try {
    const mission = (await call('swarm_create', { title: 'Replay mission', objective: 'Reconstruct every decision', workspace, scope: ['src/'], acceptance: ['works'], budget: BUDGET }, owner)).result
    missionId = mission.id
    const stream = (await call('swarm_workstream', { missionId: mission.id, title: 'Core', objective: 'Deliver the module' }, owner)).result
    const builder = (await call('swarm_add_member', { missionId: mission.id, name: 'Builder', role: 'implementation' }, owner)).result
    const reviewer = (await call('swarm_add_member', { missionId: mission.id, name: 'Reviewer', role: 'verification' }, owner)).result
    const propose = async (extra, sessionId = owner) => (await call('swarm_propose', { missionId, workstreamId: stream.id, outputs: [], scope: ['src/'], acceptance: ['works'], ...extra }, sessionId)).result
    const publish = async (taskId, sessionId) => {
      const runId = await workers.callbacks.toolRun(builder.id, { tool: 'bash', arguments: { command: 'true' }, result: { output: 'ok' }, isError: false })
      await call('swarm_publish', { missionId, taskId, attemptId: attemptOf(taskId), claim: `Evidence for ${taskId}`, outcome: 'supported', toolRunIds: [runId] }, sessionId)
    }

    // Task 1: dispatch, evidence, submission.
    const first = await propose({ title: 'Implement one', objective: 'Deliver one', kind: 'implementation', checks: ['replay-check'], assigneeId: builder.id })
    running(first.id)
    await publish(first.id, builder.sessionId)
    await call('swarm_submit', { missionId, taskId: first.id, attemptId: attemptOf(first.id), output: 'first candidate' }, builder.sessionId)

    // Task 2: dispatch, lease expiry (checkpoint + stop + re-dispatch), submission.
    const second = await propose({ title: 'Implement two', objective: 'Deliver two', kind: 'implementation', checks: ['replay-check'], assigneeId: builder.id })
    const firstAttempt = running(second.id).attempt.id
    // The dispatching body has settled, so the resume below opens a body of its
    // own. Drive lease expiry from durable state, not from the clock: the
    // scheduler's recovery path reads `attempt.leaseUntil`, so writing it into
    // the past produces the identical checkpoint/stop/re-dispatch commands.
    const expiring = runtime.store.get('tasks', second.id)
    expiring.attempt.leaseUntil = clock.now() - 1
    runtime.store.transaction(() => runtime.store.put('tasks', expiring))
    await call('swarm_control', { missionId, action: 'resume', reason: 'replay: drive lease expiry' }, owner)
    const redispatch = until(() => { const task = taskOf(second.id); return task?.status === 'running' && task.attempt?.id !== firstAttempt ? task : undefined }, 'the expired attempt to be re-dispatched')
    await publish(second.id, builder.sessionId)
    await call('swarm_submit', { missionId, taskId: second.id, attemptId: redispatch.attempt.id, output: 'second candidate' }, builder.sessionId)

    // Independent verification of task 2.
    const review = await propose({ title: 'Review two', objective: 'Independent review', kind: 'verification', checks: [], reviewOf: second.id, assigneeId: reviewer.id })
    running(review.id)
    await call('swarm_verify', { missionId, taskId: review.id, attemptId: attemptOf(review.id), verdict: 'accept', reason: 'Independent accept' }, reviewer.sessionId)

    const commands = workers.commands
    const providerCalls = workers.providerCalls
    const log = oracleLog(runtime, calls, [workspace, await realpath(root), root])
    await runtime.dispose()
    return { root, ownsRoot, workspace, statePath, missionId, log,
      commands, providerCalls, builderId: builder.id, reviewerId: reviewer.id, tasks: { first: first.id, second: second.id, review: review.id } }
  } catch (error) {
    await runtime.dispose().catch(() => {})
    if (ownsRoot) await rm(root, { recursive: true, force: true })
    throw error
  }
}
