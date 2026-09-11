/** F17 (W13): a slow worker stop must not re-pend or dispatch an abandoned attempt before quiescence. */
import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeRepo, Workspaces, WorkspaceWorkers, events, eventually, git, runScenario, setup, taskOf } from './harness.mjs'
import { subprocessSeam } from '../subprocess-seam.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

await runScenario({
  id: 'F17', title: 'Close-out ordering holds while the worker stop is still in flight', invariants: ['I13'],
  body: async () => {
    const { root, source } = await makeRepo('swarm-faults-f17', { 'src/answer.txt': 'base\n' })
    const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv })
    const workers = new WorkspaceWorkers(workspaces)
    const f = await setup({ workspace: source, workers, config: { tickMs: 3_600_000, maxIdleCloseouts: 1, leaseMs: 600_000 } })
    try {
      const task = f.propose()
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      const member = f.runtime.store.get('members', f.author.id)
      await writeFile(join(member.workspace, 'notes.txt'), 'uncommitted worker progress\n')
      assert.notEqual(await git(member.workspace, 'status', '--porcelain'), '', 'the workspace has uncommitted work before the fault')
      f.workers.idle.add(f.author.id)
      f.workers.callbacks.idle(f.author.id)
      await eventually(() => events(f.runtime, f.mission.id, 'task/closeout-nudged')[0], 'the bounded close-out nudge')
      // Injection: the worker handle stop does not resolve. The runtime must not
      // re-pend, re-claim or dispatch the task until quiescence (W13 ordering).
      const gate = deferred()
      const nativeStop = workers.stop.bind(workers)
      workers.stop = async id => { await gate.promise; await nativeStop(id) }
      f.workers.callbacks.idle(f.author.id)
      const abandoned = await eventually(() => events(f.runtime, f.mission.id, 'task/closeout-abandoned')[0], 'the exhausted close-out checkpoints the workspace')
      const blocked = taskOf(f.runtime, task.id)
      assert.equal(blocked.status, 'blocked', 'the abandoned attempt is fenced')
      assert.equal(blocked.attempt, undefined)
      assert.equal(blocked.resumeAfterStop.reason, 'worker-closeout')
      assert.equal(blocked.resumeAfterStop.epoch, blocked.epoch)
      assert.equal(events(f.runtime, f.mission.id, 'task/closeout-ready').length, 0, 'no re-pend before the stop resolves')
      assert.equal(f.workers.stopped.includes(f.author.id), false, 'the injected stop is still in flight')
      assert.match(abandoned.data.commit, /^[a-f0-9]{40}$/, 'the checkpoint is a real commit')
      assert.equal(await git(member.workspace, 'show', `${abandoned.data.commit}:notes.txt`), 'uncommitted worker progress', 'the checkpoint contains the uncommitted work')
      // Release the stop: only now does the durable ready transition follow.
      gate.resolve()
      await eventually(() => events(f.runtime, f.mission.id, 'task/closeout-ready').length === 1, 'the ready transition follows the stop')
      assert.equal(taskOf(f.runtime, task.id).status, 'pending')
      assert.equal(taskOf(f.runtime, task.id).resumeAfterStop, undefined)
      f.workers.autoIdle = true
      const resumed = await eventually(() => {
        const current = taskOf(f.runtime, task.id)
        return current.status === 'running' && current.attempt?.id !== claimed.attempt.id ? current : undefined
      }, 'the checkpointed task resumes on the same member')
      assert.equal(resumed.attempt.ownerId, f.author.id)
      assert.equal(resumed.recoveryCount, 1, 'the abandoned attempt spends exactly one recovery credit')
      assert.equal(resumed.checkpoint.commit, abandoned.data.commit, 'the durable checkpoint survives the reassignment')
      return { checkpoint: abandoned.data.commit, attemptResumed: resumed.attempt.id }
    } finally { await f.cleanup(); await workspaces.dispose(); await rm(root, { recursive: true, force: true }) }
  },
})
