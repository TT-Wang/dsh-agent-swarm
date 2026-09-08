import assert from 'node:assert/strict'
import { access, appendFile } from 'node:fs/promises'
import { importHarness } from './built-harness.mjs'

export const name = 'swarm-web-scripted-llm'
export const inject = ['llm']

/** Only model output is controlled: the web product, transport, tools and workers are real. */
export async function apply(ctx, config) {
  const { LlmAdapter, ToolCallId } = await importHarness(config.harnessRoot, '@deepseek-ai/dsh-llm')
  const owners = new Set()
  const confirmations = new Set()
  const scripts = new Map()
  let nextCall = 0
  const trace = entry => appendFile(config.tracePath, JSON.stringify(entry) + '\n')
  const texts = message => message.content.filter(block => block.type === 'text').map(block => block.text)
  const blocks = messages => messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
  const resultBody = block => JSON.parse(texts(block).join('\n'))
  const tool = (name, args) => ({ kind: 'tool', name, args })
  const answer = text => ({ kind: 'text', text })
  async function released(signal) {
    while (true) {
      signal?.throwIfAborted()
      try { await access(config.releasePath); return } catch (error) { if (error.code !== 'ENOENT') throw error }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') void trace({ type: event.type, sessionId: session.header.id, name: event.data.name })
  })
  async function action(options) {
    const lastResult = blocks(options.messages).at(-1)
    if (lastResult?.isError) {
      await trace({ type: 'fixture/error', sessionId: options.sessionId, message: texts(lastResult).join('\n') })
      return answer('Fixture observed a tool failure; stopping this turn.')
    }
    const assignmentMessage = options.messages.findLast(message => texts(message).some(text => text.startsWith('[Swarm assignment;')))
    const ownerPrompt = options.messages.flatMap(texts).findLast(text => text.startsWith('Prepare a staged swarm for browser validation.'))
    if (!assignmentMessage) {
      if (!ownerPrompt) return answer('The real web model loop is connected.')
      const ownerTurn = `${options.sessionId}:${ownerPrompt}`
      if (owners.has(ownerTurn)) {
        if (confirmations.has(ownerTurn)) return answer('Mission update received.')
        confirmations.add(ownerTurn)
        return answer('Draft ready for review. Edit the workers and launch when ready.')
      }
      owners.add(ownerTurn)
      await trace({ type: 'owner/session', sessionId: options.sessionId })
      return tool('swarm_stage', {
        title: 'Browser staged delivery', objective: 'Deliver an independently checked value of two.', workspace: config.workspace,
        scope: ['value.cjs'], acceptance: ['value.cjs exports two and node check.cjs passes'],
        budget: { maxTokens: 50_000, maxSteps: 60, maxWorkers: 2, maxDurationMs: 180_000, maxTasks: 6, maxExperiments: 1 },
        members: [
          { key: 'builder', name: 'builder', role: 'implementation and integration', provider: 'deepseek-official', model: 'swarm-web-primary' },
          { key: 'reviewer', name: 'reviewer', role: 'independent verifier', provider: 'deepseek-official', model: 'swarm-web-review' },
        ],
        workstreams: [{ key: 'delivery', title: 'Value delivery', objective: 'Change and independently verify the exported value.' }],
        tasks: [
          { key: 'implement', workstreamKey: 'delivery', title: 'Deliver value two', objective: 'Change value.cjs to export two and record host evidence.', kind: 'integration', scope: ['value.cjs'], acceptance: ['value.cjs exports two and node check.cjs passes'], checks: ['node check.cjs'], assigneeKey: 'builder' },
          { key: 'review', workstreamKey: 'delivery', title: 'Independent review', objective: 'Verify the exact submitted artifact using swarm_verify.', kind: 'verification', reviewOf: 'implement', scope: ['value.cjs'], acceptance: ['value.cjs exports two and node check.cjs passes'], assigneeKey: 'reviewer' },
        ],
      })
    }
    await released(options.signal)
    const text = texts(assignmentMessage).join('\n')
    const assignment = JSON.parse(text.slice(text.indexOf('\n') + 1))
    const key = `${options.sessionId}:${assignment.task.attempt.id}`
    const previous = blocks(options.messages).at(-1)
    if (previous?.isError) {
      await trace({ type: 'fixture/error', sessionId: options.sessionId, message: texts(previous).join('\n') })
      return answer('Fixture observed a tool failure; stopping this turn.')
    }
    let script = scripts.get(key)
    if (!script) { script = { stage: 'work' }; scripts.set(key, script); return tool('swarm_observe', { missionId: assignment.missionId }) }
    if (script.stage === 'done') return answer('Assignment finished; awaiting further work.')
    const observation = blocks(options.messages).toReversed().map(block => {
      try { return resultBody(block) } catch { return undefined }
    }).find(body => body?.result?.member !== undefined && body.result.current?.task?.id === assignment.task.id)
    assert(observation, 'worker must see its focused task view through swarm_observe')
    const task = observation.result.current.task
    const current = { missionId: assignment.missionId, taskId: task.id, attemptId: task.attempt.id }
    if (task.kind === 'verification') { script.stage = 'done'; return tool('swarm_verify', { ...current, verdict: 'accept', reason: 'The host independently executes the declared check against the submitted commit.' }) }
    if (script.stage === 'work') { script.stage = 'record'; return tool('bash', { command: "printf 'module.exports = 2\\n' > value.cjs && node check.cjs", description: 'Implement and check the scoped fixture change.' }) }
    if (script.stage === 'record') { script.stage = 'publish'; return tool('swarm_observe', { missionId: assignment.missionId }) }
    if (script.stage === 'publish') {
      const runs = observation.result.toolRuns.filter(run => run.taskId === task.id && run.tool === 'bash' && !run.isError)
      assert(runs.length, 'host-recorded successful bash execution must exist')
      script.stage = 'submit'
      return tool('swarm_publish', { ...current, claim: 'The value is two and the check passes.', outcome: 'supported', toolRunIds: runs.map(run => run.id) })
    }
    script.stage = 'done'
    return tool('swarm_submit', { ...current, output: 'The scoped value change is ready for independent verification.' })
  }
  const modelInfo = (provider, model) => ({ provider, id: model, name: model, contextWindow: 1_000_000,
    reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'off' },
  })
  class WebAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Swarm browser fixture' } }
    async listModels(provider) { return ['swarm-web-primary', 'swarm-web-review'].map(model => modelInfo(provider, model)) }
    async resolveModel(provider, model) { return modelInfo(provider, model) }
    async *stream(options) {
      await trace({ type: 'model/request', sessionId: options.sessionId, model: options.model, reasoningEffort: options.reasoningEffort })
      const response = await action(options)
      if (response.kind === 'tool') {
        const id = ToolCallId(`swarm-web-${++nextCall}`)
        const args = JSON.stringify(response.args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: response.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: response.name, arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const text = response.text
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['deepseek-official'], new WebAdapter()), 'swarm.web.fixture')
}
