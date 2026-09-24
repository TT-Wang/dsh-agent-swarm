import test from 'node:test'
import assert from 'node:assert/strict'
import { executionElapsed } from '../lib/resource-time.js'
import { FakeWorkers, SwarmRuntime, budget as sharedBudget, eventually, makeRuntime } from './faults/harness.mjs'

const budget = { ...sharedBudget, maxTokens: 100000, maxSteps: 100, maxWorkers: 4, maxTasks: 20, maxExperiments: 2 }
const flush = () => new Promise(resolve => setImmediate(resolve))
/** Records every stop and checkpoint, each behind a gate a test can hold. */
class GatedWorkers extends FakeWorkers {
  stops = []; checkpoints = []
  async stop(id) { this.stops.push(id); await this.stopGate }
  async checkpointTask(member, task) { this.checkpoints.push({ memberId: member.id, taskId: task.id }); await this.checkpointGate }
}
async function fixture(t) {
  let releaseStop, releaseCheckpoint, rt, workers
  // Registered first, so the gates open and the current (possibly restarted) runtime is disposed before makeRuntime removes the state dir.
  t.after(async () => { releaseStop?.(); releaseCheckpoint?.(); workers.stopGate = undefined; workers.checkpointGate = undefined; await rt.dispose() })
  const made = await makeRuntime(t, {
    workers: new GatedWorkers(),
    config: { tickMs: 60000, maxEvents: 500, checkTimeoutMs: undefined },
  })
  const { dir: root, config } = made
  ;({ runtime: rt, workers } = made)
  rt.kick = () => {}
  const owner = { sessionId: 'owner' }
  const mission = rt.create(owner, { title: 'Review recovery', objective: 'Keep same work safely', workspace: root, scope: ['src/'], acceptance: ['works'], budget })
  const stream = rt.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await rt.addMember(owner, mission.id, { name: 'A', role: 'implementation' })
  const other = await rt.addMember(owner, mission.id, { name: 'B', role: 'implementation' })
  const actor = { sessionId: member.sessionId }
  const task = rt.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Work', objective: 'Implement source', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], maxSteps: 1, maxFindings: 5, maxRecoveryAttempts: 2, checkTimeoutMs: 1000, assigneeId: member.id })
  return { get rt() { return rt }, workers, owner, mission, member, other, actor, task,
    async restart() { await rt.dispose(); rt = new SwarmRuntime(config, workers); rt.kick = () => {}; await rt.start() },
    holdCheckpoint() { workers.checkpointGate = new Promise(resolve => { releaseCheckpoint = resolve }); return () => { releaseCheckpoint(); workers.checkpointGate = undefined } },
    holdStop() { workers.stopGate = new Promise(resolve => { releaseStop = resolve }); return () => { releaseStop(); workers.stopGate = undefined } },
    nextTask(assigneeId = member.id) { return rt.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Next', objective: 'Next work', kind: 'implementation', scope: ['src/next.ts'], acceptance: ['works'], checks: ['test'], maxSteps: 5, maxFindings: 5, maxRecoveryAttempts: 2, checkTimeoutMs: 1000, assigneeId }) },
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
  await eventually(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined, 'expected deferred stop/checkpoint to settle')
  assert.equal((await f.rt.claim({ sessionId: f.other.sessionId }, f.mission.id, f.task.id)).attempt.ownerId, f.other.id)
})


test('review: paused stop can checkpoint without resuming or notifying the user', async t => {
  const f = await fixture(t)
  await f.rt.claim(f.actor, f.mission.id, f.task.id)
  const release = f.holdCheckpoint()
  f.rt.control(f.owner, f.mission.id, 'pause', 'User pauses work')
  await eventually(() => f.workers.checkpoints.length === 1, 'expected deferred stop/checkpoint to settle')
  assert.ok(f.rt.task(f.mission.id, f.task.id).resumeAfterStop)
  assert.equal(f.rt.task(f.mission.id, f.task.id).status, 'blocked')
  release()
  await eventually(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined, 'expected deferred stop/checkpoint to settle')
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
  await eventually(() => f.workers.checkpoints.length === 1, 'expected deferred stop/checkpoint to settle')
  assert.equal(f.rt.task(f.mission.id, f.task.id).status, 'cancelled')
  await assert.rejects(f.rt.claim(f.actor, f.mission.id, next.id), /stop|quiescen/i)
  release()
  await eventually(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined, 'expected deferred stop/checkpoint to settle')
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
  await eventually(() => f.workers.stops.length === 1, 'expected deferred stop/checkpoint to settle')
  const before = f.rt.task(f.mission.id, f.task.id)
  f.rt.cancel(f.owner, f.mission.id, { taskId: f.task.id, reason: 'Cancel fenced work' })
  assert.equal(f.rt.task(f.mission.id, f.task.id).epoch, before.epoch)
  assert.deepEqual(f.rt.task(f.mission.id, f.task.id).resumeAfterStop, before.resumeAfterStop)
  release()
  await eventually(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined, 'expected deferred stop/checkpoint to settle')
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
  await eventually(() => f.workers.checkpoints.length === 1, 'expected deferred stop/checkpoint to settle')
  assert.ok(f.rt.task(f.mission.id, f.task.id).resumeAfterStop)
  await assert.rejects(f.rt.claim(f.actor, f.mission.id, next.id), /stop|quiescen/i)
  release()
  await eventually(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined, 'expected deferred stop/checkpoint to settle')
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
  await eventually(() => f.rt.task(f.mission.id, f.task.id).resumeAfterStop === undefined, 'expected deferred stop/checkpoint to settle')
  assert.deepEqual(f.workers.stops, [f.member.id])
  assert.equal(f.rt.task(f.mission.id, f.task.id).status, 'pending')
  assert.equal(f.rt.task(f.mission.id, f.task.id).assigneeId, f.other.id)
})

for (const separateBlock of ['none', 'recovery', 'artifact', 'preparation', 'refuted', 'maxSteps']) test(`review: restart clears legacy finding ceilings without clearing ${separateBlock} policy`, async t => {
  const f = await fixture(t)
  f.rt.control(f.owner, f.mission.id, 'pause', 'Keep upgrade quiet')
  const old = f.rt.task(f.mission.id, f.task.id)
  old.status = 'blocked'
  old.ceiling = { dimension: separateBlock === 'maxSteps' ? 'maxSteps' : 'maxFindings', used: 5, limit: 5, reason: 'Legacy ceiling', at: Date.now() }
  if (separateBlock === 'artifact') old.artifact = { commit: 'immutable-rejected', changedPaths: ['src/a.ts'] }
  if (separateBlock === 'preparation') old.preparationFailure = { reason: 'Workspace requires repair', at: Date.now() }
  // A host restart never spends or checks recovery credit (R11-07): a spent
  // recovery limit alone does not keep the retired-ceiling task blocked.
  if (separateBlock === 'recovery') Object.assign(old, { recoveryCount: 1, maxRecoveryAttempts: 1 })
  if (separateBlock === 'refuted') old.evidenceIds = ['refuted-evidence']
  f.rt.commit(f.mission.id, () => {
    f.rt.store.put('tasks', old)
    if (separateBlock === 'refuted') f.rt.store.put('evidence', { id: 'refuted-evidence', missionId: f.mission.id, taskId: old.id, status: 'refuted', outcome: 'supported', supersedes: [], createdAt: Date.now() })
  })
  await f.restart()
  const restored = f.rt.task(f.mission.id, old.id)
  assert.equal(f.rt.mission(f.mission.id).status, 'paused')
  assert.equal(restored.status, separateBlock === 'none' || separateBlock === 'recovery' ? 'pending' : 'blocked')
  if (separateBlock === 'recovery') assert.equal(restored.recoveryCount, 1, 'the spent credit is preserved, not reset')
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
  await eventually(() => f.rt.task(f.mission.id, old.id).resumeAfterStop === undefined, 'expected deferred stop/checkpoint to settle')
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
  await eventually(() => f.workers.stops.length === 2, 'expected deferred stop/checkpoint to settle')
  assert.deepEqual(new Set(f.workers.stops), new Set([f.member.id, f.other.id]))
  assert.equal(f.rt.task(f.mission.id, peer.id).status, 'blocked', 'the scan fences other running work before stopping its handle')
  const next = f.nextTask(f.other.id)
  await assert.rejects(f.rt.claim({ sessionId: f.other.sessionId }, f.mission.id, next.id), /stop|quiescen/i)
  releaseStop()
  await eventually(() => f.workers.checkpoints.length > 0, 'expected deferred stop/checkpoint to settle')
  assert.ok(f.rt.task(f.mission.id, legacy.id).resumeAfterStop, 'stop acknowledgements alone do not clear the legacy obligation')
  releaseCheckpoint()
  await eventually(() => [legacy, peer].every(task => f.rt.task(f.mission.id, task.id).resumeAfterStop === undefined), 'expected deferred stop/checkpoint to settle')
  for (const task of [legacy, peer]) assert.equal(f.rt.task(f.mission.id, task.id).status, 'pending')
  assert.equal(f.rt.mission(f.mission.id).status, 'active')
  await f.rt.claim({ sessionId: f.other.sessionId }, f.mission.id, next.id)
})

test('task headroom warns before the final independent review admission and leaves the same work runnable', async t => {
  const f = await fixture(t)
  f.rt.updateBudget(f.owner, f.mission.id, { ...budget, maxTasks: 4 }, 'Plan for initial work')
  const extra = f.nextTask()
  f.rt.gates.warnBudget(f.rt.mission(f.mission.id))
  const warnings = () => f.rt.store.events(f.mission.id, 100).filter(row => row.type === 'mission/budget-warning' && row.data.dimension === 'maxTasks')
  assert.equal(warnings().length, 1)
  assert.equal(warnings()[0].data.used, 2)
  assert.equal(warnings()[0].data.pendingReviewSlots, 2)
  assert.equal(warnings()[0].data.projected, 4)
  assert.equal(warnings()[0].data.remaining, 2)
  assert.equal(warnings()[0].data.remainingAfterReviews, 0)
  assert.equal(warnings()[0].data.projectionBasis, 'admitted-plus-unpaired-reviews')
  assert.equal(f.rt.mission(f.mission.id).status, 'active')
  assert.equal(f.rt.task(f.mission.id, extra.id).status, 'pending')
  const review = f.rt.propose(f.owner, f.mission.id, { outputs: [], workstreamId: extra.workstreamId, title: 'Review work', objective: 'Review the source',
    kind: 'verification', reviewOf: extra.id, scope: ['src/'], acceptance: ['works'], assigneeId: f.other.id })
  f.rt.gates.warnBudget(f.rt.mission(f.mission.id))
  assert.equal(warnings().length, 1, 'review admission consumes its already projected slot, without a duplicate wake')
  f.rt.updateBudget(f.owner, f.mission.id, { ...budget, maxTasks: 20 }, 'More work remains after these reviews')
  f.rt.gates.warnBudget(f.rt.mission(f.mission.id))
  assert.equal(warnings().length, 1, 'an increased ceiling invalidates the old threshold')
  assert.equal(f.rt.task(f.mission.id, review.id).reviewOf, extra.id)
})

test('token recommendation states its narrow basis instead of claiming completion cost', async t => {
  const f = await fixture(t)
  const mission = f.rt.mission(f.mission.id)
  mission.usedTokens = 70000
  f.rt.commit(mission.id, () => f.rt.store.put('missions', mission))
  f.rt.gates.warnBudget(f.rt.mission(mission.id))
  const warning = f.rt.store.events(mission.id, 100).find(row => row.type === 'mission/budget-warning' && row.data.dimension === 'maxTokens')
  assert.equal(warning.data.projected, 70000)
  assert.equal(warning.data.suggestedLimit, 100001, 'numeric threshold-floor compatibility is preserved')
  assert.equal(warning.data.suggestedLimitBasis, 'threshold-headroom-only')
  assert.equal(warning.data.projectionBasis, 'settled-plus-current-model-requests')
  const notice = f.rt.store.list('deliveries', mission.id).find(row => row.content.includes('Threshold-headroom floor for maxTokens'))
  assert.match(notice.content, /not the cost of completing remaining tasks/)
  assert.match(notice.content, /decide the actual allowance from remaining work/)
})
