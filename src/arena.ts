/**
 * Arena protocols: pending readiness and the read-only notice/escalation
 * projections, with the deliveries ledger's one dedup rule (`hasNotice`).
 *
 * Everything here is a pure function over durable records so the runtime, the
 * tests and the UI projection derive the same answer without a second policy
 * engine. The runtime remains the only writer; these helpers never mutate.
 * A notice's identity is the fact it names (`factKey`, src/notices.ts); the
 * board digest `F(S)` is the runtime's `missionFingerprint`, an instrument.
 */
import { createHash } from 'node:crypto'
import { taskGraphIndex, type TaskGraphIndex } from './task-graph.ts'
import { assignmentAllows, canOwnReview } from './assignment.ts'
import type { Delivery, Escalation, Member, Mission, NoticeClass, Task } from './types.ts'

/** Owner-observable board, as durable records; no wall-clock value participates. */
interface ArenaInput {
  mission: Pick<Mission, 'status'>
  tasks: readonly Task[]
  members: readonly Member[]
  deliveries: readonly Delivery[]
}

const byId = <T extends { id: string }>(left: T, right: T): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)

/**
 * Count pending tasks that a live member could actually run, versus pending
 * tasks that are blocked by dependencies, a dead assignee or review
 * independence. `waiting` counts as live: dispatch to a waiting member is
 * fresh input (R10-09/S3), so readiness must not call it not-ready.
 */
export function pendingReadiness(tasks: readonly Task[], members: readonly Member[], graph: TaskGraphIndex = taskGraphIndex(tasks)): { ready: number; notReady: number } {
  const live = members.filter(member => member.status === 'idle' || member.status === 'waiting')
  let ready = 0, notReady = 0
  for (const task of tasks) {
    if (task.status !== 'pending') continue
    const source = graph.reviewSource(task)
    const runnable = task.dependencies.every(graph.dependencyMet)
      && (task.reviewOf === undefined || source?.status === 'submitted')
      && live.some(member => assignmentAllows(task, member.id, tasks) && canOwnReview(source, member.id))
    if (runnable) ready++
    else notReady++
  }
  return { ready, notReady }
}

/** A covered owner fact (`coveredBy`, src/notices.ts) is never sent: the delivery covering it carried the obligation. */
export const covered = (delivery: Pick<Delivery, 'notice'>): boolean => (delivery.notice as { coveredBy?: string } | undefined)?.coveredBy !== undefined

/** Whether a delivery is still owed to its recipient; a covered fact never is. */
export function awaitsDelivery(delivery: Pick<Delivery, 'deliveredAt' | 'notice'>): boolean {
  return delivery.deliveredAt === undefined && !covered(delivery)
}

/** One owner notice as the ledger exposes it: immutable, read-only projection. */
interface NoticeLedgerEntry {
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
function noticeEntry(delivery: Delivery): NoticeLedgerEntry | undefined {
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

/**
 * Newest-first bounded ledger page. Read-only: the caller receives copies. A
 * covered fact is no notice the owner was sent, so it is not a ledger entry
 * (never `queued`, never the last notice); `hasNotice` still dedups on it.
 */
export function noticeLedger(deliveries: readonly Delivery[], limit = 20): NoticeLedgerEntry[] {
  const bounded = Math.max(1, Math.trunc(limit))
  return deliveries.filter(delivery => !covered(delivery)).map(noticeEntry).filter((entry): entry is NoticeLedgerEntry => entry !== undefined).slice(-bounded).reverse()
}

/**
 * Whether the ledger already holds the fact `dedupKey` names, of the same class
 * from the same sender. `content` narrows the match to an identical message.
 * Summaries retain the original identities on their durable row, so
 * aggregation, delivery and restart cannot re-arm a fact. Older summaries
 * without those identities cannot prove a match.
 */
export function hasNotice(deliveries: readonly Delivery[], match: { class: NoticeClass; dedupKey: string; from: string; content?: string }): boolean {
  const contentDigest = match.content === undefined ? undefined : createHash('sha256').update(match.content).digest('hex')
  return deliveries.some(delivery => {
    const entry = noticeEntry(delivery)
    if (entry === undefined) return false
    if (entry.class === match.class && entry.dedupKey === match.dedupKey
      && entry.from === match.from && (match.content === undefined || entry.content === match.content)) return true
    return delivery.notice?.aggregatedIdentities?.some(identity => identity.class === match.class
      && identity.dedupKey === match.dedupKey && identity.from === match.from
      && (contentDigest === undefined || identity.contentDigest === contentDigest)) ?? false
  })
}

/** Per-member arena row: presence, activity, current attempt age and pending dependencies. */
interface ArenaMemberView {
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
  /** A representative pending task when no attempt is live; not a dispatch prediction. */
  pendingTaskId?: string
  /**
   * Ids of the dependencies still blocking this member: the running attempt's
   * dependencies, or the representative pending task's when there is no live attempt.
   */
  pendingDependencies: string[]
  subscriptions: string[]
}

/**
 * The read-only arena view: what the owner can observe without reading code.
 * It is a projection of durable records only; calling it writes nothing.
 */
interface ArenaView {
  missionId: string
  status: Mission['status']
  pendingDispatchable: number
  members: ArenaMemberView[]
  notices: NoticeLedgerEntry[]
  escalations: Escalation[]
  lastNotice?: { class: NoticeClass; dedupKey: string; at: number }
}

export function arenaView(input: ArenaInput & { missionId: string; now: number; leaseMs: number; limit?: number }): ArenaView {
  const { missionId, now, leaseMs, limit = 20 } = input
  const notices = noticeLedger(input.deliveries, limit)
  const running = input.tasks.filter(task => task.status === 'running' && task.attempt !== undefined)
  const graph = taskGraphIndex(input.tasks)
  const readiness = pendingReadiness(input.tasks, input.members, graph)
  return {
    missionId,
    status: input.mission.status,
    pendingDispatchable: readiness.ready,
    members: [...input.members].sort(byId).map(member => {
      const current = running.find(task => task.attempt!.ownerId === member.id)
      const attemptStart = current === undefined ? undefined : Math.max(0, current.attempt!.leaseUntil - leaseMs)
      // A pending task illustrates a member's outstanding work. This diagnostic
      // is not a dispatch prediction: host readiness remains runtime-owned.
      const next = current === undefined
        ? input.tasks.filter(task => {
          if (task.status !== 'pending' || !assignmentAllows(task, member.id, input.tasks)) return false
          return canOwnReview(graph.reviewSource(task), member.id)
        })
          .sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt || byId(left, right))[0]
        : undefined
      return {
        id: member.id, name: member.name, role: member.role, status: member.status,
        ...(member.activity === undefined ? {} : { activity: member.activity }),
        ...(current === undefined ? {} : { currentTaskId: current.id, attemptId: current.attempt!.id, attemptAgeMs: Math.max(0, now - attemptStart!) }),
        ...(next === undefined ? {} : { pendingTaskId: next.id }),
        pendingDependencies: (current?.dependencies ?? next?.dependencies ?? []).filter(dependency => !graph.dependencyMet(dependency)),
        subscriptions: [...member.subscriptions],
      }
    }),
    notices,
    escalations: notices.map(entry => entry.escalation).filter((item): item is Escalation => item !== undefined),
    ...(notices[0] === undefined ? {} : { lastNotice: { class: notices[0].class, dedupKey: notices[0].dedupKey, at: notices[0].sentAt } }),
  }
}
