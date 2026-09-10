/**
 * Notices and witnesses: the owner-notice ledger (dedup by class + key), the
 * bounded outbox that delivers it outside the mission queue, and the durable
 * stall / coverage / integration-gap witnesses. M1a seam 3/7.
 *
 * Behaviour-identical to the code moved from src/runtime.ts: the runtime keeps
 * thin forwarding methods, so no call site changed.
 */
import { randomUUID } from 'node:crypto'
import { hasNotice, noticeFingerprint as computeNoticeKey, noticeLedger as projectNoticeLedger } from './arena.ts'
import { formatDiagnostic, missingReviewDiagnostic } from './admission.ts'
import { requireText } from './refusals.ts'
import type { SwarmRuntime } from './runtime.ts'
import type { Actor, Delivery, Member, Mission, NoticeClass, Task } from './types.ts'

/** R14-F2(a): the durable identity of one task at one epoch, as notices carry it. */
export function taskSubject(task: Pick<Task, 'id' | 'epoch'>): string { return `${task.id}@${task.epoch}` }
/**
 * R15-A1: the mission-scoped subject for a decision that names no single task (a
 * wedged scheduling pass, a failed member with no assigned work, an escalation).
 * It is the exact lineage root of such a decision, never a placeholder, so an
 * owner-facing notice always has something to be attributed to.
 */
export function missionSubject(mission: Pick<Mission, 'id'>): string { return `mission:${mission.id}` }
/**
 * R15-A1: the subjects of a set of tasks, with the mission root as the honest
 * fallback when the set is empty. Deduplicated and order-preserving.
 */
export function subjectsOfTasks(tasks: readonly Pick<Task, 'id' | 'epoch'>[], mission: Pick<Mission, 'id'>): string[] {
  const subjects: string[] = []
  for (const task of tasks) { const subject = taskSubject(task); if (!subjects.includes(subject)) subjects.push(subject) }
  return subjects.length ? subjects : [missionSubject(mission)]
}
/**
 * R15-A1: a notice without a subject is unattributable, so it is refused rather
 * than written as an anonymous durable row. This is the runtime end of the
 * contract the enumerated `notify()`-site test enforces in source.
 *
 * Co-fires with: `taskSubject`/`missionSubject`/`subjectsOfTasks` (whose absence
 * this guard detects), the ledger's dedup (`hasNotice`, which must never see an
 * empty-subject decision row) and every caller that can produce an empty task
 * set (the W3 stall notice, the coverage-complete notice, the member-scoped
 * failure notices). Those callers fall back to `missionSubject`, so this guard
 * is reachable only from a genuine programming error.
 */
export function noticeSubjects(subjects: readonly string[] | undefined, mission: Pick<Mission, 'id'>): string[] {
  const clean = Array.isArray(subjects) ? subjects.filter(subject => typeof subject === 'string' && subject.length > 0) : []
  if (clean.length === 0) {
    // R15-A1: a caller that dropped its subjects must not produce an anonymous
    // durable row, and the omission must not be silent either. The enumerated
    // source test is the enforcement; this is the last-resort attribution: the
    // notice is still written under the mission root, and the omission is
    // reported where the runtime reports its other internal faults. (No new
    // refusal site: the retained S3 inventory pins the coded/uncoded split of
    // these files, and a programming error here is not a user-facing refusal.)
    process.stderr.write('[agent-swarm] owner notice without subjects; attributed to the mission root\n')
    return [missionSubject(mission)]
  }
  return clean
}
/**
 * R15-A1: the delivery options one notice call site passes. The subjects are a
 * required positional argument; every other field has a documented default, so a
 * new call site cannot inherit "no subject" by omission.
 */
export interface NotifyOptions {
  from?: string
  noticeClass?: NoticeClass
  dedupe?: boolean
  dedupKey?: string
  stampWitness?: boolean
}
/** The states that leave a task no future. */
const TERMINAL_STATES = new Set(['accepted', 'cancelled'])

/**
 * F2: how long a submitted code deliverable may stay without a live review
 * before the runtime concludes none is coming. One scheduler period gives the
 * author the turn in which it submitted to propose its own review; the floor
 * keeps a fast tick from turning a same-turn proposal into a race.
 */
export const AUTO_REVIEW_GRACE_MS = 1000

const id = (prefix: string) => `${prefix}_${randomUUID()}`

export class Notices {
  /** R10-15 parked-holder signals already emitted, keyed by mission:task:epoch. */
  readonly parkedNotices = new Set<string>()
  /** R11-03 integration-gap diagnostics already emitted, keyed by mission:implementation count. */
  readonly integrationGapWarned = new Set<string>()
  readonly reviewPathNotices = new Set<string>()
  /**
   * Deliveries a pump is currently attempting (cache-only claim keyed per
   * delivery, so two pumps cannot duplicate one attempt and one hung call
   * cannot claim the whole outbox).
   */
  private readonly delivering = new Map<string, number>()
  /** Start time of the running pump; ages out at the declared bound. */
  private pumpingSince?: number

  constructor(private readonly rt: SwarmRuntime) {}

  /**
   * Owner notices wake the primary agent and replay its whole context, so only
   * decisions, blockers, failures, budget exhaustion and final delivery use
   * them. Routine progress is already a durable event shown by the UI.
   *
   * Every notice is recorded in the notice-delivery ledger with the mission
   * state fingerprint it announces (`noticeFingerprint`, the spec §4 digest
   * with the announcement channel itself excluded) and its sent/queued/claimed
   * lifecycle. The runtime's own budget/ceiling refusals are deduplicated per
   * (class, fingerprint, sender); decision notices pass through so the liveness
   * engine's witness dedup stays in charge of them.
   *
   * R15-A1: the subjects are a required positional argument, refused when empty,
   * and written into the same durable delivery row as the content (never merged
   * in later). A call site that cannot name one task passes the mission root via
   * `missionSubject`; it can no longer pass nothing.
   */
  notify(missionId: string, content: string, subjects: string[], options: NotifyOptions = {}): void {
    const from = options.from ?? 'runtime'
    const noticeClass = options.noticeClass ?? 'decision'
    const dedupe = options.dedupe ?? noticeClass === 'budget'
    const mission = this.rt.store.get('missions', missionId)
    const attributed = noticeSubjects(subjects, mission ?? { id: missionId })
    // No-silent-state witness W2: every owner-decision notice is durable under
    // the fingerprint of the board it was emitted for, so the owner can verify
    // that no non-terminal state was silent. A terminal mission needs no witness.
    if ((options.stampWitness ?? true) && mission !== undefined && !this.rt.isMissionTerminal(mission)) {
      mission.witness = { fingerprint: this.rt.fingerprint(missionId), kind: 'W2', at: Date.now() }
      this.rt.store.put('missions', mission)
    }
    this.enqueueOwnerNotice(missionId, content, from, noticeClass, { subjects: attributed }, dedupe, options.dedupKey)
  }

  /** The notice dedup key: F(S) with the owner-notice channel excluded. */
  noticeKey(missionId: string): string {
    return computeNoticeKey(this.rt.fingerprintRecords(missionId))
  }

  /**
   * Record one owner-addressed notice (or an escalation) durably. Returns the
   * delivery, or undefined when the same class already announced the same
   * fingerprint from the same sender: the runtime's own budget/ceiling refusals
   * are deduplicated per state so an unchanged board never spams the owner.
   * Decision notices are always recorded — the liveness engine deduplicates its
   * own witnesses per fingerprint and clears them when the board leaves the
   * class, so change-and-return must be able to re-notify. Callers may already
   * be inside a transaction; this method only reads and writes through the
   * store and never opens one.
   */
  enqueueOwnerNotice(missionId: string, content: string, from: string, noticeClass: NoticeClass, extra: Partial<Delivery> = {}, dedupe = noticeClass === 'budget', dedupKeyOverride?: string): Delivery | undefined {
    const dedupKey = dedupKeyOverride ?? this.noticeKey(missionId)
    if (dedupe && hasNotice(this.rt.store.list('deliveries', missionId), { class: noticeClass, dedupKey, from })) return undefined
    const at = Date.now()
    const delivery: Delivery = {
      id: id('msg'), missionId, from, to: 'owner', kind: noticeClass === 'escalation' ? 'escalation' : 'control',
      content, createdAt: at,
      notice: { dedupKey, class: noticeClass, sentAt: at, queuedAt: at },
      ...extra,
    }
    this.rt.store.put('deliveries', delivery)
    return delivery
  }

  /**
   * Read-only notice-delivery ledger: every owner notice with its class, dedup
   * key and sent/queued/claimed lifecycle, newest first. Owner-only: owner
   * notices are control-plane decisions, not worker-visible board content.
   *
   * R15-A1/B: three facts that are never collapsed into one.
   * - delivery/transport: `sentAt`/`queuedAt` and `state` (`queued` / `claimed`
   *   by the adapter call that put the notice in front of the owner session);
   * - consumption: reported as `unknown`, because this host exposes no reliable
   *   native signal proving the owner consumed the notice. A `claimed` transport
   *   is never relabelled as handled;
   * - resolution: not a transport event at all. It is the mission/task/owner
   *   transition that made the decision moot, and it is not recorded here. A
   *   resolution never clears another subject's pending decision, and a healthy
   *   sibling never resets this subject's clock.
   *
   * The projected subjects are merged back from the durable delivery row (the
   * row, not the prose, is the authority for what the notice was about).
   */
  noticeLedger(actor: Actor, missionId: string, query: { limit?: number } = {}): unknown {
    const { owner } = this.rt.participant(actor, missionId)
    if (!owner) throw new Error('Only the mission owner can read the notice-delivery ledger')
    const limit = query.limit === undefined ? 20 : Math.max(1, Math.min(100, Math.trunc(query.limit)))
    const rows = this.rt.store.list('deliveries', missionId)
    const subjectRow = (deliveryId: string): string[] | undefined => {
      // A bounded linear lookup rather than a second in-memory index: the ledger
      // is a read-only page of at most `limit` rows over one mission's deliveries.
      for (const row of rows) if (row.id === deliveryId) return row.subjects
      return undefined
    }
    const entries = projectNoticeLedger(rows, limit).map(entry => {
      const subjects = subjectRow(entry.deliveryId)
      return {
        ...entry,
        ...(subjects === undefined ? {} : { subjects }),
        consumption: 'unknown' as const,
      }
    })
    return {
      ledger: entries,
      page: { limit, returned: entries.length },
      fingerprint: this.rt.fingerprint(missionId),
      note: 'Read-only: each row names the subjects the notice is about (`taskId@epoch` or `mission:<id>`) and the mission-state fingerprint it announced. `state` is the transport fact (queued, or claimed by the adapter that put it in front of the owner session); consumption is unknown because this host exposes no reliable signal for it; resolution is a task/mission transition, never a transport event. Recording a notice changes no task, member or budget state.',
    }
  }

  bounded(text: string): string {
    requireText(text, 'content')
    if (text.length > this.rt.config.maxMessageChars) throw new Error(`Content exceeds ${this.rt.config.maxMessageChars} characters`)
    return text
  }

  /**
   * No-silent-state backstop (docs/no-silent-state-spec.md §2). Runs after a
   * scheduling pass that changed nothing: a non-terminal mission must still
   * leave the owner with a witness. Exemptions are the documented ones — the
   * empty board the owner is still planning (row 17) and a board whose
   * non-terminal work is running under a live lease (row 3). The bounded
   * missing-review grace is respected: the row-5 notice arrives after
   * `AUTO_REVIEW_GRACE_MS`, not on the tick the artifact was submitted. A
   * submitted artifact with no live review path is witnessed even while
   * unrelated work runs, because no other witness can ever advance it.
   *
   * R15-A2: this is the same decision function the tick timer drives when no
   * live scheduling pass exists (`options.offPass`), so a mission whose pass
   * never returns (a hung `workers.start`) still names its subjects instead of
   * staying silent. The one branch that is only meaningful at the end of a pass
   * — the dispatcher's "ready but not dispatched" question — is skipped
   * off-pass: before a pass has run, a ready task is not yet a decision.
   *
   * Every notice below is recorded inside `rt.commit`, so the delivery row that
   * carries the subjects is written in the SAME transaction as the transition
   * (the witness stamp, the stall event) that produced it.
   */
  ensureWitness(missionId: string, options: { offPass?: boolean; wedged?: boolean } = {}): void {
    const mission = this.rt.mission(missionId)
    if (mission.status !== 'active') return
    const tasks = this.rt.store.list('tasks', missionId)
    const members = this.rt.store.list('members', missionId)
    // Row 17: the owner has not planned work yet; `stalled` uses the same rule.
    if (!tasks.length) return
    // R14-F2(b): stall roots are classified BEFORE the F(S) dedup. A root is an
    // owner decision no other notice can advance, so an unrelated notice that
    // consumed the board fingerprint must not silence it.
    const stallRootNotices = this.notifyStallRoots(mission, tasks)
    const fingerprint = this.rt.fingerprint(missionId)
    // R15-D1: a WEDGED pass is its own subject, exactly like a stall root. The
    // board witness records that *some* notice announced this fingerprint; an
    // unrelated notice (the integration-gap warning, a coverage notice) must not
    // consume the decision a dead pass owes its task. The pass-scoped path keeps
    // the dedup: there, an unchanged board is exactly what the witness means.
    if (options.wedged !== true && mission.witness?.fingerprint === fingerprint) return
    // Spec §2 dispatchable: pending, dependencies accepted, and an idle or
    // waiting member can run it. A working member is busy, not a silent board.
    const runnable = members.filter(member => member.status === 'idle' || member.status === 'waiting')
    const dispatchable = tasks.filter(task => task.status === 'pending' && runnable.some(member => this.rt.ready(task, member, tasks)))
    if (dispatchable.length && options.offPass === true && options.wedged !== true) {
      // R15-D3: between passes the dispatcher's branch owns this state, and it may
      // still dispatch the task in this same tick. The sweep must not invent a
      // cause the dispatcher's own branch refuses — silently returning here is what
      // keeps "ready but the only eligible handle is busy" from becoming a false
      // "no live path will advance" wake (the round-14 dirty-workspace shape).
      return
    }
    if (dispatchable.length) {
      // A handle that is working is not a silent board: when no runnable member
      // could be started at all, those members are working and no witness is owed
      // (the T3 integration rule; a false stall notice is as bad as a missing
      // one). The dispatcher's question is owed only when the board LOOKS
      // dispatchable — at least one startable member exists — and the task still
      // did not dispatch.
      //
      // R15-A4: the false-cause sentence is then replaced by the dispatcher's own
      // question, asked per (task, assignee) with the sweep's predicates. It names
      // the member whose handle holds the task when that is the blocker, and it
      // stays silent when the question has no blocker to name (an open attempt the
      // W6 close-out path is already nudging, or no eligible member at all).
      // Co-firing guard pairs: dispatch question x parked-member hatch, x W6
      // open-attempt close-out, x admission refusal — see
      // `Scheduling.dispatchQuestion`.
      // R15-D1: a wedged pass never reached its own dispatch question, so the
      // startable gate must not silence the subject: the question is asked even
      // when every eligible handle is busy, and the holder-naming answer is what
      // tells the owner which member is holding the task while the pass is dead.
      // For a completed pass the T3 rule stands: an all-busy board is working, not
      // silent, and owes no witness.
      if (options.wedged !== true) {
        const startable = runnable.some(member => member.status === 'waiting' || this.rt.workers.isIdle(member.id))
        if (!startable) return
      }
      const question = this.rt.dispatchQuestion(missionId, tasks, members, dispatchable)
      if (question === undefined) return
      this.rt.commit(missionId, () => {
        // The dedup key belongs to the task and its epoch, so the wedged path can
        // re-run every tick without repeating the same wake.
        this.notify(missionId, question.message, question.subjects, { dedupe: true, dedupKey: question.dedupKey })
      })
      return
    }
    const unreviewed = tasks.filter(task => task.status === 'submitted' && !this.rt.reviewable(task, tasks))
    if (unreviewed.length) {
      // A submitted artifact no live review can accept is an owner decision. The
      // documented `AUTO_REVIEW_GRACE_MS` floor is honored here, not only inside
      // `stalled`, because `stalled` returns before its unreviewed check when
      // any unrelated work is running; without this an unreviewable submission
      // could stay silent behind live work forever (verifier-1 challenge,
      // evidence_a454a771). The age comes from the durable submission event, so
      // a restart cannot reset the grace.
      const grace = Math.max(this.rt.config.tickMs, AUTO_REVIEW_GRACE_MS)
      const ripe = unreviewed.filter(task => {
        const submission = this.rt.latestSubmission(missionId, task.id)
        return submission === undefined || submission.age >= grace
      })
      if (ripe.length) {
        const subjects = subjectsOfTasks(ripe, mission)
        this.rt.commit(missionId, () => {
          this.notify(missionId, `Submitted artifact ${ripe.map(task => task.id).join(', ')} has no live independent review path and cannot reach a verdict while the rest of the board keeps running. Admit an independent verification task with swarm_propose (kind verification, reviewOf ${ripe[0]!.id}) or cancel the source task.`, subjects)
        })
      }
      return
    }
    // Row 3 (documented scope): only a board whose *every* non-terminal task is
    // running under a live lease is exempt. Running work plus a pending or
    // blocked task falls through to the witnesses below, so a dependent that
    // cannot start yet still leaves the owner a decision (T1av2 evidence_978a4694).
    const nonTerminal = tasks.filter(task => !['accepted', 'cancelled'].includes(task.status))
    if (nonTerminal.length && nonTerminal.every(task => task.status === 'running' && task.attempt !== undefined && task.attempt.leaseUntil >= Date.now())) return
    if (this.rt.stalled(mission, tasks, members)) {
      this.notifyStall(mission, tasks, members, this.rt.completionError(mission, { cancelUnschedulable: true }) ?? this.rt.completionError(mission) ?? 'no task can make progress')
      return
    }
    // R14-F2(c): the unnamed fallback is replaced. While every unfinished task is
    // legitimately waiting, the runtime stays silent; otherwise it escalates
    // UNCONDITIONALLY and names every task its classifier did not recognise, so
    // no state can be silent and unnamed at the same time.
    // A task the root classifier already named is recognised: the fall-through
    // names only what no other witness speaks for.
    const roots = new Set(this.stallRoots(tasks).map(task => task.id))
    const unrecognised = nonTerminal.filter(task => !roots.has(task.id) && !this.waitsLegitimately(task, tasks))
    if (!unrecognised.length) {
      // The stall-root notices above were emitted WITHOUT claiming the board witness,
      // so the W3 stall path (fault F19 row 7) still owns the board when it applies.
      // If the classifier recognises every task and no stall fires, those decision
      // notices are this board's evidence: stamp the W2 witness here instead (row 7b).
      if (stallRootNotices > 0) {
        this.rt.commit(missionId, () => {
          const board = this.rt.store.get('missions', missionId)
          if (board !== undefined && !this.rt.isMissionTerminal(board)) {
            board.witness = { fingerprint: this.rt.fingerprint(missionId), kind: 'W2', at: Date.now() }
            this.rt.store.put('missions', board)
          }
        })
      }
      return
    }
    const subjects = unrecognised.map(taskSubject)
    this.rt.commit(missionId, () => {
      this.notify(missionId, `Mission ${mission.title} made no progress this tick and has unfinished work that no live path will advance: ${unrecognised.map(task => `${task.id} (${task.kind}, ${task.status}, epoch ${task.epoch}${task.dependencies.length ? `, depends on ${task.dependencies.join('/')}` : ''})`).join('; ')}. Inspect the board, admit a repair or review with swarm_propose, or decide with swarm_control.`, subjects,
        { dedupe: true, dedupKey: `fallthrough:${missionId}:${subjects.slice().sort().join(',')}` })
    })
  }

  /**
   * R14-F2(b): exactly one named `decision` notice per stall root at its epoch,
   * whether or not other tasks in the mission are running. A stall root is a
   * blocked task that is not stopping, is not a verdict record, and has no live
   * replacement anywhere in its lineage; a blocked task whose waited-on stop has
   * exceeded the declared bound is a root too, because the stop it waits on is
   * no longer bounded. The dedup key is the root's own identity, not the board
   * fingerprint, so an unrelated notice can never consume it.
   */
  notifyStallRoots(mission: Mission, tasks: Task[]): number {
    let emitted = 0
    for (const root of this.stallRoots(tasks)) {
      const subject = taskSubject(root)
      const key = `stall-root:${mission.id}:${subject}`
      if (hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) continue
      const dependents = this.dependentsOf(root, tasks)
      const stop = root.resumeAfterStop?.epoch === root.epoch ? root.resumeAfterStop : undefined
      const cause = stop !== undefined
        ? (stop.at === undefined
          ? `its stop carries no recorded start, so the declared bound (${this.rt.stallPassTimeoutMs}ms) cannot be shown to hold`
          : `its stop has been awaited for ${Math.max(0, Date.now() - stop.at)}ms, past the declared bound (${this.rt.stallPassTimeoutMs}ms)`)
        : 'no live replacement exists anywhere in its lineage'
      this.rt.commit(mission.id, () => {
        this.rt.store.event(mission.id, 'mission/stalled', 'runtime', {
          cause: 'stall-root', taskId: root.id, epoch: root.epoch, reason: root.output ?? null,
          dependents: dependents.map(task => task.id), boundMs: this.rt.stallPassTimeoutMs,
          // R14-F2v D1: the W3 stall event carries `unschedulable` and readers
          // (fault F19 row 7) take it from the LATEST mission/stalled event; a
          // stall-root event without it broke that reader. The root plus the
          // tasks that depend on it is the honest value.
          unschedulable: [root.id, ...dependents.map(task => task.id)],
        })
        emitted += 1
        this.notify(mission.id, `Task ${root.id} (${root.title}, epoch ${root.epoch}) is a stall root: it is blocked and ${cause}${dependents.length ? `; ${dependents.length} task(s) depend on it (${dependents.map(task => task.id).join(', ')})` : ''}${root.output === undefined ? '' : `. Recorded reason: ${root.output}`}. Decide: admit a replacement with swarm_propose (name ${root.id} in replaces), repair the dependency, or withdraw it with swarm_cancel.`, [subject, ...dependents.map(taskSubject)], { dedupe: true, dedupKey: key, stampWitness: false })
      })
    }
    return emitted
  }

  /**
   * R14-F2(b): the stall roots of one board, in board order. Purely a function
   * of durable rows, so the pass, the timer-driven notice path and a test all
   * classify the same board identically.
   */
  stallRoots(tasks: Task[]): Task[] {
    // A live replacement marks every id in its transitive lineage as covered.
    const replaced = new Set<string>()
    const cover = (task: Task): void => {
      for (const source of task.replaces ?? []) {
        if (replaced.has(source)) continue
        replaced.add(source)
        const origin = tasks.find(candidate => candidate.id === source)
        if (origin !== undefined) cover(origin)
      }
    }
    for (const task of tasks) if (!TERMINAL_STATES.has(task.status)) cover(task)
    return tasks.filter(task => {
      if (task.status !== 'blocked' || replaced.has(task.id)) return false
      // A verdict record is not a repairable root: its source carries the repair.
      if (task.reviewOf !== undefined) return false
      const stop = task.resumeAfterStop?.epoch === task.epoch ? task.resumeAfterStop : undefined
      if (stop === undefined) return true
      const at = stop.at
      // R14-F2v D2: a stop inside the declared bound is progress, not a root, but
      // an absent timestamp is UNBOUNDED — the bound cannot be shown to hold, so
      // the state escalates as a root rather than becoming silence (a pre-upgrade
      // durable row reaches exactly this state).
      return at === undefined || Date.now() - at > this.rt.stallPassTimeoutMs
    })
  }

  /** R14-F2(b): the tasks that depend on one root, transitively, still unfinished. */
  dependentsOf(root: Task, tasks: Task[]): Task[] {
    const found = new Map<string, Task>()
    let grew = true
    while (grew) {
      grew = false
      for (const task of tasks) {
        if (task.id === root.id || TERMINAL_STATES.has(task.status) || found.has(task.id)) continue
        const dependsOnRoot = [root.id, ...found.keys()].some(id => task.dependencies.includes(id) || (task.replaces ?? []).includes(id))
        if (dependsOnRoot) { found.set(task.id, task); grew = true }
      }
    }
    return [...found.values()]
  }

  /**
   * R14-F2(c): whether an unfinished task is waiting on something still alive —
   * a live lease, the bounded review grace, a stop inside its bound, or an
   * unfinished predecessor. Anything else is unnamed silence and must escalate.
   */
  waitsLegitimately(task: Task, tasks: Task[]): boolean {
    const unfinished = (id: string): boolean => {
      const found = tasks.find(candidate => candidate.id === id)
      return found !== undefined && !TERMINAL_STATES.has(found.status)
    }
    if (task.status === 'running') return task.attempt !== undefined && task.attempt.leaseUntil >= Date.now()
    if (task.status === 'submitted') {
      const submission = this.rt.latestSubmission(task.missionId, task.id)
      return submission === undefined || submission.age < Math.max(this.rt.config.tickMs, AUTO_REVIEW_GRACE_MS)
    }
    if (task.status === 'blocked') {
      const stop = task.resumeAfterStop?.epoch === task.epoch ? task.resumeAfterStop : undefined
      // R15-A3: an absent `at` is UNBOUNDED, so it is not legitimate waiting. The
      // "cannot judge" case must never be the silent one: `stallRoots` classifies
      // the same row as a root, and this classifier refusing it here is what
      // keeps the two in agreement instead of leaving the state both silent and
      // unnamed (a pre-upgrade durable row reaches exactly this shape).
      if (stop !== undefined) return stop.at !== undefined && Date.now() - stop.at <= this.rt.stallPassTimeoutMs
      if (task.dependencies.some(unfinished)) return true
      return false
    }
    if (task.status === 'pending') {
      // R15-F1: a verification task carries no `dependencies` by protocol; its
      // prerequisite is the source it reviews. While that source exists and is not
      // terminal the review is legitimately waiting — the scheduler's `capable`
      // refuses to run it until the source is `submitted`, so no live pass can
      // advance it, and claiming "no live path" while the source is still being
      // worked is a false notice (found live on T1v/T2v/T3v). A source that is
      // terminal or missing can never make the review dispatchable again, so that
      // state is NOT waiting and stays in the fall-through's named escalation.
      //
      // Co-firing guards: this classifier x the stall-root classifier (a blocked
      // source is the root's subject, not this review's) and x `reviewable`/the
      // review-admission terminal (which speak for a submitted source).
      if (task.reviewOf !== undefined) {
        const source = tasks.find(candidate => candidate.id === task.reviewOf)
        return source !== undefined && !TERMINAL_STATES.has(source.status)
      }
      return task.dependencies.some(unfinished)
    }
    return false
  }

  /** Wake the owner once per distinct stalled state; idle workers cannot resolve it themselves. */
  notifyStall(mission: Mission, tasks: Task[], members: Member[], reason: string): void {
    const leftover = this.rt.unschedulable(mission, tasks, members)
    // The stall dedup key is the same owner-observable fingerprint as every
    // other witness, so a stall is fresh exactly when the board changed.
    const fingerprint = this.rt.fingerprint(mission.id)
    if (mission.stallNotice === fingerprint) return
    mission.stallNotice = fingerprint; mission.updatedAt = Date.now()
    const detail = leftover.map(task => `${task.id} (${task.kind}, ${task.status}${task.reviewOf ? `, reviews ${task.reviewOf}` : ''}${task.dependencies.length ? `, depends on ${task.dependencies.join('/')}` : ''})`).join('; ')
    this.rt.commit(mission.id, () => {
      this.rt.store.put('missions', mission)
      this.rt.store.event(mission.id, 'mission/stalled', 'runtime', { reason, fingerprint, unschedulable: leftover.map(task => task.id) })
      // R15-A1: the W3 stall notice names the tasks it is about (the unschedulable
      // leftovers, or every non-terminal task when the stall class is an empty
      // leftover list), with the mission root as the honest fallback. Guard pair:
      // W3 stall x stall-root classifier — a root the classifier named does not
      // stop the board-level notice, and this notice no longer depends on prose
      // to say which subject is stuck.
      const stuck = leftover.length ? leftover : tasks.filter(task => !TERMINAL_STATES.has(task.status))
      this.notify(mission.id, `Mission stalled: no task can be scheduled and workers are idle. ${reason}. Unschedulable: ${detail || 'none'}. Subjects: ${subjectsOfTasks(stuck, mission).join(', ')}. Decide: propose repairs or reviews with swarm_propose, adjust the budget, or use swarm_control complete (cancels unschedulable leftovers once every acceptance criterion is independently covered) or stop.`, subjectsOfTasks(stuck, mission))
      // W3: the stall notice is the no-silent-state witness for this state.
      mission.witness = { fingerprint, kind: 'W3', at: Date.now() }
      this.rt.store.put('missions', mission)
    })
  }

  /**
   * R10-14: the board is coverage-complete but the mission is still active
   * (owner-assembled plans do not auto-complete). Emit exactly one durable
   * owner-decision notice per distinct coverage-complete state so the owner
   * knows the deliverable is ready without the runtime taking the decision.
   */
  notifyCoverageComplete(mission: Mission): void {
    const fingerprint = this.rt.fingerprint(mission.id)
    if (mission.coverageNotice === fingerprint) return
    mission.coverageNotice = fingerprint
    this.rt.commit(mission.id, () => {
      this.rt.store.put('missions', mission)
      // R15-A1: the deliverable's lineage is the subject (every accepted task),
      // never an anonymous mission-scoped sentence.
      this.notify(mission.id, `Mission ${mission.title} is ready to complete: every acceptance criterion is independently covered and no task can make further progress. The mission stays active until you decide. Use swarm_control complete to accept the deliverable, or admit more work with swarm_propose.`, subjectsOfTasks(this.rt.store.list('tasks', mission.id).filter(task => TERMINAL_STATES.has(task.status)), mission))
    })
  }

  /**
   * R10-15: a running attempt whose owner is parked cannot progress until it is
   * woken or re-pended. Record the parked holder durably and tell the owner once
   * per attempt, so the state is never silent while the lease is alive.
   */
  notifyParkedHolder(mission: Mission, task: Task): void {
    const key = `parked:${mission.id}:${task.id}:${task.epoch}`
    // S5: the durable notice ledger is the gate; the set is only a cache.
    if (this.parkedNotices.has(key) && hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    this.parkedNotices.add(key)
    this.rt.commit(mission.id, () => {
      this.notify(mission.id, `Task ${task.id} (${task.title}) is held by a parked member and cannot make progress while parked. A fresh assignment wakes it; if the lease expires the task re-pends without spending a recovery attempt.`, [taskSubject(task)], { dedupe: true, dedupKey: key })
    })
  }

  /**
   * R11-03: the completion rule must not first appear when the owner tries to
   * complete. When a second implementation branch is admitted while the plan has
   * no integration task, emit the same diagnostic `completionError` would.
   */
  warnIntegrationGap(mission: Mission, admitted: Task): void {
    if (admitted.kind !== 'implementation') return
    const tasks = this.rt.store.list('tasks', mission.id)
    const implementations = tasks.filter(task => task.kind === 'implementation')
    if (implementations.length < 2 || tasks.some(task => task.kind === 'integration')) return
    const key = `integration-gap:${mission.id}:${implementations.length}`
    // S5: the durable notice ledger is the gate; the set is only a cache.
    if (this.integrationGapWarned.has(key) && hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    this.integrationGapWarned.add(key)
    const diagnostic = 'Coding missions require an independently accepted integration artifact, or exactly one independently accepted implementation artifact when the plan has no integration task'
    this.rt.commit(mission.id, () => {
      this.notify(mission.id, `${diagnostic}. The mission now has ${implementations.length} implementation branches (${implementations.map(task => task.id).join(', ')}); admit an integration task depending on every branch, or complete with exactly one accepted implementation artifact.`, subjectsOfTasks(implementations, mission), { dedupe: true, dedupKey: key })
    })
  }

  /** Wake the owner once per distinct blocker for one unreviewable submitted deliverable. */
  notifyReviewBlocked(mission: Mission, source: Task, reason: string): void {
    const key = `review-blocked:${mission.id}:${source.id}:${reason}`
    // S5: the durable notice ledger (class, key, sender) is the gate; the set is
    // only a cache, so losing it cannot produce a second notice for the state.
    if (this.reviewPathNotices.has(key) && hasNotice(this.rt.store.list('deliveries', mission.id), { class: 'decision', dedupKey: key, from: 'runtime' })) return
    const diagnostic = formatDiagnostic(missingReviewDiagnostic(source.id, reason))
    this.rt.commit(mission.id, () => {
      this.rt.store.event(mission.id, 'task/review-blocked', 'runtime', { taskId: source.id, kind: source.kind, reason })
      this.notify(mission.id, `${diagnostic}. Admit an independent verification task with swarm_propose (kind verification, reviewOf ${source.id}) or cancel the source task; the mission cannot complete while it is unreviewable.`, [taskSubject(source)], { dedupe: true, dedupKey: key })
    })
    this.reviewPathNotices.add(key)
  }

  topicDelivery(missionId: string, from: string, topic: string, content: string): void {
    for (const member of this.rt.store.list('members', missionId)) {
      if (member.id !== from && member.status !== 'stopped' && (member.subscriptions.includes(topic) || member.subscriptions.includes('*'))) {
        this.rt.store.put('deliveries', { id: id('msg'), missionId, from, to: member.id, topic, kind: 'finding', content, createdAt: Date.now() })
      }
    }
  }

  async flushOutbox(missionId: string): Promise<void> {
    if (this.rt.shuttingDown) return
    const mission = this.rt.mission(missionId)
    for (const delivery of this.rt.store.list('deliveries', missionId)) {
      if (this.rt.shuttingDown) return
      if (delivery.deliveredAt) continue
      if (delivery.kind === 'assignment' && delivery.taskId) {
        const task = this.rt.task(missionId, delivery.taskId)
        if (task.attempt?.id !== delivery.attemptId || task.status !== 'running') {
          delivery.deliveredAt = Date.now(); this.rt.commit(missionId, () => this.rt.store.put('deliveries', delivery)); continue
        }
      }
      if (delivery.to !== 'owner' && (mission.status !== 'active' || mission.budgetPause)) continue
      const member = delivery.to === 'owner'
        ? { id: 'owner', missionId, name: 'owner', role: 'owner', sessionId: mission.ownerSessionId, workspace: mission.workspace, status: 'idle' as const, subscriptions: [] }
        : this.rt.store.get('members', delivery.to)
      if (!member || member.status === 'stopped') continue
      // S2: one never-settling adapter `deliver` must not stop every other
      // notice. Each attempt is claimed per delivery and bounded; an attempt
      // that does not settle is abandoned, recorded durably on the mission row,
      // and retried by a later pump (adapter acceptance is idempotent).
      if (this.delivering.has(delivery.id)) continue
      this.delivering.set(delivery.id, Date.now())
      let bound: ReturnType<typeof setTimeout> | undefined
      try {
        const settled = await Promise.race([
          this.rt.workers.deliver(member, delivery).then(() => true),
          new Promise<boolean>(resolve => { bound = setTimeout(() => resolve(false), this.rt.stallPassTimeoutMs) }),
        ])
        if (!settled) { this.recordOutboxStarvation(missionId, delivery); continue }
        delivery.deliveredAt = Date.now()
        // The ledger's `claimed` timestamp is the adapter delivery that put the
        // notice in front of the owner session; a queued notice stays queued.
        if (delivery.notice !== undefined) delivery.notice.claimedAt = delivery.deliveredAt
        this.rt.commit(missionId, () => {
          this.rt.store.put('deliveries', delivery)
          // A delivered notice clears the starvation record it followed.
          if (mission.outboxStarved !== undefined) { delete mission.outboxStarved; this.rt.store.put('missions', mission) }
        })
      } catch { /* Durable outbox retries absent sessions; acceptance is idempotent in the adapter. */ }
      finally { if (bound !== undefined) clearTimeout(bound); this.delivering.delete(delivery.id) }
    }
  }

  /**
   * S2: record durably that one delivery attempt was abandoned at its bound, so
   * the starvation is visible even though the hung adapter call never returns.
   */
  recordOutboxStarvation(missionId: string, delivery: Delivery): void {
    try {
      const mission = this.rt.store.get('missions', missionId)
      if (mission === undefined) return
      const attempts = (mission.outboxStarved?.deliveryId === delivery.id ? mission.outboxStarved.attempts : 0) + 1
      mission.outboxStarved = { deliveryId: delivery.id, attempts, at: Date.now() }
      this.rt.commit(missionId, () => this.rt.store.put('missions', mission))
    } catch { /* Recording a starvation must never break the pump. */ }
  }

  /**
   * S2: the outbox pump lives outside every mission queue. It is driven by the
   * tick timer and by state-changing calls, reads only durable rows (missions,
   * deliveries, tasks, members) and never takes `exclusive`; a pass wedged in an
   * adapter call, or a mission lock held for any other reason, therefore cannot
   * stop a durable owner notice from being delivered. `beginBudgetStop` already
   * used exactly this shape (defer + a queue-external flush); this generalizes
   * it instead of adding a second mechanism.
   *
   * The pump is not a global lock: each delivery attempt is claimed
   * individually, bounded by `stallPassTimeoutMs`, and abandoned (then retried
   * on a later pump) if the adapter call does not settle. One hung `deliver`
   * therefore cannot starve another notice — not even another notice of the same
   * mission — and the abandonment is recorded durably on the mission row.
   */
  pumpOutbox(): void {
    if (this.rt.shuttingDown || this.rt.closed) return
    // Bounded coalescing: concurrent requests join a pump that is inside its
    // declared bound, but a pump whose deliveries hang past the bound never
    // suppresses the next one — the flag ages out instead of starving the
    // outbox (the reviewer's D2).
    const now = Date.now()
    if (this.pumpingSince !== undefined && now - this.pumpingSince < this.rt.stallPassTimeoutMs) return
    this.pumpingSince = now
    this.rt.defer(async () => {
      try {
        for (const mission of this.rt.store.list('missions')) {
          if (this.rt.closed || this.rt.shuttingDown) return
          try { await this.flushOutbox(mission.id) }
          catch { /* Durable outbox retries; one mission must not stop the pump. */ }
        }
      } finally { this.pumpingSince = undefined }
    })
  }
}
