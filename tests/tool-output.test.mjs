import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTools } from '../lib/tools.js'
const budget = { maxTokens: 100, maxSteps: 10, maxWorkers: 2, maxDurationMs: 10000, maxTasks: 4, maxExperiments: 0 }
function tools() { const definitions = new Map(); registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, {}, budget); return definitions }
test('summary observation preserves current provenance identities while omitting duplicate large payloads', () => {
  const observe = tools().get('swarm_observe')
  const raw = { events: [{ seq: 1, type: 'mission/created', actor: 'owner', data: { nested: 'large'.repeat(10000) } }], toolRuns: [{ id: 'run1', taskId: 'task1', attemptId: 'attempt1', memberId: 'worker1', tool: 'bash', isError: false, arguments: { command: 'node check.cjs' }, result: { output: 'large'.repeat(20000) } }] }
  const original = structuredClone(raw)
  const rendered = observe.output.render({}, { result: raw })[0].text
  const data = JSON.parse(rendered).result
  assert.equal(data.toolRuns[0].id, 'run1'); assert.equal(data.toolRuns[0].attemptId, 'attempt1'); assert.equal(data.toolRuns[0].taskId, 'task1')
  assert.match(data.detail, /detail=full/); assert.match(data.toolRuns[0].resultPreview, /truncated/)
  assert(rendered.length < 4000, `Summary should not repeat whole stored tool payload: ${rendered.length}`)
  assert.deepEqual(raw, original)
  assert.deepEqual(JSON.parse(observe.output.render({ detail: 'full' }, { result: raw })[0].text).result, raw)
})
test('all model plan entry points require their chosen budget; automatic schema requires operational policy fields', () => {
  const definitions = tools()
  for (const name of ['swarm_launch', 'swarm_create', 'swarm_stage']) assert(definitions.get(name).parameters.required.includes('budget'))
  const properties = definitions.get('swarm_launch').parameters.properties
  assert(properties.members.items.required.includes('maxOutputTokens'))
  for (const key of ['key', 'assigneeKey', 'maxRecoveryAttempts', 'checkTimeoutMs']) assert(properties.tasks.items.required.includes(key))
  assert.equal(properties.budget.properties.maxTokens.default, undefined)
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
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
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
