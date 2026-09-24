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
import { ActivityPanel } from './ActivityPanel.tsx'
import { createRightSidebarAdapter, createSidebarAdapter } from './sidebar.tsx'
import { SwarmMonitor, type Request } from './monitor.ts'
import { DisposalRegistry } from './lifecycle.ts'
import { CopyContext, en, zh, useCopy } from './locale.tsx'
import { currentSessionId, openWorker } from './navigation.ts'
import { WorkerHistory, type HistoryPage } from './history.ts'
import { SWARM_RPC_CHANNEL, SWARM_RPC_PREFIX } from '../types.ts'
import type { Member } from '../types.ts'

export const name = 'agent-swarm-client'
export const inject = ['uiConversation', 'slots', 'sessions', 'connection', 'locale', 'modelDirectories']

function SidebarLauncher({ wide, onOpen }: { wide: boolean; onOpen(): void }) {
  const copy = useCopy()
  return <button type="button" data-swarm-native-launcher data-wide={wide}
    aria-label={copy('Open swarm sidebar')} title={copy('Open swarm sidebar')} onClick={onOpen}>
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5"/><path d="M11.5 4v12M5.5 7h3M5.5 10h3M5.5 13h2"/>
    </svg>{wide && <span>{copy('Agent Swarm')}</span>}
  </button>
}

/** Native history cards and a right-sidebar tab; the host owns transport trust. */
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
  function Pane({ sessionId, active = true }: { sessionId?: string; active?: boolean }) {
    const monitor = useMemo(() => disposals.add(new SwarmMonitor(request)), [request])
    const history = useMemo(() => disposals.add(new WorkerHistory(async (workerSessionId, beforeSeq) => {
      const owner = sessionId ?? currentSessionId(ctx.sessions)
      if (!owner) throw new Error('Select a conversation to read its worker history.')
      return request<HistoryPage>('worker-history', { sessionId: owner, workerSessionId, maxMessages: 30, ...(beforeSeq === undefined ? {} : { beforeSeq }) })
    })), [sessionId])
    useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot, ctx.sessions.list.getSnapshot)
    const current = currentSessionId(ctx.sessions)
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
    return <Localized><ActivityPanel sessions={ctx.sessions} modelDirectories={ctx.modelDirectories} monitor={monitor} history={history} sessionId={sessionId} active={active}
      onOpenWorker={member => {
        try { if (openWorker(ctx, member.sessionId)) return } catch { /* A completed row can leave the live list. */ }
        history.open(member.sessionId, member.name)
      }} /></Localized>
  }
  // Surface preference: the host's own right sidebar first (the same pane Files
  // uses), then Better Sidebar when a profile mounts it. Registration owns the
  // surface without opening it; the native controller reveals it only for a
  // command or explicit navigation.
  const native = createRightSidebarAdapter(ctx, () => ({
    id: 'dsh-external-agent-swarm', kind: 'agent-swarm', order: 80,
    label: () => copy('Agent Swarm'),
    description: () => copy('Missions, workers and evidence for this conversation'),
    component: ({ scope, visible }) => <Pane key={scope.sessionId} sessionId={scope.sessionId} active={visible} />,
    launcher: props => <Localized><SidebarLauncher {...props} /></Localized>,
  }))
  const sidebar = createSidebarAdapter(ctx, () => ({
    id: 'agent-swarm', title: () => copy('Agent Swarm'), single: true, order: 80,
    component: ({ scope, visible }) => <Pane sessionId={scope.sessionId} active={visible} />,
  }))
  const openSidebar = () => { if (!native.open()) sidebar.open() }
  registerSwarmCommandUi(ctx, { openSidebar, copy })
  const viewWorker = (member: Member) => {
    try { if (openWorker(ctx, member.sessionId)) return } catch { /* Fall back to persisted history. */ }
    const owner = currentSessionId(ctx.sessions)
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
  ctx.uiConversation.events.register(swarmCardDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'agent-swarm',
  }, SwarmCard))
}
