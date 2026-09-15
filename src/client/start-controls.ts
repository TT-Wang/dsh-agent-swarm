import type { AutoStart } from '../types.ts'
import type { Request } from './monitor.ts'
import { requestWithDeadline } from './request-deadline.ts'

export type StartAction = 'retry' | 'stop'

/** Bind the recovery operation to its saved request, never to a selected mission. */
export async function requestStartControl(request: Request, sessionId: string, start: AutoStart, action: StartAction, timeoutMs?: number): Promise<AutoStart> {
  const result = await requestWithDeadline<{ request: AutoStart }>(request, 'control', {
    sessionId, requestId: start.id, action, reason: `User selected ${action} for the saved Agent Swarm request.`,
  }, timeoutMs)
  if (result?.request?.id !== start.id || result.request.ownerSessionId !== sessionId) throw new Error('Invalid saved request response from host')
  return result.request
}

/** A mutation reply may precede the watch update, but must never replace a newer epoch. */
export function mergeStartResponse(starts: readonly AutoStart[], response: AutoStart | undefined, owner: string | undefined): AutoStart[] {
  const result = [...starts]
  if (!response || response.ownerSessionId !== owner) return result
  const index = result.findIndex(start => start.id === response.id)
  if (index < 0) result.push(response)
  else {
    const current = result[index]!
    if ((current.planningEpoch ?? 1) < (response.planningEpoch ?? 1)
      || ((current.planningEpoch ?? 1) === (response.planningEpoch ?? 1) && current.updatedAt < response.updatedAt)) result[index] = response
  }
  return result
}
