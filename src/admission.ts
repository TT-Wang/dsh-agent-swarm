/** Shared input normalization and repair guidance; matching and authority stay strict. */
import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { scopeSubset, validScope, withinScope } from './scope.ts'
import type { TaskCeiling, TaskCeilingDimension } from './types.ts'

/** Accept equivalent notation without guessing a wider path or a repository root. */
export function normalizeScopeSelectors(scopes: readonly string[]): string[] {
  return scopes.map(selector => {
    let normalized = selector
    while (normalized.startsWith('./') && normalized.length > 2) normalized = normalized.slice(2)
    if (normalized.endsWith('/**')) normalized = normalized.slice(0, -2)
    return normalized !== '**' && validScope(normalized) ? normalized : selector
  })
}

export function assertScopeSelectors(scopes: readonly string[], location: string, parent?: readonly string[]): void {
  const invalid = scopes.findIndex(selector => !validScope(selector))
  if (invalid !== -1) throw new Error(`${location}[${invalid}] is invalid: ${JSON.stringify(scopes[invalid])}. Use literal workspace-relative file paths, directory prefixes ending in "/", or "**". Do not use absolute paths, traversal, wildcard patterns or descriptive prose. Correct this field and retry the same task/request, preserving its kind, acceptance criteria and budget; never broaden scope just to pass validation.`)
  if (parent && !scopeSubset(scopes, parent)) {
    const offending = scopes.find(selector => !scopeSubset([selector], parent))
    throw new Error(`${location} exceeds mission scope: ${JSON.stringify(offending)} is not covered by allowed mission selectors ${JSON.stringify(parent)}. Use literal workspace-relative paths or directory prefixes ending in "/", not descriptive prose. Each task selector must match or narrow a mission selector. Correct this field and retry the same task/request, preserving its kind, acceptance criteria and budget; never broaden scope just to pass validation.`)
  }
}

/** reviewOf already waits for submission; an ordinary edge would wait for acceptance. */
export function normalizeReviewDependencies(kind: string, reviewOf: string | undefined, dependencies: readonly string[] = []): string[] {
  return dependencies.filter(dependency => kind !== 'verification' || dependency !== reviewOf)
}

/** The minimal task shape a review path needs: one verification task and its source. */
export interface ReviewPathCandidate {
  id: string
  kind: string
  reviewOf?: string
  status: string
  assigneeId?: string
}

/**
 * The live independent review of one source, if any review can still reach a
 * verdict. A review is live only while it can still start: its status is live
 * (pending/running, or a quiescence-parked review the caller supplies), it does
 * not review itself, it is not assigned to the source author, and it is not
 * pinned to a retired member. A cancelled, accepted or author-assigned review is
 * not a review path, so a submitted artifact that only has one is unreviewable
 * and would otherwise sit submitted forever.
 */
export function liveReviewFor<T extends ReviewPathCandidate>(reviews: readonly T[], sourceId: string, authorId: string | undefined, liveMemberIds: ReadonlySet<string>,
  isLiveStatus: (review: T) => boolean = review => review.status === 'pending' || review.status === 'running'): T | undefined {
  return reviews.find(review => review.kind === 'verification' && review.reviewOf === sourceId && isLiveStatus(review)
    && (authorId === undefined || review.assigneeId !== authorId)
    && (review.assigneeId === undefined || liveMemberIds.has(review.assigneeId)))
}

/** Machine-checkable diagnostic for a submitted code deliverable no review can accept. */
export function missingReviewDiagnostic(taskId: string, reason: string): AdmissionDiagnostic {
  return { code: 'review_path_missing', location: `task ${JSON.stringify(taskId)}`, message: reason }
}

/**
 * A stable, machine-checkable admission diagnostic. The same code is embedded
 * in the thrown repair message, so a caller can match programmatically instead
 * of parsing prose.
 */
export interface AdmissionDiagnostic {
  code: string
  location: string
  message: string
  path?: string
}

export function formatDiagnostic(diagnostic: AdmissionDiagnostic): string {
  return `[${diagnostic.code}] ${diagnostic.location}: ${diagnostic.message}`
}

export interface TaskCeilingInput {
  maxSteps?: number
  maxFindings?: number
}

/**
 * Bounded defaults so every admitted task carries its own ceiling even when the
 * plan omits one. A real implementation or integration task routinely spends
 * tens of model steps and dozens of findings, so the defaults must bound a
 * runaway task without blocking honest work: 150 steps is roughly four times a
 * typical task in this repository's own rounds, while still stopping a task long
 * before it can drain a multi-thousand-step mission budget. The step default is
 * additionally capped by the mission budget below. Round 5 adds a per-task
 * override on the proposal tools; until then an explicit value in a plan or
 * proposal still wins.
 */
export const DEFAULT_TASK_MAX_STEPS = 150
export const DEFAULT_TASK_MAX_FINDINGS = 50

function assertCeilingValue(value: number, location: string, dimension: TaskCeilingDimension): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`[task_ceiling_invalid] ${location}.${dimension} must be a positive safe integer; a zero, fractional or unsafe ceiling cannot bound a task. Choose a per-task limit the runtime can enforce and retry the same task/request.`)
}

/**
 * Derive and validate one task's own step/finding ceilings. The step default is
 * bounded by the mission budget, so a plan without explicit ceilings still
 * carries per-task limits and cannot admit a task ceiling that can never bind.
 */
export function normalizeTaskCeilings(task: TaskCeilingInput, missionMaxSteps: number, location: string): { maxSteps: number; maxFindings: number } {
  const maxSteps = task.maxSteps ?? Math.max(1, Math.min(missionMaxSteps, DEFAULT_TASK_MAX_STEPS))
  const maxFindings = task.maxFindings ?? DEFAULT_TASK_MAX_FINDINGS
  assertCeilingValue(maxSteps, location, 'maxSteps')
  assertCeilingValue(maxFindings, location, 'maxFindings')
  if (maxSteps > missionMaxSteps) throw new Error(`[task_ceiling_exceeds_mission_budget] ${location}.maxSteps is ${maxSteps} but the mission maxSteps budget is ${missionMaxSteps}; a task ceiling above the mission ceiling can never bind before the mission budget does. Lower this task's maxSteps or raise the mission budget, and retry the same task/request.`)
  return { maxSteps, maxFindings }
}

export interface TaskCeilingState extends TaskCeilingInput {
  usedSteps?: number
  evidenceIds?: readonly string[]
}

/** The exhausted dimension, if the task already consumed its own ceiling. */
export function taskCeilingExhaustion(task: TaskCeilingState): { dimension: TaskCeilingDimension; limit: number; used: number } | undefined {
  if (task.maxSteps !== undefined && (task.usedSteps ?? 0) >= task.maxSteps) return { dimension: 'maxSteps', limit: task.maxSteps, used: task.usedSteps ?? 0 }
  if (task.maxFindings !== undefined && (task.evidenceIds?.length ?? 0) >= task.maxFindings) return { dimension: 'maxFindings', limit: task.maxFindings, used: task.evidenceIds?.length ?? 0 }
  return undefined
}

/**
 * The durable block record for a task that exhausted its own ceiling. The
 * runtime stores this on the task and stops the attempt, so the mission budget
 * is not spent on work that already hit its own limit.
 */
export function taskCeilingBlock(task: TaskCeilingState, now = Date.now()): TaskCeiling | undefined {
  const exhausted = taskCeilingExhaustion(task)
  if (!exhausted) return undefined
  return {
    dimension: exhausted.dimension, limit: exhausted.limit, used: exhausted.used, code: 'task_ceiling_exhausted',
    reason: `Task ceiling exhausted: ${exhausted.dimension} ${exhausted.used}/${exhausted.limit}. The task blocks at its own ceiling instead of consuming the mission budget; raise this task's ceiling or replace the task.`,
    at: now,
  }
}

const WRITE_VERBS = new Set([
  'add', 'adds', 'added', 'adding', 'append', 'appends', 'appended', 'appending',
  'commit', 'commits', 'committed', 'committing', 'create', 'creates', 'created', 'creating',
  'delete', 'deletes', 'deleted', 'deleting', 'deliver', 'delivers', 'delivered', 'delivering',
  'document', 'documents', 'documented', 'documenting', 'edit', 'edits', 'edited', 'editing',
  'emit', 'emits', 'emitted', 'emitting', 'generate', 'generates', 'generated', 'generating',
  'implement', 'implements', 'implemented', 'implementing', 'introduce', 'introduces', 'introduced', 'introducing',
  'modify', 'modifies', 'modified', 'modifying', 'move', 'moves', 'moved', 'moving',
  'place', 'places', 'placed', 'placing', 'produce', 'produces', 'produced', 'producing',
  'publish', 'publishes', 'published', 'publishing', 'record', 'records', 'recorded', 'recording',
  'remove', 'removes', 'removed', 'removing', 'rename', 'renames', 'renamed', 'renaming',
  'save', 'saves', 'saved', 'saving', 'ship', 'ships', 'shipped', 'shipping',
  'store', 'stores', 'stored', 'storing', 'update', 'updates', 'updated', 'updating',
  'write', 'writes', 'wrote', 'written', 'writing',
])
const WRITE_VERB_PATTERN = new RegExp(`\\b(?:${[...WRITE_VERBS].sort((a, b) => b.length - a.length).join('|')})\\b`, 'gi')
const NEGATION_PATTERN = /\b(?:not|never|no|without|avoid|cannot|can't|don't|doesn't|didn't|mustn't|won't|isn't|aren't|shouldn't|wouldn't|couldn't)\b/i
const DIRECTIVE_CUE = /\b(?:must|shall|should|will|need(?:s|ed)?\s+to|required\s+to|requires|required|tasked\s+(?:to|with)|responsible\s+for|expected\s+to|ensure|make\s+sure|please|to)\b/i
const CLAUSE_SPLIT = /(?:[.;!?]\s+|\n+)/

/** A conservative path token: a file with an extension, or a directory prefix ending in "/". */
export function looksLikePath(token: string): boolean {
  if (token.length < 3 || token.length > 240) return false
  if (token.startsWith('-') || token.startsWith('/') || token.includes('*') || token.includes('://')) return false
  if (!/^[A-Za-z0-9_.@/-]+$/.test(token)) return false
  const cleaned = token.replace(/^\.\//, '').replace(/\/$/, '')
  if (!cleaned || cleaned === '.' || cleaned === '..') return false
  const hasExtension = /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(cleaned)
  if (!hasExtension && !token.endsWith('/')) return false
  const segments = cleaned.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('..'))) return false
  return true
}

/** Whether a write verb reads as a directive (imperative, modal or requirement), not a factual statement. */
function directiveContext(clause: string, verbIndex: number): boolean {
  const before = clause.slice(0, verbIndex)
  if (/^\s*(?:[-*•]|\d+[.)])?\s*$/.test(before)) return true
  if (/[:：]\s*$/.test(before)) return true
  return DIRECTIVE_CUE.test(before.slice(-80))
}

export interface WriteDirectiveOptions {
  /** Strict mode ignores factual/passive statements ("X is committed at ...") and only keeps directives. */
  strict?: boolean
}

/**
 * Repository paths that a text names as write targets. Only a write verb that
 * precedes the path in the same clause counts, and a negated verb ("do not
 * edit", "never change") does not: prohibitions are not write directives.
 * Strict mode additionally requires an imperative or modal context, so a
 * factual sentence such as "the file is committed at docs/x.md" is not a
 * directive while "add a file under docs/" is.
 */
export function writeDirectivePaths(text: string, options: WriteDirectiveOptions = {}): string[] {
  const strict = options.strict ?? true
  const found: string[] = []
  const seen = new Set<string>()
  for (const clause of text.split(CLAUSE_SPLIT)) {
    const verbs: Array<{ index: number; end: number; directive: boolean }> = []
    WRITE_VERB_PATTERN.lastIndex = 0
    for (let match = WRITE_VERB_PATTERN.exec(clause); match !== null; match = WRITE_VERB_PATTERN.exec(clause)) {
      verbs.push({ index: match.index, end: match.index + match[0].length, directive: directiveContext(clause, match.index) })
    }
    if (!verbs.length) continue
    const candidates: Array<{ index: number; token: string }> = []
    const tokenPattern = /[A-Za-z0-9_.@/-]+/g
    for (let match = tokenPattern.exec(clause); match !== null; match = tokenPattern.exec(clause)) {
      if (looksLikePath(match[0])) candidates.push({ index: match.index, token: match[0].replace(/^\.\//, '') })
    }
    for (const candidate of candidates) {
      // The nearest preceding verb decides negation; an earlier imperative verb
      // in the same clause still makes an imperative chain a directive.
      const preceding = verbs.filter(verb => verb.end <= candidate.index)
      if (!preceding.length) continue
      const nearest = preceding[preceding.length - 1]!
      if (NEGATION_PATTERN.test(clause.slice(0, nearest.index)) || NEGATION_PATTERN.test(clause.slice(nearest.end, candidate.index))) continue
      const directive = preceding.some(verb => {
        if (strict && !verb.directive) return false
        if (NEGATION_PATTERN.test(clause.slice(0, verb.index))) return false
        return !NEGATION_PATTERN.test(clause.slice(verb.end, candidate.index))
      })
      if (!directive) continue
      if (!seen.has(candidate.token)) { seen.add(candidate.token); found.push(candidate.token) }
    }
  }
  return found
}

/** Reconcile an objective's write directives with the scope the task may commit. */
export function reconcileObjectiveScope(objective: string, scope: readonly string[], location: string): AdmissionDiagnostic[] {
  return writeDirectivePaths(objective).filter(path => !withinScope(path, scope)).map(path => ({
    code: 'objective_write_outside_scope',
    location,
    path,
    message: `the objective directs a write to ${JSON.stringify(path)}, which the scope ${JSON.stringify(scope)} does not cover. A worker cannot commit that path (capture rejects out-of-scope changes), so the objective would fail at submit after the work is done. Narrow the objective to an in-scope path or widen the task scope within mission scope; never broaden scope just to pass validation.`,
  }))
}

/** Path tokens named anywhere in a text, excluding clauses that prohibit them. */
export function namedPaths(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const clause of text.split(CLAUSE_SPLIT)) {
    const tokenPattern = /[A-Za-z0-9_.@/-]+/g
    for (let match = tokenPattern.exec(clause); match !== null; match = tokenPattern.exec(clause)) {
      if (!looksLikePath(match[0])) continue
      const token = match[0].replace(/^\.\//, '')
      if (seen.has(token)) continue
      if (NEGATION_PATTERN.test(clause.slice(0, match.index))) continue
      seen.add(token); found.push(token)
    }
  }
  return found
}

/**
 * Deliverable paths named by an objective or its acceptance criteria. Objectives
 * use write directives (including factual ones) so a read-only input reference
 * is not mistaken for a deliverable; an acceptance criterion names an
 * obligation, so every non-negated path token in it counts.
 */
export function deliverablePaths(objective: string, acceptance: readonly string[] = []): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const add = (path: string): void => { if (!seen.has(path)) { seen.add(path); found.push(path) } }
  for (const path of writeDirectivePaths(objective, { strict: false })) add(path)
  for (const text of acceptance) {
    for (const path of writeDirectivePaths(text, { strict: false })) add(path)
    for (const path of namedPaths(text)) add(path)
  }
  return found
}

export interface IgnoredPath { path: string; source: string; line: number; pattern: string }

/**
 * Deliverable paths that the workspace's effective ignore rules would hide from
 * capture. `git check-ignore` without `-v` lists exactly the hidden paths, so a
 * later `!` negation is never reported (verbose mode does report the negation
 * pattern and would falsely reject an un-ignored deliverable). The verbose run
 * only supplies the source, line and pattern for the paths already known to be
 * hidden, and is silent when the workspace is not a git work tree or git is
 * unavailable.
 */
export function ignoredDeliverablePaths(workspace: string, paths: readonly string[]): IgnoredPath[] {
  const candidates = [...new Set(paths.map(path => path.replace(/^\.\//, '')).filter(path => path && !path.endsWith('/') && !isAbsolute(path) && !path.includes('*') && !path.split('/').some(part => part === '..')))]
  if (!candidates.length) return []
  const input = candidates.map(candidate => `${candidate}\0`).join('')
  const run = (args: string[]) => spawnSync('git', ['-C', workspace, 'check-ignore', '--stdin', ...args], { input, encoding: 'utf8', timeout: 5000, maxBuffer: 1048576 })
  const ignored = run(['-z'])
  // Exit 1 means no candidate is ignored; 128 means git or a work tree is unavailable. Neither is an admission failure.
  if (ignored.error || ignored.status !== 0) return []
  const hidden = new Set(String(ignored.stdout).split('\0').filter(Boolean))
  if (!hidden.size) return []
  const verbose = run(['-v', '-z'])
  if (verbose.error || verbose.status !== 0) return [...hidden].map(path => ({ path, source: '.gitignore', line: 0, pattern: '' }))
  const fields = String(verbose.stdout).split('\0')
  const hits: IgnoredPath[] = []
  for (let index = 0; index + 3 < fields.length; index += 4) {
    const source = fields[index], line = Number(fields[index + 1]), pattern = fields[index + 2], path = fields[index + 3]
    if (!path || !hidden.has(path)) continue
    if (pattern?.startsWith('!')) continue
    hits.push({ path, source: source || '.gitignore', line: Number.isSafeInteger(line) ? line : 0, pattern: pattern ?? '' })
  }
  return hits
}

/** Reject admission when a named deliverable would be silently absent from the captured artifact. */
export function reconcileDeliverableIgnores(workspace: string, objective: string, acceptance: readonly string[], location: string): AdmissionDiagnostic[] {
  return ignoredDeliverablePaths(workspace, deliverablePaths(objective, acceptance)).map(hit => ({
    code: 'deliverable_path_ignored',
    location,
    path: hit.path,
    message: `the named deliverable ${JSON.stringify(hit.path)} is ignored by ${hit.source}:${hit.line} (${JSON.stringify(hit.pattern)}). Capture only records untracked, non-ignored paths, so this deliverable would be silently absent from the artifact. Add a negation for this exact path inside the task's own scope or rename the deliverable, and retry the same task/request.`,
  }))
}

/** Every admission reconciliation that needs only the task text, scope and workspace. */
export function reconcileTaskAdmission(task: { objective: string; scope: readonly string[]; acceptance?: readonly string[] }, workspace: string, location: string): AdmissionDiagnostic[] {
  const diagnostics = reconcileObjectiveScope(task.objective, task.scope, location)
  diagnostics.push(...reconcileDeliverableIgnores(workspace, task.objective, task.acceptance ?? [], location))
  return diagnostics
}

export interface CheckClassification {
  command: string
  runnable: 'worker' | 'host-only'
  code?: 'check_requires_host'
  requirement?: string
}

/**
 * Commands that cannot run under the worker's workspace-write sandbox. They are
 * host-gate suites (Harness composition, the pack/profile smokes that compose a
 * nested workspace-write profile, web/command-web smoke, isolation) or a nested
 * sandbox invocation; declaring one as a task check guarantees an unrunnable
 * verification (W14).
 */
const HOST_ONLY_CHECKS: Array<{ pattern: RegExp; requirement: string }> = [
  { pattern: /(?:^|[\s;&|()])npm\s+(?:run\s+)?test:harness(?:\s|$)/, requirement: 'the Harness composition suite needs a built Harness checkout and an unsandboxed host' },
  { pattern: /(?:^|[\s;&|()])npm\s+(?:run\s+)?test:pack(?:\s|$)/, requirement: 'the pack smoke composes a real Harness profile whose nested workspace-write sandbox is denied under worker confinement (scripts/sandbox-prerequisite.mjs)' },
  { pattern: /(?:^|[\s;&|()])npm\s+(?:run\s+)?test:profile(?:\s|$)/, requirement: 'the profile smoke composes a real Harness profile whose nested workspace-write sandbox is denied under worker confinement (scripts/sandbox-prerequisite.mjs)' },
  { pattern: /(?:^|[\s;&|()])npm\s+(?:run\s+)?test:web(?:\s|$)/, requirement: 'the web smoke suite needs the host web/session boundary' },
  { pattern: /(?:^|[\s;&|()])npm\s+(?:run\s+)?test:command-web(?:\s|$)/, requirement: 'the command-web smoke suite needs the host web/session boundary' },
  { pattern: /(?:^|[\s;&|()])npm\s+(?:run\s+)?test:isolation(?:\s|$)/, requirement: 'the isolation suite asserts a real sandbox refusal and only runs on an unsandboxed host' },
  { pattern: /(?:^|[\s;&|()])npm\s+run\s+verify(?:\s|$)/, requirement: '`npm run verify` includes the host-only test:harness, test:pack, test:profile, test:web and test:command-web suites' },
  { pattern: /node\s+--expose-internals\s+tests\/harness-composition\.mjs/, requirement: 'Harness composition needs a built Harness checkout and an unsandboxed host' },
  { pattern: /node\s+scripts\/smoke-pack\.mjs/, requirement: 'the pack smoke composes a real Harness profile whose nested workspace-write sandbox is denied under worker confinement (scripts/sandbox-prerequisite.mjs)' },
  { pattern: /node\s+scripts\/smoke-profile\.mjs/, requirement: 'the profile smoke composes a real Harness profile whose nested workspace-write sandbox is denied under worker confinement (scripts/sandbox-prerequisite.mjs)' },
  { pattern: /node\s+scripts\/smoke-web\.mjs/, requirement: 'the web smoke suite needs the host web/session boundary' },
  { pattern: /node\s+scripts\/smoke-command-web\.mjs/, requirement: 'the command-web smoke suite needs the host web/session boundary' },
  { pattern: /tests\/verification-isolation\.mjs/, requirement: 'the isolation suite asserts a real sandbox refusal and only runs on an unsandboxed host' },
  { pattern: /(?:^|[\s;&|()])(?:sandbox-exec|dsh\s+sandbox)\b/, requirement: 'a nested sandbox invocation is refused inside a worker sandbox' },
]

export function classifyCheck(command: string): CheckClassification {
  for (const { pattern, requirement } of HOST_ONLY_CHECKS) {
    if (pattern.test(command)) return { command, runnable: 'host-only', code: 'check_requires_host', requirement }
  }
  return { command, runnable: 'worker' }
}

/**
 * Standard system locations every clean verification checkout shares with the
 * host: the POSIX shells, the usual executable directories and the standard
 * device files. Any other absolute path names a host-specific location (a home
 * directory, the source checkout, a project toolchain) that the disposable
 * checkout does not contain.
 */
export const SYSTEM_CHECK_PATH_ALLOWLIST: readonly string[] = [
  '/bin', '/usr/bin', '/sbin', '/usr/sbin',
  '/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr',
]
const SYSTEM_CHECK_PATH_PREFIXES = ['/bin/', '/usr/bin/', '/sbin/', '/usr/sbin/']

/** Whether one absolute path token is a system location every checkout shares. */
export function isSystemCheckPath(candidate: string): boolean {
  return SYSTEM_CHECK_PATH_ALLOWLIST.includes(candidate) || SYSTEM_CHECK_PATH_PREFIXES.some(prefix => candidate.startsWith(prefix))
}

/**
 * Absolute path tokens named by a shell command. The command is split into
 * shell words, an assignment prefix (`VAR=value`) is peeled so its value is
 * judged, and a path is recognised only where a path component can begin: at a
 * word start, after `=` `:` `@` `,`, or after an attached short option
 * (`-I/abs`). `https://…` and a `//`-leading segment are not local paths, and a
 * `$PWD/…` expansion is not absolute. A `PATH`-style colon list is split so
 * each entry is judged on its own. This is a bounded token scanner, not a shell
 * parser: `${VAR}` indirection, `$(…)` output, `eval` and aliases/functions can
 * still produce a host path and stay documented residuals.
 */
export function absoluteCheckPaths(command: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const add = (candidate: string): void => {
    for (const part of candidate.split(':')) {
      if (!part.startsWith('/') || part.startsWith('//') || seen.has(part)) continue
      seen.add(part); found.push(part)
    }
  }
  const pattern = /(?:^|[=:@,]|-[A-Za-z]+)(\/(?!\/)[^\s;&|()<>"'`]*)/g
  for (const word of command.split(/[\s;&|()<>"'`]+/).filter(Boolean)) {
    let body = word
    for (let assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/s.exec(body); assignment !== null; assignment = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/s.exec(body)) body = assignment[1]!
    pattern.lastIndex = 0
    for (let match = pattern.exec(body); match !== null; match = pattern.exec(body)) add(match[1]!)
  }
  return found
}

/**
 * A declared check runs in a clean verification checkout: a fresh worktree of
 * the artifact commit under a random path below `workspacesRoot`. An absolute
 * path therefore cannot identify anything in that checkout — including a path
 * that points inside the mission workspace, because the source checkout is a
 * different directory from the checkout under test. It is refused at admission
 * with a field-level diagnostic (Round 9-C: a repair had swapped its check for
 * the source project's `.venv/bin/python` and a host `uv`, preserving the
 * acceptance text, and admission accepted it). Standard system locations stay
 * admitted; relative paths and shell expansions such as `$PWD/...` are
 * unaffected.
 */
export function reconcileCheckPaths(command: string, location: string): AdmissionDiagnostic[] {
  return absoluteCheckPaths(command).filter(candidate => !isSystemCheckPath(candidate)).map(candidate => ({
    code: 'check_absolute_path',
    location,
    path: candidate,
    message: `the declared check names the absolute path ${JSON.stringify(candidate)}, which is not inside the disposable verification checkout. The verifier runs every check in a clean verification checkout — a fresh worktree of the artifact commit under a random path — so this host location (a home directory, the source checkout or a project toolchain) is not present there; the check would fail with exit 127 or silently test the source instead of the artifact. Use a checkout-relative path (for example ".venv/bin/python" or "node_modules/.bin/tool") or a standard system executable (${SYSTEM_CHECK_PATH_ALLOWLIST.slice(0, 2).map(item => JSON.stringify(item)).join(', ')}). Correct this field and retry the same task/request, preserving acceptance criteria and budget; never swap a check for a host-absolute path to make it pass.`,
  }))
}

export function requireHostChecks(kind: string, checks: readonly string[] | undefined, location: string, taskIdentity?: string): void {
  if (checks !== undefined) {
    if (!Array.isArray(checks)) throw new Error(`${location}.checks must be an array of real repository acceptance commands. Correct this field and retry the same task/request, preserving acceptance criteria and budget.`)
    const invalid = checks.findIndex(command => typeof command !== 'string' || !command.trim() || command.length > 16000)
    if (invalid !== -1) throw new Error(`${location}.checks[${invalid}] must be a nonempty shell command of at most 16000 characters that proves the task's acceptance criteria. Empty or whitespace-only commands do not verify work. Correct this field and retry the same task/request, preserving acceptance criteria and budget.`)
    const hostOnly = checks.map((command, index) => ({ command, index, classification: classifyCheck(command) })).find(item => item.classification.runnable === 'host-only')
    if (hostOnly) throw new Error(`[check_requires_host] ${location}.checks[${hostOnly.index}] ${JSON.stringify(hostOnly.command)} cannot run in the worker execution environment: ${hostOnly.classification.requirement}. The verifier runs declared checks inside the workspace-write sandbox, so this command would fail there and force a re-proposal (W14). Declare only worker-runnable checks (typecheck, build, unit tests, faults, load, replay) and leave host-only suites to the owner's host gate. Correct this field and retry the same task/request, preserving acceptance criteria and budget.`)
    // Round 9-C: a check that names a host-absolute path cannot run in the
    // disposable checkout. Refuse it here, at the shared admission point, so a
    // repair cannot silently swap its check for the source toolchain.
    const absolute = checks.map((command, index) => ({ index, diagnostics: reconcileCheckPaths(command, `${location}.checks[${index}]`) })).find(item => item.diagnostics.length > 0)
    if (absolute) throw new Error(formatDiagnostic(absolute.diagnostics[0]!))
  }
  if ((kind === 'implementation' || kind === 'integration') && !checks?.length) {
    throw new Error(`${location}.checks${taskIdentity ? ` (task ${JSON.stringify(taskIdentity)})` : ''} is required: code tasks of kind ${JSON.stringify(kind)} need at least one real repository acceptance command, supplied by the primary agent. Inspect existing project test/build scripts or choose a meaningful assertion proving this task's acceptance criteria. Commands belong on the source implementation/integration task, even when it has a separate reviewOf task; the host runs them on its committed artifact. If this task changes code, keep its kind, add checks and retry the same task/request, preserving acceptance criteria and budget. If its actual objective is only a read-only audit or report synthesis, the primary agent should explicitly classify it as research with dependencies and host-recorded evidence. Never change a code deliverable to research to bypass verification or substitute trivial always-passing checks.`)
  }
}
