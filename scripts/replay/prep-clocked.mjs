/**
 * Preparation failures on the dispatch sweep, on the oracle clock
 * (scripts/replay/oracle.mjs runs it as `prep`; it runs only in oracle mode).
 * No other scenario's preparation throws. Each runtime prepares one task the
 * author is assigned; its adapter throws the errors queued for that task, in
 * order, and then prepares it. A backoff is passed by moving the clock over
 * it, so the log holds the passes a decision takes, not a tick per 10 ms.
 *
 *  1. Two identified transient host failures (an error code, then a process
 *     past its bound) under a limit of three: each re-pends the task with its
 *     backoff (one second, then two), and the third preparation dispatches it.
 *  2. Two transient failures under a limit of two: the first re-pends the task,
 *     the second blocks it and tells the owner, whose resume clears the failure,
 *     and the next preparation dispatches it.
 *  3. A deterministic failure blocks the task at once and tells the owner.
 */
import assert from 'node:assert/strict'
import { FakeWorkers, eventually, events, runScenario, setup } from '../../tests/faults/harness.mjs'

if (process.env.SWARM_ORACLE === undefined) throw new Error('prep-clocked runs only under scripts/replay/oracle.mjs (SWARM_ORACLE)')

/** Every handle is startable; a task's preparation throws the errors queued for it, in order. */
class PrepWorkers extends FakeWorkers {
  autoIdle = true
  faults = new Map()
  async prepareTask(member, task) {
    this.prepared.push({ memberId: member.id, taskId: task.id, epoch: task.epoch })
    const error = this.faults.get(task.id)?.shift()
    if (error !== undefined) throw error
  }
}

const busy = () => Object.assign(new Error('workspace busy'), { code: 'EBUSY' })
const descriptors = () => Object.assign(new Error('too many open files'), { code: 'EMFILE' })
const timedOut = () => Object.assign(new Error('git worktree add timed out'), { name: 'ProcessTimeoutError' })

/** One runtime whose author's task meets `faults` in its preparations. */
async function prepared(title, faults, extra, drive) {
  const workers = new PrepWorkers()
  const f = await setup({ workers })
  try {
    const work = f.propose({ title, ...extra })
    workers.faults.set(work.id, faults)
    const failures = () => events(f.runtime, f.mission.id, 'task/preparation-failed').map(event => [event.data.attempts, event.data.transient, event.data.status])
    const row = () => f.runtime.store.get('tasks', work.id)
    const told = () => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.notice?.trigger === 'task/preparation-failed').length
    /** The `count`th failure is recorded; then the clock moves over the backoff it set, if it set one. */
    const failed = async count => {
      await eventually(() => failures().length === count, `preparation failure ${count} is recorded`, 1_000)
      const retryAt = row().preparationFailure.retryAt
      if (retryAt !== undefined) f.clock.advance(retryAt - f.clock.now())
    }
    return await drive({ f, work, failures, failed, row, told })
  } finally { await f.cleanup() }
}

await runScenario({
  id: 'prep', title: 'Clocked: a transient preparation failure re-pends with backoff until its limit blocks it; a deterministic one blocks at once; only a block tells the owner', invariants: [],
  body: async () => {
    const retried = await prepared('Transient preparation', [busy(), timedOut()], { maxRecoveryAttempts: 3 }, async ({ failures, failed, row, told }) => {
      await failed(1)
      await failed(2)
      await eventually(() => row().status === 'running', 'the third preparation dispatches the task', 10_000)
      assert.deepEqual(failures(), [[1, true, 'pending'], [2, true, 'pending']], 'each transient failure re-pends the task')
      assert.equal(row().preparationFailure.attempts, 2, 'the running row keeps its count')
      assert.equal(told(), 0, 'a re-pend tells the owner nothing')
      return failures().length
    })
    const exhausted = await prepared('Exhausted preparation', [descriptors(), descriptors()], { maxRecoveryAttempts: 2 }, async ({ f, work, failures, failed, row, told }) => {
      await failed(1)
      await eventually(() => row().status === 'blocked', 'the second transient failure blocks the task', 10_000)
      assert.deepEqual(failures(), [[1, true, 'pending'], [2, true, 'blocked']], 'the failure at the limit blocks the task')
      assert.match(row().output, /swarm_control\(action: "resume"/)
      assert.deepEqual([told(), events(f.runtime, f.mission.id, 'task/blocked').length], [1, 1], 'the block is recorded and told once')
      f.runtime.controlTask(f.owner, f.mission.id, work.id, 'resume', {}, 'condition repaired')
      await eventually(() => row().status === 'running', 'the resumed task dispatches', 10_000)
      return failures().length
    })
    const deterministic = await prepared('Deterministic preparation', [new Error('dependency artifact is missing')], {}, async ({ failures, row, told }) => {
      await eventually(() => row().status === 'blocked', 'a deterministic failure blocks the task at once', 10_000)
      assert.deepEqual(failures(), [[1, false, 'blocked']])
      assert.equal(told(), 1)
      return failures().length
    })
    return { retried, exhausted, deterministic }
  },
})
