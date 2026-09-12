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
 * The native DSH sidebar (the 0.1.5 line).
 *
 * The shell renders one rail icon per registration in the root-scoped
 * `sidebar.panellist` list, and that icon's `id` addresses the component
 * registered in the layout's root-scoped `main` keyed slot; `ctx.layout`
 * selects it (`selectPanel`). Everything below is structural on purpose: the
 * sidebar shell ships from 0.1.5, so this module has to compile and load against
 * 0.1.2/0.1.3 as well — there the injects never fire, `getSnapshot()` stays
 * false, and the standalone dock remains the surface.
 * ------------------------------------------------------------------------- */

/**
 * The host's slot service, restricted to what this adapter uses. `inject` waits
 * for a slot declaration and returns its own disposer; the callback runs inside
 * that declaration's lifetime and must register through the service (the
 * callback's argument is a Cordis scope, not the registrar — registering on it
 * fails in a microtask, which is how a panel silently never appears).
 */
interface SlotRegistrar {
  inject(name: string, factory: () => (() => void) | void): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** The subset of the host's layout service this adapter uses. */
interface NativeLayout {
  selectPanel(id: string | null): void
}

export interface NativePanelDescriptor {
  /** Panel key: the `main` entry key and the `sidebar.panellist` list id. */
  id: string
  label: () => string
  order?: number
  /** The rail icon, drawn at the size the sidebar asks for. */
  icon: (props: { size: number; active: boolean }) => ReactNode
  /** The panel body, rendered in the main column while the panel is selected. */
  component: () => ReactNode
}

/**
 * Contribute a native sidebar panel while the host provides the slots service.
 * The returned adapter reports integrated as soon as the `main` entry is
 * registered, so the caller does not render the standalone dock beside a native
 * panel; `open()` selects the panel through the layout service.
 */
export function createNativeSidebarAdapter(ctx: Context, descriptor: () => NativePanelDescriptor): SidebarAdapter {
  const listeners = new Set<() => void>()
  let disposed = false
  let registered = 0
  let panelId: string | undefined
  const notify = () => { for (const listener of [...listeners]) listener() }
  const dependency = ctx.inject(['slots'], ready => ready.effect(() => {
    if (disposed) return () => {}
    const slots = ready.get('slots') as unknown as SlotRegistrar | undefined
    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return () => {}
    const panel = descriptor()
    panelId = panel.id
    // The main entry is the panel itself; the rail entry is its button. Both ride
    // the same id, and a host that declares only one of the two slots simply
    // never runs the other inject.
    const main = slots.inject('main', () => slots.register({ name: 'main', key: panel.id }, () => panel.component()))
    const rail = slots.inject('sidebar.panellist', () => slots.register({
      name: 'sidebar.panellist', id: panel.id, label: panel.label,
      ...(panel.order === undefined ? {} : { order: panel.order }),
    }, (props: { size: number; active: boolean }) => panel.icon(props)))
    registered += 1
    notify()
    return () => {
      registered -= 1
      main()
      rail()
      notify()
    }
  }, 'agent-swarm: native sidebar panel'))
  const dispose = () => {
    if (disposed) return
    disposed = true
    void dependency.dispose()
    listeners.clear()
  }
  ctx.effect(() => dispose, 'agent-swarm: native sidebar adapter')
  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => registered > 0,
    open() {
      if (registered === 0 || panelId === undefined) return false
      const layout = ctx.get('layout') as unknown as NativeLayout | undefined
      if (layout === undefined || typeof layout.selectPanel !== 'function') return false
      layout.selectPanel(panelId)
      return true
    },
    dispose,
  }
}

/** The rail glyph: three linked nodes, sized by the sidebar. */
export function SwarmRailIcon({ size }: { size: number }) {
  return <svg className="sw-rail-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round">
    <circle cx="12" cy="5.2" r="2.6" /><circle cx="5.6" cy="17.4" r="2.6" /><circle cx="18.4" cy="17.4" r="2.6" />
    <path d="M10.7 7.4 6.9 14.9M13.3 7.4l3.8 7.5M8.2 17.4h7.6" />
  </svg>
}
