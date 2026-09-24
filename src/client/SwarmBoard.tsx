import { createContext, memo, useContext, useMemo, useState, type ReactNode } from 'react'
import type { Snapshot, Task, Evidence, Member, UsageBuckets } from '../types.ts'
import { LANES, activityGroups, boardIndex, cancellationNotes, compactNumber, durableVerdicts, evidenceCounts, eventSummary, remainingPercent, retiredReviewsBySource, shortId, type BoardIndex, type BoardLane, type CancellationKind, type CancellationNote, type DurableVerdict, type RetiredReview } from './projection.ts'
import { leaseExpired, useVisibleClock } from './clock.ts'
import { DependencyGraph } from './DependencyGraph.tsx'
import { useCopy } from './locale.tsx'
import { memberActivity, taskReasons, type ConnectionState } from './progress.ts'
import { AgentAvatar } from './AgentAvatar.tsx'
import { MissionOverview } from './LiveWorkPanel.tsx'

type View = 'board' | 'evidence' | 'activity' | 'graph'
/**
 * A durable reason is one line on the card, its full text behind the disclosure
 * (2026-09-11 review, second pass). A preparation failure or a workspace-audit
 * refusal can run to a paragraph; printed whole it pushed every following card
 * off screen, and printed truncated with no way to open it, it hid the one
 * sentence the owner needs.
 */
const REASON_INLINE = 96
function clipped(reason: string): boolean { return reason.length > REASON_INLINE }
function time(value: number): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function tone(status: string): string {
  return ['accepted', 'completed', 'verified', 'idle'].includes(status) ? 'good'
    : ['blocked', 'challenged', 'refuted', 'stopped'].includes(status) ? 'bad'
    : ['active', 'working', 'running'].includes(status) ? 'live' : 'warn'
}
function Badge({ value }: { value: string }) {
  const t = useCopy()
  return <span className="sw-chip" data-tone={tone(value)}>{t(value.replaceAll('_', ' '))}</span>
}
function Metric({ label, value, detail, remaining }: { label: string; value: string; detail: string; remaining?: number }) {
  return <div className="sw-metric"><label>{label}</label><strong>{value}</strong><small>{detail}</small>
    {remaining !== undefined && <div className="sw-meter" role="meter" aria-label={`${label} remaining`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(remaining)}>
      <span style={{ width: `${remaining}%` }} /></div>}</div>
}
/** Usage buckets are disjoint billing units; reasoning is a subset of output and is shown as such. */
function UsageBreakdown({ worker, owner, steps }: { worker?: UsageBuckets; owner?: UsageBuckets; steps: number }) {
  const t = useCopy()
  if (!worker && !owner) return null
  const row = (label: string, usage: UsageBuckets) => <tr><th scope="row">{label}</th>
    <td>{compactNumber(usage.uncachedInputTokens)}</td><td>{compactNumber(usage.cacheReadTokens)}</td><td>{compactNumber(usage.cacheWriteTokens)}</td>
    <td>{compactNumber(usage.outputTokens)}<small> ({compactNumber(usage.reasoningTokens)} {t('reasoning')})</small></td><td>{usage.requests}</td></tr>
  return <details className="sw-section" data-swarm-usage=""><summary>{t('Usage breakdown')}</summary>
    <div className="sw-table-wrap"><table className="sw-usage"><thead><tr><th></th><th>{t('Uncached input')}</th><th>{t('Cache read')}</th><th>{t('Cache write')}</th><th>{t('Output')}</th><th>{t('Requests')}</th></tr></thead>
      <tbody>{worker && row(t('Workers'), worker)}{owner && row(t('Owner conversation'), owner)}</tbody></table></div>
    <p className="sw-small">{t('Worker requests are physical model calls; steps count logical worker turns')} · {steps} {t('steps')}. {t('Owner usage is attributed by time window and is not charged to the worker budget.')}</p>
  </details>
}
/** How the cancelled lane explains itself; the board never guesses a cause it was not given. */
const cancellationLabels: Record<CancellationKind, string> = {
  superseded: 'superseded by a repair', 'retired-review': 'review retired by its verdict',
  'at-completion': 'still queued when the mission completed', withdrawn: 'withdrawn by the owner',
  unrecorded: 'cause not recorded in this snapshot',
}
const LeaseTime = createContext(0)
/** Only mounted in the visible task-list tab; its ticks update lease labels, not task cards or graph indexes. */
function VisibleTaskLeases({ snapshot, tasks, live, connection, observedAt, children }: {
  snapshot: Snapshot; tasks: readonly Task[]; live: boolean; connection: ConnectionState; observedAt?: number; children: ReactNode;
}) {
  const active = live && connection === 'connected' && snapshot.mission.status === 'active' && !snapshot.mission.budgetPause
    && tasks.some(task => task.attempt !== undefined)
  const { now, visible } = useVisibleClock(active)
  return <LeaseTime.Provider value={active && visible ? Math.max(now, observedAt ?? 0) : observedAt ?? snapshot.mission.updatedAt}>{children}</LeaseTime.Provider>
}
function TaskLease({ attempt }: { attempt: NonNullable<Task['attempt']> }) {
  const t = useCopy(), reference = useContext(LeaseTime)
  return <span title={`${t('Attempt')} ${attempt.id}`}>{t('Attempt')} {attempt.epoch} · {t('lease')} {time(attempt.leaseUntil)}{leaseExpired(attempt.leaseUntil, reference) ? ` ${t('(expired)')}` : ''}</span>
}
function TaskCard({ task, snapshot, index, memberById, lane, reason, cancellation, onCancel }: {
  task: Task; snapshot: Snapshot; index: BoardIndex; memberById: ReadonlyMap<string, Member>; lane: BoardLane;
  reason?: string; cancellation?: CancellationNote; onCancel?: (task: Task) => void;
}) {
  const t = useCopy()
  const [arming, setArming] = useState(false)
  // Every lookup resolves through the per-render index/member map, never a
  // linear scan of the task array (F-34).
  const member = memberById.get(task.attempt?.ownerId ?? task.assigneeId ?? '')
  const dependencies = task.dependencies.map(id => index.byId.get(id))
  const blocked = index.blockedDependencies(task)
  const reviewSource = task.reviewOf ? index.byId.get(task.reviewOf) : undefined
  return <article className="sw-task" data-lane={lane}>
    <div className="sw-row"><span className="sw-eyebrow">{t(task.kind)}</span><span className="sw-code sw-muted">{shortId(task.id)}</span></div>
    <div className="sw-task-title">{task.title}</div>
    <div className="sw-task-meta"><span>{member?.name ?? t('Unassigned')}{task.experiment ? ` · ${t('experiment')}` : ''}</span>
      {task.attempt && <TaskLease attempt={task.attempt}/>}
      {blocked.length > 0 && <span>{t('Waiting on')} {blocked.length} {t(blocked.length === 1 ? 'prerequisite' : 'prerequisites')}</span>}
      {task.status === 'pending' && task.reviewOf && reviewSource?.status !== 'submitted' && <span>{t(reviewSource ? 'Waiting for source submission' : 'Review source is missing')}</span>}
      {task.evidenceIds.length > 0 && <span>{task.evidenceIds.length} {t(task.evidenceIds.length === 1 ? 'evidence record' : 'evidence records')}</span>}
      {task.artifact && <span className="sw-code" title={task.artifact.commit}>{t('Artifact')} {shortId(task.artifact.commit)}</span>}
    </div>
    {/* W9/W15: the durable reason is visible on the card, not only in the collapsed disclosure. */}
    {reason && (clipped(reason)
      ? <details className="sw-reason" data-swarm-reason="full"><summary data-swarm-task-reason="">{t('Reason')}: {reason.slice(0, REASON_INLINE)}…</summary>
        <p>{reason}</p></details>
      : <p className="sw-small sw-focus-note" data-swarm-task-reason="">{reason}</p>)}
    {/* Item 4 of the 2026-09-11 UI pass: a cancelled card names which of the four
        causes it is, instead of sharing one "blocked / cancelled" label. */}
    {cancellation && <p className="sw-small sw-cancel-note" data-swarm-cancel-kind={cancellation.kind}>{t(cancellationLabels[cancellation.kind])}{cancellation.detail ? ` · ${cancellation.detail.slice(0, REASON_INLINE)}${clipped(cancellation.detail) ? '…' : ''}` : ''}{cancellation.live ? ` · ${t('live replacement left alone')}: ${cancellation.live.join(', ')}` : ''}</p>}
    {(task.dependencies.length > 0 || task.output || task.scope?.length > 0) && <details><summary>{t('Task details')}</summary>
      {task.objective && <p className="sw-small">{task.objective}</p>}
      {task.dependencies.length > 0 && <p className="sw-refs">{t('Prerequisites')}: {task.dependencies.map((id, i) => `${dependencies[i]?.title ?? shortId(id)} (${dependencies[i]?.status ?? 'missing'})`).join('; ')}</p>}
      {task.scope?.length > 0 && <p className="sw-refs">{t('Scope')}: {task.scope.join(', ')}</p>}
      {task.reviewOf && <p className="sw-refs">{t('Reviews')} {shortId(task.reviewOf)}{task.reviewedCommit ? ` ${t('at')} ${shortId(task.reviewedCommit)}` : ''}</p>}
      {task.output && <p className="sw-small" style={{ marginTop: 8 }}>{task.output}</p>}
    </details>}
    {onCancel && !['accepted', 'cancelled'].includes(task.status) && <div className="sw-row" style={{ marginTop: 8 }}>
      {arming ? <>
        <button className="sw-link" data-action="confirm-cancel-task" onClick={() => { setArming(false); onCancel(task) }}>{t('Confirm cancel')}</button>
        <button className="sw-link" data-action="dismiss-cancel-task" onClick={() => setArming(false)}>{t('Cancel')}</button>
      </> : <button className="sw-link" data-action="cancel-task" onClick={() => setArming(true)}>{t('Cancel task')}</button>}
    </div>}
  </article>
}
function EvidenceCard({ evidence, index, memberById, verdicts, retiredBySource }: {
  evidence: Evidence; index: BoardIndex; memberById: ReadonlyMap<string, Member>;
  verdicts: ReadonlyMap<string, DurableVerdict>; retiredBySource: ReadonlyMap<string, RetiredReview[]>;
}) {
  const t = useCopy()
  const author = memberById.get(evidence.authorId)?.name ?? shortId(evidence.authorId)
  const task = index.byId.get(evidence.taskId)
  // F-12: a verdict is reconstructible from the durable log only when an event
  // names this evidence id; otherwise the panel states the gap instead of
  // presenting a state change as recorded history.
  const verdict = verdicts.get(evidence.id)
  const retired = retiredBySource.get(evidence.taskId) ?? []
  return <article className="sw-evidence"><div className="sw-row"><span className="sw-code sw-muted">{shortId(evidence.id)} · {t(evidence.outcome)}</span>
    <Badge value={evidence.status} /></div><p className="sw-claim">{evidence.claim}</p>
    <div className="sw-provenance"><span>{t('By')} {author}</span><span>·</span><span>{task?.title ?? shortId(evidence.taskId)}</span>
      <span>·</span><span>{evidence.toolRunIds.length} {t(evidence.toolRunIds.length === 1 ? 'host tool record' : 'host tool records')}</span>
      {evidence.artifact && <><span>·</span><span className="sw-code" title={evidence.artifact.commit}>{t('commit')} {shortId(evidence.artifact.commit)}</span></>}
    </div>
    {['verified', 'refuted'].includes(evidence.status) && (verdict
      ? <p className="sw-refs" data-swarm-verdict-event={verdict.seq}>{t('Durable verdict event')}: {verdict.type}</p>
      : <p className="sw-small sw-muted" data-swarm-verdict-event="missing">{t('No durable event names this verdict yet.')}</p>)}
    {retired.length > 0 && <p className="sw-refs" data-swarm-retired="">{t('Retired reviews')}: {retired.map(review => review.title).join('; ')}</p>}
    <details><summary>{t('Evidence provenance')}</summary>
      <p className="sw-refs">{t('Host tool run IDs')}: {evidence.toolRunIds.length > 0 ? evidence.toolRunIds.join(', ') : t('None recorded')}</p>
      {evidence.artifact && <><p className="sw-refs">{t('Artifact commit')}: {evidence.artifact.commit}</p>
        <p className="sw-refs">{t('Base')}: {evidence.artifact.baseCommit}</p>
        <p className="sw-refs">{t('Changed paths')}: {evidence.artifact.changedPaths.join(', ') || t('No changes')}</p></>}
      {evidence.supersedes?.length > 0 && <p className="sw-refs">{t('Supersedes')}: {evidence.supersedes.join(', ')}</p>}
    </details>
    {evidence.challenges.map((challenge, index) => <div className="sw-challenge" key={index}>
      <strong>{t('Challenge')} · {memberById.get(challenge.authorId)?.name ?? shortId(challenge.authorId)}</strong>
      <p>{challenge.reason}</p><p className="sw-refs">{t('Tool records')}: {challenge.toolRunIds.join(', ') || t('None')}</p>
    </div>)}
  </article>
}

/** Read-only projection. Rendering never performs a request or interprets peer text as code. */
export function SwarmBoard({ snapshot, initialView, onOpenWorker, onCancelTask, live = false, connection = 'connected', observedAt, actions, delivery, technicalDetails }: {
  snapshot: Snapshot; initialView?: View; onOpenWorker?: (member: Member) => void; onCancelTask?: (task: Task) => void; live?: boolean;
  connection?: ConnectionState; observedAt?: number; actions?: ReactNode; delivery?: ReactNode; technicalDetails?: ReactNode;
}) {
  const t = useCopy()
  const [view, setView] = useState<View>(initialView ?? 'board')
  const [detailsOpen, setDetailsOpen] = useState(initialView !== undefined)
  const [stream, setStream] = useState('all')
  const { mission } = snapshot
  // One index and one lane pass per render; every card, edge and count reuses
  // them, so cost stays linear in tasks + edges (F-34).
  const index = useMemo(() => boardIndex(snapshot.tasks), [snapshot.tasks])
  const lanes = useMemo(() => {
    const map = new Map<string, BoardLane>()
    for (const task of snapshot.tasks) map.set(task.id, index.lane(task, snapshot.members))
    return map
  }, [index, snapshot.tasks, snapshot.members])
  const reasons = useMemo(() => taskReasons(snapshot), [snapshot])
  const cancellations = useMemo(() => cancellationNotes(snapshot), [snapshot])
  const memberById = useMemo(() => new Map(snapshot.members.map(member => [member.id, member])), [snapshot.members])
  const groups = useMemo(() => activityGroups(snapshot), [snapshot])
  const verdicts = useMemo(() => durableVerdicts(snapshot), [snapshot])
  const retiredBySource = useMemo(() => retiredReviewsBySource(snapshot), [snapshot])
  const tasks = snapshot.tasks.filter(task => stream === 'all' || task.workstreamId === stream)
  const evidence = snapshot.evidence.filter(item => stream === 'all' || item.workstreamId === stream)
  const counts = evidenceCounts(snapshot.evidence)
  const accepted = snapshot.tasks.filter(task => task.status === 'accepted').length
  const activeWorkers = snapshot.members.filter(member => member.status === 'working').length
  const blocked = snapshot.tasks.filter(task => lanes.get(task.id) === 'blocked').length
  // One bucketing pass feeds the lane counts, the seven columns and the empty-lane
  // collapse; the board used to rescan the task array once per lane (F-34).
  const byLane = new Map<BoardLane, Task[]>()
  for (const lane of LANES) byLane.set(lane.id, [])
  for (const task of tasks) byLane.get(lanes.get(task.id) ?? 'ready')!.push(task)
  return <section data-swarm="" aria-label={`Agent Swarm mission: ${mission.title}`}>
    <header className="sw-head"><div className="sw-row"><span className="sw-eyebrow">{t(live ? 'Current mission' : 'Mission snapshot')}</span><Badge value={mission.status} /></div>
      <h2>{mission.title}</h2>
    </header>
    <MissionOverview snapshot={snapshot} connection={connection} live={live} observedAt={observedAt} onOpen={onOpenWorker} actions={actions} delivery={delivery}/>
    <details className="sw-disclosure sw-technical" data-swarm-details="technical" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary>{t('Task details and resources')}</summary>
      {detailsOpen && <>
    {/* Item 3: the top of this pane opens on a title plus its headline numbers;
        the objective, the metrics grid and the usage table unfold from there. */}
    <details className="sw-section sw-mission-facts" data-swarm-details="mission">
      <summary><span className="sw-fact-title">{mission.title}</span>
        <span className="sw-small sw-fact-counts">{accepted} / {snapshot.tasks.length} {t('tasks accepted')} · {compactNumber(mission.usedTokens)} {t('tokens')} · {mission.usedSteps} {t('steps')}</span></summary>
    <p className="sw-objective sw-detail-objective">{mission.objective}</p>
    {technicalDetails}
    <div className="sw-metrics"><Metric label={t('ACCEPTED WORK')} value={`${accepted} / ${snapshot.tasks.length}`} detail={`${blocked} blocked · ${snapshot.workstreams.length} workstreams`} />
      <Metric label={t('TOKENS USED')} value={compactNumber(mission.usedTokens)} detail={`of ${compactNumber(mission.budget.maxTokens)} budget`}
        remaining={remainingPercent(mission.usedTokens, mission.budget.maxTokens)} />
      <Metric label={t('STEPS USED')} value={`${mission.usedSteps} / ${mission.budget.maxSteps}`} detail={`Deadline ${time(mission.deadline)}`}
        remaining={remainingPercent(mission.usedSteps, mission.budget.maxSteps)} />
      {/* S6: critical-path length beside the spend it is charged against, so a
          worker that did not shorten the longest branch earns nothing visible. */}
      <Metric label={t('CRITICAL PATH')} value={`${snapshot.criticalPath?.length ?? 0}`}
        detail={`${snapshot.criticalPath?.remaining ?? 0} open · ${snapshot.criticalPath?.usedSteps ?? 0} steps on the longest chain`} />
      <Metric label={t('WORKERS')} value={`${activeWorkers} active`} detail={`${snapshot.members.length} workers · cap ${mission.budget.maxWorkers}`} />
    </div>
    <UsageBreakdown worker={mission.workerUsage} owner={mission.ownerUsage} steps={mission.usedSteps} />
    </details>
    <div className="sw-tabs" role="tablist" aria-label="Mission views">
      <button className="sw-tab" role="tab" aria-selected={view === 'board'} onClick={() => setView('board')}>{t('Work board')} <span className="sw-count">{tasks.length}</span></button>
      <button className="sw-tab" role="tab" aria-selected={view === 'graph'} onClick={() => setView('graph')}>{t('Dependency graph')} <span className="sw-count">{snapshot.tasks.length}</span></button>
      <button className="sw-tab" role="tab" aria-selected={view === 'evidence'} onClick={() => setView('evidence')}>{t('Evidence')} <span className="sw-count">{counts.total}</span></button>
      <button className="sw-tab" role="tab" aria-selected={view === 'activity'} onClick={() => setView('activity')}>{t('Activity')} <span className="sw-count">{snapshot.events.length}</span></button>
    </div>
    <div className="sw-body" role="tabpanel" aria-label={t(view === 'board' ? 'Work board' : view === 'graph' ? 'Dependency graph' : view === 'evidence' ? 'Evidence' : 'Activity')}>
      {mission.reason && <div className="sw-notice">{mission.reason}</div>}
      {view !== 'activity' && snapshot.workstreams.length > 0 && <div className="sw-streams" aria-label="Filter by workstream">
        <button className="sw-stream" aria-pressed={stream === 'all'} onClick={() => setStream('all')}>{t('All workstreams')}</button>
        {snapshot.workstreams.map(item => <button className="sw-stream" aria-pressed={stream === item.id} key={item.id}
          title={item.objective} onClick={() => setStream(item.id)}>{item.title}</button>)}
      </div>}
      {view === 'board' && <>
        {/* Item 2: the whole distribution in one line, so a narrow sidebar does not
            have to be scrolled sideways to learn where the work is. */}
        <div className="sw-lane-counts" data-swarm-lane-counts="" aria-label={t('Task distribution')}>
          {LANES.map(lane => <span className="sw-lane-count" key={lane.id} data-lane-count={lane.id} data-empty={byLane.get(lane.id)!.length === 0}>
            {t(lane.label)} <b>{byLane.get(lane.id)!.length}</b></span>)}
        </div>
        <VisibleTaskLeases snapshot={snapshot} tasks={tasks} live={live} connection={connection} observedAt={observedAt}><div className="sw-board">{LANES.map(lane => {
        const items = byLane.get(lane.id)!
        return <section className="sw-lane" key={lane.id} data-lane={lane.id} data-empty={items.length === 0 ? '' : undefined} aria-label={t(lane.label)}>
          <div className="sw-lane-title">{t(lane.label)}<span className="sw-count">{items.length}</span></div>
          {/* Item 3: an empty lane collapses to its header instead of drawing a
              dashed placeholder box in every one of the seven columns. */}
          {items.length === 0 ? <div className="sw-lane-void" aria-hidden="true" /> : items.map(task => <TaskCard key={task.id} task={task} snapshot={snapshot}
            index={index} memberById={memberById}
            lane={lanes.get(task.id) ?? 'ready'} reason={reasons.get(task.id)} cancellation={cancellations.get(task.id)} onCancel={onCancelTask} />)}
        </section>
      })}</div></VisibleTaskLeases>
        <details className="sw-section"><summary>{t('Mission contract and limits')}</summary><div className="sw-contract">
          <div><h3>{t('Acceptance')}</h3><ul>{mission.acceptance.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></div>
          <div><h3>{t('Scope')}</h3><ul>{mission.scope.map((path, index) => <li key={index}>{path}</li>)}</ul>
            <p>At most {mission.budget.maxTasks} tasks and {mission.budget.maxExperiments} experiments.</p></div>
        </div></details>
      </>}
      {view === 'graph' && <DependencyGraph snapshot={snapshot} tasks={tasks} />}
      {view === 'evidence' && <><div className="sw-row" style={{ marginBottom: 14 }}><h3>{t('Claims and provenance')}</h3>
        <span className="sw-small">{counts.verified} {t('verified')} · {counts.challenged} {t('challenged')}</span></div>
        {evidence.length === 0 ? <div className="sw-empty">{t('No evidence in this workstream yet. Claims will show their host tool records and artifact commits here.')}</div>
          : evidence.map(item => <EvidenceCard key={item.id} evidence={item} index={index} memberById={memberById} verdicts={verdicts} retiredBySource={retiredBySource} />)}
      </>}
      {view === 'activity' && <><div className="sw-row"><h3>{t('Recent events')}</h3><span className="sw-small">{snapshot.pendingDeliveries} {t('pending deliveries')} · {groups.length} {t(groups.length === 1 ? 'writer' : 'writers')}</span></div>
        {snapshot.events.length === 0 ? <div className="sw-empty">{t('No activity recorded yet.')}</div> : groups.map(group => <section className="sw-activity-group" key={group.actor} data-swarm-activity-group={group.actor}>
          {/* Item 1: one group per durable actor, so "what has Atlas been doing"
              is answered by looking at Atlas' block instead of by reading every row. */}
          <header className="sw-row sw-activity-head">
            <span className="sw-person">{group.member ? <AgentAvatar id={group.member.id} name={group.member.name} size={28} /> : <span className="sw-actor-dot" aria-hidden="true" />}
              <strong>{t(group.name)}</strong></span>
            <span className="sw-small">{group.events.length} {t(group.events.length === 1 ? 'event' : 'events')}</span>
          </header>
          {group.events.map(event => <div className="sw-event" key={event.seq}>
            <span className="sw-small">{time(event.createdAt)}</span><div><div className="sw-event-type">{event.type.replaceAll('.', '/').replaceAll('_', ' ').split('/').map(token => t(token.trim())).join(' / ')}</div>
              <div className="sw-event-data">{eventSummary(event.data) || t('No details recorded')}</div></div>
          </div>)}
        </section>)}
        {snapshot.events.length > 0 && <p className="sw-small" style={{ marginTop: 12 }}>{t('Showing the latest')} {snapshot.events.length} {t('events retained in this snapshot.')}</p>}
      </>}
    </div>
    </>}
    </details>
    <footer className="sw-foot"><span>Snapshot {new Date(mission.updatedAt).toLocaleString()} · {shortId(mission.id)}</span>
      <span>{t(live ? 'Updates automatically while this conversation is selected.' : 'Snapshot. Open the sidebar for live progress.')}</span></footer>
  </section>
}
