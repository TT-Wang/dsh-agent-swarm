/** F16 (W11): a dependency link — symlink or real untracked directory — is never artifact content. */
import assert from 'node:assert/strict'
import { lstat, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeRepo, Workspaces, git, runScenario } from './harness.mjs'
import { subprocessSeam } from '../subprocess-seam.mjs'

await runScenario({
  id: 'F16', title: 'A dependency link or directory is excluded from capture instead of failing as out-of-scope work', invariants: ['I9', 'I13'],
  body: async () => {
    const { root, source } = await makeRepo('swarm-faults-f16', { '.gitignore': '/node_modules/\n', 'src/answer.txt': 'base\n' })
    const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv })
    try {
      const mission = { id: 'mission-f16', workspace: source }
      const member = { id: 'member-f16', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-f16') }
      const task = { id: 'task-f16', missionId: mission.id, epoch: 1, title: 'Capture', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
      await workspaces.prepareTask(member, task, [])
      // Injection 1: the member dependency symlink is present when capture runs.
      await mkdir(join(source, 'node_modules', 'dep'), { recursive: true })
      await writeFile(join(source, 'node_modules', 'dep', 'value.txt'), 'toolchain\n')
      const link = join(member.workspace, 'node_modules')
      await symlink(join(source, 'node_modules'), link)
      await writeFile(join(member.workspace, 'src', 'answer.txt'), 'scoped work\n')
      assert.match(await git(member.workspace, 'status', '--porcelain=v1', '--untracked-files=all'), /\?\? node_modules/, 'the injected link is untracked')
      // Pre-fix capture threw "Artifact changes path outside task scope: node_modules".
      const artifact = await workspaces.captureArtifact(member, task)
      assert.deepEqual(artifact.changedPaths, ['src/answer.txt'], 'the dependency link is not an artifact change')
      assert.equal(await git(member.workspace, 'ls-files', '--', 'node_modules'), '', 'the link is never committed')
      assert.equal((await lstat(link)).isSymbolicLink(), true, 'the link stays in the workspace')
      // Injection 2: a real untracked dependency directory (not ignored) instead of a link.
      await rm(link)
      await mkdir(join(member.workspace, 'vendor', 'node_modules', 'dep'), { recursive: true })
      await writeFile(join(member.workspace, 'vendor', 'node_modules', 'dep', 'value.txt'), 'vendored\n')
      const next = { ...task, id: 'task-f16-next' }
      await workspaces.prepareTask(member, next, [])
      assert.match(await git(member.workspace, 'status', '--porcelain=v1', '--untracked-files=all'), /\?\? vendor\/node_modules\/dep\/value\.txt/, 'the injected directory is untracked and not ignored')
      await writeFile(join(member.workspace, 'src', 'answer.txt'), 'directory work\n')
      const second = await workspaces.captureArtifact(member, next)
      assert.deepEqual(second.changedPaths, ['src/answer.txt'], 'dependency directory content is not an artifact change')
      assert.equal(await git(member.workspace, 'ls-files', '--', 'vendor'), '', 'dependency directory content is never committed')
      return { linkCommit: artifact.commit, directoryCommit: second.commit }
    } finally { await workspaces.dispose(); await rm(root, { recursive: true, force: true }) }
  },
})
