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
import { Config } from '../lib/index.js'

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
