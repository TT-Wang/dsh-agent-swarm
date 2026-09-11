/** Native command admission and owner-agent planning; runtime owns the durable launch. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { realpath } from 'node:fs/promises'
import { registerSwarmCommand } from './command.ts'
import { ownerModelSelection } from './model-selection.ts'
import { runProcess } from './workspaces.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { AutoStart } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'swarm-start': { kind: 'swarm-start'; form: 'notice'; summary: string; requestId: string; commandId: string }
  }
}

/**
 * Host-produced instructions retain the exact user goal as separately identified
 * data. Planning rules live once in the owner system prompt; this message carries
 * only the dynamic request facts and the turn contract.
 */
export function planningMessage(request: AutoStart) {
  return createUserMessage({
    source: { kind: 'swarm-start', form: 'notice', summary: 'Agent Swarm: plan and start collaboration', requestId: request.id, commandId: request.commandId },
    content: [{ type: 'text', text: `The user invoked /agent-swarm to execute this goal. Plan and launch its collaboration now with swarm_launch and this request id; do not ask them to configure agents or press Launch.
Request id: ${request.id}
Workspace: ${request.workspace}
${request.baseline ? `Frozen planning workspace: ${request.baseline.planningWorkspace}\nSnapshot commit: ${request.baseline.snapshotCommit}\nInspect files and run read-only planning commands in this frozen workspace. The original source may keep changing; all workers use this exact snapshot. Existing user changes are baseline context, not new swarm deliverables.` : ''}
User goal (JSON string): ${JSON.stringify(request.goal)}

Inspect the repository and its existing check commands with a few read-only tool calls; do not edit source files. Follow the Agent Swarm owner protocol in your system prompt: choose the team, task graph, scopes, verbatim acceptance copies, real check commands, all six budget fields, each member's maxOutputTokens and reasoning effort, and each task's maxRecoveryAttempts and checkTimeoutMs from this repository and goal. Workers inherit this conversation's model unless a member sets another route for a concrete reason. If swarm_launch returns validation errors, repair every listed field in one retry with the same request id and complete plan; never use swarm_stage, swarm_create or other delegation tools for this request. After a successful launch, reply briefly with the division of work and budget rationale, end this turn, and wait for runtime notices instead of polling. Report final accepted artifact locations when notified; do not claim the source checkout was changed or merged. If the goal is not actionable, explain the concrete blocker instead of inventing work.` }],
  })
}

/** Register under the optional native commands service; no custom provider loop. */
export function registerAutomaticStart(ctx: Context, runtime: SwarmRuntime): void {
  let disposed = false
  ctx.effect(() => () => { disposed = true }, 'swarm: automatic planner')
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
      request = await runtime.prepareStart({ sessionId, signal }, request.id)
      signal.throwIfAborted()
      if (disposed || ctx.agents.get(agent.id) !== agent) throw new Error('当前对话已关闭，请重新打开后重试。')
      agent.followup(planningMessage(request))
      // Native whenIdle includes any queued follow-up: it cannot race ahead of planning.
      void agent.whenIdle().then(() => {
        if (!disposed && runtime.starts({ sessionId }).find(item => item.id === request.id)?.status === 'planning') {
          runtime.failStart({ sessionId }, request.id, '规划已结束，但尚未启动协作。请查看对话中的原因，或重新输入 /agent-swarm 加任务描述。')
        }
      }, () => { if (!disposed) runtime.failStart({ sessionId }, request.id, '规划未完成，请查看当前对话并重试。') })
    } catch (error) {
      runtime.failStart({ sessionId }, request.id, error instanceof Error ? error.message : String(error))
      throw error
    }
    return { kind: 'success', text: '已保存当前项目快照，正在自动规划协作。你可以继续编辑项目，成员和进度会显示在侧边栏。' }
  } })
}
