/** Optional native browser RPC consumers of the durable swarm runtime. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import { isAppendSurfaceEvent, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-llm'
import { realpath } from 'node:fs/promises'
import type { SwarmRuntime } from './runtime.ts'
import { validatePlan } from './plans.ts'
import { ownerModelSelection, workerModelSelection } from './model-selection.js'
import { persistedSessionHeader } from './session-metadata.js'
import type { Actor, Budget, PlanInput, PlanMember } from './types.ts'
import type { LiveState, LiveUpdate } from './live-types.ts'
import { waitForStateChange } from './watch.ts'

/** Payload bound is additional to the native Connection carrier's HTTP limit. */
export interface WebApiOptions {
  defaultBudget: Budget
  maxPayloadBytes: number
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RequestError('Expected a JSON object')
  return value as Record<string, unknown>
}
function text(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') throw new RequestError(`${key} must be a nonempty string`)
  return value
}
function stringArray(body: Record<string, unknown>, key: string): string[] {
  const value = body[key]
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim() !== '')) throw new RequestError(`${key} must be a string array`)
  return value
}
function revision(body: Record<string, unknown>): number {
  const value = body.revision
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new RequestError('revision must be a positive integer')
  return Number(value)
}
/** A user-actionable request failure whose message is safe to return to the browser. */
class RequestError extends Error {}
/**
 * Expose a collaborator's user-actionable validation/policy error (plan
 * admission, mission policy, model routing) to the browser. Errors that reach
 * the handler outside these known validation operations are unexpected and are
 * sanitized by the catch below; the original is logged host-side.
 */
async function exposed<T>(operation: () => Promise<T> | T): Promise<T> {
  try { return await operation() } catch (error) {
    if (error instanceof MissingSession) throw error
    throw new RequestError(error instanceof Error ? error.message : String(error))
  }
}
class MissingSession extends Error {
  constructor(readonly sessionId: SessionId) { super(`Session ${sessionId} is not an available workspace session`) }
}

async function sessionHeader(ctx: Context, id: SessionId, signal: AbortSignal): Promise<SessionHeader> {
  signal.throwIfAborted()
  const attached = ctx.sessions.get(id)
  const header = attached?.header ?? await persistedSessionHeader(ctx.sessionPersistence, id, signal)
  if (header?.cwd === undefined || header.origin === 'subagent') throw new MissingSession(id)
  const parent = header.parentSession === undefined ? undefined : ctx.agents.get(header.parentSession)
  if (parent !== undefined && ctx.agents.isOwnedBy(id, parent)) throw new MissingSession(id)
  return header
}

async function planInput(ctx: Context, body: Record<string, unknown>, header: SessionHeader, signal: AbortSignal, launching = false): Promise<PlanInput> {
  const input = object(body.input)
  const workspace = await canonicalWorkspace(text(input, 'workspace'), header)
  const plan = await exposed(() => validatePlan({ ...input, workspace }))
  await validateModels(ctx, header.id, plan.members, signal, launching)
  return plan
}

async function canonicalWorkspace(input: string, header: SessionHeader): Promise<string> {
  const workspace = await realpath(input).catch(() => undefined)
  const session = header.cwd === undefined ? undefined : await realpath(header.cwd).catch(() => undefined)
  if (session === undefined || workspace === undefined || workspace !== session) throw new RequestError('Plan workspace must match the selected session workspace')
  return workspace
}

async function validateModels(ctx: Context, ownerId: SessionId, members: Pick<PlanMember, 'provider' | 'model' | 'reasoningEffort'>[], signal: AbortSignal, launching: boolean): Promise<void> {
  const owner = ctx.agents.get(ownerId)
  const defaults = owner === undefined ? undefined : await ownerModelSelection(ctx, owner, signal)
  const providers = new Set(ctx.llm.listProviders().map(provider => provider.id))
  for (const member of members) {
    signal.throwIfAborted()
    if (!launching && member.provider === undefined && member.model === undefined && member.reasoningEffort === undefined) continue
    const selected = workerModelSelection(defaults, member)
    if (!providers.has(selected.provider)) throw new RequestError(`Unknown model provider: ${selected.provider}`)
    // Exact route resolution is authoritative. A provider may route models not
    // present in its advisory picker catalog; those remain valid selections.
    await exposed(() => ctx.llm.resolveCallConfig(selected, signal))
  }
}

/**
 * Mount the `/agent-swarm` channel through Harness Connection's authenticated
 * Host, Origin and Fetch-Metadata checks. Call inside a connection injection;
 * the native registry owns disposal under this caller's plugin fiber.
 * @param ctx - injected Connection plus the existing swarm host services.
 * @param runtime - sole owner of mission and draft policy/state.
 * @param options - resolved display defaults and bounded JSON payload size.
 */
export function registerWebApi(ctx: Context, runtime: SwarmRuntime, options: WebApiOptions): void {
  if (!Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 1) throw new Error('maxPayloadBytes must be a positive integer')
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(new Error('Swarm web API was unloaded')), 'agent-swarm: watches')
  const stateFor = (actor: Actor, header: SessionHeader, changed?: ReadonlySet<string>): { state: LiveState; missionIds: string[] } => {
    const visible = runtime.visibleMissions(actor)
    const writable = !runtime.isWorkerSession(actor.sessionId)
    return { missionIds: visible.map(mission => mission.id), state: {
      ownerSessionId: actor.sessionId, workspace: header.cwd!,
      snapshots: visible.filter(mission => changed === undefined || changed.has(mission.id)).map(mission => runtime.snapshot(actor, mission.id)),
      drafts: runtime.drafts(actor), starts: writable ? runtime.starts(actor) : [], defaultBudget: options.defaultBudget,
      writable, ownerLive: writable && ctx.agents.get(SessionId(actor.sessionId)) !== undefined, revision: runtime.store.revision(),
    } }
  }
  const handler: ConnectionRpcHandler = async (endpoint, payload, signal) => {
    try {
      signal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(payload) ?? '', 'utf8') > options.maxPayloadBytes) throw new RequestError('Swarm request exceeds the payload limit')
      const body = object(payload)
      // L2: every RPC, including the provider/model catalog, binds to an
      // authenticated, non-subagent workspace session.
      const sessionId = SessionId(text(body, 'sessionId'))
      const header = await sessionHeader(ctx, sessionId, signal)
      const actor: Actor = { sessionId, signal }
      signal.throwIfAborted()
      switch (endpoint) {
        case 'models': {
          const providers = ctx.llm.listProviders().map(provider => ({ id: provider.id, name: provider.name }))
          const models = (await Promise.all(providers.map(async provider => await ctx.llm.listModels(provider.id)))).flat()
            .map(model => ({ provider: model.provider, id: model.id, name: model.name,
              ...(model.description === undefined ? {} : { description: model.description }) }))
          return { ok: true, value: { providers, models } }
        }
        case 'delivery':
        case 'apply-delivery': {
          const missionId = text(body, 'missionId')
          const mission = runtime.store.get('missions', missionId)
          if (!mission || mission.ownerSessionId !== sessionId) throw new RequestError('Only the mission owner can access deliverables')
          await canonicalWorkspace(mission.workspace, header)
          if (endpoint === 'delivery') return { ok: true, value: { delivery: await exposed(() => runtime.inspectDelivery(actor, missionId)) } }
          return { ok: true, value: { result: await exposed(() => runtime.applyDelivery(actor, missionId)), snapshot: runtime.snapshot(actor, missionId) } }
        }
        case 'worker-history': {
          const workerSessionId = SessionId(text(body, 'workerSessionId'))
          const member = runtime.store.list('members').find(candidate => candidate.sessionId === workerSessionId)
          const mission = member === undefined ? undefined : runtime.store.get('missions', member.missionId)
          if (mission?.ownerSessionId !== sessionId) throw new RequestError('Only the mission owner can inspect this worker history')
          const maxMessages = body.maxMessages ?? 30
          if (!Number.isSafeInteger(maxMessages) || Number(maxMessages) < 1 || Number(maxMessages) > 100) throw new RequestError('maxMessages must be an integer from 1 to 100')
          const beforeSeq = body.beforeSeq
          if (beforeSeq !== undefined && (!Number.isSafeInteger(beforeSeq) || Number(beforeSeq) < 0)) throw new RequestError('beforeSeq must be a nonnegative safe integer')
          const controller = ctx.get('sessionController')
          if (controller === undefined) throw new RequestError('Worker history requires the native session controller')
          // inspect is the public cold-safe read. Remote.follow may promote an
          // archived worker into a live Agent and must not serve this sidebar.
          const inspected = await exposed(() => controller.inspect(workerSessionId, signal))
          signal.throwIfAborted()
          const events = inspected.events
          const end = Math.min(events.length, beforeSeq === undefined ? events.length : Number(beforeSeq))
          let count = 0
          let cut = 0
          for (let index = end - 1; index >= 0; index--) {
            const event = events[index]!
            if ((event.type !== 'user/message' && event.type !== 'assistant/message') || !isAppendSurfaceEvent(event)) continue
            if (++count >= Number(maxMessages)) {
              cut = Math.min(event.seq, ...(event.sourceEventSeqs ?? []))
              break
            }
          }
          return { ok: true, value: { events: events.slice(cut, end).map(event => ({ event })), hasMore: cut > 0 } }
        }
        case 'state': {
          return { ok: true, value: stateFor(actor, header).state }
        }
        case 'watch': {
          const after = body.afterRevision
          if (after !== undefined && (!Number.isSafeInteger(after) || Number(after) < 0)) throw new RequestError('afterRevision must be a nonnegative safe integer')
          const waitMs = body.waitMs ?? 20_000
          if (!Number.isSafeInteger(waitMs) || Number(waitMs) < 0 || Number(waitMs) > 20_000) throw new RequestError('waitMs must be an integer from 0 through 20000')
          const visibleScopes = () => new Set([sessionId, ...runtime.visibleMissions(actor).map(mission => mission.id)])
          if (after !== undefined) await waitForStateChange(runtime.store, Number(after), visibleScopes, AbortSignal.any([signal, lifetime.signal]), Number(waitMs), wake => {
            const observe = ({ agent }: { agent: { id: string } }) => { if (agent.id === sessionId) wake() }
            const created = ctx.on('agent/created', observe, { global: true })
            const disposed = ctx.on('agent/disposed', observe, { global: true })
            return () => { created(); disposed() }
          })
          signal.throwIfAborted()
          lifetime.signal.throwIfAborted()
          const changes = after === undefined ? undefined : runtime.store.changesSince(Number(after))
          const current = runtime.store.revision()
          let update: LiveUpdate
          if (changes === undefined) {
            update = { kind: 'snapshot', ownerSessionId: sessionId, revision: current, ...stateFor(actor, header) }
          } else {
            const allowed = visibleScopes()
            const changed = new Set(changes.flatMap(change => change.scopes).filter(scope => allowed.has(scope)))
            update = changed.size === 0
              ? { kind: 'heartbeat', ownerSessionId: sessionId, revision: current,
                writable: !runtime.isWorkerSession(sessionId), ownerLive: !runtime.isWorkerSession(sessionId) && ctx.agents.get(sessionId) !== undefined,
                workspace: header.cwd!, defaultBudget: options.defaultBudget }
              : { kind: 'delta', ownerSessionId: sessionId, revision: current, ...stateFor(actor, header, changed) }
          }
          return { ok: true, value: update }
        }
        case 'create-draft':
          return { ok: true, value: { draft: await exposed(async () => runtime.createDraft(actor, await planInput(ctx, body, header, signal))) } }
        case 'update-draft':
          return { ok: true, value: { draft: await exposed(async () => runtime.updateDraft(actor, text(body, 'draftId'), revision(body), await planInput(ctx, body, header, signal))) } }
        case 'discard-draft': {
          const draft = await exposed(() => runtime.discardDraft(actor, text(body, 'draftId'), revision(body)))
          return { ok: true, value: { draft } }
        }
        case 'launch-draft': {
          const draft = runtime.drafts(actor).find(candidate => candidate.id === text(body, 'draftId'))
          if (draft?.status === 'launched') {
            await canonicalWorkspace(draft.input.workspace, header)
            return { ok: true, value: { snapshot: await exposed(() => runtime.launchDraft(actor, draft.id, revision(body))) } }
          }
          if (ctx.agents.get(sessionId) === undefined) throw new RequestError('Open the owner session before launching its workers')
          if (draft !== undefined) await planInput(ctx, { input: draft.input }, header, signal, true)
          return { ok: true, value: { snapshot: await exposed(() => runtime.launchDraft(actor, text(body, 'draftId'), revision(body))) } }
        }
        case 'control': {
          const missionId = text(body, 'missionId')
          const action = text(body, 'action')
          if (!['pause', 'resume', 'stop', 'complete', 'coordinator'].includes(action)) throw new RequestError('Unknown mission control action')
          const coordinatorId = body.coordinatorId === undefined ? undefined : text(body, 'coordinatorId')
          await exposed(() => runtime.control(actor, missionId, action as Parameters<SwarmRuntime['control']>[2], text(body, 'reason'), coordinatorId))
          return { ok: true, value: { snapshot: runtime.snapshot(actor, missionId) } }
        }
        case 'add-member': {
          if (ctx.agents.get(sessionId) === undefined) throw new RequestError('Open the owner session before adding workers')
          const missionId = text(body, 'missionId')
          const input = object(body.input)
          for (const field of ['provider', 'model', 'reasoningEffort']) if (input[field] !== undefined) text(input, field)
          if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || Number(input.maxOutputTokens) < 1)) throw new RequestError('maxOutputTokens must be a positive safe integer')
          // M9(c): a bare string would turn topic matching into substring semantics.
          if (input.subscriptions !== undefined) stringArray(input, 'subscriptions')
          await validateModels(ctx, sessionId, [input as Pick<PlanMember, 'provider' | 'model' | 'reasoningEffort'>], signal, true)
          const member = await exposed(() => runtime.addMember(actor, missionId, input as Parameters<SwarmRuntime['addMember']>[2]))
          return { ok: true, value: { member, snapshot: runtime.snapshot(actor, missionId) } }
        }
        case 'propose': {
          const missionId = text(body, 'missionId')
          const task = await exposed(() => runtime.propose(actor, missionId, object(body.input) as unknown as Parameters<SwarmRuntime['propose']>[2]))
          return { ok: true, value: { task, snapshot: runtime.snapshot(actor, missionId) } }
        }
        default: throw new RequestError(`Unknown swarm endpoint: ${endpoint}`)
      }
    } catch (error) {
      if (signal.aborted || lifetime.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'Swarm request was cancelled', details: {} } }
      if (error instanceof MissingSession) return { ok: false, error: { code: 'session-not-found', message: error.message, details: { sessionId: error.sessionId } } }
      if (error instanceof RequestError) return { ok: false, error: { code: 'bad-request', message: error.message, details: { issues: [] } } }
      // L3: an unexpected failure can carry absolute paths or store schema text.
      // Log the original host-side and return a stable public message.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      try { ctx.logger.warn('agent-swarm: unexpected %s failure: %s', endpoint, detail) } catch { /* Logging must never mask the response. */ }
      return { ok: false, error: { code: 'internal-error', message: 'Swarm request failed unexpectedly; the original error was logged on the host.', details: { issues: [] } } }
    }
  }
  ctx.connection.rpc.handle('/agent-swarm', handler)
}
