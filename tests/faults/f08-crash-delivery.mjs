/** F8: host crash during delivery apply. Replay is idempotent: no double-apply, no lost receipt. */
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeRepo, Workspaces, WorkspaceWorkers, setup, runNode, runScenario, MISSION_ACCEPTANCE } from './harness.mjs'

await runScenario({
  id: 'F8', title: 'A SIGKILL after the delivery effect but before the receipt replays idempotently', invariants: ['I4'],
  body: async () => {
    const { root, source } = await makeRepo('swarm-faults-f8', { 'value.cjs': 'module.exports = 1\n' })
    const workspacesRoot = join(root, 'worktrees')
    const workspaces = new Workspaces({ workspacesRoot, checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv })
    const workers = new WorkspaceWorkers(workspaces)
    const stateDir = join(root, 'state')
    await mkdir(stateDir, { recursive: true })
    const marker = join(root, 'apply-marker.json')
    const f = await setup({ workspace: source, workers, config: { statePath: join(stateDir, 'swarm.sqlite'), leaseMs: 600_000 }, acceptance: ['value is two'], checks: ['true'] })
    let missionId
    let artifact
    try {
      assert(f.runtime.snapshot(f.owner, f.mission.id).mission.baseline, 'the delivery baseline is recorded')
      const task = f.propose()
      const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
      const member = f.runtime.store.get('members', f.author.id)
      await writeFile(join(member.workspace, 'value.cjs'), 'module.exports = 2\n')
      const submitted = await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'value is two' })
      artifact = submitted.artifact.commit
      const review = f.runtime.propose(f.owner, f.mission.id, {
        workstreamId: f.stream.id, title: 'Review value two', objective: 'Independent review', kind: 'verification',
        reviewOf: task.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
      })
      const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
      await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
      const mission = f.runtime.store.get('missions', f.mission.id)
      mission.status = 'completed'; mission.reason = 'F8: delivery crash injection'
      f.runtime.store.transaction(() => f.runtime.store.put('missions', mission))
      missionId = f.mission.id
    } finally { await f.cleanup() }
    try {
      const crashed = await runNode(['tests/faults/driver.mjs', 'f8-crash', '--state', stateDir, '--workspace', source, '--worktrees', workspacesRoot, '--mission', missionId, '--marker', marker])
      assert.equal(crashed.signal, 'SIGKILL', `the host was killed during delivery apply: ${crashed.stderr.slice(0, 400)}`)
      const injected = JSON.parse(await readFile(marker, 'utf8'))
      assert.equal(injected.phase, 'f8-crash')
      assert.equal(injected.result.status, 'applied', 'the injected crash landed after the effect was applied')
      assert(injected.result.changedPaths.includes('value.cjs'), 'the applied delta is the artifact')
      assert.equal(await readFile(join(source, 'value.cjs'), 'utf8'), 'module.exports = 2\n', 'the effect is materialized before the crash')
      const replayed = await runNode(['tests/faults/driver.mjs', 'f8-replay', '--state', stateDir, '--workspace', source, '--worktrees', workspacesRoot, '--mission', missionId])
      assert.equal(replayed.code, 0, `the replay host exits cleanly: ${replayed.stderr.slice(0, 400)}`)
      const state = JSON.parse(replayed.stdout.trim().split('\n').at(-1))
      assert.equal(state.status, 'applied', 'I4: the replay is accepted as already applied')
      assert.equal(state.appliedDelivery?.resultCommit, artifact, 'I4: the receipt names the exact result commit')
      assert.equal(state.appliedEvents, 1, 'I4: the apply is recorded exactly once, never twice')
      assert.equal(await readFile(join(source, 'value.cjs'), 'utf8'), 'module.exports = 2\n', 'I4: the effect is not duplicated or lost')
      return { artifact, appliedEvents: state.appliedEvents, crashedAfter: injected.result.status }
    } finally { await workspaces.dispose(); await rm(root, { recursive: true, force: true }) }
  },
})
