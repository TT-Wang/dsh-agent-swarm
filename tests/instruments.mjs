/**
 * Read-only measurement projections over a runtime's durable rows, kept as TEST
 * instruments. Each one lived on the runtime until nothing in src/ read it: the
 * tests were its only caller, so it now lives beside them. Each reads the
 * production classifiers it measures (they stay in src/ because the live
 * notice paths use them) and writes nothing.
 */
import { NO_LIVE_PATH_FAMILIES, TERMINAL_STATES, noticeFamily, taskFromSubject, taskSubject } from '../lib/notices.js'
import { ATTEMPT_FENCING_EVENTS } from '../lib/types.js'


/**
 * R16-A: the wake precision of one mission's owner decisions, projected from
 * durable rows only (deliveries and tasks), never from a cache or from notice
 * prose. It answers three questions as numbers:
 *
 * - decisions by family: how many owner notices of each durable family the
 *   mission produced (the family is the dedup key the runtime itself wrote);
 * - false wakes: a decision of a family that claims "no live path will advance
 *   this subject" (fall-through, stall-root) naming a subject whose lineage
 *   still has a live path on the durable board. `waitsLegitimately` is the
 *   classifier; for a stall root the question is whether the same row is still
 *   a root now (`stallRoots`), because a blocked root may legitimately wait on
 *   a live predecessor while still owing a repair decision;
 * - missed obligations: a non-terminal task with no live path that no owner
 *   decision names at its current epoch.
 *
 * Boundary: the judgement is made against the durable rows at READ time. A
 * decision whose subject has since advanced to another epoch is not judged, so
 * historical false wakes are not reconstructed here.
 */
export function wakePrecision(runtime, missionId) {
  const notices = runtime.notices
  const tasks = runtime.store.list('tasks', missionId)
  const deliveries = runtime.store.list('deliveries', missionId).filter(delivery => delivery.to === 'owner'
    && (delivery.notice?.class === 'decision' || delivery.notice?.class === 'escalation' || delivery.kind === 'escalation'))
  const roots = new Set(notices.stallRoots(tasks).map(task => taskSubject(task)))
  const byFamily = {}
  const falseByFamily = {}
  const falseSubjects = []
  const named = new Set()
  for (const delivery of deliveries) {
    const family = noticeFamily(delivery)
    byFamily[family] = (byFamily[family] ?? 0) + 1
    for (const subject of delivery.subjects ?? []) named.add(subject)
    if (!NO_LIVE_PATH_FAMILIES.has(family)) continue
    for (const subject of delivery.subjects ?? []) {
      const task = taskFromSubject(subject, tasks)
      if (task === undefined) continue
      const falseWake = family === 'stall-root'
        ? task.status === 'blocked' && !roots.has(subject)
        : notices.waitsLegitimately(task, tasks)
      if (!falseWake) continue
      falseByFamily[family] = (falseByFamily[family] ?? 0) + 1
      falseSubjects.push(subject)
    }
  }
  const missed = []
  for (const task of tasks) {
    if (TERMINAL_STATES.has(task.status)) continue
    if (notices.waitsLegitimately(task, tasks)) continue
    const subject = taskSubject(task)
    if (named.has(subject)) continue
    missed.push(subject)
  }
  const uniqueFalseSubjects = [...new Set(falseSubjects)]
  return {
    missionId,
    decisions: { total: deliveries.length, byFamily },
    falseWakes: { total: uniqueFalseSubjects.length, byFamily: falseByFamily, subjects: uniqueFalseSubjects },
    missedObligations: { total: missed.length, subjects: missed },
  }
}

/** Mirrors `isAttemptCloser` in its old src/scheduling.ts form: the shared fencing vocabulary. */
const isAttemptCloser = type => ATTEMPT_FENCING_EVENTS.some(kind => kind === type)

/**
 * R16-D: the silence projection. Read from the durable store alone — the
 * retained event window, the tool-run rows, the delivery rows, the current task
 * rows and the one durable pass row — and it changes nothing.
 *
 * The two numbers it reports:
 *  - the worst per-subject silent gap, each subject carrying the declared bound
 *    it was measured against (a released scheduling pass against the pass
 *    release bound; an escalated attempt against the attempt reporting bound);
 *  - the worst per-attempt reporting gap, plus how many attempts ended with no
 *    durable report or escalation at all.
 *
 * Definitions, stated so a reader can falsify them:
 *  - an attempt's durable elements are its `task/claimed` dispatch (and the
 *    assignment delivery written with it), every durable event naming its task
 *    or attempt while it was current, every delivery naming them, and every
 *    recorded tool run of the attempt;
 *  - its reporting gap is the longest interval between consecutive elements,
 *    closed at its end (or at read time while it is live);
 *  - it ended unreported when it is no longer the task's current attempt and no
 *    durable event or delivery after its dispatch ever named it — the dispatch
 *    itself is not a report about the attempt.
 *
 * Limits: the attempt intervals come from the retained event window
 * (`maxEvents`); an attempt that ended with no closing event is dated at its
 * last durable element; the attempt bound quoted is the bound in force at read
 * time. Attribution uses the scheduler's own `identityIn`, the same predicate
 * the live attempt-silence bound reads.
 */
export function silenceReport(runtime, missionId) {
  const scheduling = runtime.scheduling
  const now = Date.now()
  const bounds = { passMs: runtime.stallPassTimeoutMs, passReleaseMs: runtime.stallPassReleaseBoundMs, attemptMs: runtime.attemptSilenceBoundMs }
  const events = runtime.store.events(missionId, runtime.config.maxEvents)
  const deliveries = runtime.store.list('deliveries', missionId)
  const current = new Map(runtime.store.list('tasks', missionId).map(task => [task.id, task]))
  const byAttempt = new Map()
  const open = new Map()
  const claimStart = event => {
    const data = event.data
    const taskId = typeof data?.taskId === 'string' ? data.taskId : undefined
    const attemptId = typeof data?.attempt?.id === 'string' ? data.attempt.id : undefined
    const ownerId = typeof data?.attempt?.ownerId === 'string' ? data.attempt.ownerId : undefined
    if (taskId === undefined || attemptId === undefined || ownerId === undefined) return
    const prior = open.get(taskId)
    // A re-dispatch is the durable close of the attempt it replaces.
    if (prior !== undefined) prior.endedAt = Math.min(prior.endedAt ?? event.createdAt, event.createdAt)
    const interval = { attemptId, taskId, epoch: typeof data?.attempt?.epoch === 'number' ? data.attempt.epoch : 0, memberId: ownerId, claimedAt: event.createdAt, elements: [{ at: event.createdAt, kind: 'claim', isClaim: true }] }
    byAttempt.set(attemptId, interval)
    open.set(taskId, interval)
  }
  for (const event of events) {
    if (event.type === 'task/claimed') { claimStart(event); continue }
    // The event is attributed to the open attempt of each task it names; a
    // closer ends that attempt at this instant and takes it out of the open set.
    let closedTask
    for (const [taskId, interval] of open) {
      if (!scheduling.identityIn(event.data, taskId, interval.attemptId)) continue
      interval.elements.push({ at: event.createdAt, kind: 'event', isClaim: false })
      if (isAttemptCloser(event.type)) { interval.endedAt = Math.min(interval.endedAt ?? event.createdAt, event.createdAt); closedTask = taskId }
    }
    if (closedTask !== undefined) open.delete(closedTask)
  }
  for (const run of runtime.store.toolRuns(missionId)) {
    const interval = byAttempt.get(run.attemptId)
    if (interval === undefined) continue
    interval.elements.push({ at: run.createdAt, kind: 'run', isClaim: false })
  }
  for (const delivery of deliveries) {
    const interval = delivery.attemptId === undefined ? open.get(delivery.taskId ?? '') : byAttempt.get(delivery.attemptId)
    if (interval === undefined) continue
    // The assignment delivery is written in the same transaction as the
    // dispatch: it is the claim, not a report about the attempt.
    interval.elements.push({ at: delivery.createdAt, kind: 'delivery', isClaim: delivery.kind === 'assignment' })
  }
  const escalations = new Map()
  for (const delivery of deliveries) {
    const key = delivery.notice?.dedupKey
    if (typeof key !== 'string') continue
    const attemptId = /^(?:attempt-silent|operation-silent):([^:]+):/.exec(key)?.[1]
    if (attemptId === undefined) continue
    const list = escalations.get(attemptId) ?? []
    list.push(key)
    escalations.set(attemptId, list)
  }
  const reports = []
  const subjects = []
  for (const interval of byAttempt.values()) {
    const task = current.get(interval.taskId)
    const stillCurrent = task?.status === 'running' && task.attempt?.id === interval.attemptId
    const lastDurableAt = interval.elements.reduce((latest, element) => Math.max(latest, element.at), interval.claimedAt)
    // No closer was recorded but the task no longer carries the attempt: the
    // attempt ended at its last durable element, without a report.
    const endedAt = interval.endedAt ?? (stillCurrent ? undefined : lastDurableAt)
    const instants = [...new Set(interval.elements.map(element => element.at))].sort((a, b) => a - b)
    const end = endedAt === undefined ? now : Math.max(endedAt, instants.at(-1) ?? endedAt)
    let worstReportingGapMs = 0
    let previousInstant = interval.claimedAt
    for (const instant of instants) { worstReportingGapMs = Math.max(worstReportingGapMs, instant - previousInstant); previousInstant = instant }
    worstReportingGapMs = Math.max(worstReportingGapMs, end - previousInstant)
    const endedUnreported = endedAt !== undefined && !interval.elements.some(element => !element.isClaim && element.kind !== 'run')
    const attemptEscalations = escalations.get(interval.attemptId) ?? []
    reports.push({
      attemptId: interval.attemptId, taskId: interval.taskId, epoch: interval.epoch, memberId: interval.memberId,
      claimedAt: interval.claimedAt, ...(endedAt === undefined ? {} : { endedAt }), lastDurableAt,
      worstReportingGapMs, silentMs: Math.max(0, end - lastDurableAt), escalations: attemptEscalations, endedUnreported,
    })
    for (const key of attemptEscalations) {
      const delivery = deliveries.find(candidate => candidate.notice?.dedupKey === key)
      const silentSince = Number(key.slice(key.lastIndexOf(':') + 1))
      if (delivery === undefined || !Number.isSafeInteger(silentSince)) continue
      subjects.push({ subject: delivery.subjects?.[0] ?? `${interval.taskId}@${interval.epoch}`, kind: 'attempt', gapMs: Math.max(0, delivery.createdAt - silentSince), boundMs: bounds.attemptMs, at: delivery.createdAt })
    }
  }
  // The released scheduling passes: the durable pass row is the carrier (the
  // once-per-pass overwrite erases per-run detail, so it accumulates the worst).
  const passRelease = runtime.store.get('passes', scheduling.passKey(missionId))
  const worstRelease = passRelease?.worstRelease
  if (worstRelease !== undefined) {
    subjects.push({ subject: `pass:${worstRelease.runId}`, kind: 'scheduling-pass', gapMs: worstRelease.gapMs, boundMs: worstRelease.boundMs, at: worstRelease.releasedAt })
  }
  const worstSubjectSilence = subjects.reduce((worst, item) =>
    worst === undefined || item.gapMs > worst.gapMs || (item.gapMs === worst.gapMs && item.gapMs - item.boundMs > worst.gapMs - worst.boundMs) ? item : worst, undefined)
  const worstAttempt = reports.reduce((worst, report) =>
    worst === undefined || report.worstReportingGapMs > worst.gapMs ? { attemptId: report.attemptId, taskId: report.taskId, gapMs: report.worstReportingGapMs } : worst, undefined)
  return {
    missionId, bounds, subjects, worstSubjectSilence,
    attempts: reports,
    worstAttemptReportingGap: worstAttempt,
    attemptsEnded: reports.filter(report => report.endedAt !== undefined).length,
    attemptsEndedUnreported: reports.filter(report => report.endedUnreported).length,
    attemptSilenceEscalations: subjects.filter(item => item.kind === 'attempt').length,
    passReleases: { count: passRelease?.releases ?? 0, worst: worstRelease },
  }
}
