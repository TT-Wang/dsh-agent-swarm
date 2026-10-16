/**
 * Notices and witnesses: the owner-notice ledger, the one record that the
 * owner was told (dedup by class, key and sender, each key naming its fact),
 * the bounded outbox that delivers it outside the mission queue, and the board
 * classifier whose families each tell their own fact. M1a seam 3/7.
 */
import { createHash } from 'node:crypto'
import { covered, hasNotice } from './arena.ts'
import { hostContextOf } from './projection.ts'
import { formatDiagnostic, missingReviewDiagnostic } from './admission.ts'
import { guardTerminal, guardTerminalKey, type GuardChainId, type GuardTerminal, type GuardTerminalContext, type RefusalRegistry } from './refusals.ts'
import { TERMINAL_STATES, holdsAttempt, missionSubject, stopPending, taskSubject, terminal } from './task-graph.ts'
import { WriterBusyError, id, type SwarmStore } from './store.ts'
import { awaited, type Kernel, type PassState, type SchedulingPass } from './kernel.ts'
import { completionError, dependentsOf, eligible, interpret, isolationIssues, newestReviewBlock, noticeSubjectsFor, overdueStop, reviewNeed, reviewPathBlocker, reviewPathStalled, stallRoots, startBlocker, unreviewedSources, waitsLegitimately, type Board, type Interpretation } from './board.ts'
import type { Delivery, Escalation, Member, Mission, NoticeClass, Task, WorkerAdapter } from './types.ts'

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
function noticeSubjects(subjects: readonly string[] | undefined, mission: Pick<Mission, 'id'>): string[] {
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
 * required positional argument, and the fact is named by its trigger or an
 * explicit key, so a new call site cannot inherit "no subject" or "no fact" by
 * omission.
 */
export type NotifyOptions = ({
  /**
   * R17-G3: the durable event that triggered this fact (for example
   * `task/blocked`, `dispatch-question`, `absence-net`). With `reason` it is the
   * fact identity the dedup key is built from, so an unrelated board change
   * cannot re-arm the notice and a new fact cannot be suppressed.
   */
  trigger: string
  dedupKey?: string
} | { trigger?: undefined; dedupKey: string }) & {
  from?: string
  noticeClass?: NoticeClass
  /** R17-G3: the recorded reason the fact's rows carry (never invented by the body). */
  reason?: string
  /** Full facts and their original identities when one notice presents a batch. */
  facts?: string[]
  aggregatedIdentities?: NonNullable<Delivery['notice']>['aggregatedIdentities']
  /** Exact receipt / failed transport behind this action, including wake summaries. */
  questionId?: string
  deliveryFailureId?: string
  /**
   * The delivery that already put this same obligation in front of the owner.
   * The fact is still written durably (row, dedup, event), but it is no wake of
   * its own: it takes no wake-budget slot, the outbox never sends it, it has no
   * reminders (the covering delivery's carry it) and the owner instruments do
   * not count it as a notice.
   */
  coveredBy?: string
  /** R17-G2: what a reviewed-template body states, written on the durable row with it. */
  statement?: NoticeStatement
}

/**
 * R17-G2: the facts a reviewed-template body states, as data on the durable
 * notice row, so a reader checks them against the rows instead of parsing the
 * sentence, and the wording can change without changing a recorded fact. The
 * body's subjects and cause already travel on the same row as the fact identity
 * (`subjects`, `reason`); the statement adds what the row did not carry: the
 * template family that rendered the body, which is also the family its dedup
 * key is prefixed with (`factKey`), and the counts the body states. A fact
 * carried by a wake-budget summary is recorded in its `aggregatedFacts`
 * constituent, which has no statement.
 */
interface NoticeStatement {
  family: keyof typeof NOTICE_TEMPLATES
  /** Named counts the body states (dependents, implementations, unschedulable); empty when it states none. */
  counts: Record<string, number>
}

/**
 * The trigger the verify site records a rejection decision under. A stall root
 * at the same subject@epoch restates that decision, so it is recorded against
 * it (`NotifyOptions.coveredBy`) rather than waking the owner a second time.
 */
export const REJECTION_DECISION_TRIGGER = 'task/rejected'

/**
 * R17-G3/G8: the durable fact fields a notice row carries. The declared
 * `Delivery` type predates them (and src/types.ts is outside this branch's
 * scope), so the fields travel on the same durable row as plain JSON and are
 * read through this view. `claimedAt` is deliberately absent: it was stamped
 * from `deliveredAt` and carried no information beyond the transport.
 */
interface NoticeFactRecord {
  subjects: string[]
  trigger: string
  reason: string
  questionId?: string
  deliveryFailureId?: string
  /** R17-G8: the host's claimed signal, recorded once (CAS) per delivery. */
  consumedAt?: number
  consumptionSource?: string
  /** Bounded reminders for an unresolved fact; transport/turn end never resolves it. */
  followupCount?: number
  followupAt?: number
  /** The delivery that carried this obligation to the owner (`NotifyOptions.coveredBy`). */
  coveredBy?: string
  /** R17-G4: the facts a degraded wake-budget summary carries. */
  facts?: string[]
  aggregatedIdentities?: NonNullable<Delivery['notice']>['aggregatedIdentities']
  /** R17-G2: what a reviewed-template body states (`NoticeStatement`). */
  statement?: NoticeStatement
  escalation?: Escalation
}
type NoticeRow = NonNullable<Delivery['notice']> & Partial<NoticeFactRecord>
/** The fact view of one delivery row, or undefined when it is not a notice. */
const noticeRow = (delivery: Pick<Delivery, 'notice'>): NoticeRow | undefined => delivery.notice === undefined ? undefined : delivery.notice as NoticeRow

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

/**
 * Whether an assignment delivery is still current: its task, read in the
 * delivery's own mission, still holds the delivered attempt (`holdsAttempt`),
 * owned by the delivery's recipient. A delivery that names no task or no
 * attempt, or a task id that names no task of that mission, is not current.
 * The one rule the outbox (which marks an assignment that is not current moot,
 * `flushOutbox`) and the host's admission of a queued assignment
 * (`admitDelivery`) both read.
 */
export function assignmentCurrent(store: Pick<SwarmStore, 'get'>, delivery: Pick<Delivery, 'missionId' | 'to' | 'taskId' | 'attemptId'>): boolean {
  const { taskId, attemptId } = delivery
  if (taskId === undefined || attemptId === undefined) return false
  const task = store.get('tasks', taskId)
  return holdsAttempt(task, delivery.missionId, attemptId) && task.attempt.ownerId === delivery.to
}

/** R17-G3: the stable digest of a recorded reason, so a fact key stays bounded. */
export function reasonDigest(reason: string): string {
  return reason.length === 0 ? 'none' : createHash('sha256').update(reason).digest('hex').slice(0, 16)
}
/** The local key of a stop fault's decision request: one per task, stop epoch, member and failure text. */
export const stopFaultKey = (taskId: string, marker: { epoch: number; memberId?: string }, message: string): string => `stop:${taskId}:${marker.epoch}:${marker.memberId ?? 'unresolved'}:${createHash('sha256').update(message).digest('hex')}`
/** The opener of the workspace terminal one isolation violation raises: the violation's own text. */
export function isolationOpener(message: string): string { return `isolation:${reasonDigest(message)}` }
/**
 * R17-G3: the fact key. Identity is `subject@epoch` (or the mission root when a
 * decision names no single task) plus the triggering event plus the recorded
 * reason — never a digest of the whole board, so an unrelated change cannot
 * re-arm a notice and a new fact is never suppressed by an old one.
 *
 * Two boundaries, stated here because they cannot be inferred from the call:
 * - The "triggering event" is the event TYPE (`NotifyOptions.trigger`). A
 *   second, distinct transition of the same type at the same subject@epoch with
 *   the same recorded reason is therefore the SAME fact and is suppressed — the
 *   round's "at most one notice per fact" rule. A changed reason, a changed
 *   subject epoch or a changed trigger is a new fact and is recorded.
 * - A body a reviewed template rendered is keyed by that template's family
 *   (`NoticeStatement.family`), and the trigger does NOT participate: one field
 *   names the family, so the key prefix, `noticeFamily`, `noticeTemplateKey` and
 *   the statement agree, and two facts of one family with different triggers
 *   but the same subjects and recorded reason share one key.
 */
export function factKey(missionId: string, fact: { trigger: string; reason: string; subjects: readonly string[]; statement?: Pick<NoticeStatement, 'family'> }): string {
  const subjects = [...fact.subjects].sort().join('+')
  return `${fact.statement?.family ?? fact.trigger}:${missionId}:${subjects}:${reasonDigest(fact.reason)}`
}

/**
 * R17-G3: the fact a notice records, durable on its row, and the identity it
 * is deduplicated under: an explicit key, else the fact (subject@epoch +
 * triggering event + recorded reason), so an unrelated board change cannot
 * re-arm a notice and a new fact cannot be suppressed by an old one. The one
 * derivation `Notices.tell` writes under and every reader of its row asks.
 */
export function noticeIdentity(missionId: string, subjects: string[], options: NotifyOptions): { fact: NoticeFactRecord; identity: { class: NoticeClass; dedupKey: string; from: string } } {
  const fact: NoticeFactRecord = { subjects: noticeSubjects(subjects, { id: missionId }), trigger: options.trigger ?? options.dedupKey.split(':')[0]!, reason: options.reason ?? '', questionId: options.questionId, deliveryFailureId: options.deliveryFailureId,
    ...(options.facts === undefined ? {} : { facts: options.facts }), ...(options.aggregatedIdentities === undefined ? {} : { aggregatedIdentities: options.aggregatedIdentities }),
    ...(options.coveredBy === undefined ? {} : { coveredBy: options.coveredBy }), ...(options.statement === undefined ? {} : { statement: options.statement }) }
  return { fact, identity: { class: options.noticeClass ?? 'decision', dedupKey: options.dedupKey ?? factKey(missionId, fact), from: options.from ?? 'runtime' } }
}

/**
 * R17-G4: the one per-owner wake budget. Every notice family shares it: the
 * first `wakeBudget` facts of a window are delivered individually, and every
 * further fact of the same window is carried by one degraded summary delivery
 * (never dropped). Values are public fields so a test can tighten the budget
 * without inventing a second code path.
 */
const DEFAULT_WAKE_BUDGET = 6
const DEFAULT_WAKE_WINDOW_MS = 5_000
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
const DEFAULT_ABSENCE_BOUND_MS = 600_000
/**
 * R17-G2: the reviewed notice template table. Every reviewed family's body is
 * built by one pure function from the durable rows it cites, and the generator
 * calls that function through `renderNotice` — so the machine replay check can
 * rebuild each emitted body from the store and fail a body that states a cause
 * no row supports. `counts` names the counts a body states, read from its input.
 * `trigger` is the durable event a family's facts record; their key is the
 * family itself (`factKey`).
 */
export const NOTICE_TEMPLATES = {
  'stall-root': {
    trigger: 'task/blocked',
    counts: (input: { dependents: readonly string[] }) => ({ dependents: input.dependents.length }),
    build: (input: { rootId: string; title: string; epoch: number; cause: string; dependents: readonly string[]; recordedReason?: string }) =>
      `Task ${input.rootId} (${input.title}, epoch ${input.epoch}) is a stall root: it is blocked and ${input.cause}${input.dependents.length ? `; ${input.dependents.length} task(s) depend on it (${input.dependents.join(', ')})` : ''}${input.recordedReason === undefined ? '' : `. Recorded reason: ${input.recordedReason}`}. Inspect the recorded cause: extend this task's allocation with swarm_budget, amend its unsubmitted policy, or resume it with swarm_control(action: "resume", taskId: "${input.rootId}") after environment repair, which reworks a rejected task in place. Only when resume cannot rework it, repair it with swarm_propose with replaces: ["${input.rootId}"]; the repair inherits its acceptance. Use swarm_cancel to withdraw mistaken work.`,
  },
  fallthrough: {
    trigger: 'mission/stalled',
    build: (input: { missionTitle: string; subjects: ReadonlyArray<Pick<Task, 'id' | 'kind' | 'status' | 'epoch' | 'dependencies'>> }) =>
      `Mission ${input.missionTitle} made no progress this tick and has unfinished work that no live path will advance: ${input.subjects.map(task => `${task.id} (${task.kind}, ${task.status}, epoch ${task.epoch}${task.dependencies.length ? `, depends on ${task.dependencies.join('/')}` : ''})`).join('; ')}. Inspect the board, admit a repair or review with swarm_propose, or decide with swarm_control.`,
  },
  'board-stall': {
    trigger: 'mission/stalled',
    counts: (input: { unschedulable: readonly unknown[] }) => ({ unschedulable: input.unschedulable.length }),
    build: (input: { reason: string; unschedulable: ReadonlyArray<Pick<Task, 'id' | 'kind' | 'status' | 'reviewOf' | 'dependencies'>>; subjects: readonly string[] }) =>
      `Mission stalled: no task can be scheduled and workers are idle. ${input.reason}. Unschedulable: ${input.unschedulable.map(task => `${task.id} (${task.kind}, ${task.status}${task.reviewOf ? `, reviews ${task.reviewOf}` : ''}${task.dependencies.length ? `, depends on ${task.dependencies.join('/')}` : ''})`).join('; ') || 'none'}. Subjects: ${input.subjects.join(', ')}. Decide: amend the existing task dependencies or assignee with swarm_control, admit a repair or review with swarm_propose, or adjust the budget. If work is no longer required, withdraw it explicitly with swarm_cancel; completing a mission never cancels unfinished tasks. Use swarm_control stop to stop the mission.`,
  },
  parked: {
    trigger: 'member/waiting',
    build: (input: { taskId: string; title: string }) =>
      `Task ${input.taskId} (${input.title}) is held by a parked member and cannot make progress while parked. A fresh assignment wakes it; if the lease expires the task re-pends without spending a recovery attempt.`,
  },
  'review-blocked': {
    trigger: 'task/review-blocked',
    build: (input: { sourceId: string; reason: string }) => formatDiagnostic(missingReviewDiagnostic(input.sourceId, input.reason)),
  },
  'integration-gap': {
    trigger: 'task/proposed',
    counts: (input: { implementations: readonly string[] }) => ({ implementations: input.implementations.length }),
    build: (input: { diagnostic: string; implementations: readonly string[] }) =>
      `${input.diagnostic}. The mission now has ${input.implementations.length} implementation branches (${input.implementations.join(', ')}); admit an integration task depending on every branch, or complete with exactly one accepted implementation artifact.`,
  },
  'duplicate-carrier': {
    trigger: 'task/duplicate-carrier',
    counts: (input: { duplicates: readonly unknown[] }) => ({ duplicates: input.duplicates.length }),
    build: (input: { acceptedId: string; duplicates: ReadonlyArray<Pick<Task, 'id' | 'title' | 'status'>> }) =>
      `Task ${input.acceptedId} was independently accepted and carries the obligation of every task it replaces, but ${input.duplicates.map(task => `${task.id} (${task.title}, ${task.status})`).join(', ')} in that lineage ${input.duplicates.length === 1 ? 'is' : 'are'} still live, so one obligation now has a duplicate carrier. Withdraw each duplicate with swarm_cancel(taskId, reason) unless its result is still needed; to keep both results, admit an integration task with swarm_propose that depends on both.`,
  },
  'coverage-complete': {
    trigger: 'task/accepted',
    build: (input: { missionTitle: string }) =>
      `Mission ${input.missionTitle} is ready to complete: every acceptance criterion is independently covered and no task can make further progress. The mission stays active until you decide. Use swarm_control complete to accept the deliverable, or admit more work with swarm_propose.`,
  },
} as const
/**
 * R17-G2: one reviewed body and the statement of what it states, from the one
 * input the body is rendered from: the family is the template that rendered it
 * and each count is read from that same input, so the recorded statement cannot
 * disagree with the body.
 */
export function renderNotice<F extends keyof typeof NOTICE_TEMPLATES>(family: F, input: Parameters<(typeof NOTICE_TEMPLATES)[F]['build']>[0]): { content: string; statement: NoticeStatement } {
  // TypeScript cannot correlate NOTICE_TEMPLATES[family] with its own input type across the union.
  const template = NOTICE_TEMPLATES[family] as unknown as { build: (input: unknown) => string; counts?: (input: unknown) => Record<string, number> }
  return { content: template.build(input), statement: { family, counts: template.counts?.(input) ?? {} } }
}
/** R17-G2: the template key of one emitted notice, or undefined when the family is not reviewed. */
export function noticeTemplateKey(delivery: Pick<Delivery, 'notice'>): keyof typeof NOTICE_TEMPLATES | undefined {
  const key = delivery.notice?.dedupKey ?? ''
  const prefix = key.includes(':') ? key.slice(0, key.indexOf(':')) : ''
  return prefix in NOTICE_TEMPLATES ? prefix as keyof typeof NOTICE_TEMPLATES : undefined
}

/**
 * R16-A: the durable families of owner decisions. A family is read from the
 * dedup key the runtime itself writes (never from prose), because that key is the
 * identity the notice ledger and the dedup logic already use. Every reviewed
 * template is one, so a templated body's family is its key prefix by
 * construction. The W3 board stall is `board-stall`, outside the `NoticeClass`
 * names: the operation- and attempt-silence escalations keep class `stall`, and
 * `noticeFamily` falls back to the class for them.
 */
const DECISION_FAMILIES: readonly string[] = [...Object.keys(NOTICE_TEMPLATES), 'scheduling-pass', 'dispatch-question', 'guard-terminal', 'obligation-followup', 'absence', 'owner-reply-missing', 'owner-reply-blocked']
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
  if (DECISION_FAMILIES.includes(prefix)) return prefix
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
/** The task a subject names while it is unfinished at that epoch: the term a subject-judged notice is deliverable and reminded by. */
const unfinished = (subject: string, tasks: readonly Task[]): Task | undefined => { const task = taskFromSubject(subject, tasks); return task === undefined || TERMINAL_STATES.has(task.status) ? undefined : task }

/**
 * R15-A4: the dispatcher's answer to "why did this ready task not dispatch?",
 * asked per (task, assignee) after a pass. `holder` is present only when the
 * blocker is a member handle that still holds an unfinished turn; the mission
 * admission refusal has no holder. Both carry the task's subject and a dedup key
 * that belongs to the task and epoch, so an unrelated notice can never consume
 * this decision.
 */
interface DispatchQuestion {
  task: Task
  holder?: Member
  message: string
  subjects: string[]
  dedupKey: string
}

/**
 * R15-A4: the dispatcher's own question, asked about the first dispatchable
 * task that did not dispatch and is not yet asked about at its epoch on the
 * ledger, so successive passes ask about each such task once, and the owner
 * notice names the real cause and the member whose handle holds the task
 * instead of claiming an admission refusal that was never recorded. It asks the
 * dispatcher's own predicates (`eligible`, `startBlocker`), so the owner is
 * never told a cause the sweep did not test.
 *
 * Returns undefined — no owner decision — when no such task remains: every
 * other one carries an open attempt (the close-out path is already nudging
 * it; W6 owns that state) or has no eligible member at all (nothing is ready
 * for a member; the board is someone else's witness, not this notice's).
 *
 * Otherwise the notice names a handle holder or an unexplained dispatch gap.
 * An idle handle alone proves no budget refusal.
 * - `handle-busy`: every member eligible for the task is working by the
 *   adapter's contract. The named holder is the task's assignee when the task
 *   is pinned, else the first eligible member whose handle is busy;
 */
export function dispatchQuestion(board: Board, dispatchable: Task[]): DispatchQuestion | undefined {
  const missionId = board.missionId
  const deliveries = board.records.list('deliveries', missionId)
  for (const task of dispatchable) {
    const subjects = [taskSubject(task)], dedupKey = `dispatch-question:${missionId}:${subjects[0]}`
    // An open attempt is not a dispatch candidate: the close-out path nudges it
    // (W6) or the lease path recovers it; a task asked about at its epoch, under
    // the identity `Notices.tell` writes, is the owner's: a second wake is noise.
    if (task.attempt !== undefined || hasNotice(deliveries, noticeIdentity(missionId, subjects, { dedupKey }).identity)) continue
    const candidates = board.members.filter(member => eligible(board, task, member))
    if (!candidates.length) continue
    if (candidates.some(member => startBlocker(board.view, member) === undefined)) return { task, subjects, dedupKey,
      message: `Task ${task.id} (${task.title}, epoch ${task.epoch}) has an eligible idle member but was not dispatched this tick. An idle handle alone does not identify the dispatch blocker. Inspect the task and recorded admission/preparation diagnostics with swarm_observe; repair the reported cause or withdraw the task with swarm_cancel.` }
    const pinned = task.assigneeId === undefined ? undefined : candidates.find(member => member.id === task.assigneeId)
    const holder = pinned ?? candidates[0]!
    return { task, holder, subjects, dedupKey,
      message: `Task ${task.id} (${task.title}, epoch ${task.epoch}) is ready for member ${holder.name} (${holder.id})${pinned === undefined ? ', one of its eligible members,' : ', the member it is assigned to,'} whose worker handle still holds an unfinished turn, so the dispatcher cannot start it: no admission limit and no budget refusal was recorded for this board. The task is not undispatched for lack of an eligible member. Wait for that turn to end (the close-out path re-pends or completes it), amend this task's assigneeId with swarm_control(taskId: "${task.id}", action: "amend", changes: { assigneeId: "member id" }, reason: "reassign"), or withdraw it with swarm_cancel.` }
  }
  return undefined
}
/** A review-blocked decision's identity: one per blocker reason of one review need (`reviewNeed`, src/board.ts) of a source. */
const reviewBlockedKey =(missionId: string, sourceId: string, need: string, reason: string): string => `review-blocked:${missionId}:${sourceId}:${need}:${reason}`
/** The families of the board's own fact: the W3 stall, or an owner-assembled mission's coverage-complete (R10-14). */
const BOARD_FAMILIES: readonly string[] = ['board-stall', 'coverage-complete']
/** An outbox pump in flight (`Notices.pumpOutbox`): when its current sweep started, and whether a request waits for its next sweep. */
interface Pump { sweepStartedAt: number; requested: boolean }

export class Notices {
  /**
   * Deliveries a pump is currently attempting (cache-only claim keyed per
   * delivery, so two pumps cannot duplicate one attempt and one hung call
   * cannot claim the whole outbox).
   */
  private readonly delivering = new Map<string, number>()
  /** Whether a pump start is deferred and has not run yet (`pumpOutbox`). */
  private pumpStartPending = false
  /** The current outbox pump: the newest one in flight, until a start supersedes it (`pumpOutbox`). */
  private pump?: Pump
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
   * R17-G5: missions whose scheduling pass was just named wedged. The naming is
   * the transition that owes the dispatch question the wedged pass never
   * reached, so its publication runs with the wedged branch even if the body
   * settles before that publication runs.
   */
  private readonly wedgedReleases = new Set<string>()

  /**
   * The notices stand on the kernel and the refusal registry below them:
   * `refusals` holds the writes a busy writer refused, and a guard terminal it
   * could not tell is queued there (`emitGuardTerminal`). `passState` is their
   * one reach above the kernel, the scheduling pass state a publication reads
   * when it runs (`publishTransition`).
   */
  constructor(private readonly k: Kernel, private readonly refusals: RefusalRegistry, private readonly passState: (missionId: string) => PassState) {}

  /**
   * Owner notices wake the primary agent and replay its whole context, so only
   * decisions, blockers, failures, budget exhaustion and final delivery use
   * them. Routine progress is already a durable event shown by the UI.
   *
   * Every notice is a row of the notice-delivery ledger, the one record that
   * the owner was told: deduplicated per (class, key, sender), with its
   * sent/queued/claimed lifecycle. Nothing else records the telling.
   *
   * R15-A1: the subjects are a required positional argument, refused when empty,
   * and written into the same durable delivery row as the content (never merged
   * in later). A call site that cannot name one task passes the mission root via
   * `missionSubject`; it can no longer pass nothing.
   *
   * Returns whether the fact was recorded for the owner (its own row or a
   * wake-budget summary constituent); false when the ledger already holds it.
   */
  notify(missionId: string, content: string, subjects: string[], options: NotifyOptions): boolean {
    const { fact, identity } = noticeIdentity(missionId, subjects, options)
    if (hasNotice(this.k.store.list('deliveries', missionId), identity)) return false
    this.enqueueOwnerNotice(missionId, content, identity, fact)
    return true
  }

  /** Tell the owner one fact in a transaction of its own: a fact the ledger already holds (its class, key and sender) commits nothing; otherwise one commit writes its row, then `then`, the record that exists only with that row. */
  tell(missionId: string, content: string, subjects: string[], options: NotifyOptions, then?: () => void): boolean {
    const { fact, identity } = noticeIdentity(missionId, subjects, options)
    return !hasNotice(this.k.store.list('deliveries', missionId), identity) && this.k.commit(missionId, () => { this.enqueueOwnerNotice(missionId, content, identity, fact); then?.(); return true })
  }

  /**
   * End a guard chain: tell the owner its terminal decision request
   * (`guardTerminal`) with the stall event that names its row. A caller names
   * the chain and passes the scope it already has with the fact that opened it
   * (`GuardTerminalContext.localKey`, or the unanswered question).
   *
   * The terminal is always built, and its request is told unless the same
   * request is already on the deliveries ledger. Nothing else suppresses it: a
   * failure of the chain under another opener is another request whatever the
   * board looks like, and a busy writer is recorded (`RefusalRegistry.queueWriterBusy`),
   * never silent. It names its caller's subjects, else the task it was asked
   * about, else the member's unfinished work, else the mission root
   * (`noticeSubjectsFor`).
   */
  emitGuardTerminal(missionId: string, chain: GuardChainId, context: GuardTerminalContext): GuardTerminal | undefined {
    const mission = this.k.store.get('missions', missionId)
    // S4r-D5: only a terminal mission (completed/stopped) ends the chain's duty to
    // speak. A mission that left `active` without reaching a terminal status —
    // most importantly `blocked` after a budget stop, which is when the owner needs
    // the executable exit most — still emits the terminal.
    if (mission === undefined || terminal(mission)) return undefined
    const request = guardTerminal(chain, context)
    const key = guardTerminalKey(chain, context)
    const subjects = context.subjects ?? noticeSubjectsFor(this.k.boardOf(missionId), { taskId: context.taskId, memberId: context.memberId })
    try {
      // The board-stall event type is reused with `cause: 'guard-terminal'`, so the
      // durable log names the chain and the code without inventing an unregistered
      // event type (the vocabulary is a separate owner surface). It exists only
      // with the row its `noticeKey` names. The notice path must not share the fate
      // of the pass that could not report it: the queue-external pump delivers it.
      if (this.tell(missionId, request.message, [...new Set(subjects)], { dedupKey: key, reason: context.detail, questionId: context.questionId }, () => this.k.store.event(missionId, 'mission/stalled', 'runtime', {
        cause: 'guard-terminal', chain, code: request.code, taskId: context.taskId ?? null, memberId: context.memberId ?? null, detail: context.detail ?? null, noticeKey: key,
      }))) this.pumpOutbox()
    } catch (error) {
      // The best-effort contract of a busy writer: an escalation it refused is
      // recorded once the writer is free (`RefusalRegistry.recordWriterBusyRecovery`),
      // never an unhandled rejection, and the chain re-derives its state on the next pass.
      if (!(error instanceof WriterBusyError)) throw error
      this.refusals.queueWriterBusy({ at: this.k.now(), attempts: error.attempts, missionId, chain, context, detail: error.message })
    }
    return request
  }

  /**
   * Record one owner-addressed fact durably under the identity its caller found
   * off the ledger (`noticeIdentity`; an escalation's own, never deduplicated).
   * Returns the delivery that carries the fact (over the wake budget, the
   * window's summary). Callers may already be inside a transaction; this method
   * never opens one.
   */
  enqueueOwnerNotice(missionId: string, content: string, identity: { class: NoticeClass; dedupKey: string; from: string }, fact: NoticeFactRecord): Delivery {
    const { class: noticeClass, dedupKey, from } = identity
    const at = this.k.now()
    // R17-G4: one per-owner budget bounds every family together. Over budget, the
    // fact is carried by the window's degraded summary instead of being dropped.
    // A covered fact is no wake, so it neither spends a slot nor joins a summary.
    const summary = fact.coveredBy === undefined ? this.wakeWindowFor(missionId, at) : undefined
    if (summary !== undefined && summary.count >= this.wakeBudget) {
      const facts = fact.facts ?? [`[${fact.trigger}] ${content}`]
      return this.appendToWakeSummary(missionId, summary, facts, [{
        class: noticeClass, dedupKey, from, contentDigest: createHash('sha256').update(content).digest('hex'),
      }, ...(fact.aggregatedIdentities ?? [])], at, {
        class: noticeClass, dedupKey, from, subjects: fact.subjects,
        trigger: fact.trigger, reason: fact.reason, createdAt: at, questionId: fact.questionId, deliveryFailureId: fact.deliveryFailureId, escalation: fact.escalation,
      })
    }
    const delivery: Delivery = {
      id: id('msg'), missionId, from, to: 'owner', kind: noticeClass === 'escalation' ? 'escalation' : 'control',
      content, createdAt: at,
      notice: { dedupKey, class: noticeClass, sentAt: at, queuedAt: at, subjects: fact.subjects, trigger: fact.trigger, reason: fact.reason, facts: fact.facts, aggregatedIdentities: fact.aggregatedIdentities, questionId: fact.questionId, deliveryFailureId: fact.deliveryFailureId,
        ...(fact.coveredBy === undefined ? {} : { coveredBy: fact.coveredBy }), ...(fact.statement === undefined ? {} : { statement: fact.statement }) } as NonNullable<Delivery['notice']>,
      escalation: fact.escalation, subjects: fact.subjects,
    }
    const limit = Math.min(MAX_OWNER_NOTICE_CHARS, this.k.config.maxMessageChars)
    if (content.length > limit) {
      const row = noticeRow(delivery)!
      row.facts ??= [content]
      row.aggregatedIdentities = [...(row.aggregatedIdentities ?? []), { class: noticeClass, dedupKey, from, contentDigest: createHash('sha256').update(content).digest('hex') }]
      delivery.content = renderNoticeFacts(`Owner ${noticeClass}: ${row.facts.length} recorded fact(s).`, row.facts, missionId, delivery.id, limit)
    }
    if (summary !== undefined) summary.count += 1
    this.k.store.put('deliveries', delivery)
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
  private appendToWakeSummary(missionId: string, window: { startedAt: number; count: number; summaryId?: string }, addedFacts: string[], identities: NonNullable<NoticeRow['aggregatedIdentities']>, at: number, constituent: Omit<NonNullable<NoticeRow['aggregatedFacts']>[number], 'factStart' | 'factCount'>): Delivery {
    const existing = window.summaryId === undefined ? undefined : this.k.store.get('deliveries', window.summaryId)
    if (existing !== undefined && existing.deliveredAt === undefined && existing.notice !== undefined) {
      const row = noticeRow(existing)!
      const factStart = row.facts?.length ?? 0
      const facts = [...(row.facts ?? []), ...addedFacts]
      row.facts = facts
      row.aggregatedIdentities = [...(row.aggregatedIdentities ?? []), ...identities]
      row.aggregatedFacts = [...(row.aggregatedFacts ?? []), { ...constituent, factStart, factCount: addedFacts.length }]
      existing.content = renderNoticeFacts(WAKE_SUMMARY_HEADER, facts, missionId, existing.id, Math.min(MAX_OWNER_NOTICE_CHARS, this.k.config.maxMessageChars))
      this.k.store.put('deliveries', existing)
      return existing
    }
    const summary: Delivery = {
      id: id('msg'), missionId, from: 'runtime', to: 'owner', kind: 'control',
      content: '', createdAt: at,
      notice: { dedupKey: `wake-budget:${missionId}:${window.startedAt}`, class: 'decision', sentAt: at, queuedAt: at, facts: addedFacts, aggregatedIdentities: identities, aggregatedFacts: [{ ...constituent, factStart: 0, factCount: addedFacts.length }], trigger: 'wake-budget', reason: 'per-owner wake budget exceeded' } as NonNullable<Delivery['notice']>,
    }
    summary.content = renderNoticeFacts(WAKE_SUMMARY_HEADER, addedFacts, missionId, summary.id, Math.min(MAX_OWNER_NOTICE_CHARS, this.k.config.maxMessageChars))
    window.summaryId = summary.id
    this.k.store.put('deliveries', summary)
    return summary
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
        const delivery = this.k.store.get('deliveries', source.deliveryId)
        if (delivery?.to !== 'owner' || this.k.store.get('missions', delivery.missionId)?.ownerSessionId !== String(session.header.id)) return
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
    const delivery = this.k.store.get('deliveries', deliveryId)
    if (delivery === undefined || delivery.notice === undefined) return false
    const at = options.at ?? this.k.now()
    const source = options.source ?? 'user/message'
    let recorded = false
    this.k.commit(delivery.missionId, () => {
      const fresh = this.k.store.get('deliveries', deliveryId)
      if (fresh === undefined || fresh.notice === undefined) return
      const row = noticeRow(fresh)!
      if (row.consumedAt !== undefined) return
      row.consumedAt = at
      row.consumptionSource = source
      this.k.store.put('deliveries', fresh)
      recorded = true
    })
    return recorded
  }

  /** R17-G1: the interpretation of one mission's board as the store holds it now (`interpret`), the one every notice generator and the dispatch sweep read. */
  interpretation(missionId: string): Interpretation { return interpret(this.k.boardOf(missionId)) }

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
    const elapsed = Math.max(0, this.k.now() - lastAt)
    const bound = options.boundMs ?? this.absenceBoundMs
    if (elapsed < bound) return
    // One long operation owns its existing activity bound. Starting another
    // short operation after progress is already overdue cannot hide that gap.
    if (view.members.some(member => member.activity !== undefined && member.activity.startedAt <= lastAt + bound)) return
    this.tell(missionId, `No durable task, evidence or owner-decision progress recorded for ${elapsed}ms (declared bound ${bound}ms) on an active mission. The absence net reports the absence and the elapsed clock only; read the board for the state.`, [missionSubject(view.mission)],
      { dedupKey: `absence:${missionId}:${lastAt}`, trigger: 'absence-net', reason: `no durable progress for ${elapsed}ms` })
  }

  /**
   * Revisit delivered decisions only while their original durable obligation
   * still stands. Each fact has its own reminder allowance: a wake-budget
   * summary reminds only the constituents that are unresolved and have
   * reminders left, and spends only theirs, so an unrelated constituent that
   * stays open cannot spend the reminders of one that is resolved for a while
   * and then reopens.
   */
  private followupObligations(view: Interpretation): void {
    const mission = view.mission
    if (!['active', 'blocked'].includes(mission.status)) return
    const now = this.k.now()
    for (const delivery of this.k.store.list('deliveries', mission.id)) {
      const fact = noticeRow(delivery)
      // Only a sent fact is reminded: a covered one never is, and its covering delivery's reminders carry its root.
      if (delivery.to !== 'owner' || delivery.deliveredAt === undefined || fact === undefined
        || ['progress', 'completion'].includes(fact.class)
        || FOLLOWUP_EXCLUDED_FAMILIES.has(noticeFamily(delivery))) continue
      const spent = fact.followupCount ?? 0
      if (now - (fact.followupAt ?? delivery.deliveredAt) < this.obligationFollowupMs) continue
      const parts = fact.aggregatedFacts?.filter(part => (part.followupCount ?? 0) < this.maxObligationFollowups
        && this.unresolvedSubjects(view, this.summaryFactDelivery(mission.id, delivery.id, part)).length > 0)
      if (parts === undefined ? spent >= this.maxObligationFollowups : parts.length === 0) continue
      const unresolved = parts === undefined ? this.unresolvedSubjects(view, delivery)
        : [...new Set(parts.flatMap(part => this.unresolvedSubjects(view, this.summaryFactDelivery(mission.id, delivery.id, part))))]
      if (unresolved.length === 0) continue
      const priorContent = parts === undefined ? delivery.content : parts.flatMap(part => this.summaryFactText(delivery, part)).join('\n')
      // A summary's reminder is counted per constituent it names.
      const ordinal = parts === undefined ? spent + 1 : Math.max(...parts.map(part => (part.followupCount ?? 0) + 1))
      const reminded = parts?.map(part => part.factStart) ?? []
      this.k.commit(mission.id, () => {
        const current = this.k.store.get('deliveries', delivery.id)
        const currentFact = current === undefined ? undefined : noticeRow(current)
        if (current === undefined || currentFact === undefined || (currentFact.followupCount ?? 0) !== spent) return
        currentFact.followupCount = spent + 1
        currentFact.followupAt = now
        for (const part of currentFact.aggregatedFacts ?? []) if (reminded.includes(part.factStart)) part.followupCount = (part.followupCount ?? 0) + 1
        this.k.store.put('deliveries', current)
        this.notify(mission.id, `Owner decision still unresolved (reminder ${ordinal} of ${this.maxObligationFollowups}, original delivery ${delivery.id}). Subjects: ${unresolved.join(', ')}. Prior notice: ${compactFact(priorContent, 600)}\nRead the original with swarm_observe({ missionId: "${mission.id}", deliveryId: "${delivery.id}" }) and apply the decision.${ordinal === this.maxObligationFollowups ? '\nReminder limit reached; the unresolved obligation remains on the board.' : ''}`, unresolved,
          { dedupKey: `obligation-followup:${delivery.id}:${spent + 1}`, trigger: 'owner-decision-unresolved', reason: delivery.id })
      })
    }
  }

  /** The current obligation, shared by reminder generation and queued reminders. */
  private unresolvedSubjects(view: Interpretation, delivery: Delivery): string[] {
    const mission = view.mission
    if (!['active', 'blocked'].includes(mission.status)) return []
    if (delivery.notice !== undefined && (['progress', 'completion'].includes(delivery.notice.class)
      || FOLLOWUP_EXCLUDED_FAMILIES.has(noticeFamily(delivery)))) return []
    if (delivery.notice?.aggregatedFacts !== undefined) {
      return [...new Set(delivery.notice.aggregatedFacts.flatMap(fact => this.unresolvedSubjects(view, this.summaryFactDelivery(mission.id, delivery.id, fact))))]
    }
    const terminal = this.openGuardTerminal(mission, delivery)
    if (terminal !== undefined) return terminal
    // A stall-root decision is outstanding exactly while its root still is one;
    // the dependents it lists (a rejecting review) never keep it open.
    const family = noticeFamily(delivery)
    if (family === 'stall-root') return this.openStallRoot(view, delivery)
    if (family === 'review-blocked') return this.openReviewBlock(view, delivery)
    if (BOARD_FAMILIES.includes(family) && !this.boardFactOpen(view, delivery)) return []
    // Coverage-complete names its terminal deliverable: the completion it asks for is what stays outstanding.
    if (family === 'coverage-complete') return delivery.subjects ?? []
    return (delivery.subjects ?? [missionSubject(mission)]).filter(subject => {
      if (subject === missionSubject(mission)) {
        if (delivery.notice?.class === 'budget') return (mission.budgetReviewedAt ?? 0) <= delivery.createdAt
        return mission.status === 'blocked' || mission.budgetPause !== undefined || view.stalled
          || (view.tasks.length > 0 && view.nonTerminal.length === 0)
      }
      const task = unfinished(subject, view.tasks)
      return task !== undefined && !waitsLegitimately(view, task)
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
    // A covered fact is never a wake of its own: the covering delivery carried
    // the obligation, and that delivery's reminders carry it too.
    if (covered(delivery)) return false
    if (delivery.replyExpected === true && delivery.answeredBy !== undefined) return false
    const terminal = this.openGuardTerminal(mission, delivery)
    if (terminal !== undefined) return mission.status !== 'completed' && terminal.length > 0
    const fact = noticeRow(delivery)
    // A receipt-linked action expires when that exact question is settled;
    // task or mission progress is neither necessary nor sufficient to settle it.
    const legacyQuestionKey = fact?.dedupKey.startsWith('owner-reply-missing:') ? fact.dedupKey.slice('owner-reply-missing:'.length, fact.dedupKey.lastIndexOf(':')) : undefined
    const questionId = fact?.questionId ?? legacyQuestionKey
    if (questionId !== undefined) {
      const question = this.k.store.get('deliveries', questionId)
      if (question?.missionId !== mission.id || question.to !== 'owner' || question.replyExpected !== true || question.answeredBy !== undefined) return false
    }
    if (fact?.deliveryFailureId !== undefined) {
      const failed = this.k.store.get('deliveries', fact.deliveryFailureId)
      if (failed?.missionId !== mission.id || failed.deliveryFailure === undefined) return false
      if (!this.k.store.list('deliveries', mission.id).some(row => row.to === failed.to && row.deliveredAt === undefined
        && row.deliveryFailure?.reason === failed.deliveryFailure!.reason && row.deliveryFailure.at >= failed.deliveryFailure!.at)) return false
    }
    if (fact?.trigger === 'mission/budget-warning' && !this.currentBudgetWarnings(mission, fact).some(Boolean)) return false
    if (fact === undefined || fact.class === 'completion' || fact.class === 'progress') return true
    if (fact.aggregatedFacts !== undefined) return this.relevantSummaryFacts(mission, delivery).length > 0
    const family = noticeFamily(delivery)
    if (mission.status === 'completed' && (['budget', 'stall', 'blocker'].includes(fact.class)
      || (DECISION_FAMILIES.includes(family) && !family.startsWith('owner-reply-')))) return false
    if (family === 'obligation-followup') {
      const original = fact.reason === undefined ? undefined : this.k.store.get('deliveries', fact.reason)
      return this.unresolvedSubjects(this.interpretation(mission.id), original ?? delivery).length > 0
    }
    if (BOARD_FAMILIES.includes(family)) return this.boardFactOpen(this.interpretation(mission.id), delivery)
    if (family === 'review-blocked' || family === 'fallthrough' || family === 'stall-root'
      || family === 'dispatch-question' || family === 'parked' || family === 'scheduling-pass') {
      const board = this.k.boardOf(mission.id), tasks = board.tasks
      const subjects = delivery.subjects ?? fact.subjects ?? []
      // Old unattributed rows cannot be judged from their text alone.
      if (subjects.length === 0) return true
      if (family === 'stall-root') return this.openStallRoot(board, delivery).length > 0
      if (family === 'review-blocked') return this.openReviewBlock(board, delivery).length === subjects.length
      // A wedged pass's naming holds for the work it named that is unfinished at that epoch: a body is named once (one on a held fact is left to this row), so no later fact speaks for the rest.
      if (family === 'scheduling-pass') return subjects.some(subject => subject === missionSubject(mission) || unfinished(subject, tasks) !== undefined)
      // A batch asserts the condition for every named subject. If one changes,
      // the transition publisher emits the remaining subjects as a fresh fact.
      return subjects.every(subject => {
        if (subject === missionSubject(mission)) return true
        const task = unfinished(subject, tasks)
        if (task === undefined) return false
        if (family === 'fallthrough') return !waitsLegitimately(board, task)
        if (family === 'dispatch-question') return task.status === 'pending'
        return this.interpretation(mission.id).parkedHolders.some(holder => holder.task.id === task.id)
      })
    }
    return true
  }

  /**
   * The one rule that judges a stall-root decision (its own row or a wake-budget
   * constituent), for delivery-time relevance and obligation follow-ups alike: it
   * asserts its claim of the root its key names, never of the dependents it lists.
   * Those are consequences, not roots; judging them as roots made every stall
   * root with a dependent undeliverable, and judging them as waits kept a
   * rejected root's reminders alive while its repair ran (the rejecting review is
   * a listed dependent). Returns the root subject while it is still a stall root.
   */
  private openStallRoot(board: Board, delivery: Pick<Delivery, 'subjects' | 'notice'>): string[] {
    const rootPrefix = `stall-root:${board.missionId}:`
    const key = delivery.notice?.dedupKey ?? ''
    const root = key.startsWith(rootPrefix) ? key.slice(rootPrefix.length) : (delivery.subjects ?? noticeRow(delivery)?.subjects)?.[0]
    const task = root === undefined ? undefined : taskFromSubject(root, board.tasks)
    return task !== undefined && stallRoots(board).some(candidate => candidate.id === task.id) ? [root!] : []
  }

  /** A review-blocked decision is outstanding while its source is one the review admission speaks for (`unreviewedSources`) and its reason is the blocker the admission derives for that source under the same review need (`reviewPathBlocker`, src/board.ts). */
  private openReviewBlock(board: Board, delivery: Delivery): string[] {
    return (delivery.subjects ?? []).filter(subject => {
      const task = taskFromSubject(subject, unreviewedSources(board))
      if (task === undefined) return false
      const need = reviewNeed(board, task)
      const blocker = reviewPathBlocker(board, task, need)
      return blocker !== undefined && delivery.notice?.dedupKey === reviewBlockedKey(board.missionId, task.id, need.id, blocker)
    })
  }

  /**
   * The board's one fact while its condition holds, with the body and the
   * identity it is told under. Completion refused: a stalled board's W3
   * stall, keyed by the completion diagnostic and its stuck work (the
   * unschedulable tasks, else every unfinished one), one set that its subjects,
   * body, count and event state. Completion allowed: coverage-complete of an
   * owner-assembled mission (no start request), keyed by its terminal work.
   */
  private boardFact(view: Interpretation): { key: string; subjects: string[]; reason: string; content: string; statement: NoticeStatement } | undefined {
    const fact = (body: { content: string; statement: NoticeStatement }, subjects: string[], reason: string) =>
      ({ ...body, subjects, reason, key: factKey(view.missionId, { trigger: NOTICE_TEMPLATES[body.statement.family].trigger, reason, subjects, statement: body.statement }) })
    const refusal = completionError(view)
    if (refusal === undefined) return this.k.store.list('starts', view.missionId).length > 0 ? undefined
      : fact(renderNotice('coverage-complete', { missionTitle: view.mission.title }), view.subjectsOf(view.tasks.filter(task => TERMINAL_STATES.has(task.status))), 'every acceptance criterion is independently covered')
    if (!view.stalled) return undefined
    const subjects = view.subjectsOf(view.unschedulable.length ? view.unschedulable : view.nonTerminal)
    return fact(renderNotice('board-stall', { reason: refusal, unschedulable: view.unschedulable, subjects }), subjects, refusal)
  }

  /** A W3 stall or coverage-complete decision is outstanding while it is the board's fact under the identity it was told with; a mission blocked on its budget keeps it, like every decision (`ownerDeliveryMoot`), and only an active one is told a new fact (`ensureWitness`). */
  private boardFactOpen(view: Interpretation, delivery: Pick<Delivery, 'notice'>): boolean {
    return this.boardFact(view)?.key === delivery.notice?.dedupKey
  }

  /**
   * The subjects a guard terminal still holds open, for the openers whose
   * condition has its own end; undefined while it is judged by the subjects it
   * names. An isolation violation is outstanding while the invariant still
   * lists it. A refused admission is a decision only while the limit it met is
   * the mission's current one: a raised limit answers it. A cancelled task can
   * still owe preservation; its exact stop fault ends when cleanup succeeds.
   */
  private openGuardTerminal(mission: Mission, delivery: Delivery): string[] | undefined {
    const key = delivery.notice?.dedupKey
    if (['task-budget:', 'experiment-budget:'].some(limit => key?.startsWith(guardTerminalKey('task_ceiling', { localKey: limit })))) {
      return [`task-budget:${mission.budget.maxTasks}`, `experiment-budget:${mission.budget.maxExperiments}`].some(localKey => key === guardTerminalKey('task_ceiling', { localKey })) ? undefined : []
    }
    if (key?.startsWith(guardTerminalKey('workspace', { localKey: 'isolation:' }))) {
      return isolationIssues(this.k.boardOf(mission.id)).some(issue => key === guardTerminalKey('workspace', { localKey: isolationOpener(issue.message) })) ? delivery.subjects ?? [] : []
    }
    if (!key?.startsWith(guardTerminalKey('attempt_lease', { localKey: 'stop:' }))) return undefined
    const tasks = this.k.store.list('tasks', mission.id)
    return (delivery.subjects ?? []).filter(subject => {
      const task = taskFromSubject(subject, tasks)
      if (task === undefined || !stopPending(task) || task.resumeAfterStop.failure === undefined) return false
      return key === guardTerminalKey('attempt_lease', { localKey: stopFaultKey(task.id, task.resumeAfterStop, task.resumeAfterStop.failure.message) })
    })
  }

  /** Re-render only structured batches, leaving their original ledger intact. */
  ownerDeliveryContent(mission: Mission, delivery: Delivery): string {
    const fact = noticeRow(delivery)
    if (fact?.aggregatedFacts !== undefined) {
      const facts = this.relevantSummaryFacts(mission, delivery).flatMap(part => this.summaryFactText(delivery, part))
      return renderNoticeFacts('Current owner facts; superseded actions remain in the durable record.', facts, mission.id, delivery.id, Math.min(MAX_OWNER_NOTICE_CHARS, this.k.config.maxMessageChars))
    }
    if (fact?.trigger === 'mission/budget-warning' && fact.facts !== undefined) {
      const flags = this.currentBudgetWarnings(mission, fact)
      if (flags.some(current => !current)) return renderNoticeFacts('Current resource review; superseded limits remain in the durable record.',
        fact.facts.filter((_text, index) => index >= flags.length || flags[index]), mission.id, delivery.id, Math.min(MAX_OWNER_NOTICE_CHARS, this.k.config.maxMessageChars))
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
      const task = this.k.store.get('tasks', owner!)
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
    const flags = this.currentBudgetWarnings(this.k.mission(delivery.missionId), fact)
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

  /** R17-G5: a wedged pass was just named, by a new row or by the one the owner holds: that is a transition, published with the wedged branch. */
  expectWedgedRelease(missionId: string): void { this.wedgedReleases.add(missionId); this.transition(missionId) }

  /** R17-G5: publish one mission's committed transitions against its settled state. */
  private publishTransition(missionId: string): void {
    if (this.publishingTransition) return
    this.publishingTransition = true
    try {
      // A live pass owns the dispatcher's "ready but not dispatched" question
      // (R15-D3: generation must not invent the cause the pass is about to
      // resolve); the question is asked by the transition that ends or names
      // the pass, and by a wedged pass, which never reached its own question; a
      // body that made progress of its own within the last bound past its bound
      // is running, not wedged (`Scheduling.passState`).
      const state = this.passState(missionId)
      const released = this.wedgedReleases.delete(missionId)
      // A live, un-wedged pass owns generation: it will publish at its own close
      // (the commit that closes the pass is a transition of this same funnel), so
      // a mid-pass commit cannot describe a board the dispatcher is still acting
      // on — the D3/R15-A4 rule, now applied without sampling.
      if (state.passLive && !state.wedged && !released) return
      this.ensureWitness(missionId, state.wedged || released ? { wedged: true } : {})
    } catch {
      // A generation failure must never break the commit that triggered it; the
      // next transition (or the absence net) re-derives the same facts.
    } finally {
      this.publishingTransition = false
    }
  }

  /**
   * No-silent-state backstop (docs/no-silent-state-spec.md §2): the classifier
   * every publication and every pass end runs. A non-terminal mission must
   * leave the owner with a witness: the open row of its condition's own family
   * on the deliveries ledger. Exemptions are the documented ones — the empty
   * board the owner is still planning (row 17) and a board whose non-terminal
   * work is running under a live lease (row 3). The bounded missing-review
   * grace is respected: the row-5 notice arrives after the review need ripens
   * (`ReviewNeed.ripe`), not on the tick the artifact was submitted. Each
   * family deduplicates its own fact on the ledger, so a judgement of a board
   * whose facts the owner holds writes nothing, and no other family's row
   * stands in for it.
   *
   * Every notice below is recorded inside `commit`, so the delivery row that
   * carries the subjects is written in the SAME transaction as the event that
   * accompanies it.
   */
  ensureWitness(missionId: string, options: { wedged?: boolean } = {}): void {
    // R17-G1: the shared interpretation is the only input; no generator below
    // re-reads a raw row to decide what the board means.
    const view = this.interpretation(missionId)
    // Row 17: the owner has not planned work yet; `stalled` uses the same rule.
    if (view.mission.status !== 'active' || !view.tasks.length) return
    this.notifyStallRoots(view)
    // A submitted artifact no live review can accept is named, even behind
    // unrelated live work (verifier-1 challenge, evidence_a454a771), by the
    // runtime's own review admission: each pass admits the review or names the
    // current blocker. This names, through that admission's emitter and blocker
    // rule, only what it does not reach: while a wedged pass keeps it from
    // running, a need it recorded (`ReviewNeed.recorded`).
    if (options.wedged === true) for (const task of view.unreviewed) {
      const need = reviewNeed(view, task)
      const blocker = need.recorded ? reviewPathBlocker(view, task, need) : undefined
      if (blocker !== undefined) this.notifyReviewBlocked(view.mission, task, need.id, blocker)
    }
    this.judgeBoard(view, options)
  }

  /** The board classifiers past the stall roots and the review admission's sources: each tells its own fact once, and a fact the owner holds commits nothing. */
  private judgeBoard(view: Interpretation, options: { wedged?: boolean }): void {
    const missionId = view.missionId
    const mission = view.mission
    const tasks = view.tasks
    const members = view.members
    // R17-G1: the dispatcher's own `dispatchable` set, from the shared view.
    const dispatchable = options.wedged === true
      ? tasks.filter(task => task.status === 'pending' && members.some(member => eligible(view, task, member)))
      : view.dispatchable
    // The dispatchable work is the dispatcher's own question's to name (R15-A4),
    // one emitter among the board's: it names the member whose handle holds the
    // task, or an unexplained dispatch gap (its co-firing guards are in
    // `dispatchQuestion`). A handle that is working is not a silent
    // board: with no member startable the question is not asked (the T3 rule),
    // except by a wedged pass, which never reached its own question (R15-D1).
    // The dedup key is the task at its epoch, so every judgement re-asks it
    // without repeating the wake.
    if (dispatchable.length && (options.wedged === true || members.some(member => member.status === 'waiting' || (member.status === 'idle' && view.view.startable(member.id))))) {
      const question = dispatchQuestion(view, dispatchable)
      if (question !== undefined) this.tell(missionId, question.message, view.subjectsOf([question.task]), { dedupKey: question.dedupKey })
    }
    // The board's own fact, of which this is the one emitter: coverage-complete
    // whenever completion is allowed (an automatic mission completes on its
    // pass instead), the W3 stall once the board is stalled (`boardFact`).
    this.notifyBoard(view)
    // No live work: stuck work is the W3 stall's alone (a stall candidate until the board is stalled).
    if (reviewPathStalled(view)) return
    // R14-F2(c): the unnamed fallback is replaced. While every unfinished task is
    // legitimately waiting (row 3: a running attempt waits on its lease's path),
    // the runtime stays silent; otherwise it escalates UNCONDITIONALLY and names
    // every task its classifier did not recognise, so no state can be silent and
    // unnamed at the same time. A stall root and a dispatchable task have their
    // own board namer (the root's notice, the dispatch question). While no member
    // is startable (T3), no question is asked, and the dispatchable task is still
    // left to it, asked once a member can start; every other task no live path
    // advances is named here, whatever owner decision also names it.
    const roots = new Set(view.stallRoots.map(task => task.id))
    const unrecognised = view.nonTerminal.filter(task => !roots.has(task.id) && !dispatchable.includes(task) && !waitsLegitimately(view, task))
    if (!unrecognised.length) return
    // R17-G3: the fact is the named subjects and the recorded reason (the
    // classifier's verdict), never the board digest.
    const subjects = view.subjectsOf(unrecognised)
    const { content, statement } = renderNotice('fallthrough', { missionTitle: mission.title, subjects: unrecognised })
    this.tell(missionId, content, subjects, { trigger: NOTICE_TEMPLATES.fallthrough.trigger, reason: `no live path advances ${subjects.slice().sort().join(', ')}`, statement })
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
  notifyStallRoots(view: Interpretation): void {
    const mission = view.mission
    for (const root of view.stallRoots) {
      const subject = taskSubject(root)
      const key = `stall-root:${mission.id}:${subject}`
      const dependents = dependentsOf(view, root)
      const cause = overdueStop(view, root) ?? 'no live replacement exists anywhere in its lineage'
      const { content: body, statement } = renderNotice('stall-root', { rootId: root.id, title: root.title, epoch: root.epoch, cause,
        dependents: dependents.map(task => task.id), ...(root.output === undefined ? {} : { recordedReason: root.output }) })
      // A root the verify site already put in front of the owner (its rejection
      // decision at this subject@epoch, as its own row) is recorded against that decision when
      // the decision says all the root does: it names no dependent beyond its
      // own rejecting review(s). The row and event stay; the second wake and its
      // reminders do not (the decision's own reminders carry the root). A root
      // that strands other work, or has no such decision (preparation failure,
      // ceiling, exhausted recovery), wakes to name it.
      const cover = dependents.every(task => task.reviewOf === root.id && task.status === 'blocked')
        ? this.rejectionDecisionFor(mission.id, subject) : undefined
      // The event exists only with the delivery row that carries the fact (its
      // own row or the wake-budget summary), in the same transaction: a notice
      // that was not written must not leave an event per tick behind it.
      this.tell(mission.id, body, view.subjectsOf([root, ...dependents]), { dedupKey: key, trigger: NOTICE_TEMPLATES['stall-root'].trigger, reason: cause,
        statement, ...(cover === undefined ? {} : { coveredBy: cover.id }) }, () => {
        this.k.store.event(mission.id, 'mission/stalled', 'runtime', {
          cause: 'stall-root', taskId: root.id, epoch: root.epoch, reason: root.output ?? null, noticeKey: key,
          dependents: dependents.map(task => task.id), boundMs: this.k.bounds.stallPassTimeoutMs,
          // R14-F2v D1: the W3 stall event carries `unschedulable` and readers
          // (fault F19 row 7) take it from the LATEST mission/stalled event; a
          // stall-root event without it broke that reader. The root plus the
          // tasks that depend on it is the honest value.
          unschedulable: [root.id, ...dependents.map(task => task.id)],
        })
      })
    }
  }

  /**
   * The owner delivery carrying the verify site's rejection decision for one
   * subject@epoch (`REJECTION_DECISION_TRIGGER`) as its own row, identified by
   * its recorded trigger, never by prose. A decision carried by a wake-budget
   * summary covers nothing: the stall root is then its own fact, delivered or
   * summarized like any other, with its own reminder allowance.
   */
  private rejectionDecisionFor(missionId: string, subject: string): Delivery | undefined {
    return this.k.store.list('deliveries', missionId).find(delivery => {
      const row = delivery.to === 'owner' ? noticeRow(delivery) : undefined
      return row?.trigger === REJECTION_DECISION_TRIGGER && (delivery.subjects ?? row.subjects ?? []).includes(subject)
    })
  }

  /**
   * Tell the owner the board's fact (`boardFact`: the W3 stall, or R10-14's
   * coverage-complete, since owner-assembled plans do not auto-complete) once
   * per identity. The deliveries ledger is the record: a fact already on it
   * writes nothing, and the W3 stall's event, which carries the row's key,
   * exists only with its row.
   */
  private notifyBoard(view: Interpretation): void {
    const missionId = view.missionId
    const fact = this.boardFact(view)
    if (fact === undefined) return
    const { content, subjects, key, reason, statement } = fact
    // F(S), the board digest the W3 stall was told on, is an audit field of its event.
    this.tell(missionId, content, subjects, { dedupKey: key, trigger: NOTICE_TEMPLATES[statement.family].trigger, reason, statement }, statement.family !== 'board-stall' ? undefined
      : () => this.k.store.event(missionId, 'mission/stalled', 'runtime', { reason, fingerprint: this.k.fingerprint(missionId), unschedulable: view.unschedulable.map(task => task.id), noticeKey: key }))
  }

  /**
   * R10-15: a running attempt whose owner is parked cannot progress until it is
   * woken or re-pended. Record the parked holder durably and tell the owner once
   * per attempt, so the state is never silent while the lease is alive.
   */
  notifyParkedHolder(mission: Mission, task: Task): void {
    const view = this.interpretation(mission.id)
    const row = view.tasks.find(candidate => candidate.id === task.id) ?? task
    // S5: the durable notice ledger is the gate (its row is written in this call).
    const { content, statement } = renderNotice('parked', { taskId: row.id, title: row.title })
    this.tell(mission.id, content, view.subjectsOf([row]),
      { dedupKey: `parked:${mission.id}:${row.id}:${row.epoch}`, trigger: NOTICE_TEMPLATES.parked.trigger, reason: 'the owning member is parked', statement })
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
    const diagnostic = 'Coding missions require an independently accepted integration artifact, or exactly one independently accepted implementation artifact when the plan has no integration task'
    // S5: the durable notice ledger is the gate (its row is written in this call).
    const { content, statement } = renderNotice('integration-gap', { diagnostic, implementations: view.implementations.map(task => task.id) })
    this.tell(mission.id, content, view.subjectsOf(view.implementations),
      { dedupKey: `integration-gap:${mission.id}:${implementations.length}`, trigger: NOTICE_TEMPLATES['integration-gap'].trigger, reason: diagnostic, statement })
  }

  /** Record an unreviewable submitted deliverable's blocker whenever it changes, and wake the owner once per blocker and review need (`reviewNeed`, src/board.ts): its decision is told with its record (`tell`, whose ledger dedup gates the wake across restarts), and a changed blocker whose decision the owner holds is recorded alone. */
  notifyReviewBlocked(mission: Mission, source: Task, need: string, reason: string): void {
    const view = this.interpretation(mission.id)
    const row = view.tasks.find(candidate => candidate.id === source.id) ?? source
    const record = () => this.k.store.event(mission.id, 'task/review-blocked', 'runtime', { taskId: source.id, kind: source.kind, reason })
    const { content, statement } = renderNotice('review-blocked', { sourceId: row.id, reason })
    if (this.tell(mission.id, content, view.subjectsOf([row]), { dedupKey: reviewBlockedKey(mission.id, row.id, need, reason), trigger: NOTICE_TEMPLATES['review-blocked'].trigger, reason, statement }, record)) return
    if (newestReviewBlock(this.k.store, mission.id, source.id)?.reason !== reason) this.k.commit(mission.id, record)
  }

  topicDelivery(missionId: string, from: string, topic: string, content: string): void {
    for (const member of this.k.store.list('members', missionId)) {
      if (member.id !== from && member.status !== 'stopped' && (member.subscriptions.includes(topic) || member.subscriptions.includes('*'))) {
        this.k.store.put('deliveries', { id: id('msg'), missionId, from, to: member.id, topic, kind: 'finding', content, createdAt: this.k.now() })
      }
    }
  }

  /** The same durable failure covers missing recipients, transport errors and retries. */
  private recordDeliveryFailure(missionId: string, delivery: Delivery, reason: string): void {
    const member = this.k.store.get('members', delivery.to)
    this.k.commit(missionId, () => {
      const current = this.k.store.get('deliveries', delivery.id)
      if (current === undefined || current.deliveredAt !== undefined || current.deliveryFailure?.reason === reason) return
      current.deliveryFailure = { reason, at: this.k.now() }
      this.k.store.put('deliveries', current)
      this.k.store.event(missionId, 'mission/stalled', 'runtime', { cause: delivery.to === 'owner' ? 'owner-delivery-failed' : 'worker-delivery-failed', deliveryId: delivery.id, to: delivery.to, reason })
      if (delivery.to !== 'owner') {
        // One local incident for a member/error, even when many messages
        // are queued. A recovered queue makes this notice obsolete; a new
        // failed delivery afterwards establishes a fresh incident.
        const anchor = this.k.store.list('deliveries', missionId).filter(row => row.to === delivery.to
          && row.deliveredAt === undefined && row.deliveryFailure?.reason === reason)
          .sort((a, b) => a.deliveryFailure!.at - b.deliveryFailure!.at)[0]!
        this.notify(missionId, `Messages to ${member?.name ?? delivery.to} (${delivery.to}) are queued but cannot be delivered: ${reason}. Inspect that member's current task and stop/recovery state; repair or reassign its work to an available member. Increasing the task budget will not repair this transport failure.`,
          noticeSubjectsFor(this.k.boardOf(missionId), { memberId: delivery.to }), {
            noticeClass: 'blocker', trigger: 'worker-delivery-failed', reason,
            dedupKey: `worker-delivery-failed:${anchor.id}:${reasonDigest(reason)}`, deliveryFailureId: anchor.id,
          })
      }
    })
  }

  /**
   * Deliver a mission's queued rows. `pass` is the record of the scheduling
   * body flushing its own outbox: each delivery await is the body's own and is
   * stamped (`awaited`) before its result commits. `only` delivers that one row.
   */
  async flushOutbox(missionId: string, pass?: SchedulingPass, only?: string): Promise<void> {
    if (this.k.shuttingDown) return
    for (const queued of this.k.store.list('deliveries', missionId)) {
      if (this.k.shuttingDown) return
      if (only !== undefined && queued.id !== only) continue
      // A preceding transport can yield to stop/pause, receipts or another pump.
      // Read both rows again before deciding whether this delivery may start.
      const mission = this.k.mission(missionId)
      const delivery = this.k.store.get('deliveries', queued.id)
      if (delivery === undefined || delivery.deliveredAt !== undefined) continue
      if (delivery.kind === 'assignment' && !assignmentCurrent(this.k.store, delivery)) {
        delivery.deliveredAt = this.k.now(); this.k.commit(missionId, () => this.k.store.put('deliveries', delivery)); continue
      }
      // OWNER QUIET: a delivery the owner's own lifecycle decision made moot is
      // not sent, and its row stays durable and undelivered rather than being
      // relabelled as a transport that never happened.
      if (delivery.to === 'owner' && !this.ownerDeliveryRelevant(mission, delivery)) continue
      if (delivery.to !== 'owner' && (mission.status !== 'active' || mission.budgetPause)) continue
      const member = delivery.to === 'owner'
        ? { id: 'owner', missionId, name: 'owner', role: 'owner', sessionId: mission.ownerSessionId, workspace: mission.workspace, status: 'idle' as const, subscriptions: [] }
        : this.k.store.get('members', delivery.to)
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
        delivery.notice.handoffAt = this.k.now()
        this.k.commit(missionId, () => this.k.store.put('deliveries', delivery))
      }
      this.delivering.set(delivery.id, this.k.now())
      // An adapter may accept the message before its acknowledgement times out.
      // Detach a summary at its first handoff: retries keep this ID's content
      // immutable, and later facts get a fresh ID even after the attempt gate
      // is released. Restart also starts a fresh in-memory summary window.
      const window = this.wakeWindows[missionId]
      if (window?.summaryId === delivery.id) delete window.summaryId
      let bound: ReturnType<typeof setTimeout> | undefined
      try {
        const settled = await awaited(pass, Promise.race([
          this.k.workers.deliver(member, delivery).then(() => true),
          new Promise<boolean>(resolve => { bound = setTimeout(() => resolve(false), this.k.bounds.stallPassTimeoutMs) }),
        ]), this.k.now)
        if (!settled) { this.recordOutboxStarvation(missionId, delivery); continue }
        // R17-G8: delivery is the transport fact. It is never relabelled as
        // consumption; the host's claimed signal records consumption separately
        // (`recordConsumption`), with the adapter delivery timestamp as intake.
        this.k.commit(missionId, () => {
          const current = this.k.store.get('deliveries', delivery.id)
          if (current !== undefined && current.deliveredAt === undefined) {
            current.deliveredAt = this.k.now()
            this.k.store.put('deliveries', current)
          }
          // Only acknowledge the failure this retry observed. New lifecycle,
          // budget, receipt and starvation decisions may have landed while the
          // adapter awaited persistence; none may be replaced by the old rows.
          const latest = this.k.mission(missionId)
          const previous = mission.outboxStarved
          const starvation = latest.outboxStarved
          if (previous?.deliveryId === delivery.id && starvation?.deliveryId === delivery.id
            && starvation.attempts === previous.attempts && starvation.at === previous.at) {
            delete latest.outboxStarved
            this.k.store.put('missions', latest)
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
      const mission = this.k.store.get('missions', missionId)
      if (mission === undefined) return
      const attempts = (mission.outboxStarved?.deliveryId === delivery.id ? mission.outboxStarved.attempts : 0) + 1
      mission.outboxStarved = { deliveryId: delivery.id, attempts, at: this.k.now() }
      this.k.commit(missionId, () => this.k.store.put('missions', mission))
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
   *
   * A request is answered by a sweep that starts after it, so every row
   * committed before the request is attempted:
   *  - a request is a pending start, and every request made before that start
   *    runs shares it, because the start reads the outbox after all of them;
   *  - the start is judged when it runs, after the synchronous work that
   *    requested it (every guard of a tick). While the current pump's sweep is
   *    inside the declared bound, the start joins it: that sweep may have read
   *    a mission's outbox before the request's rows existed, so the pump sweeps
   *    again once it ends;
   *  - a sweep past the bound never holds a request (the reviewer's D2): the
   *    start supersedes its pump with a new one, and every request the
   *    superseded pump was holding is its successor's;
   *  - only the current pump starts a mission's flush. A superseded pump ends
   *    with the flush in flight: its successor's sweep started after the
   *    supersession and reaches every mission.
   */
  pumpOutbox(): void {
    if (this.k.shuttingDown || this.k.closed || this.pumpStartPending) return
    this.pumpStartPending = true
    this.k.defer(async () => {
      this.pumpStartPending = false
      const now = this.k.now()
      const current = this.pump
      if (current !== undefined && now - current.sweepStartedAt < this.k.bounds.stallPassTimeoutMs) { current.requested = true; return }
      const pump: Pump = { sweepStartedAt: now, requested: true }
      this.pump = pump
      try {
        while (pump.requested) {
          pump.requested = false
          pump.sweepStartedAt = this.k.now()
          for (const mission of this.k.store.list('missions')) {
            if (this.k.closed || this.k.shuttingDown || this.pump !== pump) return
            try { await this.flushOutbox(mission.id) }
            catch { /* Durable outbox retries; one mission must not stop the pump. */ }
          }
        }
      } finally { if (this.pump === pump) this.pump = undefined }
    })
  }
}
