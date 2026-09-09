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
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AutoStart, Delivery, DraftPlan, Evidence, Member, Mission, Post, PostKind, SwarmEvent, Task, ToolRun, Workstream } from './types.ts'
import type { AdmissionReason, AdmissionRecord, LimitRule } from './scheduler.ts'

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
}
export type Table = keyof Tables
const TABLES: Table[] = ['missions', 'members', 'workstreams', 'tasks', 'evidence', 'tool_runs', 'deliveries', 'drafts', 'starts', 'admissions', 'limits']
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
/** Bounds WAL growth between checkpoints; a checkpoint runs automatically every 1000 pages. */
const WAL_AUTOCHECKPOINT_PAGES = 1000
const WAL_JOURNAL_SIZE_LIMIT = 64 * 1024 * 1024
/** Tuning for the single-writer boundary; tests and the load harness shorten it. */
export interface StoreOptions {
  /** How long SQLite waits for a competing writer before raising SQLITE_BUSY. */
  busyTimeoutMs?: number
  /** Bounded retries after a classified SQLITE_BUSY. */
  writerAttempts?: number
  /** Backoff between writer retries, multiplied by the attempt number. */
  writerDelayMs?: number
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
  private closed = false
  private transactionScopes?: Set<string>
  private readonly listeners = new Set<() => void>()
  constructor(path: string, options: StoreOptions = {}) {
    this.busyTimeoutMs = Math.max(0, Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS))
    this.writerAttempts = Math.max(1, Math.trunc(options.writerAttempts ?? DEFAULT_WRITER_ATTEMPTS))
    this.writerDelayMs = Math.max(0, Math.trunc(options.writerDelayMs ?? DEFAULT_WRITER_DELAY_MS))
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.lockPath = `${path}.lock`
    this.acquireLock()
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
    } catch (error) { this.releaseLock(); throw error }
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
    return row ? this.parse<T>(String(row.value), id) : undefined
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
    return rows.map(row => this.parse<T>(String(row.value)))
  }
  /** Write a detached record inside its caller's transaction. */
  put<T extends Table>(table: T, value: Tables[T]): void {
    const missionId = 'missionId' in value && value.missionId !== undefined ? value.missionId : value.id
    const statement = this.db.prepare(`INSERT INTO ${table}(id,mission_id,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET mission_id=excluded.mission_id,value=excluded.value`)
    withWriterRetry(() => statement.run(value.id, missionId, JSON.stringify(value)), { attempts: this.writerAttempts, delayMs: this.writerDelayMs })
    this.transactionScopes?.add(missionId)
    if ('ownerSessionId' in value) this.transactionScopes?.add(value.ownerSessionId)
    if ('sessionId' in value) this.transactionScopes?.add(value.sessionId)
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
  /**
   * Close the database before releasing its exclusive runtime lock. A best-effort
   * checkpoint truncates the WAL so a clean shutdown leaves no growth behind; the
   * running policy is `wal_autocheckpoint=1000` pages with a 64 MiB journal limit.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.publish()
    this.listeners.clear()
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch { /* Another reader may still hold the WAL; the next open recovers it. */ }
    this.db.close()
    this.releaseLock()
  }
}
