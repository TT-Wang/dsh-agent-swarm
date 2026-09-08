/** Real Harness tool registry and prompt assembly: sessions see only their role's swarm tools and protocol. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { HarnessWorkers } from '../lib/harness-workers.js'
import { SwarmRuntime } from '../lib/runtime.js'
import { RoleScoper } from '../lib/roles.js'
import { registerTools, ENTRY_PROMPT, OWNER_PROMPT, WORKER_PROMPT, SWARM_PROMPT, MEMBER_TOOLS, MANAGEMENT_TOOLS, OWNER_SESSION_TOOLS, SWARM_TOOLS } from '../lib/tools.js'
import { runProcess } from '../lib/workspaces.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 12, maxExperiments: 2 }
const swarmNames = tools => (tools ?? []).map(tool => tool.name).filter(name => name.startsWith('swarm_')).sort()

async function fixture(t, responder, workerOptions = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-roles-')))
  const source = path.join(root, 'source')
  await mkdir(source)
  for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Swarm', '-c', 'user.email=swarm@localhost', 'commit', '--allow-empty', '-m', 'base']]) {
    const result = await runProcess(['git', ...args], { cwd: source, timeoutMs: 30000, maxBytes: 10000 })
    assert.equal(result.exitCode, 0, result.output)
  }
  const ctx = new Context()
  const requests = []
  class Scripted extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      requests.push(options)
      const action = await responder(options, requests.length)
      if (action.kind === 'tool') {
        const id = ToolCallId(`tool-${requests.length}`), args = JSON.stringify(action.arguments ?? {})
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: action.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: action.name, arguments: args } }
      } else {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: action.text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: action.text } }
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 1 } }
      yield { type: 'finish', reason: { kind: action.kind === 'tool' ? 'tool-calls' : 'stop' } }
    }
  }
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjection); await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlPersistence, { root: path.join(root, 'sessions'), compression: 'none', writeBatchMaxDelayMs: 1 })
  await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: source }); await ctx.plugin(Approval, { policy: 'never' })
  await ctx.plugin(UserQuestionService); await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['swarm-test'], new Scripted())
  const options = { workspacesRoot: path.join(root, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, ...workerOptions }
  const workers = new HarnessWorkers(ctx, options)
  const runtime = new SwarmRuntime({ statePath: path.join(root, 'swarm.sqlite'), leaseMs: 60000, tickMs: 20, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  registerTools(ctx, runtime, budget)
  ctx.systemPrompt.section({ name: 'swarm:usage', order: 119, text: SWARM_PROMPT })
  const scoper = new RoleScoper(ctx, runtime)
  await runtime.start()
  t.after(async () => { scoper.dispose(); await runtime.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  return { ctx, runtime, workers, requests, source, scoper }
}
const prompt = text => ({ kind: 'text', text })

test('an ordinary session sees the entry set and prompt; owning a request promotes it to the owner set before its planning turn', async t => {
  const f = await fixture(t, () => prompt('ok'))
  const owner = await f.ctx.agents.create({ sessionId: SessionId('owner-session'), meta: { cwd: f.source }, agentOptions: { provider: 'swarm-test', model: 'scripted' } })
  const visible = () => swarmNames(f.ctx.tools.schemas(owner.agent))
  assert.deepEqual(visible(), SWARM_TOOLS.filter(name => !MEMBER_TOOLS.includes(name) && !OWNER_SESSION_TOOLS.includes(name)).sort())
  owner.agent.followup({ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
  await owner.agent.whenIdle()
  assert.deepEqual(swarmNames(f.requests[0].tools), visible())
  assert.match(f.requests[0].system, new RegExp(ENTRY_PROMPT.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(f.requests[0].system, /owner protocol/)
  // A durable automatic request promotes the session synchronously on commit.
  f.runtime.requestStart({ sessionId: 'owner-session' }, { commandId: 'c1', goal: 'Do it', workspace: f.source })
  assert.deepEqual(visible(), SWARM_TOOLS.filter(name => !MEMBER_TOOLS.includes(name)).sort())
  owner.agent.followup({ id: 'm2', role: 'user', content: [{ type: 'text', text: 'plan' }], source: { kind: 'user' } })
  await owner.agent.whenIdle()
  assert.deepEqual(swarmNames(f.requests[1].tools), visible())
  assert.match(f.requests[1].system, /Agent Swarm owner protocol/)
  assert.equal((f.requests[1].system.match(/scope contains only repository-relative paths/g) ?? []).length, 1, 'planning rules appear exactly once')
  assert.doesNotMatch(f.requests[1].system, new RegExp(ENTRY_PROMPT.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the entry prompt is shadowed, not duplicated')
  // The old global prompt (3844 chars) plus the planning rules repeated in every planning message (1687) exceeded the owner prompt alone.
  assert(OWNER_PROMPT.length < 3844 + 1687 && ENTRY_PROMPT.length < 800 && WORKER_PROMPT.length < 1600, `role prompts stay compact: ${OWNER_PROMPT.length}/${ENTRY_PROMPT.length}/${WORKER_PROMPT.length}`)
  // Owner usage is attributed to the planning request without charging any worker pool.
  const start = f.runtime.starts({ sessionId: 'owner-session' })[0]
  assert.deepEqual(start.ownerUsage, { uncachedInputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 4, outputTokens: 2, reasoningTokens: 1, requests: 1 }, 'only the request after promotion is attributed')
})

test('subagent sessions see no swarm tools, and unloading the scoper restores the global view', async t => {
  const f = await fixture(t, () => prompt('ok'))
  const parent = await f.ctx.agents.create({ sessionId: SessionId('parent-session'), meta: { cwd: f.source }, agentOptions: { provider: 'swarm-test', model: 'scripted' } })
  const child = await f.ctx.agents.create({ sessionId: SessionId('child-session'), meta: { cwd: f.source, origin: 'subagent', parentSession: parent.agent.id }, agentOptions: { provider: 'swarm-test', model: 'scripted' } })
  assert.deepEqual(swarmNames(f.ctx.tools.schemas(child.agent)), [])
  f.scoper.dispose()
  assert.deepEqual(swarmNames(f.ctx.tools.schemas(child.agent)), [...SWARM_TOOLS].sort())
})

test('workers see only member tools and the member protocol, and each tool result carries its durable run id', async t => {
  let missionId
  const f = await fixture(t, options => {
    if (options.sessionId === 'owner-session') return prompt('owner idle')
    // Runtime-context snapshots follow the assignment, and provider serialization carries content rather than
    // Harness source metadata: inspect the whole request text. One probe per assignment; its result ends the turn.
    const all = JSON.stringify(options.messages)
    if (all.includes('probe executed') || all.includes('swarm toolRunId')) return prompt('worker done')
    return all.includes('[Swarm assignment;') ? { kind: 'tool', name: 'probe', arguments: {} } : prompt('worker idle')
  })
  f.ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'Probe', parameters: {}, execute: async () => [{ type: 'text', text: 'probe executed' }] }))
  const owner = await f.ctx.agents.create({ sessionId: SessionId('owner-session'), meta: { cwd: f.source }, agentOptions: { provider: 'swarm-test', model: 'scripted' } })
  const actor = { sessionId: 'owner-session' }
  const mission = f.runtime.create(actor, { title: 'Roles', objective: 'Scope tools by role', workspace: f.source, scope: ['**'], acceptance: ['done'], budget })
  missionId = mission.id
  const stream = f.runtime.workstream(actor, missionId, { title: 'Main', objective: 'Main' })
  const builder = await f.runtime.addMember(actor, missionId, { name: 'Builder', role: 'implementation' })
  await f.runtime.addMember(actor, missionId, { name: 'Reviewer', role: 'verification' })
  const worker = f.ctx.agents.get(SessionId(builder.sessionId))
  assert.ok(worker, 'the adapter started a real worker agent')
  assert.deepEqual(swarmNames(f.ctx.tools.schemas(worker)), SWARM_TOOLS.filter(name => !MANAGEMENT_TOOLS.includes(name)).sort())
  assert.deepEqual(swarmNames(f.ctx.tools.schemas(owner.agent)), SWARM_TOOLS.filter(name => !MEMBER_TOOLS.includes(name)).sort(), 'creating a mission promotes the owner')
  const task = f.runtime.propose(actor, missionId, { workstreamId: stream.id, title: 'Probe', objective: 'Run the probe', kind: 'research', scope: ['**'], acceptance: ['done'], assigneeId: builder.id })
  const diagnostics = () => JSON.stringify({ task: f.runtime.store.get('tasks', task.id)?.status, worker: worker.status, runs: f.runtime.store.list('tool_runs', missionId).length,
    builderRequests: f.requests.filter(r => r.sessionId === builder.sessionId).map(r => JSON.stringify(r.messages.at(-1)).slice(0, 200)),
    events: f.runtime.store.events(missionId, 12).map(e => [e.type, JSON.stringify(e.data).slice(0, 160)]),
    deliveries: f.runtime.store.list('deliveries', missionId).map(d => [d.kind, d.to, Boolean(d.deliveredAt)]),
    workerEvents: worker.session.snapshotEvents().map(e => e.type).slice(-12), inbox: worker.inbox.hasPending })
  const eventually = async (read, what) => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 20)) }
    assert.fail(`${what}: ${diagnostics()}`)
  }
  const running = await eventually(() => { const current = f.runtime.store.get('tasks', task.id); return current.status === 'running' ? current : undefined }, 'assignment')
  assert.equal(running.attempt.ownerId, builder.id)
  await eventually(() => f.runtime.store.list('tool_runs', missionId).length > 0 && worker.status === 'idle', 'probe recorded and worker idle')
  const runs = f.runtime.store.list('tool_runs', missionId)
  assert.equal(runs.length, 1); assert.equal(runs[0].tool, 'probe'); assert.equal(runs[0].seq, 1)
  assert.equal(runs[0].result.value, undefined, 'the execution-local value is not persisted')
  const workerRequest = f.requests.find(request => request.sessionId === builder.sessionId && request.tools?.some(tool => tool.name === 'probe'))
  assert.ok(workerRequest)
  const seen = f.requests.filter(request => request.sessionId === builder.sessionId).some(request => JSON.stringify(request.messages).includes(`[swarm toolRunId: ${runs[0].id}]`))
  assert.equal(seen, true, 'the model sees the recorded run id at the end of its tool result')
  assert.match(JSON.stringify(worker.session.snapshotEvents().filter(event => event.type === 'tool/result')), new RegExp(runs[0].id), 'the durable log carries the same id')
  assert.deepEqual(swarmNames(workerRequest.tools), SWARM_TOOLS.filter(name => !MANAGEMENT_TOOLS.includes(name)).sort())
  assert.match(workerRequest.system, /Swarm member protocol/); assert.doesNotMatch(workerRequest.system, /owner protocol/)
  assert.match(workerRequest.system, new RegExp(`Your memberId: ${builder.id}`))
  const stored = f.runtime.store.get('members', builder.id)
  assert.equal(stored.usage.requests >= 1, true); assert.equal(stored.usage.reasoningTokens, stored.usage.requests)
  assert.deepEqual(f.runtime.store.get('missions', missionId).workerUsage.requests, stored.usage.requests + f.runtime.store.list('members', missionId).filter(m => m.id !== builder.id).reduce((sum, m) => sum + (m.usage?.requests ?? 0), 0))
})

test('boundary compaction uses the native engine only when idle and over the prompt-pressure threshold, once per boundary', async t => {
  // The scripted provider reports 17 prompt tokens per request; the default threshold (250000) ignores them, a low one compacts.
  for (const [threshold, expected] of [[undefined, 0], [10, 1]]) {
    const f = await fixture(t, () => prompt('worker idle'), threshold === undefined ? {} : { boundaryCompactionTokens: threshold })
    const compacted = []
    f.ctx.provide('compaction', { async compactNow(agent, signal) { compacted.push({ id: String(agent.id), aborted: signal.aborted }); return null } })
    const actor = { sessionId: 'owner-session' }
    await f.ctx.agents.create({ sessionId: SessionId('owner-session'), meta: { cwd: f.source }, agentOptions: { provider: 'swarm-test', model: 'scripted' } })
    const mission = f.runtime.create(actor, { title: 'Compaction', objective: 'Trim history at boundaries', workspace: f.source, scope: ['**'], acceptance: ['done'], budget })
    const builder = await f.runtime.addMember(actor, mission.id, { name: 'Builder', role: 'implementation' })
    const worker = f.ctx.agents.get(SessionId(builder.sessionId))
    f.workers.compactAtBoundary(builder.id)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.deepEqual(compacted, [], 'no request yet: nothing to compact')
    await f.workers.deliver(builder, { id: 'd1', missionId: mission.id, from: 'owner', to: builder.id, kind: 'question', content: 'Say hello.', createdAt: 1 })
    await worker.whenIdle()
    f.workers.compactAtBoundary(builder.id)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(compacted.length, expected, `threshold ${threshold}: ${JSON.stringify(compacted)}`)
    if (expected) assert.deepEqual(compacted, [{ id: builder.sessionId, aborted: false }])
    f.workers.compactAtBoundary(builder.id)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(compacted.length, expected, 'the same boundary never compacts twice without a new request')
  }
})
