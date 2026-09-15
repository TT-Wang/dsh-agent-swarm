import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActivityPanel } from '../lib/types/client/ActivityPanel.js'
import { mergeStartResponse, requestStartControl } from '../lib/types/client/start-controls.js'
import { RequestDeadlineError, requestWithDeadline } from '../lib/types/client/request-deadline.js'
import { selectedOperation } from '../lib/types/client/selection.js'
import { uiSnapshot } from './fixtures/ui-snapshot.mjs'

const saved = (overrides = {}) => ({
  id: 'request-a', ownerSessionId: 'owner-a', commandId: 'command-a', goal: 'Fix pagination', workspace: '/workspace',
  status: 'failed', planningEpoch: 1, createdAt: 100, updatedAt: 200, ...overrides,
})
const store = value => ({ subscribe: () => () => {}, getSnapshot: () => value })
function renderStart(start, overrides = {}) {
  const data = { snapshots: [], drafts: [], starts: [start], writable: true, ...overrides.data }
  const monitor = { ...store({ ownerSessionId: 'owner-a', loading: false, connection: overrides.connection ?? 'connected', data }), select() {} }
  return renderToStaticMarkup(React.createElement(ActivityPanel, {
    sessions: { list: store({ current: 'owner-a' }) }, modelDirectories: { directoryFor() {} }, monitor,
    history: { ...store({ entries: [], loading: false, hasMore: false }), close() {} }, sessionId: 'owner-a', onOpenWorker() {},
  }))
}

test('saved failed requests expose recovery before any mission exists; active planning permits only stop', () => {
  const failed = renderStart(saved())
  assert.match(failed, /data-action="retry-start"/)
  assert.match(failed, /data-action="stop-start"/)
  for (const status of ['planning', 'launching']) {
    const html = renderStart(saved({ status }))
    assert.match(html, /data-action="stop-start"/)
    assert.doesNotMatch(html, /data-action="retry-start"/)
  }
  const stopped = renderStart(saved({ status: 'stopped' }))
  assert.match(stopped, /Collaboration start stopped/)
  assert.doesNotMatch(stopped, /data-action="(?:retry|stop)-start"/)
})

test('a new prelaunch request stays accessible beside an older mission, with read-only and offline guards', () => {
  const html = renderStart(saved(), { data: { snapshots: [uiSnapshot()] } })
  assert.match(html, /data-swarm-start-controls="request-a"/)
  assert.match(html, /value="start:request-a" selected=""/)
  assert.doesNotMatch(renderStart(saved(), { data: { writable: false } }), /data-action="(?:retry|stop)-start"/)
  assert.match(renderStart(saved(), { connection: 'reconnecting' }), /data-action="retry-start" disabled=""/)
})

test('recovery sends requestId, never missionId or a frontend budget, and reads the request response', async () => {
  const calls = []
  const expected = saved({ status: 'planning', planningEpoch: 2, updatedAt: 201 })
  const result = await requestStartControl(async (endpoint, payload, signal) => {
    calls.push({ endpoint, payload, signal })
    return { request: expected }
  }, 'owner-a', saved(), 'retry')
  assert.equal(result, expected)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].endpoint, 'control')
  assert.deepEqual(calls[0].payload, {
    sessionId: 'owner-a', requestId: 'request-a', action: 'retry', reason: 'User selected retry for the saved Agent Swarm request.',
  })
  assert.ok(calls[0].signal instanceof AbortSignal)
  await assert.rejects(requestStartControl(async () => ({ request: saved({ id: 'other-request' }) }), 'owner-a', saved(), 'stop'), /Invalid saved request response/)
})

test('late recovery replies cannot overwrite a newer epoch or another owner', () => {
  const newer = saved({ status: 'stopped', planningEpoch: 3, updatedAt: 250 })
  const stale = saved({ status: 'planning', planningEpoch: 2, updatedAt: 300 })
  assert.equal(mergeStartResponse([newer], stale, 'owner-a')[0], newer)
  assert.equal(mergeStartResponse([newer], saved({ ownerSessionId: 'other', planningEpoch: 4 }), 'owner-a')[0], newer)
  const response = saved({ status: 'planning', planningEpoch: 4, updatedAt: 251 })
  assert.equal(mergeStartResponse([newer], response, 'owner-a')[0], response)
  const watched = { ...response, status: 'launching', updatedAt: 252 }
  assert.equal(mergeStartResponse([watched], response, 'owner-a')[0], watched)
})

test('deadline settles an uncooperative transport and late success never changes the selected UI', async () => {
  let resolveRequest, signal, calls = 0
  const updates = []
  await selectedOperation(() => true,
    () => requestWithDeadline((_endpoint, _payload, receivedSignal) => {
      calls++; signal = receivedSignal
      return new Promise(resolve => { resolveRequest = resolve })
    }, 'control', {}, 10), {
      success: () => updates.push('success'),
      failure: error => { assert.ok(error instanceof RequestDeadlineError); updates.push('unconfirmed') },
      settled: () => updates.push('settled'),
    })
  assert.equal(signal.aborted, true)
  assert.equal(calls, 1, 'mutations are never automatically retried')
  assert.deepEqual(updates, ['unconfirmed', 'settled'])
  resolveRequest({ request: saved({ status: 'planning' }) })
  await Promise.resolve()
  assert.deepEqual(updates, ['unconfirmed', 'settled'])
})

test('a recovery response arriving after selection changes cannot attach to the new request', async () => {
  let selected = true, finish
  const updates = []
  const pending = selectedOperation(() => selected,
    () => requestStartControl(() => new Promise(resolve => { finish = resolve }), 'owner-a', saved(), 'retry'), {
      success: () => updates.push('success'), failure: () => updates.push('failure'), settled: () => updates.push('settled'),
    })
  await Promise.resolve()
  selected = false
  finish({ request: saved({ status: 'planning', planningEpoch: 2 }) })
  await pending
  assert.deepEqual(updates, [])
})
