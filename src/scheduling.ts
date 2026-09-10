/**
 * The scheduling seam: the readiness and stall predicates, the durable pass guard
 * (open/close/release) and the dispatch sweep of one serialized pass. M1a seam 7/7.
 *
 * Behaviour-identical to the code moved from src/runtime.ts; the runtime keeps
 * thin forwarding methods and `schedule` calls `dispatch` exactly where its
 * member loop used to be.
 */
import { randomUUID } from 'node:crypto'
import { hasNotice } from './arena.ts'
import { AdmissionRefusedError } from './scheduler.ts'
import { WorkspaceRevokedError } from './workspace-admission.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { Actor, Member, Mission, SchedulingPass, Task } from './types.ts'

/**
 * Round-8 F1: scheduling passes an unreviewed submission must persist before
 * the board is reported stalled. The owner may be admitting the review it just
 * planned; a submission that stays unreviewable past this bounded grace is a
 * stall. The wall-clock bound keeps the notice prompt even with a slow tick.
 */
export const STALL_GRACE_PASSES = 30

export const STALL_GRACE_MAX_MS = 1000

const id = (prefix: string) => `${prefix}_${randomUUID()}`

/**
 * S5c: the durable release record on the pass row. `SchedulingPass`
 * (src/types.ts) is outside this task's write scope, so the two fields are
 * declared here and travel as plain JSON properties on the same durable row;
 * the integration task records the schema addition. `releasedRunId` is the runId
 * of the most recent pass the watchdog released, carried forward by `openPass`
 * (and preserved by `closePass`) because the row is overwritten once per pass.
 */
interface ReleasedPassFields { releasedRunId?: string; releasedAt?: number }
const releasedPassFields = (row: SchedulingPass): SchedulingPass & ReleasedPassFields => row as SchedulingPass & ReleasedPassFields

export class Scheduling {
  /**
   * S1: pass ids the watchdog released after the declared bound, so an
   * abandoned pass body cannot dispatch into the newer pass's turn. S5c: this
   * Set is the in-process mirror of the durable `releasedRunId` on the pass row
   * (`passReleased` reads the row first), so losing it cannot let a released
   * body resume — it is a fast path for the same durable fact.
   */
  readonly releasedPasses = new Set<string>()
  /**
   * Identity of this runtime process in the pass row. A row written by a
   * different instance is a crashed process's leftover: it never gates this
   * runtime (the next open pass overwrites it), so a restart does not wait out
   * a dead pass's bound.
   */
  readonly instanceId = id('runtime')

  constructor(private readonly rt: SwarmRuntime) {}

  /**
   * The dispatch sweep of one serialized pass (M1a: moved out of `schedule`
   * unchanged). It returns false when the pass must be abandoned exactly where
   * the original early returns did: on shutdown, on a mission that stopped being
   * active during an adapter await, or when the pass guard was released.
   */
  async dispatch(mission: Mission, missionId: string, pass?: SchedulingPass): Promise<boolean> {
        for (const member of this.rt.store.list('members', missionId)) {
          if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
          if (member.status === 'stopped') continue
          // S1: an abandoned pass body (its guard was released after the declared
          // bound) must never dispatch into the newer pass's turn.
          if (this.passReleased(pass)) return false
          if (!this.rt.isolationAllows(missionId, member)) continue
          try { await this.rt.workers.start({ mission, member, ownerSessionId: mission.ownerSessionId }) }
          catch (error) {
            // Disposing the adapter cancels in-flight starts. This is recoverable host
            // shutdown, not a permanent worker failure to persist across restart.
            if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
            this.rt.onStartFailure(mission, member, error)
            continue
          }
          this.rt.startFailures.delete(member.id)
          this.rt.clearProviderOutage(missionId, member.id)
          if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
          if (this.passReleased(pass)) return false
          // R10-09/S3: a parked member is dispatchable. The adapter's idle
          // precondition can be false for a parked agent (a pending inbox item or a
          // non-idle handle); an assignment is exactly the fresh input that unparks
          // it, so the runtime must not let that precondition leave the board silent.
          const parkedMember = member.status === 'waiting'
          if (!parkedMember && !this.rt.workers.isIdle(member.id)) continue
          const open = this.rt.store.list('tasks', missionId).find(t => t.status === 'running' && t.attempt?.ownerId === member.id)
          if (open !== undefined) {
            // W6: the worker ended its turn with an open attempt. Nudge within a
            // bounded retry, then checkpoint the workspace and re-pend the task
            // instead of leaving it a zombie until lease expiry. A parked owner is
            // not an abandoned turn: the lease path re-pends it without a credit.
            // S5: the signal is re-read from the durable task row; the in-memory map
            // is only a cache for an attempt whose row write is still in flight.
            const durableIdle = open.idleSignal?.attemptId === open.attempt?.id
            const cachedIdle = this.rt.attempts.idleSignals.get(member.id)?.attemptId === open.attempt?.id
            if (!parkedMember && (durableIdle || cachedIdle)) await this.rt.closeOutIdleAttempt(mission, member, open)
            continue
          }
          const all = this.rt.store.list('tasks', missionId)
          const tasks = all.filter(t => this.ready(t, member, all)).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
          const task = tasks[0]
          if (!task) continue
          try {
            // Revocation fencing: a mission whose human authorization was withdrawn
            // is blocked here, before any adapter prepares a workspace or checkout.
            await this.rt.assertWorkspaceAuthorized(this.rt.mission(missionId))
            await this.rt.workers.prepareTask(member, { ...task, epoch: task.epoch + 1 }, this.rt.effectiveDependencies(missionId, task), task.reviewOf ? this.rt.task(missionId, task.reviewOf) : undefined)
            if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
            if (this.passReleased(pass)) return false
            const fresh = this.rt.task(missionId, task.id)
            if (fresh.epoch !== task.epoch || !this.ready(fresh, member)) continue
            // S7: re-read the isolation invariant after the external preparation
            // await. A state change during it (a member added into this worktree, a
            // second running task admitted) is refused here, never dispatched.
            if (!this.rt.isolationAllows(missionId, member)) continue
            this.rt.assign(fresh, member)
          } catch (error) {
            // Admission control already wrote the durable refusal; the task stays
            // pending and a later tick re-evaluates it when a slot frees up.
            if (error instanceof AdmissionRefusedError) continue
            if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
            // A withdrawn authorization is terminal for this host process, not a
            // transient preparation failure: fence the mission now, never retry.
            if (error instanceof WorkspaceRevokedError) { this.rt.fenceWorkspace(missionId, error.diagnostic); return false }
            const fresh = this.rt.task(missionId, task.id)
            if (fresh.epoch !== task.epoch || !this.ready(fresh, member)) continue
            // W18: a workspace or worker preparation failure is recoverable, not
            // terminal. Mirror the attempt-failure, close-out and lease-expiry
            // policy: spend exactly one recovery credit per failure, re-pend while
            // the limit is not exhausted, and block only once it is.
            const reason = `Workspace or worker preparation failed: ${String(error)}`
            fresh.recoveryCount = (fresh.recoveryCount ?? 0) + 1
            fresh.output = reason
            fresh.epoch++
            const limit = fresh.maxRecoveryAttempts ?? this.rt.config.maxTasksPerMember
            const exhausted = fresh.recoveryCount >= limit
            fresh.status = exhausted ? 'blocked' : 'pending'
            this.rt.commit(missionId, () => {
              this.rt.store.put('tasks', fresh)
              this.rt.store.event(missionId, 'task/preparation-failed', 'runtime', { taskId: fresh.id, epoch: fresh.epoch, reason, recoveryCount: fresh.recoveryCount, maxRecoveryAttempts: limit, status: fresh.status })
              if (!exhausted) return false
              this.rt.store.event(missionId, 'task/blocked', 'runtime', { taskId: fresh.id, reason })
              this.rt.notify(missionId, reason)
            })
          }
        }
    return true
  }

  ready(task: Task, member: Member, tasks?: Task[]): boolean {
    if (task.status !== 'pending' || (task.assigneeId && task.assigneeId !== member.id)) return false
    return this.capable(task, member, tasks)
  }

  /**
   * R5-02: whether a member could take this task if it were pending and
   * unassigned. Same prerequisites and review-independence guard as `ready`,
   * without the status/assignee pin, so a start-failure re-route can evaluate
   * candidates before committing the re-pend. The author check matches
   * admission's definition (`attempt?.ownerId ?? assigneeId`), so a re-route can
   * never assign a verification to the author of the source it reviews.
   */
  capable(task: Task, member: Member, tasks?: Task[]): boolean {
    if (!task.dependencies.every(dep => this.rt.dependencySatisfied(task.missionId, dep, tasks))) return false
    if (task.reviewOf) {
      const source = this.rt.task(task.missionId, task.reviewOf)
      if (source.status !== 'submitted' || this.rt.authorIds(source).has(member.id)) return false
    }
    return true
  }

  /**
   * Tasks that can never be dispatched again: pending work whose dependency
   * lineage or review source is dead, reviews assigned to their own author, and
   * blocked work. They contribute nothing further; completion may cancel them
   * once every acceptance criterion is independently covered.
   */
  unschedulable(mission: Mission, tasks: Task[], members: Member[]): Task[] {
    const live = members.filter(member => member.status !== 'stopped')
    // W15: a blocked task with a matching stop marker is alive, not dead. Handoff,
    // worker close-out and lease expiry hold the task at `blocked` +
    // `resumeAfterStop` only until `workers.stop()` resolves; treating it as
    // unschedulable lets `control complete` cancel recoverable work.
    const dead = new Set(tasks.filter(task => task.status === 'blocked' && !this.quiescencePending(task)).map(task => task.id))
    // Fixpoint: work waiting on dead prerequisites or an unreachable review source is dead too.
    for (let changed = true; changed;) {
      changed = false
      for (const task of tasks) {
        if (dead.has(task.id) || task.status !== 'pending') continue
        const stuck = task.dependencies.some(dep => { const effective = this.rt.effectiveDependency(mission.id, dep, tasks); return effective.status === 'cancelled' || dead.has(effective.id) })
          || (task.reviewOf !== undefined && (() => {
            const source = this.rt.task(mission.id, task.reviewOf)
            return source.status === 'cancelled' || source.status === 'accepted' || dead.has(source.id)
              || (task.assigneeId !== undefined && this.rt.authorIds(source).has(task.assigneeId))
          })())
          || (task.assigneeId !== undefined && !live.some(member => member.id === task.assigneeId))
        if (stuck) { dead.add(task.id); changed = true }
      }
    }
    return tasks.filter(task => dead.has(task.id))
  }

  /**
   * A submitted task is progress only while a live review can still accept it.
   * A review that was never admitted or was retired leaves the submission
   * unreviewable forever; counting it as progress hid a stalled board from the
   * owner (Round-8 F1). Pending and running reviews are live, and a parked
   * review (blocked with a matching stop marker) re-pends after the stop
   * acknowledgement, so it still counts.
   */
  reviewable(task: Task, tasks: Task[]): boolean {
    return tasks.some(review => review.kind === 'verification' && review.reviewOf === task.id
      && (review.status === 'pending' || review.status === 'running' || this.quiescencePending(review)))
  }

  /**
   * A submission with no live review is a stall candidate, not a stall, until
   * the same unreviewed artifact has aged past the grace. S5: the grace is read
   * from the durable `task/submitted` event of each unreviewed task, not from an
   * in-memory timer — a restart (or a lost cache) can no longer restart the
   * window, and the answer is identical for the same durable board.
   */
  unreviewedStall(missionId: string, unreviewed: Task[]): boolean {
    const grace = Math.min(this.rt.config.tickMs * STALL_GRACE_PASSES, STALL_GRACE_MAX_MS)
    const events = this.rt.store.events(missionId, this.rt.config.maxEvents)
    return unreviewed.every(task => {
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]!
        if (event.type !== 'task/submitted' || (event.data as { taskId?: string } | undefined)?.taskId !== task.id) continue
        return Date.now() - event.createdAt >= grace
      }
      // No durable submission record: the grace cannot have elapsed yet.
      return false
    })
  }

  /** Nothing is running, reviewably submitted or dispatchable: workers would stay idle forever. */
  stalled(mission: Mission, tasks: Task[], members: Member[]): boolean {
    // An empty board is a mission the owner has not planned yet, not a stall.
    if (!tasks.length) return false
    if (tasks.some(task => task.status === 'running' || this.quiescencePending(task))) return false
    const unreviewed = tasks.filter(task => task.status === 'submitted' && !this.reviewable(task, tasks))
    if (unreviewed.length) {
      if (!this.unreviewedStall(mission.id, unreviewed)) return false
    }
    const live = members.filter(member => member.status !== 'stopped')
    return !tasks.some(task => task.status === 'pending' && live.some(member => this.ready(task, member, tasks)))
  }

  /**
   * A durable stop transition is in flight: the task is blocked only until the
   * old worker handle acknowledges the stop, then it re-pends. Every scheduler
   * and completion decision treats it as live work.
   */
  quiescencePending(task: Task): boolean { return task.status === 'blocked' && task.resumeAfterStop?.epoch === task.epoch }

  /** The runtime's unique deliverable among accepted artifacts; throws when none is unique. */
  selectDeliveryTarget(missionId: string, tasks: Task[]): Task {
    const implementations = tasks.filter(task => task.kind === 'implementation' && task.status === 'accepted')
    // A dependency reference to a replaced original also covers its accepted repair.
    const covers = (task: Task, sourceId: string, seen = new Set<string>()): boolean => {
      if (seen.has(task.id)) return false
      seen.add(task.id)
      return task.dependencies.some(id => {
        const identities = this.rt.dependencyIdentities(missionId, id, tasks)
        return identities.has(sourceId) || tasks.some(parent => identities.has(parent.id) && covers(parent, sourceId, seen))
      })
    }
    if (!tasks.some(task => task.kind === 'integration')) {
      // A single reviewed implementation is the deliverable when the plan needed no assembly step.
      if (implementations.length === 1 && implementations[0]!.artifact) return implementations[0]!
      throw new Error('A unique independently accepted implementation artifact is required when the plan has no integration task')
    }
    const candidates = tasks.filter(task => task.kind === 'integration' && task.status === 'accepted' && task.artifact && implementations.every(source => covers(task, source.id)))
    // A later integration may subsume an earlier one; never guess among independent final artifacts.
    const finals = candidates.filter(candidate => !candidates.some(other => other.id !== candidate.id && covers(other, candidate.id)))
    if (finals.length !== 1) throw new Error('A unique accepted integration of all implementation results is required')
    return finals[0]!
  }

  /** One completion policy is shared by manual controls and automatic requests. */
  deliveryTarget(actor: Actor, missionId: string): { mission: Mission; task: Task } {
    actor.signal?.throwIfAborted()
    if (this.rt.shuttingDown) throw new Error('Swarm runtime is shutting down')
    const mission = this.rt.mission(missionId)
    if (mission.ownerSessionId !== actor.sessionId || this.rt.isWorkerSession(actor.sessionId)) throw new Error('Only the mission owner can access deliverables')
    if (mission.status !== 'completed') throw new Error('Complete independent acceptance before applying results')
    if (!mission.baseline) throw new Error('This historical mission has no saved delivery baseline; inspect its retained artifact')
    return { mission, task: this.selectDeliveryTarget(missionId, this.rt.store.list('tasks', missionId)) }
  }

  /** One durable pass row per mission; the row is the guard, never an in-memory Set. */
  passKey(missionId: string): string { return `pass_${missionId}` }

  /**
   * The pass that may still hold the guard. Re-read from the store on every
   * call: a `running` row older than the declared bound is NOT a guard, so a
   * pass that never returns cannot swallow the tick timer's liveness action.
   * While the mission has live work (a renewed lease, an in-flight quiescence)
   * the row keeps gating past the bound: the pass may legitimately be inside a
   * long adapter await for that live attempt.
   */
  livePass(missionId: string): SchedulingPass | undefined {
    const row = this.rt.store.get('passes', this.passKey(missionId))
    if (row === undefined || row.missionId !== missionId) return undefined
    if (row.instanceId !== this.instanceId) return undefined
    if (row.status !== 'running') return undefined
    if (Date.now() - row.startedAt < this.rt.stallPassTimeoutMs) return row
    // Past the bound the row is a guard only while the mission has live work to
    // progress. With no live work it is not a guard at all, so the tick timer's
    // kick is never swallowed; the watchdog releases and escalates it.
    return this.hasLiveWork(missionId) ? row : undefined
  }

  /** Open a pass and record it durably before any scheduling work starts. */
  openPass(missionId: string): SchedulingPass | undefined {
    if (this.rt.closed || this.rt.shuttingDown) return undefined
    if (this.rt.store.get('missions', missionId) === undefined) return undefined
    if (this.livePass(missionId) !== undefined) return undefined
    const prior = this.rt.store.get('passes', this.passKey(missionId))
    const pass: SchedulingPass & ReleasedPassFields = {
      // One row per mission, overwritten each pass: `get(passKey)` is the gate.
      id: this.passKey(missionId), runId: id('run'), instanceId: this.instanceId, missionId, status: 'running', startedAt: Date.now(),
      revisionBefore: this.rt.store.revision(), fingerprintBefore: this.rt.fingerprint(missionId),
      noProgressPasses: prior?.status === 'finished' ? prior.noProgressPasses : 0,
    }
    // S5c: the durable release record survives the once-per-pass overwrite.
    const priorRelease = prior === undefined ? undefined : releasedPassFields(prior)
    if (priorRelease?.releasedRunId !== undefined) {
      pass.releasedRunId = priorRelease.releasedRunId
      pass.releasedAt = priorRelease.releasedAt
    }
    this.rt.commit(missionId, () => this.rt.store.put('passes', pass))
    return pass
  }

  /**
   * Close a pass: record `(fingerprint-before, fingerprint-after)` and
   * `(revision-before, revision-after)`, count consecutive passes that advanced
   * nothing and terminated nothing, and escalate once the declared window of
   * such passes has been reached. Never throws: pass bookkeeping must not break
   * scheduling.
   */
  closePass(missionId: string, pass: SchedulingPass): void {
    try {
      // A graceful shutdown must still release the guard: skipping this write
      // leaves a `running` row behind that the next runtime would treat as live.
      if (this.rt.closed) return
      const row = this.rt.store.get('passes', this.passKey(missionId))
      // Compare the per-run identity, never the stable row key: another pass may
      // have overwritten the row while this body was in flight.
      if (row?.runId !== pass.runId) return
      const revisionAfter = this.rt.store.revision()
      const fingerprintAfter = this.rt.fingerprint(missionId)
      const progressed = fingerprintAfter !== pass.fingerprintBefore
      const noProgressPasses = progressed ? 0 : pass.noProgressPasses + 1
      const closed: SchedulingPass & ReleasedPassFields = { ...pass, status: 'finished', finishedAt: Date.now(), revisionAfter, fingerprintAfter, noProgressPasses }
      // S5c: never erase a release record the watchdog wrote for this same row.
      const rowRelease = releasedPassFields(row)
      if (rowRelease.releasedRunId !== undefined && closed.releasedRunId === undefined) {
        closed.releasedRunId = rowRelease.releasedRunId
        closed.releasedAt = rowRelease.releasedAt
      }
      this.rt.commit(missionId, () => this.rt.store.put('passes', closed))
      // Change-and-return: the board left the no-progress class, so a later
      // return to it re-notifies instead of staying silent behind a stale key.
      const mission = this.rt.store.get('missions', missionId)
      if (progressed && mission?.schedulingStallNotice !== undefined) {
        delete mission.schedulingStallNotice
        this.rt.commit(missionId, () => this.rt.store.put('missions', mission))
      }
      if (!progressed && noProgressPasses >= this.rt.stallPasses && this.boardCannotProgress(missionId)) {
        this.escalateSchedulingStall(missionId, { pass: closed, reason: 'no-progress', boundMs: this.rt.config.tickMs * this.rt.stallPasses, revisionNow: revisionAfter, fingerprintNow: fingerprintAfter })
      }
    } catch { /* A closed store or a concurrent owner transition must not break scheduling. */ }
  }

  /**
   * True while `pass` still owns the mission's guard (used to fence an abandoned
   * pass body). Only an explicit release after the declared bound stops a body:
   * a long pass that is still making progress (a live lease, an in-flight
   * quiescence) keeps running, while an abandoned one must never dispatch into
   * the newer pass's turn.
   *
   * S5c: the DURABLE `releasedRunId` on the pass row is the authority — the
   * watchdog writes it when it releases, and `openPass` carries it forward
   * across the once-per-pass overwrite — so clearing the in-memory Set cannot
   * let a released body resume (the verifier's reproduction). The Set is only
   * the fast path for the same durable fact.
   */
  passReleased(pass: SchedulingPass | undefined): boolean {
    if (pass === undefined) return false
    const row = this.rt.store.get('passes', this.passKey(pass.missionId))
    if (row !== undefined && releasedPassFields(row).releasedRunId === pass.runId) return true
    return this.releasedPasses.has(pass.runId)
  }

  /**
   * S1/S2: the wedge detector. Runs from the tick timer, outside every mission
   * queue and outside the pass it watches. A pass still `running` past the
   * declared bound is declared stalled: the durable stall event is committed,
   * the owner notice is delivered by an unqueued flush, and the guard is
   * released (both the durable row and the in-memory serialization chain) so the
   * next tick is not swallowed.
   */
  checkSchedulingPasses(): void {
    if (this.rt.closed || this.rt.shuttingDown) return
    const now = Date.now()
    for (const mission of this.rt.store.list('missions')) {
      if (this.rt.isMissionTerminal(mission)) continue
      const pass = this.rt.store.get('passes', this.passKey(mission.id))
      if (pass === undefined || pass.instanceId !== this.instanceId || pass.status !== 'running') continue
      if (now - pass.startedAt < this.rt.stallPassTimeoutMs) continue
      if (this.rt.store.get('passes', this.passKey(mission.id))?.runId !== pass.runId) continue
      // A live lease or an in-flight quiescence is progress: a long pass that is
      // still working must not be abandoned. It is re-evaluated on later ticks
      // and released once that work has lapsed, so the window is still bounded.
      if (this.hasLiveWork(mission.id)) continue
      const unschedulable = this.unschedulable(mission, this.rt.store.list('tasks', mission.id), this.rt.store.list('members', mission.id)).map(task => `${task.id} (${task.status})`)
      const fingerprintNow = this.rt.fingerprint(mission.id)
      const closed: SchedulingPass & ReleasedPassFields = {
        ...pass, status: 'finished', finishedAt: now, revisionAfter: this.rt.store.revision(), fingerprintAfter: fingerprintNow,
        stalled: { reason: 'pass-timeout', at: now, boundMs: this.rt.stallPassTimeoutMs, unschedulable },
      }
      // S5c: the release is recorded DURABLY on the row before anything else, so
      // `passReleased` reads it and the fence survives a cleared Set, a restart,
      // or the once-per-pass overwrite (openPass carries it forward).
      closed.releasedRunId = pass.runId
      closed.releasedAt = now
      // Release both halves of the guard: the durable row stops gating and the
      // in-memory chain no longer queues later ticks behind a promise that never
      // settles. A newer pass that has already registered its own chain entry is
      // never clobbered (its `exclusive` finally compares identity).
      this.releasedPasses.add(pass.runId)
      this.rt.queues.delete(mission.id)
      this.rt.commit(mission.id, () => this.rt.store.put('passes', closed))
      this.escalateSchedulingStall(mission.id, { pass: closed, reason: 'pass-timeout', boundMs: this.rt.stallPassTimeoutMs, revisionNow: closed.revisionAfter!, fingerprintNow })
    }
  }

  /**
   * Commit the durable stall event and, when the state is otherwise silent,
   * deliver the owner notice. Dedup is the existing fingerprint semantics: the
   * same unchanged board never escalates twice (the durable
   * `schedulingStallNotice` key), and a board that changes and returns does. A
   * fresh witness another path already emitted for this exact fingerprint
   * (`mission.witness`, the board-level stall notice or the coverage notice)
   * suppresses the escalation entirely: that state is already escalated, so a
   * second durable event for it would be duplicate evidence, not new evidence.
   */
  escalateSchedulingStall(missionId: string, info: { pass: SchedulingPass; reason: 'pass-timeout' | 'no-progress'; boundMs: number; revisionNow: number; fingerprintNow: string }): void {
    const mission = this.rt.store.get('missions', missionId)
    if (mission === undefined || this.rt.isMissionTerminal(mission) || mission.status !== 'active') return
    const fingerprint = info.fingerprintNow
    if (mission.schedulingStallNotice === fingerprint) return
    const witnessed = mission.stallNotice === fingerprint || mission.coverageNotice === fingerprint || mission.witness?.fingerprint === fingerprint
    if (witnessed) return
    const unschedulable = info.pass.stalled?.unschedulable ?? this.unschedulable(mission, this.rt.store.list('tasks', missionId), this.rt.store.list('members', missionId)).map(task => `${task.id} (${task.status})`)
    const passes = info.pass.noProgressPasses
    const stateUnchanged = info.pass.fingerprintBefore === fingerprint
    mission.schedulingStallNotice = fingerprint
    mission.updatedAt = Date.now()
    mission.witness = { fingerprint, kind: 'W3', at: Date.now() }
    this.rt.commit(missionId, () => {
      this.rt.store.put('missions', mission)
      // Reuse the registered board-stall event rather than inventing a new type:
      // `cause: 'scheduling-pass'` and `wedged` make the pass-level escalation
      // distinguishable in the durable log and in every existing read path.
      this.rt.store.event(missionId, 'mission/stalled', 'runtime', {
        cause: 'scheduling-pass',
        passId: info.pass.id, runId: info.pass.runId,
        reason: info.reason === 'pass-timeout'
          ? `scheduling pass did not return within its ${info.boundMs}ms bound and advanced no durable state`
          : `no durable state change for ${passes} consecutive scheduling passes`,
        wedged: info.reason === 'pass-timeout',
        passStartedAt: info.pass.startedAt, passes, boundMs: info.boundMs,
        revisionBefore: info.pass.revisionBefore, revisionAtStall: info.revisionNow,
        missionFingerprint: fingerprint, stateUnchanged, unschedulable, ownerNotified: true,
      })
      this.rt.notify(missionId, info.reason === 'pass-timeout'
        ? `Scheduling pass ${info.pass.id} for mission ${missionId} did not return within ${info.boundMs}ms and produced no durable state change (fingerprint ${fingerprint.slice(0, 12)}). The runtime released the mission's scheduling guard so later ticks proceed; unschedulable: ${unschedulable.join(', ') || 'none'}.`
        : `Mission ${missionId} left its durable state unchanged for ${passes} consecutive scheduling passes (window ${info.boundMs}ms, revision ${info.pass.revisionBefore} → ${info.revisionNow}, fingerprint ${fingerprint.slice(0, 12)}) and terminated nothing. Unschedulable: ${unschedulable.join(', ') || 'none'}. Decide: admit work with swarm_propose, adjust the budget, or complete/stop the mission.`)
    })
    // The notice path must not share the fate of the pass that could not report
    // it: the queue-external pump delivers it, never the wedged mission queue.
    this.rt.pumpOutbox()
  }

  /**
   * The no-progress escalation is a backstop for a pass that completed without
   * advancing or terminating, so it may only fire for a board the runtime
   * already classifies as unable to progress: `stalled` is the same predicate
   * the board-level witness uses, and it returns false while any task runs under
   * a live lease, while a stop acknowledgement is in flight, and while a
   * submitted artifact is still inside the documented review grace. In
   * particular a member the adapter reports busy is working, not stalled — a
   * false stall notice is a defect of the same severity as a missing one.
   */
  boardCannotProgress(missionId: string): boolean {
    const mission = this.rt.store.get('missions', missionId)
    if (mission === undefined || mission.status !== 'active') return false
    return this.stalled(mission, this.rt.store.list('tasks', missionId), this.rt.store.list('members', missionId))
  }

  /**
   * A live lease renewed by recorded operations, or a stop whose acknowledgement
   * is in flight, is progress: the runtime must not report a stall while one
   * exists (a false stall notice is a defect of the same severity as a missing
   * one). A lease is only live while `leaseUntil` is in the future, so a pass
   * that wedged long enough for every lease to lapse is still detected.
   */
  hasLiveWork(missionId: string): boolean {
    const now = Date.now()
    return this.rt.store.list('tasks', missionId).some(task =>
      this.quiescencePending(task)
      || (task.status === 'running' && task.attempt !== undefined && task.attempt.leaseUntil >= now))
  }

  /**
   * F2: the board makes no progress except for submitted work. Unlike `stalled`,
   * a submitted task is not progress: an artifact whose review path is broken
   * can never reach a verdict by itself.
   */
  reviewPathStalled(tasks: Task[], members: Member[]): boolean {
    if (tasks.some(task => task.status === 'running' || this.quiescencePending(task))) return false
    const live = members.filter(member => member.status !== 'stopped')
    return !tasks.some(task => task.status === 'pending' && live.some(member => this.ready(task, member, tasks)))
  }

  /** R5-02: deterministic next live member for re-routed work, preferring the planned assignee. */
  rerouteTarget(missionId: string, task: Task, failedId: string): Member | undefined {
    const candidates = this.rt.store.list('members', missionId)
      .filter(member => member.id !== failedId && member.status !== 'stopped' && this.capable(task, member))
    const planned = task.plannedAssigneeId === undefined ? undefined : candidates.find(member => member.id === task.plannedAssigneeId)
    return planned ?? candidates.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  }
}
