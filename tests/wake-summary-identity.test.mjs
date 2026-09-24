import test from 'node:test'
import assert from 'node:assert/strict'
import { hasNotice } from '../lib/arena.js'
import { factKey } from '../lib/notices.js'
import { FakeWorkers, SwarmRuntime, makeRuntime } from './faults/harness.mjs'

class InterceptWorkers extends FakeWorkers {
  sent = []
  intercept = async () => {}
  async deliver(_member, delivery) {
    this.sent.push(structuredClone(delivery))
    await this.intercept(delivery)
  }
}

async function fixture(t) {
  // The reopened runtime is disposed first; makeRuntime's own cleanup then removes the state directory.
  t.after(async () => { await runtime.dispose() })
  let { dir: directory, config, runtime, workers, budget } = await makeRuntime(t, { workers: new InterceptWorkers(),
    config: { tickMs: 60000, maxEvents: 500, maxTasksPerMember: 10, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2, maxDurationMs: 3600000, maxTasks: 20 } })
  // Exercise the real durable outbox at deterministic transport boundaries.
  const quiet = () => { runtime.pumpOutbox = () => {} }
  quiet()
  const owner = { sessionId: 'wake-identity-owner' }
  const mission = runtime.create(owner, { title: 'Wake identity', objective: 'Report each fact once',
    workspace: directory, scope: ['**'], acceptance: ['facts reach the owner'], budget })
  const rows = () => runtime.store.list('deliveries', mission.id).filter(row => row.to === 'owner')
  const emit = (content, { subject = 'task_delivery@0', reason = content, ...options } = {}) => {
    runtime.commit(mission.id, () => runtime.notify(mission.id, content, [subject], {
      trigger: 'test/fact', reason, ...options,
    }))
    return factKey(mission.id, { subjects: [subject], trigger: 'test/fact', reason })
  }
  const fillBudget = () => {
    // Retain the shipping budget, so this covers the actual default-mode path.
    for (let index = 0; index < runtime.notices.wakeBudget; index++) emit(`seed ${index}`)
  }
  return { get runtime() { return runtime }, workers, mission, rows, emit, fillBudget,
    async restart() { await runtime.dispose(); runtime = new SwarmRuntime(config, workers); quiet(); await runtime.start() },
  }
}

test('a summarized fact is deduplicated before, during and after its transport', async t => {
  const f = await fixture(t)
  f.fillBudget()
  f.emit('same decision')
  f.emit('same decision')
  const summary = f.rows().find(row => row.notice?.facts)
  assert.equal(summary.notice.facts.length, 1, 'pending aggregation must not repeat a fact')
  f.workers.intercept = async delivery => {
    if (delivery.id === summary.id) f.emit('same decision')
  }
  await f.runtime.flushOutbox(f.mission.id)
  for (let index = 0; index < 3; index++) {
    f.emit('same decision')
    await f.runtime.flushOutbox(f.mission.id)
  }
  assert.equal(f.workers.sent.filter(row => row.content.includes('same decision')).length, 1,
    'a handed-off summary keeps its fact identity even after its aggregation window detaches')
  assert.equal(f.rows().filter(row => row.notice?.facts).length, 1)
})

for (const delivered of [false, true]) {
  test(`summary identity survives a restart while ${delivered ? 'delivered' : 'queued'}`, async t => {
    const f = await fixture(t)
    f.fillBudget()
    const key = f.emit('durable decision')
    if (delivered) await f.runtime.flushOutbox(f.mission.id)
    const rowIds = f.rows().map(row => row.id)
    await f.restart()
    assert.equal(hasNotice(f.rows(), { class: 'decision', from: 'runtime', dedupKey: key }), true,
      'the shared predicate must find facts carried by summaries in the durable store')
    f.emit('durable decision')
    assert.deepEqual(f.rows().map(row => row.id), rowIds, 'restart must not re-arm an already recorded fact')
    await f.runtime.flushOutbox(f.mission.id)
    assert.equal(f.workers.sent.filter(row => row.content.includes('durable decision')).length, 1)
  })
}

test('summary dedup keeps class, sender, epoch, reason and explicit repeat semantics', async t => {
  const f = await fixture(t)
  f.fillBudget()
  const key = f.emit('decision body', { reason: 'waiting' })
  f.emit('decision body', { reason: 'waiting' })
  f.emit('decision body', { reason: 'waiting', noticeClass: 'blocker' })
  f.emit('decision body', { reason: 'waiting', from: 'member-a' })
  f.emit('decision body', { reason: 'waiting', subject: 'task_delivery@1' })
  f.emit('decision body', { reason: 'new evidence' })
  // Transition-owned notices can deliberately re-announce a change-and-return.
  f.emit('decision body', { reason: 'waiting', dedupe: false })
  const summary = f.rows().find(row => row.notice?.facts)
  assert.equal(summary.notice.facts.length, 6, 'only the ordinary repeat is suppressed')
  const match = { class: 'decision', from: 'runtime', dedupKey: key }
  assert.equal(hasNotice(f.rows(), { ...match, content: 'decision body' }), true)
  assert.equal(hasNotice(f.rows(), { ...match, content: 'different body' }), false,
    'the optional exact-content match remains meaningful after aggregation')
  assert.equal(hasNotice(f.rows(), { ...match, from: 'member-b' }), false)
  assert.equal(hasNotice(f.rows(), { ...match, class: 'failure' }), false)
  await f.runtime.flushOutbox(f.mission.id)
  f.emit('decision body', { reason: 'waiting', dedupe: false })
  await f.runtime.flushOutbox(f.mission.id)
  assert.equal(f.workers.sent.filter(row => row.notice?.facts).length, 2,
    'an explicit new announcement after handoff gets a new immutable delivery')
})
