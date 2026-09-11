/**
 * Lifecycle registry for pane-owned client resources (2026-09-11 review, C2).
 *
 * A React render may construct a component instance and discard it before it
 * ever commits — StrictMode's double render is the everyday case — so unmount
 * alone cannot dispose everything a render created: the discarded probe never
 * runs an effect, and its instance is unreachable. Every pane resource is
 * therefore registered here, released on unmount, and the plugin scope drains
 * whatever is left when it unloads. Consequences the tests pin:
 *
 *  - a resource is disposed exactly once, however it is reached (unmount,
 *    re-created dependency, or plugin unload) — `dispose()` is idempotent here;
 *  - a resource created after the drain is disposed immediately, so a pane that
 *    mounts during unload cannot leave a poller behind;
 *  - nothing in this file starts work: registration is bookkeeping only.
 */
export interface Disposable { dispose(): void }
export class DisposalRegistry {
  private items = new Set<Disposable>()
  private closed = false
  /** Register a resource; after the drain it is disposed at once and never retained. */
  add<T extends Disposable>(item: T): T {
    if (this.closed) item.dispose()
    else this.items.add(item)
    return item
  }
  /** Dispose one resource; releasing twice, or releasing an unregistered one, is a no-op. */
  release(item: Disposable): void { if (this.items.delete(item)) item.dispose() }
  /** Dispose every registered resource; idempotent, and later `add` calls dispose themselves. */
  dispose(): void {
    this.closed = true
    for (const item of [...this.items]) { this.items.delete(item); item.dispose() }
  }
  /** Resources still registered, for diagnostics and tests. */
  get size(): number { return this.items.size }
  /** Whether the registry has been drained; further registrations dispose immediately. */
  get drained(): boolean { return this.closed }
}
