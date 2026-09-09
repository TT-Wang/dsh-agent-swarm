/**
 * T5 / D1 + W14 admission contract: per-task ceilings, objective/scope
 * reconciliation, ignore-rule deliverable checks and host-only check
 * classification. Runtime enforcement of the ceiling is T5b; these tests pin
 * the contract T5b consumes and every admission rejection T5 adds.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { validatePlan } from '../lib/plans.js'
import {
  DEFAULT_TASK_MAX_FINDINGS, DEFAULT_TASK_MAX_STEPS, classifyCheck, ignoredDeliverablePaths,
  reconcileObjectiveScope, taskCeilingBlock, taskCeilingExhaustion, writeDirectivePaths,
} from '../lib/admission.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 60000, maxTasks: 12, maxExperiments: 2 }

function plan(workspace, overrides = {}) {
  return {
    title: 'Editable plan', objective: 'Deliver verified code', workspace, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation' }, { key: 'reviewer', name: 'Reviewer', role: 'verification' }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify artifact', kind: 'verification',
        scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'code' },
      { key: 'code', workstreamKey: 'main', title: 'Deliver', objective: 'Implement change', kind: 'integration',
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
  assert.match(stepBlock.reason, /instead of consuming the mission budget/)
  const findingBlock = taskCeilingBlock({ maxSteps: 10, maxFindings: 2, usedSteps: 4, evidenceIds: ['e1', 'e2'] })
  assert.equal(findingBlock.dimension, 'maxFindings')
  assert.equal(findingBlock.used, 2)
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

test('admission rejects an objective that directs a write outside the task scope', () => {
  const input = plan('/workspace')
  input.tasks[1].objective = 'Add a file under `docs/` describing the change and implement it.'
  assert.throws(() => validatePlan(input), error => {
    assert.match(error.message, /\[objective_write_outside_scope\]/)
    assert.match(error.message, /"docs\/"/)
    assert.match(error.message, /\["src\/"\]/)
    assert.match(error.message, /fail at submit/)
    return true
  })
  const diagnostics = reconcileObjectiveScope('Add a file under `docs/` describing the change.', ['src/'], 'tasks[1].objective')
  assert.deepEqual(diagnostics.map(item => [item.code, item.path]), [['objective_write_outside_scope', 'docs/']])
  const inScope = plan('/workspace')
  inScope.tasks[1].objective = 'Add `src/value.cjs` and implement the change.'
  assert.equal(validatePlan(inScope).tasks[1].objective, inScope.tasks[1].objective)
  const prohibited = plan('/workspace')
  prohibited.tasks[1].objective = 'Implement the change. Do not edit `docs/legacy.md` or `src/other.ts`.'
  assert.doesNotThrow(() => validatePlan(prohibited), 'a prohibition is not a write directive')
  const factual = plan('/workspace')
  factual.tasks[1].objective = 'Implement the change; the pre-fix reproduction is committed at `docs/repro.mjs`.'
  assert.doesNotThrow(() => validatePlan(factual), 'a factual statement is not a write directive')
  const mission = plan('/workspace', { objective: 'Add `docs/design-notes.md` and deliver verified code' })
  assert.throws(() => validatePlan(mission), /\[objective_write_outside_scope\]/, 'mission-level directives reconcile too')
  assert.deepEqual(writeDirectivePaths('Do not edit `src/types.ts`.'), [])
  assert.deepEqual(writeDirectivePaths('Add a file under `docs/` and commit `docs/review-x.md`.'), ['docs/', 'docs/review-x.md'])
})

test('admission rejects a named deliverable hidden by the effective ignore rules', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-admission-ignore-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const git = args => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
  }
  git(['init', '-q'])
  await writeFile(join(directory, '.gitignore'), 'docs/review-*.md\nartifacts/\n!docs/review-keep.md\n')
  const docsPlan = (overrides = {}) => {
    const input = plan(directory, { scope: ['docs/'], acceptance: ['works'], ...overrides })
    for (const task of input.tasks) task.scope = ['docs/']
    return input
  }
  const ignored = docsPlan()
  ignored.tasks[1].objective = 'Write `docs/review-round4.md` with the round summary.'
  assert.throws(() => validatePlan(ignored), error => {
    assert.match(error.message, /\[deliverable_path_ignored\]/)
    assert.match(error.message, /docs\/review-round4\.md/)
    assert.match(error.message, /\.gitignore:1/)
    assert.match(error.message, /"docs\/review-\*\.md"/)
    return true
  })
  const clean = docsPlan()
  clean.tasks[1].objective = 'Write `docs/notes.md` with the round summary.'
  assert.doesNotThrow(() => validatePlan(clean))
  const missionLevel = docsPlan({ acceptance: ['works', 'the summary is committed at `docs/review-mission.md`'] })
  assert.throws(() => validatePlan(missionLevel), /\[deliverable_path_ignored\]/, 'mission acceptance reconciles too')
  await mkdir(join(directory, 'docs'), { recursive: true })
  await writeFile(join(directory, 'docs', 'review-tracked.md'), 'tracked\n')
  git(['add', '-f', 'docs/review-tracked.md'])
  git(['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'track ignored deliverable'])
  const tracked = docsPlan()
  tracked.tasks[1].objective = 'Update `docs/review-tracked.md` with the round summary.'
  assert.doesNotThrow(() => validatePlan(tracked), 'a tracked deliverable is not hidden from capture')
  const negated = docsPlan()
  negated.tasks[1].objective = 'Write `docs/review-keep.md` with the round summary.'
  assert.doesNotThrow(() => validatePlan(negated), 'a later ! negation un-ignores an exact deliverable')
  const negatedAcceptance = docsPlan({ acceptance: ['works', 'the summary is committed at `docs/review-keep.md`'] })
  assert.doesNotThrow(() => validatePlan(negatedAcceptance), 'a negated deliverable named by acceptance is admitted')
  const directoryIgnored = docsPlan()
  directoryIgnored.tasks[1].objective = 'Write `artifacts/out.md` with the round summary.'
  assert.throws(() => validatePlan(directoryIgnored), /\[deliverable_path_ignored\]/, 'a deliverable under an ignored directory is rejected')
  const acceptanceNamed = docsPlan()
  acceptanceNamed.tasks[1].acceptance = ['works', '`docs/review-taskacc.md` exists']
  assert.throws(() => validatePlan(acceptanceNamed), /\[deliverable_path_ignored\]/, 'a deliverable named only by an acceptance criterion is rejected')
  const acceptanceNegated = docsPlan()
  acceptanceNegated.tasks[1].acceptance = ['works', '`docs/review-keep.md` exists']
  assert.doesNotThrow(() => validatePlan(acceptanceNegated), 'a negated deliverable named by acceptance is admitted')
  const hits = ignoredDeliverablePaths(directory, ['docs/review-round4.md', 'docs/notes.md', 'docs/review-keep.md', 'artifacts/out.md'])
  assert.deepEqual(hits.map(hit => [hit.path, hit.source, hit.line, hit.pattern]), [
    ['docs/review-round4.md', '.gitignore', 1, 'docs/review-*.md'],
    ['artifacts/out.md', '.gitignore', 2, 'artifacts/'],
  ], 'a mixed batch reports exactly the hidden paths, never the negated one')
  assert.deepEqual(ignoredDeliverablePaths(directory, ['docs/review-keep.md']), [], 'a negated candidate alone is not hidden')
})

test('W14: a host-only check is rejected at admission with a typed reason naming the host requirement', () => {
  assert.deepEqual(
    { ...classifyCheck('npm run test:harness'), command: undefined },
    { command: undefined, runnable: 'host-only', code: 'check_requires_host', requirement: 'the Harness composition suite needs a built Harness checkout and an unsandboxed host' })
  assert.equal(classifyCheck('npm run verify').runnable, 'host-only')
  assert.match(classifyCheck('npm run verify').requirement, /test:harness/)
  assert.match(classifyCheck('npm run verify').requirement, /test:pack, test:profile/)
  assert.equal(classifyCheck('node --expose-internals tests/harness-composition.mjs').runnable, 'host-only')
  assert.equal(classifyCheck('node scripts/smoke-command-web.mjs').runnable, 'host-only')
  assert.equal(classifyCheck('node tests/verification-isolation.mjs').runnable, 'host-only')
  for (const command of ['npm run test:pack', 'npm run test:profile', 'node scripts/smoke-pack.mjs', 'node scripts/smoke-profile.mjs']) {
    const classification = classifyCheck(command)
    assert.equal(classification.runnable, 'host-only', command)
    assert.equal(classification.code, 'check_requires_host')
    assert.match(classification.requirement, /nested workspace-write sandbox|sandbox-prerequisite/, command)
  }
  assert.equal(classifyCheck('npm run typecheck && npm run test:web').runnable, 'host-only', 'a composite command is host-only when any segment is')
  assert.equal(classifyCheck('npm run typecheck && npm run build && node --test tests/*.test.mjs && npm run test:faults').runnable, 'worker')
  assert.equal(classifyCheck('npm run typecheck && npm run build && node --test tests/*.test.mjs && npm run test:load').runnable, 'worker')
  assert.equal(classifyCheck('npm run typecheck && npm run build && node --test tests/*.test.mjs && npm run test:replay').runnable, 'worker')
  assert.equal(classifyCheck('npm run test:webhook').runnable, 'worker', 'a script whose name merely starts with a host-only name stays worker-runnable')
  assert.equal(classifyCheck('node check.cjs').runnable, 'worker')
  const input = plan('/workspace')
  input.tasks[1].checks = ['npm run typecheck && npm run test:harness']
  assert.throws(() => validatePlan(input), error => {
    assert.match(error.message, /\[check_requires_host\]/)
    assert.match(error.message, /unsandboxed host/)
    assert.match(error.message, /workspace-write sandbox/)
    assert.match(error.message, /host gate/)
    return true
  })
  const direct = plan('/workspace')
  direct.tasks[1].checks = ['node scripts/smoke-web.mjs']
  assert.throws(() => validatePlan(direct), /\[check_requires_host\]/)
  const nestedSandbox = plan('/workspace')
  nestedSandbox.tasks[1].checks = ['npm run typecheck && npm run build && node --test tests/*.test.mjs && npm run test:pack']
  assert.throws(() => validatePlan(nestedSandbox), error => {
    assert.match(error.message, /\[check_requires_host\]/)
    assert.match(error.message, /test:pack/)
    assert.match(error.message, /nested workspace-write sandbox/)
    return true
  }, 'the nested-sandbox pack gate cannot be declared as a worker check')
  const profileGate = plan('/workspace')
  profileGate.tasks[1].checks = ['npm run test:profile']
  assert.throws(() => validatePlan(profileGate), /\[check_requires_host\]/)
  const workerRunnable = plan('/workspace')
  workerRunnable.tasks[1].checks = ['npm run typecheck && npm run build && node --test tests/*.test.mjs && npm run test:faults']
  assert.doesNotThrow(() => validatePlan(workerRunnable))
})

test('existing cycle, missing-review, uncovered-acceptance and integration-topology rejections remain green', async t => {
  const cyclic = plan('/workspace')
  cyclic.tasks[0].dependencies = ['code']
  cyclic.tasks[1].dependencies = ['review']
  assert.throws(() => validatePlan(cyclic), /dependency\/review cycle/)
  const missingReview = plan('/workspace')
  delete missingReview.tasks[0].reviewOf
  assert.throws(() => validatePlan(missingReview), /reviewOf must name the existing source task/)

  const directory = await mkdtemp(join(tmpdir(), 'swarm-admission-runtime-'))
  const workers = {
    bind(callbacks) { this.callbacks = callbacks },
    async prepareWorkspace(mission, id) { return join(mission.workspace, id) },
    async start() {}, async prepareTask() {}, async deliver() {}, async stop() {},
    isIdle() { return false }, async dispose() {},
  }
  const runtime = new SwarmRuntime({ statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'admission-owner' }
  const automatic = () => ({
    title: 'Automatic delivery', objective: 'Deliver verified code', workspace: directory, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation', maxOutputTokens: 4096 }, { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [
      { key: 'deliver', workstreamKey: 'main', title: 'Deliver', objective: 'Implement final change', kind: 'implementation', scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'], maxRecoveryAttempts: 5, checkTimeoutMs: 45000 },
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify immutable artifact', kind: 'verification', scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'deliver', maxRecoveryAttempts: 5 },
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
    { key: 'deliver2', workstreamKey: 'main', title: 'Deliver two', objective: 'Implement second change', kind: 'implementation', scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'], maxRecoveryAttempts: 5, checkTimeoutMs: 45000 },
    { key: 'review2', workstreamKey: 'main', title: 'Review two', objective: 'Verify second artifact', kind: 'verification', scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'deliver2', maxRecoveryAttempts: 5 },
  )
  await attempt(topology, /several implementation tasks require a final integration/, 'command-topology')

  const unreviewed = automatic()
  unreviewed.tasks = [unreviewed.tasks[0]]
  await attempt(unreviewed, /requires an assigned independent verification task/, 'command-unreviewed')
})

test('the real round-4 task objectives are not false-flagged by scope reconciliation', () => {
  const cases = [
    [['src/runtime.ts', 'src/workspaces.ts', 'tests/'], "Fix, each with a regression test that fails on the pre-fix head: W9 (a preparation failure permanently blocks a task and is reachable from lease loss through the non-fatal checkpoint-failure re-pend into a dirty workspace; make recovery repair or re-create a clean baseline so a lease expiry never permanently blocks work); W12 lineage (replacing a cancelled task is refused and a dependent on a cancelled dependency is stranded; give cancellation a repair path and re-resolve dependents); retire a RUNNING sibling review both when a verdict lands and when its source is cancelled (only `pending` siblings are retired today, `src/runtime.ts:571-576`, while `docs/design.md:96` promises running reviews are retired too), with a durable event; and fix W15 (`unschedulable()` seeds every `blocked` task as dead at `src/runtime.ts:1218` and `stalled()` ignores `blocked`+`resumeAfterStop` at `:1238`, so a live handoff/close-out task is cancelled by `control complete` at `:1350-1357` and then dropped by the close-out at `:1750`); clamp `recordToolRun`'s lease to the mission deadline (F8). A runnable pre-fix reproduction for W15 is committed at `docs/repro-w15-handoff-completion.mjs`. Files: `src/runtime.ts`, `src/workspaces.ts`, `tests/`. Do not edit `src/types.ts` (T5), `src/store.ts` (T4), or another task's test file. Publish evidence with host run ids."],
    [['src/runtime.ts', 'docs/design.md', 'tests/'], "W8: validate member `reasoningEffort`/provider/model before the member starts, or refuse with a typed error instead of a provider failure that stops the member (`src/runtime.ts:317`, `:345-351`). Validate at the single admission point `runtime.addMember` — do not edit `src/web-api.ts` or `src/harness-workers.ts` (T8/T7 own them). D9: resolve the cancel-submitted contradiction — keep owner authority to withdraw submitted work, amend `docs/design.md:96` to state the exception, and add the missing test that cancels a submitted task. F6: branch the cancel-during-submit error on task status so the worker is told to stop, not resubmit. F7: `propose(admittedId)` must not re-admit a cancelled record (`:371-372`). F11: fix the budget-warning `suggestedLimit` off-by-one (`:1505`). Files: `src/runtime.ts`, `docs/design.md`, `tests/`."],
    [['src/trace.ts', 'src/tools.ts', 'scripts/replay/', 'tests/'], "D6 to level 3: a span row per orchestration step with a closed-enum operation name, `trace_id`/`span_id`/`parent_span_id`/`mission_id`/`attempt_id`, status and `error.type`, plus digests of input/output whose payloads live outside the event log; causal closure across worker hops; a committed `npm run test:replay` that replays the orchestrator decision function over the durable event log, performs zero provider calls, must emit an identical command sequence, and fails with a named error on a deliberately corrupted or truncated log; also surface the verdict and retired-review events and the 7 unsurfaced event types (F-12/F-13/F-14) and report trace-level metrics (contract compliance, first-violating-step) so D6's evidence is measurable (F-44). Files: `src/trace.ts` (new), `src/tools.ts`, `scripts/replay/`, `tests/`. Do NOT change `src/store.ts` or `src/types.ts`; declare new types in `src/trace.ts`. See `docs/sota-external-brief-2026-09-09.md` §2. Depends on T1 for `src/tools.ts`."],
    [['src/scheduler.ts', 'src/store.ts', 'src/runtime.ts', 'scripts/load/', 'tests/', 'package.json'], "D8 to level 3: every admission is a durable row with a reason code (`admitted`/`queue_full`/`budget_exceeded`/`lease_conflict`/`writer_busy`) under hierarchical per-scope limits with no unbounded in-memory queue; `npm run test:load` runs N >= 16 concurrent synthetic workers against a temporary store, prints the measured envelope (admission p50/p95, max concurrent leases, queue high-water, exact limit hit) and asserts per-worker observation cost stays bounded as N grows; a concurrent-writer test classifies and retries `SQLITE_BUSY` with no lost update; document the single-host single-writer boundary. Files: `src/scheduler.ts` (new), `src/store.ts`, `src/runtime.ts`, `scripts/load/`, `tests/`, `package.json`. Depends on T1 and T2; build on their accepted runtime. Do not edit `src/harness-workers.ts` (T7) or `src/types.ts` (T5)."],
    [['src/plans.ts', 'src/admission.ts', 'src/types.ts', 'tests/'], "D1 to level 3: a per-task step/finding ceiling carried through admission and enforced by the runtime (a task that exhausts its own ceiling blocks with a durable reason instead of consuming the mission budget); admission reconciles an objective's write directives with the task scope and checks named deliverable paths against the effective ignore rules, with machine-checkable diagnostics; W14: declared checks are validated against the execution environment or classified host-only so a worker cannot declare an unrunnable check. Keep the existing cycle, missing-review, uncovered-acceptance and integration-topology rejections green. Files: `src/plans.ts`, `src/admission.ts`, `src/types.ts`, `tests/`. `types.ts` is yours alone."],
    [['src/workspaces.ts', 'src/delivery.ts', 'src/harness-workers.ts', 'tests/'], "D7 to level 3: F-C1, the M5 guard resolves only the link's target string, so a base tree containing an escaping symlink lets a worker commit a chained escape that capture accepts and delivery materializes; resolve the chain or reject baseline escaping links in both capture and delivery. F-C2, the default `verificationDependencyMode: 'link'` is not isolated from the source tree; make the default isolating or correct the docs and prove the boundary. Production already calls `sandbox.confine({mode:'workspace-write', workspaceRoot: checkout})` (`src/harness-workers.ts:162-166`) but no test exercises it: add a HOST-ONLY test (`tests/verification-isolation.mjs` behind a new `npm run test:isolation`) that attempts an out-of-workspace write and asserts the outcome, plus the symlink-chain test. The worker's declared checks must stay `typecheck && build && node --test tests/*.test.mjs && npm run test:faults`; declaring the host-only suite as a worker check would repeat W14. Files: `src/workspaces.ts`, `src/delivery.ts`, `src/harness-workers.ts`, `tests/`. Depends on T1."],
    [['src/client/', 'src/web-api.ts', 'tests/'], "Fix the accepted client-audit findings F1-F9 at the promoted head: `verify` must not flip evidence to verified without a durable event naming it and a sibling cancel must be named; restore the 7 dropped event types to the projection; use the blocked reason rather than the title; stop hiding command/runId in `eventSummary`; render stop/complete without opening the disclosure; validate snapshots so `output:5` is rejected instead of throwing a render `TypeError`; translate the `zh` gaps (`unverified`/`supported`/`implementation`); reconcile the client `dependencyMet`/`lane=ready` with the runtime's blocked state; and fix SURFACE-R3-01, where a wrapped runtime failure returns `bad-request` with the raw internal message (`SQLITE_IOERR ... /private/var/secret/swarm.sqlite`, `LLM_ROUTE_LEAK`), so HTTP error bodies are sanitized while the durable event keeps the detail. Files: `src/client/`, `src/web-api.ts`, `tests/`."],
    [['package.json', 'README.md', 'docs/validation.md', 'docs/known-limitations.md', 'scripts/', 'tests/'], "Close the quality audit's documentation and packaging findings: recompute docs/validation.md against the final round-4 artifact or mark it historical (F-18) — this must land after T4's artifact is final; list the deferred defects and advisories in the packaged docs/known-limitations.md (F-19); close F-21 so the packed artifact no longer declares verification it does not ship; validate the fault runner's FAULT_OK record instead of trusting its presence (F-36); document the tier-B Harness prerequisite (F-37). Files: package.json, README.md, docs/validation.md, docs/known-limitations.md, scripts/, tests/. You depend on T4 for the package.json script set; do not edit src/."],
    [['docs/', 'package.json'], "Assemble T1, T2, T3, T4, T5, T7, T8 into one artifact, reconciling `package.json` scripts and `docs/`, and write the round ledger. Merge order: T4 (already contains T1+T2), then T2, then T1, then T7 (contains T1), then T3, T5, T8; never merge a whole artifact that already contains another fix. Do not weaken, skip or delete any existing assertion."],
  ]
  for (const [scope, objective] of cases) {
    assert.deepEqual(reconcileObjectiveScope(objective, scope, 'objective'), [], `no false positive for scope ${JSON.stringify(scope)}`)
  }
})
