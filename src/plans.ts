/** Pure validation shared by staged browser plans and their launch boundary. */
import { isAbsolute } from 'node:path'
import { assertScopeSelectors, normalizeReviewDependencies, normalizeScopeSelectors, requireHostChecks } from './admission.ts'
import type { PlanInput, PlanTask } from './types.ts'

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
  const inspectAdmission = (inspect: () => void): void => {
    try { inspect() } catch (error) { admissionIssues.push(String(error instanceof Error ? error.message : error)) }
  }
  inspectAdmission(() => assertScopeSelectors(value.scope as string[], 'scope'))
  record(value.budget)
  for (const name of ['maxTokens', 'maxSteps', 'maxWorkers', 'maxDurationMs', 'maxTasks', 'maxExperiments']) {
    if (!Number.isSafeInteger(value.budget[name]) || Number(value.budget[name]) < (name === 'maxExperiments' ? 0 : 1)) throw new Error(`Invalid budget ${name}`)
  }
  const members = keyed(value.members, 'Members'), streams = keyed(value.workstreams, 'Workstreams'), tasks = keyed(value.tasks, 'Tasks')
  if (members.size > Number(value.budget.maxWorkers)) throw new Error('Roster exceeds worker budget')
  if (tasks.size > Number(value.budget.maxTasks) || streams.size > Number(value.budget.maxTasks)) throw new Error('Plan exceeds task/workstream budget')
  const names = new Set<string>()
  for (const member of members.values()) {
    text(member.name, 'Member name'); text(member.role, 'Member role')
    if (names.has(member.name)) throw new Error('Member names must be unique')
    names.add(member.name)
    for (const field of ['provider', 'model', 'reasoningEffort']) if (member[field] !== undefined) text(member[field], field)
    if (member.maxOutputTokens !== undefined && (!Number.isSafeInteger(member.maxOutputTokens) || Number(member.maxOutputTokens) < 1)) throw new Error('maxOutputTokens must be a positive safe integer')
    if (member.provider !== undefined && member.model === undefined) throw new Error('A selected provider requires a selected model')
  }
  for (const stream of streams.values()) { text(stream.title, 'Workstream title'); text(stream.objective, 'Workstream objective') }
  let experiments = 0
  for (const [index, task] of [...tasks.values()].entries()) {
    text(task.title, 'Task title'); text(task.objective, 'Task objective')
    if (typeof task.workstreamKey !== 'string' || !streams.has(task.workstreamKey)) throw new Error('Unknown task workstream')
    if (!['research', 'implementation', 'integration', 'verification'].includes(String(task.kind))) throw new Error('Invalid task kind')
    strings(task.scope, 'Task scope'); strings(task.acceptance, 'Task acceptance')
    task.scope = normalizeScopeSelectors(task.scope)
    inspectAdmission(() => assertScopeSelectors(task.scope as string[], `tasks[${index}].scope`, value.scope as string[]))
    if (task.maxRecoveryAttempts !== undefined && (!Number.isSafeInteger(task.maxRecoveryAttempts) || Number(task.maxRecoveryAttempts) < 1)) throw new Error('maxRecoveryAttempts must be a positive safe integer')
    if (task.checkTimeoutMs !== undefined && (!Number.isSafeInteger(task.checkTimeoutMs) || Number(task.checkTimeoutMs) < 1 || Number(task.checkTimeoutMs) > 2147483647)) throw new Error('checkTimeoutMs must be a positive integer within the platform timer range')
    inspectAdmission(() => requireHostChecks(String(task.kind), task.checks as string[] | undefined, `tasks[${index}]`, String(task.key)))
    if (task.assigneeKey !== undefined && (typeof task.assigneeKey !== 'string' || !members.has(task.assigneeKey))) throw new Error('Unknown task assignee')
    if (task.priority !== undefined && (!Number.isInteger(task.priority) || Number(task.priority) < 0 || Number(task.priority) > 100)) throw new Error('Priority must be 0–100')
    if (task.experiment !== undefined && typeof task.experiment !== 'boolean') throw new Error('experiment must be boolean')
    if (task.experiment) experiments++
    if (task.dependencies !== undefined) strings(task.dependencies, 'Dependencies', true)
    if (task.dependencies !== undefined) task.dependencies = normalizeReviewDependencies(String(task.kind), task.reviewOf as string | undefined, task.dependencies as string[])
    for (const dependency of (task.dependencies ?? []) as string[]) if (!tasks.has(dependency)) throw new Error('Unknown dependency')
    if (task.kind === 'verification') {
      if (typeof task.reviewOf !== 'string' || !tasks.has(task.reviewOf)) throw new Error('Verification requires an existing reviewOf key')
      const source = tasks.get(task.reviewOf)!
      if (source.kind === 'verification') throw new Error('Verification cannot review another verification')
      if (task.assigneeKey && task.assigneeKey === source.assigneeKey) throw new Error('Review must be assigned to a different member')
    } else if (task.reviewOf !== undefined) throw new Error('Only verification tasks can set reviewOf')
  }
  if (admissionIssues.length) throw new Error(admissionIssues.join('\n'))
  if (experiments > Number(value.budget.maxExperiments)) throw new Error('Plan exceeds experiment budget')
  const raw = JSON.parse(JSON.stringify(value)) as PlanInput
  const plan: PlanInput = {
    title: raw.title, objective: raw.objective, workspace: raw.workspace, scope: raw.scope, acceptance: raw.acceptance,
    budget: { maxTokens: raw.budget.maxTokens, maxSteps: raw.budget.maxSteps, maxWorkers: raw.budget.maxWorkers,
      maxDurationMs: raw.budget.maxDurationMs, maxTasks: raw.budget.maxTasks, maxExperiments: raw.budget.maxExperiments },
    members: raw.members.map(({ key, name, role, provider, model, reasoningEffort, maxOutputTokens }) => ({ key, name, role, provider, model, reasoningEffort, maxOutputTokens })),
    workstreams: raw.workstreams.map(({ key, title, objective }) => ({ key, title, objective })),
    tasks: raw.tasks.map(({ key, workstreamKey, title, objective, kind, scope, acceptance, checks, maxRecoveryAttempts, checkTimeoutMs, priority, experiment, assigneeKey, dependencies, reviewOf }) =>
      ({ key, workstreamKey, title, objective, kind, scope, acceptance, checks, maxRecoveryAttempts, checkTimeoutMs, priority, experiment, assigneeKey, dependencies, reviewOf })),
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
