/** T10: detail=full is owner-only; a member's later default reads are deltas. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime, ObserveDetailRefusedError } from '../lib/runtime.js'

const budget = { maxTokens: 10000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
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
async function focusedMission(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-observe-detail-'))
  const workers = new Workers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Inspect', objective: 'Expand records', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Inspect' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const actor = { sessionId: member.sessionId }
  const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Inspect detail', objective: 'Inspect the board', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'] })
  const claimed = await runtime.claim(actor, mission.id, task.id)
  assert.equal(claimed.attempt.ownerId, member.id)
  return { runtime, workers, owner, actor, mission, task, member }
}

test('worker detail=full is refused with a typed error while the owner path keeps complete records', async t => {
  const f = await focusedMission(t)

  const focused = f.runtime.observe(f.actor, f.mission.id)
  assert.equal(focused.board[0].id, f.task.id)
  assert.equal(focused.board[0].objective, undefined, 'the default member board stays compact')
  assert.equal(focused.board[0].acceptance, undefined)
  assert(!('tasks' in focused), 'the complete board is not part of the member view')

  let refusal
  assert.throws(() => f.runtime.observe(f.actor, f.mission.id, { detail: 'full' }), error => { refusal = error; return true })
  assert.ok(refusal instanceof ObserveDetailRefusedError, 'the refusal is the typed class')
  assert.equal(refusal.name, 'ObserveDetailRefusedError')
  assert.equal(refusal.code, 'observe_detail_full_owner_only')
  assert.match(refusal.message, /Only the mission owner/)
  assert.throws(() => f.runtime.observe(f.actor, f.mission.id, { taskId: f.task.id, detail: 'full' }), ObserveDetailRefusedError, 'every worker read path is refused')

  const full = f.runtime.observe(f.owner, f.mission.id, { detail: 'full' })
  assert.equal(full.board[0].id, f.task.id)
  assert.equal(full.board[0].objective, 'Inspect the board')
  assert.deepEqual(full.board[0].acceptance, ['works'])
  assert.match(full.detail, /Complete task records/)
  assert(JSON.stringify(full).length < 20000, 'full records stay bounded')
  assert.equal(f.runtime.observe(f.owner, f.mission.id).board[0].objective, undefined, 'the owner default stays compact')
})

test('a member with a delivered cursor gets only the delta by default', async t => {
  const f = await focusedMission(t)
  const first = f.runtime.observe(f.actor, f.mission.id)
  assert(first.current && Array.isArray(first.board), 'the first read is the focused view')
  assert(!('delta' in first))

  const empty = f.runtime.observe(f.actor, f.mission.id)
  assert.equal(empty.delta, true)
  assert.deepEqual(empty.events, [])
  assert.deepEqual(empty.toolRuns, [])
  for (const key of ['mission', 'member', 'current', 'board', 'members', 'evidence']) assert(!(key in empty), `an unchanged read must not re-send ${key}`)

  await f.workers.callbacks.toolRun(f.member.id, { tool: 'bash', arguments: { command: 'check' }, result: { exitCode: 0 }, isError: false })
  const delta = f.runtime.observe(f.actor, f.mission.id)
  assert.equal(delta.delta, true)
  assert.equal(delta.toolRuns.length, 1)
  assert(delta.events.some(event => event.type === 'tool/recorded'))
  assert(!('board' in delta) && !('members' in delta) && !('evidence' in delta))
  const repeat = f.runtime.observe(f.actor, f.mission.id)
  assert.deepEqual(repeat.toolRuns, [], 'a delivered run is never re-sent')
  assert.deepEqual(repeat.events, [], 'a delivered event is never re-sent')

  const explicit = f.runtime.observe(f.actor, f.mission.id, { after: first.nextAfter, afterRun: first.nextAfterRun })
  assert(explicit.current, 'explicit cursors still return the focused view')
  assert(Array.isArray(explicit.board))
})
