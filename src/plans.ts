/** Pure validation shared by staged browser plans and their launch boundary. */
import { isAbsolute } from 'node:path'
import { assertScopeSelectors, classifyCheck, loadPackageScripts, dependencyAssumptions, formatDiagnostic, normalizeReviewDependencies, normalizeScopeSelectors, normalizeTaskCeilings, reconcileDeliverableIgnores, reconcileObjectiveScope, requireHostChecks, type AdmissionDiagnostic, type TaskCeilingInput } from './admission.ts'
import { nextWorkerName, type CheckSyntaxIssue, type PlanInput, type PlanTask } from './types.ts'

function record(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plan entries must be objects')
}
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 16000) throw new Error(`${label} must be nonempty text of at most 16000 characters`)
}
function strings(value: unknown, label: string, empty = false): asserts value is string[] {
  if (!Array.isArray(value) || (!empty && !value.length)) throw new Error(`${label} must be a ${empty ? '' : 'nonempty '}string array`)
  for (const item of value) text(item, label)
}
function keyed(value: unknown, label: string): Map<string, Record<string, unknown>> {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must contain at least one entry`)
  const result = new Map<string, Record<string, unknown>>()
  const field = label.toLowerCase(), example = `${field.slice(0, -1)}_1`
  const reference = field === 'tasks' ? 'dependencies and reviewOf refer to this key'
    : field === 'members' ? 'assigneeKey refers to this key' : 'workstreamKey refers to this key'
  for (const [index, item] of value.entries()) {
    record(item)
    const location = `${field}[${index}].key`
    if (typeof item.key !== 'string' || !item.key.trim()) throw new Error(`${location} is required: add a unique stable identifier such as "${example}". The name/title is not the identifier; ${reference}.`)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(item.key)) throw new Error(`${location} must be a stable identifier of 1–100 letters, digits, underscores or hyphens, starting with a letter or digit. For example: "${example}"; ${reference}.`)
    if (result.has(item.key)) throw new Error(`${location} duplicates ${JSON.stringify(item.key)}. Assign a different unique key and update its references; ${reference}.`)
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

/** Fail before any workers or worktrees are created. Returns a detached canonical plan. */
export function validatePlan(value: unknown): PlanInput {
  record(value)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1048576) throw new Error('Plan exceeds 1 MiB')
  // Canonicalize a detached wire copy so retries and saved caller drafts are unchanged.
  value = JSON.parse(JSON.stringify(value))
  record(value)
  text(value.title, 'Title'); text(value.objective, 'Objective'); text(value.workspace, 'Workspace')
  if (!isAbsolute(value.workspace)) throw new Error('Workspace must be absolute')
  strings(value.scope, 'Mission scope'); strings(value.acceptance, 'Mission acceptance')
  value.scope = normalizeScopeSelectors(value.scope)
  // Return related scope/check corrections together so the primary repairs one full plan.
  const admissionIssues: string[] = []
  const scripts = loadPackageScripts(String(value.workspace))
  const inspectAdmission = (inspect: () => void): void => {
    try { inspect() } catch (error) { admissionIssues.push(String(error instanceof Error ? error.message : error)) }
  }
  inspectAdmission(() => assertScopeSelectors(value.scope as string[], 'scope'))
  record(value.budget)
  for (const name of ['maxTokens', 'maxSteps', 'maxWorkers', 'maxDurationMs', 'maxTasks', 'maxExperiments']) {
    if (!Number.isSafeInteger(value.budget[name]) || Number(value.budget[name]) < (name === 'maxExperiments' ? 0 : 1)) throw new Error(`Invalid budget ${name}`)
  }
  if (value.budget.deadlineAt !== undefined && (!Number.isSafeInteger(value.budget.deadlineAt) || Number(value.budget.deadlineAt) < 1)) throw new Error('Invalid budget deadlineAt: use a positive safe integer Unix timestamp in milliseconds')
  // Mission-level write directives and named deliverables reconcile before any task is admitted.
  for (const diagnostic of reconcileObjectiveScope(String(value.objective), value.scope as string[], 'objective')) if (diagnostic.severity !== 'advisory') admissionIssues.push(formatDiagnostic(diagnostic))
  for (const diagnostic of reconcileDeliverableIgnores(String(value.workspace), String(value.objective), value.acceptance as string[], 'objective')) if (diagnostic.severity !== 'advisory') admissionIssues.push(formatDiagnostic(diagnostic))
  const members = keyed(value.members, 'Members'), streams = keyed(value.workstreams, 'Workstreams'), tasks = keyed(value.tasks, 'Tasks')
  if (members.size > Number(value.budget.maxWorkers)) throw new Error('Roster exceeds worker budget')
  if (tasks.size > Number(value.budget.maxTasks) || streams.size > Number(value.budget.maxTasks)) throw new Error('Plan exceeds task/workstream budget')
  const names = new Set<string>()
  // Reserve every explicit name before assigning defaults, including names
  // later in the roster. The detached canonical plan persists the result so
  // admission retries retain the same display identities.
  for (const member of members.values()) inspectAdmission(() => {
    if (member.name === undefined) return
    text(member.name, `members[${member.key}].name`)
    if (names.has(member.name)) throw new Error(`members[${member.key}].name duplicates another member; member names must be unique`)
    names.add(member.name)
  })
  // Field diagnostics are collected per record so the primary repairs one complete plan per round.
  for (const member of members.values()) inspectAdmission(() => {
    if (member.name === undefined) {
      const name = nextWorkerName(names)
      if (name === undefined) throw new Error(`[worker_name_pool_exhausted] members[${member.key}].name needs an explicit display name because the fixed worker-name pool has no unused names. Supply a unique \`name\` for this member and retry the same plan.`)
      member.name = name
      names.add(name)
    }
    text(member.role, `members[${member.key}].role`)
    for (const field of ['provider', 'model', 'reasoningEffort']) if (member[field] !== undefined) text(member[field], `members[${member.key}].${field}`)
    if (member.maxOutputTokens !== undefined && (!Number.isSafeInteger(member.maxOutputTokens) || Number(member.maxOutputTokens) < 1)) throw new Error(`members[${member.key}].maxOutputTokens must be a positive safe integer`)
    if (member.provider !== undefined && member.model === undefined) throw new Error(`members[${member.key}].provider requires a selected model`)
  })
  for (const stream of streams.values()) inspectAdmission(() => { text(stream.title, `workstreams[${stream.key}].title`); text(stream.objective, `workstreams[${stream.key}].objective`) })
  let experiments = 0
  for (const [index, task] of [...tasks.values()].entries()) {
    const at = `tasks[${index}] (${String(task.key)})`
    inspectAdmission(() => { text(task.title, `${at}.title`); text(task.objective, `${at}.objective`) })
    inspectAdmission(() => { if (typeof task.workstreamKey !== 'string' || !streams.has(task.workstreamKey)) throw new Error(`${at}.workstreamKey must name an existing workstream key`) })
    const validKind = ['research', 'implementation', 'integration', 'verification'].includes(String(task.kind))
    if (!validKind) admissionIssues.push(`${at}.kind must be research, implementation, integration or verification`)
    inspectAdmission(() => {
      strings(task.scope, `${at}.scope`)
      task.scope = normalizeScopeSelectors(task.scope as string[])
      assertScopeSelectors(task.scope as string[], `tasks[${index}].scope`, value.scope as string[])
    })
    inspectAdmission(() => strings(task.acceptance, `${at}.acceptance`))
    inspectAdmission(() => { if (task.maxRecoveryAttempts !== undefined && (!Number.isSafeInteger(task.maxRecoveryAttempts) || Number(task.maxRecoveryAttempts) < 1)) throw new Error(`${at}.maxRecoveryAttempts must be a positive safe integer`) })
    inspectAdmission(() => { if (task.checkTimeoutMs !== undefined && (!Number.isSafeInteger(task.checkTimeoutMs) || Number(task.checkTimeoutMs) < 1 || Number(task.checkTimeoutMs) > 2147483647)) throw new Error(`${at}.checkTimeoutMs must be a positive integer within the platform timer range`) })
    if (validKind) inspectAdmission(() => requireHostChecks(String(task.kind), task.checks as string[] | undefined, `tasks[${index}]`, String(task.key), scripts))
    // Every task carries a finite step allocation and an advisory finding estimate.
    inspectAdmission(() => {
      const ceilings = normalizeTaskCeilings(task as TaskCeilingInput, Number((value.budget as Record<string, unknown>).maxSteps), `tasks[${index}]`)
      Object.assign(task, ceilings)
    })
    if (typeof task.objective === 'string') {
      const taskScope = Array.isArray(task.scope) ? task.scope as string[] : []
      const taskAcceptance = Array.isArray(task.acceptance) ? task.acceptance as string[] : []
      for (const diagnostic of reconcileObjectiveScope(task.objective, taskScope, `${at}.objective`)) if (diagnostic.severity !== 'advisory') admissionIssues.push(formatDiagnostic(diagnostic))
      for (const diagnostic of reconcileDeliverableIgnores(String(value.workspace), task.objective, taskAcceptance, at)) if (diagnostic.severity !== 'advisory') admissionIssues.push(formatDiagnostic(diagnostic))
      // R12-F9 at plan admission: a task with no content-carrying edge whose own
      // text assumes prior work would be prepared from the bare baseline and
      // surprise its member at submit. Same guard as propose(), same exits.
      for (const diagnostic of dependencyAssumptions({
        objective: task.objective,
        acceptance: taskAcceptance,
        dependencies: [...(Array.isArray(task.dependencies) ? task.dependencies as string[] : []), ...(typeof task.reviewOf === 'string' ? [task.reviewOf] : [])],
        replaces: Array.isArray(task.replaces) ? task.replaces as string[] : [],
      }, `${at}.objective`)) if (diagnostic.severity !== 'advisory') admissionIssues.push(formatDiagnostic(diagnostic))
    }
    inspectAdmission(() => { if (task.assigneeKey !== undefined && (typeof task.assigneeKey !== 'string' || !members.has(task.assigneeKey))) throw new Error(`${at}.assigneeKey must name an existing member key`) })
    inspectAdmission(() => {
      if (task.assignmentMode !== undefined && task.assignmentMode !== 'preferred' && task.assignmentMode !== 'pinned') throw new Error(`${at}.assignmentMode must be preferred or pinned`)
      if (task.assignmentMode !== undefined && task.assigneeKey === undefined) throw new Error(`${at}.assignmentMode requires assigneeKey`)
    })
    inspectAdmission(() => { if (task.priority !== undefined && (!Number.isInteger(task.priority) || Number(task.priority) < 0 || Number(task.priority) > 100)) throw new Error(`${at}.priority must be 0–100`) })
    inspectAdmission(() => { if (task.experiment !== undefined && typeof task.experiment !== 'boolean') throw new Error(`${at}.experiment must be boolean`) })
    if (task.experiment === true) experiments++
    inspectAdmission(() => {
      if (task.dependencies !== undefined) strings(task.dependencies, `${at}.dependencies`, true)
      if (task.dependencies !== undefined) task.dependencies = normalizeReviewDependencies(String(task.kind), task.reviewOf as string | undefined, task.dependencies as string[])
      for (const dependency of (task.dependencies ?? []) as string[]) if (!tasks.has(dependency)) throw new Error(`${at}.dependencies names unknown task key ${JSON.stringify(dependency)}`)
    })
    inspectAdmission(() => {
      if (task.kind === 'verification') {
        if (typeof task.reviewOf !== 'string' || !tasks.has(task.reviewOf)) throw new Error(`${at}.reviewOf must name the existing source task key this verification reviews`)
        const source = tasks.get(task.reviewOf)!
        if (source.kind === 'verification') throw new Error(`${at}.reviewOf cannot name another verification task`)
        if (task.assigneeKey && task.assigneeKey === source.assigneeKey) throw new Error(`${at}.assigneeKey must differ from the reviewed source's assignee ${JSON.stringify(source.assigneeKey)}`)
      } else if (task.reviewOf !== undefined) throw new Error(`${at}.reviewOf is only valid on verification tasks`)
    })
  }
  if (experiments > Number(value.budget.maxExperiments)) admissionIssues.push('Plan exceeds experiment budget')
  if (admissionIssues.length) throw new Error(admissionIssues.join('\n'))
  const raw = JSON.parse(JSON.stringify(value)) as PlanInput
  const plan: PlanInput = {
    title: raw.title, objective: raw.objective, workspace: raw.workspace, scope: raw.scope, acceptance: raw.acceptance,
    budget: { maxTokens: raw.budget.maxTokens, maxSteps: raw.budget.maxSteps, maxWorkers: raw.budget.maxWorkers,
      maxDurationMs: raw.budget.maxDurationMs, maxTasks: raw.budget.maxTasks, maxExperiments: raw.budget.maxExperiments,
      ...(raw.budget.deadlineAt === undefined ? {} : { deadlineAt: raw.budget.deadlineAt }) },
    members: raw.members.map(({ key, name, role, provider, model, reasoningEffort, maxOutputTokens }) => ({ key, name, role, provider, model, reasoningEffort, maxOutputTokens })),
    workstreams: raw.workstreams.map(({ key, title, objective }) => ({ key, title, objective })),
    tasks: raw.tasks.map(({ key, workstreamKey, title, objective, kind, scope, acceptance, checks, maxRecoveryAttempts, maxSteps, maxFindings, ceilingProvenance, checkTimeoutMs, priority, experiment, assigneeKey, assignmentMode, dependencies, reviewOf }) =>
      ({ key, workstreamKey, title, objective, kind, scope, acceptance, checks, maxRecoveryAttempts, maxSteps, maxFindings, ceilingProvenance, checkTimeoutMs, priority, experiment, assigneeKey, assignmentMode, dependencies, reviewOf })),
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
