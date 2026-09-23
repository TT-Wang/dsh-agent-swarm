/** Owned Git worktrees and immutable artifacts. The source checkout is read-only. */
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { scrubbedParentEnv, type SubprocessHandle, type SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { reauthorizeWorkspace, type WorkspaceGrantSnapshot } from './authorization.js'
import { withinScope } from './scope.js'
import { PolicyError } from './policy-error.js'
import { captureGitSnapshot } from './git-snapshot.js'
import type { Artifact, CheckAttribution, CheckEnvelope, CheckEnvironment, CheckResult, CheckSyntaxIssue, Member, Mission, RecoveryFallback, Task, VerificationCleanupFailure, WorkspaceBaseline } from './types.js'
export type { CheckAttribution, CheckEnvelope, CheckEnvironment, CheckResult }

/** Full-repository path inventories are metadata, not user-visible check output. */
const INVENTORY_BYTES = 16 * 1024 * 1024
/**
 * Ignored dependency directories materialised into a clean verification
 * checkout when `verificationDependencyDirs` is not configured. npm is the
 * default ecosystem, but a foreign toolchain keeps its interpreter and packages
 * in a project-local directory too: a Python `.venv`/`venv`, a Go `vendor`, a
 * tox `.tox`. Each name is matched as a path component at any depth (a nested
 * `packages/x/node_modules` or `services/y/.venv` is materialised as well), and
 * only a gitignored directory is materialised. Configure the option to replace
 * this list; `[]` disables materialisation.
 */
export const DEFAULT_VERIFICATION_DEPENDENCY_DIRS: readonly string[] = ['node_modules', '.venv', 'venv', 'vendor', '.tox']
/**
 * F3: the per-member scratch directory name INSIDE a member worktree. The worker
 * adapter points `TMPDIR`/`TMP`/`TEMP` at it, so a member's temporary state has
 * to be writable under its own `workspace-write` sandbox (a sibling of the
 * worktree is not) while still never dirtying a deliverable. It is treated
 * exactly like a dependency directory — invisible to `status`, kept out of
 * checkpoints and artifacts — but it is never materialised into a verification
 * checkout, because it holds a live session's temporary files rather than an
 * installed toolchain.
 */
export const SWARM_SCRATCH_DIRNAME = '.swarm-scratch'
export interface WorkspaceOptions {
  workspacesRoot: string
  checkTimeoutMs: number
  maxCheckOutputBytes: number
  checkEnv?: Record<string, string>
  /**
   * Ignored dependency directory names (such as `node_modules` or a Python
   * `.venv`) linked from the source checkout into each clean verification
   * checkout, so declared checks find installed toolchains. Default:
   * `DEFAULT_VERIFICATION_DEPENDENCY_DIRS` (`node_modules`, `.venv`, `venv`,
   * `vendor`, `.tox`). Empty disables.
   */
  verificationDependencyDirs?: string[]
  /**
   * How ignored dependency directories reach a verification checkout.
   * `copy` (the effective default) clones the directory into the checkout, so
   * no path inside the materialised directory can resolve back into the source
   * checkout and a declared check cannot read uncommitted host state through
   * `node_modules/../UNCOMMITTED.txt` (R11-13). `link` symlinks the source
   * directory read-through and is honored only with the explicit
   * `allowDependencyLinkReads` opt-in, because a symlinked directory lets `..`
   * resolve to the symlink target's parent chain: the check reads the real
   * toolchain without copying it, at the cost of exposing the source checkout.
   * Every check still runs under the Harness sandbox rooted at the checkout and
   * is refused unless the host reports full enforcement (F-29), but that
   * enforcement governs writes, not reads.
   */
  verificationDependencyMode?: 'link' | 'copy'
  /**
   * R11-13: explicitly accept the read-through dependency link and the source
   * checkout reads it enables. Default false: even a configured `link` mode
   * materialises a copy, because a symlinked dependency directory lets a
   * declared check resolve `node_modules/..` (and `node_modules/pkg/../..`)
   * back to the source checkout and read uncommitted files. Set true only on a
   * host that knowingly accepts that cross-tenant read channel.
   */
  allowDependencyLinkReads?: boolean
  /**
   * Called when a disposable verification checkout cannot be removed. Cleanup
   * failure is reported here and never masks the check results. The adapter
   * forwards it to the runtime, which records the event and the owner notice
   * (H-3 follow-up). Required: this callback is the ONLY reader of a cleanup
   * failure, so an unwired construction silently loses it — that gap is a
   * compile error rather than a quiet hole.
   */
  onCleanupFailure(info: VerificationCleanupFailure): void
  /**
   * Called when a cross-owner recovery cannot capture the previous owner's
   * workspace as an artifact (W9). The dirty worktree is left untouched; its
   * WIP is carried to the replacement by a preservation snapshot when that
   * succeeds (H-3), and the report says which. The adapter forwards it to the
   * runtime, which records the event, the owner notice and the task summary.
   * Required for the same reason as `onCleanupFailure`.
   */
  onRecoveryFallback(info: RecoveryFallback): void
  /**
   * Human-authorized roots loaded once at plugin start. When supplied, every
   * baseline preparation, member workspace and verification checkout
   * re-validates the mission's recorded `workspaceGrantRoot`, so a root the
   * human removed from configuration fences the mission instead of letting it
   * continue against an unauthorized root. Absent in unit fixtures that drive
   * `Workspaces` directly; the recorded admission result then stands.
   */
  grants?: WorkspaceGrantSnapshot
  /**
   * R11-19: maximum declared-check executions per host process. Verifications
   * beyond the limit wait in a FIFO queue; every wait and run is measured and
   * reported through `checkEnvelope()`. Default 2.
   */
  checkConcurrency?: number
  /**
   * ENV: the confinement policy the host applies to a declared check. Defaults
   * to the contract every caller must satisfy: `workspace-write` rooted at the
   * clean verification checkout, and the check runs only when the host reports
   * full enforcement (F-29), so a check that ran proves the effective policy.
   * A host with a different confinement states it here.
   */
  sandboxPolicy?: { mode?: string; enforcement?: string }
  /** Required in production: wrap checks in the host's execution confinement. */
  confineCheck(argv: string[], cwd: string): Promise<string[]> | string[]
  /**
   * The host's managed-process seam every command in this instance runs through
   * (`ctx.get('subprocess')` in the adapter). Read at each start rather than
   * captured, so a workspace built before the provider mounts still executes
   * once it does. Absent refuses the command with a named error instead of
   * spawning an unmanaged process.
   */
  subprocess?: ProcessSeamSource
}
const DEFAULT_CHECK_CONCURRENCY = 2
/** The stand-in checkout path a declared envelope names before a check has a real one. */
/**
 * Bounded budget for one host git operation (worktree add, capture, commit).
 * It is deliberately not the declared-check budget: round 14 lost three
 * verification verdicts because a checkout under load exceeded the 60 s check
 * budget and `git worktree add` was cancelled while the artifact was fine.
 */
export const HOST_GIT_TIMEOUT_MS = 5 * 60_000

export const CHECKOUT_PLACEHOLDER = '<verification-checkout>'
/**
 * ENV: the measured envelope plus the declared-check environment.
 * `environment` is the declared envelope the runtime delivers to the assignee
 * and compares with the environment recorded on the declared host checks it
 * ran: blocking divergences (HOME, the user cache roots, the sandbox policy,
 * the dependency links) refuse an acceptance, the existence flags are
 * advisory, because a cold cache is not a wrong environment.
 * `selfRunEnvironment` is delivered beside it as the baseline a member's own
 * commands inherit; it is reported to the assignee, never compared. The facts
 * of a check that actually ran live on its own `CheckResult` row
 * (`environment`, `attribution`), which is what the durable `tool_runs` record carries.
 */
export interface DeclaredCheckEnvelope extends CheckEnvelope {
  environment: CheckEnvironment
  selfRunEnvironment: CheckEnvironment
}
/** Bounded attribution capture: names kept, and the longest name kept. */
const MAX_ATTRIBUTED_FAILURES = 50
const MAX_ATTRIBUTED_NAME = 200
/** Scan carry: a line longer than this is not a TAP or stage line this attribution needs. */
const MAX_ATTRIBUTION_CARRY = 4096
/**
 * ENV: read the failing test names, the TAP summary and the failing stage out of
 * the process stream as it is produced. The stored output is bounded and the
 * interesting lines are exactly the ones a bound cuts off (TAP writes the
 * failing test after every passing one and the summary last), so attribution is
 * captured from every chunk — including chunks dropped at the bound.
 */
class CheckOutputScanner {
  private readonly decoder = new StringDecoder('utf8')
  private carry = ''
  private stage: string | null = null
  private subtest: string | null = null
  private failingStage: string | null = null
  private failingSubtest: string | null = null
  private readonly failingTests: string[] = []
  private failingTestCount = 0
  private failed = false
  private specFailureSummary = false
  private readonly summary = new Map<string, string>()
  private plan: string | null = null
  push(chunk: Buffer): void {
    // A chunk can split a multi-byte character; decode through the stream decoder
    // so a TAP name is never corrupted at a chunk boundary.
    this.carry += this.decoder.write(chunk)
    let end = this.carry.indexOf('\n')
    while (end !== -1) {
      this.line(this.carry.slice(0, end).replace(/\r$/, ''))
      this.carry = this.carry.slice(end + 1)
      end = this.carry.indexOf('\n')
    }
    if (this.carry.length > MAX_ATTRIBUTION_CARRY) this.carry = this.carry.slice(-MAX_ATTRIBUTION_CARRY)
  }
  /**
   * ENV (2026-09-11 review): `node --test` writes TAP only when its reporter
   * picks TAP. Node 24's default reporter is `spec` even on a pipe (`✔ name`,
   * `✖ name`, `ℹ fail 1`), so a Node 24 check produced exit codes with NO
   * attribution at all while this scanner read TAP alone — a silent evidence
   * loss on a runtime the package's own `engines` declares supported. Both
   * formats are read here; a foreign format simply contributes nothing, which is
   * the pre-existing behaviour.
   */
  private line(text: string): void {
    if (/^(?:\$|>)\s+/.test(text)) this.specFailureSummary = false
    // Spec repeats failures below this footer. Ignore that section, not repeated
    // names in the live stream: different suites may use the same test name.
    if (/^\s*✖\s+failing tests:\s*$/.test(text)) { this.specFailureSummary = true; return }
    const tap = /^\s*not ok\s+\d+\s*-\s+(.*\S)\s*$/.exec(text)
    // `✖ failing test (12.3ms)` — the spec reporter's failure marker, optional
    // leading indentation for nested subtests, optional trailing duration.
    const spec = tap === null ? /^\s*✖\s+(.*?)(?:\s+\(\d+(?:\.\d+)?(?:ms|s)\))?\s*$/.exec(text) : null
    // The spec reporter prints its own section header (`✖ failing tests:`) with
    // the same marker; it names no test and must not become one.
    const failure = tap ?? (spec !== null && /^(?:failing )?tests?:$/.test(spec[1]!.trim()) ? null : spec)
    const name = failure === null ? null : (spec === null ? failure[1]! : failure[1]!.replace(/\s*\(\d+(?:\.\d+)?(?:ms|s)\)\s*$/, ''))
    if (name !== null) {
      if (spec !== null && this.specFailureSummary) return
      if (!this.failed) { this.failed = true; this.failingStage = this.stage; this.failingSubtest = this.subtest }
      this.failingTestCount++
      if (this.failingTests.length < MAX_ATTRIBUTED_FAILURES) this.failingTests.push(name.slice(0, MAX_ATTRIBUTED_NAME))
      return
    }
    if (!this.failed) {
      // `▶ suite name` is the spec reporter's suite marker; the TAP trio stays.
      const stage = /^>\s+(\S.*\S|\S)\s*$/.exec(text) ?? /^\$\s+(\S.*\S|\S)\s*$/.exec(text) ?? /^#\s*stage:\s*(\S.*\S|\S)\s*$/i.exec(text) ?? /^\s*▶\s+(\S.*\S|\S)\s*$/.exec(text)
      if (stage !== null) this.stage = stage[1]!.slice(0, MAX_ATTRIBUTED_NAME)
      const subtest = /^#\s*Subtest:\s*(\S.*\S|\S)\s*$/.exec(text)
      if (subtest !== null) this.subtest = subtest[1]!.slice(0, MAX_ATTRIBUTED_NAME)
    }
    const summary = /^#\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b\s*(.*)$/.exec(text)
      ?? /^\s*ℹ\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b\s*(.*)$/.exec(text)
    if (summary !== null) { this.summary.set(summary[1]!, text.trim()); return }
    const plan = /^1\.\.(\d+)\s*$/.exec(text) ?? /^\s*ℹ\s*tests\s+(\d+)\s*$/.exec(text)
    if (plan !== null) this.plan = text.trim()
  }
  result(outputTruncated: boolean): CheckAttributionShot {
    return { stage: this.failingStage ?? this.stage, subtest: this.failingSubtest ?? this.subtest,
      failingTests: [...this.failingTests], failingTestCount: this.failingTestCount,
      tapSummary: [...(this.plan === null ? [] : [this.plan]), ...this.summary.values()], outputTruncated }
  }
}
/** ENV: what the scanner extracts from a stream before the call site labels it. */
export interface CheckAttributionShot { stage: string | null; subtest: string | null; failingTests: string[]; failingTestCount: number; tapSummary: string[]; outputTruncated: boolean }
/**
 * R11-19: a per-host FIFO semaphore over declared-check executions. A queued
 * verification is not lost and not run unconfined; its wait is measured so the
 * owner can see the queueing the lease has to survive.
 */
export class CheckSemaphore {
  private active = 0
  private readonly waiters: Array<{ resolve: (handedOff: boolean) => void; reject: (error: unknown) => void; signal?: AbortSignal; onAbort?: () => void }> = []
  private maxActive = 0
  private completed = 0
  private totalWaitMs = 0
  private maxWaitMs = 0
  private totalRunMs = 0
  private maxRunMs = 0
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('checkConcurrency must be a positive safe integer')
  }
  /**
   * Resolves with the queue wait in milliseconds; rejects when the caller
   * aborts while queued. A slot freed by `release` is handed directly to the
   * oldest waiter, so `active` can never exceed the configured limit even when
   * a new caller arrives in the same tick.
   */
  async acquire(signal?: AbortSignal): Promise<number> {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted before the check could be queued')
    const started = Date.now()
    const handedOff = this.active >= this.limit && await new Promise<boolean>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject, signal }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(signal.reason ?? new Error('Aborted while queued for a check slot'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
    const waitMs = Math.max(0, Date.now() - started)
    if (!handedOff) {
      this.active++
      this.maxActive = Math.max(this.maxActive, this.active)
    }
    this.totalWaitMs += waitMs
    this.maxWaitMs = Math.max(this.maxWaitMs, waitMs)
    return waitMs
  }
  /** Release one slot: hand it to the oldest waiter, or free it. */
  release(runMs: number): void {
    this.completed++
    this.totalRunMs += Math.max(0, runMs)
    this.maxRunMs = Math.max(this.maxRunMs, Math.max(0, runMs))
    const next = this.waiters.shift()
    if (next === undefined) { this.active = Math.max(0, this.active - 1); return }
    if (next.onAbort !== undefined) next.signal?.removeEventListener('abort', next.onAbort)
    next.resolve(true)
  }
  state(): CheckEnvelope {
    return { limit: this.limit, active: this.active, queued: this.waiters.length, maxActive: this.maxActive, completed: this.completed,
      totalWaitMs: this.totalWaitMs, maxWaitMs: this.maxWaitMs, totalRunMs: this.totalRunMs, maxRunMs: this.maxRunMs }
  }
}
export type { RecoveryFallback, VerificationCleanupFailure } from './types.js'
/** Persisted on the task workspace record so the fallback survives restarts. */
interface TaskRecovery { commit: string; previousOwnerId: string; preserved: boolean; reason: string; at: number }
/** Reject a symlink whose target string alone leaves its owning workspace (fast pre-commit check). */
function assertContainedSymlink(workspace: string, relative: string, target: string): void {
  if (!target || target.includes('\0') || path.isAbsolute(target)) throw new Error(`Artifact symlink escapes the mission workspace: ${relative} -> ${JSON.stringify(target)}`)
  const root = path.resolve(workspace)
  const resolved = path.resolve(path.dirname(path.join(root, relative)), target)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Artifact symlink escapes the mission workspace: ${relative} -> ${JSON.stringify(target)}`)
}
/** One resolved component of a symlink-chain walk; a non-link entry stops resolution. */
export type SymlinkChainEntry = { kind: 'file' } | { kind: 'directory' } | { kind: 'symlink'; target: string }
/** Look up one workspace-relative path in the tree being validated, or undefined when absent. */
export type SymlinkChainLookup = (relative: string) => Promise<SymlinkChainEntry | undefined>
/** Bound a chain so a symlink cycle cannot spin; the kernel's own limit is platform-specific. */
const MAX_SYMLINK_CHAIN = 40

/**
 * Reject a symlink whose *resolved chain* leaves its owning workspace. A target
 * string that is lexically contained is not enough (F-C1): the base tree can
 * already contain an escaping link, or a link to one, so every component of the
 * resolved path is walked through `lookup` until a non-link entry or the root
 * is reached. `lookup` reads the authoritative tree (a commit for artifacts and
 * deliveries), never the link's target string alone, so a chain is refused
 * exactly when materializing it would read outside the root.
 * @param relative - the link's workspace-relative path.
 * @param target - the link's raw target string (already decoded as UTF-8).
 * @param lookup - resolves one relative path in the same tree.
 * @param prefix - the error message prefix naming what is being validated.
 */
export async function assertContainedSymlinkChain(relative: string, target: string, lookup: SymlinkChainLookup, prefix: string): Promise<void> {
  const reject = (): never => { throw new Error(`${prefix}: ${relative} -> ${JSON.stringify(target)}`) }
  if (!target || target.includes('\0') || path.isAbsolute(target)) reject()
  // Resolve the link's parent directory and its target together: a symlink
  // component is replaced in place by its target, relative to the link's own
  // directory, exactly like the kernel's component-by-component lookup.
  const queue = [...relative.split('/').slice(0, -1), ...target.split('/')]
  const resolved: string[] = []
  let links = 0
  while (queue.length > 0) {
    const part = queue.shift()!
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (resolved.length === 0) reject()
      resolved.pop()
      continue
    }
    if (part.includes('\0')) reject()
    resolved.push(part)
    const entry = await lookup(resolved.join('/'))
    if (entry === undefined || entry.kind !== 'symlink') continue
    if (++links > MAX_SYMLINK_CHAIN) throw new Error(`${prefix} does not resolve within ${MAX_SYMLINK_CHAIN} links: ${relative} -> ${JSON.stringify(target)}`)
    const next = entry.target
    if (!next || next.includes('\0') || path.isAbsolute(next)) reject()
    resolved.pop()
    queue.unshift(...next.split('/'))
  }
}
interface MissionWorkspace { version: 1; missionId: string; source: string; baseCommit: string; baseline?: WorkspaceBaseline; workspaceGrantRoot?: string; workspaceAuthorizationSource?: 'session' | 'grant' }
const INTEGRATION_CONFLICT_FILE = '.swarm-integration-conflicts.json'
interface IntegrationConflict { dependencyId: string; commit: string; paths: string[] }
interface TaskBase { taskId: string; epoch: number; baseCommit: string; capturedCommit?: string; preservedCommit?: string; recovery?: TaskRecovery
  dependencyCommits?: string[]; integrationConflicts?: IntegrationConflict[]; preservationPaths?: string[] }
function validRecoveryPath(name: string): boolean {
  return name.length > 0 && !path.isAbsolute(name) && !/[\u0000-\u001f]/.test(name) && !name.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
}
interface MemberWorkspace { version: 1; missionId: string; memberId: string; workspace: string; task?: TaskBase }
interface TaskWorkspace { version: 1; missionId: string; memberId: string; workspace: string; task: TaskBase }
/**
 * The narrow slice of the host's subprocess capability (`ctx.subprocess`) this
 * plugin executes through. Every process this plugin starts — the Git plumbing
 * on its own worktrees, a worker's shell-syntax probe, a declared check — is one
 * `spawn` of a fully specified spec; range ownership, signalling and quiescence
 * belong to the provider behind the seam (its TERM-before-KILL staging, its
 * spill and drain bounds, its host-exit force-stop).
 */
export interface ProcessSeam { spawn(spec: SubprocessSpawnSpec): SubprocessHandle }
/**
 * Resolve the seam at the moment a command starts. A resolver rather than a
 * value because the provider's mount order is the host's business: a workspace
 * built during plugin load must still execute commands once the service is
 * active, and a host that mounts none refuses at the point of use.
 */
export type ProcessSeamSource = () => ProcessSeam | undefined
interface ProcessOptions { cwd: string; signal?: AbortSignal; timeoutMs: number; maxBytes: number; env?: Record<string, string>; captureAttribution?: boolean; subprocess?: ProcessSeamSource }
/**
 * Worktree metadata mutation queues keyed by canonical git common dir. Git
 * publishes `.git/worktrees/<name>/commondir` non-atomically, so concurrent
 * `git worktree add` calls in one repository can observe a half-written file
 * and fail with `git worktree failed (128): failed to read .../commondir`,
 * which blocks the task. Module scope makes every Workspaces instance in one
 * process share the queue for a repository.
 */
const worktreeQueues = new Map<string, Promise<void>>()
const WORKTREE_METADATA_RACE = /(?:failed|unable) to read .*commondir/i

/**
 * ENV: one bounded output window over a command's two streams. The retained
 * text is the HEAD of the stream (its first `maxBytes`), because a check's first
 * failing lines are the evidence a verifier reads; attribution is scanned over
 * every chunk, including the chunks the bound drops, because the failing test
 * and the TAP summary arrive after it. The window is the plugin's, not the
 * provider's: the seam's own collector keeps the tail and is never enabled here.
 */
class ProcessOutput {
  private bytes = 0
  private truncated = false
  private readonly chunks: Buffer[] = []
  private readonly scanner: CheckOutputScanner | undefined
  constructor(private readonly maxBytes: number, captureAttribution: boolean) {
    this.scanner = captureAttribution ? new CheckOutputScanner() : undefined
  }
  push(chunk: Buffer): void {
    this.scanner?.push(chunk)
    const available = Math.max(0, this.maxBytes - this.bytes)
    if (chunk.length > available) this.truncated = true
    if (available > 0) { const kept = chunk.subarray(0, available); this.chunks.push(kept); this.bytes += kept.length }
  }
  result(): { output: string; truncated: boolean; attribution?: CheckAttributionShot } {
    const truncated = this.truncated
    let output = Buffer.concat(this.chunks).toString('utf8')
    if (truncated) {
      const marker = '\n[output truncated]'
      output = Buffer.from(output).subarray(0, Math.max(0, this.maxBytes - Buffer.byteLength(marker))).toString('utf8')
      while (Buffer.byteLength(output + marker) > this.maxBytes) output = output.slice(0, -1)
      output += marker
    }
    return { output, truncated, ...(this.scanner === undefined ? {} : { attribution: this.scanner.result(truncated) }) }
  }
}

/** A process deadline retains the bytes drained before the host stopped it. */
class ProcessTimeoutError extends Error {
  constructor(timeoutMs: number, readonly captured: ReturnType<ProcessOutput['result']>) {
    super(`Execution timed out after ${timeoutMs}ms`)
    this.name = 'ProcessTimeoutError'
  }
}

/**
 * The row for a declared check the host could not execute: exit 124 when the
 * host's own deadline stopped the preparation, otherwise 125, with the failure
 * kind the declared-check layer defers on instead of rejecting the artifact.
 */
function unexecutedCheck(command: string, error: unknown): CheckResult {
  const timeout = error instanceof ProcessTimeoutError
  return { command, exitCode: timeout ? 124 : 125, failureKind: timeout ? 'timeout' : 'infrastructure', output: `Host verification could not execute: ${String(error)}` }
}

/**
 * R19-H2: the two documented ways out of a dependency directory the host cannot
 * copy, written for the operator who reads them from a deferred review. The
 * link opt-in trades the R11-13 read boundary for the real toolchain; the
 * directory list keeps the boundary and leaves the check to find its own.
 */
const DEPENDENCY_MATERIALISATION_REPAIR = 'Install self-contained dependencies, or repair the host configuration and resume the review: either set verificationDependencyMode: "link" together with allowDependencyLinkReads: true so checks read the source toolchain through a link (this exposes uncommitted source state to checks), or change verificationDependencyDirs so this directory is not materialised ([] disables materialisation).'

/**
 * R19-H2: a dependency directory that cannot be materialised into the clean
 * checkout. No declared command has run, so this is a host-environment
 * condition (a pnpm/npm workspace symlink farm, a dangling install link), not a
 * verdict on the artifact. `verifyArtifact` returns it as a `(verification
 * preparation)` infrastructure row, so the declared-check layer defers the
 * review with a durable record instead of letting it escape `swarm_verify` as a
 * bare throw.
 */
export class DependencyMaterialisationError extends Error {
  constructor(code: 'dependency_copy_escape' | 'dependency_directory_unavailable', detail: string, dependency: string) {
    super(`[${code}] ${detail} (dependency: ${dependency}). ${DEPENDENCY_MATERIALISATION_REPAIR}`, { cause: { dependency } })
    this.name = 'DependencyMaterialisationError'
  }
}

/** Grace the host's termination procedure stages between SIGTERM and SIGKILL, and the bound it drains held pipes with. */
const TERMINATION_GRACE_MS = 300

/**
 * ENV: the environment one command receives. An explicit map is the child's
 * *whole* environment, exactly as the direct launcher treated it: every name the
 * map does not carry is removed with the seam's tombstones, because the provider
 * otherwise layers its credential-scrubbed ambient base underneath — and a check
 * environment that deliberately cleared a variable (the overlay scrubs
 * `NODE_TEST_CONTEXT`, a cleared `HOME` is recorded as a blocking divergence)
 * must not have it reappear. With no map the child gets that scrubbed ambient
 * base, which is what a bare probe wants and what the plugin's own `process.env`
 * would have handed it before the scrub existed.
 */
function seamEnvironment(map: Record<string, string> | undefined): NodeJS.ProcessEnv {
  if (map === undefined) return { GIT_TERMINAL_PROMPT: '0' }
  const env: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(scrubbedParentEnv())) if (!Object.hasOwn(map, key)) env[key] = undefined
  return { ...env, ...map, GIT_TERMINAL_PROMPT: '0' }
}

/**
 * Execute one argv through the host's managed-process seam with bounded output
 * and a caller-owned deadline.
 *
 * What stays here: the argv, the environment overlay, the head-keeping output
 * window, and cause classification — a caller abort reports 'Execution
 * cancelled', the deadline reports `Execution timed out after Nms`, and a real
 * exit code is reported whatever cleanup did afterwards.
 *
 * What moved to the host with this pass: process creation, the owned process
 * range, SIGTERM-before-SIGKILL escalation on the spec's abort signal, the drain
 * bound for pipes a surviving descendant still holds, and force-termination of
 * whatever is still running at host exit. The provider that owns those is also
 * what makes a host-exit kill and a range quiescence claim inspectable, instead
 * of the plugin's own best-effort group signalling.
 */
export async function runProcess(argv: readonly string[], options: ProcessOptions): Promise<{ exitCode: number; output: string; truncated: boolean; attribution?: CheckAttributionShot }> {
  if (argv.length === 0 || !argv[0]) throw new Error('An executable is required')
  options.signal?.throwIfAborted()
  const seam = options.subprocess?.()
  if (seam === undefined) throw new Error('[subprocess_service_required] Command execution requires the Harness subprocess service Inspect the host composition that mounts it, then retry; report the refusal with `missionId` and `swarm_observe`.')
  // The seam takes one signal, so the caller's cancellation and this deadline are
  // merged into one controller whose reason classifies the failure once.
  const deadline = new AbortController()
  let failure: Error | undefined
  let timedOut = false
  const cancel = (error: Error): void => { failure ??= error; deadline.abort(failure) }
  const onAbort = (): void => { cancel(new Error('Execution cancelled', { cause: options.signal?.reason })) }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    if (failure !== undefined) return
    timedOut = true
    cancel(new Error(`Execution timed out after ${options.timeoutMs}ms`))
  }, options.timeoutMs)
  const release = (): void => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  const output = new ProcessOutput(options.maxBytes, options.captureAttribution === true)
  let handle: SubprocessHandle
  try {
    handle = seam.spawn({
      argv,
      cwd: options.cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: TERMINATION_GRACE_MS,
      signal: deadline.signal,
      env: seamEnvironment(options.env),
    })
  } catch (error) {
    // A pre-aborted spec is refused synchronously by the provider; this plugin's
    // own cause classification still owns the message the caller reads.
    release()
    throw failure ?? error
  }
  if (handle.stdout === undefined || handle.stderr === undefined) {
    release()
    handle.terminate()
    throw new Error('[subprocess_pipes_missing] The Harness subprocess provider did not expose the requested stdout and stderr pipes Correct the provider composition, then retry; report the refusal with `missionId` and `swarm_observe`.')
  }
  handle.stdout.on('data', (chunk: Buffer) => { output.push(chunk) })
  handle.stderr.on('data', (chunk: Buffer) => { output.push(chunk) })
  // A signal that aborted before the listener existed dispatches to nobody.
  if (options.signal?.aborted) onAbort()
  try {
    const outcome = await handle.done
    if (failure !== undefined) throw failure
    return { exitCode: outcome.exitCode ?? 1, ...output.result() }
  } catch (error) {
    if (timedOut) throw new ProcessTimeoutError(options.timeoutMs, output.result())
    throw failure ?? error
  } finally {
    release()
    // The run is over; release the range. Termination is idempotent, so this
    // also covers the deadline path the seam already began, and the provider
    // keeps ownership of quiescence for whatever a check left behind.
    handle.terminate()
  }
}

function segment(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,150}$/.test(value)) throw new Error('Invalid workspace identity')
  return value
}
async function readJson(file: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as unknown } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}
/** Atomic private metadata replacement; never places metadata inside an editable worktree. */
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await rename(temporary, file) }
  finally { await rm(temporary, { force: true }) }
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function commitId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value) }

/** ENV: the host process environment as a record; the fallback check env and the self-run baseline. */
function ambientEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
/** ENV: the scoped roots one declared check receives live under this checkout subdirectory. */
export const CHECK_CACHE_DIRNAME = '.swarm-check-cache'
/**
 * R16-B: the temp root one declared check receives, beside the scoped cache
 * roots. The check sandbox is rooted at the disposable verification checkout, so
 * an inherited member scratch root is denied (EPERM) before a fixture can run;
 * the measured round-15 shape was 2/22 inside the sandbox against 22/22 outside.
 * TMPDIR/TMP/TEMP therefore point at one directory inside the checkout, created
 * before the check starts (a TMPDIR that does not exist fails `mkdtemp` with
 * ENOENT, which would turn the fix into a different failure).
 *
 * This is deliberately NOT part of `checkCacheEnvironment`: that record becomes
 * the envelope's `checkCacheRoots`. The envelope still records the scoped roots
 * it always did; no new field is added and the blocking half of
 * `compareCheckEnvironments` sees no new field at all.
 */
export function checkTempEnvironment(cacheRoot: string): Record<string, string> {
  const temp = path.join(cacheRoot, 'tmp')
  return { TMPDIR: temp, TMP: temp, TEMP: temp }
}
/** Whether a path names an existing directory; an absent cache root is recorded, never invented. */
function isDirectory(target: string | null): boolean {
  if (target === null) return false
  try { return statSync(target).isDirectory() } catch { return false }
}
/** Owns worktrees beneath one configured directory and never resets the source checkout. */
export class Workspaces {
  readonly root: string
  private readonly controllers = new Map<string, Set<AbortController>>()
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly baselines = new Map<string, Promise<WorkspaceBaseline>>()
  private readonly commonDirs = new Map<string, Promise<string>>()
  /** One in-flight self-contained artifact repository creation per mission. */
  private readonly artifactRepos = new Map<string, Promise<string>>()
  /** R11-19: one per-host semaphore over declared-check executions. */
  private readonly checks: CheckSemaphore
  private closing = false

  constructor(private readonly options: WorkspaceOptions) {
    this.root = path.resolve(options.workspacesRoot)
    if (!Number.isSafeInteger(options.checkTimeoutMs) || options.checkTimeoutMs < 1) throw new Error('checkTimeoutMs must be positive')
    if (!Number.isSafeInteger(options.maxCheckOutputBytes) || options.maxCheckOutputBytes < 64) throw new Error('maxCheckOutputBytes must be at least 64')
    this.checks = new CheckSemaphore(options.checkConcurrency ?? DEFAULT_CHECK_CONCURRENCY)
  }

  /** R11-19: the host's measured check envelope (limit, active, queued, wait and run times). */
  checkEnvelope(): DeclaredCheckEnvelope {
    return { ...this.checks.state(), environment: this.declaredCheckEnvironment(), selfRunEnvironment: this.selfRunEnvironment() }
  }
  /**
   * ENV: the environment the host's declared checks run under, computed without
   * running one. `checkCacheRoot`/`checkCacheRoots` name the placeholder
   * checkout a check will be given; the rest are the facts an executed check
   * must reproduce.
   */
  declaredCheckEnvironment(): CheckEnvironment { return this.checkEnvironment(this.checkProcessEnv(CHECKOUT_PLACEHOLDER), CHECKOUT_PLACEHOLDER, true) }
  /**
   * ENV: what a member's own self-run inherits in this host process, delivered
   * beside the envelope as `selfRun`. A self-run has none of the envelope's
   * scoped check caches; these facts are reported, never compared.
   */
  selfRunEnvironment(): CheckEnvironment { return this.checkEnvironment(ambientEnvironment(), CHECKOUT_PLACEHOLDER, false) }
  /**
   * R16-B: the environment one declared check receives. The scoped roots are
   * merged LAST so they win over the adapter's overlay (`checkEnv`), which is the
   * member session's environment and names the member's scratch root as TMPDIR:
   * the check sandbox is rooted at the checkout, so that inherited root is denied
   * and every fixture that calls `mkdtemp` dies before its first assertion.
   *
   * Co-firing guards, named: the sandbox policy the envelope records (workspace-write
   * rooted at the checkout — the temp root must be inside that root) x the
   * dependency-link exclusion in capture (the checkout is a disposable git
   * worktree of the artifact commit; `.swarm-check-cache` is untracked there and
   * is removed with the checkout, so the redirect adds no capture noise) x the
   * ENV reproduction comparison (TMPDIR/TMP/TEMP are not envelope fields; see
   * `checkTempEnvironment` for why recording them as a scoped root would lie).
   */
  private checkProcessEnv(checkout: string): Record<string, string> {
    const cache = this.checkCacheEnvironment(checkout)
    const temp = checkTempEnvironment(this.checkCacheRoot(checkout))
    // The overlay, when present, is the base — the ambient environment is NOT
    // merged under it, because the overlay is what scrubbed the parent's
    // node-test context (`NODE_TEST_CONTEXT` makes a nested `node --test` report
    // success without running the file) and re-adding it would undo the scrub.
    return { ...(this.options.checkEnv ?? ambientEnvironment()), ...cache, ...temp }
  }
  /** ENV: turn a process environment into the facts the envelope records. */
  private checkEnvironment(env: Record<string, string>, checkout: string, scoped: boolean): CheckEnvironment {
    const home = env.HOME === undefined || env.HOME === '' ? null : env.HOME
    const userCacheDir = home === null ? null : path.join(home, '.cache')
    const huggingfaceCacheDir = userCacheDir === null ? null : path.join(userCacheDir, 'huggingface')
    const roots = scoped ? this.checkCacheEnvironment(checkout) : {}
    return {
      home,
      userCacheDir,
      huggingfaceCacheDir,
      userCacheDirExists: isDirectory(userCacheDir),
      huggingfaceCacheDirExists: isDirectory(huggingfaceCacheDir),
      xdgCacheHome: env.XDG_CACHE_HOME === undefined || env.XDG_CACHE_HOME === '' ? null : env.XDG_CACHE_HOME,
      sandboxPolicy: { mode: this.options.sandboxPolicy?.mode ?? 'workspace-write', enforcement: this.options.sandboxPolicy?.enforcement ?? 'full',
        workspaceRoot: scoped ? checkout : null },
      dependencyLinks: { mode: this.dependencyMode(), dirs: [...(this.options.verificationDependencyDirs ?? DEFAULT_VERIFICATION_DEPENDENCY_DIRS)] },
      checkCacheRoot: scoped ? this.checkCacheRoot(checkout) : null,
      checkCacheRoots: roots,
    }
  }
  /**
   * Parse every declared check's shell syntax without executing it, through the
   * same host subprocess seam the checks themselves use. This is the preflight
   * `swarm_launch` ran and the staged-plan path did not: a plan whose check is a
   * shell syntax error was admitted, launched and executed by a whole task and
   * review cycle before failing at verification, where the same plan was refused
   * immediately on the prelaunch path. `checks` are already validated non-empty
   * command strings; this only answers "does `/bin/sh` parse this". Each issue
   * carries the command's position, so the caller can name the declared location
   * without assuming an input-aligned result.
   */
  async checkSyntaxPreflight(checks: readonly string[], cwd: string, signal?: AbortSignal): Promise<CheckSyntaxIssue[]> {
    const issues: CheckSyntaxIssue[] = []
    for (const [index, command] of checks.entries()) {
      signal?.throwIfAborted()
      const result = await runProcess(['/bin/sh', '-n', '-c', command], { cwd, signal, timeoutMs: HOST_GIT_TIMEOUT_MS, maxBytes: 4096, subprocess: this.options.subprocess })
      if (result.exitCode !== 0) issues.push({ index, message: result.output.trim() || `exit ${result.exitCode}` })
    }
    return issues
  }

  private missionDir(missionId: string): string { return path.join(this.root, segment(missionId)) }
  metadataPath(missionId: string, memberId: string): string { return path.join(this.missionDir(missionId), `${segment(memberId)}.worker.json`) }
  /**
   * F3: the owned worktree of one member. The one derivation of that path, so the
   * worker adapter's scratch root and this manager's ownership check agree by
   * construction instead of by a duplicated `path.join`.
   */
  workspacePath(missionId: string, memberId: string): string { return path.join(this.missionDir(missionId), 'members', segment(memberId)) }
  private memberPath(missionId: string, memberId: string): string { return path.join(this.missionDir(missionId), `${segment(memberId)}.workspace.json`) }
  private taskPath(missionId: string, taskId: string): string { return path.join(this.missionDir(missionId), 'tasks', `${segment(taskId)}.json`) }
  /** Per-mission private artifact repository: refs live outside the shared source repo. */
  private artifactRepoDir(missionId: string): string { return path.join(this.missionDir(missionId), 'artifacts.git') }

  /**
   * R11-14 (A2-04): artifact and baseline refs are published into a per-mission
   * bare repository under the mission directory instead of `refs/swarm/*` in the
   * shared source repository. Every member worktree of the source repo could
   * enumerate and read all missions' refs through the common git dir, which is a
   * cross-tenant read channel; a per-mission repository removes the discovery
   * channel.
   *
   * The repository is SELF-CONTAINED (T1c2 durability repair): it is created as
   * a local bare clone of the source — objects hardlinked on the same
   * filesystem, copied otherwise — and every later push transfers the new
   * objects into it. It therefore owns its objects (`count-objects` > 0) and
   * resolves every recorded ref without the source or an alternate, so a source
   * `gc --prune=now` after the member worktree is removed cannot make a
   * recorded artifact unreadable. An earlier revision borrowed the source
   * object store through `objects/info/alternates`; that variant left 0 own
   * objects and was disproved by the T1cv durability probe, so a legacy
   * alternate-backed repository is rebuilt here with its refs re-pushed from
   * the source. The sanctioned read path for cross-mission artifacts is the
   * runtime registry, never a git ref.
   */
  private artifactRepo(missionId: string, source: string, signal?: AbortSignal): Promise<string> {
    const existing = this.artifactRepos.get(missionId)
    if (existing !== undefined) return existing
    const pending = this.createArtifactRepo(missionId, source, signal)
    this.artifactRepos.set(missionId, pending)
    void pending.catch(() => { if (this.artifactRepos.get(missionId) === pending) this.artifactRepos.delete(missionId) })
    return pending
  }

  private async createArtifactRepo(missionId: string, source: string, signal?: AbortSignal): Promise<string> {
    const dir = this.artifactRepoDir(missionId)
    const marker = path.join(dir, 'swarm-artifacts.json')
    let saved: unknown
    let corruptMarker = false
    try { saved = await readJson(marker) }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; corruptMarker = true }
    if (saved === undefined && await lstat(dir).then(() => true, () => false)) {
      // A marker is the final creation step. Recover an interrupted write only
      // after proving this is the mission's owned bare repository; preserve all
      // artifact refs and corrupt metadata for diagnosis.
      await this.missionRecord(missionId)
      if (await realpath(dir) !== dir || await this.git(dir, ['rev-parse', '--is-bare-repository'], signal) !== 'true'
        || await realpath(await this.git(dir, ['rev-parse', '--absolute-git-dir'], signal)) !== dir) throw new Error('[artifact_repository_invalid] The mission artifact directory is not its owned bare repository; preserve it and repair its Git metadata before retrying.')
      if (corruptMarker) await rename(marker, `${marker}.corrupt-${randomUUID()}`)
      saved = { version: 1, missionId }
      await writePrivateJson(marker, saved)
    }
    if (isRecord(saved)) {
      if (saved.version !== 1 || saved.missionId !== missionId) throw new Error('Invalid per-mission artifact repository marker')
      // Copy referenced objects from a legacy alternate before disconnecting it.
      // Never delete the existing artifact repository to rebuild it: some refs
      // may already be absent from the source, and a crash must preserve them.
      const alternate = path.join(dir, 'objects', 'info', 'alternates')
      if (!(await lstat(alternate).then(() => true, () => false))) return dir
      await this.git(dir, ['repack', '-a', '-d'], signal)
      const backup = `${alternate}.retired-${randomUUID()}`
      await rename(alternate, backup)
      try { await this.git(dir, ['fsck', '--connectivity-only', '--no-dangling'], signal) }
      catch (error) { await rename(backup, alternate); throw error }
      return dir
    }
    await this.cloneArtifactRepo(missionId, source, dir, signal)
    return dir
  }

  /** A self-contained local bare clone plus its identity marker. */
  private async cloneArtifactRepo(missionId: string, source: string, dir: string, signal?: AbortSignal): Promise<void> {
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o700 })
    await this.git(path.dirname(dir), ['clone', '--bare', '--quiet', source, dir], signal)
    // Keep only the mission's own namespaces: a cloned branch or tag would
    // widen the repository's surface and make its reachability depend on the
    // source's branches. The objects stay reachable from the mission refs.
    const inherited = await this.git(dir, ['for-each-ref', '--format=%(refname)'])
    for (const ref of inherited.split('\n').map(line => line.trim()).filter(Boolean)) {
      if (ref.startsWith('refs/artifacts/') || ref.startsWith('refs/baselines/')) continue
      await this.git(dir, ['update-ref', '-d', ref], signal)
    }
    await writePrivateJson(path.join(dir, 'swarm-artifacts.json'), { version: 1, missionId })
  }

  /**
   * Publish one immutable ref into the mission's private repository and drop the
   * pre-R11-14 shared ref for exactly this mission, so a mission the host
   * touches no longer exposes its artifacts to other missions' worktrees. The
   * legacy delete is scoped to the mission's own namespace and is best effort.
   */
  private async publishArtifactRef(missionId: string, cwd: string, commit: string, ref: string, legacyRef: string, signal?: AbortSignal): Promise<void> {
    const repo = await this.artifactRepo(missionId, cwd, signal)
    await this.ensureSourceCommit(missionId, cwd, commit, signal)
    await this.git(cwd, ['push', '--quiet', '--force', repo, `${commit}:${ref}`], signal)
    await this.git(cwd, ['update-ref', '-d', legacyRef], signal).catch(() => undefined)
  }

  /**
   * Re-validate the human authorization behind a mission before its first
   * filesystem effect (baseline snapshot, member worktree, verification
   * checkout). The recorded `workspaceGrantRoot` — falling back to the mission
   * record, then to the workspace itself for records written before this
   * feature — anchors the check, and the loaded grant snapshot decides whether
   * that root is still configured and unexpired. A root the human removed
   * therefore fences the mission here instead of silently continuing.
   */
  private async assertWorkspaceAuthorized(workspace: string, recordedRoot: string | undefined, source?: 'session' | 'grant'): Promise<void> {
    const grants = this.options.grants
    if (grants === undefined) return
    const authorization = await reauthorizeWorkspace(workspace, recordedRoot ?? workspace, grants, source)
    if (!authorization.ok) throw new Error(authorization.diagnostic)
  }
  /**
   * Host git operations (worktree add, capture, commit) are not the declared
   * check and must not inherit its budget. Round 14 lost three verdicts because
   * they did: a verification checkout under load exceeded the 60 s check budget
   * and `git worktree add` was cancelled, so `swarm_verify` never recorded a
   * result while the reviewed artifact was fine. The floor is bounded, and the
   * attempt lease plus the operation bound still escalate a genuinely hung git.
   */
  private gitTimeout(): number { return Math.max(this.options.checkTimeoutMs, HOST_GIT_TIMEOUT_MS) }

  /** One git invocation with the host's fixed identity and environment; the caller judges the exit code. */
  private async gitResult(cwd: string, args: string[], signal?: AbortSignal, overrides?: Record<string, string>, maxBytes = this.options.maxCheckOutputBytes): Promise<Awaited<ReturnType<typeof runProcess>>> {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')))
    return await runProcess(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Agent Swarm', '-c', 'user.email=swarm@localhost', ...args], { cwd, timeoutMs: this.gitTimeout(), maxBytes, env: { ...env, ...overrides, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' }, subprocess: this.options.subprocess, ...(signal === undefined ? {} : { signal }) })
  }

  private async git(cwd: string, args: string[], signal?: AbortSignal, overrides?: Record<string, string>, maxBytes = this.options.maxCheckOutputBytes, raw = false): Promise<string> {
    const result = await this.gitResult(cwd, args, signal, overrides, maxBytes)
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed (${result.exitCode}): ${result.output.trim()}`)
    if (result.truncated) throw new Error(`git ${args[0]} output exceeded the configured limit; refusing incomplete artifact inspection`)
    return raw || args.includes('-z') ? result.output : result.output.trim()
  }

  private operation<T>(memberId: string, callback: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Workspace manager is disposed'))
    const controller = new AbortController()
    const abort = (): void => { controller.abort(signal?.reason) }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const active = this.controllers.get(memberId) ?? new Set<AbortController>()
    this.controllers.set(memberId, active)
    active.add(controller)
    const work = callback(controller.signal)
    this.inFlight.add(work)
    void work.finally(() => { signal?.removeEventListener('abort', abort); active.delete(controller); if (active.size === 0) this.controllers.delete(memberId); this.inFlight.delete(work) }).catch(() => undefined)
    return work
  }

  /** Canonical git common dir of one repository; the unit its worktree metadata belongs to. */
  private commonDir(cwd: string): Promise<string> {
    const key = path.resolve(cwd)
    const cached = this.commonDirs.get(key)
    if (cached !== undefined) return cached
    const pending = (async () => {
      const resolved = await this.git(cwd, ['rev-parse', '--git-common-dir'])
      const absolute = path.resolve(cwd, resolved)
      return await realpath(absolute).catch(() => absolute)
    })()
    this.commonDirs.set(key, pending)
    void pending.catch(() => { if (this.commonDirs.get(key) === pending) this.commonDirs.delete(key) })
    return pending
  }

  /** Serialize worktree metadata mutation for one repository, never per member or mission. */
  private async queueWorktree<T>(cwd: string, callback: () => Promise<T>): Promise<T> {
    const key = await this.commonDir(cwd)
    const previous = worktreeQueues.get(key) ?? Promise.resolve()
    const result = previous.then(callback)
    const tail = result.then(() => undefined, () => undefined)
    worktreeQueues.set(key, tail)
    try { return await result } finally { if (worktreeQueues.get(key) === tail) worktreeQueues.delete(key) }
  }

  /** Serialized `git worktree add` with one retry for a cross-process metadata race. */
  private async worktreeAdd(cwd: string, target: string, commit: string, signal?: AbortSignal): Promise<void> {
    await this.queueWorktree(cwd, async () => {
      try { await this.git(cwd, ['worktree', 'add', '--detach', target, commit], signal); return }
      catch (error) {
        if (!(error instanceof Error) || !WORKTREE_METADATA_RACE.test(error.message)) throw error
        // Another process outside this manager can still publish the metadata
        // non-atomically. Drop the partial registration and retry exactly once.
        await rm(target, { recursive: true, force: true }).catch(() => undefined)
        await this.git(cwd, ['worktree', 'prune'], signal).catch(() => undefined)
        await this.git(cwd, ['worktree', 'add', '--detach', target, commit], signal)
      }
    })
  }

  /** Serialized worktree metadata mutation (remove/prune) for one repository. */
  private async worktreeGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
    return await this.queueWorktree(cwd, async () => await this.git(cwd, args, signal))
  }

  private async missionRecord(missionId: string): Promise<MissionWorkspace> {
    const value = await readJson(path.join(this.missionDir(missionId), 'mission.json'))
    if (!isRecord(value) || value.version !== 1 || value.missionId !== missionId || typeof value.source !== 'string' || !commitId(value.baseCommit)) throw new Error('Invalid or missing mission workspace metadata')
    let baseline: WorkspaceBaseline | undefined
    if (value.baseline !== undefined) {
      const saved = value.baseline
      if (!isRecord(saved) || !commitId(saved.sourceHead) || saved.snapshotCommit !== value.baseCommit || typeof saved.planningWorkspace !== 'string' || !Array.isArray(saved.changedPaths) || saved.changedPaths.some(item => typeof item !== 'string') || !Number.isSafeInteger(saved.createdAt)) throw new Error('Invalid mission snapshot metadata')
      baseline = { sourceHead: saved.sourceHead, snapshotCommit: value.baseCommit, planningWorkspace: saved.planningWorkspace, changedPaths: saved.changedPaths as string[], createdAt: saved.createdAt as number }
    }
    return { version: 1, missionId, source: value.source, baseCommit: value.baseCommit, ...(baseline === undefined ? {} : { baseline }), ...(typeof value.workspaceGrantRoot === 'string' ? { workspaceGrantRoot: value.workspaceGrantRoot } : {}), ...(value.workspaceAuthorizationSource === 'session' || value.workspaceAuthorizationSource === 'grant' ? { workspaceAuthorizationSource: value.workspaceAuthorizationSource } : {}) }
  }

  /** Freeze one source baseline before planning; all members and restarts reuse it. */
  async prepareBaseline(mission: Pick<Mission, 'id' | 'workspace' | 'workspaceGrantRoot' | 'workspaceAuthorizationSource'>, signal?: AbortSignal): Promise<WorkspaceBaseline> {
    signal?.throwIfAborted()
    await this.assertWorkspaceAuthorized(mission.workspace, mission.workspaceGrantRoot, mission.workspaceAuthorizationSource)
    const existing = this.baselines.get(mission.id)
    if (existing !== undefined) {
      const baseline = await existing
      signal?.throwIfAborted()
      if ((await this.missionRecord(mission.id)).source !== await realpath(mission.workspace)) throw new Error('Mission source workspace changed')
      return baseline
    }
    const pending = this.operation(`baseline-${mission.id}`, async ownedSignal => {
      const source = await realpath(mission.workspace)
      const relativeRoot = path.relative(source, this.root)
      if (relativeRoot === '' || (!relativeRoot.startsWith(`..${path.sep}`) && relativeRoot !== '..' && !path.isAbsolute(relativeRoot))) throw new Error('Swarm snapshot storage must be outside the source repository')
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      if (await realpath(this.root) !== this.root) throw new Error('workspacesRoot must be canonical, without symlinks')
      if (await this.git(source, ['rev-parse', '--show-toplevel'], ownedSignal) !== source) throw new Error('[workspace_not_repository_root] Mission workspace must be the Git repository root Correct `workspace` with `swarm_create` and retry.')
      const manifest = path.join(this.missionDir(mission.id), 'mission.json')
      const planningWorkspace = path.join(this.missionDir(mission.id), 'planning')
      let record: MissionWorkspace
      if (await readJson(manifest) === undefined) {
        // Full repository path inventories need a metadata bound independent
        // of the much smaller user-visible check-output retention limit.
        const snapshot = await captureGitSnapshot(source, this.missionDir(mission.id), (args, env) => this.git(source, args, ownedSignal, env, INVENTORY_BYTES), ownedSignal)
        record = { version: 1, missionId: mission.id, source, baseCommit: snapshot.snapshotCommit, baseline: { ...snapshot, planningWorkspace }, ...(mission.workspaceGrantRoot === undefined ? {} : { workspaceGrantRoot: mission.workspaceGrantRoot }), ...(mission.workspaceAuthorizationSource === undefined ? {} : { workspaceAuthorizationSource: mission.workspaceAuthorizationSource }) }
        await writePrivateJson(manifest, record)
      } else record = await this.missionRecord(mission.id)
      if (record.source !== source) throw new Error('Mission source workspace changed')
      // Re-validate the persisted root, not just the in-memory mission: a
      // manifest written before the root was recorded still fences correctly.
      await this.assertWorkspaceAuthorized(source, record.workspaceGrantRoot ?? mission.workspaceGrantRoot, record.workspaceAuthorizationSource ?? mission.workspaceAuthorizationSource)
      if ((record.workspaceGrantRoot === undefined && mission.workspaceGrantRoot !== undefined) || (record.workspaceAuthorizationSource === undefined && mission.workspaceAuthorizationSource !== undefined)) {
        record = { ...record, ...(record.workspaceGrantRoot === undefined && mission.workspaceGrantRoot !== undefined ? { workspaceGrantRoot: mission.workspaceGrantRoot } : {}), ...(record.workspaceAuthorizationSource === undefined && mission.workspaceAuthorizationSource !== undefined ? { workspaceAuthorizationSource: mission.workspaceAuthorizationSource } : {}) }
        await writePrivateJson(manifest, record)
      }
      // Older manifests must retain their original baseline even if the source
      // now has unrelated edits. Add only the planning-view metadata.
      const baseline = record.baseline ?? { sourceHead: record.baseCommit, snapshotCommit: record.baseCommit, planningWorkspace, changedPaths: [], createdAt: Date.now() }
      if (baseline.planningWorkspace !== planningWorkspace) throw new Error('Planning workspace is outside its owned mission directory')
      // Persist the baseline identity before its ref/checkout. Interrupted
      // publication resumes that exact commit, never another source snapshot.
      await this.publishArtifactRef(mission.id, source, baseline.snapshotCommit, 'refs/baselines/baseline', `refs/swarm/${segment(mission.id)}/baseline`, ownedSignal)
      const exists = await realpath(planningWorkspace).then(value => value, error => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
        throw error
      })
      if (exists === undefined) {
        await mkdir(path.dirname(planningWorkspace), { recursive: true, mode: 0o700 })
        await this.worktreeAdd(source, planningWorkspace, baseline.snapshotCommit, ownedSignal)
      } else if (exists !== planningWorkspace || await this.git(planningWorkspace, ['rev-parse', 'HEAD^{commit}'], ownedSignal) !== baseline.snapshotCommit || await this.git(planningWorkspace, ['status', '--porcelain=v1', '--untracked-files=all'], ownedSignal)) throw new Error('Planning snapshot checkout was changed; restore the saved snapshot before continuing')
      if (record.baseline === undefined) await writePrivateJson(manifest, { ...record, baseline })
      return baseline
    }, signal)
    this.baselines.set(mission.id, pending)
    try { return await pending }
    finally { if (this.baselines.get(mission.id) === pending) this.baselines.delete(mission.id) }
  }

  private async memberRecord(member: Pick<Member, 'missionId' | 'id' | 'workspace'>): Promise<MemberWorkspace> {
    const value = await readJson(this.memberPath(member.missionId, member.id))
    const expected = path.join(this.missionDir(member.missionId), 'members', segment(member.id))
    if (!isRecord(value) || value.version !== 1 || value.memberId !== member.id || value.missionId !== member.missionId || value.workspace !== expected || path.resolve(member.workspace) !== expected) throw new Error('[workspace_not_owned] Workspace is not owned by this swarm member Read `taskId` with `swarm_observe` and retry from the member that owns the task.')
    const actual = await realpath(expected)
    if (actual !== expected) throw new Error('Swarm worktrees must not be replaced with symlinks')
    if (await this.git(expected, ['rev-parse', '--show-toplevel']) !== expected) throw new Error('Member workspace is no longer its owned Git worktree')
    const record: MemberWorkspace = { version: 1, memberId: member.id, missionId: member.missionId, workspace: expected }
    if (value.task !== undefined) {
      const task = value.task
      if (!isRecord(task) || typeof task.taskId !== 'string' || !Number.isSafeInteger(task.epoch) || !commitId(task.baseCommit)) throw new Error('Invalid persisted task baseline')
      if (task.capturedCommit !== undefined && !commitId(task.capturedCommit)) throw new Error('Invalid persisted captured commit')
      if (task.preservedCommit !== undefined && !commitId(task.preservedCommit)) throw new Error('Invalid persisted preservation commit')
      if (task.dependencyCommits !== undefined && (!Array.isArray(task.dependencyCommits) || !task.dependencyCommits.every(commitId))) throw new Error('Invalid persisted dependency commits')
      if (task.integrationConflicts !== undefined && (!Array.isArray(task.integrationConflicts) || !task.integrationConflicts.every(item => isRecord(item) && typeof item.dependencyId === 'string' && commitId(item.commit) && Array.isArray(item.paths) && item.paths.every(p => typeof p === 'string' && !path.isAbsolute(p) && !p.split('/').includes('..'))))) throw new Error('Invalid persisted integration conflicts')
      if (task.preservationPaths !== undefined && (!Array.isArray(task.preservationPaths) || !task.preservationPaths.every(name => typeof name === 'string' && validRecoveryPath(name)))) throw new Error('Invalid persisted recovery paths')
      const saved = task.recovery
      let recovery: TaskRecovery | undefined
      if (saved !== undefined) {
        if (!isRecord(saved) || !commitId(saved.commit) || typeof saved.previousOwnerId !== 'string' || typeof saved.reason !== 'string' || !Number.isSafeInteger(saved.at) || (saved.preserved !== undefined && typeof saved.preserved !== 'boolean')) throw new Error('Invalid persisted recovery fallback')
        // Records written before H-3 never carried a snapshot.
        recovery = { commit: saved.commit, previousOwnerId: saved.previousOwnerId, preserved: saved.preserved === true, reason: saved.reason, at: saved.at as number }
      }
      record.task = { taskId: task.taskId, epoch: task.epoch as number, baseCommit: task.baseCommit,
        ...(typeof task.capturedCommit === 'string' ? { capturedCommit: task.capturedCommit } : {}),
        ...(typeof task.preservedCommit === 'string' ? { preservedCommit: task.preservedCommit } : {}),
        ...(task.preservationPaths === undefined ? {} : { preservationPaths: task.preservationPaths as string[] }),
        ...(task.dependencyCommits === undefined ? {} : { dependencyCommits: task.dependencyCommits as string[] }),
        ...(task.integrationConflicts === undefined ? {} : { integrationConflicts: task.integrationConflicts as unknown as IntegrationConflict[] }),
        ...(recovery === undefined ? {} : { recovery }) }
    }
    const mission = await this.missionRecord(member.missionId)
    const common = async (cwd: string): Promise<string> => await realpath(path.resolve(cwd, await this.git(cwd, ['rev-parse', '--git-common-dir'])))
    if (await common(expected) !== await common(mission.source)) throw new Error('Member Git repository identity changed')
    return record
  }

  async prepareWorkspace(mission: Mission, memberId: string): Promise<string> {
    await this.prepareBaseline(mission)
    return await this.operation(memberId, async signal => {
      await mkdir(this.root, { recursive: true, mode: 0o700 })
      if (await realpath(this.root) !== this.root) throw new Error('workspacesRoot must be canonical, without symlinks')
      const source = await realpath(mission.workspace)
      if (await this.git(source, ['rev-parse', '--show-toplevel'], signal) !== source) throw new Error('Mission workspace must be the Git repository root')
      const saved = await this.missionRecord(mission.id)
      if (saved.source !== source) throw new Error('Mission source workspace changed')
      const workspace = path.join(this.missionDir(mission.id), 'members', segment(memberId))
      if (await readJson(this.memberPath(mission.id, memberId)) !== undefined) {
        await this.memberRecord({ missionId: mission.id, id: memberId, workspace })
        return workspace
      }
      await mkdir(path.dirname(workspace), { recursive: true, mode: 0o700 })
      const existing = await lstat(workspace).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (existing === undefined) await this.worktreeAdd(source, workspace, saved.baseCommit, signal)
      else if (!existing.isDirectory() || await realpath(workspace) !== workspace
        || await this.git(workspace, ['rev-parse', '--show-toplevel'], signal) !== workspace
        || await this.commonDir(workspace) !== await this.commonDir(source)
        || await this.git(workspace, ['branch', '--show-current'], signal) !== ''
        || await this.git(workspace, ['rev-parse', 'HEAD^{commit}'], signal) !== saved.baseCommit
        || await this.git(workspace, ['status', '--porcelain=v1', '--untracked-files=all'], signal)) {
        throw new Error('[workspace_recovery_requires_inspection] An unregistered member workspace contains unexpected state. Preserve its files and commits, inspect its ownership and work, then restore the recorded clean baseline before retrying.')
      }
      await writePrivateJson(this.memberPath(mission.id, memberId), { version: 1, missionId: mission.id, memberId, workspace } satisfies MemberWorkspace)
      return workspace
    })
  }

  /** Dependency directory names the plugin links into checkouts; never member work. */
  private dependencyNames(): ReadonlySet<string> {
    return new Set(this.options.verificationDependencyDirs ?? DEFAULT_VERIFICATION_DEPENDENCY_DIRS)
  }

  /**
   * F3: the only writer of a member's scratch root is the live member session
   * (the adapter points its `TMPDIR` there). Every path inside it is toolchain
   * state — never work, never a deliverable — so it is excluded exactly like a
   * dependency directory. It is NOT added to `dependencyNames`, so it is never
   * materialised into a verification checkout.
   */
  private isScratchPath(relative: string): boolean {
    return relative.split('/').includes(SWARM_SCRATCH_DIRNAME)
  }

  /**
   * The shortest prefix of `relative` that names a dependency directory
   * (`node_modules` or a configured name) or the member scratch root, and exists
   * as a directory or symlink, or undefined when the path is real work.
   * `git status --untracked-files=all` lists the files inside an untracked
   * directory and never the directory name, so the check must walk ancestors
   * (advisory A2). A regular file that merely shares a dependency name is
   * ordinary work and is still refused.
   */
  private async dependencyPrefix(workspace: string, relative: string): Promise<string | undefined> {
    const names = this.dependencyNames()
    const parts = relative.split('/').filter(part => part !== '')
    for (let index = 1; index <= parts.length; index++) {
      const part = parts[index - 1]!
      if (!names.has(part) && part !== SWARM_SCRATCH_DIRNAME) continue
      const prefix = parts.slice(0, index).join('/')
      const info = await lstat(path.join(workspace, prefix)).catch(() => undefined)
      if (info !== undefined && (info.isSymbolicLink() || info.isDirectory())) return prefix
    }
    return undefined
  }

  /**
   * Porcelain entries that are real uncommitted work. Untracked dependency
   * links and the files inside untracked dependency directories are ignored; a
   * modified tracked path, a staged path, or any other untracked path
   * (including a regular file merely named like a dependency directory) is
   * returned and still refuses preparation.
   */
  private async uncommittedWork(workspace: string, signal: AbortSignal): Promise<string[]> {
    const output = await this.git(workspace, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], signal, undefined, INVENTORY_BYTES)
    const work: string[] = []
    for (const entry of output.split('\0')) {
      if (entry === '') continue
      if (entry.startsWith('?? ') && await this.dependencyPrefix(workspace, entry.slice(3)) !== undefined) continue
      work.push(entry)
    }
    return work
  }

  /** In-flight preparation gates; stop/dispose abort queued operations before workspace I/O. */
  private readonly preparations = new Map<string, Promise<void>>()

  async prepareTask(member: Member, task: Task, dependencies: Task[], reviewSource?: Task): Promise<void> {
    await this.operation(member.id, async signal => {
      const previousPreparation = this.preparations.get(member.id)
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      this.preparations.set(member.id, gate)
      try {
        await previousPreparation
        signal.throwIfAborted()

        const record = await this.memberRecord(member)
        const preservationPaths = this.taskRecoveryPaths(task)
        if (task.reviewOf !== undefined) {
          if (reviewSource?.id !== task.reviewOf || reviewSource.missionId !== task.missionId || reviewSource.status !== 'submitted' || reviewSource.artifact === undefined) throw new Error('[verification_source_required] Verification requires its exact submitted review source artifact Verify again with `swarm_verify` and the reviewed `taskId`.')
          await this.validateArtifact(member, reviewSource.artifact, signal)
          if (task.attempt?.sourceCommit !== undefined && task.attempt.sourceCommit !== reviewSource.artifact.commit) throw new Error('[review_source_changed] Source artifact changed after assignment; reassign the same review before preparing its workspace')
        } else if (reviewSource !== undefined) throw new PolicyError('review_source_not_verification', 'tool_error', '[review_source_not_verification] Only a verification task can name a review source Correct `reviewOf` with `swarm_propose` and retry.')
        const taskOwner = await readJson(this.taskPath(member.missionId, task.id))
        const ownsRecovery = taskOwner === undefined || (isRecord(taskOwner) && taskOwner.memberId === member.id)
        const sameReview = reviewSource === undefined || record.task?.baseCommit === reviewSource.artifact?.commit
        const desiredDependencies = dependencies.flatMap(dependency => dependency.artifact === undefined ? [] : [dependency.artifact.commit]).sort()
        const sameDependencies = JSON.stringify([...(record.task?.dependencyCommits ?? [])].sort()) === JSON.stringify(desiredDependencies)
        if (sameReview && sameDependencies && ownsRecovery && record.task?.taskId === task.id && record.task.epoch === task.epoch) {
          if (JSON.stringify(record.task.preservationPaths ?? []) !== JSON.stringify(preservationPaths)) {
            record.task.preservationPaths = preservationPaths
            await this.saveTaskWorkspace(record)
          }
          return
        }
        if (sameReview && sameDependencies && ownsRecovery && record.task?.taskId === task.id) {
          if (record.task.epoch > task.epoch) throw new Error('Task attempt is older than the prepared workspace')
          // Same-task recovery keeps both committed and uncommitted progress. The
          // runtime must stop the previous attempt before preparing its replacement.
          record.task.epoch = task.epoch
          record.task.preservationPaths = preservationPaths
          await this.saveTaskWorkspace(record)
          return
        }
        const dirty = (await this.uncommittedWork(member.workspace, signal)).length > 0
        let previousHead = await this.git(member.workspace, ['rev-parse', 'HEAD^{commit}'], signal)
        if (record.task !== undefined && (record.task.taskId !== task.id || !sameDependencies || !sameReview || !ownsRecovery)) {
          // Dispatch only reaches this member after the old execution stopped.
          // Preserve all ordinary WIP, including out-of-scope work, separately
          // from accepted artifacts before removing anything from this checkout.
          if (dirty || record.task.preservationPaths?.length || previousHead !== (record.task.preservedCommit ?? record.task.capturedCommit ?? record.task.baseCommit)) {
            await this.preserveWorkspace(record, signal, { allowSuperseded: true })
            await this.assertNoIgnoredOverwrite(member.workspace, record.task.preservedCommit!, signal, record.task.preservationPaths)
            await this.git(member.workspace, ['reset', '--hard', record.task.preservedCommit!], signal)
            previousHead = record.task.preservedCommit!
          }
          await this.checkpointAbandonedTask(record, task.id)
          if (record.task.taskId !== task.id && record.task.integrationConflicts?.length) await rm(path.join(member.workspace, INTEGRATION_CONFLICT_FILE), { force: true })
        } else if (dirty) throw new Error('[workspace_uncommitted] Unowned workspace changes were preserved in place. The owner must inspect the workspace and use `swarm_control` with `taskId`, `action` resume and `reason` after correcting its ownership.')
        // Each task starts only with the mission base and explicitly accepted dependencies.
        // Captured task commits have durable Git refs; a rejected experiment cannot leak in.
        const mission = await this.missionRecord(member.missionId)
        const reviewCommit = reviewSource?.artifact?.commit
        const recovered = await this.recoverTask(member, task)
        // Review notes are task WIP too. Carry them across reviewers only while
        // their immutable source is unchanged; old-source notes stay preserved
        // in their own refs and must not be replayed onto another artifact.
        const recovery = reviewCommit !== undefined && recovered?.baseCommit !== reviewCommit ? undefined : recovered
        const recompose = recovery !== undefined && JSON.stringify([...(recovery.dependencyCommits ?? [])].sort()) !== JSON.stringify(desiredDependencies)
        const conflicts: IntegrationConflict[] = recompose ? [] : recovery?.integrationConflicts ?? []
        const dependencyCommits: string[] = recompose ? [] : recovery?.dependencyCommits ?? []
        try {
          const startingCommit = recompose ? reviewCommit ?? mission.baseCommit : recovery?.commit ?? reviewCommit ?? mission.baseCommit
          await this.ensureSourceCommit(member.missionId, mission.source, startingCommit, signal)
          await this.assertNoIgnoredOverwrite(member.workspace, startingCommit, signal)
          await this.git(member.workspace, ['checkout', '--no-overwrite-ignore', '--detach', startingCommit], signal)
          if ((recovery === undefined || recompose) && reviewCommit === undefined) for (const dependency of dependencies) {
            if (dependency.status !== 'accepted') throw new Error(`Dependency ${dependency.id} is not accepted`)
            if (dependency.artifact === undefined) {
              if (dependency.kind === 'implementation' || dependency.kind === 'integration') throw new Error(`Dependency ${dependency.id} has no immutable artifact`)
              continue
            }
            await this.validateArtifact(member, dependency.artifact, signal)
            dependencyCommits.push(dependency.artifact.commit)
            await this.assertNoIgnoredOverwrite(member.workspace, dependency.artifact.commit, signal)
            try {
              await this.git(member.workspace, ['merge', '--no-overwrite-ignore', '--no-edit', '--no-ff', dependency.artifact.commit], signal)
              // F2: a clean exit is not proof that the dependency's content
              // arrived. `git merge` honours the SOURCE REPOSITORY's own config and
              // `.gitattributes` (`merge=ours`, a custom merge driver), which can
              // exit 0 while keeping this side, and a conflict resolved to one side
              // drops the other the same way. Ancestry checks still pass afterwards
              // (the merge commit has both parents), so without this comparison a
              // dependency's whole delta could vanish from the composition with no
              // conflict recorded and no trace in `changedPaths`.
              const dropped = await this.droppedDependencyPaths(member.workspace, dependency.artifact.commit, signal)
              if (dropped.length) conflicts.push(await this.recordIntegrationConflict(member.workspace, task, { dependencyId: dependency.id, commit: dependency.artifact.commit }, `Dependency ${dependency.id} content is missing after a clean merge (${dropped.slice(0, 8).map(name => JSON.stringify(name)).join(', ')}); the source repository's merge configuration or a one-sided conflict resolution discarded it`, signal))
            } catch (error) {
              // Only integration tasks receive conflicts. The host makes the
              // composition (including conflict markers) an immutable baseline,
              // retaining both parents so workers need only edit normal files.
              conflicts.push(await this.recordIntegrationConflict(member.workspace, task, { dependencyId: dependency.id, commit: dependency.artifact.commit }, `Dependency integration conflict for ${dependency.id}: ${String(error)}`, signal))
              await this.git(member.workspace, ['commit', '--no-verify', '-m', `swarm: unresolved composition for ${task.id}`], signal)
            }
          }
          const baseCommit = recompose ? await this.git(member.workspace, ['rev-parse', 'HEAD^{commit}'], signal)
            : recovery?.baseCommit ?? await this.git(member.workspace, ['rev-parse', 'HEAD^{commit}'], signal)
          if (recompose && recovery !== undefined) {
            // Carry only the previous task's own WIP delta onto the amended
            // dependency baseline. Re-merging its old commit would silently keep
            // removed dependency content and count newly added files as task edits.
            const patchPath = path.join(this.missionDir(member.missionId), 'preservation', `rebase-${randomUUID()}.patch`)
            await mkdir(path.dirname(patchPath), { recursive: true, mode: 0o700 })
            await writeFile(patchPath, '', { mode: 0o600, flag: 'wx' })
            try {
              // File output avoids treating a large binary WIP patch as bounded
              // human-readable command output. The host operation remains timed.
              await this.git(member.workspace, ['diff', '--binary', '--no-ext-diff', '--no-textconv', `--output=${patchPath}`, recovery.baseCommit, recovery.commit, '--', '.', ...(recovery.integrationConflicts?.length ? [`:(exclude,literal)${INTEGRATION_CONFLICT_FILE}`] : [])], signal)
              if ((await lstat(patchPath)).size > 0) {
                try { await this.git(member.workspace, ['apply', '--3way', '--index', patchPath], signal) }
                catch (error) {
                  conflicts.push(await this.recordIntegrationConflict(member.workspace, task, { dependencyId: task.id, commit: recovery.commit }, `Preserved WIP conflicts with amended dependencies; its snapshot ${recovery.commit} is retained: ${String(error)}`, signal))
                }
                if (await this.git(member.workspace, ['diff', '--cached', '--name-only'], signal)) await this.git(member.workspace, ['commit', '--no-verify', '-m', `swarm: preserved WIP for ${task.id}`], signal)
              }
            } finally { await rm(patchPath, { force: true }) }
          }
          if (conflicts.length && !(recovery?.integrationConflicts?.length && !recompose) && await lstat(path.join(member.workspace, INTEGRATION_CONFLICT_FILE)).then(() => true, () => false)) throw new Error(`Integration conflict manifest path already belongs to repository content: ${INTEGRATION_CONFLICT_FILE}`)
          record.task = { taskId: task.id, epoch: task.epoch, baseCommit, preservationPaths,
            ...(recovery?.recovery === undefined ? {} : { recovery: recovery.recovery }),
            ...(dependencyCommits.length ? { dependencyCommits } : {}), ...(conflicts.length ? { integrationConflicts: conflicts } : {}) }
          await this.saveTaskWorkspace(record)
          if (conflicts.length) await writePrivateJson(path.join(member.workspace, INTEGRATION_CONFLICT_FILE), {
            instructions: 'Resolve every listed dependency conflict by editing working files. Read alternatives with git show <commit>:<path>; no Git metadata writes are required. Remove this manifest after resolving the conflicts, then swarm_submit. The host checks scope and dependency ancestry; independent review still decides acceptance.',
            dependencyCommits, conflicts,
          })
        } catch (error) {
          // Entry required a clean owned checkout; rollback restores exactly that
          // state and leaves all captured commits reachable through swarm refs.
          await this.git(member.workspace, ['merge', '--abort']).catch(() => undefined)
          await this.assertNoIgnoredOverwrite(member.workspace, previousHead)
          await this.git(member.workspace, ['reset', '--hard', previousHead])
          throw error
        }
      } finally {
        release()
        if (this.preparations.get(member.id) === gate) this.preparations.delete(member.id)
      }
    })
  }

  /** Stage only real integration conflicts; each caller retains its own commit and rollback boundary. */
  private async recordIntegrationConflict(workspace: string, task: Task, source: Omit<IntegrationConflict, 'paths'>, failure: string, signal: AbortSignal): Promise<IntegrationConflict> {
    const paths = (await this.git(workspace, ['diff', '--name-only', '--diff-filter=U', '-z'], signal)).split('\0').filter(Boolean)
    if (task.kind !== 'integration' || paths.length === 0) throw new Error(failure)
    await this.git(workspace, ['add', '--all', '--', '.'], signal)
    return { ...source, paths }
  }

  /**
   * F2: paths whose content the dependency commit changed but the current merge
   * result does not carry. Compares the dependency's own changed paths against the
   * working tree, so a merge that exits 0 while discarding a side (a repository
   * merge driver, an "ours" strategy, a one-sided resolution) is detected instead
   * of being recorded as a successful composition. A path the dependency deleted
   * is satisfied by absence; a path a later dependency legitimately re-modified is
   * not reported, because only paths this commit touched are compared and a
   * deliberate re-modification is exactly what a conflict record or a worker edit
   * covers. Untracked and ignored paths never appear in the diff.
   */
  async droppedDependencyPaths(workspace: string, commit: string, signal: AbortSignal): Promise<string[]> {
    const parent = await this.git(workspace, ['rev-parse', `${commit}^`], signal).catch(() => undefined)
    if (parent === undefined) return []
    const changed = (await this.git(workspace, ['diff', '--name-status', '--no-renames', '-z', parent, commit, '--'], signal, undefined, INVENTORY_BYTES))
      .split('\0').filter(Boolean)
    const missing: string[] = []
    for (let index = 0; index + 1 < changed.length; index += 2) {
      const status = changed[index]!
      const name = changed[index + 1]!
      if (status.startsWith('D')) {
        // The dependency deleted it: absence is correct, surviving content is the loss.
        if (await lstat(path.join(workspace, name)).then(() => true, () => false)) missing.push(name)
        continue
      }
      const expected = await this.git(workspace, ['rev-parse', `${commit}:${name}`], signal).catch(() => undefined)
      if (expected === undefined) continue
      const actual = await this.git(workspace, ['hash-object', '--', name], signal).catch(() => undefined)
      if (actual !== expected) missing.push(name)
    }
    return missing
  }

  /**
   * Serialize one task record's read-check-write across members and processes.
   * The member record is per member, but the task record is shared by the
   * previous owner, the recovering owner and capture; without mutual exclusion
   * a repair could read a stale record and clobber a newer owner's write (W1
   * advisory A1). The lock is a leaf lock: it is never held while another lock
   * or a git operation runs.
   */
  private async withTaskRecordLock<T>(taskPath: string, callback: () => Promise<T>): Promise<T> {
    const lockPath = `${taskPath}.lock`
    const staleAfterMs = 30_000
    const started = Date.now()
    await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 })
    for (;;) {
      try { await writeFile(lockPath, String(process.pid), { flag: 'wx', mode: 0o600 }); break }
      catch (error) {
        const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined
        if (code !== 'EEXIST') throw error
        const info = await lstat(lockPath).catch(() => undefined)
        if (info === undefined) continue
        if (Date.now() - info.mtimeMs > staleAfterMs) { await rm(lockPath, { force: true }).catch(() => undefined); continue }
        if (Date.now() - started > staleAfterMs) throw new Error(`Timed out waiting for the task workspace record lock: ${taskPath}`)
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    try { return await callback() } finally { await rm(lockPath, { force: true }).catch(() => undefined) }
  }

  private async saveTaskWorkspace(record: MemberWorkspace): Promise<void> {
    await writePrivateJson(this.memberPath(record.missionId, record.memberId), record)
    const task = record.task
    if (task === undefined) return
    const taskPath = this.taskPath(record.missionId, task.taskId)
    await this.withTaskRecordLock(taskPath, async () => { await writePrivateJson(taskPath, { ...record, task } satisfies TaskWorkspace) })
  }

  /** Preserve quiescent WIP without applying artifact scope or changing the checkout. */
  async checkpointTask(member: Member, task: Task, options?: { ifOwned?: boolean }): Promise<void> {
    await this.operation(member.id, async signal => {
      if (await readJson(this.memberPath(member.missionId, member.id)) === undefined) return
      const record = await this.memberRecord(member)
      if (record.task === undefined) return
      if (record.task.taskId !== task.id) {
        if (options?.ifOwned === true) return
        if (await this.hasDurableCheckpoint(member, task, signal)) return
        throw Object.assign(new Error('[workspace_ownership_conflict] Cannot checkpoint a workspace owned by another task; no durable checkpoint proves the stopped task was saved. Preserve both task workspaces and inspect the task workspace records before retrying resume.'), { code: 'WORKSPACE_OWNERSHIP_CONFLICT' })
      }
      // Older metadata has no path hints; the current task contract supplies them.
      record.task.preservationPaths = this.taskRecoveryPaths(task)
      await this.preserveWorkspace(record, signal)
    })
  }

  /**
   * The files this task owes, so a quiescent draft of one survives a handoff
   * even when it is ignored: exactly the declared `outputs` (a row without the
   * field declares none). An undeclared ignored file, such as a member-created
   * `.env`, is never force-included; the recovered checkout tracks a preserved
   * output, which is exactly what the replacement's capture carries.
   */
  private taskRecoveryPaths(task: Task): string[] {
    return (task.outputs ?? []).filter(name => validRecoveryPath(name) && withinScope(name, task.scope) && !this.toolchainName(name))
  }

  /**
   * A path with a dependency directory name or the member scratch root as any
   * component is toolchain state by name alone (F4). `dependencyLinks` only
   * sees the untracked, not-ignored entries of a worktree, so a hinted or
   * declared `node_modules/x/README.md` inside an IGNORED dependency directory
   * would otherwise read as an obligation, and be force-captured when declared.
   */
  private toolchainName(relative: string): boolean {
    const dependencies = this.dependencyNames()
    return relative.split('/').some(part => dependencies.has(part)) || this.isScratchPath(relative)
  }

  /**
   * The spelling the filesystem stores for `relative`, walking one component at
   * a time: the exact entry when it exists, otherwise the unique entry that
   * matches it case-insensitively (F2). A case-folding filesystem (the macOS
   * default) answers `lstat("docs/Report.md")` for a file stored as
   * `docs/report.md`, but git records an added file under its stored spelling
   * and a literal pathspec in the text's spelling matches nothing, so both the
   * gate and a declaration have to name the stored spelling. Undefined when a
   * component is missing, when an ancestor is a symlink or when an ancestor is
   * a nested repository or submodule: none of those can hold a deliverable of
   * this repository (outputs refuse symlink ancestors, snapshots refuse nested
   * repositories) and `git check-ignore` exits 128 for such a path instead of
   * answering, so the gate must never ask about it. The caller still inspects
   * the final entry.
   */
  private async onDiskSpelling(workspace: string, relative: string): Promise<string | undefined> {
    const resolved: string[] = []
    const parts = relative.split('/')
    for (const [index, part] of parts.entries()) {
      const entries = await readdir(path.join(workspace, ...resolved)).catch(() => undefined)
      if (entries === undefined) return undefined
      const lower = part.toLowerCase()
      const match = entries.includes(part) ? part : entries.filter(entry => entry.toLowerCase() === lower)
      if (Array.isArray(match) ? match.length !== 1 : false) return undefined
      resolved.push(Array.isArray(match) ? match[0]! : match)
      if (index === parts.length - 1) break
      const info = await lstat(path.join(workspace, ...resolved)).catch(() => undefined)
      if (info === undefined || !info.isDirectory()) return undefined
      if (await lstat(path.join(workspace, ...resolved, '.git')).then(() => true, () => false)) return undefined
    }
    return resolved.join('/')
  }

  /** A legacy failed claim may have moved the member after saving its old task.
   * Stop has already joined the worker. Only the exact preceding epoch's saved
   * checkpoint permits release; never snapshot or modify the member's new work. */
  private async hasDurableCheckpoint(member: Member, task: Task, signal: AbortSignal): Promise<boolean> {
    const saved = await readJson(this.taskPath(member.missionId, task.id))
    if (!isRecord(saved) || saved.version !== 1 || saved.missionId !== member.missionId || saved.memberId !== member.id
      || saved.workspace !== member.workspace || !isRecord(saved.task) || saved.task.taskId !== task.id
      || saved.task.epoch !== task.epoch - 1 || !commitId(saved.task.baseCommit)) return false
    const commit = saved.task.preservedCommit ?? saved.task.capturedCommit
    if (!commitId(commit)) return false
    const mission = await this.missionRecord(member.missionId)
    const repo = await this.artifactRepo(member.missionId, mission.source, signal)
    try {
      await this.git(repo, ['cat-file', '-e', `${commit}^{commit}`], signal)
      await this.git(repo, ['merge-base', '--is-ancestor', saved.task.baseCommit, commit], signal)
    } catch { signal.throwIfAborted(); return false }
    return true
  }

  /** Git resets can erase ignored obstacles; check compact ignored prefixes
   * against the target tree. Explicit snapshot paths are safe only while
   * installing the just-captured private snapshot of this quiescent checkout. */
  private async assertNoIgnoredOverwrite(workspace: string, commit: string, signal?: AbortSignal, capturedPaths: readonly string[] = []): Promise<void> {
    const ignored = (await this.git(workspace, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory', '-z'], signal, undefined, INVENTORY_BYTES)).split('\0').filter(Boolean)
    if (!ignored.length) return
    const targetPaths = (await this.git(workspace, ['ls-tree', '-rz', '--name-only', '--full-tree', commit], signal, undefined, INVENTORY_BYTES)).split('\0').filter(Boolean)
    const captured = new Set(capturedPaths)
    const collisions = targetPaths.filter(name => !captured.has(name) && ignored.some(hidden => {
      const prefix = hidden.replace(/\/$/, '')
      return name === prefix || name.startsWith(`${prefix}/`) || prefix.startsWith(`${name}/`)
    }))
    if (collisions.length) throw new PolicyError('workspace_ignored_collision', 'conflict_error', `Ignored files would be overwritten at ${collisions.slice(0, 8).map(name => JSON.stringify(name)).join(', ')}. Their contents remain in place. Preserve or move these local files outside the affected paths, then resume the same task; they were not captured as artifacts.`)
  }

  private async preserveWorkspace(record: MemberWorkspace, signal: AbortSignal, options?: { allowSuperseded?: boolean }): Promise<void> {
    const task = record.task
    if (task === undefined) throw new Error('Cannot preserve a workspace without task ownership')
    const snapshot = await captureGitSnapshot(record.workspace, path.join(this.missionDir(record.missionId), 'preservation'),
      (args, env) => this.git(record.workspace, args, signal, env, INVENTORY_BYTES), signal, task.preservationPaths)
    const nonce = randomUUID()
    await this.publishArtifactRef(record.missionId, record.workspace, snapshot.snapshotCommit,
      `refs/preservation/${segment(task.taskId)}/${task.epoch}/${nonce}`, `refs/swarm/${segment(record.missionId)}/preservation/${segment(task.taskId)}/${task.epoch}/${nonce}`, signal)
    const taskPath = this.taskPath(record.missionId, task.taskId)
    await this.withTaskRecordLock(taskPath, async () => {
      const current = await readJson(taskPath)
      const ownsTask = isRecord(current) && current.memberId === record.memberId && isRecord(current.task) && current.task.epoch === task.epoch
      // Preparation may revisit a member's previous checkout after this task
      // moved to someone else. Preserve that known local WIP without replacing
      // the newer owner's checkpoint. Stop/checkpoint still requires ownership.
      const superseded = options?.allowSuperseded === true && isRecord(current) && current.missionId === record.missionId
        && current.memberId !== record.memberId && isRecord(current.task) && current.task.taskId === task.taskId
        && Number.isSafeInteger(current.task.epoch) && Number(current.task.epoch) > task.epoch
      if (!ownsTask && !superseded) throw new Error('Task workspace ownership changed while preserving WIP; the snapshot remains in preservation refs')
      task.preservedCommit = snapshot.snapshotCommit
      await writePrivateJson(this.memberPath(record.missionId, record.memberId), record)
      if (ownsTask) await writePrivateJson(taskPath, { ...record, task } satisfies TaskWorkspace)
    })
  }

  /**
   * A member leaving a task for another one writes that task's immutable
   * checkpoint, so a later attempt never hits the uncheckpointed-owner dead end.
   * The member's workspace was just verified clean and at `capturedCommit ??
   * baseCommit`. `saveTaskWorkspace` writes the member record before the task
   * record, so a crash or failed write between the two leaves a split state:
   * the member record holds the captured commit while the task record does not.
   * That captured commit is repaired from the member record here; otherwise the
   * quiescent base is written. The write happens only while this member's own
   * task record is still current: after a handoff the task record names the new
   * owner, and the previous owner must never overwrite it.
   */
  private async checkpointAbandonedTask(record: MemberWorkspace, nextTaskId: string): Promise<void> {
    const previous = record.task
    if (previous === undefined || previous.taskId === nextTaskId) return
    const taskPath = this.taskPath(record.missionId, previous.taskId)
    // Read, compare and write under one lock: a newer owner's record written
    // while this checkpoint was deciding can never be clobbered (advisory A1).
    await this.withTaskRecordLock(taskPath, async () => {
      const saved = await readJson(taskPath)
      if (!isRecord(saved) || saved.memberId !== record.memberId || !isRecord(saved.task) || saved.task.epoch !== previous.epoch || commitId(saved.task.capturedCommit)) return
      await writePrivateJson(taskPath, {
        version: 1, missionId: record.missionId, memberId: record.memberId, workspace: record.workspace,
        task: { ...previous, capturedCommit: previous.capturedCommit ?? previous.baseCommit },
      } satisfies TaskWorkspace)
    })
  }

  /** Carry a previous owner's quiescent partial work into a replacement attempt. */
  private async recoverTask(member: Member, task: Task): Promise<(Pick<Artifact, 'commit' | 'baseCommit'> & Pick<TaskBase, 'recovery' | 'dependencyCommits' | 'integrationConflicts'>) | undefined> {
    const value = await readJson(this.taskPath(member.missionId, task.id))
    if (value === undefined) return undefined
    if (!isRecord(value) || value.version !== 1 || value.missionId !== member.missionId || typeof value.memberId !== 'string' || typeof value.workspace !== 'string' || !isRecord(value.task) || value.task.taskId !== task.id || !Number.isSafeInteger(value.task.epoch) || !commitId(value.task.baseCommit)) throw new Error('Invalid task recovery metadata')
    if (Number(value.task.epoch) >= task.epoch) throw new Error('Task workspace is already owned by this or a newer attempt')
    const prior = await this.memberRecord({ id: value.memberId, missionId: member.missionId, workspace: value.workspace })
    const composition = { ...(Array.isArray(value.task.dependencyCommits) ? { dependencyCommits: value.task.dependencyCommits as string[] } : {}),
      ...(Array.isArray(value.task.integrationConflicts) ? { integrationConflicts: value.task.integrationConflicts as unknown as IntegrationConflict[] } : {}) }
    if (commitId(value.task.preservedCommit)) return { commit: value.task.preservedCommit, baseCommit: value.task.baseCommit, ...composition }
    if (prior.task?.taskId === task.id) {
      // Task scoping is checked before committing partial work. The old worktree
      // is preserved if that check fails; no partial change is silently dropped.
      try {
        return { ...await this.captureArtifact({ ...member, id: value.memberId, workspace: value.workspace }, { ...task, epoch: prior.task.epoch }), ...composition }
      } catch (error) {
        // W9: the previous owner's workspace cannot be captured as an artifact
        // (out-of-scope, dirty or otherwise). Never dead-end the task permanently
        // and never drop that work silently: leave the worktree exactly as it is
        // and snapshot it into the preservation refs the way the stop barrier
        // does (H-3), so the replacement inherits every uncaptured change and
        // decides what to keep. Only when even that fails does the replacement
        // start from the last durable checkpoint or the recorded task base. The
        // fallback is reported either way; the runtime makes it durable and
        // owner-visible instead of leaving it in this process's memory.
        const captureFailure = error instanceof Error ? error.message : String(error)
        let preservationFailure: string | undefined
        try { await this.operation(value.memberId, signal => this.preserveWorkspace(prior, signal, { allowSuperseded: true })) }
        catch (preservationError) { preservationFailure = preservationError instanceof Error ? preservationError.message : String(preservationError) }
        const preserved = preservationFailure === undefined && commitId(prior.task.preservedCommit) ? prior.task.preservedCommit : undefined
        const commit = preserved ?? (commitId(value.task.capturedCommit) ? value.task.capturedCommit : value.task.baseCommit)
        const reason = preserved !== undefined ? captureFailure : `${captureFailure}; preservation failed: ${preservationFailure ?? 'no snapshot commit was recorded'}`
        const recovery: TaskRecovery = { commit, previousOwnerId: value.memberId, preserved: preserved !== undefined, reason, at: Date.now() }
        this.recordRecoveryFallback(member, task, recovery)
        return { commit, baseCommit: value.task.baseCommit, recovery, ...composition }
      }
    }
    if (!commitId(value.task.capturedCommit)) {
      // The recorded owner moved on without ever capturing a commit. It could
      // only leave for another task from a clean workspace at the recorded base
      // (prepareTask refuses a dirty or ahead workspace), so that base is the
      // immutable checkpoint. Recover from it instead of dead-ending the task
      // permanently; a fresh record is written for the new attempt below.
      return { commit: value.task.baseCommit, baseCommit: value.task.baseCommit, ...composition }
    }
    return { commit: value.task.capturedCommit, baseCommit: value.task.baseCommit, ...composition }
  }

  /** Report a W9 recovery fallback to the host; never masks the recovery. */
  private recordRecoveryFallback(member: Member, task: Task, recovery: TaskRecovery): void {
    try { this.options.onRecoveryFallback({ missionId: member.missionId, taskId: task.id, epoch: task.epoch, memberId: member.id, previousOwnerId: recovery.previousOwnerId, commit: recovery.commit, preserved: recovery.preserved, reason: recovery.reason }) }
    catch { /* reporting must not mask recovery */ }
  }

  private async validateArtifact(member: Member, artifact: Artifact, signal?: AbortSignal): Promise<void> {
    if (!commitId(artifact.commit) || !commitId(artifact.baseCommit)) throw new Error('Artifact requires exact commit hashes')
    const mission = await this.missionRecord(member.missionId)
    await this.ensureSourceCommit(member.missionId, mission.source, artifact.commit, signal)
    await this.git(mission.source, ['merge-base', '--is-ancestor', artifact.baseCommit, artifact.commit], signal)
    await this.git(mission.source, ['merge-base', '--is-ancestor', mission.baseCommit, artifact.commit], signal)
  }

  /** Rehydrate a pruned local object from its durable mission repository. No
   * shared source ref or FETCH_HEAD is created, preserving mission namespaces. */
  private async ensureSourceCommit(missionId: string, source: string, commit: string, signal?: AbortSignal): Promise<void> {
    if (!commitId(commit)) throw new Error('Artifact requires an exact commit hash')
    try { await this.git(source, ['cat-file', '-e', `${commit}^{commit}`], signal); return }
    catch { signal?.throwIfAborted() }
    const repo = await this.artifactRepo(missionId, source, signal)
    await this.git(repo, ['cat-file', '-e', `${commit}^{commit}`], signal)
    await this.git(source, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--no-auto-maintenance', repo, commit], signal)
    await this.git(source, ['cat-file', '-e', `${commit}^{commit}`], signal)
  }

  /** Resolve one path inside a committed tree, following symlink blobs (F-C1). */
  private treeSymlinkLookup(workspace: string, commit: string, signal: AbortSignal): SymlinkChainLookup {
    return async relative => {
      // Literal pathspec: a committed filename may itself contain glob characters.
      const raw = await this.git(workspace, ['ls-tree', '-z', commit, '--', `:(literal)${relative}`], signal, undefined, INVENTORY_BYTES, true)
      const match = /^(\d+) (blob|tree|commit) ([a-f0-9]+)\t/.exec(raw)
      if (!match) return undefined
      if (match[1] === '120000') return { kind: 'symlink', target: await this.git(workspace, ['cat-file', 'blob', match[3]!], signal, undefined, INVENTORY_BYTES, true) }
      return { kind: match[2] === 'tree' ? 'directory' : 'file' }
    }
  }

  /**
   * Reject artifact symlinks whose target is absolute or whose resolved chain
   * leaves the member workspace. Applied artifacts materialize these links in
   * the source checkout, so a read-through link to `/etc/hosts` or `../../..`
   * would let a worker plant a link that later tooling follows outside the
   * repository. A relative in-repository link stays allowed, but it is resolved
   * through the committed tree component by component (F-C1): a link to a
   * pre-existing escaping link is refused even though its target string is
   * lexically contained.
   */
  private async assertCommittedSymlinks(workspace: string, baseCommit: string, commit: string, signal: AbortSignal): Promise<void> {
    const raw = await this.git(workspace, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', baseCommit, commit, '--'], signal, undefined, INVENTORY_BYTES)
    const fields = raw.split('\0')
    const lookup = this.treeSymlinkLookup(workspace, commit, signal)
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const meta = fields[index]!.split(' ')
      const relative = fields[index + 1]!
      if (!relative || meta[1] !== '120000' || meta[3] === undefined) continue
      const target = await this.git(workspace, ['cat-file', 'blob', meta[3]!], signal, undefined, INVENTORY_BYTES, true)
      await assertContainedSymlinkChain(relative, target, lookup, 'Artifact symlink escapes the mission workspace')
    }
  }

  /**
   * Dependency prefixes present in a member workspace that are not tracked in
   * HEAD: the `node_modules` symlink or directory the member creates to run
   * checks and any configured verification dependency directory. They are
   * toolchain state, not artifact content, so capture must neither record them
   * nor treat them as out-of-scope work. A path tracked in HEAD is real content
   * and is never a link. A prefix a previous capture attempt staged is included
   * so it can be unstaged before the commit.
   */
  private async dependencyLinks(workspace: string, signal: AbortSignal): Promise<Set<string>> {
    const candidates = new Set<string>()
    for (const name of (await this.git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'], signal, undefined, INVENTORY_BYTES)).split('\0').filter(Boolean)) candidates.add(name)
    for (const name of (await this.git(workspace, ['diff', '--cached', '--name-only', '--diff-filter=A', '--no-renames', '-z'], signal, undefined, INVENTORY_BYTES)).split('\0').filter(Boolean)) candidates.add(name)
    const links = new Set<string>()
    for (const name of candidates) {
      const prefix = await this.dependencyPrefix(workspace, name)
      if (prefix === undefined) continue
      // F3: the member scratch root is toolchain state like a dependency link.
      // It is untracked by construction (the adapter points TMPDIR at it), so it
      // is excluded from the changed set, unstaged if an earlier capture staged
      // it, and kept out of the commit; unlike a dependency it is never a
      // candidate for materialisation into a verification checkout.
      if (this.isScratchPath(prefix)) { links.add(prefix); continue }
      if (!await this.git(workspace, ['cat-file', '-e', `HEAD:${prefix}`], signal).then(() => true, () => false)) links.add(prefix)
    }
    return links
  }

  private async artifactChanges(workspace: string, baseCommit: string, commit: string, signal: AbortSignal): Promise<Pick<Artifact, 'changedPaths'> & { executablePaths: string[] }> {
    const changedPaths = (await this.git(workspace, ['diff', '--name-only', '--no-renames', '-z', baseCommit, commit, '--'], signal, undefined, INVENTORY_BYTES)).split('\0').filter(Boolean)
    const rawChanges = (await this.git(workspace, ['diff', '--raw', '--no-renames', '-z', baseCommit, commit, '--'], signal, undefined, INVENTORY_BYTES)).split('\0')
    const executablePaths: string[] = []
    for (let index = 0; index + 1 < rawChanges.length; index += 2) {
      const modes = /^:(\d+) (\d+) /.exec(rawChanges[index]!)
      if (modes && modes.slice(1).some(mode => ['100755', '120000', '160000'].includes(mode))) executablePaths.push(rawChanges[index + 1]!)
    }
    return { changedPaths, executablePaths }
  }

  /** Re-read immutable Git facts for legacy records whose summary predates a policy field. */
  async inspectArtifact(member: Member, artifact: Artifact, signal?: AbortSignal): Promise<Artifact> {
    return this.operation(member.id, async signal => {
      await this.memberRecord(member)
      await this.validateArtifact(member, artifact, signal)
      return { ...artifact, ...await this.artifactChanges(member.workspace, artifact.baseCommit, artifact.commit, signal) }
    }, signal)
  }

  /**
   * Commit the member worktree as an immutable artifact. The captured files are
   * the whole-tree add of non-ignored changes plus, force-added past ignore
   * rules, the listed `deliverables` and the task's declared `outputs` (a row
   * without the field declares none). `requireOutputs` is the submit and verify
   * rule: every declared output must then exist as a regular file, or the call
   * is refused with `[output_missing]`. A checkpoint omits it and carries only
   * the declared outputs already written.
   */
  async captureArtifact(member: Member, task: Task, deliverables: string[] = [], options: { requireOutputs?: boolean } = {}): Promise<Artifact> {
    return await this.operation(member.id, async signal => {
      const record = await this.memberRecord(member)
      if (record.task?.taskId !== task.id || record.task.epoch !== task.epoch) throw new Error('[workspace_baseline_missing] Task has no matching prepared workspace baseline Retry the task with `swarm_claim` and its `taskId`.')
      const baseCommit = record.task.baseCommit
      if (record.task.integrationConflicts?.length) {
        if (await lstat(path.join(member.workspace, INTEGRATION_CONFLICT_FILE)).then(() => true, () => false)) throw new Error(`Resolve the recorded dependency conflicts, remove ${INTEGRATION_CONFLICT_FILE}, then submit this same integration task`)
        for (const name of new Set(record.task.integrationConflicts.flatMap(conflict => conflict.paths))) {
          const file = path.join(member.workspace, name)
          const info = await lstat(file).catch(() => undefined)
          if (info?.isSymbolicLink()) continue // the artifact symlink containment checks below own this case
          const content = await readFile(file, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error })
          if (/^<{7}(?: .*)?\r?\n[\s\S]*?^={7}\r?\n[\s\S]*?^>{7}(?: .*)?$/m.test(content)) throw new Error(`Unresolved dependency conflict markers remain in ${name}`)
        }
      }
      // Member-created dependency links are toolchain state, not work: they are
      // excluded from the changed set, unstaged if an earlier capture staged
      // them, and kept out of the commit. A tracked path of the same name stays
      // ordinary work and is still scope-checked.
      const links = await this.dependencyLinks(member.workspace, signal)
      // A dependency prefix covers the directory and everything inside it, so a
      // real untracked dependency directory is excluded as one unit (A2).
      const linkList = [...links]
      const dependencyContent = (name: string): boolean => linkList.some(link => name === link || name.startsWith(`${link}/`))
      if (!Array.isArray(deliverables) || deliverables.some(name => typeof name !== 'string')) throw new Error('[invalid_deliverables] deliverables must be an array of relative file paths')
      const listed = [...new Set(deliverables)]
      const owed = [...new Set(task.outputs ?? [])]
      // Explicit outputs may override ignore rules, never scope, Git metadata,
      // dependency exclusions or symlink containment. Do not force-add a folder.
      // F4: a name inside a dependency directory or the scratch root is refused
      // even when that directory is ignored and so invisible to `dependencyLinks`.
      // F2: each output is then carried under its on-disk spelling, which is the
      // spelling git records for it and the one `ls-tree` finds below.
      const outputs: string[] = []
      const missing: string[] = []
      for (const name of [...new Set([...listed, ...owed])]) {
        const declared = owed.includes(name)
        // A checkpoint carries a declared output once it is written and never
        // refuses on one still owed; only submit and verify require it.
        const optional = declared && !listed.includes(name) && options.requireOutputs !== true
        if (!withinScope(name, task.scope) || name.endsWith('/') || /[\u0000-\u001f]/.test(name) || name.split('/').some(part => part.toLowerCase() === '.git') || dependencyContent(name) || this.toolchainName(name)) {
          if (optional) continue
          throw new PolicyError('invalid_deliverable_path', 'validation_error', `${JSON.stringify(name)} must be a literal file within task scope, outside Git metadata, dependency and scratch directories. Correct \`deliverables\` with \`swarm_submit\`.`)
        }
        const parts = name.split('/')
        let regular = true
        for (let depth = 1; regular && depth <= parts.length; depth++) {
          const info = await lstat(path.join(member.workspace, ...parts.slice(0, depth))).catch(() => undefined)
          if (!info || info.isSymbolicLink() || (depth === parts.length ? !info.isFile() : !info.isDirectory())) regular = false
        }
        if (!regular) {
          if (optional) continue
          if (declared) { missing.push(name); continue }
          throw new PolicyError('invalid_deliverable_file', 'validation_error', `${JSON.stringify(name)} must exist as a regular file without symlink ancestors; correct \`deliverables\` and retry \`swarm_submit\`.`)
        }
        const spelled = await this.onDiskSpelling(member.workspace, name) ?? name
        if (!outputs.includes(spelled)) outputs.push(spelled)
      }
      if (missing.length) {
        const tool = task.kind === 'verification' ? 'swarm_verify' : 'swarm_submit'
        throw new PolicyError('output_missing', 'validation_error', `[output_missing] The task declares ${missing.map(name => JSON.stringify(name)).join(', ')} in \`outputs\`, but ${missing.length === 1 ? 'it is not a regular file' : 'they are not regular files'} in your worktree, so this ${tool === 'swarm_verify' ? 'verification' : 'submission'} was not recorded and your attempt stays running. Write ${missing.length === 1 ? 'the file' : 'each file'} and retry \`${tool}\` with the same \`taskId\`, or, if the task no longer produces ${missing.length === 1 ? 'it' : 'them'}, escalate with \`swarm_escalate\` so the owner amends \`outputs\` with \`swarm_control\`.`)
      }
      // Include tracked changes, staged changes, and new files before any commit.
      // Rename detection is disabled so a `git mv` out of scope reports the
      // deleted source path too, instead of only the in-scope destination.
      const changed = new Set((await this.git(member.workspace, ['diff', '--name-only', '--no-renames', '-z', baseCommit, '--'], signal, undefined, INVENTORY_BYTES)).split('\0').filter(Boolean).filter(name => !dependencyContent(name)))
      for (const name of (await this.git(member.workspace, ['ls-files', '--others', '--exclude-standard', '-z'], signal, undefined, INVENTORY_BYTES)).split('\0').filter(Boolean)) if (!dependencyContent(name)) changed.add(name)
      for (const name of changed) if (!withinScope(name, task.scope)) throw new Error(`Artifact changes path outside task scope: ${name}`)
      // Untracked symlinks are invisible to `git diff`; inspect every changed
      // working-tree path before committing so an escaping link is never
      // recorded in a swarm ref.
      for (const name of changed) {
        const info = await lstat(path.join(member.workspace, name)).catch(() => undefined)
        if (info?.isSymbolicLink()) assertContainedSymlink(member.workspace, name, await readlink(path.join(member.workspace, name)))
      }
      for (const link of links) await this.git(member.workspace, ['rm', '--cached', '-r', '--force', '--quiet', '--', link], signal).catch(() => undefined)
      await this.git(member.workspace, ['add', '--all', '--', '.', ...[...links].map(link => `:(exclude,literal)${link}`)], signal)
      if (outputs.length) await this.git(member.workspace, ['add', '--force', '--', ...outputs.map(name => `:(literal)${name}`)], signal)
      const staged = await this.git(member.workspace, ['diff', '--cached', '--name-only', '--no-renames', '-z'], signal, undefined, INVENTORY_BYTES)
      if (staged.length > 0) await this.git(member.workspace, ['commit', '--no-verify', '-m', `swarm: ${task.title.slice(0, 160)}`], signal, undefined, INVENTORY_BYTES)
      const commit = await this.git(member.workspace, ['rev-parse', 'HEAD^{commit}'], signal)
      await this.git(member.workspace, ['merge-base', '--is-ancestor', baseCommit, commit], signal)
      for (const dependency of record.task.dependencyCommits ?? []) await this.git(member.workspace, ['merge-base', '--is-ancestor', dependency, commit], signal)
      const { changedPaths, executablePaths } = await this.artifactChanges(member.workspace, baseCommit, commit, signal)
      for (const name of changedPaths) if (!withinScope(name, task.scope)) throw new Error(`Committed artifact changes path outside task scope: ${name}`)
      // The commit is authoritative: re-check the recorded blobs so a working
      // tree edited after staging cannot smuggle a symlink into the artifact.
      await this.assertCommittedSymlinks(member.workspace, baseCommit, commit, signal)
      const files: NonNullable<Artifact['files']> = []
      for (const name of outputs) {
        const entry = await this.git(member.workspace, ['ls-tree', '--long', '-z', commit, '--', `:(literal)${name}`], signal, undefined, INVENTORY_BYTES, true)
        const match = /^(100[0-7]{3}) blob ([a-f0-9]+)\s+(\d+)\t/.exec(entry)
        if (!match) throw new PolicyError('deliverable_not_captured', 'conflict_error', `${JSON.stringify(name)} is not a regular file in the captured commit; correct the file and retry \`swarm_submit\` with \`deliverables\`.`)
        files.push({ path: name, blob: match[2]!, bytes: Number(match[3]) })
      }
      await this.publishArtifactRef(member.missionId, member.workspace, commit, `refs/artifacts/${segment(task.id)}/${task.epoch}`, `refs/swarm/${segment(member.missionId)}/${segment(task.id)}/${task.epoch}`, signal)
      record.task.capturedCommit = commit
      delete record.task.preservedCommit
      await this.saveTaskWorkspace(record)
      return { commit, baseCommit, workspace: member.workspace, changedPaths,
        ...(files.length ? { files } : {}), ...(executablePaths.length ? { executablePaths } : {}) }
    })
  }

  async verifyArtifact(member: Member, task: Task, artifact: Artifact, signal?: AbortSignal): Promise<CheckResult[]> {
    return await this.operation(member.id, async signal => {
      await this.memberRecord(member)
      try { await this.validateArtifact(member, artifact, signal) }
      catch (error) {
        // Only the host's own git deadline (HOST_GIT_TIMEOUT_MS) proving the
        // artifact is a timeout row: no command has run. Any other failure here
        // (a non-ancestor, a missing commit) refuses the artifact by a throw,
        // and cancellation stays cancellation.
        if (!(error instanceof ProcessTimeoutError) || signal.aborted) throw error
        return [unexecutedCheck('(verification preparation)', error)]
      }
      const mission = await this.missionRecord(member.missionId)
      // Revocation fencing: the verification checkout is created only after the
      // persisted mission manifest still authorizes its recorded root.
      await this.assertWorkspaceAuthorized(mission.source, mission.workspaceGrantRoot, mission.workspaceAuthorizationSource)
      signal.throwIfAborted()
      // Research can require independent review without declaring host commands.
      // Keep the validation above, but reserve execution capacity only for checks.
      if (task.checks.length === 0) return []
      const checkout = path.join(this.missionDir(member.missionId), 'verification', randomUUID())
      let release: (() => void) | undefined
      try {
        let linked: string[]
        try {
          await mkdir(path.dirname(checkout), { recursive: true, mode: 0o700 })
          await this.worktreeAdd(mission.source, checkout, artifact.commit, signal)
          // R19-M-d: the toolchain copy can be a whole node_modules and has no
          // deadline of its own, so it lands before the slot is taken. A slow or
          // refused copy then neither idles a slot another verification is queued
          // for nor counts against the check deadline and the measured run time,
          // which both start with the command.
          linked = await this.linkDependencyDirs(mission.source, checkout, signal)
          // R11-19: declared-check executions are bounded per host. A verification
          // beyond the limit waits here in FIFO order (abort-aware), and its wait is
          // measured. The adapter reports `verification` activity for the whole
          // call, so the runtime's lease renewal keeps the queued attempt alive.
          await this.checks.acquire(signal)
        } catch (error) {
          // No declared command has run: whatever stopped the host preparing the
          // checkout (a git exit, a dependency copy, a full disk) is the host's,
          // not a verdict on the artifact. Cancellation stays cancellation.
          if (signal.aborted) throw error
          return [unexecutedCheck('(verification preparation)', error)]
        }
        const startedAt = Date.now()
        release = () => this.checks.release(Date.now() - startedAt)
        // R16-B: both scoped roots are created before the check starts. The temp
        // root must exist: a TMPDIR pointing at a missing directory fails
        // `mkdtemp` with ENOENT, which is a different failure from the denied
        // member scratch root this redirects away from.
        const cacheRoot = this.checkCacheRoot(checkout)
        await mkdir(cacheRoot, { recursive: true, mode: 0o700 }).catch(() => undefined)
        await mkdir(path.join(cacheRoot, 'tmp'), { recursive: true, mode: 0o700 }).catch(() => undefined)
        const env = this.checkProcessEnv(checkout)
        // ENV: the facts this check runs under, recorded with it so a reader can
        // compare them with the envelope delivered to the assignee.
        const environment = this.checkEnvironment(env, checkout, true)
        environment.dependencyLinks = { ...environment.dependencyLinks, materializedPaths: linked }
        const results: CheckResult[] = []
        for (const command of task.checks) {
          signal.throwIfAborted()
          let result: Awaited<ReturnType<typeof runProcess>>
          try {
            const argv = await this.options.confineCheck(['/bin/sh', '-c', command], checkout)
            result = await runProcess(argv, { cwd: checkout, signal, timeoutMs: task.checkTimeoutMs ?? this.options.checkTimeoutMs, maxBytes: this.options.maxCheckOutputBytes, env, captureAttribution: true, subprocess: this.options.subprocess })
          } catch (error) {
            // A check's own deadline is a failed execution, so the declared-check
            // layer can durably record this pass and retry it. Caller cancellation
            // remains cancellation, including when it arrives during timeout drain.
            if (!(error instanceof ProcessTimeoutError)) {
              if (signal.aborted) throw error
              // An argument the process API refused (a NUL byte in a check
              // admitted before admission refused control characters) is a
              // defect in the request, not the host: it stays a thrown refusal.
              const code = error instanceof Error && 'code' in error ? String(error.code) : ''
              if (code === 'ERR_INVALID_ARG_VALUE' || code === 'ERR_INVALID_ARG_TYPE') throw error
              // F-29: a confinement the host refused (partial enforcement) or a
              // command the seam could not start never ran; record it as this
              // command's infrastructure row, never as an assertion failure.
              results.push(unexecutedCheck(command, error))
              break
            }
            signal.throwIfAborted()
            const captured = new ProcessOutput(this.options.maxCheckOutputBytes, false)
            captured.push(Buffer.from(`[swarm] ${error.message}\n`))
            captured.push(Buffer.from(error.captured.output))
            const bounded = captured.result()
            const truncated = error.captured.truncated || bounded.truncated
            result = { exitCode: 124, ...bounded, truncated,
              ...(error.captured.attribution === undefined ? {} : { attribution: { ...error.captured.attribution, outputTruncated: truncated } }) }
          }
          // Exit 127 is "command not found": name the environment cause so a reviewer does not retry the same artifact blindly.
          const output = result.exitCode === 127
            ? `${result.output}\n[swarm] exit 127: a command in this check was not found in the clean verification checkout. ${this.dependencyMode() === 'copy' ? 'Copied' : 'Linked'} dependency directories from the source: ${linked.length ? linked.join(', ') : 'none (install dependencies in the source project, or choose checks that need no installed toolchain)'}. The artifact itself was not changed by this failure.`
            : result.output
          // ENV: attribution and environment are written BEFORE the free-form
          // output, so a bound on the record removes detail rather than the
          // failing test names, the TAP summary and the stage that failed.
          const attribution: CheckAttribution | undefined = result.attribution === undefined ? undefined
            : { index: results.length + 1, command, ...result.attribution }
          results.push({ command, exitCode: result.exitCode, ...([124, 126, 127].includes(result.exitCode) ? { failureKind: result.exitCode === 124 ? 'timeout' as const : 'infrastructure' as const } : {}), ...(attribution === undefined ? {} : { attribution }), environment, output, truncated: result.truncated })
          if (result.exitCode !== 0) break
        }
        return results
      } finally {
        release?.()
        await this.cleanupVerification(member, task, mission.source, checkout)
      }
    }, signal)
  }

  /** The scoped cache root inside one disposable verification checkout. */
  private checkCacheRoot(checkout: string): string { return path.join(checkout, CHECK_CACHE_DIRNAME) }

  /** Keep package-manager caches inside the disposable checkout, never the source. */
  private checkCacheEnvironment(checkout: string): Record<string, string> {
    const cache = this.checkCacheRoot(checkout)
    return {
      npm_config_cache: path.join(cache, 'npm'),
      YARN_CACHE_FOLDER: path.join(cache, 'yarn'),
      XDG_CACHE_HOME: path.join(cache, 'xdg'),
      PIP_CACHE_DIR: path.join(cache, 'pip'),
      GOCACHE: path.join(cache, 'go'),
    }
  }

  /**
   * Remove a disposable verification checkout without ever masking the check
   * results. `git worktree remove` fails when a check left an unreadable
   * directory; fall back to `fs.rm`, then to an owner-permission repair before
   * `git worktree prune` drops a stale registration. Failures are recorded for
   * the host and are never thrown.
   */
  private async cleanupVerification(member: Member, task: Task, source: string, checkout: string): Promise<void> {
    let failure: unknown
    try {
      await this.worktreeGit(source, ['worktree', 'remove', '--force', checkout])
      return
    } catch (error) { failure = error }
    if (!(await lstat(checkout).then(() => true, () => false))) {
      try { await this.worktreeGit(source, ['worktree', 'prune']) } catch { /* registration cleanup is best effort */ }
      return
    }
    try { await rm(checkout, { recursive: true, force: true, maxRetries: 1 }) }
    catch { try { await this.forceRemove(checkout) } catch (error) { failure = error } }
    try { await this.worktreeGit(source, ['worktree', 'prune']) } catch { /* registration cleanup is best effort */ }
    this.recordCleanupIssue(member, task, checkout, failure)
  }

  /** Restore owner permissions on an unreadable tree so removal can finish. */
  private async forceRemove(directory: string): Promise<void> {
    const gone = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
    // A failed recursive removal can still be deleting entries, so every step
    // tolerates a path that disappeared underneath it.
    const ignoringMissing = async <T>(operation: Promise<T>): Promise<T | undefined> => await operation.catch(error => { if (gone(error)) return undefined; throw error })
    const repair = async (current: string): Promise<void> => {
      for (const entry of await ignoringMissing(readdir(current, { withFileTypes: true })) ?? []) {
        const child = path.join(current, entry.name)
        const info = await ignoringMissing(lstat(child))
        if (info === undefined || info.isSymbolicLink()) continue
        if (info.isDirectory()) { await ignoringMissing(chmod(child, 0o700)); await repair(child) }
        else await ignoringMissing(chmod(child, 0o600))
      }
    }
    await repair(directory)
    await ignoringMissing(chmod(directory, 0o700))
    await rm(directory, { recursive: true, force: true })
  }

  private recordCleanupIssue(member: Member, task: Task, checkout: string, failure: unknown): void {
    const reason = failure instanceof Error ? failure.message : String(failure)
    try { this.options.onCleanupFailure({ missionId: member.missionId, taskId: task.id, memberId: member.id, checkout, reason }) } catch { /* reporting must not mask results */ }
  }

  /** Cancel member-owned artifact/check subprocesses; worker cancellation belongs to the adapter. */
  cancel(memberId: string): void { for (const controller of this.controllers.get(memberId) ?? []) controller.abort('member stopped') }

  /** Preserve mission worktrees as deliverables, while draining all owned execution. */
  /** R11-13: the effective dependency materialisation mode; `link` needs the explicit unsafe opt-in. */
  private dependencyMode(): 'link' | 'copy' {
    return this.options.verificationDependencyMode === 'link' && this.options.allowDependencyLinkReads === true ? 'link' : 'copy'
  }
  /**
   * Clean checkouts contain only committed files, so toolchains installed in the
   * source (ignored `node_modules` and similar) are absent. By default those
   * ignored directories are COPIED into the checkout at the same relative
   * paths: the artifact commit is unchanged, the check reads the real toolchain,
   * and no path inside the materialised directory can resolve back into the
   * source checkout (R11-13). A read-through symlink (`verificationDependencyMode:
   * 'link'` with `allowDependencyLinkReads: true`) lets `node_modules/..` and
   * `node_modules/pkg/../..` resolve to the symlink target's parent chain and
   * read uncommitted source state, so it is never used unless the host
   * explicitly opts in. Package-manager caches are always pointed inside the
   * checkout. Build outputs and other ignored paths are never linked or copied.
   * @returns the relative directories that were copied or linked.
   */
  private async linkDependencyDirs(source: string, checkout: string, signal: AbortSignal): Promise<string[]> {
    const names = new Set(this.options.verificationDependencyDirs ?? DEFAULT_VERIFICATION_DEPENDENCY_DIRS)
    if (names.size === 0) return []
    const ignored = await this.git(source, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], signal, undefined, INVENTORY_BYTES)
    const linked: string[] = []
    const copy = this.dependencyMode() === 'copy'
    for (const entry of ignored.split('\0')) {
      if (!entry) continue
      const relative = entry.endsWith('/') ? entry.slice(0, -1) : entry
      if (!names.has(path.basename(relative)) || relative.split('/').some(part => part === '..' || part === '')) continue
      const target = path.join(source, relative), link = path.join(checkout, relative)
      const entryStat = await lstat(target).catch(() => undefined)
      const resolved = await realpath(target).catch(() => undefined)
      const targetStat = resolved === undefined ? undefined : await lstat(resolved).catch(() => undefined)
      if (entryStat?.isSymbolicLink() && (targetStat === undefined || !targetStat.isDirectory())) throw new DependencyMaterialisationError('dependency_directory_unavailable', 'A dependency link has no readable directory target; repair or reinstall the dependency directory', relative)
      if (targetStat === undefined || !targetStat.isDirectory()) continue
      if (await lstat(link).then(() => true, () => false)) continue
      // The artifact decides the checkout's tree: when it made a parent of this
      // directory something other than a directory (a file, or a link that is
      // never written through), the dependency has no place here. Materialise
      // nothing for it and let the checks judge the artifact; failing here would
      // report an immutable artifact as a host condition no repair can change.
      if (await this.displacedByArtifact(checkout, relative)) continue
      await mkdir(path.dirname(link), { recursive: true })
      if (copy) await this.copyDependencyTree(resolved!, link, source, relative, signal)
      else await symlink(target, link, 'dir')
      linked.push(relative)
    }
    return linked
  }

  /** Whether an existing parent of `relative` inside the checkout is not a directory. */
  private async displacedByArtifact(checkout: string, relative: string): Promise<boolean> {
    for (let parent = path.dirname(relative); parent !== '.'; parent = path.dirname(parent)) {
      const stat = await lstat(path.join(checkout, parent)).catch(() => undefined)
      if (stat !== undefined && !stat.isDirectory()) return true
    }
    return false
  }

  /** Copy into staging, relocate internal links, and materialize external
   * executable files (notably venv interpreters). No copied link may read through
   * to the host, and source checkout contents outside this dependency stay out. */
  private async copyDependencyTree(source: string, destination: string, workspaceSource: string, name: string, signal: AbortSignal): Promise<void> {
    const staging = `${destination}.swarm-copy-${randomUUID()}`
    const contained = (target: string): boolean => target === source || target.startsWith(`${source}${path.sep}`)
    try {
      signal.throwIfAborted()
      await cp(source, staging, { recursive: true, dereference: false, verbatimSymlinks: true })
      const rewrite = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          signal.throwIfAborted()
          const file = path.join(directory, entry.name)
          if (entry.isDirectory()) { await rewrite(file); continue }
          if (!entry.isSymbolicLink()) continue
          const relative = path.relative(staging, file)
          const target = await readlink(file)
          const resolved = await realpath(path.resolve(source, path.dirname(relative), target)).catch(() => undefined)
          if (resolved !== undefined && !contained(resolved)) {
            const original = await lstat(resolved).catch(() => undefined)
            const readsSource = resolved === workspaceSource || resolved.startsWith(`${workspaceSource}${path.sep}`)
            // A virtualenv commonly links bin/python to a system interpreter.
            // Freeze that regular executable into the copied environment, with
            // its mode, rather than expanding the verification read boundary.
            if (!readsSource && original?.isFile() && (original.mode & 0o111) !== 0) {
              await rm(file)
              await copyFile(resolved, file)
              await chmod(file, original.mode & 0o777)
              continue
            }
          }
          if (resolved === undefined || !contained(resolved)) throw new DependencyMaterialisationError('dependency_copy_escape', 'A dependency link is broken or leaves its dependency directory without naming an external executable file; links to source checkout contents, external directories and non-executable files cannot be copied', path.join(name, relative))
          const relocated = path.join(staging, path.relative(source, resolved))
          await rm(file)
          await symlink(path.relative(path.dirname(file), relocated) || '.', file)
        }
      }
      await rewrite(staging)
      signal.throwIfAborted()
      await rename(staging, destination)
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  async dispose(): Promise<void> {
    this.closing = true
    for (const active of this.controllers.values()) for (const controller of active) controller.abort('adapter disposed')
    await Promise.allSettled([...this.inFlight])
  }
}
