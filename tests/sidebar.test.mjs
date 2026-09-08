import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createSidebarAdapter } from '../lib/types/client/sidebar.js'

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
