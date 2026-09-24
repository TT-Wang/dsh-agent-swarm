/**
 * A rejected task is repaired in place: the owner's `swarm_control` resume
 * re-opens an independently rejected non-experiment for its author, instead of
 * requiring a new task plus a `replaces` edge that the owner restates verbatim
 * and every dependent must resolve through lineage (the first live run: an
 * integration kept depending on rejected originals and stayed pending forever).
 *
 * Pinned here: a dependent admitted before the rejection runs on the reworked
 * artifact with no replacement row; the claims the rejection refuted are never
 * verified or re-stamped again; the rejecting review re-opens in place and
 * re-reviews the reworked artifact, from a member who authored none of its
 * attempts (tests/rework-review.test.mjs); the rework bound refuses with its exit; and the rework attempt
 * starts from the rejected commit in a real worktree. A rejected experiment is
 * not reworkable (tests/task-needs-replacement.test.mjs).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PolicyError } from '../lib/policy-error.js'
import { assessText, toolSchemaIndex } from './refusal-inventory.mjs'
import { FakeClock, FakeWorkers, MISSION_ACCEPTANCE, WorkspaceWorkers, eventually, git, makeRepo, makeRuntime, makeWorkspaces, setup } from './faults/harness.mjs'

/** Every attempt captures its own commit, so a reworked artifact is a new commit. */
class ReworkWorkers extends FakeWorkers {
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async prepareTask(member, task, dependencies) { this.prepared.push(structuredClone({ memberId: member.id, task, dependencies })) }
  async captureArtifact(member, task) {
    // A research deliverable here changes no file, so it owes no host check.
    return { commit: createHash('sha1').update(`${task.id}@${task.epoch}`).digest('hex'), baseCommit: 'b'.repeat(40), workspace: member.workspace, changedPaths: task.kind === 'research' ? [] : ['src/a.ts'] }
  }
}

/** Two members, so the only independent reviewer of the author's work is the other one. */
async function fixture(t) {
  const clock = new FakeClock()
  const { dir, runtime, workers, budget } = await makeRuntime(t, { workers: new ReworkWorkers(), clock,
    config: { maxEvents: 5000, maxTasksPerMember: 100, checkTimeoutMs: undefined }, budget: { maxTasks: 100, maxExperiments: 2 } })
  await runtime.start()
  const owner = { sessionId: 'rework-owner' }
  const mission = runtime.create(owner, { title: 'Rework', objective: 'Repair rejected work in place', workspace: dir, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const evidence = evidenceId => runtime.store.get('evidence', evidenceId)
  const events = type => runtime.store.events(mission.id, 5000).filter(event => event.type === type)
  const tasks = () => runtime.store.list('tasks', mission.id)
  const propose = (title, extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title,
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: author.id, ...extra })
  /** Claim as the author, publish one host-backed claim when given, and submit. */
  async function submit(task, claim) {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    let published
    if (claim !== undefined) {
      const runId = await workers.callbacks.toolRun(author.id, { tool: 'bash', arguments: { command: 'node --test' }, result: { exitCode: 0, output: 'ok' }, isError: false })
      published = runtime.publish(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, claim, outcome: 'supported', toolRunIds: [runId] })
    }
    await runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    return published
  }
  /** The reviewer claims `review` and records `verdict`. */
  async function verify(review, verdict, reason) {
    const claimed = await runtime.claim(actor(reviewer), mission.id, review.id)
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict, reason })
  }
  const proposeReview = source => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: `Review ${source.title}`,
    objective: 'Independent review', kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: source.id })
  const reject = async (source, reason = 'The artifact misses the acceptance criterion') => { const review = proposeReview(source); await verify(review, 'reject', reason); return review }
  const resume = (task, changes = {}) => runtime.controlTask(owner, mission.id, task.id, 'resume', changes, 'Rework the rejected artifact')
  /** Move past the missing-review grace and run the tick the timer would. */
  async function pastReviewGrace() { clock.advance(1001); await runtime.tick(); await runtime.settle(mission.id) }
  const pendingReviewOf = source => tasks().find(task => task.reviewOf === source.id && task.status === 'pending')
  return { runtime, workers, clock, owner, mission, author, reviewer, actor, current, evidence, events, tasks, propose, submit, verify,
    proposeReview, reject, resume, pastReviewGrace, pendingReviewOf }
}

test('a dependent admitted before the rejection runs on the reworked artifact, with no replacement row', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement')
  const dependent = f.propose('Build on it', { dependencies: [source.id], assigneeId: f.reviewer.id })
  const refuted = await f.submit(source, 'The first attempt works')
  // The existing review path admits the independent review of the submission.
  await f.pastReviewGrace()
  const firstReview = f.pendingReviewOf(source)
  assert.ok(firstReview, 'the runtime admits a review of the first artifact')
  await f.verify(firstReview, 'reject', 'The artifact misses the acceptance criterion')
  const rejected = f.current(source)
  assert.equal(rejected.status, 'blocked')
  assert.equal(f.evidence(refuted.id).status, 'refuted')

  const reopened = f.resume(source)
  assert.equal(reopened.status, 'pending', 'the rejected task re-opens in place')
  assert.equal(reopened.epoch, rejected.epoch + 1, 'the rejected attempt is fenced by the epoch')
  assert.equal(reopened.artifact, undefined, 'the rejected artifact is history, so the task policy may be amended again')
  assert.equal(reopened.assigneeId, f.author.id, 'the author keeps the rework')
  assert.ok(reopened.priorOwnerIds.includes(f.author.id), 'the rejected attempt is recorded as authorship')
  assert.equal(reopened.reworkCount, 1)
  assert.deepEqual(reopened.rejections, [{ commit: rejected.artifact.commit, epoch: rejected.epoch, reviewTaskId: firstReview.id,
    reason: 'The artifact misses the acceptance criterion', evidenceIds: [refuted.id] }])
  assert.match(reopened.handoff, new RegExp(`Rejected by review ${firstReview.id} at ${rejected.artifact.commit}: The artifact misses the acceptance criterion`), 'the author reads the rejection')
  assert.equal(f.workers.stopped.includes(f.author.id), false, 'the author holds no live attempt, so it is not stopped')
  const judged = f.current(firstReview)
  assert.equal(judged.status, 'pending', 'the rejecting review re-opens for the next submission')
  assert.equal(judged.assigneeId, f.reviewer.id, 'with the rejecting reviewer as its assignee')
  assert.equal(judged.reviewedCommit, undefined)
  assert.equal(judged.output, undefined)
  assert.deepEqual(judged.rejections.map(entry => [entry.commit, entry.reviewTaskId, entry.reason]), [[rejected.artifact.commit, firstReview.id, 'The artifact misses the acceptance criterion']], 'its verdict is archived on its own history')
  assert.deepEqual(f.events('task/review-retired'), [], 'nothing is retired')
  const amended = f.events('task/amended')
  assert.equal(amended.find(event => event.data.taskId === source.id).data.rework.reviewTaskId, firstReview.id, 'the rework is durable')
  assert.equal(amended.find(event => event.data.taskId === firstReview.id).data.rework.commit, rejected.artifact.commit, 'and so is the review re-open')

  // The reviewer cannot take the author's rework, so it stays independent of it.
  await assert.rejects(f.runtime.claim(f.actor(f.reviewer), f.mission.id, source.id), /not ready/)
  await assert.rejects(f.runtime.claim(f.actor(f.reviewer), f.mission.id, dependent.id), /not ready/, 'the dependent waits for the rework')
  const kept = await f.submit(source, 'The reworked attempt works')
  const resubmitted = f.current(source)
  assert.notEqual(resubmitted.artifact.commit, rejected.artifact.commit)
  assert.equal(f.evidence(refuted.id).artifact.commit, rejected.artifact.commit, 'a refuted claim stays pinned to the artifact it was refuted on')
  assert.equal(f.evidence(kept.id).artifact.commit, resubmitted.artifact.commit)

  await f.pastReviewGrace()
  const freshReview = f.pendingReviewOf(source)
  assert.equal(freshReview.id, firstReview.id, 'the paired review re-reviews the reworked artifact')
  assert.deepEqual(f.tasks().filter(task => task.reviewOf === source.id).map(task => task.id), [firstReview.id], 'no review is admitted per rework')
  assert.deepEqual(f.events('task/review-blocked'), [])
  await assert.rejects(f.runtime.claim(f.actor(f.author), f.mission.id, freshReview.id), /not ready/, 'the author never reviews its own rework')
  await f.verify(freshReview, 'accept', 'The rework meets the criterion')
  assert.equal(f.current(source).status, 'accepted')
  assert.equal(f.evidence(kept.id).status, 'verified')
  assert.equal(f.evidence(refuted.id).status, 'refuted', 'the refuted claim stays refuted')
  assert.equal(f.events('evidence/verified').filter(event => event.data.evidenceId === refuted.id).length, 0, 'and is never verified')

  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, dependent.id)
  assert.equal(claimed.status, 'running', 'the dependent admitted before the rejection is ready')
  const prepared = f.workers.prepared.filter(call => call.task.id === dependent.id).at(-1)
  assert.deepEqual(prepared.dependencies.map(task => [task.id, task.artifact.commit]), [[source.id, resubmitted.artifact.commit]], 'and is prepared with the reworked artifact')
  assert.ok(f.tasks().every(task => !task.replaces?.length), 'no replacement row was needed')
})

test('a reworked task that is handed off re-pends: the claims its rejection refuted no longer block it', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement')
  await f.submit(source, 'The first attempt works')
  await f.reject(source)
  // Before the rework the refuted claim no longer guards a plain amendment of the rejected task.
  f.runtime.controlTask(f.owner, f.mission.id, source.id, 'amend', { checkTimeoutMs: 5000 }, 'Allow a slower check for the rework')
  assert.equal(f.current(source).status, 'blocked')
  f.resume(source)
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  f.runtime.handoff(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, summary: 'Hand the rework back' })
  await eventually(() => f.current(source).resumeAfterStop === undefined, 'the handoff stop is confirmed')
  assert.equal(f.current(source).status, 'pending', 'the handoff lands pending, not blocked by history')
})

test('a claim a rework archived cannot be challenged: the refusal names the live claims, and the accepted rework stays accepted', async t => {
  const f = await fixture(t)
  const index = await toolSchemaIndex()
  const source = f.propose('Implement')
  const dependent = f.propose('Build on it', { dependencies: [source.id], assigneeId: f.reviewer.id })
  const archived = await f.submit(source, 'The first attempt works')
  const rejecting = await f.reject(source)
  const rejectedCommit = f.current(source).artifact.commit
  f.resume(source)
  const challenge = evidenceId => f.runtime.challenge(f.owner, f.mission.id, { evidenceId, reason: 'Re-open the old dispute', toolRunIds: [] })
  const refusal = (live, message) => error => {
    assert.ok(error instanceof PolicyError)
    assert.equal(error.code, 'evidence_archived')
    assert.equal(error.category, 'conflict_error')
    assert.ok(error.message.startsWith('[evidence_archived] '), error.message)
    assert.ok(error.message.includes(`refuted with the rejected commit ${rejectedCommit} of task ${source.id} (review ${rejecting.id})`), error.message)
    assert.match(error.message, live)
    assert.deepEqual(assessText(error.message, index), [], 'the exit resolves in the published tool schema')
    message.push(error.message)
    return true
  }
  const messages = []
  assert.throws(() => challenge(archived.id), refusal(/has no live claim yet; wait for its next claim, then use `swarm_challenge`/, messages))
  assert.equal(f.evidence(archived.id).status, 'refuted', 'the refused challenge leaves the history claim refuted')
  const kept = await f.submit(source, 'The reworked attempt works')
  assert.throws(() => challenge(archived.id), refusal(new RegExp(`Use \`swarm_challenge\` with the \`evidenceId\` of a live claim of that task instead: ${kept.id}\\.`), messages))
  await f.verify(f.pendingReviewOf(source) ?? f.proposeReview(source), 'accept', 'The rework meets the criterion')
  assert.equal(f.current(source).status, 'accepted')
  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, dependent.id)
  assert.equal(claimed.status, 'running')

  // Disputing the rejected commit's claim after the rework was accepted neither
  // re-opens the accepted task nor invalidates work built on it.
  assert.throws(() => challenge(archived.id), refusal(new RegExp(kept.id), messages))
  assert.equal(f.current(source).status, 'accepted', 'the accepted rework is not re-opened')
  assert.equal(f.current(dependent).status, 'running', 'its dependent keeps running')
  assert.deepEqual(f.events('task/invalidated'), [])
  assert.equal(f.evidence(archived.id).status, 'refuted')
  assert.equal(f.evidence(archived.id).challenges.length, 0, 'no dispute was recorded')
  assert.equal(f.events('evidence/challenged').length, 0)
  // The live claim of the accepted artifact can still be disputed.
  challenge(kept.id)
  assert.equal(f.current(source).status, 'submitted')
})

test('a dispute of an archived claim recorded before the refusal blocks neither the verdict nor completion', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement')
  const archived = await f.submit(source, 'The first attempt works')
  await f.reject(source)
  assert.deepEqual(f.resume(source).rejections.at(-1).evidenceIds, [archived.id])
  // A build before the refusal recorded this dispute; the row stays in the store.
  const row = f.evidence(archived.id)
  f.runtime.store.put('evidence', { ...row, status: 'challenged', challenges: [...row.challenges, { authorId: 'owner', reason: 'Re-open the old dispute', toolRunIds: [] }] })
  const kept = await f.submit(source, 'The reworked attempt works')
  await f.verify(f.pendingReviewOf(source) ?? f.proposeReview(source), 'accept', 'The rework meets the criterion')
  assert.equal(f.current(source).status, 'accepted')
  assert.equal(f.evidence(kept.id).status, 'verified')
  assert.equal(f.evidence(archived.id).status, 'challenged', 'the archived claim is not judged by the rework verdict')
  assert.equal(f.events('evidence/verified').filter(event => event.data.evidenceId === archived.id).length, 0, 'it is never verified')
  assert.notEqual(f.evidence(archived.id).artifact.commit, f.current(source).artifact.commit, 'nor re-stamped with the reworked artifact')
  assert.equal(f.runtime.completionError(f.runtime.mission(f.mission.id)), undefined, 'history of a rejected commit is not an open dispute')
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'Accepted rework covers the mission').status, 'completed')
})

test('a reworked research task needs a live claim before it resubmits', async t => {
  const f = await fixture(t)
  const source = f.propose('Research', { kind: 'research', checks: [] })
  await f.submit(source, 'The first finding holds')
  await f.reject(source)
  f.resume(source)
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await assert.rejects(f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'no new finding' }),
    /research_evidence_required/, 'a refuted claim supports nothing')
  const runId = await f.workers.callbacks.toolRun(f.author.id, { tool: 'bash', arguments: { command: 'node --test' }, result: { exitCode: 0 }, isError: false })
  f.runtime.publish(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, claim: 'The revised finding holds', outcome: 'supported', toolRunIds: [runId] })
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'revised finding' })
  assert.equal(f.current(source).status, 'submitted')
})

test('the rework bound refuses with its exit, and raising maxRework through swarm_control changes re-opens the task', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement')
  for (let round = 1; round <= 2; round++) {
    await f.submit(source)
    await f.reject(source)
    assert.equal(f.resume(source).reworkCount, round)
  }
  await f.submit(source)
  await f.reject(source)
  const blocked = f.current(source)
  let message
  assert.throws(() => f.resume(source), error => {
    assert.ok(error instanceof PolicyError)
    assert.equal(error.code, 'task_rework_exhausted')
    assert.equal(error.category, 'budget_error')
    assert.ok(error.message.startsWith('[task_rework_exhausted] '), error.message)
    assert.match(error.message, /2\/2/)
    assert.match(error.message, /Raise `maxRework` in `changes` with `swarm_control`/, 'the first exit is the raise')
    assert.match(error.message, /`swarm_cancel`[^.]*`swarm_propose`[^.]*`replaces`/, 'the second is a cancel plus a replacement')
    message = error.message
    return true
  })
  const index = await toolSchemaIndex()
  assert.deepEqual(assessText(message, index), [], 'the exit resolves in the published tool schema')
  assert.equal(index.definitions.get('swarm_control').parameters.properties.changes.properties.maxRework.type, 'integer', 'swarm_control declares changes.maxRework')
  const after = f.current(source)
  assert.equal(after.status, 'blocked')
  assert.equal(after.epoch, blocked.epoch)
  assert.equal(after.reworkCount, 2)
  assert.ok(after.artifact)
  assert.throws(() => f.runtime.controlTask(f.owner, f.mission.id, source.id, 'amend', { maxRework: 1 }, 'Lower the bound'), error => {
    assert.equal(error.code, 'task_rework_allocation_invalid')
    assert.deepEqual(assessText(error.message, index), [])
    return true
  })
  // Raising the bound resumes the rejected task, exactly as raising maxRecoveryAttempts resumes a blocked one.
  const raised = f.runtime.controlTask(f.owner, f.mission.id, source.id, 'amend', { maxRework: 3 }, 'One more rework')
  assert.equal(raised.status, 'pending')
  assert.equal(raised.maxRework, 3)
  assert.equal(raised.reworkCount, 3)
  assert.equal(raised.rejections.length, 3)
})

test('a budget-only amendment of a rejected task stores the ceiling and leaves it blocked; only a resume reworks it', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement', { maxRecoveryAttempts: 2 })
  await f.submit(source)
  const review = await f.reject(source)
  const rejected = f.current(source)
  // The call swarm_budget(taskId, taskBudget) makes.
  const amended = f.runtime.controlTask(f.owner, f.mission.id, source.id, 'amend', { maxRecoveryAttempts: 4 }, 'Give the task more recovery headroom')
  assert.equal(amended.status, 'blocked', 'the rejected task is not re-opened')
  assert.equal(amended.maxRecoveryAttempts, 4, 'the ceiling is stored')
  assert.deepEqual(amended.artifact, rejected.artifact, 'its artifact stays')
  assert.equal(amended.epoch, rejected.epoch)
  assert.equal(amended.reworkCount, undefined, 'no rework was spent')
  assert.equal(f.current(review).status, 'blocked', 'its rejecting review keeps its verdict')
  assert.equal(f.events('task/amended').at(-1).data.rework, undefined)
  const reopened = f.resume(source)
  assert.equal(reopened.status, 'pending', 'the explicit resume reworks it')
  assert.equal(reopened.reworkCount, 1)
})

test('the rejection decision names the rework first and a replacement second, to the owner and to the author', async t => {
  const f = await fixture(t)
  const deliveries = () => f.runtime.store.list('deliveries', f.mission.id)
  const decisionFor = task => deliveries().filter(delivery => delivery.to === 'owner' && delivery.content.includes(`(${task.id}) was blocked by independent verification`)).at(-1)?.content
  const authorNoticeFor = task => deliveries().filter(delivery => delivery.to === f.author.id && delivery.kind === 'control' && delivery.content.includes(`(${task.id}) was rejected by independent verification`)).at(-1)?.content
  const resumeCall = task => `swarm_control(action: "resume", taskId: "${task.id}", reason)`
  const replacement = task => `swarm_propose naming replaces: ["${task.id}"]`
  const inOrder = (text, first, second) => { assert.ok(text.includes(first) && text.indexOf(first) < text.indexOf(second), `${first} before ${second} in: ${text}`) }
  /** Each rejection in its own wake window, so the decision is its own row. */
  const rejectOnce = async task => { f.clock.advance(6000); await f.submit(task); await f.reject(task) }

  const source = f.propose('Implement')
  await rejectOnce(source)
  inOrder(decisionFor(source), resumeCall(source), replacement(source))
  assert.match(decisionFor(source), /rework 1\/2/)
  inOrder(authorNoticeFor(source), resumeCall(source), replacement(source))
  assert.match(authorNoticeFor(source), /The artifact misses the acceptance criterion/, 'the author reads the reason')
  f.resume(source)
  await rejectOnce(source)
  assert.match(decisionFor(source), /rework 2\/2/)
  f.resume(source)
  await rejectOnce(source)
  // Past the bound the first exit is the raise.
  inOrder(decisionFor(source), `reworked 2/2 times; raise changes.maxRework in ${resumeCall(source)}`, replacement(source))

  // A rejected experiment stays blocked, so only the replacement is offered.
  const experiment = f.propose('Try an idea', { experiment: true })
  await rejectOnce(experiment)
  assert.match(decisionFor(experiment), /Repair it with a replacement task or adjust the plan\./)
  assert.ok(!decisionFor(experiment).includes('swarm_control'), decisionFor(experiment))
  assert.ok(authorNoticeFor(experiment).includes(replacement(experiment)))
  assert.ok(!authorNoticeFor(experiment).includes('swarm_control'))
})

test('a real rework attempt starts from the rejected commit, whether or not its author moved on', async t => {
  const repo = await makeRepo('rework-worktree')
  const workspaces = makeWorkspaces(repo.root)
  const f = await setup({ workers: new WorkspaceWorkers(workspaces), workspace: repo.source, config: { tickMs: 60_000 } })
  t.after(async () => { await f.cleanup(); await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  const answer = join(f.author.workspace, 'src/answer.txt')
  const source = f.propose({ title: 'Implement' })
  const submitAs = async (task, content) => {
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    const start = await readFile(answer, 'utf8')
    await writeFile(answer, content)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: content })
    return { start, artifact: f.runtime.store.get('tasks', task.id).artifact }
  }
  const reject = async () => {
    const review = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Review', objective: 'Independent review',
      kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id })
    const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimed.attempt.id, verdict: 'reject', reason: 'Still a draft' })
  }
  const resume = () => f.runtime.controlTask(f.owner, f.mission.id, source.id, 'resume', {}, 'Rework the draft')

  const first = await submitAs(source, 'draft\n')
  assert.equal(first.start, 'base\n')
  await reject()
  resume()
  // The author reworks at once: its own worktree still holds the rejected commit.
  const second = await submitAs(source, 'second draft\n')
  assert.equal(second.start, 'draft\n', 'the rework starts from the rejected content')
  assert.equal(second.artifact.baseCommit, first.artifact.baseCommit, 'on the same task base')
  await git(repo.source, 'merge-base', '--is-ancestor', first.artifact.commit, second.artifact.commit)
  await reject()

  // The author moves on to other work before the owner re-opens the task.
  const other = f.propose({ title: 'Other work' })
  const unrelated = await submitAs(other, 'other\n')
  assert.equal(unrelated.start, 'base\n', 'other work starts from the mission base')
  resume()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  assert.equal(await git(f.author.workspace, 'rev-parse', 'HEAD'), second.artifact.commit, 'the rework is prepared from the rejected commit, not the bare baseline')
  assert.equal(await readFile(answer, 'utf8'), 'second draft\n')
  await writeFile(answer, 'final\n')
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'final' })
  const final = f.runtime.store.get('tasks', source.id).artifact
  assert.equal(final.baseCommit, first.artifact.baseCommit)
  await git(repo.source, 'merge-base', '--is-ancestor', second.artifact.commit, final.commit)
  assert.equal(await git(repo.source, 'show', `${final.commit}:src/answer.txt`), 'final')
})
