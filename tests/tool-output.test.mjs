import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSyntaxDetail, declaredPlanChecks } from '../lib/plans.js'
import { registerTools } from '../lib/tools.js'
import { Workspaces } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'
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
  for (const key of ['key', 'assigneeKey', 'maxRecoveryAttempts']) assert(properties.tasks.items.required.includes(key))
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
  assert.deepEqual(propose.required, ['missionId', 'workstreamId', 'title', 'objective', 'kind', 'scope', 'outputs'])
  assert.deepEqual(propose.properties.acceptance.items, { type: 'string' }, 'the property stays declared as a string array')
  assert.match(propose.properties.acceptance.description, /Required unless replaces is given/)
  assert(propose.properties.replaces, 'replaces carries the inheritance')
  assert(definitions.get('swarm_create').parameters.required.includes('acceptance'))
  for (const name of ['swarm_launch', 'swarm_stage']) {
    assert(definitions.get(name).parameters.required.includes('acceptance'), `${name} mission acceptance`)
    assert(definitions.get(name).parameters.properties.tasks.items.required.includes('acceptance'), `${name} task acceptance`)
  }
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
