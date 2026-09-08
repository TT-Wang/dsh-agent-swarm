import { useEffect, useState } from 'react'

/**
 * Lease expiry is a wall-clock fact. A live card must compare the attempt lease
 * with the current time, exactly as the runtime does at `runtime.ts:227`; a
 * historical snapshot keeps its recorded reference so an old mission does not
 * render every attempt as expired.
 */
export function leaseExpired(leaseUntil: number, reference: number): boolean {
  return leaseUntil < reference
}

/** Ticking wall clock for live lease markers; the interval is idle for historical cards. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}
