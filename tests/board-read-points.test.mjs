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
 *  - one board asks the adapter about one member twice and gets two answers:
 *    the view is called through and never memoized, because asking whether a
 *    handle is idle can drain a stranded inbox item (R15-A5).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ready } from '../lib/board.js'
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
