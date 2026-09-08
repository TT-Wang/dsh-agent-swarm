/** Bounded event-driven waiting; no worker is activated by an observer. */
import type { SwarmStore } from './store.ts'

export function waitForStateChange(store: SwarmStore, after: number, visibleScopes: () => ReadonlySet<string>, signal: AbortSignal, waitMs: number, subscribeWake?: (listener: () => void) => () => void): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let finished = false
    let cursor = after
    let timer: ReturnType<typeof setTimeout> | undefined
    let unsubscribe = () => {}
    let unsubscribeWake = () => {}
    const finish = (error?: unknown) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      unsubscribe()
      unsubscribeWake()
      signal.removeEventListener('abort', abort)
      if (error !== undefined) reject(error)
      else resolve()
    }
    const abort = () => finish(signal.reason ?? new Error('Swarm watch was cancelled'))
    const inspect = () => {
      try {
        const changes = store.changesSince(cursor)
        if (changes === undefined) { finish(); return }
        const allowed = visibleScopes()
        if (changes.some(change => change.scopes.some(scope => allowed.has(scope)))) { finish(); return }
        cursor = store.revision()
      } catch (error) { finish(error) }
    }
    // Subscribe before inspecting, so a commit cannot fall between baseline and wait.
    try {
      unsubscribe = store.subscribe(inspect)
      unsubscribeWake = subscribeWake?.(() => finish()) ?? (() => {})
    } catch (error) { finish(error); return }
    signal.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => finish(), waitMs)
    if (signal.aborted) abort()
    else inspect()
  })
}
