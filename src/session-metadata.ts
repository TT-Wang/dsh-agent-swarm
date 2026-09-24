/** The public persistence metadata contract both supported Harness releases share. */
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

interface MetadataReader {
  stat(id: SessionId, options?: { signal?: AbortSignal }): Promise<{ readonly header: SessionHeader } | undefined>
}

/** Read one durable header without activating, repairing, or opening a writer. */
export async function persistedSessionHeader(persistence: MetadataReader, id: SessionId, signal: AbortSignal): Promise<SessionHeader | undefined> {
  signal.throwIfAborted()
  const header = (await persistence.stat(id, { signal }))?.header
  signal.throwIfAborted()
  return header
}
