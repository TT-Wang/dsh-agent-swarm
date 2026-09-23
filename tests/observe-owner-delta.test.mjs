import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { registerTools } from '../lib/tools.js'
import { TraceWorkers } from './fixtures/trace-runtime.mjs'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 200, maxExperiments: 0 }
async function fixture(t, size = 1) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-owner-delta-'))
  const config = { statePath: join(root, 'db.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 3 }
  const runtime = new SwarmRuntime(config, new TraceWorkers())
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner-session' }
  const input = { title: 'Owner delta', objective: 'Read updates', workspace: root, scope: ['src/'], acceptance: ['works'], budget }
  const mission = runtime.create(owner, input)
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Read updates' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const task = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement module', objective: 'Read updates', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'] })
  for (let i = 1; i < size; i++) runtime.store.put('tasks', { ...task, id: `fixture-${i}`, title: `Module ${i}` })
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  const read = async (query = {}) => (await definitions.get('swarm_observe').execute({ missionId: mission.id, ...query }, { agent: { id: owner.sessionId, session: { header: { cwd: root } } }, signal: new AbortController().signal })).result
  return { runtime, config, root, owner, input, mission, member, task, read }
}

test('owner delta reports changed rows, removals and open questions without acknowledging them', async t => {
  const f = await fixture(t, 32)
  const first = await f.read()
  assert.equal(first.board.length, 32)
  assert.equal(typeof first.nextCursor, 'string')
  const unchanged = await f.read({ cursor: first.nextCursor })
  assert.equal(unchanged.delta, true)
  assert.deepEqual(unchanged.board, [])
  assert.deepEqual(unchanged.members, [])
  assert.deepEqual(unchanged.evidence, [])
  assert(unchanged.events.every(event => event.type === 'trace/span'), 'the tool read itself may append trace telemetry')
  f.runtime.store.put('tasks', { ...f.task, title: 'Implementation updated' })
  f.runtime.store.put('members', { ...f.member, accountedTokens: 75 })
  f.runtime.message({ sessionId: f.member.sessionId }, f.mission.id, { to: 'owner', kind: 'question', content: 'Choose an interface' })
  const delivery = f.runtime.openAsks(f.mission.id)[0]
  const change = await f.read({ cursor: unchanged.nextCursor })
  assert.equal(change.board.length, 1)
  assert.equal(change.board[0].title, 'Implementation updated')
  assert.equal(change.members[0].accountedTokens, 75)
  assert.equal(change.openAsks.count, 1)
  const repeat = await f.read({ cursor: change.nextCursor })
  assert.equal(repeat.openAsks.count, 1, 'unchanged obligations are still shown')
  assert.equal(f.runtime.store.get('deliveries', delivery.id).answeredBy, undefined)
  assert.match((await f.read({ deliveryId: delivery.id })).delivery.content, /Choose an interface/)
  assert.throws(() => f.runtime.observe({ sessionId: f.member.sessionId }, f.mission.id, { deliveryId: delivery.id }), /Only the mission owner/)
  // Evidence leaving the compact attention set must be removed from the caller's view.
  const evidence = { id: 'e1', missionId: f.mission.id, taskId: f.task.id, authorId: f.member.id, claim: 'claim', status: 'challenged', outcome: 'supported', toolRunIds: [], challenges: [], supersedes: [], createdAt: Date.now() }
  f.runtime.store.put('evidence', evidence)
  const challenged = await f.read({ cursor: repeat.nextCursor })
  assert.equal(challenged.evidence[0].id, evidence.id)
  f.runtime.store.put('evidence', { ...evidence, status: 'verified' })
  const verified = await f.read({ cursor: challenged.nextCursor })
  assert.deepEqual(verified.removed.evidence, [evidence.id])
})

test('owner cursors are replayable, scoped, bounded and disposable; exact reads do not consume them', async t => {
  const f = await fixture(t)
  const direct = f.runtime.observe(f.owner, f.mission.id)
  const repeatDirect = f.runtime.observe(f.owner, f.mission.id, { cursor: direct.nextCursor })
  assert.equal(repeatDirect.nextCursor, direct.nextCursor, 'an unchanged view reuses its baseline')
  const first = await f.read()
  f.runtime.store.put('tasks', { ...f.task, title: 'Changed without an event' })
  await f.read({ taskId: f.task.id })
  await f.read({ detail: 'full' })
  const changed = await f.read({ cursor: first.nextCursor })
  const replay = await f.read({ cursor: first.nextCursor })
  assert.deepEqual(replay.board, changed.board, 'retry a lost response from the same baseline')
  const other = f.runtime.create(f.owner, f.input)
  const foreign = f.runtime.observe(f.owner, other.id, { cursor: first.nextCursor })
  assert.equal(foreign.cursorReset, true)
  assert.equal(foreign.delta, undefined)
  f.runtime.store.put('missions', { ...f.runtime.store.get('missions', f.mission.id), ownerSessionId: 'new-owner' })
  const otherOwner = f.runtime.observe({ sessionId: 'new-owner' }, f.mission.id, { cursor: first.nextCursor })
  assert.equal(otherOwner.cursorReset, true)
  f.runtime.store.put('missions', { ...f.runtime.store.get('missions', f.mission.id), ownerSessionId: f.owner.sessionId })
  for (let i = 0; i < 65; i++) await f.read()
  assert.equal((await f.read({ cursor: first.nextCursor })).cursorReset, true, 'eviction is a complete compact reset')
  const last = await f.read()
  await f.runtime.dispose()
  const restarted = new SwarmRuntime(f.config, new TraceWorkers())
  try {
    const reset = restarted.observe(f.owner, f.mission.id, { cursor: last.nextCursor })
    assert.equal(reset.cursorReset, true)
    assert.equal(reset.board.length, 1)
  } finally { await restarted.dispose() }
})

test('owner event pages and history reads do not skip unseen events; posts remain bounded', async t => {
  const f = await fixture(t)
  const first = await f.read()
  for (let i = 0; i < 29; i++) f.runtime.store.event(f.mission.id, 'fixture/change', 'host', { index: i })
  for (let i = 0; i < 7; i++) f.runtime.post(f.owner, f.mission.id, { kind: 'IDEA', body: `Note ${i}` })
  const history = await f.read({ cursor: first.nextCursor, eventLimit: 3 })
  assert.equal(history.nextCursor, first.nextCursor, 'history substitution cannot advance the live event baseline')
  assert.equal(history.nextAfter, undefined, 'a history page must not publish an unseen live event cursor')
  let cursor = history.nextCursor
  const events = []
  for (let i = 0; i < 10; i++) {
    const view = await f.read({ cursor })
    events.push(...view.events)
    cursor = view.nextCursor
    if (i === 0) {
      assert(view.posts.newest.length <= 3)
      assert.equal(view.posts.count, 7)
      assert(view.posts.omitted > 0)
    }
    if (!view.moreEvents) break
  }
  assert.equal(events.filter(event => event.type === 'fixture/change').length, 29)
  assert.equal(new Set(events.map(event => event.seq)).size, events.length)
  assert.deepEqual((await f.read({ cursor })).posts.newest, [])
})

test('representative owner reads reduce serialized bytes while preserving changed rows', async t => {
  for (const size of [32, 128]) {
    const f = await fixture(t, size)
    const full = await f.read()
    f.runtime.store.put('tasks', { ...f.task, title: 'Changed module' })
    const delta = await f.read({ cursor: full.nextCursor })
    const fresh = await f.read()
    assert.equal(delta.board.length, 1)
    assert.deepEqual(delta.board[0], fresh.board.find(task => task.id === f.task.id))
    const bytes = value => Buffer.byteLength(JSON.stringify(value))
    assert(bytes(delta) < bytes(fresh))
    t.diagnostic(`${size} tasks, one changed: compact ${bytes(fresh)} bytes; delta ${bytes(delta)} bytes`)
  }
})
