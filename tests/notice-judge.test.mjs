/**
 * S12: what a board owes the owner is a function of the board (`judge`), and
 * one executor writes a notice (`Notices.record`). S13: the notice a guard
 * chain ends with is a function of the board too (`guardTerminalNotice`).
 *
 * - `judge` decides and writes nothing: its notices are exactly the rows (and
 *   events) its executor, `Notices.ensureWitness`, then writes, in order, and a
 *   judgement of the board those rows hold owes nothing more.
 * - `record` writes one notice in one commit, its row before its event; a held
 *   notice commits nothing, except an event that records a change of its own
 *   (`whenHeld`); a busy writer's refusal is queued only for a guard terminal's
 *   notice (`Notice.terminal`), and any other notice's busy writer throws.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { interpret } from '../lib/board.js'
import { Notices, guardTerminalNotice, judge, noticeIdentity, reviewBlocked } from '../lib/notices.js'
import { RefusalRegistry } from '../lib/refusals.js'
import { WriterBusyError } from '../lib/store.js'
import { FakeClock, events, makeRuntimeStub, setup, taskOf } from './faults/harness.mjs'

const ownerRows = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner')

/** The writes of each commit the runtime makes from here on, in order: `put <table>` and `event <type>`. */
function commitWrites(f) {
  const commits = []
  let open
  const commit = f.runtime.commit.bind(f.runtime), put = f.runtime.store.put.bind(f.runtime.store), event = f.runtime.store.event.bind(f.runtime.store)
  f.runtime.commit = (missionId, fn) => commit(missionId, () => { open = []; commits.push(open); try { return fn() } finally { open = undefined } })
  f.runtime.store.put = (table, row) => { open?.push(`put ${table}`); return put(table, row) }
  f.runtime.store.event = (missionId, type, ...rest) => { open?.push(`event ${type}`); return event(missionId, type, ...rest) }
  return commits
}

/**
 * A board that owes two facts nobody has told yet: a blocked root a pending
 * task depends on, and pending work that waits on withdrawn work while other
 * work runs. Its rows are written past the commit funnel, so no publication
 * judges the board before the test does.
 */
async function owingBoard(t) {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const research = { kind: 'research', checks: [] }
  const running = f.propose({ title: 'Running work', ...research })
  await f.runtime.claim(f.actor(f.author), f.mission.id, running.id)
  const root = f.propose({ title: 'Blocked root', ...research })
  const dependent = f.propose({ title: 'Waits on the root', ...research, dependencies: [root.id] })
  const withdrawn = f.propose({ title: 'Withdrawn', ...research })
  const dead = f.propose({ title: 'Waits on withdrawn work', ...research, dependencies: [withdrawn.id] })
  await f.runtime.settle(f.mission.id)
  f.runtime.store.transaction(() => {
    f.runtime.store.put('tasks', { ...taskOf(f.runtime, root.id), status: 'blocked', epoch: 1, output: 'blocked for repair' })
    f.runtime.store.put('tasks', { ...taskOf(f.runtime, withdrawn.id), status: 'cancelled' })
  })
  return { ...f, root, dependent, dead }
}

test('judge decides what a board owes the owner and writes nothing; its executor writes exactly those notices, in order, each event after its row', async t => {
  const f = await owingBoard(t)
  const rows = ownerRows(f).length, logged = f.runtime.store.events(f.mission.id, 5_000).length, revision = f.runtime.store.revision()
  const owed = [...judge(interpret(f.runtime.boardOf(f.mission.id)))]
  assert.deepEqual([ownerRows(f).length, f.runtime.store.events(f.mission.id, 5_000).length, f.runtime.store.revision()], [rows, logged, revision], 'judging the board wrote nothing')
  const key = notice => noticeIdentity(f.mission.id, notice.subjects, notice.options).identity.dedupKey
  const subject = task => `${task.id}@${taskOf(f.runtime, task.id).epoch}`
  assert.deepEqual(owed.map(notice => [key(notice).split(':')[0], notice.subjects]), [
    ['stall-root', [subject(f.root), subject(f.dependent)]],
    ['fallthrough', [subject(f.dead)]],
  ], 'the blocked root with its dependent, then the work no live path advances')
  const commits = commitWrites(f)
  f.runtime.notices.ensureWitness(f.mission.id)
  assert.deepEqual(ownerRows(f).slice(rows).map(delivery => [delivery.notice.dedupKey, delivery.content, delivery.subjects]),
    owed.map(notice => [key(notice), notice.content, notice.subjects]), 'the executor wrote exactly the judged notices, in order')
  assert.deepEqual(events(f.runtime, f.mission.id, 'mission/stalled').map(event => event.data), owed.flatMap(notice => notice.event === undefined ? [] : [notice.event.data]), 'and each judged event')
  assert.deepEqual(commits, [['put deliveries', 'event mission/stalled'], ['put deliveries']], 'one commit per notice, its event after its row')
  const told = f.runtime.store.revision()
  assert.deepEqual([...judge(interpret(f.runtime.boardOf(f.mission.id)))], [], 'the board those rows hold owes nothing more')
  f.runtime.notices.ensureWitness(f.mission.id)
  assert.equal(f.runtime.store.revision(), told, 'and judging it again commits nothing')
})

test('record writes one notice in one commit, row then event, and a held notice commits nothing but a changed record of its own', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const source = f.propose({ title: 'Submitted source' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  await f.runtime.settle(f.mission.id)
  const commits = commitWrites(f)
  const blocked = reason => reviewBlocked(f.runtime.boardOf(f.mission.id), taskOf(f.runtime, source.id), 'need', reason)
  const recorded = () => events(f.runtime, f.mission.id, 'task/review-blocked').map(event => event.data.reason)
  const first = blocked('the first blocker')
  const told = ['put deliveries', 'event task/review-blocked']
  assert.equal(f.runtime.notices.record(f.mission.id, first), true, 'a new decision is written')
  assert.deepEqual(commits, [told], 'in one commit: its row, then its record')
  assert.ok(ownerRows(f).some(delivery => delivery.notice.dedupKey === first.options.dedupKey), 'the decision')
  assert.deepEqual(recorded(), ['the first blocker'], 'and its record')
  assert.equal(blocked('the first blocker').event.whenHeld, false, 'the blocker is the one recorded')
  assert.equal(f.runtime.notices.record(f.mission.id, blocked('the first blocker')), false, 'the same decision again is held')
  assert.deepEqual(commits, [told], 'and commits nothing')
  f.runtime.notices.record(f.mission.id, blocked('a second blocker'))
  const back = blocked('the first blocker')
  assert.equal(back.event.whenHeld, true, 'the blocker changed back to one whose decision the owner holds')
  assert.equal(f.runtime.notices.record(f.mission.id, back), false, 'its decision is held')
  assert.deepEqual(commits, [told, told, ['event task/review-blocked']], 'so its record alone is committed')
  assert.deepEqual(recorded(), ['the first blocker', 'a second blocker', 'the first blocker'])
})

test('a busy writer\'s refusal is queued only for a guard terminal\'s notice; any other notice\'s busy writer throws to its caller', () => {
  const queued = []
  const kernel = makeRuntimeStub({
    commit: () => { throw new WriterBusyError('database is locked', 3) },
    store: { get: (table, id) => table === 'missions' ? { id, status: 'active' } : undefined, list: () => [], event() {} },
    boardOf: missionId => ({ missionId, mission: { id: missionId, status: 'active' }, tasks: [] }),
  })
  const refusals = new RefusalRegistry(kernel)
  refusals.queueWriterBusy = recovery => queued.push(recovery)
  const notices = new Notices(kernel, refusals, () => ({ passLive: false, wedged: false }))
  const notice = { content: 'A fact', subjects: ['mission:m'], options: { dedupKey: 'probe:m' } }
  assert.throws(() => notices.record('m', notice), WriterBusyError, 'an ordinary notice is not the busy writer\'s to absorb')
  assert.deepEqual(queued, [])
  const context = { detail: 'probe', localKey: 'probe' }
  assert.equal(notices.record('m', { ...notice, terminal: { chain: 'attempt_lease', context } }), false, 'a guard terminal\'s notice is not written')
  assert.deepEqual(queued.map(recovery => [recovery.missionId, recovery.chain, recovery.context, recovery.attempts]), [['m', 'attempt_lease', context, 3]], 'and its refusal is queued for the writer\'s recovery')
  const terminal = guardTerminalNotice(kernel.boardOf('m'), 'attempt_lease', context)
  assert.deepEqual([terminal.terminal, terminal.event.data.code], [{ chain: 'attempt_lease', context }, 'attempt_terminal'], 'a guard chain\'s notice opts in')
  assert.equal(notices.record('m', terminal), false, 'so recording it')
  assert.equal(queued.length, 2, 'queues the refusal through the same record')
})

test('S13: a guard chain\'s notice is a function of the board: it names its caller\'s subjects, else the task, else the member\'s unfinished work, else the mission root; only a terminal mission owes none, and deciding writes nothing', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const assigned = f.propose({ title: 'The author\'s work', kind: 'research', checks: [] })
  const other = f.propose({ title: 'The reviewer\'s work', kind: 'research', checks: [], assigneeId: f.reviewer.id })
  await f.runtime.settle(f.mission.id)
  const revision = f.runtime.store.revision(), rows = ownerRows(f).length
  const board = f.runtime.boardOf(f.mission.id)
  const subject = task => `${task.id}@${taskOf(f.runtime, task.id).epoch}`
  const subjects = context => guardTerminalNotice(board, 'attempt_lease', { localKey: 'probe', ...context }).subjects
  assert.deepEqual(subjects({ subjects: ['a', 'b', 'a'], taskId: other.id }), ['a', 'b'], 'its caller\'s subjects, once each')
  assert.deepEqual(subjects({ taskId: other.id, memberId: f.author.id }), [subject(other)], 'else the task it was asked about')
  assert.deepEqual(subjects({ memberId: f.author.id }), [subject(assigned)], 'else the member\'s unfinished work')
  assert.deepEqual(subjects({}), [`mission:${f.mission.id}`], 'else the mission root')
  const at = status => ({ ...board, mission: { ...board.mission, status } })
  assert.deepEqual(['active', 'paused', 'blocked', 'completed', 'stopped'].map(status => guardTerminalNotice(at(status), 'budget', { localKey: 'probe' }) !== undefined),
    [true, true, true, false, false], 'only a completed or stopped mission ends the chain\'s duty to speak')
  assert.equal(f.runtime.notices.record(f.mission.id, guardTerminalNotice(at('stopped'), 'budget', { localKey: 'probe' })), false, 'and what it owes there, nothing, records nothing')
  assert.deepEqual([f.runtime.store.revision(), ownerRows(f).length], [revision, rows], 'deciding wrote nothing')
})

test('S13: a guard chain\'s notice is recorded in one commit, its request\'s row then the stall event that names it, pumped outside the mission queue, and held by the ledger after', async t => {
  const f = await setup({ clock: new FakeClock() })
  t.after(f.cleanup)
  const task = f.propose({ title: 'Held work', kind: 'research', checks: [] })
  await f.runtime.settle(f.mission.id)
  let pumped = 0
  const pump = f.runtime.notices.pumpOutbox.bind(f.runtime.notices)
  f.runtime.notices.pumpOutbox = () => { pumped += 1; return pump() }
  const context = { taskId: task.id, memberId: f.author.id, detail: 'the close-out could not checkpoint', localKey: `closeout-failed:${task.id}@0` }
  const notice = guardTerminalNotice(f.runtime.boardOf(f.mission.id), 'attempt_lease', context)
  const commits = commitWrites(f)
  assert.equal(f.runtime.notices.record(f.mission.id, notice), true)
  assert.deepEqual([commits, pumped], [[['put deliveries', 'event mission/stalled']], 1], 'one commit, row then event, and the outbox is pumped')
  const row = ownerRows(f).find(delivery => delivery.notice.dedupKey === notice.options.dedupKey)
  assert.deepEqual([row.content, row.subjects], [notice.content, notice.subjects], 'the row is the notice')
  assert.deepEqual(events(f.runtime, f.mission.id, 'mission/stalled').at(-1).data, notice.event.data, 'and its event names that row')
  assert.equal(notice.event.data.noticeKey, row.notice.dedupKey)
  assert.equal(f.runtime.notices.record(f.mission.id, guardTerminalNotice(f.runtime.boardOf(f.mission.id), 'attempt_lease', context)), false, 'the same request again is held')
  assert.deepEqual([commits.length, pumped], [1, 1], 'and commits and pumps nothing')
})
