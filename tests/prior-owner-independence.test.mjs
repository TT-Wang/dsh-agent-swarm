/**
 * X1 (P0): independence from every prior owner.
 *
 * A prior owner could review and accept work they co-authored because
 * independence was decided from the LAST attempt's owner: a handoff, lease
 * expiry, idle close-out or start-failure reroute made every earlier owner
 * eligible again. The durable `priorOwnerIds` history plus the union predicate
 * closes admission, claim and verify for every member who ever owned the task.
 * The property asserted here is the general one: for each recorded prior owner,
 * admission, claim and acceptance are all refused.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 1e7, maxSteps: 9999, maxWorkers: 20, maxDurationMs: 3_600_000, maxTasks: 60, maxExperiments: 0 }

async function eventually(read, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

class IndependenceWorkers {
  callbacks
  checks = [{ command: 't', exitCode: 0, output: 'ok' }]
  idle = new Set()
  startError
  failingMemberId
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, id) { return join(mission.workspace, id) }
  async start(spec) { if (this.startError && (this.failingMemberId === undefined || spec.member.id === this.failingMemberId)) throw this.startError }
  async deliver() {}
  async stop() {}
  isIdle(id) { return this.idle.has(id) }
  async prepareTask() {}
  async captureArtifact(member) { return { commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), workspace: member.workspace, changedPaths: ['src/runtime.ts'] } }
  async verifyArtifact() { return this.checks }
  currentActivity() { return undefined }
  async dispose() {}
}

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-independence-'))
  const workers = new IndependenceWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 600_000, tickMs: 10,
    maxMessageChars: 16_000, maxEvents: 500, maxTasksPerMember: 5, ...config }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.start()
  const owner = { sessionId: 'independence-owner' }
  const mission = runtime.create(owner, { title: 'independence', objective: 'No prior owner may review', workspace: directory, scope: ['**'], acceptance: ['ok'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'main', objective: 'main' })
  const first = await runtime.addMember(owner, mission.id, { name: 'first-author', role: 'implementation', maxOutputTokens: 5000 })
  const second = await runtime.addMember(owner, mission.id, { name: 'second-author', role: 'implementation', maxOutputTokens: 5000 })
  const third = await runtime.addMember(owner, mission.id, { name: 'independent-reviewer', role: 'verification', maxOutputTokens: 5000 })
  const actor = member => ({ sessionId: member.sessionId })
  const taskOf = id => runtime.store.get('tasks', id)
  const propose = extra => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'shared work', objective: 'do the work',
    kind: 'implementation', scope: ['src/'], acceptance: ['ok'], checks: ['t'], maxRecoveryAttempts: 3, checkTimeoutMs: 1000, ...extra })
  const review = extra => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'review', objective: 'review it',
    kind: 'verification', scope: ['src/'], acceptance: ['ok'], maxRecoveryAttempts: 2, ...extra })
  return { directory, runtime, workers, owner, mission, stream, first, second, third, actor, taskOf, propose, review }
}

/** The general property: no recorded prior owner may be admitted, claim or accept. */
async function assertPriorOwnersRefused(f, source, reviewTask) {
  const prior = f.taskOf(source.id).priorOwnerIds ?? []
  assert(prior.length > 0, 'the attempt-dropping path must record the prior owner')
  for (const memberId of prior) {
    const member = f.runtime.store.get('members', memberId)
    // Admission: the independence guard refuses a prior owner by name. A member
    // already retired by the path (e.g. the start-failure reroute) is refused
    // even earlier as an unknown assignee; both are refusals of the property.
    assert.throws(() => f.review({ reviewOf: source.id, assigneeId: memberId }),
      /authored .*member who never owned it|Unknown assignee/,
      `prior owner ${memberId} must be refused at admission`)
    const open = f.review({ reviewOf: source.id })
    await assert.rejects(f.runtime.claim({ sessionId: member.sessionId }, f.mission.id, open.id),
      /Task is not ready for this member|not a participant/,
      `prior owner ${memberId} must be refused at claim`)
    // The verify guard is defence in depth: even if a review attempt were
    // handed to a prior owner, acceptance is refused.
    if (reviewTask !== undefined) {
      const claimed = await f.runtime.claim(f.actor(f.third), f.mission.id, reviewTask.id)
      const forged = f.taskOf(reviewTask.id)
      forged.attempt.ownerId = memberId
      f.runtime.store.transaction(() => f.runtime.store.put('tasks', forged))
      await assert.rejects(f.runtime.verify({ sessionId: member.sessionId }, f.mission.id,
        { taskId: reviewTask.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'self-review' }),
      /Only independent verification of a submitted artifact by a member who never owned it|not a participant/,
      `prior owner ${memberId} must be refused at verify`)
      const restored = f.taskOf(reviewTask.id)
      restored.attempt.ownerId = f.third.id
      f.runtime.store.transaction(() => f.runtime.store.put('tasks', restored))
    }
  }
}

test('X1: a handoff does not make the first author eligible to review or accept', async t => {
  const f = await fixture(t)
  const source = f.propose({ assigneeId: f.first.id })
  const firstClaim = await f.runtime.claim(f.actor(f.first), f.mission.id, source.id)
  f.runtime.handoff(f.actor(f.first), f.mission.id, { taskId: source.id, attemptId: firstClaim.attempt.id, to: f.second.id, summary: 'first half done' })
  await eventually(() => f.taskOf(source.id).status === 'pending', 'the handoff re-pends the task')
  const secondClaim = await f.runtime.claim(f.actor(f.second), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.second), f.mission.id, { taskId: source.id, attemptId: secondClaim.attempt.id, output: 'joint work by first and second' })
  assert.deepEqual(f.taskOf(source.id).priorOwnerIds, [f.first.id], 'the handoff records the first owner durably')
  const reviewTask = f.review({ reviewOf: source.id, assigneeId: f.third.id })
  await assertPriorOwnersRefused(f, source, reviewTask)
})

test('X1: a lease expiry does not make the previous owner eligible again', async t => {
  const f = await fixture(t, { leaseMs: 60_000 })
  const source = f.propose({ assigneeId: f.first.id })
  await f.runtime.claim(f.actor(f.first), f.mission.id, source.id)
  const expiring = f.taskOf(source.id)
  expiring.attempt.leaseUntil = Date.now() + 5
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', expiring))
  await eventually(() => f.taskOf(source.id).status === 'pending', 'the expired lease re-pends the task')
  assert.deepEqual(f.taskOf(source.id).priorOwnerIds, [f.first.id])
  const released = f.taskOf(source.id)
  delete released.assigneeId; delete released.plannedAssigneeId
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', released))
  const secondClaim = await f.runtime.claim(f.actor(f.second), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.second), f.mission.id, { taskId: source.id, attemptId: secondClaim.attempt.id, output: 'second author work' })
  await assertPriorOwnersRefused(f, source)
})

test('X1: an idle close-out does not make the previous owner eligible again', async t => {
  const f = await fixture(t, { maxIdleCloseouts: 1 })
  const source = f.propose({ assigneeId: f.first.id })
  await f.runtime.claim(f.actor(f.first), f.mission.id, source.id)
  f.workers.idle.add(f.first.id)
  f.workers.callbacks.idle(f.first.id)
  await eventually(() => (f.taskOf(source.id).priorOwnerIds ?? []).includes(f.first.id), 'the idle close-out checkpoints and records the owner')
  // The checkpoint dropped the attempt. Force the released state and stop the
  // member from being re-dispatched so the next owner can claim.
  const released = f.taskOf(source.id)
  released.status = 'pending'; released.epoch++
  delete released.attempt; delete released.assigneeId; delete released.plannedAssigneeId; delete released.resumeAfterStop
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', released))
  f.workers.idle.delete(f.first.id)
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.deepEqual(f.taskOf(source.id).priorOwnerIds, [f.first.id])
  const secondClaim = await f.runtime.claim(f.actor(f.second), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.second), f.mission.id, { taskId: source.id, attemptId: secondClaim.attempt.id, output: 'second author work' })
  await assertPriorOwnersRefused(f, source)
})

test('X1: a start-failure reroute does not make the previous owner eligible again', async t => {
  const f = await fixture(t)
  const source = f.propose({ assigneeId: f.first.id })
  await f.runtime.claim(f.actor(f.first), f.mission.id, source.id)
  f.workers.failingMemberId = f.first.id
  f.workers.startError = new Error('route unavailable')
  const rerouted = await eventually(() => {
    const current = f.taskOf(source.id)
    return current.assigneeId !== undefined && current.assigneeId !== f.first.id ? current : undefined
  }, 'the start-failure reroute moves the task to another member', 8000)
  f.workers.startError = undefined
  assert.ok((rerouted.priorOwnerIds ?? []).includes(f.first.id), 'the reroute records the previous owner')
  const target = rerouted.assigneeId
  assert.ok(target !== undefined && target !== f.first.id, 'the task is re-routed to another member')
  const targetClaim = await f.runtime.claim({ sessionId: f.runtime.store.get('members', target).sessionId }, f.mission.id, source.id)
  await f.runtime.submit({ sessionId: f.runtime.store.get('members', target).sessionId }, f.mission.id, { taskId: source.id, attemptId: targetClaim.attempt.id, output: 'rerouted work' })
  await assertPriorOwnersRefused(f, source)
})

test('X1: cancellation records the owner history and a cancelled task stays unreviewable', async t => {
  const f = await fixture(t)
  const source = f.propose({ assigneeId: f.first.id })
  await f.runtime.claim(f.actor(f.first), f.mission.id, source.id)
  f.runtime.cancel(f.owner, f.mission.id, { taskId: source.id, reason: 'withdrawn' })
  assert.deepEqual(f.taskOf(source.id).priorOwnerIds, [f.first.id], 'cancellation keeps the durable ownership history')
  assert.throws(() => f.review({ reviewOf: source.id }), /that task is already cancelled/)
})
