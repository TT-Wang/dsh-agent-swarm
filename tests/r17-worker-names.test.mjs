/**
 * The fixed human name pool and runtime assignment remain protocol contracts.
 * The current sidebar renders each durable member identity with the geometric
 * robot portrait, preserving the separate name and responsibility fields.
 * Pixel-grid implementation tests were retired with the unused pixel renderer;
 * agent-identity.test.mjs covers the current deterministic portrait generator.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { SwarmRuntime } from '../lib/runtime.js'
import { registerTools } from '../lib/tools.js'
import { WORKER_NAME_POOL, nextWorkerName } from '../lib/types.js'
import { MissionOverview } from '../lib/types/client/LiveWorkPanel.js'
import { SwarmBoard } from '../lib/types/client/SwarmBoard.js'
import { tempDirectory } from './temp-root.mjs'

/** The pool as the specification fixes it, in assignment order. */
const POOL = ['Ada', 'Alan', 'Anita', 'Barbara', 'Beatrice', 'Ben', 'Carol', 'Dennis', 'Dora', 'Ed',
  'Edsger', 'Elena', 'Emmy', 'Erik', 'Frances', 'Grace', 'Hedy', 'Ivan', 'Jean', 'Ken',
  'Linus', 'Margaret', 'Maria', 'Nadia', 'Niels', 'Olga', 'Omar', 'Peter', 'Radia', 'Raj',
  'Rich', 'Rita', 'Rosa', 'Ruth', 'Sophie', 'Tim', 'Vera', 'Vint', 'Wanda', 'Yukihiro']
/** Vendor and product tokens no worker name may carry. */
const VENDORS = ['claude', 'anthropic', 'openai', 'chatgpt', 'gpt', 'gemini', 'bard', 'llama', 'mistral', 'qwen',
  'deepseek', 'copilot', 'cursor', 'windsurf', 'grok', 'xai', 'microsoft', 'google', 'amazon', 'bedrock',
  'vertex', 'nvidia', 'apple', 'cohere', 'perplexity', 'huggingface', 'replit', 'tabnine', 'codex',
  'dsh', 'harness', 'swarm', 'agent']

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 6, maxDurationMs: 600000, maxTasks: 10, maxExperiments: 2 }

/** The only external boundary the runtime talks to; every host operation is controlled by the test. */
class Workers {
  started = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start(spec) { this.started.push(spec.member.id); if (this.refuseStart) throw new Error('worker refused to start') }
  async stop() {}
  isIdle() { return true }
  async dispose() {}
}

async function scenario(t, options = {}) {
  const directory = await tempDirectory('swarm-worker-names-')
  const workers = options.workers ?? new Workers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 20, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 3 }, workers)
  await runtime.start()
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner-worker-names' }
  const mission = runtime.create(owner, { title: 'Worker identity', objective: 'Name every worker from the fixed pool',
    workspace: directory, scope: ['src/'], acceptance: ['works'], budget: { ...budget, maxWorkers: options.maxWorkers ?? budget.maxWorkers } })
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  const exec = { agent: { id: owner.sessionId }, signal: new AbortController().signal }
  return {
    directory, runtime, workers, owner, mission, definitions, exec,
    add: input => runtime.addMember(owner, mission.id, input),
    rows: () => runtime.store.list('members', mission.id),
    current: id => runtime.store.get('members', id),
    events: () => runtime.store.events(mission.id, 500),
    calls: (tool, args) => definitions.get(tool).execute(args, exec),
  }
}

test('the pool is exactly the fixed 40-name assignment order and names no vendor or product', () => {
  assert.ok(Array.isArray(WORKER_NAME_POOL), 'the pool is an exported list')
  assert.ok(WORKER_NAME_POOL.length >= 40, `the pool carries at least 40 names (got ${WORKER_NAME_POOL.length})`)
  assert.deepEqual([...WORKER_NAME_POOL], POOL, 'the pool is exactly the specified names in assignment order')
  assert.equal(new Set(WORKER_NAME_POOL).size, WORKER_NAME_POOL.length, 'no name repeats inside the pool')
  for (const name of WORKER_NAME_POOL) {
    assert.match(name, /^[A-Z][a-z]+$/, `${name} is a plain human English given name, not an identifier or a product`)
    for (const token of VENDORS) assert.ok(!name.toLowerCase().includes(token), `${name} must not carry the vendor or product token "${token}"`)
  }
  // The pool is the assignment order, and it is consumed in that order.
  assert.equal(nextWorkerName([]), 'Ada', 'an empty roster starts at the head of the pool')
  assert.equal(nextWorkerName(['Ada', 'Alan']), 'Anita', 'the first unused name in assignment order is next')
  assert.equal(nextWorkerName(['Anita']), 'Ada', 'an out-of-order roster still takes the earliest unused name')
  assert.equal(nextWorkerName(POOL), undefined, 'an exhausted roster has no next name')
})

test('swarm_add_member assigns the next unused pooled name when the caller supplies none, through the tool boundary', async t => {
  const f = await scenario(t)
  const definition = f.definitions.get('swarm_add_member')
  assert.ok(definition, 'swarm_add_member is registered')
  // The registered schema is what the model sees and what the host validates.
  assert.deepEqual(definition.parameters.required, ['missionId', 'role'], 'name is optional at the tool boundary')
  assert.ok(Object.hasOwn(definition.parameters.properties, 'name'), 'name is still an accepted parameter')
  assert.deepEqual(validateJsonSchemaValue(definition.parameters, { missionId: f.mission.id, role: 'implementation' }), [],
    'the host validator accepts a name-less call against the registered schema')

  const established = new Set(f.events().map(event => event.type))
  const first = await f.calls('swarm_add_member', { missionId: f.mission.id, role: 'implementation' })
  assert.equal(first.result.name, 'Ada', 'the head of the pool is assigned first')
  assert.equal(first.result.role, 'implementation', 'the responsibility text is kept separately and unchanged')
  const second = await f.calls('swarm_add_member', { missionId: f.mission.id, role: 'Independent verification, never requirement discovery' })
  assert.equal(second.result.name, 'Alan', 'assignment is deterministic and ordered')
  assert.equal(second.result.role, 'Independent verification, never requirement discovery', 'role keeps the responsibility text verbatim')
  const third = await f.calls('swarm_add_member', { missionId: f.mission.id, role: 'r' })
  assert.equal(third.result.name, 'Anita')

  // Addressing stays by member id: the durable row is read by id, and the name is not an address.
  for (const member of [first.result, second.result, third.result]) {
    assert.match(member.id, /^member_/, 'the durable identity is the member id')
    assert.equal(f.current(member.id).name, member.name, 'the assigned name is durable on the member row')
    assert.notEqual(member.sessionId, member.name, 'the session is not addressed by a display name')
  }
  assert.deepEqual(f.rows().map(row => row.id).sort(), [first.result.id, second.result.id, third.result.id].sort())

  // An explicit name is still honoured, and a duplicate is still refused.
  const explicit = await f.calls('swarm_add_member', { missionId: f.mission.id, role: 'explicit', name: 'Grace' })
  assert.equal(explicit.result.name, 'Grace')
  await assert.rejects(f.calls('swarm_add_member', { missionId: f.mission.id, role: 'duplicate', name: 'Grace' }), /already exists/)
  assert.equal(f.rows().filter(row => row.name === 'Grace').length, 1, 'a display name identifies at most one member')

  // No new event kind and no naming side channel: the assignment is one member
  // row per admission (member/added) plus the tool's own span rows.
  const types = new Set(f.events().map(event => event.type))
  assert.ok(types.has('member/added'), 'the assignment is durable as the existing member/added fact')
  const introduced = [...types].filter(type => !established.has(type))
  assert.deepEqual(introduced.filter(type => !['member/added', 'trace/span'].includes(type)), [],
    `the no-name path emits no event kind of its own (introduced: ${introduced.join(', ')})`)

  // A delivery is addressed to the member id, never to the display name.
  const addressed = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to !== 'owner')
  assert.deepEqual(addressed.filter(delivery => delivery.to === 'Ada' || delivery.to === 'Alan'), [],
    'no delivery row addresses a display name')
})

test('assignment is unique, never reused while the mission is active, and needs no model turn', async t => {
  const f = await scenario(t)
  const [ada, alan] = [await f.add({ role: 'first' }), await f.add({ role: 'second' })]
  assert.deepEqual([ada.name, alan.name], ['Ada', 'Alan'])

  // The mission-stop path marks a member stopped (src/runtime.ts member/stopped);
  // its name stays taken for as long as the mission is active.
  f.runtime.store.put('members', { ...f.current(alan.id), status: 'stopped' })
  const third = await f.add({ role: 'third' })
  assert.equal(third.name, 'Anita', 'a stopped member\'s name is never handed to another worker')
  assert.notEqual(third.name, alan.name)
  assert.equal(new Set(f.rows().map(row => row.name)).size, f.rows().length, 'names are unique across the whole roster')

  // The name is chosen by the runtime, before and independently of any worker
  // start: a worker that cannot start still leaves its pooled name durable.
  const refusing = await scenario(t, { workers: Object.assign(new Workers(), { refuseStart: true }) })
  await assert.rejects(refusing.add({ role: 'refused' }), /refused to start/)
  const stopped = refusing.rows().find(row => row.status === 'stopped')
  assert.ok(stopped, 'the failed admission is durable')
  assert.equal(stopped.name, 'Ada', 'the pooled name was assigned with no worker or model turn involved')
  assert.equal(stopped.role, 'refused', 'role is stored separately from the assigned name')
})

test('the pool is the bound: exhaustion refuses a name-less admission by name and an explicit name still works', async t => {
  const f = await scenario(t, { maxWorkers: 45 })
  for (let index = 0; index < POOL.length; index++) {
    const member = await f.add({ role: `worker ${index}` })
    assert.equal(member.name, POOL[index], `assignment ${index} follows the pool order`)
  }
  await assert.rejects(f.add({ role: 'overflow' }), /pool|name/i, 'an exhausted pool refuses a name-less admission with a named exit')
  await assert.rejects(f.add({ role: 'overflow' }), error => /explicit/i.test(error.message), 'the refusal names the explicit-name exit')
  assert.equal(f.rows().length, POOL.length, 'the refusal admitted nothing')
  const named = await f.add({ role: 'overflow', name: 'Zoe' })
  assert.equal(named.name, 'Zoe', 'a caller-supplied name still admits after pool exhaustion')
  assert.equal(new Set(f.rows().map(row => row.name)).size, f.rows().length)
})

test('the sidebar renders name · role beside a stable accessible inline robot portrait without remote assets', async t => {
  const f = await scenario(t)
  const role = 'Replacement slot; implements exactly the acceptance strings it replaces'
  const member = await f.add({ role })
  // The real observation path the worker adapter uses, so the snapshot is durable state.
  f.workers.callbacks.activity(member.id, { id: 'operation-1', kind: 'model', startedAt: Date.now() - 1000, updatedAt: Date.now() })
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.members.find(row => row.id === member.id).activity.kind, 'model')
  const overview = renderToStaticMarkup(React.createElement(MissionOverview, { snapshot, live: true }))
  const focus = overview.slice(0, overview.indexOf('class="sw-live-view'))
  assert.ok(focus.includes(`${member.name} · ${role}`), 'the focus line names the member with the role beside it')
  assert.ok(focus.includes(`data-swarm-worker-name="${member.name}"`), 'the name is addressable in the projection')
  assert.ok(focus.includes(`data-swarm-worker-role="${role}"`), 'the role is addressable in the projection')
  assert.ok(!focus.includes('<svg'), 'the mission focus line draws no avatar')
  t.mock.method(globalThis, 'fetch', () => assert.fail('rendering a member portrait must not make a network request'))
  const render = value => renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot: value, onOpenWorker() {} }))
  const memberRow = markup => {
    const start = markup.indexOf(`data-swarm-member="${member.id}"`)
    assert.ok(start >= 0, 'the member has an addressable conversation button')
    return markup.slice(start, markup.indexOf('</button>', start))
  }
  const markup = render(snapshot), row = memberRow(markup)
  assert.ok(row.includes(member.name) && row.includes(role), 'the member row shows the name with the role beside it')
  assert.ok(row.includes(`aria-label="Open conversation: ${member.name}"`), 'the member navigation remains accessible')
  assert.ok(row.includes(`data-agent-identity="${member.id}"`), 'the portrait is bound to the durable member, not its display name')
  assert.ok(row.includes(`role="img" aria-label="${member.name}`), 'the portrait has an accessible identity label')
  assert.match(row, /<svg\b[^>]*aria-hidden="true"[^>]*focusable="false"/, 'decorative SVG geometry is hidden from focus and assistive technology')
  const renamed = structuredClone(snapshot)
  Object.assign(renamed.members.find(item => item.id === member.id), { name: 'Renamed worker', role: 'Updated responsibility' })
  const updated = memberRow(render(renamed))
  assert.ok(updated.includes('Renamed worker') && updated.includes('Updated responsibility'))
  assert.ok(updated.includes(`data-agent-identity="${member.id}"`))
  assert.deepEqual(updated.match(/<svg\b[\s\S]*?<\/svg>/)?.[0], row.match(/<svg\b[\s\S]*?<\/svg>/)?.[0], 'renaming or changing the role does not change the robot portrait')
  assert.ok(!/<(?:image|img|iframe|script|link)\b|\b(?:href|src)=|url\(/i.test(markup), 'the inline portrait introduces no external asset references')
})
