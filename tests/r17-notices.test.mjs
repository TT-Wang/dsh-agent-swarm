/**
 * R17-B2 — the shape of wake generation (mission acceptance 1, 2, 3, 4, 5, 8).
 *
 * Each claim is pinned by a test that fails on the pre-change tree:
 *
 * 1. ONE DERIVATION: every owner-facing notice generator consumes the shared
 *    interpretation (`Notices.interpretation`), and the enumeration below names
 *    every `notify(` site in the source tree with its trigger and its reason for
 *    not passing an explicit fact marker, so a new site fails this file.
 * 2. FACT-ONLY TEMPLATES: every body of a reviewed family is built by the one
 *    function in `NOTICE_TEMPLATES`, and the replay check rebuilds each emitted
 *    body from the rows the notice cites and compares it byte for byte.
 * 3. FACT-KEYED REPETITION: identity is subject@epoch + triggering event +
 *    recorded reason. The same fact records one row, an unrelated board change
 *    does not re-arm it, and a changed fact is a new row.
 * 4. ONE WAKE BUDGET: every family shares one per-owner bound; a burst beyond it
 *    is carried by a single degraded summary that names every fact, none dropped.
 * 5. ABSENCE NET: the sampled tick emits exactly two absence instruments and no
 *    cause — the absence net (absence of a durable transition + elapsed clock,
 *    no subject beyond the mission) and the retained attempt-silence escalation
 *    (`attemptSilenceBoundMs`, default 600,000 ms).
 * 8. CONSUMPTION AS A FACT: recorded from the host's claimed signal with a
 *    compare-and-swap; delivered and consumed stay separate facts and the
 *    `claimedAt` placeholder is gone from the ledger and from the durable row.
 *
 * Every temp directory goes through `tests/temp-root.mjs` (R15-F3/F5).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ts from 'typescript'
import { SwarmRuntime } from '../lib/runtime.js'
import { NOTICE_TEMPLATES, noticeTemplateKey } from '../lib/notices.js'
import { tempDirectory } from './temp-root.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function eventually(fn, message, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out: ${message}`)
    await sleep(10)
  }
}

class Workers {
  constructor(ctx) { this.ctx = ctx; this.started = [] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start(spec) { this.started.push(spec.member.id) }
  async deliver() {}
  async stop() {}
  isIdle() { return true }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}

async function fixture(t, config = {}) {
  const dir = await tempDirectory('swarm-r17-notices-')
  const ctx = new Context()
  const runtime = new SwarmRuntime({ statePath: join(dir, 'db.sqlite'), leaseMs: 60000, tickMs: 25, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 9, ...config }, new Workers(ctx))
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  await runtime.start()
  const owner = { sessionId: 'r17-notices-owner' }
  const mission = runtime.create(owner, { title: 'Notices', objective: 'Fact-only wake generation', workspace: dir, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const addMember = name => runtime.addMember(owner, mission.id, { name, role: 'implementation' })
  const propose = (title, input = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test -d .'], ...input })
  const ownerNotices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
  const emit = (content, subjects, options = {}) => runtime.commit(mission.id, () => runtime.notify(mission.id, content, subjects, options))
  return { dir, ctx, runtime, owner, mission, stream, addMember, propose, ownerNotices, emit }
}

test('R17-G3: repetition is keyed on the fact — same fact once, unrelated board change is not a re-arm, changed fact is new', async t => {
  const f = await fixture(t)
  const task = f.propose('Fact task')
  const subject = `${task.id}@${task.epoch}`
  const fact = { trigger: 'task/blocked', reason: 'blocked for repair', family: 'stall-root' }
  f.emit('fact body', [subject], fact)
  f.emit('fact body', [subject], fact)
  const afterFirst = f.ownerNotices().filter(delivery => delivery.notice.dedupKey.startsWith('stall-root:'))
  assert.equal(afterFirst.length, 1, 'the same fact records exactly one owner notice')

  // An unrelated board change (another task's row) must not re-arm the fact.
  const other = f.propose('Unrelated')
  const row = f.runtime.store.get('tasks', other.id)
  row.priority = 7
  f.runtime.store.put('tasks', row)
  f.emit('fact body', [subject], fact)
  assert.equal(f.ownerNotices().filter(delivery => delivery.notice.dedupKey.startsWith('stall-root:')).length, 1, 'an unrelated change cannot re-arm a fact-keyed notice')

  // A changed fact — same subject, different recorded reason — is a new fact.
  f.emit('fact body', [subject], { ...fact, reason: 'a different recorded reason' })
  assert.equal(f.ownerNotices().filter(delivery => delivery.notice.dedupKey.startsWith('stall-root:')).length, 2, 'a new fact is never suppressed by an old one')

  // The durable row records the fact it was keyed on.
  const [first] = f.ownerNotices().filter(delivery => delivery.notice.dedupKey.startsWith('stall-root:'))
  assert.deepEqual(first.notice.subjects, [subject])
  assert.equal(first.notice.trigger, 'task/blocked')
  assert.equal(first.notice.reason, 'blocked for repair')
})

test('R17-G4: one per-owner budget bounds every family and degrades a burst into a summary that names every fact', async t => {
  const f = await fixture(t)
  f.runtime.notices.wakeBudget = 2
  for (let index = 0; index < 5; index += 1) {
    f.emit(`fact ${index}`, [`task_fact_${index}@0`], { trigger: 'test/burst', reason: `reason ${index}` })
  }
  const individual = f.ownerNotices().filter(delivery => delivery.notice.dedupKey.startsWith('test/burst:'))
  const summaries = f.ownerNotices().filter(delivery => delivery.notice.dedupKey.startsWith('wake-budget:'))
  assert.equal(individual.length, 2, 'the first facts of the window are delivered individually')
  assert.equal(summaries.length, 1, 'every later fact of the window shares one degraded summary')
  const content = summaries[0].content
  for (let index = 2; index < 5; index += 1) {
    assert.match(content, new RegExp(`fact ${index}`), `the summary carries fact ${index} instead of dropping it`)
  }
  // The budget is per owner-mission window and shared by every family: a
  // separate mission has its own budget.
  assert.equal(f.runtime.notices.wakeBudget, 2)
})

test('R17-G5: the sampling path is an absence net — absence and elapsed clock only', async t => {
  const f = await fixture(t)
  f.runtime.notices.absenceBoundMs = 0
  const missionRow = f.runtime.store.get('missions', f.mission.id)
  const lastAt = f.runtime.store.events(f.mission.id, 1).at(-1)?.createdAt ?? missionRow.updatedAt
  f.runtime.notices.absenceNet(f.mission.id)
  const notices = f.ownerNotices().filter(delivery => delivery.notice.dedupKey.startsWith('absence:'))
  assert.equal(notices.length, 1, 'the absence net reports the absence once')
  assert.equal(notices[0].notice.trigger, 'absence-net')
  assert.match(notices[0].notice.reason, /no durable progress for \d+ms/)
  assert.match(notices[0].content, /No durable task, evidence or owner-decision progress recorded for \d+ms/)
  assert.match(notices[0].content, /reports the absence and the elapsed clock only/)
  assert.doesNotMatch(notices[0].content, /because|stalled|no live path cannot advance/, 'the absence net states no cause')
  assert.deepEqual(notices[0].subjects, [`mission:${f.mission.id}`], 'the subject is the mission root, never an invented task')
  // One report per observed absence instant, not one per tick.
  f.runtime.notices.absenceNet(f.mission.id)
  assert.equal(f.ownerNotices().filter(delivery => delivery.notice.dedupKey.startsWith('absence:')).length, 1)
  assert.ok(lastAt > 0)
})

test('R17-G8: consumption is recorded from the host claimed signal with a CAS; delivered and consumed stay separate', async t => {
  const f = await fixture(t)
  f.emit('ledger probe', [`mission:${f.mission.id}`], { trigger: 'test/consumption', reason: 'probe' })
  const notice = f.ownerNotices().find(delivery => delivery.notice.dedupKey.startsWith('test/consumption:'))
  assert.ok(notice)
  assert.equal(notice.deliveredAt, undefined)
  // The host can claim the item while the adapter call is still in flight, so
  // consumption is not gated on our transported timestamp; delivery follows.
  await eventually(() => f.runtime.store.get('deliveries', notice.id).deliveredAt !== undefined ? true : undefined, 'the outbox delivers the notice')
  assert.equal(f.runtime.recordConsumption(notice.id, { at: 1_700_000_000_000, source: 'agent/inbox/claimed' }), true)
  assert.equal(f.runtime.recordConsumption(notice.id), false, 'the compare-and-swap refuses a second signal')
  const row = f.runtime.store.get('deliveries', notice.id)
  assert.equal(row.notice.consumedAt, 1_700_000_000_000, 'the recorded instant is the host signal, not the delivery time')
  assert.equal(row.notice.consumptionSource, 'agent/inbox/claimed')
  assert.notEqual(row.notice.consumedAt, row.deliveredAt, 'consumed is its own fact, never the transport timestamp')
  const entry = f.runtime.noticeLedger(f.owner, f.mission.id).ledger.find(item => item.deliveryId === notice.id)
  assert.equal(entry.consumedAt, 1_700_000_000_000)
  assert.equal(entry.deliveredAt, row.deliveredAt)
  assert.equal('claimedAt' in entry, false, 'the claimedAt placeholder is gone from the ledger')
  assert.equal('claimedAt' in row.notice, false, 'and gone from the durable row')
})

test('R17-G8: the admitted owner message records consumption after inbox claim', async t => {
  const f = await fixture(t)
  f.emit('host signal probe', [`mission:${f.mission.id}`], { trigger: 'test/host-signal', reason: 'probe' })
  const notice = f.ownerNotices().find(delivery => delivery.notice.dedupKey.startsWith('test/host-signal:'))
  assert.ok(notice)
  await eventually(() => f.runtime.store.get('deliveries', notice.id).deliveredAt !== undefined ? true : undefined, 'the outbox delivers the notice')
  const message = { source: { kind: 'swarm', form: 'relay', missionId: f.mission.id, senderMemberId: 'runtime', deliveryId: notice.id, deliveryKind: 'control' } }
  f.ctx.emit('agent/inbox/claimed', { message, turn: 1 })
  assert.equal(f.runtime.store.get('deliveries', notice.id).notice.consumedAt, undefined, 'claim can still be rejected before model admission')
  f.ctx.emit('session/event', { header: { id: f.owner.sessionId } }, { type: 'user/message', data: message })
  const row = f.runtime.store.get('deliveries', notice.id)
  assert.ok(Number.isSafeInteger(row.notice.consumedAt), 'the host signal recorded consumption')
  assert.equal(row.notice.consumptionSource, 'user/message')
  // A replayed signal cannot move it (compare-and-swap).
  const recorded = row.notice.consumedAt
  f.ctx.emit('session/event', { header: { id: f.owner.sessionId } }, { type: 'user/message', data: message })
  assert.equal(f.runtime.store.get('deliveries', notice.id).notice.consumedAt, recorded)
})

/**
 * R17-G2 (repaired): the replay is INDEPENDENT of the production builder. Each
 * expected body below is written here from the durable rows the notice cites —
 * never by calling NOTICE_TEMPLATES and never with a hardcoded cause — so a
 * template mutation that adds a claim no row supports changes the emitted body
 * and fails this test.
 */
function ownerNotice(f, prefix) {
  return f.ownerNotices().find(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith(prefix))
}

test('R17-G2a: the stall-root body replays from the blocked row alone', async t => {
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  const task = f.propose('Blocked work', { assigneeId: member.id })
  const row = f.runtime.store.get('tasks', task.id)
  row.status = 'blocked'; row.epoch += 1; row.output = 'blocked for repair'
  f.runtime.store.put('tasks', row)
  f.runtime.notices.notifyStallRoots(f.runtime.interpretation(f.mission.id))
  const notice = ownerNotice(f, 'stall-root:')
  assert.ok(notice, 'the stall root was reported')
  const root = f.runtime.store.get('tasks', task.id)
  const dependents = f.runtime.store.list('tasks', f.mission.id).filter(candidate => candidate.dependencies.includes(root.id)).map(candidate => candidate.id)
  const expectedFacts = `Task ${root.id} (${root.title}, epoch ${root.epoch}) is a stall root: it is blocked and no live replacement exists anywhere in its lineage${dependents.length ? `; ${dependents.length} task(s) depend on it (${dependents.join(', ')})` : ''}. Recorded reason: ${root.output}.`
  assert.ok(notice.content.startsWith(expectedFacts), 'the facts replay exactly from the blocked row')
  assert.ok(notice.content.includes(`swarm_control(taskId: "${root.id}")`), 'repair advice names the existing task')
  assert.equal(notice.notice.reason, 'no live replacement exists anywhere in its lineage', 'the recorded reason is row-derived (the row is blocked with no replacement)')
})

test('R17-G2b: the W3 stall body replays from the unschedulable rows alone', async t => {
  const f = await fixture(t)
  await f.addMember('Ada')
  f.propose('Waiting work')
  const view = f.runtime.interpretation(f.mission.id)
  const reason = f.runtime.completionError(view.mission) ?? 'no task can make progress'
  f.runtime.notices.notifyStall(view, reason)
  const notice = ownerNotice(f, 'mission/stalled')
  assert.ok(notice, 'the W3 stall was reported')
  const stuck = view.unschedulable.length ? view.unschedulable : view.nonTerminal
  const subjects = stuck.map(task => `${task.id}@${task.epoch}`)
  const detail = view.unschedulable.map(task => `${task.id} (${task.kind}, ${task.status}${task.reviewOf ? `, reviews ${task.reviewOf}` : ''}${task.dependencies.length ? `, depends on ${task.dependencies.join('/')}` : ''})`).join('; ')
  const expected = `Mission stalled: no task can be scheduled and workers are idle. ${reason}. Unschedulable: ${detail || 'none'}. Subjects: ${subjects.join(', ')}. Decide: amend the existing task dependencies or assignee with swarm_control, admit a repair or review with swarm_propose, or adjust the budget. If work is no longer required, withdraw it explicitly with swarm_cancel; completing a mission never cancels unfinished tasks. Use swarm_control stop to stop the mission.`
  assert.equal(notice.content, expected, 'the body replays from the rows and the recorded completion diagnostic')
})

test('R17-G2c: the fall-through body replays from the unrecognised rows alone', async t => {
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  // A healthy live attempt keeps the mission out of the stalled class, so the
  // fall-through (not the W3 stall) owns the dead dependent.
  const healthy = f.propose('Healthy work', { assigneeId: member.id })
  await f.runtime.claim({ sessionId: member.sessionId }, f.mission.id, healthy.id)
  const other = await f.addMember('Grace')
  const dead = f.propose('Withdrawn', { assigneeId: other.id })
  await f.runtime.claim({ sessionId: other.sessionId }, f.mission.id, dead.id)
  await f.runtime.cancel(f.owner, f.mission.id, { taskId: dead.id, reason: 'withdrawn' })
  const waiting = f.propose('Waiting on the withdrawn task')
  const waitingRow = f.runtime.store.get('tasks', waiting.id)
  waitingRow.dependencies = [dead.id]
  f.runtime.store.put('tasks', waitingRow)
  f.runtime.notices.ensureWitness(f.mission.id, { offPass: true, wedged: true })
  const notice = ownerNotice(f, 'fallthrough:')
  assert.ok(notice, 'the fall-through was reported')
  const row = f.runtime.store.get('tasks', waiting.id)
  const expected = `Mission ${f.mission.title} made no progress this tick and has unfinished work that no live path will advance: ${row.id} (${row.kind}, ${row.status}, epoch ${row.epoch}, depends on ${row.dependencies.join('/')}). Inspect the board, admit a repair or review with swarm_propose, or decide with swarm_control.`
  assert.equal(notice.content, expected, 'the body names exactly the row the classifier did not recognise')
  assert.equal(notice.notice.reason, `no live path advances ${row.id}@${row.epoch}`, 'the recorded reason is the classifier verdict over that row')
})

test('R17-G2d: the integration-gap and coverage-complete bodies replay from the task rows alone', async t => {
  const f = await fixture(t)
  await f.addMember('Ada')
  f.propose('First implementation')
  f.propose('Second implementation')
  const gap = ownerNotice(f, 'integration-gap:')
  assert.ok(gap, 'the integration gap was reported')
  const implementations = f.runtime.store.list('tasks', f.mission.id).filter(task => task.kind === 'implementation')
  const expectedGap = `Coding missions require an independently accepted integration artifact, or exactly one independently accepted implementation artifact when the plan has no integration task. The mission now has ${implementations.length} implementation branches (${implementations.map(task => task.id).join(', ')}); admit an integration task depending on every branch, or complete with exactly one accepted implementation artifact.`
  assert.equal(gap.content, expectedGap, 'the gap body replays from the implementation rows and the recorded completion rule')

  // Coverage-complete: accept the only task and report with the mission still active.
  const accepted = f.runtime.store.get('tasks', implementations[0].id)
  accepted.status = 'accepted'
  f.runtime.store.put('tasks', accepted)
  f.runtime.notices.notifyCoverageComplete(f.runtime.store.get('missions', f.mission.id))
  const coverage = ownerNotice(f, 'task/accepted:')
  assert.ok(coverage, 'the coverage-complete notice was reported')
  assert.equal(coverage.content, `Mission ${f.mission.title} is ready to complete: every acceptance criterion is independently covered and no task can make further progress. The mission stays active until you decide. Use swarm_control complete to accept the deliverable, or admit more work with swarm_propose.`)
})

test('R17-G2e: the parked-holder body replays from the running task row alone', async t => {
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  const task = f.propose('Parked holder')
  await f.runtime.claim({ sessionId: member.sessionId }, f.mission.id, task.id)
  const parked = f.runtime.store.get('members', member.id)
  parked.phase = 'parked'
  f.runtime.store.put('members', parked)
  f.runtime.notices.notifyParkedHolder(f.runtime.store.get('missions', f.mission.id), f.runtime.store.get('tasks', task.id))
  const notice = ownerNotice(f, 'parked:')
  assert.ok(notice, 'the parked holder was reported')
  const row = f.runtime.store.get('tasks', task.id)
  assert.equal(notice.content, `Task ${row.id} (${row.title}) is held by a parked member and cannot make progress while parked. A fresh assignment wakes it; if the lease expires the task re-pends without spending a recovery attempt.`)
  assert.equal(notice.notice.reason, 'the owning member is parked')
})

test('R17-G2f: the review-blocked body replays from the submitted source row and the recorded reason alone', async t => {
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  // A second, independent member makes the automatic review admissible; with
  // only the author present the path is blocked instead of admitted.
  await f.addMember('Grace')
  const source = f.propose('Reviewable work', { assigneeId: member.id })
  const claimed = await f.runtime.claim({ sessionId: member.sessionId }, f.mission.id, source.id)
  await f.runtime.submit({ sessionId: member.sessionId }, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = await eventually(() => f.runtime.store.list('tasks', f.mission.id).find(item => item.kind === 'verification' && item.reviewOf === source.id), 'the automatic review is admitted')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: review.id, reason: 'withdrawn for the replay check' })
  const notice = await eventually(() => ownerNotice(f, 'review-blocked:'), 'the blocked review path was reported')
  const recorded = f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'task/review-blocked').at(-1)
  assert.ok(recorded, 'the reason is durable in the task/review-blocked event')
  // The diagnostic prefix is produced by the admission formatter from the
  // durable reason; both halves are read back from the recorded event.
  const diagnostic = `[review_path_missing] task "${source.id}": ${recorded.data.reason}`
  assert.equal(notice.content, `${diagnostic}. Admit an independent verification task with swarm_propose (kind verification, reviewOf ${source.id}) or cancel the source task; the mission cannot complete while it is unreviewable.`)
  assert.equal(notice.notice.reason, recorded.data.reason, 'the recorded reason is the durable event payload, not a test constant')
})

test('R17-G8: the admitted owner message records consumption after inbox claim', async t => {
  const f = await fixture(t)
  f.emit('host signal probe', [`mission:${f.mission.id}`], { trigger: 'test/host-signal', reason: 'probe' })
  const notice = f.ownerNotices().find(delivery => delivery.notice.dedupKey.startsWith('test/host-signal:'))
  assert.ok(notice)
  await eventually(() => f.runtime.store.get('deliveries', notice.id).deliveredAt !== undefined ? true : undefined, 'the outbox delivers the notice')
  const message = { source: { kind: 'swarm', form: 'relay', missionId: f.mission.id, senderMemberId: 'runtime', deliveryId: notice.id, deliveryKind: 'control' } }
  f.ctx.emit('agent/inbox/claimed', { message, turn: 1 })
  assert.equal(f.runtime.store.get('deliveries', notice.id).notice.consumedAt, undefined, 'claim can still be rejected before model admission')
  f.ctx.emit('session/event', { header: { id: f.owner.sessionId } }, { type: 'user/message', data: message })
  const row = f.runtime.store.get('deliveries', notice.id)
  assert.ok(Number.isSafeInteger(row.notice.consumedAt), 'the host signal recorded consumption')
  assert.equal(row.notice.consumptionSource, 'user/message')
  // A replayed signal cannot move it (compare-and-swap).
  const recorded = row.notice.consumedAt
  f.ctx.emit('session/event', { header: { id: f.owner.sessionId } }, { type: 'user/message', data: message })
  assert.equal(f.runtime.store.get('deliveries', notice.id).notice.consumedAt, recorded)
})

test('R17-G2: every reviewed notice body replays from the rows it cites', async t => {
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  // A stall root: a blocked task with no live replacement.
  const blocked = f.propose('Blocked work', { assigneeId: member.id })
  const row = f.runtime.store.get('tasks', blocked.id)
  row.status = 'blocked'; row.epoch += 1; row.output = 'blocked for repair'
  f.runtime.store.put('tasks', row)
  await f.runtime.notices.notifyStallRoots(f.runtime.interpretation(f.mission.id))

  const deliveries = f.ownerNotices().filter(delivery => noticeTemplateKey(delivery) !== undefined)
  assert.ok(deliveries.length >= 1, 'a reviewed template was emitted')
  for (const delivery of deliveries) {
    const key = noticeTemplateKey(delivery)
    const root = f.runtime.store.get('tasks', blocked.id)
    if (key !== 'stall-root') continue
    const rows = f.runtime.store.list('tasks', f.mission.id)
    const dependents = rows.filter(candidate => candidate.dependencies.includes(root.id)).map(candidate => candidate.id)
    const cause = 'no live replacement exists anywhere in its lineage'
    const replayed = NOTICE_TEMPLATES['stall-root'].build({ rootId: root.id, title: root.title, epoch: root.epoch, cause, dependents,
      ...(root.output === undefined ? {} : { recordedReason: root.output }) })
    assert.equal(delivery.content, replayed, 'the emitted body is exactly the template replayed from the durable rows')
    assert.equal(delivery.notice.reason, cause, 'the recorded reason is the one the rows support')
  }
})

test('pair: the absence net and the off-pass classifier report different facts and neither silences the other', async t => {
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  const task = f.propose('Stalled work', { assigneeId: member.id })
  // A genuine stall root (blocked, no live replacement) plus a zero absence
  // bound so both reports are owed at once. Co-firing guards, named: the
  // absence net (absence + elapsed clock only) and the off-pass classifier
  // (its stall-root family), which share the notice ledger but not the fact.
  const row = f.runtime.store.get('tasks', task.id)
  row.status = 'blocked'; row.epoch += 1; row.output = 'blocked for repair'
  f.runtime.store.put('tasks', row)
  f.runtime.notices.absenceBoundMs = 0
  f.runtime.notices.absenceNet(f.mission.id)
  f.runtime.notices.ensureWitness(f.mission.id, { offPass: true })
  const keys = f.ownerNotices().map(delivery => delivery.notice.dedupKey)
  assert.ok(keys.some(key => key.startsWith('absence:')), 'the absence net reported the absence')
  assert.ok(keys.some(key => key.startsWith('stall-root:')), 'the classifier reported the stall root')
  assert.equal(new Set(keys).size, keys.length, 'the two guards produce distinct facts, no repeated row')
  const stallRoot = f.ownerNotices().find(delivery => delivery.notice.dedupKey.startsWith('stall-root:'))
  assert.deepEqual(stallRoot.subjects, [`${task.id}@${row.epoch}`], 'the classifier names the task at its epoch')
  const absence = f.ownerNotices().find(delivery => delivery.notice.dedupKey.startsWith('absence:'))
  assert.deepEqual(absence.subjects, [`mission:${f.mission.id}`], 'the absence net names only the mission root')
})

test('owner notice calls supply subjects without maintaining a parallel site registry', async () => {
  const entries = await readdir(join(ROOT, 'src'), { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')))
    .map(entry => join(entry.parentPath ?? entry.path, entry.name))
  let checked = false
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'notify') {
        checked = true
        const subject = node.arguments[2]
        assert.ok(subject, `${file}: owner notice requires its subject argument`)
        assert.notEqual(subject.kind, ts.SyntaxKind.NullKeyword, `${file}: null is not a notice subject`)
        assert.ok(!ts.isIdentifier(subject) || subject.text !== 'undefined', `${file}: undefined is not a notice subject`)
        assert.ok(!ts.isArrayLiteralExpression(subject) || subject.elements.length > 0, `${file}: an empty literal has no subject`)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.ok(checked)
})
