import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { registerSwarmCommandUi } from './command.tsx'
import { swarmCardDefinition } from './card-definition.ts'
import { SwarmBoard } from './SwarmBoard.tsx'
import { SWARM_CSS } from './styles.ts'
import { ActivityPanel, OPEN_MONITOR } from './ActivityPanel.tsx'
import { SidebarDock } from './SidebarDock.tsx'
import { createRightSidebarAdapter, createSidebarAdapter } from './sidebar.tsx'
import { SwarmMonitor, type Request } from './monitor.ts'
import { DisposalRegistry } from './lifecycle.ts'
import { CopyContext, en, zh } from './locale.tsx'
import { openWorker } from './navigation.ts'
import { WorkerHistory, type HistoryPage } from './history.ts'
import { SWARM_RPC_CHANNEL, SWARM_RPC_PREFIX } from '../types.ts'
import type { Member } from '../types.ts'

export const name = 'agent-swarm-client'
export const inject = ['uiConversation', 'slots', 'sessions', 'connection', 'locale', 'modelDirectories']

/** Native history cards and a docked sidebar; the host owns transport trust. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'agent-swarm'
    style.textContent = SWARM_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, 'agent-swarm: styles')
  ctx.effect(() => ctx.locale.register('agentSwarm', 'en', en), 'agent-swarm: English')
  ctx.effect(() => ctx.locale.register('agentSwarm', 'zh', zh), 'agent-swarm: Chinese')
  const translate = ctx.locale.bind('agentSwarm')
  const copy = (text: string) => text in en ? translate(text) : text
  function Localized({ children }: { children: ReactNode }) {
    useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot(), () => ctx.locale.getSnapshot())
    return <CopyContext.Provider value={text => copy(text)}>{children}</CopyContext.Provider>
  }
  const request: Request = async <T,>(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<T> => {
    // The client builds `<channel>/<endpoint>`; the host claims our prefix inside /api.
    const result = await (ctx.get('connection') as ConnectionHandle).rpc.call(SWARM_RPC_CHANNEL, `${SWARM_RPC_PREFIX}${endpoint}`, payload, signal)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value as T
  }
  let historyRequest: { owner: string; member: Member } | undefined
  const historyListeners = new Set<() => void>()
  const historyRequests = {
    subscribe: (listener: () => void) => { historyListeners.add(listener); return () => { historyListeners.delete(listener) } },
    getSnapshot: () => historyRequest,
  }
  // C2: React can build a pane and throw it away before it commits (StrictMode's
  // double render), so unmount alone cannot dispose what a render created. Every
  // pane resource is registered here, released when the pane unmounts, and the
  // plugin scope drains the rest on unload.
  const disposals = new DisposalRegistry()
  ctx.effect(() => () => disposals.dispose(), 'agent-swarm: pane resources')
  function Pane({ sessionId, active = true, onClose }: { sessionId?: string; active?: boolean; onClose?: () => void }) {
    const monitor = useMemo(() => disposals.add(new SwarmMonitor(request)), [request])
    const history = useMemo(() => disposals.add(new WorkerHistory(async (workerSessionId, beforeSeq) => {
      const owner = sessionId ?? ctx.sessions.list.getSnapshot().current
      if (!owner) throw new Error('Select a conversation to read its worker history.')
      return request<HistoryPage>('worker-history', { sessionId: owner, workerSessionId, maxMessages: 30, ...(beforeSeq === undefined ? {} : { beforeSeq }) })
    })), [sessionId])
    const current = useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot, ctx.sessions.list.getSnapshot).current
    const pending = useSyncExternalStore(historyRequests.subscribe, historyRequests.getSnapshot, historyRequests.getSnapshot)
    useEffect(() => () => disposals.release(monitor), [monitor])
    useEffect(() => () => disposals.release(history), [history])
    useEffect(() => {
      if (active && pending && pending.owner === (sessionId ?? current)) {
        history.open(pending.member.sessionId, pending.member.name)
        historyRequest = undefined
        for (const listener of historyListeners) listener()
      }
    }, [active, pending, sessionId, current, history])
    return <Localized><ActivityPanel sessions={ctx.sessions} modelDirectories={ctx.modelDirectories} monitor={monitor} history={history} sessionId={sessionId} active={active} onClose={onClose}
      onOpenWorker={member => {
        try { if (openWorker(ctx.sessions, member.sessionId)) return } catch { /* A completed row can leave the live list. */ }
        history.open(member.sessionId, member.name)
      }} /></Localized>
  }
  // Surface preference: the host's own right sidebar first (0.1.5 line, the same
  // pane Files uses), then Better Sidebar when a profile mounts it, then the
  // standalone dock. Each adapter reports integrated only while its registration
  // is live, so unloading a host pane hands the surface to the next one instead
  // of leaving a blank column.
  const native = createRightSidebarAdapter(ctx, () => ({
    id: 'dsh-external-agent-swarm', kind: 'agent-swarm', order: 80,
    label: () => copy('Agent Swarm'),
    description: () => copy('Missions, workers and evidence for this conversation'),
    component: () => <Pane />,
  }))
  const sidebar = createSidebarAdapter(ctx, () => ({
    id: 'agent-swarm', title: () => copy('Agent Swarm'), single: true, order: 80,
    component: ({ scope, visible }) => <Pane sessionId={scope.sessionId} active={visible} />,
  }))
  const openSidebar = () => {
    if (native.open()) return
    if (!sidebar.open()) window.dispatchEvent(new Event(OPEN_MONITOR))
  }
  registerSwarmCommandUi(ctx, { openSidebar, copy })
  const viewWorker = (member: Member) => {
    try { if (openWorker(ctx.sessions, member.sessionId)) return } catch { /* Fall back to persisted history. */ }
    const owner = ctx.sessions.list.getSnapshot().current
    if (!owner) return
    historyRequest = { owner, member }
    for (const listener of historyListeners) listener()
    openSidebar()
  }
  function SwarmCard({ node }: PropsRuntime<'conversation.chat.node', 'agent-swarm'>) {
    const [error, setError] = useState('')
    return <Localized><div><button className="sw-open-monitor" onClick={openSidebar}>{copy('Open swarm sidebar')} ›</button>
      {error && <p role="alert">{error}</p>}
      <SwarmBoard snapshot={node.data} onOpenWorker={member => { setError(''); try { viewWorker(member) } catch (failure) { setError(String(failure)) } }} />
    </div></Localized>
  }
  function Panel() {
    const hostIntegrated = useSyncExternalStore(native.subscribe, native.getSnapshot, native.getSnapshot)
    const integrated = useSyncExternalStore(sidebar.subscribe, sidebar.getSnapshot, sidebar.getSnapshot)
    return hostIntegrated || integrated ? null : <Localized><SidebarDock>{props => <Pane {...props} />}</SidebarDock></Localized>
  }
  ctx.uiConversation.events.register(swarmCardDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'agent-swarm',
  }, SwarmCard))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'agent-swarm-sidebar', order: 80 }, Panel))
}
