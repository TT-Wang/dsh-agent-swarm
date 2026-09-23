/** Pure validation shared by staged browser plans and their launch boundary. */
import { isAbsolute } from 'node:path'
import { AdmissionError, assertDeclaredOutputs, assertScopeSelectors, classifyCheck, loadPackageScripts, dependencyAssumptions, formatDiagnostic, normalizeReviewDependencies, normalizeScopeSelectors, normalizeTaskCeilings, reconcileDeliverableIgnores, reconcileObjectiveScope, requireHostChecks, type AdmissionDiagnostic, type TaskCeilingInput } from './admission.ts'
import type { PolicyErrorCategory } from './policy-error.ts'
import { nextWorkerName, type CheckSyntaxIssue, type PlanInput, type PlanTask } from './types.ts'

// Plan refusals echo the caller's own plan, so they are typed admission
// refusals: the browser sees them by type, and each category is the one the
// trace classifier gave the same text before it was typed.
function record(value: unknown, location = 'plan'): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AdmissionError('plan_entry_invalid', 'validation_error', 'Plan entries must be objects', location)
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16000) throw new AdmissionError('plan_text_invalid', 'validation_error', `${label} must be nonempty text of at most 16000 characters`, label)
}
function strings(value: unknown, label: string, empty = false): asserts value is string[] {
  if (!Array.isArray(value) || (!empty && !value.length)) throw new AdmissionError('plan_list_invalid', 'validation_error', `${label} must be a ${empty ? '' : 'nonempty '}string array`, label)
  for (const item of value) text(item, label)
}
function keyed(value: unknown, label: string): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value) || !value.length) throw new AdmissionError('plan_entries_required', 'tool_error', `${label} must contain at least one entry`, label.toLowerCase())
  const result = new Map<string, Record<string, unknown>>()
  const field = label.toLowerCase(), example = `${field.slice(0, -1)}_1`
  const reference = field === 'tasks' ? 'dependencies and reviewOf refer to this key'
    : field === 'members' ? 'assigneeKey refers to this key' : 'workstreamKey refers to this key'
  for (const [index, item] of value.entries()) {
    record(item, `${field}[${index}]`)
    const location = `${field}[${index}].key`
    if (typeof item.key !== 'string' || !item.key.trim()) throw new AdmissionError('plan_key_required', 'validation_error', `${location} is required: add a unique stable identifier such as "${example}". The name/title is not the identifier; ${reference}.`, location)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(item.key)) throw new AdmissionError('plan_key_invalid', 'validation_error', `${location} must be a stable identifier of 1–100 letters, digits, underscores or hyphens, starting with a letter or digit. For example: "${example}"; ${reference}.`, location)
    if (result.has(item.key)) throw new AdmissionError('plan_key_duplicate', 'tool_error', `${location} duplicates ${JSON.stringify(item.key)}. Assign a different unique key and update its references; ${reference}.`, location)
    result.set(item.key, item)
  }
  return result
}

/** One declared check with the plan location the launch preflight cites. */
export interface DeclaredPlanCheck { command: string; location: string }

/** The checks a plan declares, flattened in task order, each with its `tasks[<key>].checks[<index>]` location. */
export function declaredPlanChecks(tasks: readonly Pick<PlanTask, 'key' | 'checks'>[]): DeclaredPlanCheck[] {
  return tasks.flatMap(task => (task.checks ?? []).map((command, index) => ({ command, location: `tasks[${task.key}].checks[${index}]` })))
}

/**
 * The lines of the launch syntax refusal, one per refused check. The preflight
 * result is located (each issue carries the index of the command it refuses in
 * the list it was given), so lines pair by that index, never by position in the
 * result: reading it as aligned with the declared list blamed a valid checks[0]
 * for a broken checks[1] and cross-paired several failures. The command is
 * quoted too, because the parser's own diagnostic does not echo it on every
 * shell.
 */
export function checkSyntaxDetail(declared: readonly DeclaredPlanCheck[], issues: readonly CheckSyntaxIssue[]): string {
  return issues.map(issue => {
    const check = declared[issue.index]!
    return `${check.location} has invalid shell syntax in ${JSON.stringify(check.command)}: ${issue.message}`
  }).join('\n')
}

/**
 * The trace classifier's precedence: a joined refusal is classified by the
 * first of these categories any of its lines carries, so the plan refusal that
 * carries several diagnostics takes that one.
 */
const CATEGORY_PRECEDENCE: readonly PolicyErrorCategory[] = ['authorization_error', 'budget_error', 'lease_error', 'conflict_error', 'validation_error', 'tool_error']

/** Fail before any workers or worktrees are created. Returns a detached canonical plan. */
export function validatePlan(value: unknown): PlanInput {
  record(value)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1048576) throw new AdmissionError('plan_too_large', 'tool_error', 'Plan exceeds 1 MiB', 'plan')
  // Canonicalize a detached wire copy so retries and saved caller drafts are unchanged.
  value = JSON.parse(JSON.stringify(value))
  record(value)
  text(value.title, 'Title'); text(value.objective, 'Objective'); text(value.workspace, 'Workspace')
  if (!isAbsolute(value.workspace)) throw new AdmissionError('plan_workspace_not_absolute', 'validation_error', 'Workspace must be absolute', 'workspace')
  strings(value.scope, 'Mission scope'); strings(value.acceptance, 'Mission acceptance')
  value.scope = normalizeScopeSelectors(value.scope)
  // Return related scope/check corrections together so the primary repairs one
  // full plan: every refusal below becomes one diagnostic of a single refusal.
  const admissionIssues: Array<{ category: PolicyErrorCategory; diagnostics: readonly AdmissionDiagnostic[]; message: string }> = []
  const scripts = loadPackageScripts(String(value.workspace))
  const inspectAdmission = (inspect: () => void): void => {
    // Anything but an authored admission refusal is a host failure, not a plan issue.
    try { inspect() } catch (error) {
      if (!(error instanceof AdmissionError)) throw error
      admissionIssues.push({ category: error.category, diagnostics: error.diagnostics, message: error.message })
    }
  }
  inspectAdmission(() => assertScopeSelectors(value.scope as string[], 'scope'))
  record(value.budget, 'budget')
  for (const name of ['maxTokens', 'maxSteps', 'maxWorkers', 'maxDurationMs', 'maxTasks', 'maxExperiments']) {
    if (!Number.isSafeInteger(value.budget[name]) || Number(value.budget[name]) < (name === 'maxExperiments' ? 0 : 1)) throw new AdmissionError('budget_invalid', 'budget_error', `Invalid budget ${name}`, `budget.${name}`)
  }
  if (value.budget.deadlineAt !== undefined && (!Number.isSafeInteger(value.budget.deadlineAt) || Number(value.budget.deadlineAt) < 1)) throw new AdmissionError('budget_invalid', 'budget_error', 'Invalid budget deadlineAt: use a positive safe integer Unix timestamp in milliseconds', 'budget.deadlineAt')
  const members = keyed(value.members, 'Members'), streams = keyed(value.workstreams, 'Workstreams'), tasks = keyed(value.tasks, 'Tasks')
  if (members.size > Number(value.budget.maxWorkers)) throw new AdmissionError('plan_roster_exceeds_budget', 'budget_error', 'Roster exceeds worker budget', 'members')
  if (tasks.size > Number(value.budget.maxTasks) || streams.size > Number(value.budget.maxTasks)) throw new AdmissionError('plan_tasks_exceed_budget', 'budget_error', 'Plan exceeds task/workstream budget', 'tasks')
  const names = new Set<string>()
  // Reserve every explicit name before assigning defaults, including names
  // later in the roster. The detached canonical plan persists the result so
  // admission retries retain the same display identities.
  for (const member of members.values()) inspectAdmission(() => {
    if (member.name === undefined) return
    text(member.name, `members[${member.key}].name`)
    if (names.has(member.name)) throw new AdmissionError('plan_member_name_duplicate', 'validation_error', `members[${member.key}].name duplicates another member; member names must be unique`, `members[${member.key}].name`)
    names.add(member.name)
  })
  // Field diagnostics are collected per record so the primary repairs one complete plan per round.
  for (const member of members.values()) inspectAdmission(() => {
    if (member.name === undefined) {
      const name = nextWorkerName(names)
      if (name === undefined) throw new AdmissionError('worker_name_pool_exhausted', 'budget_error', `[worker_name_pool_exhausted] members[${member.key}].name needs an explicit display name because the fixed worker-name pool has no unused names. Supply a unique \`name\` for this member and retry the same plan.`, `members[${member.key}].name`)
      member.name = name
      names.add(name)
    }
    text(member.role, `members[${member.key}].role`)
    for (const field of ['provider', 'model', 'reasoningEffort']) if (member[field] !== undefined) text(member[field], `members[${member.key}].${field}`)
    if (member.maxOutputTokens !== undefined && (!Number.isSafeInteger(member.maxOutputTokens) || Number(member.maxOutputTokens) < 1)) throw new AdmissionError('plan_output_tokens_invalid', 'validation_error', `members[${member.key}].maxOutputTokens must be a positive safe integer`, `members[${member.key}].maxOutputTokens`)
    if (member.provider !== undefined && member.model === undefined) throw new AdmissionError('plan_model_required', 'validation_error', `members[${member.key}].provider requires a selected model`, `members[${member.key}].provider`)
  })
  for (const stream of streams.values()) inspectAdmission(() => { text(stream.title, `workstreams[${stream.key}].title`); text(stream.objective, `workstreams[${stream.key}].objective`) })
  let experiments = 0
  for (const [index, task] of [...tasks.values()].entries()) {
    const at = `tasks[${index}] (${String(task.key)})`
    inspectAdmission(() => { text(task.title, `${at}.title`); text(task.objective, `${at}.objective`) })
    inspectAdmission(() => { if (typeof task.workstreamKey !== 'string' || !streams.has(task.workstreamKey)) throw new AdmissionError('plan_workstream_unknown', 'tool_error', `${at}.workstreamKey must name an existing workstream key`, `${at}.workstreamKey`) })
    const validKind = ['research', 'implementation', 'integration', 'verification'].includes(String(task.kind))
    if (!validKind) inspectAdmission(() => { throw new AdmissionError('plan_task_kind_invalid', 'validation_error', `${at}.kind must be research, implementation, integration or verification`, `${at}.kind`) })
    inspectAdmission(() => {
      strings(task.scope, `${at}.scope`)
      task.scope = normalizeScopeSelectors(task.scope as string[])
      assertScopeSelectors(task.scope as string[], `tasks[${index}].scope`, value.scope as string[])
    })
    inspectAdmission(() => strings(task.acceptance, `${at}.acceptance`))
    // A plan states its deliverables; nothing downstream has to read them out of
    // the objective prose. Empty is legal and means "writes no file".
    inspectAdmission(() => { if (task.outputs !== undefined) task.outputs = assertDeclaredOutputs(task.outputs, Array.isArray(task.scope) ? task.scope as string[] : [], at) })
    inspectAdmission(() => { if (task.maxRecoveryAttempts !== undefined && (!Number.isSafeInteger(task.maxRecoveryAttempts) || Number(task.maxRecoveryAttempts) < 1)) throw new AdmissionError('plan_recovery_limit_invalid', 'validation_error', `${at}.maxRecoveryAttempts must be a positive safe integer`, `${at}.maxRecoveryAttempts`) })
    inspectAdmission(() => { if (task.checkTimeoutMs !== undefined && (!Number.isSafeInteger(task.checkTimeoutMs) || Number(task.checkTimeoutMs) < 1 || Number(task.checkTimeoutMs) > 2147483647)) throw new AdmissionError('plan_check_timeout_invalid', 'validation_error', `${at}.checkTimeoutMs must be a positive integer within the platform timer range`, `${at}.checkTimeoutMs`) })
    if (validKind) inspectAdmission(() => requireHostChecks(String(task.kind), task.checks as string[] | undefined, `tasks[${index}]`, String(task.key), scripts))
    // Every task carries a finite step allocation and an advisory finding estimate.
    inspectAdmission(() => {
      const ceilings = normalizeTaskCeilings(task as TaskCeilingInput, Number((value.budget as Record<string, unknown>).maxSteps), `tasks[${index}]`)
      Object.assign(task, ceilings)
    })
    if (typeof task.objective === 'string') {
      const taskAcceptance = Array.isArray(task.acceptance) ? task.acceptance as string[] : []
      // R12-F9 at plan admission: a task with no content-carrying edge whose own
      // text assumes prior work would be prepared from the bare baseline and
      // surprise its member at submit. Same guard as propose(), same exits.
      for (const diagnostic of dependencyAssumptions({
        objective: task.objective,
        acceptance: taskAcceptance,
        dependencies: [...(Array.isArray(task.dependencies) ? task.dependencies as string[] : []), ...(typeof task.reviewOf === 'string' ? [task.reviewOf] : [])],
        replaces: Array.isArray(task.replaces) ? task.replaces as string[] : [],
      }, `${at}.objective`)) if (diagnostic.severity !== 'advisory') admissionIssues.push({ category: 'tool_error', diagnostics: [diagnostic], message: formatDiagnostic(diagnostic) })
    }
    inspectAdmission(() => { if (task.assigneeKey !== undefined && (typeof task.assigneeKey !== 'string' || !members.has(task.assigneeKey))) throw new AdmissionError('plan_assignee_unknown', 'tool_error', `${at}.assigneeKey must name an existing member key`, `${at}.assigneeKey`) })
    inspectAdmission(() => {
      if (task.assignmentMode !== undefined && task.assignmentMode !== 'preferred' && task.assignmentMode !== 'pinned') throw new AdmissionError('plan_assignment_mode_invalid', 'validation_error', `${at}.assignmentMode must be preferred or pinned`, `${at}.assignmentMode`)
      if (task.assignmentMode !== undefined && task.assigneeKey === undefined) throw new AdmissionError('plan_assignment_mode_invalid', 'validation_error', `${at}.assignmentMode requires assigneeKey`, `${at}.assignmentMode`)
    })
    inspectAdmission(() => { if (task.priority !== undefined && (!Number.isInteger(task.priority) || Number(task.priority) < 0 || Number(task.priority) > 100)) throw new AdmissionError('plan_priority_invalid', 'validation_error', `${at}.priority must be 0–100`, `${at}.priority`) })
    inspectAdmission(() => { if (task.experiment !== undefined && typeof task.experiment !== 'boolean') throw new AdmissionError('plan_experiment_invalid', 'validation_error', `${at}.experiment must be boolean`, `${at}.experiment`) })
    if (task.experiment === true) experiments++
    inspectAdmission(() => {
      if (task.dependencies !== undefined) strings(task.dependencies, `${at}.dependencies`, true)
      if (task.dependencies !== undefined) task.dependencies = normalizeReviewDependencies(String(task.kind), task.reviewOf as string | undefined, task.dependencies as string[])
      for (const dependency of (task.dependencies ?? []) as string[]) if (!tasks.has(dependency)) throw new AdmissionError('plan_dependency_unknown', 'validation_error', `${at}.dependencies names unknown task key ${JSON.stringify(dependency)}`, `${at}.dependencies`)
    })
    inspectAdmission(() => {
      if (task.kind === 'verification') {
        if (typeof task.reviewOf !== 'string' || !tasks.has(task.reviewOf)) throw new AdmissionError('plan_review_source_unknown', 'tool_error', `${at}.reviewOf must name the existing source task key this verification reviews`, `${at}.reviewOf`)
        const source = tasks.get(task.reviewOf)!
        if (source.kind === 'verification') throw new AdmissionError('plan_review_source_invalid', 'tool_error', `${at}.reviewOf cannot name another verification task`, `${at}.reviewOf`)
        if (task.assigneeKey && task.assigneeKey === source.assigneeKey) throw new AdmissionError('plan_review_independence_required', 'tool_error', `${at}.assigneeKey must differ from the reviewed source's assignee ${JSON.stringify(source.assigneeKey)}`, `${at}.assigneeKey`)
      } else if (task.reviewOf !== undefined) throw new AdmissionError('plan_review_not_verification', 'tool_error', `${at}.reviewOf is only valid on verification tasks`, `${at}.reviewOf`)
    })
  }
  if (experiments > Number(value.budget.maxExperiments)) inspectAdmission(() => { throw new AdmissionError('plan_experiments_exceed_budget', 'budget_error', 'Plan exceeds experiment budget', 'tasks') })
  if (admissionIssues.length) {
    // One refusal carrying every diagnostic; its message is the issues' text,
    // joined exactly as before the refusal was typed.
    const diagnostics = admissionIssues.flatMap(issue => issue.diagnostics)
    const category = CATEGORY_PRECEDENCE.find(candidate => admissionIssues.some(issue => issue.category === candidate))!
    throw new AdmissionError(diagnostics.length === 1 ? diagnostics[0]!.code : 'plan_invalid', category, admissionIssues.map(issue => issue.message).join('\n'), 'plan', diagnostics)
  }
  const raw = JSON.parse(JSON.stringify(value)) as PlanInput
  const plan: PlanInput = {
    title: raw.title, objective: raw.objective, workspace: raw.workspace, scope: raw.scope, acceptance: raw.acceptance,
    budget: { maxTokens: raw.budget.maxTokens, maxSteps: raw.budget.maxSteps, maxWorkers: raw.budget.maxWorkers,
      maxDurationMs: raw.budget.maxDurationMs, maxTasks: raw.budget.maxTasks, maxExperiments: raw.budget.maxExperiments,
      ...(raw.budget.deadlineAt === undefined ? {} : { deadlineAt: raw.budget.deadlineAt }) },
    members: raw.members.map(({ key, name, role, provider, model, reasoningEffort, maxOutputTokens }) => ({ key, name, role, provider, model, reasoningEffort, maxOutputTokens })),
    workstreams: raw.workstreams.map(({ key, title, objective }) => ({ key, title, objective })),
    tasks: raw.tasks.map(({ key, workstreamKey, title, objective, kind, scope, acceptance, outputs, checks, maxRecoveryAttempts, maxSteps, maxFindings, ceilingProvenance, checkTimeoutMs, priority, experiment, assigneeKey, assignmentMode, dependencies, reviewOf }) =>
      ({ key, workstreamKey, title, objective, kind, scope, acceptance, outputs, checks, maxRecoveryAttempts, maxSteps, maxFindings, ceilingProvenance, checkTimeoutMs, priority, experiment, assigneeKey, assignmentMode, dependencies, reviewOf })),
  }
  orderedTasks(plan.tasks)
  return plan
}

/** Include review edges so sources exist before their verification tasks are admitted. */
export function orderedTasks(tasks: PlanTask[]): PlanTask[] {
  const byKey = new Map(tasks.map(task => [task.key, task])), visiting = new Set<string>(), done = new Set<string>(), result: PlanTask[] = []
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error('Plan contains a dependency/review cycle')
    if (done.has(key)) return
    const task = byKey.get(key)
    if (!task) throw new Error('Unknown dependency')
    visiting.add(key)
    for (const dependency of [...(task.dependencies ?? []), ...(task.reviewOf ? [task.reviewOf] : [])]) visit(dependency)
    visiting.delete(key); done.add(key); result.push(task)
  }
  for (const task of tasks) visit(task.key)
  return result
}

/** Advisory preflight over the actual target project; never changes plan authority. */
export function planAdvisories(plan: PlanInput): AdmissionDiagnostic[] {
  const scripts = loadPackageScripts(plan.workspace)
  const diagnostics = [...reconcileObjectiveScope(plan.objective, plan.scope, 'objective'),
    ...reconcileDeliverableIgnores(plan.workspace, plan.objective, plan.acceptance, 'objective')]
  for (const task of plan.tasks) {
    diagnostics.push(...reconcileObjectiveScope(task.objective, task.scope, `tasks[${task.key}].objective`),
      ...reconcileDeliverableIgnores(plan.workspace, task.objective, task.acceptance, `tasks[${task.key}]`))
    for (const [index, command] of (task.checks ?? []).entries()) {
      const { preflight } = classifyCheck(command, scripts)
      if (preflight) diagnostics.push({ code: 'check_preflight', severity: 'advisory', location: `tasks[${task.key}].checks[${index}]`, message: preflight })
    }
  }
  return diagnostics
}
