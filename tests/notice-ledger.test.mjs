/**
 * Batch 11: the deliveries ledger is the one record that the owner was told.
 *
 * A board fact the classifier tells the owner (the W3 stall, an owner-assembled
 * mission's coverage-complete, a wedged pass's naming, a duplicate carrier) is
 * named by ONE field: the prefix of its dedup key, which is also its
 * `noticeFamily`, its reviewed template and its recorded statement. Its row is
 * outstanding exactly while its own condition holds under the identity it was
 * told with, so relevance and reminders judge the fact itself, never another
 * family's rows. The runtime reads the fake clock and runs no tick timer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeClock, acceptThroughReview, blockThroughReview, events, setup, taskOf } from './faults/harness.mjs'
import { noticeFamily, noticeTemplateKey } from '../lib/notices.js'

const ownerRows = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice !== undefined)
const stallRow = f => ownerRows(f).find(delivery => delivery.notice.trigger === 'mission/stalled' && delivery.content.startsWith('Mission stalled'))
const coverageRow = f => ownerRows(f).find(delivery => /is ready to complete/.test(delivery.content))
/** The W3 stall's own events: the board classifier's `mission/stalled`, which carries no cause. */
const boardStallEvents = f => events(f.runtime, f.mission.id, 'mission/stalled').filter(event => event.data.cause === undefined)
const ticks = async (f, count) => { for (let tick = 0; tick < count; tick += 1) { f.clock.advance(f.runtime.config.tickMs); await f.runtime.tick() } }
const relevant = (f, delivery) => f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), f.runtime.store.get('deliveries', delivery.id))
/** The one field: key prefix, family and, for a templated body, its template and statement. */
const names = delivery => ({ prefix: delivery.notice.dedupKey.split(':')[0], family: noticeFamily(delivery),
  template: noticeTemplateKey(delivery), statement: delivery.notice.statement?.family })

test('L-21: the W3 stall, coverage-complete, duplicate-carrier and wedged-pass rows are each named by one field', async t => {
  const clock = new FakeClock()
  const stalled = await setup({ clock })
  t.after(stalled.cleanup)
  await blockThroughReview(stalled, stalled.propose({ title: 'Dead end' }))
  await stalled.runtime.settle(stalled.mission.id)
  await stalled.runtime.tick()
  const stall = stallRow(stalled)
  assert.ok(stall, 'the stalled board told the owner')
  assert.deepEqual(names(stall), { prefix: 'board-stall', family: 'board-stall', template: 'board-stall', statement: 'board-stall' })
  // A wedged pass's naming is its own family, not the class a generic decision reads as.
  const scheduling = stalled.runtime.scheduling
  const pass = { id: scheduling.passKey(stalled.mission.id), operationId: 'operation_ledger_wedge', missionId: stalled.mission.id, startedAt: clock.now() - 60_000,
    revisionBefore: stalled.runtime.store.revision(), fingerprintBefore: stalled.runtime.fingerprint(stalled.mission.id) }
  scheduling.passes.set(stalled.mission.id, pass)
  t.after(() => scheduling.closePass(stalled.mission.id, pass))
  scheduling.checkSchedulingPasses()
  const naming = ownerRows(stalled).find(delivery => delivery.notice.trigger === 'scheduling-pass')
  assert.ok(naming, 'the wedged pass was named')
  assert.deepEqual(names(naming), { prefix: 'scheduling-pass', family: 'scheduling-pass', template: undefined, statement: undefined })

  const covered = await setup({ clock })
  t.after(covered.cleanup)
  const builder = await covered.runtime.addMember(covered.owner, covered.mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5_000 })
  // A replaced task still running when its repair is accepted: a duplicate carrier.
  const live = covered.propose({ title: 'Live original', assigneeId: builder.id })
  await covered.runtime.claim(covered.actor(builder), covered.mission.id, live.id)
  const repair = covered.propose({ title: 'Repair' })
  covered.runtime.commit(covered.mission.id, () => covered.runtime.store.put('tasks', { ...taskOf(covered.runtime, repair.id), replaces: [live.id] }))
  await acceptThroughReview(covered, repair)
  const duplicate = ownerRows(covered).find(delivery => delivery.notice.statement?.family === 'duplicate-carrier')
  assert.ok(duplicate, 'the duplicate carrier told the owner')
  assert.deepEqual(names(duplicate), { prefix: 'duplicate-carrier', family: 'duplicate-carrier', template: 'duplicate-carrier', statement: 'duplicate-carrier' })
  covered.runtime.cancel(covered.owner, covered.mission.id, { taskId: live.id, reason: 'The accepted repair carries it' })
  await covered.runtime.settle(covered.mission.id)
  await covered.runtime.tick()
  const coverage = coverageRow(covered)
  assert.ok(coverage, 'the coverage-complete board told the owner')
  assert.deepEqual(names(coverage), { prefix: 'coverage-complete', family: 'coverage-complete', template: 'coverage-complete', statement: 'coverage-complete' })
})

test('a queued coverage-complete decision is withheld once the mission completes', async t => {
  const clock = new FakeClock()
  const f = await setup({ clock })
  t.after(f.cleanup)
  await acceptThroughReview(f, f.propose())
  await f.runtime.settle(f.mission.id)
  await f.runtime.tick()
  const coverage = coverageRow(f)
  assert.ok(coverage, 'the coverage-complete board told the owner')
  assert.equal(relevant(f, coverage), true, 'outstanding while the owner has not decided')
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'The deliverable is accepted').status, 'completed')
  assert.equal(relevant(f, coverage), false, 'the completed mission withholds it, like every decision family')
})

test('a board that stalls while a pass runs is judged by the board classifier alone: no pass-count watchdog names it', async t => {
  const clock = new FakeClock()
  const f = await setup({ clock })
  t.after(f.cleanup)
  // The only independent member is gone, so the submission is never reviewed
  // and the board stalls on the clock alone, when its review grace runs out.
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
  await f.runtime.settle(f.mission.id)
  // Passes that change nothing, each spanning one tick of clock time, until
  // well past every grace: the stall falls due inside one of them.
  const scheduling = f.runtime.scheduling
  for (let elapsed = 0; elapsed <= 1_100; elapsed += f.runtime.config.tickMs) {
    const pass = scheduling.openPass(f.mission.id)
    clock.advance(f.runtime.config.tickMs)
    scheduling.closePass(f.mission.id, pass)
    await Promise.resolve()
  }
  assert.deepEqual(events(f.runtime, f.mission.id, 'mission/stalled').filter(event => event.data.cause === 'scheduling-pass'), [], 'no pass-count watchdog records the board')
  assert.deepEqual(ownerRows(f).filter(delivery => /consecutive scheduling passes/.test(delivery.content)), [], 'nor wakes the owner')
})

test('a W3 stall is told once per identity: a board that changes and returns to it writes no second row and no second event, and its row is outstanding again', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  await blockThroughReview(f, f.propose({ title: 'Dead end' }))
  await f.runtime.settle(f.mission.id)
  await ticks(f, 1)
  const stall = stallRow(f)
  assert.ok(stall, 'the stalled board told the owner')
  assert.equal(boardStallEvents(f).length, 1, 'its event is written with its row')
  assert.equal(boardStallEvents(f)[0].data.noticeKey, stall.notice.dedupKey, 'and names the row it accompanies')
  // Ready work ends the stall; withdrawing it returns the board to the same stuck work and diagnostic.
  const ready = f.propose({ title: 'Ready work' })
  assert.equal(relevant(f, stall), false, 'while the board can progress the stall is not outstanding')
  await ticks(f, 1)
  f.runtime.cancel(f.owner, f.mission.id, { taskId: ready.id, reason: 'Not needed after all' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 3)
  assert.equal(relevant(f, stall), true, 'the return re-opens the same decision')
  assert.deepEqual(ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith('board-stall:')).map(delivery => delivery.id), [stall.id], 'the same stall is one row')
  assert.equal(boardStallEvents(f).length, 1, 'and one event')
})

test('a coverage-complete board is never reported as a stall: an owner-assembled mission is told it may complete, an automatic one completes', async t => {
  for (const automatic of [false, true]) {
    const f = await setup({ clock: new FakeClock() })
    t.after(f.cleanup)
    if (automatic) f.runtime.store.transaction(() => f.runtime.store.put('starts', { id: 'start_ledger', ownerSessionId: f.owner.sessionId, commandId: 'ledger',
      goal: 'an automatic plan', workspace: f.dir, status: 'running', createdAt: f.clock.now(), updatedAt: f.clock.now(), missionId: f.mission.id }))
    // An automatic mission's tasks carry their recovery limit and check timeout.
    const task = f.propose({ maxRecoveryAttempts: 1, checkTimeoutMs: 30_000 })
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = f.propose({ title: 'Review', kind: 'verification', reviewOf: task.id, assigneeId: f.reviewer.id, checks: [], maxRecoveryAttempts: 1 })
    const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
    assert.equal(taskOf(f.runtime, task.id).status, 'accepted')
    // A wedged pass judges the whole board before any pass completes it.
    f.runtime.notices.ensureWitness(f.mission.id, { offPass: true, wedged: true })
    await f.runtime.settle(f.mission.id)
    await ticks(f, 3)
    assert.equal(stallRow(f), undefined, `automatic=${automatic}: a board with nothing left to do is not a stall`)
    assert.equal(ownerRows(f).filter(delivery => /is ready to complete/.test(delivery.content)).length, automatic ? 0 : 1, `automatic=${automatic}: only an owner-assembled mission is told it may complete, once`)
    assert.equal(f.runtime.mission(f.mission.id).status, automatic ? 'completed' : 'active')
  }
})

test('an unreviewable submission is the review admission\'s decision alone: the board classifier adds no W3 stall', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 150)
  const decisions = ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`review-blocked:${f.mission.id}:${task.id}:`))
  assert.equal(decisions.length, 1, 'the admission named the blocker once')
  assert.match(decisions[0].content, /no live member other than the author/)
  assert.equal(stallRow(f), undefined, 'no W3 stall restates it')
  assert.deepEqual(boardStallEvents(f), [])
})

test('a queued W3 stall is withheld once its board can progress, and coverage-complete reminds the owner until the mission completes', async t => {
  const stalled = await setup({ clock: new FakeClock() })
  t.after(stalled.cleanup)
  await blockThroughReview(stalled, stalled.propose({ title: 'Dead end' }))
  await stalled.runtime.settle(stalled.mission.id)
  await ticks(stalled, 1)
  const stall = stallRow(stalled)
  assert.ok(stall, 'the stalled board told the owner')
  assert.equal(relevant(stalled, stall), true, 'outstanding while the board stays stalled')
  stalled.propose({ title: 'Ready work' })
  assert.equal(relevant(stalled, stall), false, 'ready work ends the stall, so the queued decision is withheld')

  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const task = f.propose()
  await acceptThroughReview(f, task)
  await f.runtime.settle(f.mission.id)
  await ticks(f, 1)
  const coverage = coverageRow(f)
  assert.ok(coverage, 'the coverage-complete board told the owner')
  await f.runtime.flushOutbox(f.mission.id)
  assert.ok(f.runtime.store.get('deliveries', coverage.id).deliveredAt !== undefined, 'the decision reached the owner')
  f.clock.advance(f.runtime.notices.obligationFollowupMs)
  f.runtime.notices.absenceNet(f.mission.id)
  const reminder = ownerRows(f).find(delivery => delivery.notice.dedupKey === `obligation-followup:${coverage.id}:1`)
  assert.ok(reminder, 'the unresolved completion decision is reminded')
  assert.deepEqual(reminder.subjects, coverage.subjects, 'the reminder names the terminal work the decision named')
  assert.ok(reminder.subjects.includes(`${task.id}@${taskOf(f.runtime, task.id).epoch}`), 'among it the accepted deliverable')
})
