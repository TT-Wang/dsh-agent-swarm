/**
 * S15: the dispatch sweep decides on verdicts, each a function of the board it
 * reads where it decides (src/scheduling.ts), and acts on them:
 *
 *  - `memberStep(board, member, cursor)` at a member's boundary: a kicked body
 *    stops early before a member once the member before it held the body for a
 *    whole bound; a member whose drain ended its chain, or that takes no work,
 *    is skipped; any other is started;
 *  - `afterStart(board, member)` once the member's worker start settled: skip
 *    a busy handle (a parked member is the hatch) or a member that owes a stop,
 *    close out an open attempt whose turn ended (not a parked owner's), else
 *    dispatch the first task the member is eligible for, by priority then age;
 *  - `preparationFailure(fresh, error, clock, config)` over the error a
 *    preparation threw: an identified transient failure under the row's limit
 *    re-pends it with its backoff and tells nobody; any other failure, and the
 *    one at the limit, blocks it and owes the owner the notice that names the
 *    resume. The chosen row is not written: the verdict returns the new one.
 *
 * The sweep's executor sequence over them is pinned by the full-log oracle,
 * whose `prep` scenario (scripts/replay/prep-clocked.mjs) is the one whose
 * preparations throw.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { afterStart, memberStep, preparationFailure } from '../lib/scheduling.js'
import { FakeClock, setup, taskOf } from './faults/harness.mjs'

/** A runtime on the fake clock whose author's handle is busy until a test frees it, and a pending task assigned to the author. */
async function fixture(t) {
  const f = await setup({ clock: new FakeClock() })
  t.after(() => f.cleanup())
  const work = f.propose({ title: 'Work' })
  await f.runtime.settle(f.mission.id)
  const board = () => f.runtime.boardOf(f.mission.id)
  /** The author's member row as the sweep reached it, with `changes`. */
  const reached = (changes = {}) => ({ ...f.runtime.store.get('members', f.author.id), ...changes })
  const put = row => f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', row))
  return { ...f, work, board, reached, put }
}

const cursor = (changes = {}) => ({ index: 1, since: 0, timed: true, ended: new Set(), ...changes })

test('memberStep: a kicked body stops before a member the bound after it reached the one before; never before the first member, and an unkicked body never stops', async t => {
  const f = await fixture(t)
  const board = f.board(), bound = board.bounds.stallPassTimeoutMs, held = f.clock.now() - bound
  assert.equal(memberStep(board, f.reached(), cursor({ since: held })), 'stop-early')
  assert.equal(memberStep(board, f.reached(), cursor({ since: held + 1 })), 'start', 'inside the bound')
  assert.equal(memberStep(board, f.reached(), cursor({ since: held, index: 0 })), 'start', 'the first member of the order')
  assert.equal(memberStep(board, f.reached(), cursor({ since: held, timed: false })), 'start', 'a direct sweep, handed no record')
})

test('memberStep skips a member whose drain ended its chain, a stopped member and one that owes a stop', async t => {
  const f = await fixture(t)
  const since = f.clock.now()
  assert.equal(memberStep(f.board(), f.reached(), cursor({ since, ended: new Set([f.author.id]) })), 'skip', 'its drain threw')
  assert.equal(memberStep(f.board(), f.reached({ phase: 'stopped' }), cursor({ since })), 'skip', 'a stopped member')
  const row = taskOf(f.runtime, f.work.id)
  f.put({ ...row, status: 'blocked', epoch: row.epoch + 1, resumeAfterStop: { epoch: row.epoch + 1, memberId: f.author.id } })
  assert.equal(memberStep(f.board(), f.reached(), cursor({ since })), 'skip', 'a member that owes a stop')
})

test('afterStart skips a busy handle, unless the member is parked, and a member that owes a stop; it dispatches the first eligible task by priority, then age', async t => {
  const f = await fixture(t)
  assert.deepEqual(afterStart(f.board(), f.reached()), { kind: 'skip' }, 'the author\'s handle is busy')
  assert.equal(afterStart(f.board(), f.reached({ phase: 'parked' })).task?.id, f.work.id, 'a parked member is dispatchable whatever its handle answers')
  f.workers.idle.add(f.author.id)
  assert.deepEqual(afterStart(f.board(), f.reached()), { kind: 'dispatch', task: taskOf(f.runtime, f.work.id) })
  const urgent = f.propose({ title: 'Urgent', priority: 60 })
  f.clock.advance(1)
  f.propose({ title: 'Later urgent', priority: 60 })
  assert.equal(afterStart(f.board(), f.reached()).task.id, urgent.id, 'the higher priority, and of equal priorities the older')
  for (const task of f.board().tasks) f.put({ ...task, status: 'cancelled', epoch: task.epoch + 1 })
  assert.deepEqual(afterStart(f.board(), f.reached()), { kind: 'skip' }, 'nothing eligible')
  const owed = f.propose({ title: 'Owed' })
  f.put({ ...taskOf(f.runtime, owed.id), status: 'blocked', epoch: 1, resumeAfterStop: { epoch: 1, memberId: f.author.id } })
  f.propose({ title: 'Ready' })
  assert.deepEqual(afterStart(f.board(), f.reached()), { kind: 'skip' }, 'a member that owes a stop')
})

test('afterStart closes out an open attempt whose turn ended, and skips one whose turn has not ended, whose owner is parked or whose owner owes a stop', async t => {
  const f = await fixture(t)
  f.workers.idle.add(f.author.id)
  const row = taskOf(f.runtime, f.work.id), attempt = { id: 'attempt-open', epoch: row.epoch + 1, ownerId: f.author.id, leaseUntil: f.clock.now() + 60_000 }
  f.put({ ...row, status: 'running', epoch: row.epoch + 1, assigneeId: f.author.id, attempt })
  f.propose({ title: 'Also ready' })
  assert.deepEqual(afterStart(f.board(), f.reached()), { kind: 'skip' }, 'a turn that has not ended')
  f.put({ ...taskOf(f.runtime, f.work.id), attempt: { ...attempt, idleSignal: { at: f.clock.now() } } })
  const ended = afterStart(f.board(), f.reached())
  assert.deepEqual([ended.kind, ended.open?.attempt.id], ['close-out', 'attempt-open'])
  assert.deepEqual(afterStart(f.board(), f.reached({ phase: 'parked' })), { kind: 'skip' }, 'a parked owner is not an abandoned turn')
  // The member comes to owe a stop for other work (during its worker start, say) while it holds that ended turn: the stop comes first.
  const owed = f.propose({ title: 'Owed' })
  f.put({ ...taskOf(f.runtime, owed.id), status: 'blocked', epoch: 1, resumeAfterStop: { epoch: 1, memberId: f.author.id } })
  assert.deepEqual(afterStart(f.board(), f.reached()), { kind: 'skip' }, 'a member that owes a stop is skipped, though its open attempt\'s turn ended')
})

test('preparationFailure re-pends a transient failure under its limit with its backoff and tells nobody; the failure at the limit, and a deterministic one, block the row and owe the notice that names the resume', async t => {
  const f = await fixture(t)
  const config = f.runtime.config, clock = f.clock.now, row = taskOf(f.runtime, f.work.id)
  const chosen = { ...row, maxRecoveryAttempts: 5 }, before = structuredClone(chosen)
  const busy = Object.assign(new Error('workspace busy'), { code: 'EBUSY' })
  const first = preparationFailure(chosen, busy, clock, config)
  assert.deepEqual(chosen, before, 'the chosen row is not written')
  assert.equal(first.notice, undefined, 'a re-pend owes the owner nothing')
  assert.deepEqual([first.task.status, first.task.epoch, first.task.preparationFailure], ['pending', row.epoch + 1,
    { reason: 'Workspace or worker preparation failed: Error: workspace busy', transient: true, attempts: 1, retryAt: f.clock.now() + 1000 }])
  assert.match(first.task.output, /\nThe host will retry after bounded backoff\.$/)
  const timedOut = Object.assign(new Error('git timed out'), { name: 'ProcessTimeoutError' })
  const second = preparationFailure(first.task, timedOut, clock, config)
  assert.deepEqual([second.task.status, second.task.preparationFailure.transient, second.task.preparationFailure.retryAt], ['pending', true, f.clock.now() + 2000], 'a process past its bound is transient; the backoff doubles')
  const third = preparationFailure(second.task, busy, clock, config)
  assert.deepEqual([third.task.status, third.task.preparationFailure.attempts, third.task.preparationFailure.retryAt], ['blocked', 3, undefined], 'the third failure is at the limit of three, whatever a larger allowance')
  assert.deepEqual(third.notice, { content: third.task.output, subjects: [`${row.id}@${row.epoch + 3}`],
    options: { trigger: 'task/preparation-failed', reason: 'Workspace or worker preparation failed: Error: workspace busy' } })
  assert.match(third.notice.content, new RegExp(`swarm_control\\(action: "resume", taskId: "${row.id}", reason: "condition repaired"\\)\\.$`))
  assert.equal(preparationFailure({ ...row, maxRecoveryAttempts: 1 }, busy, clock, config).task.status, 'blocked', 'a recovery allowance below three is the limit')
  assert.equal(preparationFailure({ ...row, maxRecoveryAttempts: undefined }, busy, clock, { ...config, maxTasksPerMember: 1 }).task.status, 'blocked', 'without one, the member task limit is')
  const deterministic = preparationFailure({ ...row, maxRecoveryAttempts: 3 }, new Error('dependency artifact is missing'), clock, config)
  assert.deepEqual([deterministic.task.status, deterministic.task.preparationFailure.transient, deterministic.notice?.options.trigger], ['blocked', false, 'task/preparation-failed'])
})
