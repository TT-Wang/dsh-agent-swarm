/**
 * Shared trace fixture: a real runtime plus real model tools driven through a
 * complete propose -> claim -> publish -> submit -> review -> verdict flow that
 * also retires a sibling review. `isIdle()` is false so the scheduler never
 * auto-dispatches and every claim is an explicit `swarm_claim` step.
 */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SwarmRuntime } from '../../lib/runtime.js'
import { registerTools } from '../../lib/tools.js'
import { TracePayloadStore } from '../../lib/trace.js'

export const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 20, maxExperiments: 0 }

export class TraceWorkers {
  constructor() { this.commands = []; this.stopped = []; this.checks = [{ command: 'test', exitCode: 0, output: 'ok' }]; this.artifacts = 0 }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, memberId) { return `/isolated/${memberId}` }
  async start() {}
  async deliver() {}
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle() { return false }
  async captureArtifact() { this.artifacts++; return { commit: `commit-${this.artifacts}`, baseCommit: 'base', workspace: '/isolated', changedPaths: ['src/a.ts'] } }
  async verifyArtifact() { return this.checks }
  async prepareTask() {}
  async dispose() {}
}

export async function traceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-trace-'))
  const workspace = await realpath(await mkdtemp(join(root, 'ws-')))
  const statePath = join(root, 'db.sqlite')
  const workers = new TraceWorkers()
  const runtime = new SwarmRuntime({ statePath, leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  const exec = sessionId => ({ agent: { id: sessionId, session: { header: { cwd: workspace } } }, signal: new AbortController().signal })
  const raw = (name, args, sessionId) => definitions.get(name).execute(args, exec(sessionId))
  const call = async (name, args, sessionId) => (await raw(name, args, sessionId)).result

  const owner = 'trace-owner-session'
  const mission = await call('swarm_create', { title: 'Trace mission', objective: 'Reconstruct every decision', workspace, scope: ['src/'], acceptance: ['works'], budget }, owner)
  const missionId = mission.id
  const stream = await call('swarm_workstream', { missionId, title: 'Core', objective: 'Deliver the module' }, owner)
  const builder = await call('swarm_add_member', { missionId, name: 'Builder', role: 'implementation' }, owner)
  const reviewer = await call('swarm_add_member', { missionId, name: 'Reviewer', role: 'verification' }, owner)
  const reviewer2 = await call('swarm_add_member', { missionId, name: 'Second reviewer', role: 'verification' }, owner)
  const source = await call('swarm_propose', { missionId, workstreamId: stream.id, title: 'Implement', objective: 'Deliver the module', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: builder.id }, owner)
  const claim = await call('swarm_claim', { missionId, taskId: source.id }, builder.sessionId)
  const runId = await workers.callbacks.toolRun(builder.id, { tool: 'bash', arguments: { command: 'true' }, result: { output: 'ok' }, isError: false })
  const bigClaim = `evidence-${'x'.repeat(4000)}`
  await call('swarm_publish', { missionId, taskId: source.id, attemptId: claim.attempt.id, claim: bigClaim, outcome: 'supported', toolRunIds: [runId] }, builder.sessionId)
  await call('swarm_submit', { missionId, taskId: source.id, attemptId: claim.attempt.id, output: 'candidate' }, builder.sessionId)
  const review = await call('swarm_propose', { missionId, workstreamId: stream.id, title: 'Review', objective: 'Independent review', kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: source.id, assigneeId: reviewer.id }, owner)
  const reviewClaim = await call('swarm_claim', { missionId, taskId: review.id }, reviewer.sessionId)
  const review2 = await call('swarm_propose', { missionId, workstreamId: stream.id, title: 'Second review', objective: 'Independent review', kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: source.id, assigneeId: reviewer2.id }, owner)
  const review2Claim = await call('swarm_claim', { missionId, taskId: review2.id }, reviewer2.sessionId)
  const verdict = await call('swarm_verify', { missionId, taskId: review.id, attemptId: reviewClaim.attempt.id, verdict: 'accept', reason: 'Independent accept' }, reviewer.sessionId)
  const events = () => runtime.store.events(missionId, 1000, 0)
  return {
    root, workspace, statePath, runtime, workers, definitions, raw, call, exec, owner, missionId, stream, builder, reviewer, reviewer2,
    source, claim, review, reviewClaim, review2, review2Claim, verdict, runId, bigClaim, events,
    task: id => runtime.store.get('tasks', id),
    payloads: new TracePayloadStore(join(dirname(statePath), 'trace-payloads')),
  }
}
