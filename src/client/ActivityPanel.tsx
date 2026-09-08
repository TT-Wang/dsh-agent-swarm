import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DraftPlan, Member, Snapshot } from '../types.ts'
import { SwarmMonitor } from './monitor.ts'
import { SwarmBoard } from './SwarmBoard.tsx'
import { DraftEditor } from './DraftEditor.tsx'
import { useCopy } from './locale.tsx'
import { deliverableTask } from './projection.ts'
import { selectedOperation } from './selection.ts'
import { WorkerHistory } from './history.ts'
import { WorkerTranscript } from './WorkerTranscript.tsx'
import { BaselineNotice, DeliveryPanel } from './DeliveryPanel.tsx'
import type { ConnectionState } from './progress.ts'

export const OPEN_MONITOR = 'agent-swarm:open-monitor'
const connectionLabels: Record<ConnectionState, string> = { connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting', paused: 'Updates paused' }
export function ActivityPanel({ sessions, modelDirectories, monitor, history, onOpenWorker, sessionId, active = true, onClose }: {
  sessions: Context['sessions']; modelDirectories: Context['modelDirectories']; monitor: SwarmMonitor;
  history: WorkerHistory; onOpenWorker: (member: Member) => void;
  sessionId?: string; active?: boolean; onClose?: () => void;
}) {
  const t = useCopy()
  const sessionState = useSyncExternalStore(sessions.list.subscribe, sessions.list.getSnapshot, sessions.list.getSnapshot)
  const state = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot, monitor.getSnapshot)
  const transcript = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot)
  const owner = sessionId === undefined ? sessionState.current : sessionId as SessionId
  const [selection, setSelection] = useState(''), [localDraft, setLocalDraft] = useState<DraftPlan>(), [localMission, setLocalMission] = useState<Snapshot>()
  const [error, setError] = useState(''), [busy, setBusy] = useState(''), [stopArmed, setStopArmed] = useState(false), [editorOpen, setEditorOpen] = useState(false)
  const [editorMounted, setEditorMounted] = useState(false)
  useEffect(() => { history.close(); setSelection(''); setLocalDraft(undefined); setLocalMission(undefined); setError(''); setBusy(''); setStopArmed(false); setEditorOpen(false); setEditorMounted(false) }, [owner, monitor, history])
  useEffect(() => { monitor.select(owner, active) }, [active, owner, monitor])
  const data = state.ownerSessionId === owner ? state.data : undefined
  const connection: ConnectionState = state.ownerSessionId === owner ? (state.connection ?? (state.loading ? 'connecting' : state.error ? 'reconnecting' : state.data ? 'connected' : 'connecting')) : 'connecting'
  const starts = data?.starts ?? []
  const latestStart = [...starts].sort((a, b) => b.createdAt - a.createdAt)[0]
  const autoDraftIds = new Set(starts.map(item => item.draftId))
  useEffect(() => {
    if (latestStart?.missionId) { history.close(); setSelection(`mission:${latestStart.missionId}`) }
  }, [latestStart?.id, latestStart?.missionId, history])
  const snapshots = [...(data?.snapshots ?? [])]
  if (state.ownerSessionId === owner && localMission) {
    const index = snapshots.findIndex(item => item.mission.id === localMission.mission.id)
    if (index < 0) snapshots.unshift(localMission)
    else if (snapshots[index]!.mission.updatedAt < localMission.mission.updatedAt) snapshots[index] = localMission
  }
  const drafts = [...(data?.drafts ?? [])].filter(item => !autoDraftIds.has(item.id) && ['draft', 'launching', 'failed'].includes(item.status))
  if (state.ownerSessionId === owner && localDraft) {
    const index = drafts.findIndex(item => item.id === localDraft.id)
    if (index < 0 && !data?.drafts.some(item => item.id === localDraft.id && item.status !== 'draft')) drafts.unshift(localDraft)
    else if (index >= 0 && drafts[index]!.revision < localDraft.revision) drafts[index] = localDraft
  }
  const knownSelection = selection === 'new' || drafts.some(item => `draft:${item.id}` === selection) || snapshots.some(item => `mission:${item.mission.id}` === selection)
  const launchedSelection = data?.drafts.find(item => `draft:${item.id}` === selection && item.status === 'launched')?.missionId
  const selected = knownSelection ? selection : launchedSelection ? `mission:${launchedSelection}` : drafts[0] ? `draft:${drafts[0].id}` : snapshots[0] ? `mission:${snapshots[0].mission.id}` : ''
  const showMissionPicker = drafts.length + snapshots.length > 1 || (selected === 'new' && drafts.length + snapshots.length > 0)
  const draft = drafts.find(item => `draft:${item.id}` === selected)
  const snapshot = snapshots.find(item => `mission:${item.mission.id}` === selected)
  const selectedContext = useRef({ key: '', generation: 0 })
  const context = `${owner ?? ''}:${selected}`
  if (selectedContext.current.key !== context) selectedContext.current = { key: context, generation: selectedContext.current.generation + 1 }
  const generation = selectedContext.current.generation
  const stillSelected = () => selectedContext.current.key === context && selectedContext.current.generation === generation
  const selectedStart = snapshot ? starts.find(item => item.missionId === snapshot.mission.id) : selected === 'new' || draft ? undefined : latestStart
  const start = selectedStart && ['planning', 'launching', 'failed'].includes(selectedStart.status) ? selectedStart : undefined
  const directory = useMemo(() => {
    if (!owner || (!sessionId && sessionState.currentAddress)) return undefined
    try { return modelDirectories.directoryFor(owner) } catch { return undefined }
  }, [owner, sessionId, modelDirectories, sessionState.currentAddress])
  const choose = (value: string) => { history.close(); setSelection(value); setError(''); setBusy(''); setStopArmed(false); setEditorOpen(false); setEditorMounted(false) }
  const control = async (action: 'pause' | 'resume' | 'stop' | 'complete') => {
    if (!owner || !snapshot || !data?.writable || connection !== 'connected') return
    setBusy(action); setError('')
    await selectedOperation(stillSelected,
      () => monitor.request<{ snapshot: Snapshot }>('control', { sessionId: owner, missionId: snapshot.mission.id, action, reason: `User selected ${action} in the Agent Swarm monitor.` }), {
        success: async result => { setLocalMission(result.snapshot); setStopArmed(false); await monitor.refresh() },
        failure: failure => setError(failure instanceof Error ? failure.message : String(failure)),
        settled: () => setBusy(''),
      })
  }
  const disabled = Boolean(busy) || connection !== 'connected'
  const status = snapshot?.mission.status
  const controls = snapshot && <div className="sw-mission-controls" data-swarm-mission={snapshot.mission.id}>
    <span data-swarm-status={status} className="sw-sr-only">{t(status!)}</span>
    {data?.writable && status === 'active' && <button data-action="pause" disabled={disabled} onClick={() => { void control('pause') }}>{t('Pause')}</button>}
    {data?.writable && ['paused', 'blocked'].includes(status!) && <button data-action="resume" disabled={disabled} onClick={() => { void control('resume') }}>{t('Resume')}</button>}
    {busy && <span role="status">{t('Working')}…</span>}
  </div>
  const advancedControls = snapshot && data?.writable && !['completed', 'stopped', 'staged'].includes(status!) && <div className="sw-mission-controls">
    {!starts.some(item => item.missionId === snapshot.mission.id) && <button data-action="complete" disabled={disabled || !snapshot.tasks.length || snapshot.tasks.some(task => !['accepted', 'cancelled'].includes(task.status) && !(task.experiment && task.status === 'blocked'))} onClick={() => { void control('complete') }}>{t('Complete')}</button>}
    <button data-action="stop" disabled={disabled} onClick={() => stopArmed ? void control('stop') : setStopArmed(true)}>{t(stopArmed ? 'Confirm stop' : 'Stop')}</button>
    {stopArmed && <span className="sw-small">{t('Stop ends this mission and its workers.')} <button onClick={() => setStopArmed(false)}>{t('Cancel')}</button></span>}
  </div>
  return <aside data-swarm="" data-swarm-panel="" data-swarm-session={owner} aria-label={t('Mission control')}>
    <header className="sw-panel-title">
      <div><strong>{t('Agent Swarm')}</strong><small data-swarm-connection={connection}><span className="sw-live-dot" data-connection={connection} />{t(connectionLabels[connection])}</small></div>
      {onClose && <div className="sw-panel-buttons"><button title={t('Collapse sidebar')} aria-label={t('Collapse sidebar')} onClick={onClose}>›</button></div>}
    </header>
    <div className="sw-panel-toolbar">{showMissionPicker && <select aria-label={t('Missions')} value={selected} onChange={event => choose(event.currentTarget.value)}>
      {!drafts.length && !snapshots.length && <option value="">{t('No missions yet')}</option>}
      {drafts.length > 0 && <optgroup label={t('Drafts')}>{drafts.map(item => <option key={item.id} value={`draft:${item.id}`}>{item.input.title || t('New mission')} · {t(item.status)}</option>)}</optgroup>}
      {snapshots.length > 0 && <optgroup label={t('Missions')}>{snapshots.map(item => <option key={item.mission.id} value={`mission:${item.mission.id}`}>{item.mission.title} · {t(item.mission.status)}</option>)}</optgroup>}
      {selected === 'new' && <option value="new">{t('New mission')}</option>}
    </select>}<button disabled={!owner || !data?.writable} onClick={() => choose('new')}>{t('New mission')}</button><button aria-label={t('Refresh')} onClick={() => { void monitor.refresh() }}>↻</button></div>
    <div className="sw-panel-content">
      {transcript.sessionId ? <WorkerTranscript history={history} /> : <>
      {((state.ownerSessionId === owner && state.error) || error) && <div className="sw-error" role="alert">{error || state.error}</div>}
      {connection === 'reconnecting' && state.updatedAt && <p className="sw-connection-note">{t('Last synchronized')} {new Date(state.updatedAt).toLocaleTimeString()} · {t('Task execution status is unconfirmed.')}</p>}
      {!owner ? <div className="sw-empty">{t('Select a conversation to manage its missions.')}</div> : !data ? <div className="sw-empty">{t(state.loading ? 'Loading mission state…' : 'Swarm bridge is unavailable. Refresh to retry.')}</div> : null}
      {data && !data.writable && <p className="sw-notice">{t('Mission controls are read-only in worker conversations. Open the owner conversation to manage this mission.')}</p>}
      {start && <section className="sw-auto-start" data-swarm-start={start.status} role="status">
        <strong>{t(start.status === 'planning' ? 'Planning collaboration…' : start.status === 'launching' ? 'Starting workers…' : 'Collaboration could not start')}</strong>
        <p>{start.goal}</p>
        {['planning', 'launching'].includes(start.status) && <small>{t('Choosing roles, tasks and checks automatically using this conversation’s model.')}</small>}
        {start.error && <p className="sw-error" role="alert">{start.error}</p>}
        {start.baseline && !snapshot && <details><summary>{t('Project snapshot')}</summary><BaselineNotice baseline={start.baseline} /></details>}
      </section>}
      {owner && data && !snapshot && !start && <div className="sw-start-guide" data-swarm-natural-start="">
        <h2>{draft?.input.title || t('Start a collaboration')}</h2>
        <p>{t('Start from the conversation input:')}</p><code>/agent-swarm {t('Describe what you want to accomplish')}</code>
        <p>{t('Roles, tasks and verification are set up automatically.')}</p>
        {draft && <p className="sw-muted">{t('A saved draft is available in advanced settings.')}</p>}
      </div>}
      {owner && data?.writable && !snapshot && !start && <details className="sw-disclosure" data-swarm-details="editor" open={editorOpen} onToggle={event => { setEditorOpen(event.currentTarget.open); if (event.currentTarget.open) setEditorMounted(true) }}>
        <summary>{t('Advanced: configure a mission')}</summary>
        {editorMounted && <DraftEditor key={`${owner}:${draft?.id ?? 'new'}`} sessionId={owner} workspace={data.workspace} budget={data.defaultBudget} draft={draft} directory={directory} request={monitor.request} ownerLive={data.ownerLive} isSelected={stillSelected}
          onSaved={value => { if (!stillSelected()) return; setLocalDraft(value); setSelection(`draft:${value.id}`); void monitor.refresh() }}
          onLaunched={value => { if (!stillSelected()) return; setLocalDraft(undefined); setLocalMission(value); setSelection(`mission:${value.mission.id}`); void monitor.refresh() }}
          onDiscarded={() => { if (!stillSelected()) return; setLocalDraft(undefined); setSelection(''); void monitor.refresh() }} />}
      </details>}
      {snapshot && <SwarmBoard key={`${owner}:${snapshot.mission.id}`} snapshot={snapshot} live connection={connection} actions={controls}
        technicalDetails={<>{snapshot.mission.baseline && <BaselineNotice baseline={snapshot.mission.baseline} />}{advancedControls}</>}
        delivery={owner && data?.writable && snapshot.mission.status === 'completed' && snapshot.mission.baseline && deliverableTask(snapshot) ?
          <DeliveryPanel key={`${owner}:${snapshot.mission.id}`} snapshot={snapshot} sessionId={owner} request={monitor.request} onApplied={() => { void monitor.refresh() }} disabled={connection !== 'connected'} /> : undefined}
        onOpenWorker={member => { try { onOpenWorker(member) } catch (failure) { if (stillSelected()) setError(String(failure)) } }} />}
      </>}
    </div>
  </aside>
}
