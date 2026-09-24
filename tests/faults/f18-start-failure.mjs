/**
 * F18 (R5-02): a worker-start failure is a recoverable interruption.
 *
 * Injection: after admission, every `start` of the member assigned the task
 * fails. Pre-fix the scheduler marked the member `stopped` and blocked the task
 * with zero recovery credit and no re-route, so the work was permanently
 * unschedulable. The contract asserted here is the established recovery policy:
 * re-pend on every start failure, and after `k` consecutive failures retire the
 * route and re-route to another capable live member with a durable
 * `task/reassigned` event.
 *
 * 69211b9 changed the credit rule on purpose: route startup is infrastructure
 * recovery, so a start failure spends no task recovery credit (it used to spend
 * exactly one). The bound is the route's `k` consecutive failures instead
 * (tests/start-failure-recovery.test.mjs, "preserves task credit"). When every
 * route fails, the task-level outcome is that bound plus one owner notice that
 * names the task, each retired route with its failures and last error, and the
 * exits. A classified provider outage neither counts nor retires a route, so its
 * bound is pacing: one start probe per route per outage window, one owner notice.
 */
import assert from 'node:assert/strict'
import { setup, events, eventually, runScenario, taskOf } from './harness.mjs'

const K = 3 // START_FAILURE_REROUTE_LIMIT in src/runtime.ts
const OUTAGE_WINDOW_MS = 5 * 60_000 // PROVIDER_OUTAGE_WINDOW_MS in src/runtime.ts
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const ownerNotices = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner')

/** Every start of every route fails with `fault(member)`; returns the per-member start counts. */
function failEveryStart(f, fault) {
  const starts = { [f.author.id]: 0, [f.reviewer.id]: 0 }
  f.workers.autoIdle = true
  f.workers.start = async spec => { starts[spec.member.id] = (starts[spec.member.id] ?? 0) + 1; throw fault(spec.member) }
  return starts
}

/** Every route fails generically: k starts per route, then one named owner notice and no retry. */
async function allRoutesFail() {
  const f = await setup({ config: { tickMs: 20, maxTasksPerMember: 100 } })
  try {
    const task = f.propose({ maxRecoveryAttempts: 2 })
    const starts = failEveryStart(f, member => new Error(`injected bootstrap failure for ${member.name}`))
    await eventually(() => [f.author, f.reviewer].every(member => f.runtime.store.get('members', member.id).phase === 'stopped'),
      'every failing route was not retired')
    await sleep(300) // many ticks after the last retirement
    assert.deepEqual(starts, { [f.author.id]: K, [f.reviewer.id]: K }, 'I18: every route is bounded by k failed starts and nothing retries after the last')
    const current = taskOf(f.runtime, task.id)
    assert.equal(current.status, 'pending', 'a start failure never blocks the task')
    assert.equal(current.recoveryCount ?? 0, 0, 'I18: no start failure spends task execution credit')
    assert.equal(events(f.runtime, f.mission.id, 'task/blocked').length, 0)
    const named = ownerNotices(f).filter(delivery => /No live member can start/.test(delivery.content))
    assert.equal(named.length, 1, 'I18: exactly one owner notice names the stranded task')
    const content = named[0].content
    assert.ok(content.includes(task.id), 'the notice names the task')
    for (const member of [f.author, f.reviewer]) {
      assert.ok(content.includes(`${member.name} (${member.id}): ${K} consecutive start failures, last error: Error: injected bootstrap failure for ${member.name}`),
        `the notice names ${member.name}, its consecutive start failures and its last error`)
    }
    assert.match(content, /swarm_add_member/, 'the notice names the add-member exit')
    assert.match(content, /swarm_control\(taskId, action: "amend"/, 'the notice names the reassign exit')
    return { starts: Object.values(starts), notice: content.slice(0, 80) }
  } finally { await f.cleanup() }
}

/** Every route is inside a provider outage: one probe per route per window and one notice per route. */
async function allRoutesInOutage() {
  const clock = { skew: 0 } // the runtime clock can be moved past the outage window
  const f = await setup({ config: { tickMs: 20, maxTasksPerMember: 100, now: () => Date.now() + clock.skew } })
  try {
    const task = f.propose({ maxRecoveryAttempts: 2 })
    const starts = failEveryStart(f, () => Object.assign(new Error('provider unavailable (HTTP 503)'), { status: 503 }))
    await eventually(() => [f.author, f.reviewer].every(member => f.runtime.store.get('members', member.id).providerOutage), 'both outages were not recorded')
    await sleep(300) // many ticks inside the outage window
    assert.deepEqual(starts, { [f.author.id]: 1, [f.reviewer.id]: 1 }, 'I18: no start attempt while the outage window is open')
    const told = ownerNotices(f).filter(delivery => /provider unavailable outage/.test(delivery.content)).map(delivery => delivery.from).sort()
    assert.deepEqual(told, [f.author.id, f.reviewer.id].sort(), 'the owner is told once per route outage')
    clock.skew += OUTAGE_WINDOW_MS + 1
    await eventually(() => starts[f.author.id] === 2 && starts[f.reviewer.id] === 2, 'each route did not probe once in the next outage window')
    await sleep(300)
    assert.deepEqual(starts, { [f.author.id]: 2, [f.reviewer.id]: 2 }, 'I18: one start probe per route per outage window')
    assert.equal(ownerNotices(f).filter(delivery => /provider unavailable outage/.test(delivery.content)).length, 2, 'a continuing outage is not re-announced')
    assert.equal(taskOf(f.runtime, task.id).recoveryCount ?? 0, 0, 'an outage spends no task execution credit')
    return { starts: Object.values(starts), notices: told.length }
  } finally { await f.cleanup() }
}

/** One failing route beside a healthy one: re-pend k times, retire, re-route. */
async function perRoute() {
  const f = await setup({ config: { tickMs: 20, maxTasksPerMember: 100 } })
  try {
    const task = f.propose({ maxRecoveryAttempts: 5 })
    f.workers.autoIdle = true
    // Injection: the assigned member's route is down after admission.
    const start = f.workers.start.bind(f.workers)
    f.workers.start = async spec => {
      if (spec.member.id === f.author.id) { f.workers.started.push(spec.member.id); throw new Error('injected provider outage at worker start') }
      return await start(spec)
    }
    const reassigned = await eventually(() => events(f.runtime, f.mission.id, 'task/reassigned')[0],
      'the task was not re-routed after k consecutive start failures')
    assert(f.workers.started.filter(id => id === f.author.id).length >= 3, 'the injected fault fired on every start attempt')
    assert.equal(reassigned.data.taskId, task.id)
    assert.equal(reassigned.data.from, f.author.id)
    assert.equal(reassigned.data.to, f.reviewer.id, 'a capable live member receives the work')
    assert.equal(reassigned.data.consecutiveFailures, 3)
    assert.match(reassigned.data.reason, /injected provider outage at worker start/)
    const current = taskOf(f.runtime, task.id)
    assert.equal(current.recoveryCount ?? 0, 0, 'I18: a start failure spends no task recovery credit')
    const failed = events(f.runtime, f.mission.id, 'task/start-failed').filter(event => event.data.taskId === task.id)
    assert.deepEqual(failed.map(event => event.data.consecutiveFailures), [1, 2, 3], 'I18: the route is bounded by k consecutive failures')
    assert.deepEqual(failed.map(event => event.data.status), ['pending', 'pending', 'pending'], 'every start failure re-pends the task')
    assert.equal(f.runtime.store.get('members', f.author.id).phase, 'stopped', 'I18: the failing route is retired at k')
    assert.equal(current.status, 'running', 'the re-routed task is dispatched to the live member')
    assert.equal(current.attempt.ownerId, f.reviewer.id)
    assert.equal(current.assigneeId, f.reviewer.id)
    assert.equal(events(f.runtime, f.mission.id, 'task/blocked').length, 0, 'the task never blocks before its recovery limit')
    assert(events(f.runtime, f.mission.id, 'task/start-failed').length >= 3, 'every start failure emits a durable task transition')
    assert.equal(events(f.runtime, f.mission.id, 'member/resume-failed').length, 3, 'each failed start is durably reported')
    return { credits: current.recoveryCount, from: reassigned.data.from, to: reassigned.data.to, consecutiveFailures: reassigned.data.consecutiveFailures, newOwner: current.attempt.ownerId }
  } finally { await f.cleanup() }
}

await runScenario({
  id: 'F18', title: 'A worker-start failure preserves task recovery credit, re-routes after k consecutive failures, and is bounded and named when every route fails', invariants: ['I18'],
  body: async () => ({ perRoute: await perRoute(), allRoutesFail: await allRoutesFail(), allRoutesInOutage: await allRoutesInOutage() }),
})
