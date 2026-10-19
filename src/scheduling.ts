/**
 * The scheduling seam: the in-memory pass guard (open/close and the wedge
 * watchdog), the dispatch sweep of one serialized pass and the attempt
 * reporting bound. M1a seam 7/7, the top one: it stands on the kernel with the
 * runtime's worker start and assignment, the notices, the attempts, the
 * workspace admission and the refusals. The readiness, review and stall
 * predicates the sweep asks are functions of the board (src/board.ts); the
 * sweep reads the board where it decides, after each of its awaits.
 */
import { id } from './store.ts'
import { TERMINAL_STATES, holdsOpenAttempt, openAttempt, pendingStopOwner, quiescencePending, subjectsOfTasks, taskSubject, terminal, turnEnded } from './task-graph.ts'
import { asksHandle, eligible, isolationViolation, noticeSubjectsFor, overdueStop, startBlocker, stillDispatchable, takesWork, unschedulable } from './board.ts'
import { factKey, type Notices } from './notices.ts'
import { AdmissionRefusedError } from './scheduler.ts'
import { awaited, formatSpan, progressed, type Kernel, type PassState, type SchedulingPass } from './kernel.ts'
// R17-G6/G7: the one derivation of the derived member status.
import { memberPhaseOf } from './projection.ts'
import type { Attempts } from './attempts.ts'
import type { WorkspaceAdmission } from './workspace-admission.ts'
import type { RefusalRegistry } from './refusals.ts'
import { type Attempt, type Member, type Mission, type Task } from './types.ts'

/**
 * The kernel and the two runtime transitions a dispatch drives: a member's
 * worker start, which admission and recovery share, and a task's assignment,
 * which a member's claim shares. The runtime hands itself.
 */
export type DispatchKernel = Kernel & {
  startWorker(mission: Mission, member: Member, options: { pass?: SchedulingPass }): Promise<void>
  assign(task: Task, member: Member): Task
}

/** R16-D: the dedup-key family of the attempt reporting-bound escalation. */
const ATTEMPT_SILENCE_PREFIX = 'attempt-silent:'

/** R16-D: one live attempt whose durable progress is past its declared bound. */
interface SilentAttempt {
  taskId: string
  epoch: number
  /** The notice subject (`taskId@epoch`). */
  subject: string
  attemptId: string
  ownerId: string
  /** Newest durable row attributable to the attempt; 0 when only the dispatch exists. */
  lastDurableAt: number
  /** `now - lastDurableAt`. */
  silentMs: number
  boundMs: number
}


export class Scheduling {
  /**
   * The scheduling body queued or running per mission (see `SchedulingPass`).
   * It is removed only when that body settles, so `kick` never queues a second
   * body behind one the queue could not run anyway, and the tick watchdog reads
   * `startedAt` to name a body past its bound.
   */
  readonly passes = new Map<string, SchedulingPass>()

  constructor(private readonly k: DispatchKernel, private readonly notices: Notices, private readonly attempts: Attempts, private readonly workspaceAdmission: WorkspaceAdmission, private readonly refusals: RefusalRegistry) {}

  /**
   * The dispatch sweep of one serialized pass (M1a: moved out of `schedule`
   * unchanged). It returns false when the pass must be abandoned exactly where
   * the original early returns did: on shutdown or on a mission that stopped
   * being active during an adapter await (`halted`). It runs only inside the mission's
   * serial queue, so no other pass body runs while it awaits.
   *
   * A body also returns false at the next member boundary when the member it
   * just swept held it for a whole bound (`stallPassTimeoutMs`), and records
   * where it stopped (`stoppedBefore`). `kick` then queues the next body at
   * once, which starts from lease recovery and sweeps from that member onwards,
   * wrapping round to the ones before it. Each member's long awaits (a worker
   * start up to `workerStartTimeoutMs`, task preparation, a close-out capture)
   * therefore delay lease recovery, automatic completion and the budget check
   * by at most one such member, not by their sum over every member. A body
   * whose members each take less than a bound finishes its sweep, however long
   * the sweep takes in total. The chain of early stops is bounded: a chained
   * body's sweep ends before the member the chain started from (`chainFrom`),
   * so the body that completes the rotation returns true, runs the pass-end
   * steps (`ensureWitness`, `flushOutbox`) and the next body waits for the tick.
   * `pass` is the body's own record, handed down by `kick`; a direct call
   * without one never stamps progress and never stops early.
   */
  async dispatch(mission: Mission, missionId: string, pass?: SchedulingPass): Promise<boolean> {
        // The sweep's order is a read of rows: the board's members. R17-G1: each
        // member's step asks the predicates the board classifiers ask
        // (`eligible`, `startBlocker`), so no notice can describe a board the
        // dispatcher would act on differently, and it reads the board again
        // after each await, so it is never staler than the per-step store reads
        // it replaces.
        const { members, tasks } = this.k.boardOf(missionId)
        const from = pass?.sweepFrom === undefined ? -1 : members.findIndex(member => member.id === pass.sweepFrom)
        const rotation = from > 0 ? [...members.slice(from), ...members.slice(0, from)] : members
        const end = pass?.chainFrom === undefined ? -1 : rotation.findIndex((member, index) => index > 0 && member.id === pass.chainFrom)
        const order = end > 0 ? rotation.slice(0, end) : rotation
        // R15-A5: before it decides anything, the sweep has the adapter wake the
        // input each handle it may ask about holds that no driver will claim
        // (`WorkerAdapter.drainStrandedInbox`): the handle of each board member
        // that takes work (`takesWork`) and that a decision asks about
        // (`asksHandle`). A borrower's eligibility asks about its preferred
        // member, which a chained body's `order` can leave out, so the set is the
        // board's, not the body's. Every ask below then reads the handles that
        // step left, and asking drains nothing. It is the sweep's first adapter
        // call, so the sweep's guard comes first, and each drain is the first
        // link of its member's chain (`chainFailed`): a member whose drain threw
        // (`ended`) has no step in this sweep.
        if (this.halted(missionId)) return false
        const ended = new Set<string>()
        for (const member of members) if (takesWork(tasks, member) && asksHandle(member)) {
          try { this.k.workers.drainStrandedInbox(member.id) }
          catch (error) { if (!this.chainFailed(missionId, member, error)) return false; ended.add(member.id) }
        }
        let memberSince = this.k.now()
        for (const [index, member] of order.entries()) {
          if (this.halted(missionId)) return false
          if (pass !== undefined && index > 0 && this.k.now() - memberSince >= this.k.bounds.stallPassTimeoutMs) {
            pass.stoppedBefore = member.id
            // A chain whose start member is gone restarts from this body's first one.
            pass.chainFrom = end > 0 ? pass.chainFrom : order[0]!.id
            return false
          }
          memberSince = this.k.now()
          progressed(pass, this.k.now())
          if (ended.has(member.id) || !takesWork(this.k.store.list('tasks', missionId), member)) continue
          // Round 14: the member's step is the last link of its chain (`chainFailed`).
          try {
          // The isolation invariant is decided on the board, a refusal is
          // recorded, and only then is the member skipped or started.
          const beforeStart = this.k.boardOf(missionId), refused = isolationViolation(beforeStart, member)
          if (refused !== undefined) { this.workspaceAdmission.recordIsolation(beforeStart, refused); continue }
          try { await awaited(pass, this.k.startWorker(mission, member, { pass }), this.k.now) }
          catch (error) {
            // Disposing the adapter cancels in-flight starts. This is recoverable host
            // shutdown, not a permanent worker failure to persist across restart.
            if (this.halted(missionId)) return false
            continue
          }
          if (this.halted(missionId)) return false
          // R10-09/S3: a parked member is dispatchable. The adapter's idle
          // precondition can be false for a parked agent (a non-idle handle); an
          // assignment is exactly the fresh input that unparks it, so the runtime
          // must not let that precondition leave the board silent.
          const parkedMember = memberPhaseOf(member) === 'parked'
          // R15-A4/A5: the sweep and the owner-facing explanation ask the same
          // question (`startBlocker`), so a member the sweep skipped is never
          // described to the owner with a cause the sweep did not test. The
          // parked-member hatch keeps priority: a parked member is dispatchable.
          if (startBlocker(this.k.view, member) !== undefined) continue
          const board = this.k.boardOf(missionId)
          if (pendingStopOwner(board.tasks, member.id)) continue
          const open = openAttempt(board.tasks, member.id)
          if (open !== undefined) {
            // W6: the worker ended its turn with an open attempt. Nudge within a
            // bounded retry, then checkpoint the workspace and re-pend the task
            // instead of leaving it a zombie until lease expiry. A parked owner is
            // not an abandoned turn: the lease path re-pends it without a credit.
            if (!parkedMember && turnEnded(open)) await this.attempts.closeOutIdleAttempt(mission, member, open, pass)
            continue
          }
          const choices = board.tasks.filter(t => eligible(board, t, member)).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
          // R12-F9 (a task whose text assumes prior work no content-carrying edge
          // provides) is refused where a dependency set is written: plan
          // validation, propose() and the owner's `changes.dependencies`
          // amendment. Dispatch takes the first ready task as admitted.
          const task = choices[0]
          if (!task) continue
          try {
            // Revocation fencing: a mission whose human authorization was withdrawn
            // is blocked here, before any adapter prepares a workspace or checkout.
            this.refusals.assertAdmission(task, member)
            await awaited(pass, this.workspaceAdmission.assertWorkspaceAuthorized(this.k.mission(missionId), pass), this.k.now)
            // The adapter reports a recovery fallback from inside this call
            // (`preparationReported`), which stamps the body that marked the
            // member it prepares before the report commits.
            if (pass !== undefined) pass.preparing = member.id
            const { graph } = this.k.boardOf(missionId)
            try { await awaited(pass, this.k.workers.prepareTask(member, { ...task, epoch: task.epoch + 1 }, graph.effectiveDependencies(task), graph.reviewSource(task)), this.k.now) }
            finally { if (pass !== undefined) delete pass.preparing }
            if (this.halted(missionId)) return false
            const prepared = this.k.boardOf(missionId), fresh = stillDispatchable(prepared, task, member)
            if (fresh === undefined) continue
            // S7: decide the isolation invariant again on the board the external
            // preparation await left. A state change during it (a member added into
            // this worktree, a second running task admitted) is refused and
            // recorded here, never dispatched.
            const violation = isolationViolation(prepared, member)
            if (violation !== undefined) { this.workspaceAdmission.recordIsolation(prepared, violation); continue }
            this.k.assign(fresh, member)
          } catch (error) {
            // Admission control already wrote the durable refusal; the task stays
            // pending and a later tick re-evaluates it when a slot frees up.
            if (error instanceof AdmissionRefusedError) continue
            if (this.halted(missionId)) return false
            // A withdrawn authorization was fenced where it was detected, which
            // blocked this task, so the changed-task rule below skips it.
            const fresh = stillDispatchable(this.k.boardOf(missionId), task, member)
            if (fresh === undefined) continue
            // Retry only identified transient host failures, with durable bounded
            // backoff. Repeating unchanged deterministic work is not recovery.
            const reason = `Workspace or worker preparation failed: ${String(error).slice(0, Math.max(0, this.k.config.maxMessageChars - 650))}`
            const code = error instanceof Error && 'code' in error ? String(error.code) : ''
            const transient = ['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'ETIMEDOUT'].includes(code)
              || (error instanceof Error && error.name === 'ProcessTimeoutError')
            const attempts = (fresh.preparationFailure?.attempts ?? 0) + 1
            const limit = Math.max(1, Math.min(3, fresh.maxRecoveryAttempts ?? this.k.config.maxTasksPerMember))
            const retry = transient && attempts < limit
            fresh.preparationFailure = { reason, transient, attempts,
              ...(retry ? { retryAt: this.k.now() + Math.min(30_000, 1000 * 2 ** (attempts - 1)) } : {}) }
            fresh.output = `${reason}\n${retry ? 'The host will retry after bounded backoff.' : `Work remains preserved. Correct the reported condition, then resume this same task with swarm_control(action: "resume", taskId: "${fresh.id}", reason: "condition repaired").`}`
            fresh.epoch++
            fresh.status = retry ? 'pending' : 'blocked'
            this.k.commit(missionId, () => {
              this.k.store.put('tasks', fresh)
              this.k.store.event(missionId, 'task/preparation-failed', 'runtime', { taskId: fresh.id, epoch: fresh.epoch, reason, ...fresh.preparationFailure, status: fresh.status })
              if (retry) return
              this.k.store.event(missionId, 'task/blocked', 'runtime', { taskId: fresh.id, reason: fresh.output })
              this.notices.notify(missionId, fresh.output!, subjectsOfTasks([fresh], mission), { trigger: 'task/preparation-failed', reason })
            })
          }
          } catch (error) {
            if (!this.chainFailed(missionId, member, error)) return false
            continue
          }
        }
    return true
  }

  /**
   * Round 14: one member's guard chain must never abort the whole sweep. Each
   * link the sweep runs for a member (its drain step, then its step) ends the
   * chain here when it throws: no later link of it runs in that sweep, so the
   * work it holds waits for the owner's decision. Before this, a guard that
   * threw (the field evidence: "Member has uncommitted commits" while an owner
   * tried to preserve a cut-off attempt) propagated out of `dispatch`, the
   * scheduler only wrote it to stderr, and every later tick re-entered the
   * same throw: a dead end with no durable record and no exit. The throw is
   * the terminal element's input: escalate with a coded decision request, and
   * the sweep keeps dispatching the other members (true). On a halted sweep
   * (`halted`) the throw is the halt's, not a failure of the chain, and the
   * body is abandoned (false).
   */
  private chainFailed(missionId: string, member: Member, error: unknown): boolean {
    if (this.halted(missionId)) return false
    // The terminal of this member's chain, opened by this failure of the work
    // its request names: the same throw over that work on a later pass is the
    // request the owner already holds; other work or another failure is another.
    const detail = String(error), subjects = noticeSubjectsFor(this.k.boardOf(missionId), { memberId: member.id })
    this.notices.emitGuardTerminal(missionId, 'attempt_lease', { memberId: member.id, detail, subjects, localKey: factKey(missionId, { trigger: `dispatch-failed:${member.id}`, reason: detail, subjects }) })
    return true
  }

  /**
   * The sweep's guard, asked before each of its adapter calls that follows an
   * await or opens the sweep: it goes on only while the runtime is up and the
   * mission is active. A pause, a stop or a budget block commits outside the
   * mission queue, so one can land while the body awaits (lease recovery's
   * capture, a worker start, a preparation); a halted sweep asks and wakes
   * nothing more, and the body is abandoned.
   */
  private halted(missionId: string): boolean { return this.k.shuttingDown || this.k.mission(missionId).status !== 'active' }

  /**
   * The adapter reported from inside a member's `prepareTask` call (a recovery
   * fallback): when the body awaiting that call marked the member
   * (`SchedulingPass.preparing`), the report is the body's own progress, stamped
   * before the report commits.
   */
  preparationReported(missionId: string, memberId: string): void {
    const pass = this.passes.get(missionId)
    if (pass?.preparing === memberId) progressed(pass, this.k.now())
  }

  /** The mission's stable pass name, carried by the stall event (`passId`) and the owner notice. */
  passKey(missionId: string): string { return `pass_${missionId}` }

  /**
   * The pass that still owns the dispatcher's decisions: the body queued or
   * running for the mission, inside its declared bound and not yet named wedged.
   *
   * While the mission has live work (a renewed lease, an in-flight quiescence)
   * the body stays live inside the second, bounded window
   * (`stallPassReleaseBoundMs` = `stallPassTimeoutMs` + `stallPassLiveGraceMs`):
   * it may legitimately be inside a long adapter await for that live attempt.
   * R16-D: past that window it is not live however long a healthy sibling's
   * lease lives, and the watchdog names it. `kick` does not read this: it skips
   * while any body is queued or running, because the serial queue could not run
   * a second one anyway.
   */
  livePass(missionId: string): SchedulingPass | undefined {
    const pass = this.passes.get(missionId)
    if (pass === undefined || pass.escalatedAt !== undefined) return undefined
    const now = this.k.now()
    if (!this.pastBound(pass, now)) return pass
    // Past the declared pass bound the body is live only while the mission has
    // live work to progress AND the bounded live-work hold has not elapsed.
    if (now - pass.startedAt < this.k.bounds.stallPassReleaseBoundMs && this.hasLiveWork(missionId)) return pass
    return undefined
  }

  /**
   * The subjects whose live work keeps `hasLiveWork` true: a running attempt
   * under a live lease, or a task in its durable stop transition. The wedge
   * notice names them so the owner can see what held it, and that it preserved
   * them (it cancels no task, drops no attempt and changes no lease).
   */
  liveWorkHolders(missionId: string): Array<{ subject: string; memberId?: string }> {
    const now = this.k.now()
    const holders: Array<{ subject: string; memberId?: string }> = []
    for (const task of this.k.store.list('tasks', missionId)) {
      const live = quiescencePending(task) || (holdsOpenAttempt(task) && task.attempt.leaseUntil >= now)
      if (!live) continue
      const memberId = task.attempt?.ownerId ?? task.assigneeId
      holders.push({ subject: taskSubject(task), ...(memberId === undefined ? {} : { memberId }) })
    }
    return holders
  }

  /**
   * R15-D1/D2: a pass body that is still queued or running past its declared
   * bound. `livePass` deliberately keeps such a body live while the mission has
   * live work (a sibling lease, an in-flight stop acknowledgement), so the
   * watchdog does not name a pass that may legitimately be inside a long adapter
   * await. That hold must not silence another subject's clock: the notices
   * publish with the wedged branch while this is true, and the attempt-silence
   * escalation says the pass is wedged.
   *
   * Co-firing guards: `livePass` (still the generation owner inside the bounded
   * live-work window), the wedge watchdog (`checkSchedulingPasses`, which names
   * the body inside the declared bound or the bounded live-work window), the
   * notice publication (`passState`) and `hasLiveWork`. It stays
   * true from the first bound until the body settles, named or not.
   */
  passWedged(missionId: string): boolean {
    const pass = this.passes.get(missionId)
    return pass !== undefined && this.pastBound(pass)
  }

  /**
   * The one bound predicate: a body is past its bound once it has held the
   * mission for a whole `stallPassTimeoutMs`. The watchdog names it by this
   * (`checkSchedulingPasses`), the notices publish it wedged by this
   * (`passWedged`, `livePass`, `passState`) and the sweep stops it early by
   * this, so no instant exists at which one of them already acts on the bound
   * and another does not yet.
   */
  pastBound(pass: SchedulingPass, now = this.k.now()): boolean {
    return now - pass.startedAt >= this.k.bounds.stallPassTimeoutMs
  }

  /**
   * R17-G5: the pass state a committed transition publishes with, which the
   * notice publication reads through the closure the runtime hands `Notices`
   * (`Notices.publishTransition`). A body past its bound that has itself made
   * progress within the last bound (`progressAt`:
   * one of its own awaits returned, or it reached a member boundary) is not
   * sitting in the wedged await: it is running and reaches its own dispatch
   * question when it settles (or hands the unswept members to the next body),
   * so the transition publishes as inside a live pass. The wedged branch would
   * instead ask "was not dispatched this tick" about work the same sweep is
   * about to dispatch. Otherwise the body is live inside its bound (`livePass`)
   * and wedged past it (`passWedged`), as before; a body without progress for a
   * whole bound is wedged again, whatever a worker turn it woke commits.
   */
  passState(missionId: string): PassState {
    const pass = this.passes.get(missionId)
    const bound = this.k.bounds.stallPassTimeoutMs
    if (pass?.progressAt !== undefined && this.pastBound(pass, pass.progressAt) && this.k.now() - pass.progressAt <= bound) return { passLive: true, wedged: false }
    return { passLive: this.livePass(missionId) !== undefined, wedged: this.passWedged(missionId) }
  }

  /**
   * Record the scheduling body `kick` is about to queue, or return undefined
   * when one is already queued or running for the mission: the serial queue
   * could not start a second body before that one settles.
   */
  openPass(missionId: string): SchedulingPass | undefined {
    if (this.k.closed || this.k.shuttingDown) return undefined
    if (this.k.store.get('missions', missionId) === undefined) return undefined
    if (this.passes.has(missionId)) return undefined
    const pass: SchedulingPass = {
      id: this.passKey(missionId), operationId: id('operation'), missionId, startedAt: this.k.now(),
      revisionBefore: this.k.store.revision(), fingerprintBefore: this.k.fingerprint(missionId),
    }
    this.passes.set(missionId, pass)
    return pass
  }

  /**
   * R16-D: record the naming of a body past its bound, for the tick watchdog
   * (`checkSchedulingPasses`): the owner notice that names the body and the
   * live work that held it, and the durable stall event that carries the
   * notice's key.
   *
   * The deliveries ledger is the one record of the naming. Its fact is the
   * mission's unfinished work (the live work that held the body is part of it)
   * and each member's counted consecutive start failures, under its own
   * `scheduling-pass` family, so no other notice about those subjects can
   * consume it. A body whose fact the owner already holds writes nothing: a
   * wedge that recurs on that fact (a provider outage counts no start failure)
   * is told once, and a newly counted failure is a new fact (the member is one
   * failure nearer retirement, which bounds the renaming). A naming that did
   * not commit (a busy writer on that tick) throws, so the watchdog leaves the
   * body unnamed and the next tick retries.
   *
   * This revokes nothing: the operation queue keeps the body as the physical
   * owner until it actually returns, and a later kick is skipped until then.
   * The independent watchdog and outbox keep reporting the blocker.
   */
  private escalateWedge(mission: Mission, pass: SchedulingPass, heldByLiveWork: boolean, holders: Array<{ subject: string; memberId?: string }>): void {
    const missionId = mission.id
    const now = this.k.now()
    const board = this.k.boardOf(missionId), { tasks, members } = board
    // R15-A1/A2: a wedged pass names the work it never reached, so
    // the notice carries subjects even though `unschedulable` is legitimately
    // empty (nothing is unschedulable: the pass simply never ran to a decision).
    // Guard pair: scheduling-pass stall x stall-root classifier — both can fire for
    // one board, and each keeps its own subject and dedup key; the mission root is
    // the fallback only when the board has no non-terminal task left.
    const unreached = tasks.filter(task => !TERMINAL_STATES.has(task.status))
    // R16-D: the live work that held a naming to its second bound is unfinished
    // (`liveWorkHolders`: running, or blocked on its stop), so it is among these
    // subjects: the owner sees which subjects made the wait unavoidable, and
    // that the naming preserved them (it cancels no task, drops no attempt and
    // changes no lease). Guard pair: this naming x its wedged publication — the
    // classifier names what no live path advances, this names every unfinished task; both
    // carry task@epoch and neither consumes the other's dedup key.
    const subjects = subjectsOfTasks(unreached, mission)
    const failures = members
      .flatMap(member => member.startFailures === undefined ? [] : [`${member.id}:${member.startFailures}`])
    const reason = ['pass-timeout', ...failures].join(' ')
    const noticeKey = factKey(missionId, { trigger: 'scheduling-pass', reason, subjects })
    const fingerprint = this.k.fingerprint(missionId)
    const revision = this.k.store.revision()
    const bound = this.k.bounds.stallPassTimeoutMs
    const releaseBoundMs = heldByLiveWork ? this.k.bounds.stallPassReleaseBoundMs : bound
    const stuck = unschedulable(board).map(task => `${task.id} (${task.status})`)
    const heldText = heldByLiveWork && holders.length
      ? ` The naming was held to its ${releaseBoundMs}ms live-work bound by work that is preserved untouched: ${holders.map(holder => holder.memberId === undefined ? holder.subject : `${holder.subject} held by ${holder.memberId}`).join(', ')}.`
      : ''
    const unreachedText = unreached.length ? unreached.map(task => `${task.id} (${task.status})`).join(', ') : 'none'
    // R15-D2: when a subject of this escalation is a blocked task whose stop is
    // past its declared bound (or carries no recorded start), the escalation
    // states that row-supported fact — the wedged pass is exactly what makes
    // the stop unbounded.
    const stopFacts = unreached.flatMap(task => { const fact = overdueStop(board, task); return fact === undefined ? [] : [`${task.id} is blocked and ${fact}`] })
    const stopText = stopFacts.length ? ` Stop state: ${stopFacts.join('; ')}.` : ''
    this.notices.tell(missionId, `Scheduling pass ${pass.id} (run ${pass.operationId}) for mission ${missionId} did not return within ${bound}ms and produced no durable state change (fingerprint ${fingerprint.slice(0, 12)}). This pass keeps the mission's scheduling until the call it awaits returns at its own bound; the next pass then resumes from lease recovery. Unschedulable: ${stuck.join(', ') || 'none'}.${heldText} Work the pass never reached: ${unreachedText}.${stopText} Decide: inspect the named tasks, admit a repair with swarm_propose, or withdraw the blocking work with swarm_cancel.`, subjects,
      { dedupKey: noticeKey, reason }, () => {
      // Reuse the registered board-stall event rather than inventing a new type:
      // `cause: 'scheduling-pass'` and `wedged` make the pass-level escalation
      // distinguishable in the durable log and in every existing read path. It
      // exists only with the row its `noticeKey` names.
      this.k.store.event(missionId, 'mission/stalled', 'runtime', {
        cause: 'scheduling-pass',
        passId: pass.id, runId: pass.operationId,
        reason: `scheduling pass did not return within its ${bound}ms bound and advanced no durable state`,
        wedged: true,
        passStartedAt: pass.startedAt, boundMs: bound,
        revisionBefore: pass.revisionBefore, revisionAtStall: revision,
        missionFingerprint: fingerprint, stateUnchanged: pass.fingerprintBefore === fingerprint, unschedulable: stuck, noticeKey,
        // R16-D: what the wedge was measured against, whether live work held it,
        // and the subjects whose work it preserved. Nothing is released; the
        // `release*` names are kept for every existing reader and describe the
        // naming: `releasedAt` is the instant of the tick whose naming committed,
        // `releaseGapMs` how long the body had held the mission by then,
        // `releaseBoundMs` the bound the naming was measured against (the
        // live-work bound when live work held it) and `releasedWhileLive` whether
        // live work held it. `boundMs` keeps its original meaning (the pass's own
        // stall bound).
        releasedAt: now,
        releaseBoundMs,
        releaseGapMs: Math.max(0, now - pass.startedAt),
        releasedWhileLive: heldByLiveWork,
        liveSubjects: holders.map(holder => holder.subject),
      })
    })
  }

  /**
   * Close a pass when its body settles: remove the in-memory record (so the
   * next kick may queue a successor) and publish the pass end. R17-G5: the close
   * is a transition. While the pass was live, notices left its mid-pass commits
   * unpublished for the pass end to publish; that publication judges the board,
   * the one emitter of "it cannot progress".
   */
  closePass(missionId: string, pass: SchedulingPass): void {
    if (this.passes.get(missionId) === pass) this.passes.delete(missionId)
    if (!this.k.closed) this.notices.transition(missionId)
  }

  /**
   * S1/S2: the wedge detector. Runs from the tick timer, outside every mission
   * queue and outside the pass it watches. A body still queued or running past
   * the declared bound is named: the durable stall event is committed, the owner
   * notice is delivered by the tick's queue-external outbox pump, never by the
   * wedged mission queue, and the mission publishes as wedged until the body
   * settles. The queue keeps the body as the physical owner; each await it can
   * be in carries its own bound.
   *
   * R16-D: the naming is bounded even when the mission still has live work. A
   * live lease or an in-flight quiescence may be progress, so the body is not
   * named at the first bound; but a healthy sibling's lease must not own the
   * whole board's clock forever, so past `stallPassReleaseBoundMs` it is named
   * anyway, with the live work it was held by named and preserved untouched.
   * Co-firing guards, named: `livePass` (mirrors the same bound, so no notice
   * stays suppressed after the naming), the wedged publication (which judges
   * the board while the body is wedged and names what no live path advances), the
   * notice dedup (one naming per body and per naming fact) and the
   * lease-renewal path (the naming changes no task, attempt or lease). `now` is
   * the tick's one instant, read once for every body (`pastBound`).
   */
  checkSchedulingPasses(now = this.k.now()): void {
    if (this.k.closed || this.k.shuttingDown) return
    for (const [missionId, pass] of this.passes) {
      if (pass.escalatedAt !== undefined) continue
      const mission = this.k.store.get('missions', missionId)
      // A paused or blocked mission is not named now; the body stays unnamed and
      // the first tick after the owner resumes it names the body if it is still
      // held (the resume does not go through the mission queue).
      if (mission?.status !== 'active') continue
      if (!this.pastBound(pass, now)) continue
      const held = this.hasLiveWork(missionId)
      // Inside the second bound live work keeps the body live: a pass that may
      // legitimately be inside a long adapter await for that work is not named.
      // Past it the window is over, and the notice names the subject that held it.
      if (held && now - pass.startedAt < this.k.bounds.stallPassReleaseBoundMs) continue
      this.escalateWedge(mission, pass, held, held ? this.liveWorkHolders(missionId) : [])
      // The body counts as named once its naming fact is durable: written just
      // now, or held by the owner already. R17-G5: naming it is a transition
      // either way. It owes the wedged pass's own dispatch question and the
      // board its live window left unpublished, so a publication is queued that
      // runs with the wedged branch even if the body settles first.
      pass.escalatedAt = now
      this.notices.expectWedgedRelease(missionId)
    }
  }

  /**
   * A live lease renewed by recorded operations, or a stop whose acknowledgement
   * is in flight, is progress: the runtime must not report a stall while one
   * exists (a false stall notice is a defect of the same severity as a missing
   * one). A lease is only live while `leaseUntil` is in the future, so a pass
   * that wedged long enough for every lease to lapse is still detected.
   */
  hasLiveWork(missionId: string): boolean {
    const now = this.k.now()
    return this.k.store.list('tasks', missionId).some(task =>
      quiescencePending(task)
      || (holdsOpenAttempt(task) && task.attempt.leaseUntil >= now))
  }

  /* ----------------------------------------------------------------------- *
   * R16-D: the attempt reporting bound.
   *
   * A live lease is liveness bookkeeping, not progress. The runtime already
   * bounds one in-flight operation (F1, `operation-silent:`), but an attempt
   * whose member row records no operation at all had no clock: while the pass
   * runs, the lease eventually lapses and the existing recovery re-pends it;
   * while the pass is wedged, nothing evaluated it and nothing named it. This
   * guard gives the attempt itself a declared bound on durable progress and
   * escalates it by name from the queue-external tick.
   *
   * Durable progress is any durable row a reader can attribute to the attempt:
   * its own `task/claimed` event, a recorded tool run, a durable event naming
   * the task or the attempt, or a delivery naming them. A renewed lease is
   * deliberately NOT progress (the renewal path says so itself: "liveness
   * bookkeeping, not a new progress timestamp"), so a lease that stays alive
   * while nothing is recorded cannot mask the silence.
   *
   * Co-firing guards, named:
   *  - F1 operation silence (`operation-silent:`): while any operation is
   *    recorded on the member, that guard owns the attempt's clock; this one
   *    stays quiet rather than double-reporting the same attempt. (It is also
   *    the conservative half of the F1v D1/D2 pair: this guard never judges a
   *    live declared check or retry, where a wall-clock bound false-positived.)
   *  - the W6 idle close-out (`turnEnded`): an attempt whose turn
   *    ended is the close-out's, which nudges it and then checkpoints it with a
   *    coded terminal, so this guard stays quiet for exactly that attempt.
   *  - the parked member (`waiting`): `notifyParkedHolder` names the holder;
   *    the park is the owner's intent, not silence.
   *  - the budget pause: a deliberate host pause is not a stalled worker.
   *  - the wedge watchdog (`checkSchedulingPasses`): the tick this guard runs on
   *    is the same queue-external tick that names a wedged pass, so a pass that
   *    cannot run its own recovery sweep cannot hide the attempt.
   *  - the notice dedup: the key is `attempt-silent:<attemptId>:<lastDurableAt>`,
   *    so one silence escalates once and a recording re-arms the clock.
   * ----------------------------------------------------------------------- */

  /**
   * R16-D: one live attempt whose durable progress is past its declared bound.
   * `subject` is the attempt's task@epoch, the identity the escalation carries.
   */
  silentAttempt(task: Task, mission: Mission, now = this.k.now()): SilentAttempt | undefined {
    if (!holdsOpenAttempt(task)) return undefined
    const attempt = task.attempt
    const boundMs = this.k.bounds.attemptSilenceBoundMs
    if (boundMs <= 0) return undefined
    if (!Number.isSafeInteger(attempt.leaseUntil)) return undefined
    // Naming an attempt the W6 idle close-out acts on would double-report it
    // (the pair is pinned by R16-D5).
    if (turnEnded(task)) return undefined
    const member = this.k.store.get('members', attempt.ownerId)
    if (member === undefined || memberPhaseOf(member) === 'stopped' || memberPhaseOf(member) === 'parked') return undefined
    // F1's subject: any recorded in-flight operation means that guard owns this
    // attempt's clock. The durable member row is the record; this is the
    // conservative direction (it can only suppress, never invent, an escalation).
    if (member.activity !== undefined) return undefined
    const lastDurableAt = this.lastDurableAt(mission.id, task, attempt)
    const silentMs = now - lastDurableAt
    if (silentMs < boundMs) return undefined
    return { taskId: task.id, epoch: task.epoch, subject: taskSubject(task), attemptId: attempt.id, ownerId: attempt.ownerId, lastDurableAt, silentMs, boundMs }
  }

  /**
   * R16-D: the bounded sweep over one mission's live attempts. Runs from the
   * queue-external tick (`Runtime.sweepDecisions`) on every tick, before the
   * pass guard is consulted, so a wedged pass cannot hide an attempt that has
   * stopped reporting. Returns the number of escalations this call emitted.
   */
  sweepSilentAttempts(missionId: string): number {
    if (this.k.closed || this.k.shuttingDown) return 0
    const mission = this.k.store.get('missions', missionId)
    if (mission === undefined || mission.status !== 'active' || terminal(mission)) return 0
    // A deliberate budget pause is host policy, not a stalled worker: the pause
    // owns the board until the owner resumes it.
    if (mission.budgetPause !== undefined) return 0
    let fired = 0
    for (const task of this.k.store.list('tasks', missionId)) {
      const silent = this.silentAttempt(task, mission)
      if (silent === undefined) continue
      if (this.escalateSilentAttempt(mission, task, silent)) fired += 1
    }
    return fired
  }

  /** One durable owner escalation per silence; returns false when it was already named. */
  private escalateSilentAttempt(mission: Mission, task: Task, silent: SilentAttempt): boolean {
    const member = this.k.store.get('members', silent.ownerId)
    const name = member === undefined ? silent.ownerId : `${member.name} (${member.id})`
    const since = silent.lastDurableAt === 0 ? 'it was dispatched' : `durable row at ${silent.lastDurableAt}`
    // The pass state is part of the honesty of the claim: the same guard fires
    // whether or not the pass is running, and the reader must know which path
    // would otherwise have named the attempt.
    const pass = this.passes.get(mission.id)
    const passState = pass !== undefined && this.passWedged(mission.id)
      ? ` The mission's scheduling pass ${pass.operationId} is wedged past its ${this.k.bounds.stallPassTimeoutMs}ms bound, so the in-pass recovery sweep cannot run either.`
      : ''
    const message = `${name} has held task ${task.id} "${task.title}" at epoch ${task.epoch} (attempt ${silent.attemptId}) for ${formatSpan(silent.silentMs)} (${silent.silentMs}ms) with no durable report past its declared bound of ${formatSpan(silent.boundMs)} (${silent.boundMs}ms): no durable event, no task state transition and no recorded tool run names this attempt since ${since}; no operation is in flight and the idle close-out is not handling it.${passState} Nothing was stopped or re-pended by this notice: the attempt may still be working. Owner actions: inspect it with swarm_observe (taskId ${task.id}), send it input or finish it with swarm_handoff, raise attemptSilenceBoundMs if this silence is healthy, or withdraw the work with swarm_cancel. [witness: attempt-silent, subject ${silent.subject}, attempt ${silent.attemptId}, member ${silent.ownerId}, lastDurableAt ${silent.lastDurableAt}, silentMs ${silent.silentMs}, boundMs ${silent.boundMs}]`
    return this.notices.tell(mission.id, message, [taskSubject(task)], { noticeClass: 'stall', dedupKey: `${ATTEMPT_SILENCE_PREFIX}${silent.attemptId}:${silent.lastDurableAt}` })
  }

  /**
   * R16-D: the newest durable row a reader can attribute to one attempt. The
   * attempt's own `task/claimed` event is the floor, so a dispatch that recorded
   * nothing else measures its silence from the dispatch itself.
   */
  private lastDurableAt(missionId: string, task: Task, attempt: Attempt): number {
    let latest = 0
    for (const event of this.k.store.events(missionId, this.k.config.maxEvents)) {
      if (latest >= event.createdAt) continue
      if (event.type === 'task/claimed') {
        if (this.identityIn(event.data, task.id, attempt.id)) latest = event.createdAt
        continue
      }
      if (this.identityIn(event.data, task.id, attempt.id)) latest = Math.max(latest, event.createdAt)
    }
    for (const run of this.k.store.toolRuns(missionId, { attemptId: attempt.id })) latest = Math.max(latest, run.createdAt)
    for (const delivery of this.k.store.list('deliveries', missionId)) {
      if (delivery.attemptId === attempt.id || delivery.taskId === task.id) latest = Math.max(latest, delivery.createdAt)
    }
    return latest
  }

  /** Whether a durable payload names this task or this attempt anywhere in its (bounded) object tree. */
  private identityIn(data: unknown, taskId: string, attemptId: string, depth = 0): boolean {
    if (depth > 3) return false
    if (typeof data === 'string') return data === taskId || data === attemptId
    if (Array.isArray(data)) return data.some(item => this.identityIn(item, taskId, attemptId, depth + 1))
    if (data !== null && typeof data === 'object') return Object.values(data as Record<string, unknown>).some(item => this.identityIn(item, taskId, attemptId, depth + 1))
    return false
  }
}
