import type { Snapshot } from '../types.ts'
import { useEffect, useState } from 'react'
import { avatarCells } from './avatar.ts'
import { acceptanceSummary, activityDuration, currentProgress, recentProgress, sidebarState, type ConnectionState } from './progress.ts'
import { useCopy } from './locale.tsx'

function timestamp(value: number): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
/**
 * R17-G12: the worker's sprite, drawn inline as `<rect>`s with `crispEdges`.
 * It is decoration derived from the name, so it is `aria-hidden` — identity
 * stays with the name text — and it adds no image asset, no request, no
 * dependency and no model turn.
 */
export function WorkerAvatar({ name }: { name: string }) {
  const sprite = avatarCells(name), size = sprite.grid * sprite.cell
  return <svg className="sw-worker-avatar" aria-hidden="true" focusable="false" role="presentation"
    width={size} height={size} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
    {sprite.cells.map(cell => <rect key={`${cell.x}:${cell.y}`} x={cell.x * sprite.cell} y={cell.y * sprite.cell}
      width={sprite.cell} height={sprite.cell} fill={cell.color} />)}
  </svg>
}
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
    {/* OWNER PASS 2026-09-11: the member sprite lives in the member's own row
        (`TeamActivity`), not floating in the mission focus line, and the row is
        also where the member's progress bar is. This line keeps the name for
        screen readers and the focus contract without drawing a second avatar. */}
    {current.member && <p className="sw-focus-note sw-person" data-swarm-member={current.member.id}
      data-swarm-worker-name={current.member.name} data-swarm-worker-role={current.member.role}>
      {`${current.member.name} · ${current.member.role}`}{current.activity?.tool ? ` · ${current.activity.tool}` : ''}
    </p>}
    {current.activity && <p className="sw-focus-note"><span data-swarm-elapsed={current.activity.startedAt}>{t('Elapsed')} {duration!.minutes > 0 ? `${duration!.minutes}${t('min')} ` : ''}{duration!.seconds}{t('sec')}</span>
      {' · '}{t('Activity started')} {timestamp(current.activity.startedAt)}
      {current.activity.kind === 'retry' && current.activity.retryAt && <> · {t('Retry scheduled for')} {timestamp(current.activity.retryAt)}</>}
      {current.activity.kind === 'retry' && current.activity.retryAttempt && <> · {t('Attempt')} {current.activity.retryAttempt}</>}
    </p>}
    {owner.recovery && <p className="sw-focus-note" data-swarm-recovery={owner.recovery.subject}>{t(owner.recovery.action)}
      {owner.recovery.ageMs === undefined ? '' : ` · ${Math.round(owner.recovery.ageMs / 1000)}${t('sec')}`}{owner.recovery.since === undefined ? ` · ${t('start time unknown')}` : ''}</p>}
    {owner.decision && <p className="sw-focus-note" data-swarm-decision={owner.decision.subject}>{t('Waiting for you')}: {owner.decision.subject} · {t('consumption unknown')}
      <span className="sw-decision-content" data-swarm-decision-content="">{t(owner.decision.content)}</span></p>}
    {/* OWNER PASS 2026-09-11 (second pass): the projection's label, note, count
        and durable evidence used to be derived and then dropped; they are the
        answer to "why does this line say that", so they are shown here — behind
        one disclosure, so the summary never repeats the headline above it. */}
    <details className="sw-why" data-swarm-owner-state={owner.phase}>
      <summary>{t('Why this state')}</summary>
      <p className="sw-focus-note" data-swarm-owner-label="">{t(owner.label)}{owner.count === undefined ? '' : ` ${owner.count}`}</p>
      {owner.note && <p className="sw-focus-note" data-swarm-owner-note="">{t(owner.note)}</p>}
      <p className="sw-refs">{t('Derived from')}: <span className="sw-code" data-swarm-owner-evidence="">{owner.evidence}</span></p>
    </details>
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
