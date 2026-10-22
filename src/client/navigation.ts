import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * The session whose conversation is on screen. Client sessions can have several
 * live instances, so the list names no current one; the main conversation view
 * retains its session under the 'mainView' reference source instead.
 */
export function currentSessionId(sessions: Context['sessions'] | undefined): string | undefined {
  const list = sessions?.list.getSnapshot()
  return list?.ids.find(id => (list.byId[id]?.retainedBy.mainView ?? 0) > 0)
}

/**
 * Workers are independent Harness sessions created with withoutInitiator, not
 * catalog children. A listed one opens through the workspace UI service; false
 * leaves the caller to read its persisted history instead.
 */
export function openWorker(ctx: Pick<Context, 'sessions' | 'get'>, workerSessionId: string): boolean {
  const id = workerSessionId as SessionId
  if (!ctx.sessions.list.getSnapshot().byId[id]) return false
  const workspace = ctx.get('uiWorkspace')
  if (workspace === undefined) return false
  workspace.openSession(id)
  return true
}
