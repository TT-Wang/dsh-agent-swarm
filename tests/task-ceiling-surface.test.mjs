/**
 * S3 behavioral half (T2): the ceiling parameters the durable
 * `task_ceiling_exhausted` refusal tells the owner to raise must exist on the
 * tool that performs the repair, and the repair must actually work through that
 * tool. On the pre-fix head `swarm_propose` declared no `maxSteps`/`maxFindings`
 * (`additionalProperties: false`), so the advice had no executable half.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { OWNER_PROMPT, registerTools } from '../lib/tools.js'
import { guardTerminal } from '../lib/refusals.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 12, maxExperiments: 2 }

class ControlledWorkers {
  callbacks; deliveries = []; stopped = []; checks = [{ command: 'test', exitCode: 0, output: 'ok' }]; artifact = { commit: 'abc', baseCommit: 'base', workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, id) { return `/isolated/${id}` }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push(delivery) }
  async stop(id) { this.stopped.push(id) }
  isIdle() { return false }
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async prepareTask() {}
  async dispose() {}
}

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-ceiling-surface-'))
  const workers = new ControlledWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 200, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'ceiling-owner' }
  const mission = runtime.create(owner, { title: 'Ceiling surface', objective: 'Bound per-task work', workspace: '/source', scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Core', objective: 'Bound per-task work' })
  const builder = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  const execution = { agent: { id: 'ceiling-owner' }, signal: new AbortController().signal }
  const propose = extra => definitions.get('swarm_propose').execute({ missionId: mission.id, workstreamId: stream.id, title: 'Bound', objective: 'Bound the work', kind: 'research', scope: ['src/'], acceptance: ['works'], outputs: [], ...extra }, execution)
  return { runtime, workers, owner, mission, stream, builder, definitions, propose }
}

test('the propose tool refuses a ceiling above the mission budget with its own code and admits a valid one', async t => {
  const f = await setup(t)
  const properties = f.definitions.get('swarm_propose').parameters.properties
  assert.equal(properties.maxSteps.type, 'integer')
  assert.equal(properties.maxFindings.type, 'integer')
  assert.match(properties.maxFindings.description, /advisory/i)
  assert.doesNotMatch(properties.maxFindings.description, /blocks the task/)
  assert.match(f.definitions.get('swarm_propose').description, /swarm_budget\(taskId, taskBudget, reason\)/)
  assert.doesNotMatch(f.definitions.get('swarm_propose').description, /raise.*name it in replaces/i)
  assert.match(OWNER_PROMPT, /swarm_message with replyTo/)
  await assert.rejects(f.propose({ maxSteps: budget.maxSteps + 1 }), /\[task_ceiling_exceeds_mission_budget\]/)
  await assert.rejects(f.propose({ maxFindings: 0 }), /\[task_ceiling_invalid\]/)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.length, 0, 'a refused ceiling admits no task')
  const admitted = (await f.propose({ maxSteps: 7, maxFindings: 3 })).result
  assert.equal(admitted.maxSteps, 7)
  assert.equal(admitted.maxFindings, 3)
})

test('task ceiling advice raises the original task allocation through the registered tool', async t => {
  const f = await setup(t)
  const task = (await f.propose({ maxSteps: 2 })).result
  await f.runtime.claim({ sessionId: f.builder.sessionId }, f.mission.id, task.id)
  await f.workers.callbacks.beforeStep(f.builder.id)
  await f.workers.callbacks.beforeStep(f.builder.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.builder.id), false)
  const blocked = f.runtime.task(f.mission.id, task.id)
  assert.match(blocked.ceiling.reason, /`swarm_budget`/)
  assert.match(blocked.ceiling.reason, /`taskBudget`/)
  const tool = f.definitions.get('swarm_budget')
  assert.ok(tool.parameters.properties.taskBudget.properties.maxSteps)
  await tool.execute({ missionId: f.mission.id, taskId: task.id, taskBudget: { maxSteps: 9, maxFindings: 4 }, reason: 'Useful work needs more allowance' }, { agent: { id: f.owner.sessionId }, signal: new AbortController().signal })
  for (let i = 0; i < 100 && f.runtime.task(f.mission.id, task.id).resumeAfterStop; i++) await new Promise(resolve => setTimeout(resolve, 5))
  const revised = f.runtime.task(f.mission.id, task.id)
  assert.equal(revised.maxSteps, 9)
  assert.equal(revised.maxFindings, 4)
  assert.equal(revised.usedSteps, 2)
  assert.deepEqual(revised.acceptance, ['works'])
  assert.equal(f.runtime.store.list('tasks', f.mission.id).length, 1)
  assert.equal(revised.status, 'pending')
})

test('guard exits select the actual mission or same-task amendment parameter', () => {
  const mission = guardTerminal('task_ceiling')
  assert.deepEqual(mission.exits.map(exit => [exit.tool, exit.parameter]), [['swarm_budget', 'budget']])
  assert.doesNotMatch(mission.message, /`taskBudget`/)
  const task = guardTerminal('task_ceiling', { taskId: 'existing-task' })
  assert.equal(task.exits[0].parameter, 'taskBudget')
  assert.match(task.message, /`taskId`/)
  assert.match(guardTerminal('budget').message, /sufficient extension resumes budget-paused work after stop confirmation/)
})
