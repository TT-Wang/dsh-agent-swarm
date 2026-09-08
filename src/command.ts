/** Native human command: one natural-language request enters the swarm runtime. */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** Preserve the native invocation identity for durable admission and cancellation. */
export interface SwarmCommandRequest extends CommandInvocation {
  readonly sessionId: string
  readonly goal: string
}

export type SwarmCommandStart = (request: SwarmCommandRequest) => CommandResult | Promise<CommandResult>

export interface SwarmCommandOptions {
  /** The runtime owns planning, authorization, deduplication and worker launch. */
  readonly start: SwarmCommandStart
  readonly maxGoalChars?: number
}

/**
 * Register with DSH's shared command service. Its native web adapter supplies
 * slash-menu discovery, a free-form composer and durable command lifecycle rows.
 * The returned disposer is owned by the current Cordis plugin fiber as well.
 */
export function registerSwarmCommand(ctx: Context, options: SwarmCommandOptions): () => void {
  const maxGoalChars = options.maxGoalChars ?? 16000
  if (!Number.isSafeInteger(maxGoalChars) || maxGoalChars < 1) throw new Error('maxGoalChars must be a positive integer')
  return ctx.commands.register({
    name: 'agent-swarm',
    description: '自动组织智能体协作完成任务 · Start an agent swarm',
    input: { hint: '描述你想完成的任务，例如：为项目添加搜索功能并验证' },
    async handler(invocation) {
      invocation.signal.throwIfAborted()
      const goal = invocation.rawInput.trim()
      if (goal.length === 0) return {
        kind: 'error',
        text: '请输入任务描述，例如：/agent-swarm 为项目添加搜索功能并验证。',
      }
      if (goal.length > maxGoalChars) return {
        kind: 'error',
        text: `任务描述过长，请缩短至 ${maxGoalChars} 个字符以内。`,
      }
      return options.start(Object.freeze({ ...invocation, sessionId: String(invocation.agent.id), goal }))
    },
  })
}
