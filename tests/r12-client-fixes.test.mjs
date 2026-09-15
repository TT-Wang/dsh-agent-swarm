import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { SwarmMonitor } from '../lib/types/client/monitor.js'
import { readSnapshot } from '../lib/types/client/projection.js'
import { ActivityPanel } from '../lib/types/client/ActivityPanel.js'
import { registerWebApi } from '../lib/web-api.js'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const live = (revision = 1, ownerSessionId = 'owner') => ({ ownerSessionId, workspace: '/repo', snapshots: [uiSnapshot()], drafts: [], starts: [], defaultBudget: uiSnapshot().mission.budget, writable: true, ownerLive: true, revision })
function brokenDelta() {
  const state = live(2)
  state.snapshots[0].mission.title = null
  return { kind: 'delta', ownerSessionId: 'owner', revision: 2, state, missionIds: ['mission-demo'] }
}

test('M4-F1: an invalid delta automatically recovers with a full state before resuming watch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const monitor = new SwarmMonitor(async (endpoint, payload) => {
    calls.push({ endpoint, ...payload })
    if (endpoint === 'state') return live(calls.length === 1 ? 1 : 3)
    if (calls.length === 2) return brokenDelta()
    return await new Promise(() => {})
  })
  t.after(() => monitor.dispose())
  monitor.select('owner'); await flush()
  t.mock.timers.tick(40); await flush()
  assert.equal(monitor.getSnapshot().data.revision, 1, 'retain the last good data with a visible reconnecting error')
  assert.match(monitor.getSnapshot().error, /Invalid swarm state/)
  t.mock.timers.tick(1000); await flush()
  assert.equal(monitor.getSnapshot().data.revision, 3)
  assert.equal(monitor.getSnapshot().connection, 'connected')
  assert.equal(monitor.getSnapshot().error, undefined)
  t.mock.timers.tick(40); await flush()
  assert.deepEqual(calls.map(call => [call.endpoint, call.afterRevision]), [['state', undefined], ['watch', 1], ['state', undefined], ['watch', 3]])
})

test('M4-F1: persistently malformed snapshots back off instead of replaying the poisoned delta', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const monitor = new SwarmMonitor(async endpoint => {
    calls.push(endpoint)
    if (calls.length === 1) return live()
    return endpoint === 'watch' ? brokenDelta() : brokenDelta().state
  })
  t.after(() => monitor.dispose())
  monitor.select('owner'); await flush()
  t.mock.timers.tick(40); await flush()
  t.mock.timers.tick(1000); await flush()
  t.mock.timers.tick(1999); await flush()
  assert.equal(calls.length, 3, 'the next failed full read waits two seconds')
  t.mock.timers.tick(1); await flush()
  assert.deepEqual(calls, ['state', 'watch', 'state', 'state'])
  assert.equal(monitor.getSnapshot().data.revision, 1)
  assert.equal(monitor.getSnapshot().connection, 'reconnecting')
})

test('M4-F1: a late full-state recovery cannot cross an owner switch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = deferred(), calls = []
  const monitor = new SwarmMonitor(async (endpoint, payload, signal) => {
    calls.push({ endpoint, ...payload, signal })
    if (payload.sessionId === 'next-owner') return live(8, 'next-owner')
    if (calls.length === 1) return live()
    return endpoint === 'watch' ? brokenDelta() : await pending.promise
  })
  t.after(() => monitor.dispose())
  monitor.select('owner'); await flush()
  t.mock.timers.tick(40); await flush()
  t.mock.timers.tick(1000); await flush()
  monitor.select('next-owner'); await flush()
  assert.equal(calls[2].signal.aborted, true)
  pending.resolve(live(100)); await flush()
  assert.equal(monitor.getSnapshot().data.ownerSessionId, 'next-owner')
  assert.equal(monitor.getSnapshot().data.revision, 8)
})

test('M4-F5: optional progress, recovery and usage fields validate without requiring legacy fields', () => {
  const base = uiSnapshot()
  assert.ok(readSnapshot(base), 'older snapshots omit all new optional fields')
  const good = structuredClone(base)
  const usage = { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 4, reasoningTokens: 2, requests: 1 }
  Object.assign(good.mission, { workerUsage: usage, ownerUsage: usage, budgetPause: { id: 'pause', quiesced: false, stopping: { instanceId: 'runtime', at: 100 } } })
  Object.assign(good.tasks[1], { usedSteps: 0, maxSteps: 10, recoveryCount: 1, maxRecoveryAttempts: 3, resumeAfterStop: { epoch: 1, reason: 'handoff', at: 100 } })
  good.members[1].activity = { id: 'run', kind: 'tool', startedAt: 100, updatedAt: 200, tool: 'read', retryAt: 500, retryAttempt: 1 }
  assert.ok(readSnapshot(good))
  for (const [label, mutate] of [
    ['task usedSteps', s => { s.tasks[1].usedSteps = 'many' }],
    ['task maxSteps', s => { s.tasks[1].maxSteps = NaN }],
    ['recovery count', s => { s.tasks[1].recoveryCount = -1 }],
    ['recovery limit', s => { s.tasks[1].maxRecoveryAttempts = {} }],
    ['stop epoch', s => { s.tasks[1].resumeAfterStop.epoch = 'one' }],
    ['stop reason', s => { s.tasks[1].resumeAfterStop.reason = {} }],
    ['stop timestamp', s => { s.tasks[1].resumeAfterStop.at = Infinity }],
    ['budget pause', s => { s.mission.budgetPause = {} }],
    ['stop claim', s => { s.mission.budgetPause.stopping.at = 'now' }],
    ['worker usage', s => { s.mission.workerUsage.requests = {} }],
    ['owner usage', s => { s.mission.ownerUsage = { outputTokens: 1 } }],
    ['activity tool', s => { s.members[1].activity.tool = {} }],
    ['activity timestamp', s => { s.members[1].activity.updatedAt = Infinity }],
  ]) {
    const snapshot = structuredClone(good); mutate(snapshot)
    assert.equal(readSnapshot(snapshot), undefined, label)
  }
})

// Drive this component's hook/commit boundaries without a browser or a model.
// Children remain React elements; the assertions invoke its actual event handlers.
function panelHarness(monitor) {
  const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const hooks = []; let cursor, effects, dirty = false, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const slot = () => { const index = cursor++; return hooks[index] ?? (hooks[index] = {}) }
  const dispatcher = {
    useState(initial) { const cell = slot(); if (!('value' in cell)) cell.value = typeof initial === 'function' ? initial() : initial
      return [cell.value, next => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(cell.value, value)) { cell.value = value; dirty = true } }] },
    useRef(initial) { const cell = slot(); return cell.ref ?? (cell.ref = { current: initial }) },
    useMemo(factory, deps) { const cell = slot(); if (!same(cell.deps, deps)) { cell.value = factory(); cell.deps = deps } return cell.value },
    useEffect(effect, deps) { const cell = slot(); if (!same(cell.deps, deps)) { cell.deps = deps; effects.push(() => { cell.cleanup?.(); cell.cleanup = effect() }) } },
    useContext(context) { return context._currentValue },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
  }
  const fixed = value => ({ subscribe: () => () => {}, getSnapshot: () => value })
  const props = { sessions: { list: fixed({ current: 'owner' }) }, modelDirectories: { directoryFor() {} }, monitor,
    history: { ...fixed({}), close() {} }, onOpenWorker() {} }
  const render = () => {
    let rounds = 0
    do {
      dirty = false; cursor = 0; effects = []
      const previous = internals.ReactCurrentDispatcher.current
      internals.ReactCurrentDispatcher.current = dispatcher
      try { tree = ActivityPanel(props) } finally { internals.ReactCurrentDispatcher.current = previous }
      for (const effect of effects) effect()
      assert.ok(++rounds < 20, 'component effects converge')
    } while (dirty)
    return tree
  }
  const find = predicate => {
    const visit = node => {
      if (!node || typeof node !== 'object') return undefined
      if (Array.isArray(node)) return node.map(visit).find(Boolean)
      if (!node.props) return undefined
      if (predicate(node)) return node
      for (const value of Object.values(node.props)) { const found = visit(value); if (found) return found }
    }
    return visit(tree)
  }
  return { render, find, dispose() { for (const hook of hooks) hook.cleanup?.() } }
}

test('M4-F4: automatic mission selection releases old busy state; its late failure cannot clear a new control', async t => {
  const requests = [], operations = []
  let data = live()
  const monitor = { getSnapshot: () => ({ ownerSessionId: 'owner', data, connection: 'connected', loading: false }), subscribe: () => () => {}, select() {}, refresh: async () => {},
    request(endpoint, payload) { const operation = deferred(); requests.push({ endpoint, payload }); operations.push(operation); return operation.promise } }
  const panel = panelHarness(monitor); t.after(() => panel.dispose())
  const pause = () => panel.find(node => node.props['data-action'] === 'pause')
  panel.render(); pause().props.onClick(); panel.render()
  assert.equal(pause().props.disabled, true)
  const next = uiSnapshot(); next.mission.id = 'next-mission'
  data = { ...live(2), snapshots: [data.snapshots[0], next], starts: [{ id: 'new-start', ownerSessionId: 'owner', status: 'running', missionId: next.mission.id, createdAt: 500 }] }
  panel.render()
  assert.equal(pause().props.disabled, false, 'automatic latest-start selection must not inherit the previous busy lock')
  pause().props.onClick(); panel.render()
  assert.equal(pause().props.disabled, true)
  operations[0].reject(new Error('old request failed')); await flush(); panel.render()
  assert.equal(pause().props.disabled, true, 'the old request cannot clear the newer operation token')
  assert.equal(panel.find(node => node.props.role === 'alert'), undefined, 'the old error stays with its old selection')
  operations[1].resolve({ snapshot: { ...next, mission: { ...next.mission, status: 'paused', updatedAt: next.mission.updatedAt + 1 } } }); await flush(); panel.render()
  const resume = panel.find(node => node.props['data-action'] === 'resume')
  assert.equal(resume.props.disabled, false)
  assert.deepEqual(requests.map(item => item.payload.missionId), ['mission-demo', 'next-mission'])
})

function webFixture({ release = async () => {}, listModels = async () => [] } = {}) {
  const routes = [], effects = [], warnings = []
  const ctx = {
    effect(factory, name) { effects.push({ name, dispose: factory() }) },
    sessions: { get: id => ({ header: { id, cwd: '/workspace' } }) }, agents: { get() {} },
    llm: { listProviders: () => [{ id: 'healthy', name: 'Healthy' }, { id: 'broken', name: 'Broken' }], listModels },
    logger: { warn: (...args) => warnings.push(args) },
    connection: { fetch: { register(route) { const index = routes.push(route) - 1; return () => release(index) } } },
  }
  registerWebApi(ctx, {}, { defaultBudget: uiSnapshot().mission.budget, maxPayloadBytes: 8192 })
  const rpc = async endpoint => {
    const route = routes.find(route => route.path.endsWith('/' + endpoint))
    const response = await route.fetch(new Request('http://localhost' + route.path, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'agent-swarm/' + endpoint, payload: { sessionId: 'owner' } }) }))
    return (await response.json()).result
  }
  return { routes, warnings, rpc, dispose: () => effects.find(item => item.name === 'agent-swarm: web routes').dispose() }
}

test('M4-F2: route teardown awaits all releases and contains both synchronous and asynchronous failures', async () => {
  const waiting = deferred(), released = []
  const fixture = webFixture({ release(index) {
    released.push(index)
    if (index === 0) throw new Error('sync release')
    if (index === 1) return Promise.reject(new Error('async release'))
    if (index === 2) return waiting.promise
  } })
  let settled = false
  const done = fixture.dispose().then(() => { settled = true })
  await flush()
  assert.equal(released.length, fixture.routes.length)
  assert.equal(settled, false, 'the dispose promise includes pending route releases')
  waiting.resolve(); await done
  assert.equal(fixture.warnings.length, 2)
  await fixture.dispose()
  assert.equal(released.length, fixture.routes.length, 'registrations are released once')
})

test('M4-F3: provider catalog failures preserve healthy models and expose sanitized partial diagnostics', async () => {
  const fixture = webFixture({ async listModels(provider) {
    if (provider === 'broken') throw new Error('Secret: /Users/private/provider.env')
    return [{ provider, id: 'model', name: 'Working model' }]
  } })
  try {
    const result = await fixture.rpc('models')
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.models, [{ provider: 'healthy', id: 'model', name: 'Working model' }])
    assert.deepEqual(result.value.providerErrors, [{ provider: 'broken', code: 'catalog-unavailable', message: 'Model catalog is temporarily unavailable' }])
    assert.equal(result.value.providers.length, 2)
    assert.doesNotMatch(JSON.stringify(result), /Secret|private|provider\.env/)
    assert.equal(fixture.warnings.length, 1)
  } finally { await fixture.dispose() }
})
