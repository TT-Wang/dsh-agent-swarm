/**
 * F8 regression: `recordToolRun` may extend the current attempt's lease, but a
 * stored lease must never outlive the mission deadline. Every other renewal
 * (`fenceAttempt`, `beforeStep`, `renewActiveOperation`, budget resume) already
 * clamps to `mission.deadline`; the tool-run path did not.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

class RunWorkers {
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-f8-'))
  const workers = new RunWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 200, maxTasksPerMember: 10 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'f8-owner' }
  const mission = runtime.create(owner, { title: 'F8', objective: 'Clamp the stored lease', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget, ...overrides } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'] })
  const claimed = await runtime.claim({ sessionId: author.sessionId }, mission.id, task.id)
  return { runtime, workers, owner, mission, author, task, claimed }
}

test('F8: a recorded tool run never extends the attempt lease past the mission deadline', async t => {
  // The mission expires in three seconds while the configured lease is one minute.
  const f = await fixture(t, { maxDurationMs: 3000 })
  const deadline = f.runtime.snapshot(f.owner, f.mission.id).mission.deadline
  const before = Date.now()
  const runId = await f.workers.callbacks.toolRun(f.author.id, { tool: 'bash', arguments: { command: 'true' }, result: { exitCode: 0 }, isError: false })
  assert.equal(typeof runId, 'string', 'the run is still recorded')
  assert.equal(f.runtime.store.toolRuns(f.mission.id).length, 1)
  const stored = f.runtime.store.get('tasks', f.task.id)
  assert.ok(stored.attempt.leaseUntil <= deadline, `stored lease ${stored.attempt.leaseUntil} outlives deadline ${deadline}`)
  assert.ok(stored.attempt.leaseUntil >= before, 'the lease still extends within the mission window')
  assert.ok(Date.now() + 60000 > deadline, 'the configured lease would have outlived the mission without the clamp')
})

test('F8: the clamp preserves a normal lease extension inside the mission window', async t => {
  const f = await fixture(t)
  const deadline = f.runtime.snapshot(f.owner, f.mission.id).mission.deadline
  const before = Date.now()
  await f.workers.callbacks.toolRun(f.author.id, { tool: 'bash', arguments: { command: 'true' }, result: { exitCode: 0 }, isError: false })
  const stored = f.runtime.store.get('tasks', f.task.id)
  assert.ok(stored.attempt.leaseUntil > before + 30000, 'a live lease is still extended by the configured window')
  assert.ok(stored.attempt.leaseUntil <= deadline, 'the extension stays inside the mission deadline')
})
