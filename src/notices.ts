/**
 * Notices and witnesses: the owner-notice ledger (dedup by class + key), the
 * bounded outbox that delivers it outside the mission queue, and the durable
 * stall / coverage / integration-gap witnesses. M1a seam 3/7.
 *
 * Behaviour-identical to the code moved from src/runtime.ts: the runtime keeps
 * thin forwarding methods, so no call site changed.
 */
import { randomUUID } from 'node:crypto'
import { hasNotice, noticeFingerprint as computeNoticeKey, noticeLedger as projectNoticeLedger } from './arena.ts'
import { formatDiagnostic, missingReviewDiagnostic } from './admission.ts'
import { requireText } from './refusals.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { Actor, Delivery, Member, Mission, NoticeClass, Task } from './types.ts'

/**
 * F2: how long a submitted code deliverable may stay without a live review
 * before the runtime concludes none is coming. One scheduler period gives the
 * author the turn in which it submitted to propose its own review; the floor
 * keeps a fast tick from turning a same-turn proposal into a race.
 */
export const AUTO_REVIEW_GRACE_MS = 1000

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
   */
  notify(missionId: string, content: string, from = 'runtime', noticeClass: NoticeClass = 'decision', dedupe = noticeClass === 'budget', dedupKey?: string): void {
    const mission = this.rt.store.get('missions', missionId)
    // No-silent-state witness W2: every owner-decision notice is durable under
    // the fingerprint of the board it was emitted for, so the owner can verify
    // that no non-terminal state was silent. A terminal mission needs no witness.
    if (mission !== undefined && !this.rt.isMissionTerminal(mission)) {
      mission.witness = { fingerprint: this.rt.fingerprint(missionId), kind: 'W2', at: Date.now() }
      this.rt.store.put('missions', mission)
    }
    this.enqueueOwnerNotice(missionId, content, from, noticeClass, {}, dedupe, dedupKey)
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
  enqueueOwnerNotice(missionId: string, content: string, from: string, noticeClass: NoticeClass, extra: Partial<Delivery> = {}, dedupe = noticeClass === 'budget', dedupKeyOverride?: string): Delivery | undefined {
    const dedupKey = dedupKeyOverride ?? this.noticeKey(missionId)
    if (dedupe && hasNotice(this.rt.store.list('deliveries', missionId), { class: noticeClass, dedupKey, from })) return undefined
    const at = Date.now()
    const delivery: Delivery = {
      id: id('msg'), missionId, from, to: 'owner', kind: noticeClass === 'escalation' ? 'escalation' : 'control',
      content, createdAt: at,
      notice: { dedupKey, class: noticeClass, sentAt: at, queuedAt: at },
      ...extra,
    }
    this.rt.store.put('deliveries', delivery)
    return delivery
  }

  /**
   * Read-only notice-delivery ledger: every owner notice with its class, dedup
   * key and sent/queued/claimed lifecycle, newest first. Owner-only: owner
   * notices are control-plane decisions, not worker-visible board content.
   */
  noticeLedger(actor: Actor, missionId: string, query: { limit?: number } = {}): unknown {
    const { owner } = this.rt.participant(actor, missionId)
    if (!owner) throw new Error('Only the mission owner can read the notice-delivery ledger')
    const limit = query.limit === undefined ? 20 : Math.max(1, Math.min(100, Math.trunc(query.limit)))
    const entries = projectNoticeLedger(this.rt.store.list('deliveries', missionId), limit)
    return {
      ledger: entries,
      page: { limit, returned: entries.length },
      fingerprint: this.rt.fingerprint(missionId),
      note: 'Read-only: each row names the mission-state fingerprint it announced and whether the owner notice is still queued or was claimed by the owner session. Recording a notice changes no task, member or budget state.',
    }
  }

  bounded(text: string): string {
    requireText(text, 'content')
    if (text.length > this.rt.config.maxMessageChars) throw new Error(`Content exceeds ${this.rt.config.maxMessageChars} characters`)
    return text
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
   */
  ensureWitness(missionId: string): void {
    const mission = this.rt.mission(missionId)
    if (mission.status !== 'active') return
    const tasks = this.rt.store.list('tasks', missionId)
    const members = this.rt.store.list('members', missionId)
    // Row 17: the owner has not planned work yet; `stalled` uses the same rule.
    if (!tasks.length) return
    const fingerprint = this.rt.fingerprint(missionId)
    if (mission.witness?.fingerprint === fingerprint) return
    // Spec §2 dispatchable: pending, dependencies accepted, and an idle or
    // waiting member can run it. A working member is busy, not a silent board.
    const runnable = members.filter(member => member.status === 'idle' || member.status === 'waiting')
    const dispatchable = tasks.filter(task => task.status === 'pending' && runnable.some(member => this.rt.ready(task, member, tasks)))
    if (dispatchable.length) {
      // T3 integration: the adapter's `isIdle` precondition decides whether the
      // runtime could actually start an eligible member. When every eligible
      // member is busy by the adapter's contract, the board is not "dispatchable
      // but undispatched" — those members are working, and no witness is owed.
      // A parked (`waiting`) member is always startable (R10-09/S3).
      const startable = runnable.some(member => member.status === 'waiting' || this.rt.workers.isIdle(member.id))
      if (!startable) return
      // A dispatchable task that survived a full pass is an admission refusal,
      // not silence: say which task and why the owner may need to act.
      this.notify(missionId, `Task ${dispatchable[0]!.id} (${dispatchable[0]!.title}) is ready for an eligible member but could not be dispatched this tick (mission admission limits or budget). Free a slot, raise a limit with swarm_budget, or withdraw the blocking work with swarm_cancel.`)
      return
    }
    const unreviewed = tasks.filter(task => task.status === 'submitted' && !this.rt.reviewable(task, tasks))
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
      if (ripe.length) this.notify(missionId, `Submitted artifact ${ripe.map(task => task.id).join(', ')} has no live independent review path and cannot reach a verdict while the rest of the board keeps running. Admit an independent verification task with swarm_propose (kind verification, reviewOf ${ripe[0]!.id}) or cancel the source task.`)
      return
    }
    // Row 3 (documented scope): only a board whose *every* non-terminal task is
    // running under a live lease is exempt. Running work plus a pending or
    // blocked task falls through to the witnesses below, so a dependent that
    // cannot start yet still leaves the owner a decision (T1av2 evidence_978a4694).
    const nonTerminal = tasks.filter(task => !['accepted', 'cancelled'].includes(task.status))
    if (nonTerminal.length && nonTerminal.every(task => task.status === 'running' && task.attempt !== undefined && task.attempt.leaseUntil >= Date.now())) return
    if (this.rt.stalled(mission, tasks, members)) {
      this.notifyStall(mission, tasks, members, this.rt.completionError(mission, { cancelUnschedulable: true }) ?? this.rt.completionError(mission) ?? 'no task can make progress')
      return
    }
    this.notify(missionId, `Mission ${mission.title} made no progress this tick and no task is dispatchable. Inspect the board, admit a repair or review with swarm_propose, or decide with swarm_control.`)
  }

  /** Wake the owner once per distinct stalled state; idle workers cannot resolve it themselves. */
  notifyStall(mission: Mission, tasks: Task[], members: Member[], reason: string): void {
    const leftover = this.rt.unschedulable(mission, tasks, members)
    // The stall dedup key is the same owner-observable fingerprint as every
    // other witness, so a stall is fresh exactly when the board changed.
    const fingerprint = this.rt.fingerprint(mission.id)
    if (mission.stallNotice === fingerprint) return
    mission.stallNotice = fingerprint; mission.updatedAt = Date.now()
    const detail = leftover.map(task => `${task.id} (${task.kind}, ${task.status}${task.reviewOf ? `, reviews ${task.reviewOf}` : ''}${task.dependencies.length ? `, depends on ${task.dependencies.join('/')}` : ''})`).join('; ')
    this.rt.commit(mission.id, () => {
      this.rt.store.put('missions', mission)
      this.rt.store.event(mission.id, 'mission/stalled', 'runtime', { reason, fingerprint, unschedulable: leftover.map(task => task.id) })
      this.notify(mission.id, `Mission stalled: no task can be scheduled and workers are idle. ${reason}. Unschedulable: ${detail || 'none'}. Decide: propose repairs or reviews with swarm_propose, adjust the budget, or use swarm_control complete (cancels unschedulable leftovers once every acceptance criterion is independently covered) or stop.`)
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
    const fingerprint = this.rt.fingerprint(mission.id)
    if (mission.coverageNotice === fingerprint) return
    mission.coverageNotice = fingerprint
    this.rt.commit(mission.id, () => {
      this.rt.store.put('missions', mission)
      this.notify(mission.id, `Mission ${mission.title} is ready to complete: every acceptance criterion is independently covered and no task can make further progress. The mission stays active until you decide. Use swarm_control complete to accept the deliverable, or admit more work with swarm_propose.`)
    })
  }

  /**
   * R10-15: a running attempt whose owner is parked cannot progress until it is
   * woken or re-pended. Record the parked holder durably and tell the owner once
   * per attempt, so the state is never silent while the lease is alive.
   */
  notifyParkedHolder(mission: Mission, task: Task): void {
    const key = `parked:${mission.id}:${task.id}:${task.epoch}`
    // S5: the durable notice ledger is the gate; the set is only a cache.
    if (this.parkedNotices.has(key) && hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    this.parkedNotices.add(key)
    this.rt.commit(mission.id, () => {
      this.notify(mission.id, `Task ${task.id} (${task.title}) is held by a parked member and cannot make progress while parked. A fresh assignment wakes it; if the lease expires the task re-pends without spending a recovery attempt.`, 'runtime', 'decision', true, key)
    })
  }

  /**
   * R11-03: the completion rule must not first appear when the owner tries to
   * complete. When a second implementation branch is admitted while the plan has
   * no integration task, emit the same diagnostic `completionError` would.
   */
  warnIntegrationGap(mission: Mission, admitted: Task): void {
    if (admitted.kind !== 'implementation') return
    const tasks = this.rt.store.list('tasks', mission.id)
    const implementations = tasks.filter(task => task.kind === 'implementation')
    if (implementations.length < 2 || tasks.some(task => task.kind === 'integration')) return
    const key = `integration-gap:${mission.id}:${implementations.length}`
    // S5: the durable notice ledger is the gate; the set is only a cache.
    if (this.integrationGapWarned.has(key) && hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    this.integrationGapWarned.add(key)
    const diagnostic = 'Coding missions require an independently accepted integration artifact, or exactly one independently accepted implementation artifact when the plan has no integration task'
    this.rt.commit(mission.id, () => {
      this.notify(mission.id, `${diagnostic}. The mission now has ${implementations.length} implementation branches (${implementations.map(task => task.id).join(', ')}); admit an integration task depending on every branch, or complete with exactly one accepted implementation artifact.`, 'runtime', 'decision', true, key)
    })
  }

  /** Wake the owner once per distinct blocker for one unreviewable submitted deliverable. */
  notifyReviewBlocked(mission: Mission, source: Task, reason: string): void {
    const key = `review-blocked:${mission.id}:${source.id}:${reason}`
    // S5: the durable notice ledger (class, key, sender) is the gate; the set is
    // only a cache, so losing it cannot produce a second notice for the state.
    if (this.reviewPathNotices.has(key) && hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    const diagnostic = formatDiagnostic(missingReviewDiagnostic(source.id, reason))
    this.rt.commit(mission.id, () => {
      this.rt.store.event(mission.id, 'task/review-blocked', 'runtime', { taskId: source.id, kind: source.kind, reason })
      this.notify(mission.id, `${diagnostic}. Admit an independent verification task with swarm_propose (kind verification, reviewOf ${source.id}) or cancel the source task; the mission cannot complete while it is unreviewable.`, 'runtime', 'decision', true, key)
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
        // The ledger's `claimed` timestamp is the adapter delivery that put the
        // notice in front of the owner session; a queued notice stays queued.
        if (delivery.notice !== undefined) delivery.notice.claimedAt = delivery.deliveredAt
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
