import test from 'node:test'
import assert from 'node:assert/strict'
import { executionClock, executionElapsed } from '../lib/resource-time.js'
import { guardTerminal } from '../lib/refusals.js'
import { registerTools } from '../lib/tools.js'
import { FakeClock, FakeWorkers, budget as sharedBudget, eventually, makeRuntime, setup } from './faults/harness.mjs'

const budget = { ...sharedBudget, maxTokens: 100000, maxSteps: 100, maxWorkers: 4, maxTasks: 20, maxExperiments: 2 }
class Workers extends FakeWorkers {
  stops = []; checkpoints = []
  async stop(id) { this.stops.push(id); await this.stopping }
  async checkpointTask(member, task) { this.checkpoints.push({ memberId: member.id, taskId: task.id, epoch: task.epoch }) }
}
async function fixture(t) {
  const workers = new Workers()
  // Registered first, so a held stop is released before makeRuntime's cleanup disposes the runtime.
  t.after(() => { workers.stopping = undefined })
  const { dir, config, runtime: rt } = await makeRuntime(t, { workers, config: { tickMs: 60000, maxEvents: 500, checkTimeoutMs: undefined } })
  const owner = { sessionId: 'owner' }
  const mission = rt.create(owner, { title: 'Continue the obligation', objective: 'Same work with revised estimates', workspace: dir, scope: ['src/'], acceptance: ['works'], budget }, { grantRoot: dir, source: 'session' })
  const ws = rt.workstream(owner, mission.id, { title: 'Core', objective: 'Build it' })
  const member = await rt.addMember(owner, mission.id, { name: 'Ada', role: 'builder' })
  const other = await rt.addMember(owner, mission.id, { name: 'Alan', role: 'builder and review' })
  const actor = { sessionId: member.sessionId }
  const propose = (extra = {}) => rt.propose(owner, mission.id, { outputs: [], workstreamId: ws.id, title: `Work ${rt.store.list('tasks', mission.id).length}`, objective: 'Implement source', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], maxSteps: 2, maxFindings: 2, maxRecoveryAttempts: 2, checkTimeoutMs: 1000, assigneeId: member.id, ...extra })
  return { rt, config, workers, owner, mission, member, other, actor, propose }
}

test('task budget increase before stop confirmation preserves identity, usage and work then resumes', async t => {
  const f = await fixture(t)
  const task = await f.rt.claim(f.actor, f.mission.id, f.propose().id)
  let release
  f.workers.stopping = new Promise(resolve => { release = resolve })
  await f.workers.callbacks.beforeStep(f.member.id)
  await f.workers.callbacks.beforeStep(f.member.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.member.id), false)
  await eventually(() => f.workers.stops.length, 'Expected recovery transition')
  const held = f.rt.task(f.mission.id, task.id)
  assert.equal(held.resumeAfterStop.reason, 'resource')
  const revised = f.rt.controlTask(f.owner, f.mission.id, task.id, 'amend', { maxSteps: 8 }, 'The useful implementation needs more work')
  assert.equal(revised.status, 'blocked', 'old handle still owns the write barrier')
  assert.equal(revised.usedSteps, 2)
  assert.equal(revised.id, task.id)
  assert.equal(revised.ceiling, undefined)
  assert.equal(revised.evidenceIds.length, 0)
  release(); f.workers.stopping = undefined
  await eventually(() => f.rt.task(f.mission.id, task.id).status === 'pending', 'Expected recovery transition')
  assert.equal(f.workers.checkpoints[0].taskId, task.id)
  const resumed = await f.rt.claim(f.actor, f.mission.id, task.id)
  assert.notEqual(resumed.attempt.id, task.attempt.id)
  assert.equal(resumed.usedSteps, 2)
  await f.workers.callbacks.beforeStep(f.member.id)
  assert.equal(f.rt.task(f.mission.id, task.id).usedSteps, 3)
  assert.equal(f.rt.mission(f.mission.id).usedSteps, 3)
  assert.equal(f.rt.store.list('tasks', f.mission.id).length, 1)
})

test('ceiling remains recoverable after confirmed stop and explicit pause is not undone', async t => {
  const f = await fixture(t)
  const task = await f.rt.claim(f.actor, f.mission.id, f.propose({ maxSteps: 1 }).id)
  await f.workers.callbacks.beforeStep(f.member.id)
  await f.workers.callbacks.beforeStep(f.member.id)
  await eventually(() => !f.rt.task(f.mission.id, task.id).resumeAfterStop, 'Expected recovery transition')
  assert.equal(f.rt.task(f.mission.id, task.id).status, 'blocked')
  f.rt.control(f.owner, f.mission.id, 'pause', 'User pause')
  f.rt.controlTask(f.owner, f.mission.id, task.id, 'amend', { maxSteps: 5 }, 'Review estimate')
  assert.equal(f.rt.mission(f.mission.id).status, 'paused')
  assert.equal(f.rt.task(f.mission.id, task.id).status, 'pending')
  assert.equal(f.rt.task(f.mission.id, task.id).usedSteps, 1)
})

test('owner can fence and reassign a running task without a member attempt argument', async t => {
  const f = await fixture(t)
  const task = await f.rt.claim(f.actor, f.mission.id, f.propose().id)
  assert.throws(() => f.rt.controlTask(f.actor, f.mission.id, task.id, 'amend', { assigneeId: f.other.id }, 'self change'), /Only the primary/)
  const changed = f.rt.controlTask(f.owner, f.mission.id, task.id, 'amend', { assigneeId: f.other.id }, 'Change route')
  assert.equal(changed.status, 'blocked')
  assert.equal(changed.attempt, undefined)
  await eventually(() => f.rt.task(f.mission.id, task.id).status === 'pending', 'Expected recovery transition')
  const resumed = await f.rt.claim({ sessionId: f.other.sessionId }, f.mission.id, task.id)
  assert.ok(resumed.priorOwnerIds.includes(f.member.id))
  assert.equal(resumed.attempt.ownerId, f.other.id)
  assert.equal(f.workers.checkpoints[0].memberId, f.member.id)
})

test('task policy amendments preserve obligations and reject invalid scopes, cycles and immutable artifacts', async t => {
  const f = await fixture(t)
  const a = f.propose()
  const b = f.propose({ dependencies: [a.id] })
  assert.throws(() => f.rt.controlTask(f.owner, f.mission.id, a.id, 'amend', { dependencies: [b.id] }, 'Cycle'), /cycle/)
  assert.throws(() => f.rt.controlTask(f.owner, f.mission.id, a.id, 'amend', { scope: ['../secret'] }, 'Bad'), /invalid/)
  assert.throws(() => f.rt.controlTask(f.owner, f.mission.id, a.id, 'amend', { acceptance: [] }, 'Drop obligation'), /Unknown task amendment/)
  f.rt.amendScope(f.owner, f.mission.id, ['src/', 'docs/'], 'Documentation is part of the requested delivery')
  const changed = f.rt.controlTask(f.owner, f.mission.id, a.id, 'amend', { scope: ['src/', 'docs/'], checks: ['node --version'], checkTimeoutMs: 2000 }, 'Correct execution plan')
  assert.deepEqual(changed.acceptance, a.acceptance)
  assert.deepEqual(changed.checks, ['node --version'])
  assert.throws(() => f.rt.amendScope(f.owner, f.mission.id, ['docs/'], 'Drop source'), /retain admitted/)
  const submitted = f.rt.task(f.mission.id, a.id)
  submitted.status = 'submitted'; submitted.artifact = { commit: 'exact', baseCommit: 'base', workspace: '/isolated', changedPaths: ['src/a.ts'] }
  f.rt.commit(f.mission.id, () => f.rt.store.put('tasks', submitted))
  assert.throws(() => f.rt.controlTask(f.owner, f.mission.id, a.id, 'amend', { checks: ['test -d .'] }, 'Weaken check'), /immutable/)
  f.rt.controlTask(f.owner, f.mission.id, a.id, 'amend', { checkTimeoutMs: 5000 }, 'Allow slow check')
  assert.equal(f.rt.task(f.mission.id, a.id).artifact.commit, 'exact')
})

test('finite recovery allocation can grow without erasing its consumed count', async t => {
  const f = await fixture(t)
  const task = f.propose()
  task.status = 'blocked'; task.recoveryCount = 2
  f.rt.commit(f.mission.id, () => f.rt.store.put('tasks', task))
  assert.throws(() => f.rt.controlTask(f.owner, f.mission.id, task.id, 'resume', {}, 'Retry'), /Raise maxRecoveryAttempts/)
  const revised = f.rt.controlTask(f.owner, f.mission.id, task.id, 'amend', { maxRecoveryAttempts: 4 }, 'Environment repaired')
  assert.equal(revised.status, 'pending')
  assert.equal(revised.recoveryCount, 2)
  assert.throws(() => f.rt.controlTask(f.owner, f.mission.id, task.id, 'amend', { maxRecoveryAttempts: 1 }, 'Reset credit'), /consumed recovery/)
})

test('startup infrastructure failures do not consume queued task recovery and reroute after bounded route failures', async t => {
  const f = await fixture(t)
  const tasks = [f.propose({ maxRecoveryAttempts: 1 }), f.propose({ maxRecoveryAttempts: 1 })]
  for (let index = 0; index < 3; index++) f.rt.onStartFailure(f.mission, f.member, new Error('startup failure'))
  for (const task of tasks) {
    const current = f.rt.task(f.mission.id, task.id)
    assert.equal(current.status, 'pending')
    assert.equal(current.recoveryCount ?? 0, 0)
    assert.equal(current.epoch, 0)
    assert.equal(current.assigneeId, f.other.id)
  }
})

test('execution allowance pauses during idle/user wait while an explicit deadline stays fixed', async t => {
  const f = await fixture(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const before = executionElapsed(f.rt.mission(f.mission.id))
  now += 120000
  assert.equal(executionElapsed(f.rt.mission(f.mission.id)), before)
  const task = await f.rt.claim(f.actor, f.mission.id, f.propose().id)
  now += 1000
  assert.equal(executionElapsed(f.rt.mission(f.mission.id)), 1000)
  f.rt.control(f.owner, f.mission.id, 'pause', 'Review requested')
  now += 700000
  assert.equal(executionElapsed(f.rt.mission(f.mission.id)), 1000)
  f.rt.control(f.owner, f.mission.id, 'resume', 'Continue')
  assert.equal(f.rt.task(f.mission.id, task.id).id, task.id)
  const absolute = now + 5000
  f.rt.updateBudget(f.owner, f.mission.id, { ...budget, deadlineAt: absolute }, 'User finish-by limit')
  now += 10000
  assert.equal(f.rt.mission(f.mission.id).deadline, absolute)
  assert.throws(() => f.rt.control(f.owner, f.mission.id, 'resume', 'Too late'), /budget exhausted/)
})

test('duration accounting keeps consumed work when an estimate is revised', () => {
  const mission = { createdAt: 0, updatedAt: 50, status: 'active', executionTime: { usedMs: 50, since: 100 }, budget: { ...budget, maxDurationMs: 1000 } }
  executionClock(mission, false, 200)
  assert.equal(mission.executionTime.usedMs, 150)
  executionClock(mission, false, 800)
  assert.equal(mission.executionTime.usedMs, 150)
  mission.budget.maxDurationMs = 2000
  executionClock(mission, true, 1000)
  assert.equal(mission.deadline, 2850)
})

test('tool surface adjusts one task allocation and guard notices only name owner-executable recovery', async t => {
  const f = await fixture(t)
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.rt, budget)
  const task = f.propose()
  const tool = definitions.get('swarm_budget')
  await tool.execute({ missionId: f.mission.id, taskId: task.id, taskBudget: { maxSteps: 10 }, reason: 'Reviewed progress' }, { signal: new AbortController().signal, agent: { id: f.owner.sessionId } })
  assert.equal(f.rt.task(f.mission.id, task.id).maxSteps, 10)
  for (const chain of ['attempt_lease', 'task_ceiling', 'workspace']) {
    const terminal = guardTerminal(chain, { taskId: task.id })
    assert.doesNotMatch(JSON.stringify(terminal), /swarm_handoff/)
  }
})

 test('idle held attempts stop consuming duration until execution becomes active again', async t => {
  const f = await fixture(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const task = await f.rt.claim(f.actor, f.mission.id, f.propose().id)
  now += 1000
  f.workers.autoIdle = true
  f.rt.commit(f.mission.id, () => {})
  now += 120000
  assert.equal(f.rt.task(f.mission.id, task.id).status, 'running')
  assert.equal(executionElapsed(f.rt.mission(f.mission.id)), 1000)
  f.workers.autoIdle = false
  f.rt.commit(f.mission.id, () => {})
  now += 500
  assert.equal(executionElapsed(f.rt.mission(f.mission.id)), 1500)
})

test('explicitly pinned startup routes wait for owner reassignment without exhausting the task', async t => {
  const f = await fixture(t)
  const task = f.propose({ assignmentMode: 'pinned', maxRecoveryAttempts: 1 })
  for (let index = 0; index < 3; index++) f.rt.onStartFailure(f.mission, f.member, new Error('unavailable route'))
  const waiting = f.rt.task(f.mission.id, task.id)
  assert.equal(waiting.assigneeId, f.member.id)
  assert.equal(waiting.status, 'pending')
  assert.equal(waiting.recoveryCount ?? 0, 0)
  const revised = f.rt.controlTask(f.owner, f.mission.id, task.id, 'amend', { assigneeId: f.other.id }, 'User requirement allows the reviewed alternative')
  assert.equal(revised.id, task.id)
  assert.equal(revised.assigneeId, f.other.id)
})

test('a budget amendment omitting the fixed deadline preserves the prior user limit', async t => {
  const f = await fixture(t)
  const deadlineAt = Date.now() + 50000
  f.rt.updateBudget(f.owner, f.mission.id, { ...budget, deadlineAt }, 'User requires delivery by this time')
  const changed = f.rt.updateBudget(f.owner, f.mission.id, { ...budget, maxTokens: 200000 }, 'More tokens, same deadline')
  assert.equal(changed.deadlineAt, deadlineAt)
  assert.equal(f.rt.mission(f.mission.id).deadline, deadlineAt)
})

test('a budget resume hands the worker only the resume: the assignment the pause left unsent is settled with it, never sent after it', async t => {
  const clock = new FakeClock(), f = await setup({ clock, budget: { maxTokens: 40, maxSteps: 100 } })
  t.after(f.cleanup)
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  const pass = async () => { await f.runtime.tick(); await f.runtime.settle(f.mission.id) }
  const assignments = () => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.kind === 'assignment' && delivery.taskId === task.id)
  // The usage report exhausts maxTokens before any pass sent the claim's assignment, and the pause holds it.
  await f.workers.callbacks.usage(f.author.id, 40)
  await pass(); await pass()
  assert.equal(f.runtime.mission(f.mission.id).budgetPause?.quiesced, true, 'the exhausted mission quiesced')
  const [held] = assignments()
  assert.deepEqual([assignments().length, held.attemptId, held.deliveredAt], [1, claimed.attempt.id, undefined], 'the claim\'s assignment is still unsent')
  f.runtime.updateBudget(f.owner, f.mission.id, { ...sharedBudget, maxTokens: 100_000 }, 'Raise the exhausted ceiling')
  f.runtime.control(f.owner, f.mission.id, 'resume', 'Budget raised')
  await pass(); await pass()
  const [settled, resumed, ...others] = assignments()
  assert.deepEqual([settled.id, others], [held.id, []], 'the resume writes one assignment beside the held one')
  assert.deepEqual([resumed.attemptId, JSON.parse(resumed.content).instructions.startsWith('Resume this same task and attempt')], [claimed.attempt.id, true])
  assert.notEqual(settled.deliveredAt, undefined, 'the held assignment is settled, superseded by the resume')
  assert.deepEqual(f.workers.deliveries.filter(delivery => delivery.kind === 'assignment').map(delivery => delivery.id), [resumed.id], 'the worker is handed only the resume')
})

test('an owner\'s budget raise resumes a budget wait only when no dimension is still exhausted', async t => {
  const clock = new FakeClock(), f = await setup({ clock, budget: { maxTokens: 40, maxSteps: 100 } })
  t.after(f.cleanup)
  await f.workers.callbacks.usage(f.author.id, 40)
  const status = () => f.runtime.mission(f.mission.id).status
  assert.deepEqual([status(), f.runtime.mission(f.mission.id).budgetPause !== undefined], ['blocked', true], 'the token ceiling paused the mission')
  const raise = (allocation, reason) => f.runtime.updateBudget(f.owner, f.mission.id, { ...sharedBudget, maxSteps: 100, ...allocation }, reason)
  raise({ maxTokens: 40 }, 'The same token ceiling')
  assert.equal(status(), 'blocked', 'the tokens are still exhausted')
  raise({ maxTokens: 100_000, deadlineAt: clock.now() }, 'More tokens, but the deadline is now')
  assert.equal(status(), 'blocked', 'the duration is exhausted')
  raise({ maxTokens: 100_000, deadlineAt: clock.now() + 600_000 }, 'More tokens and time')
  assert.equal(status(), 'active', 'nothing is exhausted, so the budget wait resumes')
})

test('an admission refused on the budget names the exhausted dimension: the deadline before the tokens before the steps', async t => {
  const clock = new FakeClock(), f = await setup({ clock })
  t.after(f.cleanup)
  const mission = f.runtime.mission(f.mission.id), { maxTokens, maxSteps } = mission.budget, now = clock.now()
  const blocked = ({ usedTokens = maxTokens - 1, usedSteps = maxSteps - 1, deadline = now + 1 }) => f.runtime.refusals.budgetBlocked({ ...mission, usedTokens, usedSteps, deadline })
  const duration = `mission duration budget exhausted (deadline ${new Date(now).toISOString()})`
  const tokens = `token budget exhausted (${maxTokens}/${maxTokens})`, steps = `step budget exhausted (${maxSteps}/${maxSteps})`
  assert.deepEqual([
    blocked({}), blocked({ usedSteps: maxSteps }), blocked({ usedTokens: maxTokens }), blocked({ deadline: now }),
    blocked({ usedTokens: maxTokens, usedSteps: maxSteps }), blocked({ usedTokens: maxTokens, usedSteps: maxSteps, deadline: now }),
  ], [undefined, steps, tokens, duration, tokens, duration])
})
