/**
 * F19: the no-silent-state liveness invariant (docs/no-silent-state-spec.md §2-§5).
 *
 * Enumerates every condition class of §3 and proves, for each one, that the
 * non-terminal mission state leaves a witness within one bounded scheduler
 * window: W1 progress (dispatch / verdict / completion), W2 an owner-decision
 * notice whose dedup key is the state fingerprint F(S), or W3 a stall notice for
 * F(S). The two documented exemptions are asserted as such: a board whose only
 * non-terminal work runs under a live lease (row 3), and the zero-task
 * zero-member mission the owner is still planning (row 17).
 *
 * Rows 2, 6 and 8 are the three defects Round 10 confirmed (R10-09/S3, R10-15,
 * R10-14) and fail on the pre-fix head: the pre-fix scheduler skipped a parked
 * member, `swarm_wait` parked a running attempt, and a coverage-complete
 * owner-assembled mission returned silently.
 */
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeWorkers, SwarmRuntime, acceptThroughReview, blockThroughReview, clone, eventually, events, runScenario, setup, taskOf } from './harness.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const ownerNotices = f => f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.kind === 'control')
const reviewsOf = (f, sourceId) => f.runtime.store.list('tasks', f.mission.id).filter(task => task.kind === 'verification' && task.reviewOf === sourceId)
const witnessOf = f => f.runtime.store.get('missions', f.mission.id).witness
/** The witness must be durable, class-correct, and keyed by the current F(S). */
const assertWitness = (f, kind, label) => {
  const mission = f.runtime.store.get('missions', f.mission.id)
  assert.ok(mission.witness, `${label}: the state left no witness`)
  assert.equal(mission.witness.kind, kind, `${label}: witness class`)
  assert.equal(mission.witness.fingerprint, f.runtime.fingerprint(f.mission.id), `${label}: witness dedup key must be F(S)`)
  return mission.witness
}
/** A host-recorded run for this attempt, so research evidence is citable. */
const publishEvidence = (f, task, attemptId, outcome = 'supported') => {
  const run = { id: `run_f19_${Math.random().toString(16).slice(2)}`, seq: 1, missionId: f.mission.id, memberId: f.author.id,
    taskId: task.id, attemptId, tool: 'bash', arguments: {}, result: {}, isError: false, createdAt: Date.now() }
  f.runtime.store.transaction(() => f.runtime.store.put('tool_runs', run))
  return f.runtime.publish(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId, claim: 'F19 host-backed claim', outcome, toolRunIds: [run.id] })
}

await runScenario({
  id: 'F19',
  title: 'No-silent-state: every non-terminal board state has W1 progress, a W2 notice for F(S), or a W3 stall',
  invariants: ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'],
  body: async () => {
    const rows = {}

    // Row 1 — a pending task ready for an idle member is dispatched (W1).
    {
      const f = await setup()
      try {
        f.workers.autoIdle = true
        const task = f.propose()
        const running = await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? taskOf(f.runtime, task.id) : undefined,
          'row 1: a pending task ready for an idle member must be dispatched within a tick')
        assert.equal(running.attempt.ownerId, f.author.id)
        rows.row1 = { witness: 'W1', taskId: task.id }
      } finally { await f.cleanup() }
    }

    // Row 2 — R10-09/S3: a pending task ready only for a waiting member is
    // dispatched and woken. The adapter reports the parked member as not idle
    // (pending inbox / non-idle handle); the runtime must not let that
    // precondition leave the board silent.
    {
      const f = await setup()
      try {
        await f.runtime.wait(f.actor(f.author), f.mission.id)
        assert.equal(f.runtime.store.get('members', f.author.id).status, 'waiting')
        const task = f.propose()
        const running = await eventually(() => taskOf(f.runtime, task.id).status === 'running' ? taskOf(f.runtime, task.id) : undefined,
          'row 2: a task ready only for a waiting member must still be dispatched')
        assert.equal(running.attempt.ownerId, f.author.id)
        const assignment = f.workers.deliveries.find(item => item.kind === 'assignment' && item.taskId === task.id)
        assert.ok(assignment, 'row 2: the wake is a durable assignment delivery')
        assert.equal(assignment.memberId, f.author.id)
        assert.equal(await f.workers.callbacks.beforeStep(f.author.id, true), undefined, 'row 2: fresh input lets the parked member take its next step')
        rows.row2 = { witness: 'W1', taskId: task.id, woken: true }
      } finally { await f.cleanup() }
    }

    // Row 3 — every non-terminal task runs under a live lease: no notice.
    {
      const f = await setup()
      try {
        const task = f.propose()
        await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
        await sleep(120)
        assert.equal(taskOf(f.runtime, task.id).status, 'running')
        assert.deepEqual(events(f.runtime, f.mission.id, 'mission/stalled'), [], 'row 3: a live lease is not a stall')
        assert.deepEqual(ownerNotices(f), [], 'row 3: no notice is required while the lease is alive')
        rows.row3 = { witness: 'exempt', taskId: task.id }
      } finally { await f.cleanup() }
    }

    // Row 4 — an expired lease emits a per-task recovery event, not only a
    // mission-generic one (D6).
    {
      const f = await setup({ config: { leaseMs: 40 } })
      try {
        const task = f.propose()
        await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
        const expired = await eventually(() => events(f.runtime, f.mission.id, 'task/lease-expired').find(event => event.data.taskId === task.id),
          'row 4: lease expiry must emit a per-task recovery event')
        assert.equal(expired.data.oldOwner, f.author.id)
        assert.equal(events(f.runtime, f.mission.id, 'task/lease-expired').length, 1)
        rows.row4 = { witness: 'W2', taskId: task.id, event: 'task/lease-expired' }
      } finally { await f.cleanup() }
    }

    // Row 5 — a submitted artifact with no reviewable path is reported after the
    // documented grace, not left silent.
    {
      const f = await setup()
      try {
        f.runtime.store.transaction(() => {
          const reviewer = f.runtime.store.get('members', f.reviewer.id)
          reviewer.status = 'stopped'
          f.runtime.store.put('members', reviewer)
        })
        const task = f.propose()
        const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
        await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
        const blocked = await eventually(() => events(f.runtime, f.mission.id, 'task/review-blocked').find(event => event.data.taskId === task.id),
          'row 5: an unreviewable submission must be reported after the grace')
        assert.match(blocked.data.reason, /no live member other than the author/)
        const notice = await eventually(() => ownerNotices(f).find(delivery => /review_path_missing/.test(delivery.content) && delivery.content.includes(task.id)),
          'row 5: the owner receives the unreviewable notice')
        assert.match(notice.content, /review_path_missing/)
        assertWitness(f, 'W2', 'row 5')
        rows.row5 = { witness: 'W2', taskId: task.id }
      } finally { await f.cleanup() }
    }

    // Row 5b/5c — verifier-1 challenge (evidence_a454a771): an unreviewable
    // submitted artifact must be witnessed even while unrelated work runs.
    // `stalled`/`admitMissingReviews` only notify when the whole board would
    // otherwise stall, so without this the state stays silent behind live work.
    // Proven for an implementation artifact and a research artifact.
    for (const kind of ['implementation', 'research']) {
      const f = await setup()
      try {
        f.runtime.store.transaction(() => {
          const reviewer = f.runtime.store.get('members', f.reviewer.id)
          reviewer.status = 'stopped'
          f.runtime.store.put('members', reviewer)
        })
        const source = f.propose({ title: `${kind} source`, ...(kind === 'research' ? { kind: 'research', checks: undefined } : {}) })
        const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
        if (kind === 'research') publishEvidence(f, source, claimed.attempt.id)
        await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: `${kind} candidate` })
        // Unrelated work keeps running under a live lease while the submission
        // has no live review path. Research keeps the board free of the
        // second-implementation integration-gap diagnostic.
        const other = f.propose({ title: `Unrelated ${kind} work`, kind: 'research', checks: undefined })
        await f.runtime.claim(f.actor(f.author), f.mission.id, other.id)
        assert.equal(taskOf(f.runtime, other.id).status, 'running')
        await sleep(200)
        assert.equal(ownerNotices(f).some(delivery => delivery.content.includes(source.id)), false,
          `row 5 ${kind}: the bounded missing-review grace is honored before the notice`)
        const notice = await eventually(() => ownerNotices(f).find(delivery => delivery.content.includes(source.id) && /no live independent review path/.test(delivery.content)),
          `row 5 ${kind}: an unreviewable submission must be witnessed while unrelated work runs`)
        assert.match(notice.content, new RegExp(source.id))
        assertWitness(f, 'W2', `row 5 ${kind}`)
        await eventually(() => events(f.runtime, f.mission.id, 'task/review-missing').some(event => event.data.taskId === source.id),
          `row 5 ${kind}: the missing review is recorded durably`)
        await sleep(150)
        assert.equal(ownerNotices(f).filter(delivery => delivery.content.includes(source.id) && /no live independent review path/.test(delivery.content)).length, 1,
          `row 5 ${kind}: an unchanged mixed board does not spam`)
        rows[`row5_${kind}`] = { witness: 'W2', taskId: source.id }
      } finally { await f.cleanup() }
    }

    // Row 5d — owner finding (mission-live): the same unreviewable submission
    // with a live, capable independent reviewer and unrelated running work. The
    // runtime's deliberate rule is kept (an automatic review is admitted only
    // when the board would otherwise stall), so the witness is the owner notice,
    // and it must name the exact review to admit.
    {
      const f = await setup()
      try {
        const source = f.propose({ title: 'Implementation source' })
        const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
        await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
        const other = f.propose({ title: 'Unrelated running work', kind: 'research', checks: undefined })
        await f.runtime.claim(f.actor(f.author), f.mission.id, other.id)
        assert.equal(taskOf(f.runtime, other.id).status, 'running')
        assert.equal(f.runtime.store.get('members', f.reviewer.id).status, 'idle', 'the independent reviewer is live and capable')
        const notice = await eventually(() => ownerNotices(f).find(delivery => delivery.content.includes(source.id) && /no live independent review path/.test(delivery.content)),
          'row 5d: a capable idle reviewer behind live work must still produce a witness')
        assert.match(notice.content, new RegExp(`reviewOf ${source.id}`), 'the notice tells the owner exactly what to admit')
        assertWitness(f, 'W2', 'row 5d')
        assert.equal(reviewsOf(f, source.id).length, 0, 'the deliberate rule is kept: no automatic review while the board can still progress')
        rows.row5_capable_reviewer = { witness: 'W2', taskId: source.id }
      } finally { await f.cleanup() }
    }

    // Row 6 — R10-15: a review (here the running attempt) stuck behind a parked
    // holder is a stall signal, and the park never spends a recovery credit.
    {
      const f = await setup({ config: { leaseMs: 60_000 } })
      try {
        const task = f.propose()
        const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
        const firstAttempt = claimed.attempt.id
        // The adapter-side park state a pre-fix swarm_wait could create.
        f.runtime.store.transaction(() => {
          const parked = f.runtime.store.get('members', f.author.id)
          parked.status = 'waiting'
          f.runtime.store.put('members', parked)
        })
        const notice = await eventually(() => ownerNotices(f).find(delivery => /parked member/.test(delivery.content)),
          'row 6: a parked holder must emit a stall signal')
        assert.match(notice.content, new RegExp(task.id))
        assertWitness(f, 'W2', 'row 6')
        // Force the lease to expire: the park must not spend a recovery credit.
        const expiring = taskOf(f.runtime, task.id)
        expiring.attempt.leaseUntil = Date.now() + 5
        f.runtime.store.transaction(() => f.runtime.store.put('tasks', expiring))
        const after = await eventually(() => {
          const current = taskOf(f.runtime, task.id)
          return current.attempt?.id !== undefined && current.attempt.id !== firstAttempt ? current : undefined
        }, 'row 6: the parked attempt must be re-pended and re-dispatched')
        assert.equal(after.recoveryCount ?? 0, 0, 'row 6: a park must not spend a recovery credit')
        rows.row6 = { witness: 'W2', taskId: task.id, credits: after.recoveryCount ?? 0 }
      } finally { await f.cleanup() }
    }

    // Row 7 — pending tasks exist but none is ready: stall notice naming them.
    {
      const f = await setup()
      try {
        const blocked = f.propose()
        await blockThroughReview(f, blocked)
        // A dependent admitted before its prerequisite blocked, now not-ready
        // forever: the enumerated state has pending work and no dispatchable task.
        const dependent = { ...taskOf(f.runtime, blocked.id), id: 'task_f19_dependent', title: 'Dependent on dead work',
          dependencies: [blocked.id], status: 'pending', assigneeId: undefined, attempt: undefined, epoch: 0,
          artifact: undefined, evidenceIds: [], reviewOf: undefined, replaces: undefined, output: undefined, recoveryCount: undefined }
        f.runtime.store.transaction(() => f.runtime.store.put('tasks', dependent))
        const stall = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled').at(-1),
          'row 7: a board with only not-ready pending work must stall')
        assert.ok(stall.data.unschedulable.includes(dependent.id), 'row 7: the stall names the unschedulable dependent')
        assertWitness(f, 'W3', 'row 7')
        rows.row7 = { witness: 'W3', taskId: dependent.id }
      } finally { await f.cleanup() }
    }

    // Row 7b — T1av2 (evidence_978a4694): running work plus a pending dependent
    // whose prerequisite is not accepted. The documented row-3 exemption covers
    // only an all-running board, so this state must still leave a W2 notice.
    {
      const f = await setup({ config: { leaseMs: 60_000 } })
      try {
        const first = f.propose({ title: 'Running work' })
        await f.runtime.claim(f.actor(f.author), f.mission.id, first.id)
        assert.equal(taskOf(f.runtime, first.id).status, 'running')
        const prerequisite = f.propose({ title: 'Pending prerequisite' })
        const dependent = { ...taskOf(f.runtime, prerequisite.id), id: 'task_f19_running_dependent', title: 'Pending dependent',
          dependencies: [prerequisite.id], status: 'pending', assigneeId: undefined, attempt: undefined, epoch: 0,
          artifact: undefined, evidenceIds: [], reviewOf: undefined, replaces: undefined, output: undefined, recoveryCount: undefined }
        f.runtime.store.transaction(() => f.runtime.store.put('tasks', dependent))
        const notice = await eventually(() => ownerNotices(f).find(delivery => /made no progress|Mission stalled/.test(delivery.content)),
          'row 7b: running work plus a not-ready dependent must still leave a witness')
        assertWitness(f, 'W2', 'row 7b')
        assert.match(notice.content, /swarm_propose|swarm_control/, 'the notice names a decision the owner can take')
        rows.row7b = { witness: 'W2', taskId: dependent.id }
      } finally { await f.cleanup() }
    }

    // Row 8 — R10-14: coverage complete, mission still active: one durable owner
    // notice, no silent return, and no auto-completion of an owner-assembled plan.
    {
      const f = await setup()
      try {
        const task = f.propose()
        await acceptThroughReview(f, task)
        const notice = await eventually(() => ownerNotices(f).find(delivery => /ready to complete/.test(delivery.content)),
          'row 8: a coverage-complete owner-assembled mission must announce readiness')
        const mission = f.runtime.store.get('missions', f.mission.id)
        assert.equal(mission.status, 'active', 'row 8: the owner keeps the completion decision')
        assert.equal(mission.coverageNotice, f.runtime.fingerprint(f.mission.id), 'row 8: the durable coverage marker is keyed by F(S)')
        assertWitness(f, 'W2', 'row 8')
        await sleep(80)
        assert.equal(ownerNotices(f).filter(delivery => /ready to complete/.test(delivery.content)).length, 1, 'row 8: an unchanged state must not spam')
        rows.row8 = { witness: 'W2', taskId: task.id }
      } finally { await f.cleanup() }
    }

    // Row 9 — all tasks accepted but a criterion is uncovered: the stall notice
    // carries the exact completionError reason.
    {
      const f = await setup({ acceptance: ['fault recovery is proven from durable state', 'second uncovered criterion'] })
      try {
        const task = f.propose({ acceptance: ['fault recovery is proven from durable state'] })
        await acceptThroughReview(f, task)
        const stall = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled').at(-1),
          'row 9: an uncovered criterion must stall')
        assert.match(stall.data.reason, /Accepted tasks do not cover every mission acceptance criterion/)
        assert.match(stall.data.reason, /second uncovered criterion/)
        assertWitness(f, 'W3', 'row 9a')
        rows.row9 = { witness: 'W3', reason: stall.data.reason }
      } finally { await f.cleanup() }
    }

    // Row 9b — a second implementation branch with no integration task stalls
    // with the same diagnostic completion would report.
    {
      const f = await setup()
      try {
        const first = f.propose({ title: 'Branch one' })
        await acceptThroughReview(f, first)
        const second = f.propose({ title: 'Branch two' })
        await acceptThroughReview(f, second)
        const stall = await eventually(() => events(f.runtime, f.mission.id, 'mission/stalled').at(-1),
          'row 9b: two implementation artifacts without an integration must stall')
        assert.match(stall.data.reason, /Coding missions require an independently accepted integration artifact/)
        assertWitness(f, 'W3', 'row 9b')
        rows.row9b = { witness: 'W3', reason: stall.data.reason }
      } finally { await f.cleanup() }
    }

    // Row 10 — a task ceiling blocks the task and wakes the owner.
    {
      const f = await setup()
      try {
        const task = f.propose({ maxSteps: 1 })
        await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
        await f.workers.callbacks.beforeStep(f.author.id)
        assert.equal(await f.workers.callbacks.beforeStep(f.author.id), false)
        assert.equal(taskOf(f.runtime, task.id).status, 'blocked')
        const notice = await eventually(() => ownerNotices(f).find(delivery => /ceiling/.test(delivery.content)),
          'row 10: a task ceiling must wake the owner')
        assert.match(notice.content, new RegExp(task.id))
        assert.ok(events(f.runtime, f.mission.id, 'task/ceiling-exhausted').length >= 1)
        assertWitness(f, 'W2', 'row 10')
        rows.row10 = { witness: 'W2', taskId: task.id }
      } finally { await f.cleanup() }
    }

    // Row 11/15 — the mission budget ceiling blocks the mission at the
    // transition with a durable notice (W2) keyed by the blocked fingerprint.
    {
      const f = await setup({ budget: { maxTokens: 10 } })
      try {
        const task = f.propose()
        await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
        // An authoritative usage snapshot past the ceiling blocks the mission
        // synchronously at the transition (no scheduler race).
        await f.workers.callbacks.usage(f.author.id, 100)
        const mission = f.runtime.store.get('missions', f.mission.id)
        assert.equal(mission.status, 'blocked', 'row 11: the mission blocks at the aggregate ceiling')
        assert.match(mission.reason, /Aggregate mission budget exhausted/)
        await eventually(() => ownerNotices(f).find(delivery => /Aggregate mission budget exhausted/.test(delivery.content)),
          'row 11: the block transition wakes the owner')
        assertWitness(f, 'W2', 'row 11/15')
        rows.row11 = { witness: 'W2', status: mission.status }
      } finally { await f.cleanup() }
    }

    // Row 12 — an open challenge is a durable notice and blocks completion.
    {
      const f = await setup()
      try {
        const task = f.propose()
        const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
        const evidence = publishEvidence(f, task, claimed.attempt.id)
        await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate with evidence' })
        const review = f.runtime.propose(f.owner, f.mission.id, {
          workstreamId: f.stream.id, title: 'Review', objective: 'Independent review', kind: 'verification',
          reviewOf: task.id, scope: ['**'], acceptance: ['fault recovery is proven from durable state'], assigneeId: f.reviewer.id,
        })
        const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
        await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Checks pass' })
        assert.equal(taskOf(f.runtime, task.id).status, 'accepted')
        f.runtime.challenge(f.actor(f.reviewer), f.mission.id, { evidenceId: evidence.id, reason: 'Counter-evidence changes the conclusion', toolRunIds: [] })
        await eventually(() => ownerNotices(f).find(delivery => /challenged/.test(delivery.content)), 'row 12: the challenge must wake the owner')
        assert.equal(f.runtime.store.get('evidence', evidence.id).status, 'challenged')
        assert.equal(f.runtime.snapshot(f.owner, f.mission.id).completion.eligible, false, 'row 12: an open challenge blocks completion')
        assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'too early'), /unfinished or blocked required work|Unresolved evidence challenges/)
        assertWitness(f, 'W2', 'row 12')
        rows.row12 = { witness: 'W2', evidenceId: evidence.id }
      } finally { await f.cleanup() }
    }

    // Row 13 — a member failure wakes the owner with the failure.
    {
      const f = await setup()
      try {
        f.workers.callbacks.failure(f.author.id, 'provider exploded')
        const notice = await eventually(() => ownerNotices(f).find(delivery => /Author failed/.test(delivery.content)),
          'row 13: a member failure must wake the owner')
        assert.match(notice.content, /provider exploded/)
        assert.ok(events(f.runtime, f.mission.id, 'member/failure').length >= 1)
        assertWitness(f, 'W2', 'row 13')
        rows.row13 = { witness: 'W2' }
      } finally { await f.cleanup() }
    }

    // Row 14 — a classified provider outage is never silent and spends no
    // recovery credit. (The D2 classification itself is delivered by T2; this row
    // asserts the no-silent-state contract for the same state.)
    {
      const f = await setup()
      try {
        const before = f.runtime.store.get('missions', f.mission.id).usedTokens
        f.workers.callbacks.failure(f.author.id, '429 Too Many Requests: provider quota exceeded')
        const notice = await eventually(() => ownerNotices(f).find(delivery => /quota|429/.test(delivery.content)),
          'row 14: a provider outage must be routed to the owner, never silent')
        assert.equal(f.runtime.store.get('missions', f.mission.id).usedTokens, before, 'row 14: no silent budget burn')
        assertWitness(f, 'W2', 'row 14')
        rows.row14 = { witness: 'W2' }
      } finally { await f.cleanup() }
    }

    // Row 16 — pausing is an owner decision: the transition is durable and the
    // witness is recorded, and a paused board does not spam.
    {
      const f = await setup()
      try {
        const mission = f.runtime.control(f.owner, f.mission.id, 'pause', 'owner paused the mission')
        assert.equal(mission.status, 'paused')
        assert.ok(events(f.runtime, f.mission.id, 'mission/pause').length >= 1)
        assertWitness(f, 'W2', 'row 16')
        const count = ownerNotices(f).length
        await sleep(80)
        assert.equal(ownerNotices(f).length, count, 'row 16: a paused mission must not spam the owner')
        rows.row16 = { witness: 'W2', status: mission.status }
      } finally { await f.cleanup() }
    }

    // Row 17 — zero-task, zero-member active mission: documented exemption; the
    // test asserts no notice and a fingerprint stable across ticks.
    {
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'swarm-f19-empty-')))
      const workers = new FakeWorkers()
      const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 10,
        maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 3 }, workers)
      try {
        await runtime.start()
        const owner = { sessionId: 'f19-empty-owner' }
        const mission = runtime.create(owner, { title: 'Empty', objective: 'Owner still planning', workspace: directory, scope: ['**'],
          acceptance: ['x'], budget: { maxTokens: 10000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 0 } })
        const first = runtime.fingerprint(mission.id)
        await sleep(120)
        assert.equal(runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner').length, 0, 'row 17: the documented exemption is not spammed')
        assert.equal(runtime.store.get('missions', mission.id).witness, undefined, 'row 17: no witness is fabricated for the exemption')
        assert.equal(runtime.fingerprint(mission.id), first, 'row 17: wall-clock ticks never change F(S)')
        rows.row17 = { witness: 'exempt' }
      } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) }
    }

    // The board is stable under task/member order and sensitive to real change.
    {
      const { missionFingerprint } = await import('../../lib/runtime.js')
      const f = await setup()
      try {
        const task = f.propose()
        const base = clone(f.runtime.fingerprintBoard(f.mission.id))
        assert.equal(f.runtime.fingerprint(f.mission.id), missionFingerprint(base))
        const shuffled = { ...base, tasks: [...base.tasks].reverse(), members: [...base.members].reverse() }
        assert.equal(f.runtime.fingerprint(f.mission.id), missionFingerprint(shuffled), 'F(S) is order-independent')
        const changed = { ...base, tasks: base.tasks.map(item => item.id === task.id ? { ...item, status: 'running' } : item) }
        assert.notEqual(missionFingerprint(changed), f.runtime.fingerprint(f.mission.id), 'F(S) changes when the board changes')
        rows.fingerprint = { stable: true }
      } finally { await f.cleanup() }
    }

    return { rows: Object.keys(rows).sort(), witnesses: rows }
  },
})
