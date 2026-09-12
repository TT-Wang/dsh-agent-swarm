import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'
import { taskLane, remainingPercent, snapshotFromResult, readSnapshot, deliverableCommit, completionBlocker } from '../lib/types/client/projection.js'
import { leaseExpired } from '../lib/types/client/clock.js'
import { swarmCardDefinition } from '../lib/types/client/card-definition.js'
import { SwarmBoard } from '../lib/types/client/SwarmBoard.js'
import { ActivityPanel, CompletionControls } from '../lib/types/client/ActivityPanel.js'
import { SwarmMonitor } from '../lib/types/client/monitor.js'
import { openWorker } from '../lib/types/client/navigation.js'
import { fitSidebar, hostShiftTarget, dockShift } from '../lib/types/client/SidebarDock.js'
import { createRightSidebarAdapter } from '../lib/types/client/sidebar.js'
import { WorkerAvatar } from '../lib/types/client/MissionProgress.js'
import { DisposalRegistry } from '../lib/types/client/lifecycle.js'
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

test('board separates queued, blocked and cancelled work and clamps budget', () => {
  // OWNER PASS 2026-09-11: waiting on live work is "queued"; only a dead
  // prerequisite, a stopped assignee or a vanished review source is "blocked";
  // withdrawals get their own lane instead of sharing it with blocked work.
  const { tasks } = uiSnapshot()
  assert.equal(taskLane(tasks[2], tasks), 'queued', 'a review whose source is still running is queued, not blocked')
  assert.equal(taskLane(tasks[4], tasks), 'ready')
  assert.equal(taskLane(tasks[0], tasks), 'done')
  const review = { ...tasks[2], dependencies: [], reviewOf: tasks[1].id }
  assert.equal(taskLane(review, tasks), 'queued', 'review waits for source submission')
  assert.equal(taskLane({ ...review, reviewOf: 'missing-source' }, tasks), 'blocked', 'missing review source is never ready')
  assert.equal(taskLane(review, tasks.map(task => task.id === review.reviewOf ? { ...task, status: 'submitted' } : task)), 'ready')
  const cancelled = { ...tasks[4], status: 'cancelled' }
  assert.equal(taskLane(cancelled, tasks), 'cancelled', 'a withdrawal has its own lane')
  const blockedByDead = { ...tasks[4], dependencies: [cancelled.id] }
  assert.equal(taskLane(blockedByDead, [...tasks, cancelled]), 'blocked', 'a dead prerequisite blocks instead of queueing')
  const queuedBehindLive = { ...tasks[4], dependencies: [tasks[1].id] }
  assert.equal(taskLane(queuedBehindLive, tasks), 'queued', 'a live prerequisite queues instead of blocking')
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
  const board = renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, initialView: 'board' }))
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
  const chinese = renderToStaticMarkup(React.createElement(CopyContext.Provider, { value: text => zh[text] ?? text }, React.createElement(SwarmBoard, { snapshot, initialView: 'board', onOpenWorker() {} })))
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

test('default plan ships a real artifact-exercising host check instead of a whitespace diff', () => {
  const input = newPlan('/repo', uiSnapshot().mission.budget)
  assert.deepEqual(input.tasks[0].checks, ['npm test'])
  assert.equal(input.tasks[0].checks.some(check => /git diff --check/.test(check)), false, 'a whitespace diff cannot prove the acceptance criteria')
  assert.match(input.tasks[0].checks[0], /^(?:npm|pnpm|yarn|node|npx)\s/, 'the default check must exercise the artifact')
  input.title = 'Default check'; input.objective = 'Prove the default check exercises the artifact'
  assert.doesNotThrow(() => validatePlan(input))
  const html = renderToStaticMarkup(React.createElement(DraftEditor, { sessionId: 'owner', workspace: '/repo', budget: input.budget, request: async () => ({}), onSaved() {}, onLaunched() {}, onDiscarded() {} }))
  assert.match(html, /readonly=""[^>]*>npm test/, 'the verification task inherits the real source check')
  assert.doesNotMatch(html, /git diff --check/)
})

test('Complete is gated by the runtime completion projection and shows its blocking reason', async () => {
  const snapshot = uiSnapshot()
  snapshot.mission.status = 'active'
  snapshot.tasks = snapshot.tasks.map(task => ({ ...task, status: 'accepted', dependencies: [], reviewOf: undefined, attempt: undefined }))
  const render = value => renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot: value, initialView: 'board',
    technicalDetails: React.createElement(CompletionControls, { snapshot: value, disabled: false, onComplete() {} }) }))
  assert.match(render(snapshot), /data-action="complete">/, 'a snapshot without the projection keeps the historical terminal-work gate')
  const blocked = { ...snapshot, completion: { eligible: false, reason: 'Unresolved evidence challenges prevent completion: ev-2' } }
  assert.match(render(blocked), /data-action="complete" disabled=""/)
  assert.match(render(blocked), /data-swarm-completion="blocked"/)
  assert.match(render(blocked), /Unresolved evidence challenges prevent completion: ev-2/)
  assert.match(render({ ...snapshot, completion: { eligible: true } }), /data-action="complete">/)
  const source = await readFile(new URL('../src/client/ActivityPanel.tsx', import.meta.url), 'utf8')
  assert.match(source, /<CompletionControls snapshot=\{snapshot\} disabled=\{disabled\}/, 'ActivityPanel renders the gated Complete control')
})

test('live lease marker uses the wall clock instead of the last recorded event time', () => {
  const snapshot = uiSnapshot()
  const leaseUntil = Date.now() - 300_000
  snapshot.tasks[1].attempt = { ...snapshot.tasks[1].attempt, leaseUntil }
  snapshot.mission.updatedAt = leaseUntil - 60_000
  assert.equal(leaseExpired(leaseUntil, snapshot.mission.updatedAt), false, 'the recorded reference predates the expiry')
  assert.equal(leaseExpired(leaseUntil, Date.now()), true, 'the runtime compares the lease with the wall clock')
  const live = renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, live: true, initialView: 'board' }))
  assert.match(live, /\(expired\)/)
  snapshot.tasks[1].attempt = { ...snapshot.tasks[1].attempt, leaseUntil: Date.now() + 3_600_000 }
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, live: true, initialView: 'board' })), /\(expired\)/)
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, initialView: 'board' })), /\(expired\)/, 'a historical card keeps its recorded reference')
})

test('SwarmBoard card labels render through the locale instead of raw English literals', () => {
  const snapshot = uiSnapshot()
  snapshot.tasks[4].dependencies = ['t3']
  snapshot.tasks[3].experiment = true
  const english = renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, initialView: 'board' }))
    + renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, initialView: 'evidence' }))
  assert.match(english, /Attempt 2/)
  assert.match(english, /· lease /)
  assert.match(english, /Waiting on 1 prerequisite/)
  assert.match(english, /1 evidence record/)
  assert.match(english, /Artifact [0-9a-f]{8}/)
  assert.match(english, /Prerequisites: /)
  assert.match(english, /Reviews t2/)
  assert.match(english, /Artifact commit: /)
  const chinese = renderToStaticMarkup(React.createElement(CopyContext.Provider, { value: text => zh[text] ?? text },
    React.createElement(SwarmBoard, { snapshot, initialView: 'board' })))
    + renderToStaticMarkup(React.createElement(CopyContext.Provider, { value: text => zh[text] ?? text },
      React.createElement(SwarmBoard, { snapshot, initialView: 'evidence' })))
  for (const untranslated of [/Attempt \d/, /· lease /, /Waiting on \d/, /\d evidence record/, /Artifact [0-9a-f]{8}/,
    /Prerequisites: /, /Reviews /, /Artifact commit: /, /Host tool run IDs: /, /Tool records: /, /Challenge ·/]) {
    assert.doesNotMatch(chinese, untranslated, `untranslated SwarmBoard label ${untranslated}`)
  }
  assert.match(chinese, /尝试次数 2/)
  assert.match(chinese, /租约/)
  assert.match(chinese, /等待 1 个前置任务/)
  assert.match(chinese, /1 条证据记录/)
  assert.match(chinese, /产物 [0-9a-f]{8}/)
  assert.match(chinese, /前置任务: /)
  assert.match(chinese, /审查 t2/)
  assert.match(chinese, /产物提交: /)
})

test('snapshot reader validates every budget key and the runtime-projected delivery fields', () => {
  const snapshot = uiSnapshot()
  const missingDuration = JSON.parse(JSON.stringify(snapshot))
  delete missingDuration.mission.budget.maxDurationMs
  assert.equal(readSnapshot(missingDuration), undefined, 'a budget without maxDurationMs is not a valid snapshot')
  assert.deepEqual(readSnapshot(snapshot), snapshot)
  assert.equal(readSnapshot({ ...snapshot, deliveryTarget: { taskId: 't1' } }), undefined)
  assert.equal(readSnapshot({ ...snapshot, completion: { eligible: 'yes' } }), undefined)
  assert.equal(readSnapshot({ ...snapshot, appliedDelivery: { resultCommit: 5 } }), undefined)
  const projected = { ...snapshot, deliveryTarget: { taskId: 't1', commit: 'a'.repeat(40) },
    completion: { eligible: false, reason: 'still blocked' }, appliedDelivery: { resultCommit: 'a'.repeat(40), appliedAt: 1 } }
  assert.deepEqual(readSnapshot(projected), projected)
  assert.equal(deliverableCommit(projected), 'a'.repeat(40))
  assert.equal(completionBlocker(projected), 'still blocked')
})

test('OWNER PASS 2026-09-11 (C3): the dock shifts a discovered host root by inline style, not by an id rule', async () => {
  // The reservation must follow the dock, so it is computed for the same four
  // geometries the dock itself uses.
  assert.deepEqual(dockShift(true, 480, 1440), { width: 'calc(100% - 480px)' })
  assert.deepEqual(dockShift(false, 480, 1440), { width: 'calc(100% - 28px)' }, 'the collapsed launcher keeps its 28px strip')
  assert.deepEqual(dockShift(true, 480, 600), { width: '100%', height: '55dvh' }, 'a narrow viewport stacks the dock under the app')
  assert.deepEqual(dockShift(false, 480, 600), { width: '100%', height: 'calc(100dvh - 40px)' }, 'a collapsed narrow dock is only its 40px bar')
  // The target is discovered structurally: the child of the body above the dock.
  const body = { style: {}, parentElement: null }
  const root = { style: {}, parentElement: body }
  const shell = { style: {}, parentElement: root }
  const dock = { style: {}, parentElement: shell }
  assert.equal(hostShiftTarget(dock, node => node === body), root, 'the app root is whatever sits directly under the body')
  assert.equal(hostShiftTarget({ style: {}, parentElement: body }, node => node === body), undefined,
    'a dock that is itself a body child has no host root to move')
  assert.equal(hostShiftTarget({ style: {}, parentElement: null }, node => node === body), undefined, 'a detached dock moves nothing')
  assert.equal(hostShiftTarget(undefined, node => node === body), undefined)
  // C3 is only closed if the sheet no longer names the host's id or forces the
  // layout with !important; the dock's own geometry stays in CSS.
  const styles = await readFile(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(styles, /#root/, 'the dock no longer depends on the host root id')
  assert.doesNotMatch(styles, /\[data-swarm-docked\][^{}]*\{[^}]*!important/, 'and no dock rule has to outrank the host with !important')
  for (const rule of ['.sw-lane-count', '.sw-lane[data-empty]', '.sw-activity-group', '.sw-why']) {
    assert.ok(styles.includes(rule), `the second-pass styles ship ${rule}`)
  }
  assert.match(styles, /\.sw-lane\[data-empty\]\{opacity:\.55;align-self:start\}/,
    'an empty lane stops stretching to its row height, so it is one header tall instead of a full-height empty column')
  const dockSource = await readFile(new URL('../src/client/SidebarDock.tsx', import.meta.url), 'utf8')
  assert.match(dockSource, /style\.width = previous\.width/, 'the host inline style is restored on unload')
})

test('OWNER PASS 2026-09-11 (C2): the pane registry disposes a resource exactly once, even after the drain', async () => {
  const calls = []
  const registry = new DisposalRegistry()
  const first = { dispose: () => calls.push('first') }, second = { dispose: () => calls.push('second') }
  assert.equal(registry.add(first), first, 'add returns the resource so a render can use it inline')
  assert.equal(registry.size, 1)
  registry.release(first)
  registry.release(first)
  assert.deepEqual(calls, ['first'], 'releasing twice disposes once, so the unmount effect is idempotent')
  assert.equal(registry.size, 0)
  registry.add(second)
  registry.dispose()
  registry.dispose()
  assert.deepEqual(calls, ['first', 'second'], 'the plugin drain disposes what unmount did not, and is idempotent')
  assert.equal(registry.drained, true)
  // The point of the registry: a pane that mounts during unload cannot leak.
  const late = { dispose: () => calls.push('late') }
  registry.add(late)
  assert.deepEqual(calls, ['first', 'second', 'late'], 'a resource registered after the drain is disposed at once')
  assert.equal(registry.size, 0)
  // The plugin scope really wires the registry: the effect that drains it must exist.
  const index = await readFile(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  assert.match(index, /disposals\.add\(new SwarmMonitor\(request\)\), \[request\]/, 'the monitor registers with the pane registry and re-creates with its request')
  assert.match(index, /disposals\.release\(monitor\)/, 'unmount releases the monitor through the registry')
  assert.match(index, /ctx\.effect\(\(\) => \(\) => disposals\.dispose\(\), 'agent-swarm: pane resources'\)/, 'plugin unload drains the registry')
})

test('OWNER PASS 2026-09-11 #2: the avatar scales in half steps and the controls row never wraps', async () => {
  const render = props => renderToStaticMarkup(React.createElement(WorkerAvatar, props))
  assert.match(render({ name: 'Nova' }), /width="32" height="32" viewBox="0 0 32 32"/, 'the default renders the sprite grid exactly')
  assert.match(render({ name: 'Nova', size: 48 }), /width="48" height="48" viewBox="0 0 32 32"/, '48px is 1.5x the grid, so the cells stay integer')
  assert.match(render({ name: 'Nova', size: 28 }), /width="32" height="32"/, 'a smaller request never shrinks below the grid; the stylesheet sizes the header')
  assert.equal(render({ name: 'Nova' }), render({ name: 'Nova', size: 32 }))
  const styles = await readFile(new URL('../src/client/styles.ts', import.meta.url), 'utf8')
  assert.match(styles, /\.sw-actions\{display:flex;align-items:flex-start;gap:10px;flex-wrap:nowrap;overflow-x:auto/,
    'the mission control row is one horizontal row that scrolls instead of wrapping')
  assert.match(styles, /\.sw-actions>\.sw-mission-controls\{padding:0;flex:0 0 auto;flex-wrap:nowrap;align-items:flex-start\}/)
  assert.match(styles, /\.sw-member-head\{display:grid;grid-template-columns:auto minmax\(0,1fr\);gap:12px/, 'the member head is avatar + identity')
  assert.match(styles, /\.sw-complete-control\{display:flex;flex-direction:column/, 'the completion blocker is the button caption, not an inline sentence that displaces Stop')
  assert.match(styles, /\.sw-complete-control>\[data-swarm-completion\]\{max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis/, 'and it is bounded with an ellipsis')
  assert.match(styles, /\.sw-member \.sw-worker-avatar\{width:48px;height:48px;border-radius:11px/, 'the member avatar is 48px')
  assert.match(styles, /\.sw-team \.sw-workers\{margin-top:10px;grid-template-columns:repeat\(auto-fit,minmax\(240px,1fr\)\)\}/, 'the roster widens for the larger card')
})

test('right sidebar adapter: one tab type, its body seat, and host navigation', async () => {
  // A fake host modelled on the real right-sidebar kit: the registry takes the
  // tab type, the slot service takes the body under the same id, and the
  // controller opens the pane by kind.
  const types = [], seats = []
  const registry = { register(definition) { types.push(definition); return () => { types.splice(types.indexOf(definition), 1) } } }
  const slots = {
    inject(name, factory) { const release = factory(); return () => release?.() },
    register(options, component) { const entry = { slot: options.name, key: options.key, component }; seats.push(entry); return () => { const at = seats.indexOf(entry); if (at >= 0) seats.splice(at, 1) } },
  }
  const opened = []
  const ctx = {
    inject(names, factory) {
      const scope = { effect: fn => { const cleanup = fn(); return { dispose: async () => { cleanup?.() } } }, get: name => (name === 'slots' ? slots : name === 'sidebarRightTabs' ? registry : undefined) }
      const release = factory(scope)
      return { dispose: async () => { await release?.dispose?.() } }
    },
    get: name => (name === 'sidebarRight' ? { openTab: (kind, options) => opened.push(`${kind}:${JSON.stringify(options)}`) } : undefined),
    effect: fn => { fn() },
  }
  const describe = () => ({ id: 'dsh-external-agent-swarm', kind: 'agent-swarm', order: 80, label: () => 'Agent Swarm', description: () => 'Missions, workers and evidence for this conversation', component: () => null })
  const adapter = createRightSidebarAdapter(ctx, describe)
  assert.equal(adapter.getSnapshot(), true, 'a registered tab reports integrated, so the dock stays hidden')
  assert.deepEqual(types.map(type => [type.id, type.kind, type.title()]), [['dsh-external-agent-swarm', 'agent-swarm', 'Agent Swarm']],
    'the tab type carries the implementation id, the kind navigation names, and its chip title')
  assert.deepEqual(types[0].guide.map(entry => [entry.order, entry.title(), entry.description()]),
    [[80, 'Agent Swarm', 'Missions, workers and evidence for this conversation']],
    'and one guide capsule, which is the only route to a page type from the UI')
  assert.deepEqual(seats.map(seat => [seat.slot, seat.key, typeof seat.component]), [['sidebar.right.pane.tab', 'dsh-external-agent-swarm', 'function']],
    'the body sits in the keyed seat under that same id')
  assert.equal(adapter.open(), true)
  assert.deepEqual(opened, ['agent-swarm:{"revealIfOpened":true}'], 'open() reveals the tab through the host controller')
  adapter.dispose()
  adapter.dispose()
  assert.equal(adapter.getSnapshot(), false, 'disposal releases the type and the seat')
  assert.deepEqual(types, [])
  assert.deepEqual(seats, [])
  assert.equal(adapter.open(), false, 'a disposed adapter never reveals anything')

  // Hosts without a right sidebar (0.1.2/0.1.3) must fall back, not throw.
  const bare = { inject: () => ({ dispose: async () => {} }), get: () => undefined, effect: () => {} }
  const fallback = createRightSidebarAdapter(bare, describe)
  assert.equal(fallback.getSnapshot(), false)
  assert.equal(fallback.open(), false, 'without the registry the adapter reports not-integrated and the dock renders')
  fallback.dispose()
  // The adapter must stay structural: importing the sidebar package would pull a
  // 0.1.5-only peer into a plugin that also loads on 0.1.2/0.1.3.
  const source = await readFile(new URL('../src/client/sidebar.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from '@deepseek-ai\/dsh-client-ui-sidebar-right/, 'no static import of the right-sidebar package')
  assert.match(source, /slots\.inject\('sidebar\.right\.pane\.tab'/, 'the body registers by slot name')
  assert.match(source, /registry\.register\(\{/, 'the type registers through the host registry')
  assert.match(source, /guide: \[\{ order: tab\.order \?\? 80/, 'and names itself on the guide page, the only route to a page type from the UI')
})
