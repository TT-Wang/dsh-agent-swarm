/** Per-session presentation of swarm tools and prompt by role; runtime authority checks are unchanged. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ENTRY_PROMPT, HISTORICAL_OWNER_PROMPT, hiddenToolsFor, OWNER_PROMPT, type SwarmRole } from './tools.ts'
import type { SwarmRuntime } from './runtime.ts'

interface Applied { role: SwarmRole; dispose: () => void }
/** Presentation history only: a completed turn does not settle task or notice obligations. */
interface Handling { admitted: Set<string>; pending: Set<string>; handled: Set<string> }
const recoveryKey = (requestId: string, epoch = 1): string => `start:${requestId}:${epoch}:failure`

/**
 * Ordinary sessions see how a swarm starts and the entry tools; a session that
 * owns live work sees the owner protocol and management tools. Historical
 * owners retain those tools with a short prompt once their final notifications
 * and questions are handled. Workers are scoped by their adapter and skipped.
 * Runtime commits promote a session before its planning turn assembles.
 */
export class RoleScoper {
  private readonly applied = new Map<string, Applied>()
  private readonly handling = new Map<string, Handling>()
  private readonly disposers: Array<() => void> = []
  private disposed = false

  constructor(private readonly ctx: Context, private readonly runtime: SwarmRuntime) {
    for (const agent of ctx.agents.list()) this.track(agent)
    this.disposers.push(ctx.on('agent/created', ({ agent }) => { this.track(agent) }))
    this.disposers.push(ctx.on('agent/disposed', ({ agent }) => { this.forget(String(agent.id)) }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') this.apply(agent) }))
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const handling = this.handling.get(String(session.header.id))
      if (handling !== undefined) this.observeHandling(handling, event)
    }))
    this.disposers.push(runtime.subscribe(() => { this.refresh() }))
    ctx.effect(() => () => this.dispose(), 'swarm.roles')
  }

  roleOf(agent: Agent): SwarmRole {
    const sessionId = String(agent.id)
    if (this.runtime.isWorkerSession(sessionId)) return 'worker'
    if (agent.session.header.origin === 'subagent') return 'none'
    const starts = this.runtime.starts({ sessionId })
    const missions = this.runtime.list(sessionId)
    if (starts.length === 0 && missions.length === 0) return 'entry'
    if (starts.some(start => ['planning', 'launching', 'running'].includes(start.status))
      || missions.some(mission => !this.runtime.isMissionTerminal(mission))) return 'owner'
    const handling = this.handling.get(sessionId)
    const handled = handling?.handled
    if (starts.some(start => start.status === 'failed' && (start.recoveryNoticePending
      || (handling?.admitted.has(recoveryKey(start.id, start.planningEpoch)) && !handled?.has(recoveryKey(start.id, start.planningEpoch)))))) return 'owner'
    if (missions.some(mission => (mission.status !== 'stopped' && this.runtime.openAsks(mission.id, 'owner').length > 0)
      // Completed missions still deliver queued notices, including legacy
      // completion rows classified as decisions. Stopped missions mute them.
      || (mission.status === 'completed' && this.runtime.store.list('deliveries', mission.id)
        .some(delivery => delivery.to === 'owner' && delivery.notice !== undefined && !handled?.has(delivery.id))))) return 'owner'
    // Claiming a notice happens before prompt assembly. Do not shorten the
    // protocol midway through the turn that closes the last obligation.
    if (agent.status !== 'idle' && this.applied.get(sessionId)?.role === 'owner') return 'owner'
    return 'historical-owner'
  }

  private track(agent: Agent): void {
    const handling: Handling = { admitted: new Set(), pending: new Set(), handled: new Set() }
    for (const event of agent.session.snapshotEvents()) this.observeHandling(handling, event)
    this.handling.set(String(agent.id), handling)
    this.apply(agent)
  }

  /** Intake is not completion: interrupted turns retain their obligation on reload. */
  private observeHandling(handling: Handling, event: SessionEvent): void {
    // Admission is acknowledged before the next model step. Retain the recovery
    // protocol while that message is queued, including after a host reload.
    if (event.type === 'agent/inbox/spliced') for (const message of event.data.inserted) {
      if (message.source.kind === 'swarm-start' && message.source.phase === 'failure') handling.admitted.add(recoveryKey(message.source.requestId, message.source.planningEpoch))
    }
    if (event.type === 'user/message' && event.data.source?.kind === 'swarm') handling.pending.add(event.data.source.deliveryId)
    if (event.type === 'user/message' && event.data.source?.kind === 'swarm-start' && event.data.source.phase === 'failure') {
      const key = recoveryKey(event.data.source.requestId, event.data.source.planningEpoch)
      handling.admitted.add(key)
      handling.pending.add(key)
    }
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'completed') return
    for (const id of handling.pending) handling.handled.add(id)
    handling.pending.clear()
  }

  /** Re-evaluate every tracked session; only changed roles re-register (stable prompt prefix otherwise). */
  refresh(): void {
    if (this.disposed) return
    for (const agent of this.ctx.agents.list()) this.apply(agent)
  }

  private apply(agent: Agent): void {
    if (this.disposed) return
    const sessionId = String(agent.id)
    const role = this.roleOf(agent)
    if (role === 'worker') { this.forget(sessionId); return }
    const current = this.applied.get(sessionId)
    if (current?.role === role) return
    current?.dispose()
    this.applied.delete(sessionId)
    const undo: Array<() => void> = []
    try {
      // A throwing agent/created listener would veto the agent itself; presentation must never do that.
      const visible = new Set(agent.ctx.tools.schemas(agent).map(schema => schema.name))
      const hidden = hiddenToolsFor(role).filter(name => visible.has(name))
      if (hidden.length) undo.push(agent.ctx.tools.restrict({ deny: hidden }))
      undo.push(agent.ctx.systemPrompt.section({ name: 'swarm:usage', order: 119, text: role === 'owner' ? OWNER_PROMPT : role === 'historical-owner' ? HISTORICAL_OWNER_PROMPT : role === 'none' ? '' : ENTRY_PROMPT }))
      this.applied.set(sessionId, { role, dispose: () => { for (const fn of undo.splice(0)) { try { fn() } catch { /* the agent scope may already be gone */ } } } })
    } catch (error) {
      for (const fn of undo.splice(0)) { try { fn() } catch { /* best effort */ } }
      this.ctx.logger.warn(`Swarm role presentation for ${sessionId} was not applied: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private forget(sessionId: string): void {
    this.handling.delete(sessionId)
    const current = this.applied.get(sessionId)
    if (current === undefined) return
    this.applied.delete(sessionId)
    current.dispose()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const fn of this.disposers.splice(0)) { try { fn() } catch { /* already unregistered */ } }
    for (const sessionId of [...this.applied.keys()]) this.forget(sessionId)
    this.handling.clear()
  }
}
