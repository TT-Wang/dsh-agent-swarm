import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import React, { act } from 'react'
import { resolveHarnessRoot } from '../scripts/harness-target.mjs'
import { SwarmBoard } from '../lib/types/client/SwarmBoard.js'
import { CopyContext, zh } from '../lib/types/client/locale.js'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'

// Reuse the configured local Harness's test DOM; no dependency installation,
// host process, live profile, browser service or model request is involved.
const requireHarness = createRequire(join(resolveHarnessRoot(), 'package.json'))
const { JSDOM } = requireHarness('jsdom')

test('mounted overview uses one clock and one native projection; technical lease ticks never rerender the board', async t => {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true, url: 'http://localhost' })
  const originals = new Map()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  let hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  let now = Date.UTC(2026, 8, 15, 12), timerId = 0
  const intervals = new Map()
  t.mock.method(Date, 'now', () => now)
  t.mock.method(globalThis, 'setInterval', (callback, delay) => {
    assert.equal(delay, 1000, 'presentation clocks have a one-second cadence')
    const id = ++timerId; intervals.set(id, callback); return id
  })
  t.mock.method(globalThis, 'clearInterval', id => intervals.delete(id))
  t.mock.method(globalThis, 'fetch', () => assert.fail('a presentation tick cannot request data'))
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount'))
  t.after(async () => {
    await act(() => root.unmount())
    assert.equal(intervals.size, 0, 'unmount disposes all presentation intervals')
    dom.window.close()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })

  const snapshot = uiSnapshot()
  snapshot.mission.updatedAt = now
  snapshot.tasks[1].epoch = snapshot.tasks[1].attempt.epoch
  snapshot.tasks[1].attempt.leaseUntil = now + 9000
  const activity = { id: 'current-native-tool', kind: 'tool', tool: 'bash',
    attemptId: snapshot.tasks[1].attempt.id, startedAt: now - 5000, updatedAt: now }
  let nativeReads = 0, titleReads = 0, dependencyReads = 0
  Object.defineProperty(snapshot.members[1], 'activity', { enumerable: true, get: () => { nativeReads++; return activity } })
  const title = snapshot.mission.title
  Object.defineProperty(snapshot.mission, 'title', { enumerable: true, get: () => { titleReads++; return title } })
  for (const task of snapshot.tasks) {
    const dependencies = task.dependencies
    Object.defineProperty(task, 'dependencies', { enumerable: true, get: () => { dependencyReads++; return dependencies } })
  }
  let props = { snapshot, live: true, connection: 'connected', observedAt: now }
  let chinese = false
  const mount = async changes => {
    props = { ...props, ...changes }
    await act(() => root.render(React.createElement(CopyContext.Provider, { value: text => chinese ? zh[text] ?? text : text },
      React.createElement(SwarmBoard, props))))
  }
  const tick = async seconds => {
    for (let second = 0; second < seconds; second++) {
      now += 1000
      await act(() => { for (const callback of [...intervals.values()]) callback() })
    }
  }
  const clickTab = async label => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(item => item.textContent.startsWith(label))
    assert.ok(tab, `tab ${label} is present`)
    await act(() => tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  }
  const setDetails = async open => {
    const details = document.querySelector('[data-swarm-details="technical"]')
    await act(() => { details.open = open; details.dispatchEvent(new dom.window.Event('toggle')) })
  }
  const assertFrozen = () => {
    assert.equal(intervals.size, 0)
    assert.equal(document.querySelector('[data-moving="true"], .sw-agent-avatar-ring'), null,
      'an inactive or unconfirmed view has no observed-work animation')
  }

  await mount({})
  assert.equal(intervals.size, 1, 'focus and execution share one clock while technical details are closed')
  assert.ok(document.querySelector('.sw-agent-avatar-ring'), 'fresh native activity keeps its robot ring')
  const titleAtMount = titleReads, graphAtMount = dependencyReads, observationsAtMount = nativeReads
  const eventNodes = [...document.querySelectorAll('[data-event-id]')]
  const elapsed = document.querySelector('[data-swarm-elapsed]').textContent
  await tick(4)
  assert.equal(titleReads, titleAtMount, 'overview ticks do not rerender the top-level mission board')
  assert.equal(dependencyReads, graphAtMount, 'overview ticks do not rebuild task dependency indexes')
  assert.equal(nativeReads - observationsAtMount, 4, 'each of four ticks reads native activity once, shared by focus and execution')
  assert.notEqual(document.querySelector('[data-swarm-elapsed]').textContent, elapsed, 'the visible elapsed time still advances')
  assert.deepEqual([...document.querySelectorAll('[data-event-id]')], eventNodes, 'ticks preserve event DOM identities instead of replaying arrivals')

  await setDetails(true)
  assert.equal(intervals.size, 2, 'visible task leases add one local clock regardless of task count')
  const clickStream = async label => {
    const stream = [...document.querySelectorAll('.sw-stream')].find(item => item.textContent === label)
    assert.ok(stream, `workstream ${label} is present`)
    await act(() => stream.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  }
  await clickStream('Evidence & verification')
  assert.equal(intervals.size, 1, 'filtering out every leased task also stops the lease interval')
  await clickStream('All workstreams')
  assert.equal(intervals.size, 2)
  const titleAtOpen = titleReads, graphAtOpen = dependencyReads
  await tick(6)
  assert.match(document.querySelector('.sw-board').textContent, /\(expired\)/, 'visible lease labels cross expiry on the wall clock')
  assert.equal(titleReads, titleAtOpen, 'lease ticks do not rerender the board header')
  assert.equal(dependencyReads, graphAtOpen, 'lease ticks do not rerender task cards or rebuild indexes')

  await clickTab('Dependency graph')
  assert.equal(intervals.size, 1, 'switching away from the task list disposes the lease clock')
  const graphBeforeTick = dependencyReads, titleBeforeTick = titleReads
  await tick(3)
  assert.equal(dependencyReads, graphBeforeTick, 'the open graph does not rebuild with the overview clock')
  assert.equal(titleReads, titleBeforeTick)
  await clickTab('Work board')
  assert.equal(intervals.size, 2)
  await setDetails(false)
  assert.equal(intervals.size, 1, 'collapsing technical details disposes its lease clock')

  await mount({ connection: 'reconnecting' })
  assertFrozen()
  const offline = document.querySelector('.sw-overview').textContent
  await tick(20)
  assert.equal(document.querySelector('.sw-overview').textContent, offline, 'offline time remains at the last observation')
  assert.match(offline, /Last observed state|Recorded execution/)
  await mount({ connection: 'connected', live: false })
  assertFrozen()
  assert.match(document.querySelector('.sw-focus').textContent, /Recorded state/)

  await mount({ live: true, observedAt: now })
  assert.equal(intervals.size, 1)
  await act(() => { hidden = true; document.dispatchEvent(new dom.window.Event('visibilitychange')) })
  assertFrozen()
  await act(() => { hidden = false; document.dispatchEvent(new dom.window.Event('visibilitychange')) })
  assert.equal(intervals.size, 1, 'becoming visible resumes one overview clock')

  for (const status of ['paused', 'stopped', 'completed']) {
    snapshot.mission.status = status
    await mount({})
    assertFrozen()
  }
  snapshot.mission.status = 'paused'; chinese = true
  await mount({})
  assertFrozen()
  assert.match(document.querySelector('.sw-focus').textContent, /任务已暂停/)
  assert.doesNotMatch(document.querySelector('.sw-focus').textContent, /Mission paused/)
  snapshot.mission.status = 'active'; snapshot.mission.budgetPause = { id: 'budget-pause' }
  await mount({})
  assertFrozen()
  t.diagnostic('Measured mounted presentation intervals: compact 1; visible task-list 2; graph/closed details 1; offline/history/hidden/pause/stop/completed/budget-pause 0. Four overview ticks: four native reads, zero board-title or dependency rereads.')
})
