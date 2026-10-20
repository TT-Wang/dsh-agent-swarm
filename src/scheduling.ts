/**
 * The scheduling seam: the in-memory pass guard (open/close, the wedge
 * watchdog and the publication of committed transitions), the dispatch sweep
 * of one serialized pass and the attempt reporting bound. M1a seam 7/7, the top
 * one: it stands on the kernel with the runtime's worker start and assignment,
 * the notices, the attempts, the workspace admission and the refusals. A
 * body's standing is a verdict of the board (`wedgeVerdict`, `passState`),
 * and so are the readiness, review and stall predicates the sweep asks
 * (src/board.ts); the sweep reads the board where it decides, after each of
 * its awaits.
 */
import { id } from './store.ts'
import { TERMINAL_STATES, holdsOpenAttempt, openAttempt, pendingStopOwner, subjectsOfTasks, taskSubject, terminal, turnEnded } from './task-graph.ts'
import { asksHandle, eligible, isolationViolation, liveWork, noticeSubjectsFor, overdueStop, startBlocker, stillDispatchable, takesWork, unschedulable, type Board, type Bounds } from './board.ts'
import { factKey, guardTerminalNotice, silenceNotice, type Notice, type Notices, type SilentAttempt } from './notices.ts'
import { AdmissionRefusedError } from './scheduler.ts'
import { awaited, progressed, type Kernel, type SchedulingPass } from './kernel.ts'
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

/**
 * The scheduling pass state a committed transition is published with
 * (`passState`): a live pass that is not wedged owns the publication, and a
 * wedged one is published with the wedged branch (`Scheduling.transition`).
 */
export interface PassState { passLive: boolean; wedged: boolean }

/**
 * The one bound predicate: a body is past its bound once it has held the
 * mission for a whole `stallPassTimeoutMs` at `now`. A body's verdict reads it
 * (`wedgeVerdict`), and so does an attempt silence naming the pass
 * (`Scheduling.silentAttempt`), so no instant exists at which the watchdog
 * already names a body, or the publication judges with the wedged branch, and
 * another reader does not yet see it past its bound.
 */
export function pastBound(pass: SchedulingPass, bounds: Bounds, now: number): boolean {
  return now - pass.startedAt >= bounds.stallPassTimeoutMs
}

/** What one scheduling body is on a board at one instant (`wedgeVerdict`). */
export interface PassVerdict {
  /** S1/R15-D1: past its declared bound (`pastBound`). It stays so from the first bound until it settles, named or not. */
  wedged: boolean
  /** R16-D: the board's live work while the body is past its bound (`liveWork`), none inside it: what holds the body live, and what its naming names as preserved. */
  liveWork: Task[]
  /**
   * The body still owns the dispatcher's decisions: it is not named, and it is
   * inside its bound or, past it, held by that live work inside its release
   * bound (`stallPassReleaseBoundMs` = `stallPassTimeoutMs` +
   * `stallPassLiveGraceMs`), since it may legitimately be inside a long adapter
   * await for that work. R16-D: past the release bound it is not live however
   * long a healthy sibling's lease lives. An unnamed body that is not live is
   * the watchdog's to name (`Scheduling.checkSchedulingPasses`). `kick` does not
   * read this: it skips while any body is queued or running, because the serial
   * queue could not run a second one anyway.
   */
  live: boolean
}

/**
 * The verdict of one body on a board at `now` (the tick's one instant when the
 * watchdog asks, else the board's clock). The live work is read at the board's
 * clock: a lease is live while `leaseUntil` is not past.
 */
export function wedgeVerdict(pass: SchedulingPass, board: Pick<Board, 'tasks' | 'clock' | 'bounds'>, now = board.clock()): PassVerdict {
  const unnamed = pass.escalatedAt === undefined
  if (!pastBound(pass, board.bounds, now)) return { wedged: false, liveWork: [], live: unnamed }
  const work = liveWork(board)
  return { wedged: true, liveWork: work, live: unnamed && work.length > 0 && now - pass.startedAt < board.bounds.stallPassReleaseBoundMs }
}

/**
 * R17-G5: the pass state a committed transition is published with, the body
 * queued or running for the mission judged on its board. A body past its bound
 * that has itself made progress within the last bound (`progressAt`: one of its
 * own awaits returned, or it reached a member boundary) is not sitting in the
 * wedged await: it is running and reaches its own dispatch question when it
 * settles (or hands the unswept members to the next body), so the transition
 * publishes as inside a live pass. The wedged branch would instead ask "was not
 * dispatched this tick" about work the same sweep is about to dispatch.
 * Otherwise the body's verdict decides: live while it owns the decisions, and
 * wedged past its bound; a body without progress for a whole bound is wedged
 * again, whatever a worker turn it woke commits.
 */
export function passState(pass: SchedulingPass | undefined, board: Pick<Board, 'tasks' | 'clock' | 'bounds'>): PassState {
  if (pass === undefined) return { passLive: false, wedged: false }
  const now = board.clock()
  if (pass.progressAt !== undefined && pastBound(pass, board.bounds, pass.progressAt) && now - pass.progressAt <= board.bounds.stallPassTimeoutMs) return { passLive: true, wedged: false }
  const { live, wedged } = wedgeVerdict(pass, board, now)
  return { passLive: live, wedged }
}

/**
 * R16-D: what the naming of a body its verdict no longer counts live owes the
 * owner (`Scheduling.checkSchedulingPasses` records it): the notice that names
 * the body and the live work that held it, with the durable stall event that
 * carries the notice's key. `naming` is what the watchdog read where it named
 * the body: the instant, F(S) (`Kernel.fingerprint`) and the store revision.
 *
 * The deliveries ledger is the one record of the naming. Its fact is the
 * mission's unfinished work (the live work that held the body is part of it)
 * and each member's counted consecutive start failures, under its own
 * `scheduling-pass` family, so no other notice about those subjects can
 * consume it. A body whose fact the owner already holds writes nothing: a
 * wedge that recurs on that fact (a provider outage counts no start failure)
 * is told once, and a newly counted failure is a new fact (the member is one
 * failure nearer retirement, which bounds the renaming).
 */
export function wedgeNotice(board: Board, pass: SchedulingPass, verdict: PassVerdict, naming: { at: number; fingerprint: string; revision: number }): Notice {
  const { missionId, mission, tasks, members, bounds } = board
  const { at, fingerprint, revision } = naming
  // R15-A1/A2: a wedged pass names the work it never reached, so
  // the notice carries subjects even though `unschedulable` is legitimately
  // empty (nothing is unschedulable: the pass simply never ran to a decision).
  // Guard pair: scheduling-pass stall x stall-root classifier — both can fire for
  // one board, and each keeps its own subject and dedup key; the mission root is
  // the fallback only when the board has no non-terminal task left.
  const unreached = tasks.filter(task => !TERMINAL_STATES.has(task.status))
  // R16-D: the live work that held a naming to its second bound is unfinished
  // (`liveWork`: running, or blocked on its stop), so it is among these
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
  const bound = bounds.stallPassTimeoutMs
  const heldByLiveWork = verdict.liveWork.length > 0
  const releaseBoundMs = heldByLiveWork ? bounds.stallPassReleaseBoundMs : bound
  const stuck = unschedulable(board).map(task => `${task.id} (${task.status})`)
  // Each holder is named with the member holding it: its attempt's owner, else its assignee.
  const holders = verdict.liveWork.map(task => { const memberId = task.attempt?.ownerId ?? task.assigneeId; return memberId === undefined ? taskSubject(task) : `${taskSubject(task)} held by ${memberId}` })
  const heldText = heldByLiveWork ? ` The naming was held to its ${releaseBoundMs}ms live-work bound by work that is preserved untouched: ${holders.join(', ')}.` : ''
  const unreachedText = unreached.length ? unreached.map(task => `${task.id} (${task.status})`).join(', ') : 'none'
  // R15-D2: when a subject of this escalation is a blocked task whose stop is
  // past its declared bound (or carries no recorded start), the escalation
  // states that row-supported fact — the wedged pass is exactly what makes
  // the stop unbounded.
  const stopFacts = unreached.flatMap(task => { const fact = overdueStop(board, task); return fact === undefined ? [] : [`${task.id} is blocked and ${fact}`] })
  const stopText = stopFacts.length ? ` Stop state: ${stopFacts.join('; ')}.` : ''
  return { content: `Scheduling pass ${pass.id} (run ${pass.operationId}) for mission ${missionId} did not return within ${bound}ms and produced no durable state change (fingerprint ${fingerprint.slice(0, 12)}). This pass keeps the mission's scheduling until the call it awaits returns at its own bound; the next pass then resumes from lease recovery. Unschedulable: ${stuck.join(', ') || 'none'}.${heldText} Work the pass never reached: ${unreachedText}.${stopText} Decide: inspect the named tasks, admit a repair with swarm_propose, or withdraw the blocking work with swarm_cancel.`, subjects,
    options: { dedupKey: noticeKey, reason },
    // Reuse the registered board-stall event rather than inventing a new type:
    // `cause: 'scheduling-pass'` and `wedged` make the pass-level escalation
    // distinguishable in the durable log and in every existing read path. It
    // exists only with the row its `noticeKey` names.
    event: { type: 'mission/stalled', data: {
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
      releasedAt: at,
      releaseBoundMs,
      releaseGapMs: Math.max(0, at - pass.startedAt),
      releasedWhileLive: heldByLiveWork,
      liveSubjects: verdict.liveWork.map(task => taskSubject(task)),
    } } }
}

export class Scheduling {
  /**
   * The scheduling body queued or running per mission (see `SchedulingPass`).
   * It is removed only when that body settles, so `kick` never queues a second
   * body behind one the queue could not run anyway, and the tick watchdog reads
   * `startedAt` to name a body past its bound.
   */
  readonly passes = new Map<string, SchedulingPass>()
  /**
   * R17-G5: missions whose committed transitions still owe a publication
   * (`transition`). Transitions are coalesced within the current task (a burst
   * of commits from one synchronous operation publishes the FINAL state once),
   * then published from the pass state when the publication runs, never from
   * the sampled tick.
   */
  private readonly pendingTransitions = new Set<string>()
  private transitionScheduled = false
  /**
   * R17-G5: reentrancy guard. The judgement a publication runs commits its own
   * delivery rows, and those commits are not transitions of their own.
   */
  private publishingTransition = false
  /**
   * R17-G5: missions whose body was just named. The naming is the transition
   * that owes the dispatch question the wedged body never reached, so its
   * publication runs with the wedged branch even if the body settles before
   * that publication runs (`expectWedgedRelease`).
   */
  private readonly wedgedReleases = new Set<string>()

  constructor(private readonly k: DispatchKernel, private readonly notices: Notices, private readonly attempts: Attempts, private readonly workspaceAdmission: WorkspaceAdmission, private readonly refusals: RefusalRegistry) {}

  /**
   * The dispatch sweep of one serialized pass (M1a: moved out of `schedule`
   * unchanged). It returns false when the pass must be abandoned exactly where
   * the original early returns did: on shutdown or on a mission that stopped
   * being active during an adapter await (`activeBoard`). It runs only inside the mission's
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
        const swept = this.activeBoard(missionId)
        if (swept === undefined) return false
        const { members, tasks } = swept
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
        // call, so the sweep's guard (`activeBoard`) comes first, and each drain
        // is the first link of its member's chain (`chainFailed`): a member whose
        // drain threw (`ended`) has no step in this sweep.
        const ended = new Set<string>()
        for (const member of members) if (takesWork(tasks, member) && asksHandle(member)) {
          try { this.k.workers.drainStrandedInbox(member.id) }
          catch (error) { if (!this.chainFailed(missionId, member, error)) return false; ended.add(member.id) }
        }
        let memberSince = this.k.now()
        for (const [index, member] of order.entries()) {
          const reached = this.activeBoard(missionId)
          if (reached === undefined) return false
          if (pass !== undefined && index > 0 && this.k.now() - memberSince >= this.k.bounds.stallPassTimeoutMs) {
            pass.stoppedBefore = member.id
            // A chain whose start member is gone restarts from this body's first one.
            pass.chainFrom = end > 0 ? pass.chainFrom : order[0]!.id
            return false
          }
          memberSince = this.k.now()
          progressed(pass, this.k.now())
          if (ended.has(member.id) || !takesWork(reached.tasks, member)) continue
          // Round 14: the member's step is the last link of its chain (`chainFailed`).
          try {
          // The isolation invariant is decided on the board, a refusal is
          // recorded, and only then is the member skipped or started.
          const refused = isolationViolation(reached, member)
          if (refused !== undefined) { this.workspaceAdmission.recordIsolation(reached, refused); continue }
          try { await awaited(pass, this.k.startWorker(mission, member, { pass }), this.k.now) }
          catch (error) {
            // Disposing the adapter cancels in-flight starts. This is recoverable host
            // shutdown, not a permanent worker failure to persist across restart.
            if (this.activeBoard(missionId) === undefined) return false
            continue
          }
          const board = this.activeBoard(missionId)
          if (board === undefined) return false
          // R10-09/S3: a parked member is dispatchable. The adapter's idle
          // precondition can be false for a parked agent (a non-idle handle); an
          // assignment is exactly the fresh input that unparks it, so the runtime
          // must not let that precondition leave the board silent.
          const parkedMember = memberPhaseOf(member) === 'parked'
          // R15-A4/A5: the sweep and the owner-facing explanation ask the same
          // question (`startBlocker`), so a member the sweep skipped is never
          // described to the owner with a cause the sweep did not test. The
          // parked-member hatch keeps priority: a parked member is dispatchable.
          if (startBlocker(board.view, member) !== undefined) continue
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
            const prepared = this.activeBoard(missionId)
            if (prepared === undefined) return false
            const fresh = stillDispatchable(prepared, task, member)
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
            const failedOn = this.activeBoard(missionId)
            if (failedOn === undefined) return false
            // A withdrawn authorization was fenced where it was detected, which
            // blocked this task, so the changed-task rule below skips it.
            const fresh = stillDispatchable(failedOn, task, member)
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
   * the sweep keeps dispatching the other members (true). On an abandoned
   * sweep (`activeBoard`) the throw is the abandonment's, not a failure of the
   * chain, and the body is abandoned (false).
   */
  private chainFailed(missionId: string, member: Member, error: unknown): boolean {
    const board = this.activeBoard(missionId)
    if (board === undefined) return false
    // The terminal of this member's chain, opened by this failure of the work
    // its request names: the same throw over that work on a later pass is the
    // request the owner already holds; other work or another failure is another.
    const detail = String(error), subjects = noticeSubjectsFor(board, { memberId: member.id })
    this.notices.record(missionId, guardTerminalNotice(board, 'attempt_lease', { memberId: member.id, detail, subjects, localKey: factKey(missionId, { trigger: `dispatch-failed:${member.id}`, reason: detail, subjects }) }))
    return true
  }

  /**
   * The sweep's guard, asked where the sweep opens, at each member's boundary,
   * once a worker start or a preparation settles, and where a member's chain
   * fails: the board the sweep decides on there, while the runtime is up and
   * the mission is active, and undefined otherwise, which abandons the body. A
   * pause, a stop or a budget block commits outside the mission queue, so one
   * can land while the body awaits (lease recovery's capture, a worker start, a
   * preparation); an abandoned sweep asks and wakes nothing more. Shutdown is
   * asked first: a body a bounded shutdown left running reads no store that
   * shutdown may have closed.
   */
  private activeBoard(missionId: string): Board | undefined {
    if (this.k.shuttingDown) return undefined
    const board = this.k.boardOf(missionId)
    return board.mission.status === 'active' ? board : undefined
  }

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
   * Close a pass when its body settles: remove the in-memory record (so the
   * next kick may queue a successor) and publish the pass end. R17-G5: the close
   * is a transition. While the pass was live, the publication left its mid-pass
   * commits for the pass end to publish (`publish`); that publication judges
   * the board, the one emitter of "it cannot progress".
   */
  closePass(missionId: string, pass: SchedulingPass): void {
    if (this.passes.get(missionId) === pass) this.passes.delete(missionId)
    if (!this.k.closed) this.transition(missionId)
  }

  /**
   * R17-G5: publish the facts of ONE committed transition: the runtime's commit
   * funnel calls this after the transaction that changed the board
   * (`SwarmRuntime.commit`), and so do a body's close (`closePass`) and its
   * naming (`expectWedgedRelease`). The decision families then run against the
   * state the change produced rather than against a later sample of it. The
   * pass state decides the one branch that is only meaningful at the end of a
   * pass (the dispatcher's "ready but not dispatched" question): it runs
   * off-pass, and a wedged pass keeps its own subject. It is read when the
   * publication runs, so a body a kick opened after the commit owns that
   * commit's publication. The sampled tick path emits exactly two absence
   * instruments and no cause: the absence net (`Notices.absenceNet`) and the
   * attempt-silence escalation (`sweepSilentAttempts`, bounded by
   * `attemptSilenceBoundMs`).
   */
  transition(missionId: string): void {
    if (this.publishingTransition) return
    this.pendingTransitions.add(missionId)
    if (this.transitionScheduled) return
    this.transitionScheduled = true
    queueMicrotask(() => {
      this.transitionScheduled = false
      const pending = [...this.pendingTransitions]
      this.pendingTransitions.clear()
      for (const id of pending) this.publish(id)
    })
  }

  /** R17-G5: a body was just named, by a new row or by the one the owner holds: that is a transition, published with the wedged branch. */
  expectWedgedRelease(missionId: string): void { this.wedgedReleases.add(missionId); this.transition(missionId) }

  /**
   * R17-G5: publish one mission's committed transitions against its settled
   * state. A live pass owns the dispatcher's "ready but not dispatched"
   * question (R15-D3: generation must not invent the cause the pass is about to
   * resolve), so a live, un-wedged body's mid-pass commits are left to the
   * publication of its own close, which cannot describe a board the dispatcher
   * is still acting on. The question is asked by the transition that ends or
   * names the body, and by a wedged body, which never reached its own question:
   * the board is judged (`Notices.ensureWitness`) with the wedged branch while
   * the body is wedged (`passState`) or its naming is owed one.
   */
  private publish(missionId: string): void {
    if (this.publishingTransition) return
    this.publishingTransition = true
    try {
      const released = this.wedgedReleases.delete(missionId)
      const state = passState(this.passes.get(missionId), this.k.boardOf(missionId))
      if (state.passLive && !state.wedged && !released) return
      this.notices.ensureWitness(missionId, state.wedged || released ? { wedged: true } : {})
    } catch {
      // A generation failure must never break the commit that triggered it; the
      // next transition (or the absence net) re-derives the same facts.
    } finally {
      this.publishingTransition = false
    }
  }

  /**
   * S1/S2: the wedge detector. Runs from the tick timer, outside every mission
   * queue and outside the pass it watches. A body the verdict no longer counts
   * live (`wedgeVerdict`) is named: the durable stall event is committed, the
   * owner notice is delivered by the tick's queue-external outbox pump, never by
   * the wedged mission queue, and the mission publishes as wedged until the body
   * settles. The queue keeps the body as the physical owner; each await it can
   * be in carries its own bound.
   *
   * R16-D: the naming is bounded even when the mission still has live work. A
   * live lease or an in-flight quiescence may be progress, so the body is not
   * named at the first bound; but a healthy sibling's lease must not own the
   * whole board's clock forever, so past `stallPassReleaseBoundMs` it is named
   * anyway, with the live work it was held by named and preserved untouched
   * (`wedgeNotice`). The naming revokes nothing: the operation queue keeps the
   * body as the physical owner until it actually returns, and a later kick is
   * skipped until then. Co-firing guards, named: the verdict's `live` (the same
   * bound, so no notice stays suppressed after the naming), the wedged
   * publication (which judges the board while the body is wedged and names what
   * no live path advances), the notice dedup (one naming per body and per naming
   * fact) and the lease-renewal path (the naming changes no task, attempt or
   * lease). `now` is the tick's one instant, read once for every body.
   */
  checkSchedulingPasses(now = this.k.now()): void {
    if (this.k.closed || this.k.shuttingDown) return
    for (const [missionId, pass] of this.passes) {
      if (pass.escalatedAt !== undefined) continue
      const board = this.k.boardOf(missionId)
      // A paused or blocked mission is not named now; the body stays unnamed and
      // the first tick after the owner resumes it names the body if it is still
      // held (the resume does not go through the mission queue).
      if (board.mission.status !== 'active') continue
      // Inside its bound, or inside the release bound while live work holds it,
      // the body may legitimately be inside a long adapter await: not named.
      const verdict = wedgeVerdict(pass, board, now)
      if (verdict.live) continue
      // A naming that did not commit (a busy writer on that tick) throws, so the
      // body stays unnamed and the next tick retries. Its F(S) is the kernel's
      // digest of the board at this revision.
      this.notices.record(missionId, wedgeNotice(board, pass, verdict, { at: this.k.now(), fingerprint: this.k.fingerprint(missionId), revision: this.k.store.revision() }))
      // The body counts as named once its naming fact is durable: written just
      // now, or held by the owner already. R17-G5: naming it is a transition
      // either way. It owes the wedged pass's own dispatch question and the
      // board its live window left unpublished, so a publication is queued that
      // runs with the wedged branch even if the body settles first.
      pass.escalatedAt = now
      this.expectWedgedRelease(missionId)
    }
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
   *  - the parked member (`waiting`): `parkedHolder` names the holder;
   *    the park is the owner's intent, not silence.
   *  - the budget pause: a deliberate host pause is not a stalled worker.
   *  - the wedge watchdog (`checkSchedulingPasses`): the tick this guard runs on
   *    is the same queue-external tick that names a wedged pass, so a pass that
   *    cannot run its own recovery sweep cannot hide the attempt.
   *  - the notice dedup: the key is `attempt-silent:<attemptId>:<lastDurableAt>`,
   *    so one silence escalates once and a recording re-arms the clock.
   * ----------------------------------------------------------------------- */

  /**
   * R16-D: one live attempt whose durable progress is past its declared bound,
   * with the member row that holds it and, while this mission's scheduling pass
   * is past its bound (`pastBound`), that pass. The pass state is part of the honesty
   * of the claim: the same guard fires whether or not the pass is running, and
   * the reader must know which path would otherwise have named the attempt.
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
    const pass = this.passes.get(mission.id)
    return { family: 'attempt-silent', holder: member, subject: taskSubject(task), attemptId: attempt.id, lastDurableAt, silentMs, boundMs,
      ...(pass !== undefined && pastBound(pass, this.k.bounds, now) ? { wedgedPass: { operationId: pass.operationId, boundMs: this.k.bounds.stallPassTimeoutMs } } : {}) }
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
      if (this.notices.record(missionId, silenceNotice(task, silent))) fired += 1
    }
    return fired
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
