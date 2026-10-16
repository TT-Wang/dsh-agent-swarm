/**
 * T1's corrupted-store board on the oracle clock (scripts/replay/oracle.mjs
 * runs it as `dangling`; it runs only in oracle mode): stored ids that name no
 * task of their mission. No runtime path admits such an edge, so the rows are
 * injected the way the fault suite injects faults. One runtime, two parts:
 *
 *  1. An idle board. A pending task whose dependency names no task is
 *     unschedulable: the W3 stall names it, observe renders the edge as
 *     missing, a member's claim is refused naming the dependency, and the
 *     owner's amendment exit makes it ready, so the member claims it.
 *  2. Under that running work, a review whose source names no task is named by
 *     the fall-through, and the owner's withdrawal exit cancels it.
 */
import assert from 'node:assert/strict'
import { eventually, runScenario, setup, taskOf } from '../../tests/faults/harness.mjs'

if (process.env.SWARM_ORACLE === undefined) throw new Error('dangling-clocked runs only under scripts/replay/oracle.mjs (SWARM_ORACLE)')

/** A fresh pending row copied from `from` with `fields`, written as only a corrupted store holds it. */
function inject(f, from, fields) {
  const row = { ...taskOf(f.runtime, from.id), status: 'pending', epoch: 0, attempt: undefined, assigneeId: undefined, plannedAssigneeId: undefined,
    artifact: undefined, evidenceIds: [], output: undefined, ...fields }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', row))
  return row
}

const namedTo = (f, subject) => f.runtime.store.list('deliveries', f.mission.id).find(delivery => delivery.to === 'owner' && delivery.subjects.includes(subject))

await runScenario({
  id: 'dangling', title: 'Clocked: a stored dependency and a review source that name no task are stuck work the owner is told about', invariants: [],
  body: async () => {
    const f = await setup()
    try {
      const template = f.propose({ title: 'Withdrawn template' })
      f.runtime.cancel(f.owner, f.mission.id, { taskId: template.id, reason: 'leave the board idle' })
      const dangling = inject(f, template, { id: 'task_dangling', title: 'Depends on nothing', dependencies: ['task_missing'] })
      const stall = await eventually(() => namedTo(f, `${dangling.id}@0`), 'the W3 stall names the task')
      assert.match(stall.content, /^Mission stalled: .*depends on task_missing/)
      assert.deepEqual(f.runtime.observe(f.owner, f.mission.id, { taskId: dangling.id }).dependencies, [{ id: 'task_missing', status: 'missing' }])
      const refused = await f.runtime.claim(f.actor(f.author), f.mission.id, dangling.id).then(() => assert.fail('the claim is refused'), error => error)
      assert.equal(refused.code, 'task_not_ready')
      f.runtime.controlTask(f.owner, f.mission.id, dangling.id, 'amend', { dependencies: [] }, 'the prerequisite does not exist')
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, dangling.id)
      assert.equal(claimed.status, 'running')

      const review = inject(f, claimed, { id: 'task_dangling_review', title: 'Reviews nothing', kind: 'verification', reviewOf: 'task_missing_source', covers: undefined })
      const fallthrough = await eventually(() => namedTo(f, `${review.id}@0`), 'the fall-through names the review')
      assert.match(fallthrough.content, /no live path will advance/)
      f.runtime.cancel(f.owner, f.mission.id, { taskId: review.id, reason: 'its source does not exist' })
      await f.runtime.settle(f.mission.id)
      assert.equal(taskOf(f.runtime, review.id).status, 'cancelled')
      return { stall: stall.notice?.dedupKey !== undefined, fallthrough: true }
    } finally { await f.cleanup() }
  },
})
