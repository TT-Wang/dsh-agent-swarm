/**
 * F2 (2026-10-22 self-review): every item of the owner's state the panel
 * renders enters through one reader (src/client/projection.ts), so a malformed
 * one is refused with a visible error before it reaches state. Before admission
 * covered drafts and starts, these items reached render and threw there; on
 * Harness 0.2.1 the host's slot error boundary then retires the tab for every
 * conversation until a page reload. These tests mount the real components, so
 * a render failure unmounts the tree and fails the assertions.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { ActivityPanel } from '../lib/types/client/ActivityPanel.js'
import { newPlan } from '../lib/types/client/DraftEditor.js'
import { SwarmMonitor } from '../lib/types/client/monitor.js'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))
let dom, createRoot
const originals = new Map()
before(async () => {
  dom = new JSDOM('<body></body>', { pretendToBeVisual: true, url: 'http://localhost' })
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  ;({ createRoot } = await import('react-dom/client'))
})
after(() => {
  dom.window.close()
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})
async function mount(t, element) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  t.after(async () => { await act(() => root.unmount()); container.remove() })
  await act(async () => { root.render(element); await flush(); await flush() })
  return container
}
const alertText = container => container.querySelector('[role="alert"]')?.textContent

const budget = () => uiSnapshot().mission.budget
const draftItem = (overrides = {}) => ({ id: 'draft-1', ownerSessionId: 'owner', revision: 2, status: 'draft', createdAt: 1, updatedAt: 2,
  input: { ...newPlan('/repo', budget()), title: 'Paginate the API', objective: 'Add cursor pagination' }, ...overrides })
const startItem = (overrides = {}) => ({ id: 'start-1', ownerSessionId: 'owner', commandId: 'command-1', goal: 'Paginate the API', workspace: '/repo',
  status: 'planning', planningEpoch: 1, createdAt: 1, updatedAt: 2,
  baseline: { sourceHead: 'a'.repeat(40), snapshotCommit: 'b'.repeat(40), planningWorkspace: '/planning', changedPaths: ['src/api.ts'], createdAt: 1 }, ...overrides })
const liveState = overrides => ({ ownerSessionId: 'owner', workspace: '/repo', snapshots: [], drafts: [], starts: [], defaultBudget: budget(),
  writable: true, ownerLive: true, revision: 1, ...overrides })
const store = value => ({ subscribe: () => () => {}, getSnapshot: () => value })
const panel = monitor => React.createElement(ActivityPanel, {
  sessions: { list: store({ ids: ['owner'], byId: { owner: { retainedBy: { mainView: 1 } } } }) }, modelDirectories: { directoryFor() {} }, monitor,
  history: { ...store({ entries: [], loading: false, hasMore: false }), close() {} }, sessionId: 'owner', onOpenWorker() {},
})

test('F2: the panel refuses a malformed draft or start in the owner\'s state and stays mounted with the error', async t => {
  const admitted = new SwarmMonitor(async endpoint => endpoint === 'state' ? liveState({ drafts: [draftItem()] }) : await new Promise(() => {}))
  t.after(() => admitted.dispose())
  const shown = await mount(t, panel(admitted))
  assert.equal(shown.querySelector('[data-swarm-natural-start] h2')?.textContent, 'Paginate the API', 'a well-formed draft is admitted and rendered')
  for (const [label, state] of [
    ['a draft without its plan', liveState({ drafts: [draftItem({ input: undefined })] })],
    ['a start whose project snapshot has no commit', liveState({ starts: [startItem({ baseline: { ...startItem().baseline, snapshotCommit: undefined } })] })],
    ['a start whose goal is not text', liveState({ starts: [startItem({ goal: { text: 'Paginate the API' } })] })],
  ]) {
    const monitor = new SwarmMonitor(async endpoint => endpoint === 'state' ? state : await new Promise(() => {}))
    t.after(() => monitor.dispose())
    const container = await mount(t, panel(monitor))
    assert.ok(container.querySelector('[data-swarm-panel]'), `${label}: the panel stays mounted`)
    assert.equal(alertText(container), 'Invalid swarm state from host', label)
    assert.match(container.textContent, /Swarm bridge is unavailable/, label)
  }
})

