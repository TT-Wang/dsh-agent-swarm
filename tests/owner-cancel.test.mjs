/** W5 regressions: owner-only withdrawal of admitted-but-mistaken work. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { registerTools, SWARM_TOOLS, MANAGEMENT_TOOLS, OWNER_SESSION_TOOLS } from '../lib/tools.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function eventually(read, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

class CancelWorkers {
  prepared = []; stopped = []; stopGate
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop(memberId) { if (this.stopGate) await this.stopGate; this.stopped.push(memberId) }
  isIdle() { return false }
  async prepareTask(member, task) { this.prepared.push(structuredClone({ member: member.id, task })) }
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-cancel-'))
  const workers = new CancelWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 300, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'cancel-owner' }
  const mission = runtime.create(owner, { title: 'Cancel', objective: 'Withdraw mistaken work', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  async function block(task) {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    await runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: `Review ${task.title}`, objective: 'Independent review',
      kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: task.id })
    const claimedReview = await runtime.claim(actor(reviewer), mission.id, review.id)
    workers.checks = [{ command: 'test', exitCode: 1, output: 'host check failed' }]
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Host checks reject the candidate' })
    workers.checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
    return review
  }
  async function accept(task) {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    await runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: `Review ${task.title}`, objective: 'Independent review',
      kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: task.id })
    const claimedReview = await runtime.claim(actor(reviewer), mission.id, review.id)
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
    return current(task)
  }
  return { runtime, workers, owner, mission, stream, author, reviewer, actor, propose, block, accept, current, events }
}

test('owner cancel withdraws a pending duplicate and lineage falls back to the surviving replacement', async t => {
  const f = await fixture(t)
  const original = f.propose()
  await f.block(original)
  const survivor = f.propose({ title: 'Surviving repair', replaces: [original.id] })
  const survivorRecord = f.current(survivor)
  const duplicate = { ...structuredClone(survivorRecord), id: 'task_imported_duplicate', title: 'Imported duplicate',
    createdAt: survivorRecord.createdAt + 1, evidenceIds: [], attempt: undefined, artifact: undefined, output: undefined }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', duplicate))
  const dependent = f.propose({ title: 'Dependent synthesis', kind: 'research', checks: undefined, dependencies: [original.id] })
  assert.equal(f.runtime.observe(f.actor(f.reviewer), f.mission.id, { taskId: dependent.id }).dependencies[0].id, survivor.id)

  const cancelled = f.runtime.cancel(f.owner, f.mission.id, { taskId: duplicate.id, reason: 'Admitted a duplicate replacement by mistake' })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(f.current(duplicate.id).status, 'cancelled')
  const [event] = f.events('task/cancelled')
  assert.equal(event.data.taskId, duplicate.id)
  assert.equal(event.data.previousStatus, 'pending')
  assert.match(event.data.reason, /duplicate replacement/)
  assert.equal(f.current(survivor.id).status, 'pending', 'the surviving replacement is untouched')
  assert.equal(f.runtime.observe(f.actor(f.reviewer), f.mission.id, { taskId: dependent.id }).dependencies[0].id, survivor.id,
    'lineage resolves to the surviving live replacement')
  // Terminal states are immutable: a replay is a no-op, not a second mutation or event.
  const replayed = f.runtime.cancel(f.owner, f.mission.id, { taskId: duplicate.id, reason: 'Replay' })
  assert.equal(replayed.status, 'cancelled')
  assert.equal(f.events('task/cancelled').length, 1, 'a cancelled task is never re-audited')
})

test('cancelling the only live replacement lets the owner admit a corrected replacement', async t => {
  const f = await fixture(t)
  const original = f.propose()
  await f.block(original)
  const mistaken = f.propose({ title: 'Mistaken repair', replaces: [original.id] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: mistaken.id, reason: 'Wrong scope for this repair' })
  // A cancelled replacement is no longer live, so the admission guard admits
  // the corrected repair while still keeping exactly one live replacement.
  const corrected = f.propose({ title: 'Corrected repair', replaces: [original.id] })
  assert.equal(corrected.status, 'pending')
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.filter(task => task.replaces?.includes(original.id) && task.status !== 'cancelled').length, 1)
  const dependent = f.propose({ title: 'Dependent synthesis', kind: 'research', checks: undefined, dependencies: [original.id] })
  assert.equal(f.runtime.observe(f.actor(f.reviewer), f.mission.id, { taskId: dependent.id }).dependencies[0].id, corrected.id)
})

test('owner cancel terminates a running attempt, releases the lease, frees the member and stops the worker', async t => {
  const f = await fixture(t)
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).members.find(member => member.id === f.author.id).status, 'working')
  const cancelled = f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'Superseded by a clearer task' })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.attempt, undefined, 'the lease is released immediately')
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.members.find(member => member.id === f.author.id).status, 'idle', 'the member is free for other work')
  const [event] = f.events('task/cancelled')
  assert.equal(event.data.previousStatus, 'running')
  assert.equal(event.data.attemptId, claimed.attempt.id)
  assert.equal(event.data.ownerId, f.author.id)
  await eventually(() => f.workers.stopped.includes(f.author.id), 'the released worker handle is stopped')
  await assert.rejects(f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'late' }), /Stale|unauthorized|terminal/i)
  assert.throws(() => f.runtime.publish(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, claim: 'late', outcome: 'supported', toolRunIds: [] }), /Stale|unauthorized|terminal/i)
  assert.equal(f.current(task.id).status, 'cancelled', 'late calls never revive terminal work')
})

test('cancelling accepted work is refused and leaves the accepted record immutable', async t => {
  const f = await fixture(t)
  const task = f.propose()
  await f.accept(task)
  assert.equal(f.current(task.id).status, 'accepted')
  const before = structuredClone(f.current(task.id))
  assert.throws(() => f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'Mistake after all' }), /accepted; accepted work is immutable/)
  assert.deepEqual(f.current(task.id), before, 'a refused cancel never mutates accepted work')
  assert.equal(f.events('task/cancelled').length, 0)
})

test('owner cancel wins a handoff race: the blocked task never re-opens after the worker stops', async t => {
  const f = await fixture(t)
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  const gate = deferred()
  f.workers.stopGate = gate.promise
  f.runtime.handoff(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, to: f.reviewer.id, summary: 'Reassign' })
  assert.equal(f.current(task.id).status, 'blocked')
  const cancelled = f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'No longer needed' })
  assert.equal(cancelled.status, 'cancelled')
  gate.resolve()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.current(task.id).status, 'cancelled', 'the deferred handoff cannot reopen cancelled work')
  assert.equal(f.current(task.id).resumeAfterStop, undefined)
})

test('swarm_cancel is registered as an owner-only tool with a schema and a worker guard', async t => {
  const f = await fixture(t)
  assert(SWARM_TOOLS.includes('swarm_cancel'))
  assert(MANAGEMENT_TOOLS.includes('swarm_cancel'), 'workers must not see the management tool')
  assert(OWNER_SESSION_TOOLS.includes('swarm_cancel'), 'an entry session has no mission to cancel in')
  const calls = []
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } },
    { cancel: (...args) => { calls.push(args); return { status: 'cancelled' } }, snapshot: () => undefined }, budget)
  const definition = definitions.get('swarm_cancel')
  assert.ok(definition, 'swarm_cancel is registered')
  assert.deepEqual(definition.parameters.required, ['missionId', 'taskId', 'reason'])
  const result = await definition.execute({ missionId: f.mission.id, taskId: 'task-1', reason: 'withdraw' },
    { signal: { throwIfAborted() {} }, agent: { id: 'owner-session' } })
  assert.equal(calls[0][0].sessionId, 'owner-session')
  assert.equal(calls[0][1], f.mission.id)
  assert.deepEqual(calls[0][2], { taskId: 'task-1', reason: 'withdraw' })
  assert.deepEqual(result.result, { status: 'cancelled' })
  // A worker can never reach the tool: hidden in the schema set and denied by the runtime guard.
  assert.match(f.workers.callbacks.guard(f.author.id, 'swarm_cancel'), /bypass mission authority/)
  await assert.rejects(Promise.resolve().then(() => f.runtime.cancel(f.actor(f.author), f.mission.id, { taskId: 'task-1', reason: 'peer GO' })), /Only the mission owner/)
})

test('cancelling a source retires a running review so it cannot re-pend after lease expiry', async t => {
  const f = await fixture(t)
  const source = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, { workstreamId: f.stream.id, title: 'Review source', objective: 'Independent review',
    kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: source.id })
  await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  assert.equal(f.current(review.id).status, 'running')
  // A review parked by lease expiry or handoff would re-pend after restart even
  // though its source can never be reviewed again; model that durable state.
  const parked = f.runtime.propose(f.owner, f.mission.id, { workstreamId: f.stream.id, title: 'Parked review', objective: 'Independent review',
    kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: source.id })
  const parkedRecord = f.current(parked.id)
  parkedRecord.status = 'blocked'; parkedRecord.resumeAfterStop = { epoch: parkedRecord.epoch, reason: 'lease-expired' }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', parkedRecord))
  f.runtime.cancel(f.owner, f.mission.id, { taskId: source.id, reason: 'Source withdrawn' })
  const retired = f.current(review.id)
  assert.equal(retired.status, 'cancelled', 'a running review of withdrawn work is retired with its source')
  assert.equal(retired.attempt, undefined, 'the review attempt is fenced')
  assert.equal(retired.resumeAfterStop, undefined, 'a retired review cannot re-pend')
  assert.match(retired.output, /Superseded/)
  const parkedAfter = f.current(parked.id)
  assert.equal(parkedAfter.status, 'cancelled', 'a quiescence-parked review of withdrawn work is retired too')
  assert.equal(parkedAfter.resumeAfterStop, undefined)
  await eventually(() => f.workers.stopped.includes(f.reviewer.id), 'the retired reviewer is stopped')
  // Even a later scheduling pass must not re-pend or reassign the review.
  f.workers.callbacks.idle(f.reviewer.id)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.current(review.id).status, 'cancelled')
  assert.equal(f.events('task/lease-expired').filter(event => event.data.taskId === review.id).length, 0)
})
