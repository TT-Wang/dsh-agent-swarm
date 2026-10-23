/**
 * Pure functions of declared-check result rows: the row for a check the host
 * could not execute, and the exit a deferred review names from its deciding
 * pass's rows; with the bounded excerpt every model-visible view uses. A leaf:
 * it imports only the row type, so the board, the workspace engine, the gates
 * and the runtime read it without importing the declared-check seam.
 */
import type { CheckResult } from './types.ts'

/** Bounded text for model-visible views; the stored record remains complete. */
export function excerpt(value: unknown, limit: number): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}… [${raw.length - limit} more chars]`
}

/** The row for a declared check the host could not prepare, confine or start: the review defers instead of rejecting the artifact. */
export function unexecutedCheck(command: string, error: unknown): CheckResult {
  return { command, exitCode: 125, failureKind: 'infrastructure', output: `Host verification could not execute: ${String(error)}` }
}

const RESUME = 'resume the review with swarm_control(action: "resume", taskId, reason)'
const REPLACE = 'or, if a command is wrong, cancel the source with swarm_cancel(taskId, reason) and repair its checks with swarm_propose(replaces, checks, maxRecoveryAttempts, checkTimeoutMs)'
/** The one exit per failure kind classified on the row, an older host's rows included; it names no id and bounds row data, so a deferral has a fixed maximum. The repair names every allocation a launched mission requires of work with checks, which every mission accepts. */
const RECOVERY_EXITS: Record<NonNullable<CheckResult['failureKind']>, (check: CheckResult) => string> = {
  timeout: () => `a check reached its deadline: raise the source's checkTimeoutMs with swarm_budget(taskId, taskBudget: { checkTimeoutMs }, reason), then ${RESUME}; ${REPLACE}`,
  infrastructure: () => `the host could not execute a check: repair the host condition its output reports, then ${RESUME}`,
  unrunnable: ({ environment }) => {
    const links = environment?.dependencyLinks
    const found = links === undefined ? '' : ` (dependency directories ${links.mode === 'copy' ? 'copied' : 'linked'} from the source: ${excerpt(links.materializedPaths?.length ? links.materializedPaths.join(', ') : `none of verificationDependencyDirs ${JSON.stringify(links.dirs)}`, 60)})`
    return `a command could not run in the clean verification checkout${found}: provide what it needs in the source or on the host, then ${RESUME}; ${REPLACE}`
  },
}

/** A deferred review's exit, from the rows of the pass that decided to defer: its last classified failure's (a pass stops at its first failing check), or resuming when no row has a kind. */
export function recoveryExit(checks: ReadonlyArray<CheckResult>): string {
  const failure = checks.findLast(check => check.failureKind !== undefined)
  return failure?.failureKind === undefined ? RESUME : RECOVERY_EXITS[failure.failureKind](failure)
}
