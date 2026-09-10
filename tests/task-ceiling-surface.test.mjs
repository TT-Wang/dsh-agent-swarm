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
import { registerTools } from '../lib/tools.js'

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
  const propose = extra => definitions.get('swarm_propose').execute({ missionId: mission.id, workstreamId: stream.id, title: 'Bound', objective: 'Bound the work', kind: 'research', scope: ['src/'], acceptance: ['works'], ...extra }, execution)
  return { runtime, workers, owner, mission, stream, builder, definitions, propose }
}

test('the propose tool refuses a ceiling above the mission budget with its own code and admits a valid one', async t => {
  const f = await setup(t)
  const properties = f.definitions.get('swarm_propose').parameters.properties
  assert.equal(properties.maxSteps.type, 'integer')
  assert.equal(properties.maxFindings.type, 'integer')
  await assert.rejects(f.propose({ maxSteps: budget.maxSteps + 1 }), /\[task_ceiling_exceeds_mission_budget\]/)
  await assert.rejects(f.propose({ maxFindings: 0 }), /\[task_ceiling_invalid\]/)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.length, 0, 'a refused ceiling admits no task')
  const admitted = (await f.propose({ maxSteps: 7, maxFindings: 3 })).result
  assert.equal(admitted.maxSteps, 7)
  assert.equal(admitted.maxFindings, 3)
})

test('the task_ceiling_exhausted advice is executable: replaces + a raised maxSteps through the tool', async t => {
  const f = await setup(t)
  const task = (await f.propose({ maxSteps: 2 })).result
  await f.runtime.claim({ sessionId: f.builder.sessionId }, f.mission.id, task.id)
  await f.workers.callbacks.beforeStep(f.builder.id)
  await f.workers.callbacks.beforeStep(f.builder.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.builder.id), false, 'the exhausted step parks the worker')
  const blocked = f.runtime.snapshot(f.owner, f.mission.id).tasks.find(item => item.id === task.id)
  assert.equal(blocked.status, 'blocked')
  // The durable refusal must carry the code and an exit whose names resolve in
  // the schema the tool surface actually installs.
  assert.match(blocked.ceiling.reason, /\[task_ceiling_exhausted\]/)
  assert.match(blocked.ceiling.reason, /`swarm_propose`/)
  assert.match(blocked.ceiling.reason, /`replaces`/)
  assert.match(blocked.ceiling.reason, /`maxSteps`/)
  const properties = f.definitions.get('swarm_propose').parameters.properties
  for (const parameter of ['replaces', 'maxSteps', 'maxFindings']) assert.ok(properties[parameter], `swarm_propose declares ${parameter}`)
  const repair = (await f.propose({ title: 'Repair', objective: 'Repair the bounded work', replaces: [task.id], maxSteps: 9, maxFindings: 4 })).result
  assert.equal(repair.maxSteps, 9, 'the repair carries the raised ceiling instead of discarding the headroom')
  assert.equal(repair.maxFindings, 4)
  assert.deepEqual(repair.replaces, [task.id])
  assert.deepEqual(repair.acceptance, ['works'], 'the repair keeps the blocked acceptance verbatim')
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.tasks.filter(item => item.id === task.id).length, 1)
  const admittedRepair = snapshot.tasks.find(item => item.id === repair.id)
  assert.ok(['pending', 'running'].includes(admittedRepair.status), `the repair is admitted and schedulable (${admittedRepair.status})`)
})
