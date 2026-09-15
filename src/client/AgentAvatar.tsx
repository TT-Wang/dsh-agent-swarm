import type { CSSProperties } from 'react'
import { agentIdentity } from './agent-identity.ts'
import { useCopy } from './locale.tsx'

export type AgentAvatarState = 'active' | 'waiting' | 'idle' | 'stopped' | 'stale'
export interface AgentAvatarProps {
  id?: string
  name: string
  size?: number
  state?: AgentAvatarState
}

/** Inject once alongside the panel's styles; no SVG IDs or shared definitions. */
export const AGENT_AVATAR_CSS = `
.sw-agent-avatar{display:inline-flex;position:relative;flex:none;vertical-align:middle;line-height:0;isolation:isolate;--sw-avatar-surface:var(--sw-card,#fff);--sw-avatar-foreground:var(--sw-text,#20352e)}
.sw-agent-avatar>svg{display:block;width:100%;height:100%;overflow:visible}
.sw-agent-avatar .sw-agent-avatar-back{fill:color-mix(in srgb,var(--sw-avatar-accent) 10%,var(--sw-avatar-surface))}
.sw-agent-avatar .sw-agent-avatar-shell{fill:color-mix(in srgb,var(--sw-avatar-accent) 50%,var(--sw-avatar-surface));stroke:var(--sw-avatar-accent);stroke-width:1.2}
.sw-agent-avatar .sw-agent-avatar-detail{fill:none;stroke:var(--sw-avatar-accent);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.sw-agent-avatar .sw-agent-avatar-ring{fill:none;stroke:var(--sw-avatar-accent);stroke-linecap:round;pointer-events:none}
.sw-agent-avatar .sw-agent-avatar-track{stroke-width:.55;opacity:.18}
.sw-agent-avatar .sw-agent-avatar-guide{stroke-width:.45;opacity:.12}
.sw-agent-avatar .sw-agent-avatar-orbit{transform-origin:24px 24px;animation:sw-agent-avatar-orbit 7.8s linear infinite}
.sw-agent-avatar .sw-agent-avatar-counter-orbit{transform-origin:24px 24px;animation:sw-agent-avatar-orbit 13.4s linear infinite reverse}
.sw-agent-avatar .sw-agent-avatar-trail{stroke-width:2.8;opacity:.07}
.sw-agent-avatar .sw-agent-avatar-arc{stroke-width:1.05;opacity:.72}
.sw-agent-avatar .sw-agent-avatar-arc-tip{stroke-width:1.35;opacity:.95}
.sw-agent-avatar .sw-agent-avatar-counter-arc{stroke-width:.7;opacity:.4}
.sw-agent-avatar .sw-agent-avatar-orbit-light{fill:var(--sw-avatar-accent);stroke:var(--sw-avatar-surface);stroke-width:.45}
.sw-agent-avatar .sw-agent-avatar-status{stroke:var(--sw-avatar-surface);stroke-width:2}
.sw-agent-avatar[data-state=active] .sw-agent-avatar-status{fill:#2a9d76}
.sw-agent-avatar[data-state=waiting] .sw-agent-avatar-status{fill:#bf9042}
.sw-agent-avatar[data-state=idle] .sw-agent-avatar-status{fill:var(--sw-avatar-surface);stroke:var(--sw-avatar-foreground);stroke-width:1.5}
.sw-agent-avatar[data-state=stopped] .sw-agent-avatar-status{fill:#82938c}
.sw-agent-avatar[data-state=stale] .sw-agent-avatar-status{fill:var(--sw-avatar-surface);stroke:#bf9042;stroke-width:1.5;stroke-dasharray:2 2}
@keyframes sw-agent-avatar-orbit{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.sw-agent-avatar .sw-agent-avatar-orbit,.sw-agent-avatar .sw-agent-avatar-counter-orbit{animation:none}}
`

const PALETTES = [
  { accent: '#4da58f', ink: '#123f3b', eye: '#c9ffea' },
  { accent: '#699dd1', ink: '#1e3657', eye: '#d5edff' },
  { accent: '#b29b61', ink: '#493e26', eye: '#fff0b4' },
  { accent: '#9a86c2', ink: '#3c2f56', eye: '#eee0ff' },
  { accent: '#c18b80', ink: '#56332f', eye: '#ffe5d1' },
  { accent: '#789ca6', ink: '#243e48', eye: '#d9f6f6' },
] as const

const HEADS = [
  'M15 16H33A5 5 0 0 1 38 21V33A6 6 0 0 1 32 39H16A6 6 0 0 1 10 33V21A5 5 0 0 1 15 16Z',
  'M18 15H30L38 22V33L32 39H16L10 33V22Z',
  'M24 15C33 15 38 20 38 28V32C38 37 32 40 24 40S10 37 10 32V28C10 20 15 15 24 15Z',
  'M16 16H32L38 20V32L33 39H15L10 32V20Z',
] as const

const STATE_LABELS: Record<AgentAvatarState, string> = {
  active: 'Working', waiting: 'Waiting for input or dependencies', idle: 'No active task',
  stopped: 'Stopped', stale: 'Current status unconfirmed',
}

/** A recognisable bot portrait; only the outer indicator reflects runtime state. */
export function AgentAvatar({ id, name, size = 40, state }: AgentAvatarProps) {
  const t = useCopy()
  const identity = agentIdentity(id, name)
  const palette = PALETTES[identity.palette]!
  const dimension = Number.isFinite(size) ? Math.min(128, Math.max(20, size)) : 40
  const label = state ? `${name} · ${t(STATE_LABELS[state])}` : name
  return <span className="sw-agent-avatar" data-agent-identity={id || name} data-state={state}
    role="img" aria-label={label} title={label}
    style={{ width: dimension, height: dimension, '--sw-avatar-accent': palette.accent } as CSSProperties}>
    <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect className="sw-agent-avatar-back" x="2" y="2" width="44" height="44" rx="14" />
      {state === 'active' && <g className="sw-agent-avatar-ring">
        <circle className="sw-agent-avatar-track" cx="24" cy="24" r="25" />
        <circle className="sw-agent-avatar-guide" cx="24" cy="24" r="22.8" />
        <g className="sw-agent-avatar-counter-orbit">
          <circle className="sw-agent-avatar-counter-arc" cx="24" cy="24" r="22.8" pathLength="100" strokeDasharray="10 90" strokeDashoffset="-47" />
        </g>
        <g className="sw-agent-avatar-orbit">
          <circle className="sw-agent-avatar-trail" cx="24" cy="24" r="25" pathLength="100" strokeDasharray="18 82" strokeDashoffset="18" />
          <circle className="sw-agent-avatar-arc" cx="24" cy="24" r="25" pathLength="100" strokeDasharray="15 85" strokeDashoffset="15" />
          <circle className="sw-agent-avatar-arc-tip" cx="24" cy="24" r="25" pathLength="100" strokeDasharray="3 97" strokeDashoffset="3" />
          <circle className="sw-agent-avatar-orbit-light" cx="49" cy="24" r="1.05" />
        </g>
      </g>}
      <g className="sw-agent-avatar-detail">
        {identity.antenna === 0 && <><path d="M24 16V10" /><circle cx="24" cy="8" r="2" fill={palette.accent} /></>}
        {identity.antenna === 1 && <><path d="M19 16L16 11M29 16L32 11" /><path d="M14 10H18M30 10H34" /></>}
        {identity.antenna === 2 && <><path d="M24 16V11H29" /><circle cx="31" cy="11" r="1.6" fill={palette.accent} /></>}
        {identity.antenna === 3 && <path d="M19 15V11H29V15M23 8H25" />}
      </g>
      <path d="M10 25H7V31H10M38 25H41V31H38" className="sw-agent-avatar-detail" />
      <path d={HEADS[identity.head]} className="sw-agent-avatar-shell" />
      <rect x="14" y="22" width="20" height="11" rx={identity.head === 1 ? 3 : 5} fill={palette.ink} />
      <g fill={palette.eye} stroke={palette.eye} strokeWidth="1.7" strokeLinecap="round">
        {identity.eyes === 0 && <><circle cx="19.5" cy="27.5" r="1.6" stroke="none" /><circle cx="28.5" cy="27.5" r="1.6" stroke="none" /></>}
        {identity.eyes === 1 && <><path d="M18 28L20 26L22 28M26 28L28 26L30 28" fill="none" /></>}
        {identity.eyes === 2 && <><path d="M19 26V29M29 26V29" /></>}
        {identity.eyes === 3 && <><path d="M18 27H21M27 27H30" /><circle cx="21" cy="25" r=".65" stroke="none" /></>}
      </g>
      {identity.mark === 0 && <path d="M21 36H27" stroke={palette.ink} strokeWidth="1.5" strokeLinecap="round" />}
      {identity.mark === 1 && <><circle cx="22" cy="36" r=".8" fill={palette.ink} /><circle cx="26" cy="36" r=".8" fill={palette.ink} /></>}
      {identity.mark === 2 && <path d="M22 35L24 37L26 35" fill="none" stroke={palette.ink} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />}
      {state && <g>
        <circle className="sw-agent-avatar-status" cx="41" cy="41" r="4.5" />
        {state === 'waiting' && <path d="M39.8 39.5V42.5M42.2 39.5V42.5" stroke="white" strokeWidth="1.1" strokeLinecap="round" />}
        {state === 'stopped' && <path d="M39.4 41H42.6" stroke="white" strokeWidth="1.2" strokeLinecap="round" />}
        {state === 'stale' && <path d="M41 39.3V41.2M41 42.5V42.6" stroke="#a87930" strokeWidth="1.2" strokeLinecap="round" />}
      </g>}
    </svg>
  </span>
}
