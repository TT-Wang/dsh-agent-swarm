/**
 * One owner for why a task is blocked. `blockCauses` (src/attempts.ts) derives
 * the set of causes holding for a task from its own fields; causes coexist and
 * clear independently, so no single stored discriminant can answer the
 * question. The stop barrier decides through `stopOutcome`, the restart path,
 * owner task control and the guard-chain board model read the same set.
 *
 * The first table is the multi-cause rows the barrier, restart, ceiling and
 * recovery tests build. The second is exhaustive: every combination of the
 * fields the barrier read, under every stop reason, must land exactly where the
 * inline barrier expression it replaced landed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { blockCauses, stopOutcome } from '../lib/attempts.js'
import { guardBoard } from './guard-model.mjs'
import { FakeWorkers, makeRuntime } from './faults/harness.mjs'

const DEFAULT_LIMIT = 3
const evidence = { refuted: 'refuted', verified: 'verified', challenged: 'challenged' }
const statusOf = id => evidence[id]
const causesOf = (row, limit = DEFAULT_LIMIT) => [...blockCauses(row, statusOf, limit)].sort()
const at = Date.now()
const findings = { dimension: 'maxFindings', used: 5, limit: 5, reason: 'Legacy ceiling', at }
const steps = { code: 'task_ceiling_exhausted', dimension: 'maxSteps', used: 2, limit: 1, reason: 'Task step allocation exhausted', at }
const artifact = { commit: 'immutable-rejected', baseCommit: 'base', workspace: '/isolated', changedPaths: ['src/a.ts'] }
const deterministic = { reason: 'Workspace requires repair', transient: false, attempts: 1 }
const backingOff = { reason: 'Workspace busy', transient: true, attempts: 1, retryAt: at + 1000 }
const deferred = { sourceTaskId: 'source', commit: 'c'.repeat(40), reason: 'Verification could not establish a verdict', at }

const ROWS = [
  // tests/rule-resource-review.test.mjs 'finding-ceiling migration retains a separate repair block'
  ['finding ceiling with a separate preparation block', { status: 'blocked', ceiling: findings, preparationFailure: deterministic, evidenceIds: [] }, ['preparation-failed', 'task-ceiling']],
  ['the same row once the restart retired its obsolete ceiling', { status: 'blocked', preparationFailure: deterministic, evidenceIds: [] }, ['preparation-failed']],
  // tests/rule-resource-review.test.mjs 'restart clears legacy finding ceilings without clearing ${separateBlock} policy'
  ['legacy finding ceiling alone', { status: 'blocked', ceiling: findings, evidenceIds: [] }, ['task-ceiling']],
  ['legacy finding ceiling on a rejected artifact', { status: 'blocked', ceiling: findings, artifact, evidenceIds: [] }, ['needs-replacement', 'task-ceiling']],
  ['legacy finding ceiling with refuted evidence', { status: 'blocked', ceiling: findings, evidenceIds: ['refuted'] }, ['refuted', 'task-ceiling']],
  ['step ceiling the restart keeps', { status: 'blocked', ceiling: { ...findings, dimension: 'maxSteps' }, evidenceIds: [] }, ['task-ceiling']],
  // tests/r18-workflow-fixes.test.mjs R18-4: a step ceiling fences the handle under reason 'resource'
  ['step ceiling fenced for a resource stop', { status: 'blocked', ceiling: steps, maxRecoveryAttempts: 2, evidenceIds: [] }, ['task-ceiling']],
  // tests/guard-terminals.test.mjs 'lease expiry x workspace capture' and tests/restart-repended.test.mjs R11-07
  ['running attempt whose recovery limit is already spent', { status: 'running', recoveryCount: 1, maxRecoveryAttempts: 1, evidenceIds: [] }, ['recovery-exhausted']],
  // tests/rule-resource-continuity.test.mjs 'finite recovery allocation can grow'
  ['blocked at a spent allocation of two', { status: 'blocked', recoveryCount: 2, maxRecoveryAttempts: 2, evidenceIds: [] }, ['recovery-exhausted']],
  ['the same allocation raised to four', { status: 'blocked', recoveryCount: 2, maxRecoveryAttempts: 4, evidenceIds: [] }, []],
  // tests/preparation-failure.test.mjs: a transient failure backs off, a deterministic one blocks
  ['transient preparation failure inside its backoff retry', { status: 'pending', preparationFailure: backingOff, evidenceIds: [] }, []],
  ['deterministic preparation failure', { status: 'blocked', preparationFailure: deterministic, evidenceIds: [] }, ['preparation-failed']],
  // tests/task-needs-replacement.test.mjs: rejected sources and invalidated submissions
  ['rejected source without evidence', { status: 'blocked', artifact, evidenceIds: [] }, ['needs-replacement']],
  ['rejected source whose evidence was refuted', { status: 'blocked', artifact, evidenceIds: ['verified', 'refuted'] }, ['needs-replacement', 'refuted']],
  ['submitted source awaiting its verdict', { status: 'submitted', artifact, evidenceIds: ['challenged'] }, []],
  // tests/rule-workspace-recovery.test.mjs: a review whose checks could not establish a verdict
  ['review deferred on an unreproducible check', { status: 'blocked', verificationRecovery: deferred, evidenceIds: [] }, ['review-deferred']],
  ['every cause at once', { status: 'blocked', ceiling: steps, preparationFailure: deterministic, verificationRecovery: deferred, artifact, evidenceIds: ['refuted'], recoveryCount: 5, maxRecoveryAttempts: 5 },
    ['needs-replacement', 'preparation-failed', 'recovery-exhausted', 'refuted', 'review-deferred', 'task-ceiling']],
  // Legacy rows: no evidence list, no recovery limit of their own.
  ['legacy row at the default recovery limit', { status: 'blocked', recoveryCount: DEFAULT_LIMIT }, ['recovery-exhausted']],
  ['legacy row under the default recovery limit', { status: 'blocked', recoveryCount: DEFAULT_LIMIT - 1 }, []],
]

test('blockCauses names every cause holding on the multi-cause rows the barrier and restart tests build', () => {
  for (const [label, row, expected] of ROWS) assert.deepEqual(causesOf(row), expected, label)
})

test('blockCauses reads evidence through the supplied status reader and the default limit it is given', () => {
  const seen = []
  blockCauses({ status: 'blocked', evidenceIds: ['a', 'b'] }, id => { seen.push(id); return undefined }, 1)
  assert.deepEqual(seen, ['a', 'b'])
  assert.deepEqual([...blockCauses({ status: 'blocked', recoveryCount: 1 }, () => undefined, 1)], ['recovery-exhausted'])
  assert.deepEqual([...blockCauses({ status: 'blocked', recoveryCount: 1 }, () => undefined, 2)], [])
})

/** The inline barrier expression `stopOutcome` replaced (src/attempts.ts at e8ac876), kept as the oracle. */
function previousBarrier(fresh, reason, limit = DEFAULT_LIMIT) {
  const recoveryExhausted = reason !== 'resource' && reason !== 'handoff' && reason !== 'invalidated' && (fresh.recoveryCount ?? 0) >= (fresh.maxRecoveryAttempts ?? limit)
  const exhausted = reason === 'invalidated' || recoveryExhausted || fresh.ceiling !== undefined || fresh.preparationFailure !== undefined || fresh.verificationRecovery !== undefined
    || (fresh.status === 'blocked' && fresh.artifact !== undefined)
    || (fresh.evidenceIds ?? []).some(evidenceId => statusOf(evidenceId) === 'refuted')
  return { blocked: exhausted, recoveryLimit: recoveryExhausted }
}

function* combinations() {
  for (const status of ['blocked', 'running', 'pending', 'cancelled', 'accepted'])
    for (const ceiling of [undefined, steps])
      for (const preparationFailure of [undefined, deterministic, backingOff])
        for (const verificationRecovery of [undefined, deferred])
          for (const withArtifact of [false, true])
            for (const evidenceIds of [undefined, [], ['verified'], ['challenged', 'refuted']])
              for (const recovery of [{}, { recoveryCount: 1, maxRecoveryAttempts: 2 }, { recoveryCount: 2, maxRecoveryAttempts: 2 }, { recoveryCount: DEFAULT_LIMIT }])
                yield { status, ceiling, preparationFailure, verificationRecovery, ...(withArtifact ? { artifact } : {}), evidenceIds, ...recovery }
}

test('the stop barrier lands exactly where the inline expression it replaced landed, for every cause combination and stop reason', () => {
  let compared = 0
  for (const row of combinations()) for (const reason of ['handoff', 'lease-expired', 'worker-closeout', 'resource', 'invalidated']) {
    const outcome = stopOutcome(blockCauses(row, statusOf, DEFAULT_LIMIT), reason)
    if (row.preparationFailure?.retryAt !== undefined) {
      // The one deliberate difference: a preparation failure still inside its
      // backoff retry is not a block cause. Since `assign` drops the record, no
      // stoppable attempt carries one; for a legacy row the barrier now decides
      // exactly as it would without the stale record.
      assert.deepEqual(outcome, previousBarrier({ ...row, preparationFailure: undefined }, reason), JSON.stringify({ row, reason }))
    } else assert.deepEqual(outcome, previousBarrier(row, reason), JSON.stringify({ row, reason }))
    compared++
  }
  assert.equal(compared, 5 * 2 * 3 * 2 * 2 * 4 * 4 * 5)
})

test('the recovery limit decides only the stops it is not exempted from', () => {
  const spent = blockCauses({ status: 'running', recoveryCount: 1, maxRecoveryAttempts: 1, evidenceIds: [] }, statusOf, DEFAULT_LIMIT)
  assert.deepEqual(stopOutcome(spent, 'lease-expired'), { blocked: true, recoveryLimit: true })
  assert.deepEqual(stopOutcome(spent, 'worker-closeout'), { blocked: true, recoveryLimit: true })
  assert.deepEqual(stopOutcome(spent, 'handoff'), { blocked: false, recoveryLimit: false })
  assert.deepEqual(stopOutcome(spent, 'resource'), { blocked: false, recoveryLimit: false })
  assert.deepEqual(stopOutcome(spent, 'invalidated'), { blocked: true, recoveryLimit: false })
  assert.deepEqual(stopOutcome(new Set(), 'lease-expired'), { blocked: false, recoveryLimit: false })
  assert.deepEqual(stopOutcome(new Set(['task-ceiling']), 'handoff'), { blocked: true, recoveryLimit: false })
})

test('the guard-chain board reads a preparation block from the recorded failure, not from the prose of task.output', async t => {
  const { dir: directory, runtime, budget } = await makeRuntime(t, {
    workers: new FakeWorkers({ artifact, checks: [], async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) } }),
    config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 300, maxTasksPerMember: DEFAULT_LIMIT, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxDurationMs: 3600000, maxTasks: 100 },
  })
  const owner = { sessionId: 'causes-owner' }
  const mission = runtime.create(owner, { title: 'Causes', objective: 'Classify blocks', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const propose = title => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title,
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'] })
  const put = (task, fields) => { const row = runtime.store.get('tasks', task.id); Object.assign(row, fields); runtime.store.transaction(() => runtime.store.put('tasks', row)) }
  // Resumed after its preparation was repaired, then blocked again for another
  // cause: the old failure prose is still the output, the failure record is gone.
  const stale = propose('Stale prose')
  put(stale, { status: 'blocked', recoveryCount: DEFAULT_LIMIT, output: 'Workspace or worker preparation failed: fixed long ago' })
  // Still blocked on its preparation failure, but a later transition rewrote the output.
  const rewritten = propose('Rewritten prose')
  put(rewritten, { status: 'blocked', preparationFailure: deterministic, output: 'Prerequisite source was challenged; inspect the new evidence and propose a replacement.' })
  // Backing off: pending, never a preparation block.
  const backing = propose('Backing off')
  put(backing, { status: 'pending', preparationFailure: backingOff, output: 'Workspace or worker preparation failed: busy\nThe host will retry after bounded backoff.' })
  const board = new Map(guardBoard(runtime, mission.id).tasks.map(row => [row.id, row]))
  assert.equal(board.get(stale.id).preparationExhausted, false, 'stale prose is not a live preparation block')
  assert.equal(board.get(rewritten.id).preparationExhausted, true, 'a recorded preparation failure is a block whatever the output says')
  assert.equal(board.get(backing.id).preparationExhausted, false)
})
