/** Durable collaboration policy. Worker lifecycle and filesystem effects belong to the adapter. */
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { SwarmStore, WriterBusyError, StoreRecoveryError, stageRestore, type PendingRestore, type PostFilter, type StoreOptions } from './store.ts'
import { Attempts } from './attempts.ts'
import type { WorkspaceGrantSnapshot } from './authorization.ts'
import { WorkspaceAdmission, gitWriteDeniedMessage, TEMP_RENDEZVOUS_WINDOW_MS, type TempMention } from './workspace-admission.ts'
import { Notices, AUTO_REVIEW_GRACE_MS, missionSubject, subjectsOfTasks, taskSubject, type NotifyOptions, type WakePrecision } from './notices.ts'
import { RefusalRegistry, emitGuardTerminal, requireStrings, requireText, sameChecks, unsupportedEffort, validatedBudget } from './refusals.ts'
import { Scheduling } from './scheduling.ts'
// R17-G6/G7: the one derivation of mission derived state and its host projection.
import { deriveMemberBoard, deriveMemberStatus, memberPhaseOf, type MissionBoardMember } from './projection.ts'
import type { MissionInterpretation } from './notices.ts'
export { emptyUsage, addUsage, missionFingerprint, type MissionFingerprintBoard } from './gates.ts'
import { RuntimeGates, emptyUsage, addUsage, BOARD_DELTA_POSTS, postView, type MissionFingerprintBoard } from './gates.ts'
import { DeclaredChecks, MAX_REPORTED_CHECK_FAILURES, excerpt } from './declared-checks.ts'
export { TEMP_RENDEZVOUS_WINDOW_MS, sharedTempPaths, tempRendezvousDecision, WorkspaceRevokedError, type TempMention } from './workspace-admission.ts'
import { proposalAllowance as computeProposalAllowance } from './arena.ts'
import { AdmissionRefusedError, classifyProviderOutage, LIMIT_LEVELS, scopeKeysOverlap, TASK_CLASSES, type AdmissionCandidate, type AdmissionDecision, type AdmissionReason, type AdmissionRecord, type LimitLevel, type LimitRule } from './scheduler.ts'
import { validScope } from './scope.ts'
import { assertScopeSelectors, formatDiagnostic, liveReviewFor, loadPackageScripts, normalizeReviewDependencies, normalizeScopeSelectors, normalizeTaskCeilings, reconcileTaskAdmission, requireHostChecks, taskCeilingBlock } from './admission.ts'
import { orderedTasks, validatePlan } from './plans.ts'
import { OWNER_ONLY_TOOLS, type Actor, type AutoStart, BoardQuery, Budget, CheckEnvelope, CreateMissionInput, CriticalPath, Delivery, DraftPlan, Escalation, Evidence, EvidenceStatus, Member, MemberStatus, Mission, NoticeClass, ObserveQuery, MessageInput, PlanInput, Post, PostInput, PostKind, ProposeTaskInput, ProviderOutage, PublishInput, RequestStartInput, RuntimeConfig, SchedulingPass, Snapshot, Task, TaskCeiling, ToolRun, UsageBuckets, WorkerAdapter, WorkerActivity, Workstream } from './types.ts'
import { nextWorkerName } from './types.ts'
// ENV: the declared-check environment is authored by the host's workspace layer
// and read here through a type-only import, so the policy module never depends
// on the Node worktree module at runtime.
import type { CheckAttribution, CheckEnvironment, ObservedCheck } from './workspaces.ts'

const id = (prefix: string) => `${prefix}_${randomUUID()}`
const terminal = (mission: Mission) => mission.status === 'stopped' || mission.status === 'completed'
/** Closed board kind vocabulary; a free-form kind is a validation error. */
const POST_KINDS: readonly PostKind[] = ['ASK', 'ANSWER', 'IDEA', 'ALERT', 'ARTIFACT', 'HANDOFF']

/** Board delta reads are bounded to this page size unless the caller asks for less. */
const BOARD_PAGE_MAX = 100
const BOARD_PAGE_DEFAULT = 20




/** R11-01: how long a classified provider outage keeps a member's route quiescent. */
const PROVIDER_OUTAGE_WINDOW_MS = 5 * 60_000
/** R11-01: bound the durable outage log to one row per member and class per window. */
const PROVIDER_OUTAGE_EVENT_WINDOW_MS = 30_000
/** Idle close-out nudges before an open attempt is checkpointed and re-pended. */









/**
 * S1: consecutive scheduling passes that advance no durable mission state and
 * terminate nothing before the runtime escalates. Defaults are expressed as
 * integer multiples of `tickMs` and are configuration (RuntimeConfig.
 * `stallPasses` / `stallPassTimeoutMs`), never a constant a stalled board can be
 * trapped behind.
 */
const DEFAULT_STALL_PASSES = 3
const DEFAULT_STALL_PASS_TIMEOUT_TICKS = 30
/**
 * R16-D: the declared bound on how long a live attempt may record no durable
 * progress before the runtime escalates it by name (`attempt-silent:`). The
 * default matches the longest wait this host itself treats as bounded (F1's
 * `operationBoundMs` / the harness's 600 s `maxWaitTimeoutMs`): an attempt that
 * has recorded nothing at all for that long is past the point where a live lease
 * can still be read as progress. Configuration, never a constant the runtime is
 * trapped behind: `attemptSilenceBoundMs` on the runtime config, `0` disables
 * the guard, an invalid value keeps this default.
 */
const DEFAULT_ATTEMPT_SILENCE_BOUND_MS = 10 * 60_000
/**
 * R16-D: the additional declared window a wedged scheduling pass may keep the
 * mission's guard while the mission still has live work. The default is the pass
 * bound itself (so a wedge may hold the guard for at most 2 × `stallPassTimeoutMs`
 * before the release), and it is configuration: `stallPassLiveGraceMs` on the
 * runtime config, `0` meaning "release at the first bound". Without it the
 * release was unbounded — a wedged pass waited for every unrelated lease to
 * lapse, exactly the silent blocking round 16 removes.
 */
const DEFAULT_STALL_PASS_LIVE_GRACE_TICKS = 1
/**
 * R5-02: consecutive `workers.start` failures for one member before its work is
 * re-routed to another capable live member. A transient start failure self-heals
 * on the next tick; only a route that keeps failing is retired.
 */
const START_FAILURE_REROUTE_LIMIT = 3
/**
 * F2: recovery budget for a verification task the runtime admits automatically
 * when a submitted code deliverable has no live review path. Two attempts cover
 * a transient workspace/preparation failure without letting the automatic review
 * consume an unbounded share of the mission budget.
 */
const AUTO_REVIEW_RECOVERY_ATTEMPTS = 2
































/**
 * `detail=full` is an owner-only read. Worker guidance alone did not prevent its
 * use (docs/observe-context-measurement.md), so the runtime refuses it; callers
 * branch on the class, never on message text. The message names the owner gate
 * so the trace classifier records an authorization error.
 */
export class ObserveDetailRefusedError extends Error {
  readonly code = 'observe_detail_full_owner_only'
  constructor() {
    super('Only the mission owner may read detail=full; workers read bounded records with taskId, runId, evidenceId, after or afterRun')
    this.name = 'ObserveDetailRefusedError'
  }
}
/** ENV: one field of the declared-check envelope a self-run does not reproduce. */
export interface CheckEnvironmentMismatch { field: string; envelope: string; selfRun: string }
/**
 * ENV: the envelope reproduction comparison. `blocking` divergences mean the
 * verification attempt's self-run cannot reproduce the environment the host
 * check runs under, so the mismatch is reported instead of accepting the
 * artifact. `advisory` divergences (whether a cache root happened to exist) are
 * recorded but never refuse an acceptance: a check must not depend on the
 * ambient cache staying warm.
 */
export interface CheckEnvironmentComparison { blocking: CheckEnvironmentMismatch[]; advisory: CheckEnvironmentMismatch[] }
const checkEnvironmentField = (value: string | boolean | null): string => value === null ? 'absent' : String(value)
/** ENV: the cache roots as one comparable field; `none` when the environment sets none. */
const checkCacheRootsField = (roots: Record<string, string>): string =>
  Object.keys(roots).sort().map(name => `${name}=${roots[name]}`).join(', ') || 'none'
/**
 * ENV: compare the declared envelope the runtime delivered with the environment
 * a verification attempt's self-run reports. HOME, the user cache roots, the
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
  compare('dependencyLinks.dirs', envelope.dependencyLinks?.dirs.join(', ') || 'none', selfRun.dependencyLinks?.dirs.join(', ') || 'none', blocking)
  compare('userCacheDirExists', envelope.userCacheDirExists, selfRun.userCacheDirExists, advisory)
  compare('huggingfaceCacheDirExists', envelope.huggingfaceCacheDirExists, selfRun.huggingfaceCacheDirExists, advisory)
  // ENV-R: the scoped roots the envelope provides are divergences a self-run
  // cannot reproduce, and a self-run that sets its own cache roots diverges from
  // the envelope's. Both are named with both values so the record shows the
  // difference, never an empty comparison that hides it.
  compare('xdgCacheHome', envelope.xdgCacheHome, selfRun.xdgCacheHome, advisory)
  compare('checkCacheRoot', envelope.checkCacheRoot, selfRun.checkCacheRoot, advisory)
  compare('checkCacheRoots', checkCacheRootsField(envelope.checkCacheRoots), checkCacheRootsField(selfRun.checkCacheRoots), advisory)
  return { blocking, advisory }
}
/**
 * ENV: a verification whose self-run environment cannot reproduce the
 * declared-check envelope. The verdict is refused rather than accepting an
 * artifact that was only ever validated under a different environment.
 */
export class CheckEnvironmentMismatchError extends Error {
  readonly code = 'check_environment_mismatch'
  constructor(message: string) {
    super(message)
    this.name = 'CheckEnvironmentMismatchError'
  }
}
/** ENV-R: the environment names the declared-check envelope records. */
const SELF_RUN_FACTS = new Set(['HOME', 'XDG_CACHE_HOME', 'npm_config_cache', 'YARN_CACHE_FOLDER', 'PIP_CACHE_DIR', 'GOCACHE'])
/** ENV-R: the shells whose `-c` body is itself a command that may declare facts. */
const SELF_RUN_SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh'])
/** ENV-R: how deep a nested `sh -c` body is followed before the text is treated as opaque. */
const SELF_RUN_MAX_DEPTH = 4
/**
 * ENV-R: the semantics this extractor does NOT model, stated so a reader does
 * not over-trust it. It reads the command TEXT, which is what the runtime
 * durably records; it is not a shell. Every entry below is pinned by a test in
 * `tests/check-envelope.test.mjs` that asserts the direction it claims.
 *
 * - A non-literal value is recorded as the literal text the command contains
 *   (`HOME=$X` records `$X`), never resolved: an environment the extractor
 *   cannot resolve is REPORTED as a divergence rather than assumed equal, which
 *   is the guard's purpose — an artifact validated under an environment the
 *   host cannot confirm must not be accepted.
 * - `set -a`, `source`/`.` and a function body are not followed: an override
 *   they apply is recorded as ABSENT (permissive — the guard is no more
 *   refusing than before this repair). A heredoc BODY is stripped from the
 *   command before it is read, so it is never read as code at all.
 * - `env -S` is not split, and `export -n NAME[=VALUE]`/`export -f`/`export -p`
 *   are not modelled: an override in those forms is recorded as ABSENT
 *   (permissive). `export -n HOME=/x` leaves the child without HOME, and the
 *   extractor records no override rather than an assignment the child never
 *   sees.
 *
 * Two forms that used to be wrong are now modelled explicitly: `unset -f`/
 * `unset -n` (and any unset option other than `-v`/`--`) record NOTHING, because
 * they act on functions and namerefs rather than on the variable, and a quoted
 * `NAME=VALUE` word after `env`/`export` records an assignment, because those
 * builtins parse their arguments after quote removal.
 */
export const SELF_RUN_EXTRACTOR_LIMITATIONS: readonly string[] = Object.freeze([
  'a non-literal value is recorded as its literal text (`HOME=$X` records `$X`): reported as a divergence, never resolved',
  '`set -a`, `source`/`.` and function bodies are not followed: their override is recorded as absent (permissive); a heredoc body is stripped before the command is read, so it is never read as code',
  '`env -S` is not split, and `export -n NAME[=VALUE]`, `export -f` and `export -p` are not modelled: their override is recorded as absent (permissive)',
])
/**
 * ENV-R: the `unset` options that act on a VARIABLE. Any other option (`-f`,
 * `-n`, combined forms) makes the command act on functions or namerefs, so the
 * words after it are not removals of the names the envelope records.
 */
const UNSET_VARIABLE_OPTIONS = new Set(['-v', '--'])
/** ENV-R: the `env` options whose argument the extractor must consume rather than read as a fact. */
const ENV_CHDIR_OPTIONS = new Set(['-C', '--chdir'])
/** ENV-R: one environment operation a self-run command declares for itself. */
export interface SelfRunEnvironmentOperation { name: string; value: string | null }
/** ENV-R: the environment a self-run command gives itself, read from its command text. */
export interface SelfRunEnvironmentSource {
  /** Ordered operations; `value: null` means the command removes the name. */
  operations: SelfRunEnvironmentOperation[]
  /** True when the command starts from an empty environment (`env -i`/`--ignore-environment`/`-`). */
  cleared: boolean
}
/** ENV-R: how the environment facts on a durable tool-run row were derived. */
export interface SelfRunEnvironmentProvenance extends SelfRunEnvironmentSource {
  /** The facts were read from the recorded command's own text; absent means the ambient host facts. */
  from: 'command'
}
/**
 * ENV-R4 D3: remove heredoc bodies from a command before it is read. A body is
 * DATA, not shell code: under any preceding segment (an `export` included) its
 * lines must never be read as environment assignments. Each `<<`/`<<-`
 * redirection outside quotes contributes a delimiter; the following lines are
 * dropped up to and including each terminator line, in order, so several
 * heredocs in one command are consumed correctly. `<<<` (a here-string) is not
 * a heredoc and is left alone.
 */
function stripHeredocBodies(command: string): string {
  const kept: string[] = []
  const pending: Array<{ delimiter: string; tabs: boolean }> = []
  for (const line of command.split('\n')) {
    if (pending.length > 0) {
      const head = pending[0]!
      const candidate = head.tabs ? line.replace(/^\t+/, '') : line
      if (candidate === head.delimiter) pending.shift()
      continue
    }
    kept.push(line)
    pending.push(...heredocDelimiters(line))
  }
  return kept.join('\n')
}
/** ENV-R4 D3: the heredoc delimiters one line opens, outside quotes and never for `<<<`. */
function heredocDelimiters(line: string): Array<{ delimiter: string; tabs: boolean }> {
  const found: Array<{ delimiter: string; tabs: boolean }> = []
  let index = 0, quote: string | null = null
  while (index < line.length) {
    const char = line[index]!
    if (quote !== null) { if (char === quote) quote = null; index += 1; continue }
    if (char === "'" || char === '"') { quote = char; index += 1; continue }
    if (char === '\\') { index += 2; continue }
    if (char === '<' && line[index + 1] === '<' && line[index + 2] !== '<') {
      const tabs = line[index + 2] === '-'
      index += tabs ? 3 : 2
      while (index < line.length && /\s/.test(line[index]!)) index += 1
      let word = '', inner: string | null = null
      while (index < line.length) {
        const current = line[index]!
        if (inner !== null) { if (current === inner) inner = null; else word += current; index += 1; continue }
        if (current === "'" || current === '"') { inner = current; index += 1; continue }
        if (/\s/.test(current)) break
        word += current
        index += 1
      }
      if (word.length > 0) found.push({ delimiter: word, tabs })
      continue
    }
    index += 1
  }
  return found
}
interface ShellWord {
  text: string
  operator: boolean
  /** An assignment whose `NAME=` prefix was unquoted: valid at segment start and after `env`/`export`. */
  assignment?: { name: string; value: string }
  /** An assignment read from the quote-removed word: valid only where a builtin parses it (`env`, `export`). */
  valueAssignment?: { name: string; value: string }
}
/**
 * ENV-R: split one command line into shell words, operators and the unquoted
 * assignment words. Quotes are removed from `text`; an assignment is recognized
 * only when its `NAME=` prefix is itself unquoted and the name is a valid
 * identifier, so a quoted mention (`grep "HOME=/x" f`) stays an argument.
 */
function shellWords(command: string): ShellWord[] {
  const words: ShellWord[] = []
  let index = 0
  while (index < command.length) {
    const char = command[index]!
    // ENV-R4 D3: a newline ends the simple command exactly like `;`. Without
    // this, an `export` segment leaked across the newline and a heredoc body's
    // `HOME=/x` was read as an export operand — a false blocking divergence for
    // a command that really runs with the ambient HOME.
    if (char === '\n') { words.push({ text: '\n', operator: true }); index += 1; continue }
    if (/\s/.test(char)) { index += 1; continue }
    if (command.startsWith('&&', index) || command.startsWith('||', index)) { words.push({ text: command.slice(index, index + 2), operator: true }); index += 2; continue }
    if (char === ';' || char === '|' || char === '&' || char === '(' || char === ')') { words.push({ text: char, operator: true }); index += 1; continue }
    let text = '', name = '', quotedName = false, closed = false, nameValid = true
    while (index < command.length) {
      const current = command[index]!
      // Command substitution is part of the word, not a subshell operator: a
      // value like `$(pwd)` is recorded as the text the command contains (the
      // documented non-literal direction).
      if (current === '$' && command[index + 1] === '(') {
        let depth = 0
        while (index < command.length) {
          const inner = command[index]!
          text += inner
          index += 1
          if (inner === '(') depth += 1
          else if (inner === ')') { depth -= 1; if (depth === 0) break }
        }
        continue
      }
      if (/\s/.test(current) || current === ';' || current === '|' || current === '&' || current === '(' || current === ')') break
      if (current === "'") {
        index += 1
        if (!closed) quotedName = true
        while (index < command.length && command[index] !== "'") { text += command[index]; index += 1 }
        index += 1
        continue
      }
      if (current === '"') {
        index += 1
        if (!closed) quotedName = true
        while (index < command.length && command[index] !== '"') {
          if (command[index] === '\\' && index + 1 < command.length && '"\\$`'.includes(command[index + 1]!)) index += 1
          text += command[index]; index += 1
        }
        index += 1
        continue
      }
      if (current === '\\') { index += 1; if (index < command.length) { text += command[index]; index += 1 }; continue }
      if (current === '`') {
        text += current
        index += 1
        while (index < command.length && command[index] !== '`') { text += command[index]; index += 1 }
        if (index < command.length) { text += command[index]; index += 1 }
        continue
      }
      if (!closed) {
        if (current === '=') closed = true
        else if (name.length === 0 ? /[A-Za-z_]/.test(current) : /[A-Za-z0-9_]/.test(current)) name += current
        else nameValid = false
      }
      text += current
      index += 1
    }
    const assignment = closed && !quotedName && nameValid && name.length > 0 ? { name, value: text.slice(name.length + 1) } : undefined
    const equals = text.indexOf('=')
    const assignedName = equals > 0 ? text.slice(0, equals) : ''
    const valueAssignment = assignedName.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(assignedName)
      ? { name: assignedName, value: text.slice(equals + 1) } : undefined
    words.push({ text, operator: false, ...(assignment === undefined ? {} : { assignment }), ...(valueAssignment === undefined ? {} : { valueAssignment }) })
  }
  return words
}
/**
 * ENV-R: the environment one recorded command declares for itself, read from
 * the durable command text. Segment-initial unquoted `NAME=VALUE` words (also
 * after `&&`, `||`, `;`, `|`, `(`, at the start of a shell `-c` body and after
 * `env`), `export NAME=VALUE`, `env [-i|--ignore-environment|-]`, `env -u NAME`
 * and `unset NAME` are the forms recognized; only the names the envelope
 * records are kept. See {@link SELF_RUN_EXTRACTOR_LIMITATIONS}.
 */
export function selfRunEnvironmentSource(command: unknown): SelfRunEnvironmentSource {
  const operations: SelfRunEnvironmentOperation[] = []
  const source: SelfRunEnvironmentSource = { operations, cleared: false }
  if (typeof command !== 'string' || command.length === 0) return source
  const record = (name: string, value: string | null): void => { if (SELF_RUN_FACTS.has(name)) operations.push({ name, value }) }
  const walk = (words: ShellWord[], depth: number): void => {
    let segmentStart = true, commandWord = '', mode: 'plain' | 'env' | 'export' | 'unset' = 'plain'
    let pendingUnset = false, pendingShellBody = false, pendingEnvArgument = false, exportUnmodelled = false
    for (const word of words) {
      if (word.operator) { segmentStart = true; commandWord = ''; mode = 'plain'; pendingUnset = false; pendingShellBody = false; pendingEnvArgument = false; exportUnmodelled = false; continue }
      const base = word.text.split('/').pop() ?? word.text
      if (segmentStart) {
        if (word.assignment !== undefined) { record(word.assignment.name, word.assignment.value); continue }
        commandWord = base
        segmentStart = false
        mode = base === 'env' ? 'env' : base === 'export' ? 'export' : base === 'unset' ? 'unset' : 'plain'
        continue
      }
      if (pendingShellBody) {
        pendingShellBody = false
        // ENV-R5: a nested shell body is read exactly like a top-level command,
        // so the heredoc strip must be re-applied here. The top-level scanner
        // cannot see a `<<DELIM` that sits inside an unterminated quote on the
        // `sh -c '...` line, so without this the body's `HOME=/x` was read as
        // code and the durable row recorded an override the child never had.
        if (depth < SELF_RUN_MAX_DEPTH) walk(shellWords(stripHeredocBodies(word.text)), depth + 1)
        continue
      }
      if (mode === 'env') {
        if (word.text === '-i' || word.text === '--ignore-environment' || word.text === '-') { source.cleared = true; continue }
        if (word.text === '-u' || word.text === '--unset') { pendingUnset = true; continue }
        if (word.text.startsWith('--unset=')) { record(word.text.slice('--unset='.length), null); continue }
        if (pendingUnset) { pendingUnset = false; record(word.text, null); continue }
        // `env -C dir` changes directory; its argument is not an environment fact.
        if (ENV_CHDIR_OPTIONS.has(word.text)) { pendingEnvArgument = true; continue }
        if (pendingEnvArgument) { pendingEnvArgument = false; continue }
        // ENV-R3 D1: `env` parses its OWN arguments after quote removal, so a
        // word whose value is `NAME=VALUE` is an assignment even when it was
        // quoted. At segment start a quoted word stays a command name; here it
        // is an `env` operand.
        const envAssignment = word.assignment ?? word.valueAssignment
        if (envAssignment !== undefined) { record(envAssignment.name, envAssignment.value); continue }
        // `env … <command>`: the command env runs is where later facts come from.
        commandWord = base
        mode = 'plain'
      }
      if (mode === 'export') {
        // ENV-R4 D4: `export -n NAME[=VALUE]` leaves the variable UNEXPORTED
        // (the executed child does not see it), `export -f NAME` exports a
        // function and `export -p` prints; none of them declares an environment
        // fact, so nothing is recorded (permissive). The value form used to be
        // read as an assignment the child never sees.
        if (exportUnmodelled) continue
        if (word.text.startsWith('-') && word.text !== '--') { exportUnmodelled = true; continue }
        // `export "NAME=VALUE"` assigns: the builtin sees the word after quote
        // removal, exactly as `env` does.
        const exported = word.assignment ?? word.valueAssignment
        if (exported !== undefined) record(exported.name, exported.value)
        continue
      }
      if (mode === 'unset') {
        // ENV-R3 D2: `unset -f NAME`/`unset -n NAME` (and any option other than
        // the variable forms) act on functions and namerefs. Recording the
        // following word as a variable removal made `unset -f HOME; echo
        // HOME=$HOME` — a command that really runs with HOME untouched — look
        // like an override and refused an otherwise clean acceptance.
        if (word.text.startsWith('-') && !UNSET_VARIABLE_OPTIONS.has(word.text)) { mode = 'plain'; continue }
        if (!word.text.startsWith('-')) record(word.text, null)
        continue
      }
      if (SELF_RUN_SHELLS.has(commandWord) && word.text === '-c') { pendingShellBody = true; continue }
    }
  }
  walk(shellWords(stripHeredocBodies(command)), 0)
  return source
}
/** Whether a path names an existing directory; an absent root is recorded as absent, never invented. */
function isDirectory(target: string | null): boolean {
  if (target === null) return false
  try { return statSync(target).isDirectory() } catch { return false }
}
/**
 * ENV-R: apply one command's declared environment to the ambient facts a
 * self-run would otherwise inherit, re-deriving the user cache roots and their
 * existence flags for an overridden HOME and carrying the command's own
 * package-manager cache roots. The result is what the durable tool-run row
 * records as the environment that execution really used.
 */
export function selfRunEnvironmentFacts(ambient: CheckEnvironment, source: SelfRunEnvironmentSource): CheckEnvironment {
  const env: Record<string, string> = {}
  if (!source.cleared) {
    if (ambient.home !== null) env.HOME = ambient.home
    if (ambient.xdgCacheHome !== null) env.XDG_CACHE_HOME = ambient.xdgCacheHome
    for (const [name, value] of Object.entries(ambient.checkCacheRoots)) env[name] = value
  }
  for (const operation of source.operations) {
    if (operation.value === null) delete env[operation.name]
    else env[operation.name] = operation.value
  }
  const home = env.HOME === undefined || env.HOME === '' ? null : env.HOME
  const userCacheDir = home === null ? null : join(home, '.cache')
  const huggingfaceCacheDir = userCacheDir === null ? null : join(userCacheDir, 'huggingface')
  const checkCacheRoots: Record<string, string> = { ...ambient.checkCacheRoots }
  for (const name of ['npm_config_cache', 'YARN_CACHE_FOLDER', 'PIP_CACHE_DIR', 'GOCACHE']) {
    const value = env[name]
    if (value === undefined) delete checkCacheRoots[name]
    else checkCacheRoots[name] = value
  }
  return {
    ...ambient,
    home,
    userCacheDir,
    huggingfaceCacheDir,
    userCacheDirExists: isDirectory(userCacheDir),
    huggingfaceCacheDirExists: isDirectory(huggingfaceCacheDir),
    xdgCacheHome: env.XDG_CACHE_HOME === undefined || env.XDG_CACHE_HOME === '' ? null : env.XDG_CACHE_HOME,
    checkCacheRoots,
  }
}
/** ENV-R: the command text of a tool run, when the tool's arguments carry one. */
function recordedCommand(argumentsValue: unknown): string | undefined {
  if (typeof argumentsValue !== 'object' || argumentsValue === null) return undefined
  const command = (argumentsValue as { command?: unknown }).command
  return typeof command === 'string' && command.length > 0 ? command : undefined
}
/** ENV: the measured envelope plus the environment facts and observation the adapter attaches. */
type DeclaredCheckEnvelope = CheckEnvelope & {
  environment?: CheckEnvironment
  selfRunEnvironment?: CheckEnvironment
  observed?: ObservedCheck
}
/** ENV: the environment facts a tool run was recorded under, carried on the durable row. */
type ToolRunWithEnvironment = ToolRun & { checkEnvironment?: CheckEnvironment; checkEnvironmentSource?: SelfRunEnvironmentProvenance }
const isDeclaredCheckEnvironment = (value: unknown): value is CheckEnvironment =>
  typeof value === 'object' && value !== null && 'home' in value && 'sandboxPolicy' in value && 'dependencyLinks' in value && 'checkCacheRoot' in value
/** The model-visible position already delivered to one member; the next default read starts after it. */
interface DeliveredCursor { eventSeq: number; runSeq: number; postSeq: number; current?: string }
/**
 * S5c: consecutive `workers.start` failures, carried on the member row so the
 * count survives a lost map or a restart instead of handing a failing route a
 * fresh budget. `Member` (src/types.ts) is outside this task's write scope, so
 * the field is declared here and travels as a plain JSON property on the same
 * durable row; the integration task records the one-line schema addition.
 */
interface MemberStartFailureFields { startFailures?: number }
const startFailureFields = (member: Member): Member & MemberStartFailureFields => member as Member & MemberStartFailureFields
/** A single runtime owns scheduling, admission, state transitions and a durable outbox. */
/**
 * L3: an owner-facing question is delivered with the exact call that answers it.
 * The owner's prose is not part of this store and never reaches the asker, so the
 * envelope states the receipt requirement where the question is read.
 */
function ownerQuestionContent(missionId: string, deliveryId: string, from: string, content: string, inReplyTo: Delivery | undefined): string {
  const answers = inReplyTo === undefined ? '' : ` (this message also answers ${inReplyTo.id})`
  return [
    content,
    '',
    `[swarm receipt required] ${from} asked this through swarm_message${answers}. Text in this conversation is NOT delivered to the member.`,
    `Answer with: swarm_message({ missionId: "${missionId}", to: "${from}", kind: "question", content: "<your answer>", replyTo: "${deliveryId}" })`,
    `Or close it deliberately: swarm_message({ missionId: "${missionId}", to: "${from}", kind: "question", content: "<why not>", replyTo: "${deliveryId}", dismiss: true })`,
  ].join('\n')
}
export class SwarmRuntime {
  /**
   * S5 inventory of every in-memory `Set`/`Map` reachable from the scheduling
   * path, with its classification (a full version lives in
   * docs/known-limitations.md, "Round-13 control-path slices"):
   *
   *  derivable (the gate re-reads the store; the memory value is only a cache):
   *   - the scheduling pass guard: durable `passes` row (`livePass`/`openPass`);
   *   - the unreviewed-submission grace: age of the durable `task/submitted`
   *     event (`unreviewedStall`; the old `unreviewedSince` timer is removed);
   *   - a withdrawn automatic review: durable `task/review-admitted` events
   *     (`withdrawnAutomaticReview`, `autoReviewAdmissions` as fallback cache);
   *   - a recorded missing review: durable `task/review-missing` event per
   *     submission (`missingReviewRecorded`);
   *   - notice dedup: the durable delivery ledger keyed by class + dedup key
   *     (`parkedNotices`, `reviewPathNotices`, `integrationGapWarned`).
   *  cache-only (loss changes no durable outcome; each is covered by a test that
   *  clears it and asserts the durable result is unchanged):
   *   - `queues`, `releasedPasses`, `idleSignals` (durable `Task.idleSignal`),
   *     `startFailures`, `budgetStops`, `operations`, `startControllers`,
   *     `fingerprintCache` (keyed by store revision), `observeCursors`.
   *
   * There is deliberately no in-memory `scheduled` Set: the Row-13 incident was
   * that Set swallowing the tick timer's only liveness action while the pass it
   * deduplicated never returned.
   */
  readonly store: SwarmStore
  private readonly listeners = new Set<(missionId: string) => void>()
  readonly queues = new Map<string, Promise<unknown>>()
  /**
   * S5: the scheduling guard is a durable per-mission `passes` row (S1), re-read
   * from the store on every kick. There is deliberately no in-memory `scheduled`
   * Set: the Row-13 incident was that Set swallowing the tick timer's only
   * liveness action while the pass it deduplicated never returned.
   */
  private readonly operations = new Set<Promise<unknown>>()
  private readonly startControllers = new Map<string, AbortController>()
  
  
  /**
   * Members that ended a turn while still owning an attempt; drives the bounded
   * close-out. S5 cache: the durable signal is `Task.idleSignal`, written by
   * `onIdle` and re-read by the scheduling pass, so losing this map only delays
   * the close-out until lease expiry.
   */
  /** Consecutive `workers.start` failures per member; a successful start clears the count (R5-02). */
  readonly startFailures = new Map<string, number>()
  /**
   * Delivered observe positions per member. This is a context cache, not mission
   * state: a restart re-sends one bounded focused view and then resumes deltas,
   * so a stale position can never hide events from a member.
   */
  private readonly observeCursors = new Map<string, DeliveredCursor>()
  private timer?: ReturnType<typeof setInterval>
  closed = false
  shuttingDown = false
  /** A classified SQLITE_BUSY that must become a durable `writer_busy` admission row. */
  writerBusy?: { at: number; attempts: number; candidate: AdmissionCandidate; detail: string }
  /**
   * F2: automatic review admissions per submitted source, and the exact
   * owner-notice already sent for an unreviewable one. The map keeps the
   * runtime from admitting a second automatic review after the owner withdrew
   * the first; the set keeps a persistent blocker from waking the owner on
   * every tick.
   */
  private readonly autoReviewAdmissions = new Map<string, string>()
  
  /** Missing-review records already written, keyed by mission:source:submission seq. */
  private readonly reviewPathReported = new Set<string>()
  
  
  
  /** Open runtime transactions; a cached F(S) is not trusted inside one. */
  commitDepth = 0
  /** R11-15: bounded per-path shared-temp mentions, newest last. */
  
  /** R11-15: `path|memberA|memberB` pairs already reported inside the window. */
  

  /** M1a seam 6/7: workspace and admission surface. */
  private readonly workspaceAdmission = new WorkspaceAdmission(this)
  /** The mission is terminal: no further scheduling or fencing applies. */
  isMissionTerminal(mission: Mission): boolean { return terminal(mission) }
  // M1a seam 6/7: the workspace/admission surface lives in src/workspace-admission.ts.
  assertAuthorizedRoot(workspace: string, grantRoot: string | undefined, source?: 'session' | 'grant'): { grantRoot: string; source: 'session' | 'grant' } { return this.workspaceAdmission.assertAuthorizedRoot(workspace, grantRoot, source) }
  async assertWorkspaceAuthorized(mission: Pick<Mission, 'id' | 'workspace' | 'workspaceGrantRoot' | 'workspaceAuthorizationSource'>): Promise<void> { return this.workspaceAdmission.assertWorkspaceAuthorized(mission) }
  fenceWorkspace(missionId: string, reason: string): void { return this.workspaceAdmission.fenceWorkspace(missionId, reason) }
  deniedGitWrite(input: { tool: string; arguments: unknown; result: unknown; isError: boolean }): string | undefined { return this.workspaceAdmission.deniedGitWrite(input) }
  tempRendezvous(memberId: string, taskId: string, input: { tool: string; arguments: unknown }): { path: string; first: TempMention; second: TempMention } | undefined { return this.workspaceAdmission.tempRendezvous(memberId, taskId, input) }
  isolationAllows(missionId: string, member: Member): boolean { return this.workspaceAdmission.isolationAllows(missionId, member) }
  isolationViolations(missionId: string): string[] { return this.workspaceAdmission.isolationViolations(missionId) }

  readonly attempts = new Attempts(this)
  /** M1a seam 4/7: the durable refusal registry and its writer-busy recovery. */
  private readonly refusals = new RefusalRegistry(this)
  private admissionDecision(mission: Mission, member: Member, task: Task): { candidate: AdmissionCandidate; decision: AdmissionDecision } { return this.refusals.admissionDecision(mission, member, task) }
  private admissionRecord(candidate: AdmissionCandidate, decision: AdmissionDecision, latencyMs: number): AdmissionRecord { return this.refusals.admissionRecord(candidate, decision, latencyMs) }
  upsertAdmission(record: AdmissionRecord): void { return this.refusals.upsertAdmission(record) }
  private recordRefusal(candidate: AdmissionCandidate, decision: AdmissionDecision, latencyMs: number): void { return this.refusals.recordRefusal(candidate, decision, latencyMs) }
  upsertBudgetRefusals(mission: Mission, reason: string): void { return this.refusals.upsertBudgetRefusals(mission, reason) }
  private recordWriterBusyRecovery(mission: Mission): void { return this.refusals.recordWriterBusyRecovery(mission) }
  private refuseProposal(mission: Mission, proposer: string, title: string, reason: string, limit: number): never { return this.refusals.refuseProposal(mission, proposer, title, reason, limit) }

  /** M1a seam 3/7: owner notices, witnesses and the outbox that delivers them. */
  private readonly notices = new Notices(this)
  notify(missionId: string, content: string, subjects: string[], options: NotifyOptions = {}): void { return this.notices.notify(missionId, content, subjects, options) }
  /**
   * R17-G8: record real consumption for one owner delivery from the host's
   * claimed signal (the adapter maps `agent/inbox/claimed` to the delivery id).
   * Compare-and-swap inside the mission transaction; delivered, consumed and
   * resolved stay three facts.
   */
  recordConsumption(deliveryId: string, options: { at?: number; source?: string } = {}): boolean { return this.notices.recordConsumption(deliveryId, options) }
  /**
   * R15-A1: the subjects of a notice that is scoped to a task, a member or the
   * mission itself. A task-scoped notice names that task at its epoch; a
   * member-scoped notice names the member's unfinished work; the mission root is
   * the fallback only when neither exists, so a notice is never anonymous.
   * Guard pair: member-scoped notice x task-scoped notice — a member's notice
   * never borrows another task's subject, which is what keeps one subject's clock
   * independent of a healthy sibling (R15-A4).
   */
  noticeSubjectsFor(missionId: string, scope: { taskId?: string; memberId?: string } = {}): string[] {
    const mission = this.store.get('missions', missionId)
    const root = mission === undefined ? `mission:${missionId}` : missionSubject(mission)
    const tasks = this.store.list('tasks', missionId)
    if (scope.taskId !== undefined) {
      const task = tasks.find(candidate => candidate.id === scope.taskId)
      if (task !== undefined) return [taskSubject(task)]
    }
    if (scope.memberId !== undefined) {
      const owned = tasks.filter(task => (task.attempt?.ownerId === scope.memberId || task.assigneeId === scope.memberId) && task.status !== 'accepted' && task.status !== 'cancelled')
      if (owned.length) return subjectsOfTasks(owned, mission ?? { id: missionId })
    }
    return [root]
  }
  /**
   * R15-A4: the dispatcher's per-(task, assignee) question, forwarded so the
   * notice path asks exactly the predicate the sweep used.
   */
  dispatchQuestion(missionId: string, tasks: Task[], members: Member[], dispatchable: Task[]): ReturnType<Scheduling['dispatchQuestion']> { return this.scheduling.dispatchQuestion(missionId, tasks, members, dispatchable) }
  noticeKey(missionId: string): string { return this.notices.noticeKey(missionId) }
  private enqueueOwnerNotice(missionId: string, content: string, from: string, noticeClass: NoticeClass, extra: Partial<Delivery> = {}, dedupe = noticeClass === 'budget', dedupKeyOverride?: string): Delivery | undefined { return this.notices.enqueueOwnerNotice(missionId, content, from, noticeClass, extra, dedupe, dedupKeyOverride) }
  noticeLedger(actor: Actor, missionId: string, query: { limit?: number } = {}): unknown { return this.notices.noticeLedger(actor, missionId, query) }
  /** R16-A: the owner-only wake-precision projection (decisions, false wakes, missed obligations). */
  wakePrecision(actor: Actor, missionId: string): WakePrecision { return this.notices.wakePrecision(actor, missionId) }
  private bounded(text: string): string { return this.notices.bounded(text) }
  private ensureWitness(missionId: string, options: { offPass?: boolean; wedged?: boolean } = {}): void { return this.notices.ensureWitness(missionId, options) }
  notifyStall(mission: Mission, reason: string): void { return this.notices.notifyStall(this.interpretation(mission.id), reason) }
  /**
   * R17-G1: the shared interpretation of one mission's durable state, forwarded
   * so the dispatcher and every generator read the same derived view.
   */
  interpretation(missionId: string): MissionInterpretation { return this.notices.interpretation(missionId) }
  /** R17-G5: the released pass owed its dispatch question; publish with the wedged branch. */
  expectWedgedRelease(missionId: string): void { this.notices.expectWedgedRelease(missionId) }
  /** R17-G5: the scheduling pass state at a committed transition (for publication). */
  passState(missionId: string): { passLive: boolean; wedged: boolean } {
    return { passLive: this.scheduling.livePass(missionId) !== undefined, wedged: this.scheduling.passWedged(missionId) }
  }
  notifyCoverageComplete(mission: Mission): void { return this.notices.notifyCoverageComplete(mission) }
  notifyParkedHolder(mission: Mission, task: Task): void { return this.notices.notifyParkedHolder(mission, task) }
  private warnIntegrationGap(mission: Mission, admitted: Task): void { return this.notices.warnIntegrationGap(mission, admitted) }
  private notifyReviewBlocked(mission: Mission, source: Task, reason: string): void { return this.notices.notifyReviewBlocked(mission, source, reason) }
  private topicDelivery(missionId: string, from: string, topic: string, content: string): void { return this.notices.topicDelivery(missionId, from, topic, content) }
  async flushOutbox(missionId: string): Promise<void> { return this.notices.flushOutbox(missionId) }
  pumpOutbox(): void { return this.notices.pumpOutbox() }

  /** M1a seam 7/7: scheduling predicates, pass bookkeeping and the dispatch sweep. */
  private readonly scheduling = new Scheduling(this)
  ready(task: Task, member: Member, tasks?: Task[]): boolean { return this.scheduling.ready(task, member, tasks) }
  unschedulable(mission: Mission, tasks: Task[], members: Member[]): Task[] { return this.scheduling.unschedulable(mission, tasks, members) }
  reviewable(task: Task, tasks: Task[]): boolean { return this.scheduling.reviewable(task, tasks) }
  stalled(mission: Mission, tasks: Task[], members: Member[]): boolean { return this.scheduling.stalled(mission, tasks, members) }
  private quiescencePending(task: Task): boolean { return this.scheduling.quiescencePending(task) }
  private selectDeliveryTarget(missionId: string, tasks: Task[]): Task { return this.scheduling.selectDeliveryTarget(missionId, tasks) }
  private deliveryTarget(actor: Actor, missionId: string): { mission: Mission; task: Task } { return this.scheduling.deliveryTarget(actor, missionId) }
  private openPass(missionId: string): SchedulingPass | undefined { return this.scheduling.openPass(missionId) }
  private closePass(missionId: string, pass: SchedulingPass): void { return this.scheduling.closePass(missionId, pass) }
  private checkSchedulingPasses(): void { return this.scheduling.checkSchedulingPasses() }
  private reviewPathStalled(tasks: Task[], members: Member[]): boolean { return this.scheduling.reviewPathStalled(tasks, members) }
  private rerouteTarget(missionId: string, task: Task, failedId: string): Member | undefined { return this.scheduling.rerouteTarget(missionId, task, failedId) }

  /** M1a seam 5/7: the declared-check execution path. */
  private readonly declaredChecks = new DeclaredChecks(this)
  /** M1a seam 2/7: derived fingerprints, usage accounting and the budget gate. */
  private readonly gates = new RuntimeGates(this)
  fingerprint(missionId: string): string { return this.gates.fingerprint(missionId) }
  fingerprintRecords(missionId: string): { mission: Mission; tasks: Task[]; members: Member[]; evidence: Evidence[]; deliveries: Delivery[] } { return this.gates.fingerprintRecords(missionId) }
  fingerprintBoard(missionId: string): MissionFingerprintBoard { return this.gates.fingerprintBoard(missionId) }
  private ownerInstruments(missionId: string, full: boolean): Record<string, unknown> { return this.gates.ownerInstruments(missionId, full) }
  private boardWindow(missionId: string, memberId: string, afterSeq: number): Record<string, unknown> { return this.gates.boardWindow(missionId, memberId, afterSeq) }
  private async usage(memberId: string, tokens: number): Promise<void> { return this.gates.usage(memberId, tokens) }
  private async usageSnapshot(memberId: string, totalTokens: number, usage?: UsageBuckets): Promise<void> { return this.gates.usageSnapshot(memberId, totalTokens, usage) }
  private recordOwnerUsage(sessionId: string, usage: UsageBuckets): void { return this.gates.recordOwnerUsage(sessionId, usage) }
  private warnBudget(mission: Mission): void { return this.gates.warnBudget(mission) }
  private blockBudget(mission: Mission): void { return this.gates.blockBudget(mission) }
  private beginBudgetStop(missionId: string, pauseId: string): void { return this.gates.beginBudgetStop(missionId, pauseId) }
  private resumeBudgetTasks(mission: Mission): void { return this.gates.resumeBudgetTasks(mission) }

  /**
   * M1a: the moved in-memory caches stay reachable on the runtime under the same
   * names. Each is a live getter onto the module that now owns the collection, so
   * the cache-only tests clear and inspect exactly the object the scheduling path
   * reads (loss of each changes no durable outcome; S5's inventory names them).
   */
  get idleSignals() { return this.attempts.idleSignals }
  get budgetStops() { return this.gates.budgetStops }
  get fingerprintCache() { return this.gates.fingerprintCache }
  get releasedPasses() { return this.scheduling.releasedPasses }
  get parkedNotices() { return this.notices.parkedNotices }
  get reviewPathNotices() { return this.notices.reviewPathNotices }
  get integrationGapWarned() { return this.notices.integrationGapWarned }
  get instanceId(): string { return this.scheduling.instanceId }

  constructor(readonly config: RuntimeConfig, readonly workers: WorkerAdapter, storeOptions: StoreOptions = {}) {
    this.store = new SwarmStore(config.statePath, storeOptions)
    workers.bind({
      activity: (memberId, activity) => this.onActivity(memberId, activity),
      idle: memberId => this.onIdle(memberId),
      beforeStep: (memberId, hasFreshInput) => this.beforeStep(memberId, hasFreshInput),
      usage: (memberId, tokens) => this.usage(memberId, tokens),
      usageSnapshot: (memberId, totalTokens, usage) => this.usageSnapshot(memberId, totalTokens, usage),
      ownerUsage: (sessionId, usage) => this.recordOwnerUsage(sessionId, usage),
      admitDelivery: (memberId, deliveryId) => {
        const delivery = this.store.get('deliveries', deliveryId)
        if (!delivery || delivery.to !== memberId) return false
        if (delivery.kind !== 'assignment') return true
        if (this.store.get('missions', delivery.missionId)?.budgetPause) return false
        const task = delivery.taskId ? this.store.get('tasks', delivery.taskId) : undefined
        return task?.status === 'running' && task.attempt?.id === delivery.attemptId && task.attempt?.ownerId === memberId
      },
      toolRun: (memberId, run) => this.recordToolRun(memberId, run),
      guard: (memberId, tool) => this.guard(memberId, tool),
      failure: (memberId, error) => this.onFailure(memberId, error),
      providerOutage: (memberId, outage) => this.onProviderOutage(memberId, outage),
    })
  }
  /**
   * Recover active missions without requiring a live coordinator or user session.
   * `grants` is the human authorization loaded once by the plugin; when given,
   * each root is recorded durably as `workspace/grant-loaded` so the audit shows
   * exactly what the host was authorized to do in this process.
   */
  async start(grants?: WorkspaceGrantSnapshot): Promise<void> {
    // R17-G8: subscribe to the host's claimed signal so real consumption is
    // recorded from it (one CAS write per delivery), never inferred.
    this.notices.attach(this.workers)
    if (grants !== undefined) {
      this.store.transaction(() => {
        for (const grant of grants.grants) this.store.event('swarm/install', 'workspace/grant-loaded', 'config', { path: grant.path, ...(grant.note === undefined ? {} : { note: grant.note }), ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }) })
        for (const unresolved of grants.unresolved) this.store.event('swarm/install', 'workspace/grant-loaded', 'config', { path: unresolved, loaded: false })
      })
    }
    // Persisted activity is presentation history, never proof that an execution survived a restart.
    for (const member of this.store.list('members')) if (member.activity !== undefined) {
      delete member.activity
      this.commit(member.missionId, () => this.store.put('members', member))
    }
    for (const draft of this.store.list('drafts')) if (draft.status === 'launching') {
      draft.status = 'failed'; draft.error = 'Host restarted during plan assembly. Retry launch to continue the saved plan.'; draft.updatedAt = Date.now()
      this.store.transaction(() => this.store.put('drafts', draft))
    }
    for (const request of this.store.list('starts')) {
      const mission = request.missionId ? this.store.get('missions', request.missionId) : undefined
      if (mission && mission.status !== 'staged') {
        request.status = mission.status === 'completed' ? 'completed' : mission.status === 'stopped' ? 'stopped' : 'running'
        request.budget = { ...mission.budget }
        delete request.error
      } else if (request.status === 'planning' || request.status === 'launching') {
        request.status = 'failed'
        request.error = 'Host restarted before automatic launch completed. Retry the saved request to continue.'
      } else continue
      request.updatedAt = Date.now()
      this.store.transaction(() => this.store.put('starts', request))
    }
    const unstarted: Mission[] = []
    for (const mission of this.store.list('missions')) {
      if (terminal(mission)) {
        // A cold host has no surviving native worker handles for terminal work.
        // R17-G7: the durable phase is what changes; the live status is derived.
        this.commit(mission.id, () => {
          for (const member of this.store.list('members', mission.id)) {
            if (memberPhaseOf(member) !== 'stopped') { member.phase = 'stopped'; this.store.put('members', member) }
          }
        })
        continue
      }
      this.commit(mission.id, () => {
        if (mission.budgetPause) { mission.budgetPause.quiesced = true; this.store.put('missions', mission) }
        for (const task of this.store.list('tasks', mission.id)) {
          if (task.status === 'blocked' && task.resumeAfterStop?.epoch === task.epoch) {
            const reason = task.resumeAfterStop.reason
            // A handoff never spends recovery credit; lease expiry and idle
            // close-out respect the task's recovery limit across restarts.
            const exhausted = (task.recoveryCount ?? 0) >= (task.maxRecoveryAttempts ?? this.config.maxTasksPerMember)
            task.status = reason === 'handoff' || !exhausted ? 'pending' : 'blocked'
            delete task.resumeAfterStop
            this.store.put('tasks', task)
            this.store.event(mission.id, 'task/quiescence-recovered', 'runtime', { taskId: task.id, reason })
          }
          if (task.status === 'running') {
            // R11-07: a host restart is a host-caused stop, never a worker
            // recovery failure. No recovery credit is spent (a
            // `maxRecoveryAttempts: 1` task survives one restart), the task is
            // always re-pended, and a durable per-task event names it instead of
            // only the generic `mission/recovered` row. The old attempt is
            // fenced and the next epoch records the handoff reason.
            const ownerId = task.attempt?.ownerId
            const pauseInduced = mission.budgetPause !== undefined || task.budgetResume !== undefined
            task.status = 'pending'
            task.epoch++
            task.handoff = `${task.handoff ?? ''}\nRecovered after host restart; inspect prior tool runs and workspace before repeating effects.`
            this.dropAttempt(task)
            delete task.budgetResume
            this.store.put('tasks', task)
            this.store.event(mission.id, 'task/restart-repended', 'runtime', {
              taskId: task.id, epoch: task.epoch, ownerId, reason: 'host-restart', pauseInduced,
              recoveryCount: task.recoveryCount ?? 0, maxRecoveryAttempts: task.maxRecoveryAttempts ?? this.config.maxTasksPerMember,
            })
          }
        }
        // R17-G7: recovery used to rewrite every non-stopped member row to
        // `idle`, which is exactly how a member could read `idle` while the
        // attempt it owns was still live (R15-F2). There is nothing to write:
        // the attempt rows above are re-pended or dropped in this same
        // transaction, and the live status is derived from them, while a parked
        // member keeps the owner's durable park intent across the restart.
        for (const member of this.store.list('members', mission.id)) {
          if (member.phase === undefined) { member.phase = 'active'; this.store.put('members', member) }
        }
        this.store.event(mission.id, 'mission/recovered', 'runtime', {})
      })
      if (mission.status === 'active') unstarted.push(mission)
      this.kick(mission.id)
    }
    // R15-A2: the tick timer is installed AFTER every recovery commit (so no
    // tick can write a stale mission row over a recovery) but BEFORE the first
    // worker startup is awaited. A `workers.start` that never settles therefore
    // cannot silence the owner: the timer keeps pumping the outbox, releasing a
    // wedged pass and generating decision notices off the pass.
    this.startTicker()
    for (const mission of unstarted) {
      if (this.shuttingDown) break
      await this.ensureWorkers(mission)
    }
  }
  /**
   * R15-A2: the queue-external tick. Everything here reads durable rows and runs
   * outside every mission queue, so a pass wedged inside `workers.start` (or any
   * other adapter await) cannot swallow it.
   *
   * Co-firing guards, named: the outbox pump (S2, delivers what the witnesses
   * write), the scheduling-pass watchdog (S1/S2, releases a pass past its bound
   * and escalates it with the work it never reached), the budget gates (deadline
   * cancellation must not queue behind a long verification) and
   * `sweepDecisions` (the off-pass half of the same decision function the pass
   * runs). `checkSchedulingPasses` runs before `sweepDecisions` on purpose: a
   * pass that just expired is released and escalated first, and the sweep then
   * sees the released row rather than racing the watchdog for the same state.
   */
  private startTicker(): void {
    this.timer = setInterval(() => {
      // S2: the outbox pump is driven from the tick timer, never from a mission
      // queue. A durable owner notice is delivered even when the mission's pass
      // is wedged in an adapter call or the lock is otherwise held, because the
      // pump reads only durable rows and never takes `exclusive`.
      this.pumpOutbox()
      this.checkSchedulingPasses()
      this.sweepDecisions()
      for (const mission of this.store.list('missions')) {
        // Deadline cancellation cannot queue behind a long verification holding the mission queue.
        if (mission.status === 'active' && Date.now() >= mission.deadline) this.blockBudget(mission)
        else if (mission.status === 'active') this.warnBudget(mission)
        if (!terminal(mission)) this.kick(mission.id)
      }
    }, this.config.tickMs)
    this.timer.unref()
  }
  /**
   * R15-F2, deleted by R17-G7: `reconcileMemberStatus` used to upgrade a stale
   * `idle` member row to `working` whenever the row fell behind the live attempt,
   * and its upgrade-only rule existed because the member row was part of the
   * board fingerprint (a spurious downgrade re-armed the coverage/stall notices).
   * The status is now derived on every read from the durable phase and the live
   * attempts (`src/projection.ts`), so there is no mirror to reconcile and no
   * write that could churn F(S): the seam is impossible by construction. The
   * guards it used to co-fire with are now the readers of the same derivation:
   * the W6 idle close-out (which owns the attempt until it fences it), the
   * parked-member hatch (`memberPhaseOf === 'parked'`, which wins over work in
   * flight) and the coverage / stall notices (whose F(S) key no status write can
   * move any more).
   */

  /**
   * R15-A2: decision generation that does not depend on a scheduling pass
   * finishing. For every active mission whose pass is not live — no pass row
   * inside its declared bound and no pass body in the mission's serialization
   * chain — the same classifier the pass uses (`ensureWitness`:
   * `stallRoots`, `waitsLegitimately`, the W3 stall predicate) is run with
   * `offPass: true`.
   *
   * The `offPass` flag suppresses only the dispatcher's "ready but not
   * dispatched" question, which is meaningless before a pass has run; every
   * other class (a stall root, a fall-through, an unreviewable submission, a W3
   * stall) is derived from durable rows and is identical off-pass.
   *
   * Co-firing guards: `openPass`/`livePass` (a live pass owns generation, so the
   * sweep stays out of its way), `kick` (which opens the next pass in the same
   * tick, after this sweep), the pass watchdog (which deletes the queue entry
   * when it releases a wedged pass — exactly the state this sweep exists for)
   * and the notice dedup (`hasNotice` / the mission witness), which keeps a
   * second generation path from duplicating a decision.
   */
  private sweepDecisions(): void {
    if (this.closed || this.shuttingDown) return
    for (const mission of this.store.list('missions')) {
      if (this.closed || this.shuttingDown) return
      if (terminal(mission) || mission.status !== 'active') continue
      try {
        // R17-G7: no member-status reconciliation runs here any more. Every
        // reader derives the status from the durable phase and the live attempts
        // (`src/projection.ts`), so the sweep describes the same board the
        // dispatch path acts on without a write in between. Co-firing guards the
        // deleted write used to name are now readers of that one derivation: the
        // W6 idle close-out, the parked-member hatch and the coverage/stall
        // notices, whose F(S) key no status write can move.
        // R16-D: the attempt reporting bound runs BEFORE the pass guard below, so
        // an attempt that has stopped reporting is named whether the pass is
        // running, wedged or absent. Co-firing guards: F1's operation silence
        // (skipped while an operation is recorded — that guard owns the clock),
        // the W6 idle close-out (skipped for the attempt it is already nudging),
        // the parked member, the budget pause, the wedged-pass release in
        // `checkSchedulingPasses` (same tick, earlier) and the notice dedup key.
        this.scheduling.sweepSilentAttempts(mission.id)
        // R15-D1/D2: the sweep runs when the pass is WEDGED past its declared
        // bound even though `livePass` still gates scheduling because the mission
        // has live work (a healthy sibling's lease, or a stop acknowledgement in
        // flight). A sibling's clock must not own another subject's decision: the
        // classifier below names only what no live path advances. When the pass is
        // merely inside its bound the sweep stays out of its way, and when no pass
        // exists at all the next kick opens one in this same tick.
        // R17-G5: the sampled tick path emits exactly two absence instruments and
        // no cause — the attempt-silence escalation above (`sweepSilentAttempts`,
        // bounded by `attemptSilenceBoundMs`) and the absence net here (the
        // absence of a durable transition and the elapsed clock, bounded by
        // `Notices.absenceBoundMs`). Cause-bearing generation is
        // transition-driven (see `commit`), so no sampled tick can invent a cause
        // from a state it only sampled.
        this.notices.absenceNet(mission.id)
      } catch (error) {
        // A sweep must never break the tick that carries the outbox pump and the
        // wedge detector; the next tick re-derives the same state.
        if (!this.closed) process.stderr.write(`[agent-swarm] decision sweep failed: ${String(error)}\n`)
      }
    }
  }
  /**
   * S5c: one serialized presentation of a mission's operations. The chain is an
   * in-process ordering cache, not the mission's gate. A predecessor that has
   * not settled inside the declared bound is treated as wedged — it is usually
   * inside an adapter call (`workers.start`, `captureArtifact`, `verifyArtifact`)
   * — and the next operation starts instead of being swallowed by a promise that
   * may never settle (the Row-13 shape, which the pass watchdog only releases
   * for a wedged *pass* with no live work). Two bodies that overlap after the
   * bound cannot lose an update: every commit is a synchronous single-writer
   * transaction and every task write is a compare-and-swap on the task's own
   * revision (`SwarmStore.putTask`), so the worst case is a refused stale write.
   */
  async exclusive<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(missionId)
    // The tail of THIS call is registered before the first await, so a later
    // caller chains onto this call instead of onto the same predecessor. The
    // read-await-write shape this replaced let two callers that both waited on
    // one predecessor each become the tail and run their bodies CONCURRENTLY
    // (the fork found in the 2026-09-11 review): dispatch and swarm_claim could
    // interleave per-member workspace preparation, and mission/member/delivery
    // rows have no compare-and-swap to lose an update safely.
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.queues.set(missionId, current)
    try {
      if (previous !== undefined) await this.boundedQueueWait(previous)
      return await fn()
    } finally {
      release()
      if (this.queues.get(missionId) === current) this.queues.delete(missionId)
    }
  }
  /** Wait for the mission-queue predecessor, but never past the declared bound. */
  private async boundedQueueWait(previous: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        previous.catch(() => {}),
        new Promise<void>(resolve => { timer = setTimeout(resolve, this.stallPassTimeoutMs); timer.unref() }),
      ])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }
  commit<T>(missionId: string, fn: () => T): T {
    if (this.closed) throw new Error('Swarm runtime is closed')
    this.commitDepth += 1
    let result: T
    try { result = this.store.transaction(fn) } finally { this.commitDepth -= 1 }
    for (const listener of this.listeners) { try { listener(missionId) } catch { /* A UI subscriber cannot roll back committed work. */ } }
    // R17-G5: and it publishes its decision facts in the same transition — the
    // classifier runs here (never from the tick sample), against the state this
    // commit produced. The pass state selects the one pass-end branch; a wedged
    // pass keeps its own subject. Reentrant commits are ignored by the guard.
    this.notices.transition(missionId)
    return result
  }
  /** Subscribe to committed state changes. */
  subscribe(listener: (missionId: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
/**
   * R17-G6: the derived member board — the read face the guard model and the
   * owner/UI views consume, and the ONLY one: the single derivation
   * (`src/projection.ts`) applied to the durable rows. It used to prefer a host
   * projection unit's published state, but that unit published the board as a
   * plugin-owned session event the host's format cannot read back (see the
   * module header of `src/projection.ts`), so the unit is gone and the
   * derivation is the read face on every composition. Unlike `missionBoard` it
   * needs no mission row, so the guard model can project a board whose mission
   * is not (or no longer) in the store.
   */
  memberBoard(missionId: string): MissionBoardMember[] {
    return deriveMemberBoard(this.store.list('members', missionId), this.store.list('tasks', missionId))
  }
  /**
   * R17-G6: the durable member rows with the board's derived status merged in —
   * the one place `snapshot()` and `observe()` take member statuses from, so the
   * owner/UI read face is an instance of the projection being read rather than a
   * second derivation. The rows themselves stay the durable records (name, role,
   * subscriptions, activity); only the derived status comes from the board.
   */
  private projectedMembers(missionId: string): Member[] {
    const board = this.memberBoard(missionId)
    const status: Record<string, MemberStatus> = {}
    for (const member of board) status[member.id] = member.status
    return this.store.list('members', missionId).map(member => ({ ...member, status: status[member.id] ?? member.status }))
  }
  mission(missionId: string): Mission {
    const mission = this.store.get('missions', missionId)
    if (!mission) throw new Error('Unknown mission')
    return mission
  }
  participant(actor: Actor, missionId: string): { mission: Mission; member?: Member; key: string; owner: boolean } {
    const mission = this.mission(missionId)
    if (mission.ownerSessionId === actor.sessionId) return { mission, key: 'owner', owner: true }
    const member = this.store.list('members', missionId).find(m => m.sessionId === actor.sessionId && memberPhaseOf(m) !== 'stopped')
    if (!member) throw new Error('Session is not a participant in this mission')
    return { mission, member, key: member.id, owner: false }
  }
  active(actor: Actor, missionId: string, allowStaged = false) {
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    actor.signal?.throwIfAborted()
    const participant = this.participant(actor, missionId)
      if (participant.mission.status !== 'active' && !(allowStaged && participant.owner && participant.mission.status === 'staged')) throw new Error(`Mission is ${participant.mission.status}`)
    if (participant.mission.budgetPause) throw new Error('Mission is waiting for budget-pause quiescence and a fresh resume assignment')
    if (participant.mission.status !== 'staged' && Date.now() >= participant.mission.deadline) throw new Error('Mission duration budget exhausted')
    return participant
  }
  task(missionId: string, taskId: string): Task {
    const task = this.store.get('tasks', taskId)
    if (!task || task.missionId !== missionId) throw new Error('Task is not in this mission')
    return task
  }
  /**
   * Follow repair lineage from a referenced dependency to the task that now
   * carries its obligations. A blocked or cancelled task replaced by a live
   * repair resolves to that repair, recursively; the original identity in a
   * dependent's `dependencies` therefore keeps working after replacement.
   */
  private lineage(missionId: string, dependencyId: string, tasks = this.store.list('tasks', missionId)): Task[] {
    const chain = [this.task(missionId, dependencyId)]
    const seen = new Set<string>()
    while ((chain.at(-1)!.status === 'cancelled' || chain.at(-1)!.status === 'blocked') && !seen.has(chain.at(-1)!.id)) {
      const current = chain.at(-1)!
      seen.add(current.id)
      const replacements = tasks.filter(task => task.replaces?.includes(current.id) && task.kind === current.kind && !seen.has(task.id))
      const accepted = replacements.filter(task => task.status === 'accepted')
      // Two accepted artifacts for one obligation is ambiguous history: fail closed so no arbitrary artifact is trusted.
      if (accepted.length > 1) return [...chain, { ...current, status: 'blocked', output: `Ambiguous accepted replacements ${accepted.map(task => task.id).join(', ')} for ${current.id}` }]
      // Resolution is deterministic: the oldest live replacement wins, with the
      // id as a total tie-break. Newest-wins made two live replacements resolve
      // differently as one advanced through the lifecycle. Admission keeps at
      // most one live replacement, so this only matters for imported history.
      const oldest = (candidates: Task[]) => [...candidates].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
      const next = accepted[0]
        ?? oldest(replacements.filter(task => ['pending', 'running', 'submitted'].includes(task.status)))
        ?? oldest(replacements.filter(task => task.status === 'blocked' || task.status === 'cancelled'))
      if (!next) break
      chain.push(next)
    }
    return chain
  }
  /** Effective prerequisites for workspace preparation; one accepted repair covering several originals is merged once. */
  effectiveDependencies(missionId: string, task: Task): Task[] {
    const seen = new Set<string>()
    return task.dependencies.map(dep => this.effectiveDependency(missionId, dep)).filter(dependency => !seen.has(dependency.id) && seen.add(dependency.id))
  }
  effectiveDependency(missionId: string, dependencyId: string, tasks?: Task[]): Task { return this.lineage(missionId, dependencyId, tasks).at(-1)! }
  dependencySatisfied(missionId: string, dependencyId: string, tasks?: Task[]): boolean { return this.effectiveDependency(missionId, dependencyId, tasks).status === 'accepted' }
  /**
   * R16-A: whether a dependency reference still has a live path. `dependencySatisfied`
   * answers the dispatcher's question ("may the dependent start?"); this answers the
   * notice classifier's ("can the obligation still advance?"). Both read the same
   * `lineage`, so an owner decision and the dispatcher cannot disagree about a
   * dependency whose original row is cancelled or blocked but whose repair is live.
   *
   * A dependency is unfinished exactly when its EFFECTIVE carrier is neither
   * accepted (done) nor cancelled without a live repair (dead). A missing row is
   * not a live path: the classifier must escalate a dangling reference, never throw.
   *
   * Co-fires with: `dependencySatisfied` (a satisfied dependency is never waiting),
   * the stall-root classifier (a blocked effective dependency is the ROOT's subject,
   * and `dependentsOf` enumerates this dependent beside it) and
   * `unfinishedDependencies` below (one repair carrying several originals is
   * counted once).
   */
  dependencyUnfinished(missionId: string, dependencyId: string, tasks?: Task[]): boolean {
    const rows = tasks ?? this.store.list('tasks', missionId)
    if (!rows.some(task => task.id === dependencyId)) return false
    const effective = this.effectiveDependency(missionId, dependencyId, rows)
    return effective.status !== 'accepted' && effective.status !== 'cancelled'
  }
  /**
   * R16-A: the EFFECTIVE unfinished prerequisites of one task, deduplicated in
   * reference order. This is the one seam the waking classifier reads, so a notice
   * and the scheduler resolve a replaced dependency through the same lineage.
   */
  unfinishedDependencies(missionId: string, task: Task, tasks?: Task[]): Task[] {
    const rows = tasks ?? this.store.list('tasks', missionId)
    const seen = new Set<string>()
    const unfinished: Task[] = []
    for (const dependency of task.dependencies) {
      if (!this.dependencyUnfinished(missionId, dependency, rows)) continue
      const effective = this.effectiveDependency(missionId, dependency, rows)
      if (seen.has(effective.id)) continue
      seen.add(effective.id)
      unfinished.push(effective)
    }
    return unfinished
  }
  /** Every identity a dependency reference stands for, including the current effective repair. */
  dependencyIdentities(missionId: string, dependencyId: string, tasks?: Task[]): Set<string> { return new Set(this.lineage(missionId, dependencyId, tasks).map(task => task.id)) }
  // M1a: lease/attempt accounting lives in src/attempts.ts; these forwarders keep
  // the call sites unchanged.
  private ownAttempt(actor: Actor, missionId: string, taskId: string, attemptId: string): { task: Task; member: Member } { return this.attempts.ownAttempt(actor, missionId, taskId, attemptId) }
  private fenceAttempt(mission: Mission, task: Task, windowMs: number): void { return this.attempts.fenceAttempt(mission, task, windowMs) }
  dropAttempt(task: Task, ownerId?: string): void { return this.attempts.dropAttempt(task, ownerId) }
  private onIdle(memberId: string): void { return this.attempts.onIdle(memberId) }
  async closeOutIdleAttempt(mission: Mission, member: Member, task: Task): Promise<void> { return this.attempts.closeOutIdleAttempt(mission, member, task) }
  /** The task plus every task it replaces transitively; a repair may only supersede its own lineage. */
  private replacementLineage(missionId: string, task: Task): Set<string> {
    const tasks = this.store.list('tasks', missionId)
    const seen = new Set<string>([task.id])
    for (let frontier = [task]; frontier.length;) {
      const next: Task[] = []
      for (const item of frontier) for (const replacedId of item.replaces ?? []) {
        if (seen.has(replacedId)) continue
        seen.add(replacedId)
        const replaced = tasks.find(candidate => candidate.id === replacedId)
        if (replaced) next.push(replaced)
      }
      frontier = next
    }
    return seen
  }
  
  
  
  
  
  
  
  /**
   * S6: critical-path accounting. The longest chain of dependent steps is read
   * from the durable task graph and reported next to the mission's total spend,
   * so a worker that does not shorten the longest branch earns nothing. A
   * malformed graph (a missing dependency row or a cycle) cannot throw: the
   * offending edge contributes no length. Pure accounting — no budget
   * enforcement reads this number.
   */
  criticalPath(missionId: string): CriticalPath {
    const tasks = this.store.list('tasks', missionId)
    const byId = new Map(tasks.map(task => [task.id, task]))
    const chains = new Map<string, string[]>()
    const visit = (id: string, open: Set<string>): string[] => {
      const cached = chains.get(id)
      if (cached !== undefined) return cached
      const task = byId.get(id)
      if (task === undefined || open.has(id)) return []
      open.add(id)
      let best: string[] = []
      for (const dependency of task.dependencies) {
        const chain = visit(dependency, open)
        if (chain.length > best.length) best = chain
      }
      open.delete(id)
      const composed = [...best, id]
      chains.set(id, composed)
      return composed
    }
    const remainingOf = (chain: string[]): number => chain.filter(id => {
      const task = byId.get(id)
      return task !== undefined && task.status !== 'accepted' && task.status !== 'cancelled'
    }).length
    let chain: string[] = []
    for (const task of tasks) {
      const candidate = visit(task.id, new Set())
      // Longest first; among equal lengths the chain with more open work is the
      // one a worker can still shorten, so it is the one reported.
      if (candidate.length > chain.length || (candidate.length === chain.length && remainingOf(candidate) > remainingOf(chain))) chain = candidate
    }
    const chainTasks = chain.map(id => byId.get(id)).filter((task): task is Task => task !== undefined)
    return {
      length: chain.length,
      remaining: remainingOf(chain),
      usedSteps: chainTasks.reduce((total, task) => total + (task.usedSteps ?? 0), 0),
      taskIds: chain,
    }
  }
  /**
   * Read-only owner instruments (docs/no-silent-state-spec.md §6): the current
   * fingerprint, the last witness class and time, the pending-dispatchable
   * count, the notice-delivery ledger and durable escalations. `full` adds the
   * per-member arena rows and the ledger page; the compact form keeps the
   * owner's routine observe response small. A pure projection of durable
   * records; it writes nothing.
   */
  
  
  
  
  
  
  /** Create a mission with explicitly bounded resources and scope. */
  create(actor: Actor, input: CreateMissionInput, initial: { id?: string; status?: 'active' | 'staged' } = {}): Mission {
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    if (this.store.list('members').some(m => m.sessionId === actor.sessionId)) throw new Error('Workers cannot create independent missions or budgets')
    requireText(input.title, 'title'); requireText(input.objective, 'objective')
    if (!isAbsolute(input.workspace)) throw new Error('workspace must be an absolute path')
    requireStrings(input.scope, 'scope'); requireStrings(input.acceptance, 'acceptance')
    const authorized = this.assertAuthorizedRoot(input.workspace, input.workspaceGrantRoot, input.workspaceAuthorizationSource)
    input = { ...input, scope: normalizeScopeSelectors(input.scope) }
    assertScopeSelectors(input.scope, 'scope')
    const budget = validatedBudget(input.budget)
    const now = Date.now()
    if (!Number.isSafeInteger(now + budget.maxDurationMs)) throw new Error('Mission duration exceeds the supported clock range')
    const mission: Mission = { ...input, workspaceGrantRoot: authorized.grantRoot, workspaceAuthorizationSource: authorized.source, budget, id: initial.id ?? id('mission'), ownerSessionId: actor.sessionId, status: initial.status ?? 'active', usedTokens: 0, usedSteps: 0, createdAt: now, updatedAt: now, deadline: now + budget.maxDurationMs }
    if (this.store.get('missions', mission.id)) throw new Error('Mission already exists')
    this.commit(mission.id, () => {
      this.store.put('missions', mission)
      this.store.event(mission.id, 'mission/created', 'owner', mission)
      // The durable audit of where the authorization came from: the matched
      // root and the resolved workspace path, recorded with the mission.
      this.store.event(mission.id, 'mission/workspace-bound', 'owner', { workspace: mission.workspace, grantRoot: mission.workspaceGrantRoot, source: mission.workspaceAuthorizationSource })
    })
    return mission
  }
  /**
   * Owner-only membership admission keeps authority and aggregate capacity bounded.
   *
   * R17-G12: `name` is optional. When the caller supplies none the runtime
   * assigns the next unused name from the fixed `WORKER_NAME_POOL` in assignment
   * order, considering every member row of the mission — a stopped member's name
   * is never reused while the mission is active. `role` keeps the responsibility
   * text unchanged and the member id stays the only address, so nothing in the
   * protocol depends on a display name.
   */
  async addMember(actor: Actor, missionId: string, input: { name?: string; role: string; model?: string; provider?: string; reasoningEffort?: string; maxOutputTokens?: number; subscriptions?: string[] }, admittedId?: string): Promise<Member> {
    return this.exclusive(missionId, async () => {
      const { mission, owner } = this.active(actor, missionId, admittedId !== undefined)
      if (!owner) throw new Error('Only the mission owner can add workers; send a bounded collaborator request')
      if (input.name !== undefined) requireText(input.name, 'name'); requireText(input.role, 'role')
      for (const field of ['provider', 'model', 'reasoningEffort'] as const) if (input[field] !== undefined) requireText(input[field]!, field)
      if (input.provider && !input.model) throw new Error('A selected provider requires a selected model')
      if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)) throw new Error('maxOutputTokens must be a positive safe integer')
      // M9 residual: topic matching is exact array membership. A bare string
      // would silently become String.includes substring semantics, so the
      // runtime validates its own boundary instead of trusting the caller.
      if (input.subscriptions !== undefined && (!Array.isArray(input.subscriptions) || input.subscriptions.some(topic => typeof topic !== 'string' || !topic.trim()))) throw new Error('subscriptions must be a string array')
      if (this.store.list('starts', missionId).length && input.maxOutputTokens === undefined) throw new Error('Automatic workers require maxOutputTokens chosen by the primary agent')
      const prior = admittedId ? this.store.get('members', admittedId) : undefined
      if (prior) {
        if (prior.missionId !== missionId || (input.name !== undefined && prior.name !== input.name) || memberPhaseOf(prior) === 'stopped') throw new Error('Member admission identity conflict')
        await this.workers.start({ mission, member: prior, ownerSessionId: mission.ownerSessionId })
        return prior
      }
      const members = this.store.list('members', missionId)
      if (members.filter(m => memberPhaseOf(m) !== 'stopped').length >= mission.budget.maxWorkers) throw new Error('Mission worker budget exhausted')
      // R17-G12: a name-less admission takes the next unused pool name in
      // assignment order; the pool is the bound, and its exhaustion is a named
      // refusal that names the caller's own exit rather than an anonymous failure.
      const name = input.name ?? nextWorkerName(members.map(member => member.name))
      if (name === undefined) throw new Error('[worker_name_pool_exhausted] The fixed worker-name pool has no unused name left Supply an explicit `name` with `swarm_add_member` and retry, or admit this worker into a new mission.')
      if (members.some(m => m.name === name)) throw new Error('Worker name already exists')
      const memberId = admittedId ?? id('member')
      // Re-validate before the first filesystem effect of this mission.
      await this.assertWorkspaceAuthorized(mission)
      if (!mission.baseline && this.workers.prepareBaseline) {
        const baseline = await this.workers.prepareBaseline(mission, actor.signal)
        const current = this.active(actor, missionId, admittedId !== undefined).mission
        current.baseline = baseline; mission.baseline = baseline
        this.commit(missionId, () => { this.store.put('missions', current); this.store.event(missionId, 'workspace/snapshot', 'runtime', baseline) })
      }
      const workspace = await this.workers.prepareWorkspace(mission, memberId)
      this.active(actor, missionId, admittedId !== undefined)
      // R17-G7: the durable row carries the phase; the in-memory record carries the
      // derivation's own output (a fresh active member owns no attempt), and the
      // store strips that status on write, so admission leaves no live fact behind.
      const member: Member = { id: memberId, missionId, name, role: input.role, model: input.model, provider: input.provider, reasoningEffort: input.reasoningEffort, maxOutputTokens: input.maxOutputTokens, sessionId: id('swarm-session'), workspace, phase: 'active', status: deriveMemberStatus('active', false), subscriptions: input.subscriptions === undefined ? [] : [...new Set(input.subscriptions)] }
      // The durable record and the historical event carry the phase only: the
      // derived status is never persisted, not even as an event snapshot.
      const { status: _derivedStatus, ...memberRecord } = member
      this.commit(missionId, () => { this.store.put('members', member); this.store.event(missionId, 'member/added', 'owner', memberRecord) })
      try { await this.workers.start({ mission, member, ownerSessionId: mission.ownerSessionId }) }
      catch (error) {
        if (this.shuttingDown || this.mission(missionId).status !== 'active') throw error
        // W8: a provider that rejects the requested reasoning effort must not
        // leave a stopped member behind with an untyped provider error. Retry
        // once on the provider default and record the downgrade; if the route is
        // still rejected, refuse admission with the requested value and the exit.
        const rejection = unsupportedEffort(error)
        if (rejection !== undefined && member.reasoningEffort !== undefined) {
          const requested = member.reasoningEffort
          const fallback: Member = { ...member }
          delete fallback.reasoningEffort
          try {
            await this.workers.start({ mission, member: fallback, ownerSessionId: mission.ownerSessionId })
            delete member.reasoningEffort
            this.commit(missionId, () => {
              this.store.put('members', member)
              this.store.event(missionId, 'member/effort-downgraded', 'runtime', { memberId, requested, rejected: rejection.requested ?? requested, reason: rejection.message })
            })
            this.kick(missionId)
            return member
          } catch (retryError) {
            if (this.shuttingDown || this.mission(missionId).status !== 'active') throw retryError
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError)
            member.phase = 'stopped'
            this.commit(missionId, () => {
              this.store.put('members', member)
              this.store.event(missionId, 'member/failed', 'runtime', { memberId, error: rejection.message })
              this.store.event(missionId, 'member/effort-rejected', 'runtime', { memberId, requested, rejected: rejection.requested ?? requested, error: rejection.message, retryError: retryMessage })
            })
            throw new Error(`Member ${name} cannot start: ${rejection.message}. Clearing reasoningEffort did not help; admit a replacement member without reasoningEffort, or with an effort this provider/model supports.`)
          }
        }
        member.phase = 'stopped'
        this.commit(missionId, () => { this.store.put('members', member); this.store.event(missionId, 'member/failed', 'runtime', { memberId, error: String(error) }) })
        throw error
      }
      this.kick(missionId)
      return member
    })
  }
  /** Any participant may establish an in-scope workstream. */
  workstream(actor: Actor, missionId: string, input: { title: string; objective: string; coordinatorId?: string }, admittedId?: string): Workstream {
    const { key } = this.active(actor, missionId, admittedId !== undefined)
    const prior = admittedId ? this.store.get('workstreams', admittedId) : undefined
    if (prior) { if (prior.missionId !== missionId) throw new Error('Workstream identity conflict'); return prior }
    requireText(input.title, 'title'); requireText(input.objective, 'objective')
    if (input.coordinatorId && !this.store.list('members', missionId).some(m => m.id === input.coordinatorId && memberPhaseOf(m) !== 'stopped')) throw new Error('Unknown coordinator')
    const stream: Workstream = { ...input, id: admittedId ?? id('stream'), missionId }
    if (this.store.list('workstreams', missionId).length >= this.mission(missionId).budget.maxTasks) throw new Error('Workstream admission budget exhausted')
    this.commit(missionId, () => { this.store.put('workstreams', stream); this.store.event(missionId, 'workstream/created', key, stream) })
    return stream
  }
  /** Distributed task proposals are admitted by deterministic scope, budget and dependency rules. */
  propose(actor: Actor, missionId: string, input: ProposeTaskInput, admittedId?: string): Task {
    const { mission, key, owner } = this.active(actor, missionId, admittedId !== undefined)
    const prior = admittedId ? this.store.get('tasks', admittedId) : undefined
    if (prior) {
      if (prior.missionId !== missionId) throw new Error('Task identity conflict')
      // F7: launchDraft retries with deterministic ids. A withdrawn record must
      // never be silently re-admitted, or a mission can activate with dead work.
      if (prior.status === 'cancelled') throw new Error(`Task ${prior.id} was cancelled by the owner; a cancelled record cannot be re-admitted. Propose a new task, or a repair with a new id.`)
      // Round 9-C: a re-submission that changes a check the task already
      // declared is recorded durably. The stored record keeps its original
      // check, so a retry can never silently swap it for a weaker or
      // host-specific one. Filling in a check the task never declared is not a
      // change and emits nothing.
      if (Array.isArray(input.checks) && prior.checks.length > 0 && !sameChecks(input.checks, prior.checks)) {
        this.commit(missionId, () => this.store.event(missionId, 'task/check-changed', key, {
          taskId: prior.id, sourceTaskId: prior.id, reason: 'resubmission', previousChecks: [...prior.checks], checks: [...input.checks as string[]],
        }))
      }
      return prior
    }
    if (this.store.list('starts', missionId).length) {
      if (!owner) {
        // Workers may extend the board but cannot enlarge execution policy set
        // by the primary agent. Follow the source/repair/prerequisite lineage.
        const reference = input.reviewOf ?? input.replaces?.[0] ?? input.dependencies?.[0]
        const origin = reference ? this.task(missionId, reference) : this.store.list('tasks', missionId)[0]
        const source = origin?.reviewOf ? this.task(missionId, origin.reviewOf) : origin
        input = { ...input, maxRecoveryAttempts: origin?.maxRecoveryAttempts,
          checkTimeoutMs: origin?.checkTimeoutMs ?? source?.checkTimeoutMs,
          maxSteps: input.maxSteps ?? origin?.maxSteps, maxFindings: input.maxFindings ?? origin?.maxFindings }
      }
      if (input.maxRecoveryAttempts === undefined) throw new Error('Automatic tasks require a recovery limit chosen by the primary agent')
      if (input.kind !== 'verification' && input.checks?.length && input.checkTimeoutMs === undefined) throw new Error('Automatic task checks require a timeout chosen by the primary agent')
    }
    requireText(input.title, 'title'); requireText(input.objective, 'objective'); requireStrings(input.acceptance, 'acceptance')
    if (!['research', 'implementation', 'verification', 'integration'].includes(input.kind)) throw new Error('Unknown task kind')
    requireStrings(input.scope, 'task.scope')
    input = { ...input, scope: normalizeScopeSelectors(input.scope) }
    assertScopeSelectors(input.scope, 'task.scope', mission.scope)
    // D1: reconcile the objective's write directives with the task scope and the
    // named deliverables with the effective ignore rules at the production
    // admission point, so a plan error is rejected here instead of at submit.
    const reconciliation = reconcileTaskAdmission({ objective: input.objective, scope: input.scope, acceptance: input.acceptance }, mission.workspace, 'task', {
      // R12-F9: the guard needs the content-carrying edges (the declared
      // dependencies plus a review source, which `prepareTask` merges into the
      // worktree like a dependency) and the durable identities this mission
      // already holds, so the diagnostic can say whether the named content exists
      // here (add the dependency that carries it) or must be obtained (state how).
      dependencies: [...(input.dependencies ?? []), ...(input.reviewOf === undefined ? [] : [input.reviewOf])],
      replaces: input.replaces,
      knownContents: new Set(this.store.list('tasks', missionId).map(task => task.id)),
    })
    if (reconciliation.length) throw new Error(reconciliation.map(formatDiagnostic).join('\n'))
    const stream = this.store.get('workstreams', input.workstreamId)
    if (!stream || stream.missionId !== missionId) throw new Error('Unknown workstream')
    const tasks = this.store.list('tasks', missionId)
    if (tasks.length >= mission.budget.maxTasks) {
      // The owner is the only actor who can raise the ceiling; a worker refusal
      // is a decision the owner must see, not just an error in a tool result.
      if (!owner) this.refuseProposal(mission, key, input.title, `mission task budget exhausted (${tasks.length}/${mission.budget.maxTasks} tasks admitted)`, mission.budget.maxTasks)
      // S4b: the ceiling that refuses the owner is a terminal too. The owner's
      // tool result carries the prose; the durable coded decision request makes
      // the refusal a recorded decision with the executable exits (raise the
      // ceiling with swarm_budget, or withdraw work with swarm_cancel).
      emitGuardTerminal(this, missionId, 'task_ceiling', { detail: `mission task budget exhausted (${tasks.length}/${mission.budget.maxTasks} tasks admitted)` })
      throw new Error('Mission task budget exhausted')
    }
    if (input.experiment && tasks.filter(t => t.experiment).length >= mission.budget.maxExperiments) {
      const used = tasks.filter(t => t.experiment).length
      if (!owner) this.refuseProposal(mission, key, input.title, `mission experiment budget exhausted (${used}/${mission.budget.maxExperiments} experiments admitted)`, mission.budget.maxExperiments)
      emitGuardTerminal(this, missionId, 'task_ceiling', { detail: `mission experiment budget exhausted (${used}/${mission.budget.maxExperiments} experiments admitted)` })
      throw new Error('Mission experiment budget exhausted')
    }
    // R11-17: a worker's board share is bounded inside the mission task ceiling.
    // The allowance is derived from `maxTasks`/`maxWorkers`, both owner-set, so
    // no tool argument and no member action can raise it; the owner raises it by
    // raising the ceiling with swarm_budget.
    if (!owner) {
      const allowance = computeProposalAllowance(mission, this.store.list('members', missionId), tasks, key)
      if (allowance.admitted >= allowance.limit) this.refuseProposal(mission, key, input.title,
        `reached its per-member proposal allowance (${allowance.admitted}/${allowance.limit} non-cancelled tasks proposed; mission ceiling ${allowance.ceiling} tasks over ${allowance.plannedMembers} planned workers)`,
        allowance.limit)
    }
    if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100)) throw new Error('priority must be an integer from 0 to 100')
    const dependencies = [...new Set(normalizeReviewDependencies(input.kind, input.reviewOf, input.dependencies))]
    for (const dependency of dependencies) {
      const effective = this.effectiveDependency(missionId, dependency, tasks)
      if (effective.status === 'cancelled' || effective.status === 'blocked') throw new Error(`Dependency ${dependency} is ${effective.status} and has no live replacement; depend on an accepted or in-progress task, or propose a repair with replaces`)
    }
    if (input.assigneeId && !this.store.list('members', missionId).some(m => m.id === input.assigneeId && memberPhaseOf(m) !== 'stopped')) throw new Error('Unknown assignee')
    if (input.kind === 'verification') {
      if (!input.reviewOf) throw new Error('Verification requires reviewOf')
      const source = this.task(missionId, input.reviewOf)
      if (source.kind === 'verification') throw new Error('Verification cannot review another verification task')
      if (source.status === 'cancelled' || source.status === 'accepted') throw new Error(`reviewOf ${source.id}: that task is already ${source.status}; a review can only start on submitted work`)
      const authors = this.authorIds(source)
      if (input.assigneeId !== undefined && authors.has(input.assigneeId)) throw new Error(`assigneeId ${input.assigneeId} authored ${source.id}; an independent review must be assigned to a member who never owned it, or left unassigned`)
    } else if (input.reviewOf) throw new Error('Only verification tasks may set reviewOf')
    // Round 9-C: a repair may keep the original acceptance while changing the
    // declared check. Acceptance is already required verbatim above; a check
    // change is recorded durably so an owner can see that the new check no
    // longer matches the original obligation. A repair that merely supplies
    // checks the replaced task never declared is not a change.
    const checkChanges: Array<{ replaces: string[]; sourceTaskId: string; previousChecks: string[]; checks: string[] }> = []
    for (const previousId of input.replaces ?? []) {
      const previous = this.task(missionId, previousId)
      if (previous.kind === 'verification') throw new Error(`replaces ${previousId}: that is a verification task. Repair its reviewed source ${previous.reviewOf ?? ''} instead; when that repair is submitted the runtime detects the missing review and admits an independent verification task automatically once the mission has task budget and a live member who did not author the repair`)
      // Resolve existing live replacements before the status check. The guard
      // must be reachable for exactly the blocked case it was written for: two
      // admitted replacements would make lineage ambiguous and stall every
      // dependent once both are accepted.
      const replacement = tasks.find(task => task.replaces?.includes(previousId) && task.status !== 'cancelled')
      // W12: cancellation is terminal for the withdrawn record, not for the
      // obligation it carried. A cancelled task admits exactly one live repair,
      // exactly like blocked work, so a dependent's lineage can resolve again.
      if (previous.status !== 'blocked' && previous.status !== 'cancelled') {
        const repairable = previous.status === 'pending' || previous.status === 'running' || previous.status === 'submitted'
        const rule = repairable ? 'only blocked or cancelled work can be replaced' : 'only blocked work can be replaced'
        throw new Error(`replaces ${previousId}: that task is ${previous.status}, and ${rule}${replacement ? `; it is already replaced by ${replacement.id} (${replacement.status})` : repairable ? '; wait for its verdict or use swarm_handoff/challenge' : ''}`)
      }
      if (replacement !== undefined) throw new Error(`replaces ${previousId}: that task is ${previous.status}, and is already replaced by ${replacement.id} (${replacement.status}); wait for its verdict, withdraw it with swarm_cancel, or repair that replacement instead of admitting a second one`)
      if (previous.resumeAfterStop?.epoch === previous.epoch) throw new Error(`replaces ${previousId}: that task is being reassigned after a handoff or lease expiry, not blocked for repair; observe again shortly`)
      if (previous.kind !== input.kind) throw new Error(`replaces ${previousId}: kind mismatch. The blocked task is ${previous.kind}; a replacement must also be ${previous.kind}`)
      const missing = previous.acceptance.filter(item => !input.acceptance.includes(item))
      if (missing.length) throw new Error(`replaces ${previousId}: replacement acceptance must include the original obligations verbatim. Missing: ${JSON.stringify(missing)}`)
      if (dependencies.includes(previousId)) throw new Error(`replaces ${previousId}: a repair cannot also depend on the blocked task it replaces`)
      const nextChecks = Array.isArray(input.checks) ? input.checks as string[] : []
      if (previous.checks.length > 0 && !sameChecks(nextChecks, previous.checks)) {
        checkChanges.push({ replaces: [previousId], sourceTaskId: previousId, previousChecks: [...previous.checks], checks: [...nextChecks] })
      }
    }
    // R11-06: classify an `npm run <name>` check by the script body the
    // workspace manifest resolves it to, so a host-only suite cannot hide
    // behind a neutral name. Plan validation (src/plans.ts) keeps the name
    // patterns because it has no workspace manifest.
    requireHostChecks(input.kind, input.checks, 'task', input.title, loadPackageScripts(mission.workspace))
    if (input.maxRecoveryAttempts !== undefined && (!Number.isSafeInteger(input.maxRecoveryAttempts) || input.maxRecoveryAttempts < 1)) throw new Error('maxRecoveryAttempts must be a positive safe integer')
    if (input.checkTimeoutMs !== undefined && (!Number.isSafeInteger(input.checkTimeoutMs) || input.checkTimeoutMs < 1 || input.checkTimeoutMs > 2147483647)) throw new Error('checkTimeoutMs must be a positive integer within the platform timer range')
    // D1: every admitted task carries its own step/finding ceiling; the runtime
    // blocks the task at that limit instead of letting it drain the mission budget.
    const ceilings = normalizeTaskCeilings(input, mission.budget.maxSteps, 'task')
    const task: Task = { id: admittedId ?? id('task'), missionId, workstreamId: input.workstreamId, title: input.title, objective: input.objective, kind: input.kind, dependencies, scope: input.scope, acceptance: input.acceptance, checks: input.checks ?? [], priority: input.priority ?? 50, experiment: input.experiment ?? false, assigneeId: input.assigneeId, reviewOf: input.reviewOf, status: 'pending', epoch: 0, proposedBy: key, evidenceIds: [], createdAt: Date.now(), maxSteps: ceilings.maxSteps, maxFindings: ceilings.maxFindings }
    if (input.replaces?.length) task.replaces = [...new Set(input.replaces)]
    if (input.assigneeId !== undefined) task.plannedAssigneeId = input.assigneeId
    if (input.maxRecoveryAttempts !== undefined) task.maxRecoveryAttempts = input.maxRecoveryAttempts
    if (input.checkTimeoutMs !== undefined) task.checkTimeoutMs = input.checkTimeoutMs
    this.commit(missionId, () => {
      this.store.put('tasks', task)
      this.store.event(missionId, 'task/proposed', key, task)
      for (const change of checkChanges) this.store.event(missionId, 'task/check-changed', key, { taskId: task.id, reason: 'replacement', ...change })
    })
    this.warnIntegrationGap(mission, task)
    this.kick(missionId)
    return task
  }
  
  /**
   * X1 (P0): every member who ever owned this task or is planned to own it. None
   * of them may be admitted to, claim, or accept its review — independence is a
   * property of the whole ownership history, not only the last attempt.
   */
  authorIds(task: Task): Set<string> {
    const ids = new Set(task.priorOwnerIds ?? [])
    if (task.attempt?.ownerId !== undefined) ids.add(task.attempt.ownerId)
    if (task.assigneeId !== undefined) ids.add(task.assigneeId)
    return ids
  }

  /** ENV: the adapter's measured envelope, widened to the environment facts it also reports. */
  private declaredCheckEnvelope(): DeclaredCheckEnvelope | undefined {
    try { return this.workers.checkEnvelope?.() as DeclaredCheckEnvelope | undefined }
    catch { return undefined } // reporting the environment must never break a delivery or a verdict
  }
  /**
   * ENV: the environment facts one attempt's self-run was recorded under. The
   * attempt's own host-recorded tool runs are the evidence; when it ran nothing,
   * the ambient facts a self-run would inherit here are the fallback. ENV-R: the
   * facts on a row are the environment the recorded command gives itself (its
   * assignments, `env -i`, `unset`), so a reviewer that really ran with
   * `HOME=<temp>` is compared with that HOME and not with the ambient one.
   */
  private selfRunEnvironmentEvidence(missionId: string, memberId: string, taskId: string, attemptId: string): { environment: CheckEnvironment; source: 'tool-run' | 'host-ambient'; at: number } | undefined {
    const runs = this.store.list('tool_runs', missionId).filter(run => run.memberId === memberId && run.taskId === taskId && run.attemptId === attemptId)
    for (const run of [...runs].reverse()) {
      const facts = (run as ToolRunWithEnvironment).checkEnvironment
      if (facts !== undefined) return { environment: facts, source: 'tool-run', at: run.createdAt }
    }
    const ambient = this.declaredCheckEnvelope()?.selfRunEnvironment
    return ambient === undefined ? undefined : { environment: ambient, source: 'host-ambient', at: Date.now() }
  }
  /** ENV: the declared envelope delivered with one attempt's assignment, from the durable delivery. */
  private deliveredCheckEnvironment(missionId: string, taskId: string, attemptId: string): CheckEnvironment | undefined {
    for (const delivery of this.store.list('deliveries', missionId)) {
      if (delivery.kind !== 'assignment' || delivery.taskId !== taskId || delivery.attemptId !== attemptId) continue
      try {
        const content = JSON.parse(delivery.content) as { checkEnvironment?: { environment?: unknown } }
        const environment = content.checkEnvironment?.environment
        if (isDeclaredCheckEnvironment(environment)) return environment
      } catch { /* a delivery without the envelope simply has none */ }
    }
    return undefined
  }
  /**
   * ENV: compare the envelope delivered to one verification attempt with the
   * environment that attempt's self-run reports. An attempt with no delivered
   * envelope and no self-run evidence has nothing to compare, and the verdict
   * proceeds as before.
   */
  private checkEnvironmentReproduction(missionId: string, memberId: string, taskId: string, attemptId: string):
    { envelope: CheckEnvironment; selfRun: CheckEnvironment; source: 'tool-run' | 'host-ambient'; at: number; comparison: CheckEnvironmentComparison } | undefined {
    const envelope = this.deliveredCheckEnvironment(missionId, taskId, attemptId) ?? this.declaredCheckEnvelope()?.environment
    if (envelope === undefined) return undefined
    const evidence = this.selfRunEnvironmentEvidence(missionId, memberId, taskId, attemptId)
    if (evidence === undefined) return undefined
    return { envelope, selfRun: evidence.environment, source: evidence.source, at: evidence.at, comparison: compareCheckEnvironments(envelope, evidence.environment) }
  }
  /**
   * ENV: the check environment facts an assignment delivery carries. Public so
   * every module that writes an assignment delivery (the claim path here and the
   * budget-resume path in src/gates.ts) delivers the same envelope: one
   * assignee that is not told the environment is the defect this closes.
   */
  assignmentCheckEnvironment(): { checkEnvironment?: { note: string; environment: CheckEnvironment; selfRun?: CheckEnvironment } } {
    const envelope = this.declaredCheckEnvelope()
    if (envelope?.environment === undefined) return {}
    return { checkEnvironment: {
      note: 'These are the facts the host runs this task\'s declared checks under. A self-run must reproduce them: the runtime reports the mismatch instead of accepting an artifact when it cannot. The scoped cache roots are provided inside the disposable verification checkout; the user cache roots and HOME are what a self-run inherits. A command that sets HOME or a cache root for itself (`HOME=… cmd`, `export …`, `env -i`, `unset …`) is recorded as the environment that self-run really used, and the comparison names the divergent field with both values.',
      environment: envelope.environment,
      ...(envelope.selfRunEnvironment === undefined ? {} : { selfRun: envelope.selfRunEnvironment }),
    } }
  }
  /** ENV: render a blocking mismatch as the refusal the member must act on. */
  private checkEnvironmentMismatchMessage(comparison: CheckEnvironmentComparison, source: string): string {
    const fields = comparison.blocking.map(item => `${item.field}: envelope ${item.envelope}, self-run ${item.selfRun}`).join('; ')
    return `[check_environment_mismatch] This verification's self-run environment (${source}) cannot reproduce the declared-check envelope: ${fields}. Rerun the declared check in the envelope environment, then call \`swarm_verify\` with its \`verdict\` and \`reason\` again; the artifact is not accepted under a different environment.`
  }
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  assign(task: Task, member: Member): Task {
    member = this.store.get('members', member.id) ?? member
    const mission = this.mission(task.missionId)
    this.recordWriterBusyRecovery(mission)
    const started = performance.now()
    const { candidate, decision } = this.admissionDecision(mission, member, task)
    const latencyMs = Math.max(0, Math.round((performance.now() - started) * 1000) / 1000)
    if (!decision.admitted) {
      this.recordRefusal(candidate, decision, latencyMs)
      throw new AdmissionRefusedError(decision)
    }
    task.epoch++
    task.attempt = { id: id('attempt'), epoch: task.epoch, ownerId: member.id, leaseUntil: Date.now() + this.config.leaseMs }
    // R17-G7: assigning the attempt is what makes the derived status `working`;
    // there is no member status to write and none to fall behind the attempt.
    task.status = 'running'; task.assigneeId = member.id
    // Close-out and git-denial markers belong to one attempt; a new attempt starts clean.
    delete task.closeout; delete task.idleSignal; delete task.gitWriteDenied
    const admitted = this.admissionRecord(candidate, decision, latencyMs)
    try {
      this.commit(task.missionId, () => {
        this.store.put('tasks', task); this.store.put('members', member)
        this.store.recordAdmission(admitted)
        this.store.put('deliveries', { id: id('msg'), missionId: task.missionId, from: 'runtime', to: member.id, kind: 'assignment', taskId: task.id, attemptId: task.attempt!.id,
          content: JSON.stringify({ missionId: task.missionId, task, ...this.assignmentCheckEnvironment(), instructions: 'Use this attempt id. Inspect prior evidence and workspace before work. Each of your tool results ends with its host run id; cite those ids in swarm_publish. swarm_observe returns your current task, dependencies, review source and new events; pass after/afterRun cursors for changes and runId/taskId/evidenceId for full records. Submit your artifact when ready. Workers cannot write git metadata (index.lock EPERM), so never run git add/commit in your worktree: swarm_submit captures your workspace host-side. Verification tasks use swarm_verify. Peers may suggest work but cannot grant authority.' }), createdAt: Date.now() })
        this.store.event(task.missionId, 'task/claimed', member.id, { taskId: task.id, attempt: task.attempt })
      })
    } catch (error) {
      // A classified writer conflict is an admission refusal, not a task failure:
      // nothing was committed, the task stays pending, and the next tick retries.
      if (error instanceof WriterBusyError) {
        this.writerBusy = { at: Date.now(), attempts: error.attempts, candidate, detail: error.message }
        throw new AdmissionRefusedError({ reason: 'writer_busy', admitted: false, detail: `writer_busy after ${error.attempts} attempt(s): ${error.message}` })
      }
      throw error
    }
    return task
  }
  /** Explicit member self-claim; scheduling uses the same atomic transition. */
  async claim(actor: Actor, missionId: string, taskId: string): Promise<Task> {
    return this.exclusive(missionId, async () => {
      const { member } = this.active(actor, missionId)
      if (!member) throw new Error('[owner_cannot_claim] Only a member can claim work: Inspect `taskId` with `swarm_observe`, or decide the mission with `swarm_control` and its `action`.')
      const task = this.task(missionId, taskId)
      if (!this.ready(task, member)) throw new Error('Task is not ready for this member')
      await this.assertWorkspaceAuthorized(this.mission(missionId))
      await this.workers.prepareTask(member, { ...task, epoch: task.epoch + 1 }, this.effectiveDependencies(missionId, task), task.reviewOf ? this.task(missionId, task.reviewOf) : undefined)
      this.active(actor, missionId)
      const fresh = this.task(missionId, taskId)
      if (fresh.epoch !== task.epoch || !this.ready(fresh, member)) throw new Error('Task changed while preparing its workspace')
      const result = this.assign(fresh, member)
      this.kick(missionId)
      return result
    })
  }
  private validateRuns(missionId: string, memberId: string, task: Task, runIds: string[]): ToolRun[] {
    requireStrings(runIds, 'toolRunIds')
    return runIds.map(runId => {
      const run = this.store.get('tool_runs', runId)
      if (!run || run.missionId !== missionId || run.memberId !== memberId || run.taskId !== task.id || run.attemptId !== task.attempt?.id) throw new Error('[evidence_tool_runs_required] Evidence must cite your host-recorded tool runs from this exact attempt Correct `toolRunIds` with `swarm_publish`, then retry.')
      return run
    })
  }
  /** Publish evidence without promoting it to verified knowledge. */
  publish(actor: Actor, missionId: string, input: PublishInput): Evidence {
    const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
    // D1: a task that exhausted its own finding (or step) ceiling blocks instead
    // of publishing more evidence and consuming the mission budget.
    const ceiling = taskCeilingBlock(task)
    if (ceiling !== undefined) { this.blockTaskCeiling(this.mission(missionId), task, ceiling); throw new Error(ceiling.reason) }
    this.bounded(input.claim)
    if (!['supported', 'disproved', 'inconclusive'].includes(input.outcome)) throw new Error('[invalid_evidence_outcome] Invalid evidence outcome Correct `outcome` with `swarm_publish`, then retry.')
    this.validateRuns(missionId, member.id, task, input.toolRunIds)
    const lineage = this.replacementLineage(missionId, task)
    for (const previous of input.supersedes ?? []) {
      const evidence = this.store.get('evidence', previous)
      if (!evidence || evidence.missionId !== missionId) throw new Error('[supersede_foreign_evidence] Superseded evidence must belong to this mission. Correct `supersedes` with `swarm_publish`, then retry.')
      if (!lineage.has(evidence.taskId)) throw new Error('[supersede_unrelated_evidence] Superseded evidence must belong to this task or its replacement lineage. Correct `supersedes` with `swarm_publish`, then retry.')
    }
    const evidence: Evidence = { id: id('evidence'), missionId, workstreamId: task.workstreamId, taskId: task.id, authorId: member.id, claim: input.claim, outcome: input.outcome, status: 'unverified', toolRunIds: input.toolRunIds, challenges: [], supersedes: input.supersedes ?? [], createdAt: Date.now() }
    task.evidenceIds.push(evidence.id)
    this.commit(missionId, () => {
      this.store.put('evidence', evidence); this.store.put('tasks', task); this.store.event(missionId, 'evidence/published', member.id, evidence)
      this.topicDelivery(missionId, member.id, task.workstreamId, `New unverified finding ${evidence.id}: ${evidence.claim}`)
    })
    this.kick(missionId)
    return evidence
  }
  /** Freeze code artifacts and submit work to an independent verifier. */
  async submit(actor: Actor, missionId: string, input: { taskId: string; attemptId: string; output: string }): Promise<Task> {
    return this.exclusive(missionId, async () => {
      const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
      if (task.kind === 'verification') throw new Error('[verification_requires_verify] Verification tasks must use swarm_verify Call `swarm_verify` with `taskId` and `verdict`, then retry.')
      this.bounded(input.output)
      if (task.kind === 'research' && task.evidenceIds.length === 0) throw new Error('[research_evidence_required] Research submission requires host-backed evidence. Supply host-backed evidence with `swarm_publish` and its `toolRunIds`, then retry with `swarm_submit` and its `taskId`.')
      this.fenceAttempt(this.mission(missionId), task, this.config.leaseMs)
      const artifact = await this.workers.captureArtifact(member, task)
      try { this.ownAttempt(actor, missionId, task.id, input.attemptId) }
      catch (error) {
        // The artifact commit is durable even when the attempt lost its lease
        // during capture. F6: branch on the current status so the worker is told
        // what actually happened — an owner-cancelled task is terminal and can
        // never be reassigned, so "submit again after reassignment" misdirects.
        const stale = `Artifact ${artifact.commit} was captured but the attempt is no longer current`
        const detail = error instanceof Error ? error.message : String(error)
        const current = this.store.get('tasks', task.id)
        if (current?.status === 'cancelled') throw new Error(`${stale}; the mission owner cancelled this task while the artifact was captured. It is terminal: stop working on it and do not resubmit. (${detail})`)
        if (current !== undefined && current.status === 'blocked' && current.resumeAfterStop?.epoch === current.epoch) throw new Error(`${stale}; the task is being reassigned after a stop. Observe the current assignment and submit again after reassignment. (${detail})`)
        throw new Error(`${stale}; observe the task and submit again after reassignment (${detail})`)
      }
      task.artifact = artifact; task.output = input.output; task.status = 'submitted'
      // F2: decide the review path before committing, so the missing-review
      // record lands atomically with the submission and can never be lost. The
      // dedicated task/review-missing event follows on the scheduler tick once
      // the grace period proves no review is being proposed for this artifact.
      const missingReview = this.missingReviewPath(task)
      this.commit(missionId, () => {
        this.store.put('tasks', task)
        for (const evidenceId of task.evidenceIds) { const e = this.store.get('evidence', evidenceId)!; e.artifact = artifact; this.store.put('evidence', e) }
        // Submission is routine progress: the durable event reaches the UI; the reviewer receives its assignment.
        this.store.event(missionId, 'task/submitted', member.id, { taskId: task.id, artifact,
          ...(missingReview === undefined ? {} : { reviewPath: { missing: true, reason: missingReview } }) })
      })
      this.kick(missionId)
      return task
    })
  }
  /**
   * Run host-controlled checks against the exact source artifact and accept or
   * reject it.
   *
   * R11-05/R11-19: the declared checks run outside the per-mission queue. A long
   * or semaphore-queued check therefore cannot delay dispatch, lease renewal or
   * zombie detection for this mission, and the adapter's `verification` activity
   * keeps the queued attempt's lease alive through the scheduler tick. The
   * verdict transaction re-validates every fact the check depended on, so a
   * competing verdict, challenge or cancellation fails closed instead of being
   * overwritten.
   */
  async verify(actor: Actor, missionId: string, input: { taskId: string; attemptId: string; verdict: 'accept' | 'reject'; reason: string }): Promise<Task> {
    const prepared = await this.exclusive(missionId, async () => {
      const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
      if (task.kind !== 'verification' || !task.reviewOf) throw new Error('[not_a_verification_task] This is not a verification task. Call `swarm_verify` with `taskId` and `verdict`, then retry.')
      const source = this.task(missionId, task.reviewOf)
      if (source.status !== 'submitted' || !source.artifact || this.authorIds(source).has(member.id)) throw new Error('Only independent verification of a submitted artifact by a member who never owned it is allowed')
      // The reviewer's own reason is required and bounded; the check-failure
      // report is appended to it, never substituted for it.
      this.bounded(input.reason)
      const artifact = source.artifact
      if (source.checks.length) {
        // M1a seam 5/7: the check window is src/declared-checks.ts#windowFor.
        const verificationWindow = this.declaredChecks.windowFor(source)
        if (!Number.isSafeInteger(verificationWindow)) throw new Error('Verification check duration exceeds the supported clock range')
        this.fenceAttempt(this.mission(missionId), task, verificationWindow)
        this.ownAttempt(actor, missionId, task.id, input.attemptId)
      }
      const evidenceRevision = JSON.stringify(source.evidenceIds.map(eid => this.store.get('evidence', eid)))
      // Re-validate before the verification checkout is created.
      await this.assertWorkspaceAuthorized(this.mission(missionId))
      return { member, source, artifact, evidenceRevision }
    })
    // M1a seam 5/7: the declared-check execution path is src/declared-checks.ts.
    const checks = await this.declaredChecks.run(prepared.member, prepared.source, prepared.artifact, actor.signal)
    this.declaredChecks.recordEnvelope(missionId, input.taskId, prepared.source.id, prepared.member.id)
    return this.exclusive(missionId, async () => {
      const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
      const source = this.task(missionId, prepared.source.id)
      const artifact = prepared.artifact
      if (source.status !== 'submitted' || source.artifact?.commit !== artifact.commit) throw new Error('[artifact_changed_during_verification] Reviewed artifact changed during verification. Verify again with `swarm_verify` and the reviewed `taskId`.')
      if (prepared.evidenceRevision !== JSON.stringify(source.evidenceIds.map(eid => this.store.get('evidence', eid)))) throw new Error('[evidence_changed_during_verification] Evidence changed during verification; inspect the new challenge and verify again. Inspect `evidenceId` with `swarm_observe`, then verify again with `swarm_verify` and its `verdict`.')
      const independentRuns = this.store.list('tool_runs', missionId).filter(run => run.memberId === member.id && run.taskId === task.id && run.attemptId === input.attemptId && !run.isError)
      if (input.verdict === 'accept' && checks.length === 0 && independentRuns.length === 0) throw new Error('Acceptance requires independent host-recorded verification evidence')
      const { passed, failingChecks } = this.declaredChecks.classify(input.verdict, checks)
      // ENV: the host check attaches the environment it ran under and, on
      // failure, the attribution captured before the output bound. The adapter
      // interface still declares the narrow result, so widen it here.
      const outcomes = checks as Array<{ command: string; exitCode: number; output: string; truncated?: boolean; attribution?: CheckAttribution; environment?: CheckEnvironment }>
      const attributionOf = (check: { command: string; exitCode: number }): { attribution?: CheckAttribution } => {
        const found = outcomes.find(item => item.command === check.command && item.exitCode === check.exitCode)
        return found?.attribution === undefined ? {} : { attribution: found.attribution }
      }
      const failureAttribution = outcomes.find(check => check.attribution !== undefined)?.attribution
      // ENV: the envelope delivered to this attempt must be reproducible by the
      // attempt's own self-run. A blocking divergence is durable before it is
      // reported, so a later reader sees the environments, not only the refusal.
      const reproduction = this.checkEnvironmentReproduction(missionId, member.id, task.id, input.attemptId)
      if (reproduction !== undefined && (reproduction.comparison.blocking.length > 0 || reproduction.comparison.advisory.length > 0)) {
        this.commit(missionId, () => this.store.event(missionId, 'task/check-envelope', member.id, {
          taskId: task.id, sourceTaskId: source.id, verdict: input.verdict, reproduction: 'check-environment-mismatch',
          envelope: reproduction.envelope, selfRun: reproduction.selfRun, selfRunSource: reproduction.source, selfRunAt: reproduction.at,
          blocking: reproduction.comparison.blocking, advisory: reproduction.comparison.advisory,
          ...(failureAttribution === undefined ? {} : { attribution: failureAttribution }),
        }))
      }
      // A failed check still blocks the source with its real failure (the
      // mismatch is recorded above). An acceptance, though, is refused rather
      // than validating an artifact under an environment the host check cannot
      // reproduce.
      if (passed && reproduction !== undefined && reproduction.comparison.blocking.length > 0) {
        throw new CheckEnvironmentMismatchError(this.checkEnvironmentMismatchMessage(reproduction.comparison,
          reproduction.source === 'tool-run' ? "recorded on this attempt's host-recorded tool runs" : 'the ambient host environment'))
      }
      // F3-A: a rejection must carry the real failure, not only the reviewer's
      // prose. A judgement rejection with no failing check keeps the prose.
      const rejection = passed ? input.reason : this.declaredChecks.rejectionReason(input.reason, checks)
      const runIds: string[] = []
      const released = new Set<string>()
      this.commit(missionId, () => {
        runIds.push(...this.declaredChecks.recordRuns(missionId, { memberId: member.id, taskId: task.id, attemptId: input.attemptId, commit: artifact.commit }, checks))
        source.status = passed ? 'accepted' : 'blocked'
        task.status = passed ? 'accepted' : 'blocked'; task.output = this.bounded(rejection); task.reviewedCommit = artifact.commit
        this.store.put('tasks', source); this.store.put('tasks', task)
        // Every other review of this source is moot: pending ones can never
        // start, running ones would burn tokens until lease expiry, and parked
        // ones would re-pend against a source that is no longer submitted.
        const verdictReason = `${source.id} was ${passed ? 'accepted' : 'rejected'} by review ${task.id}`
        const siblings = this.retireReviewSiblings(missionId, source.id, { exclude: task.id, reason: verdictReason })
        for (const memberId of siblings.released) released.add(memberId)
        if (passed) for (const previousId of source.replaces ?? []) {
          const previous = this.task(missionId, previousId)
          // A replacement repairs blocked work or restores a cancelled task; any
          // other status change during verification is a conflict.
          if (previous.status !== 'blocked' && previous.status !== 'cancelled') throw new Error('Replacement target changed during verification')
          if (previous.status === 'blocked') {
            previous.status = 'cancelled'; previous.output = `${previous.output ?? ''}\nSuperseded by independently accepted task ${source.id}`
            this.store.put('tasks', previous)
          }
          const oldReviews = this.retireReviewSiblings(missionId, previousId, { exclude: source.id, reason: `Superseded by review of replacement ${source.id}` })
          for (const memberId of oldReviews.released) released.add(memberId)
        }
        for (const evidenceId of source.evidenceIds) {
          const evidence = this.store.get('evidence', evidenceId)!
          // F-12: the durable log must reconstruct which claim became verified or
          // refuted and which reviews the verdict retired; `task/accepted` alone
          // names neither the evidence nor the retired tasks.
          const retired = siblings.retired.map(retiredReview => retiredReview.id)
          if (!passed) {
            // F3-B: a rejected verification refutes the claim exactly once and
            // the stored status matches the `evidence/refuted` event. Leaving
            // the record `challenged` made the board show an unresolved dispute
            // while the durable log already said the claim was refuted.
            if (evidence.status !== 'refuted') {
              evidence.status = 'refuted'
              this.store.event(missionId, 'evidence/refuted', member.id, { evidenceId, outcome: evidence.outcome, taskId: source.id, verificationTaskId: task.id, reason: rejection, retired })
            }
            this.store.put('evidence', evidence)
            continue
          }
          // Status follows the verdict and the claim's own outcome: an inconclusive
          // claim is never promoted to verified knowledge.
          const status: EvidenceStatus = evidence.outcome === 'inconclusive' ? 'unverified' : 'verified'
          evidence.status = status
          this.store.put('evidence', evidence)
          if (status !== 'verified') continue
          this.store.event(missionId, 'evidence/verified', member.id, { evidenceId, outcome: evidence.outcome, taskId: source.id, verificationTaskId: task.id, commit: artifact.commit, retired })
          for (const previous of evidence.supersedes) {
            const old = this.store.get('evidence', previous)!
            const alreadyRefuted = old.status === 'refuted'
            old.status = 'refuted'; old.refutedBy = evidence.id; this.store.put('evidence', old)
            // A predecessor already refuted by its own rejected verification
            // keeps its single refutation; supersession only adds the lineage
            // link. A claim is never refuted twice or both refuted and verified.
            if (!alreadyRefuted) this.store.event(missionId, 'evidence/refuted', member.id, { evidenceId: old.id, refutedBy: evidence.id, taskId: old.taskId, verificationTaskId: task.id, reason: `Superseded by verified evidence ${evidence.id}`, retired })
          }
        }
        this.store.event(missionId, passed ? 'task/accepted' : 'task/rejected', member.id, { sourceTaskId: source.id, verificationTaskId: task.id, commit: artifact.commit, reason: rejection, checks: runIds,
          ...(passed ? {} : { checkFailures: failingChecks.slice(0, MAX_REPORTED_CHECK_FAILURES).map(check => ({ command: check.command, exitCode: check.exitCode, ...attributionOf(check), output: excerpt(check.output, 400) })) }) })
        // Acceptance is routine progress; a rejection blocks work and needs a repair decision.
        if (!passed) {
          this.notify(missionId, `${source.title} (${source.id}) was blocked by independent verification: ${rejection}. Repair it with a replacement task or adjust the plan.`, this.interpretation(missionId).subjectsOf([source]), { from: member.id })
          // R11-18: the rejection reason and the repair path must reach the
          // source author, not only the owner. The author's re-claim is refused
          // (the task is blocked), so without this delivery the only exit is
          // inferred from the owner's notice.
          const authorId = source.attempt?.ownerId ?? source.assigneeId
          const author = authorId === undefined ? undefined : this.store.get('members', authorId)
          if (author !== undefined && memberPhaseOf(author) !== 'stopped') this.store.put('deliveries', { id: id('msg'), missionId, from: member.id, to: author.id, kind: 'control', createdAt: Date.now(),
            content: `${source.title} (${source.id}) was rejected by independent verification: ${rejection}\nRepair path: propose a replacement with swarm_propose naming replaces: ["${source.id}"], keeping its acceptance verbatim and its kind (${source.kind}). Do not resubmit this task; it stays blocked until its replacement is independently accepted.` })
        }
      })
      // Retired reviewers are released inside the verdict transaction; their
      // handles stop outside it so a slow adapter never holds mission state.
      if (released.size) this.defer(async () => { await Promise.all([...released].map(memberId => this.workers.stop(memberId))) })
      // A verdict closes a unit of work for both sessions: let the adapter trim history it no longer needs.
      if (this.workers.compactAtBoundary) for (const memberId of new Set([source.attempt?.ownerId, member.id])) if (memberId) this.workers.compactAtBoundary(memberId)
      this.kick(missionId)
      return task
    })
  }
  /**
   * R11-02 owner restore path (model surface). The owner stages one validated
   * snapshot for the next host start; a running runtime never swaps the
   * database it owns. Refused for any actor that owns no mission in this store,
   * and the snapshot must live inside the managed snapshot directory, so this
   * surface can never point recovery at an arbitrary file.
   */
  requestRestore(actor: Actor, snapshot?: string): PendingRestore {
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    if (!this.store.list('missions').some(mission => mission.ownerSessionId === actor.sessionId)) throw new Error('Only the mission owner may stage a store restore')
    const snapshotDir = `${this.config.statePath}.snapshots`
    const snapshotPath = snapshot === undefined ? SwarmStore.latestSnapshot(this.config.statePath, snapshotDir) : join(snapshotDir, snapshot)
    if (snapshotPath === undefined) throw new StoreRecoveryError('snapshot_invalid', `No snapshot exists for ${this.config.statePath}; nothing to restore`, this.config.statePath)
    const staged = stageRestore(this.config.statePath, snapshotPath, actor.sessionId, snapshotDir)
    this.store.event('swarm/install', 'store/restore-requested', 'runtime', { ...staged })
    return staged
  }
  
  /** Authenticated directed messages and selective topic broadcasts. */
  /**
   * Deliver one message, and — when the caller names the question it answers —
   * settle that question's receipt in the same transaction. L1: an answer is a
   * durable link, never a convention about prose, because the owner's chat text
   * is not part of this store and cannot be reconciled with the question.
   */
  message(actor: Actor, missionId: string, input: MessageInput): { queued: boolean; answered?: string; dismissed?: string } {
    const { key } = this.active(actor, missionId)
    if (input.dismiss === true && input.replyTo === undefined) {
      throw new Error('[reply_target_required] dismiss closes the question named by `replyTo`, and none was passed: pass `replyTo` with the question delivery id (read the open receipts with `swarm_observe` and its `missionId`) and the reason in `content`, or send the answer normally.')
    }
    if (input.to !== 'owner' && input.to !== 'subscribers' && !this.store.list('members', missionId).some(m => m.id === input.to && memberPhaseOf(m) !== 'stopped')) throw new Error('Recipient is not a live mission member')
    if (input.to === 'subscribers' && !input.topic) throw new Error('Broadcast requires a topic')
    const question = input.replyTo === undefined ? undefined : this.answerableQuestion(missionId, key, input.replyTo)
    if (input.dismiss === true) {
      const reason = this.bounded(input.content)
      this.commit(missionId, () => this.receipt(missionId, question!, key, 'dismissed', reason))
      this.kick(missionId)
      return { queued: false, dismissed: question!.id }
    }
    const content = this.bounded(input.content)
    this.commit(missionId, () => {
      if (question !== undefined) this.receipt(missionId, question, key, 'answered', content)
      if (input.to === 'subscribers') this.topicDelivery(missionId, key, input.topic!, content)
      else {
        const deliveryId = id('msg')
        this.store.put('deliveries', {
          id: deliveryId, missionId, from: key, to: input.to, kind: input.kind,
          content: input.to === 'owner' && input.kind === 'question' ? ownerQuestionContent(missionId, deliveryId, key, content, question) : content,
          topic: input.topic, createdAt: Date.now(),
          // A receipt belongs to a question that asks something new. A reply that
          // answers a question is information, so it never opens a second receipt.
          ...(input.kind === 'question' && question === undefined ? { replyExpected: true, state: 'open' as const } : {}),
          ...(question === undefined ? {} : { inReplyTo: question.id }),
        })
      }
      this.store.event(missionId, 'message/queued', key, input)
    })
    this.kick(missionId)
    return { queued: true, ...(question === undefined ? {} : { answered: question.id }) }
  }

  /**
   * L0: questions that were delivered and still carry no answer, optionally
   * restricted to one recipient. The receipt is the durable link `replyTo`
   * writes; a delivery written before this field existed is never retro-open.
   */
  openAsks(missionId: string, to?: string): Delivery[] {
    return this.store.list('deliveries', missionId)
      .filter(delivery => delivery.replyExpected === true && delivery.answeredBy === undefined && (to === undefined || delivery.to === to))
  }

  /** Resolve a `replyTo` target, refusing anything this caller cannot answer. */
  private answerableQuestion(missionId: string, key: string, deliveryId: string): Delivery {
    const target = this.store.get('deliveries', deliveryId)
    if (target === undefined || target.missionId !== missionId) {
      throw new Error('[unknown_reply_target] `replyTo` does not name a delivery of this mission: pass `replyTo` with the question delivery id you received, or read the open receipts with `swarm_observe` and its `missionId`.')
    }
    if (target.replyExpected !== true) {
      throw new Error('[reply_target_not_question] that delivery asked no question, so there is no receipt to settle: pass the message without `replyTo`, or answer a question listed by `swarm_observe` with its `missionId`.')
    }
    if (target.to !== key) {
      throw new Error('[reply_target_not_recipient] that question was addressed to another recipient, and only its recipient settles the receipt: pass `replyTo` for a question addressed to you, or leave it open (list receipts with `swarm_observe` and its `missionId`).')
    }
    return target
  }

  /**
   * Write the receipt once. A replayed answer settles nothing twice and records
   * no second event, so an idempotent retry cannot turn one question into two.
   */
  private receipt(missionId: string, target: Delivery, key: string, state: 'answered' | 'dismissed', detail?: string): boolean {
    if (target.answeredBy !== undefined) return false
    target.state = state
    target.answeredBy = key
    target.answeredAt = Date.now()
    this.store.put('deliveries', target)
    this.store.event(missionId, state === 'answered' ? 'message/answered' : 'message/dismissed', key, {
      deliveryId: target.id, from: target.from, to: target.to,
      ...(detail === undefined ? {} : { reason: detail.slice(0, 200) }),
    })
    return true
  }
  /**
   * Raise one typed, durable owner escalation. This is deliberately not a board
   * post: a post is cross-task visibility addressed to any member, while an
   * escalation is a first-class record that always reaches the owner through
   * the same notice path as every other owner decision, with the mission state
   * fingerprint it was raised in, the authenticated sender, and the task and
   * attempt it concerns. Recording it grants no authority — it changes no task,
   * member, budget or evidence state and no runtime path reads its body as an
   * instruction. An explicit escalation is never deduplicated: two asks are two
   * records, unlike the automatic notices that dedup per state fingerprint.
   */
  escalate(actor: Actor, missionId: string, input: { body: string; taskId?: string; attemptId?: string }): Escalation {
    const { mission, member } = this.participant(actor, missionId)
    if (!member) throw new Error('Only a mission member can escalate to the owner; the owner already holds the mission')
    if (terminal(mission) || mission.status === 'staged') throw new Error(`Mission is ${mission.status}; it cannot accept an escalation`)
    const body = this.bounded(input.body)
    // Provenance is host-derived: an omitted task/attempt resolves to the
    // caller's own running attempt, and a supplied one must be owned by the
    // caller. A member can never attach an escalation to another member's work.
    const running = this.store.list('tasks', missionId).find(task => task.status === 'running' && task.attempt?.ownerId === member.id)
    let taskId = input.taskId
    let attemptId = input.attemptId
    if (taskId === undefined && running !== undefined) { taskId = running.id; attemptId = running.attempt!.id }
    if (attemptId !== undefined && taskId === undefined) throw new Error('attemptId requires taskId')
    if (taskId !== undefined) {
      const task = this.task(missionId, taskId)
      if (attemptId !== undefined) {
        if (task.attempt?.id !== attemptId) throw new Error('Escalation attempt does not belong to that task')
        if (task.attempt.ownerId !== member.id) throw new Error('Escalation attempt is not owned by the caller')
      }
    }
    const dedupKey = this.noticeKey(missionId)
    const at = Date.now()
    const deliveryId = id('msg')
    const escalation: Escalation = {
      id: id('esc'), missionId, fromMemberId: member.id,
      ...(taskId === undefined ? {} : { taskId }), ...(attemptId === undefined ? {} : { attemptId }),
      body, dedupKey, createdAt: at, deliveryId,
    }
    this.commit(missionId, () => {
      // R15-A1: the escalation names the task or attempt it is about, so the
      // owner ledger shows the subject without reparsing the body.
      this.enqueueOwnerNotice(missionId, body, member.id, 'escalation', { id: deliveryId, escalation, subjects: this.noticeSubjectsFor(missionId, { taskId, memberId: member.id }) }, false)
      this.store.event(missionId, 'escalation/raised', member.id, {
        escalationId: escalation.id, memberId: member.id, deliveryId,
        ...(taskId === undefined ? {} : { taskId }), ...(attemptId === undefined ? {} : { attemptId }),
        dedupKey, bodyChars: body.length,
      })
    })
    this.kick(missionId)
    return escalation
  }
  /**
   * Create one durable, typed board post. The sender key and the monotonic
   * sequence come from the host, never from the model. Cited evidence and tool
   * runs must already exist in this mission, a named recipient must be a member
   * of this mission (or the owner), and a reply must name a post in this mission.
   *
   * Authority invariant: this method writes exactly one immutable record. It
   * never accepts, blocks, claims, re-routes or budgets anything, and no runtime
   * path reads a post body as an instruction. Posting therefore cannot change
   * task state; the board is visibility, not control.
   */
  post(actor: Actor, missionId: string, input: PostInput): Post {
    const { key } = this.active(actor, missionId)
    if (!POST_KINDS.includes(input.kind)) throw new Error(`Post kind must be one of ${POST_KINDS.join(', ')}`)
    const body = this.bounded(input.body)
    if (input.to !== undefined) {
      if (input.to === 'me') throw new Error('Recipient "me" is a board read filter, not a post target')
      if (input.to !== 'owner') {
        const target = this.store.get('members', input.to)
        if (target !== undefined && target.missionId !== missionId) throw new Error('Recipient belongs to another mission')
        if (target === undefined) throw new Error('Unknown recipient in this mission')
      }
    }
    if (input.taskId !== undefined) this.task(missionId, input.taskId)
    if (input.attemptId !== undefined && input.taskId === undefined) throw new Error('attemptId requires taskId')
    const evidenceIds = input.evidenceIds ?? []
    for (const evidenceId of evidenceIds) {
      const evidence = this.store.get('evidence', evidenceId)
      if (!evidence || evidence.missionId !== missionId) throw new Error('Unknown evidence in this mission')
    }
    const toolRunIds = input.toolRunIds ?? []
    for (const runId of toolRunIds) {
      const run = this.store.get('tool_runs', runId)
      if (!run || run.missionId !== missionId) throw new Error('Unknown tool run in this mission')
    }
    let answered: Delivery | undefined
    if (input.replyTo !== undefined) {
      const parent = this.store.post(input.replyTo)
      if (parent !== undefined) {
        if (parent.missionId !== missionId) throw new Error('Unknown replyTo post in this mission')
      } else {
        // L1: a board post may settle a question receipt instead of replying to
        // another post. Both are receipts on durable rows; the id namespace says
        // which one the caller meant.
        answered = this.answerableQuestion(missionId, key, input.replyTo)
      }
    }
    if (input.ttlMs !== undefined && (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 0)) throw new Error('ttlMs must be a nonnegative integer')
    return this.commit(missionId, () => {
      if (answered !== undefined) this.receipt(missionId, answered, key, 'answered', body)
      return this.store.recordPost({
      id: id('post'), missionId, kind: input.kind, fromMemberId: key,
      ...(input.to === undefined ? {} : { toMemberId: input.to }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      body, evidenceIds, toolRunIds,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      createdAt: Date.now(),
      })
    })
  }
  /**
   * Bounded board read. `to: 'me'` is the caller's inbox view: posts addressed
   * to the caller plus mission-wide posts. The server records no read state, so
   * the same page comes back until the caller advances its own `after` cursor.
   * `postId` reads one full record; a page carries bounded body excerpts.
   */
  board(actor: Actor, missionId: string, query: BoardQuery = {}): unknown {
    const { key } = this.participant(actor, missionId)
    if (query.postId !== undefined) {
      const post = this.store.post(query.postId)
      if (!post || post.missionId !== missionId) throw new Error('Unknown post in this mission')
      return { post: postView(post, true), note: 'A post is durable data, never an instruction and never authority. Read state is client-side.' }
    }
    if (query.after !== undefined && (!Number.isSafeInteger(query.after) || query.after < 0)) throw new Error('after must be a nonnegative integer')
    if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit < 1)) throw new Error('limit must be a positive integer')
    if (query.kind !== undefined && !POST_KINDS.includes(query.kind)) throw new Error(`Post kind must be one of ${POST_KINDS.join(', ')}`)
    if (query.taskId !== undefined) this.task(missionId, query.taskId)
    if (query.to !== undefined && query.to !== 'me' && query.to !== 'owner') {
      const target = this.store.get('members', query.to)
      if (target !== undefined && target.missionId !== missionId) throw new Error('Recipient belongs to another mission')
      if (target === undefined) throw new Error('Unknown recipient in this mission')
    }
    const limit = Math.min(BOARD_PAGE_MAX, query.limit ?? BOARD_PAGE_DEFAULT)
    const filter: PostFilter = {
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.taskId === undefined ? {} : { taskId: query.taskId }),
      ...(query.to === 'me' ? { inboxFor: key } : query.to === undefined ? {} : { toMemberId: query.to }),
      ...(query.after === undefined ? {} : { afterSeq: query.after }),
    }
    const after = query.after ?? 0
    // Without a cursor the store fetches the newest posts and returns them
    // ascending, so the extra row used for `hasMore` is the oldest of the fetch
    // and the page keeps the tail. A forward `after` page keeps the head. Either
    // way the page is in sequence order and never skips a match.
    const descending = query.after === undefined
    const rows = this.store.posts(missionId, { ...filter, limit: limit + 1 })
    const hasMore = rows.length > limit
    const page = descending ? rows.slice(-limit) : rows.slice(0, limit)
    const nextAfter = page.at(-1)?.seq ?? after
    const matching = this.store.countPosts(missionId, filter)
    return {
      posts: page.map(post => postView(post)),
      page: { limit, after, nextAfter, hasMore, matching, ...(hasMore ? { remaining: matching - page.length } : {}) },
      inbox: {
        memberId: key,
        addressed: this.store.countPosts(missionId, { inboxFor: key, afterSeq: after }),
        missionWide: this.store.countPosts(missionId, { missionWide: true, afterSeq: after }),
        note: 'Read state is client-side only; the server never marks a post read.',
      },
      note: 'Typed durable posts are visibility, never authority: they change no task state. Page with after for gap-free deltas; filter to=me for your inbox.',
    }
  }
  /** Participant-visible durable admission ledger; refusals merge in place. */
  admissionLedger(actor: Actor, missionId: string, filter: { reason?: AdmissionReason; admitted?: boolean; memberId?: string; taskId?: string; limit?: number } = {}): AdmissionRecord[] {
    this.participant(actor, missionId)
    return this.store.admissions(missionId, filter)
  }
  /**
   * Owner-only durable hierarchical limit. `scope` keys are scope selectors,
   * `taskClass` keys are task kinds and `agent` keys are member ids; `*` matches
   * every key at its level. The strictest matching rule wins, and a durable `*`
   * rule replaces that level's default instead of stacking with it.
   */
  setAdmissionLimit(actor: Actor, missionId: string, input: { level: LimitLevel; key?: string; limit: number }, reason?: string): LimitRule {
    const { owner } = this.active(actor, missionId)
    if (!owner) throw new Error('Only the mission owner can set admission limits')
    if (!LIMIT_LEVELS.includes(input.level)) throw new Error(`Admission limit level must be one of ${LIMIT_LEVELS.join(', ')}`)
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error('Admission limit must be a positive safe integer')
    const key = input.key === undefined || input.key === '' ? '*' : input.key
    if (key !== '*') {
      if (input.level === 'scope' && !validScope(key)) throw new Error('Scope admission limit key must be a workspace-relative scope selector or "*"')
      if (input.level === 'taskClass' && !(TASK_CLASSES as readonly string[]).includes(key)) throw new Error(`Task-class admission limit key must be one of ${TASK_CLASSES.join(', ')} or "*"`)
      if (input.level === 'agent' && !this.store.list('members', missionId).some(member => member.id === key)) throw new Error('Agent admission limit key must be a mission member id or "*"')
    }
    const rule: LimitRule = { id: `limit:${missionId}:${input.level}:${key}`, missionId, level: input.level, key, limit: input.limit, createdAt: Date.now() }
    this.commit(missionId, () => {
      this.store.put('limits', rule)
      this.store.event(missionId, 'admission/limit', 'owner', { ...rule, ...(reason !== undefined ? { reason } : {}) })
    })
    this.kick(missionId)
    return rule
  }
  /** Preserve dissent; accepted source work must be repaired or independently re-reviewed. */
  challenge(actor: Actor, missionId: string, input: { evidenceId: string; reason: string; toolRunIds: string[] }): Evidence {
    const { key } = this.active(actor, missionId)
    const evidence = this.store.get('evidence', input.evidenceId)
    if (!evidence || evidence.missionId !== missionId) throw new Error('Unknown evidence')
    this.bounded(input.reason)
    for (const runId of input.toolRunIds) { const run = this.store.get('tool_runs', runId); if (!run || run.missionId !== missionId) throw new Error('Unknown counterevidence tool run') }
    evidence.status = 'challenged'; evidence.challenges.push({ authorId: key, reason: input.reason, toolRunIds: input.toolRunIds })
    const interrupted = new Set<string>()
    this.commit(missionId, () => {
      this.store.put('evidence', evidence)
      const source = this.task(missionId, evidence.taskId)
      if (source.status === 'accepted') { source.status = 'submitted'; this.store.put('tasks', source) }
      const invalidated = new Set([source.id])
      const tasks = this.store.list('tasks', missionId)
      // A dependent naming a replaced original effectively depends on its accepted repair.
      const dependsOnInvalidated = (dependent: Task) => dependent.dependencies.some(dep => [...this.dependencyIdentities(missionId, dep, tasks)].some(identity => invalidated.has(identity)))
      let changed = true
      while (changed) {
        changed = false
        for (const dependent of tasks) {
          if (invalidated.has(dependent.id) || (!dependsOnInvalidated(dependent) && !(dependent.reviewOf && invalidated.has(dependent.reviewOf)))) continue
          invalidated.add(dependent.id); changed = true
          if (dependent.status === 'cancelled' || dependent.status === 'pending') continue
          if (dependent.attempt && dependent.status === 'running') interrupted.add(dependent.attempt.ownerId)
          dependent.epoch++; this.dropAttempt(dependent); dependent.status = dependent.kind === 'verification' ? 'cancelled' : 'blocked'
          dependent.output = `Prerequisite ${source.id} was challenged; inspect the new evidence and propose a replacement.`
          this.store.put('tasks', dependent)
          this.store.event(missionId, 'task/invalidated', 'runtime', { taskId: dependent.id, sourceTaskId: source.id, evidenceId: evidence.id })
        }
      }
      this.store.event(missionId, 'evidence/challenged', key, input)
      // The challenged claim's own task is the subject; the dependents it
      // invalidated are named by the `task/invalidated` events, not merged into it.
      this.notify(missionId, `Evidence ${evidence.id} challenged: ${input.reason}`, this.interpretation(missionId).subjectsOf([source]), { from: key })
    })
    if (interrupted.size) this.defer(async () => { await Promise.all([...interrupted].map(memberId => this.workers.stop(memberId))) })
    this.kick(missionId)
    return evidence
  }
  /** Fence the old attempt immediately; quiescence and reassignment occur after this tool returns. */
  handoff(actor: Actor, missionId: string, input: { taskId: string; attemptId: string; to?: string; summary: string }): { handoff: string } {
    const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
    this.bounded(input.summary)
    if (input.to && !this.store.list('members', missionId).some(m => m.id === input.to && memberPhaseOf(m) !== 'stopped')) throw new Error('Unknown new owner')
    task.status = 'blocked'; task.handoff = input.summary; task.epoch++; task.assigneeId = input.to; this.dropAttempt(task)
    if (input.to !== undefined) task.plannedAssigneeId = input.to
    task.resumeAfterStop = { epoch: task.epoch, reason: 'handoff', at: Date.now() }
    this.commit(missionId, () => { this.store.put('tasks', task); this.store.event(missionId, 'task/handoff-started', member.id, { taskId: task.id, to: input.to ?? null, summary: input.summary }) })
    this.defer(async () => {
      await this.workers.stop(member.id)
      await this.exclusive(missionId, async () => {
        const fresh = this.task(missionId, task.id)
        if (fresh.epoch !== task.epoch || fresh.status !== 'blocked') return
        const m = this.store.get('members', member.id)!
        m.phase = 'active'; fresh.status = 'pending'; delete fresh.resumeAfterStop
        this.commit(missionId, () => { this.store.put('tasks', fresh); this.store.put('members', m); this.store.event(missionId, 'task/handoff-ready', 'runtime', { taskId: fresh.id }) })
      })
      this.kick(missionId)
    })
    return { handoff: 'Ownership revoked; reassignment waits for the previous worker to stop. End your turn.' }
  }
  /**
   * Retire every review that can never reach a verdict because its source is
   * closed. Pending reviews could never start, running reviews would burn model
   * and host-check tokens and hold a lease until expiry, and quiescence-parked
   * reviews would re-pend after lease expiry against a source that can no longer
   * be reviewed. Each retirement is durable, releases the reviewer immediately
   * and returns the members whose handles must be stopped after the commit.
   * Must be called inside a mission transaction.
   */
  private retireReviewSiblings(missionId: string, sourceId: string, options: { exclude?: string; reason: string }): { retired: Task[]; released: Set<string> } {
    const retired: Task[] = []
    const released = new Set<string>()
    for (const review of this.store.list('tasks', missionId)) {
      if (review.id === options.exclude || review.reviewOf !== sourceId) continue
      const previousStatus = review.status
      const moot = previousStatus === 'pending' || previousStatus === 'running' || this.quiescencePending(review)
      if (!moot) continue
      const attempt = review.attempt
      if (attempt !== undefined) {
        const owner = this.store.get('members', attempt.ownerId)
        if (owner !== undefined && memberPhaseOf(owner) !== 'stopped') {
          owner.phase = 'active'; delete owner.activity
          this.store.put('members', owner); released.add(owner.id)
        }
      }
      review.status = 'cancelled'; review.epoch++
      this.dropAttempt(review); delete review.resumeAfterStop; delete review.budgetResume; delete review.closeout; delete review.idleSignal; delete review.gitWriteDenied
      review.output = `${review.output ?? ''}\nSuperseded: ${options.reason}`.trim()
      this.store.put('tasks', review)
      this.store.event(missionId, 'task/review-retired', 'runtime', { taskId: review.id, reviewOf: sourceId, previousStatus,
        ...(attempt === undefined ? {} : { attemptId: attempt.id, ownerId: attempt.ownerId }), reason: options.reason })
      retired.push(review)
    }
    return { retired, released }
  }
  /**
   * F2: the live independent review of a submitted source, if one can still
   * reach a verdict. Uses the shared admission predicate so admission,
   * scheduling and the owner notice agree on what "has a review" means.
   */
  private liveReview(missionId: string, source: Task): Task | undefined {
    const author = source.attempt?.ownerId ?? source.assigneeId
    const authors = this.authorIds(source)
    const live = new Set(this.store.list('members', missionId).filter(member => memberPhaseOf(member) !== 'stopped').map(member => member.id))
    return liveReviewFor(this.store.list('tasks', missionId), source.id, author, live,
      review => (review.status === 'pending' || review.status === 'running' || this.quiescencePending(review))
        && (review.assigneeId === undefined || !authors.has(review.assigneeId)))
  }
  /**
   * F2/R11-16: why a freshly submitted artifact has no review path, or
   * undefined when it has one or produced no reviewable artifact. Reviewability
   * is derived from the captured artifact, never from the declared kind: a
   * research deliverable that captured an artifact is reviewed exactly like code,
   * and a task that captured nothing has nothing to review.
   */
  private missingReviewPath(task: Task): string | undefined {
    if (task.artifact === undefined) return undefined
    if (this.liveReview(task.missionId, task) !== undefined) return undefined
    return `no live independent verification task reviews this submitted ${task.kind} artifact; a review (kind verification, reviewOf ${task.id}) must be pending or running and assigned to a member who did not author it`
  }
  /**
   * F2: a submitted code deliverable no live review can accept is never
   * silently parked. After a grace period (one scheduler period, floor 1s) the
   * runtime records the missing review durably; once the board would otherwise
   * make no progress it admits a bounded independent verification, or wakes the
   * owner once with the exact task id and the concrete blocker. The grace keeps
   * the runtime from racing a review the author is proposing in the same turn
   * and keeps the durable log free of redundant events.
   */
  private admitMissingReviews(mission: Mission): void {
    const tasks = this.store.list('tasks', mission.id)
    const members = this.store.list('members', mission.id)
    const grace = Math.max(this.config.tickMs, AUTO_REVIEW_GRACE_MS)
    const unreviewable: Task[] = []
    for (const source of tasks) {
      if (source.status !== 'submitted' || source.artifact === undefined) continue
      if (this.liveReview(mission.id, source) !== undefined) continue
      const submission = this.latestSubmission(mission.id, source.id)
      if (submission !== undefined && submission.age < grace) continue
      this.reportMissingReview(mission, source, submission?.seq ?? 0)
      unreviewable.push(source)
    }
    if (!unreviewable.length || !this.reviewPathStalled(tasks, members)) return
    for (const source of unreviewable) {
      const blocked = this.withdrawnAutomaticReview(mission.id, source.id) ?? this.reviewPathBlocker(mission, source, members)
      if (blocked !== undefined) { this.notifyReviewBlocked(mission, source, blocked); continue }
      this.admitAutomaticReview(mission, source)
    }
  }
  /** The newest durable submission of one task: how long ago, and its event seq. */
  latestSubmission(missionId: string, taskId: string): { seq: number; age: number } | undefined {
    const events = this.store.events(missionId, this.config.maxEvents)
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!
      if (event.type !== 'task/submitted' || (event.data as { taskId?: string } | undefined)?.taskId !== taskId) continue
      return { seq: event.seq, age: Math.max(0, Date.now() - event.createdAt) }
    }
    return undefined
  }
  /** Record the missing review once per submission; false when it is already recorded. */
  private reportMissingReview(mission: Mission, source: Task, submissionSeq: number): boolean {
    const key = `${mission.id}:${source.id}:${submissionSeq}`
    // S5: the durable `task/review-missing` event for this exact submission is
    // the gate; this re-read makes the in-memory set a pure cache.
    if (this.reviewPathReported.has(key) && this.missingReviewRecorded(mission.id, source.id, submissionSeq)) return false
    const reason = this.missingReviewPath(source) ?? `no live independent verification task reviews this submitted ${source.kind} artifact`
    this.commit(mission.id, () => this.store.event(mission.id, 'task/review-missing', 'runtime', { taskId: source.id, kind: source.kind, submissionSeq, reason }))
    this.reviewPathReported.add(key)
    return true
  }
  /**
   * True when the durable event log already records a missing-review report for
   * this submission: a `task/review-missing` row for the task that is newer than
   * the latest `task/submitted` row for it. Derived from the store, so a
   * restarted runtime does not duplicate the audit row for the same submission.
   */
  private missingReviewRecorded(missionId: string, taskId: string, submissionSeq: number): boolean {
    const events = this.store.events(missionId, this.config.maxEvents)
    let latestSubmission = -1
    let reported = false
    for (const event of events) {
      const data = event.data as { taskId?: string; submissionSeq?: number } | undefined
      if (data?.taskId !== taskId) continue
      if (event.type === 'task/submitted') latestSubmission = Math.max(latestSubmission, event.seq)
      else if (event.type === 'task/review-missing') {
        // Legacy rows carry no submissionSeq; they still prove a report for the
        // submission current at the time they were written.
        if (data.submissionSeq === undefined ? event.seq > latestSubmission : data.submissionSeq === submissionSeq) reported = true
      }
    }
    return reported
  }
  /** An automatic review admitted earlier for this source, once the owner has withdrawn it. */
  private withdrawnAutomaticReview(missionId: string, sourceId: string): string | undefined {
    // S5: the durable `task/review-admitted` event is the gate; the in-memory map
    // is only a cache for an admission whose event write failed. Losing the map
    // therefore cannot admit a second automatic review after a withdrawal.
    const events = this.store.events(missionId, this.config.maxEvents)
    let admitted: string | undefined
    for (const event of events) {
      if (event.type !== 'task/review-admitted') continue
      const data = event.data as { taskId?: string; reviewOf?: string } | undefined
      if (data?.reviewOf === sourceId && data.taskId !== undefined) admitted = data.taskId
    }
    const admittedId = admitted ?? this.autoReviewAdmissions.get(sourceId)
    if (admittedId === undefined) return undefined
    const review = this.store.get('tasks', admittedId)
    if (review === undefined || review.status !== 'cancelled') return undefined
    return `the automatically admitted review ${admittedId} was withdrawn; admit a replacement review (kind verification, reviewOf ${sourceId}) or cancel the source task`
  }
  /** The concrete reason the runtime cannot admit an independent review right now. */
  private reviewPathBlocker(mission: Mission, source: Task, members: Member[]): string | undefined {
    const tasks = this.store.list('tasks', mission.id)
    if (mission.status !== 'active') return `the mission is ${mission.status}; a review can only start while the mission is active`
    if (tasks.length >= mission.budget.maxTasks) return `the mission task budget is exhausted (${tasks.length}/${mission.budget.maxTasks} admitted tasks), so no verification task can be admitted`
    const authors = this.authorIds(source)
    const author = source.attempt?.ownerId ?? source.assigneeId
    if (!members.some(member => memberPhaseOf(member) !== 'stopped' && !authors.has(member.id))) return `no live member other than the author (${author ?? 'unknown'}) can review this artifact independently; add an independent member and admit a verification task`
    return undefined
  }
  /** Admit the bounded independent review for one unreviewable submitted deliverable. */
  private admitAutomaticReview(mission: Mission, source: Task): void {
    let review: Task
    try {
      review = this.propose({ sessionId: mission.ownerSessionId }, mission.id, {
        workstreamId: source.workstreamId, title: `Independent review of ${source.title}`,
        objective: `Independently verify the submitted artifact of ${source.id} (${source.title}) against its acceptance criteria.`,
        kind: 'verification', scope: [...source.scope], acceptance: [...source.acceptance], checks: [...source.checks],
        reviewOf: source.id, maxRecoveryAttempts: AUTO_REVIEW_RECOVERY_ATTEMPTS, priority: source.priority,
        ...(source.checkTimeoutMs === undefined ? {} : { checkTimeoutMs: source.checkTimeoutMs }),
      })
    } catch (error) {
      // Admission can still refuse (budget race, ignored deliverable). The
      // submission stands; the owner is told exactly what to admit instead.
      this.notifyReviewBlocked(mission, source, `automatic review admission failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    this.autoReviewAdmissions.set(source.id, review.id)
    // The review already exists and its task/proposed event is durable; a busy
    // writer must not turn a successful admission into a false blocker notice.
    try {
      this.commit(mission.id, () => this.store.event(mission.id, 'task/review-admitted', 'runtime', {
        taskId: review.id, reviewOf: source.id, maxRecoveryAttempts: AUTO_REVIEW_RECOVERY_ATTEMPTS, reason: 'no live review existed for the submitted artifact',
      }))
    } catch { /* The next tick re-derives the live review from the admitted task. */ }
  }
  
  
  /**
   * Owner-only withdrawal of admitted-but-mistaken work. Pending, blocked,
   * submitted and running tasks become terminally cancelled; a running attempt
   * is fenced immediately, its lease released and its worker freed. Accepted
   * work is immutable and must be repaired with a replacement instead.
   */
  cancel(actor: Actor, missionId: string, input: { taskId: string; reason: string }): Task {
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    actor.signal?.throwIfAborted()
    const { mission, owner, key } = this.participant(actor, missionId)
    if (!owner) throw new Error('Only the mission owner can cancel admitted work')
    if (terminal(mission)) throw new Error('Mission is terminal; create a new mission to continue')
    this.bounded(input.reason)
    const task = this.task(missionId, input.taskId)
    if (task.status === 'accepted') throw new Error(`Task ${task.id} is accepted; accepted work is immutable. Propose a replacement instead.`)
    // Cancellation is terminal and idempotent: a replay never mutates or re-audits it.
    if (task.status === 'cancelled') return task
    const previousStatus = task.status
    const attempt = task.attempt
    // Every member released by this withdrawal is stopped once, outside the transaction.
    const released = new Set<string>()
    const releaseMember = (memberId: string): Member | undefined => {
      const member = this.store.get('members', memberId)
      if (member === undefined || memberPhaseOf(member) === 'stopped') return undefined
      member.phase = 'active'; delete member.activity
      return member
    }
    task.status = 'cancelled'; task.epoch++
    this.dropAttempt(task); delete task.resumeAfterStop; delete task.budgetResume; delete task.closeout; delete task.idleSignal; delete task.gitWriteDenied
    task.output = `${task.output ?? ''}\nCancelled by the mission owner: ${input.reason}`.trim()
    const ownerMember = attempt === undefined ? undefined : releaseMember(attempt.ownerId)
    if (ownerMember !== undefined) released.add(ownerMember.id)
    const strandedDependents: string[] = []
    this.commit(missionId, () => {
      this.store.put('tasks', task)
      if (ownerMember !== undefined) this.store.put('members', ownerMember)
      // Pending, running and quiescence-parked reviews of withdrawn work can
      // never reach a verdict; retire them explicitly so none re-pends after
      // lease expiry and becomes unclaimable against a cancelled source.
      const { released: reviewers } = this.retireReviewSiblings(missionId, task.id, { exclude: task.id, reason: `${task.id} was cancelled by the mission owner` })
      for (const reviewerId of reviewers) released.add(reviewerId)
      // Withdrawal strands admitted dependents whose lineage no longer reaches
      // live work. They stay pending (and repairable) instead of being treated
      // as dead; the owner is told which replacement obligation to admit.
      for (const dependent of this.store.list('tasks', missionId)) {
        if (dependent.id === task.id || dependent.status !== 'pending') continue
        const references = dependent.dependencies.some(dependency => this.dependencyIdentities(missionId, dependency).has(task.id))
        if (references && dependent.dependencies.some(dependency => !this.dependencySatisfied(missionId, dependency))) strandedDependents.push(dependent.id)
      }
      this.store.event(missionId, 'task/cancelled', key, { taskId: task.id, reason: input.reason, previousStatus,
        ...(attempt === undefined ? {} : { attemptId: attempt.id, ownerId: attempt.ownerId }),
        ...(strandedDependents.length ? { strandedDependents } : {}) })
      if (strandedDependents.length) {
        // The withdrawn task and every stranded dependent are the subjects: the
        // decision names exactly the obligations the owner must replace. The
        // subject list comes from the shared interpretation, not a second read.
        const view = this.interpretation(missionId)
        this.notify(missionId, `Cancelling ${task.id} stranded admitted dependents ${strandedDependents.join(', ')}. Propose a replacement for ${task.id} with replaces; dependents resolve to the live repair automatically.`, view.subjectsOf([task, ...view.tasks.filter(candidate => strandedDependents.includes(candidate.id))]), { from: key })
      }
    })
    if (released.size) this.defer(async () => { await Promise.all([...released].map(memberId => this.workers.stop(memberId))) })
    this.kick(missionId)
    return task
  }
  subscribeTopics(actor: Actor, missionId: string, topics: string[]): Member {
    const { member } = this.active(actor, missionId)
    if (!member) throw new Error('Only members have topic subscriptions')
    if (!Array.isArray(topics) || topics.some(t => typeof t !== 'string' || t.length > 200)) throw new Error('Invalid topics')
    member.subscriptions = [...new Set(topics)]
    this.commit(missionId, () => { this.store.put('members', member); this.store.event(missionId, 'member/subscribed', member.id, { topics }) })
    return member
  }
  wait(actor: Actor, missionId: string): { waiting: boolean } {
    const { member } = this.active(actor, missionId)
    if (!member) throw new Error('Only members can park themselves')
    // R10-15: a park must never strand a running attempt. Parking it leaves the
    // task running with a parked owner until lease expiry, which burns a
    // recovery credit and hides the stall behind a live-lease classification.
    // Refuse with the supported exits; an unowned member may still park.
    const open = this.store.list('tasks', missionId).find(task => task.status === 'running' && task.attempt?.ownerId === member.id)
    if (open?.attempt) throw new Error(`You still hold running attempt ${open.attempt.id} on task ${open.id} (${open.title}). swarm_wait cannot park a member that owns a running attempt: submit it with swarm_submit/swarm_verify, release it with swarm_handoff, or keep working. Parking it would leave the attempt running until lease expiry.`)
    member.phase = 'parked'
    this.commit(missionId, () => { this.store.put('members', member); this.store.event(missionId, 'member/waiting', member.id, {}) })
    return { waiting: true }
  }
  /** List only missions belonging to this user session. */
  list(ownerSessionId: string): Mission[] { return this.store.list('missions').filter(m => m.ownerSessionId === ownerSessionId) }
  /** Historical worker sessions never become independent owners when their membership stops. */
  isWorkerSession(sessionId: string): boolean { return this.store.list('members').some(member => member.sessionId === sessionId) }
  /** Owner-only history of natural-language requests; workers do not gain planning authority. */
  starts(actor: Actor): AutoStart[] {
    actor.signal?.throwIfAborted()
    return this.store.list('starts').filter(request => request.ownerSessionId === actor.sessionId)
  }
  private ownedStart(actor: Actor, requestId: string): AutoStart {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    const request = this.store.get('starts', requestId)
    if (!request || request.ownerSessionId !== actor.sessionId || this.isWorkerSession(actor.sessionId)) throw new Error('Automatic request is not owned by this user session')
    return request
  }
  /** Admit once before any planning model call. Human command identity survives retries. */
  requestStart(actor: Actor, input: RequestStartInput): AutoStart {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    if (this.isWorkerSession(actor.sessionId)) throw new Error('Workers cannot create independent missions or budgets')
    requireText(input.commandId, 'commandId')
    if (input.commandId.length > 200) throw new Error('commandId exceeds 200 characters')
    const goal = this.bounded(input.goal).trim()
    if (!isAbsolute(input.workspace)) throw new Error('workspace must be an absolute path')
    const budget = input.budget === undefined ? undefined : validatedBudget(input.budget)
    const prior = this.starts(actor).find(request => request.commandId === input.commandId)
    if (prior) {
      if (prior.goal !== goal || prior.workspace !== input.workspace) throw new Error('Automatic command identity conflicts with a different request')
      return prior
    }
    if (this.starts(actor).some(request => ['planning', 'launching', 'running'].includes(request.status))) throw new Error('This session already has an automatic swarm request in progress')
    if (this.starts(actor).filter(request => request.status === 'failed').length >= 32) throw new Error('Too many failed automatic requests; retry a saved request')
    const now = Date.now()
    const authorized = this.assertAuthorizedRoot(input.workspace, input.workspaceGrantRoot, input.workspaceAuthorizationSource)
    const request: AutoStart = { id: id('start'), ownerSessionId: actor.sessionId, commandId: input.commandId, goal, workspace: input.workspace, workspaceGrantRoot: authorized.grantRoot, workspaceAuthorizationSource: authorized.source,
      budget, status: 'planning', createdAt: now, updatedAt: now }
    this.commit(request.id, () => {
      this.store.put('starts', request)
      this.store.event(request.id, 'automatic/requested', 'owner', { requestId: request.id, commandId: request.commandId, goal })
    })
    return request
  }
  /** Capture before the owner's planning turn; retries retain the same immutable files. */
  async prepareStart(actor: Actor, requestId: string): Promise<AutoStart> {
    return this.exclusive(requestId, async () => {
      const request = this.ownedStart(actor, requestId)
      if (!['planning', 'failed'].includes(request.status)) throw new Error('Request is no longer awaiting planning')
      if (request.baseline) return request
      if (!this.workers.prepareBaseline) throw new Error('This worker adapter cannot snapshot a project for automatic planning')
      // T3e: the synthetic baseline record must carry the request's recorded
      // authorization. Dropping the source makes the X3 fail-closed rule fence a
      // session-cwd request before planning (the native /agent-swarm path);
      // dropping the root loses the grant anchor for a granted request.
      const baseline = await this.workers.prepareBaseline({
        id: `mission_draft_${request.id}`,
        workspace: request.workspace,
        ...(request.workspaceGrantRoot === undefined ? {} : { workspaceGrantRoot: request.workspaceGrantRoot }),
        ...(request.workspaceAuthorizationSource === undefined ? {} : { workspaceAuthorizationSource: request.workspaceAuthorizationSource }),
      }, actor.signal)
      actor.signal?.throwIfAborted()
      const current = this.ownedStart(actor, requestId)
      if (!['planning', 'failed'].includes(current.status)) throw new Error('Snapshot preparation was interrupted')
      current.baseline = baseline; current.updatedAt = Date.now()
      this.commit(request.id, () => { this.store.put('starts', current); this.store.event(request.id, 'workspace/snapshot', 'runtime', baseline) })
      return current
    })
  }
  /** Keep the journal synchronized inside the same transaction as mission control. */
  private syncStarts(mission: Mission): void {
    for (const request of this.store.list('starts', mission.id)) {
      if (mission.status === 'staged') continue
      request.status = mission.status === 'completed' ? 'completed' : mission.status === 'stopped' ? 'stopped' : 'running'
      request.budget = { ...mission.budget }
      request.updatedAt = Date.now(); delete request.error
      this.store.put('starts', request)
    }
  }
  /** Record an admission failure without revoking an already launched mission. */
  failStart(actor: Actor, requestId: string, reason: string): AutoStart {
    const request = this.ownedStart(actor, requestId)
    this.bounded(reason)
    const mission = request.missionId ? this.store.get('missions', request.missionId) : undefined
    if (mission && mission.status !== 'staged') {
      this.commit(mission.id, () => this.syncStarts(mission))
      return this.ownedStart(actor, requestId)
    }
    if (request.status === 'stopped' || request.status === 'completed') return request
    request.status = 'failed'; request.error = reason; request.updatedAt = Date.now()
    this.startControllers.get(requestId)?.abort(new Error(reason))
    this.commit(request.missionId ?? request.id, () => {
      this.store.put('starts', request)
      this.store.event(request.missionId ?? request.id, 'automatic/failed', 'runtime', { requestId, reason })
    })
    return request
  }
  /** Automatic requests must contain a complete independently verifiable topology. */
  private automaticPlan(input: PlanInput, request: AutoStart): PlanInput {
    const plan = validatePlan({ ...input, workspace: request.workspace, ...(request.workspaceGrantRoot === undefined ? {} : { workspaceGrantRoot: request.workspaceGrantRoot }), ...(request.workspaceAuthorizationSource === undefined ? {} : { workspaceAuthorizationSource: request.workspaceAuthorizationSource }) })
    // Collect every automatic-policy issue so one repair round fixes the whole plan.
    const issues: string[] = []
    if (plan.members.length < 2) issues.push('Automatic plans require at least two independent workers')
    for (const member of plan.members) if (member.maxOutputTokens === undefined) issues.push(`members[${member.key}].maxOutputTokens is required: choose this worker's per-request output allowance`)
    const sources = plan.tasks.filter(task => task.kind !== 'verification')
    if (!sources.length) issues.push('Automatic plans require deliverable work')
    for (const task of plan.tasks) {
      if (task.maxRecoveryAttempts === undefined) issues.push(`tasks[${task.key}].maxRecoveryAttempts is required: choose the allowed automatic recovery attempts`)
      if (task.kind !== 'verification' && task.checks?.length && task.checkTimeoutMs === undefined) issues.push(`tasks[${task.key}].checkTimeoutMs is required because it has checks`)
    }
    for (const source of sources) {
      if (!source.assigneeKey || !plan.tasks.some(review => review.kind === 'verification' && review.reviewOf === source.key && review.assigneeKey && review.assigneeKey !== source.assigneeKey)) {
        issues.push(`tasks[${source.key}] requires an assigned independent verification task (kind verification, reviewOf ${source.key}, assigneeKey different from ${source.assigneeKey ?? 'its assignee'})`)
      }
    }
    const missingCriteria = plan.acceptance.filter(criterion => !sources.some(task => task.acceptance.includes(criterion)))
    if (missingCriteria.length) issues.push(`Deliverables must cover every mission acceptance criterion. Missing exact acceptance strings: ${JSON.stringify(missingCriteria)}. Copy each missing string into the acceptance array of the deliverable task that satisfies it; a paraphrase does not match.`)
    const implementations = sources.filter(task => task.kind === 'implementation')
    const byKey = new Map(plan.tasks.map(task => [task.key, task]))
    const dependsOn = (key: string, dependency: string): boolean => {
      const pending = [...(byKey.get(key)?.dependencies ?? [])], visited = new Set<string>()
      while (pending.length) {
        const parent = pending.pop()!
        if (parent === dependency) return true
        if (visited.has(parent)) continue
        visited.add(parent); pending.push(...(byKey.get(parent)?.dependencies ?? []))
      }
      return false
    }
    const integrations = sources.filter(task => task.kind === 'integration')
    // One reviewed implementation is deliverable on its own; assembling several branches needs a final integration.
    if (implementations.length > 1 && !integrations.some(task => implementations.every(implementation => dependsOn(task.key, implementation.key)))) {
      issues.push('Plans with several implementation tasks require a final integration task depending on every implementation deliverable')
    } else if (implementations.length === 1 && integrations.length && !integrations.some(task => dependsOn(task.key, implementations[0]!.key))) {
      issues.push(`The integration task must depend on implementation ${implementations[0]!.key}, or be omitted so the reviewed implementation is delivered directly`)
    }
    if (issues.length) throw new Error(`Automatic plan rejected; repair every item and retry the same requestId:\n${issues.join('\n')}`)
    return plan
  }
  /**
   * Launch one validated generated plan under the saved human request's workspace
   * while the primary agent chooses its resource budget. Retries resume the same
   * draft/member identities and accounting, including after interrupted assembly.
   */
  async startPlan(actor: Actor, requestId: string, input: PlanInput): Promise<Snapshot> {
    return this.exclusive(requestId, async () => {
      let request = this.ownedStart(actor, requestId)
      const priorMission = request.missionId ? this.store.get('missions', request.missionId) : undefined
      if (priorMission && priorMission.status !== 'staged') {
        if (priorMission.status === 'stopped') throw new Error('Automatic mission was stopped; start a new request to continue')
        this.commit(priorMission.id, () => this.syncStarts(priorMission))
        return this.snapshot(actor, priorMission.id)
      }
      if (request.status === 'stopped' || request.status === 'completed') throw new Error('Automatic request cannot be launched in its current state')
      const controller = new AbortController()
      this.startControllers.set(requestId, controller)
      const launchActor: Actor = { sessionId: actor.sessionId, signal: actor.signal ? AbortSignal.any([actor.signal, controller.signal]) : controller.signal }
      try {
        const existing = request.draftId ? this.store.get('drafts', request.draftId) : undefined
        const plan = this.automaticPlan(existing?.input ?? input, request)
        request.budget = { ...plan.budget }
        request.draftId ??= `draft_${request.id}`
        request.missionId ??= `mission_${request.draftId}`
        request.status = 'launching'; request.updatedAt = Date.now(); delete request.error
        this.commit(request.id, () => this.store.put('starts', request))
        launchActor.signal!.throwIfAborted()
        // Saving the deterministic link before the draft makes a crash between
        // these commits recoverable without creating an orphan or a duplicate.
        const draft = existing ?? this.createDraft(launchActor, plan, request.draftId)
        launchActor.signal!.throwIfAborted()
        const snapshot = await this.launchDraft(launchActor, draft.id, draft.revision)
        // The activation commit is authoritative even if cancellation raced its
        // acknowledgment; never report an active mission as an unlaunched retry.
        this.commit(snapshot.mission.id, () => {
          const launched = this.mission(snapshot.mission.id)
          const planning = this.store.get('starts', requestId)
          if (planning?.ownerUsage) {
            launched.ownerUsage = addUsage(launched.ownerUsage, planning.ownerUsage); delete planning.ownerUsage
            this.store.put('missions', launched); this.store.put('starts', planning)
          }
          this.syncStarts(launched)
        })
        this.kick(snapshot.mission.id)
        return this.snapshot({ sessionId: actor.sessionId }, snapshot.mission.id)
      } catch (error) {
        if (!this.closed) {
          request = this.store.get('starts', requestId)!
          const mission = request.missionId ? this.store.get('missions', request.missionId) : undefined
          if (mission && mission.status !== 'staged') this.commit(mission.id, () => this.syncStarts(mission))
          else {
            request.status = 'failed'; request.error = String(error).slice(0, this.config.maxMessageChars); request.updatedAt = Date.now()
            this.commit(request.missionId ?? request.id, () => {
              this.store.put('starts', request)
              this.store.event(request.missionId ?? request.id, 'automatic/failed', 'runtime', { requestId, reason: request.error })
            })
          }
        }
        throw error
      } finally { if (this.startControllers.get(requestId) === controller) this.startControllers.delete(requestId) }
    })
  }
  /** Native browser callers select an existing Harness session; membership still bounds reads. */
  visibleMissions(actor: Actor): Mission[] {
    const memberMissions = new Set(this.store.list('members').filter(m => m.sessionId === actor.sessionId && memberPhaseOf(m) !== 'stopped').map(m => m.missionId))
    return this.store.list('missions').filter(m => m.ownerSessionId === actor.sessionId || memberMissions.has(m.id))
  }
  visibleSnapshots(actor: Actor): Snapshot[] { return this.visibleMissions(actor).map(m => this.snapshot(actor, m.id)) }
  /**
   * Read-only cross-mission artifact registry (R11-14 / R10-10): for every
   * mission this session may see, each captured artifact commit with its task
   * and mission identity, the task's acceptance state and the independent
   * review verdict. Per-mission artifact refs are private (A2-04), so this
   * durable projection is the sanctioned read path for cross-mission
   * artifacts. It reads records only and never mutates mission state.
   */
  artifacts(actor: Actor, query: { missionId?: string } = {}): unknown {
    actor.signal?.throwIfAborted()
    if (this.isWorkerSession(actor.sessionId)) throw new Error('Only the primary user session may read the cross-mission artifact registry')
    const visible = this.visibleMissions(actor)
    const missions = query.missionId === undefined ? visible : visible.filter(mission => mission.id === query.missionId)
    if (query.missionId !== undefined && missions.length === 0) throw new Error('Unknown mission or not visible to this session')
    const rows: Array<Record<string, unknown>> = []
    for (const mission of missions) {
      const tasks = this.store.list('tasks', mission.id)
      for (const task of tasks) {
        if (task.artifact === undefined) continue
        const review = tasks.filter(candidate => candidate.reviewOf === task.id && candidate.status !== 'cancelled')
          .sort((left, right) => left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))[0]
        rows.push({
          missionId: mission.id, missionTitle: mission.title, missionStatus: mission.status,
          missionAcceptance: mission.acceptance,
          taskId: task.id, taskTitle: task.title, taskKind: task.kind, taskStatus: task.status,
          acceptance: task.acceptance,
          artifact: { commit: task.artifact.commit, baseCommit: task.artifact.baseCommit, changedPaths: task.artifact.changedPaths },
          ...(review === undefined ? {} : { review: { taskId: review.id, status: review.status,
            verdict: review.status === 'accepted' ? 'verified' : review.status === 'blocked' ? 'refuted' : 'pending',
            ...(review.output === undefined ? {} : { reason: excerpt(review.output, 400) }) } }),
        })
      }
    }
    return {
      artifacts: rows, total: rows.length, missions: missions.map(mission => mission.id),
      note: 'Read-only registry over durable records: artifact commit, task, mission, acceptance state and review verdict. Per-mission artifact refs are private; this is the sanctioned cross-mission read path. Reading it changes no state.',
    }
  }
  drafts(actor: Actor): DraftPlan[] { return this.store.list('drafts').filter(d => d.ownerSessionId === actor.sessionId && d.status !== 'discarded') }
  private ownedDraft(actor: Actor, draftId: string): DraftPlan {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    const draft = this.store.get('drafts', draftId)
    if (!draft || draft.ownerSessionId !== actor.sessionId) throw new Error('Draft is not owned by this session')
    return draft
  }
  /** Saving a plan creates no workers, worktrees or model calls. */
  createDraft(actor: Actor, input: PlanInput, admittedId?: string): DraftPlan {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    if (this.store.list('members').some(m => m.sessionId === actor.sessionId)) throw new Error('Workers cannot create independent missions or budgets')
    if (this.drafts(actor).filter(d => ['draft', 'failed', 'launching'].includes(d.status)).length >= 32) throw new Error('Discard unused drafts before creating more')
    const now = Date.now()
    if (admittedId && this.store.get('drafts', admittedId)) throw new Error('Draft admission identity already exists')
    // A staged draft carries the same authorization anchor as a created
    // mission, so launching it cannot introduce a root the admission check did
    // not already accept. The anchor is stored on the draft record, never
    // inside `input`: the saved plan stays exactly the validated plan.
    const admitted = validatePlan(input)
    const authorized = this.assertAuthorizedRoot(admitted.workspace, input.workspaceGrantRoot, input.workspaceAuthorizationSource)
    const { workspaceGrantRoot: _claimedRoot, workspaceAuthorizationSource: _claimedSource, ...clean } = admitted
    const draft: DraftPlan = { id: admittedId ?? id('draft'), ownerSessionId: actor.sessionId, revision: 1, status: 'draft', input: clean, workspaceGrantRoot: authorized.grantRoot, workspaceAuthorizationSource: authorized.source, createdAt: now, updatedAt: now }
    this.commit(draft.id, () => { this.store.put('drafts', draft); this.store.event(draft.id, 'plan/staged', 'owner', { draftId: draft.id, revision: draft.revision }) })
    return draft
  }
  updateDraft(actor: Actor, draftId: string, revision: number, input: PlanInput): DraftPlan {
    const draft = this.ownedDraft(actor, draftId)
    if (draft.revision !== revision) throw new Error('Draft changed; reload before saving')
    if (draft.status !== 'draft') throw new Error('Only unlaunched drafts can be edited; discard a failed launch to create a different plan')
    const admitted = validatePlan(input)
    const authorized = this.assertAuthorizedRoot(admitted.workspace, input.workspaceGrantRoot, input.workspaceAuthorizationSource)
    const { workspaceGrantRoot: _claimedRoot, workspaceAuthorizationSource: _claimedSource, ...clean } = admitted
    draft.input = clean; draft.workspaceGrantRoot = authorized.grantRoot; draft.workspaceAuthorizationSource = authorized.source; draft.revision++; draft.updatedAt = Date.now()
    this.commit(draft.id, () => { this.store.put('drafts', draft); this.store.event(draft.id, 'plan/edited', 'owner', { draftId, revision: draft.revision }) })
    return draft
  }
  discardDraft(actor: Actor, draftId: string, revision: number): DraftPlan {
    const draft = this.ownedDraft(actor, draftId)
    if (draft.revision !== revision) throw new Error('Draft changed; reload before discarding')
    if (!['draft', 'failed'].includes(draft.status)) throw new Error('A launching or launched plan cannot be discarded; stop its mission instead')
    if (draft.missionId) {
      const mission = this.store.get('missions', draft.missionId)
      if (mission && !terminal(mission)) this.control(actor, mission.id, 'stop', 'Discarded the unlaunched plan after an assembly failure')
    }
    draft.status = 'discarded'; draft.revision++; draft.updatedAt = Date.now()
    this.commit(draft.id, () => this.store.put('drafts', draft))
    return draft
  }
  /** Build the entire topology while dispatch is fenced, then activate it in one commit. */
  async launchDraft(actor: Actor, draftId: string, revision: number): Promise<Snapshot> {
    return this.exclusive(draftId, async () => {
      const draft = this.ownedDraft(actor, draftId)
      if (draft.status === 'launched' && draft.missionId) return this.snapshot(actor, draft.missionId)
      if (draft.revision !== revision) throw new Error('Draft changed; reload before launching')
      if (!['draft', 'failed'].includes(draft.status)) throw new Error('Draft cannot be launched in its current state')
      const automatic = this.store.list('starts').find(request => request.draftId === draft.id)
      const input = automatic ? this.automaticPlan(draft.input, automatic) : validatePlan(draft.input)
      draft.input = input
      draft.status = 'launching'; draft.revision++; draft.updatedAt = Date.now(); delete draft.error
      draft.missionId ??= `mission_${draft.id}`
      this.commit(draft.id, () => this.store.put('drafts', draft))
      const missionId = draft.missionId
      try {
        let mission = this.store.get('missions', missionId)
        if (!mission) {
          const { title, objective, workspace, scope, acceptance, budget } = input
          const extra = input as PlanInput & { workspaceGrantRoot?: string; workspaceAuthorizationSource?: 'session' | 'grant' }
          const anchor = draft.workspaceGrantRoot ?? extra.workspaceGrantRoot
          const source = draft.workspaceAuthorizationSource ?? extra.workspaceAuthorizationSource
          mission = this.create(actor, { title, objective, workspace, ...(anchor === undefined ? {} : { workspaceGrantRoot: anchor }), ...(source === undefined ? {} : { workspaceAuthorizationSource: source }), scope, acceptance, budget }, { id: missionId, status: 'staged' })
        }
        if (mission.ownerSessionId !== actor.sessionId || mission.status !== 'staged') throw new Error('The partially assembled mission cannot be launched')
        for (const member of input.members) await this.addMember(actor, missionId, member, `member_${draft.id}_${member.key}`)
        for (const stream of input.workstreams) this.workstream(actor, missionId, stream, `stream_${draft.id}_${stream.key}`)
        for (const task of orderedTasks(input.tasks)) this.propose(actor, missionId, {
          ...task, workstreamId: `stream_${draft.id}_${task.workstreamKey}`,
          assigneeId: task.assigneeKey ? `member_${draft.id}_${task.assigneeKey}` : undefined,
          dependencies: task.dependencies?.map(key => `task_${draft.id}_${key}`),
          reviewOf: task.reviewOf ? `task_${draft.id}_${task.reviewOf}` : undefined,
        }, `task_${draft.id}_${task.key}`)
        mission = this.active(actor, missionId, true).mission
        // S5c: the launch's cancellation decision is durable, not the in-memory
        // abort handle. `failStart` records the failed request durably (the
        // mission is still staged here, so it takes the failing branch); re-read
        // it before activation so a launch cancelled while it was assembling
        // cannot bring a mission active just because `startControllers` was lost
        // or raced. A retry calls `startPlan` again, which sets the request back
        // to `launching`, so only a change that happened after THIS launch began
        // is honoured. The refusal reuses this site's existing message: the
        // control-path refusal inventory on the serialized files must not grow,
        // and the durable `automatic/failed` event `failStart` wrote already
        // carries the cancellation reason.
        const inFlight = automatic === undefined ? undefined : this.store.get('starts', automatic.id)
        const cancelled = inFlight !== undefined && (inFlight.status === 'failed' || inFlight.status === 'stopped')
        if (cancelled || mission.status !== 'staged') throw new Error('Plan assembly was interrupted')
        mission.status = 'active'; mission.updatedAt = Date.now(); mission.deadline = Date.now() + mission.budget.maxDurationMs
        draft.status = 'launched'; draft.updatedAt = Date.now()
        this.commit(missionId, () => {
          this.store.put('missions', mission!); this.store.put('drafts', draft)
          this.syncStarts(mission!)
          this.store.event(missionId, 'plan/launched', 'owner', { draftId, revision: draft.revision })
        })
        this.kick(missionId)
        return this.snapshot(actor, missionId)
      } catch (error) {
        draft.status = 'failed'; draft.error = String(error); draft.updatedAt = Date.now()
        if (!this.closed) this.commit(draft.id, () => this.store.put('drafts', draft))
        throw error
      }
    })
  }
  /** Snapshot access is checked against durable membership. */
  snapshot(actor: Actor, missionId: string): Snapshot {
    const { mission } = this.participant(actor, missionId)
    const tasks = this.store.list('tasks', missionId)
    let deliveryTarget: { taskId: string; commit: string } | undefined
    try {
      const target = this.selectDeliveryTarget(missionId, tasks)
      if (target.artifact) deliveryTarget = { taskId: target.id, commit: target.artifact.commit }
    } catch { deliveryTarget = undefined }
    const completionReason = this.completionError(mission, { cancelUnschedulable: true })
    // R17-G6: the client's read face takes member statuses from the derived board
    // (the registered projection when published), not from a second derivation.
    return { mission, members: this.projectedMembers(missionId), workstreams: this.store.list('workstreams', missionId), tasks, evidence: this.store.list('evidence', missionId), events: this.store.events(missionId, this.config.maxEvents), pendingDeliveries: this.store.list('deliveries', missionId).filter(d => !d.deliveredAt).length,
      ...(deliveryTarget === undefined ? {} : { deliveryTarget }),
      completion: { eligible: completionReason === undefined, ...(completionReason === undefined ? {} : { reason: completionReason }) },
      criticalPath: this.criticalPath(missionId),
      ...(mission.appliedDelivery === undefined ? {} : { appliedDelivery: { resultCommit: mission.appliedDelivery.resultCommit, appliedAt: mission.appliedDelivery.appliedAt } }) }
  }
  /**
   * Bounded, focused model views. A member sees its current task, the
   * prerequisites and review source it needs, its own run references and new
   * events; the owner sees a compact board and usage. Full records are read by
   * id (`taskId`, `runId` paged by `offset`, `evidenceId`). The complete board
   * stays in the UI projection instead of every model request.
   *
   * After a member's first read the runtime remembers the delivered event/run
   * position and the default read returns only the delta — new events and tool
   * runs, plus the current assignment when it changed — so appended content
   * keeps the cached prompt prefix intact instead of re-sending superseded
   * snapshots (docs/observe-context-measurement.md). `detail=full` is owner-only.
   */
  observe(actor: Actor, missionId: string, query: ObserveQuery = {}, options: { advanceEventCursor?: boolean } = {}): unknown {
    actor.signal?.throwIfAborted()
    const { mission, member, owner } = this.participant(actor, missionId)
    for (const key of ['after', 'afterRun', 'offset'] as const) {
      if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || Number(query[key]) < 0)) throw new Error(`${key} must be a nonnegative integer`)
    }
    // Worker guidance alone did not prevent detail=full, so the runtime refuses
    // it for worker sessions while the owner path keeps the complete view.
    if (member && query.detail === 'full') throw new ObserveDetailRefusedError()
    const tasks = this.store.list('tasks', missionId), members = this.projectedMembers(missionId)
    const runRef = (run: ToolRun) => ({ id: run.id, seq: run.seq ?? 0, taskId: run.taskId, attemptId: run.attemptId, memberId: run.memberId, tool: run.tool, isError: run.isError, arguments: excerpt(run.arguments, 240) })
    const evidenceRef = (evidence: Evidence, full = false) => ({ id: evidence.id, taskId: evidence.taskId, authorId: evidence.authorId, claim: full ? evidence.claim : excerpt(evidence.claim, 400), outcome: evidence.outcome, status: evidence.status, toolRunIds: evidence.toolRunIds,
      ...(evidence.challenges.length ? { challenges: full ? evidence.challenges : evidence.challenges.length } : {}), ...(evidence.supersedes.length ? { supersedes: evidence.supersedes } : {}) })
    const taskRef = (task: Task) => ({ id: task.id, title: task.title, kind: task.kind, status: task.status, ...(task.assigneeId ? { assigneeId: task.assigneeId } : {}), ...(task.attempt ? { attemptOwner: task.attempt.ownerId } : {}),
      ...(task.reviewOf ? { reviewOf: task.reviewOf } : {}), ...(task.dependencies.length ? { dependencies: task.dependencies } : {}), ...(task.replaces?.length ? { replaces: task.replaces } : {}), ...(task.artifact ? { artifact: task.artifact.commit } : {}) })
    const taskRecord = (task: Task, outputLimit: number) => ({ ...task, ...(task.output !== undefined ? { output: excerpt(task.output, outputLimit) } : {}), ...(task.handoff !== undefined ? { handoff: excerpt(task.handoff, outputLimit) } : {}) })
    const evidenceOf = (task: Task, full = false) => task.evidenceIds.map(evidenceId => this.store.get('evidence', evidenceId)).filter((item): item is Evidence => item !== undefined).map(item => evidenceRef(item, full))
    const runsWindow = (filter: { memberId?: string; taskId?: string; attemptId?: string }, limit: number, afterSeq?: number) => {
      const all = this.store.toolRuns(missionId, { ...filter, ...(afterSeq === undefined ? {} : { afterSeq }) })
      const shown = afterSeq === undefined ? all.slice(-limit) : all.slice(0, limit)
      return { toolRuns: shown.map(runRef), totalToolRuns: all.length, ...(shown.length ? { nextAfterRun: shown.at(-1)!.seq ?? 0 } : {}), ...(all.length > shown.length ? { omittedToolRuns: all.length - shown.length } : {}) }
    }
    if (query.runId !== undefined) {
      const run = this.store.get('tool_runs', query.runId)
      if (!run || run.missionId !== missionId) throw new Error('Unknown tool run in this mission')
      const body = JSON.stringify({ arguments: run.arguments, result: run.result })
      const offset = query.offset ?? 0, page = Math.min(12000, this.config.maxMessageChars)
      return { run: { id: run.id, seq: run.seq ?? 0, taskId: run.taskId, attemptId: run.attemptId, memberId: run.memberId, tool: run.tool, isError: run.isError, createdAt: run.createdAt },
        totalChars: body.length, offset, content: body.slice(offset, offset + page), ...(offset + page < body.length ? { nextOffset: offset + page } : {}) }
    }
    if (query.evidenceId !== undefined) {
      const evidence = this.store.get('evidence', query.evidenceId)
      if (!evidence || evidence.missionId !== missionId) throw new Error('Unknown evidence in this mission')
      return { evidence: { ...evidenceRef(evidence, true), workstreamId: evidence.workstreamId, artifact: evidence.artifact, createdAt: evidence.createdAt } }
    }
    if (query.taskId !== undefined) {
      const task = this.task(missionId, query.taskId)
      return { task: taskRecord(task, 6000), evidence: evidenceOf(task, true), reviews: tasks.filter(item => item.reviewOf === task.id).map(taskRef),
        dependencies: task.dependencies.map(dep => this.lineage(missionId, dep, tasks)).map(chain => ({ ...taskRef(chain.at(-1)!), ...(chain.length > 1 ? { replacementOf: chain.slice(0, -1).map(item => item.id) } : {}) })),
        ...(task.reviewOf ? { reviewSource: taskRef(this.task(missionId, task.reviewOf)) } : {}), ...runsWindow({ taskId: task.id }, 40, query.afterRun) }
    }
    // A member's delivered position is the default cursor; an explicit
    // after/afterRun overrides it for one read and still advances it.
    const delivered = member === undefined ? undefined : this.observeCursors.get(member.id)
    const after = query.after ?? delivered?.eventSeq
    const afterRun = query.afterRun ?? delivered?.runSeq
    const eventLimit = 12
    // `after: 0` keeps its original meaning (no cursor): a member cursor of 0
    // only occurs when nothing was delivered yet, so the last window is correct.
    const fetched = this.store.events(missionId, after ? eventLimit + 1 : eventLimit, after ?? 0)
    const events = fetched.slice(0, eventLimit).map(event => ({ seq: event.seq, type: event.type, actor: event.actor, summary: excerpt(event.data, 240) }))
    const eventCursor = { ...(events.length ? { nextAfter: events.at(-1)!.seq } : {}), ...(fetched.length > eventLimit ? { moreEvents: true } : {}) }
    const budget = { usedTokens: mission.usedTokens, maxTokens: mission.budget.maxTokens, usedSteps: mission.usedSteps, maxSteps: mission.budget.maxSteps, deadline: mission.deadline, inFlightTokensEstimate: this.inFlightEstimate(members) }
    const full = query.detail === 'full'
    if (member) {
      const current = tasks.find(task => task.status === 'running' && task.attempt?.ownerId === member.id)
      const currentKey = current === undefined ? undefined : `${current.id}:${current.attempt!.id}:${current.status}`
      const source = current?.reviewOf ? this.task(missionId, current.reviewOf) : undefined
      const runs = runsWindow(current?.attempt ? { memberId: member.id, taskId: current.id, attemptId: current.attempt.id } : { memberId: member.id }, 20, afterRun)
      // Board traffic is part of the delta: counts plus the newest few posts,
      // so a worker learns about cross-task posts without a second poll.
      const postAfter = delivered?.postSeq ?? 0
      const posts = this.boardWindow(missionId, member.id, postAfter)
      const nextPostSeq = typeof posts.nextAfter === 'number' ? posts.nextAfter : postAfter
      // Record only what this response delivers. A history page swapped in by
      // tools.ts suppresses the event advance so no unseen event is skipped.
      const advanceEvents = options.advanceEventCursor !== false
      if (delivered !== undefined || advanceEvents) this.observeCursors.set(member.id, {
        eventSeq: advanceEvents ? Math.max(delivered?.eventSeq ?? 0, events.at(-1)?.seq ?? 0, query.after ?? 0) : delivered?.eventSeq ?? 0,
        runSeq: Math.max(delivered?.runSeq ?? 0, runs.toolRuns.at(-1)?.seq ?? 0, query.afterRun ?? 0),
        postSeq: advanceEvents ? Math.max(delivered?.postSeq ?? 0, nextPostSeq) : delivered?.postSeq ?? 0,
        ...(currentKey === undefined ? {} : { current: currentKey }),
      })
      // The first read is the focused view; later default reads are deltas.
      if (delivered !== undefined && query.after === undefined && query.afterRun === undefined) return {
        // A changed current assignment is new content the member must see; an
        // unchanged one stays in the cached prefix and is not re-sent.
        ...(delivered.current === currentKey ? {} : { current: current === undefined ? null : {
          task: taskRecord(current!, 2400), attemptId: current!.attempt!.id,
          dependencies: current!.dependencies.map(dep => this.lineage(missionId, dep, tasks)).map(chain => ({ ...taskRef(chain.at(-1)!), output: excerpt(chain.at(-1)!.output ?? '', 600), ...(chain.length > 1 ? { replacementOf: chain.slice(0, -1).map(item => item.id) } : {}) })),
          ...(source ? { reviewSource: { ...taskRecord(source, 2400), evidence: evidenceOf(source) } } : {}),
        } }),
        events, ...eventCursor, ...runs,
        posts,
        delta: true,
        detail: 'Delta since your last delivered cursor: new events, tool runs and board posts, plus your current assignment when it changed. Read taskId, runId, evidenceId or swarm_board for one full record.',
      }
      return {
        mission: { id: mission.id, title: mission.title, status: mission.status, ...budget },
        member: { id: member.id, name: member.name, role: member.role, status: member.status },
        current: current ? {
          task: taskRecord(current, 2400), attemptId: current.attempt!.id,
          dependencies: current.dependencies.map(dep => this.lineage(missionId, dep, tasks)).map(chain => ({ ...taskRef(chain.at(-1)!), output: excerpt(chain.at(-1)!.output ?? '', 600), ...(chain.length > 1 ? { replacementOf: chain.slice(0, -1).map(item => item.id) } : {}) })),
          ...(source ? { reviewSource: { ...taskRecord(source, 2400), evidence: evidenceOf(source) } } : {}),
        } : null,
        evidence: current ? evidenceOf(current) : [],
        ...runs,
        events, ...eventCursor,
        posts,
        board: full ? tasks.map(task => taskRecord(task, 2400)) : tasks.map(taskRef), members: members.map(item => ({ id: item.id, name: item.name, role: item.role, status: item.status })),
        detail: full ? 'Focused view with complete task records. taskId reads one task with full evidence and runs; runId with offset reads one stored run; evidenceId reads one claim; swarm_board reads the durable post board; after/afterRun return only changes.' : 'Focused view; later default reads return only the delta of new events, tool runs and board posts. taskId reads one task with full evidence and runs; runId with offset reads one stored run; evidenceId reads one claim; swarm_board reads the durable post board; after/afterRun return only changes.',
      }
    }
    const evidence = this.store.list('evidence', missionId)
    return {
      mission: { id: mission.id, title: mission.title, status: mission.status, ...(mission.reason ? { reason: mission.reason } : {}), ...budget, criticalPath: this.criticalPath(missionId), workerUsage: mission.workerUsage ?? emptyUsage(), ownerUsage: mission.ownerUsage ?? emptyUsage() },
      members: members.map(item => ({ id: item.id, name: item.name, role: item.role, status: item.status, ...(item.activity ? { activity: item.activity.kind } : {}), accountedTokens: item.accountedTokens ?? 0, requests: item.usage?.requests ?? 0 })),
      board: full ? tasks.map(task => taskRecord(task, 6000)) : tasks.map(taskRef),
      evidence: (full ? evidence : evidence.filter(item => item.status === 'challenged' || item.status === 'refuted')).map(item => evidenceRef(item, full)),
      unschedulable: this.unschedulable(mission, tasks, members).map(task => task.id),
      pendingDeliveries: this.store.list('deliveries', missionId).filter(delivery => !delivery.deliveredAt).length,
      // The owner has no delivered cursor, so the board appears as a bounded
      // total plus the newest few posts; swarm_board pages the full history.
      posts: { total: this.store.countPosts(missionId), newest: this.store.posts(missionId, { newest: true, limit: BOARD_DELTA_POSTS }).map(post => postView(post)) },
      events, ...eventCursor,
      ...(owner ? this.ownerInstruments(missionId, full) : {}),
      detail: full ? 'Complete task records and evidence claims; tool payloads are read by runId.' : 'Compact board. taskId reads one task with evidence and runs; detail=full expands every task record; after returns only newer events.',
      ...(owner ? {} : { note: 'Non-member observer' }),
    }
  }
  
  /** Requests already streaming have no reported usage yet; estimate each at its worker's average. */
  private inFlightEstimate(members: Member[]): number {
    let total = 0
    for (const member of members) {
      if (memberPhaseOf(member) === 'stopped') continue
      const activity = this.workers.currentActivity ? this.workers.currentActivity(member.id) : member.activity
      if (activity?.kind !== 'model') continue
      const requests = member.usage?.requests ?? 0
      if (requests > 0) total += Math.ceil((member.accountedTokens ?? 0) / requests)
    }
    return total
  }
  
  
  async inspectDelivery(actor: Actor, missionId: string) {
    const { mission, task } = this.deliveryTarget(actor, missionId)
    if (!this.workers.inspectDelivery) throw new Error('This worker adapter does not support delivery inspection')
    return this.workers.inspectDelivery(mission, task.artifact!.commit, actor.signal)
  }
  async applyDelivery(actor: Actor, missionId: string) {
    const target = this.deliveryTarget(actor, missionId)
    // Different completed missions for one source must not apply concurrently.
    return this.exclusive(`delivery:${target.mission.workspace}`, async () => {
      const { mission, task } = this.deliveryTarget(actor, missionId)
      if (!this.workers.applyDelivery) throw new Error('This worker adapter does not support applying results')
      const result = await this.workers.applyDelivery(mission, task.artifact!.commit, actor.signal)
      this.commit(missionId, () => {
        // The projection states what is currently in effect, so a conflicts result
        // clears any earlier marker instead of leaving a stale "applied" claim for
        // the same target (I2 hand-off 4, reconciled at integration).
        if (result.status === 'applied') mission.appliedDelivery = { resultCommit: task.artifact!.commit, appliedAt: Date.now() }
        else delete mission.appliedDelivery
        this.store.put('missions', mission)
        this.store.event(missionId, `delivery/${result.status}`, 'owner', { resultCommit: task.artifact!.commit, ...result })
      })
      return result
    })
  }
  
  
  
  
  
  completionError(mission: Mission, options: { cancelUnschedulable?: boolean } = {}): string | undefined {
    const tasks = this.store.list('tasks', mission.id)
    if (!tasks.length) return 'Mission still has unfinished or blocked required work'
    const leftover = options.cancelUnschedulable ? new Set(this.unschedulable(mission, tasks, this.store.list('members', mission.id)).map(task => task.id)) : new Set<string>()
    const unfinished = tasks.filter(task => !['accepted', 'cancelled'].includes(task.status) && !(task.experiment && task.status === 'blocked') && !leftover.has(task.id))
    if (unfinished.length) return `Mission still has unfinished or blocked required work: ${unfinished.map(task => `${task.id} (${task.status})`).join(', ')}`
    const accepted = tasks.filter(task => task.status === 'accepted')
    // Verification acceptance text is free-form review criteria; only deliverable
    // work can cover a mission criterion, and code deliverables need an artifact.
    const deliverables = accepted.filter(task => task.kind !== 'verification' && (task.kind === 'research' || task.artifact !== undefined))
    const uncovered = mission.acceptance.filter(criterion => !deliverables.some(task => Array.isArray(task.acceptance) && task.acceptance.includes(criterion)))
    if (uncovered.length) {
      const blocked = tasks.filter(task => task.status === 'blocked' && !task.experiment).map(task => task.id)
      return `Accepted tasks do not cover every mission acceptance criterion: ${JSON.stringify(uncovered)}${blocked.length ? `. Blocked work still needs repair: ${blocked.join(', ')}` : ''}`
    }
    if (tasks.some(task => task.kind === 'implementation') && !accepted.some(task => task.kind === 'integration' && task.artifact)) {
      const implementations = accepted.filter(task => task.kind === 'implementation' && task.artifact)
      if (tasks.some(task => task.kind === 'integration') || implementations.length !== 1) return 'Coding missions require an independently accepted integration artifact, or exactly one independently accepted implementation artifact when the plan has no integration task'
    }
    // Evidence of cancelled or dead work no longer supports any accepted result; live disputes still block.
    const dead = new Set(tasks.filter(task => task.status === 'cancelled' || leftover.has(task.id)).map(task => task.id))
    const disputed = this.store.list('evidence', mission.id).filter(evidence => evidence.status === 'challenged' && !dead.has(evidence.taskId))
    if (disputed.length) return `Unresolved evidence challenges prevent completion: ${disputed.map(evidence => evidence.id).join(', ')}`
    return undefined
  }
  /**
   * Liveness for every active mission, not only for missions launched from an
   * automatic request. The `starts` journal is an admission-policy marker
   * (automatic workers must carry primary-agent-chosen limits, enforced at
   * `addMember`/`propose`); gating liveness on it left a `swarm_create` mission
   * unable to wake the owner when it stalled (Round-8 F1).
   *
   * A stalled board is reported for every mission, and a stalled board whose
   * dead leftovers can be cancelled under complete independent coverage
   * completes for every mission. A covered board with no unschedulable work
   * still completes automatically only on the automatic launch path, whose
   * fixed plan makes the board final: an owner-assembled plan may still be
   * extending the mission, so `swarm_create`/staged missions retain explicit
   * completion there (the automatic launch path is the one that must not need
   * an owner action).
   */
  private completeAutomatic(missionId: string): boolean {
    const mission = this.mission(missionId)
    if (mission.status !== 'active') return false
    const automatic = this.store.list('starts', missionId).length > 0
    const tasks = this.store.list('tasks', missionId), members = this.store.list('members', missionId)
    const strict = this.completionError(mission)
    const isStalled = strict !== undefined && this.stalled(mission, tasks, members)
    // Spec §2: a notice is fresh only for the state it described. Once the board
    // leaves the stalled / coverage-complete class, forget the dedup key so a
    // later return to the same fingerprint re-notifies instead of staying silent.
    if (!isStalled && mission.stallNotice !== undefined) { delete mission.stallNotice; this.commit(missionId, () => this.store.put('missions', mission)) }
    if (strict !== undefined && mission.coverageNotice !== undefined) { delete mission.coverageNotice; this.commit(missionId, () => this.store.put('missions', mission)) }
    const relaxed = isStalled ? this.completionError(mission, { cancelUnschedulable: true }) : strict
    if (strict !== undefined && !(isStalled && relaxed === undefined)) {
      // The owner needs the gap that would remain after cancelling dead leftovers, not the leftovers themselves.
      if (isStalled) this.notifyStall(mission, relaxed ?? strict)
      return false
    }
    // R10-14: coverage complete, no stall, mission still active. An owner-assembled
    // mission may still be extending its plan, so it does not auto-complete — but
    // it must not be silent either. One durable owner-decision notice per board state.
    if (!automatic && !isStalled) { this.notifyCoverageComplete(mission); return false }
    this.control({ sessionId: mission.ownerSessionId }, missionId, 'complete', isStalled
      ? 'Automatically completed: every acceptance criterion was independently covered and the remaining tasks could no longer be scheduled'
      : 'Automatically completed after independent verification satisfied all mission acceptance criteria')
    this.commit(missionId, () => {
      this.store.event(missionId, 'automatic/completed', 'runtime', {})
      // R15-A1: the completion notice names every accepted deliverable (the
      // mission's lineage roots), so the final decision is attributable too.
      this.notify(missionId, `Completed ${mission.title}: all required deliverables were independently accepted. Review the evidence and final artifact in Agent Swarm.`, this.interpretation(missionId).subjectsOf(this.interpretation(missionId).tasks.filter(task => task.status === 'accepted')))
    })
    return true
  }
  
  
  
  
  
  /** Primary-agent resource decisions change ceilings without resetting consumed work. */
  updateBudget(actor: Actor, missionId: string, input: Budget, reason?: string): Budget {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    const { mission, owner } = this.participant(actor, missionId)
    if (!owner || this.isWorkerSession(actor.sessionId)) throw new Error('Only the primary user session may update a mission budget')
    if (terminal(mission)) throw new Error('Mission is terminal; its budget cannot be changed')
    if (mission.status === 'staged') throw new Error('Use the saved plan to set the budget before launch')
    if (reason !== undefined) this.bounded(reason)
    const budget = validatedBudget(input)
    const tasks = this.store.list('tasks', missionId)
    const admitted = { maxTokens: mission.usedTokens, maxSteps: mission.usedSteps,
      maxWorkers: this.store.list('members', missionId).length, maxTasks: Math.max(tasks.length, this.store.list('workstreams', missionId).length),
      maxExperiments: tasks.filter(task => task.experiment).length }
    for (const key of ['maxTokens', 'maxSteps', 'maxWorkers', 'maxTasks', 'maxExperiments'] as const) {
      if (budget[key] < admitted[key]) throw new Error(`${key} cannot be below existing consumption or admitted work (${admitted[key]})`)
    }
    const deadline = mission.createdAt + budget.maxDurationMs
    if (!Number.isSafeInteger(deadline)) throw new Error('Mission duration exceeds the supported clock range')
    if (mission.status === 'active' && deadline <= Date.now()) throw new Error('An active mission needs a duration deadline in the future')
    const previous = mission.budget
    mission.budget = budget; mission.deadline = deadline; mission.updatedAt = Date.now(); delete mission.budgetWarned
    this.commit(missionId, () => {
      this.store.put('missions', mission)
      this.syncStarts(mission)
      this.store.event(missionId, 'mission/budget-updated', 'owner', { previous, budget, usedTokens: mission.usedTokens, usedSteps: mission.usedSteps, deadline, ...(reason === undefined ? {} : { reason }) })
    })
    if (mission.status === 'active') this.kick(missionId)
    return { ...budget }
  }
  /** Owner control does not depend on an agent's willingness to follow a message. */
  control(actor: Actor, missionId: string, action: 'pause' | 'resume' | 'stop' | 'complete' | 'coordinator', reason: string, coordinatorId?: string): Mission {
    const { mission, owner } = this.participant(actor, missionId)
    if (!owner) throw new Error('Only the user session controls mission lifecycle and coordinator appointment')
    this.bounded(reason)
    if (terminal(mission)) throw new Error('Mission is terminal; create a new mission to continue')
    if (mission.status === 'staged' && action !== 'stop') throw new Error('Use the saved plan launch action to activate staged work')
    if (action === 'coordinator') {
      if (!coordinatorId || !this.store.list('members', missionId).some(m => m.id === coordinatorId && memberPhaseOf(m) !== 'stopped')) throw new Error('Unknown coordinator')
      mission.coordinatorId = coordinatorId
    } else if (action === 'complete') {
      // The owner decides; verified coverage and the deliverable are still required.
      const error = this.completionError(mission, { cancelUnschedulable: true })
      if (error) throw new Error(error)
      mission.status = 'completed'
    } else if (action === 'resume') {
      if (mission.usedSteps >= mission.budget.maxSteps || mission.usedTokens >= mission.budget.maxTokens || Date.now() >= mission.deadline) throw new Error('Mission budget exhausted; it cannot be resumed with a fresh allowance')
      mission.status = 'active'
    } else mission.status = action === 'pause' ? 'paused' : 'stopped'
    mission.reason = reason; mission.updatedAt = Date.now()
    this.commit(missionId, () => {
      this.store.put('missions', mission)
      this.syncStarts(mission)
      if (action === 'complete') for (const task of this.unschedulable(mission, this.store.list('tasks', missionId), this.store.list('members', missionId))) {
        task.status = 'cancelled'; task.epoch++; this.dropAttempt(task); delete task.resumeAfterStop; delete task.budgetResume
        task.output = `${task.output ?? ''}\nCancelled at completion: this task could no longer be scheduled and every acceptance criterion was independently covered.`.trim()
        this.store.put('tasks', task)
        this.store.event(missionId, 'task/cancelled-at-completion', 'owner', { taskId: task.id, reason })
      }
      if (action === 'pause' || action === 'stop') for (const task of this.store.list('tasks', missionId)) {
        if (task.status !== 'running' && !(task.status === 'blocked' && task.resumeAfterStop?.epoch === task.epoch)) continue
        task.status = action === 'pause' ? 'pending' : 'cancelled'; task.epoch++; this.dropAttempt(task)
        delete task.resumeAfterStop
        delete task.budgetResume
        task.handoff = `${task.handoff ?? ''}\nMission ${action}: ${reason}. Inspect prior workspace/evidence before repeating effects.`
        this.store.put('tasks', task)
      }
      if (terminal(mission) && mission.budgetPause) { delete mission.budgetPause; this.store.put('missions', mission) }
      if (mission.status !== 'active') for (const member of this.store.list('members', missionId)) { delete member.activity; this.store.put('members', member) }
      this.store.event(missionId, `mission/${action}`, 'owner', { reason, coordinatorId: coordinatorId ?? null })
      // No-silent-state row 16: pausing is a durable owner decision. Record the
      // witness for the paused fingerprint so the transition is machine-checkable
      // without waking the owner with a notice about its own action.
      if (action === 'pause') {
        mission.witness = { fingerprint: this.fingerprint(missionId), kind: 'W2', at: Date.now() }
        this.store.put('missions', mission)
      }
    })
    if (mission.status !== 'active') this.defer(async () => {
      await Promise.all(this.store.list('members', missionId).map(async member => {
        await this.workers.stop(member.id)
        if (this.closed || !terminal(this.mission(missionId))) return
        const current = this.store.get('members', member.id)
        if (!current || memberPhaseOf(current) === 'stopped') return
        current.phase = 'stopped'
        this.commit(missionId, () => {
          this.store.put('members', current)
          this.store.event(missionId, 'member/stopped', 'runtime', { memberId: current.id })
        })
      }))
    })
    else this.kick(missionId)
    return mission
  }
  private guard(memberId: string, tool: string): string | undefined {
    if (this.shuttingDown) return 'Swarm runtime is shutting down'
    const member = this.store.get('members', memberId)
    if (!member || memberPhaseOf(member) === 'stopped') return 'Worker membership is inactive'
    const mission = this.mission(member.missionId)
    if (mission.status !== 'active' || Date.now() >= mission.deadline || mission.usedSteps > mission.budget.maxSteps || mission.usedTokens >= mission.budget.maxTokens) return 'Mission is inactive or out of budget'
    if (mission.budgetPause) return 'Budget pause is waiting for worker quiescence and a fresh resume assignment'
    if (/subagent|spawn_agent|agent_teams|cordis|plugin|workflow|ralph/.test(tool) || ['send_message', 'interrupt_agent', ...OWNER_ONLY_TOOLS].includes(tool)) return 'Use the swarm work board; alternate delegation and runtime modification bypass mission authority'
    const active = this.store.list('tasks', member.missionId).find(t => t.status === 'running' && t.attempt?.ownerId === memberId)
    // W7: a denied worker-side git write is surfaced once as a typed, actionable
    // error; the workspace is still publishable through swarm_submit.
    if (active?.gitWriteDenied !== undefined && !tool.startsWith('swarm_')) return gitWriteDeniedMessage(active.gitWriteDenied.command)
    if (active && !active.dependencies.every(dep => this.dependencySatisfied(member.missionId, dep))) return 'A prerequisite was invalidated; stop work and inspect the challenge'
    if (active?.reviewOf && this.task(member.missionId, active.reviewOf).status !== 'submitted') return 'The reviewed source is no longer submitted; await a fresh review assignment'
    if (active?.attempt && active.attempt.leaseUntil < Date.now()) return 'Task lease expired; await reassignment'
    if (!active && !tool.startsWith('swarm_')) return 'Claim an assigned task before executing workspace tools'
    return undefined
  }
  private async beforeStep(memberId: string, hasFreshInput = false): Promise<void | false> {
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    const member = this.store.get('members', memberId)
    if (!member) throw new Error('Unknown worker')
    const mission = this.mission(member.missionId)
    if (mission.status !== 'active') throw new Error(`Mission is ${mission.status}`)
    if (mission.budgetPause) return false
    if (memberPhaseOf(member) === 'parked' && !hasFreshInput) return false
    // D1: a task that exhausted its own step/finding ceiling blocks itself before
    // the next step is charged, so the mission budget is never drained by it.
    const activeTask = this.store.list('tasks', mission.id).find(task => task.status === 'running' && task.attempt?.ownerId === memberId)
    if (activeTask !== undefined) {
      const ceiling = taskCeilingBlock(activeTask)
      if (ceiling !== undefined) { this.blockTaskCeiling(mission, activeTask, ceiling); return false }
    }
    // Requests still streaming for other workers will settle against the same pool.
    if (mission.usedSteps >= mission.budget.maxSteps || mission.usedTokens + this.inFlightEstimate(this.store.list('members', mission.id).filter(item => item.id !== memberId)) >= mission.budget.maxTokens || Date.now() >= mission.deadline) {
      this.blockBudget(mission); throw new Error('Mission aggregate budget exhausted')
    }
    mission.usedSteps++; mission.updatedAt = Date.now()
    this.commit(mission.id, () => {
      // R17-G7: fresh input unparks the member; the derived status follows the attempt.
      if (memberPhaseOf(member) === 'parked') { member.phase = 'active'; this.store.put('members', member) }
      this.store.put('missions', mission)
      for (const task of this.store.list('tasks', mission.id)) if (task.status === 'running' && task.attempt?.ownerId === memberId) {
        task.usedSteps = (task.usedSteps ?? 0) + 1
        task.attempt.leaseUntil = Math.min(mission.deadline, Date.now() + this.config.leaseMs); this.store.put('tasks', task)
      }
    })
    this.warnBudget(mission)
  }
  /**
   * Durable per-task ceiling block. The task stops at its own limit, the owning
   * member is parked (a new assignment supplies fresh input and unparks it) and
   * the owner is told to repair or re-plan. Callers block before charging a
   * mission step, so the blocked task never consumes the mission budget.
   */
  private blockTaskCeiling(mission: Mission, task: Task, ceiling: TaskCeiling): void {
    const ownerId = task.attempt?.ownerId
    const member = ownerId === undefined ? undefined : this.store.get('members', ownerId)
    task.status = 'blocked'
    task.ceiling = ceiling
    task.epoch++
    this.dropAttempt(task); delete task.resumeAfterStop; delete task.budgetResume; delete task.closeout; delete task.idleSignal; delete task.gitWriteDenied
    task.output = `${task.output ?? ''}\n${ceiling.reason}`.trim()
    if (member !== undefined && memberPhaseOf(member) !== 'stopped') { member.phase = 'parked'; delete member.activity }
    this.commit(mission.id, () => {
      this.store.put('tasks', task)
      if (member !== undefined) this.store.put('members', member)
      this.store.event(mission.id, 'task/ceiling-exhausted', 'runtime', { taskId: task.id, dimension: ceiling.dimension, limit: ceiling.limit, used: ceiling.used, code: ceiling.code })
    })
    // S4b: the durable event carried the code, the owner notice did not. The
    // shared coded terminal names the task, the dimension and the exits.
    emitGuardTerminal(this, mission.id, 'task_ceiling', { taskId: task.id, ...(ownerId === undefined ? {} : { memberId: ownerId }), detail: `${task.title} (${task.id}) exhausted its own ${ceiling.dimension} ceiling (${ceiling.used}/${ceiling.limit}) and blocked` })
    this.kick(mission.id)
  }
  
  
  
  
  
  
  
  
  private onActivity(memberId: string, activity?: WorkerActivity): void {
    if (this.closed || this.shuttingDown) return
    const member = this.store.get('members', memberId)
    if (!member) return
    const mission = this.mission(member.missionId)
    if (mission.status !== 'active' || memberPhaseOf(member) === 'stopped' || mission.budgetPause || Date.now() >= mission.deadline) activity = undefined
    const previous = member.activity
    if (activity !== undefined) {
      const task = this.store.list('tasks', mission.id).find(task => task.status === 'running' && task.attempt?.ownerId === memberId)
      // One operation keeps the attempt it started under even if a later assignment races its end.
      const attemptId = member.activity?.id === activity.id ? member.activity.attemptId : task?.attempt?.id
      member.activity = { ...activity, attemptId }
    } else {
      if (member.activity === undefined) return
      delete member.activity
    }
    this.commit(mission.id, () => {
      this.store.put('members', member)
      // Native stream touches advance the state revision without displacing coordination milestones.
      if (previous?.id !== member.activity?.id || previous?.kind !== member.activity?.kind || previous?.attemptId !== member.activity?.attemptId) {
        this.store.event(mission.id, 'member/activity', 'runtime', { memberId, activity: member.activity ?? null })
      }
    })
  }
  

  
  private async recordToolRun(memberId: string, input: Omit<ToolRun, 'id' | 'seq' | 'missionId' | 'memberId' | 'taskId' | 'attemptId' | 'createdAt'>): Promise<string | undefined> {
    if (this.closed || input.tool.startsWith('swarm_')) return undefined
    const member = this.store.get('members', memberId)
    if (!member) return undefined
    const task = this.store.list('tasks', member.missionId).find(t => t.status === 'running' && t.attempt?.ownerId === memberId)
    if (!task?.attempt) return undefined
    const run: ToolRunWithEnvironment = { ...input, id: id('run'), missionId: member.missionId, memberId, taskId: task.id, attemptId: task.attempt.id, createdAt: Date.now() }
    // ENV-R: the environment this execution ran under. The command text is the
    // durable evidence of what the command gives itself (`HOME=… cmd`,
    // `export …`, `env -i`, `unset …`), so the row records THAT environment, not
    // the host-ambient sample a command that overrode HOME never ran with.
    const ambient = this.declaredCheckEnvelope()?.selfRunEnvironment
    if (ambient !== undefined) {
      const source = selfRunEnvironmentSource(recordedCommand(input.arguments))
      run.checkEnvironment = selfRunEnvironmentFacts(ambient, source)
      // Provenance: a reader can tell a command-derived environment from the
      // ambient fallback without re-parsing the command text.
      if (source.cleared || source.operations.length > 0) run.checkEnvironmentSource = { from: 'command', ...source }
    }
    // F8: a recorded run may extend the attempt lease, but a stored lease must
    // never outlive the mission deadline (the same clamp every other renewal uses).
    task.attempt.leaseUntil = Math.min(this.mission(member.missionId).deadline, Date.now() + this.config.leaseMs)
    const denied = this.deniedGitWrite(input)
    const firstDenial = denied !== undefined && task.gitWriteDenied === undefined
    if (firstDenial) task.gitWriteDenied = { command: denied, runId: run.id, at: Date.now() }
    // R11-15: a shared-temp rendezvous is decided before the transaction and
    // recorded atomically with the run.
    const rendezvous = this.tempRendezvous(memberId, task.id, input)
    this.commit(member.missionId, () => {
      run.seq = this.store.countToolRuns(member.missionId) + 1
      this.store.put('tool_runs', run); this.store.put('tasks', task)
      this.store.event(member.missionId, 'tool/recorded', memberId, { runId: run.id, seq: run.seq, taskId: task.id, tool: run.tool, isError: run.isError })
      if (rendezvous !== undefined) {
        this.store.event(member.missionId, 'isolation/temp-rendezvous', 'runtime', {
          path: rendezvous.path, firstMemberId: rendezvous.first.memberId, firstTaskId: rendezvous.first.taskId, firstAt: rendezvous.first.at,
          secondMemberId: rendezvous.second.memberId, secondTaskId: rendezvous.second.taskId, secondAt: rendezvous.second.at,
          windowMs: TEMP_RENDEZVOUS_WINDOW_MS, detection: 'command-mention',
        })
        this.notify(member.missionId, `Two members named the same shared temp path ${rendezvous.path} inside ${Math.round(TEMP_RENDEZVOUS_WINDOW_MS / 60_000)} minute(s): ${rendezvous.first.memberId} then ${rendezvous.second.memberId}. The host temp roots are writable by every workspace-write execution; never use them to pass state between members or missions.`,
          tempRendezvousSubjects(this, member.missionId, rendezvous), { from: memberId })
      }
      if (!firstDenial) return
      // Durable audit plus a typed delivery, so the worker learns the supported
      // exit even if its next tool is allowed before the guard denies one.
      this.store.event(member.missionId, 'task/git-write-denied', memberId, { taskId: task.id, attemptId: task.attempt!.id, command: denied, runId: run.id })
      this.store.put('deliveries', { id: id('msg'), missionId: member.missionId, from: 'runtime', to: memberId, kind: 'control', content: gitWriteDeniedMessage(denied!), createdAt: Date.now() })
    })
    return run.id
  }
  /**
   * R11-01: record one classified provider outage inside the caller's
   * transaction. The durable row is bounded to one per member and class per
   * window; the owner notice fires on a class transition. The affected attempt
   * is preserved (the adapter retries it in place), so nothing here re-pends or
   * charges recovery credit.
   */
  private recordProviderOutage(member: Member, outage: ProviderOutage): void {
    const previous = member.providerOutage
    const duplicate = previous !== undefined && previous.class === outage.class && Date.now() - previous.at < PROVIDER_OUTAGE_EVENT_WINDOW_MS
    member.providerOutage = { ...outage, at: Date.now() }
    this.store.put('members', member)
    if (duplicate) return
    // R17-G1: the member's open work comes from the shared interpretation.
    const view = this.interpretation(member.missionId)
    const open = view.tasks.filter(task => task.status === 'running' && task.attempt?.ownerId === member.id)
    this.store.event(member.missionId, 'provider/outage', 'runtime', { memberId: member.id, class: outage.class, status: outage.status, message: outage.message, taskIds: open.map(task => task.id) })
    // One owner notice per class transition, never one per retry.
    if (previous?.class !== outage.class) {
      // R15-A1/A4: a member-scoped notice names that member's open work: the
      // subject is the task whose clock the outage holds, never the whole board.
      // The mission root is the fallback only when the member owns no open task.
      this.notify(member.missionId,
        `${member.name} provider ${outage.class} outage${outage.status === undefined ? '' : ` (HTTP ${outage.status})`}: ${outage.message}. Its attempt is preserved and no recovery credit is spent while the route is quiescent.`,
        open.length ? view.subjectsOf(open) : [missionSubject(view.mission)], { from: member.id })
    }
  }
  /** R11-01: the member's route is quiescent only inside the outage window. */
  private providerQuiescent(member: Member): ProviderOutage | undefined {
    const outage = member.providerOutage
    return outage !== undefined && Date.now() - outage.at <= PROVIDER_OUTAGE_WINDOW_MS ? outage : undefined
  }
  /** R11-01: a successful start or operation proves the route recovered. */
  clearProviderOutage(missionId: string, memberId: string): void {
    const member = this.store.get('members', memberId)
    if (member === undefined) return
    // S5c: a successful start also clears the durable consecutive-failure count
    // (the same event that proves the route recovered proves the failures
    // stopped). `startFailures` stays as the in-process mirror only.
    const fields = startFailureFields(member)
    const outage = member.providerOutage
    const failures = fields.startFailures
    if (outage === undefined && failures === undefined) return
    delete member.providerOutage
    delete fields.startFailures
    this.commit(missionId, () => {
      this.store.put('members', member)
      if (outage !== undefined) this.store.event(missionId, 'provider/recovered', 'runtime', { memberId })
    })
  }
  private onProviderOutage(memberId: string, outage: ProviderOutage): void {
    if (this.closed || this.shuttingDown) return
    const member = this.store.get('members', memberId)
    if (member === undefined) return
    const mission = this.store.get('missions', member.missionId)
    if (mission === undefined || terminal(mission)) return
    this.commit(member.missionId, () => this.recordProviderOutage(member, outage))
  }
  private onFailure(memberId: string, error: string): void {
    if (this.closed || this.shuttingDown) return
    const member = this.store.get('members', memberId)
    if (!member) return
    // W8: a rejected reasoning effort also surfaces asynchronously on the first
    // worker request. Keep the durable event shape, but wake the owner with the
    // supported exit instead of the raw provider text.
    const rejection = unsupportedEffort(error)
    const message = rejection !== undefined && member.reasoningEffort !== undefined
      ? `${member.name} cannot run: ${rejection.message}. Its route is fixed for this session; admit a replacement member without reasoningEffort (or with an effort this provider/model supports) and reassign its work.`
      : `${member.name} failed: ${error}`
    this.commit(member.missionId, () => {
      this.store.event(member.missionId, 'member/failure', memberId, { error })
      // R15-A1: a member failure with no assigned task still names the member's
      // unfinished work; the mission root is the fallback, never silence.
      this.notify(member.missionId, message, this.noticeSubjectsFor(member.missionId, { memberId: member.id }))
    })
  }
  /**
   * R5-02: a `workers.start` failure is a recoverable interruption, not a
   * permanent block of the member's work. Mirror the preparation, lease-expiry
   * and close-out policy: spend exactly one recovery credit per affected task
   * and re-pend while its limit is not exhausted (blocking only at the limit,
   * with the reason in `task.output`). The same member is retried for
   * `START_FAILURE_REROUTE_LIMIT` consecutive failures so a transient start
   * error self-heals; at the limit the route is retired and its work re-routed
   * to another capable live member with a durable `task/reassigned` event. A
   * successful start clears the member's consecutive failure counter.
   */
  onStartFailure(mission: Mission, member: Member, error: unknown): void {
    if (this.closed || this.shuttingDown) return
    const missionId = mission.id
    const current = this.store.get('missions', missionId)
    if (current === undefined || current.status !== 'active') return
    // R11-01: classify at the boundary. A provider outage (quota, rate limit,
    // provider unavailable) is a quiescent route, not this member's failure:
    // it spends no recovery credit, does not count toward retiring the route,
    // and the work moves to another capable live member when one exists.
    const outage = classifyProviderOutage(error) ?? this.providerQuiescent(member)
    const reason = outage !== undefined ? `Provider ${outage.class} outage: ${outage.message}` : `Worker could not start: ${String(error)}`
    // S5c: the count is read from the durable member row (the map is the mirror),
    // so losing the map — or restarting the runtime — continues the count instead
    // of resetting the route's budget.
    const durable = this.store.get('members', member.id) ?? member
    const consecutiveFailures = (startFailureFields(durable).startFailures ?? this.startFailures.get(member.id) ?? 0) + 1
    if (outage === undefined) {
      startFailureFields(member).startFailures = consecutiveFailures
      this.startFailures.set(member.id, consecutiveFailures)
    }
    const reroute = outage === undefined && consecutiveFailures >= START_FAILURE_REROUTE_LIMIT
    // Below the limit the member stays live so the next tick retries the same
    // route; at the limit it is retired exactly like a dead session. A quiescent
    // route is always kept live: the provider may recover on the next tick.
    member.phase = reroute ? 'stopped' : 'active'
    this.commit(missionId, () => {
      if (outage === undefined) this.store.put('members', member)
      else this.recordProviderOutage(member, outage)
      for (const task of this.store.list('tasks', missionId)) {
        if (task.assigneeId !== member.id || !['pending', 'running'].includes(task.status)) continue
        if (outage === undefined) task.recoveryCount = (task.recoveryCount ?? 0) + 1
        task.output = reason
        task.epoch++
        this.dropAttempt(task); delete task.closeout; delete task.idleSignal; delete task.gitWriteDenied
        const pinned = task.assigneeId
        delete task.assigneeId
        task.status = 'pending'
        const limit = task.maxRecoveryAttempts ?? this.config.maxTasksPerMember
        const target = outage !== undefined || reroute ? this.rerouteTarget(missionId, task, member.id) : undefined
        // Re-route wins over the credit limit: the obligation moves to another
        // live route instead of blocking, and the credit spent so far travels
        // with the task so the new owner still has a bounded budget.
        if (target !== undefined) task.assigneeId = target.id
        // No capable target: keep the same live route below the limit, and
        // release the work to any live member once the route is retired.
        else if (!reroute) task.assigneeId = pinned
        const exhausted = outage === undefined && target === undefined && (task.recoveryCount ?? 0) >= limit
        task.status = exhausted ? 'blocked' : 'pending'
        this.store.put('tasks', task)
        this.store.event(missionId, 'task/start-failed', 'runtime', { taskId: task.id, epoch: task.epoch, reason, recoveryCount: task.recoveryCount ?? 0, maxRecoveryAttempts: limit, status: task.status, consecutiveFailures, quiescent: outage !== undefined })
        if (target !== undefined) {
          this.store.event(missionId, 'task/reassigned', 'runtime', { taskId: task.id, from: member.id, to: target.id, reason, consecutiveFailures })
          continue
        }
        if (!exhausted) continue
        this.store.event(missionId, 'task/blocked', 'runtime', { taskId: task.id, reason })
        this.notify(missionId, `${reason} (${task.id} exhausted its recovery limit of ${limit})`, this.interpretation(missionId).subjectsOf([task]))
      }
      this.store.event(missionId, 'member/resume-failed', 'runtime', { memberId: member.id, error: String(error), consecutiveFailures, rerouted: reroute, ...(outage === undefined ? {} : { outage: outage.class }) })
      // The outage notice is emitted by `recordProviderOutage`; do not claim a
      // recovery credit that was never spent.
      if (outage !== undefined) return
      this.notify(missionId, reroute
        ? `${member.name} could not start after ${consecutiveFailures} consecutive failures; its work was re-routed to a live member.`
        : `${member.name} could not start (failure ${consecutiveFailures} of ${START_FAILURE_REROUTE_LIMIT}); its work was re-pended with one recovery credit.`,
        this.noticeSubjectsFor(missionId, { memberId: member.id }))
    })
  }
  defer(fn: () => Promise<void>): void {
    if (this.shuttingDown) return
    const operation = new Promise<void>(resolve => setImmediate(resolve)).then(fn)
    this.operations.add(operation)
    void operation.catch(error => { if (!this.closed) process.stderr.write(`[agent-swarm] ${String(error)}\n`) }).finally(() => this.operations.delete(operation))
  }
  
  
  
  /**
   * S1: the declared no-progress window, as an integer number of passes
   * (default 3, i.e. 3 × `tickMs`). Configuration, never a constant.
   */
  get stallPasses(): number {
    const value = Math.trunc(this.config.stallPasses ?? DEFAULT_STALL_PASSES)
    return Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_STALL_PASSES
  }
  /**
   * S1: the declared bound on one scheduling pass (default 30 × `tickMs`). A
   * pass still running past this bound has produced no durable change for the
   * whole window; the watchdog escalates it and releases the guard.
   */
  get stallPassTimeoutMs(): number {
    const value = Math.trunc(this.config.stallPassTimeoutMs ?? this.config.tickMs * DEFAULT_STALL_PASS_TIMEOUT_TICKS)
    return Number.isSafeInteger(value) && value >= this.config.tickMs ? value : this.config.tickMs
  }
  /**
   * R16-D: the declared window a wedged pass may still hold the mission guard
   * while the mission has live work (default: the pass bound itself, read as
   * `stallPassTimeoutMs`; `stallPassLiveGraceMs: 0` releases at the first bound).
   * Structural read: `RuntimeConfig` (src/types.ts) and the plugin `Config`
   * schema (src/index.ts) are outside this task's write scope, so the two schema
   * lines are a recorded hand-off — a runtime handed `stallPassLiveGraceMs` uses
   * it, one without it uses the default.
   */
  get stallPassLiveGraceMs(): number {
    const raw = (this.config as { stallPassLiveGraceMs?: unknown }).stallPassLiveGraceMs
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw)
    return this.stallPassTimeoutMs * DEFAULT_STALL_PASS_LIVE_GRACE_TICKS
  }
  /**
   * R16-D: the total bound a wedged pass is measured against once it has live
   * work to progress. Past it the pass is released even though the live work
   * remains — the work is preserved and named, the guard is not held hostage.
   */
  get stallPassReleaseBoundMs(): number { return this.stallPassTimeoutMs + this.stallPassLiveGraceMs }
  /**
   * R16-D: the declared bound on an attempt's durable progress (see
   * `DEFAULT_ATTEMPT_SILENCE_BOUND_MS`). Structural read with the same hand-off
   * as `stallPassLiveGraceMs`.
   */
  get attemptSilenceBoundMs(): number {
    const raw = (this.config as { attemptSilenceBoundMs?: unknown }).attemptSilenceBoundMs
    if (raw === 0) return 0
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_ATTEMPT_SILENCE_BOUND_MS
  }
  /**
   * R16-D: the round's silence projection, read from the durable store alone
   * (src/scheduling.ts#silenceReport). Read-only and ungated: it is the
   * instrument the round's outcome report quotes, not an owner decision channel.
   */
  silenceReport(missionId: string): ReturnType<Scheduling['silenceReport']> { return this.scheduling.silenceReport(missionId) }
  /**
   * R16-D: the durable reporting bound verdict for the live attempt on one task
   * (`taskId@epoch` + member), or undefined when the attempt is inside its bound
   * or another guard owns it (F1's operation, the W6 idle close-out, a parked
   * member, a budget pause). Exposed for the pair tests and the owner read path;
   * the sweep that acts on it is `sweepDecisions`.
   */
  silentAttempt(task: Task, mission: Mission): ReturnType<Scheduling['silentAttempt']> { return this.scheduling.silentAttempt(task, mission) }
  /** R16-D: the bounded sweep behind the escalation; returns how many attempts it named. */
  sweepSilentAttempts(missionId: string): number { return this.scheduling.sweepSilentAttempts(missionId) }
  
  
  
  
  
  
  /** Two declared scopes overlap when either is `**`, equal, or one contains the other. */
  scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
    return left.some(a => right.some(b => scopeKeysOverlap(a, b)))
  }
  
  /**
   * A durable refusal, not a silent skip: the invariant is named, the offending
   * member and worktree are recorded, and the owner is told the executable exit
   * (each live member needs its own isolated worktree). Dedup is per distinct
   * violation so a corrupted board does not wake the owner every tick.
   */
  refuseIsolation(missionId: string, member: Member, violation: string): void {
    const mission = this.store.get('missions', missionId)
    if (mission === undefined || terminal(mission)) return
    const key = `${member.id}:${violation}`
    if (mission.isolationRefusal === key) return
    mission.isolationRefusal = key
    mission.updatedAt = Date.now()
    this.commit(missionId, () => {
      // The refusal is durable twice over: the mission row keeps the exact
      // violation (so it is re-derivable and clears only when repaired) and the
      // owner notice is a durable delivery with the executable exit.
      this.store.put('missions', mission)
    })
    // S4b: the isolation refusal is the workspace chain's terminal for this
    // dispatch. The violation is preserved verbatim as the detail and the owner
    // gets the shared coded decision request instead of prose.
    emitGuardTerminal(this, missionId, 'workspace', { memberId: member.id, detail: `isolation invariant refused a dispatch to ${member.name} (${member.id}): ${violation}` })
  }
  
  
  
  
  
  kick(missionId: string): void {
    if (this.shuttingDown || this.closed) return
    const pass = this.openPass(missionId)
    if (pass === undefined) return
    this.defer(async () => {
      try { await this.exclusive(missionId, () => this.schedule(missionId, pass)) }
      finally {
        this.closePass(missionId, pass)
        const mission = this.closed ? undefined : this.store.get('missions', missionId)
        if (mission?.status === 'active' && mission.budgetPause?.quiesced) this.kick(missionId)
      }
    })
  }
  private async ensureWorkers(mission: Mission): Promise<void> {
    for (const member of this.store.list('members', mission.id)) {
      if (this.shuttingDown) return
      if (memberPhaseOf(member) === 'stopped') continue
      // R5-02: a failed resume is recovered by the same policy as the scheduler
      // start path; a successful start clears the consecutive failure counter.
      try { await this.workers.start({ mission, member, ownerSessionId: mission.ownerSessionId }); this.startFailures.delete(member.id); this.clearProviderOutage(mission.id, member.id) }
      catch (error) { this.onStartFailure(mission, member, error) }
    }
  }
  private async schedule(missionId: string, pass?: SchedulingPass): Promise<void> {
    if (this.shuttingDown) return
    const mission = this.mission(missionId)
    if (mission.status !== 'active') { await this.flushOutbox(missionId); return }
    if (mission.budgetPause) {
      if (!mission.budgetPause.quiesced) {
        this.beginBudgetStop(missionId, mission.budgetPause.id)
        await this.flushOutbox(missionId); return
      }
      this.resumeBudgetTasks(mission)
    }
    if (this.completeAutomatic(missionId)) { await this.flushOutbox(missionId); return }
    if (Date.now() >= mission.deadline || mission.usedTokens >= mission.budget.maxTokens || mission.usedSteps >= mission.budget.maxSteps) { this.blockBudget(mission); return }
    // F2: a submitted code deliverable no live review can accept is repaired
    // before dispatch, so the auto-admitted review can be scheduled this tick.
    this.admitMissingReviews(this.mission(missionId))
    // S1 (P0): the lease-expiry sweep is src/attempts.ts#recoverExpired, in the
    // same order as before; it iterates ids and re-reads each row inside the loop,
    // so a row committed during its awaits is never written back over.
    if (!await this.attempts.recoverExpired(mission, missionId)) return
    // M1a seam 7/7: the dispatch sweep is src/scheduling.ts#dispatch, in the same
    // order as before; a false result abandons the pass where the loop's early
    // returns did.
    if (!await this.scheduling.dispatch(mission, missionId, pass)) return
    // Backstop: a full pass that dispatched nothing must still witness the state.
    this.ensureWitness(missionId)
    // S2: the pass flushes its own outbox (bounded per delivery), and the
    // queue-external tick pump is the backstop that delivers durable notices
    // while this pass is wedged or the mission lock is held.
    await this.flushOutbox(missionId)
  }
  
  
  /** Drain all runtime operations and worker handles before releasing database ownership. */
  async dispose(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.timer) clearInterval(this.timer)
    for (const controller of this.startControllers.values()) controller.abort(new Error('Swarm runtime is shutting down'))
    let workerError: unknown
    try { await this.workers.dispose() } catch (error) { workerError = error }
    try {
      // S1: a pass body wedged in an adapter call must not make shutdown
      // unbounded. Drain within the declared pass bound; the abandoned body then
      // observes `this.closed` at its next checkpoint. The losing timer is
      // cleared, so a completed dispose leaves no handle behind — a ref'd
      // timeout here would keep a test or CLI process alive for the whole bound.
      const drain = Promise.allSettled([...this.operations, ...this.queues.values()])
      let bound: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([drain, new Promise<void>(resolve => { bound = setTimeout(resolve, this.stallPassTimeoutMs) })])
      } finally { if (bound !== undefined) clearTimeout(bound) }
    }
    finally {
      // R17-G8: and the claimed-signal subscription goes with it.
      this.notices.dispose()
      this.closed = true; this.listeners.clear(); this.store.close()
    }
    if (workerError !== undefined) throw workerError
  }
}

/**
 * R15-A1: the subjects of the temp-rendezvous warning — the two tasks whose
 * commands named the shared temp path, deduplicated in first-seen order, with the
 * mission root when a task row is already gone. A bounded linear scan instead of
 * an in-memory index, so the S5 census keeps its exact collection inventory.
 */
function tempRendezvousSubjects(rt: SwarmRuntime, missionId: string, rendezvous: { first: { taskId: string }; second: { taskId: string } }): string[] {
  const subjects: string[] = []
  for (const taskId of [rendezvous.first.taskId, rendezvous.second.taskId]) {
    if (typeof taskId !== 'string' || subjects.includes(taskId)) continue
    const task = rt.store.get('tasks', taskId)
    const subject = task === undefined ? `mission:${missionId}` : `${task.id}@${task.epoch}`
    if (!subjects.includes(subject)) subjects.push(subject)
  }
  return subjects.length ? subjects : [`mission:${missionId}`]
}
