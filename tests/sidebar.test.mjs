import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createSidebarAdapter, createRightSidebarAdapter } from '../lib/types/client/sidebar.js'
import { SwarmMonitor } from '../lib/types/client/monitor.js'

async function settle(predicate) {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true, 'Cordis dependency transition should settle')
}

function sidebarService() {
  const tabs = new Map(), opens = []
  let disposed = 0
  return {
    tabs, opens, get disposed() { return disposed },
    registerTab(tab) {
      assert.equal(tabs.has(tab.id), false)
      tabs.set(tab.id, tab)
      return () => { disposed++; tabs.delete(tab.id) }
    },
    openTab(seed) { opens.push(seed) },
  }
}

test('optional Better Sidebar tab follows actual Cordis service arrival, removal and replacement', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let adapter
  const tab = { id: 'agent-swarm', single: true, title: () => 'Agent Swarm', component: props => props }
  const feature = ctx.plugin({ name: 'swarm-sidebar-test', apply(scope) {
    adapter = createSidebarAdapter(scope, () => tab)
  } })
  await feature
  const transitions = []
  const off = adapter.subscribe(() => transitions.push(adapter.getSnapshot()))
  assert.equal(adapter.getSnapshot(), false)
  assert.equal(adapter.open(), false, 'absent service claims no reveal')

  const service = sidebarService()
  const provider = ctx.plugin({ name: 'sidebar-service-test', apply(scope) { scope.provide('betterSidebar', service) } })
  await provider
  await settle(() => adapter.getSnapshot())
  assert.equal(service.tabs.get('agent-swarm').component, tab.component)
  assert.equal(typeof service.tabs.get('agent-swarm').createTab, 'function')
  assert.equal(adapter.open(), true)
  assert.deepEqual(service.opens, [{ type: 'agent-swarm' }], 'open uses the public type-only API and descriptor-owned reveal patch')
  const pinned = { scope: { sessionId: 'pinned-owner', cwd: '/repo' }, visible: false }
  assert.equal(service.tabs.get('agent-swarm').component(pinned), pinned, 'pinned scope and inactive visibility reach the view unchanged')

  await provider.dispose()
  await settle(() => !adapter.getSnapshot())
  assert.equal(service.tabs.size, 0)
  assert.equal(service.disposed, 1)
  assert.equal(adapter.open(), false)

  const replacement = sidebarService()
  await ctx.plugin({ name: 'sidebar-replacement-test', apply(scope) { scope.provide('betterSidebar', replacement) } })
  await settle(() => adapter.getSnapshot())
  assert.equal(replacement.tabs.size, 1)
  await feature.dispose()
  assert.equal(adapter.getSnapshot(), false)
  assert.equal(replacement.tabs.size, 0)
  assert.equal(replacement.disposed, 1)
  adapter.dispose()
  assert.equal(replacement.disposed, 1, 'explicit cleanup and fiber unload are idempotent')
  off()
  assert.deepEqual(transitions, [true, false, true, false])
})

test('explicit adapter disposal prevents delayed sidebar activation', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  let adapter
  await ctx.plugin({ name: 'disposed-sidebar-consumer', apply(scope) {
    adapter = createSidebarAdapter(scope, () => ({ id: 'agent-swarm', title: 'Agent Swarm', component: () => null }))
  } })
  adapter.dispose()
  const service = sidebarService()
  await ctx.plugin({ name: 'late-sidebar-service', apply(scope) { scope.provide('betterSidebar', service) } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(adapter.getSnapshot(), false)
  assert.equal(service.tabs.size, 0)
  assert.equal(adapter.open(), false)
})


/** Real Cordis provider lifetimes, with the small native UI surfaces held in memory. */
async function nativeFixture(t, component = () => null, options = {}) {
  const ctx = new Context(), bodies = new Map(), slots = new Map(), types = new Map(), sessionListeners = new Set(), layoutCalls = []
  let currentSession = Object.hasOwn(options, 'current') ? options.current : 'viewer'
  const signalSessions = () => { for (const listener of sessionListeners) listener() }
  t.after(() => ctx.fiber.dispose())
  t.after(() => assert.deepEqual(layoutCalls, [], 'the adapter never changes pane geometry directly'))
  await ctx.plugin({ name: 'native-sidebar-base', apply(scope) {
    scope.provide('slots', {
      inject(_name, factory) { return factory() ?? (() => {}) },
      register(options, body) {
        const key = options.key ?? options.id
        assert.equal(bodies.has(key), false)
        bodies.set(key, body)
        slots.set(key, options)
        return () => { bodies.delete(key); slots.delete(key) }
      },
    })
    scope.provide('sessions', { list: {
      subscribe(listener) { sessionListeners.add(listener); return () => sessionListeners.delete(listener) },
      getSnapshot: () => options.sessionContract === 'retained' ? {
        ids: ['background', ...(currentSession === undefined ? [] : [currentSession])],
        byId: {
          background: { retainedBy: { worker: 1, mainView: 0 } },
          ...(currentSession === undefined ? {} : { [currentSession]: { retainedBy: { mainView: 1 } } }),
        },
      } : { current: currentSession },
    } })
    scope.provide('layout', {
      openRightbar(...args) { layoutCalls.push(args) },
      ...(options.selectPanel ? { selectPanel: options.selectPanel } : {}),
    })
  } })
  let registryGeneration = 0, generation = 0, adapter
  const mountRegistry = async () => {
    const provider = ctx.plugin({ name: `native-sidebar-registry-${++registryGeneration}`, apply(scope) {
      scope.provide('sidebarRightTabs', { register(definition) {
        assert.equal(types.has(definition.id), false)
        types.set(definition.id, definition)
        return () => types.delete(definition.id)
      } })
    } })
    await provider
    return provider
  }
  const registry = await mountRegistry()
  const mount = async controller => {
    const provider = ctx.plugin({ name: `native-sidebar-controller-${++generation}`, apply(scope) { scope.provide('sidebarRight', typeof controller === 'function' ? { openTab: controller } : controller) } })
    await provider
    return provider
  }
  const feature = ctx.plugin({ name: 'native-sidebar-consumer', inject: ['slots', 'sessions'], apply(scope) {
    adapter = createRightSidebarAdapter(scope, () => ({
      id: 'swarm', kind: 'agent-swarm', label: () => 'Swarm', component, launcher: options.launcher,
    }))
  } })
  await feature
  return {
    ctx, registry, feature, adapter, types, bodies, slots, sessionListeners, mount, mountRegistry, signalSessions,
    setSession(sessionId, notify = true) { currentSession = sessionId; if (notify) signalSessions() },
  }
}

test('native sidebar readiness preserves default-collapsed state across sessions and provider replacement', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await nativeFixture(t)
  const pane = { defaultCollapsed: true, collapsed: true }
  let firstOpens = 0, replacementOpens = 0
  const transitions = []
  const off = f.adapter.subscribe(() => transitions.push(f.adapter.getSnapshot()))
  assert.equal(f.adapter.getSnapshot(), false)
  assert.equal(f.adapter.open(), false, 'an absent controller leaves the fallback in control')
  const first = await f.mount(() => { firstOpens++; pane.collapsed = false })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(f.types.size, 1)
  assert.equal(f.bodies.size, 1)
  assert.equal(firstOpens, 0, 'registration and controller mount are passive')
  f.signalSessions()
  f.setSession('another-viewer')
  t.mock.timers.tick(120_000)
  assert.equal(firstOpens, 0, 'session notifications never create an open request')
  assert.deepEqual(pane, { defaultCollapsed: true, collapsed: true })
  await first.dispose()
  await settle(() => !f.adapter.getSnapshot())
  assert.equal(f.types.size, 0)
  assert.equal(f.bodies.size, 0)
  const replacement = await f.mount(() => { replacementOpens++; pane.collapsed = false })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(replacementOpens, 0, 'replacement controller readiness does not reveal its pane')
  await f.registry.dispose()
  await settle(() => !f.adapter.getSnapshot())
  assert.equal(f.bodies.size, 0)
  await f.mountRegistry()
  await settle(() => f.adapter.getSnapshot())
  f.signalSessions()
  t.mock.timers.tick(120_000)
  assert.equal(replacementOpens, 0, 'registry replacement is also passive')
  assert.deepEqual(pane, { defaultCollapsed: true, collapsed: true })
  await replacement.dispose()
  await f.feature.dispose()
  assert.equal(f.sessionListeners.size, 0)
  assert.equal(f.adapter.open(), false)
  off()
  assert.deepEqual(transitions, [true, false, true, false, true, false])
})

test('each explicit native open reveals through the controller, including reopening after collapse', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await nativeFixture(t)
  const calls = []
  let collapsed = true
  await f.mount((...args) => { calls.push(args); collapsed = false })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(collapsed, true)
  assert.equal(f.adapter.open(), true)
  assert.equal(collapsed, false)
  assert.deepEqual(calls, [['agent-swarm', { revealIfOpened: true }]])
  collapsed = true
  f.signalSessions()
  t.mock.timers.tick(120_000)
  assert.equal(collapsed, true, 'a later user collapse survives session signals and timers')
  assert.equal(f.adapter.getSnapshot(), true, 'collapse does not relinquish native ownership')
  assert.equal(calls.length, 1)
  assert.equal(f.adapter.open(), true)
  assert.equal(collapsed, false)
  assert.deepEqual(calls, [
    ['agent-swarm', { revealIfOpened: true }],
    ['agent-swarm', { revealIfOpened: true }],
  ])
})

test('the native footer launcher is passive, stays available after collapse, and follows provider lifetimes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let projected
  const f = await nativeFixture(t, undefined, {
    current: undefined,
    launcher: props => { projected = props; return null },
  })
  let opens = 0, collapsed = true
  const provider = await f.mount(() => { opens++; collapsed = false })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(opens, 0, 'the persistent home launcher appears without opening a tab')
  assert.equal(collapsed, true)
  assert.equal(f.bodies.size, 2)
  assert.deepEqual(f.slots.get('swarm-launcher'), {
    name: 'sidebar.footer.action', id: 'swarm-launcher', order: 80,
  })
  const Launcher = f.bodies.get('swarm-launcher')
  Launcher({ wide: false })
  assert.equal(projected.wide, false)
  assert.equal(typeof projected.onOpen, 'function')
  assert.equal(opens, 0, 'rendering the launcher is also passive')
  projected.onOpen()
  assert.equal(opens, 1)
  assert.equal(collapsed, false)
  collapsed = true
  f.setSession('viewer')
  t.mock.timers.tick(120_000)
  assert.equal(collapsed, true)
  assert.equal(opens, 1)
  assert.equal(f.bodies.get('swarm-launcher'), Launcher, 'collapse and session navigation preserve the launcher registration')
  Launcher({ wide: true })
  assert.equal(projected.wide, true)
  projected.onOpen()
  assert.equal(opens, 2, 'the same launcher explicitly reopens a collapsed native pane')
  assert.equal(collapsed, false)
  const staleOpen = projected.onOpen
  await provider.dispose()
  await settle(() => !f.adapter.getSnapshot())
  assert.equal(f.bodies.size, 0, 'provider removal unregisters the body and launcher')
  assert.equal(f.slots.size, 0)
  staleOpen()
  assert.equal(opens, 2, 'callbacks retained from an unloaded launcher cannot navigate')
  await f.mount(() => { opens++; collapsed = false })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(opens, 2, 'replacement registration does not invoke the launcher')
  assert.notEqual(f.bodies.get('swarm-launcher'), Launcher)
  f.bodies.get('swarm-launcher')({ wide: false })
  const replacementOpen = projected.onOpen
  await f.feature.dispose()
  assert.equal(f.bodies.size, 0, 'feature unload also removes the native launcher')
  assert.equal(f.slots.size, 0)
  replacementOpen()
  assert.equal(opens, 2)
})

for (const supportsPanelSelection of [true, false]) {
  test(`the native launcher ${supportsPanelSelection ? 'returns from a global page to its session before opening' : 'opens when optional panel selection is unavailable'}`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const calls = []
    let projected, mounted = !supportsPanelSelection
    const f = await nativeFixture(t, undefined, {
      launcher: props => { projected = props; return null },
      ...(supportsPanelSelection ? {
        selectPanel(panel) { calls.push(['selectPanel', panel]); mounted = true },
      } : {}),
    })
    await f.mount((...args) => {
      calls.push(['openTab', ...args])
      if (!mounted) throw new Error('sidebarRight: no session surface is mounted')
    })
    await settle(() => f.adapter.getSnapshot())
    f.bodies.get('swarm-launcher')({ wide: true })
    f.signalSessions()
    t.mock.timers.tick(120_000)
    assert.deepEqual(calls, [], 'readiness, rendering and session signals preserve the selected host page')
    projected.onOpen()
    assert.deepEqual(calls, [
      ...(supportsPanelSelection ? [['selectPanel', null]] : []),
      ['openTab', 'agent-swarm', { revealIfOpened: true }],
    ], 'an explicit launcher action returns to the conversation when supported, then opens through the controller')
    const completedCalls = calls.length
    f.signalSessions()
    t.mock.timers.tick(120_000)
    assert.equal(calls.length, completedCalls, 'a completed launch neither reselects the page nor retries navigation')
  })
}

test('an explicit native request owns the fallback while waiting for its session surface', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await nativeFixture(t)
  let attempts = 0, mounted = false
  await f.mount(() => {
    attempts++
    if (!mounted) throw new Error('sidebarRight: no session surface is mounted')
  })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(attempts, 0)
  assert.equal(f.adapter.open(), true, 'the native controller owns even an initially unmounted request')
  assert.equal(f.adapter.getSnapshot(), true, 'readiness does not depend on a successful reveal')
  assert.equal(attempts, 1)
  t.mock.timers.tick(500)
  assert.equal(attempts, 2)
  mounted = true
  f.signalSessions()
  assert.equal(attempts, 3, 'a session surface signal can finish an existing request')
  t.mock.timers.tick(120_000)
  f.signalSessions()
  f.setSession('another-viewer')
  assert.equal(attempts, 3, 'success consumes the request and cancels all retry activity')
})

for (const sessionContract of ['current', 'retained']) {
  test(`an unadopted ${sessionContract} session cannot silently consume an explicit reveal`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const f = await nativeFixture(t, undefined, { sessionContract })
    let mounted = false, attempts = 0, targetedAttempts = 0, collapsed = true
    const opened = []
    // Both native host versions expose openTabIn for internal tab actions. Its
    // void return proves nothing: before store adoption it deliberately no-ops.
    await f.mount({
      openTabIn(sessionId, kind, options) {
        targetedAttempts++
        if (mounted) { opened.push([sessionId, kind, options]); collapsed = false }
      },
      openTab(kind, options) {
        attempts++
        if (!mounted) throw new Error('sidebarRight: no session surface is mounted')
        opened.push(['viewer', kind, options]); collapsed = false
      },
    })
    await settle(() => f.adapter.getSnapshot())
    f.signalSessions()
    t.mock.timers.tick(120_000)
    assert.equal(attempts, 0, 'readiness and session signals preserve the collapsed pane')
    assert.equal(collapsed, true)
    assert.equal(f.adapter.open(), true, 'native integration retains ownership while the surface mounts')
    assert.equal(attempts, 1)
    t.mock.timers.tick(500)
    assert.equal(attempts, 2, 'a refused reveal keeps its retry alive despite the silent targeted API')
    assert.deepEqual(opened, [])
    mounted = true
    t.mock.timers.tick(500)
    assert.equal(attempts, 3)
    assert.deepEqual(opened, [['viewer', 'agent-swarm', { revealIfOpened: true }]])
    assert.equal(collapsed, false)
    assert.equal(targetedAttempts, 0, 'explicit navigation uses the public mounted-seat contract')
    collapsed = true
    f.signalSessions()
    t.mock.timers.tick(120_000)
    assert.equal(attempts, 3, 'successful navigation consumes the request')
    assert.equal(collapsed, true, 'a subsequent manual collapse survives old signals and timers')
  })
}

test('native retry exhaustion needs a fresh explicit request, not a session notification', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await nativeFixture(t)
  let attempts = 0
  await f.mount(() => { attempts++; throw new Error('not mounted') })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(attempts, 0)
  assert.equal(f.adapter.open(), true)
  assert.equal(attempts, 1)
  t.mock.timers.tick(120_000)
  assert.equal(attempts, 61, 'one initial attempt and sixty bounded retries')
  t.mock.timers.tick(120_000)
  assert.equal(attempts, 61, 'an exhausted loop stays stopped')
  f.signalSessions()
  t.mock.timers.tick(120_000)
  assert.equal(attempts, 61, 'session notifications cannot restart an exhausted request')
  assert.equal(f.adapter.getSnapshot(), true)
  assert.equal(f.adapter.open(), true)
  assert.equal(attempts, 62, 'explicit intent starts a fresh retry budget')
  t.mock.timers.tick(500)
  assert.equal(attempts, 63)
})

test('native pending requests end with their controller, registry or adapter lifetime', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await nativeFixture(t)
  let attempts = 0
  const first = await f.mount(() => { attempts++; throw new Error('not mounted') })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(f.adapter.open(), true)
  assert.equal(attempts, 1)
  await first.dispose()
  await settle(() => !f.adapter.getSnapshot() && f.types.size === 0)
  t.mock.timers.tick(120_000)
  f.signalSessions()
  assert.equal(attempts, 1, 'neither old timers nor session signals reveal an absent provider')
  let replacementAttempts = 0
  await f.mount(() => { replacementAttempts++; throw new Error('not mounted') })
  await settle(() => f.adapter.getSnapshot())
  f.signalSessions()
  t.mock.timers.tick(120_000)
  assert.equal(replacementAttempts, 0, 'a pending request does not transfer to a replacement controller')
  assert.equal(f.adapter.open(), true)
  assert.equal(replacementAttempts, 1)
  await f.registry.dispose()
  await settle(() => !f.adapter.getSnapshot())
  assert.equal(f.bodies.size, 0)
  t.mock.timers.tick(120_000)
  f.signalSessions()
  assert.equal(replacementAttempts, 1, 'registry removal cancels a pending request')
  await f.mountRegistry()
  await settle(() => f.adapter.getSnapshot())
  f.signalSessions()
  t.mock.timers.tick(120_000)
  assert.equal(replacementAttempts, 1, 'a replacement registry cannot revive the old request')
  assert.equal(f.adapter.open(), true)
  assert.equal(replacementAttempts, 2)
  f.adapter.dispose()
  t.mock.timers.tick(120_000)
  f.signalSessions()
  assert.equal(replacementAttempts, 2, 'explicit unload also clears pending retries')
  assert.equal(f.adapter.getSnapshot(), false)
  assert.equal(f.adapter.open(), false)
  assert.equal(f.types.size, 0)
  assert.equal(f.bodies.size, 0)
  assert.equal(f.sessionListeners.size, 0)
})

for (const sessionContract of ['current', 'retained']) for (const notify of [true, false]) {
  test(`a pending native request is dropped on ${sessionContract} session switch${notify ? ' notification' : ' before its next timer retry'}`, async t => {
    t.mock.timers.enable({ apis: ['setInterval'] })
    const f = await nativeFixture(t, undefined, { sessionContract })
    let attempts = 0, mounted = false
    await f.mount(() => {
      attempts++
      if (!mounted) throw new Error('not mounted')
    })
    await settle(() => f.adapter.getSnapshot())
    assert.equal(f.adapter.open(), true)
    assert.equal(attempts, 1)
    mounted = true
    f.setSession('another-viewer', notify)
    t.mock.timers.tick(120_000)
    assert.equal(attempts, 1, 'the earlier request cannot open the new session')
    f.setSession('viewer')
    t.mock.timers.tick(120_000)
    assert.equal(attempts, 1, 'returning to the original session cannot revive cancelled intent')
    assert.equal(f.adapter.getSnapshot(), true)
    assert.equal(f.adapter.open(), true)
    assert.equal(attempts, 2, 'a fresh explicit open remains available')
  })
}

test('an explicit native request before the first session can open once its surface arrives', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await nativeFixture(t, undefined, { current: undefined })
  let attempts = 0, mounted = false
  await f.mount(() => {
    attempts++
    if (!mounted) throw new Error('not mounted')
  })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(attempts, 0)
  assert.equal(f.adapter.open(), true)
  assert.equal(attempts, 1)
  mounted = true
  f.setSession('first-viewer')
  assert.equal(attempts, 2, 'an initially sessionless request may follow the first mounted surface')
  f.signalSessions()
  t.mock.timers.tick(120_000)
  assert.equal(attempts, 2)
})

test('native slot forwards its session and live visibility, cancelling hidden monitor requests', async t => {
  const calls = []
  const monitor = new SwarmMonitor((_endpoint, payload, signal) => {
    calls.push({ payload, signal })
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  t.after(() => monitor.dispose())
  let projected
  const f = await nativeFixture(t, props => {
    projected = props
    // ActivityPanel's effect consumes these exact props through monitor.select.
    monitor.select(props.scope.sessionId, props.visible)
    return null
  })
  await f.mount(() => {})
  await settle(() => f.bodies.has('swarm'))
  const Body = f.bodies.get('swarm')
  let visible = true, hookReads = 0
  const props = { sessionId: 'tab-owner', useTabInfo: () => { hookReads++; return { tab: { visible } } } }
  Body(props)
  assert.deepEqual(projected, { scope: { sessionId: 'tab-owner' }, visible: true }, 'the tab owner wins over the globally selected viewer')
  assert.equal(calls[0].payload.sessionId, 'tab-owner')
  assert.equal(calls[0].signal.aborted, false)
  visible = false
  Body(props)
  assert.equal(projected.visible, false)
  assert.equal(calls[0].signal.aborted, true, 'the mounted but collapsed native pane aborts its watch')
  assert.equal(monitor.getSnapshot().connection, 'paused')
  await monitor.refresh()
  assert.equal(calls.length, 1, 'hidden panes issue no reads')
  visible = true
  Body(props)
  assert.equal(calls.length, 2, 'revealing resumes the same tab owner')
  assert.equal(hookReads, 3, 'visibility is read from the real injected hook shape on every render')
})
