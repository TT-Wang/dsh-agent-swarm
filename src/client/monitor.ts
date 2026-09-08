import type { LiveState, LiveUpdate } from '../live-types.ts'
import { readSnapshot } from './projection.ts'
export type { LiveState } from '../live-types.ts'
export interface MonitorState {
  ownerSessionId?: string
  data?: LiveState
  error?: string
  loading: boolean
  updatedAt?: number
  connection: 'connecting' | 'connected' | 'reconnecting' | 'paused'
}
export type Request = <T>(endpoint: string, payload: unknown, signal?: AbortSignal) => Promise<T>

/** One cancellable, cursor-based observer per visible pane. Old replies cannot cross owners. */
export class SwarmMonitor {
  private state: MonitorState = { loading: false, connection: 'connecting' }
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
    this.publish({ ownerSessionId, loading: Boolean(ownerSessionId), connection: active ? 'connecting' : 'paused' })
    if (ownerSessionId) void this.refresh()
  }
  /** Hidden sidebar tabs retain their data and unsaved editor state. */
  setActive(active: boolean, refresh = true) {
    if (this.active === active || this.disposed) return
    this.active = active
    clearTimeout(this.timer)
    this.pending?.abort()
    this.pending = undefined
    this.publish({ ...this.state, connection: active ? 'connecting' : 'paused' })
    if (active && refresh) void this.refresh()
  }
  refresh = (): Promise<void> => this.read(false)
  private async read(watch: boolean): Promise<void> {
    const owner = this.state.ownerSessionId, generation = this.generation
    if (!owner || !this.active || this.disposed) return
    clearTimeout(this.timer)
    this.pending?.abort()
    const controller = new AbortController()
    this.pending = controller
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 30_000)
    try {
      const revision = this.state.data?.revision
      const update = watch && revision !== undefined
        ? await this.request<LiveUpdate>('watch', { sessionId: owner, afterRevision: revision }, controller.signal)
        : undefined
      const data = update === undefined
        ? await this.request<LiveState>('state', { sessionId: owner }, controller.signal)
        : mergeUpdate(this.state.data, update, owner)
      if (this.disposed || generation !== this.generation || this.pending !== controller) return
      validateState(data, owner)
      this.failures = 0
      this.publish({ ownerSessionId: owner, data, loading: false, updatedAt: Date.now(), connection: 'connected' })
    } catch (error) {
      if (this.disposed || generation !== this.generation || this.pending !== controller || (controller.signal.aborted && !timedOut)) return
      this.failures++
      this.publish({ ...this.state, loading: false, connection: 'reconnecting', error: timedOut ? 'Swarm connection timed out' : error instanceof Error ? error.message : String(error) })
    } finally {
      clearTimeout(timeout)
      if (!this.disposed && this.active && generation === this.generation && this.pending === controller) {
        this.pending = undefined
        const supportsWatch = this.state.data?.revision !== undefined
        // Legacy cached clients retain polling compatibility. Current hosts wait for commits.
        const interval = this.failures ? Math.min(15_000, 1000 * 2 ** (this.failures - 1)) : supportsWatch ? 40 : 2000
        this.timer = setTimeout(() => { void this.read(supportsWatch) }, interval)
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

function validateState(data: LiveState, owner: string): void {
  if (!data || data.ownerSessionId !== owner || !Array.isArray(data.snapshots) || !Array.isArray(data.drafts)
    || data.snapshots.some(snapshot => !readSnapshot(snapshot))
    || (data.revision !== undefined && (!Number.isSafeInteger(data.revision) || data.revision < 0))) throw new Error('Invalid swarm state from host')
}

/** Reconcile authoritative mission membership without resetting unchanged cards or editor state. */
export function mergeUpdate(previous: LiveState | undefined, update: LiveUpdate, owner: string): LiveState {
  if (!update || update.ownerSessionId !== owner || !Number.isSafeInteger(update.revision) || update.revision < 0) throw new Error('Invalid swarm update from host')
  if (update.kind === 'snapshot') {
    validateState(update.state, owner)
    if (update.state.revision !== update.revision) throw new Error('Mismatched swarm snapshot revision')
    return update.state
  }
  if (!previous || update.revision < (previous.revision ?? 0)) throw new Error('Swarm update cursor is out of order')
  if (update.kind === 'heartbeat') {
    if ((update.ownerLive !== undefined && typeof update.ownerLive !== 'boolean') || (update.writable !== undefined && typeof update.writable !== 'boolean')) throw new Error('Invalid swarm connection metadata')
    if (update.workspace !== undefined && typeof update.workspace !== 'string') throw new Error('Invalid swarm workspace metadata')
    if (update.defaultBudget !== undefined && (!update.defaultBudget || ['maxTokens', 'maxSteps', 'maxWorkers', 'maxDurationMs', 'maxTasks', 'maxExperiments'].some(key => !Number.isSafeInteger(update.defaultBudget![key as keyof typeof update.defaultBudget])))) throw new Error('Invalid swarm budget metadata')
    return { ...previous, revision: update.revision,
      ...(update.ownerLive === undefined ? {} : { ownerLive: update.ownerLive }),
      ...(update.writable === undefined ? {} : { writable: update.writable }),
      ...(update.defaultBudget === undefined ? {} : { defaultBudget: update.defaultBudget }),
      ...(update.workspace === undefined ? {} : { workspace: update.workspace }) }
  }
  if (update.kind !== 'delta') throw new Error('Unknown swarm update kind')
  validateState(update.state, owner)
  if (update.state.revision !== update.revision || !Array.isArray(update.missionIds)
    || update.missionIds.some(id => typeof id !== 'string') || new Set(update.missionIds).size !== update.missionIds.length) throw new Error('Invalid swarm delta membership')
  const snapshots = new Map(previous.snapshots.map(snapshot => [snapshot.mission.id, snapshot]))
  for (const snapshot of update.state.snapshots) {
    if (!update.missionIds.includes(snapshot.mission.id)) throw new Error('Swarm delta contains an unexpected mission')
    snapshots.set(snapshot.mission.id, snapshot)
  }
  if (update.missionIds.some(id => !snapshots.has(id))) throw new Error('Swarm delta is missing a mission snapshot')
  return { ...update.state, snapshots: update.missionIds.map(id => snapshots.get(id)!) }
}
