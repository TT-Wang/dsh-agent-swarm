/** Model-visible context stays bounded and role-appropriate; owner notices are reserved for decisions. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime, emptyUsage } from '../lib/runtime.js'
import { validatePlan } from '../lib/plans.js'

const budget = { maxTokens: 1000, maxSteps: 10, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 12, maxExperiments: 2 }
async function eventually(read, message) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}
const settle = () => new Promise(resolve => setTimeout(resolve, 60))
/** Only the external execution adapter is replaced; store, admission, scheduling and outbox are real. */
class ControlledWorkers {
  callbacks; deliveries = []; stopped = []; checks = [{ command: 'test', exitCode: 0, output: 'ok' }]; prepared = []; idle = new Set()
  bind(c) { this.callbacks = c }
  async prepareWorkspace(m, id) { return `/isolated/${id}` }
  async start() {}
  async deliver(m, d) { this.deliveries.push(d) }
  async stop(id) { this.stopped.push(id) }
  isIdle(id) { return this.idle.has(id) }
  async captureArtifact(member, task) { return { commit: `c-${task.id.slice(-8)}`, baseCommit: 'base', workspace: member.workspace, changedPaths: ['src/a.ts'] } }
  async verifyArtifact() { return this.checks }
  async prepareTask(member, task, dependencies) { this.prepared.push({ task: task.id, dependencies: dependencies.map(d => d.id) }) }
  async dispose() {}
}
async function manual(t, overrides = {}, acceptance = ['works']) {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-efficiency-'))
  const workers = new ControlledWorkers()
  const runtime = new SwarmRuntime({ statePath: join(dir, 'db.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Build', objective: 'Fix module', workspace: '/source', scope: ['src/'], acceptance, budget: { ...budget, ...overrides } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Core', objective: 'Fix module' })
  const a = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const b = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actorA = { sessionId: a.sessionId }, actorB = { sessionId: b.sessionId }
  const propose = (actor = actorA, extra = {}) => runtime.propose(actor, mission.id, { workstreamId: stream.id, title: 'Fix', objective: 'Fix module', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const controls = () => workers.deliveries.filter(d => d.kind === 'control' && d.to === 'owner')
  async function submitted(extra = {}) {
    const task = await runtime.claim(actorA, mission.id, propose(actorA, extra).id)
    await workers.callbacks.toolRun(a.id, { tool: 'bash', arguments: { command: 'test' }, result: { exitCode: 0 }, isError: false })
    const run = runtime.observe(actorA, mission.id).toolRuns.at(-1)
    runtime.publish(actorA, mission.id, { taskId: task.id, attemptId: task.attempt.id, claim: 'Checked', outcome: 'supported', toolRunIds: [run.id] })
    await runtime.submit(actorA, mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'done' })
    return current(task)
  }
  async function reviewed(task, verdict = 'accept') {
    const review = propose(actorB, { kind: 'verification', reviewOf: task.id, checks: [] })
    const claimed = await runtime.claim(actorB, mission.id, review.id)
    workers.checks = verdict === 'accept' ? [{ command: 'test', exitCode: 0, output: 'ok' }] : [{ command: 'test', exitCode: 1, output: 'failure' }]
    await runtime.verify(actorB, mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict, reason: `Independent ${verdict}` })
    return current(review)
  }
  return { runtime, workers, owner, mission, stream, a, b, actorA, actorB, propose, current, controls, submitted, reviewed }
}

test('member observation is a focused, bounded view with cursors and by-id reads instead of the whole board', async t => {
  const f = await manual(t)
  const task = await f.runtime.claim(f.actorA, f.mission.id, f.propose().id)
  const runId = await f.workers.callbacks.toolRun(f.a.id, { tool: 'bash', arguments: { command: 'x'.repeat(2000) }, result: { output: 'y'.repeat(30000) }, isError: false })
  assert.match(runId, /^run_/, 'recording resolves to the durable run id so results can carry it')
  const view = f.runtime.observe(f.actorA, f.mission.id)
  assert.equal(view.member.id, f.a.id)
  assert.equal(view.current.task.id, task.id); assert.equal(view.current.attemptId, task.attempt.id)
  assert.deepEqual(view.toolRuns.map(run => [run.id, run.seq, run.taskId, run.attemptId]), [[runId, 1, task.id, task.attempt.id]])
  assert(view.toolRuns[0].arguments.length < 300, 'arguments are excerpted'); assert.equal(view.toolRuns[0].resultPreview, undefined, 'stored payloads are not repeated')
  assert(!('snapshot' in view) && !('tasks' in view), 'the complete board is not part of the member view')
  assert.deepEqual(view.board.map(item => item.id), [task.id]); assert.equal(view.board[0].objective, undefined)
  assert.deepEqual(view.members.map(item => item.role), ['implementation', 'verification'])
  assert(JSON.stringify(view).length < 6000, `focused view stays small: ${JSON.stringify(view).length}`)
  assert.equal(view.mission.inFlightTokensEstimate, 0)
  // Full records are read by id and paged.
  const page = f.runtime.observe(f.actorA, f.mission.id, { runId })
  assert.equal(page.run.id, runId); assert.equal(page.offset, 0); assert.equal(page.content.length, 12000); assert.equal(page.nextOffset, 12000)
  let body = page.content, next = page.nextOffset
  while (next !== undefined) { const more = f.runtime.observe(f.actorA, f.mission.id, { runId, offset: next }); body += more.content; next = more.nextOffset }
  assert.equal(body.length, page.totalChars); assert.equal(JSON.parse(body).result.output.length, 30000)
  // Event and run cursors return only changes.
  const since = f.runtime.observe(f.actorA, f.mission.id, { after: view.nextAfter, afterRun: view.nextAfterRun })
  assert.deepEqual(since.events, []); assert.deepEqual(since.toolRuns, [])
  const second = await f.workers.callbacks.toolRun(f.a.id, { tool: 'bash', arguments: {}, result: {}, isError: true })
  const delta = f.runtime.observe(f.actorA, f.mission.id, { after: view.nextAfter, afterRun: view.nextAfterRun })
  assert.deepEqual(delta.toolRuns.map(run => run.id), [second]); assert.deepEqual(delta.events.map(event => event.type), ['tool/recorded'])
  assert(delta.events[0].seq > view.nextAfter)
  const evidence = f.runtime.publish(f.actorA, f.mission.id, { taskId: task.id, attemptId: task.attempt.id, claim: 'z'.repeat(3000), outcome: 'supported', toolRunIds: [runId] })
  assert(f.runtime.observe(f.actorA, f.mission.id).evidence[0].claim.length < 500, 'claims are excerpted in the default view')
  assert.equal(f.runtime.observe(f.actorA, f.mission.id, { evidenceId: evidence.id }).evidence.claim.length, 3000)
  const focus = f.runtime.observe(f.owner, f.mission.id, { taskId: task.id })
  assert.equal(focus.task.objective, 'Fix module'); assert.equal(focus.toolRuns.length, 2); assert.equal(focus.evidence[0].claim.length, 3000)
  assert.throws(() => f.runtime.observe(f.owner, f.mission.id, { after: -1 }), /after must be/)
  assert.throws(() => f.runtime.observe(f.owner, f.mission.id, { runId: 'run_missing' }), /Unknown tool run/)
})

test('owner observation is a compact board with usage; detail=full expands records without tool payloads', async t => {
  const f = await manual(t)
  const task = await f.submitted()
  const view = f.runtime.observe(f.owner, f.mission.id)
  assert.deepEqual(view.board.map(item => [item.id, item.status, item.artifact]), [[task.id, 'submitted', task.artifact.commit]])
  assert.equal(view.board[0].objective, undefined)
  assert.deepEqual(view.mission.workerUsage, emptyUsage()); assert.deepEqual(view.mission.ownerUsage, emptyUsage())
  assert.deepEqual(view.evidence, [], 'only challenged evidence is listed by default')
  assert.equal(view.members[0].requests, 0)
  const full = f.runtime.observe(f.owner, f.mission.id, { detail: 'full' })
  assert.equal(full.board[0].objective, 'Fix module'); assert.equal(full.evidence.length, 1)
  assert(!('toolRuns' in full), 'tool payloads are only read by runId')
})

test('a reviewer sees the submitted source with its evidence, and dependencies show replacement lineage', async t => {
  const f = await manual(t)
  const task = await f.submitted()
  const review = f.propose(f.actorB, { kind: 'verification', reviewOf: task.id, checks: [] })
  await f.runtime.claim(f.actorB, f.mission.id, review.id)
  const view = f.runtime.observe(f.actorB, f.mission.id)
  assert.equal(view.current.reviewSource.id, task.id); assert.equal(view.current.reviewSource.artifact.commit, task.artifact.commit)
  assert.equal(view.current.reviewSource.evidence.length, 1); assert.deepEqual(view.current.reviewSource.checks, ['test'])
})

test('routine progress reaches the UI only; the owner is woken for rejection, stall and completion decisions', async t => {
  const f = await manual(t)
  const task = await f.submitted()
  await settle()
  assert.deepEqual(f.controls(), [], 'submission is not an owner notice')
  await f.reviewed(task)
  await settle()
  assert.deepEqual(f.controls(), [], 'acceptance is not an owner notice')
  const events = f.runtime.snapshot(f.owner, f.mission.id).events.map(event => event.type)
  assert(events.includes('task/submitted') && events.includes('task/accepted'), 'progress is durable for the panel')
  const rejected = await f.submitted()
  await f.reviewed(rejected, 'reject')
  const notice = await eventually(() => f.controls().find(delivery => /blocked by independent verification/.test(delivery.content)), 'rejection must wake the owner')
  assert.match(notice.content, new RegExp(rejected.id))
})

test('replacement errors name the failing condition and the live replacement', async t => {
  const f = await manual(t)
  const task = await f.submitted()
  const review = await f.reviewed(task, 'reject')
  assert.equal(f.current(task).status, 'blocked')
  assert.throws(() => f.propose(f.actorA, { kind: 'research', checks: undefined, replaces: [task.id] }), /kind mismatch.*blocked task is implementation/)
  assert.throws(() => f.propose(f.actorA, { replaces: [review.id] }), /verification task\. Repair its reviewed source/)
  assert.throws(() => f.propose(f.actorA, { replaces: [task.id], acceptance: ['other'] }), /Missing: \["works"\]/)
  assert.throws(() => f.propose(f.actorA, { replaces: [task.id], dependencies: [task.id] }), /is blocked and has no live replacement/)
  const repair = f.propose(f.actorA, { replaces: [task.id] })
  const claimed = await f.runtime.claim(f.actorA, f.mission.id, repair.id)
  await f.runtime.submit(f.actorA, f.mission.id, { taskId: repair.id, attemptId: claimed.attempt.id, output: 'repaired' })
  await f.reviewed(repair)
  assert.equal(f.current(task).status, 'cancelled')
  assert.throws(() => f.propose(f.actorA, { replaces: [task.id] }), new RegExp(`is cancelled.*already replaced by ${repair.id} \\(accepted\\)`))
  assert.throws(() => f.propose(f.actorA, { replaces: [repair.id] }), /is accepted, and only blocked work can be replaced/)
})

test('a verification cannot be assigned to its source author or review finished work; sibling reviews are cancelled by the verdict', async t => {
  const f = await manual(t)
  const task = await f.submitted()
  assert.throws(() => f.propose(f.actorB, { kind: 'verification', reviewOf: task.id, checks: [], assigneeId: f.a.id }), /authored .* independent review must be assigned to a different member/)
  const sibling = f.propose(f.actorB, { kind: 'verification', reviewOf: task.id, checks: [] })
  await f.reviewed(task)
  assert.equal(f.current(sibling).status, 'cancelled'); assert.match(f.current(sibling).output, /Superseded/)
  assert.throws(() => f.propose(f.actorB, { kind: 'verification', reviewOf: task.id, checks: [] }), /already accepted; a review can only start on submitted work/)
})

test('owner completion cancels tasks that can never be scheduled once every criterion is independently covered', async t => {
  const f = await manual(t, {}, ['works', 'extra'])
  const task = await f.submitted()
  await assert.rejects(Promise.resolve().then(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'too early')), /unfinished or blocked required work/)
  await f.reviewed(task)
  // The dependent graph existed before its prerequisite was rejected, as in a planned integration.
  const rejected = await f.submitted({ acceptance: ['works', 'extra'] })
  const dependent = f.propose(f.actorA, { kind: 'research', checks: undefined, dependencies: [rejected.id] })
  const review = f.propose(f.actorB, { kind: 'verification', reviewOf: dependent.id, checks: [] })
  const rejectedReview = await f.reviewed(rejected, 'reject')
  // Blocked work whose criterion is uncovered keeps the mission open and says what is missing.
  assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'covered?'), /cover every mission acceptance criterion: \["extra"\]\. Blocked work still needs repair: /)
  const owned = f.runtime.observe(f.owner, f.mission.id)
  assert.deepEqual(new Set(owned.unschedulable), new Set([rejected.id, rejectedReview.id, dependent.id, review.id]), 'blocked work, dead prerequisites and unreachable reviews are reported transitively')
  // Covering the criterion with reviewed research keeps exactly one accepted implementation as the deliverable.
  const cover = await f.submitted({ kind: 'research', checks: undefined, acceptance: ['works', 'extra'] })
  await f.reviewed(cover)
  const completed = f.runtime.control(f.owner, f.mission.id, 'complete', 'Every criterion is covered by accepted work')
  assert.equal(completed.status, 'completed')
  const final = f.runtime.snapshot(f.owner, f.mission.id)
  for (const id of [rejected.id, rejectedReview.id, dependent.id, review.id]) {
    assert.equal(final.tasks.find(item => item.id === id).status, 'cancelled'); assert.match(final.tasks.find(item => item.id === id).output, /Cancelled at completion/)
  }
  assert(final.events.some(event => event.type === 'task/cancelled-at-completion'))
})

test('usage buckets accumulate per worker without double counting and owner usage is attributed to the mission', async t => {
  const f = await manual(t)
  const first = { uncachedInputTokens: 40, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 4, requests: 1 }
  await f.workers.callbacks.usageSnapshot(f.a.id, 100, first)
  await f.workers.callbacks.usageSnapshot(f.a.id, 100, first)
  let snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.mission.usedTokens, 100); assert.deepEqual(snapshot.mission.workerUsage, first)
  assert.deepEqual(snapshot.members.find(m => m.id === f.a.id).usage, first)
  const second = { uncachedInputTokens: 60, cacheReadTokens: 120, cacheWriteTokens: 5, outputTokens: 25, reasoningTokens: 9, requests: 2 }
  await f.workers.callbacks.usageSnapshot(f.a.id, 210, second)
  await f.workers.callbacks.usageSnapshot(f.b.id, 30, { uncachedInputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 1 })
  snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.mission.usedTokens, 240)
  assert.deepEqual(snapshot.mission.workerUsage, { uncachedInputTokens: 90, cacheReadTokens: 120, cacheWriteTokens: 5, outputTokens: 25, reasoningTokens: 9, requests: 3 })
  await assert.rejects(f.workers.callbacks.usageSnapshot(f.a.id, 300, { ...second, requests: -1 }), /Invalid usage buckets/)
  f.workers.callbacks.ownerUsage(f.owner.sessionId, { uncachedInputTokens: 7, cacheReadTokens: 700, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 1, requests: 1 })
  f.workers.callbacks.ownerUsage(f.a.sessionId, { uncachedInputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 1 })
  snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.deepEqual(snapshot.mission.ownerUsage, { uncachedInputTokens: 7, cacheReadTokens: 700, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 1, requests: 1 })
  assert.equal(snapshot.mission.usedTokens, 240, 'owner usage is outside the worker pool budget')
})

test('in-flight requests are estimated from each worker’s average and gate new steps before the pool overruns', async t => {
  const f = await manual(t, { maxTokens: 500 })
  await f.workers.callbacks.usageSnapshot(f.a.id, 400, { uncachedInputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 2 })
  f.workers.callbacks.activity(f.a.id, { id: 'op', kind: 'model', startedAt: Date.now(), updatedAt: Date.now() })
  assert.equal(f.runtime.observe(f.owner, f.mission.id).mission.inFlightTokensEstimate, 200)
  await assert.rejects(f.workers.callbacks.beforeStep(f.b.id), /budget exhausted/)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).mission.status, 'blocked')
})

test('plan validation reports every field problem at once', () => {
  const plan = { title: 'T', objective: 'O', workspace: '/w', scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'a', name: '', role: 'r' }, { key: 'b', name: 'B', role: 'r' }], workstreams: [{ key: 'w', title: 'W', objective: 'W' }],
    tasks: [
      { key: 't1', workstreamKey: 'missing', title: 'T1', objective: 'x', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeKey: 'a' },
      { key: 't2', workstreamKey: 'w', title: 'T2', objective: 'x', kind: 'analysis', scope: ['src/'], acceptance: ['works'] },
      { key: 'r1', workstreamKey: 'w', title: 'R', objective: 'x', kind: 'verification', reviewOf: 't1', assigneeKey: 'a', scope: ['src/'], acceptance: ['works'] },
    ] }
  let message
  try { validatePlan(plan) } catch (error) { message = error.message }
  for (const expected of ['members[a].name', 'tasks[0] (t1).workstreamKey', 'tasks[1] (t2).kind', 'tasks[2] (r1).assigneeKey must differ']) assert.match(message, new RegExp(expected.replace(/[[\]()]/g, '\\$&')), message)
})

// ---- automatic missions: two-task code plans, stalls and automatic completion.
class AutoWorkers extends ControlledWorkers {
  starts = []; inspected = []
  async start(spec) { this.starts.push(spec) }
  async prepareBaseline() { return { sourceHead: 'h'.repeat(40), snapshotCommit: 'base', planningWorkspace: '/planning', changedPaths: [], createdAt: Date.now() } }
  async inspectDelivery(mission, resultCommit) { this.inspected.push(resultCommit); return { baselineCommit: 'base', resultCommit, changedPaths: ['src/value.cjs'], diff: '', truncated: false } }
  async captureArtifact(member, task) { return { commit: `verified-${task.id.slice(-6)}`, baseCommit: 'base', workspace: member.workspace, changedPaths: ['src/value.cjs'] } }
}
async function automatic(t, tasks, acceptance = ['works']) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-efficiency-auto-'))
  const workers = new AutoWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'automatic-owner' }
  const plan = { title: 'Automatic delivery', objective: 'Deliver verified code', workspace: directory, scope: ['src/'], acceptance, budget: { ...budget, maxTokens: 100000, maxSteps: 100 },
    members: [{ key: 'builder', name: 'Builder', role: 'implementation', maxOutputTokens: 4096 }, { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }], tasks }
  const request = runtime.requestStart(owner, { commandId: 'command-1', goal: 'Make the change.', workspace: directory })
  return { runtime, workers, owner, plan, request, directory }
}
const codeTask = (key, extra = {}) => ({ key, workstreamKey: 'main', title: key, objective: key, kind: 'implementation', scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'], maxRecoveryAttempts: 3, checkTimeoutMs: 45000, ...extra })
const reviewTask = (key, reviewOf) => ({ key, workstreamKey: 'main', title: key, objective: key, kind: 'verification', scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf, maxRecoveryAttempts: 3 })
async function acceptByKey(f, snapshot, key) {
  const missionId = snapshot.mission.id
  const builder = snapshot.members.find(member => member.name === 'Builder'), reviewer = snapshot.members.find(member => member.name === 'Reviewer')
  const source = snapshot.tasks.find(task => task.id.endsWith(`_${key}`)), review = snapshot.tasks.find(task => task.reviewOf === source.id)
  const actor = { sessionId: builder.sessionId }, verifier = { sessionId: reviewer.sessionId }
  const claimed = await f.runtime.claim(actor, missionId, source.id)
  await f.runtime.submit(actor, missionId, { taskId: source.id, attemptId: claimed.attempt.id, output: `${key} done` })
  const reviewing = await f.runtime.claim(verifier, missionId, review.id)
  await f.runtime.verify(verifier, missionId, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Checks pass' })
}

test('one reviewed implementation is a complete automatic code plan and becomes the deliverable', async t => {
  const f = await automatic(t, [codeTask('impl'), reviewTask('review', 'impl')])
  const snapshot = await f.runtime.startPlan(f.owner, f.request.id, f.plan)
  assert.equal(snapshot.tasks.length, 2)
  f.workers.callbacks.ownerUsage(f.owner.sessionId, { uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0, requests: 1 })
  await acceptByKey(f, snapshot, 'impl')
  const completed = await eventually(() => { const mission = f.runtime.store.get('missions', snapshot.mission.id); return mission.status === 'completed' ? mission : undefined }, 'automatic completion after the reviewed implementation')
  assert.deepEqual(completed.ownerUsage, { uncachedInputTokens: 1, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 3, reasoningTokens: 0, requests: 1 })
  const inspection = await f.runtime.inspectDelivery(f.owner, snapshot.mission.id)
  const implementation = f.runtime.store.list('tasks', snapshot.mission.id).find(task => task.kind === 'implementation')
  assert.equal(inspection.resultCommit, implementation.artifact.commit, 'the single accepted implementation is the delivery target')
  const notice = await eventually(() => f.workers.deliveries.find(delivery => delivery.kind === 'control' && /Completed/.test(delivery.content)), 'completion wakes the owner')
  assert.match(notice.content, /independently accepted/)
})

test('planning usage before launch is folded into the launched mission', async t => {
  const f = await automatic(t, [codeTask('impl'), reviewTask('review', 'impl')])
  f.workers.callbacks.ownerUsage(f.owner.sessionId, { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 2, requests: 1 })
  assert.deepEqual(f.runtime.starts(f.owner)[0].ownerUsage.requests, 1)
  const snapshot = await f.runtime.startPlan(f.owner, f.request.id, f.plan)
  assert.deepEqual(f.runtime.store.get('missions', snapshot.mission.id).ownerUsage, { uncachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 2, requests: 1 })
  assert.equal(f.runtime.starts(f.owner)[0].ownerUsage, undefined)
})

test('several implementation branches still require a final integration, and one integration must depend on the implementation', async t => {
  const two = await automatic(t, [codeTask('a'), reviewTask('ra', 'a'), codeTask('b'), reviewTask('rb', 'b')])
  await assert.rejects(two.runtime.startPlan(two.owner, two.request.id, two.plan), /Automatic plan rejected.*several implementation tasks require a final integration/s)
  const detached = await automatic(t, [codeTask('a'), reviewTask('ra', 'a'), codeTask('deliver', { kind: 'integration' }), reviewTask('rd', 'deliver')])
  await assert.rejects(detached.runtime.startPlan(detached.owner, detached.request.id, detached.plan), /integration task must depend on implementation a/)
})

test('a stalled board wakes the owner once, and completes automatically when leftovers cannot run but every criterion is covered', async t => {
  const research = (key, extra = {}) => ({ key, workstreamKey: 'main', title: key, objective: key, kind: 'research', scope: ['src/'], acceptance: ['documented'], assigneeKey: 'builder', maxRecoveryAttempts: 3, ...extra })
  const f = await automatic(t, [codeTask('impl'), reviewTask('review', 'impl'), research('base'), reviewTask('rbase', 'base'), research('follow', { dependencies: ['base'] }), reviewTask('rfollow', 'follow')], ['works', 'documented'])
  const snapshot = await f.runtime.startPlan(f.owner, f.request.id, f.plan)
  const missionId = snapshot.mission.id
  const builder = snapshot.members.find(member => member.name === 'Builder'), reviewer = snapshot.members.find(member => member.name === 'Reviewer')
  const actor = { sessionId: builder.sessionId }, verifier = { sessionId: reviewer.sessionId }
  const byKey = key => f.runtime.store.list('tasks', missionId).find(task => task.id.endsWith(`_${key}`))
  async function researchSubmitted(task) {
    const claimed = await f.runtime.claim(actor, missionId, task.id)
    const runId = await f.workers.callbacks.toolRun(builder.id, { tool: 'bash', arguments: {}, result: {}, isError: false })
    f.runtime.publish(actor, missionId, { taskId: task.id, attemptId: claimed.attempt.id, claim: 'Documented', outcome: 'supported', toolRunIds: [runId] })
    await f.runtime.submit(actor, missionId, { taskId: task.id, attemptId: claimed.attempt.id, output: 'report' })
  }
  async function verdict(review, value) {
    const reviewing = await f.runtime.claim(verifier, missionId, review.id)
    f.workers.checks = value === 'accept' ? [{ command: 'node check.cjs', exitCode: 0, output: 'ok' }] : [{ command: 'node check.cjs', exitCode: 1, output: 'failure' }]
    await f.runtime.verify(verifier, missionId, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: value, reason: `Independent ${value}` })
  }
  await acceptByKey(f, snapshot, 'impl')
  await researchSubmitted(byKey('base'))
  await verdict(byKey('rbase'), 'reject')
  assert.equal(byKey('base').status, 'blocked')
  // Nothing runs, follow/rfollow can never start, and 'documented' is uncovered: the owner is told exactly once.
  const stall = await eventually(() => f.workers.deliveries.find(delivery => delivery.kind === 'control' && /Mission stalled/.test(delivery.content)), 'stall notice')
  assert.match(stall.content, /Unschedulable: .*_follow/); assert.match(stall.content, /documented/)
  await settle()
  assert.equal(f.workers.deliveries.filter(delivery => delivery.kind === 'control' && /Mission stalled/.test(delivery.content)).length, 1, 'no repeated stall notices for the same state')
  assert.throws(() => f.runtime.control(f.owner, missionId, 'complete', 'try'), /cover every mission acceptance criterion: \["documented"\]/)
  // The owner covers the criterion with new reviewed research instead of repairing the blocked chain.
  const stream = f.runtime.store.list('workstreams', missionId)[0]
  const doc = f.runtime.propose(f.owner, missionId, { workstreamId: stream.id, title: 'doc', objective: 'Document', kind: 'research', scope: ['src/'], acceptance: ['documented'], assigneeId: builder.id, maxRecoveryAttempts: 3 })
  const rdoc = f.runtime.propose(f.owner, missionId, { workstreamId: stream.id, title: 'rdoc', objective: 'Review doc', kind: 'verification', reviewOf: doc.id, scope: ['src/'], acceptance: ['documented'], assigneeId: reviewer.id, maxRecoveryAttempts: 3 })
  await researchSubmitted(doc)
  await verdict(rdoc, 'accept')
  const completed = await eventually(() => { const mission = f.runtime.store.get('missions', missionId); return mission.status === 'completed' ? mission : undefined }, 'stalled-but-covered mission completes automatically')
  assert.match(completed.reason, /remaining tasks could no longer be scheduled/)
  for (const key of ['follow', 'rfollow', 'base', 'rbase']) assert.equal(byKey(key).status, 'cancelled', key)
  assert.match(byKey('follow').output, /Cancelled at completion/)
  assert.equal(byKey('impl').status, 'accepted'); assert.equal(f.runtime.store.get('tasks', doc.id).status, 'accepted')
})
