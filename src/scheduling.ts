/**
 * The scheduling seam: the readiness and stall predicates, the durable pass guard
 * (open/close/release) and the dispatch sweep of one serialized pass. M1a seam 7/7.
 *
 * Behaviour-identical to the code moved from src/runtime.ts; the runtime keeps
 * thin forwarding methods and `schedule` calls `dispatch` exactly where its
 * member loop used to be.
 */
import { randomUUID } from 'node:crypto'
import { dependencyAssumptions, taskCeilingExhaustion } from './admission.ts'
import { subjectsOfTasks, taskSubject } from './notices.ts'
import { emitGuardTerminal, guardTerminal, type DecisionExit, type GuardChainId, type GuardTerminal, type GuardTerminalContext } from './refusals.ts'
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
          // R15-A4/A5: the sweep and the owner-facing explanation ask the same
          // question (`startBlocker`), so a member the sweep skipped is never
          // described to the owner with a cause the sweep did not test. The
          // parked-member hatch keeps priority: a parked member is dispatchable.
          if (this.startBlocker(member) !== undefined) continue
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
          const ready = all.filter(t => this.ready(t, member, all)).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
          // R12-F9, dispatch-time half: a task whose own text assumes prior work
          // is already in the worktree while no content-carrying edge provides it
          // would be prepared from the bare mission baseline and surprise the
          // member at submit (T3b lost a cycle to "Artifact changes path outside
          // task scope"; INT2 was repaired by hand). The admission-time call site
          // refuses it at propose()/plan validation; this is the last guard before
          // preparation.
          //
          // S4r-D1: the ineligible task is removed from THIS member's candidate
          // set before the first candidate is chosen. Skipping the member's whole
          // iteration here used to starve every later ready task on that member
          // forever — the admission guard and the dispatch sweep co-firing into a
          // trap, exactly the pair class this round is about. One escalation per
          // ineligible task, and the sweep still dispatches the next ready task.
          // A review's source is prepared into the worktree like a dependency
          // (`prepareTask` receives it as the review source), so it is a
          // content-carrying edge too.
          const ineligible: Array<{ task: Task; detail: string }> = []
          const candidates = ready.filter(candidate => {
            const carryingEdges = [...candidate.dependencies, ...(candidate.reviewOf === undefined ? [] : [candidate.reviewOf])]
            const assumptions = dependencyAssumptions({ objective: candidate.objective, acceptance: candidate.acceptance, dependencies: carryingEdges, replaces: candidate.replaces }, `task ${JSON.stringify(candidate.id)}`)
            if (!assumptions.length) return true
            ineligible.push({ task: candidate, detail: assumptions.map(item => `${item.location}: ${item.message}`).join(' ') })
            return false
          })
          for (const refused of ineligible) this.escalateGuardTerminal(missionId, 'admission', { taskId: refused.task.id, detail: refused.detail })
          const task = candidates[0]
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
            })
            // Round 14: this is the terminal element of the dispatch-precondition
            // chain. The task cannot be prepared again (its recovery limit is
            // spent), so no earlier element of the chain can yield an action; the
            // escalation is unconditional and names the executable exits instead
            // of leaving the owner a bare reason string.
            if (exhausted) this.escalateGuardTerminal(missionId, 'dispatch_preconditions', {
              taskId: fresh.id, detail: `its recovery limit of ${limit} is exhausted after preparation failures: ${reason}`,
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
   * - the parked-member hatch (`member.status === 'waiting'`, R10-09/S3): a parked
   *   member is startable even when the adapter reports a pending inbox item, so
   *   the hatch wins here exactly as it does in `dispatch`;
   * - the adapter's `isIdle` precondition (`HarnessWorkers.isIdle`), which now
   *   drains a stranded `nextStep` item instead of stranding the member (R15-A5);
   * - the W6 open-attempt close-out, which owns a member that already has a
   *   running attempt — `dispatch` handles that member before it dispatches, and
   *   `dispatchQuestion` refuses to answer for a task with an open attempt.
   */
  startBlocker(member: Member): 'handle-busy' | undefined {
    if (member.status === 'waiting') return undefined
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
   * Otherwise the returned notice is one of exactly two honest answers:
   * - `handle-busy`: every member eligible for the task is working by the
   *   adapter's contract. The named holder is the task's assignee when the task
   *   is pinned, else the first eligible member whose handle is busy;
   * - admission: at least one eligible member is startable, so the dispatcher
   *   could have dispatched and did not — the refusal came from admission limits,
   *   budget or a task ceiling.
   */
  dispatchQuestion(missionId: string, tasks: Task[], members: Member[], dispatchable: Task[]): DispatchQuestion | undefined {
    for (const task of dispatchable) {
      // An open attempt is not a dispatch candidate: the close-out path nudges it
      // (W6) or the lease path recovers it, and a second owner wake would be noise.
      if (task.attempt !== undefined) continue
      const eligible = members.filter(member => member.status !== 'stopped' && this.ready(task, member, tasks))
      if (!eligible.length) continue
      const subjects = [taskSubject(task)]
      const dedupKey = `dispatch-question:${missionId}:${task.id}@${task.epoch}`
      if (eligible.some(member => this.startBlocker(member) === undefined)) {
        return { task, subjects, dedupKey,
          message: `Task ${task.id} (${task.title}, epoch ${task.epoch}) is ready for an eligible member the dispatcher could start but was not dispatched this tick, and no member handle is holding it: the dispatch was refused by mission admission limits or budget. Free a slot, raise a limit with swarm_budget, or withdraw the blocking work with swarm_cancel.` }
      }
      const pinned = task.assigneeId === undefined ? undefined : eligible.find(member => member.id === task.assigneeId)
      const holder = pinned ?? eligible[0]!
      return { task, holder, subjects, dedupKey,
        message: `Task ${task.id} (${task.title}, epoch ${task.epoch}) is ready for member ${holder.name} (${holder.id})${pinned === undefined ? ', one of its eligible members,' : ', the member it is assigned to,'} whose worker handle still holds an unfinished turn, so the dispatcher cannot start it: no admission limit and no budget refusal was recorded for this board. The task is not undispatched for lack of an eligible member. Wait for that turn to end (the close-out path re-pends or completes it), re-propose the task with a different assigneeId, or withdraw it with swarm_cancel.` }
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

  /**
   * The durable board as the guard-chain model sees it: the production view the
   * terminal classification and the property test share. Every field is derived
   * from a durable row (or a durable event), never from an in-memory gate.
   */
  guardBoard(missionId: string, mission?: Mission): GuardBoard {
    const row = mission ?? this.rt.store.get('missions', missionId)
    const tasks = this.rt.store.list('tasks', missionId)
    const members = this.rt.store.list('members', missionId)
    const now = Date.now()
    const revoked = this.rt.store.events(missionId, 1000).some(event => event.type === 'mission/workspace-revoked')
    return {
      mission: {
        status: row?.status ?? 'active',
        workspace: revoked ? 'revoked' : 'authorized',
        ...(row?.budgetPause === undefined ? {} : { budgetPaused: true }),
      },
      tasks: tasks.map(task => {
        const exhaustion = taskCeilingExhaustion(task)
        const source = task.reviewOf === undefined ? undefined : this.rt.task(missionId, task.reviewOf)
        const reviewSourceLive = task.reviewOf === undefined
          ? (task.status === 'submitted' ? this.reviewable(task, tasks) : undefined)
          // A review whose named source is missing can never be dispatched: the
          // scheduler's `capable` reads the source row, so a dangling review is
          // reported as no live source rather than omitted.
          : source !== undefined && source.status === 'submitted'
        return {
          id: task.id, status: task.status,
          ...(task.attempt === undefined ? {} : { attempt: { leaseLive: task.attempt.leaseUntil >= now } }),
          ...(exhaustion === undefined ? {} : { ceilingExhausted: true }),
          dependenciesSatisfied: task.dependencies.every(dependency => this.rt.dependencySatisfied(missionId, dependency, tasks)),
          dependenciesDead: task.dependencies.some(dependency => this.rt.effectiveDependency(missionId, dependency, tasks).status === 'cancelled'),
          ...(task.reviewOf === undefined ? {} : { reviewOf: task.reviewOf }),
          // S4r-D4: `reviewSourceLive` is the SAME predicate the scheduler uses,
          // for every task the model reports progress on. A review task is live
          // exactly while its source is submitted (`capable`); a submitted source
          // is live exactly while `reviewable` finds a live independent review.
          // Reporting a source as progress without consulting that predicate made
          // the review_admission terminal unable to classify its canonical case.
          ...(reviewSourceLive === undefined ? {} : { reviewSourceLive }),
          ...(source === undefined ? {} : { authorMemberIds: [...this.rt.authorIds(source)] }),
          preparationExhausted: task.status === 'blocked' && typeof task.output === 'string' && task.output.startsWith('Workspace or worker preparation failed'),
          ...(task.dependencies.length === 0 && task.reviewOf === undefined
            && dependencyAssumptions({ objective: task.objective, acceptance: task.acceptance, dependencies: task.dependencies, replaces: task.replaces }, `task ${JSON.stringify(task.id)}`).length > 0
            ? { assumedContent: true } : {}),
        }
      }),
      // R15-F2: the guard board derives a member's status from the live attempt as
      // well as from the stored row, so a stale `idle` row cannot make the model's
      // progress action hide a member that currently owns running work. Co-firing
      // guards: this derivation x the W6 idle close-out (same attempt) and x the
      // parked-member hatch (`waiting` is preserved: a parked owner still holds
      // its work).
      // Upgrade-only, exactly like the runtime's reconciliation: a stale `idle` row
      // must not hide a member that owns a live attempt (the reported seam), while a
      // stored `working` row is preserved — the retained DEADr D1 pair depends on
      // the stored status reaching the guard model, and the paths that END an
      // attempt write `idle` themselves.
      members: members.map(member => {
        if (member.status === 'waiting' || member.status === 'stopped') return { id: member.id, status: member.status }
        const ownsLiveAttempt = tasks.some(task => task.status === 'running' && task.attempt !== undefined
          && task.attempt.leaseUntil >= now && task.attempt.ownerId === member.id)
        return { id: member.id, status: ownsLiveAttempt ? 'working' : member.status }
      }),
    }
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

  /**
   * R15-D1/D2: a pass body that is still `running` past its declared bound, from
   * THIS instance. `livePass` deliberately keeps such a row as a guard while the
   * mission has live work (a sibling lease, an in-flight stop acknowledgement),
   * so the watchdog does not abandon a pass that may legitimately be inside a long
   * adapter await. That gate must not silence another subject's clock: the
   * queue-external decision sweep reads this predicate and names the subjects the
   * wedged pass cannot finish, even while a healthy sibling holds its lease.
   *
   * Co-firing guards: `livePass` (still the scheduling gate), the wedge watchdog
   * (`checkSchedulingPasses`, which releases only with no live work), the
   * off-pass decision sweep (the only caller) and `hasLiveWork`.
   */
  passWedged(missionId: string): boolean {
    const row = this.rt.store.get('passes', this.passKey(missionId))
    if (row === undefined || row.missionId !== missionId) return false
    if (row.instanceId !== this.instanceId || row.status !== 'running') return false
    return Date.now() - row.startedAt > this.rt.stallPassTimeoutMs
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
    // A pass-timeout wedge is its own subject: the pass body was abandoned and its
    // guard released. A board-level witness (another notice that announced the
    // same fingerprint) must not suppress it — that cross-subject conflation is
    // exactly what round 15 removes, and fault F21 requires the wedge to be named
    // inside the declared bound whether or not the board was already announced.
    // The no-progress variant is a statement about the board, so a fresh witness
    // for that board does suppress it, as before.
    const witnessed = info.reason === 'pass-timeout'
      ? false
      : mission.stallNotice === fingerprint || mission.coverageNotice === fingerprint || mission.witness?.fingerprint === fingerprint
    if (witnessed) return
    const unschedulable = info.pass.stalled?.unschedulable ?? this.unschedulable(mission, this.rt.store.list('tasks', missionId), this.rt.store.list('members', missionId)).map(task => `${task.id} (${task.status})`)
    // R15-A1/A2: a wedged or no-progress pass names the work it never reached, so
    // the notice carries subjects even though `unschedulable` is legitimately
    // empty (nothing is unschedulable: the pass simply never ran to a decision).
    // Guard pair: scheduling-pass stall x stall-root classifier — both can fire for
    // one board, and each keeps its own subject and dedup key; the mission root is
    // the fallback only when the board has no non-terminal task left.
    const unreached = this.rt.store.list('tasks', missionId).filter(task => task.status !== 'accepted' && task.status !== 'cancelled')
    const subjects = subjectsOfTasks(unreached, mission)
    const unreachedText = unreached.length ? unreached.map(task => `${task.id} (${task.status})`).join(', ') : 'none'
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
        ? `Scheduling pass ${info.pass.id} for mission ${missionId} did not return within ${info.boundMs}ms and produced no durable state change (fingerprint ${fingerprint.slice(0, 12)}). The runtime released the mission's scheduling guard so later ticks proceed; unschedulable: ${unschedulable.join(', ') || 'none'}. Work the pass never reached: ${unreachedText}. Decide: inspect the named tasks, admit a repair with swarm_propose, or withdraw the blocking work with swarm_cancel.`
        : `Mission ${missionId} left its durable state unchanged for ${passes} consecutive scheduling passes (window ${info.boundMs}ms, revision ${info.pass.revisionBefore} → ${info.revisionNow}, fingerprint ${fingerprint.slice(0, 12)}) and terminated nothing. Unschedulable: ${unschedulable.join(', ') || 'none'}. Work with no progress: ${unreachedText}. Decide: admit work with swarm_propose, adjust the budget, or complete/stop the mission.`, subjects)
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

/* ------------------------------------------------------------------------- *
 * Round 14: the guard-chain board model.
 *
 * The kernel obligation is structural: every guard chain ends in an escalation
 * that has no conditions of its own, so a dead end is impossible. This model is
 * the shared vocabulary for that claim. `guardDispatchActions` and
 * `guardProgressActions` describe every action an earlier element of a chain can
 * still produce; `guardTerminalChain` names the chain whose earlier elements
 * have all answered "no"; `terminalEscalation` turns that into the coded,
 * actionable decision request `Scheduling.escalateGuardTerminal` emits.
 *
 * The model is pure: no store, no clock, no cache. `tests/guard-terminals.test.mjs`
 * enumerates generated board states (task status x attempt presence x workspace
 * state x member status x budget pause), walks the reachable subset through a
 * transition relation and asserts the property over every reachable non-terminal
 * state, so the guarantee is checked against the same functions the dispatch
 * path uses. The states the generator does not reach are named in that test.
 * ------------------------------------------------------------------------- */

/** One generated board: the five dimensions the property test enumerates. */
export interface GuardTask {
  id: string
  status: Task['status']
  /** An attempt is attached to a running task; `leaseLive` is its lease state. */
  attempt?: { leaseLive: boolean }
  /** The task already spent its own step/finding ceiling (`taskCeilingExhaustion`). */
  ceilingExhausted?: boolean
  /** An ordinary dependency edge waits for acceptance; a dead edge never resolves. */
  dependenciesSatisfied?: boolean
  dependenciesDead?: boolean
  /** This task reviews the named source; the source may have no live review left. */
  reviewOf?: string
  reviewSourceLive?: boolean
  /** Members who authored the reviewed source and can never review it. */
  authorMemberIds?: string[]
  /** Preparation failures exhausted the task's recovery limit. */
  preparationExhausted?: boolean
  /**
   * The task's own text assumes prior content that no dependency carries
   * (R12-F9): the admission guard's terminal input.
   */
  assumedContent?: boolean
}

export interface GuardMember {
  id: string
  status: Member['status']
  /** False only for a member the isolation invariant refuses. */
  isolated?: boolean
}

export interface GuardBoard {
  mission: {
    status: Mission['status']
    workspace: 'authorized' | 'revoked' | 'dirty' | 'unprovisioned'
    budgetPaused?: boolean
    budgetBlocked?: string
  }
  tasks: GuardTask[]
  members: GuardMember[]
}

export interface GuardDispatchAction {
  kind: 'dispatch'
  chain: 'dispatch_preconditions'
  taskId: string
  memberId: string
}

/** Work already in flight: an action an earlier chain element is executing. */
export interface GuardProgressAction {
  kind: 'progress'
  chain: GuardChainId
  detail: string
  taskId?: string
  memberId?: string
}

export interface GuardEscalationAction {
  kind: 'escalate'
  chain: GuardChainId
  code: string
  message: string
  exits: DecisionExit[]
  coFires: GuardChainId[]
  taskId?: string
}

export type GuardAction = GuardDispatchAction | GuardProgressAction | GuardEscalationAction

const isLiveMember = (member: GuardMember): boolean => member.status === 'idle' || member.status === 'waiting'

/**
 * Every (task, member) pair an earlier element of the dispatch-precondition
 * chain can still act on. A task is dispatchable only when the whole chain
 * before the terminal answered "yes": the mission is active, the budget is not
 * paused or exhausted, the workspace is authorized, the task is pending, it has
 * not spent its own ceiling or its preparation recovery, its dependency lineage
 * is alive and satisfied, its review source is live when it is a review, and a
 * live member who did not author that source can take it.
 */
export function guardDispatchActions(board: GuardBoard): GuardDispatchAction[] {
  const mission = board.mission
  if (mission.status !== 'active' || mission.budgetPaused === true || mission.budgetBlocked !== undefined || mission.workspace !== 'authorized') return []
  const actions: GuardDispatchAction[] = []
  for (const task of board.tasks) {
    if (task.status !== 'pending' || task.ceilingExhausted === true || task.preparationExhausted === true || task.assumedContent === true) continue
    if (task.dependenciesSatisfied === false || task.dependenciesDead === true) continue
    if (task.reviewOf !== undefined && task.reviewSourceLive === false) continue
    const member = board.members.find(candidate => isLiveMember(candidate) && candidate.isolated !== false
      && !(task.authorMemberIds ?? []).includes(candidate.id))
    if (member !== undefined) actions.push({ kind: 'dispatch', chain: 'dispatch_preconditions', taskId: task.id, memberId: member.id })
  }
  return actions
}

/**
 * Work already in flight. A live lease, a working member or a submitted source
 * whose review is still live is progress, so the board is not a dead end and no
 * terminal escalation is owed. This is deliberately derived from the board, not
 * from the terminal function, so the property test cannot be circular.
 *
 * "In flight" is only progress while the chains that gate it can still let it
 * land: an attempt whose workspace cannot produce an artifact, or whose mission
 * is paused or out of budget, is executing but can never reach its terminal
 * step — that is exactly the 2026-09-10 trap, and it must count as a dead end
 * rather than as liveness.
 */
export function guardProgressActions(board: GuardBoard): GuardProgressAction[] {
  const mission = board.mission
  if (mission.status !== 'active' || mission.budgetPaused === true || mission.budgetBlocked !== undefined || mission.workspace !== 'authorized') return []
  const actions: GuardProgressAction[] = []
  for (const task of board.tasks) {
    if (task.status === 'running' && task.attempt !== undefined && task.attempt.leaseLive) {
      actions.push({ kind: 'progress', chain: 'attempt_lease', taskId: task.id, detail: 'a running attempt holds a live lease' })
    }
    if (task.status === 'submitted' && task.reviewOf === undefined && task.reviewSourceLive !== false) {
      actions.push({ kind: 'progress', chain: 'review_admission', taskId: task.id, detail: 'a submitted source has a live review path' })
    }
  }
  for (const member of board.members) {
    if (member.status === 'working') actions.push({ kind: 'progress', chain: 'dispatch_preconditions', memberId: member.id, detail: 'the member is working' })
  }
  return actions
}

/**
 * The chain whose earlier elements have all answered "no". Ordered so the
 * classification names the *first* chain that cannot progress: a board with an
 * exhausted budget and a revoked workspace is a budget decision first, because
 * no lease can be admitted until the ceiling moves.
 */
export function guardTerminalChain(board: GuardBoard): GuardChainId {
  const live = board.tasks.filter(task => task.status !== 'accepted' && task.status !== 'cancelled')
  if (board.mission.budgetBlocked !== undefined || board.mission.budgetPaused === true) return 'budget'
  if (live.length > 0 && board.mission.workspace !== 'authorized') return 'workspace'
  if (board.tasks.some(task => task.status === 'running' && task.attempt !== undefined && !task.attempt.leaseLive)) return 'attempt_lease'
  if (board.tasks.some(task => task.ceilingExhausted === true && task.status !== 'accepted' && task.status !== 'cancelled')) return 'task_ceiling'
  if (board.tasks.some(task => task.assumedContent === true && task.status === 'pending')) return 'admission'
  if (board.tasks.some(task => task.status === 'submitted' && task.reviewSourceLive === false)) return 'review_admission'
  return 'dispatch_preconditions'
}

/**
 * The unconditional terminal element: total by construction. It takes a board
 * and always returns an escalation — the only branch that carries no earlier
 * failure is the generic "no executable action remains" one — so no caller can
 * reach a state where the chain has ended and nothing is emitted.
 */
export function terminalEscalation(board: GuardBoard): GuardEscalationAction {
  const chain = guardTerminalChain(board)
  const task = board.tasks.find(candidate => candidate.status !== 'accepted' && candidate.status !== 'cancelled')
  const member = board.members.find(candidate => candidate.status === 'working') ?? board.members[0]
  const terminal = guardTerminal(chain, { ...(task === undefined ? {} : { taskId: task.id }), ...(member === undefined ? {} : { memberId: member.id }) })
  return { kind: 'escalate', ...terminal, ...(task === undefined ? {} : { taskId: task.id }) }
}

/** Every action the model can see: dispatch, progress, or the unconditional terminal. */
/**
 * True only for the mission statuses no actor can bring back: `completed` and
 * `stopped`. Everything else — including `blocked` (a budget stop) and `paused` —
 * still owes the owner an executable action, which is the whole point of the
 * terminal element (`emitGuardTerminal` bails only on a terminal mission).
 */
export function guardMissionTerminal(board: GuardBoard): boolean {
  return board.mission.status === 'completed' || board.mission.status === 'stopped'
}

export function guardActions(board: GuardBoard): GuardAction[] {
  const dispatch = guardDispatchActions(board)
  const progress = guardProgressActions(board)
  // S4r-D5: the terminal is appended for every non-terminal mission status, not
  // only for `active`. A budget-blocked mission (`status: 'blocked'`,
  // `budgetPause` set) is exactly when the owner needs the coded exit, and the
  // old predicate returned an empty action list for it.
  if (dispatch.length > 0 || progress.length > 0 || guardMissionTerminal(board)) return [...dispatch, ...progress]
  return [...dispatch, ...progress, terminalEscalation(board)]
}
