/**
 * T1b arena protocols (mission criterion 2, R11-17 and R10-04).
 *
 * The contracts pinned here:
 *  - a worker's proposal allowance is bounded by the owner-set mission ceiling
 *    (ceil(maxTasks / maxWorkers), floor 1), a member can never raise it, and a
 *    refusal for the allowance or a budget/ceiling reason records a durable
 *    owner notice naming the member, the limit and the reason;
 *  - `swarm_escalate` is a typed, durable owner escalation, not a board post:
 *    it reaches the owner through the notice path, carries the authenticated
 *    sender plus the mission/task/attempt it concerns, is visible in the arena
 *    view and the notice ledger, and grants no authority;
 *  - every owner notice records sent/queued/claimed with the mission-state
 *    fingerprint F(S) as its dedup key and is exposed read-only;
 *  - the new tool joins the single SWARM_TOOLS registry, the closed TRACE_STEPS
 *    vocabulary and the member surface (registration is fiber-scoped in
 *    src/index.ts, and tests/harness-composition.mjs asserts unload removes
 *    every swarm tool).
 *
 * These behaviours do not exist on the pre-fix head `8bb06a2`: the runtime has
 * no `escalate`, no allowance and no notice envelope, and src/arena.ts is absent
 * (`git show 8bb06a2:src/runtime.ts | grep -c escalate` is 0), so every test
 * below fails before the fix.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime, ObserveDetailRefusedError } from '../lib/runtime.js'
import { registerTools, SWARM_TOOLS, MEMBER_TOOLS, hiddenToolsFor } from '../lib/tools.js'
import { TRACE_STEPS } from '../lib/trace.js'
import { arenaLedgerDigest, noticeFingerprint, pendingReadiness, proposalAllowance } from '../lib/arena.js'

const DEFAULT_BUDGET = { maxTokens: 100000, maxSteps: 100, maxWorkers: 2, maxDurationMs: 600000, maxTasks: 6, maxExperiments: 1 }

/** Fake adapter: no auto-dispatch, records every delivery, no filesystem effects. */
class Workers {
  deliveries = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, memberId) { return `/isolated/${memberId}` }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, delivery }) }
  async stop() {}
  isIdle() { return false }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-arena-'))
  const stateDirectory = join(root, 'state')
  const workspace = join(root, 'workspace')
  await mkdir(stateDirectory, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'marker.txt'), 'workspace marker\n')
  const workers = new Workers()
  const config = { statePath: join(stateDirectory, 'db.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 4 }
  // Production composition: src/index.ts spreads the plugin config into the
  // runtime and adds maxTasksPerMember, the loaded grants and the authorization
  // predicate. Nothing below injects a value the production path does not get.
  const runtime = new SwarmRuntime({ ...config, maxTasksPerMember: config.maxTasksPerMember }, workers)
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const budget = { ...DEFAULT_BUDGET, ...(options.budget ?? {}) }
  const owner = { sessionId: `owner-${randomUUID()}` }
  const mission = runtime.create(owner, {
    title: 'Arena protocols', objective: 'Exercise the arena contracts end to end', workspace,
    scope: ['src/'], acceptance: ['the arena works'], budget,
  })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Arena work' })
  const alice = await runtime.addMember(owner, mission.id, { name: 'alice', role: 'implementation' })
  const bob = await runtime.addMember(owner, mission.id, { name: 'bob', role: 'reviewer' })
  return {
    root, stateDirectory, workspace, workers, runtime, config, owner, mission, stream, alice, bob,
    budget, aliceActor: { sessionId: alice.sessionId }, bobActor: { sessionId: bob.sessionId },
  }
}

function definitions(runtime) {
  const registered = new Map()
  registerTools({ tools: { register: definition => registered.set(definition.name, definition) } }, runtime, DEFAULT_BUDGET)
  return registered
}
const execution = sessionId => ({ signal: new AbortController().signal, agent: { id: sessionId } })
const proposal = (f, overrides = {}) => ({
  missionId: f.mission.id, workstreamId: f.stream.id, title: 'Worker task',
  objective: 'Exercise the arena contract', kind: 'research', scope: ['src/'], acceptance: ['the arena works'], ...overrides,
})
const notices = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice !== undefined)
const records = f => ({
  mission: f.runtime.store.get('missions', f.mission.id),
  tasks: f.runtime.store.list('tasks', f.mission.id),
  members: f.runtime.store.list('members', f.mission.id),
  evidence: f.runtime.store.list('evidence', f.mission.id),
  deliveries: f.runtime.store.list('deliveries', f.mission.id),
})
/** Mission-authority records only: an escalation may add deliveries, never these. */
const authorityRecords = f => JSON.stringify({
  mission: f.runtime.store.get('missions', f.mission.id),
  tasks: f.runtime.store.list('tasks', f.mission.id),
  members: f.runtime.store.list('members', f.mission.id),
  evidence: f.runtime.store.list('evidence', f.mission.id),
})
async function eventually(read, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(message)
}

test('R11-17: the per-member allowance is derived from the owner-set ceiling, and refusal wakes the owner with member, limit and reason', async t => {
  const f = await fixture(t, { budget: { maxTasks: 6, maxWorkers: 2 } })
  const tools = definitions(f.runtime)
  const propose = tools.get('swarm_propose')
  const alice = execution(f.alice.sessionId)
  const bob = execution(f.bob.sessionId)

  // ceil(6 / 2) = 3. The owner-proposed count is not a worker allowance.
  for (let index = 0; index < 3; index++) {
    const admitted = await propose.execute(proposal(f, { title: `Alice task ${index}` }), alice)
    assert.equal(admitted.result.proposedBy, f.alice.id, 'the durable proposer key is host-derived')
  }
  const before = f.runtime.store.list('tasks', f.mission.id).length
  await assert.rejects(propose.execute(proposal(f, { title: 'Alice task 3' }), alice), /per-member proposal allowance/)
  assert.equal(f.runtime.store.list('tasks', f.mission.id).length, before, 'a refused proposal admits nothing')
  assert.equal(f.runtime.store.list('tasks', f.mission.id).filter(task => task.proposedBy === f.alice.id).length, 3)

  const refusal = f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'task/proposal-refused').at(-1)
  assert.ok(refusal, 'the refusal is a durable event')
  assert.equal(refusal.data.memberId, f.alice.id)
  assert.equal(refusal.data.limit, 3)
  assert.match(refusal.data.reason, /allowance/)
  const allowanceNotice = notices(f).filter(delivery => delivery.notice.class === 'budget').at(-1)
  assert.ok(allowanceNotice, 'the refusal records an owner notice')
  assert.match(allowanceNotice.content, new RegExp(f.alice.id), 'the notice names the member')
  assert.match(allowanceNotice.content, /limit 3/, 'the notice names the limit')
  assert.match(allowanceNotice.content, /allowance/, 'the notice names the reason')

  // An identical retry, and a retry with a different title, are the same
  // decision in the same state: one notice, no spam.
  const afterFirst = notices(f).length
  await assert.rejects(propose.execute(proposal(f, { title: 'Alice task 3' }), alice), /per-member proposal allowance/)
  await assert.rejects(propose.execute(proposal(f, { title: 'Alice task 3 renamed' }), alice), /per-member proposal allowance/)
  assert.equal(notices(f).length, afterFirst, 'an unchanged state does not spam the owner')
  // No tool argument is a lever: the allowance is a function of durable state.
  await assert.rejects(propose.execute({ ...proposal(f, { title: 'Alice task 3' }), maxProposalsPerMember: 99 }, alice), /per-member proposal allowance/)
  assert.equal(notices(f).length, afterFirst, 'an extra tool argument grants nothing')

  // A different member's refusal in that state is a different decision.
  for (let index = 0; index < 3; index++) await propose.execute(proposal(f, { title: `Bob task ${index}` }), bob)
  assert.equal(f.runtime.store.list('tasks', f.mission.id).length, 6, 'the mission ceiling is now full')
  await assert.rejects(propose.execute(proposal(f, { title: 'Bob task 3' }), bob), /task budget exhausted/)
  const ceilingNotice = notices(f).filter(delivery => delivery.notice.class === 'budget').at(-1)
  assert.equal(notices(f).length, afterFirst + 1, 'a different member is a new decision')
  assert.match(ceilingNotice.content, new RegExp(f.bob.id))
  assert.match(ceilingNotice.content, /task budget exhausted \(6\/6/, 'the ceiling reason and its numbers are named')
  assert.match(ceilingNotice.content, /limit 6/)

  // A member cannot raise its own allowance: budget updates are owner-only.
  assert.throws(() => f.runtime.updateBudget(f.aliceActor, f.mission.id, { ...f.budget, maxTasks: 30 }, 'raise my allowance'), /Only the primary user session/)

  // The owner raises the ceiling and the allowance follows; the member can work again.
  f.runtime.updateBudget(f.owner, f.mission.id, { ...f.budget, maxTasks: 12 }, 'more board for repairs')
  const raised = proposalAllowance(f.runtime.store.get('missions', f.mission.id), f.runtime.store.list('members', f.mission.id), f.runtime.store.list('tasks', f.mission.id), f.alice.id)
  assert.equal(raised.limit, 6, 'ceil(12 / 2)')
  const admitted = await propose.execute(proposal(f, { title: 'Alice task 4' }), alice)
  assert.equal(admitted.result.proposedBy, f.alice.id, 'the owner-set ceiling raises the allowance')
})

test('R11-17: the experiment ceiling refuses a worker proposal with an owner notice naming the reason', async t => {
  const f = await fixture(t, { budget: { maxTasks: 6, maxWorkers: 2, maxExperiments: 0 } })
  const tools = definitions(f.runtime)
  await assert.rejects(tools.get('swarm_propose').execute(proposal(f, { title: 'Experiment', experiment: true }), execution(f.alice.sessionId)), /experiment budget exhausted/)
  const notice = notices(f).find(delivery => delivery.notice.class === 'budget')
  assert.ok(notice)
  assert.match(notice.content, new RegExp(f.alice.id))
  assert.match(notice.content, /experiment budget exhausted \(0\/0/)
  assert.match(notice.content, /limit 0/)
})

test('the notice ledger records sent, queued and claimed with the state fingerprint and is read-only', async t => {
  const f = await fixture(t)
  const propose = definitions(f.runtime).get('swarm_propose')
  const alice = execution(f.alice.sessionId)
  for (let index = 0; index < 3; index++) await propose.execute(proposal(f, { title: `Ledger task ${index}` }), alice)
  // Trigger the refusal synchronously so the outbox has not drained yet: the
  // same call through the tool awaits a trace write, which lets setImmediate run.
  assert.throws(() => f.runtime.propose(f.aliceActor, f.mission.id, proposal(f, { title: 'Ledger task 3' })), /per-member proposal allowance/)

  // Synchronous read: the notice is recorded and queued, not yet delivered.
  const queuedView = f.runtime.noticeLedger(f.owner, f.mission.id)
  const queued = queuedView.ledger.find(entry => entry.class === 'budget')
  assert.ok(queued, 'the ledger exposes the notice')
  assert.equal(queued.state, 'queued')
  assert.equal(queued.deliveredAt, undefined)
  assert.equal(queued.consumedAt, undefined, 'transport is never relabelled as consumption')
  assert.ok(Number.isSafeInteger(queued.sentAt) && Number.isSafeInteger(queued.queuedAt))
  assert.equal(queued.sentAt, queued.queuedAt, 'sent and queued are recorded at enqueue')
  // R17-G3: the identity is the fact — family, subject@epoch and the recorded
  // reason — not a digest of the whole board, so an unrelated change cannot
  // re-arm this notice.
  assert.match(queued.dedupKey, /^budget:mission_[0-9a-f-]+:mission:mission_[0-9a-f-]+:(?:none|[0-9a-f]{16})$/, `the dedup key is the fact key: ${queued.dedupKey}`)
  assert.equal(queued.deliveryId, queued.id)
  // Read-only: two reads of the same state are identical and mutate nothing.
  const revision = f.runtime.store.revision()
  assert.deepEqual(f.runtime.noticeLedger(f.owner, f.mission.id), queuedView)
  f.runtime.observe(f.owner, f.mission.id, { detail: 'full' })
  assert.equal(f.runtime.store.revision(), revision, 'reading the ledger and instruments commits no state change')
  assert.equal(f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.deliveredAt === undefined).length, 1, 'only the notice itself is pending')

  // The outbox drains on the scheduler pass: the transport fact is `delivered`.
  const deliveredEntry = await eventually(() => {
    const entry = f.runtime.noticeLedger(f.owner, f.mission.id).ledger.find(row => row.class === 'budget')
    return entry?.state === 'claimed' ? entry : undefined
  }, 'the owner notice was never delivered')
  assert.ok(deliveredEntry.deliveredAt >= deliveredEntry.sentAt)
  const delivered = f.runtime.store.list('deliveries', f.mission.id).find(delivery => delivery.id === deliveredEntry.deliveryId)
  assert.equal(delivered.deliveredAt, deliveredEntry.deliveredAt, 'the transport fact is the adapter delivery timestamp')

  // R17-G8: consumption is a separate fact, recorded once from the host's
  // claimed signal (the adapter maps the delivery id), with a compare-and-swap.
  assert.equal(f.runtime.recordConsumption(deliveredEntry.deliveryId), true, 'the host claimed signal records consumption')
  assert.equal(f.runtime.recordConsumption(deliveredEntry.deliveryId), false, 'a second signal cannot move the timestamp')
  const consumed = f.runtime.noticeLedger(f.owner, f.mission.id).ledger.find(row => row.deliveryId === deliveredEntry.deliveryId)
  assert.ok(consumed.consumedAt >= consumed.deliveredAt, 'consumption is recorded after delivery, as its own fact')
  assert.equal(consumed.state, 'claimed', 'the transport state stays transport: consumption never rewrites it')

  // The ledger is owner-only; workers must not read control-plane notices.
  assert.throws(() => f.runtime.noticeLedger(f.aliceActor, f.mission.id), /Only the mission owner/)
  const ownerView = f.runtime.observe(f.owner, f.mission.id, { detail: 'full' })
  assert.ok(Array.isArray(ownerView.noticeLedger) && ownerView.noticeLedger.length >= 1)
  assert.match(ownerView.fingerprint, /^[a-f0-9]{32}$/, 'the owner sees the no-silent-state F(S), not the 64-hex ledger digest')
  assert.equal(ownerView.fingerprint, f.runtime.fingerprint(f.mission.id), 'the owner-visible fingerprint is the runtime F(S)')
  const memberView = f.runtime.observe(f.aliceActor, f.mission.id)
  assert.equal(memberView.noticeLedger, undefined, 'a worker read never exposes the owner notice ledger')
  assert.throws(() => f.runtime.observe(f.aliceActor, f.mission.id, { detail: 'full' }), ObserveDetailRefusedError)
})

test('swarm_escalate is a typed durable owner escalation that grants no authority and is not a board post', async t => {
  const f = await fixture(t)
  const tools = definitions(f.runtime)
  const escalate = tools.get('swarm_escalate')
  assert.match(escalate.description, /not a board post/i)
  assert.match(escalate.description, /grants no authority/)

  const source = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Owned work', objective: 'Give alice a live attempt',
    kind: 'research', scope: ['src/'], acceptance: ['the arena works'],
  })
  const claimed = await f.runtime.claim(f.aliceActor, f.mission.id, source.id)
  const before = authorityRecords(f)

  const raised = await escalate.execute({ missionId: f.mission.id, body: 'Owner: the check command is ambiguous; please decide' }, execution(f.alice.sessionId))
  const escalation = raised.result
  assert.equal(escalation.missionId, f.mission.id)
  assert.equal(escalation.fromMemberId, f.alice.id, 'the sender is host-derived')
  assert.equal(escalation.taskId, source.id, 'the running attempt is bound automatically')
  assert.equal(escalation.attemptId, claimed.attempt.id)
  assert.match(escalation.dedupKey, /^[a-f0-9]{64}$/)
  assert.ok(escalation.deliveryId)

  const delivery = f.runtime.store.list('deliveries', f.mission.id).find(item => item.id === escalation.deliveryId)
  assert.ok(delivery, 'the escalation reaches the owner through a durable delivery')
  assert.equal(delivery.kind, 'escalation')
  assert.equal(delivery.to, 'owner')
  assert.equal(delivery.notice.class, 'escalation')
  assert.equal(delivery.escalation.id, escalation.id)
  assert.equal(f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'escalation/raised').length, 1)

  // No authority: no task, member, evidence or mission field changed.
  assert.equal(authorityRecords(f), before, 'recording an escalation changes no task state')

  // Visible in the arena view and the notice ledger.
  const view = f.runtime.observe(f.owner, f.mission.id, { detail: 'full' })
  assert.equal(view.escalations.length, 1)
  assert.equal(view.noticeLedger.find(entry => entry.class === 'escalation').escalation.id, escalation.id)
  const row = view.arena.members.find(member => member.id === f.alice.id)
  assert.equal(row.currentTaskId, source.id)
  assert.equal(row.attemptId, claimed.attempt.id)
  assert.ok(Number.isSafeInteger(row.attemptAgeMs) && row.attemptAgeMs >= 0, 'the arena exposes attempt age')
  assert.deepEqual(row.pendingDependencies, [])
  assert.equal(view.pendingDispatchable, 0)

  // A board post is a different channel: it never becomes an escalation.
  const post = f.runtime.post(f.aliceActor, f.mission.id, { kind: 'ALERT', body: 'Same words, different channel' })
  const afterPost = f.runtime.observe(f.owner, f.mission.id, { detail: 'full' })
  assert.equal(afterPost.escalations.length, 1, 'a post never becomes an escalation')
  assert.ok(!afterPost.noticeLedger.some(entry => entry.content === post.body), 'a post is not an owner notice')

  // Explicit asks are never deduplicated: two asks are two records.
  await escalate.execute({ missionId: f.mission.id, body: 'Owner: second ask' }, execution(f.alice.sessionId))
  assert.equal(f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'escalation/raised').length, 2)
  assert.equal(f.runtime.observe(f.owner, f.mission.id, { detail: 'full' }).escalations.length, 2)

  // Hostile escalations are refused: no foreign attempt, no forged attempt, no owner self-escalation.
  await assert.rejects(escalate.execute({ missionId: f.mission.id, taskId: source.id, attemptId: claimed.attempt.id, body: 'hostile' }, execution(f.bob.sessionId)), /not owned by the caller/)
  await assert.rejects(escalate.execute({ missionId: f.mission.id, taskId: source.id, attemptId: 'attempt_forged', body: 'hostile' }, execution(f.bob.sessionId)), /does not belong to that task/)
  await assert.rejects(escalate.execute({ missionId: f.mission.id, body: 'owner escalation' }, execution(f.owner.sessionId)), /Only a mission member/)
  assert.equal(authorityRecords(f).includes('hostile'), false, 'a refused escalation records no content')
})

test('the arena ledger digest is stable and order-independent; the notice channel is excluded from the dedup key', () => {
  const member = (id, status) => ({ id, missionId: 'm', name: id, role: 'r', sessionId: `s-${id}`, workspace: '/w', status, subscriptions: [] })
  const task = (id, status, owner) => ({
    id, missionId: 'm', workstreamId: 'w', title: id, objective: id, kind: 'research', dependencies: [], scope: ['src/'],
    acceptance: ['a'], checks: [], status, priority: 50, experiment: false, epoch: 0, evidenceIds: [], createdAt: 1,
    ...(owner === undefined ? {} : { attempt: { id: `a-${id}`, epoch: 0, ownerId: owner, leaseUntil: 1 } }),
  })
  const base = {
    mission: { status: 'active', updatedAt: 1 },
    tasks: [task('task_a', 'pending'), task('task_b', 'running', 'member_a')],
    members: [member('member_a', 'working'), member('member_b', 'idle')],
    evidence: [],
    deliveries: [],
  }
  assert.equal(arenaLedgerDigest(base), arenaLedgerDigest({ ...base, tasks: [...base.tasks].reverse(), members: [...base.members].reverse() }), 'input order is irrelevant')
  assert.equal(arenaLedgerDigest(base), arenaLedgerDigest({ ...base, mission: { status: 'active', updatedAt: 999 }, tasks: base.tasks.map(item => ({ ...item, createdAt: 999 })) }), 'wall-clock fields are excluded')
  assert.notEqual(arenaLedgerDigest(base), arenaLedgerDigest({ ...base, tasks: [task('task_a', 'running', 'member_b'), base.tasks[1]] }), 'a status change changes the digest')
  assert.notEqual(arenaLedgerDigest(base), arenaLedgerDigest({ ...base, tasks: [base.tasks[0], base.tasks[1], task('task_c', 'pending')] }), 'a new task changes the digest')
  assert.notEqual(arenaLedgerDigest(base), arenaLedgerDigest({ ...base, members: [member('member_a', 'idle'), base.members[1]] }), 'a member status change changes the digest')

  const notice = { id: 'd1', missionId: 'm', from: 'runtime', to: 'owner', kind: 'control', content: 'x', createdAt: 1, notice: { dedupKey: 'k', class: 'decision', sentAt: 1, queuedAt: 1 } }
  assert.notEqual(arenaLedgerDigest({ ...base, deliveries: [notice] }), arenaLedgerDigest(base), 'the ledger digest counts pending deliveries')
  assert.equal(noticeFingerprint({ ...base, deliveries: [notice] }), noticeFingerprint(base), 'the notice channel is not board state')
  const assignment = { id: 'd2', missionId: 'm', from: 'runtime', to: 'member_a', kind: 'assignment', content: 'x', createdAt: 1 }
  assert.notEqual(noticeFingerprint({ ...base, deliveries: [assignment] }), noticeFingerprint(base), 'member-bound deliveries still count')

  assert.deepEqual(pendingReadiness(base.tasks, base.members), { ready: 1, notReady: 0 })
  assert.deepEqual(pendingReadiness([task('task_a', 'pending')], [member('member_a', 'stopped')]), { ready: 0, notReady: 1 })
  assert.deepEqual(pendingReadiness([{ ...task('task_a', 'pending'), dependencies: ['task_b'] }], base.members), { ready: 0, notReady: 1 })
})

test('swarm_escalate joins the single registry, the closed trace vocabulary and the member surface', async t => {
  const f = await fixture(t)
  const tools = definitions(f.runtime)
  assert.deepEqual([...tools.keys()], [...SWARM_TOOLS], 'registration order is the cached schema prefix')
  for (const name of SWARM_TOOLS) assert(TRACE_STEPS.includes(name), `${name} must be a closed trace step`)
  assert(SWARM_TOOLS.includes('swarm_escalate'))
  assert(MEMBER_TOOLS.includes('swarm_escalate'))
  assert(hiddenToolsFor('owner').includes('swarm_escalate'), 'the owner has no need to escalate to itself')
  assert(!hiddenToolsFor('worker').includes('swarm_escalate'))
  const definition = tools.get('swarm_escalate')
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(definition.parameters.required, ['missionId', 'body'])
  // A second registration in the same shape adds no second registry and does not mutate the shared one.
  const snapshot = [...SWARM_TOOLS]
  const second = definitions(f.runtime)
  assert.deepEqual([...second.keys()], [...SWARM_TOOLS])
  assert.deepEqual([...SWARM_TOOLS], snapshot)
})
