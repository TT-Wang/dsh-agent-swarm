/**
 * The mission progress clock is read from the append-only event log, where the
 * progress is made. Whether an event is progress is a property of its
 * registered kind (`EventSpec.progress`), and `SwarmStore.progressAt` is the
 * newest such row in the whole log, so no mission row carries a copy that a
 * writer could leave behind. `commit()` therefore runs exactly one transaction,
 * and after it does nothing that can throw, so a claim whose transaction
 * committed can never be reported as `writer_busy`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EVENTS } from '../lib/events.js'
import { WriterBusyError } from '../lib/store.js'
import { FakeClock, MISSION_ACCEPTANCE, makeRuntime, setup } from './faults/harness.mjs'

/** The progress kinds: task, evidence and owner-decision transitions (one historical kind an old log may still hold). */
const PROGRESS = [
  'mission/created', 'mission/resume', 'mission/budget-updated', 'mission/scope-amended',
  'task/proposed', 'task/claimed', 'task/submitted', 'task/accepted', 'task/rejected', 'task/cancelled', 'task/cancelled-at-completion', 'task/amended',
  'evidence/published', 'evidence/verified', 'evidence/refuted', 'message/answered', 'message/dismissed',
]

async function fixture(t, config = {}) {
  const clock = new FakeClock()
  const made = await makeRuntime(t, { clock, config })
  const { runtime, dir, budget } = made
  runtime.kick = () => {}
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Progress clock', objective: 'Measure progress where it is made', workspace: dir, scope: ['**'], acceptance: ['works'], budget }, { grantRoot: dir, source: 'session' })
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

test('a mission row put after progress in the same transaction cannot take the clock back', async t => {
  const f = await fixture(t)
  f.clock.advance(1000)
  f.runtime.commit(f.mission.id, () => {
    const read = f.store.get('missions', f.mission.id)
    f.store.event(f.mission.id, 'task/submitted', 'test', {})
    f.store.put('missions', { ...read, reason: 'written from a copy read before the progress' })
  })
  assert.equal(f.store.get('missions', f.mission.id).reason, 'written from a copy read before the progress')
  assert.equal(f.progressAt(), f.clock.now())
})

test('every real writer of a progress kind moves the clock to its own write; other writers leave it', async t => {
  const clock = new FakeClock()
  const f = await setup({ clock })
  t.after(f.cleanup)
  const { runtime, owner, mission } = f
  const clockAt = () => runtime.notices.interpretation(mission.id).lastTransitionAt
  const written = kind => runtime.store.events(mission.id, 5_000).filter(event => event.type === kind && event.createdAt === clock.now())
  /** Run one real writer at a fresh instant and read the clock against the rows it wrote. */
  const step = async (kinds, run, { progress = true } = {}) => {
    const before = clockAt()
    clock.advance(1000)
    const value = await run()
    for (const kind of kinds) assert.ok(written(kind).length > 0, `${kinds}: the writer wrote ${kind}`)
    assert.equal(clockAt(), progress ? clock.now() : before, `${kinds}: ${progress ? 'moves' : 'leaves'} the clock`)
    return value
  }
  assert.equal(clockAt(), clock.now(), 'mission/created starts the clock')
  const research = (title, extra = {}) => f.propose({ title, kind: 'research', checks: undefined, ...extra })
  const publish = (task, attemptId) => {
    const run = { id: `run_${task.id}_${clock.now()}`, seq: 1, missionId: mission.id, memberId: f.author.id, taskId: task.id, attemptId, tool: 'bash', arguments: {}, result: {}, isError: false, createdAt: clock.now() }
    runtime.store.transaction(() => runtime.store.put('tool_runs', run))
    return runtime.publish(f.actor(f.author), mission.id, { taskId: task.id, attemptId, claim: `${task.title} holds`, outcome: 'supported', toolRunIds: [run.id] })
  }
  const review = async (source, verdict, kinds) => {
    const proposed = await step(['task/proposed'], () => runtime.propose(owner, mission.id, { outputs: [], workstreamId: f.stream.id, title: `Review ${source.title}`, objective: 'Independent review',
      kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id }))
    const claimed = await step(['task/claimed'], () => runtime.claim(f.actor(f.reviewer), mission.id, proposed.id))
    await step(kinds, () => runtime.verify(f.actor(f.reviewer), mission.id, { taskId: proposed.id, attemptId: claimed.attempt.id, verdict, reason: `The independent review decides ${verdict}` }))
  }
  for (const [title, verdict, kinds] of [['Rejected finding', 'reject', ['task/rejected', 'evidence/refuted']], ['Accepted finding', 'accept', ['task/accepted', 'evidence/verified']]]) {
    const source = await step(['task/proposed'], () => research(title))
    const claimed = await step(['task/claimed'], () => runtime.claim(f.actor(f.author), mission.id, source.id))
    await step(['evidence/published'], () => publish(source, claimed.attempt.id))
    await step(['task/submitted'], () => runtime.submit(f.actor(f.author), mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: `${title} submitted` }))
    await review(source, verdict, kinds)
  }
  const spare = await step(['task/proposed'], () => research('Spare work'))
  await step(['task/amended'], () => runtime.controlTask(owner, mission.id, spare.id, 'amend', { maxSteps: 50 }, 'Bound the spare work'))
  await step(['mission/scope-amended'], () => runtime.amendScope(owner, mission.id, ['**'], 'Restate the scope'))
  await step(['mission/budget-updated'], () => runtime.updateBudget(owner, mission.id, { ...runtime.mission(mission.id).budget, maxTokens: runtime.mission(mission.id).budget.maxTokens + 1 }, 'More room'))
  await step(['mission/pause'], () => runtime.control(owner, mission.id, 'pause', 'Hold the work'), { progress: false })
  await step(['mission/resume'], () => runtime.control(owner, mission.id, 'resume', 'Continue the work'))
  const ask = async content => {
    await step(['message/queued'], () => runtime.message(f.actor(f.author), mission.id, { to: 'owner', kind: 'question', content }), { progress: false })
    await runtime.flushOutbox(mission.id)
    return runtime.store.list('deliveries', mission.id).filter(row => row.from === f.author.id && row.to === 'owner' && row.replyExpected).at(-1)
  }
  const first = await ask('Which answer is wanted?')
  await step(['message/answered'], () => runtime.message(owner, mission.id, { to: f.author.id, kind: 'question', replyTo: first.id, content: 'The complete one' }))
  const second = await ask('Is this still needed?')
  await step(['message/dismissed'], () => runtime.message(owner, mission.id, { to: f.author.id, kind: 'question', replyTo: second.id, dismiss: true, content: 'No longer needed' }))
  await step(['task/cancelled'], () => runtime.cancel(owner, mission.id, { taskId: spare.id, reason: 'The spare work is not needed' }))
})
