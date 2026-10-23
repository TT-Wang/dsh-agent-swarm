/**
 * F2 (2026-10-22 self-review): every server item the panel renders enters
 * through one reader (src/client/projection.ts), so a malformed one is refused
 * with a visible error before it reaches state. Before admission covered drafts,
 * starts and request replies, these items reached render and threw there; on
 * Harness 0.2.1 the host's slot error boundary then retires the tab for every
 * conversation until a page reload. These tests mount the real components, so
 * a render failure unmounts the tree and fails the assertions.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { ActivityPanel } from '../lib/types/client/ActivityPanel.js'
import { DeliveryPanel } from '../lib/types/client/DeliveryPanel.js'
import { DraftEditor, newPlan } from '../lib/types/client/DraftEditor.js'
import { SwarmMonitor } from '../lib/types/client/monitor.js'
import { RequestDeadlineError } from '../lib/types/client/request-deadline.js'
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
const click = element => act(async () => { element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await flush() })
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

test('F2: a malformed reply to Save or Launch is a request error, never the editor\'s plan or a launched mission', async t => {
  const saved = [], launched = []
  const replies = { 'update-draft': { draft: draftItem({ revision: 3, input: { title: 'Paginate the API' } }) }, 'launch-draft': { snapshot: { mission: { id: 'mission-x' } } } }
  const endpoints = []
  const request = async endpoint => { endpoints.push(endpoint); return replies[endpoint] }
  const container = await mount(t, React.createElement(DraftEditor, { sessionId: 'owner', workspace: '/repo', budget: budget(), draft: draftItem(), request,
    onSaved: value => saved.push(value), onLaunched: value => launched.push(value), onDiscarded() {} }))
  await act(async () => { container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await flush() })
  assert.equal(alertText(container), 'Invalid draft from host')
  assert.equal(saved.length, 0, 'the refused draft is not handed to the panel')
  assert.equal(container.querySelector('[data-testid="draft-title"]').value, 'Paginate the API', 'the editor keeps the plan it had')
  assert.match(container.querySelector('.sw-chip').textContent, /r2$/)
  await click(container.querySelector('[data-action="launch-draft"]'))
  assert.equal(alertText(container), 'Invalid mission from host')
  assert.equal(launched.length, 0, 'the refused mission is not handed to the panel')
  assert.deepEqual(endpoints, ['update-draft', 'launch-draft'])
})

test('F2: malformed delivery replies are request errors, never a diff, an outcome or a recheck the panel renders', async t => {
  const snapshot = uiSnapshot()
  snapshot.mission.status = 'completed'
  snapshot.deliveryTarget = { taskId: 't4', commit: snapshot.tasks[3].artifact.commit }
  const replies = [], applied = []
  const request = async (endpoint, payload) => {
    const [expected, reply] = replies.shift()
    assert.equal(endpoint, expected)
    assert.equal(payload.sessionId, 'owner')
    if (reply instanceof Error) throw reply
    return reply
  }
  const container = await mount(t, React.createElement(DeliveryPanel, { snapshot, sessionId: 'owner', request, onApplied: () => applied.push(true) }))
  const button = action => container.querySelector(`[data-action="${action}"]`)
  const inspection = { baselineCommit: 'a'.repeat(40), resultCommit: snapshot.deliveryTarget.commit, changedPaths: ['src/scheduler.ts'], diff: '+fenced', truncated: false }
  replies.push(['delivery', { delivery: { ...inspection, diff: { text: '+fenced' } } }])
  await click(button('view-delivery'))
  assert.equal(alertText(container), 'Invalid delivery from host')
  assert.equal(container.querySelector('.sw-delivery-diff'), null)
  replies.push(['apply-delivery', { result: { status: 'conflicts', changedPaths: ['src/scheduler.ts'], conflicts: 'src/scheduler.ts' }, snapshot }])
  await click(button('apply-delivery'))
  assert.equal(alertText(container), 'Invalid delivery result from host')
  replies.push(['apply-delivery', { result: { status: 'applied', changedPaths: ['src/scheduler.ts'], conflicts: [] }, snapshot: { ...snapshot, events: undefined } }])
  await click(button('apply-delivery'))
  assert.equal(alertText(container), 'Invalid mission from host')
  assert.equal(applied.length, 0, 'a refused reply reports no application')
  assert.equal(button('apply-delivery').textContent, 'Apply result')
  // A timed-out apply leaves its outcome unconfirmed; the recheck reads the owner's state through the monitor's rule.
  replies.push(['apply-delivery', new RequestDeadlineError()])
  await click(button('apply-delivery'))
  assert.equal(button('apply-delivery').textContent, 'Check application status')
  replies.push(['state', liveState({ snapshots: [{ ...snapshot, events: undefined }] })])
  await click(button('apply-delivery'))
  assert.equal(alertText(container), 'Invalid swarm state from host')
  replies.push(['delivery', { delivery: inspection }])
  await click(button('view-delivery'))
  assert.equal(container.querySelector('.sw-delivery-diff').textContent, '+fenced', 'a well-formed inspection is admitted and rendered')
  assert.equal(replies.length, 0)
})
