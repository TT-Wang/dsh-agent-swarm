/** Transactional single-host state and outbox. SQLite commits precede notifications. */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AutoStart, Delivery, DraftPlan, Evidence, Member, Mission, SwarmEvent, Task, ToolRun, Workstream } from './types.ts'

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
}
export type Table = keyof Tables
const TABLES: Table[] = ['missions', 'members', 'workstreams', 'tasks', 'evidence', 'tool_runs', 'deliveries', 'drafts', 'starts']
const SCHEMA_VERSION = 1
/** SQLite-backed source of truth. Only one live runtime may own a state file. */
export class SwarmStore {
  private readonly db: DatabaseSync
  private readonly lockPath: string
  private readonly nonce = randomUUID()
  private closed = false
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.lockPath = `${path}.lock`
    this.acquireLock()
    try {
      this.db = new DatabaseSync(path)
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
      const version = this.db.prepare('PRAGMA user_version').get()?.user_version
      if (version !== 0 && version !== SCHEMA_VERSION) throw new Error(`Unsupported swarm schema ${String(version)}; expected ${SCHEMA_VERSION}`)
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (const table of TABLES) {
          this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, mission_id TEXT NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_mission ON ${table}(mission_id);`)
        }
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS starts_command ON starts(json_extract(value, '$.ownerSessionId'), json_extract(value, '$.commandId'))")
        this.db.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, mission_id TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS events_mission ON events(mission_id, seq);')
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
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = operation(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
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
    this.db.prepare(`INSERT INTO ${table}(id,mission_id,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET mission_id=excluded.mission_id,value=excluded.value`).run(value.id, missionId, JSON.stringify(value))
  }
  /** Append an immutable coordination event inside the same state transaction. */
  event(missionId: string, type: string, actor: string, data: unknown): void {
    this.db.prepare('INSERT INTO events(mission_id,type,actor,data,created_at) VALUES(?,?,?,?,?)').run(missionId, type, actor, JSON.stringify(data), Date.now())
  }
  /** Read chronological deltas, bounded for display and agent context. */
  events(missionId: string, limit: number, after = 0): SwarmEvent[] {
    const rows = after > 0
      ? this.db.prepare('SELECT * FROM events WHERE mission_id=? AND seq>? ORDER BY seq LIMIT ?').all(missionId, after, limit)
      : this.db.prepare('SELECT * FROM (SELECT * FROM events WHERE mission_id=? ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(missionId, limit)
    return rows.map(row => ({ seq: Number(row.seq), missionId: String(row.mission_id), type: String(row.type), actor: String(row.actor), data: JSON.parse(String(row.data)), createdAt: Number(row.created_at) }))
  }
  /** Close the database before releasing its exclusive runtime lock. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
    this.releaseLock()
  }
}
