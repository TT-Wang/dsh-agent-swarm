#!/usr/bin/env node
/**
 * D6 replay gate (`npm run test:replay`).
 *
 * 1. Runs the deterministic scenario through the real runtime and real model
 *    tools with a recording adapter that performs zero provider calls.
 * 2. Replays the orchestrator decision sequence from the durable event log
 *    (raw SQLite rows, decoded and validated) and requires it to equal both the
 *    adapter's recorded command sequence and the committed golden sequence.
 * 3. Re-runs the replay to prove determinism, and reports trace-level metrics
 *    (contract compliance, first violating step, payload verification).
 * 4. Fault-injects a truncated log, a corrupted log and a tampered log and
 *    requires the named errors `ReplayTruncationError`, `ReplayCorruptionError`,
 *    `TraceContractError` and `ReplayDivergenceError`.
 */
import { DatabaseSync } from 'node:sqlite'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  TraceContractError, TracePayloadStore, ReplayCorruptionError, ReplayDivergenceError, ReplayGraphError, ReplayTruncationError,
  assertReplayParity, decodeDurableLog, orchestratorCommands, replayDigest, replayLabels, stableCommandKey, traceMetrics,
} from '../../lib/trace.js'
import { runScenario } from './scenario.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN_PATH = join(HERE, 'golden-commands.json')
/** Commands the durable log and the adapter can both name exactly. */
const COMPARED_KINDS = new Set(['dispatch', 'stop', 'verify'])
const WRITE_GOLDEN = process.argv.includes('--write-golden')

const comparedKeys = (commands, labels) => commands.filter(command => COMPARED_KINDS.has(command.kind)).map(command => stableCommandKey(command, labels))
const readRows = (statePath, missionId) => {
  const db = new DatabaseSync(statePath, { readOnly: true })
  try { return db.prepare('SELECT seq, mission_id, type, actor, data, created_at FROM events WHERE mission_id=? ORDER BY seq').all(missionId) } finally { db.close() }
}
const expect = (condition, message) => { if (!condition) throw new Error(message) }
async function expectFailure(name, expected, operation) {
  try { await operation() }
  catch (error) {
    if (error?.name === expected) { console.log(`  fault ${name}: ${error.name} — ${error.message}`); return }
    throw new Error(`fault ${name} expected ${expected}, got ${error?.name ?? error}: ${error?.message ?? error}`)
  }
  throw new Error(`fault ${name} expected ${expected} but the replay succeeded`)
}

async function main() {
  let fetchCalls = 0
  globalThis.fetch = () => { fetchCalls++; throw new Error('the replay gate must perform zero provider calls') }
  const scenario = await runScenario()
  try {
    const rows = readRows(scenario.statePath, scenario.missionId)
    expect(rows.length > 0, 'the durable event log is empty')
    const events = decodeDurableLog(rows)
    const labels = replayLabels(events)
    const replayed = orchestratorCommands(events)
    const recordedKeys = comparedKeys(scenario.commands, labels)
    const replayKeys = comparedKeys(replayed.commands, labels)

    // The durable log must reconstruct exactly what the orchestrator did.
    assertReplayParity(recordedKeys, replayKeys, 'the recorded adapter command sequence')
    // Replay is deterministic: three independent replays agree byte-for-byte.
    const digests = [replayed.digest, orchestratorCommands(structuredClone(events)).digest, orchestratorCommands(structuredClone(events)).digest]
    expect(new Set(digests).size === 1, `replay is not deterministic: ${digests.join(', ')}`)

    if (WRITE_GOLDEN) {
      await writeFile(GOLDEN_PATH, `${JSON.stringify({ commands: replayKeys, digest: replayDigest(replayKeys) }, null, 2)}\n`)
      console.log(`wrote ${GOLDEN_PATH}`)
    } else {
      const golden = JSON.parse(await readFile(GOLDEN_PATH, 'utf8'))
      assertReplayParity(golden.commands, replayKeys, 'the committed golden sequence')
      expect(golden.digest === replayDigest(replayKeys), `golden digest drifted: ${golden.digest} != ${replayDigest(replayKeys)}`)
    }

    // Zero provider calls: the scenario adapter never invokes a model and the
    // process never fetches anything.
    expect(scenario.providerCalls === 0, `scenario adapter performed ${scenario.providerCalls} provider calls`)
    expect(fetchCalls === 0, `replay process performed ${fetchCalls} network calls`)

    // Trace-level metrics (F-44) over the durable span rows.
    const spans = events.filter(event => event.type === 'trace/span').map(event => event.data)
    const metrics = await traceMetrics(spans, { payloads: new TracePayloadStore(scenario.payloadDir) })
    expect(spans.length >= 10, `expected a span row per orchestration step, saw ${spans.length}`)
    expect(metrics.contractCompliance === 1, `span contract compliance is ${metrics.contractCompliance}: ${JSON.stringify(metrics.violations)}`)
    expect(metrics.firstViolatingStep === undefined, `unexpected first violating step: ${JSON.stringify(metrics.firstViolatingStep)}`)
    expect(metrics.orphanParents === 0, `causal closure broken for ${metrics.orphanParents} span(s)`)
    expect(metrics.payloads.stored > 0 && metrics.payloads.verified === metrics.payloads.stored, `payload digests did not verify: ${JSON.stringify(metrics.payloads)}`)
    expect(metrics.payloads.omitted === 0, `unexpected omitted payloads: ${metrics.payloads.omitted}`)

    // Fault injection: corruption, truncation and divergence are named failures.
    await expectFailure('corrupted JSON row', 'ReplayCorruptionError', () => {
      const bad = structuredClone(rows)
      bad[Math.floor(bad.length / 2)].data = '{not json'
      decodeDurableLog(bad)
    })
    await expectFailure('out-of-order log', 'ReplayCorruptionError', () => {
      const bad = structuredClone(rows)
      const swap = bad[1].seq
      bad[1].seq = bad[2].seq
      bad[2].seq = swap
      decodeDurableLog(bad)
    })
    await expectFailure('contract-violating span', 'TraceContractError', () => {
      const bad = structuredClone(events)
      const span = bad.find(event => event.type === 'trace/span')
      span.data.operation = 'bogus_operation'
      orchestratorCommands(bad)
    })
    await expectFailure('truncated log', 'ReplayTruncationError', () => {
      const cut = events.findIndex(event => event.type === 'task/accepted')
      expect(cut > 0, 'scenario never accepted the reviewed source')
      orchestratorCommands(events.slice(0, cut))
    })
    // DEAD: the graph validator runs on the replay path with the same function
    // admission uses, so a hand-corrupted graph is refused, not replayed.
    await expectFailure('illegal graph: dangling dependency', 'ReplayGraphError', () => {
      const bad = structuredClone(events)
      const proposed = bad.find(event => event.type === 'task/proposed' && Array.isArray(event.data.dependencies))
      expect(proposed !== undefined, 'the scenario never proposed a task with a dependency list')
      proposed.data.dependencies = [...proposed.data.dependencies, 'task_never_admitted']
      orchestratorCommands(bad)
    })
    await expectFailure('illegal graph: dependency cycle', 'ReplayGraphError', () => {
      const bad = structuredClone(events)
      const proposed = bad.filter(event => event.type === 'task/proposed')
      expect(proposed.length >= 2, `the scenario must propose at least two tasks to carry a cycle, saw ${proposed.length}`)
      proposed[0].data.dependencies = [proposed[1].data.id]
      proposed[1].data.dependencies = [proposed[0].data.id]
      orchestratorCommands(bad)
    })
    await expectFailure('tampered dispatch', 'ReplayDivergenceError', () => {
      const bad = structuredClone(events)
      const claim = bad.find(event => event.type === 'task/claimed')
      claim.data.attempt.ownerId = claim.data.attempt.ownerId === scenario.builderId ? scenario.reviewerId : scenario.builderId
      assertReplayParity(replayKeys, comparedKeys(orchestratorCommands(bad).commands, labels), 'the committed golden sequence')
    })
    await expectFailure('dropped dispatch event', 'ReplayDivergenceError', () => {
      const bad = structuredClone(events)
      bad.splice(bad.findIndex(event => event.type === 'task/claimed'), 1)
      assertReplayParity(replayKeys, comparedKeys(orchestratorCommands(bad).commands, labels), 'the committed golden sequence')
    })

    console.log('REPLAY OK')
    console.log(`  events: ${events.length} (${spans.length} spans), commands: ${replayed.commands.length}, compared: ${replayKeys.length}`)
    console.log(`  sequence: ${replayKeys.join(' -> ')}`)
    console.log(`  digest: ${replayDigest(replayKeys)}`)
    console.log(`  trace: contract compliance ${metrics.contractCompliance.toFixed(3)}, causal closure ${metrics.causalClosure.toFixed(3)}, first violating step ${metrics.firstViolatingStep === undefined ? 'none' : `${metrics.firstViolatingStep.step}: ${metrics.firstViolatingStep.reason}`}`)
    console.log(`  payloads: ${metrics.payloads.referenced} referenced, ${metrics.payloads.stored} stored, ${metrics.payloads.verified} verified, ${metrics.payloads.omitted} omitted`)
    console.log(`  provider calls: scenario ${scenario.providerCalls}, network ${fetchCalls}`)
  } finally {
    if (scenario.ownsRoot) await rm(scenario.root, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(`REPLAY FAILED: ${error?.name ?? 'Error'}: ${error?.message ?? error}`)
  if (error instanceof ReplayDivergenceError || error instanceof ReplayTruncationError || error instanceof ReplayCorruptionError || error instanceof TraceContractError || error instanceof ReplayGraphError) console.error(`  ${error.name}: ${JSON.stringify({ index: error.index, expected: error.expected, actual: error.actual, unresolved: error.unresolved, seq: error.seq, defects: error.defects })}`)
  process.exitCode = 1
})
