import { useEffect, useRef, useState } from 'react'
import type { DeliveryApplication, DeliveryInspection, Snapshot, WorkspaceBaseline } from '../types.ts'
import type { Request } from './monitor.ts'
import { useCopy } from './locale.tsx'

export function BaselineNotice({ baseline }: { baseline: WorkspaceBaseline }) {
  const t = useCopy()
  return <p className="sw-notice" data-swarm-baseline={baseline.snapshotCommit}>
    {t('Project snapshot')} <code>{baseline.snapshotCommit.slice(0, 10)}</code>
    {' · '}{baseline.changedPaths.length} {t('existing changed files included')}
    <br />{t('Your branch, staged changes and source files were preserved.')}
  </p>
}

/** Keyed by owner and mission: late requests cannot attach to a different selection. */
export function DeliveryPanel({ snapshot, sessionId, request, onApplied }: {
  snapshot: Snapshot; sessionId: string; request: Request; onApplied: () => void;
}) {
  const t = useCopy()
  const [delivery, setDelivery] = useState<DeliveryInspection>()
  const [result, setResult] = useState<DeliveryApplication>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true), pending = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const run = async (apply: boolean) => {
    if (pending.current || !mounted.current) return
    pending.current = true; setBusy(true); setError('')
    const input = { sessionId, missionId: snapshot.mission.id }
    try {
      if (apply) {
        const response = await request<{ result: DeliveryApplication }>('apply-delivery', input)
        if (mounted.current) { setResult(response.result); onApplied() }
      } else {
        const response = await request<{ delivery: DeliveryInspection }>('delivery', input)
        if (mounted.current) setDelivery(response.delivery)
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return <section className="sw-delivery" aria-label={t('Collaboration result')}>
    <strong>{t('Collaboration result')}</strong>
    <p>{t('Only changes made after the project snapshot are applied. Your staged changes stay as they are.')}</p>
    <div className="sw-controls">
      <button disabled={busy} onClick={() => { void run(false) }}>{t('View changes')}</button>
      <button disabled={busy} onClick={() => { void run(true) }}>{t('Apply result')}</button>
      {busy && <span role="status">{t('Working')}…</span>}
    </div>
    {error && <p className="sw-error" role="alert">{error}</p>}
    {result?.status === 'applied' && <p role="status">{t('Result applied to working files. Nothing was staged, committed or pushed.')}</p>}
    {result?.status === 'conflicts' && <div role="alert" className="sw-error">
      <p>{t('Some files conflict with your current edits. No source files were changed. Resolve these paths against the retained result, then retry.')}</p>
      <ul>{result.conflicts.map(file => <li key={file}><code>{file}</code></li>)}</ul>
    </div>}
    {delivery && <details open><summary>{delivery.changedPaths.length} {t('changed files')}{' · '}
      <code>{delivery.baselineCommit.slice(0, 10)} → {delivery.resultCommit.slice(0, 10)}</code>
    </summary><pre className="sw-delivery-diff">{delivery.diff || t('No changes')}</pre>
      {delivery.truncated && <p>{t('Diff display is truncated. The retained result contains the complete changes.')}</p>}
    </details>}
  </section>
}
