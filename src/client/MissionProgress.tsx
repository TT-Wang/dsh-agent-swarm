import type { Snapshot } from '../types.ts'
import { acceptanceSummary, activityDuration, currentProgress, sidebarState, type ConnectionState } from './progress.ts'
import { useCopy } from './locale.tsx'
import type { LiveWorkProjection } from './live-work.ts'

function timestamp(value: number): string { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
/** Presentation only: its owner supplies the same realtime view used by the member rows. */
export function MissionProgress({ snapshot, view, connection = 'connected', live = false }: { snapshot: Snapshot; view: LiveWorkProjection; connection?: ConnectionState; live?: boolean }) {
  const t = useCopy(), current = currentProgress(snapshot, connection, view.rows)
  const operation = view.rows.find(row => row.member.id === current.member?.id)
  const unconfirmed = live && operation?.state === 'quiet'
  const duration = current.activity ? activityDuration(0, operation?.operationDurationMs ?? 0) : undefined
  // R15-B: the owner-facing phase, its recovery age and any pending decision are
  // derived from durable rows only (see `sidebarState`); this render adds no
  // timer, request or model turn.
  const owner = sidebarState(snapshot, connection, view.referenceTime)
  return <div className="sw-focus" data-swarm-phase={owner.phase} data-swarm-current={current.activity?.kind ?? snapshot.mission.status} data-stale={live && (current.stale || owner.stale || unconfirmed)}>
    {(!live || current.stale) && <small>{t(!live ? 'Recorded state' : 'Last observed state')}</small>}
    <strong>{t(unconfirmed ? 'Waiting for activity confirmation' : current.label)}</strong>
    {current.task && <p>{current.task.title}</p>}
    {current.note && <p className="sw-focus-note">{t(current.note)}</p>}
    {/* The portrait belongs to the member row; the focus keeps its accessible name. */}
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
    {owner.decision && <p className="sw-focus-note" data-swarm-decision={owner.decision.subject}>{t('Waiting for the main agent')}
      <span className="sw-decision-content" data-swarm-decision-content="">{t(owner.decision.content)}</span></p>}
    {/* OWNER PASS 2026-09-11 (second pass): the projection's label, note, count
        and durable evidence used to be derived and then dropped; they are the
        answer to "why does this line say that", so they are shown here — behind
        one disclosure, so the summary never repeats the headline above it. */}
    <details className="sw-why" data-swarm-owner-state={owner.phase}>
      <summary>{t('Why this state')}</summary>
      <p className="sw-focus-note" data-swarm-owner-label="">{t(owner.label)}{owner.count === undefined ? '' : ` ${owner.count}`}</p>
      {owner.note && <p className="sw-focus-note" data-swarm-owner-note="">{t(owner.note)}</p>}
      {owner.decision && <p className="sw-refs">{owner.decision.subject} · {t('consumption unknown')}</p>}
      <p className="sw-refs">{t('Derived from')}: <span className="sw-code" data-swarm-owner-evidence="">{owner.evidence}</span></p>
    </details>
    {live && (current.stale || owner.stale) && <p className="sw-focus-note">{t('Current execution is unconfirmed until updates resume.')}</p>}
  </div>
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
