/**
 * S15 (FLK): a declared host check that fails once is a flake, not a verdict.
 *
 * The recorded failure mode (owner inventory, 2026-09-09; reproduced 2026-09-10):
 * a declared check is often a wall-clock deadline that assumed an unloaded
 * machine. Under the single-strike rule one timing accident turned into a
 * preserve-and-replace cycle, and the durable record could not even show that the
 * check had been flaky. The rule now lives in `src/declared-checks.ts`:
 *
 *  - a failing pass is re-run once on the same artifact and the retry decides;
 *  - both runs are written durably (one tool-run row per check per attempt, each
 *    naming its command, exit code and output), so the flake is visible;
 *  - a real failure fails twice and blocks, with the same two records.
 *
 * Guards this rule can co-fire with, and which these tests therefore exercise:
 *  - `task/blocked`: the two-strike failure blocks the source and the review in
 *    the same transaction (the W18 preparation-failure path writes the same
 *    status, so the pair is `blocked` for two different reasons);
 *  - the review-admission path (`admitAutomaticReview` / `admitMissingReviews`):
 *    a blocked source must not have a second review admitted for it;
 *  - the ceiling-exhausted path (`taskCeilingBlock`): untouched here — a task
 *    that exhausts its ceiling is not re-checked by this rule.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { setup, taskOf, events, eventually, MISSION_ACCEPTANCE, SwarmRuntime, FakeWorkers } from './faults/harness.mjs'
import { reviewNeed, reviewPathBlocker } from '../lib/board.js'

const CHECK = 'node --test tests/first.test.mjs'
const failing = output => ({ command: CHECK, exitCode: 1, output })
const passing = (output = 'tests 1, pass 1, fail 0\n') => ({ command: CHECK, exitCode: 0, output })

/** Claim, submit, admit a real independent review and take the verdict. */
async function verifySource(f, task) {
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    outputs: [], workstreamId: f.stream.id, title: `Review ${task.title}`, objective: 'Independent review', kind: 'verification',
    reviewOf: task.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, {
    taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept',
    reason: 'Independent host checks validate the submitted artifact',
  })
  return review
}

const runsFor = (f, review) => f.runtime.store.list('tool_runs', f.mission.id).filter(run => run.taskId === review.id)

test('S15: a declared check that fails once is re-run, and the task proceeds with both runs recorded', async () => {
  const f = await setup({ checks: [CHECK] })
  try {
    let calls = 0
    f.workers.verifyArtifact = async () => (++calls === 1 ? [failing('deadline exceeded under load\n')] : [passing()])
    const task = f.propose()
    const review = await verifySource(f, task)

    assert.equal(calls, 2, 'a failing declared check is re-run exactly once on the same artifact')
    assert.equal(taskOf(f.runtime, task.id).status, 'accepted', 'the flake does not block the reviewed task')
    assert.equal(taskOf(f.runtime, review.id).status, 'accepted', 'the verification is accepted')

    const runs = runsFor(f, review)
    assert.equal(runs.length, 2, 'both runs are recorded: one row per attempt')
    assert.deepEqual(runs.map(run => run.arguments.attempt), [1, 2], 'each row names its attempt')
    assert.deepEqual(runs.map(run => run.result.exitCode), [1, 0], 'the failed first pass and the passing retry')
    assert.deepEqual(runs.map(run => run.isError), [true, false], 'the failed row is durable and marked')
    assert.deepEqual(runs.map(run => run.arguments.command), [CHECK, CHECK], 'both rows name the declared command')
    assert.ok(runs.every(run => run.result.output.trim().length > 0), 'both rows carry the check output')
    assert.equal(runs[0].attemptId, runs[1].attemptId, 'both attempts belong to the same verification attempt')
    assert.equal(runs[0].result.commit ?? runs[0].arguments.commit, runs[1].arguments.commit, 'both runs name the same artifact commit')

    // The verdict rests on the deciding run only; the flake is evidence, not a failure.
    const accepted = events(f.runtime, f.mission.id, 'task/accepted')
    assert.equal(accepted.length, 1)
    assert.deepEqual(accepted[0].data.checks, [runs[1].id], 'the acceptance names the run the verdict rests on')
    assert.deepEqual(events(f.runtime, f.mission.id, 'task/rejected'), [], 'a flake is not a rejection')
  } finally { await f.cleanup() }
})

test('S15: a declared check that fails twice still blocks, with both runs recorded', async () => {
  const f = await setup({ checks: [CHECK] })
  try {
    let calls = 0
    f.workers.verifyArtifact = async () => { calls++; return [failing('exit code 1: the artifact is really broken\n')] }
    const task = f.propose()
    const review = await verifySource(f, task)

    assert.equal(calls, 2, 'the retry rule re-runs even a real failure, exactly once')
    assert.equal(taskOf(f.runtime, review.id).status, 'blocked', 'the verification blocks on the repeat')
    assert.equal(taskOf(f.runtime, task.id).status, 'blocked', 'the reviewed source blocks on the repeat')

    const runs = runsFor(f, review)
    assert.equal(runs.length, 2, 'both runs are recorded')
    assert.deepEqual(runs.map(run => run.arguments.attempt), [1, 2])
    assert.deepEqual(runs.map(run => run.isError), [true, true], 'a real failure fails both runs')

    const rejected = events(f.runtime, f.mission.id, 'task/rejected')
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].data.checkFailures.length, 1, 'the durable rejection names the real failure')
    assert.equal(rejected[0].data.checkFailures[0].exitCode, 1)
    assert.match(rejected[0].data.checkFailures[0].command, /first\.test\.mjs/, 'the rejection names the executable check')
    assert.deepEqual(rejected[0].data.checks, [runs[1].id], 'the rejection names the deciding run')
  } finally { await f.cleanup() }
})

test('S15 pair: the repeated-failure block does not admit a second review or re-pend the source', async () => {
  const f = await setup({ checks: [CHECK], config: { tickMs: 5 } })
  try {
    f.workers.verifyArtifact = async () => [failing('exit code 1: the artifact is really broken\n')]
    const task = f.propose()
    const review = await verifySource(f, task)
    assert.equal(taskOf(f.runtime, task.id).status, 'blocked')

    const reviewsFor = () => f.runtime.store.list('tasks', f.mission.id)
      .filter(candidate => candidate.kind === 'verification' && candidate.reviewOf === task.id)
    assert.equal(reviewsFor().length, 1, 'the blocked source has exactly the review that blocked it')
    // The durable record offers the repair path the owner is entitled to.
    const notice = f.runtime.store.list('deliveries', f.mission.id)
      .filter(delivery => delivery.to === 'owner' && typeof delivery.content === 'string')
      .find(delivery => delivery.content.includes(task.id))
    assert.ok(notice, 'the block wakes the owner with the task named')
    assert.match(notice.content, new RegExp(`Rework it in place with swarm_control\\(action: "resume", taskId: "${task.id}", reason\\)[^]*replaces: \\["${task.id}"\\]`), 'the rework is offered before a replacement')
    assert.match(notice.content, /blocked by independent verification/, 'the notice names the cause, not only the symptom')
    assert.equal(reviewsFor().length, 1, 'one review, admitted once')

    // Let several scheduling passes run: the two-strike block must not be repaired
    // by re-admitting a review of the source, and the source must stay blocked.
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(taskOf(f.runtime, task.id).status, 'blocked', 'the blocked source stays blocked')
    assert.equal(taskOf(f.runtime, review.id).status, 'blocked', 'the blocking review stays blocked')
    assert.equal(reviewsFor().length, 1, 'no second review is admitted for a blocked source')
    assert.deepEqual(events(f.runtime, f.mission.id, 'task/accepted'), [], 'nothing is accepted by the retry rule')
  } finally { await f.cleanup() }
})

/**
 * R16-G5a: the retry pair used to live only in an in-memory Map, so a lost
 * process erased the record that the check failed once. The failed first pass is
 * now written durably before the retry starts; `recordRuns` completes the pair
 * from the store. This test kills the process between the two passes.
 */
test('R16-G5a: the failed first pass survives a lost process and the retry completes the pair as attempt 2', async t => {
  const f = await setup({ checks: [CHECK] })
  let revived
  try {
    let calls = 0
    f.workers.verifyArtifact = async () => {
      calls += 1
      if (calls === 1) return [failing('deadline exceeded under load\n')]
      throw new Error('the host process was lost before the retry completed')
    }
    const task = f.propose()
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = f.runtime.propose(f.owner, f.mission.id, {
      outputs: [], workstreamId: f.stream.id, title: `Review ${task.title}`, objective: 'Independent review', kind: 'verification',
      reviewOf: task.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
    })
    const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    await assert.rejects(
      f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Independent host checks validate the submitted artifact' }),
      /lost before the retry/,
      'the injected process loss reaches the caller',
    )
    const before = f.runtime.store.list('tool_runs', f.mission.id).filter(run => run.taskId === review.id)
    assert.equal(before.length, 1, 'the failed first pass is durable before the retry runs')
    assert.equal(before[0].arguments.attempt, 1)
    assert.equal(before[0].result.exitCode, 1)
    assert.equal(before[0].isError, true)
    const attemptId = before[0].attemptId
    const commit = before[0].arguments.commit
    const firstRunId = before[0].id
    await f.runtime.dispose()

    // Phase 2: a fresh runtime on the same store, as after a host restart. The
    // retry pass completes the pair without rewriting the durable first pass.
    revived = new SwarmRuntime(f.runtime.config, new FakeWorkers())
    const recorded = revived.declaredChecks.recordRuns(f.mission.id, { memberId: f.reviewer.id, taskId: review.id, attemptId, commit }, [passing()])
    assert.equal(recorded.length, 1, 'the deciding pass is the returned run')
    const after = revived.store.list('tool_runs', f.mission.id).filter(run => run.taskId === review.id)
    assert.deepEqual(after.map(run => run.arguments.attempt), [1, 2], 'the pair survives the lost process')
    assert.deepEqual(after.map(run => run.result.exitCode), [1, 0], 'the durable failure and the deciding pass')
    assert.equal(after[0].id, firstRunId, 'the first pass is the same durable row, never rewritten')
    assert.equal(after[1].id, recorded[0], 'the deciding run is the one the verdict would name')
    // Pair: a different attempt never pairs with an earlier failure — it records
    // its own attempt 1 instead of inheriting a flake it did not observe.
    revived.declaredChecks.recordRuns(f.mission.id, { memberId: f.reviewer.id, taskId: review.id, attemptId: 'attempt_reverified', commit }, [passing()])
    const reverified = revived.store.list('tool_runs', f.mission.id).filter(run => run.taskId === review.id && run.attemptId === 'attempt_reverified')
    assert.equal(reverified.length, 1)
    assert.equal(reverified[0].arguments.attempt, 1, 'a later verification records its own first attempt')
  } finally {
    if (revived !== undefined) await revived.dispose()
    await f.cleanup()
  }
})

/**
 * CORE-05: a verification names the attempt the caller holds, never one read
 * off the board. The runner used to look the attempt up as the member's current
 * open attempt when the first pass failed. A review attempt fenced while that
 * pass ran had none, so its failure was never made durable: the pair was held
 * in memory under `member:commit:source`, which no attempt id scoped. The
 * fenced attempt could never use it (its verdict is refused), but the same
 * member's next attempt on the same review and commit picked it up, wrote the
 * dead attempt's two passes under its own id and cited the dead retry's row as
 * its verdict's check. And when the next attempt was already open as the first
 * pass returned, the dead attempt's failure was written under it, so its one
 * clean pass was recorded as a retry.
 *
 * The fence here is the owner's mission pause during the first pass; the
 * worker's signal is not aborted, so the retry finishes before the stop lands,
 * which is the window in which the hold was written.
 */
async function fencedReviewFixture() {
  const f = await setup({ checks: [CHECK], config: { tickMs: 60_000 } })
  // No scheduling pass dispatches the re-pended review: the test claims it.
  f.runtime.kick = () => {}
  const task = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    outputs: [], workstreamId: f.stream.id, title: `Review ${task.title}`, objective: 'Independent review', kind: 'verification',
    reviewOf: task.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const first = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  const verdict = attemptId => f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId, verdict: 'accept', reason: 'Independent host checks validate the submitted artifact' })
  /** Pause fences the review attempt; once its stop settled, resume and claim the same review again. */
  const pause = () => f.runtime.control(f.owner, f.mission.id, 'pause', 'The owner pauses while the first pass runs')
  const reclaim = async () => {
    await eventually(() => taskOf(f.runtime, review.id).resumeAfterStop === undefined && taskOf(f.runtime, review.id).status === 'pending', 'the fenced review was re-pended once its stop settled')
    f.runtime.control(f.owner, f.mission.id, 'resume', 'The owner resumes the mission')
    return (await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)).attempt.id
  }
  return { f, task, review, firstAttempt: first.attempt.id, verdict, pause, reclaim }
}

test('CORE-05: a review attempt fenced during its first pass keeps that failure durable under its own attempt, and the next attempt cites only its own passes', async () => {
  const { f, task, review, firstAttempt, verdict, pause, reclaim } = await fencedReviewFixture()
  try {
    let calls = 0
    f.workers.verifyArtifact = async () => {
      calls += 1
      if (calls === 1) { pause(); return [failing('first pass of the fenced attempt\n')] }
      if (calls === 2) return [passing('retry of the fenced attempt\n')]
      if (calls === 3) return [failing('first pass of the next attempt\n')]
      return [passing('retry of the next attempt\n')]
    }
    await assert.rejects(verdict(firstAttempt), 'the fenced attempt cannot commit a verdict')
    assert.equal(calls, 2, 'the fenced attempt ran its first pass and its retry')
    const fenced = runsFor(f, review)
    assert.equal(fenced.length, 1, 'the failed first pass is durable although its attempt was fenced while it ran')
    assert.equal(fenced[0].attemptId, firstAttempt, 'the row names the attempt that ran the pass')
    assert.equal(fenced[0].arguments.attempt, 1)
    assert.equal(fenced[0].isError, true)
    assert.equal(fenced[0].result.output, 'first pass of the fenced attempt\n')

    const nextAttempt = await reclaim()
    assert.notEqual(nextAttempt, firstAttempt)
    await verdict(nextAttempt)
    assert.equal(calls, 4)
    assert.equal(taskOf(f.runtime, task.id).status, 'accepted', 'the next attempt reaches its own verdict')

    const next = runsFor(f, review).filter(run => run.attemptId === nextAttempt)
    assert.deepEqual(next.map(run => [run.arguments.attempt, run.result.output]), [[1, 'first pass of the next attempt\n'], [2, 'retry of the next attempt\n']],
      'the next attempt records its own two passes and none of the fenced attempt\'s')
    assert.deepEqual(runsFor(f, review).filter(run => run.attemptId === firstAttempt).map(run => run.id), [fenced[0].id], 'the fenced attempt keeps exactly its durable first pass')
    assert.ok(!runsFor(f, review).some(run => run.result.output === 'retry of the fenced attempt\n'), 'the fenced attempt\'s retry, which decided nothing, is cited by no row')
    const [accepted] = events(f.runtime, f.mission.id, 'task/accepted')
    assert.deepEqual(accepted.data.checks, [next[1].id], 'the verdict cites the pass it classified')
  } finally { await f.cleanup() }
})

test('CORE-05: a fenced attempt\'s failed first pass is never written under the next attempt already open on the same review', async () => {
  const { f, review, firstAttempt, verdict, pause, reclaim } = await fencedReviewFixture()
  try {
    let calls = 0
    let release
    const held = new Promise(resolve => { release = resolve })
    f.workers.verifyArtifact = async () => {
      calls += 1
      if (calls === 1) { pause(); await held; return [failing('first pass of the fenced attempt\n')] }
      if (calls === 2) return [failing('retry of the fenced attempt\n')]
      return [passing('single pass of the next attempt\n')]
    }
    const fencedVerdict = verdict(firstAttempt)
    await eventually(() => calls === 1, 'the fenced attempt\'s first pass is running')
    // The same member already holds the next attempt on the same review when
    // the fenced attempt's first pass returns.
    const nextAttempt = await reclaim()
    release()
    await assert.rejects(fencedVerdict, 'the fenced attempt cannot commit a verdict')
    const fenced = runsFor(f, review)
    assert.deepEqual(fenced.map(run => [run.attemptId, run.arguments.attempt, run.result.output]), [[firstAttempt, 1, 'first pass of the fenced attempt\n']],
      'the failure is recorded under the attempt that ran it, not under the attempt the member holds now')

    await verdict(nextAttempt)
    const next = runsFor(f, review).filter(run => run.attemptId === nextAttempt)
    assert.deepEqual(next.map(run => [run.arguments.attempt, run.result.output]), [[1, 'single pass of the next attempt\n']],
      'a single clean pass is recorded as the first and only pass, never as a retry')
    const [accepted] = events(f.runtime, f.mission.id, 'task/accepted')
    assert.deepEqual(accepted.data.checks, [next[0].id])
  } finally { await f.cleanup() }
})

/**
 * CORE-05 pair: every failed first pass is durable now, also one a fenced
 * attempt records after the same member's next attempt on the review has
 * already deferred its verdict. That row is then the review's newest. The
 * blocker used to compose the deferral's exit from the review's newest
 * classified failure, so it named the late row's kind instead of the deciding
 * pass's. The deferral now names its deciding pass's rows
 * (`verificationRecovery.toolRunIds`, the rows its event names), and the exit
 * is composed from exactly those.
 */
test('CORE-05: a fenced attempt\'s first pass recorded after the next attempt deferred leaves the deferral\'s exit with the pass that decided it', async () => {
  const { f, task, review, firstAttempt, verdict, pause, reclaim } = await fencedReviewFixture()
  try {
    const timeout = output => ({ command: CHECK, exitCode: 124, failureKind: 'timeout', output })
    const infrastructure = output => ({ command: CHECK, exitCode: 125, failureKind: 'infrastructure', output })
    let calls = 0
    let release
    const held = new Promise(resolve => { release = resolve })
    f.workers.verifyArtifact = async () => {
      calls += 1
      if (calls === 1) { pause(); await held; return [timeout('first pass of the fenced attempt\n')] }
      if (calls === 2) return [timeout('first pass of the next attempt\n')]
      if (calls === 3) return [infrastructure('retry of the next attempt\n')]
      return [timeout('retry of the fenced attempt\n')]
    }
    const blocker = () => { const board = f.runtime.boardOf(f.mission.id), source = taskOf(f.runtime, task.id); return reviewPathBlocker(board, source, reviewNeed(board, source)) }
    const fencedVerdict = verdict(firstAttempt)
    await eventually(() => calls === 1, 'the fenced attempt\'s first pass is running')
    const nextAttempt = await reclaim()
    assert.equal((await verdict(nextAttempt)).status, 'blocked', 'the next attempt defers its verdict on its retry\'s infrastructure failure')
    const [deferral] = events(f.runtime, f.mission.id, 'task/verification-deferred')
    const exit = deferral.data.reason.slice(deferral.data.reason.indexOf('the host could not'), -1)
    assert.equal(blocker(), `review ${review.id} deferred its verdict on this artifact: ${exit}`, 'the blocker names the deciding pass\'s exit, as the deferral does')

    release()
    await assert.rejects(fencedVerdict, 'the fenced attempt cannot commit a verdict')
    assert.equal(calls, 4)
    const rows = runsFor(f, review)
    assert.deepEqual(rows.map(run => [run.attemptId, run.arguments.attempt, run.result.failureKind]),
      [[nextAttempt, 1, 'timeout'], [nextAttempt, 2, 'infrastructure'], [firstAttempt, 1, 'timeout']], 'the fenced attempt\'s failed first pass is the review\'s newest row')
    assert.equal(blocker(), `review ${review.id} deferred its verdict on this artifact: ${exit}`, 'a row recorded after the deferral moves nothing: the exit is still the deciding pass\'s')
    assert.doesNotMatch(blocker(), /checkTimeoutMs/, 'neither the next attempt\'s first pass nor the fenced attempt\'s decided anything')
    const recovery = taskOf(f.runtime, review.id).verificationRecovery
    assert.deepEqual(recovery.toolRunIds, [rows[1].id], 'the deferral names the rows of the pass that decided it')
    assert.deepEqual(deferral.data.checks, recovery.toolRunIds, 'the rows its event names')
  } finally { await f.cleanup() }
})
