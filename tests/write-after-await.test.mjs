/**
 * CORE-06: a transition that awaited I/O after it read a row writes the row
 * its commit reads (`SwarmRuntime.revise`), never the copy it read.
 *
 * The live command smoke on 268a2c5 (2026-10-24) planned tight task step
 * limits; each resource review made the owner raise the task's allocation with
 * `swarm_budget`, which bumped the task row's revision while the implementer's
 * `swarm_submit` was capturing its artifact. The submission then wrote the row
 * it had read before the capture and was refused with `StaleTaskRevisionError`,
 * twice; every refusal cost the worker steps, which raised more resource
 * reviews and more raises, until the smoke's step limit stopped the run. The
 * same refusal is reproduced on main (dac6704): it dates from the per-task
 * revision guard (S5r, 0eb26c6), not from batch A.
 *
 * Each transition that awaits between reading and writing a row now re-reads
 * that row inside its final commit, re-validates the facts it rests on (its
 * fence) and writes only the fields it owns, so:
 *  - a write it does not conflict with (an owner's allocation raise, a claim
 *    the worker published, a usage charge) survives it and never refuses it;
 *  - a write it conflicts with refuses it with that conflict's own typed reason
 *    (a cancel: `task_cancelled`; a fence that owes a stop:
 *    `task_attempt_fenced`; a lapsed or moved attempt: `task_attempt_stale`; a
 *    moved choice: `task_changed_during_preparation`), never the generic
 *    revision error, or, for a background transition, leaves the row as it
 *    stands.
 *
 * The regressions (submit, the review's lease fence, the delivery apply and
 * the staged-plan member repair) fail on 268a2c5; the pins (claim, idle
 * close-out, lease-expiry checkpoint, stop barrier, preparation failure) hold
 * the sites that already re-read by hand and now take their row through the
 * same shape.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { STALE_TASK_REFUSAL_EVENT } from '../lib/store.js'
import { FakeClock, FakeWorkers, MISSION_ACCEPTANCE, eventually, events, makeRuntime, setup, taskOf } from './faults/harness.mjs'

/** An adapter call that holds until `open()`: `entered` settles once the call is inside it. */
function gate() {
  let reached, open
  const entered = new Promise(resolve => { reached = resolve })
  const released = new Promise(resolve => { open = resolve })
  return { entered, open, wait: () => { reached(); return released } }
}
/** The owner's `swarm_budget(taskId, taskBudget)`: an allocation-only amendment. */
const raise = (f, taskId, maxSteps) => f.runtime.controlTask(f.owner, f.mission.id, taskId, 'amend', { maxSteps }, 'Resource review: raise the allocation')
const staleRefusals = f => events(f.runtime, f.mission.id, STALE_TASK_REFUSAL_EVENT).length

async function fixture(t) {
  const f = await setup({ clock: new FakeClock() })
  t.after(() => f.cleanup())
  const claim = async (member, extra = {}) => {
    const task = f.propose({ maxSteps: 8, ...extra })
    const claimed = await f.runtime.claim(f.actor(member), f.mission.id, task.id)
    return { task, attemptId: claimed.attempt.id }
  }
  /** A submission whose artifact capture holds until the returned gate opens. */
  const submitting = async () => {
    const { task, attemptId } = await claim(f.author)
    const capture = gate()
    f.workers.captureGate = capture.wait
    const submitted = f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId, output: 'done' })
    await capture.entered
    return { task, attemptId, capture, submitted }
  }
  /** A review of a submitted source whose artifact inspection holds until the returned gate opens. */
  const verifying = async () => {
    const { task: source, attemptId } = await claim(f.author)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId, output: 'done' })
    const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Review', objective: 'Independent review', kind: 'verification',
      reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id, maxSteps: 8 })
    const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    const inspection = gate()
    f.workers.inspectArtifact = async (_member, artifact) => { await inspection.wait(); return artifact }
    const verified = f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'Independent host checks validate the submitted artifact' })
    await inspection.entered
    return { source, review, inspection, verified }
  }
  return { ...f, claim, submitting, verifying }
}

test('CORE-06: a submission racing the owner\'s allocation raise is accepted and keeps the raised allocation', async t => {
  const f = await fixture(t)
  const { task, capture, submitted } = await f.submitting()
  raise(f, task.id, 20)
  capture.open()
  const result = await submitted
  const row = taskOf(f.runtime, task.id)
  assert.equal(result.status, 'submitted', 'the submission is accepted, not refused as stale')
  assert.deepEqual([row.status, row.maxSteps, row.artifact?.commit], ['submitted', 20, f.workers.artifact.commit], 'the row carries both the submission and the raised allocation')
  assert.equal(staleRefusals(f), 0, 'no write was refused as stale')
})

test('CORE-06: the owner\'s allocation raises racing a submission are accepted and survive it', async t => {
  const f = await fixture(t)
  const { task, capture, submitted } = await f.submitting()
  // A task allocation and the mission budget, both while the capture runs.
  assert.equal(raise(f, task.id, 20).maxSteps, 20, 'the task allocation raise is accepted')
  const budget = { ...f.runtime.mission(f.mission.id).budget, maxSteps: 900 }
  assert.equal(f.runtime.updateBudget(f.owner, f.mission.id, budget, 'Resource review: raise the mission budget').maxSteps, 900, 'the mission budget raise is accepted')
  capture.open()
  await submitted
  assert.equal(taskOf(f.runtime, task.id).maxSteps, 20, 'the submission keeps the task allocation the owner raised')
  assert.equal(f.runtime.mission(f.mission.id).budget.maxSteps, 900, 'and the mission budget')
  assert.equal(taskOf(f.runtime, task.id).status, 'submitted')
})

test('CORE-06: a claim the worker publishes while its submission captures is kept and pinned to the artifact', async t => {
  const f = await fixture(t)
  const { task, attemptId, capture, submitted } = await f.submitting()
  const runId = await f.runtime.recordToolRun(f.author.id, { tool: 'bash', arguments: { command: 'npm test' }, isError: false, result: { output: 'ok' } })
  const claim = f.runtime.publish(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId, claim: 'The change passes its tests', outcome: 'supported', toolRunIds: [runId] })
  capture.open()
  await submitted
  const row = taskOf(f.runtime, task.id)
  assert.equal(row.status, 'submitted')
  assert.ok(row.evidenceIds.includes(claim.id), 'the claim published during the capture stays on the row')
  assert.equal(f.runtime.store.get('evidence', claim.id).artifact?.commit, f.workers.artifact.commit, 'and is pinned to the submitted artifact')
  assert.equal(staleRefusals(f), 0)
})

test('CORE-06: a submission racing an owner cancel is refused with the cancel\'s own typed reason', async t => {
  const f = await fixture(t)
  const { task, capture, submitted } = await f.submitting()
  f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'withdrawn while the artifact was captured' })
  capture.open()
  await assert.rejects(submitted, error => error.code === 'task_cancelled'
    && /cancelled this task while the artifact was captured\. It is terminal: stop working on it and do not resubmit/.test(error.message))
  const row = taskOf(f.runtime, task.id)
  assert.deepEqual([row.status, row.artifact], ['cancelled', undefined], 'the cancel stands and nothing was submitted')
  assert.equal(staleRefusals(f), 0, 'the conflict is the cancel, not a stale revision')
})

test('CORE-06: a submission racing a fence that owes a stop is refused with the fence\'s own typed reason', async t => {
  const f = await fixture(t)
  const { task, capture, submitted } = await f.submitting()
  // A structural amendment of running work fences its attempt.
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { scope: ['src/'] }, 'narrow the scope while the artifact is captured')
  capture.open()
  await assert.rejects(submitted, error => error.code === 'task_attempt_fenced' && /being reassigned after a stop/.test(error.message))
  const row = taskOf(f.runtime, task.id)
  assert.deepEqual([row.status, row.artifact, row.scope], ['blocked', undefined, ['src/']], 'the amendment stands and nothing was submitted')
  assert.equal(staleRefusals(f), 0)
})

test('CORE-06: a submission whose lease lapsed during the capture is refused as a stale attempt that names the captured artifact', async t => {
  const f = await fixture(t)
  const { task, capture, submitted } = await f.submitting()
  f.clock.advance(f.runtime.config.leaseMs + 1)
  capture.open()
  await assert.rejects(submitted, error => error.code === 'task_attempt_stale' && error.category === 'authorization_error'
    && new RegExp(`Artifact ${f.workers.artifact.commit} was captured but the attempt is no longer current`).test(error.message))
  assert.deepEqual([taskOf(f.runtime, task.id).status, taskOf(f.runtime, task.id).artifact], ['running', undefined], 'nothing was submitted')
})

test('CORE-06: a review racing the owner\'s allocation raise extends its lease, reaches its verdict and keeps the raise', async t => {
  const f = await fixture(t)
  const { source, review, inspection, verified } = await f.verifying()
  raise(f, review.id, 20)
  inspection.open()
  await verified
  const row = taskOf(f.runtime, review.id)
  assert.deepEqual([row.status, row.maxSteps], ['accepted', 20], 'the verdict is recorded on the row that kept the raise')
  assert.equal(taskOf(f.runtime, source.id).status, 'accepted')
  assert.equal(staleRefusals(f), 0)
})

test('CORE-06: a review whose attempt is withdrawn during its inspection is refused as a stale attempt', async t => {
  const f = await fixture(t)
  const { review, inspection, verified } = await f.verifying()
  f.runtime.cancel(f.owner, f.mission.id, { taskId: review.id, reason: 'withdraw the review while it inspects' })
  inspection.open()
  await assert.rejects(verified, error => error.code === 'task_attempt_stale')
  assert.equal(taskOf(f.runtime, review.id).status, 'cancelled')
  assert.equal(staleRefusals(f), 0, 'the conflict is the withdrawn attempt, not a stale revision')
})

/** A claim whose workspace preparation holds until the returned gate opens. */
async function claiming(f) {
  const preparation = gate()
  f.workers.prepareTask = async () => { await preparation.wait() }
  const task = f.propose({ maxSteps: 8 })
  const claimed = f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await preparation.entered
  return { task, preparation, claimed }
}

test('CORE-06: a claim racing the owner\'s allocation raise opens its attempt on the raised row', async t => {
  const f = await fixture(t)
  const { task, preparation, claimed } = await claiming(f)
  raise(f, task.id, 20)
  preparation.open()
  const running = await claimed
  const row = taskOf(f.runtime, task.id)
  assert.deepEqual([row.status, row.maxSteps, row.attempt?.id, running.attempt.ownerId], ['running', 20, running.attempt.id, f.author.id])
  assert.equal(staleRefusals(f), 0)
})

test('CORE-06: a claim racing a reassignment of its task is refused as changed during preparation', async t => {
  const f = await fixture(t)
  const { task, preparation, claimed } = await claiming(f)
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { assigneeId: f.reviewer.id }, 'reassign while the workspace is prepared')
  preparation.open()
  await assert.rejects(claimed, error => error.code === 'task_changed_during_preparation')
  const row = taskOf(f.runtime, task.id)
  assert.deepEqual([row.status, row.assigneeId, row.attempt], ['pending', f.reviewer.id, undefined], 'the reassignment stands')
  assert.equal(staleRefusals(f), 0)
})

test('CORE-06: a preparation failure racing the owner\'s allocation raise is recorded on the raised row', async t => {
  const f = await fixture(t)
  const task = f.propose({ maxSteps: 8 })
  const held = gate()
  f.workers.prepareTask = async () => { await held.wait(); throw Object.assign(new Error('worktree busy'), { code: 'EBUSY' }) }
  f.workers.idle.add(f.author.id)
  f.runtime.kick(f.mission.id)
  await held.entered
  raise(f, task.id, 20)
  held.open()
  await f.runtime.settle(f.mission.id)
  const row = taskOf(f.runtime, task.id)
  assert.equal(row.preparationFailure?.attempts, 1, 'the failure is recorded')
  assert.equal(row.maxSteps, 20, 'on the row that kept the raise')
  assert.equal(staleRefusals(f), 0)
})

/** The close-out and lease paths, on the real clock: their awaits run inside the scheduling body. */
class CloseoutWorkers extends FakeWorkers {
  checks = []
  artifact = { commit: 'd'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
}
async function closeout(t, config = {}) {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, { workers: new CloseoutWorkers(),
    config: { tickMs: 60_000, maxMessageChars: 10_000, maxEvents: 300, maxTasksPerMember: 100, checkTimeoutMs: undefined, ...config },
    budget: { maxTokens: 100_000, maxSteps: 1_000, maxDurationMs: 3_600_000, maxTasks: 100 } })
  const owner = { sessionId: 'core-06-owner' }
  const mission = runtime.create(owner, { title: 'Write after await', objective: 'Keep every write a transition does not own', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget }, { grantRoot: directory, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  await runtime.settle(mission.id)
  const task = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], maxSteps: 8 })
  const claimed = await runtime.claim({ sessionId: author.sessionId }, mission.id, task.id)
  const f = { runtime, workers, owner, mission, author, task, attemptId: claimed.attempt.id }
  return { ...f, event: type => events(runtime, mission.id, type), current: () => taskOf(runtime, task.id) }
}

test('CORE-06: an idle close-out racing the owner\'s allocation raise checkpoints the attempt on the raised row', async t => {
  const f = await closeout(t, { maxIdleCloseouts: 1 })
  f.workers.idle.add(f.author.id)
  f.workers.callbacks.idle(f.author.id)
  await eventually(() => f.event('task/closeout-nudged').length === 1, 'the first idle close-out nudges', 2500)
  const capture = gate()
  f.workers.captureGate = capture.wait
  f.workers.callbacks.idle(f.author.id)
  await capture.entered
  f.runtime.controlTask(f.owner, f.mission.id, f.task.id, 'amend', { maxSteps: 20 }, 'raise while the close-out captures')
  capture.open()
  const abandoned = await eventually(() => f.event('task/closeout-abandoned')[0], 'the exhausted close-out checkpoints the attempt', 2500)
  assert.equal(abandoned.data.commit, f.workers.artifact.commit)
  assert.equal(f.current().maxSteps, 20, 'the close-out keeps the raised allocation')
  assert.equal(f.event(STALE_TASK_REFUSAL_EVENT).length, 0)
})

test('CORE-06: a lease-expiry checkpoint racing the owner\'s allocation raise expires the attempt on the raised row', async t => {
  const clock = new FakeClock()
  const leaseMs = 60
  const f = await closeout(t, { leaseMs, now: clock.now })
  f.workers.idle.add(f.author.id)
  const capture = gate()
  f.workers.captureGate = capture.wait
  clock.advance(leaseMs + 1)
  f.workers.callbacks.idle(f.author.id)
  await capture.entered
  f.runtime.controlTask(f.owner, f.mission.id, f.task.id, 'amend', { maxSteps: 20 }, 'raise while the lease-expiry checkpoint runs')
  capture.open()
  await eventually(() => f.event('task/lease-expired').length === 1, 'the expired lease is recovered', 2500)
  const row = f.current()
  assert.equal(row.checkpoint?.commit, f.workers.artifact.commit, 'the checkpoint is recorded')
  assert.equal(row.maxSteps, 20, 'on the row that kept the raise')
  assert.equal(f.event(STALE_TASK_REFUSAL_EVENT).length, 0)
})

test('CORE-06: a stop barrier racing the owner\'s allocation raise releases the task on the raised row', async t => {
  const f = await closeout(t)
  const checkpoint = gate()
  f.workers.checkpointTask = () => checkpoint.wait()
  f.runtime.handoff({ sessionId: f.author.sessionId }, f.mission.id, { taskId: f.task.id, attemptId: f.attemptId, summary: 'Release the task' })
  await checkpoint.entered
  f.runtime.controlTask(f.owner, f.mission.id, f.task.id, 'amend', { maxSteps: 20 }, 'raise while the barrier checkpoints')
  checkpoint.open()
  await eventually(() => f.event('task/handoff-ready').length === 1, 'the barrier releases the task', 2500)
  const row = f.current()
  assert.deepEqual([row.resumeAfterStop, row.maxSteps], [undefined, 20], 'the barrier released the row that kept the raise')
  assert.equal(f.event(STALE_TASK_REFUSAL_EVENT).length, 0)
})

test('CORE-06: a delivery apply racing a usage charge on the completed mission keeps the charge', async t => {
  class DeliveryWorkers extends FakeWorkers {
    applyGate
    async applyDelivery() { await this.applyGate?.(); return { status: 'applied', changedPaths: [], conflicts: [] } }
  }
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, { workers: new DeliveryWorkers(), config: { checkTimeoutMs: undefined },
    budget: { maxTokens: 100_000, maxSteps: 100, maxTasks: 20 } })
  const owner = { sessionId: 'core-06-delivery-owner' }
  const mission = runtime.create(owner, { title: 'Deliver', objective: 'Apply the accepted result', workspace: directory, scope: ['src/'], acceptance: ['works'], budget }, { grantRoot: directory, source: 'session' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  await runtime.settle(mission.id)
  runtime.store.transaction(() => {
    runtime.store.put('tasks', { id: 'integration', missionId: mission.id, workstreamId: 'stream', title: 'Integrate', objective: 'Integrate', kind: 'integration', dependencies: [],
      scope: ['src/'], acceptance: ['works'], covers: ['c1'], checks: [], status: 'accepted', priority: 50, experiment: false, epoch: 0, evidenceIds: [],
      artifact: { commit: '2'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: [] } })
    const completed = runtime.store.get('missions', mission.id)
    completed.status = 'completed'
    completed.baseline = { sourceHead: 'a'.repeat(40), snapshotCommit: 'b'.repeat(40), planningWorkspace: '/planning', changedPaths: [], createdAt: 1 }
    runtime.store.put('missions', completed)
  })
  const apply = gate()
  workers.applyGate = apply.wait
  const applied = runtime.applyDelivery(owner, mission.id)
  await apply.entered
  // A late usage report of the member reaches the mission while the apply runs.
  await workers.callbacks.usage(member.id, 500)
  assert.equal(runtime.store.get('missions', mission.id).usedTokens, 500)
  apply.open()
  assert.equal((await applied).status, 'applied')
  const row = runtime.store.get('missions', mission.id)
  assert.equal(row.appliedDelivery?.resultCommit, '2'.repeat(40), 'the apply is recorded')
  assert.equal(row.usedTokens, 500, 'on the mission row that kept the usage charge')
})

test('CORE-06: a staged-plan member repair racing a usage report on that member keeps the report', async t => {
  class PlanWorkers extends FakeWorkers {
    live = 1
    invalidateGate
    async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
    async start(spec) {
      if (this.started.length >= this.live) throw new Error('Simulated provider outage while starting the second member')
      this.started.push(spec.member.id)
    }
    async invalidateComposition() { await this.invalidateGate?.() }
  }
  const { dir: directory, runtime, workers } = await makeRuntime(t, { workers: new PlanWorkers(), config: { tickMs: 60_000, maxEvents: 1_000, checkTimeoutMs: undefined, workerStartTimeoutMs: 5_000 },
    budget: { maxTokens: 1_000_000, maxSteps: 5_000, maxWorkers: 6, maxDurationMs: 3_600_000, maxTasks: 60 } })
  runtime.kick = () => {}
  const owner = { sessionId: 'core-06-plan-owner' }
  const plan = {
    title: 'Staged plan', objective: 'Deliver', workspace: directory, scope: ['src/'], acceptance: ['done'],
    budget: { maxTokens: 1_000_000, maxSteps: 5_000, maxWorkers: 6, maxDurationMs: 3_600_000, maxTasks: 60, maxExperiments: 0 },
    members: [{ key: 'a', role: 'implementation', maxOutputTokens: 1000 }, { key: 'b', role: 'verification', maxOutputTokens: 1000 }],
    workstreams: [{ key: 'w', title: 'Main', objective: 'Deliver' }],
    tasks: [{ key: 't1', workstreamKey: 'w', title: 'Feature', objective: 'Write the feature', kind: 'implementation', outputs: [], scope: ['src/'], acceptance: ['done'], checks: ['npm test'], assigneeKey: 'a' }],
  }
  const draft = runtime.createDraft(owner, plan, { grantRoot: plan.workspace, source: 'session' })
  // The second member cannot start, so assembly fails after the first one was admitted.
  await assert.rejects(async () => { await runtime.launchDraft(owner, draft.id, draft.revision) })
  const staged = runtime.store.get('drafts', draft.id)
  const missionId = `mission_${draft.id}`
  const first = runtime.store.list('members', missionId)[0]
  workers.live = 10
  const repaired = structuredClone(plan)
  repaired.members[0].model = 'other-model'
  const edited = runtime.updateDraft(owner, draft.id, staged.revision, repaired, { grantRoot: repaired.workspace, source: 'session' })
  const invalidation = gate()
  workers.invalidateGate = invalidation.wait
  const relaunched = runtime.launchDraft(owner, draft.id, edited.revision)
  await invalidation.entered
  // The member's last usage report lands while its stale composition is dropped.
  await workers.callbacks.usageSnapshot(first.id, 777)
  assert.equal(runtime.store.get('members', first.id).accountedTokens, 777)
  invalidation.open()
  assert.equal((await relaunched).mission.status, 'active')
  const row = runtime.store.get('members', first.id)
  assert.equal(row.model, 'other-model', 'the repair is recorded')
  assert.notEqual(row.sessionId, first.sessionId, 'with the rotated identity')
  assert.equal(row.accountedTokens, 777, 'on the member row that kept the usage report')
  assert.equal(runtime.store.get('missions', missionId).usedTokens, 777)
})

test('CORE-06: a moot transition writes nothing, publishes nothing and leaves the revision; a refused one leaves nothing of its effects', async t => {
  const f = await fixture(t)
  const { task } = await f.claim(f.author)
  const notified = []
  f.runtime.subscribe(missionId => notified.push(missionId))
  const revision = f.runtime.store.revision(), row = taskOf(f.runtime, task.id)
  assert.equal(f.runtime.revise(f.mission.id, 'tasks', task.id, current => { current.output = 'moot'; return false }), undefined)
  assert.equal(f.runtime.revise(f.mission.id, 'tasks', 'task_absent', () => { assert.fail('a missing row is never handed over') }), undefined)
  assert.throws(() => f.runtime.revise(f.mission.id, 'tasks', task.id, current => { current.output = 'refused'; throw new Error('refused by the fence') }), /refused by the fence/)
  assert.throws(() => f.runtime.revise(f.mission.id, 'tasks', task.id, current => { current.output = 'refused' }, () => {
    f.runtime.store.event(f.mission.id, 'task/amended', 'owner', { taskId: task.id }); throw new Error('refused after its effects')
  }), /refused after its effects/)
  assert.deepEqual([f.runtime.store.revision(), notified], [revision, []], 'nothing was committed or published')
  assert.deepEqual(taskOf(f.runtime, task.id), row, 'and the row is as it was')
  // A write takes the row as it stands: a field another writer set survives.
  f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { maxSteps: 30 }, 'raise')
  const written = f.runtime.revise(f.mission.id, 'tasks', task.id, current => { current.output = 'written' })
  assert.deepEqual([written.output, written.maxSteps, taskOf(f.runtime, task.id).output, taskOf(f.runtime, task.id).maxSteps], ['written', 30, 'written', 30])
  // Inside an open commit it is a write of that transaction: a moot one leaves the rest of it to its caller.
  f.runtime.commit(f.mission.id, () => {
    assert.equal(f.runtime.revise(f.mission.id, 'tasks', task.id, () => false), undefined)
    f.runtime.revise(f.mission.id, 'members', f.author.id, member => { member.subscriptions = ['joined'] })
  })
  assert.deepEqual([taskOf(f.runtime, task.id).output, f.runtime.store.get('members', f.author.id).subscriptions], ['written', ['joined']])
})
