/**
 * Cross-task config hand-off owned by I3 (src/index.ts): the O3 cache-read
 * weight, O5 activity heartbeat and O4 budget warning thresholds are consumed
 * by src/harness-workers.ts (I4) and src/runtime.ts (I1). This pins the field
 * names, defaults and bounds both consumers code against.
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
