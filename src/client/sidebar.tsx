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
