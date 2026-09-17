/** Acceptance policy over host-recorded changes, independent of a model's task label. */
import { posix } from 'node:path'
import { deliverablePaths, requireHostChecks } from './admission.ts'
import { withinScope } from './scope.ts'
import type { Artifact, Task } from './types.ts'

/**
 * Named outputs the artifact neither changed nor declared. `named` defaults to
 * every path the task text names as a write target. Names outside the task
 * scope are not obligations: capture can never include them, and admission
 * already reports them as advisory read-only references (R19 H-1).
 */
export function missingDeliverablePaths(task: Pick<Task, 'objective' | 'acceptance' | 'scope'>, artifact: Pick<Artifact, 'changedPaths' | 'files'> | undefined, named: readonly string[] = deliverablePaths(task.objective ?? '', task.acceptance ?? [])): string[] {
  const present = new Set([...(artifact?.changedPaths ?? []), ...(artifact?.files ?? []).map(file => file.path)])
  return named.filter(name => withinScope(name, task.scope) && !present.has(name))
}

// Known report formats retain the lightweight research path. This classifies
// files, not arbitrary program semantics; reviewers still judge check coverage.
const reportExtensions = ['.md', '.markdown', '.txt', '.rst', '.adoc', '.pdf', '.csv', '.tsv', '.png', '.jpg', '.jpeg', '.gif', '.webp']
export function artifactNeedsChecks(artifact: Artifact): boolean {
  return !!artifact.executablePaths?.length || artifact.changedPaths.some(name => !reportExtensions.includes(posix.extname(name).toLowerCase())
    && !/^(readme|license|licence|copying|notice|authors|changelog)$/i.test(posix.basename(name)))
}

export function requireArtifactChecks(task: Pick<Task, 'id' | 'kind' | 'checks'>, artifact: Artifact): void {
  if (!artifactNeedsChecks(artifact)) return
  try { requireHostChecks('implementation', task.checks, 'task', task.id) }
  catch (error) {
    throw new Error(`[artifact_checks_required] Captured changes require host checks regardless of task kind (${task.kind}). The artifact is preserved. The owner can add meaningful checks to this same task with swarm_control(action: "amend", changes: { checks: [...] }), then retry submission or verification. ${String(error instanceof Error ? error.message : error)}`)
  }
}
