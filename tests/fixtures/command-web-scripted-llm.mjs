import assert from 'node:assert/strict'
import { access, appendFile } from 'node:fs/promises'
import { importHarness } from './built-harness.mjs'

export const name = 'swarm-command-web-scripted-llm'
export const inject = ['llm']

/** Only model output is controlled: the web product, transport, tools and workers are real. */
export async function apply(ctx, config) {
  const { LlmAdapter, ToolCallId } = await importHarness(config.harnessRoot, '@deepseek-ai/dsh-llm')
  const owners = new Set()
  const confirmations = new Set()
  const repairs = new Map()
  const scripts = new Map()
  let nextCall = 0
  const trace = entry => appendFile(config.tracePath, JSON.stringify(entry) + '\n')
  const texts = message => message.content.filter(block => block.type === 'text').map(block => block.text)
  const blocks = messages => messages.flatMap(message => message.content.filter(block => block.type === 'tool-result'))
  const resultBody = block => JSON.parse(texts(block).join('\n'))
  const tool = (name, args) => ({ kind: 'tool', name, args })
  const answer = text => ({ kind: 'text', text })
  async function released(signal, path = config.releasePath) {
    while (true) {
      signal?.throwIfAborted()
      try { await access(path); return } catch (error) { if (error.code !== 'ENOENT') throw error }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  ctx.on('session/event', (session, event) => {
    if (event.type === 'tool/call') void trace({ type: event.type, sessionId: session.header.id, name: event.data.name })
    if (event.type === 'command/run' || event.type === 'command/done') void trace({ type: event.type, sessionId: session.header.id, data: event.data })
    if (event.type === 'user/message') void trace({ type: event.type, sessionId: session.header.id, sourceKind: event.data.source.kind })
  })
  async function action(options) {
    const lastResult = blocks(options.messages).at(-1)
    const assignmentMessage = options.messages.findLast(message => texts(message).some(text => text.startsWith('[Swarm assignment;')))
    if (!assignmentMessage) {
      const startMessage = options.messages.findLast(message => message.source?.kind === 'swarm-start')
      if (!startMessage) return answer('The actual web model loop is connected.')
      const requestId = startMessage.source.requestId
      assert.equal(typeof requestId, 'string', 'automatic start must carry durable request identity')
      assert(texts(startMessage).some(text => text.includes(requestId)), 'planning context must preserve request identity for swarm_launch')
      const repair = repairs.get(requestId)
      if (config.validationRepair && repair?.stage === 'rejected') {
        assert(lastResult?.isError, 'the first invalid plan must return a normal model-visible tool error')
        const message = texts(lastResult).join('\n')
        assert.match(message, /scope\[0\]/, 'the error must locate the invalid mission selector')
        assert.match(message, /tasks\[0\]\.checks/, 'the same error must locate the missing code verification command')
        await trace({ type: 'owner/validation-error', sessionId: options.sessionId, requestId, message })
        // Only the fixture model pauses here. The real command, owner inbox and
        // browser continue normally while the test verifies no partial launch.
        await released(options.signal, config.releaseRepairPath)
        repair.stage = 'inspect'
        return tool('bash', { command: 'git ls-files -- value.cjs check.cjs && cat check.cjs', description: 'Inspect the actual scoped filename and existing verification script before repairing the plan.' })
      }
      if (lastResult?.isError) {
        await trace({ type: 'fixture/error', sessionId: options.sessionId, message: texts(lastResult).join('\n') })
        return answer('Fixture observed an unexpected tool failure; stopping this turn.')
      }
      if (config.validationRepair && repair?.stage === 'inspect') {
        const inspected = texts(lastResult).join('\n')
        assert.match(inspected, /value\.cjs/)
        assert.match(inspected, /check\.cjs/)
        assert.match(inspected, /VERIFIED_TWO/)
        const corrected = structuredClone(repair.plan)
        corrected.scope = ['value.cjs']
        corrected.tasks[0].scope = ['value.cjs']
        corrected.tasks[0].checks = ['node check.cjs']
        repair.stage = 'launched'
        await trace({ type: 'owner/repair', sessionId: options.sessionId, requestId, inspected, plan: corrected })
        return tool('swarm_launch', corrected)
      }
      if (owners.has(requestId)) {
        if (confirmations.has(requestId)) return answer('收到协作进度更新，具体状态和验收结果见侧边栏。')
        confirmations.add(requestId)
        return answer('协作任务已自动启动，侧边栏会持续显示进展。')
      }
      await released(options.signal, config.releasePlanningPath)
      owners.add(requestId)
      await trace({ type: 'owner/session', sessionId: options.sessionId, requestId })
      const plan = {
        requestId,
        title: 'Automatic browser delivery', objective: 'Deliver an independently checked value of two.',
        scope: ['value.cjs'], acceptance: ['value.cjs exports two and node check.cjs passes'],
        budget: { maxTokens: 120_000, maxSteps: 60, maxWorkers: 2, maxDurationMs: 180_000, maxTasks: 8, maxExperiments: 2 },
        members: [
          { key: 'builder', name: 'builder', role: 'implementation and integration', maxOutputTokens: 4096 },
          { key: 'reviewer', name: 'reviewer', role: 'independent verifier', maxOutputTokens: 4096 },
        ],
        workstreams: [{ key: 'delivery', title: 'Value delivery', objective: 'Change and independently verify the exported value.' }],
        tasks: [
          { key: 'implement', workstreamKey: 'delivery', title: 'Deliver value two', objective: 'Change value.cjs to export two and record host evidence.', kind: 'integration', scope: ['value.cjs'], acceptance: ['value.cjs exports two and node check.cjs passes'], checks: ['node check.cjs'], checkTimeoutMs: 30_000, maxRecoveryAttempts: 3, assigneeKey: 'builder' },
          { key: 'review', workstreamKey: 'delivery', title: 'Independent review', objective: 'Verify the exact submitted artifact using swarm_verify.', kind: 'verification', reviewOf: 'implement', scope: ['value.cjs'], acceptance: ['value.cjs exports two and node check.cjs passes'], maxRecoveryAttempts: 3, checkTimeoutMs: 30_000, assigneeKey: 'reviewer' },
        ],
      }
      if (config.validationRepair) {
        plan.scope = ['*.cjs']
        plan.tasks[0].scope = ['*.cjs']
        delete plan.tasks[0].checks
        // This redundant review edge is harmless and is intentionally retained
        // on retry to exercise canonicalization at the real launch boundary.
        plan.tasks[1].dependencies = ['implement']
        repairs.set(requestId, { stage: 'rejected', plan: structuredClone(plan) })
        await trace({ type: 'owner/invalid-plan', sessionId: options.sessionId, requestId, plan })
      }
      return tool('swarm_launch', plan)
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
    }).find(body => body?.snapshot)
    assert(observation, 'worker must see the real board through swarm_observe')
    const task = observation.snapshot.tasks.find(task => task.id === assignment.task.id)
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
      await trace({ type: 'model/request', sessionId: options.sessionId, model: options.model, reasoningEffort: options.reasoningEffort, maxTokens: options.maxTokens })
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
