/** F15 (W10): a member's untracked dependency symlink must not block the next task preparation. */
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeRepo, Workspaces, git, readJson, runScenario } from './harness.mjs'

await runScenario({
  id: 'F15', title: 'An untracked dependency symlink does not block the next task preparation', invariants: ['I9', 'I13'],
  body: async () => {
    const { root, source } = await makeRepo('swarm-faults-f15', { '.gitignore': '/node_modules/\n', 'src/answer.txt': 'base\n' })
    const workspaces = new Workspaces({ workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv })
    try {
      const mission = { id: 'mission-f15', workspace: source }
      const member = { id: 'member-f15', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-f15') }
      const task = { id: 'task-f15', missionId: mission.id, epoch: 1, title: 'Prepare', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
      await workspaces.prepareTask(member, task, [])
      // Injection: the member installs the dependency symlink it needs to run checks.
      await mkdir(join(source, 'node_modules', 'dep'), { recursive: true })
      await writeFile(join(source, 'node_modules', 'dep', 'value.txt'), 'toolchain\n')
      const link = join(member.workspace, 'node_modules')
      await symlink(join(source, 'node_modules'), link)
      const status = await git(member.workspace, 'status', '--porcelain=v1', '--untracked-files=all')
      assert.match(status, /\?\? node_modules/, 'the injected dependency symlink is untracked and not ignored')
      // Pre-fix preparation refused with "Member workspace has uncommitted work".
      const next = { ...task, id: 'task-f15-next' }
      await workspaces.prepareTask(member, next, [])
      const record = await readJson(join(root, 'worktrees', mission.id, 'member-f15.workspace.json'))
      assert.equal(record.task.taskId, next.id, 'preparation proceeds past the dependency link')
      assert.equal((await lstat(link)).isSymbolicLink(), true, 'the dependency link is left untouched')
      assert.equal(await readFile(join(member.workspace, 'src', 'answer.txt'), 'utf8'), 'base\n')
      return { untracked: 'node_modules', nextTask: record.task.taskId }
    } finally { await workspaces.dispose(); await rm(root, { recursive: true, force: true }) }
  },
})
