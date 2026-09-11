/** F10: two members and two missions prepare worktrees concurrently in one repository. No git 128, no half-written metadata. */
import assert from 'node:assert/strict'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { makeRepo, Workspaces, git, runScenario } from './harness.mjs'
import { subprocessSeam } from '../subprocess-seam.mjs'

await runScenario({
  id: 'F10', title: 'Concurrent worktree preparation in one repository is serialized and never corrupts git metadata', invariants: ['I9'],
  body: async () => {
    const { root, source } = await makeRepo('swarm-faults-f10')
    const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv })
    try {
      const missionOne = { id: 'mission-one', workspace: source }
      const missionTwo = { id: 'mission-two', workspace: source }
      const nativeGit = workspaces.git.bind(workspaces)
      const isMutation = args => args[0] === 'worktree' && ['add', 'remove', 'prune', 'move'].includes(args[1])
      let inFlight = 0
      let maxInFlight = 0
      let mutations = 0
      let active = 0
      let maxActive = 0
      let arrivals = 0
      let releaseSecond
      const secondArrived = new Promise(resolve => { releaseSecond = resolve })
      // Injection: hold the first metadata mutation until a second one arrives.
      // Pre-fix both preparations run `git worktree add` concurrently here; after
      // the per-common-dir queue the second can only arrive after the first ends.
      workspaces.git = async (cwd, args, ...rest) => {
        const mutating = isMutation(args)
        if (mutating) {
          mutations += 1
          active += 1
          maxActive = Math.max(maxActive, active)
          arrivals += 1
          if (arrivals >= 2) releaseSecond()
          else await Promise.race([secondArrived, new Promise(resolve => setTimeout(resolve, 300))])
        }
        try { return await nativeGit(cwd, args, ...rest) } finally { if (mutating) active -= 1 }
      }
      const prepare = async (mission, id) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try { return await workspaces.prepareWorkspace(mission, id) } finally { inFlight -= 1 }
      }
      const [one] = await Promise.all([workspaces.prepareBaseline(missionOne), workspaces.prepareBaseline(missionTwo)])
      const prepared = await Promise.all([
        prepare(missionOne, 'one-a'), prepare(missionTwo, 'two-b'), prepare(missionOne, 'one-c'), prepare(missionTwo, 'two-d'),
      ])
      assert(maxInFlight >= 2, 'the concurrent-preparation injection actually overlapped')
      assert(mutations >= 4, `several worktree metadata mutations were attempted, saw ${mutations}`)
      assert.equal(maxActive, 1, 'I9: git worktree metadata mutation is serialized per repository')
      for (const workspace of prepared) assert.equal(await git(workspace, 'rev-parse', 'HEAD'), one.snapshotCommit, 'I9: every worktree starts at its mission snapshot')
      const names = await readdir(join(source, '.git', 'worktrees'))
      assert(names.length >= 5, `expected the planning and member worktrees, saw ${names.length}`)
      for (const name of names) {
        assert.equal((await readFile(join(source, '.git', 'worktrees', name, 'commondir'), 'utf8')).trim(), '../..', `I9: ${name} metadata is complete`)
      }
      return { maxConcurrentPreparations: maxInFlight, maxConcurrentMutations: maxActive, mutations, worktrees: names.length }
    } finally { await workspaces.dispose(); await rm(root, { recursive: true, force: true }) }
  },
})
