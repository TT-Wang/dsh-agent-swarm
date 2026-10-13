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
import { FakeClock, FakeWorkers, MISSION_ACCEPTANCE, acceptThroughReview, blockThroughReview, events, setup, taskOf } from './faults/harness.mjs'
import { ownerTools } from './refusal-inventory.mjs'
import { noticeFamily, noticeTemplateKey } from '../lib/notices.js'

const ownerRows = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice !== undefined)
const stallRow = f => ownerRows(f).find(delivery => delivery.notice.trigger === 'mission/stalled' && delivery.content.startsWith('Mission stalled'))
const coverageRow = f => ownerRows(f).find(delivery => /is ready to complete/.test(delivery.content))
/** The W3 stall's own events: the board classifier's `mission/stalled`, which carries no cause. */
const boardStallEvents = f => events(f.runtime, f.mission.id, 'mission/stalled').filter(event => event.data.cause === undefined)
const ticks = async (f, count) => { for (let tick = 0; tick < count; tick += 1) { f.clock.advance(f.runtime.config.tickMs); await f.runtime.tick() } }
/** A board stalled on work only the reviewer may take, dead once the reviewer is gone: its one stuck subject. */
const deadAssigneeBoard = async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const dead = f.propose({ title: 'Reviewer-only work', kind: 'research', checks: [], assigneeId: f.reviewer.id })
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
  await f.runtime.settle(f.mission.id)
  await ticks(f, 1)
  return { f, dead }
}
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
  const pass = { id: scheduling.passKey(f.mission.id), operationId: 'operation_ledger_completed', missionId: f.mission.id, startedAt: clock.now() - f.runtime.stallPassReleaseBoundMs,
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
  assert.equal(stallRow(f), undefined, 'and nothing restates it')
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
        f.runtime.notices.ensureWitness(f.mission.id, { offPass: true, wedged: true })
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
  const { f, dead } = await deadAssigneeBoard(t)
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
  // An unreviewable submission joins the unfinished work: the same stuck work under a new diagnostic.
  const source = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  await f.runtime.settle(f.mission.id)
  await ticks(f, 150)
  const [, , diagnosed] = stalls()
  assert.deepEqual(diagnosed?.subjects, fenced.subjects, 'the same stuck work')
  assert.notEqual(diagnosed.notice.reason, fenced.notice.reason, 'under a new diagnostic is a new stall')
  assert.deepEqual([relevant(f, fenced), relevant(f, diagnosed)], [false, true])
  assert.deepEqual(boardStallEvents(f).map(event => event.data.noticeKey), stalls().map(delivery => delivery.notice.dedupKey), 'each stall has its one event')

  const c = await setup({ clock: new FakeClock() })
  t.after(c.cleanup)
  await acceptThroughReview(c, c.propose())
  await c.runtime.settle(c.mission.id)
  await ticks(c, 1)
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

test('every exit a W3 stall and a coverage-complete decision name, performed through the owner\'s registered tools, retires that decision', async t => {
  const toolsNamed = text => [...new Set(text.match(/\bswarm_\w+/g))].sort()
  const proposal = f => ({ workstreamId: f.stream.id, title: 'More work', objective: 'Do the work the decision asks for', kind: 'research', scope: ['**'], outputs: [], acceptance: MISSION_ACCEPTANCE, checks: [] })
  // The stall names the stuck work's amendment, a repair, a withdrawal and the mission stop (and a budget change, which names no tool).
  const stallExits = {
    'amend the existing task dependencies or assignee with swarm_control': ({ f, dead, tool }) => tool('swarm_control', { taskId: dead.id, action: 'amend', changes: { assigneeId: f.author.id }, reason: 'Reassign to a live member' }),
    'admit a repair or review with swarm_propose': ({ f, tool }) => tool('swarm_propose', proposal(f)),
    'withdraw it explicitly with swarm_cancel': ({ dead, tool }) => tool('swarm_cancel', { taskId: dead.id, reason: 'No longer required' }),
    'Use swarm_control stop': ({ tool }) => tool('swarm_control', { action: 'stop', reason: 'Stop the mission' }),
  }
  for (const [exit, perform] of Object.entries(stallExits)) {
    const { f, dead } = await deadAssigneeBoard(t)
    const stall = ownerRows(f).find(delivery => noticeFamily(delivery) === 'board-stall')
    assert.deepEqual(toolsNamed(stall.content), ['swarm_cancel', 'swarm_control', 'swarm_propose'], 'the stall names these tools')
    assert.ok(stall.content.includes(exit), `the stall names: ${exit}`)
    assert.equal(relevant(f, stall), true)
    await perform({ f, dead, tool: await ownerTools(f) })
    assert.equal(relevant(f, stall), false, `${exit} retires the stall`)
  }
  const coverageExits = {
    'Use swarm_control complete': ({ tool }) => tool('swarm_control', { action: 'complete', reason: 'The deliverable is accepted' }),
    'admit more work with swarm_propose': ({ f, tool }) => tool('swarm_propose', proposal(f)),
  }
  for (const [exit, perform] of Object.entries(coverageExits)) {
    const f = await setup({ clock: new FakeClock() })
    t.after(f.cleanup)
    await acceptThroughReview(f, f.propose())
    await f.runtime.settle(f.mission.id)
    await ticks(f, 1)
    const coverage = coverageRow(f)
    assert.deepEqual(toolsNamed(coverage.content), ['swarm_control', 'swarm_propose'], 'coverage-complete names these tools')
    assert.ok(coverage.content.includes(exit), `coverage-complete names: ${exit}`)
    assert.equal(relevant(f, coverage), true)
    await perform({ f, tool: await ownerTools(f) })
    assert.equal(relevant(f, coverage), false, `${exit} retires coverage-complete`)
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
    f.runtime.notices.ensureWitness(f.mission.id, { offPass: true, wedged: true })
    await f.runtime.settle(f.mission.id)
    await ticks(f, 3)
    assert.equal(stallRow(f), undefined, `automatic=${automatic}: a board with nothing left to do is not a stall`)
    assert.equal(ownerRows(f).filter(delivery => /is ready to complete/.test(delivery.content)).length, automatic ? 0 : 1, `automatic=${automatic}: only an owner-assembled mission is told it may complete, once`)
    assert.equal(f.runtime.mission(f.mission.id).status, automatic ? 'completed' : 'active')
  }
})

test('an unreviewable submission is the review admission\'s decision alone: the board classifier adds no W3 stall, even for a review of it no live member can take', async t => {
  for (const review of [false, true]) {
    const f = await setup({ clock: new FakeClock() })
    t.after(f.cleanup)
    const task = f.propose()
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    // The only independent member was to review it; once it is gone, that review is dead too.
    if (review) f.propose({ title: 'Review', kind: 'verification', reviewOf: task.id, checks: [], assigneeId: f.reviewer.id })
    f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
    await f.runtime.settle(f.mission.id)
    await ticks(f, 150)
    const decisions = ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`review-blocked:${f.mission.id}:${task.id}:`))
    assert.equal(decisions.length, 1, `review=${review}: the admission named the blocker once`)
    assert.match(decisions[0].content, /no live member other than the author/)
    assert.equal(stallRow(f), undefined, `review=${review}: no W3 stall restates it`)
    assert.deepEqual(boardStallEvents(f), [])
  }
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
  assert.equal(f.runtime.interpretation(f.mission.id).stalled, true, 'the board is stalled on the submission and its dead review')
  const told = ownerRows(f).filter(delivery => !before.includes(delivery.id))
  assert.deepEqual(told.map(delivery => noticeFamily(delivery)), ['review-blocked'], 'the owner is told once, by the admission')
  assert.deepEqual(told[0].subjects, [`${source.id}@${taskOf(f.runtime, source.id).epoch}`])
  assert.match(told[0].content, new RegExp(`the automatically admitted review ${review.id} is blocked and cannot reach a verdict: admit a review with swarm_propose\\(.*\\), or withdraw the source with swarm_cancel\\(taskId, reason\\)$`))
  assert.equal(relevant(f, told[0]), true, 'and the decision is outstanding')
  assert.deepEqual(boardStallEvents(f), [], 'no W3 stall restates it')
})

test('the review admission speaks only for its own source: other stuck work beside an unreviewable submission is named while that decision is open', async t => {
  /** A board whose only independent member is gone, with the author's submission unreviewable. */
  const board = async () => {
    const f = await setup({ clock: new FakeClock() })
    t.after(f.cleanup)
    f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' }))
    const source = f.propose()
    return { f, source, submit: async () => {
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
      await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    } }
  }
  const namings = (f, task) => ownerRows(f).filter(delivery => (delivery.subjects ?? []).includes(`${task.id}@${taskOf(f.runtime, task.id).epoch}`))
  const sourceDecisions = (f, source) => ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith(`review-blocked:${f.mission.id}:${source.id}:`))

  // A stalled board: the W3 stall names the work withdrawn prerequisites left dead, not the source.
  const stalled = await board()
  const withdrawn = stalled.f.propose({ title: 'Prerequisite', kind: 'research', checks: [] })
  const dead = stalled.f.propose({ title: 'Dependent', kind: 'research', checks: [], dependencies: [withdrawn.id] })
  await stalled.submit()
  stalled.f.runtime.cancel(stalled.f.owner, stalled.f.mission.id, { taskId: withdrawn.id, reason: 'Not needed' })
  await stalled.f.runtime.settle(stalled.f.mission.id)
  await ticks(stalled.f, 150)
  assert.equal(sourceDecisions(stalled.f, stalled.source).length, 1, 'the admission named the source')
  const stall = namings(stalled.f, dead).find(delivery => noticeFamily(delivery) === 'board-stall')
  assert.ok(stall, 'the stalled board names the dead work while the source\'s decision is open')
  assert.deepEqual(stall.subjects, [`${dead.id}@${taskOf(stalled.f.runtime, dead.id).epoch}`], 'and leaves the source to its admission')
  assert.equal(relevant(stalled.f, stall), true, 'the stall is outstanding')

  // Beside unrelated running work the board is not stalled: the fall-through
  // names the work only the reviewer could take, dead once the reviewer is gone.
  const running = await setup({ clock: new FakeClock() })
  t.after(running.cleanup)
  const dependent = running.propose({ title: 'Reviewer-only work', kind: 'research', checks: [], assigneeId: running.reviewer.id })
  const source = running.propose()
  const claimed = await running.runtime.claim(running.actor(running.author), running.mission.id, source.id)
  await running.runtime.submit(running.actor(running.author), running.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const unrelated = running.propose({ title: 'Unrelated work', kind: 'research', checks: [] })
  await running.runtime.claim(running.actor(running.author), running.mission.id, unrelated.id)
  running.runtime.commit(running.mission.id, () => running.runtime.store.put('members', { ...running.runtime.store.get('members', running.reviewer.id), phase: 'stopped' }))
  await running.runtime.settle(running.mission.id)
  await ticks(running, 150)
  assert.equal(sourceDecisions(running, source).length, 1, 'the admission named the source beside the running work')
  const fallthrough = namings(running, dependent).find(delivery => noticeFamily(delivery) === 'fallthrough')
  assert.ok(fallthrough, 'the dead work is named behind the running work while the source\'s decision is open')
  assert.deepEqual(fallthrough.subjects, [`${dependent.id}@${taskOf(running.runtime, dependent.id).epoch}`], 'and the naming leaves the source to its admission')
  assert.equal(relevant(running, fallthrough), true, 'the naming is outstanding')
  // A later board change is judged again, and the source stays the admission's alone.
  running.propose({ title: 'Follow-up', kind: 'research', checks: [], dependencies: [unrelated.id] })
  await running.runtime.settle(running.mission.id)
  assert.deepEqual(ownerRows(running).filter(delivery => noticeFamily(delivery) !== 'review-blocked' && (delivery.subjects ?? []).some(subject => subject.startsWith(`${source.id}@`))).map(delivery => delivery.content), [], 'no other naming restates the source')
})

test('the W3 stall states one stuck set: its subjects, its body, its count and its event all leave out the review admission\'s tasks', async t => {
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
  assert.deepEqual(f.runtime.interpretation(f.mission.id).unschedulable.map(task => task.id).sort(), [review.id, dead.id].sort(), 'the dispatcher counts the dead review and the dead dependent')
  const stall = ownerRows(f).find(delivery => noticeFamily(delivery) === 'board-stall')
  assert.ok(stall, 'the stalled board told the owner')
  assert.deepEqual(stall.subjects, [`${dead.id}@${taskOf(f.runtime, dead.id).epoch}`], 'the stall names the stuck work the admission does not speak for')
  assert.deepEqual(stall.notice.statement, { family: 'board-stall', counts: { unschedulable: 1 } }, 'its count is that set\'s')
  assert.match(stall.content, new RegExp(`Unschedulable: ${dead.id} \\(research, pending, depends on ${withdrawn.id}\\)\\. Subjects: `), 'its body lists that set alone')
  for (const task of [source, review]) assert.ok(!stall.content.split('Unschedulable: ')[1].includes(task.id), `the body restates nothing of the review path (${task.title})`)
  assert.deepEqual(boardStallEvents(f).map(event => [event.data.noticeKey, event.data.unschedulable]), [[stall.notice.dedupKey, [dead.id]]], 'and its event records that set')
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
  await stalled.runtime.flushOutbox(stalled.mission.id)
  const stallReminder = ordinal => ownerRows(stalled).find(delivery => delivery.notice.dedupKey === `obligation-followup:${stall.id}:${ordinal}`)
  stalled.clock.advance(stalled.runtime.notices.obligationFollowupMs)
  stalled.runtime.notices.absenceNet(stalled.mission.id)
  assert.ok(stallReminder(1), 'the delivered stall is reminded while the board stays stalled')
  stalled.propose({ title: 'Ready work' })
  assert.equal(relevant(stalled, stall), false, 'ready work ends the stall, so the queued decision is withheld')
  stalled.clock.advance(stalled.runtime.notices.obligationFollowupMs)
  stalled.runtime.notices.absenceNet(stalled.mission.id)
  assert.equal(stallReminder(2), undefined, 'and its reminders end with it')

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
  await stalled.runtime.flushOutbox(stalled.mission.id)
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

  const covered = await setup({ clock: new FakeClock() })
  t.after(covered.cleanup)
  await acceptThroughReview(covered, covered.propose())
  await covered.runtime.settle(covered.mission.id)
  await ticks(covered, 1)
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
  f.runtime.notices.ensureWitness(f.mission.id, { offPass: true, wedged: true })
  await ticks(f, 1)
  assert.match(f.runtime.store.list('tasks', f.mission.id).find(row => row.reviewOf === task.id)?.id ?? 'none', /^task_auto_review_/, 'the admission admitted the host review')
  assert.deepEqual(ownerRows(f).filter(delivery => delivery.notice.dedupKey.startsWith('review-blocked:')).map(delivery => delivery.content), [], 'no owner decision raced it')
})
