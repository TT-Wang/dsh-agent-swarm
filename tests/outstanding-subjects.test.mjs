/**
 * Each notice family has one rule for the subjects it still asserts, which its
 * delivery (`ownerDeliveryRelevant`) and its reminders (the obligation
 * follow-ups) both read: a fact is reminded exactly while it would still be
 * delivered, and of exactly what it still asserts. Before, a parked holder, a
 * dispatch question, a wedged pass's naming and a fall-through were delivered
 * by their own claim and reminded by another (`waitsLegitimately`, its
 * mission-level counterpart for a naming of the mission root, which reminded
 * only a blocked, paused, stalled or all-terminal board, or any subject where
 * delivery asked every one).
 *
 * Each case delivers its fact, lets one reminder interval pass, and asks the
 * relevance and the reminder of one board.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeClock, setup, taskOf } from './faults/harness.mjs'

const INTERVAL = 1_000
const ownerRows = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice !== undefined)
const family = (f, prefix) => ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(prefix))
const relevant = (f, delivery) => f.runtime.notices.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), f.runtime.store.get('deliveries', delivery.id))
const subjectOf = (f, task) => `${task.id}@${taskOf(f.runtime, task.id).epoch}`
/** Deliver what is queued, let one reminder interval pass, and return the subjects each reminder the absence net then wrote for `row` names. */
async function remind(f, row) {
  await f.runtime.notices.flushOutbox(f.mission.id)
  const reminders = () => ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`obligation-followup:${row.id}:`))
  const before = reminders().length
  f.clock.advance(INTERVAL)
  f.runtime.notices.absenceNet(f.mission.id)
  return reminders().slice(before).map(delivery => delivery.subjects)
}
async function fixture(t, options = {}) {
  const f = await setup({ clock: new FakeClock(), budget: { maxDurationMs: 86_400_000 }, ...options })
  t.after(f.cleanup)
  f.runtime.notices.obligationFollowupMs = INTERVAL
  // Every fact and reminder is its own delivery, never a constituent of a wake-budget summary.
  f.runtime.notices.wakeBudget = 0
  return f
}

test('a parked holder is reminded while the parked member holds its task, and not once it is active', async t => {
  const f = await fixture(t)
  const held = f.propose({ title: 'Held work' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, held.id)
  const phase = value => f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.author.id), phase: value }))
  phase('parked')
  f.runtime.kick(f.mission.id)
  await f.runtime.settle(f.mission.id)
  const [notice] = family(f, 'parked:')
  assert.ok(notice, 'the parked holder was told')
  assert.equal(relevant(f, notice), true, 'it is outstanding while the parked author holds the task')
  assert.deepEqual(await remind(f, notice), [[subjectOf(f, held)]], 'so it is reminded, naming the held task')
  phase('active')
  assert.equal(relevant(f, notice), false, 'not while the author that holds it is active')
  assert.deepEqual(await remind(f, notice), [], 'and so it is not reminded')
})

test('a dispatch question is reminded while its task is pending at its epoch, and not once it is not', async t => {
  const f = await fixture(t)
  // The author's handle can start; the reviewer's, which the ready work is pinned to, cannot, so the work is asked about and never dispatched.
  f.workers.idle.add(f.author.id)
  const ready = f.propose({ title: 'Ready work', assigneeId: f.reviewer.id })
  await f.runtime.settle(f.mission.id)
  f.runtime.notices.ensureWitness(f.mission.id)
  const [question] = family(f, 'dispatch-question:')
  assert.ok(question, 'the undispatched work is asked about')
  assert.deepEqual(question.subjects, [subjectOf(f, ready)])
  assert.deepEqual(await remind(f, question), [[subjectOf(f, ready)]], 'it is reminded while the task is pending')
  // The task is blocked at the same epoch: the question it answered no longer stands.
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', { ...taskOf(f.runtime, ready.id), status: 'blocked', output: 'blocked for repair' }))
  assert.deepEqual([subjectOf(f, ready), relevant(f, question)], [question.subjects[0], false], 'at the epoch it names, the question is no longer deliverable')
  assert.deepEqual(await remind(f, question), [], 'and it is not reminded')
})

test('a wedged pass\'s naming is reminded of the work it named while that work is unfinished at its epoch, a back-off it waits on included', async t => {
  const f = await fixture(t)
  const task = f.propose({ title: 'Never reached' })
  await f.runtime.settle(f.mission.id)
  const scheduling = f.runtime.scheduling
  const pass = { id: scheduling.passKey(f.mission.id), operationId: 'operation_wedge', missionId: f.mission.id, startedAt: f.clock.now() - 60_000,
    revisionBefore: f.runtime.store.revision(), fingerprintBefore: f.runtime.fingerprint(f.mission.id) }
  scheduling.passes.set(f.mission.id, pass)
  scheduling.checkSchedulingPasses()
  scheduling.closePass(f.mission.id, pass)
  const [naming] = family(f, 'scheduling-pass:')
  assert.deepEqual(naming.subjects, [subjectOf(f, task)], 'the naming names the work the pass never reached')
  // The work waits on the host's own bounded back-off at the epoch it was named at.
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', { ...taskOf(f.runtime, task.id),
    preparationFailure: { reason: 'Workspace or worker preparation failed: EBUSY', transient: true, attempts: 1, retryAt: f.clock.now() + 3_600_000 } }))
  assert.equal(relevant(f, naming), true, 'the naming is still deliverable: the work it named is unfinished at that epoch')
  assert.deepEqual(await remind(f, naming), [naming.subjects], 'so it is reminded, naming that work')
})

test('a wedged pass\'s naming of a board with no unfinished work names the mission root, and is reminded while the mission it named is unfinished, on a later board whose work runs under a live lease too', async t => {
  const f = await fixture(t)
  await f.runtime.settle(f.mission.id)
  const scheduling = f.runtime.scheduling
  const pass = { id: scheduling.passKey(f.mission.id), operationId: 'operation_wedge', missionId: f.mission.id, startedAt: f.clock.now() - 60_000,
    revisionBefore: f.runtime.store.revision(), fingerprintBefore: f.runtime.fingerprint(f.mission.id) }
  scheduling.passes.set(f.mission.id, pass)
  scheduling.checkSchedulingPasses()
  const [naming] = family(f, 'scheduling-pass:')
  assert.deepEqual(naming.subjects, [`mission:${f.mission.id}`], 'with no unfinished work, the naming names the mission root')
  // The owner plans work while the body is still wedged: a body is named once, so this row stays its only naming.
  const work = f.propose({ title: 'Planned after the wedge' })
  scheduling.checkSchedulingPasses()
  assert.deepEqual(family(f, 'scheduling-pass:').map(row => row.id), [naming.id], 'the body is not named again for the work planned while it is wedged')
  // The body settles; the planned work runs under a live lease, so nothing on the board waits illegitimately.
  scheduling.closePass(f.mission.id, pass)
  await f.runtime.settle(f.mission.id)
  await f.runtime.claim(f.actor(f.author), f.mission.id, work.id)
  assert.equal(taskOf(f.runtime, work.id).status, 'running')
  assert.equal(relevant(f, naming), true, 'the naming is deliverable while the mission it named is unfinished, as before: the board does not say whether its body is still wedged')
  assert.deepEqual(await remind(f, naming), [naming.subjects], 'so it is reminded by that rule, even while the work waits on its lease')
  assert.deepEqual(await remind(f, naming), [naming.subjects], 'and again: the reminder limit, not the board, ends its reminders')
  assert.deepEqual(await remind(f, naming), [], 'no reminder past the limit')
})

test('a fall-through is reminded while no live path advances any work it names, and not once one of them ended', async t => {
  const f = await fixture(t)
  const research = { kind: 'research', checks: [] }
  const running = f.propose({ title: 'Running work', ...research })
  await f.runtime.claim(f.actor(f.author), f.mission.id, running.id)
  const first = f.propose({ title: 'First withdrawn prerequisite', ...research }), second = f.propose({ title: 'Second withdrawn prerequisite', ...research })
  const dead = [f.propose({ title: 'Waits on the first', ...research, dependencies: [first.id] }), f.propose({ title: 'Waits on the second', ...research, dependencies: [second.id] })]
  await f.runtime.settle(f.mission.id)
  f.runtime.store.transaction(() => { for (const task of [first, second]) f.runtime.store.put('tasks', { ...taskOf(f.runtime, task.id), status: 'cancelled' }) })
  f.runtime.notices.ensureWitness(f.mission.id)
  const [fallthrough] = family(f, 'fallthrough:')
  assert.deepEqual(fallthrough.subjects, dead.map(task => subjectOf(f, task)), 'one fall-through names both dead tasks')
  assert.deepEqual(await remind(f, fallthrough), [fallthrough.subjects], 'it is reminded of both while neither has a live path')
  await f.runtime.cancel(f.owner, f.mission.id, { taskId: dead[0].id, reason: 'not needed' })
  await f.runtime.settle(f.mission.id)
  assert.equal(relevant(f, fallthrough), false, 'once one of them is withdrawn, the batch it asserted no longer stands')
  assert.deepEqual(await remind(f, fallthrough), [], 'and it is not reminded of the rest: the fall-through that names the rest is their fact')
  assert.ok(family(f, 'fallthrough:').some(delivery => delivery.subjects.length === 1 && delivery.subjects[0] === subjectOf(f, dead[1])), 'which the board\'s judgement told')
})
