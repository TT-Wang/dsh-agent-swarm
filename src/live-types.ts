/** Read models carried over Harness's authenticated Connection RPC. */
import type { AutoStart, Budget, DraftPlan, Snapshot } from './types.ts'

export interface LiveState {
  ownerSessionId: string
  workspace: string
  snapshots: Snapshot[]
  drafts: DraftPlan[]
  starts?: AutoStart[]
  defaultBudget: Budget
  writable: boolean
  ownerLive: boolean
  /** Absent only when talking to a pre-watch plugin build. */
  revision?: number
}

export type LiveUpdate = {
  kind: 'snapshot' | 'delta'
  ownerSessionId: string
  revision: number
  state: LiveState
  /** Complete authorized membership; a delta carries only changed snapshots. */
  missionIds: string[]
} | {
  kind: 'heartbeat'
  ownerSessionId: string
  revision: number
  /** Native owner lifecycle is independent of the swarm transaction cursor. */
  ownerLive?: boolean
  writable?: boolean
  defaultBudget?: Budget
  workspace?: string
}
