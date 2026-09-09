/**
 * Round 9-C durable check-lineage regression (companion F4b to F4).
 *
 * A replacement or a re-submission that changes a declared check on a task that
 * already declared checks emits a durable `task/check-changed` event naming the
 * source task, the previous checks and the new checks, so an owner can see that
 * the check no longer matches the original acceptance. Pre-fix only
 * `task/proposed` was written, and a same-id re-submission silently kept the
 * original check with no trace of the attempted swap.
 *
 * The event never changes task state or grants authority: the stored record is
 * untouched and a first proposal that merely supplies checks the original task
 * never declared is not a change.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 200, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 0 }

async function runtimeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-check-events-'))
  const workers = {
    bind(callbacks) { this.callbacks = callbacks },
    async prepareWorkspace(mission, id) { return join(mission.workspace, id) },
    async start() {}, async prepareTask() {}, async deliver() {}, async stop() {},
    isIdle() { return false }, async dispose() {},
  }
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 10 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'check-events-owner' }
  const mission = runtime.create(owner, { title: 'Check lineage', objective: 'Track declared checks', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const propose = extra => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement change',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['npm run typecheck'], ...extra })
  const research = extra => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Analyse', objective: 'Analyse the change',
    kind: 'research', scope: ['src/'], acceptance: ['works'], ...extra })
  const checkEvents = () => runtime.store.events(mission.id, 500).filter(event => event.type === 'task/check-changed')
  return { runtime, owner, mission, stream, propose, research, checkEvents }
}

test('a replacement that changes the declared check emits a durable task/check-changed event', async t => {
  const f = await runtimeFixture(t)
  const original = f.propose({ title: 'Original work' })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'The check no longer covers the acceptance' })
  const repair = f.propose({ title: 'Repair', replaces: [original.id], checks: ['npm run typecheck && npm run build'] })
  const [changed] = f.checkEvents()
  assert.ok(changed, 'the durable event exists')
  assert.deepEqual(changed.data, {
    taskId: repair.id, sourceTaskId: original.id, replaces: [original.id], reason: 'replacement',
    previousChecks: ['npm run typecheck'], checks: ['npm run typecheck && npm run build'],
  }, 'the event names the source task and both checks so an owner can compare them with the acceptance')

  // An unchanged check stays silent; a second changed check is recorded too.
  const same = f.propose({ title: 'Same check work', checks: ['npm test'] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: same.id, reason: 'Repair without touching the check' })
  f.propose({ title: 'Same check repair', replaces: [same.id], checks: ['npm test'] })
  assert.equal(f.checkEvents().length, 1, 'an identical replacement check emits nothing')
  const rewritten = f.propose({ title: 'Rewritten check work', checks: ['npm test'] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: rewritten.id, reason: 'The check drifted from the acceptance' })
  const second = f.propose({ title: 'Rewritten check repair', replaces: [rewritten.id], checks: ['npm run build'] })
  assert.equal(f.checkEvents().length, 2, 'a second changed check is recorded')
  assert.deepEqual(f.checkEvents()[1].data, {
    taskId: second.id, sourceTaskId: rewritten.id, replaces: [rewritten.id], reason: 'replacement',
    previousChecks: ['npm test'], checks: ['npm run build'],
  })
  // The event never mutates the replaced or the replacement task.
  assert.deepEqual(f.runtime.store.get('tasks', original.id).checks, ['npm run typecheck'])
  assert.deepEqual(f.runtime.store.get('tasks', repair.id).checks, ['npm run typecheck && npm run build'])
})

test('a replacement that only fills in checks the original task never declared emits nothing', async t => {
  const f = await runtimeFixture(t)
  const original = f.research({ title: 'Analysis without a check' })
  assert.deepEqual(original.checks, [], 'the original task declared no check')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'Repair the analysis' })
  const repair = f.research({ title: 'Analysis with a check', replaces: [original.id], checks: ['node check.cjs'] })
  assert.deepEqual(repair.checks, ['node check.cjs'])
  assert.equal(f.checkEvents().length, 0, 'supplying checks the original never declared is not a change')
})

test('a replacement that drops a declared check is recorded', async t => {
  const f = await runtimeFixture(t)
  const original = f.research({ title: 'Analysis with a check', checks: ['node check.cjs'] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'Repair the analysis' })
  const repair = f.research({ title: 'Analysis without a check', replaces: [original.id] })
  assert.deepEqual(repair.checks, [], 'the replacement declares no check')
  assert.deepEqual(f.checkEvents().map(event => event.data), [{
    taskId: repair.id, sourceTaskId: original.id, replaces: [original.id], reason: 'replacement',
    previousChecks: ['node check.cjs'], checks: [],
  }], 'dropping the original check is a change and is recorded')
})

test('a re-submission with a changed declared check is recorded and never silently swapped', async t => {
  const f = await runtimeFixture(t)
  const task = f.propose({ title: 'Submitted work', checks: ['npm run typecheck'] })
  const resubmitted = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Submitted work', objective: 'Implement change',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['npm run typecheck && npm run test:faults'],
  }, task.id)
  assert.deepEqual(resubmitted.checks, ['npm run typecheck'], 'the durable record keeps the original check')
  const [changed] = f.checkEvents()
  assert.ok(changed, 'the attempted swap is durably visible')
  assert.deepEqual(changed.data, {
    taskId: task.id, sourceTaskId: task.id, reason: 'resubmission',
    previousChecks: ['npm run typecheck'], checks: ['npm run typecheck && npm run test:faults'],
  })
  // A first re-submission that merely fills in a check the task never declared is not a change.
  const research = f.research({ title: 'Analysis without a check' })
  f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Analysis without a check', objective: 'Analyse the change',
    kind: 'research', scope: ['src/'], acceptance: ['works'], checks: ['node check.cjs'],
  }, research.id)
  assert.equal(f.checkEvents().length, 1, 'filling in an undeclared check emits nothing')
})
