/**
 * L0-L3: the owner-side reply protocol.
 *
 * A question is a receipt on a durable row. The worker side already had a silence
 * protocol; the owner side had none, so a question delivered into the owner's
 * conversation could be answered in prose and never reach the asker — the store
 * never saw the answer, and nothing said so.
 *
 * These tests pin the four layers:
 *  - L0 the delivery carries `replyExpected`/`state` and `openAsks` reads it back;
 *  - L1 `replyTo` (and `swarm_post(replyTo)`) bind an answer to the question, with
 *    refusals for ids this caller cannot settle, and an explicit dismiss exit;
 *  - L2 an owner turn that leaves a question open is recorded, nudged with the
 *    exact call, and escalated once the nudge bound is spent;
 *  - L3 the question envelope and the owner observe view carry the executable
 *    instruction and the open receipts.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { OwnerReplyGuard } from '../lib/owner-reply.js'
import { FakeClock, FakeWorkers, makeRuntime } from './faults/harness.mjs'

/** A context stub: the guard only reads `on` (events) and `agents` (block mode). */
const fakeContext = () => ({ on: () => () => {}, agents: { get: () => undefined }, get: () => undefined })

async function fixture(t, config = {}) {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, {
    workers: new FakeWorkers({ async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) } }),
    config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100, checkTimeoutMs: undefined, ...config },
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100 },
  })
  const owner = { sessionId: 'reply-owner' }
  const mission = runtime.create(owner, { title: 'Reply protocol', objective: 'Answer questions', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Asker', role: 'implementation' })
  const asker = { sessionId: member.sessionId }
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  const deliveries = () => runtime.store.list('deliveries', mission.id)
  /** Ask the owner a question and deliver it, so the receipt has a delivery time. */
  async function ask(content = 'Which API version should I target?') {
    const queued = runtime.message(asker, mission.id, { to: 'owner', kind: 'question', content })
    assert.equal(queued.queued, true)
    await runtime.flushOutbox(mission.id)
    const delivery = deliveries().filter(item => item.from === member.id && item.to === 'owner').at(-1)
    assert.ok(delivery, 'the question reached the owner outbox')
    assert.equal(delivery.deliveredAt === undefined, false, 'the question is delivered, so it has a delivery time')
    return delivery
  }
  return { directory, runtime, workers, owner, mission, member, asker, events, deliveries, ask }
}

test('L0/L1: a question stays open until its recipient binds an answer, once', async t => {
  const f = await fixture(t)
  const ask = await f.ask()
  assert.equal(ask.replyExpected, true, 'a question is a receipt')
  assert.equal(ask.state, 'open')
  assert.equal(f.runtime.openAsks(f.mission.id, 'owner').map(d => d.id).join(), ask.id)
  assert.match(ask.content, /\[swarm receipt required\]/, 'L3: the envelope carries the receipt requirement')
  assert.match(ask.content, new RegExp(`replyTo: "${ask.id}"`), 'and the exact call that answers it')
  assert.match(ask.content, /Text in this conversation is NOT delivered to the member/)

  const answered = f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'target v2', replyTo: ask.id })
  assert.equal(answered.answered, ask.id)
  const receipt = f.runtime.store.get('deliveries', ask.id)
  assert.equal(receipt.state, 'answered')
  assert.equal(receipt.answeredBy, 'owner')
  const answer = f.deliveries().find(item => item.inReplyTo === ask.id)
  assert.ok(answer, 'the answer names the question it settles')
  assert.equal(f.runtime.openAsks(f.mission.id).length, 0, 'the receipt is settled')
  assert.equal(f.events('message/answered').length, 1)
  // Idempotent: a repeated answer is delivered, but settles and records nothing twice.
  f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'target v2 again', replyTo: ask.id })
  assert.equal(f.events('message/answered').length, 1, 'one question, one receipt event')
  assert.equal(f.runtime.store.get('deliveries', ask.id).answeredBy, 'owner')

  // A deliberate close is its own state, and it also settles the receipt.
  const second = await f.ask('Do you want the migration note too?')
  const dismissed = f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'not needed', replyTo: second.id, dismiss: true })
  assert.equal(dismissed.queued, false, 'a dismissal sends no message')
  assert.equal(dismissed.dismissed, second.id)
  assert.equal(f.runtime.store.get('deliveries', second.id).state, 'dismissed')
  assert.equal(f.events('message/dismissed').length, 1)
  assert.equal(f.runtime.openAsks(f.mission.id).length, 0)
})

test('L1: a receipt can only be settled by its recipient, on a question, by a real id', async t => {
  const f = await fixture(t)
  const ask = await f.ask()
  const other = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Bystander', role: 'research' })
  assert.throws(() => f.runtime.message({ sessionId: other.sessionId }, f.mission.id, { to: 'owner', kind: 'question', content: 'me too', replyTo: ask.id }),
    /\[reply_target_not_recipient\]/, 'a third party cannot answer a question addressed to the owner')
  // A finding is not a question, so it carries no receipt to settle.
  const finding = f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'finding', content: 'fyi' })
  assert.equal(finding.queued, true)
  const findingDelivery = f.deliveries().find(item => item.from === 'owner' && item.kind === 'finding')
  assert.equal(findingDelivery.replyExpected, undefined, 'only a question opens a receipt')
  assert.throws(() => f.runtime.message(f.member ? f.owner : f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'x', replyTo: findingDelivery.id }),
    /\[reply_target_not_question\]/, 'a finding has no receipt to settle')
  assert.throws(() => f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'x', replyTo: 'msg_unknown' }),
    /\[unknown_reply_target\]/, 'an id from nowhere is refused rather than guessed')
  assert.throws(() => f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'x', dismiss: true }),
    /\[reply_target_required\]/, 'dismiss without a target says what to pass instead')
  // A reply that answers a question is not itself a new receipt.
  const answered = f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'v2', replyTo: ask.id })
  assert.equal(answered.answered, ask.id)
  assert.equal(f.deliveries().filter(item => item.replyExpected === true).length, 1, 'the answer opened no second receipt')
  assert.equal(f.runtime.openAsks(f.mission.id).length, 0, 'every refused call left the receipt untouched, and the answer settled it')
})

test('L1: a board post may settle a receipt, and a post reply still means a post', async t => {
  const f = await fixture(t)
  const ask = await f.ask()
  const post = f.runtime.post(f.owner, f.mission.id, { kind: 'ANSWER', body: 'target v2', replyTo: ask.id })
  assert.equal(f.runtime.store.get('deliveries', ask.id).answeredBy, 'owner')
  assert.equal(f.runtime.openAsks(f.mission.id).length, 0)
  assert.equal(post.replyTo, ask.id, 'the post keeps the link to the question it answered')
  const parent = f.runtime.post(f.owner, f.mission.id, { kind: 'IDEA', body: 'parent' })
  const child = f.runtime.post(f.owner, f.mission.id, { kind: 'ANSWER', body: 'child', replyTo: parent.id })
  assert.equal(child.replyTo, parent.id, 'a post reply keeps its board meaning')
})

test('L2/L3: an owner turn that leaves a question open is recorded, nudged with the call, then escalated', async t => {
  const f = await fixture(t)
  const ask = await f.ask('Which API version should I target?')
  const guard = new OwnerReplyGuard(fakeContext(), f.runtime, { guard: 'nudge', maxNudges: 2 })
  t.after(() => guard.dispose())

  // Turn 1: the owner reads the question and ends the turn without the call.
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() })
  guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  const missing = f.events('owner/reply-missing')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].data.deliveryId, ask.id)
  assert.equal(missing[0].data.memberId, f.member.id)
  assert.equal(f.runtime.store.get('deliveries', ask.id).replyNudges, 1, 'the nudge is durable, not in-memory')
  const nudge = f.deliveries().filter(item => item.to === 'owner' && item.notice?.dedupKey?.startsWith('owner-reply-missing:'))
  assert.equal(nudge.length, 1)
  assert.match(nudge[0].content, /\[owner_reply_missing\]/)
  assert.match(nudge[0].content, new RegExp(`replyTo: "${ask.id}"`), 'the nudge carries the exact call')
  assert.match(nudge[0].content, /only that call writes the receipt/)
  assert.equal(f.runtime.openAsks(f.mission.id, 'owner').length, 1, 'the receipt is still open')
  await f.runtime.flushOutbox(f.mission.id)
  assert.ok(f.runtime.store.get('deliveries', nudge[0].id).deliveredAt, 'the first nudge reached transport')

  // Turn 2: still unanswered — the second nudge is the last one.
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 1000 })
  guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(f.events('owner/reply-missing').length, 2)
  assert.equal(f.runtime.store.get('deliveries', ask.id).replyNudges, 2)
  const secondNudge = f.deliveries().find(item => item.to === 'owner'
    && item.notice?.dedupKey?.startsWith('owner-reply-missing:') && item.id !== nudge[0].id)
  assert.ok(secondNudge, 'the second unanswered turn creates the next wake instead of deduping it away')
  assert.match(secondNudge.content, /nudge 2 of 2/)
  await f.runtime.flushOutbox(f.mission.id)
  assert.ok(f.runtime.store.get('deliveries', secondNudge.id).deliveredAt)

  // Turn 3: the bound is spent, so the guard terminal reports the decision once.
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 2000 })
  guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  const terminal = f.events('mission/stalled').filter(event => event.data.cause === 'guard-terminal')
  assert.equal(terminal.length, 1, 'the guard terminal is the durable exit once nudging is spent')
  assert.equal(terminal[0].data.chain, 'owner_reply')
  assert.equal(terminal[0].data.code, 'owner_reply_missing')
  assert.equal(f.runtime.store.get('deliveries', ask.id).replyNudges, 2, 'a terminal does not spend another nudge')
  assert.equal(f.events('owner/reply-missing').length, 2, 'the durable miss record is bounded with the nudges')
  // Turn 4 with the same open receipt stays quiet: no further event, no duplicate terminal.
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 3000 })
  guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(f.events('owner/reply-missing').length, 2)
  assert.equal(f.events('mission/stalled').filter(event => event.data.cause === 'guard-terminal').length, 1)

  // The owner answers after the escalation: the receipt settles and the next turn is quiet.
  f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'target v2', replyTo: ask.id })
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 4000 })
  guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(f.events('owner/reply-missing').length, 2, 'a settled receipt is never reported again')
  assert.equal(f.runtime.openAsks(f.mission.id).length, 0)

  // L3: the owner observe view names the receipt and how to close it.
  const view = f.runtime.observe(f.owner, f.mission.id, {})
  assert.equal(view.openAsks.count, 0)
  assert.match(view.openAsks.note, /replyTo/)
})

test('L2: the turn boundary and the consumption stamp are on the runtime clock, so a clock ahead of the host still nudges', async t => {
  // The guard booked a question only when its runtime-clock deliveredAt was at or
  // before the host's user/message createdAt, and stamped consumedAt with that
  // host time. With the runtime clock ten minutes ahead of the host, an
  // unanswered owner question was never booked, so it was never nudged.
  const clock = new FakeClock(Date.now() + 600_000)
  const f = await fixture(t, { now: clock.now })
  const ask = await f.ask()
  const guard = new OwnerReplyGuard(fakeContext(), f.runtime, { guard: 'nudge', maxNudges: 2 })
  t.after(() => guard.dispose())
  clock.advance(1_000)
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() })
  guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.deepEqual(f.events('owner/reply-missing').map(event => event.data.deliveryId), [ask.id], 'the unanswered question is booked and recorded')
  f.runtime.pumpOutbox = () => {}
  f.runtime.message(f.asker, f.mission.id, { to: 'owner', kind: 'question', content: 'And the schema version?' })
  const consumed = f.deliveries().filter(row => row.replyExpected && row.id !== ask.id).at(-1)
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now(), source: { kind: 'swarm', deliveryId: consumed.id } })
  assert.equal(f.runtime.store.get('deliveries', consumed.id).consumedAt, clock.now(), 'consumption is stamped on the runtime clock')
})

test('L2: an answered turn is never nudged, and a repeated turn end is a no-op', async t => {
  const f = await fixture(t)
  const ask = await f.ask()
  const guard = new OwnerReplyGuard(fakeContext(), f.runtime, { guard: 'nudge', maxNudges: 2 })
  t.after(() => guard.dispose())
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() })
  f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'answered in-turn', replyTo: ask.id })
  guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(f.events('owner/reply-missing').length, 0, 'the turn settled the receipt, so nothing is missing')
  guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(f.events('owner/reply-missing').length, 0, 'an end without a booked turn reports nothing')
  assert.equal(f.runtime.store.get('deliveries', ask.id).replyNudges, undefined)
})

test('L2: replacing the guard resumes the durable nudge ordinal and reaches escalation', async t => {
  const f = await fixture(t)
  const ask = await f.ask()
  const first = new OwnerReplyGuard(fakeContext(), f.runtime, { guard: 'nudge', maxNudges: 2 })
  first.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 1000 })
  first.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  await f.runtime.flushOutbox(f.mission.id)
  first.dispose()
  const replacement = new OwnerReplyGuard(fakeContext(), f.runtime, { guard: 'nudge', maxNudges: 2 })
  t.after(() => replacement.dispose())
  replacement.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 2000 })
  replacement.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  replacement.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  const nudges = f.deliveries().filter(row => row.notice?.dedupKey?.startsWith(`owner-reply-missing:${ask.id}`))
  assert.equal(nudges.length, 2, 'guard state loss does not repeat or swallow a recovery ordinal')
  assert.equal(new Set(nudges.map(row => row.notice.dedupKey)).size, 2)
  await f.runtime.flushOutbox(f.mission.id)
  replacement.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 3000 })
  replacement.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(f.events('mission/stalled').filter(event => event.data.cause === 'guard-terminal').length, 1)
  assert.equal(f.runtime.store.get('deliveries', ask.id).replyNudges, 2)
})

test('L2: an outbox write failure does not spend a nudge without retaining its wake', async t => {
  const f = await fixture(t)
  const ask = await f.ask()
  const guard = new OwnerReplyGuard(fakeContext(), f.runtime, { guard: 'nudge', maxNudges: 2 })
  t.after(() => guard.dispose())
  const original = f.runtime.store.put.bind(f.runtime.store)
  let injected = false
  f.runtime.store.put = (table, row) => {
    if (table === 'deliveries' && row.notice?.dedupKey?.startsWith('owner-reply-missing:')) {
      injected = true
      throw new Error('injected outbox write failure')
    }
    return original(table, row)
  }
  try {
    guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 1000 })
    assert.throws(() => guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } }), /injected outbox write failure/)
  } finally { f.runtime.store.put = original }
  assert.ok(injected)
  assert.equal(f.runtime.store.get('deliveries', ask.id).replyNudges, undefined)
  assert.equal(f.events('owner/reply-missing').length, 0)
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 2000 })
  guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(f.runtime.store.get('deliveries', ask.id).replyNudges, 1)
  assert.equal(f.deliveries().filter(row => row.notice?.dedupKey?.startsWith('owner-reply-missing:')).length, 1)
})

test('L2/L3: a stopped asker does not hide the open receipt the owner still owes', async t => {
  const f = await fixture(t)
  const ask = await f.ask()
  // Stop the asker the way the runtime does: the member row's status is the fact
  // every dispatch, admission and receipt path reads.
  const row = f.runtime.store.get('members', f.member.id)
  row.status = 'stopped'
  f.runtime.store.put('members', row)
  assert.equal(f.runtime.openAsks(f.mission.id, 'owner').length, 1, 'a stopped asker leaves the receipt open')
  const view = f.runtime.observe(f.owner, f.mission.id, {})
  assert.equal(view.openAsks.count, 1)
  assert.equal(view.openAsks.asks[0].deliveryId, ask.id)
  assert.equal(view.openAsks.asks[0].from, f.member.id)
})


test('owner receipt books actual consumption before transport acknowledgement and survives context messages', async t => {
  const f = await fixture(t)
  f.runtime.pumpOutbox = () => {}
  f.runtime.message(f.asker, f.mission.id, { to: 'owner', kind: 'question', content: 'Which version?' })
  const question = f.deliveries().find(row => row.replyExpected)
  const guard = new OwnerReplyGuard(fakeContext(), f.runtime, { guard: 'nudge', maxNudges: 1 })
  t.after(() => guard.dispose())
  assert.equal(question.deliveredAt, undefined)
  guard.observe(f.owner.sessionId, 'user/message', { source: { kind: 'swarm', deliveryId: question.id } })
  guard.observe(f.owner.sessionId, 'user/message', { source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } })
  guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(f.events('owner/reply-missing').length, 1)
  assert.equal(f.events('owner/reply-missing')[0].data.deliveredAt, null)
  assert.ok(f.events('owner/reply-missing')[0].data.consumedAt)
  assert.ok(f.runtime.store.get('deliveries', question.id).consumedAt)
  assert.equal(f.runtime.store.get('deliveries', question.id).deliveredAt, undefined, 'consumption never forges a transport acknowledgement')
})

for (const summarized of [false, true]) test(`answered receipts invalidate queued nudges and terminal escalation${summarized ? ' within a wake summary' : ''}`, async t => {
  const f = await fixture(t)
  f.runtime.pumpOutbox = () => {}
  const question = await f.ask()
  if (summarized) {
    f.runtime.notices.wakeBudget = 1
    f.runtime.commit(f.mission.id, () => f.runtime.notify(f.mission.id, 'first fact', [`mission:${f.mission.id}`]))
  }
  const guard = new OwnerReplyGuard(fakeContext(), f.runtime, { guard: 'nudge', maxNudges: 1 })
  t.after(() => guard.dispose())
  for (let i = 0; i < 2; i++) {
    guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 1000 })
    guard.observe(f.owner.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  }
  const reminders = f.deliveries().filter(row => row.notice?.questionId === question.id || row.notice?.aggregatedFacts?.some(fact => fact.questionId === question.id))
  assert.ok(reminders.length)
  assert.ok(reminders.every(row => f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), row)))
  f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'v2', replyTo: question.id })
  assert.ok(reminders.every(row => !f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), row)))
  await f.runtime.flushOutbox(f.mission.id)
  assert.ok(reminders.every(row => !f.workers.deliveries.some(sent => sent.id === row.id)), 'no answered reminder reaches transport')
})


test('pre-upgrade receipt nudges expire by their existing structured question key', async t => {
  const f = await fixture(t)
  f.runtime.pumpOutbox = () => {}
  const question = await f.ask()
  f.runtime.commit(f.mission.id, () => f.runtime.notify(f.mission.id, 'legacy nudge', [`mission:${f.mission.id}`], { dedupKey: `owner-reply-missing:${question.id}:1` }))
  const nudge = f.deliveries().find(row => row.notice?.dedupKey === `owner-reply-missing:${question.id}:1`)
  assert.equal(nudge.notice.questionId, undefined)
  assert.equal(f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), nudge), true)
  f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'v2', replyTo: question.id })
  assert.equal(f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), nudge), false)
})
