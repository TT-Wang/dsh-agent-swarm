/**
 * The kernel every seam stands on, and the stamps a scheduling body puts on its
 * record (`SchedulingPass`, src/board.ts): a seam reads the store, the clock
 * and the bounds, commits and queues through `Kernel`, and stamps a pass body
 * it awaits for without importing the sweep.
 */
import type { AdapterView, Board, Bounds, SchedulingPass } from './board.ts'
import type { RevisedTable, SwarmStore, Tables } from './store.ts'
import type { Mission, RuntimeConfig, Task, WorkerAdapter } from './types.ts'

/**
 * The infrastructure `SwarmRuntime` implements and hands each seam as itself:
 * the store and the transaction funnel over it, the runtime clock, the adapter,
 * the mission queue, the lifecycle flags and the declared bounds. `bounds` is
 * read from the live config on every read, never a snapshot, because a config
 * can change after construction. `boardOf` is one mission's board as the store
 * holds it now, with the scheduling body queued or running for it
 * (`Board.pass`), the value every decision reads where it decides, and `view` the
 * adapter answers it asks, called through on every ask. `fingerprint` is F(S),
 * the board digest the owner instruments and the stall events carry: the digest
 * of `boardOf`'s board (`fingerprintBoard`, a board function), cached by the
 * kernel at one digest per store revision and never trusted inside an open
 * transaction (`commitDepth`). Readiness asks the adapter's idleness and the
 * clock, so a cached digest answers for the instant its revision was first read.
 */
export interface Kernel {
  readonly store: SwarmStore
  readonly config: RuntimeConfig
  /** The adapter's commands. Its two questions, `isIdle` and `currentActivity`, are asked through `view` alone. */
  readonly workers: Omit<WorkerAdapter, 'isIdle' | 'currentActivity'>
  readonly now: () => number
  readonly closed: boolean
  readonly shuttingDown: boolean
  /** Open runtime transactions. */
  readonly commitDepth: number
  /** This process's identity in durable claims: a claim another instance wrote never gates this one. */
  readonly instanceId: string
  readonly bounds: Bounds
  readonly view: AdapterView
  boardOf(missionId: string): Board
  commit<T>(missionId: string, fn: () => T): T
  /**
   * CORE-06: the one write of a row by a transition that awaited after it read
   * that row: the row as this commit reads it, re-validated by `change` (see
   * `SwarmRuntime.revise`). Undefined when the transition was moot.
   */
  revise<T extends RevisedTable>(missionId: string, table: T, rowId: string, change: (current: Tables[T]) => boolean | void, effects?: (written: Tables[T]) => void): Tables[T] | undefined
  defer(fn: () => Promise<void>): void
  exclusive<T>(missionId: string, fn: () => Promise<T>): Promise<T>
  kick(missionId: string, after?: SchedulingPass): void
  mission(missionId: string): Mission
  /** A caller's task id, refused where it enters, or the re-read of a row the call holds; an id a stored row holds for another task is read through `boardOf(missionId).graph` (an assignment delivery's, by `assignmentCurrent`). */
  task(missionId: string, taskId: string): Task
  isWorkerSession(sessionId: string): boolean
  fingerprint(missionId: string): string
}

/**
 * A scheduling body's own progress stamp (`SchedulingPass.progressAt`). The body
 * calls it itself, with the record `kick` handed it, when it starts, at each
 * member boundary and when one of its own awaits returns (`awaited`). A call
 * that commits before its promise settles is handed the record and stamps it
 * where its adapter work settles, before that commit (`SchedulingPass.progressAt`).
 * Nothing else stamps it: commits made by a worker turn the body woke inside an
 * adapter call are that turn's, not the body's. Without a record (a direct
 * `schedule` or `dispatch` call) it does nothing.
 */
export function progressed(pass: SchedulingPass | undefined, now: number): void {
  if (pass !== undefined) pass.progressAt = now
}

/**
 * One of a scheduling body's own awaits: `work` settles, the body stamps its
 * progress (`progressed`), and only then does it act on the result, so the
 * commit of that result publishes as a running body's.
 */
export function awaited<T>(pass: SchedulingPass | undefined, work: Promise<T>, now: () => number): Promise<T> {
  return pass === undefined ? work : work.finally(() => progressed(pass, now()))
}

/** Human form of an elapsed bound for a notice; the raw milliseconds stay on the witness. */
export function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
