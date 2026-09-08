/** Automatic admission uses the real durable runtime; only external workers are controlled. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 12, maxExperiments: 2 }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function eventually(read) {
  const until = Date.now() + 2500
  while (Date.now() < until) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('Expected automatic runtime transition did not occur')
}
class Workers {
  prepared = []; starts = []; stopped = []; delivered = []
  checks = [{ command: 'node check.cjs', exitCode: 0, output: 'ok' }]
  onStart = async () => {}
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, id) { this.prepared.push(id); return join(mission.workspace, id) }
  async start(spec) { this.starts.push(spec); await this.onStart(spec) }
  async stop(id) { if (this.stopGate) await this.stopGate; this.stopped.push(id) }
  async prepareTask() {}
  async deliver(member, delivery) { this.delivered.push({ member, delivery }) }
  isIdle() { return false }
  async captureArtifact(member) { return { commit: 'verified-commit', baseCommit: 'base', workspace: member.workspace, changedPaths: ['src/value.cjs'] } }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}
function plan(workspace) {
  return { title: 'Automatic delivery', objective: 'Deliver verified code', workspace, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation', maxOutputTokens: 4096 }, { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks: [
      { key: 'deliver', workstreamKey: 'main', title: 'Deliver', objective: 'Implement final change', kind: 'integration', scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'], maxRecoveryAttempts: 5, checkTimeoutMs: 45000 },
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify immutable artifact', kind: 'verification', scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'deliver', maxRecoveryAttempts: 5 },
    ] }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-automatic-'))
  const config = { statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 3 }
  const workers = new Workers(), runtime = new SwarmRuntime(config, workers)
  const owner = { sessionId: 'automatic-owner' }
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const requestInput = { commandId: 'command-1', goal: 'Make the requested change and verify it.', workspace: directory }
  return { directory, config, workers, runtime, owner, requestInput, input: plan(directory) }
}
async function launch(f, input = f.input) {
  const request = f.runtime.requestStart(f.owner, f.requestInput)
  const snapshot = await f.runtime.startPlan(f.owner, request.id, input)
  return { request, snapshot }
}
async function accept(f, snapshot, { evidence = false } = {}) {
  const missionId = snapshot.mission.id
  const builder = snapshot.members.find(member => member.name === 'Builder')
  const reviewer = snapshot.members.find(member => member.name === 'Reviewer')
  const source = snapshot.tasks.find(task => task.kind !== 'verification')
  const review = snapshot.tasks.find(task => task.kind === 'verification')
  const actor = { sessionId: builder.sessionId }, verifier = { sessionId: reviewer.sessionId }
  const task = await f.runtime.claim(actor, missionId, source.id)
  let finding
  if (evidence) {
    await f.workers.callbacks.toolRun(builder.id, { tool: 'bash', arguments: { command: 'node check.cjs' }, result: { exitCode: 0 }, isError: false })
    const run = f.runtime.observe(actor, missionId).toolRuns[0]
    finding = f.runtime.publish(actor, missionId, { taskId: task.id, attemptId: task.attempt.id, claim: 'Checks passed', outcome: 'supported', toolRunIds: [run.id] })
  }
  await f.runtime.submit(actor, missionId, { taskId: task.id, attemptId: task.attempt.id, output: 'Immutable candidate' })
  const assigned = await f.runtime.claim(verifier, missionId, review.id)
  await f.runtime.verify(verifier, missionId, { taskId: assigned.id, attemptId: assigned.attempt.id, verdict: 'accept', reason: 'Checked the exact submitted commit' })
  return { actor, verifier, builder, reviewer, finding }
}

test('automatic request admission is durable, owner-scoped, bounded and command-idempotent', async t => {
  const f = await fixture(t)
  const request = f.runtime.requestStart(f.owner, f.requestInput)
  assert.equal(request.status, 'planning')
  assert.equal(request.budget, undefined, 'resource decisions belong to the planning primary agent')
  assert.equal(f.workers.starts.length, 0)
  assert.equal(f.runtime.drafts(f.owner).length, 0)
  const replay = f.runtime.requestStart(f.owner, { ...f.requestInput, budget: { ...budget, maxTokens: 999999 } })
  assert.equal(replay.id, request.id)
  assert.equal(replay.budget, undefined, 'replaying command admission cannot install a fixed allowance')
  assert.deepEqual(f.runtime.starts({ sessionId: 'stranger' }), [])
  assert.throws(() => f.runtime.requestStart(f.owner, { ...f.requestInput, goal: 'different' }), /identity conflicts/)
  assert.throws(() => f.runtime.requestStart(f.owner, { ...f.requestInput, commandId: 'command-2' }), /in progress/)
  assert.throws(() => f.runtime.requestStart({ sessionId: 'other' }, { ...f.requestInput, goal: 'x'.repeat(10001) }), /exceeds/)
  assert.throws(() => f.runtime.requestStart({ sessionId: 'other' }, { ...f.requestInput, budget: { ...budget, maxWorkers: undefined } }), /Invalid budget/)
  const abort = new AbortController(); abort.abort(new Error('cancelled'))
  assert.throws(() => f.runtime.requestStart({ sessionId: 'other', signal: abort.signal }, f.requestInput), /cancelled/)
})

test('concurrent plan delivery launches once with the saved workspace and primary-agent budget', async t => {
  const f = await fixture(t)
  const request = f.runtime.requestStart(f.owner, f.requestInput)
  const input = { ...f.input, workspace: '/not-authorized', budget: { ...budget, maxTokens: 999999 } }
  const [first, duplicate] = await Promise.all([f.runtime.startPlan(f.owner, request.id, input), f.runtime.startPlan(f.owner, request.id, input)])
  assert.equal(first.mission.id, duplicate.mission.id)
  assert.equal(first.mission.workspace, f.directory)
  assert.deepEqual(first.mission.budget, input.budget)
  assert.deepEqual(f.runtime.starts(f.owner)[0].budget, input.budget)
  assert.equal(f.runtime.drafts(f.owner).length, 1)
  assert.equal(f.runtime.list(f.owner.sessionId).length, 1)
  assert.equal(f.workers.prepared.length, 2)
  assert.equal(f.runtime.starts(f.owner)[0].status, 'running')
  assert.equal(first.members.find(member => member.name === 'Builder').maxOutputTokens, 4096)
  assert.equal(first.members.find(member => member.name === 'Reviewer').maxOutputTokens, 2048)
  assert.throws(() => f.runtime.requestStart({ sessionId: first.members[0].sessionId }, f.requestInput), /Workers cannot/)
  await assert.rejects(f.runtime.startPlan({ sessionId: 'stranger' }, request.id, input), /not owned/)
  assert.match(f.workers.callbacks.guard(first.members[0].id, 'swarm_launch'), /bypass mission authority/)
})

test('automatic admission rejects incomplete topology before creating workers or a draft', async t => {
  for (const mutate of [
    input => { input.members.pop(); input.tasks.pop() },
    input => { input.tasks.pop() },
    input => { input.tasks[0].assigneeKey = undefined },
    input => { input.tasks[1].assigneeKey = undefined },
    // One reviewed implementation is deliverable alone; several implementation branches still need a final integration.
    input => { input.tasks[0].kind = 'implementation'; input.tasks.push({ ...input.tasks[0], key: 'second', title: 'Second' }, { ...input.tasks[1], key: 'second-review', title: 'Second review', reviewOf: 'second' }) },
    input => { input.acceptance = ['uncovered obligation'] },
    input => { delete input.tasks[0].maxRecoveryAttempts },
    input => { delete input.tasks[0].checkTimeoutMs },
    input => { delete input.members[0].maxOutputTokens },
  ]) {
    const f = await fixture(t)
    mutate(f.input)
    const request = f.runtime.requestStart(f.owner, f.requestInput)
    await assert.rejects(f.runtime.startPlan(f.owner, request.id, f.input), /Automatic/)
    assert.equal(f.workers.prepared.length, 0)
    assert.equal(f.runtime.drafts(f.owner).length, 0)
    assert.equal(f.runtime.starts(f.owner)[0].status, 'failed')
  }
})

test('automatic implementation plans require a final integration dependency and independent reviews', async t => {
  const f = await fixture(t)
  const implementation = { ...f.input.tasks[0], key: 'implement', kind: 'implementation' }
  const implementationReview = { ...f.input.tasks[1], key: 'implementation-review', reviewOf: 'implement' }
  f.input.tasks.unshift(implementation, implementationReview)
  const request = f.runtime.requestStart(f.owner, f.requestInput)
  await assert.rejects(f.runtime.startPlan(f.owner, request.id, f.input), /integration task must depend on implementation implement/)
  f.input.tasks.find(task => task.key === 'deliver').dependencies = ['implement']
  const snapshot = await f.runtime.startPlan(f.owner, request.id, f.input)
  assert.equal(snapshot.tasks.length, 4)
  assert.equal(snapshot.mission.status, 'active')
})

test('missing acceptance diagnostics identify the exact strings and a corrected plan launches', async t => {
  const f = await fixture(t)
  const exact = 'Keep the existing response shape, including empty results.'
  f.input.acceptance.push(exact)
  f.input.tasks[0].acceptance = ['works', 'Keep compatible responses']
  const request = f.runtime.requestStart(f.owner, f.requestInput)
  await assert.rejects(f.runtime.startPlan(f.owner, request.id, f.input), error => {
    assert.ok(error.message.includes(JSON.stringify([exact])))
    assert.match(error.message, /Copy each missing string into the acceptance array/)
    return true
  })
  assert.equal(f.workers.prepared.length, 0)
  f.input.tasks[0].acceptance.push(exact)
  const snapshot = await f.runtime.startPlan(f.owner, request.id, f.input)
  assert.equal(snapshot.mission.status, 'active')
})

test('failed assembly and retries retain one deterministic plan and worker roster', async t => {
  const f = await fixture(t)
  let fail = true
  f.workers.onStart = async spec => { if (spec.member.name === 'Reviewer' && fail) throw new Error('Temporary launch failure') }
  const request = f.runtime.requestStart(f.owner, f.requestInput)
  await assert.rejects(f.runtime.startPlan(f.owner, request.id, f.input), /Temporary launch failure/)
  const failed = f.runtime.starts(f.owner)[0]
  assert.equal(failed.status, 'failed')
  assert.equal(f.runtime.list(f.owner.sessionId)[0].status, 'staged')
  assert.equal(f.workers.delivered.length, 0)
  fail = false
  const snapshot = await f.runtime.startPlan(f.owner, request.id, { ...f.input, title: 'Ignore retry mutation' })
  assert.equal(snapshot.mission.title, f.input.title)
  assert.equal(f.runtime.starts(f.owner)[0].draftId, failed.draftId)
  assert.equal(f.workers.prepared.length, 2)
})

test('a reentrant failure while assembly waits fences activation and permits saved-plan retry', async t => {
  const f = await fixture(t)
  const entered = deferred(), gate = deferred()
  f.workers.onStart = async spec => { if (spec.member.name === 'Reviewer') { entered.resolve(); await gate.promise } }
  const request = f.runtime.requestStart(f.owner, f.requestInput)
  const launch = f.runtime.startPlan(f.owner, request.id, f.input)
  const failed = assert.rejects(launch, /Planning cancelled/)
  await entered.promise
  f.runtime.failStart(f.owner, request.id, 'Planning cancelled')
  gate.resolve()
  await failed
  assert.equal(f.runtime.list(f.owner.sessionId)[0].status, 'staged')
  assert.equal(f.workers.delivered.length, 0)
  f.workers.onStart = async () => {}
  await f.runtime.startPlan(f.owner, request.id, f.input)
  assert.equal(f.runtime.starts(f.owner)[0].status, 'running')
  assert.equal(f.workers.prepared.length, 2)
})

test('caller cancellation and explicit mission stop cannot revive a partially assembled request', async t => {
  const f = await fixture(t)
  const entered = deferred(), gate = deferred(), abort = new AbortController()
  f.workers.onStart = async spec => { if (spec.member.name === 'Reviewer') { entered.resolve(); await gate.promise } }
  const request = f.runtime.requestStart(f.owner, f.requestInput)
  const launch = f.runtime.startPlan({ ...f.owner, signal: abort.signal }, request.id, f.input)
  const rejected = assert.rejects(launch, /cancel assembly/)
  await entered.promise
  abort.abort(new Error('cancel assembly')); gate.resolve()
  await rejected
  const mission = f.runtime.list(f.owner.sessionId)[0]
  f.runtime.control(f.owner, mission.id, 'stop', 'User stopped this request')
  assert.equal(f.runtime.starts(f.owner)[0].status, 'stopped')
  await assert.rejects(f.runtime.startPlan(f.owner, request.id, f.input), /was stopped/)
})

test('independent host verification automatically completes the mission and journal without owner polling', async t => {
  const f = await fixture(t)
  const { request, snapshot } = await launch(f)
  await accept(f, snapshot)
  await eventually(() => f.runtime.snapshot(f.owner, snapshot.mission.id).mission.status === 'completed')
  assert.equal(f.runtime.starts(f.owner)[0].status, 'completed')
  await eventually(() => f.runtime.snapshot(f.owner, snapshot.mission.id).members.every(member => member.status === 'stopped'))
  assert.ok(f.runtime.snapshot(f.owner, snapshot.mission.id).events.some(event => event.type === 'automatic/completed'))
  const replay = await f.runtime.startPlan(f.owner, request.id, f.input)
  assert.equal(replay.mission.status, 'completed')
  assert.equal(f.workers.prepared.length, 2)
})

test('primary-agent budget adjustments preserve consumption, admitted counts and paused state', async t => {
  const f = await fixture(t)
  const { snapshot } = await launch(f)
  const builder = snapshot.members.find(member => member.name === 'Builder')
  await f.workers.callbacks.beforeStep(builder.id)
  await f.workers.callbacks.beforeStep(builder.id)
  await f.workers.callbacks.beforeStep(builder.id)
  await f.workers.callbacks.usage(builder.id, 17)
  for (const lower of [{ maxTokens: 16 }, { maxSteps: 2 }, { maxWorkers: 1 }, { maxTasks: 1 }]) {
    assert.throws(() => f.runtime.updateBudget(f.owner, snapshot.mission.id, { ...budget, ...lower }), /below existing consumption or admitted/)
  }
  assert.throws(() => f.runtime.updateBudget({ sessionId: builder.sessionId }, snapshot.mission.id, budget), /Only the primary/)
  assert.match(f.workers.callbacks.guard(builder.id, 'swarm_budget'), /bypass mission authority/)
  f.runtime.control(f.owner, snapshot.mission.id, 'pause', 'Primary agent inspecting remaining work')
  const chosen = { ...budget, maxTokens: 765432, maxSteps: 321, maxWorkers: 4, maxTasks: 19, maxDurationMs: 900000 }
  assert.deepEqual(f.runtime.updateBudget(f.owner, snapshot.mission.id, chosen, 'More integration checks are required'), chosen)
  const updated = f.runtime.snapshot(f.owner, snapshot.mission.id)
  assert.equal(updated.mission.usedTokens, 17)
  assert.equal(updated.mission.usedSteps, 3)
  assert.equal(updated.mission.status, 'paused')
  assert.equal(updated.mission.deadline, updated.mission.createdAt + chosen.maxDurationMs)
  assert.equal(updated.members.length, 2); assert.equal(updated.tasks.length, 2)
  assert.deepEqual(f.runtime.starts(f.owner)[0].budget, chosen)
  assert.equal(updated.events.findLast(event => event.type === 'mission/budget-updated').data.reason, 'More integration checks are required')
  f.runtime.control(f.owner, snapshot.mission.id, 'resume', 'Continue with the chosen allowance')
  assert.equal(f.runtime.snapshot(f.owner, snapshot.mission.id).mission.status, 'active')
})

test('a budget-blocked mission needs explicit resume after adjustment and keeps recorded usage', async t => {
  const f = await fixture(t)
  const { snapshot } = await launch(f)
  const builder = snapshot.members.find(member => member.name === 'Builder')
  await f.workers.callbacks.usage(builder.id, budget.maxTokens + 123)
  const chosen = { ...budget, maxTokens: budget.maxTokens * 2, maxDurationMs: 900000 }
  f.runtime.updateBudget(f.owner, snapshot.mission.id, chosen)
  let current = f.runtime.snapshot(f.owner, snapshot.mission.id).mission
  assert.equal(current.status, 'blocked'); assert.equal(current.usedTokens, budget.maxTokens + 123)
  f.runtime.control(f.owner, snapshot.mission.id, 'resume', 'Continue the remaining work')
  current = f.runtime.snapshot(f.owner, snapshot.mission.id).mission
  assert.equal(current.status, 'active'); assert.equal(current.usedTokens, budget.maxTokens + 123)
})

test('budget resume waits for quiescence then promptly wakes the same long-lived attempt with valid provenance', async t => {
  for (const reentrant of [false, true]) {
    const f = await fixture(t)
    f.config.leaseMs = 600000
    const { snapshot } = await launch(f)
    const builder = snapshot.members.find(member => member.name === 'Builder')
    const actor = { sessionId: builder.sessionId }
    const source = snapshot.tasks.find(task => task.kind === 'integration')
    const claimed = await f.runtime.claim(actor, snapshot.mission.id, source.id)
    await eventually(() => f.workers.delivered.some(({ delivery }) => delivery.taskId === source.id))
    await f.workers.callbacks.toolRun(builder.id, { tool: 'bash', arguments: { command: 'inspect working tree' }, result: 'existing evidence', isError: false })
    const run = f.runtime.observe(actor, snapshot.mission.id).toolRuns[0]
    const gate = deferred(), entered = deferred()
    let stopping = 0
    f.workers.stop = async memberId => { if (++stopping === snapshot.members.length) entered.resolve(); await gate.promise; f.workers.stopped.push(memberId) }
    const oldAssignments = new Set(f.workers.delivered.filter(({ delivery }) => delivery.kind === 'assignment').map(({ delivery }) => delivery.id))
    const resume = () => {
      f.runtime.updateBudget(f.owner, snapshot.mission.id, { ...budget, maxTokens: budget.maxTokens * 2 })
      f.runtime.control(f.owner, snapshot.mission.id, 'resume', 'Continue under the primary agent adjustment')
    }
    let adjusted = false
    const unsubscribe = f.runtime.subscribe(missionId => {
      if (!reentrant || adjusted || missionId !== snapshot.mission.id || f.runtime.snapshot(f.owner, missionId).mission.status !== 'blocked') return
      adjusted = true; resume()
    })
    await f.workers.callbacks.usage(builder.id, budget.maxTokens + 1)
    if (!reentrant) resume()
    await entered.promise
    const startsBeforeQuiescence = f.workers.starts.length
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.workers.starts.length, startsBeforeQuiescence, 'resume cannot restart any worker before its prior activity stops')
    assert.match(f.workers.callbacks.guard(builder.id, 'bash'), /quiescence/)
    assert.throws(() => f.runtime.publish(actor, snapshot.mission.id, { taskId: claimed.id, attemptId: claimed.attempt.id, claim: 'too early', outcome: 'supported', toolRunIds: [run.id] }), /quiescence/)
    assert.equal(await f.workers.callbacks.beforeStep(builder.id, true), false)
    gate.resolve()
    const resumed = await eventually(() => f.workers.delivered.find(({ delivery }) => delivery.kind === 'assignment' && delivery.taskId === source.id && !oldAssignments.has(delivery.id)))
    assert.equal(resumed.delivery.attemptId, claimed.attempt.id)
    assert.match(JSON.parse(resumed.delivery.content).instructions, /same task and attempt/)
    const current = f.runtime.snapshot(f.owner, snapshot.mission.id).tasks.find(task => task.id === source.id)
    assert.equal(current.epoch, claimed.epoch)
    assert.equal(current.attempt.id, claimed.attempt.id)
    assert.ok(current.attempt.leaseUntil > Date.now() + 500000, 'wake is immediate; it does not wait for the ten-minute lease to expire')
    assert.equal(current.budgetResume, undefined)
    assert.equal(f.runtime.snapshot(f.owner, snapshot.mission.id).members.find(member => member.id === builder.id).status, 'working')
    const published = f.runtime.publish(actor, snapshot.mission.id, { taskId: claimed.id, attemptId: claimed.attempt.id, claim: 'Earlier host evidence is still from this attempt', outcome: 'supported', toolRunIds: [run.id] })
    assert.deepEqual(published.toolRunIds, [run.id])
    assert.equal(f.workers.prepared.length, 2)
    unsubscribe()
  }
})

test('an explicit stop during budget quiescence prevents a queued resume assignment', async t => {
  const f = await fixture(t)
  const { snapshot } = await launch(f)
  const builder = snapshot.members.find(member => member.name === 'Builder')
  const source = snapshot.tasks.find(task => task.kind === 'integration')
  await f.runtime.claim({ sessionId: builder.sessionId }, snapshot.mission.id, source.id)
  await eventually(() => f.workers.delivered.some(({ delivery }) => delivery.taskId === source.id))
  const assignments = f.workers.delivered.filter(({ delivery }) => delivery.kind === 'assignment').length
  const gate = deferred(); f.workers.stopGate = gate.promise
  await f.workers.callbacks.usage(builder.id, budget.maxTokens + 1)
  f.runtime.updateBudget(f.owner, snapshot.mission.id, { ...budget, maxTokens: budget.maxTokens * 2 })
  f.runtime.control(f.owner, snapshot.mission.id, 'resume', 'Resume requested')
  f.runtime.control(f.owner, snapshot.mission.id, 'stop', 'User stopped before quiescence')
  gate.resolve()
  await eventually(() => f.runtime.snapshot(f.owner, snapshot.mission.id).members.every(member => member.status === 'stopped'))
  assert.equal(f.runtime.snapshot(f.owner, snapshot.mission.id).mission.status, 'stopped')
  assert.equal(f.workers.delivered.filter(({ delivery }) => delivery.kind === 'assignment').length, assignments)
})

test('a restarted budget pause promptly assigns a recovered epoch instead of waiting for the old lease', async t => {
  const f = await fixture(t)
  f.config.leaseMs = 600000
  const { snapshot } = await launch(f)
  const builder = snapshot.members.find(member => member.name === 'Builder')
  const source = snapshot.tasks.find(task => task.kind === 'integration')
  const claimed = await f.runtime.claim({ sessionId: builder.sessionId }, snapshot.mission.id, source.id)
  await f.workers.callbacks.usage(builder.id, budget.maxTokens + 1)
  await eventually(() => f.runtime.snapshot(f.owner, snapshot.mission.id).mission.budgetPause?.quiesced)
  await f.runtime.dispose()
  const workers = new Workers(), recovered = new SwarmRuntime(f.config, workers)
  try {
    await recovered.start()
    const task = recovered.snapshot(f.owner, snapshot.mission.id).tasks.find(task => task.id === source.id)
    assert.equal(task.status, 'pending')
    assert.equal(task.attempt, undefined, 'a host restart retains the existing epoch-fencing policy')
    assert.equal(task.budgetResume, undefined)
    recovered.updateBudget(f.owner, snapshot.mission.id, { ...budget, maxTokens: budget.maxTokens * 2 })
    workers.isIdle = () => true
    recovered.control(f.owner, snapshot.mission.id, 'resume', 'Continue after host restart')
    const delivered = await eventually(() => workers.delivered.find(({ delivery }) => delivery.kind === 'assignment' && delivery.taskId === source.id))
    assert.notEqual(delivered.delivery.attemptId, claimed.attempt.id)
    assert.equal(recovered.snapshot(f.owner, snapshot.mission.id).mission.budgetPause, undefined)
  } finally { await recovered.dispose() }
})

test('terminal worker status waits for actual quiescence and late idle events cannot revive it', async t => {
  const f = await fixture(t)
  const { snapshot } = await launch(f)
  const gate = deferred(); f.workers.stopGate = gate.promise
  f.runtime.control(f.owner, snapshot.mission.id, 'stop', 'User stopped')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(f.runtime.snapshot(f.owner, snapshot.mission.id).members.every(member => member.status !== 'stopped'))
  gate.resolve()
  await eventually(() => f.runtime.snapshot(f.owner, snapshot.mission.id).members.every(member => member.status === 'stopped'))
  for (const member of snapshot.members) f.workers.callbacks.idle(member.id)
  assert.ok(f.runtime.snapshot(f.owner, snapshot.mission.id).members.every(member => member.status === 'stopped'))
})

test('primary-agent recovery limits replace the legacy host retry cap on restart', async t => {
  for (const limit of [1, 5]) {
    const f = await fixture(t)
    f.input.tasks[0].maxRecoveryAttempts = limit
    const { snapshot } = await launch(f)
    const builder = snapshot.members.find(member => member.name === 'Builder')
    const task = await f.runtime.claim({ sessionId: builder.sessionId }, snapshot.mission.id, snapshot.tasks.find(task => task.kind === 'integration').id)
    task.recoveryCount = limit === 5 ? 2 : 0
    f.runtime.store.transaction(() => f.runtime.store.put('tasks', task))
    await f.runtime.dispose()
    const recovered = new SwarmRuntime(f.config, new Workers())
    try {
      await recovered.start()
      const restored = recovered.snapshot(f.owner, snapshot.mission.id).tasks.find(candidate => candidate.id === task.id)
      assert.equal(restored.maxRecoveryAttempts, limit)
      assert.equal(restored.status, limit === 1 ? 'blocked' : 'pending')
    } finally { await recovered.dispose() }
  }
})

test('verification lease covers every primary-agent-declared long-running check', async t => {
  const f = await fixture(t)
  f.input.tasks[0].checkTimeoutMs = 400000
  f.input.tasks[0].checks = ['first-check', 'second-check']
  const { snapshot } = await launch(f)
  const previous = f.workers.verifyArtifact.bind(f.workers)
  let observed = false
  f.workers.verifyArtifact = async (_member, source) => {
    observed = true
    assert.equal(source.checkTimeoutMs, 400000)
    const review = f.runtime.snapshot(f.owner, snapshot.mission.id).tasks.find(task => task.kind === 'verification')
    assert.ok(review.attempt.leaseUntil >= Date.now() + 800000, 'two checks must fit without the infrastructure lease expiring mid-verification')
    return previous()
  }
  await accept(f, snapshot)
  assert.equal(observed, true)
})

test('workers inherit primary-admitted execution policy when extending an automatic plan', async t => {
  const f = await fixture(t)
  const { snapshot } = await launch(f)
  const source = snapshot.tasks.find(task => task.kind === 'integration')
  const actor = { sessionId: snapshot.members[0].sessionId }
  const input = { workstreamId: snapshot.workstreams[0].id, title: 'Additional review', objective: 'Check the proposed result', kind: 'verification',
    scope: ['src/'], acceptance: ['works'], reviewOf: source.id, maxRecoveryAttempts: 999, checkTimeoutMs: 999999 }
  const workerTask = f.runtime.propose(actor, snapshot.mission.id, input)
  assert.equal(workerTask.maxRecoveryAttempts, source.maxRecoveryAttempts)
  assert.equal(workerTask.checkTimeoutMs, source.checkTimeoutMs)
  const { maxRecoveryAttempts, ...missingPolicy } = input
  assert.throws(() => f.runtime.propose(f.owner, snapshot.mission.id, missingPolicy), /chosen by the primary/)
  const primaryTask = f.runtime.propose(f.owner, snapshot.mission.id, { ...input, maxRecoveryAttempts: 7, checkTimeoutMs: 123456 })
  assert.equal(primaryTask.maxRecoveryAttempts, 7)
  assert.equal(primaryTask.checkTimeoutMs, 123456)
})

test('zero experiment allowance is valid and updates cannot erase admitted experiments or workstreams', async t => {
  const f = await fixture(t)
  f.input.budget = { ...budget, maxExperiments: 0 }
  const { snapshot } = await launch(f)
  assert.equal(snapshot.mission.budget.maxExperiments, 0)
  const source = snapshot.tasks.find(task => task.kind === 'integration')
  const input = { workstreamId: snapshot.workstreams[0].id, title: 'Experiment', objective: 'Try a variant', kind: 'integration', scope: ['src/'],
    acceptance: ['works'], checks: ['node check.cjs'], maxRecoveryAttempts: 2, checkTimeoutMs: 1234, experiment: true }
  assert.throws(() => f.runtime.propose(f.owner, snapshot.mission.id, input), /experiment budget exhausted/)
  f.runtime.updateBudget(f.owner, snapshot.mission.id, { ...budget, maxExperiments: 1 })
  f.runtime.propose(f.owner, snapshot.mission.id, input)
  assert.throws(() => f.runtime.updateBudget(f.owner, snapshot.mission.id, { ...budget, maxExperiments: 0 }), /below existing consumption or admitted/)
  for (let index = 0; index < 4; index++) f.runtime.workstream(f.owner, snapshot.mission.id, { title: `Stream ${index}`, objective: source.objective })
  assert.throws(() => f.runtime.updateBudget(f.owner, snapshot.mission.id, { ...budget, maxTasks: 4 }), /below existing consumption or admitted/)
  assert.throws(() => f.runtime.updateBudget(f.owner, snapshot.mission.id, { ...budget, maxDurationMs: Number.MAX_SAFE_INTEGER }), /clock range/)
})

test('manual missions retain explicit completion behavior', async t => {
  const f = await fixture(t)
  const draft = f.runtime.createDraft(f.owner, f.input)
  const snapshot = await f.runtime.launchDraft(f.owner, draft.id, draft.revision)
  await accept(f, snapshot)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(f.runtime.snapshot(f.owner, snapshot.mission.id).mission.status, 'active')
  assert.deepEqual(f.runtime.starts(f.owner), [])
  f.runtime.control(f.owner, snapshot.mission.id, 'complete', 'Explicit user completion')
})

test('paused and budget-blocked automatic missions do not silently complete', async t => {
  for (const state of ['paused', 'blocked']) {
    const f = await fixture(t)
    const { snapshot } = await launch(f)
    const { builder } = await accept(f, snapshot)
    if (state === 'paused') f.runtime.control(f.owner, snapshot.mission.id, 'pause', 'User paused before completion')
    else await f.workers.callbacks.usage(builder.id, budget.maxTokens + 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(f.runtime.snapshot(f.owner, snapshot.mission.id).mission.status, state)
    assert.equal(f.runtime.starts(f.owner)[0].status, 'running')
    if (state === 'paused') {
      f.runtime.control(f.owner, snapshot.mission.id, 'resume', 'Continue')
      await eventually(() => f.runtime.starts(f.owner)[0].status === 'completed')
    }
  }
})

test('failed checks and unresolved evidence challenges cannot produce automatic success', async t => {
  for (const mode of ['failed-check', 'challenge']) {
    const f = await fixture(t)
    const { snapshot } = await launch(f)
    if (mode === 'failed-check') f.workers.checks = [{ command: 'node check.cjs', exitCode: 1, output: 'failure' }]
    const result = await accept(f, snapshot, { evidence: mode === 'challenge' })
    if (result.finding) f.runtime.challenge(f.owner, snapshot.mission.id, { evidenceId: result.finding.id, reason: 'Unresolved contradictory result', toolRunIds: [] })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(f.runtime.snapshot(f.owner, snapshot.mission.id).mission.status, 'active')
    assert.equal(f.runtime.starts(f.owner)[0].status, 'running')
  }
})

test('restart recovers interrupted planning and assembly while retaining launched mission identity', async t => {
  const f = await fixture(t)
  const planning = f.runtime.requestStart(f.owner, f.requestInput)
  const other = { sessionId: 'other-owner' }
  const assembling = f.runtime.requestStart(other, { ...f.requestInput, commandId: 'command-2' })
  f.workers.onStart = async spec => { if (spec.member.name === 'Reviewer') throw new Error('Interrupted assembly') }
  await assert.rejects(f.runtime.startPlan(other, assembling.id, f.input), /Interrupted assembly/)
  const journal = f.runtime.starts(other)[0]
  journal.status = 'launching'
  f.runtime.store.transaction(() => f.runtime.store.put('starts', journal))
  await f.runtime.dispose()
  const workers = new Workers(), recovered = new SwarmRuntime(f.config, workers)
  try {
    await recovered.start()
    assert.equal(recovered.starts(f.owner)[0].status, 'failed')
    assert.match(recovered.starts(f.owner)[0].error, /restarted/)
    assert.equal(recovered.requestStart(f.owner, f.requestInput).id, planning.id)
    assert.equal(recovered.starts(other)[0].status, 'failed')
    assert.equal(workers.delivered.length, 0)
    const snapshot = await recovered.startPlan(other, assembling.id, f.input)
    assert.equal(snapshot.mission.id, journal.missionId)
    assert.equal(workers.prepared.length, 0)
    assert.equal(recovered.starts(other)[0].status, 'running')
  } finally { await recovered.dispose() }
})

test('restart trusts an already activated mission when the last launch acknowledgment was interrupted', async t => {
  const f = await fixture(t)
  const { request, snapshot } = await launch(f)
  const journal = f.runtime.starts(f.owner)[0]
  journal.status = 'launching'; journal.error = 'Stale interrupted acknowledgment'
  f.runtime.store.transaction(() => f.runtime.store.put('starts', journal))
  await f.runtime.dispose()
  const workers = new Workers(), recovered = new SwarmRuntime(f.config, workers)
  try {
    await recovered.start()
    const restored = recovered.starts(f.owner)[0]
    assert.equal(restored.status, 'running')
    assert.equal(restored.error, undefined)
    const replay = await recovered.startPlan(f.owner, request.id, f.input)
    assert.equal(replay.mission.id, snapshot.mission.id)
    assert.equal(workers.prepared.length, 0)
    recovered.control(f.owner, replay.mission.id, 'stop', 'Stop after recovery')
    assert.equal(recovered.starts(f.owner)[0].status, 'stopped')
  } finally { await recovered.dispose() }
})
