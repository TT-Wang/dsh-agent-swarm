import type { Mission } from './types.ts'

/** Legacy rows retain already elapsed time; new missions start with an explicit zero clock. */
export function executionElapsed(mission: Mission, now = Date.now()): number {
  const clock = mission.executionTime
  if (clock === undefined) return Math.max(0, Math.min(now, mission.status === 'active' ? now : mission.updatedAt) - mission.createdAt)
  return clock.usedMs + (clock.since === undefined ? 0 : Math.max(0, now - clock.since))
}

/** Settle only elapsed execution; the separate absolute deadline never pauses. */
export function executionClock(mission: Mission, running: boolean, now = Date.now()): void {
  const usedMs = executionElapsed(mission, now)
  mission.executionTime = { usedMs, ...(running ? { since: now } : {}) }
  mission.deadline = Math.min(mission.budget.deadlineAt ?? Number.MAX_SAFE_INTEGER,
    now + Math.max(0, mission.budget.maxDurationMs - usedMs))
}
