/** Optional native browser RPC consumers of the durable swarm runtime. */
import type { Context } from '@deepseek-ai/cordis'
import { RpcId } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcHandler, ConnectionRpcResult, ServerResponse } from '@deepseek-ai/dsh-client-connection'
import { isAppendSurfaceEvent, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-llm'
import { authorizeWorkspace, reauthorizeWorkspace, type WorkspaceAuthorization, type WorkspaceGrantSnapshot } from './authorization.ts'
import type { SwarmRuntime } from './runtime.ts'
import { validatePlan } from './plans.ts'
import { ownerModelSelection, workerModelSelection } from './model-selection.js'
import { persistedSessionHeader } from './session-metadata.js'
import { SWARM_RPC_CHANNEL, SWARM_RPC_PREFIX, SWARM_WEB_ENDPOINTS } from './types.ts'
import type { Actor, Budget, Mission, PlanInput, PlanMember } from './types.ts'
import type { LiveState, LiveUpdate } from './live-types.ts'
import { waitForStateChange } from './watch.ts'

/** Payload bound is additional to the native Connection carrier's HTTP limit. */
export interface WebApiOptions {
  defaultBudget: Budget
  maxPayloadBytes: number
  /**
   * The human-authorized roots loaded once at plugin start. The browser path
   * enforces the same containment check as the model tool path; absent in unit
   * fixtures, where the session cwd alone remains the authorization.
   */
  grants?: WorkspaceGrantSnapshot
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
 * Authored policy/validation refusals the browser may see. Every other
 * collaborator failure is unexpected: the host logs its full detail and the
 * browser receives a stable `internal-error` message, so absolute paths,
 * SQLite text and internal route codes never leave the process
 * (SURFACE-R3-01 / F-08). Unknown messages fail closed (sanitized); a new
 * owner-actionable runtime refusal must be added here to become visible.
 */
const actionableMessages: readonly RegExp[] = [
  // Plan admission and scope diagnostics.
  /^Plan entries must be objects$/,
  /^Plan exceeds (?:1 MiB|task\/workstream budget|experiment budget)$/,
  /^(?:Title|Objective|Workspace|Mission scope|Mission acceptance) must be nonempty text of at most 16000 characters$/,
  /^Workspace must be absolute$/,
  /^Invalid budget (?:maxTokens|maxSteps|maxWorkers|maxDurationMs|maxTasks|maxExperiments)$/,
  /^Roster exceeds worker budget$/,
  /^members\[/,
  /^workstreams\[/,
  /^tasks\[/,
  /^scope\[/,
  /^scope exceeds mission scope:/,
  // Runtime authority, lifecycle and budget refusals.
  /^Unknown (?:mission|workstream|assignee|coordinator|task kind|model provider)$/,
  /^Session is not a participant in this mission$/,
  /^Only (?:the mission owner|the user session|members|independent verification)/,
  /^Mission is (?:active|paused|blocked|stopped|completed|staged)$/,
  /^Mission is waiting for budget-pause quiescence and a fresh resume assignment$/,
  /^Mission is (?:inactive or out of budget|terminal; create a new mission to continue|terminal; its budget cannot be changed)$/,
  /^Mission (?:duration|worker|task|experiment) budget exhausted$/,
  /^Mission budget exhausted; it cannot be resumed with a fresh allowance$/,
  /^Mission (?:already exists|duration exceeds the supported clock range)$/,
  /^Member admission identity conflict$/,
  /^Workstream (?:identity conflict|admission budget exhausted)$/,
  /^Worker (?:name already exists|already owns an open task|membership is inactive)$/,
  /^Workers cannot create independent missions or budgets$/,
  /^Swarm runtime is (?:closed|shutting down)$/,
  /^Draft is not owned by this session$/,
  /^Draft changed; reload before (?:saving|discarding|launching)$/,
  /^Draft admission identity already exists$/,
  /^Draft cannot be launched in its current state$/,
  /^Discard unused drafts before creating more$/,
  /^Only unlaunched drafts can be edited/,
  /^A launching or launched plan cannot be discarded/,
  /^The partially assembled mission cannot be launched$/,
  /^Plan assembly was interrupted$/,
  /^Task (?:is not in this mission|is not ready for this member|changed while preparing its workspace|has no active attempt|identity conflict)$/,
  /^Task .* is accepted; accepted work is immutable/,
  /^A task prerequisite is no longer accepted/,
  /^Stale or unauthorized task attempt/,
  /^Attempt lease exceeds the supported clock range$/,
  /^Content exceeds \d+ characters$/,
  /^A prerequisite was invalidated/,
  /^Automatic (?:workers require maxOutputTokens|tasks require a recovery limit|task checks require a timeout) chosen by the primary agent$/,
  /^Verification (?:requires reviewOf|cannot review another verification task)$/,
  /^Only verification tasks may set reviewOf$/,
  /^(?:reviewOf|replaces|Dependency|assigneeId) /,
  /^priority must be an integer from 0 to 100$/,
  /^(?:maxRecoveryAttempts|maxOutputTokens) must be a positive safe integer$/,
  /^checkTimeoutMs must be a positive integer within the platform timer range$/,
  /^subscriptions must be a string array$/,
  /^workspace must be an absolute path$/,
  /^A selected provider requires a selected model$/,
  /^Choose an explicit provider and model/,
  // T2 W8/F7 refusals (messages confirmed byte-for-byte with the governance task).
  /^Member .+ cannot start: provider .+ does not support reasoning effort/,
  /^Task .+ was cancelled by the owner; a cancelled record cannot be re-admitted/,
  /^(?:maxTokens|maxSteps|maxWorkers|maxTasks|maxExperiments) cannot be below existing consumption or admitted work/,
  /^An active mission needs a duration deadline in the future$/,
  /^Use the saved plan (?:launch action to activate staged work|to set the budget before launch)$/,
  // Completion and delivery preconditions.
  /^Mission still has unfinished or blocked required work/,
  /^Accepted tasks do not cover every mission acceptance criterion:/,
  /^Coding missions require an independently accepted integration artifact/,
  /^Unresolved evidence challenges prevent completion:/,
  /^Complete independent acceptance before applying results$/,
  /^This historical mission has no saved delivery baseline/,
  /^This worker adapter does not support /,
]
/** Host-derived detail must never travel through the actionable allowlist. */
const unsafeDetail = /(?:\bSQLITE\b|\/Users\/|\/private\/|\/var\/|\/tmp\/|\/home\/|\/etc\/|\/opt\/|\/usr\/|\0)/i
function actionableMessage(message: string): boolean {
  if (message.length === 0 || message.length > 4000 || unsafeDetail.test(message)) return false
  return actionableMessages.some(pattern => pattern.test(message))
}
class InternalFailure extends Error {
  constructor(readonly cause: unknown) { super('Swarm request failed unexpectedly') }
}
/**
 * Run a collaborator operation and decide what the browser may see. `true`
 * marks an operation whose every failure is authored validation text;
 * a predicate marks operations that can also fail internally.
 */
async function exposed<T>(operation: () => Promise<T> | T, userActionable: boolean | ((message: string) => boolean) = false): Promise<T> {
  try { return await operation() } catch (error) {
    if (error instanceof MissingSession || error instanceof RequestError) throw error
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    if (message !== '' && (userActionable === true || (typeof userActionable === 'function' && userActionable(message)))) throw new RequestError(message)
    throw new InternalFailure(error)
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

async function planInput(ctx: Context, body: Record<string, unknown>, header: SessionHeader, signal: AbortSignal, grants: WorkspaceGrantSnapshot, launching = false): Promise<PlanInput> {
  const input = object(body.input)
  const authorization = await canonicalWorkspace(text(input, 'workspace'), header, grants)
  if (!authorization.ok) throw new RequestError(authorization.diagnostic)
  // The host-derived root always overrides any client-supplied value, so a
  // browser payload cannot widen its own authorization anchor.
  const plan = await exposed(() => validatePlan({ ...input, workspace: authorization.workspace, workspaceGrantRoot: authorization.grantRoot, workspaceAuthorizationSource: authorization.source }), true)
  await validateModels(ctx, header.id, plan.members, signal, launching)
  return plan
}

/**
 * The browser admission boundary, identical to the model tool boundary: the
 * workspace must be the calling session's cwd or resolve inside a configured
 * authorized root. The refusal is a field-level diagnostic naming the
 * authorization requirement, never a bare cwd-equality error.
 */
async function canonicalWorkspace(input: string, header: SessionHeader, grants: WorkspaceGrantSnapshot): Promise<WorkspaceAuthorization> {
  return await authorizeWorkspace(input, header.cwd, grants)
}

/** Re-validate a mission already recorded against its own durable grant root. */
async function missionWorkspace(mission: Pick<Mission, 'workspace' | 'workspaceGrantRoot' | 'workspaceAuthorizationSource'>, grants: WorkspaceGrantSnapshot): Promise<string> {
  // A mission recorded before this feature has no anchor; its workspace is its
  // own anchor, matching the pre-feature session-cwd authorization.
  const authorization = await reauthorizeWorkspace(mission.workspace, mission.workspaceGrantRoot ?? mission.workspace, grants, mission.workspaceAuthorizationSource)
  if (!authorization.ok) throw new RequestError(authorization.diagnostic)
  return authorization.workspace
}

async function validateModels(ctx: Context, ownerId: SessionId, members: Pick<PlanMember, 'provider' | 'model' | 'reasoningEffort'>[], signal: AbortSignal, launching: boolean): Promise<void> {
  const owner = ctx.agents.get(ownerId)
  const defaults = owner === undefined ? undefined : await ownerModelSelection(ctx, owner, signal)
  const providers = new Set(ctx.llm.listProviders().map(provider => provider.id))
  for (const member of members) {
    signal.throwIfAborted()
    if (!launching && member.provider === undefined && member.model === undefined && member.reasoningEffort === undefined) continue
    const selected = await exposed(() => workerModelSelection(defaults, member), true)
    if (!providers.has(selected.provider)) throw new RequestError(`Unknown model provider: ${selected.provider}`)
    // Exact route resolution is authoritative. A provider may route models not
    // present in its advisory picker catalog; those remain valid selections.
    // A resolution failure is reported as a stable selection error: the
    // adapter's own message can carry host paths or internal route codes
    // (SURFACE-R3-01), so it is logged host-side and never echoed.
    try { await ctx.llm.resolveCallConfig(selected, signal) } catch (error) {
      if (signal.aborted) throw error
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      try { ctx.logger.warn('agent-swarm: model route %s/%s failed to resolve: %s', selected.provider, selected.model, detail) } catch { /* Logging must never mask the response. */ }
      throw new RequestError(`Model route is unavailable: ${selected.provider}/${selected.model}`)
    }
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
  const grants: WorkspaceGrantSnapshot = options.grants ?? { grants: [], loadedAt: Date.now(), unresolved: [] }
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
          await missionWorkspace(mission, grants)
          if (endpoint === 'delivery') return { ok: true, value: { delivery: await exposed(() => runtime.inspectDelivery(actor, missionId), actionableMessage) } }
          return { ok: true, value: { result: await exposed(() => runtime.applyDelivery(actor, missionId), actionableMessage), snapshot: runtime.snapshot(actor, missionId) } }
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
          return { ok: true, value: { draft: await exposed(async () => runtime.createDraft(actor, await planInput(ctx, body, header, signal, grants)), actionableMessage) } }
        case 'update-draft':
          return { ok: true, value: { draft: await exposed(async () => runtime.updateDraft(actor, text(body, 'draftId'), revision(body), await planInput(ctx, body, header, signal, grants)), actionableMessage) } }
        case 'discard-draft': {
          const draft = await exposed(() => runtime.discardDraft(actor, text(body, 'draftId'), revision(body)), actionableMessage)
          return { ok: true, value: { draft } }
        }
        case 'launch-draft': {
          const draft = runtime.drafts(actor).find(candidate => candidate.id === text(body, 'draftId'))
          if (draft?.status === 'launched') {
            const mission = draft.missionId === undefined ? undefined : runtime.store.get('missions', draft.missionId)
            if (mission !== undefined) await missionWorkspace(mission, grants)
            else await canonicalWorkspace(draft.input.workspace, header, grants)
            return { ok: true, value: { snapshot: await exposed(() => runtime.launchDraft(actor, draft.id, revision(body)), actionableMessage) } }
          }
          if (ctx.agents.get(sessionId) === undefined) throw new RequestError('Open the owner session before launching its workers')
          if (draft !== undefined) await planInput(ctx, { input: draft.input }, header, signal, grants, true)
          return { ok: true, value: { snapshot: await exposed(() => runtime.launchDraft(actor, text(body, 'draftId'), revision(body)), actionableMessage) } }
        }
        case 'control': {
          const missionId = text(body, 'missionId')
          const action = text(body, 'action')
          if (!['pause', 'resume', 'stop', 'complete', 'coordinator'].includes(action)) throw new RequestError('Unknown mission control action')
          const coordinatorId = body.coordinatorId === undefined ? undefined : text(body, 'coordinatorId')
          await exposed(() => runtime.control(actor, missionId, action as Parameters<SwarmRuntime['control']>[2], text(body, 'reason'), coordinatorId), actionableMessage)
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
          const member = await exposed(() => runtime.addMember(actor, missionId, input as Parameters<SwarmRuntime['addMember']>[2]), actionableMessage)
          return { ok: true, value: { member, snapshot: runtime.snapshot(actor, missionId) } }
        }
        case 'propose': {
          const missionId = text(body, 'missionId')
          const task = await exposed(() => runtime.propose(actor, missionId, object(body.input) as unknown as Parameters<SwarmRuntime['propose']>[2]), actionableMessage)
          return { ok: true, value: { task, snapshot: runtime.snapshot(actor, missionId) } }
        }
        case 'cancel': {
          // F-35: the owner can withdraw a single admitted task from the panel.
          const missionId = text(body, 'missionId')
          const taskId = text(body, 'taskId')
          const reason = text(body, 'reason')
          const task = await exposed(() => runtime.cancel(actor, missionId, { taskId, reason }), actionableMessage)
          return { ok: true, value: { task, snapshot: runtime.snapshot(actor, missionId) } }
        }
        default: throw new RequestError(`Unknown swarm endpoint: ${endpoint}`)
      }
    } catch (error) {
      if (signal.aborted || lifetime.signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'Swarm request was cancelled', details: {} } }
      if (error instanceof MissingSession) return { ok: false, error: { code: 'session-not-found', message: error.message, details: { sessionId: error.sessionId } } }
      if (error instanceof RequestError) return { ok: false, error: { code: 'bad-request', message: error.message, details: { issues: [] } } }
      // L3: an unexpected failure can carry absolute paths, store schema text or
      // internal route codes. Log the original host-side and return a stable
      // public message; only authored policy text passes the allowlist above.
      const original = error instanceof InternalFailure ? error.cause : error
      const detail = original instanceof Error ? `${original.name}: ${original.message}` : String(original)
      try { ctx.logger.warn('agent-swarm: unexpected %s failure: %s', endpoint, detail) } catch { /* Logging must never mask the response. */ }
      return { ok: false, error: { code: 'internal-error', message: 'Swarm request failed unexpectedly; the original error was logged on the host.', details: { issues: [] } } }
    }
  }
  // Three host generations, one route shape. A plugin-owned channel
  // (`rpc.handle('/agent-swarm', …)`) is unusable from 0.1.5: the connection
  // service resolves `webServer` on a context that injects `credentials` alone,
  // and Cordis refuses that property access, so the route is never registered.
  // The shared `/api` interceptor is not an option either — that channel admits
  // exactly one interceptor and another plugin holds it. What is left is what the
  // host itself documents for plugin endpoints: one exact route per endpoint on
  // the shared channel, consulted before the interceptor, inheriting its Host,
  // Origin and browser-authentication fence. The client posts the standard
  // envelope to `/api/agent-swarm/<endpoint>`.
  const releases: Array<() => Promise<void>> = []
  ctx.effect(() => () => { for (const release of releases.splice(0)) void release() }, 'agent-swarm: web routes')
  const reply = (rpcId: string, result: ConnectionRpcResult<unknown>): Response => new Response(
    JSON.stringify({ type: 'server-response', rpcId: RpcId(rpcId), result } satisfies ServerResponse),
    { status: 200, headers: { 'content-type': 'application/json' } })
  for (const endpoint of SWARM_WEB_ENDPOINTS) {
    const method = `${SWARM_RPC_PREFIX}${endpoint}`
    releases.push(ctx.connection.fetch.register({
      path: `${SWARM_RPC_CHANNEL}/${method}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        // The framing rules mirror the host's own channel handler, so a browser
        // sees the same statuses whether an endpoint is served by a channel or by
        // one of these routes: 415 for a non-JSON media type, 400 for a body that
        // is not JSON, and a `gateway/bad-request` envelope for anything else.
        const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
        if (mediaType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
        let body: unknown
        try { body = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
        const envelope = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined
        const rpcId = typeof envelope?.rpcId === 'string' ? RpcId(envelope.rpcId) : RpcId('invalid-request')
        if (envelope?.type !== 'client-request' || typeof envelope.method !== 'string') {
          return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } } })
        }
        if (envelope.method !== method) {
          return reply(rpcId, { ok: false, error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}`, details: { issues: [] } } })
        }
        return reply(rpcId, await handler(endpoint, envelope.payload, request.signal))
      },
    }))
  }
}
