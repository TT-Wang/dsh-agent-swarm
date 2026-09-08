/** Mutation completion stays attached to the session where the user initiated it. */
export async function selectedOperation<T>(isSelected: () => boolean, operation: () => Promise<T>, callbacks: {
  success: (value: T) => void | Promise<void>
  failure: (error: unknown) => void
  settled: () => void
}): Promise<void> {
  try {
    const value = await operation()
    if (isSelected()) await callbacks.success(value)
  } catch (error) {
    if (isSelected()) callbacks.failure(error)
  } finally {
    if (isSelected()) callbacks.settled()
  }
}
