/**
 * T2 governance regressions: W8 member route admission and step refusal, the owner's authority
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
 * reasoning), `unrouted` the routes the host does not resolve, `refused` the
 * routes whose provider refuses the model, with the host's code (checked before
 * the effort, as the host prepares a call). A member with no route of its own
 * runs the owner's, `owner/default` here.
 */
class GovernanceWorkers extends FakeWorkers {
  efforts = new Map([['deepseek-official/flash', ['off', 'high']], ['owner/default', ['off', 'high']]])
  unrouted = new Set()
  refused = new Map()
  routeQuestions = []
  captureStarted = false
  artifact = { commit: 'abc123', baseCommit: 'base', workspace: '/isolated', changedPaths: ['src/a.ts'] }
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  memberRoutes(ownerSessionId, members) {
    this.routeQuestions.push({ ownerSessionId, members: structuredClone(members) })
    return members.map(member => {
      const provider = member.provider ?? 'owner', model = member.model ?? 'default'
      if (this.unrouted.has(`${provider}/${model}`)) return { verdict: 'unavailable', provider, model }
      const code = this.refused.get(`${provider}/${model}`)
      if (code !== undefined) return { verdict: 'model-refused', provider, model, code }
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

test('W8: a model its provider refuses on this Harness release is refused at admission on the same rule, naming the member\'s model field', async t => {
  const f = await setup(t)
  const members = () => f.runtime.snapshot(f.owner, f.mission.id).members
  f.workers.refused.set('deepseek-account/deepseek-next', 'CLIENT_UPGRADE_REQUIRED')
  await assert.rejects(f.addMember({ name: 'Builder', role: 'implementation', provider: 'deepseek-account', model: 'deepseek-next', reasoningEffort: 'high' }), error => {
    assert.equal(error.name, 'AdmissionError')
    assert.equal(error.code, 'member_model_unsupported')
    assert.equal(error.category, 'validation_error')
    assert.equal(error.message, '[member_model_unsupported] member.model: provider "deepseek-account" model "deepseek-next" is refused by its provider on this Harness release (CLIENT_UPGRADE_REQUIRED). Choose a `provider` and `model` this release runs, or omit both to run the owner conversation\'s route, and add the member again.')
    assert.deepEqual(error.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.location]), [['member_model_unsupported', 'member.model']])
    return true
  })
  // An inherited model the provider refuses names the owner conversation, and offers no way back to it.
  f.workers.refused.set('owner/default', 'MODEL_UNSUPPORTED')
  await assert.rejects(f.addMember({ name: 'Scout', role: 'research' }), error => {
    assert.equal(error.message, '[member_model_unsupported] member.model: provider "owner" model "default", inherited from the owner conversation, is refused by its provider on this Harness release (MODEL_UNSUPPORTED). Choose a `provider` and `model` this release runs, and add the member again.')
    return true
  })
  assert.deepEqual(members(), [], 'no member row is written')
  assert.deepEqual(f.workers.started, [], 'no worker is started')
  // A plan whose members are refused for different reasons is one refusal naming each at its own field.
  const draft = f.runtime.createDraft(f.owner, {
    title: 'Launch', objective: 'Fix governance', workspace: f.dir, scope: ['src/'], acceptance: ['works'], budget,
    members: [
      { key: 'fixer', role: 'implementation', provider: 'deepseek-account', model: 'deepseek-next', maxOutputTokens: 1000 },
      { key: 'checker', role: 'verification', provider: 'deepseek-official', model: 'flash', reasoningEffort: 'low', maxOutputTokens: 1000 },
    ],
    workstreams: [{ key: 'w', title: 'Main', objective: 'Fix governance' }],
    tasks: [{ key: 't', workstreamKey: 'w', title: 'Fix', objective: 'Fix governance', kind: 'implementation', scope: ['src/'], outputs: [], covers: ['c1'], checks: ['test'], assigneeKey: 'fixer', maxRecoveryAttempts: 1, checkTimeoutMs: 60000 }],
  }, { grantRoot: f.dir, source: 'session' })
  const before = f.runtime.list(f.owner.sessionId).length
  await assert.rejects(f.runtime.launchDraft(f.owner, draft.id, draft.revision), error => {
    assert.equal(error.code, 'plan_invalid')
    assert.deepEqual(error.diagnostics.map(diagnostic => [diagnostic.code, diagnostic.location]), [['member_model_unsupported', 'members[fixer].model'], ['member_reasoning_effort_unsupported', 'members[checker].reasoningEffort']])
    assert.match(error.message, /^\[member_model_unsupported\] members\[fixer\]\.model: provider "deepseek-account" model "deepseek-next" is refused by its provider on this Harness release \(CLIENT_UPGRADE_REQUIRED\)\./)
    return true
  })
  assert.equal(f.runtime.list(f.owner.sessionId).length, before, 'no mission is created')
  assert.deepEqual(f.workers.started, [])
})

test('W8 at a step: a refusal by the member\'s own route retires it once, releases its work and tells the owner the exits', async t => {
  const f = await setup(t)
  const ada = await f.addMember({ name: 'Ada', role: 'implementation', provider: 'deepseek-official', model: 'flash', reasoningEffort: 'high' })
  const alan = await f.addMember({ name: 'Alan', role: 'implementation' })
  const grace = await f.addMember({ name: 'Grace', role: 'implementation' })
  const running = f.propose(f.owner, { title: 'Running', assigneeId: ada.id })
  const claimed = await f.runtime.claim({ sessionId: ada.sessionId }, f.mission.id, running.id)
  // Assigned to Ada and not started: unpinned, so it is released with no handle to wait for.
  const queued = f.propose(f.owner, { title: 'Queued', assigneeId: ada.id })
  const pinned = f.propose(f.owner, { title: 'Pinned', assigneeId: ada.id, assignmentMode: 'pinned' })
  // The route changed after admission: the host now refuses Ada's effort at her next step.
  const refusal = { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'provider "deepseek-official" model "flash" does not support reasoning effort "high"' }
  f.workers.callbacks.routeRefused(ada.id, refusal)
  const member = id => f.runtime.snapshot(f.owner, f.mission.id).members.find(item => item.id === id)
  const task = id => f.runtime.snapshot(f.owner, f.mission.id).tasks.find(item => item.id === id)
  assert.equal(member(ada.id).status, 'stopped', 'the member is retired at the first refusal')
  assert.deepEqual(f.events('member/route-refused').map(event => event.data), [{ memberId: ada.id, code: refusal.code, error: refusal.message }])
  assert.equal(task(running.id).attempt, undefined, 'the attempt it held is fenced')
  assert.equal(task(queued.id).status, 'pending')
  assert.equal(task(queued.id).assigneeId, undefined, 'queued unpinned work no longer names the retired member')
  // Once the handle has stopped, the unpinned work is pending for any capable live member, its allowance intact.
  const released = await eventually(() => { const current = task(running.id); return current.status === 'pending' ? current : undefined }, 'the fenced task is re-pended')
  assert.equal(released.assigneeId, undefined)
  assert.equal(released.recoveryCount ?? 0, 0, 'no recovery credit is spent on the route')
  assert.ok(f.workers.stopped.includes(ada.id), 'the handle is stopped')
  assert.equal(task(pinned.id).assigneeId, ada.id, 'pinned work waits for the owner')
  const notices = f.ownerNotices().filter(content => content.startsWith('[member_route_refused]'))
  assert.equal(notices.length, 1)
  assert.match(notices[0], new RegExp(`^\\[member_route_refused\\] Ada \\(${ada.id}\\) was stopped: its route \\(provider "deepseek-official" model "flash" reasoning effort "high"\\) refused a model step with UNSUPPORTED_REASONING_EFFORT`))
  assert.ok(notices[0].includes(`Its unpinned work returns to the board for a capable live member: ${running.id} (Running), ${queued.id} (Queued).`))
  assert.ok(notices[0].includes(`Its pinned work waits for a new assignee: ${pinned.id} (Pinned)`))
  assert.match(notices[0], /Admit a replacement with `swarm_add_member`/)
  assert.doesNotMatch(notices[0], /does not support/, 'the host\'s text stays in the durable event')
  // A later refusal of the retired member is not reported again, and the old attempt is gone.
  f.workers.callbacks.routeRefused(ada.id, refusal)
  assert.equal(f.events('member/route-refused').length, 1)
  await assert.rejects(f.runtime.submit({ sessionId: ada.sessionId }, f.mission.id, { taskId: running.id, attemptId: claimed.attempt.id, output: 'late' }))
  // The released work runs on other members.
  const next = await f.runtime.claim({ sessionId: alan.sessionId }, f.mission.id, running.id)
  assert.equal(next.attempt.ownerId, alan.id)
  const taken = await f.runtime.claim({ sessionId: grace.sessionId }, f.mission.id, queued.id)
  assert.equal(taken.attempt.ownerId, grace.id)
})

test('W8 at a step: a member refused while it holds no attempt is retired by stopping its handle, and the work it ran before returns to the board', async t => {
  const f = await setup(t)
  const ada = await f.addMember({ name: 'Ada', role: 'implementation', provider: 'deepseek-official', model: 'flash', reasoningEffort: 'high' })
  const alan = await f.addMember({ name: 'Alan', role: 'implementation' })
  const task = id => f.runtime.snapshot(f.owner, f.mission.id).tasks.find(item => item.id === id)
  // Ada ran this work, then her worker failed to start once: the work waits for
  // her next start, and no other member may borrow it, since it ran before.
  const ran = f.propose(f.owner, { title: 'Ran before', assigneeId: ada.id })
  await f.runtime.claim({ sessionId: ada.sessionId }, f.mission.id, ran.id)
  f.runtime.onStartFailure(f.runtime.mission(f.mission.id), f.runtime.store.get('members', ada.id), new Error('worker could not start'))
  assert.equal(task(ran.id).status, 'pending')
  assert.equal(task(ran.id).assigneeId, ada.id)
  assert.equal(task(ran.id).attempt, undefined, 'Ada holds no attempt')
  assert.deepEqual(f.runtime.store.get('tasks', ran.id).priorOwnerIds, [ada.id])
  // Her next start reaches a model step that her route now refuses. No attempt
  // is fenced, so no stop on its way back to the board stops her handle: the
  // retirement does.
  const refusal = { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'provider "deepseek-official" model "flash" does not support reasoning effort "high"' }
  assert.equal(f.workers.stopped.includes(ada.id), false)
  f.workers.callbacks.routeRefused(ada.id, refusal)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).members.find(item => item.id === ada.id).status, 'stopped')
  assert.equal(task(ran.id).status, 'pending')
  assert.equal(task(ran.id).assigneeId, undefined, 'the work no longer names the retired member')
  f.workers.callbacks.routeRefused(ada.id, refusal)
  await f.runtime.settle(f.mission.id)
  assert.deepEqual(f.workers.stopped.filter(id => id === ada.id), [ada.id], 'the handle is stopped once')
  assert.deepEqual(f.events('member/route-refused').map(event => event.data), [{ memberId: ada.id, code: refusal.code, error: refusal.message }])
  const notices = f.ownerNotices().filter(content => content.startsWith('[member_route_refused]'))
  assert.equal(notices.length, 1)
  assert.ok(notices[0].includes(`Its unpinned work returns to the board for a capable live member: ${ran.id} (Ran before).`))
  assert.doesNotMatch(notices[0], /Its pinned work/)
  // The work that ran before runs on a live member.
  const next = await f.runtime.claim({ sessionId: alan.sessionId }, f.mission.id, ran.id)
  assert.equal(next.attempt.ownerId, alan.id)
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
