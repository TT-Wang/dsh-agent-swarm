/** M10/L5: the runtime projects one delivery target and the last successful apply. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWorkers, makeRuntime } from './faults/harness.mjs'

class Workers extends FakeWorkers {
  applied = 0
  async applyDelivery() { this.applied++; return { status: 'applied', changedPaths: [], conflicts: [] } }
}
async function fixture(t) {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, {
    workers: new Workers(),
    config: { maxEvents: 100, checkTimeoutMs: undefined },
    budget: { maxTokens: 10000, maxSteps: 100, maxTasks: 20, maxExperiments: 2 },
  })
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Deliver', objective: 'Chain integrations', workspace: directory, scope: ['src/'], acceptance: ['works'], budget }, { grantRoot: directory, source: 'session' })
  const put = task => { runtime.store.put('tasks', task); return task }
  return { runtime, workers, owner, mission, put }
}
const record = (mission, id, kind, status, dependencies, commit) => ({ id, missionId: mission.id, workstreamId: 'stream', title: id, objective: id, kind, dependencies,
  scope: ['src/'], acceptance: ['works'], covers: ['c1'], checks: [], status, priority: 50, experiment: false, epoch: 0, evidenceIds: [],
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

test('only the owner session, never a worker session, inspects or applies a delivery; shutdown, owner, acceptance and baseline refuse in that order', async t => {
  const f = await fixture(t)
  f.put(record(f.mission, 'impl', 'implementation', 'accepted', [], '1'.repeat(40)))
  f.put(record(f.mission, 'int-1', 'integration', 'accepted', ['impl'], '2'.repeat(40)))
  const reached = []
  f.workers.inspectDelivery = async (_mission, resultCommit) => { reached.push('inspect'); return { resultCommit } }
  f.workers.applyDelivery = async () => { reached.push('apply'); return { status: 'applied', changedPaths: [], conflicts: [] } }
  // Each refusal is the runtime's own (web-api.ts checks the owner in front of
  // it, so its tests never reach this one), for both calls, before the adapter.
  const refused = async (actor, code) => {
    for (const call of ['inspectDelivery', 'applyDelivery']) {
      await assert.rejects(f.runtime[call](actor, f.mission.id), error => error.code === code, `${call} is refused with ${code}`)
    }
  }
  const stranger = { sessionId: 'stranger-session' }
  const member = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Worker', role: 'implementation', maxOutputTokens: 5_000 })
  // An active mission with no baseline: the owner check precedes acceptance and baseline.
  await refused(stranger, 'delivery_owner_required')
  await refused(f.owner, 'delivery_acceptance_required')
  const mission = f.runtime.store.get('missions', f.mission.id)
  mission.status = 'completed'
  f.runtime.store.put('missions', mission)
  await refused(stranger, 'delivery_owner_required')
  await refused(f.owner, 'delivery_baseline_missing')
  complete(f)
  await refused(stranger, 'delivery_owner_required')
  // Shutdown is refused before the owner is asked.
  f.runtime.shuttingDown = true
  await refused(stranger, 'runtime_shutting_down')
  await refused(f.owner, 'runtime_shutting_down')
  f.runtime.shuttingDown = false
  assert.deepEqual(reached, [], 'no refused call reached the adapter')
  assert.equal((await f.runtime.inspectDelivery(f.owner, f.mission.id)).resultCommit, '2'.repeat(40))
  assert.equal((await f.runtime.applyDelivery(f.owner, f.mission.id)).status, 'applied')
  assert.deepEqual(reached, ['inspect', 'apply'], 'the owner session reaches both')
  // A worker session never holds the owner's authority, even under the owner's session id.
  f.runtime.store.put('members', { ...f.runtime.store.get('members', member.id), sessionId: f.owner.sessionId })
  await refused(f.owner, 'delivery_owner_required')
  assert.deepEqual(reached, ['inspect', 'apply'], 'the worker session reached neither')
})
