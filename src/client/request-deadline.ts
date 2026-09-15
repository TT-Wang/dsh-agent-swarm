import type { Request } from './monitor.ts'

export class RequestDeadlineError extends Error {
  constructor() {
    super('The request timed out. Its outcome is unconfirmed. Refresh the state before retrying.')
    this.name = 'RequestDeadlineError'
  }
}

/** Abort the transport and settle the UI even if an older transport ignores abort. */
export async function requestWithDeadline<T>(request: Request, endpoint: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new RequestDeadlineError()
      reject(error)
      controller.abort(error)
    }, timeoutMs)
  })
  try { return await Promise.race([Promise.resolve().then(() => request<T>(endpoint, payload, controller.signal)), deadline]) }
  finally { clearTimeout(timer) }
}
