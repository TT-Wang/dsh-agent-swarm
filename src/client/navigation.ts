import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

/** The session list, restricted to what identifies the conversation on screen across supported hosts. */
interface SessionListView {
  /** 0.1.2-0.1.5: the persisted selection every session-scoped surface keys off. */
  current?: string
  /** 0.1.6: local reference counts; the main conversation view retains its session as 'mainView'. */
  byId?: Record<string, { retainedBy?: Partial<Record<string, number>> } | undefined>
  ids?: readonly string[]
}

/**
 * The session whose conversation is on screen. 0.1.6 removed `list.current`
 * (client sessions can have several live instances) and the main view instead
 * retains its session under the 'mainView' source, so that count stands in.
 */
export function currentSessionId(sessions: Context['sessions'] | undefined): string | undefined {
  const list = (sessions?.list?.getSnapshot?.() ?? {}) as SessionListView
  if (typeof list.current === 'string') return list.current
  for (const id of list.ids ?? Object.keys(list.byId ?? {})) {
    if ((list.byId?.[id]?.retainedBy?.['mainView'] ?? 0) > 0) return id
  }
  return undefined
}

/** Workers are independent Harness sessions created with withoutInitiator, not catalog children. */
export function openWorker(ctx: Pick<Context, 'sessions' | 'get'>, workerSessionId: string): boolean {
  const sessions = ctx.sessions as Context['sessions'] & { open?: (id: string) => void }
  const list = sessions.list.getSnapshot() as SessionListView
  if (!list.byId?.[workerSessionId]) return false
  // 0.1.2-0.1.5 navigated through the sessions face; 0.1.6 moved navigation to the workspace UI service.
  if (typeof sessions.open === 'function') { sessions.open(workerSessionId); return true }
  const workspace = ctx.get('uiWorkspace') as { openSession?: (target: string) => void } | undefined
  if (typeof workspace?.openSession !== 'function') return false
  workspace.openSession(workerSessionId)
  return true
}
