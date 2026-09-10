/**
 * R17-G12 (mission acceptance 12): every worker carries a human English name
 * from a fixed pool of at least 40 names containing no vendor or product name,
 * unique within its mission and never reused while the mission is active, with
 * its responsibility kept separately in `role`; the sidebar renders `name · role`
 * beside a deterministic minimal pixel avatar derived from the name; distinct
 * sprites are proven over the whole pool; and every protocol address stays the
 * member id.
 *
 * The proof obligations, in the order the acceptance states them:
 *  1. the pool is exactly the fixed 40-name assignment order and contains no
 *     vendor or product name (test 1);
 *  2. `swarm_add_member` assigns the next unused pooled name when the caller
 *     supplies none — driven THROUGH the registered tool boundary, whose schema
 *     the host's own validator accepts with no `name` — while an explicit name
 *     is still honoured, a duplicate is refused, and `role` is preserved
 *     verbatim (test 2);
 *  3. assignment is deterministic and unique, a name is never reused while the
 *     mission is active (including a stopped member's name), and the name is
 *     chosen by the runtime with no model turn: it is durable even when the
 *     worker itself cannot start (test 3);
 *  4. the pool is the bound: exhausting it refuses a name-less admission with a
 *     named exit while an explicit name still works (test 4);
 *  5. `avatarCells` is pure and deterministic, 8x8 and left-right symmetric with
 *     3-4 colours from the fixed palette and a bounded rect count (test 5);
 *  6. the whole pool yields 40 distinct sprites, the deterministic salt widens
 *     the hash without any hand-drawn per-name exception, and no name literal
 *     appears in the module (test 6);
 *  7. the sprite renders as inline SVG `<rect>`s with `shape-rendering:
 *     crispEdges`, is `aria-hidden`, and adds no image asset, no network
 *     request and no dependency (test 7).
 *
 * Pre-fix evidence: on the pre-change tree this file fails at module load — the
 * pool and `nextWorkerName` are absent from `lib/types.js` and
 * `lib/types/client/avatar.js` does not exist. Independently of that, the
 * no-name admission of test 2 is refused before the runtime is reached on the
 * pre-change tree: `swarm_add_member` declared `required: ['missionId','name',
 * 'role']` and read it through `text(a,'name')`, which throws
 * `[tool_argument_invalid]` for an absent value while the host validator
 * reports `missing required property "name"`.
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
import { AVATAR_CELL, AVATAR_GRID, AVATAR_MAX_CELLS, AVATAR_PALETTE, avatarCells, fnv1a32 } from '../lib/types/client/avatar.js'
import { MissionProgress } from '../lib/types/client/MissionProgress.js'
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
const spriteKey = sprite => JSON.stringify(sprite.cells.map(cell => [cell.x, cell.y, cell.color]))

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

test('avatarCells is pure, deterministic, symmetric, palette-bound and rect-bounded', () => {
  // FNV-1a, 32-bit, against its published vectors.
  assert.equal(fnv1a32(''), 0x811c9dc5)
  assert.equal(fnv1a32('a'), 0xe40c292c)
  assert.equal(fnv1a32('foobar'), 0xbf9cf968)
  assert.equal(AVATAR_GRID, 8, 'the sprite is an 8x8 grid')
  assert.ok(AVATAR_CELL > 0)
  assert.ok(AVATAR_PALETTE.length >= 4, 'a fixed palette of at least four colours')
  assert.equal(new Set(AVATAR_PALETTE).size, AVATAR_PALETTE.length)
  for (const name of [...POOL, 'Atlas', '', 'x', 'Yukihiro']) {
    const sprite = avatarCells(name)
    assert.equal(sprite.grid, AVATAR_GRID)
    assert.equal(sprite.cell, AVATAR_CELL)
    assert.deepEqual([...sprite.colors], [...new Set(sprite.colors)], 'the sprite names each of its colours once')
    assert.ok(sprite.colors.length >= 3 && sprite.colors.length <= 4, `${name}: 3-4 colours (got ${sprite.colors.length})`)
    for (const color of sprite.colors) assert.ok(AVATAR_PALETTE.includes(color), `${color} comes from the fixed palette`)
    assert.ok(sprite.cells.length >= 24, `${name}: a sprite is not a sliver (${sprite.cells.length} rects)`)
    assert.equal(sprite.cells.length % 2, 0, 'cells come in mirrored pairs')
    assert.ok(sprite.cells.length <= AVATAR_MAX_CELLS, `${name}: the rect count is bounded (${sprite.cells.length} <= ${AVATAR_MAX_CELLS})`)
    // Every cell is on the grid, carries a selected colour, and its mirror exists with the same colour.
    const byKey = new Map(sprite.cells.map(cell => [`${cell.x}:${cell.y}`, cell.color]))
    assert.equal(byKey.size, sprite.cells.length, 'no cell is drawn twice')
    for (const cell of sprite.cells) {
      assert.ok(Number.isInteger(cell.x) && cell.x >= 0 && cell.x < AVATAR_GRID, `${name}: x ${cell.x} is on the grid`)
      assert.ok(Number.isInteger(cell.y) && cell.y >= 0 && cell.y < AVATAR_GRID, `${name}: y ${cell.y} is on the grid`)
      assert.ok(sprite.colors.includes(cell.color))
      assert.equal(byKey.get(`${AVATAR_GRID - 1 - cell.x}:${cell.y}`), cell.color, 'the grid is left-right symmetric')
    }
    assert.equal(spriteKey(avatarCells(name)), spriteKey(sprite), 'the same name always yields the same sprite')
    assert.deepEqual(sprite.cells, avatarCells(name).cells, 'the sprite is a pure function of the name')
  }
  // Purity is order-independent: the pool rendered backwards yields the same sprites.
  const forward = POOL.map(name => spriteKey(avatarCells(name)))
  const backward = [...POOL].reverse().map(name => spriteKey(avatarCells(name))).reverse()
  assert.deepEqual(backward, forward, 'no call order or shared state changes a sprite')
})

test('the whole pool yields 40 distinct sprites, widened by salt and never by a hand-drawn exception', async () => {
  const sprites = POOL.map(name => spriteKey(avatarCells(name)))
  assert.equal(sprites.length, 40)
  assert.equal(new Set(sprites).size, 40, '40 names yield 40 distinct sprites')
  // The deterministic widening knob: every salt re-derives the whole family, and
  // the pool stays collision-free at each of them, so a collision is fixed by
  // salting the hash rather than by a per-name exception.
  for (const salt of [0, 1, 2, 3]) {
    const salted = POOL.map(name => spriteKey(avatarCells(name, salt)))
    assert.equal(new Set(salted).size, 40, `the pool stays 40/40 distinct at salt ${salt}`)
    assert.deepEqual(POOL.map(name => spriteKey(avatarCells(name, salt))), salted, 'the salt is deterministic')
  }
  let widened = 0
  for (const name of POOL) {
    if (spriteKey(avatarCells(name, 1)) !== spriteKey(avatarCells(name))) widened++
    if (spriteKey(avatarCells(name, 2)) !== spriteKey(avatarCells(name))) widened++
  }
  assert.ok(widened > 40, 'salting genuinely re-derives the family instead of being inert')
  // No hand-drawn exception: the module never names a pool member.
  const source = await readFile(new URL('../src/client/avatar.ts', import.meta.url), 'utf8')
  for (const name of POOL) assert.ok(!source.includes(`'${name}'`) && !source.includes(`"${name}"`), `avatar.ts must not special-case ${name}`)
  assert.ok(!/https?:|fetch\(|XMLHttpRequest|new Image|\.png|\.svg|\.jpg|\.webp/.test(source), 'no asset, no network, no image format')
  assert.ok(!/^\s*import\s/m.test(source) && !/\brequire\(/.test(source), 'the avatar module depends on nothing')
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(Object.hasOwn(pkg, 'dependencies'), false, 'no runtime dependency was added for the avatar')
})

test('the sidebar renders name · role beside an aria-hidden crispEdges sprite and adds no asset or request', async t => {
  const f = await scenario(t)
  const role = 'Replacement slot; implements exactly the acceptance strings it replaces'
  const member = await f.add({ role })
  // The real observation path the worker adapter uses, so the snapshot is durable state.
  f.workers.callbacks.activity(member.id, { id: 'operation-1', kind: 'model', startedAt: Date.now() - 1000, updatedAt: Date.now() })
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.members.find(row => row.id === member.id).activity.kind, 'model')
  const markup = renderToStaticMarkup(React.createElement(MissionProgress, { snapshot, live: true }))
  assert.ok(markup.includes(`${member.name} · ${role}`), 'the sidebar shows the name with the role beside it')
  assert.ok(markup.includes(`data-swarm-worker-name="${member.name}"`), 'the name is addressable in the projection')
  assert.ok(markup.includes(`data-swarm-worker-role="${role}"`), 'the role is addressable in the projection')
  assert.ok(markup.includes('shape-rendering="crispEdges"'), 'the sprite is rendered with crispEdges')
  assert.ok(markup.includes('aria-hidden="true"'), 'the sprite is decorative; the name text carries identity')
  const rects = markup.match(/<rect /g) ?? []
  assert.equal(rects.length, avatarCells(member.name).cells.length, 'exactly the sprite cells are drawn as inline rects')
  assert.ok(rects.length <= AVATAR_MAX_CELLS && rects.length >= 24, `the drawn rect count is bounded (${rects.length})`)
  assert.ok(!/<image|xlink:href|url\(|https?:|data:/i.test(markup), 'the sprite is inline: no image asset and no network request')
  assert.ok(!markup.includes('<img'), 'no image element is introduced')
})
