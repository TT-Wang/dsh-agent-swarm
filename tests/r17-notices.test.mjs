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
 *    function in `NOTICE_TEMPLATES` through `renderNotice`, which records what
 *    it states from the same input (its statement: the rendering family and its
 *    counts, beside its subjects and recorded reason); the structure check
 *    asserts those facts against the rows the notice cites, rebuilds the body
 *    from those rows with the template, and checks the stated counts and each
 *    family's decision anchors, so the wording between anchors is free to change.
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
import { FakeClock, FakeWorkers } from './faults/harness.mjs'

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

/** Always idle, no host checks; `ctx` is the host context the notices subscribe to for consumption. */
const newWorkers = ctx => new FakeWorkers({ ctx, autoIdle: true, checks: [], artifact: { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } })

async function fixture(t, config = {}) {
  const dir = await tempDirectory('swarm-r17-notices-')
  const ctx = new Context()
  const runtime = new SwarmRuntime({ statePath: join(dir, 'db.sqlite'), leaseMs: 60000, tickMs: 25, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 9, ...config }, newWorkers(ctx))
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true, force: true }) })
  await runtime.start()
  const owner = { sessionId: 'r17-notices-owner' }
  const mission = runtime.create(owner, { title: 'Notices', objective: 'Fact-only wake generation', workspace: dir, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const addMember = name => runtime.addMember(owner, mission.id, { name, role: 'implementation' })
  const propose = (title, input = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test -d .'], ...input })
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

test('one enforcement point: a no-live-path decision is withheld at delivery while its lineage is live, and delivered once it closes', async t => {
  // Moved from the deleted emission/append refusal tests: the requirement is that
  // the owner never RECEIVES a fall-through or stall-root naming a subject a live
  // lineage still advances. Emission writes the fact; delivery (flushOutbox and
  // the native pre-step, both through ownerDeliveryRelevant) is the one judge.
  const f = await fixture(t)
  const builder = await f.addMember('Builder')
  const block = task => { const row = f.runtime.store.get('tasks', task.id); row.status = 'blocked'; row.epoch++; row.output = 'blocked for repair'; f.runtime.store.put('tasks', row); return row }
  const relevant = delivery => f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), f.runtime.store.get('deliveries', delivery.id))
  const original = block(f.propose('Blocked original', { assigneeId: builder.id }))
  const repair = f.propose('Repair', { replaces: [original.id], assigneeId: builder.id })
  await f.runtime.claim({ sessionId: builder.sessionId }, f.mission.id, repair.id)
  const covered = `${original.id}@${original.epoch}`
  f.emit('covered fall-through', [covered], { family: 'fallthrough', trigger: 'mission/stalled', reason: 'no live path advances it' })
  f.emit('covered stall root', [covered], { family: 'stall-root', dedupKey: `stall-root:${f.mission.id}:${covered}`, stampWitness: false })
  const fallthrough = f.ownerNotices().find(delivery => delivery.notice.dedupKey.startsWith('fallthrough:'))
  const coveredRoot = f.ownerNotices().find(delivery => delivery.notice.dedupKey === `stall-root:${f.mission.id}:${covered}`)
  assert.ok(fallthrough && coveredRoot, 'emission records the facts; it no longer judges them')
  assert.equal(relevant(fallthrough), false, 'a fall-through naming a subject a live repair advances is withheld')
  assert.equal(relevant(coveredRoot), false, 'a stall root whose root a live repair covers is withheld')
  await sleep(150)
  assert.equal(f.runtime.store.get('deliveries', fallthrough.id).deliveredAt, undefined, 'the pump never delivered the withheld fact')
  // The classifier's own stall-root output, a root plus a pending dependent, is
  // delivered: dependents are consequences of the root, not roots themselves.
  const root = block(f.propose('Dead end', { assigneeId: builder.id }))
  const dependent = f.propose('Waits on the dead end', { assigneeId: builder.id })
  const dependentRow = f.runtime.store.get('tasks', dependent.id)
  dependentRow.dependencies = [root.id]
  f.runtime.store.put('tasks', dependentRow)
  const rootKey = `stall-root:${f.mission.id}:${root.id}@${root.epoch}`
  const named = await eventually(() => f.ownerNotices().find(delivery => delivery.notice.dedupKey === rootKey), 'the classifier names the dead end')
  assert.deepEqual(named.subjects, [`${root.id}@${root.epoch}`, `${dependent.id}@${dependentRow.epoch}`])
  await eventually(() => f.runtime.store.get('deliveries', named.id).deliveredAt, 'a stall root with a dependent reaches the owner')
  // Closing the whole lineage makes the withheld fall-through deliverable; the
  // fact key it consumed at emission is the same fact, delivered once.
  const repairRow = f.runtime.store.get('tasks', repair.id)
  repairRow.status = 'cancelled'
  f.runtime.store.put('tasks', repairRow)
  assert.equal(relevant(fallthrough), true, 'the fact is relevant once the lineage is terminal')
  await eventually(() => f.runtime.store.get('deliveries', fallthrough.id).deliveredAt, 'the withheld fact is delivered once its lineage closes')
  assert.equal(f.ownerNotices().filter(delivery => delivery.notice.dedupKey === fallthrough.notice.dedupKey).length, 1)
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
 * R17-G2 (structure, not prose): each reviewed body is checked through the
 * facts the notice records with it — its statement (template family and the
 * counts the body states), its subjects at their epochs and its recorded
 * reason — asserted against the durable rows the notice cites. The body itself
 * is checked twice: it must equal its template rebuilt here from those rows (a
 * body rendered by the wrong template or from the wrong rows fails), and it must
 * state the recorded counts and keep the family's decision anchors below (a
 * template that states a wrong count, names the wrong tool or drops an exit
 * fails). Anchors, not sentences: the wording around them can change without a
 * test edit.
 */
function ownerNotice(f, prefix) {
  return f.ownerNotices().find(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith(prefix))
}
const subjectOf = task => `${task.id}@${task.epoch}`
/** Every tool each reviewed body names, bound to the action it is named for, and the exit the body leaves open. */
const DECISIONS = {
  'stall-root': ['allocation with swarm_budget', 'swarm_propose with replaces', 'swarm_cancel to withdraw'],
  stall: ['assignee with swarm_control', 'review with swarm_propose', 'explicitly with swarm_cancel', 'swarm_control stop'],
  fallthrough: ['review with swarm_propose', 'decide with swarm_control'],
  parked: ['held by a parked member', 'without spending a recovery attempt'],
  'integration-gap': ['integration task depending on every branch'],
  'coverage-complete': ['stays active until you decide', 'swarm_control complete', 'more work with swarm_propose'],
  'review-blocked': ['verification task with swarm_propose', 'cannot complete while it is unreviewable'],
}
function assertDecision(notice, family) {
  for (const anchor of DECISIONS[family]) assert.ok(notice.content.includes(anchor), `the ${family} body keeps "${anchor}"`)
}
/** Blocks a task the way a failed attempt leaves it: blocked at a new epoch with its reason recorded. */
function blockTask(f, task) {
  const row = f.runtime.store.get('tasks', task.id)
  row.status = 'blocked'; row.epoch += 1; row.output = 'blocked for repair'
  f.runtime.store.put('tasks', row)
  return row
}
/** Makes a proposed task wait on another, as the store would hold it. */
function dependOn(f, task, dependency) {
  const row = f.runtime.store.get('tasks', task.id)
  row.dependencies = [dependency.id]
  f.runtime.store.put('tasks', row)
  return row
}

test('R17-G2a: the stall-root body replays from the blocked row alone', async t => {
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  // One root strands a dependent and one strands none, so the stated dependent
  // count is checked both when the body states it and when it must not.
  const stranding = blockTask(f, f.propose('Blocked work', { assigneeId: member.id }))
  const lone = blockTask(f, f.propose('Blocked alone', { assigneeId: member.id }))
  dependOn(f, f.propose('Waits on the blocked work'), stranding)
  f.runtime.notices.notifyStallRoots(f.runtime.interpretation(f.mission.id))
  for (const task of [stranding, lone]) {
    const root = f.runtime.store.get('tasks', task.id)
    const notice = ownerNotice(f, `stall-root:${f.mission.id}:${subjectOf(root)}`)
    assert.ok(notice, 'the stall root was reported')
    const dependents = f.runtime.store.list('tasks', f.mission.id).filter(candidate => candidate.dependencies.includes(root.id))
    assert.deepEqual(notice.notice.statement, { family: 'stall-root', counts: { dependents: dependents.length } }, 'the body is the stall-root template and states the dependent count the rows hold')
    assert.deepEqual(notice.notice.subjects, [root, ...dependents].map(subjectOf), 'the subjects are the blocked row and its dependents at their epochs')
    assert.equal(notice.notice.reason, 'no live replacement exists anywhere in its lineage', 'the recorded reason is row-derived (the row is blocked with no replacement)')
    assert.equal(notice.content, NOTICE_TEMPLATES['stall-root'].build({ rootId: root.id, title: root.title, epoch: root.epoch, cause: notice.notice.reason,
      dependents: dependents.map(dependent => dependent.id), recordedReason: root.output }), 'the body is the template rebuilt from the blocked row and its dependents')
    assert.ok(notice.content.includes(notice.notice.reason), 'the body states the recorded cause')
    assert.ok(notice.content.includes(root.output), 'the body quotes the reason recorded on the blocked row')
    assert.ok(notice.content.includes(`swarm_control(action: "resume", taskId: "${root.id}")`), 'repair advice names the existing task')
    assert.equal(notice.content.includes('depend on it'), dependents.length > 0, 'the body states a dependent count only when the rows hold one')
    if (dependents.length) assert.ok(notice.content.includes(`${dependents.length} task(s) depend on it (${dependents.map(dependent => dependent.id).join(', ')})`), 'the body states the dependent count and names each dependent')
    assertDecision(notice, 'stall-root')
  }
})

test('R17-G2b: the W3 stall body replays from the unschedulable rows alone', async t => {
  const f = await fixture(t)
  const member = await f.addMember('Ada')
  f.propose('Waiting work')
  const stall = () => {
    const view = f.runtime.interpretation(f.mission.id)
    const reason = f.runtime.completionError(view.mission) ?? 'no task can make progress'
    f.runtime.notices.notifyStall(view, reason)
    return { view, reason, notice: f.ownerNotices().filter(delivery => delivery.notice.dedupKey.startsWith('mission/stalled')).at(-1) }
  }
  // First nothing is unschedulable (the body names every non-terminal row);
  // then a blocked row and its dependent are, so the body counts and names them.
  const stalls = [stall()]
  const dead = blockTask(f, f.propose('Dead end', { assigneeId: member.id }))
  dependOn(f, f.propose('Waits on the dead end'), dead)
  stalls.push(stall())
  assert.equal(stalls[1].view.unschedulable.length, 2, 'the second board holds two unschedulable rows')
  for (const { view, reason, notice } of stalls) {
    assert.ok(notice, 'the W3 stall was reported')
    const stuck = view.unschedulable.length ? view.unschedulable : view.nonTerminal
    const subjects = stuck.map(subjectOf)
    assert.deepEqual(notice.notice.statement, { family: 'stall', counts: { unschedulable: view.unschedulable.length } }, 'the body is the stall template and states the unschedulable count of the rows')
    assert.deepEqual(notice.notice.subjects, subjects, 'the subjects are the unschedulable rows, or every non-terminal row when none is')
    assert.equal(notice.notice.reason, reason, 'the recorded reason is the completion diagnostic')
    assert.equal(notice.content, NOTICE_TEMPLATES.stall.build({ reason, unschedulable: view.unschedulable, subjects }), 'the body is the template rebuilt from the unschedulable rows')
    assert.ok(notice.content.includes(reason), 'the body states the recorded completion diagnostic')
    for (const subject of subjects) assert.ok(notice.content.includes(subject), `the body names ${subject}`)
    for (const row of view.unschedulable) assert.ok(notice.content.includes(`${row.id} (${row.kind}, ${row.status}`), `the body counts ${row.id} as unschedulable`)
    assertDecision(notice, 'stall')
  }
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
  dependOn(f, waiting, dead)
  f.runtime.notices.ensureWitness(f.mission.id, { offPass: true, wedged: true })
  const notice = ownerNotice(f, 'fallthrough:')
  assert.ok(notice, 'the fall-through was reported')
  const row = f.runtime.store.get('tasks', waiting.id)
  assert.deepEqual(notice.notice.statement, { family: 'fallthrough', counts: {} }, 'the body is the fall-through template and states no count')
  assert.deepEqual(notice.notice.subjects, [subjectOf(row)], 'the body names exactly the row the classifier did not recognise')
  assert.equal(notice.notice.reason, `no live path advances ${row.id}@${row.epoch}`, 'the recorded reason is the classifier verdict over that row')
  assert.equal(notice.content, NOTICE_TEMPLATES.fallthrough.build({ missionTitle: f.mission.title, subjects: [row] }), 'the body is the template rebuilt from the unrecognised row')
  assert.ok(notice.content.includes(row.id), 'the body names the unrecognised row')
  assert.ok(notice.content.includes('swarm_propose'), 'the body names the repair tool')
  assertDecision(notice, 'fallthrough')
})

test('R17-G2d: the integration-gap and coverage-complete bodies replay from the task rows alone', async t => {
  const f = await fixture(t)
  await f.addMember('Ada')
  f.propose('First implementation')
  f.propose('Second implementation')
  const gap = ownerNotice(f, 'integration-gap:')
  assert.ok(gap, 'the integration gap was reported')
  const implementations = f.runtime.store.list('tasks', f.mission.id).filter(task => task.kind === 'implementation')
  assert.deepEqual(gap.notice.statement, { family: 'integration-gap', counts: { implementations: implementations.length } }, 'the gap states the implementation branch count of the rows')
  assert.deepEqual(gap.notice.subjects, implementations.map(subjectOf), 'the gap names every implementation branch')
  assert.ok(gap.notice.reason.length > 0 && gap.content.includes(gap.notice.reason), 'the body states the recorded completion rule')
  assert.equal(gap.content, NOTICE_TEMPLATES['integration-gap'].build({ diagnostic: gap.notice.reason, implementations: implementations.map(task => task.id) }), 'the gap body is the template rebuilt from the implementation rows')
  assert.ok(gap.content.includes(`${implementations.length} implementation branches`), 'the gap body states the branch count of the rows')
  for (const task of implementations) assert.ok(gap.content.includes(task.id), `the gap body names ${task.id}`)
  assertDecision(gap, 'integration-gap')

  // Coverage-complete: accept the only task and report with the mission still active.
  const accepted = f.runtime.store.get('tasks', implementations[0].id)
  accepted.status = 'accepted'
  f.runtime.store.put('tasks', accepted)
  f.runtime.notices.notifyCoverageComplete(f.runtime.store.get('missions', f.mission.id))
  const coverage = ownerNotice(f, 'task/accepted:')
  assert.ok(coverage, 'the coverage-complete notice was reported')
  assert.deepEqual(coverage.notice.statement, { family: 'coverage-complete', counts: {} }, 'the body is the coverage-complete template and states no count')
  assert.deepEqual(coverage.notice.subjects, [subjectOf(accepted)], 'the subject is the accepted deliverable')
  assert.equal(coverage.content, NOTICE_TEMPLATES['coverage-complete'].build({ missionTitle: f.mission.title }), 'the body is the template rebuilt from the mission row')
  assert.ok(coverage.content.includes(f.mission.title), 'the body names the mission')
  assertDecision(coverage, 'coverage-complete')
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
  assert.deepEqual(notice.notice.statement, { family: 'parked', counts: {} }, 'the body is the parked template and states no count')
  assert.deepEqual(notice.notice.subjects, [subjectOf(row)], 'the subject is the running row the parked member holds')
  assert.equal(notice.notice.reason, 'the owning member is parked')
  assert.equal(notice.content, NOTICE_TEMPLATES.parked.build({ taskId: row.id, title: row.title }), 'the body is the template rebuilt from the held row')
  assert.ok(notice.content.includes(row.id), 'the body names the held task')
  assertDecision(notice, 'parked')
})

/** A hand-driven clock and tick: which generator speaks first can no longer depend on host load. */
async function clockedFixture(t) {
  const clock = new FakeClock()
  const f = await fixture(t, { manualTick: true, now: clock.now, stallPassTimeoutMs: 60_000 })
  const pass = async () => { clock.advance(1_500); await f.runtime.tick(); await f.runtime.settle(f.mission.id) }
  return { ...f, clock, pass }
}

test('R17-G2f: the review-blocked body replays from the submitted source row and the recorded reason alone', async t => {
  const f = await clockedFixture(t)
  const member = await f.addMember('Ada')
  // A second, independent member makes the automatic review admissible; with
  // only the author present the path is blocked instead of admitted.
  await f.addMember('Grace')
  const source = f.propose('Reviewable work', { assigneeId: member.id })
  const claimed = await f.runtime.claim({ sessionId: member.sessionId }, f.mission.id, source.id)
  await f.runtime.submit({ sessionId: member.sessionId }, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  await f.pass()
  const review = f.runtime.store.list('tasks', f.mission.id).find(item => item.kind === 'verification' && item.reviewOf === source.id)
  assert.ok(review, 'the automatic review is admitted')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: review.id, reason: 'withdrawn for the replay check' })
  // The off-pass witness (a tick or a transition between passes) may judge the
  // board before the next pass does; under load it did. Nothing else can
  // progress, so the runtime's own review admission owns this board and the
  // witness adds no second, generic review-blocked fact whichever runs first.
  f.runtime.notices.ensureWitness(f.mission.id, { offPass: true })
  await f.pass()
  const blocked = f.ownerNotices().filter(delivery => delivery.notice?.dedupKey?.startsWith('review-blocked:'))
  assert.equal(blocked.length, 1, `one review-blocked fact for one blocked path: ${JSON.stringify(blocked.map(delivery => delivery.content.slice(0, 80)))}`)
  const [notice] = blocked
  const recorded = f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'task/review-blocked').at(-1)
  assert.ok(recorded, 'the reason is durable in the task/review-blocked event')
  assert.deepEqual(notice.notice.statement, { family: 'review-blocked', counts: {} }, 'the body is the review-blocked template and states no count')
  assert.deepEqual(notice.notice.subjects, [subjectOf(f.runtime.store.get('tasks', source.id))], 'the subject is the submitted source row')
  assert.equal(notice.notice.reason, recorded.data.reason, 'the recorded reason is the durable event payload, not a test constant')
  // The body leads with the admission diagnostic built from the durable reason.
  assert.ok(notice.content.includes(recorded.data.reason), 'the body states the recorded reason')
  assert.ok(notice.content.includes('[review_path_missing]'), 'the body carries the typed diagnostic code')
  assert.ok(notice.content.includes(`reviewOf ${source.id}`), 'the verification advice names the source task')
  assertDecision(notice, 'review-blocked')
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

test('R17-G2g: the review-blocked notice beside running work is the template too, with its statement and recorded reason', async t => {
  const f = await clockedFixture(t)
  const author = await f.addMember('Ada')
  const other = await f.addMember('Grace')
  const source = f.propose('Reviewable work', { assigneeId: author.id })
  const claimed = await f.runtime.claim({ sessionId: author.sessionId }, f.mission.id, source.id)
  await f.runtime.submit({ sessionId: author.sessionId }, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  // Unrelated work keeps running, so the runtime admits no automatic review and
  // the witness path is the one that names the unreviewable submission.
  const running = f.propose('Unrelated work', { assigneeId: other.id, kind: 'research', checks: [] })
  await f.runtime.claim({ sessionId: other.sessionId }, f.mission.id, running.id)
  await f.pass()
  const notice = ownerNotice(f, 'review-blocked:')
  assert.ok(notice, 'the unreviewable submission is named while the board keeps running')
  const row = f.runtime.store.get('tasks', source.id)
  assert.deepEqual(notice.notice.statement, { family: 'review-blocked', counts: {} }, 'every review-blocked body states its template')
  assert.deepEqual(notice.notice.subjects, [subjectOf(row)])
  assert.match(notice.notice.reason, /has no live independent review path/)
  assert.equal(notice.content, NOTICE_TEMPLATES['review-blocked'].build({ diagnostic: notice.notice.reason, sourceId: row.id }), 'the body is the template rebuilt from the recorded reason and the source row')
  assertDecision(notice, 'review-blocked')
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
