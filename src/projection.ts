/**
 * R17-G6/G7: one truth for mission derived state.
 *
 * - R17-G6: mission derived state used to be re-derived by every consumer from
 *   raw rows. This module holds the single derivation (`memberPhaseOf`,
 *   `deriveMemberStatus`), which the store applies at its one member read face
 *   (`SwarmStore.list('members')`); the runtime's member board, the guard model
 *   and the owner/UI views all read that hydrated row, so no consumer carries
 *   its own version of it.
 *
 * - R17-G7: a durable member `status` mirrored a live fact (the R15-F2 seam: a
 *   member row reading `idle` while a live attempt exists). The status is now a
 *   pure function of the durable phase plus the tasks that name the member as
 *   the owner of a running attempt. The store strips it on write and re-derives
 *   it on read, so the reconciliation path and its upgrade-only rule are gone
 *   and the stale state is impossible by construction.
 *
 * NOT A SESSION PROJECTION (owner pass 2026-09-11). Round 17 also registered a
 * host projection unit and published each derived board into the owner session
 * as a plugin-owned session event (`swarm/mission`). The host's session format
 * keeps a CLOSED vocabulary (`KNOWN_SESSION_EVENT_TYPES`, no plugin
 * registration path) and refuses to decode a stored log containing an unknown
 * type unless its envelope carries `ignorable: true` — which `Session.append()`
 * cannot set. The result was a log only its writer could not read back:
 * `test:harness`, `test:profile` and `test:pack` refused on every host then supported
 * with `SessionFormatUnsupportedError … "swarm/mission" … not marked ignorable`.
 * The projection is derived state, the durable truth already lives in
 * `swarm.sqlite`, and the derivation was already the fallback read face, so the
 * session-event publication and the host registration are deleted rather than
 * patched. `tests/r17-projection.test.mjs` pins the surviving contract: the
 * plugin appends NOTHING to a session log, and the one derivation is the read
 * face whether or not a projection registry is mounted.
 */
import type { Delivery, Member, MemberPhase, MemberStatus } from './types.ts'

/** Current transport trouble, derived from pending delivery rows rather than another health state machine. */
export function memberDeliveryHealth(deliveries: readonly Delivery[]): Map<string, { pending: number; failed: number; since: number; reason: string }> {
  const pending = new Map<string, number>()
  const failures = new Map<string, { pending: number; failed: number; since: number; reason: string }>()
  for (const delivery of deliveries) {
    if (delivery.to === 'owner' || delivery.deliveredAt !== undefined) continue
    pending.set(delivery.to, (pending.get(delivery.to) ?? 0) + 1)
    if (delivery.deliveryFailure === undefined) continue
    const current = failures.get(delivery.to)
    failures.set(delivery.to, { pending: 0, failed: (current?.failed ?? 0) + 1,
      since: Math.min(current?.since ?? Infinity, delivery.deliveryFailure.at), reason: delivery.deliveryFailure.reason.slice(0, 500) })
  }
  for (const [memberId, value] of failures) value.pending = pending.get(memberId) ?? 0
  return failures
}

/** One derived member row: the durable phase plus the derived live status. */
export interface MissionBoardMember {
  id: string
  phase: MemberPhase
  status: MemberStatus
}

export function memberPhaseOf(member: Pick<Member, 'phase'> & { status?: MemberStatus }): MemberPhase {
  if (member.phase !== undefined) return member.phase
  if (member.status === 'stopped') return 'stopped'
  if (member.status === 'waiting') return 'parked'
  return 'active'
}

/**
 * R17-G7: the one derivation of the live member status.
 *
 * `stopped` and `parked` are durable intent and win over work in flight (a
 * parked member is never rewritten by the runtime; the parked-member hatch keeps
 * it dispatchable). An `active` member with a running attempt is `working`;
 * without one it is `idle`. There is no other input, and no path stores the
 * result, so a member row can never say `idle` while it owns a live attempt.
 *
 * Co-firing guards, named: the parked-member hatch (`startBlocker`, which makes a
 * parked member dispatchable), the W6 idle close-out (which owns the attempt
 * until it fences it, so this agrees with it rather than racing it), the dispatch
 * decision (which asks `startBlocker` about the handle, never this status) and
 * the test-side guard model (tests/guard-model.mjs, whose `guardProgressActions`
 * reads `working` as progress).
 */
export function deriveMemberStatus(phase: MemberPhase, ownsLiveAttempt: boolean): MemberStatus {
  if (phase === 'stopped') return 'stopped'
  if (phase === 'parked') return 'waiting'
  return ownsLiveAttempt ? 'working' : 'idle'
}
