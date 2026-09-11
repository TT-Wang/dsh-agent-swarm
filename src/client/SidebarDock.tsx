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
/** The host application root as seen from the dock: a node with inline styles. */
interface ShiftHost {
  parentElement?: ShiftHost | null
  style: { width: string; height: string; minWidth: string; minHeight: string }
}
/**
 * OWNER PASS 2026-09-11 (review C3): reserving the dock's width used to be a CSS
 * rule against the host's `#root` id with `!important`, so the reservation
 * silently stopped working the day the host renamed that node, and the dock then
 * sat on top of the conversation. The target is discovered from the dock's own
 * position instead: walking up from the dock returns the child of `document.body`
 * — whatever the host calls it — and the shift is applied as inline styles, which
 * outrank the host's own rules without `!important`. Returns undefined when the
 * dock itself is a direct child of body, because then there is no host root to
 * move and the dock's own fixed width is already correct.
 */
export function hostShiftTarget(from: ShiftHost | null | undefined, isBody: (node: ShiftHost) => boolean): ShiftHost | undefined {
  let node = from?.parentElement ?? undefined
  while (node) {
    if (isBody(node)) return undefined
    const parent = node.parentElement ?? undefined
    if (parent === undefined) return undefined
    if (isBody(parent)) return node
    node = parent
  }
  return undefined
}
/**
 * How much room the dock takes from the host root, matching the dock's own
 * geometry: side-by-side above 700px, otherwise the dock is a bottom bar and the
 * host keeps full width and gives up height. A property that is absent is one the
 * host keeps as it is.
 */
export function dockShift(expanded: boolean, width: number, viewport: number): { width: string; height?: string } {
  if (viewport <= 700) return { width: '100%', height: expanded ? '55dvh' : 'calc(100dvh - 40px)' }
  return { width: `calc(100% - ${expanded ? width : 28}px)` }
}
export function SidebarDock({ children }: { children: (props: { active: boolean; onClose: () => void }) => ReactNode }) {
  const t = useCopy()
  const [expanded, setExpanded] = useState(false), [preferredWidth, setWidth] = useState(initialWidth)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const dock = useRef<HTMLDivElement>(null)
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
  // C3: the host root is moved by inline style, never by a rule that names its id.
  // Every property this effect touches is restored as it was, so an unload leaves
  // the host exactly as it found it.
  useLayoutEffect(() => {
    const host = hostShiftTarget(dock.current, node => node === document.body)
    if (host === undefined) return
    const { style } = host
    const previous = { width: style.width, height: style.height, minWidth: style.minWidth, minHeight: style.minHeight }
    const shift = dockShift(expanded, width, viewport)
    style.width = shift.width
    style.minWidth = '0'
    if (shift.height !== undefined) { style.height = shift.height; style.minHeight = '0' }
    return () => { style.width = previous.width; style.height = previous.height; style.minWidth = previous.minWidth; style.minHeight = previous.minHeight }
  }, [expanded, width, viewport])
  const start = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { x: event.clientX, width }
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current) setWidth(fitSidebar(gesture.current.width + gesture.current.x - event.clientX, window.innerWidth))
  }
  const end = () => { gesture.current = undefined }
  return <div data-swarm-dock="" data-expanded={expanded} ref={dock}>
    <button data-swarm-launcher="" className="sw-launcher" hidden={expanded} aria-label={t('Open swarm sidebar')} title={t('Open swarm sidebar')} onClick={() => setExpanded(true)}><span aria-hidden="true">◈</span><span>{t('Agent Swarm')}</span></button>
    <div className="sw-dock-body" hidden={!expanded}>{children({ active: expanded, onClose: () => setExpanded(false) })}</div>
    {expanded && <div className="sw-sidebar-resize" role="separator" aria-label={t('Resize sidebar')} aria-orientation="vertical" aria-valuemin={320} aria-valuemax={Math.min(760, Math.max(320, viewport - 400))} aria-valuenow={width} tabIndex={0}
      onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth(fitSidebar(width + (event.key === 'ArrowLeft' ? 20 : -20), viewport)) } }} />}
  </div>
}
