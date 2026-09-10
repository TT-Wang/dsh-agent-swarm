/**
 * The declared-check execution path: the bounded timeout window, the host call
 * that runs the task's declared checks, the measured envelope record, the
 * pass/fail classification, the durable tool-run row per check and the rejection
 * text. M1a seam 5/7.
 *
 * Behaviour-identical to the code moved from src/runtime.ts. `verify` still
 * runs inside the same transaction: only the check execution moved, and it
 * records exactly the rows it recorded before.
 */
import type { SwarmRuntime } from './runtime.ts'
import { randomUUID } from 'node:crypto'
import type { Artifact, Member, Task, ToolRun } from './types.ts'

const id = (prefix: string) => `${prefix}_${randomUUID()}`

/** Host verification timeout when a task chose none; matches the plugin config default. */
export const DEFAULT_CHECK_TIMEOUT_MS = 60000

/** A rejection names at most this many failing checks; the rest are counted. */
export const MAX_REPORTED_CHECK_FAILURES = 4

/** Bounded text for model-visible views; the stored record remains complete. */
export function excerpt(value: unknown, limit: number): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}… [${raw.length - limit} more chars]`
}

export class DeclaredChecks {
  constructor(private readonly rt: SwarmRuntime) {}

  /** The verification window one source's declared checks may occupy. */
  windowFor(source: Task): number {
    const checkTimeoutMs = source.checkTimeoutMs ?? this.rt.config.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    return checkTimeoutMs * Math.max(1, source.checks.length) + this.rt.config.leaseMs
  }

  /** Run the declared checks through the adapter; the host owns the sandbox. */
  async run(member: Member, source: Task, artifact: Artifact, signal?: AbortSignal) {
    return this.rt.workers.verifyArtifact(member, source, artifact, signal)
  }

  /**
   * R11-19: record the measured envelope durably, even when the verdict below
   * fails closed because the world moved during the check.
   */
  recordEnvelope(missionId: string, taskId: string, sourceTaskId: string, memberId: string): void {
    const envelope = this.rt.workers.checkEnvelope?.()
    if (envelope === undefined) return
    this.rt.commit(missionId, () => this.rt.store.event(missionId, 'task/check-envelope', memberId,
      { taskId, sourceTaskId, ...envelope }))
  }

  /** The verdict's check outcome: a rejection is the reviewer's to earn. */
  classify(verdict: 'accept' | 'reject', checks: ReadonlyArray<{ command: string; exitCode: number; output: string; truncated?: boolean }>): { passed: boolean; failingChecks: Array<{ command: string; exitCode: number; output: string; truncated?: boolean }> } {
    const passed = verdict === 'accept' && checks.every(check => check.exitCode === 0)
    return { passed, failingChecks: checks.filter(check => check.exitCode !== 0) }
  }

  /**
   * One durable tool-run row per declared check, in order, in the same
   * transaction as the verdict. Returns the row ids the acceptance event names.
   */
  recordRuns(missionId: string, where: { memberId: string; taskId: string; attemptId: string; commit: string },
    checks: ReadonlyArray<{ command: string; exitCode: number; output: string; truncated?: boolean }>): string[] {
    const ids: string[] = []
    let seq = this.rt.store.countToolRuns(missionId)
    for (const check of checks) {
      const run: ToolRun = { id: id('run'), seq: ++seq, missionId, memberId: where.memberId, taskId: where.taskId, attemptId: where.attemptId, tool: 'swarm.host_verification', arguments: { command: check.command, commit: where.commit }, result: check, isError: check.exitCode !== 0, createdAt: Date.now() }
      this.rt.store.put('tool_runs', run); ids.push(run.id)
    }
    return ids
  }

  /**
   * The durable rejection reason: the reviewer's own prose plus, per failing
   * declared check, the command, the exit code and a bounded output excerpt.
   * The Round-8 benchmark lost the real failure here — the reviewer wrote that
   * every criterion passed while the host check had exited 127, and the only
   * copy lived in a tool run. A rejection on judgement (no failing check) keeps
   * the prose untouched. The combined text never exceeds `maxMessageChars`, and
   * every reported command and exit code survives truncation because only
   * output excerpts are cut.
   */
  rejectionReason(reason: string, checks: ReadonlyArray<{ command: string; exitCode: number; output: string; truncated?: boolean }>): string {
    const failures = checks.filter(check => check.exitCode !== 0)
    if (failures.length === 0) return reason
    const shown = failures.slice(0, MAX_REPORTED_CHECK_FAILURES)
    const omitted = failures.length - shown.length
    const heading = failures.length === 1 ? 'Host check failed' : `Host checks failed (${failures.length})`
    const heads = shown.map((check, index) => `check ${index + 1} \`${check.command}\` exited ${check.exitCode}${check.truncated === true ? ' (host output truncated at the check-output bound)' : ''}: `)
    const omission = omitted === 0 ? '' : `\n… ${omitted} more failing check(s) not shown`
    const marker = ' …[output excerpt truncated]'
    const fixed = 1 + heading.length + 2 + heads.reduce((total, head) => total + head.length + 1, 0) + marker.length + omission.length
    let prose = reason
    if (prose.length + fixed > this.rt.config.maxMessageChars) {
      // The check evidence is the part that must never be lost: excerpt the prose to fit.
      const proseBudget = Math.max(0, this.rt.config.maxMessageChars - fixed - 48)
      prose = `${prose.slice(0, proseBudget)} …[reviewer reason truncated]`
    }
    let remaining = Math.max(0, this.rt.config.maxMessageChars - prose.length - fixed)
    const parts: string[] = []
    for (const [index, check] of shown.entries()) {
      const output = check.output.trimEnd()
      const share = index === shown.length - 1 ? remaining : Math.max(0, Math.floor(remaining / (shown.length - index)))
      const excerpt = output.length === 0 ? '(no output captured)'
        : output.length <= share ? output : `${output.slice(0, Math.max(0, share - marker.length))}${marker}`
      remaining = Math.max(0, remaining - excerpt.length)
      parts.push(`${heads[index]}${excerpt}`)
    }
    const report = `${prose}\n${heading}:\n${parts.join('\n')}${omission}`
    return report.length <= this.rt.config.maxMessageChars ? report : `${report.slice(0, Math.max(0, this.rt.config.maxMessageChars - marker.length))}${marker}`
  }
}
