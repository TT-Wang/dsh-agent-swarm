import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import React, { act } from 'react'
import { resolveHarnessRoot } from '../scripts/harness-target.mjs'
import { LiveWorkOverview } from '../lib/types/client/LiveWorkPanel.js'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'

const requireHarness = createRequire(join(resolveHarnessRoot(), 'package.json'))
const { JSDOM } = requireHarness('jsdom')

test('member activity updates preserve row order, keyboard focus and conversation identity; collapsed members retain full text', async t => {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true, url: 'http://localhost' })
  const originals = new Map()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('mount'))
  t.after(async () => {
    await act(() => root.unmount())
    dom.window.close()
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  })
  t.mock.method(globalThis, 'fetch', () => assert.fail('member rendering and activity updates must not fetch'))
  const now = Date.now(), snapshot = uiSnapshot(), opened = []
  snapshot.mission.updatedAt = now
  const longName = 'Atlas responsible for cross-platform interoperability'
  const longRole = 'Independent verification of workspace preparation, dependency recovery and persistent delivery'
  const ids = ['a', 'b', 'c', 'd', 'e']
  const baseMember = snapshot.members[0], baseTask = snapshot.tasks[1]
  snapshot.members = ['b', 'e', 'a', 'd', 'c'].map(id => ({ ...baseMember, id, name: id === 'a' ? longName : `Member ${id}`,
    role: id === 'a' ? longRole : `Responsibility ${id}`, sessionId: `${id}-conversation`, status: 'working' }))
  snapshot.tasks = ids.map(id => ({ ...baseTask, id: `task-${id}`, assigneeId: id, title: `Execute the complete assignment for ${id}`,
    dependencies: [], status: 'running', epoch: 1, attempt: { id: `attempt-${id}`, epoch: 1, ownerId: id, leaseUntil: now + 120_000 } }))
  const activity = (id, kind = 'tool') => ({ id: `operation-${id}-${kind}`, kind, tool: kind === 'tool' ? 'bash' : undefined,
    startedAt: now - 5000, updatedAt: now, attemptId: `attempt-${id}` })
  snapshot.members.find(member => member.id === 'b').activity = activity('b')
  const onOpen = member => opened.push({ id: member.id, sessionId: member.sessionId })
  const mount = async () => act(() => root.render(React.createElement(LiveWorkOverview,
    { snapshot: { ...snapshot }, live: true, observedAt: now, connection: 'connected', onOpen })))
  const memberButtons = () => [...document.querySelectorAll('button[data-swarm-member]')]
  const renderedIds = () => memberButtons().map(button => button.dataset.swarmMember)
  const memberButton = id => document.querySelector(`button[data-swarm-member="${id}"]`)
  const click = async button => {
    assert.ok(button, 'the requested control is present')
    await act(() => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  }

  await mount()
  assert.deepEqual(renderedIds(), ['a', 'b', 'c'], 'the initial member order follows durable identity, not transient activity')
  const original = memberButton('a')
  original.focus()
  assert.equal(document.activeElement, original)
  assert.equal(original.getAttribute('aria-label'), `Open conversation: ${longName}`)
  for (const kind of ['model', 'retry', 'verification']) {
    snapshot.members.find(member => member.id === 'a').activity = activity('a', kind)
    snapshot.members.find(member => member.id === 'b').activity = { ...activity('b'), updatedAt: now - 60_000, startedAt: now - 65_000 }
    await mount()
    assert.deepEqual(renderedIds(), ['a', 'b', 'c'], `${kind} does not shuffle the member list`)
    assert.equal(memberButton('a'), original, 'a native transition preserves the actual clickable DOM element')
    assert.equal(document.activeElement, original, 'a native transition preserves keyboard focus')
    await click(original)
  }
  assert.deepEqual(opened, Array.from({ length: 3 }, () => ({ id: 'a', sessionId: 'a-conversation' })),
    'all activity states open the same durable member conversation')

  await click([...document.querySelectorAll('button')].find(button => button.textContent.includes('Show all members')))
  assert.deepEqual(renderedIds(), ids, 'expanding retains all active members exactly once')
  const expandedNodes = memberButtons()
  snapshot.members.find(member => member.id === 'e').activity = activity('e')
  await mount()
  assert.deepEqual(memberButtons(), expandedNodes, 'new activity keeps expansion and existing row identities')

  // The completed overview uses compact member rows. Full names/roles remain
  // available even when visual line clamping or ellipsis is used by CSS.
  snapshot.mission.status = 'completed'
  snapshot.tasks = snapshot.tasks.map(task => ({ ...task, status: 'accepted' }))
  snapshot.members = snapshot.members.map(member => ({ ...member, status: 'stopped', activity: undefined }))
  await mount()
  await click([...document.querySelectorAll('button')].find(button => button.textContent.includes('Team activity')))
  assert.deepEqual(new Set(renderedIds()), new Set(ids), 'the compact completed roster retains every member')
  const compact = memberButton('a')
  assert.equal(compact.getAttribute('aria-label'), `Open conversation: ${longName}`)
  const fullText = [...compact.querySelectorAll('[title]')].map(element => element.title)
  assert.ok(fullText.includes(longName), 'a visually shortened name has a full title')
  assert.ok(fullText.includes(longRole), 'a visually shortened role has a full title')
  await click(compact)
  assert.deepEqual(opened.at(-1), { id: 'a', sessionId: 'a-conversation' })
  assert.equal(compact.querySelector('.sw-agent-avatar-ring'), null, 'completed members do not claim active execution')
})
