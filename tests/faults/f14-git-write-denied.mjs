/** F14: a worker attempts a git commit in its worktree. A typed error names swarm_submit; submission still captures the workspace. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rm, writeFile } from 'node:fs/promises'
import { makeRepo, Workspaces, WorkspaceWorkers, setup, events, eventually, git, runScenario, taskOf } from './harness.mjs'
import { subprocessSeam } from '../subprocess-seam.mjs'

await runScenario({
  id: 'F14', title: 'A denied worker git write returns a typed error and never blocks artifact publication', invariants: ['I14'],
  body: async () => {
    const { root, source } = await makeRepo('swarm-faults-f14')
    const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv })
    const workers = new WorkspaceWorkers(workspaces)
    const f = await setup({ workspace: source, workers })
    const g = await setup()
    try {
      const task = f.propose()
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      assert.equal(workers.callbacks.guard(f.author.id, 'bash'), undefined, 'no denial exists before the fault')
      // Injection: the adapter records the failed worker-side git write.
      const runId = await workers.callbacks.toolRun(f.author.id, {
        tool: 'bash', arguments: { command: 'git commit -m "worker commit"' },
        result: { exitCode: 128, output: "fatal: Unable to create '/repo/.git/worktrees/author/index.lock': Operation not permitted" }, isError: true,
      })
      assert(runId, 'the failed run is host-recorded')
      const denied = taskOf(f.runtime, task.id).gitWriteDenied
      assert(denied, 'the denial is durably recorded on the attempt')
      assert.match(denied.command, /git commit/, 'the recorded command is the denied git write')
      assert.equal(denied.runId, runId)
      const denial = events(f.runtime, f.mission.id, 'task/git-write-denied')[0]
      assert(denial, 'the denial is audited')
      assert.equal(denial.data.taskId, task.id)
      assert.equal(denial.data.attemptId, claimed.attempt.id)
      assert.match(denial.data.command, /git commit/)
      const guard = workers.callbacks.guard(f.author.id, 'bash')
      assert.match(guard, /swarm_submit/, 'I14: the typed error names the supported artifact path')
      assert.match(guard, /index\.lock|EPERM|git metadata/, 'I14: the typed error names the denial')
      assert.doesNotMatch(guard, /^fatal:/, 'I14: the raw sandbox error is not the whole message')
      assert.equal(workers.callbacks.guard(f.author.id, 'swarm_submit'), undefined, 'I14: submission stays available')
      const queued = f.runtime.store.list('deliveries', f.mission.id).find(item => item.kind === 'control' && item.to === f.author.id && /swarm_submit/.test(item.content))
      assert(queued, 'the actionable notice is durably queued for the worker')
      assert.match(queued.content, /(cannot|could not) write git metadata/)
      const notice = await eventually(() => workers.deliveries.find(item => item.kind === 'control' && /swarm_submit/.test(item.content)), 'the notice reaches the worker')
      assert.match(notice.content, /swarm_submit/)
      // Recovery: submission never depends on a worker-side commit.
      const member = f.runtime.store.get('members', f.author.id)
      await writeFile(join(member.workspace, 'src', 'answer.txt'), 'fixed\n')
      const submitted = await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'published after the denied commit' })
      assert.equal(submitted.status, 'submitted', 'I14: publication succeeds without a worker commit')
      assert.match(submitted.artifact.commit, /^[a-f0-9]{40}$/)
      assert.equal(await git(member.workspace, 'show', `${submitted.artifact.commit}:src/answer.txt`), 'fixed', 'I14: the host-side capture includes the worker’s work')
      assert.equal(events(f.runtime, f.mission.id, 'task/submitted').length, 1)
      // Negative control: a read-only git command never claims the typed denial path.
      const other = g.propose()
      await g.runtime.claim(g.actor(g.author), g.mission.id, other.id)
      await g.workers.callbacks.toolRun(g.author.id, {
        tool: 'bash', arguments: { command: 'git status --porcelain' },
        result: { exitCode: 1, output: 'Operation not permitted' }, isError: true,
      })
      assert.equal(taskOf(g.runtime, other.id).gitWriteDenied, undefined, 'a read-only git failure is not a denied write')
      assert.equal(events(g.runtime, g.mission.id, 'task/git-write-denied').length, 0)
      return { deniedCommand: denied.command, runId, artifact: submitted.artifact.commit }
    } finally { await f.cleanup(); await g.cleanup(); await workspaces.dispose(); await rm(root, { recursive: true, force: true }) }
  },
})
