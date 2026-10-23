/**
 * The declared-check execution path: the bounded timeout window, the host call
 * that runs the task's declared checks, the measured envelope record, the
 * pass/fail classification, the durable tool-run row per check and the rejection
 * text; and the check environment: the assignment delivery that hands an
 * attempt its envelope (the one writer of an assignment delivery), its
 * reproduction by the host checks that support a verdict and the refusal of an
 * acceptance they do not reproduce.
 *
 * Check executions are outside the mission transaction; the verdict records
 * their exact outcomes and retains bounded retry evidence. Explicit execution
 * failures can defer review without converting infrastructure into a code verdict.
 */
import { id } from './store.ts'
import { memberTask } from './task-graph.ts'
import { unexecutedCheck } from './check-results.ts'
import type { Kernel } from './kernel.ts'
import type { WorkspaceAdmission } from './workspace-admission.ts'
import type { Artifact, CheckEnvelope, CheckEnvironment, CheckResult, Member, Task, ToolRun } from './types.ts'

/** Host verification timeout when a task chose none; matches the plugin config default. */
const DEFAULT_CHECK_TIMEOUT_MS = 60000

/** A rejection names at most this many failing checks; the rest are counted. */
export const MAX_REPORTED_CHECK_FAILURES = 4

/**
 * ENV: one field of the declared-check envelope the executed check does not
 * reproduce. `selfRun` names the measured side of the comparison; both sides are
 * environments the host recorded, never an environment read off a command.
 */
export interface CheckEnvironmentMismatch { field: string; envelope: string; selfRun: string }
/**
 * ENV: the envelope reproduction comparison. `blocking` divergences mean the
 * declared host checks that support this verification did not run under the
 * environment the envelope promised, so the mismatch is reported instead of
 * accepting the artifact. `advisory` divergences (whether a cache root happened
 * to exist) are recorded but never refuse an acceptance: a check must not depend
 * on the ambient cache staying warm.
 */
export interface CheckEnvironmentComparison { blocking: CheckEnvironmentMismatch[]; advisory: CheckEnvironmentMismatch[] }
const checkEnvironmentField = (value: string | boolean | null): string => value === null ? 'absent' : String(value)
/** ENV: the cache roots as one comparable field; `none` when the environment sets none. */
const checkCacheRootsField = (roots: Record<string, string>): string =>
  Object.keys(roots).sort().map(name => `${name}=${roots[name]}`).join(', ') || 'none'
/** Dependency directories are a set; Git inventory order is not declaration order. */
const checkDependencyDirsField = (dirs: readonly string[] | undefined): string =>
  JSON.stringify([...new Set(dirs ?? [])].sort())
/**
 * ENV: compare the declared envelope the runtime delivered with the environment
 * a host-recorded execution reports. HOME, the user cache roots, the
 * sandbox policy and the dependency links must agree; the scoped check cache
 * roots the envelope itself provides (`checkCacheRoot`, `checkCacheRoots`,
 * `xdgCacheHome`) and the existence flags are compared and REPORTED but stay
 * advisory: they differ by construction on every run, and a check must not
 * depend on the ambient cache staying warm — refusing on them would block every
 * production acceptance.
 */
export function compareCheckEnvironments(envelope: CheckEnvironment, selfRun: CheckEnvironment): CheckEnvironmentComparison {
  const blocking: CheckEnvironmentMismatch[] = []
  const advisory: CheckEnvironmentMismatch[] = []
  const compare = (field: string, before: string | boolean | null, after: string | boolean | null, into: CheckEnvironmentMismatch[]): void => {
    const left = checkEnvironmentField(before), right = checkEnvironmentField(after)
    if (left !== right) into.push({ field, envelope: left, selfRun: right })
  }
  compare('home', envelope.home, selfRun.home, blocking)
  compare('userCacheDir', envelope.userCacheDir, selfRun.userCacheDir, blocking)
  compare('huggingfaceCacheDir', envelope.huggingfaceCacheDir, selfRun.huggingfaceCacheDir, blocking)
  compare('sandboxPolicy.mode', envelope.sandboxPolicy?.mode ?? null, selfRun.sandboxPolicy?.mode ?? null, blocking)
  compare('sandboxPolicy.enforcement', envelope.sandboxPolicy?.enforcement ?? null, selfRun.sandboxPolicy?.enforcement ?? null, blocking)
  compare('dependencyLinks.mode', envelope.dependencyLinks?.mode ?? null, selfRun.dependencyLinks?.mode ?? null, blocking)
  compare('dependencyLinks.dirs', checkDependencyDirsField(envelope.dependencyLinks?.dirs), checkDependencyDirsField(selfRun.dependencyLinks?.dirs), blocking)
  compare('userCacheDirExists', envelope.userCacheDirExists, selfRun.userCacheDirExists, advisory)
  compare('huggingfaceCacheDirExists', envelope.huggingfaceCacheDirExists, selfRun.huggingfaceCacheDirExists, advisory)
  // The scoped roots the envelope promises name a placeholder checkout, while
  // an executed check names the disposable checkout it really received: they
  // differ on every run by construction. Both are still named with both values
  // so the record shows the difference, never an empty comparison that hides it.
  compare('xdgCacheHome', envelope.xdgCacheHome, selfRun.xdgCacheHome, advisory)
  compare('checkCacheRoot', envelope.checkCacheRoot, selfRun.checkCacheRoot, advisory)
  compare('checkCacheRoots', checkCacheRootsField(envelope.checkCacheRoots), checkCacheRootsField(selfRun.checkCacheRoots), advisory)
  return { blocking, advisory }
}
/**
 * ENV: a verification whose supporting host checks did not run under the
 * declared-check envelope, rendered from the comparison's blocking fields as
 * the refusal the member must act on. The verdict is refused rather than
 * accepting an artifact that was only ever validated under a different
 * environment.
 */
export class CheckEnvironmentMismatchError extends Error {
  readonly code = 'check_environment_mismatch'
  constructor(comparison: CheckEnvironmentComparison) {
    const fields = comparison.blocking.map(item => `${item.field}: envelope ${item.envelope}, self-run ${item.selfRun}`).join('; ')
    super(`[check_environment_mismatch] This verification's self-run environment (recorded on the declared host checks) cannot reproduce the declared-check envelope: ${fields}. Rerun the declared check in the envelope environment, then call \`swarm_verify\` with its \`verdict\` and \`reason\` again; the artifact is not accepted under a different environment.`)
    this.name = 'CheckEnvironmentMismatchError'
  }
}
/** ENV: the measured envelope plus the environment facts the adapter attaches. */
type DeclaredCheckEnvelope = CheckEnvelope & {
  environment?: CheckEnvironment
  selfRunEnvironment?: CheckEnvironment
}
const isDeclaredCheckEnvironment = (value: unknown): value is CheckEnvironment =>
  typeof value === 'object' && value !== null && 'home' in value && 'sandboxPolicy' in value && 'dependencyLinks' in value && 'checkCacheRoot' in value
/**
 * ENV: the fields an assignment delivery carries about the check environment.
 * `deliverAssignment` writes them and `deliveredEnvironment` reads them back
 * through this one type, so neither side can rename the key alone.
 */
interface AssignmentEnvironment { checkEnvironment?: { note: string; environment: CheckEnvironment; selfRun?: CheckEnvironment } }
/**
 * CORE-05: the verification a declared-check run belongs to: the review task
 * and the attempt its caller proved it holds before the checks ran. The run's
 * durable rows name it, whatever happens to that attempt while they run.
 */
export interface VerificationAttempt { taskId: string; attemptId: string }

export class DeclaredChecks {
  constructor(private readonly k: Kernel, private readonly workspaceAdmission: WorkspaceAdmission) {}

  /**
   * R16-G5a: write one durable tool-run row per declared check of the FAILED
   * first pass, before the retry runs, so a lost process can never lose the
   * record that the check failed once.
   *
   * CORE-05: the rows name the verification attempt the caller holds
   * (`run`'s `verification`), never one read off the board. That attempt may
   * have been fenced while the pass ran (a lease expiry, an owner cancel or
   * amendment, a mission pause or stop, a revoked workspace, a sibling
   * verdict); the rows are still a true record of a host execution against
   * this commit, and since its verdict is then refused, they are all that
   * attempt leaves. Nothing is held in memory across calls, so no later
   * attempt can cite a pass it never ran, and a member's next attempt open
   * when a fenced attempt's pass returns is never credited with that failure.
   *
   * Co-firing guards, named: the retry rule itself (a first pass that passes
   * never reaches here, so a single-pass verification still records exactly one
   * attempt) x `recordRuns` (which must not write this attempt twice: it writes
   * only the deciding pass once these rows exist) x the acceptance basis in
   * `verify` (an acceptance's `checks` basis names only the deciding pass, so
   * these rows never back one; an acceptance with no check row is the
   * reviewer's judgement backed by the reviewer's published review evidence,
   * `reviewEvidence`, never a count of the attempt's runs).
   */
  private recordFirstPass(member: Member, verification: VerificationAttempt, artifact: Artifact, checks: ReadonlyArray<CheckResult>): void {
    this.k.commit(member.missionId, () => {
      let seq = this.k.store.countToolRuns(member.missionId)
      for (const check of checks) {
        const run: ToolRun = { id: id('run'), seq: ++seq, missionId: member.missionId, memberId: member.id, taskId: verification.taskId, attemptId: verification.attemptId, tool: 'swarm.host_verification', arguments: { command: check.command, commit: artifact.commit, attempt: 1 }, result: check, isError: check.exitCode !== 0, createdAt: this.k.now() }
        this.k.store.put('tool_runs', run)
      }
    })
  }

  /**
   * R16-G5a: whether the durable record holds a failed first pass of this
   * attempt at this commit, which `recordRuns` reads to label the pass it
   * writes 2 (a retry) instead of 1. Scoped by attempt id, so a later
   * verification of the same commit can never pair with an earlier attempt's
   * failure. The lookup is scoped by attempt, not by `swarm_verify` call: a
   * second call by the same live attempt, after
   * `[checks_changed_during_verification]` or `[check_environment_mismatch]`,
   * also finds the first call's failed first pass, so its single clean pass is
   * labelled 2. Only that label is off: the verdict and the rows it cites are
   * the second call's own.
   */
  private firstPassRecorded(missionId: string, where: { memberId: string; taskId: string; attemptId: string; commit: string }): boolean {
    return this.k.store.list('tool_runs', missionId).some(run => {
      const args = run.arguments
      if (typeof args !== 'object' || args === null) return false
      const named = args as { attempt?: unknown; commit?: unknown }
      return run.tool === 'swarm.host_verification' && run.isError && run.memberId === where.memberId && run.taskId === where.taskId && run.attemptId === where.attemptId
        && named.attempt === 1 && named.commit === where.commit
    })
  }

  /**
   * The verification window one source's declared checks may occupy. It covers
   * the worst case of the retry rule below: a failing first pass plus its retry.
   */
  windowFor(source: Task): number {
    const checkTimeoutMs = source.checkTimeoutMs ?? this.k.config.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    return checkTimeoutMs * Math.max(1, source.checks.length) * 2 + this.k.config.leaseMs
  }

  /**
   * Run the declared checks through the adapter; the host owns the sandbox.
   *
   * S15 (recorded 2026-09-09, reproduced on 2026-09-10): a declared check can be a
   * wall-clock deadline that assumed an unloaded machine, and the single-strike
   * rule turned one timing accident into a preserve-and-replace cycle — round 13
   * paid two of those and the owner paid one more while gating it. So a failing
   * pass is re-run once on the same artifact and the retry decides: a real
   * failure fails twice, a flake does not. The failed first pass is written
   * durably under `verification` before the retry runs (`recordFirstPass`),
   * never discarded; the verdict records the deciding pass (`recordRuns`).
   *
   * CORE-05: `verification` is the review task and attempt the caller proved it
   * holds (`verify`'s `ownAttempt` before the checks), so the record names the
   * attempt that ran the passes even when it is fenced while they run.
   */
  async run(member: Member, source: Task, artifact: Artifact, verification: VerificationAttempt, signal?: AbortSignal): Promise<CheckResult[]> {
    const first = await this.execute(member, source, artifact, signal)
    if (first.every(check => check.exitCode === 0)) return first
    // R16-G5a: if the process is lost between the two passes, the record of the failure survives.
    this.recordFirstPass(member, verification, artifact, first)
    return await this.execute(member, source, artifact, signal)
  }

  /**
   * Only host-identified infrastructure failures defer a verdict; assertion
   * failures still reject. The adapter reports a check it could not prepare,
   * confine or start as a row (`failureKind` set), so a throw here is a refusal
   * unless it carries an errno code: the backstop for an adapter that throws
   * and for I/O outside its preparation phase.
   */
  private async execute(member: Member, source: Task, artifact: Artifact, signal?: AbortSignal): Promise<CheckResult[]> {
    // Every checkout, the retry's included, is created only after the runtime re-validates.
    await this.workspaceAdmission.assertWorkspaceAuthorized(this.k.mission(source.missionId))
    try { return await this.k.workers.verifyArtifact(member, source, artifact, signal) }
    catch (error) {
      if (signal?.aborted) throw error
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (!['EAGAIN', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT'].includes(code)) throw error
      return [unexecutedCheck('(verification preparation)', error)]
    }
  }

  /** Uncertain execution is not evidence that the artifact's assertions failed. */
  recoveryRequired(checks: ReadonlyArray<CheckResult>): boolean {
    const failures = checks.filter(check => check.exitCode !== 0)
    return failures.length > 0 && failures.every(check => check.failureKind !== undefined)
  }

  /**
   * R11-19: record the measured envelope durably, even when the verdict below
   * fails closed because the world moved during the check. This is the
   * verdict's one read of the adapter's report, and only a record: what the
   * verdict compares is the envelope delivered with its attempt (`reproduce`).
   */
  recordEnvelope(missionId: string, taskId: string, sourceTaskId: string, memberId: string): void {
    const envelope = this.envelope()
    if (envelope === undefined) return
    this.k.commit(missionId, () => this.k.store.event(missionId, 'task/check-envelope', memberId,
      { taskId, sourceTaskId, ...envelope }))
  }

  /**
   * ENV: the adapter's measured envelope, widened to the environment facts it
   * also reports. The one door to that report, read once per assignment
   * delivery and once per verdict; best-effort by contract.
   */
  private envelope(): DeclaredCheckEnvelope | undefined {
    try { return this.k.workers.checkEnvelope?.() as DeclaredCheckEnvelope | undefined }
    catch { return undefined } // reporting the environment must never break a delivery or a verdict
  }

  /**
   * The one writer of an assignment delivery, at a claim and, through
   * `redeliverAssignment`, at a budget resume. Its worker reads the task as
   * `memberTask` renders it, without the preparation record (this attempt's
   * workspace was prepared), beside the facts the host runs its declared
   * checks under (ENV), which `reproduce` reads back from this delivery at the
   * verdict, and the caller's instructions. Returns the task as delivered.
   */
  deliverAssignment(task: Task, instructions: string): Task {
    const { preparationFailure: _retried, ...assigned } = memberTask(this.k.boardOf(task.missionId), task)
    this.k.store.put('deliveries', { id: id('msg'), missionId: task.missionId, from: 'runtime', to: task.attempt!.ownerId, kind: 'assignment', taskId: task.id, attemptId: task.attempt!.id,
      content: JSON.stringify({ missionId: task.missionId, task: assigned, ...this.assignmentFields(), instructions }), createdAt: this.k.now() })
    return assigned
  }

  /**
   * A budget resume hands the same attempt its assignment again. The task's
   * assignment still unsent is superseded by it and settled first, so the
   * worker is handed only the resume.
   */
  redeliverAssignment(task: Task, instructions: string): void {
    for (const delivery of this.k.store.list('deliveries', task.missionId)) {
      if (delivery.kind === 'assignment' && delivery.taskId === task.id && !delivery.deliveredAt) {
        delivery.deliveredAt = this.k.now(); this.k.store.put('deliveries', delivery)
      }
    }
    this.deliverAssignment(task, instructions)
  }

  /** ENV: the facts the host runs a task's declared checks under, as the fields an assignment delivery carries; none when the adapter reports no environment. */
  private assignmentFields(): AssignmentEnvironment {
    const envelope = this.envelope()
    return envelope?.environment === undefined ? {} : { checkEnvironment: {
      note: 'These are the facts the host runs this task\'s declared checks under. Acceptance compares the supporting host checks with this envelope; unrelated diagnostics do not determine the verdict. The scoped cache roots are provided inside the disposable verification checkout; the user cache roots and HOME are what a self-run inherits.',
      environment: envelope.environment,
      ...(envelope.selfRunEnvironment === undefined ? {} : { selfRun: envelope.selfRunEnvironment }),
    } }
  }

  /** ENV: the declared envelope delivered with one attempt's assignment, read back from the durable delivery `deliverAssignment` wrote. */
  private deliveredEnvironment(missionId: string, taskId: string, attemptId: string): CheckEnvironment | undefined {
    for (const delivery of this.k.store.list('deliveries', missionId)) {
      if (delivery.kind !== 'assignment' || delivery.taskId !== taskId || delivery.attemptId !== attemptId) continue
      try {
        const { checkEnvironment } = JSON.parse(delivery.content) as Partial<Record<keyof AssignmentEnvironment, { environment?: unknown }>>
        const environment = checkEnvironment?.environment
        if (isDeclaredCheckEnvironment(environment)) return environment
      } catch { /* a delivery without the envelope simply has none */ }
    }
    return undefined
  }

  /**
   * ENV: compare the envelope delivered to one verification attempt with the
   * environment the host recorded on that artifact's declared checks, and make
   * a divergence durable before the verdict reads the comparison, so a later
   * reader sees both environments, not only a refusal. Both sides are
   * host-measured: the runtime constructs the envelope and runs the declared
   * checks itself, so nothing here is inferred from a member's command text.
   * The delivered envelope is the one basis: an attempt delivered none (the
   * adapter reported none when it was assigned) has nothing to compare, and
   * neither has a verdict with no host check outcome that carries an
   * environment; such a verdict rests on its host checks alone, whatever the
   * adapter reports when it verifies.
   */
  reproduce(where: { missionId: string; taskId: string; sourceTaskId: string; attemptId: string; memberId: string; verdict: 'accept' | 'reject' },
    checks: ReadonlyArray<CheckResult>): CheckEnvironmentComparison | undefined {
    if (checks.length === 0) return undefined
    const envelope = this.deliveredEnvironment(where.missionId, where.taskId, where.attemptId)
    if (envelope === undefined) return undefined
    // Declared host checks are the supporting executions. A later unrelated
    // diagnostic cannot substitute its environment for those immutable-artifact checks.
    const selfRun = checks.find(check => check.environment !== undefined && compareCheckEnvironments(envelope, check.environment).blocking.length > 0)?.environment
      ?? checks.find(check => check.environment !== undefined)?.environment
    if (selfRun === undefined) return undefined
    const comparison = compareCheckEnvironments(envelope, selfRun)
    if (comparison.blocking.length === 0 && comparison.advisory.length === 0) return comparison
    const attribution = checks.find(check => check.attribution !== undefined)?.attribution
    this.k.commit(where.missionId, () => this.k.store.event(where.missionId, 'task/check-envelope', where.memberId, {
      taskId: where.taskId, sourceTaskId: where.sourceTaskId, verdict: where.verdict, reproduction: 'check-environment-mismatch',
      envelope, selfRun, selfRunSource: 'host-check', selfRunAt: this.k.now(), blocking: comparison.blocking, advisory: comparison.advisory,
      ...(attribution === undefined ? {} : { attribution }),
    }))
    return comparison
  }

  /** The verdict's check outcome: a rejection is the reviewer's to earn. */
  classify(verdict: 'accept' | 'reject', checks: ReadonlyArray<{ command: string; exitCode: number; output: string; truncated?: boolean }>): { passed: boolean; failingChecks: Array<{ command: string; exitCode: number; output: string; truncated?: boolean }> } {
    const passed = verdict === 'accept' && checks.every(check => check.exitCode === 0)
    return { passed, failingChecks: checks.filter(check => check.exitCode !== 0) }
  }

  /**
   * One durable tool-run row per declared check of the deciding pass, in order,
   * in the same transaction as the verdict, each row naming its pass, command,
   * exit code and output. When the retry rule fired, the failed first pass is
   * already durable under the same attempt (`recordFirstPass` wrote it before
   * the retry, and a lost process keeps those rows), so this writes the
   * deciding pass as attempt 2 — never a second copy of attempt 1 — and the
   * durable record shows the flake instead of hiding it. The returned ids are
   * the deciding pass's rows, which is what the acceptance/rejection event
   * names. The lookup is scoped by attempt id, so a re-verification of the same
   * commit records its own attempt 1 instead of pairing with an older failure.
   */
  recordRuns(missionId: string, where: { memberId: string; taskId: string; attemptId: string; commit: string },
    checks: ReadonlyArray<CheckResult>): string[] {
    const attempt = this.firstPassRecorded(missionId, where) ? 2 : 1
    let seq = this.k.store.countToolRuns(missionId)
    return checks.map(check => {
      const run: ToolRun = { id: id('run'), seq: ++seq, missionId, memberId: where.memberId, taskId: where.taskId, attemptId: where.attemptId, tool: 'swarm.host_verification', arguments: { command: check.command, commit: where.commit, attempt }, result: check, isError: check.exitCode !== 0, createdAt: this.k.now() }
      this.k.store.put('tool_runs', run)
      return run.id
    })
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
    if (prose.length + fixed > this.k.config.maxMessageChars) {
      // The check evidence is the part that must never be lost: excerpt the prose to fit.
      const proseBudget = Math.max(0, this.k.config.maxMessageChars - fixed - 48)
      prose = `${prose.slice(0, proseBudget)} …[reviewer reason truncated]`
    }
    let remaining = Math.max(0, this.k.config.maxMessageChars - prose.length - fixed)
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
    return report.length <= this.k.config.maxMessageChars ? report : `${report.slice(0, Math.max(0, this.k.config.maxMessageChars - marker.length))}${marker}`
  }
}
