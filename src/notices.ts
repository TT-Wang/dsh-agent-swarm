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
import { decisionRefusals } from './invariant.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { Actor, DecisionCandidate, Delivery, Member, Mission, NoticeClass, Task, WorkerAdapter } from './types.ts'

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
   * (`noticeFamily`, the wake-precision projection, owner-side filters) read the
   * family from the key prefix, so a fact-keyed notice keeps it.
   */
  family?: string
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
  /** R17-G3: the notice family the dedup key is prefixed with. */
  family?: string
  /** R17-G8: the host's claimed signal, recorded once (CAS) per delivery. */
  consumedAt?: number
  consumptionSource?: string
  /** R17-G4: the facts a degraded wake-budget summary carries. */
  facts?: string[]
}
export type NoticeRow = NonNullable<Delivery['notice']> & Partial<NoticeFactRecord>
/** The fact view of one delivery row, or undefined when it is not a notice. */
export const noticeRow = (delivery: Pick<Delivery, 'notice'>): NoticeRow | undefined => delivery.notice === undefined ? undefined : delivery.notice as NoticeRow

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
 *   readers (`noticeFamily`, the wake-precision projection) resolve, so two facts
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
/**
 * R17-G5: the declared absence bound the sampling net reports against. It is the
 * same order as the runtime's attempt-silence bound: a mission that recorded
 * nothing durable for this long is reported as an absence, not as a cause.
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
      `Task ${input.rootId} (${input.title}, epoch ${input.epoch}) is a stall root: it is blocked and ${input.cause}${input.dependents.length ? `; ${input.dependents.length} task(s) depend on it (${input.dependents.join(', ')})` : ''}${input.recordedReason === undefined ? '' : `. Recorded reason: ${input.recordedReason}`}. Decide: admit a replacement with swarm_propose (name ${input.rootId} in replaces), repair the dependency, or withdraw it with swarm_cancel.`,
  },
  fallthrough: {
    trigger: 'mission/stalled',
    build: (input: { missionTitle: string; subjects: ReadonlyArray<Pick<Task, 'id' | 'kind' | 'status' | 'epoch' | 'dependencies'>> }) =>
      `Mission ${input.missionTitle} made no progress this tick and has unfinished work that no live path will advance: ${input.subjects.map(task => `${task.id} (${task.kind}, ${task.status}, epoch ${task.epoch}${task.dependencies.length ? `, depends on ${task.dependencies.join('/')}` : ''})`).join('; ')}. Inspect the board, admit a repair or review with swarm_propose, or decide with swarm_control.`,
  },
  stall: {
    trigger: 'mission/stalled',
    build: (input: { reason: string; detail: string; subjects: readonly string[] }) =>
      `Mission stalled: no task can be scheduled and workers are idle. ${input.reason}. Unschedulable: ${input.detail || 'none'}. Subjects: ${input.subjects.join(', ')}. Decide: propose repairs or reviews with swarm_propose, adjust the budget, or use swarm_control complete (cancels unschedulable leftovers once every acceptance criterion is independently covered) or stop.`,
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
  /** The newest durable row time for this mission (the absence net's clock origin). */
  lastTransitionAt: number
  subjectsOf: (tasks: readonly Pick<Task, 'id' | 'epoch'>[]) => string[]
}
/** The states that leave a task no future. */
const TERMINAL_STATES = new Set(['accepted', 'cancelled'])

/**
 * R16-A: the durable families of owner decisions. A family is read from the
 * dedup key the runtime itself writes (never from prose), because that key is the
 * identity the notice ledger and the dedup logic already use.
 */
const DECISION_FAMILIES = ['stall-root', 'fallthrough', 'dispatch-question', 'guard-terminal', 'integration-gap', 'parked', 'review-blocked'] as const
/**
 * The families whose claim is "no live path will advance this subject". Only
 * these can be false wakes when the named subject's lineage is live. A
 * `dispatch-question` or `guard-terminal` names a subject for a different claim
 * and is deliberately not judged by the wake-precision predicate.
 */
const NO_LIVE_PATH_FAMILIES = new Set(['stall-root', 'fallthrough'])

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
 * R16-A: the durable wake-precision projection. Counts owner decisions by family,
 * false wakes and missed obligations from the store alone.
 */
export interface WakePrecision {
  missionId: string
  decisions: { total: number; byFamily: Record<string, number> }
  falseWakes: { total: number; byFamily: Record<string, number>; subjects: string[] }
  missedObligations: { total: number; subjects: string[] }
  note: string
}

/**
 * F2: how long a submitted code deliverable may stay without a live review
 * before the runtime concludes none is coming. One scheduler period gives the
 * author the turn in which it submitted to propose its own review; the floor
 * keeps a fast tick from turning a same-turn proposal into a race.
 */
export const AUTO_REVIEW_GRACE_MS = 1000

/**
 * R17-G9: the runtime slice the lineage rules read, so the classifiers, the
 * wake-precision projection, the emission-time refusal and the host pre-append
 * invariant all consume ONE implementation (`SwarmRuntime` satisfies it
 * structurally; a test can supply the same shape).
 */
export interface LineageRuntime {
  readonly store: { list: (table: 'tasks', missionId: string) => Task[] }
  readonly config: { tickMs: number }
  readonly stallPassTimeoutMs: number
  latestSubmission(missionId: string, taskId: string): { seq: number; age: number } | undefined
  unfinishedDependencies(missionId: string, task: Task, tasks?: Task[]): Task[]
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
 * durable rows, so the pass, the timer-driven notice path, the invariant and a
 * test all classify the same board identically.
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
 * unfinished dependency/predecessor edge. One implementation for the classifiers,
 * the wake-precision projection and the R17-G9 refusal predicate.
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
    // R15-F1: a verification task carries no `dependencies` by protocol; its
    // prerequisite is the source it reviews. While that source exists and is not
    // terminal the review is legitimately waiting. A source that is terminal or
    // missing can never make the review dispatchable again, so that state is NOT
    // waiting and stays in the fall-through's named escalation.
    if (task.reviewOf !== undefined) {
      const source = tasks.find(candidate => candidate.id === task.reviewOf)
      return source !== undefined && !TERMINAL_STATES.has(source.status)
    }
    return rt.unfinishedDependencies(task.missionId, task, tasks).length > 0
  }
  return false
}

/**
 * R17-G9: the emission-time counterpart of the wake-precision classifier — the
 * exact false-wake condition `Notices.wakePrecision` counts after the fact,
 * judged before the write. A candidate decision in a family whose claim is "no
 * live path will advance this subject" is illegal while any subject it names
 * still resolves (at its current epoch) to a task with a live path: a `stall-root`
 * naming a still-blocked task that is not a root, or a `fallthrough` naming a
 * subject `waitsLegitimately` still recognises.
 *
 * @returns the reason naming the offending subject, or `undefined` when the
 * candidate may be written. Families that claim something else are never judged.
 *
 * Co-firing guards, named: the fall-through classifier and the stall-root
 * classifier (which produce the legal candidates this predicate must admit) x the
 * fact-keyed dedup (a refusal consumes no key) x the per-owner wake budget (a
 * refused candidate never becomes a delivery, so it charges no budget) x the
 * transition-driven publication (refusal happens before the witness stamp) x the
 * close-out nudge (whose `task/closeout-*` families carry no such claim).
 */
export function liveLineageSubject(rt: LineageRuntime, candidate: DecisionCandidate): string | undefined {
  const family = candidate.family
  if (family === undefined || !NO_LIVE_PATH_FAMILIES.has(family)) return undefined
  const tasks = rt.store.list('tasks', candidate.missionId)
  const roots = new Set(stallRootsFor(rt, tasks).map(task => taskSubject(task)))
  for (const subject of candidate.subjects) {
    const task = taskFromSubject(subject, tasks)
    if (task === undefined) continue
    const live = family === 'stall-root'
      ? task.status === 'blocked' && !roots.has(subject)
      : waitsLegitimately(rt, task, tasks)
    if (live) return `${family} names ${subject}, whose lineage still has a live path`
  }
  return undefined
}

const id = (prefix: string) => `${prefix}_${randomUUID()}`

export class Notices {
  /** R10-15 parked-holder signals already emitted, keyed by mission:task:epoch. */
  readonly parkedNotices = new Set<string>()
  /** R11-03 integration-gap diagnostics already emitted, keyed by mission:implementation count. */
  readonly integrationGapWarned = new Set<string>()
  readonly reviewPathNotices = new Set<string>()
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
    // R17-G9: refusal is judged BEFORE anything durable is written. A decision
    // whose family claims "no live path will advance this subject" while a named
    // subject's lineage is still live is the false wake the wake-precision
    // projection would count after the fact; it is refused here instead of being
    // written (no delivery row, no witness stamp, no dedup key consumed), and the
    // refusal is recorded as a measurement rather than swallowed. Co-firing
    // guards: the fall-through/stall-root classifiers (whose legal candidates pass),
    // the fact-keyed dedup, the per-owner wake budget, the transition-driven
    // publication and the close-out nudge — see `liveLineageSubject`.
    const refusal = liveLineageSubject(this.rt, { missionId, ...(family === undefined ? {} : { family }), subjects: attributed })
    if (refusal !== undefined) {
      decisionRefusals.record({ at: Date.now(), missionId, family: family ?? 'unknown', subjects: [...attributed], reason: refusal, stage: 'emission' })
      return
    }
    const fact: NoticeFactRecord = { subjects: attributed, trigger: options.trigger ?? options.dedupKey?.split(':')[0] ?? noticeClass, reason: options.reason ?? '', ...(family === undefined ? {} : { family }) }
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
      this.appendToWakeSummary(missionId, summary, `[${fact?.trigger ?? noticeClass}] ${content}`, at)
      return undefined
    }
    const { fact: _fact, ...deliveryExtra } = extra
    const delivery: Delivery = {
      id: id('msg'), missionId, from, to: 'owner', kind: noticeClass === 'escalation' ? 'escalation' : 'control',
      content, createdAt: at,
      notice: { dedupKey, class: noticeClass, sentAt: at, queuedAt: at, ...(fact === undefined ? {} : { subjects: fact.subjects, trigger: fact.trigger, reason: fact.reason }) } as NonNullable<Delivery['notice']>,
      ...deliveryExtra,
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
   * dropped, it is only ever reported in degraded form.
   */
  private appendToWakeSummary(missionId: string, window: { startedAt: number; count: number; summaryId?: string }, line: string, at: number): void {
    const existing = window.summaryId === undefined ? undefined : this.rt.store.get('deliveries', window.summaryId)
    if (existing !== undefined && existing.deliveredAt === undefined && existing.notice !== undefined) {
      const row = noticeRow(existing)!
      const facts = [...(row.facts ?? []), line]
      row.facts = facts
      existing.content = `${WAKE_SUMMARY_HEADER}\n${facts.map(fact => `- ${fact}`).join('\n')}`
      this.rt.store.put('deliveries', existing)
      return
    }
    const summary: Delivery = {
      id: id('msg'), missionId, from: 'runtime', to: 'owner', kind: 'control',
      content: `${WAKE_SUMMARY_HEADER}\n- ${line}`, createdAt: at,
      notice: { dedupKey: `wake-budget:${missionId}:${window.startedAt}`, class: 'decision', sentAt: at, queuedAt: at, facts: [line], trigger: 'wake-budget', reason: 'per-owner wake budget exceeded' } as NonNullable<Delivery['notice']>,
    }
    window.summaryId = summary.id
    this.rt.store.put('deliveries', summary)
  }

  /**
   * R17-G8: subscribe to the host's claimed signal (`agent/inbox/claimed`) and
   * map the relay message's `source.deliveryId` to the durable delivery row. The
   * adapter composes the relay source (`harness-workers.ts`), and the host fires
   * the event when the owner's inbox item is claimed, so consumption is recorded
   * from the host's own signal rather than inferred from transport. A host
   * without the event or without a context simply records nothing there, while
   * `recordConsumption` stays the one write path.
   */
  attach(workers: WorkerAdapter): void {
    if (this.unsubscribeClaimed !== undefined) return
    const ctx = hostContextOf(workers) as { on?: (name: string, handler: (payload: unknown) => void) => () => void } | undefined
    if (ctx === undefined || typeof ctx.on !== 'function') return
    try {
      this.unsubscribeClaimed = ctx.on('agent/inbox/claimed', (payload: unknown) => {
        const source = (payload as { message?: { source?: { kind?: unknown; deliveryId?: unknown } } } | undefined)?.message?.source
        if (source === undefined || source.kind !== 'swarm' || typeof source.deliveryId !== 'string') return
        this.recordConsumption(source.deliveryId, { source: 'agent/inbox/claimed' })
      })
    } catch { this.unsubscribeClaimed = undefined }
  }

  /** R17-G8: release the host claimed-signal subscription. Idempotent. */
  dispose(): void {
    try { this.unsubscribeClaimed?.() } catch { /* the host fiber may already be gone */ }
    this.unsubscribeClaimed = undefined
  }

  /**
   * R17-G8: record real consumption from the host's claimed signal. The write is
   * a compare-and-swap inside the mission transaction: a delivery is consumed
   * once, and a second signal (a replay, a second pump) cannot move the
   * timestamp. Delivered, consumed and resolved stay three separate facts.
   */
  recordConsumption(deliveryId: string, options: { at?: number; source?: string } = {}): boolean {
    const delivery = this.rt.store.get('deliveries', deliveryId)
    if (delivery === undefined || delivery.notice === undefined) return false
    const at = options.at ?? Date.now()
    const source = options.source ?? 'agent/inbox/claimed'
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
   * R16-A: the single owner gate for the read-only owner instruments. The notice
   * ledger and the wake-precision projection ask the same question, so the second
   * instrument reuses this one refusal site instead of adding another: the
   * retained S3 inventory counts uncoded throw sites and may only shrink, and the
   * ledger's observable message is preserved verbatim through `instrument`.
   */
  private requireOwner(actor: Actor, missionId: string, instrument: string): void {
    const { owner } = this.rt.participant(actor, missionId)
    if (!owner) throw new Error(`Only the mission owner can read the ${instrument}`)
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
    if (text.length > this.rt.config.maxMessageChars) throw new Error(`Content exceeds ${this.rt.config.maxMessageChars} characters`)
    return text
  }

  /**
   * R16-A precision instrument: the wake precision of one mission's owner
   * decisions, projected from durable rows only (deliveries, tasks and the
   * submission events), never from a cache or from notice prose. It answers three
   * questions the round's outcome report needs as numbers:
   *
   * - decisions by family: how many owner notices of each durable family the
   *   mission produced (the family is the dedup key the runtime itself wrote);
   * - false wakes: a decision of a family that claims "no live path will advance
   *   this subject" (fall-through, stall-root) naming a subject whose lineage
   *   still has a live path on the durable board. `waitsLegitimately` is the
   *   classifier; for a stall root the question is whether the same row is still
   *   a root now (`stallRoots`), because a blocked root may legitimately wait on
   *   a live predecessor while still owing a repair decision;
   * - missed obligations: a non-terminal task with no live path that no owner
   *   decision names at its current epoch.
   *
   * Boundary (stated, not hidden): the judgement is made against the durable rows
   * at READ time. A decision whose subject has since advanced to another epoch is
   * not judged — its epoch is gone from the board — so historical false wakes are
   * not reconstructed here; the projection measures whether the decisions still
   * standing on the board are true now. Read-only: it changes no task, member,
   * budget or delivery state.
   */
  wakePrecision(actor: Actor, missionId: string): WakePrecision {
    this.requireOwner(actor, missionId, 'wake-precision projection')
    const tasks = this.rt.store.list('tasks', missionId)
    const deliveries = this.rt.store.list('deliveries', missionId).filter(delivery => delivery.to === 'owner')
    const roots = new Set(this.stallRoots(tasks).map(task => taskSubject(task)))
    const byFamily: Record<string, number> = {}
    const falseByFamily: Record<string, number> = {}
    const falseSubjects: string[] = []
    const named = new Set<string>()
    for (const delivery of deliveries) {
      const family = noticeFamily(delivery)
      byFamily[family] = (byFamily[family] ?? 0) + 1
      for (const subject of delivery.subjects ?? []) named.add(subject)
      if (!NO_LIVE_PATH_FAMILIES.has(family)) continue
      for (const subject of delivery.subjects ?? []) {
        const task = taskFromSubject(subject, tasks)
        if (task === undefined) continue
        const falseWake = family === 'stall-root'
          ? task.status === 'blocked' && !roots.has(subject)
          : this.waitsLegitimately(task, tasks)
        if (!falseWake) continue
        falseByFamily[family] = (falseByFamily[family] ?? 0) + 1
        falseSubjects.push(subject)
      }
    }
    const missed: string[] = []
    for (const task of tasks) {
      if (TERMINAL_STATES.has(task.status)) continue
      if (this.waitsLegitimately(task, tasks)) continue
      const subject = taskSubject(task)
      if (named.has(subject)) continue
      missed.push(subject)
    }
    const uniqueFalseSubjects = [...new Set(falseSubjects)]
    return {
      missionId,
      decisions: { total: deliveries.length, byFamily },
      falseWakes: { total: uniqueFalseSubjects.length, byFamily: falseByFamily, subjects: uniqueFalseSubjects },
      missedObligations: { total: missed.length, subjects: missed },
      note: 'Read-only projection over the durable rows at read time. `byFamily` comes from the notice dedup keys the runtime wrote. A false wake is a fall-through naming a subject `waitsLegitimately` still recognises, or a stall-root whose row is still blocked at that epoch and is no longer in `stallRoots`. A missed obligation is a non-terminal task with no live path that no owner decision names at its current epoch. A decision whose subject has advanced epochs is not judged against the current board.',
    }
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
    if (mission.status !== 'active') return
    const lastAt = view.lastTransitionAt
    const elapsed = Math.max(0, Date.now() - lastAt)
    const bound = options.boundMs ?? this.absenceBoundMs
    if (elapsed < bound) return
    const key = `absence:${missionId}:${lastAt}`
    if (hasNotice(this.rt.store.list('deliveries', missionId), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    const subject = missionSubject(mission)
    this.rt.commit(missionId, () => {
      this.notify(missionId, `No durable transition recorded for ${elapsed}ms (declared bound ${bound}ms) on an active mission. The absence net reports the absence and the elapsed clock only; read the board for the state.`, [missionSubject(view.mission)], {
        dedupe: true, dedupKey: key, trigger: 'absence-net', reason: `no durable row for ${elapsed}ms`,
      })
    })
  }

  /** The newest durable row time for one mission: the absence clock's origin. */
  private lastTransitionAt(missionId: string): number {
    const newest = this.rt.store.events(missionId, 1).at(-1)?.createdAt ?? 0
    const mission = this.rt.store.get('missions', missionId)
    return Math.max(newest, mission?.updatedAt ?? 0)
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
    const dispatchable = view.dispatchable
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
        const subjects = view.subjectsOf(ripe)
        this.rt.commit(missionId, () => {
          this.notify(missionId, `Submitted artifact ${ripe.map(task => task.id).join(', ')} has no live independent review path and cannot reach a verdict while the rest of the board keeps running. Admit an independent verification task with swarm_propose (kind verification, reviewOf ${ripe[0]!.id}) or cancel the source task.`, view.subjectsOf(ripe))
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
      this.notifyStall(view, this.rt.completionError(mission, { cancelUnschedulable: true }) ?? this.rt.completionError(mission) ?? 'no task can make progress')
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
        this.notify(mission.id, body, view.subjectsOf([root, ...dependents]), { dedupe: true, dedupKey: key, stampWitness: false, trigger: NOTICE_TEMPLATES['stall-root'].trigger, reason: cause })
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
    const tasks = view.tasks
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
      const stuckSubjects = view.subjectsOf(stuck)
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
    // S5: the durable notice ledger is the gate; the set is only a cache.
    if (this.parkedNotices.has(key) && hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    this.parkedNotices.add(key)
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
    // S5: the durable notice ledger is the gate; the set is only a cache.
    if (this.integrationGapWarned.has(key) && hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    this.integrationGapWarned.add(key)
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
    // S5: the durable notice ledger (class, key, sender) is the gate; the set is
    // only a cache, so losing it cannot produce a second notice for the state.
    if (this.reviewPathNotices.has(key) && hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    const diagnostic = formatDiagnostic(missingReviewDiagnostic(source.id, reason))
    this.rt.commit(mission.id, () => {
      this.rt.store.event(mission.id, 'task/review-blocked', 'runtime', { taskId: source.id, kind: source.kind, reason })
      this.notify(mission.id, NOTICE_TEMPLATES['review-blocked'].build({ diagnostic, sourceId: row.id }), view.subjectsOf([row]),
        { dedupe: true, dedupKey: key, trigger: NOTICE_TEMPLATES['review-blocked'].trigger, reason })
    })
    this.reviewPathNotices.add(key)
  }

  topicDelivery(missionId: string, from: string, topic: string, content: string): void {
    for (const member of this.rt.store.list('members', missionId)) {
      if (member.id !== from && member.status !== 'stopped' && (member.subscriptions.includes(topic) || member.subscriptions.includes('*'))) {
        this.rt.store.put('deliveries', { id: id('msg'), missionId, from, to: member.id, topic, kind: 'finding', content, createdAt: Date.now() })
      }
    }
  }

  async flushOutbox(missionId: string): Promise<void> {
    if (this.rt.shuttingDown) return
    const mission = this.rt.mission(missionId)
    for (const delivery of this.rt.store.list('deliveries', missionId)) {
      if (this.rt.shuttingDown) return
      if (delivery.deliveredAt) continue
      if (delivery.kind === 'assignment' && delivery.taskId) {
        const task = this.rt.task(missionId, delivery.taskId)
        if (task.attempt?.id !== delivery.attemptId || task.status !== 'running') {
          delivery.deliveredAt = Date.now(); this.rt.commit(missionId, () => this.rt.store.put('deliveries', delivery)); continue
        }
      }
      if (delivery.to !== 'owner' && (mission.status !== 'active' || mission.budgetPause)) continue
      const member = delivery.to === 'owner'
        ? { id: 'owner', missionId, name: 'owner', role: 'owner', sessionId: mission.ownerSessionId, workspace: mission.workspace, status: 'idle' as const, subscriptions: [] }
        : this.rt.store.get('members', delivery.to)
      if (!member || member.status === 'stopped') continue
      // S2: one never-settling adapter `deliver` must not stop every other
      // notice. Each attempt is claimed per delivery and bounded; an attempt
      // that does not settle is abandoned, recorded durably on the mission row,
      // and retried by a later pump (adapter acceptance is idempotent).
      if (this.delivering.has(delivery.id)) continue
      this.delivering.set(delivery.id, Date.now())
      let bound: ReturnType<typeof setTimeout> | undefined
      try {
        const settled = await Promise.race([
          this.rt.workers.deliver(member, delivery).then(() => true),
          new Promise<boolean>(resolve => { bound = setTimeout(() => resolve(false), this.rt.stallPassTimeoutMs) }),
        ])
        if (!settled) { this.recordOutboxStarvation(missionId, delivery); continue }
        delivery.deliveredAt = Date.now()
        // R17-G8: delivery is the transport fact. It is never relabelled as
        // consumption; the host's claimed signal records consumption separately
        // (`recordConsumption`), with the adapter delivery timestamp as intake.
        this.rt.commit(missionId, () => {
          this.rt.store.put('deliveries', delivery)
          // A delivered notice clears the starvation record it followed.
          if (mission.outboxStarved !== undefined) { delete mission.outboxStarved; this.rt.store.put('missions', mission) }
        })
      } catch { /* Durable outbox retries absent sessions; acceptance is idempotent in the adapter. */ }
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
