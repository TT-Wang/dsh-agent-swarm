/** Shared worker routing: native live selection, durable owner header, then defaults. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { PlanMember } from './types.js'

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
export function workerModelSelection(owner: ModelSelection | undefined, member: Pick<PlanMember, 'provider' | 'model' | 'reasoningEffort'>): ModelSelection {
  const provider = member.provider ?? owner?.provider
  const model = member.model ?? owner?.model
  if (!provider || !model) throw new Error('Choose an explicit provider and model or open an owner session with a model selection')
  const effort = member.reasoningEffort ?? (member.provider === undefined && member.model === undefined ? owner?.reasoningEffort : undefined)
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }) }
}
