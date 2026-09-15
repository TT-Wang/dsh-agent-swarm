/** Mutation completion stays attached to the session where the user initiated it. */
export async function selectedOperation<T>(isSelected: () => boolean, operation: () => Promise<T>, callbacks: {
  success: (value: T) => void | Promise<void>
  failure: (error: unknown) => void
  settled?: () => void
  /** Operation-owned cleanup, also called after selection changes. Must not clear another operation. */
  release?: () => void
}): Promise<void> {
  try {
    const value = await operation()
    if (isSelected()) await callbacks.success(value)
  } catch (error) {
    if (isSelected()) callbacks.failure(error)
  } finally {
    try { if (isSelected()) callbacks.settled?.() } finally { callbacks.release?.() }
  }
}
