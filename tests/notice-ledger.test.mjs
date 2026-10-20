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
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FakeClock, FakeWorkers, MISSION_ACCEPTANCE, acceptThroughReview, blockThroughReview, eventually, events, setup, taskOf } from './faults/harness.mjs'
import { BOARD_RUNNING, completionError, interpret, isolationIssues, reviewNeed } from '../lib/board.js'
import { assertNamedCalls, ownerTools } from './refusal-inventory.mjs'
import { NOTICE_TEMPLATES, factKey, guardTerminalNotice, noticeFamily, noticeTemplateKey, reviewBlocked } from '../lib/notices.js'
import { passState } from '../lib/scheduling.js'

/** The publication state of the body queued or running for `missionId`, judged on its board. */
const stateOf = (runtime, missionId) => passState(runtime.scheduling.passes.get(missionId), runtime.boardOf(missionId))

const ownerRows = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice !== undefined)
const stallRow = f => ownerRows(f).find(delivery => delivery.notice.trigger === 'mission/stalled' && delivery.content.startsWith('Mission stalled'))
const coverageRow = f => ownerRows(f).find(delivery => /is ready to complete/.test(delivery.content))
/** The W3 stall's own events: the board classifier's `mission/stalled`, which carries no cause. */
const boardStallEvents = f => events(f.runtime, f.mission.id, 'mission/stalled').filter(event => event.data.cause === undefined)
const ticks = async (f, count) => { for (let tick = 0; tick < count; tick += 1) { f.clock.advance(f.runtime.config.tickMs); await f.runtime.tick() } }
/**
 * The boards a decision names stuck work on. Each holds one stuck task
 * (`stuck`), on a board with nothing else to do (`running` false: the W3 stall
 * names it) or beside unrelated work a third member keeps running (the
 * fall-through names it), and is judged once by the tick that follows.
 */
const stuckBoard = async (t, running, strand) => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const board = await strand(f)
  if (running) {
    const runner = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Runner', role: 'implementation', maxOutputTokens: 5_000 })
    await f.runtime.claim(f.actor(runner), f.mission.id, f.propose({ title: 'Unrelated work', kind: 'research', checks: [], assigneeId: runner.id }).id)
  }
  await f.runtime.settle(f.mission.id)
  await ticks(f, 1)
  return { f, ...board }
}
/** Work only the reviewer may take, dead once the reviewer is gone. */
const deadAssigneeBoard = (t, running = false) => stuckBoard(t, running, f => {
  const stuck = f.propose({ title: 'Reviewer-only work', kind: 'research', checks: [], assigneeId: f.reviewer.id })
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
  return { stuck }
})
/** A dependent a cancellation stranded: its prerequisite is withdrawn. */
const strandedBoard = (t, running) => stuckBoard(t, running, f => {
  const prerequisite = f.propose({ title: 'Prerequisite', kind: 'research', checks: [] })
  const stuck = f.propose({ title: 'Dependent', kind: 'research', checks: [], dependencies: [prerequisite.id] })
  const cancelled = f.runtime.cancel(f.owner, f.mission.id, { taskId: prerequisite.id, reason: 'Not needed' })
  return { stuck, prerequisite, cancelled }
})
/**
 * Pending work holding an id that names no task (T1, tests/dangling-reference.test.mjs): `edge` is its
 * dependency or its review source. The row is written as only a corrupted store holds it (no runtime path
 * admits a dangling edge), and the owner then withdraws the work it was copied from while it stands.
 */
const danglingBoard = (t, running, edge) => stuckBoard(t, running, f => {
  const template = f.propose({ title: 'Template' })
  const stuck = { ...taskOf(f.runtime, template.id), id: 'task_dangling', status: 'pending', epoch: 0, attempt: undefined, assigneeId: undefined,
    plannedAssigneeId: undefined, artifact: undefined, evidenceIds: [], output: undefined, ...edge }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', stuck))
  f.runtime.cancel(f.owner, f.mission.id, { taskId: template.id, reason: 'Leave the dangling row alone' })
  return { stuck }
})
/** A submission an older build left without an artifact, which the host's review admission does not review, past its review grace. */
const legacyBoard = (t, running) => stuckBoard(t, running, async f => {
  const stuck = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, stuck.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: stuck.id, attemptId: claimed.attempt.id, output: 'candidate' })
  f.runtime.store.transaction(() => { const row = taskOf(f.runtime, stuck.id); delete row.artifact; f.runtime.store.put('tasks', row) })
  f.clock.advance(Math.max(f.runtime.config.tickMs, 1_000))
  return { stuck }
})
/** An owner-assembled mission whose one task is accepted: coverage-complete, and the owner's to complete. */
const coverageBoard = async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const task = f.propose()
  await acceptThroughReview(f, task)
  await f.runtime.settle(f.mission.id)
  await ticks(f, 1)
  return { f, task }
}
/** Work no pass reached, held by a scheduling body the tick watchdog finds past its bound and names. */
const unreachedBoard = async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const stuck = f.propose({ title: 'Never reached' })
  await f.runtime.settle(f.mission.id)
  wedgedBody(t, f, 'operation_wedge_exit')
  return { f, stuck }
}
const relevant = (f, delivery) => f.runtime.notices.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), f.runtime.store.get('deliveries', delivery.id))
/** The swarm_* tools a text names, once each. */
const namedTools = text => [...new Set(text.match(/\bswarm_\w+/g))].sort()
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
  const { lastWitness } = stalled.runtime.observe(stalled.owner, stalled.mission.id)
  assert.deepEqual([lastWitness.class, lastWitness.family, lastWitness.dedupKey], ['decision', 'board-stall', stall.notice.dedupKey], 'the owner instruments name the last witness, the newest ledger row, by its family (spec §6)')
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

test('a coverage-complete board writes no stall event: the owner-assembled mission is told coverage-complete as its one record, over every tick', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  await acceptThroughReview(f, f.propose({ title: 'The whole deliverable' }))
  await f.runtime.settle(f.mission.id)
  await ticks(f, 3)
  assert.ok(coverageRow(f), 'the owner is told the mission is ready to complete')
  assert.equal(f.runtime.mission(f.mission.id).status, 'active', 'and decides: an owner-assembled mission does not complete itself')
  assert.deepEqual(events(f.runtime, f.mission.id, 'mission/stalled'), [], 'coverage is no stall: no mission/stalled event is written with its row')
})

test('queued board decisions are withheld once the mission completes: coverage-complete, a duplicate carrier and a wedged pass\'s naming', async t => {
  const clock = new FakeClock()
  const f = await setup({ clock })
  t.after(f.cleanup)
  const builder = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5_000 })
  // A replaced task still running when its repair is accepted: a duplicate carrier.
  const live = f.propose({ title: 'Live original', assigneeId: builder.id })
  await f.runtime.claim(f.actor(builder), f.mission.id, live.id)
  const repair = f.propose({ title: 'Repair' })
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', { ...taskOf(f.runtime, repair.id), replaces: [live.id] }))
  await acceptThroughReview(f, repair)
  const duplicate = ownerRows(f).find(delivery => delivery.notice.statement?.family === 'duplicate-carrier')
  assert.ok(duplicate, 'the duplicate carrier told the owner')
  // A body past its bound on this board, past the live-work bound the running original holds it to, is named.
  const scheduling = f.runtime.scheduling
  const pass = { id: scheduling.passKey(f.mission.id), operationId: 'operation_ledger_completed', missionId: f.mission.id, startedAt: clock.now() - f.runtime.bounds.stallPassReleaseBoundMs,
    revisionBefore: f.runtime.store.revision(), fingerprintBefore: f.runtime.fingerprint(f.mission.id) }
  scheduling.passes.set(f.mission.id, pass)
  scheduling.checkSchedulingPasses()
  scheduling.closePass(f.mission.id, pass)
  const naming = ownerRows(f).find(delivery => noticeFamily(delivery) === 'scheduling-pass')
  assert.ok(naming, 'the wedged pass was named')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: live.id, reason: 'The accepted repair carries it' })
  await f.runtime.settle(f.mission.id)
  await f.runtime.tick()
  const coverage = coverageRow(f)
  assert.ok(coverage, 'the coverage-complete board told the owner')
  assert.equal(relevant(f, coverage), true, 'outstanding while the owner has not decided')
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'The deliverable is accepted').status, 'completed')
  for (const row of [coverage, duplicate, naming]) assert.equal(relevant(f, row), false, `the completed mission withholds ${noticeFamily(row)}, like every decision family`)
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
  // The submission is the review admission's: the next real pass names it.
  await ticks(f, 1)
  const [decision] = ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`review-blocked:${f.mission.id}:${task.id}:`))
  assert.match(decision?.content ?? 'none', /no live member other than the author/, 'the admission names the stalled board\'s one subject')
  assert.deepEqual(ownerRows(f).filter(delivery => noticeFamily(delivery) === 'board-stall').map(delivery => delivery.subjects), [[`${task.id}@${taskOf(f.runtime, task.id).epoch}`]],
    'and the W3 stall of that board is told beside it, once: one more wording of the open item R20 (docs/known-limitations.md)')
})

test('the board classifier tells what a live pass left unpublished: the pass end publishes the board, and a wedged judgement tells its board facts, with no tick', async t => {
  for (const board of ['stall', 'coverage']) {
    for (const end of ['pass end', 'wedged judgement']) {
      const f = await setup({ clock: new FakeClock() })
      t.after(f.cleanup)
      // A live pass owns generation: the transitions inside it are published at its end.
      const scheduling = f.runtime.scheduling
      const pass = scheduling.openPass(f.mission.id)
      t.after(() => scheduling.closePass(f.mission.id, pass))
      if (board === 'stall') await blockThroughReview(f, f.propose({ title: 'Dead end' }))
      else await acceptThroughReview(f, f.propose())
      await Promise.resolve()
      const told = () => ownerRows(f).filter(delivery => ['board-stall', 'coverage-complete', 'stall-root'].includes(noticeFamily(delivery))).map(delivery => noticeFamily(delivery)).sort()
      assert.deepEqual(told(), [], `${board}, ${end}: nothing is told while the pass is live`)
      if (end === 'pass end') {
        scheduling.closePass(f.mission.id, pass)
        await Promise.resolve()
        assert.ok(told().includes(board === 'stall' ? 'stall-root' : 'coverage-complete'), `${board}: the pass end judged the board`)
      } else {
        f.runtime.notices.ensureWitness(f.mission.id, { wedged: true })
        assert.deepEqual(told(), board === 'stall' ? ['board-stall', 'stall-root'] : ['coverage-complete'], `${board}: the wedged judgement told the board facts`)
      }
    }
  }
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

test('a board fact is told under its own identity: the W3 stall\'s stuck work at its epochs and its diagnostic, coverage-complete\'s terminal work; a new identity is a new row, and the old one is no longer outstanding', async t => {
  const { f, stuck: dead } = await deadAssigneeBoard(t)
  const stalls = () => ownerRows(f).filter(delivery => noticeFamily(delivery) === 'board-stall')
  const [first] = stalls()
  assert.deepEqual(first?.subjects, [`${dead.id}@${taskOf(f.runtime, dead.id).epoch}`], 'the stalled board named its stuck work')
  // A structural amendment fences the stuck work at a new epoch; it stays stuck under the same diagnostic.
  f.runtime.controlTask(f.owner, f.mission.id, dead.id, 'amend', { scope: ['src/**'] }, 'Narrow the scope')
  await f.runtime.settle(f.mission.id)
  await ticks(f, 1)
  const [, fenced] = stalls()
  assert.deepEqual(fenced?.subjects, [`${dead.id}@${taskOf(f.runtime, dead.id).epoch}`], 'the stuck work at its new epoch is a new stall')
  assert.notDeepEqual(fenced.subjects, first.subjects)
  assert.equal(fenced.notice.reason, first.notice.reason, 'under the same diagnostic')
  assert.deepEqual([relevant(f, first), relevant(f, fenced)], [false, true], 'the earlier identity is no longer outstanding')
  // A submission an older build left without an artifact joins the unfinished work: the same stuck work under a new diagnostic.
  const source = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  f.runtime.store.transaction(() => { const row = taskOf(f.runtime, source.id); delete row.artifact; f.runtime.store.put('tasks', row) })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 150)
  const [, , diagnosed] = stalls()
  assert.deepEqual(diagnosed?.subjects, fenced.subjects, 'the same stuck work')
  assert.notEqual(diagnosed.notice.reason, fenced.notice.reason, 'under a new diagnostic is a new stall')
  assert.deepEqual([relevant(f, fenced), relevant(f, diagnosed)], [false, true])
  assert.deepEqual(boardStallEvents(f).map(event => event.data.noticeKey), stalls().map(delivery => delivery.notice.dedupKey), 'each stall has its one event')

  const { f: c } = await coverageBoard(t)
  const coverages = () => ownerRows(c).filter(delivery => noticeFamily(delivery) === 'coverage-complete')
  const [covered] = coverages()
  assert.ok(covered, 'the coverage-complete board told the owner')
  const extra = c.propose({ title: 'Extra work', kind: 'research', checks: [] })
  assert.equal(relevant(c, covered), false, 'unfinished work ends the coverage')
  c.runtime.cancel(c.owner, c.mission.id, { taskId: extra.id, reason: 'Not needed after all' })
  await c.runtime.settle(c.mission.id)
  await ticks(c, 1)
  const [, recovered] = coverages()
  assert.ok(recovered?.subjects.includes(`${extra.id}@${taskOf(c.runtime, extra.id).epoch}`), 'coverage with new terminal work is a new coverage state')
  assert.deepEqual([relevant(c, covered), relevant(c, recovered)], [false, true])
})

/**
 * What an exit does is its board's, and the words that name it are its
 * family's: the W3 stall and the fall-through name the same stuck work, so one
 * table of stuck work serves both. Performed, an exit retires the decision
 * (`outstanding: false`), or is admitted and leaves it outstanding, or is
 * refused with its code and changes nothing.
 */
const RETIRES = { outstanding: false }, STANDS = { outstanding: true }
const refused = code => ({ refused: code, outstanding: true })
const EXIT_WORDS = {
  // The W3 stall also names a budget change, which names no tool.
  'board-stall': { amend: 'amend the existing task dependencies or assignee with swarm_control', propose: 'admit a repair or review with swarm_propose',
    withdraw: 'withdraw it explicitly with swarm_cancel', stop: 'Use swarm_control stop' },
  // The fall-through's one swarm_control decision covers the amendment and the mission stop.
  fallthrough: { amend: 'decide with swarm_control', propose: 'admit a repair or review with swarm_propose',
    withdraw: 'withdraw the stuck work with swarm_cancel(taskId, reason)', stop: 'decide with swarm_control' },
  'coverage-complete': { complete: 'Use swarm_control complete', propose: 'admit more work with swarm_propose' },
  'scheduling-pass': { propose: 'admit a repair with swarm_propose', withdraw: 'withdraw the blocking work with swarm_cancel' },
}
const REASON = 'Follow the exit the decision names'
const work = (f, fields = {}) => ({ workstreamId: f.stream.id, title: 'More work', objective: 'Do the work the decision asks for', kind: 'research', scope: ['**'], outputs: [],
  acceptance: MISSION_ACCEPTANCE, checks: [], ...fields })
const amend = changes => ({ f, stuck, tool }) => tool('swarm_control', { action: 'amend', taskId: stuck.id, changes: changes(f), reason: REASON })
/** A repair of the board's `held` task, for the author: work that replaces it, an implementation unless `fields` say otherwise. */
const repair = (held, fields) => board => board.tool('swarm_propose', work(board.f, { title: 'Repair', kind: 'implementation', checks: ['test -d .'], assigneeId: board.f.author.id, ...fields,
  replaces: [board[held].id] }))
const withdraw = ({ stuck, tool }) => tool('swarm_cancel', { taskId: stuck.id, reason: REASON })
const stop = ({ tool }) => tool('swarm_control', { action: 'stop', reason: REASON })
const complete = ({ tool }) => tool('swarm_control', { action: 'complete', reason: REASON })
const more = ({ f, tool }) => tool('swarm_propose', work(f))
/** A review of the stuck submission: admitted, but it never reaches a verdict, since swarm_verify needs the captured artifact (docs/known-limitations.md). */
const review = async ({ f, stuck, tool }) => {
  const admitted = await tool('swarm_propose', { workstreamId: f.stream.id, title: 'Review the source', objective: 'Independently review the submitted artifact', kind: 'verification',
    scope: ['**'], outputs: [], acceptance: MISSION_ACCEPTANCE, reviewOf: stuck.id, assigneeId: f.reviewer.id })
  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, admitted.id)
  await assert.rejects(f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: admitted.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' }),
    /Only independent verification of a submitted artifact/, 'the admitted review never reaches a verdict')
}
/** The withdrawal of the stuck submission, after which the repair it admits reaches a verdict. */
const withdrawThenRepair = async board => {
  await withdraw(board)
  await acceptThroughReview(board.f, await repair('stuck')(board))
}
/** Stuck work, and what each exit the W3 stall and the fall-through name does to it: the same on a board with nothing else to do and beside running work. */
const STUCK = {
  'a dead assignee': [deadAssigneeBoard, [['amend', RETIRES, amend(f => ({ assigneeId: f.author.id }))],
    ['propose', refused('replacement_source_not_blocked'), repair('stuck')], ['withdraw', RETIRES, withdraw], ['stop', RETIRES, stop]]],
  'a dependent a cancellation stranded': [strandedBoard, [['amend', RETIRES, amend(() => ({ dependencies: [] }))],
    ['propose', RETIRES, repair('prerequisite', { kind: 'research', checks: [] })], ['withdraw', RETIRES, withdraw], ['stop', RETIRES, stop]]],
  'a dependency that names no task': [(t, running) => danglingBoard(t, running, { dependencies: ['task_missing'] }), [['amend', RETIRES, amend(() => ({ dependencies: [] }))],
    ['propose', refused('replacement_source_not_blocked'), repair('stuck')], ['withdraw', RETIRES, withdraw], ['stop', RETIRES, stop]]],
  // T1: neither the repair nor an amendment can clear it, so only the withdrawal and the mission stop retire its decision.
  'a review whose source names no task': [(t, running) => danglingBoard(t, running, { kind: 'verification', reviewOf: 'task_missing_source', covers: undefined }), [
    ['amend', refused('task_graph_invalid'), amend(f => ({ assigneeId: f.author.id }))], ['propose', refused('replacement_source_verification'), repair('stuck')],
    ['withdraw', RETIRES, withdraw], ['stop', RETIRES, stop]]],
  'a submission an older build left without an artifact': [legacyBoard, [
    ['amend', refused('artifact_policy_immutable'), amend(f => ({ assigneeId: f.reviewer.id }))], ['amend', refused('artifact_policy_immutable'), amend(() => ({ dependencies: [] }))],
    ['propose', refused('replacement_source_not_blocked'), repair('stuck')], ['propose', RETIRES, review], ['withdraw', RETIRES, withdrawThenRepair], ['stop', RETIRES, stop]]],
}

test('every exit a board decision names, performed through the owner\'s registered tools, does what its board decides: it retires the decision, is admitted and leaves it outstanding, or is refused and changes nothing; every kind of stuck work the W3 stall or the fall-through names is cleared by its withdrawal with swarm_cancel, which both name', async t => {
  const decisions = [
    ...Object.entries(STUCK).flatMap(([board, [build, exits]]) => [['board-stall', false], ['fallthrough', true]].map(([family, running]) => [family, board, t => build(t, running), exits])),
    ['coverage-complete', 'an accepted deliverable', coverageBoard, [['complete', RETIRES, complete], ['propose', RETIRES, more]]],
    ['scheduling-pass', 'work a wedged pass never reached', unreachedBoard, [['propose', STANDS, more], ['withdraw', RETIRES, withdraw]]],
  ]
  for (const [family, board, build, exits] of decisions) {
    const words = EXIT_WORDS[family]
    assert.deepEqual([...new Set(exits.map(([exit]) => exit))].sort(), Object.keys(words).sort(), `${family} on ${board}: every exit it names is performed`)
    for (const [exit, outcome, perform] of exits) {
      await t.test(`${family} on ${board}: ${words[exit]}`, async t => {
        const { f, ...held } = await build(t)
        const decision = ownerRows(f).find(delivery => noticeFamily(delivery) === family)
        assert.ok(decision, `the board told the owner its ${family}`)
        assert.deepEqual(namedTools(decision.content), namedTools(Object.values(words).join(' ')), 'every tool it names is an exit performed here')
        assert.ok(decision.content.includes(words[exit]), `it names: ${words[exit]}`)
        // An exit written as a call is checked against that tool's published schema.
        const calls = [...decision.content.matchAll(/(swarm_\w+)\(/g)].map(([, tool]) => tool)
        if (calls.length > 0) await assertNamedCalls(decision.content, calls)
        assert.equal(relevant(f, decision), true, 'it is outstanding')
        const before = held.stuck && taskOf(f.runtime, held.stuck.id)
        const performed = perform({ f, ...held, tool: await ownerTools(f) })
        if (outcome.refused === undefined) await performed
        else {
          assert.equal((await performed.then(value => assert.fail(`not refused: ${JSON.stringify(value)}`), error => error)).code, outcome.refused)
          assert.deepEqual(taskOf(f.runtime, held.stuck.id), before, 'the refused exit changes nothing')
        }
        assert.equal(relevant(f, decision), outcome.outstanding, outcome.outstanding ? 'it is still outstanding' : 'it retires the decision')
      })
    }
  }
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
    f.runtime.notices.ensureWitness(f.mission.id, { wedged: true })
    await f.runtime.settle(f.mission.id)
    await ticks(f, 3)
    assert.equal(stallRow(f), undefined, `automatic=${automatic}: a board with nothing left to do is not a stall`)
    assert.equal(ownerRows(f).filter(delivery => /is ready to complete/.test(delivery.content)).length, automatic ? 0 : 1, `automatic=${automatic}: only an owner-assembled mission is told it may complete, once`)
    assert.equal(f.runtime.mission(f.mission.id).status, automatic ? 'completed' : 'active')
  }
})

test('D3: a submission whose review need ripened, beside a dependent that waits on it, is never reported as a stall before the host admits its review, whichever route judges the board first', async t => {
  const grace = f => Math.max(f.runtime.config.tickMs, 1_000)
  const told = f => [boardStallEvents(f), ownerRows(f).filter(delivery => delivery.content.startsWith('Mission stalled'))]
  /** One deliverable submitted with no review, its dependent waiting on it, the reviewer idle; past its review grace with no write. */
  const deliver = async (f, index = 0) => {
    const source = f.propose({ title: `Deliverable ${index}` })
    const dependent = f.propose({ title: `Builds on deliverable ${index}`, kind: 'research', checks: [], dependencies: [source.id] })
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    await f.runtime.settle(f.mission.id)
    f.clock.advance(grace(f))
    const need = reviewNeed(f.runtime.boardOf(f.mission.id), taskOf(f.runtime, source.id))
    assert.deepEqual([need.ripe, need.recorded, interpret(f.runtime.boardOf(f.mission.id)).stalled], [true, false, false], `deliverable ${index}: before the next pass the need is ripe, the admission has yet to process it, and the board is not stalled by it`)
    return { source, dependent }
  }
  const admitted = (f, source) => f.runtime.store.list('tasks', f.mission.id).find(task => task.reviewOf === source.id)
  const routes = {
    'the pass start': async () => {},
    'an activity commit before the tick': async f => {
      f.workers.reportActivity(f.author.id, { id: 'operation_d3', kind: 'tool', tool: 'bash', startedAt: f.clock.now(), updatedAt: f.clock.now() })
      await Promise.resolve()
      f.workers.reportActivity(f.author.id, undefined)
      await Promise.resolve()
    },
    'a wedged publication': async f => { f.runtime.scheduling.expectWedgedRelease(f.mission.id); await Promise.resolve() },
  }
  for (const [route, judge] of Object.entries(routes)) {
    const f = await setup({ clock: new FakeClock() })
    t.after(f.cleanup)
    const { source } = await deliver(f)
    await judge(f)
    await f.runtime.tick()
    await f.runtime.settle(f.mission.id)
    assert.match(admitted(f, source)?.id ?? 'none', /^task_auto_review_/, `${route}: the pass admitted the host review`)
    assert.deepEqual(told(f), [[], []], `${route}: no W3 stall was told before it`)
  }
  // Twelve deliverables in sequence, each judged by an activity commit before its pass: none is first reported as a stall.
  const f = await setup({ clock: new FakeClock(), budget: { maxTasks: 40 } })
  t.after(f.cleanup)
  for (let index = 0; index < 12; index++) {
    const before = told(f).map(rows => rows.length)
    const { source, dependent } = await deliver(f, index)
    await routes['an activity commit before the tick'](f)
    await f.runtime.tick()
    await f.runtime.settle(f.mission.id)
    const review = admitted(f, source)
    assert.match(review?.id ?? 'none', /^task_auto_review_/, `deliverable ${index}: the pass admitted the host review`)
    assert.deepEqual(told(f).map(rows => rows.length), before, `deliverable ${index}: no W3 stall was told before it`)
    // The review accepts the deliverable and the owner withdraws its dependent, so the next deliverable meets a board with nothing to do.
    const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
    f.runtime.cancel(f.owner, f.mission.id, { taskId: dependent.id, reason: 'Not needed' })
    await f.runtime.settle(f.mission.id)
  }
  // A need the admission recorded beside running work, by deferring its review (BOARD_RUNNING): that work ends, and a wedged publication judges the board first.
  const recorded = await setup({ clock: new FakeClock() })
  t.after(recorded.cleanup)
  const running = recorded.propose({ title: 'Running work', kind: 'research', checks: [], assigneeId: recorded.reviewer.id })
  await recorded.runtime.claim(recorded.actor(recorded.reviewer), recorded.mission.id, running.id)
  const { source } = await deliver(recorded)
  await recorded.runtime.tick()
  await recorded.runtime.settle(recorded.mission.id)
  const deferred = ownerRows(recorded).filter(delivery => delivery.notice.dedupKey.startsWith(`review-blocked:${recorded.mission.id}:${source.id}:`))
  assert.deepEqual([reviewNeed(recorded.runtime.boardOf(recorded.mission.id), taskOf(recorded.runtime, source.id)).recorded, deferred.map(delivery => delivery.notice.reason), admitted(recorded, source)], [true, [BOARD_RUNNING], undefined], 'the admission recorded the need by deferring its review while the other work runs')
  recorded.runtime.cancel(recorded.owner, recorded.mission.id, { taskId: running.id, reason: 'Not needed' })
  recorded.runtime.scheduling.expectWedgedRelease(recorded.mission.id)
  await Promise.resolve()
  assert.deepEqual(told(recorded), [[], []], 'the recorded need: the wedged publication tells no W3 stall once the running work ends')
  await recorded.runtime.tick()
  await recorded.runtime.settle(recorded.mission.id)
  assert.match(admitted(recorded, source)?.id ?? 'none', /^task_auto_review_/, 'the recorded need: the next pass admitted the host review')
  assert.deepEqual(told(recorded), [[], []], 'the recorded need: no W3 stall was told before it')
})

test('D3-expiry: the running work ends inside the pass that recorded the BOARD_RUNNING deferral of a ripe need; no W3 stall is told before the host admits its review', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const told = () => [boardStallEvents(f), ownerRows(f).filter(delivery => delivery.content.startsWith('Mission stalled'))]
  // The reviewer runs work with no recovery left; the author submits a deliverable with no review, which a dependent waits on.
  const running = f.propose({ title: 'Running work', kind: 'research', checks: [], assigneeId: f.reviewer.id, maxRecoveryAttempts: 1 })
  await f.runtime.claim(f.actor(f.reviewer), f.mission.id, running.id)
  const source = f.propose({ title: 'Deliverable' })
  f.propose({ title: 'Builds on the deliverable', kind: 'research', checks: [], dependencies: [source.id] })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  await f.runtime.settle(f.mission.id)
  // One pass finds the need ripe beside the running work, and that work's lease already run out.
  f.clock.advance(f.runtime.config.leaseMs + f.runtime.config.tickMs)
  await f.runtime.tick()
  await f.runtime.settle(f.mission.id)
  const deferred = ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`review-blocked:${f.mission.id}:${source.id}:`))
  assert.deepEqual(deferred.map(delivery => delivery.notice.reason), [BOARD_RUNNING], 'the pass deferred the review while the work ran')
  const review = f.runtime.store.list('tasks', f.mission.id).find(task => task.reviewOf === source.id)
  assert.deepEqual([taskOf(f.runtime, running.id).status, review?.id.startsWith('task_auto_review_')], ['blocked', true], 'the expiry exhausted the running work\'s recovery, and the next pass admitted the host review')
  assert.deepEqual(told(), [[], []], 'no W3 stall was told before it')
})

test('coverage-complete is told whenever completion is allowed, whatever the stall predicate says: beside an exempt experiment whose worker stop is still settling', async t => {
  // A pin of critique change 6 against 6f87081, which told the board's fact only on a board with no live work; 29a0268 tells it too.
  let release
  const settling = new Promise(resolve => { release = resolve })
  const f = await setup({ clock: new FakeClock(), budget: { maxExperiments: 1 } })
  t.after(async () => { release(); await f.cleanup() })
  const runner = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Runner', role: 'implementation', maxOutputTokens: 5_000 })
  await f.runtime.settle(f.mission.id)
  // The experiment blocked while its worker's stop is still settling: exempt from completion, and live work to the stall predicate.
  const stop = f.workers.stop.bind(f.workers)
  f.workers.stop = async id => { await stop(id); if (id === runner.id) await settling }
  const experiment = f.propose({ title: 'Experiment', kind: 'research', checks: [], experiment: true, assigneeId: runner.id })
  f.runtime.commit(f.mission.id, () => {
    const row = taskOf(f.runtime, experiment.id)
    f.runtime.store.put('tasks', { ...row, status: 'blocked', resumeAfterStop: { epoch: row.epoch, memberId: runner.id, reason: 'handoff', at: f.clock.now() } })
  })
  await acceptThroughReview(f, f.propose())
  // The held stop is the one operation left: every pass and publication since has settled.
  await eventually(() => !stateOf(f.runtime, f.mission.id).passLive, 'the last pass ends')
  await ticks(f, 1)
  await eventually(() => !stateOf(f.runtime, f.mission.id).passLive, 'the tick\'s pass ends')
  const view = interpret(f.runtime.boardOf(f.mission.id))
  assert.deepEqual([completionError(view), view.stalled, taskOf(f.runtime, experiment.id).status], [undefined, false, 'blocked'], 'completion is allowed on a board the stall predicate calls live')
  assert.equal(ownerRows(f).filter(delivery => noticeFamily(delivery) === 'coverage-complete').length, 1, 'coverage-complete is told')
})

test('the board classifier is the one emitter of the board\'s facts: a pass that blocks the mission on its deadline tells the block alone, and the W3 stall its board owes is told once the owner resumes it', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  f.runtime.updateBudget(f.owner, f.mission.id, { ...f.runtime.mission(f.mission.id).budget, deadlineAt: f.clock.now() + 1_000 }, 'A fixed deadline')
  await f.runtime.settle(f.mission.id)
  const prerequisite = f.propose({ title: 'Prerequisite', kind: 'research', checks: [] })
  const dependent = f.propose({ title: 'Dependent', kind: 'research', checks: [], dependencies: [prerequisite.id] })
  // The deadline passes and the owner's cancellation strands the dependent: the queued pass starts on the stalled board and blocks the mission.
  f.clock.advance(1_000)
  f.runtime.cancel(f.owner, f.mission.id, { taskId: prerequisite.id, reason: 'Not needed' })
  await f.runtime.settle(f.mission.id)
  assert.equal(f.runtime.mission(f.mission.id).status, 'blocked', 'the pass blocked the mission on its deadline')
  assert.deepEqual([ownerRows(f).map(delivery => noticeFamily(delivery)), boardStallEvents(f)], [['guard-terminal'], []], 'the owner is told the block alone')
  f.runtime.updateBudget(f.owner, f.mission.id, { ...f.runtime.mission(f.mission.id).budget, deadlineAt: f.clock.now() + 3_600_000 }, 'More time')
  await f.runtime.settle(f.mission.id)
  await ticks(f, 2)
  assert.equal(f.runtime.mission(f.mission.id).status, 'active', 'the owner resumed the mission')
  const stalls = ownerRows(f).filter(delivery => noticeFamily(delivery) === 'board-stall')
  assert.deepEqual([stalls.map(delivery => delivery.subjects), boardStallEvents(f).length], [[[`${dependent.id}@${taskOf(f.runtime, dependent.id).epoch}`]], 1], 'then the board classifier tells the stall, once')
})

test('an unreviewable submission is named by the review admission\'s decision, and the W3 stall of a board with nothing else to do is told beside it, once: one more wording of the open item R20, with or without a review of it no live member can take, when the task budget admits no review, and when the host\'s review is refused', async t => {
  const blockers = { false: /no live member other than the author/, true: /no live member other than the author/, budget: /the mission task budget is exhausted \(1\/1 admitted tasks\)/,
    refused: /automatic review admission failed: .* The refusal: \[check_requires_host\] / }
  for (const review of [false, true, 'budget', 'refused']) {
    // The budget board keeps its independent member but has no task slot left for the host's review. The refused one keeps
    // both, and the source's check now resolves to a nested sandbox, so the host's review that copies it is refused.
    const f = await setup({ clock: new FakeClock(), budget: review === 'budget' ? { maxTasks: 1 } : {} })
    t.after(f.cleanup)
    const task = f.propose(review === 'refused' ? { checks: ['npm run verify'] } : {})
    if (review === 'refused') await writeFile(join(f.dir, 'package.json'), JSON.stringify({ scripts: { verify: 'sandbox-exec -f verify.sb node verify.js' } }))
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    // The only independent member was to review it; once it is gone, that review is dead too.
    const dead = review === true ? f.propose({ title: 'Review', kind: 'verification', reviewOf: task.id, checks: [], assigneeId: f.reviewer.id }) : task
    if (typeof review === 'boolean') f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
    await f.runtime.settle(f.mission.id)
    await ticks(f, 150)
    const decisions = ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`review-blocked:${f.mission.id}:${task.id}:`))
    assert.equal(decisions.length, 1, `review=${review}: the admission named the blocker once`)
    assert.match(decisions[0].content, blockers[review])
    const stalls = ownerRows(f).filter(delivery => noticeFamily(delivery) === 'board-stall')
    assert.deepEqual([stalls.map(delivery => delivery.subjects), boardStallEvents(f).length], [[[subjectOf(f, dead)]], 1], `review=${review}: the W3 stall names the board's stuck work beside it, once, with its one event`)
    assert.deepEqual([relevant(f, decisions[0]), relevant(f, stalls[0])], [true, true], 'and both are outstanding')
  }
})

test('beside running work, an unreviewable source past its grace is stuck work: the fall-through names it, outstanding, beside the admission\'s BOARD_RUNNING decision, whose blocker is the running board', async t => {
  // The other half of the pin above: beside live work the admission's own rule names the running board, never a stall it imagines.
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const running = f.propose({ title: 'Running work', kind: 'research', checks: [], assigneeId: f.reviewer.id })
  await f.runtime.claim(f.actor(f.reviewer), f.mission.id, running.id)
  const source = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 150)
  assert.deepEqual([taskOf(f.runtime, running.id).status, reviewNeed(f.runtime.boardOf(f.mission.id), taskOf(f.runtime, source.id)).ripe], ['running', true], 'the other work still runs under its lease, and the source is past its grace')
  const naming = ownerRows(f).filter(delivery => (delivery.subjects ?? []).includes(subjectOf(f, source)) && delivery.notice.trigger !== 'owner-decision-unresolved')
  assert.deepEqual(naming.map(delivery => noticeFamily(delivery)).sort(), ['fallthrough', 'review-blocked'], 'the source is named by the fall-through beside the admission\'s decision')
  const [decision, fallthrough] = ['review-blocked', 'fallthrough'].map(family => naming.find(delivery => noticeFamily(delivery) === family))
  assert.equal(decision.notice.reason, BOARD_RUNNING, 'whose blocker is the running board')
  assert.deepEqual([fallthrough.subjects, relevant(f, fallthrough), relevant(f, decision)], [[subjectOf(f, source)], true, true], 'the fall-through names the source alone, and both are outstanding')
})

test('a board whose only unfinished work is a submission and its dead host review is the admission\'s to name: it is told once, by that decision, even when no guard terminal was', async t => {
  // A worker stop the test holds open, so the owner can pause the mission while the review's last lease expiry is settling.
  let held
  const workers = new FakeWorkers()
  const stop = workers.stop.bind(workers)
  workers.stop = async id => { await stop(id); if (held !== undefined) { held.entered(); await held.released } }
  const f = await setup({ clock: new FakeClock(), workers })
  t.after(f.cleanup)
  const source = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 150)
  const review = f.runtime.store.list('tasks', f.mission.id).find(row => row.reviewOf === source.id)
  assert.match(review?.id ?? 'none', /^task_auto_review_/, 'the host admitted its review')
  const row = () => taskOf(f.runtime, review.id)
  const expire = async () => {
    await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    f.clock.advance(f.runtime.config.leaseMs + f.runtime.config.tickMs)
  }
  // Every lease but the last runs out and the review re-pends.
  while ((row().recoveryCount ?? 0) < row().maxRecoveryAttempts - 1) {
    await expire()
    await ticks(f, 5)
    await f.runtime.settle(f.mission.id)
    assert.equal(row().status, 'pending', 'an expiry inside the recovery limit re-pends the review')
  }
  // The last expiry's stop is still settling when the owner pauses the mission, so the recovery limit raises no guard terminal.
  await expire()
  let release
  const entered = new Promise(resolve => { held = { entered: resolve, released: new Promise(open => { release = open }) } })
  f.runtime.runTick()
  await entered
  f.runtime.control(f.owner, f.mission.id, 'pause', 'Hold on')
  held = undefined
  release()
  await f.runtime.settle(f.mission.id)
  assert.deepEqual([row().status, row().recoveryCount, row().resumeAfterStop], ['blocked', row().maxRecoveryAttempts, undefined], 'the review is blocked at its recovery limit')
  const before = ownerRows(f).map(delivery => delivery.id)
  f.runtime.control(f.owner, f.mission.id, 'resume', 'Carry on')
  await f.runtime.settle(f.mission.id)
  await ticks(f, 150)
  assert.equal(interpret(f.runtime.boardOf(f.mission.id)).stalled, true, 'the board is stalled on the submission and its dead review')
  const told = ownerRows(f).filter(delivery => !before.includes(delivery.id))
  assert.deepEqual(told.map(delivery => noticeFamily(delivery)).sort(), ['board-stall', 'review-blocked'], 'the owner is told by the admission, and by the W3 stall of that board beside it: one more wording of the open item R20')
  const [decision] = told.filter(delivery => noticeFamily(delivery) === 'review-blocked')
  assert.deepEqual(decision.subjects, [`${source.id}@${taskOf(f.runtime, source.id).epoch}`])
  assert.match(decision.content, new RegExp(`the automatically admitted review ${review.id} is blocked and cannot reach a verdict: admit a review with swarm_propose\\(.*\\), or withdraw the source with swarm_cancel\\(taskId, reason\\)$`))
  assert.equal(relevant(f, decision), true, 'and the decision is outstanding')
  assert.deepEqual([told.find(delivery => noticeFamily(delivery) === 'board-stall').subjects, boardStallEvents(f).length], [[subjectOf(f, review)], 1], 'the W3 stall names the dead review, once')
})

test('a dependent a cancellation strands beside an unreviewable submission is named while that submission stays unreviewable: by the W3 stall on a board with no live work and by the fall-through beside running work, each beside the admission\'s decision (the D1 probe)', async t => {
  for (const running of [false, true]) {
    const f = await setup({ clock: new FakeClock(), budget: LONG })
    t.after(f.cleanup)
    // The withdrawn prerequisite leaves its dependent dead; an unrelated deliverable is submitted and its only independent member stopped.
    const prerequisite = f.propose({ title: 'Prerequisite', kind: 'research', checks: [] })
    const dead = f.propose({ title: 'Dependent', kind: 'research', checks: [], dependencies: [prerequisite.id] })
    const source = f.propose()
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    if (running) await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ title: 'Unrelated work', kind: 'research', checks: [] }).id)
    f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
    f.runtime.cancel(f.owner, f.mission.id, { taskId: prerequisite.id, reason: 'Not needed' })
    await f.runtime.settle(f.mission.id)
    await ticks(f, 150)
    const [decision, ...more] = ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`review-blocked:${f.mission.id}:${source.id}:`))
    assert.deepEqual([more, taskOf(f.runtime, source.id).status, relevant(f, decision)], [[], 'submitted', true], `running=${running}: the source is still unreviewable and its admission's decision is outstanding`)
    const namings = ownerRows(f).filter(delivery => (delivery.subjects ?? []).includes(subjectOf(f, dead)) && delivery.notice.trigger !== 'owner-decision-unresolved')
    assert.deepEqual([...new Set(namings.map(delivery => noticeFamily(delivery)))], [running ? 'fallthrough' : 'board-stall'], `running=${running}: the board's own naming names the stranded dependent at its epoch`)
    assert.equal(namings.some(delivery => relevant(f, delivery)), true, `running=${running}: and that naming is outstanding`)
  }
})

test('D1: an unreviewable source, its review pending for a stopped reviewer and a dead dependent: the W3 stall names the dead work while the source is unreviewable, each withdrawal that moves its identity tells it again (R20) with only the newest outstanding, and the one that follows the source states one unfiltered set', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const source = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  // The only independent member was to review it; once it is gone the source is unreviewable and that review is unschedulable.
  const review = f.propose({ title: 'Review', kind: 'verification', reviewOf: source.id, checks: [], assigneeId: f.reviewer.id })
  const withdrawn = f.propose({ title: 'Prerequisite', kind: 'research', checks: [] })
  const dead = f.propose({ title: 'Dependent', kind: 'research', checks: [], dependencies: [withdrawn.id] })
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
  f.runtime.cancel(f.owner, f.mission.id, { taskId: withdrawn.id, reason: 'Not needed' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 150)
  const stalls = () => ownerRows(f).filter(delivery => delivery.content.startsWith('Mission stalled'))
  const outstanding = () => stalls().filter(delivery => relevant(f, delivery))
  assert.equal(ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`review-blocked:${f.mission.id}:${source.id}:`)).length, 1, 'the admission named the source')
  const first = [subjectOf(f, review), subjectOf(f, dead)]
  assert.deepEqual(stalls().map(delivery => delivery.subjects), [first], 'while the source is unreviewable the W3 stall names the dead work beside its decision')
  // The owner withdraws only the review: the source is still unreviewable, and the W3 stall's identity moves.
  f.runtime.cancel(f.owner, f.mission.id, { taskId: review.id, reason: 'Not this review' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 150)
  assert.deepEqual(stalls().map(delivery => delivery.subjects), [first, [subjectOf(f, dead)]], 'the moved identity is told again: a second W3 after a withdrawn review, one wording of the open item R20')
  assert.deepEqual(outstanding(), stalls().slice(-1), 'only the newest is outstanding')
  // The owner withdraws the source too: the W3 stall names what remains, as one set.
  f.runtime.cancel(f.owner, f.mission.id, { taskId: source.id, reason: 'Not needed' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 2)
  const view = interpret(f.runtime.boardOf(f.mission.id))
  const reason = completionError(view)
  const subjects = [subjectOf(f, dead)]
  assert.deepEqual(view.unschedulable.map(task => task.id), [dead.id], 'the dispatcher counts the dead dependent alone')
  const [stall, ...others] = outstanding()
  assert.deepEqual([others, stall.id], [[], stalls().at(-1).id], 'one outstanding stall, the newest')
  assert.equal(stall.content, NOTICE_TEMPLATES['board-stall'].build({ reason, unschedulable: view.unschedulable, subjects }), 'its whole body is the template of that one set')
  assert.equal(stall.notice.dedupKey, factKey(f.mission.id, { trigger: 'mission/stalled', reason, subjects, statement: { family: 'board-stall' } }), 'and so is its key')
  assert.deepEqual(stall.notice.statement, { family: 'board-stall', counts: { unschedulable: 1 } })
  assert.deepEqual(boardStallEvents(f).map(event => event.data.noticeKey), stalls().map(delivery => delivery.notice.dedupKey), 'each W3 row has its one event')
  assert.deepEqual(boardStallEvents(f).at(-1).data.unschedulable, [dead.id], 'and the last records that set')
})

/**
 * Work only the reviewer may take and the author's submission, with the
 * reviewer then gone: dead work beside a review need inside its grace.
 * `legacy` leaves the submission as an older build did (no artifact, so the
 * review admission skips it); `running` adds unrelated live work.
 */
const graceBoard = async (t, { legacy = false, running = false } = {}) => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const dead = f.propose({ title: 'Reviewer-only work', kind: 'research', checks: [], assigneeId: f.reviewer.id })
  const source = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  if (legacy) f.runtime.store.transaction(() => { const row = taskOf(f.runtime, source.id); delete row.artifact; f.runtime.store.put('tasks', row) })
  if (running) await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ title: 'Unrelated work', kind: 'research', checks: [] }).id)
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
  await f.runtime.settle(f.mission.id)
  /** The families of the decisions naming a task at its epoch, reminders aside. */
  const naming = task => ownerRows(f).filter(delivery => (delivery.subjects ?? []).includes(`${task.id}@${taskOf(f.runtime, task.id).epoch}`) && delivery.notice.trigger !== 'owner-decision-unresolved')
  await ticks(f, 1)
  assert.equal(reviewNeed(f.runtime.boardOf(f.mission.id), taskOf(f.runtime, source.id)).ripe, false, 'the need is inside its grace')
  return { f, dead, source, naming, families: task => naming(task).map(delivery => noticeFamily(delivery)) }
}

test('a board with no live work is the stall\'s to name: inside a review grace it is a stall candidate the fall-through leaves alone, and once the admission names the source\'s blocker the W3 stall names the dead work beside that decision and is reminded as one obligation', async t => {
  const { f, dead, source, naming, families } = await graceBoard(t)
  assert.deepEqual([families(dead), families(source)], [[], []], 'nothing is told inside the grace')
  await ticks(f, 150)
  assert.deepEqual([families(dead), families(source)], [['board-stall'], ['review-blocked']], 'past the grace the admission names the source and the W3 stall names the dead work beside it')
  await f.runtime.notices.flushOutbox(f.mission.id)
  for (let interval = 0; interval < 4; interval += 1) { f.clock.advance(f.runtime.notices.obligationFollowupMs); f.runtime.notices.absenceNet(f.mission.id); await f.runtime.notices.flushOutbox(f.mission.id) }
  assert.deepEqual(naming(dead).filter(delivery => relevant(f, delivery)).map(delivery => noticeFamily(delivery)), ['board-stall'], 'one outstanding decision names it')
  const reminded = ownerRows(f).filter(delivery => delivery.notice.trigger === 'owner-decision-unresolved' && (delivery.subjects ?? []).some(subject => subject.startsWith(`${dead.id}@`)))
  assert.equal(reminded.length, f.runtime.notices.maxObligationFollowups, 'and it is reminded as one obligation')
})

test('a legacy source beside dead work and running work is ordinary stuck work: the fall-through names it when its grace ends, with no change to the board, and never before', async t => {
  const { f, dead, source, naming, families } = await graceBoard(t, { legacy: true, running: true })
  assert.deepEqual([families(dead), families(source)], [['fallthrough'], []], 'inside the grace the dead work behind the running work is named, the source is not')
  const grace = Math.max(f.runtime.config.tickMs, 1_000)
  const opened = events(f.runtime, f.mission.id, 'task/submitted').find(event => event.data.taskId === source.id).createdAt
  const fingerprint = f.runtime.fingerprint(f.mission.id)
  f.clock.advance(opened + grace - f.clock.now())
  await ticks(f, 1)
  assert.equal(f.runtime.fingerprint(f.mission.id), fingerprint, 'the grace ended with no change to the board')
  assert.deepEqual(families(source), ['fallthrough'], 'the legacy source is named by the first tick past its grace: the dead work\'s notice did not stand for it')
  assert.equal(naming(source)[0].createdAt, opened + grace + f.runtime.config.tickMs)
  assert.deepEqual(naming(source)[0].subjects.sort(), [dead, source].map(task => `${task.id}@${taskOf(f.runtime, task.id).epoch}`).sort(), 'the fall-through names everything no live path advances')
  await ticks(f, 150)
  assert.deepEqual(families(source), ['fallthrough'], 'and it is named once')
  assert.deepEqual(events(f.runtime, f.mission.id, 'task/review-blocked'), [], 'no review-path decision names it')
})

test('a review-blocked decision an older build wrote for a submission without an artifact is not the admission\'s: queued it is withheld, delivered it is never reminded, and the board\'s own namer names the source, beside running work and on a board with nothing else to do', async t => {
  for (const running of [true, false]) {
    const f = await setup({ clock: new FakeClock() })
    t.after(f.cleanup)
    const source = f.propose()
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    // The row as an older build left it: a submission without an artifact, beside unrelated work the reviewer runs.
    f.runtime.store.transaction(() => { const row = taskOf(f.runtime, source.id); delete row.artifact; f.runtime.store.put('tasks', row) })
    const unrelated = f.propose({ title: 'Unrelated work', kind: 'research', checks: [], assigneeId: f.reviewer.id })
    await f.runtime.claim(f.actor(f.reviewer), f.mission.id, unrelated.id)
    await f.runtime.settle(f.mission.id)
    // The decision 29a0268 wrote for this source past its grace, through the same emitter, with its event: the running board's cause.
    const row = taskOf(f.runtime, source.id)
    f.runtime.notices.record(f.mission.id, reviewBlocked(f.runtime.boardOf(f.mission.id), row, reviewNeed(f.runtime.boardOf(f.mission.id), row).id, BOARD_RUNNING))
    const [legacy] = ownerRows(f).filter(delivery => noticeFamily(delivery) === 'review-blocked')
    assert.equal(legacy.notice.dedupKey, `review-blocked:${f.mission.id}:${source.id}:${reviewNeed(f.runtime.boardOf(f.mission.id), row).id}:${BOARD_RUNNING}`, `running=${running}: the older build's key`)
    // After the upgrade the running work goes on, or the owner withdraws it and the board has nothing else to do.
    if (!running) { f.runtime.cancel(f.owner, f.mission.id, { taskId: unrelated.id, reason: 'Not needed' }); await f.runtime.settle(f.mission.id) }
    await ticks(f, Math.ceil(Math.max(f.runtime.config.tickMs, 1_000) / f.runtime.config.tickMs) + 1)
    const subject = `${source.id}@${row.epoch}`
    const naming = ownerRows(f).filter(delivery => (delivery.subjects ?? []).includes(subject) && delivery.notice.trigger !== 'owner-decision-unresolved' && relevant(f, delivery))
    assert.deepEqual(naming.map(delivery => noticeFamily(delivery)), [running ? 'fallthrough' : 'board-stall'], `running=${running}: one outstanding decision names the source, the board's own`)
    assert.equal(relevant(f, legacy), false, `running=${running}: the older decision is withheld`)
    // As the older build left it: delivered before the upgrade.
    f.runtime.commit(f.mission.id, () => f.runtime.store.put('deliveries', { ...f.runtime.store.get('deliveries', legacy.id), deliveredAt: f.clock.now() }))
    await f.runtime.notices.flushOutbox(f.mission.id)
    for (let interval = 0; interval < 3; interval += 1) { f.clock.advance(f.runtime.notices.obligationFollowupMs); f.runtime.notices.absenceNet(f.mission.id); await f.runtime.notices.flushOutbox(f.mission.id) }
    assert.deepEqual(ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`obligation-followup:${legacy.id}:`)), [], `running=${running}: and it is never reminded`)
  }
})

test('a queued W3 stall is withheld once its board can progress, and coverage-complete reminds the owner while the board stays coverage-complete', async t => {
  const stalled = await setup({ clock: new FakeClock() })
  t.after(stalled.cleanup)
  await blockThroughReview(stalled, stalled.propose({ title: 'Dead end' }))
  await stalled.runtime.settle(stalled.mission.id)
  await ticks(stalled, 1)
  const stall = stallRow(stalled)
  assert.ok(stall, 'the stalled board told the owner')
  assert.equal(relevant(stalled, stall), true, 'outstanding while the board stays stalled')
  await stalled.runtime.notices.flushOutbox(stalled.mission.id)
  const stallReminder = ordinal => ownerRows(stalled).find(delivery => delivery.notice.dedupKey === `obligation-followup:${stall.id}:${ordinal}`)
  stalled.clock.advance(stalled.runtime.notices.obligationFollowupMs)
  stalled.runtime.notices.absenceNet(stalled.mission.id)
  assert.ok(stallReminder(1), 'the delivered stall is reminded while the board stays stalled')
  stalled.propose({ title: 'Ready work' })
  assert.equal(relevant(stalled, stall), false, 'ready work ends the stall, so the queued decision is withheld')
  stalled.clock.advance(stalled.runtime.notices.obligationFollowupMs)
  stalled.runtime.notices.absenceNet(stalled.mission.id)
  assert.equal(stallReminder(2), undefined, 'and its reminders end with it')

  const { f, task } = await coverageBoard(t)
  const coverage = coverageRow(f)
  assert.ok(coverage, 'the coverage-complete board told the owner')
  await f.runtime.notices.flushOutbox(f.mission.id)
  assert.ok(f.runtime.store.get('deliveries', coverage.id).deliveredAt !== undefined, 'the decision reached the owner')
  f.clock.advance(f.runtime.notices.obligationFollowupMs)
  f.runtime.notices.absenceNet(f.mission.id)
  const reminder = ownerRows(f).find(delivery => delivery.notice.dedupKey === `obligation-followup:${coverage.id}:1`)
  assert.ok(reminder, 'the unresolved completion decision is reminded')
  assert.deepEqual(reminder.subjects, coverage.subjects, 'the reminder names the terminal work the decision named')
  assert.ok(reminder.subjects.includes(`${task.id}@${taskOf(f.runtime, task.id).epoch}`), 'among it the accepted deliverable')
  // The owner admits more work through the registered tool: the board is no longer coverage-complete.
  const tool = await ownerTools(f)
  await tool('swarm_propose', { workstreamId: f.stream.id, title: 'More work', objective: 'Extend the mission', kind: 'research', scope: ['**'], outputs: [], acceptance: MISSION_ACCEPTANCE, checks: [] })
  f.clock.advance(f.runtime.notices.obligationFollowupMs)
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(ownerRows(f).find(delivery => delivery.notice.dedupKey === `obligation-followup:${coverage.id}:2`), undefined, 'its reminders stop once the board is no longer coverage-complete')
})

test('a mission blocked on its budget keeps its board decision: a told W3 stall stays outstanding and is reminded, a told coverage-complete stays outstanding, and no new one is told', async t => {
  /** The owner's fixed deadline passes: the budget guard blocks the mission at the next tick. */
  const block = async f => {
    f.runtime.updateBudget(f.owner, f.mission.id, { ...f.runtime.mission(f.mission.id).budget, deadlineAt: f.clock.now() + 60_000 }, 'A fixed deadline')
    f.clock.advance(60_000)
    await f.runtime.tick()
    await f.runtime.settle(f.mission.id)
    assert.equal(f.runtime.mission(f.mission.id).status, 'blocked', 'the exhausted duration blocked the mission')
  }
  const stalled = await setup({ clock: new FakeClock() })
  t.after(stalled.cleanup)
  await blockThroughReview(stalled, stalled.propose({ title: 'Dead end' }))
  await stalled.runtime.settle(stalled.mission.id)
  await ticks(stalled, 1)
  const stall = stallRow(stalled)
  assert.ok(stall, 'the stalled board told the owner')
  await stalled.runtime.notices.flushOutbox(stalled.mission.id)
  await block(stalled)
  assert.equal(relevant(stalled, stall), true, 'the blocked mission keeps the stall outstanding')
  const reminders = () => ownerRows(stalled).filter(delivery => delivery.notice.dedupKey.startsWith(`obligation-followup:${stall.id}:`)).length
  const before = reminders()
  stalled.clock.advance(stalled.runtime.notices.obligationFollowupMs)
  stalled.runtime.notices.absenceNet(stalled.mission.id)
  assert.equal(reminders(), before + 1, 'and reminds the owner of it')
  // Work withdrawn while the mission is blocked changes the stall's identity: a blocked mission is told no new board fact.
  const told = () => ownerRows(stalled).filter(delivery => noticeFamily(delivery) === 'board-stall').length
  const extra = stalled.runtime.store.list('tasks', stalled.mission.id).find(task => task.kind === 'verification')
  stalled.runtime.cancel(stalled.owner, stalled.mission.id, { taskId: extra.id, reason: 'Not needed' })
  await stalled.runtime.settle(stalled.mission.id)
  await ticks(stalled, 3)
  assert.deepEqual([relevant(stalled, stall), told()], [false, 1], 'the stall under its new identity is not told while the mission is blocked')

  const { f: covered } = await coverageBoard(t)
  const coverage = coverageRow(covered)
  assert.ok(coverage, 'the coverage-complete board told the owner')
  await block(covered)
  assert.equal(relevant(covered, coverage), true, 'the blocked mission keeps coverage-complete outstanding')
})

test('a wedged pass never pre-empts the review admission: a need that ripened since the last pass is left to it, and it admits the host review with no owner decision', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
  await f.runtime.settle(f.mission.id)
  // The need ripens with no pass since; a wedged publication judges the board first.
  f.clock.advance(Math.max(f.runtime.config.tickMs, 1_000))
  f.runtime.notices.ensureWitness(f.mission.id, { wedged: true })
  await ticks(f, 1)
  assert.match(f.runtime.store.list('tasks', f.mission.id).find(row => row.reviewOf === task.id)?.id ?? 'none', /^task_auto_review_/, 'the admission admitted the host review')
  assert.deepEqual(ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith('review-blocked:')).map(delivery => delivery.content), [], 'no owner decision raced it')
})

/** A scheduling body past its bound on the current board, as the tick watchdog finds and names it. */
const wedgedBody = (t, f, operationId) => {
  const scheduling = f.runtime.scheduling
  const pass = { id: scheduling.passKey(f.mission.id), operationId, missionId: f.mission.id, startedAt: f.clock.now() - 60_000,
    revisionBefore: f.runtime.store.revision(), fingerprintBefore: f.runtime.fingerprint(f.mission.id) }
  scheduling.passes.set(f.mission.id, pass)
  t.after(() => scheduling.closePass(f.mission.id, pass))
  scheduling.checkSchedulingPasses()
  return pass
}
const wedgeRows = f => ownerRows(f).filter(delivery => delivery.notice.trigger === 'scheduling-pass')
const wedgeEvents = f => events(f.runtime, f.mission.id, 'mission/stalled').filter(event => event.data.cause === 'scheduling-pass')

test('a wedged pass is named once per naming fact, on the ledger alone: a body on a held fact writes nothing, and a newly counted start failure names the next body on an unchanged board', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  f.propose({ title: 'Never reached' })
  await f.runtime.settle(f.mission.id)
  const scheduling = f.runtime.scheduling
  const board = f.runtime.fingerprint(f.mission.id)
  const first = wedgedBody(t, f, 'operation_wedge_1')
  assert.deepEqual(wedgeEvents(f).map(event => [event.data.runId, event.data.noticeKey]), [['operation_wedge_1', wedgeRows(f)[0]?.notice.dedupKey]], 'the first body is named: one row, and the one event that names it')
  scheduling.closePass(f.mission.id, first)
  // A second body wedges on the same fact: the owner already holds it.
  const second = wedgedBody(t, f, 'operation_wedge_2')
  assert.ok(second.escalatedAt !== undefined, 'the body is marked named, so the mission publishes as wedged')
  assert.deepEqual([wedgeRows(f).length, wedgeEvents(f).length], [1, 1], 'and it writes neither a row nor an event')
  scheduling.closePass(f.mission.id, second)
  // A start failure is counted for a member: a new naming fact on the same board digest.
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.author.id), startFailures: 1 }))
  assert.equal(f.runtime.fingerprint(f.mission.id), board, 'the board digest cannot see the counted failure')
  wedgedBody(t, f, 'operation_wedge_3')
  assert.deepEqual(wedgeEvents(f).map(event => [event.data.runId, event.data.noticeKey]),
    [['operation_wedge_1', wedgeRows(f)[0].notice.dedupKey], ['operation_wedge_3', wedgeRows(f)[1]?.notice.dedupKey]], 'the next body is named for the new fact, by its own row and event')
  assert.match(wedgeRows(f)[1].notice.reason, new RegExp(`^pass-timeout .*${f.author.id}:1`), 'whose recorded reason carries the counted failure')
  assert.equal(Object.hasOwn(f.runtime.store.get('missions', f.mission.id), 'schedulingWedgeNotice'), false, 'nothing on the mission row records a naming')
})

test('M-1: a notice is its ledger row and nothing else: the same fact on another board digest is no second row and nothing on the mission row records it, and a notice committed with the board change that owes another family\'s fact does not stand for that fact', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const unrelated = () => f.runtime.notices.notify(f.mission.id, 'An unrelated owner decision', [`mission:${f.mission.id}`], { trigger: 'test/unrelated', reason: 'one fact' })
  f.runtime.commit(f.mission.id, unrelated)
  const board = f.runtime.fingerprint(f.mission.id)
  f.propose({ title: 'A board change', kind: 'research', checks: [], assigneeId: f.reviewer.id })
  await f.runtime.settle(f.mission.id)
  assert.notEqual(f.runtime.fingerprint(f.mission.id), board, 'the board digest moved')
  f.runtime.commit(f.mission.id, unrelated)
  assert.equal(ownerRows(f).filter(delivery => delivery.notice.trigger === 'test/unrelated').length, 1, 'the same fact is one row, whatever the board digest is')
  assert.equal(Object.hasOwn(f.runtime.store.get('missions', f.mission.id), 'witness'), false, 'nothing on the mission row records a notice')

  // Beside running work, the board change that leaves work dead is committed with an unrelated notice.
  const dead = await setup({ clock: new FakeClock() })
  t.after(dead.cleanup)
  await dead.runtime.claim(dead.actor(dead.author), dead.mission.id, dead.propose({ title: 'Running work', kind: 'research', checks: [] }).id)
  const stranded = dead.propose({ title: 'Reviewer-only work', kind: 'research', checks: [], assigneeId: dead.reviewer.id })
  await dead.runtime.settle(dead.mission.id)
  dead.runtime.commit(dead.mission.id, () => {
    dead.runtime.store.put('members', { ...dead.runtime.store.get('members', dead.reviewer.id), phase: 'stopped' })
    dead.runtime.notices.notify(dead.mission.id, 'An unrelated owner decision', [`mission:${dead.mission.id}`], { trigger: 'test/unrelated', reason: 'co-committed' })
  })
  await dead.runtime.settle(dead.mission.id)
  await ticks(dead, 3)
  assert.deepEqual(ownerRows(dead).filter(delivery => noticeFamily(delivery) === 'fallthrough').map(delivery => delivery.subjects), [[`${stranded.id}@${taskOf(dead.runtime, stranded.id).epoch}`]], 'the fall-through names the dead work')

  // A ready task pinned to a busy handle is admitted, and an unrelated notice is committed before any judgement.
  const pinned = await setup({ clock: new FakeClock() })
  t.after(pinned.cleanup)
  pinned.workers.idle.add(pinned.reviewer.id)
  const task = pinned.propose({ title: 'Pinned to a busy handle' })
  pinned.runtime.commit(pinned.mission.id, () => pinned.runtime.notices.notify(pinned.mission.id, 'An unrelated owner decision', [`mission:${pinned.mission.id}`], { trigger: 'test/unrelated', reason: 'co-committed' }))
  await pinned.runtime.settle(pinned.mission.id)
  await ticks(pinned, 3)
  assert.equal(taskOf(pinned.runtime, task.id).status, 'pending', 'the task was not dispatched')
  assert.deepEqual(ownerRows(pinned).filter(delivery => noticeFamily(delivery) === 'dispatch-question').map(delivery => delivery.subjects), [[`${task.id}@${taskOf(pinned.runtime, task.id).epoch}`]], 'the dispatch question is asked')
})

test('a member whose starts are failing does not stand in for the dispatch question: the work it cannot start is asked about once beside its start failure, whatever the board digest, and runs once it starts', async t => {
  const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }) })
  t.after(f.cleanup)
  let failing = true
  const start = f.workers.start.bind(f.workers)
  f.workers.start = async spec => { if (failing && spec.member.id === f.author.id) throw Object.assign(new Error('worker start failed'), { code: 'EMFILE' }); return start(spec) }
  const task = f.propose({ title: 'Work for the author' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 1)
  await f.runtime.settle(f.mission.id)
  const subject = `${task.id}@${taskOf(f.runtime, task.id).epoch}`
  const questions = () => ownerRows(f).filter(delivery => noticeFamily(delivery) === 'dispatch-question').map(delivery => delivery.subjects)
  const failure = ownerRows(f).find(delivery => /^Author could not start \(failure 1 of 3\)/.test(delivery.content))
  assert.deepEqual(failure?.subjects, [subject], 'the start failure is told, naming the work it re-pended')
  assert.equal(taskOf(f.runtime, task.id).status, 'pending')
  // A durable member field is no record that the owner was told: the question is asked on its own condition, a second
  // wording of the start failure's (the open item R20).
  assert.deepEqual(questions(), [[subject]], 'the dispatch question about the work is asked beside the start failure')
  // The board digest moves while the author's start is still failing.
  const board = f.runtime.fingerprint(f.mission.id)
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
  await Promise.resolve()
  assert.notEqual(f.runtime.fingerprint(f.mission.id), board)
  assert.deepEqual(questions(), [[subject]], 'once, at the task\'s epoch')
  // The route recovers: its next start succeeds and the work runs.
  failing = false
  await ticks(f, 2)
  await f.runtime.settle(f.mission.id)
  assert.equal(taskOf(f.runtime, task.id).status, 'running', 'the work runs once the author starts')
  assert.deepEqual(questions(), [[subject]], 'and the question is not asked again')
})

test('a start failure over unassigned work names the mission root, and the work its member cannot start is asked about, once, beside it', async t => {
  const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }) })
  t.after(f.cleanup)
  const start = f.workers.start.bind(f.workers)
  f.workers.start = async spec => { if (spec.member.id === f.author.id) throw Object.assign(new Error('worker start failed'), { code: 'EMFILE' }); return start(spec) }
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
  const task = f.propose({ title: 'Unassigned work', assigneeId: undefined })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 1)
  await f.runtime.settle(f.mission.id)
  const failure = ownerRows(f).find(delivery => /^Author could not start \(failure 1 of 3\)/.test(delivery.content))
  assert.deepEqual([failure?.subjects, taskOf(f.runtime, task.id).assigneeId], [[`mission:${f.mission.id}`], undefined], 'the start failure is told, naming the mission root: the work is assigned to no member')
  assert.notEqual(f.runtime.store.get('members', f.author.id).phase, 'stopped', 'the author is not retired')
  assert.deepEqual(ownerRows(f).filter(delivery => noticeFamily(delivery) === 'dispatch-question').map(delivery => delivery.subjects), [[`${task.id}@${taskOf(f.runtime, task.id).epoch}`]], 'the dispatch question about the work is asked, once')
})

test('P3: a start that adopts the member\'s running session ends its counted start failures, so the next failure counts from one; with the handle still busy, the dispatch question names the holder, once', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  // Only the reviewer's handle is idle. The author's first start fails; the next finds its session running and adopts it (the adapter resolves true), mid-turn.
  f.workers.idle.add(f.reviewer.id)
  const start = f.workers.start.bind(f.workers)
  let failures = 1
  f.workers.start = async spec => {
    if (spec.member.id !== f.author.id) return start(spec)
    if (failures-- > 0) throw Object.assign(new Error('worker start failed'), { code: 'EMFILE' })
    await start(spec)
    return true
  }
  const task = f.propose({ title: 'Bound to the author' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 1)
  await f.runtime.settle(f.mission.id)
  const subject = `${task.id}@${taskOf(f.runtime, task.id).epoch}`
  assert.ok(ownerRows(f).some(delivery => delivery.content.startsWith('Author could not start (failure 1 of 3)') && delivery.subjects.includes(subject)), 'the start failure names the work bound to the author')
  await ticks(f, 6)
  await f.runtime.settle(f.mission.id)
  assert.deepEqual([taskOf(f.runtime, task.id).status, subjectOf(f, task), f.runtime.store.get('members', f.author.id).startFailures], ['pending', subject, undefined], 'the adoption cleared the counted failures; the work waits at the epoch the failure named')
  assert.deepEqual(ownerRows(f).filter(delivery => noticeFamily(delivery) === 'dispatch-question').map(delivery => delivery.subjects), [[subject]], 'the dispatch question names it, once')
  // The author's next start fails once more: the adoption ended the run, its in-process mirror included, so the count starts again.
  failures = 1
  await ticks(f, 1)
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(events(f.runtime, f.mission.id, 'member/resume-failed').map(event => event.data.consecutiveFailures), [1, 1], 'the failure after the adoption is the first of a new run')
  assert.deepEqual(ownerRows(f).filter(delivery => delivery.content.startsWith('Author could not start')).map(delivery => delivery.content.match(/failure \d of \d/)[0]), ['failure 1 of 3', 'failure 1 of 3'], 'and is told as one')
})

test('a cancellation that strands a dependent leaves it to the board classifier: one decision names it at its epoch, the fall-through beside running work and the W3 stall on a board with nothing else to do', async t => {
  for (const running of [true, false]) {
    const { f, stuck: dependent, cancelled } = await strandedBoard(t, running)
    assert.deepEqual(cancelled.strandedDependents, [dependent.id], `running=${running}: the cancellation reports the dependent it strands`)
    await ticks(f, 20)
    const subject = `${dependent.id}@${taskOf(f.runtime, dependent.id).epoch}`
    const decisions = ownerRows(f).filter(delivery => (delivery.subjects ?? []).includes(subject) && delivery.notice.trigger !== 'owner-decision-unresolved')
    assert.deepEqual(decisions.map(delivery => noticeFamily(delivery)), [running ? 'fallthrough' : 'board-stall'], `running=${running}: one decision names the stranded dependent, the board's own`)
    assert.equal(relevant(f, decisions[0]), true, `running=${running}: and it is outstanding`)
  }
})

test('the dispatch question is one emitter among the board\'s: a dependent a cancellation strands beside dispatchable work is named by the fall-through, beside ready work whose member\'s handle is busy (GATE-BUSY) and beside isolation-refused work (GATE-ISO), and the dispatchable work is the question\'s alone', async t => {
  const boards = {
    // Every handle is busy (the fixture's workers report none idle), so the T3 rule asks no question about the ready work.
    'GATE-BUSY': async () => {
      const f = await setup({ clock: new FakeClock(), budget: LONG })
      t.after(f.cleanup)
      return { f, ready: f.propose({ title: 'Ready behind a busy handle', kind: 'research', checks: [] }), questions: [] }
    },
    // The reviewer is moved into the author's worktree and given work: the isolation invariant refuses it on every pass.
    'GATE-ISO': async () => {
      const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), budget: LONG })
      t.after(f.cleanup)
      f.runtime.store.transaction(() => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), workspace: f.runtime.store.get('members', f.author.id).workspace }))
      const ready = f.propose({ title: 'Isolation-refused work', assigneeId: f.reviewer.id, kind: 'research', checks: [] })
      return { f, ready, questions: [ready] }
    },
  }
  for (const [board, build] of Object.entries(boards)) await t.test(board, async () => {
    const { f, ready, questions } = await build()
    await quiet(f)
    const prerequisite = f.propose({ title: 'Prerequisite', kind: 'research', checks: [] })
    const dependent = f.propose({ title: 'Dependent', kind: 'research', checks: [], dependencies: [prerequisite.id] })
    f.runtime.cancel(f.owner, f.mission.id, { taskId: prerequisite.id, reason: 'Not needed' })
    await quiet(f)
    await ticks(f, 10)
    assert.deepEqual([taskOf(f.runtime, ready.id).status, interpret(f.runtime.boardOf(f.mission.id)).dispatchable.map(task => task.id)], ['pending', [ready.id]], `${board}: the ready work is dispatchable and was not dispatched`)
    const namings = task => ownerRows(f).filter(delivery => (delivery.subjects ?? []).includes(subjectOf(f, task)) && delivery.notice.trigger !== 'owner-decision-unresolved' && !delivery.notice.dedupKey.startsWith('guard-terminal:'))
    assert.deepEqual(namings(dependent).map(delivery => noticeFamily(delivery)), ['fallthrough'], `${board}: the fall-through names the stranded dependent, once`)
    assert.deepEqual([namings(dependent)[0].subjects, relevant(f, namings(dependent)[0])], [[subjectOf(f, dependent)], true], `${board}: it names the dependent alone, and is outstanding`)
    assert.deepEqual(namings(ready).map(delivery => noticeFamily(delivery)), questions.map(() => 'dispatch-question'), `${board}: the ready work is named by the dispatch question when its condition holds, and by nothing else`)
  })
})

test('a provider outage\'s notice names the member\'s open work or the mission root, never the pending work it is assigned: the dispatch question about that work is asked, once, on an unchanged board', async t => {
  const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }) })
  t.after(f.cleanup)
  const start = f.workers.start.bind(f.workers)
  f.workers.start = async spec => { if (spec.member.id === f.author.id) throw Object.assign(new Error('429 Too Many Requests: rate limit'), { status: 429 }); return start(spec) }
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
  const task = f.propose({ title: 'Work for the author' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 3)
  await f.runtime.settle(f.mission.id)
  const subject = `${task.id}@${taskOf(f.runtime, task.id).epoch}`
  const outage = ownerRows(f).filter(delivery => /provider rate-limit outage/.test(delivery.content))
  assert.deepEqual(outage.map(delivery => delivery.subjects), [[`mission:${f.mission.id}`]], 'the outage is told, naming the mission root: the author holds no open work')
  assert.notEqual(f.runtime.store.get('members', f.author.id).providerOutage, undefined, 'the outage is recorded')
  const board = f.runtime.fingerprint(f.mission.id)
  await ticks(f, 3)
  assert.equal(f.runtime.fingerprint(f.mission.id), board, 'the board did not change')
  assert.deepEqual(ownerRows(f).filter(delivery => noticeFamily(delivery) === 'dispatch-question').map(delivery => delivery.subjects), [[subject]], 'the dispatch question about the pending work is asked, once')
})

test('a judgement of a board whose fact the owner holds commits nothing, and a tick judges the board at most twice: the dispatch question, the fall-through, the W3 stall', async t => {
  // A pin of critique change 4: it fails when a branch skips its ledger check. 29a0268 passes it once its W3 stall is read under the family it had there.
  const boards = {
    'dispatch-question': async () => {
      const f = await setup({ clock: new FakeClock() })
      t.after(f.cleanup)
      // Only the reviewer's handle is idle: the author's holds the task pinned to it.
      f.workers.idle.add(f.reviewer.id)
      f.propose({ title: 'Pinned to a busy handle' })
      return f
    },
    fallthrough: async () => {
      const f = await setup({ clock: new FakeClock() })
      t.after(f.cleanup)
      await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ title: 'Running work', kind: 'research', checks: [] }).id)
      // Work only the reviewer may take, dead behind the running work once the reviewer is gone.
      f.propose({ title: 'Reviewer-only work', kind: 'research', checks: [], assigneeId: f.reviewer.id })
      f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
      return f
    },
    'board-stall': async () => (await deadAssigneeBoard(t)).f,
  }
  for (const [family, build] of Object.entries(boards)) {
    const f = await build()
    await f.runtime.settle(f.mission.id)
    await ticks(f, 2)
    await f.runtime.notices.flushOutbox(f.mission.id)
    assert.equal(ownerRows(f).filter(delivery => noticeFamily(delivery) === family).length, 1, `${family}: the board's fact is told`)
    const judged = [], committed = []
    let judging = false
    const ensure = f.runtime.notices.ensureWitness.bind(f.runtime.notices)
    f.runtime.notices.ensureWitness = (missionId, options) => { judged.push(f.clock.now()); judging = true; try { return ensure(missionId, options) } finally { judging = false } }
    const commit = f.runtime.commit.bind(f.runtime)
    f.runtime.commit = (missionId, fn) => { if (judging) committed.push(missionId); return commit(missionId, fn) }
    const board = f.runtime.fingerprint(f.mission.id), rows = ownerRows(f).length
    await ticks(f, 10)
    assert.equal(f.runtime.fingerprint(f.mission.id), board, `${family}: the board did not change`)
    const perTick = [...new Set(judged)].map(at => judged.filter(when => when === at).length)
    assert.ok(perTick.length === 10 && perTick.every(count => count <= 2), `${family}: every tick judges the board, at most twice: ${perTick}`)
    assert.deepEqual([committed.length, ownerRows(f).length], [0, rows], `${family}: a judgement of a board whose fact the owner holds commits nothing and tells nothing`)
  }
})

test('a wedged pass\'s naming is outstanding while the work it named is unfinished at the epochs it named, whatever a body does now: it stays the owner\'s to read once the body settles, a later body on the same fact is told by that row, and it ends when the named work moves on', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const task = f.propose({ title: 'Never reached' })
  await f.runtime.settle(f.mission.id)
  const scheduling = f.runtime.scheduling
  const first = wedgedBody(t, f, 'operation_wedge_open')
  const [naming] = wedgeRows(f)
  assert.deepEqual(naming.subjects, [`${task.id}@${taskOf(f.runtime, task.id).epoch}`], 'the naming names the work the pass never reached')
  // The hung call returns at its own bound before the owner has read the naming.
  scheduling.closePass(f.mission.id, first)
  assert.deepEqual([stateOf(f.runtime, f.mission.id).wedged, relevant(f, naming)], [false, true], 'no body is wedged, and the naming is still the owner\'s to read')
  // Later bodies wedge on the same fact and settle: the one row tells them, in every phase.
  for (const operationId of ['operation_wedge_2', 'operation_wedge_3']) {
    const body = wedgedBody(t, f, operationId)
    assert.deepEqual([body.escalatedAt !== undefined, wedgeRows(f).length, relevant(f, naming)], [true, 1, true], 'a body on the held fact writes no row: the row the owner can read tells it')
    scheduling.closePass(f.mission.id, body)
    assert.equal(relevant(f, naming), true)
  }
  await f.runtime.notices.flushOutbox(f.mission.id)
  assert.ok(f.runtime.store.get('deliveries', naming.id).deliveredAt !== undefined, 'it is delivered with no body wedged')
  const reminder = ordinal => ownerRows(f).find(delivery => delivery.notice.dedupKey === `obligation-followup:${naming.id}:${ordinal}`)
  f.clock.advance(f.runtime.notices.obligationFollowupMs)
  f.runtime.notices.absenceNet(f.mission.id)
  assert.deepEqual(reminder(1)?.subjects, naming.subjects, 'and reminded while no live path advances the work it named')
  // A later pass reaches the work: its member takes it, at a new epoch.
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  assert.notEqual(`${task.id}@${taskOf(f.runtime, task.id).epoch}`, naming.subjects[0])
  assert.equal(relevant(f, naming), false, 'the naming ends when the work it named moves on')
  f.clock.advance(f.runtime.notices.obligationFollowupMs)
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(reminder(2), undefined, 'and so do its reminders')
})

const terminalRows = (f, chain) => ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`guard-terminal:${chain}:`))
/** Each told fact's stall event names its row: the events of one cause, as the keys of the rows they were written with. */
const stallEventKeys = (f, cause) => events(f.runtime, f.mission.id, 'mission/stalled').filter(event => event.data.cause === cause).map(event => event.data.noticeKey)
/**
 * A guard of one member's dispatch chain that throws on every pass: the member holds no isolated worktree, so the
 * sweep's isolation decision refuses it, and recording that refusal throws `failure()`; the sweep's own guard
 * terminal is then the throw's one record. `repair` gives the member its worktree back, and its chain passes.
 */
const failingDispatch = (f, member, failure) => {
  const workspace = f.runtime.store.get('members', member.id).workspace
  const provision = path => f.runtime.store.transaction(() => f.runtime.store.put('members', { ...f.runtime.store.get('members', member.id), workspace: path }))
  const recordIsolation = f.runtime.workspaceAdmission.recordIsolation.bind(f.runtime.workspaceAdmission)
  f.runtime.workspaceAdmission.recordIsolation = (board, violation) => { if (violation.memberIds.includes(member.id)) throw new Error(failure()); return recordIsolation(board, violation) }
  provision('')
  return { repair: () => provision(workspace) }
}

test('L-25: a guard terminal is one request per fact that opened it: the task budget and the experiment budget refused on one board are two, and a repeat on another board is none', async t => {
  const f = await setup({ clock: new FakeClock(), budget: { maxTasks: 1, maxExperiments: 0 } })
  t.after(f.cleanup)
  f.propose({ title: 'The one admitted task' })
  await f.runtime.settle(f.mission.id)
  const board = f.runtime.fingerprint(f.mission.id)
  assert.throws(() => f.propose({ title: 'One too many' }), /mission_task_budget_exhausted/)
  f.runtime.updateBudget(f.owner, f.mission.id, { ...f.runtime.mission(f.mission.id).budget, maxTasks: 5 }, 'room for more work')
  await f.runtime.settle(f.mission.id)
  assert.throws(() => f.propose({ title: 'An experiment', experiment: true }), /experiment budget exhausted/)
  assert.equal(f.runtime.fingerprint(f.mission.id), board, 'both refusals met one board digest: a raised ceiling is no board change')
  const keys = () => terminalRows(f, 'task_ceiling').map(delivery => delivery.notice.dedupKey)
  assert.deepEqual(keys().map(key => key.split(':').slice(3).join(':')), ['task-budget:1', 'experiment-budget:0'], 'each refusal is its own request, keyed by the limit it met')
  assert.deepEqual(terminalRows(f, 'task_ceiling').map(delivery => delivery.notice.reason),
    ['mission task budget exhausted (1/1 tasks admitted)', 'mission experiment budget exhausted (0/0 experiments admitted)'], 'and its row records the refusal as its reason')
  assert.deepEqual(stallEventKeys(f, 'guard-terminal'), keys(), 'one stall event per request, naming its row')
  // The board changes; the same limit refuses the same admission again.
  f.propose({ title: 'A second admitted task', assigneeId: f.reviewer.id, kind: 'research', checks: [] })
  await f.runtime.settle(f.mission.id)
  assert.notEqual(f.runtime.fingerprint(f.mission.id), board)
  assert.throws(() => f.propose({ title: 'The experiment again', experiment: true }), /experiment budget exhausted/)
  assert.deepEqual([keys().length, stallEventKeys(f, 'guard-terminal').length], [2, 2], 'the owner holds that request: a repeat writes no row and no event, whatever the board digest is')
  // A raised limit that refuses again is a new fact (told in a new wake window, so as its own delivery).
  f.clock.advance(f.runtime.notices.wakeBudgetWindowMs + 1)
  f.runtime.updateBudget(f.owner, f.mission.id, { ...f.runtime.mission(f.mission.id).budget, maxExperiments: 1 }, 'one experiment')
  f.propose({ title: 'The admitted experiment', experiment: true })
  assert.throws(() => f.propose({ title: 'A second experiment', experiment: true }), /experiment budget exhausted/)
  assert.equal(keys().at(-1).split(':').slice(3).join(':'), 'experiment-budget:1', 'the limit the owner raised refuses under its own request')
  assert.deepEqual(stallEventKeys(f, 'guard-terminal'), keys())
})

test('L-25: a failed dispatch is one request per member, the work it names and the failure, whatever the board digest; the dispatch question about the task it names stays its own fact, told once under its own key', async t => {
  const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }) })
  t.after(f.cleanup)
  // A guard of the author's dispatch chain throws on every pass.
  let failure = 'worktree probe failed: EIO'
  failingDispatch(f, f.author, () => failure)
  const task = f.propose({ title: 'Work for the author' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 2)
  const subject = `${task.id}@${taskOf(f.runtime, task.id).epoch}`
  const terminals = () => terminalRows(f, 'attempt_lease')
  const questions = () => ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith('dispatch-question:')).map(delivery => delivery.notice.dedupKey)
  assert.equal(taskOf(f.runtime, task.id).status, 'pending', 'the author is never given its task')
  assert.deepEqual(terminals().map(delivery => [delivery.notice.dedupKey, delivery.notice.reason, delivery.subjects]),
    [[`guard-terminal:attempt_lease:attempt_terminal:${factKey(f.mission.id, { trigger: `dispatch-failed:${f.author.id}`, reason: `Error: ${failure}`, subjects: [subject] })}`, `Error: ${failure}`, [subject]]],
    'the chain\'s terminal is opened by factKey\'s rule over the member, its unfinished work and the failure, records the failure as its reason and names that work')
  // The board changes under the same failure: the reviewer is given work.
  const board = f.runtime.fingerprint(f.mission.id)
  f.propose({ title: 'Work for the reviewer', assigneeId: f.reviewer.id, kind: 'research', checks: [] })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 3)
  assert.notEqual(f.runtime.fingerprint(f.mission.id), board)
  assert.equal(terminals().length, 1, 'the same failure on another board digest is the request the owner holds')
  // Another failure of the same chain on this board is another request.
  const changed = f.runtime.fingerprint(f.mission.id)
  failure = 'worktree probe failed: ENOSPC'
  await ticks(f, 2)
  assert.equal(f.runtime.fingerprint(f.mission.id), changed)
  assert.deepEqual(terminals().map(delivery => delivery.notice.reason), ['Error: worktree probe failed: EIO', `Error: ${failure}`], 'a different failure on an unchanged board is told')
  assert.deepEqual(stallEventKeys(f, 'guard-terminal'), terminals().map(delivery => delivery.notice.dedupKey), 'one stall event per request, naming its row')
  // Open (docs/known-limitations.md): the question is a second wording of the failing chain's condition. It has no predicate
  // for a failing chain, so it is asked too; what is pinned here is that it is asked once, under its own key.
  assert.deepEqual(questions(), [`dispatch-question:${f.mission.id}:${subject}`], 'the undispatched task is the dispatch question\'s own fact at its epoch: asked once, whichever requests the chain holds')
})

/** Every body and deferred operation settles, two ticks run, and what they started settles too. */
const quiet = async f => { await f.runtime.settle(f.mission.id); await ticks(f, 2); await f.runtime.settle(f.mission.id) }
/** The openers of one chain's requests on the ledger, in the order they were told. */
const openers = (f, chain) => terminalRows(f, chain).map(delivery => delivery.notice.dedupKey.split(':').slice(3).join(':'))
const requestKeys = f => ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith('guard-terminal:')).map(delivery => delivery.notice.dedupKey)
/** A new wake window, so the next fact is its own delivery and not a constituent of a summary. */
const nextWindow = f => f.clock.advance(f.runtime.notices.wakeBudgetWindowMs + 1)
const reminders = (f, row) => ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`obligation-followup:${row.id}:`))
/** Deliver what is queued, let one reminder interval pass, and return the reminders the absence net then wrote for a row. */
const remind = async (f, row) => {
  await f.runtime.notices.flushOutbox(f.mission.id)
  const before = reminders(f, row).length
  f.clock.advance(f.runtime.notices.obligationFollowupMs)
  f.runtime.notices.absenceNet(f.mission.id)
  return reminders(f, row).slice(before)
}
/** A mission long enough for a test that keeps scheduling after a reminder interval. */
const LONG = { maxDurationMs: 86_400_000 }

test('L-25: each budget pause has its own request: told once while the pause lasts, and the exhaustion after the owner raised the budget is told again; every tool it names is performed through the owner\'s registered tools: swarm_control\'s resume is refused, swarm_cancel withdraws work and resets nothing, and swarm_budget resumes the mission', async t => {
  const f = await setup({ clock: new FakeClock(), budget: { maxTokens: 10_000 } })
  t.after(f.cleanup)
  const tool = await ownerTools(f)
  const held = f.propose({ title: 'Held work' })
  const spend = tokens => f.runtime.commit(f.mission.id, () => f.runtime.store.put('missions', { ...f.runtime.mission(f.mission.id), usedTokens: tokens }))
  spend(10_000)
  await quiet(f)
  const first = f.runtime.mission(f.mission.id).budgetPause.id
  await ticks(f, 3)
  assert.deepEqual(openers(f, 'budget'), [`budget-pause:${first}`], 'the pause is one request, however many ticks it lasts')
  const [request] = terminalRows(f, 'budget')
  assert.deepEqual(namedTools(request.content), ['swarm_budget', 'swarm_cancel', 'swarm_control'], 'the request names these tools')
  /** What the owner meets after a named call: the mission, its spend, the held task, the pause's requests and whether this one is still the owner's to read. */
  const met = () => { const mission = f.runtime.mission(f.mission.id); return [mission.status, mission.usedTokens, taskOf(f.runtime, held.id).status, openers(f, 'budget'), relevant(f, request)] }
  // The request names swarm_control's resume for an explicit user pause only: an exhausted budget refuses it.
  assert.match(request.content, /Explicit user pause remains until `swarm_control` with `action: resume`/)
  await assert.rejects(tool('swarm_control', { action: 'resume', reason: 'Resume' }), /Mission budget exhausted; it cannot be resumed with a fresh allowance/, 'the resume is refused by the limit it would have to ignore')
  await quiet(f)
  assert.deepEqual(met(), ['blocked', 10_000, 'pending', [`budget-pause:${first}`], true], 'the refused resume changes nothing: the pause and its one request stand')
  assert.match(request.content, /Use `swarm_cancel` with `taskId` and `reason` to withdraw mistaken work; cancellation never resets consumed budget/)
  await tool('swarm_cancel', { taskId: held.id, reason: 'Withdrawn' })
  await quiet(f)
  assert.deepEqual(met(), ['blocked', 10_000, 'cancelled', [`budget-pause:${first}`], true], 'the withdrawal is accepted and, as the request says, resets nothing: the mission stays paused under the same request')
  assert.match(request.content, /`swarm_budget` using `budget` and `reason`/, 'the request names the exit that ends the pause')
  nextWindow(f)
  await tool('swarm_budget', { budget: { ...f.runtime.mission(f.mission.id).budget, maxTokens: 20_000 }, reason: 'More room' })
  await quiet(f)
  assert.equal(f.runtime.mission(f.mission.id).status, 'active', 'that exit resumes the mission')
  spend(20_000)
  await quiet(f)
  const second = f.runtime.mission(f.mission.id).budgetPause.id
  assert.deepEqual(openers(f, 'budget'), [`budget-pause:${first}`, `budget-pause:${second}`], 'the second exhaustion is its own pause, so its own request')
  assert.deepEqual(stallEventKeys(f, 'guard-terminal'), requestKeys(f), 'one stall event per request, naming its row')
})

test('L-25: a task ceiling is one request per task epoch and dimension: the task that exhausts the allocation the owner raised with swarm_budget is told again', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const tool = await ownerTools(f)
  const task = f.propose({ title: 'Ceiling bound', maxSteps: 1 })
  /** The author takes the task and steps until its ceiling refuses one. */
  const exhaust = async () => {
    await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    while (await f.workers.callbacks.beforeStep(f.author.id, true) !== false) { /* a charged step */ }
    await quiet(f)
    assert.equal(taskOf(f.runtime, task.id).status, 'blocked')
    return `ceiling:${task.id}@${taskOf(f.runtime, task.id).epoch}:maxSteps`
  }
  const first = await exhaust()
  assert.deepEqual(openers(f, 'task_ceiling'), [first], 'the request is keyed by the task at the epoch it blocked and the dimension it exhausted')
  assert.match(terminalRows(f, 'task_ceiling')[0].content, /`swarm_budget` using `taskId`, `taskBudget` and `reason`/, 'and names the exit')
  nextWindow(f)
  await tool('swarm_budget', { taskId: task.id, taskBudget: { maxSteps: 2 }, reason: 'More steps' })
  await quiet(f)
  assert.equal(taskOf(f.runtime, task.id).status, 'pending', 'that exit re-pends the task')
  const second = await exhaust()
  assert.deepEqual(openers(f, 'task_ceiling'), [first, second], 'the raised allocation running out is a new fact: the task at its new epoch')
  assert.notEqual(second, first)
  assert.deepEqual(stallEventKeys(f, 'guard-terminal'), requestKeys(f), 'one stall event per request, naming its row')
})

test('L-25: the close-out requests are keyed by what ended: an abandoned close-out per attempt and an exhausted recovery per task epoch, so the recovery the owner extended with swarm_control is told again when it runs out; until it is extended, the exits that request names are refused', async t => {
  const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), config: { maxIdleCloseouts: 0 } })
  t.after(f.cleanup)
  const tool = await ownerTools(f)
  const task = f.propose({ title: 'Close-out', maxRecoveryAttempts: 2 })
  await quiet(f)
  /** The author's turn ends with its attempt open: the close-out checkpoints it and re-pends the task. */
  const abandon = async () => {
    const attempt = taskOf(f.runtime, task.id).attempt.id
    f.runtime.attempts.onIdle(f.author.id)
    await quiet(f)
    return `closeout-abandoned:${attempt}`
  }
  const exhausted = () => `recovery-exhausted:${task.id}@${taskOf(f.runtime, task.id).epoch}`
  const first = await abandon()
  assert.deepEqual([taskOf(f.runtime, task.id).status, openers(f, 'attempt_lease')], ['running', [first]], 'the abandoned attempt is told, and the task is dispatched again')
  nextWindow(f)
  const second = await abandon()
  const spent = exhausted()
  assert.deepEqual([taskOf(f.runtime, task.id).status, openers(f, 'attempt_lease')], ['blocked', [first, second, spent]],
    'the next attempt\'s abandonment is its own request, and so is the recovery it exhausted, on the one transition')
  // A recorded limitation (docs/known-limitations.md): the chain's request names the chain's exits, and while this opener's
  // limit is spent each of them meets the refusal that names the limit. Raising it, below, is the exit that works.
  const request = terminalRows(f, 'attempt_lease').at(-1)
  for (const [exit, call] of Object.entries({
    '`action: amend`, `changes.assigneeId` and `reason` to fence and reassign it': { action: 'amend', changes: { assigneeId: f.reviewer.id }, reason: 'Reassign' },
    '`action: resume` after repair': { action: 'resume', reason: 'Repaired' },
  })) {
    assert.ok(request.content.includes(exit), `the exhausted recovery's request names: ${exit}`)
    await assert.rejects(tool('swarm_control', { taskId: task.id, ...call }), /Raise maxRecoveryAttempts before resuming exhausted automatic recovery/, `${exit} is refused while the recovery limit is spent`)
  }
  assert.deepEqual([taskOf(f.runtime, task.id).status, openers(f, 'attempt_lease'), relevant(f, request)], ['blocked', [first, second, spent], true], 'the refused exits change nothing: the task is blocked and its request outstanding')
  nextWindow(f)
  await tool('swarm_control', { taskId: task.id, action: 'amend', changes: { maxRecoveryAttempts: 3 }, reason: 'One more recovery' })
  await quiet(f)
  assert.equal(taskOf(f.runtime, task.id).status, 'running', 'the owner\'s extension lets the task run again')
  const third = await abandon()
  assert.deepEqual(openers(f, 'attempt_lease'), [first, second, spent, third, exhausted()], 'the extended recovery running out is a new fact: the task at its new epoch')
  assert.notEqual(exhausted(), spent)
  assert.deepEqual(stallEventKeys(f, 'guard-terminal'), requestKeys(f), 'one stall event per request, naming its row')
})

test('L-25: a close-out whose checkpoint fails is one request per task epoch: the task the owner resumed with swarm_control is told again when its next close-out fails, and the reassignment the request also names lets it run under another member', async t => {
  const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), config: { maxIdleCloseouts: 0 } })
  t.after(f.cleanup)
  const tool = await ownerTools(f)
  const task = f.propose({ title: 'Held attempt', maxRecoveryAttempts: 3 })
  f.workers.captureArtifact = async () => { throw new Error('[workspace_uncommitted] Member workspace has uncommitted work') }
  /** The dispatched author's turn ends with its attempt open, and the close-out cannot checkpoint the workspace. */
  const fail = async () => {
    await quiet(f)
    assert.equal(taskOf(f.runtime, task.id).status, 'running')
    f.runtime.attempts.onIdle(f.author.id)
    await quiet(f)
    assert.equal(taskOf(f.runtime, task.id).status, 'blocked')
    return `closeout-failed:${task.id}@${taskOf(f.runtime, task.id).epoch}`
  }
  const first = await fail()
  assert.deepEqual(openers(f, 'attempt_lease'), [first])
  assert.match(terminalRows(f, 'attempt_lease')[0].content, /`action: resume` after repair/, 'the request names the exit')
  nextWindow(f)
  await tool('swarm_control', { taskId: task.id, action: 'resume', reason: 'Workspace repaired' })
  const second = await fail()
  assert.deepEqual(openers(f, 'attempt_lease'), [first, second], 'the resumed task failing its close-out again is a new fact: the task at its new epoch')
  assert.notEqual(second, first)
  assert.deepEqual(stallEventKeys(f, 'guard-terminal'), requestKeys(f), 'one stall event per request, naming its row')
  // The other exit the request names moves the task off the member whose workspace cannot be checkpointed.
  assert.match(terminalRows(f, 'attempt_lease')[1].content, /`action: amend`, `changes.assigneeId` and `reason` to fence and reassign it/)
  nextWindow(f)
  await tool('swarm_control', { taskId: task.id, action: 'amend', changes: { assigneeId: f.reviewer.id }, reason: 'Reassign' })
  await quiet(f)
  assert.deepEqual([taskOf(f.runtime, task.id).status, taskOf(f.runtime, task.id).attempt?.ownerId, openers(f, 'attempt_lease')], ['running', f.reviewer.id, [first, second]], 'the reassignment lets the task run under the other member, with no further request')
})

test('L-25: a lease-expiry checkpoint failure is one request per attempt: the next attempt whose lease expires over the same workspace is told again', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const task = f.propose({ title: 'Expiring attempt', maxRecoveryAttempts: 3 })
  // The owner of the attempt is quiescent, so the lease-expiry path tries a checkpoint, which the workspace refuses.
  f.workers.idle.add(f.author.id)
  f.workers.captureArtifact = async () => { throw new Error('[workspace_uncommitted] dirty workspace') }
  const expire = async () => {
    await quiet(f)
    const attempt = taskOf(f.runtime, task.id).attempt.id
    f.clock.advance(f.runtime.config.leaseMs + 1)
    await quiet(f)
    return `checkpoint-failed:${attempt}`
  }
  const first = await expire()
  assert.deepEqual(openers(f, 'attempt_lease'), [first])
  const second = await expire()
  assert.deepEqual(openers(f, 'attempt_lease'), [first, second], 'each attempt whose checkpoint failed is its own request')
  assert.notEqual(second, first)
  assert.deepEqual(stallEventKeys(f, 'guard-terminal'), requestKeys(f), 'one stall event per request, naming its row')
})

test('every exit the abandoned close-out\'s and the lease-expiry checkpoint failure\'s requests name, performed through the owner\'s registered tools: the task was already re-pended, so the resume leaves its new attempt running and the reassignment fences it for the other member; neither tells the request again or reminds the owner of an attempt that is gone', async t => {
  const boards = {
    /** The author's turn ends with its attempt open: the close-out checkpoints it and re-pends the task. */
    'closeout-abandoned': async () => {
      const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), config: { maxIdleCloseouts: 0 }, budget: LONG })
      t.after(f.cleanup)
      const task = f.propose({ title: 'Close-out', maxRecoveryAttempts: 3 })
      await quiet(f)
      const attempt = taskOf(f.runtime, task.id).attempt.id
      f.runtime.attempts.onIdle(f.author.id)
      await quiet(f)
      return { f, task, attempt }
    },
    /** The quiescent author's lease expires, and the workspace refuses the checkpoint the expiry path tries. */
    'checkpoint-failed': async () => {
      const f = await setup({ clock: new FakeClock(), budget: LONG })
      t.after(f.cleanup)
      const task = f.propose({ title: 'Expiring attempt', maxRecoveryAttempts: 3 })
      for (const member of [f.author, f.reviewer]) f.workers.idle.add(member.id)
      f.workers.captureArtifact = async () => { throw new Error('[workspace_uncommitted] dirty workspace') }
      await quiet(f)
      const attempt = taskOf(f.runtime, task.id).attempt.id
      f.clock.advance(f.runtime.config.leaseMs + 1)
      await quiet(f)
      return { f, task, attempt }
    },
  }
  const exits = {
    '`action: resume` after repair': { owner: f => f.author.id, call: () => ({ action: 'resume', reason: 'Repaired' }) },
    '`action: amend`, `changes.assigneeId` and `reason` to fence and reassign it': { owner: f => f.reviewer.id, call: f => ({ action: 'amend', changes: { assigneeId: f.reviewer.id }, reason: 'Reassign' }) },
  }
  for (const [opener, board] of Object.entries(boards)) {
    for (const [exit, { owner, call }] of Object.entries(exits)) {
      const { f, task, attempt } = await board()
      const [request] = terminalRows(f, 'attempt_lease')
      assert.deepEqual([openers(f, 'attempt_lease'), namedTools(request.content)], [[`${opener}:${attempt}`], ['swarm_control']])
      assert.ok(request.content.includes(exit), `the ${opener} request names: ${exit}`)
      // The recovery that raised the request has already re-pended the task: the author runs it again under a new attempt.
      const before = taskOf(f.runtime, task.id)
      assert.deepEqual([before.status, before.attempt.ownerId, before.attempt.id !== attempt], ['running', f.author.id, true])
      nextWindow(f)
      await (await ownerTools(f))('swarm_control', { taskId: task.id, ...call(f) })
      await quiet(f)
      const after = taskOf(f.runtime, task.id)
      assert.deepEqual([after.status, after.attempt.ownerId, after.attempt.id === before.attempt.id], ['running', owner(f), owner(f) === f.author.id],
        `${opener}: ${exit} ${owner(f) === f.author.id ? 'is accepted and leaves the running attempt as it is' : 'fences that attempt and the other member runs the task'}`)
      assert.deepEqual([openers(f, 'attempt_lease'), relevant(f, request), (await remind(f, request)).length], [[`${opener}:${attempt}`], true, 0],
        'the request stays the record of the attempt that ended: it is not told again, and nothing reminds the owner of a task that moved on')
    }
  }
})

test('the mission admission requests\' exit, performed through the owner\'s registered tools, for the task budget and the experiment budget: swarm_budget and a retry admit the work, a refusal repeated under one limit is the request the owner holds, and a refusal under the raised limit is a new one', async t => {
  const limits = {
    'task-budget': { limit: 'maxTasks', extra: {}, refusal: /mission_task_budget_exhausted/ },
    'experiment-budget': { limit: 'maxExperiments', extra: { experiment: true }, refusal: /Mission experiment budget exhausted/ },
  }
  for (const [opener, { limit, extra, refusal }] of Object.entries(limits)) {
    const f = await setup({ clock: new FakeClock(), budget: { [limit]: 1 } })
    t.after(f.cleanup)
    const tool = await ownerTools(f)
    const proposal = title => ({ workstreamId: f.stream.id, title, objective: 'Do the work the mission needs', kind: 'research', scope: ['**'], outputs: [], acceptance: MISSION_ACCEPTANCE, checks: [], ...extra })
    await tool('swarm_propose', proposal('The one admitted'))
    for (const title of ['One too many', 'One too many, again']) await assert.rejects(tool('swarm_propose', proposal(title)), refusal)
    assert.deepEqual([openers(f, 'task_ceiling'), stallEventKeys(f, 'guard-terminal').length], [[`${opener}:1`], 1], `${opener}: two refusals under one limit are one request and one event`)
    const [request] = terminalRows(f, 'task_ceiling')
    assert.deepEqual(namedTools(request.content), ['swarm_budget'])
    assert.match(request.content, /use `swarm_budget` with a finite raised `budget` and `reason`, then retry the original admission/)
    nextWindow(f)
    await tool('swarm_budget', { budget: { ...f.runtime.mission(f.mission.id).budget, [limit]: 2 }, reason: 'Room for one more' })
    assert.equal((await tool('swarm_propose', proposal('One too many'))).title, 'One too many', `${opener}: the retried admission goes through`)
    // The raised limit answers the request: it is a decision only while the limit it met is the current one.
    assert.equal(relevant(f, request), false, `${opener}: the raised limit ends the request`)
    await assert.rejects(tool('swarm_propose', proposal('A third')), refusal)
    assert.deepEqual(openers(f, 'task_ceiling'), [`${opener}:1`, `${opener}:2`], `${opener}: the limit the owner raised refuses under its own request`)
    assert.deepEqual(stallEventKeys(f, 'guard-terminal'), requestKeys(f), 'one stall event per request, naming its row')
  }
})

const subjectOf = (f, task) => `${task.id}@${taskOf(f.runtime, task.id).epoch}`
/** Two tasks no pass has reached: the author's, and one only the reviewer may take. */
const twoUnreached = async t => {
  const f = await setup({ clock: new FakeClock(), budget: LONG })
  t.after(f.cleanup)
  const one = f.propose({ title: 'Never reached one' })
  const two = f.propose({ title: 'Never reached two', kind: 'research', checks: [], assigneeId: f.reviewer.id })
  await f.runtime.settle(f.mission.id)
  return { f, one, two }
}
const stopReviewer = f => f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))

test('naming a body is the transition its wedged publication belongs to, whether or not the naming writes a row: a board fact committed inside the bound of a body on a held naming fact is told at that bound', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const dead = f.propose({ title: 'Reviewer-only work', kind: 'research', checks: [], assigneeId: f.reviewer.id })
  await f.runtime.settle(f.mission.id)
  const scheduling = f.runtime.scheduling
  // An earlier body wedged on this naming fact, was named, and settled.
  scheduling.closePass(f.mission.id, wedgedBody(t, f, 'operation_wedge_1'))
  await Promise.resolve()
  // The next body is live. Inside its bound the only member that may take the work is stopped: that transition's publication is the pass's.
  const body = scheduling.openPass(f.mission.id)
  t.after(() => scheduling.closePass(f.mission.id, body))
  stopReviewer(f)
  await Promise.resolve()
  assert.equal(stallRow(f), undefined, 'a live pass leaves the board to its end')
  // The body never returns. Past its bound the watchdog names it by the row the owner holds.
  f.clock.advance(f.runtime.bounds.stallPassTimeoutMs)
  scheduling.checkSchedulingPasses()
  assert.deepEqual([body.escalatedAt !== undefined, wedgeRows(f).length, wedgeEvents(f).length], [true, 1, 1], 'the body is named, and the naming writes neither a row nor an event')
  await Promise.resolve()
  assert.deepEqual(stallRow(f)?.subjects, [subjectOf(f, dead)], 'the board the body left unpublished is judged at its bound: the stuck work is told while the body is still wedged, with no other commit')
})

test('a wedged pass\'s naming of several tasks is outstanding for the work still unfinished at the epochs it named: one withdrawn while the body stays wedged leaves the naming the owner\'s to read and its reminders name the rest, and it ends with the last', async t => {
  for (const delivered of [false, true]) {
    const { f, one, two } = await twoUnreached(t)
    const body = wedgedBody(t, f, 'operation_wedge_two')
    const [naming] = wedgeRows(f)
    assert.deepEqual([...naming.subjects].sort(), [subjectOf(f, one), subjectOf(f, two)].sort(), 'the naming names both tasks the pass never reached')
    if (delivered) await f.runtime.notices.flushOutbox(f.mission.id)
    assert.equal(f.runtime.store.get('deliveries', naming.id).deliveredAt !== undefined, delivered)
    // The owner withdraws one named task. The body is still wedged, and a body is named once.
    f.runtime.cancel(f.owner, f.mission.id, { taskId: two.id, reason: 'Not needed' })
    await ticks(f, 2)
    assert.deepEqual([stateOf(f.runtime, f.mission.id).wedged, f.runtime.scheduling.passes.get(f.mission.id) === body, wedgeRows(f).length, taskOf(f.runtime, one.id).status], [true, true, 1, 'pending'],
      'the body is still wedged on work it named, and nothing names it again')
    assert.equal(relevant(f, naming), true, `the ${delivered ? 'delivered naming stays in the owner\'s inbox' : 'queued naming is still delivered'}: it is the one record of the wedge that holds the remaining work`)
    assert.deepEqual((await remind(f, naming)).map(delivery => delivery.subjects), [[subjectOf(f, one)]], 'its reminder names the work still unfinished')
    assert.equal(relevant(f, naming), true, 'and a naming the owner is reminded of is one the owner can read')
    f.runtime.cancel(f.owner, f.mission.id, { taskId: one.id, reason: 'Not needed either' })
    assert.equal(relevant(f, naming), false, 'the naming ends with the last task it named')
    assert.deepEqual(await remind(f, naming), [], 'and so do its reminders')
  }
})

test('a wake summary reminds and spends only the constituents with reminders left: one that spent its own stays unnamed while it is unresolved, and one resolved for a while and then reopened is reminded from its own first', async t => {
  const f = await setup({ clock: new FakeClock(), budget: LONG })
  t.after(f.cleanup)
  const limit = f.runtime.notices.maxObligationFollowups
  const [spent, reopened] = ['Spent work', 'Reopened work'].map(title => f.propose({ title }))
  await quiet(f)
  /** Row surgery as a verdict or a withdrawal writes it: a blocked task waits on nothing but the owner, a cancelled one is resolved. */
  const status = (task, value) => f.runtime.store.transaction(() => f.runtime.store.put('tasks', { ...taskOf(f.runtime, task.id), status: value }))
  for (const task of [spent, reopened]) status(task, 'blocked')
  // One wake window: its first fact takes the individual wake, and the two decisions are carried by its summary.
  f.runtime.notices.wakeBudget = 1
  nextWindow(f)
  f.runtime.store.transaction(() => {
    f.runtime.notices.notify(f.mission.id, 'A fact that takes the window\'s individual wake', [`mission:${f.mission.id}`], { noticeClass: 'progress', trigger: 'test/progress' })
    f.runtime.notices.notify(f.mission.id, 'The spent decision', [subjectOf(f, spent)], { noticeClass: 'stall', trigger: 'test/stall' })
    f.runtime.notices.notify(f.mission.id, 'The reopened decision', [subjectOf(f, reopened)], { noticeClass: 'stall', trigger: 'test/stall' })
  })
  f.runtime.notices.wakeBudget = 0
  const summary = ownerRows(f).find(delivery => delivery.notice.dedupKey.startsWith('wake-budget:'))
  assert.deepEqual(summary.notice.aggregatedFacts.map(part => part.subjects), [[subjectOf(f, spent)], [subjectOf(f, reopened)]], 'the summary carries both decisions')
  const counts = () => f.runtime.store.get('deliveries', summary.id).notice.aggregatedFacts.map(part => part.followupCount ?? 0)
  // While the second decision is resolved, every reminder is the first one's, until it has spent its own.
  status(reopened, 'cancelled')
  for (let reminder = 1; reminder <= limit; reminder += 1) {
    assert.deepEqual((await remind(f, summary)).map(delivery => [delivery.subjects, delivery.content.includes('The spent decision'), delivery.content.includes('The reopened decision')]), [[[subjectOf(f, spent)], true, false]],
      `reminder ${reminder} names the unresolved constituent alone`)
  }
  assert.deepEqual(counts(), [limit, 0], 'the first constituent spent its reminders, and the resolved one spent none')
  assert.deepEqual(await remind(f, summary), [], 'a constituent that spent its reminders is not reminded again, though it is unresolved')
  // The second decision reopens: it is reminded from its own first reminder, and the spent one is neither named nor charged.
  status(reopened, 'blocked')
  const [reminder, ...more] = await remind(f, summary)
  assert.deepEqual([more.length, reminder.subjects], [0, [subjectOf(f, reopened)]], 'one reminder, naming the reopened constituent alone')
  assert.ok(reminder.content.includes(`reminder 1 of ${limit}`) && reminder.content.includes('The reopened decision') && !reminder.content.includes('The spent decision'), 'its ordinal and its prior notice are that constituent\'s own')
  assert.deepEqual(counts(), [limit, 1], 'and it spends only that constituent\'s allowance')
})

test('a wedged pass\'s naming fact is the unfinished work and the counted start failures, under the key older builds wrote: other unfinished work under unchanged failures names the next body, and a held fact on a moved board digest names none', async t => {
  const { f, one, two } = await twoUnreached(t)
  const scheduling = f.runtime.scheduling
  const key = (tasks, reason) => `scheduling-pass:${f.mission.id}:${tasks.map(task => subjectOf(f, task)).sort().join('+')}:${createHash('sha256').update(reason).digest('hex').slice(0, 16)}`
  const told = () => [wedgeRows(f).map(delivery => delivery.notice.dedupKey), wedgeEvents(f).map(event => event.data.noticeKey)]
  const both = key([one, two], 'pass-timeout')
  scheduling.closePass(f.mission.id, wedgedBody(t, f, 'operation_wedge_1'))
  assert.deepEqual(told(), [[both], [both]], 'the key is the family, the mission, the sorted unfinished work at its epochs and the digest of the recorded reason')
  // The board digest moves under the next body; the work it never reached and the counted failures do not.
  const second = { id: scheduling.passKey(f.mission.id), operationId: 'operation_wedge_2', missionId: f.mission.id, startedAt: f.clock.now() - 60_000,
    revisionBefore: f.runtime.store.revision(), fingerprintBefore: f.runtime.fingerprint(f.mission.id) }
  scheduling.passes.set(f.mission.id, second)
  stopReviewer(f)
  assert.notEqual(f.runtime.fingerprint(f.mission.id), second.fingerprintBefore, 'the board digest moved while the body was held')
  scheduling.checkSchedulingPasses()
  assert.deepEqual([second.escalatedAt !== undefined, told()], [true, [[both], [both]]], 'the owner holds that fact: the body is named by its row, with no second row and no event, whatever the board digest is')
  scheduling.closePass(f.mission.id, second)
  // Less unfinished work under the same (absent) start failures is another fact.
  f.runtime.cancel(f.owner, f.mission.id, { taskId: two.id, reason: 'Not needed' })
  await f.runtime.settle(f.mission.id)
  const third = wedgedBody(t, f, 'operation_wedge_3')
  assert.deepEqual(told(), [[both, key([one], 'pass-timeout')], [both, key([one], 'pass-timeout')]], 'the work the pass never reached is part of the fact: the next body is named by its own row and event')
  // A counted start failure is the reason's other component.
  scheduling.closePass(f.mission.id, third)
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.author.id), startFailures: 2 }))
  wedgedBody(t, f, 'operation_wedge_4')
  assert.equal(told()[0].at(-1), key([one], `pass-timeout ${f.author.id}:2`), 'each member\'s counted consecutive start failures follow the cause in the reason the key digests')
})

/** The digest a key carries for a recorded reason. */
const sha16 = text => createHash('sha256').update(text).digest('hex').slice(0, 16)

test('L-25: a failed dispatch\'s request is the failure of the work it names: the same member failing with the same text is the request the owner holds only over that work, and is told again over later work, by a request that names it', async t => {
  const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), budget: LONG })
  t.after(f.cleanup)
  const tool = await ownerTools(f)
  // A guard of the author's dispatch chain throws on every pass, whatever work the author holds.
  const failure = 'Member has uncommitted commits'
  failingDispatch(f, f.author, () => failure)
  const opener = subjects => factKey(f.mission.id, { trigger: `dispatch-failed:${f.author.id}`, reason: `Error: ${failure}`, subjects })
  const told = () => terminalRows(f, 'attempt_lease').map(delivery => [delivery.notice.dedupKey.split(':').slice(3).join(':'), delivery.subjects, delivery.notice.reason])
  const request = subjects => [opener(subjects), subjects, `Error: ${failure}`]
  const first = f.propose({ title: 'First work for the author' })
  await quiet(f)
  const one = [subjectOf(f, first)], root = [`mission:${f.mission.id}`]
  assert.deepEqual(told(), [request(one)], 'the request is keyed by the member, the unfinished work it names at its epoch and the failure')
  await ticks(f, 3)
  assert.deepEqual(told(), [request(one)], 'the same throw over the same work is the request the owner holds')
  // The owner reads the request and withdraws the work. The chain still throws, with nothing of the author's to hold.
  nextWindow(f)
  await tool('swarm_cancel', { taskId: first.id, reason: 'Withdrawn' })
  await quiet(f)
  assert.deepEqual(told(), [request(one), request(root)], 'a member that holds no work and still fails is told once, at the mission root')
  // Later work for the same member meets the same throw: no request the owner holds names it.
  nextWindow(f)
  const later = f.propose({ title: 'Later work for the author' })
  await quiet(f)
  const two = [subjectOf(f, later)]
  assert.equal(taskOf(f.runtime, later.id).status, 'pending', 'the author is never given the later work')
  assert.deepEqual(told(), [request(one), request(root), request(two)], 'the same failure of other work is a new fact: its own request, naming that work')
  await ticks(f, 3)
  assert.deepEqual(told().length, 3, 'told once')
  assert.deepEqual(stallEventKeys(f, 'guard-terminal'), requestKeys(f), 'one stall event per request, naming its row')
  const [withdrawn, , stuck] = terminalRows(f, 'attempt_lease')
  assert.deepEqual([(await remind(f, withdrawn)).length, (await remind(f, stuck)).map(delivery => delivery.subjects)], [0, [two]], 'and the reminders speak for the work that is stuck now, not for the work the owner withdrew')
})

test('every exit a failed dispatch\'s request names, performed through the owner\'s registered tools: each lets the task it names run, the request is never told twice over that work, and its reminders follow the task', async t => {
  /** The author's dispatch chain throws on every pass until `fault.repair()`; its task stays pending and the chain's request names it. */
  const board = async () => {
    const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), budget: LONG })
    t.after(f.cleanup)
    const fault = failingDispatch(f, f.author, () => 'worktree probe failed: EIO')
    const task = f.propose({ title: 'Work for the author' })
    await quiet(f)
    const [request] = terminalRows(f, 'attempt_lease')
    assert.deepEqual(namedTools(request.content), ['swarm_control'])
    return { f, task, request, fault, tool: await ownerTools(f) }
  }
  // The reassignment moves the task off the failing member without repairing it: that member then fails holding no work, which is told once at the mission root.
  const exits = {
    '`action: resume` after repair': { then: [], perform: async ({ task, fault, tool }) => { fault.repair(); await tool('swarm_control', { taskId: task.id, action: 'resume', reason: 'Repaired' }) } },
    '`action: amend`, `changes.assigneeId` and `reason` to fence and reassign it': { then: [f => [`mission:${f.mission.id}`]], perform: ({ f, task, tool }) => tool('swarm_control', { taskId: task.id, action: 'amend', changes: { assigneeId: f.reviewer.id }, reason: 'Reassign' }) },
  }
  for (const [exit, { then, perform }] of Object.entries(exits)) {
    const fixture = await board()
    const { f, task, request } = fixture
    assert.ok(request.content.includes(exit), `the request names: ${exit}`)
    nextWindow(f)
    await perform(fixture)
    await quiet(f)
    assert.equal(taskOf(f.runtime, task.id).status, 'running', `${exit} lets the task run`)
    assert.deepEqual([terminalRows(f, 'attempt_lease').map(delivery => delivery.subjects), relevant(f, request), (await remind(f, request)).length], [[request.subjects, ...then.map(subjects => subjects(f))], true, 0],
      'the request stays the record the owner can read, it is not told again over the task, and nothing reminds the owner of a task that moved on')
  }
  // The resume without the repair: the chain fails again over the same work, under the same opener.
  const { f, task, request, tool } = await board()
  await tool('swarm_control', { taskId: task.id, action: 'resume', reason: 'Retry' })
  await quiet(f)
  assert.deepEqual([taskOf(f.runtime, task.id).status, terminalRows(f, 'attempt_lease').length], ['pending', 1], 'the same failure is the request the owner holds')
  assert.deepEqual((await remind(f, request)).map(delivery => delivery.subjects), [request.subjects], 'which is reminded while the task it names is stuck')
})

/**
 * The first link of one member's dispatch chain, the adapter's drain step, throws on every sweep (a session append
 * failing while the adapter wakes that member's stranded input). The member is not stepped in that sweep, and the
 * chain's guard terminal is the throw's one record. `repair` lets the drain step pass.
 */
const failingDrain = (f, member, failure) => {
  let broken = true
  f.workers.drainStrandedInbox = id => { if (broken && id === member.id) throw new Error(failure) }
  return { repair: () => { broken = false } }
}

test('every exit a failed drain step\'s request names, performed through the owner\'s registered tools: each lets the task it names run, and the request is never told twice over that work', async t => {
  /** The author's drain step throws on every sweep until `fault.repair()`; its task stays pending and the chain's request names it. */
  const board = async () => {
    const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), budget: LONG })
    t.after(f.cleanup)
    const fault = failingDrain(f, f.author, 'session append failed while waking stranded input')
    const task = f.propose({ title: 'Work for the author' })
    await quiet(f)
    assert.equal(taskOf(f.runtime, task.id).status, 'pending', 'the author is not stepped while its drain step throws')
    const [request, ...others] = terminalRows(f, 'attempt_lease')
    assert.deepEqual([others.length, request.subjects, namedTools(request.content)], [0, [subjectOf(f, task)], ['swarm_control']], 'one request, naming the work that waits')
    return { f, task, request, fault, tool: await ownerTools(f) }
  }
  // The reassignment moves the task off the failing member without repairing it: that member then fails holding no work, which is told once at the mission root.
  const exits = {
    '`action: resume` after repair': { then: [], perform: async ({ task, fault, tool }) => { fault.repair(); await tool('swarm_control', { taskId: task.id, action: 'resume', reason: 'Repaired' }) } },
    '`action: amend`, `changes.assigneeId` and `reason` to fence and reassign it': { then: [f => [`mission:${f.mission.id}`]], perform: ({ f, task, tool }) => tool('swarm_control', { taskId: task.id, action: 'amend', changes: { assigneeId: f.reviewer.id }, reason: 'Reassign' }) },
  }
  for (const [exit, { then, perform }] of Object.entries(exits)) {
    const fixture = await board()
    const { f, task, request } = fixture
    assert.ok(request.content.includes(exit), `the request names: ${exit}`)
    nextWindow(f)
    await perform(fixture)
    await quiet(f)
    assert.equal(taskOf(f.runtime, task.id).status, 'running', `${exit} lets the task run`)
    assert.deepEqual([terminalRows(f, 'attempt_lease').map(delivery => delivery.subjects), relevant(f, request), (await remind(f, request)).length], [[request.subjects, ...then.map(subjects => subjects(f))], true, 0],
      'the request stays the record the owner can read, it is not told again over the task, and nothing reminds the owner of a task that moved on')
  }
  // The resume without the repair: the drain step throws again, the task waits, under the same request.
  const { f, task, request, tool } = await board()
  await tool('swarm_control', { taskId: task.id, action: 'resume', reason: 'Retry' })
  await quiet(f)
  assert.deepEqual([taskOf(f.runtime, task.id).status, terminalRows(f, 'attempt_lease').length], ['pending', 1], 'the same failure is the request the owner holds')
  assert.deepEqual((await remind(f, request)).map(delivery => delivery.subjects), [request.subjects], 'which is reminded while the task it names waits')
})

/** The breaches the isolation invariant lists on one fixture's board, by their text. */
const violationsOf = f => isolationIssues(f.runtime.boardOf(f.mission.id)).map(issue => issue.message)

test('the isolation request is its violation\'s: keyed by the violation\'s text and naming the unfinished work of every member it lists, told once however often it refuses them; a changed violation is a second request, and only the violation the invariant lists is outstanding and reminded', async t => {
  const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), budget: LONG })
  t.after(f.cleanup)
  const worktree = (member, workspace) => f.runtime.store.transaction(() => f.runtime.store.put('members', { ...f.runtime.store.get('members', member.id), workspace }))
  // The reviewer is moved into the author's worktree, and both members hold work.
  worktree(f.reviewer, f.runtime.store.get('members', f.author.id).workspace)
  const reviewers = f.propose({ title: 'Reviewer work', assigneeId: f.reviewer.id, kind: 'research', checks: [] })
  const authors = f.propose({ title: 'Author work' })
  await quiet(f)
  const request = (violation, tasks) => [`guard-terminal:workspace:workspace_terminal:isolation:${sha16(violation)}`, `the isolation invariant refuses dispatch: ${violation}`, tasks.map(task => subjectOf(f, task)).sort()]
  const told = () => terminalRows(f, 'workspace').map(delivery => [delivery.notice.dedupKey, delivery.notice.reason, [...delivery.subjects].sort()])
  const [sharing, ...others] = violationsOf(f)
  assert.match(sharing, /share one provisioned worktree/)
  assert.deepEqual(others, [])
  const shared = request(sharing, [reviewers, authors])
  assert.deepEqual(told(), [shared], 'one request for the violation: keyed by its text, recording it as the reason, and naming the unfinished work of both members it lists')
  await ticks(f, 3)
  assert.equal(told().length, 1, 'told once, though the invariant refuses both members on every pass')
  // The violation changes: the author's worktree is lost altogether, so the reviewer shares none.
  nextWindow(f)
  worktree(f.author, '')
  await quiet(f)
  const [missing, ...rest] = violationsOf(f)
  assert.match(missing, /has no provisioned isolated worktree/)
  assert.deepEqual(rest, [], 'the invariant lists the new violation alone')
  assert.deepEqual(told(), [shared, request(missing, [authors])], 'the changed violation is a second request, keyed by its own text and naming the work of the one member it lists')
  const [first, second] = terminalRows(f, 'workspace')
  assert.deepEqual([relevant(f, first), relevant(f, second)], [false, true], 'only the violation the invariant lists is outstanding: another violation being listed keeps no other request open')
  assert.deepEqual([(await remind(f, first)).length, (await remind(f, second)).map(delivery => delivery.subjects)], [0, [second.subjects]], 'and only that one is reminded')
})

test('the isolation request is outstanding exactly while the invariant lists its violation: reminded while it does, whatever the exits it names do to the task through the owner\'s registered tools, and neither delivered nor reminded once the worktrees are repaired', async t => {
  /** The reviewer is moved into the author's worktree, and work is given to the reviewer. */
  const board = async () => {
    const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), budget: LONG })
    t.after(f.cleanup)
    const own = f.runtime.store.get('members', f.reviewer.id).workspace
    f.runtime.store.transaction(() => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), workspace: f.runtime.store.get('members', f.author.id).workspace }))
    const task = f.propose({ title: 'Reviewer work', assigneeId: f.reviewer.id, kind: 'research', checks: [] })
    await quiet(f)
    const [request] = terminalRows(f, 'workspace')
    assert.deepEqual(namedTools(request.content), ['swarm_control'])
    const repair = () => f.runtime.store.transaction(() => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), workspace: own }))
    return { f, task, request, repair, tool: await ownerTools(f) }
  }
  // The exits the request names act on the task; without the repair the violation still refuses both members.
  const unrepaired = {
    '`action: resume` and `reason`': ({ task, tool }) => tool('swarm_control', { taskId: task.id, action: 'resume', reason: 'Retry' }),
    'amend the same task\'s scope/dependencies/assignee with `action: amend` and `changes`': ({ f, task, tool }) => tool('swarm_control', { taskId: task.id, action: 'amend', changes: { assigneeId: f.author.id }, reason: 'Reassign' }),
  }
  for (const [exit, perform] of Object.entries(unrepaired)) {
    const fixture = await board()
    const { f, task, request } = fixture
    assert.ok(request.content.includes(exit), `the request names: ${exit}`)
    await perform(fixture)
    await quiet(f)
    assert.deepEqual([taskOf(f.runtime, task.id).status, violationsOf(f).length, terminalRows(f, 'workspace').length, relevant(f, request)], ['pending', 1, 1, true],
      `${exit}, without the repair, leaves the violation listed: the one request stays outstanding`)
    assert.deepEqual((await remind(f, request)).map(delivery => delivery.subjects), [request.subjects], 'and the owner is reminded of it')
  }
  // Work given later to a member the violation lists: the request names the work it saw when first told, and the dispatch
  // question names each undispatched task beside it, once (beside the request for the first: one wording of the open item R20).
  const changed = await board()
  const later = changed.f.propose({ title: 'Later work', assigneeId: changed.f.author.id, kind: 'research', checks: [] })
  await quiet(changed.f)
  await ticks(changed.f, 3)
  assert.deepEqual([taskOf(changed.f.runtime, later.id).status, violationsOf(changed.f).length, terminalRows(changed.f, 'workspace').map(delivery => [subjectOf(changed.f, changed.task), subjectOf(changed.f, later)].map(subject => delivery.subjects.includes(subject)))],
    ['pending', 1, [[true, false]]], 'the violation still refuses both members, and its one request names the work it saw when first told')
  const questions = ownerRows(changed.f).filter(delivery => noticeFamily(delivery) === 'dispatch-question')
  assert.deepEqual(questions.map(delivery => [delivery.subjects, relevant(changed.f, delivery)]), [[[subjectOf(changed.f, changed.task)], true], [[subjectOf(changed.f, later)], true]],
    'the dispatch question names the reviewer\'s task and the later work, each once, and both are outstanding')
  // "Repair the condition, then ... resume": the repair is what ends the request.
  const { f, task, request, repair, tool } = await board()
  assert.match(request.content, /Repair the condition, then use `swarm_control`/)
  repair()
  assert.deepEqual([violationsOf(f), relevant(f, request)], [[], false], 'the repaired worktrees end the request: a queued one is withheld')
  assert.deepEqual(await remind(f, request), [], 'and no reminder follows it, though the task it named is still pending')
  await tool('swarm_control', { taskId: task.id, action: 'resume', reason: 'Repaired' })
  await quiet(f)
  assert.equal(taskOf(f.runtime, task.id).status, 'running', 'the resumed task is dispatched')
})

test('work admitted after the isolation request, unassigned or given to a member it lists, is named by the dispatch question beside that request (the isolation probe)', async t => {
  for (const assigned of [false, true]) {
    const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), budget: LONG })
    t.after(f.cleanup)
    // The reviewer is moved into the author's worktree, and work is given to the reviewer: the isolation request is raised.
    f.runtime.store.transaction(() => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), workspace: f.runtime.store.get('members', f.author.id).workspace }))
    const first = f.propose({ title: 'Reviewer work', assigneeId: f.reviewer.id, kind: 'research', checks: [] })
    await quiet(f)
    const [request, ...others] = terminalRows(f, 'workspace')
    assert.deepEqual([request.subjects.includes(subjectOf(f, first)), others], [true, []], `assigned=${assigned}: the request names the work it saw when first told`)
    // Later work only the two members the violation lists could run.
    const later = f.propose({ title: 'Later work', ...(assigned ? { assigneeId: f.author.id } : {}), kind: 'research', checks: [] })
    await quiet(f)
    await ticks(f, 5)
    assert.equal(taskOf(f.runtime, later.id).status, 'pending', `assigned=${assigned}: the later work is not dispatched`)
    const namings = ownerRows(f).filter(delivery => (delivery.subjects ?? []).includes(subjectOf(f, later)) && delivery.notice.trigger !== 'owner-decision-unresolved')
    assert.deepEqual(namings.map(delivery => noticeFamily(delivery)), ['dispatch-question'], `assigned=${assigned}: the dispatch question names it, once`)
    assert.deepEqual([relevant(f, namings[0]), relevant(f, request), terminalRows(f, 'workspace').length, request.subjects.includes(subjectOf(f, later))], [true, true, 1, false], `assigned=${assigned}: outstanding, beside the one open request, which does not name it`)
  }
})

test('the fall-through names stuck work at its epoch, once, beside an open request raised for that task and beside the retirement that names it: no decision stands in for the board\'s naming', async t => {
  // Running work keeps each board from stalling, so the fall-through is the board's namer.
  const boards = {
    'an open request raised for the task': async () => {
      const f = await setup({ clock: new FakeClock(), budget: LONG })
      t.after(f.cleanup)
      await f.runtime.claim(f.actor(f.author), f.mission.id, f.propose({ title: 'Running work', kind: 'research', checks: [] }).id)
      // Work only the reviewer may take, dead once the reviewer is gone, with a request raised for it.
      const stuck = f.propose({ title: 'Reviewer-only work', kind: 'research', checks: [], assigneeId: f.reviewer.id })
      f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
      f.runtime.notices.record(f.mission.id, guardTerminalNotice(f.runtime.boardOf(f.mission.id), 'attempt_lease', { taskId: stuck.id, localKey: 'closeout-abandoned:attempt_abandoned', detail: 'idle close-out abandoned attempt attempt_abandoned and re-pended the task' }))
      await quiet(f)
      // The board digest moves: work queued behind the author's live lease.
      f.propose({ title: 'Queued work', kind: 'research', checks: [] })
      await quiet(f)
      const [decision] = terminalRows(f, 'attempt_lease')
      return { f, stuck, decision }
    },
    'the retirement of the route it is pinned to': async () => {
      const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), budget: LONG })
      t.after(f.cleanup)
      await f.runtime.claim(f.actor(f.reviewer), f.mission.id, f.propose({ title: 'Unrelated work', kind: 'research', checks: [], assigneeId: f.reviewer.id }).id)
      const start = f.workers.start.bind(f.workers)
      f.workers.start = async spec => { if (spec.member.id === f.author.id) throw Object.assign(new Error('worker start failed'), { code: 'EMFILE' }); return start(spec) }
      const stuck = f.propose({ title: 'Pinned to the author', kind: 'research', checks: [], assigneeId: f.author.id, assignmentMode: 'pinned' })
      await f.runtime.settle(f.mission.id)
      await ticks(f, 20)
      await f.runtime.settle(f.mission.id)
      assert.equal(f.runtime.store.get('members', f.author.id).phase, 'stopped', 'the author was retired after its start failures')
      const decision = ownerRows(f).find(delivery => (delivery.subjects ?? []).includes(subjectOf(f, stuck)) && /could not start after 3 consecutive failures|No live member can start/.test(delivery.content))
      return { f, stuck, decision }
    },
  }
  for (const [board, build] of Object.entries(boards)) {
    const { f, stuck, decision } = await build()
    await ticks(f, 20)
    const subject = subjectOf(f, stuck)
    assert.deepEqual([taskOf(f.runtime, stuck.id).status, decision?.subjects.includes(subject)], ['pending', true], `${board}: the decision names the pending task at its epoch`)
    if (board === 'an open request raised for the task') assert.equal(relevant(f, decision), true, `${board}: and is open`)
    const fallthroughs = ownerRows(f).filter(delivery => noticeFamily(delivery) === 'fallthrough' && delivery.subjects.includes(subject))
    assert.equal(fallthroughs.length, 1, `${board}: the fall-through names it at that epoch, once`)
    assert.equal(relevant(f, fallthroughs[0]), true, `${board}: and that naming is outstanding`)
  }
})

test('P1d: a member\'s blocked task is named by its stall root beside an open member-scoped request: a real handoff whose old owner never stops, beside the new assignee\'s failing dispatch; a dead end beside a failing dispatch; a dead end beside an isolation request', async t => {
  /** The author's dispatch chain throws on every pass: its request names all of the author's unfinished work. */
  const failDispatch = f => failingDispatch(f, f.author, () => 'worktree probe failed: EIO')
  const deadEnd = (f, assigneeId) => {
    const dead = f.propose({ title: 'Dead end', assigneeId, kind: 'research', checks: [] })
    f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', { ...taskOf(f.runtime, dead.id), status: 'blocked', epoch: taskOf(f.runtime, dead.id).epoch + 1, output: 'blocked for repair' }))
    return dead
  }
  const boards = {
    'a real handoff whose old owner never stops, beside the new assignee\'s failing dispatch': async () => {
      const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), config: { stallPassTimeoutMs: 1_000 }, budget: LONG })
      t.after(f.cleanup)
      failDispatch(f)
      const handed = f.propose({ title: 'Reviewer research', kind: 'research', checks: [], assigneeId: f.reviewer.id })
      const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, handed.id)
      // The reviewer's handle never acknowledges its stop.
      const stop = f.workers.stop.bind(f.workers)
      f.workers.stop = id => id === f.reviewer.id ? new Promise(() => {}) : stop(id)
      f.runtime.handoff(f.actor(f.reviewer), f.mission.id, { taskId: handed.id, attemptId: claimed.attempt.id, to: f.author.id, summary: 'Hand to the author' })
      f.propose({ title: 'Work for the author', kind: 'research', checks: [] })
      await ticks(f, 3)
      f.clock.advance(f.runtime.bounds.stallPassTimeoutMs + 1)
      await ticks(f, 6)
      return { f, stuck: handed, chain: 'attempt_lease' }
    },
    'a dead end beside a failing dispatch': async () => {
      const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), budget: LONG })
      t.after(f.cleanup)
      failDispatch(f)
      f.propose({ title: 'Work for the author' })
      const dead = deadEnd(f, f.author.id)
      await quiet(f)
      return { f, stuck: dead, chain: 'attempt_lease' }
    },
    'a dead end beside an isolation request': async () => {
      const f = await setup({ clock: new FakeClock(), workers: new FakeWorkers({ autoIdle: true }), budget: LONG })
      t.after(f.cleanup)
      // The reviewer is moved into the author's worktree. It holds pending work and a dead end of its own.
      f.runtime.store.transaction(() => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), workspace: f.runtime.store.get('members', f.author.id).workspace }))
      f.propose({ title: 'Reviewer work', assigneeId: f.reviewer.id, kind: 'research', checks: [] })
      const dead = deadEnd(f, f.reviewer.id)
      await quiet(f)
      return { f, stuck: dead, chain: 'workspace' }
    },
  }
  for (const [board, build] of Object.entries(boards)) {
    const { f, stuck, chain } = await build()
    const subject = subjectOf(f, stuck)
    assert.equal(taskOf(f.runtime, stuck.id).status, 'blocked', `${board}: the task is blocked`)
    const request = terminalRows(f, chain).find(delivery => delivery.subjects.includes(subject))
    assert.ok(request !== undefined && relevant(f, request), `${board}: an open request raised for the member names the blocked task at its epoch`)
    const named = ownerRows(f).filter(delivery => ['stall-root', 'board-stall', 'fallthrough'].includes(noticeFamily(delivery)) && delivery.subjects.includes(subject))
    assert.deepEqual(named.map(delivery => noticeFamily(delivery)), ['stall-root'], `${board}: the board names the blocked task beside it, once`)
    assert.equal(relevant(f, named[0]), true, `${board}: and that naming is outstanding`)
  }
})

test('a task\'s budget warning is told once per task, dimension, limit and threshold over many ticks: a lower threshold after a higher one is not warned, and the limit the owner raises is a new allocation', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const task = f.propose({ title: 'Bounded work', maxSteps: 10 })
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  const steps = used => f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', { ...taskOf(f.runtime, task.id), usedSteps: used }))
  const told = () => events(f.runtime, f.mission.id, 'mission/budget-warning').filter(event => event.data.taskId === task.id).map(event => [event.data.dimension, event.data.limit, event.data.threshold, event.data.projected])
  const rows = (limit, threshold) => ownerRows(f).filter(delivery => [delivery.notice.dedupKey, ...(delivery.notice.aggregatedIdentities ?? []).map(identity => identity.dedupKey)]
    .includes(`budget-review:${f.mission.id}:${task.id}:maxSteps:${limit}:${threshold}`)).length
  // Eight steps are settled and the author's model request is in flight: the projection crosses both thresholds.
  steps(8)
  f.workers.activity = { id: 'model', kind: 'model', startedAt: f.clock.now(), updatedAt: f.clock.now() }
  await ticks(f, 3)
  assert.deepEqual(told(), [['maxSteps', 10, 0.9, 9]], 'the higher threshold is told, once over every tick')
  assert.deepEqual([rows(10, 0.9), rows(10, 0.7)], [1, 0], 'by one row of the task, dimension, limit and threshold')
  // The request ends: the projection falls back between the thresholds.
  f.workers.activity = undefined
  await ticks(f, 3)
  assert.deepEqual(told(), [['maxSteps', 10, 0.9, 9]], 'a lower threshold after a higher one is not warned')
  assert.deepEqual([rows(10, 0.9), rows(10, 0.7)], [1, 0])
  // The owner raises the task's allocation: the same spend is under the lower threshold of the new limit until a step crosses it.
  await (await ownerTools(f))('swarm_budget', { taskId: task.id, taskBudget: { maxSteps: 12 }, reason: 'Room to finish' })
  await ticks(f, 3)
  assert.deepEqual(told(), [['maxSteps', 10, 0.9, 9]], 'eight of twelve crosses no threshold')
  steps(9)
  await ticks(f, 3)
  assert.deepEqual(told(), [['maxSteps', 10, 0.9, 9], ['maxSteps', 12, 0.7, 9]], 'the new limit has its own warning, once')
  assert.deepEqual([rows(10, 0.9), rows(12, 0.7)], [1, 1])
})

test('a budget warning is told once per allocation and threshold, by the ledger alone: a projection that falls back under a told threshold warns no lower one, the limit the owner raises with swarm_budget is a new allocation that retires the old warning, and nothing on the mission row records one', async t => {
  const f = await setup({ clock: new FakeClock(), budget: { maxTokens: 10_000 } })
  t.after(f.cleanup)
  const told = () => events(f.runtime, f.mission.id, 'mission/budget-warning').filter(event => event.data.dimension === 'maxTokens').map(event => [event.data.limit, event.data.threshold, event.data.projected])
  const reviews = () => ownerRows(f).flatMap(delivery => delivery.notice.aggregatedIdentities ?? []).map(identity => identity.dedupKey).filter(key => key.includes(':mission:maxTokens:'))
  // The author settled 2000 tokens in one request and 7500 are spent; a second model request is in flight, estimated at 2000 more.
  const author = f.runtime.store.get('members', f.author.id), mission = f.runtime.mission(f.mission.id)
  f.runtime.commit(f.mission.id, () => { f.runtime.store.put('members', { ...author, accountedTokens: 2000, usage: { requests: 1 } }); f.runtime.store.put('missions', { ...mission, usedTokens: 7500 }) })
  f.workers.activity = { id: 'model', kind: 'model', startedAt: f.clock.now(), updatedAt: f.clock.now() }
  await ticks(f, 2)
  assert.deepEqual(told(), [[10_000, 0.9, 9500]], 'the projection crossed both thresholds: the owner is told the higher one, once')
  // The request ends without further usage: the projection falls back between the thresholds.
  f.workers.activity = undefined
  await ticks(f, 2)
  assert.deepEqual(told(), [[10_000, 0.9, 9500]], 'a lower threshold after a higher one is not warned')
  assert.deepEqual(reviews(), [`budget-review:${f.mission.id}:mission:maxTokens:10000:0.9`], 'the ledger row is the warning\'s one record')
  assert.equal(Object.hasOwn(f.runtime.store.get('missions', f.mission.id), 'budgetWarned'), false, 'nothing on the mission row records it')
  // The owner takes the exit the warning names: the same spend crosses the lower threshold of a new allocation.
  const warnings = () => ownerRows(f).filter(delivery => delivery.notice.trigger === 'mission/budget-warning')
  const [warned] = warnings()
  assert.deepEqual([namedTools(warned.content), relevant(f, warned)], [['swarm_budget'], true])
  await (await ownerTools(f))('swarm_budget', { budget: { ...f.runtime.mission(f.mission.id).budget, maxTokens: 10_500 }, reason: 'A little more room' })
  await ticks(f, 2)
  assert.deepEqual(told(), [[10_000, 0.9, 9500], [10_500, 0.7, 7500]], 'a changed limit has its own warning')
  assert.deepEqual(warnings().map(delivery => relevant(f, delivery)), [false, true], 'and the warning of the allocation the owner replaced is no longer outstanding')
  assert.equal(Object.hasOwn(f.runtime.store.get('missions', f.mission.id), 'budgetWarned'), false)
})
