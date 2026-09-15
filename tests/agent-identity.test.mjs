import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentIdentity } from '../lib/types/client/agent-identity.js'
import { AgentAvatar } from '../lib/types/client/AgentAvatar.js'

test('durable identity survives rename and remount; legacy members use their name', () => {
  assert.deepEqual(agentIdentity('member-12', 'Atlas'), agentIdentity('member-12', 'Changed name'))
  assert.deepEqual(agentIdentity('member-12', 'Atlas'), agentIdentity('member-12', 'Atlas'))
  assert.deepEqual(agentIdentity(undefined, 'Atlas'), agentIdentity('', 'Atlas'))
  const portraits = Array.from({ length: 32 }, (_, i) => JSON.stringify(agentIdentity(`member-${i}`, 'Same name')))
  assert.ok(new Set(portraits).size >= 24, 'different durable members must stay recognisable in a typical roster')
})

test('changing state keeps the face and never marks stale or stopped avatars as active', () => {
  const render = state => renderToStaticMarkup(React.createElement(AgentAvatar, { id: 'member-12', name: 'Nova', state }))
  const active = render('active')
  assert.match(active, /aria-label="Nova · Working"/)
  const face = markup => markup.match(/<path d="M10 25[\s\S]*?(?=<g><circle class="sw-agent-avatar-status")/)[0]
  for (const state of ['waiting', 'idle', 'stopped', 'stale']) {
    const html = render(state)
    assert.equal(face(html), face(active), 'availability must not change member identity')
    assert.doesNotMatch(html, /class="sw-agent-avatar-ring"/)
    assert.doesNotMatch(html, /(?:\sid=|url\(#)/, 'repeated avatars must not share SVG definition IDs')
  }
  assert.match(render('stale'), /Current status unconfirmed/)
})
