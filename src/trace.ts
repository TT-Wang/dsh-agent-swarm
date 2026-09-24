/**
 * D6 trace contracts: a closed span vocabulary, digest-addressed payloads that
 * never enter the durable event log, causal closure across worker hops, an
 * executable replay gate over the durable log, event surfacing for the read
 * path and trace-level metrics (contract compliance, first violating step).
 *
 * Design boundaries:
 * - `src/store.ts` and `src/types.ts` are owned by other tasks and are not
 *   modified. Spans are therefore appended through the existing
 *   `SwarmStore.event`/`transaction` API as `trace/span` events; a span carries
 *   only the digest and byte count of its input and output, so the log stays
 *   bounded by construction and the bytes are never copied anywhere.
 * - The replay gate reads the durable event log (SQLite rows) and replays the
 *   orchestrator's externally visible command sequence with no provider call.
 *   It fails with a named error on a corrupted or truncated log and on a
 *   command sequence that diverges from the recorded/golden sequence.
 * - R17-G10 (host-contract adoption): recorded spans are handed to the host
 *   telemetry sink (`ctx.sessionTelemetry`, the `session-telemetry` contract)
 *   when the deployment mounts a backend. The durable `trace/span` row stays
 *   because replay, the trace tests and the reader census read it and the sink
 *   has no read-back; the retained bespoke pieces and the reason that decided
 *   each are named at their definitions below.
 * - The payload bytes themselves are not retained: a span keeps only the digest
 *   and size of its input and output. Spans are recorded for the swarm_* tools,
 *   which the worker adapter deliberately does not record as `ToolRun` rows, and
 *   the digested input of a workspace-bound call carries host-added fields no
 *   session log holds, so a span digest cannot be resolved back to its payload.
 *   It identifies a step and orders the causal chain; it is not an audit copy.
 *   Builds before round 20 kept the bytes in a `trace-payloads` directory beside
 *   the state file; `forRuntime` removes that directory once, since nothing
 *   reads it and the retention sweep that bounded it is gone.
 */
import { createHash, randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { taskGraphDefects, type TaskGraphDefect, type TaskGraphNode } from './admission.ts'
import { EVENT_VOCABULARY, type EventKind } from './events.ts'
import { ATTEMPT_FENCING_EVENTS, type SwarmEvent } from './types.ts'
import { PolicyError } from './policy-error.ts'

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
export const TRACE_STEPS = ['swarm_stage', 'swarm_launch', 'swarm_budget', 'swarm_create', 'swarm_add_member', 'swarm_workstream', 'swarm_propose', 'swarm_claim', 'swarm_publish', 'swarm_submit', 'swarm_verify', 'swarm_message', 'swarm_challenge', 'swarm_handoff', 'swarm_subscribe', 'swarm_wait', 'swarm_observe', 'swarm_control', 'swarm_cancel', 'swarm_registry', 'swarm_escalate', 'swarm_post', 'swarm_board', 'swarm_restore', 'delivery-apply'] as const
export type TraceStep = (typeof TRACE_STEPS)[number]
const OPERATION_BY_STEP: Record<TraceStep, TraceOperation> = {
  swarm_stage: 'agent', swarm_launch: 'agent', swarm_budget: 'agent', swarm_create: 'agent', swarm_add_member: 'agent', swarm_workstream: 'agent',
  swarm_propose: 'tool', swarm_claim: 'agent', swarm_publish: 'tool', swarm_submit: 'tool', swarm_verify: 'review', swarm_message: 'tool',
  swarm_challenge: 'tool', swarm_handoff: 'agent', swarm_subscribe: 'tool', swarm_wait: 'tool', swarm_observe: 'tool', swarm_control: 'agent',
  swarm_cancel: 'agent', swarm_registry: 'tool', swarm_post: 'tool', swarm_board: 'tool', swarm_escalate: 'tool', swarm_restore: 'agent', 'delivery-apply': 'merge',
}
export const spanOperation = (step: TraceStep): TraceOperation => OPERATION_BY_STEP[step]
export const isTraceOperation = (value: unknown): value is TraceOperation => typeof value === 'string' && (TRACE_OPERATIONS as readonly string[]).includes(value)
export const isTraceStep = (value: unknown): value is TraceStep => typeof value === 'string' && (TRACE_STEPS as readonly string[]).includes(value)
export const isTraceStatus = (value: unknown): value is TraceStatus => value === 'ok' || value === 'error'
export const isTraceErrorType = (value: unknown): value is TraceErrorType => typeof value === 'string' && (TRACE_ERROR_TYPES as readonly string[]).includes(value)
/** Map a thrown orchestration failure onto the closed `error.type` vocabulary. */
export function errorTypeFor(error: unknown): TraceErrorType {
  if (error instanceof PolicyError) return error.category
  const message = error instanceof Error ? error.message : String(error)
  if (/not a participant|unauthorized|Only the mission owner|Only a member|Only the primary user|Workers cannot|authenticated|bypass mission authority|owner session|workspace_not_authorized/i.test(message)) return 'authorization_error'
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
/**
 * DEAD: the replayed task graph is illegal (an unknown edge, a self edge, a
 * duplicated identity or a cycle). The same validator runs at admission
 * (`reconcileTaskAdmission`, src/admission.ts), so an illegal graph cannot exist
 * in the durable log at all; a log that carries one is refused here instead of
 * being replayed into a sequence of commands that never really happened.
 */
export class ReplayGraphError extends Error {
  constructor(message: string, readonly defects: readonly TaskGraphDefect[]) { super(message); this.name = 'ReplayGraphError' }
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
/** W3C trace context id: deterministic from the mission, so worker hops join one trace. */
export const traceIdFor = (missionId: string): string => createHash('sha256').update(missionId, 'utf8').digest('hex').slice(0, 32)
export const traceparentFor = (traceId: string, spanId: string): string => `00-${traceId}-${spanId}-01`

/**
 * The durable reference a span carries for its input and its output.
 *
 * `stored` says whether the bytes are held anywhere this layer can read back.
 * Nothing spills them any more, so every reference this process writes is
 * `stored: false`; the flag stays because rows written by older builds carry
 * `stored: true` and `spanContractViolation` still validates both.
 */
export interface TracePayloadRef { digest: string; bytes: number; stored: boolean }
/** Digest and size one span payload, without retaining the bytes. */
export function payloadRef(value: unknown): TracePayloadRef {
  const text = canonicalJson(value)
  return { digest: digestText(text), bytes: Buffer.byteLength(text, 'utf8'), stored: false }
}

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

/** Structural slice of `SwarmStore` the trace layer needs; keeps store.ts untouched. */
export interface TraceStore {
  events(missionId: string, limit: number, after?: number): SwarmEvent[]
  /** Newest matching spans in chronological order; optional for older store adapters. */
  traceEvents?(missionId: string, limit: number, filter?: { taskId?: string; attemptId?: string; step?: string }): SwarmEvent[]
  event(missionId: string, type: string, actor: string, data: unknown): void
  transaction<T>(operation: () => T): T
}

/**
 * R17-G10: the host telemetry sink (`session-telemetry`), declared structurally.
 *
 * The host package `@deepseek-ai/dsh-session-telemetry` (the same contract on
 * 0.1.5-rc.3 and 0.1.7-rc.1) defines `SessionTelemetryRecord` and
 * `SessionTelemetrySink` and registers the sink as the `sessionTelemetry`
 * service; the record shape below is that contract verbatim
 * (`channel`/`time`/`severity`/`attributes`/`body`, with `emit` a non-blocking
 * enqueue). It is declared here instead of imported so this package keeps no
 * runtime or build dependency on a host package it does not declare
 * (package.json is outside this branch's scope, and the deployed plugin
 * installs only its declared peers); the binding is made through the cordis
 * service registry in `src/index.ts`, which is how the host expects an optional
 * integration to be discovered.
 *
 * What the host contract does NOT cover, and why the durable row stays: the
 * sink is fire-and-forget with no read-back, so it cannot be the durable home of
 * a span. `scripts/replay/replay.mjs` re-derives the decision sequence from the
 * persisted `trace/span` rows, `tests/trace-*.test.mjs` assert their contract,
 * and `tests/reader-census.test.mjs` records `trace/span` as a kept kind read by
 * `src/tools.ts`. Dropping the row would delete an observable contract, which
 * the acceptance forbids; the sink is therefore the reporting transport and the
 * log row remains the record. The host's own capture coordinator also cannot
 * help here: it mirrors host session events, and a swarm span is a plugin event
 * in the swarm store.
 */
export interface HostTelemetryRecord {
  channel: 'ledger' | 'ops'
  time: number
  severity: 'info' | 'warn' | 'error'
  attributes: Record<string, string | number>
  body: unknown
}
/** The minimum the host sink contract requires of a reporting backend. */
export interface HostTelemetrySink {
  emit(record: HostTelemetryRecord): void
  flush?(): void
  shutdown?(): Promise<void>
}
/**
 * Map one durable span onto the host sink's ops record. `channel: 'ops'` is the
 * host's channel for a signal with no session-log home (a swarm span is not a
 * host session event, so it can never be a `ledger` row); the body is the
 * complete span row, so nothing observable is lost in transport.
 */
export function hostTelemetryRecord(span: TraceSpan): HostTelemetryRecord {
  return {
    channel: 'ops',
    time: span.endedAt,
    severity: span.status === 'error' ? 'error' : 'info',
    attributes: {
      'telemetry.op': 'swarm.span',
      'mission.id': span.missionId,
      'trace.id': span.traceId,
      'span.id': span.spanId,
      ...(span.parentSpanId === undefined ? {} : { 'parent.span.id': span.parentSpanId }),
      ...(span.taskId === undefined ? {} : { 'task.id': span.taskId }),
      ...(span.attemptId === undefined ? {} : { 'attempt.id': span.attemptId }),
      step: span.step, operation: span.operation, status: span.status,
      ...(span.errorType === undefined ? {} : { 'error.type': span.errorType }),
    },
    body: span,
  }
}
/**
 * One runtime's binding to the host sink. The service may be mounted before or
 * after this plugin (`ctx.inject` fires whenever it appears), so recorded spans
 * read a mutable link instead of a value captured at construction. Emission is
 * contained exactly as the host contains a backend failure: a throwing sink is
 * counted and never allowed to cost the durable row.
 */
export class HostTelemetryLink {
  private sink?: HostTelemetrySink
  private emitted = 0
  private failed = 0
  attach(sink: HostTelemetrySink | undefined): void { this.sink = sink }
  detach(): void { this.sink = undefined }
  bound(): boolean { return this.sink !== undefined }
  /** Hand one span to the host sink; returns whether a record was enqueued. */
  emit(span: TraceSpan): boolean {
    if (this.sink === undefined) return false
    try { this.sink.emit(hostTelemetryRecord(span)); this.emitted++; return true }
    catch { this.failed++; return false }
  }
  /** Records enqueued and sink failures contained, for the round's instrument. */
  counts(): { emitted: number; failed: number } { return { emitted: this.emitted, failed: this.failed } }
}
const hostTelemetryLinks = new WeakMap<object, HostTelemetryLink>()
/**
 * The telemetry link belongs to the runtime object, not to the recorder: the
 * recorder is built by `src/tools.ts` (outside this change's scope) while the
 * cordis context that owns the sink is only available in `src/index.ts`, so the
 * two meet on the runtime identity they already share. Binding first or
 * attaching later both yield one shared link.
 */
export function bindHostTelemetry(runtime: object): HostTelemetryLink {
  const existing = hostTelemetryLinks.get(runtime)
  if (existing !== undefined) return existing
  const link = new HostTelemetryLink()
  hostTelemetryLinks.set(runtime, link)
  return link
}
const hostTelemetryFor = (runtime: unknown): HostTelemetryLink | undefined =>
  runtime !== null && typeof runtime === 'object' ? hostTelemetryLinks.get(runtime) : undefined

const SEED_LIMIT = 20000
const HISTORY_SCAN_LIMIT = 100000
const HISTORY_PAGE_DEFAULT = 50
const HISTORY_PAGE_MAX = 500

export interface TraceWindow {
  limit: number
  spans: number
  truncated: boolean
  source: 'trace-spans' | 'events'
  firstSpanId?: string
  lastSpanId?: string
}
interface SpanIndex {
  truncated: boolean
  source: TraceWindow['source']
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
  /**
   * The best-effort removal of the payload directory earlier builds kept beside
   * the state file. Exposed so a caller can await it; a failure is swallowed,
   * because a leftover directory is inert and must never block plugin start.
   */
  legacyCleanup?: Promise<void>
  constructor(readonly store: TraceStore, readonly telemetry?: HostTelemetryLink) {}
  /** A recorder exists only when the runtime owns a durable store and state path. */
  static forRuntime(runtime: unknown): TraceRecorder | undefined {
    const candidate = runtime as { config?: { statePath?: unknown } & Record<string, unknown>; store?: Partial<TraceStore> } | undefined
    const statePath = candidate?.config?.statePath
    const store = candidate?.store
    if (typeof statePath !== 'string' || !statePath) return undefined
    if (!store || typeof store.event !== 'function' || typeof store.transaction !== 'function' || typeof store.events !== 'function') return undefined
    const recorder = new TraceRecorder(store as TraceStore, hostTelemetryFor(runtime))
    recorder.legacyCleanup = rm(join(dirname(statePath), 'trace-payloads'), { recursive: true, force: true }).catch(() => undefined)
    return recorder
  }
  private index(missionId: string): SpanIndex {
    const existing = this.indexes.get(missionId)
    if (existing) return existing
    const source = this.store.traceEvents ? 'trace-spans' : 'events'
    const events = this.store.traceEvents?.(missionId, SEED_LIMIT + 1) ?? this.store.events(missionId, SEED_LIMIT + 1, 0)
    const index: SpanIndex = { byTask: new Map(), byAttempt: new Map(), all: [], source, truncated: events.length > SEED_LIMIT }
    for (const event of events.slice(-SEED_LIMIT)) {
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
    if (index.all.length > SEED_LIMIT) {
      const expired = index.all.shift()!
      for (const [map, key] of [[index.byTask, expired.taskId], [index.byAttempt, expired.attemptId]] as const) {
        if (!key) continue
        const list = map.get(key)!
        list.shift()
        if (list.length === 0) map.delete(key)
      }
      index.truncated = true
    }
  }
  spansFor(missionId: string): TraceSpan[] { return [...this.index(missionId).all] }
  /** Metrics explicitly describe the retained window, never imply complete history. */
  windowFor(missionId: string): TraceWindow {
    const index = this.index(missionId)
    return { limit: SEED_LIMIT, spans: index.all.length, truncated: index.truncated, source: index.source,
      ...(index.all.length ? { firstSpanId: index.all[0]!.spanId, lastSpanId: index.all.at(-1)!.spanId } : {}) }
  }
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
    // Once history exceeds the cache, resolve scoped parents directly in the
    // durable span rows. Activity/tool events cannot hide a claim or submission,
    // and a missing scoped parent must not attach this task to an unrelated one.
    const stored = (filter: { taskId?: string; attemptId?: string; step?: string }): TraceSpan | undefined => {
      const event = this.store.traceEvents?.(context.missionId, 1, filter)?.at(-1)
      const span = event?.data as TraceSpan | undefined
      return span && typeof span.spanId === 'string' ? span : undefined
    }
    const lookup = (filter: { taskId?: string; attemptId?: string; step?: string }, spans: TraceSpan[] | undefined) =>
      index.truncated && this.store.traceEvents ? stored(filter)
        : latest(spans, span => filter.step === undefined || span.step === filter.step)
    if (context.step === 'swarm_verify' && context.reviewOfTaskId) {
      const taskId = context.reviewOfTaskId, reviewed = index.byTask.get(taskId)
      return (lookup({ taskId, step: 'swarm_submit' }, reviewed)
        ?? (index.truncated && !this.store.traceEvents ? undefined : lookup({ taskId }, reviewed)))?.spanId
    }
    if (context.step !== 'swarm_claim' && context.attemptId) {
      const attemptId = context.attemptId, attempt = index.byAttempt.get(attemptId)
      return (lookup({ attemptId, step: 'swarm_claim' }, attempt)
        ?? (index.truncated && !this.store.traceEvents ? undefined : lookup({ attemptId }, attempt)))?.spanId
    }
    if (context.taskId) {
      const parent = lookup({ taskId: context.taskId }, index.byTask.get(context.taskId))
      if (parent || context.step !== 'swarm_propose') return parent?.spanId
      // A new proposal joins a mission-level setup span, never another task.
      return (latest(index.all, span => !span.taskId && !span.attemptId)
        ?? stored({ step: 'swarm_launch' }) ?? stored({ step: 'swarm_create' }) ?? stored({ step: 'swarm_stage' }))?.spanId
    }
    return index.all.at(-1)?.spanId
  }
  /** Record one span row durably; the row is validated before it can enter the log. */
  async record(context: { missionId: string; actor: string; step: TraceStep; taskId?: string; attemptId?: string; reviewOfTaskId?: string; input: unknown; output: unknown; status: TraceStatus; errorType?: TraceErrorType; startedAt: number; endedAt?: number }): Promise<TraceSpan> {
    const spanId = randomUUID().replaceAll('-', '').slice(0, 16)
    const traceId = traceIdFor(context.missionId)
    const input = payloadRef(context.input)
    const output = payloadRef(context.output)
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
    // R17-G10: the durable row is written first, then the host sink is fed. The
    // sink is a reporting transport (contained, counted, never rethrowing), so a
    // backend failure can never cost the record or the mission.
    this.telemetry?.emit(span)
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
  window?: TraceWindow
  spans: number
  roots: number
  contractCompliance: number
  causalClosure: number
  orphanParents: number
  violations: TraceViolation[]
  firstViolatingStep?: TraceViolation
  operations: Record<string, number>
  /**
   * Payload references seen in this window. `stored` counts the rows an older
   * build spilled to disk; nothing writes them any more, so a window of current
   * rows reports `stored: 0` and `omitted === referenced`.
   */
  payloads: { referenced: number; stored: number; omitted: number }
}
/** Contract compliance, causal closure and first-violating-step over a span window (F-44). */
export async function traceMetrics(spans: readonly TraceSpan[], options: { seqOf?: (span: TraceSpan, index: number) => number | undefined; window?: TraceWindow } = {}): Promise<TraceMetrics> {
  const violations: TraceViolation[] = []
  const operations: Record<string, number> = {}
  const payloads: TraceMetrics['payloads'] = { referenced: 0, stored: 0, omitted: 0 }
  const known = new Set(spans.map(span => span?.spanId))
  let roots = 0, orphans = 0
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
      if (ref.stored) payloads.stored++; else payloads.omitted++
    }
  })
  const total = spans.length
  const first = violations.find(violation => violation.seq !== undefined) ?? violations[0]
  return {
    ...(options.window === undefined ? {} : { window: options.window }),
    spans: total, roots, contractCompliance: total === 0 ? 1 : (total - violations.length) / total,
    causalClosure: total === 0 ? 1 : (total - orphans) / total, orphanParents: orphans, violations,
    ...(first === undefined ? {} : { firstViolatingStep: first }), operations, payloads,
  }
}

/**
 * The read path's view of the registry in `src/events.ts`. The rows live there
 * because that module imports nothing and both tsconfigs compile it, so the
 * client renders the same registry the host writes.
 */
export { EVENT_VOCABULARY, type EventKind }
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
  const scanned = store.events(missionId, HISTORY_SCAN_LIMIT + 1, 0)
  const all = scanned.slice(-HISTORY_SCAN_LIMIT)
  const window = before === undefined ? all : all.filter(event => event.seq < before)
  const events = window.slice(-limit)
  const hasOlder = window.length > events.length
  return {
    events, total: all.length, pageSize: limit,
    ...(events.length ? { firstSeq: events[0]!.seq, lastSeq: events.at(-1)!.seq } : {}),
    ...(hasOlder && events.length ? { nextBefore: events[0]!.seq } : {}),
    hasOlder, truncated: scanned.length > HISTORY_SCAN_LIMIT,
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
/** The one declared set (`src/types.ts`): every event that fences a running attempt. */
const ATTEMPT_CLOSERS: ReadonlySet<string> = new Set(ATTEMPT_FENCING_EVENTS)
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
  // DEAD: the same graph validator the admission path runs, over the graph the
  // durable log carries. A log whose `task/proposed` rows describe an illegal
  // graph is refused here, before any command is derived from it, rather than
  // replayed into a sequence that no legal mission could have produced.
  const graph: TaskGraphNode[] = []
  for (const event of events) {
    if (event.type === 'task/proposed') {
      const data = asObject(event.data, event.seq, event.type)
      graph.push({
        id: required(data, 'id', event.seq),
        dependencies: Array.isArray(data.dependencies) ? data.dependencies.filter((id): id is string => typeof id === 'string') : [],
        ...(typeof data.reviewOf === 'string' && data.reviewOf ? { reviewOf: data.reviewOf } : {}),
      })
    } else if (event.type === 'task/amended' || event.type === 'task/plan-repaired') {
      const data = asObject(event.data, event.seq, event.type)
      const taskId = required(data, 'taskId', event.seq)
      const node = graph.find(task => task.id === taskId)
      if (!node) throw new ReplayTruncationError(`durable log lacks the admission for amended task ${taskId}`, [taskId])
      const changes = asObject(event.type === 'task/amended' ? data.changes : data.task, event.seq, `${event.type} changes`)
      if (Array.isArray(changes.dependencies)) node.dependencies = [...new Set(changes.dependencies.filter((id): id is string => typeof id === 'string' && id !== node.reviewOf))]
      if (event.type === 'task/plan-repaired') {
        if (typeof changes.reviewOf === 'string' && changes.reviewOf) node.reviewOf = changes.reviewOf
        else delete node.reviewOf
      }
    }
  }
  const graphDefects = taskGraphDefects(graph)
  if (graphDefects.length > 0) {
    throw new ReplayGraphError(`replayed task graph is illegal: ${graphDefects.map(defect => defect.message).join(' ')}`, graphDefects)
  }
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
    if (event.type === 'task/amended') {
      const data = asObject(event.data, event.seq, event.type)
      if (typeof data.fencedAttemptId === 'string' && open.get(data.fencedAttemptId)?.taskId === data.taskId) open.delete(data.fencedAttemptId)
      continue
    }
    if (event.type !== 'task/claimed' && !ATTEMPT_CLOSERS.has(event.type)) continue
    const data = asObject(event.data, event.seq, event.type)
    if (event.type === 'task/claimed') {
      const taskId = required(data, 'taskId', event.seq)
      const attempt = asObject(data.attempt, event.seq, 'task/claimed attempt')
      const attemptId = required(attempt, 'id', event.seq)
      const memberId = required(attempt, 'ownerId', event.seq)
      const earlier = [...open.entries()].find(([, record]) => record.taskId === taskId)
      if (earlier) throw new ReplayTruncationError(`durable log is truncated: ${taskId} was dispatched again at seq ${event.seq} before attempt ${earlier[0]} reached a closing event`, [`${taskId}#${earlier[0]}`])
      if (open.has(attemptId)) throw new ReplayCorruptionError(`attempt ${attemptId} was claimed for another task at seq ${event.seq}`, event.seq)
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
