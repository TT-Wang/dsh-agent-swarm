import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const buckets = (input, requests = 1) => ({ uncachedInputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, requests })
class Workers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, memberId) { return `/isolated/${memberId}` }
  async start() {}
  async stop() {}
  async deliver() {}
  async dispose() {}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-usage-recovery-'))
  const config = { statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 1000, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }
  let workers = new Workers(), runtime = new SwarmRuntime(config, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'usage-owner' }
  const mission = runtime.create(owner, { title: 'Accounting', objective: 'Retain recovered usage', workspace: '/source', scope: ['**'], acceptance: ['done'], budget: {
    maxTokens: 10000, maxSteps: 100, maxWorkers: 1, maxDurationMs: 600000, maxTasks: 4, maxExperiments: 1,
  } })
  const member = await runtime.addMember(owner, mission.id, { name: 'Ada', role: 'Research' })
  return {
    record(total, usage, source) { return workers.callbacks.usageSnapshot(member.id, total, usage, source) },
    read() { return { mission: runtime.store.get('missions', mission.id), member: runtime.store.get('members', member.id) } },
    async reopen() { await runtime.dispose(); workers = new Workers(); runtime = new SwarmRuntime(config, workers) },
  }
}

test('a rebuilt native session charges its first request without discarding lifetime usage', async t => {
  const f = await fixture(t)
  await f.record(900, buckets(900, 9), { generation: 100, restored: false })
  await f.record(0, buckets(0, 0), { generation: 200, restored: false })
  assert.equal(f.read().member.accountedTokens, 900, 'opening a replacement never resets past cost')
  await f.record(40, buckets(40), { generation: 200, restored: false })
  let state = f.read()
  assert.equal(state.mission.usedTokens, 940, 'the new request is below the old watermark but still billable')
  assert.equal(state.member.accountedTokens, 940)
  assert.deepEqual(state.member.usage, buckets(940, 10))
  assert.deepEqual(state.mission.workerUsage, state.member.usage)
  assert.deepEqual(state.member.usageSession, { generation: 200, accountedTokens: 40, usage: buckets(40) })
  await f.reopen()
  await f.record(40, buckets(40), { generation: 200, restored: true })
  await f.record(20, buckets(20), { generation: 200, restored: true })
  await f.record(1000, buckets(1000, 10), { generation: 100, restored: true })
  assert.equal(f.read().mission.usedTokens, 940, 'duplicates, stale current samples and retired sessions cannot be charged again')
  await f.record(85, buckets(85, 2), { generation: 200, restored: true })
  state = f.read()
  assert.equal(state.mission.usedTokens, 985)
  assert.equal(state.member.accountedTokens, 985)
  assert.deepEqual(state.member.usage, buckets(985, 11))
})

test('upgrading a saved native session adopts its legacy watermark without double charging', async t => {
  const f = await fixture(t)
  await f.record(80, buckets(80))
  await f.reopen()
  await f.record(80, buckets(80), { generation: 100, restored: true })
  assert.equal(f.read().mission.usedTokens, 80)
  await f.record(100, buckets(100, 2), { generation: 100, restored: true })
  assert.equal(f.read().mission.usedTokens, 100)
  assert.deepEqual(f.read().member.usage, buckets(100, 2))
})

test('upgrading after a missing native log starts a new watermark and retains legacy cost', async t => {
  const f = await fixture(t)
  await f.record(80, buckets(80))
  await f.reopen()
  await f.record(0, buckets(0, 0), { generation: 200, restored: false })
  await f.record(15, buckets(15), { generation: 200, restored: false })
  assert.equal(f.read().mission.usedTokens, 95)
  assert.deepEqual(f.read().member.usage, buckets(95, 2))
})

test('out-of-order bucket samples cannot lower a watermark and charge later replays twice', async t => {
  const f = await fixture(t)
  const source = { generation: 100, restored: false }
  const first = { ...buckets(40), cacheReadTokens: 20 }
  const partialOlder = { ...buckets(20, 2), cacheReadTokens: 10 }
  await f.record(60, first, source)
  await f.record(40, partialOlder, source)
  await f.record(60, first, source)
  assert.equal(f.read().mission.usedTokens, 60)
  assert.deepEqual(f.read().member.usage, { ...first, requests: 2 })
  assert.deepEqual(f.read().member.usageSession.usage, { ...first, requests: 2 })
  assert.deepEqual(f.read().mission.workerUsage, { ...first, requests: 2 })
})
