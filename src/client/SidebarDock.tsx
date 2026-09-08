import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode, PointerEvent } from 'react'
import { OPEN_MONITOR } from './ActivityPanel.tsx'
import { useCopy } from './locale.tsx'

/** The fallback shares viewport space with DSH; it never covers the conversation. */
export function fitSidebar(width: number, viewport: number): number {
  return Math.min(Math.max(320, Number.isFinite(width) ? width : 480), 760, Math.max(320, viewport - 400))
}
function initialWidth(): number {
  try { const value = Number(localStorage.getItem('agent-swarm.sidebar-width')); if (value >= 320) return value } catch { /* Optional preference. */ }
  return 480
}
export function SidebarDock({ children }: { children: (props: { active: boolean; onClose: () => void }) => ReactNode }) {
  const t = useCopy()
  const [expanded, setExpanded] = useState(false), [preferredWidth, setWidth] = useState(initialWidth)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const gesture = useRef<{ x: number; width: number }>()
  const width = fitSidebar(preferredWidth, viewport)
  useEffect(() => {
    const open = () => setExpanded(true), resize = () => setViewport(window.innerWidth)
    window.addEventListener(OPEN_MONITOR, open); window.addEventListener('resize', resize)
    return () => { window.removeEventListener(OPEN_MONITOR, open); window.removeEventListener('resize', resize) }
  }, [])
  useEffect(() => { try { localStorage.setItem('agent-swarm.sidebar-width', String(preferredWidth)) } catch { /* Optional preference. */ } }, [preferredWidth])
  useLayoutEffect(() => {
    const body = document.body
    body.setAttribute('data-swarm-docked', expanded ? 'open' : 'closed')
    body.style.setProperty('--swarm-dock-width', `${expanded ? width : 28}px`)
    return () => { body.removeAttribute('data-swarm-docked'); body.style.removeProperty('--swarm-dock-width') }
  }, [expanded, width])
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { x: event.clientX, width }
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current) setWidth(fitSidebar(gesture.current.width + gesture.current.x - event.clientX, window.innerWidth))
  }
  const end = () => { gesture.current = undefined }
  return <div data-swarm-dock="" data-expanded={expanded}>
    <button data-swarm-launcher="" className="sw-launcher" hidden={expanded} aria-label={t('Open swarm sidebar')} title={t('Open swarm sidebar')} onClick={() => setExpanded(true)}><span aria-hidden="true">◈</span><span>{t('Agent Swarm')}</span></button>
    <div className="sw-dock-body" hidden={!expanded}>{children({ active: expanded, onClose: () => setExpanded(false) })}</div>
    {expanded && <div className="sw-sidebar-resize" role="separator" aria-label={t('Resize sidebar')} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={Math.min(760, Math.max(320, viewport - 400))} aria-valuenow={width} tabIndex={0}
      onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(fitSidebar(width + (event.key === 'ArrowLeft' ? 20 : -20), viewport)) } }} />}
  </div>
}
