/**
 * S3: a decision reads the board where it decides. A board is one mission's
 * rows read at one instant (`readBoard`, src/board.ts), so a decision after an
 * await reads a new board, and the adapter view a board carries asks the
 * adapter at every ask:
 *
 *  - dispatch and claim build the board again after `prepareTask`: a commit
 *    made outside the mission queue during the preparation (here a challenge of
 *    the prerequisite's claim) changes a row other than the task's own, and the
 *    fresh-row check reads it (the kept interleaving of scheduler-snapshot S1);
 *  - both ask one fresh-row rule (`stillChosen`): a change of the chosen row's
 *    epoch or of any field of its assignment during the preparation drops the
 *    sweep's choice and refuses the claim, though the row is still ready;
 *  - dispatch alone also decides the isolation invariant again on the board
 *    the preparation left: a worktree shared during the await is refused and
 *    recorded there (S7's decide, record, skip), never assigned into;
 *  - the dispatch sweep asserts the admission before it prepares anything
 *    (`RefusalRegistry.assertAdmission`): a refused admission is recorded and no
 *    workspace is prepared for the work it refused;
 *  - the assignment asserts the admission again: a stop the member came to owe
 *    during a claim's preparation refuses it. The dispatch sweep decides its
 *    choice again with the predicate that chose it (`eligible`), so a stop the
 *    member came to owe during the sweep's preparation (an owner resume that
 *    fences its attempt elsewhere) leaves the work pending while the stop is
 *    owed, with no preparation failure and no owner notice, also when the
 *    preparation throws, and the sweep after the stop dispatches it;
 *  - one board asks the adapter about one member twice and gets two answers:
 *    the view is called through and never memoized, because a handle's answer
 *    changes as its turns start and end;
 *  - a stranded inbox (R15-A5: input an idle handle holds that no driver will
 *    claim) is woken by the adapter's drain step, which the dispatch sweep runs
 *    once before it decides anything, never by a question. A preferred member
 *    stranded before the sweep is busy at every ask of it, so the borrower
 *    takes its work in the same pass; one whose turn ends stranded during the
 *    sweep is startable, so it keeps its work and the assignment wakes its
 *    input. Either way the owner is asked no dispatch question (the case S11
 *    found, when an ask drained the inbox). A member that owes a stop, like a
 *    parked one, is never drained. The drain step covers the board's
 *    members, not the body's order: a chained body whose order leaves out a
 *    preferred member stranded since the previous body still drains it, so its
 *    borrower takes the work in that body. The drain step is the sweep's
 *    first adapter call, so the sweep's guard comes before it: a pause that
 *    lands while lease recovery awaits a capture wakes nothing of the paused
 *    mission, whose stranded input the first sweep after the resume wakes.
 *    Each drain is the first link of its member's chain (Round 14): one that
 *    throws ends that chain with its guard terminal, so that member is not
 *    stepped and the work held for it waits, and the sweep goes on.
 *
 * A notice that reads only rows reads the board and asks the adapter nothing:
 * tests/notice-board-reads.test.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolationViolation, ready } from '../lib/board.js'
import { FakeClock, FakeWorkers, events, setup, taskOf } from './faults/harness.mjs'

const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve: value => resolve(value) } }

/**
 * A runtime on the fake clock with a pending task bound to the author that
 * depends on an accepted source with one verified claim, and an adapter whose
 * preparation waits on `gate` once it reports `entered`.
 */
async function fixture(t) {
  const f = await setup({ clock: new FakeClock() })
  t.after(() => f.cleanup())
  const proposed = f.propose({ title: 'Accepted source' })
  f.runtime.commit(f.mission.id, () => {
    f.runtime.store.put('tasks', { ...taskOf(f.runtime, proposed.id), status: 'accepted', artifact: { ...f.workers.artifact }, evidenceIds: ['e-source'] })
    f.runtime.store.put('evidence', { id: 'e-source', missionId: f.mission.id, taskId: proposed.id, workstreamId: f.stream.id, authorId: f.author.id,
      claim: 'the source works', outcome: 'supported', status: 'verified', toolRunIds: [], supersedes: [], challenges: [], createdAt: f.clock.now() })
  })
  const dependent = f.propose({ title: 'Dependent', dependencies: [proposed.id] })
  await f.runtime.settle(f.mission.id)
  const entered = deferred(), gate = deferred()
  const prepare = f.workers.prepareTask.bind(f.workers)
  f.workers.prepareTask = async (...args) => { entered.resolve(); await gate.promise; return prepare(...args) }
  /** The owner disputes the source's claim: the source leaves `accepted`, and the pending dependent's own row is untouched. */
  const challenge = () => {
    const before = taskOf(f.runtime, dependent.id)
    f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'e-source', reason: 'a counterexample', toolRunIds: [] })
    assert.equal(taskOf(f.runtime, proposed.id).status, 'submitted', 'the challenge re-opened the source')
    assert.deepEqual(taskOf(f.runtime, dependent.id), before, 'only the board around the dependent changed, not its own row')
  }
  return { ...f, dependent, entered, gate, challenge }
}

/**
 * Earlier work, ranked below the dependent, blocked while it still holds the
 * author's attempt, and a stop barrier the adapter holds at its stop until
 * `stopped` resolves. `resume` is the owner's resume of that work, which
 * fences the attempt: the author owes its stop until the barrier completes.
 * `swept` resolves when the next pass closes.
 */
async function owedStop(f) {
  const earlier = f.propose({ title: 'Earlier work', priority: 10 })
  await f.runtime.settle(f.mission.id)
  f.runtime.commit(f.mission.id, () => {
    const row = taskOf(f.runtime, earlier.id)
    f.runtime.store.put('tasks', { ...row, status: 'blocked', epoch: row.epoch + 1, attempt: { id: 'attempt-held', epoch: row.epoch + 1, ownerId: f.author.id, leaseUntil: f.clock.now() + 60_000 } })
  })
  const stopped = deferred(), swept = deferred()
  const stop = f.workers.stop.bind(f.workers)
  f.workers.stop = async id => { await stopped.promise; return stop(id) }
  const closePass = f.runtime.scheduling.closePass.bind(f.runtime.scheduling)
  f.runtime.scheduling.closePass = (missionId, pass) => { closePass(missionId, pass); swept.resolve() }
  const resume = () => {
    f.runtime.controlTask(f.owner, f.mission.id, earlier.id, 'resume', {}, 'condition repaired')
    assert.equal(taskOf(f.runtime, earlier.id).resumeAfterStop?.memberId, f.author.id, 'the resume fenced the author\'s attempt, so the author owes its stop')
  }
  return { earlier, stopped, swept, resume }
}

const notices = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.notice !== undefined)

test('dispatch reads the board again after preparing: a prerequisite challenged during the preparation is not assigned', async t => {
  const f = await fixture(t)
  f.workers.idle.add(f.author.id)
  f.runtime.kick(f.mission.id)
  await f.entered.promise
  f.challenge()
  f.gate.resolve()
  await f.runtime.settle(f.mission.id)
  const row = taskOf(f.runtime, f.dependent.id)
  assert.deepEqual([row.status, row.attempt, row.epoch], ['pending', undefined, f.dependent.epoch], 'the dispatcher did not assign work whose prerequisite is no longer accepted')
})

test('dispatch decides isolation again after preparing: a worktree lost during the preparation is refused and recorded, not assigned', async t => {
  const f = await fixture(t)
  f.workers.idle.add(f.author.id)
  f.runtime.kick(f.mission.id)
  await f.entered.promise
  // Isolation is lost while the author's task is prepared: a commit outside
  // the mission queue drops the author's provisioned worktree. The author's
  // check before its start passed on the board before this, and the violation
  // lists the author alone, so no later member's check can record it instead.
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.author.id), workspace: '' }))
  f.gate.resolve()
  await f.runtime.settle(f.mission.id)
  const row = taskOf(f.runtime, f.dependent.id)
  assert.deepEqual([row.status, row.attempt, row.epoch], ['pending', undefined, f.dependent.epoch], 'the dispatcher did not assign work to a member without an isolated worktree')
  const violation = isolationViolation(f.runtime.boardOf(f.mission.id), f.author)
  assert.deepEqual(violation?.memberIds, [f.author.id], 'the board lists the author alone')
  const refusals = f.runtime.store.list('deliveries', f.mission.id)
    .filter(delivery => /^guard-terminal:workspace:workspace_terminal:isolation:[0-9a-f]{16}$/.test(delivery.notice?.dedupKey ?? ''))
  assert.deepEqual(refusals.map(delivery => delivery.notice.reason), [`the isolation invariant refuses dispatch: ${violation.message}`],
    'the refusal is recorded once, by the decision after the preparation, naming the violation its await left')
})

test('claim reads the board again after preparing: a prerequisite challenged during the preparation refuses the claim', async t => {
  const f = await fixture(t)
  const claim = f.runtime.claim(f.actor(f.author), f.mission.id, f.dependent.id)
  await f.entered.promise
  f.challenge()
  f.gate.resolve()
  await assert.rejects(claim, error => error.code === 'task_changed_during_preparation', 'the claim is refused by the board read after the await')
  const row = taskOf(f.runtime, f.dependent.id)
  assert.deepEqual([row.status, row.attempt, row.epoch], ['pending', undefined, f.dependent.epoch])
})

test('dispatch and claim ask one fresh-row rule after preparing: a changed epoch or assignment field drops the sweep\'s choice and refuses the claim, though the row is still ready', async t => {
  // Each change is committed outside the mission queue during the preparation
  // and leaves the dependent pending and ready for the author, its assignee,
  // so only the fresh-row rule (`stillChosen`) can see it.
  const changes = {
    epoch: row => ({ epoch: row.epoch + 1 }),
    assigneeId: () => ({ assigneeId: undefined }),
    plannedAssigneeId: (_row, f) => ({ plannedAssigneeId: f.reviewer.id }),
    assignmentMode: row => ({ assignmentMode: row.assignmentMode === 'preferred' ? 'pinned' : 'preferred' }),
  }
  for (const [field, change] of Object.entries(changes)) {
    const changeDuringPreparation = f => {
      f.runtime.commit(f.mission.id, () => { const row = taskOf(f.runtime, f.dependent.id); f.runtime.store.put('tasks', { ...row, ...change(row, f) }) })
      const changed = taskOf(f.runtime, f.dependent.id)
      assert.notEqual(changed[field], f.dependent[field], `the commit changed ${field}`)
      assert.ok(ready(f.runtime.boardOf(f.mission.id), changed, f.author), `the changed ${field} leaves the dependent ready for the author`)
      return changed
    }
    const swept = await fixture(t)
    swept.workers.idle.add(swept.author.id)
    swept.runtime.kick(swept.mission.id)
    await swept.entered.promise
    const changed = changeDuringPreparation(swept)
    swept.gate.resolve()
    await swept.runtime.settle(swept.mission.id)
    const claimed = () => events(swept.runtime, swept.mission.id, 'task/claimed').filter(event => event.data.taskId === swept.dependent.id).length
    const row = taskOf(swept.runtime, swept.dependent.id)
    assert.deepEqual([row.status, row.attempt, claimed()], ['pending', undefined, 0], `a changed ${field} drops the sweep's choice: nothing is assigned on the preparation of the row it chose`)
    swept.runtime.kick(swept.mission.id)
    await swept.runtime.settle(swept.mission.id)
    const dispatched = taskOf(swept.runtime, swept.dependent.id)
    assert.deepEqual([dispatched.status, dispatched.epoch, claimed(), swept.workers.prepared.filter(prepared => prepared.taskId === swept.dependent.id).map(prepared => prepared.epoch)],
      ['running', changed.epoch + 1, 1, [swept.dependent.epoch + 1, changed.epoch + 1]], `the next sweep prepares the row with the changed ${field} and assigns it`)
    const asked = await fixture(t)
    const claim = asked.runtime.claim(asked.actor(asked.author), asked.mission.id, asked.dependent.id)
    await asked.entered.promise
    changeDuringPreparation(asked)
    asked.gate.resolve()
    await assert.rejects(claim, error => error.code === 'task_changed_during_preparation', `a changed ${field} refuses the claim`)
  }
})

test('dispatch asserts admission before preparing: a refused admission is recorded and no workspace is prepared for it', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(() => f.cleanup())
  // A third member holds the one running lease a scope limit on '**' admits.
  const holder = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Holder', role: 'implementation', maxOutputTokens: 5_000 })
  await f.runtime.settle(f.mission.id)
  const held = f.propose({ title: 'Held', assigneeId: holder.id })
  await f.runtime.claim(f.actor(holder), f.mission.id, held.id)
  f.runtime.setAdmissionLimit(f.owner, f.mission.id, { level: 'scope', key: '**', limit: 1 }, 'one running lease')
  const waiting = f.propose({ title: 'Waiting' })
  await f.runtime.settle(f.mission.id)
  f.workers.idle.add(f.author.id)
  f.runtime.kick(f.mission.id)
  await f.runtime.settle(f.mission.id)
  const refusals = f.runtime.admissionLedger(f.owner, f.mission.id, { reason: 'queue_full' })
  assert.deepEqual(refusals.map(row => [row.taskId, row.memberId, row.level, row.key]), [[waiting.id, f.author.id, 'scope', '**']], 'the sweep recorded the refused admission')
  assert.deepEqual(f.workers.prepared.filter(row => row.taskId === waiting.id), [], 'and prepared no workspace for the work it refused')
  const row = taskOf(f.runtime, waiting.id)
  assert.deepEqual([row.status, row.attempt, row.epoch], ['pending', undefined, waiting.epoch], 'the refused task stays pending')
})

test('the assignment asserts admission again after preparing: a stop the member came to owe during the preparation refuses the claim', async t => {
  const f = await fixture(t)
  const earlier = f.propose({ title: 'Earlier work' })
  await f.runtime.settle(f.mission.id)
  const claim = f.runtime.claim(f.actor(f.author), f.mission.id, f.dependent.id)
  await f.entered.promise
  // A commit outside the mission queue records, during the preparation, a stop
  // the author owes on other work, as a fence of its attempt there writes it.
  // The claim's own check before its preparation passed, and the fresh-row
  // check after it reads only the dependent and its readiness, so the
  // admission the assignment asserts again is the only check that sees it.
  f.runtime.commit(f.mission.id, () => {
    const row = taskOf(f.runtime, earlier.id)
    f.runtime.store.put('tasks', { ...row, status: 'blocked', resumeAfterStop: { epoch: row.epoch, memberId: f.author.id, reason: 'handoff', at: f.clock.now() } })
  })
  f.gate.resolve()
  await assert.rejects(claim, /^Error: Worker is waiting for its previous attempt to stop$/, 'the assignment refuses a member that owes a stop')
  const row = taskOf(f.runtime, f.dependent.id)
  assert.deepEqual([row.status, row.attempt, row.epoch], ['pending', undefined, f.dependent.epoch], 'no attempt was assigned')
  assert.deepEqual(f.runtime.store.events(f.mission.id, 5_000).filter(event => event.type === 'task/claimed'), [], 'nothing was claimed')
})

test('the dispatch sweep decides its choice again after preparing: a stop an owner resume makes the member owe during the preparation leaves the work pending with no owner notice, and the sweep after the stop dispatches it', async t => {
  const f = await fixture(t)
  const owed = await owedStop(f)
  const told = new Set(notices(f).map(delivery => delivery.id))
  const ofDependent = type => events(f.runtime, f.mission.id, type).filter(event => event.data.taskId === f.dependent.id)
  f.workers.idle.add(f.author.id)
  f.runtime.kick(f.mission.id)
  await f.entered.promise
  owed.resume()
  f.gate.resolve()
  await owed.swept.promise
  // The sweep is over and the author still owes its stop.
  const waiting = taskOf(f.runtime, f.dependent.id)
  assert.deepEqual([waiting.status, waiting.attempt, waiting.epoch, waiting.preparationFailure], ['pending', undefined, f.dependent.epoch, undefined],
    'the work stays pending at its epoch, with no preparation failure')
  assert.deepEqual([...ofDependent('task/preparation-failed'), ...ofDependent('task/blocked'), ...ofDependent('mission/stalled')], [], 'nothing failed, blocked or stalled it')
  assert.deepEqual(notices(f).filter(delivery => !told.has(delivery.id)), [], 'and the owner is told nothing: the stop ends the wait by itself')
  owed.stopped.resolve()
  await f.runtime.settle(f.mission.id)
  assert.equal(taskOf(f.runtime, owed.earlier.id).resumeAfterStop, undefined, 'the stop completed')
  const dispatched = taskOf(f.runtime, f.dependent.id)
  assert.deepEqual([dispatched.status, dispatched.attempt?.ownerId, dispatched.epoch, dispatched.preparationFailure, ofDependent('task/claimed').length], ['running', f.author.id, f.dependent.epoch + 1, undefined, 1],
    'the sweep after the stop dispatched the dependent to the author once')
  assert.deepEqual([...ofDependent('task/preparation-failed'), ...ofDependent('task/blocked')], [], 'and its preparation never failed')
})

test('a preparation that throws after the member came to owe a stop during it records no failure: the work stays pending, and the sweep after the stop prepares it again', async t => {
  const f = await fixture(t)
  const owed = await owedStop(f)
  // The first preparation fails deterministically once its gate opens.
  let fault = new Error('deterministic preparation fault')
  const gated = f.workers.prepareTask
  f.workers.prepareTask = async (...args) => { await gated(...args); if (fault !== undefined) { const thrown = fault; fault = undefined; throw thrown } }
  const told = new Set(notices(f).map(delivery => delivery.id))
  const ofDependent = type => events(f.runtime, f.mission.id, type).filter(event => event.data.taskId === f.dependent.id)
  const preparations = () => f.workers.prepared.filter(row => row.taskId === f.dependent.id).length
  f.workers.idle.add(f.author.id)
  f.runtime.kick(f.mission.id)
  await f.entered.promise
  owed.resume()
  f.gate.resolve()
  await owed.swept.promise
  assert.equal(fault, undefined, 'the preparation threw')
  const waiting = taskOf(f.runtime, f.dependent.id)
  assert.deepEqual([waiting.status, waiting.attempt, waiting.epoch, waiting.preparationFailure], ['pending', undefined, f.dependent.epoch, undefined],
    'the choice no longer stood, so its failure is not the task\'s: the work stays pending at its epoch')
  assert.deepEqual([...ofDependent('task/preparation-failed'), ...ofDependent('task/blocked')], [], 'no failure or block was recorded')
  assert.deepEqual(notices(f).filter(delivery => !told.has(delivery.id)), [], 'and the owner is told nothing')
  owed.stopped.resolve()
  await f.runtime.settle(f.mission.id)
  const dispatched = taskOf(f.runtime, f.dependent.id)
  assert.deepEqual([dispatched.status, dispatched.attempt?.ownerId, dispatched.epoch, dispatched.preparationFailure, preparations()], ['running', f.author.id, f.dependent.epoch + 1, undefined, 2],
    'the sweep after the stop prepared the work again and dispatched it')
})

test('a board asks the adapter at every ask: two asks about one member on one board reach the adapter twice', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(() => f.cleanup())
  const first = f.propose({ title: 'First', assignmentMode: 'preferred' })
  const second = f.propose({ title: 'Second', assignmentMode: 'preferred' })
  await f.runtime.settle(f.mission.id)
  // The author's handle ends its turn between the two asks: busy, then idle.
  const answers = [false, true], asked = []
  f.workers.isIdle = memberId => { asked.push(memberId); return memberId === f.author.id ? answers.shift() : false }
  const board = f.runtime.boardOf(f.mission.id)
  const reviewer = board.members.find(member => member.id === f.reviewer.id)
  const [one, two] = [first, second].map(task => board.tasks.find(row => row.id === task.id))
  assert.deepEqual([ready(board, one, reviewer), ready(board, two, reviewer)], [true, false],
    'the reviewer may borrow work while its preferred member is busy, and not once that member is idle')
  assert.deepEqual(asked, [f.author.id, f.author.id], 'each ask reached the adapter')
})

/**
 * A Harness-like adapter (`HarnessWorkers`, R15-A5): a member's handle is idle
 * while it is in `idle`, and an idle handle can hold input no driver will claim
 * (`stranded`). `isIdle` is a question, so asking changes nothing; only the
 * drain step wakes stranded input, whose turn then runs (the handle is busy),
 * and an assignment's waking delivery carries it with the assignment. `woken`
 * records which of the two consumed each member's stranded input.
 */
class InboxWorkers extends FakeWorkers {
  stranded = new Set()
  woken = []
  drainStrandedInbox(id) {
    if (!this.isIdle(id) || !this.stranded.delete(id)) return
    this.idle.delete(id)
    this.woken.push(['drain', id])
  }
  async deliver(member, delivery) {
    if (this.stranded.delete(member.id)) this.woken.push(['delivery', member.id])
    await super.deliver(member, delivery)
  }
}

const dispatchQuestions = f => f.runtime.store.list('deliveries', f.mission.id)
  .filter(delivery => delivery.to === 'owner' && delivery.notice?.dedupKey.startsWith('dispatch-question:')).map(delivery => delivery.content)

test('the dispatch sweep has the adapter wake a stranded inbox before it decides, and leaves a parked member\'s', async t => {
  const workers = new InboxWorkers()
  const f = await setup({ clock: new FakeClock(), workers })
  t.after(() => f.cleanup())
  // The reviewer is parked: the parked-member hatch never asks about its handle.
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'parked' }))
  await f.runtime.settle(f.mission.id)
  // Both handles are idle and hold input no driver will claim; there is no work to hand them.
  for (const member of [f.author, f.reviewer]) { workers.idle.add(member.id); workers.stranded.add(member.id) }
  await f.runtime.tick()
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(workers.woken, [['drain', f.author.id]], 'the sweep woke the author\'s stranded input, once')
  assert.deepEqual([...workers.stranded], [f.reviewer.id], 'and left the parked reviewer\'s for the work that unparks it')
})

test('a preferred member whose handle holds stranded input when the sweep starts is drained first, so the borrower takes its work in the same pass and the owner is asked nothing', async t => {
  const workers = new InboxWorkers()
  const f = await setup({ clock: new FakeClock(), workers })
  t.after(() => f.cleanup())
  const work = f.propose({ title: 'Preferred to the reviewer', assigneeId: f.reviewer.id, assignmentMode: 'preferred' })
  await f.runtime.settle(f.mission.id)
  for (const member of [f.author, f.reviewer]) workers.idle.add(member.id)
  workers.stranded.add(f.reviewer.id)
  await f.runtime.tick()
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(workers.woken, [['drain', f.reviewer.id]], 'the sweep woke the reviewer\'s stranded input before it decided anything')
  const row = taskOf(f.runtime, work.id)
  assert.deepEqual([row.status, row.attempt?.ownerId], ['running', f.author.id], 'so every ask of the sweep read the reviewer busy, and the author borrowed its work')
  assert.deepEqual(dispatchQuestions(f), [], 'and the owner was asked no dispatch question about it')
})

test('a preferred member whose turn ends stranded while the sweep starts the author keeps its work, and the owner is asked nothing', async t => {
  const workers = new InboxWorkers()
  const f = await setup({ clock: new FakeClock(), workers })
  t.after(() => f.cleanup())
  const work = f.propose({ title: 'Preferred to the reviewer', assigneeId: f.reviewer.id, assignmentMode: 'preferred' })
  await f.runtime.settle(f.mission.id)
  // The author's handle is idle. The reviewer's is busy until the sweep starts
  // the author, the member it steps through first, and then ends its turn with
  // input left in its inbox: after the sweep's drain step, so no step drains it.
  workers.idle.add(f.author.id)
  const start = f.runtime.startWorker.bind(f.runtime)
  f.runtime.startWorker = async (mission, member, options) => {
    await start(mission, member, options)
    if (member.id === f.author.id && !workers.idle.has(f.reviewer.id)) { workers.idle.add(f.reviewer.id); workers.stranded.add(f.reviewer.id) }
  }
  await f.runtime.tick()
  await f.runtime.settle(f.mission.id)
  const row = taskOf(f.runtime, work.id)
  assert.deepEqual([row.status, row.attempt?.ownerId], ['running', f.reviewer.id], 'the reviewer\'s idle handle is startable at every ask, so it keeps the work preferred to it')
  assert.deepEqual(workers.woken, [['delivery', f.reviewer.id]], 'and the assignment\'s waking delivery carried its stranded input')
  assert.deepEqual(dispatchQuestions(f), [], 'and the owner was asked no dispatch question about it')
})

test('a pause that lands while lease recovery awaits a capture halts the sweep before its drain step, and the first sweep after the resume wakes the stranded input', async t => {
  const workers = new InboxWorkers()
  const f = await setup({ clock: new FakeClock(), workers })
  t.after(() => f.cleanup())
  for (const member of [f.author, f.reviewer]) workers.idle.add(member.id)
  const work = f.propose()
  await f.runtime.settle(f.mission.id)
  assert.equal(taskOf(f.runtime, work.id).status, 'running')
  // The author's lease expires, and the next body's lease recovery awaits its checkpoint capture.
  const capturing = deferred(), gate = deferred()
  workers.captureGate = () => { capturing.resolve(); return gate.promise }
  f.clock.advance(f.runtime.config.leaseMs + 1)
  const ticking = f.runtime.tick()
  await capturing.promise
  // During that await the owner pauses the mission, and the reviewer's turn ends with input no driver will claim.
  f.runtime.control(f.owner, f.mission.id, 'pause', 'Owner paused')
  workers.stranded.add(f.reviewer.id)
  gate.resolve()
  await ticking
  await f.runtime.settle(f.mission.id)
  assert.equal(f.runtime.mission(f.mission.id).status, 'paused')
  assert.deepEqual(workers.woken, [], 'the halted sweep woke nothing of the paused mission')
  f.runtime.control(f.owner, f.mission.id, 'resume', 'Owner resumed')
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(workers.woken, [['drain', f.reviewer.id]], 'the first sweep of the resumed mission woke the reviewer\'s stranded input')
})

test('a member whose drain step throws ends its own chain in that sweep: it is not stepped, so the work held for it waits under its guard terminal, told once, and the sweep still dispatches the others', async t => {
  const workers = new InboxWorkers()
  const f = await setup({ clock: new FakeClock(), workers })
  t.after(() => f.cleanup())
  // Waking the author's stranded input throws on every sweep (a session append failing inside the wake).
  const failure = 'session append failed while waking stranded input'
  const drain = workers.drainStrandedInbox.bind(workers)
  workers.drainStrandedInbox = id => { if (id === f.author.id && workers.stranded.has(id)) throw new Error(failure); drain(id) }
  for (const member of [f.author, f.reviewer]) workers.idle.add(member.id)
  workers.stranded.add(f.author.id)
  const held = f.propose({ title: 'Work for the author' })
  const work = f.propose({ title: 'Work for the reviewer', assigneeId: f.reviewer.id })
  await f.runtime.settle(f.mission.id)
  for (let tick = 0; tick < 3; tick += 1) { f.clock.advance(f.runtime.config.tickMs); await f.runtime.tick(); await f.runtime.settle(f.mission.id) }
  const row = taskOf(f.runtime, work.id)
  assert.deepEqual([row.status, row.attempt?.ownerId], ['running', f.reviewer.id], 'the reviewer, whose own chain is fine, still gets its work')
  const kept = taskOf(f.runtime, held.id)
  assert.deepEqual([kept.status, kept.attempt, kept.epoch], ['pending', undefined, held.epoch], 'the author is not stepped in a sweep whose drain step threw, so the work held for it is not assigned')
  assert.deepEqual([workers.woken, [...workers.stranded]], [[], [f.author.id]], 'and no delivery carried the input its drain step could not wake')
  const terminals = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice?.dedupKey.startsWith('guard-terminal:attempt_lease:'))
  assert.deepEqual(terminals.map(delivery => [delivery.notice.reason, delivery.subjects]), [[`Error: ${failure}`, [`${held.id}@${held.epoch}`]]],
    'the author\'s chain ended in its guard terminal, naming the work that waits, told once however often the throw recurs')
  assert.deepEqual(events(f.runtime, f.mission.id, 'mission/stalled').filter(event => event.data.cause === 'guard-terminal').map(event => [event.data.memberId, event.data.detail]),
    [[f.author.id, `Error: ${failure}`]], 'and its one stall event names the author and the failure')
})

test('a chained body drains the stranded preferred member its order leaves out, so the borrower in that order takes the work', async t => {
  const workers = new InboxWorkers()
  const f = await setup({ clock: new FakeClock(), workers })
  t.after(() => f.cleanup())
  const third = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Third', role: 'implementation', maxOutputTokens: 5_000 })
  await f.runtime.settle(f.mission.id)
  // The author and the reviewer are busy and the third member is idle. The
  // reviewer's start holds the first body for a whole bound, and meanwhile the
  // author's turn ends with input no driver will claim. That body stops before
  // the third member, and the chained body that follows sweeps the third alone.
  workers.idle.add(third.id)
  const start = workers.start.bind(workers)
  workers.start = async spec => {
    await start(spec)
    if (spec.member.id !== f.reviewer.id || workers.stranded.has(f.author.id)) return
    f.clock.advance(f.runtime.config.stallPassTimeoutMs)
    workers.idle.add(f.author.id); workers.stranded.add(f.author.id)
  }
  const bodies = [], closePass = f.runtime.scheduling.closePass.bind(f.runtime.scheduling)
  f.runtime.scheduling.closePass = (missionId, pass) => { bodies.push([pass.sweepFrom, pass.stoppedBefore]); return closePass(missionId, pass) }
  const work = f.propose({ title: 'Preferred to the author', assignmentMode: 'preferred' })
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(bodies.slice(0, 2), [[undefined, third.id], [third.id, undefined]], 'the first body stopped before the third member, and the chained body swept from it')
  assert.deepEqual(workers.woken, [['drain', f.author.id]], 'the chained body drained the author, whom its order leaves out')
  const row = taskOf(f.runtime, work.id)
  assert.deepEqual([row.status, row.attempt?.ownerId], ['running', third.id], 'so the third member\'s ask read the author busy and it borrowed the work')
  assert.deepEqual(dispatchQuestions(f), [], 'and the owner was asked no dispatch question about it')
})

test('the sweep\'s drain step leaves the stranded input of a member that owes a stop', async t => {
  const workers = new InboxWorkers()
  const f = await setup({ clock: new FakeClock(), workers })
  t.after(() => f.cleanup())
  const earlier = f.propose({ title: 'Earlier work' })
  await f.runtime.settle(f.mission.id)
  // The author's stop waits on `release`, so the stop it owes stays in flight through the next sweep.
  const release = deferred(), stop = workers.stop.bind(workers)
  workers.stop = async id => { if (id === f.author.id) await release.promise; return stop(id) }
  // The sweep's first worker start comes after its drain step.
  const swept = deferred(), start = workers.start.bind(workers)
  workers.start = async spec => { swept.resolve(); return start(spec) }
  for (const member of [f.author, f.reviewer]) { workers.idle.add(member.id); workers.stranded.add(member.id) }
  // A stop the author owes on the earlier work, as a fence of its attempt there writes it.
  f.runtime.commit(f.mission.id, () => {
    const row = taskOf(f.runtime, earlier.id)
    f.runtime.store.put('tasks', { ...row, status: 'blocked', resumeAfterStop: { epoch: row.epoch, memberId: f.author.id, reason: 'handoff', at: f.clock.now() } })
  })
  const ticking = f.runtime.tick()
  try {
    await swept.promise
    assert.deepEqual(workers.woken, [['drain', f.reviewer.id]], 'the sweep woke the reviewer\'s stranded input')
    assert.ok(workers.stranded.has(f.author.id), 'and left the input of the author, which owes a stop')
  } finally { release.resolve() }
  await ticking
  await f.runtime.settle(f.mission.id)
})
