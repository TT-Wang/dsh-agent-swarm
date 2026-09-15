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

/** A local presentation clock; hidden documents never keep an interval alive. */
export function useVisibleClock(active: boolean, intervalMs = 1000): { now: number; visible: boolean } {
  const [now, setNow] = useState(() => Date.now())
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  useEffect(() => {
    if (typeof document === 'undefined') return
    const update = () => setVisible(!document.hidden)
    update()
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])
  useEffect(() => {
    if (!active || !visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, visible, intervalMs])
  return { now, visible }
}
