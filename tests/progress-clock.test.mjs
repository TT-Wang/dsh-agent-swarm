/**
 * The mission progress clock is written by the transaction that makes the
 * progress. Whether an event is progress is a property of its registered kind
 * (`EventSpec.progress`), and `SwarmStore.event` advances the mission's
 * `meaningfulProgressAt` in the same write. `commit()` therefore runs exactly
 * one transaction, and after it does nothing that can throw, so a claim whose
 * transaction committed can never be reported as `writer_busy`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EVENTS } from '../lib/events.js'
import { WriterBusyError } from '../lib/store.js'
import { FakeClock, makeRuntime } from './faults/harness.mjs'

/** The progress kinds: task, evidence and owner-decision transitions. */
const PROGRESS = [
  'mission/created', 'mission/resume', 'mission/budget-updated', 'mission/scope-amended',
  'task/proposed', 'task/claimed', 'task/submitted', 'task/accepted', 'task/rejected', 'task/cancelled', 'task/amended',
  'evidence/published', 'evidence/verified', 'evidence/refuted', 'message/answered', 'message/dismissed',
]

async function fixture(t, config = {}) {
  const clock = new FakeClock()
  const made = await makeRuntime(t, { clock, config })
  const { runtime, dir, budget } = made
  runtime.kick = () => {}
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Progress clock', objective: 'Measure progress where it is made', workspace: dir, scope: ['**'], acceptance: ['works'], budget })
  // Every transaction the store opens, counted at the store boundary.
  const store = runtime.store, original = store.transaction.bind(store)
  const counter = { transactions: 0, failAfter: undefined }
  store.transaction = operation => {
    if (counter.failAfter !== undefined && counter.transactions >= counter.failAfter) throw new WriterBusyError('injected: the writer is busy', 1)
    const result = original(operation)
    counter.transactions++
    return result
  }
  const progressAt = () => runtime.notices.interpretation(mission.id).lastTransitionAt
  const absences = () => store.list('deliveries', mission.id).filter(row => row.notice?.dedupKey?.startsWith('absence:'))
  return { clock, runtime, store, owner, mission, counter, progressAt, absences }
}

test('the registry declares exactly the progress kinds', () => {
  assert.deepEqual(Object.keys(EVENTS).filter(kind => EVENTS[kind].progress === true).sort(), [...PROGRESS].sort())
})

test('a claim whose transaction committed is never refused as writer_busy', async t => {
  const f = await fixture(t)
  const stream = f.runtime.workstream(f.owner, f.mission.id, { title: 'Work', objective: 'Do the work' })
  const member = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Worker', role: 'research' })
  const proposed = f.runtime.propose(f.owner, f.mission.id, { workstreamId: stream.id, title: 'Research', objective: 'Find the answer', kind: 'research', scope: ['**'], acceptance: ['works'], outputs: [], assigneeId: member.id })
  // The claim's transaction commits; every transaction after it fails as a busy writer would.
  f.clock.advance(1000)
  f.counter.transactions = 0
  f.counter.failAfter = 1
  let claimed
  try { claimed = f.runtime.assign(f.store.get('tasks', proposed.id), f.store.get('members', member.id)) } finally { f.counter.failAfter = undefined }
  assert.equal(f.counter.transactions, 1, 'the claim is one transaction')
  assert.equal(claimed.status, 'running')
  assert.equal(f.store.get('tasks', proposed.id).status, 'running')
  assert.equal(f.store.latestTaskEvent(f.mission.id, proposed.id, 'task/claimed')?.data.attempt.id, claimed.attempt.id)
  // Nothing was queued as a writer conflict, so no writer_busy row is written later.
  f.runtime.refusals.recordWriterBusyRecovery()
  assert.deepEqual(f.store.admissions(f.mission.id, { reason: 'writer_busy' }), [])
})

test('commit() opens one transaction whether or not it made progress', async t => {
  const f = await fixture(t)
  for (const kind of ['task/submitted', 'member/activity']) {
    f.clock.advance(1000)
    f.counter.transactions = 0
    f.runtime.commit(f.mission.id, () => f.store.event(f.mission.id, kind, 'test', {}))
    assert.equal(f.counter.transactions, 1, `${kind}: one transaction`)
  }
})

test('the progress clock advances on progress kinds only and survives the event window', async t => {
  const f = await fixture(t, { maxEvents: 3 })
  assert.equal(f.progressAt(), f.mission.createdAt)
  for (const kind of PROGRESS) {
    f.clock.advance(1000)
    f.runtime.commit(f.mission.id, () => f.store.event(f.mission.id, kind, 'test', {}))
    assert.equal(f.progressAt(), f.clock.now(), `${kind} advances the clock`)
  }
  const committed = f.progressAt()
  for (const kind of ['member/activity', 'trace/span']) {
    f.clock.advance(1000)
    f.runtime.commit(f.mission.id, () => f.store.event(f.mission.id, kind, 'test', {}))
    assert.equal(f.progressAt(), committed, `${kind} does not advance the clock`)
  }
  // Progress written by any transaction (here one outside the commit funnel)
  // advances the clock, and telemetry that evicts it from the window does not
  // take it back.
  f.clock.advance(1000)
  f.store.transaction(() => f.store.event(f.mission.id, 'task/submitted', 'test', {}))
  const progress = f.clock.now()
  for (let index = 0; index < 5; index++) {
    f.clock.advance(1000)
    f.store.transaction(() => f.store.event(f.mission.id, index % 2 ? 'trace/span' : 'member/activity', 'test', { index }))
  }
  assert.ok(f.store.events(f.mission.id, 3).every(event => event.type !== 'task/submitted'), 'the progress event left the window')
  assert.equal(f.progressAt(), progress)
  // The absence net measures from that clock and fires at its declared bound.
  const bound = f.runtime.notices.absenceBoundMs
  f.clock.advance(progress + bound - 1 - f.clock.now())
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(f.absences().length, 0, 'quiet below the bound')
  f.clock.advance(1)
  f.runtime.notices.absenceNet(f.mission.id)
  assert.deepEqual(f.absences().map(row => row.notice.dedupKey), [`absence:${f.mission.id}:${progress}`])
})
