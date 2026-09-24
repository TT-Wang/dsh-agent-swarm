import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { OwnerReplyGuard } from '../lib/owner-reply.js'
import { RoleScoper } from '../lib/roles.js'
import { RefusalRegistry, emitGuardTerminal } from '../lib/refusals.js'
import { WriterBusyError } from '../lib/store.js'
import { pendingReadiness } from '../lib/arena.js'
import { Attempts, pendingStopOwner } from '../lib/attempts.js'
import { wakePrecision } from './instruments.mjs'
import { FakeWorkers, makeRuntime, makeRuntimeStub } from './faults/harness.mjs'

function guardFixture() {
  const mission = { id: 'm', ownerSessionId: 'owner', status: 'active' }
  const question = { id: 'q', missionId: 'm', from: 'worker', to: 'owner', content: 'Choose an API', replyExpected: true, deliveredAt: 1 }
  const hooks = new Set()
  const rt = makeRuntimeStub({
    store: { list: () => [mission], get: table => table === 'missions' ? mission : question, put() {}, event() {} },
    isMissionTerminal: value => ['completed', 'stopped'].includes(value.status), openAsks: () => [question],
    commit: (_id, fn) => fn(), notify() {}, noticeSubjectsFor: () => [],
  })
  const ctx = { on: () => () => {}, agents: { get: () => ({ ctx: { on: (_name, hook) => {
    hooks.add(hook); return () => hooks.delete(hook)
  } } }) } }
  return { mission, question, hooks, rt, guard: new OwnerReplyGuard(ctx, rt, { guard: 'block', maxNudges: 2 }) }
}

test('R12: aborted, failed and blocked turns leave the owner reply opportunity intact', () => {
  const f = guardFixture()
  for (const kind of ['aborted', 'error', 'blocked', 'max-tokens']) {
    f.guard.observe('owner', 'user/message', { createdAt: 2 })
    f.guard.observe('owner', 'turn/end', { reason: { kind } })
    assert.equal(f.question.replyNudges, undefined, kind)
  }
  f.guard.observe('owner', 'user/message', { createdAt: 2 })
  f.guard.observe('owner', 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(f.question.replyNudges, 1)
  assert.equal(f.hooks.size, 0, 'legacy block never installs an owner pre-step rejection')
  f.guard.dispose()
  f.guard.dispose()
  assert.equal(f.hooks.size, 0, 'all lazy pre-step hooks are disposed')
})

test('R12: legacy block keeps active and terminal owner work executable', async () => {
  const f = guardFixture()
  f.guard.observe('owner', 'user/message', { createdAt: 2 })
  f.guard.observe('owner', 'turn/end', { reason: { kind: 'completed' } })
  f.mission.status = 'stopped'
  assert.equal(f.hooks.size, 0, 'there is no owner execution gate to release')
  f.guard.dispose()
})

test('R12: muted stopped questions do not retain the full owner role; completed questions do', () => {
  const mission = { id: 'm', status: 'stopped' }
  const scoper = Object.assign(Object.create(RoleScoper.prototype), {
    runtime: {
      isWorkerSession: () => false, starts: () => [], list: () => [mission],
      isMissionTerminal: () => true, openAsks: () => [{ id: 'question' }], store: { list: () => [] },
    }, handling: new Map(), applied: new Map(),
  })
  const owner = { id: 'owner', status: 'idle', session: { header: {} } }
  assert.equal(scoper.roleOf(owner), 'historical-owner')
  mission.status = 'completed'
  assert.equal(scoper.roleOf(owner), 'owner')
})

const quietRuntime = t => makeRuntime(t, {
  workers: new FakeWorkers({ async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) } }),
  config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100, checkTimeoutMs: undefined },
  budget: { maxTokens: 10000, maxSteps: 100, maxWorkers: 2, maxDurationMs: 3600000, maxTasks: 10 },
})

test('R12: owner can settle a receipt in paused, blocked and terminal missions without restarting work', async t => {
  const { dir: directory, runtime: rt, budget } = await quietRuntime(t)
  const owner = { sessionId: 'owner' }
  for (const status of ['paused', 'blocked', 'completed', 'stopped']) {
    const mission = rt.create(owner, { title: status, objective: 'Settle a receipt', workspace: directory, scope: ['**'], acceptance: ['answer'],
      budget: { ...budget } })
    const questionId = `question-${status}`
    rt.commit(mission.id, () => {
      const row = rt.mission(mission.id); row.status = status; rt.store.put('missions', row)
      rt.store.put('deliveries', { id: questionId, missionId: mission.id, from: 'retired-member', to: 'owner', kind: 'question',
        content: 'Which API?', createdAt: Date.now(), replyExpected: true, state: 'open' })
    })
    const result = rt.message(owner, mission.id, { to: 'retired-member', kind: 'question', replyTo: questionId, dismiss: true, content: 'No further work needed' })
    assert.equal(result.dismissed, questionId)
    assert.equal(rt.openAsks(mission.id, 'owner').length, 0)
    assert.equal(rt.mission(mission.id).status, status)
    assert.equal(rt.store.list('deliveries', mission.id).filter(row => row.to === 'retired-member').length, 0)
    assert.throws(() => rt.message(owner, mission.id, { to: 'retired-member', kind: 'question', content: 'New work' }))
  }
})

function refusalFixture() {
  let busy = true
  const admissions = new Map(), events = []
  const rt = makeRuntimeStub({
    commit: (_id, fn) => { if (busy) throw new WriterBusyError('busy', 2); return fn() },
    store: {
      get: (table, id) => table === 'missions' ? { id, status: 'active' } : admissions.get(id), list: () => [],
      recordAdmission: row => admissions.set(row.id, structuredClone(row)),
      event: (missionId, type, actor, data) => events.push({ missionId, type, actor, data }),
    }, fingerprint: () => 'stable', isMissionTerminal: () => false, noticeSubjectsFor: () => [], notify() {}, pumpOutbox() {},
  })
  return { rt, registry: new RefusalRegistry(rt), admissions, events, release: () => { busy = false } }
}

test('R12: writer recovery retains distinct refusals and flushes them only under their own mission', () => {
  const f = refusalFixture()
  const candidate = missionId => ({ missionId, taskId: `${missionId}-task`, memberId: 'member', taskClass: 'research', scope: '**', epoch: 1 })
  const decision = { reason: 'budget_exceeded', admitted: false, detail: 'budget' }
  f.registry.recordRefusal(candidate('a'), decision, 1)
  f.registry.recordRefusal(candidate('b'), decision, 1)
  f.registry.recordRefusal(candidate('a'), decision, 1)
  f.release()
  f.registry.recordWriterBusyRecovery({ id: 'a' })
  assert.deepEqual([...f.admissions.values()].map(row => [row.missionId, row.count]), [['a', 2]])
  f.registry.recordWriterBusyRecovery()
  assert.equal(f.admissions.size, 2)
  assert.equal([...f.admissions.values()].find(row => row.missionId === 'b').count, 1)
  f.registry.recordWriterBusyRecovery()
  assert.equal(f.events.length, 2, 'a drained recovery is not recorded twice')
})

test('R12: failed guard writes preserve their origin without manufacturing an admission', () => {
  const f = refusalFixture()
  emitGuardTerminal(f.rt, 'mission', 'attempt_lease', { taskId: 'task', memberId: 'member', detail: 'lease stop failed' })
  f.release()
  f.registry.recordWriterBusyRecovery()
  assert.equal(f.admissions.size, 0)
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].data.cause, 'guard-terminal-write-failed')
  assert.equal(f.events[0].data.chain, 'attempt_lease')
  assert.equal(f.events[0].data.taskId, 'task')
  assert.equal(f.events[0].data.ownerNotified, false)
})

test('R12: pending readiness requires a submitted source and an idle independent reviewer', () => {
  const source = { id: 'source', status: 'pending', assigneeId: 'author', priorOwnerIds: ['old-author'], dependencies: [] }
  const review = { id: 'review', status: 'pending', reviewOf: 'source', dependencies: [] }
  const members = [{ id: 'author', status: 'idle' }, { id: 'old-author', status: 'waiting' }, { id: 'reviewer', status: 'working' }]
  assert.equal(pendingReadiness([source, review], members).ready, 1, 'only the source can run')
  source.status = 'submitted'
  assert.equal(pendingReadiness([source, review], members).ready, 0)
  members[2].status = 'idle'
  assert.equal(pendingReadiness([source, review], members).ready, 1)
})

// Instrument self-test: the decision metric lives in tests/instruments.mjs since
// round 20, so this pins the audit instrument, not a production classifier.
test('R12 instrument: ordinary owner questions are excluded from the decision metric', async t => {
  const { dir: directory, runtime: rt, budget } = await quietRuntime(t)
  const owner = { sessionId: 'owner' }
  const mission = rt.create(owner, { title: 'Metrics', objective: 'Count decisions', workspace: directory, scope: ['**'], acceptance: ['accurate'],
    budget: { ...budget } })
  rt.commit(mission.id, () => {
    rt.store.put('deliveries', { id: 'ordinary-question', missionId: mission.id, from: 'member', to: 'owner', kind: 'question', content: 'API?', createdAt: 1, replyExpected: true })
  })
  assert.equal(wakePrecision(rt, mission.id).decisions.byFamily.unknown, undefined)
  assert.equal(wakePrecision(rt, mission.id).decisions.total, 0)
})

function stopFixture(reason, stop) {
  const mission = { id: 'mission', status: 'active' }
  // The fenced owner's row, already stopped: the adapter checkpoints it and the
  // release leaves it (and, on close-out, the task's assignee) as it is.
  const oldOwner = { id: 'old-owner', missionId: mission.id, status: 'stopped' }
  const rows = new Map([['task', { id: 'task', missionId: mission.id, epoch: 2, status: 'blocked', assigneeId: 'planned-new-owner', recoveryCount: 1,
    resumeAfterStop: { epoch: 2, memberId: 'old-owner', reason, at: Date.now() } }]])
  const pending = [], events = [], stopped = []
  const rt = makeRuntimeStub({
    config: { maxTasksPerMember: 10 }, shuttingDown: false,
    store: {
      list: table => table === 'tasks' ? [...rows.values()].map(row => structuredClone(row)) : [],
      get: (table, id) => table === 'missions' ? mission : table === 'tasks' ? structuredClone(rows.get(id))
        : table === 'members' && id === oldOwner.id ? structuredClone(oldOwner) : undefined,
      put: (table, row) => { if (table === 'tasks') rows.set(row.id, structuredClone(row)) },
      event: (_mission, type, _actor, data) => events.push({ type, data }),
    },
    workers: new FakeWorkers({ stop: async memberId => { stopped.push(memberId); await stop(stopped.length) } }),
    task: (_mission, id) => structuredClone(rows.get(id)), mission: () => mission,
    isMissionTerminal: value => ['stopped', 'completed'].includes(value.status),
    defer: fn => { pending.push(Promise.resolve().then(fn)) }, exclusive: (_id, fn) => fn(), commit: (_id, fn) => fn(),
    kick() {}, fingerprint: () => 'stable', noticeSubjectsFor: () => [], notify() {}, pumpOutbox() {},
  })
  return { mission, rows, pending, events, stopped, attempts: new Attempts(rt) }
}

for (const reason of ['lease-expired', 'worker-closeout', 'handoff']) test(`R12: ${reason} retries a rejected stop before re-pending without charging another recovery`, async () => {
  const f = stopFixture(reason, async count => { if (count === 1) throw new Error('temporary stop failure') })
  if (reason === 'handoff') f.rows.get('task').maxRecoveryAttempts = 1
  assert.equal(pendingStopOwner([...f.rows.values()], 'old-owner'), true)
  assert.equal(pendingStopOwner([...f.rows.values()], 'planned-new-owner'), false)
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    await f.attempts.recoverExpired(f.mission, 'mission')
    await Promise.all(f.pending)
    assert.equal(f.rows.get('task').status, 'blocked')
    await f.attempts.recoverExpired(f.mission, 'mission')
    assert.equal(f.stopped.length, 1, 'backoff prevents a hot retry loop')
    now += 1001
    await f.attempts.recoverExpired(f.mission, 'mission')
    await Promise.all(f.pending)
    assert.deepEqual(f.stopped, ['old-owner', 'old-owner'], 'stop targets the fenced owner, not the planned replacement')
    assert.equal(f.rows.get('task').status, 'pending')
    assert.equal(f.rows.get('task').resumeAfterStop, undefined)
    assert.equal(pendingStopOwner([...f.rows.values()], 'old-owner'), false)
    assert.equal(f.rows.get('task').recoveryCount, 1)
  } finally { Date.now = realNow }
})

test('R12: one in-flight stop cannot duplicate or resurrect a cancelled epoch', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = stopFixture('lease-expired', async () => gate)
  await f.attempts.recoverExpired(f.mission, 'mission')
  for (let i = 0; i < 5; i++) await f.attempts.recoverExpired(f.mission, 'mission')
  assert.equal(f.stopped.length, 1)
  const task = f.rows.get('task'); task.epoch++; task.status = 'cancelled'; delete task.resumeAfterStop
  release()
  await Promise.all(f.pending)
  assert.equal(f.rows.get('task').status, 'cancelled')
  assert.equal(f.events.some(event => event.type === 'task/quiescence-recovered'), false)
})

test('R12: a successful late stop does not resume a paused mission', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = stopFixture('lease-expired', async () => gate)
  await f.attempts.recoverExpired(f.mission, 'mission')
  f.mission.status = 'paused'
  release()
  await Promise.all(f.pending)
  assert.equal(f.mission.status, 'paused')
  assert.equal(f.rows.get('task').status, 'pending')
  assert.equal(f.rows.get('task').resumeAfterStop, undefined, 'confirmed shutdown can settle while the mission stays paused')
})

test('R12: cancellation before a deferred stop starts cannot stop a replacement handle', async () => {
  const f = stopFixture('lease-expired', async () => {})
  f.attempts.resumeStoppedAttempt('mission', structuredClone(f.rows.get('task')))
  const task = f.rows.get('task'); task.epoch++; task.status = 'cancelled'; delete task.resumeAfterStop
  await Promise.all(f.pending)
  assert.equal(f.stopped.length, 0)
})

test('R12: a stop whose recorded owner has no member row is refused, and the owner is given an exit that works', async t => {
  const { dir, runtime, budget } = await makeRuntime(t)
  await runtime.start()
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Ghost owner', objective: 'Refuse an unconfirmable stop', workspace: dir, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const work = { outputs: [], workstreamId: stream.id, title: 'Work', objective: 'Do the work', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test -d .'] }
  const task = runtime.propose(owner, mission.id, work)
  // The store never deletes a member, so the ghost owner is written onto the stop marker directly.
  const row = runtime.store.get('tasks', task.id)
  row.status = 'blocked'; row.epoch++
  row.resumeAfterStop = { epoch: row.epoch, memberId: 'member_ghost', reason: 'handoff', at: runtime.now() }
  runtime.store.transaction(() => runtime.store.put('tasks', row))
  runtime.attempts.resumeStoppedAttempt(mission.id, runtime.store.get('tasks', task.id))
  await runtime.settle(mission.id)
  const refused = runtime.store.events(mission.id, 500).filter(event => event.type === 'mission/stalled' && event.data.cause === 'worker-stop-failed')
  assert.equal(refused.length, 1, 'the stop is refused once')
  assert.equal(refused[0].data.deterministic, true, 'no retry can confirm a missing owner')
  assert.match(refused[0].data.reason, /member_ghost has no member row/)
  assert.equal(runtime.store.get('tasks', task.id).status, 'blocked')
  assert.ok(runtime.store.get('tasks', task.id).resumeAfterStop, 'nothing is released without a confirmed checkpoint')
  const notice = runtime.store.list('deliveries', mission.id).find(delivery => delivery.to === 'owner' && /member_ghost has no member row/.test(delivery.content))
  assert.ok(notice, 'the owner is told which owner is missing')
  assert.doesNotMatch(notice.content, /Repair the recorded workspace condition/, 'no advice a resume cannot satisfy')
  assert.match(notice.content, new RegExp(`swarm_cancel \\(taskId "${task.id}"\\).*replaces: \\["${task.id}"\\]`))
  // The named exit works: the task is withdrawn and its repair is admitted.
  runtime.cancel(owner, mission.id, { taskId: task.id, reason: 'The recorded stop owner is gone' })
  assert.deepEqual(runtime.propose(owner, mission.id, { ...work, replaces: [task.id] }).replaces, [task.id])
})
