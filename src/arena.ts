/**
 * Arena protocols: the mission-state fingerprint, the bounded per-member
 * proposal allowance, and the read-only notice/escalation projections.
 *
 * Everything here is a pure function over durable records so the runtime, the
 * tests and the UI projection derive the same answer without a second policy
 * engine. The runtime remains the only writer; these helpers never mutate.
 *
 * The arena ledger digest is the notice-ledger projection of the `F(S)` of
 * `docs/no-silent-state-spec.md` §4: a stable digest of the owner-observable
 * board that excludes wall-clock fields, so an unchanged state keeps its key
 * and a changed state gets a new one. Owner notices record it as their dedup
 * key (spec §3, §6), which is what lets the ledger prove which states were
 * announced. The no-silent-state invariant itself uses the runtime's exported
 * `missionFingerprint(board)` (T1a's 32-hex F(S)).
 */
import { createHash } from 'node:crypto'
import type { Delivery, Escalation, Evidence, Member, Mission, NoticeClass, Task } from './types.ts'

/** Owner-observable board, as durable records; no wall-clock value participates. */
export interface FingerprintInput {
  mission: Pick<Mission, 'status'>
  tasks: readonly Task[]
  members: readonly Member[]
  evidence: readonly Evidence[]
  deliveries: readonly Delivery[]
}

const byId = <T extends { id: string }>(left: T, right: T): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

/**
 * The live carrier of one dependency reference, following repair lineage the
 * same way the runtime does: a blocked or cancelled task resolves to its
 * replacement, deterministically (oldest live replacement, id tie-break).
 */
export function liveCarrier(tasks: readonly Task[], dependencyId: string, seen: Set<string> = new Set()): Task | undefined {
  const task = tasks.find(candidate => candidate.id === dependencyId)
  if (task === undefined || seen.has(task.id)) return undefined
  seen.add(task.id)
  if (task.status !== 'blocked' && task.status !== 'cancelled') return task
  const replacements = tasks.filter(candidate => candidate.replaces?.includes(task.id) && !seen.has(candidate.id))
  const oldest = (candidates: readonly Task[]) => [...candidates]
    .sort((left, right) => left.createdAt - right.createdAt || byId(left, right))[0]
  const next = oldest(replacements.filter(candidate => candidate.status === 'accepted'))
    ?? oldest(replacements.filter(candidate => ['pending', 'running', 'submitted'].includes(candidate.status)))
    ?? oldest(replacements.filter(candidate => candidate.status === 'blocked' || candidate.status === 'cancelled'))
  return next === undefined ? task : liveCarrier(tasks, next.id, seen)
}

/** Whether one dependency reference is satisfied by an accepted live carrier. */
export function dependencyAccepted(tasks: readonly Task[], dependencyId: string): boolean {
  return liveCarrier(tasks, dependencyId)?.status === 'accepted'
}

/** A submitted task's live review path: a non-terminal verification task reviewing it. */
function hasReviewPath(tasks: readonly Task[], taskId: string): boolean {
  return tasks.some(candidate => candidate.reviewOf === taskId && ['pending', 'running', 'submitted'].includes(candidate.status))
}

/** The author of the reviewed source; a reviewer must differ from it. */
function reviewedAuthor(tasks: readonly Task[], reviewOf: string | undefined): string | undefined {
  if (reviewOf === undefined) return undefined
  const source = tasks.find(candidate => candidate.id === reviewOf)
  return source?.attempt?.ownerId ?? source?.assigneeId
}

/**
 * Count pending tasks that a live member could actually run, versus pending
 * tasks that are blocked by dependencies, a dead assignee or review
 * independence. `waiting` counts as live: dispatch to a waiting member is
 * fresh input (R10-09/S3), so the fingerprint must not call it not-ready.
 */
export function pendingReadiness(tasks: readonly Task[], members: readonly Member[]): { ready: number; notReady: number } {
  const live = members.filter(member => member.status !== 'stopped')
  let ready = 0, notReady = 0
  for (const task of tasks) {
    if (task.status !== 'pending') continue
    const assignee = task.assigneeId === undefined ? undefined : live.find(member => member.id === task.assigneeId)
    const pinnedToStopped = task.assigneeId !== undefined && assignee === undefined
    const author = reviewedAuthor(tasks, task.reviewOf)
    const independent = assignee === undefined || author === undefined || assignee.id !== author
    const runnable = !pinnedToStopped && independent && task.dependencies.every(dependency => dependencyAccepted(tasks, dependency))
      && (task.assigneeId === undefined ? live.length > 0 : assignee !== undefined)
    if (runnable) ready++
    else notReady++
  }
  return { ready, notReady }
}

/**
 * The arena ledger digest: the notice-ledger projection of `F(S)` per spec §4.
 * The canonical projection is sorted everywhere, contains no timestamp, and is
 * hashed so the notice ledger and its tests can compare states by value. The
 * no-silent-state invariant itself uses the runtime's exported
 * `missionFingerprint(board)` (T1a's 32-hex F(S)); this 64-hex digest is the
 * ledger's dedup-key projection and is deliberately a different value domain.
 */
export function arenaLedgerDigest(input: FingerprintInput): string {
  return digest(input, false)
}

/**
 * The notice dedup key: the arena ledger digest with the owner-notice channel
 * itself excluded from the pending-delivery count. A notice is the witness for
 * a state, so counting the witness as board state would change the very key it
 * was recorded under and make the ledger suppress nothing. It equals
 * `arenaLedgerDigest` for every state with no owner notice in flight, which is
 * the normal case because the outbox drains on the same tick.
 */
export function noticeFingerprint(input: FingerprintInput): string {
  return digest(input, true)
}

function digest(input: FingerprintInput, excludeNotices: boolean): string {
  const { mission, tasks, members, evidence, deliveries } = input
  const readiness = pendingReadiness(tasks, members)
  const canonical = {
    status: mission.status,
    tasks: [...tasks].sort(byId).map(task => [task.id, task.status, task.attempt?.ownerId ?? null]),
    ready: readiness.ready,
    notReady: readiness.notReady,
    submittedUnreviewed: tasks.filter(task => task.status === 'submitted' && !hasReviewPath(tasks, task.id)).map(task => task.id).sort(),
    members: [...members].sort(byId).map(member => [member.id, member.status]),
    pendingDeliveries: deliveries.filter(delivery => delivery.deliveredAt === undefined && !(excludeNotices && delivery.notice !== undefined)).length,
    challenged: evidence.filter(item => item.status === 'challenged').map(item => item.id).sort(),
    ceilings: tasks.filter(task => task.ceiling !== undefined)
      .map(task => [task.id, task.ceiling!.dimension, task.ceiling!.limit, task.ceiling!.used]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** The owner-set bound on how much board one member may add, and its usage. */
export interface ProposalAllowance {
  /** Effective per-member limit: inside the mission task ceiling, never below 1. */
  limit: number
  /** The mission task ceiling the allowance sits inside. */
  ceiling: number
  /** Planned worker capacity used to derive the default share. */
  plannedMembers: number
  /** Non-cancelled tasks this proposer already added to the board. */
  admitted: number
}

/**
 * R11-17: derive the allowance from the owner-set mission ceiling. It is a pure
 * function of durable state, so a member cannot raise it: the only input that
 * changes it is `maxTasks`, and `swarm_budget` is owner-only. A cancelled task
 * does not consume the allowance (it no longer occupies the board).
 */
export function proposalAllowance(mission: Pick<Mission, 'budget'>, members: readonly Member[], tasks: readonly Task[], proposer: string): ProposalAllowance {
  const ceiling = Math.max(1, mission.budget.maxTasks)
  const plannedMembers = Math.max(1, mission.budget.maxWorkers)
  const limit = Math.max(1, Math.min(ceiling, Math.ceil(ceiling / plannedMembers)))
  const admitted = tasks.filter(task => task.proposedBy === proposer && task.status !== 'cancelled').length
  return { limit, ceiling, plannedMembers, admitted }
}

/** One owner notice as the ledger exposes it: immutable, read-only projection. */
export interface NoticeLedgerEntry {
  id: string
  missionId: string
  class: NoticeClass
  dedupKey: string
  from: string
  content: string
  sentAt: number
  queuedAt: number
  /**
   * R17-G8: the transport fact (the adapter delivered it) and the consumption
   * fact (the host's claimed signal). They are separate: `state` is transport
   * only (`claimed` means "the adapter put it in front of the owner session"),
   * a delivery is never relabelled as consumed, and consumption is never
   * inferred from transport.
   */
  deliveredAt?: number
  consumedAt?: number
  state: 'queued' | 'claimed'
  deliveryId: string
  escalation?: Escalation
}

/** Project one delivery into a ledger entry, or undefined when it is not an owner notice. */
export function noticeEntry(delivery: Delivery): NoticeLedgerEntry | undefined {
  if (delivery.notice === undefined || delivery.to !== 'owner') return undefined
  return {
    id: delivery.id, missionId: delivery.missionId, class: delivery.notice.class, dedupKey: delivery.notice.dedupKey,
    from: delivery.from, content: delivery.content,
    sentAt: delivery.notice.sentAt, queuedAt: delivery.notice.queuedAt,
    ...(delivery.deliveredAt === undefined ? {} : { deliveredAt: delivery.deliveredAt }),
    ...((delivery.notice as { consumedAt?: number }).consumedAt === undefined ? {} : { consumedAt: (delivery.notice as { consumedAt?: number }).consumedAt }),
    state: delivery.deliveredAt === undefined ? 'queued' : 'claimed',
    deliveryId: delivery.id,
    ...(delivery.escalation === undefined ? {} : { escalation: delivery.escalation }),
  }
}

/** Newest-first bounded ledger page. Read-only: the caller receives copies. */
export function noticeLedger(deliveries: readonly Delivery[], limit = 20): NoticeLedgerEntry[] {
  const bounded = Math.max(1, Math.trunc(limit))
  return deliveries.map(noticeEntry).filter((entry): entry is NoticeLedgerEntry => entry !== undefined).slice(-bounded).reverse()
}

/** The most recent notice of one class, used for witness dedup and reporting. */
export function lastNoticeOfClass(deliveries: readonly Delivery[], noticeClass: NoticeClass): NoticeLedgerEntry | undefined {
  for (let index = deliveries.length - 1; index >= 0; index--) {
    const entry = noticeEntry(deliveries[index]!)
    if (entry !== undefined && entry.class === noticeClass) return entry
  }
  return undefined
}

/**
 * Whether the same class already announced the same state fingerprint from the
 * same sender. `content` narrows the match to an identical message. A different
 * message in the same state is a different decision and must still reach the
 * owner; an identical repeat is spam. The dedup key recorded on the row stays
 * the state fingerprint.
 */
export function hasNotice(deliveries: readonly Delivery[], match: { class: NoticeClass; dedupKey: string; from: string; content?: string }): boolean {
  return deliveries.some(delivery => {
    const entry = noticeEntry(delivery)
    return entry !== undefined && entry.class === match.class && entry.dedupKey === match.dedupKey
      && entry.from === match.from && (match.content === undefined || entry.content === match.content)
  })
}

/** Per-member arena row: presence, activity, current attempt age and pending dependencies. */
export interface ArenaMemberView {
  id: string
  name: string
  role: string
  status: Member['status']
  activity?: Member['activity']
  currentTaskId?: string
  attemptId?: string
  /**
   * Age of the current lease window in milliseconds (now minus the lease
   * start implied by `leaseUntil - leaseMs`), or undefined without a live
   * attempt. A renewed lease resets the window; the attempt id still names the
   * same ownership across renewals.
   */
  attemptAgeMs?: number
  /** The member's next pending task, when it holds no live attempt. */
  pendingTaskId?: string
  /**
   * Ids of the dependencies still blocking this member: the running attempt's
   * dependencies, or the next pending task's when there is no live attempt.
   */
  pendingDependencies: string[]
  subscriptions: string[]
}

/**
 * The read-only arena view: what the owner can observe without reading code.
 * It is a projection of durable records only; calling it writes nothing.
 */
export interface ArenaView {
  missionId: string
  status: Mission['status']
  fingerprint: string
  pendingDispatchable: number
  members: ArenaMemberView[]
  notices: NoticeLedgerEntry[]
  escalations: Escalation[]
  lastNotice?: { class: NoticeClass; dedupKey: string; at: number }
}

export function arenaView(input: FingerprintInput & { missionId: string; now: number; leaseMs: number; limit?: number }): ArenaView {
  const { missionId, now, leaseMs, limit = 20 } = input
  const notices = noticeLedger(input.deliveries, limit)
  const running = input.tasks.filter(task => task.status === 'running' && task.attempt !== undefined)
  return {
    missionId,
    status: input.mission.status,
    fingerprint: arenaLedgerDigest(input),
    pendingDispatchable: pendingReadiness(input.tasks, input.members).ready,
    members: [...input.members].sort(byId).map(member => {
      const current = running.find(task => task.attempt!.ownerId === member.id)
      const attemptStart = current === undefined ? undefined : Math.max(0, current.attempt!.leaseUntil - leaseMs)
      // Without a live attempt, the member's next pending task names what it is
      // waiting on, so the owner can see a blocked member, not just a busy one.
      const next = current === undefined
        ? input.tasks.filter(task => task.status === 'pending' && (task.assigneeId === undefined || task.assigneeId === member.id))
          .sort((left, right) => Number(right.assigneeId === member.id) - Number(left.assigneeId === member.id)
            || right.priority - left.priority || left.createdAt - right.createdAt || byId(left, right))[0]
        : undefined
      return {
        id: member.id, name: member.name, role: member.role, status: member.status,
        ...(member.activity === undefined ? {} : { activity: member.activity }),
        ...(current === undefined ? {} : { currentTaskId: current.id, attemptId: current.attempt!.id, attemptAgeMs: Math.max(0, now - attemptStart!) }),
        ...(next === undefined ? {} : { pendingTaskId: next.id }),
        pendingDependencies: (current?.dependencies ?? next?.dependencies ?? []).filter(dependency => !dependencyAccepted(input.tasks, dependency)),
        subscriptions: [...member.subscriptions],
      }
    }),
    notices,
    escalations: notices.map(entry => entry.escalation).filter((item): item is Escalation => item !== undefined),
    ...(notices[0] === undefined ? {} : { lastNotice: { class: notices[0].class, dedupKey: notices[0].dedupKey, at: notices[0].sentAt } }),
  }
}
