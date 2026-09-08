/** Native tool-event folding follows the public Harness conversation extension contract.
 * Architectural reference: NanmiCoder/dsh-agent-teams (MIT), commit 1caff61f.
 * The implementation uses Harness ui-conversation assembly and ui-chat rendering.
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Snapshot } from '../types.ts'
import { snapshotFromResult } from './projection.ts'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'agent-swarm': Snapshot }
}

export interface SwarmCardState { snapshot?: Snapshot }

/** One versioned snapshot per explicit create/observe call, replayed through native history access. */
export const swarmCardDefinition: ConversationNodeDefinition<SwarmCardState> = {
  kind: 'agent-swarm', target: 'chat',
  match(event) {
    if (event.type === 'tool/call' && ['swarm_create', 'swarm_launch', 'swarm_observe'].includes(event.data.name)) {
      return { id: String(event.data.callId), role: 'start' }
    }
    if (event.type === 'tool/result' && event.data.message.source.kind === 'tool') {
      return { id: String(event.data.message.source.callId), role: 'update' }
    }
    return null
  },
  start: () => ({}),
  update(context, match) {
    if (match.event.type !== 'tool/result' || match.event.data.error !== undefined
      || match.event.data.message.content.some(block => block.type === 'tool-result' && block.isError === true)) return context.state
    const snapshot = snapshotFromResult(match.event.data.meta, match.event.data.message.content)
    return snapshot === undefined ? context.state : { snapshot }
  },
  buildViewNode(context): ChatConversationViewNode | null {
    const snapshot = context.state?.snapshot
    if (snapshot === undefined || context.start === undefined) return null
    return { key: context.key, kind: 'agent-swarm', id: context.id, target: 'chat',
      anchorSeq: context.start.event.seq, location: context.start.location,
      visibility: 'visible', data: snapshot }
  },
}
