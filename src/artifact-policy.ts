/** Acceptance policy over host-recorded changes, independent of a model's task label. */
import { posix } from 'node:path'
import { requireHostChecks } from './admission.ts'
import type { Artifact, Task } from './types.ts'

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
