/**
 * Lease and attempt accounting: the durable attempt lifecycle (fence, renew,
 * drop, close out) and the pass's lease-expiry recovery sweep.
 *
 * M1a seam 1/7. Everything here is behaviour-identical to the code it was moved
 * from `src/runtime.ts`; the runtime keeps thin forwarding methods so no call
 * site changed. The runtime reference is typed as the class and imported
 * type-only, so no runtime import cycle exists.
 */
import { createHash, randomUUID } from 'node:crypto'
import { hasNotice } from './arena.ts'
import { taskSubject } from './notices.ts'
import { emitGuardTerminal } from './refusals.ts'
import { memberPhaseOf } from './projection.ts'
import { PolicyError } from './policy-error.ts'
import { awaited, type SchedulingPass } from './scheduling.ts'

/**
 * The detail a terminal message embeds. A guard's own message may already carry
 * a coded diagnostic (`[workspace_uncommitted] ...`); the terminal renders its
 * own stable code, so the nested token is stripped here rather than delivered as
 * a second, contradictory diagnostic. The durable event keeps the raw detail.
 * (The general helper belongs inside `guardTerminal` in src/refusals.ts, which
 * is outside this task's write scope: hand-off note in the submission.)
 */
const terminalDetail = (text: string): string => text.replace(/\[[a-z][a-z0-9_]{2,63}\]\s*/g, '').trim()
import type { SwarmRuntime } from './runtime.ts'
import type { Actor, Artifact, EvidenceStatus, Member, Mission, Task, WorkerActivity } from './types.ts'

const id = (prefix: string) => `${prefix}_${randomUUID()}`

/** Why a fenced task still owes a stop, as the durable marker records it. */
export type StopReason = NonNullable<Task['resumeAfterStop']>['reason']

/**
 * A fence this task still owes: a stop marker recorded at the task's OWN epoch.
 * A marker at an older epoch belongs to a fence a later epoch already replaced,
 * so it obliges nothing. This one comparison was written out at roughly twenty
 * call sites across the runtime, the attempt accounting, the scheduling pass and
 * the notices; naming it is what lets a reader see that they all ask the same
 * question rather than four similar ones.
 */
export function stopPending(task: Pick<Task, 'epoch' | 'resumeAfterStop'>): boolean {
  return task.resumeAfterStop?.epoch === task.epoch
}

/** A fenced handle must finish stopping before that member can own new work. */
export function pendingStopOwner(tasks: readonly Task[], memberId: string): boolean {
  return tasks.some(task => {
    if (!stopPending(task)) return false
    const marker = task.resumeAfterStop!
    if (marker.memberId !== undefined) return marker.memberId === memberId
    // An unresolved legacy owner is a conservative stop of every mission
    // handle; reserve every member until the complete scan confirms quiescence.
    return true
  })
}

/**
 * Why a task is, or on its next confirmed stop would be, blocked. A `blocked`
 * status has several causes that can hold together and clear independently (a
 * restart retires an obsolete finding ceiling while a preparation failure still
 * needs repair), so the set is derived from the task's own fields whenever a
 * reader asks, never stored as one discriminant.
 */
export type BlockCause = 'task-ceiling' | 'preparation-failed' | 'review-deferred' | 'needs-replacement' | 'refuted' | 'recovery-exhausted'

/**
 * The claims of the task's current attempt generation. A rework archives the
 * claims its rejection refuted in `rejections`: they stay refuted, but they no
 * longer block the task and no later submission or verdict touches them.
 */
export function currentEvidenceIds(task: Pick<Task, 'evidenceIds' | 'rejections'>): string[] {
  const archived = new Set(task.rejections?.flatMap(rejection => rejection.evidenceIds))
  return (task.evidenceIds ?? []).filter(evidenceId => !archived.has(evidenceId))
}

/**
 * The block causes holding for `task` now. `evidenceStatusOf` reads an evidence
 * row's current status; `defaultMaxRecoveryAttempts` is the limit of a task
 * without its own `maxRecoveryAttempts` (the runtime's `maxTasksPerMember`). A
 * preparation failure still inside its backoff retry is not a cause: that task
 * is pending and the host retries it.
 */
export function blockCauses(
  task: Pick<Task, 'status' | 'ceiling' | 'preparationFailure' | 'verificationRecovery' | 'artifact' | 'evidenceIds' | 'recoveryCount' | 'maxRecoveryAttempts' | 'rejections'>,
  evidenceStatusOf: (evidenceId: string) => EvidenceStatus | undefined,
  defaultMaxRecoveryAttempts: number,
): Set<BlockCause> {
  const causes = new Set<BlockCause>()
  if (task.ceiling !== undefined) causes.add('task-ceiling')
  if (task.preparationFailure !== undefined && task.preparationFailure.retryAt === undefined) causes.add('preparation-failed')
  if (task.verificationRecovery !== undefined) causes.add('review-deferred')
  // A rejected source, or submitted work invalidated after submission: its
  // artifact is immutable. Only an owner rework (a rejected non-experiment,
  // whose artifact then moves into history) or a replacement repairs it.
  if (task.status === 'blocked' && task.artifact !== undefined) causes.add('needs-replacement')
  if (currentEvidenceIds(task).some(evidenceId => evidenceStatusOf(evidenceId) === 'refuted')) causes.add('refuted')
  if ((task.recoveryCount ?? 0) >= (task.maxRecoveryAttempts ?? defaultMaxRecoveryAttempts)) causes.add('recovery-exhausted')
  return causes
}

/** Stops the host or the owner caused: the task's automatic recovery limit does not decide where they land. */
const recoveryLimitExempt = (reason: StopReason): boolean => reason === 'resource' || reason === 'handoff' || reason === 'invalidated'

/**
 * Where a confirmed stop lands, decided from the causes holding when the stop
 * is confirmed: blocked when the stop was an invalidation, or when any cause
 * holds other than a recovery limit this stop reason is exempt from.
 * `recoveryLimit` is true when the recovery limit is one of the deciding causes.
 */
export function stopOutcome(causes: ReadonlySet<BlockCause>, reason: StopReason): { blocked: boolean; recoveryLimit: boolean } {
  const recoveryLimit = causes.has('recovery-exhausted') && !recoveryLimitExempt(reason)
  return { blocked: reason === 'invalidated' || recoveryLimit || [...causes].some(cause => cause !== 'recovery-exhausted'), recoveryLimit }
}

/** W6: bounded idle close-outs before the workspace is checkpointed and re-pended. */
export const DEFAULT_IDLE_CLOSEOUTS = 2
/** Renewal allowance per model output token, so a long model call keeps its lease. */
export const LEASE_MS_PER_OUTPUT_TOKEN = 20
/**
 * F1: the declared bound on how long one in-flight operation may hold an
 * attempt without recording anything. Inside the bound an operation is
 * plausibly bounded (a long build, a declared check, one generation) and the
 * lease-renewal rule is right; past it "bounded" stops being plausible, so the
 * operation stops counting as liveness and the owner is told exactly which
 * member, task and tool went silent. Configuration, never a constant the
 * runtime is trapped behind: `operationBoundMs` on the runtime config, `0`
 * disables the guard, an invalid value keeps this default. The default matches
 * the longest wait this host itself treats as bounded (the harness's
 * `maxWaitTimeoutMs` of 600 s): one operation silently held past it is past the
 * point where "bounded" is still plausible, while an operation that declares a
 * longer bound of its own is judged by that bound instead.
 */
export const DEFAULT_OPERATION_BOUND_MS = 10 * 60_000
/** Read the declared bound; invalid configuration keeps the default rather than reverting to 0. */
export function declaredOperationBoundMs(config: { operationBoundMs?: unknown }): number {
  // The bound arrives on the runtime config. `RuntimeConfig` (src/types.ts) and
  // the plugin `Config` schema (src/index.ts) live outside this task's write
  // scope, so the read is structural and the two schema lines are recorded in
  // the submission as a hand-off: a runtime handed `operationBoundMs` uses it,
  // one without it uses the default above.
  const value = config.operationBoundMs
  if (value === 0) return 0
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_OPERATION_BOUND_MS
}
/** Human form of an elapsed bound for a notice; the raw milliseconds stay on the witness. */
function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
/** F1: one in-flight operation that has produced nothing beyond the declared bound. */
export interface SilentOperation {
  attemptId: string
  ownerId: string
  activityId: string
  kind: WorkerActivity['kind']
  tool?: string
  /** When the operation itself started. */
  startedAt: number
  /** Newest durable recording on this attempt, 0 when the attempt never recorded. */
  lastRecordedAt: number
  /** `max(startedAt, lastRecordedAt)`: the instant this silence began. */
  silentSince: number
  elapsedMs: number
  boundMs: number
}

export class Attempts {
  /**
   * S5 cache-only: the durable `Task.idleSignal` row carries the same value and
   * the scheduling pass re-reads it; losing this map changes no durable outcome.
   */
  readonly idleSignals = new Map<string, { attemptId: string; at: number }>()
  /** Retry timing is disposable; the fenced task row owns the recovery obligation. */
  private readonly stopRetries = new Map<string, { epoch: number; memberId?: string; retries: number; retryAt: number; inFlight: boolean }>()

  constructor(private readonly rt: SwarmRuntime) {}

  /** Stop outside the pass queue; only confirmed quiescence can re-pend this epoch. */
  resumeStoppedAttempt(missionId: string, task: Task, options: { force?: boolean } = {}): void {
    const marker = task.resumeAfterStop
    if (marker?.epoch !== task.epoch) return
    if (options.force && !this.stopRetries.get(task.id)?.inFlight) {
      delete marker.failure
      this.stopRetries.delete(task.id)
      this.rt.commit(missionId, () => this.rt.store.put('tasks', task))
    }
    if (marker.failure?.deterministic) {
      this.reportStopFailure(missionId, task)
      return
    }
    if (marker.memberId === undefined) {
      const eventType = marker.reason === 'handoff' ? 'task/handoff-started' : marker.reason === 'lease-expired' ? 'task/lease-expired' : 'task/closeout-abandoned'
      const event = this.rt.store.latestTaskEvent(missionId, task.id, eventType)
      const data = event?.data as { oldOwner?: string; ownerId?: string } | undefined
      const recorded = marker.reason === 'handoff' ? data?.oldOwner ?? (event?.actor === 'runtime' ? undefined : event?.actor) : marker.reason === 'lease-expired' ? data?.oldOwner : data?.ownerId
      const fallback = task.priorOwnerIds?.length === 1 ? task.priorOwnerIds[0] : marker.reason !== 'handoff' && !task.priorOwnerIds?.length ? task.assigneeId : undefined
      const memberId = task.attempt?.ownerId ?? recorded ?? fallback
      if (memberId !== undefined) {
        marker.memberId = memberId
        this.rt.commit(missionId, () => this.rt.store.put('tasks', task))
      } else {
        // A legacy handoff can have lost the identity of its old handle. A
        // bounded scan stops every candidate without guessing its new target.
        // Fence other live attempts first, preserving their own checkpoint debt.
        const peers = this.rt.store.list('tasks', missionId).filter(peer => peer.id !== task.id && peer.status === 'running' && peer.attempt !== undefined)
        const prior = this.rt.store.latestTaskEvent(missionId, task.id, 'mission/stalled')?.data as { cause?: string; epoch?: number } | undefined
        if (peers.length > 0 || prior?.cause !== 'stop-owner-unresolved' || prior.epoch !== task.epoch) this.rt.commit(missionId, () => {
          for (const peer of peers) {
            const oldOwner = peer.attempt!.ownerId
            peer.status = 'blocked'; peer.epoch++; this.dropAttempt(peer); delete peer.budgetResume
            peer.resumeAfterStop = { epoch: peer.epoch, memberId: oldOwner, reason: 'handoff', at: this.rt.now() }
            this.rt.store.put('tasks', peer)
            this.rt.store.event(missionId, 'task/handoff-started', 'runtime', { taskId: peer.id, oldOwner, reason: 'legacy stop owner recovery' })
          }
          this.rt.store.event(missionId, 'mission/stalled', 'runtime', { cause: 'stop-owner-unresolved', taskId: task.id, epoch: task.epoch, recovery: 'stop and checkpoint all recorded members' })
        })
      }
    }
    let retry = this.stopRetries.get(task.id)
    if (retry === undefined || retry.epoch !== task.epoch || retry.memberId !== marker.memberId) {
      retry = { epoch: task.epoch, memberId: marker.memberId, retries: 0, retryAt: 0, inFlight: false }
      this.stopRetries.set(task.id, retry)
    }
    if (retry.inFlight || retry.retryAt > this.rt.now()) return
    const state = retry
    state.inFlight = true
    this.rt.defer(async () => {
      let stopConfirmed = false
      try {
        const queued = this.rt.store.get('tasks', task.id)
        if (this.rt.shuttingDown || queued === undefined || queued.epoch !== state.epoch
          || queued.resumeAfterStop?.epoch !== state.epoch || queued.resumeAfterStop.memberId !== state.memberId) return
        const stoppedMember = state.memberId === undefined ? undefined : this.rt.store.get('members', state.memberId)
        const candidates = state.memberId === undefined ? this.rt.store.list('members', missionId) : stoppedMember === undefined ? [] : [stoppedMember]
        const ownerIds = state.memberId === undefined ? candidates.map(member => member.id) : [state.memberId]
        const results = await Promise.allSettled(ownerIds.map(memberId => this.rt.workers.stop(memberId)))
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        stopConfirmed = true
        if (this.rt.shuttingDown) return
        const stoppedTask = this.rt.task(missionId, task.id)
        if (stoppedTask.epoch !== state.epoch || stoppedTask.resumeAfterStop?.epoch !== state.epoch || stoppedTask.resumeAfterStop.memberId !== state.memberId) return
        if (candidates.length === 0) throw new Error(`The recorded stop owner is missing: ${state.memberId ?? 'this mission'} has no member row, so its workspace checkpoint can never be confirmed`)
        for (const candidate of candidates) await this.rt.workers.checkpointTask(candidate, stoppedTask, state.memberId === undefined ? { ifOwned: true } : undefined)
        await this.rt.exclusive(missionId, async () => {
          const mission = this.rt.mission(missionId)
          const fresh = this.rt.task(missionId, task.id)
          if (fresh.epoch !== state.epoch || fresh.resumeAfterStop?.epoch !== state.epoch || fresh.resumeAfterStop.memberId !== state.memberId) return
          const reason = fresh.resumeAfterStop.reason
          const causes = blockCauses(fresh, evidenceId => this.rt.store.get('evidence', evidenceId)?.status, this.rt.config.maxTasksPerMember)
          const { blocked: exhausted, recoveryLimit: recoveryExhausted } = stopOutcome(causes, reason)
          const released = ownerIds.map(memberId => this.rt.store.get('members', memberId)).filter((member): member is Member => member !== undefined)
          if (reason === 'worker-closeout' && state.memberId !== undefined && (released.length === 0 || released[0]!.status === 'stopped')) delete fresh.assigneeId
          if (fresh.status !== 'cancelled' && fresh.status !== 'accepted') fresh.status = exhausted ? 'blocked' : 'pending'
          delete fresh.resumeAfterStop
          this.rt.commit(missionId, () => {
            for (const member of released) if (memberPhaseOf(member) !== 'stopped') {
              // R20: the barrier no longer decides a member's phase. `parked` is
              // the member's own `swarm_wait` intent and nothing else, so there is
              // no host park left for this release to preserve or consume — the
              // step brake in `beforeStep` refuses a fenced handle's steps while
              // the barrier is in flight, which is the whole window the park used
              // to cover. A terminal mission still ends the membership here,
              // because that is the barrier's own decision, not a released flag.
              if (this.rt.isMissionTerminal(mission)) member.phase = 'stopped'
              this.rt.store.put('members', member)
            }
            this.rt.store.put('tasks', fresh)
            this.rt.store.event(missionId, reason === 'worker-closeout' ? (exhausted ? 'task/closeout-exhausted' : 'task/closeout-ready') : reason === 'handoff' ? 'task/handoff-ready' : 'task/quiescence-recovered', 'runtime', {
              taskId: fresh.id, ...(state.memberId === undefined ? { memberIds: ownerIds } : { memberId: state.memberId }), reason, retries: state.retries,
            })
          })
          if (recoveryExhausted && mission.status === 'active' && fresh.status !== 'cancelled') emitGuardTerminal(this.rt, missionId, 'attempt_lease', { taskId: fresh.id, memberId: state.memberId, detail: `${reason === 'lease-expired' ? 'lease expiry exhausted' : 'idle close-out reached'} the recovery limit (${fresh.recoveryCount ?? 0}/${fresh.maxRecoveryAttempts ?? this.rt.config.maxTasksPerMember}) and left the task blocked` })
        })
        if (this.stopRetries.get(task.id) === state) this.stopRetries.delete(task.id)
        if (state.memberId === undefined) for (const peer of this.rt.store.list('tasks', missionId)) if (peer.id !== task.id && stopPending(peer)) this.resumeStoppedAttempt(missionId, peer)
        if (this.rt.mission(missionId).status === 'active') this.rt.kick(missionId)
      } catch (error) {
        state.retries++
        state.retryAt = this.rt.now() + Math.min(30_000, 1000 * 2 ** Math.min(state.retries - 1, 5))
        if (this.rt.shuttingDown) return
        const fresh = this.rt.store.get('tasks', task.id)
        const mission = this.rt.store.get('missions', missionId)
        if (fresh === undefined || fresh.epoch !== state.epoch || fresh.resumeAfterStop?.epoch !== state.epoch || fresh.resumeAfterStop.memberId !== state.memberId || mission === undefined) return
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof Error && 'code' in error ? String(error.code) : ''
        const deterministic = stopConfirmed && (code === 'WORKSPACE_OWNERSHIP_CONFLICT'
          || /Cannot checkpoint a workspace owned by another task|recorded stop owner is missing/.test(message))
        const previousFailure = fresh.resumeAfterStop!.failure
        if (previousFailure?.message !== message || previousFailure.deterministic !== deterministic) {
          fresh.resumeAfterStop!.failure = { message, deterministic }
          this.rt.commit(missionId, () => {
            this.rt.store.put('tasks', fresh)
            this.rt.store.event(missionId, 'mission/stalled', 'runtime', { cause: 'worker-stop-failed', taskId: task.id, epoch: state.epoch,
              memberId: state.memberId, deterministic, ...(deterministic ? {} : { retryAt: state.retryAt }), reason: message })
          })
        }
        this.reportStopFailure(missionId, fresh)
      } finally { state.inFlight = false }
    })
  }

  private reportStopFailure(missionId: string, task: Task): void {
    const marker = task.resumeAfterStop
    if (!marker?.failure || this.rt.mission(missionId).status !== 'active') return
    const { message, deterministic } = marker.failure
    const digest = createHash('sha256').update(message).digest('hex')
    // No row can ever confirm a missing owner's checkpoint, so for it a resume only repeats the refusal.
    const exit = !deterministic ? 'The member remains fenced. The host will retry this temporary failure with bounded backoff.'
      : /recorded stop owner is missing/.test(message)
        ? `A resume only repeats this refusal. Withdraw the task with swarm_cancel (taskId "${task.id}"); if its work is still needed, propose its repair with swarm_propose naming replaces: ["${task.id}"].`
        : `The member remains fenced. Repair the recorded workspace condition, then retry cleanup with swarm_control(action: "resume", taskId: "${task.id}"); its cancelled or blocked outcome is preserved.`
    emitGuardTerminal(this.rt, missionId, 'attempt_lease', { taskId: task.id, memberId: marker.memberId,
      localKey: `stop:${task.id}:${marker.epoch}:${marker.memberId ?? 'unresolved'}:${digest}`,
      detail: `Stopping or preserving this attempt failed: ${message}. ${exit}` })
  }

  ownAttempt(actor: Actor, missionId: string, taskId: string, attemptId: string): { task: Task; member: Member } {
    const { member } = this.rt.active(actor, missionId)
    const task = this.rt.task(missionId, taskId)
    if (!member || task.status !== 'running' || !task.attempt || task.attempt.id !== attemptId || task.attempt.ownerId !== member.id || task.attempt.leaseUntil < this.rt.now()) throw new PolicyError('task_attempt_stale', 'authorization_error', 'Stale or unauthorized task attempt; stop work and observe the current assignment')
    if (!task.dependencies.every(dep => this.rt.dependencySatisfied(missionId, dep))) throw new PolicyError('task_prerequisite_revoked', 'tool_error', 'A task prerequisite is no longer accepted; stop work')
    return { task, member }
  }
  /**
   * Extend the current attempt's lease before a long host operation. Bounded by
   * the mission deadline so a stored lease can never outlive the mission.
   */
  fenceAttempt(mission: Mission, task: Task, windowMs: number): void {
    if (!task.attempt) throw new PolicyError('task_attempt_missing', 'lease_error', 'Task has no active attempt')
    const leaseUntil = Math.min(mission.deadline, this.rt.now() + Math.max(this.rt.config.leaseMs, windowMs))
    if (!Number.isSafeInteger(leaseUntil)) throw new PolicyError('attempt_lease_out_of_range', 'lease_error', 'Attempt lease exceeds the supported clock range')
    task.attempt.leaseUntil = leaseUntil
    this.rt.commit(mission.id, () => this.rt.store.put('tasks', task))
  }
  /**
   * X1 (P0): drop an attempt and remember its owner durably. Every path that
   * abandons an attempt without a verdict calls this, so the union below can
   * never forget a member who already touched the work.
   */
  dropAttempt(task: Task, ownerId?: string): void {
    const owner = ownerId ?? task.attempt?.ownerId
    if (owner !== undefined) task.priorOwnerIds = [...new Set([...(task.priorOwnerIds ?? []), owner])]
    delete task.attempt
  }
  /**
   * The one write that fences a running attempt, whatever decided to stop it.
   *
   * Stopping work in flight is five things that only mean anything together:
   * the epoch bump that invalidates the outstanding lease, the `dropAttempt`
   * that records the outgoing owner in `priorOwnerIds` (the basis of reviewer
   * independence), the attempt-scoped markers that describe an attempt which no
   * longer exists, the stop marker a live handle still owes, and one durable
   * closer event. Each control path used to assemble them by hand and they
   * disagreed: `fenceWorkspace` blocked a running task while leaving its attempt
   * and its handle alive, and mission pause/stop and challenge closed attempts
   * with no closer event at all, so the replay decoder refused logs this runtime
   * had just written.
   *
   * The caller keeps what is its own: its authorization check, its domain event,
   * its member updates and its asynchronous `resumeStoppedAttempt` poke.
   *
   * A marker already at the task's epoch means an earlier fence is still in
   * flight. That barrier keeps its epoch and its owner instead of being
   * abandoned and re-run, and it keeps its reason too — a `handoff` must not
   * downgrade a `resource` stop — except that `invalidated` replaces it, because
   * the barrier re-pends every other reason and invalidated work must stay
   * blocked.
   *
   * Call inside a mission transaction: the closer event and the caller's task
   * write are one durable transition.
   */
  fenceForStop(task: Task, options: { status: Task['status']; reason?: StopReason; cause: string }): { previousStatus: Task['status']; attempt: Task['attempt']; stopOwner: string | undefined } {
    const previousStatus = task.status
    const attempt = task.attempt
    const priorStop = stopPending(task) ? task.resumeAfterStop : undefined
    const reason = options.reason ?? 'handoff'
    // Submitted work may retain an author who now owns another task. Only an
    // active attempt or an existing stop marker can identify a handle to stop.
    const stopOwner = priorStop?.memberId ?? (previousStatus === 'running' ? attempt?.ownerId : undefined)
    task.status = options.status
    if (priorStop === undefined) task.epoch++
    this.dropAttempt(task)
    delete task.budgetResume; delete task.closeout; delete task.idleSignal; delete task.gitWriteDenied; delete task.leaseWarned
    if (priorStop === undefined) {
      if (stopOwner !== undefined) task.resumeAfterStop = { epoch: task.epoch, memberId: stopOwner, reason, at: this.rt.now() }
    } else if (reason === 'invalidated' && priorStop.reason !== 'invalidated') task.resumeAfterStop = { ...priorStop, reason }
    this.rt.store.event(task.missionId, 'attempt/fenced', 'runtime', { taskId: task.id, attemptId: attempt?.id ?? null, cause: options.cause })
    return { previousStatus, attempt, stopOwner }
  }
  /**
   * The live operation an attempt currently holds, or undefined when none is
   * live. This is the liveness rule renewal has always used: the durable member
   * activity is the record, and the adapter's current activity must confirm
   * that exact operation is still the live one.
   */
  private liveOperation(task: Task): WorkerActivity | undefined {
    const ownerId = task.attempt?.ownerId
    if (ownerId === undefined) return undefined
    const activity = this.rt.store.get('members', ownerId)?.activity
    if (activity === undefined) return undefined
    const observed = this.rt.workers.currentActivity(ownerId)
    return observed !== undefined && observed.id === activity.id ? activity : undefined
  }
  /**
   * F1: the bound that applies to one operation, i.e. the operations that
   * declare no end of their own and are exactly what F1 exists to bound: a model
   * stream and a tool call.
   *  - a retry is bounded by `retryAt`: nothing is recorded before the retry
   *    fires, so it cannot be silent while its own end is still ahead;
   *  - a declared check is NOT judged by this wall-clock bound at all. The
   *    adapter reports ONE `verification` activity for the whole call — the
   *    check-semaphore queue wait plus the check — and that activity exists
   *    precisely so a QUEUED attempt's lease stays alive, so the runtime cannot
   *    see where the queue ends and the check begins. The wait is bounded by
   *    other checks' own declared timeouts, never by anything this attempt
   *    declares, so any wall-clock bound here is a false positive waiting for a
   *    busy host (measured: a queued verification escalated 5.2 s before its own
   *    check could start, and a healthy 4.06 s check inside its declared 30 s
   *    task bound escalated at 2835 ms). The declared-check path is already
   *    bounded without this guard: the host kills every check at
   *    `task.checkTimeoutMs ?? config.checkTimeoutMs`, the semaphore drains
   *    FIFO, and the verification carries its own admitted ceiling
   *    (src/declared-checks.ts). The arithmetic is removed rather than made
   *    task-aware, because a long queue would still false-positive.
   * Returns undefined when no bound applies (guard disabled, or bounded ahead).
   */
  private operationBound(activity: WorkerActivity, declaredMs: number): number | undefined {
    if (declaredMs <= 0) return undefined
    if (activity.kind === 'retry' && activity.retryAt !== undefined && activity.retryAt > this.rt.now()) return undefined
    if (activity.kind === 'verification') return undefined
    return declaredMs
  }
  /**
   * F1: the declared-bound verdict for one attempt. Silent means an operation
   * is still in flight and nothing durable has been recorded on this attempt
   * since `silentSince`: the `tool_runs` rows are the recording, `0` when the
   * attempt never recorded. A recording mid-operation (a sibling tool
   * returning, a retry recorded) moves that instant forward, so an operation
   * that is still producing something cannot trip the bound.
   */
  silentOperation(task: Task, mission: Mission): SilentOperation | undefined {
    const attempt = task.attempt
    if (attempt === undefined) return undefined
    const activity = this.liveOperation(task)
    if (activity === undefined) return undefined
    // One operation belongs to the attempt it started under; an operation
    // recorded under a different attempt is not this task's stuck call.
    if (activity.attemptId !== undefined && activity.attemptId !== attempt.id) return undefined
    const boundMs = this.operationBound(activity, declaredOperationBoundMs(this.rt.config as { operationBoundMs?: unknown }))
    if (boundMs === undefined) return undefined
    const lastRecordedAt = this.rt.store.toolRuns(mission.id, { attemptId: attempt.id }).reduce((latest, run) => Math.max(latest, run.createdAt), 0)
    const silentSince = Math.max(activity.startedAt, lastRecordedAt)
    const elapsedMs = this.rt.now() - silentSince
    if (elapsedMs < boundMs) return undefined
    return {
      attemptId: attempt.id, ownerId: attempt.ownerId, activityId: activity.id, kind: activity.kind,
      ...(activity.tool === undefined ? {} : { tool: activity.tool }),
      startedAt: activity.startedAt, lastRecordedAt, silentSince, elapsedMs, boundMs,
    }
  }
  /**
   * F1: one durable witness plus one owner escalation per silent operation. The
   * dedup key is the operation identity and the instant its silence began, so an
   * unchanged stuck call never repeats, a recording that resumes progress
   * re-arms the clock, and a genuinely new silence warns again. This guard can
   * co-fire with the lease-expiry path (the operation stops being liveness, so
   * the existing recovery frees the attempt), the scheduling stall detector (an
   * in-flight operation is progress, so the board-level stall notice must stay
   * silent while this one names the stuck call) and the task-ceiling path (which
   * blocks the task and drops the attempt, after which no operation remains to
   * watch).
   */
  private escalateSilentOperation(mission: Mission, task: Task, silent: SilentOperation): void {
    const dedupKey = `operation-silent:${silent.attemptId}:${silent.activityId}:${silent.silentSince}`
    if (hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'stall', dedupKey, from: 'runtime' })) return
    const member = this.rt.store.get('members', silent.ownerId)
    const name = member === undefined ? silent.ownerId : `${member.name} (${member.id})`
    const what = silent.tool === undefined ? `a ${silent.kind} operation` : `a ${silent.kind} operation \`${silent.tool}\``
    const message = `${name} has held ${what} for ${formatElapsed(silent.elapsedMs)} (${silent.elapsedMs}ms) without recording anything, past its declared bound of ${formatElapsed(silent.boundMs)}: task ${task.id} "${task.title}", attempt ${silent.attemptId}. The operation no longer counts as liveness, so the lease is not renewed and the attempt expires into the existing recovery, which stops the worker and re-pends the task. Owner actions: inspect the stuck call with swarm_observe (taskId ${task.id}), raise operationBoundMs if the operation is genuinely long, or withdraw the work with swarm_cancel. [witness: activity ${silent.activityId}, kind ${silent.kind}${silent.tool === undefined ? '' : `, tool ${silent.tool}`}, attempt ${silent.attemptId}, startedAt ${silent.startedAt}, lastRecordedAt ${silent.lastRecordedAt}, elapsedMs ${silent.elapsedMs}, boundMs ${silent.boundMs}]`
    this.rt.commit(mission.id, () => {
      // The durable witness is the no-silent-state W2 row `notify` records on
      // the mission, together with the durable owner delivery itself — this
      // runtime's witness for an owner notice. A dedicated
      // `task/operation-silent` event type would need its own registry row in
      // src/events.ts, outside this task's write scope; that exact change is
      // named as a hand-off in the submission.
      // R15-A1: the silent operation names its own task. Guard pair: F1 operation
      // silence x lease expiry x the board-level stall — the subject is this task's
      // identity, so a healthy sibling's notices never consume the clock of this
      // one (they carry different subjects and different dedup keys).
      this.rt.notify(mission.id, message, [taskSubject(task)], { noticeClass: 'stall', dedupe: true, dedupKey })
    })
  }
  /**
   * Renew only a still-owned native operation, bounded by the owner's actual
   * mission deadline. `silent` is F1's verdict from the current pass: an
   * operation past its declared bound keeps every other property of a live
   * operation, but it is no longer plausible liveness, so the lease stops being
   * renewed and the existing expiry path — not a new kill switch — frees the
   * attempt. Inside the bound the rule is unchanged.
   */
  renewActiveOperation(task: Task, mission: Mission, silent = false): void {
    // S1 (P0): fence the renewal itself. The caller may hold a row read before
    // an earlier iteration's await; re-read and never extend a lease, clear a
    // warning or write a whole record over a row that moved epoch, status or
    // attempt (cancel, handoff, challenge, beforeStep, recordToolRun).
    const current = this.rt.store.get('tasks', task.id)
    if (current === undefined || current.missionId !== mission.id || current.epoch !== task.epoch
      || current.status !== 'running' || current.attempt?.id !== task.attempt?.id) return
    task = current
    if (!task.attempt || task.attempt.leaseUntil >= this.rt.now() + this.rt.config.leaseMs / 2) return
    // A live operation is liveness for its full duration: match by member and
    // activity id, never by the attempt the operation happens to be stored under.
    // The adapter must confirm the operation is live; a durable activity alone never renews.
    const activity = this.liveOperation(task)
    if (activity === undefined) {
      if (task.leaseWarned !== task.attempt.leaseUntil) {
        task.leaseWarned = task.attempt.leaseUntil
        this.rt.commit(mission.id, () => {
          this.rt.store.put('tasks', task)
          this.rt.store.event(mission.id, 'task/lease-expiring', 'runtime', { taskId: task.id, ownerId: task.attempt!.ownerId, leaseUntil: task.attempt!.leaseUntil })
        })
      }
      return
    }
    if (silent) return
    const member = this.rt.store.get('members', task.attempt.ownerId)
    const modelAllowance = activity.kind === 'model' ? (member?.maxOutputTokens ?? 0) : 0
    task.attempt.leaseUntil = Math.min(mission.deadline, this.rt.now() + this.rt.config.leaseMs + Math.ceil(modelAllowance * LEASE_MS_PER_OUTPUT_TOKEN))
    delete task.leaseWarned
    // A lease extension is liveness bookkeeping, not a new progress timestamp or milestone.
    this.rt.commit(mission.id, () => this.rt.store.put('tasks', task))
  }
  onIdle(memberId: string): void {
    if (this.rt.closed || this.rt.shuttingDown) return
    const member = this.rt.store.get('members', memberId)
    if (!member || member.status === 'stopped') return
    // W6: remember that this member ended a turn while still owning an attempt,
    // so scheduling can nudge it and, when the bounded retry is exhausted,
    // checkpoint the workspace before any reassignment.
    const open = this.rt.store.list('tasks', member.missionId).find(task => task.status === 'running' && task.attempt?.ownerId === memberId)
    if (open?.attempt) {
      this.idleSignals.set(memberId, { attemptId: open.attempt.id, at: this.rt.now() })
      // S5: the signal is durable on the task row the scheduling pass re-reads;
      // the map above is only a cache for a row write still in flight.
      open.idleSignal = { attemptId: open.attempt.id, at: this.rt.now() }
      this.rt.store.put('tasks', open)
    } else this.idleSignals.delete(memberId)
    // No member status is written: it is derived from the phase and the live
    // attempts on every read (src/projection.ts) and the store strips it.
    delete member.activity
    this.rt.commit(member.missionId, () => {
      this.rt.store.put('members', member)
      if (open?.attempt) this.rt.store.put('tasks', open)
    })
    this.rt.kick(member.missionId)
  }
  /**
   * W6: an idle worker still owns a running attempt. First re-wake it with a
   * bounded, durable nudge; when the bound is exhausted, capture the member
   * workspace as an immutable checkpoint, fence the attempt and re-pend the
   * task with the same member preferred so recovery resumes partial work.
   * `pass` is the dispatching body's record: its capture await is the body's own.
   */
  async closeOutIdleAttempt(mission: Mission, member: Member, task: Task, pass?: SchedulingPass): Promise<void> {
    const bound = this.rt.config.maxIdleCloseouts ?? DEFAULT_IDLE_CLOSEOUTS
    const nudges = task.closeout?.nudges ?? 0
    if (nudges < bound) {
      const nudge = nudges + 1
      const remaining = bound - nudge
      const attemptId = task.attempt!.id
      task.closeout = { nudges: nudge, at: this.rt.now() }
      this.rt.commit(mission.id, () => {
        this.rt.store.put('tasks', task)
        this.rt.store.put('deliveries', { id: id('msg'), missionId: mission.id, from: 'runtime', to: member.id, kind: 'control', createdAt: this.rt.now(),
          content: `Your attempt on "${task.title}" (${task.id}) is still open but your turn ended without a terminal call. Continue this exact attemptId ${attemptId} and finish it: submit with swarm_submit, release it with swarm_handoff, or park with swarm_wait. ${remaining === 0 ? 'The next idle close-out checkpoints your workspace and re-pends the task for recovery.' : `After ${remaining} more idle close-out${remaining === 1 ? '' : 's'} the runtime checkpoints your workspace and re-pends the task for recovery.`}` })
        this.rt.store.event(mission.id, 'task/closeout-nudged', 'runtime', { taskId: task.id, attemptId, ownerId: member.id, nudges: nudge })
      })
      return
    }
    let checkpoint: Artifact
    try { checkpoint = await awaited(pass, this.rt.workers.captureArtifact(member, task), this.rt.now) }
    catch (error) {
      const failed = this.rt.task(mission.id, task.id)
      if (failed.status !== 'running' || failed.attempt?.id !== task.attempt?.id) return
      failed.status = 'blocked'; failed.epoch++; this.dropAttempt(failed); delete failed.closeout; delete failed.idleSignal
      failed.resumeAfterStop = { epoch: failed.epoch, reason: 'invalidated', memberId: member.id, at: this.rt.now() }
      failed.output = `Worker ended its turn without submitting (${task.id}) and its workspace could not be checkpointed: ${error instanceof Error ? error.message : String(error)}. Inspect the member workspace before proposing a replacement.`
      this.rt.commit(mission.id, () => {
        this.rt.store.put('tasks', failed)
        this.rt.store.event(mission.id, 'task/closeout-failed', 'runtime', { taskId: failed.id, ownerId: member.id, reason: failed.output })
      })
      // S4b: the terminal element of the attempt/lease chain. The workspace
      // checkpoint guard (a dirty or unprovisioned worktree) and the close-out
      // guard co-fire here, so the owner gets the shared coded decision request
      // naming the task and the exits instead of a prose-only reason.
      emitGuardTerminal(this.rt, mission.id, 'attempt_lease', { taskId: failed.id, memberId: member.id, detail: terminalDetail(failed.output!) })
      this.resumeStoppedAttempt(mission.id, failed)
      return
    }
    const current = this.rt.task(mission.id, task.id)
    // The attempt may have finished while the checkpoint committed; never mutate terminal work.
    if (current.status !== 'running' || current.attempt?.id !== task.attempt?.id) return
    current.checkpoint = { commit: checkpoint.commit, at: this.rt.now() }
    current.status = 'blocked'; current.epoch++
    current.recoveryCount = (current.recoveryCount ?? 0) + 1
    this.dropAttempt(current); delete current.closeout; delete current.idleSignal
    // Prefer the same member: its next attempt resumes the checkpointed workspace
    // instead of a different member starting from the mission baseline.
    current.assigneeId = member.id
    current.plannedAssigneeId ??= member.id
    current.resumeAfterStop = { epoch: current.epoch, reason: 'worker-closeout', memberId: member.id, at: this.rt.now() }
    this.rt.commit(mission.id, () => {
      this.rt.store.put('tasks', current)
      this.rt.store.event(mission.id, 'task/closeout-abandoned', 'runtime', { taskId: current.id, ownerId: member.id, commit: checkpoint.commit, recoveryCount: current.recoveryCount })
    })
    // S4b (owner finding, measured: 7 of 8 silent): an abandoned close-out is a
    // stuck transition the owner was never told about. It emits the shared coded
    // escalation, naming the task and the attempt, while the durable checkpoint
    // event above keeps the audit trail. Co-firing guards: the attempt/lease
    // chain fires with the workspace capture guard that produced the checkpoint,
    // with the dispatch sweep that re-pends the task, and (when the recovery
    // limit is already spent) with the close-out exhaustion terminal below.
    emitGuardTerminal(this.rt, mission.id, 'attempt_lease', { taskId: current.id, memberId: member.id, detail: `idle close-out abandoned attempt ${task.attempt?.id ?? 'unknown'}: the workspace was checkpointed at ${checkpoint.commit} and the task was re-pended (recovery ${current.recoveryCount ?? 0})` })
    this.idleSignals.delete(member.id)
    this.resumeStoppedAttempt(mission.id, current)
  }

  /**
   * The pass's lease-expiry sweep, in the same order the serialized pass ran it
   * (M1a: moved out of `schedule` unchanged), plus F1's silent-operation guard:
   * each running attempt is judged against the declared bound before renewal, so
   * an operation that has stopped producing is named to the owner and stops
   * counting as liveness. Returns false when a shutdown was observed, so the
   * caller keeps the original "abandon the pass" control flow. `pass` is the
   * scheduling body's own record (`kick`); its capture await is the body's own.
   */
  async recoverExpired(mission: Mission, missionId: string, pass?: SchedulingPass): Promise<boolean> {
        // S1 (P0): iterate ids and re-read each row inside the loop. The loop awaits
        // external work (captureArtifact, stop), and cancel/challenge/handoff/
        // publish/beforeStep/recordToolRun commit directly during those awaits; a
        // pre-await snapshot must never be written back over a newer record.
        for (const listed of this.rt.store.list('tasks', missionId)) {
          if (this.rt.shuttingDown) return false
          let task = this.rt.store.get('tasks', listed.id)
          if (task !== undefined && stopPending(task)) {
            this.resumeStoppedAttempt(missionId, task)
            continue
          }
          this.stopRetries.delete(listed.id)
          if (task === undefined || task.missionId !== missionId || task.status !== 'running' || !task.attempt) continue
          const oldOwner = task.attempt.ownerId
          const attemptId = task.attempt.id
          // R10-15: a parked member holding a live attempt is a stall signal, not a
          // silent board. Record it durably and wake the owner once per attempt.
          const ownerMember = this.rt.store.get('members', oldOwner)
          const parked = ownerMember?.status === 'waiting'
          if (parked) this.rt.notifyParkedHolder(mission, task)
          // F1: an in-flight operation that has recorded nothing past its
          // declared bound is named to the owner once, and stops renewing the
          // lease so the existing expiry path can free the attempt.
          const silent = this.silentOperation(task, mission)
          if (silent !== undefined) this.escalateSilentOperation(mission, task, silent)
          this.renewActiveOperation(task, mission, silent !== undefined)
          // S1r: the renewal commits a re-read row, so the caller's snapshot can
          // still look expired after a successful renewal. Re-read again and use the
          // current row for every later comparison, or a live operation is renewed
          // and then expired in the same pass (the documented "a live operation is
          // liveness for its full duration" invariant).
          const renewed = this.rt.store.get('tasks', task.id)
          if (renewed === undefined || renewed.missionId !== missionId || renewed.epoch !== task.epoch
            || renewed.status !== 'running' || renewed.attempt?.id !== attemptId) continue
          task = renewed
          if (task.attempt === undefined || task.attempt.leaseUntil >= this.rt.now()) continue
          // W6: capture a durable checkpoint before any reassignment when the old
          // owner is quiescent, so the next attempt resumes committed work instead
          // of falling back to the mission baseline.
          if (this.rt.workers.isIdle(oldOwner)) {
            const owner = this.rt.store.get('members', oldOwner)
            if (owner !== undefined && owner.status !== 'stopped') {
              try {
                const checkpoint = await awaited(pass, this.rt.workers.captureArtifact(owner, task), this.rt.now)
                const current = this.rt.task(missionId, task.id)
                if (current.epoch === task.epoch && current.status === 'running' && current.attempt?.id === attemptId) {
                  // S1 (P0): commit the row re-read after the await, never the
                  // pre-await object, so a concurrent transition is not reverted.
                  current.checkpoint = { commit: checkpoint.commit, at: this.rt.now() }
                  this.rt.commit(missionId, () => { this.rt.store.put('tasks', current); this.rt.store.event(missionId, 'task/checkpointed', 'runtime', { taskId: current.id, commit: checkpoint.commit, reason: 'lease-expired' }) })
                }
              } catch (error) {
                // Auditable and non-fatal: the workspace stays untouched and
                // prepareTask refuses a dirty workspace rather than losing it.
                const current = this.rt.task(missionId, task.id)
                if (current.epoch === task.epoch && current.status === 'running' && current.attempt?.id === attemptId) {
                  const reason = `Lease-expiry checkpoint failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}. The member workspace is preserved; recovery will refuse a dirty workspace instead of losing it.`
                  this.rt.commit(missionId, () => {
                    this.rt.store.event(missionId, 'task/checkpoint-failed', 'runtime', { taskId: task.id, ownerId: oldOwner, reason })
                  })
                  // S4b: the lease-expiry checkpoint failure is the terminal of
                  // the attempt/lease chain for this attempt: the workspace guard
                  // refused the capture, so recovery will refuse a dirty
                  // workspace too. The coded decision request replaces the prose.
                  emitGuardTerminal(this.rt, missionId, 'attempt_lease', { taskId: task.id, memberId: oldOwner, detail: terminalDetail(reason) })
                }
              }
            }
          }
          // The checkpoint awaited external work. An owner cancel (or any other
          // fencing transition) committed during it must win over lease recovery:
          // re-read and only transition the record that still owns this attempt.
          const expiring = this.rt.task(missionId, task.id)
          if (expiring.epoch !== task.epoch || expiring.status !== 'running' || expiring.attempt?.id !== attemptId) continue
          // A lease that expired while the task was budget-paused is host policy, not
          // a recovery failure, and the plan's intended owner must survive it. A
          // lease that expired while its owner was parked is the same class of
          // host-induced stop (R10-15): the park, not the worker, caused the stall,
          // so it must not spend a recovery credit.
          const pauseInduced = expiring.budgetResume !== undefined || parked
          expiring.status = 'blocked'; expiring.epoch++
          if (!pauseInduced) expiring.recoveryCount = (expiring.recoveryCount ?? 0) + 1
          this.dropAttempt(expiring)
          const planned = expiring.plannedAssigneeId === undefined ? undefined : this.rt.store.get('members', expiring.plannedAssigneeId)
          if (planned !== undefined && planned.status !== 'stopped') expiring.assigneeId = planned.id
          else delete expiring.assigneeId
          expiring.resumeAfterStop = { epoch: expiring.epoch, reason: 'lease-expired', memberId: oldOwner, at: this.rt.now() }
          this.rt.commit(missionId, () => { this.rt.store.put('tasks', expiring); this.rt.store.event(missionId, 'task/lease-expired', 'runtime', { taskId: expiring.id, oldOwner }) })
          this.resumeStoppedAttempt(missionId, expiring)
        }
    return true
  }
}
