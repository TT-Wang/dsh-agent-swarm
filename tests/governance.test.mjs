/**
 * T2 governance regressions: W8 member route admission, the owner's authority
 * to withdraw submitted work (D9), the cancel-during-submit message (F6),
 * deterministic-id re-admission of a cancelled task (F7) and the budget-warning
 * suggested limit (F11). Only the external execution adapter is replaced; store,
 * admission, state transitions and the outbox are the real runtime.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeWorkers, budget as sharedBudget, eventually, makeRuntime } from './faults/harness.mjs'

const budget = { ...sharedBudget, maxTokens: 1000, maxSteps: 10, maxWorkers: 4, maxTasks: 12, maxExperiments: 2 }

/**
 * The external execution boundary with a route catalog: `efforts` holds the
 * reasoning efforts each `provider/model` declares (none: the model declares no
 * reasoning), `unrouted` the routes the host does not resolve. A member with no
 * route of its own runs the owner's, `owner/default` here.
 */
class GovernanceWorkers extends FakeWorkers {
  efforts = new Map([['deepseek-official/flash', ['off', 'high']], ['owner/default', ['off', 'high']]])
  unrouted = new Set()
  routeQuestions = []
  captureStarted = false
  artifact = { commit: 'abc123', baseCommit: 'base', workspace: '/isolated', changedPaths: ['src/a.ts'] }
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  memberRoutes(ownerSessionId, members) {
    this.routeQuestions.push({ ownerSessionId, members: structuredClone(members) })
    return members.map(member => {
      const provider = member.provider ?? 'owner', model = member.model ?? 'default'
      if (this.unrouted.has(`${provider}/${model}`)) return { verdict: 'unavailable', provider, model }
      const efforts = this.efforts.get(`${provider}/${model}`) ?? []
      return member.reasoningEffort === undefined || efforts.includes(member.reasoningEffort) ? { verdict: 'accepted' }
        : { verdict: 'effort-unsupported', provider, model, effort: member.reasoningEffort, efforts }
    })
  }
  async captureArtifact() { this.captureStarted = true; if (this.captureGate) await this.captureGate; return this.artifact }
}

async function setup(t, options = {}) {
  const { dir, runtime, workers } = await makeRuntime(t, { workers: new GovernanceWorkers(),
    config: { tickMs: 1000, maxEvents: 200, checkTimeoutMs: undefined, ...options.config } })
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Govern', objective: 'Fix governance', workspace: dir, scope: ['src/'], acceptance: ['works'], budget: { ...budget, ...options.budget } }, { grantRoot: dir, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Core', objective: 'Fix governance' })
  const addMember = (input, admittedId) => runtime.addMember(owner, mission.id, { maxOutputTokens: 1000, ...input }, admittedId)
  const propose = (actor, extra = {}, admittedId) => runtime.propose(actor, mission.id, {
    outputs: [], workstreamId: stream.id, title: 'Fix', objective: 'Fix governance', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra }, admittedId)
  const events = type => runtime.snapshot(owner, mission.id).events.filter(event => event.type === type)
  const ownerNotices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner').map(delivery => delivery.content)
  return { dir, runtime, workers, mission, stream, owner, addMember, propose, events, ownerNotices }
}

test('W8: an effort the route does not accept is refused at admission, before any effect, naming the efforts it accepts', async t => {
  const f = await setup(t)
  const members = () => f.runtime.snapshot(f.owner, f.mission.id).members
  await assert.rejects(f.addMember({ name: 'Builder', role: 'implementation', provider: 'deepseek-official', model: 'flash', reasoningEffort: 'low' }), error => {
    assert.equal(error.name, 'AdmissionError')
    assert.equal(error.code, 'member_reasoning_effort_unsupported')
    assert.equal(error.category, 'validation_error')
    assert.equal(error.message, '[member_reasoning_effort_unsupported] member.reasoningEffort: provider "deepseek-official" model "flash" does not accept reasoning effort "low"; it accepts "off", "high". Set `reasoningEffort` to one it accepts, or omit it and name the member\'s own `provider` and `model` to run that route\'s default, and add the member again.')
    assert.deepEqual(error.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.location]), [['member_reasoning_effort_unsupported', 'member.reasoningEffort']])
    return true
  })
  assert.deepEqual(members(), [], 'no member row is written')
  assert.deepEqual(f.events('member/added'), [])
  assert.deepEqual(f.workers.started, [], 'no worker is started')
  assert.deepEqual(f.workers.routeQuestions, [{ ownerSessionId: f.owner.sessionId, members: [{ provider: 'deepseek-official', model: 'flash', reasoningEffort: 'low' }] }], 'the adapter is asked about the route fields alone')
  // A member that inherits the owner's route is admitted on that route's efforts too.
  await assert.rejects(f.addMember({ role: 'research', reasoningEffort: 'medium' }), /provider "owner" model "default" does not accept reasoning effort "medium"; it accepts "off", "high"/)
  // A route the host does not resolve is refused the same way, naming only the route.
  f.workers.unrouted.add('gateway/missing')
  await assert.rejects(f.addMember({ name: 'Scout', role: 'research', provider: 'gateway', model: 'missing' }), error => {
    assert.equal(error.code, 'member_route_unavailable')
    assert.equal(error.message, '[member_route_unavailable] member: provider "gateway" model "missing" does not resolve on this host. Choose a `provider` and `model` it routes, or omit both to run the owner conversation\'s route, and add the member again.')
    return true
  })
  assert.deepEqual(members(), [])
  // The repaired admission runs on the effort the owner chose: nothing is downgraded.
  const member = await f.addMember({ name: 'Builder', role: 'implementation', provider: 'deepseek-official', model: 'flash', reasoningEffort: 'high' })
  assert.equal(member.reasoningEffort, 'high')
  assert.deepEqual(f.workers.started, [member.id])
})

test('W8: a launch names every member whose route refuses it, in one refusal before any effect, on every launch path', async t => {
  const f = await setup(t)
  const plan = efforts => ({
    title: 'Launch', objective: 'Fix governance', workspace: f.dir, scope: ['src/'], acceptance: ['works'], budget,
    members: [
      { key: 'fixer', role: 'implementation', provider: 'deepseek-official', model: 'flash', reasoningEffort: efforts[0], maxOutputTokens: 1000 },
      { key: 'checker', role: 'verification', reasoningEffort: efforts[1], maxOutputTokens: 1000 },
    ],
    workstreams: [{ key: 'w', title: 'Main', objective: 'Fix governance' }],
    tasks: [{ key: 't', workstreamKey: 'w', title: 'Fix', objective: 'Fix governance', kind: 'implementation', scope: ['src/'], outputs: [], covers: ['c1'], checks: ['test'], assigneeKey: 'fixer', maxRecoveryAttempts: 1, checkTimeoutMs: 60000 }],
  })
  const draft = f.runtime.createDraft(f.owner, plan(['low', 'medium']), { grantRoot: f.dir, source: 'session' })
  const missions = () => f.runtime.list(f.owner.sessionId).length
  const before = missions()
  await assert.rejects(f.runtime.launchDraft(f.owner, draft.id, draft.revision), error => {
    assert.equal(error.code, 'member_reasoning_effort_unsupported')
    assert.deepEqual(error.diagnostics.map(diagnostic => diagnostic.location), ['members[fixer].reasoningEffort', 'members[checker].reasoningEffort'])
    assert.deepEqual(error.message.split('\n').map(line => line.slice(0, line.indexOf(':'))), ['[member_reasoning_effort_unsupported] members[fixer].reasoningEffort', '[member_reasoning_effort_unsupported] members[checker].reasoningEffort'])
    assert.match(error.message, /members\[checker\]\.reasoningEffort: provider "owner" model "default" does not accept reasoning effort "medium"; it accepts "off", "high"\./)
    assert.match(error.message, /and relaunch the complete plan\.$/)
    return true
  })
  assert.equal(missions(), before, 'no mission is created')
  assert.deepEqual(f.workers.started, [], 'no worker is started')
  // The automatic path (swarm_launch) refuses the same plan at the same boundary.
  f.runtime.store.transaction(() => f.runtime.store.put('starts', { id: 'start_w8', ownerSessionId: f.owner.sessionId, commandId: 'start_w8', goal: 'Fix governance',
    workspace: f.dir, workspaceGrantRoot: f.dir, workspaceAuthorizationSource: 'session', status: 'planning', createdAt: Date.now(), updatedAt: Date.now() }))
  await assert.rejects(f.runtime.startPlan(f.owner, 'start_w8', plan(['low', 'high'])), error => {
    assert.deepEqual(error.diagnostics.map(diagnostic => diagnostic.location), ['members[fixer].reasoningEffort'])
    return true
  })
  assert.equal(missions(), before)
  assert.deepEqual(f.workers.started, [])
  // One retry with the repaired efforts launches, on exactly those efforts.
  const snapshot = await f.runtime.startPlan(f.owner, 'start_w8', plan(['off', 'high']))
  assert.equal(snapshot.mission.status, 'active')
  assert.deepEqual(snapshot.members.map(member => member.reasoningEffort), ['off', 'high'])
})

test('a mission duration beyond the clock range is one validation_error at create and at budget update', async t => {
  const f = await setup(t)
  const duration = error => {
    assert.equal(error.code, 'mission_duration_invalid')
    assert.equal(error.category, 'validation_error')
    assert.equal(error.message, 'Mission duration exceeds the supported clock range')
    return true
  }
  assert.throws(() => f.runtime.create(f.owner, { title: 'Long', objective: 'Too long', workspace: '/source', scope: ['src/'], acceptance: ['works'],
    budget: { ...budget, maxDurationMs: Number.MAX_SAFE_INTEGER } }, { grantRoot: '/source', source: 'session' }), duration)
  assert.throws(() => f.runtime.updateBudget(f.owner, f.mission.id, { ...budget, maxDurationMs: Number.MAX_SAFE_INTEGER }), duration)
})

test('D9: the owner withdraws a submitted task, records the previous status and retires its review', async t => {
  const f = await setup(t)
  const builder = await f.addMember({ name: 'Builder', role: 'implementation' })
  const reviewer = await f.addMember({ name: 'Reviewer', role: 'verification' })
  const task = f.propose({ sessionId: builder.sessionId })
  const claimed = await f.runtime.claim({ sessionId: builder.sessionId }, f.mission.id, task.id)
  await f.runtime.submit({ sessionId: builder.sessionId }, f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'done' })
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(item => item.id === task.id).status, 'submitted')
  const review = f.propose({ sessionId: reviewer.sessionId }, { kind: 'verification', title: 'Review', objective: 'Review the fix', acceptance: ['reviewed'], checks: [], reviewOf: task.id })
  const cancelled = f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'wrong direction' })
  assert.equal(cancelled.status, 'cancelled')
  const withdrawn = f.events('task/cancelled').filter(event => event.data.taskId === task.id)
  assert.equal(withdrawn.length, 1)
  assert.equal(withdrawn[0].data.previousStatus, 'submitted')
  assert.equal(withdrawn[0].data.reason, 'wrong direction')
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(item => item.id === review.id).status, 'cancelled', 'a review of withdrawn work is retired')
})

test('F6: cancelling during artifact capture tells the worker the task is terminal, not to resubmit', async t => {
  const f = await setup(t)
  const builder = await f.addMember({ name: 'Builder', role: 'implementation' })
  const task = f.propose({ sessionId: builder.sessionId })
  const claimed = await f.runtime.claim({ sessionId: builder.sessionId }, f.mission.id, task.id)
  let release
  f.workers.captureGate = new Promise(resolve => { release = resolve })
  const submitting = f.runtime.submit({ sessionId: builder.sessionId }, f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'done' })
  await eventually(() => f.workers.captureStarted, 'artifact capture did not start', 2500)
  f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'captured by mistake' })
  release()
  await assert.rejects(submitting, /cancelled this task while the artifact was captured\. It is terminal: stop working on it and do not resubmit/)
})

test('F7: propose(admittedId) refuses to re-admit a cancelled record', async t => {
  const f = await setup(t)
  const builder = await f.addMember({ name: 'Builder', role: 'implementation' })
  const actor = { sessionId: builder.sessionId }
  const admittedId = 'task_deterministic'
  const task = f.propose(actor, {}, admittedId)
  assert.equal(task.id, admittedId)
  assert.equal(f.propose(actor, {}, admittedId).id, admittedId, 'a live record is replayed idempotently')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: admittedId, reason: 'withdrawn' })
  assert.throws(() => f.propose(actor, {}, admittedId), error => {
    assert.match(error.message, /^Task task_deterministic was cancelled by the owner; a cancelled record cannot be re-admitted\./)
    return true
  })
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).tasks.find(item => item.id === admittedId).status, 'cancelled')
})

test('F11/R06: warning suggestions increase the limit and restore planning headroom', async t => {
  const f = await setup(t, { budget: { maxTokens: 1000 } })
  const builder = await f.addMember({ name: 'Builder', role: 'implementation' })
  await f.workers.callbacks.usageSnapshot(builder.id, 700)
  const warnings = () => f.events('mission/budget-warning')
  assert.equal(warnings().length, 1)
  assert.equal(warnings()[0].data.threshold, 0.7)
  assert.equal(warnings()[0].data.suggestedLimit, 1001, 'a suggested adjustment must increase the current ceiling')
  await f.workers.callbacks.usageSnapshot(builder.id, 700)
  assert.equal(warnings().length, 1, 'the threshold warns once')
  await f.workers.callbacks.usageSnapshot(builder.id, 950)
  const last = warnings().at(-1)
  assert.equal(last.data.threshold, 0.9)
  assert.equal(last.data.suggestedLimit, 1358, 'a recommendation restores headroom below the first review threshold')
})
