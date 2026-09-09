/** M9 residual regression: runtime.addMember validates subscriptions at its own boundary. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 6, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

class SubscriptionWorkers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact() { return { commit: 'f'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async dispose() {}
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-subscriptions-'))
  const workers = new SubscriptionWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'subscription-owner' }
  const mission = runtime.create(owner, { title: 'Subscriptions', objective: 'Validate the runtime boundary', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  return { runtime, workers, owner, mission }
}

test('runtime.addMember rejects a non-array subscriptions value before any workspace effect', async t => {
  const f = await fixture(t)
  const before = f.runtime.snapshot(f.owner, f.mission.id).members.length
  // Pre-fix this stored the bare string and topic matching silently degraded to
  // String.includes substring semantics.
  await assert.rejects(f.runtime.addMember(f.owner, f.mission.id, { name: 'Worker', role: 'implementation', subscriptions: 'topic-a' }),
    /subscriptions must be a string array/)
  await assert.rejects(f.runtime.addMember(f.owner, f.mission.id, { name: 'Worker', role: 'implementation', subscriptions: { topic: 'a' } }),
    /subscriptions must be a string array/)
  await assert.rejects(f.runtime.addMember(f.owner, f.mission.id, { name: 'Worker', role: 'implementation', subscriptions: ['topic-a', 7] }),
    /subscriptions must be a string array/)
  await assert.rejects(f.runtime.addMember(f.owner, f.mission.id, { name: 'Worker', role: 'implementation', subscriptions: ['topic-a', '   '] }),
    /subscriptions must be a string array/)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).members.length, before, 'a rejected admission creates no member')
})

test('runtime.addMember stores subscriptions as a deduplicated string array with exact topic matching', async t => {
  const f = await fixture(t)
  const member = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Subscriber', role: 'research', subscriptions: ['topic-a', 'topic-a', 'topic-b'] })
  assert.deepEqual(member.subscriptions, ['topic-a', 'topic-b'])
  const findings = topic => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.kind === 'finding' && delivery.topic === topic)
  f.runtime.message(f.owner, f.mission.id, { to: 'subscribers', kind: 'finding', content: 'substring must not match', topic: 'topic' })
  assert.equal(findings('topic').length, 0, 'topic matching is exact array membership, not a substring of topic-a')
  f.runtime.message(f.owner, f.mission.id, { to: 'subscribers', kind: 'finding', content: 'exact match', topic: 'topic-a' })
  assert.equal(findings('topic-a').length, 1)
})
