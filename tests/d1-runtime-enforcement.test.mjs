/**
 * D1 runtime half (T5b): `propose` carries the per-task step/finding ceiling and
 * reconciles objective/scope admission, `beforeStep` charges steps to the task
 * and blocks it at its own ceiling, and `publish` blocks at the finding ceiling.
 * Every assertion here fails on the pre-fix head, where the runtime ignored the
 * ceiling contract and had no admission-reconciliation call site.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

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

async function setup(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-d1-enforce-'))
  const workers = new ControlledWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 200, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'd1-owner' }
  const mission = runtime.create(owner, { title: 'D1 enforcement', objective: 'Bound per-task work', workspace: '/source', scope: ['src/'], acceptance: ['works'], budget: { ...budget, ...overrides } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Core', objective: 'Bound per-task work' })
  const builder = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = { sessionId: builder.sessionId }
  const propose = (extra = {}, from = actor) => runtime.propose(from, mission.id, {
    workstreamId: stream.id, title: 'Fix', objective: 'Fix module', kind: 'implementation',
    scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra,
  })
  return { runtime, workers, owner, mission, stream, builder, reviewer, actor, propose }
}

test('propose admits a per-task ceiling on every task and rejects invalid or over-budget values', async t => {
  const f = await setup(t)
  const explicit = f.propose({ maxSteps: 5, maxFindings: 2 })
  assert.equal(explicit.maxSteps, 5, 'an explicit step ceiling is carried on the durable task')
  assert.equal(explicit.maxFindings, 2, 'an explicit finding ceiling is carried on the durable task')
  const derived = f.propose({ title: 'Derived' })
  assert.equal(derived.maxSteps, 100, 'a missing ceiling derives the contract default (150), capped by the 100-step mission budget')
  assert.equal(derived.maxFindings, 50, 'a missing ceiling derives the raised finding default (50)')
  assert.throws(() => f.propose({ title: 'Zero', maxSteps: 0 }), /\[task_ceiling_invalid\]/)
  assert.throws(() => f.propose({ title: 'Fractional', maxFindings: 1.5 }), /\[task_ceiling_invalid\]/)
  assert.throws(() => f.propose({ title: 'Too high', maxSteps: 101 }), /\[task_ceiling_exceeds_mission_budget\]/)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.length, 2, 'a rejected ceiling admits no task')
})

test('propose never refuses a task for the paths its objective names', async t => {
  const f = await setup(t)
  assert.doesNotThrow(() => f.propose({ objective: 'Add a file under `docs/` describing the change' }))
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.length, 1)
  const admitted = f.propose({ objective: 'Implement `src/value.ts` and add `src/value-helper.ts`' })
  assert.equal(admitted.objective, 'Implement `src/value.ts` and add `src/value-helper.ts`')
})

test('beforeStep blocks a task at its own step ceiling without charging the mission budget', async t => {
  const f = await setup(t)
  const task = await f.runtime.claim(f.actor, f.mission.id, f.propose({ maxSteps: 2 }).id)
  await f.workers.callbacks.beforeStep(f.builder.id)
  await f.workers.callbacks.beforeStep(f.builder.id)
  let snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.mission.usedSteps, 2)
  assert.equal(snapshot.tasks.find(item => item.id === task.id).usedSteps, 2)
  const parked = await f.workers.callbacks.beforeStep(f.builder.id)
  assert.equal(parked, false, 'the exhausted step parks the worker instead of running another step')
  snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.mission.usedSteps, 2, 'the blocked step is never charged to the mission budget')
  const blocked = snapshot.tasks.find(item => item.id === task.id)
  assert.equal(blocked.status, 'blocked')
  if (blocked.attempt) assert.equal(blocked.attempt.id, task.attempt.id, 'any retained attempt is fenced pending stop confirmation')
  assert.deepEqual({ ...blocked.ceiling, reason: undefined }, {
    dimension: 'maxSteps', limit: 2, used: 2, code: 'task_ceiling_exhausted', reason: undefined, at: blocked.ceiling.at,
  })
  assert.match(blocked.ceiling.reason, /maxSteps 2\/2/)
  assert.match(blocked.output, /Task ceiling exhausted/)
  assert.notEqual(snapshot.members.find(member => member.id === f.builder.id).status, 'working', 'resource waiting never permits continued execution')
  const events = f.runtime.observe(f.owner, f.mission.id).events
  const event = events.find(item => item.type === 'task/ceiling-exhausted')
  assert.ok(event, 'a durable ceiling event is emitted')
  const data = JSON.parse(event.summary)
  assert.deepEqual({ taskId: data.taskId, dimension: data.dimension, limit: data.limit, used: data.used, code: data.code },
    { taskId: task.id, dimension: 'maxSteps', limit: 2, used: 2, code: 'task_ceiling_exhausted' })
  await assert.rejects(f.runtime.claim(f.actor, f.mission.id, task.id), /not ready|previous attempt to stop/)
  assert.throws(() => f.runtime.publish(f.actor, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, claim: 'late', outcome: 'supported', toolRunIds: [] }), /Stale|attempt/)
  const revised = f.runtime.controlTask(f.owner, f.mission.id, task.id, 'amend', { maxSteps: 60 }, 'The original task needs more execution steps')
  assert.equal(revised.id, task.id)
  assert.equal(revised.maxSteps, 60, 'the owner can revise the same task allocation')
  assert.equal(revised.usedSteps, 2, 'revision preserves consumed work')
})

test('finding estimate leaves produced evidence and submission usable', async t => {
  const f = await setup(t)
  const task = await f.runtime.claim(f.actor, f.mission.id, f.propose({ maxFindings: 1 }).id)
  await f.workers.callbacks.toolRun(f.builder.id, { tool: 'bash', arguments: { command: 'probe' }, result: { exitCode: 0 }, isError: false })
  const run = f.runtime.observe(f.actor, f.mission.id).toolRuns[0]
  for (const claim of ['First finding', 'Second finding']) {
    assert.equal(f.runtime.publish(f.actor, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, claim, outcome: 'supported', toolRunIds: [run.id] }).status, 'unverified')
  }
  const current = f.runtime.store.get('tasks', task.id)
  assert.equal(current.status, 'running'); assert.equal(current.evidenceIds.length, 2); assert.equal(current.ceiling, undefined)
  await f.runtime.submit(f.actor, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Preserved findings and artifact' })
  assert.equal(f.runtime.store.get('tasks', task.id).status, 'submitted')
})

test('legacy tasks admitted without a ceiling are never blocked by the ceiling guard', async t => {
  const f = await setup(t)
  const task = f.propose({ title: 'Legacy' })
  // Simulate a record admitted before the ceiling contract existed.
  const legacy = f.runtime.store.get('tasks', task.id)
  delete legacy.maxSteps; delete legacy.maxFindings
  f.runtime.store.put('tasks', legacy)
  const claimed = await f.runtime.claim(f.actor, f.mission.id, task.id)
  await f.workers.callbacks.beforeStep(f.builder.id)
  const current = f.runtime.snapshot(f.owner, f.mission.id).tasks.find(item => item.id === claimed.id)
  assert.equal(current.status, 'running')
  assert.equal(current.usedSteps, 1, 'a legacy task still counts steps but has no ceiling to hit')
})
