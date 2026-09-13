import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'

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
}

/** The session list, restricted to the signal that a session surface can mount. */
interface SessionList {
  subscribe?(listener: () => void): () => void
  getSnapshot?(): { current?: string }
}

/** How long a tab that could not open yet keeps trying (30 x 500ms). */
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
  component: () => ReactNode
}

/**
 * Contribute one right-sidebar tab. Integrated as soon as the tab body is
 * registered, so the caller does not also render the standalone dock; `open()`
 * reveals the tab through the host's controller.
 */
export function createRightSidebarAdapter(ctx: Context, descriptor: () => RightSidebarDescriptor): SidebarAdapter {
  const listeners = new Set<() => void>()
  let disposed = false
  let registered = 0
  /** The tab is registered AND the pane actually shows it; only then is the dock redundant. */
  let opened = false
  let timer: ReturnType<typeof setInterval> | undefined
  let attempts = 0
  let stopWatchingSessions: (() => void) | undefined
  const notify = () => { for (const listener of [...listeners]) listener() }
  const stopRetry = () => { if (timer !== undefined) { clearInterval(timer); timer = undefined } }
  /**
   * Expand the right pane (if it is collapsed) and select this tab. Every step
   * is best effort: the layout service is optional, and the controller refuses a
   * write while no session surface is mounted — the host's own answer on a page
   * that has not opened a conversation yet. A refusal is "not yet", so it stays
   * contained here and the caller schedules another attempt.
   */
  const reveal = (): boolean => {
    const tab = descriptor()
    const layout = ctx.get('layout') as unknown as LayoutReveal | undefined
    try { layout?.openRightbar?.(true, false) } catch { /* Layout optional; the tab still opens below. */ }
    try {
      const controller = ctx.get('sidebarRight') as unknown as RightSidebarController | undefined
      if (controller === undefined || typeof controller.openTab !== 'function') return false
      controller.openTab(tab.kind, { revealIfOpened: true })
      return true
    } catch { return false }
  }
  const attempt = (): boolean => {
    if (disposed || opened) return true
    if (!reveal()) return false
    opened = true
    stopRetry()
    notify()
    return true
  }
  /** Try now; if the host has no session surface yet, keep trying for a bounded
   * while instead of leaving a registered tab that nobody can see. */
  const scheduleReveal = () => {
    if (disposed || opened || attempt()) return
    if (timer !== undefined) return
    timer = setInterval(() => {
      attempts += 1
      if (attempt() || attempts >= REVEAL_ATTEMPTS) stopRetry()
    }, REVEAL_INTERVAL_MS)
  }
  // Both services are required, and they are required together: the registry is
  // the host fact that a right sidebar exists, and asking for it in the same
  // injection is what keeps this adapter from claiming seats on a host whose
  // slot tree has no right pane (0.1.2/0.1.3 declare neither service, and a
  // registration into an undeclared slot would otherwise look like success and
  // hide the dock the panel still needs).
  const dependency = ctx.inject(['slots', 'sidebarRightTabs'], ready => ready.effect(() => {
    if (disposed) return () => {}
    const slots = ready.get('slots') as unknown as SlotRegistrar | undefined
    const registry = ready.get('sidebarRightTabs') as unknown as RightTabRegistry | undefined
    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return () => {}
    if (registry === undefined || typeof registry.register !== 'function') return () => {}
    const tab = descriptor()
    const releaseType = registry.register({
      id: tab.id, kind: tab.kind, title: () => tab.label(),
      // The guide is the only route to a page type from the UI, so the panel
      // names itself there instead of staying a registration nobody can pick.
      guide: [{ order: tab.order ?? 80, title: () => tab.label(), ...(tab.description === undefined ? {} : { description: tab.description }) }],
    })
    // The body and its chip title share the registry id as the seat key. The
    // title seat is optional (the chip falls back to the captured title), so the
    // panel registers its own name and stays independent of copy timing.
    const releaseBody = slots.inject('sidebar.right.pane.tab', () => slots.register({ name: 'sidebar.right.pane.tab', key: tab.id }, () => tab.component()))
    registered += 1
    notify()
    // OWNER PASS: the host starts with an empty right pane, so a registered tab
    // that nobody opens is invisible — the panel had no affordance at all until
    // the owner knew the New tab -> Start -> Agent Swarm path. Open it as soon as
    // a session surface exists, the way the shipped Files pane appears, and keep
    // the command and card paths working through open(). Until the pane really
    // shows it, `opened` stays false and the standalone dock keeps carrying the
    // panel, so a host that never mounts a session surface still shows something.
    attempts = 0
    scheduleReveal()
    return () => {
      registered -= 1
      releaseBody()
      releaseType()
      notify()
    }
  }, 'agent-swarm: right sidebar tab'))
  // A session surface mounts when a conversation reaches the screen, and that is
  // the host signal that the refused write may now land. Being resumed from a
  // session is worth a fresh budget of attempts; the adapter still opens the tab
  // at most once per page load.
  const sessions = (ctx as { sessions?: { list?: SessionList } }).sessions?.list
  if (typeof sessions?.subscribe === 'function') {
    try {
      stopWatchingSessions = sessions.subscribe(() => {
        if (disposed || opened) return
        attempts = 0
        scheduleReveal()
      })
    } catch { stopWatchingSessions = undefined }
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    stopRetry()
    stopWatchingSessions?.()
    stopWatchingSessions = undefined
    void dependency.dispose()
    listeners.clear()
  }
  ctx.effect(() => dispose, 'agent-swarm: right sidebar adapter')
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => registered > 0 && opened,
    open() {
      if (registered === 0) return false
      // Revealing is best effort: the tab exists either way, and the host's own
      // Tab control opens the pane when no controller is mounted. An already
      // integrated tab is re-opened here (a user gesture that closed it must be
      // able to bring it back); otherwise the bounded schedule takes over, and
      // while the pane is not showing the tab this reports not-integrated, so the
      // dock keeps the panel reachable and the caller can fall back to it.
      attempts = 0
      if (opened) opened = reveal()
      scheduleReveal()
      return opened
    },
    dispose,
  }
}
