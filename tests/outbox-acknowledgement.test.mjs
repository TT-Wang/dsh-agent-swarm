import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { tempDirectory } from './temp-root.mjs'

async function fixture(t, config = {}) {
  const directory = await tempDirectory('swarm-outbox-ack-')
  const workers = {
    sent: [], intercept: async () => {}, bind() {},
    async prepareWorkspace(_mission, memberId) { return join(directory, memberId) },
    async start() {}, async stop() {}, async dispose() {}, isIdle() { return false },
    async deliver(member, delivery) {
      this.sent.push(structuredClone(delivery))
      await this.intercept(member, delivery)
    },
  }
  const runtime = new SwarmRuntime({ statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000,
    tickMs: 60000, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100, ...config }, workers)
  // Drive the real outbox at a controlled adapter boundary, without a competing pump.
  runtime.pumpOutbox = () => {}
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'ack-owner' }
  const mission = runtime.create(owner, { title: 'Outbox acknowledgement', objective: 'Preserve concurrent decisions',
    workspace: directory, scope: ['**'], acceptance: ['preserved'],
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 } })
  const member = await runtime.addMember(owner, mission.id, { name: 'Asker', role: 'implementation' })
  const rows = () => runtime.store.list('deliveries', mission.id)
  const emit = key => {
    runtime.commit(mission.id, () => runtime.notify(mission.id, key, [`mission:${mission.id}`], { dedupKey: key }))
    return rows().find(row => row.notice?.dedupKey === key)
  }
  return { runtime, workers, owner, mission, member, rows, emit }
}

for (const action of ['stop', 'pause']) {
  test(`outbox acknowledgement preserves ${action} during a starved delivery retry`, async t => {
    const f = await fixture(t)
    const first = f.emit('first')
    const second = f.emit('second')
    const mission = f.runtime.mission(f.mission.id)
    mission.outboxStarved = { deliveryId: first.id, attempts: 1, at: Date.now() - 1000 }
    f.runtime.store.put('missions', mission)
    let interrupted = false
    f.workers.intercept = async (_member, delivery) => {
      if (delivery.id !== first.id) return
      interrupted = true
      f.runtime.control(f.owner, mission.id, action, 'owner decision during transport')
    }
    await f.runtime.flushOutbox(mission.id)
    assert.ok(interrupted, 'the lifecycle change happened inside the awaited transport')
    const current = f.runtime.mission(mission.id)
    assert.equal(current.status, action === 'stop' ? 'stopped' : 'paused')
    assert.equal(current.reason, 'owner decision during transport')
    assert.equal(current.outboxStarved, undefined, 'this successful retry clears its own old failure')
    assert.ok(f.runtime.store.get('deliveries', first.id).deliveredAt, 'in-flight delivery remains a transport fact')
    assert.equal(f.workers.sent.some(row => row.id === second.id), false, 'the next delivery sees the new lifecycle')
    assert.equal(f.runtime.store.get('deliveries', second.id).deliveredAt, undefined)
  })
}

test('outbox checks a queued question again after it is answered during another delivery', async t => {
  const f = await fixture(t)
  const first = f.emit('before-question')
  f.runtime.message({ sessionId: f.member.sessionId }, f.mission.id, { to: 'owner', kind: 'question', content: 'Which API?' })
  const question = f.rows().find(row => row.replyExpected)
  f.workers.intercept = async (_member, delivery) => {
    if (delivery.id !== first.id) return
    f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'v2', replyTo: question.id })
    f.runtime.control(f.owner, f.mission.id, 'pause', 'answer settled before pausing')
  }
  await f.runtime.flushOutbox(f.mission.id)
  assert.equal(f.runtime.store.get('deliveries', question.id).answeredBy, 'owner')
  assert.equal(f.workers.sent.some(row => row.id === question.id), false, 'pause retains only questions still awaiting an answer')
})

for (const differentDelivery of [false, true]) {
  test(`outbox acknowledgement preserves a newer starvation record (${differentDelivery ? 'another delivery' : 'same delivery'})`, async t => {
    const f = await fixture(t)
    const notice = f.emit('retry')
    const mission = f.runtime.mission(f.mission.id)
    mission.outboxStarved = { deliveryId: notice.id, attempts: 1, at: 1000 }
    f.runtime.store.put('missions', mission)
    const newer = { deliveryId: differentDelivery ? 'newer-delivery' : notice.id, attempts: 2, at: 2000 }
    f.workers.intercept = async (_member, delivery) => {
      if (delivery.id !== notice.id) return
      const current = f.runtime.mission(mission.id)
      current.outboxStarved = newer
      f.runtime.store.put('missions', current)
    }
    await f.runtime.flushOutbox(mission.id)
    assert.deepEqual(f.runtime.mission(mission.id).outboxStarved, newer)
  })
}

test('outbox acknowledgement preserves consumption and reply counters written during transport', async t => {
  const f = await fixture(t)
  const notice = f.emit('consumption')
  f.workers.intercept = async (_member, delivery) => {
    if (delivery.id !== notice.id) return
    assert.equal(f.runtime.recordConsumption(notice.id, { at: 123456, source: 'agent/inbox/claimed' }), true)
    const current = f.runtime.store.get('deliveries', notice.id)
    current.replyNudges = 2
    f.runtime.store.put('deliveries', current)
  }
  await f.runtime.flushOutbox(f.mission.id)
  const current = f.runtime.store.get('deliveries', notice.id)
  assert.ok(current.deliveredAt)
  assert.equal(current.notice.consumedAt, 123456)
  assert.equal(current.notice.consumptionSource, 'agent/inbox/claimed')
  assert.equal(current.replyNudges, 2)
})

for (const dismiss of [false, true]) {
  test(`outbox acknowledgement preserves an in-flight ${dismiss ? 'dismissal' : 'answer'}`, async t => {
    const f = await fixture(t)
    f.runtime.message({ sessionId: f.member.sessionId }, f.mission.id, { to: 'owner', kind: 'question', content: 'Which API?' })
    const question = f.rows().find(row => row.replyExpected)
    f.workers.intercept = async (_member, delivery) => {
      if (delivery.id !== question.id) return
      f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', content: 'v2', replyTo: question.id, dismiss })
    }
    await f.runtime.flushOutbox(f.mission.id)
    const current = f.runtime.store.get('deliveries', question.id)
    assert.ok(current.deliveredAt)
    assert.equal(current.state, dismiss ? 'dismissed' : 'answered')
    assert.equal(current.answeredBy, 'owner')
    assert.equal(f.runtime.openAsks(f.mission.id, 'owner').length, 0)
  })
}

test('wake-summary facts arriving during transport get a new deliverable summary', async t => {
  const f = await fixture(t)
  f.runtime.notices.wakeBudget = 1
  f.emit('within-budget')
  f.emit('first-summary-fact')
  const summary = f.rows().find(row => row.notice?.facts)
  assert.ok(summary)
  f.workers.intercept = async (_member, delivery) => {
    if (delivery.id === summary.id) f.emit('fact-during-transport')
  }
  await f.runtime.flushOutbox(f.mission.id)
  const queued = f.rows().find(row => row.id !== summary.id && row.notice?.facts?.some(fact => fact.includes('fact-during-transport')))
  assert.ok(queued, 'an already handed-off message cannot absorb a fact the owner never received')
  assert.equal(queued.deliveredAt, undefined)
  await f.runtime.flushOutbox(f.mission.id)
  assert.ok(f.workers.sent.some(row => row.id === queued.id && row.content.includes('fact-during-transport')))
})

test('wake-summary facts after a transport timeout survive adapter deduplication of the retry', async t => {
  const f = await fixture(t, { tickMs: 1, stallPassTimeoutMs: 20 })
  f.runtime.notices.wakeBudget = 1
  f.emit('within-budget')
  f.emit('initial-summary-fact')
  const summary = f.rows().find(row => row.notice?.facts)
  const accepted = new Map()
  f.workers.intercept = async (_member, delivery) => {
    if (accepted.has(delivery.id)) return
    accepted.set(delivery.id, structuredClone(delivery))
    // The native inbox accepted this immutable message, but its acknowledgement
    // never settles. A later retry acknowledges its ID without replacing content.
    if (delivery.id === summary.id) return new Promise(() => {})
  }
  await f.runtime.flushOutbox(f.mission.id)
  assert.equal(f.runtime.mission(f.mission.id).outboxStarved?.deliveryId, summary.id)
  f.emit('fact-after-timeout')
  await f.runtime.flushOutbox(f.mission.id)
  const delivered = [...accepted.values()].find(row => row.content.includes('fact-after-timeout'))
  assert.ok(delivered, 'a retry must not acknowledge a new fact the native inbox never received')
  assert.notEqual(delivered.id, summary.id, 'an attempted summary stays immutable after its gate is released')
  assert.ok(f.runtime.store.get('deliveries', delivered.id).deliveredAt)
  assert.equal(f.runtime.store.get('deliveries', summary.id).content, accepted.get(summary.id).content)
})
