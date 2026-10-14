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
  const mission = runtime.create(owner, { title: 'Finish', objective: 'Cover every criterion', workspace: directory, scope: ['src/'], acceptance, budget }, { grantRoot: directory, source: 'session' })
  const put = task => { runtime.store.put('tasks', task); return task }
  return { runtime, owner, mission, put }
}
const record = (mission, id, kind, status, acceptance, commit, covers) => ({ id, missionId: mission.id, workstreamId: 'stream', title: id, objective: id, kind, dependencies: [],
  scope: ['src/'], acceptance, ...(covers === undefined ? {} : { covers }), checks: [], status, priority: 50, experiment: false, epoch: 0, evidenceIds: [],
  ...(commit === undefined ? {} : { artifact: { commit, baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: [] } }) })

test('only an accepted deliverable covers a mission criterion: not a verification task, by its text or by an id its row holds, not an implementation without an artifact, and not a deliverable that was withdrawn', async t => {
  const f = await fixture(t, ['works', 'extra'])
  f.put(record(f.mission, 'deliverable', 'implementation', 'accepted', ['works'], '1'.repeat(40), ['c1']))
  // Each row holds c2 and fails exactly one condition: its kind, its missing artifact, its status.
  f.put(record(f.mission, 'review', 'verification', 'accepted', ['works', 'extra'], undefined, ['c2']))
  f.put(record(f.mission, 'uncaptured', 'implementation', 'accepted', [], undefined, ['c2']))
  f.put(record(f.mission, 'withdrawn', 'research', 'cancelled', [], undefined, ['c2']))
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.completion.eligible, false)
  assert.match(snapshot.completion.reason, /criterion: c2 "extra"\. /)
  assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'verification claims both'), /criterion: c2 "extra"\. /)
})

test('completion becomes eligible exactly when control(complete) succeeds', async t => {
  const f = await fixture(t, ['works', 'extra'])
  f.put(record(f.mission, 'deliverable', 'implementation', 'accepted', ['works'], '1'.repeat(40), ['c1']))
  f.put(record(f.mission, 'review', 'verification', 'accepted', ['works', 'extra']))
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).completion.eligible, false)
  f.put(record(f.mission, 'cover', 'research', 'accepted', ['works', 'extra'], undefined, ['c2']))
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.completion.eligible, true)
  assert.equal(snapshot.completion.reason, undefined)
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'covered').status, 'completed')
})

test('a deliverable\'s own acceptance text never covers a mission criterion: only a cited id does, and the reason names the id, its text and the exit', async t => {
  const f = await fixture(t, ['works', 'extra'])
  f.put(record(f.mission, 'deliverable', 'implementation', 'accepted', ['works', 'extra'], '1'.repeat(40), ['c1']))
  const reason = 'Accepted tasks do not cover every mission acceptance criterion: c2 "extra". Propose a deliverable that names them in `covers` with `swarm_propose`; an accepted task cannot gain covers'
  assert.deepEqual(f.runtime.snapshot(f.owner, f.mission.id).completion, { eligible: false, reason })
  assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'the text is there'), error => error.message === reason)
  f.put(record(f.mission, 'cover', 'research', 'accepted', [], undefined, ['c2']))
  assert.deepEqual(f.runtime.snapshot(f.owner, f.mission.id).completion, { eligible: true })
})

test('unfinished work makes completion ineligible with the same reason the control reports', async t => {
  const f = await fixture(t, ['works'])
  f.put(record(f.mission, 'deliverable', 'implementation', 'pending', ['works']))
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.completion.eligible, false)
  assert.match(snapshot.completion.reason, /unfinished or blocked required work/)
  assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'too early'), /unfinished or blocked required work/)
})
