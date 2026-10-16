/**
 * The paths the replay and fault scenarios never reach, on the oracle clock
 * (scripts/replay/oracle.mjs runs it as `paths`; it runs only in oracle mode).
 * Each part is a runtime of its own, so each leaves its own full log:
 *
 *  1. Stop fences. A stop marker an older build left with no owner reserves
 *     every member while its stop fails (two transient refusals, each told once
 *     by its own key, then a confirmed stop); a marker at an older epoch fences
 *     nothing; a recorded owner with no member row is refused deterministically
 *     and the owner's named exit (withdraw it) works.
 *  2. Isolation. Two live members in one worktree refuse dispatch durably, the
 *     repair dispatches, and a changed violation is a new decision.
 *  3. Silence. An operation and an attempt that record nothing past their
 *     declared bounds are named, each by its own guard, exactly once.
 *  4. Completion. The owner completes a mission whose work is accepted; the
 *     terminal mission and its accepted task stay immutable.
 *  5. Preference. Two untouched tasks preferred to different members wait
 *     behind a member that prefers neither, with nothing running. Every
 *     reading of that board (the dispatch sweep's, the board judgement's) asks
 *     the adapter whether each preferred member can start, once for the
 *     dispatchable work and again for the stall, so the order in which the
 *     interpretation evaluates its sets is in the trace. Once every handle can
 *     start, each preferred member takes its own task.
 *  6. A pump that ages out mid-tick. An owner notice's delivery hangs, so the
 *     pump that started it stays in flight; a body wedges in its start. The
 *     tick's outbox guard joins that pump one millisecond inside its bound, the
 *     guards after it take that millisecond, and the watchdog names the body at
 *     the bound. The naming is delivered in its own tick, while the body is
 *     wedged.
 *
 * Durable state is injected only where no runtime path produces it (a marker
 * without an owner or at an older epoch, a missing owner, a shared worktree),
 * the way the fault suite injects faults.
 */
import assert from 'node:assert/strict'
import { FakeWorkers, acceptThroughReview, eventually, now, runScenario, setup, taskOf, wait } from '../../tests/faults/harness.mjs'

if (process.env.SWARM_ORACLE === undefined) throw new Error('paths-clocked runs only under scripts/replay/oracle.mjs (SWARM_ORACLE)')

/** Every stop throws `stopFault` while one is set. */
class FenceWorkers extends FakeWorkers {
  stopFault
  async stop(id) { this.stopped.push(id); if (this.stopFault !== undefined) throw this.stopFault }
}

const ownerNotices = (f, pattern) => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && pattern.test(delivery.content))
const write = (f, table, row) => f.runtime.store.transaction(() => f.runtime.store.put(table, row))
const running = (f, taskId, message) => eventually(() => taskOf(f.runtime, taskId).status === 'running' ? taskOf(f.runtime, taskId) : undefined, message)

async function stopFences() {
  const workers = new FenceWorkers({ autoIdle: true })
  const f = await setup({ workers })
  try {
    const second = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Second', role: 'implementation', maxOutputTokens: 5_000 })
    await f.runtime.settle(f.mission.id)
    const fenced = f.propose({ title: 'Fenced by an unresolved stop' })
    const dispatched = await running(f, fenced.id, 'the work is dispatched to its assignee')
    // A marker an older build wrote without the stopped handle's owner.
    workers.stopFault = new Error('EBUSY: the worker handle is busy (first refusal)')
    const row = taskOf(f.runtime, fenced.id)
    row.status = 'blocked'; row.epoch++; delete row.attempt
    row.resumeAfterStop = { epoch: row.epoch, reason: 'handoff', at: now() }
    write(f, 'tasks', row)
    const waiting = f.propose({ title: 'Waits behind the unresolved stop', assigneeId: second.id })
    await wait(100)
    assert.equal(taskOf(f.runtime, waiting.id).status, 'pending', 'an unresolved stop owner reserves every member, not only the one that held the work')
    assert.equal(ownerNotices(f, /first refusal/).length, 1, 'the failed stop is told once')
    workers.stopFault = new Error('EBUSY: the worker handle is busy (second refusal)')
    await wait(1_500)
    assert.equal(ownerNotices(f, /second refusal/).length, 1, 'a different failure at the same epoch is a new decision')
    assert.equal(taskOf(f.runtime, waiting.id).status, 'pending', 'the reservation holds while the stop fails')
    workers.stopFault = undefined
    await running(f, waiting.id, 'the confirmed stop releases every member')
    const redispatched = await running(f, fenced.id, 'the fenced work is re-pended and dispatched again')
    assert.ok(redispatched.epoch > dispatched.epoch)

    // A marker at an older epoch fences nothing: the owner is free once it submits.
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: fenced.id, attemptId: redispatched.attempt.id, output: 'fenced work done' })
    const submitted = taskOf(f.runtime, fenced.id)
    submitted.resumeAfterStop = { epoch: submitted.epoch - 1, memberId: f.author.id, reason: 'handoff', at: now() }
    write(f, 'tasks', submitted)
    const free = f.propose({ title: 'Behind a stale marker' })
    await running(f, free.id, 'a marker at an older epoch reserves no member')
    const stops = workers.stopped.length
    await wait(100)
    assert.equal(workers.stopped.length, stops, 'and is never resumed as a stop')
    assert.equal(taskOf(f.runtime, fenced.id).status, 'submitted')

    // A recorded owner with no member row can never confirm its checkpoint.
    const ghost = f.propose({ title: 'Owned by a missing member', assigneeId: second.id })
    const orphan = taskOf(f.runtime, ghost.id)
    orphan.status = 'blocked'; orphan.epoch++
    orphan.resumeAfterStop = { epoch: orphan.epoch, memberId: 'member_ghost', reason: 'handoff', at: now() }
    write(f, 'tasks', orphan)
    const refusal = await eventually(() => ownerNotices(f, /member_ghost has no member row/)[0], 'the unconfirmable stop is refused')
    assert.match(refusal.notice.dedupKey, /^guard-terminal:attempt_lease:attempt_terminal:stop:/)
    f.runtime.cancel(f.owner, f.mission.id, { taskId: ghost.id, reason: 'The recorded stop owner is gone' })
    await wait(50)
    return { stops: workers.stopped.length }
  } finally { await f.cleanup() }
}

async function isolation() {
  const f = await setup({ workers: new FakeWorkers({ autoIdle: true }) })
  try {
    const authorWorkspace = f.runtime.store.get('members', f.author.id).workspace
    write(f, 'members', { ...f.runtime.store.get('members', f.reviewer.id), workspace: authorWorkspace })
    const task = f.propose()
    const terminals = () => ownerNotices(f, /\[workspace_terminal\]/)
    await eventually(() => terminals()[0], 'a shared worktree is refused durably')
    await wait(100)
    assert.equal(terminals().length, 1, 'one decision for the one violation')
    assert.equal(taskOf(f.runtime, task.id).status, 'pending', 'nothing is dispatched into a shared worktree')
    write(f, 'members', { ...f.runtime.store.get('members', f.reviewer.id), workspace: `${authorWorkspace}-repaired` })
    await running(f, task.id, 'the repair dispatches the work')
    write(f, 'members', { ...f.runtime.store.get('members', f.author.id), workspace: '' })
    f.propose({ title: 'Work for the author' })
    await eventually(() => terminals()[1], 'a changed violation is a new decision')
    return { decisions: terminals().length }
  } finally { await f.cleanup() }
}

async function silence() {
  const workers = new FakeWorkers({ autoIdle: true })
  const f = await setup({ workers, config: { leaseMs: 600_000, operationBoundMs: 120_000, attemptSilenceBoundMs: 120_000 } })
  try {
    const second = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Second', role: 'implementation', maxOutputTokens: 5_000 })
    await f.runtime.settle(f.mission.id)
    const stuck = f.propose({ title: 'Stuck in one call' })
    const quiet = f.propose({ title: 'Reports nothing', assigneeId: second.id })
    const claimed = await running(f, stuck.id, 'the stuck work is dispatched')
    await running(f, quiet.id, 'the quiet work is dispatched')
    // One in-flight operation recorded on the member, written as the row the adapter's report leaves.
    const activity = { id: 'activity_stuck', kind: 'tool', tool: 'bash', startedAt: now() - 500, attemptId: claimed.attempt.id }
    write(f, 'members', { ...f.runtime.store.get('members', f.author.id), activity })
    workers.activities.set(f.author.id, activity)
    workers.activities.set(second.id, undefined)
    f.clock.advance(130_000)
    await f.runtime.tick()
    await f.runtime.settle(f.mission.id)
    const named = prefix => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.notice?.dedupKey?.startsWith(prefix))
    assert.equal(named('operation-silent:').length, 1, 'the stuck operation is named past its bound')
    assert.equal(named('attempt-silent:').length, 1, 'the silent attempt is named past its bound')
    await wait(100)
    assert.deepEqual([named('operation-silent:').length, named('attempt-silent:').length], [1, 1], 'each silence is named once')
    return { notices: 2 }
  } finally { await f.cleanup() }
}

async function completion() {
  const f = await setup({ workers: new FakeWorkers({ autoIdle: true }) })
  try {
    const task = f.propose({ assigneeId: undefined })
    await acceptThroughReview(f, task)
    await f.runtime.settle(f.mission.id)
    f.runtime.control(f.owner, f.mission.id, 'complete', 'Every deliverable was independently accepted')
    await wait(50)
    assert.equal(f.runtime.store.get('missions', f.mission.id).status, 'completed')
    assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'resume', 'reopen'), /./, 'a completed mission is terminal')
    assert.throws(() => f.propose({ title: 'After completion' }), /./, 'a completed mission admits no work')
    assert.throws(() => f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'withdraw' }), /./, 'and its accepted work is immutable')
    return { status: 'completed' }
  } finally { await f.cleanup() }
}

async function preference() {
  const workers = new FakeWorkers()
  const f = await setup({ workers, budget: { maxWorkers: 4 } })
  try {
    const left = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Left', role: 'implementation', maxOutputTokens: 5_000 })
    const right = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Right', role: 'implementation', maxOutputTokens: 5_000 })
    await f.runtime.settle(f.mission.id)
    // Both proposals commit before the pass they kick reads the board, and the
    // author, first in store order, is preferred by neither.
    const first = f.propose({ title: 'Preferred to Left', assigneeId: left.id, assignmentMode: 'preferred' })
    const second = f.propose({ title: 'Preferred to Right', assigneeId: right.id, assignmentMode: 'preferred' })
    await f.runtime.settle(f.mission.id)
    assert.deepEqual([first, second].map(task => taskOf(f.runtime, task.id).status), ['pending', 'pending'], 'no busy handle takes either task')
    for (const member of [f.author, f.reviewer, left, right]) workers.idle.add(member.id)
    await f.runtime.tick()
    assert.equal((await running(f, first.id, 'the task preferred to Left is dispatched')).attempt.ownerId, left.id, 'Left takes the task preferred to it')
    assert.equal((await running(f, second.id, 'the task preferred to Right is dispatched')).attempt.ownerId, right.id, 'Right takes the task preferred to it')
    return { owners: 2 }
  } finally { await f.cleanup() }
}

const HELD_NOTICE = 'An owner notice whose delivery hangs'

/** The next `start` hangs until the scenario releases it, and the owner delivery of HELD_NOTICE hangs until it ends `held`. */
class AgeOutWorkers extends FakeWorkers {
  wedgeNext = false
  wedged = Promise.withResolvers()
  release
  delivering = Promise.withResolvers()
  held = Promise.withResolvers()
  async start(spec, signal) {
    this.started.push(spec.member.id)
    if (!this.wedgeNext) return
    this.wedgeNext = false
    this.wedged.resolve()
    await new Promise((_resolve, reject) => {
      this.release = () => reject(new Error('Worker startup timed out (released by the scenario)'))
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  }
  async deliver(member, delivery) {
    if (member.id === 'owner' && delivery.content === HELD_NOTICE) { this.delivering.resolve(); await this.held.promise }
    return await super.deliver(member, delivery)
  }
}

async function pumpAgeOut() {
  const workers = new AgeOutWorkers()
  const f = await setup({ workers, config: { workerStartTimeoutMs: 3_600_000 } })
  try {
    const bound = f.runtime.config.stallPassTimeoutMs
    await f.runtime.settle(f.mission.id)
    f.runtime.commit(f.mission.id, () => f.runtime.notify(f.mission.id, HELD_NOTICE, [`mission:${f.mission.id}`], { trigger: 'test/held', reason: 'held' }))
    f.runtime.notices.pumpOutbox()
    await workers.delivering.promise
    workers.wedgeNext = true
    f.runtime.kick(f.mission.id)
    await workers.wedged.promise
    f.clock.advance(bound - 1)
    const sweepStarts = f.runtime.sweepStarts.bind(f.runtime)
    f.runtime.sweepStarts = () => { sweepStarts(); f.clock.advance(1) }
    await f.runtime.tick()
    f.runtime.sweepStarts = sweepStarts
    const named = f.runtime.store.events(f.mission.id, 5_000).filter(event => event.type === 'mission/stalled' && event.data.cause === 'scheduling-pass')
    assert.equal(named.length, 1, 'the watchdog names the body at its bound')
    const naming = f.runtime.store.list('deliveries', f.mission.id).find(delivery => delivery.notice?.dedupKey === named[0].data.noticeKey)
    assert.ok(naming?.deliveredAt !== undefined, 'the naming is delivered in its own tick, while the body is wedged')
    workers.release()
    workers.held.resolve()
    await f.runtime.settle(f.mission.id)
    return { named: named.length }
  } finally { await f.cleanup() }
}

await runScenario({
  id: 'paths', title: 'Clocked: stop fences, isolation, silence bounds, completion, preference and a pump that ages out mid-tick', invariants: [],
  body: async () => ({ fences: await stopFences(), isolation: await isolation(), silence: await silence(), completion: await completion(), preference: await preference(), pumpAgeOut: await pumpAgeOut() }),
})
