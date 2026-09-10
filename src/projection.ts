/**
 * R17-G6/G7: one truth for mission derived state.
 *
 * Two gaps, one seam:
 *
 * - R17-G6: mission derived state used to be re-derived by every consumer from
 *   raw rows. The host already offers the facility for exactly this
 *   (`ctx.sessionProjections.register`, used by several host packages and by
 *   Agent Teams) and we only ever read one of its keys. This module registers a
 *   host-only projection unit for the mission board, publishes the derived board
 *   into the owner session on a transition, and exposes the same derivation to
 *   every in-process reader, so no consumer carries its own version of it.
 *
 * - R17-G7: a durable member `status` mirrored a live fact (the R15-F2 seam: a
 *   member row reading `idle` while a live attempt exists). The status is now a
 *   pure function of the durable phase plus the tasks that name the member as
 *   the owner of a running attempt. The store strips it on write and re-derives
 *   it on read, so the reconciliation path and its upgrade-only rule are gone
 *   and the stale state is impossible by construction.
 *
 * The projection state is a plain-JSON fold over the plugin's own session event
 * (`swarm/mission`, whole value per mission), so the host can checkpoint and
 * replay it exactly like the units the host packages register. The publication
 * is transition-driven: a commit that does not change the board appends nothing.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SwarmRuntime } from './runtime.ts'
import type { Member, MemberPhase, MemberStatus, Mission, Task, WorkerAdapter } from './types.ts'

/** The projection key this plugin owns. Host-only: no client wire value. */
export const MISSION_PROJECTION_KEY = 'swarmMission'
/** The plugin-owned session event type that carries one whole derived board. */
export const MISSION_PROJECTION_EVENT = 'swarm/mission'

/** One derived member row: the durable phase plus the derived live status. */
export interface MissionBoardMember {
  id: string
  phase: MemberPhase
  status: MemberStatus
}

/** The derived mission board: mission identity, durable status and member views. */
export interface MissionBoard {
  missionId: string
  status: Mission['status']
  updatedAt: number
  members: MissionBoardMember[]
}

/**
 * Checkpoint-safe projection state: the newest whole board per mission, keyed
 * by mission id, for every mission owned by the projected session. Plain JSON.
 */
export interface MissionProjectionState {
  version: 1
  /**
   * Identity of the session this fold belongs to. `apply` refuses a payload
   * published for another session, so a forked session that inherits the
   * parent's log starts with an empty board instead of mirroring missions it
   * does not own.
   */
  sessionId: string
  missions: Record<string, MissionBoard>
}

/** The whole-value payload of one `swarm/mission` session event. */
export interface MissionProjectionEvent {
  version: 1
  missionId: string
  ownerSessionId: string
  board: MissionBoard
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One whole derived mission board, published on a transition. */
    'swarm/mission': MissionProjectionEvent
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    swarmMission: MissionProjectionState
  }
}

/**
 * R17-G7: the durable phase of a member row — the ONE rule, including the legacy
 * mapping for rows written before the phase existed.
 *
 * A phase-less row carries only the old durable `status`, and the recorded
 * intent in it must survive the split: `stopped` stays stopped (not dispatchable,
 * exactly as the base read it) and `waiting` stays parked. `idle` and `working`
 * were live facts rather than intent, so a phase-less row recording one is
 * `active` until a phase is written, and the live status is re-derived from the
 * attempt it owns. Every member read and write goes through this function
 * (`SwarmStore.get`/`list` hydration and the member write funnel), so a
 * read-modify-write cannot turn a stopped legacy row into a dispatchable one.
 *
 * The live store is exactly this shape — 142 member rows, 0 carrying a phase,
 * 114 of them `stopped` — which is why the fallback is a rule, not a default.
 */
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
export function deriveMissionBoard(mission: Mission, members: readonly Member[], tasks: readonly Task[]): MissionBoard {
  return {
    missionId: mission.id,
    status: mission.status,
    updatedAt: mission.updatedAt,
    members: deriveMemberBoard(members, tasks),
  }
}

/** Structural equality of two published boards, so an unchanged commit publishes nothing. */
export function sameMissionBoard(left: MissionBoard | undefined, right: MissionBoard): boolean {
  if (left === undefined || left.missionId !== right.missionId || left.status !== right.status || left.updatedAt !== right.updatedAt) return false
  if (left.members.length !== right.members.length) return false
  return left.members.every((member, index) => {
    const other = right.members[index]
    return other !== undefined && member.id === other.id && member.phase === other.phase && member.status === other.status
  })
}

/**
 * The registry validates a persisted state before it seeds a fold. The plugin
 * has no zod dependency (and must not grow one), so the schema is the same
 * structural parse the fold uses, exposed as the `parse` face the registry
 * calls; a malformed checkpoint row is refused instead of seeded.
 */
function parseMissionProjectionState(value: unknown): MissionProjectionState {
  if (value === null || typeof value !== 'object') throw new Error('swarmMission projection state must be an object')
  const candidate = value as Partial<MissionProjectionState>
  if (candidate.version !== 1 || typeof candidate.sessionId !== 'string' || candidate.missions === null || typeof candidate.missions !== 'object') throw new Error('swarmMission projection state has an unknown version')
  for (const [missionId, board] of Object.entries(candidate.missions)) {
    if (board === null || typeof board !== 'object' || board.missionId !== missionId || typeof board.status !== 'string' || !Array.isArray(board.members)) {
      throw new Error(`swarmMission projection state has a malformed board for ${missionId}`)
    }
    for (const member of board.members) {
      if (member === null || typeof member !== 'object' || typeof member.id !== 'string' || typeof member.phase !== 'string' || typeof member.status !== 'string') {
        throw new Error(`swarmMission projection state has a malformed member in ${missionId}`)
      }
    }
  }
  return candidate as MissionProjectionState
}

/** Decode one persisted `swarm/mission` payload; a malformed one is ignored, never folded. */
function decodeMissionEvent(data: unknown): MissionProjectionEvent | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const candidate = data as Partial<MissionProjectionEvent>
  if (candidate.version !== 1 || typeof candidate.missionId !== 'string' || typeof candidate.ownerSessionId !== 'string') return undefined
  if (candidate.board === null || typeof candidate.board !== 'object' || candidate.board.missionId !== candidate.missionId) return undefined
  return candidate as MissionProjectionEvent
}

/** The host-only projection unit this plugin registers. */
export const missionProjectionDefinition = {
  key: MISSION_PROJECTION_KEY,
  stateVersion: 1,
  stateSchema: { parse: (value: unknown) => parseMissionProjectionState(value) } as unknown as ProjectionDefinition<'swarmMission', MissionProjectionState>['stateSchema'],
  init: header => ({ version: 1 as const, sessionId: header.id, missions: {} }),
  apply: (state: MissionProjectionState, event: SessionEvent): MissionProjectionState => {
    if (event.type !== MISSION_PROJECTION_EVENT) return state
    const payload = decodeMissionEvent(event.data)
    // An unchanged reference is the registry's "not my event" answer: a payload
    // published for another session (an inherited fork prefix, or a stale event)
    // cannot enter this fold.
    if (payload === undefined || payload.ownerSessionId !== state.sessionId) return state
    return { version: 1, sessionId: state.sessionId, missions: { ...state.missions, [payload.missionId]: payload.board } }
  },
} satisfies ProjectionDefinition<'swarmMission', MissionProjectionState>

/**
 * The host context a worker adapter was composed with, when it has one.
 *
 * `HarnessWorkers` keeps the context it was constructed with; the runtime reads
 * it structurally (never by importing the adapter) because the plugin
 * composition and the adapter are outside this task's write scope, and because a
 * unit adapter that has no host services must simply register no projection:
 * capability absence, never a crash. A runtime whose adapter carries no context
 * keeps the derivation-only read face.
 */
export function hostContextOf(workers: WorkerAdapter): Context | undefined {
  const candidate = (workers as unknown as { ctx?: unknown }).ctx
  if (candidate === null || typeof candidate !== 'object') return undefined
  const ctx = candidate as Context
  return typeof ctx.get === 'function' ? ctx : undefined
}

/**
 * R17-G6: the mission projection owner. It registers the host-only unit through
 * `ctx.sessionProjections.register`, publishes each mission's derived board into
 * its owner session on a transition (never on an unchanged commit), and disposes
 * the registration on unload so the key disappears from the host's snapshots.
 */
export class MissionProjection {
  private host: Context | undefined
  private unregister: (() => void) | undefined
  private unsubscribe: (() => void) | undefined
  constructor(private readonly runtime: SwarmRuntime) {}

  /**
   * Register the unit against the host context the worker adapter carries.
   * Idempotent; a host without the projection registry (a headless unit
   * composition) registers nothing and every reader uses the derivation.
   */
  attach(workers: WorkerAdapter): void {
    if (this.unregister !== undefined) return
    const ctx = hostContextOf(workers)
    if (ctx === undefined) return
    const registry = ctx.get('sessionProjections')
    if (registry === undefined) return
    try {
      this.unregister = registry.register(missionProjectionDefinition)
    } catch {
      // A conflicting key (another registration at a different stateVersion) is
      // the host's refusal to serve one key twice; the derivation still serves
      // this process, so the plugin keeps working without the projection.
      this.unregister = undefined
      return
    }
    this.host = ctx
    this.unsubscribe = this.runtime.subscribe(missionId => this.publish(missionId))
  }

  /**
   * Publish one mission's derived board into its owner session. The whole value
   * rides the session log (the projection's fold input), and a commit whose
   * board equals the published one appends nothing. Never throws: a read model
   * must not break the durable commit that triggered it.
   */
  publish(missionId: string): void {
    if (this.host === undefined || this.unregister === undefined) return
    try {
      const registry = this.host.get('sessionProjections')
      if (registry === undefined) return
      const mission = this.runtime.store.get('missions', missionId)
      if (mission === undefined) return
      const session = this.sessionOf(mission.ownerSessionId)
      if (session === undefined) return
      const board = deriveMissionBoard(mission, this.runtime.store.list('members', missionId), this.runtime.store.list('tasks', missionId))
      const current = registry.stateOf(session, MISSION_PROJECTION_KEY)
      if (sameMissionBoard(current?.missions[missionId], board)) return
      session.append(MISSION_PROJECTION_EVENT, { version: 1, missionId, ownerSessionId: mission.ownerSessionId, board })
    } catch {
      // The projection is a read model; a missing owner session, a closed
      // registry or a non-serializable board must not roll back durable work.
    }
  }

  /** The published board for one mission, when this process has a projection and an attached owner session. */
  boardOf(missionId: string): MissionBoard | undefined {
    if (this.host === undefined) return undefined
    try {
      const mission = this.runtime.store.get('missions', missionId)
      if (mission === undefined) return undefined
      const session = this.sessionOf(mission.ownerSessionId)
      if (session === undefined) return undefined
      return this.host.get('sessionProjections')?.stateOf(session, MISSION_PROJECTION_KEY)?.missions[missionId]
    } catch {
      return undefined
    }
  }

  /** Whether this process registered the host unit (the test-visible capability flag). */
  get registered(): boolean {
    return this.unregister !== undefined
  }

  /** Unregister the host unit and stop publishing. Idempotent. */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    const unregister = this.unregister
    this.unregister = undefined
    this.host = undefined
    try { unregister?.() } catch { /* the registry was already disposed with its host */ }
  }

  /** The live owner session for a mission, when the host has it attached. */
  private sessionOf(ownerSessionId: string): Session | undefined {
    const ctx = this.host
    if (ctx === undefined) return undefined
    const sessionId = SessionId(ownerSessionId)
    const attached = ctx.get('sessions')?.get(sessionId)
    if (attached !== undefined) return attached
    return ctx.get('agents')?.get(sessionId)?.session
  }
}
