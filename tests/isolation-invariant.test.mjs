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
 * path to record a durable refusal instead of starting a worker there: one
 * decision per violation on the deliveries ledger, outstanding exactly while
 * the invariant lists that violation.
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
    const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 60_000 } })
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

test('S7: a shared worktree is refused durably, never dispatched into, and its decision ends with the repair', async () => {
  const f = await setup({ config: { tickMs: 10, stallPassTimeoutMs: 60_000 } })
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
    const terminals = () => f.runtime.store.list('deliveries', f.mission.id)
      .filter(delivery => delivery.to === 'owner' && /\[workspace_terminal\]/.test(delivery.content))
    const relevant = notice => f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), f.runtime.store.get('deliveries', notice.id))
    const refused = { notice: await eventually(() => terminals()[0], 'a shared worktree must produce a durable refusal', 6_000) }
    const [violation] = f.runtime.isolationViolations(f.mission.id)
    assert.match(violation, new RegExp(`${f.author.id}.*${f.reviewer.id}|${f.reviewer.id}.*${f.author.id}`), 'the violation names both members that share the worktree')
    assert.match(refused.notice.notice.dedupKey, /^guard-terminal:workspace:workspace_terminal:isolation:[0-9a-f]{16}$/, 'the refusal is keyed by the violation, not by a member or the board')
    assert.equal(refused.notice.notice.reason, `the isolation invariant refuses dispatch: ${violation}`, 'and records the violation as its reason')
    assert.deepEqual(refused.notice.subjects, [`${task.id}@${taskOf(f.runtime, task.id).epoch}`, `mission:${f.mission.id}`].sort(), 'it names the unfinished work of every member the violation lists: the reviewer\'s task, and the mission root for the author, who holds none')
    assert.equal(relevant(refused.notice), true, 'the decision is outstanding while the invariant lists the violation')
    // S4b: the isolation notice is the shared coded workspace terminal now. The
    // assertion is the coded contract (stable code, the violation as the detail,
    // and the executable exits) instead of the removed prose-only wording.
    assert.match(refused.notice.content, /\[workspace_terminal\]/, 'the refusal carries the stable diagnostic code')
    assert.match(refused.notice.content, /share one provisioned worktree/, 'the detail names the violation')
    assert.match(refused.notice.content, /swarm_control/, 'the refusal wakes the owner with an executable exit')
    assert.equal(taskOf(f.runtime, task.id).status, 'pending', 'no task is assigned into a shared worktree')
    const starts = f.workers.started.filter(id => id === f.reviewer.id).length
    await sleep(120)
    assert.equal(f.workers.started.filter(id => id === f.reviewer.id).length, starts,
      'no worker handle is started for the refused member while the violation holds')
    assert.equal(terminals().length, 1, 'one decision for the one violation, though dispatch refuses both members on every tick')
    assert.equal(Object.hasOwn(f.runtime.store.get('missions', f.mission.id), 'isolationRefusal'), false, 'nothing on the mission row records the refusal')

    // Repair the durable state: each live member gets its own isolated worktree.
    f.runtime.store.transaction(() => {
      const reviewer = f.runtime.store.get('members', f.reviewer.id)
      reviewer.workspace = `${authorWorkspace}-repaired`
      f.runtime.store.put('members', reviewer)
    })
    assert.deepEqual(f.runtime.isolationViolations(f.mission.id), [], 'the repaired board satisfies the invariant')
    assert.equal(relevant(refused.notice), false, 'the repair ends the decision: a queued one is withheld')
    const running = await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? taskOf(f.runtime, task.id) : undefined,
      'after the repair the pending task is dispatched normally', 6_000)
    assert.equal(running.attempt.ownerId, f.reviewer.id)

    // A changed violation is a new decision: the author now has no worktree at all.
    f.runtime.store.transaction(() => f.runtime.store.put('members', { ...f.runtime.store.get('members', f.author.id), workspace: '' }))
    f.propose({ title: 'Work for the author' })
    const second = await eventually(() => terminals()[1], 'a changed violation must wake the owner again', 6_000)
    assert.notEqual(second.notice.dedupKey, refused.notice.notice.dedupKey)
    assert.match(second.content, /has no provisioned isolated worktree/, 'the new decision names the new violation')
    assert.deepEqual([relevant(second), relevant(refused.notice)], [true, false], 'and only the violation the invariant lists is outstanding')
  } finally { await f.cleanup() }
})
