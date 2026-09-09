/**
 * T2 governance regressions: W8 member route validation, the owner's authority
 * to withdraw submitted work (D9), the cancel-during-submit message (F6),
 * deterministic-id re-admission of a cancelled task (F7) and the budget-warning
 * suggested limit (F11). Only the external execution adapter is replaced; store,
 * admission, state transitions and the outbox are the real runtime.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 1000, maxSteps: 10, maxWorkers: 4, maxDurationMs: 600000, maxTasks: 12, maxExperiments: 2 }

async function eventually(read, message) {
  const until = Date.now() + 2500
  while (Date.now() < until) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

/** A provider whose supported efforts are declared by `unsupported` and `rejectAll`. */
class GovernanceWorkers {
  callbacks; deliveries = []; stopped = []; prepared = []
  unsupported = new Set()
  rejectAll = false
  captureStarted = false
  captureGate
  artifact = { commit: 'abc123', baseCommit: 'base', workspace: '/isolated', changedPaths: ['src/a.ts'] }
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return `/isolated/${memberId}` }
  async start(spec) {
    const effort = spec.member.reasoningEffort
    if (effort !== undefined && this.unsupported.has(effort)) {
      const error = new Error(`provider "${spec.member.provider ?? 'inherited'}" model "${spec.member.model ?? 'inherited'}" does not support reasoning effort "${effort}"`)
      error.code = 'UNSUPPORTED_REASONING_EFFORT'
      throw error
    }
    if (this.rejectAll) throw new Error(`provider "${spec.member.provider ?? 'inherited'}" model "${spec.member.model ?? 'inherited'}" is unavailable`)
  }
  async deliver(member, delivery) { this.deliveries.push(delivery) }
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle() { return false }
  async captureArtifact() { this.captureStarted = true; if (this.captureGate) await this.captureGate; return this.artifact }
  async verifyArtifact() { return this.checks }
  async prepareTask(member, task) { this.prepared.push(task.epoch) }
  async dispose() {}
}

async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-governance-'))
  const workers = new GovernanceWorkers()
  const config = { statePath: join(dir, 'db.sqlite'), leaseMs: 60000, tickMs: 1000, maxMessageChars: 16000, maxEvents: 200, maxTasksPerMember: 3, ...options.config }
  const runtime = new SwarmRuntime(config, workers)
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Govern', objective: 'Fix governance', workspace: '/source', scope: ['src/'], acceptance: ['works'], budget: { ...budget, ...options.budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Core', objective: 'Fix governance' })
  const addMember = (input, admittedId) => runtime.addMember(owner, mission.id, { maxOutputTokens: 1000, ...input }, admittedId)
  const propose = (actor, extra = {}, admittedId) => runtime.propose(actor, mission.id, {
    workstreamId: stream.id, title: 'Fix', objective: 'Fix governance', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra }, admittedId)
  const events = type => runtime.snapshot(owner, mission.id).events.filter(event => event.type === type)
  return { runtime, workers, mission, stream, owner, addMember, propose, events }
}

test('W8: an unsupported reasoning effort is downgraded with a durable warning and the member still runs', async t => {
  const f = await setup(t)
  f.workers.unsupported.add('medium')
  const member = await f.addMember({ name: 'Builder', role: 'implementation', provider: 'deepseek-official', model: 'flash', reasoningEffort: 'medium' })
  assert.equal(member.reasoningEffort, undefined, 'the rejected effort is cleared on the admitted member')
  const downgraded = f.events('member/effort-downgraded')
  assert.equal(downgraded.length, 1)
  assert.equal(downgraded[0].data.memberId, member.id)
  assert.equal(downgraded[0].data.requested, 'medium')
  assert.equal(downgraded[0].data.rejected, 'medium')
  assert.match(downgraded[0].data.reason, /does not support reasoning effort "medium"/)
  const stored = f.runtime.snapshot(f.owner, f.mission.id).members.find(item => item.id === member.id)
  assert.equal(stored.status, 'idle', 'the downgraded member is admitted and usable')
  assert.equal(stored.reasoningEffort, undefined)
  assert.equal(f.events('member/failed').length, 0)
})

test('W8: a route that still rejects the cleared effort refuses admission with a typed error', async t => {
  const f = await setup(t)
  f.workers.unsupported.add('medium')
  f.workers.rejectAll = true
  await assert.rejects(
    f.addMember({ name: 'Builder', role: 'implementation', provider: 'deepseek-official', model: 'flash', reasoningEffort: 'medium' }),
    error => {
      assert.match(error.message, /^Member Builder cannot start: provider .+ does not support reasoning effort "medium"/)
      assert.match(error.message, /admit a replacement member without reasoningEffort/i)
      return true
    })
  const rejected = f.events('member/effort-rejected')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].data.requested, 'medium')
  const stored = f.runtime.snapshot(f.owner, f.mission.id).members.find(item => item.name === 'Builder')
  assert.equal(stored.status, 'stopped', 'a member that cannot start is not left live')
})

test('D9: the owner withdraws a submitted task, records the previous status and retires its review', async t => {
  const f = await setup(t)
  const builder = await f.addMember({ name: 'Builder', role: 'implementation' })
  const reviewer = await f.addMember({ name: 'Reviewer', role: 'verification' })
  const task = f.propose({ sessionId: builder.sessionId })
  const claimed = await f.runtime.claim({ sessionId: builder.sessionId }, f.mission.id, task.id)
  await f.runtime.submit({ sessionId: builder.sessionId }, f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'done' })
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(item => item.id === task.id).status, 'submitted')
  const review = f.propose({ sessionId: reviewer.sessionId }, { kind: 'verification', title: 'Review', objective: 'Review the fix', acceptance: ['reviewed'], checks: [], reviewOf: task.id })
  const cancelled = f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'wrong direction' })
  assert.equal(cancelled.status, 'cancelled')
  const withdrawn = f.events('task/cancelled').filter(event => event.data.taskId === task.id)
  assert.equal(withdrawn.length, 1)
  assert.equal(withdrawn[0].data.previousStatus, 'submitted')
  assert.equal(withdrawn[0].data.reason, 'wrong direction')
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(item => item.id === review.id).status, 'cancelled', 'a review of withdrawn work is retired')
})

test('F6: cancelling during artifact capture tells the worker the task is terminal, not to resubmit', async t => {
  const f = await setup(t)
  const builder = await f.addMember({ name: 'Builder', role: 'implementation' })
  const task = f.propose({ sessionId: builder.sessionId })
  const claimed = await f.runtime.claim({ sessionId: builder.sessionId }, f.mission.id, task.id)
  let release
  f.workers.captureGate = new Promise(resolve => { release = resolve })
  const submitting = f.runtime.submit({ sessionId: builder.sessionId }, f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'done' })
  await eventually(() => f.workers.captureStarted, 'artifact capture did not start')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'captured by mistake' })
  release()
  await assert.rejects(submitting, /cancelled this task while the artifact was captured\. It is terminal: stop working on it and do not resubmit/)
})

test('F7: propose(admittedId) refuses to re-admit a cancelled record', async t => {
  const f = await setup(t)
  const builder = await f.addMember({ name: 'Builder', role: 'implementation' })
  const actor = { sessionId: builder.sessionId }
  const admittedId = 'task_deterministic'
  const task = f.propose(actor, {}, admittedId)
  assert.equal(task.id, admittedId)
  assert.equal(f.propose(actor, {}, admittedId).id, admittedId, 'a live record is replayed idempotently')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: admittedId, reason: 'withdrawn' })
  assert.throws(() => f.propose(actor, {}, admittedId), error => {
    assert.match(error.message, /^Task task_deterministic was cancelled by the owner; a cancelled record cannot be re-admitted\./)
    return true
  })
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(item => item.id === admittedId).status, 'cancelled')
})

test('F11: suggestedLimit is the exact ceiling, not one above it', async t => {
  const f = await setup(t, { budget: { maxTokens: 1000 } })
  const builder = await f.addMember({ name: 'Builder', role: 'implementation' })
  await f.workers.callbacks.usageSnapshot(builder.id, 700)
  const warnings = () => f.events('mission/budget-warning')
  assert.equal(warnings().length, 1)
  assert.equal(warnings()[0].data.threshold, 0.7)
  assert.equal(warnings()[0].data.suggestedLimit, 1000, '700 / 0.7 is exactly 1000, not 1001')
  await f.workers.callbacks.usageSnapshot(builder.id, 700)
  assert.equal(warnings().length, 1, 'the threshold warns once')
  await f.workers.callbacks.usageSnapshot(builder.id, 950)
  const last = warnings().at(-1)
  assert.equal(last.data.threshold, 0.9)
  assert.equal(last.data.suggestedLimit, 1056, 'a non-integer ratio still rounds up')
})
