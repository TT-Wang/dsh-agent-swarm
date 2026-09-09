/** W6 regressions: a worker that stops with an open attempt never strands its workspace. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function eventually(read, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

class CloseoutWorkers {
  idle = new Set(); prepared = []; captured = []; stopped = []; stopEntered = new Set(); deliveries = []; captureError; captureGate; stopGate
  checks = []
  artifact = { commit: 'd'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, delivery }) }
  async stop(memberId) {
    this.stopEntered.add(memberId)
    if (this.stopGate !== undefined) await this.stopGate(memberId)
    this.stopped.push(memberId)
  }
  isIdle(memberId) { return this.idle.has(memberId) }
  async prepareTask(member, task) { this.prepared.push(structuredClone({ member: member.id, task })) }
  async captureArtifact(member, task) {
    if (this.captureError !== undefined) throw this.captureError
    this.captured.push(structuredClone({ member: member.id, task }))
    if (this.captureGate !== undefined) await this.captureGate()
    return this.artifact
  }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-closeout-'))
  const workers = new CloseoutWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 300, maxTasksPerMember: 100, ...config }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'closeout-owner' }
  const mission = runtime.create(owner, { title: 'Close-out', objective: 'Never strand uncommitted work', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
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
    && /still open but your turn ended/.test(item.delivery.content)), 'the bounded close-out nudge')
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
  const abandoned = await eventually(() => f.events('task/closeout-abandoned')[0], 'the exhausted close-out abandons the attempt')
  assert.equal(abandoned.data.commit, f.workers.artifact.commit)
  assert.equal(f.workers.captured.length, 1, 'the workspace is checkpointed exactly once')
  assert.equal(f.workers.captured[0].task.id, task.id)
  assert.equal(f.workers.captured[0].task.epoch, claimed.attempt.epoch, 'the checkpoint matches the open attempt baseline')
  assert.equal(f.workers.captured[0].task.attempt.id, claimed.attempt.id)
  // Either the deferred stop reaches the adapter, or a re-pend is observed
  // first - the latter proves the ordering guarantee is broken.
  await eventually(() => f.workers.stopEntered.has(f.author.id) || f.events('task/closeout-ready').length > 0,
    'the close-out stop or an early re-pend')
  assert.equal(f.events('task/closeout-ready').length, 0, 'the task is not re-pended before the abandoned handle is stopped')
  assert.equal(f.workers.stopped.includes(f.author.id), false, 'the gated handle is not yet reported stopped')
  assert.equal(f.current(task.id).status, 'blocked', 'the abandoned task stays undispatchable while the handle stops')
  assert.equal(f.current(task.id).attempt, undefined)
  assert.equal(f.current(task.id).resumeAfterStop?.reason, 'worker-closeout')
  assert.equal(f.events('task/claimed').filter(event => event.data.taskId === task.id).length, 1,
    'no reassignment can be observed before the abandoned handle is stopped')
  releaseStop.resolve()
  await eventually(() => f.workers.stopped.includes(f.author.id), 'the abandoned handle is stopped')
  await eventually(() => f.events('task/closeout-ready')[0], 'the task re-pends only after the stop')
  assert(f.workers.stopped.includes(f.author.id), 'the handle is stopped when the task becomes dispatchable')

  const resumed = await eventually(() => {
    const current = f.current(task.id)
    return current.status === 'running' && current.attempt?.id !== claimed.attempt.id ? current : undefined
  }, 'the checkpointed task resumes on the preferred member')
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
  }, 'the uncheckpointable attempt is blocked')
  assert.match(blocked.output, /could not be checkpointed.*outside task scope/)
  assert.equal(blocked.attempt, undefined, 'the abandoned attempt is fenced')
  assert.equal(f.workers.captured.length, 0)
  assert.equal(f.workers.stopped.length, 0, 'no reassignment is attempted without a checkpoint')
  assert.equal(f.events('task/closeout-failed').length, 1)
  const notice = await eventually(() => f.workers.deliveries.find(item => item.memberId === 'owner'
    && /could not be checkpointed/.test(item.delivery.content)), 'the owner is woken for the uncheckpointable workspace')
  assert.match(notice.delivery.content, new RegExp(task.id))
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
  const checkpointed = await eventually(() => f.events('task/checkpointed')[0], 'the lease-expiry checkpoint')
  assert.equal(checkpointed.data.commit, f.workers.artifact.commit)
  assert.equal(checkpointed.data.reason, 'lease-expired')
  assert.equal(f.workers.captured.at(-1).task.epoch, claimed.attempt.epoch, 'the checkpoint matches the expired attempt baseline')
  const resumed = await eventually(() => {
    const current = f.current(task.id)
    return current.status === 'running' && current.attempt?.id !== claimed.attempt.id ? current : undefined
  }, 'the planned assignee resumes after the checkpoint')
  assert.equal(resumed.attempt.ownerId, f.author.id)
  assert.equal(resumed.checkpoint.commit, f.workers.artifact.commit)
})

test('an owner cancel during the lease-expiry checkpoint is never overwritten by recovery', async t => {
  const f = await fixture(t, { leaseMs: 60 })
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.workers.idle.add(f.author.id)
  const entered = deferred(), release = deferred()
  f.workers.captureGate = async () => { entered.resolve(); await release.promise }
  const stored = f.current(task.id)
  stored.attempt.leaseUntil = Date.now() - 1
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', stored))
  f.workers.callbacks.idle(f.author.id)
  await entered.promise
  // The owner withdraws while captureArtifact is in flight; the checkpoint's
  // post-await transition must not resurrect the task.
  const cancelled = f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'Owner withdraws while the checkpoint is in flight' })
  assert.equal(cancelled.status, 'cancelled')
  release.resolve()
  await new Promise(resolve => setTimeout(resolve, 50))
  const final = f.current(task.id)
  assert.equal(final.status, 'cancelled', 'the in-flight checkpoint must not overwrite the owner cancel')
  assert.equal(final.epoch, cancelled.epoch, 'the cancelled epoch is preserved')
  assert.equal(final.attempt, undefined)
  assert.equal(f.events('task/lease-expired').length, 0, 'lease recovery abandons its transition after the cancel')
  assert.equal(f.events('task/checkpointed').length, 0, 'a checkpoint committed after the cancel is discarded')
  assert.equal(f.events('task/claimed').filter(event => event.data.taskId === task.id).length, 1, 'the cancelled task is never re-claimed')
  assert.equal(f.workers.stopped.filter(id => id === f.author.id).length, 1, 'the released worker is stopped exactly once')
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
  const failed = await eventually(() => f.events('task/checkpoint-failed')[0], 'the failed lease-expiry checkpoint is audited')
  assert.equal(failed.data.taskId, task.id)
  assert.equal(failed.data.ownerId, f.author.id)
  assert.match(failed.data.reason, /index\.lock/)
  const notice = await eventually(() => f.workers.deliveries.find(item => item.memberId === 'owner'
    && /Lease-expiry checkpoint failed/.test(item.delivery.content)), 'the owner is woken for the failed checkpoint')
  assert.match(notice.delivery.content, new RegExp(task.id))
  // Recovery still proceeds; the preserved workspace is what prepareTask guards.
  const resumed = await eventually(() => {
    const current = f.current(task.id)
    return current.status === 'running' && current.attempt?.id !== claimed.attempt.id ? current : undefined
  }, 'lease recovery proceeds after the audited checkpoint failure')
  assert.equal(resumed.attempt.ownerId, f.author.id)
  assert.equal(f.workers.captured.length, 0)
})
