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
import { join } from 'node:path'
import { setup, taskOf, events, MISSION_ACCEPTANCE, SwarmRuntime, FakeWorkers } from './faults/harness.mjs'

const CHECK = 'node --test tests/first.test.mjs'
const failing = output => ({ command: CHECK, exitCode: 1, output })
const passing = () => ({ command: CHECK, exitCode: 0, output: 'tests 1, pass 1, fail 0\n' })

/** Claim, submit, admit a real independent review and take the verdict. */
async function verifySource(f, task) {
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: `Review ${task.title}`, objective: 'Independent review', kind: 'verification',
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
    assert.match(notice.content, /Repair it with a replacement task or adjust the plan/)
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
      workstreamId: f.stream.id, title: `Review ${task.title}`, objective: 'Independent review', kind: 'verification',
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
    revived = new SwarmRuntime({ statePath: join(f.dir, 'swarm.sqlite'), leaseMs: 60_000, tickMs: 10, maxMessageChars: 16_000, maxEvents: 5_000, maxTasksPerMember: 3, checkTimeoutMs: 30_000 }, new FakeWorkers())
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
