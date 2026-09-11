/**
 * R17-G6/G7: one truth for mission derived state.
 *
 * - R17-G6: mission derived state used to be re-derived by every consumer from
 *   raw rows. This module holds the single derivation (`memberPhaseOf`,
 *   `deriveMemberStatus`, `deriveMemberBoard`) that the runtime's read face, the
 *   guard model and the owner/UI views all consume, so no consumer carries its
 *   own version of it.
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
 * `test:harness`, `test:profile` and `test:pack` refused on every supported host
 * with `SessionFormatUnsupportedError … "swarm/mission" … not marked ignorable`.
 * The projection is derived state, the durable truth already lives in
 * `swarm.sqlite`, and the derivation was already the fallback read face, so the
 * session-event publication and the host registration are deleted rather than
 * patched. `tests/r17-projection.test.mjs` pins the surviving contract: the
 * plugin appends NOTHING to a session log, and the one derivation is the read
 * face whether or not a projection registry is mounted.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Member, MemberPhase, MemberStatus, Task, WorkerAdapter } from './types.ts'

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

/** Whether a member currently owns a running task attempt. */
export function ownsLiveAttempt(memberId: string, tasks: readonly Task[]): boolean {
  return tasks.some(task => task.status === 'running' && task.attempt !== undefined && task.attempt.ownerId === memberId)
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
 * the guard board (`guardProgressActions` reads `working` as progress).
 */
export function deriveMemberStatus(phase: MemberPhase, ownsLiveAttempt: boolean): MemberStatus {
  if (phase === 'stopped') return 'stopped'
  if (phase === 'parked') return 'waiting'
  return ownsLiveAttempt ? 'working' : 'idle'
}

/** One member view: the durable row plus the derived status, from the one derivation. */
export function memberView(member: Member, tasks: readonly Task[]): Member {
  const phase = memberPhaseOf(member)
  return { ...member, phase, status: deriveMemberStatus(phase, ownsLiveAttempt(member.id, tasks)) }
}

/** The derived view of every member row, in the input order. */
export function memberViews(members: readonly Member[], tasks: readonly Task[]): Member[] {
  return members.map(member => memberView(member, tasks))
}

/** The derived member board: what every consumer reads instead of re-deriving. */
export function deriveMemberBoard(members: readonly Member[], tasks: readonly Task[]): MissionBoardMember[] {
  return memberViews(members, tasks).map(member => ({ id: member.id, phase: memberPhaseOf(member), status: member.status }))
}

/** The derived mission board, from durable rows only. */
export function hostContextOf(workers: WorkerAdapter): Context | undefined {
  const candidate = (workers as unknown as { ctx?: unknown }).ctx
  if (candidate === null || typeof candidate !== 'object') return undefined
  const ctx = candidate as Context
  return typeof ctx.get === 'function' ? ctx : undefined
}
