/** M10/L5: the runtime projects one delivery target and the last successful apply. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 10000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
class Workers {
  applied = 0
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return false }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [{ command: 'test', exitCode: 0, output: 'ok' }] }
  async prepareTask() {}
  async applyDelivery() { this.applied++; return { status: 'applied', changedPaths: [], conflicts: [] } }
  async dispose() {}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-delivery-target-'))
  const workers = new Workers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Deliver', objective: 'Chain integrations', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const put = task => { runtime.store.put('tasks', task); return task }
  return { runtime, workers, owner, mission, put }
}
const record = (mission, id, kind, status, dependencies, commit) => ({ id, missionId: mission.id, workstreamId: 'stream', title: id, objective: id, kind, dependencies,
  scope: ['src/'], acceptance: ['works'], checks: [], status, priority: 50, experiment: false, epoch: 0, evidenceIds: [],
  ...(commit === undefined ? {} : { artifact: { commit, baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: [] } }) })
function complete(f) {
  const mission = f.runtime.store.get('missions', f.mission.id)
  mission.status = 'completed'
  mission.baseline = { sourceHead: 'a'.repeat(40), snapshotCommit: 'b'.repeat(40), planningWorkspace: '/planning', changedPaths: [], createdAt: 1 }
  f.runtime.store.put('missions', mission)
  return mission
}

test('snapshot.deliveryTarget is the unique maximal integration, not the first accepted one', async t => {
  const f = await fixture(t)
  f.put(record(f.mission, 'impl', 'implementation', 'accepted', [], '1'.repeat(40)))
  f.put(record(f.mission, 'int-1', 'integration', 'accepted', ['impl'], '2'.repeat(40)))
  f.put(record(f.mission, 'int-2', 'integration', 'accepted', ['int-1'], '3'.repeat(40)))
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.deliveryTarget.taskId, 'int-2')
  assert.equal(snapshot.deliveryTarget.commit, '3'.repeat(40))
  // The legacy client rule (first accepted integration) would have picked int-1.
  assert.equal(snapshot.tasks.filter(task => task.kind === 'integration' && task.status === 'accepted')[0].id, 'int-1')
  assert.equal(snapshot.completion.eligible, true)
})

test('ambiguous independent integrations project no target and applyDelivery rejects them', async t => {
  const f = await fixture(t)
  f.put(record(f.mission, 'impl', 'implementation', 'accepted', [], '1'.repeat(40)))
  f.put(record(f.mission, 'int-a', 'integration', 'accepted', ['impl'], '2'.repeat(40)))
  f.put(record(f.mission, 'int-b', 'integration', 'accepted', ['impl'], '3'.repeat(40)))
  complete(f)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).deliveryTarget, undefined)
  await assert.rejects(f.runtime.applyDelivery(f.owner, f.mission.id), /unique accepted integration/)
  assert.equal(f.workers.applied, 0)
})

test('applyDelivery records the applied result durably and projects it in the snapshot', async t => {
  const f = await fixture(t)
  f.put(record(f.mission, 'impl', 'implementation', 'accepted', [], '1'.repeat(40)))
  f.put(record(f.mission, 'int-1', 'integration', 'accepted', ['impl'], '2'.repeat(40)))
  complete(f)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).appliedDelivery, undefined)
  assert.equal((await f.runtime.applyDelivery(f.owner, f.mission.id)).status, 'applied')
  assert.equal(f.runtime.store.get('missions', f.mission.id).appliedDelivery.resultCommit, '2'.repeat(40))
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).appliedDelivery.resultCommit, '2'.repeat(40))
  // A conflicts result must not claim the result was applied: the durable marker
  // and the projection are both cleared (I2 hand-off 4, reconciled at integration).
  f.workers.applyDelivery = async () => ({ status: 'conflicts', changedPaths: [], conflicts: ['x'] })
  assert.equal((await f.runtime.applyDelivery(f.owner, f.mission.id)).status, 'conflicts')
  assert.equal(f.runtime.store.get('missions', f.mission.id).appliedDelivery, undefined)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).appliedDelivery, undefined)
})
