/** Assignment flexibility is opt-in and ends as soon as the first attempt starts. */
export interface AssignmentCandidate {
  id?: string
  status: string
  assigneeId?: string
  assignmentMode?: 'preferred' | 'pinned'
  epoch?: number
  attempt?: unknown
  resumeAfterStop?: unknown
  budgetResume?: unknown
  reviewOf?: string
  priorOwnerIds?: readonly string[]
  checkpoint?: unknown
}

/** The ownership facts a review's independence is decided from. */
export interface AuthoredTask {
  assigneeId?: string
  priorOwnerIds?: readonly string[]
  attempt?: { ownerId?: string }
}

/**
 * X1 (P0): the current assignee, the current attempt's owner and every
 * recorded prior owner. An unused initial preference is not in the history
 * once borrowed, so independence follows actual ownership.
 */
export function authorIdsOf(task: AuthoredTask): Set<string> {
  const ids = new Set(task.priorOwnerIds ?? [])
  if (task.attempt?.ownerId !== undefined) ids.add(task.attempt.ownerId)
  if (task.assigneeId !== undefined) ids.add(task.assigneeId)
  return ids
}

/**
 * The one independence rule every assignment path applies: a member may own a
 * review of `source` only if it never authored it. No source (a task that
 * reviews nothing) excludes no one.
 */
export function canOwnReview(source: AuthoredTask | undefined, memberId: string): boolean {
  return source === undefined || !authorIdsOf(source).has(memberId)
}

/** Recovery and handoff own their workspace; only untouched pending work may move. */
export function canBorrowTask(task: AssignmentCandidate): boolean {
  // New admissions record an explicit empty ownership history. Epoch also
  // fences preparation/policy edits and does not imply that execution began.
  // Old rows without ownership history retain the conservative epoch guard.
  const untouched = task.priorOwnerIds === undefined ? task.epoch === 0 : task.priorOwnerIds.length === 0
  return task.assignmentMode === 'preferred' && task.status === 'pending' && untouched && task.checkpoint === undefined
    && task.attempt === undefined && task.resumeAfterStop === undefined && task.budgetResume === undefined
}

/**
 * Assignment eligibility, before readiness/independence and member availability.
 * Borrowing must not turn an explicitly pinned future reviewer into its source's
 * author. Legacy tasks have no mode and keep their existing assignment contract.
 */
export function assignmentAllows(task: AssignmentCandidate, memberId: string, tasks: readonly AssignmentCandidate[] = []): boolean {
  if (task.assigneeId === undefined || task.assigneeId === memberId) return true
  return canBorrowTask(task) && !tasks.some(review => review.reviewOf === task.id
    && review.assigneeId === memberId && !canBorrowTask(review)
    && (review.status === 'pending' || review.status === 'running' || review.status === 'submitted'))
}
