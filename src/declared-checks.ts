/**
 * The declared-check execution path: the bounded timeout window, the host call
 * that runs the task's declared checks, the measured envelope record, the
 * pass/fail classification, the durable tool-run row per check and the rejection
 * text; and the check environment: the envelope an assignment delivers, its
 * reproduction by the host checks that support a verdict and the refusal of an
 * acceptance they do not reproduce.
 *
 * Check executions are outside the mission transaction; the verdict records
 * their exact outcomes and retains bounded retry evidence. Explicit execution
 * failures can defer review without converting infrastructure into a code verdict.
 */
import { id } from './store.ts'
import { openAttempt } from './task-graph.ts'
import type { Kernel } from './kernel.ts'
import type { WorkspaceAdmission } from './workspace-admission.ts'
import type { Artifact, CheckEnvelope, CheckEnvironment, CheckResult, Member, Task, ToolRun } from './types.ts'

/** Host verification timeout when a task chose none; matches the plugin config default. */
const DEFAULT_CHECK_TIMEOUT_MS = 60000

/** A rejection names at most this many failing checks; the rest are counted. */
export const MAX_REPORTED_CHECK_FAILURES = 4

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

/** A deferred review's exit: its last classified failure's (a pass stops at its first failing check), or resuming when no row has a kind. */
export function recoveryExit(checks: ReadonlyArray<CheckResult>): string {
  const failure = checks.findLast(check => check.failureKind !== undefined)
  return failure?.failureKind === undefined ? RESUME : RECOVERY_EXITS[failure.failureKind](failure)
}

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
 * `assignmentFields` writes them and `deliveredEnvironment` reads them back
 * through this one type, so neither side can rename the key alone.
 */
interface AssignmentEnvironment { checkEnvironment?: { note: string; environment: CheckEnvironment; selfRun?: CheckEnvironment } }

export class DeclaredChecks {
  /**
   * S15: the attempts of the verification in flight. The key is
   * `memberId:commit:sourceTaskId`, not `memberId:commit`: `run()` executes
   * outside the mission lock and `recordRuns()` inside a later exclusive section,
   * so two concurrent verifications by one member on one artifact could otherwise
   * swap their held passes. The reviewed source is available on both sides —
   * `run()` gets the source, and `recordRuns()` reads the verification task's
   * `reviewOf` from the store — so the pairing is exact without a new parameter.
   *
   * R16-G5a: this map is only a cache now. A failed first pass is written to the
   * durable `tool_runs` table before the retry starts (`recordFirstPass`), so a
   * lost process can no longer lose the record that the check failed once. The
   * map remains for the one case the durable rows cannot cover: a verification
   * task that cannot be resolved from the board at the moment the first pass
   * fails, where the pair is still held in-process and recorded by `recordRuns`.
   */
  private readonly checkRuns = new Map<string, CheckResult[][]>()

  constructor(private readonly k: Kernel, private readonly workspaceAdmission: WorkspaceAdmission) {}

  /** The reviewed source a verification task belongs to. */
  private sourceOf(verificationTaskId: string): string {
    return this.k.store.get('tasks', verificationTaskId)?.reviewOf ?? verificationTaskId
  }

  /**
   * R16-G5a: the verification task this member is running for one source, with
   * its live attempt. Derived from the board for the same reason `sourceOf` is:
   * `run()` has the member and the source, `recordRuns()` has the attempt id, and
   * the durable rows must name the verification consistently on both sides.
   */
  private verificationAttempt(member: Member, source: Task): { taskId: string; attemptId: string } | undefined {
    const open = openAttempt(this.k.store.list('tasks', member.missionId), member.id)
    return open?.kind === 'verification' && open.reviewOf === source.id ? { taskId: open.id, attemptId: open.attempt.id } : undefined
  }

  /**
   * R16-G5a: write one durable tool-run row per declared check of the FAILED
   * first pass, before the retry runs. Returns false when the verification task
   * cannot be resolved (the caller then keeps the pair in memory).
   *
   * Co-firing guards, named: the retry rule itself (a first pass that passes
   * never reaches here, so a single-pass verification still records exactly one
   * attempt) x `recordRuns` (which must not write this attempt twice: it writes
   * only the deciding pass once these rows exist) x the accept-evidence check in
   * `verify` (a failing check row is `isError`, so it can never satisfy
   * "acceptance requires independent host-recorded verification evidence").
   */
  private recordFirstPass(member: Member, source: Task, artifact: Artifact, checks: ReadonlyArray<CheckResult>): boolean {
    const verification = this.verificationAttempt(member, source)
    if (verification === undefined) return false
    this.k.commit(member.missionId, () => {
      let seq = this.k.store.countToolRuns(member.missionId)
      for (const check of checks) {
        const run: ToolRun = { id: id('run'), seq: ++seq, missionId: member.missionId, memberId: member.id, taskId: verification.taskId, attemptId: verification.attemptId, tool: 'swarm.host_verification', arguments: { command: check.command, commit: artifact.commit, attempt: 1 }, result: check, isError: check.exitCode !== 0, createdAt: this.k.now() }
        this.k.store.put('tool_runs', run)
      }
    })
    return true
  }

  /**
   * R16-G5a: whether the durable record already holds this attempt's failed first
   * pass. Scoped by attempt id, so a later verification of the same commit can
   * never pair with an earlier attempt's failure.
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
   * failure fails twice, a flake does not. The first pass is kept for the durable
   * record (see `recordRuns`), never discarded.
   */
  async run(member: Member, source: Task, artifact: Artifact, signal?: AbortSignal): Promise<CheckResult[]> {
    const key = `${member.id}:${artifact.commit}:${source.id}`
    const first = await this.execute(member, source, artifact, signal)
    if (first.every(check => check.exitCode === 0)) { this.checkRuns.delete(key); return first }
    // R16-G5a: the failed first pass is durable before the retry starts. If the
    // process is lost between the two passes, the record of the failure survives;
    // when the verification task cannot be resolved, the pair stays in memory.
    const durable = this.recordFirstPass(member, source, artifact, first)
    const retry = await this.execute(member, source, artifact, signal)
    if (!durable) this.checkRuns.set(key, [first, retry])
    return retry
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
   * fails closed because the world moved during the check.
   */
  recordEnvelope(missionId: string, taskId: string, sourceTaskId: string, memberId: string): void {
    const envelope = this.k.workers.checkEnvelope?.()
    if (envelope === undefined) return
    this.k.commit(missionId, () => this.k.store.event(missionId, 'task/check-envelope', memberId,
      { taskId, sourceTaskId, ...envelope }))
  }

  /** ENV: the adapter's measured envelope, widened to the environment facts it also reports. */
  private envelope(): DeclaredCheckEnvelope | undefined {
    try { return this.k.workers.checkEnvelope?.() as DeclaredCheckEnvelope | undefined }
    catch { return undefined } // reporting the environment must never break a delivery or a verdict
  }

  /** ENV: the facts the host runs a task's declared checks under, as the fields an assignment delivery carries; none when the adapter reports no environment. */
  assignmentFields(): AssignmentEnvironment {
    const envelope = this.envelope()
    return envelope?.environment === undefined ? {} : { checkEnvironment: {
      note: 'These are the facts the host runs this task\'s declared checks under. Acceptance compares the supporting host checks with this envelope; unrelated diagnostics do not determine the verdict. The scoped cache roots are provided inside the disposable verification checkout; the user cache roots and HOME are what a self-run inherits.',
      environment: envelope.environment,
      ...(envelope.selfRunEnvironment === undefined ? {} : { selfRun: envelope.selfRunEnvironment }),
    } }
  }

  /** ENV: the declared envelope delivered with one attempt's assignment, read back from the durable delivery `assignmentFields` wrote. */
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
   * environment the host recorded on that artifact's declared checks. Both sides
   * are host-measured: the runtime constructs the envelope and runs the declared
   * checks itself, so nothing here is inferred from a member's command text. An
   * attempt with no delivered envelope, or with no host check outcome that
   * carries an environment, has nothing to compare and the verdict proceeds as
   * before.
   */
  reproduction(missionId: string, taskId: string, attemptId: string, checks: ReadonlyArray<{ environment?: CheckEnvironment }>):
    { envelope: CheckEnvironment; selfRun: CheckEnvironment; source: 'host-check'; at: number; comparison: CheckEnvironmentComparison } | undefined {
    if (checks.length === 0) return undefined
    const envelope = this.deliveredEnvironment(missionId, taskId, attemptId) ?? this.envelope()?.environment
    if (envelope === undefined) return undefined
    // Declared host checks are the supporting executions. A later unrelated
    // diagnostic cannot substitute its environment for those immutable-artifact checks.
    const measured = checks.find(check => check.environment !== undefined && compareCheckEnvironments(envelope, check.environment).blocking.length > 0)?.environment
      ?? checks.find(check => check.environment !== undefined)?.environment
    if (measured === undefined) return undefined
    return { envelope, selfRun: measured, source: 'host-check', at: this.k.now(), comparison: compareCheckEnvironments(envelope, measured) }
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
   *
   * R16-G5a: the first pass may already be durable (`recordFirstPass` wrote it
   * before the retry, and a lost process keeps those rows). Then this transaction
   * writes only the deciding pass, as attempt 2 — never a second copy of attempt
   * 1. The lookup is scoped by attempt id, so a re-verification of the same
   * commit records its own attempt 1 instead of pairing with an older failure.
   */
  recordRuns(missionId: string, where: { memberId: string; taskId: string; attemptId: string; commit: string },
    checks: ReadonlyArray<CheckResult>): string[] {
    const key = `${where.memberId}:${where.commit}:${this.sourceOf(where.taskId)}`
    const held = this.checkRuns.get(key)
    this.checkRuns.delete(key)
    const recorded: Array<{ attempt: number; checks: ReadonlyArray<CheckResult> }> = held !== undefined
      ? [{ attempt: 1, checks: held[0]! }, { attempt: 2, checks: held[1]! }]
      : this.firstPassRecorded(missionId, where)
        ? [{ attempt: 2, checks }]
        : [{ attempt: 1, checks }]
    const ids: string[] = []
    let seq = this.k.store.countToolRuns(missionId)
    for (const [index, entry] of recorded.entries()) {
      const deciding = index === recorded.length - 1
      for (const check of entry.checks) {
        const run: ToolRun = { id: id('run'), seq: ++seq, missionId, memberId: where.memberId, taskId: where.taskId, attemptId: where.attemptId, tool: 'swarm.host_verification', arguments: { command: check.command, commit: where.commit, attempt: entry.attempt }, result: check, isError: check.exitCode !== 0, createdAt: this.k.now() }
        this.k.store.put('tool_runs', run); if (deciding) ids.push(run.id)
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
