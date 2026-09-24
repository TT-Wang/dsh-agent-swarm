/**
 * T5 / D1 + W14 admission contract: per-task ceilings, objective prose that
 * never refuses a plan, and host-only check classification. Runtime
 * enforcement of the ceiling is T5b; these tests pin the contract T5b consumes
 * and every admission rejection T5 adds.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { planAdvisories, validatePlan } from '../lib/plans.js'
import { FakeWorkers, budget as defaultBudget, makeRuntime, setup } from './faults/harness.mjs'
import {
  DEFAULT_TASK_MAX_FINDINGS, DEFAULT_TASK_MAX_STEPS, classifyCheck, taskCeilingBlock, taskCeilingExhaustion,
} from '../lib/admission.js'

const budget = { ...defaultBudget, maxTokens: 100000, maxSteps: 100, maxDurationMs: 60000, maxTasks: 12, maxExperiments: 2 }

function plan(workspace, overrides = {}) {
  return {
    title: 'Editable plan', objective: 'Deliver verified code', workspace, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation' }, { key: 'reviewer', name: 'Reviewer', role: 'verification' }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify artifact', kind: 'verification', outputs: [],
        scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'code' },
      { key: 'code', workstreamKey: 'main', title: 'Deliver', objective: 'Implement change', kind: 'integration', outputs: [],
        scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'] },
    ],
    ...overrides,
  }
}

test('every admitted task carries its own step and finding ceiling; explicit values survive', () => {
  const input = plan('/workspace', { budget: { ...budget, maxSteps: 200 } })
  input.tasks[1].maxSteps = 7
  input.tasks[1].maxFindings = 3
  const before = structuredClone(input)
  const admitted = validatePlan(input)
  assert.deepEqual(input, before, 'validation does not mutate the supplied plan')
  for (const task of admitted.tasks) {
    assert.ok(Number.isSafeInteger(task.maxSteps) && task.maxSteps > 0, `task ${task.key} carries a positive step ceiling`)
    assert.ok(Number.isSafeInteger(task.maxFindings) && task.maxFindings > 0, `task ${task.key} carries a positive finding ceiling`)
  }
  assert.equal(admitted.tasks[1].maxSteps, 7, 'an explicit ceiling is preserved')
  assert.equal(admitted.tasks[1].maxFindings, 3)
  assert.equal(admitted.tasks[0].maxSteps, DEFAULT_TASK_MAX_STEPS, 'a missing ceiling derives the bounded default when the budget allows it')
  assert.equal(admitted.tasks[0].maxFindings, DEFAULT_TASK_MAX_FINDINGS)
  const small = plan('/workspace', { budget: { ...budget, maxSteps: 5 } })
  assert.equal(validatePlan(small).tasks[0].maxSteps, 5, 'the step default is bounded by the mission budget')
})

test('the ceiling defaults bound runaway work without blocking real work', () => {
  assert.equal(DEFAULT_TASK_MAX_STEPS, 150, 'the step default is pinned: a normal implementation or integration must fit')
  assert.equal(DEFAULT_TASK_MAX_FINDINGS, 50, 'the finding default is pinned')
  const admitted = validatePlan(plan('/workspace', { budget: { ...budget, maxSteps: 200 } }))
  assert.equal(admitted.tasks[0].maxSteps, 150)
  assert.equal(admitted.tasks[0].maxFindings, 50)
  const capped = plan('/workspace', { budget: { ...budget, maxSteps: 120 } })
  assert.equal(validatePlan(capped).tasks[0].maxSteps, 120, 'the mission step budget still caps the default')
  const explicit = plan('/workspace')
  explicit.tasks[1].maxSteps = 25
  explicit.tasks[1].maxFindings = 7
  const overridden = validatePlan(explicit)
  assert.equal(overridden.tasks[1].maxSteps, 25, 'an explicit per-task value still overrides the default')
  assert.equal(overridden.tasks[1].maxFindings, 7)
  const invalid = plan('/workspace')
  invalid.tasks[1].maxSteps = 0
  assert.throws(() => validatePlan(invalid), /\[task_ceiling_invalid\]/)
  const overBudget = plan('/workspace', { budget: { ...budget, maxSteps: 120 } })
  overBudget.tasks[1].maxSteps = 121
  assert.throws(() => validatePlan(overBudget), /\[task_ceiling_exceeds_mission_budget\]/)
})

test('invalid or unbounded per-task ceilings are rejected with machine-checkable codes', () => {
  for (const [field, value, code] of [
    ['maxSteps', 0, 'task_ceiling_invalid'],
    ['maxSteps', -1, 'task_ceiling_invalid'],
    ['maxSteps', 1.5, 'task_ceiling_invalid'],
    ['maxFindings', 0, 'task_ceiling_invalid'],
    ['maxFindings', 'many', 'task_ceiling_invalid'],
    ['maxSteps', 101, 'task_ceiling_exceeds_mission_budget'],
  ]) {
    const input = plan('/workspace')
    input.tasks[1][field] = value
    assert.throws(() => validatePlan(input), error => {
      assert.match(error.message, new RegExp(`\\[${code}\\]`), error.message)
      assert.match(error.message, /same task\/request/, 'the repair instruction is part of the diagnostic')
      return true
    }, `${field}=${String(value)} must be rejected`)
  }
})

test('the ceiling contract blocks a task at its own limit with a durable, machine-checkable reason', () => {
  assert.equal(taskCeilingExhaustion({ maxSteps: 3, maxFindings: 2, usedSteps: 2, evidenceIds: [] }), undefined)
  assert.equal(taskCeilingExhaustion({}), undefined, 'legacy tasks without ceilings never block on one')
  const stepBlock = taskCeilingBlock({ maxSteps: 3, maxFindings: 2, usedSteps: 3, evidenceIds: [] }, 1700000000000)
  assert.deepEqual({ ...stepBlock, reason: undefined }, { dimension: 'maxSteps', limit: 3, used: 3, code: 'task_ceiling_exhausted', reason: undefined, at: 1700000000000 })
  assert.match(stepBlock.reason, /maxSteps 3\/3/)
  assert.match(stepBlock.reason, /swarm_budget.*taskId.*taskBudget.*reason/)
  const findingBlock = taskCeilingBlock({ maxSteps: 10, maxFindings: 2, usedSteps: 4, evidenceIds: ['e1', 'e2'] })
  assert.equal(findingBlock, undefined, 'finding estimates prompt review without blocking submission')
  const both = taskCeilingBlock({ maxSteps: 1, maxFindings: 1, usedSteps: 1, evidenceIds: ['e1'] })
  assert.equal(both.dimension, 'maxSteps', 'steps take precedence when both ceilings are exhausted')
  assert.deepEqual(JSON.parse(JSON.stringify(stepBlock)), stepBlock, 'the durable block reason survives serialization')
  // The contract T5b enforces: a task stops at its own ceiling, so the mission
  // step budget stays untouched by the runaway task.
  const task = { maxSteps: 3, maxFindings: 5, usedSteps: 0, evidenceIds: [] }
  let missionUsedSteps = 0
  while (missionUsedSteps < budget.maxSteps) {
    const block = taskCeilingBlock(task)
    if (block) { assert.equal(block.code, 'task_ceiling_exhausted'); break }
    task.usedSteps += 1; missionUsedSteps += 1
  }
  assert.equal(task.usedSteps, 3)
  assert.equal(missionUsedSteps, 3)
  assert.ok(missionUsedSteps < budget.maxSteps, 'the task ceiling binds before the mission budget')
})

test('objective prose that names paths neither refuses a plan nor yields a path hint', () => {
  const input = plan('/workspace')
  input.tasks[1].objective = 'Add a file under `docs/` describing the change and implement it.'
  assert.doesNotThrow(() => validatePlan(input))
  assert.deepEqual(planAdvisories(input).filter(item => item.code !== 'check_preflight'), [], 'objective prose yields no path hint')
  const mission = plan('/workspace', { objective: 'Add `docs/design-notes.md` and deliver verified code' })
  assert.doesNotThrow(() => validatePlan(mission), 'mission-level prose is not read for paths either')
  assert.deepEqual(planAdvisories(mission).filter(item => item.code !== 'check_preflight'), [])
})

test('check admission inspects actual commands without a project-specific name veto', () => {
  for (const command of ['npm run verify', 'npm run test:harness', 'node scripts/smoke-web.mjs', 'node tests/verification-isolation.mjs']) {
    assert.equal(classifyCheck(command).runnable, 'worker', command)
    const input = plan('/workspace'); input.tasks[1].checks = [command]
    assert.doesNotThrow(() => validatePlan(input))
  }
  const nested = plan('/workspace'); nested.tasks[1].checks = ['sandbox-exec -p rule node --test']
  assert.throws(() => validatePlan(nested), /check_requires_host/)
  assert.equal(classifyCheck('npm run typecheck && node --test tests/*.test.mjs').runnable, 'worker')
})

test('existing cycle, missing-review, uncovered-acceptance and integration-topology rejections remain green', async t => {
  const cyclic = plan('/workspace')
  cyclic.tasks[0].dependencies = ['code']
  cyclic.tasks[1].dependencies = ['review']
  assert.throws(() => validatePlan(cyclic), /dependency\/review cycle/)
  const missingReview = plan('/workspace')
  delete missingReview.tasks[0].reviewOf
  assert.throws(() => validatePlan(missingReview), /reviewOf must name the existing source task/)

  const { dir: directory, runtime } = await makeRuntime(t, {
    workers: new FakeWorkers({ async prepareWorkspace(mission, id) { return join(mission.workspace, id) } }),
    config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 100, checkTimeoutMs: undefined },
  })
  const owner = { sessionId: 'admission-owner' }
  const automatic = () => ({
    title: 'Automatic delivery', objective: 'Deliver verified code', workspace: directory, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation', maxOutputTokens: 4096 }, { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [
      { key: 'deliver', workstreamKey: 'main', title: 'Deliver', objective: 'Implement final change', kind: 'implementation', outputs: [], scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'], maxRecoveryAttempts: 5, checkTimeoutMs: 45000 },
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify immutable artifact', kind: 'verification', outputs: [], scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'deliver', maxRecoveryAttempts: 5 },
    ],
  })
  const attempt = async (input, pattern, commandId) => {
    const request = runtime.requestStart(owner, { commandId, goal: 'Make the requested change and verify it.', workspace: directory })
    await assert.rejects(runtime.startPlan(owner, request.id, input), pattern)
  }
  const uncovered = automatic()
  uncovered.acceptance = ['works', 'the extra criterion is covered']
  await attempt(uncovered, /Missing exact acceptance strings/, 'command-uncovered')

  const topology = automatic()
  topology.tasks.push(
    { key: 'deliver2', workstreamKey: 'main', title: 'Deliver two', objective: 'Implement second change', kind: 'implementation', outputs: [], scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'], maxRecoveryAttempts: 5, checkTimeoutMs: 45000 },
    { key: 'review2', workstreamKey: 'main', title: 'Review two', objective: 'Verify second artifact', kind: 'verification', outputs: [], scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'deliver2', maxRecoveryAttempts: 5 },
  )
  await attempt(topology, /several implementation tasks require a final integration/, 'command-topology')

  const unreviewed = automatic()
  unreviewed.tasks = [unreviewed.tasks[0]]
  await attempt(unreviewed, /requires an assigned independent verification task/, 'command-unreviewed')
})

/**
 * A declared check reaches the host as one `/bin/sh -c` argument. A NUL byte
 * there is refused by the process API itself (ERR_INVALID_ARG_VALUE), which the
 * verification path recorded as host infrastructure and deferred the review on,
 * so admission refuses every control character a check cannot need. Tab and
 * newline stay admitted: a multi-line or tab-indented script is a real check.
 */
test('a declared check carrying a control character other than tab or newline is refused at admission', async t => {
  const refusal = (location, codePoint) => `[check_control_character] ${location} contains the control character U+${codePoint}; a declared check may contain tab and newline but no other control character. Remove it from \`checks\` and retry with \`swarm_propose\`, or amend \`changes\` with \`swarm_control\`; keep the same task and acceptance criteria.`
  const typed = (location, codePoint) => error => {
    assert.equal(error.code, 'check_control_character')
    assert.equal(error.category, 'validation_error')
    assert.equal(error.message, refusal(location, codePoint))
    return true
  }
  for (const [character, codePoint] of [['\u0000', '0000'], ['\r', '000D'], ['\u001b', '001B'], ['\u007f', '007F']]) {
    const input = plan('/workspace'); input.tasks[1].checks = ['node check.cjs', `node check.cjs${character} && true`]
    assert.throws(() => validatePlan(input), typed('tasks[1].checks[1]', codePoint), 'plan admission refuses it')
  }
  const multiline = plan('/workspace'); multiline.tasks[1].checks = ['node check.cjs &&\n\tnode --test']
  assert.doesNotThrow(() => validatePlan(multiline), 'tab and newline are still admitted')

  const f = await setup()
  t.after(() => f.cleanup())
  assert.throws(() => f.propose({ checks: ['test -f src/answer.txt\u0000 && true'] }), typed('task.checks[0]', '0000'), 'swarm_propose refuses it')
  const task = f.propose({ checks: ['test -d .'] })
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { checks: ['test -d .\u0000'] }, 'narrow the check'), typed('task.checks[0]', '0000'), 'swarm_control amend refuses it')
  assert.deepEqual(f.runtime.store.get('tasks', task.id).checks, ['test -d .'], 'the refused amendment changed nothing')
})
