/**
 * R14-F2 (b)/(c)/(d): the board's stall roots are named once per root@epoch
 * whether or not a healthy sibling is running, and the unnamed fall-through is
 * replaced by a silent-while-waiting, named-otherwise escalation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { waitsLegitimately } from '../lib/notices.js'
import { wakePrecision } from './instruments.mjs'
import { FakeClock, FakeWorkers, eventually, makeRuntime } from './faults/harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A started runtime with one member, on the shared fixture. With a `clock`
 * (FakeClock) the runtime reads it and runs no tick timer: the test moves the
 * clock and drives `runtime.tick()` itself (`ticks`).
 */
async function fixture(t, { clock, ...config } = {}) {
  const workers = new FakeWorkers({ autoIdle: true, checks: [], artifact: { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } })
  const { dir: directory, runtime, budget } = await makeRuntime(t, { workers, clock, config: { tickMs: 25, maxEvents: 500, maxTasksPerMember: 9, checkTimeoutMs: undefined, ...config },
    budget: { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 } })
  await runtime.start()
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
  return { directory, runtime, clock, owner, mission, member, actor, propose, block, cancel, notices, stallRoots, fallthroughs }
}

/** `count` ticks of the timer a fake-clock runtime does not run, one tick unit of clock time apart. */
async function ticks(f, count) { for (let n = 0; n < count; n += 1) { f.clock.advance(f.runtime.config.tickMs); await f.runtime.tick() } }
/** Tick until `read` returns a value, as the timer would until it holds; fail after `limit` ticks. */
async function ticksUntil(f, read, message, limit = 200) {
  for (let n = 0; n <= limit; n += 1) { const value = read(); if (value) return value; if (n < limit) await ticks(f, 1) }
  assert.fail(`not within ${limit} ticks: ${message}`)
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
  const rt = { stallPassTimeoutMs: 100, config: { tickMs: 25 }, unfinishedDependencies: () => [], now: () => now }
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

test('a rejected root whose decision was summarized is its own fact, and is named again when its repair is withdrawn', async t => {
  // 82d9ec8: a stall root was recorded against a rejection decision that was a
  // wake-budget summary constituent, so it had no reminders of its own and
  // shared the summary's two with unrelated facts. Spent on another blocked
  // task while the repair ran, they left nothing to name the root once the
  // owner withdrew the repair. A summarized decision now covers nothing, and
  // each summarized fact has its own reminder allowance.
  const f = await fixture(t, { tickMs: 10, stallPassTimeoutMs: 5000 })
  const rt = f.runtime
  rt.notices.wakeBudget = 1
  rt.notices.wakeBudgetWindowMs = 1e9
  rt.notices.obligationFollowupMs = 300
  // The one wake slot's delivery is held in transport, so every later fact is summarized.
  let release
  const gate = new Promise(resolve => { release = resolve })
  let hold = true
  const deliver = rt.workers.deliver.bind(rt.workers)
  rt.workers.deliver = async (member, delivery) => { if (member.id === 'owner' && hold) await gate; return deliver(member, delivery) }
  const reviewer = await rt.addMember(f.owner, f.mission.id, { name: 'Reviewer', role: 'verification' })
  const other = await rt.addMember(f.owner, f.mission.id, { name: 'Other', role: 'implementation' })
  const sibling = f.propose('Healthy sibling', { kind: 'research', checks: undefined, assigneeId: other.id })
  await rt.claim({ sessionId: other.sessionId }, f.mission.id, sibling.id)
  rt.commit(f.mission.id, () => rt.notify(f.mission.id, 'First owner fact', [`mission:${f.mission.id}`], { trigger: 'probe/first', reason: 'first' }))
  const unrelated = f.propose('Unrelated dead end', { kind: 'research', checks: undefined, assigneeId: other.id })
  await sleep(100)
  const source = f.propose('Source')
  const claimed = await rt.claim(f.actor, f.mission.id, source.id)
  await rt.submit(f.actor, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = rt.propose(f.owner, f.mission.id, { outputs: [], workstreamId: rt.store.get('tasks', source.id).workstreamId, title: 'Review', objective: 'Independent review', kind: 'verification', reviewOf: source.id, scope: ['src/'], acceptance: ['works'], assigneeId: reviewer.id })
  const reviewing = await rt.claim({ sessionId: reviewer.sessionId }, f.mission.id, review.id)
  await rt.verify({ sessionId: reviewer.sessionId }, f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'reject', reason: 'The candidate does not work' })
  // In the same macrotask another task dies and the owner is asked to decide it.
  rt.commit(f.mission.id, () => {
    const row = rt.store.get('tasks', unrelated.id); row.status = 'blocked'; row.epoch++; row.output = 'blocked for repair'; rt.store.put('tasks', row)
    rt.notify(f.mission.id, `Task ${unrelated.id} is blocked; decide`, [`${unrelated.id}@${row.epoch}`], { trigger: 'probe/unrelated-decision', reason: 'unrelated' })
  })
  const rootSubject = `${source.id}@${rt.store.get('tasks', source.id).epoch}`
  const facts = () => f.notices().flatMap(delivery => delivery.notice?.aggregatedFacts === undefined
    ? [{ delivery, dedupKey: delivery.notice?.dedupKey ?? '', subjects: delivery.subjects ?? [], createdAt: delivery.createdAt, coveredBy: delivery.notice?.coveredBy }]
    : delivery.notice.aggregatedFacts.map(part => ({ delivery, dedupKey: part.dedupKey, subjects: part.subjects, createdAt: part.createdAt })))
  const root = await eventually(() => facts().find(fact => fact.dedupKey === `stall-root:${f.mission.id}:${rootSubject}`), 'the stall root is recorded')
  assert.equal(root.coveredBy, undefined, 'a rejection decision carried by a summary covers nothing: the root is its own fact')
  // The owner repairs the root before the notices arrive; the unrelated fact
  // stays open while the repair runs.
  const repair = f.propose('Repair', { replaces: [source.id] })
  await rt.claim(f.actor, f.mission.id, repair.id)
  hold = false; release()
  await sleep(1200)
  assert.equal(rt.store.get('tasks', repair.id).status, 'running', 'the repair ran past two reminder intervals')
  const withdrawnAt = Date.now()
  rt.cancel(f.owner, f.mission.id, { taskId: repair.id, reason: 'withdraw the repair' })
  assert.ok(rt.notices.stallRoots(rt.store.list('tasks', f.mission.id)).some(task => task.id === source.id), 'the root is a stall root again')
  const naming = await eventually(() => facts().find(fact => fact.createdAt >= withdrawnAt && fact.subjects.includes(rootSubject)), 'a fact names the root after the withdrawal', 2000)
  assert.ok(naming.dedupKey.startsWith('obligation-followup:'), `a reminder names the root: ${naming.dedupKey}`)
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
    // while the root's repair was already running. The clock and the ticks are
    // driven by hand: each reminder interval is one clock step and one tick.
    const clock = new FakeClock()
    const f = await fixture(t, { clock })
    const followupMs = f.runtime.notices.obligationFollowupMs = 300
    const reminderIntervals = async count => { for (let step = 0; step < count; step += 1) { clock.advance(followupMs); await f.runtime.tick() } }
    const reviewer = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Reviewer', role: 'verification' })
    const source = f.propose('Rejected implementation')
    const claimed = await f.runtime.claim(f.actor, f.mission.id, source.id)
    await f.runtime.submit(f.actor, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.runtime.store.get('tasks', source.id).workstreamId,
      title: 'Review', objective: 'Independent review', kind: 'verification', reviewOf: source.id, scope: ['src/'], acceptance: ['works'], assigneeId: reviewer.id })
    const reviewing = await f.runtime.claim({ sessionId: reviewer.sessionId }, f.mission.id, review.id)
    await f.runtime.verify({ sessionId: reviewer.sessionId }, f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'reject', reason: 'The candidate does not work' })
    await f.runtime.tick()
    const rootSubject = `${source.id}@${f.runtime.store.get('tasks', source.id).epoch}`
    // Delivered itself, or (a rejected root) through the decision it is recorded against.
    const handed = delivery => (delivery.notice.coveredBy === undefined ? delivery : f.runtime.store.get('deliveries', delivery.notice.coveredBy))?.deliveredAt !== undefined
    const stallRoot = f.stallRoots().find(handed)
    assert.ok(stallRoot !== undefined, 'the stall-root decision reaches the owner')
    assert.ok(stallRoot.subjects.includes(`${review.id}@${f.runtime.store.get('tasks', review.id).epoch}`), 'the rejecting review is a listed dependent')
    const reviewSubject = `${review.id}@${f.runtime.store.get('tasks', review.id).epoch}`
    // Every owner fact: its own row, or each wake-budget constituent.
    const facts = () => f.notices().flatMap(delivery => delivery.notice?.aggregatedFacts === undefined
      ? [{ delivery, dedupKey: delivery.notice?.dedupKey ?? '', subjects: delivery.subjects ?? [], createdAt: delivery.createdAt }]
      : delivery.notice.aggregatedFacts.map(part => ({ delivery, dedupKey: part.dedupKey, subjects: part.subjects, createdAt: part.createdAt })))
    const remindersOf = original => facts().filter(fact => fact.dedupKey.startsWith(`obligation-followup:${original.id}:`))
    const reminders = () => remindersOf(stallRoot)
    if (repaired) {
      const proposedAt = clock.now()
      const repair = f.propose('Repair', { replaces: [source.id] })
      // A body still open from the verdict coalesces this kick; the next tick runs it.
      await f.runtime.settle(f.mission.id)
      await f.runtime.tick()
      assert.equal(f.runtime.store.get('tasks', repair.id).status, 'running', 'the repair runs')
      await reminderIntervals(4)
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
    await reminderIntervals(f.runtime.notices.maxObligationFollowups + 1)
    const reminder = remindersOf(cover).find(item => item.delivery.deliveredAt !== undefined)
    assert.ok(reminder !== undefined, 'the rejection decision\'s reminder reaches the owner')
    assert.deepEqual(reminder.subjects, [rootSubject], 'the reminder names the root, not the rejecting review')
    // The W3 board stall lists the review too; its reminders judge the same rule.
    const stall = f.notices().find(delivery => delivery.notice?.dedupKey?.startsWith('mission/stalled:'))
    assert.ok(stall?.subjects.includes(reviewSubject), 'the W3 stall lists the rejecting review')
    assert.equal(remindersOf(stall).length, f.runtime.notices.maxObligationFollowups, 'every W3 reminder is recorded')
    assert.deepEqual(remindersOf(stall).map(fact => fact.subjects), remindersOf(stall).map(() => [rootSubject]), 'the W3 reminders name the root only')
    // 12b12a6: the covered row reminded on its own, beside the decision's
    // reminder, citing an "original delivery" the owner never received.
    assert.deepEqual(reminders(), [], 'the covered stall root has no reminders of its own')
    const cited = facts().filter(fact => fact.dedupKey.startsWith('obligation-followup:')).map(fact => fact.dedupKey.split(':')[1])
    assert.deepEqual(cited.filter(id => f.runtime.store.get('deliveries', id)?.deliveredAt === undefined), [], 'every reminder cites a delivery the owner received')
    // cc5bb56: an uncovered stall-root decision reminds while the root its key
    // names is still a root. This root waits on a live prerequisite, which the
    // subject rule of every other decision reads as a legitimate wait.
    const prerequisite = f.propose('Live prerequisite')
    const root = f.block(f.propose('Root with a live prerequisite', { dependencies: [prerequisite.id] }))
    await f.runtime.tick()
    const rootKey = `stall-root:${f.mission.id}:${root.id}@${root.epoch}`
    // Its own row, or a wake-budget summary that carries it.
    const decision = f.notices().find(delivery => delivery.notice?.dedupKey === rootKey || delivery.notice?.aggregatedFacts?.some(part => part.dedupKey === rootKey))
    assert.ok(decision?.deliveredAt !== undefined && decision.notice.coveredBy === undefined, 'the stall-root decision reaches the owner')
    await reminderIntervals(1)
    assert.ok(remindersOf(decision).some(fact => fact.subjects.includes(`${root.id}@${root.epoch}`)), 'its reminder names the root, however the root waits')
  })
}

test('a pending task in preparation back-off is a bounded live wait, and a named fall-through once the bound passes without a retry', async t => {
  // Before, any `preparationFailure` made a pending task "not legitimately
  // waiting", so the host's own transient back-off woke the owner through the
  // fall-through while the retry was still scheduled. The clock and the ticks
  // are driven by hand.
  const f = await fixture(t, { clock: new FakeClock() })
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
  const retryAt = f.clock.now() + 400
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
  await ticks(f, 10)
  assert.equal(named().length, 0, `no fall-through while the host's retry is scheduled: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  const notice = await ticksUntil(f, () => named()[0], 'the overdue retry is named once the bound passes')
  assert.ok(notice.createdAt > retryAt + tickMs, `named only after retryAt plus one tick (${notice.createdAt - retryAt} ms after retryAt)`)
  assert.equal(f.runtime.store.get('tasks', backoff.id).status, 'pending', 'no retry happened')
  await ticks(f, 4)
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
    // and the fall-through never named the task nothing would retry. The clock
    // and the ticks are driven by hand.
    const f = await fixture(t, { clock: new FakeClock() })
    const tickMs = f.runtime.config.tickMs
    const second = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Second', role: 'implementation' })
    const research = { kind: 'research', checks: undefined }
    const sibling = f.propose('Healthy sibling', research)
    await f.runtime.claim(f.actor, f.mission.id, sibling.id)
    const other = f.propose('Unrelated dead end', research)
    const backoff = f.propose('Backing off', { ...research, assigneeId: second.id })
    const retryAt = f.clock.now() + 400
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
    const stamped = await ticksUntil(f, () => {
      const witness = f.runtime.store.get('missions', f.mission.id).witness
      return witness?.kind === 'W2' && witness.at <= retryAt + tickMs && witness.fingerprint === f.runtime.fingerprint(f.mission.id) ? witness : undefined
    }, 'a W2 witness is stamped during the back-off window')
    assert.ok(stamped.at <= retryAt, `stamped inside the window (${retryAt - stamped.at} ms before retryAt)`)
    assert.equal(named().length, 0, 'the live back-off is not named')
    const notice = await ticksUntil(f, () => named()[0], 'the expired back-off is named despite the earlier W2 for the same F(S)', 120)
    assert.ok(notice.createdAt > retryAt + tickMs, `named only after retryAt plus one tick (${notice.createdAt - retryAt} ms after retryAt)`)
    assert.deepEqual(notice.subjects, [`${backoff.id}@${epoch}`], 'only the expired back-off is named')
    assert.equal(f.runtime.store.get('tasks', backoff.id).status, 'pending', 'no retry happened')
    await ticks(f, 6)
    assert.equal(named().length, 1, 'named exactly once: the fall-through re-stamps the witness past the bound')
    const witness = f.runtime.store.get('missions', f.mission.id).witness
    assert.equal(witness.fingerprint, f.runtime.fingerprint(f.mission.id), 'the witness is still keyed by F(S) alone')
    assert.ok(witness.at > retryAt + tickMs, 'the current witness post-dates the bound')
  })
}

test('an expired back-off that still waits (queued behind a live lease) is judged once, then the witness dedup holds again', async t => {
  // 12b12a6: once a back-off expired after the witness was stamped, the F(S)
  // dedup stayed bypassed for as long as the task legitimately waited, so the
  // whole classifier ran on every pass and transition (~40 per second here).
  // The clock and the ticks are driven by hand; the instants below are the
  // runtime's clock.
  const f = await fixture(t, { clock: new FakeClock() })
  const tickMs = f.runtime.config.tickMs
  const research = { kind: 'research', checks: undefined }
  const running = f.propose('Running work', research)
  await f.runtime.claim(f.actor, f.mission.id, running.id)
  const other = f.propose('Unrelated dead end', research)
  // Queued behind its own assignee's live lease once the back-off expires.
  const backoff = f.propose('Backing off', research)
  const retryAt = f.clock.now() + 300
  f.runtime.commit(f.mission.id, () => {
    const row = f.runtime.store.get('tasks', backoff.id)
    row.epoch++
    row.preparationFailure = { reason: 'Workspace or worker preparation failed: EBUSY', transient: true, attempts: 1, retryAt }
    f.runtime.store.put('tasks', row)
    const dead = f.runtime.store.get('tasks', other.id)
    dead.status = 'blocked'; dead.epoch++; dead.output = 'blocked for repair'
    f.runtime.store.put('tasks', dead)
  })
  // The unrelated stall root stamps the W2 witness inside the back-off window.
  const stamped = await ticksUntil(f, () => {
    const witness = f.runtime.store.get('missions', f.mission.id).witness
    return witness?.kind === 'W2' && witness.at <= retryAt && witness.fingerprint === f.runtime.fingerprint(f.mission.id) ? witness : undefined
  }, 'a W2 witness is stamped during the back-off window')
  const notices = f.runtime.notices
  const judged = [], passes = []
  const waits = notices.waitsLegitimately.bind(notices)
  notices.waitsLegitimately = (task, tasks) => { if (task.id === backoff.id) judged.push(f.clock.now()); return waits(task, tasks) }
  const ensure = notices.ensureWitness.bind(notices)
  notices.ensureWitness = (missionId, options) => { passes.push(f.clock.now()); return ensure(missionId, options) }
  await ticks(f, Math.ceil((Math.max(0, retryAt + tickMs - f.clock.now()) + 800) / tickMs))
  const bound = retryAt + tickMs
  const after = judged.filter(at => at > bound)
  t.diagnostic(`witness passes after the bound: ${passes.filter(at => at > bound).length}; back-off judgements after the bound: ${after.length}`)
  assert.ok(passes.filter(at => at > bound).length >= 5, `the witness path kept running after the bound: ${passes.filter(at => at > bound).length}`)
  assert.ok(after.length >= 1, 'the expired back-off is judged after its bound')
  assert.ok(after.length <= 2, `the expired back-off is judged once, not on every pass: ${after.length}`)
  const witness = f.runtime.store.get('missions', f.mission.id).witness
  assert.equal(witness.fingerprint, stamped.fingerprint, 'the same F(S) is re-stamped')
  assert.ok(witness.at > bound, 'the witness now post-dates the expired bound')
  assert.equal(f.runtime.store.get('tasks', backoff.id).status, 'pending', 'the back-off still waits behind the live lease')
  assert.deepEqual(f.fallthroughs().map(delivery => delivery.subjects), [], 'a legitimately waiting back-off is not named')
})

test('a back-off whose bound passes while a pass judges the board is still judged expired by a later pass', async t => {
  // 24ee7ce re-stamped the witness at the end of the judging pass. Back-off B
  // was judged still waiting early in that pass; its bound passed before the
  // pass ended, and the re-stamp then post-dated it, so every later pass read
  // the same F(S) as already judged and B's fall-through was never owed. The
  // re-stamp now carries the instant the judgement began. The clock and the
  // ticks are driven by hand: the slow judgement moves the clock past B's bound
  // itself instead of spinning on real time.
  const f = await fixture(t, { clock: new FakeClock() })
  const tickMs = f.runtime.config.tickMs
  const second = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Second', role: 'implementation' })
  const research = { kind: 'research', checks: undefined }
  const sibling = f.propose('Healthy sibling', research)
  await f.runtime.claim(f.actor, f.mission.id, sibling.id)
  const other = f.propose('Unrelated dead end', research)
  // A waits behind the live lease once expired (judged, nothing to publish:
  // the re-stamp); B's assignee is stopped, so once expired a fall-through is owed.
  const a = f.propose('Backoff A', research)
  const b = f.propose('Backoff B', { ...research, assigneeId: second.id })
  const retryA = f.clock.now() + 400
  const retryB = retryA + 80
  f.runtime.commit(f.mission.id, () => {
    for (const [task, retryAt] of [[a, retryA], [b, retryB]]) {
      const row = f.runtime.store.get('tasks', task.id)
      row.epoch++
      row.preparationFailure = { reason: 'Workspace or worker preparation failed: EBUSY', transient: true, attempts: 1, retryAt }
      f.runtime.store.put('tasks', row)
    }
    const dead = f.runtime.store.get('tasks', other.id)
    dead.status = 'blocked'; dead.epoch++; dead.output = 'blocked for repair'
    f.runtime.store.put('tasks', dead)
    const member = f.runtime.store.get('members', second.id)
    member.phase = 'stopped'
    f.runtime.store.put('members', member)
  })
  const boundA = retryA + tickMs, boundB = retryB + tickMs
  const bSubject = `${b.id}@${f.runtime.store.get('tasks', b.id).epoch}`
  await ticksUntil(f, () => {
    const witness = f.runtime.store.get('missions', f.mission.id).witness
    return witness?.kind === 'W2' && witness.at <= retryA && witness.fingerprint === f.runtime.fingerprint(f.mission.id) ? witness : undefined
  }, 'a W2 witness is stamped inside both back-off windows')
  const notices = f.runtime.notices
  let spun
  const judgedB = []
  const waits = notices.waitsLegitimately.bind(notices)
  notices.waitsLegitimately = (task, tasks) => { const result = waits(task, tasks); if (task.id === b.id) judgedB.push({ at: f.clock.now(), waits: result }); return result }
  const judge = notices.judgeBoard.bind(notices)
  notices.judgeBoard = (...args) => {
    const start = f.clock.now()
    const result = judge(...args)
    // The first judgement after A's bound runs past B's bound: a slow tail.
    if (spun === undefined && start > boundA && start < boundB) { spun = { start }; f.clock.advance(boundB + 2 - f.clock.now()) /* a slow judgement */ }
    return result
  }
  const named = await ticksUntil(f, () => f.fallthroughs().find(delivery => delivery.subjects?.includes(bSubject)), 'B\'s expired back-off is named by the fall-through', Math.ceil((Math.max(0, boundB - f.clock.now()) + 1000) / tickMs)).catch(error => error)
  assert.ok(spun !== undefined, 'a judgement began between the two bounds and ran past B\'s')
  assert.ok(judgedB.some(item => item.at >= spun.start && item.at < boundB && item.waits), 'that judgement found B still waiting')
  assert.ok(!(named instanceof Error), 'a later pass judged B expired and named it')
})
