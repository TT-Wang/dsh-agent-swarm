/** Durable collaboration policy. Worker lifecycle and filesystem effects belong to the adapter. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { SwarmStore } from './store.ts'
import { assertScopeSelectors, normalizeReviewDependencies, normalizeScopeSelectors, requireHostChecks } from './admission.ts'
import { orderedTasks, validatePlan } from './plans.ts'
import type { Actor, Artifact, AutoStart, Budget, CreateMissionInput, Delivery, DraftPlan, Evidence, EvidenceStatus, Member, Mission, ObserveQuery, PlanInput, ProposeTaskInput, PublishInput, RequestStartInput, RuntimeConfig, Snapshot, Task, ToolRun, UsageBuckets, WorkerAdapter, WorkerActivity, Workstream } from './types.ts'

const id = (prefix: string) => `${prefix}_${randomUUID()}`
const terminal = (mission: Mission) => mission.status === 'stopped' || mission.status === 'completed'
/** Host verification timeout when a task chose none; matches the plugin config default. */
const DEFAULT_CHECK_TIMEOUT_MS = 60000
/** Extra lease headroom per allowed output token while a model stream is observably live. */
const LEASE_MS_PER_OUTPUT_TOKEN = 20
const DEFAULT_BUDGET_WARN_AT: readonly number[] = [0.7, 0.9]
/** Idle close-out nudges before an open attempt is checkpointed and re-pended. */
const DEFAULT_IDLE_CLOSEOUTS = 2
/** A worker-side git write that the sandbox refused; the action names the supported exit. */
const gitWriteDeniedMessage = (command: string): string => `Worker git writes are denied by the workspace sandbox: ${command} could not write git metadata (index.lock EPERM). Workers cannot commit; do not retry git add/commit. Publish the workspace with swarm_submit, which captures it host-side, or release the attempt with swarm_handoff/swarm_wait.`
const USAGE_KEYS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens', 'requests'] as const
export const emptyUsage = (): UsageBuckets => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, requests: 0 })
export function addUsage(base: UsageBuckets | undefined, delta: UsageBuckets): UsageBuckets {
  const result = { ...(base ?? emptyUsage()) }
  for (const key of USAGE_KEYS) result[key] += Math.max(0, delta[key])
  return result
}
/** Cumulative logs never shrink; a smaller bucket means a replayed snapshot and contributes nothing. */
function usageDelta(next: UsageBuckets, previous: UsageBuckets | undefined): UsageBuckets {
  const result = emptyUsage()
  for (const key of USAGE_KEYS) result[key] = Math.max(0, next[key] - (previous?.[key] ?? 0))
  return result
}
function validUsage(value: unknown): value is UsageBuckets {
  return value !== null && typeof value === 'object' && USAGE_KEYS.every(key => Number.isSafeInteger((value as Record<string, unknown>)[key]) && Number((value as Record<string, unknown>)[key]) >= 0)
}
/** Bounded text for model-visible views; the stored record remains complete. */
function excerpt(value: unknown, limit: number): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}… [${raw.length - limit} more chars]`
}
function requireText(value: string, name: string): void { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`) }
function requireStrings(value: string[], name: string): void {
  if (!Array.isArray(value) || value.length === 0 || !value.every(x => typeof x === 'string' && x.trim())) throw new Error(`${name} must contain nonempty strings`)
}
function validatedBudget(input: Budget): Budget {
  const budget = {} as Budget
  for (const key of ['maxTokens', 'maxSteps', 'maxWorkers', 'maxDurationMs', 'maxTasks', 'maxExperiments'] as const) {
    const value = input?.[key]
    if (!Number.isSafeInteger(value) || value < (key === 'maxExperiments' ? 0 : 1)) throw new Error(`Invalid budget ${key}`)
    budget[key] = value
  }
  return budget
}

/** A single runtime owns scheduling, admission, state transitions and a durable outbox. */
export class SwarmRuntime {
  readonly store: SwarmStore
  private readonly listeners = new Set<(missionId: string) => void>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly scheduled = new Set<string>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly startControllers = new Map<string, AbortController>()
  private readonly budgetStops = new Set<string>()
  /** Members that ended a turn while still owning an attempt; drives the bounded close-out. */
  private readonly idleSignals = new Map<string, { attemptId: string; at: number }>()
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private shuttingDown = false

  constructor(readonly config: RuntimeConfig, readonly workers: WorkerAdapter) {
    this.store = new SwarmStore(config.statePath)
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
    })
  }
  /** Recover active missions without requiring a live coordinator or user session. */
  async start(): Promise<void> {
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
    for (const mission of this.store.list('missions')) {
      if (terminal(mission)) {
        // A cold host has no surviving native worker handles for terminal work.
        this.commit(mission.id, () => {
          for (const member of this.store.list('members', mission.id)) {
            if (member.status !== 'stopped') { member.status = 'stopped'; this.store.put('members', member) }
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
            // A budget-pause stop is host policy, not a recovery failure: re-pend
            // without spending recovery credit so a long pause cannot kill the task.
            const pauseInduced = mission.budgetPause !== undefined || task.budgetResume !== undefined
            if (!pauseInduced) task.recoveryCount = (task.recoveryCount ?? 0) + 1
            task.status = !pauseInduced && (task.recoveryCount ?? 0) >= (task.maxRecoveryAttempts ?? this.config.maxTasksPerMember) ? 'blocked' : 'pending'
            task.epoch++; task.handoff = `${task.handoff ?? ''}\nRecovered after host restart; inspect prior tool runs and workspace before repeating effects.`
            delete task.attempt
            delete task.budgetResume
            this.store.put('tasks', task)
          }
        }
        for (const member of this.store.list('members', mission.id)) {
          if (member.status !== 'stopped') { member.status = 'idle'; this.store.put('members', member) }
        }
        this.store.event(mission.id, 'mission/recovered', 'runtime', {})
      })
      if (mission.status === 'active') await this.ensureWorkers(mission)
      this.kick(mission.id)
    }
    this.timer = setInterval(() => {
      for (const mission of this.store.list('missions')) {
        // Deadline cancellation cannot queue behind a long verification holding the mission queue.
        if (mission.status === 'active' && Date.now() >= mission.deadline) this.blockBudget(mission)
        else if (mission.status === 'active') this.warnBudget(mission)
        if (!terminal(mission)) this.kick(mission.id)
      }
    }, this.config.tickMs)
    this.timer.unref()
  }
  private async exclusive<T>(missionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(missionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(fn)
    this.queues.set(missionId, current)
    try { return await current } finally { if (this.queues.get(missionId) === current) this.queues.delete(missionId) }
  }
  private commit<T>(missionId: string, fn: () => T): T {
    if (this.closed) throw new Error('Swarm runtime is closed')
    const result = this.store.transaction(fn)
    for (const listener of this.listeners) { try { listener(missionId) } catch { /* A UI subscriber cannot roll back committed work. */ } }
    return result
  }
  /** Subscribe to committed state changes. */
  subscribe(listener: (missionId: string) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private mission(missionId: string): Mission {
    const mission = this.store.get('missions', missionId)
    if (!mission) throw new Error('Unknown mission')
    return mission
  }
  private participant(actor: Actor, missionId: string): { mission: Mission; member?: Member; key: string; owner: boolean } {
    const mission = this.mission(missionId)
    if (mission.ownerSessionId === actor.sessionId) return { mission, key: 'owner', owner: true }
    const member = this.store.list('members', missionId).find(m => m.sessionId === actor.sessionId && m.status !== 'stopped')
    if (!member) throw new Error('Session is not a participant in this mission')
    return { mission, member, key: member.id, owner: false }
  }
  private active(actor: Actor, missionId: string, allowStaged = false) {
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    actor.signal?.throwIfAborted()
    const participant = this.participant(actor, missionId)
    if (participant.mission.status !== 'active' && !(allowStaged && participant.owner && participant.mission.status === 'staged')) throw new Error(`Mission is ${participant.mission.status}`)
    if (participant.mission.budgetPause) throw new Error('Mission is waiting for budget-pause quiescence and a fresh resume assignment')
    if (participant.mission.status !== 'staged' && Date.now() >= participant.mission.deadline) throw new Error('Mission duration budget exhausted')
    return participant
  }
  private task(missionId: string, taskId: string): Task {
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
  private effectiveDependencies(missionId: string, task: Task): Task[] {
    const seen = new Set<string>()
    return task.dependencies.map(dep => this.effectiveDependency(missionId, dep)).filter(dependency => !seen.has(dependency.id) && seen.add(dependency.id))
  }
  private effectiveDependency(missionId: string, dependencyId: string, tasks?: Task[]): Task { return this.lineage(missionId, dependencyId, tasks).at(-1)! }
  private dependencySatisfied(missionId: string, dependencyId: string, tasks?: Task[]): boolean { return this.effectiveDependency(missionId, dependencyId, tasks).status === 'accepted' }
  /** Every identity a dependency reference stands for, including the current effective repair. */
  private dependencyIdentities(missionId: string, dependencyId: string, tasks?: Task[]): Set<string> { return new Set(this.lineage(missionId, dependencyId, tasks).map(task => task.id)) }
  private ownAttempt(actor: Actor, missionId: string, taskId: string, attemptId: string): { task: Task; member: Member } {
    const { member } = this.active(actor, missionId)
    const task = this.task(missionId, taskId)
    if (!member || task.status !== 'running' || !task.attempt || task.attempt.id !== attemptId || task.attempt.ownerId !== member.id || task.attempt.leaseUntil < Date.now()) throw new Error('Stale or unauthorized task attempt; stop work and observe the current assignment')
    if (!task.dependencies.every(dep => this.dependencySatisfied(missionId, dep))) throw new Error('A task prerequisite is no longer accepted; stop work')
    return { task, member }
  }
  /**
   * Extend the current attempt's lease before a long host operation. Bounded by
   * the mission deadline so a stored lease can never outlive the mission.
   */
  private fenceAttempt(mission: Mission, task: Task, windowMs: number): void {
    if (!task.attempt) throw new Error('Task has no active attempt')
    const leaseUntil = Math.min(mission.deadline, Date.now() + Math.max(this.config.leaseMs, windowMs))
    if (!Number.isSafeInteger(leaseUntil)) throw new Error('Attempt lease exceeds the supported clock range')
    task.attempt.leaseUntil = leaseUntil
    this.commit(mission.id, () => this.store.put('tasks', task))
  }
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
  private bounded(text: string): string {
    requireText(text, 'content')
    if (text.length > this.config.maxMessageChars) throw new Error(`Content exceeds ${this.config.maxMessageChars} characters`)
    return text
  }
  /**
   * Owner notices wake the primary agent and replay its whole context, so only
   * decisions, blockers, failures, budget exhaustion and final delivery use
   * them. Routine progress is already a durable event shown by the UI.
   */
  private notify(missionId: string, content: string, from = 'runtime'): void {
    this.store.put('deliveries', { id: id('msg'), missionId, from, to: 'owner', kind: 'control', content, createdAt: Date.now() })
  }
  /** Create a mission with explicitly bounded resources and scope. */
  create(actor: Actor, input: CreateMissionInput, initial: { id?: string; status?: 'active' | 'staged' } = {}): Mission {
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    if (this.store.list('members').some(m => m.sessionId === actor.sessionId)) throw new Error('Workers cannot create independent missions or budgets')
    requireText(input.title, 'title'); requireText(input.objective, 'objective')
    if (!isAbsolute(input.workspace)) throw new Error('workspace must be an absolute path')
    requireStrings(input.scope, 'scope'); requireStrings(input.acceptance, 'acceptance')
    input = { ...input, scope: normalizeScopeSelectors(input.scope) }
    assertScopeSelectors(input.scope, 'scope')
    const budget = validatedBudget(input.budget)
    const now = Date.now()
    if (!Number.isSafeInteger(now + budget.maxDurationMs)) throw new Error('Mission duration exceeds the supported clock range')
    const mission: Mission = { ...input, budget, id: initial.id ?? id('mission'), ownerSessionId: actor.sessionId, status: initial.status ?? 'active', usedTokens: 0, usedSteps: 0, createdAt: now, updatedAt: now, deadline: now + budget.maxDurationMs }
    if (this.store.get('missions', mission.id)) throw new Error('Mission already exists')
    this.commit(mission.id, () => { this.store.put('missions', mission); this.store.event(mission.id, 'mission/created', 'owner', mission) })
    return mission
  }
  /** Owner-only membership admission keeps authority and aggregate capacity bounded. */
  async addMember(actor: Actor, missionId: string, input: { name: string; role: string; model?: string; provider?: string; reasoningEffort?: string; maxOutputTokens?: number; subscriptions?: string[] }, admittedId?: string): Promise<Member> {
    return this.exclusive(missionId, async () => {
      const { mission, owner } = this.active(actor, missionId, admittedId !== undefined)
      if (!owner) throw new Error('Only the mission owner can add workers; send a bounded collaborator request')
      requireText(input.name, 'name'); requireText(input.role, 'role')
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
        if (prior.missionId !== missionId || prior.name !== input.name || prior.status === 'stopped') throw new Error('Member admission identity conflict')
        await this.workers.start({ mission, member: prior, ownerSessionId: mission.ownerSessionId })
        return prior
      }
      const members = this.store.list('members', missionId)
      if (members.filter(m => m.status !== 'stopped').length >= mission.budget.maxWorkers) throw new Error('Mission worker budget exhausted')
      if (members.some(m => m.name === input.name)) throw new Error('Worker name already exists')
      const memberId = admittedId ?? id('member')
      if (!mission.baseline && this.workers.prepareBaseline) {
        const baseline = await this.workers.prepareBaseline(mission, actor.signal)
        const current = this.active(actor, missionId, admittedId !== undefined).mission
        current.baseline = baseline; mission.baseline = baseline
        this.commit(missionId, () => { this.store.put('missions', current); this.store.event(missionId, 'workspace/snapshot', 'runtime', baseline) })
      }
      const workspace = await this.workers.prepareWorkspace(mission, memberId)
      this.active(actor, missionId, admittedId !== undefined)
      const member: Member = { id: memberId, missionId, name: input.name, role: input.role, model: input.model, provider: input.provider, reasoningEffort: input.reasoningEffort, maxOutputTokens: input.maxOutputTokens, sessionId: id('swarm-session'), workspace, status: 'idle', subscriptions: input.subscriptions === undefined ? [] : [...new Set(input.subscriptions)] }
      this.commit(missionId, () => { this.store.put('members', member); this.store.event(missionId, 'member/added', 'owner', member) })
      try { await this.workers.start({ mission, member, ownerSessionId: mission.ownerSessionId }) }
      catch (error) {
        if (this.shuttingDown || this.mission(missionId).status !== 'active') throw error
        member.status = 'stopped'
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
    if (input.coordinatorId && !this.store.list('members', missionId).some(m => m.id === input.coordinatorId && m.status !== 'stopped')) throw new Error('Unknown coordinator')
    const stream: Workstream = { ...input, id: admittedId ?? id('stream'), missionId }
    if (this.store.list('workstreams', missionId).length >= this.mission(missionId).budget.maxTasks) throw new Error('Workstream admission budget exhausted')
    this.commit(missionId, () => { this.store.put('workstreams', stream); this.store.event(missionId, 'workstream/created', key, stream) })
    return stream
  }
  /** Distributed task proposals are admitted by deterministic scope, budget and dependency rules. */
  propose(actor: Actor, missionId: string, input: ProposeTaskInput, admittedId?: string): Task {
    const { mission, key, owner } = this.active(actor, missionId, admittedId !== undefined)
    const prior = admittedId ? this.store.get('tasks', admittedId) : undefined
    if (prior) { if (prior.missionId !== missionId) throw new Error('Task identity conflict'); return prior }
    if (this.store.list('starts', missionId).length) {
      if (!owner) {
        // Workers may extend the board but cannot enlarge execution policy set
        // by the primary agent. Follow the source/repair/prerequisite lineage.
        const reference = input.reviewOf ?? input.replaces?.[0] ?? input.dependencies?.[0]
        const origin = reference ? this.task(missionId, reference) : this.store.list('tasks', missionId)[0]
        const source = origin?.reviewOf ? this.task(missionId, origin.reviewOf) : origin
        input = { ...input, maxRecoveryAttempts: origin?.maxRecoveryAttempts,
          checkTimeoutMs: origin?.checkTimeoutMs ?? source?.checkTimeoutMs }
      }
      if (input.maxRecoveryAttempts === undefined) throw new Error('Automatic tasks require a recovery limit chosen by the primary agent')
      if (input.kind !== 'verification' && input.checks?.length && input.checkTimeoutMs === undefined) throw new Error('Automatic task checks require a timeout chosen by the primary agent')
    }
    requireText(input.title, 'title'); requireText(input.objective, 'objective'); requireStrings(input.acceptance, 'acceptance')
    if (!['research', 'implementation', 'verification', 'integration'].includes(input.kind)) throw new Error('Unknown task kind')
    requireStrings(input.scope, 'task.scope')
    input = { ...input, scope: normalizeScopeSelectors(input.scope) }
    assertScopeSelectors(input.scope, 'task.scope', mission.scope)
    const stream = this.store.get('workstreams', input.workstreamId)
    if (!stream || stream.missionId !== missionId) throw new Error('Unknown workstream')
    const tasks = this.store.list('tasks', missionId)
    if (tasks.length >= mission.budget.maxTasks) throw new Error('Mission task budget exhausted')
    if (input.experiment && tasks.filter(t => t.experiment).length >= mission.budget.maxExperiments) throw new Error('Mission experiment budget exhausted')
    if (input.priority !== undefined && (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 100)) throw new Error('priority must be an integer from 0 to 100')
    const dependencies = [...new Set(normalizeReviewDependencies(input.kind, input.reviewOf, input.dependencies))]
    for (const dependency of dependencies) {
      const effective = this.effectiveDependency(missionId, dependency, tasks)
      if (effective.status === 'cancelled' || effective.status === 'blocked') throw new Error(`Dependency ${dependency} is ${effective.status} and has no live replacement; depend on an accepted or in-progress task, or propose a repair with replaces`)
    }
    if (input.assigneeId && !this.store.list('members', missionId).some(m => m.id === input.assigneeId && m.status !== 'stopped')) throw new Error('Unknown assignee')
    if (input.kind === 'verification') {
      if (!input.reviewOf) throw new Error('Verification requires reviewOf')
      const source = this.task(missionId, input.reviewOf)
      if (source.kind === 'verification') throw new Error('Verification cannot review another verification task')
      if (source.status === 'cancelled' || source.status === 'accepted') throw new Error(`reviewOf ${source.id}: that task is already ${source.status}; a review can only start on submitted work`)
      const author = source.attempt?.ownerId ?? source.assigneeId
      if (input.assigneeId !== undefined && author !== undefined && input.assigneeId === author) throw new Error(`assigneeId ${input.assigneeId} authored ${source.id}; an independent review must be assigned to a different member or left unassigned`)
    } else if (input.reviewOf) throw new Error('Only verification tasks may set reviewOf')
    for (const previousId of input.replaces ?? []) {
      const previous = this.task(missionId, previousId)
      if (previous.kind === 'verification') throw new Error(`replaces ${previousId}: that is a verification task. Repair its reviewed source ${previous.reviewOf ?? ''} instead; a new review starts automatically when the repair is submitted`)
      // Resolve existing live replacements before the status check. The guard
      // must be reachable for exactly the blocked case it was written for: two
      // admitted replacements would make lineage ambiguous and stall every
      // dependent once both are accepted.
      const replacement = tasks.find(task => task.replaces?.includes(previousId) && task.status !== 'cancelled')
      if (previous.status !== 'blocked') {
        throw new Error(`replaces ${previousId}: that task is ${previous.status}, and only blocked work can be replaced${replacement ? `; it is already replaced by ${replacement.id} (${replacement.status})` : previous.status === 'pending' || previous.status === 'running' || previous.status === 'submitted' ? '; wait for its verdict or use swarm_handoff/challenge' : ''}`)
      }
      if (replacement !== undefined) throw new Error(`replaces ${previousId}: that blocked task is already replaced by ${replacement.id} (${replacement.status}); wait for its verdict, withdraw it with swarm_cancel, or repair that replacement instead of admitting a second one`)
      if (previous.resumeAfterStop?.epoch === previous.epoch) throw new Error(`replaces ${previousId}: that task is being reassigned after a handoff or lease expiry, not blocked for repair; observe again shortly`)
      if (previous.kind !== input.kind) throw new Error(`replaces ${previousId}: kind mismatch. The blocked task is ${previous.kind}; a replacement must also be ${previous.kind}`)
      const missing = previous.acceptance.filter(item => !input.acceptance.includes(item))
      if (missing.length) throw new Error(`replaces ${previousId}: replacement acceptance must include the original obligations verbatim. Missing: ${JSON.stringify(missing)}`)
      if (dependencies.includes(previousId)) throw new Error(`replaces ${previousId}: a repair cannot also depend on the blocked task it replaces`)
    }
    requireHostChecks(input.kind, input.checks, 'task', input.title)
    if (input.maxRecoveryAttempts !== undefined && (!Number.isSafeInteger(input.maxRecoveryAttempts) || input.maxRecoveryAttempts < 1)) throw new Error('maxRecoveryAttempts must be a positive safe integer')
    if (input.checkTimeoutMs !== undefined && (!Number.isSafeInteger(input.checkTimeoutMs) || input.checkTimeoutMs < 1 || input.checkTimeoutMs > 2147483647)) throw new Error('checkTimeoutMs must be a positive integer within the platform timer range')
    const task: Task = { id: admittedId ?? id('task'), missionId, workstreamId: input.workstreamId, title: input.title, objective: input.objective, kind: input.kind, dependencies, scope: input.scope, acceptance: input.acceptance, checks: input.checks ?? [], priority: input.priority ?? 50, experiment: input.experiment ?? false, assigneeId: input.assigneeId, reviewOf: input.reviewOf, status: 'pending', epoch: 0, evidenceIds: [], createdAt: Date.now() }
    if (input.replaces?.length) task.replaces = [...new Set(input.replaces)]
    if (input.assigneeId !== undefined) task.plannedAssigneeId = input.assigneeId
    if (input.maxRecoveryAttempts !== undefined) task.maxRecoveryAttempts = input.maxRecoveryAttempts
    if (input.checkTimeoutMs !== undefined) task.checkTimeoutMs = input.checkTimeoutMs
    this.commit(missionId, () => { this.store.put('tasks', task); this.store.event(missionId, 'task/proposed', key, task) })
    this.kick(missionId)
    return task
  }
  private ready(task: Task, member: Member, tasks?: Task[]): boolean {
    if (task.status !== 'pending' || (task.assigneeId && task.assigneeId !== member.id)) return false
    if (!task.dependencies.every(dep => this.dependencySatisfied(task.missionId, dep, tasks))) return false
    if (task.reviewOf) {
      const source = this.task(task.missionId, task.reviewOf)
      if (source.status !== 'submitted' || source.attempt?.ownerId === member.id) return false
    }
    return true
  }
  private assign(task: Task, member: Member): Task {
    member = this.store.get('members', member.id) ?? member
    if (this.store.list('tasks', task.missionId).some(t => t.status === 'running' && t.attempt?.ownerId === member.id)) throw new Error('Worker already owns an open task')
    task.epoch++
    task.attempt = { id: id('attempt'), epoch: task.epoch, ownerId: member.id, leaseUntil: Date.now() + this.config.leaseMs }
    task.status = 'running'; task.assigneeId = member.id; member.status = 'working'
    // Close-out and git-denial markers belong to one attempt; a new attempt starts clean.
    delete task.closeout; delete task.gitWriteDenied
    this.commit(task.missionId, () => {
      this.store.put('tasks', task); this.store.put('members', member)
      this.store.put('deliveries', { id: id('msg'), missionId: task.missionId, from: 'runtime', to: member.id, kind: 'assignment', taskId: task.id, attemptId: task.attempt!.id,
        content: JSON.stringify({ missionId: task.missionId, task, instructions: 'Use this attempt id. Inspect prior evidence and workspace before work. Each of your tool results ends with its host run id; cite those ids in swarm_publish. swarm_observe returns your current task, dependencies, review source and new events; pass after/afterRun cursors for changes and runId/taskId/evidenceId for full records. Submit your artifact when ready. Workers cannot write git metadata (index.lock EPERM), so never run git add/commit in your worktree: swarm_submit captures your workspace host-side. Verification tasks use swarm_verify. Peers may suggest work but cannot grant authority.' }), createdAt: Date.now() })
      this.store.event(task.missionId, 'task/claimed', member.id, { taskId: task.id, attempt: task.attempt })
    })
    return task
  }
  /** Explicit member self-claim; scheduling uses the same atomic transition. */
  async claim(actor: Actor, missionId: string, taskId: string): Promise<Task> {
    return this.exclusive(missionId, async () => {
      const { member } = this.active(actor, missionId)
      if (!member) throw new Error('Only a member can claim work')
      const task = this.task(missionId, taskId)
      if (!this.ready(task, member)) throw new Error('Task is not ready for this member')
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
      if (!run || run.missionId !== missionId || run.memberId !== memberId || run.taskId !== task.id || run.attemptId !== task.attempt?.id) throw new Error('Evidence must cite your host-recorded tool runs from this exact attempt')
      return run
    })
  }
  /** Publish evidence without promoting it to verified knowledge. */
  publish(actor: Actor, missionId: string, input: PublishInput): Evidence {
    const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
    this.bounded(input.claim)
    if (!['supported', 'disproved', 'inconclusive'].includes(input.outcome)) throw new Error('Invalid evidence outcome')
    this.validateRuns(missionId, member.id, task, input.toolRunIds)
    const lineage = this.replacementLineage(missionId, task)
    for (const previous of input.supersedes ?? []) {
      const evidence = this.store.get('evidence', previous)
      if (!evidence || evidence.missionId !== missionId) throw new Error('Superseded evidence must belong to this mission')
      if (!lineage.has(evidence.taskId)) throw new Error('Superseded evidence must belong to this task or its replacement lineage')
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
      if (task.kind === 'verification') throw new Error('Verification tasks must use swarm_verify')
      this.bounded(input.output)
      if (task.kind === 'research' && task.evidenceIds.length === 0) throw new Error('Research submission requires host-backed evidence')
      this.fenceAttempt(this.mission(missionId), task, this.config.leaseMs)
      const artifact = await this.workers.captureArtifact(member, task)
      try { this.ownAttempt(actor, missionId, task.id, input.attemptId) }
      catch (error) {
        // The commit is durable even when the attempt lost its lease during capture.
        throw new Error(`Artifact ${artifact.commit} was captured but the attempt is no longer current; observe the task and submit again after reassignment (${error instanceof Error ? error.message : String(error)})`)
      }
      task.artifact = artifact; task.output = input.output; task.status = 'submitted'
      this.commit(missionId, () => {
        this.store.put('tasks', task)
        for (const evidenceId of task.evidenceIds) { const e = this.store.get('evidence', evidenceId)!; e.artifact = artifact; this.store.put('evidence', e) }
        // Submission is routine progress: the durable event reaches the UI; the reviewer receives its assignment.
        this.store.event(missionId, 'task/submitted', member.id, { taskId: task.id, artifact })
      })
      this.kick(missionId)
      return task
    })
  }
  /** Run host-controlled checks against the exact source artifact and accept or reject it. */
  async verify(actor: Actor, missionId: string, input: { taskId: string; attemptId: string; verdict: 'accept' | 'reject'; reason: string }): Promise<Task> {
    return this.exclusive(missionId, async () => {
      const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
      if (task.kind !== 'verification' || !task.reviewOf) throw new Error('This is not a verification task')
      const source = this.task(missionId, task.reviewOf)
      if (source.status !== 'submitted' || !source.artifact || source.attempt?.ownerId === member.id) throw new Error('Only independent verification of a submitted artifact is allowed')
      const artifact = source.artifact
      if (source.checks.length) {
        const checkTimeoutMs = source.checkTimeoutMs ?? this.config.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
        const verificationWindow = checkTimeoutMs * Math.max(1, source.checks.length) + this.config.leaseMs
        if (!Number.isSafeInteger(verificationWindow)) throw new Error('Verification check duration exceeds the supported clock range')
        this.fenceAttempt(this.mission(missionId), task, verificationWindow)
        this.ownAttempt(actor, missionId, task.id, input.attemptId)
      }
      const evidenceRevision = JSON.stringify(source.evidenceIds.map(eid => this.store.get('evidence', eid)))
      const checks = await this.workers.verifyArtifact(member, source, artifact, actor.signal)
      this.ownAttempt(actor, missionId, task.id, input.attemptId)
      const currentSource = this.task(missionId, source.id)
      if (currentSource.status !== 'submitted' || currentSource.artifact?.commit !== artifact.commit) throw new Error('Reviewed artifact changed during verification')
      if (evidenceRevision !== JSON.stringify(currentSource.evidenceIds.map(eid => this.store.get('evidence', eid)))) throw new Error('Evidence changed during verification; inspect the new challenge and verify again')
      const independentRuns = this.store.list('tool_runs', missionId).filter(run => run.memberId === member.id && run.taskId === task.id && run.attemptId === input.attemptId && !run.isError)
      if (input.verdict === 'accept' && checks.length === 0 && independentRuns.length === 0) throw new Error('Acceptance requires independent host-recorded verification evidence')
      const passed = input.verdict === 'accept' && checks.every(c => c.exitCode === 0)
      const runIds: string[] = []
      this.commit(missionId, () => {
        let seq = this.store.countToolRuns(missionId)
        for (const check of checks) {
          const run: ToolRun = { id: id('run'), seq: ++seq, missionId, memberId: member.id, taskId: task.id, attemptId: input.attemptId, tool: 'swarm.host_verification', arguments: { command: check.command, commit: artifact.commit }, result: check, isError: check.exitCode !== 0, createdAt: Date.now() }
          this.store.put('tool_runs', run); runIds.push(run.id)
        }
        source.status = passed ? 'accepted' : 'blocked'
        task.status = passed ? 'accepted' : 'blocked'; task.output = this.bounded(input.reason); task.reviewedCommit = artifact.commit
        this.store.put('tasks', source); this.store.put('tasks', task)
        // Other pending reviews of this source can never start: the source is no longer submitted.
        for (const sibling of this.store.list('tasks', missionId)) {
          if (sibling.id !== task.id && sibling.reviewOf === source.id && sibling.status === 'pending') {
            sibling.status = 'cancelled'; sibling.output = `Superseded: ${source.id} was ${passed ? 'accepted' : 'rejected'} by review ${task.id}`
            this.store.put('tasks', sibling)
          }
        }
        if (passed) for (const previousId of source.replaces ?? []) {
          const previous = this.task(missionId, previousId)
          if (previous.status !== 'blocked') throw new Error('Replacement target changed during verification')
          previous.status = 'cancelled'; previous.output = `${previous.output ?? ''}\nSuperseded by independently accepted task ${source.id}`
          this.store.put('tasks', previous)
          for (const oldReview of this.store.list('tasks', missionId)) {
            if (oldReview.reviewOf === previousId && (oldReview.status === 'blocked' || oldReview.status === 'pending')) { oldReview.status = 'cancelled'; oldReview.output = `Superseded by review of replacement ${source.id}`; this.store.put('tasks', oldReview) }
          }
        }
        for (const evidenceId of source.evidenceIds) {
          const evidence = this.store.get('evidence', evidenceId)!
          // Status follows the verdict and the claim's own outcome: an inconclusive
          // claim is never promoted to verified knowledge.
          const status: EvidenceStatus = !passed ? 'challenged' : evidence.outcome === 'inconclusive' ? 'unverified' : 'verified'
          evidence.status = status
          this.store.put('evidence', evidence)
          if (status === 'verified') for (const previous of evidence.supersedes) {
            const old = this.store.get('evidence', previous)!
            old.status = 'refuted'; old.refutedBy = evidence.id; this.store.put('evidence', old)
          }
        }
        this.store.event(missionId, passed ? 'task/accepted' : 'task/rejected', member.id, { sourceTaskId: source.id, verificationTaskId: task.id, commit: artifact.commit, reason: input.reason, checks: runIds })
        // Acceptance is routine progress; a rejection blocks work and needs a repair decision.
        if (!passed) this.notify(missionId, `${source.title} (${source.id}) was blocked by independent verification: ${input.reason}. Repair it with a replacement task or adjust the plan.`, member.id)
      })
      // A verdict closes a unit of work for both sessions: let the adapter trim history it no longer needs.
      if (this.workers.compactAtBoundary) for (const memberId of new Set([source.attempt?.ownerId, member.id])) if (memberId) this.workers.compactAtBoundary(memberId)
      this.kick(missionId)
      return task
    })
  }
  private topicDelivery(missionId: string, from: string, topic: string, content: string): void {
    for (const member of this.store.list('members', missionId)) {
      if (member.id !== from && member.status !== 'stopped' && (member.subscriptions.includes(topic) || member.subscriptions.includes('*'))) {
        this.store.put('deliveries', { id: id('msg'), missionId, from, to: member.id, topic, kind: 'finding', content, createdAt: Date.now() })
      }
    }
  }
  /** Authenticated directed messages and selective topic broadcasts. */
  message(actor: Actor, missionId: string, input: { to: string; kind: 'question' | 'finding'; content: string; topic?: string }): { queued: boolean } {
    const { key } = this.active(actor, missionId)
    this.bounded(input.content)
    if (input.to !== 'owner' && input.to !== 'subscribers' && !this.store.list('members', missionId).some(m => m.id === input.to && m.status !== 'stopped')) throw new Error('Recipient is not a live mission member')
    if (input.to === 'subscribers' && !input.topic) throw new Error('Broadcast requires a topic')
    this.commit(missionId, () => {
      if (input.to === 'subscribers') this.topicDelivery(missionId, key, input.topic!, input.content)
      else this.store.put('deliveries', { id: id('msg'), missionId, from: key, to: input.to, kind: input.kind, content: input.content, topic: input.topic, createdAt: Date.now() })
      this.store.event(missionId, 'message/queued', key, input)
    })
    this.kick(missionId)
    return { queued: true }
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
          dependent.epoch++; delete dependent.attempt; dependent.status = dependent.kind === 'verification' ? 'cancelled' : 'blocked'
          dependent.output = `Prerequisite ${source.id} was challenged; inspect the new evidence and propose a replacement.`
          this.store.put('tasks', dependent)
          this.store.event(missionId, 'task/invalidated', 'runtime', { taskId: dependent.id, sourceTaskId: source.id, evidenceId: evidence.id })
        }
      }
      this.store.event(missionId, 'evidence/challenged', key, input)
      this.notify(missionId, `Evidence ${evidence.id} challenged: ${input.reason}`, key)
    })
    if (interrupted.size) this.defer(async () => { await Promise.all([...interrupted].map(memberId => this.workers.stop(memberId))) })
    this.kick(missionId)
    return evidence
  }
  /** Fence the old attempt immediately; quiescence and reassignment occur after this tool returns. */
  handoff(actor: Actor, missionId: string, input: { taskId: string; attemptId: string; to?: string; summary: string }): { handoff: string } {
    const { task, member } = this.ownAttempt(actor, missionId, input.taskId, input.attemptId)
    this.bounded(input.summary)
    if (input.to && !this.store.list('members', missionId).some(m => m.id === input.to && m.status !== 'stopped')) throw new Error('Unknown new owner')
    task.status = 'blocked'; task.handoff = input.summary; task.epoch++; task.assigneeId = input.to; delete task.attempt
    if (input.to !== undefined) task.plannedAssigneeId = input.to
    task.resumeAfterStop = { epoch: task.epoch, reason: 'handoff' }
    this.commit(missionId, () => { this.store.put('tasks', task); this.store.event(missionId, 'task/handoff-started', member.id, { taskId: task.id, to: input.to ?? null, summary: input.summary }) })
    this.defer(async () => {
      await this.workers.stop(member.id)
      await this.exclusive(missionId, async () => {
        const fresh = this.task(missionId, task.id)
        if (fresh.epoch !== task.epoch || fresh.status !== 'blocked') return
        const m = this.store.get('members', member.id)!
        m.status = 'idle'; fresh.status = 'pending'; delete fresh.resumeAfterStop
        this.commit(missionId, () => { this.store.put('tasks', fresh); this.store.put('members', m); this.store.event(missionId, 'task/handoff-ready', 'runtime', { taskId: fresh.id }) })
      })
      this.kick(missionId)
    })
    return { handoff: 'Ownership revoked; reassignment waits for the previous worker to stop. End your turn.' }
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
      if (member === undefined || member.status === 'stopped') return undefined
      member.status = 'idle'; delete member.activity
      return member
    }
    task.status = 'cancelled'; task.epoch++
    delete task.attempt; delete task.resumeAfterStop; delete task.budgetResume; delete task.closeout; delete task.gitWriteDenied
    task.output = `${task.output ?? ''}\nCancelled by the mission owner: ${input.reason}`.trim()
    const ownerMember = attempt === undefined ? undefined : releaseMember(attempt.ownerId)
    if (ownerMember !== undefined) released.add(ownerMember.id)
    this.commit(missionId, () => {
      this.store.put('tasks', task)
      if (ownerMember !== undefined) this.store.put('members', ownerMember)
      // Pending, running and quiescence-parked reviews of withdrawn work can
      // never reach a verdict; retire them explicitly so none re-pends after
      // lease expiry and becomes unclaimable against a cancelled source.
      for (const review of this.store.list('tasks', missionId)) {
        const moot = review.status === 'pending' || review.status === 'running' || (review.status === 'blocked' && review.resumeAfterStop !== undefined)
        if (review.id === task.id || review.reviewOf !== task.id || !moot) continue
        if (review.attempt !== undefined) {
          const reviewOwner = releaseMember(review.attempt.ownerId)
          if (reviewOwner !== undefined) { this.store.put('members', reviewOwner); released.add(reviewOwner.id) }
        }
        review.status = 'cancelled'; review.epoch++
        delete review.attempt; delete review.resumeAfterStop; delete review.budgetResume; delete review.closeout; delete review.gitWriteDenied
        review.output = `${review.output ?? ''}\nSuperseded: ${task.id} was cancelled by the mission owner`.trim()
        this.store.put('tasks', review)
      }
      this.store.event(missionId, 'task/cancelled', key, { taskId: task.id, reason: input.reason, previousStatus,
        ...(attempt === undefined ? {} : { attemptId: attempt.id, ownerId: attempt.ownerId }) })
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
    member.status = 'waiting'
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
    const request: AutoStart = { id: id('start'), ownerSessionId: actor.sessionId, commandId: input.commandId, goal, workspace: input.workspace,
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
      const baseline = await this.workers.prepareBaseline({ id: `mission_draft_${request.id}`, workspace: request.workspace }, actor.signal)
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
    const plan = validatePlan({ ...input, workspace: request.workspace })
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
    const memberMissions = new Set(this.store.list('members').filter(m => m.sessionId === actor.sessionId && m.status !== 'stopped').map(m => m.missionId))
    return this.store.list('missions').filter(m => m.ownerSessionId === actor.sessionId || memberMissions.has(m.id))
  }
  visibleSnapshots(actor: Actor): Snapshot[] { return this.visibleMissions(actor).map(m => this.snapshot(actor, m.id)) }
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
    const draft: DraftPlan = { id: admittedId ?? id('draft'), ownerSessionId: actor.sessionId, revision: 1, status: 'draft', input: validatePlan(input), createdAt: now, updatedAt: now }
    this.commit(draft.id, () => { this.store.put('drafts', draft); this.store.event(draft.id, 'plan/staged', 'owner', { draftId: draft.id, revision: draft.revision }) })
    return draft
  }
  updateDraft(actor: Actor, draftId: string, revision: number, input: PlanInput): DraftPlan {
    const draft = this.ownedDraft(actor, draftId)
    if (draft.revision !== revision) throw new Error('Draft changed; reload before saving')
    if (draft.status !== 'draft') throw new Error('Only unlaunched drafts can be edited; discard a failed launch to create a different plan')
    draft.input = validatePlan(input); draft.revision++; draft.updatedAt = Date.now()
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
          mission = this.create(actor, { title, objective, workspace, scope, acceptance, budget }, { id: missionId, status: 'staged' })
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
        if (mission.status !== 'staged') throw new Error('Plan assembly was interrupted')
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
    return { mission, members: this.store.list('members', missionId), workstreams: this.store.list('workstreams', missionId), tasks, evidence: this.store.list('evidence', missionId), events: this.store.events(missionId, this.config.maxEvents), pendingDeliveries: this.store.list('deliveries', missionId).filter(d => !d.deliveredAt).length,
      ...(deliveryTarget === undefined ? {} : { deliveryTarget }),
      completion: { eligible: completionReason === undefined, ...(completionReason === undefined ? {} : { reason: completionReason }) },
      ...(mission.appliedDelivery === undefined ? {} : { appliedDelivery: { resultCommit: mission.appliedDelivery.resultCommit, appliedAt: mission.appliedDelivery.appliedAt } }) }
  }
  /**
   * Bounded, focused model views. A member sees its current task, the
   * prerequisites and review source it needs, its own run references and new
   * events; the owner sees a compact board and usage. Full records are read by
   * id (`taskId`, `runId` paged by `offset`, `evidenceId`). The complete board
   * stays in the UI projection instead of every model request.
   */
  observe(actor: Actor, missionId: string, query: ObserveQuery = {}): unknown {
    actor.signal?.throwIfAborted()
    const { mission, member, owner } = this.participant(actor, missionId)
    for (const key of ['after', 'afterRun', 'offset'] as const) {
      if (query[key] !== undefined && (!Number.isSafeInteger(query[key]) || Number(query[key]) < 0)) throw new Error(`${key} must be a nonnegative integer`)
    }
    const tasks = this.store.list('tasks', missionId), members = this.store.list('members', missionId)
    const runRef = (run: ToolRun) => ({ id: run.id, seq: run.seq ?? 0, taskId: run.taskId, attemptId: run.attemptId, memberId: run.memberId, tool: run.tool, isError: run.isError, arguments: excerpt(run.arguments, 240) })
    const evidenceRef = (evidence: Evidence, full = false) => ({ id: evidence.id, taskId: evidence.taskId, authorId: evidence.authorId, claim: full ? evidence.claim : excerpt(evidence.claim, 400), outcome: evidence.outcome, status: evidence.status, toolRunIds: evidence.toolRunIds,
      ...(evidence.challenges.length ? { challenges: full ? evidence.challenges : evidence.challenges.length } : {}), ...(evidence.supersedes.length ? { supersedes: evidence.supersedes } : {}) })
    const taskRef = (task: Task) => ({ id: task.id, title: task.title, kind: task.kind, status: task.status, ...(task.assigneeId ? { assigneeId: task.assigneeId } : {}), ...(task.attempt ? { attemptOwner: task.attempt.ownerId } : {}),
      ...(task.reviewOf ? { reviewOf: task.reviewOf } : {}), ...(task.dependencies.length ? { dependencies: task.dependencies } : {}), ...(task.replaces?.length ? { replaces: task.replaces } : {}), ...(task.artifact ? { artifact: task.artifact.commit } : {}) })
    const taskRecord = (task: Task, outputLimit: number) => ({ ...task, ...(task.output !== undefined ? { output: excerpt(task.output, outputLimit) } : {}), ...(task.handoff !== undefined ? { handoff: excerpt(task.handoff, outputLimit) } : {}) })
    const evidenceOf = (task: Task, full = false) => task.evidenceIds.map(evidenceId => this.store.get('evidence', evidenceId)).filter((item): item is Evidence => item !== undefined).map(item => evidenceRef(item, full))
    const runsWindow = (filter: { memberId?: string; taskId?: string; attemptId?: string }, limit: number) => {
      const all = this.store.toolRuns(missionId, { ...filter, afterSeq: query.afterRun })
      const shown = query.afterRun === undefined ? all.slice(-limit) : all.slice(0, limit)
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
        ...(task.reviewOf ? { reviewSource: taskRef(this.task(missionId, task.reviewOf)) } : {}), ...runsWindow({ taskId: task.id }, 40) }
    }
    const eventLimit = 12
    const fetched = this.store.events(missionId, query.after ? eventLimit + 1 : eventLimit, query.after)
    const events = fetched.slice(0, eventLimit).map(event => ({ seq: event.seq, type: event.type, actor: event.actor, summary: excerpt(event.data, 240) }))
    const eventCursor = { ...(events.length ? { nextAfter: events.at(-1)!.seq } : {}), ...(fetched.length > eventLimit ? { moreEvents: true } : {}) }
    const budget = { usedTokens: mission.usedTokens, maxTokens: mission.budget.maxTokens, usedSteps: mission.usedSteps, maxSteps: mission.budget.maxSteps, deadline: mission.deadline, inFlightTokensEstimate: this.inFlightEstimate(members) }
    const full = query.detail === 'full'
    if (member) {
      const current = tasks.find(task => task.status === 'running' && task.attempt?.ownerId === member.id)
      const source = current?.reviewOf ? this.task(missionId, current.reviewOf) : undefined
      return {
        mission: { id: mission.id, title: mission.title, status: mission.status, ...budget },
        member: { id: member.id, name: member.name, role: member.role, status: member.status },
        current: current ? {
          task: taskRecord(current, 2400), attemptId: current.attempt!.id,
          dependencies: current.dependencies.map(dep => this.lineage(missionId, dep, tasks)).map(chain => ({ ...taskRef(chain.at(-1)!), output: excerpt(chain.at(-1)!.output ?? '', 600), ...(chain.length > 1 ? { replacementOf: chain.slice(0, -1).map(item => item.id) } : {}) })),
          ...(source ? { reviewSource: { ...taskRecord(source, 2400), evidence: evidenceOf(source) } } : {}),
        } : null,
        evidence: current ? evidenceOf(current) : [],
        ...runsWindow(current?.attempt ? { memberId: member.id, taskId: current.id, attemptId: current.attempt.id } : { memberId: member.id }, 20),
        events, ...eventCursor,
        board: full ? tasks.map(task => taskRecord(task, 2400)) : tasks.map(taskRef), members: members.map(item => ({ id: item.id, name: item.name, role: item.role, status: item.status })),
        detail: full ? 'Focused view with complete task records. taskId reads one task with full evidence and runs; runId with offset reads one stored run; evidenceId reads one claim; after/afterRun return only changes.' : 'Focused view. taskId reads one task with full evidence and runs; runId with offset reads one stored run; evidenceId reads one claim; after/afterRun return only changes.',
      }
    }
    const evidence = this.store.list('evidence', missionId)
    return {
      mission: { id: mission.id, title: mission.title, status: mission.status, ...(mission.reason ? { reason: mission.reason } : {}), ...budget, workerUsage: mission.workerUsage ?? emptyUsage(), ownerUsage: mission.ownerUsage ?? emptyUsage() },
      members: members.map(item => ({ id: item.id, name: item.name, role: item.role, status: item.status, ...(item.activity ? { activity: item.activity.kind } : {}), accountedTokens: item.accountedTokens ?? 0, requests: item.usage?.requests ?? 0 })),
      board: full ? tasks.map(task => taskRecord(task, 6000)) : tasks.map(taskRef),
      evidence: (full ? evidence : evidence.filter(item => item.status === 'challenged')).map(item => evidenceRef(item, full)),
      unschedulable: this.unschedulable(mission, tasks, members).map(task => task.id),
      pendingDeliveries: this.store.list('deliveries', missionId).filter(delivery => !delivery.deliveredAt).length,
      events, ...eventCursor,
      detail: full ? 'Complete task records and evidence claims; tool payloads are read by runId.' : 'Compact board. taskId reads one task with evidence and runs; detail=full expands every task record; after returns only newer events.',
      ...(owner ? {} : { note: 'Non-member observer' }),
    }
  }
  /** Requests already streaming have no reported usage yet; estimate each at its worker's average. */
  private inFlightEstimate(members: Member[]): number {
    let total = 0
    for (const member of members) {
      if (member.status === 'stopped') continue
      const activity = this.workers.currentActivity ? this.workers.currentActivity(member.id) : member.activity
      if (activity?.kind !== 'model') continue
      const requests = member.usage?.requests ?? 0
      if (requests > 0) total += Math.ceil((member.accountedTokens ?? 0) / requests)
    }
    return total
  }
  /** The runtime's unique deliverable among accepted artifacts; throws when none is unique. */
  private selectDeliveryTarget(missionId: string, tasks: Task[]): Task {
    const implementations = tasks.filter(task => task.kind === 'implementation' && task.status === 'accepted')
    // A dependency reference to a replaced original also covers its accepted repair.
    const covers = (task: Task, sourceId: string, seen = new Set<string>()): boolean => {
      if (seen.has(task.id)) return false
      seen.add(task.id)
      return task.dependencies.some(id => {
        const identities = this.dependencyIdentities(missionId, id, tasks)
        return identities.has(sourceId) || tasks.some(parent => identities.has(parent.id) && covers(parent, sourceId, seen))
      })
    }
    if (!tasks.some(task => task.kind === 'integration')) {
      // A single reviewed implementation is the deliverable when the plan needed no assembly step.
      if (implementations.length === 1 && implementations[0]!.artifact) return implementations[0]!
      throw new Error('A unique independently accepted implementation artifact is required when the plan has no integration task')
    }
    const candidates = tasks.filter(task => task.kind === 'integration' && task.status === 'accepted' && task.artifact && implementations.every(source => covers(task, source.id)))
    // A later integration may subsume an earlier one; never guess among independent final artifacts.
    const finals = candidates.filter(candidate => !candidates.some(other => other.id !== candidate.id && covers(other, candidate.id)))
    if (finals.length !== 1) throw new Error('A unique accepted integration of all implementation results is required')
    return finals[0]!
  }
  /** One completion policy is shared by manual controls and automatic requests. */
  private deliveryTarget(actor: Actor, missionId: string): { mission: Mission; task: Task } {
    actor.signal?.throwIfAborted()
    if (this.shuttingDown) throw new Error('Swarm runtime is shutting down')
    const mission = this.mission(missionId)
    if (mission.ownerSessionId !== actor.sessionId || this.isWorkerSession(actor.sessionId)) throw new Error('Only the mission owner can access deliverables')
    if (mission.status !== 'completed') throw new Error('Complete independent acceptance before applying results')
    if (!mission.baseline) throw new Error('This historical mission has no saved delivery baseline; inspect its retained artifact')
    return { mission, task: this.selectDeliveryTarget(missionId, this.store.list('tasks', missionId)) }
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
  /**
   * Tasks that can never be dispatched again: pending work whose dependency
   * lineage or review source is dead, reviews assigned to their own author, and
   * blocked work. They contribute nothing further; completion may cancel them
   * once every acceptance criterion is independently covered.
   */
  private unschedulable(mission: Mission, tasks: Task[], members: Member[]): Task[] {
    const live = members.filter(member => member.status !== 'stopped')
    const dead = new Set(tasks.filter(task => task.status === 'blocked').map(task => task.id))
    // Fixpoint: work waiting on dead prerequisites or an unreachable review source is dead too.
    for (let changed = true; changed;) {
      changed = false
      for (const task of tasks) {
        if (dead.has(task.id) || task.status !== 'pending') continue
        const stuck = task.dependencies.some(dep => { const effective = this.effectiveDependency(mission.id, dep, tasks); return effective.status === 'cancelled' || dead.has(effective.id) })
          || (task.reviewOf !== undefined && (() => {
            const source = this.task(mission.id, task.reviewOf)
            return source.status === 'cancelled' || source.status === 'accepted' || dead.has(source.id)
              || (task.assigneeId !== undefined && (source.attempt?.ownerId ?? source.assigneeId) === task.assigneeId)
          })())
          || (task.assigneeId !== undefined && !live.some(member => member.id === task.assigneeId))
        if (stuck) { dead.add(task.id); changed = true }
      }
    }
    return tasks.filter(task => dead.has(task.id))
  }
  /** Nothing is running, submitted or dispatchable: workers would stay idle forever. */
  private stalled(mission: Mission, tasks: Task[], members: Member[]): boolean {
    if (tasks.some(task => task.status === 'running' || task.status === 'submitted')) return false
    const live = members.filter(member => member.status !== 'stopped')
    return !tasks.some(task => task.status === 'pending' && live.some(member => this.ready(task, member, tasks)))
  }
  private completionError(mission: Mission, options: { cancelUnschedulable?: boolean } = {}): string | undefined {
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
  private completeAutomatic(missionId: string): boolean {
    const mission = this.mission(missionId)
    if (mission.status !== 'active' || !this.store.list('starts', missionId).length) return false
    const tasks = this.store.list('tasks', missionId), members = this.store.list('members', missionId)
    const strict = this.completionError(mission)
    const isStalled = strict !== undefined && this.stalled(mission, tasks, members)
    const relaxed = isStalled ? this.completionError(mission, { cancelUnschedulable: true }) : strict
    if (strict !== undefined && !(isStalled && relaxed === undefined)) {
      // The owner needs the gap that would remain after cancelling dead leftovers, not the leftovers themselves.
      if (isStalled) this.notifyStall(mission, tasks, members, relaxed ?? strict)
      return false
    }
    this.control({ sessionId: mission.ownerSessionId }, missionId, 'complete', isStalled
      ? 'Automatically completed: every acceptance criterion was independently covered and the remaining tasks could no longer be scheduled'
      : 'Automatically completed after independent verification satisfied all mission acceptance criteria')
    this.commit(missionId, () => {
      this.store.event(missionId, 'automatic/completed', 'runtime', {})
      this.notify(missionId, `Completed ${mission.title}: all required deliverables were independently accepted. Review the evidence and final artifact in Agent Swarm.`)
    })
    return true
  }
  /** Wake the owner once per distinct stalled state; idle workers cannot resolve it themselves. */
  private notifyStall(mission: Mission, tasks: Task[], members: Member[], reason: string): void {
    const leftover = this.unschedulable(mission, tasks, members)
    const fingerprint = JSON.stringify(tasks.filter(task => !['accepted', 'cancelled'].includes(task.status)).map(task => [task.id, task.status, task.epoch]))
    if (mission.stallNotice === fingerprint) return
    mission.stallNotice = fingerprint; mission.updatedAt = Date.now()
    const detail = leftover.map(task => `${task.id} (${task.kind}, ${task.status}${task.reviewOf ? `, reviews ${task.reviewOf}` : ''}${task.dependencies.length ? `, depends on ${task.dependencies.join('/')}` : ''})`).join('; ')
    this.commit(mission.id, () => {
      this.store.put('missions', mission)
      this.store.event(mission.id, 'mission/stalled', 'runtime', { reason, unschedulable: leftover.map(task => task.id) })
      this.notify(mission.id, `Mission stalled: no task can be scheduled and workers are idle. ${reason}. Unschedulable: ${detail || 'none'}. Decide: propose repairs or reviews with swarm_propose, adjust the budget, or use swarm_control complete (cancels unschedulable leftovers once every acceptance criterion is independently covered) or stop.`)
    })
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
      if (!coordinatorId || !this.store.list('members', missionId).some(m => m.id === coordinatorId && m.status !== 'stopped')) throw new Error('Unknown coordinator')
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
        task.status = 'cancelled'; task.epoch++; delete task.attempt; delete task.resumeAfterStop; delete task.budgetResume
        task.output = `${task.output ?? ''}\nCancelled at completion: this task could no longer be scheduled and every acceptance criterion was independently covered.`.trim()
        this.store.put('tasks', task)
        this.store.event(missionId, 'task/cancelled-at-completion', 'owner', { taskId: task.id, reason })
      }
      if (action === 'pause' || action === 'stop') for (const task of this.store.list('tasks', missionId)) {
        if (task.status !== 'running' && !(task.status === 'blocked' && task.resumeAfterStop?.epoch === task.epoch)) continue
        task.status = action === 'pause' ? 'pending' : 'cancelled'; task.epoch++; delete task.attempt
        delete task.resumeAfterStop
        delete task.budgetResume
        task.handoff = `${task.handoff ?? ''}\nMission ${action}: ${reason}. Inspect prior workspace/evidence before repeating effects.`
        this.store.put('tasks', task)
      }
      if (terminal(mission) && mission.budgetPause) { delete mission.budgetPause; this.store.put('missions', mission) }
      if (mission.status !== 'active') for (const member of this.store.list('members', missionId)) { delete member.activity; this.store.put('members', member) }
      this.store.event(missionId, `mission/${action}`, 'owner', { reason, coordinatorId: coordinatorId ?? null })
    })
    if (mission.status !== 'active') this.defer(async () => {
      await Promise.all(this.store.list('members', missionId).map(async member => {
        await this.workers.stop(member.id)
        if (this.closed || !terminal(this.mission(missionId))) return
        const current = this.store.get('members', member.id)
        if (!current || current.status === 'stopped') return
        current.status = 'stopped'
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
    if (!member || member.status === 'stopped') return 'Worker membership is inactive'
    const mission = this.mission(member.missionId)
    if (mission.status !== 'active' || Date.now() >= mission.deadline || mission.usedSteps > mission.budget.maxSteps || mission.usedTokens >= mission.budget.maxTokens) return 'Mission is inactive or out of budget'
    if (mission.budgetPause) return 'Budget pause is waiting for worker quiescence and a fresh resume assignment'
    if (/subagent|spawn_agent|agent_teams|cordis|plugin|workflow|ralph/.test(tool) || ['send_message', 'interrupt_agent', 'swarm_stage', 'swarm_launch', 'swarm_budget', 'swarm_create', 'swarm_add_member', 'swarm_control', 'swarm_cancel'].includes(tool)) return 'Use the swarm work board; alternate delegation and runtime modification bypass mission authority'
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
    if (member.status === 'waiting' && !hasFreshInput) return false
    // Requests still streaming for other workers will settle against the same pool.
    if (mission.usedSteps >= mission.budget.maxSteps || mission.usedTokens + this.inFlightEstimate(this.store.list('members', mission.id).filter(item => item.id !== memberId)) >= mission.budget.maxTokens || Date.now() >= mission.deadline) {
      this.blockBudget(mission); throw new Error('Mission aggregate budget exhausted')
    }
    mission.usedSteps++; mission.updatedAt = Date.now()
    this.commit(mission.id, () => {
      if (member.status === 'waiting') { member.status = 'working'; this.store.put('members', member) }
      this.store.put('missions', mission)
      for (const task of this.store.list('tasks', mission.id)) if (task.status === 'running' && task.attempt?.ownerId === memberId) {
        task.attempt.leaseUntil = Math.min(mission.deadline, Date.now() + this.config.leaseMs); this.store.put('tasks', task)
      }
    })
    this.warnBudget(mission)
  }
  private async usage(memberId: string, tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens < 0 || this.closed) return
    const member = this.store.get('members', memberId)
    if (!member) return
    const mission = this.mission(member.missionId)
    mission.usedTokens += Math.ceil(tokens)
    this.commit(mission.id, () => { this.store.put('missions', mission) })
    this.warnBudget(mission)
    if (mission.usedTokens >= mission.budget.maxTokens) this.blockBudget(mission)
  }
  /** Reconcile durable Harness usage cumulatively, including after a crash before SQLite accounting. */
  private async usageSnapshot(memberId: string, totalTokens: number, usage?: UsageBuckets): Promise<void> {
    if (this.closed) return
    if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) throw new Error('Invalid authoritative usage snapshot')
    if (usage !== undefined && !validUsage(usage)) throw new Error('Invalid usage buckets')
    const member = this.store.get('members', memberId)
    if (!member) throw new Error('Unknown worker in usage accounting')
    const mission = this.mission(member.missionId)
    const previouslyAccounted = member.accountedTokens ?? 0
    const bucketDelta = usage === undefined ? undefined : usageDelta(usage, member.usage)
    if (totalTokens <= previouslyAccounted && (bucketDelta === undefined || USAGE_KEYS.every(key => bucketDelta[key] === 0))) return
    member.accountedTokens = Math.max(previouslyAccounted, totalTokens)
    mission.usedTokens += Math.max(0, totalTokens - previouslyAccounted)
    if (bucketDelta !== undefined) { member.usage = usage; mission.workerUsage = addUsage(mission.workerUsage, bucketDelta) }
    this.commit(mission.id, () => { this.store.put('members', member); this.store.put('missions', mission) })
    this.warnBudget(mission)
    if (mission.usedTokens >= mission.budget.maxTokens) this.blockBudget(mission)
  }
  /**
   * Owner-session usage (planning, coordination, replies to notices) is not
   * charged to the worker pool but is attributed to that owner's newest live
   * mission, or to its planning request before launch, so the total cost of a
   * collaboration stays visible.
   */
  private recordOwnerUsage(sessionId: string, usage: UsageBuckets): void {
    if (this.closed || this.shuttingDown || !validUsage(usage) || this.isWorkerSession(sessionId)) return
    const mission = this.store.list('missions').filter(item => item.ownerSessionId === sessionId && !terminal(item)).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (mission) {
      mission.ownerUsage = addUsage(mission.ownerUsage, usage); mission.updatedAt = Date.now()
      this.commit(mission.id, () => this.store.put('missions', mission))
      return
    }
    const request = this.store.list('starts').filter(item => item.ownerSessionId === sessionId && (item.status === 'planning' || item.status === 'launching')).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!request) return
    request.ownerUsage = addUsage(request.ownerUsage, usage); request.updatedAt = Date.now()
    this.commit(request.id, () => this.store.put('starts', request))
  }
  /** Budget dimensions that are currently exhausted; used by the pause reason and event. */
  private exhaustedDimensions(mission: Mission): string[] {
    const dimensions: string[] = []
    if (mission.usedTokens >= mission.budget.maxTokens) dimensions.push('maxTokens')
    if (mission.usedSteps >= mission.budget.maxSteps) dimensions.push('maxSteps')
    if (Date.now() >= mission.deadline) dimensions.push('maxDurationMs')
    return dimensions
  }
  /**
   * Emit at most one approaching-limit warning per dimension per threshold. The
   * first signal is an event, not a fatal pause; thresholds default to 0.7/0.9.
   */
  private warnBudget(mission: Mission): void {
    if (mission.status !== 'active' || mission.budgetPause) return
    const thresholds = [...(this.config.budgetWarnAt ?? DEFAULT_BUDGET_WARN_AT)]
      .filter(value => Number.isFinite(value) && value > 0 && value < 1).sort((a, b) => a - b)
    if (!thresholds.length) return
    const dimensions: Array<{ dimension: string; used: number; limit: number }> = [
      { dimension: 'maxTokens', used: mission.usedTokens, limit: mission.budget.maxTokens },
      { dimension: 'maxSteps', used: mission.usedSteps, limit: mission.budget.maxSteps },
      { dimension: 'maxDurationMs', used: Math.max(0, Date.now() - mission.createdAt), limit: mission.budget.maxDurationMs },
    ]
    let changed = false
    for (const item of dimensions) {
      if (!(item.limit > 0)) continue
      const crossed = thresholds.filter(threshold => item.used / item.limit >= threshold).at(-1)
      if (crossed === undefined || crossed <= (mission.budgetWarned?.[item.dimension] ?? 0)) continue
      mission.budgetWarned = { ...(mission.budgetWarned ?? {}), [item.dimension]: crossed }
      changed = true
      this.store.event(mission.id, 'mission/budget-warning', 'runtime', { dimension: item.dimension, threshold: crossed, used: item.used, limit: item.limit,
        remaining: Math.max(0, item.limit - item.used), suggestedLimit: Math.ceil(item.used / crossed) })
    }
    if (changed) this.commit(mission.id, () => this.store.put('missions', mission))
  }
  private blockBudget(mission: Mission): void {
    if (terminal(mission) || mission.status === 'blocked') return
    const dimensions = this.exhaustedDimensions(mission)
    mission.status = 'blocked'
    mission.reason = dimensions.length ? `Aggregate mission budget exhausted: ${dimensions.join(', ')}` : 'Aggregate mission budget exhausted'
    mission.budgetPause = { id: id('budget-pause'), quiesced: false }
    this.commit(mission.id, () => {
      this.store.put('missions', mission)
      for (const task of this.store.list('tasks', mission.id)) if (task.status === 'running' && task.attempt) {
        task.budgetResume = { pauseId: mission.budgetPause!.id, attemptId: task.attempt.id, epoch: task.epoch }
        this.store.put('tasks', task)
      }
      for (const member of this.store.list('members', mission.id)) { delete member.activity; this.store.put('members', member) }
      this.store.event(mission.id, 'mission/budget-exhausted', 'runtime', { tokens: mission.usedTokens, steps: mission.usedSteps, dimensions })
      this.notify(mission.id, mission.reason!)
    })
    this.beginBudgetStop(mission.id, mission.budgetPause.id)
  }
  /** Stop outside the mission queue, which a cancelled in-flight tool may own. */
  private beginBudgetStop(missionId: string, pauseId: string): void {
    if (this.shuttingDown || this.budgetStops.has(pauseId)) return
    this.budgetStops.add(pauseId)
    this.defer(async () => {
      try {
        await Promise.all(this.store.list('members', missionId).map(member => this.workers.stop(member.id)))
        if (this.closed) return
        const mission = this.mission(missionId)
        if (mission.budgetPause?.id !== pauseId) return
        mission.budgetPause.quiesced = true
        this.commit(missionId, () => {
          this.store.put('missions', mission)
          this.store.event(missionId, 'mission/budget-quiesced', 'runtime', { pauseId })
        })
        this.kick(missionId)
        await this.flushOutbox(missionId)
      } finally { this.budgetStops.delete(pauseId) }
    })
  }
  /** A fresh durable delivery wakes preserved attempts as soon as stop completes. */
  private resumeBudgetTasks(mission: Mission): void {
    const pause = mission.budgetPause
    if (mission.status !== 'active' || !pause?.quiesced) return
    this.commit(mission.id, () => {
      for (const task of this.store.list('tasks', mission.id)) {
        const resume = task.budgetResume
        if (!resume || resume.pauseId !== pause.id) continue
        delete task.budgetResume
        if (task.status !== 'running' || !task.attempt || task.attempt.id !== resume.attemptId || task.epoch !== resume.epoch) {
          // The pause marker outlived its attempt (challenge, handoff or restart):
          // re-pend the work without charging a recovery attempt.
          if (task.status === 'running') { task.status = 'pending'; delete task.attempt }
          this.store.put('tasks', task)
          this.store.event(mission.id, 'task/budget-resume-skipped', 'runtime', { taskId: task.id, pauseId: pause.id })
          continue
        }
        task.attempt.leaseUntil = Math.min(mission.deadline, Date.now() + this.config.leaseMs)
        this.store.put('tasks', task)
        const member = this.store.get('members', task.attempt.ownerId)
        if (member && member.status !== 'stopped') { member.status = 'working'; this.store.put('members', member) }
        for (const delivery of this.store.list('deliveries', mission.id)) {
          if (delivery.kind === 'assignment' && delivery.taskId === task.id && !delivery.deliveredAt) {
            delivery.deliveredAt = Date.now(); this.store.put('deliveries', delivery)
          }
        }
        this.store.put('deliveries', { id: id('msg'), missionId: mission.id, from: 'runtime', to: task.attempt.ownerId, kind: 'assignment',
          taskId: task.id, attemptId: task.attempt.id, createdAt: Date.now(),
          content: JSON.stringify({ missionId: mission.id, task, instructions: 'Resume this same task and attempt after the primary agent adjusted the mission budget. The previous worker activity has fully stopped. Your previously recorded host tool-run IDs from this attempt remain valid. Inspect the saved workspace and evidence, continue unfinished work, and use this exact attemptId. Do not repeat completed effects or claim a new task.' }) })
        this.store.event(mission.id, 'task/budget-resumed', 'runtime', { taskId: task.id, attemptId: task.attempt.id, pauseId: pause.id })
      }
      delete mission.budgetPause
      this.store.put('missions', mission)
    })
  }
  private onActivity(memberId: string, activity?: WorkerActivity): void {
    if (this.closed || this.shuttingDown) return
    const member = this.store.get('members', memberId)
    if (!member) return
    const mission = this.mission(member.missionId)
    if (mission.status !== 'active' || member.status === 'stopped' || mission.budgetPause || Date.now() >= mission.deadline) activity = undefined
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
  /** Renew only a still-owned native operation, bounded by the owner's actual mission deadline. */
  private renewActiveOperation(task: Task, mission: Mission): void {
    if (!task.attempt || task.attempt.leaseUntil >= Date.now() + this.config.leaseMs / 2) return
    const member = this.store.get('members', task.attempt.ownerId)
    const activity = member?.activity
    const observed = this.workers.currentActivity?.(task.attempt.ownerId)
    // A live operation is liveness for its full duration: match by member and
    // activity id, never by the attempt the operation happens to be stored under.
    // Adapters that report current activity must confirm the operation is live.
    const live = activity !== undefined && (this.workers.currentActivity === undefined || (observed !== undefined && observed.id === activity.id))
    if (!live) {
      if (task.leaseWarned !== task.attempt.leaseUntil) {
        task.leaseWarned = task.attempt.leaseUntil
        this.commit(mission.id, () => {
          this.store.put('tasks', task)
          this.store.event(mission.id, 'task/lease-expiring', 'runtime', { taskId: task.id, ownerId: task.attempt!.ownerId, leaseUntil: task.attempt!.leaseUntil })
        })
      }
      return
    }
    const modelAllowance = activity.kind === 'model' ? (member?.maxOutputTokens ?? 0) : 0
    task.attempt.leaseUntil = Math.min(mission.deadline, Date.now() + this.config.leaseMs + Math.ceil(modelAllowance * LEASE_MS_PER_OUTPUT_TOKEN))
    delete task.leaseWarned
    // A lease extension is liveness bookkeeping, not a new progress timestamp or milestone.
    this.commit(mission.id, () => this.store.put('tasks', task))
  }
  /**
   * A worker-side git write that the sandbox refused (index.lock EPERM). Only
   * a git write command that failed with a permission denial qualifies, so a
   * read-only git command or an unrelated EPERM never claims the typed path.
   */
  private deniedGitWrite(input: { arguments: unknown; result: unknown }): string | undefined {
    const strings: string[] = []
    const collect = (value: unknown, depth = 0): void => {
      if (depth > 4) return
      if (typeof value === 'string') strings.push(value)
      else if (Array.isArray(value)) for (const item of value) collect(item, depth + 1)
      else if (value !== null && typeof value === 'object') for (const item of Object.values(value as Record<string, unknown>)) collect(item, depth + 1)
    }
    collect(input.arguments)
    const command = strings.find(text => /\bgit\b[^\n]{0,200}?\b(commit|add|merge|rebase|cherry-pick|revert|reset|switch|checkout|stash|tag|update-ref|rm|mv|apply|am|push|pull|fetch|branch|config|worktree|init|gc|repack)\b/.test(text))
    if (command === undefined) return undefined
    if (!/index\.lock|Operation not permitted|EPERM/i.test(JSON.stringify(input.result ?? ''))) return undefined
    return command.length > 200 ? `${command.slice(0, 200)}…` : command
  }
  private async recordToolRun(memberId: string, input: Omit<ToolRun, 'id' | 'seq' | 'missionId' | 'memberId' | 'taskId' | 'attemptId' | 'createdAt'>): Promise<string | undefined> {
    if (this.closed || input.tool.startsWith('swarm_')) return undefined
    const member = this.store.get('members', memberId)
    if (!member) return undefined
    const task = this.store.list('tasks', member.missionId).find(t => t.status === 'running' && t.attempt?.ownerId === memberId)
    if (!task?.attempt) return undefined
    const run: ToolRun = { ...input, id: id('run'), missionId: member.missionId, memberId, taskId: task.id, attemptId: task.attempt.id, createdAt: Date.now() }
    task.attempt.leaseUntil = Date.now() + this.config.leaseMs
    const denied = this.deniedGitWrite(input)
    const firstDenial = denied !== undefined && task.gitWriteDenied === undefined
    if (firstDenial) task.gitWriteDenied = { command: denied, runId: run.id, at: Date.now() }
    this.commit(member.missionId, () => {
      run.seq = this.store.countToolRuns(member.missionId) + 1
      this.store.put('tool_runs', run); this.store.put('tasks', task)
      this.store.event(member.missionId, 'tool/recorded', memberId, { runId: run.id, seq: run.seq, taskId: task.id, tool: run.tool, isError: run.isError })
      if (!firstDenial) return
      // Durable audit plus a typed delivery, so the worker learns the supported
      // exit even if its next tool is allowed before the guard denies one.
      this.store.event(member.missionId, 'task/git-write-denied', memberId, { taskId: task.id, attemptId: task.attempt!.id, command: denied, runId: run.id })
      this.store.put('deliveries', { id: id('msg'), missionId: member.missionId, from: 'runtime', to: memberId, kind: 'control', content: gitWriteDeniedMessage(denied!), createdAt: Date.now() })
    })
    return run.id
  }
  private onIdle(memberId: string): void {
    if (this.closed || this.shuttingDown) return
    const member = this.store.get('members', memberId)
    if (!member || member.status === 'stopped') return
    // W6: remember that this member ended a turn while still owning an attempt,
    // so scheduling can nudge it and, when the bounded retry is exhausted,
    // checkpoint the workspace before any reassignment.
    const open = this.store.list('tasks', member.missionId).find(task => task.status === 'running' && task.attempt?.ownerId === memberId)
    if (open?.attempt) this.idleSignals.set(memberId, { attemptId: open.attempt.id, at: Date.now() })
    else this.idleSignals.delete(memberId)
    member.status = 'idle'
    delete member.activity
    this.commit(member.missionId, () => { this.store.put('members', member) })
    this.kick(member.missionId)
  }
  /**
   * W6: an idle worker still owns a running attempt. First re-wake it with a
   * bounded, durable nudge; when the bound is exhausted, capture the member
   * workspace as an immutable checkpoint, fence the attempt and re-pend the
   * task with the same member preferred so recovery resumes partial work.
   */
  private async closeOutIdleAttempt(mission: Mission, member: Member, task: Task): Promise<void> {
    const bound = this.config.maxIdleCloseouts ?? DEFAULT_IDLE_CLOSEOUTS
    const nudges = task.closeout?.nudges ?? 0
    if (nudges < bound) {
      const nudge = nudges + 1
      const remaining = bound - nudge
      const attemptId = task.attempt!.id
      task.closeout = { nudges: nudge, at: Date.now() }
      this.commit(mission.id, () => {
        this.store.put('tasks', task)
        this.store.put('deliveries', { id: id('msg'), missionId: mission.id, from: 'runtime', to: member.id, kind: 'control', createdAt: Date.now(),
          content: `Your attempt on "${task.title}" (${task.id}) is still open but your turn ended without a terminal call. Continue this exact attemptId ${attemptId} and finish it: submit with swarm_submit, release it with swarm_handoff, or park with swarm_wait. ${remaining === 0 ? 'The next idle close-out checkpoints your workspace and re-pends the task for recovery.' : `After ${remaining} more idle close-out${remaining === 1 ? '' : 's'} the runtime checkpoints your workspace and re-pends the task for recovery.`}` })
        this.store.event(mission.id, 'task/closeout-nudged', 'runtime', { taskId: task.id, attemptId, ownerId: member.id, nudges: nudge })
      })
      return
    }
    let checkpoint: Artifact
    try { checkpoint = await this.workers.captureArtifact(member, task) }
    catch (error) {
      const failed = this.task(mission.id, task.id)
      if (failed.status !== 'running' || failed.attempt?.id !== task.attempt?.id) return
      failed.status = 'blocked'; failed.epoch++; delete failed.attempt; delete failed.closeout
      failed.output = `Worker ended its turn without submitting (${task.id}) and its workspace could not be checkpointed: ${error instanceof Error ? error.message : String(error)}. Inspect the member workspace before proposing a replacement.`
      this.commit(mission.id, () => {
        this.store.put('tasks', failed)
        this.store.event(mission.id, 'task/closeout-failed', 'runtime', { taskId: failed.id, ownerId: member.id, reason: failed.output })
        this.notify(mission.id, failed.output!)
      })
      return
    }
    const current = this.task(mission.id, task.id)
    // The attempt may have finished while the checkpoint committed; never mutate terminal work.
    if (current.status !== 'running' || current.attempt?.id !== task.attempt?.id) return
    current.checkpoint = { commit: checkpoint.commit, at: Date.now() }
    current.status = 'blocked'; current.epoch++
    current.recoveryCount = (current.recoveryCount ?? 0) + 1
    delete current.attempt; delete current.closeout
    // Prefer the same member: its next attempt resumes the checkpointed workspace
    // instead of a different member starting from the mission baseline.
    current.assigneeId = member.id
    current.plannedAssigneeId ??= member.id
    current.resumeAfterStop = { epoch: current.epoch, reason: 'worker-closeout' }
    const epoch = current.epoch
    this.commit(mission.id, () => {
      this.store.put('tasks', current)
      this.store.event(mission.id, 'task/closeout-abandoned', 'runtime', { taskId: current.id, ownerId: member.id, commit: checkpoint.commit, recoveryCount: current.recoveryCount })
    })
    this.idleSignals.delete(member.id)
    this.defer(async () => {
      await this.workers.stop(member.id)
      await this.exclusive(mission.id, async () => {
        const fresh = this.task(mission.id, task.id)
        if (fresh.epoch !== epoch || fresh.status !== 'blocked') return
        const released = this.store.get('members', member.id)
        if (released !== undefined && released.status !== 'stopped') { released.status = 'idle'; this.store.put('members', released) }
        const exhausted = (fresh.recoveryCount ?? 0) >= (fresh.maxRecoveryAttempts ?? this.config.maxTasksPerMember)
        if (!exhausted) {
          fresh.status = 'pending'; delete fresh.resumeAfterStop
          if (released === undefined || released.status === 'stopped') delete fresh.assigneeId
        } else delete fresh.resumeAfterStop
        this.commit(mission.id, () => {
          this.store.put('tasks', fresh)
          this.store.event(mission.id, exhausted ? 'task/closeout-exhausted' : 'task/closeout-ready', 'runtime', { taskId: fresh.id, memberId: member.id })
        })
      })
      this.kick(mission.id)
    })
  }
  private onFailure(memberId: string, error: string): void {
    if (this.closed || this.shuttingDown) return
    const member = this.store.get('members', memberId)
    if (!member) return
    this.commit(member.missionId, () => { this.store.event(member.missionId, 'member/failure', memberId, { error }); this.notify(member.missionId, `${member.name} failed: ${error}`) })
  }
  private defer(fn: () => Promise<void>): void {
    if (this.shuttingDown) return
    const operation = new Promise<void>(resolve => setImmediate(resolve)).then(fn)
    this.operations.add(operation)
    void operation.catch(error => { if (!this.closed) process.stderr.write(`[agent-swarm] ${String(error)}\n`) }).finally(() => this.operations.delete(operation))
  }
  private kick(missionId: string): void {
    if (this.shuttingDown || this.scheduled.has(missionId)) return
    this.scheduled.add(missionId)
    this.defer(async () => {
      try { await this.exclusive(missionId, () => this.schedule(missionId)) }
      finally {
        this.scheduled.delete(missionId)
        const mission = this.closed ? undefined : this.store.get('missions', missionId)
        if (mission?.status === 'active' && mission.budgetPause?.quiesced) this.kick(missionId)
      }
    })
  }
  private async ensureWorkers(mission: Mission): Promise<void> {
    for (const member of this.store.list('members', mission.id)) {
      if (this.shuttingDown) return
      if (member.status === 'stopped') continue
      try { await this.workers.start({ mission, member, ownerSessionId: mission.ownerSessionId }) }
      catch (error) { this.onFailure(member.id, `Cannot resume: ${String(error)}`) }
    }
  }
  private async schedule(missionId: string): Promise<void> {
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
    for (const task of this.store.list('tasks', missionId)) {
      if (this.shuttingDown) return
      if (task.status !== 'running' || !task.attempt) continue
      this.renewActiveOperation(task, mission)
      if (task.attempt.leaseUntil >= Date.now()) continue
      const oldOwner = task.attempt.ownerId
      const attemptId = task.attempt.id
      // W6: capture a durable checkpoint before any reassignment when the old
      // owner is quiescent, so the next attempt resumes committed work instead
      // of falling back to the mission baseline.
      if (this.workers.isIdle(oldOwner)) {
        const owner = this.store.get('members', oldOwner)
        if (owner !== undefined && owner.status !== 'stopped') {
          try {
            const checkpoint = await this.workers.captureArtifact(owner, task)
            const current = this.task(missionId, task.id)
            if (current.epoch === task.epoch && current.status === 'running' && current.attempt?.id === attemptId) {
              // Mutate the record this iteration commits, so the checkpoint is
              // not lost when the lease-expiry transition writes it below.
              task.checkpoint = { commit: checkpoint.commit, at: Date.now() }
              this.commit(missionId, () => { this.store.put('tasks', task); this.store.event(missionId, 'task/checkpointed', 'runtime', { taskId: task.id, commit: checkpoint.commit, reason: 'lease-expired' }) })
            }
          } catch (error) {
            // Auditable and non-fatal: the workspace stays untouched and
            // prepareTask refuses a dirty workspace rather than losing it.
            const current = this.task(missionId, task.id)
            if (current.epoch === task.epoch && current.status === 'running' && current.attempt?.id === attemptId) {
              const reason = `Lease-expiry checkpoint failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}. The member workspace is preserved; recovery will refuse a dirty workspace instead of losing it.`
              this.commit(missionId, () => {
                this.store.event(missionId, 'task/checkpoint-failed', 'runtime', { taskId: task.id, ownerId: oldOwner, reason })
                this.notify(missionId, reason)
              })
            }
          }
        }
      }
      // The checkpoint awaited external work. An owner cancel (or any other
      // fencing transition) committed during it must win over lease recovery:
      // re-read and only transition the record that still owns this attempt.
      const expiring = this.task(missionId, task.id)
      if (expiring.epoch !== task.epoch || expiring.status !== 'running' || expiring.attempt?.id !== attemptId) continue
      // A lease that expired while the task was budget-paused is host policy, not
      // a recovery failure, and the plan's intended owner must survive it.
      const pauseInduced = expiring.budgetResume !== undefined
      expiring.status = 'blocked'; expiring.epoch++
      if (!pauseInduced) expiring.recoveryCount = (expiring.recoveryCount ?? 0) + 1
      delete expiring.attempt
      const planned = expiring.plannedAssigneeId === undefined ? undefined : this.store.get('members', expiring.plannedAssigneeId)
      if (planned !== undefined && planned.status !== 'stopped') expiring.assigneeId = planned.id
      else delete expiring.assigneeId
      expiring.resumeAfterStop = { epoch: expiring.epoch, reason: 'lease-expired' }
      this.commit(missionId, () => { this.store.put('tasks', expiring); this.store.event(missionId, 'task/lease-expired', 'runtime', { taskId: expiring.id, oldOwner }) })
      await this.workers.stop(oldOwner)
      const reopened = this.task(missionId, task.id)
      if (reopened.epoch !== expiring.epoch || reopened.status !== 'blocked') continue
      reopened.status = (reopened.recoveryCount ?? 0) >= (reopened.maxRecoveryAttempts ?? this.config.maxTasksPerMember) ? 'blocked' : 'pending'; delete reopened.resumeAfterStop
      this.commit(missionId, () => { this.store.put('tasks', reopened) })
    }
    for (const member of this.store.list('members', missionId)) {
      if (this.shuttingDown || this.mission(missionId).status !== 'active') return
      if (member.status === 'stopped') continue
      try { await this.workers.start({ mission, member, ownerSessionId: mission.ownerSessionId }) }
      catch (error) {
        // Disposing the adapter cancels in-flight starts. This is recoverable host
        // shutdown, not a permanent worker failure to persist across restart.
        if (this.shuttingDown || this.mission(missionId).status !== 'active') return
        member.status = 'stopped'
        this.commit(missionId, () => {
          this.store.put('members', member)
          for (const abandoned of this.store.list('tasks', missionId)) {
            if (abandoned.assigneeId !== member.id || !['pending', 'running'].includes(abandoned.status)) continue
            abandoned.status = 'blocked'; abandoned.epoch++; delete abandoned.attempt
            abandoned.output = `Worker could not resume: ${String(error)}. Propose a replacement with a live worker.`
            this.store.put('tasks', abandoned)
          }
          this.store.event(missionId, 'member/resume-failed', 'runtime', { memberId: member.id, error: String(error) })
          this.notify(missionId, `${member.name} could not resume: ${String(error)}`)
        })
        continue
      }
      if (this.shuttingDown || this.mission(missionId).status !== 'active') return
      if (!this.workers.isIdle(member.id)) continue
      const open = this.store.list('tasks', missionId).find(t => t.status === 'running' && t.attempt?.ownerId === member.id)
      if (open !== undefined) {
        // W6: the worker ended its turn with an open attempt. Nudge within a
        // bounded retry, then checkpoint the workspace and re-pend the task
        // instead of leaving it a zombie until lease expiry.
        if (this.idleSignals.get(member.id)?.attemptId === open.attempt?.id) await this.closeOutIdleAttempt(mission, member, open)
        continue
      }
      const all = this.store.list('tasks', missionId)
      const tasks = all.filter(t => this.ready(t, member, all)).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
      const task = tasks[0]
      if (!task) continue
      try {
        await this.workers.prepareTask(member, { ...task, epoch: task.epoch + 1 }, this.effectiveDependencies(missionId, task), task.reviewOf ? this.task(missionId, task.reviewOf) : undefined)
        if (this.shuttingDown || this.mission(missionId).status !== 'active') return
        const fresh = this.task(missionId, task.id)
        if (fresh.epoch !== task.epoch || !this.ready(fresh, member)) continue
        this.assign(fresh, member)
      } catch (error) {
        if (this.shuttingDown || this.mission(missionId).status !== 'active') return
        const fresh = this.task(missionId, task.id)
        if (fresh.epoch !== task.epoch || !this.ready(fresh, member)) continue
        fresh.status = 'blocked'; fresh.output = `Workspace or worker preparation failed: ${String(error)}`
        this.commit(missionId, () => { this.store.put('tasks', fresh); this.store.event(missionId, 'task/blocked', 'runtime', { taskId: fresh.id, reason: fresh.output }); this.notify(missionId, fresh.output!) })
      }
    }
    await this.flushOutbox(missionId)
  }
  private async flushOutbox(missionId: string): Promise<void> {
    if (this.shuttingDown) return
    const mission = this.mission(missionId)
    for (const delivery of this.store.list('deliveries', missionId)) {
      if (this.shuttingDown) return
      if (delivery.deliveredAt) continue
      if (delivery.kind === 'assignment' && delivery.taskId) {
        const task = this.task(missionId, delivery.taskId)
        if (task.attempt?.id !== delivery.attemptId || task.status !== 'running') {
          delivery.deliveredAt = Date.now(); this.commit(missionId, () => this.store.put('deliveries', delivery)); continue
        }
      }
      if (delivery.to !== 'owner' && (mission.status !== 'active' || mission.budgetPause)) continue
      const member = delivery.to === 'owner'
        ? { id: 'owner', missionId, name: 'owner', role: 'owner', sessionId: mission.ownerSessionId, workspace: mission.workspace, status: 'idle' as const, subscriptions: [] }
        : this.store.get('members', delivery.to)
      if (!member || member.status === 'stopped') continue
      try {
        await this.workers.deliver(member, delivery)
        delivery.deliveredAt = Date.now()
        this.commit(missionId, () => { this.store.put('deliveries', delivery) })
      } catch { /* Durable outbox retries absent sessions; acceptance is idempotent in the adapter. */ }
    }
  }
  /** Drain all runtime operations and worker handles before releasing database ownership. */
  async dispose(): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.timer) clearInterval(this.timer)
    for (const controller of this.startControllers.values()) controller.abort(new Error('Swarm runtime is shutting down'))
    let workerError: unknown
    try { await this.workers.dispose() } catch (error) { workerError = error }
    try { await Promise.allSettled([...this.operations, ...this.queues.values()]) }
    finally { this.closed = true; this.listeners.clear(); this.store.close() }
    if (workerError !== undefined) throw workerError
  }
}
