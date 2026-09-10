/**
 * Lease and attempt accounting: the durable attempt lifecycle (fence, renew,
 * drop, close out) and the pass's lease-expiry recovery sweep.
 *
 * M1a seam 1/7. Everything here is behaviour-identical to the code it was moved
 * from `src/runtime.ts`; the runtime keeps thin forwarding methods so no call
 * site changed. The runtime reference is typed as the class and imported
 * type-only, so no runtime import cycle exists.
 */
import { randomUUID } from 'node:crypto'
import type { SwarmRuntime } from './runtime.ts'
import type { Actor, Artifact, Member, Mission, Task } from './types.ts'

const id = (prefix: string) => `${prefix}_${randomUUID()}`

/** W6: bounded idle close-outs before the workspace is checkpointed and re-pended. */
export const DEFAULT_IDLE_CLOSEOUTS = 2
/** Renewal allowance per model output token, so a long model call keeps its lease. */
export const LEASE_MS_PER_OUTPUT_TOKEN = 20

export class Attempts {
  /**
   * S5 cache-only: the durable `Task.idleSignal` row carries the same value and
   * the scheduling pass re-reads it; losing this map changes no durable outcome.
   */
  readonly idleSignals = new Map<string, { attemptId: string; at: number }>()

  constructor(private readonly rt: SwarmRuntime) {}

  ownAttempt(actor: Actor, missionId: string, taskId: string, attemptId: string): { task: Task; member: Member } {
    const { member } = this.rt.active(actor, missionId)
    const task = this.rt.task(missionId, taskId)
    if (!member || task.status !== 'running' || !task.attempt || task.attempt.id !== attemptId || task.attempt.ownerId !== member.id || task.attempt.leaseUntil < Date.now()) throw new Error('Stale or unauthorized task attempt; stop work and observe the current assignment')
    if (!task.dependencies.every(dep => this.rt.dependencySatisfied(missionId, dep))) throw new Error('A task prerequisite is no longer accepted; stop work')
    return { task, member }
  }
  /**
   * Extend the current attempt's lease before a long host operation. Bounded by
   * the mission deadline so a stored lease can never outlive the mission.
   */
  fenceAttempt(mission: Mission, task: Task, windowMs: number): void {
    if (!task.attempt) throw new Error('Task has no active attempt')
    const leaseUntil = Math.min(mission.deadline, Date.now() + Math.max(this.rt.config.leaseMs, windowMs))
    if (!Number.isSafeInteger(leaseUntil)) throw new Error('Attempt lease exceeds the supported clock range')
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
  /** Renew only a still-owned native operation, bounded by the owner's actual mission deadline. */
  renewActiveOperation(task: Task, mission: Mission): void {
    // S1 (P0): fence the renewal itself. The caller may hold a row read before
    // an earlier iteration's await; re-read and never extend a lease, clear a
    // warning or write a whole record over a row that moved epoch, status or
    // attempt (cancel, handoff, challenge, beforeStep, recordToolRun).
    const current = this.rt.store.get('tasks', task.id)
    if (current === undefined || current.missionId !== mission.id || current.epoch !== task.epoch
      || current.status !== 'running' || current.attempt?.id !== task.attempt?.id) return
    task = current
    if (!task.attempt || task.attempt.leaseUntil >= Date.now() + this.rt.config.leaseMs / 2) return
    const member = this.rt.store.get('members', task.attempt.ownerId)
    const activity = member?.activity
    const observed = this.rt.workers.currentActivity?.(task.attempt.ownerId)
    // A live operation is liveness for its full duration: match by member and
    // activity id, never by the attempt the operation happens to be stored under.
    // Adapters that report current activity must confirm the operation is live.
    const live = activity !== undefined && (this.rt.workers.currentActivity === undefined || (observed !== undefined && observed.id === activity.id))
    if (!live) {
      if (task.leaseWarned !== task.attempt.leaseUntil) {
        task.leaseWarned = task.attempt.leaseUntil
        this.rt.commit(mission.id, () => {
          this.rt.store.put('tasks', task)
          this.rt.store.event(mission.id, 'task/lease-expiring', 'runtime', { taskId: task.id, ownerId: task.attempt!.ownerId, leaseUntil: task.attempt!.leaseUntil })
        })
      }
      return
    }
    const modelAllowance = activity.kind === 'model' ? (member?.maxOutputTokens ?? 0) : 0
    task.attempt.leaseUntil = Math.min(mission.deadline, Date.now() + this.rt.config.leaseMs + Math.ceil(modelAllowance * LEASE_MS_PER_OUTPUT_TOKEN))
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
      this.idleSignals.set(memberId, { attemptId: open.attempt.id, at: Date.now() })
      // S5: the signal is durable on the task row the scheduling pass re-reads;
      // the map above is only a cache for a row write still in flight.
      open.idleSignal = { attemptId: open.attempt.id, at: Date.now() }
      this.rt.store.put('tasks', open)
    } else this.idleSignals.delete(memberId)
    member.status = 'idle'
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
   */
  async closeOutIdleAttempt(mission: Mission, member: Member, task: Task): Promise<void> {
    const bound = this.rt.config.maxIdleCloseouts ?? DEFAULT_IDLE_CLOSEOUTS
    const nudges = task.closeout?.nudges ?? 0
    if (nudges < bound) {
      const nudge = nudges + 1
      const remaining = bound - nudge
      const attemptId = task.attempt!.id
      task.closeout = { nudges: nudge, at: Date.now() }
      this.rt.commit(mission.id, () => {
        this.rt.store.put('tasks', task)
        this.rt.store.put('deliveries', { id: id('msg'), missionId: mission.id, from: 'runtime', to: member.id, kind: 'control', createdAt: Date.now(),
          content: `Your attempt on "${task.title}" (${task.id}) is still open but your turn ended without a terminal call. Continue this exact attemptId ${attemptId} and finish it: submit with swarm_submit, release it with swarm_handoff, or park with swarm_wait. ${remaining === 0 ? 'The next idle close-out checkpoints your workspace and re-pends the task for recovery.' : `After ${remaining} more idle close-out${remaining === 1 ? '' : 's'} the runtime checkpoints your workspace and re-pends the task for recovery.`}` })
        this.rt.store.event(mission.id, 'task/closeout-nudged', 'runtime', { taskId: task.id, attemptId, ownerId: member.id, nudges: nudge })
      })
      return
    }
    let checkpoint: Artifact
    try { checkpoint = await this.rt.workers.captureArtifact(member, task) }
    catch (error) {
      const failed = this.rt.task(mission.id, task.id)
      if (failed.status !== 'running' || failed.attempt?.id !== task.attempt?.id) return
      failed.status = 'blocked'; failed.epoch++; this.dropAttempt(failed); delete failed.closeout; delete failed.idleSignal
      failed.output = `Worker ended its turn without submitting (${task.id}) and its workspace could not be checkpointed: ${error instanceof Error ? error.message : String(error)}. Inspect the member workspace before proposing a replacement.`
      this.rt.commit(mission.id, () => {
        this.rt.store.put('tasks', failed)
        this.rt.store.event(mission.id, 'task/closeout-failed', 'runtime', { taskId: failed.id, ownerId: member.id, reason: failed.output })
        this.rt.notify(mission.id, failed.output!)
      })
      return
    }
    const current = this.rt.task(mission.id, task.id)
    // The attempt may have finished while the checkpoint committed; never mutate terminal work.
    if (current.status !== 'running' || current.attempt?.id !== task.attempt?.id) return
    current.checkpoint = { commit: checkpoint.commit, at: Date.now() }
    current.status = 'blocked'; current.epoch++
    current.recoveryCount = (current.recoveryCount ?? 0) + 1
    this.dropAttempt(current); delete current.closeout; delete current.idleSignal
    // Prefer the same member: its next attempt resumes the checkpointed workspace
    // instead of a different member starting from the mission baseline.
    current.assigneeId = member.id
    current.plannedAssigneeId ??= member.id
    current.resumeAfterStop = { epoch: current.epoch, reason: 'worker-closeout' }
    const epoch = current.epoch
    this.rt.commit(mission.id, () => {
      this.rt.store.put('tasks', current)
      this.rt.store.event(mission.id, 'task/closeout-abandoned', 'runtime', { taskId: current.id, ownerId: member.id, commit: checkpoint.commit, recoveryCount: current.recoveryCount })
    })
    this.idleSignals.delete(member.id)
    this.rt.defer(async () => {
      await this.rt.workers.stop(member.id)
      await this.rt.exclusive(mission.id, async () => {
        const fresh = this.rt.task(mission.id, task.id)
        if (fresh.epoch !== epoch || fresh.status !== 'blocked') return
        const released = this.rt.store.get('members', member.id)
        if (released !== undefined && released.status !== 'stopped') { released.status = 'idle'; this.rt.store.put('members', released) }
        const exhausted = (fresh.recoveryCount ?? 0) >= (fresh.maxRecoveryAttempts ?? this.rt.config.maxTasksPerMember)
        if (!exhausted) {
          fresh.status = 'pending'; delete fresh.resumeAfterStop
          if (released === undefined || released.status === 'stopped') delete fresh.assigneeId
        } else delete fresh.resumeAfterStop
        this.rt.commit(mission.id, () => {
          this.rt.store.put('tasks', fresh)
          this.rt.store.event(mission.id, exhausted ? 'task/closeout-exhausted' : 'task/closeout-ready', 'runtime', { taskId: fresh.id, memberId: member.id })
        })
      })
      this.rt.kick(mission.id)
    })
  }

  /**
   * The pass's lease-expiry sweep, in the same order the serialized pass ran it
   * (M1a: moved out of `schedule` unchanged). Returns false when a shutdown was
   * observed, so the caller keeps the original "abandon the pass" control flow.
   */
  async recoverExpired(mission: Mission, missionId: string): Promise<boolean> {
        // S1 (P0): iterate ids and re-read each row inside the loop. The loop awaits
        // external work (captureArtifact, stop), and cancel/challenge/handoff/
        // publish/beforeStep/recordToolRun commit directly during those awaits; a
        // pre-await snapshot must never be written back over a newer record.
        for (const listed of this.rt.store.list('tasks', missionId)) {
          if (this.rt.shuttingDown) return false
          let task = this.rt.store.get('tasks', listed.id)
          if (task === undefined || task.missionId !== missionId || task.status !== 'running' || !task.attempt) continue
          const oldOwner = task.attempt.ownerId
          const attemptId = task.attempt.id
          // R10-15: a parked member holding a live attempt is a stall signal, not a
          // silent board. Record it durably and wake the owner once per attempt.
          const ownerMember = this.rt.store.get('members', oldOwner)
          const parked = ownerMember?.status === 'waiting'
          if (parked) this.rt.notifyParkedHolder(mission, task)
          this.renewActiveOperation(task, mission)
          // S1r: the renewal commits a re-read row, so the caller's snapshot can
          // still look expired after a successful renewal. Re-read again and use the
          // current row for every later comparison, or a live operation is renewed
          // and then expired in the same pass (the documented "a live operation is
          // liveness for its full duration" invariant).
          const renewed = this.rt.store.get('tasks', task.id)
          if (renewed === undefined || renewed.missionId !== missionId || renewed.epoch !== task.epoch
            || renewed.status !== 'running' || renewed.attempt?.id !== attemptId) continue
          task = renewed
          if (task.attempt === undefined || task.attempt.leaseUntil >= Date.now()) continue
          // W6: capture a durable checkpoint before any reassignment when the old
          // owner is quiescent, so the next attempt resumes committed work instead
          // of falling back to the mission baseline.
          if (this.rt.workers.isIdle(oldOwner)) {
            const owner = this.rt.store.get('members', oldOwner)
            if (owner !== undefined && owner.status !== 'stopped') {
              try {
                const checkpoint = await this.rt.workers.captureArtifact(owner, task)
                const current = this.rt.task(missionId, task.id)
                if (current.epoch === task.epoch && current.status === 'running' && current.attempt?.id === attemptId) {
                  // S1 (P0): commit the row re-read after the await, never the
                  // pre-await object, so a concurrent transition is not reverted.
                  current.checkpoint = { commit: checkpoint.commit, at: Date.now() }
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
                    this.rt.notify(missionId, reason)
                  })
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
          expiring.resumeAfterStop = { epoch: expiring.epoch, reason: 'lease-expired' }
          this.rt.commit(missionId, () => { this.rt.store.put('tasks', expiring); this.rt.store.event(missionId, 'task/lease-expired', 'runtime', { taskId: expiring.id, oldOwner }) })
          await this.rt.workers.stop(oldOwner)
          const reopened = this.rt.task(missionId, task.id)
          if (reopened.epoch !== expiring.epoch || reopened.status !== 'blocked') continue
          reopened.status = (reopened.recoveryCount ?? 0) >= (reopened.maxRecoveryAttempts ?? this.rt.config.maxTasksPerMember) ? 'blocked' : 'pending'; delete reopened.resumeAfterStop
          this.rt.commit(missionId, () => { this.rt.store.put('tasks', reopened) })
        }
    return true
  }
}
