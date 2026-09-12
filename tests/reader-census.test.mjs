/**
 * Round 15, Pass 2 — the reader census, as a repository fact.
 *
 * WHAT THIS FILE IS. The census is not a note: it is this table plus the checks
 * below. Every tool in `SWARM_TOOLS` (the registry that defines the model-facing
 * surface) and every kind in `EVENT_VOCABULARY` (the registry that defines the
 * durable log) must carry a recorded decision, a named reader role, a proof that
 * exists in the tree, and the job that reader performs. A later addition that
 * has no reader or no decision fails this file instead of passing unnoticed.
 *
 * WHAT COUNTS AS A READER. A worker or owner decision, dispatch, recovery,
 * acceptance, the UI projection, human understanding, audit, replay, or
 * historical compatibility. A human-facing projection that enables a concrete
 * action or understanding counts even when it displays rather than decides — it
 * is recorded as role `ui`. A vocabulary description alone is not proof of
 * value: an `audit` row is accepted only when the kind also has a writer (a real
 * durable fact that the audit path reads), and a `test`-only row is rejected.
 *
 * THE DELETION RULE. Only proven duplication or unused surface is deleted, with
 * the checks in the last three tests as the consumer-pair regression: a deleted
 * kind must be absent from the vocabulary, absent from every source, test,
 * script and doc outside this file, and an old log row that carries it must
 * still replay with its data intact. The live sibling keeps its writer and its
 * client label, which is what makes the absence meaningful rather than a
 * rename.
 *
 * COUNTS ON THIS ARTIFACT (measured, not quotas): 24 tools, 89 event kinds,
 * 44 examined payload fields. The historical 24/92/… figures are not the
 * baseline; nothing below was deleted to move a number.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SWARM_TOOLS } from '../lib/tools.js'
import { EVENT_VOCABULARY, eventVocabularyReport } from '../lib/trace.js'
import { SwarmStore } from '../lib/store.js'
import { tempDirectory } from './temp-root.mjs'

const ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const CENSUS_FILE = 'tests/reader-census.test.mjs'

/** Roles a recorded reader may carry. `test` is deliberately absent: a test alone proves no value. */
const READER_ROLES = new Set(['engine', 'worker-decision', 'owner-decision', 'dispatch', 'recovery', 'acceptance', 'audit', 'ui', 'human', 'replay', 'compatibility'])
const KEEP_ROLES = new Set(['engine', 'worker-decision', 'owner-decision', 'dispatch', 'recovery', 'acceptance', 'audit', 'ui', 'human', 'replay', 'compatibility'])

/*
 * EVENT CENSUS — one row per vocabulary kind: [kind, decision, readerRole, proof, job].
 * The proof is a repository path; the checks below require it to exist and to
 * mention the kind it claims to read.
 */
const EVENT_CENSUS = [
  ["mission/created", "keep", "audit", "src/trace.ts", "Mission admitted with its frozen scope and budget"],
  // L0-L2 owner-reply receipts: the answer link, the deliberate close and the
  // owner-side miss, each with a writer and a reader that names it.
  ["message/answered", "keep", "ui", "src/client/progress.ts", "The addressed recipient bound an answer to a question delivery id"],
  ["message/dismissed", "keep", "ui", "src/client/progress.ts", "The addressed recipient closed a question without an answer, with the reason"],
  ["owner/reply-missing", "keep", "owner-decision", "src/owner-reply.ts", "An owner turn ended with a delivered question still unanswered"],
  ["mission/recovered", "keep", "ui", "src/client/progress.ts", "Host restarted and recovered the mission from durable state"],
  ["mission/budget-updated", "keep", "audit", "src/trace.ts", "Owner changed the resource ceilings without resetting usage"],
  ["mission/stalled", "keep", "ui", "src/client/progress.ts", "No schedulable work remains and every live worker is idle"],
  ["automatic/completed", "keep", "ui", "src/client/progress.ts", "Runtime completed an automatic mission after independent acceptance"],
  ["workspace/snapshot", "keep", "ui", "src/client/progress.ts", "Member workspace baseline snapshot recorded"],
  ["member/added", "keep", "ui", "src/client/progress.ts", "Worker admitted with its isolated worktree"],
  ["member/failed", "keep", "ui", "src/client/progress.ts", "Worker could not be created"],
  ["member/resume-failed", "keep", "ui", "src/client/progress.ts", "Worker could not resume after restart"],
  ["member/stopped", "keep", "audit", "src/trace.ts", "Worker handle stopped"],
  ["member/activity", "keep", "audit", "src/trace.ts", "Worker activity heartbeat for lease liveness"],
  ["workstream/created", "keep", "audit", "src/trace.ts", "Workstream admitted"],
  ["task/proposed", "keep", "engine", "src/admission.ts", "Task admitted under a workstream"],
  ["task/claimed", "keep", "ui", "src/client/progress.ts", "Attempt dispatched: ownership, attempt id and lease recorded"],
  ["task/submitted", "keep", "engine", "src/scheduling.ts", "Artifact captured and submitted for independent review"],
  ["task/accepted", "keep", "engine", "src/runtime.ts", "Independent verification accepted the source artifact"],
  ["task/rejected", "keep", "engine", "src/runtime.ts", "Independent verification rejected the source artifact"],
  ["task/blocked", "keep", "ui", "src/client/progress.ts", "Task blocked with the reason that must be repaired"],
  ["task/cancelled", "keep", "engine", "src/tools.ts", "Owner withdrew admitted work; dependents named as stranded"],
  ["task/cancelled-at-completion", "keep", "ui", "src/client/progress.ts", "Unschedulable leftover cancelled at mission completion"],
  ["task/lease-expired", "keep", "ui", "src/client/progress.ts", "Attempt lease expired and the owner was released"],
  ["task/ceiling-exhausted", "keep", "ui", "src/client/progress.ts", "Task exhausted its own step or finding ceiling and blocked without charging the mission budget"],
  ["task/checkpointed", "keep", "ui", "src/client/progress.ts", "Workspace checkpoint captured before reassignment"],
  ["task/checkpoint-failed", "keep", "ui", "src/client/progress.ts", "Checkpoint capture failed; workspace preserved, recovery refuses a dirty tree"],
  ["task/closeout-nudged", "keep", "ui", "src/client/progress.ts", "Idle worker nudged to finish its open attempt"],
  ["task/closeout-abandoned", "keep", "ui", "src/client/progress.ts", "Idle close-out exhausted: checkpoint captured and the task re-pended"],
  ["task/closeout-failed", "keep", "ui", "src/client/progress.ts", "Idle close-out could not capture a checkpoint"],
  ["task/handoff-started", "keep", "ui", "src/client/progress.ts", "Ownership revoked; reassignment waits for the previous worker to stop"],
  ["task/handoff-ready", "keep", "ui", "src/client/progress.ts", "Previous worker stopped and the handed-off task is schedulable again"],
  ["task/review-retired", "keep", "engine", "src/tools.ts", "Sibling review retired because its source can never reach a verdict"],
  ["task/invalidated", "keep", "ui", "src/client/progress.ts", "Dependent work invalidated by a challenged prerequisite"],
  ["task/git-write-denied", "keep", "ui", "src/client/progress.ts", "Sandbox refused a worker git write; the supported exit is named"],
  ["task/budget-resume-skipped", "keep", "ui", "src/client/progress.ts", "Budget-resume marker was stale and skipped"],
  ["task/stale-revision-refused", "keep", "audit", "src/trace.ts", "A task write presented a revision another accepted write had moved past; the durable revision was named and the write refused"],
  ["task/quiescence-recovered", "keep", "ui", "src/client/progress.ts", "Parked task recovered after host restart"],
  ["evidence/published", "keep", "ui", "src/client/progress.ts", "Unverified claim published with host-recorded run ids"],
  ["evidence/challenged", "keep", "ui", "src/client/progress.ts", "Claim challenged with counterevidence"],
  ["evidence/verified", "keep", "ui", "src/client/progress.ts", "Verdict verified the claim and names the retired reviews"],
  ["evidence/refuted", "keep", "engine", "src/tools.ts", "Verdict refuted the claim and names the retired reviews"],
  ["evidence/verdict", "keep", "ui", "src/client/locale.tsx", "Normalized verdict row: evidence id, verdict and retired reviews"],
  ["trace/span", "keep", "engine", "src/tools.ts", "One orchestration step span with digests of its input and output"],
  ["message/queued", "keep", "audit", "src/trace.ts", "Directed message or topic broadcast queued durably"],
  ["automatic/requested", "keep", "audit", "src/trace.ts", "Automatic planning request admitted with its goal and workspace"],
  ["automatic/failed", "keep", "ui", "src/client/progress.ts", "Automatic planning or launch failed with the recorded reason"],
  ["member/failure", "keep", "ui", "src/client/progress.ts", "Worker operation failed with the recorded error"],
  ["member/subscribed", "keep", "ui", "src/client/progress.ts", "Worker topic subscriptions replaced"],
  ["member/waiting", "keep", "audit", "src/trace.ts", "Worker parked itself until fresh peer input arrives"],
  ["mission/budget-exhausted", "keep", "ui", "src/client/progress.ts", "Aggregate budget exhausted; mission paused pending quiescence and a raise"],
  ["mission/budget-quiesced", "keep", "audit", "src/trace.ts", "Every worker stopped after budget exhaustion; attempts preserved for resume"],
  ["mission/budget-warning", "keep", "ui", "src/client/progress.ts", "Approaching-limit threshold crossed for one budget dimension"],
  ["plan/edited", "keep", "audit", "src/trace.ts", "Saved draft plan edited with a new revision"],
  ["plan/launched", "keep", "ui", "src/client/progress.ts", "Saved draft plan activated as an active mission"],
  ["plan/staged", "keep", "audit", "src/trace.ts", "Draft plan staged without creating workers or worktrees"],
  ["task/budget-resumed", "keep", "ui", "src/client/progress.ts", "Preserved attempt resumed after the budget raise"],
  ["task/lease-expiring", "keep", "ui", "src/client/progress.ts", "Attempt lease is approaching expiry with no live operation"],
  ["tool/recorded", "keep", "audit", "src/trace.ts", "Host tool run recorded for evidence and audit"],
  ["admission/limit", "keep", "audit", "src/trace.ts", "Owner set an admission limit rule; recorded with its level, key and limit"],
  ["admission/refused", "keep", "audit", "src/trace.ts", "Admission refused a task or member against a limit; recorded once per refusal row"],
  ["member/effort-downgraded", "keep", "ui", "src/client/progress.ts", "Provider rejected the requested reasoning effort; the member runs without it"],
  ["member/effort-rejected", "keep", "audit", "src/trace.ts", "Provider rejected the effort retry; admission failed and the member was stopped"],
  ["task/check-changed", "keep", "ui", "src/client/progress.ts", "A replaced or re-submitted task declared a different check than the stored record"],
  ["task/closeout-ready", "keep", "engine", "src/attempts.ts", "Idle close-out re-pended the task after a checkpoint instead of abandoning it"],
  ["task/closeout-exhausted", "keep", "engine", "src/attempts.ts", "Idle close-out reached the recovery limit and left the task blocked"],
  ["task/preparation-failed", "keep", "ui", "src/client/progress.ts", "Task preparation failed; the reason and recovery credit were recorded"],
  ["task/reassigned", "keep", "ui", "src/client/progress.ts", "A failed attempt was re-routed to another live member"],
  ["task/review-admitted", "keep", "ui", "src/client/progress.ts", "The runtime admitted an independent verification for a submitted task with no review"],
  ["task/review-blocked", "keep", "ui", "src/client/progress.ts", "A submitted task has no review and no eligible reviewer; the reason is recorded"],
  ["task/review-missing", "keep", "ui", "src/client/progress.ts", "A submitted task was detected without a review on the scheduler tick"],
  ["task/start-failed", "keep", "ui", "src/client/progress.ts", "Worker start failed; the attempt was recovered or re-routed with the reason"],
  ["mission/pause", "keep", "ui", "src/client/progress.ts", "Owner paused the mission"],
  ["mission/stop", "keep", "ui", "src/client/progress.ts", "Owner stopped the mission"],
  ["mission/complete", "keep", "ui", "src/client/progress.ts", "Owner completed the mission"],
  ["mission/resume", "keep", "ui", "src/client/progress.ts", "Owner resumed the mission"],
  ["mission/coordinator", "keep", "ui", "src/client/progress.ts", "Owner set the mission coordinator"],
  ["delivery/applied", "keep", "ui", "src/client/progress.ts", "Owner applied an accepted result to the source checkout"],
  ["delivery/conflicts", "keep", "ui", "src/client/progress.ts", "Owner applied a result that conflicted; no source write was kept"],
  ["workspace/grant-loaded", "keep", "engine", "src/index.ts", "One human-configured authorizedWorkspaces root loaded at plugin start, or named as unresolvable"],
  ["mission/workspace-bound", "keep", "ui", "src/client/progress.ts", "Mission bound to its resolved workspace and the matched authorized root"],
  ["mission/workspace-revoked", "keep", "engine", "src/scheduling.ts", "Mission fenced: its workspace is no longer inside a human-authorized root"],
  ["escalation/raised", "keep", "ui", "src/client/progress.ts", "A member raised a typed durable owner escalation with its mission-state fingerprint"],
  ["task/proposal-refused", "keep", "ui", "src/client/progress.ts", "A worker proposal was refused for the per-member allowance or a mission budget/ceiling reason; the owner was notified"],
  ["provider/outage", "keep", "ui", "src/client/progress.ts", "Provider outage classified (quota, rate limit or unavailable); the route is quiescent and no recovery credit is spent"],
  ["provider/recovered", "keep", "ui", "src/client/progress.ts", "A quiescent provider route answered successfully again; the outage marker is cleared"],
  ["task/restart-repended", "keep", "ui", "src/client/progress.ts", "Host restart re-pended a running task without spending recovery credit; the task and epoch are named"],
  ["task/check-envelope", "keep", "audit", "src/trace.ts", "Measured declared-check envelope after a verification: limit, active, queued, wait and run times"],
  ["store/snapshot", "keep", "audit", "src/trace.ts", "Periodic VACUUM INTO snapshot written beside the owner state file"],
  ["store/restore-requested", "keep", "audit", "src/trace.ts", "Owner staged one validated snapshot restore for the next host start"],
  ["store/restored", "keep", "audit", "src/trace.ts", "Plugin composition applied a staged snapshot restore before opening the store"],
  ["isolation/temp-rendezvous", "keep", "engine", "src/workspace-admission.ts", "Two members named the same shared temp path inside the rendezvous window; the path and both members are recorded"],
]

/*
 * TOOL CENSUS — one row per SWARM_TOOLS entry: [tool, decision, readerRole, proof, job].
 * A tool is a model-facing affordance: the reader is the worker or owner whose
 * decision uses it. The proof states exactly what proves the row, and there are
 * two kinds, checked by the tool-proof test below:
 *  - the test that exercises the tool's handler under `tests/` — 22 of 24 rows;
 *  - the handler module `src/tools.ts` for `swarm_challenge` and
 *    `swarm_subscribe`, whose model-visible surface is the golden fixture
 *    `tests/fixtures/model-visible.expected.json` (their worker tool set), read
 *    by `tests/harness-composition.mjs` and `tests/roles.test.mjs`.
 * The blanket claim that every row was proven by a test that exercises the tool
 * was false for those two rows (R16-G7); it now states the split, and the test
 * fails if either kind of proof stops holding.
 */
const TOOL_CENSUS = [
  ["swarm_stage", "keep", "worker-decision", "tests/authorized-workspace.test.mjs", "Save an editable mission plan for the Agent Swarm panel; creates no workers or model calls"],
  ["swarm_launch", "keep", "worker-decision", "tests/automatic.test.mjs", "Launch the complete plan for a native /agent-swarm request identified by requestId; no user confirmation is ne"],
  ["swarm_budget", "keep", "worker-decision", "tests/automatic.test.mjs", "Owner only: set all six resource ceilings from observed progress, with a reason"],
  ["swarm_create", "keep", "worker-decision", "tests/authorized-workspace.test.mjs", "Create a durable mission in the user-authorized workspace and scope with every budget field chosen for this ta"],
  ["swarm_add_member", "keep", "worker-decision", "tests/harness-composition.mjs", "Add a persistent worker sharing the mission budget; the runtime creates its isolated worktree. Omit `name` and the runtime assigns the next unused human name from the fixed pool; `role` carries the responsibility text and every address stays the member id."],
  ["swarm_workstream", "keep", "worker-decision", "tests/harness-composition.mjs", "Create a durable workstream in this mission; any member can propose work under it."],
  ["swarm_propose", "keep", "worker-decision", "tests/arena-protocols.test.mjs", "Propose and admit a task within mission scope and budget"],
  ["swarm_claim", "keep", "worker-decision", "tests/durability-w9-recovery.test.mjs", "Claim ready work as yourself; ownership is atomic and expires"],
  ["swarm_publish", "keep", "worker-decision", "tests/harness-composition.mjs", "Publish a finding backed by host run ids from this attempt (each tool result ends with its id)"],
  ["swarm_submit", "keep", "worker-decision", "tests/harness-composition.mjs", "Submit your current task and immutable artifact for independent verification"],
  ["swarm_verify", "keep", "worker-decision", "tests/check-envelope.test.mjs", "Independent verifier: run the source checks on its exact artifact and record accept or reject with a reason"],
  ["swarm_message", "keep", "worker-decision", "tests/harness-composition.mjs", "Send a question or finding to a member id or owner; topic broadcasts reach subscribers only"],
  ["swarm_challenge", "keep", "worker-decision", "src/tools.ts", "Challenge a finding with a reason and optional host-recorded counterevidence"],
  ["swarm_handoff", "keep", "worker-decision", "tests/guard-terminals.test.mjs", "Checkpoint work and release your attempt to another member or the ready queue; new ownership begins after you "],
  ["swarm_subscribe", "keep", "worker-decision", "src/tools.ts", "Replace your topic subscriptions (workstream ids; * for all findings)"],
  ["swarm_wait", "keep", "worker-decision", "tests/harness-workers.test.mjs", "Members only: park until relevant work or a direct message arrives, then end the turn"],
  ["swarm_observe", "keep", "worker-decision", "tests/harness-composition.mjs", "Bounded mission reads"],
  ["swarm_control", "keep", "worker-decision", "tests/harness-composition.mjs", "Owner: pause/resume/stop/complete the mission or replace its coordinator"],
  ["swarm_cancel", "keep", "worker-decision", "tests/guard-terminals.test.mjs", "Owner only: withdraw one admitted-but-mistaken task"],
  ["swarm_registry", "keep", "worker-decision", "tests/arena-visibility.test.mjs", "Owner only, read-only: the cross-mission artifact registry"],
  ["swarm_escalate", "keep", "worker-decision", "tests/arena-protocols.test.mjs", "Members only: typed durable owner escalation"],
  ["swarm_post", "keep", "worker-decision", "tests/board.test.mjs", "Sanctioned mission board: post one durable, immutable typed note (ASK/ANSWER/IDEA/ALERT/ARTIFACT/HANDOFF)"],
  ["swarm_board", "keep", "worker-decision", "tests/board.test.mjs", "Read the durable mission board as a bounded page (default 20, clamped to 100) plus the caller\\"],
  ["swarm_restore", "keep", "worker-decision", "tests/board.test.mjs", "Owner only: stage one validated mission-store snapshot for the next host start (R11-02)"],
]

/*
 * PAYLOAD CENSUS — the examined payloads and every field they carry:
 * [event, field, decision, readerRole, proof]. Bounded on purpose to the four
 * densest durable payloads (the stall family, the check envelope, the tool-run
 * audit row and the isolation rendezvous); a field that is dropped or renamed
 * must be visited here.
 */
const PAYLOAD_CENSUS = [
  ['mission/stalled', 'cause', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'passId', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'runId', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'reason', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'wedged', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'passStartedAt', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'boundMs', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'revisionBefore', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'revisionAtStall', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'missionFingerprint', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'ownerNotified', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'chain', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'code', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'taskId', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'memberId', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'detail', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'coFires', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'epoch', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'dependents', 'keep', 'engine', 'src/scheduling.ts'],
  ['mission/stalled', 'unschedulable', 'keep', 'engine', 'src/scheduling.ts'],
  ['task/check-envelope', 'taskId', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'sourceTaskId', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'verdict', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'reproduction', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'envelope', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'selfRun', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'selfRunSource', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'selfRunAt', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'blocking', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['task/check-envelope', 'advisory', 'keep', 'acceptance', 'src/declared-checks.ts'],
  ['tool/recorded', 'runId', 'keep', 'audit', 'src/runtime.ts'],
  ['tool/recorded', 'seq', 'keep', 'audit', 'src/runtime.ts'],
  ['tool/recorded', 'taskId', 'keep', 'audit', 'src/runtime.ts'],
  ['tool/recorded', 'tool', 'keep', 'audit', 'src/runtime.ts'],
  ['tool/recorded', 'isError', 'keep', 'audit', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'path', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'firstMemberId', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'firstTaskId', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'firstAt', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'secondMemberId', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'secondTaskId', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'secondAt', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'windowMs', 'keep', 'owner-decision', 'src/runtime.ts'],
  ['isolation/temp-rendezvous', 'detection', 'keep', 'owner-decision', 'src/runtime.ts'],
]

/*
 * DELETED SURFACE — candidates whose decision is `delete`, with the proof that
 * nothing reads them. Each entry is also required to be absent from the
 * vocabulary and from every file outside this one.
 */
const DELETED_EVENT_KINDS = [
  ['mission/paused', 'exact duplicate of the live dynamic `mission/pause` family: identical description, no writer in this repository history, no reader anywhere'],
  ['mission/resumed', 'exact duplicate of the live dynamic `mission/resume` family: identical description, no writer in this repository history, no reader anywhere'],
  ['mission/stopped', 'unused surface: the live kind is the dynamic `mission/stop`; no writer ever emitted the `-ed` form and nothing reads it'],
  ['mission/completed', 'exact duplicate of the live dynamic `mission/complete` family: identical description, no writer in this repository history, no reader anywhere'],
]

/*
 * COMPATIBILITY LABELS — client labels kept although no writer in this
 * repository emits the kind. They exist so a historical card holding old rows
 * still renders; the round's rule allows a compatibility decoder to outlive the
 * writer that stopped emitting. Recorded here so the label-coverage check below
 * cannot be satisfied by an undocumented exception.
 *
 * `why` is a claim, so it is checked: every repository path it names must exist
 * AND must itself mention the kind, and the recorded reader in its `proof` file
 * must carry the kind in the site the reason names. A reason that cites a file
 * which never mentions the label (the R16-G7 defect: the row claimed
 * `tests/ui-progress.test.mjs` rendered `attempt/started`, which occurs nowhere
 * in that file or its fixtures) fails the compatibility-reader test below.
 */
const COMPATIBILITY_LABELS = [
  ['attempt/started', 'no writer in this repository history emits the label and the live kind is `task/claimed`; the readers that keep it are the label map `meaningfulEvents` (renders "Task started") and `recoveryEventTypes` (treats such a row as a recovery step) in src/client/progress.ts', 'src/client/progress.ts'],
]

function tree(...prefixes) {
  const found = []
  for (const prefix of prefixes) {
    const base = join(ROOT, prefix)
    if (!existsSync(base)) continue
    for (const entry of readdirSync(base, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath ?? entry.path ?? base, entry.name)
      if (/\.(ts|tsx|mjs|md|json|yml)$/.test(entry.name)) found.push(relative(ROOT, path))
    }
  }
  return found.sort()
}

const TREE = tree('src', 'tests', 'scripts')
const TEXT = new Map([...TREE, 'README.md', 'docs/known-limitations.md'].filter(existsSync).map(path => [path, readFileSync(join(ROOT, path), 'utf8')]))
const textOf = path => TEXT.get(path) ?? ''

/**
 * Which files write one kind. The derivation mirrors the production scanner in
 * tests/event-vocabulary.test.mjs: a literal second argument, a ternary pair
 * (`passed ? 'task/accepted' : 'task/rejected'`), a shared exported constant, or
 * the dynamic `mission/${action}` / `delivery/${result.status}` family token.
 */
const DYNAMIC_FAMILY = new Map([
  ['mission/pause', 'mission/${action}'], ['mission/resume', 'mission/${action}'], ['mission/stop', 'mission/${action}'],
  ['mission/complete', 'mission/${action}'], ['mission/coordinator', 'mission/${action}'],
  ['delivery/applied', 'delivery/${result.status}'], ['delivery/conflicts', 'delivery/${result.status}'],
])
const EMITTERS = (() => {
  const sources = TREE.filter(path => path.startsWith('src/'))
  const constants = new Map()
  for (const path of sources) for (const match of textOf(path).matchAll(/export const ([A-Za-z0-9_]+)\s*=\s*'([^']+)'/g)) constants.set(match[1], match[2])
  const map = new Map()
  const add = (kind, path) => { const list = map.get(kind) ?? []; if (!list.includes(path)) list.push(path); map.set(kind, list) }
  for (const path of sources) {
    const text = textOf(path)
    for (const match of text.matchAll(/\.event\(\s*[^,]+,\s*([^,]+?)\s*,/g)) {
      const argument = match[1].trim()
      if (argument.startsWith("'") && argument.endsWith("'")) add(argument.slice(1, -1), path)
      else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argument) && constants.has(argument)) add(constants.get(argument), path)
    }
    for (const match of text.matchAll(/\.event\(\s*[^,]+,\s*[^,?]+\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) { add(match[1], path); add(match[2], path) }
  }
  return map
})()

function writersOf(kind) {
  const token = DYNAMIC_FAMILY.get(kind)
  if (token !== undefined) return TREE.filter(path => path.startsWith('src/') && textOf(path).includes(token))
  return EMITTERS.get(kind) ?? []
}

/** The recorded-decision table is the only place a decision may live. */
function decisionFor(rows, key) {
  const matches = rows.filter(row => row[0] === key)
  assert.ok(matches.length <= 1, `${key} has ${matches.length} census rows`)
  return matches[0]
}

/** Coverage: every registry entry has exactly one row and no row is stale. */
function coverage(registry, rows, label) {
  const recorded = new Set(rows.map(row => row[0]))
  const missing = registry.filter(key => !recorded.has(key))
  const stale = [...recorded].filter(key => !registry.includes(key))
  assert.deepEqual(missing, [], `${label}: ${missing.length} entr(y/ies) have no recorded decision: ${missing.join(', ')}`)
  assert.deepEqual(stale, [], `${label}: recorded decisions for entries that no longer exist: ${stale.join(', ')}`)
}

test('every event kind in the vocabulary has exactly one recorded decision, and every recorded decision is real', () => {
  const kinds = Object.keys(EVENT_VOCABULARY)
  coverage(kinds, EVENT_CENSUS, 'event census')
  for (const [kind, decision, role, proof, job] of EVENT_CENSUS) {
    assert.ok(decision === 'keep' || decision === 'delete', `${kind}: decision ${decision}`)
    assert.ok(READER_ROLES.has(role), `${kind}: unknown reader role ${role}`)
    assert.ok(typeof job === 'string' && job.length > 8, `${kind}: the reader's job must be recorded`)
    assert.ok(existsSync(join(ROOT, proof)), `${kind}: proof ${proof} does not exist`)
    if (decision === 'keep') {
      // The proof must mention the kind itself; the dynamic family token is only
      // how the writer is found, not what a reader names.
      assert.ok(textOf(proof).includes(kind), `${kind}: proof ${proof} does not mention it`)
      const writers = writersOf(kind)
      assert.ok(writers.length > 0, `${kind}: kept, but no writer emits it and no historical decoder names it`)
      if (role === 'audit') {
        // The audit reader is the durable log itself: it is only a reader while
        // the row is written. A vocabulary description alone proves nothing.
        assert.ok(writers.length > 0, `${kind}: audit rows need a durably written fact`)
      }
    } else {
      assert.ok(DELETED_EVENT_KINDS.some(([deleted]) => deleted === kind), `${kind}: deleted without a DELETED_EVENT_KINDS entry`)
    }
  }
})

test('a later registry addition cannot pass without a recorded decision (the checker is not vacuous)', () => {
  const synthetic = [...Object.keys(EVENT_VOCABULARY), 'mission/brand-new-unrecorded-kind']
  assert.throws(() => coverage(synthetic, EVENT_CENSUS, 'synthetic'), /have no recorded decision/, 'an unrecorded kind must fail the coverage check')
  assert.throws(() => coverage(Object.keys(EVENT_VOCABULARY), [...EVENT_CENSUS, ['mission/retired-kind', 'keep', 'ui', 'src/client/progress.ts', 'retired but still recorded']], 'synthetic'), /no longer exist/, 'a stale row must fail too')
})

test('every tool in SWARM_TOOLS has a recorded decision, a real reader and a job', () => {
  coverage([...SWARM_TOOLS], TOOL_CENSUS, 'tool census')
  const handlers = textOf('src/tools.ts')
  for (const [tool, decision, role, proof, job] of TOOL_CENSUS) {
    assert.equal(decision, 'keep', `${tool}: no tool was deleted this round`)
    assert.ok(KEEP_ROLES.has(role), `${tool}: unknown reader role ${role}`)
    assert.ok(typeof job === 'string' && job.length > 8, `${tool}: the job must be recorded`)
    assert.ok(handlers.includes(`'${tool}'`), `${tool}: no registration or handler in src/tools.ts`)
    assert.ok(existsSync(join(ROOT, proof)), `${tool}: proof ${proof} does not exist`)
    assert.ok(textOf(proof).includes(tool), `${tool}: proof ${proof} does not exercise it`)
  }
})

test('a tool row states exactly what proves it: an exercising test, or the handler plus the model-visible fixture', () => {
  const fixturePath = 'tests/fixtures/model-visible.expected.json'
  const fixture = textOf(fixturePath)
  assert.ok(fixture.length > 0, `${fixturePath}: the model-visible golden fixture must be readable`)
  for (const reader of ['tests/harness-composition.mjs', 'tests/roles.test.mjs']) {
    assert.ok(textOf(reader).includes('fixtures/model-visible.expected.json'), `${reader} must read the model-visible golden fixture`)
  }
  // The split the census documents: 22 rows carry an exercising test, and the
  // two handler-proofed rows are named. A third kind of proof, or a row that
  // moves from one kind to the other without the document changing, fails here.
  const handlerProofed = TOOL_CENSUS.filter(([, , , proof]) => proof === 'src/tools.ts').map(([tool]) => tool)
  assert.deepEqual(handlerProofed, ['swarm_challenge', 'swarm_subscribe'], 'the handler-proofed rows changed; docs/known-limitations.md states 22 of 24 tools are proven by a test that exercises the tool')
  assert.equal(TOOL_CENSUS.length - handlerProofed.length, 22, 'the exercising-test row count changed; docs/known-limitations.md states 22 of 24')
  const workerVisible = JSON.parse(fixture).workerSwarmTools
  for (const tool of handlerProofed) {
    assert.ok(workerVisible.includes(tool), `${tool}: the handler-proofed row must be covered by the model-visible worker tool set`)
  }
  for (const [tool, , , proof] of TOOL_CENSUS) {
    if (proof === 'src/tools.ts') continue
    assert.ok(proof.startsWith('tests/'), `${tool}: an exercising-test proof must live under tests/, got ${proof}`)
  }
})

test('every examined payload field is recorded, real, and names its reader', () => {
  const src = TREE.filter(path => path.startsWith('src/'))
  for (const [event, field, decision, role, proof] of PAYLOAD_CENSUS) {
    assert.ok(Object.hasOwn(EVENT_VOCABULARY, event), `${event}: payload of an unknown event kind`)
    assert.equal(decision, 'keep', `${event}.${field}: no payload field was deleted this round`)
    assert.ok(KEEP_ROLES.has(role), `${event}.${field}: unknown reader role ${role}`)
    assert.ok(existsSync(join(ROOT, proof)), `${event}.${field}: proof ${proof} does not exist`)
    const written = src.some(path => new RegExp(`\\b${field}\\s*:`).test(textOf(path)))
    assert.ok(written, `${event}.${field}: no writer carries this field`)
  }
  // The same field of the same event is recorded once per payload shape.
  const keys = PAYLOAD_CENSUS.map(([event, field]) => `${event}.${field}`)
  assert.equal(new Set(keys).size, keys.length, 'a payload field is recorded twice')
})

test('deleted event kinds are absent from the vocabulary and from every reader', () => {
  for (const [kind, why] of DELETED_EVENT_KINDS) {
    assert.equal(Object.hasOwn(EVENT_VOCABULARY, kind), false, `${kind} is still in the vocabulary`)
    // Only executable readers count: source, tests and scripts. Documentation is
    // allowed — and expected — to keep naming a deleted kind, because that prose is
    // the historical record of the decision (docs/known-limitations.md, "Round 15
    // Pass 2"), not a reader of the surface.
    for (const path of TREE) {
      if (path === CENSUS_FILE) continue
      assert.equal(textOf(path).includes(kind), false, `${kind} is still referenced by ${path} (${why})`)
    }
    assert.equal(writersOf(kind).length, 0, `${kind}: a writer reappeared`)
  }
  // Positive control: the live sibling of each deleted kind keeps its writer and
  // its client label, so the absence above is meaningful rather than a rename.
  for (const live of ['mission/pause', 'mission/resume', 'mission/stop', 'mission/complete']) {
    assert.ok(writersOf(live).length > 0, `${live}: the live dynamic kind lost its writer`)
    assert.ok(textOf('src/client/progress.ts').includes(live), `${live}: the live kind lost its client label`)
  }
})

test('every client label key is a vocabulary kind, a compatibility label, or a dynamic family member', () => {
  const labels = [...textOf('src/client/progress.ts').matchAll(/'([a-z][a-z0-9-]*\/[a-z0-9-]+)':/g)].map(match => match[1])
  assert.ok(labels.length > 40, `the label map must be seen by this check, saw ${labels.length}`)
  const documented = new Set(COMPATIBILITY_LABELS.map(([kind]) => kind))
  const undocumented = labels.filter(kind => !Object.hasOwn(EVENT_VOCABULARY, kind) && !documented.has(kind))
  assert.deepEqual(undocumented, [], `client labels with no vocabulary kind and no documented compatibility entry: ${undocumented.join(', ')}`)
  for (const [kind, why, proof] of COMPATIBILITY_LABELS) {
    assert.ok(Object.hasOwn(EVENT_VOCABULARY, kind) === false, `${kind}: a compatibility label must not have a vocabulary entry`)
    assert.ok(writersOf(kind).length === 0, `${kind}: a compatibility label must have no writer`)
    assert.ok(textOf('src/client/progress.ts').includes(kind), `${kind}: ${why}`)
    assert.ok(existsSync(join(ROOT, proof)), `${kind}: compatibility proof ${proof} does not exist`)
  }
})

test('a compatibility label names its real reader, and every reader the reason cites carries the label', () => {
  const progress = textOf('src/client/progress.ts')
  const recovery = /const recoveryEventTypes = new Set\(\[([\s\S]*?)\]\)/.exec(progress)
  assert.ok(recovery, 'src/client/progress.ts must still declare recoveryEventTypes')
  const labelMap = new Set([...progress.matchAll(/'([a-z][a-z0-9-]*\/[a-z0-9-]+)':/g)].map(match => match[1]))
  for (const [kind, why, proof] of COMPATIBILITY_LABELS) {
    assert.ok(labelMap.has(kind), `${kind}: the label map in ${proof} must carry it`)
    assert.ok(recovery[1].includes(`'${kind}'`), `${kind}: the recorded reader recoveryEventTypes must carry it`)
    // The recorded reason is a claim about this repository: every path it names
    // must exist and must itself mention the kind. A reason citing a file that
    // never names the label is the R16-G7 defect, and it fails here.
    for (const match of why.matchAll(/(?:src|tests|scripts)\/[A-Za-z0-9_./-]+/g)) {
      const named = match[0].replace(/[.,;:]$/, '')
      assert.ok(existsSync(join(ROOT, named)), `${kind}: the recorded reason names ${named}, which does not exist`)
      assert.ok(textOf(named).includes(kind), `${kind}: the recorded reason names ${named} as a reader, but that file never mentions the kind`)
    }
  }
})

test('historical readability: an old log row with a deleted kind still replays with its data', async t => {
  const directory = await tempDirectory('swarm-reader-census-')
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }) })
  const store = new SwarmStore(join(directory, 'legacy.sqlite'))
  try {
    store.transaction(() => {
      store.event('mission-1', 'mission/paused', 'owner', { reason: 'pre-upgrade row written by an older build' })
      store.event('mission-1', 'mission/pause', 'owner', { reason: 'current row' })
    })
    const events = store.events('mission-1', 10)
    assert.deepEqual(events.map(event => event.type), ['mission/paused', 'mission/pause'])
    assert.equal(events[0].data.reason, 'pre-upgrade row written by an older build', 'the legacy row keeps its payload')
    const report = eventVocabularyReport(events)
    assert.ok(report.unrecognized.includes('mission/paused'), 'the removed description is reported as undescribed, not dropped')
    assert.equal(report.types.reduce((total, item) => total + item.count, 0), 2, 'both rows are still classified')
    assert.deepEqual(report.recognized, ['mission/pause'], 'the live kind keeps its description')
  } finally { store.close() }
})
