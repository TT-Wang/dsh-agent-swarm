import { useEffect, useState } from 'react'
import type { Member, Snapshot } from '../types.ts'
import { AgentAvatar, type AgentAvatarState } from './AgentAvatar.tsx'
import { projectLiveWork, type LiveWorkProjection, type LiveWorkRow } from './live-work.ts'
import type { ConnectionState } from './progress.ts'
import { useCopy } from './locale.tsx'

export function useLiveWork(snapshot: Snapshot, connection: ConnectionState = 'connected', live = true, observedAt?: number): LiveWorkProjection {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!live || connection !== 'connected' || snapshot.mission.status !== 'active') return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, connection, snapshot.mission.id, snapshot.mission.status])
  return projectLiveWork(snapshot, { connection: live ? connection : 'paused', now: live ? Math.max(now, observedAt ?? 0) : snapshot.mission.updatedAt, observedAt })
}
const duration = (value: number) => { const seconds = Math.max(0, Math.floor(value / 1000)); return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `${seconds}s` }
export function avatarState(row: LiveWorkRow): AgentAvatarState {
  return row.animate ? 'active' : row.state === 'stale' || row.state === 'quiet' ? 'stale'
    : ['paused', 'waiting'].includes(row.state) ? 'waiting' : ['complete', 'stopped'].includes(row.state) ? 'stopped' : 'idle'
}
function Wave({ moving }: { moving: boolean }) {
  return <span className="sw-live-wave" data-moving={moving} aria-hidden="true"><i/><i/><i/><i/></span>
}
function MemberLine({ row, onOpen, compact = false }: { row: LiveWorkRow; onOpen?: (member: Member) => void; compact?: boolean }) {
  const t = useCopy()
  const content = <>
    <AgentAvatar id={row.member.id} name={row.member.name} size={compact ? 32 : 40} state={avatarState(row)} />
    <span className="sw-live-member-body"><span className="sw-live-member-heading"><strong>{row.member.name}</strong><small>{row.member.role}</small><span className="sw-live-operation" data-state={row.state}><Wave moving={row.animate}/>{t(row.label)}</span></span>
      <span className="sw-live-task">{row.task?.title ?? t(row.label)}</span>
      {!compact && <span className="sw-live-timing">{row.activity?.tool && <code>{row.activity.tool}</code>}
        {row.operationDurationMs !== undefined && <span>{t(row.state === 'stale' ? 'Recorded elapsed' : row.state === 'quiet' ? 'Since operation started' : 'Elapsed')} <b>{duration(row.operationDurationMs)}</b></span>}
        {row.ageMs !== undefined && <span>{t('Activity signal')} <b>{duration(row.ageMs)}</b> {t('ago')}</span>}
      </span>}
    </span>{onOpen && <span className="sw-live-open" aria-hidden="true">›</span>}
  </>
  return onOpen ? <button className="sw-live-member" data-state={row.state} data-swarm-member={row.member.id} onClick={() => onOpen(row.member)} aria-label={`${t('Open conversation')}: ${row.member.name}`}>{content}</button>
    : <div className="sw-live-member" data-state={row.state} data-swarm-member={row.member.id}>{content}</div>
}

/** Native activity drives the busy display. No timers produce fake events or completion percentages. */
export function LiveExecution({ view, onOpen }: { view: LiveWorkProjection; onOpen?: (member: Member) => void }) {
  const t = useCopy(), [expanded, setExpanded] = useState(false)
  const active = view.rows.filter(row => row.task || row.activity).sort((a, b) => Number(b.animate) - Number(a.animate) || a.member.id.localeCompare(b.member.id))
  const quiet = active.filter(row => row.state === 'quiet').length
  const connected = view.connection === 'connected'
  const restingLabel = view.rows.find(row => ['paused', 'complete', 'stopped', 'waiting'].includes(row.state))?.label ?? 'Waiting for work'
  const shown = expanded ? active : active.slice(0, 3)
  return <section className="sw-live-view sw-live-execution" aria-label={t('Execution activity')} data-motion={view.workingCount > 0}>
    <div className="sw-live-top"><h3>{t(connected ? 'Execution activity' : 'Recorded execution')}</h3><span className="sw-live-health" data-quiet={quiet > 0 || !connected || !view.live}><i/>{t(!connected ? 'Updates unconfirmed' : !view.live ? restingLabel : quiet > 0 ? 'Waiting for activity confirmation' : view.workingCount > 0 ? 'Receiving activity signals' : 'Waiting for work')}</span></div>
    <div className="sw-live-counters"><span><b>{connected ? view.workingCount : view.lastObservedWorkingCount}</b>{t(connected ? 'observed working' : 'previously working')}</span><span><b>{view.counts.submitted}</b>{t('pending review')}</span><span><b>{view.counts.accepted}</b>{t('accepted')}</span></div>
    {shown.length ? <div className="sw-live-lanes">{shown.map(row => <MemberLine key={row.member.id} row={row} onOpen={onOpen}/>)}</div> : <p className="sw-live-empty">{t('No current worker activity has been observed.')}</p>}
    {active.length > 3 && <button className="sw-live-expand" onClick={() => setExpanded(!expanded)}>{t(expanded ? 'Show fewer members' : 'Show all members')} ({active.length})</button>}
    {view.lastProgressAt !== undefined && <p className="sw-live-empty">{t('Latest recorded work')} · <time dateTime={new Date(view.lastProgressAt).toISOString()}>{new Date(view.lastProgressAt).toLocaleTimeString([], {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time></p>}
    {quiet > 0 && connected && <p className="sw-live-caution">{t('No recent runtime signal. Execution is unconfirmed; this does not mean the task has stopped.')}</p>}
    {!connected && <p className="sw-live-caution">{t('Current execution is unconfirmed until updates resume.')}</p>}
  </section>
}

export function LiveEvents({ view }: { view: LiveWorkProjection }) {
  const t = useCopy()
  return <section className="sw-live-view sw-live-events" data-swarm-progress="" aria-label={t('Recent activity')}>
    <div className="sw-live-top"><h3>{t('Recent activity')}</h3><small>{t('Recorded events only')}</small></div>
    <ol aria-live="polite" aria-relevant="additions">{view.recentEvents.slice(0, 3).map(event => <li key={event.id} data-event-id={event.id} data-kind={event.kind}>
      <span className="sw-live-event-mark" aria-hidden="true">{event.kind === 'milestone' ? '✓' : event.kind === 'tool' ? '⌘' : '·'}</span><div><p>{t(event.label)}</p>{event.detail && <small>{event.detail}</small>}</div>
      <time dateTime={new Date(event.createdAt).toISOString()}>{new Date(event.createdAt).toLocaleTimeString([], {hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>
    </li>)}</ol>
    {!view.recentEvents.length && <p className="sw-live-empty">{t('No progress events recorded yet.')}</p>}
  </section>
}

export function LiveMembers({ view, onOpen, all = false }: { view: LiveWorkProjection; onOpen?: (member: Member) => void; all?: boolean }) {
  const t = useCopy(), [expanded, setExpanded] = useState(false)
  const rows = all ? view.rows : view.rows.filter(row => !row.task && !row.activity)
  return <section className="sw-live-view sw-live-team" data-swarm-team="">
    <button className="sw-live-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><span className="sw-live-portrait-stack">{rows.slice(0, 4).map(row => <AgentAvatar key={row.member.id} id={row.member.id} name={row.member.name} size={26} state={avatarState(row)}/>)}</span><span>{t(all ? 'Team activity' : 'Other members')} · {rows.length}</span><span className="sw-live-open">{expanded ? '⌃' : '⌄'}</span></button>
    {expanded && rows.map(row => <MemberLine key={row.member.id} row={row} compact onOpen={onOpen}/>)}
  </section>
}

export function LiveWorkOverview({ snapshot, connection, live, observedAt, onOpen }: {
  snapshot: Snapshot; connection?: ConnectionState; live?: boolean; observedAt?: number; onOpen?: (member: Member) => void;
}) {
  const view = useLiveWork(snapshot, connection, live, observedAt)
  const finished = ['completed', 'stopped'].includes(snapshot.mission.status)
  return <>{!finished && <LiveExecution view={view} onOpen={onOpen}/>}<LiveEvents view={view}/><LiveMembers view={view} onOpen={onOpen} all={finished}/></>
}

export const LIVE_WORK_CSS = `
.sw-live-view{color:var(--sw-text,#273d30);font-size:12px;line-height:1.5;min-width:0}.sw-live-view button{font:inherit;color:inherit;cursor:pointer}.sw-live-top{display:flex;gap:8px;align-items:center;justify-content:space-between;margin-bottom:11px}.sw-live-top h3{font-size:12px!important;margin:0!important;font-weight:600}.sw-live-top small{color:var(--sw-muted,#7b8b80);font-size:9px}.sw-live-health{display:inline-flex;align-items:center;gap:5px;font-size:9px;color:var(--sw-accent,#488369)}.sw-live-health>i{width:5px;height:5px;background:currentColor;border-radius:50%}.sw-live-health[data-quiet=true]{color:#a18553}.sw-live-counters{display:flex;gap:17px;padding-bottom:13px;border-bottom:1px solid var(--sw-border,#e5ece7);margin-bottom:3px;font-size:10px;color:var(--sw-muted,#7b8b80)}.sw-live-counters>span{display:flex;align-items:baseline;gap:5px}.sw-live-counters b{font-size:19px;color:var(--sw-text,#273d30);font-weight:550;font-variant-numeric:tabular-nums}.sw-live-member{display:flex!important;width:100%;gap:11px;align-items:center;text-align:left;border:0;background:transparent;padding:13px 0!important;border-bottom:1px solid var(--sw-border,#e5ece7);border-radius:0!important}.sw-live-member:last-child{border-bottom:0}.sw-live-member-body{min-width:0;flex:1;display:block}.sw-live-member-heading{display:flex;flex-wrap:wrap;align-items:center;gap:4px 7px}.sw-live-member-heading strong{font-size:12px;font-weight:600}.sw-live-member-heading small{font-size:9px;color:var(--sw-muted,#7b8b80)}.sw-live-operation{margin-left:auto;display:flex;gap:4px;align-items:center;font-size:9px;color:var(--sw-accent,#488369)}.sw-live-operation[data-state=quiet],.sw-live-operation[data-state=waiting]{color:#a18553}.sw-live-operation[data-state=stale],.sw-live-operation[data-state=idle]{color:var(--sw-muted,#7b8b80)}.sw-live-task{display:block;font-size:11px;margin-top:4px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.sw-live-timing{display:flex;flex-wrap:wrap;gap:3px 9px;margin-top:6px;font-size:9px;color:var(--sw-muted,#7b8b80)}.sw-live-timing b{font-family:ui-monospace,monospace;font-weight:400;font-variant-numeric:tabular-nums}.sw-live-timing code{font-size:9px;color:var(--sw-accent,#488369);font-family:ui-monospace,monospace}.sw-live-open{color:var(--sw-muted,#7b8b80);margin-left:auto;font-size:17px}.sw-live-wave{display:inline-flex;align-items:center;gap:2px;height:11px;width:14px}.sw-live-wave i{width:2px;background:currentColor;border-radius:1px;height:3px}.sw-live-wave[data-moving=true] i{animation:sw-live-wave 1.1s ease-in-out infinite alternate}.sw-live-wave i:nth-child(2){animation-delay:-.4s}.sw-live-wave i:nth-child(3){animation-delay:-.8s}.sw-live-wave i:nth-child(4){animation-delay:-.2s}.sw-live-expand{display:flex!important;align-items:center;justify-content:flex-start!important;gap:10px!important;width:100%;background:transparent!important;border:0!important;padding:9px 0!important;font-size:10px!important;color:var(--sw-muted,#7b8b80)!important}.sw-live-portrait-stack{display:inline-flex;padding-right:7px}.sw-live-portrait-stack .sw-agent-avatar{margin-right:-6px}.sw-live-events{margin-top:19px}.sw-live-events ol{list-style:none;padding:0;margin:0}.sw-live-events li{display:flex;gap:9px;align-items:flex-start;padding:9px 0;animation:sw-live-arrival .32s ease-out}.sw-live-event-mark{display:flex;align-items:center;justify-content:center;flex-shrink:0;border-radius:50%;width:19px;height:19px;font-size:10px;color:var(--sw-accent,#488369);background:color-mix(in srgb,var(--sw-accent,#488369) 9%,transparent)}.sw-live-events li>div{min-width:0;flex:1}.sw-live-events li p{font-size:11px;margin:0!important}.sw-live-events li small{display:block;font-size:9px;color:var(--sw-muted,#7b8b80);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;max-width:100%}.sw-live-events time{font-size:9px;color:var(--sw-muted,#7b8b80);font-family:ui-monospace,monospace;padding-top:2px}.sw-live-team{border-top:1px solid var(--sw-border,#e5ece7);margin-top:14px;padding-top:7px}.sw-live-caution,.sw-live-empty{font-size:10px!important;line-height:1.65;margin:10px 0 0!important;color:var(--sw-muted,#7b8b80)}.sw-live-caution{color:#a18553}.sw-live-member:focus-visible,.sw-live-expand:focus-visible{outline:2px solid var(--sw-accent,#488369);outline-offset:3px}@keyframes sw-live-wave{to{height:10px}}@keyframes sw-live-arrival{from{opacity:.4;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.sw-live-wave[data-moving=true] i,.sw-live-events li{animation:none}}@container(max-width:380px){.sw-live-member-heading small{display:none}.sw-live-operation{font-size:8px}.sw-live-health{font-size:8px}.sw-live-counters{gap:10px}.sw-live-member{gap:9px}.sw-live-events time{font-size:8px}}
`
