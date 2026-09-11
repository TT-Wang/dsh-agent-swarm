/** D6 replay gate: deterministic command replay, named corruption/truncation/divergence failures. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  ReplayCorruptionError, ReplayDivergenceError, ReplayTruncationError, TraceContractError, TracePayloadStore,
  assertReplayParity, decodeDurableLog, orchestratorCommands, replayDigest, replayLabels, stableCommandKey, traceMetrics,
} from '../lib/trace.js'
import { runScenario } from '../scripts/replay/scenario.mjs'
import { ATTEMPT_FENCING_EVENTS } from '../lib/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN = join(HERE, '..', 'scripts', 'replay', 'golden-commands.json')
const COMPARED = new Set(['dispatch', 'stop', 'verify'])
const compared = (commands, labels) => commands.filter(command => COMPARED.has(command.kind)).map(command => stableCommandKey(command, labels))

const syntheticLog = () => [
  { seq: 1, missionId: 'm', type: 'member/added', actor: 'owner', data: { id: 'member-1' }, createdAt: 1 },
  { seq: 2, missionId: 'm', type: 'task/proposed', actor: 'owner', data: { id: 'task-1' }, createdAt: 2 },
  { seq: 3, missionId: 'm', type: 'task/claimed', actor: 'member-1', data: { taskId: 'task-1', attempt: { id: 'attempt-1', ownerId: 'member-1', epoch: 1 } }, createdAt: 3 },
  { seq: 4, missionId: 'm', type: 'task/submitted', actor: 'member-1', data: { taskId: 'task-1' }, createdAt: 4 },
  { seq: 5, missionId: 'm', type: 'task/accepted', actor: 'member-1', data: { sourceTaskId: 'task-1', verificationTaskId: 'task-2' }, createdAt: 5 },
]

test('replay derives the orchestrator command sequence with stable admission-order labels', () => {
  const events = syntheticLog()
  const replayed = orchestratorCommands(events)
  assert.deepEqual(replayed.keys, ['dispatch:task#1:member#1', 'verify:task#1'])
  assert.equal(replayed.digest, replayDigest(replayed.keys))
  assert.deepEqual(replayed.unresolved, [])
  // Two independent replays of the same durable log are byte-identical.
  assert.equal(orchestratorCommands(syntheticLog()).digest, replayed.digest)
  assert.deepEqual(orchestratorCommands(syntheticLog()).commands.map(command => command.kind), ['dispatch', 'verify'])
})

test('every attempt-fencing event closes the open attempt: restart re-pend and ceiling block included', () => {
  // The two readers used to carry hand-mirrored closer lists and both had lost
  // `task/restart-repended` (a host restart re-pends a running task) and
  // `task/ceiling-exhausted` (a task blocks at its own ceiling), so a durable
  // log the runtime itself wrote was refused as truncated by its own replay.
  // Each payload is the shape its emission site writes (src/runtime.ts and
  // src/attempts.ts): taskId is what closes the attempt, oldOwner is what the
  // lease-expiry path additionally carries for the stop command.
  const fence = (type, data) => orchestratorCommands([
    ...syntheticLog().slice(0, 3),
    { seq: 4, missionId: 'm', type, actor: 'runtime', data, createdAt: 4 },
  ])
  const fences = [
    ['task/restart-repended', { taskId: 'task-1', epoch: 2, ownerId: 'member-1', reason: 'host-restart' }],
    ['task/ceiling-exhausted', { taskId: 'task-1', dimension: 'steps', limit: 12, used: 12, code: 'task_ceiling_exhausted' }],
    ['task/lease-expired', { taskId: 'task-1', oldOwner: 'member-1' }],
  ]
  for (const [type, data] of fences) {
    const replayed = fence(type, data)
    assert.deepEqual(replayed.unresolved, [], `${type} closes the attempt it fences`)
    assert.ok(replayed.keys.includes('dispatch:task#1:member#1'), `${type} keeps the dispatch it fenced`)
  }
  // The declared vocabulary is the single source both readers consume.
  assert.deepEqual(Object.keys(ATTEMPT_FENCING_EVENTS).length > 0, true)
  assert.ok(ATTEMPT_FENCING_EVENTS.includes('task/restart-repended') && ATTEMPT_FENCING_EVENTS.includes('task/ceiling-exhausted'))
})

test('a truncated durable log fails with ReplayTruncationError, never a silent short sequence', () => {
  const truncated = syntheticLog().slice(0, 3)
  assert.throws(() => orchestratorCommands(truncated), error => {
    assert(error instanceof ReplayTruncationError)
    assert.match(error.message, /truncated/)
    assert.deepEqual(error.unresolved, ['task-1#attempt-1'])
    return true
  })
})

test('corrupted durable rows fail with ReplayCorruptionError before any command is derived', () => {
  const row = (overrides = {}) => ({ seq: 1, mission_id: 'm', type: 'mission/created', actor: 'owner', data: '{}', created_at: 1, ...overrides })
  assert.throws(() => decodeDurableLog([row({ data: '{not json' })]), ReplayCorruptionError)
  assert.throws(() => decodeDurableLog([row(), row({ seq: 1 })]), ReplayCorruptionError)
  assert.throws(() => decodeDurableLog([row(), row({ seq: 2, mission_id: 'other' })]), ReplayCorruptionError)
  assert.throws(() => decodeDurableLog([row({ seq: 0 })]), ReplayCorruptionError)
  assert.throws(() => decodeDurableLog([row({ type: '' })]), ReplayCorruptionError)
})

test('a contract-violating span row is a named TraceContractError, not a command', () => {
  const events = syntheticLog()
  events.push({ seq: 6, missionId: 'm', type: 'trace/span', actor: 'owner', data: { operation: 'bogus' }, createdAt: 6 })
  assert.throws(() => orchestratorCommands(events), TraceContractError)
})

test('divergence names the first differing command', () => {
  assert.throws(() => assertReplayParity(['a', 'b'], ['a', 'c'], 'golden'), error => {
    assert(error instanceof ReplayDivergenceError)
    assert.equal(error.index, 1); assert.equal(error.expected, 'b'); assert.equal(error.actual, 'c')
    return true
  })
  assert.throws(() => assertReplayParity(['a'], ['a', 'b'], 'golden'), ReplayDivergenceError)
  assert.doesNotThrow(() => assertReplayParity(['a'], ['a'], 'golden'))
})

test('the durable log replays the live recorded command sequence with zero provider calls', async t => {
  const scenario = await runScenario()
  t.after(() => rm(scenario.root, { recursive: true, force: true }))
  const db = new DatabaseSync(scenario.statePath, { readOnly: true })
  const rows = db.prepare('SELECT seq, mission_id, type, actor, data, created_at FROM events WHERE mission_id=? ORDER BY seq').all(scenario.missionId)
  db.close()
  const events = decodeDurableLog(rows)
  const labels = replayLabels(events)
  const replayed = orchestratorCommands(events)
  assertReplayParity(compared(scenario.commands, labels), compared(replayed.commands, labels), 'the recorded adapter command sequence')
  assertReplayParity(JSON.parse(await readFile(GOLDEN, 'utf8')).commands, compared(replayed.commands, labels), 'the committed golden sequence')
  assert.equal(scenario.providerCalls, 0, 'the scenario adapter never invokes a provider')
  assert.equal(events.some(event => event.type === 'trace/span'), true, 'the durable log carries span rows')

  const spans = events.filter(event => event.type === 'trace/span').map(event => event.data)
  const metrics = await traceMetrics(spans, { payloads: new TracePayloadStore(scenario.payloadDir) })
  assert.equal(metrics.contractCompliance, 1)
  assert.equal(metrics.firstViolatingStep, undefined)
  assert.equal(metrics.orphanParents, 0)
  assert(metrics.payloads.stored > 0 && metrics.payloads.verified === metrics.payloads.stored)
})
