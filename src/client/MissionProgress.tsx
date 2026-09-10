import type { Snapshot } from '../types.ts'
import { useEffect, useState } from 'react'
import { acceptanceSummary, activityDuration, currentProgress, recentProgress, sidebarState, type ConnectionState } from './progress.ts'
import { useCopy } from './locale.tsx'

function timestamp(value: number): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
export function MissionProgress({ snapshot, connection = 'connected', live = false }: { snapshot: Snapshot; connection?: ConnectionState; live?: boolean }) {
  const t = useCopy(), current = currentProgress(snapshot, connection)
  const [clock, setClock] = useState(() => live && connection === 'connected' ? Date.now() : current.activity?.updatedAt ?? snapshot.mission.updatedAt)
  useEffect(() => {
    if (!live || connection !== 'connected' || !current.activity) return
    setClock(Date.now())
    const timer = setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, connection, current.activity?.id])
  const duration = current.activity ? activityDuration(current.activity.startedAt, live ? clock : current.activity.updatedAt) : undefined
  // R15-B: the owner-facing phase, its recovery age and any pending decision are
  // derived from durable rows only (see `sidebarState`); this render adds no
  // timer, request or model turn.
  const owner = sidebarState(snapshot, connection, live && connection === 'connected' ? clock : (current.observedAt ?? snapshot.mission.updatedAt))
  return <div className="sw-focus" data-swarm-phase={owner.phase} data-swarm-current={current.activity?.kind ?? snapshot.mission.status} data-stale={live && (current.stale || owner.stale)}>
    {(!live || current.stale) && <small>{t(!live ? 'Recorded state' : 'Last observed state')}</small>}
    <strong>{t(current.label)}</strong>
    {current.task && <p>{current.task.title}</p>}
    {current.note && <p className="sw-focus-note">{t(current.note)}</p>}
    {current.member && <p className="sw-focus-note">{current.member.name}{current.activity?.tool ? ` · ${current.activity.tool}` : ''}</p>}
    {current.activity && <p className="sw-focus-note"><span data-swarm-elapsed={current.activity.startedAt}>{t('Elapsed')} {duration!.minutes > 0 ? `${duration!.minutes}${t('min')} ` : ''}{duration!.seconds}{t('sec')}</span>
      {' · '}{t('Activity started')} {timestamp(current.activity.startedAt)}
      {current.activity.kind === 'retry' && current.activity.retryAt && <> · {t('Retry scheduled for')} {timestamp(current.activity.retryAt)}</>}
      {current.activity.kind === 'retry' && current.activity.retryAttempt && <> · {t('Attempt')} {current.activity.retryAttempt}</>}
    </p>}
    {owner.recovery && <p className="sw-focus-note" data-swarm-recovery={owner.recovery.subject}>{t(owner.recovery.action)}
      {owner.recovery.ageMs === undefined ? '' : ` · ${Math.round(owner.recovery.ageMs / 1000)}${t('sec')}`}{owner.recovery.since === undefined ? ` · ${t('start time unknown')}` : ''}</p>}
    {owner.decision && <p className="sw-focus-note" data-swarm-decision={owner.decision.subject}>{t('Waiting for you')}: {owner.decision.subject} · {t('consumption unknown')}</p>}
    {live && (current.stale || owner.stale) && <p className="sw-focus-note">{t('Current execution is unconfirmed until updates resume.')}</p>}
  </div>
}

export function RecentProgress({ snapshot }: { snapshot: Snapshot }) {
  const t = useCopy(), events = recentProgress(snapshot), counts = acceptanceSummary(snapshot)
  return <section className="sw-recent" data-swarm-progress="">
    <div className="sw-row"><h3>{t('Recent progress')}</h3><span className="sw-accepted-count" data-swarm-accepted="">{counts.accepted} / {counts.total} {t('tasks accepted')}</span></div>
    {events.length ? <ol>{events.map(event => <li key={event.seq} data-swarm-progress-event={event.seq}>
      <time dateTime={new Date(event.createdAt).toISOString()}>{timestamp(event.createdAt)}</time>
      <div><p>{t(event.label)}</p>{event.detail && <small>{event.detail}</small>}</div>
    </li>)}</ol> : <p className="sw-muted">{t('No progress events recorded yet.')}</p>}
  </section>
}

export function ResultSummary({ snapshot }: { snapshot: Snapshot }) {
  const t = useCopy(), counts = acceptanceSummary(snapshot)
  return <section className="sw-result-summary" data-swarm-result="" aria-label={t('Acceptance')}>
    <h3>{t('Result and acceptance')}</h3>
    {counts.outputs.map(task => <div key={task.id}><strong>{task.title}</strong><p>{task.output!.slice(0, 1200)}{task.output!.length > 1200 ? '…' : ''}</p></div>)}
    <p>{counts.accepted} / {counts.total} {t('tasks accepted')} · {counts.reviews} {t('independent reviews accepted')}</p>
    {!counts.outputs.length && <p className="sw-muted">{t('Accepted tasks and their evidence are available in the details.')}</p>}
  </section>
}
