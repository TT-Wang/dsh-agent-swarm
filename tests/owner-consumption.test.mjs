/**
 * One durable field records that the owner session admitted an owner-addressed
 * delivery: `Delivery.consumedAt`. Its one writer is `Notices.recordConsumption`,
 * driven by the host's admitted `user/message`, for an owner notice and an owner
 * question alike. The owner-reply guard hears the same message and only reads
 * the field; the notice ledger reads it as the delivery's own field.
 *
 * A store an earlier build wrote recorded a notice's consumption on its notice
 * envelope (`notice.consumedAt`, with `consumptionSource`). Opening it moves that
 * fact onto the delivery once, as the schema 5 upgrade, in the opening
 * transaction and on a restored older snapshot alike; nothing reads the old field.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { SwarmStore } from '../lib/store.js'
import { OwnerReplyGuard } from '../lib/owner-reply.js'
import { noticeLedger } from '../lib/arena.js'
import { FakeClock, FakeWorkers, SwarmRuntime, makeRuntime } from './faults/harness.mjs'

/** A started runtime whose adapter carries one host context, as production's does: the notices subscribe to it at start. */
async function hosted(t) {
  const ctx = new Context(), clock = new FakeClock()
  const workers = new FakeWorkers({ ctx, async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) } })
  const { dir, runtime, budget } = await makeRuntime(t, { workers, clock, config: { maxTasksPerMember: 100 } })
  await runtime.start()
  const owner = { sessionId: 'consumption-owner' }
  const mission = runtime.create(owner, { title: 'Consumption', objective: 'Record what the owner admitted', workspace: dir, scope: ['src/'], acceptance: ['works'], budget }, { grantRoot: dir, source: 'session' })
  runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Asker', role: 'implementation' })
  await runtime.settle(mission.id)
  const row = id => runtime.store.get('deliveries', id)
  const latest = predicate => runtime.store.list('deliveries', mission.id).filter(predicate).at(-1)
  /** The host admits the delivery into `sessionId`'s model context: one session event every subscriber hears. */
  const admit = (sessionId, deliveryId) => ctx.emit('session/event', { header: { id: sessionId } }, { type: 'user/message', data: { source: { kind: 'swarm', deliveryId } } })
  const endTurn = () => ctx.emit('session/event', { header: { id: owner.sessionId } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const notice = async content => {
    runtime.commit(mission.id, () => runtime.notices.notify(mission.id, content, [`mission:${mission.id}`], { dedupKey: content }))
    await runtime.notices.flushOutbox(mission.id)
    return latest(delivery => delivery.notice?.dedupKey === content)
  }
  const question = async content => {
    runtime.message({ sessionId: member.sessionId }, mission.id, { to: 'owner', kind: 'question', content })
    await runtime.notices.flushOutbox(mission.id)
    return latest(delivery => delivery.replyExpected === true && delivery.to === 'owner')
  }
  return { ctx, clock, runtime, owner, mission, member, row, latest, admit, endTurn, notice, question }
}

test('the owner session\'s admission records consumption on the delivery itself, for a notice and a question alike, once and on the runtime clock', async t => {
  const f = await hosted(t)
  const notice = await f.notice('consumption probe')
  const question = await f.question('Which API version?')
  f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'Which branch?' })
  const toMember = f.latest(delivery => delivery.to === f.member.id && delivery.kind === 'question')
  assert.ok(notice.deliveredAt !== undefined && question.deliveredAt !== undefined && toMember !== undefined)
  f.clock.advance(1_000)
  // Admission into any other session, or of a delivery addressed to a member, is not the owner consuming it.
  f.admit('another-session', notice.id)
  f.admit(f.member.sessionId, toMember.id)
  f.admit(f.owner.sessionId, toMember.id)
  assert.deepEqual([notice, question, toMember].map(delivery => f.row(delivery.id).consumedAt), [undefined, undefined, undefined])
  f.admit(f.owner.sessionId, notice.id)
  f.admit(f.owner.sessionId, question.id)
  const consumedAt = f.clock.now()
  for (const delivery of [notice, question]) {
    const row = f.row(delivery.id)
    assert.equal(row.consumedAt, consumedAt, `${delivery.kind}: the admission instant on the runtime clock, recorded on the delivery`)
    assert.notEqual(row.consumedAt, row.deliveredAt, 'consumed is its own fact, never the transport timestamp')
  }
  assert.deepEqual(Object.keys(f.row(notice.id).notice).filter(key => key.startsWith('consum')), [], 'the notice envelope holds no second copy of the fact')
  // A replayed admission cannot move it (compare-and-swap).
  f.clock.advance(1_000)
  f.admit(f.owner.sessionId, notice.id)
  f.admit(f.owner.sessionId, question.id)
  assert.deepEqual([f.row(notice.id).consumedAt, f.row(question.id).consumedAt], [consumedAt, consumedAt])
  assert.equal(f.runtime.observe(f.owner, f.mission.id, { detail: 'full' }).noticeLedger.find(entry => entry.deliveryId === notice.id).consumedAt, consumedAt, 'the ledger reads the delivery\'s field')
})

test('the owner-reply guard reads consumption and never writes it: its turn books the admitted question, and its miss record reads the one field', async t => {
  const f = await hosted(t)
  const guard = new OwnerReplyGuard(f.ctx, f.runtime, { maxNudges: 2 })
  t.after(() => guard.dispose())
  const question = await f.question('Which API version?')
  f.clock.advance(1_000)
  f.admit(f.owner.sessionId, question.id)
  const consumedAt = f.clock.now()
  f.clock.advance(1_000)
  f.endTurn()
  const missing = f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'owner/reply-missing')
  assert.deepEqual(missing.map(event => [event.data.deliveryId, event.data.consumedAt]), [[question.id, consumedAt]], 'the miss records the consumption the notices wrote')
  // A guard that hears the admission while the notices do not records no consumption of its own: it still books the
  // question the message carries, and its miss record states what the one field holds.
  const solo = new OwnerReplyGuard(new Context(), f.runtime, { maxNudges: 2 })
  t.after(() => solo.dispose())
  const second = await f.question('And the schema version?')
  solo.observe(f.owner.sessionId, 'user/message', { source: { kind: 'swarm', deliveryId: second.id } })
  solo.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(f.row(second.id).consumedAt, undefined, 'the guard is no writer of consumption')
  const booked = f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'owner/reply-missing' && event.data.deliveryId === second.id)
  assert.deepEqual(booked.map(event => event.data.consumedAt), [null], 'the admitted question is booked, and its miss states no consumption the store does not hold')
})

// Rows as a v4 build wrote them: a consumed notice carries its consumption on the notice envelope, beside the signal that
// recorded it; a consumed owner question carries it on the delivery; a task holds a criterion's text as its own.
const v4Mission = { id: 'm', ownerSessionId: 'owner', workspace: '/repo', title: 'm', objective: 'm', scope: ['**'], acceptance: ['a1'], status: 'active',
  budget: { maxTokens: 1000, maxSteps: 10, maxWorkers: 1, maxDurationMs: 60000, maxTasks: 5 }, usedTokens: 0, usedSteps: 0, createdAt: 1, updatedAt: 1, deadline: 9e15 }
const v4Task = { id: 't', missionId: 'm', workstreamId: 's', title: 't', objective: 't', kind: 'research', status: 'pending', dependencies: [], scope: ['**'], acceptance: ['a1'], checks: [], priority: 50, experiment: false, epoch: 0, evidenceIds: [], createdAt: 1 }
const envelope = dedupKey => ({ dedupKey, class: 'decision', sentAt: 10, queuedAt: 10, handoffAt: 11, subjects: ['mission:m'], trigger: 'probe', reason: 'probe' })
const consumedNotice = { id: 'n1', missionId: 'm', from: 'runtime', to: 'owner', kind: 'control', content: 'consumed', createdAt: 10, deliveredAt: 12,
  notice: { ...envelope('probe:1'), consumedAt: 111, consumptionSource: 'user/message' } }
const unconsumedNotice = { id: 'n2', missionId: 'm', from: 'runtime', to: 'owner', kind: 'control', content: 'unread', createdAt: 10, deliveredAt: 12, notice: envelope('probe:2') }
const consumedQuestion = { id: 'q1', missionId: 'm', from: 'member', to: 'owner', kind: 'question', content: 'Which?', createdAt: 10, deliveredAt: 12, consumedAt: 222, replyExpected: true, state: 'open' }
function writeV4(path, version = 4) {
  const db = new DatabaseSync(path)
  const insert = (table, row) => db.prepare(`INSERT INTO ${table}(id,mission_id,value) VALUES(?,?,?)`).run(row.id, row.missionId ?? row.id, JSON.stringify(row))
  insert('missions', v4Mission)
  insert('tasks', v4Task)
  for (const row of [consumedNotice, unconsumedNotice, consumedQuestion]) insert('deliveries', row)
  db.exec(`PRAGMA user_version=${version}`)
  db.close()
}
const revisionOf = path => { const db = new DatabaseSync(path, { readOnly: true }); try { return Number(db.prepare('SELECT revision FROM state_revision WHERE id=1').get().revision) } finally { db.close() } }
const versionOf = path => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('PRAGMA user_version').get().user_version } finally { db.close() } }

test('a v4 store\'s notice consumption moves onto its delivery once, at open, in one recorded change; a restored v4 snapshot upgrades the same way', async t => {
  const { dir, config, runtime } = await makeRuntime(t)
  await runtime.dispose()
  writeV4(config.statePath)
  copyFileSync(config.statePath, join(dir, 'v4.sqlite'))
  const before = revisionOf(config.statePath)
  const opened = new SwarmRuntime(config, new FakeWorkers())
  t.after(() => opened.dispose())
  const { consumedAt: _moved, consumptionSource: _dropped, ...moved } = consumedNotice.notice
  assert.deepEqual(opened.store.get('deliveries', 'n1'), { ...consumedNotice, notice: moved, consumedAt: 111 }, 'the fact moves onto the delivery and the signal that recorded it is dropped')
  assert.deepEqual([opened.store.get('deliveries', 'n2'), opened.store.get('deliveries', 'q1')], [unconsumedNotice, consumedQuestion], 'an unconsumed notice and a question already on the field are untouched')
  assert.deepEqual(opened.store.get('tasks', 't'), v4Task, 'the v4 upgrade does not run again: a v4 task\'s own text stays its own')
  assert.equal(noticeLedger(opened.store.list('deliveries', 'm')).find(entry => entry.deliveryId === 'n1').consumedAt, 111, 'the ledger reads the moved fact')
  assert.equal(opened.notices.recordConsumption('owner', 'n1'), false, 'the moved fact is the fact: a later admission cannot move it')
  assert.equal(opened.store.revision(), before + 1, 'the upgrade is one change')
  assert.deepEqual(opened.store.changesSince(before).map(change => change.scopes), [['m']], 'naming the mission whose delivery it rewrote')
  assert.equal(versionOf(config.statePath), 5)
  await opened.dispose()
  // Once: a v5 store is not upgraded again. A row that still held the old field (only an older build writes one) is left as it is, and nothing is written.
  const db = new DatabaseSync(config.statePath)
  db.prepare('UPDATE deliveries SET value=? WHERE id=?').run(JSON.stringify(consumedNotice), 'n1')
  db.close()
  const revision = revisionOf(config.statePath)
  const reopened = new SwarmRuntime(config, new FakeWorkers())
  t.after(() => reopened.dispose())
  assert.deepEqual([reopened.store.get('deliveries', 'n1'), reopened.store.revision()], [consumedNotice, revision], 'reopening rewrites nothing and moves no state revision')
  await reopened.dispose()
  // Restoring a v4 snapshot, or an unversioned one, upgrades it the same way.
  for (const version of [4, 0]) {
    const snapshot = join(dir, `v${version}.sqlite`)
    if (version === 0) { copyFileSync(join(dir, 'v4.sqlite'), snapshot); const legacy = new DatabaseSync(snapshot); legacy.exec('PRAGMA user_version=0'); legacy.close() }
    SwarmStore.restore(config.statePath, snapshot)
    const restored = new SwarmRuntime(config, new FakeWorkers())
    const row = restored.store.get('deliveries', 'n1')
    assert.deepEqual([row.consumedAt, Object.hasOwn(row.notice, 'consumedAt'), Object.hasOwn(row.notice, 'consumptionSource')], [111, false, false], `v${version}`)
    await restored.dispose()
  }
  // A store from a later schema fails closed, as a v4 build refuses this one.
  const future = new DatabaseSync(config.statePath); future.exec('PRAGMA user_version=6'); future.close()
  assert.throws(() => new SwarmRuntime(config, new FakeWorkers()), /Unsupported swarm schema 6; expected 5/)
})
