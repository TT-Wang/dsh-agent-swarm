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
 * For each blocker family this file produces the blocker through the real
 * runtime, checks the body is the diagnostic alone, checks every named call
 * against the published tool schemas, and performs every named exit through the
 * owner's registered tools until the source has a live review or is withdrawn.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertNamedCalls, ownerTools } from './refusal-inventory.mjs'
import { FakeClock, MISSION_ACCEPTANCE, events, makeRuntime, taskOf } from './faults/harness.mjs'

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
  return {
    ...f, actor, tool: await ownerTools(f),
    propose: (extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement the scoped change',
      kind: 'implementation', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: ['test -d .'], assigneeId: author.id, ...extra }),
    submit: async source => {
      const claimed = await runtime.claim(actor(author), mission.id, source.id)
      await runtime.submit(actor(author), mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
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
 * reason is the durable event's, and every tool the body names is a call whose
 * parameters `assertNamedCalls` can check.
 */
function blockedNotice(f, source, cause) {
  const decisions = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner'
    && delivery.notice?.dedupKey?.startsWith(`review-blocked:${f.mission.id}:${source.id}:`) && cause.test(delivery.notice.reason))
  assert.equal(decisions.length, 1, `one decision for this cause: ${JSON.stringify(f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner').map(delivery => delivery.content))}`)
  const [notice] = decisions
  assert.equal(notice.content, `[review_path_missing] task ${JSON.stringify(source.id)}: ${notice.notice.reason}`, 'the body is the diagnostic alone')
  assert.ok(events(f.runtime, f.mission.id, 'task/review-blocked').some(event => event.data.taskId === source.id && event.data.reason === notice.notice.reason), 'the reason is durable')
  assert.equal([...notice.content.matchAll(/swarm_\w+/g)].length, [...notice.content.matchAll(/swarm_\w+\(/g)].length, `every tool the body names is a call: ${notice.content}`)
  return notice
}

const withdraw = (f, { source }) => f.tool('swarm_cancel', { taskId: source.id, reason: 'Withdrawn instead of reviewed' })
const proposeReview = (f, { source }) => f.tool('swarm_propose', { workstreamId: f.stream.id, title: 'Review the source', objective: 'Independently review the submitted artifact',
  kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, outputs: [] })
const addMember = f => f.tool('swarm_add_member', { role: 'verification' })
const raiseMaxTasks = (f, maxTasks) => f.tool('swarm_budget', { budget: { ...f.budget, maxTasks }, reason: 'Room for the review' })

/** Submit a source and let the review grace pass on a board with nothing else to do. */
async function submitted(f, extra) {
  const source = f.propose(extra)
  await f.submit(source)
  await f.pass()
  return { source }
}

/** Each blocker family: how the runtime produces it, the cause it records, and a performer for every exit its notice names. */
const FAMILIES = [
  {
    name: 'the mission task budget is exhausted',
    options: { budget: { maxTasks: 1 } },
    block: f => submitted(f),
    cause: /^the mission task budget is exhausted \(1\/1 admitted tasks\), so no verification task can be admitted: /,
    exits: { swarm_budget: f => raiseMaxTasks(f, 2), swarm_cancel: withdraw },
  },
  {
    name: 'no live member other than the author can review',
    options: { members: ['Author'] },
    block: f => submitted(f),
    cause: /^no live member other than the author \(member_[\w-]+\) can review this artifact independently: /,
    exits: { swarm_add_member: addMember, swarm_cancel: withdraw },
  },
  {
    name: 'the owner withdrew the automatic review',
    block: async f => {
      const { source } = await submitted(f)
      const [automatic] = f.reviewsOf(source)
      assert.match(automatic.id, /^task_auto_review_/, 'the host admitted its review first')
      await f.tool('swarm_cancel', { taskId: automatic.id, reason: 'Not this review' })
      await f.pass()
      return { source }
    },
    cause: /^the automatically admitted review task_auto_review_\w+ was withdrawn: /,
    exits: { swarm_propose: proposeReview, swarm_cancel: withdraw },
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
    cause: /^automatic review admission failed: .* The refusal: \[check_requires_host\] /,
    exits: { swarm_propose: proposeReview, swarm_cancel: withdraw },
  },
  {
    name: 'a review deferred its verdict on the artifact',
    block: async f => {
      const source = f.propose()
      await f.submit(source)
      const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Review the source', objective: 'Independently review the scoped change',
        kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id })
      const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
      f.workers.checks = [{ command: '(verification preparation)', exitCode: 125, failureKind: 'infrastructure', output: 'Host verification could not execute: Error: EMFILE' }]
      assert.equal((await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason: 'Review against acceptance' })).status, 'blocked')
      f.workers.checks = [{ command: 'test -d .', exitCode: 0, output: 'ok' }]
      await f.pass()
      return { source, review }
    },
    cause: /^review task_[\w-]+ deferred its verdict on this artifact: the host could not execute a check: /,
    exits: { swarm_control: (f, { review }) => f.tool('swarm_control', { action: 'resume', taskId: review.id, reason: 'The host condition is repaired' }) },
  },
  {
    name: 'the rest of the board keeps running',
    block: async f => {
      const source = f.propose()
      await f.submit(source)
      // Unrelated work keeps running, so the host admits no review and the
      // transition classifier names the source.
      const running = f.propose({ title: 'Unrelated work', kind: 'research', checks: [], assigneeId: f.reviewer.id })
      await f.runtime.claim(f.actor(f.reviewer), f.mission.id, running.id)
      await f.pass()
      return { source }
    },
    cause: /^it has no live independent review path and cannot reach a verdict while the rest of the board keeps running: /,
    exits: { swarm_propose: proposeReview, swarm_cancel: withdraw },
  },
]

for (const family of FAMILIES) {
  test(`${family.name}: the notice names its own exits, and each one really works`, async t => {
    for (const [tool, perform] of Object.entries(family.exits)) {
      await t.test(tool, async t => {
        const f = await fixture(t, family.options)
        const blocked = await family.block(f)
        const { source } = blocked
        assert.equal(taskOf(f.runtime, source.id).status, 'submitted')
        assert.equal(f.live(source), false, 'the source has no live review')
        const notice = blockedNotice(f, source, family.cause)
        await assertNamedCalls(notice.content, Object.keys(family.exits))
        await perform(f, blocked)
        await f.pass()
        if (tool === 'swarm_cancel') assert.equal(taskOf(f.runtime, source.id).status, 'cancelled', 'the source is withdrawn')
        else assert.equal(f.live(source), true, `${tool} gives the source a live review`)
      })
    }
  })
}

test('beside running work the classifier names the runtime\'s blocker, and each exit in turn reaches a live review', async t => {
  const f = await fixture(t, { members: ['Author'] })
  const source = f.propose()
  await f.submit(source)
  // The author's other work keeps the board running, and nobody else can review.
  const running = f.propose({ title: 'Other work', kind: 'research', checks: [] })
  await f.runtime.claim(f.actor(f.author), f.mission.id, running.id)
  await f.pass()
  const first = blockedNotice(f, source, /^no live member other than the author/)
  await assertNamedCalls(first.content, ['swarm_add_member', 'swarm_cancel'])
  await addMember(f)
  await f.pass()
  assert.equal(taskOf(f.runtime, running.id).status, 'running', 'the board still runs, so the host admits no review itself')
  const next = blockedNotice(f, source, /keeps running: /)
  await assertNamedCalls(next.content, ['swarm_propose', 'swarm_cancel'])
  await proposeReview(f, { source })
  assert.equal(f.live(source), true)
})

test('an automatic review withdrawn on an exhausted budget names the budget first, and each exit in turn reaches a live review', async t => {
  const f = await fixture(t, { budget: { maxTasks: 2 } })
  const { source } = await submitted(f)
  const [automatic] = f.reviewsOf(source)
  await f.tool('swarm_cancel', { taskId: automatic.id, reason: 'Not this review' })
  await f.pass()
  // A review the owner admits needs a task slot, so the slot is named first.
  const first = blockedNotice(f, source, /^the mission task budget is exhausted \(2\/2 admitted tasks\)/)
  await assertNamedCalls(first.content, ['swarm_budget', 'swarm_cancel'])
  await raiseMaxTasks(f, 3)
  await f.pass()
  assert.deepEqual(f.reviewsOf(source).map(task => [task.id, task.status]), [[automatic.id, 'cancelled']], 'nothing is admitted over the owner\'s withdrawal')
  const next = blockedNotice(f, source, /was withdrawn: /)
  await assertNamedCalls(next.content, ['swarm_propose', 'swarm_cancel'])
  await proposeReview(f, { source })
  assert.equal(f.live(source), true)
})
