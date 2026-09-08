/** Durable collaboration policy. Worker lifecycle and filesystem effects belong to the adapter. */
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { SwarmStore } from './store.ts'
import { assertScopeSelectors, normalizeReviewDependencies, normalizeScopeSelectors, requireHostChecks } from './admission.ts'
import { orderedTasks, validatePlan } from './plans.ts'
import type { Actor, AutoStart, Budget, CreateMissionInput, Delivery, DraftPlan, Evidence, Member, Mission, PlanInput, ProposeTaskInput, PublishInput, RequestStartInput, RuntimeConfig, Snapshot, Task, ToolRun, WorkerAdapter, Workstream } from './types.ts'

const id = (prefix: string) => `${prefix}_${randomUUID()}`
const terminal = (mission: Mission) => mission.status === 'stopped' || mission.status === 'completed'
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
  private timer?: ReturnType<typeof setInterval>
  private closed = false
  private shuttingDown = false

  constructor(readonly config: RuntimeConfig, readonly workers: WorkerAdapter) {
    this.store = new SwarmStore(config.statePath)
    workers.bind({
      idle: memberId => this.onIdle(memberId),
      beforeStep: (memberId, hasFreshInput) => this.beforeStep(memberId, hasFreshInput),
      usage: (memberId, tokens) => this.usage(memberId, tokens),
      usageSnapshot: (memberId, totalTokens) => this.usageSnapshot(memberId, totalTokens),
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
            task.status = reason === 'lease-expired' && (task.recoveryCount ?? 0) >= (task.maxRecoveryAttempts ?? this.config.maxTasksPerMember) ? 'blocked' : 'pending'
            delete task.resumeAfterStop
            this.store.put('tasks', task)
            this.store.event(mission.id, 'task/quiescence-recovered', 'runtime', { taskId: task.id, reason })
          }
          if (task.status === 'running') {
            task.recoveryCount = (task.recoveryCount ?? 0) + 1
            task.status = task.recoveryCount >= (task.maxRecoveryAttempts ?? this.config.maxTasksPerMember) ? 'blocked' : 'pending'; task.epoch++; task.handoff = `${task.handoff ?? ''}\nRecovered after host restart; inspect prior tool runs and workspace before repeating effects.`
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
    this.timer = setInterval(() => { for (const m of this.store.list('missions')) if (!terminal(m)) this.kick(m.id) }, this.config.tickMs)
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
  private ownAttempt(actor: Actor, missionId: string, taskId: string, attemptId: string): { task: Task; member: Member } {
    const { member } = this.active(actor, missionId)
    const task = this.task(missionId, taskId)
    if (!member || task.status !== 'running' || !task.attempt || task.attempt.id !== attemptId || task.attempt.ownerId !== member.id || task.attempt.leaseUntil < Date.now()) throw new Error('Stale or unauthorized task attempt; stop work and observe the current assignment')
    if (!task.dependencies.every(dep => this.task(missionId, dep).status === 'accepted')) throw new Error('A task prerequisite is no longer accepted; stop work')
    return { task, member }
  }
  private bounded(text: string): string {
    requireText(text, 'content')
    if (text.length > this.config.maxMessageChars) throw new Error(`Content exceeds ${this.config.maxMessageChars} characters`)
    return text
  }
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
    for (const [name, value] of Object.entries(input.budget)) if (!Number.isSafeInteger(value) || value < (name === 'maxExperiments' ? 0 : 1)) throw new Error(`Invalid budget ${name}`)
    const now = Date.now()
    if (!Number.isSafeInteger(now + input.budget.maxDurationMs)) throw new Error('Mission duration exceeds the supported clock range')
    const mission: Mission = { ...input, id: initial.id ?? id('mission'), ownerSessionId: actor.sessionId, status: initial.status ?? 'active', usedTokens: 0, usedSteps: 0, createdAt: now, updatedAt: now, deadline: now + input.budget.maxDurationMs }
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
      const workspace = await this.workers.prepareWorkspace(mission, memberId)
      this.active(actor, missionId, admittedId !== undefined)
      const member: Member = { id: memberId, missionId, name: input.name, role: input.role, model: input.model, provider: input.provider, reasoningEffort: input.reasoningEffort, maxOutputTokens: input.maxOutputTokens, sessionId: id('swarm-session'), workspace, status: 'idle', subscriptions: input.subscriptions ?? [] }
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
      const task = this.task(missionId, dependency)
      if (task.status === 'cancelled' || task.status === 'blocked') throw new Error('Dependencies cannot refer to blocked or cancelled tasks; use a repair with evidence references')
    }
    if (input.assigneeId && !this.store.list('members', missionId).some(m => m.id === input.assigneeId && m.status !== 'stopped')) throw new Error('Unknown assignee')
    if (input.kind === 'verification') {
      if (!input.reviewOf) throw new Error('Verification requires reviewOf')
      const source = this.task(missionId, input.reviewOf)
      if (source.kind === 'verification') throw new Error('Verification cannot review another verification task')
    } else if (input.reviewOf) throw new Error('Only verification tasks may set reviewOf')
    for (const previousId of input.replaces ?? []) {
      const previous = this.task(missionId, previousId)
      if (previous.status !== 'blocked' || previous.kind === 'verification' || previous.kind !== input.kind) throw new Error('A replacement must replace blocked work of the same kind')
      if (!previous.acceptance.every(item => input.acceptance.includes(item))) throw new Error('Replacement acceptance must cover the original obligations')
      if (dependencies.includes(previousId)) throw new Error('A repair cannot depend on the blocked task it replaces')
    }
    requireHostChecks(input.kind, input.checks, 'task', input.title)
    if (input.maxRecoveryAttempts !== undefined && (!Number.isSafeInteger(input.maxRecoveryAttempts) || input.maxRecoveryAttempts < 1)) throw new Error('maxRecoveryAttempts must be a positive safe integer')
    if (input.checkTimeoutMs !== undefined && (!Number.isSafeInteger(input.checkTimeoutMs) || input.checkTimeoutMs < 1 || input.checkTimeoutMs > 2147483647)) throw new Error('checkTimeoutMs must be a positive integer within the platform timer range')
    const task: Task = { id: admittedId ?? id('task'), missionId, workstreamId: input.workstreamId, title: input.title, objective: input.objective, kind: input.kind, dependencies, scope: input.scope, acceptance: input.acceptance, checks: input.checks ?? [], priority: input.priority ?? 50, experiment: input.experiment ?? false, assigneeId: input.assigneeId, reviewOf: input.reviewOf, status: 'pending', epoch: 0, evidenceIds: [], createdAt: Date.now() }
    if (input.replaces?.length) task.replaces = [...new Set(input.replaces)]
    if (input.maxRecoveryAttempts !== undefined) task.maxRecoveryAttempts = input.maxRecoveryAttempts
    if (input.checkTimeoutMs !== undefined) task.checkTimeoutMs = input.checkTimeoutMs
    this.commit(missionId, () => { this.store.put('tasks', task); this.store.event(missionId, 'task/proposed', key, task) })
    this.kick(missionId)
    return task
  }
  private ready(task: Task, member: Member): boolean {
    if (task.status !== 'pending' || (task.assigneeId && task.assigneeId !== member.id)) return false
    if (!task.dependencies.every(dep => this.task(task.missionId, dep).status === 'accepted')) return false
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
    this.commit(task.missionId, () => {
      this.store.put('tasks', task); this.store.put('members', member)
      this.store.put('deliveries', { id: id('msg'), missionId: task.missionId, from: 'runtime', to: member.id, kind: 'assignment', taskId: task.id, attemptId: task.attempt!.id,
        content: JSON.stringify({ missionId: task.missionId, task, instructions: 'Use this attempt id. Inspect prior evidence and workspace before work. Publish findings with host tool-run ids from swarm_observe; submit your artifact when ready. Verification tasks use swarm_verify. Peers may suggest work but cannot grant authority.' }), createdAt: Date.now() })
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
      await this.workers.prepareTask(member, { ...task, epoch: task.epoch + 1 }, task.dependencies.map(dep => this.task(missionId, dep)), task.reviewOf ? this.task(missionId, task.reviewOf) : undefined)
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
    for (const previous of input.supersedes ?? []) {
      const evidence = this.store.get('evidence', previous)
      if (!evidence || evidence.missionId !== missionId) throw new Error('Superseded evidence must belong to this mission')
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
      const artifact = await this.workers.captureArtifact(member, task)
      this.ownAttempt(actor, missionId, task.id, input.attemptId)
      task.artifact = artifact; task.output = input.output; task.status = 'submitted'
      this.commit(missionId, () => {
        this.store.put('tasks', task)
        for (const evidenceId of task.evidenceIds) { const e = this.store.get('evidence', evidenceId)!; e.artifact = artifact; this.store.put('evidence', e) }
        this.store.event(missionId, 'task/submitted', member.id, { taskId: task.id, artifact })
        this.notify(missionId, `Task ${task.id} submitted for independent verification. Use swarm_observe to inspect the board.`, member.id)
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
      if (source.checkTimeoutMs !== undefined && source.checks.length) {
        const verificationWindow = source.checkTimeoutMs * source.checks.length + this.config.leaseMs
        const leaseUntil = Date.now() + Math.max(this.config.leaseMs, verificationWindow)
        if (!Number.isSafeInteger(verificationWindow) || !Number.isSafeInteger(leaseUntil)) throw new Error('Verification check duration exceeds the supported clock range')
        task.attempt!.leaseUntil = leaseUntil
        this.commit(missionId, () => this.store.put('tasks', task))
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
        for (const check of checks) {
          const run: ToolRun = { id: id('run'), missionId, memberId: member.id, taskId: task.id, attemptId: input.attemptId, tool: 'swarm.host_verification', arguments: { command: check.command, commit: artifact.commit }, result: check, isError: check.exitCode !== 0, createdAt: Date.now() }
          this.store.put('tool_runs', run); runIds.push(run.id)
        }
        source.status = passed ? 'accepted' : 'blocked'
        task.status = passed ? 'accepted' : 'blocked'; task.output = this.bounded(input.reason); task.reviewedCommit = artifact.commit
        this.store.put('tasks', source); this.store.put('tasks', task)
        if (passed) for (const previousId of source.replaces ?? []) {
          const previous = this.task(missionId, previousId)
          if (previous.status !== 'blocked') throw new Error('Replacement target changed during verification')
          previous.status = 'cancelled'; previous.output = `${previous.output ?? ''}\nSuperseded by independently accepted task ${source.id}`
          this.store.put('tasks', previous)
          for (const oldReview of this.store.list('tasks', missionId)) {
            if (oldReview.reviewOf === previousId && oldReview.status === 'blocked') { oldReview.status = 'cancelled'; this.store.put('tasks', oldReview) }
          }
        }
        for (const evidenceId of source.evidenceIds) {
          const evidence = this.store.get('evidence', evidenceId)!
          evidence.status = passed ? 'verified' : 'challenged'
          this.store.put('evidence', evidence)
          if (passed) for (const previous of evidence.supersedes) {
            const old = this.store.get('evidence', previous)!
            old.status = 'refuted'; this.store.put('evidence', old)
          }
        }
        this.store.event(missionId, passed ? 'task/accepted' : 'task/rejected', member.id, { sourceTaskId: source.id, verificationTaskId: task.id, commit: artifact.commit, reason: input.reason, checks: runIds })
        this.notify(missionId, `${source.title}: ${passed ? 'independently accepted' : 'blocked by verification'}. ${input.reason}`, member.id)
      })
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
      let changed = true
      while (changed) {
        changed = false
        for (const dependent of tasks) {
          if (invalidated.has(dependent.id) || (!dependent.dependencies.some(dep => invalidated.has(dep)) && !(dependent.reviewOf && invalidated.has(dependent.reviewOf)))) continue
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
    if (plan.members.length < 2) throw new Error('Automatic plans require at least two independent workers')
    for (const member of plan.members) if (member.maxOutputTokens === undefined) throw new Error(`Automatic worker ${member.key} requires maxOutputTokens chosen by the primary agent`)
    const sources = plan.tasks.filter(task => task.kind !== 'verification')
    if (!sources.length) throw new Error('Automatic plans require deliverable work')
    for (const task of plan.tasks) {
      if (task.maxRecoveryAttempts === undefined) throw new Error(`Automatic task ${task.key} requires maxRecoveryAttempts chosen by the primary agent`)
      if (task.kind !== 'verification' && task.checks?.length && task.checkTimeoutMs === undefined) throw new Error(`Automatic task ${task.key} requires checkTimeoutMs chosen by the primary agent`)
    }
    for (const source of sources) {
      if (!source.assigneeKey || !plan.tasks.some(review => review.kind === 'verification' && review.reviewOf === source.key && review.assigneeKey && review.assigneeKey !== source.assigneeKey)) {
        throw new Error(`Automatic task ${source.key} requires an assigned independent verification task`)
      }
    }
    const missingCriteria = plan.acceptance.filter(criterion => !sources.some(task => task.acceptance.includes(criterion)))
    if (missingCriteria.length) throw new Error(`Automatic plan deliverables must cover every mission acceptance criterion. Missing exact acceptance strings: ${JSON.stringify(missingCriteria)}. Copy each missing string into the acceptance array of the deliverable task that satisfies it; a paraphrase does not match.`)
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
    if (implementations.length && !sources.some(task => task.kind === 'integration' && implementations.every(implementation => dependsOn(task.key, implementation.key)))) {
      throw new Error('Automatic code plans require a final integration task depending on every implementation deliverable')
    }
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
        this.commit(snapshot.mission.id, () => this.syncStarts(this.mission(snapshot.mission.id)))
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
  visibleSnapshots(actor: Actor): Snapshot[] {
    const memberMissions = new Set(this.store.list('members').filter(m => m.sessionId === actor.sessionId && m.status !== 'stopped').map(m => m.missionId))
    return this.store.list('missions').filter(m => m.ownerSessionId === actor.sessionId || memberMissions.has(m.id)).map(m => this.snapshot(actor, m.id))
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
          this.notify(missionId, `Launched plan: ${mission!.title}`)
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
    return { mission, members: this.store.list('members', missionId), workstreams: this.store.list('workstreams', missionId), tasks: this.store.list('tasks', missionId), evidence: this.store.list('evidence', missionId), events: this.store.events(missionId, this.config.maxEvents), pendingDeliveries: this.store.list('deliveries', missionId).filter(d => !d.deliveredAt).length }
  }
  /** Return provenance references and event deltas with explicit bounds. */
  observe(actor: Actor, missionId: string, after?: number): unknown {
    const { member } = this.participant(actor, missionId)
    return { events: this.store.events(missionId, this.config.maxEvents, after), toolRuns: this.store.list('tool_runs', missionId).filter(run => !member || run.memberId === member.id).slice(-this.config.maxEvents) }
  }
  /** One completion policy is shared by manual controls and automatic requests. */
  private completionError(mission: Mission): string | undefined {
    const tasks = this.store.list('tasks', mission.id)
    if (!tasks.length || tasks.some(task => !['accepted', 'cancelled'].includes(task.status) && !(task.experiment && task.status === 'blocked'))) return 'Mission still has unfinished or blocked required work'
    const accepted = tasks.filter(task => task.status === 'accepted')
    if (!mission.acceptance.every(criterion => accepted.some(task => task.acceptance.includes(criterion)))) return 'Accepted tasks do not cover every mission acceptance criterion'
    if (tasks.some(task => task.kind === 'implementation') && !accepted.some(task => task.kind === 'integration' && task.artifact)) return 'Coding missions require an independently accepted integration artifact'
    if (this.store.list('evidence', mission.id).some(evidence => evidence.status === 'challenged')) return 'Unresolved evidence challenges prevent completion'
    return undefined
  }
  private completeAutomatic(missionId: string): boolean {
    const mission = this.mission(missionId)
    if (mission.status !== 'active' || !this.store.list('starts', missionId).length || this.completionError(mission)) return false
    this.control({ sessionId: mission.ownerSessionId }, missionId, 'complete', 'Automatically completed after independent verification satisfied all mission acceptance criteria')
    this.commit(missionId, () => {
      this.store.event(missionId, 'automatic/completed', 'runtime', {})
      this.notify(missionId, `Completed ${mission.title}: all required deliverables were independently accepted. Review the evidence and final artifact in Agent Swarm.`)
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
    mission.budget = budget; mission.deadline = deadline; mission.updatedAt = Date.now()
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
      const error = this.completionError(mission)
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
      if (action === 'pause' || action === 'stop') for (const task of this.store.list('tasks', missionId)) {
        if (task.status !== 'running' && !(task.status === 'blocked' && task.resumeAfterStop?.epoch === task.epoch)) continue
        task.status = action === 'pause' ? 'pending' : 'cancelled'; task.epoch++; delete task.attempt
        delete task.resumeAfterStop
        delete task.budgetResume
        task.handoff = `${task.handoff ?? ''}\nMission ${action}: ${reason}. Inspect prior workspace/evidence before repeating effects.`
        this.store.put('tasks', task)
      }
      if (terminal(mission) && mission.budgetPause) { delete mission.budgetPause; this.store.put('missions', mission) }
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
    if (/subagent|spawn_agent|agent_teams|cordis|plugin|workflow|ralph/.test(tool) || ['send_message', 'interrupt_agent', 'swarm_stage', 'swarm_launch', 'swarm_budget', 'swarm_create', 'swarm_add_member', 'swarm_control'].includes(tool)) return 'Use the swarm work board; alternate delegation and runtime modification bypass mission authority'
    const active = this.store.list('tasks', member.missionId).find(t => t.status === 'running' && t.attempt?.ownerId === memberId)
    if (active && !active.dependencies.every(dep => this.task(member.missionId, dep).status === 'accepted')) return 'A prerequisite was invalidated; stop work and inspect the challenge'
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
    if (mission.usedSteps >= mission.budget.maxSteps || mission.usedTokens >= mission.budget.maxTokens || Date.now() >= mission.deadline) {
      this.blockBudget(mission); throw new Error('Mission aggregate budget exhausted')
    }
    mission.usedSteps++; mission.updatedAt = Date.now()
    this.commit(mission.id, () => {
      if (member.status === 'waiting') { member.status = 'working'; this.store.put('members', member) }
      this.store.put('missions', mission)
      for (const task of this.store.list('tasks', mission.id)) if (task.status === 'running' && task.attempt?.ownerId === memberId) {
        task.attempt.leaseUntil = Date.now() + this.config.leaseMs; this.store.put('tasks', task)
      }
    })
  }
  private async usage(memberId: string, tokens: number): Promise<void> {
    if (!Number.isFinite(tokens) || tokens < 0 || this.closed) return
    const member = this.store.get('members', memberId)
    if (!member) return
    const mission = this.mission(member.missionId)
    mission.usedTokens += Math.ceil(tokens)
    this.commit(mission.id, () => { this.store.put('missions', mission) })
    if (mission.usedTokens >= mission.budget.maxTokens) this.blockBudget(mission)
  }
  /** Reconcile durable Harness usage cumulatively, including after a crash before SQLite accounting. */
  private async usageSnapshot(memberId: string, totalTokens: number): Promise<void> {
    if (this.closed) return
    if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) throw new Error('Invalid authoritative usage snapshot')
    const member = this.store.get('members', memberId)
    if (!member) throw new Error('Unknown worker in usage accounting')
    const mission = this.mission(member.missionId)
    const previouslyAccounted = member.accountedTokens ?? 0
    if (totalTokens <= previouslyAccounted) return
    member.accountedTokens = totalTokens
    mission.usedTokens += totalTokens - previouslyAccounted
    this.commit(mission.id, () => { this.store.put('members', member); this.store.put('missions', mission) })
    if (mission.usedTokens >= mission.budget.maxTokens) this.blockBudget(mission)
  }
  private blockBudget(mission: Mission): void {
    if (terminal(mission) || mission.status === 'blocked') return
    mission.status = 'blocked'; mission.reason = 'Aggregate mission budget exhausted'
    mission.budgetPause = { id: id('budget-pause'), quiesced: false }
    this.commit(mission.id, () => {
      this.store.put('missions', mission)
      for (const task of this.store.list('tasks', mission.id)) if (task.status === 'running' && task.attempt) {
        task.budgetResume = { pauseId: mission.budgetPause!.id, attemptId: task.attempt.id, epoch: task.epoch }
        this.store.put('tasks', task)
      }
      this.store.event(mission.id, 'mission/budget-exhausted', 'runtime', { tokens: mission.usedTokens, steps: mission.usedSteps })
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
          this.store.put('tasks', task); continue
        }
        task.attempt.leaseUntil = Date.now() + this.config.leaseMs
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
  private async recordToolRun(memberId: string, input: Omit<ToolRun, 'id' | 'missionId' | 'memberId' | 'taskId' | 'attemptId' | 'createdAt'>): Promise<void> {
    if (this.closed || input.tool.startsWith('swarm_')) return
    const member = this.store.get('members', memberId)
    if (!member) return
    const task = this.store.list('tasks', member.missionId).find(t => t.status === 'running' && t.attempt?.ownerId === memberId)
    if (!task?.attempt) return
    const run: ToolRun = { ...input, id: id('run'), missionId: member.missionId, memberId, taskId: task.id, attemptId: task.attempt.id, createdAt: Date.now() }
    task.attempt.leaseUntil = Date.now() + this.config.leaseMs
    this.commit(member.missionId, () => { this.store.put('tool_runs', run); this.store.put('tasks', task); this.store.event(member.missionId, 'tool/recorded', memberId, { runId: run.id, taskId: task.id, tool: run.tool, isError: run.isError }) })
  }
  private onIdle(memberId: string): void {
    if (this.closed || this.shuttingDown) return
    const member = this.store.get('members', memberId)
    if (!member || member.status === 'stopped') return
    member.status = 'idle'
    this.commit(member.missionId, () => { this.store.put('members', member) })
    this.kick(member.missionId)
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
      if (task.status !== 'running' || !task.attempt || task.attempt.leaseUntil >= Date.now()) continue
      const oldOwner = task.attempt.ownerId
      task.status = 'blocked'; task.epoch++; task.recoveryCount = (task.recoveryCount ?? 0) + 1; delete task.attempt
      delete task.assigneeId
      task.resumeAfterStop = { epoch: task.epoch, reason: 'lease-expired' }
      this.commit(missionId, () => { this.store.put('tasks', task); this.store.event(missionId, 'task/lease-expired', 'runtime', { taskId: task.id, oldOwner }) })
      await this.workers.stop(oldOwner)
      const fresh = this.task(missionId, task.id)
      if (fresh.epoch !== task.epoch || fresh.status !== 'blocked') continue
      fresh.status = (fresh.recoveryCount ?? 0) >= (fresh.maxRecoveryAttempts ?? this.config.maxTasksPerMember) ? 'blocked' : 'pending'; delete fresh.resumeAfterStop
      this.commit(missionId, () => { this.store.put('tasks', fresh) })
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
      if (this.store.list('tasks', missionId).some(t => t.status === 'running' && t.attempt?.ownerId === member.id)) continue
      const tasks = this.store.list('tasks', missionId).filter(t => this.ready(t, member)).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
      const task = tasks[0]
      if (!task) continue
      try {
        await this.workers.prepareTask(member, { ...task, epoch: task.epoch + 1 }, task.dependencies.map(dep => this.task(missionId, dep)), task.reviewOf ? this.task(missionId, task.reviewOf) : undefined)
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
