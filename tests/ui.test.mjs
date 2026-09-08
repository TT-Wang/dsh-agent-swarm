import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'
import { taskLane, remainingPercent, snapshotFromResult } from '../lib/types/client/projection.js'
import { swarmCardDefinition } from '../lib/types/client/card-definition.js'
import { SwarmBoard } from '../lib/types/client/SwarmBoard.js'
import { SwarmMonitor } from '../lib/types/client/monitor.js'
import { openWorker } from '../lib/types/client/navigation.js'
import { fitSidebar } from '../lib/types/client/SidebarDock.js'
import { DraftEditor, cleanPlan, newPlan } from '../lib/types/client/DraftEditor.js'
import { CopyContext, zh } from '../lib/types/client/locale.js'
import { validatePlan } from '../lib/plans.js'
import { selectedOperation } from '../lib/types/client/selection.js'
import { WorkerHistory, transcriptEntry } from '../lib/types/client/history.js'
import { WorkerTranscript } from '../lib/types/client/WorkerTranscript.js'

const testLocale = () => ({ register() { return () => {} }, bind() { return text => text } })

async function nativeClient(packageName) {
  const require = createRequire(import.meta.url)
  const runtimeDir = dirname(require.resolve(`${packageName}/package.json`))
  const styleLoader = registerHooks({ load(url, context, nextLoad) {
    if (new URL(url).pathname.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }
    return nextLoad(url, context)
  } })
  try {
    let plugin
    runInNewContext(await readFile(join(runtimeDir, 'lib/client.js'), 'utf8'), {
      setTimeout, clearTimeout, AbortController, queueMicrotask, console,
      window: { __ModuleLoader__: { load({ factory }) { plugin = factory(require) } } },
    })
    return plugin
  } finally { styleLoader.deregister() }
}

test('board distinguishes dependency-blocked work from dispatchable work and clamps budget', () => {
  const { tasks } = uiSnapshot()
  assert.equal(taskLane(tasks[2], tasks), 'blocked')
  assert.equal(taskLane(tasks[4], tasks), 'ready')
  assert.equal(taskLane(tasks[0], tasks), 'done')
  const review = { ...tasks[2], dependencies: [], reviewOf: tasks[1].id }
  assert.equal(taskLane(review, tasks), 'blocked', 'review waits for source submission')
  assert.equal(taskLane({ ...review, reviewOf: 'missing-source' }, tasks), 'blocked', 'missing review source is never ready')
  assert.equal(taskLane(review, tasks.map(task => task.id === review.reviewOf ? { ...task, status: 'submitted' } : task)), 'ready')
  assert.equal(remainingPercent(140, 100), 0)
  assert.equal(remainingPercent(0, 0), 0)
})

test('UI reads native private metadata and rejects incompatible historical payloads', () => {
  const snapshot = uiSnapshot()
  assert.deepEqual(snapshotFromResult({ swarmSnapshot: snapshot }, []), snapshot)
  assert.deepEqual(snapshotFromResult(undefined, [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({ snapshot }) }] }]), snapshot)
  assert.equal(snapshotFromResult({ swarmSnapshot: { mission: { id: 'broken' } } }, []), undefined)
  assert.equal(snapshotFromResult(undefined, [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: JSON.stringify(snapshot) }] }]), undefined)
})

test('native conversation fold presents only successful explicit swarm observations', () => {
  const snapshot = uiSnapshot()
  const start = { event: { type: 'tool/call', seq: 4, data: { name: 'swarm_observe', callId: 'call-1' } }, location: { kind: 'unresolved' } }
  assert.deepEqual(swarmCardDefinition.match(start.event), { id: 'call-1', role: 'start' })
  assert.equal(swarmCardDefinition.match({ ...start.event, data: { ...start.event.data, name: 'other_tool' } }), null)
  const context = { state: {}, start, id: 'call-1', key: 'key' }
  const result = { event: { type: 'tool/result', data: { meta: { swarmSnapshot: snapshot }, message: { source: { kind: 'tool', callId: 'call-1' }, content: [] } } } }
  context.state = swarmCardDefinition.update(context, result)
  assert.equal(swarmCardDefinition.buildViewNode(context).data.mission.id, snapshot.mission.id)
  assert.deepEqual(swarmCardDefinition.update({ ...context, state: {} }, { event: { ...result.event, data: { ...result.event.data, error: { name: 'Error' } } } }), {})
})

test('current native Conversation assembler rebuilds swarm cards from durable tool events', async () => {
  const { ConversationNodeAssembler } = await nativeClient('@deepseek-ai/dsh-client-ui-conversation')
  const snapshot = uiSnapshot()
  const definition = { target: 'chat', create: () => ({ empty: [], replace: ({ nodes }) => nodes, apply: ({ upserts }) => upserts }) }
  const assembler = new ConversationNodeAssembler({ entries: () => [swarmCardDefinition], fallbackEntry: () => undefined }, { entries: () => [definition] })
  assembler.activateTarget('chat')
  const call = { type: 'event', event: { type: 'tool/call', seq: 4, time: 4, data: { name: 'swarm_observe', callId: 'call-1', arguments: '{}' } } }
  const result = { type: 'event', event: { type: 'tool/result', seq: 5, time: 5, data: { meta: { swarmSnapshot: snapshot }, message: { source: { kind: 'tool', callId: 'call-1' }, content: [] } } } }
  assembler.replaceWindow([call, result], false)
  assembler.flush()
  const cards = assembler.get('chat')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].target, 'chat')
  assert.equal(cards[0].anchorSeq, 4)
  assert.equal(cards[0].visibility, 'visible')
  assert.equal(cards[0].data.mission.id, snapshot.mission.id)
  assembler.replaceWindow([result], true)
  assembler.flush()
  assert.equal(assembler.get('chat').length, 0, 'a page with no explicit swarm call cannot invent a card')
})

test('render includes evidence provenance, challenges, attempts, blockers and inert peer text', () => {
  const snapshot = uiSnapshot()
  snapshot.mission.title = '<script>steal()</script>'
  const board = renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot }))
  assert.match(board, /Attempt 2/)
  assert.match(board, /Waiting for source submission/)
  assert.match(board, /Snapshot\. Open the sidebar for live progress\./)
  assert.match(board, /&lt;script&gt;steal\(\)&lt;\/script&gt;/)
  assert.doesNotMatch(board, /<script>/)
  const evidence = renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, initialView: 'evidence' }))
  assert.match(evidence, /tool-run-018/)
  assert.match(evidence, /bc918def1234567890abcdef1234567890abcdef12/)
  assert.match(evidence, /crash after acceptance/)
  const activity = renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, initialView: 'activity' }))
  assert.match(activity, /evidence \/ challenged/)
})

test('built client closure loads in Harness module protocol and owns reversible registrations', async () => {
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const require = createRequire(import.meta.url)
  let plugin, loadedId, styleRemoved = false
  const effects = [], definitions = [], slots = []
  const document = { createElement: () => ({ dataset: {}, textContent: '', remove() { styleRemoved = true } }), head: { appendChild() {} } }
  runInNewContext(code, { document, setTimeout, clearTimeout, AbortController, window: { __ModuleLoader__: { load({ id, factory }) { loadedId = id; plugin = factory(require) } } } })
  assert.equal(loadedId, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).name)
  const ctx = { effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    locale: testLocale(), inject() { return { dispose() {} } }, on() { return () => {} },
    uiConversation: { events: { register(value) { definitions.push(value); return () => definitions.pop() } } },
    slots: { inject(name, fn) { effects.push(fn()) }, register(options, component) { slots.push({ options, component }); return () => slots.pop() } } }
  plugin.apply(ctx)
  assert.equal(definitions[0].kind, 'agent-swarm')
  assert(slots.some(slot => slot.options.name === 'conversation.chat.node' && slot.options.key === 'agent-swarm'))
  assert(slots.some(slot => slot.options.name === 'conversation.chat.commandview' && slot.options.key === 'agent-swarm'))
  assert(slots.some(slot => slot.options.name === 'shell.overlay' && slot.options.id === 'agent-swarm-sidebar'))
  for (const dispose of effects.reverse()) dispose?.()
  assert.equal(styleRemoved, true)
  assert.equal(slots.length, 0)
})

test('built client mounts and unloads with the actual Harness Cordis and browser registries', async () => {
  const require = createRequire(import.meta.url)
  const { Context } = await import('@deepseek-ai/cordis')
  const { SlotRegistry } = await nativeClient('@deepseek-ai/dsh-client-ui-renderer')
  const { UiConversation } = await nativeClient('@deepseek-ai/dsh-client-ui-conversation')
  const ctx = new Context()
  ctx.provide('sessions', {})
  ctx.provide('connection', {})
  ctx.provide('modelDirectories', {})
  ctx.provide('locale', testLocale())
  const slotFiber = ctx.plugin(SlotRegistry)
  const eventFiber = ctx.plugin({ name: 'test-native-conversation', apply(scope) { new UiConversation(scope, scope.sessions) } })
  await slotFiber
  await eventFiber
  let plugin, removed = false
  const document = { createElement: () => ({ dataset: {}, remove() { removed = true } }), head: { appendChild() {} } }
  runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    document, setTimeout, clearTimeout, AbortController, window: { __ModuleLoader__: { load({ factory }) { plugin = factory(require) } } },
  })
  const surface = ctx.plugin({ name: 'test-conversation-surface', inject: ['slots'], apply(host) {
    host.slots.register({ name: 'root', children: { 'conversation.chat.node': { kind: 'keyed', scope: 'session' }, 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' }, 'shell.overlay': { kind: 'list', scope: 'root' } } }, () => null)
  } })
  await surface
  const feature = ctx.plugin(plugin)
  try {
    await feature
    assert.equal(ctx.uiConversation.events.entries().some(item => item.kind === 'agent-swarm'), true)
    assert.equal(ctx.slots.entries('conversation.chat.node').some(item => item.options.key === 'agent-swarm'), true)
    assert.equal(ctx.slots.entries('conversation.chat.commandview').some(item => item.options.key === 'agent-swarm'), true)
    assert.equal(ctx.slots.entries('shell.overlay').some(item => item.options.id === 'agent-swarm-sidebar'), true)
    await feature.dispose()
    assert.equal(ctx.uiConversation.events.entries().some(item => item.kind === 'agent-swarm'), false)
    assert.equal(ctx.slots.entries('conversation.chat.node').length, 0)
    assert.equal(ctx.slots.entries('conversation.chat.commandview').length, 0)
    assert.equal(ctx.slots.entries('shell.overlay').length, 0)
    assert.equal(removed, true)
  } finally {
    await feature.dispose()
    await surface.dispose()
    await eventFiber.dispose()
    await slotFiber.dispose()
  }
})

test('live monitor fences switched-session responses and aborts all work on disposal', async () => {
  const calls = []
  const monitor = new SwarmMonitor((endpoint, payload, signal) => new Promise(resolve => calls.push({ endpoint, payload, signal, resolve })))
  const response = ownerSessionId => ({ ownerSessionId, workspace: '/repo', snapshots: [uiSnapshot()], drafts: [], defaultBudget: uiSnapshot().mission.budget, writable: true, ownerLive: true })
  try {
    monitor.select('owner-a')
    monitor.select('owner-b')
    assert.equal(calls[0].signal.aborted, true)
    calls[1].resolve(response('owner-b'))
    await new Promise(resolve => setImmediate(resolve))
    calls[0].resolve(response('owner-a'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(monitor.getSnapshot().data.ownerSessionId, 'owner-b')
    const pending = monitor.refresh()
    monitor.dispose()
    assert.equal(calls[2].signal.aborted, true)
    calls[2].resolve(response('owner-b'))
    await pending
    assert.equal(calls.length, 3)
  } finally { monitor.dispose() }
})

test('worker navigation opens its independent native session and rejects missing list entries', async () => {
  const opened = []
  const sessions = { list: { getSnapshot: () => ({ byId: { worker: { id: 'worker' } } }) }, open: sessionId => opened.push(sessionId) }
  assert.equal(openWorker(sessions, 'worker'), true)
  assert.deepEqual(opened, ['worker'])
  assert.equal(openWorker(sessions, 'missing'), false, 'missing live row delegates to read-only native history')
  assert.equal(opened.length, 1)
})

test('draft defaults preserve independent verification and line editing; sidebar leaves room for conversation', () => {
  const input = newPlan('/repo', uiSnapshot().mission.budget)
  assert.equal(input.tasks[1].reviewOf, input.tasks[0].key)
  assert.notEqual(input.tasks[0].assigneeKey, input.tasks[1].assigneeKey)
  assert.equal(input.tasks[0].checks.length > 0, true, 'code task template carries the required host checks')
  input.title = 'Template test'; input.objective = 'Deliver the test objective'
  assert.doesNotThrow(() => validatePlan(input))
  assert.equal(input.acceptance.every(criterion => input.tasks[0].acceptance.includes(criterion) && input.tasks[1].acceptance.includes(criterion)), true, 'template task acceptance covers the mission contract')
  input.scope = ['src/', '', ' tests/ ']
  assert.deepEqual(cleanPlan(input).scope, ['src/', 'tests/'])
  assert.deepEqual(input.scope, ['src/', '', ' tests/ '], 'normalization does not change an in-progress field')
  assert.equal(fitSidebar(480, 1440), 480)
  assert.equal(fitSidebar(900, 1440), 760)
  assert.equal(fitSidebar(900, 1000), 600)
  assert.equal(fitSidebar(Number.NaN, 1440), 480)

})

test('graph and Chinese card render real task/evidence projections and worker links', () => {
  const snapshot = uiSnapshot()
  const graph = renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, initialView: 'graph' }))
  assert.match(graph, /sw-graph-node/)
  assert.match(graph, /role="tabpanel" aria-label="Dependency graph"/)
  assert.match(graph, /stroke-dasharray="4 4"/)
  const chinese = renderToStaticMarkup(React.createElement(CopyContext.Provider, { value: text => zh[text] ?? text }, React.createElement(SwarmBoard, { snapshot, onOpenWorker() {} })))
  assert.match(chinese, /任务看板/)
  assert.match(chinese, /data-worker-session=/)
  assert.match(chinese, /打开对话/)
})

test('draft model picker preserves explicit model with inherited provider and shows source checks', () => {
  const input = newPlan('/repo', uiSnapshot().mission.budget)
  input.title = 'Model plan'; input.objective = 'Check model selection'
  input.members[0].model = 'custom-model'
  input.tasks[0].checks = ['node verify.cjs']
  delete input.tasks[1].checks
  const catalog = { current: { provider: 'provider-a', model: 'default-model' }, groups: [{ id: 'provider-a', name: 'Provider A', models: [{ id: 'custom-model', name: 'Custom model' }] }], status: 'ready', failures: [], error: null }
  const directory = { store: { subscribe: () => () => {}, getSnapshot: () => catalog }, load: async () => catalog }
  const draft = { id: 'draft-ui', ownerSessionId: 'owner', revision: 1, status: 'draft', input, createdAt: 1, updatedAt: 1 }
  const html = renderToStaticMarkup(React.createElement(DraftEditor, { sessionId: 'owner', workspace: '/repo', budget: input.budget, draft, directory, request: async () => ({}), onSaved() {}, onLaunched() {}, onDiscarded() {} }))
  assert.match(html, /Owner provider \/ custom-model/)
  assert.match(html, /value="\[null,&quot;custom-model&quot;\]" selected=""/)
  assert.match(html, /readonly=""[^>]*>node verify.cjs/)
  assert.match(html, /data-action="launch-draft"[^>]*>Launch mission/)
})

test('deferred mutation success and failure cannot update a different selected conversation', async () => {
  for (const outcome of ['success', 'failure']) {
    let selected = 'owner-a', resolve, reject
    const writes = []
    const pending = selectedOperation(() => selected === 'owner-a', () => new Promise((accept, fail) => { resolve = accept; reject = fail }), {
      success: value => { writes.push(['launch', value]) }, failure: error => { writes.push(['error', error]) }, settled: () => { writes.push(['busy', false]) },
    })
    selected = 'owner-b'
    if (outcome === 'success') resolve({ mission: { ownerSessionId: 'owner-a' } })
    else reject(new Error('old session action failed'))
    await pending
    assert.deepEqual(writes, [], `${outcome} is fenced after switching owner`)
  }
})

test('cold worker history paginates native events, renders inert tool results, and fences closed views', async () => {
  const requests = [], pending = []
  const history = new WorkerHistory((sessionId, beforeSeq) => {
    requests.push({ sessionId, beforeSeq })
    return new Promise(resolve => pending.push(resolve))
  })
  history.open('worker-a', 'Builder')
  pending[0]({ events: [{ event: { seq: 8, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: '<script>untrusted()</script> command output' }] }] } } } }], hasMore: true })
  await new Promise(resolve => setImmediate(resolve))
  const html = renderToStaticMarkup(React.createElement(WorkerTranscript, { history }))
  assert.match(html, /Read-only worker transcript/)
  assert.match(html, /Tool error/, 'native nested tool-result failure is labelled correctly')
  assert.match(html, /&lt;script&gt;untrusted\(\)&lt;\/script&gt;/)
  assert.doesNotMatch(html, /<script>/)
  const older = history.load()
  assert.deepEqual(requests[1], { sessionId: 'worker-a', beforeSeq: 8 })
  pending[1]({ events: [{ event: { seq: 2, type: 'user/message', data: { content: [{ type: 'text', text: 'Assignment' }] } } }], hasMore: false })
  await older
  assert.deepEqual(history.getSnapshot().entries.map(entry => entry.event.seq), [2, 8])
  assert.equal(transcriptEntry(history.getSnapshot().entries[0]).text, 'Assignment')
  history.open('worker-b', 'Reviewer')
  history.close()
  pending[2]({ events: [{ event: { seq: 1, type: 'user/message', data: { content: 'late' } } }], hasMore: false })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(history.getSnapshot().sessionId, undefined)
  assert.deepEqual(history.getSnapshot().entries, [])
  assert.equal(requests.length, 3, 'history performs only the requested read pages')
  history.dispose()
})

test('hidden sidebar monitor retains editor input data while stopping requests and resumes its own scope', async () => {
  const calls = []
  const monitor = new SwarmMonitor((endpoint, payload, signal) => new Promise(resolve => calls.push({ payload, signal, resolve })))
  const response = ownerSessionId => ({ ownerSessionId, workspace: '/repo', snapshots: [uiSnapshot()], drafts: [], defaultBudget: uiSnapshot().mission.budget, writable: true, ownerLive: true })
  try {
    monitor.select('pinned-owner')
    calls[0].resolve(response('pinned-owner'))
    await new Promise(resolve => setImmediate(resolve))
    const cached = monitor.getSnapshot().data
    const pending = monitor.refresh()
    monitor.select('pinned-owner', false)
    assert.equal(calls[1].signal.aborted, true)
    assert.equal(monitor.getSnapshot().data, cached, 'hidden editor keeps its existing data instead of being unmounted')
    await monitor.refresh()
    assert.equal(calls.length, 2, 'hidden view does not issue requests')
    calls[1].resolve(response('other-owner'))
    await pending
    assert.equal(monitor.getSnapshot().data, cached, 'cancelled response cannot replace the retained scope')
    monitor.select('pinned-owner', true)
    assert.equal(calls.length, 3)
    assert.equal(calls[2].payload.sessionId, 'pinned-owner')
    calls[2].resolve(response('pinned-owner'))
    await new Promise(resolve => setImmediate(resolve))
  } finally { monitor.dispose() }
})
