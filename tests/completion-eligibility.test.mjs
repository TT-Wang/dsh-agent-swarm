/** M11/M2: the projected completion state is exactly what control('complete') enforces. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWorkers, makeRuntime } from './faults/harness.mjs'

async function fixture(t, acceptance) {
  const { dir: directory, runtime, budget } = await makeRuntime(t, {
    workers: new FakeWorkers({ artifact: { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] }, checks: [{ command: 'test', exitCode: 0, output: 'ok' }] }),
    config: { maxEvents: 100, checkTimeoutMs: undefined },
    budget: { maxTokens: 10000, maxSteps: 100, maxTasks: 20, maxExperiments: 2 },
  })
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
