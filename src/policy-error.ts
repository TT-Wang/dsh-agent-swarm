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
   * automatic request's recorded reason, a draft's launch failure, a guard
   * terminal's detail). A refusal renders there as the plain `Error` it was
   * typed from, so typing it moves no recorded byte. A refusal class that had
   * its own name before it was typed overrides this to keep that name.
   */
  override toString(): string { return `Error: ${this.message}` }
}
