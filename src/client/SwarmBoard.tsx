import { useState, type ReactNode } from 'react'
import type { Snapshot, Task, Evidence, Member, UsageBuckets } from '../types.ts'
import { LANES, compactNumber, dependencyMet, evidenceCounts, eventSummary, remainingPercent, shortId, taskLane } from './projection.ts'
import { leaseExpired, useNow } from './clock.ts'
import { DependencyGraph } from './DependencyGraph.tsx'
import { useCopy } from './locale.tsx'
import { MissionProgress, RecentProgress, ResultSummary } from './MissionProgress.tsx'
import { activityLabels, memberActivity, type ConnectionState } from './progress.ts'

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
function TaskCard({ task, snapshot, live, now }: { task: Task; snapshot: Snapshot; live: boolean; now: number }) {
  const t = useCopy()
  const member = snapshot.members.find(item => item.id === (task.attempt?.ownerId ?? task.assigneeId))
  const dependencies = task.dependencies.map(id => snapshot.tasks.find(item => item.id === id))
  const blocked = task.dependencies.filter(id => !dependencyMet(id, snapshot.tasks))
  const reviewSource = task.reviewOf ? snapshot.tasks.find(item => item.id === task.reviewOf) : undefined
  const expired = task.attempt !== undefined && leaseExpired(task.attempt.leaseUntil, live ? now : snapshot.mission.updatedAt)
  return <article className="sw-task" data-lane={taskLane(task, snapshot.tasks)}>
    <div className="sw-row"><span className="sw-eyebrow">{task.kind}</span><span className="sw-code sw-muted">{shortId(task.id)}</span></div>
    <div className="sw-task-title">{task.title}</div>
    <div className="sw-task-meta"><span>{member?.name ?? t('Unassigned')}{task.experiment ? ` · ${t('experiment')}` : ''}</span>
      {task.attempt && <span title={`${t('Attempt')} ${task.attempt.id}`}>{t('Attempt')} {task.attempt.epoch} · {t('lease')} {time(task.attempt.leaseUntil)}{expired ? ` ${t('(expired)')}` : ''}</span>}
      {blocked.length > 0 && <span>{t('Waiting on')} {blocked.length} {t(blocked.length === 1 ? 'prerequisite' : 'prerequisites')}</span>}
      {task.status === 'pending' && task.reviewOf && reviewSource?.status !== 'submitted' && <span>{t(reviewSource ? 'Waiting for source submission' : 'Review source is missing')}</span>}
      {task.evidenceIds.length > 0 && <span>{task.evidenceIds.length} {t(task.evidenceIds.length === 1 ? 'evidence record' : 'evidence records')}</span>}
      {task.artifact && <span className="sw-code" title={task.artifact.commit}>{t('Artifact')} {shortId(task.artifact.commit)}</span>}
    </div>
    {(task.dependencies.length > 0 || task.output || task.scope?.length > 0) && <details><summary>{t('Task details')}</summary>
      {task.objective && <p className="sw-small">{task.objective}</p>}
      {task.dependencies.length > 0 && <p className="sw-refs">{t('Prerequisites')}: {task.dependencies.map((id, i) => `${dependencies[i]?.title ?? shortId(id)} (${dependencies[i]?.status ?? 'missing'})`).join('; ')}</p>}
      {task.scope?.length > 0 && <p className="sw-refs">{t('Scope')}: {task.scope.join(', ')}</p>}
      {task.reviewOf && <p className="sw-refs">{t('Reviews')} {shortId(task.reviewOf)}{task.reviewedCommit ? ` ${t('at')} ${shortId(task.reviewedCommit)}` : ''}</p>}
      {task.output && <p className="sw-small" style={{ marginTop: 8 }}>{task.output}</p>}
    </details>}
  </article>
}
function Worker({ member, tasks, onOpen }: { member: Member; tasks: Task[]; onOpen?: (member: Member) => void }) {
  const t = useCopy()
  const current = tasks.find(task => task.status === 'running' && (task.attempt?.ownerId ?? task.assigneeId) === member.id)
  const activity = memberActivity(member, tasks)
  return <article className="sw-worker"><div className="sw-row"><div className="sw-person">
    <span className="sw-avatar" aria-hidden="true">{member.name.slice(0, 2).toUpperCase()}</span>
    <div><div className="sw-worker-name">{member.name}</div><div className="sw-small">{member.role}</div></div>
  </div><Badge value={member.status} /></div>
    {member.model && <div className="sw-small" style={{ marginTop: 8 }}>{member.provider ? `${member.provider} / ` : ''}{member.model}{member.reasoningEffort ? ` · ${member.reasoningEffort}` : ''}</div>}
    <p className="sw-small" style={{ marginTop: 7 }}>{current?.title ?? t(member.status === 'waiting' ? 'Waiting for input or dependencies' : 'No active task')}</p>
    {activity && <p className="sw-small" data-swarm-worker-activity={activity.kind}>{t(activityLabels[activity.kind])}{activity.tool ? ` · ${activity.tool}` : ''}</p>}
    {onOpen && <button className="sw-link" data-worker-session={member.sessionId} onClick={() => onOpen(member)}>{t('Open conversation')} ↗</button>}
  </article>
}
function EvidenceCard({ evidence, snapshot }: { evidence: Evidence; snapshot: Snapshot }) {
  const t = useCopy()
  const author = snapshot.members.find(item => item.id === evidence.authorId)?.name ?? shortId(evidence.authorId)
  const task = snapshot.tasks.find(item => item.id === evidence.taskId)
  return <article className="sw-evidence"><div className="sw-row"><span className="sw-code sw-muted">{shortId(evidence.id)} · {evidence.outcome}</span>
    <Badge value={evidence.status} /></div><p className="sw-claim">{evidence.claim}</p>
    <div className="sw-provenance"><span>{t('By')} {author}</span><span>·</span><span>{task?.title ?? shortId(evidence.taskId)}</span>
      <span>·</span><span>{evidence.toolRunIds.length} {t(evidence.toolRunIds.length === 1 ? 'host tool record' : 'host tool records')}</span>
      {evidence.artifact && <><span>·</span><span className="sw-code" title={evidence.artifact.commit}>{t('commit')} {shortId(evidence.artifact.commit)}</span></>}
    </div>
    <details><summary>{t('Evidence provenance')}</summary>
      <p className="sw-refs">{t('Host tool run IDs')}: {evidence.toolRunIds.length > 0 ? evidence.toolRunIds.join(', ') : t('None recorded')}</p>
      {evidence.artifact && <><p className="sw-refs">{t('Artifact commit')}: {evidence.artifact.commit}</p>
        <p className="sw-refs">{t('Base')}: {evidence.artifact.baseCommit}</p>
        <p className="sw-refs">{t('Changed paths')}: {evidence.artifact.changedPaths.join(', ') || t('No changes')}</p></>}
      {evidence.supersedes?.length > 0 && <p className="sw-refs">{t('Supersedes')}: {evidence.supersedes.join(', ')}</p>}
    </details>
    {evidence.challenges.map((challenge, index) => <div className="sw-challenge" key={index}>
      <strong>{t('Challenge')} · {snapshot.members.find(item => item.id === challenge.authorId)?.name ?? shortId(challenge.authorId)}</strong>
      <p>{challenge.reason}</p><p className="sw-refs">{t('Tool records')}: {challenge.toolRunIds.join(', ') || t('None')}</p>
    </div>)}
  </article>
}

/** Read-only projection. Rendering never performs a request or interprets peer text as code. */
export function SwarmBoard({ snapshot, initialView, onOpenWorker, live = false, connection = 'connected', actions, delivery, technicalDetails }: {
  snapshot: Snapshot; initialView?: View; onOpenWorker?: (member: Member) => void; live?: boolean;
  connection?: ConnectionState; actions?: ReactNode; delivery?: ReactNode; technicalDetails?: ReactNode;
}) {
  const t = useCopy()
  const [view, setView] = useState<View>(initialView ?? 'board')
  const [detailsOpen, setDetailsOpen] = useState(initialView !== undefined)
  const [stream, setStream] = useState('all')
  const now = useNow(live)
  const { mission } = snapshot
  const tasks = snapshot.tasks.filter(task => stream === 'all' || task.workstreamId === stream)
  const evidence = snapshot.evidence.filter(item => stream === 'all' || item.workstreamId === stream)
  const counts = evidenceCounts(snapshot.evidence)
  const accepted = snapshot.tasks.filter(task => task.status === 'accepted').length
  const activeWorkers = snapshot.members.filter(member => member.status === 'working').length
  const blocked = snapshot.tasks.filter(task => taskLane(task, snapshot.tasks) === 'blocked').length
  return <section data-swarm="" aria-label={`Agent Swarm mission: ${mission.title}`}>
    <header className="sw-head"><div className="sw-row"><span className="sw-eyebrow">{t(live ? 'Current mission' : 'Mission snapshot')}</span><Badge value={mission.status} /></div>
      <h2>{mission.title}</h2>
    </header>
    <div className="sw-overview">
      <MissionProgress snapshot={snapshot} live={live} connection={connection} />
      {mission.status === 'completed' && <ResultSummary snapshot={snapshot} />}
      {delivery}
      {actions}
      <RecentProgress snapshot={snapshot} />
      <details className="sw-disclosure" data-swarm-details="team"><summary>{t('Team')} <span className="sw-detail-count">{snapshot.members.length}</span></summary>
        <div className="sw-workers">{snapshot.members.length === 0 ? <p className="sw-muted">{t('Workers appear when the mission delegates work.')}</p>
          : snapshot.members.map(member => <Worker key={member.id} member={member} tasks={snapshot.tasks} onOpen={onOpenWorker} />)}</div>
      </details>
    </div>
    <details className="sw-disclosure sw-technical" data-swarm-details="technical" open={detailsOpen} onToggle={event => setDetailsOpen(event.currentTarget.open)}>
      <summary>{t('Task details and resources')}</summary>
      {detailsOpen && <>
    <p className="sw-objective sw-detail-objective">{mission.objective}</p>
    {technicalDetails}
    <div className="sw-metrics"><Metric label={t('ACCEPTED WORK')} value={`${accepted} / ${snapshot.tasks.length}`} detail={`${blocked} blocked · ${snapshot.workstreams.length} workstreams`} />
      <Metric label={t('TOKENS USED')} value={compactNumber(mission.usedTokens)} detail={`of ${compactNumber(mission.budget.maxTokens)} budget`}
        remaining={remainingPercent(mission.usedTokens, mission.budget.maxTokens)} />
      <Metric label={t('STEPS USED')} value={`${mission.usedSteps} / ${mission.budget.maxSteps}`} detail={`Deadline ${time(mission.deadline)}`}
        remaining={remainingPercent(mission.usedSteps, mission.budget.maxSteps)} />
      <Metric label={t('WORKERS')} value={`${activeWorkers} active`} detail={`${snapshot.members.length} workers · cap ${mission.budget.maxWorkers}`} />
    </div>
    <UsageBreakdown worker={mission.workerUsage} owner={mission.ownerUsage} steps={mission.usedSteps} />
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
        const items = tasks.filter(task => taskLane(task, snapshot.tasks) === lane.id)
        return <section className="sw-lane" key={lane.id} aria-label={t(lane.label)}><div className="sw-lane-title">{t(lane.label)}<span className="sw-count">{items.length}</span></div>
          {items.length === 0 ? <div className="sw-empty">{t('No tasks')}</div> : items.map(task => <TaskCard key={task.id} task={task} snapshot={snapshot} live={live} now={now} />)}
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
        <span className="sw-small">{counts.verified} verified · {counts.challenged} challenged</span></div>
        {evidence.length === 0 ? <div className="sw-empty">{t('No evidence in this workstream yet. Claims will show their host tool records and artifact commits here.')}</div>
          : evidence.map(item => <EvidenceCard key={item.id} evidence={item} snapshot={snapshot} />)}
      </>}
      {view === 'activity' && <><div className="sw-row"><h3>{t('Recent events')}</h3><span className="sw-small">{snapshot.pendingDeliveries} pending deliveries</span></div>
        {snapshot.events.length === 0 ? <div className="sw-empty">{t('No activity recorded yet.')}</div> : snapshot.events.slice(-40).reverse().map(event => <div className="sw-event" key={event.seq}>
          <span className="sw-small">{time(event.createdAt)}</span><div><div className="sw-event-type">{event.type.replaceAll('.', ' / ').replaceAll('_', ' ')}</div>
            <div className="sw-event-data">{event.actor} · {eventSummary(event.data)}</div></div>
        </div>)}
        {snapshot.events.length > 40 && <p className="sw-small" style={{ marginTop: 12 }}>Showing the latest 40 events from this snapshot.</p>}
      </>}
    </div>
    </>}
    </details>
    <footer className="sw-foot"><span>Snapshot {new Date(mission.updatedAt).toLocaleString()} · {shortId(mission.id)}</span>
      <span>{t(live ? 'Updates automatically while this conversation is selected.' : 'Snapshot. Open the sidebar for live progress.')}</span></footer>
  </section>
}
