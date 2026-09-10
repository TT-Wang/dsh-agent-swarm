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

/** One declared check's outcome, as the host recorded it. */
export type CheckResult = { command: string; exitCode: number; output: string; truncated?: boolean }

export class DeclaredChecks {
  /**
   * S15: the attempts of the verification in flight. The key is
   * `memberId:commit:sourceTaskId`, not `memberId:commit`: `run()` executes
   * outside the mission lock and `recordRuns()` inside a later exclusive section,
   * so two concurrent verifications by one member on one artifact could otherwise
   * swap their held passes. The reviewed source is available on both sides —
   * `run()` gets the source, and `recordRuns()` reads the verification task's
   * `reviewOf` from the store — so the pairing is exact without a new parameter.
   */
  private readonly checkRuns = new Map<string, CheckResult[][]>()

  constructor(private readonly rt: SwarmRuntime) {}

  /** The reviewed source a verification task belongs to. */
  private sourceOf(verificationTaskId: string): string {
    return this.rt.store.get('tasks', verificationTaskId)?.reviewOf ?? verificationTaskId
  }

  /**
   * The verification window one source's declared checks may occupy. It covers
   * the worst case of the retry rule below: a failing first pass plus its retry.
   */
  windowFor(source: Task): number {
    const checkTimeoutMs = source.checkTimeoutMs ?? this.rt.config.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    return checkTimeoutMs * Math.max(1, source.checks.length) * 2 + this.rt.config.leaseMs
  }

  /**
   * Run the declared checks through the adapter; the host owns the sandbox.
   *
   * S15 (recorded 2026-09-09, reproduced on 2026-09-10): a declared check can be a
   * wall-clock deadline that assumed an unloaded machine, and the single-strike
   * rule turned one timing accident into a preserve-and-replace cycle — round 13
   * paid two of those and the owner paid one more while gating it. So a failing
   * pass is re-run once on the same artifact and the retry decides: a real
   * failure fails twice, a flake does not. The first pass is kept for the durable
   * record (see `recordRuns`), never discarded.
   */
  async run(member: Member, source: Task, artifact: Artifact, signal?: AbortSignal): Promise<CheckResult[]> {
    const key = `${member.id}:${artifact.commit}:${source.id}`
    const first = await this.rt.workers.verifyArtifact(member, source, artifact, signal)
    if (first.every(check => check.exitCode === 0)) { this.checkRuns.delete(key); return first }
    const retry = await this.rt.workers.verifyArtifact(member, source, artifact, signal)
    this.checkRuns.set(key, [first, retry])
    return retry
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
   * One durable tool-run row per declared check per attempt, in order, in the
   * same transaction as the verdict. When the retry rule fired, both the failed
   * first pass and the deciding retry are written, each row naming its attempt,
   * command, exit code and output, so the durable record shows the flake instead
   * of hiding it. The returned ids are the deciding attempt's rows, which is what
   * the acceptance/rejection event names.
   */
  recordRuns(missionId: string, where: { memberId: string; taskId: string; attemptId: string; commit: string },
    checks: ReadonlyArray<CheckResult>): string[] {
    const key = `${where.memberId}:${where.commit}:${this.sourceOf(where.taskId)}`
    const held = this.checkRuns.get(key)
    this.checkRuns.delete(key)
    const recorded: Array<{ attempt: number; checks: ReadonlyArray<CheckResult> }> = held === undefined
      ? [{ attempt: 1, checks }]
      : [{ attempt: 1, checks: held[0]! }, { attempt: 2, checks: held[1]! }]
    const ids: string[] = []
    let seq = this.rt.store.countToolRuns(missionId)
    for (const [index, entry] of recorded.entries()) {
      const deciding = index === recorded.length - 1
      for (const check of entry.checks) {
        const run: ToolRun = { id: id('run'), seq: ++seq, missionId, memberId: where.memberId, taskId: where.taskId, attemptId: where.attemptId, tool: 'swarm.host_verification', arguments: { command: check.command, commit: where.commit, attempt: entry.attempt }, result: check, isError: check.exitCode !== 0, createdAt: Date.now() }
        this.rt.store.put('tool_runs', run); if (deciding) ids.push(run.id)
      }
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
