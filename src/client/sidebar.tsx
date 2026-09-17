import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import { currentSessionId } from './navigation.ts'

/** Public Better Sidebar 0.18 service subset. Kept structural so an optional
 * client integration does not pull its newer Harness peers into this plugin.
 * Source: dsh-better-sidebar/client/service (TabDescriptor / BetterSidebarService).
 */
export interface SidebarScope {
  sessionId: string
  cwd?: string
}

export interface SidebarTabProps {
  scope: SidebarScope
  /** Better Sidebar keeps inactive tabs mounted; the view should pause polling. */
  visible: boolean
}

export interface SidebarTabDescriptor {
  id: string
  title: string | (() => string)
  single?: boolean
  order?: number
  icon?: ReactNode | ((size: number) => ReactNode)
  component: (props: SidebarTabProps) => ReactNode
  createTab?: (state: SidebarState) => { tab: SidebarTab; patch?: { panelOpen?: boolean; bottomOpen?: boolean } }
}

interface SidebarTab { id: string; type: string; title: string }
interface SidebarPane { id: string; tabs?: readonly SidebarTab[]; children?: readonly SidebarPane[] }
interface SidebarState {
  activePane: string | null
  splits: SidebarPane
  bottomSplits: SidebarPane
  floats: readonly { tab: SidebarTab }[]
}

interface BetterSidebar {
  registerTab(descriptor: SidebarTabDescriptor): () => void
  openTab(seed: { type: string }): void
  getSnapshot?(): { state?: SidebarState }
}

export interface SidebarAdapter {
  subscribe(listener: () => void): () => void
  getSnapshot(): boolean
  /** Focus and reveal the registered tab through the host's public descriptor. */
  open(): boolean
  dispose(): void
}

function inTree(node: SidebarPane, predicate: (node: SidebarPane) => boolean): boolean {
  return predicate(node) || (node.children?.some(child => inTree(child, predicate)) ?? false)
}

/** Public createTab patches let type-only opens reveal their owning pane.
 * Existing tabs stay where the user placed them. Better Sidebar 0.18 merges
 * both workbenches into the right drawer below its documented 768px breakpoint.
 */
function revealedDescriptor(descriptor: SidebarTabDescriptor, service: BetterSidebar): SidebarTabDescriptor {
  return { ...descriptor, createTab: state => {
    const tab = { id: descriptor.id, type: descriptor.id, title: typeof descriptor.title === 'function' ? descriptor.title() : descriptor.title }
    // Targeted opens in another session must not change the current viewer's panels.
    if (service.getSnapshot && service.getSnapshot().state !== state) return { tab }
    if (state.floats.some(window => window.tab.type === descriptor.id)) return { tab }
    if (typeof window !== 'undefined' && window.innerWidth < 768) return { tab, patch: { panelOpen: true } }
    const ownsTab = (pane: SidebarPane) => pane.tabs?.some(item => item.type === descriptor.id) ?? false
    const alreadyRight = inTree(state.splits, ownsTab)
    const inBottom = inTree(state.bottomSplits, ownsTab) || (!alreadyRight && inTree(state.bottomSplits, pane => pane.id === state.activePane))
    return { tab, patch: inBottom ? { bottomOpen: true } : { panelOpen: true } }
  } }
}

/** Contribute a tab only while the optional sidebar service is present.
 * Registration follows Cordis service replacement and unload; subscribers can
 * hand layout ownership back to the standalone dock when the service leaves.
 * The descriptor receives the sidebar's exact scope, including pinned tabs.
 */
export function createSidebarAdapter(ctx: Context, descriptor: () => SidebarTabDescriptor): SidebarAdapter {
  const listeners = new Set<() => void>()
  let disposed = false
  let current: { service: BetterSidebar; id: string; release: () => void } | undefined
  const notify = () => { for (const listener of [...listeners]) listener() }
  const dependency = ctx.inject(['betterSidebar'], ready => {
    ready.effect(() => {
      if (disposed) return () => {}
      const service = ready.get('betterSidebar') as BetterSidebar | undefined
      if (typeof service?.registerTab !== 'function' || typeof service.openTab !== 'function') return () => {}
      const tab = revealedDescriptor(descriptor(), service)
      const unregister = service.registerTab(tab)
      let released = false
      const entry = {
        service,
        id: tab.id,
        release: () => {
          if (released) return
          released = true
          try { unregister() } finally {
            if (current === entry) {
              current = undefined
              notify()
            }
          }
        },
      }
      current = entry
      notify()
      return entry.release
    }, 'agent-swarm: Better Sidebar tab')
  })
  const dispose = () => {
    if (disposed) return
    disposed = true
    current?.release()
    void dependency.dispose()
    listeners.clear()
  }
  ctx.effect(() => dispose, 'agent-swarm: Better Sidebar adapter')
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => current !== undefined,
    open() {
      if (current === undefined) return false
      current.service.openTab({ type: current.id })
      return true
    },
    dispose,
  }
}

/* ------------------------------------------------------------------------- *
 * The host's right sidebar (the 0.1.5 line).
 *
 * The Files pane and this panel are the same mechanism: a tab TYPE registered
 * with the `sidebarRightTabs` registry (id, kind, and the title its chip shows),
 * the panel BODY in the keyed `sidebar.right.pane.tab` seat under that id, and
 * navigation through the `sidebarRight` controller (`openTab(kind)`). Nothing
 * here imports the sidebar package: the ids, keys and slot names are structural,
 * so 0.1.2/0.1.3 — which have no right sidebar — simply never fire these injects
 * and the standalone dock keeps carrying the surface.
 * ------------------------------------------------------------------------- */

/** The slot service, restricted to what this adapter uses. */
interface SlotRegistrar {
  inject(name: string, factory: () => (() => void) | void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/**
 * One capsule on the right sidebar's guide page — the Start tab's list of what a
 * pane can open. Without it a registered type is invisible: the guide is how a
 * user reaches a page type that recognizes no resource address.
 */
export interface RightSidebarGuideEntry {
  /** Stable within the tab type; 0.1.6 requires it and rejects duplicates. */
  id: string
  order: number
  title: () => string
  description?: () => string
}

/** The right-sidebar tab registry. */
interface RightTabRegistry {
  register(definition: {
    id: string
    kind: string
    title: (address: string) => string
    guide?: readonly RightSidebarGuideEntry[]
  }): () => void
}

/**
 * The right-sidebar navigation controller. `openTab` is a WRITE and the host
 * answers a write with no mounted session surface by throwing
 * (`sidebarRight: no session surface is mounted`), so every call here is a
 * best-effort attempt that may have to be repeated once a conversation is on
 * screen.
 */
interface RightSidebarController {
  openTab(kind: string, options?: Record<string, unknown>): void
  /** 0.1.5+: open for one session; a no-op (not a throw) until that session's surface exists. */
  openTabIn?(sessionId: string, kind: string, options?: Record<string, unknown>): void
}

/** The session list, restricted to the signal that a session surface can mount. */
interface SessionList {
  subscribe?(listener: () => void): () => void
  getSnapshot?(): { current?: string }
}

/** How long a tab that could not open yet keeps trying (60 x 500ms). */
const REVEAL_ATTEMPTS = 60
const REVEAL_INTERVAL_MS = 500

/** The layout service, restricted to revealing the right pane. */
interface LayoutReveal {
  openRightbar?(track: boolean, fullscreen: boolean): void
}

export interface RightSidebarDescriptor {
  /** Registry id: also the key both seats register under. */
  id: string
  /** Tab kind `openTab` names. */
  kind: string
  label: () => string
  /** One line under the guide capsule's title. */
  description?: () => string
  /** Ascending order on the guide page. */
  order?: number
  component: (props: SidebarTabProps) => ReactNode
}

/** The host binds these standard session props and the tab hook at the body seat.
 * Kept structural so earlier supported releases need no sidebar-right import. */
interface RightSidebarBodyProps {
  sessionId: string
  useTabInfo(): { tab: { visible: boolean } }
}

/**
 * Contribute one right-sidebar tab. Integration requires a successful reveal
 * through the current provider; until then the caller retains its fallback.
 * The body projects the host tab's session and visibility into the monitor.
 */
export function createRightSidebarAdapter(ctx: Context, descriptor: () => RightSidebarDescriptor): SidebarAdapter {
  const listeners = new Set<() => void>()
  let disposed = false
  let current: {
    opened: boolean
    scheduleReveal(reset?: boolean): void
    open(): boolean
    release(): void
  } | undefined
  const notify = () => { for (const listener of [...listeners]) listener() }
  // A navigation success belongs to this registry AND controller lifetime.
  // Replacing either service must release the previous reveal and retry state.
  const dependency = ctx.inject(['slots', 'sidebarRightTabs', 'sidebarRight'], ready => ready.effect(() => {
    if (disposed) return () => {}
    const slots = ready.get('slots') as unknown as SlotRegistrar | undefined
    const registry = ready.get('sidebarRightTabs') as unknown as RightTabRegistry | undefined
    const controller = ready.get('sidebarRight') as unknown as RightSidebarController | undefined
    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return () => {}
    if (registry === undefined || typeof registry.register !== 'function' || typeof controller?.openTab !== 'function') return () => {}
    const tab = descriptor()
    const releaseType = registry.register({
      id: tab.id, kind: tab.kind, title: () => tab.label(),
      guide: [{ id: 'open', order: tab.order ?? 80, title: () => tab.label(), ...(tab.description === undefined ? {} : { description: tab.description }) }],
    })
    let releaseBody: () => void
    try {
      releaseBody = slots.inject('sidebar.right.pane.tab', () => slots.register({ name: 'sidebar.right.pane.tab', key: tab.id },
        function SwarmTabBody({ sessionId, useTabInfo }: RightSidebarBodyProps) {
          const { tab: info } = useTabInfo()
          return tab.component({ scope: { sessionId }, visible: info.visible })
        }))
    } catch (error) { releaseType(); throw error }
    let timer: ReturnType<typeof setInterval> | undefined
    let attempts = 0
    let released = false
    const stopRetry = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined } }
    const live = () => !disposed && !released && current === entry
    const reveal = (): boolean => {
      if (!live()) return false
      try {
        const layout = ready.get('layout') as unknown as LayoutReveal | undefined
        layout?.openRightbar?.(true, false)
      } catch { /* Layout optional; the tab still opens below. */ }
      // openTab throws until a session surface is mounted; openTabIn addresses the session the main view
      // shows and merely no-ops while its surface is still being minted, so try it first.
      if (typeof controller.openTabIn === 'function') {
        let sessionId: string | undefined
        try { const sessions = ready.get('sessions') as Context['sessions'] | undefined; if (sessions !== undefined) sessionId = currentSessionId(sessions) } catch { /* No sessions face: openTab decides. */ }
        if (sessionId !== undefined) {
          try { controller.openTabIn(sessionId, tab.kind, { revealIfOpened: true }); return true } catch { /* Fall through to openTab. */ }
        }
      }
      try { controller.openTab(tab.kind, { revealIfOpened: true }); return true }
      catch { return false }
    }
    const attempt = (): boolean => {
      if (!live() || entry.opened) return true
      if (!reveal()) return false
      entry.opened = true
      stopRetry()
      notify()
      return true
    }
    const entry: NonNullable<typeof current> = {
      opened: false,
      scheduleReveal(reset = false) {
        if (!live() || entry.opened) return
        if (reset) attempts = 0
        if (attempt() || timer !== undefined) return
        timer = setInterval(() => {
          attempts += 1
          if (attempt() || attempts >= REVEAL_ATTEMPTS) stopRetry()
        }, REVEAL_INTERVAL_MS)
      },
      open() {
        if (!live()) return false
        if (entry.opened) {
          entry.opened = reveal()
          if (!entry.opened) notify()
        }
        entry.scheduleReveal(true)
        return entry.opened
      },
      release() {
        if (released) return
        released = true
        stopRetry()
        entry.opened = false
        if (current === entry) { current = undefined; notify() }
        try { releaseBody() } finally { releaseType() }
      },
    }
    current = entry
    entry.scheduleReveal()
    return entry.release
  }, 'agent-swarm: right sidebar tab'))
  // Only a live provider owns a retry budget. Session notifications on older
  // hosts or during provider removal cannot start orphan reveal loops.
  const sessions = (ctx as { sessions?: { list?: SessionList } }).sessions?.list
  let stopWatchingSessions: (() => void) | undefined
  if (typeof sessions?.subscribe === 'function') {
    try { stopWatchingSessions = sessions.subscribe(() => current?.scheduleReveal(true)) }
    catch { stopWatchingSessions = undefined }
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    stopWatchingSessions?.()
    stopWatchingSessions = undefined
    current?.release()
    void dependency.dispose()
    listeners.clear()
  }
  ctx.effect(() => dispose, 'agent-swarm: right sidebar adapter')
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => current?.opened ?? false,
    open: () => current?.open() ?? false,
    dispose,
  }
}
