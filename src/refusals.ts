/**
 * The refusal registry: every admission decision becomes a durable row with a
 * stable reason, refusals are deduplicated on the durable ledger, and a
 * writer-busy retry is recorded as its own recovery. M1a seam 4/7.
 *
 * Behaviour-identical to the code moved from src/runtime.ts; the runtime keeps
 * thin forwarding methods so no call site changed.
 */
import { admissionRowId, decideAdmission, defaultLimitRules, scopeKeysOverlap, TASK_CLASSES, type AdmissionCandidate, type AdmissionDecision, type AdmissionRecord, type AdmissionUsage, type LimitRule } from './scheduler.ts'
import { WriterBusyError } from './store.ts'
import { hasNotice, proposalAllowance } from './arena.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { Budget, Member, Mission, Task } from './types.ts'

export function requireText(value: string, name: string): void { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`) }

export function requireStrings(value: string[], name: string): void {
  if (!Array.isArray(value) || value.length === 0 || !value.every(x => typeof x === 'string' && x.trim())) throw new Error(`${name} must contain nonempty strings`)
}

/** Exact ordered comparison of declared check lists (Round 9-C check integrity). */
export function sameChecks(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = left ?? [], b = right ?? []
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function validatedBudget(input: Budget): Budget {
  const budget = {} as Budget
  for (const key of ['maxTokens', 'maxSteps', 'maxWorkers', 'maxDurationMs', 'maxTasks', 'maxExperiments'] as const) {
    const value = input?.[key]
    if (!Number.isSafeInteger(value) || value < (key === 'maxExperiments' ? 0 : 1)) throw new Error(`Invalid budget ${key}`)
    budget[key] = value
  }
  return budget
}

/**
 * A provider rejection of an explicit reasoning effort. The Harness LLM layer
 * raises `UNSUPPORTED_REASONING_EFFORT` for a route whose model declares no such
 * effort; the same text can also reach the runtime as a plain string from the
 * worker adapter's failure callback, so both shapes are recognized.
 */
export function unsupportedEffort(error: unknown): { requested?: string; message: string } | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const code = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
  if (code !== 'UNSUPPORTED_REASONING_EFFORT' && !/does not support reasoning effort/i.test(message)) return undefined
  const requested = /reasoning effort "([^"]+)"/i.exec(message)?.[1]
  return { ...(requested === undefined ? {} : { requested }), message }
}

export class RefusalRegistry {


  constructor(private readonly rt: SwarmRuntime) {}

  /**
   * Effective hierarchical limits: durable owner rules, with the worker-budget
   * default kept only for a level the owner has not overridden with a `*` rule.
   */
  admissionRulesFor(mission: Mission): LimitRule[] {
    const durable = this.rt.store.list('limits', mission.id)
    return [...durable, ...defaultLimitRules(mission.id, mission.budget.maxWorkers)
      .filter(rule => !durable.some(overridden => overridden.level === rule.level && overridden.key === '*'))]
  }

  /** Concurrent slots in use, derived from live leases rather than a memory queue. */
  admissionUsage(missionId: string, candidate: AdmissionCandidate, member: Member): AdmissionUsage {
    const running = this.rt.store.list('tasks', missionId).filter(task => task.status === 'running')
    return {
      scope: running.filter(task => scopeKeysOverlap(task.scope[0] ?? '**', candidate.scope)).length,
      taskClass: running.filter(task => task.kind === candidate.taskClass).length,
      agent: running.filter(task => task.attempt?.ownerId === member.id).length,
    }
  }

  /** Budget dimensions that must refuse a new lease; undefined when the mission can admit. */
  budgetBlocked(mission: Mission): string | undefined {
    if (Date.now() >= mission.deadline) return `mission duration budget exhausted (deadline ${new Date(mission.deadline).toISOString()})`
    if (mission.usedTokens >= mission.budget.maxTokens) return `token budget exhausted (${mission.usedTokens}/${mission.budget.maxTokens})`
    if (mission.usedSteps >= mission.budget.maxSteps) return `step budget exhausted (${mission.usedSteps}/${mission.budget.maxSteps})`
    return undefined
  }

  admissionCandidate(missionId: string, task: Task, member: Member): AdmissionCandidate {
    return { missionId, memberId: member.id, taskId: task.id, taskClass: task.kind, scope: task.scope[0] ?? '**', epoch: task.epoch }
  }

  admissionDecision(mission: Mission, member: Member, task: Task): { candidate: AdmissionCandidate; decision: AdmissionDecision } {
    const candidate = this.admissionCandidate(mission.id, task, member)
    const usage = this.admissionUsage(mission.id, candidate, member)
    const signals: { budgetExceeded?: string; leaseConflict?: string } = {}
    const blocked = this.budgetBlocked(mission)
    if (blocked !== undefined) signals.budgetExceeded = blocked
    if (usage.agent > 0) signals.leaseConflict = `member ${member.id} already owns a running lease`
    return { candidate, decision: decideAdmission(candidate, this.admissionRulesFor(mission), usage, signals) }
  }

  admissionRecord(candidate: AdmissionCandidate, decision: AdmissionDecision, latencyMs: number): AdmissionRecord {
    const at = Date.now()
    return {
      id: admissionRowId(candidate, decision.reason), missionId: candidate.missionId, memberId: candidate.memberId, taskId: candidate.taskId, epoch: candidate.epoch,
      reason: decision.reason, admitted: decision.admitted, taskClass: candidate.taskClass, scope: candidate.scope,
      ...(decision.level !== undefined ? { level: decision.level } : {}), ...(decision.key !== undefined ? { key: decision.key } : {}),
      ...(decision.limit !== undefined ? { limit: decision.limit } : {}), ...(decision.inUse !== undefined ? { inUse: decision.inUse } : {}),
      count: 1, latencyMs, detail: decision.detail, firstAt: at, lastAt: at,
    }
  }

  /** Refusals merge in place; a changed cause or a second of staleness refreshes the row. */
  shouldRecordRefusal(next: AdmissionRecord): boolean {
    const previous = this.rt.store.get('admissions', next.id)
    if (previous === undefined) return true
    return previous.level !== next.level || previous.limit !== next.limit || previous.inUse !== next.inUse
      || previous.detail !== next.detail || next.lastAt - previous.lastAt >= 1000
  }

  /** Caller owns the transaction: upsert the refusal and announce it once. */
  upsertAdmission(record: AdmissionRecord): void {
    const existing = this.rt.store.get('admissions', record.id)
    this.rt.store.recordAdmission(record)
    if (existing === undefined) this.rt.store.event(record.missionId, 'admission/refused', 'runtime', {
      taskId: record.taskId, memberId: record.memberId, reason: record.reason, level: record.level, key: record.key,
      limit: record.limit, inUse: record.inUse, detail: record.detail,
    })
  }

  recordRefusal(candidate: AdmissionCandidate, decision: AdmissionDecision, latencyMs: number): void {
    const record = this.admissionRecord(candidate, decision, latencyMs)
    if (!this.shouldRecordRefusal(record)) return
    try {
      this.rt.commit(candidate.missionId, () => this.upsertAdmission(record))
    } catch (error) {
      if (error instanceof WriterBusyError) {
        this.rt.writerBusy = { at: Date.now(), attempts: error.attempts, candidate, detail: error.message }
        return
      }
      throw error
    }
  }

  /** Caller owns the transaction: one durable budget_exceeded row per waiting task. */
  upsertBudgetRefusals(mission: Mission, reason: string): void {
    for (const task of this.rt.store.list('tasks', mission.id)) {
      if (task.status !== 'pending') continue
      const memberId = task.assigneeId ?? task.plannedAssigneeId ?? 'unassigned'
      const candidate: AdmissionCandidate = { missionId: mission.id, memberId, taskId: task.id, taskClass: task.kind, scope: task.scope[0] ?? '**', epoch: task.epoch }
      const record = this.admissionRecord(candidate, { reason: 'budget_exceeded', admitted: false, detail: `budget_exceeded: ${reason}` }, 0)
      if (this.shouldRecordRefusal(record)) this.upsertAdmission(record)
    }
  }

  /**
   * Flush the classified writer conflict as a durable `writer_busy` admission row
   * once the writer is free again. The flag survives while the store stays busy.
   */
  recordWriterBusyRecovery(mission: Mission): void {
    const busy = this.rt.writerBusy
    if (busy === undefined) return
    const record = this.admissionRecord(busy.candidate, { reason: 'writer_busy', admitted: false, detail: busy.detail }, Math.max(0, Date.now() - busy.at))
    try {
      this.rt.commit(mission.id, () => this.upsertAdmission(record))
      this.rt.writerBusy = undefined
    } catch (error) {
      if (!(error instanceof WriterBusyError)) { this.rt.writerBusy = undefined; throw error }
    }
  }

  /**
   * Refuse a worker proposal for an allowance, budget or ceiling reason and
   * make it an owner decision: the refusal is recorded durably, an owner notice
   * names the member, the limit and the reason, and the same refusal is thrown
   * so the worker's tool result carries it. Never called for the owner, who
   * sees the error directly and is the actor who can raise the ceiling.
   */
  refuseProposal(mission: Mission, proposer: string, title: string, reason: string, limit: number): never {
    const message = `Worker ${proposer} cannot propose ${JSON.stringify(title)}: ${reason} (limit ${limit}). The owner can raise the mission ceiling with swarm_budget or admit the work with swarm_propose.`
    // Round 14: the budget chain's terminal element is the *owner decision*, not
    // the worker's tool error. The worker keeps the round-13 refusal text; the
    // owner notice becomes the coded decision request naming the executable
    // exits. The notice keeps the round-11 ledger invariant — a budget-class
    // notice is deduplicated by the mission-state fingerprint, not by a custom
    // key — so one unchanged board never re-wakes the owner.
    const terminal = guardTerminal('budget', { memberId: proposer, detail: `the proposal ${JSON.stringify(title)} was refused: ${reason} (limit ${limit})` })
    this.rt.commit(mission.id, () => {
      this.rt.store.event(mission.id, 'task/proposal-refused', proposer, { memberId: proposer, title, reason, limit })
      this.rt.notify(mission.id, terminal.message, proposer, 'budget', true)
    })
    // The owner notice must not wait for the next scheduler tick; flush it now.
    this.rt.kick(mission.id)
    throw new Error(message)
  }
}

/* ------------------------------------------------------------------------- *
 * Round 14 guard terminals.
 *
 * The kernel rule replaced "one owner remedy per failure mode" with "a guard
 * chain's last element escalates without conditions, so a dead end is
 * structurally impossible". A *guard chain* is the ordered set of predicates a
 * control path evaluates before it can act: budget, workspace state, the
 * attempt/lease lifecycle, per-task ceilings, review admission, dispatch
 * preconditions and admission itself (the seventh chain in the same family,
 * R12-F9). The *terminal element* is what happens when every predicate
 * before it answers "no": it must be an unconditional escalation that emits a
 * durable decision request naming the executable exits. It has no conditions of
 * its own — it cannot be skipped, deduplicated away into silence, or left
 * waiting for a later pass — and the only thing that may suppress a repeat is
 * the fact that the *same* decision request is already durable for the same
 * board fingerprint.
 *
 * `guardTerminal` is the single builder of those requests, so the pure board
 * model in `src/scheduling.ts`, the dispatch path that emits them, the
 * admission guard in `src/admission.ts` and the property test in
 * `tests/guard-terminals.test.mjs` all speak one vocabulary.
 * Every message carries a stable `[diagnostic_code]`, an imperative next step
 * and backticked parameters that resolve in the real tool schema — the refusal
 * lint (`tests/refusal-inventory.mjs`) is run over every one of them.
 * ------------------------------------------------------------------------- */

/** The seven control-path chains whose terminal element must escalate. */
export type GuardChainId = 'budget' | 'workspace' | 'attempt_lease' | 'task_ceiling' | 'review_admission' | 'dispatch_preconditions' | 'admission'

/** One executable exit: the tool, the parameter of that tool, and the instruction. */
export interface DecisionExit {
  tool: string
  parameter: string
  instruction: string
}

/** An unconditional terminal escalation: coded, durable and actionable. */
export interface GuardTerminal {
  chain: GuardChainId
  code: string
  message: string
  exits: DecisionExit[]
  /**
   * The other guard chains this terminal can co-fire with on the same board.
   * Every severe defect of 2026-09-10 was two individually-correct rules
   * multiplying into a trap, so the pair is named here and the pair test in
   * `tests/guard-terminals.test.mjs` exercises at least two of them.
   */
  coFires: GuardChainId[]
}

/** Free text a caller knows at emission time; never a condition on the escalation. */
export interface GuardTerminalContext {
  taskId?: string
  memberId?: string
  detail?: string
}

const GUARD_TERMINAL_CODES: Record<GuardChainId, string> = {
  budget: 'budget_terminal',
  workspace: 'workspace_terminal',
  attempt_lease: 'attempt_terminal',
  task_ceiling: 'task_ceiling_terminal',
  review_admission: 'review_admission_terminal',
  dispatch_preconditions: 'dispatch_terminal',
  // One vocabulary entry for the admission guard, which is the terminal element
  // of the seventh chain in the same family (R12-F9): the code is authored in
  // src/admission.ts and tests/guard-terminals.test.mjs asserts the two match.
  admission: 'dependency_assumption_missing',
}

/**
 * The co-firing guards of each chain, as observed on the 2026-09-10 host: a
 * clean-tree workspace guard fired together with the review-capture guard and
 * bricked a member, and "Member has uncommitted commits" fired together with
 * the attempt-preservation guard with no exit at all.
 */
const GUARD_TERMINAL_CO_FIRES: Record<GuardChainId, GuardChainId[]> = {
  budget: ['dispatch_preconditions', 'workspace'],
  workspace: ['attempt_lease', 'review_admission', 'dispatch_preconditions'],
  attempt_lease: ['workspace', 'task_ceiling', 'dispatch_preconditions'],
  task_ceiling: ['dispatch_preconditions', 'budget'],
  review_admission: ['workspace', 'dispatch_preconditions'],
  dispatch_preconditions: ['workspace', 'attempt_lease', 'task_ceiling', 'budget', 'review_admission'],
  admission: ['workspace', 'dispatch_preconditions'],
}

const described = (context: GuardTerminalContext, fallback: string): string => context.detail ?? fallback

/**
 * Build the unconditional terminal escalation of one guard chain. Pure and
 * total: it never returns undefined and it reads no board state, so no earlier
 * element of the chain can prevent it from existing. The dispatch path wraps
 * the result in a durable event and owner decision notice.
 */
export function guardTerminal(chain: GuardChainId, context: GuardTerminalContext = {}): GuardTerminal {
  const task = context.taskId ?? 'the held work'
  const member = context.memberId ?? 'the member'
  const messages: Record<GuardChainId, string> = {
    budget: `[budget_terminal] The mission budget is exhausted or paused (${described(context, 'no lease can be admitted')}), so ${member} cannot be given work and no attempt can renew. Raise the mission ceiling with \`swarm_budget\` by passing the raised \`budget\` and a \`reason\`, or withdraw the work holding the slot with \`swarm_cancel\` by naming the \`taskId\` and a \`reason\`, then decide with \`swarm_control\` and an \`action\`.`,
    workspace: `[workspace_terminal] The mission workspace cannot produce an artifact (${described(context, 'workspace state is unresolved')}), so ${task} would loop without an exit. Repair the member workspace, then re-propose the blocked work with \`swarm_propose\` by passing the \`objective\`, \`dependencies\` and \`replaces\`, or withdraw it with \`swarm_cancel\` by naming the \`taskId\` and a \`reason\`.`,
    attempt_lease: `[attempt_terminal] The attempt on ${task} cannot advance (${described(context, 'the lease or the workspace guard refused it')}). Release the attempt with \`swarm_handoff\` by passing the \`attemptId\` and a \`summary\` and let the next owner resume, or withdraw the task with \`swarm_cancel\` and its \`taskId\` and then re-propose the work with \`swarm_propose\` and its \`objective\`.`,
    task_ceiling: `[task_ceiling_terminal] ${task} exhausted its own ceiling (${described(context, 'step or finding limit')}) and cannot be dispatched again. Propose its replacement with \`swarm_propose\`: name it in \`replaces\` and pass a raised \`maxSteps\` or \`maxFindings\` inside the mission budget, keeping the acceptance criteria verbatim; or withdraw it with \`swarm_cancel\` and its \`taskId\`.`,
    admission: `[dependency_assumption_missing] ${task} declares no dependency while its text assumes prior work is already available (${described(context, 'the worktree would be prepared from the bare mission baseline')}), so the work starts without the content it needs. Add the dependency that carries that content with \`swarm_propose\` by passing \`dependencies\`, or state in the \`objective\` how you will obtain it and retry the same task with the same acceptance criteria and budget; a repair may name the blocked task in \`replaces\` instead.`,
    review_admission: `[review_admission_terminal] Submitted work ${task} has no live independent review path, so no verdict can ever land. Admit a review with \`swarm_propose\` by passing \`kind\`, \`reviewOf\`, \`scope\` and \`acceptance\`, or withdraw the source with \`swarm_cancel\` and its \`taskId\`.`,
    dispatch_preconditions: `[dispatch_terminal] No executable action remains (${described(context, 'no task is ready for a live member and no attempt is in flight')}). Inspect the blocker with \`swarm_observe\` and its \`taskId\`, free a slot or raise a limit with \`swarm_budget\` and its \`budget\`, repair the work with \`swarm_propose\` and its \`replaces\`, withdraw the stuck work with \`swarm_cancel\` and its \`taskId\`, or decide with \`swarm_control\` and its \`action\`.`,
  }
  const exits: Record<GuardChainId, DecisionExit[]> = {
    budget: [
      { tool: 'swarm_budget', parameter: 'budget', instruction: 'raise the mission ceiling with a reason' },
      { tool: 'swarm_cancel', parameter: 'taskId', instruction: 'withdraw the work holding the slot' },
      { tool: 'swarm_control', parameter: 'action', instruction: 'resume, complete or stop the mission' },
    ],
    workspace: [
      { tool: 'swarm_propose', parameter: 'dependencies', instruction: 're-propose the work with the dependency that carries missing content' },
      { tool: 'swarm_cancel', parameter: 'taskId', instruction: 'withdraw the work the workspace cannot produce' },
    ],
    attempt_lease: [
      { tool: 'swarm_handoff', parameter: 'attemptId', instruction: 'release the attempt to another owner' },
      { tool: 'swarm_cancel', parameter: 'taskId', instruction: 'withdraw the task and re-propose it' },
    ],
    task_ceiling: [
      { tool: 'swarm_propose', parameter: 'replaces', instruction: 'propose the replacement with a raised ceiling' },
      { tool: 'swarm_cancel', parameter: 'taskId', instruction: 'withdraw the exhausted task' },
    ],
    admission: [
      { tool: 'swarm_propose', parameter: 'dependencies', instruction: 'add the dependency that carries the assumed content' },
      { tool: 'swarm_propose', parameter: 'replaces', instruction: 'repair the task that carried the content, or state in the objective how it will be obtained' },
    ],
    review_admission: [
      { tool: 'swarm_propose', parameter: 'reviewOf', instruction: 'admit an independent verification task' },
      { tool: 'swarm_cancel', parameter: 'taskId', instruction: 'withdraw the unreviewable source' },
    ],
    dispatch_preconditions: [
      { tool: 'swarm_observe', parameter: 'taskId', instruction: 'read the exact blocker before deciding' },
      { tool: 'swarm_propose', parameter: 'replaces', instruction: 'repair or extend the board' },
      { tool: 'swarm_cancel', parameter: 'taskId', instruction: 'withdraw the stuck work' },
      { tool: 'swarm_control', parameter: 'action', instruction: 'complete or stop the mission' },
    ],
  }
  return { chain, code: GUARD_TERMINAL_CODES[chain], message: messages[chain], exits: exits[chain], coFires: [...GUARD_TERMINAL_CO_FIRES[chain]] }
}

/** The durable dedup key of one terminal decision request: one per chain and board state. */
export function guardTerminalKey(chain: GuardChainId, code: string, fingerprint: string): string {
  return `guard-terminal:${chain}:${code}:${fingerprint}`
}

/**
 * Emit one guard-chain terminal: the durable decision request and the owner
 * notice that make it unconditional.
 *
 * This is the *mechanical opt-in* for every call site that still ends a guard
 * chain in prose or in silence, including the ones outside this branch's scope
 * (`src/attempts.ts`, `src/workspace-admission.ts`, `src/notices.ts`,
 * `src/runtime.ts`). Wiring a site is a two-line change:
 *
 *     const terminal = guardTerminal('<chain>', { taskId, memberId, detail })
 *     emitGuardTerminal(this.rt, missionId, '<chain>', { taskId, memberId, detail })
 *
 * The helper takes the runtime as its first argument (not a method on one
 * class), so a caller in any module can reach it without importing the
 * scheduling seam or the runtime class; `Scheduling.escalateGuardTerminal`
 * delegates here and keeps the dispatch path's call shape unchanged.
 *
 * Behaviour, in one sentence: the terminal is always built, and a durable row is
 * written unless the *same* decision request for the *same* board fingerprint is
 * already on the delivery ledger. Nothing else can suppress it; a writer-busy
 * transaction is recorded on the runtime's writer-busy flag and the state is
 * re-derived by the next pass.
 */
export function emitGuardTerminal(rt: SwarmRuntime, missionId: string, chain: GuardChainId, context: GuardTerminalContext = {}): GuardTerminal | undefined {
  const mission = rt.store.get('missions', missionId)
  // S4r-D5: only a terminal mission (completed/stopped) ends the chain's duty to
  // speak. A mission that left `active` without reaching a terminal status —
  // most importantly `blocked` after a budget stop, which is when the owner needs
  // the executable exit most — still emits the terminal.
  if (mission === undefined || rt.isMissionTerminal(mission)) return undefined
  const terminal = guardTerminal(chain, context)
  const fingerprint = rt.fingerprint(missionId)
  const key = guardTerminalKey(chain, terminal.code, fingerprint)
  if (hasNotice(rt.store.list('deliveries', missionId), { class: 'decision', dedupKey: key, from: 'runtime' })) return terminal
  try {
    rt.commit(missionId, () => {
      // The board-stall event type is reused with `cause: 'guard-terminal'`, so
      // the durable log names the chain and the code without inventing an
      // unregistered event type (the vocabulary is a separate owner surface).
      rt.store.event(missionId, 'mission/stalled', 'runtime', {
        cause: 'guard-terminal', chain: terminal.chain, code: terminal.code,
        taskId: context.taskId ?? null, memberId: context.memberId ?? null, detail: context.detail ?? null,
        coFires: terminal.coFires, fingerprint, ownerNotified: true,
      })
      rt.notify(missionId, terminal.message, 'runtime', 'decision', true, key)
    })
  } catch (error) {
    // A busy writer must not turn an escalation into an unhandled rejection.
    // The state is re-derived on the next pass, and the board-level witness path
    // still speaks for a stalled board, so no silence follows.
    if (error instanceof WriterBusyError) {
      rt.writerBusy = { at: Date.now(), attempts: error.attempts, candidate: { missionId, memberId: 'runtime', taskId: context.taskId ?? 'unknown', taskClass: 'research', scope: '**', epoch: 0 }, detail: error.message }
      return terminal
    }
    throw error
  }
  // The notice path must not share the fate of the pass that could not report
  // it: the queue-external pump delivers it.
  rt.pumpOutbox()
  return terminal
}
