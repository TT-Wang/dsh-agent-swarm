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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { OwnerReplyGuard } from '../lib/owner-reply.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

class SilentWorkers {
  deliveries = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push({ to: member.id, ...delivery }) }
  async stop() {}
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact() { return { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] } }
  async verifyArtifact() { return [{ command: 'test', exitCode: 0, output: 'ok' }] }
  async dispose() {}
}

/** A context stub: the guard only reads `on` (events) and `agents` (block mode). */
const fakeContext = () => ({ on: () => () => {}, agents: { get: () => undefined }, get: () => undefined })

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-owner-reply-'))
  const workers = new SilentWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
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
  guard.observe(f.owner.sessionId, 'turn/end')
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

  // Turn 2: still unanswered — the second nudge is the last one.
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 1000 })
  guard.observe(f.owner.sessionId, 'turn/end')
  assert.equal(f.events('owner/reply-missing').length, 2)
  assert.equal(f.runtime.store.get('deliveries', ask.id).replyNudges, 2)

  // Turn 3: the bound is spent, so the guard terminal reports the decision once.
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 2000 })
  guard.observe(f.owner.sessionId, 'turn/end')
  const terminal = f.events('mission/stalled').filter(event => event.data.cause === 'guard-terminal')
  assert.equal(terminal.length, 1, 'the guard terminal is the durable exit once nudging is spent')
  assert.equal(terminal[0].data.chain, 'owner_reply')
  assert.equal(terminal[0].data.code, 'owner_reply_missing')
  assert.equal(f.runtime.store.get('deliveries', ask.id).replyNudges, 2, 'a terminal does not spend another nudge')
  assert.equal(f.events('owner/reply-missing').length, 2, 'the durable miss record is bounded with the nudges')
  // Turn 4 with the same open receipt stays quiet: no further event, no duplicate terminal.
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 3000 })
  guard.observe(f.owner.sessionId, 'turn/end')
  assert.equal(f.events('owner/reply-missing').length, 2)
  assert.equal(f.events('mission/stalled').filter(event => event.data.cause === 'guard-terminal').length, 1)

  // The owner answers after the escalation: the receipt settles and the next turn is quiet.
  f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'target v2', replyTo: ask.id })
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() + 4000 })
  guard.observe(f.owner.sessionId, 'turn/end')
  assert.equal(f.events('owner/reply-missing').length, 2, 'a settled receipt is never reported again')
  assert.equal(f.runtime.openAsks(f.mission.id).length, 0)

  // L3: the owner observe view names the receipt and how to close it.
  const view = f.runtime.observe(f.owner, f.mission.id, {})
  assert.equal(view.openAsks.count, 0)
  assert.match(view.openAsks.note, /replyTo/)
})

test('L2: an answered turn is never nudged, and a repeated turn end is a no-op', async t => {
  const f = await fixture(t)
  const ask = await f.ask()
  const guard = new OwnerReplyGuard(fakeContext(), f.runtime, { guard: 'nudge', maxNudges: 2 })
  t.after(() => guard.dispose())
  guard.observe(f.owner.sessionId, 'user/message', { createdAt: Date.now() })
  f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'answered in-turn', replyTo: ask.id })
  guard.observe(f.owner.sessionId, 'turn/end')
  assert.equal(f.events('owner/reply-missing').length, 0, 'the turn settled the receipt, so nothing is missing')
  guard.observe(f.owner.sessionId, 'turn/end')
  assert.equal(f.events('owner/reply-missing').length, 0, 'an end without a booked turn reports nothing')
  assert.equal(f.runtime.store.get('deliveries', ask.id).replyNudges, undefined)
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
