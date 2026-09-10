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
import { proposalAllowance } from './arena.ts'
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
    this.rt.commit(mission.id, () => {
      this.rt.store.event(mission.id, 'task/proposal-refused', proposer, { memberId: proposer, title, reason, limit })
      this.rt.notify(mission.id, message, proposer, 'budget')
    })
    // The owner notice must not wait for the next scheduler tick; flush it now.
    this.rt.kick(mission.id)
    throw new Error(message)
  }
}
