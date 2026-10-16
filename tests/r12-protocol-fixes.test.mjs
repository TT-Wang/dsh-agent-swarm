import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { OwnerReplyGuard } from '../lib/owner-reply.js'
import { RoleScoper } from '../lib/roles.js'
import { RefusalRegistry, guardTerminalKey } from '../lib/refusals.js'
import { Notices } from '../lib/notices.js'
import { WriterBusyError } from '../lib/store.js'
import { Attempts } from '../lib/attempts.js'
import { pendingStopOwner } from '../lib/task-graph.js'
import { wakePrecision } from './instruments.mjs'
import { FakeClock, FakeWorkers, MISSION_ACCEPTANCE, makeRuntime, makeRuntimeStub, setup } from './faults/harness.mjs'
import { openAsks } from '../lib/arena.js'
import { dispatchable as dispatchableOf } from '../lib/board.js'

/** A stub `Notices.tell`: the record that exists only with the fact, in the stubs' pass-through transaction (the ledger is not modelled). */
function tell(_missionId, _content, _subjects, _options, then) { then?.(); return true }

function guardFixture() {
  const mission = { id: 'm', ownerSessionId: 'owner', status: 'active' }
  const question = { id: 'q', missionId: 'm', from: 'worker', to: 'owner', content: 'Choose an API', replyExpected: true, deliveredAt: 1 }
  const rt = makeRuntimeStub({
    store: { list: table => table === 'deliveries' ? [question] : [mission], get: table => table === 'missions' ? mission : question, put() {}, event() {} },
    commit: (_id, fn) => fn(), notices: { notify() {} }, boardOf: missionId => ({ missionId, tasks: [] }),
  })
  return { mission, question, rt, guard: new OwnerReplyGuard({ on: () => () => {} }, rt, { maxNudges: 2 }) }
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
  f.guard.dispose()
  f.guard.dispose()
})

test('R12: muted stopped questions do not retain the full owner role; completed questions do', () => {
  const mission = { id: 'm', status: 'stopped' }
  const scoper = Object.assign(Object.create(RoleScoper.prototype), {
    runtime: {
      isWorkerSession: () => false, starts: () => [], list: () => [mission],
      store: { list: table => table === 'deliveries' ? [{ id: 'question', to: 'owner', replyExpected: true }] : [] },
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
      budget: { ...budget } }, { grantRoot: directory, source: 'session' })
    const questionId = `question-${status}`
    rt.commit(mission.id, () => {
      const row = rt.mission(mission.id); row.status = status; rt.store.put('missions', row)
      rt.store.put('deliveries', { id: questionId, missionId: mission.id, from: 'retired-member', to: 'owner', kind: 'question',
        content: 'Which API?', createdAt: Date.now(), replyExpected: true, state: 'open' })
    })
    const result = rt.message(owner, mission.id, { to: 'retired-member', kind: 'question', replyTo: questionId, dismiss: true, content: 'No further work needed' })
    assert.equal(result.dismissed, questionId)
    assert.equal(openAsks(rt.store.list('deliveries', mission.id), 'owner').length, 0)
    assert.equal(rt.mission(mission.id).status, status)
    assert.equal(rt.store.list('deliveries', mission.id).filter(row => row.to === 'retired-member').length, 0)
    assert.throws(() => rt.message(owner, mission.id, { to: 'retired-member', kind: 'question', content: 'New work' }))
  }
})

/** A refusal registry on a kernel stub whose writer is busy until released, and the notices that queue a guard terminal on that one registry. */
function refusalFixture() {
  let busy = true
  const admissions = new Map(), events = []
  const kernel = makeRuntimeStub({
    commit: (_id, fn) => { if (busy) throw new WriterBusyError('busy', 2); return fn() },
    store: {
      get: (table, id) => table === 'missions' ? { id, status: 'active' } : admissions.get(id), list: () => [],
      recordAdmission: row => admissions.set(row.id, structuredClone(row)),
      event: (missionId, type, actor, data) => events.push({ missionId, type, actor, data }),
    }, boardOf: missionId => ({ missionId, tasks: [] }),
  })
  const registry = new RefusalRegistry(kernel)
  return { registry, notices: new Notices(kernel, registry, () => ({ passLive: false, wedged: false })), admissions, events, release: () => { busy = false } }
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
  f.notices.emitGuardTerminal('mission', 'attempt_lease', { taskId: 'task', memberId: 'member', detail: 'lease stop failed', localKey: 'stop:task' })
  f.release()
  f.registry.recordWriterBusyRecovery()
  assert.equal(f.admissions.size, 0)
  assert.equal(f.events.length, 1)
  assert.equal(f.events[0].data.cause, 'guard-terminal-write-failed')
  assert.equal(f.events[0].data.chain, 'attempt_lease')
  assert.equal(f.events[0].data.taskId, 'task')
  assert.equal(Object.hasOwn(f.events[0].data, 'noticeKey'), false, 'no row was written, so the record names none: its cause and chain name it')
  assert.equal(Object.hasOwn(f.events[0].data, 'ownerNotified'), false, 'the cause states the condition: no field restates what the ledger did')
})

test('a busy writer records each guard request it could not write: distinct openers of one chain are distinct records, and a repeat of one is counted on its record', () => {
  const f = refusalFixture()
  // One task and member, two facts that end the attempt chain; one ceiling chain under two limits.
  const failures = [
    ['attempt_lease', { taskId: 'task', memberId: 'member', detail: 'idle close-out abandoned attempt_1', localKey: 'closeout-abandoned:attempt_1' }],
    ['attempt_lease', { taskId: 'task', memberId: 'member', detail: 'idle close-out reached the recovery limit', localKey: 'recovery-exhausted:task@2' }],
    ['task_ceiling', { detail: 'mission task budget exhausted', localKey: 'task-budget:1' }],
    ['task_ceiling', { detail: 'mission experiment budget exhausted', localKey: 'experiment-budget:0' }],
    ['attempt_lease', { taskId: 'task', memberId: 'member', detail: 'idle close-out abandoned attempt_1', localKey: 'closeout-abandoned:attempt_1' }],
  ]
  for (const [chain, context] of failures) f.notices.emitGuardTerminal('mission', chain, context)
  f.release()
  f.registry.recordWriterBusyRecovery()
  assert.deepEqual(f.events.map(event => [event.data.cause, event.data.chain, event.data.taskId, event.data.count]), [
    ['guard-terminal-write-failed', 'attempt_lease', 'task', 2],
    ['guard-terminal-write-failed', 'attempt_lease', 'task', 1],
    ['guard-terminal-write-failed', 'task_ceiling', null, 1],
    ['guard-terminal-write-failed', 'task_ceiling', null, 1],
  ])
  f.registry.recordWriterBusyRecovery()
  assert.equal(f.events.length, 4, 'a drained record is not written twice')
})

test('a guard request a busy writer could not write is named by its cause and chain: once the chain fires again and writes it, exactly one stall event carries that row\'s key', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const context = { detail: 'mission task budget exhausted (1/1 tasks admitted)', localKey: 'task-budget:1' }
  f.runtime.commit = () => { throw new WriterBusyError('database is locked', 3) }
  f.runtime.notices.emitGuardTerminal(f.mission.id, 'task_ceiling', context)
  delete f.runtime.commit
  assert.equal(f.runtime.notices.refusals, f.runtime.refusals, 'one registry per runtime: the notices queue the refused request on the registry the tick drains')
  f.clock.advance(f.runtime.config.tickMs)
  await f.runtime.tick()
  const stalls = () => f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'mission/stalled').map(event => event.data)
  assert.deepEqual(stalls().map(data => [data.cause, data.chain]), [['guard-terminal-write-failed', 'task_ceiling']], 'the writer\'s refusal is recorded')
  f.runtime.notices.emitGuardTerminal(f.mission.id, 'task_ceiling', context)
  const requests = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.notice?.dedupKey.startsWith('guard-terminal:task_ceiling:'))
  assert.equal(requests.length, 1, 'the request is written once the writer is free')
  assert.deepEqual(stalls().filter(data => data.noticeKey === requests[0].notice.dedupKey).map(data => data.cause), ['guard-terminal'], 'one stall event names that row: the one written with it, never the record of the write that failed')
})

test('R12: a pending review is dispatchable only once its source is submitted, to an idle live member independent of it', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const busy = f.propose({ title: 'The reviewer\'s own work', assigneeId: f.reviewer.id })
  const working = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, busy.id)
  const source = f.propose({ title: 'Source' })
  const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Review', objective: 'Independent review',
    kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE })
  // The dispatchable set the owner instruments count and F(S) digests: the dispatcher's eligibility over idle or waiting members.
  const dispatchable = () => dispatchableOf(f.runtime.boardOf(f.mission.id)).map(task => task.id)
  assert.deepEqual(dispatchable(), [source.id], 'only the source can run')
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  assert.deepEqual(dispatchable(), [], 'the source\'s author may not review it, and the reviewer is working')
  await f.runtime.submit(f.actor(f.reviewer), f.mission.id, { taskId: busy.id, attemptId: working.attempt.id, output: 'done' })
  assert.deepEqual(dispatchable(), [review.id], 'the idle independent reviewer can run it')
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
  assert.deepEqual(dispatchable(), [], 'a stopped member runs nothing')
})

// Instrument self-test: the decision metric lives in tests/instruments.mjs since
// round 20, so this pins the audit instrument, not a production classifier.
test('R12 instrument: ordinary owner questions are excluded from the decision metric', async t => {
  const { dir: directory, runtime: rt, budget } = await quietRuntime(t)
  const owner = { sessionId: 'owner' }
  const mission = rt.create(owner, { title: 'Metrics', objective: 'Count decisions', workspace: directory, scope: ['**'], acceptance: ['accurate'],
    budget: { ...budget } }, { grantRoot: directory, source: 'session' })
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
    defer: fn => { pending.push(Promise.resolve().then(fn)) }, exclusive: (_id, fn) => fn(), commit: (_id, fn) => fn(),
    kick() {}, fingerprint: () => 'stable',
  })
  return { mission, rows, pending, events, stopped, attempts: new Attempts(rt, { emitGuardTerminal() {}, notify() {}, tell }) }
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
  const mission = runtime.create(owner, { title: 'Ghost owner', objective: 'Refuse an unconfirmable stop', workspace: dir, scope: ['src/'], acceptance: ['works'], budget }, { grantRoot: dir, source: 'session' })
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

test('R12: an unresolved legacy stop owner reserves every member, and a marker at an older epoch reserves none', () => {
  const blocked = (epoch, marker) => ({ id: 'task', status: 'blocked', epoch, resumeAfterStop: { reason: 'handoff', at: 1, ...marker } })
  assert.equal(pendingStopOwner([blocked(2, { epoch: 2 })], 'member_any'), true, 'a stop whose owner an older build never recorded reserves every member')
  assert.equal(pendingStopOwner([blocked(2, { epoch: 2, memberId: 'member_old' })], 'member_old'), true, 'a recorded owner waits for its own stop')
  assert.equal(pendingStopOwner([blocked(2, { epoch: 2, memberId: 'member_old' })], 'member_any'), false, 'and reserves no other member')
  assert.equal(pendingStopOwner([blocked(3, { epoch: 2 })], 'member_any'), false, 'a marker at an older epoch is no pending stop, even without an owner')
  assert.equal(pendingStopOwner([blocked(3, { epoch: 2, memberId: 'member_old' })], 'member_old'), false)
})

test('R12: each distinct stop failure at one epoch is its own decision, keyed by task, epoch, owner and the failure digest', async t => {
  class Workers extends FakeWorkers { fault; async stop(id) { this.stopped.push(id); if (this.fault !== undefined) throw this.fault } }
  const workers = new Workers()
  const clock = new FakeClock(1_700_000_000_000)
  const { dir, runtime, budget } = await makeRuntime(t, { workers, clock })
  await runtime.start()
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Stop faults', objective: 'Tell each stop failure once', workspace: dir, scope: ['src/'], acceptance: ['works'], budget }, { grantRoot: dir, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  await runtime.settle(mission.id)
  workers.fault = new Error('EBUSY: the handle is busy (first)')
  const task = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Work', objective: 'Do the work', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test -d .'] })
  const row = runtime.store.get('tasks', task.id)
  row.status = 'blocked'; row.epoch++
  row.resumeAfterStop = { epoch: row.epoch, memberId: member.id, reason: 'handoff', at: runtime.now() }
  runtime.store.transaction(() => runtime.store.put('tasks', row))
  const keyOf = message => `guard-terminal:attempt_lease:attempt_terminal:stop:${task.id}:${row.epoch}:${member.id}:${createHash('sha256').update(message).digest('hex')}`
  const told = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner' && /\[attempt_terminal\]/.test(delivery.content)).map(delivery => delivery.notice.dedupKey)
  const retry = async ms => { clock.advance(ms); await runtime.tick(); await runtime.settle(mission.id) }
  await retry(0)
  assert.deepEqual(told(), [keyOf('EBUSY: the handle is busy (first)')], 'the failed stop is told under its full key')
  await retry(1_000)
  assert.ok(workers.stopped.length >= 2, 'the stop was retried')
  assert.deepEqual(told(), [keyOf('EBUSY: the handle is busy (first)')], 'the same failure again is the same decision')
  workers.fault = new Error('EBUSY: the handle is busy (second)')
  await retry(2_000)
  assert.deepEqual(told(), [keyOf('EBUSY: the handle is busy (first)'), keyOf('EBUSY: the handle is busy (second)')], 'a different failure at the same epoch is a new decision')
  workers.fault = undefined
  await retry(4_000)
  assert.equal(runtime.store.get('tasks', task.id).resumeAfterStop, undefined, 'the confirmed stop clears the fence')
})
