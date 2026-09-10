/**
 * S5 (b): every task write must agree with the task's own revision.
 *
 * The runtime previously had one global store revision (used only by the
 * fingerprint cache) and no compare-and-swap on task rows: a writer that read a
 * task, awaited something, and then wrote it back overwrote whatever decision
 * had been committed in between. That is the lost-update shape of the Row-13
 * P0, where an in-memory flag papered over a task row decided from stale
 * memory. This file proves the replacement:
 *
 *  - `Task.revision` is stamped by the store on every accepted write, and the
 *    caller's object is stamped in place, so read -> mutate -> write is a
 *    compare-and-swap without any in-memory gate;
 *  - a write that presents a revision another accepted write moved past is
 *    REFUSED (the row keeps the winner, the caller's transaction rolls back),
 *    with a stale-revision diagnostic that names the current revision and the
 *    imperative next step: read the task again and retry the write once;
 *  - the refusal is recorded durably (`task/stale-revision-refused`) even though
 *    the refused write rolled back, and the record outlives the process;
 *  - two writers that both read before either writes leave exactly one winner.
 *
 * Pair guards exercised here (every guard must name what it can co-fire with):
 *  - the mission queue (`SwarmRuntime.queues`, an in-memory promise chain): its
 *    loss cannot make two writers both win, because the CAS is in the store;
 *  - the writer-busy classification (`WriterBusyError` / `withWriterRetry`): a
 *    stale refusal is NOT contention and must not be retried as one;
 *  - the revision-keyed fingerprint cache (`RuntimeGates.fingerprintCache`):
 *    the refusal record advances the store revision, so the cached digest can
 *    never be the stale board's.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { SwarmStore, StaleTaskRevisionError, STALE_TASK_REFUSAL_EVENT, WriterBusyError, isSqliteBusy } from '../lib/store.js'
import { missionFingerprint } from '../lib/gates.js'
import { EVENT_VOCABULARY, eventVocabularyReport } from '../lib/trace.js'

/** The external execution boundary only: nothing in these tests dispatches work. */
class QuietWorkers {
  bind() {}
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop() {}
  /**
   * Deliberately false: `propose` kicks a deferred scheduling pass, and this
   * suite must own every task write. A dispatchable member would let that pass
   * claim the task underneath the writers being tested.
   */
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact() { return { commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async dispose() {}
}

const budget = { maxTokens: 1_000_000, maxSteps: 1_000, maxWorkers: 2, maxDurationMs: 3_600_000, maxTasks: 20, maxExperiments: 0 }

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-s5-revision-'))
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60_000, tickMs: 10_000,
    maxMessageChars: 20_000, maxEvents: 500, maxTasksPerMember: 10 }, new QuietWorkers())
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 's5-owner' }
  const mission = runtime.create(owner, { title: 'Revisions', objective: 'Prove per-task compare-and-swap', workspace: directory,
    scope: ['**'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  // The tick timer is deliberately not started: these tests drive writes directly
  // so the interleaving is deterministic rather than load-dependent.
  const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Task', objective: 'Task',
    kind: 'implementation', scope: ['**'], acceptance: ['works'], checks: ['true'], assigneeId: author.id })
  const store = runtime.store
  const refusals = () => store.events(mission.id, 500).filter(event => event.type === STALE_TASK_REFUSAL_EVENT)
  const twoReaders = () => { const record = store.get('tasks', task.id); return [structuredClone(record), structuredClone(record)] }
  const write = record => store.transaction(() => { record.assigneeId = author.id; store.put('tasks', record) })
  return { directory, runtime, store, owner, mission, stream, author, task, refusals, twoReaders, write }
}

test('S5: an accepted task write stamps the next revision onto the caller object', async t => {
  const f = await fixture(t)
  assert.equal(f.store.get('tasks', f.task.id).revision, 1, 'a newly admitted task is stamped with revision 1')
  const read = f.store.get('tasks', f.task.id)
  f.store.transaction(() => { read.status = 'pending'; f.store.put('tasks', read) })
  assert.equal(read.revision, 2, 'the caller object is stamped in place, so a later write of the same record agrees')
  assert.equal(f.store.get('tasks', f.task.id).revision, 2)
  assert.equal(f.store.taskRevision(f.task.id), 2, 'the durable revision is readable without reading the whole row')
})

test('S5: a task write that disagrees with the durable revision is refused with the current revision and the next step', async t => {
  const f = await fixture(t)
  const [winner, loser] = f.twoReaders()
  f.write(winner)
  const before = f.refusals().length
  let refusal
  try { f.write(loser) } catch (error) { refusal = error }
  assert.ok(refusal instanceof StaleTaskRevisionError, 'the disagreeing write is refused with the typed stale-revision error')
  assert.equal(refusal.code, 'stale_task_revision', 'callers branch on the stable code')
  assert.equal(refusal.taskId, f.task.id)
  assert.equal(refusal.expected, 1, 'the refusal names the revision the writer presented')
  assert.equal(refusal.current, 2, 'the refusal names the durable revision')
  assert.match(refusal.message, /revision 2/, 'the diagnostic names the current revision')
  assert.match(refusal.message, /Read task .* again/, 'the diagnostic carries the imperative next step: read')
  assert.match(refusal.message, /retry the write once with revision 2/, 'the diagnostic carries the imperative next step: retry once')
  assert.equal(refusal.nextStep, `Read task ${f.task.id} again (swarm_observe with taskId=${f.task.id}, or SwarmStore.get), then retry the write once with revision 2`)
  assert.equal(f.refusals().length, before + 1, 'exactly one durable refusal record is written for the refused write')
  assert.deepEqual(f.refusals().at(-1).data, { taskId: f.task.id, expected: 1, current: 2 }, 'the record names the attempted and the current revision')
})

test('S5: the refused write leaves the winner and rolls back every other write in its transaction', async t => {
  const f = await fixture(t)
  const [winner, loser] = f.twoReaders()
  f.write(winner)
  assert.throws(() => f.store.transaction(() => {
    loser.status = 'cancelled'
    f.store.put('tasks', loser)
    f.store.event(f.mission.id, 'probe/other-write', 'runtime', { note: 'must not survive the rollback' })
  }), StaleTaskRevisionError)
  assert.equal(f.store.get('tasks', f.task.id).status, 'pending', 'the winner is the only accepted task write')
  assert.equal(f.store.events(f.mission.id, 500).filter(event => event.type === 'probe/other-write').length, 0,
    'a refused compare-and-swap has no partial outcome: the rest of the transaction is rolled back')
})

test('S5: read-and-retry-once succeeds, and a second stale retry is refused again', async t => {
  const f = await fixture(t)
  const [winner, loser] = f.twoReaders()
  f.write(winner)
  assert.throws(() => f.write(loser), StaleTaskRevisionError)
  const reread = f.store.get('tasks', f.task.id)
  reread.status = 'pending'
  f.store.transaction(() => f.store.putTask(reread))
  assert.equal(reread.revision, 3, 'reading again and retrying once is accepted')
  const stillStale = structuredClone(loser)
  const [other] = f.twoReaders()
  f.write(other)
  assert.throws(() => f.write(stillStale), StaleTaskRevisionError, 'a second refusal means another writer won again, so the caller must re-read rather than overwrite')
})

test('S5: two writers that both read before either writes leave exactly one winner and a durable refusal', async t => {
  const f = await fixture(t)
  const [first, second] = f.twoReaders()
  const before = f.store.get('tasks', f.task.id).revision
  const barrier = () => new Promise(resolve => setTimeout(resolve, 0))
  const writer = async (record, status) => {
    await barrier()
    try { f.store.transaction(() => { record.status = status; f.store.put('tasks', record) }); return 'accepted' }
    catch (error) { return error }
  }
  const results = await Promise.all([writer(first, 'pending'), writer(second, 'cancelled')])
  const winners = results.filter(result => result === 'accepted')
  const refused = results.filter(result => result instanceof StaleTaskRevisionError)
  assert.equal(winners.length, 1, 'exactly one racing writer wins')
  assert.equal(refused.length, 1, 'exactly one racing writer is refused, never silently overwritten')
  assert.equal(f.store.get('tasks', f.task.id).revision, before + 1, 'the durable revision advanced exactly once')
  assert.equal(f.refusals().length, 1, 'the race leaves a durable record of the refusal')
  assert.equal(f.refusals()[0].data.current, before + 1)
})

test('S5: the refusal record is durable across a process restart', async t => {
  const f = await fixture(t)
  const [winner, loser] = f.twoReaders()
  f.write(winner)
  assert.throws(() => f.write(loser), StaleTaskRevisionError)
  await f.runtime.dispose()
  const reopened = new SwarmRuntime({ statePath: join(f.directory, 'state.sqlite'), leaseMs: 60_000, tickMs: 10_000,
    maxMessageChars: 20_000, maxEvents: 500, maxTasksPerMember: 10 }, new QuietWorkers())
  t.after(async () => { await reopened.dispose() })
  const recorded = reopened.store.events(f.mission.id, 500).filter(event => event.type === STALE_TASK_REFUSAL_EVENT)
  assert.equal(recorded.length, 1, 'the refused lost update is visible in the durable record after a restart')
  assert.deepEqual(recorded[0].data, { taskId: f.task.id, expected: 1, current: 2 })
})

test('S5 pair: the mission queue is not the guard — clearing it cannot make two writers both win', async t => {
  const f = await fixture(t)
  f.runtime.queues.clear()
  const [first, second] = f.twoReaders()
  const barrier = () => new Promise(resolve => setTimeout(resolve, 0))
  const writer = async (record, status) => {
    await barrier()
    try { f.store.transaction(() => { record.status = status; f.store.put('tasks', record) }); return 'accepted' }
    catch (error) { return error }
  }
  const results = await Promise.all([writer(first, 'pending'), writer(second, 'cancelled')])
  assert.equal(results.filter(result => result === 'accepted').length, 1,
    'with the in-memory queue lost, the store CAS still leaves exactly one winner')
  assert.equal(f.refusals().length, 1, 'and still records the refusal durably')
})

test('S5 pair: a stale refusal is not writer contention — it is neither retried nor classified busy', async t => {
  const f = await fixture(t)
  const [winner, loser] = f.twoReaders()
  f.write(winner)
  let refusal
  try { f.write(loser) } catch (error) { refusal = error }
  assert.equal(isSqliteBusy(refusal), false, 'a stale refusal is not SQLITE_BUSY')
  assert.equal(refusal instanceof WriterBusyError, false, 'a stale refusal is not a writer-busy conflict')
  assert.equal(f.refusals().length, 1, 'the refused write is not retried: one attempt, one record')
})

test('S5 pair: the revision-keyed fingerprint cache can never serve the stale board', async t => {
  const f = await fixture(t)
  const before = f.runtime.fingerprint(f.mission.id)
  assert.equal(before, missionFingerprint(f.runtime.fingerprintBoard(f.mission.id)), 'the digest is pure over durable state')
  const [winner, loser] = f.twoReaders()
  f.write(winner)
  assert.throws(() => f.write(loser), StaleTaskRevisionError)
  const after = f.runtime.fingerprint(f.mission.id)
  assert.equal(after, missionFingerprint(f.runtime.fingerprintBoard(f.mission.id)),
    'the refusal record advanced the store revision, so the cache recomputed instead of gating on the stale digest')
  f.runtime.fingerprintCache.clear()
  assert.equal(f.runtime.fingerprint(f.mission.id), after, 'losing the cache changes no digest (cache-only)')
})

test('S5: the generic store put is the same guard as putTask — no task write bypasses the CAS', async t => {
  const f = await fixture(t)
  const [winner, loser] = f.twoReaders()
  f.write(winner)
  assert.throws(() => f.store.transaction(() => f.store.put('tasks', loser)), StaleTaskRevisionError,
    'the funnel every call site uses is the guard, so no path can bypass it')
  const returned = f.store.putTask(f.store.get('tasks', f.task.id))
  assert.equal(returned, 3, 'putTask returns the revision it wrote')
})

test('S5: a new task record is accepted without a revision and a legacy row is migrated on its first accepted write', async t => {
  const f = await fixture(t)
  const created = { id: 'task_fresh', missionId: f.mission.id, workstreamId: f.stream.id, title: 'Fresh', objective: 'Fresh', kind: 'implementation',
    dependencies: [], scope: ['**'], acceptance: ['works'], checks: [], status: 'pending', priority: 0, experiment: false, epoch: 0, evidenceIds: [], createdAt: Date.now() }
  f.store.transaction(() => f.store.put('tasks', created))
  assert.equal(created.revision, 1, 'a brand-new row is stamped with revision 1')
  // A row written before per-task revisions existed carries no `revision`: its
  // first accepted write stamps one instead of refusing the bootstrap write.
  const legacyDirectory = await mkdtemp(join(tmpdir(), 'swarm-s5-legacy-'))
  t.after(async () => { await rm(legacyDirectory, { recursive: true, force: true }) })
  const store = new SwarmStore(join(legacyDirectory, 'state.sqlite'), { snapshotIntervalMs: 0 })
  t.after(() => store.close())
  const legacy = { ...created, id: 'task_legacy', revision: undefined }
  store.transaction(() => store.put('tasks', legacy))
  assert.equal(store.get('tasks', 'task_legacy').revision, 1, 'the legacy row is versioned by its first accepted write')
  assert.equal(store.taskRevision('task_legacy'), 1)
})

test('S5c: the durable stale-revision refusal type is registered and recognized by the vocabulary report', async t => {
  const f = await fixture(t)
  const [winner, loser] = f.twoReaders()
  f.write(winner)
  assert.throws(() => f.write(loser), StaleTaskRevisionError)
  const log = f.store.events(f.mission.id, 500)
  const recorded = log.filter(event => event.type === STALE_TASK_REFUSAL_EVENT)
  assert.equal(recorded.length, 1, 'the refusal is in the real mission log')
  // The type is emitted through an exported constant, which the vocabulary
  // scanner now resolves (tests/event-vocabulary.test.mjs); this test pins the
  // end-to-end consequence on a real mission log.
  assert.equal(typeof EVENT_VOCABULARY[STALE_TASK_REFUSAL_EVENT], 'string', 'the vocabulary names the emitted type')
  const report = eventVocabularyReport(log)
  assert.deepEqual(report.unrecognized, [], 'no event in the real mission log is unrecognized')
  assert.ok(report.recognized.includes(STALE_TASK_REFUSAL_EVENT), 'the report recognizes the refusal type')
})
