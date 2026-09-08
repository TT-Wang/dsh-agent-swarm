import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SwarmStore } from '../lib/store.js'
import { waitForStateChange } from '../lib/watch.js'
import { SwarmMonitor, mergeUpdate } from '../lib/types/client/monitor.js'
import { deliverableTask, deliverableCommit, deliveryApplied } from '../lib/types/client/projection.js'
import { DeliveryPanel } from '../lib/types/client/DeliveryPanel.js'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-live-'))
  const path = join(root, 'state.sqlite')
  let store = new SwarmStore(path)
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  return { get store() { return store }, path, reopen() { store.close(); store = new SwarmStore(path); return store } }
}
const record = (value = 1, owner = 'owner') => ({ id: 'mission-live', ownerSessionId: owner, value })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const state = (owner = 'owner', revision = 1, snapshots = [uiSnapshot()]) => ({ ownerSessionId: owner, revision, workspace: '/repo', snapshots, drafts: [], starts: [], defaultBudget: uiSnapshot().mission.budget, writable: true, ownerLive: true })

test('state cursor covers eventless commits, remains durable, and does not notify rolled-back work', async t => {
  const f = await fixture(t), revisions = []
  const off = f.store.subscribe(() => { try { revisions.push(f.store.revision()) } catch {} })
  f.store.transaction(() => f.store.put('missions', record()))
  assert.equal(f.store.events('mission-live', 100).length, 0)
  assert.equal(f.store.revision(), 1)
  assert.deepEqual(revisions, [1])
  assert.throws(() => f.store.transaction(() => { f.store.put('missions', record(2)); throw new Error('rollback') }), /rollback/)
  assert.equal(f.store.get('missions', 'mission-live').value, 1)
  assert.equal(f.store.revision(), 1)
  assert.deepEqual(revisions, [1])
  off()
  f.reopen()
  assert.equal(f.store.revision(), 1)
  assert.deepEqual(f.store.changesSince(0), [{ revision: 1, scopes: ['mission-live', 'owner'] }])
})

test('version one store upgrades without losing prior records', async t => {
  const f = await fixture(t)
  f.store.transaction(() => f.store.put('missions', record()))
  f.store.close()
  const db = new DatabaseSync(f.path)
  db.exec('DROP TABLE state_revision; DROP TABLE state_changes; PRAGMA user_version=1;')
  db.close()
  f.reopen()
  assert.equal(f.store.get('missions', 'mission-live').value, 1)
  assert.equal(f.store.revision(), 0)
  f.store.transaction(() => f.store.put('missions', record(2)))
  assert.equal(f.store.revision(), 1)
})

test('expired or future cursor requires a snapshot; replay is bounded', async t => {
  const { store } = await fixture(t)
  for (let i = 0; i < 1030; i++) store.transaction(() => store.put('missions', record(i)))
  assert.equal(store.changesSince(0), undefined)
  assert.equal(store.changesSince(1031), undefined)
  assert.equal(store.changesSince(6).length, 1024)
  assert.deepEqual(store.changesSince(1030), [])
})

test('watch wakes promptly for its owner, ignores other owners, and closes cleanly', async t => {
  const { store } = await fixture(t), signal = new AbortController()
  const scopes = () => new Set(['owner'])
  let completed = false
  const waiting = waitForStateChange(store, 0, scopes, signal.signal, 1000).then(() => { completed = true })
  store.transaction(() => store.put('missions', { ...record(1, 'someone-else'), id: 'other-mission' }))
  await pause(20)
  assert.equal(completed, false)
  store.transaction(() => store.put('missions', record()))
  await waiting
  assert.equal(completed, true)
  const cancellation = new AbortController()
  const cancelled = waitForStateChange(store, store.revision(), scopes, cancellation.signal, 1000)
  cancellation.abort(new Error('observer left'))
  await assert.rejects(cancelled, /observer left/)
  const closing = waitForStateChange(store, store.revision(), scopes, signal.signal, 1000)
  store.close()
  await assert.rejects(closing, /store is closed/)
})

test('watch detects a commit before subscription and gives idle heartbeat without changing revision', async t => {
  const { store } = await fixture(t)
  store.transaction(() => store.put('missions', record()))
  await waitForStateChange(store, 0, () => new Set(['owner']), new AbortController().signal, 1000)
  await waitForStateChange(store, 1, () => new Set(['owner']), new AbortController().signal, 5)
  assert.equal(store.revision(), 1)
})

test('delta reconciliation preserves unchanged cards and removes revoked memberships', () => {
  const first = uiSnapshot(), second = { ...uiSnapshot(), mission: { ...uiSnapshot().mission, id: 'second' } }
  const initial = state('owner', 1, [first, second])
  const changed = { ...first, mission: { ...first.mission, usedTokens: 99 } }
  const update = { kind: 'delta', ownerSessionId: 'owner', revision: 2, missionIds: [first.mission.id, 'second'], state: state('owner', 2, [changed]) }
  const merged = mergeUpdate(initial, update, 'owner')
  assert.equal(merged.snapshots[0], changed)
  assert.equal(merged.snapshots[1], second)
  const removed = mergeUpdate(merged, { ...update, revision: 3, missionIds: [], state: state('owner', 3, []) }, 'owner')
  assert.deepEqual(removed.snapshots, [])
  assert.throws(() => mergeUpdate(initial, update, 'other-owner'), /Invalid swarm update/)
  assert.throws(() => mergeUpdate(merged, { kind: 'heartbeat', ownerSessionId: 'owner', revision: 1 }, 'owner'), /out of order/)
  const idle = mergeUpdate(merged, { kind: 'heartbeat', ownerSessionId: 'owner', revision: 4 }, 'owner')
  assert.equal(idle.snapshots, merged.snapshots)
})

test('monitor follows commits, fences delayed replies after owner switch, and cancels a hidden watch', async () => {
  const calls = []
  const waitForCalls = async count => {
    const until = Date.now() + 5000
    while (calls.length < count && Date.now() < until) await pause(5)
    assert.ok(calls.length >= count, `Expected ${count} admitted monitor requests, got ${calls.length}`)
  }
  const monitor = new SwarmMonitor((endpoint, payload, signal) => new Promise(resolve => calls.push({ endpoint, payload, signal, resolve })))
  try {
    monitor.select('owner')
    calls[0].resolve(state())
    await waitForCalls(2)
    assert.equal(calls[1].endpoint, 'watch')
    assert.equal(calls[1].payload.afterRevision, 1)
    monitor.select('other-owner')
    assert.equal(calls[1].signal.aborted, true)
    calls[2].resolve(state('other-owner', 5))
    calls[1].resolve({ kind: 'heartbeat', ownerSessionId: 'owner', revision: 9 })
    await waitForCalls(4)
    assert.equal(monitor.getSnapshot().data.ownerSessionId, 'other-owner')
    assert.equal(monitor.getSnapshot().data.revision, 5)
    assert.equal(calls[3].endpoint, 'watch')
    monitor.setActive(false)
    assert.equal(calls[3].signal.aborted, true)
    assert.equal(monitor.getSnapshot().connection, 'paused')
    calls[3].resolve({ kind: 'heartbeat', ownerSessionId: 'other-owner', revision: 6 })
    await pause(70)
    assert.equal(calls.length, 4)
    assert.equal(monitor.getSnapshot().data.revision, 5)
  } finally { monitor.dispose() }
})

test('heartbeat refreshes native lifecycle and configuration metadata without altering work', () => {
  const initial = state()
  const nextBudget = { ...initial.defaultBudget, maxWorkers: 2 }
  const updated = mergeUpdate(initial, { kind: 'heartbeat', ownerSessionId: 'owner', revision: initial.revision,
    ownerLive: false, writable: true, defaultBudget: nextBudget, workspace: '/repo' }, 'owner')
  assert.equal(updated.ownerLive, false)
  assert.equal(updated.defaultBudget, nextBudget)
  assert.equal(updated.snapshots, initial.snapshots)
  assert.equal(updated.revision, initial.revision)
})

test('delivery consumes the runtime target instead of the first accepted integration', () => {
  const base = uiSnapshot()
  const artifact = commit => ({ commit, baseCommit: 'f'.repeat(40), workspace: '/workspace/demo', changedPaths: ['src/change.ts'] })
  const tasks = [
    { ...base.tasks[0], id: 'impl-1', kind: 'implementation', status: 'accepted', artifact: artifact('1'.repeat(40)), dependencies: [] },
    { ...base.tasks[0], id: 'integ-1', kind: 'integration', status: 'accepted', artifact: artifact('2'.repeat(40)), dependencies: ['impl-1'] },
    { ...base.tasks[0], id: 'integ-2', kind: 'integration', status: 'accepted', artifact: artifact('3'.repeat(40)), dependencies: ['integ-1'] },
  ]
  const snapshot = { ...base, tasks, deliveryTarget: { taskId: 'integ-2', commit: '3'.repeat(40) } }
  assert.equal(deliverableTask(snapshot).id, 'integ-2', 'the runtime maximal integration is the deliverable')
  assert.equal(deliverableCommit(snapshot), '3'.repeat(40))
  const legacy = { ...snapshot }
  delete legacy.deliveryTarget
  assert.equal(deliverableTask(legacy).id, 'integ-1', 'a legacy snapshot keeps the historical local rule')
  assert.equal(deliverableCommit(legacy), '2'.repeat(40))
  assert.equal(deliveryApplied(snapshot, deliverableCommit(snapshot)), false, 'no receipt means the result is not applied')
  const applied = { ...snapshot, appliedDelivery: { resultCommit: '3'.repeat(40), appliedAt: base.mission.updatedAt } }
  assert.equal(deliveryApplied(applied, deliverableCommit(applied)), true)
  assert.equal(deliveryApplied(applied, '2'.repeat(40)), false, 'a receipt only marks its own result commit applied')
  const panel = props => renderToStaticMarkup(React.createElement(DeliveryPanel, { snapshot: props, sessionId: 'owner', request: async () => ({}), onApplied() {} }))
  assert.match(panel(applied), /data-action="apply-delivery"[^>]*disabled=""/)
  assert.match(panel(applied), />Applied</)
  assert.match(panel(applied), /Result applied to working files/)
  assert.match(panel(snapshot), /data-action="apply-delivery"[^>]*>Apply result</, 'the button is offered while no applied receipt exists')
})
