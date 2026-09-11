import { memo, useMemo, useState, type ReactNode } from 'react'
import type { Snapshot, Task, Evidence, Member, UsageBuckets } from '../types.ts'
import { LANES, boardIndex, cancellationNotes, compactNumber, durableVerdicts, evidenceCounts, eventSummary, remainingPercent, retiredReviewsBySource, shortId, type BoardIndex, type BoardLane, type CancellationKind, type CancellationNote, type DurableVerdict, type RetiredReview } from './projection.ts'
import { leaseExpired, useNow } from './clock.ts'
import { DependencyGraph } from './DependencyGraph.tsx'
import { useCopy } from './locale.tsx'
import { MissionProgress, RecentProgress, ResultSummary, WorkerAvatar } from './MissionProgress.tsx'
import { activityLabels, memberActivity, memberProgress, runningByOwner, taskReasons, type ConnectionState } from './progress.ts'

type View = 'board' | 'evidence' | 'activity' | 'graph'
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
function TaskCard({ task, snapshot, live, now, index, memberById, lane, reason, cancellation, onCancel }: {
  task: Task; snapshot: Snapshot; live: boolean; now: number; index: BoardIndex; memberById: ReadonlyMap<string, Member>; lane: BoardLane;
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
  const expired = task.attempt !== undefined && leaseExpired(task.attempt.leaseUntil, live ? now : snapshot.mission.updatedAt)
  return <article className="sw-task" data-lane={lane}>
    <div className="sw-row"><span className="sw-eyebrow">{t(task.kind)}</span><span className="sw-code sw-muted">{shortId(task.id)}</span></div>
    <div className="sw-task-title">{task.title}</div>
    <div className="sw-task-meta"><span>{member?.name ?? t('Unassigned')}{task.experiment ? ` · ${t('experiment')}` : ''}</span>
      {task.attempt && <span title={`${t('Attempt')} ${task.attempt.id}`}>{t('Attempt')} {task.attempt.epoch} · {t('lease')} {time(task.attempt.leaseUntil)}{expired ? ` ${t('(expired)')}` : ''}</span>}
      {blocked.length > 0 && <span>{t('Waiting on')} {blocked.length} {t(blocked.length === 1 ? 'prerequisite' : 'prerequisites')}</span>}
      {task.status === 'pending' && task.reviewOf && reviewSource?.status !== 'submitted' && <span>{t(reviewSource ? 'Waiting for source submission' : 'Review source is missing')}</span>}
      {task.evidenceIds.length > 0 && <span>{task.evidenceIds.length} {t(task.evidenceIds.length === 1 ? 'evidence record' : 'evidence records')}</span>}
      {task.artifact && <span className="sw-code" title={task.artifact.commit}>{t('Artifact')} {shortId(task.artifact.commit)}</span>}
    </div>
    {/* W9/W15: the durable reason is visible on the card, not only in the collapsed disclosure. */}
    {reason && <p className="sw-small sw-focus-note" data-swarm-task-reason="">{reason}</p>}
    {/* Item 4 of the 2026-09-11 UI pass: a cancelled card names which of the four
        causes it is, instead of sharing one "blocked / cancelled" label. */}
    {cancellation && <p className="sw-small sw-cancel-note" data-swarm-cancel-kind={cancellation.kind}>{t(cancellationLabels[cancellation.kind])}{cancellation.detail ? ` · ${cancellation.detail}` : ''}</p>}
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
/**
 * One member's live row. OWNER PASS 2026-09-11:
 *  - the deterministic pixel sprite replaces the initials block, so the avatar
 *    sits with the member (it used to be drawn only in the mission focus line
 *    while this row showed initials);
 *  - the bar under the name is the member's own dynamic progress: a durable step
 *    ratio when the task declares a ceiling, a lease countdown when it holds an
 *    attempt, and otherwise an indeterminate live bar that animates while the
 *    member works;
 *  - the row is the same component wherever members are shown, so the roster
 *    cannot drift between the top strip and any other view.
 */
function MemberRow({ member, running, now, live, onOpen }: {
  member: Member; running: ReadonlyMap<string, Task>; now: number; live: boolean; onOpen?: (member: Member) => void;
}) {
  const t = useCopy()
  const view = memberProgress(member, running, live ? now : Date.now())
  const stateLabel = view.state === 'working' ? (view.task?.title ?? t('Working'))
    : view.state === 'waiting' ? t('Waiting for input or dependencies')
      : view.state === 'stopped' ? t('Stopped') : t('No active task')
  return <article className="sw-worker sw-member" data-swarm-member={member.id} data-state={view.state}>
    <div className="sw-row"><div className="sw-person">
      <WorkerAvatar name={member.name} />
      <div><div className="sw-worker-name">{member.name}</div><div className="sw-small">{member.role}</div></div>
    </div><Badge value={member.status} /></div>
    <p className="sw-small sw-member-task">{view.state === 'working' && view.task ? view.task.title : stateLabel}</p>
    <div className="sw-bar" data-basis={view.basis ?? 'live'} data-state={view.state}
      {...(view.percent === undefined ? { 'data-indeterminate': '' } : { role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(view.percent), 'aria-label': `${member.name}: ${stateLabel}` })}>
      <span style={view.percent === undefined ? undefined : { width: `${view.percent}%` }} /></div>
    <div className="sw-small sw-member-meta">
      {view.basis === 'steps' && view.basisCount !== undefined && <span data-swarm-member-basis="steps">{t('steps')} {view.basisCount}</span>}
      {view.basis === 'lease' && <span data-swarm-member-basis="lease">{view.leaseRemaining === 0 ? t('lease expired') : `${t('lease')} ${view.leaseRemaining}${t('sec')}`}</span>}
      {view.activity && <span data-swarm-worker-activity={view.activity.kind}>{t(activityLabels[view.activity.kind])}{view.activity.tool ? ` · ${view.activity.tool}` : ''}</span>}
      {member.model && <span>{member.provider ? `${member.provider} / ` : ''}{member.model}</span>}
    </div>
    {onOpen && <button className="sw-link" data-worker-session={member.sessionId} onClick={() => onOpen(member)}>{t('Open conversation')} ↗</button>}
  </article>
}
/**
 * The team strip at the top of the overview: every member with its own live
 * progress, so the answer to "what is happening" includes who is doing it
 * without opening a disclosure.
 */
function TeamActivity({ members, running, now, live, onOpen }: {
  members: readonly Member[]; running: ReadonlyMap<string, Task>; now: number; live: boolean; onOpen?: (member: Member) => void;
}) {
  const t = useCopy()
  const working = members.filter(member => member.status === 'working').length
  return <section className="sw-team" data-swarm-team="" aria-label={t('Team activity')}>
    <div className="sw-row"><h3>{t('Team activity')}</h3>
      <span className="sw-small" data-swarm-team-counts="">{working} {t('working')} · {members.length} {t('members')}</span></div>
    <div className="sw-workers">{members.length === 0 ? <p className="sw-muted">{t('Workers appear when the mission delegates work.')}</p>
      : members.map(member => <MemberRow key={member.id} member={member} running={running} now={now} live={live} onOpen={onOpen} />)}</div>
  </section>
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
export function SwarmBoard({ snapshot, initialView, onOpenWorker, onCancelTask, live = false, connection = 'connected', actions, delivery, technicalDetails }: {
  snapshot: Snapshot; initialView?: View; onOpenWorker?: (member: Member) => void; onCancelTask?: (task: Task) => void; live?: boolean;
  connection?: ConnectionState; actions?: ReactNode; delivery?: ReactNode; technicalDetails?: ReactNode;
}) {
  const t = useCopy()
  const [view, setView] = useState<View>(initialView ?? 'board')
  const [detailsOpen, setDetailsOpen] = useState(initialView !== undefined)
  const [stream, setStream] = useState('all')
  // The lease clock ticks only while a lease is on screen: every other card and
  // the roster render from stable values, so a live mission no longer re-renders
  // the whole board once per second (2026-09-11 review, M2/C-item).
  const leaseVisible = live && snapshot.tasks.some(task => task.attempt !== undefined)
  const now = useNow(leaseVisible)
  const stableNow = snapshot.mission.updatedAt
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
  const running = useMemo(() => runningByOwner(snapshot.tasks), [snapshot.tasks])
  const verdicts = useMemo(() => durableVerdicts(snapshot), [snapshot])
  const retiredBySource = useMemo(() => retiredReviewsBySource(snapshot), [snapshot])
  const tasks = snapshot.tasks.filter(task => stream === 'all' || task.workstreamId === stream)
  const evidence = snapshot.evidence.filter(item => stream === 'all' || item.workstreamId === stream)
  const counts = evidenceCounts(snapshot.evidence)
  const accepted = snapshot.tasks.filter(task => task.status === 'accepted').length
  const activeWorkers = snapshot.members.filter(member => member.status === 'working').length
  const blocked = snapshot.tasks.filter(task => lanes.get(task.id) === 'blocked').length
  return <section data-swarm="" aria-label={`Agent Swarm mission: ${mission.title}`}>
    <header className="sw-head"><div className="sw-row"><span className="sw-eyebrow">{t(live ? 'Current mission' : 'Mission snapshot')}</span><Badge value={mission.status} /></div>
      <h2>{mission.title}</h2>
    </header>
    <div className="sw-overview">
      <MissionProgress snapshot={snapshot} live={live} connection={connection} />
      {actions}
      {/* Item 5: the members moved out of their disclosure into the dynamic area,
          each with its own avatar and live progress. */}
      <TeamActivity members={snapshot.members} running={running} now={now} live={live} onOpen={onOpenWorker} />
      {mission.status === 'completed' && <ResultSummary snapshot={snapshot} />}
      {delivery}
      <RecentProgress snapshot={snapshot} />
    </div>
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
      <button className="sw-tab" role="tab" aria-selected={view === 'board'} onClick={() => setView('board')}>{t('Work board')}</button>
      <button className="sw-tab" role="tab" aria-selected={view === 'graph'} onClick={() => setView('graph')}>{t('Dependency graph')}</button>
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
      {view === 'board' && <><div className="sw-board">{LANES.map(lane => {
        const items = tasks.filter(task => lanes.get(task.id) === lane.id)
        return <section className="sw-lane" key={lane.id} aria-label={t(lane.label)}><div className="sw-lane-title">{t(lane.label)}<span className="sw-count">{items.length}</span></div>
          {items.length === 0 ? <div className="sw-empty">{t('No tasks')}</div> : items.map(task => <TaskCard key={task.id} task={task} snapshot={snapshot} live={live}
            now={task.attempt === undefined ? stableNow : now} index={index} memberById={memberById}
            lane={lanes.get(task.id) ?? 'ready'} reason={reasons.get(task.id)} cancellation={cancellations.get(task.id)} onCancel={onCancelTask} />)}
        </section>
      })}</div>
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
      {view === 'activity' && <><div className="sw-row"><h3>{t('Recent events')}</h3><span className="sw-small">{snapshot.pendingDeliveries} {t('pending deliveries')}</span></div>
        {snapshot.events.length === 0 ? <div className="sw-empty">{t('No activity recorded yet.')}</div> : [...snapshot.events].reverse().map(event => <div className="sw-event" key={event.seq}>
          <span className="sw-small">{time(event.createdAt)}</span><div><div className="sw-event-type">{event.type.replaceAll('.', '/').replaceAll('_', ' ').split('/').map(token => t(token.trim())).join(' / ')}</div>
            <div className="sw-event-data">{event.actor} · {eventSummary(event.data)}</div></div>
        </div>)}
        {snapshot.events.length > 0 && <p className="sw-small" style={{ marginTop: 12 }}>{t('Showing the latest')} {snapshot.events.length} {t('events retained in this snapshot.')}</p>}
      </>}
    </div>
    </>}
    </details>
    <footer className="sw-foot"><span>Snapshot {new Date(mission.updatedAt).toLocaleString()} · {shortId(mission.id)}</span>
      <span>{t(live ? 'Updates automatically while this conversation is selected.' : 'Snapshot. Open the sidebar for live progress.')}</span></footer>
  </section>
}
