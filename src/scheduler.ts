/**
 * D8 admission control: hierarchical per-scope limits and durable reason codes.
 *
 * This module is pure policy. It never opens the store, so `store.ts` can import
 * its record types without an import cycle, and the load harness can exercise the
 * same decision function the runtime uses.
 *
 * Every admission decision becomes a durable row whose `reason` is one of
 * `admitted` | `queue_full` | `budget_exceeded` | `lease_conflict` | `writer_busy`.
 * Limits are hierarchical — scope, then task class, then agent — and a candidate
 * is admitted only when every level has a free slot; the strictest matching rule
 * at each level wins. There is no in-memory wait queue: refused candidates stay
 * durable rows (`tasks` for the work, `admissions` for the refusal) and the next
 * scheduler tick re-evaluates them.
 *
 * Boundary: this ledger makes refusals auditable, it does not make concurrent
 * writers safe. The store is single-host, single-writer; a competing writer is
 * classified as `writer_busy` and retried with bounded backoff. See
 * `scripts/load/README.md` and `src/store.ts`.
 */
import { errorChain, isQuotaExceededError } from '@deepseek-ai/dsh-llm'
import type { ProviderOutage } from './types.ts'
export const ADMISSION_REASONS = ['admitted', 'queue_full', 'budget_exceeded', 'lease_conflict', 'writer_busy'] as const
export type AdmissionReason = (typeof ADMISSION_REASONS)[number]

/**
 * R11-01: classify a provider failure as a capacity/quota/availability outage.
 * The adapter classifies at the boundary where the provider error is still
 * structured (HTTP status and the Harness' stable codes), and the runtime
 * routes on the returned class, never on message text. Returns undefined for a
 * task/worker defect that should spend recovery credit normally.
 */
export function classifyProviderOutage(error: unknown): ProviderOutage | undefined {
  const record = error !== null && typeof error === 'object' ? error as { status?: unknown; statusCode?: unknown; code?: unknown; failure?: { status?: unknown } } : undefined
  let status: number | undefined
  for (const candidate of [record?.status, record?.statusCode, record?.failure?.status]) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599) { status = candidate; break }
  }
  const code = typeof record?.code === 'string' ? record.code : undefined
  const message = errorChain(error)
  const detail = `${code ?? ''} ${status ?? ''} ${message}`
  const bounded = message.length > 500 ? `${message.slice(0, 500)}…` : message
  if (status === 402) return { class: 'quota', status, message: bounded }
  if (status === 429) return { class: 'rate-limit', status, message: bounded }
  if (status !== undefined && status >= 500) return { class: 'unavailable', status, message: bounded }
  if (code === 'QUOTA' || isQuotaExceededError(detail)) return { class: 'quota', ...(status === undefined ? {} : { status }), message: bounded }
  if (code === 'RATE_LIMIT' || /\brate[\s_-]*limit\b|\btoo many requests\b/i.test(detail)) return { class: 'rate-limit', ...(status === undefined ? {} : { status }), message: bounded }
  if (code === 'SERVER' || code === 'TIMEOUT' || code === 'TRANSPORT' || code === 'PROVIDER_UNAVAILABLE'
    || /\bprovider\b[^.]{0,40}\b(?:unavailable|unreachable|down)\b|\bservice unavailable\b|\boverloaded\b|\b(?:502|503|504)\b|socket hang up|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|upstream connect error/i.test(detail)) {
    return { class: 'unavailable', ...(status === undefined ? {} : { status }), message: bounded }
  }
  return undefined
}

/** Broadest to narrowest: a candidate must have a free slot at every level. */
export const LIMIT_LEVELS = ['scope', 'taskClass', 'agent'] as const
export type LimitLevel = (typeof LIMIT_LEVELS)[number]

/** Task classes that may carry a task-class limit; `*` matches every class. */
export const TASK_CLASSES = ['research', 'implementation', 'verification', 'integration'] as const

/**
 * One durable hierarchical limit. `key` is `*` (every key at this level) or a
 * literal level key: a scope selector, a task class, or a member id.
 */
export interface LimitRule {
  id: string
  missionId: string
  level: LimitLevel
  key: string
  /** Maximum concurrent admissions at this level. */
  limit: number
  createdAt: number
}

/** One durable admission decision. Refusals merge in place so the ledger is bounded. */
export interface AdmissionRecord {
  id: string
  missionId: string
  memberId: string
  taskId: string
  /** Attempt epoch the decision belongs to; one row per candidate and reason. */
  epoch: number
  reason: AdmissionReason
  admitted: boolean
  taskClass: string
  scope: string
  level?: LimitLevel
  key?: string
  limit?: number
  inUse?: number
  /** Recorded decisions for this candidate and reason (refusals upsert in place). */
  count: number
  /** Wall-clock decision latency in milliseconds. */
  latencyMs: number
  detail: string
  firstAt: number
  lastAt: number
}

export interface AdmissionCandidate {
  missionId: string
  memberId: string
  taskId: string
  taskClass: string
  scope: string
  epoch: number
}

/** Concurrent admissions currently holding a slot at each level. */
export interface AdmissionUsage {
  scope: number
  taskClass: number
  agent: number
}

/**
 * Host facts that outrank configured limits. Each is a short reason, so the
 * durable row explains the refusal without re-reading runtime state.
 */
export interface AdmissionSignals {
  budgetExceeded?: string
  leaseConflict?: string
  writerBusy?: string
}

export interface AdmissionDecision {
  reason: AdmissionReason
  admitted: boolean
  level?: LimitLevel
  key?: string
  limit?: number
  inUse?: number
  detail: string
}

/** Typed refusal so callers can distinguish admission control from a real fault. */
export class AdmissionRefusedError extends Error {
  readonly reason: AdmissionReason
  readonly decision: AdmissionDecision
  constructor(decision: AdmissionDecision) {
    super(`Admission refused (${decision.reason}): ${decision.detail}`)
    this.name = 'AdmissionRefusedError'
    this.reason = decision.reason
    this.decision = decision
  }
}

/** Directory selectors nest; `**` covers everything. Exact equality always matches. */
export function scopeKeysOverlap(a: string, b: string): boolean {
  if (a === '**' || b === '**') return true
  if (a === b) return true
  return (a.endsWith('/') && b.startsWith(a)) || (b.endsWith('/') && a.startsWith(b))
}

/** The key a candidate is counted and matched under at each level. */
export function candidateKeys(candidate: AdmissionCandidate): Record<LimitLevel, string> {
  return { scope: candidate.scope, taskClass: candidate.taskClass, agent: candidate.memberId }
}

function ruleMatches(level: LimitLevel, key: string, rule: LimitRule): boolean {
  if (rule.level !== level) return false
  if (rule.key === '*') return true
  if (level === 'scope') return scopeKeysOverlap(rule.key, key)
  return rule.key === key
}

/**
 * The strictest matching rule at one level, or undefined when the level is
 * unlimited. A key-specific rule wins a tie with `*` so the audit trail names
 * the narrowest rule that blocked the candidate.
 */
export function effectiveLimit(level: LimitLevel, key: string, rules: readonly LimitRule[]): LimitRule | undefined {
  let best: LimitRule | undefined
  for (const rule of rules) {
    if (!ruleMatches(level, key, rule)) continue
    if (best === undefined || rule.limit < best.limit || (rule.limit === best.limit && best.key === '*' && rule.key !== '*')) best = rule
  }
  return best
}

/** Default hierarchy: never more concurrent leases than the worker budget, one per agent. */
export function defaultLimitRules(missionId: string, maxWorkers: number): LimitRule[] {
  const limit = Math.max(1, maxWorkers)
  return LIMIT_LEVELS.map(level => ({
    id: `limit:${missionId}:default:${level}`, missionId, level, key: '*', limit: level === 'agent' ? 1 : limit, createdAt: 0,
  }))
}

/**
 * Decide one admission. Host signals (writer, budget, lease) are evaluated before
 * configured limits so a refusal names the real cause; limits are then checked
 * broadest to narrowest and the first exhausted level is reported.
 */
export function decideAdmission(
  candidate: AdmissionCandidate, rules: readonly LimitRule[], usage: AdmissionUsage, signals: AdmissionSignals = {},
): AdmissionDecision {
  if (signals.writerBusy !== undefined) {
    return { reason: 'writer_busy', admitted: false, detail: `writer_busy: ${signals.writerBusy}` }
  }
  if (signals.budgetExceeded !== undefined) {
    return { reason: 'budget_exceeded', admitted: false, detail: `budget_exceeded: ${signals.budgetExceeded}` }
  }
  if (signals.leaseConflict !== undefined) {
    return { reason: 'lease_conflict', admitted: false, detail: `lease_conflict: ${signals.leaseConflict}` }
  }
  const keys = candidateKeys(candidate)
  for (const level of LIMIT_LEVELS) {
    const rule = effectiveLimit(level, keys[level], rules)
    if (rule === undefined) continue
    if (usage[level] >= rule.limit) {
      return {
        reason: 'queue_full', admitted: false, level, key: keys[level], limit: rule.limit, inUse: usage[level],
        detail: `queue_full at ${level} (${JSON.stringify(keys[level])}): ${usage[level]}/${rule.limit} concurrent slots in use`,
      }
    }
  }
  return { reason: 'admitted', admitted: true, detail: `admitted under ${rules.length} limit rule(s)` }
}

/**
 * Deterministic ledger identity. One row per candidate attempt and reason, so a
 * candidate refused every tick for a minute still occupies exactly one row.
 */
export function admissionRowId(candidate: AdmissionCandidate, reason: AdmissionReason): string {
  return `admission:${candidate.taskId}:${candidate.memberId}:${candidate.epoch}:${reason}`
}
