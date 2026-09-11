/**
 * R17-G9: the pre-append invariant pilot — an owner-facing decision that names a
 * subject whose lineage still has a live path cannot be written.
 *
 * WHAT IS ADOPTED, NOT RE-INVENTED. The host registers package-owned invariant
 * companions through `@deepseek-ai/dsh-invariants` (`ctx.invariants.register`),
 * and the `internal/dispatch` hook runs an installer's check BEFORE the event is
 * published, so a throwing `fail()` vetoes the append (measured semantics: the
 * `session/event` listeners never see the refused event). Twelve host packages
 * register one; this module is the swarm's. The companion is installed through
 * the cordis registry in `src/index.ts` (`ctx.inject(['invariants'], …)`), so a
 * deployment that does not mount the registry keeps working and the missing
 * capability is named rather than assumed — `swarmInvariantStatus.registered`
 * records which of the two happened.
 *
 * WHAT IT REFUSES. A `session/event` candidate that relays a swarm message
 * (`source.kind === 'swarm'`) carrying an owner delivery whose family claims "no
 * live path will advance this subject" (`stall-root`, `fallthrough`) while any
 * subject it names still has a live path. The judgement is the SAME predicate the
 * emission site uses and the same rule `Notices.wakePrecision` counts after the
 * fact (`liveLineageSubject`, src/notices.ts): the false-wake condition, judged
 * before the write instead of after it. `src/index.ts` supplies the mapping from a
 * relayed message to that predicate, so this module knows nothing about the store.
 *
 * REFUSALS ARE A MEASUREMENT. Every refusal is recorded in {@link decisionRefusals}
 * with its stage (`emission`: refused before anything durable was written;
 * `append`: the host refused the session append before publication), so the round
 * can report a count instead of a silent no-op. The adapter acknowledges an
 * append-refused delivery (src/harness-workers.ts) so the durable outbox cannot
 * retry a decision the invariant will refuse again.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DecisionRefusal } from './types.ts'

/** Full package name the companion reserves in the host invariant registry. */
export const SWARM_INVARIANT_PACKAGE = '@dsh-external/dsh-agent-swarm'
/** Cordis companion plugin name, matching the host companions' convention. */
export const name = 'swarm-invariant'
/** The host service the companion requires before it can reserve package ownership. */
export const inject = ['invariants']

/**
 * Whether the companion is registered with the host registry right now. Stays
 * `false` when the deployment does not mount `@deepseek-ai/dsh-invariants`; the
 * round reports the pilot as not landed in that case rather than claiming it.
 */
export const swarmInvariantStatus: { registered: boolean; packageName: string } = {
  registered: false, packageName: SWARM_INVARIANT_PACKAGE,
}

/** The durable refusal log: the count the round reports, oldest first. */
export class DecisionRefusalLog {
  private readonly entries: DecisionRefusal[] = []
  /** Record one refused candidate (never throws; a refusal is a measurement). */
  record(refusal: DecisionRefusal): void { this.entries.push(refusal) }
  /** Every refusal recorded in this process, oldest first. */
  list(): readonly DecisionRefusal[] { return [...this.entries] }
  /** How many candidates were refused. */
  count(): number { return this.entries.length }
  /** Test seam: drop the recorded refusals. */
  clear(): void { this.entries.length = 0 }
}
/** The one refusal log: written by the emission site and by the host invariant. */
export const decisionRefusals = new DecisionRefusalLog()

/** The slice of a relayed host message the invariant inspects; structural, no host import. */
export interface RelayedMessage {
  id?: string
  source?: { kind?: string; deliveryId?: string; missionId?: string }
}
/** What the judge returns for a refused relayed message; `undefined` admits it. */
export interface RelayRefusal {
  missionId: string
  family: string
  subjects: string[]
  reason: string
  deliveryId?: string
}
/** Maps one relayed swarm message to a refusal, or `undefined` when it may be appended. */
export type RelayJudge = (message: RelayedMessage) => RelayRefusal | undefined
/** The host registry seam: only `register` is used, so no host package is imported at runtime. */
export interface InvariantRegistryLike {
  register(packageName: string, installer: (ctx: Context, fail: (message: string) => never) => void): () => void
}

/**
 * Record a host pre-append refusal raised while delivering one durable delivery,
 * and report whether the error was one (a host `InvariantError`, matched by name
 * and by its stable `INVARIANT` code rather than by message text). The adapter
 * uses this to acknowledge a refused delivery instead of letting the outbox retry
 * a decision the invariant will refuse again.
 */
export function recordAppendRefusal(error: unknown, delivery: { id: string; missionId: string; family: string; subjects: readonly string[] }): boolean {
  const row = error as { name?: unknown; code?: unknown } | null
  if (row?.name !== 'InvariantError' && row?.code !== 'INVARIANT') return false
  decisionRefusals.record({
    at: Date.now(), missionId: delivery.missionId, family: delivery.family, subjects: [...delivery.subjects],
    reason: error instanceof Error ? error.message : String(error), stage: 'append', deliveryId: delivery.id,
  })
  return true
}

/**
 * Every swarm message a `session/event` candidate would publish: a direct
 * `user/message`, or the messages inserted by an `agent/inbox/spliced` splice.
 * Any other event carries no swarm delivery.
 */
export function relayedSwarmMessages(event: unknown): RelayedMessage[] {
  if (event === null || typeof event !== 'object') return []
  const row = event as { type?: unknown; data?: unknown }
  const messages: RelayedMessage[] = []
  if (row.type === 'user/message') messages.push(row.data as RelayedMessage)
  else if (row.type === 'agent/inbox/spliced') {
    const inserted = (row.data as { inserted?: unknown } | undefined)?.inserted
    if (Array.isArray(inserted)) messages.push(...inserted as RelayedMessage[])
  }
  return messages.filter(message => message?.source?.kind === 'swarm')
}

/**
 * Register the companion through the host facility and refuse illegal appends.
 *
 * The install hook runs on the host's `internal/dispatch`, which fires before an
 * event is published, so `fail()` vetoes the append: the refused `session/event`
 * never reaches its listeners (the pre-append contract). The registration is
 * disposed with the plugin fiber through the inject callback's disposer.
 *
 * @param ctx - the plugin context carrying (or later receiving) the host registry.
 * @param judge - the refusal predicate over one relayed message.
 */
export function installSwarmInvariant(ctx: Context, judge: RelayJudge): void {
  ctx.inject(['invariants'], scoped => {
    const registry = scoped.get('invariants') as InvariantRegistryLike | undefined
    if (registry === undefined) return
    const dispose = registry.register(SWARM_INVARIANT_PACKAGE, (child, fail) => {
      child.on('internal/dispatch', (_mode: unknown, eventName: string, args: unknown[]) => {
        if (eventName !== 'session/event') return
        for (const message of relayedSwarmMessages(args[1])) {
          const refusal = judge(message)
          if (refusal === undefined) continue
          decisionRefusals.record({ at: Date.now(), ...refusal, stage: 'append' })
          fail(`refusing an owner-facing ${refusal.family} decision naming ${refusal.subjects.join(', ') || 'unknown subject'}: ${refusal.reason}`)
        }
      }, { global: true })
    })
    swarmInvariantStatus.registered = true
    return () => {
      swarmInvariantStatus.registered = false
      void dispose()
    }
  })
}
