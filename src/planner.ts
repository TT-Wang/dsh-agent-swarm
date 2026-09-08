/** Native command admission and owner-agent planning; runtime owns the durable launch. */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { realpath } from 'node:fs/promises'
import { registerSwarmCommand } from './command.ts'
import { TASK_PLANNING_RULES } from './tools.ts'
import { ownerModelSelection } from './model-selection.ts'
import { runProcess } from './workspaces.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { AutoStart } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'swarm-start': { kind: 'swarm-start'; form: 'notice'; summary: string; requestId: string; commandId: string }
  }
}

/** Host-produced instructions retain the exact user goal as separately identified data. */
export function planningMessage(request: AutoStart) {
  return createUserMessage({
    source: { kind: 'swarm-start', form: 'notice', summary: 'Agent Swarm: plan and start collaboration', requestId: request.id, commandId: request.commandId },
    content: [{ type: 'text', text: `The user invoked /agent-swarm to execute this goal. Automatically plan and launch its collaboration now; do not ask them to configure agents or press Launch.
Request id: ${request.id}
Workspace: ${request.workspace}
${request.baseline ? `Frozen planning workspace: ${request.baseline.planningWorkspace}\nSnapshot commit: ${request.baseline.snapshotCommit}\nInspect files and run read-only planning commands in this frozen workspace. The original source may keep changing; all workers will use this exact snapshot. Existing user changes are baseline context, not new swarm deliverables.` : ''}
Resource budgets: choose these yourself from the actual task; no preset token or step allowance has been selected.
User goal (JSON string): ${JSON.stringify(request.goal)}

Inspect the repository and relevant existing checks using a few read-only tool calls. Do not edit source files during planning. Choose the smallest useful team of persistent members suited to this goal, with at least two members for independent review. Workers inherit the current conversation model unless you explicitly select another available route for a concrete task reason. Decompose only useful work into a complete, bounded plan. Use narrow relative paths for scope, existing repository test commands that actually prove the goal; prefer the verified project scripts to inventing complex shell pipelines, and exact matching acceptance strings between mission and delivery tasks. Host acceptance commands run in a clean checkout of the committed immutable artifact. Never rely on uncommitted git diff output in those commands; the host separately validates changed paths against task scope.
${TASK_PLANNING_RULES}
Decide all six budget fields yourself: maxTokens (estimated total worker input/output tokens, including repeated context), maxSteps (total worker model calls), maxWorkers (team capacity), maxDurationMs (whole-mission elapsed time), maxTasks (room for the planned graph and likely repairs), maxExperiments (useful alternative hypotheses). Estimate from repository size, complexity, testing cost and uncertainty; avoid blindly copying a fixed allowance. Choose each member's maxOutputTokens (per-request output allowance) for its role within the selected model's capabilities. Select each task's maxRecoveryAttempts for lease/restart recovery and checkTimeoutMs for its check commands. Choose scopes, acceptance, check commands, dependencies, priorities and experimental work yourself. During execution, inspect real progress and use swarm_budget with a reason to adjust resource ceilings when warranted. Existing consumed tokens and steps are never reset; after a budget block, adjust it and use swarm_control resume if continuing is justified.
Call swarm_launch with requestId ${request.id} and your complete plan. Required record fields (do not drop fields when retrying):
- members[]: key, name, role, maxOutputTokens.
- workstreams[]: key, title, objective.
- tasks[]: key, workstreamKey, title, objective, kind, scope, acceptance, assigneeKey, maxRecoveryAttempts, checkTimeoutMs. Code sources also need checks; verification also needs reviewOf; integration needs dependencies.
Every single tasks[] entry MUST contain its own explicit key, including verification entries. title is not key. For example a source key task_1 is referenced by reviewOf: task_1; choose your own stable identifiers for the actual task. scopes contain only literal relative paths (such as src/ or a filename discovered in this repository); put explanations in objective, not scope. Copy mission acceptance strings verbatim into relevant task acceptance arrays; for code, the final integration task should copy the entire mission acceptance array exactly. Never weaken or delete a user requirement just to pass schema validation. If a tool returns a validation error, repair that specific field while preserving all other required fields and the user's complete goal. Assign each task to a member. Every research, implementation and integration task needs a verification task assigned to a different member, with reviewOf pointing at its source key. Do not also put that source in the verification task's dependencies: the reviewer starts on the submitted artifact. For code, include an integration task depending on the implementation tasks so their accepted artifacts are assembled; include a separate independent reviewOf that integration. Integration needs the real verification commands too. For a small code change, two members and four tasks (implement, review implementation, integrate, review integration) suffice. Avoid redundant research or busywork. Do not hard-code a sample goal or tests from these instructions.
swarm_launch validates and launches the entire plan automatically. If validation reports a correctable error, fix the plan and retry the same requestId. Never use swarm_stage, manual UI setup, swarm_create, or other delegation tools for this request. After successful launch or resume, give a brief text response and end this native conversation turn. Explain the division of work and budget rationale after launch. The runtime sends notices when your attention is needed and when the mission completes; wait for those notices rather than polling. swarm_wait is for member workers only, not the primary agent. The runtime automatically completes only after independently accepted results meet all criteria. Report final accepted artifact locations; do not claim the source checkout was changed or merged. If the goal is not actionable, explain the concrete blocker instead of inventing work.` }],
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
      const result = await runProcess(['git', ...args], { cwd: workspace, signal, timeoutMs: 10000, maxBytes: 16000 })
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
