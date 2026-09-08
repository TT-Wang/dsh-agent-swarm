import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'

/** Workers are independent Harness sessions created with withoutInitiator, not catalog children. */
export function openWorker(sessions: Context['sessions'], workerSessionId: string): boolean {
  const sessionId = workerSessionId as Parameters<typeof sessions.open>[0]
  if (!sessions.list.getSnapshot().byId[sessionId]) return false
  sessions.open(sessionId)
  return true
}
