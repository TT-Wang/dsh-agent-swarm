/**
 * The scheduling seam: the readiness and stall predicates, the in-memory pass
 * guard (open/close and the wedge watchdog) and the dispatch sweep of one
 * serialized pass. M1a seam 7/7.
 *
 * Behaviour-identical to the code moved from src/runtime.ts; the runtime keeps
 * thin forwarding methods and `schedule` calls `dispatch` exactly where its
 * member loop used to be.
 */
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { selectAcceptedDelivery } from './task-graph.ts'
import { assignmentAllows, canBorrowTask } from './assignment.ts'
import { pendingStopOwner, stopPending } from './attempts.ts'
import { hasNotice } from './arena.ts'
import { subjectsOfTasks, taskSubject } from './notices.ts'
import { emitGuardTerminal, type GuardChainId, type GuardTerminal, type GuardTerminalContext } from './refusals.ts'
import { AdmissionRefusedError } from './scheduler.ts'
import { isolationIssues, WorkspaceRevokedError } from './workspace-admission.ts'
// R17-G6/G7: the one derivation of the derived member status.
import { memberPhaseOf } from './projection.ts'
import { PolicyError } from './policy-error.ts'
import type { SwarmRuntime } from './runtime.ts'
import { type Actor, type Attempt, type Member, type Mission, type Task } from './types.ts'

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
 * R15-A4: the dispatcher's answer to "why did this ready task not dispatch?",
 * asked per (task, assignee) after a pass. `holder` is present only when the
 * blocker is a member handle that still holds an unfinished turn; the mission
 * admission refusal has no holder. Both carry the task's subject and a dedup key
 * that belongs to the task and epoch, so an unrelated notice can never consume
 * this decision.
 */
export interface DispatchQuestion {
  task: Task
  holder?: Member
  message: string
  subjects: string[]
  dedupKey: string
}

/**
 * The scheduling body that is queued or running for one mission. `openPass`
 * (called by `kick`) records it before the body is queued on the mission's
 * serial queue (`SwarmRuntime.exclusive`), and `closePass` removes it when the
 * body settles, so at most one scheduling body per mission is queued or running.
 * It is in-memory on purpose: it describes an operation this process owns, and
 * a restarted process owns none. The durable row it replaces never gated or
 * named anything after a restart either (it carried the dead process's
 * instance id); it only carried the no-progress count, which now restarts with
 * the process.
 *
 * Why no release and no fence: the queue is strictly serial and a waiter past
 * its bound is refused, never run (`boundedQueueWait`), so a successor body
 * cannot start until this body settles; a wedged body can never write after its
 * successor starts. The watchdog therefore only names a body past its bound
 * (`checkSchedulingPasses`) and marks the mission wedged for notices; the body
 * itself ends at the bound of whichever await it is in (`workerStartTimeoutMs`,
 * the per-attempt delivery bound, each git subprocess's `HOST_GIT_TIMEOUT_MS`),
 * and once one of its own awaits has waited past its bound it stops at the next
 * member boundary so the next body resumes from lease recovery (`dispatch`).
 */
export interface SchedulingPass {
  /** The mission's stable pass name (`pass_<missionId>`), named by the stall event and the owner notice. */
  id: string
  /** This body's identity; the stall event and the owner notice name it as the run. */
  operationId: string
  missionId: string
  startedAt: number
  /** Store revision and mission digest when the pass was opened. */
  revisionBefore: number
  fingerprintBefore: string
  /** Consecutive earlier passes that changed no durable mission state. */
  noProgressPasses: number
  /** Set once the watchdog's naming of this body past its bound has committed; it is then wedged, not live. */
  escalatedAt?: number
  /**
   * The body's own last progress: when one of its own awaits returned (stamped
   * before it commits the result) or it reached a member boundary (`progressed`).
   * Only the body stamps it, with the record `kick` handed it, so a worker turn
   * one of its adapter calls woke commits without crediting the body; progress
   * proves the body is running, not sitting in an await (`passState`).
   */
  progressAt?: number
  /** The event loop's total idle time at the body's last stamp (`progressed`). */
  idleMs?: number
  /**
   * The last stamp at which the event loop had sat idle since the body's
   * previous stamp: the body was waiting on one of its own awaits, not
   * computing. Past the bound it stops the body early (`dispatch`).
   */
  waitedAt?: number
  /** The member this body's sweep starts from: the one its predecessor stopped before. */
  sweepFrom?: string
  /**
   * The member where the chain of early-stopped bodies this body belongs to
   * started. A chained body's sweep ends before it, so the chain covers at most
   * one rotation and its last body runs the pass-end steps.
   */
  chainFrom?: string
  /** Set when this body stopped early at a member boundary: the first member it did not sweep. */
  stoppedBefore?: string
}

/**
 * R16-D: what the watchdog measured when it named a wedged body: the whole
 * time the body had held the mission when it was named, the bound it was
 * measured against, and the live work that held the naming to its second bound.
 * The durable `mission/stalled` event carries these facts. Nothing is released:
 * the `release*` names are kept for the event's existing readers.
 */
interface WedgeRecord {
  /** The instant of the tick whose naming committed (a retried naming measures its own tick). */
  releasedAt: number
  /** `releasedAt - startedAt`: how long the body had held the mission when it was named. */
  gapMs: number
  /** The live subjects that held the naming to its second bound. */
  liveSubjects: string[]
}

/** R16-D: the dedup-key family of the attempt reporting-bound escalation. */
export const ATTEMPT_SILENCE_PREFIX = 'attempt-silent:'

/** R16-D: one live attempt whose durable progress is past its declared bound. */
export interface SilentAttempt {
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

/** Human form of an elapsed bound for a notice; the raw milliseconds stay on the witness. */
function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * A scheduling body's own progress stamp (`SchedulingPass.progressAt`). The body
 * calls it itself, with the record `kick` handed it, when it starts, at each
 * member boundary and when one of its own awaits returns (`awaited`). Nothing
 * else stamps it: commits made by a worker turn the body woke inside an adapter
 * call are that turn's, not the body's. Without a record (a direct `schedule`
 * or `dispatch` call) it does nothing.
 *
 * It also records whether the body waited since its previous stamp: the event
 * loop only idles while the body is suspended in an await with nothing left to
 * run, so time spent computing (the body's own or an adapter's synchronous
 * work) never counts as waiting (`waitedAt`).
 */
export function progressed(pass: SchedulingPass | undefined): void {
  if (pass === undefined) return
  const now = Date.now()
  const idleMs = performance.eventLoopUtilization().idle
  if (pass.idleMs !== undefined && idleMs > pass.idleMs) pass.waitedAt = now
  pass.progressAt = now
  pass.idleMs = idleMs
}

/**
 * One of a scheduling body's own awaits: `work` settles, the body stamps its
 * progress (`progressed`), and only then does it act on the result, so the
 * commit of that result publishes as a running body's.
 */
export function awaited<T>(pass: SchedulingPass | undefined, work: Promise<T>): Promise<T> {
  return pass === undefined ? work : work.finally(() => progressed(pass))
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
   * Consecutive no-progress passes per mission, carried from one pass to the
   * next for the S1 no-progress escalation. Its loss only restarts the count;
   * the escalation's dedup key is durable on the mission row.
   */
  private readonly noProgress = new Map<string, number>()
  /**
   * Identity of this runtime process in durable claims (the budget stop claim
   * in src/gates.ts). A claim written by a different instance is a crashed
   * process's leftover and never gates this runtime.
   */
  readonly instanceId = id('runtime')

  constructor(private readonly rt: SwarmRuntime) {}

  /**
   * The dispatch sweep of one serialized pass (M1a: moved out of `schedule`
   * unchanged). It returns false when the pass must be abandoned exactly where
   * the original early returns did: on shutdown or on a mission that stopped
   * being active during an adapter await. It runs only inside the mission's
   * serial queue, so no other pass body runs while it awaits.
   *
   * A body one of whose own awaits waited past its bound (`waitedAt`,
   * `pastBound`) also returns false at the next member boundary, after sweeping
   * at least one member, and records where it stopped (`stoppedBefore`). `kick`
   * then queues the next body at once, which starts from lease recovery and
   * sweeps from that member onwards, wrapping round to the ones before it. Each
   * member's long awaits (a worker start up to `workerStartTimeoutMs`, task
   * preparation, a close-out capture) therefore delay lease recovery, automatic
   * completion and the budget check by at most one such await, not by their sum
   * over every member. A body past its bound on computation alone (its own or
   * an adapter's synchronous work) does not stop: another body would only add
   * its own start-up work. The chain of early stops is bounded: a chained body's
   * sweep ends before the member the chain started from (`chainFrom`), so the
   * body that completes the rotation returns true, runs the pass-end steps
   * (`ensureWitness`, `flushOutbox`) and the next body waits for the tick.
   * `pass` is the body's own record, handed down by `kick`; a direct call
   * without one never stamps progress and never stops early.
   */
  async dispatch(mission: Mission, missionId: string, pass?: SchedulingPass): Promise<boolean> {
        // R17-G1: the dispatcher reads the SAME shared interpretation every
        // owner-facing generator consumes (`ready`, `dispatchable`, the task and
        // member rows), so no notice can describe a board the dispatcher would
        // act on differently. The view is rebuilt after each await, so it is
        // never staler than the per-step store reads it replaces.
        const members = this.rt.interpretation(missionId).members
        const from = pass?.sweepFrom === undefined ? -1 : members.findIndex(member => member.id === pass.sweepFrom)
        const rotation = from > 0 ? [...members.slice(from), ...members.slice(0, from)] : members
        const end = pass?.chainFrom === undefined ? -1 : rotation.findIndex((member, index) => index > 0 && member.id === pass.chainFrom)
        const order = end > 0 ? rotation.slice(0, end) : rotation
        for (const [index, member] of order.entries()) {
          if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
          if (pass?.waitedAt !== undefined && index > 0 && this.pastBound(pass, pass.waitedAt)) {
            pass.stoppedBefore = member.id
            // A chain whose start member is gone restarts from this body's first one.
            pass.chainFrom = end > 0 ? pass.chainFrom : order[0]!.id
            return false
          }
          progressed(pass)
          if (memberPhaseOf(member) === 'stopped') continue
          if (pendingStopOwner(this.rt.store.list('tasks', missionId), member.id)) continue
          // Round 14: one member's guard chain must never abort the whole sweep.
          // Before this, a guard that threw here (the field evidence: "Member has
          // uncommitted commits" while an owner tried to preserve a cut-off
          // attempt) propagated out of `dispatch`, the scheduler only wrote it to
          // stderr, and every later tick re-entered the same throw: a dead end
          // with no durable record and no exit. The throw is now the terminal
          // element's input: escalate with a coded decision request, then keep
          // dispatching the other members.
          try {
          if (!this.rt.isolationAllows(missionId, member)) continue
          try { await awaited(pass, this.rt.startWorker(mission, member)) }
          catch (error) {
            // Disposing the adapter cancels in-flight starts. This is recoverable host
            // shutdown, not a permanent worker failure to persist across restart.
            if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
            continue
          }
          this.rt.startFailures.delete(member.id)
          this.rt.clearProviderOutage(missionId, member.id)
          if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
          // R10-09/S3: a parked member is dispatchable. The adapter's idle
          // precondition can be false for a parked agent (a pending inbox item or a
          // non-idle handle); an assignment is exactly the fresh input that unparks
          // it, so the runtime must not let that precondition leave the board silent.
          const parkedMember = memberPhaseOf(member) === 'parked'
          // R15-A4/A5: the sweep and the owner-facing explanation ask the same
          // question (`startBlocker`), so a member the sweep skipped is never
          // described to the owner with a cause the sweep did not test. The
          // parked-member hatch keeps priority: a parked member is dispatchable.
          if (this.startBlocker(member) !== undefined) continue
          const view = this.rt.interpretation(missionId)
          if (pendingStopOwner(view.tasks, member.id)) continue
          const open = view.tasks.find(t => t.status === 'running' && t.attempt?.ownerId === member.id)
          if (open !== undefined) {
            // W6: the worker ended its turn with an open attempt. Nudge within a
            // bounded retry, then checkpoint the workspace and re-pend the task
            // instead of leaving it a zombie until lease expiry. A parked owner is
            // not an abandoned turn: the lease path re-pends it without a credit.
            // S5: the signal is re-read from the durable task row; the in-memory map
            // is only a cache for an attempt whose row write is still in flight.
            const durableIdle = open.idleSignal?.attemptId === open.attempt?.id
            const cachedIdle = this.rt.attempts.idleSignals.get(member.id)?.attemptId === open.attempt?.id
            if (!parkedMember && (durableIdle || cachedIdle)) await this.rt.closeOutIdleAttempt(mission, member, open, pass)
            continue
          }
          const all = view.tasks
          const ready = all.filter(t => view.ready(t, member)).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
          // R12-F9 (a task whose text assumes prior work no content-carrying edge
          // provides) is refused where a dependency set is written: plan
          // validation, propose() and the owner's `changes.dependencies`
          // amendment. Dispatch takes the first ready task as admitted.
          const task = ready[0]
          if (!task) continue
          try {
            // Revocation fencing: a mission whose human authorization was withdrawn
            // is blocked here, before any adapter prepares a workspace or checkout.
            this.rt.assertAdmission(task, member)
            await awaited(pass, this.rt.assertWorkspaceAuthorized(this.rt.mission(missionId)))
            await awaited(pass, this.rt.workers.prepareTask(member, { ...task, epoch: task.epoch + 1 }, this.rt.effectiveDependencies(missionId, task), task.reviewOf ? this.rt.task(missionId, task.reviewOf) : undefined))
            if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
            const fresh = this.rt.task(missionId, task.id)
            if (fresh.epoch !== task.epoch || fresh.assigneeId !== task.assigneeId || fresh.plannedAssigneeId !== task.plannedAssigneeId
              || fresh.assignmentMode !== task.assignmentMode || !this.ready(fresh, member)) continue
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
            if (error instanceof WorkspaceRevokedError) {
              this.rt.fenceWorkspace(missionId, error.diagnostic)
              // Round 14: the workspace chain's terminal element. `fenceWorkspace`
              // blocks the work and records the raw diagnostic; this adds the coded
              // decision request naming the executable exits, so a fenced mission
              // never ends with a record that has no way forward in it.
              this.escalateGuardTerminal(missionId, 'workspace', { taskId: task.id, detail: error.diagnostic })
              return false
            }
            const fresh = this.rt.task(missionId, task.id)
            if (fresh.epoch !== task.epoch || fresh.assigneeId !== task.assigneeId || fresh.plannedAssigneeId !== task.plannedAssigneeId
              || fresh.assignmentMode !== task.assignmentMode || !this.ready(fresh, member)) continue
            // Retry only identified transient host failures, with durable bounded
            // backoff. Repeating unchanged deterministic work is not recovery.
            const reason = `Workspace or worker preparation failed: ${String(error).slice(0, Math.max(0, this.rt.config.maxMessageChars - 650))}`
            const code = error instanceof Error && 'code' in error ? String(error.code) : ''
            const transient = ['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'ETIMEDOUT'].includes(code)
              || (error instanceof Error && error.name === 'ProcessTimeoutError')
            const attempts = (fresh.preparationFailure?.attempts ?? 0) + 1
            const limit = Math.max(1, Math.min(3, fresh.maxRecoveryAttempts ?? this.rt.config.maxTasksPerMember))
            const retry = transient && attempts < limit
            fresh.preparationFailure = { reason, transient, attempts,
              ...(retry ? { retryAt: Date.now() + Math.min(30_000, 1000 * 2 ** (attempts - 1)) } : {}) }
            fresh.output = `${reason}\n${retry ? 'The host will retry after bounded backoff.' : `Work remains preserved. Correct the reported condition, then resume this same task with swarm_control(action: "resume", taskId: "${fresh.id}", reason: "condition repaired").`}`
            fresh.epoch++
            fresh.status = retry ? 'pending' : 'blocked'
            this.rt.commit(missionId, () => {
              this.rt.store.put('tasks', fresh)
              this.rt.store.event(missionId, 'task/preparation-failed', 'runtime', { taskId: fresh.id, epoch: fresh.epoch, reason, ...fresh.preparationFailure, status: fresh.status })
              if (retry) return
              this.rt.store.event(missionId, 'task/blocked', 'runtime', { taskId: fresh.id, reason: fresh.output })
              this.rt.notify(missionId, fresh.output!, this.rt.interpretation(missionId).subjectsOf([fresh]), { from: 'runtime' })
            })
          }
          } catch (error) {
            if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
            this.escalateGuardTerminal(missionId, 'attempt_lease', { memberId: member.id, detail: String(error) })
            continue
          }
        }
    return true
  }

  /**
   * R15-A4/A5: the dispatcher's startability question for one member, shared by
   * the sweep and by the explanation `ensureWitness` gives the owner, so both
   * answer with the same predicate.
   *
   * Guards it can co-fire with:
   * - the parked-member hatch (`memberPhaseOf(member) === 'parked'`, R10-09/S3): a
   *   parked member is startable even when the adapter reports a pending inbox item,
   *   so the hatch wins here exactly as it does in `dispatch`;
   * - the adapter's `isIdle` precondition (`HarnessWorkers.isIdle`), which now
   *   drains a stranded `nextStep` item instead of stranding the member (R15-A5);
   * - the W6 open-attempt close-out, which owns a member that already has a
   *   running attempt — `dispatch` handles that member before it dispatches, and
   *   `dispatchQuestion` refuses to answer for a task with an open attempt.
   */
  startBlocker(member: Member): 'handle-busy' | undefined {
    if (memberPhaseOf(member) === 'parked') return undefined
    return this.rt.workers.isIdle(member.id) ? undefined : 'handle-busy'
  }

  /**
   * R15-A4: the dispatcher's own question, asked per (task, assignee) after a
   * pass that dispatched nothing, so the owner notice names the real cause and
   * the member whose handle holds the task instead of claiming an admission
   * refusal that was never recorded.
   *
   * Returns undefined — no owner decision — when:
   * - every dispatchable task carries an open attempt (the close-out path is
   *   already nudging it; W6 owns that state), or
   * - no eligible member exists at all (nothing is ready for a member; the board
   *   is someone else's witness, not this notice's).
   *
   * Otherwise the notice names a handle holder, a current prerequisite failure,
   * or an unexplained dispatch gap. An idle handle alone proves no budget refusal.
   * - `handle-busy`: every member eligible for the task is working by the
   *   adapter's contract. The named holder is the task's assignee when the task
   *   is pinned, else the first eligible member whose handle is busy;
   */
  dispatchQuestion(missionId: string, tasks: Task[], members: Member[], dispatchable: Task[]): DispatchQuestion | undefined {
    for (const task of dispatchable) {
      // An open attempt is not a dispatch candidate: the close-out path nudges it
      // (W6) or the lease path recovers it, and a second owner wake would be noise.
      if (task.attempt !== undefined) continue
      const eligible = members.filter(member => memberPhaseOf(member) !== 'stopped' && !pendingStopOwner(tasks, member.id) && this.ready(task, member, tasks))
      if (!eligible.length) continue
      const subjects = [taskSubject(task)]
      const dedupKey = `dispatch-question:${missionId}:${task.id}@${task.epoch}`
      if (eligible.some(member => this.startBlocker(member) === undefined)) {
        const issues = isolationIssues(members, tasks, (left, right) => this.rt.scopesOverlap(left, right))
        const startable = eligible.filter(member => this.startBlocker(member) === undefined)
        const isolated = startable.filter(member => !issues.some(issue => issue.memberIds.includes(member.id)))
        const detail = isolated.length === 0
          ? `Workspace isolation prevents dispatch: ${issues.filter(issue => startable.some(member => issue.memberIds.includes(member.id))).map(issue => issue.message).join(' ')} Inspect the named members and repair their isolated workspaces before retrying.`
          : 'An idle handle alone does not identify the dispatch blocker. Inspect the task and recorded admission/preparation diagnostics with swarm_observe; repair the reported cause or withdraw the task with swarm_cancel.'
        return { task, subjects, dedupKey,
          message: `Task ${task.id} (${task.title}, epoch ${task.epoch}) has an eligible idle member but was not dispatched this tick. ${detail}` }
      }
      const pinned = task.assigneeId === undefined ? undefined : eligible.find(member => member.id === task.assigneeId)
      const holder = pinned ?? eligible[0]!
      return { task, holder, subjects, dedupKey,
        message: `Task ${task.id} (${task.title}, epoch ${task.epoch}) is ready for member ${holder.name} (${holder.id})${pinned === undefined ? ', one of its eligible members,' : ', the member it is assigned to,'} whose worker handle still holds an unfinished turn, so the dispatcher cannot start it: no admission limit and no budget refusal was recorded for this board. The task is not undispatched for lack of an eligible member. Wait for that turn to end (the close-out path re-pends or completes it), amend this task's assigneeId with swarm_control(taskId: "${task.id}", action: "amend", changes: { assigneeId: "member id" }, reason: "reassign"), or withdraw it with swarm_cancel.` }
    }
    return undefined
  }

  /**
   * Round 14: the terminal element of a guard chain, made unconditional.
   *
   * A chain's earlier elements may each answer "no" for a good reason; when
   * every one of them has, this method is what runs. It has no condition of its
   * own: it always produces a `GuardTerminal` and always records a durable
   * decision request unless the *same* request for the *same* board fingerprint
   * is already durable. Dedup therefore means "this exact decision is already on
   * the record", never "stay silent and hope a later pass speaks".
   *
   * The notice is recorded through `notify`, which stamps the mission's W2
   * witness for this fingerprint: the board-level witness path cannot then emit
   * a second, differently-worded decision for the same state, so two individually
   * correct rules cannot multiply into a trap.
   */
  escalateGuardTerminal(missionId: string, chain: GuardChainId, context: GuardTerminalContext = {}): GuardTerminal | undefined {
    return emitGuardTerminal(this.rt, missionId, chain, context)
  }

  ready(task: Task, member: Member, tasks?: Task[]): boolean {
    return this.readinessBlocker(task, member, tasks) === undefined
  }

  /** The same readiness decision supplies a concrete refusal without another policy model. */
  readinessBlocker(task: Task, member: Member, tasks?: Task[]): string | undefined {
    if (task.status !== 'pending') return `task ${task.id} is ${task.status}; inspect its current attempt, artifact or recovery condition with swarm_observe(taskId)`
    if ((task.preparationFailure?.retryAt ?? 0) > Date.now()) return `preparation is backing off until ${task.preparationFailure!.retryAt}: ${task.preparationFailure!.reason}`
    if (task.assigneeId === undefined || task.assigneeId === member.id) return this.capabilityBlocker(task, member, tasks)
    if (!canBorrowTask(task)) return `task is bound to member ${task.assigneeId}; the owner can amend assigneeId when reassignment is appropriate`
    const all = tasks ?? this.rt.store.list('tasks', task.missionId)
    if (!assignmentAllows(task, member.id, all)) return `member ${member.id} is reserved as an independent reviewer and cannot borrow this source task`
    const incapable = this.capabilityBlocker(task, member, all)
    if (incapable !== undefined) return incapable
    // Keep useful context on the preferred member when it can take this work
    // now. A busy, stopping, retired or non-independent preference cannot reserve
    // an untouched task while another member is idle. This adds no reservation.
    const preferred = this.rt.store.get('members', task.assigneeId)
    const availableForBorrowing = preferred === undefined || memberPhaseOf(preferred) === 'stopped'
      || all.some(candidate => candidate.status === 'running' && candidate.attempt?.ownerId === preferred.id)
      || pendingStopOwner(all, preferred.id)
      || this.startBlocker(preferred) !== undefined
      || !this.capable(task, preferred, all)
    return availableForBorrowing ? undefined : `preferred member ${task.assigneeId} is available for this task; the owner can amend assigneeId to change the preference`
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
    return this.capabilityBlocker(task, member, tasks) === undefined
  }

  private capabilityBlocker(task: Task, member: Member, tasks?: Task[]): string | undefined {
    const waiting = task.dependencies.find(dep => !this.rt.dependencySatisfied(task.missionId, dep, tasks))
    if (waiting !== undefined) {
      const effective = this.rt.effectiveDependency(task.missionId, waiting, tasks)
      return `dependency ${waiting}${effective.id === waiting ? '' : ` (effective replacement ${effective.id})`} is ${effective.status}, not accepted; inspect it or amend the dependency plan`
    }
    if (task.reviewOf) {
      const source = this.rt.task(task.missionId, task.reviewOf)
      if (source.status !== 'submitted') return `review source ${source.id} is ${source.status}; review begins only after its artifact is submitted`
      if (this.rt.authorIds(source).has(member.id)) return `member ${member.id} authored review source ${source.id}; assign an independent reviewer`
    }
    return undefined
  }

  /**
   * Tasks that cannot be dispatched under the current plan: pending work whose dependency
   * lineage or review source is dead, reviews assigned to their own author, and
   * blocked work. This is a diagnostic for owner repair, not permission to
   * cancel obligations or mark the mission complete.
   */
  unschedulable(mission: Mission, tasks: Task[], members: Member[]): Task[] {
    const live = members.filter(member => memberPhaseOf(member) !== 'stopped')
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
              || !live.some(member => assignmentAllows(task, member.id, tasks) && !this.rt.authorIds(source).has(member.id))
          })())
          || (task.assigneeId !== undefined && !live.some(member => assignmentAllows(task, member.id, tasks)))
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
    return unreviewed.every(task => {
      const event = this.rt.store.latestTaskEvent(missionId, task.id, 'task/submitted')
      if (event !== undefined) return Date.now() - event.createdAt >= grace
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
    const live = members.filter(member => memberPhaseOf(member) !== 'stopped')
    return !tasks.some(task => task.status === 'pending' && live.some(member => this.ready(task, member, tasks)))
  }

  /**
   * A durable stop transition is in flight: the task is blocked only until the
   * old worker handle acknowledges the stop, then it re-pends. Every scheduler
   * and completion decision treats it as live work.
   */
  quiescencePending(task: Task): boolean { return task.status === 'blocked' && stopPending(task) }

  /** The runtime's unique deliverable among accepted artifacts; throws when none is unique. */
  selectDeliveryTarget(_missionId: string, tasks: Task[]): Task {
    return selectAcceptedDelivery(tasks)
  }

  /** One completion policy is shared by manual controls and automatic requests. */
  deliveryTarget(actor: Actor, missionId: string): { mission: Mission; task: Task } {
    actor.signal?.throwIfAborted()
    if (this.rt.shuttingDown) throw new PolicyError('runtime_shutting_down', 'conflict_error', 'Swarm runtime is shutting down')
    const mission = this.rt.mission(missionId)
    if (mission.ownerSessionId !== actor.sessionId || this.rt.isWorkerSession(actor.sessionId)) throw new PolicyError('delivery_owner_required', 'authorization_error', 'Only the mission owner can access deliverables')
    if (mission.status !== 'completed') throw new PolicyError('delivery_acceptance_required', 'tool_error', 'Complete independent acceptance before applying results')
    if (!mission.baseline) throw new PolicyError('delivery_baseline_missing', 'tool_error', 'This historical mission has no saved delivery baseline; inspect its retained artifact')
    return { mission, task: this.selectDeliveryTarget(missionId, this.rt.store.list('tasks', missionId)) }
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
    const now = Date.now()
    if (!this.pastBound(pass, now)) return pass
    // Past the declared pass bound the body is live only while the mission has
    // live work to progress AND the bounded live-work hold has not elapsed.
    if (now - pass.startedAt < this.rt.stallPassReleaseBoundMs && this.hasLiveWork(missionId)) return pass
    return undefined
  }

  /**
   * The subjects whose live work keeps `hasLiveWork` true: a running attempt
   * under a live lease, or a task in its durable stop transition. The wedge
   * notice names them so the owner can see what held it, and that it preserved
   * them (it cancels no task, drops no attempt and changes no lease).
   */
  liveWorkHolders(missionId: string): Array<{ subject: string; memberId?: string }> {
    const now = Date.now()
    const holders: Array<{ subject: string; memberId?: string }> = []
    for (const task of this.rt.store.list('tasks', missionId)) {
      const live = this.quiescencePending(task) || (task.status === 'running' && task.attempt !== undefined && task.attempt.leaseUntil >= now)
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
   * notice publication (`SwarmRuntime.passState`) and `hasLiveWork`. It stays
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
  pastBound(pass: SchedulingPass, now = Date.now()): boolean {
    return now - pass.startedAt >= this.rt.stallPassTimeoutMs
  }

  /**
   * R17-G5: the pass state a committed transition publishes with
   * (`SwarmRuntime.passState`, read by the notice publication). A body past its
   * bound that has itself made progress within the last bound (`progressAt`:
   * one of its own awaits returned, or it reached a member boundary) is not
   * sitting in the wedged await: it is running and reaches its own dispatch
   * question when it settles (or hands the unswept members to the next body),
   * so the transition publishes as inside a live pass. The wedged branch would
   * instead ask "was not dispatched this tick" about work the same sweep is
   * about to dispatch. Otherwise the body is live inside its bound (`livePass`)
   * and wedged past it (`passWedged`), as before; a body without progress for a
   * whole bound is wedged again, whatever a worker turn it woke commits.
   */
  passState(missionId: string): { passLive: boolean; wedged: boolean } {
    const pass = this.passes.get(missionId)
    const bound = this.rt.stallPassTimeoutMs
    if (pass?.progressAt !== undefined && this.pastBound(pass, pass.progressAt) && Date.now() - pass.progressAt <= bound) return { passLive: true, wedged: false }
    return { passLive: this.livePass(missionId) !== undefined, wedged: this.passWedged(missionId) }
  }

  /**
   * Record the scheduling body `kick` is about to queue, or return undefined
   * when one is already queued or running for the mission: the serial queue
   * could not start a second body before that one settles.
   */
  openPass(missionId: string): SchedulingPass | undefined {
    if (this.rt.closed || this.rt.shuttingDown) return undefined
    if (this.rt.store.get('missions', missionId) === undefined) return undefined
    if (this.passes.has(missionId)) return undefined
    const pass: SchedulingPass = {
      id: this.passKey(missionId), operationId: id('operation'), missionId, startedAt: Date.now(),
      revisionBefore: this.rt.store.revision(), fingerprintBefore: this.rt.fingerprint(missionId),
      noProgressPasses: this.noProgress.get(missionId) ?? 0,
    }
    this.passes.set(missionId, pass)
    return pass
  }

  /**
   * R16-D: name a body past its bound. One path, from the tick watchdog: the
   * durable stall event, the owner notice that names the body and the live
   * work that held it, and the wedged mark the notices publish with.
   *
   * The body counts as named only once that event and notice have committed
   * for an active mission (`escalatedAt` is set after the commit, never
   * before). A naming that did not commit (a busy writer on that tick) or was
   * skipped (the mission paused, blocked or already carrying this board's wedge
   * key) leaves the body unnamed, so the next tick retries; the durable
   * `schedulingWedgeNotice` key makes every retry idempotent, and `closePass`
   * clears it when a named body settles, so the next body that wedges on the
   * same board is named as well.
   *
   * This revokes nothing: the operation queue keeps the body as the physical
   * owner until it actually returns, and a later kick is skipped until then.
   * The independent watchdog and outbox keep reporting the blocker.
   */
  private escalateWedge(missionId: string, pass: SchedulingPass, heldByLiveWork: boolean, holders: Array<{ subject: string; memberId?: string }>): boolean {
    const now = Date.now()
    const fingerprintNow = this.rt.fingerprint(missionId)
    if (this.rt.store.get('missions', missionId)?.schedulingWedgeNotice === fingerprintNow) return false
    const boundMs = heldByLiveWork ? this.rt.stallPassReleaseBoundMs : this.rt.stallPassTimeoutMs
    const unschedulable = this.unschedulable(this.rt.mission(missionId), this.rt.store.list('tasks', missionId), this.rt.store.list('members', missionId)).map(task => `${task.id} (${task.status})`)
    const wedge: WedgeRecord = { releasedAt: now, gapMs: Math.max(0, now - pass.startedAt), liveSubjects: holders.map(holder => holder.subject) }
    const named = this.escalateSchedulingStall(missionId, {
      pass, reason: 'pass-timeout', boundMs: this.rt.stallPassTimeoutMs, revisionNow: this.rt.store.revision(), fingerprintNow,
      unschedulable, releaseBoundMs: boundMs, heldByLiveWork, wedge, liveHolders: holders,
    })
    if (named) pass.escalatedAt = now
    return named
  }

  /**
   * Close a pass when its body settles: remove the in-memory record first (so
   * the next kick may queue a successor), then compare the mission digest with
   * the one it opened on, count consecutive passes that advanced nothing and
   * terminated nothing, and escalate once the declared window of such passes
   * has been reached. Never throws: pass bookkeeping must not break scheduling.
   */
  closePass(missionId: string, pass: SchedulingPass): void {
    if (this.passes.get(missionId) === pass) this.passes.delete(missionId)
    try {
      if (this.rt.closed) return
      // R17-G5: the close is a transition. While the pass was live, notices left
      // its mid-pass commits unpublished for the pass end to publish.
      this.rt.passSettled(missionId)
      const revisionAfter = this.rt.store.revision()
      const fingerprintAfter = this.rt.fingerprint(missionId)
      const progressed = fingerprintAfter !== pass.fingerprintBefore
      const noProgressPasses = progressed ? 0 : pass.noProgressPasses + 1
      this.noProgress.set(missionId, noProgressPasses)
      // Change-and-return: the board left the no-progress class, so a later
      // return to it re-notifies instead of staying silent behind a stale key.
      // A named body that settles has spent its wedge key too: the key dedups
      // the retried naming of that one body (`escalatedAt` keeps one naming per
      // body), so a later body that wedges on this same board is named once.
      const mission = this.rt.store.get('missions', missionId)
      const clearStall = progressed && mission?.schedulingStallNotice !== undefined
      const clearWedge = (progressed || pass.escalatedAt !== undefined) && mission?.schedulingWedgeNotice !== undefined
      if (mission !== undefined && (clearStall || clearWedge)) {
        if (clearStall) delete mission.schedulingStallNotice
        if (clearWedge) delete mission.schedulingWedgeNotice
        this.rt.commit(missionId, () => this.rt.store.put('missions', mission))
      }
      if (!progressed && noProgressPasses >= this.rt.stallPasses && this.boardCannotProgress(missionId)) {
        this.escalateSchedulingStall(missionId, { pass: { ...pass, noProgressPasses }, reason: 'no-progress', boundMs: this.rt.config.tickMs * this.rt.stallPasses, revisionNow: revisionAfter, fingerprintNow: fingerprintAfter })
      }
    } catch { /* A closed store or a concurrent owner transition must not break scheduling. */ }
  }

  /**
   * S1/S2: the wedge detector. Runs from the tick timer, outside every mission
   * queue and outside the pass it watches. A body still queued or running past
   * the declared bound is named: the durable stall event is committed, the owner
   * notice is delivered by an unqueued flush, and the mission publishes as
   * wedged until the body settles. The queue keeps the body as the physical
   * owner; each await it can be in carries its own bound.
   *
   * R16-D: the naming is bounded even when the mission still has live work. A
   * live lease or an in-flight quiescence may be progress, so the body is not
   * named at the first bound; but a healthy sibling's lease must not own the
   * whole board's clock forever, so past `stallPassReleaseBoundMs` it is named
   * anyway, with the live work it was held by named and preserved untouched.
   * Co-firing guards, named: `livePass` (mirrors the same bound, so no notice
   * stays suppressed after the naming), the off-pass decision sweep (which runs
   * while the body is wedged and names the subjects no live path advances), the
   * notice dedup (one escalation per body and per unchanged board) and the
   * lease-renewal path (the naming changes no task, attempt or lease). `now` is
   * the tick's one instant, read once for every body (`pastBound`).
   */
  checkSchedulingPasses(now = Date.now()): void {
    if (this.rt.closed || this.rt.shuttingDown) return
    for (const [missionId, pass] of this.passes) {
      if (pass.escalatedAt !== undefined) continue
      const mission = this.rt.store.get('missions', missionId)
      // A paused or blocked mission is not named now; the body stays unnamed and
      // the first tick after the owner resumes it names the body if it is still
      // held (the resume does not go through the mission queue).
      if (mission?.status !== 'active') continue
      if (!this.pastBound(pass, now)) continue
      const held = this.hasLiveWork(missionId)
      // Inside the second bound live work keeps the body live: a pass that may
      // legitimately be inside a long adapter await for that work is not named.
      // Past it the window is over, and the notice names the subject that held it.
      if (held && now - pass.startedAt < this.rt.stallPassReleaseBoundMs) continue
      this.escalateWedge(missionId, pass, held, held ? this.liveWorkHolders(missionId) : [])
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
  escalateSchedulingStall(missionId: string, info: {
    pass: SchedulingPass
    reason: 'pass-timeout' | 'no-progress'
    boundMs: number
    revisionNow: number
    fingerprintNow: string
    /** What was unschedulable when the wedge was named; computed here when absent. */
    unschedulable?: string[]
    /** R16-D: the bound the wedge was measured against (the live-work window when one applied). */
    releaseBoundMs?: number
    /** R16-D: true when live work held the naming to its second bound. */
    heldByLiveWork?: boolean
    /** R16-D: what the watchdog measured when it named the wedge, carried by the event. */
    wedge?: WedgeRecord
    /** R16-D: the live work the naming preserved, as subjects and members. */
    liveHolders?: Array<{ subject: string; memberId?: string }>
  }): boolean {
    const mission = this.rt.store.get('missions', missionId)
    if (mission === undefined || this.rt.isMissionTerminal(mission) || mission.status !== 'active') return false
    const fingerprint = info.fingerprintNow
    const noticeKey = info.reason === 'pass-timeout' ? 'schedulingWedgeNotice' : 'schedulingStallNotice'
    if (mission[noticeKey] === fingerprint) return false
    // A pass-timeout wedge is its own subject: the pass body is past its bound
    // and the dispatch question it owes is unasked. A board-level witness (another notice that announced the
    // same fingerprint) must not suppress it — that cross-subject conflation is
    // exactly what round 15 removes, and fault F21 requires the wedge to be named
    // inside the declared bound whether or not the board was already announced.
    // The no-progress variant is a statement about the board, so a fresh witness
    // for that board does suppress it, as before.
    const witnessed = info.reason === 'pass-timeout'
      ? false
      : mission.stallNotice === fingerprint || mission.coverageNotice === fingerprint || mission.witness?.fingerprint === fingerprint
    if (witnessed) return false
    const unschedulable = info.unschedulable ?? this.unschedulable(mission, this.rt.store.list('tasks', missionId), this.rt.store.list('members', missionId)).map(task => `${task.id} (${task.status})`)
    // R15-A1/A2: a wedged or no-progress pass names the work it never reached, so
    // the notice carries subjects even though `unschedulable` is legitimately
    // empty (nothing is unschedulable: the pass simply never ran to a decision).
    // Guard pair: scheduling-pass stall x stall-root classifier — both can fire for
    // one board, and each keeps its own subject and dedup key; the mission root is
    // the fallback only when the board has no non-terminal task left.
    const unreached = this.rt.store.list('tasks', missionId).filter(task => task.status !== 'accepted' && task.status !== 'cancelled')
    // R16-D: a naming held to its second bound names the live work that held it
    // as a subject too. The claim is still "this pass cannot finish", but the
    // owner must be able to see which subjects made the wait unavoidable, and
    // that the naming preserved them (it cancels no task, drops no attempt and
    // changes no lease). Guard pair: this naming x the off-pass sweep — the sweep
    // names what no live path advances, this names what the wedged pass never
    // reached and what held it; both carry task@epoch and neither consumes the
    // other's dedup key.
    const holders = info.liveHolders ?? []
    const subjects = [...new Set([...subjectsOfTasks(unreached, mission), ...holders.map(holder => holder.subject)])]
    const heldText = info.heldByLiveWork === true && holders.length
      ? ` The naming was held to its ${info.releaseBoundMs ?? info.boundMs}ms live-work bound by work that is preserved untouched: ${holders.map(holder => holder.memberId === undefined ? holder.subject : `${holder.subject} held by ${holder.memberId}`).join(', ')}.`
      : ''
    const unreachedText = unreached.length ? unreached.map(task => `${task.id} (${task.status})`).join(', ') : 'none'
    // R15-D2: when a subject of this escalation is a blocked task whose stop is
    // past its declared bound (or carries no recorded start), the escalation
    // states that row-supported fact — the wedged pass is exactly what makes
    // the stop unbounded.
    const stopFacts = unreached.filter(task => task.status === 'blocked' && stopPending(task))
      .map(task => {
        const stop = task.resumeAfterStop
        return stop?.at === undefined
          ? `${task.id} is blocked and its stop carries no recorded start, so the declared bound (${info.boundMs}ms) cannot be shown to hold`
          : `${task.id} is blocked and its stop has been awaited for ${Math.max(0, Date.now() - stop.at)}ms, past its declared bound`
      })
    const stopText = stopFacts.length ? ` Stop state: ${stopFacts.join('; ')}.` : ''
    const passes = info.pass.noProgressPasses
    const stateUnchanged = info.pass.fingerprintBefore === fingerprint
    mission[noticeKey] = fingerprint
    mission.updatedAt = Date.now()
    mission.witness = { fingerprint, kind: 'W3', at: Date.now() }
    this.rt.commit(missionId, () => {
      this.rt.store.put('missions', mission)
      // Reuse the registered board-stall event rather than inventing a new type:
      // `cause: 'scheduling-pass'` and `wedged` make the pass-level escalation
      // distinguishable in the durable log and in every existing read path.
      this.rt.store.event(missionId, 'mission/stalled', 'runtime', {
        cause: 'scheduling-pass',
        passId: info.pass.id, runId: info.pass.operationId,
        reason: info.reason === 'pass-timeout'
          ? `scheduling pass did not return within its ${info.boundMs}ms bound and advanced no durable state`
          : `no durable state change for ${passes} consecutive scheduling passes`,
        wedged: info.reason === 'pass-timeout',
        passStartedAt: info.pass.startedAt, passes, boundMs: info.boundMs,
        revisionBefore: info.pass.revisionBefore, revisionAtStall: info.revisionNow,
        missionFingerprint: fingerprint, stateUnchanged, unschedulable, ownerNotified: true,
        // R16-D: what the wedge was measured against, whether live work held it,
        // and the subjects whose work it preserved. Nothing is released; the
        // `release*` names are kept for every existing reader and describe the
        // naming: `releasedAt` is the instant of the tick whose naming committed,
        // `releaseGapMs` how long the body had held the mission by then,
        // `releaseBoundMs` the bound the naming was measured against (the
        // live-work bound when live work held it) and `releasedWhileLive` whether
        // live work held it. `boundMs` keeps its original meaning (the pass's own
        // stall bound); these facts are additive and only present on a wedge,
        // never on the no-progress variant.
        ...(info.wedge === undefined ? {} : {
          releasedAt: info.wedge.releasedAt,
          releaseBoundMs: info.releaseBoundMs ?? info.boundMs,
          releaseGapMs: info.wedge.gapMs,
          releasedWhileLive: info.heldByLiveWork === true,
          liveSubjects: info.wedge.liveSubjects,
        }),
      })
      this.rt.notify(missionId, info.reason === 'pass-timeout'
        ? `Scheduling pass ${info.pass.id} (run ${info.pass.operationId}) for mission ${missionId} did not return within ${info.boundMs}ms and produced no durable state change (fingerprint ${fingerprint.slice(0, 12)}). This pass keeps the mission's scheduling until the call it awaits returns at its own bound; the next pass then resumes from lease recovery. Unschedulable: ${unschedulable.join(', ') || 'none'}.${heldText} Work the pass never reached: ${unreachedText}.${stopText} Decide: inspect the named tasks, admit a repair with swarm_propose, or withdraw the blocking work with swarm_cancel.`
        : `Mission ${missionId} left its durable state unchanged for ${passes} consecutive scheduling passes (window ${info.boundMs}ms, revision ${info.pass.revisionBefore} → ${info.revisionNow}, fingerprint ${fingerprint.slice(0, 12)}) and terminated nothing. Unschedulable: ${unschedulable.join(', ') || 'none'}. Work with no progress: ${unreachedText}. Decide: admit work with swarm_propose, adjust the budget, or complete/stop the mission.`, subjects,
        // R17-G5: the pass naming is its own fact, not the board's witness. A
        // wedged-pass escalation must not consume the board's W2 witness for a
        // fingerprint whose decision the transition-driven classifier still owes
        // (the dispatch question the dead pass never reached).
        { stampWitness: false })
    })
    // R17-G5: the naming is a transition that still owes the wedged pass's own
    // dispatch question, so the next fact publication runs with the wedged
    // branch even if the body settles before that publication runs. Marked only
    // once the naming committed; the publication it marks runs after this
    // synchronous call returns.
    this.rt.expectWedgedRelease(missionId)
    // The notice path must not share the fate of the pass that could not report
    // it: the queue-external pump delivers it, never the wedged mission queue.
    this.rt.pumpOutbox()
    return true
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
   *  - the W6 idle close-out: an attempt whose turn ended (`idleSignal`,
   *    `closeout.nudges`) is already being nudged and then checkpointed with a
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
  silentAttempt(task: Task, mission: Mission, now = Date.now()): SilentAttempt | undefined {
    const attempt = task.attempt
    if (attempt === undefined || task.status !== 'running') return undefined
    const boundMs = this.rt.attemptSilenceBoundMs
    if (boundMs <= 0) return undefined
    if (!Number.isSafeInteger(attempt.leaseUntil)) return undefined
    // The W6 idle close-out owns an attempt whose turn ended: it nudges, then
    // checkpoints and re-pends with a coded terminal. Naming it here would
    // double-report one attempt (the pair is pinned by R16-D5).
    if (task.idleSignal?.attemptId === attempt.id) return undefined
    if ((task.closeout?.nudges ?? 0) > 0) return undefined
    const member = this.rt.store.get('members', attempt.ownerId)
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
    if (this.rt.closed || this.rt.shuttingDown) return 0
    const mission = this.rt.store.get('missions', missionId)
    if (mission === undefined || mission.status !== 'active' || this.rt.isMissionTerminal(mission)) return 0
    // A deliberate budget pause is host policy, not a stalled worker: the pause
    // owns the board until the owner resumes it.
    if (mission.budgetPause !== undefined) return 0
    let fired = 0
    for (const task of this.rt.store.list('tasks', missionId)) {
      const silent = this.silentAttempt(task, mission)
      if (silent === undefined) continue
      if (this.escalateSilentAttempt(mission, task, silent)) fired += 1
    }
    return fired
  }

  /** One durable owner escalation per silence; returns false when it was already named. */
  private escalateSilentAttempt(mission: Mission, task: Task, silent: SilentAttempt): boolean {
    const dedupKey = `${ATTEMPT_SILENCE_PREFIX}${silent.attemptId}:${silent.lastDurableAt}`
    if (hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'stall', dedupKey, from: 'runtime' })) return false
    const member = this.rt.store.get('members', silent.ownerId)
    const name = member === undefined ? silent.ownerId : `${member.name} (${member.id})`
    const since = silent.lastDurableAt === 0 ? 'it was dispatched' : `durable row at ${silent.lastDurableAt}`
    // The pass state is part of the honesty of the claim: the same guard fires
    // whether or not the pass is running, and the reader must know which path
    // would otherwise have named the attempt.
    const pass = this.passes.get(mission.id)
    const passState = pass !== undefined && this.passWedged(mission.id)
      ? ` The mission's scheduling pass ${pass.operationId} is wedged past its ${this.rt.stallPassTimeoutMs}ms bound, so the in-pass recovery sweep cannot run either.`
      : ''
    const message = `${name} has held task ${task.id} "${task.title}" at epoch ${task.epoch} (attempt ${silent.attemptId}) for ${formatSpan(silent.silentMs)} (${silent.silentMs}ms) with no durable report past its declared bound of ${formatSpan(silent.boundMs)} (${silent.boundMs}ms): no durable event, no task state transition and no recorded tool run names this attempt since ${since}; no operation is in flight and the idle close-out is not handling it.${passState} Nothing was stopped or re-pended by this notice: the attempt may still be working. Owner actions: inspect it with swarm_observe (taskId ${task.id}), send it input or finish it with swarm_handoff, raise attemptSilenceBoundMs if this silence is healthy, or withdraw the work with swarm_cancel. [witness: attempt-silent, subject ${silent.subject}, attempt ${silent.attemptId}, member ${silent.ownerId}, lastDurableAt ${silent.lastDurableAt}, silentMs ${silent.silentMs}, boundMs ${silent.boundMs}]`
    this.rt.commit(mission.id, () => { this.rt.notify(mission.id, message, [taskSubject(task)], { noticeClass: 'stall', dedupe: true, dedupKey }) })
    return true
  }

  /**
   * R16-D: the newest durable row a reader can attribute to one attempt. The
   * attempt's own `task/claimed` event is the floor, so a dispatch that recorded
   * nothing else measures its silence from the dispatch itself.
   */
  private lastDurableAt(missionId: string, task: Task, attempt: Attempt): number {
    let latest = 0
    for (const event of this.rt.store.events(missionId, this.rt.config.maxEvents)) {
      if (latest >= event.createdAt) continue
      if (event.type === 'task/claimed') {
        if (this.identityIn(event.data, task.id, attempt.id)) latest = event.createdAt
        continue
      }
      if (this.identityIn(event.data, task.id, attempt.id)) latest = Math.max(latest, event.createdAt)
    }
    for (const run of this.rt.store.toolRuns(missionId, { attemptId: attempt.id })) latest = Math.max(latest, run.createdAt)
    for (const delivery of this.rt.store.list('deliveries', missionId)) {
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

  /**
   * F2: the board makes no progress except for submitted work. Unlike `stalled`,
   * a submitted task is not progress: an artifact whose review path is broken
   * can never reach a verdict by itself.
   */
  reviewPathStalled(tasks: Task[], members: Member[]): boolean {
    if (tasks.some(task => task.status === 'running' || this.quiescencePending(task))) return false
    const live = members.filter(member => memberPhaseOf(member) !== 'stopped')
    return !tasks.some(task => task.status === 'pending' && live.some(member => this.ready(task, member, tasks)))
  }

  /** R5-02: deterministic next live member for re-routed work, preferring the planned assignee. */
  rerouteTarget(missionId: string, task: Task, failedId: string): Member | undefined {
    const candidates = this.rt.store.list('members', missionId)
      .filter(member => member.id !== failedId && memberPhaseOf(member) !== 'stopped' && this.capable(task, member))
    const planned = task.plannedAssigneeId === undefined ? undefined : candidates.find(member => member.id === task.plannedAssigneeId)
    return planned ?? candidates.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  }
}
