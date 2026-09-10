/**
 * Round 15, Pass 1 — the owner decision loop.
 *
 * The five measured round-14 gaps, each pinned by a test that fails without its
 * mechanism:
 *
 * 1. `subjects` on every `notify()` site, enforced by an ENUMERATION of the call
 *    sites in `src/` (not a sample) plus durable-readback assertions for the
 *    classes the round-14 review read back without subjects (the guard-terminal
 *    notice behind the task-ceiling path, the W3 stall notice, the escalation).
 * 2. Off-pass decision generation: with `workers.start` hung — the failure-first
 *    case — the pending task is still named by a durable decision notice.
 * 3. An absent `resumeAfterStop.at` is unbounded, therefore a stall root, and is
 *    named with its subjects instead of being silent and unnamed.
 * 4. The dispatcher's per-(task, assignee) question: the notice names the member
 *    whose handle holds the task, never a false admission cause; an open attempt
 *    stays silent because the close-out path is already nudging it.
 * 5. A member holding a pending `nextStep` inbox item is drained or stays
 *    dispatchable, with the pair test showing the naive predicate stranding it.
 *
 * Every guard in this round names the guards it can co-fire with and each pair
 * below exercises the pair, not just one side.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SwarmRuntime } from '../lib/runtime.js'
import { HarnessWorkers, strandedInboxDecision } from '../lib/harness-workers.js'
import { AUTO_REVIEW_GRACE_MS } from '../lib/notices.js'
import { sidebarState } from '../lib/types/client/progress.js'
import { tempDirectory } from './temp-root.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class Workers {
  constructor(options = {}) { this.options = options; this.started = []; this.delivered = [] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start(spec) { this.started.push(spec.member.id); if (this.options.hangStart === true) return new Promise(() => {}) }
  async deliver(member, delivery) { this.delivered.push({ memberId: member.id, deliveryId: delivery.id }); if (this.options.onDeliver) await this.options.onDeliver(member, delivery) }
  async stop() { if (this.options.hangStop === true) return new Promise(() => {}) }
  isIdle(memberId) { return this.options.idle === undefined ? true : this.options.idle(memberId) }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}

async function fixture(t, config = {}, workers = undefined, directory = undefined) {
  const dir = directory ?? await tempDirectory('swarm-owner-decisions-')
  const runtime = new SwarmRuntime({ statePath: join(dir, 'db.sqlite'), leaseMs: 60000, tickMs: 25, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 9, ...config }, workers ?? new Workers())
  t.after(async () => { await runtime.dispose(); if (directory === undefined) await rm(dir, { recursive: true, force: true }) })
  return { directory: dir, runtime }
}

async function scenario(t, { workers = new Workers(), config = {}, directory } = {}) {
  const f = await fixture(t, config, workers, directory)
  await f.runtime.start()
  const owner = { sessionId: 'owner-decisions' }
  const mission = f.runtime.create(owner, { title: 'Owner decisions', objective: 'Name the subject', workspace: f.directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = f.runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const addMember = name => f.runtime.addMember(owner, mission.id, { name, role: 'implementation' })
  const actorFor = member => ({ sessionId: member.sessionId })
  const propose = (title, input = {}) => f.runtime.propose(owner, mission.id, { workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...input })
  const notices = () => f.runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
  const block = (task, extra = {}) => {
    const row = f.runtime.store.get('tasks', task.id)
    row.status = 'blocked'; row.epoch++; row.output = 'blocked for repair'
    Object.assign(row, extra)
    f.runtime.store.put('tasks', row)
    return f.runtime.store.get('tasks', row.id)
  }
  return { ...f, owner, mission, stream, addMember, actorFor, propose, notices, block }
}

/** Skip one string or template literal (including `${...}` substitutions). */
function skipString(text, start) {
  const quote = text[start]
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') { index += 2; continue }
    if (char === quote) return index + 1
    if (quote === '`' && char === '$' && text[index + 1] === '{') {
      let depth = 1
      index += 2
      while (index < text.length && depth > 0) {
        const inner = text[index]
        if (inner === '\\') { index += 2; continue }
        if (inner === '"' || inner === "'" || inner === '`') { index = skipString(text, index); continue }
        if (inner === '{') depth += 1
        else if (inner === '}') depth -= 1
        index += 1
      }
      continue
    }
    index += 1
  }
  return index
}

/** Skip one regular-expression literal (a quote inside one must not open a string). */
function skipRegex(text, start) {
  let index = start + 1
  let inClass = false
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') { index += 2; continue }
    if (char === '[') { inClass = true; index += 1; continue }
    if (char === ']') { inClass = false; index += 1; continue }
    if (char === '/' && !inClass) return index + 1
    if (char === '\n') return start + 1
    index += 1
  }
  return start + 1
}

/** Offsets of every `.notify(` call OUTSIDE strings, comments and regexes. */
function notifyCallOffsets(text) {
  const offsets = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index += 1; continue }
    if (char === '/' && text[index + 1] === '*') { const end = text.indexOf('*/', index + 2); if (end === -1) break; index = end + 2; continue }
    if (char === '/' && !/[/*]/.test(text[index + 1] ?? '')) {
      let before = index - 1
      while (before >= 0 && /\s/.test(text[before])) before -= 1
      if (before < 0 || '([{,;:=!&|?+-*%<>~^'.includes(text[before])) { index = skipRegex(text, index); continue }
    }
    if (char === '"' || char === "'" || char === '`') { index = skipString(text, index); continue }
    if (char === '.' && text.startsWith('.notify(', index)) { offsets.push(index + '.notify('.length - 1); index += '.notify('.length; continue }
    index += 1
  }
  return offsets
}

/** The top-level comma-separated arguments of the call whose `(` is at `open`. */
function topLevelArguments(text, open) {
  let depth = 0
  let index = open + 1
  let start = open + 1
  const args = []
  while (index < text.length) {
    const char = text[index]
    if (char === '/' && text[index + 1] === '/') { while (index < text.length && text[index] !== '\n') index += 1; continue }
    if (char === '/' && text[index + 1] === '*') { const end = text.indexOf('*/', index + 2); if (end === -1) return undefined; index = end + 2; continue }
    if (char === '"' || char === "'" || char === '`') { index = skipString(text, index); continue }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') {
      if (char === ')' && depth === 0) { args.push(text.slice(start, index)); return args }
      depth -= 1
    } else if (char === ',' && depth === 0) { args.push(text.slice(start, index)); start = index + 1 }
    index += 1
  }
  return undefined
}

test('R15-A1: every notify() call site in src/ passes a subject argument (enumeration, not a sample)', async () => {
  const entries = await readdir(join(root, 'src'), { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')))
    .map(entry => join(entry.parentPath ?? entry.path, entry.name))
  let sites = 0
  const offenders = []
  const isSubjectArgument = value => value.startsWith('[')
    || /^(subjects|subjectList|[a-zA-Z.]*Subjects)$/.test(value)
    || /^[a-zA-Z.]*SubjectsFor\(/.test(value)
    || /^[a-zA-Z.]*subjectsOfTasks\(/.test(value)
    || /^[a-zA-Z.]*(Subjects|subjects)\(/.test(value)
    || /^question\.subjects$/.test(value)
    || /^noticeSubjects\(/.test(value)
  const stripComments = value => value.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    // The scanner must see every raw occurrence: a file it mis-parses would make
    // this enumeration quietly incomplete, which is the failure mode it exists to
    // prevent.
    assert.equal(notifyCallOffsets(text).length, (text.match(/\.notify\(/g) ?? []).length, `every raw .notify( occurrence in ${file.slice(root.length + 1)} is parsed by the enumeration scanner`)
    for (const open of notifyCallOffsets(text)) {
      sites += 1
      const args = topLevelArguments(text, open)
      if (args === undefined) { offenders.push(`${file.slice(root.length + 1)}: unparsed argument list`); continue }
      const third = stripComments(args[2] ?? '').trim()
      if (!isSubjectArgument(third)) offenders.push(`${file.slice(root.length + 1)}: ${third.slice(0, 60)}`)
    }
  }
  // The count is part of the claim: a NEW call site must be visited and given a
  // subject, and this number is what makes the enumeration complete. R16-D adds
  // exactly one site — `Scheduling.escalateSilentAttempt` (src/scheduling.ts),
  // the attempt reporting-bound escalation, whose third argument is
  // `[taskSubject(task)]`. The count moves 23 -> 24; nothing else in this test
  // changed, and the new site is visited and checked like every other.
  assert.equal(sites, 24, `every .notify() site enumerated (found ${sites})`)
  assert.deepEqual(offenders, [], `every notify() site passes subjects as its third argument: ${offenders.join(' | ')}`)
})

test('R15-A1: the guard-terminal owner notice behind the task-ceiling path carries subjects in its own durable row', async t => {
  const f = await scenario(t)
  const member = await f.addMember('Builder')
  // mission task budget exhausted -> the same `emitGuardTerminal` task-ceiling
  // entry the round-14 review read back with `subjects: ABSENT`.
  const limited = await fixture(t, { maxTasks: 1 })
  await limited.runtime.start()
  const owner = { sessionId: 'ceiling-owner' }
  const mission = limited.runtime.create(owner, { title: 'Ceiling', objective: 'Name the subject', workspace: limited.directory, scope: ['src/'], acceptance: ['works'], budget: { ...budget, maxTasks: 1 } })
  const stream = limited.runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const builder = await limited.runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  await limited.runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'First', objective: 'First', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: builder.id })
  let refusal
  try { await limited.runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Second', objective: 'Second', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: builder.id }) }
  catch (error) { refusal = error }
  assert.ok(refusal instanceof Error, `the second proposal is refused: ${String(refusal)}`)
  assert.match(String(refusal), /task budget|ceiling/i)
  const notice = limited.runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
    .find(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('guard-terminal:'))
  assert.ok(notice, 'the guard terminal recorded a durable owner notice')
  const reloaded = limited.runtime.store.get('deliveries', notice.id)
  assert.ok(Array.isArray(reloaded.subjects) && reloaded.subjects.length > 0, `the durable row carries subjects: ${JSON.stringify(reloaded.subjects)}`)
  assert.ok(reloaded.subjects.every(subject => /^task:|^mission:/.test(subject) || subject.includes('@')), `subjects are taskId@epoch or the lineage root: ${JSON.stringify(reloaded.subjects)}`)
  // The task-scoped variant of the same entry (the measured defect) names the task.
  assert.deepEqual(f.runtime.noticeSubjectsFor(f.mission.id, { taskId: 'task_example', memberId: member.id }), [`mission:${f.mission.id}`], 'an unknown task falls back to the mission root rather than to nothing')
  const rootProposal = f.propose('Rooted')
  assert.deepEqual(f.runtime.noticeSubjectsFor(f.mission.id, { taskId: rootProposal.id }), [`${rootProposal.id}@${rootProposal.epoch}`], 'a task-scoped guard terminal names that task at its epoch')
})

test('R15-A1: the W3 stall notice names an unschedulable subject, and an escalation names its own', async t => {
  const f = await scenario(t)
  const member = await f.addMember('Builder')
  const actor = f.actorFor(member)
  // A cancelled prerequisite leaves its dependent pending but unschedulable:
  // the W3 stall class with a named subject (and no stall root, because the
  // dependent is not blocked).
  const dead = f.propose('Withdrawn', { assigneeId: member.id })
  await f.runtime.claim(actor, f.mission.id, dead.id)
  await f.runtime.cancel(f.owner, f.mission.id, { taskId: dead.id, reason: 'withdrawn' })
  const waiting = f.propose('Waiting on the withdrawn task')
  const row = f.runtime.store.get('tasks', waiting.id)
  row.dependencies = [dead.id]
  f.runtime.store.put('tasks', row)
  await sleep(300)
  const stall = f.notices().find(delivery => delivery.content.startsWith('Mission stalled'))
  assert.ok(stall, `the W3 stall notice fires: ${JSON.stringify(f.notices().map(delivery => delivery.content.slice(0, 50)))}`)
  assert.ok(Array.isArray(stall.subjects) && stall.subjects.length > 0, 'the stall notice names its subjects')
  assert.ok(stall.subjects.some(subject => subject.startsWith(`${waiting.id}@`) || subject.startsWith(`${dead.id}@`)), `the unschedulable work is the subject: ${JSON.stringify(stall.subjects)}`)
  assert.match(stall.content, new RegExp(waiting.id), 'the stall notice names the unschedulable task')
  // Pair: the guard-terminal escalation of the same round carries its own
  // subject, and the two notices do not consume one another's clock.
  let escalation
  try { escalation = f.runtime.escalate(actor, f.mission.id, { body: 'A worker needs the owner' }) }
  catch (error) { escalation = error }
  const raised = escalation instanceof Error ? undefined : f.notices().find(delivery => delivery.kind === 'escalation')
  assert.ok(raised, `the escalation delivery exists: ${String(escalation)}`)
  assert.deepEqual(raised.subjects, [`mission:${f.mission.id}`], 'a member with no assigned work escalates under the mission root')
})

test('R15-A2: a hung workers.start still names the pending task in a durable decision notice (failure-first)', async t => {
  const directory = await tempDirectory('swarm-hung-start-')
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  // Phase 1: a durable board with a running task a pending dependent waits on.
  // That state is legitimately waiting — no escalation and no witness yet — so
  // phase 2 cannot be suppressed by a stale witness from the previous life.
  const first = await scenario(t, { directory })
  const builder = await first.addMember('Builder')
  const pending = first.propose('Runs across the restart', { assigneeId: builder.id })
  await first.runtime.claim(first.actorFor(builder), first.mission.id, pending.id)
  first.propose('Waits on the restart', { assigneeId: builder.id, dependencies: [pending.id] })
  await sleep(150)
  assert.equal(first.runtime.store.get('tasks', pending.id).status, 'running', 'the task is durable and running before the restart')
  assert.equal(first.runtime.store.list('deliveries', first.mission.id).filter(delivery => delivery.content.startsWith('Mission stalled')).length, 0, 'a legitimately waiting board escalates nothing before the restart')
  const missionId = first.mission.id
  await first.runtime.dispose()

  // Phase 2: the same durable store, an adapter whose start() never settles.
  const workers = new Workers({ hangStart: true })
  const second = await fixture(t, { stallPassTimeoutMs: 60 }, workers, directory)
  const startedAt = Date.now()
  void second.runtime.start().catch(() => undefined)
  await sleep(500)
  const fresh = second.runtime.store.list('deliveries').filter(delivery => delivery.to === 'owner' && delivery.createdAt >= startedAt)
  assert.ok(fresh.length > 0, `a hung worker start produced ${fresh.length} owner notices (round-14 reproduction: zero)`)
  const named = fresh.find(delivery => Array.isArray(delivery.subjects) && delivery.subjects.some(subject => subject.startsWith(`${pending.id}@`)))
  assert.ok(named, `the pending task is named by a durable decision notice: ${JSON.stringify(fresh.map(delivery => ({ key: delivery.notice?.dedupKey, subjects: delivery.subjects, content: delivery.content.slice(0, 80) })))}`)
  assert.match(named.content, new RegExp(pending.id), 'the notice names the task it never reached')
  assert.equal(named.notice.class, 'decision', 'the pending task is named by a decision notice')
  const event = second.runtime.store.events(missionId, 200).filter(item => item.type === 'mission/stalled').at(-1)
  assert.ok(event, 'the wedged pass is still recorded durably')
})

test('R15-A2/A4 pair: an ordinary automatic dispatch produces no owner wake while the sweep runs', async t => {
  const workers = new Workers()
  const f = await scenario(t, { workers })
  const builder = await f.addMember('Builder')
  const task = f.propose('Ordinary work', { assigneeId: builder.id })
  await sleep(250)
  assert.equal(f.runtime.store.get('tasks', task.id).status, 'running', 'the task was dispatched automatically')
  const decisions = f.notices().filter(delivery => delivery.notice?.class === 'decision')
  assert.deepEqual(decisions, [], `a routine dispatch wakes nobody: ${JSON.stringify(decisions.map(delivery => delivery.content.slice(0, 60)))}`)
})

test('R15-A3: a stop with no recorded start is a named stall root, never silence', async t => {
  const f = await scenario(t)
  const sibling = await f.addMember('Sibling')
  const actor = f.actorFor(sibling)
  const healthy = f.propose('Healthy sibling', { assigneeId: sibling.id })
  await f.runtime.claim(actor, f.mission.id, healthy.id)
  const stuck = f.propose('Untimestamped stop')
  const blocked = f.block(stuck)
  const row = f.runtime.store.get('tasks', stuck.id)
  // A pre-upgrade durable row: the stop marker exists, its start timestamp does
  // not. The bound cannot be shown to hold, so the state must escalate.
  row.resumeAfterStop = { epoch: blocked.epoch, reason: 'handoff' }
  f.runtime.store.put('tasks', row)
  await sleep(250)
  const roots = f.notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('stall-root:'))
  assert.equal(roots.length, 1, `an untimestamped stop escalates instead of staying silent: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  assert.ok(roots[0].subjects.includes(`${row.id}@${row.epoch}`), `the root carries its subject: ${JSON.stringify(roots[0].subjects)}`)
  assert.match(roots[0].content, /no recorded start/, 'the notice states why the bound cannot hold')
  assert.match(roots[0].content, new RegExp(row.id), 'the notice names the task')
})

test('R15-A4: a ready task pinned to an adapter-busy assignee names the holder, not a false admission cause', async t => {
  let busyId
  const holder = await scenario(t, { workers: new Workers({ idle: memberId => memberId !== busyId }) })
  const pinned = await holder.addMember('Pinned holder')
  busyId = pinned.id
  const healthy = await holder.addMember('Healthy idle')
  const task = holder.propose('Pinned work', { assigneeId: pinned.id })
  await sleep(300)
  assert.equal(holder.runtime.store.get('tasks', task.id).status, 'pending', 'the pinned task could not be dispatched')
  const question = holder.notices().find(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('dispatch-question:'))
  assert.ok(question, `the dispatcher's question is recorded: ${JSON.stringify(holder.notices().map(delivery => delivery.content.slice(0, 60)))}`)
  assert.match(question.content, new RegExp(pinned.id), 'the notice names the member whose handle holds the task')
  assert.doesNotMatch(question.content, /admission limits or budget/, 'the false admission cause is gone')
  assert.ok(question.subjects.includes(`${task.id}@${task.epoch}`), `the notice carries the task subject: ${JSON.stringify(question.subjects)}`)
  assert.ok(healthy.id !== pinned.id, 'a healthy idle member exists beside the holder')
})

test('R15-A4 pair: an open attempt stays silent — the close-out path already nudges it', async t => {
  // The holder's handle is busy, so the sweep cannot dispatch the pinned task and
  // the question is the only thing that could speak. With an open attempt on the
  // row, it must not: the close-out path (W6) already owns that state.
  const f = await scenario(t, { workers: new Workers({ idle: memberId => !memberId.startsWith('holder-member') }) })
  const builder = await f.addMember('Builder')
  const task = f.propose('Mid-flight', { assigneeId: builder.id })
  const members = f.runtime.store.list('members', f.mission.id)
  const withoutAttempt = { ...f.runtime.store.get('tasks', task.id) }
  assert.notEqual(f.runtime.dispatchQuestion(f.mission.id, [withoutAttempt], members, [withoutAttempt]), undefined, 'the question answers for a task with no open attempt')
  const row = f.runtime.store.get('tasks', task.id)
  row.attempt = { id: 'attempt_open', epoch: row.epoch, ownerId: builder.id, leaseUntil: Date.now() + 60000 }
  f.runtime.store.put('tasks', row)
  assert.equal(f.runtime.dispatchQuestion(f.mission.id, [f.runtime.store.get('tasks', task.id)], members, [f.runtime.store.get('tasks', task.id)]), undefined, "an open attempt is the close-out path business, not a dispatch question")
  await sleep(250)
  const question = f.notices().find(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('dispatch-question:'))
  assert.equal(question, undefined, 'no owner decision is recorded while an open attempt exists')
  assert.deepEqual(f.notices().filter(delivery => delivery.notice?.class === 'decision'), [], 'an open attempt is not silence, so it owes no decision')
})

test('R15-A5: the stranded-inbox hatch drains or stays dispatchable, and the naive predicate strands it', async t => {
  // Unit: the decision function the adapter now uses.
  assert.deepEqual(strandedInboxDecision({ stopping: false, observations: 0, status: 'idle', hasPending: false }), { startable: true, drain: false })
  assert.deepEqual(strandedInboxDecision({ stopping: false, observations: 0, status: 'idle', hasPending: true }), { startable: true, drain: true }, 'an idle handle holding queued input is startable and is drained')
  assert.deepEqual(strandedInboxDecision({ stopping: true, observations: 0, status: 'idle', hasPending: true }), { startable: false, drain: false }, 'a stopping handle is never startable')
  assert.deepEqual(strandedInboxDecision({ stopping: false, observations: 1, status: 'idle', hasPending: true }), { startable: false, drain: false }, 'in-flight observations are work, not a stranded queue')
  assert.deepEqual(strandedInboxDecision({ stopping: false, observations: 0, status: 'running', hasPending: true }), { startable: false, drain: false }, 'a running handle is working')

  const state = { pending: new Set(), drained: [] }
  const naive = memberId => !state.pending.has(memberId)
  const stranded = await scenario(t, { workers: new Workers({ idle: naive }) })
  const strandedMember = await stranded.addMember('Stranded')
  state.pending.add(strandedMember.id)
  await stranded.addMember('Healthy sibling')
  const strandedTask = stranded.propose('Never dispatched', { assigneeId: strandedMember.id })
  await sleep(250)
  assert.equal(stranded.runtime.store.get('tasks', strandedTask.id).status, 'pending', 'the naive predicate strands the member (round-14 defect)')
  // Pair: the member is stranded by the adapter predicate, and the dispatcher
  // still names WHO holds the task instead of claiming an admission refusal.
  const strandedQuestion = stranded.notices().find(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('dispatch-question:'))
  assert.ok(strandedQuestion, 'the stranded holder is named even when the adapter refuses to start it')
  assert.match(strandedQuestion.content, new RegExp(strandedMember.id), 'the notice names the member whose handle holds the task')

  const fixedState = { pending: new Set(), drained: [] }
  const fixed = await scenario(t, { workers: new Workers({ idle: memberId => {
    const decision = strandedInboxDecision({ stopping: false, observations: 0, status: 'idle', hasPending: fixedState.pending.has(memberId) })
    if (decision.drain) { fixedState.drained.push(memberId); fixedState.pending.delete(memberId) }
    return decision.startable
  } }) })
  const drained = await fixed.addMember('Drained')
  fixedState.pending.add(drained.id)
  const task = fixed.propose('Dispatched after the drain', { assigneeId: drained.id })
  await sleep(250)
  assert.deepEqual(fixedState.drained, [drained.id], 'the queued item was drained through the hatch')
  assert.equal(fixed.runtime.store.get('tasks', task.id).status, 'running', 'and the member stayed dispatchable')
})

test('R15-A1/B: the owner ledger carries subjects, reports consumption unknown, and never collapses the three facts', async t => {
  const f = await scenario(t)
  const builder = await f.addMember('Builder')
  const root = f.block(f.propose('Ledger root', { assigneeId: builder.id }))
  await sleep(250)
  const ledger = f.runtime.noticeLedger(f.owner, f.mission.id, { limit: 10 })
  assert.ok(ledger.ledger.length > 0, 'the decision produced a durable ledger row')
  const row = ledger.ledger.find(entry => typeof entry.dedupKey === 'string' && entry.dedupKey.startsWith('stall-root:'))
  assert.ok(row, `the stall-root row is in the ledger: ${JSON.stringify(ledger.ledger.map(entry => entry.dedupKey))}`)
  assert.ok(Array.isArray(row.subjects) && row.subjects.includes(`${root.id}@${root.epoch}`), `the ledger row exposes the subjects: ${JSON.stringify(row.subjects)}`)
  assert.equal(row.consumption, 'unknown', 'consumption is reported unknown, never relabelled from transport')
  assert.equal(Object.hasOwn(row, 'resolved'), false, 'a transport fact never records resolution')
  assert.equal(Object.hasOwn(row, 'resolvedAt'), false, 'a transport fact never records resolution')
  // A read receipt (claimed) is transport acceptance only: the decision stays
  // pending and the ledger still reports consumption as unknown.
  const store = f.runtime.store.get('deliveries', row.deliveryId)
  assert.equal(store.to, 'owner')
  const reread = f.runtime.noticeLedger(f.owner, f.mission.id, { limit: 10 }).ledger.find(entry => entry.deliveryId === row.deliveryId)
  assert.equal(reread.consumption, 'unknown')
  assert.equal(reread.state === 'queued' || reread.state === 'claimed', true, 'the transport state stays a transport state')
})

test('R15-F1: a pending verification waits on its live source and is named only when the source closes', async t => {
  const f = await scenario(t)
  const builder = await f.addMember('Builder')
  const source = f.propose('Reviewed source', { assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, source.id)
  // Verification tasks carry `reviewOf`, not `dependencies`: the protocol puts the
  // prerequisite in the review link.
  // `research` keeps the fixture free of the integration-gap notice, whose
  // subjects legitimately name every implementation branch.
  const review = f.propose('Pending review', { assigneeId: builder.id, kind: 'research' })
  const row = f.runtime.store.get('tasks', review.id)
  row.kind = 'verification'; row.reviewOf = source.id; row.dependencies = []
  f.runtime.store.put('tasks', row)
  const namesReview = () => f.notices().filter(delivery => Array.isArray(delivery.subjects)
    && delivery.subjects.some(subject => subject.startsWith(`${row.id}@`)))
  await sleep(300)
  assert.deepEqual(namesReview(), [], `a review whose source is still being worked is legitimately waiting, not silence: ${JSON.stringify(namesReview().map(delivery => delivery.content.slice(0, 60)))}`)
  // Pair: closing the source makes the same review a named decision, with its subject.
  const closed = f.runtime.store.get('tasks', source.id)
  closed.status = 'cancelled'; f.runtime.store.put('tasks', closed)
  await sleep(350)
  assert.ok(namesReview().length > 0, 'a review whose source is terminal has no live path and is named')
})

test('R15-F2: a stale idle member row is reconciled with the live attempt, and the projection still shows the work', async t => {
  const f = await scenario(t)
  const builder = await f.addMember('Builder')
  const task = f.propose('Live attempt', { assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, task.id)
  // The reported pause/restart seam: the durable member row says idle while the
  // attempt is live on a running task.
  const stale = f.runtime.store.get('members', builder.id)
  stale.status = 'idle'
  f.runtime.store.put('members', stale)
  // The projection derives the phase from the durable task rows, not from the row.
  assert.equal(sidebarState(f.runtime.snapshot(f.owner, f.mission.id), 'connected', Date.now()).phase, 'working', 'the projection shows the live attempt even while the stored status is ambiguous')
  // The guard board derives the same fact for the model-facing progress action.
  const board = f.runtime.scheduling.guardBoard(f.mission.id)
  assert.equal(board.members.find(member => member.id === builder.id).status, 'working', 'the guard board derives a working member from the live attempt')
  // And the tick reconciles the durable row itself.
  await sleep(250)
  assert.equal(f.runtime.store.get('members', builder.id).status, 'working', 'the durable member row is reconciled with the live attempt')
  // Pair 1: a parked member is never rewritten by the reconciliation.
  const parked = await f.addMember('Parked')
  const parkedRow = f.runtime.store.get('members', parked.id)
  parkedRow.status = 'waiting'
  f.runtime.store.put('members', parkedRow)
  await sleep(200)
  assert.equal(f.runtime.store.get('members', parked.id).status, 'waiting', 'a parked member is never rewritten')
  assert.equal(f.runtime.store.get('members', builder.id).status, 'working', 'the working member stays working')
  // Pair 2: once the attempt is gone the derived views stop claiming work, and
  // the tick leaves the durable row alone: the reconciliation only ever upgrades,
  // so it cannot churn the F(S) key that the coverage and stall notices use. The
  // paths that END an attempt write `idle` (Attempts.onIdle, cancel/handoff).
  const done = f.runtime.store.get('tasks', task.id)
  done.status = 'submitted'; delete done.attempt
  f.runtime.store.put('tasks', done)
  await sleep(250)
  assert.notEqual(sidebarState(f.runtime.snapshot(f.owner, f.mission.id), 'connected', Date.now()).phase, 'working', 'the projection stops reporting work once the attempt is gone')
  const after = f.runtime.scheduling.guardBoard(f.mission.id)
  assert.equal(after.members.find(member => member.id === builder.id).status, 'working', 'the guard board preserves the stored row (upgrade-only, the retained DEADr D1 contract)')
  assert.equal(f.runtime.store.get('members', builder.id).status, 'working', 'the upgrade-only reconciliation does not downgrade the row')
  // The path that ends a turn writes the downgrade itself.
  f.runtime.workers.callbacks?.idle?.(builder.id)
  await sleep(150)
  assert.equal(f.runtime.store.get('members', builder.id).status, 'idle', 'the idle callback writes the downgrade')
})

test('R15-D1: a hung workers.start is named while a healthy sibling holds a live lease', async t => {
  // The verifier's D1 shape: one member is adapter-busy with a live attempt, the
  // pass is wedged inside workers.start, and a second task waits behind it. The
  // sibling's lease must not own the pending task's clock.
  const workers = new Workers({ idle: () => false })
  const f = await scenario(t, { workers, config: { stallPassTimeoutMs: 120 } })
  const builder = await f.addMember('Builder')
  const sibling = f.propose('Healthy sibling', { assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, sibling.id)
  const pending = f.propose('Waiting behind the wedge', { assigneeId: builder.id })
  const startedAt = Date.now()
  workers.options.hangStart = true
  await sleep(700)
  const fresh = f.notices().filter(delivery => delivery.createdAt >= startedAt)
  const named = fresh.find(delivery => typeof delivery.notice?.dedupKey === 'string'
    && (delivery.notice.dedupKey.startsWith('fallthrough:') || delivery.notice.dedupKey.startsWith('dispatch-question:'))
    && Array.isArray(delivery.subjects) && delivery.subjects.some(subject => subject.startsWith(`${pending.id}@`)))
  assert.ok(named, `the pending task is named while the sibling's lease is live: ${JSON.stringify(fresh.map(delivery => ({ key: delivery.notice?.dedupKey, subjects: delivery.subjects, content: delivery.content.slice(0, 70) })))}`)
  assert.equal(f.runtime.scheduling.passWedged(f.mission.id), true, 'the pass really is wedged past its declared bound')
  assert.equal(named.subjects.some(subject => subject.startsWith(`${sibling.id}@`)), false, 'the healthy sibling is not named as the stuck subject')
  assert.equal(f.runtime.store.get('tasks', pending.id).status, 'pending', 'the task really is still undispatched')
})

test('R15-D2: a hung workers.stop is bounded and named while its quiescence keeps the pass from releasing', async t => {
  const workers = new Workers()
  const f = await scenario(t, { workers, config: { stallPassTimeoutMs: 120 } })
  const builder = await f.addMember('Builder')
  const task = f.propose('Stop never acknowledges', { assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, task.id)
  // The stop hangs: the lease-expiry path fences the attempt, records the
  // quiescence marker and then waits forever on workers.stop, so the pass wedges
  // while `quiescencePending` keeps the mission's live work true.
  workers.options.hangStop = true
  const leased = f.runtime.store.get('tasks', task.id)
  leased.attempt.leaseUntil = Date.now() - 1
  f.runtime.store.put('tasks', leased)
  await sleep(700)
  const blocked = f.runtime.store.get('tasks', task.id)
  assert.equal(blocked.status, 'blocked', 'the hung stop leaves a durable quiescence transition')
  assert.ok(blocked.resumeAfterStop !== undefined, 'the stop marker is durable')
  const named = f.notices().find(delivery => Array.isArray(delivery.subjects)
    && delivery.subjects.some(subject => subject.startsWith(`${blocked.id}@`)))
  assert.ok(named, `the hung stop is named with its subject: ${JSON.stringify(f.notices().map(delivery => ({ key: delivery.notice?.dedupKey, subjects: delivery.subjects })))}`)
  assert.match(named.content, /awaited|no recorded start/, 'the notice states why the stop is no longer bounded')
})

test('R15-D3: the off-pass sweep does not invent a cause the dispatcher branch suppresses', async t => {
  // The round-14 dirty-workspace shape at rest: a ready pending task whose only
  // eligible member is adapter-busy. The pass stays silent because that member is
  // working; the sweep must not turn the same state into "no live path will
  // advance" just because it cannot ask the pass-scoped question.
  const f = await scenario(t, { workers: new Workers({ idle: () => false }) })
  const builder = await f.addMember('Builder')
  const task = f.propose('Pinned to a busy handle', { assigneeId: builder.id })
  await sleep(400)
  const decisions = f.notices().filter(delivery => delivery.notice?.class === 'decision')
  assert.deepEqual(decisions, [], `a ready task whose only eligible member is adapter-busy is working, not silence: ${JSON.stringify(decisions.map(delivery => delivery.content.slice(0, 80)))}`)
  assert.equal(f.runtime.store.get('tasks', task.id).status, 'pending', 'and it really was not dispatched')
  const fallthrough = f.notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('fallthrough:'))
  assert.deepEqual(fallthrough, [], 'the off-pass sweep never emits the pass-scoped fall-through for a dispatchable board')
})

test('R15-D4: the real adapter drains a stranded nextStep item through isIdle', async t => {
  // The shipped guard must be exercised on the real adapter surface: a stubbed
  // Harness context is enough to construct it, and the resident is injected so
  // the decision runs through HarnessWorkers.isIdle itself.
  const ctx = { on: () => () => {}, get: () => undefined, logger: { error: () => {}, warn: () => {}, info: () => {} } }
  const adapterRoot = await tempDirectory('swarm-adapter-')
  const adapter = new HarnessWorkers(ctx, { workspacesRoot: join(adapterRoot, 'ws'), checkTimeoutMs: 1000, maxCheckOutputBytes: 1000 })
  t.after(async () => { adapter.residents.delete('member_adapter'); await adapter.dispose().catch(() => undefined); await rm(adapterRoot, { recursive: true, force: true }) })
  adapter.bind({})
  const sent = []
  const pending = [{ id: 'msg_stranded', role: 'user', content: [], source: { kind: 'swarm', form: 'relay', missionId: 'mission_adapter', senderMemberId: 'owner', deliveryId: 'd1', deliveryKind: 'control' } }]
  const resident = {
    spec: { mission: { id: 'mission_adapter' }, member: { id: 'member_adapter', missionId: 'mission_adapter' } },
    abort: new AbortController(), opening: Promise.resolve(), observations: new Set(), delivered: new Set(), recoveryInbox: new Map(),
    journalWrites: Promise.resolve(), totalTokens: 0, usage: {}, lastPromptTokens: 0, compactionRequested: false,
    recordedExecutions: new WeakSet(), rejectedPendingStep: false, activities: new Map(),
  }
  const agent = {
    id: 'session_adapter', status: 'idle',
    inbox: { get nextStep() { return pending }, nextTurn: [], get hasPending() { return pending.length > 0 },
      remove(id) { const index = pending.findIndex(message => message.id === id); if (index === -1) return false; pending.splice(index, 1); return true } },
    send(message, target, wakeup) { sent.push({ id: message.id, target, wakeup }) },
    session: {},
  }
  adapter.residents.set('member_adapter', { ...resident, handle: { agent, dispose: async () => {} } })
  assert.equal(adapter.isIdle('member_adapter'), true, 'an idle handle holding queued input is startable')
  assert.deepEqual(sent, [{ id: 'msg_stranded', target: 'next-step', wakeup: true }], 'the stranded item is re-woken with its original identity')
  assert.deepEqual(pending, [], 'and it is no longer pending')
  // Pair: in-flight observations are work, not a stranded queue, and a stopping
  // resident is never startable.
  const busy = { ...resident, observations: new Set([Promise.resolve()]), handle: { agent, dispose: async () => {} } }
  adapter.residents.set('member_busy', busy)
  assert.equal(adapter.isIdle('member_busy'), false, 'in-flight observations are work')
  adapter.residents.set('member_stopping', { ...resident, stopping: Promise.resolve(), handle: { agent, dispose: async () => {} } })
  assert.equal(adapter.isIdle('member_stopping'), false, 'a stopping resident is never startable')
})

test('R15-B: the sidebar phase, recovery age and pending decision come from durable facts', () => {
  const mission = { id: 'm1', status: 'active', updatedAt: 1000, reason: undefined }
  const snapshot = (tasks, events = [], status = 'active') => ({ mission: { ...mission, status }, tasks, events })
  const disconnected = sidebarState(snapshot([], [], 'active'), 'reconnecting', 2000)
  assert.equal(disconnected.phase, 'disconnected')
  assert.equal(disconnected.stale, true)
  assert.equal(disconnected.modelTurn, false)

  assert.equal(sidebarState(snapshot([], [], 'completed'), 'connected', 2000).phase, 'finished')
  assert.equal(sidebarState(snapshot([], [], 'paused'), 'connected', 2000).phase, 'paused')

  const blocked = sidebarState(snapshot([{ id: 't1', epoch: 2, status: 'blocked', kind: 'implementation', dependencies: [], output: 'Needs a repair', createdAt: 1 }]), 'connected', 2000)
  assert.equal(blocked.phase, 'waiting-for-owner')
  assert.equal(blocked.decision.subject, 't1@2')
  assert.equal(blocked.decision.consumption, 'unknown')

  const stopping = sidebarState(snapshot([{ id: 't2', epoch: 3, status: 'blocked', kind: 'implementation', dependencies: [], createdAt: 1, resumeAfterStop: { epoch: 3, reason: 'handoff', at: 1500 } }]), 'connected', 2000)
  assert.equal(stopping.phase, 'recovering')
  assert.equal(stopping.recovery.subject, 't2@3')
  assert.equal(stopping.recovery.ageMs, 500, 'the recovery age comes from the durable stop timestamp')

  const unreviewed = sidebarState(snapshot([{ id: 't3', epoch: 1, status: 'submitted', kind: 'implementation', dependencies: [], createdAt: 1 }]), 'connected', 2000)
  assert.equal(unreviewed.phase, 'waiting-for-owner')
  assert.equal(unreviewed.decision.subject, 't3@1')

  const running = sidebarState(snapshot([{ id: 't4', epoch: 1, status: 'running', kind: 'implementation', dependencies: [], createdAt: 1, recoveryCount: 2, maxRecoveryAttempts: 3, attempt: { id: 'a', epoch: 1, ownerId: 'x', leaseUntil: 9 } }], [{ seq: 1, type: 'task/claimed', createdAt: 1700, data: { taskId: 't4' } }]), 'connected', 2000)
  assert.equal(running.phase, 'recovering')
  assert.equal(running.recovery.ageMs, 300)

  const working = sidebarState(snapshot([{ id: 't5', epoch: 1, status: 'running', kind: 'implementation', dependencies: [], createdAt: 1 }]), 'connected', 2000)
  assert.equal(working.phase, 'working')
  assert.equal(working.modelTurn, false)
})

/**
 * R16-A: wake precision. The fall-through classifier resolves a dependency
 * through the EFFECTIVE replacement lineage (`runtime.effectiveDependency`), not
 * the raw id, and a task whose own obligation is carried by a live replacement is
 * waiting rather than dead. The measured defect: `task.dependencies.some(unfinished)`
 * named a dependent seven times on the round-15 mission while the running repair
 * of its cancelled dependency was the live path.
 *
 * The tests below ENUMERATE the classifier over constructed boards instead of
 * sampling examples: every (predecessor status × repair status × subject status ×
 * stop shape × review shape) combination is materialised as durable rows and
 * compared with an independent reference that reads the runtime's lineage seam
 * directly, and the emitted notices are checked against the same rules.
 */

const TERMINAL_STATES = new Set(['accepted', 'cancelled'])

/**
 * R16-A1r2: whether the runtime's OWN lineage seam carries this task's
 * obligation — the effective dependency differs from the task and is not
 * terminal. This is `runtime.effectiveDependency`, the same walk the dispatcher
 * uses, so the coverage predicate is never checked against a test-local copy of
 * the production helper (that copy hid a non-transitive production helper: a
 * two-hop repair chain still covered the original through the seam while the
 * weakened classifier did not).
 */
function referenceCarried(runtime, missionId, task, tasks) {
  const tail = runtime.effectiveDependency(missionId, task.id, tasks)
  return tail.id !== task.id && !TERMINAL_STATES.has(tail.status)
}

/**
 * The independent reference for `waitsLegitimately`, written against the
 * runtime's own lineage seam (`effectiveDependency`) rather than the classifier.
 * Removing the lineage resolution from the classifier makes these disagree on
 * the cancelled-A / live-A' / B-depends-on-A board, and a non-transitive
 * replacement-coverage helper makes them disagree on the two-hop chain, which is
 * what the mutation proofs exercise.
 */
function referenceWaiting(runtime, missionId, task, tasks) {
  if (TERMINAL_STATES.has(task.status)) return false
  if (referenceCarried(runtime, missionId, task, tasks)) return true
  if (task.status === 'running') return task.attempt !== undefined && task.attempt.leaseUntil >= Date.now()
  if (task.status === 'submitted') {
    const submission = runtime.latestSubmission(missionId, task.id)
    return submission === undefined || submission.age < Math.max(runtime.config.tickMs, AUTO_REVIEW_GRACE_MS)
  }
  if (task.status === 'blocked' && task.resumeAfterStop?.epoch === task.epoch) {
    const stop = task.resumeAfterStop
    return stop.at !== undefined && Date.now() - stop.at <= runtime.stallPassTimeoutMs
  }
  if (task.status === 'pending' && task.reviewOf !== undefined) {
    const source = tasks.find(candidate => candidate.id === task.reviewOf)
    return source !== undefined && !TERMINAL_STATES.has(source.status)
  }
  return task.dependencies.some(id => {
    if (!tasks.some(candidate => candidate.id === id)) return false
    return !TERMINAL_STATES.has(runtime.effectiveDependency(missionId, id, tasks).status)
  })
}

/** The independent reference for `stallRoots` membership of one blocked task. */
function referenceStallRoot(runtime, missionId, task, tasks, stallPassTimeoutMs) {
  if (task.status !== 'blocked') return false
  if (referenceCarried(runtime, missionId, task, tasks)) return false
  if (task.reviewOf !== undefined) return false
  const stop = task.resumeAfterStop?.epoch === task.epoch ? task.resumeAfterStop : undefined
  if (stop === undefined) return true
  return stop.at === undefined || Date.now() - stop.at > stallPassTimeoutMs
}

test('R16-A1: the waiting classifier is enumerated over every constructed board and resolves through the effective lineage', async t => {
  const f = await fixture(t)
  const owner = { sessionId: 'r16-a1' }
  const mission = f.runtime.create(owner, { title: 'Lineage enumeration', objective: 'Enumerate the classifier', workspace: f.directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = f.runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const now = Date.now()
  let seq = 0
  const materialize = (id, status, extra = {}) => {
    const row = {
      id, missionId: mission.id, workstreamId: stream.id, title: id, objective: id, kind: 'implementation',
      dependencies: [], scope: ['src/'], acceptance: ['works'], checks: [], priority: 50, experiment: false,
      status, epoch: 1, proposedBy: 'owner', evidenceIds: [], createdAt: now, maxSteps: 10, maxFindings: 5, ...extra,
    }
    f.runtime.store.put('tasks', row)
    return row
  }
  const depStatuses = ['pending', 'running', 'submitted', 'blocked', 'accepted', 'cancelled', 'missing']
  const replacementStatuses = ['none', 'pending', 'running', 'submitted', 'accepted', 'cancelled']
  const subjectStatuses = ['pending', 'blocked', 'running', 'submitted']
  const stopShapes = ['none', 'in-bound', 'expired', 'unbounded']
  const reviewShapes = ['none', 'live', 'terminal', 'missing']
  const mismatches = []
  const naiveDivergences = []
  const naiveWaiting = (task, tasks) => {
    // The pre-fix rule: raw ids, no lineage, no replacement coverage.
    if (TERMINAL_STATES.has(task.status)) return false
    if (task.status === 'running') return task.attempt !== undefined && task.attempt.leaseUntil >= Date.now()
    if (task.status === 'submitted') {
      const submission = f.runtime.latestSubmission(mission.id, task.id)
      return submission === undefined || submission.age < Math.max(f.runtime.config.tickMs, AUTO_REVIEW_GRACE_MS)
    }
    if (task.status === 'blocked' && task.resumeAfterStop?.epoch === task.epoch) {
      const stop = task.resumeAfterStop
      return stop.at !== undefined && Date.now() - stop.at <= f.runtime.stallPassTimeoutMs
    }
    if (task.status === 'pending' && task.reviewOf !== undefined) {
      const source = tasks.find(candidate => candidate.id === task.reviewOf)
      return source !== undefined && !TERMINAL_STATES.has(source.status)
    }
    return task.dependencies.some(id => {
      const found = tasks.find(candidate => candidate.id === id)
      return found !== undefined && !TERMINAL_STATES.has(found.status)
    })
  }
  let checked = 0
  for (const depStatus of depStatuses) {
    for (const replacement of replacementStatuses) {
      for (const subjectStatus of subjectStatuses) {
        for (const stopShape of stopShapes) {
          for (const reviewShape of reviewShapes) {
            seq += 1
            const depId = `task_r16a1_dep_${seq}`
            const replacementId = `task_r16a1_rep_${seq}`
            const subjectId = `task_r16a1_sub_${seq}`
            const sourceId = `task_r16a1_src_${seq}`
            const tasks = []
            if (depStatus !== 'missing') tasks.push(materialize(depId, depStatus))
            if (replacement !== 'none') tasks.push(materialize(replacementId, replacement, { replaces: [depId] }))
            const subject = materialize(subjectId, subjectStatus, { dependencies: [depId] })
            if (stopShape !== 'none') {
              const at = stopShape === 'in-bound' ? Date.now() - 100 : stopShape === 'expired' ? Date.now() - 5000 : undefined
              subject.resumeAfterStop = { epoch: subject.epoch, reason: 'handoff', ...(at === undefined ? {} : { at }) }
              f.runtime.store.put('tasks', subject)
            }
            if (reviewShape !== 'none') {
              subject.reviewOf = sourceId
              if (reviewShape === 'live') tasks.push(materialize(sourceId, 'submitted'))
              else if (reviewShape === 'terminal') tasks.push(materialize(sourceId, 'cancelled'))
              f.runtime.store.put('tasks', subject)
            }
            tasks.push(subject)
            const got = f.runtime.notices.waitsLegitimately(subject, tasks)
            const want = referenceWaiting(f.runtime, mission.id, subject, tasks)
            if (got !== want) mismatches.push({ depStatus, replacement, subjectStatus, stopShape, reviewShape, got, want })
            const rootTask = { ...subject }
            const gotRoot = f.runtime.notices.stallRoots(tasks).some(root => root.id === subject.id)
            const wantRoot = referenceStallRoot(f.runtime, mission.id, rootTask, tasks, f.runtime.stallPassTimeoutMs)
            if (gotRoot !== wantRoot) mismatches.push({ kind: 'stallRoot', depStatus, replacement, subjectStatus, stopShape, reviewShape, gotRoot, wantRoot })
            if (naiveWaiting(subject, tasks) !== want) naiveDivergences.push({ depStatus, replacement, subjectStatus, stopShape, reviewShape })
            checked += 1
          }
        }
      }
    }
  }
  assert.equal(checked, depStatuses.length * replacementStatuses.length * subjectStatuses.length * stopShapes.length * reviewShapes.length, 'every combination is visited')

  // R16-A1r/A1r2: the SUBJECT-covered dimension, derived from the runtime's own
  // lineage seam. Every board above gives the subject a dependency edge (or a
  // stop/review that decides it), so the classifier's replacement-coverage branch
  // is never load-bearing there. These boards give the subject NO dependency, no
  // review and no stop: its own repair lineage is the only possible live path.
  //
  // Only BLOCKED subjects are enumerated here. Admission replaces only blocked or
  // cancelled work (pending, running and submitted sources are refused, and a
  // different-kind replacement is refused), so a covered pending/running/submitted
  // subject is unreachable through the public API and the seam reference
  // intentionally does not model the classifier's answer for it.
  //
  // The chains are the reachable shapes: one hop, and a two-hop chain through a
  // cancelled first repair — exactly where a non-transitive production coverage
  // helper stops covering the original while the seam still resolves it to the
  // running tail.
  const coverageChains = [
    { name: 'none', chain: [] },
    { name: 'one-hop pending', chain: ['pending'] },
    { name: 'one-hop running', chain: ['running'] },
    { name: 'one-hop submitted', chain: ['submitted'] },
    { name: 'one-hop accepted', chain: ['accepted'] },
    { name: 'one-hop cancelled', chain: ['cancelled'] },
    { name: 'two-hop live through cancelled', chain: ['cancelled', 'running'] },
    { name: 'two-hop accepted through cancelled', chain: ['cancelled', 'accepted'] },
    { name: 'two-hop terminal', chain: ['cancelled', 'cancelled'] },
  ]
  const coverageDriven = []
  let coverageChecked = 0
  for (const shape of coverageChains) {
    seq += 1
    const subjectId = `task_r16a1r_sub_${seq}`
    const tasks = []
    const subject = materialize(subjectId, 'blocked')
    const rows = []
    let previous = subjectId
    for (const [index, status] of shape.chain.entries()) {
      const row = materialize(`task_r16a1r_rep_${seq}_${index}`, status, { replaces: [previous] })
      rows.push(row)
      previous = row.id
    }
    tasks.push(...rows, subject)
    const got = f.runtime.notices.waitsLegitimately(subject, tasks)
    const want = referenceWaiting(f.runtime, mission.id, subject, tasks)
    if (got !== want) mismatches.push({ kind: 'subjectCoverage', shape: shape.name, got, want })
    const gotRoot = f.runtime.notices.stallRoots(tasks).some(root => root.id === subject.id)
    const wantRoot = referenceStallRoot(f.runtime, mission.id, { ...subject }, tasks, f.runtime.stallPassTimeoutMs)
    if (gotRoot !== wantRoot) mismatches.push({ kind: 'subjectCoverageRoot', shape: shape.name, gotRoot, wantRoot })
    // The board without the final repair row: when it stops waiting, the coverage
    // predicate is what makes this board live.
    if (want && rows.length > 0) {
      const withoutTail = tasks.filter(row => row.id !== rows.at(-1).id)
      if (!referenceWaiting(f.runtime, mission.id, subject, withoutTail)) coverageDriven.push(shape.name)
    }
    coverageChecked += 1
  }
  assert.deepEqual(mismatches.slice(0, 5), [], `the classifier agrees with the lineage reference on every constructed board including the subject-covered dimension (${mismatches.length} mismatches)`)
  assert.equal(coverageChecked, coverageChains.length, 'every subject-covered shape is visited')
  assert.ok(coverageDriven.includes('one-hop running'), `the blocked subject with a running repair is coverage-driven: ${JSON.stringify(coverageDriven)}`)
  assert.ok(coverageDriven.includes('two-hop live through cancelled'), `the two-hop chain through a cancelled repair is coverage-driven: ${JSON.stringify(coverageDriven)}`)

  // The enumeration is sensitive: the raw-id rule really disagrees on the measured
  // shape (a cancelled predecessor with a live repair), so the mutation proof
  // cannot pass vacuously.
  assert.ok(naiveDivergences.some(board => board.depStatus === 'cancelled' && board.replacement === 'running' && board.subjectStatus === 'pending'), `the raw-id rule diverges on the cancelled-A/live-A' shape: ${JSON.stringify(naiveDivergences.slice(0, 3))}`)
  assert.ok(naiveDivergences.length > 0, 'the enumeration contains boards the pre-fix rule gets wrong')
})

test("R16-A2: a cancelled predecessor with a live repair leaves its dependent waiting, and the fall-through returns only when the whole lineage is terminal", async t => {
  const f = await scenario(t)
  const builder = await f.addMember('Builder')
  const siblingMember = await f.addMember('Sibling')
  const sibling = f.propose('Healthy sibling', { assigneeId: siblingMember.id })
  await f.runtime.claim(f.actorFor(siblingMember), f.mission.id, sibling.id)
  const original = f.propose('Withdrawn original', { assigneeId: builder.id })
  const dependent = f.propose('Waits on the original', { assigneeId: builder.id })
  const dependentRow = f.runtime.store.get('tasks', dependent.id)
  dependentRow.dependencies = [original.id]
  f.runtime.store.put('tasks', dependentRow)
  await f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'withdrawn' })
  const repair = f.propose('Live repair of the original', { replaces: [original.id], assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, repair.id)
  const fallthroughs = () => f.notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('fallthrough:'))
  await sleep(300)
  assert.deepEqual(fallthroughs(), [], `the dependent waits on the running repair instead of being named: ${JSON.stringify(fallthroughs().map(delivery => delivery.content.slice(0, 80)))}`)
  assert.equal(f.runtime.dependencySatisfied(f.mission.id, original.id), false, 'the dispatcher still cannot start the dependent: its effective dependency is running, not accepted')
  const live = f.runtime.store.get('tasks', dependent.id)
  assert.equal(f.runtime.notices.waitsLegitimately(live, f.runtime.store.list('tasks', f.mission.id)), true, 'the dependent is waiting on the live repair, not dead')
  // Pair: closing the repair's whole lineage makes the same dependent a named
  // decision — the fall-through may appear only when no live path remains.
  const repairRow = f.runtime.store.get('tasks', repair.id)
  repairRow.status = 'cancelled'
  f.runtime.store.put('tasks', repairRow)
  await sleep(350)
  const named = fallthroughs()
  assert.equal(named.length, 1, `the dead lineage is named: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  assert.ok(named[0].subjects.includes(`${dependent.id}@${live.epoch}`), `the notice names the dependent at its epoch: ${JSON.stringify(named[0].subjects)}`)
})

/**
 * R16-A1r pair: the SUBJECT side of the same rule. A blocked task whose repair is
 * running has a live path through its own replacement lineage, so no owner
 * decision may name it and the stall-root classifier must not treat it as a root;
 * closing the whole lineage makes the same subject a named decision. This is the
 * pair the coverage-line deletion mutation must redden.
 */
test('R16-A1r pair: a blocked subject with a running repair is never named, and closing the repair names it', async t => {
  const f = await scenario(t)
  const builder = await f.addMember('Builder')
  const siblingMember = await f.addMember('Sibling')
  // research kind keeps the fixture free of integration-gap notices, whose
  // subjects legitimately name every implementation branch.
  const sibling = f.propose('Healthy sibling', { assigneeId: siblingMember.id, kind: 'research' })
  await f.runtime.claim(f.actorFor(siblingMember), f.mission.id, sibling.id)
  const source = f.block(f.propose('Blocked subject', { assigneeId: builder.id, kind: 'research' }))
  const repair = f.propose('Live repair of the subject', { replaces: [source.id], assigneeId: builder.id, kind: 'research' })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, repair.id)
  const namesSubject = () => f.notices().filter(delivery => Array.isArray(delivery.subjects) && delivery.subjects.some(subject => subject.startsWith(`${source.id}@`)))
  await sleep(300)
  const tasks = f.runtime.store.list('tasks', f.mission.id)
  assert.equal(f.runtime.notices.waitsLegitimately(f.runtime.store.get('tasks', source.id), tasks), true, 'the blocked subject waits on its running repair')
  assert.equal(f.runtime.notices.stallRoots(tasks).some(root => root.id === source.id), false, 'a subject carried by a live repair is not a stall root')
  assert.deepEqual(namesSubject(), [], `no owner decision names the covered subject: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  // Pair: closing the whole lineage makes the same subject a named decision.
  const repairRow = f.runtime.store.get('tasks', repair.id)
  repairRow.status = 'cancelled'
  f.runtime.store.put('tasks', repairRow)
  await sleep(350)
  const named = namesSubject()
  assert.ok(named.length > 0, `a subject whose repair lineage is terminal is named: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  assert.ok(named.some(delivery => Array.isArray(delivery.subjects) && delivery.subjects.includes(`${source.id}@${f.runtime.store.get('tasks', source.id).epoch}`)), 'the notice names the subject at its current epoch')
})

/**
 * R16-A1r2 pair: the two-hop repair chain through a cancelled first repair. The
 * original is blocked, its first repair is cancelled and its second repair is
 * running, so the runtime's own seam resolves the original to the running second
 * repair. A non-transitive production coverage helper loses the original there
 * and emits a stall-root decision for a subject whose lineage is live — this test
 * is the gate that must redden that mutation.
 *
 * The cancelled first repair is written directly (the same fixture idiom `block`
 * uses) so the second proposal is reached without a scheduling pass between the
 * two synchronous writes; the second repair is admitted through the real
 * proposal path, which is the shape admission allows.
 */
test('R16-A1r2 pair: a two-hop repair chain through a cancelled repair keeps the original unnamed until the whole chain closes', async t => {
  const f = await scenario(t)
  const builder = await f.addMember('Builder')
  const siblingMember = await f.addMember('Sibling')
  const sibling = f.propose('Healthy sibling', { assigneeId: siblingMember.id, kind: 'research' })
  await f.runtime.claim(f.actorFor(siblingMember), f.mission.id, sibling.id)
  const original = f.block(f.propose('Blocked original', { assigneeId: builder.id, kind: 'research' }))
  const firstRepair = f.propose('First repair', { replaces: [original.id], assigneeId: builder.id, kind: 'research' })
  const firstRow = f.runtime.store.get('tasks', firstRepair.id)
  firstRow.status = 'cancelled'
  f.runtime.store.put('tasks', firstRow)
  const secondRepair = f.propose('Second repair', { replaces: [firstRepair.id], assigneeId: builder.id, kind: 'research' })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, secondRepair.id)
  const coveredAt = Date.now()
  const namesOriginal = since => f.notices().filter(delivery => delivery.createdAt >= since
    && Array.isArray(delivery.subjects) && delivery.subjects.some(subject => subject.startsWith(`${original.id}@`)))
  await sleep(300)
  const tasks = f.runtime.store.list('tasks', f.mission.id)
  const tail = f.runtime.effectiveDependency(f.mission.id, original.id, tasks)
  assert.equal(tail.id, secondRepair.id, 'the runtime seam resolves the original through the cancelled first repair to the second')
  assert.equal(tail.status, 'running', 'the seam tail is the running second repair')
  assert.equal(f.runtime.notices.waitsLegitimately(f.runtime.store.get('tasks', original.id), tasks), true, 'the original waits on the running second repair')
  assert.equal(f.runtime.notices.stallRoots(tasks).some(root => root.id === original.id), false, 'a two-hop covered subject is not a stall root')
  assert.deepEqual(namesOriginal(coveredAt), [], `no owner decision names the covered original after the second repair was admitted: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  // Pair: closing the whole chain makes the original a named decision.
  const secondRow = f.runtime.store.get('tasks', secondRepair.id)
  secondRow.status = 'cancelled'
  f.runtime.store.put('tasks', secondRow)
  await sleep(350)
  const named = namesOriginal(coveredAt)
  assert.ok(named.length > 0, `closing the chain names the original: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  assert.ok(named.some(delivery => Array.isArray(delivery.subjects) && delivery.subjects.includes(`${original.id}@${f.runtime.store.get('tasks', original.id).epoch}`)), 'the notice names the original at its current epoch')
})

test('R16-A3: a blocked source enumerates the pending review that waits on it (reviewOf edge)', async t => {
  const f = await scenario(t)
  const builder = await f.addMember('Builder')
  const source = f.propose('Blocked source', { assigneeId: builder.id })
  const root = f.block(source)
  const review = f.propose('Review waiting on the source', { kind: 'research', assigneeId: builder.id })
  const reviewRow = f.runtime.store.get('tasks', review.id)
  reviewRow.kind = 'verification'
  reviewRow.reviewOf = root.id
  reviewRow.dependencies = []
  f.runtime.store.put('tasks', reviewRow)
  await sleep(250)
  const roots = f.notices().filter(delivery => typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('stall-root:'))
  assert.equal(roots.length, 1, `exactly one stall-root notice: ${JSON.stringify(f.notices().map(delivery => delivery.notice?.dedupKey))}`)
  const notice = roots[0]
  assert.match(notice.content, new RegExp(review.id), 'the notice enumerates the review as a dependent of the root')
  assert.ok(notice.subjects.includes(`${review.id}@${reviewRow.epoch}`), `the review is a named subject: ${JSON.stringify(notice.subjects)}`)
  assert.ok(notice.subjects.includes(`${root.id}@${root.epoch}`), 'the blocked source is the root subject')
  const event = f.runtime.store.events(f.mission.id, 200).filter(item => item.type === 'mission/stalled' && item.data?.cause === 'stall-root').at(-1)
  assert.ok(event.data.dependents.includes(review.id), `the durable stall event enumerates the review: ${JSON.stringify(event.data.dependents)}`)
})

test('R16-A4 pair: the off-pass sweep of a wedged pass applies the lineage-resolved waiting rule (D1/D2)', async t => {
  const workers = new Workers({ idle: () => false })
  const f = await scenario(t, { workers, config: { stallPassTimeoutMs: 120 } })
  const builder = await f.addMember('Builder')
  const original = f.propose('Withdrawn original', { assigneeId: builder.id })
  const dependent = f.propose('Waits on the original', { assigneeId: builder.id })
  const dependentRow = f.runtime.store.get('tasks', dependent.id)
  dependentRow.dependencies = [original.id]
  f.runtime.store.put('tasks', dependentRow)
  await f.runtime.cancel(f.owner, f.mission.id, { taskId: original.id, reason: 'withdrawn' })
  const repair = f.propose('Live repair of the original', { replaces: [original.id], assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, repair.id)
  const startedAt = Date.now()
  workers.options.hangStart = true
  await sleep(700)
  assert.equal(f.runtime.scheduling.passWedged(f.mission.id), true, 'the pass really is wedged past its declared bound')
  const fresh = f.notices().filter(delivery => delivery.createdAt >= startedAt)
  const falseWake = fresh.filter(delivery => typeof delivery.notice?.dedupKey === 'string'
    && delivery.notice.dedupKey.startsWith('fallthrough:')
    && Array.isArray(delivery.subjects) && delivery.subjects.some(subject => subject.startsWith(`${dependent.id}@`)))
  assert.deepEqual(falseWake, [], `the wedged sweep must not name a dependent whose repair is the live path: ${JSON.stringify(falseWake.map(delivery => delivery.content.slice(0, 80)))}`)
  assert.equal(f.runtime.store.get('tasks', dependent.id).status, 'pending', 'the dependent really is still undispatched')
  assert.equal(f.runtime.store.get('tasks', repair.id).status, 'running', 'the repair really is the live path')
})

test('R16-A5: the wake-precision projection counts decisions, false wakes and missed obligations from the store', async t => {
  const f = await scenario(t, { workers: new Workers({ idle: () => false }), config: { tickMs: 600000 } })
  const builder = await f.addMember('Builder')
  const now = Date.now()
  const put = (id, status, extra = {}) => {
    const row = {
      id, missionId: f.mission.id, workstreamId: f.stream.id, title: id, objective: id, kind: 'implementation',
      dependencies: [], scope: ['src/'], acceptance: ['works'], checks: [], priority: 50, experiment: false,
      status, epoch: 1, proposedBy: 'owner', evidenceIds: [], createdAt: now, maxSteps: 10, maxFindings: 5, ...extra,
    }
    f.runtime.store.put('tasks', row)
    return row
  }
  const original = put('task_r16a5_original', 'cancelled')
  const repair = put('task_r16a5_repair', 'running', { replaces: [original.id], attempt: { id: 'attempt_r16a5_repair', epoch: 1, ownerId: builder.id, leaseUntil: now + 600000 } })
  const dependent = put('task_r16a5_dependent', 'pending', { dependencies: [original.id] })
  const root = put('task_r16a5_root', 'blocked')
  const covered = put('task_r16a5_covered', 'blocked')
  const cover = put('task_r16a5_cover', 'running', { replaces: [covered.id], attempt: { id: 'attempt_r16a5_cover', epoch: 1, ownerId: builder.id, leaseUntil: now + 600000 } })
  const deliver = (id, family, subjects) => f.runtime.store.put('deliveries', {
    id, missionId: f.mission.id, from: 'runtime', to: 'owner', kind: 'control', content: `${family} decision`, createdAt: now,
    notice: { dedupKey: `${family}:${f.mission.id}:${subjects.join(',')}`, class: 'decision', sentAt: now, queuedAt: now }, subjects,
  })
  // The round-15 defect shape as a durable row: a fall-through naming the
  // dependent whose cancelled predecessor has a live repair.
  deliver('msg_r16a5_fallthrough', 'fallthrough', [`${dependent.id}@${dependent.epoch}`])
  // A stall root whose blocked subject is carried by a live replacement again.
  deliver('msg_r16a5_stall_root', 'stall-root', [`${covered.id}@${covered.epoch}`])
  const precision = f.runtime.wakePrecision(f.owner, f.mission.id)
  assert.equal(precision.decisions.byFamily.fallthrough, 1, 'the fall-through family is counted')
  assert.equal(precision.decisions.byFamily['stall-root'], 1, 'the stall-root family is counted')
  assert.equal(precision.falseWakes.byFamily.fallthrough, 1, 'a fall-through naming a live-waiting subject is a false wake')
  assert.equal(precision.falseWakes.byFamily['stall-root'], 1, 'a stall-root whose subject is covered by a live replacement is a false wake')
  assert.deepEqual([...precision.falseWakes.subjects].sort(), [`${covered.id}@${covered.epoch}`, `${dependent.id}@${dependent.epoch}`].sort())
  assert.equal(precision.missedObligations.subjects.includes(`${root.id}@${root.epoch}`), true, 'a blocked subject with no live path and no notice is a missed obligation')
  assert.equal(precision.missedObligations.subjects.includes(`${dependent.id}@${dependent.epoch}`), false, 'the waiting dependent is not a missed obligation')
  assert.equal(precision.missedObligations.subjects.includes(`${repair.id}@${repair.epoch}`), false, 'the running repair is live work')
  const board = f.runtime.store.list('tasks', f.mission.id)
  assert.equal(f.runtime.notices.stallRoots(board).some(candidate => candidate.id === covered.id), false, 'the covered blocked task is not a stall root')
  assert.equal(f.runtime.notices.waitsLegitimately(cover, board), true, 'the live cover is running work, not silence')
  assert.equal(cover.replaces[0], covered.id)
  // Pair: a fall-through naming a genuinely dead subject is not a false wake, and
  // stops being a missed obligation once a decision names it.
  deliver('msg_r16a5_fallthrough_dead', 'fallthrough', [`${root.id}@${root.epoch}`])
  const reread = f.runtime.wakePrecision(f.owner, f.mission.id)
  assert.equal(reread.decisions.byFamily.fallthrough, 2, 'the second fall-through is counted')
  assert.equal(reread.falseWakes.byFamily.fallthrough, 1, 'the dead subject is not counted as a false wake')
  assert.equal(reread.missedObligations.subjects.includes(`${root.id}@${root.epoch}`), false, 'and the decision clears the missed obligation')
  // A non-owner cannot read the instrument.
  assert.throws(() => f.runtime.wakePrecision(f.actorFor(builder), f.mission.id), /owner/)
})

test('R16-A6 pair: the lineage rule reaches an ordinary dependent but not a review identity (review grace × lineage)', async t => {
  const f = await scenario(t, { config: { tickMs: 600000 } })
  const now = Date.now()
  const put = (id, status, extra = {}) => {
    const row = {
      id, missionId: f.mission.id, workstreamId: f.stream.id, title: id, objective: id, kind: 'implementation',
      dependencies: [], scope: ['src/'], acceptance: ['works'], checks: [], priority: 50, experiment: false,
      status, epoch: 1, proposedBy: 'owner', evidenceIds: [], createdAt: now, maxSteps: 10, maxFindings: 5, ...extra,
    }
    f.runtime.store.put('tasks', row)
    return row
  }
  const source = put('task_r16a6_source', 'cancelled')
  const repair = put('task_r16a6_repair', 'running', { replaces: [source.id], attempt: { id: 'attempt_r16a6', epoch: 1, ownerId: 'member_r16a6', leaseUntil: now + 600000 } })
  const dependent = put('task_r16a6_dependent', 'pending', { dependencies: [source.id] })
  const review = put('task_r16a6_review', 'pending', { kind: 'verification', reviewOf: source.id, dependencies: [] })
  const tasks = f.runtime.store.list('tasks', f.mission.id)
  assert.equal(f.runtime.dependencySatisfied(f.mission.id, source.id), false, 'the effective dependency is running, not accepted')
  assert.equal(f.runtime.notices.waitsLegitimately(dependent, tasks), true, 'an ordinary dependent waits on the live repair')
  assert.equal(f.runtime.notices.waitsLegitimately(review, tasks), false, 'the review follows its source IDENTITY, which is terminal: a review of a cancelled task has no path even when the obligation is repaired')
  assert.equal(f.runtime.notices.stallRoots(tasks).some(root => root.id === review.id), false, 'a verdict record is never a stall root')
  assert.equal(f.runtime.notices.stallRoots(tasks).some(root => root.id === dependent.id), false, 'a pending dependent is never a stall root')
  assert.equal(repair.status, 'running')
})
