/**
 * T1: an id a stored row holds that names no task of its mission (a dependency
 * or a review source a corrupted store left dangling) is stuck work the owner
 * is told about, never a refusal the runtime throws at itself.
 *
 * Before, the task graph had a second, refusing form of its reads
 * (`taskOf`/`lineageOf`/`effectiveOf`/`dependencyMetOf`, which threw
 * `task_not_in_mission`) and the decisions over stored rows asked it: one such
 * row made readiness, `unschedulable` and observe throw, so every tick logged
 * "decision sweep failed", no pass finished, no owner notice was told, and the
 * owner's own exits (cancelling other work, a challenge) threw too. Now the
 * graph has one plain form: an id that names no task reads as no task, so it
 * is an unmet prerequisite, `unschedulable` holds its task as dead, the board
 * names it, and observe renders the edge as `{ id, status: 'missing' }`. A
 * caller's id is still refused where it enters (`SwarmRuntime.task`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertNamedCalls, ownerTools } from './refusal-inventory.mjs'
import { FakeClock, events, setup, taskOf } from './faults/harness.mjs'

/** A fixture runtime on the fake clock, with every tick failure the runtime logs collected. */
async function fixture(t, options = {}) {
  const f = await setup({ clock: new FakeClock(), ...options })
  const failures = [], write = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => { if (/tick failed|sweep failed/.test(String(chunk))) { failures.push(String(chunk)); return true } return write(chunk, ...rest) }
  t.after(async () => { process.stderr.write = write; await f.cleanup() })
  return { ...f, failures, tool: await ownerTools(f) }
}

/** One tick of the runtime clock, settled. */
async function tick(f) {
  f.clock.advance(f.runtime.config.tickMs)
  await f.runtime.tick()
  await f.runtime.settle(f.mission.id)
}

/** A fresh pending row copied from `from` with `fields`, written as only a corrupted store holds it: no runtime path admits a dangling edge. */
function inject(f, from, fields) {
  const row = { ...taskOf(f.runtime, from.id), status: 'pending', epoch: 0, attempt: undefined, assigneeId: undefined, plannedAssigneeId: undefined,
    artifact: undefined, evidenceIds: [], output: undefined, ...fields }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', row))
  return row
}

const ownerNotices = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner')
const missing = id => ({ id, status: 'missing' })
/** The error a call is refused with; the call must be refused. */
const refusal = promise => promise.then(value => assert.fail(`not refused: ${JSON.stringify(value)}`), error => error)

test('a stored dependency that names no task: within one tick the owner is told, no pass fails, and observe and snapshot answer', async t => {
  const f = await fixture(t)
  const template = f.propose({ title: 'Withdrawn first' })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: template.id, reason: 'leave the board idle' })
  const dangling = inject(f, template, { id: 'task_dangling', title: 'Depends on nothing', dependencies: ['task_missing'] })
  await tick(f)
  assert.deepEqual(f.failures, [], 'no tick fails on the board')
  const stall = events(f.runtime, f.mission.id, 'mission/stalled').at(-1)
  assert.ok(stall?.data.unschedulable.includes(dangling.id), `the W3 stall holds the task as unschedulable: ${JSON.stringify(stall?.data)}`)
  const notice = ownerNotices(f).find(delivery => delivery.notice?.dedupKey === stall.data.noticeKey)
  assert.ok(notice?.subjects.includes(`${dangling.id}@0`), 'the owner notice names the task')
  assert.match(notice.content, /task_dangling \(implementation, pending, depends on task_missing\)/, 'and the edge that names no task')
  const board = f.runtime.observe(f.owner, f.mission.id)
  assert.deepEqual(board.unschedulable, [dangling.id], 'the owner board names it unschedulable')
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id, { taskId: dangling.id }).dependencies, [missing('task_missing')], 'the dependency renders as missing')
  assert.ok(f.runtime.snapshot(f.owner, f.mission.id).tasks.some(task => task.id === dangling.id && task.dependencies[0] === 'task_missing'), 'the snapshot carries the row as stored')
})

test('the readiness refusal names the missing dependency, and the owner\'s amendment exit makes the task ready', async t => {
  const f = await fixture(t)
  const dangling = inject(f, f.propose({ title: 'Template' }), { id: 'task_dangling', title: 'Depends on nothing', dependencies: ['task_missing'] })
  const refused = await refusal(f.runtime.claim(f.actor(f.author), f.mission.id, dangling.id))
  assert.equal(refused.code, 'task_not_ready')
  assert.ok(refused.message.includes('dependency task_missing names no task in this mission'), refused.message)
  await assertNamedCalls(refused.message, ['swarm_control', 'swarm_cancel'])
  // A proposal reaching the edge is refused by the one graph validator, which names it.
  assert.throws(() => f.propose({ title: 'Behind the dangling task', dependencies: [dangling.id] }), error => error.code === 'task_graph_invalid'
    && error.diagnostics.some(diagnostic => diagnostic.code === 'task_graph_unknown_edge' && diagnostic.path === 'task_missing'), 'the unknown edge is named')
  await f.tool('swarm_control', { action: 'amend', taskId: dangling.id, changes: { dependencies: [] }, reason: 'the prerequisite does not exist' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, dangling.id)
  assert.equal(claimed.status, 'running', 'the amended task is ready and claimed')
})

test('a review source that names no task under running work: the fall-through names it, its refusal names the withdrawal, and withdrawing it leaves other dangling work standing', async t => {
  const f = await fixture(t)
  const running = f.propose({ title: 'Running work' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, running.id)
  const review = inject(f, running, { id: 'task_dangling_review', title: 'Reviews nothing', kind: 'verification', reviewOf: 'task_missing_source', covers: undefined })
  const dependent = inject(f, running, { id: 'task_dangling_dependent', title: 'Depends on nothing', dependencies: ['task_missing'] })
  await tick(f)
  assert.deepEqual(f.failures, [], 'no tick fails on the board')
  const named = ownerNotices(f).find(delivery => /no live path will advance/.test(delivery.content))
  assert.ok(named?.subjects.includes(`${review.id}@0`) && named.subjects.includes(`${dependent.id}@0`), `the fall-through names both: ${JSON.stringify(named?.subjects)}`)
  const refused = await refusal(f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id))
  assert.equal(refused.code, 'task_not_ready')
  assert.ok(refused.message.includes('review source task_missing_source names no task in this mission'), refused.message)
  await assertNamedCalls(refused.message, ['swarm_cancel'])
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id, { taskId: review.id }).reviewSource, missing('task_missing_source'), 'the review source renders as missing')
  await f.tool('swarm_cancel', { taskId: review.id, reason: 'its source does not exist' })
  assert.equal(taskOf(f.runtime, review.id).status, 'cancelled', 'the withdrawal exit works while another dangling row stands')
  await f.tool('swarm_cancel', { taskId: dependent.id, reason: 'its prerequisite does not exist' })
  assert.equal(taskOf(f.runtime, dependent.id).status, 'cancelled')
})

test('a challenge reads past a dangling row: the disputed source re-opens', async t => {
  const f = await fixture(t)
  const source = f.propose({ title: 'Accepted source' })
  f.runtime.commit(f.mission.id, () => {
    f.runtime.store.put('tasks', { ...taskOf(f.runtime, source.id), status: 'accepted', artifact: { ...f.workers.artifact }, evidenceIds: ['e-source'] })
    f.runtime.store.put('evidence', { id: 'e-source', missionId: f.mission.id, taskId: source.id, workstreamId: f.stream.id, authorId: f.author.id,
      claim: 'the source works', outcome: 'supported', status: 'verified', toolRunIds: [], supersedes: [], challenges: [], createdAt: f.clock.now() })
  })
  inject(f, source, { id: 'task_dangling', title: 'Depends on nothing', dependencies: ['task_missing'] })
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'e-source', reason: 'a counterexample', toolRunIds: [] })
  assert.equal(taskOf(f.runtime, source.id).status, 'submitted', 'the challenge re-opened the source')
})

test('running work whose dependency comes to name no task: the member sees it missing, the guard stops its tools, and submit is refused as a revoked prerequisite', async t => {
  const f = await fixture(t)
  const work = f.propose({ title: 'Running work' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, work.id)
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', { ...taskOf(f.runtime, work.id), dependencies: ['task_missing'] }))
  assert.deepEqual(f.runtime.observe(f.actor(f.author), f.mission.id).current.dependencies, [missing('task_missing')], 'the current assignment renders the dependency as missing')
  assert.equal(f.workers.callbacks.guard(f.author.id, 'read'), 'A prerequisite was invalidated; stop work and inspect the challenge')
  await assert.rejects(f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: work.id, attemptId: claimed.attempt.id, output: 'done' }), error => error.code === 'task_prerequisite_revoked')
})
