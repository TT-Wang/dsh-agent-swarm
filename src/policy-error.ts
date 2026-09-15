/** Authored control refusals: presentation text does not determine their category. */
export type PolicyErrorCategory = 'validation_error' | 'authorization_error' | 'budget_error' | 'lease_error' | 'conflict_error'

export class PolicyError extends Error {
  constructor(readonly code: string, readonly category: PolicyErrorCategory, message: string) {
    super(message)
    this.name = 'PolicyError'
  }
}
