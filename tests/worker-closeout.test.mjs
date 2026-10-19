/** W6 regressions: a worker that stops with an open attempt never strands its workspace. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { FakeClock, FakeWorkers, eventually, events, makeRuntime, setup, taskOf } from './faults/harness.mjs'
import { WriterBusyError } from '../lib/store.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

class CloseoutWorkers extends FakeWorkers {
  stopEntered = new Set(); captureError; stopGate
  checks = []
  artifact = { commit: 'd'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, delivery }) }
  async stop(memberId) {
    this.stopEntered.add(memberId)
    if (this.stopGate !== undefined) await this.stopGate(memberId)
    this.stopped.push(memberId)
  }
  async prepareTask(member, task) { this.prepared.push(structuredClone({ member: member.id, task })) }
  async captureArtifact(member, task) {
    if (this.captureError !== undefined) throw this.captureError
    this.captured.push(structuredClone({ member: member.id, task }))
    if (this.captureGate !== undefined) await this.captureGate()
    return this.artifact
  }
}

async function fixture(t, config = {}) {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, { workers: new CloseoutWorkers(),
    config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 300, maxTasksPerMember: 100, checkTimeoutMs: undefined, ...config },
    budget: { maxTokens: 100000, maxSteps: 1000, maxDurationMs: 3600000, maxTasks: 100 } })
  const owner = { sessionId: 'closeout-owner' }
  const mission = runtime.create(owner, { title: 'Close-out', objective: 'Never strand uncommitted work', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget }, { grantRoot: directory, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  // The members' starts re-validate the workspace on disk; their passes settle before a test claims by hand.
  await runtime.settle(mission.id)
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  return { runtime, workers, owner, mission, stream, author, reviewer, actor, propose, current, events }
}

test('an idle worker with an open attempt is nudged, then checkpointed and resumed on the same member', async t => {
  const f = await fixture(t, { maxIdleCloseouts: 1 })
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.workers.idle.add(f.author.id); f.workers.idle.add(f.reviewer.id)
  f.workers.callbacks.idle(f.author.id)
  const nudge = await eventually(() => f.workers.deliveries.find(item => item.memberId === f.author.id
    && /still open but your turn ended/.test(item.delivery.content)), 'the bounded close-out nudge', 2500)
  assert.match(nudge.delivery.content, /swarm_submit/)
  assert.match(nudge.delivery.content, new RegExp(claimed.attempt.id))
  assert.equal(f.current(task.id).status, 'running', 'the first idle close-out nudges instead of abandoning')
  assert.equal(f.current(task.id).attempt.id, claimed.attempt.id, 'the nudge does not fence the attempt')
  assert.equal(f.events('task/closeout-nudged').length, 1)
  assert.equal(f.events('task/closeout-abandoned').length, 0)

  // Hold the abandoned handle's stop open so the ordering guarantee is observed
  // deterministically instead of racing the deferred close-out block.
  const releaseStop = deferred()
  f.workers.stopGate = async memberId => { if (memberId === f.author.id) await releaseStop.promise }
  f.workers.callbacks.idle(f.author.id)
  const abandoned = await eventually(() => f.events('task/closeout-abandoned')[0], 'the exhausted close-out abandons the attempt', 2500)
  assert.equal(abandoned.data.commit, f.workers.artifact.commit)
  assert.equal(f.workers.captured.length, 1, 'the workspace is checkpointed exactly once')
  assert.equal(f.workers.captured[0].task.id, task.id)
  assert.equal(f.workers.captured[0].task.epoch, claimed.attempt.epoch, 'the checkpoint matches the open attempt baseline')
  assert.equal(f.workers.captured[0].task.attempt.id, claimed.attempt.id)
  // Either the deferred stop reaches the adapter, or a re-pend is observed
  // first - the latter proves the ordering guarantee is broken.
  await eventually(() => f.workers.stopEntered.has(f.author.id) || f.events('task/closeout-ready').length > 0,
    'the close-out stop or an early re-pend', 2500)
  assert.equal(f.events('task/closeout-ready').length, 0, 'the task is not re-pended before the abandoned handle is stopped')
  assert.equal(f.workers.stopped.includes(f.author.id), false, 'the gated handle is not yet reported stopped')
  assert.equal(f.current(task.id).status, 'blocked', 'the abandoned task stays undispatchable while the handle stops')
  assert.equal(f.current(task.id).attempt, undefined)
  assert.equal(f.current(task.id).resumeAfterStop?.reason, 'worker-closeout')
  assert.equal(f.events('task/claimed').filter(event => event.data.taskId === task.id).length, 1,
    'no reassignment can be observed before the abandoned handle is stopped')
  releaseStop.resolve()
  await eventually(() => f.workers.stopped.includes(f.author.id), 'the abandoned handle is stopped', 2500)
  await eventually(() => f.events('task/closeout-ready')[0], 'the task re-pends only after the stop', 2500)
  assert(f.workers.stopped.includes(f.author.id), 'the handle is stopped when the task becomes dispatchable')

  const resumed = await eventually(() => {
    const current = f.current(task.id)
    return current.status === 'running' && current.attempt?.id !== claimed.attempt.id ? current : undefined
  }, 'the checkpointed task resumes on the preferred member', 2500)
  assert.equal(resumed.attempt.ownerId, f.author.id, 'the same member is preferred over another idle member')
  assert.equal(resumed.assigneeId, f.author.id)
  assert.equal(resumed.plannedAssigneeId, f.author.id)
  assert.equal(resumed.recoveryCount, 1, 'one abandoned attempt spends exactly one recovery credit')
  assert.equal(resumed.checkpoint.commit, f.workers.artifact.commit, 'the durable checkpoint survives the reassignment')
  assert.ok(resumed.attempt.epoch > claimed.attempt.epoch)
  assert.equal(f.workers.prepared.at(-1).task.id, task.id)
  assert.equal(f.workers.prepared.at(-1).task.epoch, resumed.attempt.epoch, 'preparation targets the resumed epoch')
  assert.equal(f.events('task/closeout-ready').length, 1)
})

test('a failed checkpoint blocks the task and wakes the owner instead of reassigning dirty work', async t => {
  const f = await fixture(t, { maxIdleCloseouts: 0 })
  const task = f.propose()
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.workers.captureError = new Error('Artifact changes path outside task scope: secret.txt')
  f.workers.idle.add(f.author.id)
  f.workers.callbacks.idle(f.author.id)
  const blocked = await eventually(() => {
    const current = f.current(task.id)
    return current.status === 'blocked' ? current : undefined
  }, 'the uncheckpointable attempt is blocked', 2500)
  assert.match(blocked.output, /could not be checkpointed.*outside task scope/)
  assert.equal(blocked.attempt, undefined, 'the abandoned attempt is fenced')
  assert.equal(f.workers.captured.length, 0)
  // The abandoned handle is still stopped (the fence's quiescence), but the
  // task never re-pends for another attempt.
  assert.deepEqual(f.events('task/closeout-ready'), [], 'no reassignment is attempted without a checkpoint')
  assert.equal(f.workers.prepared.length, 1, 'only the claimed attempt was ever prepared')
  assert.equal(f.events('task/closeout-failed').length, 1)
  const notice = await eventually(() => f.workers.deliveries.find(item => item.memberId === 'owner'
    && /could not be checkpointed/.test(item.delivery.content)), 'the owner is woken for the uncheckpointable workspace', 2500)
  assert.match(notice.delivery.content, new RegExp(task.id))
})

/** An idle close-out whose checkpoint capture is held open until the owner has cancelled the task, then succeeds or fails. */
async function cancelDuringCloseoutCapture(t, captureFails) {
  const f = await fixture(t, { maxIdleCloseouts: 0, now: new FakeClock().now })
  const task = f.propose()
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.workers.idle.add(f.author.id)
  const entered = deferred(), release = deferred()
  f.workers.captureGate = async () => {
    entered.resolve(); await release.promise
    if (captureFails) throw new Error('git commit failed: index.lock EPERM')
  }
  f.workers.callbacks.idle(f.author.id)
  await entered.promise
  const cancelled = f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'Owner withdraws while the close-out checkpoint is in flight' })
  assert.equal(cancelled.status, 'cancelled')
  release.resolve()
  await f.runtime.settle(f.mission.id)
  await f.runtime.tick()
  const final = f.current(task.id)
  assert.equal(final.status, 'cancelled', 'the close-out must not overwrite the owner cancel')
  assert.equal(final.epoch, cancelled.epoch, 'the cancelled epoch is preserved')
  assert.equal(f.events('task/claimed').filter(event => event.data.taskId === task.id).length, 1, 'the cancelled task is never re-claimed')
  return { f, final }
}

test('an owner cancel during the idle close-out checkpoint is never overwritten by the close-out', async t => {
  const { f, final } = await cancelDuringCloseoutCapture(t, false)
  assert.equal(final.checkpoint, undefined, 'a checkpoint captured after the cancel is discarded')
  assert.equal(f.events('task/closeout-abandoned').length, 0, 'the close-out abandons nothing the cancel already fenced')
  assert.equal(f.events('mission/stalled').filter(event => event.data.cause === 'guard-terminal' && /idle close-out abandoned/.test(event.data.detail ?? '')).length, 0,
    'no attempt/lease guard terminal names the cancelled attempt')
})

test('an idle close-out checkpoint that fails after an owner cancel reports nothing for the cancelled attempt', async t => {
  const { f, final } = await cancelDuringCloseoutCapture(t, true)
  assert.equal(final.resumeAfterStop, undefined, 'no invalidation barrier is laid over the cancel')
  assert.equal(f.events('task/closeout-failed').length, 0, 'a capture failure after the cancel is not recorded as the attempt\'s close-out failure')
  assert.equal(f.events('mission/stalled').filter(event => event.data.cause === 'guard-terminal' && /could not be checkpointed/.test(event.data.detail ?? '')).length, 0,
    'no attempt/lease guard terminal names the cancelled attempt')
  assert.equal(f.runtime.store.list('deliveries', f.mission.id).filter(row => /could not be checkpointed/.test(row.content ?? '')).length, 0, 'the owner is not told about the cancelled attempt')
})

test('an idle member without an open attempt is never treated as a close-out', async t => {
  const f = await fixture(t, { maxIdleCloseouts: 0 })
  f.workers.idle.add(f.author.id)
  f.workers.callbacks.idle(f.author.id)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.events('task/closeout-nudged').length, 0)
  assert.equal(f.events('task/closeout-abandoned').length, 0)
  assert.equal(f.events('task/closeout-failed').length, 0)
})

test('lease expiry checkpoints a quiescent workspace before the task is re-pended', async t => {
  const f = await fixture(t, { leaseMs: 60 })
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.workers.idle.add(f.author.id)
  const stored = f.current(task.id)
  stored.attempt.leaseUntil = Date.now() - 1
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', stored))
  f.workers.callbacks.idle(f.author.id)
  const checkpointed = await eventually(() => f.events('task/checkpointed')[0], 'the lease-expiry checkpoint', 2500)
  assert.equal(checkpointed.data.commit, f.workers.artifact.commit)
  assert.equal(checkpointed.data.reason, 'lease-expired')
  assert.equal(f.workers.captured.at(-1).task.epoch, claimed.attempt.epoch, 'the checkpoint matches the expired attempt baseline')
  const resumed = await eventually(() => {
    const current = f.current(task.id)
    return current.status === 'running' && current.attempt?.id !== claimed.attempt.id ? current : undefined
  }, 'the planned assignee resumes after the checkpoint', 2500)
  assert.equal(resumed.attempt.ownerId, f.author.id)
  assert.equal(resumed.checkpoint.commit, f.workers.artifact.commit)
})

test('an owner cancel during the lease-expiry checkpoint is never overwritten by recovery', async t => {
  const clock = new FakeClock()
  const leaseMs = 60
  const f = await fixture(t, { leaseMs, now: clock.now })
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.workers.idle.add(f.author.id)
  const entered = deferred(), release = deferred()
  f.workers.captureGate = async () => { entered.resolve(); await release.promise }
  clock.advance(leaseMs + 1)
  f.workers.callbacks.idle(f.author.id)
  await entered.promise
  // The owner withdraws while captureArtifact is in flight; the checkpoint's
  // post-await transition must not resurrect the task.
  const cancelled = f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'Owner withdraws while the checkpoint is in flight' })
  assert.equal(cancelled.status, 'cancelled')
  release.resolve()
  // The released checkpoint's transition and the cancel's stop barrier have
  // both run once the mission has settled, and the next tick has run the
  // cancel's kick the open recovery body coalesced, so the negative assertions
  // below mean something without a pause.
  await f.runtime.settle(f.mission.id)
  await f.runtime.tick()
  const final = f.current(task.id)
  assert.equal(final.status, 'cancelled', 'the in-flight checkpoint must not overwrite the owner cancel')
  assert.equal(final.epoch, cancelled.epoch, 'the cancelled epoch is preserved')
  assert.equal(final.attempt, undefined)
  assert.equal(f.events('task/lease-expired').length, 0, 'lease recovery abandons its transition after the cancel')
  assert.equal(f.events('task/checkpointed').length, 0, 'a checkpoint committed after the cancel is discarded')
  assert.equal(f.events('task/claimed').filter(event => event.data.taskId === task.id).length, 1, 'the cancelled task is never re-claimed')
  assert.equal(f.workers.stopped.filter(id => id === f.author.id).length, 1, 'the released worker is stopped exactly once')
})

test('a lease-expiry checkpoint that fails after an owner cancel reports nothing for the cancelled attempt', async t => {
  const clock = new FakeClock()
  const leaseMs = 60
  const f = await fixture(t, { leaseMs, now: clock.now })
  const task = f.propose()
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.workers.idle.add(f.author.id)
  const entered = deferred(), release = deferred()
  f.workers.captureGate = async () => { entered.resolve(); await release.promise; throw new Error('git commit failed: index.lock EPERM') }
  clock.advance(leaseMs + 1)
  f.workers.callbacks.idle(f.author.id)
  await entered.promise
  // The owner withdraws while captureArtifact is in flight, and the capture
  // then fails: its failure belongs to an attempt the cancel already fenced.
  const cancelled = f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'Owner withdraws while the checkpoint is in flight' })
  assert.equal(cancelled.status, 'cancelled')
  release.resolve()
  await f.runtime.settle(f.mission.id)
  await f.runtime.tick()
  const final = f.current(task.id)
  assert.equal(final.status, 'cancelled', 'the failed checkpoint must not overwrite the owner cancel')
  assert.equal(final.epoch, cancelled.epoch, 'the cancelled epoch is preserved')
  assert.equal(f.events('task/checkpoint-failed').length, 0, 'a capture failure after the cancel is not audited as the attempt\'s checkpoint failure')
  assert.equal(f.events('mission/stalled').filter(event => event.data.cause === 'guard-terminal' && /Lease-expiry checkpoint failed/.test(event.data.detail ?? '')).length, 0,
    'no attempt/lease guard terminal names the cancelled attempt')
  assert.equal(f.runtime.store.list('deliveries', f.mission.id).filter(row => /Lease-expiry checkpoint failed/.test(row.content ?? '')).length, 0, 'the owner is not told about the cancelled attempt')
  assert.equal(f.events('task/lease-expired').length, 0, 'lease recovery abandons its transition after the cancel')
})

test('a failed lease-expiry checkpoint is audited and wakes the owner', async t => {
  const f = await fixture(t, { leaseMs: 60 })
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.workers.idle.add(f.author.id)
  f.workers.captureError = new Error('git commit failed: index.lock EPERM')
  const stored = f.current(task.id)
  stored.attempt.leaseUntil = Date.now() - 1
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', stored))
  f.workers.callbacks.idle(f.author.id)
  const failed = await eventually(() => f.events('task/checkpoint-failed')[0], 'the failed lease-expiry checkpoint is audited', 2500)
  assert.equal(failed.data.taskId, task.id)
  assert.equal(failed.data.ownerId, f.author.id)
  assert.match(failed.data.reason, /index\.lock/)
  const notice = await eventually(() => f.workers.deliveries.find(item => item.memberId === 'owner'
    && /Lease-expiry checkpoint failed/.test(item.delivery.content)), 'the owner is woken for the failed checkpoint', 2500)
  assert.match(notice.delivery.content, new RegExp(task.id))
  // Recovery still proceeds; the preserved workspace is what prepareTask guards.
  const resumed = await eventually(() => {
    const current = f.current(task.id)
    return current.status === 'running' && current.attempt?.id !== claimed.attempt.id ? current : undefined
  }, 'lease recovery proceeds after the audited checkpoint failure', 2500)
  assert.equal(resumed.attempt.ownerId, f.author.id)
  assert.equal(f.workers.captured.length, 0)
})

/**
 * The author ended its turn on an open attempt, on the fake clock, but the
 * writer refused the row write that records it (`Attempt.idleSignal`): only the
 * attempt seam's in-memory signal holds the ended turn, the cache that stands
 * in for a row write which did not land.
 */
async function turnEndedUnrecorded(t, config = {}) {
  const f = await setup({ clock: new FakeClock(), config })
  t.after(() => f.cleanup())
  const task = f.propose({ title: 'Turn ended' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await f.runtime.settle(f.mission.id)
  const put = f.runtime.store.put
  f.runtime.store.put = function (table, value) {
    if (table === 'tasks' && value.attempt?.idleSignal !== undefined) throw new WriterBusyError('SQLite writer stayed busy after 1 attempt(s): database is locked', 1)
    return put.call(this, table, value)
  }
  assert.throws(() => f.workers.callbacks.idle(f.author.id), WriterBusyError, 'the writer refused the row write that records the ended turn')
  delete f.runtime.store.put
  assert.equal(taskOf(f.runtime, task.id).attempt.idleSignal, undefined, 'the row does not record the ended turn')
  return { ...f, task, attemptId: claimed.attempt.id }
}

/** The author's handle is idle and a pass runs, so the idle close-out acts on the ended turn. */
async function closeOutPass(f) {
  f.workers.idle.add(f.author.id)
  f.runtime.kick(f.mission.id)
  await f.runtime.settle(f.mission.id)
}

test('an ended turn the writer could not record on the row is still closed out: the next pass nudges on the attempt seam\'s own signal', async t => {
  const f = await turnEndedUnrecorded(t)
  await closeOutPass(f)
  const row = taskOf(f.runtime, f.task.id)
  assert.deepEqual([row.status, row.attempt?.id, row.attempt?.idleSignal, row.attempt?.closeout?.nudges], ['running', f.attemptId, undefined, 1],
    'the pass nudged the open attempt that its row alone does not name')
  assert.deepEqual(events(f.runtime, f.mission.id, 'task/closeout-nudged').map(event => event.data.taskId), [f.task.id])
  assert.ok(f.workers.deliveries.some(delivery => delivery.memberId === f.author.id && /still open but your turn ended/.test(delivery.content)),
    'and the member is told to finish it')
})

test('the attempt reporting bound never names an attempt whose turn ended, though only the attempt seam records it, before the close-out\'s first nudge or after it', async t => {
  const f = await turnEndedUnrecorded(t, { attemptSilenceBoundMs: 1_000 })
  // The reviewer holds an attempt too, and never ends a turn on it.
  const other = f.propose({ title: 'Never idle', assigneeId: f.reviewer.id })
  const { attempt } = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, other.id)
  await f.runtime.settle(f.mission.id)
  const named = () => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.notice?.dedupKey?.startsWith('attempt-silent:'))
    .map(delivery => delivery.notice.dedupKey.split(':')[1])
  f.clock.advance(2_000)
  assert.equal(f.runtime.scheduling.sweepSilentAttempts(f.mission.id), 1, 'past the bound, before any nudge, one attempt is named')
  assert.deepEqual(named(), [attempt.id], 'the attempt whose owner never ended a turn, never the one the close-out is about to nudge')
  await closeOutPass(f)
  const nudged = taskOf(f.runtime, f.task.id)
  assert.deepEqual([nudged.attempt.idleSignal, nudged.attempt.closeout?.nudges], [undefined, 1], 'the close-out nudged the attempt its row does not name')
  f.clock.advance(2_000)
  assert.equal(f.runtime.scheduling.silentAttempt(nudged, f.runtime.store.get('missions', f.mission.id)), undefined,
    'after the nudge, the reporting bound still leaves the attempt to the close-out')
  f.runtime.scheduling.sweepSilentAttempts(f.mission.id)
  assert.deepEqual(named(), [attempt.id], 'and no owner notice ever names it')
})
