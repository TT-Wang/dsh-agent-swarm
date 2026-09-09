/** DeepSeek Harness plugin: a durable swarm runtime over existing agent/session APIs. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { authorizeWorkspace, loadWorkspaceGrants, type WorkspaceGrant } from './authorization.ts'
import { SwarmRuntime } from './runtime.ts'
import { HarnessWorkers } from './harness-workers.ts'
import { DEFAULT_VERIFICATION_DEPENDENCY_DIRS } from './workspaces.ts'
import { registerTools, SWARM_PROMPT } from './tools.ts'
import { RoleScoper } from './roles.ts'
import { registerAutomaticStart } from './planner.ts'
import { registerWebApi } from './web-api.ts'
import type { Budget } from './types.ts'

declare module '@deepseek-ai/cordis' { interface Context { swarm: SwarmRuntime } }

export const name = 'agent-swarm'
export const inject = ['agents', 'sessions', 'tools', 'systemPrompt', 'llm', 'sessionPersistence', 'sandbox', 'sandboxPolicy', 'approval']
export interface Config {
  statePath: string
  workspacesRoot: string
  leaseMs: number
  tickMs: number
  maxMessageChars: number
  maxEvents: number
  maxAttempts: number
  checkTimeoutMs: number
  maxCheckOutputBytes: number
  /** Ignored dependency directories materialised into verification checkouts; see DEFAULT_VERIFICATION_DEPENDENCY_DIRS. */
  verificationDependencyDirs: string[]
  /** M6: `link` (default) symlinks source dependency directories read-through; `copy` clones them into each checkout. */
  verificationDependencyMode: 'link' | 'copy'
  boundaryCompactionTokens: number
  /** O3: cost weight charged for cache-read input tokens (raw buckets stay visible to the UI). */
  cacheReadWeight: number
  /** O5: interval at which a live native operation republishes activity as lease liveness; 0 disables it. */
  activityHeartbeatMs: number
  /** O4: budget fractions at which the runtime emits an approaching-limit warning. */
  budgetWarnAt: number[]
  /**
   * Human-authorized workspace roots, loaded once at plugin start. A mission
   * may target a repository outside the calling session's cwd only when it is
   * inside one of these roots. No model-callable tool can add, widen or remove
   * a root: changing the set requires a human edit and a host restart.
   */
  authorizedWorkspaces: WorkspaceGrant[]
  defaultBudget: Budget
}
export const Config: z<Config> = z.object({
  statePath: z.string().default(join(homedir(), '.dsh/agent-swarm/swarm.sqlite')),
  workspacesRoot: z.string().default(join(homedir(), '.dsh/agent-swarm/workspaces')),
  leaseMs: z.natural().min(100).default(120000),
  tickMs: z.natural().min(10).default(1000),
  maxMessageChars: z.natural().min(1000).default(16000),
  maxEvents: z.natural().min(1).default(100),
  maxAttempts: z.natural().min(1).default(3),
  checkTimeoutMs: z.natural().min(100).default(60000),
  maxCheckOutputBytes: z.natural().min(1024).default(32000),
  verificationDependencyDirs: z.array(z.string()).default([...DEFAULT_VERIFICATION_DEPENDENCY_DIRS]),
  verificationDependencyMode: z.union(['link', 'copy']).default('link'),
  boundaryCompactionTokens: z.natural().default(250000),
  cacheReadWeight: z.number().min(0).max(1).default(0.1),
  activityHeartbeatMs: z.natural().min(0).default(1000),
  budgetWarnAt: z.array(z.number().min(0).max(1)).default([0.7, 0.9]),
  authorizedWorkspaces: z.array(z.object({
    path: z.string().required().description('Absolute authorized root, symlink-resolved once at start.'),
    note: z.string().description('Human-readable reason shown in the workspace/grant-loaded audit event.'),
    expiresAt: z.natural().description('Epoch milliseconds after which the root is no longer consulted.'),
  })).default([]),
  defaultBudget: z.object({
    maxTokens: z.natural().min(1).default(500000),
    maxSteps: z.natural().min(1).default(200),
    maxWorkers: z.natural().min(1).default(4),
    maxDurationMs: z.natural().min(1).default(3600000),
    maxTasks: z.natural().min(1).default(40),
    maxExperiments: z.natural().min(0).default(8),
  }),
})

/** Register the host service and all consumers under one disposable plugin fiber. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!isAbsolute(config.statePath) || !isAbsolute(config.workspacesRoot)) throw new Error('Swarm statePath and workspacesRoot must be absolute')
  // Human authorization is read exactly once here, from plugin configuration.
  // Nothing below re-reads the profile and no model tool can reach this value.
  const grants = await loadWorkspaceGrants(config.authorizedWorkspaces)
  const workers = new HarnessWorkers(ctx, { ...config, grants })
  const runtime = new SwarmRuntime({ ...config, maxTasksPerMember: config.maxAttempts, grants,
    authorizeWorkspace: (workspace, sessionCwd) => authorizeWorkspace(workspace, sessionCwd, grants) }, workers)
  ctx.effect(() => () => runtime.dispose(), 'swarm.runtime')
  ctx.provide('swarm', runtime)
  registerTools(ctx, runtime, config.defaultBudget, grants)
  // Ordinary sessions get the entry prompt; owner, worker and subagent sessions shadow it by role.
  ctx.systemPrompt.section({ name: 'swarm:usage', order: 119, text: SWARM_PROMPT })
  new RoleScoper(ctx, runtime)
  await runtime.start(grants)
  ctx.inject(['commands'], commands => registerAutomaticStart(commands, runtime))
  ctx.inject(['connection'], browser => registerWebApi(browser, runtime, { defaultBudget: config.defaultBudget, maxPayloadBytes: 1048576, grants }))
}
