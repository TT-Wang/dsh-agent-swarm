/**
 * T10 regression: replay the owner's recorded session shape and prove the
 * default observe read for a member with a delivered cursor is a delta.
 *
 * Baseline (docs/observe-context-measurement.md, decoded session JSONL): before,
 * two 9-call sessions re-sent 40-41K chars per call with a 44.6%/51.7% redundant
 * share; after the round-3 call-shape change, 12-20K per call at 7.6%/11.3%.
 * Redundancy is measured the way the owner measured it: content blocks (events,
 * tool runs, task records, evidence) charged by size when they duplicate the
 * previous read. The runtime now remembers each member's delivered event/run
 * position, so those blocks are never re-sent and only new content is returned.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime, ObserveDetailRefusedError } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const shape = JSON.parse(await readFile(new URL('./fixtures/observe-session-shape.json', import.meta.url), 'utf8'))

class Workers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return false }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}

/** Content blocks the owner's method charges: records the model could already have in context. */
function contentFragments(result) {
  const fragments = []
  for (const event of result.events ?? []) fragments.push(JSON.stringify(event))
  for (const run of result.toolRuns ?? []) fragments.push(JSON.stringify(run))
  for (const task of result.board ?? []) fragments.push(JSON.stringify(task))
  for (const evidence of result.evidence ?? []) fragments.push(JSON.stringify(evidence))
  if (result.current !== undefined && result.current !== null) fragments.push(JSON.stringify(result.current))
  return fragments
}

test('replayed member session returns only new content, refuses worker detail=full, and keeps the owner path', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-observe-delta-'))
  const workers = new Workers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Observe replay', objective: 'Replay the recorded observe shape', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Replay' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const actor = { sessionId: member.sessionId }
  const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Work', objective: 'Do the work', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'] })
  let current = await runtime.claim(actor, mission.id, task.id)

  const results = []
  let lastRunId
  for (const [index, turn] of shape.replay.turns.entries()) {
    for (let step = 0; step < turn.runs; step++) {
      lastRunId = await workers.callbacks.toolRun(member.id, {
        tool: 'bash', arguments: { command: `step ${index}-${step}`, note: 'x'.repeat(200 + index * 25) },
        result: { exitCode: 0, output: 'y'.repeat(300 + index * 40) }, isError: false,
      })
    }
    if (turn.evidence) {
      runtime.publish(actor, mission.id, { taskId: current.id, attemptId: current.attempt.id, claim: `Finding ${index}`, outcome: 'supported', toolRunIds: [lastRunId] })
    }
    if (turn.reassign) {
      await runtime.submit(actor, mission.id, { taskId: current.id, attemptId: current.attempt.id, output: 'first task done' })
      const next = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Follow-up', objective: 'Continue the session', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'] })
      current = await runtime.claim(actor, mission.id, next.id)
    }
    results.push(runtime.observe(actor, mission.id))
  }
  assert.equal(results.length, shape.replay.observeCalls)

  // (a) The first read is the focused view; every later default read is a delta
  // that re-sends no superseded content and only strictly newer events/runs.
  const first = results[0]
  assert.equal(first.member.id, member.id)
  assert.equal(first.current.task.id, task.id)
  assert(Array.isArray(first.board) && first.board.length > 0, 'the first read is the focused view')
  assert(!('delta' in first))
  let seenEvent = Math.max(0, ...first.events.map(event => event.seq))
  let seenRun = Math.max(0, ...first.toolRuns.map(run => run.seq))
  let changedAssignmentReads = 0
  for (const [index, result] of results.slice(1).entries()) {
    const call = index + 2
    assert.equal(result.delta, true, `call ${call} is a delta`)
    for (const key of ['mission', 'member', 'board', 'members', 'evidence']) assert(!(key in result), `delta ${call} must not re-send ${key}`)
    assert(!('current' in result) || result.current !== null, `delta ${call} carries only a changed assignment`)
    if ('current' in result) { changedAssignmentReads += 1; assert.equal(result.current.task.id, current.id, 'the changed assignment is the live one') }
    for (const event of result.events) { assert(event.seq > seenEvent, `delta ${call} re-sent event ${event.seq}`); seenEvent = Math.max(seenEvent, event.seq) }
    for (const run of result.toolRuns) { assert(run.seq > seenRun, `delta ${call} re-sent run ${run.seq}`); seenRun = Math.max(seenRun, run.seq) }
  }
  assert.equal(changedAssignmentReads, 1, 'the mid-session reassignment is delivered exactly once')

  // No content block is ever delivered twice across the whole session.
  const delivered = new Set()
  for (const result of results) for (const fragment of contentFragments(result)) {
    assert(!delivered.has(fragment), 'a content block was delivered twice')
    delivered.add(fragment)
  }

  // (d) Redundant share of consecutive observe results, measured over content
  // blocks exactly as the owner measured it.
  let content = 0, duplicated = 0
  for (const [index, result] of results.entries()) {
    const now = contentFragments(result)
    content += now.reduce((sum, fragment) => sum + fragment.length, 0)
    if (index > 0) {
      const previous = new Set(contentFragments(results[index - 1]))
      duplicated += now.filter(fragment => previous.has(fragment)).reduce((sum, fragment) => sum + fragment.length, 0)
    }
  }
  assert(content > 5000, `the fixture must carry real content: ${content}`)
  const share = duplicated / content
  const beforeShares = [shape.recorded.before.sessionA.redundantShare, shape.recorded.before.sessionB.redundantShare]
  const afterShares = [shape.recorded.after.sessionA.redundantShare, shape.recorded.after.sessionB.redundantShare]
  assert(Math.min(...beforeShares) > 0.4, 'the recorded pre-change baseline is 44.6-51.7%')
  assert(share < 0.05, `redundant share must fall below 5%: ${(share * 100).toFixed(2)}%`)
  assert(share < Math.min(...afterShares) / 2, 'the delta default beats the recorded round-3 call-shape baseline')

  // Each delta is bounded (hundreds-2K), and the whole session stays far below
  // the recorded 9 x 40-41K = ~369K chars.
  const sizes = results.map(result => JSON.stringify(result).length)
  assert(sizes[0] > 1000, 'the focused first read carries real content')
  for (const [index, size] of sizes.slice(1).entries()) assert(size < 5000, `delta ${index + 2} stays bounded: ${size}`)
  const total = sizes.reduce((sum, size) => sum + size, 0)
  assert(total < 40000, `the replayed session stays small: ${total} chars`)
  t.diagnostic(`redundant share ${(share * 100).toFixed(2)}% over ${content} content chars; observe sizes [${sizes.join(', ')}]; total ${total} chars`)

  // (b) A worker calling detail=full is refused with a typed error.
  let refusal
  assert.throws(() => runtime.observe(actor, mission.id, { detail: 'full' }), error => { refusal = error; return true })
  assert.ok(refusal instanceof ObserveDetailRefusedError, 'the refusal is the typed class')
  assert.equal(refusal.name, 'ObserveDetailRefusedError')
  assert.equal(refusal.code, 'observe_detail_full_owner_only')
  assert.match(refusal.message, /Only the mission owner/)
  assert.throws(() => runtime.observe(actor, mission.id, { taskId: current.id, detail: 'full' }), ObserveDetailRefusedError, 'by-id reads are refused too')

  // (c) The owner path still supports full detail and its default stays a compact board.
  const ownerFull = runtime.observe(owner, mission.id, { detail: 'full' })
  assert.match(ownerFull.detail, /Complete task records/)
  assert(ownerFull.board.length >= 2 && ownerFull.board.every(item => item.objective !== undefined), 'owner full expands every task record')
  const ownerDefault = runtime.observe(owner, mission.id)
  assert(!('delta' in ownerDefault), 'the owner read is not a member delta')
  assert(Array.isArray(ownerDefault.board) && ownerDefault.board.length >= 2 && ownerDefault.board.every(item => item.objective === undefined), 'the owner default stays compact')
  assert(Array.isArray(ownerDefault.members) && ownerDefault.members.length > 0)

  // By-id reads keep returning one full record and do not turn into deltas.
  const byId = runtime.observe(actor, mission.id, { taskId: current.id })
  assert.equal(byId.task.id, current.id)
  assert(!('delta' in byId))
})
