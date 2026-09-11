import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools.js'
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

test('launch rejects indexed shell syntax errors before admission and syntax checks never execute commands', async t => {
  const { mkdtemp, access, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const workspace = await mkdtemp(join(tmpdir(), 'swarm-check-syntax-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  let launches = 0
  const snapshot = { mission: { id: 'mission-one' } }
  const runtime = { starts: () => [{ id: 'request-one', workspace }], async startPlan(_actor, _id, plan) { launches++; assert.equal(plan.budget.maxTokens, 12345); return snapshot }, snapshot: () => snapshot }
  const definitions = new Map()
  // The launch path probes every declared check's shell syntax through the host
  // managed-process seam, so this stub host supplies the real provider — the
  // assertion below is that the probe runs without executing the check.
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) }, get: name => name === 'subprocess' ? subprocessSeam() : undefined }, runtime, budget)
  const input = { requestId: 'request-one', title: 'Goal', objective: 'Deliver the goal', scope: ['result.txt'], acceptance: ['works'], budget: { ...budget, maxTokens: 12345 },
    members: [{ key: 'a', name: 'A', role: 'delivery', maxOutputTokens: 1024 }, { key: 'b', name: 'B', role: 'review', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'w', title: 'Work', objective: 'Deliver' }], tasks: [
      { key: 't', workstreamKey: 'w', title: 'Deliver', objective: 'Deliver', kind: 'integration', scope: ['result.txt'], acceptance: ['works'], checks: ['touch result.txt'], assigneeKey: 'a', maxRecoveryAttempts: 2, checkTimeoutMs: 1000 },
      { key: 'r', workstreamKey: 'w', title: 'Review', objective: 'Review', kind: 'verification', scope: ['result.txt'], acceptance: ['works'], reviewOf: 't', assigneeKey: 'b', maxRecoveryAttempts: 2, checkTimeoutMs: 1000 },
    ] }
  const execution = { agent: { id: 'owner' }, signal: new AbortController().signal }
  await definitions.get('swarm_launch').execute(input, execution)
  assert.equal(launches, 1)
  await assert.rejects(access(join(workspace, 'result.txt')), { code: 'ENOENT' })
  input.tasks[0].checks = ['echo pass | ! read -r c']
  await assert.rejects(definitions.get('swarm_launch').execute(input, execution), /tasks\[0\]\.checks\[0\].*invalid shell syntax/)
  assert.equal(launches, 1)
})
