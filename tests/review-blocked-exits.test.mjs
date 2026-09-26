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
 * work (the transition classifier names it). `followExits` then checks every
 * decision the owner gets (the body is the diagnostic alone, the reason is
 * durable, every named call resolves in the published tool schemas) and
 * performs each call it names, as named, through the owner's registered tools
 * until the source has a live review; a family whose exit uncovers a further
 * cause lists that cause as its next step. The withdrawal a first decision
 * names is performed separately and must withdraw the source.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNamedCalls, ownerTools, toolSchemaIndex } from './refusal-inventory.mjs'
import { FakeClock, MISSION_ACCEPTANCE, events, makeRuntime, taskOf } from './faults/harness.mjs'

const { definitions } = await toolSchemaIndex()

/** A mission with the named members on the fake clock; the first member authors every source. */
async function fixture(t, { members = ['Author', 'Reviewer'], budget: overrides } = {}) {
  const clock = new FakeClock()
  const { dir, runtime, workers, budget } = await makeRuntime(t, { clock, budget: overrides })
  await runtime.start()
  const owner = { sessionId: 'review-exits-owner' }
  const mission = runtime.create(owner, { title: 'Review exits', objective: 'Every review-path blocker names an exit that works', workspace: dir,
    scope: ['**'], acceptance: MISSION_ACCEPTANCE, budget }, { grantRoot: dir, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Exits', objective: 'Exercise each review-path blocker' })
  const added = []
  for (const [index, name] of members.entries()) added.push(await runtime.addMember(owner, mission.id, { name, role: index === 0 ? 'implementation' : 'verification', maxOutputTokens: 5_000 }))
  const [author, reviewer] = added
  await runtime.settle(mission.id)
  const f = { dir, runtime, workers, budget, clock, owner, mission, stream, author, reviewer }
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement the scoped change',
    kind: 'implementation', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: ['test -d .'], assigneeId: author.id, ...extra })
  return {
    ...f, actor, propose, tool: await ownerTools(f),
    submit: async source => {
      const claimed = await runtime.claim(actor(author), mission.id, source.id)
      await runtime.submit(actor(author), mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    },
    /** Unrelated work `member` keeps running, so the host admits no review and the transition classifier names the source. */
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

/** The calls a decision names, in order, each with the parameters it names (`name`, or `name: <JSON value>`). */
const namedCalls = text => [...text.matchAll(/(swarm_\w+)\(([^()]*)\)/g)].map(([, tool, params]) =>
  [tool, Object.fromEntries([...params.matchAll(/([A-Za-z]\w*)(?::\s*("[^"]*"|\[\]))?/g)].map(([, param, given]) => [param, given === undefined ? undefined : JSON.parse(given)]))])

/**
 * Perform one call a decision names, as named: the parameters it names (a
 * value it gives as given) and those its published schema requires, each with
 * this board's value, and no other. A call that needs a parameter it does not
 * name is refused here, as it would be for the owner.
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
    reviewOf: () => source.id,
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
  return f.tool(tool, Object.fromEntries([...params].map(param => [param, named[param] ?? value[param]()])))
}

/**
 * Walk a family's steps: each step's decision is checked (the cause, the body,
 * exactly the calls expected, each resolving in its tool's schema) and every
 * call it names but the withdrawal is performed in order, then one tick runs.
 * The last step's exits, and what the board does after them when the family
 * says (`afterExits`), must leave the source with a live review.
 */
async function followExits(f, blocked, { steps, afterExits }) {
  const { source } = blocked
  for (const [cause, calls] of steps) {
    assert.equal(f.live(source), false, `the source has no live review before ${cause}`)
    const notice = blockedNotice(f, source, cause)
    await assertNamedCalls(notice.content, calls)
    for (const [tool, named] of namedCalls(notice.content)) if (tool !== 'swarm_cancel') await perform(f, source, notice.notice.reason, tool, named)
    await f.pass()
  }
  if (afterExits !== undefined) { await afterExits(f, blocked); await f.pass() }
  assert.equal(f.live(source), true, 'the exits named give the source a live review')
}

/** Submit a source and let the review grace pass, beside `running`'s unrelated work when given. */
async function submitted(f, { running } = {}) {
  const source = f.propose()
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

/** An independent review of the source defers its verdict: the host could not execute its check. */
async function deferred(f, { running } = {}) {
  const source = f.propose()
  await f.submit(source)
  const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Review the source', objective: 'Independently review the scoped change',
    kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id })
  const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  f.workers.checks = [{ command: '(verification preparation)', exitCode: 125, failureKind: 'infrastructure', output: 'Host verification could not execute: Error: EMFILE' }]
  assert.equal((await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason: 'Review against acceptance' })).status, 'blocked')
  f.workers.checks = [{ command: 'test -d .', exitCode: 0, output: 'ok' }]
  if (running !== undefined) await f.run(running(f))
  await f.pass()
  return { source }
}

const author = f => f.author
const reviewer = f => f.reviewer
const BUDGET = n => new RegExp(`^the mission task budget is exhausted \\(${n}/${n} admitted tasks\\), so no verification task can be admitted: `)
const NO_MEMBER = /^no live member other than the author \(member_[\w-]+\) can review this artifact independently: add /
const WITHDRAWN = /^the automatically admitted review task_auto_review_\w+ was withdrawn: /
const DEFERRED = /^review task_[\w-]+ deferred its verdict on this artifact: the host could not execute a check: /
const RUNNING = /^it has no live independent review path and cannot reach a verdict while the rest of the board keeps running: /
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
    name: 'the owner withdrew the automatic review',
    block: f => withdrawn(f),
    steps: [[WITHDRAWN, PROPOSE_OR_CANCEL]],
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
    block: async f => {
      // The source's check was worker-runnable when it was admitted; its script
      // now resolves to a nested sandbox, so the review that copies it is refused.
      const source = f.propose({ checks: ['npm run verify'] })
      await writeFile(join(f.dir, 'package.json'), JSON.stringify({ scripts: { verify: 'sandbox-exec -f verify.sb node verify.js' } }))
      await f.submit(source)
      await f.pass()
      return { source }
    },
    steps: [[/^automatic review admission failed: .* The refusal: \[check_requires_host\] /, PROPOSE_OR_CANCEL]],
  },
  {
    name: 'a review deferred its verdict on the artifact',
    block: f => deferred(f),
    steps: [[DEFERRED, ['swarm_control']]],
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
    steps: [[BUDGET(2), ['swarm_budget', 'swarm_cancel']]],
    // The raise frees the slot; the board state the owner was told about is
    // unchanged (F(S) holds no ceiling), so the host admits the review once the
    // unrelated work ends and the board has nothing else to do.
    afterExits: (f, { running }) => f.tool('swarm_cancel', { taskId: running.id, reason: 'The unrelated work ends' }),
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
]

for (const family of FAMILIES) {
  test(`${family.name}: each decision names its own exits, and performing them reaches a live review`, async t => {
    const f = await fixture(t, family.options)
    const blocked = await family.block(f)
    assert.equal(taskOf(f.runtime, blocked.source.id).status, 'submitted')
    await followExits(f, blocked, family)
  })
  const [[cause, calls]] = family.steps
  if (calls.includes('swarm_cancel')) {
    test(`${family.name}: the withdrawal the decision names withdraws the source`, async t => {
      const f = await fixture(t, family.options)
      const { source } = await family.block(f)
      const notice = blockedNotice(f, source, cause)
      const [[, named]] = namedCalls(notice.content).filter(([tool]) => tool === 'swarm_cancel')
      await perform(f, source, notice.notice.reason, 'swarm_cancel', named)
      await f.pass()
      assert.equal(taskOf(f.runtime, source.id).status, 'cancelled', 'the source is withdrawn')
    })
  }
}
