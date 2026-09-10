/** Owned Git worktrees and immutable artifacts. The source checkout is read-only. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { chmod, cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { reauthorizeWorkspace, type WorkspaceGrantSnapshot } from './authorization.js'
import { withinScope } from './scope.js'
import { captureGitSnapshot } from './git-snapshot.js'
import type { Artifact, CheckEnvelope, Member, Mission, Task, WorkspaceBaseline } from './types.js'
export type { CheckEnvelope }

export interface CheckResult { command: string; exitCode: number; output: string; truncated?: boolean
  /** ENV: failure attribution captured ahead of the output bound; durable with the check row. */
  attribution?: CheckAttribution
  /** ENV: the environment this check actually ran under. */
  environment?: CheckEnvironment }
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
   * failure is recorded here and never masks the check results.
   */
  onCleanupFailure?(info: { checkout: string; error: string }): void
  /**
   * Called when a cross-owner recovery cannot capture the previous owner's
   * workspace and re-creates a clean baseline instead (W9). The dirty worktree
   * is left untouched; this reports the fallback for host-side observability.
   */
  onRecoveryFallback?(info: RecoveryFallback): void
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
   * reported through `checkEnvelope()` / `onCheckEnvelope`. Default 2.
   */
  checkConcurrency?: number
  /** R11-19: called once per declared check with its measured wait and run time. */
  onCheckEnvelope?(info: CheckEnvelopeSample): void
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
}
/** R11-19: one declared check's measured queue wait and execution time. */
export interface CheckEnvelopeSample {
  memberId: string
  taskId: string
  command: string
  waitMs: number
  runMs: number
  /** Check executions active when this one started. */
  active: number
  /** Checks still waiting when this one started. */
  queued: number
  limit: number
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
 * ENV: the environment a declared check runs under, stated as facts instead of
 * folklore, so the assignee knows which environment the host check will use and
 * a verification can tell when its self-run cannot reproduce it.
 *
 * `home`, the two user cache roots, the sandbox policy and the dependency links
 * are what a self-run must reproduce. `checkCacheRoot`/`checkCacheRoots` are the
 * scoped roots the envelope itself provides inside the disposable checkout: they
 * differ by design on every run and are excluded from the reproduction
 * comparison. Existence flags are recorded and reported but never refuse an
 * acceptance: a check must not depend on the ambient cache staying warm.
 *
 * Structural mirror: `src/runtime.ts` reads the same shape through a type-only
 * import, and `WorkerAdapter.checkEnvelope` keeps declaring the measured type.
 */
export interface CheckEnvironment {
  /** HOME the check process receives; null when it inherits none. */
  home: string | null
  /** User-level cache directory the check's HOME resolves (`<home>/.cache`); null without a HOME. */
  userCacheDir: string | null
  /** `<userCacheDir>/huggingface`, where a user-level model cache lives; null without a HOME. */
  huggingfaceCacheDir: string | null
  /** Whether the two user cache roots existed when these facts were recorded. */
  userCacheDirExists: boolean
  huggingfaceCacheDirExists: boolean
  /** XDG_CACHE_HOME in force for this environment (the scoped root for a check). */
  xdgCacheHome: string | null
  /** The confinement the host applies: workspace-write rooted at the checkout, full enforcement. */
  sandboxPolicy: { mode: string; enforcement: string; workspaceRoot: string | null }
  /** Ignored dependency directories materialised into the checkout, and how. */
  dependencyLinks: { mode: 'link' | 'copy'; dirs: string[] }
  /** Scoped cache root the envelope provides inside the checkout; null for a self-run. */
  checkCacheRoot: string | null
  /** Package-manager cache roots the check sets below `checkCacheRoot`. */
  checkCacheRoots: Record<string, string>
}
/** ENV: one check's failure attribution, captured before the output bound can cut it off. */
export interface CheckAttribution {
  /** 1-based position of the failing check in the declared sequence. */
  index: number
  command: string
  /** The last stage banner (`> script`, `$ command`, `# stage: name`) before the first failure. */
  stage: string | null
  /** The last `# Subtest:` heading before the first failure (the suite that failed). */
  subtest: string | null
  /** TAP `not ok` names seen in the stream, bounded; the count is every name seen. */
  failingTests: string[]
  failingTestCount: number
  /** TAP summary lines (`1..N`, `# tests/# pass/# fail/...`), latest value per key. */
  tapSummary: string[]
  /** True when the stored output was cut at the host's output bound. */
  outputTruncated: boolean
}
/** ENV: the measured facts of the most recent completed check, carried by the envelope record. */
export interface ObservedCheck {
  memberId: string
  taskId: string
  at: number
  environment: CheckEnvironment
  attribution?: CheckAttribution
  /** Bounded head of the free-form output; the attribution above it is what must survive a cut. */
  output: string
}
/**
 * ENV: the measured envelope plus the declared-check environment and the last
 * observation. `environment` is the declared envelope the runtime delivers to
 * the assignee and compares with the verification attempt's self-run facts:
 * blocking divergences (HOME, the user cache roots, the sandbox policy, the
 * dependency links) are the ones a self-run cannot reproduce, the existence
 * flags are advisory, because a cold cache is not a wrong environment.
 */
export interface DeclaredCheckEnvelope extends CheckEnvelope {
  environment: CheckEnvironment
  selfRunEnvironment: CheckEnvironment
  observed?: ObservedCheck
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
  private line(text: string): void {
    const failure = /^\s*not ok\s+\d+\s*-\s+(.*\S)\s*$/.exec(text)
    if (failure !== null) {
      if (!this.failed) { this.failed = true; this.failingStage = this.stage; this.failingSubtest = this.subtest }
      this.failingTestCount++
      if (this.failingTests.length < MAX_ATTRIBUTED_FAILURES) this.failingTests.push(failure[1]!.slice(0, MAX_ATTRIBUTED_NAME))
      return
    }
    if (!this.failed) {
      const stage = /^>\s+(\S.*\S|\S)\s*$/.exec(text) ?? /^\$\s+(\S.*\S|\S)\s*$/.exec(text) ?? /^#\s*stage:\s*(\S.*\S|\S)\s*$/i.exec(text)
      if (stage !== null) this.stage = stage[1]!.slice(0, MAX_ATTRIBUTED_NAME)
      const subtest = /^#\s*Subtest:\s*(\S.*\S|\S)\s*$/.exec(text)
      if (subtest !== null) this.subtest = subtest[1]!.slice(0, MAX_ATTRIBUTED_NAME)
    }
    const summary = /^#\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b\s*(.*)$/.exec(text)
    if (summary !== null) { this.summary.set(summary[1]!, text.trim()); return }
    const plan = /^1\.\.(\d+)\s*$/.exec(text)
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
/** Durable record of a recovery that could not capture the previous owner's partial work. */
export interface RecoveryFallback { missionId: string; taskId: string; epoch: number; previousOwnerId: string; commit: string; reason: string }
/** Persisted on the task workspace record so the fallback survives restarts. */
interface TaskRecovery { commit: string; previousOwnerId: string; reason: string; at: number }
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
interface TaskBase { taskId: string; epoch: number; baseCommit: string; capturedCommit?: string; recovery?: TaskRecovery }
interface MemberWorkspace { version: 1; missionId: string; memberId: string; workspace: string; task?: TaskBase }
interface TaskWorkspace { version: 1; missionId: string; memberId: string; workspace: string; task: TaskBase }
interface ProcessOptions { cwd: string; signal?: AbortSignal; timeoutMs: number; maxBytes: number; env?: Record<string, string>; captureAttribution?: boolean }
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

/** Execute an argv with bounded output and a cancellation-owned process group. */
export async function runProcess(argv: readonly string[], options: ProcessOptions): Promise<{ exitCode: number; output: string; truncated: boolean; attribution?: CheckAttributionShot }> {
  if (argv.length === 0 || !argv[0]) throw new Error('An executable is required')
  options.signal?.throwIfAborted()
  if (process.platform === 'win32') throw new Error('Swarm worktree execution currently requires POSIX process groups')
  return await new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: '0' },
    })
    let bytes = 0
    let truncated = false
    const chunks: Buffer[] = []
    // ENV: attribution is read from every chunk, including the chunks the
    // output bound drops, because the failing test and the TAP summary arrive
    // after it.
    const scanner = options.captureAttribution === true ? new CheckOutputScanner() : undefined
    let failure: Error | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, signal) } catch (error) {
        // ESRCH and EPERM both mean the group is no longer ours to signal: the
        // close-path reap must not replace the child's real exit code and
        // output with a cleanup error. A timeout or abort already recorded its
        // own failure in cancel() before any kill.
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (code !== 'ESRCH' && code !== 'EPERM') failure ??= error instanceof Error ? error : new Error(String(error))
      }
    }
    const cancel = (error: Error): void => {
      failure ??= error
      killGroup('SIGTERM')
      killTimer ??= setTimeout(() => { killGroup('SIGKILL') }, 300)
    }
    const onAbort = (): void => { cancel(new Error('Execution cancelled', { cause: options.signal?.reason })) }
    const timer = setTimeout(() => { cancel(new Error(`Execution timed out after ${options.timeoutMs}ms`)) }, options.timeoutMs)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const append = (chunk: Buffer): void => {
      scanner?.push(chunk)
      const available = Math.max(0, options.maxBytes - bytes)
      if (chunk.length > available) truncated = true
      if (available > 0) { const kept = chunk.subarray(0, available); chunks.push(kept); bytes += kept.length }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', error => { failure ??= error })
    child.on('close', code => {
      clearTimeout(timer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      options.signal?.removeEventListener('abort', onAbort)
      // A check may leave background descendants. Its owned process group ends here.
      killGroup('SIGKILL')
      if (failure !== undefined) { reject(failure); return }
      let output = Buffer.concat(chunks).toString('utf8')
      if (truncated) {
        const marker = '\n[output truncated]'
        output = Buffer.from(output).subarray(0, Math.max(0, options.maxBytes - Buffer.byteLength(marker))).toString('utf8')
        while (Buffer.byteLength(output + marker) > options.maxBytes) output = output.slice(0, -1)
        output += marker
      }
      resolve({ exitCode: code ?? 1, output, truncated, ...(scanner === undefined ? {} : { attribution: scanner.result(truncated) }) })
    })
    if (options.signal?.aborted) onAbort()
  })
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

/** ENV: how much of one check's free-form output the envelope record carries below its attribution. */
const CHECK_ENVELOPE_OUTPUT_CHARS = 4000
/** ENV: the bounded output excerpt the envelope carries after the attribution. */
function boundedOutput(output: string): string {
  return output.length <= CHECK_ENVELOPE_OUTPUT_CHARS ? output : `${output.slice(0, CHECK_ENVELOPE_OUTPUT_CHARS)}\n[envelope output excerpt truncated]`
}
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
 * the envelope's `checkCacheRoots`, which `selfRunEnvironmentFacts` spreads into
 * a member's self-run facts and re-derives only for the four package-manager
 * names. Recording a checkout-scoped TMPDIR there would make every self-run
 * falsely claim the envelope's disposable temp root. The envelope still records
 * the scoped roots it always did; no new field is added and the blocking half of
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
  private readonly cleanupIssues: string[] = []
  private readonly recoveryIssues: string[] = []
  /** R11-19: one per-host semaphore over declared-check executions. */
  private readonly checks: CheckSemaphore
  private readonly checkSamples: CheckEnvelopeSample[] = []
  /** ENV: the most recent completed check's own environment and failure attribution. */
  private lastCheck: ObservedCheck | undefined
  private closing = false

  constructor(private readonly options: WorkspaceOptions) {
    this.root = path.resolve(options.workspacesRoot)
    if (!Number.isSafeInteger(options.checkTimeoutMs) || options.checkTimeoutMs < 1) throw new Error('checkTimeoutMs must be positive')
    if (!Number.isSafeInteger(options.maxCheckOutputBytes) || options.maxCheckOutputBytes < 64) throw new Error('maxCheckOutputBytes must be at least 64')
    this.checks = new CheckSemaphore(options.checkConcurrency ?? DEFAULT_CHECK_CONCURRENCY)
  }

  /** R11-19: the host's measured check envelope (limit, active, queued, wait and run times). */
  checkEnvelope(): DeclaredCheckEnvelope {
    return { ...this.checks.state(), environment: this.declaredCheckEnvironment(), selfRunEnvironment: this.selfRunEnvironment(),
      ...(this.lastCheck === undefined ? {} : { observed: this.lastCheck }) }
  }
  /**
   * ENV: the environment the host's declared checks run under, computed without
   * running one. `checkCacheRoot`/`checkCacheRoots` name the placeholder
   * checkout a check will be given; the rest are the facts a self-run must
   * reproduce.
   */
  declaredCheckEnvironment(): CheckEnvironment { return this.checkEnvironment(this.checkProcessEnv(CHECKOUT_PLACEHOLDER), CHECKOUT_PLACEHOLDER, true) }
  /**
   * ENV: what a member's own self-run inherits in this host process. A self-run
   * has none of the envelope's scoped check caches, which is why those fields
   * are excluded from the reproduction comparison.
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
  /** R11-19: the most recent measured checks, oldest first (bounded). */
  checkEnvelopeSamples(): readonly CheckEnvelopeSample[] { return [...this.checkSamples] }
  private recordCheckEnvelope(member: Member, task: Task, command: string, waitMs: number, runMs: number): void {
    const state = this.checks.state()
    const sample: CheckEnvelopeSample = { memberId: member.id, taskId: task.id, command, waitMs, runMs, active: state.active, queued: state.queued, limit: state.limit }
    this.checkSamples.push(sample)
    if (this.checkSamples.length > 100) this.checkSamples.splice(0, this.checkSamples.length - 100)
    try { this.options.onCheckEnvelope?.(sample) } catch { /* host-side recording must not mask check results */ }
  }

  /** Non-fatal verification-checkout cleanup failures, oldest first (bounded). */
  cleanupFailures(): readonly string[] { return [...this.cleanupIssues] }

  /**
   * W9 recoveries that could not capture the previous owner's workspace and
   * re-created a clean baseline instead, oldest first (bounded). The previous
   * owner's worktree is never modified by such a fallback.
   */
  recoveryFallbacks(): readonly string[] { return [...this.recoveryIssues] }

  private missionDir(missionId: string): string { return path.join(this.root, segment(missionId)) }
  metadataPath(missionId: string, memberId: string): string { return path.join(this.missionDir(missionId), `${segment(memberId)}.worker.json`) }
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
    const saved = await readJson(marker)
    if (isRecord(saved)) {
      if (saved.version !== 1 || saved.missionId !== missionId) throw new Error('Invalid per-mission artifact repository marker')
      // A legacy repository that borrows the source through an alternate is not
      // durable: rebuild it self-contained and carry every ref over.
      if (!(await lstat(path.join(dir, 'objects', 'info', 'alternates')).then(() => true, () => false))) return dir
      const refs = (await this.git(dir, ['for-each-ref', '--format=%(objectname) %(refname)']))
        .split('\n').map(line => line.trim()).filter(Boolean)
        .map(line => { const [commit, ref] = line.split(' '); return { commit: commit!, ref: ref! } })
      await rm(dir, { recursive: true, force: true })
      await this.cloneArtifactRepo(missionId, source, dir, signal)
      for (const { commit, ref } of refs) await this.git(source, ['push', '--quiet', '--force', dir, `${commit}:${ref}`], signal)
      return dir
    }
    // `git clone` refuses a non-empty destination, so drop a partial directory
    // from an interrupted first attempt before cloning.
    if (await lstat(dir).then(() => true, () => false)) await rm(dir, { recursive: true, force: true })
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
    await writeFile(path.join(dir, 'swarm-artifacts.json'), JSON.stringify({ version: 1, missionId }), { mode: 0o600 })
  }

  /**
   * Publish one immutable ref into the mission's private repository and drop the
   * pre-R11-14 shared ref for exactly this mission, so a mission the host
   * touches no longer exposes its artifacts to other missions' worktrees. The
   * legacy delete is scoped to the mission's own namespace and is best effort.
   */
  private async publishArtifactRef(missionId: string, cwd: string, commit: string, ref: string, legacyRef: string, signal?: AbortSignal): Promise<void> {
    const repo = await this.artifactRepo(missionId, cwd, signal)
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

  private async git(cwd: string, args: string[], signal?: AbortSignal, overrides?: Record<string, string>, maxBytes = this.options.maxCheckOutputBytes, raw = false): Promise<string> {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GIT_')))
    const result = await runProcess(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Agent Swarm', '-c', 'user.email=swarm@localhost', ...args], { cwd, timeoutMs: this.gitTimeout(), maxBytes, env: { ...env, ...overrides, GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' }, ...(signal === undefined ? {} : { signal }) })
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

  /**
   * Re-validate one recorded mission before a verification checkout is created.
   * A verification can be the first filesystem effect after a host restart, so
   * the checkout path checks independently against the persisted manifest.
   */
  private async assertRecordAuthorized(missionId: string, source: string): Promise<void> {
    if (this.options.grants === undefined) return
    const record = await this.missionRecord(missionId)
    if (record.source !== source) throw new Error('Mission source workspace changed')
    await this.assertWorkspaceAuthorized(source, record.workspaceGrantRoot)
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
      const saved = task.recovery
      let recovery: TaskRecovery | undefined
      if (saved !== undefined) {
        if (!isRecord(saved) || !commitId(saved.commit) || typeof saved.previousOwnerId !== 'string' || typeof saved.reason !== 'string' || !Number.isSafeInteger(saved.at)) throw new Error('Invalid persisted recovery fallback')
        recovery = { commit: saved.commit, previousOwnerId: saved.previousOwnerId, reason: saved.reason, at: saved.at as number }
      }
      record.task = { taskId: task.taskId, epoch: task.epoch as number, baseCommit: task.baseCommit,
        ...(typeof task.capturedCommit === 'string' ? { capturedCommit: task.capturedCommit } : {}), ...(recovery === undefined ? {} : { recovery }) }
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
      await this.worktreeAdd(source, workspace, saved.baseCommit, signal)
      await writePrivateJson(this.memberPath(mission.id, memberId), { version: 1, missionId: mission.id, memberId, workspace } satisfies MemberWorkspace)
      return workspace
    })
  }

  /** Dependency directory names the plugin links into checkouts; never member work. */
  private dependencyNames(): ReadonlySet<string> {
    return new Set(this.options.verificationDependencyDirs ?? DEFAULT_VERIFICATION_DEPENDENCY_DIRS)
  }

  /**
   * The shortest prefix of `relative` that names a dependency directory
   * (`node_modules` or a configured name) and exists as a directory or symlink,
   * or undefined when the path is real work. `git status --untracked-files=all`
   * lists the files inside an untracked directory and never the directory name,
   * so the check must walk ancestors (advisory A2). A regular file that merely
   * shares a dependency name is ordinary work and is still refused.
   */
  private async dependencyPrefix(workspace: string, relative: string): Promise<string | undefined> {
    const names = this.dependencyNames()
    const parts = relative.split('/').filter(part => part !== '')
    for (let index = 1; index <= parts.length; index++) {
      if (!names.has(parts[index - 1]!)) continue
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

  async prepareTask(member: Member, task: Task, dependencies: Task[], reviewSource?: Task): Promise<void> {
    await this.operation(member.id, async signal => {
      const record = await this.memberRecord(member)
      if (task.reviewOf !== undefined) {
        if (reviewSource?.id !== task.reviewOf || reviewSource.missionId !== task.missionId || reviewSource.status !== 'submitted' || reviewSource.artifact === undefined) throw new Error('[verification_source_required] Verification requires its exact submitted review source artifact Verify again with `swarm_verify` and the reviewed `taskId`.')
        await this.validateArtifact(member, reviewSource.artifact)
      } else if (reviewSource !== undefined) throw new Error('[review_source_not_verification] Only a verification task can name a review source Correct `reviewOf` with `swarm_propose` and retry.')
      const taskOwner = await readJson(this.taskPath(member.missionId, task.id))
      const ownsRecovery = taskOwner === undefined || (isRecord(taskOwner) && taskOwner.memberId === member.id)
      const sameReview = reviewSource === undefined || record.task?.baseCommit === reviewSource.artifact?.commit
      if (sameReview && ownsRecovery && record.task?.taskId === task.id && record.task.epoch === task.epoch) return
      if (sameReview && ownsRecovery && record.task?.taskId === task.id) {
        if (record.task.epoch > task.epoch) throw new Error('Task attempt is older than the prepared workspace')
        // Same-task recovery keeps both committed and uncommitted progress. The
        // runtime must stop the previous attempt before preparing its replacement.
        record.task.epoch = task.epoch
        await this.saveTaskWorkspace(record)
        return
      }
      if ((await this.uncommittedWork(member.workspace, signal)).length > 0) throw new Error('[workspace_uncommitted] Member workspace has uncommitted work; submit or resolve it before starting another task Submit the work with `swarm_submit` and its `taskId`, then retry.')
      const previousHead = await this.git(member.workspace, ['rev-parse', 'HEAD^{commit}'], signal)
      if (record.task !== undefined && previousHead !== (record.task.capturedCommit ?? record.task.baseCommit)) throw new Error('[commits_unsubmitted] Member has unsubmitted commits; capture them before preparing another task Submit the commits with `swarm_submit` and its `taskId`, then retry.')
      if (record.task !== undefined && record.task.taskId !== task.id) await this.checkpointAbandonedTask(record, task.id)
      // Each task starts only with the mission base and explicitly accepted dependencies.
      // Captured task commits have durable Git refs; a rejected experiment cannot leak in.
      const mission = await this.missionRecord(member.missionId)
      const recovery = reviewSource === undefined ? await this.recoverTask(member, task) : undefined
      const reviewCommit = reviewSource?.artifact?.commit
      try {
        await this.git(member.workspace, ['checkout', '--detach', reviewCommit ?? recovery?.commit ?? mission.baseCommit], signal)
        if (recovery === undefined && reviewCommit === undefined) for (const dependency of dependencies) {
          if (dependency.status !== 'accepted') throw new Error(`Dependency ${dependency.id} is not accepted`)
          if (dependency.artifact === undefined) {
            if (dependency.kind === 'implementation' || dependency.kind === 'integration') throw new Error(`Dependency ${dependency.id} has no immutable artifact`)
            continue
          }
          await this.validateArtifact(member, dependency.artifact)
          try { await this.git(member.workspace, ['merge', '--no-edit', '--no-ff', dependency.artifact.commit], signal) }
          catch (error) { throw new Error(`Dependency integration conflict for ${dependency.id}: ${String(error)}`) }
        }
        record.task = { taskId: task.id, epoch: task.epoch, baseCommit: recovery?.baseCommit ?? await this.git(member.workspace, ['rev-parse', 'HEAD^{commit}'], signal),
          ...(recovery?.recovery === undefined ? {} : { recovery: recovery.recovery }) }
        await this.saveTaskWorkspace(record)
      } catch (error) {
        // Entry required a clean owned checkout; rollback restores exactly that
        // state and leaves all captured commits reachable through swarm refs.
        await this.git(member.workspace, ['merge', '--abort']).catch(() => undefined)
        await this.git(member.workspace, ['reset', '--hard', previousHead])
        throw error
      }
    })
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
  private async recoverTask(member: Member, task: Task): Promise<(Pick<Artifact, 'commit' | 'baseCommit'> & { recovery?: TaskRecovery }) | undefined> {
    const value = await readJson(this.taskPath(member.missionId, task.id))
    if (value === undefined) return undefined
    if (!isRecord(value) || value.version !== 1 || value.missionId !== member.missionId || typeof value.memberId !== 'string' || typeof value.workspace !== 'string' || !isRecord(value.task) || value.task.taskId !== task.id || !Number.isSafeInteger(value.task.epoch) || !commitId(value.task.baseCommit)) throw new Error('Invalid task recovery metadata')
    if (Number(value.task.epoch) >= task.epoch) throw new Error('Task workspace is already owned by this or a newer attempt')
    const prior = await this.memberRecord({ id: value.memberId, missionId: member.missionId, workspace: value.workspace })
    if (prior.task?.taskId === task.id) {
      // Task scoping is checked before committing partial work. The old worktree
      // is preserved if that check fails; no partial change is silently dropped.
      try {
        return await this.captureArtifact({ ...member, id: value.memberId, workspace: value.workspace }, { ...task, epoch: prior.task.epoch })
      } catch (error) {
        // W9: the previous owner's workspace cannot be captured (out-of-scope,
        // dirty or otherwise). Never dead-end the task permanently: leave that
        // worktree exactly as it is, fall back to the last durable checkpoint or
        // the recorded task base, and record the fallback durably so the next
        // attempt starts from a clean baseline instead of blocking forever.
        const commit = commitId(value.task.capturedCommit) ? value.task.capturedCommit : value.task.baseCommit
        const recovery: TaskRecovery = { commit, previousOwnerId: value.memberId, reason: error instanceof Error ? error.message : String(error), at: Date.now() }
        this.recordRecoveryFallback(member.missionId, task.id, task.epoch, recovery)
        return { commit, baseCommit: value.task.baseCommit, recovery }
      }
    }
    if (!commitId(value.task.capturedCommit)) {
      // The recorded owner moved on without ever capturing a commit. It could
      // only leave for another task from a clean workspace at the recorded base
      // (prepareTask refuses a dirty or ahead workspace), so that base is the
      // immutable checkpoint. Recover from it instead of dead-ending the task
      // permanently; a fresh record is written for the new attempt below.
      return { commit: value.task.baseCommit, baseCommit: value.task.baseCommit }
    }
    return { commit: value.task.capturedCommit, baseCommit: value.task.baseCommit }
  }

  /** Bounded, host-visible record of a W9 recovery fallback; never masks the recovery. */
  private recordRecoveryFallback(missionId: string, taskId: string, epoch: number, recovery: TaskRecovery): void {
    const message = `Recovery fallback for ${taskId} (epoch ${epoch}): could not capture ${recovery.previousOwnerId}'s workspace (${recovery.reason}); started from ${recovery.commit}`
    this.recoveryIssues.push(message)
    if (this.recoveryIssues.length > 50) this.recoveryIssues.splice(0, this.recoveryIssues.length - 50)
    try { this.options.onRecoveryFallback?.({ missionId, taskId, epoch, previousOwnerId: recovery.previousOwnerId, commit: recovery.commit, reason: recovery.reason }) }
    catch { /* reporting must not mask recovery */ }
  }

  private async validateArtifact(member: Member, artifact: Artifact): Promise<void> {
    if (!commitId(artifact.commit) || !commitId(artifact.baseCommit)) throw new Error('Artifact requires exact commit hashes')
    const mission = await this.missionRecord(member.missionId)
    await this.git(mission.source, ['cat-file', '-e', `${artifact.commit}^{commit}`])
    await this.git(mission.source, ['merge-base', '--is-ancestor', artifact.baseCommit, artifact.commit])
    await this.git(mission.source, ['merge-base', '--is-ancestor', mission.baseCommit, artifact.commit])
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
      if (!await this.git(workspace, ['cat-file', '-e', `HEAD:${prefix}`], signal).then(() => true, () => false)) links.add(prefix)
    }
    return links
  }

  async captureArtifact(member: Member, task: Task): Promise<Artifact> {
    return await this.operation(member.id, async signal => {
      const record = await this.memberRecord(member)
      if (record.task?.taskId !== task.id || record.task.epoch !== task.epoch) throw new Error('[workspace_baseline_missing] Task has no matching prepared workspace baseline Retry the task with `swarm_claim` and its `taskId`.')
      const baseCommit = record.task.baseCommit
      // Member-created dependency links are toolchain state, not work: they are
      // excluded from the changed set, unstaged if an earlier capture staged
      // them, and kept out of the commit. A tracked path of the same name stays
      // ordinary work and is still scope-checked.
      const links = await this.dependencyLinks(member.workspace, signal)
      // A dependency prefix covers the directory and everything inside it, so a
      // real untracked dependency directory is excluded as one unit (A2).
      const linkList = [...links]
      const dependencyContent = (name: string): boolean => linkList.some(link => name === link || name.startsWith(`${link}/`))
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
      const staged = await this.git(member.workspace, ['diff', '--cached', '--name-only', '--no-renames', '-z'], signal, undefined, INVENTORY_BYTES)
      if (staged.length > 0) await this.git(member.workspace, ['commit', '--no-verify', '-m', `swarm: ${task.title.slice(0, 160)}`], signal, undefined, INVENTORY_BYTES)
      const commit = await this.git(member.workspace, ['rev-parse', 'HEAD^{commit}'], signal)
      await this.git(member.workspace, ['merge-base', '--is-ancestor', baseCommit, commit], signal)
      const changedPaths = (await this.git(member.workspace, ['diff', '--name-only', '--no-renames', '-z', baseCommit, commit, '--'], signal, undefined, INVENTORY_BYTES)).split('\0').filter(Boolean)
      for (const name of changedPaths) if (!withinScope(name, task.scope)) throw new Error(`Committed artifact changes path outside task scope: ${name}`)
      // The commit is authoritative: re-check the recorded blobs so a working
      // tree edited after staging cannot smuggle a symlink into the artifact.
      await this.assertCommittedSymlinks(member.workspace, baseCommit, commit, signal)
      await this.publishArtifactRef(member.missionId, member.workspace, commit, `refs/artifacts/${segment(task.id)}/${task.epoch}`, `refs/swarm/${segment(member.missionId)}/${segment(task.id)}/${task.epoch}`, signal)
      record.task.capturedCommit = commit
      await this.saveTaskWorkspace(record)
      return { commit, baseCommit, workspace: member.workspace, changedPaths }
    })
  }

  async verifyArtifact(member: Member, task: Task, artifact: Artifact, signal?: AbortSignal): Promise<CheckResult[]> {
    return await this.operation(member.id, async signal => {
      await this.memberRecord(member)
      await this.validateArtifact(member, artifact)
      const mission = await this.missionRecord(member.missionId)
      // Revocation fencing: the verification checkout is created only after the
      // persisted mission manifest still authorizes its recorded root.
      await this.assertWorkspaceAuthorized(mission.source, mission.workspaceGrantRoot, mission.workspaceAuthorizationSource)
      // R11-19: declared-check executions are bounded per host. A verification
      // beyond the limit waits here in FIFO order (abort-aware), and its wait is
      // measured. The adapter reports `verification` activity for the whole
      // call, so the runtime's lease renewal keeps the queued attempt alive.
      const waitMs = await this.checks.acquire(signal)
      const startedAt = Date.now()
      let released = false
      const release = (): void => { if (!released) { released = true; this.checks.release(Date.now() - startedAt) } }
      const checkout = path.join(this.missionDir(member.missionId), 'verification', randomUUID())
      try {
        await mkdir(path.dirname(checkout), { recursive: true, mode: 0o700 })
        await this.worktreeAdd(mission.source, checkout, artifact.commit, signal)
        const linked = await this.linkDependencyDirs(mission.source, checkout, signal)
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
        environment.dependencyLinks = { ...environment.dependencyLinks, dirs: linked.length ? linked : environment.dependencyLinks.dirs }
        const results: CheckResult[] = []
        let first = true
        for (const command of task.checks) {
          signal.throwIfAborted()
          const argv = await this.options.confineCheck(['/bin/sh', '-c', command], checkout)
          const commandStarted = Date.now()
          const result = await runProcess(argv, { cwd: checkout, signal, timeoutMs: task.checkTimeoutMs ?? this.options.checkTimeoutMs, maxBytes: this.options.maxCheckOutputBytes, env, captureAttribution: true })
          // Exit 127 is "command not found": name the environment cause so a reviewer does not retry the same artifact blindly.
          const output = result.exitCode === 127
            ? `${result.output}\n[swarm] exit 127: a command in this check was not found in the clean verification checkout. ${this.dependencyMode() === 'copy' ? 'Copied' : 'Linked'} dependency directories from the source: ${linked.length ? linked.join(', ') : 'none (install dependencies in the source project, or choose checks that need no installed toolchain)'}. The artifact itself was not changed by this failure.`
            : result.output
          // ENV: attribution and environment are written BEFORE the free-form
          // output, so a bound on the record removes detail rather than the
          // failing test names, the TAP summary and the stage that failed.
          const attribution: CheckAttribution | undefined = result.attribution === undefined ? undefined
            : { index: results.length + 1, command, ...result.attribution }
          results.push({ command, exitCode: result.exitCode, ...(attribution === undefined ? {} : { attribution }), environment, output, truncated: result.truncated })
          // ENV: the most recent completed check, whatever its verdict, so the
          // measured envelope never carries a stale attribution from an earlier run.
          this.lastCheck = { memberId: member.id, taskId: task.id, at: Date.now(), environment, ...(attribution === undefined ? {} : { attribution }), output: boundedOutput(output) }
          // The queue wait belongs to the first check of this verification; the
          // run time is the check's own execution.
          this.recordCheckEnvelope(member, task, command, first ? waitMs : 0, Date.now() - commandStarted)
          first = false
          if (result.exitCode !== 0) break
        }
        return results
      } finally {
        release()
        await this.cleanupVerification(mission.source, checkout)
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
  private async cleanupVerification(source: string, checkout: string): Promise<void> {
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
    this.recordCleanupIssue(checkout, failure)
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

  private recordCleanupIssue(checkout: string, failure: unknown): void {
    const message = `Verification checkout cleanup failed for ${checkout}: ${failure instanceof Error ? failure.message : String(failure)}`
    this.cleanupIssues.push(message)
    if (this.cleanupIssues.length > 50) this.cleanupIssues.splice(0, this.cleanupIssues.length - 50)
    try { this.options.onCleanupFailure?.({ checkout, error: message }) } catch { /* reporting must not mask results */ }
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
      if (!entry.endsWith('/')) continue
      const relative = entry.slice(0, -1)
      if (!names.has(path.basename(relative)) || relative.split('/').some(part => part === '..' || part === '')) continue
      const target = path.join(source, relative), link = path.join(checkout, relative)
      const targetStat = await lstat(target).catch(() => undefined)
      if (targetStat === undefined || !targetStat.isDirectory()) continue
      if (await lstat(link).then(() => true, () => false)) continue
      await mkdir(path.dirname(link), { recursive: true })
      if (copy) await cp(target, link, { recursive: true, dereference: false, verbatimSymlinks: true })
      else await symlink(target, link, 'dir')
      linked.push(relative)
    }
    return linked
  }
  async dispose(): Promise<void> {
    this.closing = true
    for (const active of this.controllers.values()) for (const controller of active) controller.abort('adapter disposed')
    await Promise.allSettled([...this.inFlight])
  }
}
