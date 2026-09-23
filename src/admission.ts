/** Shared input normalization and repair guidance; matching and authority stay strict. */
import { assignmentAllows, type AssignmentCandidate } from './assignment.ts'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { scopeSubset, validScope, withinScope } from './scope.ts'
// Declared outputs are checked against the same toolchain names the workspace
// engine excludes from capture; both sides must never drift apart.
import { DEFAULT_VERIFICATION_DEPENDENCY_DIRS, SWARM_SCRATCH_DIRNAME } from './workspaces.ts'
import type { TaskCeiling, TaskCeilingDimension, TaskCeilingProvenance } from './types.ts'
import { PolicyError, type PolicyErrorCategory } from './policy-error.ts'

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
  // The code token trails the legacy `location[` prefix so the message bytes
  // stay the ones tests and callers pin; the category is the one errorTypeFor
  // always derived from this text (it says "budget").
  if (invalid !== -1) throw new AdmissionError('scope_selector_invalid', 'budget_error', `${location}[${invalid}] is invalid: ${JSON.stringify(scopes[invalid])}. Use literal workspace-relative file paths, directory prefixes ending in "/", or "**". Do not use absolute paths, traversal, wildcard patterns or descriptive prose. Correct \`scope\` and retry the same task/request, preserving its kind, acceptance criteria and budget; never broaden scope just to pass validation. [scope_selector_invalid]`, `${location}[${invalid}]`)
  if (parent && !scopeSubset(scopes, parent)) {
    const offending = scopes.find(selector => !scopeSubset([selector], parent))
    throw new AdmissionError('scope_selector_out_of_scope', 'budget_error', `${location} exceeds mission scope: ${JSON.stringify(offending)} is not covered by allowed mission selectors ${JSON.stringify(parent)}. Use literal workspace-relative paths or directory prefixes ending in "/", not descriptive prose. Each task selector must match or narrow a mission selector. Narrow \`scope\` to a subset of the mission \`scope\` and retry the same task/request, preserving its kind, acceptance criteria and budget; never broaden scope just to pass validation. [scope_selector_out_of_scope]`, location)
  }
}

/**
 * The criteria a repair's stored `acceptance` holds beyond the list its
 * proposal supplied: what the host inherited from the replaced tasks. An
 * omitted or malformed proposal list supplied nothing.
 */
export function inheritedAcceptance(acceptance: readonly string[], proposed: unknown): string[] {
  const supplied: readonly unknown[] = Array.isArray(proposed) ? proposed : []
  return acceptance.filter(criterion => !supplied.includes(criterion))
}

/** reviewOf already waits for submission; an ordinary edge would wait for acceptance. */
export function normalizeReviewDependencies(kind: string, reviewOf: string | undefined, dependencies: readonly string[] = []): string[] {
  return dependencies.filter(dependency => kind !== 'verification' || dependency !== reviewOf)
}

/** The minimal task shape a review path needs: one verification task and its source. */
export interface ReviewPathCandidate extends AssignmentCandidate {
  id: string
  kind: string
}

/** A live review needs at least one live member allowed to own it independently. */
export function liveReviewFor<T extends ReviewPathCandidate>(reviews: readonly T[], sourceId: string, authorId: string | undefined, liveMemberIds: ReadonlySet<string>,
  isLiveStatus: (review: T) => boolean = review => review.status === 'pending' || review.status === 'running'): T | undefined {
  return reviews.find(review => review.kind === 'verification' && review.reviewOf === sourceId && isLiveStatus(review)
    && [...liveMemberIds].some(memberId => memberId !== authorId && assignmentAllows(review, memberId, reviews)))
}

/* ------------------------------------------------------------------------- *
 * Round 14 DEAD: the durable task-graph validator.
 *
 * An illegal graph — an edge to an identity no task carries, an edge to itself,
 * a duplicated identity, or a dependency/review cycle — must not exist in the
 * durable log at all, so the check runs on every path that can write state:
 *  - admission: `reconcileTaskAdmission`, which the propose path calls with the
 *    mission's durable identities in `knownContents`;
 *  - replay: `orchestratorCommands` in `src/trace.ts`, over the `task/proposed`
 *    graph reconstructed from the durable log.
 * One function, two callers, so the two paths cannot drift into separate rule
 * sets. Pure and total: it reads only its arguments and never throws; each
 * caller decides whether a defect is a refusal (it is, on both paths).
 * ------------------------------------------------------------------------- */

/** One node of the durable task graph: exactly the edges the runtime stores. */
export interface TaskGraphNode {
  id: string
  dependencies: readonly string[]
  reviewOf?: string
}

export type TaskGraphDefectCode = 'task_graph_duplicate' | 'task_graph_self_edge' | 'task_graph_unknown_edge' | 'task_graph_cycle'

export interface TaskGraphDefect {
  code: TaskGraphDefectCode
  taskId: string
  target: string
  message: string
}

/**
 * Every defect in `nodes`. `known` is the set of identities the caller can prove
 * exist — the mission's durable task ids at admission, the replayed ids on the
 * replay path; when it is omitted, the node ids are the known set. The edges of
 * a node are its `dependencies` plus its `reviewOf` source, which `prepareTask`
 * merges into the worktree like a dependency.
 */
export function taskGraphDefects(nodes: readonly TaskGraphNode[], known?: ReadonlySet<string>): TaskGraphDefect[] {
  const defects: TaskGraphDefect[] = []
  const knownIds = known ?? new Set(nodes.map(node => node.id))
  const seen = new Set<string>()
  const edges = (node: TaskGraphNode): string[] => [...node.dependencies, ...(node.reviewOf === undefined ? [] : [node.reviewOf])]
  for (const node of nodes) {
    if (seen.has(node.id)) {
      defects.push({ code: 'task_graph_duplicate', taskId: node.id, target: node.id,
        message: `task ${JSON.stringify(node.id)} appears more than once in the graph, so its edges are ambiguous. Withdraw the duplicate with \`swarm_cancel\` by naming its \`taskId\` and a \`reason\`, then re-check the board with \`swarm_observe\` and its \`taskId\`, and retry the same task/request.` })
    }
    seen.add(node.id)
  }
  for (const node of nodes) for (const target of edges(node)) {
    if (target === node.id) {
      defects.push({ code: 'task_graph_self_edge', taskId: node.id, target,
        message: `task ${JSON.stringify(node.id)} declares an edge to itself. Remove ${JSON.stringify(node.id)} from its own \`dependencies\` and re-propose it with \`swarm_propose\`, then retry the same task/request.` })
      continue
    }
    if (!knownIds.has(target)) {
      defects.push({ code: 'task_graph_unknown_edge', taskId: node.id, target,
        message: `task ${JSON.stringify(node.id)} declares edge ${JSON.stringify(target)}, which no task in this mission carries. Add the task that carries it with \`swarm_propose\` by passing its \`dependencies\`, or remove the edge from \`dependencies\`/\`reviewOf\` and retry the same task/request.` })
    }
  }
  // A cycle is an edge that closes a path back to a node already on the current
  // depth-first stack; one defect per closing edge, naming both ends.
  const byId = new Map(nodes.map(node => [node.id, node]))
  const open = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string): void => {
    if (open.has(id) || done.has(id)) return
    open.add(id)
    const node = byId.get(id)
    for (const target of node === undefined ? [] : edges(node)) {
      if (target === id || !byId.has(target)) continue
      if (open.has(target)) {
        defects.push({ code: 'task_graph_cycle', taskId: id, target,
          message: `task ${JSON.stringify(id)} depends on ${JSON.stringify(target)}, which (directly or through other tasks) depends back on it, so neither can ever be accepted first. Remove one edge of the cycle from \`dependencies\` or \`reviewOf\` and re-propose the work with \`swarm_propose\`, then retry the same task/request.` })
        continue
      }
      visit(target)
    }
    open.delete(id); done.add(id)
  }
  for (const node of nodes) visit(node.id)
  return defects
}

/** Render one defect as an admission diagnostic; the code is the same token. */
export function taskGraphDiagnostic(defect: TaskGraphDefect, location: string): AdmissionDiagnostic {
  return { code: defect.code, location, path: defect.target, message: defect.message }
}

/**
 * An authored admission refusal: typed for the RPC boundary and the trace, and
 * carrying the machine-checkable diagnostics it refuses with. A single refusal
 * is its own diagnostic at `location`; a refusal with several diagnostics
 * passes them, and its message is their formatted join.
 */
export class AdmissionError extends PolicyError {
  readonly diagnostics: readonly AdmissionDiagnostic[]
  constructor(code: string, category: PolicyErrorCategory, message: string, location: string, diagnostics?: readonly AdmissionDiagnostic[]) {
    super(code, category, message)
    this.name = 'AdmissionError'
    this.diagnostics = diagnostics ?? [{ code, location, message }]
  }
}

/** Authored graph validation, distinguishable from an internal host failure at RPC. */
export class TaskGraphAdmissionError extends AdmissionError {
  constructor(readonly defects: readonly TaskGraphDefect[]) {
    super('task_graph_invalid', 'validation_error', defects.map(defect => formatDiagnostic(taskGraphDiagnostic(defect, 'task'))).join('\n'), 'task',
      defects.map(defect => taskGraphDiagnostic(defect, 'task')))
    this.name = 'TaskGraphAdmissionError'
  }
  /** Named before it was typed, so its recorded rendering keeps the name. */
  override toString(): string { return `${this.name}: ${this.message}` }
}

/** Machine-checkable diagnostic for a submitted code deliverable no review can accept. */
export function missingReviewDiagnostic(taskId: string, reason: string): AdmissionDiagnostic {
  // The message is the caller's reason; the only call site (Runtime's review
  // notification) composes the imperative exit next to it. The rendered form is
  // pinned byte-for-byte by tests/review-path-admission.test.mjs, so the
  // actionable half travels with the caller, not inside this stable code carrier.
  return { code: 'review_path_missing', location: `task ${JSON.stringify(taskId)}`, message: reason }
}

/**
 * A stable, machine-checkable admission diagnostic. The same code is embedded
 * in the thrown repair message, so a caller can match programmatically instead
 * of parsing prose.
 */
export interface AdmissionDiagnostic {
  /** Heuristics explain potential risks without granting or denying authority. */
  severity?: 'advisory'
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
  ceilingProvenance?: TaskCeilingProvenance
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
  if (!Number.isSafeInteger(value) || value < 1) throw new AdmissionError('task_ceiling_invalid', 'validation_error', `[task_ceiling_invalid] ${location}.${dimension} must be a positive safe integer; a zero, fractional or unsafe ceiling cannot bound a task. Set \`maxSteps\` or \`maxFindings\` on this task to a positive safe integer and retry the same task/request.`, `${location}.${dimension}`)
}

/**
 * Derive and validate one task's own step/finding ceilings. The step default is
 * bounded by the mission budget, so a plan without explicit ceilings still
 * carries per-task limits and cannot admit a task ceiling that can never bind.
 */
export function normalizeTaskCeilings(task: TaskCeilingInput, missionMaxSteps: number, location: string): { maxSteps: number; maxFindings: number; ceilingProvenance: TaskCeilingProvenance } {
  const maxSteps = task.maxSteps ?? Math.max(1, Math.min(missionMaxSteps, DEFAULT_TASK_MAX_STEPS))
  const maxFindings = task.maxFindings ?? DEFAULT_TASK_MAX_FINDINGS
  assertCeilingValue(maxSteps, location, 'maxSteps')
  assertCeilingValue(maxFindings, location, 'maxFindings')
  if (maxSteps > missionMaxSteps) throw new AdmissionError('task_ceiling_exceeds_mission_budget', 'budget_error', `[task_ceiling_exceeds_mission_budget] ${location}.maxSteps is ${maxSteps} but the mission maxSteps budget is ${missionMaxSteps}; a task ceiling above the mission ceiling can never bind before the mission budget does. Pass a lower \`maxSteps\` on the task (at most the mission budget) and retry the same task/request, or ask the mission owner to raise \`maxSteps\` inside \`swarm_budget\`'s \`budget\` argument first.`, `${location}.maxSteps`)
  const provenance = (dimension: TaskCeilingDimension, value: number): NonNullable<TaskCeilingProvenance[TaskCeilingDimension]> => {
    const prior = task.ceilingProvenance?.[dimension]
    // Revalidation receives filled-in numbers. Retain their saved origin only
    // while that exact value is unchanged; an edited number is an agent choice.
    const source = task[dimension] == null ? 'default'
      : prior?.value === value && (prior.source === 'agent' || prior.source === 'default') ? prior.source : 'agent'
    return { source, value }
  }
  return { maxSteps, maxFindings, ceilingProvenance: { maxSteps: provenance('maxSteps', maxSteps), maxFindings: provenance('maxFindings', maxFindings) } }
}

export interface TaskCeilingState extends TaskCeilingInput {
  usedSteps?: number
  evidenceIds?: readonly string[]
}

/** The exhausted dimension, if the task already consumed its own ceiling. */
export function taskCeilingExhaustion(task: TaskCeilingState): { dimension: TaskCeilingDimension; limit: number; used: number } | undefined {
  if (task.maxSteps !== undefined && (task.usedSteps ?? 0) >= task.maxSteps) return { dimension: 'maxSteps', limit: task.maxSteps, used: task.usedSteps ?? 0 }
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
    // The durable reason is thrown and notified verbatim, so the code travels in
    // the message itself and the exit names the owner's same-task budget repair.
    reason: `[task_ceiling_exhausted] Task ceiling exhausted: ${exhausted.dimension} ${exhausted.used}/${exhausted.limit}. Review progress and raise this task's finite \`maxSteps\` through \`swarm_budget\` with \`taskId\`, \`taskBudget\` and \`reason\`, within the mission budget. The original task, acceptance, artifacts and consumed work are preserved.`,
    at: now,
  }
}

/**
 * Why one declared output is unusable, or undefined when it is exact. The rules
 * are the capture gate's own (`Workspaces.captureArtifact`), stated at
 * admission: literal in-scope file, no directory, no glob, no traversal, no Git
 * metadata, no dependency or scratch directory. `dependencyDirs` is the name
 * set the host's workspace engine was configured with.
 */
function declaredOutputFault(output: unknown, scope: readonly string[], dependencyDirs: readonly string[]): string | undefined {
  if (typeof output !== 'string' || !output.trim()) return 'is not a nonempty path string'
  if (output.endsWith('/')) return 'ends in "/", so it names a directory rather than one file'
  if (/[*?[\]]/.test(output)) return 'contains a glob character, and only literal paths can be captured'
  if (isAbsolute(output) || output.startsWith('/') || output.includes('\\')) return 'is not a repository-relative path'
  if (/[ -]/.test(output)) return 'contains a control character'
  const parts = output.split('/')
  if (parts.some(part => part === '' || part === '.')) return 'has an empty or "." path segment'
  if (parts.includes('..')) return 'has a ".." segment, which could escape the repository'
  if (parts.some(part => part.toLowerCase() === '.git')) return 'names Git metadata'
  // The same names the workspace engine treats as toolchain state by name alone,
  // so a declared output can never force-capture an installed dependency.
  const toolchain = parts.find(part => part === SWARM_SCRATCH_DIRNAME || dependencyDirs.includes(part))
  if (toolchain !== undefined) return `lies under ${JSON.stringify(toolchain)}, a dependency or scratch directory that is never captured as work`
  if (!withinScope(output, scope)) return `is outside the task scope ${JSON.stringify([...scope])}`
  return undefined
}

/** The context of one `assertDeclaredOutputs` call, which decides the refusal's exit. */
export interface DeclaredOutputsOptions {
  /**
   * The outputs are the task's stored declaration, re-checked because the
   * owner amended only its scope. The caller never passed `outputs`, so the
   * exit names adding them to the same `swarm_control` amendment.
   */
  scopeAmendment?: boolean
  /**
   * The dependency directory names the host configured for its workspace
   * engine (`verificationDependencyDirs`), which capture treats as toolchain
   * state. Omitted means the engine's own default,
   * `DEFAULT_VERIFICATION_DEPENDENCY_DIRS`.
   */
  dependencyDirs?: readonly string[]
}

/**
 * The one exact check of a task's declared outputs, shared by plan validation,
 * `propose` and the owner amendment. It returns the detached list the caller
 * stores, so no call site can admit an entry it did not validate.
 */
export function assertDeclaredOutputs(outputs: unknown, scope: readonly string[], location: string, options: DeclaredOutputsOptions = {}): string[] {
  if (!Array.isArray(outputs)) throw new AdmissionError('output_outside_scope', 'validation_error', `[output_outside_scope] ${location}.outputs must be an array of repository-relative file paths. Set \`outputs\` to that array — empty for analysis-only work that writes no file — and retry the same request.`, `${location}.outputs`)
  for (const output of outputs) {
    const fault = declaredOutputFault(output, scope, options.dependencyDirs ?? DEFAULT_VERIFICATION_DEPENDENCY_DIRS)
    if (fault === undefined) continue
    if (options.scopeAmendment) throw new AdmissionError('output_outside_scope', 'validation_error', `[output_outside_scope] ${location}.outputs declares ${JSON.stringify(output)}, which ${fault} once this amendment applies, so every later submit would be refused. Pass \`changes\` with \`outputs\` that fit the new \`scope\` in the same \`swarm_control\` call, or keep a \`scope\` that contains every declared output, then retry.`, `${location}.outputs`)
    throw new AdmissionError('output_outside_scope', 'validation_error', `[output_outside_scope] ${location}.outputs declares ${JSON.stringify(output)}, which ${fault}. Correct that entry of \`outputs\` to a literal repository-relative file this task writes inside its own \`scope\`, drop it if the task only reads that path, and retry the same request.`, `${location}.outputs`)
  }
  return [...outputs as string[]]
}

/**
 * The admission refusals that need only the task text and its edges: the
 * dependency-assumption guard and the graph validator. Advisory hints (the
 * check preflight) are the draft UI's (`planAdvisories`); the propose path
 * refuses only on these, so it computes only these.
 */
export function reconcileTaskAdmission(task: DependencyAssumptionInput, location: string, context: DependencyAssumptionContext = {}): AdmissionDiagnostic[] {
  const diagnostics: AdmissionDiagnostic[] = []
  // R12-F9, admission-time half: the terminal element of the admission chain.
  // It fires only when the caller supplies the task's dependency set, so a call
  // site that does not know the edges can never refuse a legitimate task.
  diagnostics.push(...dependencyAssumptions(task, location, context))
  // DEAD, admission-time half: the same graph validator the replay path runs.
  // It fires only when the caller supplies the mission's durable identities —
  // without them, "unknown edge" cannot be distinguished from "not loaded yet",
  // and the guard must never guess. The candidate's own id is not part of the
  // admission input, so the self-edge and cycle checks are the replay path's
  // (a brand-new node cannot close a cycle: nothing references it yet).
  if (context.knownContents !== undefined) {
    const candidate: TaskGraphNode = { id: `${location} candidate`, dependencies: context.dependencies ?? task.dependencies ?? [] }
    for (const defect of taskGraphDefects([candidate], context.knownContents)) diagnostics.push(taskGraphDiagnostic(defect, location))
  }
  return diagnostics
}

/* ------------------------------------------------------------------------- *
 * R12-F9: the admission guard for a task that assumes prior work.
 *
 * Reproduced twice on 2026-09-10. `T3b` was admitted with no dependencies while
 * its objective said "resume from your own artifact `09883f3`" and was prepared
 * from the bare mission baseline; it was refused at submission ("Artifact
 * changes path outside task scope"). `INT2` said the assembly was already in its
 * worktree, was caught by the member itself, and was repaired by hand with
 * `git archive` plus a 225-path hash check at the cost of an owner cancellation
 * pair. Both are the same chain: preparation merges the mission baseline plus
 * the declared dependencies, so a task whose own text assumes content that no
 * dependency carries is refused at admission — with a coded diagnostic and an
 * executable exit — instead of surprising its member at submission.
 *
 * The guard deliberately requires the dependency *set*, not just the text: a
 * task that really does depend on the content is legitimate, and a repair may
 * not depend on the task it replaces (src/runtime.ts refuses that edge), so a
 * bare `replaces` id is not by itself evidence of missing content. `knownContents`
 * lets the caller distinguish "add the dependency that carries it" from "state
 * how you will obtain it"; when the caller does not know, the diagnostic names
 * both exits.
 * ------------------------------------------------------------------------- */

/** The stable code of the R12-F9 admission refusal. */
export const DEPENDENCY_ASSUMPTION_CODE = 'dependency_assumption_missing'

export interface DependencyAssumptionInput {
  objective: string
  acceptance?: readonly string[]
  dependencies?: readonly string[]
  replaces?: readonly string[]
}

export interface DependencyAssumptionContext {
  /** The declared dependency set. Absent means unknown, never "empty". */
  dependencies?: readonly string[]
  replaces?: readonly string[]
  /** Durable task ids, artifact commits and evidence ids this mission already holds. */
  knownContents?: ReadonlySet<string>
  /**
   * The dependency set is an owner amendment of an admitted task
   * (`swarm_control` `changes.dependencies`), whose text can no longer change,
   * so the diagnostic names the amendment's exits instead of a new proposal's.
   */
  amendment?: boolean
}

/** A clause that claims prior work is already available in the worktree. */
const WORKTREE_PRESENCE = /\b(?:already\s+in|already\s+present\s+in|is\s+already\s+in|are\s+already\s+in|was\s+already\s+in|were\s+already\s+in|already\s+has)\s+(?:your|its|the|this)\s+(?:worktree|checkout|baseline)\b/i
/** A clause that resumes or starts from named prior work. */
const RESUME_PRESENCE = /\b(?:resum(?:e|es|ing)\s+from|continu(?:e|es|ing)\s+from|prepared?\s+from|start(?:s|ing)?\s+from)\b/i
/** A weaker claim, kept only for a *named* artifact identity. */
const AVAILABILITY_PRESENCE = /\balready\s+(?:present|available|committed|merged|checked\s+out)\b/i
/** Sentence and line boundaries: the guard reads one clause at a time. */
const CLAUSE_SPLIT = /(?:[.;!?]\s+|\n+)/
const CONTENT_WORD = /\b(?:artifact|assembly|checkpoint|commit|evidence|snapshot|previous\s+attempt|prior\s+work|replaced\s+task)\b/i

/** Named artifact/evidence/task identities and commit-like tokens appearing in a clause. */
export function namedContentTokens(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/\b(?:artifact|evidence|task|attempt|mission|stream|checkpoint)_[A-Za-z0-9-]{4,}\b/g)) found.push(match[0])
  // A bare short hex token is only a commit reference when it carries a digit:
  // ordinary words such as "defaced" are all [a-f] and must not be read as one.
  for (const match of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) if (/\d/.test(match[0])) found.push(match[0])
  return found
}

/**
 * The coded diagnostic for one clause that assumes content no dependency
 * carries. `known` is the caller's answer to "does this mission already hold
 * that content"; undefined names both executable exits. `amendment` is an owner
 * amendment of an admitted task's dependencies: its objective and acceptance
 * are fixed, so the exits are the amendment itself or a withdrawal.
 */
export function dependencyAssumptionDiagnostic(named: string, field: string, clause: string, location: string, known?: boolean, amendment = false): AdmissionDiagnostic {
  const provenance = known === true
    ? 'That content exists in this mission, so a dependency edge is what carries it into a prepared worktree.'
    : known === false
      ? 'That content is not in the mission baseline, so the worktree will not contain it.'
      : 'No declared dependency carries that content into the prepared worktree.'
  if (amendment) return {
    code: 'dependency_assumption_missing',
    location,
    path: named,
    message: `the ${field} assumes ${JSON.stringify(named)} is already available${clause === '' ? '' : ` (${JSON.stringify(clause)})`}, but this amendment leaves the task no dependency that carries it. ${provenance} Keep the task that carries that content in \`changes\` \`dependencies\` and retry \`swarm_control\` with the same \`taskId\`, or withdraw the task with \`swarm_cancel\` and propose it again with \`swarm_propose\`, stating in \`objective\` how it obtains that content. The task is unchanged.`,
  }
  return {
    code: 'dependency_assumption_missing',
    location,
    path: named,
    message: `the ${field} assumes ${JSON.stringify(named)} is already available${clause === '' ? '' : ` (${JSON.stringify(clause)})`}, but the task declares no dependency that carries it. ${provenance} Add the dependency that carries that content with \`swarm_propose\` by passing \`dependencies\`, or state in the \`objective\` how you will obtain it and retry the same task; a repair may instead name the blocked task in \`replaces\`; the repair inherits its acceptance.`,
  }
}

/**
 * The R12-F9 admission guard: diagnostics for every clause of the objective and
 * acceptance that assumes prior work while the declared dependency set is empty.
 * A call site that does not supply the dependency set gets an empty list — the
 * guard never guesses, because guessing would refuse a legitimate task.
 */
export function dependencyAssumptions(task: DependencyAssumptionInput, location: string, context: DependencyAssumptionContext = {}): AdmissionDiagnostic[] {
  const dependencies = context.dependencies ?? task.dependencies
  if (dependencies === undefined || dependencies.length > 0) return []
  const replaces = new Set(context.replaces ?? task.replaces ?? [])
  const fields: Array<[string, string]> = [['objective', task.objective], ...(task.acceptance ?? []).map((item, index) => [`acceptance[${index}]`, item] as [string, string])]
  const found: AdmissionDiagnostic[] = []
  const seen = new Set<string>()
  for (const [field, text] of fields) {
    for (const clause of text.split(CLAUSE_SPLIT)) {
      const worktreeClaim = WORKTREE_PRESENCE.test(clause)
      const resumeClaim = RESUME_PRESENCE.test(clause)
      const availabilityClaim = AVAILABILITY_PRESENCE.test(clause)
      if (!worktreeClaim && !resumeClaim && !availabilityClaim) continue
      const tokens = namedContentTokens(clause)
      const contentWord = CONTENT_WORD.test(clause)
      const replaced = [...replaces].filter(id => clause.includes(id))
      // A bare `replaces` id in an ordinary repair sentence is not evidence of a
      // missing dependency; it only counts when the same clause also claims
      // prior content is available, or carries a named artifact identity.
      const claimsContent = tokens.length > 0 || contentWord || (replaced.length > 0 && (worktreeClaim || resumeClaim || availabilityClaim))
      if (!claimsContent) continue
      // The weak "already present/available/committed/merged" wording only fires
      // for a named identity or an explicit content noun, so a factual sentence
      // about the baseline repository cannot trip the guard.
      if (availabilityClaim && !worktreeClaim && !resumeClaim && tokens.length === 0 && !CONTENT_WORD.test(clause)) continue
      const named = tokens[0] ?? replaced[0] ?? (/(?:artifact|assembly|checkpoint|commit|evidence|snapshot)/i.exec(clause)?.[0] ?? 'the assumed prior work')
      if (seen.has(named)) continue
      seen.add(named)
      found.push(dependencyAssumptionDiagnostic(named, field, clause.trim(), location, context.knownContents === undefined ? undefined : context.knownContents.has(named), context.amendment === true))
    }
  }
  return found
}

export interface CheckClassification {
  command: string
  runnable: 'worker' | 'host-only'
  code?: 'check_requires_host'
  requirement?: string
  preflight?: string
}

/** Actual confinement requirements, independent of project script and file names. */
const HOST_ONLY_CHECKS: Array<{ pattern: RegExp; requirement: string }> = [
  { pattern: /(?:^|[\s;&|()])(?:sandbox-exec|dsh\s+sandbox)\b/, requirement: 'a nested sandbox invocation is refused inside the verifier workspace-write sandbox; run it through an available host check route or provide an equivalent artifact check supported by this verifier' },
]

/**
 * R11-06: read the workspace manifest's declared scripts, read-only and
 * bounded. The classifier uses it to judge an `npm run <name>` by the command
 * the name actually resolves to, so a host-only suite cannot hide behind a
 * neutral script name and a worker-runnable script is never refused by name.
 * Returns undefined when the manifest is absent, unreadable, oversized or
 * malformed; unresolved scripts remain preflight hints, never name-based refusals.
 */
export function loadPackageScripts(workspace: string): Record<string, string> | undefined {
  try {
    const raw = readFileSync(join(workspace, 'package.json'), 'utf8')
    if (raw.length > 1_000_000) return undefined
    const parsed = JSON.parse(raw) as { scripts?: unknown }
    const scripts = parsed?.scripts
    if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return undefined
    const result: Record<string, string> = {}
    for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) if (typeof body === 'string') result[name] = body
    return result
  } catch { return undefined }
}
/** R11-06: bounded recursive resolution of `npm run <name>` to a host-only body. */
function resolveHostOnlyScript(command: string, scripts: Record<string, string>, seen: Set<string>, depth: number): string | undefined {
  if (depth > 4) return undefined
  const pattern = /(?:^|[\s;&|()])npm\s+(?:run\s+|run-script\s+)?([A-Za-z0-9:_.-]+)/g
  for (let match = pattern.exec(command); match !== null; match = pattern.exec(command)) {
    const name = match[1]!
    const body = scripts[name]
    if (body === undefined || seen.has(name)) continue
    seen.add(name)
    for (const { pattern: hostPattern, requirement } of HOST_ONLY_CHECKS) {
      if (hostPattern.test(body)) return `script ${JSON.stringify(name)} resolves to ${JSON.stringify(body)}, which ${requirement}`
    }
    const nested = resolveHostOnlyScript(body, scripts, seen, depth + 1)
    if (nested !== undefined) return `script ${JSON.stringify(name)} resolves to ${JSON.stringify(body)}: ${nested}`
  }
  return undefined
}

export function classifyCheck(command: string, scripts?: Record<string, string>): CheckClassification {
  for (const { pattern, requirement } of HOST_ONLY_CHECKS) {
    if (pattern.test(command)) return { command, runnable: 'host-only', code: 'check_requires_host', requirement }
  }
  if (scripts !== undefined) {
    const resolved = resolveHostOnlyScript(command, scripts, new Set(), 0)
    if (resolved !== undefined) return { command, runnable: 'host-only', code: 'check_requires_host', requirement: resolved }
  }
  const unresolved = [...command.matchAll(/(?:^|[\s;&|()])npm\s+(?:run\s+|run-script\s+)([A-Za-z0-9:_.-]+)/g)].map(match => match[1]!).filter(name => scripts?.[name] === undefined)
  return { command, runnable: 'worker', ...(unresolved.length ? { preflight: `Unresolved target package scripts: ${unresolved.join(', ')}. Inspect the target manifest before execution; the immutable artifact must still pass its declared checks.` } : {}) }
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

/** One shell word after quote removal and backslash unescaping. */
export interface ShellToken { text: string; offset: number }
const SHELL_WORD_OPERATORS = new Set([';', '&', '|', '(', ')', '<', '>', '\n'])
/**
 * R11-04: a bounded POSIX-ish word splitter. It resolves single/double quotes
 * and backslash escapes (so `\/abs` and `"//abs"` become the words a shell would
 * execute), splits unquoted shell operators into their own tokens, keeps
 * backtick substitution bodies verbatim (a documented residual), and treats
 * `$(` as an operator boundary so an absolute path inside a substitution stays
 * visible. It is not a shell parser: `${VAR}`, `$'…'` ANSI-C quoting, `eval`
 * and aliases/functions remain documented residuals.
 */
export function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let text = ''
  let offset = -1
  let index = 0
  const flush = (): void => { if (text !== '') { tokens.push({ text, offset }); text = ''; offset = -1 } }
  while (index < command.length) {
    const char = command[index]!
    if (char === '\\' && index + 1 < command.length) {
      if (offset < 0) offset = index
      if (command[index + 1] !== '\n') text += command[index + 1]!
      index += 2
      continue
    }
    if (char === "'") {
      const close = command.indexOf("'", index + 1)
      const end = close === -1 ? command.length : close
      if (offset < 0) offset = index
      text += command.slice(index + 1, end)
      index = close === -1 ? command.length : close + 1
      continue
    }
    if (char === '"') {
      if (offset < 0) offset = index
      let cursor = index + 1
      while (cursor < command.length && command[cursor] !== '"') {
        const inner = command[cursor]!
        if (inner === '\\' && cursor + 1 < command.length && ['$', '`', '"', '\\', '\n'].includes(command[cursor + 1]!)) {
          if (command[cursor + 1] !== '\n') text += command[cursor + 1]!
          cursor += 2
        } else { text += inner; cursor++ }
      }
      index = cursor < command.length ? cursor + 1 : command.length
      continue
    }
    if (char === '`') {
      const close = command.indexOf('`', index + 1)
      const end = close === -1 ? command.length : close
      if (offset < 0) offset = index
      text += command.slice(index + 1, end)
      index = close === -1 ? command.length : close + 1
      continue
    }
    if (SHELL_WORD_OPERATORS.has(char)) {
      flush()
      tokens.push({ text: char, offset: index })
      index++
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') { flush(); index++; continue }
    if (offset < 0) offset = index
    text += char
    index++
  }
  flush()
  return tokens
}
/**
 * R11-04: command segments with the same operator boundaries the R6 git-write
 * classifier always used (`;`, `|`, `&&`, `||`, newline). A single `&`, `(` and
 * `)` stay inside a token, so the documented false negatives (`(git commit …)`,
 * `sleep 1 & git commit …`) stay false instead of widening the denial surface.
 */
export function shellSegments(command: string): ShellToken[][] {
  const segments: ShellToken[][] = [[]]
  let text = ''
  let offset = -1
  let index = 0
  const flush = (): void => { if (text !== '') { segments[segments.length - 1]!.push({ text, offset }); text = ''; offset = -1 } }
  const split = (): void => { flush(); if (segments[segments.length - 1]!.length > 0) segments.push([]) }
  while (index < command.length) {
    const char = command[index]!
    if (char === '\\' && index + 1 < command.length) {
      if (offset < 0) offset = index
      if (command[index + 1] !== '\n') text += command[index + 1]!
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      const quote = char
      if (offset < 0) offset = index
      let cursor = index + 1
      while (cursor < command.length && command[cursor] !== quote) {
        const inner = command[cursor]!
        if (quote === '"' && inner === '\\' && cursor + 1 < command.length && ['$', '`', '"', '\\', '\n'].includes(command[cursor + 1]!)) {
          if (command[cursor + 1] !== '\n') text += command[cursor + 1]!
          cursor += 2
        } else { text += inner; cursor++ }
      }
      index = cursor < command.length ? cursor + 1 : command.length
      continue
    }
    if (char === '`') {
      const close = command.indexOf('`', index + 1)
      const end = close === -1 ? command.length : close
      if (offset < 0) offset = index
      text += command.slice(index + 1, end)
      index = close === -1 ? command.length : close + 1
      continue
    }
    if (char === '\n' || char === ';' || char === '|' || (char === '&' && command[index + 1] === '&')) {
      if (char === '&' || char === '|') index++
      index++
      split()
      continue
    }
    if (char === ' ' || char === '\t' || char === '\r') { flush(); index++; continue }
    if (offset < 0) offset = index
    text += char
    index++
  }
  flush()
  return segments.filter(segment => segment.length > 0)
}
/**
 * R11-04/A2-01: lexical POSIX normalization of an absolute path, with no
 * filesystem access: collapse every run of slashes, drop `.` segments and
 * resolve `..` segments against the already-resolved prefix (never above the
 * root). `/usr/bin/../..//Users/x` and `/usr/bin/./../..//Users/x` both
 * normalize to `/Users/x`, which is what the shell would execute, so the system
 * exemption must be decided on the normalized result.
 */
export function normalizeAbsolutePath(candidate: string): string {
  const segments: string[] = []
  for (const part of candidate.replace(/^\/+/, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { segments.pop(); continue }
    segments.push(part)
  }
  // A trailing slash is preserved so a `/word/` regex literal stays
  // distinguishable from a single-segment path (`/word`).
  const trailing = segments.length > 0 && candidate.length > 1 && candidate.endsWith('/') ? '/' : ''
  return `/${segments.join('/')}${trailing}`
}
/**
 * R11-04: a candidate that is a shell pattern/regex/separator argument rather
 * than a host filesystem path. The refusal must not reject ordinary correct
 * checks: `awk -F/`, `sort -t/`, `tr / _` name the bare root as a separator,
 * `grep -E '/(src|tests)/'` and `--test-name-pattern='/rejects/'` are regex
 * arguments, and a single-segment `/word/` is a regex literal. A glob path
 * argument is likewise treated as a pattern here; the residual is documented
 * because declared-check admission cannot tell a pattern from a literal host
 * path without executing the shell.
 */
const CHECK_PATTERN_METACHARACTERS = /[\^$\[\]()?+{}|*\\]/
export function isCheckPattern(candidate: string): boolean {
  if (candidate === '/') return true
  if (CHECK_PATTERN_METACHARACTERS.test(candidate)) return true
  return /^\/[^/]*\/$/.test(candidate)
}
/**
 * R11-04/A2-01: absolute path tokens named by a shell command, scanned on the
 * words a POSIX shell would actually execute. The tokenizer resolves quotes and
 * backslash escapes, so a backslash-escaped leading slash (`cat \/Users/…`) and
 * a doubled leading slash (`cat //Users/…`) are both normalized to the same
 * host path the shell resolves. Every candidate is then lexically normalized
 * (`normalizeAbsolutePath`), so a traversal or dot-segment through a system
 * prefix (`/usr/bin/../..//Users/…`) is reported as the host path it resolves
 * to and cannot inherit the `/usr/bin/` exemption. An assignment prefix
 * (`VAR=value`) is peeled so its value is judged, and a path is recognised
 * where a path component can begin: at a word start, after whitespace or inner
 * shell punctuation inside a resolved quoted/backtick/eval word, after `=` `:`
 * `@` `,`, or after an attached short option (`-I/abs`), so
 * `sh -c "cat /abs"`, `eval "cat /abs"` and `node -e "require('/abs')"` are
 * seen. A `<scheme>://…` URL value is not a local path token and stays admitted;
 * the exemption requires the doubled slash and a scheme immediately before the
 * colon, so `--url=https://…` and `PATH=x:https://…` stay admitted while
 * `PATH=x:/abs` stays refused. A `PATH`-style colon list is split so each
 * entry is judged on its own. This is a bounded tokenizer, not a shell parser:
 * ANSI-C `$'\x2f…'`, `file://` URLs, `$IFS`, `$(…)` output that is not itself a
 * literal path word, `${VAR}` indirection, `eval` and aliases/functions can
 * still produce a host path and stay documented residuals.
 */
export function absoluteCheckPaths(command: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const add = (candidate: string): void => {
    const normalized = normalizeAbsolutePath(candidate)
    if (!normalized.startsWith('/') || seen.has(normalized)) return
    seen.add(normalized); found.push(normalized)
  }
  // A candidate begins at a word start, after whitespace (a quoted, backtick or
  // eval body resolves to one token but still contains separate shell words),
  // after inner shell punctuation or an assignment/option separator, or after
  // an attached short option (`-I/abs`).
  const candidatePattern = /(?:^|[\s=:@,({\['"`$]|-[A-Za-z]+)(\/+[^\s;&|()<>"'`]*)/g
  for (const token of shellTokens(command)) {
    let body = token.text
    for (let assignment = /^[A-Za-z_][A-Za-z0-9_]*=([\s\S]*)$/.exec(body); assignment !== null; assignment = /^[A-Za-z_][A-Za-z0-9_]*=([\s\S]*)$/.exec(body)) body = assignment[1]!
    candidatePattern.lastIndex = 0
    for (let match = candidatePattern.exec(body); match !== null; match = candidatePattern.exec(body)) {
      const candidate = match[1]!
      const start = match.index + match[0].length - candidate.length
      // `<scheme>://host/path` is a URL value, not a host filesystem path. The
      // candidate must be a doubled slash and the run immediately before the
      // colon must be a scheme, so `--url=https://…` and `PATH=x:https://…`
      // stay admitted while `PATH=x:/abs` (single slash) stays refused.
      if (candidate.startsWith('//') && start >= 2 && body[start - 1] === ':'
        && /(?:^|[^A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*$/.test(body.slice(0, start - 1))) continue
      for (const part of candidate.split(':')) add(part)
    }
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
 * admitted, and the decision uses the normalized path, so
 * `/usr/bin/../..//Users/…` is judged as `/Users/…`. Pattern/regex/separator
 * arguments (`awk -F/`, `grep -E '/(src|tests)/'`, `--test-name-pattern='/x/'`)
 * are not host paths and stay admitted; relative paths and shell expansions
 * such as `$PWD/...` are unaffected.
 */
export function reconcileCheckPaths(command: string, location: string): AdmissionDiagnostic[] {
  return absoluteCheckPaths(command)
    .filter(candidate => !isSystemCheckPath(candidate) && !isCheckPattern(candidate))
    .map(candidate => ({
    code: 'check_absolute_path',
    location,
    path: candidate,
    message: `the declared check names the absolute path ${JSON.stringify(candidate)}, which is not inside the disposable verification checkout. The verifier runs every check in a clean verification checkout — a fresh worktree of the artifact commit under a random path — so this host location (a home directory, the source checkout or a project toolchain) is not present there; the check would fail with exit 127 or silently test the source instead of the artifact. Replace it in \`checks\` with a checkout-relative path (for example ".venv/bin/python" or "node_modules/.bin/tool") or a standard system executable (${SYSTEM_CHECK_PATH_ALLOWLIST.slice(0, 2).map(item => JSON.stringify(item)).join(', ')}), then retry the same task/request; never swap a check for a host-absolute path to make it pass.`,
  }))
}

export function isNoopCheck(command: string): boolean { return /^(?:true|:|exit\s+0)\s*;?$/.test(command.trim()) }

/**
 * A control character a declared check cannot need. The check reaches the host
 * as one `/bin/sh -c` argument: a NUL byte there is refused by the process API
 * itself, and the others (a carriage return, an escape) are never part of a
 * real command. Tab and newline are admitted: a multi-line script is a check.
 */
const CHECK_CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/

export function requireHostChecks(kind: string, checks: readonly string[] | undefined, location: string, taskIdentity?: string, scripts?: Record<string, string>): void {
  if (checks !== undefined) {
    if (!Array.isArray(checks)) throw new AdmissionError('check_not_array', 'budget_error', `${location}.checks must be an array of real repository acceptance commands. Pass a nonempty \`checks\` array of shell command strings and retry the same task/request, preserving acceptance criteria and budget. [check_not_array]`, `${location}.checks`)
    const invalid = checks.findIndex(command => typeof command !== 'string' || !command.trim() || command.length > 16000)
    if (invalid !== -1) throw new AdmissionError('check_invalid', 'budget_error', `${location}.checks[${invalid}] must be a nonempty shell command of at most 16000 characters that proves the task's acceptance criteria. Empty or whitespace-only commands do not verify work. Repair that \`checks\` entry and retry the same task/request, preserving acceptance criteria and budget. [check_invalid]`, `${location}.checks[${invalid}]`)
    const control = checks.findIndex(command => CHECK_CONTROL_CHARACTER.test(command))
    if (control !== -1) {
      const codePoint = checks[control]!.match(CHECK_CONTROL_CHARACTER)![0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
      throw new AdmissionError('check_control_character', 'validation_error', `[check_control_character] ${location}.checks[${control}] contains the control character U+${codePoint}; a declared check may contain tab and newline but no other control character. Remove it from \`checks\` and retry with \`swarm_propose\`, or amend \`changes\` with \`swarm_control\`; keep the same task and acceptance criteria.`, `${location}.checks[${control}]`)
    }
    const noop = checks.findIndex(isNoopCheck)
    if (noop !== -1) throw new AdmissionError('check_noop', 'validation_error', `[check_noop] ${location}.checks[${noop}] is an always-passing no-op. Supply a real assertion in \`checks\` with \`swarm_propose\`, or amend \`changes\` with \`swarm_control\`; keep the same task and acceptance criteria.`, `${location}.checks[${noop}]`)
    const hostOnly = checks.map((command, index) => ({ command, index, classification: classifyCheck(command, scripts) })).find(item => item.classification.runnable === 'host-only')
    if (hostOnly) throw new AdmissionError('check_requires_host', 'budget_error', `[check_requires_host] ${location}.checks[${hostOnly.index}] ${JSON.stringify(hostOnly.command)} cannot run in the worker execution environment: ${hostOnly.classification.requirement}. The verifier runs declared checks inside the workspace-write sandbox, so this command would fail there until the check route is repaired. Declare only worker-runnable commands in \`checks\` (typecheck, build, unit tests, faults, load, replay) and leave host-only suites to the owner's host gate; retry the same task/request, preserving acceptance criteria and budget.`, `${location}.checks[${hostOnly.index}]`)
    // Round 9-C: a check that names a host-absolute path cannot run in the
    // disposable checkout. Refuse it here, at the shared admission point, so a
    // repair cannot silently swap its check for the source toolchain.
    const absolute = checks.map((command, index) => reconcileCheckPaths(command, `${location}.checks[${index}]`)[0]).find(diagnostic => diagnostic !== undefined)
    if (absolute) throw new AdmissionError(absolute.code, 'validation_error', formatDiagnostic(absolute), absolute.location, [absolute])
  }
  if ((kind === 'implementation' || kind === 'integration') && !checks?.length) {
    throw new AdmissionError('check_required', 'budget_error', `${location}.checks${taskIdentity ? ` (task ${JSON.stringify(taskIdentity)})` : ''} is required: code tasks of kind ${JSON.stringify(kind)} need at least one real repository acceptance command, supplied by the primary agent. [check_required] Inspect existing project test/build scripts or choose a meaningful assertion proving this task's acceptance criteria. Commands belong on the source implementation/integration task, even when it has a separate reviewOf task; the host runs them on its committed artifact. If this task changes code, keep its kind, add a real \`checks\` command and retry the same task/request, preserving acceptance criteria and budget. If its actual objective is only a read-only audit or report synthesis, the primary agent should explicitly classify it as research with dependencies and host-recorded evidence. Never change a code deliverable to research to bypass verification or substitute trivial always-passing checks.`, `${location}.checks`)
  }
}
