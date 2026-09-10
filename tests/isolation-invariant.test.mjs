/**
 * S7: the isolation invariant, asserted over generated task/member sets and
 * proven to refuse durably when it is violated.
 *
 * Invariant (docs/known-limitations.md, "Isolation invariant"):
 *  - live workers never exceed provisioned isolated worktrees: every non-stopped
 *    member owns a provisioned workspace and no two live members share one;
 *  - two concurrently running tasks in one isolated worktree declare disjoint
 *    scope. Tasks in distinct worktrees are isolated by construction (the
 *    per-member worktree is the isolation mechanism; this test never weakens it).
 *
 * The test asserts the invariant through the runtime's own durable-state check
 * (`isolationViolations`), not by inspecting code: a generated plan is scheduled
 * and every observation must be violation-free. The second test corrupts the
 * durable state (two live members in one worktree) and requires the dispatch
 * path to record a durable refusal instead of starting a worker there.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, eventually, taskOf } from './faults/harness.mjs'

const SCOPES = ['src/', 'docs/', 'scripts/faults/', 'tests/', '**', 'src/runtime.ts']
/** Deterministic generator so a failing seed is reproducible. */
const rng = seed => { let state = seed >>> 0; return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x1_0000_0000 } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('S7: generated member/task sets keep live workers within provisioned worktrees and concurrent scopes disjoint per worktree', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const random = rng(seed)
    const memberCount = 2 + Math.floor(random() * 2) // the harness budget admits 3
    const taskCount = 3 + Math.floor(random() * 3)
    const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 60_000, stallPasses: 50 } })
    try {
      while (f.runtime.store.list('members', f.mission.id).filter(member => member.status !== 'stopped').length < memberCount) {
        await f.runtime.addMember(f.owner, f.mission.id, { name: `Gen ${random().toFixed(6)}`, role: 'implementation', maxOutputTokens: 5_000 })
      }
      const members = f.runtime.store.list('members', f.mission.id)
      f.workers.autoIdle = true
      const proposed = []
      for (let index = 0; index < taskCount; index++) {
        proposed.push(f.propose({
          title: `Generated ${seed}-${index}`,
          scope: [SCOPES[Math.floor(random() * SCOPES.length)]],
          assigneeId: members[Math.floor(random() * members.length)].id,
        }))
      }
      await eventually(() => f.runtime.store.list('tasks', f.mission.id).some(task => task.status === 'running'),
        `seed ${seed}: generated work must dispatch`, 6_000)
      for (let observation = 0; observation < 10; observation++) {
        await sleep(20)
        const violations = f.runtime.isolationViolations(f.mission.id)
        assert.deepEqual(violations, [], `seed ${seed}: the isolation invariant must hold: ${violations.join('; ')}`)
        const running = f.runtime.store.list('tasks', f.mission.id).filter(task => task.status === 'running' && task.attempt !== undefined)
        const workspaces = new Set(f.runtime.store.list('members', f.mission.id)
          .filter(member => member.status !== 'stopped').map(member => member.workspace))
        assert.ok(running.length <= workspaces.size,
          `seed ${seed}: live workers (${running.length}) must never exceed provisioned isolated worktrees (${workspaces.size})`)
        // The generated plan deliberately reuses scopes; two running tasks that
        // declare overlapping scope must therefore be in disjoint worktrees.
        for (let left = 0; left < running.length; left++) {
          for (let right = left + 1; right < running.length; right++) {
            const a = running[left], b = running[right]
            const workspaceOf = task => f.runtime.store.get('members', task.attempt.ownerId)?.workspace
            const overlap = a.scope.some(x => b.scope.some(y => x === '**' || y === '**' || x === y || (x.endsWith('/') && y.startsWith(x)) || (y.endsWith('/') && x.startsWith(y))))
            if (overlap) assert.notEqual(workspaceOf(a), workspaceOf(b), `seed ${seed}: ${a.id} and ${b.id} overlap and must not share a worktree`)
          }
        }
      }
      assert.ok(proposed.length === taskCount)
    } finally { await f.cleanup() }
  }
})

test('S7: a shared worktree is refused durably, never dispatched into, and clears after repair', async () => {
  const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 60_000, stallPasses: 50 } })
  try {
    f.workers.autoIdle = true
    const authorWorkspace = f.runtime.store.get('members', f.author.id).workspace
    // Inject the loss of isolation: a second live member is moved into the
    // author's worktree (the shape a lost/broken provisioning path would have).
    f.runtime.store.transaction(() => {
      const reviewer = f.runtime.store.get('members', f.reviewer.id)
      reviewer.workspace = authorWorkspace
      f.runtime.store.put('members', reviewer)
    })
    const task = f.propose({ assigneeId: f.reviewer.id })
    const refused = await eventually(() => {
      const notice = f.runtime.store.list('deliveries', f.mission.id)
        .find(delivery => delivery.to === 'owner' && /Isolation invariant refused/.test(delivery.content))
      const key = f.runtime.store.get('missions', f.mission.id).isolationRefusal
      return notice !== undefined && key !== undefined ? { notice, key } : undefined
    }, 'a shared worktree must produce a durable refusal', 6_000)
    assert.match(refused.key, new RegExp(f.reviewer.id), 'the durable refusal names the member that was not started')
    assert.match(refused.key, /share one provisioned worktree/, 'the durable refusal names the violation')
    assert.match(refused.notice.content, /repair the member workspaces/, 'the refusal wakes the owner with the executable exit')
    assert.equal(taskOf(f.runtime, task.id).status, 'pending', 'no task is assigned into a shared worktree')
    const starts = f.workers.started.filter(id => id === f.reviewer.id).length
    await sleep(120)
    assert.equal(f.workers.started.filter(id => id === f.reviewer.id).length, starts,
      'no worker handle is started for the refused member while the violation holds')

    // Repair the durable state: each live member gets its own isolated worktree.
    f.runtime.store.transaction(() => {
      const reviewer = f.runtime.store.get('members', f.reviewer.id)
      reviewer.workspace = `${authorWorkspace}-repaired`
      f.runtime.store.put('members', reviewer)
    })
    assert.deepEqual(f.runtime.isolationViolations(f.mission.id), [], 'the repaired board satisfies the invariant')
    await eventually(() => f.runtime.store.get('missions', f.mission.id).isolationRefusal === undefined,
      'the repaired board forgets the refusal so a recurrence re-notifies', 4_000)
    const running = await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? taskOf(f.runtime, task.id) : undefined,
      'after the repair the pending task is dispatched normally', 6_000)
    assert.equal(running.attempt.ownerId, f.reviewer.id)
  } finally { await f.cleanup() }
})
