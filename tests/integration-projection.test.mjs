/**
 * Integration (task_f6089dbe): the runtime must PROJECT the three snapshot fields
 * the accepted client consumes. Declaring them in `src/types.ts` is not projection,
 * and an absent field silently reverts the client to the pre-fix M10/M11/L5 rules.
 * This test binds the real runtime snapshot to the real client accessors.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeWorkers, makeRuntime } from './faults/harness.mjs'
import {
  readDeliveryTarget, readCompletion, readAppliedDelivery, deliverableCommit, deliveryApplied, completionBlocker
} from '../lib/types/client/projection.js'

async function fixture(t) {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, {
    workers: new FakeWorkers({
      artifact: { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] }, checks: [{ command: 'test', exitCode: 0, output: 'ok' }],
      async applyDelivery() { return { status: 'applied', changedPaths: [], conflicts: [] } },
    }),
    config: { maxEvents: 100, checkTimeoutMs: undefined },
    budget: { maxTokens: 10000, maxSteps: 100, maxTasks: 20, maxExperiments: 2 },
  })
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

test('the runtime projects the delivery target and completion in the shapes the client reads', async t => {
  const f = await fixture(t)
  f.put(record(f.mission, 'impl', 'implementation', 'accepted', [], '1'.repeat(40)))
  f.put(record(f.mission, 'int-1', 'integration', 'accepted', ['impl'], '2'.repeat(40)))
  f.put(record(f.mission, 'int-2', 'integration', 'accepted', ['int-1'], '3'.repeat(40)))
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  // The runtime projection is present and is the unique maximal integration, not the first accepted one.
  assert.deepEqual(snapshot.deliveryTarget, { taskId: 'int-2', commit: '3'.repeat(40) })
  assert.deepEqual(readDeliveryTarget(snapshot), { taskId: 'int-2', commit: '3'.repeat(40) })
  assert.equal(deliverableCommit(snapshot), '3'.repeat(40))
  assert.deepEqual(snapshot.completion, { eligible: true })
  assert.equal(readCompletion(snapshot).eligible, true)
  assert.equal(completionBlocker(snapshot), undefined)
})

test('the runtime projects the applied receipt and clears it on a conflicts result', async t => {
  const f = await fixture(t)
  f.put(record(f.mission, 'impl', 'implementation', 'accepted', [], '1'.repeat(40)))
  f.put(record(f.mission, 'int-1', 'integration', 'accepted', ['impl'], '2'.repeat(40)))
  complete(f)
  assert.equal(readAppliedDelivery(f.runtime.snapshot(f.owner, f.mission.id)), undefined)
  assert.equal((await f.runtime.applyDelivery(f.owner, f.mission.id)).status, 'applied')
  const applied = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(readAppliedDelivery(applied).resultCommit, '2'.repeat(40))
  assert.equal(deliveryApplied(applied, '2'.repeat(40)), true)
  f.workers.applyDelivery = async () => ({ status: 'conflicts', changedPaths: [], conflicts: ['x'] })
  assert.equal((await f.runtime.applyDelivery(f.owner, f.mission.id)).status, 'conflicts')
  const conflicted = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(readAppliedDelivery(conflicted), undefined)
  assert.equal(deliveryApplied(conflicted, '2'.repeat(40)), false)
})

test('a runtime snapshot missing the new projections is rejected by the client shape validators', async t => {
  const f = await fixture(t)
  f.put(record(f.mission, 'impl', 'implementation', 'accepted', [], '1'.repeat(40)))
  f.put(record(f.mission, 'int-1', 'integration', 'accepted', ['impl'], '2'.repeat(40)))
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  // A malformed projection must be rejected, not silently trusted.
  assert.equal(readDeliveryTarget({ ...snapshot, deliveryTarget: { taskId: 'int-1' } }), undefined)
  assert.equal(readCompletion({ ...snapshot, completion: { eligible: 'yes' } }), undefined)
  assert.equal(readAppliedDelivery({ ...snapshot, appliedDelivery: { resultCommit: 5 } }), undefined)
})
