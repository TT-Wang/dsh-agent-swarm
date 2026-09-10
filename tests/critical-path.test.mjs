/**
 * S6: critical-path accounting.
 *
 * The mission reports the LENGTH of the longest chain of dependent steps next to
 * its total spend, so a worker that does not shorten the longest branch earns
 * nothing. The numbers are pure accounting: no budget enforcement reads them,
 * and a malformed graph cannot throw.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, acceptThroughReview } from './faults/harness.mjs'

test('S6: the critical path is the longest dependent chain, and adding a worker never shortens it', async () => {
  const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 60_000, stallPasses: 50 } })
  try {
    // A -> B -> C is the longest chain; A -> D is the short branch.
    const a = f.propose({ title: 'A' })
    const b = f.propose({ title: 'B', dependencies: [a.id] })
    const c = f.propose({ title: 'C', dependencies: [b.id] })
    const d = f.propose({ title: 'D', dependencies: [a.id] })
    const path = f.runtime.criticalPath(f.mission.id)
    assert.equal(path.length, 3, 'the longest chain of dependent steps is three tasks')
    assert.deepEqual(path.taskIds, [a.id, b.id, c.id], 'the chain is reported dependency-first')
    assert.equal(path.remaining, 3, 'none of the chain is accepted yet')
    assert.equal(path.usedSteps, 0, 'no steps are charged to the chain yet')

    // More parallelism does not shorten the longest branch.
    await f.runtime.addMember(f.owner, f.mission.id, { name: 'Extra', role: 'implementation', maxOutputTokens: 5_000 })
    assert.equal(f.runtime.criticalPath(f.mission.id).length, 3, 'an added worker does not shorten the critical path')
    assert.deepEqual(f.runtime.criticalPath(f.mission.id).taskIds, [a.id, b.id, c.id])

    // An independent task is off the critical path: accepting it earns nothing.
    const off = f.propose({ title: 'Off-path' })
    assert.equal(f.runtime.criticalPath(f.mission.id).length, 3, 'off-path work does not lengthen the chain')
    assert.ok(!f.runtime.criticalPath(f.mission.id).taskIds.includes(off.id))
    await acceptThroughReview(f, off)
    const afterOffPath = f.runtime.criticalPath(f.mission.id)
    assert.equal(afterOffPath.length, 3, 'accepting off-path work leaves the longest branch unchanged')
    assert.equal(afterOffPath.remaining, 3, 'a worker that did not shorten the longest branch leaves it open')
    assert.deepEqual(afterOffPath.taskIds, [a.id, b.id, c.id])

    // Accepting the head of the chain shortens the OPEN part of the chain.
    await acceptThroughReview(f, a)
    const afterHead = f.runtime.criticalPath(f.mission.id)
    assert.equal(afterHead.length, 3, 'the chain keeps its graph length')
    assert.equal(afterHead.remaining, 2, 'the accepted head leaves two open steps on the chain')
    assert.deepEqual(afterHead.taskIds, [a.id, b.id, c.id])

    // D stays off the reported chain even though it also depends on A.
    assert.ok(!afterHead.taskIds.includes(d.id))
  } finally { await f.cleanup() }
})

test('S6: the observe payload and the snapshot carry the critical path beside the mission spend', async () => {
  const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 60_000, stallPasses: 50 } })
  try {
    const first = f.propose({ title: 'First' })
    const second = f.propose({ title: 'Second', dependencies: [first.id] })
    const observed = await f.runtime.observe(f.owner, f.mission.id, {})
    assert.equal(observed.mission.criticalPath.length, 2, 'observe reports the critical-path length')
    assert.deepEqual(observed.mission.criticalPath.taskIds, [first.id, second.id])
    assert.equal(typeof observed.mission.usedSteps, 'number', 'the length sits next to the mission spend')
    assert.equal(typeof observed.mission.usedTokens, 'number')
    const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
    assert.equal(snapshot.criticalPath.length, 2, 'the client snapshot carries the same projection')
    assert.equal(snapshot.criticalPath.remaining, 2)
    // Accounting only: the reported numbers never change enforcement.
    assert.equal(snapshot.mission.budget.maxSteps, f.runtime.store.get('missions', f.mission.id).budget.maxSteps)
  } finally { await f.cleanup() }
})

test('S6: a malformed graph cannot throw the accounting path', async () => {
  const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 60_000, stallPasses: 50 } })
  try {
    const a = f.propose({ title: 'A' })
    const b = f.propose({ title: 'B', dependencies: [a.id] })
    // A cycle and a dangling dependency are not reachable through the API, so
    // inject them durably: the projection must stay total.
    f.runtime.store.transaction(() => {
      const first = f.runtime.store.get('tasks', a.id)
      const second = f.runtime.store.get('tasks', b.id)
      second.dependencies = [a.id]
      first.dependencies = [b.id, 'task_missing']
      f.runtime.store.put('tasks', first)
      f.runtime.store.put('tasks', second)
    })
    const path = f.runtime.criticalPath(f.mission.id)
    assert.ok(path.length >= 1 && path.length <= 2, `a cyclic graph still yields a bounded chain (${path.length})`)
    assert.ok(path.taskIds.every(id => id === a.id || id === b.id), 'only real tasks are reported')
  } finally { await f.cleanup() }
})
