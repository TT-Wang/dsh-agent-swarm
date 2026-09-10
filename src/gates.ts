/**
 * Gates and caches: the mission fingerprint and its revision-keyed cache, the
 * owner/board instruments, and the usage accounting that gates a budget stop.
 * M1a seam 2/7.
 *
 * Behaviour-identical to the code moved from src/runtime.ts; the runtime keeps
 * thin forwarding methods and re-exports the symbols its public surface had.
 */
import { randomUUID, createHash } from 'node:crypto'
import { arenaView as projectArenaView } from './arena.ts'
import { excerpt } from './declared-checks.ts'
import { emitGuardTerminal } from './refusals.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { Actor, Budget, Delivery, Evidence, Member, Mission, Post, Task, UsageBuckets } from './types.ts'

export const USAGE_KEYS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'requests'] as const

export const emptyUsage = (): UsageBuckets => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 })

export function addUsage(base: UsageBuckets | undefined, delta: UsageBuckets): UsageBuckets {
  const result = { ...(base ?? emptyUsage()) }
  for (const key of USAGE_KEYS) result[key] += Math.max(0, delta[key])
  return result
}

/** Cumulative logs never shrink; a smaller bucket means a replayed snapshot and contributes nothing. */
export function usageDelta(next: UsageBuckets, previous: UsageBuckets | undefined): UsageBuckets {
  const result = emptyUsage()
  for (const key of USAGE_KEYS) result[key] = Math.max(0, next[key] - (previous?.[key] ?? 0))
  return result
}

export function validUsage(value: unknown): value is UsageBuckets {
  return value !== null && typeof value === 'object' && USAGE_KEYS.every(key => Number.isSafeInteger((value as Record<string, unknown>)[key]) && Number((value as Record<string, unknown>)[key]) >= 0)
}

/** The owner-observable board slice `missionFingerprint` digests (spec §4). */
export interface MissionFingerprintBoard {
  status: Mission['status']
  tasks: readonly MissionFingerprintTask[]
  members: ReadonlyArray<{ id: string; status: Member['status'] }>
  /** Undelivered worker outbox rows whose recipient can no longer receive them. */
  pendingDeliveries: number
  challengedEvidence: number
  /** Ceilings already hit: the budget pause id and each task's exhausted dimension. */
  ceilings: readonly string[]
}

/**
 * One task's owner-observable slice of the no-silent-state board. `ready` and
 * `unreviewed` are derived by the runtime from durable state (`ready()` and the
 * live review path); they are never supplied by a caller's claim.
 */
export interface MissionFingerprintTask {
  id: string
  status: Task['status']
  /** The attempt owner only; a planned assignee is not an observed owner. */
  attemptOwner?: string
  /** A pending task at least one idle or waiting member can run right now. */
  ready: boolean
  /** A submitted task no live independent review can accept. */
  unreviewed: boolean
}

/**
 * Stable digest `F(S)` of the owner-observable board (docs/no-silent-state-spec.md
 * §4). Every field is durable state; wall-clock fields are excluded by
 * construction, so an idle tick never changes the fingerprint and an unchanged
 * board cannot re-notify. Pure so a test can recompute it from the board.
 */
export function missionFingerprint(board: MissionFingerprintBoard): string {
  const order = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const tasks = [...board.tasks].sort(order).map(task => [task.id, task.status, task.attemptOwner ?? null, task.ready ? 1 : 0, task.unreviewed ? 1 : 0])
  const members = [...board.members].sort(order).map(member => [member.id, member.status])
  const canonical = JSON.stringify({
    status: board.status,
    tasks,
    ready: board.tasks.filter(task => task.ready).length,
    notReady: board.tasks.filter(task => task.status === 'pending' && !task.ready).length,
    unreviewed: board.tasks.filter(task => task.unreviewed).length,
    members,
    pendingDeliveries: board.pendingDeliveries,
    challengedEvidence: board.challengedEvidence,
    ceilings: [...board.ceilings].sort(),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/** Observe shows only the newest few new posts; the board tool pages the rest. */
export const BOARD_DELTA_POSTS = 3

/** Extra lease headroom per allowed output token while a model stream is observably live. */
export const DEFAULT_BUDGET_WARN_AT: readonly number[] = [0.7, 0.9]

/**
 * Bounded board projection. `full` is used only by the single-post read; every
 * page carries an excerpt and says how many characters were withheld, so a
 * board page can never flood a model context. TTL expiry is reported, never
 * enforced by mutating the post.
 */
export function postView(post: Post, full = false): Record<string, unknown> {
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
    ...(post.ttlMs === undefined ? {} : { ttlMs: post.ttlMs, expiresAt: post.createdAt + post.ttlMs, expired: Date.now() >= post.createdAt + post.ttlMs }),
  }
}

/** A board page shows a bounded body excerpt; the full body is read by postId. */
export const BOARD_BODY_EXCERPT = 600

const id = (prefix: string) => `${prefix}_${randomUUID()}`

export class RuntimeGates {
  /** F(S) cache keyed by the store revision: the digest is pure over durable state. */
  readonly fingerprintCache = new Map<string, { revision: number; fingerprint: string }>()
  readonly budgetStops = new Set<string>()

  constructor(private readonly rt: SwarmRuntime) {}

  /** Current `F(S)`; the dedup key every owner notice and stall notice is emitted under. */
  fingerprint(missionId: string): string {
    // Cache per store revision: F(S) is pure over durable state, so a tick that
    // changed nothing cannot change it, and the scheduler's per-tick witness
    // check stays cheap under a large board. Never trust the cache inside an open
    // transaction: the revision has not advanced yet while the board is mutating.
    if (this.rt.commitDepth > 0) return missionFingerprint(this.fingerprintBoard(missionId))
    const revision = this.rt.store.revision()
    const cached = this.fingerprintCache.get(missionId)
    if (cached !== undefined && cached.revision === revision) return cached.fingerprint
    const fingerprint = missionFingerprint(this.fingerprintBoard(missionId))
    this.fingerprintCache.set(missionId, { revision, fingerprint })
    return fingerprint
  }

  fingerprintRecords(missionId: string): { mission: Mission; tasks: Task[]; members: Member[]; evidence: Evidence[]; deliveries: Delivery[] } {
    return {
      mission: this.rt.mission(missionId),
      tasks: this.rt.store.list('tasks', missionId),
      members: this.rt.store.list('members', missionId),
      evidence: this.rt.store.list('evidence', missionId),
      deliveries: this.rt.store.list('deliveries', missionId),
    }
  }

  /**
   * The owner-observable fingerprint board built from durable state only. The
   * readiness/review counts come from the same predicates the scheduler and the
   * completion check use, so the digest cannot disagree with the board.
   */
  fingerprintBoard(missionId: string): MissionFingerprintBoard {
    const mission = this.rt.mission(missionId)
    const tasks = this.rt.store.list('tasks', missionId)
    const members = this.rt.store.list('members', missionId)
    // Spec §2: dispatchable means a pending task at least one member whose
    // status is idle or waiting can run. A working member is already busy.
    const runnable = members.filter(member => member.status === 'idle' || member.status === 'waiting')
    const ready = new Set(tasks.filter(task => task.status === 'pending' && runnable.some(member => this.rt.ready(task, member, tasks))).map(task => task.id))
    const unreviewed = new Set(tasks.filter(task => task.status === 'submitted' && !this.rt.reviewable(task, tasks)).map(task => task.id))
    return {
      status: mission.status,
      tasks: tasks.map(task => ({ id: task.id, status: task.status,
        ...(task.attempt?.ownerId === undefined ? {} : { attemptOwner: task.attempt.ownerId }),
        ready: ready.has(task.id), unreviewed: unreviewed.has(task.id) })),
      members: members.map(member => ({ id: member.id, status: member.status })),
      // Owner-observable outbox backlog only: a delivery to a live member is the
      // wake channel and is flushed in the same scheduling pass, and the owner
      // notice being emitted is the witness for this state. Counting either
      // would make every notice change the fingerprint it was keyed by.
      pendingDeliveries: this.rt.store.list('deliveries', missionId).filter(delivery => delivery.deliveredAt === undefined
        && delivery.to !== 'owner'
        && !members.some(member => member.id === delivery.to && member.status !== 'stopped')).length,
      challengedEvidence: this.rt.store.list('evidence', missionId).filter(evidence => evidence.status === 'challenged').length,
      ceilings: [
        ...(mission.budgetPause === undefined ? [] : [`budget:${mission.budgetPause.id}`]),
        ...tasks.filter(task => task.ceiling !== undefined).map(task => `task:${task.id}:${task.ceiling!.dimension}`),
      ],
    }
  }

  /**
   * Read-only owner instruments (docs/no-silent-state-spec.md §6): the current
   * no-silent-state fingerprint `F(S)`, the last witness class and time, the
   * pending-dispatchable count, the notice-delivery ledger and durable
   * escalations. `full` adds the per-member arena rows and the ledger page; the
   * compact form keeps the owner's routine observe response small. A pure
   * projection of durable records; it writes nothing.
   */
  ownerInstruments(missionId: string, full: boolean): Record<string, unknown> {
    const records = this.fingerprintRecords(missionId)
    const view = projectArenaView({ ...records, missionId, now: Date.now(), leaseMs: this.rt.config.leaseMs })
    const counts = { sent: view.notices.length, queued: view.notices.filter(entry => entry.state === 'queued').length, claimed: view.notices.filter(entry => entry.state === 'claimed').length }
    return {
      // T3d: the owner-visible fingerprint is the no-silent-state F(S) the
      // witness record and F19 use, never the arena ledger's dedup digest.
      fingerprint: this.fingerprint(missionId),
      noticeDedupKey: this.rt.noticeKey(missionId),
      pendingDispatchable: view.pendingDispatchable,
      ...(view.lastNotice === undefined ? {} : { lastWitness: view.lastNotice }),
      notices: counts,
      ...(full ? { noticeLedger: view.notices, escalations: view.escalations, arena: { missionId: view.missionId, status: view.status, members: view.members } } : {}),
      note: 'Read-only arena instruments: fingerprint, last witness, pending dispatchable tasks, notice counts' + (full ? ', the notice-delivery ledger, escalations and per-member presence/activity/attempt age/pending dependencies' : '') + '. Reading them changes no state.',
    }
  }

  /**
   * Bounded board window for observe: counts plus the newest few posts after
   * the member's delivered cursor. Older unseen posts are counted and named as
   * omitted rather than re-sent; `swarm_board` pages them with an explicit
   * cursor, so nothing is lost and no delta grows without bound.
   */
  boardWindow(missionId: string, memberId: string, afterSeq: number): Record<string, unknown> {
    const count = this.rt.store.countPosts(missionId, { afterSeq })
    const newest = this.rt.store.posts(missionId, { afterSeq, newest: true, limit: BOARD_DELTA_POSTS })
    return {
      count,
      addressed: this.rt.store.countPosts(missionId, { inboxFor: memberId, afterSeq }),
      newest: newest.map(post => postView(post)),
      ...(count > newest.length ? { omitted: count - newest.length } : {}),
      ...(newest.length ? { nextAfter: newest.at(-1)!.seq } : {}),
    }
  }

  async usage(memberId: string, tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens < 0 || this.rt.closed) return
    const member = this.rt.store.get('members', memberId)
    if (!member) return
    const mission = this.rt.mission(member.missionId)
    mission.usedTokens += Math.ceil(tokens)
    this.rt.commit(mission.id, () => { this.rt.store.put('missions', mission) })
    this.warnBudget(mission)
    if (mission.usedTokens >= mission.budget.maxTokens) this.blockBudget(mission)
  }

  /** Reconcile durable Harness usage cumulatively, including after a crash before SQLite accounting. */
  async usageSnapshot(memberId: string, totalTokens: number, usage?: UsageBuckets): Promise<void> {
    if (this.rt.closed) return
    if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) throw new Error('Invalid authoritative usage snapshot')
    if (usage !== undefined && !validUsage(usage)) throw new Error('Invalid usage buckets')
    const member = this.rt.store.get('members', memberId)
    if (!member) throw new Error('Unknown worker in usage accounting')
    const mission = this.rt.mission(member.missionId)
    const previouslyAccounted = member.accountedTokens ?? 0
    const bucketDelta = usage === undefined ? undefined : usageDelta(usage, member.usage)
    if (totalTokens <= previouslyAccounted && (bucketDelta === undefined || USAGE_KEYS.every(key => bucketDelta[key] === 0))) return
    member.accountedTokens = Math.max(previouslyAccounted, totalTokens)
    mission.usedTokens += Math.max(0, totalTokens - previouslyAccounted)
    if (bucketDelta !== undefined) { member.usage = usage; mission.workerUsage = addUsage(mission.workerUsage, bucketDelta) }
    this.rt.commit(mission.id, () => { this.rt.store.put('members', member); this.rt.store.put('missions', mission) })
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
    if (this.rt.closed || this.rt.shuttingDown || !validUsage(usage) || this.rt.isWorkerSession(sessionId)) return
    const mission = this.rt.store.list('missions').filter(item => item.ownerSessionId === sessionId && !this.rt.isMissionTerminal(item)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (mission) {
      mission.ownerUsage = addUsage(mission.ownerUsage, usage); mission.updatedAt = Date.now()
      this.rt.commit(mission.id, () => this.rt.store.put('missions', mission))
      return
    }
    const request = this.rt.store.list('starts').filter(item => item.ownerSessionId === sessionId && (item.status === 'planning' || item.status === 'launching')).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!request) return
    request.ownerUsage = addUsage(request.ownerUsage, usage); request.updatedAt = Date.now()
    this.rt.commit(request.id, () => this.rt.store.put('starts', request))
  }

  /** Budget dimensions that are currently exhausted; used by the pause reason and event. */
  exhaustedDimensions(mission: Mission): string[] {
    const dimensions: string[] = []
    if (mission.usedTokens >= mission.budget.maxTokens) dimensions.push('maxTokens')
    if (mission.usedSteps >= mission.budget.maxSteps) dimensions.push('maxSteps')
    if (Date.now() >= mission.deadline) dimensions.push('maxDurationMs')
    return dimensions
  }

  /**
   * Emit at most one approaching-limit warning per dimension per threshold. The
   * first signal is an event, not a fatal pause; thresholds default to 0.7/0.9.
   */
  warnBudget(mission: Mission): void {
    if (mission.status !== 'active' || mission.budgetPause) return
    const thresholds = [...(this.rt.config.budgetWarnAt ?? DEFAULT_BUDGET_WARN_AT)]
      .filter(value => Number.isFinite(value) && value > 0 && value < 1).sort((a, b) => a - b)
    if (!thresholds.length) return
    const dimensions: Array<{ dimension: string; used: number; limit: number }> = [
      { dimension: 'maxTokens', used: mission.usedTokens, limit: mission.budget.maxTokens },
      { dimension: 'maxSteps', used: mission.usedSteps, limit: mission.budget.maxSteps },
      { dimension: 'maxDurationMs', used: Math.max(0, Date.now() - mission.createdAt), limit: mission.budget.maxDurationMs },
    ]
    let changed = false
    for (const item of dimensions) {
      if (!(item.limit > 0)) continue
      const crossed = thresholds.filter(threshold => item.used / item.limit >= threshold).at(-1)
      if (crossed === undefined || crossed <= (mission.budgetWarned?.[item.dimension] ?? 0)) continue
      mission.budgetWarned = { ...(mission.budgetWarned ?? {}), [item.dimension]: crossed }
      changed = true
      // F11: the division can land one ulp above an exact ceiling (700 / 0.7 is
      // 1000.0000000000001), so Math.ceil alone suggests 1001. Round the ratio to
      // six decimals first; the suggestion stays the smallest integer limit that
      // holds the dimension at or below the crossed threshold.
      const suggestedLimit = Math.ceil(Number((item.used / crossed).toFixed(6)))
      this.rt.store.event(mission.id, 'mission/budget-warning', 'runtime', { dimension: item.dimension, threshold: crossed, used: item.used, limit: item.limit,
        remaining: Math.max(0, item.limit - item.used), suggestedLimit })
    }
    if (changed) this.rt.commit(mission.id, () => this.rt.store.put('missions', mission))
  }

  blockBudget(mission: Mission): void {
    if (this.rt.isMissionTerminal(mission) || mission.status === 'blocked') return
    const dimensions = this.exhaustedDimensions(mission)
    mission.status = 'blocked'
    mission.reason = dimensions.length ? `Aggregate mission budget exhausted: ${dimensions.join(', ')}` : 'Aggregate mission budget exhausted'
    mission.budgetPause = { id: id('budget-pause'), quiesced: false }
    this.rt.commit(mission.id, () => {
      this.rt.store.put('missions', mission)
      for (const task of this.rt.store.list('tasks', mission.id)) if (task.status === 'running' && task.attempt) {
        task.budgetResume = { pauseId: mission.budgetPause!.id, attemptId: task.attempt.id, epoch: task.epoch }
        // S5: every task write is a compare-and-swap on the task's own revision.
        // These records were read inside this transaction, so the presented
        // revision is the durable one and the write is accepted; a record that
        // another accepted write moved past is refused instead of overwritten.
        this.rt.store.putTask(task)
      }
      for (const member of this.rt.store.list('members', mission.id)) { delete member.activity; this.rt.store.put('members', member) }
      this.rt.upsertBudgetRefusals(mission, mission.reason!)
      this.rt.store.event(mission.id, 'mission/budget-exhausted', 'runtime', { tokens: mission.usedTokens, steps: mission.usedSteps, dimensions })
    })
    // S4b: the budget chain's terminal. The mission is durably blocked and the
    // in-flight attempts are preserved; the owner gets the shared coded decision
    // request (chain budget, exits swarm_budget/swarm_cancel/swarm_control)
    // instead of a prose-only reason. `emitGuardTerminal` proceeds for the
    // non-terminal `blocked` status (S4r-D5), which is exactly this state.
    // Co-firing guards: the budget guard fires with the attempt/lease chain (the
    // preserved attempts) and with the dispatch sweep (nothing new is admitted
    // while the pause holds).
    emitGuardTerminal(this.rt, mission.id, 'budget', { detail: mission.reason! })
    this.beginBudgetStop(mission.id, mission.budgetPause.id)
  }

  /**
   * Stop outside the mission queue, which a cancelled in-flight tool may own.
   *
   * S5r: the gate is the DURABLE pause row, never the in-memory `budgetStops`
   * Set. The claim (`budgetPause.stopping`) is written before any await, so two
   * concurrent callers — or the same caller after the Set was lost — cannot run
   * the stop twice and write a duplicate `mission/budget-quiesced` event. The
   * claim is bounded exactly like the pass guard: a foreign instance's claim, or
   * one older than `stallPassTimeoutMs`, is a crashed stop and does not gate.
   * `budgetStops` stays only as the public mirror `SwarmRuntime.budgetStops`
   * names for the gate census; it is never read to decide anything.
   */
  beginBudgetStop(missionId: string, pauseId: string): void {
    if (this.rt.shuttingDown) return
    const mission = this.rt.store.get('missions', missionId)
    if (mission === undefined) return
    const pause = mission.budgetPause
    if (pause === undefined || pause.id !== pauseId || pause.quiesced) return
    const claim = pause.stopping
    if (claim !== undefined && claim.instanceId === this.rt.instanceId && Date.now() - claim.at < this.rt.stallPassTimeoutMs) return
    // The durable claim lands BEFORE the first await, so it is the gate for any
    // later caller, whether or not this process still holds the mirror entry.
    pause.stopping = { instanceId: this.rt.instanceId, at: Date.now() }
    this.rt.commit(missionId, () => this.rt.store.put('missions', mission))
    this.budgetStops.add(pauseId)
    this.rt.defer(async () => {
      try {
        await Promise.all(this.rt.store.list('members', missionId).map(member => this.rt.workers.stop(member.id)))
        if (this.rt.closed) return
        const current = this.rt.mission(missionId)
        // Re-read after the await: the pause may have been resumed or already
        // quiesced by a concurrent stop; either way this claim writes nothing.
        if (current.budgetPause?.id !== pauseId || current.budgetPause.quiesced) return
        current.budgetPause.quiesced = true
        delete current.budgetPause.stopping
        this.rt.commit(missionId, () => {
          this.rt.store.put('missions', current)
          this.rt.store.event(missionId, 'mission/budget-quiesced', 'runtime', { pauseId })
        })
        this.rt.kick(missionId)
        await this.rt.flushOutbox(missionId)
      } finally { this.budgetStops.delete(pauseId) }
    })
  }

  /** A fresh durable delivery wakes preserved attempts as soon as stop completes. */
  resumeBudgetTasks(mission: Mission): void {
    const pause = mission.budgetPause
    if (mission.status !== 'active' || !pause?.quiesced) return
    this.rt.commit(mission.id, () => {
      for (const task of this.rt.store.list('tasks', mission.id)) {
        const resume = task.budgetResume
        if (!resume || resume.pauseId !== pause.id) continue
        delete task.budgetResume
        if (task.status !== 'running' || !task.attempt || task.attempt.id !== resume.attemptId || task.epoch !== resume.epoch) {
          // The pause marker outlived its attempt (challenge, handoff or restart):
          // re-pend the work without charging a recovery attempt.
          if (task.status === 'running') { task.status = 'pending'; this.rt.dropAttempt(task) }
          // S5: compare-and-swap on the task's own revision (see blockBudget).
          this.rt.store.putTask(task)
          this.rt.store.event(mission.id, 'task/budget-resume-skipped', 'runtime', { taskId: task.id, pauseId: pause.id })
          continue
        }
        task.attempt.leaseUntil = Math.min(mission.deadline, Date.now() + this.rt.config.leaseMs)
        this.rt.store.putTask(task)
        const member = this.rt.store.get('members', task.attempt.ownerId)
        if (member && member.status !== 'stopped') { member.status = 'working'; this.rt.store.put('members', member) }
        for (const delivery of this.rt.store.list('deliveries', mission.id)) {
          if (delivery.kind === 'assignment' && delivery.taskId === task.id && !delivery.deliveredAt) {
            delivery.deliveredAt = Date.now(); this.rt.store.put('deliveries', delivery)
          }
        }
        this.rt.store.put('deliveries', { id: id('msg'), missionId: mission.id, from: 'runtime', to: task.attempt.ownerId, kind: 'assignment',
          taskId: task.id, attemptId: task.attempt.id, createdAt: Date.now(),
          content: JSON.stringify({ missionId: mission.id, task, instructions: 'Resume this same task and attempt after the primary agent adjusted the mission budget. The previous worker activity has fully stopped. Your previously recorded host tool-run IDs from this attempt remain valid. Inspect the saved workspace and evidence, continue unfinished work, and use this exact attemptId. Do not repeat completed effects or claim a new task.' }) })
        this.rt.store.event(mission.id, 'task/budget-resumed', 'runtime', { taskId: task.id, attemptId: task.attempt.id, pauseId: pause.id })
      }
      delete mission.budgetPause
      this.rt.store.put('missions', mission)
    })
  }
}
