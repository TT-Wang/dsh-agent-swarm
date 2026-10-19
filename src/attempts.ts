/**
 * Lease and attempt accounting: the durable attempt lifecycle (fence, renew,
 * drop, close out) and the pass's lease-expiry recovery sweep. The seam stands
 * on the kernel and on the notices it tells the owner through. Whether a worker
 * tool call owns the attempt it names is the runtime's tool authorization
 * (`SwarmRuntime.ownAttempt`), not lease accounting.
 */
import { id } from './store.ts'
import { TERMINAL_STATES, blockCauses, holdsAttempt, holdsOpenAttempt, openAttempt, stopPending, taskSubject, terminal, type BlockCause, type HeldTask } from './task-graph.ts'
import { parkedHolder, stopFaultKey, type Notices } from './notices.ts'
import { heldByParkedMember } from './board.ts'
import { memberPhaseOf } from './projection.ts'
import { PolicyError } from './policy-error.ts'
import { awaited, formatSpan, type Kernel, type SchedulingPass } from './kernel.ts'
import type { Artifact, Member, Mission, Task, WorkerActivity } from './types.ts'

/**
 * The detail a terminal message embeds. A guard's own message may already carry
 * a coded diagnostic (`[workspace_uncommitted] ...`); the terminal renders its
 * own stable code, so the nested token is stripped here rather than delivered as
 * a second, contradictory diagnostic. The durable event keeps the raw detail.
 * (The general helper belongs inside `guardTerminal` in src/refusals.ts, which
 * is outside this task's write scope: hand-off note in the submission.)
 */
const terminalDetail = (text: string): string => text.replace(/\[[a-z][a-z0-9_]{2,63}\]\s*/g, '').trim()

/** Why a fenced task still owes a stop, as the durable marker records it. */
type StopReason = NonNullable<Task['resumeAfterStop']>['reason']

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

/**
 * X1 (P0): take the attempt off the row, and with it every fact it recorded
 * while it ran (they are its fields, `Attempt`), and remember its owner
 * durably, so the union below can never forget a member who already touched
 * the work. Only the two operations that end an attempt, `endAttempt` and
 * `Attempts.fenceRow`, call it.
 */
function dropAttempt(task: Task): void {
  const owner = task.attempt?.ownerId
  if (owner !== undefined) task.priorOwnerIds = [...new Set([...(task.priorOwnerIds ?? []), owner])]
  delete task.attempt
}

/**
 * End the row's attempt when no handle owes a stop for it: the epoch bump
 * fences its lease and every write it could still present. A host restart
 * re-pending running work (the old process is gone), a rework re-opening a
 * rejected task or its review (their handles finished with the submission and
 * the verdict), and a worker start that failed end an attempt this way. An
 * attempt a handle may still be running is fenced instead (`Attempts.fenceForStop`).
 */
export function endAttempt(task: Task): void {
  task.epoch++
  dropAttempt(task)
}

/** W6: bounded idle close-outs before the workspace is checkpointed and re-pended. */
const DEFAULT_IDLE_CLOSEOUTS = 2
/** Renewal allowance per model output token, so a long model call keeps its lease. */
const LEASE_MS_PER_OUTPUT_TOKEN = 20
/** F1: one in-flight operation that has produced nothing beyond the declared bound. */
interface SilentOperation {
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
  /** Retry timing is disposable; the fenced task row owns the recovery obligation. */
  private readonly stopRetries = new Map<string, { epoch: number; memberId?: string; retries: number; retryAt: number; inFlight: boolean }>()

  constructor(private readonly k: Kernel, private readonly notices: Notices) {}

  /** Stop outside the pass queue; only confirmed quiescence can re-pend this epoch. */
  resumeStoppedAttempt(missionId: string, task: Task, options: { force?: boolean } = {}): void {
    if (!stopPending(task)) return
    const marker = task.resumeAfterStop
    if (options.force && !this.stopRetries.get(task.id)?.inFlight) {
      delete marker.failure
      this.stopRetries.delete(task.id)
      this.k.commit(missionId, () => this.k.store.put('tasks', task))
    }
    if (marker.failure?.deterministic) {
      this.reportStopFailure(missionId, task)
      return
    }
    if (marker.memberId === undefined) {
      const eventType = marker.reason === 'handoff' ? 'task/handoff-started' : marker.reason === 'lease-expired' ? 'task/lease-expired' : 'task/closeout-abandoned'
      const event = this.k.store.latestTaskEvent(missionId, task.id, eventType)
      const data = event?.data as { oldOwner?: string; ownerId?: string } | undefined
      const recorded = marker.reason === 'handoff' ? data?.oldOwner ?? (event?.actor === 'runtime' ? undefined : event?.actor) : marker.reason === 'lease-expired' ? data?.oldOwner : data?.ownerId
      const fallback = task.priorOwnerIds?.length === 1 ? task.priorOwnerIds[0] : marker.reason !== 'handoff' && !task.priorOwnerIds?.length ? task.assigneeId : undefined
      const memberId = task.attempt?.ownerId ?? recorded ?? fallback
      if (memberId !== undefined) {
        marker.memberId = memberId
        this.k.commit(missionId, () => this.k.store.put('tasks', task))
      } else {
        // A legacy handoff can have lost the identity of its old handle. A
        // bounded scan stops every candidate without guessing its new target.
        // Fence other live attempts first, preserving their own checkpoint debt.
        const peers = this.k.store.list('tasks', missionId).filter(holdsOpenAttempt).filter(peer => peer.id !== task.id)
        const prior = this.k.store.latestTaskEvent(missionId, task.id, 'mission/stalled')?.data as { cause?: string; epoch?: number } | undefined
        if (peers.length > 0 || prior?.cause !== 'stop-owner-unresolved' || prior.epoch !== task.epoch) this.k.commit(missionId, () => {
          for (const peer of peers) {
            const oldOwner = peer.attempt.ownerId
            this.fenceForStop(peer, { status: 'blocked', reason: 'handoff', cause: 'stop-owner-unresolved' })
            this.k.store.put('tasks', peer)
            this.k.store.event(missionId, 'task/handoff-started', 'runtime', { taskId: peer.id, oldOwner, reason: 'legacy stop owner recovery' })
          }
          this.k.store.event(missionId, 'mission/stalled', 'runtime', { cause: 'stop-owner-unresolved', taskId: task.id, epoch: task.epoch, recovery: 'stop and checkpoint all recorded members' })
        })
      }
    }
    let retry = this.stopRetries.get(task.id)
    if (retry === undefined || retry.epoch !== task.epoch || retry.memberId !== marker.memberId) {
      retry = { epoch: task.epoch, memberId: marker.memberId, retries: 0, retryAt: 0, inFlight: false }
      this.stopRetries.set(task.id, retry)
    }
    if (retry.inFlight || retry.retryAt > this.k.now()) return
    const state = retry
    state.inFlight = true
    this.k.defer(async () => {
      let stopConfirmed = false
      try {
        const queued = this.k.store.get('tasks', task.id)
        if (this.k.shuttingDown || queued === undefined || queued.epoch !== state.epoch
          || queued.resumeAfterStop?.epoch !== state.epoch || queued.resumeAfterStop.memberId !== state.memberId) return
        const stoppedMember = state.memberId === undefined ? undefined : this.k.store.get('members', state.memberId)
        const candidates = state.memberId === undefined ? this.k.store.list('members', missionId) : stoppedMember === undefined ? [] : [stoppedMember]
        const ownerIds = state.memberId === undefined ? candidates.map(member => member.id) : [state.memberId]
        const results = await Promise.allSettled(ownerIds.map(memberId => this.k.workers.stop(memberId)))
        const failed = results.find(result => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        stopConfirmed = true
        if (this.k.shuttingDown) return
        const stoppedTask = this.k.task(missionId, task.id)
        if (stoppedTask.epoch !== state.epoch || stoppedTask.resumeAfterStop?.epoch !== state.epoch || stoppedTask.resumeAfterStop.memberId !== state.memberId) return
        if (candidates.length === 0) throw new Error(`The recorded stop owner is missing: ${state.memberId ?? 'this mission'} has no member row, so its workspace checkpoint can never be confirmed`)
        for (const candidate of candidates) await this.k.workers.checkpointTask(candidate, stoppedTask, state.memberId === undefined ? { ifOwned: true } : undefined)
        await this.k.exclusive(missionId, async () => {
          const mission = this.k.mission(missionId)
          const fresh = this.k.task(missionId, task.id)
          if (fresh.epoch !== state.epoch || fresh.resumeAfterStop?.epoch !== state.epoch || fresh.resumeAfterStop.memberId !== state.memberId) return
          const reason = fresh.resumeAfterStop.reason
          const causes = blockCauses(fresh, evidenceId => this.k.store.get('evidence', evidenceId)?.status, this.k.config.maxTasksPerMember)
          const { blocked: exhausted, recoveryLimit: recoveryExhausted } = stopOutcome(causes, reason)
          const released = ownerIds.map(memberId => this.k.store.get('members', memberId)).filter((member): member is Member => member !== undefined)
          if (reason === 'worker-closeout' && state.memberId !== undefined && (released.length === 0 || released[0]!.status === 'stopped')) delete fresh.assigneeId
          if (!TERMINAL_STATES.has(fresh.status)) fresh.status = exhausted ? 'blocked' : 'pending'
          delete fresh.resumeAfterStop
          this.k.commit(missionId, () => {
            for (const member of released) if (memberPhaseOf(member) !== 'stopped') {
              // R20: the barrier no longer decides a member's phase. `parked` is
              // the member's own `swarm_wait` intent and nothing else, so there is
              // no host park left for this release to preserve or consume — the
              // step brake in `beforeStep` refuses a fenced handle's steps while
              // the barrier is in flight, which is the whole window the park used
              // to cover. A terminal mission still ends the membership here,
              // because that is the barrier's own decision, not a released flag.
              if (terminal(mission)) member.phase = 'stopped'
              this.k.store.put('members', member)
            }
            this.k.store.put('tasks', fresh)
            this.k.store.event(missionId, reason === 'worker-closeout' ? (exhausted ? 'task/closeout-exhausted' : 'task/closeout-ready') : reason === 'handoff' ? 'task/handoff-ready' : 'task/quiescence-recovered', 'runtime', {
              taskId: fresh.id, ...(state.memberId === undefined ? { memberIds: ownerIds } : { memberId: state.memberId }), reason, retries: state.retries,
            })
          })
          if (recoveryExhausted && mission.status === 'active' && fresh.status !== 'cancelled') this.notices.emitGuardTerminal(missionId, 'attempt_lease', { taskId: fresh.id, memberId: state.memberId, localKey: `recovery-exhausted:${taskSubject(fresh)}`, detail: `${reason === 'lease-expired' ? 'lease expiry exhausted' : 'idle close-out reached'} the recovery limit (${fresh.recoveryCount ?? 0}/${fresh.maxRecoveryAttempts ?? this.k.config.maxTasksPerMember}) and left the task blocked` })
        })
        if (this.stopRetries.get(task.id) === state) this.stopRetries.delete(task.id)
        if (state.memberId === undefined) for (const peer of this.k.store.list('tasks', missionId)) if (peer.id !== task.id && stopPending(peer)) this.resumeStoppedAttempt(missionId, peer)
        if (this.k.mission(missionId).status === 'active') this.k.kick(missionId)
      } catch (error) {
        state.retries++
        state.retryAt = this.k.now() + Math.min(30_000, 1000 * 2 ** Math.min(state.retries - 1, 5))
        if (this.k.shuttingDown) return
        const fresh = this.k.store.get('tasks', task.id)
        const mission = this.k.store.get('missions', missionId)
        if (fresh === undefined || fresh.epoch !== state.epoch || fresh.resumeAfterStop?.epoch !== state.epoch || fresh.resumeAfterStop.memberId !== state.memberId || mission === undefined) return
        const message = error instanceof Error ? error.message : String(error)
        const code = error instanceof Error && 'code' in error ? String(error.code) : ''
        const deterministic = stopConfirmed && (code === 'WORKSPACE_OWNERSHIP_CONFLICT'
          || /Cannot checkpoint a workspace owned by another task|recorded stop owner is missing/.test(message))
        const previousFailure = fresh.resumeAfterStop!.failure
        if (previousFailure?.message !== message || previousFailure.deterministic !== deterministic) {
          fresh.resumeAfterStop!.failure = { message, deterministic }
          this.k.commit(missionId, () => {
            this.k.store.put('tasks', fresh)
            this.k.store.event(missionId, 'mission/stalled', 'runtime', { cause: 'worker-stop-failed', taskId: task.id, epoch: state.epoch,
              memberId: state.memberId, deterministic, ...(deterministic ? {} : { retryAt: state.retryAt }), reason: message })
          })
        }
        this.reportStopFailure(missionId, fresh)
      } finally { state.inFlight = false }
    })
  }

  private reportStopFailure(missionId: string, task: Task): void {
    const marker = task.resumeAfterStop
    if (!marker?.failure || this.k.mission(missionId).status !== 'active') return
    const { message, deterministic } = marker.failure
    // No row can ever confirm a missing owner's checkpoint, so for it a resume only repeats the refusal.
    const exit = !deterministic ? 'The member remains fenced. The host will retry this temporary failure with bounded backoff.'
      : /recorded stop owner is missing/.test(message)
        ? `A resume only repeats this refusal. Withdraw the task with swarm_cancel (taskId "${task.id}"); if its work is still needed, propose its repair with swarm_propose naming replaces: ["${task.id}"].`
        : `The member remains fenced. Repair the recorded workspace condition, then retry cleanup with swarm_control(action: "resume", taskId: "${task.id}"); its cancelled or blocked outcome is preserved.`
    this.notices.emitGuardTerminal(missionId, 'attempt_lease', { taskId: task.id, memberId: marker.memberId,
      localKey: stopFaultKey(task.id, marker, message),
      detail: `Stopping or preserving this attempt failed: ${message}. ${exit}` })
  }

  /**
   * Extend the current attempt's lease before a long host operation. Bounded by
   * the mission deadline so a stored lease can never outlive the mission.
   */
  fenceAttempt(mission: Mission, task: Task, windowMs: number): void {
    if (!task.attempt) throw new PolicyError('task_attempt_missing', 'lease_error', 'Task has no active attempt')
    const leaseUntil = Math.min(mission.deadline, this.k.now() + Math.max(this.k.config.leaseMs, windowMs))
    if (!Number.isSafeInteger(leaseUntil)) throw new PolicyError('attempt_lease_out_of_range', 'lease_error', 'Attempt lease exceeds the supported clock range')
    task.attempt.leaseUntil = leaseUntil
    this.k.commit(mission.id, () => this.k.store.put('tasks', task))
  }
  /**
   * The one write that fences an attempt a handle may still be running,
   * whatever decided to stop it, with the handle that owes the stop named by
   * the caller (`memberId`). Every site fences through `fenceForStop`, which
   * reads that handle from the row; only the owner's task control names it
   * itself (`SwarmRuntime.controlTask`).
   *
   * Stopping work in flight is four things that only mean anything together:
   * the end of the attempt (`endAttempt`: the epoch bump that invalidates the
   * outstanding lease, the outgoing owner in `priorOwnerIds`, which is the basis
   * of reviewer independence, and the attempt's markers gone with it), the
   * stop marker that handle owes, the row's new `status`, and the
   * `attempt/fenced` closer. Each site used to assemble them by hand, each
   * clearing a different subset of the markers, and only the control paths
   * wrote the closer, so a budget-resume marker could outlive the attempt it
   * named.
   *
   * The caller keeps what is its own: its authorization check, its closer
   * event, its extra fields (a checkpoint, a recovery count, an assignee, an
   * output), its member updates and its `resumeStoppedAttempt` poke.
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
  fenceRow(task: Task, options: { status: Task['status']; reason: StopReason; memberId: string | undefined; cause: string }): { previousStatus: Task['status']; attempt: Task['attempt']; stopOwner: string | undefined } {
    const previousStatus = task.status
    const attempt = task.attempt
    const priorStop = stopPending(task) ? task.resumeAfterStop : undefined
    task.status = options.status
    if (priorStop === undefined) {
      endAttempt(task)
      if (options.memberId !== undefined) task.resumeAfterStop = { epoch: task.epoch, memberId: options.memberId, reason: options.reason, at: this.k.now() }
    } else {
      dropAttempt(task)
      if (options.reason === 'invalidated' && priorStop.reason !== 'invalidated') task.resumeAfterStop = { ...priorStop, reason: options.reason }
    }
    this.k.store.event(task.missionId, 'attempt/fenced', 'runtime', { taskId: task.id, attemptId: attempt?.id ?? null, cause: options.cause })
    return { previousStatus, attempt, stopOwner: priorStop?.memberId ?? options.memberId }
  }
  /**
   * The fence every site uses: lease expiry, an idle close-out, a handoff, a
   * task ceiling, the legacy stop-owner recovery and each control decision (an
   * owner cancel, a mission pause or stop, a challenged prerequisite, a retired
   * review, a revoked workspace). Submitted work may retain an author who now
   * owns another task, so the handle that owes the stop is the one holding the
   * row's open attempt, if any; a stop already owed keeps its own.
   */
  fenceForStop(task: Task, options: { status: Task['status']; reason?: StopReason; cause: string }): ReturnType<Attempts['fenceRow']> {
    return this.fenceRow(task, { status: options.status, reason: options.reason ?? 'handoff', memberId: holdsOpenAttempt(task) ? task.attempt.ownerId : undefined, cause: options.cause })
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
    const activity = this.k.store.get('members', ownerId)?.activity
    if (activity === undefined) return undefined
    const observed = this.k.view.activity(ownerId)
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
    if (activity.kind === 'retry' && activity.retryAt !== undefined && activity.retryAt > this.k.now()) return undefined
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
    const boundMs = this.operationBound(activity, this.k.bounds.operationBoundMs)
    if (boundMs === undefined) return undefined
    const lastRecordedAt = this.k.store.toolRuns(mission.id, { attemptId: attempt.id }).reduce((latest, run) => Math.max(latest, run.createdAt), 0)
    const silentSince = Math.max(activity.startedAt, lastRecordedAt)
    const elapsedMs = this.k.now() - silentSince
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
    const member = this.k.store.get('members', silent.ownerId)
    const name = member === undefined ? silent.ownerId : `${member.name} (${member.id})`
    const what = silent.tool === undefined ? `a ${silent.kind} operation` : `a ${silent.kind} operation \`${silent.tool}\``
    const message = `${name} has held ${what} for ${formatSpan(silent.elapsedMs)} (${silent.elapsedMs}ms) without recording anything, past its declared bound of ${formatSpan(silent.boundMs)}: task ${task.id} "${task.title}", attempt ${silent.attemptId}. The operation no longer counts as liveness, so the lease is not renewed and the attempt expires into the existing recovery, which stops the worker and re-pends the task. Owner actions: inspect the stuck call with swarm_observe (taskId ${task.id}), raise operationBoundMs if the operation is genuinely long, or withdraw the work with swarm_cancel. [witness: activity ${silent.activityId}, kind ${silent.kind}${silent.tool === undefined ? '' : `, tool ${silent.tool}`}, attempt ${silent.attemptId}, startedAt ${silent.startedAt}, lastRecordedAt ${silent.lastRecordedAt}, elapsedMs ${silent.elapsedMs}, boundMs ${silent.boundMs}]`
    // The durable witness is the owner delivery row itself, on the
    // deliveries ledger. A dedicated
    // `task/operation-silent` event type would need its own registry row in
    // src/events.ts, outside this task's write scope; that exact change is
    // named as a hand-off in the submission.
    // R15-A1: the silent operation names its own task. Guard pair: F1 operation
    // silence x lease expiry x the board-level stall — the subject is this task's
    // identity, so a healthy sibling's notices never consume the clock of this
    // one (they carry different subjects and different dedup keys).
    this.notices.record(mission.id, { content: message, subjects: [taskSubject(task)], options: { noticeClass: 'stall', dedupKey: `operation-silent:${silent.attemptId}:${silent.activityId}:${silent.silentSince}` } })
  }
  /**
   * Renew only a still-owned native operation, bounded by the owner's actual
   * mission deadline. `silent` is F1's verdict from the current pass: an
   * operation past its declared bound keeps every other property of a live
   * operation, but it is no longer plausible liveness, so the lease stops being
   * renewed and the existing expiry path — not a new kill switch — frees the
   * attempt. Inside the bound the rule is unchanged. `taskId` and `attemptId`
   * are the task and the attempt the lease-expiry sweep read. Returns the row as
   * it now stands, renewed or not, while it still holds that attempt; undefined
   * once a fencing transition took it.
   */
  private renewActiveOperation(taskId: string, attemptId: string, mission: Mission, silent: boolean): HeldTask | undefined {
    // S1 (P0): fence the renewal itself. The caller may hold a row read before
    // an earlier iteration's await; re-read and never extend a lease, clear a
    // warning or write a whole record over a row that moved epoch, status or
    // attempt (cancel, handoff, challenge, beforeStep, recordToolRun).
    const task = this.k.store.get('tasks', taskId)
    if (!holdsAttempt(task, mission.id, attemptId)) return undefined
    if (task.attempt.leaseUntil >= this.k.now() + this.k.config.leaseMs / 2) return task
    // A live operation is liveness for its full duration: match by member and
    // activity id, never by the attempt the operation happens to be stored under.
    // The adapter must confirm the operation is live; a durable activity alone never renews.
    const activity = this.liveOperation(task)
    if (activity === undefined) {
      if (task.attempt.leaseWarned !== task.attempt.leaseUntil) {
        task.attempt.leaseWarned = task.attempt.leaseUntil
        this.k.commit(mission.id, () => {
          this.k.store.put('tasks', task)
          this.k.store.event(mission.id, 'task/lease-expiring', 'runtime', { taskId: task.id, ownerId: task.attempt.ownerId, leaseUntil: task.attempt.leaseUntil })
        })
      }
      return task
    }
    if (silent) return task
    const member = this.k.store.get('members', task.attempt.ownerId)
    const modelAllowance = activity.kind === 'model' ? (member?.maxOutputTokens ?? 0) : 0
    task.attempt.leaseUntil = Math.min(mission.deadline, this.k.now() + this.k.config.leaseMs + Math.ceil(modelAllowance * LEASE_MS_PER_OUTPUT_TOKEN))
    delete task.attempt.leaseWarned
    // A lease extension is liveness bookkeeping, not a new progress timestamp or milestone.
    this.k.commit(mission.id, () => this.k.store.put('tasks', task))
    return task
  }
  /**
   * W6: the member ended a turn. When it still owns an attempt, the turn end is
   * recorded on that attempt (`turnEnded`), in the one commit that also clears
   * the member's activity, so the dispatch sweep can nudge it and, when the
   * bounded retry is exhausted, checkpoint the workspace before any
   * reassignment. A commit the writer refuses records nothing: that turn end
   * gets no nudge, and the attempt's lease expiry frees it. The attempt
   * reporting bound names it before that only when its own bound passes first
   * (at the default bounds the lease runs out first) and the member row records
   * no operation (an activity end the same writer refused leaves one recorded).
   */
  onIdle(memberId: string): void {
    if (this.k.closed || this.k.shuttingDown) return
    const member = this.k.store.get('members', memberId)
    if (!member || member.status === 'stopped') return
    const open = openAttempt(this.k.store.list('tasks', member.missionId), memberId)
    if (open !== undefined) open.attempt.idleSignal = { at: this.k.now() }
    // No member status is written: it is derived from the phase and the live
    // attempts on every read (src/projection.ts) and the store strips it.
    delete member.activity
    this.k.commit(member.missionId, () => {
      this.k.store.put('members', member)
      if (open !== undefined) this.k.store.put('tasks', open)
    })
    this.k.kick(member.missionId)
  }
  /**
   * W6: an idle worker still owns a running attempt. First re-wake it with a
   * bounded, durable nudge; when the bound is exhausted, capture the member
   * workspace as an immutable checkpoint, fence the attempt and re-pend the
   * task with the same member preferred so recovery resumes partial work.
   * `pass` is the dispatching body's record: its capture await is the body's own.
   */
  async closeOutIdleAttempt(mission: Mission, member: Member, task: HeldTask, pass?: SchedulingPass): Promise<void> {
    const attemptId = task.attempt.id
    const bound = this.k.config.maxIdleCloseouts ?? DEFAULT_IDLE_CLOSEOUTS
    const nudges = task.attempt.closeout?.nudges ?? 0
    if (nudges < bound) {
      const nudge = nudges + 1
      const remaining = bound - nudge
      task.attempt.closeout = { nudges: nudge, at: this.k.now() }
      this.k.commit(mission.id, () => {
        this.k.store.put('tasks', task)
        this.k.store.put('deliveries', { id: id('msg'), missionId: mission.id, from: 'runtime', to: member.id, kind: 'control', createdAt: this.k.now(),
          content: `Your attempt on "${task.title}" (${task.id}) is still open but your turn ended without a terminal call. Continue this exact attemptId ${attemptId} and finish it: submit with swarm_submit, release it with swarm_handoff, or park with swarm_wait. ${remaining === 0 ? 'The next idle close-out checkpoints your workspace and re-pends the task for recovery.' : `After ${remaining} more idle close-out${remaining === 1 ? '' : 's'} the runtime checkpoints your workspace and re-pends the task for recovery.`}` })
        this.k.store.event(mission.id, 'task/closeout-nudged', 'runtime', { taskId: task.id, attemptId, ownerId: member.id, nudges: nudge })
      })
      return
    }
    let checkpoint: Artifact
    try { checkpoint = await awaited(pass, this.k.workers.captureArtifact(member, task), this.k.now) }
    catch (error) {
      const failed = this.k.task(mission.id, task.id)
      if (!holdsAttempt(failed, mission.id, attemptId)) return
      failed.output = `Worker ended its turn without submitting (${task.id}) and its workspace could not be checkpointed: ${error instanceof Error ? error.message : String(error)}. Inspect the member workspace before proposing a replacement.`
      this.k.commit(mission.id, () => {
        this.fenceForStop(failed, { status: 'blocked', reason: 'invalidated', cause: 'closeout-failed' })
        this.k.store.put('tasks', failed)
        this.k.store.event(mission.id, 'task/closeout-failed', 'runtime', { taskId: failed.id, ownerId: member.id, reason: failed.output })
      })
      // S4b: the terminal element of the attempt/lease chain. The workspace
      // checkpoint guard (a dirty or unprovisioned worktree) and the close-out
      // guard co-fire here, so the owner gets the shared coded decision request
      // naming the task and the exits instead of a prose-only reason.
      this.notices.emitGuardTerminal(mission.id, 'attempt_lease', { taskId: failed.id, memberId: member.id, localKey: `closeout-failed:${taskSubject(failed)}`, detail: terminalDetail(failed.output!) })
      this.resumeStoppedAttempt(mission.id, failed)
      return
    }
    const current = this.k.task(mission.id, task.id)
    // The attempt may have finished while the checkpoint committed; never mutate terminal work.
    if (!holdsAttempt(current, mission.id, attemptId)) return
    current.checkpoint = { commit: checkpoint.commit, at: this.k.now() }
    current.recoveryCount = (current.recoveryCount ?? 0) + 1
    // Prefer the same member: its next attempt resumes the checkpointed workspace
    // instead of a different member starting from the mission baseline.
    current.assigneeId = member.id
    current.plannedAssigneeId ??= member.id
    this.k.commit(mission.id, () => {
      this.fenceForStop(current, { status: 'blocked', reason: 'worker-closeout', cause: 'closeout-abandoned' })
      this.k.store.put('tasks', current)
      this.k.store.event(mission.id, 'task/closeout-abandoned', 'runtime', { taskId: current.id, ownerId: member.id, commit: checkpoint.commit, recoveryCount: current.recoveryCount })
    })
    // S4b (owner finding, measured: 7 of 8 silent): an abandoned close-out is a
    // stuck transition the owner was never told about. It emits the shared coded
    // escalation, naming the task and the attempt, while the durable checkpoint
    // event above keeps the audit trail. Co-firing guards: the attempt/lease
    // chain fires with the workspace capture guard that produced the checkpoint,
    // with the dispatch sweep that re-pends the task, and (when the recovery
    // limit is already spent) with the close-out exhaustion terminal below.
    this.notices.emitGuardTerminal(mission.id, 'attempt_lease', { taskId: current.id, memberId: member.id, localKey: `closeout-abandoned:${attemptId}`, detail: `idle close-out abandoned attempt ${attemptId}: the workspace was checkpointed at ${checkpoint.commit} and the task was re-pended (recovery ${current.recoveryCount ?? 0})` })
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
        for (const listed of this.k.store.list('tasks', missionId)) {
          if (this.k.shuttingDown) return false
          let task = this.k.store.get('tasks', listed.id)
          if (task !== undefined && stopPending(task)) {
            this.resumeStoppedAttempt(missionId, task)
            continue
          }
          this.stopRetries.delete(listed.id)
          if (task === undefined || task.missionId !== missionId || !holdsOpenAttempt(task)) continue
          const oldOwner = task.attempt.ownerId
          const attemptId = task.attempt.id
          // R10-15: a parked member holding a live attempt is a stall signal, not a
          // silent board. Record it durably and wake the owner once per attempt.
          const parked = heldByParkedMember(this.k.store.list('members', missionId), task)
          if (parked) this.notices.record(missionId, parkedHolder(missionId, task))
          // F1: an in-flight operation that has recorded nothing past its
          // declared bound is named to the owner once, and stops renewing the
          // lease so the existing expiry path can free the attempt.
          const silent = this.silentOperation(task, mission)
          if (silent !== undefined) this.escalateSilentOperation(mission, task, silent)
          const renewed = this.renewActiveOperation(task.id, attemptId, mission, silent !== undefined)
          if (renewed === undefined || renewed.attempt.leaseUntil >= this.k.now()) continue
          task = renewed
          // W6: capture a durable checkpoint before any reassignment when the old
          // owner is quiescent, so the next attempt resumes committed work instead
          // of falling back to the mission baseline.
          if (this.k.view.startable(oldOwner)) {
            const owner = this.k.store.get('members', oldOwner)
            if (owner !== undefined && owner.status !== 'stopped') {
              try {
                const checkpoint = await awaited(pass, this.k.workers.captureArtifact(owner, task), this.k.now)
                const current = this.k.task(missionId, task.id)
                if (holdsAttempt(current, missionId, attemptId)) {
                  // S1 (P0): commit the row re-read after the await, never the
                  // pre-await object, so a concurrent transition is not reverted.
                  current.checkpoint = { commit: checkpoint.commit, at: this.k.now() }
                  this.k.commit(missionId, () => { this.k.store.put('tasks', current); this.k.store.event(missionId, 'task/checkpointed', 'runtime', { taskId: current.id, commit: checkpoint.commit, reason: 'lease-expired' }) })
                }
              } catch (error) {
                // Auditable and non-fatal: the workspace stays untouched and
                // prepareTask refuses a dirty workspace rather than losing it.
                const current = this.k.task(missionId, task.id)
                if (holdsAttempt(current, missionId, attemptId)) {
                  const reason = `Lease-expiry checkpoint failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}. The member workspace is preserved; recovery will refuse a dirty workspace instead of losing it.`
                  this.k.commit(missionId, () => {
                    this.k.store.event(missionId, 'task/checkpoint-failed', 'runtime', { taskId: task.id, ownerId: oldOwner, reason })
                  })
                  // S4b: the lease-expiry checkpoint failure is the terminal of
                  // the attempt/lease chain for this attempt: the workspace guard
                  // refused the capture, so recovery will refuse a dirty
                  // workspace too. The coded decision request replaces the prose.
                  this.notices.emitGuardTerminal(missionId, 'attempt_lease', { taskId: task.id, memberId: oldOwner, localKey: `checkpoint-failed:${attemptId}`, detail: terminalDetail(reason) })
                }
              }
            }
          }
          // The checkpoint awaited external work. An owner cancel (or any other
          // fencing transition) committed during it must win over lease recovery:
          // re-read and only transition the record that still owns this attempt.
          const expiring = this.k.task(missionId, task.id)
          if (!holdsAttempt(expiring, missionId, attemptId)) continue
          // A lease that expired while the task was budget-paused is host policy, not
          // a recovery failure, and the plan's intended owner must survive it. The
          // pause is the mission's, read after the checkpoint await above, which
          // it can land during. A lease that expired while its owner was parked is
          // the same class of host-induced stop (R10-15): the park, not the
          // worker, caused the stall, so it must not spend a recovery credit.
          const pauseInduced = this.k.mission(missionId).budgetPause !== undefined || parked
          if (!pauseInduced) expiring.recoveryCount = (expiring.recoveryCount ?? 0) + 1
          const planned = expiring.plannedAssigneeId === undefined ? undefined : this.k.store.get('members', expiring.plannedAssigneeId)
          if (planned !== undefined && planned.status !== 'stopped') expiring.assigneeId = planned.id
          else delete expiring.assigneeId
          this.k.commit(missionId, () => {
            this.fenceForStop(expiring, { status: 'blocked', reason: 'lease-expired', cause: 'lease-expired' })
            this.k.store.put('tasks', expiring)
            this.k.store.event(missionId, 'task/lease-expired', 'runtime', { taskId: expiring.id, oldOwner })
          })
          this.resumeStoppedAttempt(missionId, expiring)
        }
    return true
  }
}
