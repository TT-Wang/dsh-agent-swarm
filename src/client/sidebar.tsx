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
  /** Whether this provider owns the registered tab surface, independent of visibility. */
  getSnapshot(): boolean
  /** Claim an explicit reveal request; a native surface may still be mounting. */
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
 * Registration follows Cordis service replacement and unload.
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
 * The host's right sidebar.
 *
 * The Files pane and this panel are the same mechanism: a tab TYPE registered
 * with the `sidebarRightTabs` registry (id, kind, and the title its chip shows),
 * the panel BODY in the keyed `sidebar.right.pane.tab` seat under that id, and
 * navigation through the `sidebarRight` controller (`openTab(kind)`). Nothing
 * here imports the sidebar package, which is not a declared peer: the ids, keys
 * and slot names are structural, and a profile without the right sidebar never
 * fires these injects.
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
  /** Stable within the tab type; the registry requires it and rejects duplicates. */
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
}

/** How long a tab that could not open yet keeps trying (60 x 500ms). */
const REVEAL_ATTEMPTS = 60
const REVEAL_INTERVAL_MS = 500

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
  /** Persistent native navigation action, including the sessionless home. */
  launcher?: (props: { wide: boolean; onOpen(): void }) => ReactNode
}

/** The host binds these standard session props and the tab hook at the body seat.
 * Kept structural so the plugin needs no sidebar-right import. */
interface RightSidebarBodyProps {
  sessionId: string
  useTabInfo(): { tab: { visible: boolean } }
}

/**
 * Register without revealing: the native controller owns both tab navigation
 * and layout. Only an explicit open request may wait for a mounting surface.
 * The body projects the host tab's session and visibility into the monitor.
 */
export function createRightSidebarAdapter(ctx: Context, descriptor: () => RightSidebarDescriptor): SidebarAdapter {
  const listeners = new Set<() => void>()
  const sessions = (ctx as { sessions?: Context['sessions'] }).sessions
  let disposed = false
  let current: { retry(): void; open(): boolean; release(): void } | undefined
  const notify = () => { for (const listener of [...listeners]) listener() }
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
    let releaseBody: (() => void) | undefined
    let releaseLauncher: (() => void) | undefined
    try {
      releaseBody = slots.inject('sidebar.right.pane.tab', () => slots.register({ name: 'sidebar.right.pane.tab', key: tab.id },
        function SwarmTabBody({ sessionId, useTabInfo }: RightSidebarBodyProps) {
          const { tab: info } = useTabInfo()
          return tab.component({ scope: { sessionId }, visible: info.visible })
        }))
      if (tab.launcher) releaseLauncher = slots.inject('sidebar.footer.action', () => slots.register({
        name: 'sidebar.footer.action', id: `${tab.id}-launcher`, order: tab.order ?? 80,
      }, function SwarmLauncher({ wide }: { wide: boolean }) {
        return tab.launcher!({ wide, onOpen: () => { entry.open() } })
      }))
    } catch (error) { releaseLauncher?.(); releaseBody?.(); releaseType(); throw error }
    let timer: ReturnType<typeof setInterval> | undefined
    let request: { sessionId?: string } | undefined
    let attempts = 0
    let released = false
    const stopRetry = () => {
      if (timer !== undefined) { clearInterval(timer); timer = undefined }
      request = undefined
    }
    const live = () => !disposed && !released && current === entry
    const attempt = (): boolean => {
      if (!live() || request === undefined) return true
      // A late mount for a different conversation cannot inherit this reveal.
      if (request.sessionId !== undefined && request.sessionId !== currentSessionId(sessions)) {
        stopRetry()
        return true
      }
      try {
        // Public navigation throws until a seat mounts. openTabIn is an internal
        // tab action that silently no-ops before adoption, so it cannot acknowledge a reveal.
        controller.openTab(tab.kind, { revealIfOpened: true })
        stopRetry()
        return true
      } catch { return false }
    }
    const entry: NonNullable<typeof current> = {
      retry() { if (request !== undefined) attempt() },
      open() {
        if (!live()) return false
        stopRetry()
        // Global pages unmount the session surface. An explicit launch returns
        // to the current conversation; native sidebar state still owns geometry.
        const layout = ready.get('layout') as { selectPanel?(panel: null): void } | undefined
        layout?.selectPanel?.(null)
        request = { sessionId: currentSessionId(sessions) }
        attempts = 0
        if (!attempt()) timer = setInterval(() => {
          attempts += 1
          if (attempt() || attempts >= REVEAL_ATTEMPTS) stopRetry()
        }, REVEAL_INTERVAL_MS)
        // Native ownership includes this bounded pending intent. Opening a
        // fallback at the same time would create two competing side panels.
        return true
      },
      release() {
        if (released) return
        released = true
        stopRetry()
        if (current === entry) { current = undefined; notify() }
        try { releaseLauncher?.() } finally { try { releaseBody?.() } finally { releaseType() } }
      },
    }
    current = entry
    notify()
    return entry.release
  }, 'agent-swarm: right sidebar tab'))
  let stopWatchingSessions: (() => void) | undefined
  if (typeof sessions?.list?.subscribe === 'function') {
    try { stopWatchingSessions = sessions.list.subscribe(() => current?.retry()) }
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
    getSnapshot: () => current !== undefined,
    open: () => current?.open() ?? false,
    dispose,
  }
}
