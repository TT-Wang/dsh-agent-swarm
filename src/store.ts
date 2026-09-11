/**
 * Transactional single-host state and outbox. SQLite commits precede notifications.
 *
 * Boundary (single-host, single-writer): WAL gives readers-don't-block-writers but
 * permits exactly one writer at a time, and WAL requires every process on the same
 * host. The exclusive lock below refuses a second live runtime, so a competing
 * writer is either this process retried (`withWriterRetry`) or a classified
 * `WriterBusyError`; it is never silently lost. Multi-host scale-out needs external
 * coordination and is out of scope. See `scripts/load/README.md`.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, chmodSync, existsSync, readdirSync, copyFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join, basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AutoStart, Delivery, DraftPlan, Evidence, Member, Mission, Post, PostKind, SchedulingPass, SwarmEvent, Task, ToolRun, Workstream } from './types.ts'
import type { AdmissionReason, AdmissionRecord, LimitRule } from './scheduler.ts'
// R17-G7: one derivation for the derived member status; the store never persists it.
import { deriveMemberStatus, memberPhaseOf } from './projection.ts'

interface Tables {
  missions: Mission
  members: Member
  workstreams: Workstream
  tasks: Task
  evidence: Evidence
  tool_runs: ToolRun
  deliveries: Delivery
  drafts: DraftPlan
  starts: AutoStart
  admissions: AdmissionRecord
  limits: LimitRule
  passes: SchedulingPass
}
export type Table = keyof Tables
const TABLES: Table[] = ['missions', 'members', 'workstreams', 'tasks', 'evidence', 'tool_runs', 'deliveries', 'drafts', 'starts', 'admissions', 'limits', 'passes']
/** Bounded board filters. `inboxFor` means "addressed to this key or mission-wide". */
export interface PostFilter {
  kind?: PostKind
  toMemberId?: string
  inboxFor?: string
  missionWide?: boolean
  taskId?: string
  afterSeq?: number
  /** With `afterSeq`, return the newest matches instead of the oldest. */
  newest?: boolean
  limit?: number
}
/** v3 adds the append-only `posts` board table; older versions are read-compatible. */
const SCHEMA_VERSION = 3
const CHANGE_HISTORY = 1024
const DEFAULT_BUSY_TIMEOUT_MS = 5000
const DEFAULT_WRITER_ATTEMPTS = 3
const DEFAULT_WRITER_DELAY_MS = 25
/** WAL growth is bounded between checkpoints; a checkpoint runs automatically every 1000 pages. */
const WAL_AUTOCHECKPOINT_PAGES = 1000
const WAL_JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024
/**
 * R11-02: periodic `VACUUM INTO` snapshots. The snapshot directory is derived
 * from the state file, so it lives in the owner's state directory — never in a
 * mission workspace or the source checkout — and an owner restore path can
 * recover a truncated or deleted store instead of silently starting empty.
 */
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60_000
const DEFAULT_SNAPSHOT_KEEP = 5
const SNAPSHOT_SUFFIX = '.snapshot.sqlite'
/** Tuning for the single-writer boundary; tests and the load harness shorten it. */
export interface StoreOptions {
  /** How long SQLite waits for a competing writer before raising SQLITE_BUSY. */
  busyTimeoutMs?: number
  /** Bounded retries after a classified SQLITE_BUSY. */
  writerAttempts?: number
  /** Backoff between writer retries, multiplied by the attempt number. */
  writerDelayMs?: number
  /** Directory for periodic snapshots; defaults to `<statePath>.snapshots`, a sibling of the state file. */
  snapshotDir?: string
  /** Periodic snapshot interval; 0 disables the timer (explicit `snapshot()` still works). */
  snapshotIntervalMs?: number
  /** How many snapshots to retain; the newest is always kept. */
  snapshotKeep?: number
}
/**
 * R11-02: the store cannot be opened safely and the owner must choose a
 * recovery path. `code` is stable so callers branch on it, never on message
 * text; `snapshots` names every available recovery point.
 */
export class StoreRecoveryError extends Error {
  readonly code: 'store_corrupt' | 'store_missing_with_snapshots' | 'snapshot_invalid' | 'restore_blocked'
  readonly statePath: string
  readonly snapshots: string[]
  constructor(code: StoreRecoveryError['code'], message: string, statePath: string, snapshots: string[] = []) {
    super(message)
    this.name = 'StoreRecoveryError'
    this.code = code
    this.statePath = statePath
    this.snapshots = snapshots
  }
}
/** A writer conflict that survived bounded retries; classified, never silent. */
export class WriterBusyError extends Error {
  readonly reason = 'writer_busy' as const
  readonly attempts: number
  constructor(message: string, attempts: number, readonly cause?: unknown) {
    super(message)
    this.name = 'WriterBusyError'
    this.attempts = attempts
  }
}
/** SQLITE_BUSY (5) and SQLITE_LOCKED (6) are contention, not corruption. */
export function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  const errcode = (error as { errcode?: unknown } | undefined)?.errcode
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || errcode === 5 || errcode === 6) return true
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(message)
}
/**
 * S5: a task write that disagrees with the task's durable per-task revision.
 * The record was read before another write was accepted, so applying this one
 * would be a lost update — the exact shape of the Row-13 P0, where an
 * in-memory flag papered over a task row decided from stale memory. The refusal
 * names the durable revision, not the caller's stale one, so the caller can
 * re-read and decide again; `code` is stable so callers branch on it, never on
 * message text.
 */
export class StaleTaskRevisionError extends Error {
  readonly code = 'stale_task_revision' as const
  /** The imperative next step, separate from the prose so a caller can render it. */
  readonly nextStep: string
  constructor(readonly taskId: string, readonly expected: number, readonly current: number, readonly missionId: string) {
    const nextStep = `Read task ${taskId} again (swarm_observe with taskId=${taskId}, or SwarmStore.get), then retry the write once with revision ${current}`
    super(`Task ${taskId} write refused: it presents revision ${expected} but the durable task is at revision ${current}; another write was accepted after this writer read the task. ${nextStep}; a second refusal means another writer won again, so re-read and decide on the current record instead of overwriting it.`)
    this.name = 'StaleTaskRevisionError'
    this.nextStep = nextStep
  }
}
/** One refused stale task write, recorded durably when the refused write rolled back. */
export interface StaleTaskRefusal {
  missionId: string
  taskId: string
  expected: number
  current: number
  at: number
}
/** The durable event type every refused stale task write is recorded under. */
export const STALE_TASK_REFUSAL_EVENT = 'task/stale-revision-refused'

/**
 * R11-02: a state file that is not a database, or is structurally corrupt.
 * Distinct from contention (`isSqliteBusy`) and from an unsupported schema, so
 * the open path can fail closed and name the snapshot recovery path instead of
 * surfacing a raw SQLite string.
 */
export function isSqliteNotADatabase(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code
  const errcode = (error as { errcode?: unknown } | undefined)?.errcode
  if (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT' || errcode === 26 || errcode === 11) return true
  const message = error instanceof Error ? error.message : String(error)
  return /file is not a database|SQLITE_NOTADB|database disk image is malformed|SQLITE_CORRUPT/i.test(message)
}
/** Synchronous bounded backoff; node:sqlite is synchronous, so timers cannot be awaited here. */
function sleepSync(ms: number): void {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
/** Run a writer operation, retrying a classified SQLITE_BUSY with bounded backoff. */
export function withWriterRetry<T>(operation: () => T, options: { attempts?: number; delayMs?: number; onBusy?: (attempt: number, error: unknown) => void } = {}): T {
  const attempts = Math.max(1, Math.trunc(options.attempts ?? DEFAULT_WRITER_ATTEMPTS))
  const delayMs = Math.max(0, Math.trunc(options.delayMs ?? DEFAULT_WRITER_DELAY_MS))
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return operation() } catch (error) {
      if (!isSqliteBusy(error)) throw error
      lastError = error
      options.onBusy?.(attempt, error)
      if (attempt < attempts) sleepSync(delayMs * attempt)
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new WriterBusyError(`SQLite writer stayed busy after ${attempts} attempt(s): ${message}`, attempts, lastError)
}
export interface StoreChange { revision: number; scopes: string[] }
/** SQLite-backed source of truth. Only one live runtime may own a state file. */
export class SwarmStore {
  private readonly db: DatabaseSync
  private readonly lockPath: string
  private readonly nonce = randomUUID()
  private readonly busyTimeoutMs: number
  private readonly writerAttempts: number
  private readonly writerDelayMs: number
  private readonly statePath: string
  private readonly snapshotDir: string
  private readonly snapshotIntervalMs: number
  private readonly snapshotKeep: number
  private snapshotTimer?: ReturnType<typeof setInterval>
  private lastSnapshotRevision = -1
  private lastSnapshotError?: string
  private closed = false
  private transactionScopes?: Set<string>
  private readonly listeners = new Set<() => void>()
  /**
   * S5: stale task refusals produced inside a transaction. The refused write
   * makes the caller's transaction roll back (a compare-and-swap has no partial
   * outcome), so the refusal record is committed by `transaction()` immediately
   * after the rollback instead of being erased by it.
   */
  private pendingStaleRefusals: StaleTaskRefusal[] = []
  constructor(path: string, options: StoreOptions = {}) {
    this.busyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))
    this.writerAttempts = Math.max(1, Math.trunc(options.writerAttempts ?? DEFAULT_WRITER_ATTEMPTS))
    this.writerDelayMs = Math.max(0, Math.trunc(options.writerDelayMs ?? DEFAULT_WRITER_DELAY_MS))
    this.statePath = path
    this.snapshotDir = options.snapshotDir ?? `${path}.snapshots`
    this.snapshotIntervalMs = Math.max(0, Math.trunc(options.snapshotIntervalMs ?? DEFAULT_SNAPSHOT_INTERVAL_MS))
    this.snapshotKeep = Math.max(1, Math.trunc(options.snapshotKeep ?? DEFAULT_SNAPSHOT_KEEP))
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.lockPath = `${path}.lock`
    this.acquireLock()
    // R11-02: a state file that disappeared while snapshots exist is data loss,
    // not a fresh install. Fail closed and name the recovery path instead of
    // silently starting an empty board.
    if (!existsSync(path)) {
      const snapshots = this.listSnapshots()
      if (snapshots.length > 0) {
        this.releaseLock()
        throw new StoreRecoveryError('store_missing_with_snapshots',
          `Swarm state ${path} is missing but ${snapshots.length} snapshot(s) exist. Restore one before starting the host: SwarmStore.restore(statePath, snapshot). Latest: ${snapshots.at(-1)}`,
          path, snapshots)
      }
    }
    try {
      this.db = new DatabaseSync(path)
      chmodSync(path, 0o600)
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=${this.busyTimeoutMs}; PRAGMA wal_autocheckpoint=${WAL_AUTOCHECKPOINT_PAGES}; PRAGMA journal_size_limit=${WAL_JOURNAL_SIZE_LIMIT};`)
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version
      if (version !== 0 && version !== 1 && version !== 2 && version !== SCHEMA_VERSION) throw new Error(`Unsupported swarm schema ${String(version)}; expected ${SCHEMA_VERSION}`)
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (const table of TABLES) {
          this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_mission ON ${table}(mission_id);`)
        }
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS starts_command ON starts(json_extract(value, '$.ownerSessionId'), json_extract(value, '$.commandId'))")
        // Board posts are append-only and carry a host-assigned sequence as the
        // primary key, so delta reads page on a monotonic cursor. They are never
        // updated in place: a post is immutable once recorded.
        this.db.exec('CREATE TABLE IF NOT EXISTS posts (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, mission_id TEXT NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS posts_mission ON posts(mission_id, seq);')
        this.db.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS events_mission ON events(mission_id, seq);')
        this.db.exec('CREATE TABLE IF NOT EXISTS state_revision (id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO state_revision(id,revision) VALUES(1,0); CREATE TABLE IF NOT EXISTS state_changes (revision INTEGER PRIMARY KEY, scopes TEXT NOT NULL);')
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`)
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    } catch (error) {
      this.releaseLock()
      if (isSqliteNotADatabase(error)) throw new StoreRecoveryError('store_corrupt',
        `Swarm state ${this.statePath} is not a usable database (${error instanceof Error ? error.message : String(error)}). Restore a snapshot before starting the host: SwarmStore.restore(statePath, snapshot). Snapshots: ${this.listSnapshots().join(', ') || 'none'}`,
        this.statePath, this.listSnapshots())
      throw error
    }
    if (this.snapshotIntervalMs > 0) {
      this.snapshotTimer = setInterval(() => this.periodicSnapshot(), this.snapshotIntervalMs)
      this.snapshotTimer.unref()
    }
  }
  private acquireLock(): void {
    try {
      const fd = openSync(this.lockPath, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: this.nonce })) } finally { closeSync(fd) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let lock: { pid: number }
      try { lock = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid: number } }
      catch { throw new Error(`Unrecognized runtime lock: ${this.lockPath}; inspect it before removing`) }
      if (!Number.isInteger(lock.pid) || lock.pid < 1) throw new Error('Invalid swarm runtime lock')
      try { process.kill(lock.pid, 0) }
      catch (check) {
        if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check
        unlinkSync(this.lockPath)
        this.acquireLock()
        return
      }
      throw new Error(`Swarm database is already owned by process ${lock.pid}`)
    }
  }
  private releaseLock(): void {
    try {
      const value = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { nonce?: string }
      if (value.nonce === this.nonce) unlinkSync(this.lockPath)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  /** Commit a synchronous group of state changes and outbox events atomically. */
  transaction<T>(operation: () => T): T {
    if (this.closed) throw new Error('Swarm store is closed')
    if (this.transactionScopes) throw new Error('Nested swarm transactions are not supported')
    // Only lock acquisition and commit are retried: the body is caller code and
    // runs exactly once, so a retry can never double-apply a side effect.
    withWriterRetry(() => this.db.exec('BEGIN IMMEDIATE'), { attempts: this.writerAttempts, delayMs: this.writerDelayMs })
    this.transactionScopes = new Set()
    let result: T, changed = false
    try {
      result = operation()
      changed = this.transactionScopes.size > 0
      if (changed) {
        this.db.exec('UPDATE state_revision SET revision=revision+1 WHERE id=1')
        const revision = this.revision()
        this.db.prepare('INSERT INTO state_changes(revision,scopes) VALUES(?,?)').run(revision, JSON.stringify([...this.transactionScopes]))
        this.db.prepare('DELETE FROM state_changes WHERE revision<=?').run(revision - CHANGE_HISTORY)
      }
      withWriterRetry(() => this.db.exec('COMMIT'), { attempts: this.writerAttempts, delayMs: this.writerDelayMs })
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* A failed commit may already have ended the transaction. */ }
      // S5: the rollback erased the refused write, not the evidence of it. The
      // refusal record is committed on its own before the error leaves this call.
      this.flushStaleRefusals()
      if (error instanceof WriterBusyError || !isSqliteBusy(error)) throw error
      throw new WriterBusyError(`SQLite writer conflicted during a swarm transaction: ${error instanceof Error ? error.message : String(error)}`, this.writerAttempts, error)
    } finally { this.transactionScopes = undefined }
    // Observers see only committed data, and cannot roll back another observer's work.
    if (changed) this.publish()
    return result
  }
  /** Cursor for every committed mutation, including those without coordination events. */
  revision(): number {
    if (this.closed) throw new Error('Swarm store is closed')
    return Number(this.db.prepare('SELECT revision FROM state_revision WHERE id=1').get()!.revision)
  }
  /** Undefined means the cursor cannot be replayed and the reader needs a fresh snapshot. */
  changesSince(after: number): StoreChange[] | undefined {
    const current = this.revision()
    if (!Number.isSafeInteger(after) || after < 0 || after > current) return undefined
    if (after === current) return []
    const first = Number(this.db.prepare('SELECT MIN(revision) AS first FROM state_changes').get()?.first ?? current + 1)
    if (after < first - 1) return undefined
    return this.db.prepare('SELECT revision,scopes FROM state_changes WHERE revision>? ORDER BY revision').all(after)
      .map(row => ({ revision: Number(row.revision), scopes: JSON.parse(String(row.scopes)) as string[] }))
  }
  subscribe(listener: () => void): () => void {
    if (this.closed) throw new Error('Swarm store is closed')
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(): void { for (const listener of this.listeners) { try { listener() } catch { /* Observers own failure handling. */ } } }
  /** Read a detached record. Durable parsers reject malformed identity fields. */
  get<T extends Table>(table: T, id: string): Tables[T] | undefined {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id)
    if (row === undefined) return undefined
    const parsed = this.parse<T>(String(row.value), id)
    if (table === 'members') return this.hydrateMembers([parsed as unknown as Member])[0] as unknown as Tables[T]
    return parsed
  }
  private parse<T extends Table>(json: string, id?: string): Tables[T] {
    const result: unknown = JSON.parse(json)
    if (result === null || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string' || (id !== undefined && result.id !== id)) throw new Error('Corrupt swarm record identity')
    return result as Tables[T]
  }
  /** Read a mission's records, or all records for host recovery. */
  list<T extends Table>(table: T, missionId?: string): Tables[T][] {
    const rows = missionId === undefined ? this.db.prepare(`SELECT value FROM ${table} ORDER BY rowid`).all()
      : this.db.prepare(`SELECT value FROM ${table} WHERE mission_id=? ORDER BY rowid`).all(missionId)
    const parsed = rows.map(row => this.parse<T>(String(row.value)))
    // R17-G7: member rows are hydrated with the derived live status at the one
    // read face, so no reader sees a durable status (there is none).
    if (table === 'members') return this.hydrateMembers(parsed as unknown as Member[]) as unknown as Tables[T][]
    return parsed
  }
  /**
   * R17-G7: the derived member view. The durable row carries a phase; the live
   * status is computed here from that phase and the tasks that name the member
   * as the owner of a running attempt (`deriveMemberStatus`). The member is
   * never given a stored status to mirror, so the R15-F2 seam (a row reading
   * `idle` while a live attempt exists) cannot be constructed.
   */
  private hydrateMembers(members: readonly Member[]): Member[] {
    const views: Member[] = []
    let cachedMission = ''
    let liveOwners = new Set<string>()
    for (const member of members) {
      if (member.missionId !== cachedMission) {
        cachedMission = member.missionId
        liveOwners = this.liveAttemptOwners(cachedMission)
      }
      // R17-G7: the ONE phase rule, including the legacy mapping, so a
      // phase-less row that records `stopped`/`waiting` keeps its intent.
      const phase = memberPhaseOf(member)
      views.push({ ...member, phase, status: deriveMemberStatus(phase, liveOwners.has(member.id)) })
    }
    return views
  }
  /** Members that own a running attempt in one mission, read from the durable task rows. */
  private liveAttemptOwners(missionId: string): Set<string> {
    const rows = this.db.prepare(`SELECT json_extract(value,'$.attempt.ownerId') AS owner_id FROM tasks WHERE mission_id=? AND json_extract(value,'$.status')='running' AND json_extract(value,'$.attempt.ownerId') IS NOT NULL`).all(missionId)
    return new Set(rows.map(row => String(row.owner_id)))
  }
  /** Write a detached record inside its caller's transaction. */
  put<T extends Table>(table: T, value: Tables[T]): void {
    // S5: every task write is a compare-and-swap on the task's own revision.
    // The funnel is deliberate: all call sites (runtime, attempts, scheduling,
    // workspace-admission, gates) write tasks through this one method, so no
    // path can bypass the guard by holding a record it read before another
    // accepted write.
    if (table === 'tasks') { this.putTask(value as Task); return }
    // R17-G7: the member funnel drops the derived live status and normalizes the
    // durable phase. A caller that assigns `member.status` (there are legacy
    // sites outside this round's write scope) changes nothing durable: the next
    // read re-derives the status from the phase and the live attempts.
    if (table === 'members') {
      const member = value as Member
      const { status: _derivedStatus, ...durable } = member
      this.upsert(table, { ...durable, phase: memberPhaseOf(member) } as Tables[T])
      return
    }
    this.upsert(table, value)
  }
  /**
   * S5: the durable revision of one task. `0` means "no versioned row yet"
   * (a new id, or a row written before per-task revisions existed), which is
   * also the value an unversioned writer presents.
   */
  taskRevision(taskId: string): number {
    return this.get('tasks', taskId)?.revision ?? 0
  }
  /**
   * S5 compare-and-swap for one task row. The presented revision must equal the
   * durable one; the accepted write stamps `current + 1` onto the caller's
   * object, so a caller that re-writes the same record inside the same
   * transaction stays consistent, while a caller that presents a revision
   * another writer already moved past is refused with `StaleTaskRevisionError`
   * and leaves no partial write behind. Returns the revision that was written.
   */
  putTask(value: Task): number {
    if (value.revision !== undefined && !Number.isSafeInteger(value.revision)) throw new Error('Invalid task revision')
    const current = this.get('tasks', value.id)
    const expected = value.revision ?? 0
    const currentRevision = current?.revision ?? 0
    if (current !== undefined && expected !== currentRevision) throw this.refuseStaleTask(value, expected, currentRevision)
    value.revision = currentRevision + 1
    this.upsert('tasks', value)
    return value.revision
  }
  private upsert<T extends Table>(table: T, value: Tables[T]): void {
    const missionId = 'missionId' in value && value.missionId !== undefined ? value.missionId : value.id
    const statement = this.db.prepare(`INSERT INTO ${table}(id,mission_id,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET mission_id=excluded.mission_id,value=excluded.value`)
    withWriterRetry(() => statement.run(value.id, missionId, JSON.stringify(value)), { attempts: this.writerAttempts, delayMs: this.writerDelayMs })
    this.transactionScopes?.add(missionId)
    if ('ownerSessionId' in value) this.transactionScopes?.add(value.ownerSessionId)
    if ('sessionId' in value) this.transactionScopes?.add(value.sessionId)
  }
  /** Record the refusal durably and hand the caller the diagnostic to throw. */
  private refuseStaleTask(value: Task, expected: number, current: number): StaleTaskRevisionError {
    const refusal: StaleTaskRefusal = { missionId: value.missionId, taskId: value.id, expected, current, at: Date.now() }
    // Inside a caller transaction the record is flushed after its rollback;
    // outside one there is nothing to roll back, so it is committed now.
    if (this.transactionScopes === undefined) this.recordStaleRefusals([refusal])
    else this.pendingStaleRefusals.push(refusal)
    return new StaleTaskRevisionError(value.id, expected, current, value.missionId)
  }
  private flushStaleRefusals(): void {
    const pending = this.pendingStaleRefusals
    this.pendingStaleRefusals = []
    this.recordStaleRefusals(pending)
  }
  /**
   * One durable `task/stale-revision-refused` event per refused write, so the
   * lost update is visible in the mission record even though the write itself
   * was rolled back. Never throws: a refusal record must not mask the refusal.
   */
  private recordStaleRefusals(refusals: readonly StaleTaskRefusal[]): void {
    if (this.closed || !refusals.length) return
    try {
      // The transaction that produced these may have rolled back already; clear
      // the scope so the record's own transaction can open.
      this.transactionScopes = undefined
      this.transaction(() => {
        for (const refusal of refusals) this.event(refusal.missionId, STALE_TASK_REFUSAL_EVENT, 'runtime', { taskId: refusal.taskId, expected: refusal.expected, current: refusal.current })
      })
    } catch { /* The write was still refused; the record is best-effort bookkeeping. */ }
  }
  /** Append an immutable coordination event inside the same state transaction. */
  event(missionId: string, type: string, actor: string, data: unknown): void {
    const statement = this.db.prepare('INSERT INTO events(mission_id,type,actor,data,created_at) VALUES(?,?,?,?,?)')
    withWriterRetry(() => statement.run(missionId, type, actor, JSON.stringify(data), Date.now()), { attempts: this.writerAttempts, delayMs: this.writerDelayMs })
    this.transactionScopes?.add(missionId)
  }
  /**
   * Upsert one admission decision. A repeated refusal for the same candidate and
   * reason merges in place — the count grows, the row does not — so a mission
   * refused every tick keeps a bounded ledger.
   */
  recordAdmission(next: AdmissionRecord): AdmissionRecord {
    const previous = this.get('admissions', next.id)
    const merged: AdmissionRecord = previous === undefined
      ? next
      : { ...next, count: previous.count + 1, firstAt: previous.firstAt, lastAt: Math.max(previous.lastAt, next.lastAt) }
    this.put('admissions', merged)
    return merged
  }
  /** Read the admission ledger for a mission, newest last. */
  admissions(missionId: string, filter: { reason?: AdmissionReason; admitted?: boolean; memberId?: string; taskId?: string; limit?: number } = {}): AdmissionRecord[] {
    const clauses = ['mission_id=?'], params: Array<string | number> = [missionId]
    if (filter.reason !== undefined) { clauses.push("json_extract(value,'$.reason')=?"); params.push(filter.reason) }
    if (filter.memberId !== undefined) { clauses.push("json_extract(value,'$.memberId')=?"); params.push(filter.memberId) }
    if (filter.taskId !== undefined) { clauses.push("json_extract(value,'$.taskId')=?"); params.push(filter.taskId) }
    if (filter.admitted !== undefined) { clauses.push("json_extract(value,'$.admitted')=?"); params.push(filter.admitted ? 1 : 0) }
    let sql = `SELECT value FROM admissions WHERE ${clauses.join(' AND ')} ORDER BY rowid`
    if (filter.limit !== undefined) { sql += ' LIMIT ?'; params.push(filter.limit) }
    return this.db.prepare(sql).all(...params).map(row => this.parse<'admissions'>(String(row.value)))
  }
  /** Number of runs recorded for a mission; the next run's per-mission position is count + 1. */
  countToolRuns(missionId: string): number {
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM tool_runs WHERE mission_id=?').get(missionId)!.count)
  }
  /**
   * Read tool runs in recorded order with optional identity filters and a
   * position cursor. Runs recorded before positions existed sort as position 0.
   */
  toolRuns(missionId: string, filter: { memberId?: string; taskId?: string; attemptId?: string; afterSeq?: number; limit?: number } = {}): ToolRun[] {
    const clauses = ['mission_id=?'], params: Array<string | number> = [missionId]
    for (const key of ['memberId', 'taskId', 'attemptId'] as const) {
      if (filter[key] !== undefined) { clauses.push(`json_extract(value,'$.${key}')=?`); params.push(filter[key]!) }
    }
    if (filter.afterSeq !== undefined) { clauses.push("COALESCE(json_extract(value,'$.seq'),0)>?"); params.push(filter.afterSeq) }
    let sql = `SELECT value FROM tool_runs WHERE ${clauses.join(' AND ')} ORDER BY rowid`
    if (filter.limit !== undefined) { sql += ' LIMIT ?'; params.push(filter.limit) }
    return this.db.prepare(sql).all(...params).map(row => this.parse<'tool_runs'>(String(row.value)))
  }
  /** One durable board post by id, or undefined when it does not exist. */
  post(id: string): Post | undefined {
    if (this.closed) throw new Error('Swarm store is closed')
    const row = this.db.prepare('SELECT value FROM posts WHERE id=?').get(id)
    return row === undefined ? undefined : this.parsePost(String(row.value), id)
  }
  /**
   * Append one immutable board post. The sequence is host-assigned inside the
   * caller's transaction; the runtime is the single writer, so `MAX(seq)+1`
   * cannot race. Posts are never updated or deleted, which is what makes the
   * cursor a gap-free delta position.
   */
  recordPost(post: Omit<Post, 'seq'>): Post {
    if (this.closed) throw new Error('Swarm store is closed')
    const seq = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM posts').get()!.next)
    const stored: Post = { ...post, seq }
    const statement = this.db.prepare('INSERT INTO posts(seq,id,mission_id,value) VALUES(?,?,?,?)')
    withWriterRetry(() => statement.run(stored.seq, stored.id, stored.missionId, JSON.stringify(stored)), { attempts: this.writerAttempts, delayMs: this.writerDelayMs })
    this.transactionScopes?.add(stored.missionId)
    return stored
  }
  /**
   * Bounded board page in sequence order. Without a cursor the newest `limit`
   * posts are returned; with `afterSeq` the next page is returned oldest-first
   * (or newest-first when `newest` is set), so a reader can page without gaps
   * or repeats. Filters are applied in SQL so a page never hides matching posts.
   */
  posts(missionId: string, filter: PostFilter = {}): Post[] {
    if (this.closed) throw new Error('Swarm store is closed')
    const limit = filter.limit === undefined ? undefined : Math.max(0, Math.trunc(filter.limit))
    if (limit === 0) return []
    const { where, params } = this.postWhere(missionId, filter)
    const ascending = filter.afterSeq !== undefined && filter.newest !== true
    const rows = this.db.prepare(`SELECT value FROM posts WHERE ${where} ORDER BY seq ${ascending ? 'ASC' : 'DESC'}${limit === undefined ? '' : ' LIMIT ?'}`)
      .all(...(limit === undefined ? params : [...params, limit]))
    const posts = rows.map(row => this.parsePost(String(row.value)))
    return ascending ? posts : posts.reverse()
  }
  /** Count matching posts without materializing them; used for bounded delta counts. */
  countPosts(missionId: string, filter: PostFilter = {}): number {
    if (this.closed) throw new Error('Swarm store is closed')
    const { where, params } = this.postWhere(missionId, filter)
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM posts WHERE ${where}`).get(...params)!.count)
  }
  private postWhere(missionId: string, filter: PostFilter): { where: string; params: Array<string | number> } {
    const clauses = ['mission_id=?']
    const params: Array<string | number> = [missionId]
    if (filter.kind !== undefined) { clauses.push("json_extract(value,'$.kind')=?"); params.push(filter.kind) }
    if (filter.toMemberId !== undefined) { clauses.push("json_extract(value,'$.toMemberId')=?"); params.push(filter.toMemberId) }
    // Mission-wide posts omit `toMemberId` entirely, so JSON extraction yields NULL.
    if (filter.inboxFor !== undefined) { clauses.push("(json_extract(value,'$.toMemberId') IS NULL OR json_extract(value,'$.toMemberId')=?)"); params.push(filter.inboxFor) }
    if (filter.missionWide === true) clauses.push("json_extract(value,'$.toMemberId') IS NULL")
    if (filter.taskId !== undefined) { clauses.push("json_extract(value,'$.taskId')=?"); params.push(filter.taskId) }
    if (filter.afterSeq !== undefined) { clauses.push('seq>?'); params.push(filter.afterSeq) }
    return { where: clauses.join(' AND '), params }
  }
  private parsePost(json: string, id?: string): Post {
    const result: unknown = JSON.parse(json)
    if (result === null || typeof result !== 'object' || !('id' in result) || typeof result.id !== 'string' || (id !== undefined && result.id !== id)
      || !('seq' in result) || !Number.isSafeInteger(result.seq)) throw new Error('Corrupt board post record')
    return result as Post
  }
  /** Read chronological deltas, bounded for display and agent context. */
  events(missionId: string, limit: number, after = 0): SwarmEvent[] {
    const rows = after > 0
      ? this.db.prepare('SELECT * FROM events WHERE mission_id=? AND seq>? ORDER BY seq LIMIT ?').all(missionId, after, limit)
      : this.db.prepare('SELECT * FROM (SELECT * FROM events WHERE mission_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(missionId, limit)
    return rows.map(row => ({ seq: Number(row.seq), missionId: String(row.mission_id), type: String(row.type), actor: String(row.actor), data: JSON.parse(String(row.data)), createdAt: Number(row.created_at) }))
  }
  /** Snapshot files, oldest first; the name orders by revision then timestamp. */
  listSnapshots(): string[] {
    try {
      return readdirSync(this.snapshotDir).filter(name => name.endsWith(SNAPSHOT_SUFFIX)).sort().map(name => join(this.snapshotDir, name))
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  /** Snapshot metadata for the owner, newest first. */
  snapshots(): Array<{ path: string; bytes: number; createdAt: number }> {
    return this.listSnapshots().map(path => { const info = statSync(path); return { path, bytes: info.size, createdAt: info.mtimeMs } }).reverse()
  }
  /** R11-02 owner-visible snapshot status; a timer failure is reported, never thrown. */
  snapshotState(): { dir: string; intervalMs: number; keep: number; lastRevision: number; snapshots: number; lastError?: string } {
    return { dir: this.snapshotDir, intervalMs: this.snapshotIntervalMs, keep: this.snapshotKeep, lastRevision: this.lastSnapshotRevision, snapshots: this.listSnapshots().length,
      ...(this.lastSnapshotError === undefined ? {} : { lastError: this.lastSnapshotError }) }
  }
  /**
   * R11-02: one consistent `VACUUM INTO` snapshot beside the state file. The
   * target directory is derived from the owner-configured state path, so it
   * lives in the owner's state directory and never in a mission workspace or
   * the source checkout. `VACUUM INTO` folds the WAL into a single complete
   * database file, so a restore is one validated copy.
   */
  snapshot(): { path: string; revision: number; bytes: number } {
    if (this.closed) throw new Error('Swarm store is closed')
    if (this.transactionScopes) throw new Error('A snapshot cannot run inside a swarm transaction')
    mkdirSync(this.snapshotDir, { recursive: true, mode: 0o700 })
    const revision = this.revision()
    const file = join(this.snapshotDir, `swarm-r${String(revision).padStart(12, '0')}-${Date.now()}-${randomUUID().slice(0, 8)}${SNAPSHOT_SUFFIX}`)
    try {
      this.db.prepare('VACUUM INTO ?').run(file)
      chmodSync(file, 0o600)
    } catch (error) {
      rmSync(file, { force: true })
      throw error
    }
    this.lastSnapshotRevision = revision
    this.lastSnapshotError = undefined
    this.pruneSnapshots()
    const bytes = statSync(file).size
    // Durable bookkeeping: the snapshot predates this event, so the file list
    // (not the event) is authoritative for the owner restore path.
    this.event('swarm/install', 'store/snapshot', 'runtime', { path: file, revision, bytes })
    return { path: file, revision, bytes }
  }
  private periodicSnapshot(): void {
    if (this.closed) return
    try {
      if (this.revision() === this.lastSnapshotRevision && this.listSnapshots().length > 0) return
      this.snapshot()
    } catch (error) {
      this.lastSnapshotError = error instanceof Error ? error.message : String(error)
    }
  }
  private pruneSnapshots(): void {
    const files = this.listSnapshots()
    for (const file of files.slice(0, Math.max(0, files.length - this.snapshotKeep))) rmSync(file, { force: true })
  }
  /**
   * R11-02 owner restore path. Validates the snapshot's integrity and schema,
   * refuses while another live runtime owns the state file, then atomically
   * replaces the state file and drops stale WAL sidecars. Deliberately not a
   * model-callable tool: recovery is an owner action, so a worker can never
   * roll the mission back.
   */
  static restore(statePath: string, snapshotPath: string): { restoredFrom: string; bytes: number } {
    if (!existsSync(snapshotPath)) throw new StoreRecoveryError('snapshot_invalid', `Snapshot ${snapshotPath} does not exist`, statePath)
    const lockPath = `${statePath}.lock`
    if (existsSync(lockPath)) {
      let pid: number | undefined
      try { pid = (JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number }).pid } catch { pid = undefined }
      let alive = false
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); alive = true } catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM' }
      }
      if (alive || pid === undefined) {
        throw new StoreRecoveryError('restore_blocked',
          `Swarm state ${statePath} is owned by a live runtime${alive && pid !== undefined ? ` (pid ${pid})` : ''}; stop the host before restoring a snapshot. If no host is running, delete ${lockPath} and retry.`, statePath)
      }
      // OWNER PASS 2026-09-11: a crashed host leaves its lock behind, and the
      // store's own acquire path already reclaims a dead pid — restore did not,
      // so the recovery path was unavailable exactly when it was needed: a host
      // killed while a restore request was staged could never apply it again.
      // Reclaim the same way acquireLock does, then continue.
      rmSync(lockPath, { force: true })
    }
    SwarmStore.validateSnapshot(statePath, snapshotPath)
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 })
    const staging = `${statePath}.restore-${randomUUID()}.tmp`
    copyFileSync(snapshotPath, staging)
    chmodSync(staging, 0o600)
    renameSync(staging, statePath)
    for (const suffix of ['-wal', '-shm']) rmSync(`${statePath}${suffix}`, { force: true })
    return { restoredFrom: snapshotPath, bytes: statSync(statePath).size }
  }
  /** R11-02: validate a snapshot without applying it (existence, integrity and schema). */
  static validateSnapshot(statePath: string, snapshotPath: string): { bytes: number } {
    if (!existsSync(snapshotPath)) throw new StoreRecoveryError('snapshot_invalid', `Snapshot ${snapshotPath} does not exist`, statePath)
    const probe = new DatabaseSync(snapshotPath, { readOnly: true })
    try {
      const check = probe.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown }
      if (check?.integrity_check !== 'ok') throw new StoreRecoveryError('snapshot_invalid', `Snapshot ${snapshotPath} failed integrity_check: ${String(check?.integrity_check)}`, statePath)
      const version = probe.prepare('PRAGMA user_version').get()?.user_version
      if (version !== 0 && version !== 1 && version !== 2 && version !== SCHEMA_VERSION) throw new StoreRecoveryError('snapshot_invalid', `Snapshot ${snapshotPath} has unsupported schema ${String(version)}; expected ${SCHEMA_VERSION}`, statePath)
    } catch (error) {
      if (error instanceof StoreRecoveryError) throw error
      throw new StoreRecoveryError('snapshot_invalid', `Snapshot ${snapshotPath} is not a usable database: ${error instanceof Error ? error.message : String(error)}`, statePath)
    } finally { probe.close() }
    return { bytes: statSync(snapshotPath).size }
  }
  /** The newest snapshot for `statePath`, for the owner restore path. */
  static latestSnapshot(statePath: string, snapshotDir = `${statePath}.snapshots`): string | undefined {
    let names: string[]
    try { names = readdirSync(snapshotDir).filter(name => name.endsWith(SNAPSHOT_SUFFIX)).sort() } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
    return names.length ? join(snapshotDir, names.at(-1)!) : undefined
  }
  /**
   * Close the database before releasing its exclusive runtime lock. A best-effort
   * checkpoint truncates the WAL so a clean shutdown leaves no growth behind; the
   * running policy is `wal_autocheckpoint=1000` pages with a 64 MiB journal limit.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.snapshotTimer) clearInterval(this.snapshotTimer)
    this.publish()
    this.listeners.clear()
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* Another reader may still hold the WAL; the next open recovers it. */ }
    this.db.close()
    this.releaseLock()
  }
}

/** R11-02: a staged owner restore request, applied by the plugin composition at the next host start. */
export interface PendingRestore {
  snapshot: string
  requestedAt: number
  requestedBy?: string
  appliedAt?: number
}
const RESTORE_REQUEST_SUFFIX = '.restore.json'
/**
 * R11-02 owner restore path (staging half). Validate a snapshot inside the
 * managed directory and record one request for the next host start. A live
 * runtime keeps ownership: applying is deliberately impossible while the store
 * is open, so the model surface can request a restore but never swap the
 * database under a running mission.
 */
export function stageRestore(statePath: string, snapshotPath: string, requestedBy?: string, snapshotDir = `${statePath}.snapshots`): PendingRestore {
  const dir = resolve(snapshotDir)
  const file = resolve(snapshotPath)
  if (dirname(file) !== dir || !basename(file).endsWith(SNAPSHOT_SUFFIX)) {
    throw new StoreRecoveryError('snapshot_invalid', `Snapshot ${snapshotPath} is not inside the managed snapshot directory ${dir}`, statePath)
  }
  SwarmStore.validateSnapshot(statePath, file)
  const request: PendingRestore = { snapshot: basename(file), requestedAt: Date.now(), ...(requestedBy === undefined ? {} : { requestedBy }) }
  const target = `${statePath}${RESTORE_REQUEST_SUFFIX}`
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const staging = `${target}.${randomUUID()}.tmp`
  writeFileSync(staging, JSON.stringify(request), { mode: 0o600 })
  renameSync(staging, target)
  return request
}
/** Read one staged restore request, if present. A malformed request fails closed. */
export function pendingRestore(statePath: string, _snapshotDir = `${statePath}.snapshots`): PendingRestore | undefined {
  try {
    const parsed = JSON.parse(readFileSync(`${statePath}${RESTORE_REQUEST_SUFFIX}`, 'utf8')) as Partial<PendingRestore>
    if (typeof parsed.snapshot !== 'string' || !parsed.snapshot.endsWith(SNAPSHOT_SUFFIX) || basename(parsed.snapshot) !== parsed.snapshot) {
      throw new StoreRecoveryError('snapshot_invalid', `Restore request for ${statePath} names an invalid snapshot; inspect ${statePath}${RESTORE_REQUEST_SUFFIX}`, statePath)
    }
    return { snapshot: parsed.snapshot, requestedAt: typeof parsed.requestedAt === 'number' ? parsed.requestedAt : 0, ...(typeof parsed.requestedBy === 'string' ? { requestedBy: parsed.requestedBy } : {}) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof StoreRecoveryError) throw error
    throw new StoreRecoveryError('snapshot_invalid', `Restore request for ${statePath} is unreadable: ${error instanceof Error ? error.message : String(error)}`, statePath)
  }
}
/**
 * R11-02 owner restore path (apply half). Called by `src/index.ts` before the
 * runtime opens the store, so a staged request recovers a corrupted or deleted
 * state file at the next host start. Returns the applied request, or undefined
 * when nothing was staged.
 */
export function applyPendingRestore(statePath: string, snapshotDir = `${statePath}.snapshots`): PendingRestore | undefined {
  const request = pendingRestore(statePath, snapshotDir)
  if (request === undefined) return undefined
  const applied = SwarmStore.restore(statePath, join(snapshotDir, request.snapshot))
  rmSync(`${statePath}${RESTORE_REQUEST_SUFFIX}`, { force: true })
  return { ...request, snapshot: applied.restoredFrom, appliedAt: Date.now() }
}
