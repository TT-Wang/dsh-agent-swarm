/** M15: detail=full expands member task records instead of silently ignoring the flag. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

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

test('member detail=full returns bounded full task records; the default stays a compact board', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-observe-detail-'))
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }, new Workers())
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Inspect', objective: 'Expand records', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Inspect' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const actor = { sessionId: member.sessionId }
  const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Inspect detail', objective: 'Inspect the board', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'] })
  const claimed = await runtime.claim(actor, mission.id, task.id)
  assert.equal(claimed.attempt.ownerId, member.id)

  const focused = runtime.observe(actor, mission.id)
  assert.equal(focused.board[0].id, task.id)
  assert.equal(focused.board[0].objective, undefined, 'the default member board stays compact')
  assert.equal(focused.board[0].acceptance, undefined)
  assert(!('tasks' in focused), 'the complete board is not part of the member view')

  const full = runtime.observe(actor, mission.id, { detail: 'full' })
  assert.equal(full.board[0].id, task.id)
  assert.equal(full.board[0].objective, 'Inspect the board')
  assert.deepEqual(full.board[0].acceptance, ['works'])
  assert.match(full.detail, /complete task records/)
  assert(JSON.stringify(full).length < 20000, 'full records stay bounded')
})
