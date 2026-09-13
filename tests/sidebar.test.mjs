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
  assert.equal(adapter.open(), false, 'absent service leaves the standalone dock in control')

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
async function nativeFixture(t, component = () => null) {
  const ctx = new Context(), bodies = new Map(), types = new Map(), sessionListeners = new Set()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin({ name: 'native-sidebar-base', apply(scope) {
    scope.provide('slots', {
      inject(_name, factory) { return factory() ?? (() => {}) },
      register(options, body) { bodies.set(options.key, body); return () => bodies.delete(options.key) },
    })
    scope.provide('sessions', { list: {
      subscribe(listener) { sessionListeners.add(listener); return () => sessionListeners.delete(listener) },
      getSnapshot: () => ({ current: 'viewer' }),
    } })
    scope.provide('layout', { openRightbar() {} })
  } })
  const registry = await ctx.plugin({ name: 'native-sidebar-registry', apply(scope) {
    scope.provide('sidebarRightTabs', { register(definition) {
      assert.equal(types.has(definition.id), false)
      types.set(definition.id, definition)
      return () => types.delete(definition.id)
    } })
  } })
  let generation = 0, adapter
  const mount = async openTab => {
    const provider = ctx.plugin({ name: `native-sidebar-controller-${++generation}`, apply(scope) { scope.provide('sidebarRight', { openTab }) } })
    await provider
    return provider
  }
  const feature = ctx.plugin({ name: 'native-sidebar-consumer', inject: ['slots', 'sessions'], apply(scope) {
    adapter = createRightSidebarAdapter(scope, () => ({ id: 'swarm', kind: 'agent-swarm', label: () => 'Swarm', component }))
  } })
  await feature
  return { ctx, registry, feature, adapter, types, bodies, sessionListeners, mount }
}

test('native sidebar success belongs to its provider: controller and registry replacement reveal afresh', async t => {
  const f = await nativeFixture(t)
  let firstOpens = 0, replacementOpens = 0, mounted = false
  const first = await f.mount(() => { firstOpens++ })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(firstOpens, 1)
  await first.dispose()
  await settle(() => !f.adapter.getSnapshot())
  assert.equal(f.types.size, 0)
  assert.equal(f.bodies.size, 0)
  const replacement = await f.mount(() => {
    replacementOpens++
    if (!mounted) throw new Error('sidebarRight: no session surface is mounted')
  })
  await settle(() => f.types.size === 1)
  assert.equal(f.adapter.getSnapshot(), false, 'an old successful open never hides the replacement fallback')
  assert.equal(replacementOpens, 1)
  mounted = true
  for (const listener of f.sessionListeners) listener()
  assert.equal(f.adapter.getSnapshot(), true)
  assert.equal(replacementOpens, 2)
  await f.registry.dispose()
  await settle(() => !f.adapter.getSnapshot())
  assert.equal(f.bodies.size, 0)
  await f.ctx.plugin({ name: 'native-sidebar-new-registry', apply(scope) {
    scope.provide('sidebarRightTabs', { register() { return () => {} } })
  } })
  await settle(() => f.adapter.getSnapshot())
  assert.equal(replacementOpens, 3, 'registry replacement also owns a new reveal')
  await replacement.dispose()
  await f.feature.dispose()
  assert.equal(f.sessionListeners.size, 0)
  assert.equal(f.adapter.open(), false)
})

test('native sidebar retries are bounded and stop with the owning provider', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = await nativeFixture(t)
  let attempts = 0
  const first = await f.mount(() => { attempts++; throw new Error('not mounted') })
  await settle(() => f.types.size === 1)
  assert.equal(attempts, 1)
  t.mock.timers.tick(120_000)
  assert.equal(attempts, 61, 'one initial attempt and sixty bounded retries')
  t.mock.timers.tick(120_000)
  assert.equal(attempts, 61, 'an exhausted loop stays stopped')
  for (const listener of f.sessionListeners) listener()
  assert.equal(attempts, 62, 'a session signal grants a fresh bounded retry window')
  await first.dispose()
  await settle(() => !f.adapter.getSnapshot() && f.types.size === 0)
  t.mock.timers.tick(120_000)
  for (const listener of f.sessionListeners) listener()
  assert.equal(attempts, 62, 'neither old timers nor session signals reveal an absent provider')
  let replacementAttempts = 0
  await f.mount(() => { replacementAttempts++; throw new Error('not mounted') })
  await settle(() => f.types.size === 1)
  assert.equal(replacementAttempts, 1)
  f.adapter.dispose()
  t.mock.timers.tick(120_000)
  assert.equal(replacementAttempts, 1, 'explicit unload also clears pending retries')
  assert.equal(f.adapter.getSnapshot(), false)
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
