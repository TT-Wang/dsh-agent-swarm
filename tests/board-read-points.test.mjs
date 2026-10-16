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
 *  - dispatch alone also decides the isolation invariant again on the board
 *    the preparation left: a worktree shared during the await is refused and
 *    recorded there (S7's decide, record, skip), never assigned into;
 *  - the dispatch sweep asserts the admission before it prepares anything
 *    (`RefusalRegistry.assertAdmission`): a refused admission is recorded and no
 *    workspace is prepared for the work it refused;
 *  - the assignment asserts the admission again: a stop the member came to owe
 *    during a claim's preparation refuses it;
 *  - one board asks the adapter about one member twice and gets two answers:
 *    the view is called through and never memoized, because asking whether a
 *    handle is idle can drain a stranded inbox item (R15-A5);
 *  - each member step of the dispatch sweep judges the board (the
 *    interpretation) before it asks that member's eligibility, so a preferred
 *    member that judgement drains leaves its work to the borrower in the same
 *    pass.
 *
 * A notice that reads only rows reads the board and asks the adapter nothing:
 * tests/notice-board-reads.test.mjs.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolationViolation, ready } from '../lib/board.js'
import { FakeClock, setup, taskOf } from './faults/harness.mjs'

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

test('each member step of the dispatch sweep judges the board before it asks eligibility: a preferred member drained there leaves its work to the borrower in the same pass, and the owner is asked nothing', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(() => f.cleanup())
  const work = f.propose({ title: 'Preferred to the reviewer', assigneeId: f.reviewer.id, assignmentMode: 'preferred' })
  await f.runtime.settle(f.mission.id)
  // The Harness adapter's idleness question drains a stranded inbox item
  // (`HarnessWorkers.isIdle`, R15-A5): the first ask about an idle handle that
  // holds one answers that it can start and wakes it, so every later ask
  // answers busy. The reviewer's handle is left that way while the sweep
  // starts the author, the member it steps through first.
  let stranded = false
  f.workers.isIdle = memberId => {
    if (memberId === f.author.id) return true
    if (memberId !== f.reviewer.id || !stranded) return false
    stranded = false
    return true
  }
  const start = f.runtime.startWorker.bind(f.runtime)
  f.runtime.startWorker = async (mission, member, options) => { await start(mission, member, options); if (member.id === f.author.id) stranded = true }
  await f.runtime.tick()
  await f.runtime.settle(f.mission.id)
  const row = taskOf(f.runtime, work.id)
  assert.deepEqual([row.status, row.attempt?.ownerId], ['running', f.author.id], 'the author borrowed the work its drained preferred member cannot start')
  assert.deepEqual(f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice?.dedupKey.startsWith('dispatch-question:')).map(delivery => delivery.content), [],
    'and the owner was asked no dispatch question about it')
})
