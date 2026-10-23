import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { SwarmMonitor } from '../lib/types/client/monitor.js'
import { readBudget, readDelivery, readDeliveryApplication, readDraft, readSnapshot, readStart } from '../lib/types/client/projection.js'
import { ActivityPanel } from '../lib/types/client/ActivityPanel.js'
import { newPlan } from '../lib/types/client/DraftEditor.js'
import { registerWebApi } from '../lib/web-api.js'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'
import { makeRuntimeStub } from './faults/harness.mjs'

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

// F2: a saved draft, a saved request and a budget as the server sends them,
// with every optional field the panel reads present.
const draftItem = () => {
  const input = { ...newPlan('/repo', uiSnapshot().mission.budget), title: 'Paginate the API', objective: 'Add cursor pagination' }
  Object.assign(input.members[0], { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' })
  Object.assign(input.tasks[0], { outputs: ['src/api.ts'], priority: 60, experiment: false })
  return { id: 'draft-1', ownerSessionId: 'owner', revision: 2, status: 'failed', input, advisories: ['A preflight note'], error: 'Launch failed', createdAt: 1, updatedAt: 2 }
}
const startItem = () => ({ id: 'start-1', ownerSessionId: 'owner', commandId: 'command-1', goal: 'Paginate the API', workspace: '/repo', status: 'planning',
  planningEpoch: 1, draftId: 'draft-1', createdAt: 1, updatedAt: 2,
  baseline: { sourceHead: 'a'.repeat(40), snapshotCommit: 'b'.repeat(40), planningWorkspace: '/planning', changedPaths: ['src/api.ts'], createdAt: 1 } })

test('F2: the draft, start, budget and delivery readers admit what the panel renders and refuse what would break it', () => {
  assert.equal(readDraft(draftItem()) !== undefined, true)
  assert.equal(readStart(startItem()) !== undefined, true)
  const bare = draftItem(); delete bare.advisories; delete bare.error
  assert.ok(readDraft(bare), 'a draft without notes or an error is readable')
  const legacy = startItem(); delete legacy.planningEpoch; delete legacy.draftId; delete legacy.baseline
  assert.ok(readStart(legacy), 'a legacy request without an epoch, a draft or a snapshot is readable')
  const value = draftItem()
  assert.equal(readDraft(value), value, 'a reader returns the item itself')
  for (const [label, mutate] of [
    ['draft without input', d => { delete d.input }],
    ['tasks not a list', d => { d.input.tasks = { deliver: d.input.tasks[0] } }],
    ['task scope', d => { d.input.tasks[0].scope = 'src/' }],
    ['task acceptance', d => { delete d.input.tasks[1].acceptance }],
    ['task covers', d => { d.input.tasks[0].covers = [1] }],
    ['task checks', d => { d.input.tasks[0].checks = 'npm test' }],
    ['task outputs', d => { d.input.tasks[0].outputs = {} }],
    ['task dependencies', d => { d.input.tasks[0].dependencies = 'review' }],
    ['task title', d => { d.input.tasks[0].title = { text: 'Deliver' } }],
    ['task workstream', d => { delete d.input.tasks[0].workstreamKey }],
    ['task review source', d => { d.input.tasks[1].reviewOf = 5 }],
    ['task priority', d => { d.input.tasks[0].priority = 'high' }],
    ['task experiment', d => { d.input.tasks[0].experiment = 'yes' }],
    ['members not a list', d => { d.input.members = null }],
    ['member name', d => { d.input.members[0].name = {} }],
    ['member model', d => { d.input.members[0].model = 4 }],
    ['workstream objective', d => { d.input.workstreams[0].objective = null }],
    ['plan scope', d => { d.input.scope = 'src/' }],
    ['plan criteria', d => { d.input.acceptance = [{ text: 'Done' }] }],
    ['plan title', d => { d.input.title = 5 }],
    ['plan budget', d => { delete d.input.budget }],
    ['plan budget limit', d => { d.input.budget.maxTasks = '20' }],
    ['revision', d => { d.revision = 'r2' }],
    ['status', d => { delete d.status }],
    ['error', d => { d.error = { message: 'failed' } }],
    ['advisories', d => { d.advisories = 'A preflight note' }],
    ['mission link', d => { d.missionId = 5 }],
  ]) {
    const draft = draftItem(); mutate(draft)
    assert.equal(readDraft(draft), undefined, label)
  }
  for (const [label, mutate] of [
    ['goal', s => { delete s.goal }],
    ['status', s => { s.status = 5 }],
    ['created time', s => { s.createdAt = 'now' }],
    ['updated time', s => { delete s.updatedAt }],
    ['planning epoch', s => { s.planningEpoch = 'one' }],
    ['draft link', s => { s.draftId = 5 }],
    ['mission link', s => { s.missionId = {} }],
    ['error', s => { s.error = { message: 'failed' } }],
    ['baseline', s => { s.baseline = 'b'.repeat(40) }],
    ['baseline commit', s => { delete s.baseline.snapshotCommit }],
    ['baseline changed paths', s => { s.baseline.changedPaths = 'src/api.ts' }],
  ]) {
    const start = startItem(); mutate(start)
    assert.equal(readStart(start), undefined, label)
  }
  const budget = uiSnapshot().mission.budget
  assert.ok(readBudget({ ...budget, deadlineAt: Date.UTC(2026, 9, 30) }))
  assert.ok(readBudget({ ...budget, maxTokens: 1.5 }), 'admission keeps render safe; integer limits are the runtime\'s policy')
  for (const [label, value] of [['absent', undefined], ['null', null], ['empty', {}], ['infinite limit', { ...budget, maxSteps: Infinity }],
    ['string limit', { ...budget, maxWorkers: '5' }], ['string deadline', { ...budget, deadlineAt: 'tomorrow' }]]) {
    assert.equal(readBudget(value), undefined, label)
  }
  const snapshot = uiSnapshot(); snapshot.mission.budget.deadlineAt = 'tomorrow'
  assert.equal(readSnapshot(snapshot), undefined, 'a mission budget is read by the same budget rule')
  const delivery = { baselineCommit: 'a'.repeat(40), resultCommit: 'b'.repeat(40), changedPaths: ['src/api.ts'], diff: '+x', truncated: false }
  assert.equal(readDelivery(delivery), delivery)
  for (const broken of [{ ...delivery, diff: { text: '+x' } }, { ...delivery, changedPaths: 'src/api.ts' }, { ...delivery, truncated: 'no' }, { ...delivery, resultCommit: undefined }]) {
    assert.equal(readDelivery(broken), undefined)
  }
  const application = { status: 'conflicts', changedPaths: ['src/api.ts'], conflicts: ['src/api.ts'] }
  assert.equal(readDeliveryApplication(application), application)
  for (const broken of [{ ...application, status: 'merged' }, { ...application, conflicts: 'src/api.ts' }, { ...application, changedPaths: undefined }]) {
    assert.equal(readDeliveryApplication(broken), undefined)
  }
})

test('F2: the monitor refuses a state whose draft, start or budget would break render, and keeps the last good view', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const good = { ...live(), drafts: [draftItem()], starts: [startItem()] }
  const admitted = new SwarmMonitor(async endpoint => endpoint === 'state' ? good : await new Promise(() => {}))
  t.after(() => admitted.dispose())
  admitted.select('owner'); await flush()
  assert.equal(admitted.getSnapshot().data, good, 'a state of well-formed items is admitted as sent')
  for (const [label, mutate] of [
    ['a draft without input', state => { delete state.drafts[0].input }],
    ['a draft whose tasks are not a list', state => { state.drafts[0].input.tasks = {} }],
    ['a start with a malformed baseline', state => { state.starts[0].baseline.changedPaths = undefined }],
    ['starts that are not a list', state => { state.starts = { 'start-1': state.starts[0] } }],
    ['no initial budget', state => { delete state.defaultBudget }],
  ]) {
    const broken = { ...live(2), drafts: [draftItem()], starts: [startItem()] }; mutate(broken)
    const calls = []
    const monitor = new SwarmMonitor(async endpoint => {
      calls.push(endpoint)
      if (calls.length === 1) return good
      return endpoint === 'watch' ? { kind: 'snapshot', ownerSessionId: 'owner', revision: 2, state: broken, missionIds: ['mission-demo'] } : broken
    })
    monitor.select('owner'); await flush()
    t.mock.timers.tick(40); await flush()
    assert.equal(monitor.getSnapshot().data, good, `${label}: the last good view stays`)
    assert.equal(monitor.getSnapshot().connection, 'reconnecting', label)
    assert.match(monitor.getSnapshot().error, /Invalid swarm state from host/, label)
    t.mock.timers.tick(1000); await flush()
    assert.deepEqual(calls, ['state', 'watch', 'state'], `${label}: the refused update is retried as a full read`)
    assert.equal(monitor.getSnapshot().data, good, `${label}: a refused full read is not admitted either`)
    monitor.dispose()
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
  const props = { sessions: { list: fixed({ ids: ['owner'], byId: { owner: { retainedBy: { mainView: 1 } } } }) }, modelDirectories: { directoryFor() {} }, monitor,
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

test('F2: a malformed mission reply to a control or a task cancel is a request error, never the mission the board renders', async t => {
  const data = live(), endpoints = []
  const current = data.snapshots[0]
  const malformed = { ...current, mission: { ...current.mission, status: 'paused', updatedAt: current.mission.updatedAt + 1 }, tasks: undefined }
  const monitor = { getSnapshot: () => ({ ownerSessionId: 'owner', data, connection: 'connected', loading: false }), subscribe: () => () => {}, select() {}, refresh: async () => {},
    request: async endpoint => { endpoints.push(endpoint); return { snapshot: malformed } } }
  const panel = panelHarness(monitor); t.after(() => panel.dispose())
  const board = () => panel.find(node => node.props.onCancelTask !== undefined && node.props.snapshot !== undefined)
  const alert = () => panel.find(node => node.props.role === 'alert')?.props.children
  panel.render()
  panel.find(node => node.props['data-action'] === 'pause').props.onClick(); await flush(); panel.render()
  assert.equal(alert(), 'Invalid mission from host')
  assert.equal(board().props.snapshot, current, 'the board keeps the admitted mission')
  assert.ok(panel.find(node => node.props['data-action'] === 'pause'), 'the refused reply did not pause the mission on screen')
  assert.equal(panel.find(node => node.props['data-action'] === 'resume'), undefined)
  board().props.onCancelTask(current.tasks[4]); await flush(); panel.render()
  assert.equal(alert(), 'Invalid mission from host')
  assert.equal(board().props.snapshot, current)
  assert.deepEqual(endpoints, ['control', 'cancel'])
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
  registerWebApi(ctx, makeRuntimeStub(), { defaultBudget: uiSnapshot().mission.budget, maxPayloadBytes: 8192 })
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
