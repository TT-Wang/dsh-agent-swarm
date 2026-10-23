/**
 * A challenge disputes only a claim a verdict can still judge (`unjudgeable`,
 * src/task-graph.ts): one that is current (no rework archived it), not refuted
 * (by a rejection or by supersession), of a task that is not cancelled, and of
 * work a verdict judges rather than a review's own evidence. Any other is
 * refused with one coded refusal, `[evidence_not_judgeable]`, which records
 * nothing and names the exit the caller actually has.
 *
 * The three paths the 2026-10-22 self-review reproduced (CORE-02), each of
 * which a challenge used to act on:
 *  (a) a claim a rejection refuted, before the owner resumed: the challenge
 *      cancelled the rejecting review, so the owner's in-place rework was
 *      refused with a false task_needs_replacement;
 *  (b1) a claim superseded within its task: the challenge re-opened the
 *      accepted source, blocked its running dependent and cancelled the
 *      accepting review, and the first acceptance had already verified the
 *      superseded claim before refuting it (F3-B);
 *  (b2) a claim of a replaced, cancelled task: the challenge fenced a running
 *      dependent of the original although its accepted repair stood.
 * A review's own claim is judged by no verdict either: a dispute of one left an
 * accepted review submitted, or a challenge open, that nothing could resolve.
 * Completion reads the same predicate (`completionError`, src/board.ts).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { PolicyError } from '../lib/policy-error.js'
import { completionError } from '../lib/board.js'
import { judgeable, unjudgeable } from '../lib/task-graph.js'
import { assessText, toolSchemaIndex } from './refusal-inventory.mjs'
import { FakeClock, FakeWorkers, makeRuntime } from './faults/harness.mjs'

/** Every attempt captures its own commit, so a reworked artifact is a new commit. */
class CommitPerAttempt extends FakeWorkers {
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async captureArtifact(member, task) {
    return { commit: createHash('sha1').update(`${task.id}@${task.epoch}`).digest('hex'), baseCommit: 'b'.repeat(40), workspace: member.workspace, changedPaths: ['src/a.ts'] }
  }
}

/** An owner, an author and the only independent reviewer of the author's work. */
async function fixture(t) {
  const { dir, runtime, workers, budget } = await makeRuntime(t, { workers: new CommitPerAttempt(), clock: new FakeClock(),
    config: { maxEvents: 5000, maxTasksPerMember: 100, checkTimeoutMs: undefined }, budget: { maxTasks: 100, maxExperiments: 2 } })
  await runtime.start()
  const owner = { sessionId: 'judgeability-owner' }
  const mission = runtime.create(owner, { title: 'Judgeability', objective: 'Dispute only what a verdict can judge', workspace: dir, scope: ['src/'], acceptance: ['works'], budget }, { grantRoot: dir, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const current = task => runtime.store.get('tasks', task.id)
  const evidence = claim => runtime.store.get('evidence', claim.id)
  const events = type => runtime.store.events(mission.id, 5000).filter(event => event.type === type)
  const eventsOf = claim => runtime.store.events(mission.id, 5000).filter(event => event.type !== 'evidence/published' && event.type.startsWith('evidence/') && event.data.evidenceId === claim.id)
  const propose = (title, extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title,
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], covers: ['c1'], checks: ['test'], assigneeId: author.id, ...extra })
  const proposeReview = source => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: `Review ${source.title}`,
    objective: 'Independent review', kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: source.id })
  const claim = (member, task) => runtime.claim(actor(member), mission.id, task.id)
  /** One host-backed claim on `claimed`'s attempt. */
  async function publish(member, claimed, text, supersedes) {
    const runId = await workers.callbacks.toolRun(member.id, { tool: 'bash', arguments: { command: 'node --test' }, result: { exitCode: 0, output: 'ok' }, isError: false })
    return runtime.publish(actor(member), mission.id, { taskId: claimed.id, attemptId: claimed.attempt.id, claim: text, outcome: 'supported', toolRunIds: [runId], ...(supersedes === undefined ? {} : { supersedes }) })
  }
  const submitClaimed = claimed => runtime.submit(actor(author), mission.id, { taskId: claimed.id, attemptId: claimed.attempt.id, output: 'candidate' })
  /** Claim, publish one claim when given, and submit, as the author. */
  async function submit(task, text) {
    const claimed = await claim(author, task)
    const published = text === undefined ? undefined : await publish(author, claimed, text)
    await submitClaimed(claimed)
    return published
  }
  /** The reviewer records `verdict` on `review`. */
  async function verify(review, verdict, reason = verdict === 'accept' ? 'The artifact meets the criterion' : 'The artifact misses the criterion') {
    const claimed = await claim(reviewer, review)
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict, reason })
  }
  const challenge = (caller, claimed) => runtime.challenge(caller, mission.id, { evidenceId: claimed.id, reason: 'Counter-evidence changes the conclusion', toolRunIds: [] })
  /** Assert a challenge refusal and its exit; returns the message. */
  async function refused(caller, claimed, because, exit) {
    const index = await toolSchemaIndex()
    let message
    assert.throws(() => challenge(caller, claimed), error => {
      assert.ok(error instanceof PolicyError)
      assert.equal(error.code, 'evidence_not_judgeable')
      assert.equal(error.category, 'conflict_error')
      assert.ok(error.message.startsWith(`[evidence_not_judgeable] Evidence ${claimed.id} ${because}, so no verdict can judge it again`), error.message)
      assert.ok(error.message.endsWith(exit), error.message)
      assert.deepEqual(assessText(error.message, index), [], 'the exit resolves in the published tool schema')
      message = error.message
      return true
    })
    assert.equal(evidence(claimed).challenges.length, 0, 'a refused challenge records no dispute')
    return message
  }
  /** Why a claim `review` refuted by rejecting `task` is refused. */
  const refutedBy = (task, review) => `was refuted when review ${review.id} rejected task ${task.id} at commit ${current(task).artifact.commit}`
  return { runtime, workers, owner, mission, author, reviewer, actor, current, evidence, events, eventsOf, propose, proposeReview, claim, publish,
    submitClaimed, submit, verify, challenge, refused, refutedBy }
}

test('the rule: archived, then cancelled, then refuted (superseded when a claim refuted it), then a review\'s own claim', () => {
  const rejection = { commit: 'c'.repeat(40), epoch: 1, reviewTaskId: 'review', reason: 'misses it', evidenceIds: ['old'] }
  const work = { status: 'running', kind: 'implementation', rejections: [rejection] }
  const claim = (id, status = 'unverified', refutedBy) => ({ id, status, ...(refutedBy === undefined ? {} : { refutedBy }) })
  assert.deepEqual(unjudgeable(claim('old', 'refuted'), { ...work, status: 'cancelled' }), { kind: 'archived', rejection })
  assert.deepEqual(unjudgeable(claim('live', 'refuted', 'next'), { ...work, status: 'cancelled' }), { kind: 'cancelled' })
  assert.deepEqual(unjudgeable(claim('live', 'refuted', 'next'), work), { kind: 'superseded', by: 'next' })
  assert.deepEqual(unjudgeable(claim('live', 'refuted'), { ...work, kind: 'verification' }), { kind: 'refuted' })
  assert.deepEqual(unjudgeable(claim('live', 'verified'), { ...work, kind: 'verification', status: 'accepted' }), { kind: 'review-evidence' })
  for (const status of ['unverified', 'verified', 'challenged']) for (const task of ['pending', 'running', 'submitted', 'accepted', 'blocked']) {
    assert.equal(judgeable(claim('live', status), { ...work, status: task }), true, `a ${status} claim of ${task} work`)
  }
})

test('(a) a claim the rejection refuted is not disputed before the owner resumes: each caller is named its own exit, and the resume still reworks in place', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement')
  const refutedClaim = await f.submit(source, 'The first attempt works')
  const rejecting = f.proposeReview(source)
  await f.verify(rejecting, 'reject')
  const commit = f.current(source).artifact.commit
  const verdict = f.current(rejecting)
  assert.deepEqual([f.evidence(refutedClaim).status, f.current(source).status, verdict.status], ['refuted', 'blocked', 'blocked'])
  const because = `was refuted when review ${rejecting.id} rejected task ${source.id} at commit ${commit}`
  // The author disputing its own rejection asks the owner about its task; any
  // other member asks by name; the owner decides the rejection itself.
  await f.refused(f.actor(f.author), refutedClaim, because, `If you hold that rejection wrong, call \`swarm_escalate\` with \`taskId\` ${source.id} so the owner decides.`)
  await f.refused(f.actor(f.reviewer), refutedClaim, because, `If you hold that rejection wrong, call \`swarm_escalate\` with a \`body\` naming task ${source.id} so the owner decides.`)
  await f.refused(f.owner, refutedClaim, because, `The rejection is yours to decide: resume task ${source.id} with \`swarm_control\`, its \`taskId\` and \`action\` resume to rework it in place, where its review judges the resubmission, or propose a replacement with \`swarm_propose\` naming \`replaces\`.`)
  // Nothing moved: the claim stays refuted, and the rejecting review keeps its verdict.
  assert.equal(f.evidence(refutedClaim).status, 'refuted')
  assert.deepEqual(f.current(rejecting), verdict, 'the rejecting review is neither cancelled nor overwritten')
  assert.deepEqual([f.events('evidence/challenged'), f.events('task/invalidated')], [[], []])
  // The exits are real: the author's escalation binds its own task.
  assert.equal(f.runtime.escalate(f.actor(f.author), f.mission.id, { body: 'The rejection misreads the criterion', taskId: source.id }).taskId, source.id)
  f.runtime.escalate(f.actor(f.reviewer), f.mission.id, { body: `Task ${source.id}: the rejection should be revisited` })

  // The owner's in-place rework is still there: the rejected task re-opens for
  // its author, and the rejecting review re-opens with it.
  const resumed = f.runtime.controlTask(f.owner, f.mission.id, source.id, 'resume', {}, 'Rework the rejected artifact')
  assert.equal(resumed.status, 'pending')
  assert.deepEqual(resumed.rejections.map(rejection => [rejection.reviewTaskId, rejection.commit, rejection.evidenceIds]), [[rejecting.id, commit, [refutedClaim.id]]])
  assert.equal(f.current(rejecting).status, 'pending', 'the rejecting review is re-opened for the resubmission')
  await f.submit(source, 'The reworked attempt works')
  await f.verify(rejecting, 'accept')
  assert.deepEqual([f.current(source).status, f.current(rejecting).status], ['accepted', 'accepted'], 'the same review accepts the rework')
})

test('(b1) a claim superseded within its task is refuted, never verified, by the first acceptance, and its challenge is refused while the dependent keeps running', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement')
  const dependent = f.propose('Build on it', { dependencies: [source.id], assigneeId: f.reviewer.id })
  const claimed = await f.claim(f.author, source)
  const first = await f.publish(f.author, claimed, 'The first attempt works')
  const revised = await f.publish(f.author, claimed, 'The revised attempt works', [first.id])
  await f.submitClaimed(claimed)
  const review = f.proposeReview(source)
  await f.verify(review, 'accept')
  // F3-B: the predecessor is refuted by the claim that supersedes it, after
  // that claim's verdict, and is never verified on the way.
  assert.deepEqual(f.eventsOf(first).map(event => [event.type, event.data.refutedBy, event.data.reason]), [['evidence/refuted', revised.id, `Superseded by verified evidence ${revised.id}`]])
  assert.deepEqual(f.eventsOf(revised).map(event => event.type), ['evidence/verified', 'evidence/verdict'])
  assert.ok(f.eventsOf(first)[0].seq > f.eventsOf(revised)[0].seq, 'the refutation follows the verdict of the claim that supersedes it')
  assert.deepEqual([f.evidence(first).status, f.evidence(first).refutedBy, f.evidence(revised).status], ['refuted', revised.id, 'verified'])
  assert.equal((await f.claim(f.reviewer, dependent)).status, 'running')

  await f.refused(f.owner, first, `is refuted and superseded by evidence ${revised.id}`,
    `Use \`swarm_challenge\` with the \`evidenceId\` of a claim of task ${source.id} a verdict can still judge instead: ${revised.id}.`)
  assert.deepEqual([f.current(source).status, f.current(review).status, f.current(dependent).status], ['accepted', 'accepted', 'running'],
    'the accepted source is not re-opened, its review is not cancelled, and its dependent keeps running')
  assert.deepEqual(f.events('task/invalidated'), [])
  assert.equal(completionError(f.runtime.boardOf(f.mission.id)), `Mission still has unfinished or blocked required work: ${dependent.id} (running)`)

  // The exit is real: the claim that superseded it is still disputed, and re-opens the source.
  f.challenge(f.owner, revised)
  assert.deepEqual([f.evidence(revised).status, f.current(source).status], ['challenged', 'submitted'])
})

test('(b2) a claim of a replaced task is not disputed once the repair is accepted: a dependent of the original keeps running', async t => {
  const f = await fixture(t)
  const original = f.propose('Implement')
  const dependent = f.propose('Build on it', { dependencies: [original.id], assigneeId: f.reviewer.id })
  const replaced = await f.submit(original, 'The first attempt works')
  await f.verify(f.proposeReview(original), 'reject')
  const repair = f.propose('Repair', { replaces: [original.id] })
  const claimed = await f.claim(f.author, repair)
  const repaired = await f.publish(f.author, claimed, 'The repair works', [replaced.id])
  await f.submitClaimed(claimed)
  const repairReview = f.proposeReview(repair)
  await f.verify(repairReview, 'accept')
  assert.deepEqual([f.current(original).status, f.current(repair).status, f.evidence(replaced).status, f.evidence(replaced).refutedBy], ['cancelled', 'accepted', 'refuted', repaired.id])
  assert.equal((await f.claim(f.reviewer, dependent)).status, 'running', 'the dependent of the original runs on the accepted repair')

  await f.refused(f.actor(f.reviewer), replaced, `belongs to task ${original.id}, which is cancelled and so supports no result`,
    `Use \`swarm_challenge\` with the \`evidenceId\` of a claim of task ${repair.id} a verdict can still judge instead: ${repaired.id}.`)
  assert.deepEqual([f.current(repair).status, f.current(repairReview).status, f.current(dependent).status], ['accepted', 'accepted', 'running'])
  assert.deepEqual(f.events('task/invalidated'), [])
})

/**
 * The exit a refusal names is one the runtime then accepts. The task that
 * answers for a refuted claim is its carrier (`carrier`, src/task-graph.ts),
 * the one task owner control acts on, and the owner's exit is the one owner
 * control takes for it (`reworkableRejection`, `reworksSpent`).
 */
test('a refuted claim of a rejected task a pending repair carries names that repair\'s next claim, never a resume of the task the repair replaced', async t => {
  const f = await fixture(t)
  const original = f.propose('Implement')
  const refutedClaim = await f.submit(original, 'The first attempt works')
  const rejecting = f.proposeReview(original)
  await f.verify(rejecting, 'reject')
  const repair = f.propose('Repair', { replaces: [original.id] })
  const because = f.refutedBy(original, rejecting)
  await f.refused(f.owner, refutedClaim, because, `Task ${repair.id} has no claim a verdict can judge yet; wait for its next claim, then use \`swarm_challenge\` with that \`evidenceId\`.`)
  // A resume of the original is not the exit: the repair carries it.
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, original.id, 'resume', {}, 'Rework instead'), error => error.code === 'task_replaced' && error.message.includes(`carried by its replacement ${repair.id}`))
  // The exit is real: once the repair publishes, its claim is the one to challenge.
  const claimed = await f.claim(f.author, repair)
  const repaired = await f.publish(f.author, claimed, 'The repair works')
  await f.refused(f.owner, refutedClaim, because, `Use \`swarm_challenge\` with the \`evidenceId\` of a claim of task ${repair.id} a verdict can still judge instead: ${repaired.id}.`)
  f.challenge(f.owner, repaired)
  assert.equal(f.evidence(repaired).status, 'challenged')
})

test('a rejected repair a pending repair replaced in turn is not the answer: the dispute waits on the task that carries the obligation now', async t => {
  const f = await fixture(t)
  const first = f.propose('Implement')
  const firstClaim = await f.submit(first, 'The first attempt works')
  const firstReview = f.proposeReview(first)
  await f.verify(firstReview, 'reject')
  const second = f.propose('Repair', { replaces: [first.id] })
  const secondClaim = await f.submit(second, 'The repair works')
  const secondReview = f.proposeReview(second)
  await f.verify(secondReview, 'reject')
  const third = f.propose('Repair the repair', { replaces: [second.id] })
  assert.deepEqual([first, second, third].map(task => f.current(task).status), ['blocked', 'blocked', 'pending'])
  const wait = `Task ${third.id} has no claim a verdict can judge yet; wait for its next claim, then use \`swarm_challenge\` with that \`evidenceId\`.`
  // The first live replacement of the original is the rejected repair, which a
  // resume would refuse ([task_replaced]): the carrier is the pending repair.
  await f.refused(f.owner, firstClaim, f.refutedBy(first, firstReview), wait)
  await f.refused(f.owner, secondClaim, f.refutedBy(second, secondReview), wait)
  await f.refused(f.actor(f.reviewer), firstClaim, f.refutedBy(first, firstReview), wait)
  for (const replaced of [first, second]) {
    assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, replaced.id, 'resume', {}, 'Rework instead'),
      error => error.code === 'task_replaced' && error.message.includes(`carried by its replacement ${third.id} (pending)`), 'owner control names the carrier its refusal leaves to act on')
  }
  const claimed = await f.claim(f.author, third)
  const latest = await f.publish(f.author, claimed, 'The second repair works')
  await f.refused(f.owner, firstClaim, f.refutedBy(first, firstReview), `Use \`swarm_challenge\` with the \`evidenceId\` of a claim of task ${third.id} a verdict can still judge instead: ${latest.id}.`)
})

test('a refuted claim of a rejected experiment names its replacement, never a resume: a rejected experiment stays blocked', async t => {
  const f = await fixture(t)
  const experiment = f.propose('Try an idea', { experiment: true })
  const refutedClaim = await f.submit(experiment, 'The idea works')
  const rejecting = f.proposeReview(experiment)
  await f.verify(rejecting, 'reject')
  const because = f.refutedBy(experiment, rejecting)
  const message = await f.refused(f.owner, refutedClaim, because, `The rejection is yours to decide: task ${experiment.id} is a rejected experiment, which stays blocked, so repair it with a replacement: use \`swarm_propose\` naming \`replaces\`.`)
  assert.ok(!message.includes('swarm_control') && !/\bresume\b/.test(message), message)
  await f.refused(f.actor(f.author), refutedClaim, because, `If you hold that rejection wrong, call \`swarm_escalate\` with \`taskId\` ${experiment.id} so the owner decides.`)
  // A resume is refused, and the replacement the refusal names is admitted.
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, experiment.id, 'resume', {}, 'Rework instead'), error => error.code === 'task_refuted')
  const replacement = f.propose('Try the idea again', { experiment: true, replaces: [experiment.id] })
  assert.equal(f.current(replacement).status, 'pending')
})

test('a refuted claim of a task whose reworks are spent names the raised maxRework, the resume owner control accepts', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement')
  f.runtime.controlTask(f.owner, f.mission.id, source.id, 'amend', { maxRework: 1 }, 'One rework at most')
  await f.submit(source, 'The first attempt works')
  const rejecting = f.proposeReview(source)
  await f.verify(rejecting, 'reject')
  f.runtime.controlTask(f.owner, f.mission.id, source.id, 'resume', {}, 'Rework it once')
  const refutedClaim = await f.submit(source, 'The reworked attempt works')
  await f.verify(rejecting, 'reject')
  assert.deepEqual([f.current(source).status, f.current(source).reworkCount, f.evidence(refutedClaim).status], ['blocked', 1, 'refuted'])
  await f.refused(f.owner, refutedClaim, f.refutedBy(source, rejecting),
    `The rejection is yours to decide: task ${source.id} was already reworked 1/1 time(s), so resume it with \`swarm_control\`, its \`taskId\`, \`action\` resume and a higher \`maxRework\` in \`changes\` to rework it again, or propose a replacement with \`swarm_propose\` naming \`replaces\`.`)
  // A plain resume is refused; the named one reworks the task in place.
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, source.id, 'resume', {}, 'Rework again'), error => error.code === 'task_rework_exhausted')
  assert.equal(f.runtime.controlTask(f.owner, f.mission.id, source.id, 'resume', { maxRework: 2 }, 'Rework again').status, 'pending')
  assert.equal(f.current(rejecting).status, 'pending', 'the rejecting review re-opens for the resubmission')
})

test('a reviewer\'s claim a rework archived on the review names the reviewed source\'s claims a verdict can still judge', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement')
  await f.submit(source, 'The first attempt works')
  const review = f.proposeReview(source)
  const claimedReview = await f.claim(f.reviewer, review)
  const finding = await f.publish(f.reviewer, claimedReview, 'The artifact fails test X')
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'reject', reason: 'Fails test X' })
  const rejected = f.current(source).artifact.commit
  f.runtime.controlTask(f.owner, f.mission.id, source.id, 'resume', {}, 'Rework the rejected artifact')
  const because = `belongs to the round of task ${review.id} that review ${review.id} closed by rejecting commit ${rejected}; the rework archived it with that rejection`
  await f.refused(f.owner, finding, because, `Task ${source.id} has no claim a verdict can judge yet; wait for its next claim, then use \`swarm_challenge\` with that \`evidenceId\`.`)
  const reworked = await f.submit(source, 'The reworked attempt works')
  await f.refused(f.owner, finding, because, `Use \`swarm_challenge\` with the \`evidenceId\` of a claim of task ${source.id} a verdict can still judge instead: ${reworked.id}.`)
  f.challenge(f.owner, reworked)
  assert.equal(f.evidence(reworked).status, 'challenged')
})

test('a claim of work the owner withdrew supports no result: its challenge is refused and names nothing left to dispute', async t => {
  const f = await fixture(t)
  const withdrawn = f.propose('Optional idea')
  const claimed = await f.claim(f.author, withdrawn)
  const unverified = await f.publish(f.author, claimed, 'The idea holds')
  f.runtime.cancel(f.owner, f.mission.id, { taskId: withdrawn.id, reason: 'Not needed any more' })
  assert.deepEqual([f.current(withdrawn).status, f.evidence(unverified).status], ['cancelled', 'unverified'])
  await f.refused(f.actor(f.reviewer), unverified, `belongs to task ${withdrawn.id}, which is cancelled and so supports no result`,
    'No result rests on it, so nothing is left to dispute; to dispute live work, use `swarm_challenge` with the `evidenceId` of one of its claims.')
})

test('a review\'s own claim is judged by no verdict: its challenge is refused before and after the verdict', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement')
  await f.submit(source)
  const review = f.proposeReview(source)
  const claimed = await f.claim(f.reviewer, review)
  const finding = await f.publish(f.reviewer, claimed, 'The tests pass on the submitted commit')
  const because = `is review ${review.id}'s own evidence for its verdict on task ${source.id}; a verdict judges the claims of the work it reviews, and nothing reviews a review`
  // The author disputing the reviewer's finding asks the owner about its own task.
  await f.refused(f.actor(f.author), finding, because, `If you hold it wrong, call \`swarm_escalate\` with \`taskId\` ${source.id} so the owner decides.`)
  assert.equal(f.current(review).status, 'running', 'the review keeps running')
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'The finding holds' })
  assert.deepEqual([f.current(source).status, f.current(review).status, f.evidence(finding).status], ['accepted', 'accepted', 'unverified'], 'no verdict judges the review\'s own claim')
  // The source has no claim of its own, so no claim carries this dispute.
  await f.refused(f.owner, finding, because, `No claim a verdict can judge carries this dispute; propose the repair of task ${source.id} as new work with \`swarm_propose\` and an \`objective\` that names it.`)
  assert.equal(f.current(review).status, 'accepted', 'the accepting review is not turned back to a submission no verdict can judge')
  assert.equal(completionError(f.runtime.boardOf(f.mission.id)), undefined)
})

test('completion is held only by a dispute a verdict can still resolve: an older build\'s dispute of a review\'s own claim holds nothing open', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement')
  await f.submit(source)
  const review = f.proposeReview(source)
  const claimed = await f.claim(f.reviewer, review)
  const finding = await f.publish(f.reviewer, claimed, 'The tests pass on the submitted commit')
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict: 'accept', reason: 'The finding holds' })
  assert.deepEqual(f.runtime.snapshot(f.owner, f.mission.id).completion, { eligible: true })
  // A build before the refusal recorded this dispute; no verdict could ever resolve it.
  const row = f.evidence(finding)
  f.runtime.store.put('evidence', { ...row, status: 'challenged', challenges: [{ authorId: f.author.id, reason: 'Disputed before the refusal', toolRunIds: [] }] })
  assert.equal(completionError(f.runtime.boardOf(f.mission.id)), undefined)
  assert.deepEqual(f.runtime.snapshot(f.owner, f.mission.id).completion, { eligible: true }, 'a live dispute still holds completion (tests/completion-disputes.test.mjs)')
})
