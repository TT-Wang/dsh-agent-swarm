import type { DeliveryApplication, Snapshot } from '../types.ts'
import { deliverableCommit, deliveryApplied } from './projection.ts'

/** A response may bridge the interval until the monitor publishes its next snapshot. */
export interface DeliveryObservation {
  baseSnapshot: Snapshot
  commit: string
  snapshot?: Snapshot
  result?: DeliveryApplication
}
export interface DeliveryState { applied: boolean; result?: DeliveryApplication }

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
/** Read the latest matching delivery outcome, not an earlier conflict followed by a successful apply. */
function conflicts(snapshot: Snapshot, commit: string | undefined): DeliveryApplication | undefined {
  if (!commit) return undefined
  const latest = snapshot.events.filter(event => event.missionId === snapshot.mission.id && Number.isSafeInteger(event.seq)
    && ['delivery/applied', 'delivery/conflicts'].includes(event.type.replaceAll('.', '/')) && record(event.data).resultCommit === commit)
    .sort((a, b) => b.seq - a.seq)[0]
  if (latest?.type.replaceAll('.', '/') !== 'delivery/conflicts') return undefined
  const data = record(latest.data)
  return strings(data.changedPaths) && strings(data.conflicts)
    ? { status: 'conflicts', changedPaths: data.changedPaths, conflicts: data.conflicts } : undefined
}

/** Any newer host snapshot supersedes a local response, including an authoritative cleared receipt. */
export function projectDeliveryState(snapshot: Snapshot, commit: string | undefined, observation?: DeliveryObservation): DeliveryState {
  const local = observation?.baseSnapshot === snapshot && observation.commit === commit ? observation : undefined
  const authoritative = local?.snapshot && local.snapshot.mission.id === snapshot.mission.id
    && deliverableCommit(local.snapshot) === commit ? local.snapshot : snapshot
  const applied = local?.snapshot === undefined && local?.result !== undefined
    ? local.result.status === 'applied' : deliveryApplied(authoritative, commit)
  if (applied) return { applied: true }
  const result = local?.snapshot === undefined ? local?.result ?? conflicts(authoritative, commit) : conflicts(authoritative, commit)
  return { applied: false, ...(result?.status === 'conflicts' ? { result } : {}) }
}

export type DeliveryCheck = { kind: 'missing' } | { kind: 'applied' | 'conflicts' | 'retry'; observation: DeliveryObservation }
/** A negative read unlocks an explicit user retry; it never sends another mutation itself. */
export function checkDeliveryOutcome(baseSnapshot: Snapshot, commit: string | undefined, latest?: Snapshot): DeliveryCheck {
  if (!commit || !latest || latest.mission.id !== baseSnapshot.mission.id || deliverableCommit(latest) !== commit) return { kind: 'missing' }
  const observation: DeliveryObservation = { baseSnapshot, commit, snapshot: latest }
  const state = projectDeliveryState(baseSnapshot, commit, observation)
  return { kind: state.applied ? 'applied' : state.result?.status === 'conflicts' ? 'conflicts' : 'retry', observation }
}
