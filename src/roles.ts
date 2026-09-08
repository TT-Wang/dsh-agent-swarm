/** Per-session presentation of swarm tools and prompt by role; runtime authority checks are unchanged. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ENTRY_PROMPT, hiddenToolsFor, OWNER_PROMPT, type SwarmRole } from './tools.ts'
import type { SwarmRuntime } from './runtime.ts'

interface Applied { role: SwarmRole; dispose: () => void }

/**
 * Ordinary sessions see how a swarm starts and the entry tools; a session that
 * owns an automatic request or mission sees the owner protocol and management
 * tools; subagent sessions see no swarm tools. Workers are scoped by their
 * adapter and skipped here. Roles are re-evaluated on every runtime commit so
 * a session is promoted before its planning turn assembles.
 */
export class RoleScoper {
  private readonly applied = new Map<string, Applied>()
  private readonly disposers: Array<() => void> = []
  private disposed = false

  constructor(private readonly ctx: Context, private readonly runtime: SwarmRuntime) {
    for (const agent of ctx.agents.list()) this.apply(agent)
    this.disposers.push(ctx.on('agent/created', ({ agent }) => { this.apply(agent) }))
    this.disposers.push(ctx.on('agent/disposed', ({ agent }) => { this.forget(String(agent.id)) }))
    this.disposers.push(runtime.subscribe(() => { this.refresh() }))
    ctx.effect(() => () => this.dispose(), 'swarm.roles')
  }

  roleOf(agent: Agent): SwarmRole {
    const sessionId = String(agent.id)
    if (this.runtime.isWorkerSession(sessionId)) return 'worker'
    if (agent.session.header.origin === 'subagent') return 'none'
    return this.runtime.starts({ sessionId }).length > 0 || this.runtime.list(sessionId).length > 0 ? 'owner' : 'entry'
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
      undo.push(agent.ctx.systemPrompt.section({ name: 'swarm:usage', order: 119, text: role === 'owner' ? OWNER_PROMPT : role === 'none' ? '' : ENTRY_PROMPT }))
      this.applied.set(sessionId, { role, dispose: () => { for (const fn of undo.splice(0)) { try { fn() } catch { /* the agent scope may already be gone */ } } } })
    } catch (error) {
      for (const fn of undo.splice(0)) { try { fn() } catch { /* best effort */ } }
      this.ctx.logger.warn(`Swarm role presentation for ${sessionId} was not applied: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private forget(sessionId: string): void {
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
  }
}
