/** DeepSeek Harness plugin: a durable swarm runtime over existing agent/session APIs. */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { authorizeWorkspace, loadWorkspaceGrants, type WorkspaceGrant } from './authorization.ts'
import { applyPendingRestore } from './store.ts'
import { SwarmRuntime } from './runtime.ts'
import { HarnessWorkers } from './harness-workers.ts'
import { DEFAULT_VERIFICATION_DEPENDENCY_DIRS } from './workspaces.ts'
import { registerTools, SWARM_PROMPT } from './tools.ts'
import { RoleScoper } from './roles.ts'
import { OwnerReplyGuard } from './owner-reply.ts'
import { registerAutomaticStart } from './planner.ts'
import { registerWebApi } from './web-api.ts'
import { liveLineageSubject, noticeFamily } from './notices.ts'
import { installSwarmInvariant } from './invariant.ts'
import { bindHostTelemetry, DEFAULT_TRACE_SPILL_LIMITS, TRACE_SPILL_RETENTION_DAYS, type HostTelemetrySink } from './trace.ts'
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
  /** M6/R11-13: `link` symlinks source dependency directories read-through; `copy` (the effective default) clones them into each checkout. */
  verificationDependencyMode: 'link' | 'copy'
  /**
   * R11-13: explicit human opt-in for a read-through dependency link. A
   * symlinked directory lets `node_modules/..` resolve into the source checkout
   * and the F-29 sandbox governs writes, not reads, so `link` is honored only
   * when this is true; otherwise the effective mode is `copy`.
   */
  allowDependencyLinkReads: boolean
  boundaryCompactionTokens: number
  /** O3: cost weight charged for cache-read input tokens (raw buckets stay visible to the UI). */
  cacheReadWeight: number
  /** O5: interval at which a live native operation republishes activity as lease liveness; 0 disables it. */
  activityHeartbeatMs: number
  /** O4: budget fractions at which the runtime emits an approaching-limit warning. */
  budgetWarnAt: number[]
  /**
   * R11-19: maximum declared-check executions per host. Forwarded unchanged to
   * the owned `Workspaces` semaphore, which queues the rest in FIFO order and
   * measures the envelope.
   */
  checkConcurrency: number
  /**
   * Human-authorized workspace roots, loaded once at plugin start. A mission
   * may target a repository outside the calling session's cwd only when it is
   * inside one of these roots. No model-callable tool can add, widen or remove
   * a root: changing the set requires a human edit and a host restart.
   */
  authorizedWorkspaces: WorkspaceGrant[]
  defaultBudget: Budget
  /**
   * R17-G10: hard bound, in bytes, on the content-addressed span-payload spill
   * beside the state file. Oldest payloads are evicted first, and an evicted
   * payload is reported as `missing` by `traceMetrics`, never silently.
   */
  traceSpillMaxBytes: number
  /** R17-G10: hard bound on the number of payload files held by the spill. */
  traceSpillMaxFiles: number
  /** R17-G10: days a payload file is retained; `0` disables age retention and keeps the size bound only. */
  traceSpillRetentionDays: number
  /**
   * L2 owner-reply guard. `nudge` (default) records a question the owner's turn
   * left unanswered and instructs with the exact call; `block` additionally
   * refuses the owner's next step while the receipt stays open.
   */
  ownerReplyGuard: 'nudge' | 'block'
  /** Nudges spent on one unanswered owner question before the guard terminal; default 2. */
  maxOwnerReplyNudges: number
}
export const Config: z<Config> = z.object({
  statePath: z.string().default(join(homedir(), '.dsh/agent-swarm/swarm.sqlite')),
  workspacesRoot: z.string().default(join(homedir(), '.dsh/agent-swarm/workspaces')),
  leaseMs: z.natural().min(100).default(120000),
  tickMs: z.natural().min(10).default(1000),
  maxMessageChars: z.natural().min(1000).default(16000),
  maxEvents: z.natural().min(1).default(100),
  maxAttempts: z.natural().min(1).default(3),
  // The budget one declared check runs under. This project's own checks
  // (`npm run typecheck && npm run build && node --test <file>`) measure 67-111 s
  // on an idle host and longer under load, so the former 60 s fallback cancelled
  // legitimate checks mid-run and three reviewers could not record a verdict for
  // the resulting failures. Ten minutes fits a real check while still bounding a
  // hang; a task may declare its own value (900000 and 1800000 are used in this
  // campaign) and that value wins.
  checkTimeoutMs: z.natural().min(100).default(600000),
  maxCheckOutputBytes: z.natural().min(1024).default(32000),
  ownerReplyGuard: z.union(['nudge', 'block']).default('nudge'),
  maxOwnerReplyNudges: z.natural().min(0).default(2),
  verificationDependencyDirs: z.array(z.string()).default([...DEFAULT_VERIFICATION_DEPENDENCY_DIRS]),
  verificationDependencyMode: z.union(['link', 'copy']).default('link'),
  allowDependencyLinkReads: z.boolean().default(false),
  boundaryCompactionTokens: z.natural().default(250000),
  cacheReadWeight: z.number().min(0).max(1).default(0.1),
  activityHeartbeatMs: z.natural().min(0).default(1000),
  budgetWarnAt: z.array(z.number().min(0).max(1)).default([0.7, 0.9]),
  checkConcurrency: z.natural().min(1).default(2),
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
  // The spill bound defaults come from the trace module's declared limits, so
  // the schema and the sweep cannot disagree about what the bound is.
  traceSpillMaxBytes: z.natural().min(1).default(DEFAULT_TRACE_SPILL_LIMITS.maxBytes),
  traceSpillMaxFiles: z.natural().min(1).default(DEFAULT_TRACE_SPILL_LIMITS.maxFiles),
  traceSpillRetentionDays: z.natural().min(0).default(TRACE_SPILL_RETENTION_DAYS),
})

/**
 * R17-G10: adopt the host telemetry sink for this runtime.
 *
 * The sink is a cordis service (`ctx.sessionTelemetry` from
 * `@deepseek-ai/dsh-session-telemetry`), so the plugin discovers it through the
 * registry instead of importing the host package: `ctx.inject` fires whether the
 * backend is mounted before or after this plugin, and a composition with no
 * backend mounted records exactly as before (durable span rows, no sink) — the
 * host's own "no backend" behaviour, not this plugin's silence. The link is
 * created before `registerTools` builds the recorder and shared through the
 * runtime identity, because the recorder's construction site (`src/tools.ts`) is
 * outside this change's scope while the context is only available here. The
 * disposer detaches the sink with the plugin fiber, so no backend keeps a
 * reporter after unload; the fiber is returned so a caller (and the pair test)
 * can reach it.
 */
export function installHostTelemetry(ctx: Context, runtime: unknown): Fiber {
  const link = bindHostTelemetry(runtime as object)
  return ctx.inject(['sessionTelemetry'], scoped => {
    link.attach(scoped.get('sessionTelemetry') as HostTelemetrySink | undefined)
    return () => link.detach()
  })
}

/** Register the host service and all consumers under one disposable plugin fiber. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!isAbsolute(config.statePath) || !isAbsolute(config.workspacesRoot)) throw new Error('Swarm statePath and workspacesRoot must be absolute')
  // Human authorization is read exactly once here, from plugin configuration.
  // Nothing below re-reads the profile and no model tool can reach this value.
  const grants = await loadWorkspaceGrants(config.authorizedWorkspaces)
  // R11-02: an owner-staged restore request is applied before the store opens,
  // so a corrupted or deleted state file recovers at the next host start
  // instead of starting empty. Applying here (not in a model tool) keeps the
  // swap outside any live runtime's ownership.
  const restored = applyPendingRestore(config.statePath)
  const workers = new HarnessWorkers(ctx, { ...config, grants })
  const runtime = new SwarmRuntime({ ...config, maxTasksPerMember: config.maxAttempts, grants,
    authorizeWorkspace: (workspace, sessionCwd) => authorizeWorkspace(workspace, sessionCwd, grants) }, workers)
  if (restored !== undefined) runtime.store.transaction(() => runtime.store.event('swarm/install', 'store/restored', 'runtime',
    { snapshot: restored.snapshot, requestedAt: restored.requestedAt, ...(restored.requestedBy === undefined ? {} : { requestedBy: restored.requestedBy }) }))
  ctx.effect(() => () => runtime.dispose(), 'swarm.runtime')
  ctx.provide('swarm', runtime)
  // R17-G9: the pre-append invariant pilot. The companion registers through the
  // host's `ctx.invariants` facility (the same one twelve host packages use), so
  // an owner-facing decision naming a subject whose lineage still has a live path
  // is refused BEFORE its host session event is published. The judge maps one
  // relayed swarm message to the shared lineage predicate (`liveLineageSubject`,
  // the emission-time counterpart of the wake-precision classifier); a deployment
  // that mounts no invariant registry keeps working and reports the pilot as not
  // landed through `swarmInvariantStatus`.
  installSwarmInvariant(ctx, message => {
    const source = message.source
    if (source?.kind !== 'swarm' || typeof source.deliveryId !== 'string') return undefined
    const delivery = runtime.store.get('deliveries', source.deliveryId)
    if (delivery === undefined || delivery.to !== 'owner') return undefined
    const family = noticeFamily(delivery)
    const reason = liveLineageSubject(runtime, { missionId: delivery.missionId, family, subjects: delivery.subjects ?? [] })
    if (reason === undefined) return undefined
    return { missionId: delivery.missionId, family, subjects: [...(delivery.subjects ?? [])], reason, deliveryId: delivery.id }
  })
  // R17-G10: the host sink link exists before the recorder does; `registerTools`
  // builds the recorder from the runtime identity this binding is keyed on.
  installHostTelemetry(ctx, runtime)
  registerTools(ctx, runtime, config.defaultBudget, grants)
  // Ordinary sessions get the entry prompt; owner, worker and subagent sessions shadow it by role.
  ctx.systemPrompt.section({ name: 'swarm:usage', order: 119, text: SWARM_PROMPT })
  new RoleScoper(ctx, runtime)
  await runtime.start(grants)
  // L2: the owner side of the reply protocol. The guard observes owner turns and
  // reports questions the turn did not settle; it never answers on the owner's
  // behalf and never edits a message.
  const ownerReplies = new OwnerReplyGuard(ctx, runtime, { guard: config.ownerReplyGuard, maxNudges: config.maxOwnerReplyNudges })
  ctx.effect(() => () => ownerReplies.dispose(), 'swarm.owner-reply-guard')
  ctx.inject(['commands'], commands => registerAutomaticStart(commands, runtime))
  ctx.inject(['connection', 'webServer'], browser => registerWebApi(browser, runtime, { defaultBudget: config.defaultBudget, maxPayloadBytes: 1048576, grants }))
}
