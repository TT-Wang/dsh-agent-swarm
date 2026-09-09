/**
 * D6 trace contracts: a closed span vocabulary, digest-addressed payloads that
 * live outside the durable event log, causal closure across worker hops, an
 * executable replay gate over the durable log, event surfacing for the read
 * path and trace-level metrics (contract compliance, first violating step).
 *
 * Design boundaries:
 * - `src/store.ts` and `src/types.ts` are owned by other tasks and are not
 *   modified. Spans are therefore appended through the existing
 *   `SwarmStore.event`/`transaction` API as `trace/span` events; the payload
 *   bytes they digest live in a content-addressed directory beside the state
 *   file, so the log stays bounded by construction.
 * - The replay gate reads the durable event log (SQLite rows) and replays the
 *   orchestrator's externally visible command sequence with no provider call.
 *   It fails with a named error on a corrupted or truncated log and on a
 *   command sequence that diverges from the recorded/golden sequence.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SwarmEvent } from './types.ts'

/** Closed operation vocabulary from the D6 contract (OTel/OpenInference analogue). */
export const TRACE_OPERATIONS = ['agent', 'tool', 'llm', 'retrieval', 'review', 'merge'] as const
export type TraceOperation = (typeof TRACE_OPERATIONS)[number]
/** Closed status vocabulary. */
export const TRACE_STATUSES = ['ok', 'error'] as const
export type TraceStatus = (typeof TRACE_STATUSES)[number]
/** Closed `error.type` vocabulary; every failed span names exactly one. */
export const TRACE_ERROR_TYPES = ['validation_error', 'authorization_error', 'budget_error', 'lease_error', 'conflict_error', 'tool_error', 'internal_error', 'contract_error'] as const
export type TraceErrorType = (typeof TRACE_ERROR_TYPES)[number]
/** Closed step vocabulary: one row per orchestration step, no free-form names. */
export const TRACE_STEPS = ['swarm_stage', 'swarm_launch', 'swarm_budget', 'swarm_create', 'swarm_add_member', 'swarm_workstream', 'swarm_propose', 'swarm_claim', 'swarm_publish', 'swarm_submit', 'swarm_verify', 'swarm_message', 'swarm_challenge', 'swarm_handoff', 'swarm_subscribe', 'swarm_wait', 'swarm_observe', 'swarm_control', 'swarm_cancel', 'delivery-apply'] as const
export type TraceStep = (typeof TRACE_STEPS)[number]
const OPERATION_BY_STEP: Record<TraceStep, TraceOperation> = {
  swarm_stage: 'agent', swarm_launch: 'agent', swarm_budget: 'agent', swarm_create: 'agent', swarm_add_member: 'agent', swarm_workstream: 'agent',
  swarm_propose: 'tool', swarm_claim: 'agent', swarm_publish: 'tool', swarm_submit: 'tool', swarm_verify: 'review', swarm_message: 'tool',
  swarm_challenge: 'tool', swarm_handoff: 'agent', swarm_subscribe: 'tool', swarm_wait: 'tool', swarm_observe: 'tool', swarm_control: 'agent',
  swarm_cancel: 'agent', 'delivery-apply': 'merge',
}
export const spanOperation = (step: TraceStep): TraceOperation => OPERATION_BY_STEP[step]
export const isTraceOperation = (value: unknown): value is TraceOperation => typeof value === 'string' && (TRACE_OPERATIONS as readonly string[]).includes(value)
export const isTraceStep = (value: unknown): value is TraceStep => typeof value === 'string' && (TRACE_STEPS as readonly string[]).includes(value)
export const isTraceStatus = (value: unknown): value is TraceStatus => value === 'ok' || value === 'error'
export const isTraceErrorType = (value: unknown): value is TraceErrorType => typeof value === 'string' && (TRACE_ERROR_TYPES as readonly string[]).includes(value)
/** Map a thrown orchestration failure onto the closed `error.type` vocabulary. */
export function errorTypeFor(error: unknown): TraceErrorType {
  const message = error instanceof Error ? error.message : String(error)
  if (/not a participant|unauthorized|Only the mission owner|Only a member|Only the primary user|Workers cannot|authenticated|bypass mission authority|owner session/i.test(message)) return 'authorization_error'
  if (/budget|exhausted|deadline/i.test(message)) return 'budget_error'
  if (/lease|no longer current|fenced|already owns an open task/i.test(message)) return 'lease_error'
  if (/changed during|already exists|is terminal|conflict/i.test(message)) return 'conflict_error'
  if (/must be|Invalid|Unknown|is required|Expected an object|requires/i.test(message)) return 'validation_error'
  return 'tool_error'
}

const TRACE_ID = /^[0-9a-f]{32}$/
const SPAN_ID = /^[0-9a-f]{16}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/

/** Named trace/replay failures; callers branch on the class, never on message text. */
export class TraceContractError extends Error {
  constructor(message: string, readonly seq?: number, readonly step?: string) { super(message); this.name = 'TraceContractError' }
}
export class ReplayCorruptionError extends Error {
  constructor(message: string, readonly seq?: number) { super(message); this.name = 'ReplayCorruptionError' }
}
export class ReplayTruncationError extends Error {
  constructor(message: string, readonly unresolved: string[]) { super(message); this.name = 'ReplayTruncationError' }
}
export class ReplayDivergenceError extends Error {
  constructor(message: string, readonly index: number, readonly expected?: string, readonly actual?: string) { super(message); this.name = 'ReplayDivergenceError' }
}

/** Deterministic JSON so a digest is stable across processes and key order. */
export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return typeof item === 'number' && !Number.isFinite(item) ? null : item
    if (Array.isArray(item)) return item.map(canonical)
    const entries = Object.entries(item as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return Object.fromEntries(entries.map(([key, entry]) => [key, canonical(entry)]))
  }
  return JSON.stringify(canonical(value)) ?? 'null'
}
export const digestText = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
export const digestPayload = (value: unknown): string => digestText(canonicalJson(value))
/** W3C trace context id: deterministic from the mission, so worker hops join one trace. */
export const traceIdFor = (missionId: string): string => createHash('sha256').update(missionId, 'utf8').digest('hex').slice(0, 32)
export const traceparentFor = (traceId: string, spanId: string): string => `00-${traceId}-${spanId}-01`

export interface TracePayloadRef { digest: string; bytes: number; stored: boolean }
export interface TraceSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  missionId: string
  attemptId?: string
  taskId?: string
  operation: TraceOperation
  step: TraceStep
  status: TraceStatus
  errorType?: TraceErrorType
  startedAt: number
  endedAt: number
  traceparent: string
  actor: string
  input: TracePayloadRef
  output: TracePayloadRef
}

/** Content-addressed payload store beside the state file; digests, not payloads, enter the log. */
export class TracePayloadStore {
  constructor(readonly directory: string, readonly maxBytes = 262144) {}
  pathFor(digest: string): string { return join(this.directory, `${digest.slice('sha256:'.length)}.json`) }
  async put(value: unknown): Promise<TracePayloadRef> {
    const text = canonicalJson(value)
    const digest = digestText(text)
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.maxBytes) return { digest, bytes, stored: false }
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try { await writeFile(this.pathFor(digest), text, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    return { digest, bytes, stored: true }
  }
  async read(digest: string): Promise<string | undefined> {
    if (!DIGEST.test(digest)) return undefined
    try { return await readFile(this.pathFor(digest), 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  /** Re-hash the stored bytes: true only when the file is present and intact. */
  async verify(ref: TracePayloadRef): Promise<boolean> {
    if (!ref.stored) return true
    const text = await this.read(ref.digest)
    return text !== undefined && digestText(text) === ref.digest
  }
}

/** Structural slice of `SwarmStore` the trace layer needs; keeps store.ts untouched. */
export interface TraceStore {
  events(missionId: string, limit: number, after?: number): SwarmEvent[]
  event(missionId: string, type: string, actor: string, data: unknown): void
  transaction<T>(operation: () => T): T
}

const SEED_LIMIT = 20000
const HISTORY_SCAN_LIMIT = 100000
const HISTORY_PAGE_DEFAULT = 50
const HISTORY_PAGE_MAX = 500

interface SpanIndex {
  byTask: Map<string, TraceSpan[]>
  byAttempt: Map<string, TraceSpan[]>
  all: TraceSpan[]
}
/**
 * One recorder per runtime process. Each mission's span index is seeded once
 * from the durable log (so a plugin reload can still close a parent chain) and
 * updated as spans are written, which keeps parent lookup O(1) instead of
 * re-reading the log on every tool call.
 */
export class TraceRecorder {
  private readonly indexes = new Map<string, SpanIndex>()
  private readonly unscoped = new Map<string, number>()
  constructor(readonly store: TraceStore, readonly payloads: TracePayloadStore) {}
  /** A recorder exists only when the runtime owns a durable store and state path. */
  static forRuntime(runtime: unknown): TraceRecorder | undefined {
    const candidate = runtime as { config?: { statePath?: unknown }; store?: Partial<TraceStore> } | undefined
    const statePath = candidate?.config?.statePath
    const store = candidate?.store
    if (typeof statePath !== 'string' || !statePath) return undefined
    if (!store || typeof store.event !== 'function' || typeof store.transaction !== 'function' || typeof store.events !== 'function') return undefined
    return new TraceRecorder(store as TraceStore, new TracePayloadStore(join(dirname(statePath), 'trace-payloads')))
  }
  private index(missionId: string): SpanIndex {
    const existing = this.indexes.get(missionId)
    if (existing) return existing
    const index: SpanIndex = { byTask: new Map(), byAttempt: new Map(), all: [] }
    for (const event of this.store.events(missionId, SEED_LIMIT, 0)) {
      if (event.type !== 'trace/span') continue
      const span = event.data as TraceSpan | undefined
      if (span === null || typeof span !== 'object' || typeof span.spanId !== 'string') continue
      this.remember(index, span)
    }
    this.indexes.set(missionId, index)
    return index
  }
  private remember(index: SpanIndex, span: TraceSpan): void {
    index.all.push(span)
    if (span.taskId) { const list = index.byTask.get(span.taskId) ?? []; list.push(span); index.byTask.set(span.taskId, list) }
    if (span.attemptId) { const list = index.byAttempt.get(span.attemptId) ?? []; list.push(span); index.byAttempt.set(span.attemptId, list) }
  }
  spansFor(missionId: string): TraceSpan[] { return [...this.index(missionId).all] }
  /**
   * A step with no mission scope (draft planning, the mission list) cannot
   * carry a valid `mission_id`, so it is counted rather than recorded. The
   * counter keeps the limitation measurable instead of silently dropping work.
   */
  noteUnscoped(step: string): void { this.unscoped.set(step, (this.unscoped.get(step) ?? 0) + 1) }
  unscopedSteps(): Record<string, number> { return Object.fromEntries(this.unscoped) }
  /**
   * Parent resolution: a worker's call joins its attempt's claim span (a
   * cross-hop link from the orchestrator's dispatch), a verdict joins the
   * reviewed source's submission span (cross-hop from worker to reviewer), a
   * claim joins the task's proposal, and the first span of a mission is root.
   */
  parentFor(context: { step: TraceStep; missionId: string; taskId?: string; attemptId?: string; reviewOfTaskId?: string }): string | undefined {
    const index = this.index(context.missionId)
    const latest = (spans: TraceSpan[] | undefined, predicate: (span: TraceSpan) => boolean = () => true): TraceSpan | undefined => {
      if (!spans) return undefined
      for (let position = spans.length - 1; position >= 0; position--) { const span = spans[position]!; if (predicate(span)) return span }
      return undefined
    }
    if (context.step === 'swarm_verify' && context.reviewOfTaskId) {
      const reviewed = index.byTask.get(context.reviewOfTaskId)
      return (latest(reviewed, span => span.step === 'swarm_submit') ?? latest(reviewed))?.spanId ?? index.all.at(-1)?.spanId
    }
    if (context.step !== 'swarm_claim' && context.attemptId) {
      const attempt = index.byAttempt.get(context.attemptId)
      const parent = latest(attempt, span => span.step === 'swarm_claim') ?? latest(attempt)
      if (parent) return parent.spanId
    }
    if (context.taskId) {
      const parent = latest(index.byTask.get(context.taskId))
      if (parent) return parent.spanId
    }
    return index.all.at(-1)?.spanId
  }
  /** Record one span row durably; the row is validated before it can enter the log. */
  async record(context: { missionId: string; actor: string; step: TraceStep; taskId?: string; attemptId?: string; reviewOfTaskId?: string; input: unknown; output: unknown; status: TraceStatus; errorType?: TraceErrorType; startedAt: number; endedAt?: number }): Promise<TraceSpan> {
    const spanId = randomUUID().replaceAll('-', '').slice(0, 16)
    const traceId = traceIdFor(context.missionId)
    const input = await this.payloads.put(context.input)
    const output = await this.payloads.put(context.output)
    const parentSpanId = this.parentFor(context)
    const span: TraceSpan = {
      traceId, spanId, ...(parentSpanId === undefined ? {} : { parentSpanId }), missionId: context.missionId,
      ...(context.taskId === undefined ? {} : { taskId: context.taskId }), ...(context.attemptId === undefined ? {} : { attemptId: context.attemptId }),
      operation: spanOperation(context.step), step: context.step, status: context.status,
      ...(context.status === 'error' ? { errorType: context.errorType ?? 'tool_error' } : {}),
      startedAt: context.startedAt, endedAt: context.endedAt ?? Date.now(),
      traceparent: traceparentFor(traceId, spanId), actor: context.actor, input, output,
    }
    const reason = spanContractViolation(span)
    if (reason) throw new TraceContractError(`Refusing to record a span that violates the D6 contract: ${reason}`, undefined, context.step)
    this.store.transaction(() => this.store.event(context.missionId, 'trace/span', context.actor, span))
    this.remember(this.index(context.missionId), span)
    return span
  }
}

/** First contract violation in a span row, or undefined when it satisfies the D6 vocabulary. */
export function spanContractViolation(span: unknown): string | undefined {
  if (span === null || typeof span !== 'object' || Array.isArray(span)) return 'span is not an object'
  const row = span as Partial<TraceSpan>
  if (typeof row.traceId !== 'string' || !TRACE_ID.test(row.traceId)) return 'trace_id must be 32 lowercase hex characters'
  if (typeof row.spanId !== 'string' || !SPAN_ID.test(row.spanId)) return 'span_id must be 16 lowercase hex characters'
  if (row.parentSpanId !== undefined && (typeof row.parentSpanId !== 'string' || !SPAN_ID.test(row.parentSpanId))) return 'parent_span_id must be null or 16 lowercase hex characters'
  if (row.parentSpanId === row.spanId) return 'parent_span_id must differ from span_id'
  if (typeof row.missionId !== 'string' || !row.missionId) return 'mission_id is required'
  if (!isTraceOperation(row.operation)) return `operation must be one of ${TRACE_OPERATIONS.join('|')}`
  if (!isTraceStep(row.step)) return `step must be one of ${TRACE_STEPS.join('|')}`
  if (!isTraceStatus(row.status)) return 'status must be ok|error'
  if (row.status === 'error' && !isTraceErrorType(row.errorType)) return `error.type must be one of ${TRACE_ERROR_TYPES.join('|')} when status is error`
  if (row.status === 'ok' && row.errorType !== undefined) return 'error.type must be absent when status is ok'
  if (!Number.isSafeInteger(row.startedAt) || !Number.isSafeInteger(row.endedAt) || Number(row.endedAt) < Number(row.startedAt)) return 'startedAt/endedAt must be ordered safe integers'
  if (typeof row.actor !== 'string' || !row.actor) return 'actor is required'
  if (row.traceparent !== traceparentFor(String(row.traceId), String(row.spanId))) return 'traceparent must be 00-<trace-id>-<span-id>-01 for this span'
  for (const key of ['input', 'output'] as const) {
    const ref = row[key]
    if (ref === null || typeof ref !== 'object' || typeof ref.digest !== 'string' || !DIGEST.test(ref.digest) || !Number.isSafeInteger(ref.bytes) || Number(ref.bytes) < 0 || typeof ref.stored !== 'boolean') return `${key} must be a digest reference`
  }
  return undefined
}

export interface TraceViolation { seq?: number; spanId?: string; step?: string; reason: string }
export interface TraceMetrics {
  spans: number
  roots: number
  contractCompliance: number
  causalClosure: number
  orphanParents: number
  violations: TraceViolation[]
  firstViolatingStep?: TraceViolation
  operations: Record<string, number>
  payloads: { referenced: number; stored: number; omitted: number; verified: number; missing: number; mismatched: number }
}
/** Contract compliance, causal closure and first-violating-step over a span window (F-44). */
export async function traceMetrics(spans: readonly TraceSpan[], options: { payloads?: TracePayloadStore; seqOf?: (span: TraceSpan, index: number) => number | undefined } = {}): Promise<TraceMetrics> {
  const violations: TraceViolation[] = []
  const operations: Record<string, number> = {}
  const payloads = { referenced: 0, stored: 0, omitted: 0, verified: 0, missing: 0, mismatched: 0 }
  const known = new Set(spans.map(span => span?.spanId))
  let roots = 0, orphans = 0
  const refs: TracePayloadRef[] = []
  spans.forEach((span, index) => {
    const reason = spanContractViolation(span)
    if (reason) violations.push({ seq: options.seqOf?.(span, index), spanId: span?.spanId, step: span?.step, reason })
    else {
      operations[span.operation] = (operations[span.operation] ?? 0) + 1
      if (span.parentSpanId === undefined) roots++
      else if (!known.has(span.parentSpanId)) { orphans++; violations.push({ seq: options.seqOf?.(span, index), spanId: span.spanId, step: span.step, reason: `causal closure broken: parent ${span.parentSpanId} is not in this window` }) }
    }
    for (const key of ['input', 'output'] as const) {
      const ref = span?.[key]
      if (ref === null || typeof ref !== 'object') continue
      payloads.referenced++
      if (ref.stored) { payloads.stored++; refs.push(ref) } else payloads.omitted++
    }
  })
  if (options.payloads) for (const ref of refs) { if (await options.payloads.verify(ref)) payloads.verified++; else { payloads.missing++; payloads.mismatched++ } }
  const total = spans.length
  const first = violations.find(violation => violation.seq !== undefined) ?? violations[0]
  return {
    spans: total, roots, contractCompliance: total === 0 ? 1 : (total - violations.length) / total,
    causalClosure: total === 0 ? 1 : (total - orphans) / total, orphanParents: orphans, violations,
    ...(first === undefined ? {} : { firstViolatingStep: first }), operations, payloads,
  }
}

/**
 * Event vocabulary the read path recognizes. Every type the round-2 review found
 * unsurfaced (F-14) is named here, together with the verdict and retired-review
 * events (F-12) and the trace rows themselves.
 */
export const EVENT_VOCABULARY: Record<string, string> = {
  'mission/created': 'Mission admitted with its frozen scope and budget',
  'mission/recovered': 'Host restarted and recovered the mission from durable state',
  'mission/budget-updated': 'Owner changed the resource ceilings without resetting usage',
  'mission/stalled': 'No schedulable work remains and every live worker is idle',
  'mission/paused': 'Owner paused the mission',
  'mission/resumed': 'Owner resumed the mission',
  'mission/stopped': 'Owner stopped the mission; evidence and artifacts are preserved',
  'mission/completed': 'Owner completed the mission',
  'automatic/completed': 'Runtime completed an automatic mission after independent acceptance',
  'workspace/snapshot': 'Member workspace baseline snapshot recorded',
  'member/added': 'Worker admitted with its isolated worktree',
  'member/failed': 'Worker could not be created',
  'member/resume-failed': 'Worker could not resume after restart',
  'member/stopped': 'Worker handle stopped',
  'member/activity': 'Worker activity heartbeat for lease liveness',
  'workstream/created': 'Workstream admitted',
  'task/proposed': 'Task admitted under a workstream',
  'task/claimed': 'Attempt dispatched: ownership, attempt id and lease recorded',
  'task/submitted': 'Artifact captured and submitted for independent review',
  'task/accepted': 'Independent verification accepted the source artifact',
  'task/rejected': 'Independent verification rejected the source artifact',
  'task/blocked': 'Task blocked with the reason that must be repaired',
  'task/cancelled': 'Owner withdrew admitted work; dependents named as stranded',
  'task/cancelled-at-completion': 'Unschedulable leftover cancelled at mission completion',
  'task/lease-expired': 'Attempt lease expired and the owner was released',
  'task/ceiling-exhausted': 'Task exhausted its own step or finding ceiling and blocked without charging the mission budget',
  'task/checkpointed': 'Workspace checkpoint captured before reassignment',
  'task/checkpoint-failed': 'Checkpoint capture failed; workspace preserved, recovery refuses a dirty tree',
  'task/closeout-nudged': 'Idle worker nudged to finish its open attempt',
  'task/closeout-abandoned': 'Idle close-out exhausted: checkpoint captured and the task re-pended',
  'task/closeout-failed': 'Idle close-out could not capture a checkpoint',
  'task/handoff-started': 'Ownership revoked; reassignment waits for the previous worker to stop',
  'task/handoff-ready': 'Previous worker stopped and the handed-off task is schedulable again',
  'task/review-retired': 'Sibling review retired because its source can never reach a verdict',
  'task/invalidated': 'Dependent work invalidated by a challenged prerequisite',
  'task/git-write-denied': 'Sandbox refused a worker git write; the supported exit is named',
  'task/budget-resume-skipped': 'Budget-resume marker was stale and skipped',
  'task/quiescence-recovered': 'Parked task recovered after host restart',
  'evidence/published': 'Unverified claim published with host-recorded run ids',
  'evidence/challenged': 'Claim challenged with counterevidence',
  'evidence/verified': 'Verdict verified the claim and names the retired reviews',
  'evidence/refuted': 'Verdict refuted the claim and names the retired reviews',
  'evidence/verdict': 'Normalized verdict row: evidence id, verdict and retired reviews',
  'trace/span': 'One orchestration step span with digests of its input and output',
  'message/queued': 'Directed message or topic broadcast queued durably',
  // Every remaining type the runtime emits (F-14). The read path must name them
  // so an operator can reconstruct a decision instead of seeing an unknown row.
  'automatic/requested': 'Automatic planning request admitted with its goal and workspace',
  'automatic/failed': 'Automatic planning or launch failed with the recorded reason',
  'member/failure': 'Worker operation failed with the recorded error',
  'member/subscribed': 'Worker topic subscriptions replaced',
  'member/waiting': 'Worker parked itself until fresh peer input arrives',
  'mission/budget-exhausted': 'Aggregate budget exhausted; mission paused pending quiescence and a raise',
  'mission/budget-quiesced': 'Every worker stopped after budget exhaustion; attempts preserved for resume',
  'mission/budget-warning': 'Approaching-limit threshold crossed for one budget dimension',
  'plan/edited': 'Saved draft plan edited with a new revision',
  'plan/launched': 'Saved draft plan activated as an active mission',
  'plan/staged': 'Draft plan staged without creating workers or worktrees',
  'task/budget-resumed': 'Preserved attempt resumed after the budget raise',
  'task/lease-expiring': 'Attempt lease is approaching expiry with no live operation',
  'tool/recorded': 'Host tool run recorded for evidence and audit',
}
export interface EventVocabularyReport {
  recognized: string[]
  unrecognized: string[]
  types: Array<{ type: string; count: number; description?: string }>
}
export function eventVocabularyReport(events: readonly SwarmEvent[]): EventVocabularyReport {
  const counts = new Map<string, number>()
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1)
  const types = [...counts.entries()].map(([type, count]) => ({ type, count, ...(EVENT_VOCABULARY[type] === undefined ? {} : { description: EVENT_VOCABULARY[type] }) }))
  return {
    recognized: types.filter(item => item.description !== undefined).map(item => item.type),
    unrecognized: types.filter(item => item.description === undefined).map(item => item.type),
    types,
  }
}
export const eventSummary = (event: SwarmEvent, limit = 240): string => {
  const raw = typeof event.data === 'string' ? event.data : JSON.stringify(event.data) ?? ''
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}… [${raw.length - limit} more chars]`
}

export interface EventHistory {
  events: SwarmEvent[]
  total: number
  pageSize: number
  firstSeq?: number
  lastSeq?: number
  nextBefore?: number
  hasOlder: boolean
  truncated: boolean
}
/**
 * Older-event read path (F-13): the store's cursor is forward-only and `after=0`
 * is the newest page, so history is served from the bounded retained window
 * with a `before` cursor that walks backwards.
 */
export function readEventHistory(store: TraceStore, missionId: string, options: { before?: number; limit?: number } = {}): EventHistory {
  const limit = Math.min(HISTORY_PAGE_MAX, Math.max(1, Math.trunc(options.limit ?? HISTORY_PAGE_DEFAULT)))
  const before = options.before
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) throw new Error('before must be a nonnegative integer')
  const all = store.events(missionId, HISTORY_SCAN_LIMIT, 0)
  const window = before === undefined ? all : all.filter(event => event.seq < before)
  const events = window.slice(-limit)
  const hasOlder = window.length > events.length
  return {
    events, total: all.length, pageSize: limit,
    ...(events.length ? { firstSeq: events[0]!.seq, lastSeq: events.at(-1)!.seq } : {}),
    ...(hasOlder && events.length ? { nextBefore: events[0]!.seq } : {}),
    hasOlder, truncated: all.length >= HISTORY_SCAN_LIMIT,
  }
}

/** Raw `events` table row, as stored by SQLite; the replay gate decodes these directly. */
export interface ReplayEventRow { seq: number; mission_id: string; type: string; actor: string; data: string; created_at: number }
export function decodeEventRow(row: ReplayEventRow): SwarmEvent {
  if (!Number.isSafeInteger(row.seq) || row.seq < 1) throw new ReplayCorruptionError(`event row has an invalid seq: ${String(row.seq)}`, row.seq)
  if (typeof row.mission_id !== 'string' || !row.mission_id) throw new ReplayCorruptionError('event row has no mission id', row.seq)
  if (typeof row.type !== 'string' || !row.type) throw new ReplayCorruptionError(`event ${row.seq} has no type`, row.seq)
  if (typeof row.actor !== 'string') throw new ReplayCorruptionError(`event ${row.seq} has no actor`, row.seq)
  if (!Number.isSafeInteger(row.created_at)) throw new ReplayCorruptionError(`event ${row.seq} has no created_at`, row.seq)
  if (typeof row.data !== 'string') throw new ReplayCorruptionError(`event ${row.seq} data is not stored text`, row.seq)
  let data: unknown
  try { data = JSON.parse(row.data) } catch { throw new ReplayCorruptionError(`event ${row.seq} data is not valid JSON`, row.seq) }
  return { seq: row.seq, missionId: row.mission_id, type: row.type, actor: row.actor, data, createdAt: row.created_at }
}
/** Decode and validate a durable log: ordered seqs, one mission, decodable rows. */
export function decodeDurableLog(rows: readonly ReplayEventRow[]): SwarmEvent[] {
  const events: SwarmEvent[] = []
  let missionId: string | undefined
  let previous = 0
  for (const row of rows) {
    const event = decodeEventRow(row)
    if (event.seq <= previous) throw new ReplayCorruptionError(`durable log is not ordered: seq ${event.seq} follows ${previous}`, event.seq)
    previous = event.seq
    if (missionId === undefined) missionId = event.missionId
    else if (event.missionId !== missionId) throw new ReplayCorruptionError(`durable log mixes missions ${missionId} and ${event.missionId}`, event.seq)
    events.push(event)
  }
  return events
}

export type ReplayCommandKind = 'dispatch' | 'verify' | 'stop' | 'checkpoint'
export interface ReplayCommand {
  kind: ReplayCommandKind
  seq: number
  taskId?: string
  memberId?: string
  attemptId?: string
  sourceTaskId?: string
  verdict?: 'accepted' | 'rejected'
  commit?: string
}
/** Stable comparison key; only fields both the durable log and the adapter can know. */
export function commandKey(command: ReplayCommand): string {
  switch (command.kind) {
    case 'dispatch': return `dispatch:${command.taskId}:${command.memberId}`
    case 'verify': return `verify:${command.sourceTaskId}`
    case 'stop': return `stop:${command.memberId}`
    case 'checkpoint': return `checkpoint:${command.taskId}:${command.commit}`
  }
}
export const replayDigest = (keys: readonly string[]): string => digestText(keys.join('\n'))

/**
 * Stable labels for replay comparison: task and member ids are random per run,
 * so the sequence is keyed by admission order instead. A golden sequence is
 * therefore byte-identical across runs while still naming every decision.
 */
export interface ReplayLabels { task: (id: string) => string; member: (id: string) => string }
export function replayLabels(events: readonly SwarmEvent[]): ReplayLabels {
  const tasks = new Map<string, string>(), members = new Map<string, string>()
  for (const event of events) {
    const data = event.data as { id?: unknown } | undefined
    const id = data !== null && typeof data === 'object' && typeof data.id === 'string' ? data.id : undefined
    if (id === undefined) continue
    if (event.type === 'task/proposed' && !tasks.has(id)) tasks.set(id, `task#${tasks.size + 1}`)
    if (event.type === 'member/added' && !members.has(id)) members.set(id, `member#${members.size + 1}`)
  }
  return { task: id => tasks.get(id) ?? `task#?${id.slice(-4)}`, member: id => members.get(id) ?? `member#?${id.slice(-4)}` }
}
export function stableCommandKey(command: ReplayCommand, labels: ReplayLabels): string {
  const task = (id: string | undefined): string => (id === undefined ? '?' : labels.task(id))
  const member = (id: string | undefined): string => (id === undefined ? '?' : labels.member(id))
  switch (command.kind) {
    case 'dispatch': return `dispatch:${task(command.taskId)}:${member(command.memberId)}`
    case 'verify': return `verify:${task(command.sourceTaskId)}`
    case 'stop': return `stop:${member(command.memberId)}`
    case 'checkpoint': return `checkpoint:${task(command.taskId)}`
  }
}

const asObject = (value: unknown, seq: number, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ReplayCorruptionError(`${label} at seq ${seq} is not an object`, seq)
  return value as Record<string, unknown>
}
const required = (data: Record<string, unknown>, key: string, seq: number): string => {
  const value = data[key]
  if (typeof value !== 'string' || !value) throw new ReplayCorruptionError(`event ${seq} is missing ${key}`, seq)
  return value
}
/** Events that close a dispatched attempt; anything else leaves the attempt unresolved. */
const ATTEMPT_CLOSERS = new Set(['task/submitted', 'task/blocked', 'task/cancelled', 'task/cancelled-at-completion', 'task/lease-expired', 'task/handoff-started', 'task/invalidated', 'task/review-retired', 'task/closeout-abandoned', 'task/closeout-failed', 'task/accepted', 'task/rejected'])
export interface ReplayResult {
  commands: ReplayCommand[]
  keys: string[]
  digest: string
  unresolved: string[]
  eventCount: number
}
/**
 * Replay the orchestrator's externally visible decision sequence from the
 * durable event log. Pure: no provider call, no filesystem access, no clock.
 * Corruption and truncation are named failures; a structurally valid log that
 * yields a different sequence is a divergence detected by the caller.
 */
export function orchestratorCommands(events: readonly SwarmEvent[]): ReplayResult {
  const commands: ReplayCommand[] = []
  const open = new Map<string, { taskId: string; memberId: string }>()
  let previous = 0
  for (const event of events) {
    if (!Number.isSafeInteger(event.seq) || event.seq <= previous) throw new ReplayCorruptionError(`durable log is not ordered at seq ${String(event.seq)}`, event.seq)
    previous = event.seq
    if (typeof event.type !== 'string' || !event.type) throw new ReplayCorruptionError(`event ${event.seq} has no type`, event.seq)
    if (event.type === 'trace/span') {
      const reason = spanContractViolation(event.data)
      if (reason) throw new TraceContractError(`trace span at seq ${event.seq} violates the D6 contract: ${reason}`, event.seq, (event.data as Partial<TraceSpan>).step)
      continue
    }
    if (event.type !== 'task/claimed' && !ATTEMPT_CLOSERS.has(event.type)) continue
    const data = asObject(event.data, event.seq, event.type)
    if (event.type === 'task/claimed') {
      const taskId = required(data, 'taskId', event.seq)
      const attempt = asObject(data.attempt, event.seq, 'task/claimed attempt')
      const attemptId = required(attempt, 'id', event.seq)
      const memberId = required(attempt, 'ownerId', event.seq)
      commands.push({ kind: 'dispatch', seq: event.seq, taskId, memberId, attemptId })
      open.set(attemptId, { taskId, memberId })
      continue
    }
    const closesTask = typeof data.taskId === 'string' && data.taskId ? data.taskId : undefined
    const closesSource = typeof data.sourceTaskId === 'string' && data.sourceTaskId ? data.sourceTaskId : undefined
    const closesVerification = typeof data.verificationTaskId === 'string' && data.verificationTaskId ? data.verificationTaskId : undefined
    if (event.type === 'task/accepted' || event.type === 'task/rejected') {
      commands.push({ kind: 'verify', seq: event.seq, sourceTaskId: required(data, 'sourceTaskId', event.seq), verdict: event.type === 'task/accepted' ? 'accepted' : 'rejected' })
    }
    if (event.type === 'task/lease-expired') commands.push({ kind: 'stop', seq: event.seq, memberId: required(data, 'oldOwner', event.seq) })
    if (event.type === 'task/review-retired' && typeof data.ownerId === 'string' && data.ownerId) commands.push({ kind: 'stop', seq: event.seq, memberId: data.ownerId })
    if (event.type === 'task/checkpointed') commands.push({ kind: 'checkpoint', seq: event.seq, taskId: required(data, 'taskId', event.seq), commit: typeof data.commit === 'string' ? data.commit : '' })
    for (const [attemptId, record] of [...open]) {
      if (record.taskId === closesTask || record.taskId === closesSource || record.taskId === closesVerification) open.delete(attemptId)
    }
  }
  const unresolved = [...open.entries()].map(([attemptId, record]) => `${record.taskId}#${attemptId}`)
  if (unresolved.length) throw new ReplayTruncationError(`durable log is truncated: ${unresolved.length} dispatched attempt(s) never reached a closing event: ${unresolved.join(', ')}`, unresolved)
  // Keys use admission-order labels, so the digest is byte-identical across
  // runs even though task and member ids are random.
  const labels = replayLabels(events)
  const keys = commands.map(command => stableCommandKey(command, labels))
  return { commands, keys, digest: replayDigest(keys), unresolved, eventCount: events.length }
}
/** Compare a replayed sequence to the recorded/golden sequence; name the first divergence. */
export function assertReplayParity(expected: readonly string[], actual: readonly string[], context: string): void {
  const length = Math.max(expected.length, actual.length)
  for (let index = 0; index < length; index++) {
    if (expected[index] === actual[index]) continue
    throw new ReplayDivergenceError(`Replay diverged from ${context} at command ${index}: expected ${expected[index] ?? '<end of sequence>'}, replayed ${actual[index] ?? '<end of sequence>'}`, index, expected[index], actual[index])
  }
}

/** Verdict normalization for the client contract: `{ evidenceId, verdict, retired }`. */
export interface VerdictRow { evidenceId: string; verdict: 'verified' | 'refuted'; outcome: string; taskId: string; verificationTaskId: string; retired: string[]; reason: string }
export function verdictRows(input: {
  sourceTaskId: string
  verificationTaskId: string
  verdict: 'verified' | 'refuted'
  reason: string
  evidence: ReadonlyArray<{ id: string; outcome: string }>
  retired: readonly string[]
}): VerdictRow[] {
  return input.evidence.map(item => ({ evidenceId: item.id, verdict: input.verdict, outcome: item.outcome, taskId: input.sourceTaskId, verificationTaskId: input.verificationTaskId, retired: [...input.retired], reason: input.reason }))
}
