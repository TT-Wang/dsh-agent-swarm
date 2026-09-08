import { useSyncExternalStore } from 'react'
import { WorkerHistory, transcriptEntry } from './history.ts'
import { useCopy } from './locale.tsx'

export function WorkerTranscript({ history }: { history: WorkerHistory }) {
  const t = useCopy(), state = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot)
  return <section className="sw-transcript" data-swarm-transcript={state.sessionId}>
    <div className="sw-row"><div><h2>{state.title}</h2><p className="sw-small">{t('Read-only worker transcript from native session history.')}</p></div>
      <button data-action="close-transcript" onClick={history.close}>{t('Back to mission')}</button></div>
    <p className="sw-refs">{state.sessionId}</p>
    {state.error && <div className="sw-error" role="alert">{state.error}</div>}
    {state.hasMore && <button data-action="load-older" disabled={state.loading} onClick={() => { void history.load() }}>{t(state.loading ? 'Loading history…' : state.entries.length ? 'Load older messages' : 'Retry history')}</button>}
    {state.entries.map(entry => {
      const view = transcriptEntry(entry)
      if (!view) return null
      const text = view.text.length > 40_000 ? `${view.text.slice(0, 40_000)}\n[${t('Display limited to 40,000 characters for this entry.')}]` : view.text
      return <article className="sw-transcript-entry" key={entry.event.seq}><div className="sw-row"><strong>{t(view.role)}</strong><span className="sw-small">#{entry.event.seq}</span></div><pre>{text || t('No text content')}</pre></article>
    })}
    {!state.loading && !state.entries.length && !state.error && <div className="sw-empty">{t('No messages recorded.')}</div>}
    <details><summary>{t('Session event index')}</summary><div className="sw-refs">{state.entries.map(entry => <div key={entry.event.seq}>#{entry.event.seq} · {entry.event.type}</div>)}</div></details>
  </section>
}
