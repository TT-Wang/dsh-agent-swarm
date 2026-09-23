import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSyntaxDetail, declaredPlanChecks } from '../lib/plans.js'
import { registerTools } from '../lib/tools.js'
import { Workspaces } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { setup } from './faults/harness.mjs'
import { assessText, toolSchemaIndex } from './refusal-inventory.mjs'
const budget = { maxTokens: 100, maxSteps: 10, maxWorkers: 2, maxDurationMs: 10000, maxTasks: 4, maxExperiments: 0 }
function tools() { const definitions = new Map(); registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, {}, budget); return definitions }
test('model-visible renders stay compact: observe passes the focused view through and never repeats the board; launch and stage return identities', () => {
  const definitions = tools()
  const observe = definitions.get('swarm_observe')
  const snapshot = { mission: { id: 'mission1', title: 'M', status: 'active', budget, deadline: 1 }, members: [{ id: 'm1', name: 'A', role: 'r', sessionId: 's1' }], workstreams: [{ id: 'w1', title: 'W' }], tasks: Array.from({ length: 40 }, (_, i) => ({ id: `task${i}`, title: `T${i}`, kind: 'research', status: 'pending', dependencies: [], output: 'x'.repeat(5000) })), evidence: [], events: [], pendingDeliveries: 0 }
  const view = { mission: { id: 'mission1' }, member: { id: 'm1' }, current: null, toolRuns: [{ id: 'run1', seq: 1, taskId: 'task1', attemptId: 'attempt1' }], events: [] }
  const rendered = observe.output.render({}, { result: view, snapshot })[0].text
  assert.deepEqual(JSON.parse(rendered), { result: view }, 'the complete snapshot travels only in UI presentation metadata')
  assert.deepEqual(observe.output.presentationMeta({}, { result: view, snapshot }), { swarmSnapshot: snapshot })
  const launched = JSON.parse(definitions.get('swarm_launch').output.render({}, { result: snapshot, snapshot })[0].text).result
  assert.equal(launched.mission.id, 'mission1'); assert.equal(launched.tasks.length, 40); assert.equal(launched.tasks[0].output, undefined)
  assert(JSON.stringify(launched).length < 6000, 'launch confirmation must not echo every task record')
  const staged = JSON.parse(definitions.get('swarm_stage').output.render({}, { result: { id: 'draft1', revision: 1, status: 'draft', input: { title: 'x'.repeat(20000) } } })[0].text).result
  assert.deepEqual(staged.draft, { id: 'draft1', revision: 1, status: 'draft' })
})
test('role tool sets hide only what the runtime rejects for that role, in a stable order', async () => {
  const { hiddenToolsFor, SWARM_TOOLS, MEMBER_TOOLS, MANAGEMENT_TOOLS } = await import('../lib/tools.js')
  const definitions = tools()
  assert.deepEqual([...definitions.keys()], [...SWARM_TOOLS], 'registration order is the cached schema prefix')
  assert.deepEqual(hiddenToolsFor('worker'), [...MANAGEMENT_TOOLS])
  assert.deepEqual(hiddenToolsFor('owner'), [...MEMBER_TOOLS])
  assert(hiddenToolsFor('entry').includes('swarm_launch') && !hiddenToolsFor('entry').includes('swarm_stage') && !hiddenToolsFor('entry').includes('swarm_create'))
  assert.deepEqual(hiddenToolsFor('none'), [...SWARM_TOOLS])
  for (const name of [...MEMBER_TOOLS, ...MANAGEMENT_TOOLS]) assert(definitions.has(name), name)
  const workerChars = [...definitions.values()].filter(d => !MANAGEMENT_TOOLS.includes(d.name)).reduce((sum, d) => sum + JSON.stringify({ name: d.name, description: d.description, parameters: d.parameters }).length, 0)
  const allChars = [...definitions.values()].reduce((sum, d) => sum + JSON.stringify({ name: d.name, description: d.description, parameters: d.parameters }).length, 0)
  assert(workerChars < allChars * 0.5, `worker schema ${workerChars} should be well under half of ${allChars}`)
})
test('all model plan entry points require their chosen budget; automatic schema requires operational policy fields', () => {
  const definitions = tools()
  for (const name of ['swarm_launch', 'swarm_create', 'swarm_stage']) assert(definitions.get(name).parameters.required.includes('budget'))
  const properties = definitions.get('swarm_launch').parameters.properties
  assert(properties.members.items.required.includes('maxOutputTokens'))
  for (const key of ['key', 'maxRecoveryAttempts']) assert(properties.tasks.items.required.includes(key))
  // M9(a): runtime admission requires checkTimeoutMs only for non-verification
  // tasks that declare checks, so the schema must not demand it on every task.
  assert(!properties.tasks.items.required.includes('checkTimeoutMs'), 'checkTimeoutMs is conditional, never universally required')
  assert.equal(properties.tasks.items.properties.checkTimeoutMs.type, 'integer', 'the conditional property stays declared')
  assert.match(properties.tasks.items.properties.checkTimeoutMs.description, /checks/)
  assert.equal(properties.budget.properties.maxTokens.default, undefined)
})

test('swarm_propose leaves acceptance optional for a repair to inherit; every plan entry point still requires it', () => {
  const definitions = tools()
  const propose = definitions.get('swarm_propose').parameters
  assert.deepEqual(propose.required, ['missionId', 'workstreamId', 'title', 'objective', 'kind', 'scope'])
  assert.deepEqual(propose.properties.acceptance.items, { type: 'string' }, 'the property stays declared as a string array')
  assert.match(propose.properties.acceptance.description, /Required unless replaces is given/)
  assert(propose.properties.replaces, 'replaces carries the inheritance')
  assert(definitions.get('swarm_create').parameters.required.includes('acceptance'))
  for (const name of ['swarm_launch', 'swarm_stage']) {
    assert(definitions.get(name).parameters.required.includes('acceptance'), `${name} mission acceptance`)
    assert(definitions.get(name).parameters.properties.tasks.items.required.includes('acceptance'), `${name} task acceptance`)
  }
})

test('a schema requires only what the runtime requires on every call, and says when a conditional field may be omitted', () => {
  const definitions = tools()
  // swarm_submit: missing deliverables are none; the declared outputs are always captured.
  const submit = definitions.get('swarm_submit').parameters
  assert.deepEqual(submit.required, ['missionId', 'taskId', 'attemptId', 'output'])
  assert.match(submit.properties.deliverables.description, /^Optional; omit when the task's declared outputs are everything to capture\./)
  // swarm_propose: a repair inherits the replaced tasks' outputs, so outputs is conditional like acceptance.
  const propose = definitions.get('swarm_propose').parameters
  assert.equal(propose.required.includes('outputs'), false)
  assert.match(propose.properties.outputs.description, /Required unless replaces is given\. On a repair, explicit outputs replace the outputs it would otherwise inherit from every task in replaces\./)
  // swarm_launch: the automatic plan requires assigneeKey on deliverables and one review of each, not on every task.
  const launchTask = definitions.get('swarm_launch').parameters.properties.tasks.items
  assert.equal(launchTask.required.includes('assigneeKey'), false)
  assert.match(launchTask.properties.assigneeKey.description, /Required on every non-verification task and on at least one verification task reviewing it, with a different member; may be omitted on any further review\./)
  // The staged plan never required it.
  assert.equal(definitions.get('swarm_stage').parameters.properties.tasks.items.required.includes('assigneeKey'), false)
})

test('R24: model-visible text states the declared-outputs rule once and never describes guessing paths from prose', async () => {
  const { OWNER_PROMPT, WORKER_PROMPT, ENTRY_PROMPT } = await import('../lib/tools.js')
  const definitions = tools()
  const texts = [OWNER_PROMPT, WORKER_PROMPT, ENTRY_PROMPT]
  const collect = node => { if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) key === 'description' && typeof value === 'string' ? texts.push(value) : collect(value) }
  for (const definition of definitions.values()) { texts.push(definition.description); collect(definition.parameters) }
  for (const text of texts) assert.doesNotMatch(text, /inferred|objective text|uncaptured|names that exists/i, text)
  const outputs = definitions.get('swarm_propose').parameters.properties.outputs.description
  assert.match(outputs, /The host captures exactly these, including ignored files, and refuses a submission missing one\./)
  // What is never an output, and what "declared" promises at submit, are stated
  // on every surface that takes outputs; the owner prompt only points there.
  const surfaces = [outputs, definitions.get('swarm_launch').parameters.properties.tasks.items.properties.outputs.description,
    definitions.get('swarm_stage').parameters.properties.tasks.items.properties.outputs.description,
    definitions.get('swarm_control').parameters.properties.changes.properties.outputs.description]
  for (const description of surfaces) {
    assert.match(description, /no directories, symlinks, globs, "\.\." segments, dependency directories or files a declared check generates\./)
    assert.match(description, /A removed or renamed-away path is never an output; a delete-only task declares \[\]\./)
    assert.match(description, /A declared output only has to exist as a regular file at submit; it is not checked for having changed\./)
  }
  assert.match(OWNER_PROMPT, /Declare files a task writes in outputs per schema; \[\] if it only reads\/deletes\./)
})

test('repair guidance says a repair inherits acceptance instead of asking the model to copy it', async () => {
  const { OWNER_PROMPT, WORKER_PROMPT, ENTRY_PROMPT } = await import('../lib/tools.js')
  const { NOTICE_TEMPLATES } = await import('../lib/notices.js')
  const { guardTerminal } = await import('../lib/refusals.js')
  const { dependencyAssumptionDiagnostic } = await import('../lib/admission.js')
  const surfaces = { OWNER_PROMPT, WORKER_PROMPT, ENTRY_PROMPT, swarm_propose: tools().get('swarm_propose').description }
  for (const [where, text] of Object.entries(surfaces)) {
    assert.doesNotMatch(text, /unchanged acceptance|acceptance verbatim|retain original acceptance/i, `${where} no longer asks for a copy`)
  }
  for (const where of ['OWNER_PROMPT', 'WORKER_PROMPT', 'swarm_propose']) assert.match(surfaces[where], /replaces[^.]*inherit[^.]*acceptance/, `${where} states the inheritance once`)
  // The owner's stall-root notice, the dispatch terminal and the missing
  // dependency diagnostic carry the same repair path; none may ask for
  // acceptance to be copied, in any wording.
  const repairPaths = {
    'stall-root notice': NOTICE_TEMPLATES['stall-root'].build({ rootId: 'task_root', title: 'Rejected work', epoch: 2, cause: 'no live replacement exists anywhere in its lineage', dependents: ['task_next'], recordedReason: 'rejected by review' }),
    'dispatch_terminal': guardTerminal('dispatch_preconditions').message,
    'dependency_assumption_missing': dependencyAssumptionDiagnostic('the earlier artifact', 'objective', 'resume from the earlier artifact', 'task "Repair"').message,
  }
  for (const [where, text] of Object.entries(repairPaths)) {
    assert.doesNotMatch(text, /verbatim|unchanged acceptance|retain original acceptance/i, `${where} no longer asks for a copy`)
    assert.match(text, /swarm_propose/, `${where} names the repair tool`)
    assert.match(text, /replaces[^.]*inherits its acceptance/, `${where} states the inheritance`)
  }
})

test('tool schemas match the enforced runtime contract for observe cursors and member subscriptions', () => {
  const definitions = tools()
  // M9(b): optionalInteger rejects negatives, so every cursor declares minimum 0.
  const observe = definitions.get('swarm_observe').parameters.properties
  for (const key of ['after', 'afterRun', 'offset']) assert.equal(observe[key].minimum, 0, `${key} must declare the nonnegative runtime contract`)
  // M9(c): the runtime stores subscriptions verbatim; a bare string would turn
  // topic matching into substring semantics, so the schema is a string array.
  const member = definitions.get('swarm_add_member').parameters.properties
  assert.equal(member.subscriptions.type, 'array')
  assert.equal(member.subscriptions.items.type, 'string')
})

test('registered launch accepts omitted member names and forwards canonical identities', async () => {
  const definitions = new Map(), launched = []
  const snapshot = { mission: { id: 'named-mission' } }
  const runtime = {
    config: {},
    starts: () => [{ id: 'named-request', workspace: '/workspace' }],
    async startPlan(_actor, requestId, plan) { launched.push({ requestId, plan }); return snapshot },
    snapshot: () => snapshot,
  }
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  for (const name of ['swarm_stage', 'swarm_launch']) {
    const member = definitions.get(name).parameters.properties.members.items
    assert.equal(member.required.includes('name'), false, `${name} must permit the host-assigned default`)
    assert.equal(member.required.includes('role'), true)
  }
  const input = { requestId: 'named-request', title: 'Research', objective: 'Understand the module', scope: ['src/'], acceptance: ['understood'], budget,
    members: [{ key: 'author', role: 'Inspect the implementation', maxOutputTokens: 1024 }, { key: 'reviewer', name: 'Ada', role: 'Independently review the research', maxOutputTokens: 1024 }],
    workstreams: [{ key: 'main', title: 'Research', objective: 'Understand the module' }],
    tasks: [
      { key: 'research', workstreamKey: 'main', title: 'Inspect', objective: 'Inspect the module', kind: 'research', outputs: [], scope: ['src/'], acceptance: ['understood'], assigneeKey: 'author', maxRecoveryAttempts: 2 },
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Review the evidence', kind: 'verification', outputs: [], scope: ['src/'], acceptance: ['understood'], assigneeKey: 'reviewer', reviewOf: 'research', maxRecoveryAttempts: 2 },
    ] }
  const execution = { agent: { id: 'owner' }, signal: new AbortController().signal }
  await definitions.get('swarm_launch').execute(input, execution)
  assert.equal(launched.length, 1)
  assert.equal(launched[0].requestId, input.requestId)
  assert.deepEqual(launched[0].plan.members.map(member => ({ key: member.key, name: member.name, role: member.role })), [
    { key: 'author', name: 'Alan', role: input.members[0].role },
    { key: 'reviewer', name: 'Ada', role: input.members[1].role },
  ])
  assert.equal(input.members[0].name, undefined, 'tool parsing leaves the original input reusable')
})

test('launch rejects indexed shell syntax errors before admission and syntax checks never execute commands', async t => {
  const { mkdtemp, access, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const workspace = await mkdtemp(join(tmpdir(), 'swarm-check-syntax-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  let launches = 0
  const snapshot = { mission: { id: 'mission-one' } }
  // The preflight itself now runs at the shared launch boundary
  // (`SwarmRuntime.launchDraft`), so the tool hands the validated plan to
  // `startPlan`; this stub keeps the same assertion the tool-level check made by
  // running the real parse-only probe before it counts a launch, and pairs its
  // result with the production helpers launchDraft uses (R18-5b proves that
  // boundary end to end). `checks` are parsed with /bin/sh -n and never executed.
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: join(workspace, 'worktrees'),
    checkTimeoutMs: 30000, maxCheckOutputBytes: 100000, confineCheck: argv => argv })
  t.after(() => workspaces.dispose())
  const runtime = { config: {}, starts: () => [{ id: 'request-one', workspace }], async startPlan(_actor, _id, plan) {
    const declared = declaredPlanChecks(plan.tasks)
    const issues = await workspaces.checkSyntaxPreflight(declared.map(check => check.command), workspace)
    if (issues.length) throw new Error(`[check_syntax_invalid] ${checkSyntaxDetail(declared, issues)}`)
    launches++; assert.equal(plan.budget.maxTokens, 12345); return snapshot
  }, snapshot: () => snapshot }
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) }, get: name => name === 'subprocess' ? subprocessSeam() : undefined }, runtime, budget)
  const input = { requestId: 'request-one', title: 'Goal', objective: 'Deliver the goal', scope: ['result.txt'], acceptance: ['works'], budget: { ...budget, maxTokens: 12345 },
    members: [{ key: 'a', name: 'A', role: 'delivery', maxOutputTokens: 1024 }, { key: 'b', name: 'B', role: 'review', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'w', title: 'Work', objective: 'Deliver' }], tasks: [
      { key: 't', workstreamKey: 'w', title: 'Deliver', objective: 'Deliver', kind: 'integration', outputs: [], scope: ['result.txt'], acceptance: ['works'], checks: ['touch result.txt'], assigneeKey: 'a', maxRecoveryAttempts: 2, checkTimeoutMs: 1000 },
      { key: 'r', workstreamKey: 'w', title: 'Review', objective: 'Review', kind: 'verification', outputs: [], scope: ['result.txt'], acceptance: ['works'], reviewOf: 't', assigneeKey: 'b', maxRecoveryAttempts: 2, checkTimeoutMs: 1000 },
    ] }
  const execution = { agent: { id: 'owner' }, signal: new AbortController().signal }
  await definitions.get('swarm_launch').execute(input, execution)
  assert.equal(launches, 1)
  await assert.rejects(access(join(workspace, 'result.txt')), { code: 'ENOENT' })
  input.tasks[0].checks = ['echo pass | ! read -r c']
  await assert.rejects(definitions.get('swarm_launch').execute(input, execution), /tasks\[t\]\.checks\[0\] has invalid shell syntax in "echo pass \| ! read -r c"/)
  assert.equal(launches, 1)
})

test('request control routes through the existing tool without accepting ambiguous identities', async () => {
  const calls = [], definitions = new Map()
  const runtime = { controlStart(...args) { calls.push(args); return { id: 'request-1', status: 'planning', planningEpoch: 2 } } }
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  const control = definitions.get('swarm_control')
  const execution = { agent: { id: 'owner' }, signal: new AbortController().signal }
  await control.execute({ requestId: 'request-1', action: 'retry', reason: 'Recover saved plan' }, execution)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0].sessionId, 'owner')
  assert.deepEqual(calls[0].slice(1), ['request-1', 'retry', 'Recover saved plan', undefined])
  await assert.rejects(control.execute({ requestId: 'request-1', missionId: 'mission-1', action: 'stop', reason: 'stop' }, execution), /exactly one/)
  await assert.rejects(control.execute({ action: 'stop', reason: 'stop' }, execution), /exactly one/)
})

test('observe lists bounded saved requests and permits one owner-scoped focused recovery read', async () => {
  const definitions = new Map()
  const requests = Array.from({ length: 20 }, (_, i) => ({ id: `request-${i}`, status: 'failed', updatedAt: i, goal: 'x'.repeat(1000), error: 'e'.repeat(1000), planningEpoch: 2 }))
  const runtime = { list: () => [], starts: actor => actor.sessionId === 'owner' ? requests : [] }
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  const observe = definitions.get('swarm_observe')
  const exec = { agent: { id: 'owner' }, signal: new AbortController().signal }
  const listed = await observe.execute({}, exec)
  assert.equal(listed.result.totalRequests, 20)
  assert.equal(listed.result.requests.length, 10)
  assert.equal(listed.result.requests[0].id, 'request-19')
  assert.ok(listed.result.requests[0].goal.length <= 240)
  const focused = await observe.execute({ requestId: 'request-0' }, exec)
  assert.equal(focused.result.request.goal.length, 1000)
  await assert.rejects(observe.execute({ requestId: 'request-0' }, { ...exec, agent: { id: 'stranger' } }), /not owned/)
})

/* Every swarm_* tool checks its call against its own published parameters schema before anything runs. */

/** A runtime that records every method the tool layer reaches; the validator must reach none of them. */
function recordingTools() {
  const calls = [], definitions = new Map()
  const runtime = new Proxy({}, { get: (_target, key) => typeof key === 'string' && key !== 'then' ? (...args) => { calls.push(key); return undefined } : undefined })
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  return { calls, definitions }
}
const refusedBySchema = (schemaIndex, tool, ...fragments) => error => {
  assert.equal(error.name, 'PolicyError')
  assert.equal(error.code, 'tool_arguments_invalid')
  assert.equal(error.category, 'validation_error')
  assert.ok(error.message.startsWith(`[tool_arguments_invalid] ${tool} was called with arguments its parameters schema refuses: `), error.message)
  for (const fragment of fragments) assert.ok(error.message.includes(fragment), `${fragment} in ${error.message}`)
  assert.deepEqual(assessText(error.message, schemaIndex), [], `the rendered refusal satisfies the refusal contract: ${error.message}`)
  return true
}

test('swarm_verify without verdict and swarm_message without kind are refused before any state changes', async () => {
  const f = await setup({ config: { tickMs: 10_000 } })
  try {
    const schemaIndex = await toolSchemaIndex()
    const definitions = new Map()
    registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
    const as = member => ({ agent: { id: member.sessionId }, signal: new AbortController().signal })
    const source = f.propose({ title: 'Source work' })
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Review source', objective: 'Independent review',
      kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: f.mission.acceptance, assigneeId: f.reviewer.id })
    const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    const evidence = f.runtime.store.list('evidence', f.mission.id).length
    const deliveries = f.runtime.store.list('deliveries', f.mission.id).length
    // Without verdict the runtime used to run the checks and record a rejection.
    await assert.rejects(definitions.get('swarm_verify').execute({ missionId: f.mission.id, taskId: review.id, attemptId: reviewing.attempt.id, reason: 'The artifact looks right' }, as(f.reviewer)),
      refusedBySchema(schemaIndex, 'swarm_verify', '`verdict` is required'))
    assert.equal(f.workers.verified.length, 0, 'no declared check ran')
    assert.equal(f.runtime.store.get('tasks', source.id).status, 'submitted', 'the source is not rejected')
    assert.equal(f.runtime.store.get('tasks', review.id).attempt?.id, reviewing.attempt.id, 'the review attempt is untouched')
    assert.equal(f.runtime.store.list('evidence', f.mission.id).length, evidence)
    // Without kind a question used to be delivered with no kind and open no reply receipt.
    await assert.rejects(definitions.get('swarm_message').execute({ missionId: f.mission.id, to: 'owner', content: 'Is the scope right?' }, as(f.author)),
      refusedBySchema(schemaIndex, 'swarm_message', '`kind` is required'))
    assert.equal(f.runtime.store.list('deliveries', f.mission.id).length, deliveries, 'nothing was delivered')
  } finally { await f.cleanup() }
})

test('an invalid enum, a wrong primitive type and a nested launch task missing a field are refused before the runtime is reached', async () => {
  const schemaIndex = await toolSchemaIndex()
  const { calls, definitions } = recordingTools()
  const exec = { agent: { id: 'owner' }, signal: new AbortController().signal }
  await assert.rejects(definitions.get('swarm_control').execute({ missionId: 'mission_1', action: 'explode', reason: 'r' }, exec),
    refusedBySchema(schemaIndex, 'swarm_control', '`action` must be one of "pause", "resume", "stop", "complete", "coordinator", "retry", "extend", "amend"'))
  await assert.rejects(definitions.get('swarm_propose').execute({ missionId: 'mission_1', workstreamId: 'stream_1', title: 'T', objective: 'O', kind: 'research', scope: ['**'], outputs: [], priority: 'high' }, exec),
    refusedBySchema(schemaIndex, 'swarm_propose', '`priority` must be an integer'))
  const task = { key: 'task_1', workstreamKey: 'main', title: 'T', objective: 'O', kind: 'implementation', scope: ['**'], acceptance: ['works'], outputs: [], maxRecoveryAttempts: 1 }
  const { objective: _objective, ...withoutObjective } = task
  await assert.rejects(definitions.get('swarm_launch').execute({ requestId: 'request_1', title: 'P', objective: 'O', scope: ['**'], acceptance: ['works'], budget,
    members: [{ key: 'builder', role: 'implementation', maxOutputTokens: 1000 }], workstreams: [{ key: 'main', title: 'Main', objective: 'Main' }],
    tasks: [task, { ...withoutObjective, key: 'task_2', scope: ['src/', 7] }] }, exec),
    refusedBySchema(schemaIndex, 'swarm_launch', '`tasks`[1].`objective` is required', '`tasks`[1].`scope`[1] must be a string'))
  // Every offending path of one call is named in the one refusal.
  await assert.rejects(definitions.get('swarm_verify').execute({ missionId: 'mission_1', taskId: 'task_1', attemptId: 'attempt_1', verdict: 'maybe', reason: 7 }, exec),
    refusedBySchema(schemaIndex, 'swarm_verify', '`verdict` must be one of "accept", "reject"; `reason` must be a string'))
  await assert.rejects(definitions.get('swarm_budget').execute({ missionId: 'mission_1', reason: 'r', budget: { maxTokens: 1 } }, exec),
    refusedBySchema(schemaIndex, 'swarm_budget', '`budget`.`maxSteps` is required'))
  // The enums whose runtime re-checks were removed: an evidence outcome and a board kind.
  await assert.rejects(definitions.get('swarm_publish').execute({ missionId: 'mission_1', taskId: 'task_1', attemptId: 'attempt_1', claim: 'c', outcome: 'maybe', toolRunIds: ['run_1'] }, exec),
    refusedBySchema(schemaIndex, 'swarm_publish', '`outcome` must be one of "supported", "disproved", "inconclusive"'))
  await assert.rejects(definitions.get('swarm_board').execute({ missionId: 'mission_1', kind: 'GOSSIP' }, exec),
    refusedBySchema(schemaIndex, 'swarm_board', '`kind` must be one of "ASK", "ANSWER", "IDEA", "ALERT", "ARTIFACT", "HANDOFF"'))
  assert.deepEqual(calls, [], 'no refused call reached the runtime')
})

test('a representative valid call of every swarm tool passes its schema check and reaches the runtime', async () => {
  const workspace = await realpath(tmpdir())
  const plan = {
    title: 'P', objective: 'O', scope: ['**'], acceptance: ['works'], budget,
    members: [{ key: 'builder', role: 'implementation' }], workstreams: [{ key: 'main', title: 'Main', objective: 'Main' }],
    tasks: [{ key: 'task_1', workstreamKey: 'main', title: 'T', objective: 'O', kind: 'research', scope: ['**'], acceptance: ['works'] }],
  }
  const valid = {
    swarm_stage: { ...plan, workspace },
    // A launch task may omit assigneeKey (a further review); outputs and maxRecoveryAttempts are required.
    swarm_launch: { ...plan, requestId: 'request_1', members: [{ key: 'builder', role: 'implementation', maxOutputTokens: 1000 }], tasks: [{ ...plan.tasks[0], outputs: [], maxRecoveryAttempts: 1 }] },
    swarm_budget: { missionId: 'mission_1', budget, reason: 'raise' },
    swarm_create: { title: 'P', objective: 'O', workspace, scope: ['**'], acceptance: ['works'], budget },
    swarm_add_member: { missionId: 'mission_1', role: 'reviewer' },
    swarm_workstream: { missionId: 'mission_1', title: 'W', objective: 'O' },
    // A repair may omit outputs and acceptance: both are inherited.
    swarm_propose: { missionId: 'mission_1', workstreamId: 'stream_1', title: 'Repair', objective: 'O', kind: 'research', scope: ['**'], replaces: ['task_old'] },
    swarm_claim: { missionId: 'mission_1', taskId: 'task_1' },
    swarm_publish: { missionId: 'mission_1', taskId: 'task_1', attemptId: 'attempt_1', claim: 'c', outcome: 'supported', toolRunIds: ['run_1'] },
    // deliverables may be omitted: the declared outputs are always captured.
    swarm_submit: { missionId: 'mission_1', taskId: 'task_1', attemptId: 'attempt_1', output: 'done' },
    swarm_verify: { missionId: 'mission_1', taskId: 'task_1', attemptId: 'attempt_1', verdict: 'accept', reason: 'checks pass' },
    swarm_message: { missionId: 'mission_1', to: 'owner', kind: 'question', content: 'q' },
    swarm_challenge: { missionId: 'mission_1', evidenceId: 'evidence_1', reason: 'r', toolRunIds: ['run_1'] },
    swarm_handoff: { missionId: 'mission_1', taskId: 'task_1', attemptId: 'attempt_1', summary: 's' },
    swarm_subscribe: { missionId: 'mission_1', topics: ['*'] },
    swarm_wait: { missionId: 'mission_1' },
    swarm_observe: {},
    swarm_control: { missionId: 'mission_1', taskId: 'task_1', action: 'amend', changes: { dependencies: [], maxSteps: 5 }, reason: 'r' },
    swarm_cancel: { missionId: 'mission_1', taskId: 'task_1', reason: 'r' },
    swarm_registry: {},
    swarm_escalate: { missionId: 'mission_1', body: 'b' },
    swarm_post: { missionId: 'mission_1', kind: 'ASK', body: 'b' },
    swarm_board: { missionId: 'mission_1', kind: 'ASK', limit: 5 },
    swarm_restore: {},
  }
  const { SWARM_TOOLS } = await import('../lib/tools.js')
  assert.deepEqual(Object.keys(valid).sort(), [...SWARM_TOOLS].sort(), 'every registered tool has a representative call')
  for (const name of SWARM_TOOLS) {
    const { calls, definitions } = recordingTools()
    const exec = { agent: { id: 'owner', session: { header: { cwd: workspace } } }, signal: new AbortController().signal }
    const error = await definitions.get(name).execute(structuredClone(valid[name]), exec).then(() => undefined, failure => failure)
    assert.notEqual(error?.code, 'tool_arguments_invalid', `${name}: ${error?.message}`)
    assert.ok(calls.length > 0, `${name} reached the runtime (${error?.message ?? 'ok'})`)
  }
})

/*
 * JSON null on an optional property is an omission (d81a3fb accepted these
 * calls with null meaning "unset"); only a field that declares null in its
 * schema keeps it, because there null means something (changes.assigneeId).
 */
test('a null optional property is an omission at every nesting level, and a declared-nullable field keeps its null', async () => {
  const f = await setup({ config: { tickMs: 60_000 } })
  try {
    const definitions = new Map()
    registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
    const as = sessionId => ({ agent: { id: sessionId }, signal: new AbortController().signal })
    const call = (tool, args, sessionId = f.owner.sessionId) => definitions.get(tool).execute(Object.freeze(args), as(sessionId))
    // The arguments the Harness hands a tool are frozen; the stored row equals
    // the one the same call leaves with the property omitted.
    const proposal = { missionId: f.mission.id, workstreamId: f.stream.id, title: 'Audit', objective: 'Audit the code', kind: 'research', scope: ['**'], acceptance: f.mission.acceptance, outputs: [] }
    const row = id => { const { id: _id, createdAt: _at, ...rest } = f.runtime.store.get('tasks', id); return rest }
    const omitted = row((await call('swarm_propose', proposal)).result.id)
    for (const key of ['priority', 'experiment', 'replaces', 'maxSteps', 'maxFindings', 'assigneeId', 'reviewOf', 'dependencies', 'checks', 'assignmentMode', 'checkTimeoutMs', 'maxRecoveryAttempts']) {
      assert.deepEqual(row((await call('swarm_propose', { ...proposal, [key]: null })).result.id), omitted, `propose ${key}: null is stored as omitted`)
    }
    const stream = (await call('swarm_workstream', { missionId: f.mission.id, title: 'W2', objective: 'O2', coordinatorId: null })).result
    assert.equal(Object.hasOwn(f.runtime.store.get('workstreams', stream.id), 'coordinatorId'), false)
    await call('swarm_message', { missionId: f.mission.id, to: 'owner', kind: 'finding', content: 'noted', topic: null, dismiss: null, replyTo: null }, f.author.sessionId)
    const sent = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.from === f.author.id)
    assert.equal(sent.length, 1); assert.equal(Object.hasOwn(sent[0], 'topic'), false)
    for (const extra of [{ detail: null }, { vocabulary: null }, { trace: null }, { cursor: null }]) await call('swarm_observe', { missionId: f.mission.id, ...extra })
    // Nested: budget.deadlineAt null keeps the recorded deadline, as omitting it does.
    const deadlineAt = Date.now() + 3_600_000
    f.runtime.updateBudget(f.owner, f.mission.id, { ...f.mission.budget, deadlineAt }, 'set a deadline')
    await call('swarm_budget', { missionId: f.mission.id, reason: 'raise', budget: { ...f.mission.budget, maxTokens: 900_000, deadlineAt: null } })
    assert.deepEqual([f.runtime.store.get('missions', f.mission.id).budget.maxTokens, f.runtime.store.get('missions', f.mission.id).budget.deadlineAt], [900_000, deadlineAt])
    // A member's publish and handoff.
    const task = f.propose({ title: 'Work' })
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.workers.callbacks.toolRun(f.author.id, { tool: 'bash', arguments: { command: 'ls' }, result: { exitCode: 0 }, isError: false })
    const runId = f.runtime.observe(f.actor(f.author), f.mission.id).toolRuns[0].id
    const evidence = (await call('swarm_publish', { missionId: f.mission.id, taskId: task.id, attemptId: claimed.attempt.id, claim: 'c', outcome: 'supported', toolRunIds: [runId], supersedes: null }, f.author.sessionId)).result
    assert.deepEqual(f.runtime.store.get('evidence', evidence.id).supersedes, [])
    await call('swarm_handoff', { missionId: f.mission.id, taskId: task.id, attemptId: claimed.attempt.id, to: null, summary: 'Checkpointed' }, f.author.sessionId)
    const handed = f.runtime.store.get('tasks', task.id)
    assert.equal(Object.hasOwn(handed, 'assigneeId'), false, 'to: null releases to the ready queue, as omitting it does')
    assert.equal(handed.plannedAssigneeId, f.author.id)
    // changes.assigneeId declares null: it is kept and releases the binding.
    const bound = f.propose({ title: 'Bound' })
    const nullableSchema = definitions.get('swarm_control').parameters.properties.changes.properties.assigneeId
    assert.deepEqual(nullableSchema.oneOf, [{ type: 'string' }, { type: 'null' }]); assert.match(nullableSchema.description, /null or an empty string releases/)
    await call('swarm_control', { missionId: f.mission.id, taskId: bound.id, action: 'amend', reason: 'release', changes: { assigneeId: null, maxSteps: null } })
    assert.equal(f.runtime.store.get('tasks', bound.id).assigneeId, undefined, 'changes.assigneeId null still releases')
    assert.equal(f.runtime.store.get('tasks', bound.id).maxSteps, bound.maxSteps, 'changes.maxSteps null is an omission')
    // Mission control with null optional fields; a null required field is still refused.
    await call('swarm_control', { missionId: f.mission.id, action: 'pause', reason: 'r', coordinatorId: null, changes: null, timeoutMs: null, taskId: null, requestId: null })
    assert.equal(f.runtime.store.get('missions', f.mission.id).status, 'paused')
    const schemaIndex = await toolSchemaIndex()
    await assert.rejects(call('swarm_claim', { missionId: f.mission.id, taskId: null }, f.author.sessionId), refusedBySchema(schemaIndex, 'swarm_claim', '`taskId` must be a string'))
    await assert.rejects(call('swarm_control', { missionId: f.mission.id, taskId: bound.id, action: 'amend', reason: 'r', changes: { assigneeId: 7 } }),
      refusedBySchema(schemaIndex, 'swarm_control', '`changes`.`assigneeId` must be a string or null'))
  } finally { await f.cleanup() }
})

test('a null optional plan field is an omission inside launch and stage tasks and members', async () => {
  const launched = [], staged = []
  const definitions = new Map()
  const runtime = { config: {}, starts: () => [{ id: 'request_1', workspace: '/workspace' }], async startPlan(_actor, _id, plan) { launched.push(plan); return { mission: { id: 'mission_1' } } }, createDraft(_actor, plan) { staged.push(plan); return { id: 'draft_1', revision: 1, status: 'draft' } }, snapshot: () => undefined }
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  const workspace = await realpath(tmpdir())
  const task = { key: 'task_1', workstreamKey: 'main', title: 'T', objective: 'O', kind: 'research', scope: ['**'], acceptance: ['works'], outputs: [], maxRecoveryAttempts: 1, maxSteps: null, maxFindings: null, priority: null, experiment: null, reviewOf: null, dependencies: null, checks: null }
  const plan = { title: 'P', objective: 'O', scope: ['**'], acceptance: ['works'], budget: { ...budget, deadlineAt: null },
    members: [{ key: 'builder', role: 'implementation', maxOutputTokens: 1000, name: null, provider: null }], workstreams: [{ key: 'main', title: 'Main', objective: 'Main' }], tasks: [task] }
  const exec = { agent: { id: 'owner', session: { header: { cwd: workspace } } }, signal: new AbortController().signal }
  await definitions.get('swarm_launch').execute(Object.freeze({ ...plan, requestId: 'request_1', planningEpoch: null }), exec)
  await definitions.get('swarm_stage').execute(Object.freeze({ ...plan, workspace }), exec)
  for (const [where, received] of [['launch', launched[0].tasks[0]], ['stage', staged[0].tasks[0]]]) {
    for (const key of ['maxSteps', 'maxFindings', 'priority', 'experiment', 'reviewOf', 'dependencies', 'checks']) assert.notEqual(received[key], null, `${where} ${key}`)
  }
  assert.equal(launched[0].tasks[0].ceilingProvenance.maxSteps.source, 'default', 'a null ceiling takes the admission default')
  assert.equal(launched[0].budget.deadlineAt, undefined)
  assert.equal(typeof launched[0].members[0].name, 'string', 'a null name takes the host-assigned name')
  assert.equal(Object.hasOwn(staged[0].budget, 'deadlineAt'), false)
})

/*
 * Every swarm schema declares additionalProperties: false, and the check now
 * enforces it: a misspelled key used to be admitted and silently dropped.
 */
test('an undeclared key is refused by name with the keys that object accepts, at the top level and nested', async () => {
  const f = await setup({ config: { tickMs: 60_000 } })
  try {
    const schemaIndex = await toolSchemaIndex()
    const definitions = new Map()
    registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
    const as = sessionId => ({ agent: { id: sessionId }, signal: new AbortController().signal })
    const source = f.propose({ title: 'Source' })
    const tasks = f.runtime.store.list('tasks', f.mission.id).length
    // A typo'd dependency key was admitted with no dependency at all.
    await assert.rejects(definitions.get('swarm_propose').execute({ missionId: f.mission.id, workstreamId: f.stream.id, title: 'Follow-on', objective: 'Extend the change once Source lands', kind: 'implementation',
      scope: ['**'], acceptance: f.mission.acceptance, outputs: [], checks: ['test -d .'], dependsOn: [source.id] }, as(f.owner.sessionId)),
    refusedBySchema(schemaIndex, 'swarm_propose', '"dependsOn" is not a parameter (accepted: `missionId`, `workstreamId`, `title`, `objective`, `kind`, `dependencies`,'))
    assert.equal(f.runtime.store.list('tasks', f.mission.id).length, tasks, 'nothing was admitted')
    // swarm_budget used to forward the whole taskBudget to controlTask, so a
    // structural key (assignee, scope) was applied through the budget tool.
    await assert.rejects(definitions.get('swarm_budget').execute({ missionId: f.mission.id, taskId: source.id, reason: 'raise', taskBudget: { maxSteps: 20, assigneeId: '', scope: ['src/'] } }, as(f.owner.sessionId)),
      refusedBySchema(schemaIndex, 'swarm_budget', '"assigneeId", "scope" are not fields of `taskBudget` (accepted: `maxSteps`, `maxFindings`, `maxRecoveryAttempts`, `checkTimeoutMs`)'))
    const unchanged = f.runtime.store.get('tasks', source.id)
    assert.deepEqual([unchanged.assigneeId, unchanged.scope, unchanged.maxSteps], [f.author.id, ['**'], source.maxSteps])
    await definitions.get('swarm_budget').execute({ missionId: f.mission.id, taskId: source.id, reason: 'raise', taskBudget: { maxSteps: 20 } }, as(f.owner.sessionId))
    assert.equal(f.runtime.store.get('tasks', source.id).maxSteps, 20)
    assert.equal(f.runtime.store.get('tasks', source.id).assigneeId, f.author.id)
  } finally { await f.cleanup() }
  const schemaIndex = await toolSchemaIndex()
  const { calls, definitions } = recordingTools()
  const exec = { agent: { id: 'owner' }, signal: new AbortController().signal }
  const task = { key: 'task_1', workstreamKey: 'main', title: 'T', objective: 'O', kind: 'research', scope: ['**'], acceptance: ['works'], outputs: [], maxRecoveryAttempts: 1 }
  await assert.rejects(definitions.get('swarm_launch').execute({ requestId: 'request_1', title: 'P', objective: 'O', scope: ['**'], acceptance: ['works'], budget: { ...budget, maxCost: 1 },
    members: [{ key: 'builder', role: 'implementation', maxOutputTokens: 1000 }], workstreams: [{ key: 'main', title: 'Main', objective: 'Main' }], tasks: [{ ...task, dependsOn: ['task_0'] }] }, exec),
  refusedBySchema(schemaIndex, 'swarm_launch', '"maxCost" is not a field of `budget` (accepted: `maxTokens`,', '"dependsOn" is not a field of `tasks`[0] (accepted: `key`, `workstreamKey`,'))
  await assert.rejects(definitions.get('swarm_control').execute({ missionId: 'mission_1', taskId: 'task_1', action: 'amend', reason: 'r', changes: { objective: 'new' } }, exec),
    refusedBySchema(schemaIndex, 'swarm_control', '"objective" is not a field of `changes` (accepted: `maxSteps`,'))
  assert.deepEqual(calls, [], 'no refused call reached the runtime')
})

/*
 * 15 of 82 recorded swarm_launch calls repeat the planning message's
 * `Workspace:` line as a top-level `workspace`. The launch always runs in the
 * frozen request workspace, so the key is accepted and ignored: refusing it
 * cost a whole 10-25k-character plan re-emission and protected nothing.
 */
test('a recorded launch shape carrying workspace is accepted and runs in the frozen request workspace, while compact stays refused on swarm_observe', async () => {
  const launched = [], definitions = new Map()
  const runtime = { config: {}, starts: () => [{ id: 'request_1', workspace: '/frozen/request' }], async startPlan(_actor, _id, plan) { launched.push(plan); return { mission: { id: 'mission_1' } } }, snapshot: () => undefined }
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  const exec = { agent: { id: 'owner' }, signal: new AbortController().signal }
  // The keys, key order and budget of call_00_IDLtqD00MZDkoD3xm0HV5189
  // (agent-swarm-preview-5199, 2026-09-17), a launch that succeeded live, with
  // its text trimmed and today's required task outputs added.
  const task = (key, extra) => ({ key, workstreamKey: 'audit', title: key, objective: `Audit ${key}`, kind: 'research', scope: ['src/'], acceptance: ['Report every finding'], assigneeKey: 'auditor_a',
    maxSteps: 60, maxFindings: 20, maxRecoveryAttempts: 1, checkTimeoutMs: 120000, priority: 1, checks: ['node --version'], outputs: [], ...extra })
  const recorded = { requestId: 'request_1', planningEpoch: 1, title: 'Audit', objective: 'Audit the slice', workspace: '/Users/someone/code/dsh-slice-agent-loop', scope: ['src/'], acceptance: ['Report every finding'],
    budget: { maxTokens: 2000000, maxSteps: 620, maxWorkers: 4, maxDurationMs: 7200000, maxTasks: 14, maxExperiments: 0 },
    members: [{ key: 'auditor_a', role: 'Audit group A', maxOutputTokens: 8000 }, { key: 'synthesizer_d', role: 'Independent verification', maxOutputTokens: 8000 }],
    workstreams: [{ key: 'audit', title: 'Audit', objective: 'Audit the slice' }],
    tasks: [task('T1_audit'), task('T5_verify', { kind: 'verification', reviewOf: 'T1_audit', assigneeKey: 'synthesizer_d', priority: 2 })] }
  await definitions.get('swarm_launch').execute(Object.freeze(recorded), exec)
  assert.equal(launched.length, 1, 'the recorded shape launches')
  assert.equal(launched[0].workspace, '/frozen/request', 'the frozen request workspace, never the caller\'s value')
  const declared = definitions.get('swarm_launch').parameters
  assert.equal(declared.required.includes('workspace'), false)
  assert.match(declared.properties.workspace.description, /ignored.*frozen request workspace/i)
  // A flag-like word in the owner protocol produced compact:true on 4/4 recorded reads; the parameter still does not exist.
  const schemaIndex = await toolSchemaIndex()
  await assert.rejects(definitions.get('swarm_observe').execute({ missionId: 'mission_1', compact: true }, exec), refusedBySchema(schemaIndex, 'swarm_observe', '"compact" is not a parameter'))
  const { OWNER_PROMPT } = await import('../lib/tools.js')
  assert.doesNotMatch(OWNER_PROMPT, /\bcompact\b/, 'the owner protocol names no compact read')
})

test('an empty member id is refused by field instead of binding work to nobody', async () => {
  const f = await setup({ config: { tickMs: 60_000 } })
  try {
    const definitions = new Map()
    registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
    const as = sessionId => ({ agent: { id: sessionId }, signal: new AbortController().signal })
    const typed = (code, field, tool) => error => error.name === 'PolicyError' && error.code === code && error.category === 'validation_error'
      && error.message.startsWith(`[${code}] \`${field}\` must be a member id; an empty string names no member`) && error.message.endsWith(`then retry \`${tool}\`.`)
    const tasks = f.runtime.store.list('tasks', f.mission.id).length
    const proposal = { missionId: f.mission.id, workstreamId: f.stream.id, title: 'Audit', objective: 'Audit the code', kind: 'research', scope: ['**'], acceptance: f.mission.acceptance, outputs: [], assigneeId: '' }
    await assert.rejects(definitions.get('swarm_propose').execute(proposal, as(f.owner.sessionId)), typed('task_assignee_empty', 'assigneeId', 'swarm_propose'))
    const { missionId: _missionId, ...input } = proposal
    assert.throws(() => f.runtime.propose(f.owner, f.mission.id, input), typed('task_assignee_empty', 'assigneeId', 'swarm_propose'))
    assert.equal(f.runtime.store.list('tasks', f.mission.id).length, tasks, 'nothing was admitted')
    // A handoff to "" used to assign the task to member "".
    const task = f.propose({ title: 'Work' })
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await assert.rejects(definitions.get('swarm_handoff').execute({ missionId: f.mission.id, taskId: task.id, attemptId: claimed.attempt.id, to: '', summary: 'Checkpointed' }, as(f.author.sessionId)),
      typed('handoff_target_empty', 'to', 'swarm_handoff'))
    const untouched = f.runtime.store.get('tasks', task.id)
    assert.deepEqual([untouched.status, untouched.attempt?.id, untouched.assigneeId], ['running', claimed.attempt.id, f.author.id], 'the attempt is untouched')
    // Omitting the member id is still the way to leave work unassigned.
    await definitions.get('swarm_handoff').execute({ missionId: f.mission.id, taskId: task.id, attemptId: claimed.attempt.id, summary: 'Checkpointed' }, as(f.author.sessionId))
    assert.equal(f.runtime.store.get('tasks', task.id).assigneeId, undefined)
  } finally { await f.cleanup() }
})

test('swarm_budget without its conditional object and a non-object call are typed [tool_arguments_invalid] refusals naming what is missing', async () => {
  const schemaIndex = await toolSchemaIndex()
  const { calls, definitions } = recordingTools()
  const exec = { agent: { id: 'owner' }, signal: new AbortController().signal }
  const typed = (...fragments) => error => {
    assert.equal(error.name, 'PolicyError'); assert.equal(error.code, 'tool_arguments_invalid'); assert.equal(error.category, 'validation_error')
    assert.ok(error.message.startsWith('[tool_arguments_invalid] '), error.message)
    for (const fragment of fragments) assert.ok(error.message.includes(fragment), `${fragment} in ${error.message}`)
    return true
  }
  // Used to fail inside object() as a plain Error saying "Expected an object".
  await assert.rejects(definitions.get('swarm_budget').execute({ missionId: 'mission_1', taskId: 'task_1', reason: 'raise' }, exec), typed('called with `taskId` but no `taskBudget`', 'Pass `taskBudget`'))
  await assert.rejects(definitions.get('swarm_budget').execute({ missionId: 'mission_1', reason: 'raise' }, exec), typed('called with neither `budget` nor `taskId`', 'Pass `budget`'))
  for (const message of await Promise.all([{ missionId: 'mission_1', taskId: 'task_1', reason: 'raise' }, { missionId: 'mission_1', reason: 'raise' }]
    .map(args => definitions.get('swarm_budget').execute(args, exec).catch(error => error.message)))) assert.deepEqual(assessText(message, schemaIndex), [], message)
  for (const value of ['{"missionId":', [], null, 7]) {
    await assert.rejects(definitions.get('swarm_observe').execute(value, exec), typed('Expected an object: pass this tool\'s named parameters as one JSON object'))
  }
  assert.deepEqual(calls, [], 'no refused call reached the runtime')
})
