/**
 * Cross-task config hand-off owned by I3 (src/index.ts): the O3 cache-read
 * weight, O5 activity heartbeat and O4 budget warning thresholds are consumed
 * by src/harness-workers.ts (I4) and src/runtime.ts (I1). This pins the field
 * names, defaults and bounds both consumers code against. Round 11 adds the
 * R11-19 per-host check concurrency and the R11-13 read-through opt-in, both of
 * which the composition spreads into the owned `Workspaces`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/index.js'
import { SwarmRuntime } from '../lib/runtime.js'
import { FakeWorkers } from './faults/harness.mjs'

const base = { statePath: '/tmp/swarm-config/swarm.sqlite', workspacesRoot: '/tmp/swarm-config/workspaces' }

test('config exposes the O3/O4/O5 accounting and warning defaults with enforced bounds', () => {
  const config = Config(base)
  assert.equal(config.cacheReadWeight, 0.1, 'O3 default cache-read cost weight')
  assert.equal(config.activityHeartbeatMs, 1000, 'O5 default lease-liveness heartbeat')
  assert.deepEqual(config.budgetWarnAt, [0.7, 0.9], 'O4 default approaching-limit thresholds')
  const overridden = Config({ ...base, cacheReadWeight: 0, activityHeartbeatMs: 0, budgetWarnAt: [0.5] })
  assert.equal(overridden.cacheReadWeight, 0, 'a zero weight is a valid explicit choice')
  assert.equal(overridden.activityHeartbeatMs, 0, 'zero disables the heartbeat timer')
  assert.deepEqual(overridden.budgetWarnAt, [0.5])
  assert.throws(() => Config({ ...base, cacheReadWeight: 2 }))
  assert.throws(() => Config({ ...base, activityHeartbeatMs: -1 }))
  assert.throws(() => Config({ ...base, budgetWarnAt: [1.5] }))
})

test('config exposes the round-11 check semaphore and dependency-link opt-in', () => {
  const config = Config(base)
  assert.equal(config.checkConcurrency, 2, 'R11-19 default declared-check executions per host')
  assert.equal(config.verificationDependencyMode, 'link', 'the schema keeps the documented link/copy choice')
  assert.equal(config.allowDependencyLinkReads, false, 'R11-13: a read-through link needs an explicit human opt-in')
  const overridden = Config({ ...base, checkConcurrency: 5, verificationDependencyMode: 'copy', allowDependencyLinkReads: true })
  assert.equal(overridden.checkConcurrency, 5)
  assert.equal(overridden.verificationDependencyMode, 'copy')
  assert.equal(overridden.allowDependencyLinkReads, true)
  assert.throws(() => Config({ ...base, checkConcurrency: 0 }))
})

test('the declared-check budget default fits a real check, and a declared value still wins', () => {
  // Round 14 measured this project's own declared checks (`npm run typecheck &&
  // npm run build && node --test <file>`) at 67-111 s. The former 60 s default
  // cancelled them mid-run, and host git operations shared the same knob, so the
  // verification checkout died with the check and three reviewers could not record
  // a verdict for artifacts that were fine.
  const config = Config(base)
  assert.ok(config.checkTimeoutMs >= 300000, `the default check budget must exceed a real check's runtime, saw ${config.checkTimeoutMs}`)
  assert.equal(Config({ ...base, checkTimeoutMs: 900000 }).checkTimeoutMs, 900000, 'a declared budget still wins over the default')
})

test('a non-function now in a runtime config built from the profile falls back to the default clock', async () => {
  // Config keeps unknown keys, so a runtime built from `{ ...Config(profile) }`
  // took any `now` value as its clock and threw at the first read.
  for (const now of [5, 'x']) {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-config-now-'))
    const runtime = new SwarmRuntime({ ...Config({ statePath: join(dir, 'swarm.sqlite'), workspacesRoot: join(dir, 'workspaces'), now }), maxTasksPerMember: 3 }, new FakeWorkers())
    try {
      await runtime.start()
      const before = Date.now()
      const mission = runtime.create({ sessionId: 'config-owner' }, { title: 'Clock', objective: 'Run on the default clock', workspace: dir, scope: ['src/'], acceptance: ['works'],
        budget: { maxTokens: 1000, maxSteps: 10, maxWorkers: 1, maxDurationMs: 60000, maxTasks: 5, maxExperiments: 0 } })
      assert.equal(mission.status, 'active', `now: ${JSON.stringify(now)}`)
      assert.ok(mission.createdAt >= before && mission.createdAt <= Date.now(), 'the mission is stamped by the default clock')
    } finally { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) }
  }
})
