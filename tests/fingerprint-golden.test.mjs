/**
 * The F(S) golden: the board digest the owner instruments and the stall events
 * carry, over a fixed sequence of fixture boards, must stay byte-identical
 * across a refactor (tests/fixtures/fingerprint-golden.json, recorded with
 * `UPDATE_FINGERPRINT_GOLDEN=1`).
 *
 * One mission walks through the board states F(S) reads: readiness (an idle,
 * a busy and a parked member, an unmet dependency), an attempt owner, a
 * submission with and without a live independent reviewer, a stopped member,
 * a task ceiling, a challenged claim, an undeliverable worker message, a
 * budget pause and a submission an older build left without an artifact (the
 * review admission never speaks for it, yet F(S) counts it unreviewed). At
 * each state the test records the runtime's `fingerprint`
 * (revision-cached) and the digest of its board recomputed now; the board is
 * recorded with ids relabeled by first appearance, so the golden pins what F(S)
 * derives and digests, not the random ids of one run.
 *
 * The last states pin the revision cache itself. A preparation back-off that
 * ends on the clock alone changes readiness at an unchanged revision, so the
 * cached digest is the one first computed there (`cacheIsLive: false`); a read
 * inside an open commit never answers from the cache. The adapter's idleness
 * cannot show the cache: it never changes the ready set (a member whose
 * idleness a borrower's readiness asks about is itself runnable and eligible).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { FakeClock, setup } from './faults/harness.mjs'
import { ORACLE_EPOCH } from './faults/oracle.mjs'
import { fingerprintBoard } from '../lib/board.js'

const { missionFingerprint } = await import('../lib/runtime.js')
const GOLDEN = new URL('./fixtures/fingerprint-golden.json', import.meta.url)

/** The board with every id renamed by first appearance, and its digest. */
function relabeled(board) {
  const labels = new Map()
  const label = (raw, prefix) => { if (!labels.has(raw)) labels.set(raw, `${prefix}${[...labels.values()].filter(value => value.startsWith(prefix)).length + 1}`); return labels.get(raw) }
  const members = board.members.map(member => ({ ...member, id: label(member.id, 'member_') }))
  const tasks = board.tasks.map(task => ({ ...task, id: label(task.id, 'task_'), ...(task.attemptOwner === undefined ? {} : { attemptOwner: label(task.attemptOwner, 'member_') }) }))
  const ceilings = board.ceilings.map(ceiling => ceiling.replace(/^(budget|task):([^:]+)/, (_raw, kind, id) => `${kind}:${label(id, kind === 'task' ? 'task_' : 'pause_')}`))
  const value = { ...board, members, tasks, ceilings }
  return { board: value, digest: missionFingerprint(value) }
}

test('F(S) over the fixture boards equals the recorded golden', async t => {
  const clock = new FakeClock(ORACLE_EPOCH)
  const f = await setup({ clock })
  t.after(() => f.cleanup())
  const states = []
  // The runtime's F(S) is the digest of the board it reads now, unless its
  // revision cache still holds the answer of an unchanged revision.
  const record = name => {
    const board = fingerprintBoard(f.runtime.boardOf(f.mission.id))
    states.push({ name, cacheIsLive: f.runtime.fingerprint(f.mission.id) === missionFingerprint(board), ...relabeled(board) })
  }
  const put = (table, row) => f.runtime.store.transaction(() => f.runtime.store.put(table, row))
  const step = async () => { clock.advance(1_000); await f.runtime.settle(f.mission.id) }

  record('members only')
  const first = f.propose({ title: 'First' })
  await step()
  record('pending, every handle busy')
  f.workers.idle.add(f.author.id)
  record('pending, the assignee idle (revision unchanged)')
  // The proposal's commit kicks a pass, which dispatches the first task to its idle assignee.
  const second = f.propose({ title: 'Second', dependencies: [first.id] })
  await step()
  record('running under its attempt owner; a dependent waits on it')
  const claimed = f.runtime.store.get('tasks', first.id)
  assert.equal(claimed.status, 'running')
  f.workers.idle.delete(f.author.id)
  const run = await f.workers.callbacks.toolRun(f.author.id, { tool: 'bash', arguments: { command: 'true' }, result: { output: 'ok' }, isError: false })
  const evidence = f.runtime.publish(f.actor(f.author), f.mission.id, { taskId: first.id, attemptId: claimed.attempt.id, claim: 'golden claim', outcome: 'supported', toolRunIds: [run] })
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: first.id, attemptId: claimed.attempt.id, output: 'golden candidate' })
  await step()
  record('submitted beside a live independent reviewer')
  put('members', { ...f.runtime.store.get('members', f.reviewer.id), phase: 'stopped' })
  await step()
  record('submitted with the only reviewer stopped')
  put('evidence', { ...f.runtime.store.get('evidence', evidence.id), status: 'challenged' })
  await step()
  record('a challenged claim')
  put('tasks', { ...f.runtime.store.get('tasks', second.id), ceiling: { dimension: 'maxSteps', limit: 1, used: 1, code: 'task_ceiling_exhausted', reason: 'golden ceiling', at: clock.now() } })
  await step()
  record('a task ceiling')
  f.runtime.store.transaction(() => f.runtime.store.put('deliveries', { id: 'delivery_golden', missionId: f.mission.id, from: f.author.id, to: f.reviewer.id, kind: 'finding', content: 'for a stopped member', createdAt: clock.now() }))
  await step()
  record('an undeliverable worker message')
  put('members', { ...f.runtime.store.get('members', f.author.id), phase: 'parked' })
  f.propose({ title: 'Third' })
  await step()
  record('a parked assignee with pending work')
  put('missions', { ...f.runtime.mission(f.mission.id), budgetPause: { id: 'pause_golden', quiesced: true } })
  await step()
  record('a budget pause')
  // F(S)'s unreviewed work is every submission no live review can accept, not
  // only the review admission's sources: one an older build left without an
  // artifact stays unreviewed.
  const bare = f.runtime.store.get('tasks', first.id)
  assert.equal(bare.status, 'submitted')
  delete bare.artifact
  put('tasks', bare)
  await step()
  record('a submission without an artifact and no live review')
  // The revision cache: a back-off the clock ends moves readiness, not the revision.
  const backedOff = { ...f.runtime.store.get('tasks', second.id), id: 'task_golden_backoff', title: 'Backed off', dependencies: [], preparationFailure: { reason: 'golden back-off', retryAt: clock.now() + 5_000 } }
  delete backedOff.ceiling
  put('tasks', backedOff)
  record('a preparation back-off, read at its revision')
  clock.advance(10_000)
  record('the back-off over on the clock, the revision unchanged')
  // An open commit reads the board it is writing, never the digest cached at the revision it has not advanced yet.
  f.runtime.commit(f.mission.id, () => {
    f.runtime.store.put('tasks', { ...f.runtime.store.get('tasks', backedOff.id), status: 'cancelled' })
    record('withdrawn inside an open commit')
  })

  if (process.env.UPDATE_FINGERPRINT_GOLDEN === '1') await writeFile(GOLDEN, `${JSON.stringify(states, null, 2)}\n`)
  assert.deepEqual(states, JSON.parse(await readFile(GOLDEN, 'utf8')))
})
