import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId, LlmAdapter, MessageId, ReasoningEffortId, freezeMessage } from '@deepseek-ai/dsh-llm'
import { ownerModelSelection } from '../lib/model-selection.js'
import { persistedSessionHeader } from '../lib/session-metadata.js'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import { HarnessWorkers } from '../lib/harness-workers.js'
import { SwarmRuntime } from '../lib/runtime.js'
import { registerTools } from '../lib/tools.js'
import { runProcess } from '../lib/workspaces.js'
import { subprocessSeam, SubprocessLocal } from './subprocess-seam.mjs'

/**
 * The provider-visible system prompt. On hosts through 0.1.3-alpha.2 the loop
 * passed it as `options.system`; from the 0.1.5 line the agent-loop invariant
 * requires `options.system === undefined` and carries the prompt inside
 * `messages` as surface node 0 (a `system`-role message). Reading both keeps one
 * assertion set valid on either host.
 */
const systemTextOf = request => request.system ?? (request.messages ?? [])
  .filter(message => message.role === 'system')
  .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
  .join('\n')

// Actual public storage APIs on each supported release. These helpers preserve
// durability and release alpha.2's explicit handles, including after failures.
async function readStoredSession(persistence, id) {
  if (!('open' in persistence)) return await persistence.readFrom(id, 0)
  const handle = await persistence.open(id, 'read')
  try { return { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, ...(await handle.read()) } }
  finally { await handle.close() }
}
async function appendStoredEvents(persistence, id, events) {
  if (!('open' in persistence)) return await persistence.append(id, events)
  const handle = await persistence.open(id, 'write')
  try { await handle.append(events); await handle.flush() }
  finally { await handle.close() }
}

test('session metadata supports both public persistence contracts without activating sessions', async () => {
  const id = SessionId('metadata-owner')
  const header = { id, cwd: '/fixture' }
  const signal = new AbortController().signal
  const legacy = { async list(received) { assert.equal(received, signal); return [{ id: 'other' }, header] } }
  const modern = {
    async stat(received, options) { assert.equal(received, id); assert.equal(options.signal, signal); return { header } },
    async list() { assert.fail('modern metadata must use stat without listing every session') },
  }
  assert.equal(await persistedSessionHeader(legacy, id, signal), header)
  assert.equal(await persistedSessionHeader(modern, id, signal), header)
  assert.equal(await persistedSessionHeader({ async stat() { return undefined } }, id, signal), undefined)
  assert.equal(await persistedSessionHeader({ async list() { return [] } }, id, signal), undefined)
  const stopped = new AbortController()
  stopped.abort(new Error('metadata request canceled'))
  await assert.rejects(persistedSessionHeader({ async stat() { assert.fail('pre-canceled read') } }, id, stopped.signal), /metadata request canceled/)
  const during = new AbortController()
  await assert.rejects(persistedSessionHeader({ async stat() { during.abort(new Error('canceled during stat')); return { header } } }, id, during.signal), /canceled during stat/)
  await assert.rejects(persistedSessionHeader({ async stat() { throw new Error('storage unavailable') } }, id, signal), /storage unavailable/)
})

async function fixture(t, responder = () => ({ kind: 'text', text: 'done' }), config = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-workers-')))
  const source = path.join(root, 'source')
  await mkdir(source)
  for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Swarm', '-c', 'user.email=swarm@localhost', 'commit', '--allow-empty', '-m', 'base']]) {
    const result = await runProcess(['git', ...args], { subprocess: subprocessSeam, cwd: source, timeoutMs: 30000, maxBytes: 10000 })
    assert.equal(result.exitCode, 0, result.output)
  }
  const ctx = new Context()
  let adapter
  t.after(async () => { await adapter?.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const requests = []
  class Scripted extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, ...config.modelInfo?.(model) } }
    async *stream(options) {
      requests.push(options)
      const action = await responder(options, requests.length)
      // Test hook: hold the provider silent after the request started and before any chunk.
      if (config.beforeChunks !== undefined) await config.beforeChunks(action, options, requests.length)
      if (action.kind === 'tool') {
        const id = ToolCallId(`tool-${requests.length}`)
        const args = JSON.stringify(action.arguments ?? {})
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: action.name, arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: action.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: action.text } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(SystemPrompt, config.systemPromptConfig)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SubprocessLocal)
  await ctx.plugin(JsonlPersistence, { root: path.join(root, 'sessions'), compression: 'none', writeBatchMaxDelayMs: 1 })
  await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: source })
  await ctx.plugin(Approval, { policy: 'never' })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (config.defaults !== undefined) await ctx.plugin(AgentDefaultModel, config.defaults)
  ctx.llm.registerAdapter(['swarm-test', 'other-provider'], new Scripted())
  const owner = await ctx.agents.create({ sessionId: SessionId('owner-session'), meta: { cwd: source }, agentOptions: config.ownerOptions ?? { provider: 'swarm-test', model: 'scripted' } })
  await config.configureOwner?.({ ctx, owner })
  const options = { workspacesRoot: path.join(root, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, ...config.workerOptions }
  let adapterContext = ctx
  let workerOwnerScope
  if (config.scopedOwner) {
    workerOwnerScope = ctx.plugin({ name: 'worker-lifecycle-owner', inject: ['agents', 'sessions'], apply(scope) { adapterContext = scope } })
    await workerOwnerScope
  }
  adapter = new HarnessWorkers(adapterContext, options)
  const observations = { idle: [], steps: [], usage: [], tools: [], failures: [], activities: [] }
  const callbacks = {
    idle: id => { observations.idle.push(id) },
    activity: (id, activity) => { observations.activities.push({ id, activity }) },
    beforeStep: async id => { observations.steps.push(id) },
    usage: async (id, tokens) => { observations.usage.push({ id, tokens }) },
    toolRun: async (id, run) => { observations.tools.push({ id, run }) },
    guard: () => undefined,
    failure: (id, error) => { observations.failures.push({ id, error }) },
  }
  adapter.bind(callbacks)
  const mission = { id: 'mission-test', workspace: source, objective: 'Test durable collaboration' }
  const member = { id: 'worker-test', missionId: mission.id, sessionId: 'worker-session', name: 'worker', role: 'implementer', workspace: await adapter.prepareWorkspace(mission, 'worker-test'), ...config.member }
  const spec = { mission, member, ownerSessionId: 'owner-session' }
  if (config.start !== false) await adapter.start(spec)
  return { ctx, adapter, owner, options, observations, callbacks, mission, member, spec, requests, workerOwnerScope }
}

const message = (member, id = 'delivery-one') => ({ id, missionId: member.missionId, from: 'coordinator-test', to: member.id, kind: 'assignment', content: 'Complete the assigned task.', createdAt: 1 })

async function eventually(read, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(`Timed out waiting for ${what}`)
}
/** The scripted provider reports this per request; cache reads are charged at the adapter weight, buckets stay raw. */
const rawScriptedBuckets = { uncachedInputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 4, outputTokens: 2, reasoningTokens: 1, requests: 1 }

const reasoningModel = model => model === 'plain-model' ? {} : {
  reasoning: { efforts: [{ id: ReasoningEffortId('off'), name: 'Off' }, { id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('off') },
}

test('blank headless owners inherit the public Harness default-model service', async t => {
  const f = await fixture(t, undefined, { ownerOptions: {}, defaults: { provider: 'other-provider', model: 'default-model' } })
  assert.equal(f.owner.agent.session.requestHeader(), undefined)
  await f.adapter.deliver(f.member, message(f.member))
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  assert.equal(f.requests[0].provider, 'other-provider')
  assert.equal(f.requests[0].model, 'default-model')
  assert.deepEqual(f.observations.failures, [])
})

test('v0.1 compositions without a frozen route retain scoped defaults on owner-free resume', async t => {
  const f = await fixture(t)
  await f.adapter.dispose()
  await f.owner.dispose()
  const filename = path.join(f.options.workspacesRoot, f.mission.id, `${f.member.id}.worker.json`)
  const legacy = JSON.parse(await readFile(filename, 'utf8'))
  legacy.options = {}
  delete legacy.selection
  await writeFile(filename, JSON.stringify(legacy))
  f.ctx.on('agent/request', async (_payload, next) => {
    const selected = await next()
    return { ...selected, provider: 'swarm-test', model: 'legacy-default' }
  })
  const resumed = new HarnessWorkers(f.ctx, f.options)
  resumed.bind(f.callbacks)
  try {
    await resumed.start(f.spec)
    await resumed.deliver(f.member, message(f.member, 'legacy-default-resume'))
    await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
    assert.equal(f.requests[0].model, 'legacy-default')
    assert.deepEqual(f.observations.failures, [])
  } finally { await resumed.dispose() }
})

test('durable owner selection is read without provider catalog calls and respects cancellation', async t => {
  let reads = 0
  const f = await fixture(t, undefined, { start: false, configureOwner: async ({ ctx, owner }) => {
    class SlowCatalog extends LlmAdapter {
      async listModels() { reads++; throw new Error('Selection must not request a catalog') }
    }
    ctx.llm.registerAdapter(['slow-catalog'], new SlowCatalog())
    owner.agent.session.append('model/selection', { provider: 'swarm-test', model: 'scripted' })
  } })
  const cancellation = new AbortController()
  cancellation.abort(new Error('owner read canceled'))
  await assert.rejects(ownerModelSelection(f.ctx, f.owner.agent, cancellation.signal), /owner read canceled/)
  await f.adapter.start(f.spec)
  assert.equal(reads, 0)
  await f.adapter.stop(f.member.id)
  assert.equal(f.ctx.agents.get(SessionId(f.member.sessionId)), undefined)
  assert.equal(f.requests.length, 0)
})

test('explicit worker reasoning effort reaches real requests and survives owner-free cold resume', async t => {
  const f = await fixture(t, undefined, { modelInfo: reasoningModel,
    member: { provider: 'other-provider', model: 'reasoning-model', reasoningEffort: 'high' } })
  await f.adapter.deliver(f.member, message(f.member))
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  assert.deepEqual(f.requests.map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort })), [
    { provider: 'other-provider', model: 'reasoning-model', reasoningEffort: 'high' },
  ])
  await f.adapter.dispose()
  await f.owner.dispose()
  const resumed = new HarnessWorkers(f.ctx, f.options)
  resumed.bind(f.callbacks)
  try {
    await resumed.start(f.spec)
    await resumed.deliver(f.member, message(f.member, 'reasoning-after-restart'))
    await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
    assert.equal(f.requests[1].reasoningEffort, 'high')
    assert.equal(f.requests[1].provider, 'other-provider')
    assert.equal(f.requests[1].model, 'reasoning-model')
    assert.deepEqual(f.observations.failures, [])
  } finally { await resumed.dispose() }
})

test('workers inherit a native model and effort switch before the owner sends another request', async t => {
  const f = await fixture(t, undefined, { modelInfo: reasoningModel, configureOwner: async ({ ctx, owner }) => {
    owner.agent.session.append('model/selection', {
      provider: 'other-provider', model: 'reasoning-model', reasoningEffort: 'high',
    })
    assert.equal(owner.agent.session.requestHeader(), undefined, 'durable selection precedes the next owner request')
  } })
  assert.equal(f.owner.agent.options.model, 'scripted', 'native selection does not mutate AgentOptions')
  await f.adapter.deliver(f.member, message(f.member))
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  assert.equal(f.requests[0].provider, 'other-provider')
  assert.equal(f.requests[0].model, 'reasoning-model')
  assert.equal(f.requests[0].reasoningEffort, 'high')
  f.owner.agent.session.append('model/selection', { provider: 'swarm-test', model: 'scripted', reasoningEffort: 'off' })
  await f.adapter.deliver(f.member, message(f.member, 'same-worker-selection'))
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  assert.equal(f.requests[1].model, 'reasoning-model', 'saved worker composition remains independent of later owner changes')
  assert.equal(f.requests[1].reasoningEffort, 'high')
})

for (const override of [undefined, { model: 'plain-model' }]) {
  test(override === undefined ? 'headless workers inherit the owner logged route and effort' : 'a worker model override clears incompatible owner reasoning effort', async t => {
    const f = await fixture(t, undefined, { modelInfo: reasoningModel, member: override, configureOwner: async ({ owner }) => {
      installModelSelection(owner.agent.ctx, { current: { provider: 'other-provider', model: 'reasoning-model', reasoningEffort: ReasoningEffortId('high') }, assembled: undefined })
      owner.agent.send(freezeMessage({ id: MessageId('owner-inheritance'), role: 'user', content: [{ type: 'text', text: 'Initialize owner selection.' }], source: { kind: 'user' } }), 'next-turn', true)
      await owner.agent.whenIdle()
    } })
    await f.adapter.deliver(f.member, message(f.member))
    await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
    assert.equal(f.requests.length, 2)
    assert.equal(f.requests[1].provider, 'other-provider')
    assert.equal(f.requests[1].model, override?.model ?? 'reasoning-model')
    assert.equal(f.requests[1].reasoningEffort, override === undefined ? 'high' : undefined)
    assert.deepEqual(f.observations.failures, [])
  })
}

test('real Agent delivery keeps sender identity, deduplicates across resume, and outlives its initial owner', async t => {
  const f = await fixture(t)
  await f.owner.dispose()
  assert.ok(f.ctx.agents.get(SessionId(f.member.sessionId)), 'worker remains owned by adapter')
  await f.adapter.deliver(f.member, message(f.member))
  const worker = f.ctx.agents.get(SessionId(f.member.sessionId))
  await worker.whenIdle()
  assert.equal(f.requests.length, 1)
  const input = worker.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === 'swarm:delivery-one')
  assert.equal(input.data.source.kind, 'swarm')
  assert.equal(input.data.source.senderMemberId, 'coordinator-test')
  assert.equal(input.data.source.deliveryId, 'delivery-one')
  assert.deepEqual(f.observations.usage.map(item => item.tokens), [17], 'cache counts are disjoint; reasoning is already part of output; cache reads are charged at the 0.1 default weight')
  assert.equal(f.observations.steps.length, 1)
  await f.adapter.deliver(f.member, message(f.member))
  assert.equal(f.requests.length, 1)
  await f.adapter.dispose()
  const resumed = new HarnessWorkers(f.ctx, f.options)
  resumed.bind(f.callbacks)
  try {
    await resumed.start(f.spec)
    await resumed.deliver(f.member, message(f.member))
    assert.equal(f.requests.length, 1, 'accepted durable message is not duplicated after cold resume')
    await resumed.deliver(f.member, message(f.member, 'delivery-two'))
    await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
    assert.equal(f.requests.length, 2)
    assert.deepEqual(f.observations.failures, [])
  } finally { await resumed.dispose() }
})

test('first peer input exposes mission and member identity in provider text after composition resume', async t => {
  const f = await fixture(t)
  await f.adapter.dispose()
  const resumed = new HarnessWorkers(f.ctx, f.options)
  resumed.bind(f.callbacks)
  try {
    await resumed.start(f.spec)
    await resumed.deliver(f.member, { ...message(f.member, 'first-peer-question'), kind: 'question', content: 'Please wait until there is a review assignment.' })
    await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
    assert.equal(f.requests.length, 1)
    const request = f.requests[0]
    // Inspect only provider-visible prompt/text, never host-only message source
    // metadata. The model has received no prior assignment or mission tool call.
    assert.match(systemTextOf(request), /Swarm missionId: mission-test/)
    assert.match(systemTextOf(request), /Your memberId: worker-test/)
    const text = request.messages.flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n')
    assert.match(text, /\[Swarm question; missionId mission-test;/)
    assert.match(text, /Please wait until there is a review assignment/)
    assert.doesNotMatch(text, /\[Swarm assignment;/)
  } finally { await resumed.dispose() }
})

test('scoped monotonic guard blocks real tool execution and records the authoritative error outcome', async t => {
  const f = await fixture(t, (_options, count) => count === 1 ? { kind: 'tool', name: 'probe' } : { kind: 'text', text: 'blocked as expected' })
  let bodies = 0
  f.ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'Probe', parameters: {}, execute: async () => { bodies++; return [{ type: 'text', text: 'executed' }] } }))
  f.callbacks.guard = (_id, tool) => tool === 'probe' ? 'Task scope denies probe' : undefined
  await f.adapter.deliver(f.member, message(f.member))
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  assert.equal(bodies, 0)
  assert.equal(f.observations.tools.length, 1)
  assert.equal(f.observations.tools[0].run.isError, true)
  assert.equal(f.observations.tools[0].run.result.callId, 'tool-1')
  assert.match(JSON.stringify(f.observations.tools[0].run.result), /Task scope denies probe/)
})

test('step admission denial spends no model request and reports a real agent error', async t => {
  const f = await fixture(t)
  f.callbacks.beforeStep = async () => { throw new Error('Mission budget exhausted') }
  await f.adapter.deliver(f.member, message(f.member))
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  assert.equal(f.requests.length, 0)
  assert.match(JSON.stringify(f.observations.failures), /Mission budget exhausted/)
  assert.equal(f.adapter.isIdle(f.member.id), true)
})

for (const wakeDuringRejection of [false, true]) {
  test(`real swarm_wait parks the loop until fresh peer input${wakeDuringRejection ? ' even when that input races the rejected step' : ''}`, async t => {
    let missionId
    const f = await fixture(t, (_options, count) => count === 1
      ? { kind: 'tool', name: 'swarm_wait', arguments: { missionId } }
      : { kind: 'text', text: 'Resumed with fresh peer context.' })
    const adapter = new HarnessWorkers(f.ctx, { ...f.options, workspacesRoot: path.join(f.options.workspacesRoot, 'waiting-runtime') })
    const runtime = new SwarmRuntime({ statePath: path.join(f.options.workspacesRoot, 'waiting.sqlite'), leaseMs: 60000,
      tickMs: 60000, maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 100 }, adapter)
    try {
      const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 10 }
      registerTools(f.ctx, runtime, budget)
      const owner = { sessionId: String(f.owner.agent.id) }
      const mission = runtime.create(owner, { title: 'Wait for evidence', objective: 'Park until useful peer input arrives',
        workspace: f.mission.workspace, scope: ['**'], acceptance: ['resume on input'], budget })
      missionId = mission.id
      const member = await runtime.addMember(owner, mission.id, { name: 'waiting-reviewer', role: 'verification' })
      const worker = f.ctx.agents.get(SessionId(member.sessionId))
      let readyResolve, releaseResolve
      const ready = new Promise(resolve => { readyResolve = resolve })
      const release = new Promise(resolve => { releaseResolve = resolve })
      let assemblies = 0
      if (wakeDuringRejection) worker.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        if (++assemblies === 2) { readyResolve(); await release }
        return await next()
      })
      await adapter.deliver(member, { ...message(member, 'start-waiting'), kind: 'finding', content: 'Wait for evidence from a peer.' })
      if (wakeDuringRejection) {
        await ready
        assert.equal(runtime.store.get('members', member.id).status, 'waiting', 'real tool execution sets the durable waiting state')
        await adapter.deliver(member, { ...message(member, 'fresh-peer-input'), kind: 'finding', content: 'The requested peer evidence has arrived.' })
        releaseResolve()
      } else {
        await worker.whenIdle()
        assert.equal(f.requests.length, 1, 'swarm_wait must prevent an automatic follow-up request')
        assert.equal(runtime.store.get('missions', mission.id).usedSteps, 1, 'the parked step spends no budget')
        assert.ok(worker.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'blocked'), 'waiting ends the live turn gracefully')
        await adapter.deliver(member, { ...message(member, 'fresh-peer-input'), kind: 'finding', content: 'The requested peer evidence has arrived.' })
      }
      await worker.whenIdle()
      assert.equal(f.requests.length, 2, 'only the newly admitted peer input resumes model execution')
      assert.equal(runtime.store.get('missions', mission.id).usedSteps, 2)
      assert.match(JSON.stringify(f.requests[1].messages), /requested peer evidence has arrived/)
      assert.equal(worker.inbox.hasPending, false)
      assert.equal(runtime.store.events(mission.id, 100).some(event => event.type === 'member/failure'), false, 'parking is not reported as an agent failure')
    } finally { await runtime.dispose() }
  })
}

test('owner notifications use the owner inbox without transferring lifecycle ownership', async t => {
  const f = await fixture(t)
  const ownerMember = { id: 'owner', missionId: f.mission.id, sessionId: 'owner-session' }
  const delivery = { ...message(f.member, 'owner-notice'), from: f.member.id, to: 'owner', kind: 'finding' }
  await f.adapter.deliver(ownerMember, delivery)
  await f.owner.agent.whenIdle()
  await f.adapter.deliver(ownerMember, delivery)
  assert.equal(f.requests.length, 1)
  assert.equal(f.owner.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.id === 'swarm:owner-notice').length, 1)
  await f.adapter.dispose()
  assert.equal(f.ctx.agents.get(SessionId('owner-session')), f.owner.agent, 'adapter never disposes the owner')
  await f.owner.dispose()
  const next = new HarnessWorkers(f.ctx, f.options)
  next.bind(f.callbacks)
  try { await assert.rejects(next.deliver(ownerMember, { ...delivery, id: 'later-notice' }), /owner is offline/) }
  finally { await next.dispose() }
})

test('cumulative usage snapshots reconcile persisted work before a resumed worker can request again', async t => {
  const f = await fixture(t)
  let idleResolve
  const waitForAccounting = () => new Promise(resolve => { idleResolve = resolve })
  f.callbacks.idle = () => { idleResolve?.() }
  let accounted = 0
  const snapshots = []
  f.callbacks.usageSnapshot = async (_memberId, total) => {
    snapshots.push(total)
    const stored = await readStoredSession(f.ctx.sessionPersistence, SessionId(f.member.sessionId))
    // Each persisted request is charged 10 + 2 + 4 + 3 × 0.1 = 16.3 → 17 under the default weight.
    const persistedTotal = stored.events.reduce((sum, event) => event.type === 'assistant/message' && event.data.usage ? sum + 17 : sum, 0)
    assert.equal(persistedTotal, total, 'session events are persisted before accounting')
    accounted = Math.max(accounted, total)
  }
  const firstIdle = waitForAccounting()
  await f.adapter.deliver(f.member, message(f.member))
  await firstIdle
  assert.equal(accounted, 17)
  assert.deepEqual(f.observations.usage, [], 'snapshot capability replaces delta accounting')
  await f.adapter.dispose()
  accounted = 0 // Simulate loss of the runtime transaction after the source log committed.
  const resumed = new HarnessWorkers(f.ctx, f.options)
  resumed.bind(f.callbacks)
  try {
    await resumed.start(f.spec)
    assert.equal(accounted, 17)
    assert.deepEqual(snapshots, [17, 17])
    assert.equal(f.requests.length, 1, 'reconciliation completes before another request')
    const nextIdle = waitForAccounting()
    await resumed.deliver(f.member, message(f.member, 'second-usage-message'))
    await nextIdle
    assert.equal(accounted, 34)
    assert.deepEqual(f.observations.failures, [])
  } finally { await resumed.dispose() }
})

test('cache reads are charged at the configured weight while raw buckets stay exact for the UI', async t => {
  const charged = []
  const f = await fixture(t, undefined, { workerOptions: { cacheReadWeight: 0.5 } })
  f.callbacks.usageSnapshot = async (_memberId, total, usage) => { charged.push({ total, usage }) }
  await f.adapter.deliver(f.member, message(f.member))
  await eventually(() => charged.length >= 1, 'the first weighted usage snapshot')
  assert.deepEqual(charged, [{ total: 18, usage: rawScriptedBuckets }],
    '10 uncached + 2 output + 4 cache-write + 3 cache-read × 0.5 = 17.5, charged as 18, while every raw bucket stays exact')
  await f.adapter.deliver(f.member, message(f.member, 'weighted-usage-second'))
  await eventually(() => charged.length >= 2, 'the cumulative weighted usage snapshot')
  assert.equal(charged[1].total, 36, 'the cumulative charge is the sum of per-request charges, not a re-weighted total')
  assert.deepEqual(charged[1].usage, { uncachedInputTokens: 20, cacheReadTokens: 6, cacheWriteTokens: 8, outputTokens: 4, reasoningTokens: 2, requests: 2 },
    'the UI contract stays raw and cumulative')
  assert.deepEqual(f.observations.usage, [], 'the weighted charge replaces delta accounting instead of adding to it')
})

test('a single long model generation republishes liveness without inventing progress', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t, undefined, {
    workerOptions: { activityHeartbeatMs: 20 },
    beforeChunks: (_action, _options, count) => count === 1 ? gate : undefined,
  })
  try {
    await f.adapter.deliver(f.member, message(f.member))
    const first = await eventually(() => f.observations.activities.find(item => item.activity?.kind === 'model'), 'the model activity')
    // The gate holds the provider silent: no chunk arrives, so only the liveness
    // heartbeat can republish the still-running operation.
    await new Promise(resolve => setTimeout(resolve, 140))
    const sameOperation = f.observations.activities.filter(item => item.activity?.id === first.activity.id)
    assert.ok(sameOperation.length >= 3, `a silent generation republishes at least every 20 ms: ${sameOperation.length} publishes`)
    for (let index = 1; index < sameOperation.length; index++) {
      assert.ok(sameOperation[index].activity.updatedAt >= sameOperation[index - 1].activity.updatedAt, 'republished liveness is monotonic')
    }
    const live = f.adapter.currentActivity(f.member.id)
    assert.equal(live.id, first.activity.id); assert.equal(live.kind, 'model')
    assert.equal(sameOperation.every(item => item.activity.attemptId === undefined), true, 'the adapter reports liveness only; the runtime owns the attempt binding')
  } finally { release() }
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  await eventually(() => f.observations.activities.at(-1)?.activity === undefined, 'the model activity to end')
  assert.equal(f.adapter.currentActivity(f.member.id), undefined)
  const settled = f.observations.activities.length
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(f.observations.activities.length, settled, 'an ended operation leaves no heartbeat publishing')
})

test('an active tool execution republishes liveness while its body is blocked', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t, (_options, count) => count === 1 ? { kind: 'tool', name: 'slow_probe', arguments: {} } : { kind: 'text', text: 'done' },
    { workerOptions: { activityHeartbeatMs: 20 } })
  f.ctx.tools.register(defineContentToolFixture({ name: 'slow_probe', description: 'Slow probe', parameters: {}, execute: async () => { await gate; return [{ type: 'text', text: 'probe done' }] } }))
  try {
    await f.adapter.deliver(f.member, message(f.member))
    const first = await eventually(() => f.observations.activities.find(item => item.activity?.kind === 'tool'), 'the tool activity')
    assert.equal(first.activity.tool, 'slow_probe')
    await new Promise(resolve => setTimeout(resolve, 140))
    const sameOperation = f.observations.activities.filter(item => item.activity?.id === first.activity.id)
    assert.ok(sameOperation.length >= 3, `a blocked tool body republishes at least every 20 ms: ${sameOperation.length} publishes`)
    assert.equal(f.adapter.currentActivity(f.member.id).tool, 'slow_probe')
  } finally { release() }
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  await eventually(() => f.observations.activities.at(-1)?.activity === undefined, 'the tool activity to end')
})

test('a silent generation keeps its attempt lease renewed through the runtime with no tool call', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = await fixture(t, undefined, {
    workerOptions: { activityHeartbeatMs: 20 },
    // Hold every provider request silent; abort must still release the gate. The
    // former "first request only" gate let the member's turn end before its silent
    // generation under load, which left a live operation unobservable and turned a
    // lease-liveness property into a harness-start race.
    beforeChunks: (_action, options) => Promise.race([gate, new Promise(resolve => {
      if (options.signal.aborted) resolve()
      else options.signal.addEventListener('abort', resolve, { once: true })
    })]),
  })
  const adapter = new HarnessWorkers(f.ctx, { ...f.options, workspacesRoot: path.join(f.options.workspacesRoot, 'lease-runtime') })
  // The lease is generous relative to the observation window: the property is
  // "a live operation keeps its attempt alive", and a short lease made the model
  // start itself a race under load (the attempt was recovered before the harness
  // could publish its first activity). The decision the property is about is
  // pinned below by driving the durable lease to its expiry boundary, not by
  // waiting for wall-clock time to pass.
  const runtime = new SwarmRuntime({ statePath: path.join(f.options.workspacesRoot, 'lease.sqlite'), leaseMs: 60_000, tickMs: 10,
    maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 100 }, adapter)
  try {
    const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 10 }
    const owner = { sessionId: String(f.owner.agent.id) }
    const mission = runtime.create(owner, { title: 'Lease liveness', objective: 'Survive one silent generation', workspace: f.mission.workspace, scope: ['**'], acceptance: ['survives'], budget })
    const member = await runtime.addMember(owner, mission.id, { name: 'silent-worker', role: 'implementation' })
    const actor = { sessionId: member.sessionId }
    const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Keep the attempt alive' })
    const task = runtime.propose(actor, mission.id, { workstreamId: stream.id, title: 'Long generation', objective: 'Generate without tools', kind: 'implementation', scope: ['**'], acceptance: ['survives'], checks: ['check'] })
    // start() must precede the claim: it treats an already-running task as host-restart recovery.
    await runtime.start()
    // The runtime's own dispatcher can win the race with this explicit claim: its
    // refusal names exactly that outcome ("Task changed while preparing its
    // workspace"). The property under test starts on the next line — the task running
    // under this member with a live operation renewed at its lease boundary — and a
    // claim refused because the dispatcher already moved the row is not a failure of
    // that property. Any other error, or a task that left the runnable states (the
    // dispatcher may be mid-preparation, so pending and running both count), still
    // fails the test unchanged.
    try { await runtime.claim(actor, mission.id, task.id) }
    catch (error) {
      const current = runtime.store.get('tasks', task.id)
      const runnable = current !== undefined && (current.status === 'running' || current.status === 'pending')
      if (!runnable || !/Task changed while preparing its workspace/.test(String(error?.message ?? ''))) throw error
    }
    const running = await eventually(() => { const current = runtime.store.get('tasks', task.id); return current?.status === 'running' ? current : undefined }, 'the task to be running', 30_000)
    const published = await eventually(() => runtime.store.get('members', member.id)?.activity, 'the published activity', 30_000)
    assert.equal(published.attemptId, running.attempt.id, 'the runtime binds the live operation to its attempt')
    // Simulate the runtime dropping the persisted activity (the budget-pause clear in
    // blockBudget): only the adapter's ongoing liveness can restore it before expiry.
    runtime.store.transaction(() => { const stored = runtime.store.get('members', member.id); delete stored.activity; runtime.store.put('members', stored) })
    const restored = await eventually(() => runtime.store.get('members', member.id)?.activity, 'the adapter to restore the persisted activity', 30_000)
    assert.equal(restored.attemptId, running.attempt.id, 'the adapter restored the persisted activity')
    // Drive the durable lease to its expiry boundary (the same nudge the W9 test
    // uses) so the renewal decision is exercised deterministically: with a live
    // activity the runtime must renew, and it may never expire the attempt. The
    // margin is 2 s, not a bare millisecond: the renewal rule fires whenever the
    // lease is inside half of `leaseMs`, and the margin only has to survive heartbeat
    // jitter (20 ms) plus one scheduled tick — a tighter margin made the fixture's own
    // nudge the thing that expired the attempt under load.
    const leaseBefore = Date.now() + 2000
    runtime.store.transaction(() => { const row = runtime.store.get('tasks', task.id); row.attempt.leaseUntil = leaseBefore; runtime.store.put('tasks', row) })
    let observed
    await eventually(() => {
      const after = runtime.store.get('tasks', task.id)
      if (after.attempt === undefined || after.attempt.leaseUntil <= leaseBefore) return undefined
      observed = {
        after,
        activity: runtime.store.get('members', member.id)?.activity,
        expired: runtime.store.events(mission.id, 500).some(event => event.type === 'task/lease-expired'),
      }
      return observed
    }, 'the live operation renews its attempt lease', 30_000)
    assert.equal(observed.after.status, 'running', 'a silent generation is lease liveness for its full duration')
    assert.equal(observed.after.attempt.id, running.attempt.id, 'the original attempt keeps ownership')
    assert.equal(observed.after.recoveryCount ?? 0, 0, 'no recovery is spent while the operation is live')
    assert.equal(observed.expired, false, 'no lease expiry while the operation is live')
    assert.equal(observed.activity.attemptId, running.attempt.id, 'the live operation stays bound to its attempt')
  } finally { release(); await runtime.dispose() }
})

test('revoked assignments never cause a model step while peer findings remain admissible', async t => {
  const f = await fixture(t)
  f.callbacks.admitDelivery = () => false
  await f.adapter.deliver(f.member, message(f.member, 'revoked-assignment'))
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  assert.equal(f.requests.length, 0)
  assert.equal(f.observations.steps.length, 0)
  await f.adapter.deliver(f.member, { ...message(f.member, 'peer-finding'), kind: 'finding', content: 'peer finding survives' })
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  assert.equal(f.requests.length, 1)
  assert.match(JSON.stringify(f.requests[0].messages), /peer finding survives/)
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /revoked-assignment/)
})

test('an admitted assignment arriving behind a rejected stale claim receives its own model turn', async t => {
  const f = await fixture(t)
  const worker = f.ctx.agents.get(SessionId(f.member.sessionId))
  let claimedResolve, releaseResolve
  const claimed = new Promise(resolve => { claimedResolve = resolve })
  const release = new Promise(resolve => { releaseResolve = resolve })
  let firstAssembly = true
  worker.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    if (firstAssembly) {
      firstAssembly = false
      claimedResolve()
      await release
    }
    return await next()
  })
  f.callbacks.admitDelivery = (_memberId, deliveryId) => deliveryId !== 'stale-claimed'
  await f.adapter.deliver(f.member, message(f.member, 'stale-claimed'))
  await claimed
  await f.adapter.deliver(f.member, { ...message(f.member, 'current-assignment'), content: 'Current authorized assignment' })
  await f.adapter.deliver(f.member, { ...message(f.member, 'following-assignment'), content: 'Following authorized assignment' })
  await f.adapter.deliver(f.member, { ...message(f.member, 'pending-peer'), kind: 'finding', content: 'Concurrent peer context' })
  releaseResolve()
  await worker.whenIdle()
  assert.equal(f.requests.length, 2, 'the still-pending authorized wakes must not be stranded by stale-claim rejection')
  assert.match(JSON.stringify(f.requests[0].messages), /Current authorized assignment/)
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /stale-claimed/)
  assert.equal(worker.inbox.hasPending, false)
  const delivered = worker.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'swarm').map(event => event.data.id)
  assert.deepEqual(delivered, ['swarm:pending-peer', 'swarm:current-assignment', 'swarm:following-assignment'], 'existing step/turn priority and FIFO survive without duplicate model input')
})

test('cold setup removes only revoked pending assignments through the durable inbox API', async t => {
  const f = await fixture(t)
  await f.adapter.dispose()
  const id = SessionId(f.member.sessionId)
  const stored = await readStoredSession(f.ctx.sessionPersistence, id)
  const staged = Session.fromRestore(id, stored.events, stored.meta, stored.inheritedEventCount)
  for (const [index, kind] of ['assignment', 'finding'].entries()) staged.append('agent/inbox/spliced', {
    target: 'next-step', start: index,
    inserted: [freezeMessage({ id: MessageId(`swarm:cold-${kind}`), role: 'user',
      content: [{ type: 'text', text: kind === 'assignment' ? 'obsolete assignment' : 'durable peer finding' }],
      source: { kind: 'swarm', form: 'relay', missionId: f.mission.id, senderMemberId: 'peer', deliveryId: `cold-${kind}`, deliveryKind: kind },
    })],
  })
  // This is the public persistence append API, modeling a crash with accepted
  // inbox input that was not yet claimed by a model step.
  await appendStoredEvents(f.ctx.sessionPersistence, id, staged.snapshotEvents(stored.events.length))
  f.callbacks.admitDelivery = () => false
  const resumed = new HarnessWorkers(f.ctx, f.options)
  resumed.bind(f.callbacks)
  try {
    await resumed.start(f.spec)
    const worker = f.ctx.agents.get(id)
    assert.equal(worker.inbox.nextStep.some(item => item.source.kind === 'swarm' && item.source.deliveryKind === 'assignment'), false)
    await resumed.deliver(f.member, { ...message(f.member, 'resume-control'), kind: 'control', content: 'Read the surviving peer context.' })
    await worker.whenIdle()
    assert.match(JSON.stringify(f.requests.map(request => request.messages)), /durable peer finding/)
    assert.doesNotMatch(JSON.stringify(f.requests.map(request => request.messages)), /obsolete assignment/)
    assert.ok(worker.session.snapshotEvents().some(event => event.type === 'agent/inbox/spliced' && event.data.outcome === 'canceled'))
  } finally { await resumed.dispose() }
})


for (const nativeOwnerDisposal of [false, true]) test(`${nativeOwnerDisposal ? 'native owner-fiber disposal' : 'adapter stop'} and cold restart preserve queued questions and findings exactly once while pruning revoked assignments`, async t => {
  const f = await fixture(t, undefined, { scopedOwner: nativeOwnerDisposal })
  const original = f.ctx.agents.get(SessionId(f.member.sessionId))
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  original.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    entered.resolve()
    await release.promise
    return await next()
  })
  await f.adapter.deliver(f.member, message(f.member, 'initial-claim'))
  await entered.promise
  const peers = ['question', 'finding'].map(kind => ({ ...message(f.member, `pending-${kind}`), kind, content: `Durable pending peer ${kind}` }))
  for (const delivery of peers) await f.adapter.deliver(f.member, delivery)
  await f.adapter.deliver(f.member, { ...message(f.member, 'revoked-pending'), content: 'Obsolete pending assignment' })
  assert.equal(original.inbox.nextStep.length, 2)
  assert.equal(original.inbox.nextTurn.length, 1)
  const stopping = nativeOwnerDisposal ? f.workerOwnerScope.dispose() : f.adapter.stop(f.member.id)
  release.resolve()
  await stopping
  if (nativeOwnerDisposal) await assert.doesNotReject(f.adapter.stop(f.member.id), 'adapter drains an already-retired native handle without flushing a detached Session')
  assert.equal(f.requests.length, 0)
  assert.equal(f.ctx.agents.get(SessionId(f.member.sessionId)), undefined)
  f.callbacks.admitDelivery = (_member, deliveryId) => deliveryId !== 'revoked-pending'
  const resumed = new HarnessWorkers(f.ctx, f.options)
  resumed.bind(f.callbacks)
  try {
    await resumed.start(f.spec)
    const worker = f.ctx.agents.get(SessionId(f.member.sessionId))
    for (const delivery of peers) await resumed.deliver(f.member, delivery)
    await resumed.deliver(f.member, { ...message(f.member, 'resume-after-stop'), kind: 'control', content: 'Continue with preserved peer context' })
    await worker.whenIdle()
    const consumed = worker.session.snapshotEvents().filter(event => event.type === 'user/message')
    for (const kind of ['question', 'finding']) assert.equal(consumed.filter(event => event.data.id === `swarm:pending-${kind}`).length, 1)
    assert.match(JSON.stringify(f.requests), /Durable pending peer question/)
    assert.match(JSON.stringify(f.requests), /Durable pending peer finding/)
    assert.doesNotMatch(JSON.stringify(f.requests), /Obsolete pending assignment/)
    assert.equal(worker.inbox.hasPending, false)
    assert.deepEqual(f.observations.failures, [])
  } finally { await resumed.dispose() }
})

test('worker persona shadows both legacy and prefix/suffix deployment personas', async t => {
  const f = await fixture(t, undefined, { systemPromptConfig: {
    persona: 'DEPLOYMENT_SENTINEL_LEGACY',
    personaPrefix: 'DEPLOYMENT_SENTINEL_PREFIX',
    personaSuffix: 'DEPLOYMENT_SENTINEL_SUFFIX',
  } })
  await f.adapter.deliver(f.member, message(f.member))
  await f.ctx.agents.get(SessionId(f.member.sessionId)).whenIdle()
  assert.doesNotMatch(systemTextOf(f.requests[0]), /DEPLOYMENT_SENTINEL/)
  assert.match(systemTextOf(f.requests[0]), /Your role: implementer/)
  assert.equal(systemTextOf(f.requests[0]).match(/Your role: implementer/g).length, 1)
})
