import assert from 'node:assert/strict'
import { importHarness } from './built-harness.mjs'

export const name = 'swarm-smoke-scripted-llm'
export const inject = ['llm']
export const requests = []
let responder
let nextCall = 0

/** Only the network/model boundary is scripted; tools, loops, inboxes and persistence are real. */
export function setResponder(next) {
  responder = next
  requests.length = 0
  nextCall = 0
}

export async function apply(ctx, config) {
  const { LlmAdapter, ToolCallId } = await importHarness(config.harnessRoot, '@deepseek-ai/dsh-llm')
  class ScriptedAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }

    async * stream(options) {
      assert(responder, 'scripted model requires a scenario')
      requests.push({
        sessionId: options.sessionId,
        messages: structuredClone(options.messages),
        system: options.system,
        tools: structuredClone(options.tools),
      })
      const action = await responder(options)
      if (action.kind === 'wait') {
        await new Promise((resolve, reject) => {
          const abort = () => reject(new Error('scripted stream canceled'))
          if (options.signal?.aborted) abort()
          else options.signal?.addEventListener('abort', abort, { once: true })
        })
        return
      }
      if (action.kind === 'tool') {
        const id = ToolCallId(`swarm-smoke-${++nextCall}`)
        const args = JSON.stringify(action.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: action.name, arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      assert.equal(action.kind, 'text')
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: action.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: action.text } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['swarm-smoke'], new ScriptedAdapter()), 'smoke.llm')
}
