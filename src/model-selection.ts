/** Shared worker routing: native live selection, durable owner header, then defaults. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { MemberRoute, MemberRouteInput } from './types.js'
import { PolicyError } from './policy-error.js'

function sameSelection(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/** Headless compositions may omit the Web projection, but retain its public durable events. */
function pendingSelection(ctx: Context, owner: Agent): ModelSelection | undefined {
  const projected = ctx.get('sessionProjections')?.stateOf(owner.session, 'modelSelection')
  if (projected !== undefined) return projected.pending === null ? undefined : {
    provider: projected.pending.provider, model: projected.pending.model,
    ...(projected.pending.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(projected.pending.reasoningEffort) }),
  }
  let pending: ModelSelection | undefined
  for (const event of owner.session.snapshotEvents()) {
    if (event.type === 'model/selection') pending = { provider: event.data.provider, model: event.data.model,
      ...(event.data.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(event.data.reasoningEffort) }) }
    if (event.type === 'request/header' && pending !== undefined && sameSelection(pending, event.data.header.config)) pending = undefined
  }
  return pending
}

/** Read the same current selection shown by the native owner model picker. */
export async function ownerModelSelection(ctx: Context, owner: Agent, signal?: AbortSignal): Promise<ModelSelection | undefined> {
  signal?.throwIfAborted()
  const pending = pendingSelection(ctx, owner)
  if (pending !== undefined) return pending
  const header = owner.session.requestHeader()
  const logged = header?.config
  const defaults = ctx.get('agentDefaultModel')?.currentSelection()
  const provider = logged?.provider ?? owner.options.provider ?? defaults?.provider
  const model = logged?.model ?? owner.options.model ?? defaults?.model
  if (!provider || !model) return undefined
  const effort = logged !== undefined ? header?.adapterDefaults?.reasoningEffort === true ? undefined : logged.reasoningEffort
    : owner.options.reasoningEffort ?? (provider === defaults?.provider && model === defaults.model ? defaults.reasoningEffort : undefined)
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

/** A newly selected route restores provider defaults unless effort is explicit. */
function workerModelSelection(owner: ModelSelection | undefined, member: MemberRouteInput): ModelSelection {
  const provider = member.provider ?? owner?.provider
  const model = member.model ?? owner?.model
  if (!provider || !model) throw new PolicyError('model_selection_required', 'authorization_error', 'Choose an explicit provider and model or open an owner session with a model selection')
  const effort = member.reasoningEffort ?? (member.provider === undefined && member.model === undefined ? owner?.reasoningEffort : undefined)
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }) }
}

/**
 * The route a worker is created on: the owner's selection (`inherited`) under
 * the member's own route fields, or none when neither names one, and the
 * worker runs its preset's defaults. Worker composition and admission
 * (`memberRoutes`) both read it, so admission checks the route a worker runs.
 */
export function workerRoute(inherited: ModelSelection | undefined, member: MemberRouteInput): ModelSelection | undefined {
  return inherited === undefined && member.provider === undefined && member.model === undefined && member.reasoningEffort === undefined
    ? undefined : workerModelSelection(inherited, member)
}

/**
 * Each member's route as its worker will run it (`workerRoute` under the owner
 * session's current selection), checked by the host's own call-config
 * validation, which refuses an effort the route's model does not declare before
 * any provider request (`llm.resolveCallConfig`). A refused effort is answered
 * with the efforts that model declares (`llm.resolveModelInfo`); any other
 * resolution failure is an unavailable route. The host's text can carry host
 * paths or internal route codes (SURFACE-R3-01), so it is logged and never
 * returned. A worker that runs no route of its own has nothing to resolve.
 */
export async function memberRoutes(ctx: Context, ownerSessionId: string, members: readonly MemberRouteInput[], signal?: AbortSignal): Promise<MemberRoute[]> {
  const owner = ctx.agents.get(SessionId(ownerSessionId))
  const inherited = owner === undefined ? undefined : await ownerModelSelection(ctx, owner, signal)
  const routes: MemberRoute[] = []
  for (const member of members) {
    const route = workerRoute(inherited, member)
    routes.push(route === undefined ? { verdict: 'accepted' } : await resolvedRoute(ctx, route, signal))
  }
  return routes
}

async function resolvedRoute(ctx: Context, route: ModelSelection, signal?: AbortSignal): Promise<MemberRoute> {
  const { provider, model, reasoningEffort } = route
  try {
    await ctx.llm.resolveCallConfig(route, signal)
    return { verdict: 'accepted' }
  } catch (error) {
    signal?.throwIfAborted()
    // The Harness LLM error code, read structurally like every provider code (src/scheduler.ts).
    const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
    if (reasoningEffort !== undefined && code === 'UNSUPPORTED_REASONING_EFFORT') {
      const declared = (await ctx.llm.resolveModelInfo(provider, model, signal)).reasoning?.efforts ?? []
      return { verdict: 'effort-unsupported', provider, model, effort: reasoningEffort, efforts: declared.map(effort => effort.id) }
    }
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    try { ctx.logger.warn('agent-swarm: model route %s/%s failed to resolve: %s', provider, model, detail) } catch { /* Logging must never mask the answer. */ }
    return { verdict: 'unavailable', provider, model }
  }
}
