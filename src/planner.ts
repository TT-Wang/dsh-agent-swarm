/** Native command admission and owner-agent planning; runtime owns the durable launch. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { realpath } from 'node:fs/promises'
import { registerSwarmCommand } from './command.ts'
import { ownerModelSelection } from './model-selection.ts'
import { runProcess } from './workspaces.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { AutoStart } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'swarm-start': { kind: 'swarm-start'; form: 'notice'; summary: string; requestId: string; commandId: string; planningEpoch?: number; phase?: 'planning' | 'failure' | 'warning' }
  }
}

/**
 * Host-produced instructions retain the exact user goal as separately identified
 * data. Planning rules live once in the owner system prompt; this message carries
 * only the dynamic request facts and the turn contract.
 */
export function planningMessage(request: AutoStart): UserMessage {
  const epoch = request.planningEpoch ?? 1
  return freezeMessage({
    id: MessageId(`swarm-start:${request.id}:${epoch}:planning`), role: 'user',
    source: { kind: 'swarm-start', form: 'notice', summary: 'Agent Swarm: plan and start collaboration', requestId: request.id, commandId: request.commandId, planningEpoch: epoch, phase: 'planning' },
    content: [{ type: 'text', text: `The user invoked /agent-swarm to execute this goal. Plan and launch its collaboration now with swarm_launch and this request id; do not ask them to configure agents or press Launch.
Request id: ${request.id}
Planning epoch: ${epoch} (pass planningEpoch: ${epoch} to swarm_launch; older epochs cannot launch this request)
Planning deadline: ${request.planningDeadlineAt === undefined ? 'read the saved request with swarm_observe' : new Date(request.planningDeadlineAt).toISOString()}. If more planning time is needed, use swarm_control with requestId, action "extend", reason and timeoutMs before the deadline.
Workspace: ${request.workspace}
${request.baseline ? `Frozen planning workspace: ${request.baseline.planningWorkspace}\nSnapshot commit: ${request.baseline.snapshotCommit}\nInspect files and run read-only planning commands in this frozen workspace. The original source may keep changing; all workers use this exact snapshot. Existing user changes are baseline context, not new swarm deliverables.` : ''}
User goal (JSON string): ${JSON.stringify(request.goal)}

Inspect the repository and its existing check commands with a few read-only tool calls; do not edit source files. Follow the Agent Swarm owner protocol in your system prompt: choose the team, task graph, scopes, verbatim acceptance copies, real check commands, all six budget fields, each member's maxOutputTokens and reasoning effort, and each task's maxSteps, maxFindings, maxRecoveryAttempts and checkTimeoutMs from this repository and goal. Workers inherit this conversation's model unless a member sets another route for a concrete reason. If swarm_launch returns validation errors, repair every listed field in one retry with the same request id, planning epoch and complete plan; never use swarm_stage, swarm_create or other delegation tools for this request. After a successful launch, reply briefly with the division of work and budget rationale, end this turn, and wait for runtime notices instead of polling. Report final accepted artifact locations when notified; do not claim the source checkout was changed or merged. If the goal is not actionable, explain the concrete blocker instead of inventing work.` }],
  })
}

function recoveryMessage(request: AutoStart): UserMessage {
  const epoch = request.planningEpoch ?? 1
  return freezeMessage({
    id: MessageId(`swarm-start:${request.id}:${epoch}:failure`), role: 'user',
    source: { kind: 'swarm-start', form: 'notice', summary: 'Agent Swarm: planning needs recovery', requestId: request.id, commandId: request.commandId, planningEpoch: epoch, phase: 'failure' },
    content: [{ type: 'text', text: `Agent Swarm planning needs recovery before execution can continue.
Request id: ${request.id}
Fenced planning epoch: ${epoch}
Recorded reason (JSON string): ${JSON.stringify(request.error ?? 'Planning did not launch a mission.')}
The saved request, project snapshot and recorded usage are retained. Read swarm_observe({ requestId: "${request.id}" }) for the saved request. If this was a recoverable interruption, call swarm_control({ requestId: "${request.id}", action: "retry", reason: "<recovery decision>" }); its new planning message carries the current epoch. If the goal cannot proceed, explain the blocker and use action "stop" with the same requestId. Do not launch from this expired epoch or invent a new request to bypass it.` }],
  })
}

/** Same request and epoch: the warning offers extension before planning expires. */
export function planningWarningMessage(request: AutoStart): UserMessage {
  const epoch = request.planningEpoch ?? 1
  const deadline = request.planningWarning!.deadline
  return freezeMessage({
    id: MessageId(`swarm-start:${request.id}:${epoch}:warning:${deadline}`), role: 'user',
    source: { kind: 'swarm-start', form: 'notice', summary: 'Agent Swarm: review planning time', requestId: request.id, commandId: request.commandId, planningEpoch: epoch, phase: 'warning' },
    content: [{ type: 'text', text: `Planning for saved request ${request.id} (epoch ${epoch}) is approaching its current deadline ${new Date(deadline).toISOString()}. The request and saved snapshot remain active. Review progress now: launch the current plan with swarm_launch when ready, or extend this same request with swarm_control({ requestId: "${request.id}", action: "extend", timeoutMs: <needed milliseconds>, reason: "<progress and remaining work>" }). If planning cannot proceed, use action "stop" with this requestId and explain the blocker.` }],
  })
}

/** Register under the optional native commands service; no custom provider loop. */
export function registerAutomaticStart(ctx: Context, runtime: SwarmRuntime): void {
  let disposed = false
  const lifetime = new AbortController()
  const inFlight = new Set<string>()
  const watchIdle = (agent: Agent, request: AutoStart) => {
    const epoch = request.planningEpoch ?? 1
    const fail = (reason: string) => {
      if (disposed || runtime.shuttingDown || runtime.closed) return
      const current = runtime.store.get('starts', request.id)
      if (current !== undefined && (current.planningEpoch ?? 1) === epoch
        && (current.status === 'planning' || (current.status === 'failed' && !current.planningFenced))) {
        runtime.failStart({ sessionId: request.ownerSessionId }, request.id, current.status === 'failed' ? current.error ?? reason : reason, epoch)
      }
    }
    // Native whenIdle includes queued input. An old turn cannot fail a retry.
    void agent.whenIdle().then(() => fail('规划已结束，但尚未启动协作。请查看对话中的原因，或重试已保存的请求。'),
      () => fail('规划未完成，请查看当前对话并重试已保存的请求。'))
  }
  const pending = (id: string, epoch: number, kind: 'planning' | 'failure' | 'warning') => {
    if (disposed || runtime.shuttingDown || runtime.closed) return undefined
    const row = runtime.store.get('starts', id)
    if (row === undefined || (row.planningEpoch ?? 1) !== epoch) return undefined
    return kind === 'planning'
      ? row.status === 'planning' && !row.planningFenced && row.planningDispatchPending ? row : undefined
      : kind === 'failure' ? row.status === 'failed' && row.recoveryNoticePending ? row : undefined
        : ['planning', 'launching'].includes(row.status) && !row.planningFenced && row.planningWarning !== undefined && row.planningWarning.deadline === row.planningDeadlineAt && row.planningWarning.deliveredAt === undefined ? row : undefined
  }
  const deliver = async (request: AutoStart, kind: 'planning' | 'failure' | 'warning', signal: AbortSignal) => {
    const epoch = request.planningEpoch ?? 1
    const actor = { sessionId: request.ownerSessionId, signal }
    const agent = ctx.agents.get(SessionId(request.ownerSessionId))
    if (agent === undefined) return
    if (kind === 'planning') await runtime.prepareStart(actor, request.id, epoch)
    signal.throwIfAborted()
    const current = pending(request.id, epoch, kind)
    if (current === undefined || ctx.agents.get(agent.id) !== agent) return
    if (kind === 'warning' && current.planningWarning?.deadline !== request.planningWarning?.deadline) return
    const message = kind === 'planning' ? planningMessage(current) : kind === 'warning' ? planningWarningMessage(current) : recoveryMessage(current)
    const seen = agent.session.snapshotEvents().some(event => (event.type === 'user/message' && event.data.id === message.id)
      || (event.type === 'agent/inbox/spliced' && event.data.inserted.some(item => item.id === message.id)))
    if (!seen) agent.send(message, 'next-step', true)
    await ctx.sessions.flush(agent.session)
    signal.throwIfAborted()
    if (pending(request.id, epoch, kind) === undefined) return
    if (kind === 'warning') {
      runtime.commit(request.missionId ?? request.id, () => {
        const latest = pending(request.id, epoch, kind)
        if (latest?.planningWarning === undefined || latest.planningWarning.deadline !== current.planningWarning?.deadline) return
        latest.planningWarning.deliveredAt = runtime.now()
        runtime.store.put('starts', latest)
      })
    } else runtime.ackStartMessage(actor, request.id, epoch, kind)
    if (kind === 'planning') watchIdle(agent, current)
  }
  const dispatch = async (request: AutoStart, kind: 'planning' | 'failure' | 'warning', key: string) => {
    const timeout = new AbortController()
    const signal = AbortSignal.any([lifetime.signal, timeout.signal])
    let timer: ReturnType<typeof setTimeout> | undefined
    const expire = () => {
      try {
        // Snapshot preparation belongs to the owner-controlled planning clock,
        // not the short outbox clock. Re-read at expiry so an extension applies
        // to an already running preparation as well as its next retry.
        const current = kind === 'planning' ? pending(request.id, request.planningEpoch ?? 1, kind) : undefined
        const remaining = current === undefined ? 0
          : (current.planningDeadlineAt ?? current.updatedAt + (runtime.config.planningTimeoutMs ?? 600000)) - runtime.now()
        if (remaining > 0) {
          timer = setTimeout(expire, Math.min(remaining, 2147483647))
          timer.unref()
          return
        }
      } catch { /* Expired or unavailable durable state cannot extend this attempt. */ }
      timeout.abort(new Error('Planning notification delivery timed out'))
    }
    if (kind === 'planning') expire()
    else { timer = setTimeout(expire, runtime.stallPassTimeoutMs); timer.unref() }
    let aborted: () => void = () => {}
    try {
      await Promise.race([deliver(request, kind, signal), new Promise<never>((_resolve, reject) => {
        aborted = () => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        if (signal.aborted) aborted()
      })])
    } catch { /* The durable pending flag survives an absent owner, failed flush or bounded attempt. */ }
    finally {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', aborted)
      timeout.abort()
      inFlight.delete(key)
    }
  }
  const pump = () => {
    if (disposed || runtime.shuttingDown || runtime.closed) return
    try {
      for (const request of runtime.store.list('starts')) {
        const kind = request.status === 'planning' && request.planningDispatchPending ? 'planning'
          : request.status === 'failed' && request.recoveryNoticePending ? 'failure'
            : ['planning', 'launching'].includes(request.status) && request.planningWarning !== undefined && request.planningWarning.deadline === request.planningDeadlineAt && request.planningWarning?.deliveredAt === undefined ? 'warning' : undefined
        if (kind === undefined || ctx.agents.get(SessionId(request.ownerSessionId)) === undefined) continue
        const key = `${request.id}:${request.planningEpoch ?? 1}:${kind}${kind === 'warning' ? `:${request.planningWarning?.deadline}` : ''}`
        if (inFlight.has(key)) continue
        inFlight.add(key)
        void dispatch(request, kind, key)
      }
    } catch { /* A transient read/service failure must not veto agent creation; the timer retries durable pending work. */ }
  }
  const unsubscribe = runtime.subscribe(pump)
  const removeCreated = ctx.on('agent/created', (): undefined => { pump(); return undefined }, { global: true })
  const timer = setInterval(pump, Math.max(25, Math.min(runtime.config.tickMs, 1000)))
  timer.unref()
  ctx.effect(() => () => {
    disposed = true
    clearInterval(timer)
    unsubscribe()
    removeCreated()
    lifetime.abort(new Error('Agent Swarm planner is unloading'))
  }, 'swarm: automatic planner')
  pump()
  registerSwarmCommand(ctx, { start: async invocation => {
    const { agent, sessionId, signal, goal, commandId } = invocation
    signal.throwIfAborted()
    if (disposed) throw new Error('Agent Swarm is unloading')
    if (runtime.isWorkerSession(sessionId) || agent.session.header.origin === 'subagent') throw new Error('请在主对话中开启 Agent Swarm。')
    if (ctx.agents.get(agent.id) !== agent) throw new Error('当前对话已关闭，请重新打开后重试。')
    const existing = runtime.starts({ sessionId }).find(item => item.commandId === commandId)
    if (existing) return { kind: existing.status === 'failed' ? 'error' : 'success', text: existing.error ?? '此协作请求已接收，进度见侧边栏。' }
    const cwd = agent.session.header.cwd
    if (!cwd) throw new Error('请先打开目标项目的对话，然后输入 /agent-swarm 加任务描述。')
    const workspace = await realpath(cwd)
    const git = async (args: string[]) => {
      const result = await runProcess(['git', ...args], { cwd: workspace, signal, timeoutMs: 10000, maxBytes: 16000, subprocess: () => ctx.get('subprocess') })
      if (result.exitCode !== 0 || result.truncated) throw new Error('Agent Swarm 需要一个已有提交的 Git 项目，请在项目根目录的对话中重试。')
      return result.output.trim()
    }
    if (await realpath(await git(['rev-parse', '--show-toplevel'])) !== workspace) throw new Error('请在 Git 项目根目录的对话中开启 Agent Swarm。')
    await git(['rev-parse', 'HEAD^{commit}'])
    const model = await ownerModelSelection(ctx, agent, signal)
    if (!model) throw new Error('当前对话没有可用模型，请先选择模型。')
    await ctx.llm.resolveCallConfig(model, signal)
    signal.throwIfAborted()
    if (disposed) throw new Error('Agent Swarm is unloading')
    let request = runtime.requestStart({ sessionId, signal }, { commandId, goal, workspace })
    try {
      request = await runtime.prepareStart({ sessionId, signal }, request.id, request.planningEpoch ?? 1)
      signal.throwIfAborted()
      if (disposed || ctx.agents.get(agent.id) !== agent) throw new Error('当前对话已关闭，请重新打开后重试。')
      const current = runtime.store.get('starts', request.id)
      if (current?.status !== 'planning' || current.planningFenced || (current.planningEpoch ?? 1) !== (request.planningEpoch ?? 1)) throw new Error('Planning request was stopped or superseded')
      agent.followup(planningMessage(request))
      watchIdle(agent, request)
    } catch (error) {
      if (!disposed && !runtime.shuttingDown && !runtime.closed) runtime.failStart({ sessionId }, request.id, error instanceof Error ? error.message : String(error), request.planningEpoch ?? 1)
      throw error
    }
    return { kind: 'success', text: '已保存当前项目快照，正在自动规划协作。你可以继续编辑项目，成员和进度会显示在侧边栏。' }
  } })
}
