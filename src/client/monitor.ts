import type { AutoStart, Budget, DraftPlan, Snapshot } from '../types.ts'
import { readSnapshot } from './projection.ts'

export interface LiveState {
  ownerSessionId: string
  workspace: string
  snapshots: Snapshot[]
  drafts: DraftPlan[]
  starts?: AutoStart[]
  defaultBudget: Budget
  writable: boolean
  ownerLive: boolean
}
export interface MonitorState {
  ownerSessionId?: string
  data?: LiveState
  error?: string
  loading: boolean
  updatedAt?: number
}
export type Request = <T>(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<T>

/** A single selected-owner poller, disposed with the plugin. Old responses cannot cross owners. */
export class SwarmMonitor {
  private state: MonitorState = { loading: false }
  private listeners = new Set<() => void>()
  private generation = 0
  private timer?: ReturnType<typeof setTimeout>
  private pending?: AbortController
  private disposed = false
  private active = true
  private failures = 0
  constructor(readonly request: Request) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: MonitorState) { this.state = value; for (const listener of this.listeners) listener() }
  select(ownerSessionId?: string, active = this.active) {
    const activityChanged = this.active !== active
    this.setActive(active, false)
    if (this.disposed) return
    if (ownerSessionId === this.state.ownerSessionId) {
      if (activityChanged && active) void this.refresh()
      return
    }
    this.generation++
    clearTimeout(this.timer)
    this.pending?.abort()
    this.pending = undefined
    this.failures = 0
    this.publish({ ownerSessionId, loading: Boolean(ownerSessionId) })
    if (ownerSessionId) void this.refresh()
  }
  /** Hidden sidebar tabs retain their data and unsaved editor state. */
  setActive(active: boolean, refresh = true) {
    if (this.active === active || this.disposed) return
    this.active = active
    clearTimeout(this.timer)
    this.pending?.abort()
    this.pending = undefined
    if (active && refresh) void this.refresh()
  }
  refresh = async (): Promise<void> => {
    const owner = this.state.ownerSessionId, generation = this.generation
    if (!owner || !this.active || this.disposed) return
    clearTimeout(this.timer)
    this.pending?.abort()
    const controller = new AbortController()
    this.pending = controller
    try {
      const data = await this.request<LiveState>('state', { sessionId: owner }, controller.signal)
      if (this.disposed || generation !== this.generation || this.pending !== controller) return
      if (data.ownerSessionId !== owner || !Array.isArray(data.snapshots) || !Array.isArray(data.drafts)
        || data.snapshots.some(snapshot => !readSnapshot(snapshot))) throw new Error('Invalid swarm state from host')
      this.failures = 0
      this.publish({ ownerSessionId: owner, data, loading: false, updatedAt: Date.now() })
    } catch (error) {
      if (this.disposed || generation !== this.generation || this.pending !== controller || controller.signal.aborted) return
      this.failures++
      this.publish({ ...this.state, loading: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (!this.disposed && this.active && generation === this.generation && this.pending === controller) {
        this.pending = undefined
        const active = this.state.data?.starts?.some(start => ['planning', 'launching'].includes(start.status)) || this.state.data?.snapshots.some(snapshot => ['active', 'paused', 'blocked'].includes(snapshot.mission.status))
        const interval = this.failures ? Math.min(30_000, 2000 * 2 ** this.failures) : active ? 2000 : 6000
        this.timer = setTimeout(() => { void this.refresh() }, interval)
      }
    }
  }
  dispose() {
    this.disposed = true
    this.generation++
    clearTimeout(this.timer)
    this.pending?.abort()
    this.listeners.clear()
  }
}
