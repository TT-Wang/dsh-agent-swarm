/**
 * R14-F2 (b)/(c)/(d): the board's stall roots are named once per root@epoch
 * whether or not a healthy sibling is running, and the unnamed fall-through is
 * replaced by a silent-while-waiting, named-otherwise escalation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { waitsLegitimately } from '../lib/notices.js'
import { wakePrecision } from './instruments.mjs'
import { tempDirectory } from './temp-root.mjs'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(read, message, timeoutMs = 5000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(5)) { const value = read(); if (value) return value }
  assert.fail(`timed out: ${message}`)
}
class Workers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return true }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}

async function fixture(t, config = {}) {
  const directory = await tempDirectory('swarm-stall-roots-')
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60000, tickMs: 25, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 9, ...config }, new Workers())
  await runtime.start()
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'stall-owner' }
  const mission = runtime.create(owner, { title: 'Stall roots', objective: 'Name the root', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const actor = { sessionId: member.sessionId }
  const propose = (title, input = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: member.id, ...input })
  const block = task => { const row = runtime.store.get('tasks', task.id); row.status = 'blocked'; row.epoch++; row.output = 'blocked for repair'; runtime.store.put('tasks', row); return runtime.store.get('tasks', task.id) }
  const cancel = task => { const row = runtime.store.get('tasks', task.id); row.status = 'cancelled'; runtime.store.put('tasks', row) }
  const notices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
  const stallRoots = () => notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('stall-root:'))
  const fallthroughs = () => notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('fallthrough:'))
  return { directory, runtime, owner, mission, member, actor, propose, block, cancel, notices, stallRoots, fallthroughs }
}

test('R14-F2(b): a blocked root is named once per root@epoch while a healthy sibling runs', async t => {
  const f = await fixture(t)
  const sibling = f.propose('Healthy sibling')
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  // The dependent is admitted before the root dies (admission refuses a
  // dependency on a blocked task), then the durable edge is written directly.
  const dependent = f.propose('Depends on the root')
  const root = f.block(f.propose('Dead end'))
  const dependentRow = f.runtime.store.get('tasks', dependent.id)
  dependentRow.dependencies = [root.id]
  f.runtime.store.put('tasks', dependentRow)
  await sleep(200)
  const roots = f.stallRoots()
  assert.equal(roots.length, 1, `exactly one stall-root notice: ${JSON.stringify(roots.map(delivery => delivery.notice.dedupKey))}`)
  const notice = roots[0]
  assert.equal(notice.notice.dedupKey, `stall-root:${f.mission.id}:${root.id}@${root.epoch}`)
  assert.match(notice.content, new RegExp(root.id), 'the root is named')
  assert.match(notice.content, new RegExp(dependent.id), 'the dependent is named')
  assert.ok(Array.isArray(notice.subjects) && notice.subjects.includes(`${root.id}@${root.epoch}`), `the notice carries the root subject: ${JSON.stringify(notice.subjects)}`)
  assert.ok(notice.subjects.includes(`${dependent.id}@${dependent.epoch}`), 'the dependent subject is carried too')
  const event = f.runtime.store.events(f.mission.id, 200).filter(item => item.type === 'mission/stalled' && item.data?.cause === 'stall-root').at(-1)
  assert.ok(event, 'the stall root is durable with its own cause')
  assert.equal(event.data.taskId, root.id)
  await sleep(150)
  assert.equal(f.stallRoots().length, 1, 'the same root@epoch never repeats')
})

test('R14-F2(b): a blocked task with a live replacement is lineage, not a root', async t => {
  const f = await fixture(t)
  const source = f.block(f.propose('Superseded'))
  const replacement = f.propose('Live replacement', { replaces: [source.id] })
  await f.runtime.claim(f.actor, f.mission.id, replacement.id)
  await sleep(200)
  assert.equal(f.stallRoots().length, 0, 'a live replacement covers its lineage')
})

test('R14-F2(b/d): a stop awaited past the declared bound is a stall root', async t => {
  const f = await fixture(t, { stallPassTimeoutMs: 40 })
  const root = f.propose('Stuck stop')
  const row = f.runtime.store.get('tasks', root.id)
  row.status = 'blocked'; row.epoch++
  row.resumeAfterStop = { epoch: row.epoch, reason: 'handoff', at: Date.now() - 5000 }
  f.runtime.store.put('tasks', row)
  await sleep(150)
  const roots = f.stallRoots()
  assert.equal(roots.length, 1, 'an expired stop is a root')
  assert.match(roots[0].content, /awaited/, `the notice names the awaited stop: ${roots[0].content}`)
})

test('R14-F2(c): the runtime stays silent while every unfinished task is legitimately waiting', async t => {
  const f = await fixture(t)
  const running = f.propose('Running')
  await f.runtime.claim(f.actor, f.mission.id, running.id)
  f.propose('Waiting on the running task', { dependencies: [running.id] })
  await sleep(200)
  assert.equal(f.fallthroughs().length, 0, 'a live dependency is legitimate waiting, not silence')
})

test('R14-F2(c): a pending task whose predecessor is dead escalates and is named', async t => {
  const f = await fixture(t)
  // A healthy sibling keeps the board out of the W3 stall class, so the
  // fall-through escalation itself is what must name the dead-ended task.
  const sibling = f.propose('Healthy sibling')
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  const dead = f.propose('Dead predecessor')
  const waiting = f.propose('Waiting on the dead one')
  const waitingRow = f.runtime.store.get('tasks', waiting.id)
  waitingRow.dependencies = [dead.id]
  f.runtime.store.put('tasks', waitingRow)
  f.cancel(dead)
  await sleep(200)
  const fallthroughs = f.fallthroughs()
  assert.equal(fallthroughs.length, 1, 'the unnamed fallback is replaced by a named escalation')
  const notice = fallthroughs[0]
  assert.match(notice.content, new RegExp(waiting.id), 'the unrecognised task is named')
  assert.ok(notice.subjects.includes(`${waiting.id}@${waiting.epoch}`), `the notice carries subjects: ${JSON.stringify(notice.subjects)}`)
  assert.ok(!notice.subjects.some(subject => subject.startsWith(`${sibling.id}@`)), 'the healthy sibling is not named')
  assert.doesNotMatch(notice.content, /made no progress this tick and no task is dispatchable/, 'the old unnamed message is gone')
})

test('R14-F2v D1: the stall-root event carries the unschedulable shape later readers use', async t => {
  const f = await fixture(t)
  const sibling = f.propose('Healthy sibling')
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  const root = f.block(f.propose('Dead end'))
  await sleep(200)
  const events = f.runtime.store.events(f.mission.id, 200).filter(event => event.type === 'mission/stalled')
  const latest = events.at(-1)
  assert.equal(latest.data.cause, 'stall-root', 'the latest stall event is the stall root')
  assert.ok(Array.isArray(latest.data.unschedulable), `the latest mission/stalled event keeps the unschedulable list: ${JSON.stringify(latest.data)}`)
  assert.ok(latest.data.unschedulable.includes(root.id), 'the root is in the unschedulable list')
})

test('R14-F2v D2: a stop with no recorded start is a root, never silence', async t => {
  const f = await fixture(t)
  const sibling = f.propose('Healthy sibling')
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  const stuck = f.propose('Untimestamped stop')
  const row = f.runtime.store.get('tasks', stuck.id)
  row.status = 'blocked'; row.epoch++
  row.resumeAfterStop = { epoch: row.epoch, reason: 'handoff' }
  f.runtime.store.put('tasks', row)
  await sleep(200)
  const roots = f.stallRoots()
  assert.equal(roots.length, 1, `an untimestamped stop escalates instead of staying silent: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  assert.equal(f.fallthroughs().length, 0, `the recovered root waits for its selected member without a duplicate fallthrough: ${JSON.stringify(f.fallthroughs().map(delivery => ({ subjects: delivery.subjects, content: delivery.content })))}`)
  assert.deepEqual(roots[0].subjects, [`${stuck.id}@${row.epoch}`], 'the original stop is named exactly once, without attributing its healthy sibling')
  assert.match(roots[0].content, /no recorded start/, `the notice states why the bound cannot hold: ${roots[0].content}`)
})


test('pending stop waits remain bounded and use the same owner scope as dispatch fencing', t => {
  const now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const rt = { stallPassTimeoutMs: 100, config: { tickMs: 25 }, unfinishedDependencies: () => [] }
  const pending = { id: 'next', missionId: 'mission', epoch: 0, status: 'pending', assigneeId: 'owner', dependencies: [] }
  const stop = (id, memberId, at, epoch = 1) => ({ id, missionId: 'mission', status: 'cancelled', epoch: 1,
    resumeAfterStop: { epoch, memberId, reason: 'handoff', ...(at === undefined ? {} : { at }) } })
  const bounded = stop('old-work', 'owner', now - 50)
  assert.equal(waitsLegitimately(rt, pending, [pending, bounded]), true, 'the assigned member will be released by this bounded stop')
  assert.equal(waitsLegitimately(rt, pending, [pending, stop('unknown-owner', undefined, now - 50)]), true, 'an ambiguous owner scan reserves every member')
  for (const expired of [stop('expired', 'owner', now - 101), stop('untimestamped', 'owner', undefined), stop('unknown-expired', undefined, now - 101)]) {
    assert.equal(waitsLegitimately(rt, pending, [pending, expired]), false, 'an unbounded matching stop must remain actionable')
    assert.equal(waitsLegitimately(rt, pending, [pending, bounded, expired]), false, 'one healthy stop cannot hide another matching stop past its bound')
  }
  assert.equal(waitsLegitimately(rt, pending, [pending, stop('unrelated', 'other', now - 50)]), false, 'another member stop is not this task path')
  assert.equal(waitsLegitimately(rt, pending, [pending, stop('stale', 'owner', now - 50, 0)]), false, 'a stale stop epoch cannot justify waiting')
  const running = { id: 'active-work', missionId: 'mission', status: 'running', epoch: 1, dependencies: [], attempt: { ownerId: 'owner', leaseUntil: now + 100 } }
  assert.equal(waitsLegitimately(rt, pending, [pending, running]), true, 'the selected member is busy under a live lease')
  assert.equal(waitsLegitimately(rt, pending, [pending, { ...running, attempt: { ...running.attempt, leaseUntil: now - 1 } }]), false, 'an expired lease cannot hide an overdue assignment')
  assert.equal(waitsLegitimately(rt, { ...pending, dependencies: ['missing'] }, [pending, running]), false, 'a busy owner does not repair a missing prerequisite')
  assert.equal(waitsLegitimately(rt, { ...pending, dependencies: ['missing'] }, [pending, bounded]), false, 'a bounded stop does not repair a missing prerequisite')
  assert.equal(waitsLegitimately(rt, { ...pending, reviewOf: 'missing' }, [pending, bounded]), false, 'a bounded stop does not repair a missing review source')
  const accepted = { id: 'accepted', missionId: 'mission', status: 'accepted', epoch: 1, dependencies: [] }
  assert.equal(waitsLegitimately(rt, { ...pending, dependencies: [accepted.id] }, [pending, accepted, running]), true, 'accepted prerequisites remain ready while the member is busy')
})

test('a real review rejection names its stall root exactly once, with exactly one stall-root event', async t => {
  // 2026-09-18 review: after a real rejection the emission-time refusal refused
  // every stall-root notice (the rejecting review, a blocked verdict record, is
  // a dependent that is not itself a root), while the stall event was written on
  // every tick: ~62 events and 0 deliveries. The event now exists only with its
  // delivery row, and delivery judges the root the key names, not its dependents.
  const f = await fixture(t, { tickMs: 10 })
  const reviewer = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Reviewer', role: 'verification' })
  const source = f.propose('Rejected implementation')
  const claimed = await f.runtime.claim(f.actor, f.mission.id, source.id)
  await f.runtime.submit(f.actor, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.runtime.store.get('tasks', source.id).workstreamId,
    title: 'Review', objective: 'Independent review', kind: 'verification', reviewOf: source.id, scope: ['src/'], acceptance: ['works'], assigneeId: reviewer.id })
  const reviewing = await f.runtime.claim({ sessionId: reviewer.sessionId }, f.mission.id, review.id)
  await f.runtime.verify({ sessionId: reviewer.sessionId }, f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'reject', reason: 'The candidate does not work' })
  const rejected = f.runtime.store.get('tasks', source.id)
  assert.equal(rejected.status, 'blocked', 'the reviewed source is blocked by the rejection')
  await sleep(1500)
  const key = `stall-root:${f.mission.id}:${source.id}@${rejected.epoch}`
  const deliveries = f.stallRoots().filter(delivery => delivery.notice.dedupKey === key)
  const events = f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'mission/stalled' && event.data?.cause === 'stall-root')
  const transitionSite = f.notices().filter(delivery => !delivery.notice?.dedupKey?.startsWith('stall-root:') && delivery.subjects?.includes(`${source.id}@${rejected.epoch}`))
  t.diagnostic(`stall-root events ${events.length}; owner deliveries naming the rejected source: stall-root ${deliveries.length}, transition-site ${transitionSite.length} (${transitionSite.map(delivery => delivery.notice?.dedupKey).join(', ')})`)
  assert.equal(deliveries.length, 1, `exactly one stall-root delivery: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  assert.equal(events.length, 1, `exactly one stall-root event, not one per tick: ${events.length}`)
  assert.equal(events[0].data.taskId, source.id)
  // The root's obligation reaches the owner, not only the ledger: through the
  // rejection decision the stall-root row is recorded against (one wake, not two).
  const cover = f.runtime.store.get('deliveries', deliveries[0].notice.coveredBy)
  assert.equal(cover?.notice?.trigger, 'task/rejected', 'the stall root is recorded against the verify-site rejection decision')
  assert.ok(cover.deliveredAt !== undefined, 'the stall-root decision reaches the owner, not only the ledger')
})

test('one rejection is one owner wake for its root: the stall root is recorded against the rejection decision', async t => {
  // 5347f5b: one rejection delivered three owner notices within ~10 ms that all
  // asked for the same repair (the verify-site decision, the W3 board stall and
  // the stall root), and the stall root spent a wake-budget slot of its own.
  // Decision: the stall root stays the durable fact (row, event, reminders) but is
  // not a second wake when the verify site already decided this subject@epoch.
  const f = await fixture(t, { tickMs: 10 })
  // Exactly the decision and the board stall fit; a third wake would be summarized.
  f.runtime.notices.wakeBudget = 2
  const reviewer = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Reviewer', role: 'verification' })
  const source = f.propose('Rejected implementation')
  const claimed = await f.runtime.claim(f.actor, f.mission.id, source.id)
  await f.runtime.submit(f.actor, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.runtime.store.get('tasks', source.id).workstreamId,
    title: 'Review', objective: 'Independent review', kind: 'verification', reviewOf: source.id, scope: ['src/'], acceptance: ['works'], assigneeId: reviewer.id })
  const reviewing = await f.runtime.claim({ sessionId: reviewer.sessionId }, f.mission.id, review.id)
  await f.runtime.verify({ sessionId: reviewer.sessionId }, f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'reject', reason: 'The candidate does not work' })
  const stallRootEvents = () => f.runtime.store.events(f.mission.id, 500).filter(event => event.type === 'mission/stalled' && event.data?.cause === 'stall-root')
  await eventually(() => stallRootEvents().length > 0, 'the stall-root fact is recorded')
  await sleep(500)
  const delivered = f.notices().filter(delivery => delivery.deliveredAt !== undefined)
  const families = delivered.map(delivery => delivery.notice?.dedupKey?.split(':')[0])
  t.diagnostic(`owner notices delivered for one rejection: ${delivered.length} (${families.join(', ')})`)
  assert.equal(delivered.length, 2, `two owner wakes per rejection, the decision and the board stall: ${families.join(', ')}`)
  assert.deepEqual(f.notices().filter(delivery => delivery.notice?.dedupKey?.startsWith('wake-budget:')).map(delivery => delivery.notice.aggregatedFacts?.map(part => part.dedupKey)), [],
    'the stall root spends no wake-budget slot')
  const decision = f.notices().find(delivery => delivery.notice?.trigger === 'task/rejected')
  assert.ok(decision?.deliveredAt !== undefined, 'the verify-site rejection decision reaches the owner under its recorded trigger')
  assert.deepEqual(delivered.map(delivery => delivery.notice.trigger).sort(), ['mission/stalled', 'task/rejected'])
  const [root, ...extra] = f.stallRoots()
  assert.deepEqual(extra, [], 'one stall-root row')
  assert.equal(root.notice.dedupKey, `stall-root:${f.mission.id}:${source.id}@${f.runtime.store.get('tasks', source.id).epoch}`)
  assert.equal(root.notice.coveredBy, decision.id, 'the stall root is recorded against the rejection decision')
  assert.equal(root.deliveredAt, undefined, 'the stall root is not a second wake')
  assert.equal(stallRootEvents().length, 1, 'the stall root stays a durable fact')
  // The covered row is no notice on any owner instrument: not a wake or false
  // wake in the precision projection, not queued, not the last notice.
  const precision = wakePrecision(f.runtime, f.mission.id)
  assert.equal(precision.decisions.byFamily['stall-root'], undefined, `the covered row is no wake: ${JSON.stringify(precision.decisions.byFamily)}`)
  assert.equal(precision.falseWakes.total, 0, `its listed rejecting review is no false wake: ${JSON.stringify(precision.falseWakes)}`)
  const ledger = f.runtime.noticeLedger(f.owner, f.mission.id).ledger
  assert.equal(ledger.some(entry => entry.deliveryId === root.id), false, 'the covered row is not a ledger entry')
  assert.deepEqual(ledger.filter(entry => entry.state === 'queued').map(entry => entry.dedupKey), [], 'nothing is left queued')
  const observed = f.runtime.observe(f.owner, f.mission.id)
  assert.equal(observed.pendingDeliveries, 0, 'the covered row is not a pending delivery')
  assert.notEqual(observed.lastWitness?.dedupKey, root.notice.dedupKey, 'the covered row is not the last notice')
})

test('a rejected root that strands a dependent names it in a delivered notice, not first in a reminder', async t => {
  // 12b12a6: the rejected root's stall-root row was recorded against the
  // rejection decision, which names the source only; while other work ran, the
  // stranded dependent first reached the owner in a reminder (600 s by default).
  const f = await fixture(t, { tickMs: 10 })
  f.runtime.notices.obligationFollowupMs = 1e9
  const reviewer = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Reviewer', role: 'verification' })
  const other = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Other', role: 'implementation' })
  const source = f.propose('Rejected implementation')
  const claimed = await f.runtime.claim(f.actor, f.mission.id, source.id)
  await f.runtime.submit(f.actor, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.runtime.store.get('tasks', source.id).workstreamId,
    title: 'Review', objective: 'Independent review', kind: 'verification', reviewOf: source.id, scope: ['src/'], acceptance: ['works'], assigneeId: reviewer.id })
  const reviewing = await f.runtime.claim({ sessionId: reviewer.sessionId }, f.mission.id, review.id)
  const sibling = f.propose('Healthy sibling', { kind: 'research', checks: undefined, assigneeId: other.id })
  await f.runtime.claim({ sessionId: other.sessionId }, f.mission.id, sibling.id)
  // Research kind keeps the integration-gap diagnostic (which lists every
  // implementation branch) from naming the dependent first.
  const dependent = f.propose('Downstream of the rejected source', { kind: 'research', checks: undefined, assigneeId: other.id })
  f.runtime.store.transaction(() => { const row = f.runtime.store.get('tasks', dependent.id); row.dependencies = [source.id]; f.runtime.store.put('tasks', row) })
  await f.runtime.verify({ sessionId: reviewer.sessionId }, f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'reject', reason: 'The candidate does not work' })
  const naming = await eventually(() => f.notices().find(delivery => delivery.deliveredAt !== undefined && delivery.content.includes(dependent.id)), 'a delivered notice names the stranded dependent', 2000)
  assert.equal(f.runtime.store.get('tasks', sibling.id).status, 'running', 'other work is running')
  assert.equal(f.runtime.store.get('tasks', dependent.id).status, 'pending')
  assert.ok(naming.notice.dedupKey.startsWith(`stall-root:${f.mission.id}:${source.id}@`), `the root's own stall-root notice names it: ${naming.notice.dedupKey}`)
  assert.equal(naming.notice.coveredBy, undefined, 'a root that strands other work is not recorded against the rejection decision')
  assert.ok(naming.subjects.includes(`${dependent.id}@${f.runtime.store.get('tasks', dependent.id).epoch}`), 'the dependent is a subject of the delivered notice')
  assert.deepEqual(f.notices().filter(delivery => delivery.notice?.dedupKey?.startsWith('obligation-followup:')), [], 'no reminder was needed')
})

test('a stall root with no rejection decision (a permanent preparation failure) is still its own owner wake', async t => {
  // The same generic `decision` notice shape the verify site used before, from
  // the scheduler's permanent preparation failure: it never covers a stall root.
  const f = await fixture(t)
  const research = { kind: 'research', checks: undefined }
  const sibling = f.propose('Healthy sibling', research)
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  const failing = f.propose('Cannot prepare', research)
  f.runtime.commit(f.mission.id, () => {
    const row = f.runtime.store.get('tasks', failing.id)
    row.epoch++; row.status = 'blocked'
    row.preparationFailure = { reason: 'Workspace or worker preparation failed: EACCES', transient: false, attempts: 1 }
    row.output = 'Workspace or worker preparation failed: EACCES'
    f.runtime.store.put('tasks', row)
    f.runtime.notify(f.mission.id, row.output, [`${row.id}@${row.epoch}`], { from: 'runtime' })
  })
  const root = await eventually(() => f.stallRoots().find(delivery => delivery.deliveredAt !== undefined), 'the stall root is delivered as its own wake')
  assert.equal(root.notice.coveredBy, undefined, 'only a verify-site rejection decision covers a stall root')
})

for (const repaired of [true, false]) {
  test(`stall-root reminders judge the root the key names: ${repaired ? 'none while the repair runs' : 'one arrives when no repair is proposed'}`, async t => {
    // 5347f5b: delivery judged a stall-root by its root alone, but its reminders
    // judged every listed subject; the rejecting review (a listed dependent) is
    // never a live wait, so two "still unresolved" reminders reached the owner
    // while the root's repair was already running.
    const f = await fixture(t, { tickMs: 10 })
    f.runtime.notices.obligationFollowupMs = 300
    const reviewer = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Reviewer', role: 'verification' })
    const source = f.propose('Rejected implementation')
    const claimed = await f.runtime.claim(f.actor, f.mission.id, source.id)
    await f.runtime.submit(f.actor, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.runtime.store.get('tasks', source.id).workstreamId,
      title: 'Review', objective: 'Independent review', kind: 'verification', reviewOf: source.id, scope: ['src/'], acceptance: ['works'], assigneeId: reviewer.id })
    const reviewing = await f.runtime.claim({ sessionId: reviewer.sessionId }, f.mission.id, review.id)
    await f.runtime.verify({ sessionId: reviewer.sessionId }, f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'reject', reason: 'The candidate does not work' })
    const rootSubject = `${source.id}@${f.runtime.store.get('tasks', source.id).epoch}`
    // Delivered itself, or (a rejected root) through the decision it is recorded against.
    const handed = delivery => (delivery.notice.coveredBy === undefined ? delivery : f.runtime.store.get('deliveries', delivery.notice.coveredBy))?.deliveredAt !== undefined
    const stallRoot = await eventually(() => f.stallRoots().find(handed), 'the stall-root decision reaches the owner')
    assert.ok(stallRoot.subjects.includes(`${review.id}@${f.runtime.store.get('tasks', review.id).epoch}`), 'the rejecting review is a listed dependent')
    const reviewSubject = `${review.id}@${f.runtime.store.get('tasks', review.id).epoch}`
    // Every owner fact: its own row, or each wake-budget constituent.
    const facts = () => f.notices().flatMap(delivery => delivery.notice?.aggregatedFacts === undefined
      ? [{ delivery, dedupKey: delivery.notice?.dedupKey ?? '', subjects: delivery.subjects ?? [], createdAt: delivery.createdAt }]
      : delivery.notice.aggregatedFacts.map(part => ({ delivery, dedupKey: part.dedupKey, subjects: part.subjects, createdAt: part.createdAt })))
    const remindersOf = original => facts().filter(fact => fact.dedupKey.startsWith(`obligation-followup:${original.id}:`))
    const reminders = () => remindersOf(stallRoot)
    if (repaired) {
      const proposedAt = Date.now()
      const repair = f.propose('Repair', { replaces: [source.id] })
      await eventually(() => f.runtime.store.get('tasks', repair.id).status === 'running', 'the repair runs')
      await sleep(1200)
      assert.equal(f.runtime.store.get('tasks', repair.id).status, 'running', 'the repair is still running')
      assert.deepEqual(reminders().map(item => item.subjects), [], 'no stall-root reminder while the repair runs')
      // 12b12a6: the W3 stall's reminders and the fall-through still named the
      // rejecting review (a blocked verdict record) while the repair ran.
      const naming = facts().filter(fact => fact.createdAt >= proposedAt && /^(obligation-followup|fallthrough):/.test(fact.dedupKey) && fact.subjects.includes(reviewSubject))
      assert.deepEqual(naming.map(fact => fact.dedupKey.split(':')[0]), [], 'no reminder or fall-through names the rejecting review while the repair runs')
      return
    }
    // The rejected root is recorded against its rejection decision, whose own
    // reminders carry the root.
    const cover = f.runtime.store.get('deliveries', stallRoot.notice.coveredBy)
    assert.ok(cover !== undefined, 'the rejected root is recorded against the rejection decision')
    const reminder = await eventually(() => remindersOf(cover).find(item => item.delivery.deliveredAt !== undefined), 'the rejection decision\'s reminder reaches the owner', 3000)
    assert.deepEqual(reminder.subjects, [rootSubject], 'the reminder names the root, not the rejecting review')
    // The W3 board stall lists the review too; its reminders judge the same rule.
    const stall = f.notices().find(delivery => delivery.notice?.dedupKey?.startsWith('mission/stalled:'))
    assert.ok(stall?.subjects.includes(reviewSubject), 'the W3 stall lists the rejecting review')
    await eventually(() => remindersOf(stall).length >= f.runtime.notices.maxObligationFollowups, 'every W3 reminder is recorded', 5000)
    assert.deepEqual(remindersOf(stall).map(fact => fact.subjects), remindersOf(stall).map(() => [rootSubject]), 'the W3 reminders name the root only')
    // 12b12a6: the covered row reminded on its own, beside the decision's
    // reminder, citing an "original delivery" the owner never received.
    assert.deepEqual(reminders(), [], 'the covered stall root has no reminders of its own')
    const cited = facts().filter(fact => fact.dedupKey.startsWith('obligation-followup:')).map(fact => fact.dedupKey.split(':')[1])
    assert.deepEqual(cited.filter(id => f.runtime.store.get('deliveries', id)?.deliveredAt === undefined), [], 'every reminder cites a delivery the owner received')
  })
}

test('a pending task in preparation back-off is a bounded live wait, and a named fall-through once the bound passes without a retry', async t => {
  // Before, any `preparationFailure` made a pending task "not legitimately
  // waiting", so the host's own transient back-off woke the owner through the
  // fall-through while the retry was still scheduled.
  const f = await fixture(t)
  const tickMs = f.runtime.config.tickMs
  const second = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Second', role: 'implementation' })
  // A healthy sibling keeps the board out of the W3 stall class; research kind
  // keeps the integration-gap diagnostic off the board.
  const research = { kind: 'research', checks: undefined }
  const sibling = f.propose('Healthy sibling', research)
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  const backoff = f.propose('Backing off', { ...research, assigneeId: second.id })
  // The scheduler's transient back-off (src/scheduling.ts) and then the loss of
  // the only member it could retry on: nothing will retry once retryAt passes.
  const retryAt = Date.now() + 400
  f.runtime.store.transaction(() => {
    const row = f.runtime.store.get('tasks', backoff.id)
    row.epoch++
    row.preparationFailure = { reason: 'Workspace or worker preparation failed: EBUSY', transient: true, attempts: 1, retryAt }
    f.runtime.store.put('tasks', row)
    const member = f.runtime.store.get('members', second.id)
    member.phase = 'stopped'
    f.runtime.store.put('members', member)
  })
  const epoch = f.runtime.store.get('tasks', backoff.id).epoch
  const named = () => f.fallthroughs().filter(delivery => delivery.subjects?.includes(`${backoff.id}@${epoch}`))
  const board = () => f.runtime.store.list('tasks', f.mission.id)
  assert.equal(waitsLegitimately(f.runtime, f.runtime.store.get('tasks', backoff.id), board()), true, 'the back-off is a live wait')
  await sleep(250)
  assert.equal(named().length, 0, `no fall-through while the host's retry is scheduled: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  const notice = await eventually(() => named()[0], 'the overdue retry is named once the bound passes')
  assert.ok(notice.createdAt > retryAt + tickMs, `named only after retryAt plus one tick (${notice.createdAt - retryAt} ms after retryAt)`)
  assert.equal(f.runtime.store.get('tasks', backoff.id).status, 'pending', 'no retry happened')
  await sleep(100)
  assert.equal(named().length, 1, 'named exactly once')
  // Past the bound the back-off explains nothing: the row is judged like any
  // other ready work, so an assignee holding a live lease is still a live wait.
  assert.equal(waitsLegitimately(f.runtime, { ...f.runtime.store.get('tasks', backoff.id), assigneeId: f.member.id }, board()), true,
    'an expired back-off queued behind its assignee\'s live lease is not an obstacle')
  // A failure the host will not retry stays a block cause, never a wait.
  const { retryAt: _retryAt, ...permanent } = f.runtime.store.get('tasks', backoff.id).preparationFailure
  assert.equal(waitsLegitimately(f.runtime, { ...f.runtime.store.get('tasks', backoff.id), preparationFailure: { ...permanent, transient: false } }, board()), false)
})

for (const coStamp of ['stall-root', 'permanent-preparation-failure']) {
  test(`a W2 witness stamped during a preparation back-off (${coStamp}) does not hide the back-off once its bound passes`, async t => {
    // 5347f5b: the back-off wait ends on a timer that changes nothing in F(S), so
    // a W2 stamped inside the window (the row-7b stamp after a stall-root notice,
    // or another task's permanent preparation-failure notice) matched F(S) forever
    // and the fall-through never named the task nothing would retry.
    const f = await fixture(t)
    const tickMs = f.runtime.config.tickMs
    const second = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Second', role: 'implementation' })
    const research = { kind: 'research', checks: undefined }
    const sibling = f.propose('Healthy sibling', research)
    await f.runtime.claim(f.actor, f.mission.id, sibling.id)
    const other = f.propose('Unrelated dead end', research)
    const backoff = f.propose('Backing off', { ...research, assigneeId: second.id })
    const retryAt = Date.now() + 400
    f.runtime.commit(f.mission.id, () => {
      const row = f.runtime.store.get('tasks', backoff.id)
      row.epoch++
      row.preparationFailure = { reason: 'Workspace or worker preparation failed: EBUSY', transient: true, attempts: 1, retryAt }
      f.runtime.store.put('tasks', row)
      const dead = f.runtime.store.get('tasks', other.id)
      dead.status = 'blocked'; dead.epoch++
      if (coStamp === 'permanent-preparation-failure') {
        // The scheduler's own permanent-failure shape (src/scheduling.ts), notice included.
        dead.preparationFailure = { reason: 'Workspace or worker preparation failed: EACCES', transient: false, attempts: 1 }
        dead.output = 'Workspace or worker preparation failed: EACCES'
        f.runtime.store.put('tasks', dead)
        f.runtime.notify(f.mission.id, dead.output, [`${dead.id}@${dead.epoch}`], { from: 'runtime' })
      } else {
        dead.output = 'blocked for repair'
        f.runtime.store.put('tasks', dead)
      }
      const member = f.runtime.store.get('members', second.id)
      member.phase = 'stopped'
      f.runtime.store.put('members', member)
    })
    const epoch = f.runtime.store.get('tasks', backoff.id).epoch
    const named = () => f.fallthroughs().filter(delivery => delivery.subjects?.includes(`${backoff.id}@${epoch}`))
    // The co-stamp happened inside the window and the board did not change after it.
    const stamped = await eventually(() => {
      const witness = f.runtime.store.get('missions', f.mission.id).witness
      return witness?.kind === 'W2' && witness.at <= retryAt + tickMs && witness.fingerprint === f.runtime.fingerprint(f.mission.id) ? witness : undefined
    }, 'a W2 witness is stamped during the back-off window')
    assert.ok(stamped.at <= retryAt, `stamped inside the window (${retryAt - stamped.at} ms before retryAt)`)
    assert.equal(named().length, 0, 'the live back-off is not named')
    const notice = await eventually(() => named()[0], 'the expired back-off is named despite the earlier W2 for the same F(S)', 3000)
    assert.ok(notice.createdAt > retryAt + tickMs, `named only after retryAt plus one tick (${notice.createdAt - retryAt} ms after retryAt)`)
    assert.deepEqual(notice.subjects, [`${backoff.id}@${epoch}`], 'only the expired back-off is named')
    assert.equal(f.runtime.store.get('tasks', backoff.id).status, 'pending', 'no retry happened')
    await sleep(150)
    assert.equal(named().length, 1, 'named exactly once: the fall-through re-stamps the witness past the bound')
    const witness = f.runtime.store.get('missions', f.mission.id).witness
    assert.equal(witness.fingerprint, f.runtime.fingerprint(f.mission.id), 'the witness is still keyed by F(S) alone')
    assert.ok(witness.at > retryAt + tickMs, 'the current witness post-dates the bound')
  })
}
