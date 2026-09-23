/** Durable task/receipt regressions. Real runtime and SQLite, controlled workers. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { canBorrowTask } from '../lib/assignment.js'
import { taskGraphIndex } from '../lib/task-graph.js'

class Workers {
  deliveries = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, id) { return join(mission.workspace, id) }
  async start() {}
  async stop() {}
  async dispose() {}
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, delivery: structuredClone(delivery) }) }
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact(member, task) { return { commit: createHash('sha1').update(task.id).digest('hex'), baseCommit: 'b'.repeat(40), workspace: member.workspace, changedPaths: ['src/a.ts'] } }
  async verifyArtifact() { return [{ command: 'npm test', exitCode: 0, output: 'ok' }] }
}
async function eventually(read, message, timeout = 6000) {
  const until = Date.now() + timeout
  while (Date.now() < until) { const result = read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(message)
}
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-identity-'))
  const config = { statePath: join(root, 'state.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100, ...extra }
  const workers = new Workers(), runtime = new SwarmRuntime(config, workers)
  const nativeKick = runtime.kick.bind(runtime)
  runtime.kick = () => {}
  runtime.pumpOutbox = () => {}
  const runtimes = [runtime]
  t.after(async () => { for (const rt of runtimes) await rt.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { sessionId: 'identity-owner' }
  const mission = runtime.create(owner, { title: 'Orchestration identities', objective: 'Complete independently verified work', workspace: root, scope: ['src/'], acceptance: ['done'], budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Complete the work' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const integrator = await runtime.addMember(owner, mission.id, { name: 'Integrator', role: 'integration' })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (title, values = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['done'], checks: ['npm test'], assigneeId: author.id, ...values })
  const submit = async task => {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    await runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'Candidate artifact' })
  }
  const accept = async task => {
    await submit(task)
    const review = propose('Independent review', { kind: 'verification', reviewOf: task.id, assigneeId: reviewer.id, checks: [] })
    const claimed = await runtime.claim(actor(reviewer), mission.id, review.id)
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'Verified the exact candidate' })
  }
  const restart = async () => {
    await runtimes.at(-1).dispose()
    const restored = new SwarmRuntime(config, new Workers())
    restored.kick = () => {}; restored.pumpOutbox = () => {}
    runtimes.push(restored)
    await restored.start()
    return restored
  }
  const startScheduler = async () => { runtime.kick = nativeKick; await runtime.start() }
  return { root, config, runtime, workers, owner, mission, author, reviewer, integrator, actor, propose, submit, accept, restart, startScheduler }
}

async function replacementChain(f) {
  const original = f.propose('Original implementation')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'Repair needed' })
  const first = f.propose('First repair', { replaces: [original.id] })
  f.runtime.cancel(f.owner, f.mission.id, { taskId: first.id, reason: 'Refine repair' })
  const current = f.propose('Current repair', { replaces: [first.id] })
  return { original, first, current }
}

test('C04: an ancestor fork cannot displace an accepted repair or change a running integration dependency', async t => {
  const f = await fixture(t)
  const { original, current } = await replacementChain(f)
  await f.accept(current)
  const integration = f.propose('Integrate accepted result', { kind: 'integration', dependencies: [original.id], assigneeId: f.integrator.id })
  const running = await f.runtime.claim(f.actor(f.integrator), f.mission.id, integration.id)
  const tasksBefore = f.runtime.store.list('tasks', f.mission.id).length
  assert.throws(() => f.propose('Competing ancestor repair', { replaces: [original.id] }), error => /already replaced/.test(error.message) && error.message.includes(current.id))
  assert.equal(f.runtime.store.list('tasks', f.mission.id).length, tasksBefore)
  assert.equal(f.runtime.effectiveDependency(f.mission.id, original.id).id, current.id)
  assert.equal(f.runtime.dependencySatisfied(f.mission.id, original.id), true)
  assert.equal(f.runtime.task(f.mission.id, integration.id).attempt.id, running.attempt.id)
  assert.equal(f.workers.callbacks.guard(f.integrator.id, 'write_file'), undefined)
})

test('C04: a pending descendant also prevents an ancestor from admitting a competing repair', async t => {
  const f = await fixture(t)
  const { original, current } = await replacementChain(f)
  assert.throws(() => f.propose('Competing repair', { replaces: [original.id] }), error => /already replaced/.test(error.message) && error.message.includes(current.id))
  assert.equal(f.runtime.effectiveDependency(f.mission.id, original.id).id, current.id)
})

test('C04: legacy forks keep an accepted descendant visible and refuse ambiguous accepted branches', () => {
  const row = (id, status, replaces = [], createdAt = 1) => ({ id, kind: 'implementation', status, replaces, createdAt, dependencies: [] })
  const old = row('original', 'cancelled'), first = row('first', 'cancelled', ['original'], 2)
  const accepted = row('accepted-grandchild', 'accepted', ['first'], 3)
  const fork = row('pending-fork', 'pending', ['original'], 4)
  const graph = taskGraphIndex([old, first, accepted, fork])
  assert.deepEqual(graph.lineage(old.id).map(task => task.id), [old.id, first.id, accepted.id])
  assert.equal(graph.dependencyMet(old.id), true)
  const ambiguous = taskGraphIndex([old, first, accepted, { ...fork, status: 'accepted' }])
  assert.equal(ambiguous.dependencyMet(old.id), false)
  assert.match(ambiguous.effective(old.id).output, /Ambiguous accepted replacements/)
})

for (const omitAdmissionEvent of [false, true]) test(`C08: withdrawn automatic review survives event eviction and restart${omitAdmissionEvent ? ' even if its follow-up event failed' : ''}`, async t => {
  const f = await fixture(t, { tickMs: 10, maxEvents: 20 })
  const event = f.runtime.store.event.bind(f.runtime.store)
  if (omitAdmissionEvent) f.runtime.store.event = (...args) => {
    if (args[1] === 'task/review-admitted') throw new Error('injected post-admission writer failure')
    return event(...args)
  }
  await f.startScheduler()
  const source = f.propose('Automatic review source')
  await f.submit(source)
  const reviews = rt => rt.store.list('tasks', f.mission.id).filter(task => task.reviewOf === source.id)
  const automatic = await eventually(() => reviews(f.runtime)[0], 'the scheduler must admit a review')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: automatic.id, reason: 'Owner withdraws this review' })
  for (let n = 0; n < 35; n++) f.runtime.setAdmissionLimit(f.owner, f.mission.id, { level: 'taskClass', key: 'implementation', limit: 100 + n }, 'Unrelated admission update')
  assert.equal(f.runtime.store.events(f.mission.id, 20).some(row => row.type === 'task/review-admitted'), false)
  const restored = await f.restart()
  for (let n = 0; n < 3; n++) await restored.schedule(f.mission.id)
  assert.deepEqual(reviews(restored).map(task => ({ id: task.id, status: task.status })), [{ id: automatic.id, status: 'cancelled' }])
  const blocker = restored.store.latestTaskEvent(f.mission.id, source.id, 'task/review-blocked')
  assert.match(blocker.data.reason, /withdrawn/)
  assert.ok(blocker.data.reason.includes(automatic.id))
})

test('C09: a scope correction preserves untouched preferred borrowing, while execution history stays fenced', async t => {
  const f = await fixture(t)
  const busy = f.propose('Existing author work')
  await f.runtime.claim(f.actor(f.author), f.mission.id, busy.id)
  const untouched = f.propose('Parallel preferred work', { assignmentMode: 'preferred' })
  const amended = f.runtime.controlTask(f.owner, f.mission.id, untouched.id, 'amend', { scope: ['src/a.ts'] }, 'Correct output path before execution')
  assert.ok(amended.epoch > untouched.epoch)
  assert.deepEqual(amended.priorOwnerIds, [])
  assert.equal(canBorrowTask(amended), true)
  const claimed = await f.runtime.claim(f.actor(f.integrator), f.mission.id, amended.id)
  assert.equal(claimed.attempt.ownerId, f.integrator.id)
  assert.equal(claimed.assigneeId, f.integrator.id)
  assert.equal(claimed.plannedAssigneeId, f.integrator.id, 'recovery follows the actual owner even after policy amendment')
  const restored = await f.restart()
  const recovered = restored.task(f.mission.id, claimed.id)
  assert.equal(recovered.status, 'pending')
  assert.ok(recovered.priorOwnerIds.includes(f.integrator.id))
  assert.equal(canBorrowTask(recovered), false, 'the new owner history prevents automatic borrowing after execution')
  assert.equal(canBorrowTask({ ...amended, priorOwnerIds: undefined }), false, 'legacy rows without history keep the conservative epoch fence')
})

for (const paused of [false, true]) test(`C06: a ${paused ? 'paused' : 'live'} owner cannot settle a question by sending its answer to another member`, async t => {
  const f = await fixture(t)
  f.runtime.message(f.actor(f.author), f.mission.id, { to: 'owner', kind: 'question', content: 'Which result should I produce?' })
  await f.runtime.flushOutbox(f.mission.id)
  const question = f.runtime.openAsks(f.mission.id, 'owner')[0]
  if (paused) f.runtime.control(f.owner, f.mission.id, 'pause', 'Pause while considering the answer')
  const before = f.runtime.store.list('deliveries', f.mission.id)
  assert.throws(() => f.runtime.message(f.owner, f.mission.id, { to: f.reviewer.id, kind: 'question', content: 'Wrong destination', replyTo: question.id }), error => error.code === 'reply_recipient_mismatch')
  assert.deepEqual(f.runtime.store.list('deliveries', f.mission.id), before)
  assert.equal(f.runtime.store.get('deliveries', question.id).state, 'open')
  const reply = f.runtime.message(f.owner, f.mission.id, { to: f.author.id, kind: 'question', content: 'Use the recorded scope', replyTo: question.id })
  assert.equal(reply.answered, question.id)
  assert.equal(f.runtime.store.get('deliveries', question.id).state, 'answered')
  const answer = f.runtime.store.list('deliveries', f.mission.id).find(row => row.inReplyTo === question.id)
  assert.equal(answer.to, f.author.id)
})

test('C06: member replies use the same recipient check; dismiss still closes without sending', async t => {
  const f = await fixture(t)
  f.runtime.message(f.actor(f.author), f.mission.id, { to: f.reviewer.id, kind: 'question', content: 'Can you clarify the acceptance?' })
  const question = f.runtime.openAsks(f.mission.id, f.reviewer.id)[0]
  assert.throws(() => f.runtime.message(f.actor(f.reviewer), f.mission.id, { to: 'owner', kind: 'question', content: 'Misrouted answer', replyTo: question.id }), error => error.code === 'reply_recipient_mismatch')
  assert.equal(f.runtime.store.get('deliveries', question.id).state, 'open')
  const result = f.runtime.message(f.actor(f.reviewer), f.mission.id, { to: 'owner', kind: 'question', content: 'This question is no longer needed', replyTo: question.id, dismiss: true })
  assert.equal(result.dismissed, question.id)
  assert.equal(result.queued, false)
  assert.equal(f.runtime.store.get('deliveries', question.id).state, 'dismissed')
})

test('dependency amendments report full replacement and cancellation names the stranded existing task', async t => {
  const f = await fixture(t)
  const first = f.propose('First input'), second = f.propose('Second input')
  const integration = f.propose('Combine the selected input', { kind: 'integration', dependencies: [first.id], assigneeId: f.integrator.id })
  const amended = f.runtime.controlTask(f.owner, f.mission.id, integration.id, 'amend', { dependencies: [second.id] }, 'Use the corrected input')
  assert.deepEqual(amended.dependencies, [second.id])
  assert.deepEqual(amended.dependencyChanges, { previous: [first.id], current: [second.id], added: [second.id], removed: [first.id] })
  assert.equal(f.runtime.task(f.mission.id, integration.id).dependencyChanges, undefined, 'call feedback does not become another durable dependency representation')
  const unrelated = f.runtime.cancel(f.owner, f.mission.id, { taskId: first.id, reason: 'No longer used' })
  assert.deepEqual(unrelated.strandedDependents ?? [], [])
  const withdrawn = f.runtime.cancel(f.owner, f.mission.id, { taskId: second.id, reason: 'Repair this input' })
  assert.deepEqual(withdrawn.strandedDependents, [integration.id])
  assert.equal(f.runtime.task(f.mission.id, integration.id).status, 'pending')
  const repair = f.propose('Corrected input', { replaces: [second.id] })
  assert.equal(f.runtime.effectiveDependency(f.mission.id, second.id).id, repair.id)
  assert.deepEqual(f.runtime.task(f.mission.id, integration.id).dependencies, [second.id], 'replacement reuses the dependent instead of duplicating delivery work')
})

test('C04: legacy fork branches converging on one accepted repair remain one dependency and retain both obligations', () => {
  const row = (id, status, replaces = [], createdAt = 1) => ({ id, kind: 'implementation', status, replaces, createdAt, dependencies: [] })
  const original = row('original', 'cancelled')
  const left = row('left', 'cancelled', [original.id], 2), right = row('right', 'blocked', [original.id], 3)
  const joined = row('joined', 'accepted', [left.id, right.id], 4)
  const graph = taskGraphIndex([original, left, right, joined])
  assert.equal(graph.effective(original.id).id, joined.id)
  assert.equal(graph.dependencyMet(original.id), true)
  assert.deepEqual(graph.lineage(original.id).map(task => task.id), [original.id, left.id, joined.id])
  assert.deepEqual([...graph.identities(original.id)].sort(), [original.id, left.id, right.id, joined.id].sort())
  const integration = { ...row('integration', 'accepted'), dependencies: [original.id] }
  assert.equal(graph.covers(integration, left.id), true)
  assert.equal(graph.covers(integration, right.id), true)
  assert.equal(graph.covers(integration, joined.id), true)
})

test('C04: accepted frontier stops at live carriers and still distinguishes genuinely different accepted results', () => {
  const row = (id, status, replaces = [], createdAt = 1) => ({ id, kind: 'implementation', status, replaces, createdAt, dependencies: [] })
  for (const status of ['pending', 'running', 'submitted']) {
    const original = row('original', 'cancelled')
    const carrier = row('carrier', status, [original.id], 2)
    const hidden = row('old-accepted', 'accepted', [carrier.id], 3)
    const graph = taskGraphIndex([original, carrier, hidden])
    assert.equal(graph.effective(original.id).id, carrier.id)
    assert.equal(graph.dependencyMet(original.id), false)
    assert.equal(graph.identities(original.id).has(hidden.id), false)
  }
  const original = row('original', 'cancelled'), parent = row('parent', 'cancelled', [original.id])
  const first = row('first', 'accepted', [parent.id]), second = row('second', 'accepted', [parent.id])
  const graph = taskGraphIndex([original, parent, first, second])
  assert.equal(graph.dependencyMet(original.id), false)
  assert.match(graph.effective(original.id).output, /first, second/)
  const multi = taskGraphIndex([row('a', 'cancelled'), row('b', 'blocked'), row('merged', 'accepted', ['a', 'b'])])
  assert.equal(multi.effective('a').id, 'merged')
  assert.equal(multi.effective('b').id, 'merged')
})
