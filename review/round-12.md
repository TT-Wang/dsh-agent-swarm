# Round 12 — consolidated full-`src/` code review (M1–M4)

**Baseline.** All four surveys read the same uncommitted base state of branch
`codex/fix-review-20260913`, captured per worktree at spawn: M1 @ `71958b1`, M3 @
`e770264`, M4 @ `6fe0259` (M2's notes record no hash; same base state). This consolidation
was written on `feat/write-consolidated-review-report` from the four missions' notes alone;
no product code was re-read or modified.

**Method.** Four read-only surveys ran in parallel over disjoint file scopes (§1). Every
finding was recorded by its source mission with `file:line`, a severity, and a concrete
consequence; each mission also listed the paths it traced and found sound. This report
merges those notes, deduplicates across missions (no cross-mission duplicates found; the
two near-miss pairs are cross-referenced in §5), and drops entries the source missions
themselves excluded as pinned/deliberate or disproven (e.g. M1's unreachable
`observe()`-note dead-code remark, M3's pinned behaviors). No finding below is a style
suggestion. Documentation-only artifact: per AGENTS.md, no runtime tests were required or
run; the declared check of round 11 is untouched.

**Count reconciliation.** The tower briefing totals for M1 (16: 1 high / 3 medium / 12 low)
and M3 (10: 2 medium / 8 low) match the mission notes exactly. M2's notes contain 13
entries (2 medium / 11 low) against the briefing's 11, and M4's notes contain 7 entries
(1 medium / 6 low) against the briefing's 8 — this report follows the mission notes, which
are the authoritative evidence. Grand total: **46 findings — 1 high, 8 medium, 37 low; no
critical.**

## 1. Scope map and totals

| Mission | Scope (all under `src/`) | Critical | High | Medium | Low |
| --- | --- | --- | --- | --- | --- |
| M1 runtime core | `runtime.ts`, `store.ts`, `trace.ts` | 0 | 1 | 3 | 12 |
| M2 scheduling & workspace | `scheduling.ts`, `scheduler.ts`, `workspaces.ts`, `workspace-admission.ts`, `admission.ts`, `git-snapshot.ts`, `scope.ts`, `watch.ts` | 0 | 0 | 2 | 11 |
| M3 collaboration protocol | `notices.ts`, `arena.ts`, `attempts.ts`, `roles.ts`, `planner.ts`, `plans.ts`, `delivery.ts`, `owner-reply.ts`, `refusals.ts`, `declared-checks.ts`, `authorization.ts`, `gates.ts`, `invariant.ts` | 0 | 0 | 2 | 8 |
| M4 harness integration & client | `harness-workers.ts`, `index.ts`, `web-api.ts`, `tools.ts`, `types.ts`, `command.ts`, `live-types.ts`, `projection.ts`, `model-selection.ts`, `session-metadata.ts`, `client/**` | 0 | 0 | 1 | 6 |
| **Total** | all of `src/` | 0 | 1 | 8 | 37 |

Finding ids keep their source-mission numbering for traceability (`M1-R1` … `M1-T3`,
`M3-MED-1`, `M4-F1`, …). M2's notes carried no ids, so this report numbers them `M2-1` …
`M2-13` in note order (scheduling → workspaces → admission/git-snapshot). Full evidence for
every entry lives in the corresponding mission note (§8).

## 2. High findings

- **M1-R1 — The tick callback is not failure-contained for 4 of its 5 guard steps**
  (`src/runtime.ts:951-967`). `pumpOutbox()`, `sweepStarts()`, `checkSchedulingPasses()` and
  the mission loop (`blockBudget`/`warnBudget`/`kick`) run with no try/catch; only
  `sweepDecisions` is wrapped (`src/runtime.ts:1041-1045`, "A sweep must never break the
  tick"). A reachable throw path exists: `sweepStarts` (`src/runtime.ts:2743-2751`) →
  `failStart` (2816) → `commit` (2830) → `store.transaction` can throw `WriterBusyError`
  after exhausted retries (`src/store.ts:179`) — an error class the rest of the system
  treats as routine contention (`assign()` catches it at `src/runtime.ts:1776`).
  **Consequence:** an exception escaping a `setInterval` callback is an uncaughtException —
  with no host handler the process exits (all missions down); even with a handler, that
  tick's remaining guards (outbox pump, pass watchdog, budget gates) are silently skipped.
  The asymmetry with the wrapped `sweepDecisions` shows the risk was known but only one
  step was contained.

## 3. Medium findings

- **M1-R2 — Member-row lost update via stale object write in `onStartFailure`**
  (`src/runtime.ts:3911-3917`, `3731-3743`; also `recordProviderOutage` at 3641).
  `ensureWorkers` reads the member, awaits `workers.start`, then on failure mutates and
  `store.put('members', …)` the **pre-await** object; member/mission/delivery rows have no
  compare-and-swap (only tasks do, `src/store.ts:427-436`). The same exposure exists when
  `exclusive()`'s `boundedQueueWait` times out and two mission bodies overlap
  (`src/runtime.ts:1081-1089`). **Consequence:** fields committed during the awaited start
  (activity, providerOutage) are silently overwritten; stale
  phase/startFailures/providerOutage resurrect or erase newer state and the derived member
  status (`src/projection.ts`) is mis-computed until the next write.
- **M1-R3 — `runtime.start()` awaits adapter worker starts serially with no timeout or
  abort** (`src/runtime.ts:932-935` → `ensureWorkers` 3910-3919; `abortableStart` exists at
  34-43 but is only used for `prepareBaseline`/`launchDraft`). **Consequence:** a wedged
  `workers.start` promise hangs `start()` forever and blocks worker recovery for every
  later mission; the ticker is installed first so notices keep flowing, but the plugin
  start call itself never resolves.
- **M1-T1 — TraceRecorder's span index silently truncates at `SEED_LIMIT` (20000) events**
  (`src/trace.ts:613`, `656-663`; `parentFor` 684-705; `traceMetrics` 770-805). The seed
  read returns the *newest* page, so on longer missions earlier spans are never seeded and
  new spans link to the wrong parent. **Consequence:** on long missions the trace's
  causal-closure metric and parent chains degrade silently while reporting
  contract-compliant spans; nothing bounds or flags the truncation (unlike
  `readEventHistory`, which at least sets a `truncated` flag).
- **M2-1 — Pass-timeout wedge escalation is suppressed by a prior no-progress escalation
  for the same board fingerprint** (`src/scheduling.ts:933`; shared key written at 981; the
  R15 comment at 936-944 says a wedge must be named "whether or not the board was already
  announced"). Both escalation variants write the same `schedulingStallNotice` fingerprint,
  so a wedge after a no-progress escalation of the same board returns early.
  **Consequence:** the most serious scheduling condition (pass guard broke and was
  released) can be absent from the durable event log and the owner inbox — no
  `mission/stalled wedged:true` event, no owner notice, no witness; only the pass row's
  `releases`/`worstRelease` records it. Fix direction: dedup per `info.reason`.
- **M2-4 — Artifact/dependency commits are validated and merged against the source repo's
  object store, but no source ref protects them from gc** (`src/workspaces.ts:1271-1273` +
  1144 + 846-850). After R11-14, artifact commits are pushed only to the per-mission bare
  repo; in the source store they stay reachable only via the member worktree's HEAD/index,
  which `prepareTask` detaches on the next task (1136). A host-side `git gc --prune=now`
  then prunes the commit and `validateArtifact`/`git merge <artifact.commit>` fail with
  exit 128. **Consequence:** verifications cannot run and dependent tasks cannot prepare;
  recovery credits burn and guard-chain escalations fire, with no in-code recovery —
  nothing fetches the commit back from the mission's own artifact repo, which R11-14 made
  durable for exactly this scenario. Likelihood requires explicit aggressive gc (default
  pruneExpire is 2 weeks).
- **M3-MED-1 — An uncloseable open question on a terminal mission pins the full owner role
  forever** (`src/roles.ts:51` vs `src/runtime.ts:1148` + `src/notices.ts:132`). `roleOf`
  keeps a session in `owner` role while any mission has an unanswered owner question
  (durable, survives restart), but the only receipt-settling path throws for non-active
  missions, and for stopped missions `ownerDeliveryMoot` (`src/notices.ts:131-135`) even
  refuses delivery. **Consequence:** an unanswered question on a stopped/completed mission
  is undeliverable-and-unsettleable yet pins the full owner prompt + management tools
  indefinitely; the `historical-owner` downgrade never happens.
  `tests/roles.test.mjs:207-228` pins the retention half; the uncloseability is the
  unpinned gap.
- **M3-MED-2 — The block-mode owner-reply pre-step hook is never disposed**
  (`src/owner-reply.ts:183` registration vs 74-79 dispose). The cordis disposer return
  value of `agentCtx.on('agent/pre-step', …)` is discarded; `dispose()` removes only the
  session/event listener. Dormant by default (`ownerReplyGuard:'block'`; default is
  `'nudge'`, `src/index.ts:105`). **Consequence:** with block mode on, every owner session
  that ever blocks keeps a live middleware hook for the agent's lifetime, retaining the
  disposed guard and the closed SwarmRuntime (GC leak); after a plugin reload a second
  inert hook attaches to the same agent. Violates AGENTS.md "Every registration and worker
  handle must be disposed on unload."
- **M4-F1 — A malformed state/delta puts the live pane in an unrecoverable reconnect
  loop** (`src/client/monitor.ts:65-88`, `100-104`). On a `validateState` failure the
  monitor retries `watch` with the same unchanged revision, so the host sends the same
  delta and validation fails identically forever (backoff caps at 15 s); a full re-read
  cannot help because it validates the same store content, and `validateState` rejects the
  entire state when any single snapshot fails `readSnapshot`, so one version-skewed mission
  takes down every mission in the pane. **Consequence:** after a plugin/host field skew —
  the exact case `readSnapshot` exists for — the sidebar sits at "Reconnecting"
  indefinitely for all missions; only re-selecting the conversation (`select()`,
  `src/client/monitor.ts:28-43`) resets the revision.

## 4. Low findings

### 4.1 M1 — runtime core

- **M1-R4** (`src/runtime.ts:1758`) — `assign()` sets the initial attempt lease unclamped
  (`Date.now() + leaseMs`) while every renewal clamps to the mission deadline (3516, 3602).
  Consequence: nil in practice (`guard()` checks the deadline first, 3477); lease
  bookkeeping is inconsistent.
- **M1-R5** (`src/runtime.ts:2153-2155` vs 2161-2167) — `escalate()` contradicts its
  documented ownership invariant: the ownership check only runs when `attemptId` is also
  supplied, so a member passing only `taskId` can attach any other member's task as
  escalation provenance. Consequence: wrong attribution on a durable record the owner acts
  on; no authority is granted.
- **M1-R6** (`src/runtime.ts:3389` vs 1411) — `updateBudget` counts stopped members against
  `maxWorkers` while `addMember` counts only live members. Consequence: lowering
  `maxWorkers` is refused against the historical admitted total, not the live headcount.
- **M1-R7** (`src/runtime.ts:3479`) — `guard()` blocks worker tools by unanchored substring
  regex (`/subagent|spawn_agent|agent_teams|cordis|plugin|workflow|ralph/`). Consequence:
  false-positive denials of unrelated host tools whose names merely contain those
  substrings.
- **M1-R8** (`src/runtime.ts:2485-2526`) — missing-review dedup is bounded by the
  `config.maxEvents` window; on very long missions a runtime restart can re-emit a
  duplicate `task/review-missing` audit row for an old submission. Consequence: bounded
  duplicate durable audit. (Same window-bound theme as **M2-2** — see §5.)
- **M1-R9** (`src/runtime.ts:2356-2360` vs `cancel()` at 2597) — `challenge()` moves
  ACCEPTED dependents to blocked (epoch++, `dropAttempt`) while `cancel()` declares
  accepted work immutable; the dependent's previously verified evidence rows stay
  `verified`. Consequence: an upstream evidence challenge effectively reverses accepted
  downstream work — plausibly intended invalidation semantics, but it contradicts the
  immutability guarantee stated at the cancel boundary; flagged as a design question.
- **M1-R10** (`src/runtime.ts:3954-3956`) — `dispose()` is not re-entrant-safe: a second
  call while the first is still draining returns immediately without awaiting the
  in-flight teardown. Consequence: a caller awaiting the second dispose can proceed while
  teardown is still running.
- **M1-S1** (`src/store.ts:682-683`) — `restore()` deletes stale WAL sidecars *after* the
  rename; a crash between `renameSync` and the `rmSync` lets the next raw SQLite open
  replay the old database's WAL frames onto the restored snapshot. Consequence: silent
  page-level corruption of restored state — mitigated in the supported composition
  (`applyPendingRestore`, 774-780, re-restores before opening), exposed on a direct
  `SwarmStore` open. Fix direction: delete `-wal`/`-shm` *before* the rename.
- **M1-S2** (`src/store.ts:307-313` → 454-458; success path 296-317) —
  `pendingStaleRefusals` is only flushed on the transaction *failure* path; a transaction
  body that catches `StaleTaskRevisionError` internally and still commits silently drops
  the durable `task/stale-revision-refused` audit row (or misattributes it into a later
  unrelated flush). Consequence: latent today (no in-scope call site swallows the error),
  but the S5 guarantee "every refused stale write is visible in the mission record" is
  voidable by one future defensive catch.
- **M1-S3** (`src/store.ts:262-281`) — the lock-file PID check is vulnerable to PID reuse:
  `process.kill(lock.pid, 0)` succeeding for a recycled pid refuses startup with "already
  owned by process X" until the lock is removed by hand. Consequence: documented-style ops
  hazard; the restore path (664-676) handles dead pids but normal open does not distinguish
  a recycled one.
- **M1-T2** (`src/trace.ts:1121-1123`, 1126) — replay attempt closers match by *task* id
  and delete all open attempts on that task; if attempt A never reached a fencing event
  (log truncation) but the task was re-dispatched as attempt B and B closed, the single
  closer deletes both and `ReplayTruncationError` is not raised. Consequence: detection gap
  in the replay truncation gate, not data corruption.
- **M1-T3** (`src/trace.ts:971`) — `readEventHistory`'s `truncated` flag is off by one
  (`all.length >= HISTORY_SCAN_LIMIT`): a mission with exactly 100000 events reports
  `truncated=true` although nothing was truncated. Consequence: cosmetic metric inaccuracy
  on the owner read path.

### 4.2 M2 — scheduling and workspace lifecycle

- **M2-2** (`src/scheduling.ts:576-588`) — `unreviewedStall` measures the grace from the
  durable `task/submitted` event inside the bounded retained window; if that event ages
  out, the detector returns false forever. Consequence: this one detector stays silent for
  that artifact — bounded, because `admitMissingReviews` (`src/runtime.ts:3935`) and the
  row-based `review_admission` guard terminal (`src/scheduling.ts:1518`) still cover the
  stuck submission. (Same window-bound theme as **M1-R8** — see §5.)
- **M2-3** (`src/scheduling.ts:408-410` vs 281-289/225) — `dispatchQuestion`'s "refused by
  mission admission limits or budget" verdict is not exhaustive of the dispatcher's own
  refusal causes: a task filtered by the R12-F9 dependency-assumption guard, or a member
  refused by the isolation invariant, is misattributed to admission limits/budget.
  Consequence: the owner receives one correct notice (the coded escalation fires
  separately) and one misattributed one — misleading diagnosis text, not a missing
  escalation. (Instrument/dispatcher divergence theme shared with **M3-LOW-3** — see §5.)
- **M2-5** (`src/workspaces.ts:283`) — dead regex branch: `/^$\s+(\S.*\S|\S)\s*$/` can never
  match (the `$` is the end anchor, not an escaped literal), so the documented
  `$ command` stage-banner form is never captured (verified by exact-code repro).
  Consequence: `CheckAttribution.stage` misses `$`-prefixed banners (common CI convention)
  → weaker failure-attribution evidence; verdicts (exit codes) unaffected.
- **M2-6** (`src/workspaces.ts:275`) — spec-reporter dedup undercounts distinct same-named
  failing tests: a second failure with an identical name is dropped before
  `failingTestCount++` (verified by exact-code repro: two distinct same-named failures yield
  count 1 while the reporter's own summary says `fail 2`). Consequence: the attribution
  count/list under-reports real failures; verdicts unaffected.
- **M2-7** (`src/workspaces.ts:1053-1059`) — a member workspace is permanently bricked
  after a crash between `worktreeAdd` and `writePrivateJson`: the retry takes the creation
  path and `git worktree add` fails ("already exists"); there is no adopt/validate-or-clean
  path (contrast 1000-1007 and 820). Consequence: every `prepareWorkspace` retry fails →
  W18 recovery credits burn → task blocked + `dispatch_preconditions` escalation; manual
  `rm` required. Narrow trigger window.
- **M2-8** (`src/workspaces.ts:837` vs 804-806) — the artifact-repo identity marker is
  written with plain non-atomic `writeFile` while `readJson` throws on parse failure; a
  crash mid-write leaves a truncated marker and every later `createArtifactRepo` call
  propagates the JSON.parse error (no rebuild for present-but-corrupt, unlike 819-821).
  Consequence: all artifact publishes for the mission fail permanently until the file is
  removed by hand. Narrow window; hard failure.
- **M2-9** (`src/workspaces.ts:1563-1564` + 1567) — two dependency-materialization gaps in
  the default copy mode: (a) a dependency directory that is itself a symlink in the source
  (pnpm/monorepo store layouts) is silently skipped — neither copied nor reported — so
  declared checks fail with exit 127 and the guidance misdiagnoses the cause; (b)
  `cp(verbatimSymlinks: true)` copies relative symlinks whose targets live *outside* the
  source tree, which then dangle or resolve to host paths outside the checkout,
  undercutting copy mode's stated no-resolve-back property (read-side only; writes stay
  sandboxed). Consequence: verification fails or reads unintended host paths for
  external-store projects in default mode.
- **M2-10** (`src/workspace-admission.ts:158-165`) — `unquotedShellText` treats *any*
  unquoted `#` as a comment start, but POSIX starts a comment only when `#` begins a word.
  Verified by exact-code repro: `curl http://h/p#frag && git commit -m x` and
  `echo foo#bar; git add .` yield `deniedGitWrite === undefined`. Consequence: for this
  subset of real git-write attempts the worker gets no typed `gitWriteDeniedMessage`
  guidance and the attempt does not latch the `gitWriteDenied` marker — the sandbox still
  blocks the write, so this is guidance/latch degradation, not a safety hole.
- **M2-11** (`src/workspace-admission.ts:516`) — `isolationAllows` matches violations with
  `entry.includes(member.id)` over formatted prose; member display names are agent-chosen
  and embedded in the violation text (545), so a member named to embed a sibling's id is
  refused by violations that do not concern it. Consequence: same-mission denial of
  dispatch against one member; requires an adversarial/confused member name. Fix direction:
  return structured violations (member ids) instead of matching substrings in prose.
- **M2-12** (`src/git-snapshot.ts:119-120` with 47-102) — a HEAD-tracked file removed from
  the real index via `git rm --cached` that also matches an ignore rule is still captured
  in the snapshot (private index seeded with `read-tree HEAD`, `git add --all` keeps it),
  contradicting the documented "tracked and nonignored untracked content" contract (108).
  Consequence: content the user deliberately untracked-and-ignored flows into swarm
  workspaces — safe direction (never loses user work), but a fidelity leak.
- **M2-13** (`src/git-snapshot.ts:128-129`) — residual v1→v2→v1 race: the before/after
  fingerprint comparison cannot detect content that changes during `git add --all` and
  reverts to its original bytes before the after-scan. Consequence: a snapshot tree that
  never matched a consistent source state (millisecond window; any other mismatch fails
  closed into one of 3 retries).

### 4.3 M3 — collaboration protocol

- **M3-LOW-1** (`src/refusals.ts:134-136`, 157-167) — `rt.writerBusy` is a single slot; a
  second `WriterBusyError` overwrites the first pending recovery. Consequence: two refusals
  hitting a busy writer before the flush lose the first one's durable `writer_busy`
  admission row — accounting loss only, no state corruption.
- **M3-LOW-2** (`src/refusals.ts:413-415`, 157-167) — `emitGuardTerminal`'s
  `WriterBusyError` path fabricates a synthetic admission candidate (taskClass `research`,
  scope `**`, taskId `?? 'unknown'`, epoch 0) that is later persisted as a durable
  `writer_busy` admission row that never was an admission decision. Consequence: misleading
  durable record; owner-visible if the admissions ledger is read.
- **M3-LOW-3** (`src/arena.ts:73-88` vs `src/gates.ts:166`, 199) — two readiness predicates
  can disagree about the same board: `pendingReadiness` is assignee-agnostic and ignores
  exhausted task ceilings and handle readiness, while the dispatcher uses `rt.ready`.
  Consequence: owner instruments can show `pendingDispatchable: 1` while the dispatcher
  never dispatches — the instrument/dispatcher divergence R17-G1
  (`src/notices.ts:831-838`) was written to preclude, in the one view it doesn't cover.
  Instrumentation-only.
- **M3-LOW-4** (`src/notices.ts:791`, 281-287, 824; `src/runtime.ts:2080-2088`) —
  `wakePrecision` counts non-decision owner deliveries as decisions (member→owner questions
  carry no notice row and inflate `decisions.total` and `byFamily.unknown`). Consequence:
  measurement noise in the R16-A instrument; false-wake/missed-obligation math is
  unaffected.
- **M3-LOW-5** (`src/owner-reply.ts:86-90` vs `src/roles.ts:82`) — the owner-reply guard
  counts ANY `turn/end`, not only completed ones. Consequence: aborted/errored owner turns
  (user escape, model error) burn the bounded nudge budget (default 2), advancing toward
  the `owner_reply` guard terminal (142-150) on spurious grounds. Unpinned by existing
  tests.
- **M3-LOW-6** (`src/attempts.ts:354`, 472) — an unprotected `await workers.stop(...)` gates
  the automatic re-pend in two recovery paths; a transient adapter failure leaves the task
  blocked with the recovery credit already spent (332, 465) and no retry of the stop, and
  in `recoverExpired` the throw also aborts the remainder of that sweep pass (retried next
  tick). Consequence: automatic recovery downgrades to a stall-root owner decision after
  `stallPassTimeoutMs`. The stop-before-re-pend ordering is safety-correct; the gap is only
  the missing catch/retry, inconsistent with the wrapped `captureArtifact` call 20 lines
  above (426-451).
- **M3-LOW-7** (`src/roles.ts:82-85`) — turn-end handled-marking race: on any completed
  `turn/end`, ALL pending delivery ids move to handled, including a notice spliced into the
  session after the model's last step of that turn. Consequence: a notice can count as
  handled though never processed, allowing downgrade to historical-owner while an unhandled
  decision notice exists (questions are protected by the separate `openAsks` disjunct at
  `roles.ts:51`). Narrow race; the durable notice itself is not lost.
- **M3-LOW-8** (`src/gates.ts:333-335`) — the `budgetWarned` latch is not reset when the
  budget is raised, so the 0.7/0.9 warnings for the NEW limit never fire (only a crossing
  strictly above the old threshold would). Consequence: advisory budget-warning events
  only; enforcement (`blockBudget`) is unaffected.

### 4.4 M4 — harness integration and client

- **M4-F2** (`src/web-api.ts:426-427`) — unhandled rejection on unload: the disposal effect
  runs `void release()` over the route releases; a rejecting release is unobserved during
  plugin unload. Consequence: unobserved rejection at teardown; should be
  `void release().catch(...)` like the logger-guarded paths at 221 and 412.
- **M4-F3** (`src/web-api.ts:263-267`) — the `models` endpoint is all-or-nothing across
  providers (`Promise.all` over `listModels`): one provider whose listing rejects (auth
  expiry, network) fails the whole catalog with internal-error. Consequence: limited to
  external consumers of the published `SWARM_WEB_ENDPOINTS` contract
  (`src/types.ts:615-618`); no in-repo client calls this endpoint.
- **M4-F4** (`src/client/ActivityPanel.tsx:90`, 98-108, 127-136, 56-58, 73) — an in-flight
  control/cancel whose context changes mid-flight never settles: two context-change paths
  (the auto-select effect and the selection fallback) bypass `choose()`'s busy reset, so
  `setBusy('')` never runs and ALL mission controls stay disabled, and `monitor.refresh()`
  is skipped so the pane shows stale state. Consequence: recovers only when the user
  changes the selection or conversation.
- **M4-F5** (`src/client/projection.ts:181-221` vs consumers) — `readSnapshot` validates
  fewer fields than its own contract ("Every field a renderer dereferences is validated
  here"): unvalidated-but-dereferenced fields include `task.usedSteps`/`maxSteps`
  (`progress.ts:85-87` → NaN percent), `recoveryCount`/`maxRecoveryAttempts`/
  `resumeAfterStop` (`progress.ts:395-425`), `mission.budgetPause` (renders
  `mission.budgetPause=undefined`), `workerUsage`/`ownerUsage` (`SwarmBoard.tsx:276` prints
  "undefined"), `member.activity` (`progress.ts:81`). Consequence: a malformed/skewed
  snapshot renders garbage values in exactly the fields the validation layer was built to
  protect, instead of dropping the snapshot. Host-authenticated channel, so
  defense-in-depth.
- **M4-F6** (`src/client/DraftEditor.tsx:34-42`) — `ModelPicker` destroys a server-valid
  "model without provider" selection: the extra option's key can never match a catalog
  route, so selecting it calls `onChange({provider: undefined, model: undefined, …})` and
  wipes the member's model, although the server explicitly accepts model-only members
  (`src/model-selection.ts:47-52`; `src/web-api.ts:384`). Consequence: one click in the
  picker silently discards a valid saved selection.
- **M4-F7** (`src/harness-workers.ts:769-773`, 838-849, +454-474) — crash-window duplicate
  delivery: `deliver()` journals the message BEFORE `agent.send` and marks
  `resident.delivered` AFTER send; a crash between send and flush keeps the journal plus
  the un-acked outbox entry, and on restart `restoreInbox` re-appends the journaled message
  while `resident.delivered` — rebuilt only from session events — misses the id, so the
  outbox redelivery sends the same message id a second time. Consequence: the model may
  observe one assignment twice (sub-second, crash-only window); whether the host inbox
  dedupes by id is not pinnable from this repo.

## 5. Cross-cutting constraints and correlated findings

- **TraceRecorder must never be called inside a runtime commit (M1 → M4, not
  corroborated).** `TraceRecorder.record()` opens its own `store.transaction`
  (`src/trace.ts:723`), so any caller invoking it from inside a runtime commit would hit
  "Nested swarm transactions are not supported". M1 flagged the constraint for the
  `src/tools.ts` reviewer; M4's survey of `tools.ts` (24 registrations, fiber-scoped
  disposal; span-on-error path at 261-264 verified) surfaced **no** call path that invokes
  `record()` from inside a runtime commit. Status: constraint stands as documented; no
  violating call path exists today. Keep as a standing invariant for future callers — a
  one-line guard or comment at the `record()` entry would make the invariant
  self-enforcing.
- **Same-file fix grouping (suggested by M3, endorsed here).** `src/roles.ts`:
  **M3-MED-1** (uncloseable open question pins owner role, line 51) and **M3-LOW-7**
  (turn-end handled-marking race, lines 82-85) both live in the role-scoping logic and
  should be fixed together — both concern what keeps a session in full owner role.
  `src/owner-reply.ts`: **M3-MED-2** (pre-step hook never disposed, line 183) and
  **M3-LOW-5** (aborted turns burn nudge budget, lines 86-90) both live in the owner-reply
  guard and should be fixed together.
- **Bounded-window detection gaps (cross-mission theme, not duplicates).** **M1-R8**
  (missing-review dedup loses both the in-memory set and the durable gate when the events
  scroll past `maxEvents`) and **M2-2** (`unreviewedStall` measures grace from a
  `task/submitted` event inside the same bounded window) are independent detectors with
  the same root limitation: durable evidence read through the `maxEvents` window. A shared
  fix (a durable marker outside the event window, or an explicit `truncated` fallback)
  would close both.
- **Instrument/dispatcher divergence (cross-mission theme, not duplicates).** **M2-3**
  (owner notice misattributes dependency-guard/isolation refusals to admission limits) and
  **M3-LOW-3** (`pendingReadiness` disagrees with `rt.ready`) both make owner-visible
  instruments diverge from dispatcher reality in views the R17-G1 instrument does not
  cover. Worth one instrument-consistency pass across `scheduling.ts`, `arena.ts` and
  `gates.ts`.

## 6. Open questions (unverified, carried from M2)

1. **Can `emitGuardTerminal` throw inside dispatch's outer catch
   (`src/scheduling.ts:352`)?** If so, the error escapes the Round-14 containment. The
   answer depends on `refusals.ts` behavior on closed stores, which neither M2 nor M3
   exercised (M3's refusals findings **M3-LOW-1/2** concern the writer-busy recovery path
   on open stores). Recommended: a targeted fault test that closes the store under a
   guard-terminal emission.
2. **Would `store.changesSince` commits with empty scope sets be invisible to `watch.ts`
   waiters?** No evidence such commits exist; `watch.ts` itself was verified clean
   (subscribe-before-inspect ordering, conservative resolution of compacted cursors).
   Recommended: either an assertion that scope sets are never empty at commit, or a
   documented invariant.

## 7. Verified-clean coverage (no findings, for the record)

Each mission recorded the paths it traced and found sound; the highlights:

- **M1:** the core transaction/CAS path of `store.ts` (BEGIN IMMEDIATE retry scoping,
  `putTask` compare-and-swap, `changesSince` window boundaries, `recordPost` MAX(seq)+1,
  snapshot `VACUUM INTO`, `stageRestore` path confinement, `applyPendingRestore` ordering);
  `trace.ts` spill guards, payload-store serialization and ceiling enforcement, span
  vocabulary checks, `canonicalJson` determinism, durable-log decoding, orchestrator-command
  graph validation, host-telemetry failure containment.
- **M2:** the dispatch sweep's suspected assign race (does not exist — passes are
  serialized through `exclusive()` and the prepare→assign window contains no await);
  `CheckSemaphore` acquire/release in all interleavings; `runProcess` abort/deadline
  merging; `captureArtifact` double scope-check and committed-symlink re-walk; `prepareTask`
  rollback fidelity; `withTaskRecordLock` stale break; submodule handling and snapshot
  retry logic in `git-snapshot.ts`; all `scope.ts` boundary cases; `watch.ts` wakeup
  ordering; `scheduler.ts` admission determinism; `admission.ts` ignored-deliverable and
  host-only-script handling; the suspected ambient-credential leak into declared checks
  (does not exist in the production composition — `checkEnv` comes from the scrubbed scoped
  environment, `src/harness-workers.ts:314`).
- **M3:** `authorization.ts` containment/expiry/revocation fencing incl. X3 fail-closed;
  `plans.ts` validation (size cap, key format, cycle detection, review independence);
  `delivery.ts` merge-then-publish with fingerprint re-checks and receipt idempotency;
  `declared-checks.ts` retry pairing; `attempts.ts` re-read + CAS discipline; `notices.ts`
  fact-key dedup, wake-budget detach-at-handoff, absence-net dedup; `invariant.ts`
  pre-append veto; `gates.ts` budget stop fencing; `roles.ts` restart rebuild.
- **M4:** worker start/stop/dispose concurrency (no double `handle.dispose` race; closing
  set synchronously); constructor registrations removed in `dispose()`; `runtime.dispose()`
  awaiting `workers.dispose()`; stranded-inbox FIFO/exactly-once; `readScratch` containment
  under symlink-swap TOCTOU; `src/index.ts` resource scoping under `ctx.effect`/`ctx.inject`;
  all 24 `src/tools.ts` registrations (fiber-scoped disposal, H4 workspace binding, D6 span
  on error, parse-only syntax check, verdicts read from recorded outcomes); `command.ts`
  bounds; client `monitor.ts` cursor/generation fencing, `mergeUpdate` full validation,
  history pagination guards, sidebar adapter idempotency, render-inert text, `SidebarDock`
  style restoration; web-api input handling (byte bound, per-field validators, allowlist
  fail-closed, owner-only authorization, scope-filtered watch deltas).

## 8. Conclusion and recommended fix priority

**Overall conclusion.** The codebase is in good shape: no critical findings and a single
high across a full-`src/` review, with the core transactional, CAS, containment and
lifecycle paths explicitly verified sound. The findings cluster into three actionable
themes: (1) failure containment around the tick and recovery paths (M1-R1, M1-R3, M3-LOW-6,
M4-F2), (2) durable-state write discipline — stale-object writes, escalation dedup keys,
gc-exposed artifact commits (M1-R2, M2-1, M2-4, M1-S1/S2), and (3) bounded-window and
instrument-consistency gaps that degrade owner-visible diagnosis without corrupting state
(M1-R8, M2-2, M2-3, M3-LOW-3, M1-T1). Most lows are narrow-window crash races, misleading
diagnostics, or measurement noise — worth fixing but not urgent.

Recommended order:

1. **P0 — M1-R1** (high): wrap the four unguarded tick steps in the same containment
   `sweepDecisions` already has. Small, mechanical change that removes the only
   process-fatal path found in this review.
2. **P1 — silent-failure mediums:**
   - **M2-1** — separate the wedge/no-progress escalation dedup keys so a wedged pass guard
     is always named in the durable log and the owner inbox.
   - **M1-R2** — re-read the member row after the awaited start (or extend the task-row CAS
     pattern to member rows) before `onStartFailure` writes.
   - **M1-R3** — bound `ensureWorkers` starts with the existing `abortableStart` so a wedged
     adapter cannot hang plugin start and recovery for later missions.
   - **M2-4** — validate/merge artifact commits against the per-mission artifact repo (or
     fetch from it on demand), closing the gc window R11-14's durability was designed for.
3. **P2 — paired protocol fixes (same-file groups from §5):**
   - `src/roles.ts`: **M3-MED-1** + **M3-LOW-7** — let terminal-mission questions be settled
     (or exclude them from `openAsks`), and only mark deliveries handled that were actually
     presented in the completed turn.
   - `src/owner-reply.ts`: **M3-MED-2** + **M3-LOW-5** — push the pre-step disposer into
     `this.removals`, and count only `completed` turn-ends against the nudge budget.
   - **M1-T1** — bound or flag the trace span-index truncation so the causal-closure metric
     cannot silently degrade on long missions.
   - **M4-F1** — make the client monitor drop/reset the poisoned revision (or validate
     snapshots independently) so one skewed mission cannot wedge the whole pane.
4. **P3 — lows, batched by file to keep reviews small:** `workspaces.ts` (M2-5, M2-6, M2-7,
   M2-8, M2-9), `refusals.ts` (M3-LOW-1, M3-LOW-2; start with **M1-S1** in `store.ts` —
   one-line reorder with a corruption-class consequence), `runtime.ts` bookkeeping
   (M1-R4…R8, M1-R10; **M1-R9** needs a design decision on challenge-versus-immutability
   first), `scheduling.ts`/`arena.ts`/`gates.ts` instrument consistency (M2-2, M2-3,
   M3-LOW-3, M3-LOW-4, M3-LOW-8), `attempts.ts` (M3-LOW-6), admission/snapshot fidelity
   (M2-10…M2-13), web-api/server (M4-F2, M4-F3, M4-F7), client validation and controls
   (M4-F4, M4-F5, M4-F6).
5. **Open questions (§6):** resolve both with targeted fault tests before the next round;
   neither has evidence of a live bug today.

## 9. Evidence index

- **M1** (runtime core, 16 findings): three `TowerMission` notes on mission M1 —
  `src/runtime.ts` findings R1-R10 (+ one dead-code remark carried as information, not a
  finding), `src/store.ts` findings S1-S3 (+ verified-clean transaction/CAS list),
  `src/trace.ts` findings T1-T3 (+ verified-clean list). Survey @ `71958b1`.
- **M2** (scheduling & workspace, 13 findings): three notes on mission M2 — `scheduling.ts`
  (1 medium, 2 low, + verified-clean dispatch-serialization analysis), `workspaces.ts`
  (1 medium, 5 low, + verified-clean semaphore/process/capture analysis),
  `workspace-admission.ts` + `git-snapshot.ts` (4 low, + verified-clean
  scope/watch/scheduler/admission analysis). Numbered M2-1…M2-13 by this report.
- **M3** (collaboration protocol, 10 findings): three notes on mission M3 — MEDIUM-1/2,
  LOW-1…LOW-8, verified-clean list and method (all 13 files read in full, ~4750 lines,
  @ `e770264`, cross-referenced against `store.ts`, `runtime.ts`, `scheduling.ts`,
  `harness-workers.ts`, `projection.ts`, `tests/roles.test.mjs`).
- **M4** (harness integration & client, 7 findings): three notes on mission M4 — F1
  (medium) and F2-F7 (low), verified-clean server/client lists and web-api input-handling
  verification (all in-scope files read in full, @ `6fe0259`).
- **Tower cross-file notes (carried in §5/§6):** TraceRecorder nested-transaction
  constraint (M1 → M4, not corroborated); same-file fix grouping hints (M3); M2's two open
  questions.
- **This artifact:** `review/round-12.md` only. No product code, tests, or configuration
  changed; no runtime checks were required (documentation-only, per AGENTS.md).
