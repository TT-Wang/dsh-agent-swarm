/**
 * The board every decision reads, and the declared bounds it is judged against.
 */
import type { RuntimeConfig } from './types.ts'

/**
 * S1: the bound on one scheduling pass before the runtime names it wedged, in
 * `tickMs` (RuntimeConfig.`stallPassTimeoutMs`), never a constant a wedged pass
 * can be trapped behind.
 */
const DEFAULT_STALL_PASS_TIMEOUT_TICKS = 30
/**
 * R16-D: the additional declared window a wedged scheduling pass stays live
 * (unnamed) while the mission still has live work, in pass bounds. The default
 * is the pass bound itself (so a wedge is named after at most 2 ×
 * `stallPassTimeoutMs`), and it is configuration: `stallPassLiveGraceMs`, `0`
 * meaning "name it at the first bound". Without it the naming was unbounded: a
 * wedged pass waited for every unrelated lease to lapse, exactly the silent
 * blocking round 16 removes.
 */
const DEFAULT_STALL_PASS_LIVE_GRACE_TICKS = 1
/**
 * R16-D: the declared bound on how long a live attempt may record no durable
 * progress before the runtime escalates it by name (`attempt-silent:`). The
 * default matches the longest wait this host itself treats as bounded (F1's
 * operation bound, the harness's 600 s `maxWaitTimeoutMs`): an attempt that
 * has recorded nothing at all for that long is past the point where a live lease
 * can still be read as progress.
 */
const DEFAULT_ATTEMPT_SILENCE_BOUND_MS = 10 * 60_000
/**
 * F1: the declared bound on how long one in-flight operation may hold an
 * attempt without recording anything. Inside the bound an operation is
 * plausibly bounded (a long build, a declared check, one generation) and the
 * lease-renewal rule is right; past it "bounded" stops being plausible, so the
 * operation stops counting as liveness and the owner is told exactly which
 * member, task and tool went silent. The default matches the longest wait this
 * host itself treats as bounded (the harness's `maxWaitTimeoutMs` of 600 s),
 * while an operation that declares a longer bound of its own is judged by that
 * bound instead.
 */
const DEFAULT_OPERATION_BOUND_MS = 10 * 60_000

/**
 * The declared bounds of one configuration, each a window on the runtime clock.
 * Configuration, never a constant the runtime is trapped behind: an invalid
 * value keeps the default.
 */
export interface Bounds {
  /** The tick unit every tick-derived window is measured in. */
  tickMs: number
  /** S1: how long one scheduling pass may hold its mission before it is wedged. */
  stallPassTimeoutMs: number
  /** R16-D: how much longer live work keeps a wedged pass unnamed. */
  stallPassLiveGraceMs: number
  /**
   * R16-D: the total bound a wedged pass is measured against once it has live
   * work to progress. Past it the pass is named even though the live work
   * remains: the work is preserved and named, generation is not held hostage.
   */
  stallPassReleaseBoundMs: number
  /** R16-D: how long a live attempt may record nothing durable; `0` disables the guard. */
  attemptSilenceBoundMs: number
  /** F1: how long one in-flight operation may record nothing; `0` disables the guard. */
  operationBoundMs: number
}

/** The bounds `config` declares. A caller reads them where it decides, so a config changed after construction is the one judged. */
export function bounds(config: RuntimeConfig): Bounds {
  const pass = Math.trunc(config.stallPassTimeoutMs ?? config.tickMs * DEFAULT_STALL_PASS_TIMEOUT_TICKS)
  const stallPassTimeoutMs = Number.isSafeInteger(pass) && pass >= config.tickMs ? pass : config.tickMs
  const grace = config.stallPassLiveGraceMs
  const stallPassLiveGraceMs = typeof grace === 'number' && Number.isFinite(grace) && grace >= 0 ? Math.floor(grace) : stallPassTimeoutMs * DEFAULT_STALL_PASS_LIVE_GRACE_TICKS
  return {
    tickMs: config.tickMs, stallPassTimeoutMs, stallPassLiveGraceMs, stallPassReleaseBoundMs: stallPassTimeoutMs + stallPassLiveGraceMs,
    attemptSilenceBoundMs: declaredBound(config.attemptSilenceBoundMs, DEFAULT_ATTEMPT_SILENCE_BOUND_MS),
    operationBoundMs: declaredBound(config.operationBoundMs, DEFAULT_OPERATION_BOUND_MS),
  }
}

/** A guard's declared bound: `0` disables the guard, an invalid value keeps the default rather than reverting to 0. */
function declaredBound(value: number | undefined, fallback: number): number {
  if (value === 0) return 0
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
