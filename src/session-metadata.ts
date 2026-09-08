/** Public persistence metadata contracts across supported Harness releases. */
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

type MetadataReader = {
  stat(id: SessionId, options?: { signal?: AbortSignal }): Promise<{ readonly header: SessionHeader } | undefined>
} | {
  list(signal?: AbortSignal): Promise<readonly SessionHeader[]>
}

/** Read one durable header without activating, repairing, or opening a writer. */
export async function persistedSessionHeader(persistence: MetadataReader, id: SessionId, signal: AbortSignal): Promise<SessionHeader | undefined> {
  signal.throwIfAborted()
  // alpha.2 has a per-session stat; rc.1 exposes a lightweight header listing.
  // Keep each public cancellation contract intact rather than guessing list's
  // changed argument and result shape or interpreting the package version.
  const header = 'stat' in persistence
    ? (await persistence.stat(id, { signal }))?.header
    : (await persistence.list(signal)).find(candidate => candidate.id === id)
  signal.throwIfAborted()
  return header
}
