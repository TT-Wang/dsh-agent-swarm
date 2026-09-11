/** F13: a worker ends its turn with an open attempt and uncommitted work. Bounded nudges, then a real checkpoint. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rm, writeFile } from 'node:fs/promises'
import { makeRepo, Workspaces, WorkspaceWorkers, setup, events, eventually, git, runScenario, taskOf } from './harness.mjs'
import { subprocessSeam } from '../subprocess-seam.mjs'

await runScenario({
  id: 'F13', title: 'An idle worker with uncommitted work is nudged, checkpointed and resumed from the real commit', invariants: ['I13'],
  body: async () => {
    const { root, source } = await makeRepo('swarm-faults-f13')
    const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv })
    const workers = new WorkspaceWorkers(workspaces)
    const f = await setup({ workspace: source, workers, config: { tickMs: 3_600_000, maxIdleCloseouts: 2, leaseMs: 600_000 } })
    try {
      const task = f.propose()
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      const member = f.runtime.store.get('members', f.author.id)
      // Uncommitted worker progress in the real worktree.
      await writeFile(join(member.workspace, 'notes.txt'), 'uncommitted worker progress\n')
      assert.notEqual(await git(member.workspace, 'status', '--porcelain'), '', 'the workspace has uncommitted work before the fault')
      // Injection 1: the worker ends its turn while the attempt is still open.
      f.workers.idle.add(f.author.id)
      f.workers.callbacks.idle(f.author.id)
      await eventually(() => events(f.runtime, f.mission.id, 'task/closeout-nudged')[0], 'the first close-out nudge')
      const afterNudge = taskOf(f.runtime, task.id)
      assert.equal(afterNudge.status, 'running', 'the first nudge does not fence the attempt')
      assert.equal(afterNudge.attempt.id, claimed.attempt.id)
      assert.equal(afterNudge.closeout.nudges, 1)
      assert.equal(f.workers.captured.length, 0, 'no checkpoint before the bound is exhausted')
      const nudgeDelivery = f.workers.deliveries.find(item => item.kind === 'control' && /still open but your turn ended/.test(item.content))
      assert(nudgeDelivery, 'the worker is re-woken with a durable control delivery')
      assert.match(nudgeDelivery.content, /swarm_submit/)
      assert.match(nudgeDelivery.content, new RegExp(claimed.attempt.id))
      // Injection 2: the worker still does not act; the bound is reached.
      f.workers.callbacks.idle(f.author.id)
      await eventually(() => events(f.runtime, f.mission.id, 'task/closeout-nudged').length === 2, 'the second close-out nudge')
      assert.equal(taskOf(f.runtime, task.id).closeout.nudges, 2, 'nudges are bounded by maxIdleCloseouts')
      // Injection 3: the bound is exhausted, so the workspace is checkpointed.
      f.workers.callbacks.idle(f.author.id)
      const abandoned = await eventually(() => events(f.runtime, f.mission.id, 'task/closeout-abandoned')[0], 'the exhausted close-out checkpoints the workspace')
      assert.equal(f.workers.captured.length, 1, 'the workspace is checkpointed exactly once')
      assert.equal(f.workers.captured[0].attemptId, claimed.attempt.id, 'the checkpoint belongs to the open attempt')
      const checkpoint = abandoned.data.commit
      assert.match(checkpoint, /^[a-f0-9]{40}$/, 'I13: the checkpoint is a real commit')
      assert.equal(await git(member.workspace, 'show', `${checkpoint}:notes.txt`), 'uncommitted worker progress', 'I13: the checkpoint contains the uncommitted work')
      // Recovery: the same member is preferred and resumes from the checkpoint.
      f.workers.autoIdle = true
      const resumed = await eventually(() => {
        const current = taskOf(f.runtime, task.id)
        return current.status === 'running' && current.attempt?.id !== claimed.attempt.id ? current : undefined
      }, 'the checkpointed task resumes on the same member')
      assert.equal(resumed.attempt.ownerId, f.author.id, 'I13: the same member is preferred')
      assert.equal(resumed.assigneeId, f.author.id)
      assert.equal(resumed.plannedAssigneeId, f.author.id)
      assert.equal(resumed.recoveryCount, 1, 'I13: one abandoned attempt spends exactly one recovery credit')
      assert.equal(resumed.checkpoint.commit, checkpoint, 'the durable checkpoint survives the reassignment')
      assert.equal(await git(member.workspace, 'show', `${resumed.checkpoint.commit}:notes.txt`), 'uncommitted worker progress', 'I13: the resumed workspace carries the partial work')
      assert.equal(events(f.runtime, f.mission.id, 'task/closeout-ready').length, 1)
      assert.equal(events(f.runtime, f.mission.id, 'task/closeout-failed').length, 0)
      assert(f.workers.stopped.includes(f.author.id), 'the abandoned handle is stopped before reassignment')
      return { nudges: 2, checkpoint, attemptResumed: resumed.attempt.id, credits: resumed.recoveryCount }
    } finally { await f.cleanup(); await workspaces.dispose(); await rm(root, { recursive: true, force: true }) }
  },
})
