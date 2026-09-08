/** M11/M2: the projected completion state is exactly what control('complete') enforces. */
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
  async verifyArtifact() { return [{ command: 'test', exitCode: 0, output: 'ok' }] }
  async prepareTask() {}
  async dispose() {}
}
async function fixture(t, acceptance) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-completion-'))
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }, new Workers())
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Finish', objective: 'Cover every criterion', workspace: directory, scope: ['src/'], acceptance, budget })
  const put = task => { runtime.store.put('tasks', task); return task }
  return { runtime, owner, mission, put }
}
const record = (mission, id, kind, status, acceptance, commit) => ({ id, missionId: mission.id, workstreamId: 'stream', title: id, objective: id, kind, dependencies: [],
  scope: ['src/'], acceptance, checks: [], status, priority: 50, experiment: false, epoch: 0, evidenceIds: [],
  ...(commit === undefined ? {} : { artifact: { commit, baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: [] } }) })

test('a verification task acceptance string cannot cover a mission criterion', async t => {
  const f = await fixture(t, ['works', 'extra'])
  f.put(record(f.mission, 'deliverable', 'implementation', 'accepted', ['works'], '1'.repeat(40)))
  f.put(record(f.mission, 'review', 'verification', 'accepted', ['works', 'extra']))
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.completion.eligible, false)
  assert.match(snapshot.completion.reason, /"extra"/)
  assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'verification claims both'), /"extra"/)
})

test('completion becomes eligible exactly when control(complete) succeeds', async t => {
  const f = await fixture(t, ['works', 'extra'])
  f.put(record(f.mission, 'deliverable', 'implementation', 'accepted', ['works'], '1'.repeat(40)))
  f.put(record(f.mission, 'review', 'verification', 'accepted', ['works', 'extra']))
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).completion.eligible, false)
  f.put(record(f.mission, 'cover', 'research', 'accepted', ['works', 'extra']))
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.completion.eligible, true)
  assert.equal(snapshot.completion.reason, undefined)
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'covered').status, 'completed')
})

test('unfinished work makes completion ineligible with the same reason the control reports', async t => {
  const f = await fixture(t, ['works'])
  f.put(record(f.mission, 'deliverable', 'implementation', 'pending', ['works']))
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.completion.eligible, false)
  assert.match(snapshot.completion.reason, /unfinished or blocked required work/)
  assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'too early'), /unfinished or blocked required work/)
})
