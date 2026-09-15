import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { executionElapsed } from '../lib/resource-time.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 4, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const flush = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-resource-review-'))
  let releaseStop, releaseCheckpoint
  const workers = {
    stops: [], bind(callbacks) { this.callbacks = callbacks },
    async prepareWorkspace(_mission, id) { return `/isolated/${id}` }, async start() {},
    async stop(id) { this.stops.push(id); await this.stopGate },
    checkpoints: [], async checkpointTask(member, task) { this.checkpoints.push({ memberId: member.id, taskId: task.id }); await this.checkpointGate },
    async prepareTask() {}, async deliver() {}, isIdle() { return false }, async dispose() {},
  }
  const config = { statePath: join(root, 'state.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 3 }
  let rt = new SwarmRuntime(config, workers)
  rt.kick = () => {}
  t.after(async () => { releaseStop?.(); releaseCheckpoint?.(); workers.stopGate = undefined; workers.checkpointGate = undefined; await rt.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner' }
  const mission = rt.create(owner, { title: 'Review recovery', objective: 'Keep same work safely', workspace: root, scope: ['src/'], acceptance: ['works'], budget })
  const stream = rt.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await rt.addMember(owner, mission.id, { name: 'A', role: 'implementation' })
  const other = await rt.addMember(owner, mission.id, { name: 'B', role: 'implementation' })
  const actor = { sessionId: member.sessionId }
  const task = rt.propose(owner, mission.id, { workstreamId: stream.id, title: 'Work', objective: 'Implement source', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], maxSteps: 1, maxFindings: 5, maxRecoveryAttempts: 2, checkTimeoutMs: 1000, assigneeId: member.id })
  return { get rt() { return rt }, workers, owner, mission, member, other, actor, task,
    async restart() { await rt.dispose(); rt = new SwarmRuntime(config, workers); rt.kick = () => {}; await rt.start() },
    holdCheckpoint() { workers.checkpointGate = new Promise(resolve => { releaseCheckpoint = resolve }); return () => { releaseCheckpoint(); workers.checkpointGate = undefined } },
    holdStop() { workers.stopGate = new Promise(resolve => { releaseStop = resolve }); return () => { releaseStop(); workers.stopGate = undefined } },
    nextTask(assigneeId = member.id) { return rt.propose(owner, mission.id, { workstreamId: stream.id, title: 'Next', objective: 'Next work', kind: 'implementation', scope: ['src/next.ts'], acceptance: ['works'], checks: ['test'], maxSteps: 5, maxFindings: 5, maxRecoveryAttempts: 2, checkTimeoutMs: 1000, assigneeId }) },
  }
}

test('review: terminal stop settles the execution clock permanently', async t => {
  const f = await fixture(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  await f.rt.claim(f.actor, f.mission.id, f.task.id)
  now += 1000
  f.rt.control(f.owner, f.mission.id, 'stop', 'All work stopped')
  const atStop = executionElapsed(f.rt.mission(f.mission.id))
  now += 50000
  assert.equal(executionElapsed(f.rt.mission(f.mission.id)), atStop, 'terminal history must not accumulate later wall time')
})

test('review: pause preserves the pending resource stop barrier across reassignment', async t => {
  const f = await fixture(t)
  await f.rt.claim(f.actor, f.mission.id, f.task.id)
  const release = f.holdStop()
  await f.workers.callbacks.beforeStep(f.member.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.member.id), false)
  await flush()
  assert.ok(f.workers.stops.includes(f.member.id))
  assert.equal(f.rt.task(f.mission.id, f.task.id).resumeAfterStop.reason, 'resource')
  f.rt.control(f.owner, f.mission.id, 'pause', 'Pause while stop is pending')
  f.rt.controlTask(f.owner, f.mission.id, f.task.id, 'amend', { maxSteps: 5, assigneeId: f.other.id }, 'Reassign preserved work')
  f.rt.control(f.owner, f.mission.id, 'resume', 'Continue once safe')
  await assert.rejects(f.rt.claim({ sessionId: f.other.sessionId }, f.mission.id, f.task.id), /stop|ready|pending|quiescen/i, 'another worker cannot prepare the work before prior stop acknowledgement')
  release()
  await until(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined)
  assert.equal((await f.rt.claim({ sessionId: f.other.sessionId }, f.mission.id, f.task.id)).attempt.ownerId, f.other.id)
})

async function until(predicate) {
  for (let i = 0; i < 50; i++) { if (predicate()) return; await flush() }
  assert.ok(predicate(), 'expected deferred stop/checkpoint to settle')
}

test('review: paused stop can checkpoint without resuming or notifying the user', async t => {
  const f = await fixture(t)
  await f.rt.claim(f.actor, f.mission.id, f.task.id)
  const release = f.holdCheckpoint()
  f.rt.control(f.owner, f.mission.id, 'pause', 'User pauses work')
  await until(() => f.workers.checkpoints.length === 1)
  assert.ok(f.rt.task(f.mission.id, f.task.id).resumeAfterStop)
  assert.equal(f.rt.task(f.mission.id, f.task.id).status, 'blocked')
  release()
  await until(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined)
  assert.equal(f.rt.mission(f.mission.id).status, 'paused')
  assert.equal(f.rt.task(f.mission.id, f.task.id).status, 'pending')
  await assert.rejects(f.rt.claim(f.actor, f.mission.id, f.task.id), /active|paused/i)
  assert.equal(f.rt.store.list('deliveries', f.mission.id).filter(row => row.to === 'owner').length, 0)
})

test('review: cancellation blocks member reuse until the old workspace checkpoint finishes', async t => {
  const f = await fixture(t)
  await f.rt.claim(f.actor, f.mission.id, f.task.id)
  const next = f.nextTask()
  const release = f.holdCheckpoint()
  f.rt.cancel(f.owner, f.mission.id, { taskId: f.task.id, reason: 'Withdraw this work' })
  await until(() => f.workers.checkpoints.length === 1)
  assert.equal(f.rt.task(f.mission.id, f.task.id).status, 'cancelled')
  await assert.rejects(f.rt.claim(f.actor, f.mission.id, next.id), /stop|quiescen/i)
  release()
  await until(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined)
  assert.equal(f.rt.task(f.mission.id, f.task.id).status, 'cancelled')
  await f.rt.claim(f.actor, f.mission.id, next.id)
  assert.deepEqual(f.workers.stops, [f.member.id])
})

test('review: cancelling an in-flight resource stop neither duplicates stop nor resurrects its task', async t => {
  const f = await fixture(t)
  await f.rt.claim(f.actor, f.mission.id, f.task.id)
  const release = f.holdStop()
  await f.workers.callbacks.beforeStep(f.member.id)
  await f.workers.callbacks.beforeStep(f.member.id)
  await until(() => f.workers.stops.length === 1)
  const before = f.rt.task(f.mission.id, f.task.id)
  f.rt.cancel(f.owner, f.mission.id, { taskId: f.task.id, reason: 'Cancel fenced work' })
  assert.equal(f.rt.task(f.mission.id, f.task.id).epoch, before.epoch)
  assert.deepEqual(f.rt.task(f.mission.id, f.task.id).resumeAfterStop, before.resumeAfterStop)
  release()
  await until(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined)
  assert.equal(f.rt.task(f.mission.id, f.task.id).status, 'cancelled')
  assert.deepEqual(f.workers.stops, [f.member.id])
})

test('review: cold recovery preserves a cancelled stop marker until checkpoint confirmation', async t => {
  const f = await fixture(t)
  const old = f.rt.task(f.mission.id, f.task.id)
  old.status = 'cancelled'
  old.resumeAfterStop = { epoch: old.epoch, memberId: f.member.id, reason: 'handoff', at: Date.now() }
  f.rt.commit(f.mission.id, () => f.rt.store.put('tasks', old))
  const next = f.nextTask()
  const release = f.holdCheckpoint()
  await f.restart()
  await until(() => f.workers.checkpoints.length === 1)
  assert.ok(f.rt.task(f.mission.id, f.task.id).resumeAfterStop)
  await assert.rejects(f.rt.claim(f.actor, f.mission.id, next.id), /stop|quiescen/i)
  release()
  await until(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined)
  assert.equal(f.rt.task(f.mission.id, f.task.id).status, 'cancelled')
  await f.rt.claim(f.actor, f.mission.id, next.id)
})

test('review: cancelling submitted work preserves its artifact and does not stop its historical author', async t => {
  const f = await fixture(t)
  await f.rt.claim(f.actor, f.mission.id, f.task.id)
  const submitted = f.rt.task(f.mission.id, f.task.id)
  submitted.status = 'submitted'
  submitted.artifact = { commit: 'immutable-commit', baseCommit: 'base', files: ['src/old.ts'] }
  f.rt.commit(f.mission.id, () => f.rt.store.put('tasks', submitted))
  const next = f.nextTask()
  await f.rt.claim(f.actor, f.mission.id, next.id)
  f.rt.cancel(f.owner, f.mission.id, { taskId: f.task.id, reason: 'Withdraw old artifact' })
  await flush()
  assert.deepEqual(f.rt.task(f.mission.id, f.task.id).artifact, submitted.artifact)
  assert.equal(f.rt.task(f.mission.id, f.task.id).resumeAfterStop, undefined)
  assert.equal(f.rt.task(f.mission.id, next.id).status, 'running')
  assert.deepEqual(f.workers.stops, [])
})

test('review: legacy handoff recovery uses the recorded old owner instead of its new target', async t => {
  const f = await fixture(t)
  const old = f.rt.task(f.mission.id, f.task.id)
  old.status = 'blocked'; old.assigneeId = f.other.id
  old.priorOwnerIds = [f.member.id, f.other.id]
  old.resumeAfterStop = { epoch: old.epoch, reason: 'handoff', at: Date.now() }
  f.rt.commit(f.mission.id, () => {
    f.rt.store.put('tasks', old)
    f.rt.store.event(f.mission.id, 'task/handoff-started', f.member.id, { taskId: old.id, to: f.other.id })
  })
  await f.restart()
  await until(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined)
  assert.deepEqual(f.workers.stops, [f.member.id])
  assert.equal(f.rt.task(f.mission.id, f.task.id).status, 'pending')
  assert.equal(f.rt.task(f.mission.id, f.task.id).assigneeId, f.other.id)
})

for (const separateBlock of ['none', 'artifact', 'preparation', 'refuted', 'maxSteps']) test(`review: restart clears legacy finding ceilings without clearing ${separateBlock} policy`, async t => {
  const f = await fixture(t)
  f.rt.control(f.owner, f.mission.id, 'pause', 'Keep upgrade quiet')
  const old = f.rt.task(f.mission.id, f.task.id)
  old.status = 'blocked'
  old.ceiling = { dimension: separateBlock === 'maxSteps' ? 'maxSteps' : 'maxFindings', used: 5, limit: 5, reason: 'Legacy ceiling', at: Date.now() }
  if (separateBlock === 'artifact') old.artifact = { commit: 'immutable-rejected', changedPaths: ['src/a.ts'] }
  if (separateBlock === 'preparation') old.preparationFailure = { reason: 'Workspace requires repair', at: Date.now() }
  if (separateBlock === 'refuted') old.evidenceIds = ['refuted-evidence']
  f.rt.commit(f.mission.id, () => {
    f.rt.store.put('tasks', old)
    if (separateBlock === 'refuted') f.rt.store.put('evidence', { id: 'refuted-evidence', missionId: f.mission.id, taskId: old.id, status: 'refuted', outcome: 'supported', supersedes: [], createdAt: Date.now() })
  })
  await f.restart()
  const restored = f.rt.task(f.mission.id, old.id)
  assert.equal(f.rt.mission(f.mission.id).status, 'paused')
  assert.equal(restored.status, separateBlock === 'none' ? 'pending' : 'blocked')
  if (separateBlock === 'maxSteps') assert.equal(restored.ceiling.dimension, 'maxSteps')
  else assert.equal(restored.ceiling, undefined)
})

test('review: finding-ceiling migration retains a separate repair block after its pending checkpoint', async t => {
  const f = await fixture(t)
  f.rt.control(f.owner, f.mission.id, 'pause', 'Preserve user pause')
  const old = f.rt.task(f.mission.id, f.task.id)
  old.status = 'blocked'
  old.ceiling = { dimension: 'maxFindings', used: 5, limit: 5, reason: 'Legacy ceiling', at: Date.now() }
  old.preparationFailure = { reason: 'Workspace needs repair', at: Date.now() }
  old.resumeAfterStop = { epoch: old.epoch, memberId: f.member.id, reason: 'resource', at: Date.now() }
  f.rt.commit(f.mission.id, () => f.rt.store.put('tasks', old))
  await f.restart()
  await until(() => f.rt.task(f.mission.id, old.id).resumeAfterStop === undefined)
  const restored = f.rt.task(f.mission.id, old.id)
  assert.equal(restored.status, 'blocked')
  assert.equal(restored.ceiling, undefined)
  assert.equal(restored.preparationFailure.reason, old.preparationFailure.reason)
  assert.equal(f.rt.mission(f.mission.id).status, 'paused')
})

test('review: ambiguous legacy owner recovery stops every candidate and preserves other live work', async t => {
  const f = await fixture(t)
  const peer = f.nextTask(f.other.id)
  await f.rt.claim({ sessionId: f.other.sessionId }, f.mission.id, peer.id)
  const legacy = f.rt.task(f.mission.id, f.task.id)
  legacy.status = 'blocked'
  legacy.resumeAfterStop = { epoch: legacy.epoch, reason: 'handoff', at: Date.now() }
  f.rt.commit(f.mission.id, () => f.rt.store.put('tasks', legacy))
  const releaseStop = f.holdStop(), releaseCheckpoint = f.holdCheckpoint()
  f.rt.attempts.resumeStoppedAttempt(f.mission.id, legacy)
  await until(() => f.workers.stops.length === 2)
  assert.deepEqual(new Set(f.workers.stops), new Set([f.member.id, f.other.id]))
  assert.equal(f.rt.task(f.mission.id, peer.id).status, 'blocked', 'the scan fences other running work before stopping its handle')
  const next = f.nextTask(f.other.id)
  await assert.rejects(f.rt.claim({ sessionId: f.other.sessionId }, f.mission.id, next.id), /stop|quiescen/i)
  releaseStop()
  await until(() => f.workers.checkpoints.length > 0)
  assert.ok(f.rt.task(f.mission.id, legacy.id).resumeAfterStop, 'stop acknowledgements alone do not clear the legacy obligation')
  releaseCheckpoint()
  await until(() => [legacy, peer].every(task => f.rt.task(f.mission.id, task.id).resumeAfterStop === undefined))
  for (const task of [legacy, peer]) assert.equal(f.rt.task(f.mission.id, task.id).status, 'pending')
  assert.equal(f.rt.mission(f.mission.id).status, 'active')
  await f.rt.claim({ sessionId: f.other.sessionId }, f.mission.id, next.id)
})
