/**
 * The draft editor's criteria controls, driven through a mounted React tree:
 * the handlers behind Add criterion, a criterion's text, the last criterion's
 * Remove, a deliverable's Covers boxes, its own acceptance's `required`, and the
 * kind change that drops covers from a review. Static markup cannot run them.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import React, { act } from 'react'
import { resolveHarnessRoot } from '../scripts/harness-target.mjs'
import { DraftEditor, newPlan } from '../lib/types/client/DraftEditor.js'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'

// Reuse the configured local Harness's test DOM, as tests/ui-clock.test.mjs does.
const { JSDOM } = createRequire(join(resolveHarnessRoot(), 'package.json'))('jsdom')

test('the draft editor adds, edits and guards criteria, cites them per deliverable, and drops a review\'s covers', async t => {
  const dom = new JSDOM('<div id="mount"></div>', { pretendToBeVisual: true, url: 'http://localhost' })
  const originals = new Map()
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
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
  const input = { ...newPlan('/repo', uiSnapshot().mission.budget), title: 'Cited plan', objective: 'Cite criteria by id' }
  const requests = []
  const request = async (endpoint, body) => { requests.push([endpoint, body]); return { draft: { id: 'draft-dom', ownerSessionId: 'owner', revision: 1, status: 'draft', input: body.input, createdAt: 1, updatedAt: 1 } } }
  await act(() => root.render(React.createElement(DraftEditor, { sessionId: 'owner', workspace: '/repo', budget: input.budget, request, onSaved() {}, onLaunched() {}, onDiscarded() {},
    draft: { id: 'draft-dom', ownerSessionId: 'owner', revision: 1, status: 'draft', input, createdAt: 1, updatedAt: 1 } })))

  const click = element => act(() => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
  const type = (element, value) => act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value)
    element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
  const button = (scope, text) => [...scope.querySelectorAll('button')].find(item => item.textContent === text)
  const criteria = () => [...document.querySelectorAll('fieldset.sw-criteria > div')]
  const tasks = () => [...document.querySelectorAll('details.sw-edit-item')]
  const field = (task, label) => [...task.querySelectorAll('label')].find(item => item.firstChild?.textContent === label).querySelector('select, textarea, input')
  const covers = task => [...task.querySelectorAll('.sw-prereqs')].find(group => group.querySelector('span')?.textContent === 'Covers')
  const checked = task => [...(covers(task)?.querySelectorAll('input') ?? [])].map(box => box.checked)

  assert.equal(criteria().length, 1)
  assert.equal(button(criteria()[0], 'Remove').disabled, true, 'the last criterion cannot be removed')
  await click(button(document.querySelector('fieldset.sw-criteria'), 'Add criterion'))
  assert.deepEqual(criteria().map(row => [row.querySelector('code').textContent, button(row, 'Remove').disabled]), [['c1', false], ['c2', false]])
  await type(criteria()[1].querySelector('input'), 'The README documents the change.')
  assert.equal(criteria()[1].querySelector('input').value, 'The README documents the change.')
  const [deliver, review] = tasks()
  assert.match(covers(deliver).textContent, /c2 The README documents the change\.$/, 'each deliverable offers the new criterion by id and text')
  assert.equal(covers(review), undefined, 'a review cites nothing')
  assert.deepEqual([checked(deliver), field(deliver, 'Acceptance').required, field(review, 'Acceptance').required], [[true, false], false, false], 'a deliverable that covers a criterion, and a review, need no own acceptance')
  await click(covers(deliver).querySelectorAll('input')[1])
  assert.deepEqual(checked(deliver), [true, true])
  await click(covers(deliver).querySelectorAll('input')[0])
  await click(covers(deliver).querySelectorAll('input')[1])
  assert.deepEqual([checked(deliver), field(deliver, 'Acceptance').required], [[false, false], true], 'a deliverable that covers nothing needs its own acceptance')
  await click(covers(deliver).querySelectorAll('input')[0])
  await click(covers(deliver).querySelectorAll('input')[1])

  // A deliverable turned into a review drops its covers, so none are saved hidden and none come back.
  await click(button(document, 'Add task'))
  const added = tasks()[2]
  await click(covers(added).querySelectorAll('input')[0])
  assert.deepEqual(checked(added), [true, false])
  await type(field(added, 'Kind'), 'verification')
  assert.equal(covers(tasks()[2]), undefined)
  await type(field(tasks()[2], 'Kind'), 'research')
  assert.deepEqual(checked(tasks()[2]), [false, false])

  await act(() => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })))
  const [[endpoint, { input: saved }]] = requests
  assert.equal(endpoint, 'update-draft')
  assert.deepEqual(saved.acceptance, ['The delivered change satisfies the objective and passes independent verification.', 'The README documents the change.'])
  assert.deepEqual(saved.tasks.map(task => [task.kind, task.covers]), [['integration', ['c1', 'c2']], ['verification', undefined], ['research', undefined]])
})
