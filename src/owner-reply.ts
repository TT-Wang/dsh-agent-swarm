import type { Context } from '@deepseek-ai/cordis'
import type { SwarmRuntime } from './runtime.ts'
import type { Delivery, Mission } from './types.ts'
import { emitGuardTerminal } from './refusals.ts'

/**
 * L2: the owner-side half of the reply protocol.
 *
 * A question delivered to the owner is a receipt (L0/L1). The worker side already
 * has a silence protocol — a quiet attempt is nudged, checkpointed and finally
 * abandoned with an event. The owner side had nothing: the question reached the
 * conversation, the owner answered in prose, and the asker never heard anything,
 * because the owner's chat text is not part of this store and cannot be
 * reconciled with the delivery.
 *
 * This guard closes that gap where it can actually be observed: at the end of an
 * owner turn. Questions that were delivered before the turn started, are still
 * open when it ends, and were not settled by any tool call during it leave a
 * durable `owner/reply-missing` event and a bounded instruction naming the exact
 * call. When the bound is spent, the existing guard-terminal vocabulary reports
 * the decision instead of nudging forever.
 *
 * The guard never edits the owner's answer and never sends on its behalf: it
 * makes the missing receipt visible and executable, which is the invariant the
 * board already keeps for task state.
 */
export interface OwnerReplyOptions {
  /**
   * `nudge` (default) records the miss and instructs; `block` additionally
   * refuses the owner's next step while the receipt stays open.
   */
  guard: 'nudge' | 'block'
  /** Nudges spent on one question before the guard terminal; default 2. */
  maxNudges: number
}

/** One question booked at turn start, with everything the nudge must name. */
interface Booking {
  missionId: string
  from: string
  taskId?: string
  content: string
  deliveredAt: number
}

/** The nudge body: the question, the exact call, and the rule the owner must know. */
export function ownerReplyNudge(missionId: string, delivery: Delivery, booking: Booking, attempt: number, limit: number): string {
  return [
    `[owner_reply_missing] ${booking.from} asked a question that this turn did not answer (nudge ${attempt} of ${limit}).`,
    '',
    `Question: ${booking.content.replace(/\s+/g, ' ').slice(0, 400)}`,
    '',
    `Answer it with: swarm_message({ missionId: "${missionId}", to: "${booking.from}", kind: "question", content: "<your answer>", replyTo: "${delivery.id}" })`,
    `Or close it deliberately: swarm_message({ missionId: "${missionId}", to: "${booking.from}", kind: "question", content: "<why not>", replyTo: "${delivery.id}", dismiss: true })`,
    'Your reply in the conversation is not delivered to the member: only that call writes the receipt.',
  ].join('\n')
}

export class OwnerReplyGuard {
  private readonly bookings = new Map<string, Map<string, Booking>>()
  private readonly blocking = new Map<string, Set<string>>()
  private readonly attached = new Set<string>()
  private readonly removals: Array<() => void> = []
  private closed = false

  constructor(private readonly ctx: Context, private readonly rt: SwarmRuntime, private readonly options: OwnerReplyOptions) {
    this.removals.push(ctx.on('session/event', (session, event) => {
      if (this.closed) return
      try { this.observe(String(session.header.id), event.type, event.data) }
      catch { /* An observer must never break a turn; the next turn re-derives the miss. */ }
    }))
  }

  dispose(): void {
    this.closed = true
    for (const remove of this.removals.splice(0)) remove()
    this.bookings.clear()
    this.blocking.clear()
  }

  /**
   * Drive the guard from one session event. Public on purpose: the cordis
   * listener above is the only production caller, and a test (or a host that
   * carries session events another way) can feed the same two events directly.
   */
  observe(sessionId: string, type: string, data?: unknown): void {
    if (this.closed) return
    if (type === 'user/message') this.startTurn(sessionId, data)
    else if (type === 'turn/end') this.endTurn(sessionId)
  }

  /** Owner missions that are still live for this session. */
  private ownerMissions(sessionId: string): Mission[] {
    return this.rt.store.list('missions').filter(mission => mission.ownerSessionId === sessionId && !this.rt.isMissionTerminal(mission))
  }

  /**
   * Book the questions this turn is expected to settle: delivered before it
   * started and still open. A turn with no such question books nothing, so an
   * ordinary owner turn is never nudged.
   */
  private startTurn(sessionId: string, data?: unknown): void {
    const at = typeof (data as { createdAt?: unknown } | undefined)?.createdAt === 'number' ? (data as { createdAt: number }).createdAt : Date.now()
    const booked = new Map<string, Booking>()
    for (const mission of this.ownerMissions(sessionId)) {
      for (const delivery of this.rt.openAsks(mission.id, 'owner')) {
        if (delivery.deliveredAt === undefined || delivery.deliveredAt > at) continue
        booked.set(delivery.id, {
          missionId: mission.id, from: delivery.from, content: delivery.content, deliveredAt: delivery.deliveredAt,
          ...(delivery.taskId === undefined ? {} : { taskId: delivery.taskId }),
        })
      }
    }
    if (booked.size === 0) this.bookings.delete(sessionId)
    else this.bookings.set(sessionId, booked)
  }

  private endTurn(sessionId: string): void {
    const booked = this.bookings.get(sessionId)
    this.bookings.delete(sessionId)
    if (booked === undefined) return
    for (const [deliveryId, booking] of booked) {
      const current = this.rt.store.get('deliveries', deliveryId)
      // Settled during the turn (answered or dismissed), or gone: nothing to report.
      if (current === undefined || current.answeredBy !== undefined) continue
      this.missing(sessionId, deliveryId, current, booking)
    }
  }

  /**
   * Record the miss, nudge within the bound, and escalate once the bound is
   * spent. Every step is durable, so a restart resumes at the same nudge count
   * instead of starting the count over.
   */
  private missing(sessionId: string, deliveryId: string, delivery: Delivery, booking: Booking): void {
    const mission = this.rt.store.get('missions', booking.missionId)
    if (mission === undefined || this.rt.isMissionTerminal(mission)) return
    const spent = delivery.replyNudges ?? 0
    // The durable miss record is bounded with the nudges: after the bound the
    // guard terminal is the outcome, so a later turn cannot keep writing rows
    // about a decision the owner has already been handed.
    if (spent < this.options.maxNudges) {
      this.rt.commit(booking.missionId, () => this.rt.store.event(booking.missionId, 'owner/reply-missing', 'runtime', {
        deliveryId, memberId: booking.from, taskId: booking.taskId ?? null,
        deliveredAt: booking.deliveredAt, nudges: spent, question: booking.content.replace(/\s+/g, ' ').slice(0, 200),
      }))
    }
    if (spent >= this.options.maxNudges) {
      // Idempotent by its own dedup key: the terminal is emitted once and later
      // turns re-derive the same decision without a second notice.
      emitGuardTerminal(this.rt, booking.missionId, 'owner_reply', {
        detail: `question ${deliveryId} from ${booking.from} still has no answer after ${spent} nudge(s)`,
        memberId: booking.from,
        ...(booking.taskId === undefined ? {} : { taskId: booking.taskId }),
      })
      return
    }
    delivery.replyNudges = spent + 1
    this.rt.commit(booking.missionId, () => this.rt.store.put('deliveries', delivery))
    try {
      this.rt.notify(booking.missionId, ownerReplyNudge(booking.missionId, delivery, booking, spent + 1, this.options.maxNudges),
        this.rt.noticeSubjectsFor(booking.missionId, { ...(booking.taskId === undefined ? {} : { taskId: booking.taskId }), memberId: booking.from }),
        { dedupe: true, dedupKey: `owner-reply-missing:${deliveryId}` })
    } catch { /* A notice that cannot be queued must not lose the durable event above. */ }
    if (this.options.guard === 'block') this.block(sessionId, deliveryId)
  }

  /**
   * Hard mode: hold the next step of the owner's session until the receipt is
   * settled. Attached lazily to the owner agent, because the owner is an
   * ordinary conversation the plugin does not create; a host that cannot supply
   * the agent keeps the nudge and loses nothing durable.
   */
  private block(sessionId: string, deliveryId: string): void {
    const tracked = this.blocking.get(sessionId) ?? new Set<string>()
    tracked.add(deliveryId)
    this.blocking.set(sessionId, tracked)
    if (this.attached.has(sessionId)) return
    const agent = this.ctx.agents.get(sessionId as never)
    const agentCtx = (agent as { ctx?: Context } | undefined)?.ctx
    if (agent === undefined || agentCtx === undefined) return
    this.attached.add(sessionId)
    agentCtx.on('agent/pre-step', async (_payload, next) => {
      const open = await next()
      if (open.kind === 'reject') return open
      for (const id of [...(this.blocking.get(sessionId) ?? [])]) {
        const delivery = this.rt.store.get('deliveries', id)
        if (delivery === undefined || delivery.answeredBy !== undefined) { this.blocking.get(sessionId)?.delete(id); continue }
        if ((delivery.replyNudges ?? 0) > this.options.maxNudges) { this.blocking.get(sessionId)?.delete(id); continue }
        const booking = { missionId: delivery.missionId, from: delivery.from, content: delivery.content, deliveredAt: delivery.deliveredAt ?? Date.now(), ...(delivery.taskId === undefined ? {} : { taskId: delivery.taskId }) }
        this.rt.notify(delivery.missionId, ownerReplyNudge(delivery.missionId, delivery, booking, (delivery.replyNudges ?? 0), this.options.maxNudges),
          this.rt.noticeSubjectsFor(delivery.missionId, { memberId: delivery.from }), { dedupe: true, dedupKey: `owner-reply-blocked:${id}` })
        return { kind: 'reject' }
      }
      return open
    })
  }
}
