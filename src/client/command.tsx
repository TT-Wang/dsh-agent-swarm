import type { Context } from '@deepseek-ai/cordis'
import type { CommandRowOwnerProps, CommandRowProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { useSyncExternalStore } from 'react'

export const SWARM_COMMAND = 'agent-swarm'

interface CommandUiOptions {
  openSidebar(): void
  copy(text: string): string
}

/** The native command log owns the original goal and settled outcome. */
export function SwarmCommandCard({ node, onOpenSidebar, copy = text => text }: CommandRowOwnerProps & {
  onOpenSidebar(): void
  copy?: (text: string) => string
}) {
  const pending = node.outcome === null
  const failed = node.outcome?.kind === 'error'
  const goal = node.args?.trim()
  return <section data-swarm data-swarm-command aria-label={copy('Agent Swarm request')}>
    <div style={{ padding: '14px 16px', display: 'grid', gap: 10 }}>
      <div className="sw-row"><strong>/agent-swarm</strong>
        <button className="sw-open-monitor" type="button" onClick={onOpenSidebar}>{copy('Open swarm sidebar')} ›</button>
      </div>
      {goal && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{goal}</p>}
      <p role={failed ? 'alert' : 'status'} aria-live="polite" className={failed ? 'sw-notice' : 'sw-objective'} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
        {pending ? copy('Starting collaboration…') : node.outcome?.text ?? copy('Collaboration requested')}
      </p>
    </div>
  </section>
}

/**
 * The HOST command descriptor's input hint registers discovery and free-form
 * input with native ui-commands. Client contributions support popup selection
 * only and would collide with that descriptor, so this adapter owns presentation
 * and the local command acknowledgment, never parsing or submitting composer text.
 */
export function registerSwarmCommandUi(ctx: Context, { openSidebar, copy }: CommandUiOptions): void {
  ctx.on('command/executed', (sessionId, name, result) => {
    if (name === SWARM_COMMAND && result.kind === 'success' && ctx.sessions.list.getSnapshot().current === sessionId) openSidebar()
  })
  function CommandCard({ node, sessionId }: CommandRowProps) {
    useSyncExternalStore(listener => ctx.locale.subscribe(listener), () => ctx.locale.getSnapshot(), () => ctx.locale.getSnapshot())
    return <SwarmCommandCard node={node} copy={copy} onOpenSidebar={() => {
      if (ctx.sessions.list.getSnapshot().current === sessionId) openSidebar()
    }} />
  }
  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({
    name: 'conversation.chat.commandview', key: SWARM_COMMAND,
  }, CommandCard))
}
