/**
 * The kernel every seam stands on, and the scheduling pass record with its
 * stamps: a seam reads the store, the clock and the bounds, commits and queues
 * through `Kernel`, and stamps a pass body it awaits for without importing the
 * sweep.
 */
import type { AdapterView, Board, Bounds } from './board.ts'
import type { SwarmStore } from './store.ts'
import type { Mission, RuntimeConfig, Task, WorkerAdapter } from './types.ts'

/**
 * The infrastructure `SwarmRuntime` implements and hands each seam as itself:
 * the store and the transaction funnel over it, the runtime clock, the adapter,
 * the mission queue, the lifecycle flags and the declared bounds. `bounds` is
 * read from the live config on every read, never a snapshot, because a config
 * can change after construction. `boardOf` is one mission's board as the store
 * holds it now, the value every decision reads where it decides, and `view` the
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
  readonly workers: WorkerAdapter
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
  defer(fn: () => Promise<void>): void
  exclusive<T>(missionId: string, fn: () => Promise<T>): Promise<T>
  kick(missionId: string, after?: SchedulingPass): void
  mission(missionId: string): Mission
  task(missionId: string, taskId: string): Task
  isWorkerSession(sessionId: string): boolean
  fingerprint(missionId: string): string
}

/**
 * The scheduling body that is queued or running for one mission. `openPass`
 * (called by `kick`) records it before the body is queued on the mission's
 * serial queue (`SwarmRuntime.exclusive`), and `closePass` removes it when the
 * body settles, so at most one scheduling body per mission is queued or running.
 * It is in-memory on purpose: it describes an operation this process owns, and
 * a restarted process owns none. The durable row it replaces never gated or
 * named anything after a restart either (it carried the dead process's
 * instance id).
 *
 * Why no release and no fence: the queue is strictly serial and a waiter past
 * its bound is refused, never run (`boundedQueueWait`), so a successor body
 * cannot start until this body settles; a wedged body can never write after its
 * successor starts. The watchdog therefore only names a body past its bound
 * (`checkSchedulingPasses`) and marks the mission wedged for notices; the body
 * itself ends at the bound of whichever await it is in (`workerStartTimeoutMs`,
 * the per-attempt delivery bound, each git subprocess's `HOST_GIT_TIMEOUT_MS`),
 * and a member that held it for a whole bound makes it stop at the next member
 * boundary so the next body resumes from lease recovery (`dispatch`).
 */
export interface SchedulingPass {
  /** The mission's stable pass name (`pass_<missionId>`), named by the stall event and the owner notice. */
  id: string
  /** This body's identity; the stall event and the owner notice name it as the run. */
  operationId: string
  missionId: string
  startedAt: number
  /** Store revision and mission digest when the pass was opened. */
  revisionBefore: number
  fingerprintBefore: string
  /** Set once this body's naming fact is on the deliveries ledger, written by its own naming or already held (`escalateWedge`); it is then wedged, not live. */
  escalatedAt?: number
  /**
   * The body's own last progress: when one of its own awaits returned (stamped
   * before it commits the result) or it reached a member boundary (`progressed`).
   * A call that commits before its promise settles stamps the record the body
   * handed it at the instant its adapter call settles, before that commit: the
   * worker start (`SwarmRuntime.startWorker`), the workspace authorization
   * check and the preparation's recovery-fallback report. Only the body's own
   * record is stamped, so a worker turn one of its adapter calls woke commits
   * without crediting the body; progress proves the body is running, not
   * sitting in an await (`passState`).
   */
  progressAt?: number
  /**
   * The member whose task this body is preparing, while its `prepareTask` await
   * is in flight: the adapter's recovery-fallback report, committed from inside
   * that call, stamps the body's progress first (`SwarmRuntime.onRecoveryFallback`).
   */
  preparing?: string
  /** The member this body's sweep starts from: the one its predecessor stopped before. */
  sweepFrom?: string
  /**
   * The member where the chain of early-stopped bodies this body belongs to
   * started. A chained body's sweep ends before it, so the chain covers at most
   * one rotation and its last body runs the pass-end steps.
   */
  chainFrom?: string
  /** Set when this body stopped early at a member boundary: the first member it did not sweep. */
  stoppedBefore?: string
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
