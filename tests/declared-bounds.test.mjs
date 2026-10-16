/**
 * The declared bounds (`bounds`, src/board.ts): one value read from the live
 * config, where each guard decides. Two of its contracts are pinned here:
 *  - a pass bound below one tick is raised to the tick, since the watchdog that
 *    measures it runs once per tick;
 *  - `0` disables the attempt-silence and operation-silence guards, so neither
 *    names anything past the default bound it would otherwise fall back to.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeClock, FakeWorkers, setup, taskOf } from './faults/harness.mjs'
import { bounds } from '../lib/board.js'

test('a pass bound shorter than one tick is raised to the tick, and a longer one is kept', () => {
  assert.equal(bounds({ tickMs: 100, stallPassTimeoutMs: 50 }).stallPassTimeoutMs, 100)
  assert.equal(bounds({ tickMs: 100, stallPassTimeoutMs: 150 }).stallPassTimeoutMs, 150)
})

/**
 * Two dispatched attempts on a hand-driven clock: one held by an in-flight
 * operation that records nothing, one that reports nothing at all. The clock
 * then jumps past both default bounds (600 s) inside a lease and a mission
 * duration that outlast it, and one tick runs the sweeps. Returns how many
 * operation-silent and attempt-silent notices the ledger holds.
 */
async function silencesPastTheDefaultBounds(config) {
  const clock = new FakeClock()
  const workers = new FakeWorkers({ autoIdle: true })
  const f = await setup({ clock, workers, config: { leaseMs: 3_600_000, ...config }, budget: { maxDurationMs: 3_600_000 } })
  try {
    const second = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Second', role: 'implementation', maxOutputTokens: 5_000 })
    await f.runtime.settle(f.mission.id)
    const stuck = f.propose({ title: 'Stuck in one call' })
    const quiet = f.propose({ title: 'Reports nothing', assigneeId: second.id })
    await f.runtime.settle(f.mission.id)
    assert.deepEqual([stuck, quiet].map(task => taskOf(f.runtime, task.id).status), ['running', 'running'], 'both tasks are dispatched')
    // One in-flight operation on the stuck attempt, as the adapter's report leaves it.
    const activity = { id: 'activity_stuck', kind: 'tool', tool: 'bash', startedAt: clock.now() - 500, attemptId: taskOf(f.runtime, stuck.id).attempt.id }
    f.runtime.store.transaction(() => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.author.id), activity }))
    workers.activities.set(f.author.id, activity)
    workers.activities.set(second.id, undefined)
    clock.advance(700_000)
    await f.runtime.tick()
    await f.runtime.settle(f.mission.id)
    const named = prefix => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.notice?.dedupKey?.startsWith(prefix)).length
    return { operationSilent: named('operation-silent:'), attemptSilent: named('attempt-silent:') }
  } finally { await f.cleanup() }
}

test('0 disables the attempt-silence and operation-silence guards past the default bound they would otherwise fall back to', async () => {
  assert.deepEqual(await silencesPastTheDefaultBounds({}), { operationSilent: 1, attemptSilent: 1 }, 'with the default bounds, both silences are named past 600 s')
  assert.deepEqual(await silencesPastTheDefaultBounds({ attemptSilenceBoundMs: 0, operationBoundMs: 0 }), { operationSilent: 0, attemptSilent: 0 }, 'a bound of 0 names neither')
})
