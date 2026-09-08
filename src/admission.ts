/** Shared input normalization and repair guidance; matching and authority stay strict. */
import { scopeSubset, validScope } from './scope.ts'

/** Accept equivalent notation without guessing a wider path or a repository root. */
export function normalizeScopeSelectors(scopes: readonly string[]): string[] {
  return scopes.map(selector => {
    let normalized = selector
    while (normalized.startsWith('./') && normalized.length > 2) normalized = normalized.slice(2)
    if (normalized.endsWith('/**')) normalized = normalized.slice(0, -2)
    return normalized !== '**' && validScope(normalized) ? normalized : selector
  })
}

export function assertScopeSelectors(scopes: readonly string[], location: string, parent?: readonly string[]): void {
  const invalid = scopes.findIndex(selector => !validScope(selector))
  if (invalid !== -1) throw new Error(`${location}[${invalid}] is invalid: ${JSON.stringify(scopes[invalid])}. Use literal workspace-relative file paths, directory prefixes ending in "/", or "**". Do not use absolute paths, traversal, wildcard patterns or descriptive prose. Correct this field and retry the same task/request, preserving its kind, acceptance criteria and budget; never broaden scope just to pass validation.`)
  if (parent && !scopeSubset(scopes, parent)) {
    const offending = scopes.find(selector => !scopeSubset([selector], parent))
    throw new Error(`${location} exceeds mission scope: ${JSON.stringify(offending)} is not covered by allowed mission selectors ${JSON.stringify(parent)}. Use literal workspace-relative paths or directory prefixes ending in "/", not descriptive prose. Each task selector must match or narrow a mission selector. Correct this field and retry the same task/request, preserving its kind, acceptance criteria and budget; never broaden scope just to pass validation.`)
  }
}

/** reviewOf already waits for submission; an ordinary edge would wait for acceptance. */
export function normalizeReviewDependencies(kind: string, reviewOf: string | undefined, dependencies: readonly string[] = []): string[] {
  return dependencies.filter(dependency => kind !== 'verification' || dependency !== reviewOf)
}

export function requireHostChecks(kind: string, checks: readonly string[] | undefined, location: string, taskIdentity?: string): void {
  if (checks !== undefined) {
    if (!Array.isArray(checks)) throw new Error(`${location}.checks must be an array of real repository acceptance commands. Correct this field and retry the same task/request, preserving acceptance criteria and budget.`)
    const invalid = checks.findIndex(command => typeof command !== 'string' || !command.trim() || command.length > 16000)
    if (invalid !== -1) throw new Error(`${location}.checks[${invalid}] must be a nonempty shell command of at most 16000 characters that proves the task's acceptance criteria. Empty or whitespace-only commands do not verify work. Correct this field and retry the same task/request, preserving acceptance criteria and budget.`)
  }
  if ((kind === 'implementation' || kind === 'integration') && !checks?.length) {
    throw new Error(`${location}.checks${taskIdentity ? ` (task ${JSON.stringify(taskIdentity)})` : ''} is required: code tasks of kind ${JSON.stringify(kind)} need at least one real repository acceptance command, supplied by the primary agent. Inspect existing project test/build scripts or choose a meaningful assertion proving this task's acceptance criteria. Commands belong on the source implementation/integration task, even when it has a separate reviewOf task; the host runs them on its committed artifact. If this task changes code, keep its kind, add checks and retry the same task/request, preserving acceptance criteria and budget. If its actual objective is only a read-only audit or report synthesis, the primary agent should explicitly classify it as research with dependencies and host-recorded evidence. Never change a code deliverable to research to bypass verification or substitute trivial always-passing checks.`)
  }
}
