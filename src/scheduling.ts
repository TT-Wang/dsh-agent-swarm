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
import { hasNotice } from './arena.ts'
import { subjectsOfTasks, taskSubject } from './notices.ts'
import { emitGuardTerminal, guardTerminal, type DecisionExit, type GuardChainId, type GuardTerminal, type GuardTerminalContext } from './refusals.ts'
import { AdmissionRefusedError } from './scheduler.ts'
import { WorkspaceRevokedError } from './workspace-admission.ts'
// R17-G6/G7: the one derivation of the derived member status.
import { memberPhaseOf } from './projection.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { Actor, Attempt, Member, Mission, SchedulingPass, SwarmEvent, Task } from './types.ts'

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
 *
 * R16-D: the same row also accumulates what the release bound could not keep:
 * `releases` counts every released wedge and `worstRelease` keeps the widest
 * release-to-bound gap seen (with the bound it was measured against). The row is
 * the single durable carrier of these facts for the same reason as
 * `releasedRunId`: the once-per-pass overwrite would otherwise erase the only
 * record of a bounded release, and the silence projection (below) must not
 * depend on the retained event window.
 */
interface ReleaseRecord {
  runId: string
  startedAt: number
  releasedAt: number
  /** `releasedAt - startedAt`: the whole time the wedged pass held the guard. */
  gapMs: number
  /** The declared bound this release was measured against. */
  boundMs: number
  /** True when live work (a live lease, an in-flight stop acknowledgement) held the release to its second bound. */
  heldByLiveWork: boolean
  /** The subjects whose live work held it, preserved by the release. */
  liveSubjects: string[]
}
interface ReleasedPassFields {
  releasedRunId?: string
  releasedAt?: number
  releases?: number
  worstRelease?: ReleaseRecord
}
const releasedPassFields = (row: SchedulingPass): SchedulingPass & ReleasedPassFields => row as SchedulingPass & ReleasedPassFields

/** Keep the wider of two release records; ties keep the earlier one. */
const widerRelease = (previous: ReleaseRecord | undefined, next: ReleaseRecord): ReleaseRecord =>
  previous === undefined || next.gapMs > previous.gapMs ? next : previous

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

/** R16-D: one subject whose silence was measured against the bound that applied to it. */
export interface SubjectSilence {
  subject: string
  kind: 'scheduling-pass' | 'attempt'
  gapMs: number
  /** The declared bound it was measured against. */
  boundMs: number
  /** When the measurement was taken (release instant or escalation instant). */
  at: number
}

/** R16-D: the durable per-attempt reporting record, for one attempt of the retained window. */
export interface AttemptReport {
  attemptId: string
  taskId: string
  epoch: number
  memberId: string
  claimedAt: number
  /** When the attempt stopped being current; undefined while the task row still carries it. */
  endedAt?: number
  lastDurableAt: number
  /** Longest interval between consecutive durable elements (or to `endedAt` / now). */
  worstReportingGapMs: number
  /** The current silence: `(endedAt ?? now) - lastDurableAt`. */
  silentMs: number
  /** Owner escalations naming this attempt, by dedup key. */
  escalations: string[]
  /** The attempt ended with nothing durable after its own dispatch (no report, no escalation). */
  endedUnreported: boolean
}

/**
 * R16-D: the round's silence projection, read from the durable store alone.
 * Read-only: it changes no task, member, pass or delivery state.
 */
export interface SilenceReport {
  missionId: string
  bounds: { passMs: number; passReleaseMs: number; attemptMs: number }
  /** Every subject whose silence was measured, with the bound it was measured against. */
  subjects: SubjectSilence[]
  worstSubjectSilence: SubjectSilence | undefined
  attempts: AttemptReport[]
  worstAttemptReportingGap: { attemptId: string; taskId: string; gapMs: number } | undefined
  attemptsEnded: number
  /** Attempts that ended with no durable report or escalation after their own dispatch. */
  attemptsEndedUnreported: number
  attemptSilenceEscalations: number
  /** The durable pass-row release record: how many wedges were released and the widest one. */
  passReleases: { count: number; worst: ReleaseRecord | undefined }
  note: string
}

/** Human form of an elapsed bound for a notice; the raw milliseconds stay on the witness. */
function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * R16-D: the durable events after which a task no longer holds its attempt.
 * This mirrors the private `ATTEMPT_CLOSERS` set in src/trace.ts (out of this
 * task's write scope) — the replay truncation check is the cross-check: a log
 * whose attempt closers diverge from this list is refused there. Kept local
 * because importing it is impossible (not exported) and widening that module's
 * surface is outside this task's scope; the integration task records the
 * duplication as a hand-off. A frozen array, not a Set: it is a lookup
 * vocabulary, and the S5 in-memory census classifies every collection in src/.
 */
const ATTEMPT_CLOSER_TYPES: readonly string[] = ['task/submitted', 'task/blocked', 'task/cancelled', 'task/cancelled-at-completion', 'task/lease-expired', 'task/handoff-started', 'task/invalidated', 'task/review-retired', 'task/closeout-abandoned', 'task/closeout-failed', 'task/accepted', 'task/rejected']
const isAttemptCloser = (type: string): boolean => ATTEMPT_CLOSER_TYPES.includes(type)

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
        // R17-G1: the dispatcher reads the SAME shared interpretation every
        // owner-facing generator consumes (`ready`, `dispatchable`, the task and
        // member rows), so no notice can describe a board the dispatcher would
        // act on differently. The view is rebuilt after each await, so it is
        // never staler than the per-step store reads it replaces.
        for (const member of this.rt.interpretation(missionId).members) {
          if (this.rt.shuttingDown || this.rt.mission(missionId).status !== 'active') return false
          if (memberPhaseOf(member) === 'stopped') continue
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
          const parkedMember = memberPhaseOf(member) === 'parked'
          // R15-A4/A5: the sweep and the owner-facing explanation ask the same
          // question (`startBlocker`), so a member the sweep skipped is never
          // described to the owner with a cause the sweep did not test. The
          // parked-member hatch keeps priority: a parked member is dispatchable.
          if (this.startBlocker(member) !== undefined) continue
          const view = this.rt.interpretation(missionId)
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
            if (!parkedMember && (durableIdle || cachedIdle)) await this.rt.closeOutIdleAttempt(mission, member, open)
            continue
          }
          const all = view.tasks
          const ready = all.filter(t => view.ready(t, member)).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
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
      const eligible = members.filter(member => memberPhaseOf(member) !== 'stopped' && this.ready(task, member, tasks))
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
      // R17-G6/G7: the member half of the guard board is READ from the runtime's
      // derived member board — the registered host projection's current state
      // when this process published one, otherwise the same single derivation —
      // so the model-facing guard model is an instance of the projection being
      // read, not a second interpretation of the rows. The stored mirror and its
      // upgrade-only rule are gone: there is no row to fall behind the attempt,
      // and no write here can churn F(S). Co-firing guards, named: the W6 idle
      // close-out (which owns the attempt until it fences it), the parked-member
      // hatch (`parked` wins over work in flight and keeps the member
      // dispatchable), the dispatch decision (which asks `startBlocker` about the
      // handle, never this status) and the coverage/stall notices, whose F(S) key
      // no status write can move any more. A dead lease stays the guard model's
      // own classification (`guardTerminalChain` reads the task rows and returns
      // `attempt_lease`), so this status never has to encode lease liveness.
      members: this.rt.memberBoard(missionId).map(member => ({ id: member.id, status: member.status })),
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
    const live = members.filter(member => memberPhaseOf(member) !== 'stopped')
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
   *
   * While the mission has live work (a renewed lease, an in-flight quiescence)
   * the row keeps gating inside the second, bounded window (`stallPassReleaseBoundMs`
   * = `stallPassTimeoutMs` + `stallPassLiveGraceMs`): the pass may legitimately
   * be inside a long adapter await for that live attempt. R16-D closes the half
   * round 15 left open: past that window the row is not a guard at all, so a
   * `kick` is never swallowed indefinitely by a healthy sibling's lease. The
   * watchdog records and names the release; `openPass` records it durably too
   * when a fresh pass supersedes a still-running wedged row, so the fence
   * (`passReleased`) is closed on both paths.
   */
  livePass(missionId: string): SchedulingPass | undefined {
    const row = this.rt.store.get('passes', this.passKey(missionId))
    if (row === undefined || row.missionId !== missionId) return undefined
    if (row.instanceId !== this.instanceId) return undefined
    if (row.status !== 'running') return undefined
    const age = Date.now() - row.startedAt
    if (age < this.rt.stallPassTimeoutMs) return row
    // Past the declared pass bound the row is a guard only while the mission has
    // live work to progress AND the bounded live-work hold has not elapsed. With
    // no live work it is not a guard at all, so the tick timer's kick is never
    // swallowed; the watchdog releases and escalates it.
    if (age < this.rt.stallPassReleaseBoundMs && this.hasLiveWork(missionId)) return row
    return undefined
  }

  /**
   * The subjects whose live work keeps `hasLiveWork` true: a running attempt
   * under a live lease, or a task in its durable stop transition. The release
   * names them so the owner can see what held the guard and that the release
   * preserved it (it cancels no task, drops no attempt and changes no lease).
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
   * R15-D1/D2: a pass body that is still `running` past its declared bound, from
   * THIS instance. `livePass` deliberately keeps such a row as a guard while the
   * mission has live work (a sibling lease, an in-flight stop acknowledgement),
   * so the watchdog does not abandon a pass that may legitimately be inside a long
   * adapter await. That gate must not silence another subject's clock: the
   * queue-external decision sweep reads this predicate and names the subjects the
   * wedged pass cannot finish, even while a healthy sibling holds its lease.
   *
   * Co-firing guards: `livePass` (still the scheduling gate inside the bounded
   * live-work window), the wedge watchdog (`checkSchedulingPasses`, which
   * releases inside the declared bound or the bounded live-work window), the
   * off-pass decision sweep (the only caller) and `hasLiveWork`. R16-D: the
   * bounded release does not weaken this predicate — it is still true for every
   * `running` row past the first bound, so the off-pass sweep keeps naming the
   * subjects the wedged pass cannot finish.
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
    // R16-D: a still-running predecessor is past every bound (else `livePass`
    // above would have returned it), so opening this pass SUPERSEDES and
    // RELEASES it. The slow path (the tick watchdog) normally gets there first;
    // when it does not — a `kick` from a control path between ticks — the
    // release must still be durable, fenced and named instead of being silently
    // overwritten by the row write below.
    if (prior !== undefined && prior.status === 'running' && prior.instanceId === this.instanceId) {
      const held = this.hasLiveWork(missionId)
      this.recordRelease(missionId, prior, releasedPassFields(prior), held, held ? this.liveWorkHolders(missionId) : [])
    }
    // Re-read: a supersede released the row above, and the durable release facts
    // must travel onto this row (the once-per-pass overwrite erases them
    // otherwise).
    const carried = this.rt.store.get('passes', this.passKey(missionId))
    const release = carried === undefined ? undefined : releasedPassFields(carried)
    const pass: SchedulingPass & ReleasedPassFields = {
      // One row per mission, overwritten each pass: `get(passKey)` is the gate.
      id: this.passKey(missionId), runId: id('run'), instanceId: this.instanceId, missionId, status: 'running', startedAt: Date.now(),
      revisionBefore: this.rt.store.revision(), fingerprintBefore: this.rt.fingerprint(missionId),
      noProgressPasses: carried?.status === 'finished' ? carried.noProgressPasses : 0,
    }
    // S5c: the durable release record survives the once-per-pass overwrite.
    if (release?.releasedRunId !== undefined) {
      pass.releasedRunId = release.releasedRunId
      pass.releasedAt = release.releasedAt
    }
    if (release?.releases !== undefined) pass.releases = release.releases
    if (release?.worstRelease !== undefined) pass.worstRelease = release.worstRelease
    this.rt.commit(missionId, () => this.rt.store.put('passes', pass))
    return pass
  }

  /**
   * R16-D: release a wedged pass durably and name it. One path for both
   * generators — the tick watchdog and a superseding `openPass` — so a release
   * can never happen without the durable `releasedRunId` fence, the accumulated
   * `releases`/`worstRelease` record and the owner escalation that names the
   * wedged pass and the live work the release preserved.
   *
   * The in-memory chain entry is dropped as well: the abandoned body is fenced
   * by `passReleased`, and a later `kick` must not queue behind a promise that
   * never settles.
   */
  private recordRelease(missionId: string, pass: SchedulingPass, previous: ReleasedPassFields, heldByLiveWork: boolean, holders: Array<{ subject: string; memberId?: string }>): void {
    const now = Date.now()
    const boundMs = heldByLiveWork ? this.rt.stallPassReleaseBoundMs : this.rt.stallPassTimeoutMs
    const unschedulable = this.unschedulable(this.rt.mission(missionId), this.rt.store.list('tasks', missionId), this.rt.store.list('members', missionId)).map(task => `${task.id} (${task.status})`)
    const fingerprintNow = this.rt.fingerprint(missionId)
    const release: ReleaseRecord = { runId: pass.runId, startedAt: pass.startedAt, releasedAt: now, gapMs: Math.max(0, now - pass.startedAt), boundMs, heldByLiveWork, liveSubjects: holders.map(holder => holder.subject) }
    const closed: SchedulingPass & ReleasedPassFields = {
      ...pass, status: 'finished', finishedAt: now, revisionAfter: this.rt.store.revision(), fingerprintAfter: fingerprintNow,
      stalled: { reason: 'pass-timeout', at: now, boundMs: this.rt.stallPassTimeoutMs, unschedulable },
    }
    // S5c: the release is recorded DURABLY on the row before anything else, so
    // `passReleased` reads it and the fence survives a cleared Set, a restart,
    // or the once-per-pass overwrite (openPass carries it forward).
    closed.releasedRunId = pass.runId
    closed.releasedAt = now
    closed.releases = (previous.releases ?? 0) + 1
    closed.worstRelease = widerRelease(previous.worstRelease, release)
    // Release both halves of the guard: the durable row stops gating and the
    // in-memory chain no longer queues later ticks behind a promise that never
    // settles. A newer pass that has already registered its own chain entry is
    // never clobbered (its `exclusive` finally compares identity).
    this.releasedPasses.add(pass.runId)
    this.rt.queues.delete(missionId)
    this.rt.commit(missionId, () => this.rt.store.put('passes', closed))
    this.escalateSchedulingStall(missionId, {
      pass: closed, reason: 'pass-timeout', boundMs: this.rt.stallPassTimeoutMs, revisionNow: closed.revisionAfter!, fingerprintNow,
      releaseBoundMs: boundMs, heldByLiveWork, release, liveHolders: holders,
    })
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
      // R16-D: the accumulated release facts are the only durable record of a
      // bounded release (the row is overwritten per pass), so a body that closes
      // after its release must carry them, never drop them.
      if (rowRelease.releases !== undefined && closed.releases === undefined) closed.releases = rowRelease.releases
      if (rowRelease.worstRelease !== undefined && closed.worstRelease === undefined) closed.worstRelease = rowRelease.worstRelease
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
   *
   * R16-D: the release is bounded even when the mission still has live work. A
   * live lease or an in-flight quiescence may be progress, so the pass is not
   * abandoned at the first bound; but a healthy sibling's lease must not own the
   * whole board's clock forever, so past `stallPassReleaseBoundMs` the pass is
   * released anyway, with the live work it was held by named on the escalation
   * and preserved untouched. Co-firing guards, named: `livePass` (mirrors the
   * same bound, so no `kick` is swallowed after the release), the fence
   * (`passReleased`, durable before the next pass opens), the off-pass decision
   * sweep (which runs while the row is wedged and names the subjects no live
   * path advances), the notice dedup (one escalation per unchanged board) and
   * the lease-renewal path (a released pass changes no task, attempt or lease).
   */
  checkSchedulingPasses(): void {
    if (this.rt.closed || this.rt.shuttingDown) return
    const now = Date.now()
    for (const mission of this.rt.store.list('missions')) {
      if (this.rt.isMissionTerminal(mission)) continue
      const pass = this.rt.store.get('passes', this.passKey(mission.id))
      if (pass === undefined || pass.instanceId !== this.instanceId || pass.status !== 'running') continue
      const age = now - pass.startedAt
      if (age < this.rt.stallPassTimeoutMs) continue
      if (this.rt.store.get('passes', this.passKey(mission.id))?.runId !== pass.runId) continue
      const held = this.hasLiveWork(mission.id)
      // Inside the second bound live work keeps the guard: a pass that may
      // legitimately be inside a long adapter await for that work must not be
      // abandoned. Past it the window is over, and the release below names the
      // subject that held it instead of leaving the guard unreleased.
      if (held && age < this.rt.stallPassReleaseBoundMs) continue
      this.recordRelease(mission.id, pass, releasedPassFields(pass), held, held ? this.liveWorkHolders(mission.id) : [])
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
    /** R16-D: the bound the release was measured against (the live-work window when one applied). */
    releaseBoundMs?: number
    /** R16-D: true when live work held the release to its second bound. */
    heldByLiveWork?: boolean
    /** R16-D: the release record written to the pass row, named in the event. */
    release?: ReleaseRecord
    /** R16-D: the live work the release preserved, as subjects and members. */
    liveHolders?: Array<{ subject: string; memberId?: string }>
  }): void {
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
    // R16-D: a release held to its second bound names the live work that held it
    // as a subject too. The claim is still "this pass cannot finish", but the
    // owner must be able to see which subjects made the wait unavoidable, and
    // that the release preserved them (it cancels no task, drops no attempt and
    // changes no lease). Guard pair: this naming x the off-pass sweep — the sweep
    // names what no live path advances, this names what the wedged pass never
    // reached and what held it; both carry task@epoch and neither consumes the
    // other's dedup key.
    const holders = info.liveHolders ?? []
    const subjects = [...new Set([...subjectsOfTasks(unreached, mission), ...holders.map(holder => holder.subject)])]
    const heldText = info.heldByLiveWork === true && holders.length
      ? ` The release was held to its ${info.releaseBoundMs ?? info.boundMs}ms live-work bound by work that is preserved untouched: ${holders.map(holder => holder.memberId === undefined ? holder.subject : `${holder.subject} held by ${holder.memberId}`).join(', ')}.`
      : ''
    const unreachedText = unreached.length ? unreached.map(task => `${task.id} (${task.status})`).join(', ') : 'none'
    // R15-D2: when a subject of this escalation is a blocked task whose stop is
    // past its declared bound (or carries no recorded start), the escalation
    // states that row-supported fact — the pass's release is exactly what makes
    // the stop unbounded.
    const stopFacts = unreached.filter(task => task.status === 'blocked' && task.resumeAfterStop?.epoch === task.epoch)
      .map(task => {
        const stop = task.resumeAfterStop
        return stop?.at === undefined
          ? `${task.id} is blocked and its stop carries no recorded start, so the declared bound (${info.boundMs}ms) cannot be shown to hold`
          : `${task.id} is blocked and its stop has been awaited for ${Math.max(0, Date.now() - stop.at)}ms, past its declared bound`
      })
    const stopText = stopFacts.length ? ` Stop state: ${stopFacts.join('; ')}.` : ''
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
        // R16-D: what the release was measured against, whether live work held it,
        // and the subjects whose work the release preserved. `boundMs` keeps its
        // original meaning (the pass's own stall bound) so every existing reader
        // is unchanged; the release facts are additive and only present on a
        // release, never on the no-progress variant.
        ...(info.release === undefined ? {} : {
          releasedAt: info.release.releasedAt,
          releaseBoundMs: info.releaseBoundMs ?? info.boundMs,
          releaseGapMs: info.release.gapMs,
          releasedWhileLive: info.heldByLiveWork === true,
          liveSubjects: info.release.liveSubjects,
        }),
      })
      // R17-G5: the release is a transition that still owes the dead pass's own
      // dispatch question, so the next fact publication runs with the wedged
      // branch even though the pass row is released by the time it runs.
      this.rt.expectWedgedRelease(missionId)
      this.rt.notify(missionId, info.reason === 'pass-timeout'
        ? `Scheduling pass ${info.pass.id} (run ${info.pass.runId}) for mission ${missionId} did not return within ${info.boundMs}ms and produced no durable state change (fingerprint ${fingerprint.slice(0, 12)}). The runtime released the mission's scheduling guard so later ticks proceed; unschedulable: ${unschedulable.join(', ') || 'none'}.${heldText} Work the pass never reached: ${unreachedText}.${stopText} Decide: inspect the named tasks, admit a repair with swarm_propose, or withdraw the blocking work with swarm_cancel.`
        : `Mission ${missionId} left its durable state unchanged for ${passes} consecutive scheduling passes (window ${info.boundMs}ms, revision ${info.pass.revisionBefore} → ${info.revisionNow}, fingerprint ${fingerprint.slice(0, 12)}) and terminated nothing. Unschedulable: ${unschedulable.join(', ') || 'none'}. Work with no progress: ${unreachedText}. Decide: admit work with swarm_propose, adjust the budget, or complete/stop the mission.`, subjects,
        // R17-G5: the pass release is its own fact, not the board's witness. A
        // wedged-pass escalation must not consume the board's W2 witness for a
        // fingerprint whose decision the transition-driven classifier still owes
        // (the dispatch question the dead pass never reached).
        { stampWitness: false })
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
   *  - the wedge release (`recordRelease`): the tick this guard runs on is the
   *    same queue-external tick that releases a wedged pass, so a pass that
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
    const pass = this.rt.store.get('passes', this.passKey(mission.id))
    const passState = pass !== undefined && pass.status === 'running' && this.passWedged(mission.id)
      ? ` The mission's scheduling pass ${pass.runId} is wedged past its ${this.rt.stallPassTimeoutMs}ms bound, so the in-pass recovery sweep cannot run either.`
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
   * R16-D: the round's silence projection. Read from the durable store alone —
   * the retained event window, the tool-run rows, the delivery rows, the current
   * task rows and the one durable pass row — and it changes nothing.
   *
   * The two numbers the round quotes:
   *  - the worst per-subject silent gap, each subject carrying the declared bound
   *    it was measured against (a released scheduling pass against the pass
   *    release bound; an escalated attempt against the attempt reporting bound);
   *  - the worst per-attempt reporting gap, plus how many attempts ended with no
   *    durable report or escalation at all.
   *
   * Definitions, stated so a reader can falsify them:
   *  - an attempt's durable elements are its `task/claimed` dispatch (and the
   *    assignment delivery written with it), every durable event naming its task
   *    or attempt while it was current, every delivery naming them, and every
   *    recorded tool run of the attempt;
   *  - its reporting gap is the longest interval between consecutive elements,
   *    closed at its end (or at read time while it is live);
   *  - it ended unreported when it is no longer the task's current attempt and no
   *    durable event or delivery after its dispatch ever named it — the dispatch
   *    itself is not a report about the attempt.   *
   * LIMITS, named rather than hidden: the attempt intervals come from the
   * retained event window (`maxEvents`), so an attempt whose dispatch has aged
   * out is not reconstructed; an attempt that ended with no closing event is
   * dated at its last durable element; the attempt bound quoted is the bound in
   * force at read time, not necessarily the one in force when an old escalation
   * fired (the escalation's own `[witness: …]` token carries that one).
   */
  silenceReport(missionId: string): SilenceReport {
    const now = Date.now()
    const bounds = { passMs: this.rt.stallPassTimeoutMs, passReleaseMs: this.rt.stallPassReleaseBoundMs, attemptMs: this.rt.attemptSilenceBoundMs }
    const events = this.rt.store.events(missionId, this.rt.config.maxEvents)
    const deliveries = this.rt.store.list('deliveries', missionId)
    const current = new Map(this.rt.store.list('tasks', missionId).map(task => [task.id, task]))
    type ElementKind = 'claim' | 'event' | 'delivery' | 'run'
    interface Element { at: number; kind: ElementKind; isClaim: boolean }
    interface Interval { attemptId: string; taskId: string; epoch: number; memberId: string; claimedAt: number; endedAt?: number; elements: Element[] }
    const byAttempt = new Map<string, Interval>()
    const open = new Map<string, Interval>()
    const claimStart = (event: SwarmEvent): void => {
      const data = event.data as { taskId?: unknown; attempt?: { id?: unknown; ownerId?: unknown; epoch?: unknown } } | undefined
      const taskId = typeof data?.taskId === 'string' ? data.taskId : undefined
      const attemptId = typeof data?.attempt?.id === 'string' ? data.attempt.id : undefined
      const ownerId = typeof data?.attempt?.ownerId === 'string' ? data.attempt.ownerId : undefined
      if (taskId === undefined || attemptId === undefined || ownerId === undefined) return
      const prior = open.get(taskId)
      // A re-dispatch is the durable close of the attempt it replaces.
      if (prior !== undefined) prior.endedAt = Math.min(prior.endedAt ?? event.createdAt, event.createdAt)
      const interval: Interval = { attemptId, taskId, epoch: typeof data?.attempt?.epoch === 'number' ? data.attempt.epoch : 0, memberId: ownerId, claimedAt: event.createdAt, elements: [{ at: event.createdAt, kind: 'claim', isClaim: true }] }
      byAttempt.set(attemptId, interval)
      open.set(taskId, interval)
    }
    const attribute = (taskId: string, element: Element): void => {
      const interval = open.get(taskId)
      if (interval !== undefined) interval.elements.push(element)
    }
    for (const event of events) {
      if (event.type === 'task/claimed') { claimStart(event); continue }
      // The event is attributed to the open attempt of each task it names; a
      // closer ends that attempt at this instant and takes it out of the open
      // set, so a later event about the same task is never attributed to a
      // closed attempt (a later delivery or run that names the attempt id is
      // still attributed, because that identity is exact).
      let closedTask: string | undefined
      for (const [taskId, interval] of open) {
        if (!this.identityIn(event.data, taskId, interval.attemptId)) continue
        interval.elements.push({ at: event.createdAt, kind: 'event', isClaim: false })
        if (isAttemptCloser(event.type)) { interval.endedAt = Math.min(interval.endedAt ?? event.createdAt, event.createdAt); closedTask = taskId }
      }
      if (closedTask !== undefined) open.delete(closedTask)
    }
    for (const run of this.rt.store.toolRuns(missionId)) {
      const interval = byAttempt.get(run.attemptId)
      if (interval === undefined) continue
      interval.elements.push({ at: run.createdAt, kind: 'run', isClaim: false })
    }
    for (const delivery of deliveries) {
      const interval = delivery.attemptId === undefined ? open.get(delivery.taskId ?? '') : byAttempt.get(delivery.attemptId)
      if (interval === undefined) continue
      // The assignment delivery is written in the same transaction as the
      // dispatch: it is the claim, not a report about the attempt.
      interval.elements.push({ at: delivery.createdAt, kind: 'delivery', isClaim: delivery.kind === 'assignment' })
    }
    const escalations = new Map<string, string[]>()
    for (const delivery of deliveries) {
      const key = delivery.notice?.dedupKey
      if (typeof key !== 'string') continue
      const attemptId = /^(?:attempt-silent|operation-silent):([^:]+):/.exec(key)?.[1]
      if (attemptId === undefined) continue
      const list = escalations.get(attemptId) ?? []
      list.push(key)
      escalations.set(attemptId, list)
    }
    const reports: AttemptReport[] = []
    const subjects: SubjectSilence[] = []
    for (const interval of byAttempt.values()) {
      const task = current.get(interval.taskId)
      const stillCurrent = task?.status === 'running' && task.attempt?.id === interval.attemptId
      const lastDurableAt = interval.elements.reduce((latest, element) => Math.max(latest, element.at), interval.claimedAt)
      // No closer was recorded but the task no longer carries the attempt: the
      // attempt ended at its last durable element, without a report.
      const endedAt = interval.endedAt ?? (stillCurrent ? undefined : lastDurableAt)
      const instants = [...new Set(interval.elements.map(element => element.at))].sort((a, b) => a - b)
      const end = endedAt === undefined ? now : Math.max(endedAt, instants.at(-1) ?? endedAt)
      let worstReportingGapMs = 0
      let previousInstant = interval.claimedAt
      for (const instant of instants) { worstReportingGapMs = Math.max(worstReportingGapMs, instant - previousInstant); previousInstant = instant }
      worstReportingGapMs = Math.max(worstReportingGapMs, end - previousInstant)
      const endedUnreported = endedAt !== undefined && !interval.elements.some(element => !element.isClaim && element.kind !== 'run')
      const attemptEscalations = escalations.get(interval.attemptId) ?? []
      reports.push({
        attemptId: interval.attemptId, taskId: interval.taskId, epoch: interval.epoch, memberId: interval.memberId,
        claimedAt: interval.claimedAt, ...(endedAt === undefined ? {} : { endedAt }), lastDurableAt,
        worstReportingGapMs, silentMs: Math.max(0, end - lastDurableAt), escalations: attemptEscalations, endedUnreported,
      })
      for (const key of attemptEscalations) {
        const delivery = deliveries.find(candidate => candidate.notice?.dedupKey === key)
        const silentSince = Number(key.slice(key.lastIndexOf(':') + 1))
        if (delivery === undefined || !Number.isSafeInteger(silentSince)) continue
        subjects.push({ subject: delivery.subjects?.[0] ?? `${interval.taskId}@${interval.epoch}`, kind: 'attempt', gapMs: Math.max(0, delivery.createdAt - silentSince), boundMs: bounds.attemptMs, at: delivery.createdAt })
      }
    }
    // The released scheduling passes: the durable pass row is the carrier (the
    // once-per-pass overwrite erases per-run detail, so it accumulates the worst).
    const passRow = this.rt.store.get('passes', this.passKey(missionId))
    const passRelease = passRow === undefined ? undefined : releasedPassFields(passRow)
    const worstRelease = passRelease?.worstRelease
    if (worstRelease !== undefined) {
      subjects.push({ subject: `pass:${worstRelease.runId}`, kind: 'scheduling-pass', gapMs: worstRelease.gapMs, boundMs: worstRelease.boundMs, at: worstRelease.releasedAt })
    }
    const worstSubjectSilence = subjects.reduce<SubjectSilence | undefined>((worst, item) =>
      worst === undefined || item.gapMs > worst.gapMs || (item.gapMs === worst.gapMs && item.gapMs - item.boundMs > worst.gapMs - worst.boundMs) ? item : worst, undefined)
    const worstAttempt = reports.reduce<{ attemptId: string; taskId: string; gapMs: number } | undefined>((worst, report) =>
      worst === undefined || report.worstReportingGapMs > worst.gapMs ? { attemptId: report.attemptId, taskId: report.taskId, gapMs: report.worstReportingGapMs } : worst, undefined)
    return {
      missionId, bounds, subjects, worstSubjectSilence,
      attempts: reports,
      worstAttemptReportingGap: worstAttempt,
      attemptsEnded: reports.filter(report => report.endedAt !== undefined).length,
      attemptsEndedUnreported: reports.filter(report => report.endedUnreported).length,
      attemptSilenceEscalations: subjects.filter(item => item.kind === 'attempt').length,
      passReleases: { count: passRelease?.releases ?? 0, worst: worstRelease },
      note: 'Read-only projection over the durable rows at read time. A subject silence is measured against the declared bound carried next to it: a released scheduling pass against the pass release bound it was released under, an escalated attempt against the attempt reporting bound in force at read time. The worst subject silence is the widest gap (ties: the widest overrun). The worst per-attempt reporting gap is the longest interval between durable elements attributable to one attempt, closed at its end or at read time. `attemptsEndedUnreported` counts attempts no longer current whose only durable element is their own dispatch. Limits: attempt intervals come from the retained event window, an attempt that ended with no closing event is dated at its last durable element, and a second release of an unchanged board is deduped into the first escalation (the pass row still counts it in `releases`).',
    }
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
