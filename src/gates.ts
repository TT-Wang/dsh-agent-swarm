/**
 * Gates: the owner/board instruments and the usage accounting that gates a
 * budget stop. M1a seam 2/7. F(S), the fingerprint the instruments show, is a
 * function of the board (`fingerprintBoard`, src/board.ts) the kernel caches
 * (`Kernel.fingerprint`).
 *
 * `RuntimeGates` stands on the kernel and three seams below it, each called one
 * hop: the notices a warning and the budget terminal go through, the refusals a
 * budget block records and the declared checks, whose assignment delivery a
 * budget resume writes. Every caller reaches it as `runtime.gates`, so a test
 * that patches `runtime.gates.<method>` intercepts them all.
 */
import { createHash } from 'node:crypto'
import { id } from './store.ts'
import { arenaView as projectArenaView, hasNotice, openAsks } from './arena.ts'
import { TERMINAL_STATES, currentEvidenceIds, holdsAttempt, holdsOpenAttempt, subjectsOfTasks, terminal } from './task-graph.ts'
import { excerpt, type DeclaredChecks } from './declared-checks.ts'
import { executionElapsed } from './resource-time.ts'
import { dispatchable, inFlightEstimate, stepsInFlight } from './board.ts'
import { noticeFamily, noticeIdentity, type Notices } from './notices.ts'
import type { RefusalRegistry } from './refusals.ts'
import type { Kernel } from './kernel.ts'
import type { Delivery, Mission, Post, Task, UsageBuckets, UsageSnapshotSource } from './types.ts'

const USAGE_KEYS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'requests'] as const

export const emptyUsage = (): UsageBuckets => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 })

export function addUsage(base: UsageBuckets | undefined, delta: UsageBuckets): UsageBuckets {
  const result = { ...(base ?? emptyUsage()) }
  for (const key of USAGE_KEYS) result[key] += Math.max(0, delta[key])
  return result
}

/** Cumulative logs never shrink; a smaller bucket means a replayed snapshot and contributes nothing. */
function usageDelta(next: UsageBuckets, previous: UsageBuckets | undefined): UsageBuckets {
  const result = emptyUsage()
  for (const key of USAGE_KEYS) result[key] = Math.max(0, next[key] - (previous?.[key] ?? 0))
  return result
}

function validUsage(value: unknown): value is UsageBuckets {
  return value !== null && typeof value === 'object' && USAGE_KEYS.every(key => Number.isSafeInteger((value as Record<string, unknown>)[key]) && Number((value as Record<string, unknown>)[key]) >= 0)
}

/** Observe shows only the newest few new posts; the board tool pages the rest. */
export const BOARD_DELTA_POSTS = 3

/** Extra lease headroom per allowed output token while a model stream is observably live. */
const DEFAULT_BUDGET_WARN_AT: readonly number[] = [0.7, 0.9]

/**
 * Bounded board projection. `full` is used only by the single-post read; every
 * page carries an excerpt and says how many characters were withheld, so a
 * board page can never flood a model context. TTL expiry is reported, never
 * enforced by mutating the post.
 */
export function postView(post: Post, now: number, full = false): Record<string, unknown> {
  return {
    id: post.id, seq: post.seq, kind: post.kind, fromMemberId: post.fromMemberId,
    ...(post.toMemberId === undefined ? {} : { toMemberId: post.toMemberId }),
    ...(post.taskId === undefined ? {} : { taskId: post.taskId }),
    ...(post.attemptId === undefined ? {} : { attemptId: post.attemptId }),
    body: full ? post.body : excerpt(post.body, BOARD_BODY_EXCERPT),
    ...(full || post.body.length <= BOARD_BODY_EXCERPT ? {} : { bodyChars: post.body.length, bodyTruncated: true }),
    ...(post.evidenceIds.length ? { evidenceIds: post.evidenceIds } : {}),
    ...(post.toolRunIds.length ? { toolRunIds: post.toolRunIds } : {}),
    ...(post.replyTo === undefined ? {} : { replyTo: post.replyTo }),
    createdAt: post.createdAt,
    ...(post.ttlMs === undefined ? {} : { ttlMs: post.ttlMs, expiresAt: post.createdAt + post.ttlMs, expired: now >= post.createdAt + post.ttlMs }),
  }
}

/** A board page shows a bounded body excerpt; the full body is read by postId. */
const BOARD_BODY_EXCERPT = 600

export class RuntimeGates {
  constructor(private readonly k: Kernel, private readonly notices: Notices, private readonly refusals: RefusalRegistry, private readonly declaredChecks: DeclaredChecks) {}

  /**
   * Read-only owner instruments (docs/no-silent-state-spec.md §6): the current
   * board digest `F(S)`, the last witness (the newest ledger row) with its family and time, the
   * pending-dispatchable count, the notice-delivery ledger and durable
   * escalations. `full` adds the per-member arena rows and the ledger page; the
   * compact form keeps the owner's routine observe response small. A pure
   * projection of durable records; it writes nothing.
   */
  ownerInstruments(missionId: string, full: boolean): Record<string, unknown> {
    const records = { mission: this.k.mission(missionId), tasks: this.k.store.list('tasks', missionId), members: this.k.store.list('members', missionId), deliveries: this.k.store.list('deliveries', missionId) }
    const view = projectArenaView({ ...records, missionId, now: this.k.now(), leaseMs: this.k.config.leaseMs })
    const counts = { sent: view.notices.length, queued: view.notices.filter(entry => entry.state === 'queued').length, claimed: view.notices.filter(entry => entry.state === 'claimed').length }
    return {
      // T3d: the owner-visible fingerprint is the board digest F(S); no notice is keyed by it.
      fingerprint: this.k.fingerprint(missionId),
      pendingDispatchable: dispatchable(this.k.boardOf(missionId)).length,
      ...(view.lastNotice === undefined ? {} : { lastWitness: { ...view.lastNotice, family: noticeFamily(records.deliveries.find(delivery => delivery.id === view.notices[0]!.deliveryId)!) } }),
      notices: counts,
      // L3: the receipts nobody has settled yet. A question with no answer is a
      // silent state by the same argument the board uses, so it is named here
      // with the call that closes it, whether or not the owner acted on a nudge.
      openAsks: this.openAsks(missionId),
      ...(full ? { noticeLedger: view.notices, escalations: view.escalations, arena: { missionId: view.missionId, status: view.status, members: view.members } } : {}),
      note: 'Read-only arena instruments: fingerprint, last witness, pending dispatchable tasks, notice counts' + (full ? ', the notice-delivery ledger, escalations and per-member presence/activity/attempt age/pending dependencies' : '') + '. Reading them changes no state.',
    }
  }

  /** L3: open receipts as the owner reads them, bounded and answerable by id. */
  private openAsks(missionId: string): { count: number; asks: Array<Record<string, unknown>>; note: string } {
    const open = openAsks(this.k.store.list('deliveries', missionId))
    const asks = [...open]
      .sort((a, b) => (a.deliveredAt ?? a.createdAt) - (b.deliveredAt ?? b.createdAt))
      .slice(0, 10)
      .map(delivery => ({
        deliveryId: delivery.id,
        to: delivery.to === 'owner' ? 'owner' : delivery.to,
        from: delivery.from,
        ...(delivery.taskId === undefined ? {} : { taskId: delivery.taskId }),
        ageMs: Math.max(0, this.k.now() - (delivery.deliveredAt ?? delivery.createdAt)),
        nudges: delivery.replyNudges ?? 0,
        question: delivery.content.replace(/\s+/g, ' ').slice(0, 200),
      }))
    return {
      count: open.length,
      asks,
      note: 'Questions with no receipt. Answer one with swarm_message and its deliveryId in replyTo, or close it with dismiss: true; an owner question answered only in chat is still open here.',
    }
  }

  /**
   * Bounded board window for observe: counts plus the newest few posts after
   * the member's delivered cursor. Older unseen posts are counted and named as
   * omitted rather than re-sent; `swarm_board` pages them with an explicit
   * cursor, so nothing is lost and no delta grows without bound.
   */
  boardWindow(missionId: string, memberId: string, afterSeq: number): Record<string, unknown> {
    const count = this.k.store.countPosts(missionId, { afterSeq })
    const newest = this.k.store.posts(missionId, { afterSeq, newest: true, limit: BOARD_DELTA_POSTS })
    return {
      count,
      addressed: this.k.store.countPosts(missionId, { inboxFor: memberId, afterSeq }),
      newest: newest.map(post => postView(post, this.k.now())),
      ...(count > newest.length ? { omitted: count - newest.length } : {}),
      ...(newest.length ? { nextAfter: newest.at(-1)!.seq } : {}),
    }
  }

  async usage(memberId: string, tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens < 0 || this.k.closed) return
    const member = this.k.store.get('members', memberId)
    if (!member) return
    const mission = this.k.mission(member.missionId)
    mission.usedTokens += Math.ceil(tokens)
    this.k.commit(mission.id, () => { this.k.store.put('missions', mission) })
    this.warnBudget(mission)
    if (mission.usedTokens >= mission.budget.maxTokens) this.blockBudget(mission)
  }

  /** Reconcile durable Harness usage cumulatively, including after a crash before SQLite accounting. */
  async usageSnapshot(memberId: string, totalTokens: number, usage?: UsageBuckets, source?: UsageSnapshotSource): Promise<void> {
    if (this.k.closed) return
    if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) throw new Error('Invalid authoritative usage snapshot')
    if (usage !== undefined && !validUsage(usage)) throw new Error('Invalid usage buckets')
    if (source !== undefined && (!Number.isSafeInteger(source.generation) || source.generation < 0 || typeof source.restored !== 'boolean')) throw new Error('Invalid usage session generation')
    const member = this.k.store.get('members', memberId)
    if (!member) throw new Error('Unknown worker in usage accounting')
    const mission = this.k.mission(member.missionId)
    // New native sessions restart their cumulative log at zero. Never use a
    // member's lifetime total as that new log's watermark or erase old costs.
    // A late observation from a retired generation must not reopen its ledger.
    if (source !== undefined && member.usageSession !== undefined && source.generation < member.usageSession.generation) return
    const sameSession = source !== undefined && member.usageSession?.generation === source.generation
    const migrate = source !== undefined && member.usageSession === undefined && source.restored
    const previous = source === undefined || migrate ? { accountedTokens: member.accountedTokens ?? 0, usage: member.usage }
      : sameSession ? member.usageSession! : { accountedTokens: 0, usage: undefined }
    const tokenDelta = Math.max(0, totalTokens - previous.accountedTokens)
    const bucketDelta = usage === undefined ? undefined : usageDelta(usage, previous.usage)
    if (tokenDelta === 0 && (bucketDelta === undefined || USAGE_KEYS.every(key => bucketDelta[key] === 0)) && (source === undefined || sameSession)) return
    member.accountedTokens = (member.accountedTokens ?? 0) + tokenDelta
    mission.usedTokens += tokenDelta
    if (bucketDelta !== undefined) { member.usage = addUsage(member.usage, bucketDelta); mission.workerUsage = addUsage(mission.workerUsage, bucketDelta) }
    if (source !== undefined) member.usageSession = {
      generation: source.generation,
      accountedTokens: Math.max(previous.accountedTokens, totalTokens),
      ...(bucketDelta === undefined ? previous.usage === undefined ? {} : { usage: previous.usage } : { usage: addUsage(previous.usage, bucketDelta) }),
    }
    this.k.commit(mission.id, () => { this.k.store.put('members', member); this.k.store.put('missions', mission) })
    this.warnBudget(mission)
    if (mission.usedTokens >= mission.budget.maxTokens) this.blockBudget(mission)
  }

  /**
   * Owner-session usage (planning, coordination, replies to notices) is not
   * charged to the worker pool but is attributed to that owner's newest live
   * mission, or to its planning request before launch, so the total cost of a
   * collaboration stays visible.
   */
  recordOwnerUsage(sessionId: string, usage: UsageBuckets): void {
    if (this.k.closed || this.k.shuttingDown || !validUsage(usage) || this.k.isWorkerSession(sessionId)) return
    const mission = this.k.store.list('missions').filter(item => item.ownerSessionId === sessionId && !terminal(item)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (mission) {
      mission.ownerUsage = addUsage(mission.ownerUsage, usage); mission.updatedAt = this.k.now()
      this.k.commit(mission.id, () => this.k.store.put('missions', mission))
      return
    }
    const request = this.k.store.list('starts').filter(item => item.ownerSessionId === sessionId && (item.status === 'planning' || item.status === 'launching')).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!request) return
    request.ownerUsage = addUsage(request.ownerUsage, usage); request.updatedAt = this.k.now()
    this.k.commit(request.id, () => this.k.store.put('starts', request))
  }

  /** Budget dimensions that are currently exhausted; used by the pause reason and event. */
  exhaustedDimensions(mission: Mission): string[] {
    const dimensions: string[] = []
    if (mission.usedTokens >= mission.budget.maxTokens) dimensions.push('maxTokens')
    if (mission.usedSteps >= mission.budget.maxSteps) dimensions.push('maxSteps')
    if (this.k.now() >= mission.deadline) dimensions.push('maxDurationMs')
    return dimensions
  }

  /**
   * Emit at most one approaching-limit warning per allocation (scope, dimension
   * and limit) and threshold: a durable owner review notice; thresholds default
   * to 0.7/0.9. The deliveries ledger is the one record of a warning, so a
   * crossing the owner holds at that threshold or a higher one is not told again.
   */
  warnBudget(mission: Mission): void {
    if (mission.status !== 'active' || mission.budgetPause) return
    const thresholds = [...(this.k.config.budgetWarnAt ?? DEFAULT_BUDGET_WARN_AT)]
      .filter(value => Number.isFinite(value) && value > 0 && value < 1).sort((a, b) => a - b)
    if (!thresholds.length) return
    const members = this.k.store.list('members', mission.id)
    const inFlight = stepsInFlight(this.k.view, members)
    const tasks = this.k.store.list('tasks', mission.id)
    const pairedSources = new Set(tasks.filter(task => task.kind === 'verification' && task.status !== 'cancelled').map(task => task.reviewOf))
    const pendingReviewSlots = tasks.filter(task => task.kind !== 'verification' && !TERMINAL_STATES.has(task.status) && !pairedSources.has(task.id)).length
    const dimensions: Array<{ dimension: string; used: number; limit: number; inFlight: number; reviewSlots?: number; task?: Task }> = [
      { dimension: 'maxTokens', used: mission.usedTokens, limit: mission.budget.maxTokens, inFlight: inFlightEstimate(this.k.view, members) },
      { dimension: 'maxSteps', used: mission.usedSteps, limit: mission.budget.maxSteps, inFlight: inFlight.length },
      { dimension: 'maxDurationMs', used: executionElapsed(mission, this.k.now()), limit: mission.budget.maxDurationMs, inFlight: 0 },
      { dimension: 'maxTasks', used: tasks.length, limit: mission.budget.maxTasks, inFlight: 0, reviewSlots: pendingReviewSlots },
    ]
    for (const task of tasks) {
      if (TERMINAL_STATES.has(task.status)) continue
      if (task.maxSteps !== undefined) dimensions.push({ dimension: 'maxSteps', used: task.usedSteps ?? 0, limit: task.maxSteps,
        inFlight: inFlight.some(member => member.id === task.attempt?.ownerId) ? 1 : 0, task })
      // A claim a rework archived is history of a rejected round, so it counts toward no round's findings.
      if (task.maxFindings !== undefined) dimensions.push({ dimension: 'maxFindings', used: currentEvidenceIds(task).length, limit: task.maxFindings, inFlight: 0, task })
    }
    const warnings: Array<{ key: string; content: string; subjects: string[]; data: Record<string, string | number> }> = []
    let missionProgress: string | undefined
    let ledger: Delivery[] | undefined
    for (const item of dimensions) {
      if (!(item.limit > 0)) continue
      const projected = item.used + item.inFlight + (item.reviewSlots ?? 0)
      const crossed = thresholds.filter(threshold => projected / item.limit >= threshold).at(-1)
      const review = `budget-review:${mission.id}:${item.task?.id ?? 'mission'}:${item.dimension}:${item.limit}`, subjects = subjectsOfTasks(item.task === undefined ? [] : [item.task], mission)
      if (crossed === undefined || thresholds.some(threshold => threshold >= crossed
        && hasNotice(ledger ??= this.k.store.list('deliveries', mission.id), noticeIdentity(mission.id, subjects, { noticeClass: 'budget', dedupKey: `${review}:${threshold}` }).identity))) continue
      // This is only the numeric floor that restores threshold headroom, never
      // an estimate of the resources needed to finish the mission.
      const recommendation = Math.max(item.limit + 1, Math.ceil(Number((projected / thresholds[0]!).toFixed(6))))
      const suggestedLimit = Number.isSafeInteger(recommendation) ? recommendation : undefined
      const scope = item.task === undefined ? 'Mission' : `Task ${item.task.id} (${item.task.title})`
      const progress = item.task === undefined
        ? missionProgress ??= `${tasks.filter(task => task.status === 'accepted').length}/${tasks.length} tasks accepted; ${this.k.store.list('evidence', mission.id).length} evidence records`
        : `status ${item.task.status}; ${item.task.evidenceIds.length} evidence records; artifact ${item.task.artifact?.commit ?? 'not submitted'}`
      const data = { dimension: item.dimension, threshold: crossed, used: item.used, limit: item.limit,
        remaining: Math.max(0, item.limit - item.used), inFlightEstimate: item.inFlight, projected,
        projectionBasis: item.dimension === 'maxTokens' ? 'settled-plus-current-model-requests' : item.reviewSlots !== undefined ? 'admitted-plus-unpaired-reviews' : 'settled-plus-in-flight',
        ...(item.reviewSlots === undefined ? {} : { pendingReviewSlots: item.reviewSlots, remainingAfterReviews: Math.max(0, item.limit - projected) }),
        ...(suggestedLimit === undefined ? {} : { suggestedLimit, suggestedLimitBasis: 'threshold-headroom-only' }), ...(item.task === undefined ? {} : { taskId: item.task.id }), progress }
      warnings.push({ key: `${review}:${crossed}`, data, subjects,
        content: `${scope}: ${item.dimension} ${item.reviewSlots === undefined ? 'settled' : 'admitted'} ${item.used}/${item.limit}, remaining ${data.remaining}; ${item.reviewSlots === undefined ? `in-flight estimate ${item.inFlight}` : `${item.reviewSlots} known review slots still needed`}, projected ${projected}, threshold ${crossed}.${suggestedLimit === undefined ? '' : ` Threshold-headroom floor for ${item.dimension}: ${suggestedLimit}; decide the actual allowance from remaining work.`} Progress: ${progress}.${item.dimension === 'maxTokens' ? ' Token projection covers current requests only, not the cost of completing remaining tasks.' : ''}${item.dimension === 'maxFindings' ? ' Finding count is advisory.' : ''}` })
    }
    if (!warnings.length) return
    // One owner wake for this pass; each dimension keeps its durable event and
    // identity so a later threshold, changed limit or restart remains distinct.
    this.k.commit(mission.id, () => {
      for (const warning of warnings) this.k.store.event(mission.id, 'mission/budget-warning', 'runtime', warning.data)
      const keys = warnings.map(warning => warning.key)
      const dedupKey = warnings.length === 1 ? keys[0]! : `budget-review:${mission.id}:batch:${createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 20)}`
      const instructions = 'Review remaining work and use swarm_budget with reason: budget for the mission, or taskId and taskBudget for a task. Exhaustion preserves work; an extension never overrides a user pause or fixed deadline.'
      this.notices.notify(mission.id, `Resource review (${warnings.length} threshold${warnings.length === 1 ? '' : 's'}):\n${warnings.map(warning => `- ${warning.content}`).join('\n')}\n${instructions}`,
        [...new Set(warnings.flatMap(warning => warning.subjects))], { noticeClass: 'budget', dedupKey, trigger: 'mission/budget-warning', reason: keys.join('\n'),
          facts: [...warnings.map(warning => warning.content), instructions],
          aggregatedIdentities: warnings.map(warning => ({ ...noticeIdentity(mission.id, warning.subjects, { noticeClass: 'budget', dedupKey: warning.key }).identity, contentDigest: createHash('sha256').update(warning.content).digest('hex') })) })
    })
  }

  blockBudget(mission: Mission): void {
    if (terminal(mission) || mission.status === 'blocked') return
    const dimensions = this.exhaustedDimensions(mission)
    mission.status = 'blocked'
    mission.reason = dimensions.length ? `Aggregate mission budget exhausted: ${dimensions.join(', ')}` : 'Aggregate mission budget exhausted'
    mission.budgetPause = { id: id('budget-pause'), quiesced: false }
    this.k.commit(mission.id, () => {
      this.k.store.put('missions', mission)
      for (const task of this.k.store.list('tasks', mission.id)) if (holdsOpenAttempt(task)) {
        task.budgetResume = { pauseId: mission.budgetPause!.id, attemptId: task.attempt.id }
        // S5: every task write is a compare-and-swap on the task's own revision.
        // These records were read inside this transaction, so the presented
        // revision is the durable one and the write is accepted; a record that
        // another accepted write moved past is refused instead of overwritten.
        this.k.store.putTask(task)
      }
      for (const member of this.k.store.list('members', mission.id)) { delete member.activity; this.k.store.put('members', member) }
      this.refusals.upsertBudgetRefusals(mission, mission.reason!)
      this.k.store.event(mission.id, 'mission/budget-exhausted', 'runtime', { tokens: mission.usedTokens, steps: mission.usedSteps, dimensions })
    })
    // S4b: the budget chain's terminal. The mission is durably blocked and the
    // in-flight attempts are preserved; the owner gets the shared coded decision
    // request (chain budget, exits swarm_budget/swarm_cancel/swarm_control)
    // instead of a prose-only reason. `emitGuardTerminal` proceeds for the
    // non-terminal `blocked` status (S4r-D5), which is exactly this state.
    // Co-firing guards: the budget guard fires with the attempt/lease chain (the
    // preserved attempts) and with the dispatch sweep (nothing new is admitted
    // while the pause holds).
    this.notices.emitGuardTerminal(mission.id, 'budget', { detail: mission.reason!, localKey: `budget-pause:${mission.budgetPause.id}` })
    this.beginBudgetStop(mission.id, mission.budgetPause.id)
  }

  /**
   * Stop outside the mission queue, which a cancelled in-flight tool may own.
   *
   * S5r: the gate is the DURABLE pause row. The claim (`budgetPause.stopping`)
   * is written before any await, so two concurrent callers cannot run the stop
   * twice and write a duplicate `mission/budget-quiesced` event. The claim is
   * bounded exactly like the pass guard: a foreign instance's claim, or one
   * older than `stallPassTimeoutMs`, is a crashed stop and does not gate.
   */
  beginBudgetStop(missionId: string, pauseId: string): void {
    if (this.k.shuttingDown) return
    const mission = this.k.store.get('missions', missionId)
    if (mission === undefined) return
    const pause = mission.budgetPause
    if (pause === undefined || pause.id !== pauseId || pause.quiesced) return
    const claim = pause.stopping
    if (claim !== undefined && claim.instanceId === this.k.instanceId && this.k.now() - claim.at < this.k.bounds.stallPassTimeoutMs) return
    // The durable claim lands BEFORE the first await, so it is the gate for any
    // later caller.
    pause.stopping = { instanceId: this.k.instanceId, at: this.k.now() }
    this.k.commit(missionId, () => this.k.store.put('missions', mission))
    this.k.defer(async () => {
      await Promise.all(this.k.store.list('members', missionId).map(member => this.k.workers.stop(member.id)))
      if (this.k.closed) return
      const current = this.k.mission(missionId)
      // Re-read after the await: the pause may have been resumed or already
      // quiesced by a concurrent stop; either way this claim writes nothing.
      if (current.budgetPause?.id !== pauseId || current.budgetPause.quiesced) return
      current.budgetPause.quiesced = true
      delete current.budgetPause.stopping
      this.k.commit(missionId, () => {
        this.k.store.put('missions', current)
        this.k.store.event(missionId, 'mission/budget-quiesced', 'runtime', { pauseId })
      })
      this.k.kick(missionId)
      await this.notices.flushOutbox(missionId)
    })
  }

  /** A fresh durable delivery wakes preserved attempts as soon as stop completes. */
  resumeBudgetTasks(mission: Mission): void {
    const pause = mission.budgetPause
    if (mission.status !== 'active' || !pause?.quiesced) return
    this.k.commit(mission.id, () => {
      for (const task of this.k.store.list('tasks', mission.id)) {
        // A marker leaves the row with the attempt it names, so the rows that
        // still hold the attempt their marker names are what this pause preserved.
        const resume = task.budgetResume
        if (resume?.pauseId !== pause.id || !holdsAttempt(task, mission.id, resume.attemptId)) continue
        delete task.budgetResume
        task.attempt.leaseUntil = Math.min(mission.deadline, this.k.now() + this.k.config.leaseMs)
        this.k.store.putTask(task)
        // The resumed attempt is what makes its owner `working`; the status is
        // derived from that on every read, so there is nothing to write here.
        for (const delivery of this.k.store.list('deliveries', mission.id)) {
          if (delivery.kind === 'assignment' && delivery.taskId === task.id && !delivery.deliveredAt) {
            delivery.deliveredAt = this.k.now(); this.k.store.put('deliveries', delivery)
          }
        }
        this.declaredChecks.deliverAssignment(task, 'Resume this same task and attempt after the primary agent adjusted the mission budget. The previous worker activity has fully stopped. Your previously recorded host tool-run IDs from this attempt remain valid. Inspect the saved workspace and evidence, continue unfinished work, and use this exact attemptId. Do not repeat completed effects or claim a new task.')
        this.k.store.event(mission.id, 'task/budget-resumed', 'runtime', { taskId: task.id, attemptId: task.attempt.id, pauseId: pause.id })
      }
      delete mission.budgetPause
      this.k.store.put('missions', mission)
    })
  }
}
