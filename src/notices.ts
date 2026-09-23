/**
 * Notices and witnesses: the owner-notice ledger (dedup by class + key), the
 * bounded outbox that delivers it outside the mission queue, and the durable
 * stall / coverage / integration-gap witnesses. M1a seam 3/7.
 *
 * Behaviour-identical to the code moved from src/runtime.ts: the runtime keeps
 * thin forwarding methods, so no call site changed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { hasNotice, noticeFingerprint as computeNoticeKey, noticeLedger as projectNoticeLedger } from './arena.ts'
import { hostContextOf, memberPhaseOf } from './projection.ts'
import { formatDiagnostic, missingReviewDiagnostic } from './admission.ts'
import { requireText } from './refusals.ts'
import { taskGraphIndex } from './task-graph.ts'
import { blockCauses } from './attempts.ts'
import { PolicyError } from './policy-error.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { Actor, Delivery, Member, Mission, NoticeClass, Task, WorkerAdapter } from './types.ts'

/** R14-F2(a): the durable identity of one task at one epoch, as notices carry it. */
export function taskSubject(task: Pick<Task, 'id' | 'epoch'>): string { return `${task.id}@${task.epoch}` }
/**
 * R15-A1: the mission-scoped subject for a decision that names no single task (a
 * wedged scheduling pass, a failed member with no assigned work, an escalation).
 * It is the exact lineage root of such a decision, never a placeholder, so an
 * owner-facing notice always has something to be attributed to.
 */
export function missionSubject(mission: Pick<Mission, 'id'>): string { return `mission:${mission.id}` }
/**
 * R15-A1: the subjects of a set of tasks, with the mission root as the honest
 * fallback when the set is empty. Deduplicated and order-preserving.
 */
export function subjectsOfTasks(tasks: readonly Pick<Task, 'id' | 'epoch'>[], mission: Pick<Mission, 'id'>): string[] {
  const subjects: string[] = []
  for (const task of tasks) { const subject = taskSubject(task); if (!subjects.includes(subject)) subjects.push(subject) }
  return subjects.length ? subjects : [missionSubject(mission)]
}
/**
 * R15-A1: a notice without a subject is unattributable, so it is refused rather
 * than written as an anonymous durable row. This is the runtime end of the
 * contract the enumerated `notify()`-site test enforces in source.
 *
 * Co-fires with: `taskSubject`/`missionSubject`/`subjectsOfTasks` (whose absence
 * this guard detects), the ledger's dedup (`hasNotice`, which must never see an
 * empty-subject decision row) and every caller that can produce an empty task
 * set (the W3 stall notice, the coverage-complete notice, the member-scoped
 * failure notices). Those callers fall back to `missionSubject`, so this guard
 * is reachable only from a genuine programming error.
 */
export function noticeSubjects(subjects: readonly string[] | undefined, mission: Pick<Mission, 'id'>): string[] {
  const clean = Array.isArray(subjects) ? subjects.filter(subject => typeof subject === 'string' && subject.length > 0) : []
  if (clean.length === 0) {
    // R15-A1: a caller that dropped its subjects must not produce an anonymous
    // durable row, and the omission must not be silent either. The enumerated
    // source test is the enforcement; this is the last-resort attribution: the
    // notice is still written under the mission root, and the omission is
    // reported where the runtime reports its other internal faults. (No new
    // refusal site: the retained S3 inventory pins the coded/uncoded split of
    // these files, and a programming error here is not a user-facing refusal.)
    process.stderr.write('[agent-swarm] owner notice without subjects; attributed to the mission root\n')
    return [missionSubject(mission)]
  }
  return clean
}
/**
 * R15-A1: the delivery options one notice call site passes. The subjects are a
 * required positional argument; every other field has a documented default, so a
 * new call site cannot inherit "no subject" by omission.
 */
export interface NotifyOptions {
  from?: string
  noticeClass?: NoticeClass
  dedupe?: boolean
  dedupKey?: string
  stampWitness?: boolean
  /**
   * R17-G3: the durable event that triggered this fact (for example
   * `task/blocked`, `dispatch-question`, `absence-net`). With `reason` it is the
   * fact identity the dedup key is built from, so an unrelated board change
   * cannot re-arm the notice and a new fact cannot be suppressed.
   */
  trigger?: string
  /** R17-G3: the recorded reason the fact's rows carry (never invented by the body). */
  reason?: string
  /**
   * R17-G3: the notice family the dedup key is prefixed with. Existing readers
   * (`noticeFamily`, owner-side filters) read the family from the key prefix, so
   * a fact-keyed notice keeps it.
   */
  family?: string
  /** Full facts and their original identities when one notice presents a batch. */
  facts?: string[]
  aggregatedIdentities?: NonNullable<Delivery['notice']>['aggregatedIdentities']
  /** Exact receipt / failed transport behind this action, including wake summaries. */
  questionId?: string
  deliveryFailureId?: string
}

/**
 * R17-G3/G8: the durable fact fields a notice row carries. The declared
 * `Delivery` type predates them (and src/types.ts is outside this branch's
 * scope), so the fields travel on the same durable row as plain JSON and are
 * read through this view. `claimedAt` is deliberately absent: it was stamped
 * from `deliveredAt` and carried no information beyond the transport.
 */
export interface NoticeFactRecord {
  subjects: string[]
  trigger: string
  reason: string
  questionId?: string
  deliveryFailureId?: string
  /** R17-G3: the notice family the dedup key is prefixed with. */
  family?: string
  /** R17-G8: the host's claimed signal, recorded once (CAS) per delivery. */
  consumedAt?: number
  consumptionSource?: string
  /** Bounded reminders for an unresolved fact; transport/turn end never resolves it. */
  followupCount?: number
  followupAt?: number
  /** R17-G4: the facts a degraded wake-budget summary carries. */
  facts?: string[]
  aggregatedIdentities?: NonNullable<Delivery['notice']>['aggregatedIdentities']
}
export type NoticeRow = NonNullable<Delivery['notice']> & Partial<NoticeFactRecord>
/** The fact view of one delivery row, or undefined when it is not a notice. */
export const noticeRow = (delivery: Pick<Delivery, 'notice'>): NoticeRow | undefined => delivery.notice === undefined ? undefined : delivery.notice as NoticeRow

/**
 * OWNER QUIET: whether an owner delivery is moot because the owner has taken the
 * mission out of play, judged by the owner's own decision rather than by a
 * terminal status.
 *
 * `control()` deliberately writes no notice for its own pause/stop — the
 * decision is already the owner's and the panel shows it — so without this rule
 * the decisions a mission queued kept arriving after the owner stopped it, which
 * reads as the swarm still running after it was stopped. The rule is keyed on
 * the decision, never on `completed`: completion is automatic and can overtake
 * the outbox, so a fact produced while the mission was still running must still
 * land even though the mission has completed by the time the pump reaches it.
 * A paused mission still delivers a question that awaits the owner's answer,
 * because that is a receipt rather than a report, and `blocked` — a decision
 * addressed to the owner — keeps its notices because the mission is not out of
 * play at all.
 */
function ownerDeliveryMoot(mission: Pick<Mission, 'status'>, delivery: Pick<Delivery, 'kind' | 'replyExpected' | 'answeredBy'>): boolean {
  if (mission.status === 'stopped') return true
  if (mission.status !== 'paused') return false
  return !(delivery.kind === 'question' && delivery.replyExpected === true && delivery.answeredBy === undefined)
}

/** R17-G3: the stable digest of a recorded reason, so a fact key stays bounded. */
function reasonDigest(reason: string): string {
  return reason.length === 0 ? 'none' : createHash('sha256').update(reason).digest('hex').slice(0, 16)
}
/**
 * R17-G3: the fact key. Identity is `subject@epoch` (or the mission root when a
 * decision names no single task) plus the triggering event plus the recorded
 * reason — never a digest of the whole board, so an unrelated change cannot
 * re-arm a notice and a new fact is never suppressed by an old one.
 *
 * Two boundaries, stated here because they cannot be inferred from the call:
 * - The "triggering event" is the event TYPE (`NotifyOptions.trigger`, or the
 *   notice class when no trigger is given). A second, distinct transition of the
 *   same type at the same subject@epoch with the same recorded reason is
 *   therefore the SAME fact and is suppressed — the round's "at most one notice
 *   per fact" rule. A changed reason, a changed subject epoch or a changed
 *   trigger is a new fact and is recorded.
 * - When a `family` is present (an explicit `NotifyOptions.family`, or the prefix
 *   of an explicit `dedupKey`), the key is prefixed with that family and the
 *   trigger does NOT participate: the family is the identity the retained family
 *   readers (`noticeFamily`) resolve, so two facts
 *   of one family with different triggers but the same subjects and recorded
 *   reason share one key. The per-site reviewed table in
 *   `tests/r17-notices.test.mjs` names every site that relies on this.
 */
export function factKey(missionId: string, fact: { trigger: string; reason: string; subjects: readonly string[]; family?: string }): string {
  const subjects = [...fact.subjects].sort().join('+')
  return `${fact.family ?? fact.trigger}:${missionId}:${subjects}:${reasonDigest(fact.reason)}`
}

/**
 * R17-G4: the one per-owner wake budget. Every notice family shares it: the
 * first `wakeBudget` facts of a window are delivered individually, and every
 * further fact of the same window is carried by one degraded summary delivery
 * (never dropped). Values are public fields so a test can tighten the budget
 * without inventing a second code path.
 */
export const DEFAULT_WAKE_BUDGET = 6
export const DEFAULT_WAKE_WINDOW_MS = 5_000
const WAKE_SUMMARY_HEADER = 'Wake budget reached: further facts in this window are summarized here, none is dropped.'
/** Bound generated owner text; full facts remain on the same durable delivery. */
const MAX_OWNER_NOTICE_CHARS = 3200
const compactFact = (content: string, limit: number): string => content.length <= limit ? content
  : `${content.slice(0, Math.floor((limit - 3) * 2 / 3))} … ${content.slice(-Math.floor((limit - 3) / 3))}`
function renderNoticeFacts(header: string, facts: readonly string[], missionId: string, deliveryId: string, limit: number): string {
  const read = `Full facts: swarm_observe({ missionId: "${missionId}", deliveryId: "${deliveryId}" }).`
  const lines: string[] = []
  let length = header.length + read.length + 100
  for (const fact of facts) {
    const line = `- ${compactFact(fact, 440)}`
    if (length + line.length > limit) break
    lines.push(line); length += line.length + 1
  }
  return `${header}\n${lines.join('\n')}${lines.length < facts.length ? `\n${facts.length - lines.length} further fact(s) retained in the record.` : ''}\n${read}`
}
/**
 * R17-G5: the declared absence bound the sampling net reports against. It is the
 * same order as the runtime's attempt-silence bound: a mission without
 * task, evidence or owner-decision progress is reported as an absence.
 */
export const DEFAULT_ABSENCE_BOUND_MS = 600_000
/**
 * R17-G2: the reviewed notice template table. Every reviewed family's body is
 * built by one pure function from the durable rows it cites, and the generator
 * calls that function — so the machine replay check can rebuild each emitted
 * body from the store and fail a body that states a cause no row supports.
 * `trigger` is the durable event the family is keyed on; a family absent from
 * this table is listed with its reason in the test's reviewed-site table.
 */
export const NOTICE_TEMPLATES = {
  'stall-root': {
    trigger: 'task/blocked',
    build: (input: { rootId: string; title: string; epoch: number; cause: string; dependents: readonly string[]; recordedReason?: string }) =>
      `Task ${input.rootId} (${input.title}, epoch ${input.epoch}) is a stall root: it is blocked and ${input.cause}${input.dependents.length ? `; ${input.dependents.length} task(s) depend on it (${input.dependents.join(', ')})` : ''}${input.recordedReason === undefined ? '' : `. Recorded reason: ${input.recordedReason}`}. Inspect the recorded cause: extend this task's allocation with swarm_budget, amend its unsubmitted policy or resume it after environment repair with swarm_control(taskId: "${input.rootId}"). Rejected implementations require swarm_propose with replaces: ["${input.rootId}"]; the repair inherits its acceptance. Use swarm_cancel to withdraw mistaken work.`,
  },
  fallthrough: {
    trigger: 'mission/stalled',
    build: (input: { missionTitle: string; subjects: ReadonlyArray<Pick<Task, 'id' | 'kind' | 'status' | 'epoch' | 'dependencies'>> }) =>
      `Mission ${input.missionTitle} made no progress this tick and has unfinished work that no live path will advance: ${input.subjects.map(task => `${task.id} (${task.kind}, ${task.status}, epoch ${task.epoch}${task.dependencies.length ? `, depends on ${task.dependencies.join('/')}` : ''})`).join('; ')}. Inspect the board, admit a repair or review with swarm_propose, or decide with swarm_control.`,
  },
  stall: {
    trigger: 'mission/stalled',
    build: (input: { reason: string; detail: string; subjects: readonly string[] }) =>
      `Mission stalled: no task can be scheduled and workers are idle. ${input.reason}. Unschedulable: ${input.detail || 'none'}. Subjects: ${input.subjects.join(', ')}. Decide: amend the existing task dependencies or assignee with swarm_control, admit a repair or review with swarm_propose, or adjust the budget. If work is no longer required, withdraw it explicitly with swarm_cancel; completing a mission never cancels unfinished tasks. Use swarm_control stop to stop the mission.`,
  },
  parked: {
    trigger: 'member/waiting',
    build: (input: { taskId: string; title: string }) =>
      `Task ${input.taskId} (${input.title}) is held by a parked member and cannot make progress while parked. A fresh assignment wakes it; if the lease expires the task re-pends without spending a recovery attempt.`,
  },
  'review-blocked': {
    trigger: 'task/review-blocked',
    build: (input: { diagnostic: string; sourceId: string }) =>
      `${input.diagnostic}. Admit an independent verification task with swarm_propose (kind verification, reviewOf ${input.sourceId}) or cancel the source task; the mission cannot complete while it is unreviewable.`,
  },
  'integration-gap': {
    trigger: 'task/proposed',
    build: (input: { diagnostic: string; implementations: readonly string[] }) =>
      `${input.diagnostic}. The mission now has ${input.implementations.length} implementation branches (${input.implementations.join(', ')}); admit an integration task depending on every branch, or complete with exactly one accepted implementation artifact.`,
  },
  'coverage-complete': {
    trigger: 'task/accepted',
    build: (input: { missionTitle: string }) =>
      `Mission ${input.missionTitle} is ready to complete: every acceptance criterion is independently covered and no task can make further progress. The mission stays active until you decide. Use swarm_control complete to accept the deliverable, or admit more work with swarm_propose.`,
  },
} as const
/** R17-G2: the template key of one emitted notice, or undefined when the family is not reviewed. */
export function noticeTemplateKey(delivery: Pick<Delivery, 'notice'>): keyof typeof NOTICE_TEMPLATES | undefined {
  const key = delivery.notice?.dedupKey ?? ''
  const prefix = key.includes(':') ? key.slice(0, key.indexOf(':')) : ''
  return prefix in NOTICE_TEMPLATES ? prefix as keyof typeof NOTICE_TEMPLATES : undefined
}

/** R17-G1: the shared interpretation one mission's notice generators consume. */
export interface MissionInterpretation {
  missionId: string
  mission: Mission
  tasks: Task[]
  members: Member[]
  /** The dispatcher's startability set: idle, or parked (the parked-member hatch). */
  runnable: Member[]
  nonTerminal: Task[]
  stallRoots: Task[]
  replaced: Set<string>
  /** The dispatcher's own readiness predicate, bound to these rows. */
  ready: (task: Task, member: Member, tasks?: Task[]) => boolean
  /** Pending tasks a runnable member can run right now (the dispatcher's question). */
  dispatchable: Task[]
  /** Submitted tasks with no live review path (before the grace is applied). */
  unreviewed: Task[]
  /** The dispatcher's unschedulable set for this board. */
  unschedulable: Task[]
  /** The scheduler's stalled predicate for this board. */
  stalled: boolean
  /** Running tasks whose owning member is durably parked (the R10-15 holder family). */
  parkedHolders: Array<{ task: Task; member: Member }>
  implementations: Task[]
  /** Latest task, evidence or owner-decision progress; telemetry does not reset this clock. */
  lastTransitionAt: number
  subjectsOf: (tasks: readonly Pick<Task, 'id' | 'epoch'>[]) => string[]
}
/** The states that leave a task no future. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set(['accepted', 'cancelled'])

/**
 * R16-A: the durable families of owner decisions. A family is read from the
 * dedup key the runtime itself writes (never from prose), because that key is the
 * identity the notice ledger and the dedup logic already use.
 */
const DECISION_FAMILIES = ['stall-root', 'fallthrough', 'dispatch-question', 'guard-terminal', 'integration-gap', 'parked', 'review-blocked', 'obligation-followup', 'absence', 'owner-reply-missing', 'owner-reply-blocked'] as const
/**
 * The families whose claim is "no live path will advance this subject". Only
 * these can be false wakes when the named subject's lineage is live. A
 * `dispatch-question` or `guard-terminal` names a subject for a different claim
 * and is deliberately not judged by the wake-precision predicate.
 */
export const NO_LIVE_PATH_FAMILIES: ReadonlySet<string> = new Set(['stall-root', 'fallthrough'])
const FOLLOWUP_EXCLUDED_FAMILIES = new Set(['obligation-followup', 'absence', 'owner-reply-missing', 'owner-reply-blocked'])

/** R16-A: the family of one durable owner notice, from its dedup key or class. */
export function noticeFamily(delivery: Pick<Delivery, 'notice' | 'kind'>): string {
  const key = delivery.notice?.dedupKey ?? ''
  const prefix = key.includes(':') ? key.slice(0, key.indexOf(':')) : ''
  if ((DECISION_FAMILIES as readonly string[]).includes(prefix)) return prefix
  if (delivery.kind === 'escalation' || delivery.notice?.class === 'escalation') return 'escalation'
  return delivery.notice?.class ?? 'unknown'
}

/** R16-A: the task a `taskId@epoch` subject names, only while that epoch is still the live row. */
export function taskFromSubject(subject: string, tasks: readonly Task[]): Task | undefined {
  const match = /^(.*)@(\d+)$/.exec(subject)
  if (match === null) return undefined
  const task = tasks.find(candidate => candidate.id === match[1])
  return task !== undefined && task.epoch === Number(match[2]) ? task : undefined
}

/**
 * F2: how long a submitted code deliverable may stay without a live review
 * before the runtime concludes none is coming. One scheduler period gives the
 * author the turn in which it submitted to propose its own review; the floor
 * keeps a fast tick from turning a same-turn proposal into a race.
 */
export const AUTO_REVIEW_GRACE_MS = 1000

/**
 * R17-G9: the runtime slice the lineage rules read, so the classifiers and the
 * delivery-time relevance check consume ONE implementation (`SwarmRuntime`
 * satisfies it structurally; a test can supply the same shape).
 */
export interface LineageRuntime {
  readonly store: { list: (table: 'tasks', missionId: string) => Task[] }
  readonly config: { tickMs: number }
  readonly stallPassTimeoutMs: number
  latestSubmission(missionId: string, taskId: string): { seq: number; age: number } | undefined
  unfinishedDependencies(missionId: string, task: Task, tasks?: Task[]): Task[]
  reviewable(task: Task, tasks: Task[]): boolean
}

/**
 * R16-A: the ids whose obligation is carried by a live task through `replaces`,
 * transitively. Shared by `stallRoots` (a covered task is not a root) and
 * `waitsLegitimately` (a covered task is waiting on its repair), so the two
 * classifiers cannot disagree about a task that is inside a live lineage.
 * Co-fires with: the lineage-resolved dependency rule (both read the same durable
 * `replaces` edges the dispatcher's `effectiveDependency` walks) and the
 * fall-through, which may name a subject only when this set does not contain it.
 */
export function replacementCoverage(tasks: Task[]): Set<string> {
  const replaced = new Set<string>()
  const cover = (task: Task): void => {
    for (const source of task.replaces ?? []) {
      if (replaced.has(source)) continue
      replaced.add(source)
      const origin = tasks.find(candidate => candidate.id === source)
      if (origin !== undefined) cover(origin)
    }
  }
  for (const task of tasks) if (!TERMINAL_STATES.has(task.status)) cover(task)
  return replaced
}

/**
 * R14-F2(b): the stall roots of one board, in board order. Purely a function of
 * durable rows, so the pass, the timer-driven notice path, the delivery-time
 * relevance check and a test all classify the same board identically.
 */
export function stallRootsFor(rt: Pick<LineageRuntime, 'stallPassTimeoutMs'>, tasks: Task[]): Task[] {
  // A live replacement marks every id in its transitive lineage as covered.
  const replaced = replacementCoverage(tasks)
  return tasks.filter(task => {
    if (task.status !== 'blocked' || replaced.has(task.id)) return false
    // A verdict record is not a repairable root: its source carries the repair.
    if (task.reviewOf !== undefined) return false
    const stop = task.resumeAfterStop?.epoch === task.epoch ? task.resumeAfterStop : undefined
    if (stop === undefined) return true
    const at = stop.at
    // R14-F2v D2: a stop inside the declared bound is progress, not a root, but an
    // absent timestamp is UNBOUNDED — the bound cannot be shown to hold, so the
    // state escalates as a root rather than becoming silence (a pre-upgrade
    // durable row reaches exactly this state).
    return at === undefined || Date.now() - at > rt.stallPassTimeoutMs
  })
}

/**
 * R14-F2(c) / R16-A: whether an unfinished task is waiting on something still
 * alive — a live lease, the bounded review grace, a stop inside its bound, or an
 * unfinished dependency/predecessor edge. One implementation for the classifiers
 * and the delivery-time relevance check (`ownerDeliveryRelevant`).
 *
 * Co-firing guards, named: this classifier x the stall-root classifier (a blocked
 * predecessor is the ROOT's subject, named by the root notice with its
 * dependents, never re-named here) x the review grace (`reviewable` and the
 * review-admission terminal) x the off-pass wedged-pass classification.
 */
export function waitsLegitimately(rt: LineageRuntime, task: Task, tasks: Task[]): boolean {
  if (TERMINAL_STATES.has(task.status)) return false
  // R16-A: a task whose obligation is carried by a live replacement has a live
  // path whatever its own row says — the repair advances it.
  if (replacementCoverage(tasks).has(task.id)) return true
  // R17-G3: a running task with a live attempt row is NOT dead — the lease path
  // owns its expiry (fence, re-pend, re-route). Only a running row with no
  // attempt at all is unrecognised.
  if (task.status === 'running') return task.attempt !== undefined
  if (task.status === 'submitted') {
    // Submission remains in this state for the entire independent review. Use
    // the dispatcher's live-review rule, including an admitted/parked review,
    // rather than mistaking the end of the admission grace for a stalled task.
    if (rt.reviewable(task, tasks)) return true
    const submission = rt.latestSubmission(task.missionId, task.id)
    return submission === undefined || submission.age < Math.max(rt.config.tickMs, AUTO_REVIEW_GRACE_MS)
  }
  if (task.status === 'blocked') {
    const stop = task.resumeAfterStop?.epoch === task.epoch ? task.resumeAfterStop : undefined
    // R15-A3: an absent `at` is UNBOUNDED, so it is not legitimate waiting. The
    // "cannot judge" case must never be the silent one: `stallRootsFor` classifies
    // the same row as a root, and this classifier refusing it here keeps the two
    // in agreement instead of leaving the state both silent and unnamed.
    if (stop !== undefined) return stop.at !== undefined && Date.now() - stop.at <= rt.stallPassTimeoutMs
    return rt.unfinishedDependencies(task.missionId, task, tasks).length > 0
  }
  if (task.status === 'pending') {
    // Reviews wait on their exact source; no worker stop can repair a missing
    // or terminal source. Ordinary prerequisites keep the shared lineage rule.
    if (task.reviewOf !== undefined) {
      const source = tasks.find(candidate => candidate.id === task.reviewOf)
      return source !== undefined && !TERMINAL_STATES.has(source.status)
    }
    if (rt.unfinishedDependencies(task.missionId, task, tasks).length > 0) return true
    const graph = taskGraphIndex(tasks)
    if (!task.dependencies.every(dependency => graph.dependencyMet(dependency))) return false
    // A preparation failure the host will not retry is a block cause the owner
    // repairs (`blockCauses` owns that distinction). One carrying `retryAt` is the
    // host's own bounded back-off: a live wait until one tick past `retryAt`.
    // Past that bound the back-off explains nothing and the task is judged like
    // any other ready work below.
    const failure = task.preparationFailure
    if (failure !== undefined) {
      if (blockCauses(task, () => undefined, Number.POSITIVE_INFINITY).has('preparation-failed')) return false
      if (failure.retryAt !== undefined && Date.now() <= failure.retryAt + rt.config.tickMs) return true
    }
    // The same marker that fences dispatch is a live wait only while every
    // matching stop is inside its bound. An unknown owner reserves all members.
    const memberId = task.assigneeId ?? task.plannedAssigneeId
    const stops = tasks.filter(candidate => candidate.resumeAfterStop?.epoch === candidate.epoch
      && (candidate.id === task.id || candidate.resumeAfterStop.memberId === undefined
        || (memberId !== undefined && candidate.resumeAfterStop.memberId === memberId)))
    if (stops.length > 0) return stops.every(candidate => candidate.resumeAfterStop!.at !== undefined
      && Date.now() - candidate.resumeAfterStop!.at! <= rt.stallPassTimeoutMs)
    // Once the stop settles, another live attempt may take the selected member
    // first. Its bounded lease provides the next chance to run this ready work.
    return memberId !== undefined && tasks.some(candidate => candidate.status === 'running'
      && candidate.attempt?.ownerId === memberId && candidate.attempt.leaseUntil >= Date.now())
  }
  return false
}

const id = (prefix: string) => `${prefix}_${randomUUID()}`

export class Notices {
  /**
   * Deliveries a pump is currently attempting (cache-only claim keyed per
   * delivery, so two pumps cannot duplicate one attempt and one hung call
   * cannot claim the whole outbox).
   */
  private readonly delivering = new Map<string, number>()
  /** Start time of the running pump; ages out at the declared bound. */
  private pumpingSince?: number
  /** R17-G4: the per-owner budget window (no collection: keyed by mission id). */
  private readonly wakeWindows: Record<string, { startedAt: number; count: number; summaryId?: string }> = {}
  /** R17-G4: the shared bound and its window; public so a test can tighten them. */
  wakeBudget = DEFAULT_WAKE_BUDGET
  wakeBudgetWindowMs = DEFAULT_WAKE_WINDOW_MS
  /** R17-G5: how long an active mission may record no durable row before the absence net reports it. */
  absenceBoundMs = DEFAULT_ABSENCE_BOUND_MS
  /** Followups share the existing absence sweep and owner wake budget. */
  obligationFollowupMs = DEFAULT_ABSENCE_BOUND_MS
  maxObligationFollowups = 2
  /** R17-G8: the host claimed-signal subscription, disposed with the runtime. */
  private unsubscribeClaimed?: () => void
  /**
   * R17-G5: reentrancy guard for transition-driven generation. The classifier
   * itself commits (its delivery rows), and those commits must not re-enter it.
   */
  private publishingTransition = false
  /**
   * R17-G5: missions whose committed transitions still owe a fact publication.
   * Transitions are coalesced within the current task (a burst of commits from
   * one synchronous operation publishes the FINAL state once), then published
   * from the runtime's pass state — never from the sampled tick.
   */
  private readonly pendingTransitions = new Set<string>()
  private transitionScheduled = false
  /**
   * R17-G5: missions whose scheduling guard was just released as wedged. The
   * watchdog's release commit is the transition that owes the dispatch question
   * the dead pass never reached, so the next publication runs with the wedged
   * branch even though the pass row is already released.
   */
  private readonly wedgedReleases = new Set<string>()

  constructor(private readonly rt: SwarmRuntime) {}

  /**
   * Owner notices wake the primary agent and replay its whole context, so only
   * decisions, blockers, failures, budget exhaustion and final delivery use
   * them. Routine progress is already a durable event shown by the UI.
   *
   * Every notice is recorded in the notice-delivery ledger with the mission
   * state fingerprint it announces (`noticeFingerprint`, the spec §4 digest
   * with the announcement channel itself excluded) and its sent/queued/claimed
   * lifecycle. The runtime's own budget/ceiling refusals are deduplicated per
   * (class, fingerprint, sender); decision notices pass through so the liveness
   * engine's witness dedup stays in charge of them.
   *
   * R15-A1: the subjects are a required positional argument, refused when empty,
   * and written into the same durable delivery row as the content (never merged
   * in later). A call site that cannot name one task passes the mission root via
   * `missionSubject`; it can no longer pass nothing.
   */
  notify(missionId: string, content: string, subjects: string[], options: NotifyOptions = {}): void {
    const from = options.from ?? 'runtime'
    const noticeClass = options.noticeClass ?? 'decision'
    const mission = this.rt.store.get('missions', missionId)
    const attributed = noticeSubjects(subjects, mission ?? { id: missionId })
    // R17-G3: the fact identity is durable and recorded on the row. Dedup is on
    // the fact (subject@epoch + triggering event + recorded reason), so an
    // unrelated board change cannot re-arm a notice and a new fact cannot be
    // suppressed by an old one. A caller can still opt out explicitly.
    const family = options.family ?? (options.dedupKey === undefined ? undefined : options.dedupKey.split(':')[0])
    const fact: NoticeFactRecord = { subjects: attributed, trigger: options.trigger ?? options.dedupKey?.split(':')[0] ?? noticeClass, reason: options.reason ?? '', questionId: options.questionId, deliveryFailureId: options.deliveryFailureId, ...(family === undefined ? {} : { family }),
      ...(options.facts === undefined ? {} : { facts: options.facts }), ...(options.aggregatedIdentities === undefined ? {} : { aggregatedIdentities: options.aggregatedIdentities }) }
    const dedupe = options.dedupe ?? true
    // No-silent-state witness W2: every owner-decision notice is durable under
    // the fingerprint of the board it was emitted for, so the owner can verify
    // that no non-terminal state was silent. A terminal mission needs no witness.
    if ((options.stampWitness ?? true) && mission !== undefined && !this.rt.isMissionTerminal(mission)) {
      mission.witness = { fingerprint: this.rt.fingerprint(missionId), kind: 'W2', at: Date.now() }
      this.rt.store.put('missions', mission)
    }
    this.enqueueOwnerNotice(missionId, content, from, noticeClass, { subjects: attributed, fact }, dedupe, options.dedupKey)
  }

  /** The notice dedup key: F(S) with the owner-notice channel excluded. */
  noticeKey(missionId: string): string {
    return computeNoticeKey(this.rt.fingerprintRecords(missionId))
  }

  /**
   * Record one owner-addressed notice (or an escalation) durably. Returns the
   * delivery, or undefined when the same class already announced the same
   * fingerprint from the same sender: the runtime's own budget/ceiling refusals
   * are deduplicated per state so an unchanged board never spams the owner.
   * Decision notices are always recorded — the liveness engine deduplicates its
   * own witnesses per fingerprint and clears them when the board leaves the
   * class, so change-and-return must be able to re-notify. Callers may already
   * be inside a transaction; this method only reads and writes through the
   * store and never opens one.
   */
  enqueueOwnerNotice(missionId: string, content: string, from: string, noticeClass: NoticeClass, extra: Partial<Delivery> & { fact?: NoticeFactRecord } = {}, dedupe = noticeClass === 'budget', dedupKeyOverride?: string): Delivery | undefined {
    const fact = extra.fact
    // R17-G3: the fact key is the default identity; the board fingerprint is
    // kept only for the callers that still pass an explicit key.
    const dedupKey = dedupKeyOverride ?? (fact === undefined ? this.noticeKey(missionId) : factKey(missionId, fact))
    if (dedupe && hasNotice(this.rt.store.list('deliveries', missionId), { class: noticeClass, dedupKey, from })) return undefined
    const at = Date.now()
    // R17-G4: one per-owner budget bounds every family together. Over budget, the
    // fact is carried by the window's degraded summary instead of being dropped.
    const summary = this.wakeWindowFor(missionId, at)
    if (summary !== undefined && summary.count >= this.wakeBudget) {
      const facts = fact?.facts ?? [`[${fact?.trigger ?? noticeClass}] ${content}`]
      this.appendToWakeSummary(missionId, summary, facts, [{
        class: noticeClass, dedupKey, from, contentDigest: createHash('sha256').update(content).digest('hex'),
      }, ...(fact?.aggregatedIdentities ?? [])], at, {
        class: noticeClass, dedupKey, from, subjects: fact?.subjects ?? [],
        trigger: fact?.trigger ?? noticeClass, reason: fact?.reason ?? '', createdAt: at, questionId: fact?.questionId, deliveryFailureId: fact?.deliveryFailureId,
      })
      return undefined
    }
    const { fact: _fact, ...deliveryExtra } = extra
    const delivery: Delivery = {
      id: id('msg'), missionId, from, to: 'owner', kind: noticeClass === 'escalation' ? 'escalation' : 'control',
      content, createdAt: at,
      notice: { dedupKey, class: noticeClass, sentAt: at, queuedAt: at, ...(fact === undefined ? {} : { subjects: fact.subjects, trigger: fact.trigger, reason: fact.reason, facts: fact.facts, aggregatedIdentities: fact.aggregatedIdentities, questionId: fact.questionId, deliveryFailureId: fact.deliveryFailureId }) } as NonNullable<Delivery['notice']>,
      ...deliveryExtra,
    }
    const limit = Math.min(MAX_OWNER_NOTICE_CHARS, this.rt.config.maxMessageChars)
    if (content.length > limit) {
      const row = noticeRow(delivery)!
      row.facts ??= [content]
      row.aggregatedIdentities = [...(row.aggregatedIdentities ?? []), { class: noticeClass, dedupKey, from, contentDigest: createHash('sha256').update(content).digest('hex') }]
      delivery.content = renderNoticeFacts(`Owner ${noticeClass}: ${row.facts.length} recorded fact(s).`, row.facts, missionId, delivery.id, limit)
    }
    if (summary !== undefined) summary.count += 1
    this.rt.store.put('deliveries', delivery)
    return delivery
  }

  /**
   * R17-G4: the shared per-owner budget window. Every owner notice of a mission
   * counts, whatever its family; the window rolls over on the declared interval.
   * Returns undefined when budgeting is disabled (`wakeBudget <= 0`).
   */
  private wakeWindowFor(missionId: string, now: number): { startedAt: number; count: number; summaryId?: string } | undefined {
    if (this.wakeBudget <= 0) return undefined
    const current = this.wakeWindows[missionId]
    if (current !== undefined && now - current.startedAt <= this.wakeBudgetWindowMs) return current
    const next = { startedAt: now, count: 0 }
    this.wakeWindows[missionId] = next
    return next
  }

  /**
   * R17-G4: carry one over-budget fact in the window's single summary delivery.
   * The summary is one delivery whose content lists every degraded fact; while it
   * is still undelivered the fact is appended to it, and once it has been
   * delivered the next over-budget fact opens a fresh summary — a fact is never
   * dropped, it is only ever reported in degraded form. Original identities are
   * written with the content: the summary's transport key must never replace
   * the class, sender and key used to deduplicate its constituent facts.
   */
  private appendToWakeSummary(missionId: string, window: { startedAt: number; count: number; summaryId?: string }, addedFacts: string[], identities: NonNullable<NoticeRow['aggregatedIdentities']>, at: number, constituent: Omit<NonNullable<NoticeRow['aggregatedFacts']>[number], 'factStart' | 'factCount'>): void {
    const existing = window.summaryId === undefined ? undefined : this.rt.store.get('deliveries', window.summaryId)
    if (existing !== undefined && existing.deliveredAt === undefined && existing.notice !== undefined) {
      const row = noticeRow(existing)!
      const factStart = row.facts?.length ?? 0
      const facts = [...(row.facts ?? []), ...addedFacts]
      row.facts = facts
      row.aggregatedIdentities = [...(row.aggregatedIdentities ?? []), ...identities]
      row.aggregatedFacts = [...(row.aggregatedFacts ?? []), { ...constituent, factStart, factCount: addedFacts.length }]
      existing.content = renderNoticeFacts(WAKE_SUMMARY_HEADER, facts, missionId, existing.id, Math.min(MAX_OWNER_NOTICE_CHARS, this.rt.config.maxMessageChars))
      this.rt.store.put('deliveries', existing)
      return
    }
    const summary: Delivery = {
      id: id('msg'), missionId, from: 'runtime', to: 'owner', kind: 'control',
      content: '', createdAt: at,
      notice: { dedupKey: `wake-budget:${missionId}:${window.startedAt}`, class: 'decision', sentAt: at, queuedAt: at, facts: addedFacts, aggregatedIdentities: identities, aggregatedFacts: [{ ...constituent, factStart: 0, factCount: addedFacts.length }], trigger: 'wake-budget', reason: 'per-owner wake budget exceeded' } as NonNullable<Delivery['notice']>,
    }
    summary.content = renderNoticeFacts(WAKE_SUMMARY_HEADER, addedFacts, missionId, summary.id, Math.min(MAX_OWNER_NOTICE_CHARS, this.rt.config.maxMessageChars))
    window.summaryId = summary.id
    this.rt.store.put('deliveries', summary)
  }

  /**
   * Record admitted context, after pre-step filtering. Inbox claim alone is
   * insufficient: a stopped mission's queued message can be claimed and then
   * discarded without ever reaching the owner's model context.
   */
  attach(workers: WorkerAdapter): void {
    if (this.unsubscribeClaimed !== undefined) return
    const ctx = hostContextOf(workers) as { on?: (name: string, handler: (session: { header: { id: string } }, event: { type: string; data: unknown }) => void) => () => void } | undefined
    if (ctx === undefined || typeof ctx.on !== 'function') return
    try {
      this.unsubscribeClaimed = ctx.on('session/event', (session, event) => {
        if (event.type !== 'user/message') return
        const source = (event.data as { source?: { kind?: unknown; deliveryId?: unknown } } | undefined)?.source
        if (source === undefined || source.kind !== 'swarm' || typeof source.deliveryId !== 'string') return
        const delivery = this.rt.store.get('deliveries', source.deliveryId)
        if (delivery?.to !== 'owner' || this.rt.store.get('missions', delivery.missionId)?.ownerSessionId !== String(session.header.id)) return
        this.recordConsumption(source.deliveryId, { source: 'user/message' })
      })
    } catch { this.unsubscribeClaimed = undefined }
  }

  /** R17-G8: release the host claimed-signal subscription. Idempotent. */
  dispose(): void {
    try { this.unsubscribeClaimed?.() } catch { /* the host fiber may already be gone */ }
    this.unsubscribeClaimed = undefined
  }

  /**
   * R17-G8: record real consumption from the host's admitted message. The write is
   * a compare-and-swap inside the mission transaction: a delivery is consumed
   * once, and a second signal (a replay, a second pump) cannot move the
   * timestamp. Delivered, consumed and resolved stay three separate facts.
   */
  recordConsumption(deliveryId: string, options: { at?: number; source?: string } = {}): boolean {
    const delivery = this.rt.store.get('deliveries', deliveryId)
    if (delivery === undefined || delivery.notice === undefined) return false
    const at = options.at ?? Date.now()
    const source = options.source ?? 'user/message'
    let recorded = false
    this.rt.commit(delivery.missionId, () => {
      const fresh = this.rt.store.get('deliveries', deliveryId)
      if (fresh === undefined || fresh.notice === undefined) return
      const row = noticeRow(fresh)!
      if (row.consumedAt !== undefined) return
      row.consumedAt = at
      row.consumptionSource = source
      this.rt.store.put('deliveries', fresh)
      recorded = true
    })
    return recorded
  }

  /**
   * R16-A: the single owner gate for the read-only owner instruments (the notice
   * ledger). One refusal site: the retained S3 inventory counts uncoded throw
   * sites and may only shrink, and the ledger's observable message is preserved
   * verbatim through `instrument`.
   */
  private requireOwner(actor: Actor, missionId: string, instrument: string): void {
    const { owner } = this.rt.participant(actor, missionId)
    if (!owner) throw new PolicyError('observe_owner_required', 'authorization_error', `Only the mission owner can read the ${instrument}`)
  }

  /**
   * Read-only notice-delivery ledger: every owner notice with its class, dedup
   * key and sent/queued/claimed lifecycle, newest first. Owner-only: owner
   * notices are control-plane decisions, not worker-visible board content.
   *
   * R15-A1/B: three facts that are never collapsed into one.
   * - delivery/transport: `sentAt`/`queuedAt` and `state` (`queued` / `claimed`
   *   by the adapter call that put the notice in front of the owner session);
   * - consumption: reported as `unknown`, because this host exposes no reliable
   *   native signal proving the owner consumed the notice. A `claimed` transport
   *   is never relabelled as handled;
   * - resolution: not a transport event at all. It is the mission/task/owner
   *   transition that made the decision moot, and it is not recorded here. A
   *   resolution never clears another subject's pending decision, and a healthy
   *   sibling never resets this subject's clock.
   *
   * The projected subjects are merged back from the durable delivery row (the
   * row, not the prose, is the authority for what the notice was about).
   */
  noticeLedger(actor: Actor, missionId: string, query: { limit?: number } = {}): unknown {
    this.requireOwner(actor, missionId, 'notice-delivery ledger')
    const limit = query.limit === undefined ? 20 : Math.max(1, Math.min(100, Math.trunc(query.limit)))
    const rows = this.rt.store.list('deliveries', missionId)
    const subjectRow = (deliveryId: string): string[] | undefined => {
      // A bounded linear lookup rather than a second in-memory index: the ledger
      // is a read-only page of at most `limit` rows over one mission's deliveries.
      for (const row of rows) if (row.id === deliveryId) return row.subjects
      return undefined
    }
    const entries = projectNoticeLedger(rows, limit).map(entry => {
      const subjects = subjectRow(entry.deliveryId)
      return {
        ...entry,
        ...(subjects === undefined ? {} : { subjects }),
        consumption: 'unknown' as const,
      }
    })
    return {
      ledger: entries,
      page: { limit, returned: entries.length },
      fingerprint: this.rt.fingerprint(missionId),
      note: 'Read-only: each row names the subjects the notice is about (`taskId@epoch` or `mission:<id>`) and the mission-state fingerprint it announced. `state` is the transport fact (queued, or claimed by the adapter that put it in front of the owner session); consumption is unknown because this host exposes no reliable signal for it; resolution is a task/mission transition, never a transport event. Recording a notice changes no task, member or budget state.',
    }
  }

  bounded(text: string): string {
    requireText(text, 'content')
    if (text.length > this.rt.config.maxMessageChars) throw new PolicyError('content_too_long', 'tool_error', `Content exceeds ${this.rt.config.maxMessageChars} characters`)
    return text
  }

  /**
   * R17-G1: the ONE shared interpretation of a mission's durable state. Every
   * owner-facing generator reads this view instead of re-reading raw rows and
   * re-deriving its own answer, and the dispatcher's own predicates
   * (`ready`, `unfinishedDependencies`, `reviewable`) are what it exposes, so a
   * notice can never describe a board the dispatcher would act on differently.
   * Read-only: it writes nothing and holds no cache.
   */
  interpretation(missionId: string): MissionInterpretation {
    const mission = this.rt.mission(missionId)
    const tasks = this.rt.store.list('tasks', missionId)
    const members = this.rt.store.list('members', missionId)
    const runnable = members.filter(member => member.status === 'idle' || member.status === 'waiting')
    return {
      missionId, mission, tasks, members, runnable,
      nonTerminal: tasks.filter(task => !TERMINAL_STATES.has(task.status)),
      stallRoots: this.stallRoots(tasks),
      replaced: replacementCoverage(tasks),
      ready: (task, member, rows = tasks) => this.rt.ready(task, member, rows),
      // The dispatcher's own question and its own predicates, computed once here
      // so a notice can never describe a board the dispatcher would act on
      // differently (`ready`, `reviewable`, `unschedulable`, `stalled`).
      dispatchable: tasks.filter(task => task.status === 'pending' && runnable.some(member => this.rt.ready(task, member, tasks))),
      unreviewed: tasks.filter(task => task.status === 'submitted' && !this.rt.reviewable(task, tasks)),
      unschedulable: this.rt.unschedulable(mission, tasks, members),
      stalled: this.rt.stalled(mission, tasks, members),
      parkedHolders: tasks.filter(task => task.status === 'running' && task.attempt !== undefined
        && members.some(member => member.id === task.attempt?.ownerId && memberPhaseOf(member) === 'parked'))
        .map(task => ({ task, member: members.find(member => member.id === task.attempt?.ownerId)! })),
      implementations: tasks.filter(task => task.kind === 'implementation'),
      lastTransitionAt: this.lastTransitionAt(missionId),
      subjectsOf: list => subjectsOfTasks(list, mission),
    }
  }

  /**
   * R17-G5: the absence net — one of the two absence instruments a sampled tick
   * emits (the other is the retained attempt-silence escalation,
   * `Scheduling.sweepSilentAttempts`, bounded by `attemptSilenceBoundMs`). It
   * reports the absence of a durable transition and the elapsed clock — never a
   * cause, and never a subject beyond the mission root — so no sampled tick can
   * invent a causal claim no row supports. The bound is a public field so the
   * declared silence bound stays configuration, and the dedup key is the
   * observed absence instant: one report per absence, a new one when time moves on.
   */
  absenceNet(missionId: string, options: { boundMs?: number } = {}): void {
    const view = this.interpretation(missionId)
    const mission = view.mission
    this.followupObligations(view)
    if (mission.status !== 'active' || mission.budgetPause !== undefined) return
    const lastAt = view.lastTransitionAt
    const elapsed = Math.max(0, Date.now() - lastAt)
    const bound = options.boundMs ?? this.absenceBoundMs
    if (elapsed < bound) return
    // One long operation owns its existing activity bound. Starting another
    // short operation after progress is already overdue cannot hide that gap.
    if (view.members.some(member => member.activity !== undefined && member.activity.startedAt <= lastAt + bound)) return
    const key = `absence:${missionId}:${lastAt}`
    if (hasNotice(this.rt.store.list('deliveries', missionId), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    this.rt.commit(missionId, () => {
      this.notify(missionId, `No durable task, evidence or owner-decision progress recorded for ${elapsed}ms (declared bound ${bound}ms) on an active mission. The absence net reports the absence and the elapsed clock only; read the board for the state.`, [missionSubject(view.mission)], {
        dedupe: true, dedupKey: key, trigger: 'absence-net', reason: `no durable progress for ${elapsed}ms`,
      })
    })
  }

  /** A progress clock excludes scheduling, usage, transport and repeated tool logs. */
  private lastTransitionAt(missionId: string): number {
    const mission = this.rt.store.get('missions', missionId) as (Mission & { meaningfulProgressAt?: number }) | undefined
    if (mission === undefined) return 0
    let latest = mission.meaningfulProgressAt ?? mission.createdAt
    const progressTypes = new Set([
      'mission/created', 'mission/resume', 'mission/budget-updated', 'mission/revised', 'mission/scope-amended',
      'task/proposed', 'task/claimed', 'task/submitted', 'task/accepted', 'task/rejected',
      'task/cancelled', 'task/cancelled-at-completion', 'task/handoff', 'task/revised', 'task/amended',
      'evidence/published', 'evidence/verified', 'evidence/refuted', 'message/answered', 'message/dismissed',
    ])
    for (const event of this.rt.store.events(missionId, this.rt.config.maxEvents)) {
      if (progressTypes.has(event.type)) latest = Math.max(latest, event.createdAt)
    }
    for (const evidence of this.rt.store.list('evidence', missionId)) if (Number.isFinite(evidence.createdAt)) latest = Math.max(latest, evidence.createdAt)
    return latest
  }

  /** Revisit delivered decisions only while their original durable obligation still stands. */
  private followupObligations(view: MissionInterpretation): void {
    const mission = view.mission
    if (!['active', 'blocked'].includes(mission.status)) return
    const now = Date.now()
    for (const delivery of this.rt.store.list('deliveries', mission.id)) {
      const fact = noticeRow(delivery)
      if (delivery.to !== 'owner' || delivery.deliveredAt === undefined || fact === undefined
        || ['progress', 'completion'].includes(fact.class)
        || FOLLOWUP_EXCLUDED_FAMILIES.has(noticeFamily(delivery))) continue
      const spent = fact.followupCount ?? 0
      if (spent >= this.maxObligationFollowups || now - (fact.followupAt ?? delivery.deliveredAt) < this.obligationFollowupMs) continue
      const unresolved = this.unresolvedSubjects(view, delivery)
      if (unresolved.length === 0) continue
      const priorContent = fact.aggregatedFacts === undefined ? delivery.content
        : fact.aggregatedFacts.filter(part => this.unresolvedSubjects(view, this.summaryFactDelivery(mission.id, delivery.id, part)).length > 0)
          .flatMap(part => this.summaryFactText(delivery, part)).join('\n')
      this.rt.commit(mission.id, () => {
        const current = this.rt.store.get('deliveries', delivery.id)
        const currentFact = current === undefined ? undefined : noticeRow(current)
        if (current === undefined || currentFact === undefined || (currentFact.followupCount ?? 0) !== spent) return
        currentFact.followupCount = spent + 1
        currentFact.followupAt = now
        this.rt.store.put('deliveries', current)
        this.notify(mission.id, `Owner decision still unresolved (reminder ${spent + 1} of ${this.maxObligationFollowups}, original delivery ${delivery.id}). Subjects: ${unresolved.join(', ')}. Prior notice: ${compactFact(priorContent, 600)}\nRead the original with swarm_observe({ missionId: "${mission.id}", deliveryId: "${delivery.id}" }) and apply the decision.${spent + 1 === this.maxObligationFollowups ? '\nReminder limit reached; the unresolved obligation remains on the board.' : ''}`, unresolved,
          { dedupe: true, dedupKey: `obligation-followup:${delivery.id}:${spent + 1}`, trigger: 'owner-decision-unresolved', reason: delivery.id, stampWitness: false })
      })
    }
  }

  /** The current obligation, shared by reminder generation and queued reminders. */
  private unresolvedSubjects(view: MissionInterpretation, delivery: Delivery): string[] {
    const mission = view.mission
    if (!['active', 'blocked'].includes(mission.status)) return []
    if (delivery.notice !== undefined && (['progress', 'completion'].includes(delivery.notice.class)
      || FOLLOWUP_EXCLUDED_FAMILIES.has(noticeFamily(delivery)))) return []
    if (delivery.notice?.aggregatedFacts !== undefined) {
      return [...new Set(delivery.notice.aggregatedFacts.flatMap(fact => this.unresolvedSubjects(view, this.summaryFactDelivery(mission.id, delivery.id, fact))))]
    }
    const stopFailures = this.stopFailureSubjects(mission.id, delivery)
    if (stopFailures !== undefined) return stopFailures
    return (delivery.subjects ?? [missionSubject(mission)]).filter(subject => {
      if (subject === missionSubject(mission)) {
        if (delivery.notice?.class === 'budget') return (mission.budgetReviewedAt ?? 0) <= delivery.createdAt
        return mission.status === 'blocked' || mission.budgetPause !== undefined || view.stalled
          || (view.tasks.length > 0 && view.nonTerminal.length === 0)
      }
      const task = taskFromSubject(subject, view.tasks)
      return task !== undefined && !TERMINAL_STATES.has(task.status) && !this.waitsLegitimately(task, view.tasks)
    })
  }

  /**
   * Recheck actionable notices at the last outbox boundary and when selecting
   * the owner's protocol. Superseded decisions stay in the durable ledger;
   * they are not relabelled as delivered. Unclassified legacy facts and final
   * results remain deliverable because completion can overtake the outbox.
   */
  ownerDeliveryRelevant(mission: Mission, delivery: Delivery): boolean {
    if (ownerDeliveryMoot(mission, delivery)) return false
    if (delivery.replyExpected === true && delivery.answeredBy !== undefined) return false
    const stopFailures = this.stopFailureSubjects(mission.id, delivery)
    if (stopFailures !== undefined) return mission.status !== 'completed' && stopFailures.length > 0
    const fact = noticeRow(delivery)
    // A receipt-linked action expires when that exact question is settled;
    // task or mission progress is neither necessary nor sufficient to settle it.
    const legacyQuestionKey = fact?.dedupKey.startsWith('owner-reply-missing:') ? fact.dedupKey.slice('owner-reply-missing:'.length, fact.dedupKey.lastIndexOf(':')) : undefined
    const questionId = fact?.questionId ?? legacyQuestionKey
    if (questionId !== undefined) {
      const question = this.rt.store.get('deliveries', questionId)
      if (question?.missionId !== mission.id || question.to !== 'owner' || question.replyExpected !== true || question.answeredBy !== undefined) return false
    }
    if (fact?.deliveryFailureId !== undefined) {
      const failed = this.rt.store.get('deliveries', fact.deliveryFailureId)
      if (failed?.missionId !== mission.id || failed.deliveryFailure === undefined) return false
      if (!this.rt.store.list('deliveries', mission.id).some(row => row.to === failed.to && row.deliveredAt === undefined
        && row.deliveryFailure?.reason === failed.deliveryFailure!.reason && row.deliveryFailure.at >= failed.deliveryFailure!.at)) return false
    }
    if (fact?.trigger === 'mission/budget-warning' && !this.currentBudgetWarnings(mission, fact).some(Boolean)) return false
    if (fact === undefined || fact.class === 'completion' || fact.class === 'progress') return true
    if (fact.aggregatedFacts !== undefined) return this.relevantSummaryFacts(mission, delivery).length > 0
    const family = noticeFamily(delivery)
    if (mission.status === 'completed' && (['budget', 'stall', 'blocker'].includes(fact.class)
      || ((DECISION_FAMILIES as readonly string[]).includes(family) && !family.startsWith('owner-reply-')))) return false
    if (family === 'obligation-followup') {
      const original = fact.reason === undefined ? undefined : this.rt.store.get('deliveries', fact.reason)
      return this.unresolvedSubjects(this.interpretation(mission.id), original ?? delivery).length > 0
    }
    if (family === 'review-blocked' || family === 'fallthrough' || family === 'stall-root'
      || family === 'dispatch-question' || family === 'parked') {
      const tasks = this.rt.store.list('tasks', mission.id)
      const subjects = delivery.subjects ?? fact.subjects ?? []
      // Old unattributed rows cannot be judged from their text alone.
      if (subjects.length === 0) return true
      // A batch asserts the condition for every named subject. If one changes,
      // the transition publisher emits the remaining subjects as a fresh fact.
      // A stall-root decision asserts it of its root alone (the subject its key
      // names): the dependents it lists are consequences, never roots, so judging
      // them as roots made every stall root with a dependent undeliverable.
      const rootPrefix = `stall-root:${mission.id}:`
      const judged = family !== 'stall-root' ? subjects
        : [fact.dedupKey.startsWith(rootPrefix) ? fact.dedupKey.slice(rootPrefix.length) : subjects[0]!]
      return judged.every(subject => {
        if (subject === missionSubject(mission)) return true
        const task = taskFromSubject(subject, tasks)
        if (task === undefined || TERMINAL_STATES.has(task.status)) return false
        if (family === 'review-blocked') return task.status === 'submitted' && !this.rt.reviewable(task, tasks)
        if (family === 'fallthrough') return !this.waitsLegitimately(task, tasks)
        if (family === 'stall-root') return stallRootsFor(this.rt, tasks).some(root => root.id === task.id)
        if (family === 'dispatch-question') return task.status === 'pending'
        return this.interpretation(mission.id).parkedHolders.some(holder => holder.task.id === task.id)
      })
    }
    // Before review-blocked was explicit, missing-review notices were generic
    // decisions. Their still-submitted subjects are enough to recognize that
    // admitting a review fulfilled the request without interpreting prose.
    if (fact.class === 'decision' && fact.trigger === 'decision' && delivery.subjects?.length) {
      const tasks = this.rt.store.list('tasks', mission.id)
      if (delivery.subjects.every(subject => {
        const task = taskFromSubject(subject, tasks)
        return task?.status === 'submitted' && this.rt.reviewable(task, tasks)
      })) return false
    }
    return true
  }

  /** A cancelled task can still owe preservation; its exact stop fault ends when cleanup succeeds. */
  private stopFailureSubjects(missionId: string, delivery: Delivery): string[] | undefined {
    const prefix = 'guard-terminal:attempt_lease:attempt_terminal:stop:'
    const key = delivery.notice?.dedupKey
    if (!key?.startsWith(prefix)) return undefined
    const tasks = this.rt.store.list('tasks', missionId)
    return (delivery.subjects ?? []).filter(subject => {
      const task = taskFromSubject(subject, tasks)
      const marker = task?.resumeAfterStop
      if (task === undefined || marker?.epoch !== task.epoch || marker.failure === undefined) return false
      const digest = createHash('sha256').update(marker.failure.message).digest('hex')
      return key === `${prefix}${task.id}:${marker.epoch}:${marker.memberId ?? 'unresolved'}:${digest}`
    })
  }

  /** Re-render only structured batches, leaving their original ledger intact. */
  ownerDeliveryContent(mission: Mission, delivery: Delivery): string {
    const fact = noticeRow(delivery)
    if (fact?.aggregatedFacts !== undefined) {
      const facts = this.relevantSummaryFacts(mission, delivery).flatMap(part => this.summaryFactText(delivery, part))
      return renderNoticeFacts('Current owner facts; superseded actions remain in the durable record.', facts, mission.id, delivery.id, Math.min(MAX_OWNER_NOTICE_CHARS, this.rt.config.maxMessageChars))
    }
    if (fact?.trigger === 'mission/budget-warning' && fact.facts !== undefined) {
      const flags = this.currentBudgetWarnings(mission, fact)
      if (flags.some(current => !current)) return renderNoticeFacts('Current resource review; superseded limits remain in the durable record.',
        fact.facts.filter((_text, index) => index >= flags.length || flags[index]), mission.id, delivery.id, Math.min(MAX_OWNER_NOTICE_CHARS, this.rt.config.maxMessageChars))
    }
    return delivery.content
  }

  /** Budget warning identities encode their allocation; no body parsing. */
  private currentBudgetWarnings(mission: Mission, fact: { reason?: string }): boolean[] {
    const prefix = `budget-review:${mission.id}:`
    return (fact.reason ?? '').split('\n').map(key => {
      if (!key.startsWith(prefix)) return true // Legacy facts remain readable.
      const match = /^(.*):(maxTokens|maxSteps|maxDurationMs|maxTasks|maxFindings):([\d.e+-]+):([\d.e+-]+)$/.exec(key.slice(prefix.length))
      if (match === null) return true
      const [, owner, dimension, limit] = match
      if (owner === 'mission') return (mission.budget as unknown as Record<string, number>)[dimension!] === Number(limit)
      const task = this.rt.store.get('tasks', owner!)
      return task?.missionId === mission.id && !TERMINAL_STATES.has(task.status)
        && (task as unknown as Record<string, unknown>)[dimension!] === Number(limit)
    })
  }

  /** Reuse the ordinary notice policy; legacy text-only summaries stay untouched. */
  private relevantSummaryFacts(mission: Mission, delivery: Delivery): NonNullable<NoticeRow['aggregatedFacts']> {
    return (delivery.notice?.aggregatedFacts ?? []).filter(fact => this.ownerDeliveryRelevant(mission, this.summaryFactDelivery(mission.id, delivery.id, fact)))
  }

  private summaryFactDelivery(missionId: string, deliveryId: string, fact: NonNullable<NoticeRow['aggregatedFacts']>[number]): Delivery {
    return {
      id: deliveryId, missionId, to: 'owner', from: fact.from,
      kind: fact.class === 'escalation' ? 'escalation' : 'control', content: '',
      subjects: fact.subjects, createdAt: fact.createdAt,
      notice: { class: fact.class, dedupKey: fact.dedupKey, sentAt: fact.createdAt, queuedAt: fact.createdAt,
        trigger: fact.trigger, reason: fact.reason, questionId: fact.questionId, deliveryFailureId: fact.deliveryFailureId } as NonNullable<Delivery['notice']>,
    }
  }

  /** Constituents reference the existing text array so exact reads do not duplicate it. */
  private summaryFactText(delivery: Delivery, fact: NonNullable<NoticeRow['aggregatedFacts']>[number]): string[] {
    const text = (noticeRow(delivery)?.facts ?? []).slice(fact.factStart, fact.factStart + fact.factCount)
    if (fact.trigger !== 'mission/budget-warning') return text
    const flags = this.currentBudgetWarnings(this.rt.mission(delivery.missionId), fact)
    return text.filter((_text, index) => index >= flags.length || flags[index])
  }

  /**
   * R17-G5: publish the facts of ONE committed transition. A state change now
   * drives generation: the caller (the runtime's commit funnel) invokes this
   * after the transaction that changed the board, so the decision families run
   * against the state the change produced rather than against a later sample of
   * it. The pass state decides the one branch that is only meaningful at the end
   * of a pass (the dispatcher's "ready but not dispatched" question): it runs
   * off-pass, and a wedged pass keeps its own subject. Reentrant calls (the
   * classifier's own commits) are ignored. The sampled tick path emits exactly
   * two absence instruments and no cause: the absence net here and the retained
   * attempt-silence escalation (`Scheduling.sweepSilentAttempts`, bounded by
   * `attemptSilenceBoundMs`).
   */
  transition(missionId: string): void {
    // Save progress when its transition commits, before telemetry can evict it
    // from the bounded event window. Interpretation remains read-only.
    const mission = this.rt.store.get('missions', missionId) as (Mission & { meaningfulProgressAt?: number }) | undefined
    const progressAt = this.lastTransitionAt(missionId)
    if (mission !== undefined && mission.meaningfulProgressAt !== progressAt) {
      mission.meaningfulProgressAt = progressAt
      this.rt.commit(missionId, () => this.rt.store.put('missions', mission))
    }
    if (this.publishingTransition) return
    this.pendingTransitions.add(missionId)
    if (this.transitionScheduled) return
    this.transitionScheduled = true
    queueMicrotask(() => {
      this.transitionScheduled = false
      const pending = [...this.pendingTransitions]
      this.pendingTransitions.clear()
      for (const id of pending) this.publishTransition(id)
    })
  }

  /** R17-G5: mark the next publication of a released-wedged pass's mission. */
  expectWedgedRelease(missionId: string): void { this.wedgedReleases.add(missionId) }

  /** R17-G5: publish one mission's committed transitions against its settled state. */
  private publishTransition(missionId: string): void {
    if (this.publishingTransition) return
    this.publishingTransition = true
    try {
      // A live pass owns the dispatcher's "ready but not dispatched" question
      // (R15-D3: generation must not invent the cause the pass is about to
      // resolve), so a transition inside a pass classifies with `offPass`; the
      // question is asked by the transition that ends or releases the pass, and
      // by a wedged pass, which never reached its own question.
      const state = this.rt.passState(missionId)
      const released = this.wedgedReleases.delete(missionId)
      // A live, un-wedged pass owns generation: it will publish at its own close
      // (the commit that closes the pass is a transition of this same funnel), so
      // a mid-pass commit cannot describe a board the dispatcher is still acting
      // on — the D3/R15-A4 rule, now applied without sampling.
      if (state.passLive && !state.wedged && !released) return
      const options = state.wedged || released ? { offPass: true, wedged: true } : {}
      this.ensureWitness(missionId, options)
    } catch {
      // A generation failure must never break the commit that triggered it; the
      // next transition (or the absence net) re-derives the same facts.
    } finally {
      this.publishingTransition = false
    }
  }

  /**
   * No-silent-state backstop (docs/no-silent-state-spec.md §2). Runs after a
   * scheduling pass that changed nothing: a non-terminal mission must still
   * leave the owner with a witness. Exemptions are the documented ones — the
   * empty board the owner is still planning (row 17) and a board whose
   * non-terminal work is running under a live lease (row 3). The bounded
   * missing-review grace is respected: the row-5 notice arrives after
   * `AUTO_REVIEW_GRACE_MS`, not on the tick the artifact was submitted. A
   * submitted artifact with no live review path is witnessed even while
   * unrelated work runs, because no other witness can ever advance it.
   *
   * R15-A2: this is the same decision function the tick timer drives when no
   * live scheduling pass exists (`options.offPass`), so a mission whose pass
   * never returns (a hung `workers.start`) still names its subjects instead of
   * staying silent. The one branch that is only meaningful at the end of a pass
   * — the dispatcher's "ready but not dispatched" question — is skipped
   * off-pass: before a pass has run, a ready task is not yet a decision.
   *
   * Every notice below is recorded inside `rt.commit`, so the delivery row that
   * carries the subjects is written in the SAME transaction as the transition
   * (the witness stamp, the stall event) that produced it.
   */
  ensureWitness(missionId: string, options: { offPass?: boolean; wedged?: boolean } = {}): void {
    // R17-G1: the shared interpretation is the only input; no generator below
    // re-reads a raw row to decide what the board means.
    const view = this.interpretation(missionId)
    const mission = view.mission
    if (mission.status !== 'active') return
    const tasks = view.tasks
    const members = view.members
    // Row 17: the owner has not planned work yet; `stalled` uses the same rule.
    if (!tasks.length) return
    // R14-F2(b): stall roots are classified BEFORE the F(S) dedup. A root is an
    // owner decision no other notice can advance, so an unrelated notice that
    // consumed the board fingerprint must not silence it.
    const stallRootNotices = this.notifyStallRoots(view)
    const fingerprint = this.rt.fingerprint(missionId)
    // R15-D1: a WEDGED pass is its own subject, exactly like a stall root. The
    // board witness records that *some* notice announced this fingerprint; an
    // unrelated notice (the integration-gap warning, a coverage notice) must not
    // consume the decision a dead pass owes its task. The pass-scoped path keeps
    // the dedup: there, an unchanged board is exactly what the witness means.
    if (options.wedged !== true && mission.witness?.fingerprint === fingerprint) return
    // Spec §2 dispatchable: pending, dependencies accepted, and an idle or
    // waiting member can run it. A working member is busy, not a silent board.
    const runnable = view.runnable
    // R17-G1: the dispatcher's own `dispatchable` set, from the shared view.
    const dispatchable = options.wedged === true
      ? tasks.filter(task => task.status === 'pending' && members.some(member => memberPhaseOf(member) !== 'stopped' && view.ready(task, member)))
      : view.dispatchable
    if (dispatchable.length && options.offPass === true && options.wedged !== true) {
      // R15-D3: between passes the dispatcher's branch owns this state, and it may
      // still dispatch the task in this same tick. The sweep must not invent a
      // cause the dispatcher's own branch refuses — silently returning here is what
      // keeps "ready but the only eligible handle is busy" from becoming a false
      // "no live path will advance" wake (the round-14 dirty-workspace shape).
      return
    }
    if (dispatchable.length) {
      // A handle that is working is not a silent board: when no runnable member
      // could be started at all, those members are working and no witness is owed
      // (the T3 integration rule; a false stall notice is as bad as a missing
      // one). The dispatcher's question is owed only when the board LOOKS
      // dispatchable — at least one startable member exists — and the task still
      // did not dispatch.
      //
      // R15-A4: the false-cause sentence is then replaced by the dispatcher's own
      // question, asked per (task, assignee) with the sweep's predicates. It names
      // the member whose handle holds the task when that is the blocker, and it
      // stays silent when the question has no blocker to name (an open attempt the
      // W6 close-out path is already nudging, or no eligible member at all).
      // Co-firing guard pairs: dispatch question x parked-member hatch, x W6
      // open-attempt close-out, x admission refusal — see
      // `Scheduling.dispatchQuestion`.
      // R15-D1: a wedged pass never reached its own dispatch question, so the
      // startable gate must not silence the subject: the question is asked even
      // when every eligible handle is busy, and the holder-naming answer is what
      // tells the owner which member is holding the task while the pass is dead.
      // For a completed pass the T3 rule stands: an all-busy board is working, not
      // silent, and owes no witness.
      if (options.wedged !== true) {
        const startable = runnable.some(member => member.status === 'waiting' || this.rt.workers.isIdle(member.id))
        if (!startable) return
      }
      const question = this.rt.dispatchQuestion(missionId, tasks, members, dispatchable)
      if (question === undefined) return
      this.rt.commit(missionId, () => {
        // The dedup key belongs to the task and its epoch, so the wedged path can
        // re-run every tick without repeating the same wake.
        this.notify(missionId, question.message, view.subjectsOf([question.task]), { dedupe: true, dedupKey: question.dedupKey })
      })
      return
    }
    const unreviewed = view.unreviewed
    if (unreviewed.length) {
      // A submitted artifact no live review can accept is an owner decision. The
      // documented `AUTO_REVIEW_GRACE_MS` floor is honored here, not only inside
      // `stalled`, because `stalled` returns before its unreviewed check when
      // any unrelated work is running; without this an unreviewable submission
      // could stay silent behind live work forever (verifier-1 challenge,
      // evidence_a454a771). The age comes from the durable submission event, so
      // a restart cannot reset the grace.
      const grace = Math.max(this.rt.config.tickMs, AUTO_REVIEW_GRACE_MS)
      const ripe = unreviewed.filter(task => {
        const submission = this.rt.latestSubmission(missionId, task.id)
        return submission === undefined || submission.age >= grace
      })
      if (ripe.length) {
        this.rt.commit(missionId, () => {
          this.notify(missionId, `Submitted artifact ${ripe.map(task => task.id).join(', ')} has no live independent review path and cannot reach a verdict while the rest of the board keeps running. Admit an independent verification task with swarm_propose (kind verification, reviewOf ${ripe[0]!.id}) or cancel the source task.`, view.subjectsOf(ripe), { family: 'review-blocked', trigger: 'task/review-blocked' })
        })
      }
      return
    }
    // Row 3 (documented scope): only a board whose *every* non-terminal task is
    // running under a live lease is exempt. Running work plus a pending or
    // blocked task falls through to the witnesses below, so a dependent that
    // cannot start yet still leaves the owner a decision (T1av2 evidence_978a4694).
    const nonTerminal = view.nonTerminal
    if (nonTerminal.length && nonTerminal.every(task => task.status === 'running' && task.attempt !== undefined && task.attempt.leaseUntil >= Date.now())) return
    if (view.stalled) {
      this.notifyStall(view, this.rt.completionError(mission) ?? 'no task can make progress')
      return
    }
    // R14-F2(c): the unnamed fallback is replaced. While every unfinished task is
    // legitimately waiting, the runtime stays silent; otherwise it escalates
    // UNCONDITIONALLY and names every task its classifier did not recognise, so
    // no state can be silent and unnamed at the same time.
    // A task the root classifier already named is recognised: the fall-through
    // names only what no other witness speaks for.
    const roots = new Set(view.stallRoots.map(task => task.id))
    const unrecognised = nonTerminal.filter(task => !roots.has(task.id) && !this.waitsLegitimately(task, tasks))
    if (!unrecognised.length) {
      // The stall-root notices above were emitted WITHOUT claiming the board witness,
      // so the W3 stall path (fault F19 row 7) still owns the board when it applies.
      // If the classifier recognises every task and no stall fires, those decision
      // notices are this board's evidence: stamp the W2 witness here instead (row 7b).
      if (stallRootNotices > 0) {
        this.rt.commit(missionId, () => {
          const board = this.rt.store.get('missions', missionId)
          if (board !== undefined && !this.rt.isMissionTerminal(board)) {
            board.witness = { fingerprint: this.rt.fingerprint(missionId), kind: 'W2', at: Date.now() }
            this.rt.store.put('missions', board)
          }
        })
      }
      return
    }
    const subjects = unrecognised.map(taskSubject)
    // R17-G3: the fact is the named subjects and the recorded reason (the
    // classifier's verdict), never the board digest.
    const reason = `no live path advances ${subjects.slice().sort().join(', ')}`
    this.rt.commit(missionId, () => {
      this.notify(missionId, NOTICE_TEMPLATES.fallthrough.build({ missionTitle: mission.title, subjects: unrecognised }), view.subjectsOf(unrecognised),
        { dedupe: true, family: 'fallthrough', trigger: NOTICE_TEMPLATES.fallthrough.trigger, reason })
    })
  }

  /**
   * R14-F2(b): exactly one named `decision` notice per stall root at its epoch,
   * whether or not other tasks in the mission are running. A stall root is a
   * blocked task that is not stopping, is not a verdict record, and has no live
   * replacement anywhere in its lineage; a blocked task whose waited-on stop has
   * exceeded the declared bound is a root too, because the stop it waits on is
   * no longer bounded. The dedup key is the root's own identity, not the board
   * fingerprint, so an unrelated notice can never consume it.
   */
  notifyStallRoots(view: MissionInterpretation): number {
    const mission = view.mission
    const tasks = view.tasks
    let emitted = 0
    for (const root of view.stallRoots) {
      const subject = taskSubject(root)
      const key = `stall-root:${mission.id}:${subject}`
      if (hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) continue
      const dependents = this.dependentsOf(root, tasks)
      const stop = root.resumeAfterStop?.epoch === root.epoch ? root.resumeAfterStop : undefined
      const cause = stop !== undefined
        ? (stop.at === undefined
          ? `its stop carries no recorded start, so the declared bound (${this.rt.stallPassTimeoutMs}ms) cannot be shown to hold`
          : `its stop has been awaited for ${Math.max(0, Date.now() - stop.at)}ms, past the declared bound (${this.rt.stallPassTimeoutMs}ms)`)
        : 'no live replacement exists anywhere in its lineage'
      const body = NOTICE_TEMPLATES['stall-root'].build({ rootId: root.id, title: root.title, epoch: root.epoch, cause,
        dependents: dependents.map(task => task.id), ...(root.output === undefined ? {} : { recordedReason: root.output }) })
      this.rt.commit(mission.id, () => {
        this.notify(mission.id, body, view.subjectsOf([root, ...dependents]), { dedupe: true, dedupKey: key, stampWitness: false, trigger: NOTICE_TEMPLATES['stall-root'].trigger, reason: cause })
        // The event exists only with the delivery row that carries the fact (its
        // own row or the wake-budget summary), in the same transaction: a notice
        // that was not written must not leave an event per tick behind it.
        if (!hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
        this.rt.store.event(mission.id, 'mission/stalled', 'runtime', {
          cause: 'stall-root', taskId: root.id, epoch: root.epoch, reason: root.output ?? null,
          dependents: dependents.map(task => task.id), boundMs: this.rt.stallPassTimeoutMs,
          // R14-F2v D1: the W3 stall event carries `unschedulable` and readers
          // (fault F19 row 7) take it from the LATEST mission/stalled event; a
          // stall-root event without it broke that reader. The root plus the
          // tasks that depend on it is the honest value.
          unschedulable: [root.id, ...dependents.map(task => task.id)],
        })
        emitted += 1
      })
    }
    return emitted
  }

  /**
   * R14-F2(b): the stall roots of one board, in board order. Purely a function
   * of durable rows, so the pass, the timer-driven notice path and a test all
   * classify the same board identically.
   */
  stallRoots(tasks: Task[]): Task[] {
    return stallRootsFor(this.rt, tasks)
  }

  /**
   * R14-F2(b): the tasks that depend on one root, transitively, still unfinished.
   *
   * R16-A: the edge set is the durable one the board really has — `dependencies`,
   * `replaces` AND `reviewOf`. A blocked source's notice now enumerates the
   * pending review that waits on it, so the review's subject is not left out of
   * the decision the source's repair owes. Co-fires with: the stall-root
   * classifier (which is what calls this) and the review-grace rule in
   * `waitsLegitimately` (a review whose source is terminal is dead and named;
   * while the source is live this enumeration is how its notice names the review).
   */
  dependentsOf(root: Task, tasks: Task[]): Task[] {
    const found = new Map<string, Task>()
    let grew = true
    while (grew) {
      grew = false
      for (const task of tasks) {
        if (task.id === root.id || TERMINAL_STATES.has(task.status) || found.has(task.id)) continue
        const dependsOnRoot = [root.id, ...found.keys()].some(id => task.dependencies.includes(id) || (task.replaces ?? []).includes(id) || task.reviewOf === id)
        if (dependsOnRoot) { found.set(task.id, task); grew = true }
      }
    }
    return [...found.values()]
  }

  /**
   * R14-F2(c): whether an unfinished task is waiting on something still alive —
   * a live lease, the bounded review grace, a stop inside its bound, a live
   * repair carrying its obligation, or an unfinished EFFECTIVE predecessor.
   * Anything else is unnamed silence and must escalate.
   *
   * R16-A: the predecessor edge is resolved through the dispatcher's own lineage
   * seam (`rt.unfinishedDependencies`), never the raw id, so a task whose
   * cancelled dependency has a live running repair is waiting, not dead. And a
   * task whose own obligation is carried by a live replacement is waiting too,
   * read from the same coverage `stallRoots` uses, so the fall-through can name a
   * subject only when its whole lineage is terminal.
   *
   * Co-firing guards, named: this classifier x the stall-root classifier (a
   * blocked predecessor is the ROOT's subject, named by the root notice with its
   * dependents, never re-named here) x the review grace (`reviewable` and the
   * review-admission terminal: a pending review follows its SOURCE identity, so a
   * cancelled source with a live repair still has no review path) x the off-pass
   * wedged-pass classification (D1/D2: the wedge changes who generates the
   * decision, never which boards are waiting).
   */
  waitsLegitimately(task: Task, tasks: Task[]): boolean {
    return waitsLegitimately(this.rt, task, tasks)
  }

  /** Wake the owner once per distinct stalled state; idle workers cannot resolve it themselves. */
  notifyStall(view: MissionInterpretation, reason: string): void {
    const mission = view.mission
    const leftover = view.unschedulable
    // The stall dedup key is the same owner-observable fingerprint as every
    // other witness, so a stall is fresh exactly when the board changed.
    const fingerprint = this.rt.fingerprint(mission.id)
    if (mission.stallNotice === fingerprint) return
    mission.stallNotice = fingerprint; mission.updatedAt = Date.now()
    const detail = leftover.map(task => `${task.id} (${task.kind}, ${task.status}${task.reviewOf ? `, reviews ${task.reviewOf}` : ''}${task.dependencies.length ? `, depends on ${task.dependencies.join('/')}` : ''})`).join('; ')
    this.rt.commit(mission.id, () => {
      this.rt.store.put('missions', mission)
      this.rt.store.event(mission.id, 'mission/stalled', 'runtime', { reason, fingerprint, unschedulable: leftover.map(task => task.id) })
      // R15-A1: the W3 stall notice names the tasks it is about (the unschedulable
      // leftovers, or every non-terminal task when the stall class is an empty
      // leftover list), with the mission root as the honest fallback. Guard pair:
      // W3 stall x stall-root classifier — a root the classifier named does not
      // stop the board-level notice, and this notice no longer depends on prose
      // to say which subject is stuck.
      const stuck = leftover.length ? leftover : view.nonTerminal
      this.notify(mission.id, NOTICE_TEMPLATES.stall.build({ reason, detail, subjects: view.subjectsOf(stuck) }), view.subjectsOf(stuck),
        { trigger: NOTICE_TEMPLATES.stall.trigger, reason })
      // W3: the stall notice is the no-silent-state witness for this state.
      mission.witness = { fingerprint, kind: 'W3', at: Date.now() }
      this.rt.store.put('missions', mission)
    })
  }

  /**
   * R10-14: the board is coverage-complete but the mission is still active
   * (owner-assembled plans do not auto-complete). Emit exactly one durable
   * owner-decision notice per distinct coverage-complete state so the owner
   * knows the deliverable is ready without the runtime taking the decision.
   */
  notifyCoverageComplete(mission: Mission): void {
    const view = this.interpretation(mission.id)
    const fingerprint = this.rt.fingerprint(mission.id)
    if (mission.coverageNotice === fingerprint) return
    mission.coverageNotice = fingerprint
    this.rt.commit(mission.id, () => {
      this.rt.store.put('missions', mission)
      // R15-A1: the deliverable's lineage is the subject (every accepted task),
      // never an anonymous mission-scoped sentence.
      this.notify(mission.id, NOTICE_TEMPLATES['coverage-complete'].build({ missionTitle: view.mission.title }), view.subjectsOf(view.tasks.filter(task => TERMINAL_STATES.has(task.status))),
        { trigger: NOTICE_TEMPLATES['coverage-complete'].trigger, reason: 'every acceptance criterion is independently covered' })
    })
  }

  /**
   * R10-15: a running attempt whose owner is parked cannot progress until it is
   * woken or re-pended. Record the parked holder durably and tell the owner once
   * per attempt, so the state is never silent while the lease is alive.
   */
  notifyParkedHolder(mission: Mission, task: Task): void {
    const view = this.interpretation(mission.id)
    const row = view.tasks.find(candidate => candidate.id === task.id) ?? task
    const key = `parked:${mission.id}:${row.id}:${row.epoch}`
    // S5: the durable notice ledger is the gate (its row is written in this call).
    if (hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    this.rt.commit(mission.id, () => {
      this.notify(mission.id, NOTICE_TEMPLATES.parked.build({ taskId: row.id, title: row.title }), view.subjectsOf([row]),
        { dedupe: true, dedupKey: key, trigger: NOTICE_TEMPLATES.parked.trigger, reason: 'the owning member is parked' })
    })
  }

  /**
   * R11-03: the completion rule must not first appear when the owner tries to
   * complete. When a second implementation branch is admitted while the plan has
   * no integration task, emit the same diagnostic `completionError` would.
   */
  warnIntegrationGap(mission: Mission, admitted: Task): void {
    if (admitted.kind !== 'implementation') return
    const view = this.interpretation(mission.id)
    const implementations = view.implementations
    if (implementations.length < 2 || view.tasks.some(task => task.kind === 'integration')) return
    const key = `integration-gap:${mission.id}:${implementations.length}`
    // S5: the durable notice ledger is the gate (its row is written in this call).
    if (hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    const diagnostic = 'Coding missions require an independently accepted integration artifact, or exactly one independently accepted implementation artifact when the plan has no integration task'
    this.rt.commit(mission.id, () => {
      this.notify(mission.id, NOTICE_TEMPLATES['integration-gap'].build({ diagnostic, implementations: view.implementations.map(task => task.id) }), view.subjectsOf(view.implementations),
        { dedupe: true, dedupKey: key, trigger: NOTICE_TEMPLATES['integration-gap'].trigger, reason: diagnostic })
    })
  }

  /** Wake the owner once per distinct blocker for one unreviewable submitted deliverable. */
  notifyReviewBlocked(mission: Mission, source: Task, reason: string): void {
    const view = this.interpretation(mission.id)
    const row = view.tasks.find(candidate => candidate.id === source.id) ?? source
    const key = `review-blocked:${mission.id}:${row.id}:${reason}`
    // S5: the durable notice ledger (class, key, sender) is the gate; its row is
    // written in this call, so neither a restart nor a repeat can re-emit it.
    if (hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    const diagnostic = formatDiagnostic(missingReviewDiagnostic(source.id, reason))
    this.rt.commit(mission.id, () => {
      this.rt.store.event(mission.id, 'task/review-blocked', 'runtime', { taskId: source.id, kind: source.kind, reason })
      this.notify(mission.id, NOTICE_TEMPLATES['review-blocked'].build({ diagnostic, sourceId: row.id }), view.subjectsOf([row]),
        { dedupe: true, dedupKey: key, trigger: NOTICE_TEMPLATES['review-blocked'].trigger, reason })
    })
  }

  topicDelivery(missionId: string, from: string, topic: string, content: string): void {
    for (const member of this.rt.store.list('members', missionId)) {
      if (member.id !== from && member.status !== 'stopped' && (member.subscriptions.includes(topic) || member.subscriptions.includes('*'))) {
        this.rt.store.put('deliveries', { id: id('msg'), missionId, from, to: member.id, topic, kind: 'finding', content, createdAt: Date.now() })
      }
    }
  }

  /** The same durable failure covers missing recipients, transport errors and retries. */
  private recordDeliveryFailure(missionId: string, delivery: Delivery, reason: string): void {
    const member = this.rt.store.get('members', delivery.to)
    this.rt.commit(missionId, () => {
      const current = this.rt.store.get('deliveries', delivery.id)
      if (current === undefined || current.deliveredAt !== undefined || current.deliveryFailure?.reason === reason) return
      current.deliveryFailure = { reason, at: Date.now() }
      this.rt.store.put('deliveries', current)
      this.rt.store.event(missionId, 'mission/stalled', 'runtime', { cause: delivery.to === 'owner' ? 'owner-delivery-failed' : 'worker-delivery-failed', deliveryId: delivery.id, to: delivery.to, reason })
      if (delivery.to !== 'owner') {
        // One local incident for a member/error, even when many messages
        // are queued. A recovered queue makes this notice obsolete; a new
        // failed delivery afterwards establishes a fresh incident.
        const anchor = this.rt.store.list('deliveries', missionId).filter(row => row.to === delivery.to
          && row.deliveredAt === undefined && row.deliveryFailure?.reason === reason)
          .sort((a, b) => a.deliveryFailure!.at - b.deliveryFailure!.at)[0]!
        this.notify(missionId, `Messages to ${member?.name ?? delivery.to} (${delivery.to}) are queued but cannot be delivered: ${reason}. Inspect that member's current task and stop/recovery state; repair or reassign its work to an available member. Increasing the task budget will not repair this transport failure.`,
          this.rt.noticeSubjectsFor(missionId, { memberId: delivery.to }), {
            noticeClass: 'blocker', trigger: 'worker-delivery-failed', reason,
            dedupKey: `worker-delivery-failed:${anchor.id}:${reasonDigest(reason)}`, deliveryFailureId: anchor.id,
          })
      }
    })
  }

  async flushOutbox(missionId: string): Promise<void> {
    if (this.rt.shuttingDown) return
    for (const queued of this.rt.store.list('deliveries', missionId)) {
      if (this.rt.shuttingDown) return
      // A preceding transport can yield to stop/pause, receipts or another pump.
      // Read both rows again before deciding whether this delivery may start.
      const mission = this.rt.mission(missionId)
      const delivery = this.rt.store.get('deliveries', queued.id)
      if (delivery === undefined || delivery.deliveredAt !== undefined) continue
      if (delivery.kind === 'assignment' && delivery.taskId) {
        const task = this.rt.task(missionId, delivery.taskId)
        if (task.attempt?.id !== delivery.attemptId || task.status !== 'running') {
          delivery.deliveredAt = Date.now(); this.rt.commit(missionId, () => this.rt.store.put('deliveries', delivery)); continue
        }
      }
      // OWNER QUIET: a delivery the owner's own lifecycle decision made moot is
      // not sent, and its row stays durable and undelivered rather than being
      // relabelled as a transport that never happened.
      if (delivery.to === 'owner' && !this.ownerDeliveryRelevant(mission, delivery)) continue
      if (delivery.to !== 'owner' && (mission.status !== 'active' || mission.budgetPause)) continue
      const member = delivery.to === 'owner'
        ? { id: 'owner', missionId, name: 'owner', role: 'owner', sessionId: mission.ownerSessionId, workspace: mission.workspace, status: 'idle' as const, subscriptions: [] }
        : this.rt.store.get('members', delivery.to)
      if (!member || member.status === 'stopped') {
        this.recordDeliveryFailure(missionId, delivery, !member
          ? `Recipient ${delivery.to} is missing from the durable member roster`
          : `Recipient ${delivery.to} is stopped`)
        this.recordOutboxStarvation(missionId, delivery)
        continue
      }
      // S2: one never-settling adapter `deliver` must not stop every other
      // notice. Each attempt is claimed per delivery and bounded; an attempt
      // that does not settle is abandoned, recorded durably on the mission row,
      // and retried by a later pump (adapter acceptance is idempotent).
      if (this.delivering.has(delivery.id)) continue
      if (delivery.to === 'owner' && delivery.notice !== undefined && delivery.notice.handoffAt === undefined) {
        delivery.content = this.ownerDeliveryContent(mission, delivery)
        delivery.notice.handoffAt = Date.now()
        this.rt.commit(missionId, () => this.rt.store.put('deliveries', delivery))
      }
      this.delivering.set(delivery.id, Date.now())
      // An adapter may accept the message before its acknowledgement times out.
      // Detach a summary at its first handoff: retries keep this ID's content
      // immutable, and later facts get a fresh ID even after the attempt gate
      // is released. Restart also starts a fresh in-memory summary window.
      const window = this.wakeWindows[missionId]
      if (window?.summaryId === delivery.id) delete window.summaryId
      let bound: ReturnType<typeof setTimeout> | undefined
      try {
        const settled = await Promise.race([
          this.rt.workers.deliver(member, delivery).then(() => true),
          new Promise<boolean>(resolve => { bound = setTimeout(() => resolve(false), this.rt.stallPassTimeoutMs) }),
        ])
        if (!settled) { this.recordOutboxStarvation(missionId, delivery); continue }
        // R17-G8: delivery is the transport fact. It is never relabelled as
        // consumption; the host's claimed signal records consumption separately
        // (`recordConsumption`), with the adapter delivery timestamp as intake.
        this.rt.commit(missionId, () => {
          const current = this.rt.store.get('deliveries', delivery.id)
          if (current !== undefined && current.deliveredAt === undefined) {
            current.deliveredAt = Date.now()
            this.rt.store.put('deliveries', current)
          }
          // Only acknowledge the failure this retry observed. New lifecycle,
          // budget, receipt and starvation decisions may have landed while the
          // adapter awaited persistence; none may be replaced by the old rows.
          const latest = this.rt.mission(missionId)
          const previous = mission.outboxStarved
          const starvation = latest.outboxStarved
          if (previous?.deliveryId === delivery.id && starvation?.deliveryId === delivery.id
            && starvation.attempts === previous.attempts && starvation.at === previous.at) {
            delete latest.outboxStarved
            this.rt.store.put('missions', latest)
          }
        })
      } catch (error) {
        // A host failure did not deliver this message. Keep its identity queued
        // and record a durable fault once per distinct error, including after reload.
        const reason = error instanceof Error ? error.message : String(error)
        this.recordDeliveryFailure(missionId, delivery, reason)
        this.recordOutboxStarvation(missionId, delivery)
      }
      finally { if (bound !== undefined) clearTimeout(bound); this.delivering.delete(delivery.id) }
    }
  }

  /**
   * S2: record durably that one delivery attempt was abandoned at its bound, so
   * the starvation is visible even though the hung adapter call never returns.
   */
  recordOutboxStarvation(missionId: string, delivery: Delivery): void {
    try {
      const mission = this.rt.store.get('missions', missionId)
      if (mission === undefined) return
      const attempts = (mission.outboxStarved?.deliveryId === delivery.id ? mission.outboxStarved.attempts : 0) + 1
      mission.outboxStarved = { deliveryId: delivery.id, attempts, at: Date.now() }
      this.rt.commit(missionId, () => this.rt.store.put('missions', mission))
    } catch { /* Recording a starvation must never break the pump. */ }
  }

  /**
   * S2: the outbox pump lives outside every mission queue. It is driven by the
   * tick timer and by state-changing calls, reads only durable rows (missions,
   * deliveries, tasks, members) and never takes `exclusive`; a pass wedged in an
   * adapter call, or a mission lock held for any other reason, therefore cannot
   * stop a durable owner notice from being delivered. `beginBudgetStop` already
   * used exactly this shape (defer + a queue-external flush); this generalizes
   * it instead of adding a second mechanism.
   *
   * The pump is not a global lock: each delivery attempt is claimed
   * individually, bounded by `stallPassTimeoutMs`, and abandoned (then retried
   * on a later pump) if the adapter call does not settle. One hung `deliver`
   * therefore cannot starve another notice — not even another notice of the same
   * mission — and the abandonment is recorded durably on the mission row.
   */
  pumpOutbox(): void {
    if (this.rt.shuttingDown || this.rt.closed) return
    // Bounded coalescing: concurrent requests join a pump that is inside its
    // declared bound, but a pump whose deliveries hang past the bound never
    // suppresses the next one — the flag ages out instead of starving the
    // outbox (the reviewer's D2).
    const now = Date.now()
    if (this.pumpingSince !== undefined && now - this.pumpingSince < this.rt.stallPassTimeoutMs) return
    this.pumpingSince = now
    this.rt.defer(async () => {
      try {
        for (const mission of this.rt.store.list('missions')) {
          if (this.rt.closed || this.rt.shuttingDown) return
          try { await this.flushOutbox(mission.id) }
          catch { /* Durable outbox retries; one mission must not stop the pump. */ }
        }
      } finally { this.pumpingSince = undefined }
    })
  }
}
