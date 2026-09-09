/**
 * Scripted LLM adapter with injectable provider faults (F3a/F3b/F3c).
 *
 * Only the model boundary is scripted; sessions, the agent loop, tools, the
 * swarm runtime and real git workspaces are real. Each fault mode records that
 * it fired so a scenario can prove the injection took effect before asserting
 * recovery.
 */
import assert from 'node:assert/strict'
import { importHarness } from './loader.mjs'

export const name = 'faults-scripted-llm'
export const inject = ['llm']
export const requests = []
export const faults = { fired: 0, modes: [] }

let script
let nextCall = 0

export function setScript(next) {
  script = next
  requests.length = 0
  faults.fired = 0
  faults.modes = []
  nextCall = 0
}

export async function apply(ctx, config) {
  const { LlmAdapter, ToolCallId } = await importHarness(config.harnessRoot, '@deepseek-ai/dsh-llm')
  class FaultAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }

    async * stream(options) {
      requests.push({ sessionId: options.sessionId, messages: structuredClone(options.messages) })
      const action = await script(options)
      assert(action, 'the fault script must answer every request')
      if (action.kind === 'fault-crash') {
        faults.fired += 1
        faults.modes.push('crash-content')
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: action.partial ?? 'partial content before the crash' }
        throw new Error('injected provider crash on the content field')
      }
      if (action.kind === 'fault-omit') {
        faults.fired += 1
        faults.modes.push('omitted-finish')
        const id = ToolCallId(`fault-omit-${++nextCall}`)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: action.argumentsDelta }
        // No block-end and no finish: the stream is truncated mid-call.
        return
      }
      if (action.kind === 'fault-value') {
        faults.fired += 1
        faults.modes.push('corrupt-tool-value')
        const id = ToolCallId(`fault-value-${++nextCall}`)
        const args = JSON.stringify(action.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: action.name, arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (action.kind === 'tool') {
        const id = ToolCallId(`fault-tool-${++nextCall}`)
        const args = JSON.stringify(action.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: action.name, arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      assert.equal(action.kind, 'text')
      const text = action.text ?? 'done'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['swarm-smoke'], new FaultAdapter()), 'faults.llm')
}
