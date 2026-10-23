# Validation

Current **0.7.0** working-tree checks and the historical **0.6.0** baseline are recorded separately below. The supported Harness release remains a prerelease; matching a version string alone does not establish compatibility with an arbitrary checkout or profile. Exactly one release is supported, `0.2.1-rc.2`. `0.1.5-rc.3` (`a4c74a91e06b00fe0b0937bde982170c526cc842`) and `0.1.7-rc.1` (`46a7f68b0922371ce7144b668b90e377d8e799f4`) were dropped on 2026-10-22, and `a28b116` is the last revision that supports them. Entries from round 28 until `0.2.1-rc.2` was added record checks on those two hosts (`0.1.5-rc.3` was then the default host), the 2026-10-21 entry records checks on all three, and entries from 2026-10-22 on record checks on `0.2.1-rc.2` alone; entries before round 28 record checks against the releases supported at the time (`0.1.2-rc.1`, `0.1.3-alpha.2`, `0.1.5-rc.1`, `0.1.6-alpha.2`), which are no longer supported either.

| Harness release | Exact source commit |
| --- | --- |
| `0.2.1-rc.2` (npm `latest` and `next`) | `687f282e8625c6b8d11ff58211a90524be2e4317` |

Where entries say the owner runs a suite "in the round gate" or "in the gate" (the round-4 baselines of 2026-09-09), they describe the practice of that time. `scripts/round.mjs gate` last ran on 2026-09-10, and its own suite list never had `test:oracle`. The batches after it, up to batch A of 2026-10-24, were merged with a plain `git merge` on gate runs kept outside the repository, each with a suite list kept by hand. `test:isolation` was in none of them until the 0.1.x drop's gates of 2026-10-23, and `test:load` in none between 2026-09-24 and then. Since the gate manifest (2026-10-24), `npm run verify`, the round gate and CI run the suites one manifest lists, and each run records every suite as passed, failed, or skipped with the prerequisite it lacked; see [Reproduce](#reproduce).

## Self-review batch A: CORE-02, CORE-05, CORE-01, CORE-04, CORE-03, and CORE-06 from the live smoke (2026-10-24)

**Head**: `1218e86`, where the final gates ran (the third gate run below), and this record's revision
(documentation only), branch `swarm/batch-a-core` on `dac6704` (main), not merged. Batch A (verdicts, evidence basis,
durable identities) of the follow-ups from the owner's 2026-10-22 self-review, in the order its verification set:
CORE-02, CORE-05, CORE-01, CORE-04 and CORE-03 (`09d6c5d` to `6dc97f6`), each followed by a correctness review (the
medium findings of the CORE-05 and CORE-03 reviews were repaired within their slices, `498b58a` and `630f015`); one
review repair round over the batch (`e13f804` to `17fbd1c`); the first version of this record (`268a2c5`); CORE-06
(`1218e86`), the fix for what the owner's live smokes found at `268a2c5`; and this amendment. The verification read
`a28b116`; every anchor was re-located on `dac6704`, after the 0.1.x drop and the W8 route rule. `src` against
`dac6704` at `17fbd1c`: +713 −286, net +427. By slice: CORE-02 +200 −44 (net +156), CORE-05 +109 −96 (+13), CORE-01
+95 −23 (+72), CORE-04 +141 −66 (+75), CORE-03 +102 −34 (+68), and the repair round +136 −93 (+43). CORE-06 adds
+367 −209 (+158), so `src` against `dac6704` at `1218e86` is +1076 −491, net +585.

**Merged** as `48ac499` (2026-10-24) on `dac6704`, after both live smokes passed at `82d4837` (`62a6d8a`). Main had not
moved, so the merged tree is `62a6d8a`'s.

**What each slice leaves at the head.**

- **CORE-02: one rule for a claim a verdict can still judge** (`09d6c5d`, `3584ea0`; documents `0736ab3`; repair
  `b32a413`, `59e4c90`, `17fbd1c`). `unjudgeable(evidence, owningTask)` (`src/task-graph.ts`) says why no verdict can
  judge a claim any more: `archived` (a rework archived it), `cancelled` (its task is), `superseded` or `refuted`
  (refuted by a claim that superseded it, or by a rejection), and, asked last, `review-evidence` (a review's own claim:
  `verify` judges the reviewed source's claims, and nothing reviews a review). `judgeable` and `judgeableClaims` build
  on it, and every reader that decided this on its own now reads it: the verdict loop, submission's live-claim test and
  artifact pinning, `completionError`'s disputed set (challenged and judgeable) and `challenge()`.
  - `challenge()` refuses any other claim with one coded conflict refusal, `[evidence_not_judgeable]`, which replaces
    `[evidence_archived]` and records nothing. Before, it set every claim a rework had not archived to challenged and
    fenced the task's dependents and reviews: (a) on a claim a rejection refuted it cancelled the rejecting review, so
    the owner's in-place resume was refused with `task_needs_replacement` and the false "invalidated after
    submission"; (b1) on a claim superseded within its task it re-opened the accepted source, blocked its running
    dependent and cancelled the accepting review; (b2) on a claim of a replaced, cancelled task it fenced a running
    dependent of the original while the accepted repair stood; and on a review's own claim it turned an accepted
    review back into a submission no verdict judges, or left a dispute nothing resolves, so the mission could not
    complete.
  - The refusal names the reason and the exit the caller has, and the runtime accepts that exit. The dispute moves to
    the work the claim was about (the superseding claim's task; the reviewed source, for a review's claim; else the
    claim's own task), and to the task that carries that work's obligation now: `graph.carrier(id)` is the task itself
    while no replacement of it is live, else its live replacement's carrier, the one task owner control acts on. For a
    rejection the owner's exit is the one control takes: `swarm_control` resume (with a raised `maxRework` once the
    reworks are spent), or a replacement for a rejected experiment. A member asks for it with `swarm_escalate`, by
    `taskId` when it answers for the task. Each rule the refusal states has one owner it shares: `controlTask` and the
    refusal read `reworkableRejection`; `controlTask`, the repair path a rejection names (`rejectionRepair`) and the
    refusal read `reworksSpent`; and `escalate` and the refusal read `taskOwnerId`. `controlTask`'s `[task_replaced]`
    refusal names the carrier too: with T1 rejected, T2 replacing it and rejected, and T3 replacing T2 and pending, it
    named the first live descendant and told the owner to resume T2, which control refuses.
  - F3-B: an acceptance resolves supersession among the claims it judges before it verifies any. With same-task
    supersession the first acceptance verified the predecessor in `evidenceIds` order and then refuted it under the
    same verdict. The predecessor is now refuted after its superseder's `evidence/verified` and never verified; a chain
    is refuted link by link, each `refutedBy` naming its own superseder, and a superseded claim's refusal names that
    claim without calling it verified (only the chain's head is). An inconclusive claim is never verified, so it still
    supersedes nothing.
  - The repair round departs from the approved fix in one place: the answering task is `graph.carrier`, not
    `graph.effective`, which follows a withdrawn repair (T1 blocked with its only repair T2 cancelled gives T2, while
    control resumes T1) and can end on a cancelled branch while a blocked sibling repair carries the obligation.
- **CORE-05: a check pass is recorded under the attempt that ran it** (`c5fb7a9`, `498b58a`, `09828fa`; documents
  `2ba4b7e`; repair `166c35a`, `6c64ba2`). `verify()` hands `DeclaredChecks.run` the review task and attempt that its
  phase-1 `ownAttempt` proved the caller holds (`VerificationAttempt`), and a failed first pass is always written
  durably under that attempt. Before, the runner looked the attempt up on the board when the first pass failed. An
  attempt fenced while that pass ran (a lapsed lease, an owner cancel or amendment, a pause or stop, a revoked
  workspace, a sibling verdict) had none, so the pair was held in memory under `member:commit:source` with no attempt
  id. The fenced attempt could never use it, and the same member's next attempt on the same review and commit picked
  it up: it wrote the dead attempt's passes under its own id and cited the dead retry's row, or, if it was already
  open when that pass returned, had its own single clean pass recorded as a retry. `checkRuns`,
  `verificationAttempt`, `sourceOf` and the held-pair branch of `recordRuns` are deleted. In the repair round `run()`
  returns `DecidingPass { checks, pass: 1 | 2 }` and `recordRuns` writes that pass, so the attempt-scoped lookup
  `firstPassRecorded` goes too. It labelled a clean second call by the same attempt, after
  `[checks_changed_during_verification]` or `[check_environment_mismatch]`, as pass 2, and its one intended case, a
  pre-crash failure paired with a post-crash pass on the same attempt, cannot occur: `start()` re-pends every running
  row and ends its attempt.
  - The slice review's medium finding (`498b58a`): `reviewPathBlocker` (`src/board.ts`) composed a deferred review's
    exit from the review's newest classified failure, and a fenced attempt's late first pass can now be that row, so
    the owner could be told to raise `checkTimeoutMs` when the host needed repair. A deferral now names its deciding
    pass's rows on the task, `verificationRecovery.toolRunIds` (the ids its `task/verification-deferred` event carries
    as `checks`, written in the same transaction), and the blocker composes the exit from exactly those rows.
  - **Schema 8.** Opening a store an older build wrote upgrades it once, in the opening transaction
    (`SwarmStore.deferralsNameTheirPass`): each stored deferral takes the rows its review's newest deferral event
    names (every build since `69211b9` writes that event with the deferral, and a resume clears the deferral). A
    deferral no event names, which no build writes, names no rows, so its blocker offers the resume alone. As after
    schema 7, an older build then refuses the store. The tests that pin the schema number move from 7 to 8, the
    later-schema probe from 8 to 9, and two hand-built deferral fixtures gain the field.
- **CORE-01: an acceptance without checks rests on published review evidence, and every acceptance records its
  basis** (`2d27e52`; documents `0ac8f75`). When the source declares no host checks, `swarm_verify` accept needs at
  least one claim the reviewer published with `swarm_publish` on the accepting attempt that still stands
  (`reviewEvidence`, `src/task-graph.ts`: current, on a review that is not cancelled, citing only runs of that attempt;
  exactly the claims `unjudgeable` answers `review-evidence` for). Without one it is refused with
  `[review_evidence_required]` (`validation_error`); nothing is recorded and the attempt keeps running. This replaces
  the count of the attempt's non-error tool runs, which accepted on one unrelated call and named none of it. Every
  acceptance records its basis, `{ kind: 'checks', runIds }` (the deciding pass's rows, equal to `task/accepted`'s
  `checks`) or `{ kind: 'review-evidence', evidenceIds }`, on `task/accepted`, on each verified `evidence/verdict` row,
  on the accepting review (`acceptanceBasis`) and in the artifact registry (`review.basis`). `WORKER_PROMPT` and the
  `swarm_verify` description tell the model the rule. Where the slice departs from the brief:
  - A rejection records no basis: it needs no evidence, and its grounds are its check failures and reason. A basis on
    every verdict would need a third kind (judgement with no evidence), archived into `TaskRejection` when a rework
    re-opens the review.
  - The basis kind follows whether the verdict classified host check rows, not `source.checks.length`; for the real
    adapter the two agree, since a source without checks yields no check rows.
  - `task/accepted` keeps its `checks` field. No schema bump: the field is optional, and an acceptance an older build
    recorded has none (the registry leaves it out).
  - A `swarm_observe` read stays uncitable by design. `swarm_*` calls are never recorded runs (the worker adapter skips
    them and `recordToolRun` returns early); recording them would make protocol reads research evidence, renew leases
    and feed the git-write and temp-rendezvous detectors; and the review workspace is checked out at the source's
    artifact commit, so an honest review always has a recorded way to inspect it. The report's path-name heuristic was
    not adopted.
- **CORE-04: both file locks share one owner identity** (`7178f10`; documents `a65cf64`; repair `e13f804`).
  `src/process-identity.ts` owns the identity a lock records, `{ pid, birth }` (`recordedOwner`; this process's birth
  is read once, `ownBirth`), and the one takeover rule, `ownerAbandoned`: an owner is abandoned when no process holds
  its PID, or when the process holding it has a valid birth on the same platform that differs from the recorded one. A
  live PID with no birth, an unrecognised or unreadable one, or one from another platform keeps its lock.
  `processBirth` and `validProcessBirth` moved there from `src/store.ts`. The store's runtime lock behaves as before,
  except that a recorded PID of 2^31 or more is refused as an invalid lock instead of throwing a `TypeError` from
  `process.kill`. The delivery apply lock's `owner.json` records `{ pid, birth }` and drops the `createdAt` nothing
  read (older owner files still parse), so a host killed inside an apply window no longer leaves a lock that a later
  holder of its PID keeps; the owner record is built before the `mkdir`. The refusal names the lock path and the
  owner PID, with the exit of removing the lock by hand, and `applyDelivery` releases the lock in its own `finally`
  after the scratch cleanup, so a failed `rm` of the scratch directory can no longer leave the live host holding the
  lock until it restarts.
- **CORE-03: the attempt-silence basis is read from the whole log** (`c808a63`, `630f015`, `6dc97f6`; documents
  `9ae5cc9`). The attempt reporting bound measured silence from the newest row it found in the presentation window
  (`store.events(missionId, maxEvents)`). A worker whose last report was one `swarm_*` span lost it once other members
  wrote more than `maxEvents` rows: the basis fell back to the assignment delivery, and the same silence was told again
  under a new dedup key, overstated by the span's age. `SwarmStore.attemptEventAt` now reads the event term from the
  whole append-only log at named paths only (`ATTEMPT_PATHS`: `$.attempt.id`, `$.attemptId`, `$.activity.attemptId`,
  and `$.taskId` from the claim's sequence on), each through its own partial index. `lastDurableAt` takes the max of
  that, the attempt's tool runs and the deliveries naming it or its task, with the assignment delivery as the floor, so
  the basis and the dedup key only move forward. The deep match (`identityIn`) is gone: a sibling's proposal naming
  the task in `dependencies`, or an outage's `taskIds`, no longer re-arms the clock, and an operation run under the
  attempt does. The dead `lastDurableAt === 0` branch of `silenceNotice` is removed. The slice review's medium finding
  (`630f015`): the silence instrument (`tests/instruments.mjs`) closed an attempt only at an event that also passed
  the progress test, and a verdict or deferral names its review only at `$.verificationTaskId`, so a review attempt
  ran on past its verdict. Which tasks a fencing event closes is now one rule, `tasksClosedBy` beside
  `ATTEMPT_FENCING_EVENTS` (`src/types.ts`), which the replay decoder reads, with no change in what it decodes, and
  the instrument reads too. `6dc97f6` documents that the claim-sequence bound covers the event term only.

**Review repair round** (2026-10-24; `e13f804` to `17fbd1c`). The batch review raised six medium issues. Each fix has
a test that fails without it, checked with the reviewer's mutants or their equivalents on the new code.

1. `e13f804` (tests): the CORE-04 tests skipped whenever `ownBirth()` or the recorded birth came back undefined, which
   is the output of the code under test, so the recycled-PID takeover could be switched off with the suite green.
   `tests/process-birth.mjs` now chooses by platform: on linux and darwin `establishedBirth()` asserts a birth in the
   platform's format, and only another platform skips. The mutants P13 (`ownBirth` returns undefined), P14 (the darwin
   `ps` branch returns undefined) and P11 (the store lock writes no birth) now fail.
2. `6c64ba2` (tests): the schema 8 upgrade test wrote one deferral event, so reading the oldest (`ORDER BY seq ASC`)
   passed. A review that deferred on a timeout, was resumed and deferred again on an infrastructure failure must now
   name the second pass and give its exit (mutant C5 fails).
3. and 4. `b32a413`: the dispute refusal re-derived resume eligibility and `escalate`'s ownership test, and answered
   "which task now answers for this one" with two lineage rules (`liveReplacement` and `effective`). It now reads the
   rules control and `escalate` own, through `graph.carrier` (above). Before, a refuted claim of a rejected experiment
   was told to resume it (`task_refuted`), and one whose task had spent its reworks to resume without raising
   `maxRework` (`task_rework_exhausted`).
5. `59e4c90`: a superseded claim's refusal called the claim that refuted it one "a verdict verified", which is false
   for every link of a chain but its head; the reason now reads "is refuted and superseded by evidence `<by>`".
   Following `refutedBy` to the head was not taken, since the head can itself be challenged or refuted later.
6. `166c35a`: the deciding pass's label comes from `run()` (above).

`17fbd1c` documents the dispute exits in `docs/known-limitations.md`; the README summary still holds.

**The live smokes at `268a2c5`** (2026-10-24). The owner's session ran both real-provider smokes at `268a2c5` on
`deepseek-official` / `deepseek-v4-flash`; their reports are kept with the batch's gate runner, outside the repository.

- `test:deepseek` passed: 27,792 tokens, 11 steps (10 model responses). Its source declares `node check.cjs`, so the
  reviewer's acceptance rested on checks; the CORE-01 path without checks did not run.
- `test:command-deepseek` hit the smoke's external limit, 36 model steps and 525,767 reported tokens against its cap
  of 500,000 tokens, with the owner alone reporting 358,670 tokens (the runtime accounted 43,147 to workers). The
  owner's plan gave the implementation task `maxSteps` 8. Each "Resource review" notice made the owner raise a task's
  allocation with `swarm_budget`, as the protocol asks: five raises, the implementation's `maxSteps` to 9, 11 and 15,
  then its review's to 10 and 13. Every raise moved the task row's revision. The implementer's `swarm_submit`, which
  had read the task before its artifact capture, was refused twice with `StaleTaskRevisionError` ("it presents
  revision 12 but the durable task is at revision 13; another write was accepted after this writer read the task",
  then 16 against 17; `putTask` and `refuseStaleTask` in `src/store.ts`) and accepted on its third call. Each refusal
  cost the worker steps, which triggered more resource reviews and more raises, until the limit stopped the run with the
  implementation submitted late, its review still running and the mission active. The revision guard dates from the
  S5r batch (`0eb26c6`), not from this batch.

**Root cause.** A transition that awaited I/O wrote back the copy of a row it had read before the await, and that
write went through the per-task revision guard (`src/store.ts` `putTask`/`refuseStaleTask`). That guard was added in
S5r (`0eb26c6`). In `submit` (`src/runtime.ts`), `ownAttempt` read the task and `fenceAttempt` wrote it. Then
`await captureArtifact` ran, and `ownAttempt` re-checked the attempt, but its fresh row was thrown away. The commit
then did `store.put('tasks', task)` with the row read before the capture. `controlTask` (what
`swarm_budget(taskId, taskBudget)` calls) is synchronous and outside the mission queue, so the owner's
allocation-only raise during the capture moved the revision, and submit was refused with `StaleTaskRevisionError`
even though nothing it depends on had changed. The same hazard was in four more places:

1. A review's lease fence after `await inspectArtifact` (`Attempts.fenceAttempt` on the copy read before the await).
2. `applyDelivery` wrote the mission copy from before the apply, silently reverting a usage charge (mission rows have
   no revision guard).
3. The staged-plan member repair wrote a member copy read before `await invalidateComposition`, reverting a usage
   report.
4. Every other continuation re-read its row by hand (the S1 sites).

It was reproduced deterministically, without a provider, with a capture gate and `controlTask` amend `{ maxSteps }`.
Main `dac6704` fails the same way: it was exported with `git archive` into a scratch directory, its `node_modules`
linked to the 0.2.1-rc.2 link farm, and built. An export rather than a git worktree was used, so the shared
repository metadata was not touched.

**CORE-06: a transition that awaited writes the row its commit reads** (`1218e86`). One owner,
`SwarmRuntime.revise` (`Kernel.revise`). A transition that awaited I/O after reading a task, member or mission row
writes it only through `revise`, which opens the commit, reads the row inside it (a mission through `mission`, which
folds its clock) and hands it to the transition's change. The change re-validates the transition's fence on that row
and sets only the fields the transition owns; `revise` writes the row and runs the transition's effects in the same
transaction. A concurrent write the transition does not conflict with (an owner's `swarm_budget` raise, a published
claim, a usage charge) is kept. A conflicting one refuses the transition with its own typed code (the change throws)
or, for background work, makes it moot (nothing written, nothing published). Inside an open commit `revise` joins it.
The revision guard stays as the backstop for a whole-row write of a stale task copy, and `docs/known-limitations.md`
states the rule. The audit, site by site:

- `submit`: a bug; it wrote the pre-capture copy. It now uses `revise`: `submissionFence` checks the attempt on the
  row the commit reads and refuses with a typed code, `[task_cancelled]`, `[task_attempt_fenced]` or
  `[task_attempt_stale]`, naming the captured artifact; any other check (budget pause, prerequisite) keeps its own
  refusal. The live claim, `rework_unchanged`, the artifact checks and `missingReviewPath` are decided on that row.
  Owned fields: `artifact`, `output`, `status`.
- `verify` phase 1 (`src/runtime.ts` and `Attempts.fenceAttempt`): a bug; the lease fence wrote the review copy read
  before `inspectArtifact`. `fenceAttempt` now uses `revise` and is moot when the attempt has moved, so the
  `ownAttempt` that follows refuses with `task_attempt_stale`.
- `verify` phase 2, verdict and deferral: it already re-read and re-checked by hand. Its final commits now use
  `revise` on the review row. The attempt check (`heldAttempt`) and the source facts (a single `currentSource`
  closure, so each coded refusal still appears once) are asked at the start of the turn and again inside the commit.
  The commit that only records runs on an environment mismatch is unchanged.
- Claim → `assign`: `assign` now uses `revise` with a `sameChoice` fence (the row half of `stillChosen`,
  `src/board.ts`) and refuses with `[task_changed_during_preparation]`; the claim's own `stillChosen`/ready check
  after the await is kept. The dispatcher (`src/scheduling.ts`) assigns through the same `assign`, and its
  preparation failure after `prepareTask` uses `revise` with `sameChoice` (moot).
- `Attempts.closeOutIdleAttempt`: the checkpoint-failed and checkpointed outcomes now use `revise` instead of the hand
  re-read (S1); the nudge branch writes in the turn it reads and is unchanged. `Attempts.recoverExpired`: the
  lease-expiry checkpoint and the expiry now use `revise`; `renewActiveOperation` reads by id in the turn that writes
  and is unchanged. `Attempts.resumeStoppedAttempt`'s deferred path: the barrier release after stop and
  `checkpointTask`, and the stop-failure record, now use `revise`; the synchronous force, marker and legacy-peer
  writes are unchanged.
- `applyDelivery` (mission): a bug; it reverted concurrent mission writes. It now uses `revise` and owns
  `appliedDelivery`.
- `repairDraftAdmissions`: a bug on the member row (a copy read before `invalidateComposition`). The member now uses
  `revise` with the `assertStaged` fence and owns the route fields, `phase`, and `sessionId` when it changes; the
  mission plan fields also use `revise`.
- `addMember`: the baseline (mission) and the failure path (member) now use `revise`; the new member row is a fresh
  insert. The `launchDraft` activation (mission) now uses `revise`, fenced by `active()`, `assertCurrent` and staged;
  the draft rows keep their own revision check. Control's deferred member stop after `workers.stop` and
  `gates.beginBudgetStop`'s deferred quiesce now use `revise`. The `notices.flushOutbox` mission acknowledgement uses
  `revise`, joined to its commit; the delivery row is still re-read inside that commit (deliveries are outside the
  rule's tables).
- Unchanged: `startPlan`'s final commit already reads the mission inside its commit (its start rows are outside the
  rule). `publish`, `controlTask`/`swarm_budget`, `updateBudget`, `control`, `cancel`, `propose` and replacement,
  `challenge`, `handoff`, `escalate`, `message`, `post`, `wait`, `subscribe` and `amendScope` have no await between
  read and write. `beforeStep`, `recordToolRun`, `onIdle`, `onActivity`, `onStartFailure`, `recordStarted`,
  `onRecoveryFallback`, the usage gates (`usage`, `usageSnapshot`, `recordOwnerUsage`), `blockBudget`,
  `resumeBudgetTasks`, `blockTaskCeiling`, the workspace admission's `fenceWorkspace`, `recordOutboxStarvation` and
  `start()`'s recovery read their row by id in the turn that writes it. `schedule` never writes the mission it read
  when the pass started after its awaits; its helpers use it only for the id and the deadline.

**User-facing changes.**

- `swarm_challenge` of a claim no verdict can still judge (refuted by a rejection, before the rework too; superseded;
  of cancelled work; a review's own claim) is refused with `[evidence_not_judgeable]`, which replaces
  `[evidence_archived]` and names where the dispute can still go. Such a dispute can no longer cancel the review that
  rejected a task, defeat the owner's resume or re-open accepted work. A dispute an older build recorded on a review's
  own claim no longer holds a mission open; an accepted review an older build turned back to `submitted` that way
  stays unfinished until the owner cancels it (there is no migration).
- An acceptance no longer reports a superseded claim verified and then refuted: the predecessor is only refuted.
- A reviewer of a source without checks must publish at least one claim with `swarm_publish` on its review attempt
  before it accepts (`[review_evidence_required]` otherwise). Every acceptance shows what it rests on, in the event log
  and in `swarm_registry` (`review.basis`).
- The store moves to schema 8 the first time this build opens it, and older builds then refuse it; going back needs a
  backup taken before. The operations guide and its zh-CN twin name schema 8.
- A deferred review's blocker gives the exit of the pass that deferred it.
- Apply result: a lock left by a killed host whose PID a later process reuses is reclaimed. Otherwise the refusal
  names the lock and the holding process, and the operations guide says when the lock may be removed by hand.
- An unchanged attempt silence is escalated once, from a basis that only moves forward.
- CORE-06: an owner's `swarm_budget` raise, a published claim or a usage charge made while a submission captures its
  artifact, a review inspects it, a claim or the dispatcher prepares a workspace, or a delivery is applied, is kept:
  it no longer makes that transition fail, and the transition no longer reverts it. A submission a conflicting write
  overtakes is refused with that write's own code, `[task_cancelled]` (new), `[task_attempt_fenced]` (new) or
  `[task_attempt_stale]` naming the captured artifact, instead of the stale-revision error; a review whose attempt was
  withdrawn during its inspection is refused with `[task_attempt_stale]`.

**The full-log oracle at the head against `dac6704`** (`npm run test:oracle`). One commit changed the logs: `2d27e52`
(CORE-01), re-recorded with `node scripts/replay/oracle.mjs --runs 3 --write` (three identical runs). It changed 19
lines in four logs (F12 2, F19 11, paths 2, replay 4). Each line changes in one field and nothing else, and every
basis is `checks`, since no scenario accepts a source without checks:

- Eight `task/accepted` events gain `basis: { kind: 'checks', runIds }`, equal to their `checks`: F12 runtime 1
  (event 10); F19 runtimes 14 and 15 (event 10 each), 16 (events 10 and 16) and 19 (event 12); paths runtime 4
  (event 10); replay (event 37).
- Two verified `evidence/verdict` events, the only two acceptances in the logs that verify a claim, gain the same
  basis: F19 runtime 19 event 13 and replay event 38.
- Eight accepting review rows gain `acceptanceBasis`, one per acceptance above: F12 `task#2`; F19 `task#2` in
  runtimes 14 and 15, `task#2` and `task#4` in runtime 16, and `task#2` in runtime 19, which a later challenge of the
  source's verified claim cancelled and which keeps its basis; paths `task#2`; replay `task#3`.
- One `trace/span` row: replay's `swarm_verify` span output grows from 1064 to 1154 bytes, because the review task the
  tool returns now carries its `acceptanceBasis` (90 bytes with the real 40-character run id; the log normalizes ids,
  but the size is the real result's).

No other commit changed a line: no scenario has same-task supersession (CORE-02 reorders nothing there), none defers a
review (schema 8 and the deciding-pass rows), and neither the lock identity nor the silence basis appears in a log.
CORE-06 (`1218e86`) changed none either, so nothing was re-recorded for it. All three gate runs below reproduced every
log, and the `test:replay` digest is unchanged,
`sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e`.

**Regressions.** The full suite has 1986 tests at `dac6704`, 2021 at `17fbd1c` and 2038 at `1218e86`: CORE-02 adds
10, CORE-05 4, CORE-01 5, CORE-04 5, CORE-03 4, the repair round 7 (and rewrites one R16-G5a test) and CORE-06 17.
For the first record, the test files at `17fbd1c` were also run against a `dac6704` build, and the CORE-01 and CORE-03
changes were reverted in a build of `17fbd1c`, each in a scratch copy since removed.

- CORE-02: `tests/claim-judgeability.test.mjs` (new, 12 tests): the rule; (a) with the owner's resume after the
  refused challenges; (b1); (b2); withdrawn work; a review's own claim before and after its verdict; completion over an
  older build's dispute; and, from the repair round, five tests that each perform the exit they pin (a rejected task a
  pending repair carries; the T1/T2/T3 chain, with control naming T3; a rejected experiment; spent reworks; an
  archived reviewer claim naming the source's claims). All 12 fail on `dac6704` (the rule test against stub imports).
  The repair round's mutants (no carrier; the first live descendant instead; no review-to-source mapping; no
  experiment check; no spent-rework branch; control naming `liveReplacement`) each fail at least one.
  `tests/verdict-honesty.test.mjs`: a chain is refuted link by link and its links' challenges are refused, each
  naming its own superseder and no verification; the existing re-review test now also asserts that the first
  acceptance never verifies the predecessor. Both fail on `dac6704`. Two new inconclusive cases pass on both, since an
  inconclusive claim supersedes nothing, as before. `completion-disputes`, `rework-in-place` and `rework-review` move
  to the new code, and `rework-review` asserts the archived review claim's full exit.
- CORE-05: `tests/declared-check-retry.test.mjs`: a review attempt fenced during its first pass keeps that failure
  under its own attempt, and the next attempt cites only its own passes; a next attempt already open is never
  credited with it; a fenced attempt's first pass recorded after the next attempt deferred leaves the deferral's exit
  alone (it fails on `c5fb7a9` with the `checkTimeoutMs` exit); a clean call after the same attempt's refused one
  records pass 1. All four fail on `dac6704`. The rewritten R16-G5a test restarts the runtime for real (the dead
  attempt's verdict is refused `task_attempt_stale`, and the next attempt records and cites its own pass 1) and passes
  on both. `tests/check-failure-exits.test.mjs`: the schema 8 upgrade of a stored deferral, and of one deferred again
  after a resume. Both fail on `dac6704`, as does the existing deciding-pass test, which now also asserts
  `toolRunIds`.
- CORE-01: `tests/acceptance-basis.test.mjs` (new, 5 tests). With the floor before CORE-01 restored in a build of the
  head (any non-error run of the attempt), the acceptance without checks and the claim of an earlier attempt are
  accepted and their tests fail; with the basis left off `task/accepted` and the review row, those two and the checked
  acceptance fail. The rejection test pins what did not change (no evidence needed, no basis), and the rule test pins
  `reviewEvidence`. `tests/runtime.test.mjs` (whose test pinned the old floor), `artifact-policy`,
  `completion-obligations`, `refusal-runtime-annotations` and `trace-events` follow the new rule and fields.
- CORE-04: `tests/delivery.test.mjs`: the apply lock records `{ pid, birth }`, is taken over from a recycled PID, and
  refuses its own live owner and a legacy owner with the new message; a scratch cleanup failure still releases it.
  Both fail on `dac6704`'s `src/delivery.ts` (a `dac6704` build with only `src/process-identity.ts` added, which the
  tests' birth helper imports). `tests/process-identity.test.mjs` (new, 3 tests) pins the rule once, and
  `tests/r12-store-fixes.test.mjs` asserts that the store lock records `ownBirth()`.
- CORE-03: `tests/silence-bounds.test.mjs`: the basis is the attempt's newest durable row in the whole log, so the
  window moving neither takes it back nor tells the silence twice; only a named path attributes an event to an
  attempt. Both fail with `src/scheduling.ts` restored to its state before `c808a63` in a build of the head. A third
  test pins `SwarmStore.attemptEventAt`, and a fourth (`630f015`) that the instrument ends a review attempt at its
  verdict; before its fix that test read an end at 50000 and a worst gap of 46000, where it expects 12000 and 8000.
- CORE-06: `tests/write-after-await.test.mjs` (new, 17 tests), run against builds of `268a2c5` and `dac6704`
  (`git archive` exports, as in the root cause above). Eleven regressions fail on both:
  - a submission racing a task `maxSteps` raise is accepted and keeps `maxSteps` 20;
  - task and mission budget raises made during a submission are accepted and survive it;
  - a claim published during the capture is kept and pinned to the artifact;
  - a submission racing an owner cancel is refused with `task_cancelled`, and one racing a structural amendment with
    `task_attempt_fenced`;
  - a lease lapsing during the capture is refused with `task_attempt_stale`, and the message names the artifact;
  - a review racing a raise on it reaches its verdict and keeps the raise;
  - a review whose attempt is withdrawn during its inspection is refused with `task_attempt_stale`, not
    `stale_task_revision`;
  - a delivery apply racing a usage charge keeps `usedTokens` 500 (it was 0 before the fix);
  - a staged-plan repair racing a member usage report keeps `accountedTokens` 777;
  - `revise` itself: a moot or refused call commits nothing and publishes nothing, and a call joined inside an open
    commit works.

  Six pins pass on both: a claim racing a raise; a claim racing a reassignment, refused with
  `task_changed_during_preparation`; a preparation failure; an idle close-out; a lease-expiry checkpoint; a stop
  barrier. Two existing files change: `makeRuntimeStub` (`tests/faults/harness.mjs`) gains a stub `revise`, and
  `tests/refusal-runtime-annotations.test.mjs` annotates `task_cancelled` and `task_attempt_fenced`. Before the fix, a
  scratch reproduction outside the suite (a capture gate and `controlTask` amend `{ maxSteps }`) gave
  `StaleTaskRevisionError`, revision 3 against 4, on `268a2c5` and on `dac6704`; on `1218e86` it passes (status
  `submitted`, `maxSteps` 20).

**Gates**, each run with `node_modules` linked to the 0.2.1-rc.2 link farm and `DSH_HARNESS_ROOT` set to the pinned
clone (`dsh-v0.2.1-rc.2`, `687f282e86`).

| Check | `6dc97f6` (2026-10-23 23:23 to 23:32) | `17fbd1c` (2026-10-24 01:02 to 01:14) | `1218e86` (2026-10-24 03:02 to 03:16) |
| --- | --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed | passed / passed |
| `node --test tests/*.test.mjs` | 2013/2014 (286 s): `S1/R17-G5` failed (below) | 2021/2021 (299 s), 0 cancelled, 0 skipped | 2038/2038 (451 s), 0 cancelled, 0 skipped |
| `npm run test:harness` | failed in `tests/harness-boundary-compaction.mjs` (below); re-run passed, 4 scripts | passed, 4 scripts | passed, 4 scripts |
| `npm run test:replay` | digest unchanged | digest unchanged | digest unchanged |
| `npm run test:oracle` | 12/12 identical | 12/12 identical | 12/12 identical |
| `npm run test:pack` | passed (254 archive entries, 254 published files) | passed (254, 254) | passed (254, 254) |
| `npm run test:profile` | passed | passed | passed |
| `npm run test:bundle` | 7/7 | 7/7 | 7/7 |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 | 24/24 |
| `npm run test:web` | passed, 13 checks | 13 checks passed, then killed after its report (exit 143, below); re-run alone passed, 13 checks | passed, 13 checks (64 s) |
| `npm run test:command-web` | passed, 11 checks | passed, 11 checks | passed, 11 checks (57 s) |
| `npm run test:isolation` | 6/6 | 6/6 | 6/6 |
| `npm run test:load` | D8 load envelope OK: observation bounded (max 1039 B and 1042 B, ratio 1.00x) | the same | the same |

The pack has three files more than at `af154be`: `lib/process-identity.js` with its `.d.ts` and `.js.map`. Every web
smoke's `report.json` records `harnessHead` `687f282e8625c6b8d11ff58211a90524be2e4317`. The harness, pack and profile
logs carry 9, 11 and 7 `[mission_operation_pending]` lines at `6dc97f6` (where the harness run stopped in its second
script), 19, 10 and 6 at `17fbd1c`, and 30, 14 and 9 at `1218e86`.

At `6dc97f6` two gates failed, each on a path the batch does not change. The load was not recorded for this run.

- `S1/R17-G5` (`tests/scheduling-pass.test.mjs:859`) failed at its assertion that the stranded drain woke one turn
  from inside the body (`0 !== 1`, line 936), the assertion the 2026-10-22 entry records failing most often under
  stress at `a28b116` and at `fcf5b5e`. The batch changes `lastDurableAt` in `src/scheduling.ts`, which that
  assertion does not read. Re-run alone the test passed, and its file passed 29/29. At `17fbd1c` the repair round
  re-ran the file (29/29) and the test by name three times (3/3) at load averages of 16 to 24, and the final full
  suite passed it.
- `test:harness` stopped in `tests/harness-boundary-compaction.mjs` with `swarm_propose failed: undefined`
  (`ownerCall`, line 123, called at line 204): no tool result followed the owner's input by the time the owner went
  idle. Re-run, `test:harness` passed all four scripts; the script then passed 6 of 6 runs alone and 12 of 12 in two
  rounds of six concurrent copies, and it passed in the final run. The repair round traced it to the owner session,
  which the batch does not touch: `installOwnerDeliveryFilter` (`src/harness-workers.ts:131`) can reject or empty an
  owner turn's opening step (line 149, since `ccbfdc1`), the pinned Harness's `AgentLoop.turn()` then returns without
  re-checking its inbox, and a wake sent while that driver runs is not latched, so owner input that arrives in that
  window waits for the next wake. `git diff dac6704..HEAD` is empty for `src/harness-workers.ts`, `src/index.ts`, that
  script and `tests/fixtures`.

At `17fbd1c` the web smoke's scenario passed: its `report.json` reads `passed: true` with 13 checks. The process then
did not exit within 30 s of its report, so the batch's gate runner (kept outside the repository) killed it, exit 143,
57 s in all. File times place the stall in the `finally` of `scripts/web-smoke-browser.mjs`, at
`await browser?.close()` (line 284), before the `dsh web` child is signalled. The try block's report and the server
log were written at 01:10:22 and the `finally`'s second report never was; the run's temporary root was still being
written by the live child until the runner's kill at about 01:10:55; and Playwright's profile directory, which Chrome
had begun to flush at 01:10:22, was never removed. Headless Chrome's shutdown stalled at load averages of 17 to 27,
with `fseventsd` near 97% CPU. The batch changes neither smoke script (`git diff dac6704..HEAD -- scripts/` touches
only the oracle logs). Re-run alone at a load average of 17.7 it passed, 13 checks, with its report at 21 s and its
exit 10 s later. It is the only one of the 30 web runs in the gate logs killed after its report. The kill left that
run's temporary root and Playwright profile in the system temporary directory, where they remain. It was not run at
`dac6704`: a failure that does not recur on the branch cannot be confirmed there either. One contributing factor
predates the batch: the same `finally` never clears the 10 s timer of its `Promise.race` (line 287), so every clean
web smoke stays alive 10 s after its child exits, a third of the runner's grace, and `browser.close()` has no bound of
its own.

At `1218e86` every gate passed on its first run, so nothing was re-run; the web smokes exited 64 s and 57 s after
they started, with no kill. One-minute load averages read 20.5 to 23.7 at the samples taken during the run
(fifteen-minute 25.5 to 27.9), with other sessions' Harness processes running on the machine. None of the four
full-suite failures CORE-06's own checks met (below) recurred.

**Repair-round checks** (before the final gates): typecheck and build; the lock tests 29/29 with none skipped;
`tests/check-failure-exits.test.mjs` 12/12; `claim-judgeability`, `rework-review` and `rework-in-place` 44/44;
`verdict-honesty` with `claim-judgeability` 21/21; `declared-check-retry` 8/8, whose new CORE-05 label test fails with
the old lookup patched back into the lib; related subsets of 480, 439 and 576 tests; `test:oracle` 12/12 identical;
`test:replay`; faults 24/24.

**CORE-06 checks** (before the final gates): typecheck (both tsconfigs) and build; the scratch reproduction and
`tests/write-after-await.test.mjs` against `268a2c5`, `dac6704` and the fix (above); a first full suite at 2016 of
2021, whose 5 failures came from the change (four stub kernels without `revise`, and a computed `PolicyError` code),
both fixed; a full suite on the final code at 2034 of 2038, whose 4 failures were `[mission_operation_pending]`
bounded waits and one bounded stop timer, hit while other test files ran at the same time, and whose three files
(`declared-check-retry`, `liveness-create-path`, `owner-decisions`) passed 35 of 35 alone and had not failed in the
first run; `test:harness` (4 scripts); `test:oracle` (12 scenarios, every log unchanged); faults 24/24.

**Not exercised.**

- A live source without checks. The owner's session re-ran both real-provider smokes at `82d4837` (this record on
  `1218e86`): `test:deepseek` passed (28,663 tokens, 11 steps) and `test:command-deepseek` passed (owner 83,667
  tokens, workers 46,946, 20 model responses; one implementation and its review accepted, no revision refusal; the
  three refused calls were the protocol's own: an output outside scope and the effort `low` at launch, and a reviewer's
  `swarm_submit` on its verification task, each repaired once). Both live sources declared `node check.cjs`, so no
  live model has yet been seen to publish a claim before it accepts a source without checks (CORE-01).
  `test:validation-repair-web` and `test:sidebar-service` did not run.
- The schema 8 upgrade ran on stores the tests rewrite into a schema 7 shape, never on a real home's store.
- Process births were read on macOS only (`ps`); the linux reading (`/proc`) did not run on this machine. A recycled
  PID is simulated with a fabricated birth (`recycledBirth()`), not by wrapping the PID space.

**Open after this batch** (not adopted here).

- The owner-session stranding race behind the compaction failure (above). The proposed fix is one shared helper that
  wakes the pending tail at the owner agent's next idle after the filter rejects or empties an opening, as members
  already recover (`continueAfterRejectedStep`); `ownerCall` in the compaction script should also wait for its own
  command's tool result rather than for `whenIdle` alone.
- The web smoke's teardown: the uncleared 10 s timer and the unbounded `browser.close()` (above).
- Timer-bound tests under load: `S1/R17-G5`, as the 2026-10-22 entry records, and `tests/r12-runtime-fixes.test.mjs`
  "recovery returns with a stuck startup, starts siblings, and records one shared timeout" (a 40 ms startup timer),
  which failed once in a slice's full-suite run and passes alone.
- Disputes. The owner has no way to dispute or re-open an accepted source that published no claim of its own
  (documented in known-limitations; the refusal points at proposing new work). The `swarm_challenge` description does
  not say which claims are refused, which would be a model-visible change. The board fingerprint's
  `challengedEvidence` still counts challenged rows of claims no verdict can judge, which only an older build writes.
  `graph.lineage`/`effective` can resolve a dependency through a cancelled repair while a blocked sibling repair
  carries the obligation; dependency resolution still reads it, while disputes and control read `carrier`. A rejected
  task with a pending stop would be told to propose a replacement, which propose refuses
  (`replacement_source_reassigning`); the state is unreachable today and has no branch of its own.
- Verification. `run()` still runs the full retry for an attempt fenced during its first pass, whose verdict can never
  commit. A rejection carries no basis; a basis on every verdict row needs a defined third kind. `WORKER_PROMPT` is at
  1590 of the 1600 characters `tests/roles.test.mjs` allows. `swarm_registry` still over-reports one refutation after
  a deferred, resumed and then otherwise blocked review (known-limitations).
- The apply lock. A scratch cleanup failure after a delivery completed still rejects the call, though the files were
  applied and the receipt written (the lock is now released, and a retry finds the receipt). Reclaiming a stale lock
  is check-then-rename, so two contenders can race, and the code comment overstates what the rename guarantees (now in
  known-limitations). The in-process `activeSources` refusal still names no lock or holder. The lock lives in the
  checkout's own git directory, so linked worktrees of one repository do not share it.
- Attempt silence. The delivery term has no lifetime bound, so after a clock step-back a delivery naming the task from
  an earlier attempt can raise the basis (it can delay an escalation, never invent one); bounding it needs a log
  position on delivery rows. An owner `swarm_observe` span naming a running task at `$.taskId` re-arms the clock, each
  tick loads the attempt's tool runs and deliveries in full, and an operation's end names no attempt. In
  `src/trace.ts`, the `task/checkpointed` branch of `orchestratorCommands` cannot run, since that event is not in
  `ATTEMPT_FENCING_EVENTS`.
- Writes after an await (CORE-06). `addMember` checks the `maxWorkers` budget before its awaits and does not re-check
  it after them, so an owner who lowers `maxWorkers` during workspace preparation can end up one worker over the new
  limit; that is an admission decision, not a stale-row write. `renewActiveOperation` caps renewed leases at the
  deadline the scheduling pass read when it started, so an owner's deadline extension during the pass gives a shorter
  lease until the next renewal; no stale row is written. Delivery, draft and start rows are outside `revise`: the
  outbox acknowledgement, consumption and follow-ups re-read delivery rows inside their commits, and any other
  asynchronous delivery writer still needs review (known-limitations).
- Batch B of the self-review (F3, T2, T1, F2) is not on this branch.

## Harness 0.2.1-rc.2 only: 0.1.5-rc.3 and 0.1.7-rc.1 dropped (2026-10-22)

**Head**: `af154be`, where the gates of the live-smoke repair round ran, and this record's revision (documentation
only), branch `dsh021/drop-01x` on `a28b116` (main), not merged. The owner dropped `0.1.5-rc.3` and `0.1.7-rc.1` on
2026-10-22, so `0.2.1-rc.2` is the only supported host. 41 commits (`15d00ec` to `ea487f0`), one review repair round
(`a80d012` to `d5c7f25`, no `src` change), this record (`fcf5b5e`, revised at `87025d6` for the final gates at
`fcf5b5e`), and the live-smoke repair round (`ffef623` to `af154be`, below).
`src` against `a28b116`: +617 −338, net +279. The drop (`15d00ec` to `22383d8`) is +131 −155, net −24; the W8 route
rule (`f3518a8` to `95e5772`) is +276 −127, net +149; the live-smoke repair round is +222 −68, net +154.

**Merged** as `9ddbdb5` (2026-10-23) on `a28b116`, after the smoke delivery rule (`a708ecd`) and both live smokes
passing there (`e2ba280`, below). Main had not moved, so the merged tree is `e2ba280`'s.

**What the drop deleted, and what stands in its place.** Each item existed only because 0.1.x was supported; the
2026-10-21 entry records most of them as bridges between hosts.

- **The supported set** (`15d00ec`, `99cd363`, `f219fc7`; repair `150caf1`). `compatibility.json` keeps one row,
  `0.2.1-rc.2`, and records the dropped releases with `a28b116` as the last revision that supports them. Every
  `@deepseek-ai/dsh-*` peer range, `SUPPORTED_HARNESS_RELEASES` and the profile's `requires.harness` name only
  `0.2.1-rc.2`, so a host with a peer-version gate (0.1.7-rc.1 and 0.2.x) installs and boots the plugin only on that
  release, unless its owner exempts this plugin version. No `engines.dsh` is declared: with one release it would name
  what the peer ranges name and change no verdict. The repair round drops `defaultHost`, which only ordered several
  releases: `scripts/harness-target.mjs` takes the one sibling `deepseek-harness-021rc2` with no ordering, and the
  lockstep test requires exactly one supported release and pins every `dsh-*` peer and dev dependency to it.
- **The command-input patch** (`80bcee5`). `patches/harness-command-input.patch` corrected dsh-external#637 in
  `claim-decor.ts` on 0.1.5-rc.3 and 0.1.7-rc.1; 0.2.1-rc.2 ships no such file (upstream replaced it with command
  chips). The patch, `patches/README.md`, `scripts/command-input-patch.mjs`, `scripts/check-harness-command-input.mjs`
  and `tests/command-input-patch.test.mjs` are deleted.
- **`update-preview`'s `compat/` guard** (`f0aa2a8`). It refused a preview whose rebuilt host packages came from
  another release, a layout only that patch produced. The rule in its place is wider: a plugin snapshot boots only on
  the release whose `@deepseek-ai/dsh-session` it links, checked before any build, sync or preflight; a snapshot that
  links none loads the host's own and is not checked.
- **The persona prompt variable** (`5423297`, `4383f44`). The worker persona section held only `{{swarm_persona}}`
  because 0.1.5-rc.3's `PromptSection` had no `interpolate` field. The worker now shadows the deployment persona
  prefix with its persona text under `interpolate: false`, naming the host's `PERSONA_PREFIX_SECTION` and
  `PERSONA_SUFFIX_SECTION` and taking their order from `getSectionOrder`. A `{{...}}` in a member name, role or
  mission objective still reaches the model as written.
- **Host shapes read in `src`** (`80efe2d`, `eea725e`, `9c457af`, `c04b26c`, `0c81145`, `a8823a8`). The owner filter
  accepts one runtime-context source, the agent loop's `runtime-context` (the v3-to-v4 session format renames 0.1.5's
  system-prompt `plugin` source on restore). `confinedCheckArgv` takes the host's `SandboxProvider.confine`, which
  returns a promise, and the local types for 0.1.5's synchronous confine go. `registerWebApi` injects `connection`
  alone. In the client a tool result fails by its tool-role message's `isError`, the transcript reads a message's
  content as flat host blocks without descending into nested `content`, and navigation finds the session on screen
  by its mainView retention and opens a worker through the workspace UI service's `openSession` (0.1.5's
  `list.current` and `sessions.open` go).
- **Test and smoke compositions** (`021db0c`, `2d3fa7f`, `0e81051`, `4c2baa2`, `21c2ede`, `a8cec16`). Gone: the
  `toolResultBlocks` normalizer, `tests/fixtures/host-packages.mjs` and its catalog-conditional rows, the
  `loaderPlugin()` export rule, the catalog checks behind `workingDirectoryRows()` and the API-key route, `smokeHost()`
  and the flags it returned, the command smoke's chip-or-text assertion, and the r17 vocabulary exception for
  `working-directory/change`. In their place: the worker tests import the host's tool packages statically; each host
  package is imported in the shape 0.2.1 publishes; both real Loader compositions mount `dsh-fs-local`,
  `dsh-working-directory` and `dsh-llm-deepseek-api-key` unconditionally, so a checkout without one fails by name;
  the web smokes always wait for the default workspace's composer, and the command smoke always asserts the command
  chip; the profile test reads `patchPaths` and the boot graph's combo reference. The working-directory service
  stays optional in the adapter, and a composition without it keeps a test of its own.
- **Comments and documents** (`1f60ebd`, `f17b1fd`, `71793f2`, `39ff9bc`, `e1eab40`, `89ec8c4`, `22383d8`,
  `a1493ee`, `7563520`, `e4658cc`, `49673ba`, `3c38b4e`, `ea487f0`). Code and test comments, both READMEs, both
  operations guides, `docs/design.md`, `docs/known-limitations.md` and the profile README describe one host.
  "Upgrade a Harness home to 0.2.x" becomes "Move a 0.1.x Harness home to 0.2.1-rc.2": the backup, why the move is
  one-way, and that a move back also needs a plugin revision up to `a28b116`.

**W8: one rule for a member's route** (`f3518a8`, `e5d6507`, `2df3fbe`, `caacbe7`, `dc7bd01`; documents `984c25a`,
`95e5772`, `17a3fc5`). The owner's live `test:command-deepseek` on 0.2.1-rc.2 (2026-10-22, before this branch)
failed when the host refused a worker's reasoning effort (`low` on `deepseek-v4-flash`) at its model steps, before
any worker request was made.

- At admission: a launch (`launchDraft`, behind `swarm_launch` and the browser launch) admits every member of its
  plan, and `swarm_add_member` one member, through the adapter's `memberRoutes`. It resolves the route the worker will
  run (`workerRoute`: the owner session's current selection under the member's own fields) and calls the host's
  `llm.prepareCall`, as a model step does, without dispatching it, so no provider request is made. One refusal names
  every refused member at its field before any mission, member row, worktree or session exists:
  `member_reasoning_effort_unsupported` with the efforts the route declares, `member_model_unsupported` for a model
  its provider refuses on this release (`MODEL_UNSUPPORTED`, `CLIENT_UPGRADE_REQUIRED`; the code, never the host's
  text), or `member_route_unavailable`. A draft save runs the same rule over the routes the draft names. The
  start-time downgrade and retry in `addMember` and the web API's own route validation are deleted;
  `member/effort-downgraded` and `member/effort-rejected` are historical and still decode.
- At a step: `UNSUPPORTED_REASONING_EFFORT` joins `MODEL_UNSUPPORTED` and `CLIENT_UPGRADE_REQUIRED` in the `member`
  class of `PROVIDER_FAILURE_CODES`, and the adapter reports such a failure as `routeRefused` alone, never also as the
  member's failure. The runtime retires the member at the first refusal (`member/route-refused`, new). Each attempt it
  holds is fenced and re-pended once its handle has stopped and its workspace is checkpointed, its recovery allowance
  intact; unpinned pending work assigned to it loses its assignee; pinned work waits for the owner; a member that holds
  no attempt has its handle stopped by the retirement. The owner gets one `[member_route_refused]` notice naming the
  work and the exits (`swarm_add_member`, and a `swarm_control` amend for pinned work). The regex reading of provider
  text in `onFailure` and `src/refusals.ts` is deleted.

**User-facing changes.**

- The plugin installs and runs only on Harness 0.2.1-rc.2. The 0.1.7-rc.1 plugin manager refuses it, and 0.1.5-rc.3
  loads it with a logged unsupported-host error. A home that ran on 0.2.1-rc.2 goes back to 0.1.x only from a backup,
  and with a plugin revision up to `a28b116`.
- Without `DSH_HARNESS_ROOT` or `DSH_SOURCE`, the scripts look only at `~/.dsh/source/current` and the sibling
  `deepseek-harness-021rc2`, and every entry point names `supported: 0.2.1-rc.2` when it refuses another release.
- A launch or `swarm_add_member` whose member route the running release cannot take is refused before anything is
  created, saying what the route accepts, instead of starting the member and failing its model steps. A route that
  changes after admission costs one charged step: its member is retired once, and its unpinned work goes to a capable
  live member.
- `update-preview` refuses a preview whose snapshot links another release's SDK, which includes the attended 5202 root
  on 0.1.7-rc.1; moving it means a new root from `start-preview` on 0.2.1-rc.2.

**Oracle logs re-recorded** (`f3518a8`, `e5d6507`). The 12 logs in `scripts/replay/oracle/` changed only in their
adapter trace lines: each member added on its own records one `memberRoutes` call before `prepareWorkspace` (92
calls across the 12 logs), and the `bind` line names the new `routeRefused` callback. Checked line by line for this
record: every event, row and delivery line is identical to `a28b116`'s, and with those two kinds of trace line set
aside, so is every adapter call. The `test:replay` digest is unchanged.

**Review repair round** (2026-10-23; no `src` change).

- `a80d012` (tests): two branches of the step refusal had no test, and deleting either kept the targeted suite and
  `test:harness` green. The step test adds a queued task assigned to the refused member: it loses its assignee at
  once, the notice names it, and another member claims it. A new test has a member claim work, fail one start (the
  work waits for her and, having run, cannot be borrowed) and then be refused while she holds no attempt: her handle
  is stopped once, the event and the notice are recorded once, and the work is released, named and claimed by another
  member. On the built lib, collecting only pinned pending work fails both tests (with the assignee assertion
  removed, the other member's claim is refused `task_not_ready`), and dropping the stop of a member with nothing
  fenced fails the new one.
- `150caf1` (`compatibility.json`, `scripts/harness-target.mjs`, tests, documents): `defaultHost` goes (above), with
  the default-search test's fake second release and the known-limitations clause about several listed releases.
- `d5c7f25` (documents): known-limitations said the real-provider smokes last ran on 0.1.x; it now records the
  2026-10-22 runs on 0.2.1-rc.2.
- The six full-suite failures of the gate run at `ea487f0` (below) were missed timer deadlines under load, not code
  defects, and changed nothing.

**Regressions.** The full suite has 1971 tests at `ea487f0` (1972 at `a28b116`); the repair round adds one, so
`fcf5b5e` has 1972. The live-smoke repair round adds 11, so `af154be` has 1983; its regressions are listed with it,
below.

- `tests/governance.test.mjs`: an effort the route does not accept is refused at `swarm_add_member` and on every
  launch path, before any effect, naming the accepted efforts; a model its provider refuses is refused at the member's
  model field; a step refusal retires the member once, fences and releases its work, keeps pinned work and tells the
  owner the exits; a member refused with no attempt is stopped by the retirement.
- `tests/harness-workers.test.mjs`: admission prepares each route through the real LLM service as a step does, so the
  route adapter's own refusal of a model decides it, before any request; a composition without the working-directory
  service writes no directory event.
- `tests/harness-effort-admission.mjs` (new, in `test:harness`): on the real Loader with a scripted model whose route
  declares `off` and `high`, `swarm_launch` and `swarm_add_member` are refused and then admitted on the repaired
  effort, which the provider receives; a step the route stops taking retires the member once, its task runs on the
  live member, and the owner's model reads the notice.
- `tests/web-api-sanitize.test.mjs`: a route the host refuses reaches the browser as the admission refusal, never as
  the adapter's text. `tests/harness-support.test.mjs`: `update-preview` boots a snapshot only on the release its SDK
  links. `tests/host-version.test.mjs`: exactly one supported release, named by every list that declares it.

**Gates**, each run with `node_modules` linked to a 0.2.1-rc.2 link farm and `DSH_HARNESS_ROOT` set to the clone it
links.

**The first gate run is invalidated.** It ran on 2026-10-22 at `ea487f0` against the shared clone
`deepseek-harness-021rc2`. Another system on this machine runs Harness from that clone's source, and at 17:58 the
clone's HEAD had been moved to the 0.2.0-rc.2 merge `639ed015`; its files were unchanged. The run's release-revision
assertions failed on that HEAD: re-run at 19:51, the full suite failed to load `tests/r17-profile.test.mjs` with
`Harness 0.2.1-rc.2 verification requires its declared release revision` (1964/1965). A pass against the same clone
that evening (19:52 to 20:00), which the first version of this record counted, is not counted either: its smokes read
`harnessHead` `687f282e`, but the clone's reflog records `639ed015` from 17:58 until 14:56 the next day, so what that
pass ran against cannot be established. The machine then slept from 21:39 until 14:48 on 2026-10-23, which
interrupted the batch. From 2026-10-23 on, `DSH_HARNESS_ROOT` and the link farm point at a dedicated clone of the same
build pinned at `dsh-v0.2.1-rc.2` (`687f282e86`), and both runs below used it.

| Check | `ea487f0` (2026-10-23 14:57) | `fcf5b5e` (2026-10-23 16:18) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `node --test tests/*.test.mjs` | 1965/1971 (672 s); re-runs 37/37 and 1971/1971 (470 s) | 1971/1972 (280 s); re-run 1972/1972 (317 s) |
| `npm run test:harness` | passed | passed |
| `npm run test:replay` | digest unchanged | digest unchanged |
| `npm run test:oracle` | 12/12 identical | 12/12 identical |
| `npm run test:pack` | passed (251 archive entries, 251 published files) | passed (251, 251) |
| `npm run test:profile` | passed | failed at the offline plugin add (below); with a pnpm that runs offline, passed |
| `npm run test:bundle` | 7/7 | 7/7 |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `npm run test:web` | passed, 13 checks | failed at the offline plugin add; with a pnpm that runs offline, passed, 13 checks |
| `npm run test:command-web` | passed, 11 checks | failed at the offline plugin add; with a pnpm that runs offline, passed, 11 checks |

The replay digest is `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e`, and each passing web
smoke's `report.json` records `harnessHead` `687f282e8625c6b8d11ff58211a90524be2e4317`. `test:harness` includes the new
`tests/harness-effort-admission.mjs` in both runs.

At `ea487f0` the full suite took 672 s on an overloaded machine: the gate run's `uptime` read load averages of 170 to
195 on 8 CPUs while macOS daemons caught up after the sleep. Six tests missed a short timer deadline: four waited past
the mission queue's bound and were rejected with `[mission_operation_pending]` (`S5 gate src/runtime.ts:6` in
`tests/in-memory-gates.test.mjs`, 50 ms, and three tests in `tests/review-path.test.mjs`, 300 ms), `R19-M-d` saw its
check exit 124 past its 500 ms deadline, and in `R14-F2(a)` the 25 ms scheduler tick started the task before the
test's own claim (`task_not_ready`). None of the four files changed in this batch. Re-run alone, the four files passed
37/37 in 22 s, and the whole suite then passed 1971/1971 in 470 s. The repair round re-ran the four files at its head,
37/37 in 24 s at a load average of about 15.

At `fcf5b5e` one test failed, at load averages of about 10 to 31: `S1/R17-G5: a worker turn the body woke inside an
adapter call keeps committing, ...` (`tests/scheduling-pass.test.mjs:859`) read `passLive: true` beside
`wedged: true`, where it expects `passLive: false`. The board reports a live pass beside a wedge only while the body
is not yet named and live work exists, and under load the test's probe can find a wedge event before the hung body is
named, for instance one from an earlier body that crossed its fake-clock bound while it awaited real asynchronous
work. The test, `src/scheduling.ts`, `src/board.ts` and `src/kernel.ts` are unchanged in this batch. The whole suite
re-run passed 1972/1972 in 317 s, and the test passes when run alone. Under 16 parallel copies for three rounds it
failed 31 of 48 runs at `fcf5b5e` and 32 of 48 at `a28b116`.

Also at `fcf5b5e`, `test:profile`, `test:web` and `test:command-web` failed within 3 s, before any check, at the
offline `dsh plugin add` that each runs with `COREPACK_ENABLE_NETWORK=0`. The Harness plugin manager runs the `pnpm`
on `PATH`, here the corepack 0.34.0 shim. Corepack's home had been created anew at 15:32, after the `ea487f0` smokes
passed, with no `lastKnownGood.json` and no copy of its default pnpm, so with the network disabled corepack stops with
`Network access disabled by the environment` before pnpm runs. `test:profile` failed the same way re-run alone, and
fails the same way at `a28b116`; no commit after `ea487f0` touches `package.json` or the smoke scripts. With a shim
first on `PATH` that runs the pinned clone's own pnpm 11.28.5 (its `packageManager`), all three passed. The machine's
corepack state was left as found.

The harness, pack and profile logs carry `[agent-swarm] Error: [mission_operation_pending]` lines, the notice those
compositions trigger on purpose, more often under load: 27, 31 and 15 at `ea487f0`, and 13, 8 and 8 at `fcf5b5e`.
`test:harness` runs during the slices printed 9 to 42.

**Repair-round checks** (the round changes no `src`, so the built lib is the one the gates ran):
`npm run typecheck` passed; `tests/governance.test.mjs` 10/10; `tests/harness-support.test.mjs`,
`tests/host-version.test.mjs`, `tests/host-scripts.test.mjs` and `tests/web-smoke-runner.test.mjs` 29/29.

Not exercised by these gate runs: `test:deepseek` and `test:command-deepseek`, which make real provider requests and
need the owner's key. Both changed in this batch: each reads a tool result as the host's tool-role message, and the
command smoke's text reader takes a flat block list. Before this branch, the owner ran them on 2026-10-22 at
`a28b116`: `test:deepseek` passed (30,319 tokens, 10 steps), and `test:command-deepseek` failed when the host refused
the worker effort `low` on `deepseek-v4-flash` at its model step, the effort W8 now refuses at admission. The owner's
session then ran both at `87025d6`; the live-smoke repair round below records what they found.
`test:validation-repair-web` did not run; it reuses the command smoke's claim path, which now always asserts the
command chip. `test:load` and `test:isolation` first ran on 0.2.1-rc.2 at `87025d6` (below). Better Sidebar and the
attended preview have not run on 0.2.1-rc.2; the attended 5202 preview still runs 0.1.7-rc.1 with a pinned plugin.

**Live-smoke repair round** (2026-10-23; `ffef623` to `af154be`, `src` +222 −68, net +154).

The owner's session ran both real-provider smokes at `87025d6` on `deepseek-official` / `deepseek-v4-flash` with
thinking disabled, so the owner's route declares one effort, `off`. `test:deepseek` passed: 25,523 tokens, 10 steps.
`test:command-deepseek` failed twice. The first run failed at the owner's step 3: the model streamed a tool call whose
input was not valid JSON (`MALFORMED_RESPONSE`, "DeepSeek Messages stream: tool input is invalid JSON"). This is a
provider flake that no plugin code reaches. The re-run exposed a launch-admission defect. The owner's first two
`swarm_launch` calls were refused with typed plan errors, which it repaired. Its third named the member efforts `low`
and `medium`, which the route does not declare. W8 promises a typed refusal there, naming the efforts the route
declares, which the owner repairs in one retry. Instead:

- the tool result was the literal text `Error: [object Object]`;
- no mission was created;
- the owner session recorded "cannot create effect on inactive context" (`INACTIVE_EFFECT`, thrown by the
  working-directory service's `ensure()` from a timer);
- the smoke failed with `Unknown mission` after 5 owner steps and 66,837 owner tokens.

The earlier run at `a28b116`, before W8, launched and failed later, at the worker's step, on the same effort.

**What happened.** The report's lifecycle shows the order, and `tests/harness-launch-refusal.mjs` replays it on the
real Loader. The W8 refusal was never reached: the smoke tore the host down before admission answered.

1. `ffef623`: `startPlan` linked the saved request to `mission_<draft>` when its launch began. That was before the
   workspace re-check, the check preflight and the W8 route rule. So while the third launch was being admitted, the
   request named a mission that did not exist. The smoke's poll followed the link, met `Unknown mission`, and tore the
   host down in the middle of the launch. The request is now linked in the commit that creates its mission (`create`,
   from `launchDraft`), so a launch refused before then links none. A host start drops a link that an earlier release
   left to a mission that was never created.
2. `9ddf955`: the teardown cancelled the launch with the session's cause, the plain object `{ kind: 'disposed' }`.
   Every `throwIfAborted()` below the tool threw it as it was, and the tool layer rethrew it. The Harness renders a
   value that is not an Error with `String()`, so the result read `Error: [object Object]`. Each call now runs under
   its own signal (`callSignal`), whose abort reason is a typed `[tool_cancelled]` refusal naming the cause. Every
   rejection leaves through `toolFailure`: an Error as itself, the session's cancellation cause as `[tool_cancelled]`,
   and any other value as a typed `[tool_failed]` refusal carrying its readable text (`thrownText`).
3. `4f1042f`: the planner's `watchIdle` then failed the start. Its recovery notice woke the owner after the Harness's
   teardown had observed the owner's quiescence and before it unwound the owner's scope. The new turn's system-prompt
   assembly met the unwound scope (`INACTIVE_EFFECT`). Admission never touched it. `wakeableAgent`
   (`src/harness-workers.ts`) is now the one gate of every waking owner delivery, the planner's notices and the
   mission outbox's. It requires a registered agent with a live scope whose last turn in this session object's
   lifecycle did not end on a disposed cancel. A notice it skips stays pending for the session's next agent.

**Review of the repair** (one medium finding, three low; `f55a1b1`, `e52fa91`, `af154be`). The medium finding: when a
launch failed, its durable records still turned the thrown value into text with `String()`. Those records are the
automatic request's error (`startPlan`'s catch in `src/runtime.ts`), the draft's error (`launchDraft`'s catch) and the
native command's own `failStart` reason (`src/planner.ts`). The earlier "one owner of failure text" fix (`9ddf955`)
covered tool results only (`toolFailure`). So a non-Error thrown out of the launch was stored as "[object Object]",
and the planner's recovery notice quoted that to the owner's model as "Recorded reason". The reviewer's effobj probe
hit this through a second gap (low #2): `resolvedRoute` in `src/model-selection.ts` looked up the model's declared
efforts outside its guarded path. A failed lookup therefore escaped admission as the raw host value, without the typed
`member_route_unavailable` verdict and without a log line.

- `f55a1b1`: `recordedFailure` (`src/policy-error.ts`) is how a failed launch's records carry a thrown value. An Error
  is recorded as its own `String()` rendering, byte for byte (`Error: <message>`), and any other value as `thrownText`.
  It stays total when an Error's `toString` throws. `startPlan`'s `request.error` and `launchDraft`'s `draft.error` use
  it. The native command's `failStart` reason uses `thrownText`, so an Error there still records its bare message.
- `e52fa91` (low #2): `routeAnswer` returns the host's answer for a route: accepted, or a refused effort with the
  efforts its model declares. It throws everything else, a failed declared-efforts lookup included. `resolvedRoute`
  reads every host failure by one rule: it logs the detail (`thrownText` for a non-Error) and returns a typed verdict
  (unavailable or model-refused). An aborted admission does not query the host again.
- `af154be` (lows #3 and #4): the command path's planning wake, after `prepareStart`, asks `wakeableAgent` instead of
  the bare registry. The scope guard in `wakeableAgent` (`agent.ctx.fiber.uid === null`) now has regressions.

On the real Loader, the reviewer's probe (a host whose declared-efforts lookup throws `{ kind: 'catalog-offline' }`)
recorded the start error `{"kind":"catalog-offline"}` after `f55a1b1`. After `e52fa91` the launch answers a typed
`[member_route_unavailable]`, the text the request records and the notice quotes.

**Regressions of the round.** Each fails without its fix: on `87025d6`, or with its site reverted in place and the
lib rebuilt (then restored).

- `tests/automatic.test.mjs` (`ffef623`): a refused launch leaves the request unlinked, and the launch that creates the
  mission links it; a restart drops a dangling link. Both fail on `87025d6`. The S5c gate in
  `tests/in-memory-gates.test.mjs` reads the failure event from the scope the request now names.
- `tests/tool-failure-text.test.mjs` (`9ddf955`, `f55a1b1`): an Error leaves as itself; the session's cancellation
  cause becomes `[tool_cancelled]`; any other value becomes `[tool_failed]` with its readable text; `recordedFailure`
  renders a PolicyError, a TypeError, an Error whose `toString` throws, non-Error values and a trapping proxy. It fails
  on `87025d6`.
- `tests/harness-launch-refusal.mjs` (`4f1042f`, new, in `test:harness`): on the real Loader, through the native
  `/agent-swarm` command, on a scripted route that declares only `off`. The undeclared efforts are refused with the
  typed W8 refusal naming `off`, with no mission, member, worker or mission link, and the owner's corrected relaunch in
  the same turn launches. `swarm_add_member` is refused alike. A non-Error throw answers `[tool_failed]`. A mission
  notice skips an owner its disposal cancelled and reaches its resumed agent. A launch cancelled by the owner's
  disposal answers `[tool_cancelled]`, opens no second turn and meets no inactive scope. Each scenario fails with its
  fix reverted (the start link, the failure text, the call signal, the planner gate, the outbox gate, the
  lifecycle-scoped read).
- `tests/planner.test.mjs` (`f55a1b1`, `af154be`): a non-Error thrown inside the assembly gives a readable start error,
  draft error and recovery-notice reason (fails with `startPlan` or `launchDraft` reverted to `String(error)`); one
  thrown by the command's snapshot gives a readable start error and notice reason (fails with the `failStart` reason
  reverted); an owner whose scope is unwound while its snapshot is prepared gets no planning message and no recovery
  notice, and the notice reaches it once its scope is live (fails with the command path's registry check restored).
- `tests/harness-workers.test.mjs` (`e52fa91`): an adapter whose second resolution of the model fails (a frozen object,
  then an Error carrying a host path) gives unavailable routes and logs both details. It fails on the previous
  `resolvedRoute`, where the frozen object escapes `memberRoutes`.
- `tests/rule-owner-channel.test.mjs` (`af154be`): a mission notice is held in the outbox for an owner whose scope is
  unwound (fiber uid `null`) and delivered once the scope is live. Removing the `fiber.uid === null` guard (the
  reviewer's mutation M8) now fails this test and the planner's unwound-scope test.

**Gates at `af154be`** (2026-10-23 18:38 to 18:47), with `node_modules` linked to the 0.2.1-rc.2 link farm and
`DSH_HARNESS_ROOT` set to the pinned clone. Every gate passed on its first run, so nothing was re-run. The 1-minute
load average read 7.0 to 27.0 on 8 CPUs.

| Check | `af154be` |
| --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed |
| `node --test tests/*.test.mjs` | 1983/1983 (298 s), 0 cancelled |
| `npm run test:harness` | passed, 4 compositions (including `tests/harness-launch-refusal.mjs`) |
| `npm run test:replay` | digest unchanged |
| `npm run test:oracle` | 12/12 identical |
| `npm run test:pack` | passed (251 archive entries, 251 published files) |
| `npm run test:profile` | passed |
| `npm run test:bundle` | 7/7 |
| `node scripts/faults/run.mjs` | 24/24 |
| `npm run test:web` | passed, 13 checks |
| `npm run test:command-web` | passed, 11 checks |
| `npm run test:isolation` | 6/6 |
| `npm run test:load` | D8 load envelope OK: N=16 and N=32, observation bounded (max 1039 B and 1042 B, ratio 1.00x) |

The replay digest is still `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e`, and both web
smokes' `report.json` record `harnessHead` `687f282e8625c6b8d11ff58211a90524be2e4317`. The harness, pack and profile
logs carry 14, 6 and 4 `[mission_operation_pending]` lines. The offline plugin add that failed at `fcf5b5e` passed here
and in the owner's run at `87025d6` with the corepack shim on `PATH`: corepack's home has recorded pnpm 11.7.0 in
`lastKnownGood.json` since 16:49. The owner's run at `87025d6` also passed `test:profile`, `test:isolation` (6/6),
`test:load`, `test:web` (13 checks) and `test:command-web` (11 checks).

The live smokes were not run at `af154be`; they need the owner's key. The owner's session re-ran both on
`deepseek-official` / `deepseek-v4-flash`:

- At `003cfd1`, `test:deepseek` passed (24,249 tokens, 9 steps). `test:command-deepseek` ran end to end: the owner's
  first `swarm_launch` was refused with the typed `[member_reasoning_effort_unsupported]` text naming the accepted
  effort `off`, the owner relaunched, one implementation and its independent verification were accepted, and the
  mission completed automatically. The smoke then failed only on its own stale assertion, from `becba81`, that an
  accepted `integration` task must exist; the owner protocol asks for an integration only over several
  implementation branches.
- `a708ecd` makes the smoke assert the delivery the runtime names: `verifiedDelivery` (`src/task-graph.ts`) takes the
  delivery from `selectAcceptedDelivery`, which completion and `deliveryTarget` use, and requires its accepted
  independent review of the delivered commit (`tests/verified-delivery.test.mjs`). Full suite 1986/1986.
- At `a708ecd`, both passed: `test:deepseek` (25,803 tokens, 10 steps) and `test:command-deepseek` (owner 53,794
  tokens, workers 33,028 tokens, 17 model responses; the owner's first launch was again refused for effort `low` and
  repaired in one relaunch). No report or log holds a credential.

**Open after this batch** (not adopted here).

- Several behavioral tests bound their waits by short timers (a 50 ms or 300 ms mission-queue bound, a 500 ms check
  deadline, a 25 ms scheduler tick that races an explicit claim), so a heavily overloaded host fails them, as the gate
  run at `ea487f0` did. Under stress `S1/R17-G5` fails about as often at `a28b116` as here (32 and 31 of 48 runs),
  mostly at its other assertion (the stranded drain woke one turn from inside the body: 30 and 26) and otherwise at
  the gate's wedge assertion (2 and 5). The known-limitations list of wall-clock tests names none of these.
- `test:profile`, `test:web` and `test:command-web` need a `pnpm` on `PATH` that installs offline; a corepack shim
  whose home lacks its default pnpm fails them before any check.
- Other durable records still render a thrown value with `String()` and can store "[object Object]" for a non-Error:
  the guard terminal's detail (`chainFailed`) and `preparationFailure`'s reason in `src/scheduling.ts`, `startWorker`'s
  "Worker could not start" reason, `member.startError` and the `member/resume-failed` and `member/failed` events in
  `src/runtime.ts`, and `src/check-results.ts`. Each needs its own regression, so the live-smoke repair left them.
- Two writers record an automatic request's reason in different forms: `startPlan` stores `Error: <message>`
  (`recordedFailure`) and the native command path the bare message (`thrownText`). Both were kept to move no recorded
  text; unifying them is a separate decision.
- The Harness gives no signal when an agent's disposal starts. `wakeableAgent` covers an idle owner disposed while its
  snapshot is prepared only once the owner's scope has been unwound.
- The items the 2026-10-21 entry left open stand: no downgrade guard, cold workers resumed by other host paths, the
  stranded-inbox drain, the API-key route's credential codes as member failures, and
  `scripts/check-cancel-freeze.mjs` importing `isJsonValue`, which 0.2.1-rc.2 does not export.

## Harness 0.2.1-rc.2: the default host, with 0.1.5-rc.3 and 0.1.7-rc.1 kept (2026-10-21)

**Head**: `7bcc4ae` and this record (documentation only), branch `dsh021/adapt` on `a57052b` (main), not merged; six
slices (A to F) and one review repair round. `src` against `a57052b`: +193 −48, net +145. By slice: A +1, B 0, C
+69, D +73, E 0, F 0, and the repair round +2 (comments). Every change holds on all three hosts, and no `src` line
branches on a host version: where hosts differ, the code or fixture composes what the host provides (its package
catalog, its services, its editor nodes).

**Merged** as `a8536af` (2026-10-21) on `a57052b`. Main had not moved, so the merged tree is this record's commit
`cd641b6` and the gates below hold for it unchanged.

**Where 0.2.1-rc.2 stood at `a57052b`.** A probe at main, with only `compatibility.json` admitting 0.2.1-rc.2:
typecheck, build, `test:replay`, `test:oracle` (12/12 identical) and the fault suite (24/24) passed. The full suite
ran 1843 tests with 15 failures, and six files failed to load (about 107 tests never ran). `test:harness` and
`test:pack` failed with `unknown tool "bash"`. `test:profile`, `test:bundle` and both web smokes failed because the
0.2.x plugin manager refused the install on the plugin's peer ranges.

**What each slice leaves at the head.**

- **A, the supported set** (`7116157`, `2a1d1db`, `b957e3a`). `compatibility.json` gains the 0.2.1-rc.2 row (tag
  `dsh-v0.2.1-rc.2`, `687f282e86`) and names it `defaultHost`. Its `channel` string becomes a `channels` list, since
  npm `latest` and `next` both name 0.2.1-rc.2; nothing reads it. Every `@deepseek-ai/dsh-*` peer range,
  `SUPPORTED_HARNESS_RELEASES` (`src/host-version.ts`) and the profile's `requires.harness` admit it, in the same
  order, so the 0.1.7 and 0.2.1 plugin managers accept `plugin add`. No `engines.dsh` is declared: the peer ranges
  already decide on 0.1.7 and 0.2.1, 0.1.5 only logs a mismatch, and a second list would need its own lockstep.
  `devDependencies` pin the default host's packages. Without `DSH_HARNESS_ROOT` or `DSH_SOURCE`,
  `scripts/harness-target.mjs` derives its sibling checkouts from `compatibility.json`, the default host's first
  (`deepseek-harness-021rc2`, then `015rc3` and `017rc1`), so adding a release needs no script edit.
- **B, the test compositions** (`362a165`, `3958f08`, `31b8323`, `c1c6f4c`, `5f4b923`, `e556e9a`; no `src` change).
  Six test files mount JSONL persistence through `loaderPlugin()` (`tests/fixtures/built-harness.mjs`), the Loader's
  own export rule: the default export where there is one (0.1.x), else the namespace (0.2.1, which publishes no
  default). The owner-notice fixture drops `dsh-invariants`, which 0.2.x deleted; it mounted no companion that
  registers a check, so it ran none on 0.1.x either. Both real Loader compositions (`bootHarness`,
  `bootFaultHarness`) add `workingDirectoryRows()`: `fs-local` rooted at the workspace and `dsh-working-directory`
  with the workspace as its default directory, each mounted only where the host's package catalog has the package
  (`fs-local` on every host, `dsh-working-directory` on 0.2.1, whose `tool-bash` injects it).
  `assertEveryEntryActive()`, shared by both, replaces a boot check that only asked whether an entry had a fiber:
  every enabled entry, group children included, must be active, and a pending one is named with the services it
  waits for. `bootHarness` mounts the DeepSeek API-key route from `dsh-llm-deepseek-api-key` where the catalog has
  it (0.2.1) and from `dsh-llm-deepseek` otherwise. `nativeClient()` in `tests/ui.test.mjs` keeps the identities the
  test shares with the clients it loads (react, react-dom, Cordis) and resolves the other host-shared modules, such
  as `zod`, from the native package's own directory.
- **C, worker confinement** (`8dacae6`, `f4a5aac`, `bfb73c3`). `UNCONFINED_HOST_TOOLS` (`src/types.ts`), beside
  `OWNER_ONLY_TOOLS`, lists `working_directory`, `create_worktree` and `schedule_create`, `schedule_update`,
  `schedule_list`, `schedule_delete`. `hiddenToolsFor('worker')` hides each one the host registers, and the runtime
  guard refuses every one by name with its own reason. Each worker activation re-anchors the session's working
  directory where it forces `sandbox/mode` and `approval/policy`: when the host provides the `workingDirectory`
  service and its `get()` reads anything but the member worktree, the adapter appends one
  `working-directory/change` naming the worktree, as the service's own `ensure()` records a session's first
  directory. It does not call the service's `set()`, which also queues an inbox notice that the stranded-inbox drain
  would wake as a model turn of its own. A worker already in its worktree, and a host without the service, get no
  write. The owner side needed no code: `/agent-swarm`, the swarm tools and browser drafts authorize from the
  session header's directory.
- **D, the runtime** (`5f6bfce`, `3b493cb`, `ccbfdc1`, `8670342`). (1) `PROVIDER_FAILURE_CODES`
  (`src/scheduler.ts`) is the one table a Harness failure code is read from; `classifyProviderOutage` reads it first,
  then the HTTP status, then wording. `ACCOUNT_QUOTA` is the quota class. `ACCOUNT_SIGN_IN_REQUIRED` and
  `ACCOUNT_TOKEN_INVALID` form a new `credential` outage class: one condition of the route, shared by every session
  on it, that ends when the owner signs in. `MODEL_UNSUPPORTED` and `CLIENT_UPGRADE_REQUIRED` stay member failures,
  since a member's route is fixed for its session and only a replacement runs the work. (2) The worker persona
  section holds only `{{swarm_persona}}`, and a scoped prompt variable supplies the persona. No supported host scans
  a substituted value again, and 0.1.5-rc.3's `PromptSection` has no `interpolate` field and its renderer no escape
  syntax, so the variable is the one form all three hosts read the same way. (3) The owner delivery filter rejects
  an opening step (`step === 1`) whose every claimed message went stale, and still empties a continuing step. The
  0.2.x Web presets (Standard, PTC, Cordis) mount `dsh-time-context`, whose prepended pre-step listener appended a
  reading to an emptied opening, so a stale-only owner wake cost a model call. The time context passes a rejection
  through, and the loop ends the turn before any step on every host. Two survey items were refuted by their own
  challenges and changed nothing: subagent-settled turns in `OwnerReplyGuard`, and agent shutdown ownership.
- **E, web smokes and host scripts** (`2e00a95`, `7f7b244`, `00ad4be`, `93745f9`, `e09d173`; no `src` change).
  `smokeHost()` composes from what the host ships. It disables `llm-deepseek` and, where shipped,
  `llm-deepseek-account`. It pins the first-use default workspace inside the run root where the workspace controller
  has `initializeDefault` (0.1.7, 0.2.1). It asserts the command chip where the editor ships `CommandChipNode`. The
  runner acknowledges the welcome notice through the notice, then waits for the first-use session's live composer
  before it opens the chooser menu; the command smoke polls the composer's `textContent`.
  `patches/harness-command-input.patch` declares its targets on a `Targets: 0.1.5-rc.3 0.1.7-rc.1` preamble line
  that `git apply` ignores, and `scripts/command-input-patch.mjs` is its one reader. The check script runs the
  regression on a targeted release, reports a release that ships no `claim-decor.ts` NOT AFFECTED (exit 0), and
  refuses an untargeted release that still ships it. `update-preview` refuses a root whose `compat/` packages were
  rebuilt from another release. `hostPatch(root)` in `scripts/host.mjs` is the one root overlay of the lab and the
  previews, with the `hmr` row disabled. `start-lab` no longer replaces `llm-deepseek`'s model list.
- **F, documentation** (`b963f39`, `9ea9f2f`, `b44811b`; docs only). The operations guide (EN and zh-CN) gains
  "Upgrade a Harness home to 0.2.x": what to back up, why the way back is closed, and what the plugin does after a
  move back. `docs/known-limitations.md` carries the evidence, and records the 0.2.x behaviour an operator meets: the
  cached prompt prefix on `toolUpdate` routes, the shared `AGENTS.md` in `$DSH_AGENTS_HOME`, Minimal-preset members
  that compact, dsh-external#624 and #632 (open, unchanged) and the 0.2.1 host's owner-only plugin routes. The
  remaining "both hosts" statements in both READMEs, both operations twins and known-limitations say every
  supported host.

**Review repair round** (`499bc7e` to `7bcc4ae`).

- `499bc7e` (tests): the two halves of the stale-input rejection, `step === 1` and every claimed message stale,
  were pinned by no test; rejecting at any step, or when any one message was stale, kept the suite green on
  0.2.1-rc.2. Two tests now pin them (below).
- `794fccd` (tests only): `tests/faults/loader.mjs` kept its own copies of `harnessCatalog`, `harnessEntry` and
  `importHarness`, each with its own catalog cache, so one fault composition read the checkout twice. It now takes
  them from `tests/fixtures/built-harness.mjs`, as do the fault provider and its fixture. F3A, F3B and F3C pass on
  all three hosts.
- `c23399e` (comments and a test name): "both supported" hosts or releases now reads "every supported", each claim
  checked against the 0.2.1-rc.2 source first. The telemetry note in `src/trace.ts` says 0.2.x adds only an
  optional `sourceEvent`, and the `agentPresets` note names `dsh-agent-preset-registry` for 0.2.x too.
- `7bcc4ae` (docs): the known-limitations bullet on what the gates did and did not exercise on 0.2.1-rc.2. The
  review listed the replay digest on 0.2.1 as unexercised; the first gate run's `test:replay` on 0.2.1-rc.2
  reproduced it, so the bullet records it as reproduced.

**User-facing changes.**

- `dsh plugin add` of the plugin succeeds on 0.2.1-rc.2. The unsupported-host refusal and log name all three
  releases, and the default checkout search tries `deepseek-harness-021rc2` first.
- On 0.2.x a worker neither sees nor can call `working_directory`, `create_worktree` or the `schedule_*` reminder
  tools, and every activation starts it in its member worktree, whatever its log recorded. On 0.1.x a profile that
  mounts `dsh-schedule` registers the reminder tools in each agent's own scope, where only the guard refuses them.
- On 0.2.x a mission and a draft bind to the directory the owner session started in; a later `cd` moves neither.
- The DeepSeek account route (0.2.x): a signed-out account or a refused token is a `credential` outage. The route is
  quiescent, no recovery credit is spent, no member is retired, and it ends when the owner signs in. `ACCOUNT_QUOTA`
  is a quota outage with or without a 402. A model the account catalog refuses on the running release is the
  member's counted failure. On every host a Harness code now decides before the HTTP status (`QUOTA` with a 429 is
  quota, not rate-limit).
- A member name, role or mission objective containing `{{...}}` reaches the model as written on every host. Before,
  a malformed group failed every request of that worker on every host, `{{cwd}}` failed on 0.2.1, and `{{cwd}}` and
  `{{model}}` were silently substituted on 0.1.x.
- An owner wake whose only input went stale makes no model call on any host (it made one under the 0.2.x Web
  presets). Its `turn/end` reads `blocked` instead of `completed`, and it marks no earlier pending delivery handled.
- The lab and preview hosts boot without HMR on every host, so a build mounts only through a restart. The lab
  offers the host's own DeepSeek model catalog (its override named a preview model that expired on 09-10 and left
  out `deepseek-flash`, the model every host's `agent-default-model` row names). `update-preview` will not boot a
  0.1.x-built `compat/` overlay on another release. The web smokes no longer create folders in the operator's
  `~/Documents`.
- Moving a Harness home to 0.2.x is one-way for its session logs; the operations guide says what to back up first.

**The full-log oracle at the head against `a57052b`** (`npm run test:oracle`, one run on each host at `7bcc4ae`,
and one on each at `b44811b`). On 0.1.5-rc.3, 0.1.7-rc.1 and 0.2.1-rc.2 alike, every event, row, delivery and
adapter call is identical to the 12 logs recorded at `a57052b`; no commit of the batch re-recorded a log
(`scripts/replay/oracle/` is unchanged). Slice C also ran it at its head on 0.1.5-rc.3, 12/12 identical. No log
could move: the scenarios drive the kernel through a scripted adapter, so the re-anchor, the persona variable and
the owner filter (`src/harness-workers.ts`) are off their path; no scenario calls a host tool the worker projection
now hides; and the `outage` scenario hands the runtime its outage already classified (`rate-limit`, 429) and fails
its starts with `EMFILE`, which neither the code table nor the status and wording rules name, before or after
`5f6bfce`. The probe at `a57052b` reproduced the same 12 logs on 0.2.1-rc.2, so the oracle told the hosts apart
neither before the batch nor after it; the host differences are covered by the Loader compositions, the fault
suite and the browser smokes.

**Regressions.** The full suite grows from 1950 tests at `a57052b` to 1972.

- A: `tests/host-version.test.mjs` builds the expected refusal and log messages from the supported list and pins
  `defaultHost` to a supported release. `tests/harness-support.test.mjs` builds the expected `harness-target`
  refusal from `compatibility.json`, and its default-search test builds a 0.2.1-rc.2 sibling beside a 0.1.5-rc.3
  one and expects it to win.
- B: `assertEveryEntryActive()` is the boot check of both real Loader compositions. On 0.2.1-rc.2 with the
  working-directory rows dropped, boot fails with `tool-bash: pending, waiting for workingDirectory`, where the old
  check passed and the failure surfaced later as `unknown tool "bash"`.
- C: `tests/harness-workers.test.mjs` composes a worker with the host's real tool packages, each mounted only where
  the installed host ships it (`tests/fixtures/host-packages.mjs`, new). The worker sees none of the unconfined
  tools, every call fails without reaching the service behind it, and its directory stays its worktree. A worker
  whose log recorded another directory starts its next activation in its worktree: one write, no queued input, and
  the model-visible directory context names the worktree; on a host without the service no activation writes the
  event. `tests/roles.test.mjs` requires the guard to refuse every tool the worker projection hides, and
  `tests/tool-output.test.mjs` pins the worker's hidden list as the management surface plus this list.
  `tests/r17-projection.test.mjs` accepts `working-directory/change` only on a host that does not ship the package
  owning it.
- D: `tests/provider-outage.test.mjs`: the table decides every code it names ahead of the status and wording; a
  start failure classified as an outage re-routes without spending credit, the credential codes included; a start
  the account catalog refuses for the member's model is the member's counted failure. `tests/harness-workers.test.mjs`:
  a worker turn failing with each account code is reported as the table's class or as the member's failure, and a
  worker persona reaches the model as written whatever braces its free text carries.
  `tests/harness-owner-notices.test.mjs` mounts the host's time context (shipped on all three hosts): an owner wake
  whose every message went stale opens no model call. Before `ccbfdc1` it made one request on 0.2.1-rc.2.
- E: `tests/web-smoke-runner.test.mjs` (the smoke composes the DeepSeek routes, first-use workspace and command
  claim by what the Harness ships), `tests/command-input-patch.test.mjs` (new: the patch targets only supported
  releases and corrects one file; a release without the file is not affected and one that still ships it untargeted
  is refused; a patch without a `Targets` line declares nothing), `tests/harness-support.test.mjs` (`update-preview`
  boots rebuilt host packages only on the release they were rebuilt from), `tests/host.test.mjs` (a root's host
  boots with its own swarm state and without HMR) and `tests/host-scripts.test.mjs` (the live lab's overlay
  disables HMR and leaves the host's model catalog alone).
- Repair round, `tests/harness-owner-notices.test.mjs`: a continuing owner step whose claimed input all went stale
  still hands the model its tool result, and the turn ends `completed`; an opening owner step runs genuine owner
  input claimed beside stale swarm input. In both, the stale text reaches no request and the delivery is not
  consumed. On 0.2.1-rc.2 each fails on its own built-lib mutant and on no other (reject at any step: expected 2
  requests, actual 1; reject when any message is stale: expected 1, actual 0); both pass on all three hosts.

**Gates at `7bcc4ae`** on each host in turn, with `node_modules` linked to that host's link farm (`nm-015rc3`,
`nm-017rc1`, `nm-021rc2`) and `DSH_HARNESS_ROOT` at its clone:

| Check | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) | 0.2.1-rc.2 (`687f282e86`) |
| --- | --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed | passed / passed |
| `node --test tests/*.test.mjs` | 1972/1972 (206 s) | 1972/1972 (204 s) | 1972/1972 (218 s) |
| `npm run test:harness` | passed | passed | passed |
| `npm run test:replay` | digest unchanged | digest unchanged | digest unchanged |
| `npm run test:oracle` | 12/12 identical | 12/12 identical | 12/12 identical |
| `npm run test:pack` | passed (251 archive entries, 251 published files) | passed (251, 251) | passed (251, 251) |
| `npm run test:profile` | passed | passed | passed |
| `npm run test:bundle` | 7/7 | 7/7 | 7/7 |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 | 24/24 |
| `npm run test:web` | passed, 13 checks | passed, 13 checks | passed, 13 checks |
| `npm run test:command-web` | passed, 11 checks | passed, 11 checks | passed, 11 checks |

The replay digest is `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` on every host. Each
web smoke's `report.json` records its host's `harnessHead`. No full-suite log holds a `not ok` line. The
`[agent-swarm] Error: [mission_operation_pending]` lines in the harness, pack and profile logs (4 to 9 a log) are
the notice those compositions trigger on purpose, as on main. The first gate run, at `b44811b` before the repair
round, passed the same gates on each host with 1970/1970. `scripts/check-harness-command-input.mjs` passes 5/5
against the patch on 0.1.5-rc.3 and 0.1.7-rc.1 and reports 0.2.1-rc.2 NOT AFFECTED.

Not exercised on 0.2.1-rc.2: a real-provider mission (`test:deepseek`, `test:command-deepseek`; only the API-key
route's boot was checked, without a request), `test:load`, Better Sidebar and the attended preview, which still
runs 0.1.7-rc.1. No scripted model declares `toolUpdate`, and the gate compositions write no job events, so the
in-history tool update and the 0.2.x production log shape are read from the host source and the browser smokes.

**Open after this batch** (not adopted here; each predates the batch or needs an owner decision).

- No downgrade guard: the plugin records no host release, so a session a 0.1.x host refuses after a move back is an
  ordinary start failure.
- A cold worker resumed by another host path (a sidebar reopen, the 0.2.x schedule service, a UI composer) runs
  without the worker guard, restriction or accounting; a worker whose worktree was cleaned up fails each request at
  prompt assembly on 0.2.x.
- The stranded-inbox drain treats any pending inbox item as input, so context a host plugin injects into a worker
  starts a model turn of its own.
- On the API-key route `AUTH`, `MISSING_CREDENTIAL` and `INVALID_CREDENTIAL` are still member failures.
- `scripts/check-cancel-freeze.mjs` imports `isJsonValue` from `@deepseek-ai/dsh-session`, which no supported host
  exports, so it stops before booting on every host.

## Kernel/Board W1 and F2: a finished attempt's recovery, one stop-owner rule (2026-10-19)

**Head**: `4e8e7f7` and this record (documentation only), branch `claude/lucid-germain-771544` on `9aa4a59`
(`batch16/kernel`), not merged. Two owner-approved slices in order: W1 (`d627c2f`), then F2 (`4e8e7f7`), which
re-lands the slice reverted in `4f54cf1` on W1's recovery. `src` against `9aa4a59`: +122 −52, net +70 (W1 +79 −16;
F2 +57 −50, part of it moving W1's `resumedFrom` write into F2's `endAttempt` branch).

**W1: a finished attempt is recovered from the capture its submission or verdict recorded.** The runtime names the
attempt (`finishedAttempt`, `src/task-graph.ts`): the round a rework archived last (a source's `rejections[].commit`,
a rejecting review's `rejections[].reviewArtifact`), or the verdict an owner resume re-opened a review from
(`Task.resumedFrom`, written by `controlTask` from the attempt it ends), whichever is at the later epoch. Both
preparation sites pass it to `WorkerAdapter.prepareTask` as a fifth argument. In `Workspaces.recoverTask` a task
record of that epoch is that attempt's: the replacement starts from the named capture, or from the record's base
when the verdict captured none, never from that attempt's worktree or a snapshot of it taken after it finished,
and that epoch's artifact ref is not published again. A record of a later epoch is an attempt that did not end in a
capture (a restart, a failed start, a fenced attempt), recovered as before. A record older than the named attempt
is refused as invalid recovery metadata. A member whose own worktree still holds the task continues in place.

**F2: one stop-owner rule.** `controlTask` fences only a structural change of running work, through
`fenceForStop`, into which `fenceRow` is inlined. A review blocked on its deferred or rejecting verdict holds a
finished attempt: a resume, or a structural amendment that resumes it, records `resumedFrom`, ends that attempt with
`endAttempt` and re-pends the review in the same transition. Every stop question `controlTask` asks is
`stopPending`, so a marker of an earlier epoch obliges nothing. The closer rule has one owner, option (b):
`fenceForStop` writes `attempt/fenced` exactly when it fenced an open attempt or carried a stop already owed. A
finished attempt's own event (`task/submitted`, `task/verification-deferred`, `task/rejected`, `task/accepted`)
closed it, and the replay decoder ignores a closer for an attempt that is not open. Option (a) would have put a
closer on the owner resume while a rework's `endAttempt` still wrote none, so the site, not the row, would decide
again.

**User-facing change.** An owner's resume or structural amendment of a deferred or rejecting review no longer stops
and checkpoints the reviewer's handle, which may by then be running other work, and re-pends the review at once. The
next reviewer starts from the review artifact that verdict captured (the source commit when it captured none), and a
reworked task given to another member starts from its rejected commit. Neither carries what the previous member
wrote after its verdict or submission; those writes stay in that member's worktree, and the epoch's artifact ref
keeps the commit the row records. An owner cancel, a review retirement or a challenge that ends a finished attempt,
or a row holding none, writes no `attempt/fenced`.

**The full-log oracle at the head against `9aa4a59`** (`npm run test:oracle`, each slice re-recorded with
`--runs 3 --write`, three identical runs; the head reproduces the logs). Measured by diffing each slice's logs with
the previous ones row by row, event indices stripped:

- W1 (`d627c2f`): each of the 58 `prepareTask` trace entries gains its fifth argument, `null` in every scenario
  (none reworks or resumes a review holding its verdict): F12 2, F13 2, F18 1, F19 31, F2 2, F21 1, F5 2, dangling 1,
  outage 1, paths 11, replay 4. No event, row or other adapter call changes.
- F2 (`4e8e7f7`): five `attempt/fenced` events go. F12 loses one (`owner-cancel` of a pending row, `attemptId` null)
  and dangling two (`owner-cancel`, `attemptId` null). F19 loses two: an `owner-cancel` of a pending row (`attemptId`
  null), and `prerequisite-challenged` of an accepted review's finished attempt (`attempt#2`). Each later event of
  those runtimes moves up one index. F19's `evidence/challenged` owner notice records that event's seq one lower:
  its delivery's `reason` reads `evidence#1 challenge 16`, not 17, and its `dedupKey` digest changes. paths keeps
  its one closer: that owner cancel carried the owed stop of a missing stop owner. replay, F2, F5, F13, F18, F21 and
  outage are identical.

No other difference exists.

**Regressions.** Each was run against a detached build of the commit before its slice.

- W1, `tests/finished-attempt-recovery.test.mjs` (new). On the real engine, a named finished attempt recovers from
  its capture: the previous worktree is not committed into, and its epoch's ref stays. A verdict that captured
  nothing recovers from the base, and a record older than the named attempt is refused. Two real-engine runtime
  cases cover a reworked source handed to another member and a rework-reopened review handed to another reviewer:
  each leaves the previous member's HEAD, its uncommitted later write and the recorded epoch's ref alone. A further
  case pins the unchanged branch: a record of a later epoch recovers by capturing its quiescent worktree. On
  `9aa4a59` five fail and that pin passes.
- W1, the d934886 test in `tests/artifact-policy.test.mjs`: the next reviewer of a reassigned deferred review now
  starts at the deferral's review artifact, without the file the first reviewer wrote after its verdict. It fails on
  `9aa4a59`, where the barrier's checkpoint carries that file. The artifact-ref invariant still holds.
- F2, `tests/stop-owner.test.mjs` (restored from F2 as landed, on W1). It covers the resume while the reviewer runs
  other work, the reassignment, the rejecting review, a marker of an earlier epoch on a resume and on a structural
  amendment, and the closer rule (a cancelled finished attempt and a cancelled pending row write no closer;
  cancelling running work fences it). Six fail on `d627c2f`; the pin that a structural amendment of running work
  still fences it passes on both. The d934886 test now also asserts that the first reviewer is not stopped and that
  the resume owes no stop; it fails on `d627c2f`. R1's two regressions in `tests/board-read-points.test.mjs` record
  the owed stop by a commit outside the mission queue, because no owner control lays one on a member holding no open
  attempt now. Their old fixture fails both cases on the head.

Gate at `4e8e7f7` on 0.1.5-rc.3 (`DSH_HARNESS_ROOT` at the 0.1.5-rc.3 checkout): `npm run typecheck`, `npm run build`,
the full `node --test tests/*.test.mjs` (1927/1927; 1920/1920 at `d627c2f`), `npm run test:harness`, `npm run
test:replay` (digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e`, unchanged),
`npm run test:oracle` (11 scenarios identical to the logs recorded above), `node scripts/faults/run.mjs` (24/24),
`npm run test:web` (13 checks) and `npm run test:command-web` (11 checks) passed. `test:harness` logs a varying
number of `mission_operation_pending` lines from its composition run, 5 to 20 a run on both `9aa4a59` and the head.
Not run: 0.1.7-rc.1.

**Merged** as `b1ea9aa` (2026-10-21) on `979b33a` (batch 17 and the validation backfill). Two conflicts kept both
sides: `src/task-graph.ts` holds batch 17's `turnEnded` beside W1's `finishedAttempt`, and `src/scheduling.ts`
imports both. The oracle's `prep` scenario, which batch 17 added, was re-recorded: its seven `prepareTask` trace
entries gain the fifth argument, `null`; the other eleven scenarios are identical.

Gates at `b1ea9aa` on 0.1.5-rc.3 and 0.1.7-rc.1: typecheck, build, full suite 1950/1950, `test:harness`,
`test:replay`, `test:oracle` 12/12 identical, pack, profile, bundle, faults 24/24, `smoke-web` 13/13,
`smoke-command-web` 11/11.

## Batch 17: decide-then-act S12, S13, S14, S15 (2026-10-20)

**Head**: this record on `b7f53a3`, branch `batch17/kernel` on `f8cee82`, not merged; written in the batch's first
integrator repair round. `src` against `f8cee82`: +1069 −928, net +141. By slice: S12 +66 (`30a1a60` to `7ba3207`),
S13 +1, S14 −29, S15 +89, and this round +14 (`3cee26a` +8, `7b332a7` +6).

**The full-log oracle at the head against `f8cee82`** (`npm run test:oracle`, three identical runs at the head).
Every event, row, delivery and adapter call is identical in the 11 scenarios recorded at `f8cee82`, at every slice
head and at this head. The 12th scenario, `prep` (`e80ac1f`: preparations that throw, re-pended with backoff up to
their limit and blocked with the owner told), was recorded on `f2e9dc8` before any S15 move, and its log is also
reproduced by an `f8cee82` build. No commit of the batch changed a log. The two behaviour changes, `6919778`'s and
`7b332a7`'s, are owner-approved and lie where no scenario reaches: no scenario reaches an obligation follow-up, and
F21 and paths deliver their wedged-pass namings while the body is still wedged.

**What each slice leaves at the head.**

- **S12, a notice is a value with one executor** (`30a1a60`, `6919778`, `3df1690`, `f2664c8`, and the repair
  `58a464e`, `7ba3207`). `Notice` is a value; `Notices.record(missionId, notice)` is its one executor (a held notice
  commits nothing, else one commit writes the row and then its event; only a guard terminal opts into the pump and
  the busy-writer queue), and `judge(view, { wedged })` yields what a board owes the owner and writes nothing.
  `6919778` (owner-approved): each family judged by the subjects it names has one rule, `Notices.outstanding`, that
  its delivery and its reminders both read, so a parked holder, a dispatch question, a wedged pass's naming and a
  fall-through are reminded exactly while they would be delivered. Regressions: `tests/notice-judge.test.mjs` and
  `tests/outstanding-subjects.test.mjs`. The repair kept a wedged pass's naming of the mission root outstanding
  while the mission was unfinished, on any later board; the owner decided otherwise, and this round applies it.
- **S13, one silence notice and one guard-terminal notice** (`48e12dd`, `7ee6c80`, `1a9d786`). An operation
  silence and an attempt silence are verdicts their predicates return, with the holder row they read, and
  `silenceNotice(task, silence)` is their one notice; `guardTerminalNotice(board, chain, context)` is the notice a
  guard chain ends with, a function of the board its site records. Refactor. Regressions: the builders in
  `tests/notice-judge.test.mjs`, and `tests/execution-ownership.test.mjs` pins that a queue keyed by no mission
  refuses its waiter and tells no mission.
- **S14, pass bookkeeping as verdicts** (`07dce11`, `832dbff`, `31ff2f6`, `7fbe56e`, `f2e9dc8`). A body's standing
  is one verdict over its board, `wedgeVerdict`; live work is one board predicate, `liveWork` (a stop in flight, or
  an open attempt whose lease has not lapsed); the naming is `wedgeNotice`. The publication of a committed
  transition is the pass guard's (`Scheduling.transition`, `publish`), so the notices stand on the kernel and the
  refusals alone. Refactor. Regression: `7fbe56e` pins that a body named and settled in one turn is published once,
  with the wedged branch its naming owes. **S14c did not apply**: its `closeVerdict(pass, board, noProgress,
  stallPasses)` judged the no-progress watchdog, which batch 11 deleted (`noProgress`, `stallPasses`,
  `boardCannotProgress`, `escalateSchedulingStall` and `stallNotice` are absent at `f8cee82`). The one decision a
  close still makes, whether it chains the next body, is `kick`'s one-line condition over the pass record
  (`stoppedBefore`) and the mission row (active, `budgetPause.quiesced`), its only reader.
- **S15, the dispatch sweep's verdicts** (`e80ac1f`, `c306db5`, `7888217`, `971f24f`). The sweep decides on the
  board of an active mission, `activeBoard(missionId)`, and no board is the abandon verdict; at a member's boundary
  and after its worker start it acts on `memberStep` and `afterStart`; a preparation that threw leaves the row
  `preparationFailure` returns, with the notice a block owes, committed in one transaction. Refactor, proven by the
  `prep` scenario and `tests/dispatch-verdicts.test.mjs`. **S15d did not apply**: sharing the fresh-row check
  between dispatch and claim had landed in batch 16 R1. `stillChosen(board, chosen)` is the one fresh-row rule;
  dispatch asks `stillDispatchable` (`stillChosen` while the member is `eligible`), and claim asks `stillChosen` and
  then `ready` on one board and keeps its coded `task_changed_during_preparation` refusal, as R1 decided.
  `tests/board-read-points.test.mjs` pins each of the four fresh-row clauses through both (`66febb2`).
- **F2 stays withdrawn** (the W1 follow-up). Nothing in this batch touches `Attempts.fenceRow` or `controlTask`'s own
  stop owner. W1, recovering a finished attempt from the capture its verdict or submission recorded (a
  `WorkerAdapter` change the owner decides), comes first; F2 then lands as one fence.
- **R20, one wording per condition, stays open** (stopped in S12; not attempted in this round). Stuck work is always
  named: the board's own namings (a stall root, the W3 stall, the dispatch question, the fall-through) are told
  whenever their own condition holds, whatever decision already names the same work. So the same stuck task can be
  named in two or more wordings (docs/known-limitations.md lists them). Binding R20 needs an openness bound to its
  own cause for each decision a naming could defer to. Most guard-chain requests and the other decisions that name a
  task are open by their subjects' state, and a closed-out failure and a revocation leave no durable cause to bind
  to. It also needs member-scoped requests narrowed to the work their cause holds, a deferral that speaks again once
  its cover closes (a covered row is held forever), and the namings of a chain of wedged bodies as one cover.

**Integrator repair round 1** (`3cee26a` to `b7f53a3`, and this record).

- `3cee26a` (refactor): the board carries the scheduling body queued or running for its mission (`Board.pass`),
  which the runtime reads into every board it builds. `SchedulingPass` moves beside `Board` in src/board.ts, and
  `pastBound`, `wedgeVerdict` and `passState(board)` are board predicates there, so a reader below the scheduling
  seam reads the wedge as data, with no closure. The oracle is identical; the 19 test files that name the moved
  symbols pass 309/309, and faults F13, F19 and F21 pass.
- `7b332a7` (fix, owner decision): a wedged pass's naming is outstanding while the mission publishes its pass as
  wedged (`passState(board).wedged`), for the mission root it named, which follows the wedge alone, and for the work
  it named that is unfinished at its epoch. `claimed`'s mission-root clause is deleted: only this family names the
  mission root. Delta against `f8cee82`: a queued naming is delivered only while a body is wedged (before, while any
  named task was unfinished at its epoch, a restart included); a delivered naming the owner has not read is
  withdrawn from the owner's inbox once no body is wedged; while a body is wedged it is reminded of each named task
  unfinished at its epoch and of the mission root (before, a task only while no live path advanced it, the root only
  on a blocked, paused, stalled or all-terminal board), and it is not reminded once none is. Regressions, each
  failing on a detached `f8cee82` build and at `3cee26a`: `tests/outstanding-subjects.test.mjs` (a task naming and
  a mission-root naming, reminded while wedged and not on a later healthy board),
  `tests/notice-ledger.test.mjs` (withheld once the body settled, delivered and reminded while a later body wedges
  on the same fact, ended when the work moves on) and `tests/harness-owner-notices.test.mjs` (real Harness
  composition: withdrawn unread from a busy owner's inbox when its body settles, and a later body on its fact told by
  the row's reminder). The oracle is identical.
- `a9bc975` (test): `liveWork`'s lease clause was pinned by no test. A board whose only running attempt's lease
  lapsed gives a body at its bound the verdict `{ wedged: true, liveWork: [], live: false }`, and the watchdog names
  it at its first bound (`tests/scheduling-pass.test.mjs`). The built-lib mutant that drops the clause fails it.
- `b7f53a3` (test): `afterStart`'s stop-owed clause was pinned by no test (its case passed through `eligible`). A
  member that owes a stop while it holds an open attempt whose turn ended is skipped, not closed out
  (`tests/dispatch-verdicts.test.mjs`). The built-lib mutant that drops the clause fails it.
- This record answers the missing batch-17 record, R20's statement here and in README.md and README.zh-CN.md, F2,
  S14c and S15d.

Open after this round: a row the outbox already delivered is not sent again. A wedged pass's naming the owner's
inbox withdrew unread when its body settled therefore reaches the owner again, when a later body wedges on the
same fact, only through its reminders (at most two, the first `obligationFollowupMs` after its delivery, at a tick
when a body is wedged). Re-sending a withdrawn row is a transport change the owner has not decided.

Gate at `b7f53a3` (docs-only commits follow). On 0.1.5-rc.3 these passed: `npm run typecheck`, `npm run build`,
`npm run test:oracle` (12 scenarios identical over three runs), `npm run test:harness` (with
`UPDATE_SMOKE_SNAPSHOT=1` the model-visible fixture does not drift), `npm run test:replay` (digest
`sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e`, unchanged), the fault suite (24/24),
`scripts/smoke-web.mjs` and `scripts/smoke-command-web.mjs` (each `passed: true`). Each touched test file passed
three rounds of two concurrent copies. On 0.1.7-rc.1 (a detached scratch worktree on its link farm, since removed):
typecheck, build, `test:harness`, and the eight touched or named test files 188/188.

## Batch 16: decide-then-act A1, R1, F2 (reverted), F3, V1, I1 (2026-10-19)

**Head**: `c7fed65` and this record (documentation only), branch `batch16/kernel` on `6d5da9d`, not merged; this entry
is written in the batch's first integrator repair round. `src` against `6d5da9d`: +351 −279, net +72. By slice: A1
+61 (`53cb1d3` to `f1a0530`), `089f45b` 0, R1 +23, F2 0 (reverted), F3 −7, V1 −1, I1 −4, and this round 0.

**The full-log oracle at the head against `6d5da9d`** (`npm run test:oracle`; each slice that changed a log
re-recorded it with `--write` after three identical runs). Measured by diffing each log at `6d5da9d` with the head's,
trace indices ignored. Every event is identical in all 11 scenarios. Rows, deliveries and the adapter trace differ by
exactly these deltas:

- A1 (`53cb1d3`, `91e08b4`): 1263 `drainStrandedInbox` adapter calls, one per board member that takes work and
  whose handle a decision may ask about, at the start of each dispatch sweep: replay 22, F2 9, F5 6, F12 6, F13 12,
  F18 150, F19 852, F21 8, paths 162, dangling 8, outage 28. `91e08b4` added F21's and paths' last one, the member a
  chained body's order leaves out. paths also loses 30 `isIdle` calls (292 to 262; 16 for `member#3`, 14 for
  `member#4`): 23 came from the member steps' interpretation and 7 from the absence net's. With the drain calls
  removed, every runtime's trace is its old trace minus those asks, in order.
- F3 (`e71289f`): F19's task#1 row has `attempt.pausedBy: budget-pause#1` in place of the row's `budgetResume`
  `{attemptId: attempt#1, pauseId: budget-pause#1}`.
- I1 (`e1c2767`): F13's task row and `attempt#2`'s assignment content hold `revision` 10, not 13 (lines 21 and 27),
  because each `onIdle` writes the row once.

R1, F2, V1 and this round's commits change no log. No oracle scenario makes a member owe a stop during a
preparation, resumes or amends a deferred review, or reports a check envelope.

**What each slice leaves at the head.**

- **A1, one point where a stranded inbox is woken.** `isIdle` is a question: the adapter answers that an idle handle
  holding input no driver will claim is startable, and wakes nothing. Draining is the adapter's own step,
  `WorkerAdapter.drainStrandedInbox`. The dispatch sweep runs it at one point: after the sweep's guard
  (`Scheduling.halted`), for each board member with `takesWork && asksHandle`, whatever order the body sweeps. A
  drain that throws ends that member's chain (`chainFailed`, the `attempt_lease` guard terminal), and that member is
  not stepped in that sweep (`135d183`). In the adapter, `strandedInboxDecision` decides one handle state (`busy`,
  `idle` or `stranded`) from `fenced(resident)`, the in-flight observations and the native agent. One `rewake` wakes
  the tail, so a multi-item stranded inbox reaches the model in the order it was queued (`db52e30`; the reorder is
  R15-A5's, older than A1). Every site that asks whether a handle is fenced now asks `fenced(resident)` (`9478e8e`,
  this round). Each member step decides on the board. The absence net builds the interpretation only when a
  follow-up is due, and finds a summary's open constituents once. `commit()`'s execution clock asks
  `view.startable`. Batch 15's two placeholders that waited for A1 (the member step building the interpretation,
  and `interpret`'s second builder) are deleted. Regressions: `tests/board-read-points.test.mjs`, with a draining
  fake. It covers the stranded member drained once and the parked one not, the preferred member drained before its
  borrower asks, a member whose turn ends stranded during the sweep, a paused mission woken nowhere (`4702f90`), a
  drain that throws (`832ba8d`, `135d183`) and a chained body (`91e08b4`). `tests/harness-workers.test.mjs` (the
  real adapter: two asks wake nothing, the drain step wakes, FIFO) and `tests/owner-decisions.test.mjs` (the
  handle-state rules, and a revoked assignment discarded before the re-wake). `tests/notice-ledger.test.mjs`
  performs each exit of the drain-throw terminal through the owner's tools (`ec50037`) and checks that a wake
  summary reminds only its open constituents (`f1a0530`).
- **R1, a choice decided again after the preparation.** After the preparation await, the dispatch sweep decides its
  choice again with the predicate that made it. `stillDispatchable(board, chosen, member)` is
  `stillChosen(board, chosen)` (the row's epoch, `assigneeId`, `plannedAssigneeId` and `assignmentMode` are
  unchanged) while the member is still `eligible`. The sweep asks it before the assignment and before it records a
  preparation failure. Claim asks `stillChosen` and then `ready` on one board. `stopOwed` stays an untyped `Error`.
  The typed `stop_owed` admission refusal of `04a3f7c` was reverted by `d8144e4`, since it put into the ledgered
  admission vocabulary a reason no admission decision makes. The owner-approved delta, against `6d5da9d`: when the
  member came to owe a stop during the preparation, the sweep records no `task/preparation-failed`, `task/blocked`
  or `mission/stalled`, sends no preparation-failed or stall-root notice, does not move the epoch and records no
  `preparationFailure`. The task stays pending and dispatches after the stop. Regressions, all in
  `tests/board-read-points.test.mjs`. The stop barrier held open: the work stays pending and the owner is told
  nothing while the stop is owed (`ced9aff`). A preparation that throws after the stop became owed records no
  failure (`c4b22be`). Each of the four fresh-row clauses is pinned through dispatch and claim (`66febb2`, a gap
  older than `6d5da9d`). Not changed: the barrier's release publishes a dispatch question before the pass it kicks is
  open. That ordering also gives the replay, F2, F13 and F19 logs their question, so changing it is an owner-facing
  change of its own.
- **F2, reverted** (`89e294c` to `6a09912`, reverted by `4f54cf1`; `src`, tests and docs are as at `66febb2`). The
  rule F2 wanted is that the handle holding a row's open attempt owes the stop, and an attempt that ended in a
  submission or a verdict owes none. That rule needs a recovery F2's brief did not name. Without the stop and the
  checkpoint, the next member's preparation captured the first reviewer's live worktree and re-published the
  deferral epoch's artifact ref at a new commit. `d934886` pins that this ref keeps the commit the verdict recorded.
  It fails on the F2 build and passes at `6d5da9d` and here. The follow-up, W1, recovers a finished attempt from the
  capture its verdict or submission recorded, so the runtime names the recovery source to `prepareTask`. That is a
  `WorkerAdapter` change, and the owner decides it. F2 then lands as one fence. Until then `Attempts.fenceRow` and
  `controlTask`'s own stop owner stay as they are.
- **F3, an attempt's markers are fields of the attempt.** `pausedBy`, `idleSignal`, `closeout`, `leaseWarned` and
  `gitWriteDenied` live on `Attempt`. Whatever ends the attempt takes them, and a submission or a verdict keeps them
  with the attempt it keeps as its record. The budget resume continues the open attempts whose `pausedBy` names its
  pause. Opening a store before schema 7 rewrites each row that carries a marker once, inside the opening
  transaction, and writes no row that carries none (owner-approved durable change). Regressions:
  `tests/attempt-fence.test.mjs`, where each fence takes every marker and the schema 7 upgrade runs over a v6 and a v5
  store, its restored snapshot and a reopen. This round adds the budget resume's two clauses (`349ac77`): a
  submission's or a deferred verdict's kept attempt carrying the pause's id is not resumed, and a running attempt with
  no `pausedBy` or another pause's is neither redelivered nor recorded. It also adds a store whose rows carry no
  marker, which the upgrade does not write (`c7fed65`). Built-lib mutants that drop either clause, or the upgrade's
  skip of an unmarked row, each fail exactly the test written for it.
- **V1, one comparison basis** (`9aa4a59`, owner-approved). A verdict compares only the envelope delivered with its
  attempt; an attempt delivered none has nothing to compare, whatever the adapter reports at verify time.
  Regression: `tests/check-envelope.test.mjs`. A review delivered no envelope, verified while the adapter reports
  one, is accepted and records only that report; it fails on `6d5da9d` with `check_environment_mismatch`. R22
  (`tests/rule-workspace-recovery.test.mjs`) installs its envelope before the review is claimed.
- **I1, one record of a turn end** (`e1c2767`, `30754b4`, `1ce5025`; owner decision (b)). `onIdle` records the turn
  end once, as `attempt.idleSignal`, in the commit that clears the member's activity. `turnEnded` is a predicate over
  the row. A turn end whose commit the writer refused records nothing, so it is not nudged and its lease expiry frees
  the attempt. The attempt reporting bound names it first only when that bound passes before the lease and the member
  row records no operation. Regressions: `tests/worker-closeout.test.mjs` covers the default bounds (nothing names
  it before the lease expiry), a reporting bound shorter than the lease (it names it), and the operation end refused
  too (nothing names it). Each fails on `6d5da9d`, whose in-memory signal nudged the attempt.

**Integrator repair round 1** (`9478e8e` to `c7fed65`, and this record).

- `9478e8e` (refactor): seven sites in `HarnessWorkers` spelled the fence's three clauses inline. They are
  `currentActivity`, the tool guard, the pre-step's two rejects, the idle callback, `compactAtBoundary` and
  `compactIfRequested`, and each now asks `fenced(resident)`. The sites that first throw the abort's own reason and
  then refuse a closing adapter or a stopping resident keep their two clauses. The oracle is unchanged, the 17 test
  files that name the adapter pass 296/296, and `npm run test:harness` (which runs the real boundary compaction)
  passes.
- `349ac77`, `c7fed65` (tests): F3's two findings, described above. No `src` change.
- This record answers R1's finding and the missing batch-16 record.

Gate at `c7fed65` (`src` as at `9478e8e`). On 0.1.5-rc.3 these passed: `npm run typecheck`, `npm run build`,
`npm run test:oracle` (11 scenarios identical over three runs), `npm run test:harness` (with
`UPDATE_SMOKE_SNAPSHOT=1` the model-visible fixture does not drift), `npm run test:replay` (digest
`sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e`, unchanged),
`node scripts/faults/run.mjs` (24/24) and both web smokes (`passed: true`). On 0.1.7-rc.1, in a detached worktree on
that host's link farm, these passed: typecheck, build, `test:harness`, and harness-workers, owner-decisions,
activity, operation-bound, r12-native-start-fixes and attempt-fence (107/107). `tests/attempt-fence.test.mjs` passed
17/17 in three rounds of two concurrent copies.

## Batch 15: decide-then-act X1, X2, X3, F1, S7, S8, S9, S11, the full-log oracle record (2026-10-17)

**Head**: `9234211` and this record (documentation only), branch `batch15/kernel` on `b462a61`, not merged; this
entry is written in the batch's first integrator repair round and extended in its second. `src` against `b462a61`:
+1068 −934, net +134 (the first round: +9 for comments, +9 for S7, −17 for the idle close-out; net +1; the second
round changes no `src`).

**The full-log oracle at the head against `b462a61`** (`npm run test:oracle`, its logs recorded at `b462a61` before
any `src` move; the head reproduces them identically over three runs). F5, F12, F18, F21 and outage are identical. The
other six scenarios differ by exactly the deltas of three owner-approved behaviour slices, measured by diffing each
log at `b462a61` with the head's, row by row and field by field:

- X1 (`2f0da10`): the fall-through also names withdrawing the stuck work with `swarm_cancel(taskId, reason)`. Six
  `fallthrough:` owner deliveries change their `content` and no other field, five in F19 and one in dangling.
- F1 (`cf054c6`, `3a4b84b`): one `attempt/fenced` event lands immediately before each fenced closer, seven in all:
  replay 1 (`lease-expired`), F2 1 (`lease-expired`), F13 1 (`closeout-abandoned`) and F19 4 (`lease-expired` twice,
  `task-ceiling` twice); every later event index moves by the events inserted before it. A row an attempt was
  fenced from no longer keeps that attempt's `leaseWarned` (replay, F2 and F19 twice), and neither does what renders
  the row next: the following assignment's task (replay, F2, F19) and, in replay, the output of the `swarm_submit`
  tool span (1341 to 1313 bytes). F19's budget-resume marker loses `epoch` (`3a4b84b`).
- S11 (`161a6c5`, `634640f`): paths loses 15 `isIdle` trace entries (307 to 292), 10 from the dispatch sweep's member
  order and 5 from the integration-gap warning the second proposal opens, both now board reads. Each part was
  measured on a scratch mutant of the head that builds the interpretation there again: 302 with the member order,
  297 with the warning. Every event, row, delivery and other adapter call is identical and in order. `161a6c5` had
  also removed the 23 entries of each member step's interpretation; `634640f` put them back
  (`tests/board-read-points.test.mjs`, the drain case), and the step says why until A1.

No other difference exists, so X2, X3, S7, S8, S9 and this round's two fixes add none: the oracle's adapters report
no check envelope, and no scenario resumes a running task or meets a busy writer at `onIdle`.

**Integrator repair round 1** (`5e43f3d` to `7782a37`).

- `5e43f3d`: the dispatch member step states why it builds the interpretation (its asks precede the member's
  eligibility asks, and an ask can drain a stranded inbox), and `interpret`'s docs name it as the one builder
  outside the classifiers until A1.
- `345bcf2`: both readers of the in-flight estimate are pinned with a quarter-token average (401 over 4, 40001 over
  4), so a round-to-nearest mutant of `inFlightEstimate` fails each, as a round-down one does.
- `12d90c4`: a verdict reads the adapter's environment report once, through the best-effort `envelope()`;
  `recordEnvelope` records it and hands its environment to `reproduce`. A report that throws no longer rejects
  `swarm_verify`. Stopped for the owner: deleting `reproduce`'s fallback, so that an attempt delivered no envelope
  has nothing to compare; R22 (`tests/rule-workspace-recovery.test.mjs`) pins that fallback.
- `7782a37`: the idle close-out has one question, `Attempts.turnEnded`, which the attempt reporting bound asks too
  (`closeOutOwns` and its nudge half are deleted), and an owner resume restarts only the nudge count, keeping the
  turn end on the row. Before it, after an owner resume or a busy writer at `onIdle`, the next pass nudged an
  attempt that the tick had just named to the owner as silent.

Gate at `7782a37`: on 0.1.5-rc.3 `npm run typecheck`, `npm run build`, `npm run test:harness`, `npm run test:replay`
(digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e`, unchanged),
`node scripts/faults/run.mjs` (24/24) and both web smokes (`passed: true`) passed. On 0.1.7-rc.1, in a detached
worktree on that host's link farm, typecheck, build, `test:harness` and the five touched test files with
`tests/board-read-points.test.mjs` (99/99) passed. The behavioral suite was not run whole: at their own steps the 49
files that name the close-out, the silence bound or `controlTask` ran 809/809, and the 20 that name the check
envelope 223/223. Each touched test file passed three rounds of two concurrent copies, and each regression test of
the two fixes fails on a `b462a61` build.

**Integrator repair round 2** (`9234211`).

- `9234211` (tests only): the `owner_reply_missing` nudge's two printed `swarm_message` calls hold the call-exit
  contract against the published schemas, and each is performed as printed through the owner's registered tools,
  the answer on one question and the dismiss on another: the answer reaches the member that asked, both questions
  are settled, and the next owner turn nudges neither. A mutant whose nudge names the delivery's `to` as the asker
  fails only this test; it passes on `b462a61`, since `d287f79` was a refactor. `assertNamedCalls` drops a bare
  value such as `true` as it drops a quoted one, so a call that passes `dismiss: true` can be checked.
- Stopped for the owner: the idle close-out's turn end has three records: the row's `idleSignal`, written outside
  any transaction and again inside `onIdle`'s commit, and `Attempts.idleSignals`, which alone holds a turn end whose
  row write the writer refused. The right model records it once, inside the commit, and `turnEnded` reads only the
  row; a refused write then records no turn end, so no nudge comes, the attempt reporting bound names the attempt
  and the lease expiry frees it, as for any refused commit. Measured on a scratch mutant of `9234211` (−12 `src`
  lines), the oracle differs only at F13 lines 21 and 27: the task row and attempt 2's assignment content hold
  `revision` 10, not 13, because each `onIdle` writes the row once. Deleting only the out-of-transaction write gives
  the same F13 log. Of the 19 test files that name the close-out, its signal or the reporting bound, 382 of 387
  tests pass; the 5 that fail are `worker-closeout`'s two busy-writer cases, which pin the map, and the three that
  name it: `in-memory-gates`' census entry `src/attempts.ts:1` and its probe, and `scheduling-pass`' S5 clear. That
  entry's `cache-only` label, and the map's doc in `src/attempts.ts`, are false while a refused write is the map's
  alone, and the change deletes both.

Gate at `9234211` (`src` and the environment as at `7782a37`): on 0.1.5-rc.3 `npm run typecheck`, `npm run build`,
`npm run test:oracle` (11 scenarios identical to the recorded logs), `npm run test:harness`, `npm run test:replay`
(digest unchanged), `node scripts/faults/run.mjs` (24/24) and both web smokes (`passed: true`) passed. The 20 files
that import `tests/refusal-inventory.mjs` passed 407/407, and `tests/owner-reply.test.mjs` passed 15/15 in three
rounds of two concurrent copies.

## Batch 14: decide-then-act T1, S10, S16, S5, S6 (2026-10-16)

Merged as `b462a61`. T1 (owner-approved) leaves the task graph one plain read form: an id is refused where it enters,
and an id a stored row holds that names no task is stuck work the board names within one tick (before, the decision
sweep failed every tick and no notice was told); the oracle gained the `dangling` scenario. S10 deleted the unreachable
owner notice-ledger API; S16 found dispatch's second start-success bookkeeping already gone (batch 11) and pinned the
outage window (the oracle gained the `outage` scenario); S5 and S6 put Notices and Attempts on the kernel and the board.
The integrator rounds gave task edges one function (`taskEdges`), the open attempt one rule and type guard
(`openAttempt`, `HeldTask`, `holdsAttempt`) and an assignment's currency one predicate. src +27.

Gates on 0.1.5-rc.3 and 0.1.7-rc.1: typecheck, build, full suite 1813/1813, `test:harness`, `test:replay`,
`test:oracle` 11/11 identical, pack, profile, bundle, faults 24/24, `smoke-web` 13/13, `smoke-command-web` 11/11.

## Batch 13: decide-then-act S1-S4, a kernel and one read-only board (2026-10-16)

Merged as `b592356`. S1 recorded a full-log oracle (`npm run test:oracle`: every event, store row, delivery and adapter
call of nine fake-clock scenarios, ids and clock fields normalized) and an F(S) golden before any move, moved the pure
task helpers into leaves and broke the value-import cycle (`tests/import-cycles.test.mjs`). S2 gave the runtime a
`Kernel` interface and put the refusal registry below the notices. S3 and S4 made the scheduling, review and task-graph
decisions functions of one read-only `Board` (bounds read from the live config, the adapter called through and never
memoized) and replaced `MissionInterpretation` with `interpret(board)`. The integrator rounds gave the outbox pump one
model (a pending start that same-span requests join, which judges an in-flight sweep against its bound) and one
renderer of an overdue stop. From this batch on line count is no longer a goal (owner, 2026-10-15). src +77.

Gates on 0.1.5-rc.3 and 0.1.7-rc.1: typecheck, build, full suite 1795/1795, `test:harness`, `test:replay`,
`test:oracle` 9/9 identical, pack, profile, bundle, faults 24/24, `smoke-web` 13/13, `smoke-command-web` 11/11.

## Live mission on the 5202 preview after batches 10-12 (2026-10-15)

Preview host 0.1.7-rc.1, plugin `68515a4` (batches 10, 11 and 12 merged), 12:07-12:21 CST, driven through the owner
session's composer with the 2026-09-26 textstats goal (two modules with tests, an integration with `src/index.js` and a
README section, `package.json` unchanged).

- **Store upgrade on real rows.** The preview's store opened at schema 4: the five deliverables of the 2026-09-26
  mission now cite their criteria in `covers`.
- **Acceptance by id.** The planner wrote seven criteria `c1`..`c7`; the wordcount implementation covers `[c1, c2]`,
  topwords `[c3, c4]`, the integration `[c5, c6, c7]`; no review carries `covers`; the launch met no refusal.
- **Incident.** The planner gave every member `reasoningEffort: "medium"`, which route `deepseek-official` /
  `deepseek-flash` rejects, so every worker step failed (`member/failure` x21) and both implementation tasks exhausted
  close-out and recovery. The owner, woken by guard requests, a stall root and the W3 stall, added four replacement
  members with no explicit effort, resumed the tasks and re-pointed one review. The field exists since `becba81` (not a
  regression of batches 10-12); admission refusing an effort the route rejects is a follow-up task.
- **Outcome.** Mission completed; three deliverables and three reviews accepted (one review cancelled); final artifact
  `8579177`: `npm test` 21/21, `package.json` unchanged.
- **Usage (workers).** 160,446 uncached input + 2,620,800 cache read + 93,743 output = 2,874,989 tokens, 73 requests.
- **Owner rows.** 28: member/failure 7, guard-terminal 5, wake-budget summaries 7, dispatch-question 1, stall-root 1,
  board-stall 1, fall-through 2, review-blocked 1, escalation 1, integration-gap 1, automatic/completed 1.

`scripts/smoke-deepseek.mjs` on the same day: 0.1.5-rc.3 passed (33,389 tokens, 12 steps), 0.1.7-rc.1 passed (36,232
tokens, 12 steps; one model call passed a parameter `swarm_verify` does not declare and retried correctly).

## Round-30 simplification batch 11: one notice ledger (2026-10-14)

**Head**: `5209de7` and this record (documentation only), branch `batch11/ledger` on `29a0268`, 124 commits.
`src` net against `29a0268`: −683 lines (+752/−1435). Every design step shrinks it; the integrator rounds and their
repairs shrink it by 100 (B1 and its repairs are withdrawn, net 0; the final round is −21, the closing round −29 and
its second round −21).

**One record that the owner was told** (review M-1; design step 7, with the owner's amendment of the no-silent-state
spec §2, §4 and §6 and of the F19 contract). Wrong model: beside the deliveries ledger row, "told" was a mission-row
stamp keyed by the board digest F(S) (`Mission.witness`, `stallNotice`, `coverageNotice`, `schedulingStallNotice`,
`schedulingWedgeNotice`, `isolationRefusal`, `budgetWarned`), written whatever the ledger decided, and the witness
stamp gated the board classifier, so any family's notice on one digest consumed every other family's fact on it, and
a stop bound, lease end or review grace that expired on an unchanged digest stayed silent. Right model: the row is the
only record; `ensureWitness` runs every family at every pass end and every publication outside a live pass, each
family checks its own key on the ledger before it commits, and a key is `<family>:<scope>:<opener>` with no board
digest, wall clock or in-memory counter in it. Pause is the owner's own `mission/pause` event. Deleted: the seven
mission fields, the dead `Task.budgetWarned`, the witness gate with its back-off bypass and re-stamp, every stamp and
clear, and `ownerNotified` on the stall events, which now carry the `noticeKey` of the row they exist with.

**One family field, one emitter per condition** (L-21). The family is the key prefix, which is also `noticeFamily`,
the reviewed template and the recorded statement (`10697eb`), so the W3 stall (`board-stall:`) and coverage-complete
(`coverage-complete:`) are withheld once the mission completes and reminded only while their own condition holds.
`judgeBoard` is the one emitter of the W3 stall and of an owner-assembled mission's coverage-complete; completion
only completes (`b36bd09`), the no-progress watchdog and `stallPasses` are deleted (`253fbd0`), the isolation
terminal is the one emitter of an isolation refusal, a cancellation's stranded dependent is named by the board
classifier (`f6b9c34`) whether or not dispatchable work stands beside it (`c259487`), and an unreviewable submission
holds the board only while the review admission's own rule would still admit its review (`b2d4157`, which deleted
`d451784`'s board-wide gates; `9e0847e`), whose refusal of the host's review is a blocker it derives (`55b1209`).

**The design at the head, step by step.** An item's `src` net counts its own commits and every later repair of it, so
the items sum to the branch total.

| Item | Commits (own; later repairs) | `src` net |
| --- | --- | --- |
| Step 1: the family is one field | `10697eb` | −7 |
| Step 2: the W3 stall and coverage-complete own their dedup | `12e3aae` | −2 |
| Step 3: one emitter for "the board cannot progress" | `253fbd0`, `ae67c0a`, `fe569a2` | −139 |
| Batch-10 hand-off: one review-need grace | `f76dc6a` | −18 |
| Group 1's repairs of the board facts and the review admission | `cfb88e6`, `074967e`, `24bf1dd`, `25d04a9`, `c8e2cfd`, `437f12e`, `6fb394b`, `07beb95` | −11 |
| Step 4: the wedge naming on the ledger | `d515e4d`; `a3db6b3`, `9425d95`, `77ed057`, `8dd4f58` | −45 |
| Step 5: guard terminals and isolation keyed by opener | `af09ce7`; `d1e3ed3`, `6d9accf`, `6a54562`, `f3acf6d`, `6d9c50b`, `ebc4c90`, `fe9a167`, `35fac1f`; B1 and its repairs (`cf45ce0`, `bec0cc6`, `8fe10ea`, `6a8c269`, `a5ac07b`, `bda03ec`, `1af4a8d`) with their withdrawal `2fab0f1`, net 0 | −43 |
| Step 6: budget warnings from the ledger | `43ff5cf` | −5 |
| Step 7: the whole-board witness deleted, one emitter of the board's fact | `6f87081`, `b36bd09`, `76b799b`, `d451784`, `3288c1d`, `0f90f3e`, `21545cc`, `5ce7354`, `f6b9c34`, `082a175`, `8d23caa`, `d08eed5`, `b4a16ee`, `ebccfd5`, `2b11313`; `757b889`, `e5ce2e0` | −208 |
| Step 8: every notice names its fact | `afce859`; `f1a14f5`, `a785c3c`, `aeb4d7d`, `864f030`, `a44f044`, `2a63505`, `b9e89e4`, `e07d9e4` | −31 |
| Step 9: one identity domain | `201dd3d`; `8201147`, `604c0ac`, `0853d29` | −101 |
| Step 10: comments and documentation | `4b2604b` | −2 |
| Final integrator round: D1's gates, the dispatch question's isolation skip and an unreachable cover term deleted | `b2d4157`, `ec2a892`, `59fcb19` | −21 |
| Closing integrator round: the dispatch question's returns, the admission's record as its rule, a hand-built identity | `c259487`, `9e0847e`, `b982c30` | −29 |
| Closing round 2: the refused admission derived, the row-3 return and the hand-built identities deleted | `55b1209`, `1cbb3f7`, `5209de7` (`e6d28d9` is a test) | −21 |

**Step 4 at the head.** A wedged pass's naming is one ledger row per naming fact, under the key shape older builds
wrote: the mission's unfinished work at its epochs and each member's counted start failures
(`scheduling-pass:<mission>:<subjects>:<sha16 of "pass-timeout" and member:failures>`; `d515e4d`, `8dd4f58`). A body
whose fact the owner already holds is named by that row: it is marked named and writes no row and no event. Relevance
is per subject, not per body (`a3db6b3`, `77ed057`): the naming is outstanding while any task it named is still
unfinished at the epoch it named, whether or not a body is still wedged, so an owner inside a long step reads it after
the body settles and one still queued at a restart is delivered; its reminders name the still-unfinished work no live
path advances. Naming a body is a publication whether or not the naming wrote a row (`9425d95`): the dispatch question
the wedged pass never reached and the board facts committed inside the body's bound are told at that bound, also on a
held naming. Both depart from the design's step 4, whose `openWedge` held the naming only while a body was wedged and
whose publication followed only a new naming.

**Step 5 at the head.** A guard terminal is one request per chain and the fact that opened it, declared at its call
site (a limit, a budget pause, a task at its epoch, an attempt, an isolation violation's text, and for a failing
dispatch factKey's rule over the member, its unfinished work and the failure; `af09ce7`, `f3acf6d`, `6d9c50b`), never
the board digest, so distinct failures of one chain are distinct requests. The isolation request is one per violation,
names the unfinished work of every member it lists and is outstanding while the invariant lists it (critique change 2).
A request a busy writer refused is recorded by its cause and chain (`ebc4c90`), and every request is told through
`Notices.tell` (`fe9a167`). A proposal refused at an admission limit is one `[task_ceiling_terminal]` request per
limit, open while that limit is the mission's current one (B2, `b9e89e4`, `e07d9e4`); a workspace revocation's request
names the work the fence blocked; any start that leaves a member's session running, an adopted one included, ends its
counted start failures (`35fac1f`). The final rule (`2fab0f1`, `e5ce2e0`, `b2d4157`, `ec2a892`, `c259487`): every
board-level naming (the W3 stall, a stall root, the dispatch question, the fall-through) is told while its own condition
holds, the dispatch question beside the others, and a decision's openness governs only its own delivery and reminders. The same stuck task can therefore be named twice in
different wordings: a failed dispatch or an isolation request beside the dispatch question (critique change 3), a start
failure or retirement beside the dispatch question and the W3 stall or fall-through, a workspace revocation beside a
stall root and the W3 stall, a ceiling or recovery request beside the stall root, a review-blocked decision beside the
W3 stall (beside running work, the fall-through), and a second W3 stall after a withdrawn review. R20 (one wording per
condition) is an open item: it needs each decision's openness bound to its cause, which the decide-then-act Notices
slice (S12) owns. One older rule removes a wording: a rejected stall root that strands nothing beyond its rejecting
review is recorded against the rejection decision at the same subject@epoch (`coveredBy`).

**Step 6 at the head.** A budget warning is told once per allocation and threshold, from the ledger alone (`43ff5cf`;
pinned for a task's allocation by `ec9c491`).

**Every notice names its fact** (design step 8, `afce859`). Wrong model: notify defaulted a fact's trigger to its
class, so a preparation failure, a deferred verification, a challenge, a temp-path rendezvous, a provider outage, a
member failure and a start failure below the bound shared `decision:<mission>:<subjects>:none`, and a worker's refused
proposal `budget:<mission>:mission:<mission>:none`: failure 2 after failure 1, a second outage class, a second
challenge, another temp path, a new refusal reason or a raised limit was dropped. Right model: `NotifyOptions`
requires a trigger or an explicit key at the type level; each site passes its event and the reason that opens its
fact, and a start failure and a challenge are opened by their own event (`SwarmStore.event` returns the event's
sequence); a provider outage is its class on the member's open work (repair round 1 below). notify always
deduplicates; an escalation never is. Deleted: the
`dedupe` option, the class fallback, and the relevance branch that read the class-named trigger `decision` as an
older build's missing-review notice (such a row is now an unclassified legacy fact, deliverable like any other)
(`tests/notice-openers.test.mjs`, the second path in `tests/temp-rendezvous.test.mjs`, the legacy row in
`tests/rule-owner-channel.test.mjs`). A refused proposal is now one `[task_ceiling_terminal]` request per admission
limit, whoever proposed it (B2, `b9e89e4`, integrator round below).

**One identity domain** (design step 9, `201dd3d`). Wrong model: an escalation's dedupKey was the 64-hex arena digest
of the board with the notice channel excluded (`noticeFingerprint`), a key that identified nothing since escalations
are never deduplicated, exposed again as `ownerInstruments.noticeDedupKey`; its full variant was computed into an
arena-view field nothing showed. Right model: an escalation is told under `escalation:<id>`; F(S) is the one board
digest, an owner instrument and audit field. Deleted: `noticeFingerprint`, `arenaLedgerDigest` and its digest,
`Notices.noticeKey`, `SwarmRuntime.noticeKey`, the `fingerprintRecords` pair and `noticeDedupKey`.

**Behaviour after an upgrade** is recorded in [known-limitations.md](known-limitations.md) ("Change and return",
"Upgrade from a build before batch 11"): a condition that returns with the same opener is carried by its row's
relevance and remaining reminders, not announced again; conditions whose key changed are announced once more.

**Recorded open** (known-limitations). R20 above, with each co-fire it lists; in a start-failure storm the dispatch
question spends a slot of the owner's wake window, so a later fact can ride the window's summary. In an all-routes-fail
storm the retirement notice rides it: the summary names the task and points to `swarm_observe(deliveryId)`, which
returns the fact in full with its `swarm_add_member` exit. An isolation
violation whose text recurs after a repair is the same decision. `tests/client-event-projection.test.mjs`'s restart
test asserts that the revocation's request names the fenced work and that its stall root and the W3 stall name it too,
on the real overview. The dispatch double bookkeeping that predates this batch was 29a0268's `scheduling.ts:278`: the
start-failure delete and `clearProviderOutage` after every resolved `startWorker`, including a resident member's no-op
start. `2a63505` deleted it on this branch (only a start that opens a member's session clears its outage), and
`35fac1f` makes every start that leaves the session running, an adoption included, end the counted start failures. The
owner-held spec (`docs/no-silent-state-spec.md`, untracked) still describes W2 and W3 by the board digest; the amended
§2, §3 rows and §4 for the ledger model and the final rule are returned with the final round for the integrator to
apply.

**Group 4's checks before its repair rounds** (gate at `4b2604b`, 68 commits):

| Check at `4b2604b` | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` unchanged | passed, digest unchanged |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `npm run test:web` / `npm run test:command-web` | passed, 13 checks / passed, 10 checks | not run |
| Test files steps 8 to 10 touched (12), three rounds of two concurrent copies | 72/72 runs passed | 20 files touched or reading the changed docs: 256/256 |

**Repair round 1 of steps 8 to 10** (`f1a14f5` to `fa7c58b`). `src` net against `29a0268` is now −579 lines
(+629/−1208); the round is −26.
- `f1a14f5` (fix). Step 8 opened a provider outage notice by the event of each class transition, read from
  `Member.providerOutage`. A scheduling pass clears that record whenever it restarts a resident member, so four
  same-class reports on one preserved attempt, with a pass between each, woke the owner four times. The outage is now
  its class on the member's open work, and the ledger alone decides, so the class over the member's next task is told
  too. The transition gate is deleted (`tests/notice-openers.test.mjs` fails on `29a0268`, on `e30eba6` and with the
  gate restored). A pass that restarts a resident member still records the route as recovered and resets outage
  pacing. That predates this batch (`scheduling.ts:278` at `29a0268`) and is recorded open in known-limitations.
- `8201147` (refactor). The arena's `pendingReadiness` and `ArenaView.pendingDispatchable` had no production reader
  after step 9 and were a weaker second readiness rule: they skipped preparation back-off, stop owners, capability and
  borrowing. They are deleted. Their pins now ask the dispatcher's eligibility through `fingerprintBoard` or
  `eligible`.
- `fa7c58b` (test). The worker's refused-proposal request has each exit it names performed through the registered
  tools.
- A worker's refused proposal and the owner's refused admission at the same limit are two differently worded
  requests. Both existed at `29a0268`. Folding them into one request per limit would end the wake per proposer that
  the design names, so it is recorded in known-limitations as an owner decision.

| Check at `fa7c58b` | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest unchanged | passed, digest unchanged |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `scripts/smoke-web.mjs` / `scripts/smoke-command-web.mjs` | passed, 13 checks / passed, 10 checks | passed / passed |
| Test files the round touched (6), three rounds of two concurrent copies | 36/36 runs passed | the 7 touched or outage files, once: 64/64 tests |

**Repair round 2 of steps 8 to 10** (`a785c3c` to `f3d4b2c`). `src` net against `29a0268` is now −584 lines
(+637/−1221); the round is −5.
- `a785c3c` (fix). The adapter reported a classified provider error twice, through `providerOutage` and through
  `failure`, and since step 8 the member-failure notice is keyed by the error text. Retries whose text differed by a
  request id therefore woke the owner once per report with "<member> failed": five reports wrote one outage row and
  five failure rows. Each cause now has one emitter: a classified error is reported as the outage alone, as the start
  path already did, and `WorkerCallbacks.providerOutage` is required (`tests/harness-workers.test.mjs`, through the
  real adapter, fails on `29a0268` and on `bb15d25`).
- `aeb4d7d` (fix). `f1a14f5` kept an early return inside the 30-second window that bounds the outage event, so the
  same class over new work inside that window was not told. Repair round 1's statement that the ledger alone decides
  was false; its test advanced past the window. The window now paces only the `provider/outage` event
  (`tests/notice-openers.test.mjs` reports the new work 1 s later; fails on `29a0268` and with the return restored).
- `864f030` (refactor). `enqueueOwnerNotice` loses its `dedupe` flag. notify and tell each read the ledger before they
  write, and an escalation is written unguarded.
- `fb98484` (test). A task-budget refusal and an experiment-budget refusal of one proposer at one limit value are two
  requests. Before this, no test told the reason apart. The test fails on `29a0268` and on a key without the reason.
- `f3d4b2c` (test). `tests/client-event-projection.test.mjs` fails from `6f87081`, which is on this branch; the
  failure is not pre-existing. It is the designed change. With the witness gone, the W3 stall is told for its own
  fact beside the stall root and the workspace terminal on the blocked task. F19 row 7 and the ceiling-bound case in
  `tests/liveness-create-path.test.mjs` already had that shape at `29a0268`, where the board changed in between. The
  compact overview's three newest events are therefore those facts, and the assertion now renders the overview as of
  the revocation.
- Left open as an owner decision: a worker's refused proposal keeps the budget chain's wording, and the owner's own
  refusal at the same limit is a separate request. Both gaps are removed by one `task_ceiling` request per limit for
  every proposer, but that ends the wake per proposer that the design names (known-limitations).

| Check at `f3d4b2c` | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest unchanged | passed, digest unchanged |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `scripts/smoke-web.mjs` / `scripts/smoke-command-web.mjs` | passed, 13 checks / passed, 10 checks | passed, 13 checks / passed, 10 checks |
| Test files the round touched (3), three rounds of two concurrent copies | 18/18 runs passed | the 3 touched files and 3 outage or refusal files, once: 100/100 tests |

**Repair round 3 of steps 8 to 10** (`a44f044` to `b6527ec`). `src` net against `29a0268` is now −583 lines
(+667/−1250); the round is +1.
- `a44f044` (fix). Step 8 keyed a member failure by its message. The provider's text can carry per-request data (a
  context-length error names the tokens each turn requested) and such an error is no classified outage, so one
  unchanged condition woke the owner once per report. The fact is now the member on its open work, like the outage:
  the text is the body, and the member id tells two members apart while neither holds work, which `29a0268`'s generic
  key collapsed (`tests/notice-openers.test.mjs` fails on `29a0268` and with the message key). `src` net 0.
- `2a63505` (fix). Every successful start cleared the member's provider outage, and the dispatch sweep cleared it
  again. A pass that finds a worker running adopts its session and opens nothing, so an outage reported during a turn
  was cleared after each pass: `provider/recovered` per pass, a new `provider/outage` event per report, and no
  quiescence for probes or reroutes. Round 1 had recorded that in known-limitations instead of fixing it.
  `WorkerAdapter.start` now resolves true for an adoption, only an opening start clears, and the sweep's second clear
  is deleted (`tests/notice-openers.test.mjs`, three reports with passes between: one outage event and no recovery,
  3 and 3 on `29a0268`; `tests/harness-workers.test.mjs` through the real adapter, which resolves `undefined` on
  `29a0268`). `src` net +1: the adapter's return value and its declared contract, against the deleted clear.
- `604c0ac` (fix). `enqueueOwnerNotice` kept a fact-less branch only escalations reached, with the class fallbacks
  step 8 had deleted elsewhere, and returned a delivery no caller read. Over the wake budget an escalation's summary
  constituent had no subjects and its `deliveryId` named no delivery (as on `29a0268`). The escalation now names its
  fact (`escalation/raised`), the fact is a required parameter, and the escalation records the delivery that carries
  it, its own row or the summary (`tests/notice-openers.test.mjs` fails on `29a0268`). `src` net 0. The arena's
  escalations list still reads escalations off their own rows (known-limitations).
- `b6527ec` (test). Round 2 rendered the revocation's overview from a snapshot cut at the revocation. The test now reads
  the real snapshot once the fenced board is judged: the overview's three newest events are the workspace terminal,
  the stall root and the W3 stall, and the revocation is read in the panel's progress and the zh table. Making the
  terminal the one emitter for the work it blocks would contradict F19 row 7c, which keeps a ceiling-blocked root
  beside its terminal, so it is left to the owner; known-limitations and both READMEs state the three wordings.

| Check at `b6527ec` | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest unchanged | passed, digest unchanged |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `scripts/smoke-web.mjs` / `scripts/smoke-command-web.mjs` | passed, 13 checks / passed, 10 checks | passed, 13 checks / passed, 10 checks |
| Test files the round touched (3), three rounds of two concurrent copies | 18/18 runs passed | the 3 touched files and 3 outage, start or escalation files, once: 61/61 tests |

**Integrator round** (`6d9c50b` to `b9e89e4`, and this record). `src` net against `29a0268` is now −648 lines
(+737/−1385); the round is −65: part A −12, part B −53.
- Part A (`6d9c50b` to `3e4049c`). A failed dispatch's request is opened by factKey's rule over subjects its caller
  computes once (`6d9c50b`, 0). A request a busy writer could not write is named by its cause and chain and names no row
  (`ebc4c90`, 0). A guard terminal is told through `Notices.tell` (`fe9a167`, −10). The dispatchable set is one
  function, owned by `Scheduling` (`757b889`, −2). An escalation's typed record is part of its fact, so a summary that
  carries it keeps it (`0853d29`, 0). Two pins follow: a task's budget warning (`ec9c491`) and a coverage-complete board
  that writes no stall event (`3e4049c`).
- B1 (`cf45ce0`, fix, −35; withdrawn with its repairs, see the integrator decision below): one condition is one owner
  decision: a board naming deferred to an open decision naming the same work. It deletes the start-failure clause, the covered-row machinery (`NotifyOptions.coveredBy`, arena's `covered` and
  `awaitsDelivery`, `REJECTION_DECISION_TRIGGER`, `rejectionDecisionFor`) and the documented co-fire gaps. F19 row 7c
  stands: the ceiling request names the root at its epoch, but the root also strands a dependent that no open decision
  names, so the root is told and names that dependent. Row 7e is new: a stall root that the isolation request names is
  that request's while the request is open, and it is told once the worktrees are repaired and the task is still
  blocked. Regressions, each failing on `3e4049c` and on `29a0268`: a start failure over work bound to its member with
  no dispatch question beside it; the failed dispatch with no dispatch question; the isolation request resolved while
  its root stays blocked; one revocation wakes the owner once; the retired routes' stranded work is named by the start
  and retirement notices alone; a rejected root and a permanent preparation failure's root write no stall-root row or
  event; F19 row 7e (on `29a0268` F19 already fails at row 7, under the ledger model step 7 adopted). Repair round 2
  below stopped the failed dispatch and the released retirement work, whose pins it restored.
- B2 (`b9e89e4`, fix, −18): a proposal refused at an admission limit is one `[task_ceiling_terminal]` request per
  limit, whoever proposed it. The owner decided this, ending the wake per proposer. `refuseProposal` emits the
  task-ceiling terminal for every proposer, and for a worker it adds the `task/proposal-refused` event and the thrown
  error. The request names the mission root, not the proposer: `memberId` would make its subjects the first refused
  worker's unrelated work. Deleted: the proposer's budget-class notify, its key family and its budget-chain wording,
  and `propose`'s second terminal call. The exits are performed through the registered tools (`swarm_budget` raises
  `maxTasks`, then the retried `swarm_propose` is admitted). The regressions fail on `3e4049c` and on `29a0268`.
- B3 (this record): the head, step by step, with per-item `src` accounting.

| Check at `b9e89e4` | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` unchanged | passed, digest unchanged |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `scripts/smoke-web.mjs` / `scripts/smoke-command-web.mjs` | passed, 13 checks / passed, 10 checks | not run |
| Test files part B touched (9), three rounds of two concurrent copies at `b9e89e4` | 54/54 runs passed | the 9 files, once: 155/155 tests |

**Integrator repair round 2** (`e07d9e4` to `80caf99`, and this record). `src` net against `29a0268` is now −629 lines
(+757/−1386); the round is +19 (B2 is now −14, B1 −20).
- `e07d9e4` (fix, +4). B2's one request per admission limit had no end: `openGuardTerminal` did not know it, so it
  stayed open until the mission ended, and the owner who raised the limit with `swarm_budget`, the request's own exit,
  was still reminded twice (before B2 a worker's refusal was a budget-class notice that a budget review ended). The
  request is now a decision only while the limit in its key is the mission's current one; a lower limit can never
  return to it (`swarm_budget` refuses a limit below the admitted work). `tests/notice-openers.test.mjs` fails on
  `72a3d6f` and on `29a0268`.
- `bec0cc6` (fix, +12). B1 deferred a board naming to any open decision-class row outside a deny-list
  (`NAMING_FAMILIES`), open by `ownerDeliveryRelevant`, which for most families ends only with the mission or the
  epoch. A start failure the member recovered from, one member failure, an escalation or a failed dispatch therefore
  held pending work for good at its epoch: a dependent a cancellation later stranded got no W3 stall or fall-through,
  and work bound to a member that had started again behind a busy handle was never asked about; an older build's W3
  row also counted as a decision. cf45ce0 had recorded this as a known limitation. Now one positive rule
  (`decisionCause`) states each deferring decision's cause, read on the task it names: a guard terminal, a rejection or
  a permanent preparation failure holds a task while it stays blocked at that epoch; a start failure or retirement
  holds pending work bound to a member whose counted start failures stand. The cause is read where the deferral is
  judged, not in `ownerDeliveryRelevant`, whose delivery and reminder rules are unchanged. Deleted: the deny-list and
  the known-limitations residual. Stopped (contract item 4): the failed dispatch over pending work and unpinned work a
  retirement released have no cause a row shows ending, so the dispatch question and the board's naming are told
  beside them again; L-25's pre-B1 pin is restored and R5-02 pins the W3 stall once. Their right model is a durable
  record of the cause: each pass's dispatch decision (S16) and a retirement's live-route predicate. Regressions in
  `tests/notice-ledger.test.mjs`: a start failure's request holds the work until the member starts, then the
  handle-busy question is asked (fails on `72a3d6f` and on `29a0268`); after a recovered start failure, or a member
  failure, a dependent a cancellation strands is told by the fall-through and by the W3 stall (fails on both); and
  work pinned to a retired member gets no fall-through beside running work, which kills the mutant that drops the
  fall-through's deferral (a pin: it passes on `72a3d6f` and on `29a0268`).
- `8fe10ea` (fix, +3). B1 deferred the W3 stall all or nothing, so one rejection on an idle board still woke the owner
  twice (the rejection and the W3 stall over the source and its rejecting review), and tests pinned it. The W3 stall now
  tells only the stuck work no decision holds, in its subjects, body, count and event, and nothing when decisions hold
  all of it; a board with no stuck work (an uncovered criterion) still stalls on the mission root. A blocked verdict
  record is its source's, read by the predicate, so the stall root's inline filter is deleted. Regressions: one
  rejection is one wake (`tests/stall-roots.test.mjs`) and the W3 stall beside a rejection names only the other stuck
  work (`tests/notice-ledger.test.mjs`), each failing on `72a3d6f` and on `29a0268`. Tests that used a rejection as
  their stalled board now strand reviewer-only work on a stopped reviewer.
- `80caf99` (test). An older build's W3 row (key prefix `mission/stalled`, class decision) holds no work: B1's deny-list
  read it as a deciding family, open for good; the positive rule gives it no cause. Fails on `72a3d6f` and on
  `29a0268`.
- F19 row 7c stands: the ceiling request holds the blocked root at its epoch, not the pending dependent the root
  strands, so the root is told and names it. Row 7e is unchanged.

| Check at `80caf99` (`src` as at `8fe10ea`) | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` unchanged | passed, digest unchanged |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `scripts/smoke-web.mjs` / `scripts/smoke-command-web.mjs` | passed, 13 checks / passed, 10 checks | not run |
| Test files the round touched (4), three rounds of two concurrent copies | 24/24 runs passed, and `tests/notice-ledger.test.mjs` 6/6 again after `80caf99` | the 4 files, once: 92/92 tests |
| Test files reading the changed predicates or notices (26, among them `tests/in-memory-gates.test.mjs`), at the record's head | 404/404 tests, once | not run |

**Integrator round 3** (`6a8c269` to `1af4a8d`, and this record). `src` net against `29a0268` is now −630 lines
(+786/−1416); the round is −1: C2 +8, C1 −1 (`35fac1f` 0, `a5ac07b` −1), C3 0, the comments that state the rule once
−8. C2's +8 is the positive list of the guard openers raised for a task: a request's scope is on its row only through
the opener in its key, and no durable field may be added, so a list of those openers is the smallest structure that
tells them from the requests raised for a member; C1 folded it into `HOLDING`.
- `6a8c269` (fix, C2). bec0cc6 held every task a guard-terminal row named while it was blocked, whoever the request was
  raised for, so a member-scoped request (a failed dispatch, an isolation violation) left that member's unrelated
  blocked task with no stall root. Only a request raised for a task, or a revocation's, holds work. Regression
  `tests/notice-ledger.test.mjs` "P1d": a real handoff whose old owner's stop hangs beside the new assignee's failing
  dispatch, a dead end beside a failing dispatch, and a dead end beside an isolation request each get the stall root
  beside the open request. Fails on `82f5fd4`; on `29a0268` the handoff and dispatch boards pass (no deferral existed)
  and the isolation board fails on the request batch 11 keyed. F19 row 7e now asserts the stall root beside the open
  isolation request.
- `35fac1f` (fix, C1). 2a63505 put the clearing of a member's counted start failures behind `if (!adopted)`; a start
  that adopts a running session now ends them (`recordStarted`), while only an opening start clears an outage.
  Regression "P3" (an adoption mid-turn after one failed start: the count clears and the dispatch question names the
  work once) fails on `82f5fd4`. On `29a0268` it passes its count assertion (29a0268 cleared the counted failures after
  every resolved start, an adoption included) and fails at its last: no dispatch question is asked there (corrected in
  the final round).
- `a5ac07b` (fix, C1). bec0cc6's `decisionCause` was a second rule beside `ownerDeliveryRelevant`: a recovered start
  failure was still delivered and reminded while holding nothing. One list (`HOLDING`) and one openness rule
  (`openSubjects`, formerly `openGuardTerminal`) now serve delivery, reminders and the deferral (`held`, formerly
  `decided`); the delivery failure's end moved from `ownerDeliveryRelevant` into it, so its reminders stop when the
  transport recovers. Regressions in `tests/notice-ledger.test.mjs`: a recovered start failure stops being reminded
  (fails on `82f5fd4` and `29a0268`); the epoch guard, a rejection at e and the task blocked again at e+1 with no
  decision of its own, named at e+1 (fails on `82f5fd4` and `29a0268`, and the any-epoch mutant fails it); the
  fall-through leaves a pending task an open task-scoped request names (fails on `82f5fd4`, on `29a0268` and with the
  filter removed).
- `bda03ec` (fix, C3). Critique change 3: the dispatch question became the open pass's own and skipped the work its requests named. Regressions: "a dispatch-failed member with assigned work gives one
  request, not a request plus a dispatch question" (fails on `82f5fd4` and `29a0268`; removing the pass gate or the
  pass record each fails it), and r12-workspace-fixes M2-3 (no question with no open pass; an isolation-refused
  member's task is skipped only when the pass's own request names it; fails on `82f5fd4` and `29a0268`). The L-25 pin
  of the second wording and the co-fire's known-limitations and README prose are deleted.
- `d3265a2` (docs, C4). The retirement co-fire is one open item in known-limitations; R5-02 asserts the current
  behaviour, with a comment that names it.
- `1af4a8d` (docs, C6). README.md, README.zh-CN.md, docs/design.md and docs/known-limitations.md state the final rule;
  the source comments state it once (comments only).

| Check at `1af4a8d` | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` unchanged | passed, digest unchanged |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `scripts/smoke-web.mjs` / `scripts/smoke-command-web.mjs` | passed, 13 checks / passed, 10 checks | passed, 13 checks / passed, 10 checks |
| Test files the round touched (6) three rounds of two concurrent copies, and F19 likewise | 36/36 runs passed (774 tests), F19 6/6 | 15 touched or affected files, once: 265/265 tests |
| Test files reading the changed rules (47), at `bda03ec` | 666/666 tests, once | not run |

**Integrator decision: B1 withdrawn** (`2fab0f1`, `e5ce2e0`, and this record). `src` net against `29a0268` is now
−612 lines (+712/−1324); the round is +18: W1 +21, W2 −3. B1 let a board-level naming defer to an open owner decision
that named the same work, and was repaired three times; every verification found a new way for a stuck task to go
without any notice. Round 1 (of `cf45ce0`): a start failure the member had recovered from, a member failure, an
escalation or a failed dispatch held pending work for good at its epoch, so a dependent a cancellation stranded got no
W3 stall or fall-through and work behind a busy handle was never asked about. Round 2 (of `bec0cc6` to `80caf99`): a
member-scoped request held that member's blocked work (P1d), and an adoption left the start failures standing (P3).
Round 3 (of `6a8c269` to `1af4a8d`): a task-scoped request stayed open after its task was re-pended or resumed, a
worker-delivery failure held the recipient's blocked work, an isolation refusal identified work given to the member
later, and a chained pass body lost what the first body identified. No silent state is the product's core guarantee
and a duplicate wording is noise, so under the owner's rule (a needed patch means the approach is wrong) the integrator
withdrew B1: a decision can hold work only once every decision's openness is bound to its own cause, which is the
decide-then-act Notices slice's job (S12). The final rule is step 5's above; R20 is open in known-limitations.
- `2fab0f1` (fix, W1, +21). Deleted: `HOLDING`, `openSubjects`' holding branches, `held()` and its callers (the W3
  stall's per-subject filter, the stall roots, the fall-through, the pass-end dispatch question),
  `SchedulingPass.identified` with `identify()`, and the dispatch question's pass gate. Restored as at `3e4049c`: the
  `coveredBy` cover of a rejected stall root, which B1 had deleted, so the withdrawal is exactly B1's own −21 returned.
  Kept: B2 (`b9e89e4`, `e07d9e4`), `35fac1f` and the revocation request naming the work it fenced. The test files only
  B1 changed return to `3e4049c` (F19 loses row 7e, which asserted the deferral's boundary); notice-ledger keeps
  `e07d9e4`'s assertion, P3 (retitled to its property) and P1d's three boards as no-silent-state guards, and loses ten
  deferral cases. Regressions, each failing on `4cd605d` and passing here: the revocation case (its request names the
  fenced work, and the stall root and the W3 stall name it too, on the real overview; it also fails on `29a0268`, where
  it times out before its request assertion waiting for a `board-stall:` row, since 29a0268 keyed the W3 stall
  `mission/stalled:`; with that key mapped it fails because 29a0268's request names the mission root) and the restored
  stall-root, create-path, W3-stall, L-25, M2-3 and covered-row tests. On a `4cd605d` build the 10 test files the
  withdrawal touched fail 18 tests in 7 files: notice-ledger 7, stall-roots 5, liveness-create-path 2, and
  arena-protocols, client-event-projection, r12-workspace-fixes (M2-3) and start-failure-recovery (R5-02) 1 each, W2's
  two among them (corrected in the final round).
- `e5ce2e0` (fix, W2, −3). The dispatch question's start-failure clause (`5ce7354`, `ebccfd5`) treated a durable member
  field as the record that the owner was told. It is deleted: the work a failing member cannot start is asked about
  once beside its start failure (notice-ledger; fails on `4cd605d`, `3e4049c` and `29a0268`). In a start-failure storm
  the question spends a slot of the owner's wake window, so R5-02, F18 and the flapping-preparation case read the
  retirement and the block from their own row or the window summary's durable facts, and R5-02 lists the question
  among the stranded task's wordings.
- Unchanged: F19 passes as at `3e4049c` (rows 1 to 17 with 7b, 7c and 7d; row 7e, B1's, is gone), the replay digest
  and `tests/fixtures/model-visible.expected.json`. `tests/client-event-projection.test.mjs` passes on its real overview.

| Check at `e5ce2e0` | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` unchanged | passed, digest unchanged |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `scripts/smoke-web.mjs` / `scripts/smoke-command-web.mjs` | passed, 13 checks / passed, 10 checks | passed, 13 checks / passed, 10 checks |
| Test files the round touched (10), three rounds of two concurrent copies, and F18 and F19 likewise | 60/60 runs passed (1,014 tests), F18 and F19 6/6 | the 10 files and 2 doc-reading files, once: 208/208 tests |
| Test files reading the changed rules, start failures or docs (40), once, at this record | 598/598 tests | not run |

**Integrator final round: every board-level naming is told while its own condition holds** (`b2d4157` to `a931ee1`,
and this record). `src` net against `29a0268` is now −633 lines (+722/−1355); the round is −21: E1 −15, E2 −5, E4 −1
(E3 and the P1d title are tests only). B1's withdrawal left two older deferrals that silenced stuck work, each
reproduced by a probe; both are deleted.
- `b2d4157` (fix, E1, −15). D1 (`d451784`): while any submission the review admission speaks for was unreviewable,
  `boardFact` returned no fact and `judgeBoard` returned before the fall-through, so a dependent a cancellation
  stranded elsewhere on the board was named by no row, on a board with no live work and beside running work
  (`29a0268` named it). Deleted: both board-wide gates (`boardFact` is "not stalled, no fact"; the fall-through's guard
  is the review path's own stall) and `Scheduling.unreviewedStall`. What D1 protected (D3: no W3 stall against a ripe
  need the host can still satisfy by admitting a review, off-pass or wedged) is now one rule about the submission,
  `awaitsReviewAdmission`, read by the stall predicate and the waiting classifier alike: an unreviewable submission is
  work the host can still advance inside its review grace and, for one the admission speaks for, until the admission
  has recorded its current need (`ReviewNeed.recorded`). A submission an older build left without an artifact is
  ordinary stuck work once its grace ends, as before. Once the admission names a blocker, the board's W3 stall (beside
  running work, the fall-through, which then names the source too) is told beside the review-blocked decision, and a
  withdrawn review that moves the W3 stall's stuck work tells a second W3 stall: R20 wordings. Regressions in
  `tests/notice-ledger.test.mjs`: the D1 probe (the stranded dependent is named by the W3 stall on a board with no live
  work and by the fall-through beside running work while the source stays unreviewable; fails on `29a0268` and on
  `9d5f224`) and the D1 test, which now requires the dead dependent to be named, the second W3 stall after the
  withdrawn review and only the newest outstanding (fails on both). The D3 test keeps its three routes, its twelve
  deliverables and their no-W3 assertions; its precondition now states that the need is ripe and unprocessed and that
  the board is not stalled by it. Four tests that pinned D1's silence now pin the W3 stall told beside the decision,
  once; a fifth became the D1 probe.
  `tests/scheduling-pass.test.mjs` reads the grace from `ReviewNeed.ripe`, and its stall-versus-waiting test asserts
  that both readers move together at the admission's record.
- `ec2a892` (fix, E2, −5). The dispatch question skipped a task whose every startable member the isolation invariant
  refused (a skip `af09ce7` introduced on this branch; `29a0268` asked the question with an isolation wording), and it
  was always about the first undispatched task, so once that task's row was on the ledger no other was named. The
  `[workspace_terminal]` request names the work it saw when first told, so work given later to a listed member, or
  runnable only by listed members, got no notice (the isolation probe; on `29a0268` the unassigned case was silent
  too). Deleted: the isolation clause, the `isolationIssues` import and the `startable` list. The question is about the
  first dispatchable task that did not dispatch and is not yet asked about at its epoch on the ledger, so successive
  judgements ask about each such task once. Beside the isolation request
  this is one more R20 wording, and while a body is wedged each judgement asks about the next task the wedged sweep has
  not reached. Regressions, each failing on `29a0268` and on `9d5f224`: the isolation probe (later work, unassigned and
  given to a listed member, each named once by the dispatch question beside the one open request, which does not name
  it), the isolation request test's later-work board, and r12-workspace-fixes M2-3. The wedged-body test in
  `tests/scheduling-pass.test.mjs` now observes the judgements: none runs with the wedged branch once the body sweeps
  again (the progress-blind `passState` mutant fails it), and each question was asked while the body sat in the wedged
  await.
- `59fcb19` (refactor, E4, −1). The reminder loop's `|| covered(delivery)` term is deleted: a covered fact is never
  sent, so `deliveredAt === undefined` already excluded it. The 47 test files that read covered rows, the rejection
  decision or the reminder loop pass as before.
- `1b23674` (test, E3). Pins of the rules the withdrawal restored. The fall-through names stuck work at its epoch,
  once, beside an open request raised for that task and beside the retirement of the route it is pinned to; a
  fall-through that defers to any owner row naming the task fails both boards. The rejection cover matches its
  subject@epoch only (`tests/stall-roots.test.mjs`): blocked again at the next epoch beside running work, the task is
  named there by an uncovered stall root in a delivered notice; a cover by task id at any epoch fails it. R5-02 and F18
  assert what the owner is woken with in an all-routes-fail storm (the retirement rides the wake-budget summary, which
  names the task and points to `swarm_observe` with its `deliveryId`) and, through that call, that the durable fact
  carries `swarm_add_member`; they no longer rebuild the exit from the summary's stored facts as if delivered. These
  pass on `9d5f224`; on `29a0268` the fall-through and R5-02 tests fail and the cover test passes.
- `a931ee1` (test). P1d is titled by its property, without naming B1.
- Corrections to this entry: the revocation case's failure on `29a0268`, the per-file counts on a `4cd605d` build and
  P3 on `29a0268` (in the withdrawal and round-3 records above), each measured on detached builds of those commits.
- Seen once, before the rounds: the real-time R15-D2 case in `tests/owner-decisions.test.mjs` named the blocked task by
  the fall-through first, when the stall-root and waiting samples read the clock on either side of the stop bound. It
  passed on four reruns and in all six round runs; known-limitations lists it among the wall-clock cases.
- Unchanged: the replay digest, `tests/fixtures/model-visible.expected.json` and F19.

| Check at `a931ee1` | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` unchanged | not run |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `scripts/smoke-web.mjs` / `scripts/smoke-command-web.mjs` | passed, 13 checks / passed, 10 checks | not run |
| Test files the round touched (6), three rounds of two concurrent copies, and F18 likewise | 36/36 runs passed (870 tests), F18 6/6 | the 6 files and F18, once: 145/145 tests, F18 1/1 |
| Test files reading the changed rules, notices, start failures or docs (84), once | 1,127/1,127 tests | not run |

**Integrator closing round: the dispatch question is one emitter among the board's, and the review admission's own
rule** (`c259487` to `b982c30`, and this record). `src` net against `29a0268` is now −662 lines (+735/−1397); the round
is −29: E6 −16, E7 −12, E8 −1. The three lenses of the final round's verification found the same remaining hole (E6)
and one weak predicate (E7).
- `c259487` (fix, E6, −16). `judgeBoard` ended the judgement at the dispatch question whenever some pending task was
  dispatchable: its branch returned after asking, and earlier still under the T3 all-busy gate, so the board's fact and
  the fall-through never ran. Beside an isolation-refused task, or ready work whose member's handle is busy, a
  dependent a cancellation stranded was named by nothing: a regression against `29a0268`, where the cancel site told
  it, since `f6b9c34` made the board classifier its one namer. Both returns are deleted. The T3 gate guards only the
  question (asked unless the judgement is not wedged and no member is startable); the board's fact and the
  fall-through always run, and the fall-through counts a dispatchable task as having a live path, because the question
  is its namer. A board on which completion is allowed beside a dispatchable experiment is now told its
  coverage-complete. Regressions in `tests/notice-ledger.test.mjs`, one subtest each: GATE-BUSY (a stranded dependent
  beside ready work whose member's handle is busy) and GATE-ISO (beside isolation-refused work). The fall-through names
  the dependent alone, once, outstanding; of the board's namings only the dispatch question names the ready work under
  GATE-ISO, beside the isolation request, and none does under GATE-BUSY (T3). Both fail on `93db631` (the dependent is
  named by nothing) and on `29a0268` (it is named by the cancel site's decision, not by the board).
- `9e0847e` (fix, E7, −12). `awaitsReviewAdmission` read the admission's record (`ReviewNeed.recorded`) as "the host
  can still advance it". Once the admission had recorded a need by deferring its review beside running work
  (`BOARD_RUNNING`), the end of that work let a pass end or a wedged publication tell a W3 stall, and the next pass
  admitted the host review for that same need. The predicate now reads the admission's own rule: an unreviewable
  submission awaits the admission inside its grace or, for a source the admission speaks for, while
  `reviewPathBlocker` names no blocker under the board's own stall (the next pass on a stalled board admits its
  review). Deleted: the recorded term, the second statement of which submissions the admission speaks for (a
  submitted artifact, now stated once and read by `unreviewedSources` and `awaitsReviewAdmission`), and the restated
  `LineageRuntime` interface, now a `Pick` of `SwarmRuntime` since it must carry the blocker rule with the runtime's
  `ReviewNeed` type. Two consequences, both wordings the docs already list: a source with a real blocker (no
  independent member, the task budget, a dead or withdrawn host review, a deferred verdict) is stuck work from the end
  of its grace, before the admission names the blocker, so on a quiet board the W3 stall can precede the review-blocked
  decision; beside running work the blocker is the running board, so the fall-through names the source once its grace
  ends, where it waited for the admission's record before. Regressions in `tests/notice-ledger.test.mjs`: D3-expiry
  (the running work's lease runs out, with no recovery left, inside the pass that records the `BOARD_RUNNING`
  deferral; no W3 stall is told before the next pass admits the host review) and the D3 test's recorded-need wedged
  route (the owner withdraws the running work and a wedged publication judges the board first). Both fail on
  `93db631`; on `29a0268` D3-expiry fails on its W3 stall and the D3 test at its first route's precondition, as in the
  final round. The liveness half is pinned: the review-blocked test also exhausts the task budget, and the W3 stall is
  told beside the decision (passes on `93db631`). The stall-versus-waiting test in `tests/scheduling-pass.test.mjs`
  now reads the blocker: past its grace a blocked source is a stall and one the admission would serve waits, before and
  after the admission's record, and the admission admits a review exactly when it names no blocker (fails on `93db631`
  and on `29a0268`).
- `b982c30` (refactor, E8, −1). The dispatch question read the ledger with a hand-built identity. `noticeIdentity`,
  the derivation `notify` and `tell` write under, is a module function, and the question reads its row under it. The 12
  files that read the question or the ledger's dedup pass unchanged (243/243 tests). Outside this round's brief, three
  other ledger reads still build their identity by hand: the budget warnings (`gates.ts`), `guardTerminalHeld` and
  `notifyReviewBlocked`.
- Correction: E2's record above called the dispatch question's isolation skip older than batch 11; `af09ce7`
  introduced it on this branch (`29a0268` asked the question with an isolation wording).
- Unchanged: the replay digest, `tests/fixtures/model-visible.expected.json` and F19.

| Check at `b982c30` | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` unchanged | not run |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `scripts/smoke-web.mjs` / `scripts/smoke-command-web.mjs` | passed, 13 checks / passed, 10 checks | not run |
| Test files the round touched (2), three rounds of two concurrent copies | 12/12 runs passed (474 tests) | the 2 files and 2 dispatch-question files, once: 120/120 tests |
| Test files reading the changed rules, notices or docs (53), once; the 15 that read the docs again with this record | 737/737 tests; 257/257 tests | not run |

**Integrator closing round 2: the review admission has two outcomes, a blocker or an admitted review** (`55b1209` to
`5209de7`, and this record). `src` net against `29a0268` is now −683 lines (+752/−1435); the round is −21: E9 +1,
E11 −22 (the row-3 return −8, the ledger identities −14); E10 is a test. The three lenses of the closing round's
verification found one hole in E7 (E9).
- `55b1209` (fix, E9, +1). E7 made `awaitsReviewAdmission` read `reviewPathBlocker` as the admission's whole rule, but
  the admission had a third outcome that rule did not derive: the host review's proposal refused (`automatic review
  admission failed`, known only to `admitAutomaticReview`'s catch). On a quiet board the refused source awaited the
  admission on every pass, the board never stalled, `judgeBoard` returned at the review path's stall before the
  fall-through, and a dependent of the source, or one a cancellation stranded anywhere on that board, was named by no
  row (a regression against `93db631` and `29a0268`). Each pass also proposed the refused review again (four proposals
  in four passes on `f63fa0b`), beside running work `BOARD_RUNNING` displaced the refusal, and a refusal written in the
  pass that admitted another source's review was withheld (the residual known-limitations recorded).
  `reviewPathBlocker` now derives the refusal for the current need as it derives a withdrawn host review: the source's
  newest `task/review-blocked` row is newer than the row that opened the need and states `ADMISSION_REFUSED`, the
  statement's prefix, one constant beside the other review-path statements, read by `admitAutomaticReview` and by the
  derivation. It is named after the task slot and the independent member its exit needs. The refusal is a cause like
  the others: the board stalls, the W3 stall is told beside the decision, and the host proposes its review once per
  need; the owner's exits stay. Deleted: `openReviewBlock`'s `?? recordedBlocker(...)` fallback (not dead, as
  first recorded: with it a cause the owner removed on a stalled board stayed outstanding until the next pass; without
  it the decision retires at the removal, which the integrator kept as consistent with the D3 rule) and
  `Notices.recordedBlocker`, whose one remaining reader, `notifyReviewBlocked`'s check that records the blocker whenever
  it changes, reads the newest recorded reason itself; and the known-limitations residual. The +1 is the derivation (2
  lines), the constant (1) and the cause in `reviewPathBlocker`'s contract (1), against the fallback and
  `recordedBlocker` (−3). One corner, measured by a probe and now in known-limitations: a cause named before the
  refusal (the task budget, an independent member, a deferred verdict) that is recorded after it displaces it, and
  once the owner removes that cause the host proposes its review once more; refused for the same reason, it is recorded
  again with no second decision. Regressions in `tests/review-blocked-exits.test.mjs`, whose `refusedAdmission` recipe
  gains a hook that changes the board after the submission: REFUSED-DEP and REFUSED-D1 (on a quiet board one
  outstanding W3 stall names the source's dependent, and a dependent a cancellation stranded elsewhere, beside the
  outstanding refusal), REFUSED-PAIR (the refusal written in the pass that admitted another source's review is
  outstanding and delivered) and the refused-then-running-then-stall test, rewritten (the refusal stays the one
  recorded cause and the outstanding decision beside running work and after it, and the host proposes its review
  once). All fail on `f63fa0b` (there no row names either dependent) and on `29a0268` (there REFUSED-DEP and REFUSED-D1
  fail only on the W3 stall's family: that build's W3 stall, under its older `mission/stalled:` key, names the
  dependents, and its cancel site names the stranded one). E7's liveness pin in `tests/notice-ledger.test.mjs` gains
  the refused admission: the W3 stall is told beside the refusal (fails on `f63fa0b` at that board, and on `29a0268`
  at its first board, as before).
- `e6d28d9` (test, E10). E7's `BOARD_RUNNING` half: beside work running under its lease, past its grace, a source the
  host's review would serve is named by the fall-through alone, outstanding, beside the outstanding `BOARD_RUNNING`
  decision. It passes on `f63fa0b` and here; mutant M9 (`awaitsReviewAdmission` reading `reviewPathBlocker(task, need,
  true)`, a forced stall) fails it on both (the fall-through names nothing). On `29a0268` it fails at its precondition
  (that build's review need has no `ripe` grace).
- `1cbb3f7` (refactor, E11, −8). `judgeBoard`'s row-3 return is deleted. Every board it exempted (each non-terminal
  task running under a live lease) is exempted by the classifiers after it: completion is refused while a task runs
  (only a blocked task is exempt from it), the stall predicate is false beside running work, so the board's fact tells
  nothing, and the fall-through counts a running task with an attempt as waiting. The fall-through's comment now states
  row 3 and the T3 case: while no member is startable no question is asked, and the dispatchable task is still left to
  the question. F19 (row 3 exempt with no notice) and the 10 files that read the classifier, the lease or T3 pass as
  before (215/215 tests).
- `5209de7` (refactor, E11, −14). The three readers that built a ledger identity by hand ask `noticeIdentity`, so its
  comment is true. `notifyReviewBlocked` tells its decision through `tell`, with its record as the companion write, and
  records a changed blocker alone when the owner holds its decision; the budget warnings ask it for the threshold
  identities they read and the batch constituents they write (their subjects are `subjectsOfTasks` of the warning's
  task, else the mission root: what `noticeSubjectsFor` returned, without its second read of the task table); the
  workspace fence asks it for its revocation request's identity, and `guardTerminalHeld`, that fence's one helper, is
  deleted. No reader's identity differs: each holds an explicit key. The 29 files that read these identities or the
  notice sites in source pass as before (498/498 tests).
- Docs: known-limitations no longer says coverage-complete is told beside a dispatchable experiment; its
  review-admission paragraph counts the refused admission among the causes, states the outstanding rule without the
  fallback, drops the withheld-refusal residual and records the displaced-refusal corner; design.md counts the refusal
  among the blockers. README.md and README.zh-CN.md state nothing E9 changes (their "while nothing blocks one" is now
  exact) and are unchanged.
- Correction: the closing round's E6 record says a board on which completion is allowed beside a dispatchable
  experiment is now told its coverage-complete. No such board exists: a dispatchable task is pending, and completion is
  refused while any task is pending.
- Unchanged: the replay digest, `tests/fixtures/model-visible.expected.json` and F19.

| Check at `5209de7` | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `npm run test:harness` | passed; `UPDATE_SMOKE_SNAPSHOT=1` leaves `tests/fixtures/model-visible.expected.json` unchanged | passed |
| `npm run test:replay` | passed, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` unchanged | not run |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `scripts/smoke-web.mjs` / `scripts/smoke-command-web.mjs` | passed, 13 checks / passed, 10 checks | not run |
| Test files the round touched (2), three rounds of two concurrent copies | 12/12 runs passed (702 tests) | the 2 files, once: 117/117 tests |
| Test files reading the changed rules, identities or docs (45), once, with this record | 691/691 tests | not run |
## Batch 12: acceptance criteria by reference (2026-10-14)

**Gate at `c5aa308`** on `batch12/accrefs` (41 commits on `dfc0825`, not merged; batch 10 merges first). On
0.1.5-rc.3 `npm run typecheck`, `npm run build`, `npm run test:harness` (composition and boundary compaction),
`npm run test:replay` (digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e`, unchanged),
`node scripts/faults/run.mjs` (24/24), `scripts/smoke-web.mjs` and `scripts/smoke-command-web.mjs` (both
`passed: true`) passed. On 0.1.7-rc.1, in a detached worktree on that host's link farm, typecheck, build and
`test:harness` passed, and ten test files ran 128/128 (the eight node:test files the integrator round touched,
`tests/draft-editor-criteria.test.mjs` and `tests/roles.test.mjs`). The behavioral suite was not run whole: the 115
test files (of 176) that read a changed symbol ran together once, 1208 tests, 1205 passed and 3 failed as timeouts
while the load average was above 50 (two 300 s host git deadlines in
`tests/r24-declared-outputs-capture.test.mjs` and `tests/workspaces.test.mjs`, one `[mission_operation_pending]` in
`tests/r17-worker-names.test.mjs`); each of the three files passed alone at a load average of 11 (27/27, 36/36,
5/5). An earlier 26-file run failed once in `tests/owner-decisions.test.mjs` (R15-D2, the bounded `workers.stop`);
that file then passed 24/24 three times alone and passed in the 115-file run. The eight touched node:test files each
passed three rounds of two concurrent copies.

**Why.** A mission criterion had no identity, so every row that answered for one stored a copy of its text and every
coverage decision compared the copies as strings. Of 86 recorded real `swarm_launch` calls, 10 were refused with
"Missing exact acceptance strings … a paraphrase does not match" (`b2efddc`). A recount over the 80 distinct recorded
calls (`f775ee1`, reproduced for this entry from the saved extract) finds 12 plans in which some criterion had no
verbatim copy on a deliverable (21 criteria: 10 sat only on a review, 11 on no task), and a mission criterion repeated
on 169 of 315 authored reviews, in 50 of the 80 plans.

**What changed.**

- Wrong model: a criterion is a string that must reappear verbatim on a deliverable, on every repair of it and on its
  review; launch, completion and the staged-draft repair compare those strings, and that repair could rewrite the
  mission's own list.
- Right model: criterion *i* is `c{i+1}` (`criterionId`), fixed once the mission exists. A deliverable cites the ids
  it satisfies in `covers`, and a row stores only its own criteria. Two selectors on the replacement lineage derive
  the rest (`src/task-graph.ts`): `criteriaOf`, what a task answers for, and `checklist`, what its worker and every
  reviewer read. Automatic launch (`[plan_criterion_uncovered]`) and completion read ids only. `citedCovers` is the
  one validator of a plan's and a proposal's `covers` and returns the one stored form, the task's own non-empty list
  or no field. One projection per reader: a member reads the checklist as text and never an id (`memberTask`: its
  assignment, `swarm_observe`, the result of its own propose, claim, submit and verify); the owner reads the stored
  row at every exit and resolves ids through the criteria map of a fresh `swarm_observe` overview.
- Deleted: the verbatim rule in `automaticPlan`, in `completionError` and in the planner's prompt and schemas; both
  `draft_repair_acceptance_dropped` checks and the repair's rewrite of `Mission.acceptance`; a repair's stored copy of
  the lists it replaces with `inheritedAcceptance` and the propose note that listed it; a host-added review's copy of
  its source's list; the second writer of an assignment delivery (`assignmentCheckEnvironment` and the resume's own
  `store.put` in `src/gates.ts`); and, in the integrator round, the owner branch of the observe record, the registry's
  derivation, and the `accepted` intermediate in `completionError`.

**Integrator round** (`7267433` to `c5aa308`).

- `7267433`: the owner read the stored row from `swarm_propose`, `swarm_control`, `swarm_cancel` and the snapshot but
  the derived checklist from `swarm_observe` and `swarm_registry`. Both now return the row; the registry row also
  carries `covers` and `replaces`. One test reads a deliverable that only cites ids, and the repair that replaces it,
  through every owner exit; a second walks every member exit and finds no `covers` key.
- `3e6a970`: the schema 4 upgrade applies one rule to every task row and draft plan task. Its own `acceptance` drops
  what its checklist already takes from its review source and from the tasks it replaces, and a deliverable cites the
  mission criteria left in it, so an upgraded row is the row this version stores for the same proposal and the amend
  dependency guard no longer answers by row age.
- `0fd5f9c`: three surviving mutants die, each proved on a scratch build: the upgrade run at every open, completion
  counting the `covers` of every accepted task, and the upgrade citing only the first draft task that changes.
- `e534739`, `0e54151`, `5538719`: a reviewer's `observe().current.reviewSource` is its source's checklist with no
  ids, in the delta and in the focused view; the prior-work guard is pinned through the registered `swarm_propose`
  for a cited and for an inherited criterion; the Loader composition asserts that no delivery or tool result a worker
  received carries `covers`. `tests/fixtures/model-visible.expected.json` was regenerated deliberately: the assignment
  of "Implement value two" and of its review now list `["value is two", "node check.cjs passes"]`, the cited
  criterion's text and then the deliverable's own, a list no row stores.
- `2c6a5e7`, `c5aa308`: citing nothing is the absent field through a launch and through a staged repair alike, and a
  plan that writes `covers: []` validates to the plan that omits it; completion names one set.

**Repair round 2** (`8e89565`, `dafbc4b`, `7825686`; tests only, `src` unchanged). A second mutation pass over the
integrator round found three rules a test named without holding them. Each mutant passed the previous tests whole and
now fails, proved on a scratch build.

- `8e89565`: completion's filter without its status condition, so a withdrawn deliverable's ids count. The withdrawn
  task of the existing test was an implementation without an artifact, which the artifact condition already excluded.
  `tests/completion-eligibility.test.mjs` now holds one row per condition (an accepted review, an accepted
  implementation without an artifact, a cancelled research task), and the task withdrawn through `swarm_cancel` in
  `tests/criteria.test.mjs` is research.
- `dafbc4b`: `swarm_propose` storing `covers: []` as written, and refusing a review that writes it. The leg named for
  `swarm_propose` launched a plan, whose validation had already removed the empty list. The registered
  `swarm_propose` is now handed `covers: []` for a deliverable and for its review; the returned tasks and the stored
  rows are the launched ones, with no `covers` key.
- `7825686`: the upgrade saving a draft only when a deliverable changed. `3e6a970` had edited the one fixture of that
  shape. Both shapes now stand: a v3 draft whose review alone copied its source's own criterion is rewritten (the
  review holds `[]`), moves to its next revision, refuses the page's stale save and is named in the change's scopes;
  a draft whose tasks hold only their own criteria is left as it is.

Gate at `7825686`: on 0.1.5-rc.3 typecheck, build, `test:harness`, `test:replay` (digest unchanged),
`node scripts/faults/run.mjs` (24/24) and both web smokes (`passed: true`) passed; on 0.1.7-rc.1 typecheck, build,
`test:harness` and the two touched test files (35/35) passed. Each touched file passed three rounds of two concurrent
copies.

**`src` against `dfc0825`: +160 −155, net +5.**

| File | + | − | net |
| --- | --- | --- | --- |
| `src/runtime.ts` | 53 | 73 | −20 |
| `src/gates.ts` | 1 | 8 | −7 |
| `src/tools.ts` | 15 | 22 | −7 |
| `src/admission.ts` | 6 | 9 | −3 |
| `src/plans.ts` | 13 | 9 | +4 |
| `src/types.ts` | 10 | 4 | +6 |
| `src/task-graph.ts` | 13 | 2 | +11 |
| `src/client/DraftEditor.tsx` | 18 | 12 | +6 |
| `src/store.ts` | 24 | 9 | +15 |
| `src/planner.ts`, `src/refusals.ts`, `src/client/SwarmBoard.tsx`, `src/client/locale.tsx`, `src/client/styles.ts` | 7 | 7 | 0 |

The decisions, views and schemas net −16, the draft editor +6 and the one-time store upgrade +15. The total is not
negative; without the upgrade the branch nets −10.

- The upgrade, +15, is `citeCriteria` (14 lines) and the import of the derivation it applies; its call takes the place
  of a line of the hand-written BEGIN/COMMIT that `transaction()` replaced. Each line answers a requirement: a task
  row older than the list shape is left alone; a row drops only what the runtime's own `checklist` supplies from
  elsewhere, so the upgrade cannot disagree with what a worker reads; a review cites nothing, because its copies never
  decided a verdict; a staged mission takes its saved draft's criteria, without which a v3 staged draft with an
  appended criterion could neither relaunch nor be saved; a rewritten draft takes its next revision, without which a
  page still holding the v3 draft would save the copies back; and only changed rows are written. The alternative to
  rewriting once at open is a branch in the runtime that keeps comparing criterion text on old rows. That is a
  compatibility branch that never goes away; the upgrade is a one-time rewrite, and it is accepted as the cost of
  keeping existing stores.
- The editor, +6: `removeCriterion` +5, the Covers box +1, the numbered criteria rows +1 over the textarea they
  replace, the template −1. An id is a position, so removing a criterion shifts every later id, and `removeCriterion`
  renumbers each task's `covers` in the same edit; the only structure that needs no renumbering stores an id on each
  criterion, a durable field the design rejected. The Covers box is the one control that writes `covers`.

## Batch 10: every review-blocked exit is its own, and the round-5 leftovers (2026-09-27)

Merged as `29a0268`. Every review-blocked blocker names the exit that removes it, as fixed texts that name every
allocation a launched mission's admission requires (`ADMIT_REVIEW`, `REPLACE`); the stall is judged once per admission
pass; the recorded blocker follows the derived one; the sidebar shows a decision in full. Ten low-severity leftovers of
the 2026-09-24 review landed with it (the resident worker ends where the host ends its agent). F13 and F19 awaited
their wake deliveries instead of reading them at once (`5bed1d9`): both failed about once in twenty runs on `dfc0825`
as well, a test race, not a regression. src -68.

Gates on 0.1.5-rc.3 and 0.1.7-rc.1: typecheck, build, full suite 1641/1641, `test:harness`, `test:replay`, pack,
profile, bundle, faults 24/24, `smoke-web` 13/13, `smoke-command-web` 10/10.

## Round-29 simplification batch 9: one authorization rule, one exit table, a derived progress clock (2026-09-25)

**Gate at `27fa353` and `19dbc30`.** Seven branches were merged onto main `75b765a` on `b9-integration` (`96f6db9`
batch9/commit, `c99e854` batch9/auth, `bb242d9` batch9/checks, `380e03f` batch9/adapter, `2226867` batch9r2/authz,
`cb331ca` batch9r2/trace, `72cc577` batch9r2/exits), with the whitespace-only `a65f837` between `380e03f` and
`2226867`, and followed by `27fa353`. On both supported hosts the build passed, and the behavioral suite ran 1564
tests: 1554 passed and 10 failed, all in `tests/trace-recording.test.mjs`, whose fixture called `runtime.create`
without the claim argument the authorization branch made required. `19dbc30` fixed the fixture, and the file passed
11/11 three times on 0.1.5-rc.3 and once on 0.1.7-rc.1. Every other gate passed on both hosts (table below). Six
repair commits followed (`832b4a3` to `95318c0`); each fix is recorded below with its own regression (`b7f78f2` is a
refactor covered by the existing `tests/authorized-workspace.test.mjs` cases), and the gate figures are those of
`27fa353` and `19dbc30`. A second repair series (`dc5d0f6` to `0ff86e2`, 2026-09-25 to 2026-09-26) has its own gate record below.
`src` net against `75b765a`: −464 lines (+649/−1113) at `19dbc30`, −478 (+664/−1142) at `95318c0`, where the
behavioral suite has 1571 tests, −482 (+682/−1164) at `8b97e07`, and −497 (+749/−1246) at `c65f7f1`, where it has
1577.

**Progress clock** (`2f7f57a`, `c371e34`; review M-2, L-1). Wrong model: after every commit `Notices.transition()`
recomputed the absence net's clock from the bounded event window (`maxEvents`), a hard-coded set of 20 type names
(three of them never registered) and every evidence row, and saved it on the mission through a second, nested commit
after the first was durable; a `WriterBusyError` there made a committed claim report `writer_busy`. Right model:
whether an event is progress is a property of its kind (`EventSpec.progress`), and the clock is read from the
append-only log (`SwarmStore.progressAt`: the newest progress-kind row, else the mission's `createdAt`), so no writer
can leave it behind and `commit()` opens one transaction. Deleted: `Notices.lastTransitionAt()` with its scans and
name set, the nested commit, and the stored `meaningfulProgressAt` with its casts (`tests/progress-clock.test.mjs`).

**One workspace authorization rule** (batch9/auth, batch9r2/authz, and the repairs `b7f78f2`, `1912420`,
`95318c0`, `79910ee`, `db41b05`; review H-1, L-36).

- Wrong model: the rule was written three times over two representations and judged at two layers on two clocks.
  The runtime asked a closure (`RuntimeConfig.authorizeWorkspace`) that demanded the longest configured root equal
  the recorded one, so a narrower root configured later fenced a healthy mission as "removed" (H-1). The adapter
  and the browser API re-checked with an exact-root rule on host time. A worker start and the planning snapshot
  reached the adapter with no runtime check, and the declared-check retry created a second checkout with none.
  The authorization rode inside the plan as optional fields that validation dropped and a cast recovered; once
  `592a0c6` stopped reading a missing source as a session authorization, both web smokes failed from `c99e854`.
- Right model: `RuntimeConfig.grants` is the one representation and `claimFor` (`src/authorization.ts`) the one
  rule: the calling session's own directory, else the most specific active configured root that contains the
  realpath-resolved workspace. Admission, the synchronous create path and re-validation all decide through it. Each
  entry point hands the runtime its claim beside the plan (`WorkspaceClaim`), and the runtime records it. Since
  `79910ee` the runtime's config is also the snapshot's one channel: `SwarmRuntime.start()` takes no argument and
  records the audit of `config.grants`, and the planning tools and the browser plan path authorize against
  `runtime.config.grants`. Since `db41b05` the field is required: a plugin with no configured root loads the empty
  snapshot, which authorizes only the calling session's own directory, and admission, re-validation and every entry
  point read that one value. Only the runtime re-validates, on its own clock, before each of these paths: worker
  start, member admission, claim and dispatch, planning snapshot, plan repair, each verification checkout (the retry
  included), and since `1912420` delivery inspection and application and a draft launch before its check preflight.
  Submission capture, a review's artifact inspection and capture, and the checkpoints taken at a stop, an idle
  close-out or a lease expiry inside a running attempt are not re-validated themselves; they write objects and refs
  into the authorized repository, and a revocation reaches that attempt only when a later re-validation on one of
  these paths fences the mission, which blocks and stops its running work. The browser API only admits, and answers
  the runtime's `WorkspaceRevokedError` as a bad request carrying its diagnostic. `fenceWorkspace` is idempotent from
  mission state; since `95318c0` its owner decision is keyed on the runtime instance that found the revocation, so
  the owner is woken once per runtime instance, that is, per Harness start or plugin reload.
- Deleted: `RuntimeConfig.authorizeWorkspace` and its closure, the duplicate grant types, the adapter's grants and
  checks (`WorkspaceOptions.grants`, `HarnessWorkerOptions.grants`, the manifest's anchor copy), the plan's
  authorization fields and `WORKSPACE_BOUND_TOOLS`, scheduling's second fence, the browser's
  `assertRecordedWorkspace`, `grantFor` as a separate export, the three session-then-root sequences, the
  mission-wide revocation key, and the snapshot's other channels with their two "absent means no roots" defaults
  (the `start(grants)` parameter, `registerTools`' grants parameter, `WebApiOptions.grants`, `planInput`'s grants and
  dependency-directory parameters) and the runtime's two `grants === undefined` branches, which recorded a caller's
  claim verbatim and skipped re-validation (`tests/authorized-workspace.test.mjs`).

**Deletions without production readers** (batch9/checks; review M-4, M-11, M-12, L-6, L-9, L-11, L-16, L-17, L-33,
L-34, L-36). `readScratch`/`ScratchRead`; the `ownerReplyGuard` mode nothing read (a profile that still sets it
loads, `tests/surface-config.test.mjs`); the runtime's test-only cache getters and the write-only
`RuntimeGates.budgetStops` mirror; the `export` keyword on 123 declarations nothing imports, a duplicated pair of
delivery interfaces and a `CheckResult` alias; the arena helpers `liveCarrier` and `proposalAllowance`; three client
projection wrappers only tests called (a board lane now resolves with the roster, `a66f25c`); the web smoke's
`[data-swarm-dock]` assertion, which could not fail; three raw control bytes, one of which had disabled the
session-append guard's first alternative since `21976c1`. The restored guard now requires the host vocabulary
(`687927b`), and `recoveryRequired` reads only a row's `failureKind` (`5ed3061`).

**Worker adapter** (batch9/adapter; review M-7, M-8).

- Task records (M-7, `4c45ad2`). Wrong model: a cross-process `.lock` file, broken by its mtime after 30 s and
  polled every 5 ms, guarded a record only the owning process writes. Right model: an in-process keyed chain
  (`serialized` in `src/workspaces.ts`) orders every write of one record. Deleted: `withTaskRecordLock` with its lock
  file, staleness, polling and timeout, and the chain body `queueWorktree` duplicated.
- Verification checkouts (M-8, `4423b64`, `c972a3c`, `e31cca9`, `4e10ec4`, and the repairs `30266b4` and `8b97e07`).
  Wrong model: each verification removed only its own checkout, so one a crash (SIGKILL, OOM) left between
  `git worktree add` and that cleanup, tree and registration, was never removed; the first fix, like `75b765a`'s
  fallback and the worktree-add race retry, ran a repository-wide `git worktree prune`, which also drops the user's
  own worktrees whose directory is missing at that moment. Right model: one reclaim path, by path, and since
  `8b97e07` one method (`Workspaces.reclaim`), which the race retry and `cleanupVerification` both run in the
  repository's worktree queue. Every checkout under the mission's `verification/` that no in-flight verification of
  this process owns loses its tree first (a link is never followed), then the registration of the now missing path
  (`git worktree remove --force --force`); a tree that resists is thrown before git sees its path. Nothing prunes,
  and the race retry reclaims only its own target: when that target's tree resists, the add fails with the reclaim's
  own cause instead of git receiving a remove and a second add on a path whose tree still exists. Deleted: the
  per-checkout special cases, every prune, the plain `rm` before the permission repair, `recordCleanupIssue`, and
  the second copy of the reclaim (the retry's inline pair and `cleanupVerification`'s remove and reclaim closures)
  (`tests/workspaces.test.mjs`; `W4: the metadata-race retry reclaims only its own target …` and `W4: a raced target
  whose tree resists the reclaim fails the add and is never handed to git` in `tests/worktree-concurrency.test.mjs`).

**Trace spans** (batch9r2/trace; review M-3). Wrong model: `record()` validated each span at call time and threw
`TraceContractError`, and the wrapper awaited the span inside the `try` that held the command, so a failed span write
turned a committed command into a tool error, the `catch` wrote a second, false error span, and a throw from that
write replaced the command's own error (`missionId: ""` threw `mission_id is required`). Right model: each D6 clause
holds where its value is made: a span is scoped only to an existing mission, the actor is the id the session guard
requires, `endedAt` is `startedAt` plus a monotonic duration, and a stored parent is used only when its id is valid
(the malformed row stays in the metrics window). The wrapper settles the command once, records at most one span with
that outcome, and rethrows exactly the command's error; recording is contained and counted
(`HostTelemetryLink.contain`). Deleted: the per-call contract check and its throw, the double-span path, the second
wall-clock read, `hostTelemetryFor` and `noteUnscoped` (folded into `record`) (`tests/trace-recording.test.mjs`).

**Check failure exits** (batch9r2/exits and `27fa353`; review M-9). Wrong model: a failure's kind was decided twice,
where the row was produced and again in `recoveryRequired` by exit code (124, 126, 127); the exit-127 hint was prose
appended to the command's own output; `verify` gave one fixed deferral reason for every kind and
`reviewPathBlocker` held a paraphrase of it; the host deadline was stored as exit 124 and then recognised by that
code, so a command's own 124 deferred and told the owner to raise `checkTimeoutMs`. Right model: the kind is set once
where the row is produced (`timeout` only where the host deadline fires, `infrastructure` from the one
`unexecutedCheck` producer, `unrunnable` for 126/127), `recoveryRequired` reads only the kind, and one table
(`RECOVERY_EXITS`) gives each kind's exit, taken from the last classified failure of the deciding pass. Deleted: the
127 prose, the fixed deferral string and its paraphrase, the second unexecuted-check producer,
`DeclaredChecks.deferredChecks` and the exit-code proxy for the timeout kind (`tests/check-failure-exits.test.mjs`).
Case F of `tests/r19-recovery-fallback.test.mjs` now reads the cleanup fact through a wake-budget summary; that fold,
about one run in ten under load, was its intermittent failure (`f8f45c0`).

**Repairs after the gate.**

- `832b4a3`: the host admits a submission's automatic review once. Its id was keyed on the submission (since
  `dc5d0f6`, on the review need; see the second series below), so an existing row is that review and
  `task/review-admitted` means a pass created it; before, a review the fence had blocked was re-proposed and recorded
  on every pass (`A fenced review path records one automatic admission however many passes run`).
- `30266b4`: the worktree-add race retry reclaims its own target by path and no longer prunes (`W4` above); its
  inline reclaim became the one `Workspaces.reclaim` method in `8b97e07`.
- `b7f78f2`: `claimFor` replaces the three session-then-root sequences of `authorizeWorkspace`,
  `reauthorizeWorkspace` and `assertAuthorizedRoot`; `grantFor` and the unread `WorkspaceAuthorized.grant` are gone.
- `1912420`: the runtime re-validates before delivery inspection and application and before a draft launch's
  preflight (`Delivery inspection and application re-validate the workspace before the adapter reaches it`, `A draft
  launch re-validates its recorded claim before the preflight reaches the workspace`).
- `b9f16c6`: an accepting verdict closes every review of its source that is still blocked (fenced, out of recovery
  credit, or deferred on the same artifact) as `task/review-retired` with `previousStatus: "blocked"`, keeping its
  verdict, output and evidence; such a review used to hold completion. This closes the batch notes' open item that a
  review deferred on an artifact stayed blocked after a second review accepted the source (`An accepted source closes
  the reviews the fence blocked, so the restored mission completes`; `an accepting verdict closes a sibling review
  deferred on the same artifact` in `tests/durability-sibling-retirement.test.mjs`).
- `95318c0`: the revocation decision is keyed on the runtime instance that found it (one per Harness start or plugin
  reload); a mission-wide key stayed held after the root was restored, so a later revocation reached no one (`A
  revocation after the root was restored wakes the owner again`).

**Second repair series** (`dc5d0f6` to `0ff86e2`, 2026-09-25 to 2026-09-26).

- `dc5d0f6`: a challenge that re-opens an automatically reviewed source (accepted back to submitted, or a running
  automatic review invalidated on a submitted source) gets a fresh automatic review for the re-opened need, as a
  challenged source with a proposed review already did (R10-16). The id was keyed on the submission alone, so every
  later pass found the retired row under the same id and returned: at `95318c0` the source stayed submitted with no
  review and no owner notice; at `75b765a` the owner instead got a `review_path_missing` notice that blamed an owner
  cancel that never happened. An unchallenged submission keeps its id (`a challenge of an automatically reviewed
  source admits an automatic review for the re-opened need` in `tests/review-path.test.mjs`).
- `79910ee`: every entry point reads the grants from the runtime config (above). Plugin behaviour is unchanged,
  since `src/index.ts` already handed one snapshot to all four channels; the module API changed:
  `SwarmRuntime.start()` takes no argument, and `registerTools(ctx, runtime, defaultBudget)` and
  `registerWebApi(ctx, runtime, { defaultBudget, maxPayloadBytes })` take no grants. The updated tests (AC2, AC3,
  AC5, the binding-authorization test and the browser granted-drafts test) failed 5/70 against the previous `src` and
  pass after.
- `8b97e07`: one reclaim method for the race retry and `cleanupVerification` (M-8 above; `W4: a raced target whose
  tree resists the reclaim fails the add and is never handed to git`). The retry's target that resists is now the
  add's failure with its own cause; if the removal empties a target but cannot unlink the directory itself (a
  non-writable parent), the add fails with that cause where git used to add into the empty directory.
- `dff54b2`: every missing-review fact is keyed on the one review need (`SwarmRuntime.reviewNeed`). Its id keys the
  automatic review and the owner's blocker decision; the admission grace (the runtime's, the notices' legitimacy and
  ripeness checks and the scheduler's unreviewed-stall grace), the `task/review-missing` record and an owner
  withdrawal are dated from the newest row that opened it. Before, only the automatic review's id followed the need:
  a re-opened need found an earlier need's withdrawal and stayed silent until the absence net, a challenge of an old
  submission was admitted an automatic review at once (racing a review the owner proposed in the same turn), and a
  re-opened need recorded no missing review. A blocker decision is now one per (review need, reason), not per
  (source, reason), so a source blocked across the upgrade is told once more (`an automatic review the owner withdrew
  from an earlier need never blocks the need a challenge re-opens`, `a challenge re-opens the grace, so the owner's
  own review of the re-opened source is its only review`, `a re-opened need blocked for the reason an earlier need
  was blocked wakes the owner again` in `tests/rework-review.test.mjs`).
- `db41b05`: `RuntimeConfig.grants` is required (above). Production never took the two `grants === undefined`
  branches; they served unit fixtures, which now carry the empty snapshot (`NO_GRANTS` in `tests/faults/harness.mjs`,
  also the runtime stub's config) and real temporary workspaces, so a member start in a fixture re-validates on disk
  as it does in the plugin. The replay digest is unchanged.
- `86445d6` (tests only): fixtures that proposed, claimed or moved the fake clock right after an admission raced the
  pass that member start kicks; they now settle the mission or wait for the start first, and the fixed
  `delay(0)`/`delay(5)` waits are order-based waits.
- `0a4d167` (tests only): fault scenario F18 read the re-routed task in the poll that first saw `task/reassigned`.
  Since `db41b05` that dispatch awaits an on-disk re-validation, so the read saw `pending` in about half the runs on
  both hosts; the scenario now waits until the task is running (interleaved on 0.1.5-rc.3, the old scenario failed
  4/8 and the new one passed 8/8; 8/8 on 0.1.7-rc.1).
- `c65f7f1`: a review need re-opens only when a challenge takes a review away. `dc5d0f6` keyed the automatic review,
  and `dff54b2` every missing-review fact, on one token per challenge of the source's claims, and `dff54b2` dated the
  need from the newest `evidence/challenged` row, so
  each challenge of an unreviewed submission minted a new need (another identical owner decision and
  `task/review-missing` row, and a restarted grace), and a challenge while the automatic review was still pending
  moved the need off that live review, so a second automatic review was admitted if that one later blocked. The need
  is now the submission plus each review of it that a challenge retired (the `task/invalidated` row `challenge()`
  writes for the review that accepted the source or one running or blocked) newer than its `task/submitted` row, and
  it is dated from the newest such row; a challenge that retires no review (of an unreviewed submission, or one whose
  review is still pending) leaves the need as it was. An unchallenged submission's id is unchanged, and
  `SwarmStore.latestTaskEvent` is keyed by task id only again (`dff54b2` had replaced its unused `reviewOf` key with
  an `evidenceId` key only the challenge lookup used) (`a challenge that takes no review away leaves the review need
  as it was` in `tests/rework-review.test.mjs`).
- `0ff86e2`: a review-blocked decision has one emitter and one identity. The runtime's review admission keyed each
  decision on the review need, but the transition classifier emitted its own multi-subject review-blocked decision
  keyed on `subject@epoch`, and relevance and reminders judged either kind per source (submitted and unreviewable).
  A re-opened need therefore revived the previous need's decision beside the new one, and the owner was reminded of
  both. The classifier now names each unreviewable source through `notifyReviewBlocked` under its current need,
  `reviewBlockedKey` builds the key once, and `openReviewBlock` (the counterpart of `openStallRoot`) is the one test
  relevance and reminders use, so a re-opened need retires the old decision. The classifier's body now carries the
  `review_path_missing` code like every other review-blocked decision; the model-visible snapshot and the replay digest
  are unchanged (`a re-opened need blocked for the reason an earlier need was blocked wakes the owner again` now also
  pins that the earlier decision is irrelevant and never reminded; it fails before `0ff86e2`).

**Gate for the second series.**

- `8b97e07`, on 0.1.5-rc.3 only: `node --test` 1573/1573, `test:harness`, `test:replay` (digest unchanged), the
  fault suite 24/24, `test:web` (13 checks) and `test:command-web` (10 checks) passed.
- `86445d6`, on 0.1.5-rc.3: `node --test` 1576/1576 on a quiet host (earlier failures there were git deadlines under
  a load average near 270).
- The fault gate is not a valid record at `db41b05` or `86445d6`: F18 failed about half its runs on both hosts
  until `0a4d167`.
- `c65f7f1`, on 0.1.5-rc.3: typecheck, build, `test:harness`, `test:replay` (digest unchanged), the fault suite 24/24
  in two runs, `test:web` (13 checks) and `test:command-web` (10 checks) passed, and the 19 test files that reference
  the review need, `latestTaskEvent` or `challenge()` passed 273/273 (`tests/rework-review.test.mjs` also 20/20 in
  each of two concurrent copies over three rounds). On 0.1.7-rc.1 only typecheck, the fault suite (24/24 in two
  runs), F18 (8/8) and `tests/rework-review.test.mjs` with `tests/review-path.test.mjs` (29/29) ran.
- Final gate at `33ea76f` (after `0ff86e2`). On 0.1.7-rc.1: build, `node --test` 1577/1577, `test:harness`,
  `test:replay` (digest unchanged), `test:pack`, `test:profile`, `test:bundle`, the fault suite 24/24, `test:web`
  (13 checks) and `test:command-web` (10 checks) passed. On 0.1.5-rc.3 the same gates passed except `node --test`,
  which ran during a host load spike (57 minutes instead of about 3) and failed 16 of 1577 on time bounds (7 host git
  deadlines of 300 s, worker startup and stop deadlines, and lease expiries); the 13 files holding them passed
  157/157 when rerun on a quiet host. The integrator commits (`a65f837`, the resolutions in `bb242d9` and `cb331ca`,
  `27fa353`) were checked by the final skeptic round, which found no medium or high defect in them.

**What the review got wrong.** M-15 (a rejected native dispose leaks the worker handle, so stop and unload should
retry it) was implemented in `213e630` and reverted in `d36efd8`. On both supported hosts the handle's dispose is
memoized (`disposing ??= …` in `@deepseek-ai/dsh-agent-loop`) and runs registry, scope and ownership teardown to
quiescence before it rejects, so a rejected dispose has already released the handle and a retry re-awaits the same
rejection: with the retry, one failed close left the member unable to start again in that process and unload failing.
`c9d78d0` pins the host contract on the real AgentLoop with JSONL persistence; no `src` change remains for the item.
M-1 is left as is.

**Owner decisions.** M-9: a check that decides no verdict still defers its review (the deferral is kept, still with no
bound), and the deferral's exit is chosen by the failure's kind; a command's own exit 124 is its verdict and rejects the
source like exit 1.

**Kept limitations** (in [known-limitations.md](known-limitations.md)): deferred verification has no bound, and an
`infrastructure` failure the artifact caused reads as a host problem on every resume; the review-blocked notice
appends its fixed exit also under blockers where no verification task can be admitted or a review is deferred; a
contained span-recording failure is only counted in process; a registration git left locked without a recorded
`gitdir` cannot be reclaimed by path; a record without an authorization source is judged by the configured roots
alone; the `swarm_stage`/`swarm_create` binding and the browser's draft saves check grants on host time; submission
capture, a review's artifact inspection and capture, and a running attempt's checkpoints are not re-validated
themselves; a review of an accepted source that a challenge of the review's own prerequisite cancelled counts, once
the source itself is challenged, as the re-opening of its need, so that need has no admission grace.
`scripts/smoke-deepseek.mjs` was edited (the claim moved beside the input) and not run, because it needs provider
credentials. Known-limitations no longer lists checkout re-authorization and task-record lock staleness on host time,
the host-time grant check at `swarm_launch` and at a browser launch (the runtime now re-validates a draft launch on
its own clock, `1912420`), or case F among the timer-bound tests; it corrects the claim that the plugin writes nothing into a session log
(worker activations have appended the host's own `sandbox/mode` and `approval/policy` events since `becba81`).

| Check | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run build` at `27fa353` | passed | passed |
| `node --test tests/*.test.mjs` at `27fa353` | 1554/1564; the 10 failures are all in `tests/trace-recording.test.mjs` | 1554/1564; the same 10 |
| `tests/trace-recording.test.mjs` at `19dbc30` | 11/11, three runs | 11/11, one run |
| `npm run test:harness` | passed | passed |
| `npm run test:replay` | passed, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` unchanged | passed, digest unchanged |
| `npm run test:pack` / `test:profile` / `test:bundle` | passed / passed / passed | passed / passed / passed |
| `node scripts/faults/run.mjs` | 24/24 | 24/24 |
| `npm run test:web` | passed, 13 checks | passed, 13 checks |
| `npm run test:command-web` | passed, 10 checks | passed, 10 checks |

With this entry's documentation on `95318c0`, the four test files that read the docs
(`tests/authorized-workspace.test.mjs`, `tests/client-event-projection.test.mjs`, `tests/packaging.test.mjs`,
`tests/reader-census.test.mjs`) passed 47/47 with the plugin linked to 0.1.5-rc.3, and again 47/47 with the second
series' documentation on `c65f7f1`.

## Batch-8 fix: boundary compaction reaches the member's preset realm (2026-09-24)

Boundary compaction (`boundaryCompactionTokens`, default 250000) was on by default but never ran. The batch-8 measurement found 288 recorded (member, verdict) boundaries whose last prompt was at or above 250K, and no boundary compaction. The only two member compactions were the preset engine's own pressure path at about 800K (0.8 of the 1M window).

**Root cause.** The adapter resolved the engine with `ctx.get('compaction')` from the plugin's context.
- That call needs no `inject` entry. Cordis `ReflectService.get` returns any active implementation stored under the caller's isolation key. With `compaction-basic` on the host plane it did find the engine: a probe at `73cf4fb` compacted on both hosts.
- The web profile disables the host-plane rows (`compaction-basic`, `command-compact` and `tool-result-pruner` are `disabled: true` in `packages/bundle/web-app/cordis.patch.yml`). Each agent preset mounts them in a `cordis:group` with `isolate: { compaction: true, toolResultPruner: true }`.
- The realm therefore has its own key. The plugin's lookup returned nothing, and `compactIfRequested` cleared the request without a log line.
- The layout is the same on every host the recorded roots ran on (`0.1.3-alpha.2` for v41, `0.1.5-rc.1` for 5198/5199, `0.1.6-alpha.2` for 5202) and on both supported releases:
  - 0.1.5-rc.3: web-app patch line 427, and `agent-presets/presets/standard/agent.cordis.yml` lines 138-146.
  - 0.1.7-rc.1: web-app patch line 488, and `web-app/presets/standard.patch.yml` lines 63-71.
- Read-only session logs agree:
  - In v41 member `0629119e` (mission `85262933`), a `swarm_verify` at a 313,277-token prompt was followed by `swarm_wait`, a `blocked` turn end and 7.7 minutes idle, with no compaction. The session's only compaction came at 792,439 tokens, from the preset's pressure path.
  - In the 5198/5199/5202 roots, 8 reviewer verdicts were at or above 250K. All reached an idle turn end, and none compacted.

The other candidates:
- `lastPromptTokens` was not the cause. It is updated from every `assistant/message` usage, and the DeepSeek adapter reports `inputTokens` net of cache hits, so input plus cache read is the whole prompt.
- The request did survive a busy member and was retried at the next idle. However, the idle handler first re-woke input queued behind a rejected step, so that unit ran on the full history.
- The summary request's usage (`compaction/summary`) was never charged to the member, although known-limitations said it was.

**Fix.**
- The adapter reaches the member's own engine through the `/compact` command that the member's composition resolves (`commands.find(agent, 'compact')`). It falls back to a host-plane `compaction` service, and warns once when there is neither.
- The idle handler now compacts before it re-wakes a rejected step's queued input. That input then waits behind the engine's `runMaintenance`.
- `compaction/summary` usage is charged like a model response, both live and when a session is restored.

**Regression.**
- `tests/harness-boundary-compaction.mjs` is now part of `test:harness`, and `test:pack` also runs it against the packed artifact.
  - It is a real Loader composition: `commands` and `tokenMeter` on the host plane, plus the preset's realm (the same group and `isolate` map). It sets `boundaryCompactionTokens: 1000` and scripts prompts of 1,500 tokens.
  - The builder is idle at its verdict and compacts at once. The reviewer is inside `swarm_verify` and compacts at the idle after that turn.
  - For each member it checks: exactly one `compaction/start`/`summary`/`end` after the verdict and before the next assignment reaches the model; no open turn; no command id.
  - It also checks that the next request has fewer messages and characters and carries the `<compacted-summary>` checkpoint, and that the stored usage equals every scripted request, the summary included.
- A unit test in `tests/roles.test.mjs` covers the retry at the next idle. A member parks itself inside a held tool while next-turn input is queued, and must compact while idle before that input's unit runs.
- At `73cf4fb`'s adapter:
  - The Loader test times out waiting for any compaction on both hosts.
  - The unit test records `next-unit-request` before the compaction.
  - With only the accounting change reverted, the Loader test fails at the usage check.

**Checks.** Each supported host was checked with its `nm-015rc3` or `nm-017rc1` link farm and `DSH_HARNESS_ROOT` at the matching clone:
- `typecheck` and `build` clean.
- Ten adapter test files (roles, harness-workers, activity, r12-native-start-fixes, r19-recovery-fallback, rule-owner-channel, harness-owner-notices, owner-decisions, scheduling-pass, operation-bound): 155/155.
- `test:harness` passed, smoke snapshot unchanged.
- `test:pack` passed: 239 archive entries, both compositions on the packed artifact.
- `test:profile` passed. `test:bundle` 7/7.
- Fault suite 24/24.
- `test:replay` ran once, on 0.1.5-rc.3: digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e`, unchanged.

**Expected effect, not yet measured live.**
- The worktree measurement attributes 414.1M accounted tokens (4,085M raw, almost all cache reads) of 800.7M member tokens to context carried into later tasks. The median carried context at a later task's start is 306,666 tokens (p10 130K, p90 600K).
- The report's cap model (carried context at most 250K) removes about 137M accounted. That moves one-member-per-task's remaining saving from −40.7..−50.4% to −23.6..−33.2% of member tokens at the budget rule, and to +4.5..−13.8% at list price.
- This is a lower bound for boundaries above 250K, because a compacted member starts its next unit from the summary plus the last retained node, not from 250K. Carried context under 250K is untouched.
- Each compaction costs one summary request that replays the old prompt, mostly as cache hits: about 30-65K accounted at 250-600K prompts. If all 288 boundaries had compacted, that would be at most about 9-19M.
- Measuring the effect needs a new mission on a host with this build.

## Round-28 host versions: 0.1.5-rc.3 and 0.1.7-rc.1 only (2026-09-24)

**Final gate at 06bc7c4 (after the batch-8 adversarial fixes).** On 0.1.5-rc.3: `typecheck` and `build` clean,
1509 of 1509 behavioral tests, `test:replay` (digest unchanged), `test:harness` (the composition and the new
boundary-compaction composition), `test:pack` (248 files), `test:profile`, `test:bundle` 7/7, `test:faults` 24/24,
`test:web`, `test:command-web` and `test:load` passed. On 0.1.7-rc.1: the same gates passed (`test:pack` 242 files),
and the behavioral suite ran 1508 of 1509; the one failure was R15-D2, the documented timing-bound hung-stop test.
The batch-8 adversarial verification also corrected the worktree measurement (the saving it reported holds only at
the swarm's budget weights, not at DeepSeek list prices) and found boundary compaction had never run; see the
boundary-compaction entry above.

The plugin now supports exactly two Harness releases, `0.1.5-rc.3` (npm `latest`, the default host) and
`0.1.7-rc.1` (npm `next`); `0.1.2-rc.1`, `0.1.3-alpha.2`, `0.1.5-rc.1` and `0.1.6-alpha.2` are dropped.

**Hosts.** Two fresh clones of `github.com/deepseek-ai/deepseek-harness`, checked out at `dsh-v0.1.5-rc.3`
(`a4c74a91e0`) and `dsh-v0.1.7-rc.1` (`46a7f68b09`), built the way the earlier checkouts were: pnpm 11.7.0,
Node 22.22.3, `pnpm install --frozen-lockfile` then `pnpm run build` (native system addon, `build:lib` host and
client, `build:web`, client build record). 0.1.5-rc.3: install 128 s, build 406 s (234 client artifacts).
0.1.7-rc.1: install 23 s (warm store), build 330 s (263 client artifacts), partly concurrent with the 0.1.5-rc.3
gates. Each gate ran with `DSH_HARNESS_ROOT` at one clone and the plugin's own SDK links (`npm run link:dsh`)
pointing at the same clone, so the plugin's imports and the Loader's host packages come from one release.

**What each host needed.**

- 0.1.5-rc.3 needed no product change: typecheck, build and every gate except `test:web` passed at `fa6a507`
  with only the compatibility metadata of `a4798c1` applied.
- `test:web` failed on both hosts at `[data-swarm-launcher]`. With `DSH_HARNESS_ROOT` unset the web smokes had
  resolved `~/.dsh/source/current`, a 0.1.2-rc.1 checkout on the development host, and were written against the
  plugin's standalone dock, which renders only where the host has no right sidebar. Both supported hosts carry
  the panel as a native right-sidebar tab. `test:web` and `test:command-web` now open it through the native footer
  launcher, check that it sits beside the conversation without covering the composer, collapse it through the
  host's own control and reopen it (unsaved plan edits survive), keep it inside a 390px viewport, and open a
  worker conversation's own tab from the launcher (the right sidebar is per conversation).
- 0.1.7-rc.1 failed typecheck with six errors at four sites, and the Loader composition could not read tool results. The
  `agentPresets` service moved from `dsh-agent-presets` (not published at 0.1.7) to `dsh-agent-preset-registry`
  with the same `composedPreset`/`mount` methods: the adapter declares it structurally and the peer is dropped.
  The regenerated runtime context is a `runtime-context` message source (the shared `plugin` kind is gone): the
  owner delivery filter accepts both shapes. `ConnectionRpcHandler` gained a `peer` argument: the web routes
  type their own handler. Tool results are `role: 'tool'` messages carrying `isError`: the swarm card and the
  worker transcript read that flag too, and the test fixtures read either shape through `toolResultBlocks`.
  The bundle test accepts 0.1.7's `patchPaths` list and mount-relative plugin URL, and the command test bench
  offers 0.1.7's `sessions.binding`/`sessions.using`.

**Deleted as serving only the dropped releases.** The standalone dock (`SidebarDock.tsx`, its `shell.overlay`
seat, the open-monitor event, the panel's Collapse button, its CSS and strings), the setup hook's
`agentCtx.agent` fallback, the empty `deployment:persona` section, the persistence `list` fallback, and the
test-side `options.system` carrier and pre-handle storage helpers. Net: client −125 lines, runtime −18, tests −38;
the earlier estimate of about 400 lines of client compatibility code did not hold. The 0.1.6 behaviour that
0.1.7 keeps (the retained `mainView` session, `uiWorkspace.openSession`, the asynchronous sandbox `confine`, the
right-sidebar guide entry id) stays beside the 0.1.5 path. The default Harness selection skips an unsupported
`~/.dsh/source/current` and tries `deepseek-harness-015rc3` and `deepseek-harness-017rc1` beside the checkout.

**Host defect, not patched here.** The `ui-conversation` claim-token loop is unchanged in both releases (and was
in 0.1.6-alpha.2): `claim-decor.ts` splits the styled `/command ` token with `splitText`, the overflow keeps the
token style, Lexical merges the identically styled siblings, and the transform never settles. With Lexical 0.49.0
headless, registering the decoration for `/agent-swarm `, creating that text node and appending `全` to it throws
`One or more transforms are endlessly triggering additional transforms` on 0.1.5-rc.3, 0.1.6-alpha.2 and
0.1.7-rc.1; clearing the overflow style after the split (the shipped `patches/harness-command-input.patch`,
retargeted from 0.1.5-rc.1) stops it on all three, and `scripts/check-harness-command-input.mjs` passes 5/5 on
both supported clones. Both browser command smokes pass without it.

| Check | 0.1.5-rc.3 (`a4c74a91e0`) | 0.1.7-rc.1 (`46a7f68b09`) |
| --- | --- | --- |
| `npm run typecheck` / `npm run build` | passed / passed | passed / passed |
| `node --test tests/*.test.mjs` | 1491/1491 (183 s) | 1491/1491 (292 s); the first run failed the three command-bench tests fixed in `962ab92` |
| `npm run test:harness` | passed | passed |
| `npm run test:pack` | passed (239 published files) | passed (239 published files) |
| `npm run test:profile` | passed | passed |
| `npm run test:bundle` | 7/7 | 7/7 |
| `node scripts/faults/run.mjs` (F3a-c boot the real Loader) | 24/24 | 24/24 |
| `npm run test:web` | passed, 13 checks (host on 127.0.0.1:64131) | passed, 13 checks (127.0.0.1:52831) |
| `npm run test:command-web` | passed, 10 checks (127.0.0.1:64333) | passed, 10 checks (127.0.0.1:53197) |

Both web smokes start their own temporary host on a port the OS assigns (`--port 0`); none used 5192-5202. A
smoke process can stay alive after `passed` while Chrome shuts down; the result is `passed` in its `report.json`.
Not exercised: a real-provider mission (`test:deepseek`, `test:command-deepseek`), `test:load`, `test:replay` and
the attended preview.

**Items the known-limitations rewrite dropped as resolved.** `docs/known-limitations.md` was reorganised by gap
(`c0523a8`) and now states only what is true of the current tree. These four statements it dropped as resolved had
no record in this file; each is resolved in the tree at `73cf4fb`:

- R17-G13, no checkpoint for a ceiling-blocked attempt: `blockTaskCeiling` (`src/runtime.ts`) installs a `resource`
  stop marker, and the stop barrier (`Attempts.resumeStoppedAttempt`) calls `workers.checkpointTask` once the stop is
  confirmed.
- `swarm_escalate` checked a supplied `taskId` only together with an `attemptId` (round 11, T1bv):
  `SwarmRuntime.escalate` now refuses a `taskId` whose attempt owner, or else assignee, is not the caller.
- The attempt-closer set duplicated between the scheduling code and `src/trace.ts` (round-17 hand-off): `trace.ts`
  builds its closer set from `ATTEMPT_FENCING_EVENTS` in `src/types.ts`.
- The residual member-status writers in `src/attempts.ts` and `src/gates.ts` (round-17 hand-off): no `src/` code
  assigns a member's `status`; it is derived from the phase on every read, and the store strips it on write.

## Round-27 simplification batch 7: rework in place, whole-lineage retirement, host-added reviews (2026-09-24)

- **Rework in place.** `swarm_control` `action: "resume"` on a task its own independent review rejected
  re-opens it: the rejection (commit, epoch, review, reason, refuted claims) moves into `task.rejections[]`,
  the artifact is released, the epoch bumps, the author stays pinned and resumes from the rejected commit,
  and the review that rejected it is re-pended with the same reviewer and a fresh allowance, its own
  verdict and claims archived; every other open review of the source is retired. `maxRework` (default 2)
  bounds it (`[task_rework_exhausted]`). Archived claims are refused by `swarm_challenge`
  (`[evidence_archived]`) and ignored by completion; a verdict never re-verifies or re-refutes a refuted
  claim; a same-commit resubmission without a new claim is refused (`[rework_unchanged]`). A dependent
  admitted before the rejection is prepared with the reworked artifact, with no replacement row.
- **Whole-lineage retirement.** Accepting a replacement retires every blocked or pending task of its
  `replaces` lineage and their reviews (`task/superseded`); `[task_replaced]` is transitive, re-pend
  paths skip replaced rows, a live duplicate carrier from an older store is named
  (`task/duplicate-carrier`), and host recovery replays the retirement once, before re-pending, only for
  acceptances made before the rule.
- **Host-added reviews and one independence rule.** `pairReviews` adds one unassigned independent review to
  every unpaired deliverable at launch, draft save and legacy draft listing, with an optional nested
  `review` override; `canOwnReview`, `authorIdsOf` and `strandedReview` decide independence on every
  assignment path, including claim, dispatch and reroute of an unassigned source; a review counts as a live
  review path only when a live member may own it. `OWNER_PROMPT` is 44 characters shorter.

The first adversarial pass found two high-severity defects (a challenge of an archived claim blocked
completion forever; the restart replay retired work the verdict had deliberately left running) and medium
ones: resubmissions that got no review or a false "withdrawn" notice, a deferred review left blocked, a
two-member rework rerouted to its only reviewer, a non-transitive `task_replaced` guard, a silent duplicate
implementation, and review-path relevance blind to independence. The fix re-opens the rejecting review
with the task instead of minting a new one. A narrower second pass confirmed every fix and found the
re-opened review keeping its previous round's consumption, an owner withdrawal of it not honoured, and
unassigned sources still reachable by their bound reviewer; all are fixed with regressions.

- `npm run typecheck` and `npm run build`: passed.
- Full behavioral suite: 1490 tests at cf86cb7, 1489 passed. The one failure, `F. a verification checkout that cannot be removed ...` in `tests/r19-recovery-fallback.test.mjs`, is an intermittent real-time test seen since round 21; it passed 4 of 4 runs in isolation.
- `npm run test:replay` (digest unchanged), `test:bundle`, `test:harness` (smoke snapshot unchanged),
  `test:pack`, `test:profile`, `test:faults` (24 of 24) and `test:web`: passed.

## Round-26 simplification batch 6, wave B: one test fixture, a required adapter, structural notice checks (2026-09-24)

- **One shared runtime test fixture.** `tests/faults/harness.mjs` exports `FakeWorkers(overrides)` (every
  required adapter method, behaviour-neutral, with per-member `reportActivity(id, activity)`; it omits
  `prepareBaseline` and `checkEnvelope` on purpose), `makeRuntime(t, { config, budget, workers, clock,
  storeOptions })` (no mission, member or event of its own), `makeWorkspaces(dir, overrides)`,
  `makeRuntimeStub(overrides)` and one `eventually`. About 140 test files and the load and replay scripts
  now build their runtimes, adapters, workspaces and partial runtimes through it; the tests lost about
  1,250 lines net, and every migrated poller keeps the bound its local poller had.
- **The worker adapter interface is required.** `currentActivity`, `compactAtBoundary`,
  `invalidateComposition`, `checkSyntaxPreflight`, `checkpointTask`, `inspectArtifact`, `inspectDelivery`
  and `applyDelivery` are required and their runtime fallbacks are deleted; `prepareBaseline` and
  `checkEnvelope` stay optional because their absence suppresses `workspace/snapshot` and
  `task/check-envelope`. No partial adapter stub remains in `tests/` or `scripts/`.
- **Notice checks pin structure and anchors, not prose.** Every reviewed owner notice is rendered by
  `renderNotice`, which records the statement (the rendering family and the counts the body states) from
  the same input the body is built from. `tests/r17-notices.test.mjs` checks the statement, subjects and
  reason against the durable rows, rebuilds each body through its template from those rows, checks the
  stated counts in the text and a per-family table of tool and exit anchors. The model-visible snapshot
  holds `<ASSIGNMENT_INSTRUCTIONS>`, which the harness test substitutes from the `ASSIGNMENT_INSTRUCTIONS`
  export after checking that it is nonempty and keeps its invariant sentences (peers cannot grant
  authority; never `git add`/`commit`; capture through `swarm_submit`; cite host run ids); each recorded
  delivery names its recipient role. Rewording the instruction needs no fixture refresh.
- **The scheduling tests are deterministic.** Every test in `tests/scheduling-pass.test.mjs` and
  `tests/stall-roots.test.mjs` runs on the fake clock with hand-driven ticks except one, and a fake-clock
  adapter await moves the clock one tick unit at a time with the timer's tick at each step, so the watchdog
  acts during a body as in production. Both files pass three rounds of four concurrent copies at load
  averages up to 155.

The adversarial verification of this wave found that the first structural notice tests missed 19 body
defects the prose replays caught (the statement was a literal separate from the rendered input), that an
empty or authority-free assignment instruction passed the snapshot, that one migration chunk had widened
its pollers from 2.5-5 s to 8 s so a delayed-transition mutant passed, that the fake-clock adapter waits ran
no tick so two watchdog mutants passed, and that the shared `FakeWorkers` reported one member's activity
for every member. Each is fixed and shown with its mutant; all 43 notice mutants now fail a test.

- `npm run typecheck` and `npm run build`: passed.
- Full behavioral suite: 1410 tests at 9d2b135, 1409 passed. The one failure was R15-D2 in `tests/owner-decisions.test.mjs`, the documented timing-bound hung-worker case, which is not yet on the fake clock; it passed 4 of 4 runs in isolation. An earlier run at 73d6c90 failed two scheduling tests under load that were still on real time; both now run on the fake clock.
- `npm run test:replay` (digest unchanged, 39 events / 13 spans / 6 commands), `test:bundle`,
  `test:harness` (the snapshot changed once, to record recipient roles and the instruction placeholder),
  `test:pack`, `test:profile`, `test:faults` (24 of 24), `test:web` and `test:load`: passed.

## Round-26 simplification batch 6, wave A: fault suite, runtime clock, web smokes and host scripts (2026-09-24)

- **The fault suite passes again: 24 of 24**, in a worktree and from a `git archive` export, where it was
  17 of 24 on main and 15 of 24 on the round-19 main. Every failure was a stale fixture, bisected to the
  commit that changed the behaviour on purpose: F1, F14 and F18 to 69211b9 (a pause re-pends only after the
  stop barrier; a denied git write is a delivered typed error; a start failure spends no task credit),
  F3a-c and F4 to 8b16913 (their `checks: ['true']` became `[check_noop]`), and F3c's stray key to 00e0e55.
  F4 now runs `scripts/round.mjs promote` from a scratch git repository with every local module it
  imports, so it no longer needs this tree to be a git checkout.
- **A runtime clock and an awaitable pass for tests.** `RuntimeConfig.now` (a function; never taken from
  profile config) is read for leases, pass bounds, back-offs, silence, stall and wedge ages, wake budgets,
  follow-up timing, event `createdAt`, the owner turn boundary, the grant-expiry fence and the task-ceiling
  stamp. `manualTick: true` installs no tick timer while `tickMs` stays the unit of every tick-derived
  window; a test drives `await runtime.tick()` and `await runtime.settle(missionId)` and moves time with
  `FakeClock.advance(ms)` (`setup({ clock })` in `tests/faults/harness.mjs`). Every scheduling-pass and
  stall-roots test runs on it without sleeps or polling, except the stall-roots summarized-root test (wave B).
- **Start failures are bounded and named.** When no live member can start a task because every capable
  route was retired for start failures, the owner gets one notice naming the task, each retired member's
  consecutive failures and last error, and the exits. During a recorded provider outage a member is probed
  once per outage window instead of every tick, and the owner is told once per outage.
- **The typed git-denial error reaches the worker before its next model step**: the runtime delivers it
  into the worker's inbox before the failed tool result returns.
- **The browser smokes run through one `runWebSmoke`** with one scripted model; `npm run test:web` passes
  again (its roster selectors had gone stale in a7547ae; the client was correct).
- **The preview and lab host is identified by its port and its command line.** `scripts/host.mjs` finds
  the listener on `127.0.0.1:<port>`, accepts it only when its command line is the dsh web host these
  scripts launch for that root, and re-reads it before every signal; `update-preview` boots the Harness the
  running host was launched from unless `--harness` is given, and records a failed restart as failed.

The adversarial verification of this wave found that stopping a host signalled whatever listened on the
port, including another program or another root's host (high), that the recorded Harness could restart a
hand-started host onto a stale checkout, that a profile key `now` crashed the runtime, that a task whose
every route failed to start stayed pending with a stall notice reading "Unschedulable: none" and no bound
under a provider outage, and that the rebuilt F1, F14 and F18 assertions could not fail. Each is fixed with
a regression that fails before it; F1, F14 and F18 were mutation-tested.

- `npm run typecheck` and `npm run build`: passed.
- Full behavioral suite: 1408 tests at e6daa64, all passed. An earlier run at f49b545 found eleven R12 tests whose hand-built partial runtimes lacked the new clock; they were given one (9bf2e50).
- `npm run test:replay` (digest unchanged), `test:bundle`, `test:harness` (smoke snapshot unchanged
  under `UPDATE_SMOKE_SNAPSHOT=1`), `test:pack` and `test:profile`: passed.
- `npm run test:faults`: 24 of 24. `npm run test:web`: passed.

## Round-25 simplification batch 5: one owner per notice and scheduling rule (2026-09-24)

Batch 5 removed duplicated owner-notice and scheduling machinery and added one schema check for every
swarm tool call. It was verified adversarially three times: the second and third passes reviewed the
fixes to the pass before, because those fixes added mechanisms of their own.

- **The owner false-wake rule has one enforcement point.** `ownerDeliveryRelevant` judges a notice at
  delivery and at native consumption. The emission-time refusal in `Notices.notify()`,
  `liveLineageSubject`, the host pre-append invariant (`src/invariant.ts`), the harness append-refusal
  catch and `tests/r17-invariant.test.mjs` are deleted. A real rejection used to write about 280
  `mission/stalled{cause:'stall-root'}` events in 1.5 s and deliver none; the event is now written only
  with its delivery row, and a stall root is judged, delivered and reminded on the root its key names.
- **Notice dedup reads the durable ledger.** The in-memory `parkedNotices`, `integrationGapWarned` and
  `reviewPathNotices` Sets are deleted; a restart no longer writes a duplicate `task/review-blocked` event.
- **A rejection is one wake unless it strands other work.** Owner notices delivered per rejection went
  from 3 to 2: the stall root is recorded against the verify-site rejection decision's own row (`coveredBy`)
  when it names no dependent beyond its rejecting review, and then has no reminders or ledger entry of its
  own. A decision carried by a wake-budget summary covers nothing, and each fact in a summary has its own
  reminder allowance. A rejected root that strands other work is still delivered, naming those dependents.
  A rejecting review is not named on its own while its source has a live replacement or is itself a stall
  root.
- **A preparation back-off is a bounded wait.** A pending task whose transient preparation failure carries
  `retryAt` waits legitimately until one tick past it, and its expiry bypasses the witness dedup once.
- **Dispatch no longer reads task prose.** The dispatch-time `dependencyAssumptions` filter, its
  `dispatchQuestion` branch, `assumedContent` and the `admission` guard-terminal chain are deleted (eight
  chains become seven). `swarm_control` refuses a `changes.dependencies` amendment that leaves an assumed
  dependency uncarried; the hex-token diagnostic no longer claims unchecked provenance. A restart-time hold
  for rows written by earlier builds was tried and removed: none of 1,029 task rows in 17 real profile
  stores would have been held, and it cost two to three owner wakes per held task.
- **Every swarm tool call is checked against its own published schema.** `register()` checks required
  properties, enums, primitive types, `oneOf` and `additionalProperties: false` before anything runs and
  refuses with one typed `[tool_arguments_invalid]`. JSON null on an optional property is an omission;
  `swarm_control` `changes.assigneeId` is published as string-or-null. Three required lists were made
  truthful (`swarm_submit.deliverables`; `swarm_propose.outputs`, required unless `replaces`;
  `swarm_launch` `tasks[].assigneeKey`). Measured against 12,761 recorded real swarm tool calls: 18% of the
  recorded `swarm_launch` calls carried a top-level `workspace` the tool always overwrote, which is now
  declared and ignored; 28 other calls carried an undeclared key that was silently dropped and is now
  refused by name. The runtime API and browser RPC keep their own checks (evidence outcome, post and board
  kind, proposal priority and experiment, empty member ids), `swarm_budget` forwards only its ceiling keys,
  and an amendment that changes nothing is refused with `[task_amendment_empty]`.
- **The scheduling pass guard lives on the mission queue.** The durable `passes` row, the released-run
  fence and the supersede release are deleted. `Scheduling.passes` holds the one body queued or running per
  mission; `kick` skips while it exists. The watchdog names a body past `stallPassTimeoutMs` once per body
  and retries until the naming commits (a busy writer, a paused mission); a body that wedges on a board an
  earlier naming left unchanged is named again only when that naming reached the owner, so under a recorded
  provider outage the renaming stops at the first repeat. Nothing is released: the body
  keeps the mission until the await it is in returns at that await's own bound. The body stamps its own
  progress when its awaits return, and a call that commits before its promise settles (a worker start, an
  outbox delivery, the workspace check, a recovery-fallback report) stamps it first (an AsyncLocalStorage
  version leaked into worker turns the body woke and was replaced), so its own commits never publish as a
  wedged pass. A body stops at the next member boundary when the member it just swept held it for a whole
  bound, and a chain of such stops covers at most one member rotation.
  The wedge notice no longer says the guard was released (a model-visible text change).
- **Fault fixtures.** F19 (rows 7b and 9b, stale since 69211b9) and F21 (stale since 20fc1a5 and 69211b9)
  were rebuilt, with new rows 7c and 7d and invariants I5 and I6.

The first adversarial pass found a wedge naming that was attempted once and lost for good (high), a
back-off hidden by a witness stamped during it, stall-root reminders while the repair ran, nulls refused
on optional fields, runtime API calls that lost their vocabulary checks, prose-assuming rows from the
previous build dispatched without escalation, a false dispatch question from a named body's own commits,
and lease recovery delayed by the sum of every member's slow awaits. The second pass, over the fixes,
found the AsyncLocalStorage leak (a wedged body published as live, silencing the owner), covered stall
roots that hid the dependents a rejection strands, the restart hold's extra wakes and release paths, the
`workspace` refusals and an unbounded chain of early-stopped bodies. The third pass confirmed every second-pass fix and found a body's own start failures, deliveries and recovery reports published against a stale progress stamp (a false dispatch question), an early-stop test that counted any idle time as waiting, endless renaming of wedged bodies under a recorded provider outage with the owner claimed notified of suppressed notices, a stall root whose summarized rejection decision spent its reminders on unrelated facts, and a back-off re-stamp that hid a bound passing during the judging pass. A fourth, narrow round fixed those; its elapsed-time early stop halved the sweep rate of quick members, so the final rule stops a body only after one member held it for a whole bound. Every fix has a
regression that fails before it.

- `npm run typecheck` and `npm run build`: passed.
- Full behavioral suite: 1378 tests at 4572a56, all passed. Earlier runs of the same batch found a Scheduling constructor that subscribed to a runtime it was not given (four failures in `tests/r12-workspace-fixes.test.mjs`) and a new early-stop test too tight for suite load; both were fixed before this run.
- `npm run test:replay` (digest unchanged), `test:bundle`, `test:harness` (smoke snapshot unchanged
  under `UPDATE_SMOKE_SNAPSHOT=1`), `test:pack` and `test:profile`: passed.
- `npm run test:faults`: 17 of 24 pass. F19 and F21 now pass; F1, F3a-c, F4, F14 and F18 fail as they
  did on the round-19 main.

## Round-24 simplification batch 4: declared outputs only (2026-09-23)

The write-verb heuristic that guessed a task's output paths from its prose, patched in rounds 4
through 19 and rewritten three times in round 19 alone, is deleted. A live mission on 2026-09-23
showed the planner declares `outputs` correctly: the implementation task declared
`["docs/summary.md"]`, the review declared `[]`, and the artifact carried exactly that file.

- **Capture, gates and preservation read the declaration.** `captureArtifact` force-captures every
  declared output, ignored or not, under its on-disk spelling, and checks that spelling against the
  scope before anything is committed. A declared output that is not a regular file at `swarm_submit`
  or `swarm_verify` is refused with `[output_missing]` while the attempt stays running, and the text
  names each cause: not written, deleted or renamed by the task (escalate, do not recreate), symlink or
  symlinked parent, directory, special file. Checkpoints capture declared outputs already written and
  skip owed ones. Handoff preservation carries exactly the declared outputs under their stored spelling
  and fails the snapshot if one is not recorded. A recovered checkout untracks every ignored path added
  since the task base that is not a declared output, which covers snapshots written by earlier builds.
- **Typed capture refusals.** `[output_case_mismatch]` (the stored spelling fails the path checks:
  rename it), `[output_path_refused]` (a declared output is outside the current scope or under a
  dependency or scratch directory: escalate so the owner amends `outputs` or `scope`) and
  `[artifact_path_outside_scope]` (a stray file: remove or move it and retry) replace untyped errors.
  A capture that fails after its commit resets the member HEAD and restores the saved index.
- **Every task declares outputs.** `swarm_propose` refuses a task without `outputs` unless it is a
  repair, which inherits the union of every replaced task's outputs and names them in the result;
  explicit outputs on a repair replace the inherited list. Plan launch refuses all undeclared tasks with
  one `[outputs_required]` refusal naming every location. The draft editor keeps an untouched field
  undeclared. An owner scope amendment that would leave declared outputs outside the scope is refused.
  Admission checks outputs against the host's configured `verificationDependencyDirs`, the set capture
  uses. The Harness does not enforce a tool schema's required list, so these checks live in the runtime.
- **The outputs text says what an output is:** a file the task leaves in place, never a path it removes
  or renames away (a delete-only task declares `[]`), a directory, a symlink or a file a check
  generates; submission checks existence only.
- **Deleted:** `writeDirectivePaths`, `deliverablePaths`, `ignoredDeliverablePaths` and its synchronous
  `git check-ignore`, `reconcileObjectiveScope`, `reconcileDeliverableIgnores`, the hint-based
  `untrackPreservedHints`, `Artifact.uncapturedPaths`, both `[deliverable_uncaptured]` gates,
  `[deliverable_gate_unavailable]`, the prose-derived draft advisories and the round-19 heuristic tests,
  replaced by exact-rule tests in `tests/r24-declared-outputs-capture.test.mjs`.

The adversarial verification of this batch found two high-severity defects, both fixed before merge:
on a case-insensitive filesystem a declared output whose directory case differed was committed and
then refused, leaving the member worktree wedged on a bad commit; and a preservation snapshot written
before the upgrade could carry a member-created `.env` that the recovered checkout then tracked and the
next capture committed (a cross-version probe recovered an e92ce4c snapshot with the fixed build: the
artifact no longer carries `.env`). It also found a scope amendment that stranded declared outputs,
delete and rename tasks that could never satisfy their declaration, repairs that inherited only the
first replaced task's outputs, a propose path that stored undeclared tasks, an editor save that declared
every untouched task analysis-only, and admission and capture using different dependency directories;
each has a regression that fails on 041e223.

- `npm run typecheck` and `npm run build`: passed.
- Full behavioral suite: 1346 tests at d5c22ec, 1345 passed; the one failure was a new capture test whose setup (an owner scope amendment stranding a declared output) the new amendment check refuses. It now asserts that refusal and reaches the state through a stored row (ffdb7b3); `tests/r24-declared-outputs-capture.test.mjs` and `tests/r20-declared-outputs.test.mjs` then pass 37/37.
- `npm run test:replay` (digest unchanged), `test:bundle`, `test:harness` (smoke snapshot unchanged
  under `UPDATE_SMOKE_SNAPSHOT=1`), `test:pack` and `test:profile`: passed.
- `npm run test:faults`: 15 of 24 pass. The nine failures (F1, F3a-c, F4, F14, F18, F19, F21) are the
  same set, with the same errors, on the round-19 main 98c6657, so they predate this programme; F3a-c
  fail on `[check_noop]` before any outputs check. The fault suite is not part of the recorded gate.

## Round-23 simplification batch 3: declarations and correctness (2026-09-23)

- **A host that cannot prepare a check defers the review.** A failed `git worktree add`, a dependency copy
  error with any code or none, a failed checkout directory, a sandbox that reports only partial
  enforcement, a process that cannot be spawned, and a host git deadline while the artifact is validated
  now come back from `Workspaces.verifyArtifact` as the existing `(verification preparation)` or
  per-command infrastructure row, so the review is deferred with a durable record instead of
  `swarm_verify` throwing. Cancellation, authorization and ownership refusals still throw.
  `DeclaredChecks.execute` no longer recognises failures by their class name, and
  `WorkerAdapter.verifyArtifact` declares the check rows it returns. Two failures that are the artifact's
  or the check's own fault are kept out of that path: a dependency directory whose place in the checkout
  the artifact turned into a file is skipped, and a check with a control character is refused at
  admission.
- **One owner for why a task is blocked.** `blockCauses()` returns the set of causes a blocked task
  carries (ceiling, preparation failure, deferred review, needs replacement, refuted evidence, exhausted
  recovery). The stop barrier, the restart path and `controlTask` read it instead of re-deriving it;
  an exhaustive comparison of the old and new barrier expressions over every combination of their
  inputs differs only where intended. Resuming a blocked task that carries an immutable artifact is now
  refused as `task_needs_replacement` instead of bumping its epoch and stopping its historical author.
- **A repair inherits the acceptance of the task it replaces.** `swarm_propose` with `replaces` stores
  the replaced tasks' criteria followed by any new ones, so the planner no longer copies them verbatim
  and `acceptance` may be omitted for a repair; criteria the host added are named in the result and on
  the `task/proposed` event. The model-facing texts that told the planner to copy acceptance were
  reworded.

The adversarial verification of this batch found a host git timeout that no longer deferred, a
preparation retry counter reset by an assignment (a flapping preparation could loop without ever
escalating to the owner), two artifact- or check-caused failures misread as host infrastructure,
stale repair wording and an unvalidated `replaces`; each was fixed with a regression before merge.

- `npm run typecheck` and `npm run build`: passed.
- Full behavioral suite: **1,330 tests, 1,330 passing** on the final head (`c1f4be9`). The two runs before it each had one timing failure in a different test: `tests/worker-closeout.test.mjs` gave a barrier-issued stop a fixed 50 ms and now waits for the stop, and a planner retry-snapshot case in `tests/planner.test.mjs` passed five consecutive isolated runs and the final full run.
- `npm run test:replay` (digest unchanged), `test:bundle`, `test:harness`, `test:pack` and
  `test:profile`: passed, with no model-visible snapshot drift.

## Round-22 simplification batch 2: typed refusals (2026-09-23)

What the browser may see of a refusal used to be decided by `src/web-api.ts` matching about sixty
anchored regular expressions against English message text, and the refusal contract was policed by a
573-line hand-written JavaScript lexer. Both are gone.

- **Refusals are typed.** About 150 refusal sites reachable from the browser RPCs moved from plain
  `Error('[code] prose')` to `PolicyError(code, category, message)` with byte-identical messages, in
  families (draft and launch, the `Task …` cancel family, runtime shutdown, plan validation, mission
  authority and budget, task and member admission, attempts, content and delivery). The allowlist,
  `actionableMessages` and the predicate form of `exposed()` are deleted: a `PolicyError` reaches the
  browser when its text is bounded, names no host detail and carries a well-formed code; anything
  else is `internal-error`. The two validators that echo the caller's own input keep their
  scrub-exempt path. `TaskGraphAdmissionError` became a subclass of a general `AdmissionError`, and
  plan validation raises one `AdmissionError` carrying every diagnostic. `unsafeDetail` now also
  recognises `/Volumes/`, `/srv/`, `/mnt/`, `/data/`, `/root/`, `/Library/`, `/System/` and other
  absolute host roots.
- **The refusal contract is checked on rendered text.** A TypeScript-AST walker in
  `tests/source-semantics.mjs` replaces the lexer; it inventories every `throw new <Class>(…)`, reads
  a class throw's message at the constructor's declared message parameter, and sees the 147 typed
  sites the lexer never did. `assessText` checks rendered text against the registered tool schemas:
  one code token, a named parameter that resolves, and an imperative next step.

An adversarial verification (browser boundary, byte identity, lint strength) found, and this batch
fixed before merge: plan validation had stopped collecting a non-typed failure, so one malformed
scope entry replaced every other diagnostic with a bare `TypeError`; a reasoning-effort refusal
echoed the adapter's raw text, which can name an internal gateway, to the browser; the wider host-path
scrub turned a caller's own absolute selector on amend, propose and task control into an opaque
internal error, now a fixed repair naming the code and location; three codes each had two categories
or were typed in one place and untyped in another; the lint had lost its next-step check; and the
typed-site structure test did not see `AdmissionError`. Each fix has a regression that fails before it.

- `npm run typecheck` and `npm run build`: passed.
- Full behavioral suite: **1,294 tests, 1,294 passing** in two consecutive full runs on the final head (`58f998f`). The round-18 case that had failed in most full runs of this and the previous batch, the report-survives case in `tests/artifact-policy.test.mjs`, gave a stop barrier that checkpoints a workspace with real git only one second to settle; it now waits for the barrier itself and asserts the barrier settled before asserting the outcome.
- `npm run test:replay` (digest unchanged), `test:bundle`, `test:harness`, `test:pack` and
  `test:profile`: passed, with no model-visible snapshot drift.

## Round-21 simplification batch 1 (2026-09-23)

The first batch of the remaining round-20 review items deletes mechanisms that no production code
reads. Every deletion was preceded by a grep of `src/` for its consumers, and one item a reviewer
had listed, `Workspaces.selfRunEnvironment`, was kept because every assignment still delivers it.
Source shrank by about 1,700 lines.

- **Self-run environment parser.** About 335 lines tokenised the text of every worker command to
  infer the environment a reviewer's own run used. The verdict is decided by the host's declared
  checks in a clean checkout under an environment the host constructs, so the reproduction check now
  compares the delivered envelope only with the environments recorded on those host check rows.
- **Trace payload spill.** Span payloads were copied into a content-addressed directory beside the
  state file and bounded by a sweeper; nothing read them back. A span now keeps only the digest and
  size of its input and output, and the first host start after the upgrade removes the old
  directory. `npm run test:replay` reports `26 referenced, 0 stored, 26 omitted` where it used to
  verify stored payloads; its digest is unchanged.
- **Instruments only tests read.** The guard-chain board model, the wake-precision and silence
  projections moved into `tests/guard-model.mjs` and `tests/instruments.mjs`; the guard co-fire
  table, the in-process refusal log and the Workspaces in-memory issue logs were deleted. The
  recovery-fallback and cleanup-failure callbacks those logs mirrored are now required options, so an
  unwired production construction is a compile error.
- **Advisory work on the propose path.** `reconcileTaskAdmission` computed path and ignore
  advisories on every proposal, spawning `git check-ignore`, and the caller discarded them. The
  hints the draft editor shows still come from `planAdvisories`.

An adversarial verification (three reviewers: hidden consumers, lost guarantees, weakened tests)
found no behaviour regression and seven weaker points, all closed before merge: the orphaned
payload directory above; a span-digest test and a check-semaphore test that a deliberate mutation
passed, both tightened and re-checked against the mutation; a test-side instrument that copied
production constants instead of importing them; a trace comment that overstated what a digest can
be resolved to; and the disclosures below. The full suite also exposed one test that had depended
on a trace file write yielding to the scheduler; it now waits for the outbox explicitly, and the
deliveries it observes are identical.

- `npm run typecheck` and `npm run build`: passed.
- Full behavioral suite: **1,272 tests, 1,272 passing** on the final head (`e16f8c9`). One earlier full run of the same tree failed two load-sensitive cases, the round-18 report-survives case in `tests/artifact-policy.test.mjs` and case F of `tests/r19-recovery-fallback.test.mjs`; each passes in isolation and under a ten-file parallel load, and the repeat full run passed with neither.
- `npm run test:replay`, `test:bundle`, `test:harness`, `test:pack` and `test:profile` against the
  0.1.6-alpha.2 Loader: passed, with no model-visible snapshot drift.

## Round-20 simplifications (2026-09-18)

A whole-repository review looked for problems solved by inference and patch accretion where a
declaration, a type or a single writer would do. It proposed 83 candidates; the 22 with the largest
impact were each challenged by a reviewer instructed to defend the existing design. Six were
confirmed outright, sixteen survived in a narrower form and none was judged necessary as built. The
first three accepted results land here; each also closes defects the review reproduced on the
pre-change head.

- **One writer for a fenced attempt** (`tests/r20-fence.test.mjs`). Stopping a running attempt has to
  bump the epoch, drop the attempt so the outgoing owner is recorded in `priorOwnerIds`, clear the
  attempt-scoped markers, install the stop obligation and emit a closer. Fourteen sites did this by
  hand and disagreed. `Attempts.fenceForStop` is now the only code that does it, and the control
  paths route through it. Two reproduced consequences are closed: a revoked workspace left the
  attempt on the row with no owner recorded and no handle stopped, and a mission pause wrote a log
  its own replay decoder rejected as truncated. The uniform closer is the new durable event
  `attempt/fenced`.
- **One meaning for a parked member** (same file). `MemberPhase` 'parked' meant both the member's own
  `swarm_wait` and a host park installed when a task hit its ceiling. A step brake in `beforeStep`
  now refuses every further step of a handle that still owes a stop, whatever fenced it, before the
  step is charged and without fresh input lifting it. The host park is gone, so 'parked' is written
  only by `wait()`. This closes two reproduced defects: fresh input during a ceiling barrier bought
  a charged step and erased the park, and cancelling a ceiling-blocked task after its barrier had
  settled left the member waiting forever.
- **The event kind is a type** (`src/events.ts`). `SwarmStore.event` took any string, so a new kind
  had to be registered in five places and the convention was policed by a runtime vocabulary, two
  source-text scanners and a hundred-row reader census. One registry row per kind now carries the
  description and the panel decision, `EventKind` is its key set, and an unregistered kind is a
  compile error. Decoding stays open: a row written by an older version still decodes and reports as
  undescribed. The scanners and the census rows the type now guarantees are deleted; the converse
  check, that every registered kind without `historical: true` has a writer, is kept.
- **A task declares the files it must produce** (`tests/r20-declared-outputs.test.mjs`). Tasks carried
  objective, scope, acceptance and checks but nothing naming their outputs, so five consumers
  inferred that list from the objective prose with a write-verb regex that every round since round 4
  has patched. `outputs` is now a declared field, required-present in `swarm_launch` and
  `swarm_propose` and amendable through `swarm_control`, validated by one exact rule: a literal
  relative file path inside the task's own scope, with no directory, glob, `..` segment, `.git`
  component or dependency directory, refused with `[output_outside_scope]`. This change is additive:
  workspace recovery and artifact capture read the declared field and fall back to the heuristic only
  for a row that does not carry it, so a declaring task's deliverable list is exact while legacy rows
  behave exactly as before. Plan validation also stopped spawning `git check-ignore` for advisories
  it computed and discarded.

- `npm run typecheck` and `npm run build`: passed.
- Full behavioral suite: **1,295 tests, 1,295 passing, 0 skipped, 0 failing** on the integrated head (`e84383b`, harness 0.1.6-alpha.2 linked), against 1,285 on the pre-change head.
- `npm run test:bundle` 7/7; `npm run test:replay` (the D6 replay gate, including its eight fault
  injections) and `npm run test:harness`, `npm run test:pack` and `npm run test:profile` against the
  real 0.1.6-alpha.2 Loader all passed, with no model-visible snapshot drift.
- Not part of this gate: `npm run test:web` fails on the team-roster assertion in
  `scripts/smoke-web.mjs`. Verified identical on the unchanged pre-change head, so it predates this
  work; it is recorded in [known-limitations.md](known-limitations.md) rather than fixed here.

## Round-19 workflow audit and fixes (2026-09-18)

A third audit (round-19: three read-only branches, each independently re-verified, then every
finding re-derived and reproduced on this host against snapshot `73627e4`) reported five high and
seven medium findings. Four high and two medium were confirmed or partially confirmed and are fixed
here; H-5 (the frozen worker worktree cannot build) is a worker-environment limit the host does not
share (the five named end-to-end files pass 34/34 on the host), and H-4 (a read-only branch task with
no capturable report path) is a mission-layout mistake against the documented scope contract, not a
code defect. Every fix carries a regression that fails on the pre-fix head `c788c47`; an
adversarial review of the first integration (three lenses) then tightened H-1 and closed the
coverage gaps it named.

- **H-1 uncaptured deliverable gate** (`tests/r19-deliverable-gate.test.mjs`). A research task whose
  text named an ignored report (this repository's `docs/.gitignore` is `*`) was accepted with an
  artifact that omitted it when the member left `swarm_submit.deliverables` empty; nothing in submit,
  verify or `completionError` gated the advisory `artifact.uncapturedPaths`, so the mission became
  eligible and the owner was told every deliverable was independently accepted. The signal is now
  precise: `captureArtifact` lists a named path only when it is in scope, not a directory token,
  ignored by Git, present as a regular file in the member worktree and not declared, and
  `swarm_submit` refuses that list for every task kind with `[deliverable_uncaptured]`, offering
  both repairs (list the file if it is an output, remove it if it is not) while the attempt stays
  running. Names the member never wrote, tracked inputs named after a write verb, and directory
  tokens are never obligations, so the review's dead-end and secret-capture scenarios cannot occur;
  rows accepted before the gate are named in the completion notice instead of blocking completion.
- **H-1 gate hardening** (`tests/r19c-deliverable-gate.test.mjs`). A second review of the gate
  found that preservation snapshots force-include hinted ignored files (so a draft survives a
  handoff) and a recovered checkout therefore had them tracked, out of the gate's sight. A recovered
  checkout now un-tracks every hinted path the snapshot pulled in (tracked, ignored by pattern,
  absent from the task base), so a member-created `.env` never reaches an artifact ref through a
  handoff or a same-member task switch while the draft stays on disk. Hints and declared outputs
  resolve to their on-disk spelling on case-folding filesystems; `swarm_verify` with `deliverables`
  refuses on `reviewArtifact.uncapturedPaths` with the same repairs; paths inside ignored dependency
  directories or the scratch root are neither obligations nor deliverables; a `git check-ignore` run
  that does not complete fails the capture with `[deliverable_gate_unavailable]` instead of silently
  opening the gate.
- **H-2/M-d dependency materialisation** (`tests/r19-dependency-materialisation.test.mjs`). The copy
  of a source repository's `node_modules` refused any symlink resolving outside the dependency
  directory with a codeless `Error` that the declared-check classifier could not recognise, so on a
  workspace symlink farm every `swarm_verify` with checks threw before the first command. Both
  refusals are now the typed `DependencyMaterialisationError`, classified as an infrastructure
  failure (`(verification preparation)` row, exit 125) that defers the review with the two documented
  ways out in its output; materialisation runs before the check slot is acquired, so a slow or refused
  copy holds no slot and counts against no check deadline.
- **H-3 recovery fallback** (`tests/r19-recovery-fallback.test.mjs`). When a cross-owner recovery could
  not capture the previous owner's worktree, the replacement started from the last checkpoint or the
  task base and the fallback was recorded only in an in-memory list with no production reader; a
  host-restart re-pend followed by a start-failure re-route or an owner `assigneeId` amend lost the
  uncommitted work silently. `recoverTask` now snapshots the old worktree into the preservation refs
  first and the replacement inherits it; the fallback is a durable `task/recovery-fallback` event, an
  owner notice and a `task.recovery` projection in `swarm_observe`. The second silent channel the
  audit named, a failed verification cleanup, is surfaced the same way.
- **M-a check-syntax attribution** (R18-5/R18-5b in `tests/r18-workflow-fixes.test.mjs`). The
  launch-boundary preflight read the adapter's compact result as if it were aligned with the declared
  checks, so a broken check at any index above 0 was refused naming `checks[0]`. The adapter contract
  is now located (`CheckSyntaxIssue { index, message }`) and the refusal names each offending
  `tasks[<key>].checks[<j>]` with its own quoted command and diagnostic.
- **M-b task-ceiling park** (R18-4/R18-4b/R18-4c/R18-4d). `blockTaskCeiling` parked the member and
  ran the `resource` stop barrier, whose completion set the member active again on the assumption of
  a later barrier that nothing installs, so the member read idle, further steps were admitted and
  charged, and the raise never consumed a park. The park is the durable member row and survives its
  own barrier and a host restart; `controlTask` consumes it when the owner raises the ceiling.
  R18-4c now discriminates the barrier-alone case (the release with the ceiling still held leaves the
  member parked and a further step refused), and R18-4d/R18-4e cover the park, its refusal and its
  raise across a host restart. `tests/refusal-inventory.mjs` now walks registered coded `Error`
  subclasses, so the two `DependencyMaterialisationError` refusals are inventoried again.

- `npm run typecheck` and `npm run build`: passed (backend and browser bundles).
- Full behavioral suite: **1,285 tests, 1,285 passing, 0 skipped, 0 failing** in a parallel run on the integrated head (`3a1569a`, harness 0.1.6-alpha.2 linked).
- Smokes: `npm run test:bundle` 7/7; `npm run test:harness`, `npm run test:profile` and `DSH_HARNESS_ROOT=~/code/deepseek-harness-016 npm run test:pack` (real 0.1.6-alpha.2 Loader composition, installed-bundle profile, clean-checkout pack of 239 files) passed after `tests/fixtures/model-visible.expected.json` was refreshed for the new assignment-instruction sentence; the composition smoke now awaits the Loader unload before asserting worker disposal, a race the packed layout lost by a few milliseconds and the source layout won.
- Residuals recorded in [known-limitations.md](known-limitations.md): task text that names no
  literal path still submits an empty artifact; a materialisation failure copies the tree twice
  before it defers and concurrent copies are no longer bounded by `checkConcurrency`; a replacement
  inherits out-of-scope changes it must revert; M-c (cancelled task rows count toward `maxTasks`) is
  unchanged.

## Round-18 workflow audit (2026-09-17)

A second deep audit of the four workflow questions (does a mission run through, is each member's
environment complete, do handoffs preserve work, does the merged delivery lose anything) surveyed
`src/` again and fixed seven defects; each has a regression in
`tests/r18-workflow-fixes.test.mjs` that fails on the pre-fix head. The measured set: delivery
coverage now follows the composition (`covers` no longer counts a withdrawn carrier's plan, so a
mission behind a repaired middle task cannot complete with an accepted implementation omitted); a
staged-plan member edit drops the stale adapter composition instead of bricking the member; handoff
refuses a review target that could never own it; the stop barrier keeps a `handoff` park and still
clears the `resource` resume; the parse-only check preflight runs at the shared launch boundary, so
the staged path refuses a shell-syntax-error check before any work exists; mission-scope amend names
its own required shape on the tool and RPC paths; the member scratch root moved inside the worktree
(sandbox-writable, excluded like toolchain state) with the round-16 layout tolerated on resume.

- `npm run typecheck` and `npm run build`: passed (backend and browser bundles).
- Full behavioral suite: **1,248 tests, 1,248 passing, 0 skipped, 0 failing** in a serial, unloaded
  run (`/tmp/r18-final.txt`). An earlier run of the same tree under load reported one failure in
  `tests/artifact-policy.test.mjs` ("captured review report survives deferred checks and
  reassignment without locking recovery"), which passes three consecutive times in isolation; that
  is the pre-existing load sensitivity recorded in
  [known-limitations.md](known-limitations.md), not a regression from this round.
- `DSH_HARNESS_ROOT=/Users/tongtao/code/deepseek-harness-015 node scripts/smoke-pack.mjs`: clean-source
  prepack (**239** published files) and the real **0.1.5-rc.1** Loader composition passed, covering
  registered model tools, peer proposals, real bash, evidence, independent verification, integration,
  automatic completion, owner-independent restart recovery and unload.
- The composition-fidelity check (`Workspaces.droppedDependencyPaths`) is verified directly against a
  composed tree that keeps the wrong side, not through a repository merge driver: on the measured
  `git version 2.50.1` a custom `merge=<driver>` attribute did not engage for a conflicting
  single-line edit, so that trigger stays a named residual in
  [known-limitations.md](known-limitations.md).

## Consolidation and context efficiency (2026-09-15)

All ten follow-up consolidation items are implemented in the current 0.7.0
working tree on `codex/r12-recovery-fixes` (base `73a232a`). They preserve
owner-directed budgets, task identity, immutable evidence, independent review,
stop confirmation and WIP recovery. No live campaign or budget was changed.

The runtime now owns normalized verdict events in the actual verdict transaction;
check-infrastructure deferral emits no refutation. Draft and owner-control
refusals carry explicit business codes/categories through Web and trace, with
size/path redaction retained. Owner observations support explicit scoped cursors,
replay, full reset and exact delivery reads. Bounded notices retain full facts and
per-dimension budget identities. The UI shares its visible projection/clock and
removes retired components. Cancellation preparation, draft diagnostics, task-graph
indexes and integration-conflict staging reuse their existing local paths.

Validation of the final product sources:

- `npm run build` and `npm run typecheck`: passed.
- Full behavioral execution: **1,136 tests**, with 1,131 passing initially.
  Five test-maintenance failures were corrected: two migrated UI event fixtures
  needed their mission ID; the new disposable owner-cursor cache needed its
  recovery registration; the event-reader inventory still named the removed tool
  consumer; and the refusal inventory assumed an English-regex site count could
  never decrease. The latter now checks typed codes/categories as well as the
  retained legacy path and native Web redaction behavior.
- The affected census/UI fixture rerun passed **40/40**. Event/refusal inventory
  reruns passed **13/13**, including one new typed-refusal test. Final frontend
  behavior and mounted-clock tests passed **78/78**, including the later fix that
  disables lease timing when the active filter hides all leased tasks. These
  scoped reruns complete coverage; the initial full run is not represented as a
  zero-failure run. The mounted-clock and typed-refusal tests bring the current
  suite to 1,138 cases across full execution and scoped reruns.
- Registered-tool verdict/recovery tests passed **124/124**; notification and
  lifecycle tests passed **133/133**; owner delta/history tests passed **11/11**;
  typed Web/trace/resource tests passed **44/44**. These overlap the full suite.
- `DSH_HARNESS_ROOT=.../deepseek-harness-015 node scripts/smoke-pack.mjs`:
  clean-source prepack and the actual **0.1.5-rc.1** Loader passed, with **236**
  published files. It exercised registered model tools, real bash, evidence,
  independent verification, integration, completion, owner-independent restart
  recovery and unload. The clean-source copier was corrected to honor tracked
  working-tree deletions without changing the Git index.

Build/type checks use the linked **0.1.3-alpha.2** dependencies; package loading
was checked against the exact **0.1.5-rc.1** revision in the table above. Providers
were scripted and test workspaces/profiles isolated. No billable model requests
were made. UI lifecycle evidence comes from mounted React under jsdom; the full
browser E2E suite was not rerun for this consolidation.

Bounded measurements (not general token, throughput or memory guarantees):

| Scenario | Before | After |
| --- | ---: | ---: |
| Owner read, 32 tasks, one changed task | 6,743 serialized bytes | 2,205 bytes |
| Owner read, 128 tasks, one changed task | 14,768 serialized bytes | 2,206 bytes |
| Five synchronous graph operations, 32 tasks | 151 index constructions | 5 |
| Same operations, 128 tasks | 583 index constructions | 5 |
| Same operations, 256 tasks | 1,159 index constructions | 5 |
| One draft operation, package metadata reads | 3 | 2 |

Graph shapes included fan-in, a two-hop replacement chain and an exact review
source. Outputs matched before/after, including a subsequent carrier change.
Uninstrumented medians after warmup were 0.302→0.095 ms, 3.511→0.120 ms and
13.103→0.221 ms respectively (Node 22.22.3, seven batches of twenty operations).
Heap readings were GC-sensitive and did not consistently improve, so no general
memory reduction is claimed. Draft tests also preserve 25 complete diagnostics
in the event, cap displayed diagnostics at 20, and read changed scripts on the
next operation.

Mounted UI measurements: the compact overview runs one clock; a visible leased
task list adds one independent clock; hiding/filtering away that list removes
its clock. Hidden, offline, paused, stopped, completed, resource-paused and
historical views run zero clocks. Four elapsed ticks performed four native
activity reads and zero board-title/dependency rereads, while event DOM identities
remained stable. Robot identities, dynamic rings, reduced-motion behavior and
Chinese/English state labels remain covered by the frontend tests.

## Rule recovery and resource continuity (2026-09-15)

The current working tree on `codex/r12-recovery-fixes`, based on `73a232a`,
implements the 26 recorded rule-audit items and both follow-up observations.
This includes the earlier shared task-graph interpretation and advance budget
review TODOs. The detailed local implementation map is
`docs/local/rule-audit-2026-09-15.md`; it is excluded from Git and published
packages. The package version remains 0.7.0.

Owners can amend finite task allocations and recover the same task without
resetting consumption, rebuilding the DAG or discarding artifacts. Durable
advance warnings and bounded reminders distinguish delivered notifications
from completed decisions, and meaningful-progress detection ignores repeated
failed-tool and scheduling noise. Explicit user pauses remain authoritative.
Effective execution time excludes idle/resource waits; an optional absolute
deadline remains a separate constraint.

Recovery tests cover stop confirmation before workspace reuse, legacy records
without a recorded worker identity, WIP preservation, dependency amendments,
same-artifact review after infrastructure failure, integration conflict
resolution and independent review. Shared graph selectors align completion,
delivery and UI facts. Heuristic path/script diagnostics no longer override
actual scope, host capability or artifact evidence. Historical policy documents
are marked as archived instead of retaining conflicting current mandates.

An existing stall-root regression exposed a duplicate alert after legacy stop
recovery: pending work was treated as stuck while its selected member was
stopping or executing another task. The classifier now recognizes those
bounded waits while retaining dead-prerequisite and expired-stop alerts.
An overdue scheduling pass still produces its own task-specific dispatch
question. The affected owner/notice/recovery group passed **84/84** after this
correction, including the original attribution assertions and new paired cases.

- `npm run typecheck` and `npm run build` passed for the backend and browser.
- `node --test --test-concurrency=4 tests/*.test.mjs`: **1,120/1,120 passed**,
  with zero failures, cancellations or skips (166 seconds;
  `/tmp/swarm-rule-final-full-tests.log`). This final run includes the
  Round 12 fixes, lean assignment work and all rule-recovery changes above.
- `DSH_HARNESS_ROOT=/Users/tongtao/code/deepseek-harness-015 node scripts/smoke-pack.mjs`
  passed against exact Harness **0.1.5-rc.1** commit
  `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. Clean-source prepack emitted
  both declared entry points and the **236-file package** passed the real
  Loader composition: tool registration, peer proposals, real shell execution,
  evidence, independent verification, integration, completion,
  owner-independent restart recovery and unload
  (`/tmp/swarm-rule-final-pack-loader.log`).

The first packed check caught an outdated model-visible assignment snapshot:
integration workers now receive instructions for their conflict manifest.
Only that intentional instruction was updated in the four affected snapshots;
the subsequent packed check passed. This did not change product code.

Behavioral tests use the linked **0.1.3-alpha.2** host; the packed check links
its temporary extraction to **0.1.5-rc.1**. Providers are scripted, while host,
Git, filesystem, persistence and Loader interactions are real. These checks do
not establish paid-model planning quality, general throughput improvements or
arbitrary infrastructure fault tolerance. This pass did not restart user
services, alter live mission budgets or resume the paused campaign, and did not
repeat browser rendering checks.

## Lean planning and idle borrowing (2026-09-15)

On the same working branch, planning guidance now favors independently
verifiable outcomes and real input dependencies, accounting for coordination
cost. The owner prompt grew by 83 characters (two English words net); no
additional planning agent, tool, model turn or scheduler loop was introduced.

New automatic plans persist `assignmentMode: preferred`. Only pending work at
epoch 0 without an attempt or recovery marker may be borrowed when the preferred
member cannot start it. Explicit `pinned` and legacy/manual binding remain;
actual authors cannot review their own work, and borrowing cannot consume a
source's pinned reviewer. Once claimed, the actual member owns recovery.
Runtime, review-path and client projections use the same pure assignment rules.

Behavior tests exercise busy and idle preferences, independent review through
acceptance, pinned/legacy/recovery exclusions, cancellation or reassignment
during preparation, and restart persistence. Automatic and manual plan tests
also verify the default, explicit override and saved representation. Browser
projection tests cover a stopped preference and malformed assignment modes.

- `npm run typecheck` and the backend/browser build passed.
- `node --test --test-concurrency=4 tests/*.test.mjs`: **1,045/1,045 passed**,
  zero failures, cancellations or skips (`/tmp/lean-full-tests.log`). This also
  reran all Round 12 fixes recorded below.
- `DSH_HARNESS_ROOT=/Users/tongtao/code/deepseek-harness-015 node scripts/smoke-pack.mjs`
  passed against exact Harness **0.1.5-rc.1** commit
  `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`: clean-source prepack and the
  227-file artifact passed real Loader collaboration, review, integration,
  restart recovery and unload (`/tmp/lean-pack-harness-015.log`). A handled
  `SessionHandleClosedError` flush diagnostic appeared during teardown; the
  unload assertions still confirmed no remaining worker handles or swarm tools.

The suite uses the linked **0.1.3-alpha.2** host; the packed check links its own
temporary extraction to 0.1.5-rc.1. Scripted providers avoid paid model calls.
These checks prove the assignment and recovery behavior, not a measured
wall-time speedup or improved model decomposition quality. Existing user
services/profiles were not restarted or modified.

## Round 12 recovery fixes (2026-09-15)

The working tree on `codex/r12-recovery-fixes`, based on `73a232a`, addresses 40
reported findings and hardens snapshot consistency for one further item; five
reported items did not warrant changes after revalidation. The detailed local
log is `review/round-12-fixes.md` (excluded from Git and published packages).
The plugin package version remains 0.7.0.

The local peer links resolve to **0.1.3-alpha.2**, even though the checkout is
named `deepseek-harness-latest`. Typecheck, the built backend/browser bundle,
and the behavioral suite use those links. A separate extracted package was
linked to **0.1.5-rc.1**, commit `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`,
for the real Loader check; neither host checkout nor user profiles were changed.

- `npm run typecheck` and `npm run build` passed.
- `node --test --test-concurrency=4 tests/*.test.mjs` ran 1,029 tests:
  1,028 passed, and one test caught an ownership diagnostic that no longer
  explained “not owned” in plain language. The message was repaired while
  retaining its stable diagnostic code and actionable parameters; the affected
  tool and diagnostic suites were then rerun against the rebuilt artifact:
  **55/55 passed**, with no skips. The other passing checks were reused because
  the final change only restored that diagnostic sentence.
- `DSH_HARNESS_ROOT=/Users/tongtao/code/deepseek-harness-015 node scripts/smoke-pack.mjs`
  passed: clean-source prepack builds both entry points; the 221-file package
  passes real Loader registration, native tool execution, independent review,
  integration, completion, owner-independent restart recovery and unload.

The Loader uses a scripted provider and real local host services, not a paid
model or a model-quality benchmark. SQLite restore tests kill subprocesses at
defined publication points; they do not establish arbitrary power-loss or
concurrent multi-host restore safety. Git tests use temporary repositories and
include actual Python virtualenv execution. UI recovery is checked through
monitor, projection and component behavior; this pass does not re-render the
README showcase or change the avatar design.

## Recovery and sidebar corrections (2026-09-13)

The seven findings reviewed at `6b42c66` are addressed in the working tree on
`codex/fix-review-20260913`:

- Outbox acknowledgements merge into current mission and delivery rows. A stop,
  pause, consumption signal, answer or dismissal during transport survives the
  acknowledgement. A successful retry clears only its matching starvation record.
- Each send rechecks lifecycle and the current question receipt. Completed
  missions still deliver queued facts; a paused mission delivers only questions
  that remain unanswered.
- Owner reminders have distinct durable ordinals. The counter, miss event and
  queued reminder commit atomically; guard replacement and a failed outbox write
  do not consume a reminder without retaining its wake.
- A handed-off wake summary cannot absorb new facts, including after a transport
  timeout. Later facts get a new delivery ID and survive adapter deduplication.
- Task admission checks the prospective effective dependency graph, including
  replacement lineage and exact review sources. Valid repairs retain historical
  rows. Typed graph failures reach native RPC as actionable `bad-request` errors;
  generic errors imitating their text remain sanitized.
- A real check deadline becomes exit 124 with bounded output, attribution and
  environment. Completed checks and both passes are durable; the existing retry
  decides acceptance or rejection. Explicit caller cancellation does not retry.
- Native sidebar reveal state belongs to its registry/controller lifetime.
  Replacement requires a fresh reveal, removal clears retries, and the host's
  session and visibility hook govern the pane's monitor.

Regression coverage includes deterministic adapter interleavings with the real
runtime and SQLite, real subprocess deadlines, actual Cordis service replacement,
and native Connection RPC. The new outbox and reminder cases failed against the
pre-fix artifact. The timeout regressions also failed before normalization; the
explicit-cancellation case already passed. The additional timeout/dedup summary
case caught a gap in the initial correction and now guards that interleaving too.

Build, typecheck and the full built-artifact behavioral suite pass: **889/889**,
with zero failures or skipped tests (baseline: 865). Deterministic replay retains
`sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e`.
An isolated packed artifact (193 files) boots and disposes through the real Loader
on exact Harness `0.1.5-rc.1` (`183f08e9c6dde7e36cd2318eaee70b0da08fb35e`).
The development peer links remain on `0.1.3-alpha.2`; they were not repointed.
This pass runs no live model calls, full mission end-to-end execution, or browser
workflow, and does not establish a new full three-version behavioral matrix.

## 0.1.5-rc.1 baseline (2026-09-11)

The owner pass of 2026-09-11 adapted the plugin to the npm `latest` line and measured it on a checkout
built from the release tag `dsh-v0.1.5-rc.1` (`183f08e9c6`): `pnpm install --frozen-lockfile` (25 s) then
`build:lib`, `build:native-system` and `build:web` in a fresh clone of that revision. The project's
Harness symlink farm was repointed at that checkout for the run (the tracked linker still enforces
`compatibility.json`), then restored.

| Check | 0.1.5-rc.1 (`183f08e9c6`) | 0.1.3-alpha.2 (`82a5fd61a7`) |
| --- | --- | --- |
| `npm run build` | exit 0 | exit 0 |
| `node --test tests/*.test.mjs` | **833/833** | **833/833** |
| `npm run test:faults` | **24/24** | **24/24** |
| `npm run test:replay` | `REPLAY OK`, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` | identical digest |
| `npm run test:harness` (real Loader composition) | passed | passed |
| `npm run test:profile` (installed bundle through the real CLI) | passed | passed |
| `npm run test:pack` (packed artifact) | passed (187 published files) | passed |
| `npm run test:bundle` | 7/7 | 7/7 |

Three product changes make the newest line work, and each is written to satisfy every supported
release rather than forked by version: the worker setup hook accepts the agent as an **optional**
second parameter (0.1.5 passes it there; through 0.1.3 it is reached through `agentCtx.agent`, removed
at 0.1.5), the inbox's pending work is read from `nextStep`/`nextTurn` (the `hasPending` getter was
removed), and the RPC registration injects `webServer` alongside `connection` (0.1.5's connection
plugin registers its route on the context the service was provided from and that context must inject
it). Declaration metadata moved with them: `compatibility.json` gained the release and made it the
default, `profile/package.json`'s `dsh.bundle.requires.harness` lists all three, and the 24 peer ranges
accept it. Test-side adaptations: the provider-visible system prompt is read through one helper that
accepts either carrier (0.1.5's agent loop forbids `options.system` and carries the prompt in
`messages` as surface node 0), and the synthetic web host composes `Connection` inside a scope that
injects `webServer`.

The same pass fixed the reason the three real-host tiers could not run at all before it: the plugin
published its derived mission board into the owner session as a plugin-owned `swarm/mission` event,
which the host's closed session vocabulary refuses to read back (`SessionFormatUnsupportedError` on
every supported host). The publication and the host projection registration are deleted; the board is
the single derivation over `swarm.sqlite`, and `tests/r17-projection.test.mjs` pins that no `src/`
module appends a session event.

Both targets use isolated SDK links. The rc.1 copy runs the same emitted JavaScript against rc.1 dependencies and its actual CLI; it is not an alpha.2-linked plugin with only a different CLI environment variable. Host and client TypeScript are also checked against the selected SDK without re-emitting that copy.

### The RPC surface moved onto the host's shared channel (2026-09-12)

Booting the native-sidebar host exposed a second adaptation gap, this one on the
host side, and it is fixed in the same pass:

- **A plugin-owned channel is unusable from 0.1.5.** `ctx.connection.rpc.handle('/agent-swarm', …)`
  registers the route through the connection service, which reads `webServer` on a
  context that injects `credentials` alone. Cordis refuses that access
  (`cannot get property "webServer" without inject`), the route is never mounted,
  and every panel call dies with `HTTP 405`.
- **The shared channel admits exactly one interceptor.** `rpc.intercept('/api', …)`
  answers `connection: shared RPC channel "/api" already has an interceptor` on a
  composed host, so it is not available either.
- **What works on all three releases** is the host's documented mechanism for
  plugin endpoints: one exact Fetch route per endpoint on the shared `/api`
  channel, consulted before the interceptor and behind its Host, Origin and
  browser-authentication fence. The client already posts the standard envelope to
  `<channel>/<endpoint>`, so the change is one address on each side plus the
  endpoint list (`SWARM_WEB_ENDPOINTS`, pinned against the handler's dispatch and
  the naming manifest). The route's framing mirrors the host's channel handler:
  415 for a non-JSON media type, 400 for a body that is not JSON, and a
  `gateway/bad-request` envelope for a malformed or mismatched request.

Measured on the same isolated 0.1.5-rc.1 host: before the fix
`POST /agent-swarm/state → 405` and (after the address change but before the route
change) `POST /api/agent-swarm/state → 404`; now `POST /api/agent-swarm/state → 200`
with the plugin's own envelope, and the panel in the native sidebar reports
**Connected** with the start-guide body, no standalone dock and no page error
(`~/.dsh/agent-swarm-native015/verify/native-sidebar-5196-wired.png`). The real-HTTP
suites (`tests/web-api.test.mjs`, `tests/web-api-sanitize.test.mjs`, 23 cases)
drive a composed connection plugin, web server, browser authentication and the
routes end to end, and the full behavioral suite is re-run on the final code.

### The panel moved to the host's right sidebar (2026-09-12)

The owner asked for the panel beside the conversation rather than in the main
column. Harness 0.1.5 exposes the same mechanism the Files pane uses, and it is
public: a tab TYPE in the `sidebarRightTabs` registry (`id`, `kind`, the chip
title and the guide capsule), the panel BODY in the keyed `sidebar.right.pane.tab`
seat under that id, and navigation through the `sidebarRight` controller
(`openTab(kind, { revealIfOpened: true })`). The guide capsule matters: a page
type that recognizes no resource address is otherwise unreachable from the UI,
which the first attempt proved — the tab registered, and nothing could open it.

Measured on the isolated 0.1.5-rc.1 host (port 5196, headless Chromium): the right
sidebar's tab strip now reads **Agent Swarm** beside Files; the panel renders
inside the pane at `x=792, y=38, 648×862` on a 1440×900 viewport; the state RPC is
`200` and the panel reports **Connected**; the standalone dock is absent and no
page error is logged (`~/.dsh/agent-swarm-native015/verify/right-sidebar-5196-open.png`).
The left column's Global panels list is empty again — the plugin registers one
surface, not two.

## Native sidebar adaptation (2026-09-12)

Harness 0.1.5 introduced the host's own sidebar (`@deepseek-ai/dsh-client-ui-sidebar`).
Its extension point is the root-scoped `sidebar.panellist` list plus the layout's
root-scoped `main` keyed slot: an icon registration and a panel registration that
share one id, selected through `ctx.layout.selectPanel`. 0.1.3-alpha.2 and
0.1.2-rc.1 ship an earlier sidebar without `sidebar.panellist`, so the adapter is
structural (registered by slot name, no import of the sidebar package) and the
standalone dock remains their surface.

Measured on an isolated 0.1.5-rc.1 host booted for this check
(`/Users/tongtao/code/dsh-015-rc1`, port 5196, its own `DSH_HOME`, plugin snapshot
and `statePath` — the running 5192 preview was left untouched), with the real Web
application in headless Chromium:

| Check | Result |
| --- | --- |
| `npm run typecheck` (0.1.3-alpha.2 farm) | exit 0 — the adapter compiles against a host that has no `sidebar.panellist` |
| Client suites (`ui`, `ui-progress`, `client-findings`, `client-event-projection`, `r17-worker-names`, `sidebar`, `r17-projection`, `client-command`) | **79/79** |
| `npm run test:pack` (clean checkout of the committed artifact) | passed, 190 published files |
| Rail registration | exactly one button in the host's `nav[aria-label="Global panels"]`: **"Agent Swarm"** |
| Wake | clicking it mounts the panel in the main column: `[data-swarm-panel]` at x=280, 1160×900 beside the 280px sidebar |
| Surface preference | the standalone dock is **absent** (`[data-swarm-dock]` count 0) once the native panel is registered |
| Console | no page errors, no adapter warnings |

The isolated host has no conversation of its own, so the panel reports its
no-session state there ("Select a conversation to manage its missions"); the
session-scoped RPC path is the one already measured on the running preview.

## Second UI pass (2026-09-11, client only)

The owner asked for the remaining items of the 2026-09-11 UI review and then for the attended
preview restart. The pass changes `src/client/` only (feed grouping, lane counts and empty-lane
collapse, the clamped card reason, the sidebar's stated derivation, the `DisposalRegistry`, and the
dock's inline-style layout shift), so the runtime, store, adapter and admission paths are untouched
and the replay digest is unchanged. Measured on the committed artifact `1f62695`, with the SDK farm
repointed per row (the tracked linker still enforces `compatibility.json`).

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 on both farms (`0.1.3-alpha.2`, `0.1.5-rc.1`) |
| Emitted JavaScript (`lib/**/*.js`) | 59 files, SHA-256 `2a654ad5c839eb96db5b24b802bce9283d7e521f3fb43b5f3f581771c0505ee3` |
| Complete behavioral suite (`node --test tests/*.test.mjs`) | **849 tests: 847 passed, 2 failed** on this host; the two failing files pass alone (see the load note) |
| `npm run test:faults` | **24/24** on both farms |
| `npm run test:replay` | `REPLAY OK`, digest `sha256:61a921e64088b78b957cd6aeaa563d5436d4a6eae4b0130725d1f3c74c6f971e` (unchanged by this pass) |
| `npm run test:harness` (real Loader composition) | passed on `0.1.3-alpha.2` and `0.1.5-rc.1` |
| `npm run test:profile` (installed bundle through the real CLI) | passed on both |
| `npm run test:pack` (clean checkout of the committed artifact) | passed on both; 190 published files |
| `npm run test:bundle` | 7/7 on `0.1.3-alpha.2`, passed on `0.1.5-rc.1` |

The pass adds six tests (843 → 849): the actor-grouping derivation and its rendered order, the lane
counts and the collapsed empty lane, the reason clamp (full reason one disclosure away, short reason
inline), the owner-state disclosure (including the new `count` field and the Chinese strings), the
`DisposalRegistry` contract, and the dock geometry plus the two source guards that keep `#root` and
`!important` out of the stylesheet. The clean-checkout pack tier is also the gate that caught the new
`src/client/lifecycle.ts` while it was still untracked: the tier builds only tracked files, so the
module had to be committed before the packed artifact could compose.

Layout facts were measured in headless Chromium against the rendered board and panel, not inferred
from markup: the lane-count strip sits above the board (strip y 924, board y 959) with all seven chips
(`ready 1 · queued 1 · active 1 · review 1 · blocked 0 · cancelled 0 · done 1`); an empty lane is
**20 px** tall (header only, 1 px rule, no placeholder box) where a filled lane is 240 px; the
lane-title colour rules that no code had ever triggered now apply (`queued` `rgb(157,182,212)`,
`cancelled` `rgb(154,160,173)`); the Activity tab renders three actor groups (runtime, Nova, Atlas —
20 retained events each, member groups drawing 54 and 50 sprite rects and the runtime group none); the
clamped reason is one 17 px line whose full 294-character text is one disclosure away; the tab bar
reports `Work board 10 · Dependency graph 10 · Evidence 2 · Activity 5`; and the state-provenance
disclosure reports phase `waiting-for-owner` with the durable evidence
`task t4 status=submitted without a live review`.

**Load note (this host, not a product claim).** The host running the suite also runs the live preview
host and the owner's browser; load average was 12–33 during the measurements. Five wall-clock-bound
cases failed in a run that shared the machine with a browser and a second suite, and two different
wall-clock-bound cases failed in the serial run published above (`durability-w9-recovery`,
`lease-liveness`; the first took 175 s where it takes 7 s alone). Every failing file passes when run
by itself, and no assertion was changed to make that happen. This is recorded in
`docs/known-limitations.md` with the same evidence.

## Historical revision baseline (2026-09-09, superseded)

This table is retained as historical evidence: it describes revision `a226108`, not the round-4 head. The round-4 baseline below supersedes it.

Measured on the integrated remediation of revision `a226108` (the `dec5fe7` feature head plus `scripts/update-preview.mjs`) after assembling the six accepted implementation artifacts — runtime `3c470f7d`, capture `6e911c7c`, surface `87b5bdbd`, adapter `66ae0f4c`, client `11d56f61`, packaging `66bdafdb` — and the integration hand-offs. The digest algorithm documented below reproduces the recorded `1c58738` baseline digest `008061c3b73adcf4c82b4e710735d11f060999a1c602e4851897468d173b8ea3` (43 files), so the current digest is computed the same way. The emitted set grows by one file versus `a226108` because the client remediation adds `src/client/clock.ts`.

| Check | Result on this revision |
| --- | --- |
| Host/client TypeScript and production browser build | Passed (`npm run build`) |
| Emitted JavaScript | 44 files, SHA-256 `3c3993abf7dc812e051b13227ddc53c46a1de9bd265e40d16eafc7850389aa78` |
| Complete behavioral suite (`node --test tests/*.test.mjs`) | **281/281 passed**, 0 failed, 0 skipped |
| Clean pack manifest (`npm pack --dry-run --json` with lifecycle scripts) | `files=141`; `lib/index.js` and `lib/client.js` both present (H5) |
| `npm run test:pack` | Stopped at the nested-sandbox prerequisite on this host (below); its clean-checkout `prepack` assertions are exercised on a host that permits nested `sandbox_apply` |
| `npm run test:profile` | Not re-run in this integration; it composes the same real-Harness fixture |
| `npm run test:web` / `npm run test:command-web` | Not re-run in this integration; they must be run sequentially on an idle host (see below) |

The two sections that follow record the historical 0.6.0 release baseline and final watch-lifecycle correction. They are retained as first-baseline evidence and are not re-digested against later revisions. Recompute this table whenever source changes land after the measurement above: the digest covers emitted `lib/` output and the behavioral count covers the full test suite.

## Round-4 baseline (T9 tree, 2026-09-09, superseded by the integrated measurement)

This is the round-4 measurement taken on the T9 artifact base — the accepted T4 scalability artifact `832b6335` plus the T9 documentation and packaging changes — not on the final integration. The integration task and the owner's gate must recompute the same three numbers on the integrated artifact with the commands below; if they differ, this table is superseded by the integrated measurement.

| Check | Result on the T9 tree |
| --- | --- |
| Host/client TypeScript and production browser build | Passed (`npm run build`) |
| Emitted JavaScript | 45 files, SHA-256 `ef872275e787196d4b80865e27e76577aa66414cb8a45d20edcaffc5757024dc` |
| Complete behavioral suite (`node --test tests/*.test.mjs`) | **357/357 passed**, 0 failed, 0 skipped |
| Clean pack manifest (`npm pack --dry-run --json --ignore-scripts` after a build) | `files=145`; `scripts/packed-smoke.mjs` included; `lib/index.js` and `lib/client.js` present |
| `npm run test:packed` | Passed (`packed-smoke: 10 export target(s) and 8 shipped file(s) present`) |
| `npm run test:load` | Passed: measured envelope at N=16/32 (maximum concurrent leases 8/16, queue high-water 16/32, admission p50/p95 sub-millisecond, exact limit hit `queue_full@taskClass(implementation)=8/16`, per-worker observation 829B → 832B) |
| `npm run test:faults` | Runs without a sandbox; provider tier B (F3a/F3b/F3c) needs a built Harness checkout (see below) |
| `npm run test:harness`, `test:pack`, `test:profile` | Host-only: they compose a real Harness profile and need a host that permits nested `sandbox_apply`; the owner runs them in the round gate |
| `npm run test:isolation` | Host-only: it drives the real sandbox provider and needs a built Harness checkout; the owner runs it in the round gate |
| `npm run test:web`, `test:command-web` | Not re-run here; they must run sequentially on an idle host (see below) |

Recompute the digest, the file count and the unit count after any source change lands:

```sh
npm run link:dsh && npm run build
# Emitted JavaScript: sorted lib-relative .js paths, a NUL separator and file contents.
node --input-type=module -e "import {createHash} from 'node:crypto';import {readdir,readFile} from 'node:fs/promises';import {join} from 'node:path';const lib=join(process.cwd(),'lib');const files=(await readdir(lib,{recursive:true})).filter(p=>p.endsWith('.js')).sort();const h=createHash('sha256');for(const p of files){h.update(p+'\0');h.update(await readFile(join(lib,p)))};console.log(files.length,h.digest('hex'))"
# Behavioral suite: the final `# tests` and `# pass` lines are the count.
node --test tests/*.test.mjs | tail -12
# Packed manifest: file count with lifecycle scripts disabled after a build.
npm pack --dry-run --json --ignore-scripts --cache "$(mktemp -d)" | node -e "const [m]=JSON.parse(require('node:fs').readFileSync(0,'utf8'));console.log('files='+m.files.length)"
```

## Round-4 baseline (integrated head, 2026-09-09)

This is the round-4 measurement recomputed on the integrated artifact
(`task_24f706c6`: the T4 chain + W18 + T7 + the client repair + the D1 defaults +
the materialized trace/ceiling/replay lineage), with the commands above. It
supersedes the T9-tree table for the final round-4 claim.

| Check | Result on the integrated head |
| --- | --- |
| Host/client TypeScript and production browser build | Passed (`npm run typecheck`, `npm run build`) |
| Emitted JavaScript | 46 files, SHA-256 `381f8844b17a85e68c0b796f87719d299b5853fb1eced8ec849352e39c4fec19` |
| Complete behavioral suite (`node --test tests/*.test.mjs`) | **409/409 passed**, 0 failed, 0 skipped |
| Clean pack manifest (`npm pack --dry-run --json --ignore-scripts` after a build) | `files=148` |
| `npm run test:packed` | Passed (`packed-smoke: 10 export target(s) and 8 shipped file(s) present`) |
| `npm run test:replay` | `REPLAY OK` — 13 spans, 6 commands compared, contract compliance 1.000, causal closure 1.000, 26/26 payloads verified, 0 provider calls |
| `npm run test:faults` | **20/20 fault scenarios passed** (F1–F17, each proving its injected fault fired) |
| `npm run test:load` | Passed: N=16/32, maximum concurrent leases 8/16, queue high-water 16/32, admission p50/p95 sub-millisecond, exact limit `queue_full@taskClass(implementation)=8/16`, per-worker observation 861B → 864B (BOUNDED) |
| `npm run test:harness`, `test:pack`, `test:profile` | Host-only: they compose a real Harness profile whose sandbox requests `workspace-write`; inside the worker sandbox macOS denies nested `sandbox_apply` (`SandboxUnavailableError`). The owner runs them in the gate |
| `npm run test:isolation` | Host-only: it drives the real sandbox provider through `confinedCheckArgv`; the owner runs it in the gate |
| `npm run test:web`, `test:command-web` | Not run here; they are load-sensitive browser smokes and must run sequentially on an idle host |

The `test:pack` clean checkout materializes only `git ls-files`, so it cannot see
files that the host capture has not committed yet. The integration verified the
equivalent condition directly: a clean directory containing exactly the tracked
tree plus the new untracked sources builds and packs with lifecycle scripts
enabled (208 files, `npm run build` exit 0, `npm pack` produced the tarball). The
owner gate re-runs `test:pack` on the committed artifact.

## Full regression baseline

The first 0.6.0 build contained 42 JavaScript files, with SHA-256:

```text
fac66e2d358725fee2ffe822f26f42fa4f4a2290de802aba48b2cbfb01126bc1
```

| Check | Result on this baseline |
| --- | --- |
| Host/client TypeScript and production browser build | Passed |
| Complete alpha.2 behavioral suite | **192/192 passed** |
| Complete isolated rc.1 behavioral suite | **192/192 passed** |
| Alpha.2 real Harness Loader composition | Passed |
| Rc.1 real Harness Loader composition | Passed on an unchanged retry after the timeout described below |
| Alpha.2 extracted npm artifact | Passed through the real Loader; 135 packaged files |
| Alpha.2 native CLI profile installation | Passed: isolated install, configuration composition and worker lifecycle |
| Alpha.2 native command browser | **10 workflow groups passed** |
| Alpha.2 full sidebar browser | **13 workflow groups passed** |
| Alpha.2 invalid-plan recovery browser | **12 workflow groups passed** |

The first rc.1 Loader run exceeded a fixture's five-second tool timeout during heavy machine load. That run is retained as a failure, not counted as a pass. An unchanged retry passed on the same baseline hash. Final-artifact Loader checks, when listed below, are separate runs.

## Final watch-lifecycle correction

Review found that native owner creation/disposal can change `ownerLive` without changing the swarm database revision. The final correction wakes an outstanding watch on those native lifecycle events and refreshes ownership/connection metadata in keepalive responses, while preserving unchanged mission data.

The final 42-file JavaScript artifact has SHA-256:

```text
3feb18ce3020c002d0b7b9d8356872226b628b178498b3bc44f6381494d9e94d
```

| Check | Result on the final artifact |
| --- | --- |
| Production build and isolated rc.1 host/client typechecking | Passed; rc.1 reused the emitted artifact without rebuilding it |
| Alpha.2 live-state and native Web API regressions | **25/25 passed**, including two new lifecycle/metadata cases |
| Live provider connection through the installed alpha.2 preview | Passed: native session creation, prompt and follow returned the expected fixed response |
| Isolated rc.1 live-state and native Web API regressions | **25/25 passed** |
| Isolated rc.1 Loader, packaged artifact and CLI installation | Passed: real Loader, 135 packaged files, offline install and installed-bundle composition |
| Final alpha.2 native command browser | **10 workflow groups passed**, including activity, watch recovery, hidden-pane catch-up and result application |

The complete 192-test suite was run on the baseline, then the affected live-state/Web API tests were run again after the narrow correction. Lifecycle fixtures now wait for actual session flushing, watch subscription and native-call readiness instead of fixed sleeps. Final rc.1 Loader attempts also exceeded a fixture's five-second verification deadline; its test-only allowance was raised to 30 seconds, retaining all verification assertions and the mission deadline. These fixture corrections did not change the final product artifact. The final focused suite includes two added cases; this is not a claim that a complete 194-test suite was rerun on the final hash. The baseline sidebar and invalid-plan browser evidence is likewise not relabeled as final-hash evidence.

Final browser verification used alpha.2. Rc.1 was verified through its isolated typechecking, focused regressions, Loader, extracted package and native CLI profile; a separate rc.1 browser run was not repeated for 0.6.0.

Digests above concatenate sorted `lib`-relative `.js` paths, a NUL separator and file contents. Source maps, package metadata and documentation are excluded.

## What the workflows exercise

The native command browser submits one `/agent-swarm` goal. Its initial and running views have no visible manual budget fields or four-tab technical bar. A real native model stream waits at the fixture's model-only gate while the panel displays **Agent is thinking** and an elapsed clock tied to that operation's actual start. The test hides the sidebar, lets actual workers finish independent verification, confirms the hidden panel stops issuing state/watch requests, then reopens it and checks the completed state under the same owner. A deliberately failed watch exposes **Reconnecting**; the next successful watch restores the state and keeps the selected owner.

The same workflow starts from staged and untracked source edits. It checks that one frozen project snapshot includes both, runs actual worker tools, accepts the integration artifact independently, and then edits the source again. **View changes** presents only the snapshot-to-result delta. **Apply result** changes the requested code while preserving the later source edit, the real Git index byte for byte and the original HEAD. The invalid-plan variant additionally rejects missing code checks and invalid scopes, then repairs the original request without partial workers, a duplicate mission or changed acceptance/budget decisions.

The full sidebar browser opens the advanced editor explicitly, saves a native model/reasoning choice, and checks that unsaved draft edits survive collapsing and reopening the sidebar (the 0.6.0 run also resized the dock, which round 28 deleted). It exercises Pause/Resume, native live-worker navigation, owner-only controls, Stop confirmation, the technical graph disclosure, a 390-pixel viewport and cold transcripts containing actual host tool output without another model request. Recorded screenshots of thinking, reconnecting, applied results and the responsive layout were visually inspected.

Activity and runtime regressions cover native model/tool operation boundaries, provider retry backoff, cancellation, long-operation renewal, ordinary expiry without a live adapter operation, pause, restart and deadline cancellation while the mission queue is occupied. Store/watch tests cover transaction-only revision changes, rollback, bounded replay, cancellation, owner isolation, mission delta merging, native owner lifecycle and metadata updates without an invented database revision.

## Timing and evidence boundaries

The watch protocol removes a fixed two-second polling wait; it does not promise a latency bound under arbitrary host/browser/network load. The final browser timing method samples each previously unseen mission/event sequence once, only in a delta returned to a continuous observer. Full snapshots, eventless lease updates and the first reply after interruption are excluded. Earlier raw reports sampled the age of the last event even for eventless deltas; those values include idle time and are not treated as delivery latency.

The final alpha.2 command run recorded **11 eligible event samples at 22–235 ms** from host event creation to browser observation. That one local scripted scenario took 89.2 seconds overall, including startup and an intentional reconnect wait, with 14 model-fixture requests and eight real tool calls. These measurements demonstrate event-driven delivery in that run, not a general performance benchmark or service guarantee.

Provider responses in the regression suites were **scripted**. Harness, browser authentication, tools, persistence, Git and filesystem effects were real. These results establish integration behavior, not a real model's planning success rate or a comparative swarm benchmark. The regression suites did not make billable model requests.

A separate minimal live connection check used the installed final artifact and native Harness session creation, prompt and follow APIs with `deepseek-official/deepseek-v4-flash`. It returned the expected fixed response, and the authenticated plugin state recognized the live owner. That check requested no tools and created no swarm mission; it verifies provider connectivity through Harness, not full real-provider swarm planning or acceptance.

The 0.6.0 browser checks exercised the dock fallback; Better Sidebar's public service contract was validated separately on the earlier release, and its registration path was unchanged there. Round 28 deleted the dock: `test:web` and `test:command-web` now open the panel as the host's native right-sidebar tab (see the round-28 entry).

## Reproduce

The behavioral suite has two tiers, listed in `scripts/test-tiers.mjs`. The hermetic tier needs only the packages `package-lock.json` pins, the 0.2.1-rc.2 Harness packages from npm included, so a fresh clone runs it with no Harness checkout:

```sh
npm ci
npm test
```

Everything else needs a built checkout of an exact revision in [compatibility.json](../compatibility.json). Set `DSH_HARNESS_ROOT` as described in the [README](../README.md), link the checkout over the installed packages, and run the gate:

```sh
npm run link:dsh
npm run verify
```

`npm run verify` runs, in order, every suite of the manifest in `package.json` (`gate`) whose prerequisites the machine has: `typecheck`, `npm test`, `test:packed`, `test:replay`, `test:oracle`, `test:load`, `test:faults`, `test:bundle`, `test:harness`, `test:pack`, `test:profile`, `test:isolation`, `test:web`, `test:command-web` and `test:validation-repair-web`. It records the others as skipped with the prerequisite they lacked in `artifacts/gate/<commit>.json`; `node scripts/gate.mjs --plan` lists them before a run. `test:sidebar-service` runs only with `--with better-sidebar`, and the real-provider smokes only with `--with provider`. [Development and verification](operations.md#development-and-verification) describes the prerequisites, the record and the round gate.

Browser checks need the matching Harness Web build and Playwright browser environment. Set `DSH_WEB_SMOKE_ARTIFACTS` to retain separate evidence directories for different host versions. Test profiles and repositories are isolated. Running the large Harness suites and multiple browsers concurrently can increase load enough to exceed small fixture timeouts; run them sequentially when reproducing. The `test:deepseek` and `test:command-deepseek` scripts use real provider credentials and are billable, so `verify` runs them only with `--with provider`. All three browser smokes run through `runWebSmoke` in `scripts/web-smoke-browser.mjs` with one scripted model, `tests/fixtures/web-scripted-llm.mjs`. Without `DSH_WEB_SMOKE_ARTIFACTS`, evidence goes to `artifacts/<smoke>`: `artifacts/web` (formerly `artifacts/sidebar`), `artifacts/command-web` and `artifacts/validation-repair-web`. A `--serve-only` run writes `report.json` with `scenario: "serve-only"` and no checks: it is a served host, not a passed scenario.

The behavioral tests import the built `lib/` output. `npm test` builds first; running a tier directly (`node scripts/test-tiers.mjs hermetic`, or `host`) needs `npm run build` first, otherwise it stops at `ERR_MODULE_NOT_FOUND .../lib/runtime.js`. A clean checkout with neither `npm ci` nor `npm run link:dsh` stops earlier at `tsc: command not found`. The hermetic tier runs as a fresh clone would on any machine: its runner removes `DSH_HARNESS_ROOT` and `DSH_SOURCE`, and `scripts/harness-target.mjs` searches for no checkout while it runs, so a test that needs one fails there until it is listed in the host tier. The two tiers bind the release in different ways: the hermetic tier by the lockfile's integrity hashes for the npm registry's tarballs, the host tier and the other gates by the checkout's commit, which `assertSupportedHarness` compares with `compatibility.json`.

`npm run test:harness`, `npm run test:pack` and `npm run test:profile` compose a real Harness profile whose sandbox requests `workspace-write`, so they require a host that permits nested `sandbox_apply`. Inside an outer workspace-write sandbox, macOS denies it (`sandbox-exec: sandbox_apply: Operation not permitted`) and the composition fails with `SandboxUnavailableError`. `test:pack` and `test:profile` detect an unusable nested sandbox before the composition and abort with that prerequisite; set `DSH_SWARM_SKIP_SANDBOX_PREFLIGHT=1` to attempt the composition anyway. `npm run test:harness` runs the composition directly and reports the same `SandboxUnavailableError`.

`npm run test:faults` needs no sandbox, but its provider-fault tier B (F3a/F3b/F3c) boots the real Harness Loader, so it needs a built supported Harness checkout: `DSH_HARNESS_ROOT` or `DSH_SOURCE`, or else the first of `~/.dsh/source/current` and the sibling `deepseek-harness-021rc2`, in that order, whose version is in [compatibility.json](../compatibility.json), with built `lib/` entries. Without one it fails with `The fault suite needs a built Harness checkout; set DSH_HARNESS_ROOT`. The host-only `npm run test:isolation` drives the real sandbox provider and needs the same built checkout plus a host that permits the platform sandbox; it is not part of the worker check set. The published tarball ships only `package.json` and its `files` list (built `lib/`, `cordis.patch.yml`, the profile bundle, both READMEs, the five `docs/` documents and their images, `compatibility.json`, the naming manifest, `LICENSE`, `NOTICE` and `scripts/packed-smoke.mjs`), so the full suite requires the repository checkout (see [known-limitations.md](known-limitations.md)).

`npm run test:web` and `npm run test:command-web` launch the real Web application and are load-sensitive. Run them sequentially on an idle host, without other large suites or browsers in parallel, and re-run a timeout before treating it as a product defect.

Raw local logs, traces, screenshots, credentials and preview state are excluded from the public repository. Remaining operational boundaries are in [known-limitations.md](known-limitations.md).

## 0.1.6-alpha.2 baseline (2026-09-17)

Host: `~/code/deepseek-harness-016` at release tag `dsh-v0.1.6-alpha.2` (`ddefc45fbc`), built from source. The
plugin checkout was linked to it with `DSH_SOURCE=… npm run link:dsh` after `compatibility.json` gained the release.

What the release changed for this plugin, and what was done about it:

| Host change | Effect here | Change |
|---|---|---|
| `SandboxProvider.confine()` resolves asynchronously | `confinedCheckArgv` returned a promise's fields | `VerificationSandbox.confine` accepts either shape; `confinedCheckArgv` awaits (its two tests await / reject) |
| `agent/created` is a serial hook returning `undefined \| Promise<undefined>` | two `void`-typed listeners failed typecheck | both return `undefined` explicitly; they stay synchronous, as the serial contract requires |
| client Sessions are multi-instance: `SessionListState.current` / `currentAddress` and `sessions.open()` removed | eight client sites read the selection; worker navigation was a no-op | `currentSessionId()` reads the main view's `retainedBy.mainView` count (falls back to `current` on older hosts); `openWorker` navigates through `uiWorkspace.openSession` when `sessions.open` is absent; panes prefer their own `sessionId` |
| right-sidebar guide entries require a stable `id` (duplicates throw) | the capsule shipped `entryId: undefined` | `id: 'open'` on the guide entry; `openTabIn(sessionId, kind)` is tried before the throwing `openTab` |
| `Inbox` is no longer a runtime export of `dsh-agent` | `tests/planner.test.mjs` could not import it | the owner fixture writes the same durable `agent/inbox/spliced` record both real inboxes write |
| `snapshotEvents` / `eventAt` / `ownEvents` deprecated | seven call sites | unchanged for this release (still implemented); migration scheduled |

| Check | 0.1.6-alpha.2 (`ddefc45fbc`) |
|---|---|
| `tsc -p tsconfig.json` / `tsc -p tsconfig.client.json` | exit 0 / exit 0 |
| `npm run build` | exit 0 |
| `node --test tests/*.test.mjs` | 1179 tests, 1178 passed in the parallel run; the one failure (R15-D1) and two earlier ones (R15-D2, R16-A4) are timing-bound "hung worker" cases that pass on every isolated re-run |
| isolated preview (`scripts/start-preview.mjs`, `DSH_SOURCE` = the 0.1.6 checkout) | boots with no `did not activate` row and no startup diagnostics file |
| `POST /api/agent-swarm/state` without the browser credential | 401 (route mounted; the retired `/agent-swarm` channel answers 405, as on 0.1.5) |
| right sidebar with a workspace selected | the Start page lists an **Agent Swarm** capsule beside Workspace files, New terminal and Browser; the fallback dock is not rendered |

Not exercised on this host: a full mission (member sessions, verification checkouts, the delivery flow).
