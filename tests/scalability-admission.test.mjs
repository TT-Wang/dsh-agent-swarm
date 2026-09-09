/**
 * D8 admission control regressions. Every decision is a durable row with a reason
 * code, limits are hierarchical (scope -> task class -> agent) with the strictest
 * matching rule winning, repeated refusals merge in place instead of growing an
 * in-memory queue, and a classified writer conflict surfaces as a durable
 * `writer_busy` row before the next successful admission. Only the execution
 * adapter is inert; store, admission and state transitions are the real runtime.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SwarmRuntime } from '../lib/runtime.js'
import { AdmissionRefusedError, decideAdmission, defaultLimitRules, effectiveLimit, scopeKeysOverlap } from '../lib/scheduler.js'
import { SwarmStore } from '../lib/store.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 32, maxExperiments: 0 }
const owner = { sessionId: 'd8-owner' }
const actorFor = member => ({ sessionId: member.sessionId })

class InertWorkers {
  callbacks; prepared = []; stopped = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return `/inert/${memberId}` }
  async start() {}
  async deliver() {}
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle() { return false }
  async prepareTask(member, task) { this.prepared.push(task.id) }
  async captureArtifact() { return { commit: 'inert', baseCommit: 'inert', workspace: '/inert', changes: [] } }
  async verifyArtifact() { return [] }
  async dispose() {}
}

async function eventually(read, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(message)
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-d8-admission-'))
  const workers = new InertWorkers()
  const config = { statePath: join(root, 'state.sqlite'), leaseMs: 60000, tickMs: options.tickMs ?? 3600000, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }
  const runtime = new SwarmRuntime(config, workers, options.storeOptions ?? {})
  await runtime.start()
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, runtime, workers, config }
}

async function mission(runtime, overrides = {}) {
  return runtime.create(owner, { title: 'D8 admission', objective: 'prove admission control', workspace: '/inert-workspace', scope: ['**'], acceptance: ['admission is durable'], budget: { ...budget, ...overrides } })
}

async function addWorker(runtime, m, name) {
  return runtime.addMember(owner, m.id, { name, role: 'worker', maxOutputTokens: 1000 })
}

function propose(runtime, m, stream, member, scope) {
  return runtime.propose(owner, m.id, {
    workstreamId: stream.id, title: `task ${scope}`, objective: `do ${scope}`, kind: 'implementation', scope: [scope],
    acceptance: ['done'], checks: ['node -e "process.exit(0)"'], assigneeId: member.id,
  })
}

test('pure hierarchy: the strictest matching rule wins at every level and each reason code is reachable', () => {
  const rules = [
    { id: 's1', missionId: 'm', level: 'scope', key: '*', limit: 4, createdAt: 0 },
    { id: 's2', missionId: 'm', level: 'scope', key: 'src/a/', limit: 2, createdAt: 0 },
    { id: 't1', missionId: 'm', level: 'taskClass', key: 'implementation', limit: 1, createdAt: 0 },
    { id: 'g1', missionId: 'm', level: 'agent', key: '*', limit: 1, createdAt: 0 },
  ]
  const candidate = { missionId: 'm', memberId: 'member-1', taskId: 'task-1', taskClass: 'implementation', scope: 'src/a/x.ts', epoch: 0 }
  assert.equal(effectiveLimit('scope', 'src/a/x.ts', rules).limit, 2, 'a key-specific rule beats a wider * rule')
  assert.ok(scopeKeysOverlap('src/a/', 'src/a/x.ts'))
  assert.ok(scopeKeysOverlap('**', 'src/a/'))
  assert.equal(decideAdmission(candidate, rules, { scope: 0, taskClass: 0, agent: 0 }).reason, 'admitted')
  const scope = decideAdmission(candidate, rules, { scope: 2, taskClass: 0, agent: 0 })
  assert.deepEqual([scope.reason, scope.level, scope.limit, scope.inUse], ['queue_full', 'scope', 2, 2])
  assert.equal(decideAdmission(candidate, rules, { scope: 0, taskClass: 1, agent: 0 }).level, 'taskClass')
  assert.equal(decideAdmission(candidate, rules, { scope: 0, taskClass: 0, agent: 1 }).level, 'agent')
  assert.equal(decideAdmission(candidate, rules, { scope: 0, taskClass: 0, agent: 0 }, { budgetExceeded: 'tokens' }).reason, 'budget_exceeded')
  assert.equal(decideAdmission(candidate, rules, { scope: 0, taskClass: 0, agent: 0 }, { leaseConflict: 'owned' }).reason, 'lease_conflict')
  assert.equal(decideAdmission(candidate, rules, { scope: 0, taskClass: 0, agent: 0 }, { writerBusy: 'locked' }).reason, 'writer_busy')
  const defaults = defaultLimitRules('m', 6)
  assert.deepEqual(defaults.map(rule => [rule.level, rule.key, rule.limit]), [['scope', '*', 6], ['taskClass', '*', 6], ['agent', '*', 1]])
})

test('an admitted lease writes one durable admission row with a measured latency', async t => {
  const { runtime } = await fixture(t)
  const m = await mission(runtime)
  const stream = runtime.workstream(owner, m.id, { title: 'w', objective: 'o' })
  const alice = await addWorker(runtime, m, 'alice')
  const task = propose(runtime, m, stream, alice, 'src/a/')
  const claimed = await runtime.claim(actorFor(alice), m.id, task.id)
  assert.equal(claimed.status, 'running')
  const rows = runtime.admissionLedger(owner, m.id, { reason: 'admitted' })
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].taskId, rows[0].memberId, rows[0].admitted, rows[0].reason], [task.id, alice.id, true, 'admitted'])
  assert.ok(Number.isFinite(rows[0].latencyMs) && rows[0].latencyMs >= 0, 'admission latency is recorded')
})

test('a hierarchical scope limit refuses the next lease with a durable queue_full row', async t => {
  const { runtime } = await fixture(t)
  const m = await mission(runtime)
  const stream = runtime.workstream(owner, m.id, { title: 'w', objective: 'o' })
  const alice = await addWorker(runtime, m, 'alice')
  const bob = await addWorker(runtime, m, 'bob')
  runtime.setAdmissionLimit(owner, m.id, { level: 'scope', key: 'src/a/', limit: 1 }, 'one concurrent writer per scope')
  const first = propose(runtime, m, stream, alice, 'src/a/')
  const second = propose(runtime, m, stream, bob, 'src/a/')
  await runtime.claim(actorFor(alice), m.id, first.id)
  await assert.rejects(runtime.claim(actorFor(bob), m.id, second.id),
    error => error instanceof AdmissionRefusedError && error.reason === 'queue_full' && /queue_full at scope/.test(error.message))
  const refusals = runtime.admissionLedger(owner, m.id, { reason: 'queue_full' })
  assert.equal(refusals.length, 1)
  assert.deepEqual([refusals[0].level, refusals[0].key, refusals[0].limit, refusals[0].inUse, refusals[0].admitted],
    ['scope', 'src/a/', 1, 1, false])
  assert.equal(runtime.observe(owner, m.id, { taskId: second.id }).task.status, 'pending', 'a refused task stays pending, never queued in memory')
})

test('a second lease for one member is a durable lease_conflict refusal', async t => {
  const { runtime } = await fixture(t)
  const m = await mission(runtime)
  const stream = runtime.workstream(owner, m.id, { title: 'w', objective: 'o' })
  const alice = await addWorker(runtime, m, 'alice')
  const first = propose(runtime, m, stream, alice, 'src/a/')
  const second = propose(runtime, m, stream, alice, 'src/b/')
  await runtime.claim(actorFor(alice), m.id, first.id)
  await assert.rejects(runtime.claim(actorFor(alice), m.id, second.id),
    error => error instanceof AdmissionRefusedError && error.reason === 'lease_conflict')
  const refusals = runtime.admissionLedger(owner, m.id, { reason: 'lease_conflict' })
  assert.equal(refusals.length, 1)
  assert.equal(refusals[0].taskId, second.id)
  assert.match(refusals[0].detail, /already owns a running lease/)
})

test('budget exhaustion records durable budget_exceeded rows for waiting tasks', async t => {
  const { runtime } = await fixture(t, { tickMs: 20 })
  const m = await mission(runtime)
  const stream = runtime.workstream(owner, m.id, { title: 'w', objective: 'o' })
  const alice = await addWorker(runtime, m, 'alice')
  const task = propose(runtime, m, stream, alice, 'src/a/')
  runtime.updateBudget(owner, m.id, { ...budget, maxDurationMs: Date.now() - m.createdAt + 40 }, 'load-test squeeze')
  await eventually(() => runtime.admissionLedger(owner, m.id, { reason: 'budget_exceeded' }).length > 0, 'budget refusal was not recorded')
  const rows = runtime.admissionLedger(owner, m.id, { reason: 'budget_exceeded' })
  assert.ok(rows.some(row => row.taskId === task.id && /maxDurationMs/.test(row.detail)))
  assert.equal(rows[0].admitted, false)
})

test('repeated refusals merge into one bounded durable row instead of growing a queue', async t => {
  const { runtime } = await fixture(t)
  const m = await mission(runtime)
  const stream = runtime.workstream(owner, m.id, { title: 'w', objective: 'o' })
  const alice = await addWorker(runtime, m, 'alice')
  const bob = await addWorker(runtime, m, 'bob')
  runtime.setAdmissionLimit(owner, m.id, { level: 'scope', key: 'src/a/', limit: 1 })
  const first = propose(runtime, m, stream, alice, 'src/a/')
  const second = propose(runtime, m, stream, bob, 'src/a/')
  await runtime.claim(actorFor(alice), m.id, first.id)
  for (let attempt = 0; attempt < 6; attempt++) await assert.rejects(runtime.claim(actorFor(bob), m.id, second.id), /queue_full/)
  const rows = runtime.admissionLedger(owner, m.id, { reason: 'queue_full' })
  assert.equal(rows.length, 1, 'six refusals still occupy exactly one durable row')
  assert.ok(rows[0].count >= 1)
})

test('recordAdmission merges counts in place for a repeated decision identity', async t => {
  const { root } = await fixture(t)
  const store = new SwarmStore(join(root, 'merge.sqlite'))
  t.after(() => store.close())
  const row = { id: 'admission:task-1:member-1:0:queue_full', missionId: 'm', memberId: 'member-1', taskId: 'task-1', epoch: 0,
    reason: 'queue_full', admitted: false, taskClass: 'implementation', scope: 'src/a/', level: 'scope', key: 'src/a/', limit: 1, inUse: 1,
    count: 1, latencyMs: 0, detail: 'queue_full at scope', firstAt: 10, lastAt: 10 }
  store.transaction(() => { store.recordAdmission(row); store.recordAdmission({ ...row, lastAt: 20 }); store.recordAdmission({ ...row, lastAt: 30 }) })
  const rows = store.admissions('m')
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].count, rows[0].firstAt, rows[0].lastAt], [3, 10, 30])
})

test('a classified writer conflict becomes a durable writer_busy row before the retried admission', async t => {
  const { runtime, root } = await fixture(t, { storeOptions: { busyTimeoutMs: 1, writerAttempts: 2, writerDelayMs: 1 } })
  const m = await mission(runtime)
  const stream = runtime.workstream(owner, m.id, { title: 'w', objective: 'o' })
  const alice = await addWorker(runtime, m, 'alice')
  const task = propose(runtime, m, stream, alice, 'src/a/')
  const blocker = new DatabaseSync(join(root, 'state.sqlite'))
  blocker.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE')
  try {
    await assert.rejects(runtime.claim(actorFor(alice), m.id, task.id), error => error instanceof AdmissionRefusedError && error.reason === 'writer_busy')
  } finally { blocker.exec('ROLLBACK'); blocker.close() }
  const claimed = await runtime.claim(actorFor(alice), m.id, task.id)
  assert.equal(claimed.status, 'running')
  const ledger = runtime.admissionLedger(owner, m.id)
  const busy = ledger.find(row => row.reason === 'writer_busy')
  assert.ok(busy, 'writer_busy was classified and recorded')
  assert.deepEqual([busy.admitted, busy.taskId, busy.memberId], [false, task.id, alice.id])
  assert.ok(ledger.some(row => row.reason === 'admitted' && row.taskId === task.id), 'the retried admission succeeded')
})

test('admission limits are owner-only, validated and durable', async t => {
  const { runtime, root } = await fixture(t)
  const m = await mission(runtime)
  const alice = await addWorker(runtime, m, 'alice')
  assert.throws(() => runtime.setAdmissionLimit(actorFor(alice), m.id, { level: 'scope', limit: 2 }), /Only the mission owner/)
  assert.throws(() => runtime.setAdmissionLimit(owner, m.id, { level: 'scope', key: '/abs', limit: 2 }), /scope selector/)
  assert.throws(() => runtime.setAdmissionLimit(owner, m.id, { level: 'taskClass', key: 'nope', limit: 2 }), /Task-class/)
  assert.throws(() => runtime.setAdmissionLimit(owner, m.id, { level: 'agent', key: 'nope', limit: 2 }), /member id/)
  assert.throws(() => runtime.setAdmissionLimit(owner, m.id, { level: 'scope', limit: 0 }), /positive safe integer/)
  const rule = runtime.setAdmissionLimit(owner, m.id, { level: 'taskClass', key: 'implementation', limit: 2 }, 'cap')
  assert.equal(rule.id, `limit:${m.id}:taskClass:implementation`)
  assert.deepEqual(runtime.store.list('limits', m.id).map(item => item.id), [rule.id])
})

test('refusals and pending work are durable across a runtime restart', async t => {
  const { runtime, root, config, workers } = await fixture(t)
  const m = await mission(runtime)
  const stream = runtime.workstream(owner, m.id, { title: 'w', objective: 'o' })
  const alice = await addWorker(runtime, m, 'alice')
  const bob = await addWorker(runtime, m, 'bob')
  runtime.setAdmissionLimit(owner, m.id, { level: 'scope', key: 'src/a/', limit: 1 })
  const first = propose(runtime, m, stream, alice, 'src/a/')
  const second = propose(runtime, m, stream, bob, 'src/a/')
  await runtime.claim(actorFor(alice), m.id, first.id)
  await assert.rejects(runtime.claim(actorFor(bob), m.id, second.id), /queue_full/)
  await runtime.dispose()
  const reopened = new SwarmRuntime(config, workers, {})
  t.after(async () => { await reopened.dispose() })
  assert.equal(reopened.admissionLedger(owner, m.id, { reason: 'queue_full' }).length, 1)
  assert.equal(reopened.observe(owner, m.id, { taskId: second.id }).task.status, 'pending')
  assert.equal(reopened.admissionLedger(owner, m.id, { reason: 'admitted' }).length, 1)
  void root
})
