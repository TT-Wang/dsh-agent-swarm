/**
 * R11-07 regression: a host restart re-pends every running task with a durable
 * per-task event naming it and spends no recovery credit, so a
 * `maxRecoveryAttempts: 1` task survives one restart.
 *
 * Pre-fix head: `start()` incremented `recoveryCount` for a running task and
 * blocked it at the limit, and the only durable row was the generic
 * `mission/recovered`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

class Workers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact() { return { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] } }
  async verifyArtifact() { return [] }
  async dispose() {}
}

const config = statePath => ({ statePath, leaseMs: 60000, tickMs: 60000, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 3 })

async function firstHost(t, statePath) {
  const runtime = new SwarmRuntime(config(statePath), new Workers())
  await runtime.start()
  const owner = { sessionId: 'restart-owner' }
  const mission = runtime.create(owner, { title: 'Restart', objective: 'Survive a host restart', workspace: '/source', scope: ['**'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Long task', objective: 'Survive', kind: 'implementation',
    scope: ['**'], acceptance: ['works'], checks: ['test'], assigneeId: member.id, maxRecoveryAttempts: 1 })
  const claimed = await runtime.claim({ sessionId: member.sessionId }, mission.id, task.id)
  await runtime.dispose()
  return { owner, mission, member, task, claimed }
}

test('R11-07: a restart re-pends a running task with a per-task event and spends no recovery credit', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-restart-'))
  const statePath = join(directory, 'state.sqlite')
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const f = await firstHost(t, statePath)
  const running = new SwarmRuntime(config(statePath), new Workers())
  t.after(async () => { await running.dispose().catch(() => undefined) })
  await running.start()
  const restarted = running.store.get('tasks', f.task.id)
  assert.equal(restarted.recoveryCount ?? 0, 0, 'a host-caused stop spends no recovery credit')
  assert.equal(restarted.status, 'pending', 'the task is re-pended, not blocked at maxRecoveryAttempts: 1')
  assert.equal(restarted.attempt, undefined, 'the dead attempt is fenced')
  assert.equal(restarted.epoch, f.claimed.epoch + 1, 'the re-pend advances the epoch')
  const repended = running.store.events(f.mission.id, 500).filter(event => event.type === 'task/restart-repended')
  assert.equal(repended.length, 1, 'exactly one per-task restart event names the task')
  assert.equal(repended[0].data.taskId, f.task.id)
  assert.equal(repended[0].data.reason, 'host-restart')
  assert.equal(repended[0].data.ownerId, f.member.id)
  assert.equal(repended[0].data.recoveryCount, 0)
  assert.equal(repended[0].data.maxRecoveryAttempts, 1)
  assert.ok(running.store.events(f.mission.id, 500).some(event => event.type === 'mission/recovered'), 'the generic mission event is preserved')
  // The task is schedulable again after the restart: a fresh claim succeeds.
  const reclaimed = await running.claim({ sessionId: f.member.sessionId }, f.mission.id, f.task.id)
  assert.equal(reclaimed.status, 'running')
  assert.equal(reclaimed.recoveryCount ?? 0, 0, 'the second attempt also starts with no credit spent')
})

test('R11-07: a task already at its recovery limit still re-pends once after a restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-restart-limit-'))
  const statePath = join(directory, 'state.sqlite')
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const f = await firstHost(t, statePath)
  // Simulate a task that spent its single credit on an earlier worker failure.
  const runtime = new SwarmRuntime(config(statePath), new Workers())
  await runtime.start()
  const stored = runtime.store.get('tasks', f.task.id)
  stored.recoveryCount = 1
  runtime.store.transaction(() => runtime.store.put('tasks', stored))
  await runtime.dispose()
  const again = new SwarmRuntime(config(statePath), new Workers())
  t.after(async () => { await again.dispose().catch(() => undefined) })
  await again.start()
  const restarted = again.store.get('tasks', f.task.id)
  assert.equal(restarted.status, 'pending', 'a host restart never converts a running task into blocked work')
  assert.equal(restarted.recoveryCount, 1, 'the earlier worker credit is preserved, not increased')
})
