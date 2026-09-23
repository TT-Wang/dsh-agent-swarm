/** Native owner consumer regression: full plugin composition, scripted local model. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId, LlmAdapter, MessageId, freezeMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import Invariants from '@deepseek-ai/dsh-invariants'
import * as Swarm from '../lib/index.js'
import { runProcess } from '../lib/workspaces.js'
import { subprocessSeam, SubprocessLocal } from './subprocess-seam.mjs'
import { tempDirectory } from './temp-root.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const text = value => ({ kind: 'text', text: value })
const input = (id, content) => freezeMessage({ id: MessageId(id), role: 'user', content: [{ type: 'text', text: content }], source: { kind: 'user' } })
async function fixture(t, respond = () => text('Done'), configure) {
  const root = await realpath(await tempDirectory('swarm-owner-native-'))
  const source = path.join(root, 'source'); await mkdir(source)
  for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Swarm', '-c', 'user.email=swarm@localhost', 'commit', '--allow-empty', '-m', 'base']]) {
    const result = await runProcess(['git', ...args], { subprocess: subprocessSeam, cwd: source, timeoutMs: 30000, maxBytes: 10000 })
    assert.equal(result.exitCode, 0, result.output)
  }
  const ctx = new Context(), requests = []
  t.after(async () => { await ctx.get('swarm')?.dispose(); await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  class Scripted extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model } }
    async *stream(options) {
      requests.push(options)
      const action = await respond(options, requests.length)
      const block = action.kind === 'tool'
        ? { type: 'tool-call', id: ToolCallId(`tool-${requests.length}`), name: 'native_probe', arguments: '{}' }
        : { type: 'text', text: action.text }
      yield { type: 'block-start', index: 0, blockType: block.type }
      if (block.type === 'tool-call') yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      else yield { type: 'text-delta', index: 0, text: block.text }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: block.type === 'tool-call' ? 'tool-calls' : 'stop' } }
    }
  }
  for (const plugin of [LlmRuntime, SessionStore, SessionProjection, SystemPrompt, ToolRuntime, AgentRegistry, SubprocessLocal]) await ctx.plugin(plugin)
  await ctx.plugin(JsonlPersistence, { root: path.join(root, 'sessions'), compression: 'none', writeBatchMaxDelayMs: 1 })
  await ctx.plugin(SandboxPolicy, { mode: 'read-only', workspaceRoot: source })
  await ctx.plugin(Approval, { policy: 'never' })
  for (const plugin of [UserQuestionService, SandboxLocal, Invariants]) await ctx.plugin(plugin)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['swarm-test'], new Scripted())
  await configure?.(ctx)
  const handle = await ctx.agents.create({ sessionId: SessionId('owner-session'), meta: { cwd: source }, agentOptions: { provider: 'swarm-test', model: 'scripted' } })
  await ctx.plugin(Swarm, { statePath: path.join(root, 'state.sqlite'), workspacesRoot: path.join(root, 'worktrees'), tickMs: 60000, leaseMs: 60000, maxEvents: 500, maxAttempts: 100, maxMessageChars: 10000 })
  const rt = ctx.swarm
  rt.kick = () => {}; rt.pumpOutbox = () => {}
  const owner = { sessionId: 'owner-session' }
  const mission = rt.create(owner, { title: 'Native owner notices', objective: 'Preserve correct owner work', workspace: source, scope: ['**'], acceptance: ['correct'], budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 } })
  const emit = (content, options = {}) => {
    rt.commit(mission.id, () => rt.notify(mission.id, content, [`mission:${mission.id}`], { dedupKey: content, ...options }))
    return rt.store.list('deliveries', mission.id).find(row => row.notice?.dedupKey === content)
  }
  return { ctx, rt, owner, agent: handle.agent, mission, requests, emit }
}

test('full plugin books first consumed question before the transport flush acknowledges it', async t => {
  const f = await fixture(t, () => text('Ordinary prose is not a receipt answer'))
  const member = await f.rt.addMember(f.owner, f.mission.id, { name: 'Asker', role: 'research' })
  let ackAtConsumption
  f.ctx.on('session/event', (session, event) => {
    if (String(session.header.id) === f.owner.sessionId && event.type === 'user/message' && event.data.source.kind === 'swarm') {
      ackAtConsumption = f.rt.store.get('deliveries', event.data.source.deliveryId)?.deliveredAt
    }
  })
  f.rt.message({ sessionId: member.sessionId }, f.mission.id, { to: 'owner', kind: 'question', content: 'Which API?' })
  await f.rt.flushOutbox(f.mission.id); await f.agent.whenIdle()
  const question = f.rt.openAsks(f.mission.id, 'owner')[0]
  assert.ok(question?.consumedAt)
  assert.equal(ackAtConsumption, undefined, 'fixture reaches consumption before flush ack')
  assert.equal(question.state, 'open')
  assert.equal(f.rt.store.events(f.mission.id, 500).filter(event => event.type === 'owner/reply-missing').length, 1)
  assert.equal(f.requests.length, 1)
})

for (const continuation of ['prose', 'tool', 'mixed']) test(`stop filters queued owner notices while preserving ${continuation} work`, async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve())
  const f = await fixture(t, async (_request, n) => {
    if (n === 1) { entered.resolve(); await release.promise; return continuation === 'tool' ? { kind: 'tool' } : text('Finished ordinary work') }
    return text('Finished independent continuation')
  })
  let ran = 0
  f.ctx.tools.register(defineContentToolFixture({ name: 'native_probe', description: 'Unrelated owner work', parameters: {}, execute: async () => { ran++; return [{ type: 'text', text: 'ordinary tool result' }] } }))
  f.agent.send(input('ordinary-work', 'Ordinary independent owner work'), 'next-turn', true)
  await entered.promise
  const notice = f.emit('STALE_MISSION_DECISION')
  await f.rt.flushOutbox(f.mission.id)
  assert.ok(f.agent.inbox.nextStep.some(message => message.source.kind === 'swarm'))
  if (continuation === 'mixed') f.agent.send(input('second-ordinary', 'SECOND_INDEPENDENT_REQUEST'), 'next-step', true)
  f.rt.control(f.owner, f.mission.id, 'stop', 'user stopped only this mission')
  release.resolve(); await f.agent.whenIdle()
  assert.equal(f.requests.length, continuation === 'prose' ? 1 : 2)
  assert.ok(f.requests.every(request => !JSON.stringify(request).includes('STALE_MISSION_DECISION')))
  if (continuation === 'tool') assert.equal(ran, 1)
  if (continuation === 'mixed') assert.match(JSON.stringify(f.requests[1]), /SECOND_INDEPENDENT_REQUEST/)
  assert.equal(f.rt.store.get('deliveries', notice.id).notice.consumedAt, undefined, 'discarded input never claims model consumption')
  assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1).data.reason.kind, 'completed')
})

test('consumer rechecks messages already claimed while another pre-step handler awaits', async t => {
  const entered = deferred(), release = deferred(); t.after(() => release.resolve())
  const f = await fixture(t, undefined, ctx => {
    ctx.on('agent/pre-step', async ({ messages }, next) => {
      if (messages.some(message => message.source.kind === 'swarm')) { entered.resolve(); await release.promise }
      return await next()
    })
  })
  const notice = f.emit('STALE_CLAIMED_DECISION')
  const flushing = f.rt.flushOutbox(f.mission.id)
  await entered.promise
  assert.equal(f.agent.inbox.nextStep.length, 0, 'the native loop already claimed it')
  f.rt.control(f.owner, f.mission.id, 'stop', 'stopped during step preparation')
  release.resolve(); await flushing; await f.agent.whenIdle()
  assert.equal(f.requests.length, 0)
  assert.equal(f.rt.store.get('deliveries', notice.id).notice.consumedAt, undefined)
})

test('completed mission facts still reach the owner after automatic completion overtakes transport', async t => {
  const f = await fixture(t)
  const notice = f.emit('COMPLETION_FACT_MUST_SURVIVE', { noticeClass: 'completion' })
  const mission = f.rt.mission(f.mission.id); mission.status = 'completed'
  f.rt.commit(mission.id, () => f.rt.store.put('missions', mission))
  await f.rt.flushOutbox(mission.id); await f.agent.whenIdle()
  assert.equal(f.requests.length, 1)
  assert.match(JSON.stringify(f.requests[0]), /COMPLETION_FACT_MUST_SURVIVE/)
  assert.ok(f.rt.store.get('deliveries', notice.id).notice.consumedAt)
})
