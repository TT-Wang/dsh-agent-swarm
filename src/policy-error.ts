/**
 * Authored control refusals: presentation text does not determine their category.
 * `tool_error` is the category the trace gave a refusal text no classifier rule
 * matched; a refusal typed from such a text keeps it, so its trace row does not move.
 */
export type PolicyErrorCategory = 'validation_error' | 'authorization_error' | 'budget_error' | 'lease_error' | 'conflict_error' | 'tool_error'

export class PolicyError extends Error {
  constructor(readonly code: string, readonly category: PolicyErrorCategory, message: string) {
    super(message)
    this.name = 'PolicyError'
  }
  /**
   * `String(error)` feeds durable records the owner and the model read (an
   * automatic request's recorded reason and a draft's launch failure, through
   * `recordedFailure`; a guard terminal's detail). A refusal renders there as
   * the plain `Error` it was typed from, so typing it moves no recorded byte. A
   * refusal class that had its own name before it was typed overrides this to
   * keep that name.
   */
  override toString(): string { return `Error: ${this.message}` }
}

/**
 * A thrown value's readable text, never "[object Object]": an Error's
 * message, a string as itself, an object's string `message`, any other
 * object as its JSON, a primitive as its string. A value that cannot be read
 * (a cyclic object, a trapping proxy) is named as such, so the text is total.
 */
export function thrownText(value: unknown): string {
  try {
    if (value instanceof Error) return value.message
    if (typeof value === 'string') return value
    if (typeof value === 'function') return `a function ${JSON.stringify(value.name)}`
    if (value === null || typeof value !== 'object') return String(value)
    const message = (value as { message?: unknown }).message
    if (typeof message === 'string') return message
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch { /* An unreadable value is named below. */ }
  return 'a thrown value that cannot be read'
}

/**
 * A thrown value as a failed launch's durable records carry it: the automatic
 * request's recorded reason (`startPlan`), which its recovery notice quotes to
 * the owner's model, and the draft's launch failure (`launchDraft`). An Error
 * renders as itself, `Error: <message>` (`PolicyError.toString`); any other
 * value as its readable text (`thrownText`), never "[object Object]". Total,
 * as `thrownText` is: an Error whose rendering throws is read like any other
 * value.
 */
export function recordedFailure(value: unknown): string {
  try { if (value instanceof Error) return String(value) } catch { /* Read below like any other value. */ }
  return thrownText(value)
}
