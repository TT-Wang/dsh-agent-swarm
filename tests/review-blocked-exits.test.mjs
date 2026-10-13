/**
 * Every review-path blocker names its own exit, the one that works for its
 * cause, and the review-blocked template appends none.
 *
 * At dfc0825 `NOTICE_TEMPLATES['review-blocked']` appended one fixed exit to
 * every blocker ("Admit an independent verification task with swarm_propose
 * (kind verification, reviewOf <source>) or cancel the source task"). It was
 * false when the task budget is exhausted (that proposal is refused), incomplete
 * when no independent member is live (the proposed review can never start), and
 * a second, contradicting exit after a deferral's own. The transition classifier
 * named every unreviewable source with one generic cause whatever held, and an
 * owner-withdrawn automatic review was named before the budget and member causes
 * its "admit a review" exit depends on.
 *
 * Each family below produces a blocker through the real runtime, on a board
 * with nothing else to do (the runtime's admission names it) or beside running
 * work. `followExits` then checks every decision the owner gets (the body is
 * the diagnostic alone, the reason is durable, every named call resolves in
 * the published tool schemas) and performs the calls of its first exit, as
 * named, through the owner's registered tools until the source has a live
 * review; a family whose exit uncovers a further cause lists that cause as its
 * next step, and a performed step's decision is no longer outstanding. Every
 * other exit a first decision names (the withdrawal, a deferral's repair) is
 * performed separately and must withdraw the source. A refusal met on the way
 * is followed through the exit it names.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNamedCalls, ownerTools, toolSchemaIndex } from './refusal-inventory.mjs'
import { FakeClock, MISSION_ACCEPTANCE, events, makeRuntime, taskOf } from './faults/harness.mjs'
import { sidebarState } from '../lib/types/client/progress.js'

const { definitions } = await toolSchemaIndex()

const MISSION = { title: 'Review exits', objective: 'Every review-path blocker names an exit that works', scope: ['**'], acceptance: MISSION_ACCEPTANCE }
const STREAM = { title: 'Exits', objective: 'Exercise each review-path blocker' }
const memberInput = (name, index) => ({ name, role: index === 0 ? 'implementation' : 'verification', maxOutputTokens: 5_000 })
/** The allocations only the primary agent chooses: a launched mission's admission requires them, and every exit that admits a task names them. */
const CHOSEN = { maxRecoveryAttempts: 2, checkTimeoutMs: 30_000 }

/**
 * A mission with the named members on the fake clock; the first member authors
 * every source. `launched` starts it from a plan, as `swarm_launch` does (the
 * default /agent-swarm path): the plan's members are admitted with it, and its
 * one deliverable (`planned`) is paired with an unassigned host review.
 * Otherwise the owner assembles it (`swarm_create`, `swarm_add_member`).
 */
async function fixture(t, { members = ['Author', 'Reviewer'], budget: overrides, launched = false } = {}) {
  const clock = new FakeClock()
  const { dir, runtime, workers, budget } = await makeRuntime(t, { clock, budget: overrides })
  await runtime.start()
  const owner = { sessionId: 'review-exits-owner' }
  const claim = { grantRoot: dir, source: 'session' }
  let mission, stream, added, planned
  if (launched) {
    const snapshot = await runtime.startPlan(owner, runtime.requestStart(owner, { commandId: 'review-exits', goal: MISSION.objective, workspace: dir }, claim).id, {
      ...MISSION, workspace: dir, budget, members: members.map((name, index) => ({ key: `m${index}`, ...memberInput(name, index) })),
      workstreams: [{ key: 'main', ...STREAM }],
      tasks: [{ key: 'impl', workstreamKey: 'main', title: 'Implement', objective: 'Implement the scoped change', kind: 'implementation', outputs: [], scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeKey: 'm0', checks: ['test -d .'], maxRecoveryAttempts: 2, checkTimeoutMs: 30_000 }],
    })
    mission = snapshot.mission
    ;[stream] = runtime.store.list('workstreams', mission.id)
    added = members.map((_, index) => snapshot.members.find(member => member.id.endsWith(`_m${index}`)))
    planned = snapshot.tasks.find(task => task.kind === 'implementation')
  } else {
    mission = runtime.create(owner, { ...MISSION, workspace: dir, budget }, claim)
    stream = runtime.workstream(owner, mission.id, STREAM)
    added = []
    for (const [index, name] of members.entries()) added.push(await runtime.addMember(owner, mission.id, memberInput(name, index)))
  }
  const [author, reviewer] = added
  await runtime.settle(mission.id)
  const f = { dir, runtime, workers, budget, clock, owner, mission, stream, author, reviewer, planned }
  const actor = member => ({ sessionId: member.sessionId })
  // On a launched mission the owner's every proposal carries the allocations the primary agent chooses.
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement the scoped change',
    kind: 'implementation', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: ['test -d .'], assigneeId: author.id, ...(launched ? CHOSEN : {}), ...extra })
  return {
    ...f, actor, propose, tool: await ownerTools(f), refused: [],
    submit: async source => {
      const claimed = await runtime.claim(actor(author), mission.id, source.id)
      await runtime.submit(actor(author), mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    },
    /** Unrelated work `member` keeps running, so the host admits no review and its admission pass names the running board. */
    run: async member => {
      const running = propose({ title: 'Unrelated work', kind: 'research', checks: [], assigneeId: member.id })
      await runtime.claim(actor(member), mission.id, running.id)
      return running
    },
    /** A member whose worker is gone: the durable phase every liveness rule reads. */
    stop: member => {
      const row = runtime.store.get('members', member.id)
      row.phase = 'stopped'
      runtime.store.transaction(() => runtime.store.put('members', row))
    },
    /** One scheduling tick past the review grace. */
    pass: async () => { clock.advance(1_500); await runtime.tick(); await runtime.settle(mission.id) },
    reviewsOf: source => runtime.store.list('tasks', mission.id).filter(task => task.reviewOf === source.id),
    live: source => runtime.reviewable(taskOf(runtime, source.id), runtime.store.list('tasks', mission.id)),
  }
}

/**
 * The one review-blocked decision on `source` whose recorded reason matches
 * `cause`: its body is the diagnostic of that reason and nothing else, the
 * reason is the durable event's, and every tool the body names is a call.
 */
function blockedNotice(f, source, cause) {
  const decisions = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner'
    && delivery.notice?.dedupKey?.startsWith(`review-blocked:${f.mission.id}:${source.id}:`) && cause.test(delivery.notice.reason))
  assert.equal(decisions.length, 1, `one decision for ${cause}: ${JSON.stringify(f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner').map(delivery => delivery.content))}`)
  const [notice] = decisions
  assert.equal(notice.content, `[review_path_missing] task ${JSON.stringify(source.id)}: ${notice.notice.reason}`, 'the body is the diagnostic alone')
  assert.ok(events(f.runtime, f.mission.id, 'task/review-blocked').some(event => event.data.taskId === source.id && event.data.reason === notice.notice.reason), 'the reason is durable')
  assert.equal([...notice.content.matchAll(/swarm_\w+/g)].length, [...notice.content.matchAll(/swarm_\w+\(/g)].length, `every tool the body names is a call: ${notice.content}`)
  return notice
}

/** The calls a text names, in order, each with the parameters it names (`name`, or `name: <JSON value>`; an object's fields are its own). */
const namedCalls = text => [...text.matchAll(/(swarm_\w+)\(([^()]*)\)/g)].map(([, tool, params]) =>
  [tool, Object.fromEntries([...params.replace(/\{[^}]*\}/g, '{}').matchAll(/([A-Za-z]\w*)(?::\s*("[^"]*"|\[\]))?/g)].map(([, param, given]) => [param, given === undefined ? undefined : JSON.parse(given)]))])
/** The alternative exits a decision names (`X, or Y`; `X; or, if ..., Y`), each the calls it performs in order. */
const alternatives = text => text.split(/[,;] or,? /).map(namedCalls).filter(calls => calls.length)

/**
 * Perform one call a decision names, as named: the parameters it names (a
 * value it gives as given) and those its published schema requires, each with
 * this board's value, and no other. A call that needs a parameter it does not
 * name is refused here, as it would be for the owner. A refusal names its own
 * exit: its calls are checked and performed the same way, then the refused
 * call is made again, once.
 */
async function perform(f, source, reason, tool, named) {
  const value = {
    // The ceiling the decision says to raise, by one.
    budget: () => {
      const ceiling = /raise (max\w+) with swarm_budget/.exec(reason)[1]
      const budget = f.runtime.mission(f.mission.id).budget
      return { ...budget, [ceiling]: budget[ceiling] + 1 }
    },
    taskId: () => tool === 'swarm_control' ? /^review (\S+) deferred/.exec(reason)[1] : source.id,
    taskBudget: () => ({ checkTimeoutMs: 90_000 }),
    // The allocations an exit names; a swarm_create mission accepts them too.
    maxRecoveryAttempts: () => CHOSEN.maxRecoveryAttempts,
    checkTimeoutMs: () => CHOSEN.checkTimeoutMs,
    reviewOf: () => source.id,
    replaces: () => [source.id],
    // The corrected command a repair holds.
    checks: () => ['test -f README.md'],
    kind: () => taskOf(f.runtime, source.id).kind,
    acceptance: () => taskOf(f.runtime, source.id).acceptance,
    reason: () => 'Follow the exit the decision names',
    role: () => 'verification',
    maxOutputTokens: () => 5_000,
    workstreamId: () => f.stream.id,
    title: () => 'Review the source',
    objective: () => 'Independently review the submitted artifact',
    scope: () => ['**'],
  }
  const params = new Set([...Object.keys(named), ...definitions.get(tool).parameters.required.filter(param => param !== 'missionId')])
  const args = Object.fromEntries([...params].map(param => [param, named[param] ?? value[param]()]))
  return f.tool(tool, args).catch(async refusal => {
    f.refused.push(refusal.message)
    await assertNamedCalls(refusal.message, namedCalls(refusal.message).map(([exit]) => exit))
    for (const [exit, params] of namedCalls(refusal.message)) await perform(f, source, refusal.message, exit, params)
    return f.tool(tool, args)
  })
}

/**
 * Walk a family's steps: each step's decision is checked (the cause, the body,
 * exactly the calls expected, each resolving in its tool's schema) and the
 * calls of its first alternative are performed in order, then one tick runs;
 * the decision is then no longer outstanding, so no reminder repeats a cause
 * its exit removed. The last step's exits must leave the source with a live
 * review, with no action a decision did not name, meeting exactly the
 * refusals the family lists (each followed through the exit it names).
 */
async function followExits(f, { source }, { steps, refused = [] }) {
  for (const [cause, calls] of steps) {
    assert.equal(f.live(source), false, `the source has no live review before ${cause}`)
    const notice = blockedNotice(f, source, cause)
    await assertNamedCalls(notice.content, calls)
    for (const [tool, named] of alternatives(notice.content)[0]) await perform(f, source, notice.notice.reason, tool, named)
    await f.pass()
    assert.equal(f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), f.runtime.store.get('deliveries', notice.id)), false, `the exit retires its decision: ${notice.content}`)
  }
  assert.equal(f.live(source), true, 'the exits named give the source a live review')
  assert.equal(f.refused.length, refused.length, `the refusals met: ${JSON.stringify(f.refused)}`)
  refused.forEach((pattern, index) => assert.match(f.refused[index], pattern))
}

/** Publish one committed transition with no scheduling pass, as an ordinary publication or as the one after a wedged pass was named. */
const publish = async (f, wedged) => {
  if (wedged) f.runtime.notices.expectWedgedRelease(f.mission.id)
  f.runtime.notices.transition(f.mission.id)
  await new Promise(resolve => queueMicrotask(resolve))
}
const decisionsOn = (f, task) => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.notice?.dedupKey?.startsWith(`review-blocked:${f.mission.id}:${task.id}:`))

/** Submit a source and let the review grace pass, beside `running`'s unrelated work when given. */
async function submitted(f, { running, source = f.propose() } = {}) {
  await f.submit(source)
  const blocked = { source, running: running === undefined ? undefined : await f.run(running(f)) }
  await f.pass()
  return blocked
}

/** The host admits its review on a board with nothing else to do; the owner withdraws it. */
async function withdrawn(f, { running, stop } = {}) {
  const { source } = await submitted(f)
  const [automatic] = f.reviewsOf(source)
  assert.match(automatic.id, /^task_auto_review_/, 'the host admitted its review first')
  if (stop !== undefined) f.stop(stop(f))
  await f.tool('swarm_cancel', { taskId: automatic.id, reason: 'Not this review' })
  if (running !== undefined) await f.run(running(f))
  await f.pass()
  return { source }
}

/**
 * The host admits its review on a board with nothing else to do, and every
 * attempt at it runs out its lease with no verdict until the review's recovery
 * limit leaves it blocked: the one review the host admits for this need is dead.
 */
async function exhausted(f, { running } = {}) {
  const { source } = await submitted(f)
  const [automatic] = f.reviewsOf(source)
  assert.match(automatic.id, /^task_auto_review_/, 'the host admitted its review first')
  for (let round = 0; round < 6 && f.live(source); round++) {
    if (taskOf(f.runtime, automatic.id).status === 'pending') await f.runtime.claim(f.actor(f.reviewer), f.mission.id, automatic.id)
    f.clock.advance(f.runtime.config.leaseMs)
    await f.pass()
  }
  const review = taskOf(f.runtime, automatic.id)
  assert.deepEqual([review.status, review.recoveryCount, review.resumeAfterStop], ['blocked', review.maxRecoveryAttempts, undefined], 'the review is blocked at its recovery limit')
  if (running !== undefined) await f.run(running(f))
  await f.pass()
  return { source }
}

/** A submission as an older build left it: no artifact, so the host's admission skips it and only the classifier names it. */
async function legacy(f) {
  const source = f.propose()
  await f.submit(source)
  f.runtime.store.transaction(() => { const row = taskOf(f.runtime, source.id); delete row.artifact; f.runtime.store.put('tasks', row) })
  await f.pass()
  return { source }
}

/**
 * The host's own review of the source is refused: the source's check was
 * worker-runnable when it was admitted, and its script now resolves to a
 * nested sandbox, so the review that copies it is refused.
 */
async function refusedAdmission(f) {
  const source = f.propose({ checks: ['npm run verify'] })
  await writeFile(join(f.dir, 'package.json'), JSON.stringify({ scripts: { verify: 'sandbox-exec -f verify.sb node verify.js' } }))
  await f.submit(source)
  await f.pass()
  return { source }
}

/** The host rows a deferred review's check left, per failure kind. */
const DEFERRAL = {
  infrastructure: { command: '(verification preparation)', exitCode: 125, failureKind: 'infrastructure', output: 'Host verification could not execute: Error: EMFILE' },
  timeout: { command: 'test -d .', exitCode: 124, failureKind: 'timeout', output: '[swarm] Execution timed out after 30000ms' },
  unrunnable: { command: 'test -d .', exitCode: 127, failureKind: 'unrunnable', output: 'sh: test: command not found' },
}

/** An independent review of the source defers its verdict on a check of `kind`. */
async function deferred(f, { running, kind = 'infrastructure' } = {}) {
  const source = f.propose()
  await f.submit(source)
  const review = f.propose({ title: 'Review the source', objective: 'Independently review the scoped change', kind: 'verification', reviewOf: source.id, checks: undefined, assigneeId: f.reviewer.id })
  const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  f.workers.checks = [DEFERRAL[kind]]
  assert.equal((await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason: 'Review against acceptance' })).status, 'blocked')
  f.workers.checks = [{ command: 'test -d .', exitCode: 0, output: 'ok' }]
  if (running !== undefined) await f.run(running(f))
  await f.pass()
  return { source }
}

const author = f => f.author
const reviewer = f => f.reviewer
/** On a launched mission the owner first withdraws the planned deliverable (its paired review goes with it), so the board holds only what `block` adds. */
const unplanned = block => async f => {
  await f.tool('swarm_cancel', { taskId: f.planned.id, reason: 'Superseded by the work below' })
  return block(f)
}
const BUDGET = n => new RegExp(`^the mission task budget is exhausted \\(${n}/${n} admitted tasks\\), so no verification task can be admitted: `)
const NO_MEMBER = /^no live member other than the author \(member_[\w-]+\) can review this artifact independently: add /
const WITHDRAWN = /^the automatically admitted review task_auto_review_\w+ was withdrawn: /
const NOT_LIVE = /^the automatically admitted review task_auto_review_\w+ is blocked and cannot reach a verdict: /
const DEFERRED = /^review task_[\w-]+ deferred its verdict on this artifact: the host could not execute a check: /
const DEFERRED_TIMEOUT = /^review task_[\w-]+ deferred its verdict on this artifact: a check reached its deadline: /
const DEFERRED_UNRUNNABLE = /^review task_[\w-]+ deferred its verdict on this artifact: a command could not run in the clean verification checkout: /
const REPLACE = ['swarm_control', 'swarm_cancel', 'swarm_propose']
const TASK_CEILING = /^\[mission_task_budget_exhausted\] Mission task budget exhausted: raise maxTasks with swarm_budget\(budget, reason\), then /
const RUNNING = /^it has no live independent review path and cannot reach a verdict while the rest of the board keeps running: /
const REFUSED = /^automatic review admission failed: .* The refusal: \[check_requires_host\] /
const PROPOSE_OR_CANCEL = ['swarm_propose', 'swarm_cancel']

/**
 * Each blocker family: how the runtime produces it, and each decision its exits
 * lead through, with the calls that decision names.
 */
const FAMILIES = [
  {
    name: 'the mission task budget is exhausted',
    options: { budget: { maxTasks: 1 } },
    block: f => submitted(f),
    steps: [[BUDGET(1), ['swarm_budget', 'swarm_cancel']]],
  },
  {
    name: 'no live member other than the author can review',
    options: { members: ['Author'] },
    block: f => submitted(f),
    steps: [[NO_MEMBER, ['swarm_add_member', 'swarm_cancel']]],
  },
  {
    name: 'no live member other than the author can review, and every worker slot is taken',
    options: { members: ['Author'], budget: { maxWorkers: 1 } },
    block: f => submitted(f),
    // The add meets the worker ceiling, whose refusal names the raise.
    steps: [[NO_MEMBER, ['swarm_add_member', 'swarm_cancel']]],
    refused: [/^\[mission_worker_budget_exhausted\] Mission worker budget exhausted: raise maxWorkers with swarm_budget\(budget, reason\), then /],
  },
  {
    name: 'on a launched mission, no live member other than the author can review its planned deliverable',
    options: { launched: true },
    block: f => { f.stop(f.reviewer); return submitted(f, { source: f.planned }) },
    // The host paired the deliverable at launch; the added member makes that review live.
    steps: [[NO_MEMBER, ['swarm_add_member', 'swarm_cancel']]],
  },
  {
    name: 'the owner withdrew the automatic review',
    block: f => withdrawn(f),
    steps: [[WITHDRAWN, PROPOSE_OR_CANCEL]],
  },
  // A launched mission's admission requires the primary agent's allocations,
  // which each exit that admits a task names on every mission.
  {
    name: 'on a launched mission, the owner withdrew the automatic review',
    options: { launched: true },
    block: unplanned(f => withdrawn(f)),
    steps: [[WITHDRAWN, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'on a launched mission, the automatic review\'s admission is refused',
    options: { launched: true },
    block: unplanned(refusedAdmission),
    steps: [[REFUSED, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'on a launched mission, the rest of the board keeps running',
    options: { launched: true },
    block: unplanned(f => submitted(f, { running: reviewer })),
    steps: [[RUNNING, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'on a launched mission, a review deferred its verdict at a check deadline',
    options: { launched: true },
    block: unplanned(f => deferred(f, { kind: 'timeout' })),
    steps: [[DEFERRED_TIMEOUT, ['swarm_budget', ...REPLACE]]],
  },
  {
    name: 'on a launched mission, a review deferred its verdict on a command that could not run',
    options: { launched: true },
    block: unplanned(f => deferred(f, { kind: 'unrunnable' })),
    steps: [[DEFERRED_UNRUNNABLE, REPLACE]],
  },
  // The host admits one review per need: once that review cannot reach a verdict the owner decides, on a stalled board as beside running work.
  {
    name: 'the automatic review is blocked at its recovery limit',
    block: f => exhausted(f),
    steps: [[NOT_LIVE, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'on a launched mission, the automatic review is blocked at its recovery limit',
    options: { launched: true },
    block: unplanned(f => exhausted(f)),
    steps: [[NOT_LIVE, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'beside running work, the automatic review is blocked at its recovery limit',
    block: f => exhausted(f, { running: author }),
    steps: [[NOT_LIVE, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'the automatic review is blocked at its recovery limit and the task budget is exhausted',
    options: { budget: { maxTasks: 2 } },
    block: f => exhausted(f),
    // A review the owner admits needs a task slot, so the slot is named first.
    steps: [[BUDGET(2), ['swarm_budget', 'swarm_cancel']], [NOT_LIVE, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'the owner withdrew the automatic review and no independent member is live',
    block: f => withdrawn(f, { stop: reviewer }),
    // A review the owner admits needs a member who may own it, so the member is named first.
    steps: [[NO_MEMBER, ['swarm_add_member', 'swarm_cancel']], [WITHDRAWN, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'the owner withdrew the automatic review and the task budget is exhausted',
    options: { budget: { maxTasks: 2 } },
    block: f => withdrawn(f),
    // A review the owner admits needs a task slot, so the slot is named first.
    steps: [[BUDGET(2), ['swarm_budget', 'swarm_cancel']], [WITHDRAWN, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'the automatic review\'s admission is refused',
    block: f => refusedAdmission(f),
    steps: [[REFUSED, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'a review deferred its verdict on the artifact',
    block: f => deferred(f),
    steps: [[DEFERRED, ['swarm_control']]],
  },
  {
    name: 'a review deferred its verdict on the artifact, and the task budget is exhausted',
    options: { budget: { maxTasks: 2 } },
    block: f => deferred(f),
    // Resuming the deferred review needs no task slot, so the deferral is named first.
    steps: [[DEFERRED, ['swarm_control']]],
  },
  {
    name: 'a review deferred its verdict at a check deadline, and the task budget is exhausted',
    options: { budget: { maxTasks: 2 } },
    block: f => deferred(f, { kind: 'timeout' }),
    // The raise and the resume need no task slot; the repair does, and its refusal names the raise.
    steps: [[DEFERRED_TIMEOUT, ['swarm_budget', ...REPLACE]]],
    otherRefused: [TASK_CEILING],
  },
  {
    name: 'a review deferred its verdict on a command that could not run, and the task budget is exhausted',
    options: { budget: { maxTasks: 2 } },
    block: f => deferred(f, { kind: 'unrunnable' }),
    steps: [[DEFERRED_UNRUNNABLE, REPLACE]],
    otherRefused: [TASK_CEILING],
  },
  {
    name: 'the rest of the board keeps running',
    block: f => submitted(f, { running: reviewer }),
    steps: [[RUNNING, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'beside running work, no live member other than the author can review',
    options: { members: ['Author'] },
    block: f => submitted(f, { running: author }),
    // The board still runs once the member is added, so the host admits no review itself.
    steps: [[NO_MEMBER, ['swarm_add_member', 'swarm_cancel']], [RUNNING, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'beside running work, the mission task budget is exhausted',
    options: { budget: { maxTasks: 2 } },
    block: f => submitted(f, { running: reviewer }),
    // The raise frees the slot; the board still runs, so the host admits no review itself.
    steps: [[BUDGET(2), ['swarm_budget', 'swarm_cancel']], [RUNNING, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'beside running work, the owner withdrew the automatic review',
    block: f => withdrawn(f, { running: reviewer }),
    steps: [[WITHDRAWN, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'beside running work, a review deferred its verdict on the artifact',
    block: f => deferred(f, { running: author }),
    steps: [[DEFERRED, ['swarm_control']]],
  },
  // The host reviews only a captured artifact, so on a board with nothing else to do a legacy submission still has the owner's exits.
  {
    name: 'a submission an older build left without an artifact, on a board with nothing else to do',
    block: legacy,
    steps: [[RUNNING, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'a submission an older build left without an artifact, and the task budget is exhausted',
    options: { budget: { maxTasks: 1 } },
    block: legacy,
    // The raise changes no task: the classifier still names the cause that holds next.
    steps: [[BUDGET(1), ['swarm_budget', 'swarm_cancel']], [RUNNING, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'beside running work, a submission an older build left without an artifact has a blocked review that did not defer',
    block: async f => {
      const source = f.propose()
      await f.submit(source)
      const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Review the source', objective: 'Independently review the scoped change',
        kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id })
      // The rows as that build left them: no artifact on the submission, and a
      // review blocked by something other than a deferral (no recovery record).
      f.runtime.store.transaction(() => {
        const row = taskOf(f.runtime, source.id); delete row.artifact; f.runtime.store.put('tasks', row)
        f.runtime.store.put('tasks', { ...taskOf(f.runtime, review.id), status: 'blocked' })
      })
      await f.run(f.author)
      await f.pass()
      return { source }
    },
    // A deferral is a recorded recovery of the source's artifact; neither exists here.
    steps: [[RUNNING, PROPOSE_OR_CANCEL]],
  },
]

test('beside running work, no reminder repeats the budget cause the owner removed', async t => {
  const f = await fixture(t, { budget: { maxTasks: 2 } })
  const { source } = await submitted(f, { running: reviewer })
  const notice = blockedNotice(f, source, BUDGET(2))
  f.runtime.notices.obligationFollowupMs = 0
  await perform(f, source, notice.notice.reason, 'swarm_budget', namedCalls(notice.content)[0][1])
  for (let pass = 0; pass < 3; pass++) await f.pass()
  const reminders = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.notice?.trigger === 'owner-decision-unresolved')
  assert.deepEqual(reminders.filter(delivery => delivery.notice.reason === notice.id).map(delivery => delivery.content), [], 'the removed cause is never reminded')
  const running = blockedNotice(f, source, RUNNING)
  assert.ok(reminders.some(delivery => delivery.notice.reason === running.id), 'the cause that holds now is the one reminded')
})

test('a refused admission, then running work, then a stall: the refusal is again the recorded cause and the outstanding decision', async t => {
  const f = await fixture(t)
  const { source } = await refusedAdmission(f)
  const refusal = blockedNotice(f, source, REFUSED)
  const running = await f.run(f.reviewer)
  await f.pass()
  const busy = blockedNotice(f, source, RUNNING)
  await f.tool('swarm_cancel', { taskId: running.id, reason: 'Stop the unrelated work' })
  await f.pass()
  assert.equal(f.runtime.reviewPathStalled(f.runtime.store.list('tasks', f.mission.id), f.runtime.store.list('members', f.mission.id)), true, 'the board stalls again')
  assert.deepEqual(f.reviewsOf(source), [], 'and the host\'s admission is refused again')
  const recorded = events(f.runtime, f.mission.id, 'task/review-blocked').filter(event => event.data.taskId === source.id).map(event => event.data.reason)
  assert.deepEqual(recorded, [refusal.notice.reason, busy.notice.reason, refusal.notice.reason], 'the recorded cause follows the derived one')
  const outstanding = notice => f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), f.runtime.store.get('deliveries', notice.id))
  assert.deepEqual([outstanding(refusal), outstanding(busy)], [true, false], 'the refusal is outstanding again, the running board no longer')
  assert.equal(sidebarState(f.runtime.snapshot(f.owner, f.mission.id), 'connected', f.clock.now()).decision.content, refusal.notice.reason, 'and the sidebar shows it in full')
  blockedNotice(f, source, REFUSED)
})

test('a wedged pass keeps the host\'s admission from running: the classifier names a legacy source on any pass, and a source with an artifact only once that admission recorded its need', async t => {
  const f = await fixture(t, { budget: { maxTasks: 2 } })
  const source = f.propose(), legacy = f.propose({ title: 'Implement the rest' })
  await f.submit(source)
  await f.submit(legacy)
  // The row as an older build left it: a submission without an artifact, which the host's admission skips.
  f.runtime.store.transaction(() => { const row = taskOf(f.runtime, legacy.id); delete row.artifact; f.runtime.store.put('tasks', row) })
  await f.runtime.settle(f.mission.id)
  f.clock.advance(1_500)
  // Past the review grace with no scheduling pass: only the classifier can name the board.
  await publish(f, false)
  blockedNotice(f, legacy, BUDGET(2))
  assert.deepEqual(decisionsOn(f, source), [], 'an ordinary pass leaves a source with an artifact to the host\'s admission')
  await publish(f, true)
  assert.deepEqual(decisionsOn(f, source), [], 'a wedged pass never pre-empts an admission that has not recorded the need yet')
  // The host's admission records the need and names its blocker; a wedged pass then restates nothing.
  await f.pass()
  assert.equal(events(f.runtime, f.mission.id, 'task/review-missing').filter(event => event.data.taskId === source.id).length, 1)
  const told = blockedNotice(f, source, BUDGET(2))
  await publish(f, true)
  assert.deepEqual(decisionsOn(f, source).map(delivery => delivery.id), [told.id], 'the recorded need keeps its one decision')
  await followExits(f, { source }, { steps: [[BUDGET(2), ['swarm_budget', 'swarm_cancel']]] })
})

test('while a wedged pass keeps the host\'s admission from running, the classifier names a recorded need by the blocker that holds: the next cause once the owner removed the first, and none when the host would admit its review', async t => {
  for (const members of [['Author'], ['Author', 'Reviewer']]) {
    const f = await fixture(t, { members, budget: { maxTasks: 1 } })
    const { source } = await submitted(f)
    const first = blockedNotice(f, source, BUDGET(1))
    // The owner frees a task slot, and no pass runs to admit a review or name the next cause.
    f.runtime.store.transaction(() => { const mission = f.runtime.mission(f.mission.id); f.runtime.store.put('missions', { ...mission, budget: { ...mission.budget, maxTasks: 2 } }) })
    await publish(f, true)
    assert.equal(f.runtime.reviewPathStalled(f.runtime.store.list('tasks', f.mission.id), f.runtime.store.list('members', f.mission.id)), true, 'nothing runs on the board')
    if (members.length === 1) {
      // No member may review it: the cause the admission would name next is true of the board now.
      const next = blockedNotice(f, source, NO_MEMBER)
      assert.deepEqual(decisionsOn(f, source).map(delivery => delivery.id), [first.id, next.id], 'the wedged classifier names the cause that holds now')
      assert.deepEqual([first, next].map(notice => f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), f.runtime.store.get('deliveries', notice.id))), [false, true], 'and it alone is outstanding')
      await followExits(f, { source }, { steps: [[NO_MEMBER, ['swarm_add_member', 'swarm_cancel']]] })
    } else {
      // An independent member is live: the host admits its review at its next pass, so no cause holds and none is invented.
      assert.deepEqual(decisionsOn(f, source).map(delivery => delivery.id), [first.id], 'no decision states a cause the board does not have')
      await f.pass()
      assert.match(f.reviewsOf(source).map(review => review.id).join(), /^task_auto_review_\w+$/, 'the next pass admits the host review')
      assert.equal(f.live(source), true)
    }
  }
})

test('two sources share the last task slot: the first gets the host review, the second the budget decision, and no decision is stale when written', async t => {
  const f = await fixture(t, { budget: { maxTasks: 3 } })
  const first = f.propose(), second = f.propose({ title: 'Implement the rest' })
  await f.submit(first)
  await f.submit(second)
  await f.pass()
  assert.match(f.reviewsOf(first).map(review => review.id).join(), /^task_auto_review_\w+$/, 'the first source takes the last slot')
  const decisions = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.notice?.class === 'decision')
  // The host judged the second source after the first's admission: it proposed no review the budget refuses.
  assert.deepEqual(decisions.filter(delivery => delivery.notice.dedupKey.startsWith(`review-blocked:${f.mission.id}:${second.id}:`)).map(delivery => delivery.notice.reason),
    [blockedNotice(f, second, BUDGET(3)).notice.reason], 'the second source has the one budget decision')
  assert.deepEqual(decisions.filter(delivery => !f.runtime.ownerDeliveryRelevant(f.runtime.mission(f.mission.id), delivery)).map(delivery => delivery.content), [], 'no decision is stale when written')
  assert.deepEqual(f.reviewsOf(second), [])
})

test('two sources on a board with nothing else to do and a free task slot each: one pass admits both host reviews and names no blocker', async t => {
  const f = await fixture(t)
  const first = f.propose(), second = f.propose({ title: 'Implement the rest' })
  await f.submit(first)
  await f.submit(second)
  await f.pass()
  // The pass judges the stall once, as it found the board: the first admission does not make the second source's board a running one.
  for (const source of [first, second]) {
    assert.match(f.reviewsOf(source).map(review => review.id).join(), /^task_auto_review_\w+$/, `the host admitted a review of ${source.title}`)
    assert.deepEqual(events(f.runtime, f.mission.id, 'task/review-blocked').filter(event => event.data.taskId === source.id).map(event => event.data.reason), [], `no blocker is recorded for ${source.title}`)
    assert.deepEqual(f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.notice?.dedupKey?.startsWith(`review-blocked:${f.mission.id}:${source.id}:`)).map(delivery => delivery.content), [], `no decision names ${source.title}`)
  }
})

for (const family of FAMILIES) {
  test(`${family.name}: each decision names its own exits, and performing them reaches a live review`, async t => {
    const f = await fixture(t, family.options)
    const blocked = await family.block(f)
    assert.equal(taskOf(f.runtime, blocked.source.id).status, 'submitted')
    await followExits(f, blocked, family)
  })
  const [[cause, calls]] = family.steps
  if (calls.includes('swarm_cancel')) {
    test(`${family.name}: every other exit the first decision names withdraws the source`, async t => {
      for (let index = 1, count = 2; index < count; index++) {
        const f = await fixture(t, family.options)
        const { source } = await family.block(f)
        const notice = blockedNotice(f, source, cause)
        const exits = alternatives(notice.content)
        count = exits.length
        for (const [tool, named] of exits[index]) await perform(f, source, notice.notice.reason, tool, named)
        await f.pass()
        assert.equal(taskOf(f.runtime, source.id).status, 'cancelled', `the source is withdrawn by ${exits[index].map(([tool]) => tool)}`)
        assert.equal(f.refused.length, (family.otherRefused ?? []).length, `the refusals met: ${JSON.stringify(f.refused)}`)
        ;(family.otherRefused ?? []).forEach((pattern, at) => assert.match(f.refused[at], pattern))
      }
    })
  }
}
