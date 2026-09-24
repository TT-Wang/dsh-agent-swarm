import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { SwarmRuntime } from '../lib/runtime.js'
import { OwnerReplyGuard } from '../lib/owner-reply.js'
import { RoleScoper } from '../lib/roles.js'
import { HarnessWorkers } from '../lib/harness-workers.js'
import { registerAutomaticStart } from '../lib/planner.js'
import { hasNotice } from '../lib/arena.js'
import { tempDirectory } from './temp-root.mjs'
import { makeRuntimeStub } from './faults/harness.mjs'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
class Workers {
  deliveries = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver(_member, delivery) { this.deliveries.push(structuredClone(delivery)) }
  async stop() {}
  isIdle() { return false }
  async dispose() {}
}
async function fixture(t) {
  const root = await tempDirectory('swarm-rule-owner-')
  const workers = new Workers()
  const config = { statePath: join(root, 'state.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 10000, maxEvents: 20, maxTasksPerMember: 100 }
  let runtime = new SwarmRuntime(config, workers)
  runtime.kick = () => {}
  runtime.notices.wakeBudget = 0
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Owner channel', objective: 'Preserve decisions', workspace: root, scope: ['**'], acceptance: ['works'], budget })
  const member = await runtime.addMember(owner, mission.id, { name: 'Asker', role: 'research' })
  const rows = () => runtime.store.list('deliveries', mission.id)
  const question = async () => {
    runtime.message({ sessionId: member.sessionId }, mission.id, { to: 'owner', kind: 'question', content: 'Which complete answer?' })
    await runtime.flushOutbox(mission.id)
    return rows().filter(row => row.replyExpected).at(-1)
  }
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, owner, mission, member, workers, rows, question, get runtime() { return runtime }, async reload() {
    await runtime.dispose(); runtime = new SwarmRuntime(config, workers); runtime.kick = () => {}; runtime.notices.wakeBudget = 0
  } }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

for (const status of ['paused', 'blocked', 'budget-quiescing']) test(`R02: full answers survive ${status}, restart and identical retries until resumed delivery`, async t => {
  const f = await fixture(t)
  const question = await f.question()
  const row = f.runtime.mission(f.mission.id)
  if (status === 'budget-quiescing') row.budgetPause = { id: 'pause', state: 'stopping' }
  else row.status = status
  f.runtime.commit(row.id, () => f.runtime.store.put('missions', row))
  const content = 'Full answer beyond event summaries. '.repeat(45)
  const input = { to: f.member.id, kind: 'question', replyTo: question.id, content }
  assert.equal(f.runtime.message(f.owner, row.id, input).queued, true)
  f.runtime.message(f.owner, row.id, input)
  await f.runtime.flushOutbox(row.id)
  assert.equal(f.rows().filter(item => item.inReplyTo === question.id).length, 1)
  assert.equal(f.workers.deliveries.filter(item => item.inReplyTo === question.id).length, 0)
  assert.equal(f.runtime.openAsks(row.id, 'owner').length, 0)
  await f.reload()
  f.runtime.message(f.owner, row.id, input)
  const restored = f.rows().find(item => item.inReplyTo === question.id)
  assert.equal(restored.content, content)
  assert.equal(restored.deliveredAt, undefined)
  const resumed = f.runtime.mission(row.id); resumed.status = 'active'; delete resumed.budgetPause
  f.runtime.commit(row.id, () => f.runtime.store.put('missions', resumed))
  await f.runtime.flushOutbox(row.id)
  f.runtime.message(f.owner, row.id, input)
  await f.runtime.flushOutbox(row.id)
  assert.equal(f.workers.deliveries.filter(item => item.inReplyTo === question.id).length, 1)
  assert.equal(f.rows().filter(item => item.inReplyTo === question.id).length, 1)
})

for (const status of ['completed', 'stopped']) test(`R02: ${status} receipt closes without waking or queuing worker work`, async t => {
  const f = await fixture(t), question = await f.question()
  const row = f.runtime.mission(f.mission.id); row.status = status
  f.runtime.commit(row.id, () => f.runtime.store.put('missions', row))
  const result = f.runtime.message(f.owner, row.id, { to: f.member.id, kind: 'question', replyTo: question.id, content: 'Final recorded answer' })
  assert.equal(result.queued, false)
  assert.equal(result.answered, question.id)
  assert.equal(f.rows().filter(item => item.inReplyTo === question.id).length, 0)
})

test('R01: legacy block config leaves owner tool execution available to answer', async t => {
  const f = await fixture(t), question = await f.question(), hooks = []
  const guard = new OwnerReplyGuard({ on: () => () => {}, agents: { get: () => ({ ctx: { on: (...args) => { hooks.push(args); return () => {} } } }) } }, f.runtime, { guard: 'block', maxNudges: 2 })
  t.after(() => guard.dispose())
  guard.observe('owner', 'user/message', { createdAt: Date.now() + 1 })
  guard.observe('owner', 'turn/end', { reason: { kind: 'completed' } })
  assert.equal(hooks.length, 0)
  assert.equal(f.runtime.store.get('deliveries', question.id).replyNudges, 1)
  f.runtime.message(f.owner, f.mission.id, { to: f.member.id, kind: 'question', replyTo: question.id, content: 'Now answered' })
  assert.equal(f.runtime.openAsks(f.mission.id).length, 0)
})

test('R03: a host append rejection is never an acknowledgement, even one naming this package', async t => {
  // The package-owned append refusal is gone: delivery relevance is the one
  // false-wake judge, so every host append failure stays an outbox obligation.
  const f = await fixture(t), ctx = new Context()
  const delivery = { id: 'exact', missionId: f.mission.id, from: 'runtime', to: 'owner', kind: 'control', content: 'old decision', createdAt: Date.now(), subjects: ['task@1'], notice: { class: 'decision', dedupKey: 'fallthrough:fact' } }
  const refusal = Object.assign(new Error('invariant violated by "@dsh-external/dsh-agent-swarm": refusing an owner-facing fallthrough decision'), { name: 'InvariantError', code: 'INVARIANT' })
  ctx.provide('agents', { get: () => ({ session: { snapshotEvents: () => [] }, send: () => { throw refusal } }) })
  ctx.provide('sessions', { flush: async () => {} })
  const adapter = new HarnessWorkers(ctx, { workspacesRoot: f.root, checkTimeoutMs: 1000, maxCheckOutputBytes: 1024 })
  t.after(() => adapter.dispose())
  await assert.rejects(adapter.deliver({ id: 'owner', missionId: f.mission.id, sessionId: 'owner' }, delivery), error => error === refusal)
})

test('R03: unrelated host invariant retains outbox identity and one durable failure until retry succeeds', async t => {
  const f = await fixture(t)
  f.runtime.notify(f.mission.id, 'Choose a recoverable route', [`mission:${f.mission.id}`], { dedupKey: 'route-decision' })
  const delivery = f.rows().find(item => item.content === 'Choose a recoverable route')
  const error = Object.assign(new Error('other package invariant rejects append'), { name: 'InvariantError', code: 'INVARIANT' })
  f.workers.deliver = async () => { throw error }
  await f.runtime.flushOutbox(f.mission.id)
  await f.runtime.flushOutbox(f.mission.id)
  assert.equal(f.runtime.store.get('deliveries', delivery.id).deliveredAt, undefined)
  assert.equal(f.runtime.store.events(f.mission.id, 500).filter(event => event.data.cause === 'owner-delivery-failed' && event.data.deliveryId === delivery.id).length, 1)
  await f.reload()
  await f.runtime.flushOutbox(f.mission.id)
  assert.equal(f.runtime.store.events(f.mission.id, 500).filter(event => event.data.cause === 'owner-delivery-failed' && event.data.deliveryId === delivery.id).length, 1)
  f.workers.deliver = async (_member, message) => f.workers.deliveries.push(message)
  await f.runtime.flushOutbox(f.mission.id)
  assert.ok(f.runtime.store.get('deliveries', delivery.id).deliveredAt)
  assert.equal(f.workers.deliveries.filter(item => item.id === delivery.id).length, 1)
})

async function stalledDecision(f) {
  const task = { id: 'blocked-task', missionId: f.mission.id, workstreamId: 'stream', title: 'Needs owner action', objective: 'Progress', kind: 'research', status: 'blocked', epoch: 1, dependencies: [], scope: ['**'], acceptance: ['works'], checks: [], evidenceIds: [], priority: 0, experiment: false, createdAt: Date.now() }
  f.runtime.commit(f.mission.id, () => {
    f.runtime.store.put('tasks', task)
    f.runtime.notify(f.mission.id, 'Repair the task with owner control', ['blocked-task@1'], { dedupKey: 'test-unresolved' })
  })
  await f.runtime.flushOutbox(f.mission.id)
  return f.rows().find(row => row.notice?.dedupKey === 'test-unresolved')
}

test('Q01: receiving and ending a turn leaves unresolved decisions eligible for bounded durable followup', async t => {
  const f = await fixture(t), original = await stalledDecision(f)
  const handling = { admitted: new Set(), pending: new Set(), handled: new Set() }
  const scoper = Object.create(RoleScoper.prototype)
  scoper.observeHandling(handling, { type: 'user/message', data: { source: { kind: 'swarm', deliveryId: original.id } } })
  scoper.observeHandling(handling, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.ok(handling.handled.has(original.id))
  f.runtime.notices.obligationFollowupMs = 0
  f.runtime.notices.absenceNet(f.mission.id)
  const key = `obligation-followup:${original.id}:`
  assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith(key)).length, 1)
  await f.reload()
  f.runtime.notices.obligationFollowupMs = 0
  for (let i = 0; i < 5; i++) f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith(key)).length, 2, 'restart keeps the durable reminder bound')
})

test('Q01: actual task resolution and explicit owner pause/stop suppress followup', async t => {
  for (const state of ['resolved', 'paused', 'stopped']) {
    const f = await fixture(t), original = await stalledDecision(f)
    if (state === 'resolved') { const task = f.runtime.task(f.mission.id, 'blocked-task'); task.status = 'cancelled'; f.runtime.store.put('tasks', task) }
    else { const mission = f.runtime.mission(f.mission.id); mission.status = state; f.runtime.store.put('missions', mission) }
    f.runtime.notices.obligationFollowupMs = 0
    f.runtime.notices.absenceNet(f.mission.id)
    assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith(`obligation-followup:${original.id}:`)).length, 0, state)
  }
})

for (const reviewStatus of ['pending', 'running', 'parked']) test(`owner reminders stop when an independent review is ${reviewStatus}, including after reload`, async t => {
  const f = await fixture(t), original = await stalledDecision(f)
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const source = f.runtime.task(f.mission.id, 'blocked-task')
  source.status = 'submitted'
  const review = { ...source, id: 'independent-review', kind: 'verification', reviewOf: source.id, status: reviewStatus === 'parked' ? 'blocked' : reviewStatus,
    ...(reviewStatus === 'running' ? { attempt: { id: 'review-attempt', ownerId: f.member.id, epoch: 1, leaseUntil: now + 3600000 } } : {}),
    ...(reviewStatus === 'parked' ? { resumeAfterStop: { epoch: 1, at: now, memberId: f.member.id } } : {}) }
  f.runtime.store.transaction(() => {
    f.runtime.store.put('tasks', source)
    f.runtime.store.event(f.mission.id, 'task/submitted', f.member.id, { taskId: source.id, epoch: source.epoch })
    f.runtime.store.put('tasks', review)
  })
  t.mock.timers.tick(120000)
  assert.ok(f.runtime.latestSubmission(f.mission.id, source.id).age >= f.runtime.config.tickMs)
  assert.equal(f.runtime.notices.waitsLegitimately(source, f.runtime.store.list('tasks', f.mission.id)), true)
  const key = `obligation-followup:${original.id}:`
  for (let i = 0; i < 2; i++) {
    f.runtime.notices.obligationFollowupMs = 0
    f.runtime.notices.absenceNet(f.mission.id)
    assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith(key)).length, 0, 'admitting the review fulfills the request before its verdict')
    if (i === 0) await f.reload()
  }
  const cancelled = f.runtime.task(f.mission.id, review.id)
  cancelled.status = 'cancelled'; delete cancelled.resumeAfterStop; delete cancelled.attempt
  f.runtime.store.put('tasks', cancelled)
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith(key)).length, 1, 'a retired review leaves a real unresolved obligation visible')
})

test('a reminder queued before review admission is retained in the ledger but never sent afterwards', async t => {
  const f = await fixture(t), original = await stalledDecision(f)
  f.runtime.notices.obligationFollowupMs = 0
  f.runtime.notices.absenceNet(f.mission.id)
  const reminder = f.rows().find(row => row.notice?.dedupKey === `obligation-followup:${original.id}:1`)
  assert.ok(reminder)
  const source = f.runtime.task(f.mission.id, 'blocked-task'); source.status = 'submitted'
  f.runtime.store.transaction(() => {
    f.runtime.store.put('tasks', source)
    f.runtime.store.put('tasks', { ...source, id: 'review', kind: 'verification', reviewOf: source.id, status: 'pending' })
    f.runtime.store.put('tasks', { ...source, id: 'other-submission' })
    f.runtime.notify(f.mission.id, 'Admit the now-existing review', [`${source.id}@${source.epoch}`], { family: 'review-blocked' })
    f.runtime.notify(f.mission.id, 'Stale mixed batch', [`${source.id}@${source.epoch}`, 'other-submission@1'], { family: 'review-blocked' })
    f.runtime.notify(f.mission.id, 'Current remaining request', ['other-submission@1'], { family: 'review-blocked' })
    f.runtime.notify(f.mission.id, 'Legacy review decision', [`${source.id}@${source.epoch}`])
  })
  await f.runtime.flushOutbox(f.mission.id)
  for (const row of f.rows().filter(row => row.id === reminder.id || ['Admit the now-existing review', 'Legacy review decision', 'Stale mixed batch'].includes(row.content))) {
    assert.equal(row.deliveredAt, undefined, 'suppression is not a transport acknowledgement')
    assert.equal(f.workers.deliveries.some(delivery => delivery.id === row.id), false)
  }
  assert.equal(f.workers.deliveries.some(delivery => delivery.content === 'Current remaining request'), true)
})

test('bounded reminders do not create reminders of reminders', async t => {
  const f = await fixture(t), original = await stalledDecision(f)
  f.runtime.notices.obligationFollowupMs = 0
  for (let i = 0; i < 6; i++) {
    f.runtime.notices.absenceNet(f.mission.id)
    await f.runtime.flushOutbox(f.mission.id)
  }
  const reminders = f.rows().filter(row => row.notice?.dedupKey.startsWith('obligation-followup:'))
  assert.equal(reminders.filter(row => row.notice.dedupKey.startsWith(`obligation-followup:${original.id}:`)).length, 2)
  assert.ok(reminders.every(row => !reminders.some(parent => row.notice.dedupKey.startsWith(`obligation-followup:${parent.id}:`))))
})

test('review admission replaces a stale multi-subject decision with a fresh remaining-subject decision', async t => {
  const f = await fixture(t)
  await stalledDecision(f)
  const source = f.runtime.task(f.mission.id, 'blocked-task'); source.status = 'submitted'
  const other = { ...source, id: 'remaining-submission' }
  f.runtime.commit(f.mission.id, () => {
    f.runtime.store.put('tasks', source)
    f.runtime.store.put('tasks', other)
  })
  await flush()
  const old = f.rows().find(row => row.notice?.dedupKey.startsWith('review-blocked:') && row.subjects?.length === 2)
  assert.ok(old, 'the actual transition publisher announces both missing reviews')
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', {
    ...source, id: 'admitted-review', kind: 'verification', reviewOf: source.id, status: 'running',
    attempt: { id: 'review-attempt', ownerId: f.member.id, epoch: 1, leaseUntil: Date.now() + 3600000 },
  }))
  await flush()
  const fresh = f.rows().find(row => row.notice?.dedupKey.startsWith('review-blocked:') && row.subjects?.length === 1 && row.subjects[0] === `${other.id}@1`)
  assert.ok(fresh, 'the same publisher regenerates the still-unresolved subject')
  assert.notEqual(old.notice.dedupKey, fresh.notice.dedupKey)
  await f.runtime.flushOutbox(f.mission.id)
  assert.equal(f.workers.deliveries.some(row => row.id === old.id), false)
  assert.equal(f.workers.deliveries.some(row => row.id === fresh.id), true, 'suppressing the obsolete batch does not suppress the necessary owner wake')
})

test('completion suppresses old actions while delivering the final result and historical facts once', async t => {
  const f = await fixture(t)
  f.runtime.store.transaction(() => {
    f.runtime.notify(f.mission.id, 'Old review action', ['old-source@1'], { family: 'review-blocked' })
    f.runtime.notify(f.mission.id, 'Old silence action', ['old-source@1'], { noticeClass: 'stall' })
    f.runtime.notify(f.mission.id, 'Old budget action', ['mission:' + f.mission.id], { noticeClass: 'budget' })
    f.runtime.notify(f.mission.id, 'Retained host fact', ['mission:' + f.mission.id], { noticeClass: 'progress' })
    f.runtime.notify(f.mission.id, 'Completed result', ['mission:' + f.mission.id], { noticeClass: 'completion' })
    const mission = f.runtime.mission(f.mission.id); mission.status = 'completed'; f.runtime.store.put('missions', mission)
  })
  await f.runtime.flushOutbox(f.mission.id)
  await f.reload()
  await f.runtime.flushOutbox(f.mission.id)
  assert.equal(f.workers.deliveries.filter(row => row.content === 'Old review action').length, 0)
  assert.equal(f.workers.deliveries.filter(row => row.content === 'Old silence action' || row.content === 'Old budget action').length, 0)
  assert.equal(f.workers.deliveries.filter(row => row.content === 'Completed result').length, 1)
  assert.equal(f.workers.deliveries.filter(row => row.content === 'Retained host fact').length, 1)
})

for (const includeCompletion of [false, true]) test(`wake summaries recheck individual facts and preserve completion=${includeCompletion}`, async t => {
  const f = await fixture(t)
  f.runtime.notices.wakeBudget = 1
  f.runtime.store.transaction(() => {
    f.runtime.notify(f.mission.id, 'First fact occupies the individual wake', ['mission:' + f.mission.id], { noticeClass: 'progress' })
    f.runtime.notify(f.mission.id, 'Obsolete review request', ['old-source@1'], { family: 'review-blocked' })
    f.runtime.notify(f.mission.id, 'Obsolete silence request', ['old-source@1'], { noticeClass: 'stall' })
    if (includeCompletion) f.runtime.notify(f.mission.id, 'Final accepted deliverable', ['mission:' + f.mission.id], { noticeClass: 'completion' })
    const mission = f.runtime.mission(f.mission.id); mission.status = 'completed'; f.runtime.store.put('missions', mission)
  })
  const summary = f.rows().find(row => row.notice?.dedupKey.startsWith('wake-budget:'))
  assert.ok(summary.notice.aggregatedFacts.length >= 2, 'new summaries retain each fact identity and subject')
  await f.reload()
  assert.equal(f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), summary), includeCompletion)
  await f.runtime.flushOutbox(f.mission.id)
  await f.runtime.flushOutbox(f.mission.id)
  const sent = f.workers.deliveries.filter(row => row.id === summary.id)
  assert.equal(sent.length, includeCompletion ? 1 : 0)
  if (includeCompletion) {
    assert.match(sent[0].content, /Final accepted deliverable/)
    assert.doesNotMatch(sent[0].content, /Obsolete review request|Obsolete silence request/)
  }
  const stored = f.runtime.store.get('deliveries', summary.id)
  assert.ok(stored.notice.facts.some(fact => fact.includes('Obsolete review request')), 'filtering transport never erases the historical fact')
})

test('a delivered summary does not revive a resolved review request because unrelated work remains blocked', async t => {
  const f = await fixture(t)
  await stalledDecision(f)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const source = { ...f.runtime.task(f.mission.id, 'blocked-task'), id: 'submitted-source', status: 'submitted' }
  f.runtime.store.transaction(() => {
    f.runtime.store.put('tasks', source)
    f.runtime.store.event(f.mission.id, 'task/submitted', f.member.id, { taskId: source.id, epoch: source.epoch })
  })
  t.mock.timers.tick(120000)
  f.runtime.notices.wakeBudget = 1
  f.runtime.store.transaction(() => {
    f.runtime.notify(f.mission.id, 'An observed fact', ['mission:' + f.mission.id], { noticeClass: 'progress' })
    f.runtime.notify(f.mission.id, 'Please admit the review', [`${source.id}@1`], { family: 'review-blocked' })
  })
  await f.runtime.flushOutbox(f.mission.id)
  const summary = f.rows().find(row => row.notice?.aggregatedFacts?.some(part => part.subjects.includes(`${source.id}@1`)))
  assert.ok(summary.deliveredAt)
  const review = { ...source, id: 'summary-review', kind: 'verification', reviewOf: source.id, status: 'pending' }
  f.runtime.store.put('tasks', review)
  f.runtime.notices.obligationFollowupMs = 0
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(f.runtime.store.get('deliveries', summary.id).notice.followupCount, undefined)
  review.status = 'cancelled'; f.runtime.store.put('tasks', review)
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(f.runtime.store.get('deliveries', summary.id).notice.followupCount, 1, 'the constituent obligation becomes actionable again when its review is withdrawn')
})

test('Q02: empty scheduling passes and repeated failed tools cannot conceal a lack of progress', async t => {
  const f = await fixture(t)
  await stalledDecision(f)
  const task = f.runtime.task(f.mission.id, 'blocked-task'); task.status = 'running'
  task.attempt = { id: 'repeat-attempt', ownerId: f.member.id, epoch: task.epoch, leaseUntil: Date.now() + 3600000 }
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', task))
  await flush()
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(601000)
  for (let index = 0; index < 30; index++) {
    await f.workers.callbacks.toolRun(f.member.id, { tool: 'read', arguments: { path: 'missing.txt' }, result: 'same missing file', isError: true })
    f.runtime.commit(f.mission.id, () => {
      f.runtime.store.event(f.mission.id, 'mission/scheduling-pass', 'runtime', { progress: false })
      const mission = f.runtime.mission(f.mission.id); mission.updatedAt = Date.now(); f.runtime.store.put('missions', mission)
    })
  }
  assert.equal(f.runtime.store.toolRuns(f.mission.id, { attemptId: 'repeat-attempt' }).length, 30, 'the host callback durably attributed every ineffective execution')
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith('absence:')).length, 1)
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith('absence:')).length, 1, 'diagnostics do not re-arm their own absence')
  t.mock.timers.tick(1)
  f.runtime.commit(f.mission.id, () => f.runtime.store.event(f.mission.id, 'task/submitted', f.member.id, { taskId: task.id, artifact: { commit: 'new' } }))
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith('absence:')).length, 1, 'a real submitted artifact resets the clock')
})

test('Q02: one long in-flight operation remains quiet beyond the progress bound', async t => {
  const f = await fixture(t)
  f.runtime.notices.absenceBoundMs = 0
  const member = f.runtime.store.get('members', f.member.id); member.activity = { kind: 'check', startedAt: f.runtime.notices.interpretation(f.mission.id).lastTransitionAt }
  f.runtime.store.put('members', member)
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith('absence:')).length, 0)
})

function plannerFixture(t) {
  const disposers = [], handlers = new Set(), requests = new Map(), events = [], sent = []
  let failFlush = true
  const request = { id: 'start', ownerSessionId: 'owner', commandId: 'command', status: 'planning', planningEpoch: 3, planningDeadlineAt: Date.now() + 60000, updatedAt: Date.now(), goal: 'Plan work', workspace: '/project' }
  request.planningWarning = { deadline: request.planningDeadlineAt, threshold: 30000 }
  requests.set(request.id, request)
  const agent = { id: 'owner', session: { snapshotEvents: () => events }, send(message) { sent.push(message); events.push({ type: 'user/message', data: message }) } }
  const ctx = { agents: { get: () => agent }, sessions: { async flush() { if (failFlush) throw new Error('persistence offline') } },
    on: () => () => {}, effect: factory => disposers.push(factory()), inject() {}, commands: { register: () => () => {} } }
  const runtime = makeRuntimeStub({ config: { tickMs: 60000 }, stallPassTimeoutMs: 1000, store: { list: () => [...requests.values()], get: (_table, id) => structuredClone(requests.get(id)), put: (_table, row) => requests.set(row.id, structuredClone(row)) },
    subscribe(fn) { handlers.add(fn); return () => handlers.delete(fn) }, commit: (_id, fn) => fn() })
  registerAutomaticStart(ctx, runtime)
  t.after(() => disposers.forEach(dispose => dispose()))
  return { requests, sent, retry: () => { failFlush = false; for (const handler of handlers) handler() } }
}

test('R12: a deadline warning retries its same identity after failed flush and preserves planning epoch', async t => {
  const f = plannerFixture(t)
  await flush()
  assert.equal(f.requests.get('start').planningWarning.deliveredAt, undefined)
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0].content[0].text, /action: "extend"/)
  f.retry(); await flush()
  assert.ok(f.requests.get('start').planningWarning.deliveredAt)
  assert.equal(f.sent.length, 1, 'retry flushes the already accepted inbox identity')
  assert.equal(f.requests.get('start').status, 'planning')
  assert.equal(f.requests.get('start').planningEpoch, 3)
})

test('R06: in-flight usage triggers durable mission review with a larger recommendation before settled exhaustion', async t => {
  const f = await fixture(t)
  const member = f.runtime.store.get('members', f.member.id)
  member.accountedTokens = 10000; member.usage = { requests: 1 }; member.activity = { id: 'model', kind: 'model', startedAt: Date.now(), updatedAt: Date.now() }
  const mission = f.runtime.mission(f.mission.id); mission.usedTokens = 65000
  f.runtime.commit(mission.id, () => { f.runtime.store.put('members', member); f.runtime.store.put('missions', mission) })
  f.runtime.gates.warnBudget(f.runtime.mission(mission.id))
  const warnings = () => f.runtime.store.events(mission.id, 100).filter(event => event.type === 'mission/budget-warning' && event.data.dimension === 'maxTokens')
  assert.equal(warnings().length, 1)
  assert.equal(warnings()[0].data.used, 65000)
  assert.equal(warnings()[0].data.inFlightEstimate, 10000)
  assert.equal(warnings()[0].data.projected, 75000)
  assert.ok(warnings()[0].data.suggestedLimit > mission.budget.maxTokens)
  assert.equal(f.runtime.mission(mission.id).status, 'active')
  assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith('budget-review:')).length, 1)
  await f.reload()
  f.runtime.gates.warnBudget(f.runtime.mission(mission.id))
  assert.equal(warnings().length, 1, 'restart does not repeat a threshold for the same limit')
  const amended = f.runtime.mission(mission.id); amended.budget.maxTokens = 105000
  f.runtime.commit(mission.id, () => f.runtime.store.put('missions', amended))
  f.runtime.gates.warnBudget(f.runtime.mission(mission.id))
  assert.equal(warnings().length, 2, 'a changed limit has its own review identity')
})

test('R06/R10: task step and finding warnings preserve task identity and submission path', async t => {
  const f = await fixture(t)
  await stalledDecision(f)
  const task = f.runtime.task(f.mission.id, 'blocked-task'); task.status = 'running'; task.maxSteps = 10; task.usedSteps = 7; task.maxFindings = 2; task.evidenceIds = ['one', 'two']; task.attempt = { id: 'attempt', ownerId: f.member.id, epoch: task.epoch, leaseUntil: Date.now() + 60000 }
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', task))
  f.runtime.gates.warnBudget(f.runtime.mission(f.mission.id))
  const warnings = f.runtime.store.events(f.mission.id, 100).filter(event => event.type === 'mission/budget-warning' && event.data.taskId === task.id)
  assert.deepEqual(warnings.map(event => event.data.dimension).sort(), ['maxFindings', 'maxSteps'])
  assert.ok(warnings.every(event => event.data.suggestedLimit > event.data.limit))
  const batches = f.rows().filter(row => row.notice?.dedupKey.startsWith('budget-review:'))
  assert.equal(batches.length, 1, 'one pass sends one resource decision with both threshold facts')
  const findingNotice = batches[0]
  assert.equal(findingNotice.notice.aggregatedIdentities.length, 2)
  for (const warning of warnings) {
    assert.equal(hasNotice(f.rows(), { class: 'budget', from: 'runtime', dedupKey: `budget-review:${f.mission.id}:${task.id}:${warning.data.dimension}:${warning.data.limit}:${warning.data.threshold}` }), true)
  }
  assert.match(findingNotice.content, /Finding count is advisory/)
  assert.equal(f.runtime.task(f.mission.id, task.id).status, 'running')
  assert.equal(f.runtime.task(f.mission.id, task.id).attempt.id, 'attempt')
  await f.reload()
  f.runtime.gates.warnBudget(f.runtime.mission(f.mission.id))
  assert.equal(f.rows().filter(row => row.notice?.dedupKey.startsWith('budget-review:')).length, 1, 'all dimensions stay deduplicated after restart')
})

test('bounded notice summaries retain complete facts and original identities through exact reads and restart', async t => {
  const f = await fixture(t)
  f.runtime.notices.wakeBudget = 1
  const facts = Array.from({ length: 30 }, (_, index) => `Fact ${index}: ${'diagnostic detail '.repeat(200)} Action ${index}: repair the recorded condition.`)
  const emit = (fact, index) => f.runtime.commit(f.mission.id, () => f.runtime.notify(f.mission.id, fact, [`mission:${f.mission.id}`], { trigger: 'test/long-fact', dedupKey: `long-fact:${index}` }))
  facts.forEach(emit)
  const first = f.rows().find(row => row.notice?.dedupKey === 'long-fact:0')
  const summary = f.rows().find(row => row.notice?.dedupKey.startsWith('wake-budget:'))
  assert.ok(first.content.length <= 3200)
  assert.ok(summary.content.length <= 3200)
  assert.match(summary.content, /further fact\(s\) retained/)
  assert.ok(summary.content.includes(summary.id), 'the compact message links to the exact full record')
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id, { deliveryId: first.id }).delivery.notice.facts, [facts[0]])
  const stored = f.runtime.observe(f.owner, f.mission.id, { deliveryId: summary.id }).delivery
  assert.deepEqual(stored.notice.facts, facts.slice(1).map(fact => `[test/long-fact] ${fact}`))
  for (let index = 0; index < facts.length; index++) assert.equal(hasNotice(f.rows(), { class: 'decision', from: 'runtime', dedupKey: `long-fact:${index}`, content: facts[index] }), true)
  await f.reload()
  facts.forEach(emit)
  assert.equal(f.rows().filter(row => row.notice?.dedupKey === 'long-fact:0' || row.notice?.dedupKey.startsWith('wake-budget:')).length, 2)
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id, { deliveryId: summary.id }).delivery.notice.facts, stored.notice.facts)
})

test('a resource batch crossing the wake budget retains each dimension identity and keeps paused work quiet', async t => {
  const f = await fixture(t)
  f.runtime.notices.wakeBudget = 1
  f.runtime.commit(f.mission.id, () => f.runtime.notify(f.mission.id, 'Existing owner decision', [`mission:${f.mission.id}`], { dedupKey: 'prefill' }))
  const mission = f.runtime.mission(f.mission.id)
  mission.usedTokens = 70000; mission.usedSteps = 700
  f.runtime.store.put('missions', mission)
  f.runtime.gates.warnBudget(f.runtime.mission(mission.id))
  const warnings = () => f.runtime.store.events(mission.id, 100).filter(event => event.type === 'mission/budget-warning')
  assert.equal(warnings().length, 2)
  const summary = f.rows().find(row => row.notice?.dedupKey.startsWith('wake-budget:'))
  assert.ok(summary)
  for (const warning of warnings()) {
    const key = `budget-review:${mission.id}:mission:${warning.data.dimension}:${warning.data.limit}:${warning.data.threshold}`
    assert.equal(hasNotice(f.rows(), { class: 'budget', from: 'runtime', dedupKey: key }), true)
    assert.ok(summary.notice.facts.some(fact => fact.includes(warning.data.dimension)))
  }
  await f.reload()
  f.runtime.gates.warnBudget(f.runtime.mission(mission.id))
  assert.equal(warnings().length, 2)
  for (const status of ['paused', 'stopped']) {
    const current = f.runtime.mission(mission.id)
    current.status = status; current.usedTokens = 95000; current.usedSteps = 950
    f.runtime.store.put('missions', current)
    f.runtime.gates.warnBudget(current)
    assert.equal(warnings().length, 2, status)
  }
})

test('unresolved reminders excerpt a legacy long notice without losing the original or resending it in full', async t => {
  const f = await fixture(t), original = await stalledDecision(f)
  const full = `Root condition: ${'complete diagnostic '.repeat(400)}. Resume the original task after repair.`
  const record = f.runtime.store.get('deliveries', original.id)
  record.content = full
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('deliveries', record))
  f.runtime.notices.obligationFollowupMs = 0
  f.runtime.notices.absenceNet(f.mission.id)
  const followup = f.rows().find(row => row.notice?.dedupKey === `obligation-followup:${original.id}:1`)
  assert.ok(followup.content.length < 1300)
  assert.match(followup.content, /Root condition:/)
  assert.match(followup.content, /Resume the original task after repair/)
  assert.ok(followup.content.includes(original.id))
  assert.equal(f.runtime.observe(f.owner, f.mission.id, { deliveryId: original.id }).delivery.content, full)
})

test('R12: warning precedes planning expiry, deduplicates the same deadline, and re-arms on extension', async t => {
  const f = await fixture(t)
  const request = f.runtime.requestStart({ sessionId: 'planner-owner' }, { commandId: 'deadline-check', workspace: f.root, goal: 'Plan the retained request' })
  const row = f.runtime.store.get('starts', request.id); row.planningDeadlineAt = Date.now() + 10000
  f.runtime.store.put('starts', row)
  f.runtime.sweepStarts()
  const first = f.runtime.store.get('starts', request.id)
  assert.equal(first.status, 'planning')
  assert.equal(first.planningWarning.deadline, row.planningDeadlineAt)
  assert.equal(first.planningWarning.deliveredAt, undefined)
  f.runtime.sweepStarts()
  const warnings = () => f.runtime.store.events(request.id, 100).filter(event => event.type === 'mission/budget-warning' && event.data.requestId === request.id)
  assert.equal(warnings().length, 1)
  f.runtime.controlStart({ sessionId: 'planner-owner' }, request.id, 'extend', 'planning has more work', 20000)
  f.runtime.sweepStarts()
  assert.equal(warnings().length, 2)
  assert.equal(f.runtime.store.get('starts', request.id).planningEpoch, first.planningEpoch)
})
