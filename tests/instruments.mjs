/**
 * Read-only measurement projections over a runtime's durable rows, kept as TEST
 * instruments. Each one lived on the runtime until nothing in src/ read it: the
 * tests were its only caller, so it now lives beside them. Each reads the
 * production classifiers it measures (they stay in src/ because the live
 * notice paths use them) and writes nothing.
 */
import { noticeFamily, taskFromSubject, taskSubject } from '../lib/notices.js'

/** Mirrors `TERMINAL_STATES` in src/notices.ts. */
const TERMINAL_STATES = new Set(['accepted', 'cancelled'])
/** Mirrors `NO_LIVE_PATH_FAMILIES` in src/notices.ts: the families whose claim is "no live path will advance this subject". */
const NO_LIVE_PATH_FAMILIES = new Set(['stall-root', 'fallthrough'])

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
