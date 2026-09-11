/** F6: task workspace owner moved on before capture. The task re-prepares from the recorded base. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { makeRepo, readJson, writeJson, Workspaces, git, runScenario } from './harness.mjs'
import { subprocessSeam } from '../subprocess-seam.mjs'

await runScenario({
  id: 'F6', title: 'A task whose recorded owner moved on recovers from its recorded base', invariants: ['I1', 'I3'],
  body: async () => {
    const { root, source, head } = await makeRepo('swarm-faults-f6')
    const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv })
    try {
      const mission = { id: 'mission-f6', workspace: source }
      const first = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
      const task = { id: 'task-f6', missionId: mission.id, epoch: 1, title: 'Recover answer', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
      await workspaces.prepareTask(first, task, [])
      // Injection: the recorded owner moves on to another task before capture.
      await workspaces.prepareTask(first, { ...task, id: 'task-next' }, [])
      // Restore the durable record the pre-fix head leaves behind: base commit, no captured commit.
      const recordPath = join(root, 'worktrees', mission.id, 'tasks', `${task.id}.json`)
      await writeJson(recordPath, { version: 1, missionId: mission.id, memberId: first.id, workspace: first.workspace, task: { taskId: task.id, epoch: 1, baseCommit: head } })
      const legacy = await readJson(recordPath)
      assert.equal(legacy.task.capturedCommit, undefined, 'the injected state has no immutable checkpoint')
      assert.equal(legacy.task.baseCommit, head, 'the injected state records a base commit')
      assert.equal(legacy.memberId, first.id, 'the injected state records the moved-on owner')
      const movedOn = await readJson(join(root, 'worktrees', mission.id, `${first.id}.workspace.json`))
      assert.equal(movedOn.task.taskId, 'task-next', 'the recorded owner has moved on to another task')
      // Recovery: a different member prepares the task from the recorded base instead of dead-ending.
      const second = { id: 'member-two', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-two') }
      await workspaces.prepareTask(second, { ...task, epoch: 2 }, [])
      assert.equal(await git(second.workspace, 'rev-parse', 'HEAD'), head, 'I1: the replacement attempt starts at the recorded base')
      const recovered = await readJson(recordPath)
      assert.equal(recovered.memberId, second.id, 'I3: a fresh workspace record names the new attempt owner')
      assert.equal(recovered.task.epoch, 2, 'the recovered record is fenced to the new epoch')
      assert.equal(recovered.task.baseCommit, head, 'the recorded base is preserved')
      return { baseCommit: head, from: first.id, to: second.id }
    } finally { await workspaces.dispose(); await rm(root, { recursive: true, force: true }) }
  },
})
