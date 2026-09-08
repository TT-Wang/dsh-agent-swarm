/** Exercise the real native command registry, discovery and session lifecycle. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { registerSwarmCommand } from '../lib/command.js'

async function fixture(t, start, options = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  const session = await ctx.sessions.create(SessionId('swarm-command-owner'))
  // The adapter only uses native identity; starting the model belongs to start().
  const agent = { id: session.id, session }
  let remove
  const registration = ctx.plugin({
    name: 'test-native-swarm-command', inject: ['commands'],
    apply(scope) { remove = registerSwarmCommand(scope, { start, ...options }) },
  })
  await registration
  return { ctx, agent, registration, remove,
    execute: (line, signal = new AbortController().signal) => ctx.commands.execute(agent, line, [], signal) }
}

test('native slash discovery advertises free-form input and unregisters on plugin unload', async t => {
  const f = await fixture(t, () => ({ kind: 'success' }))
  const descriptor = f.ctx.commands.list(f.agent).find(command => command.name === 'agent-swarm')
  assert.match(descriptor.description, /智能体协作/)
  assert.match(descriptor.input.hint, /描述.*任务/)
  assert.equal(Object.isFrozen(descriptor), true)
  await f.registration.dispose()
  assert.deepEqual(f.ctx.commands.list(f.agent), [])
  assert.equal(await f.execute('/agent-swarm build search'), undefined)
})

test('native command forwards exact owner, invocation identity and natural-language goal once', async t => {
  const requests = []
  const result = { kind: 'success', text: '正在为你安排协作任务。' }
  const f = await fixture(t, request => { requests.push(request); return result })
  const rawInput = ' \t给项目添加搜索功能\n保留现有接口和测试。  '
  const signal = new AbortController().signal
  const executed = await f.execute(`/agent-swarm${rawInput}`, signal)
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.agent, f.agent)
  assert.equal(request.sessionId, f.agent.id)
  assert.equal(request.commandId, executed.commandId)
  assert.equal(request.rawInput, rawInput)
  assert.equal(request.goal, '给项目添加搜索功能\n保留现有接口和测试。')
  assert.equal(request.signal, signal)
  assert.equal(Object.isFrozen(request), true)
  assert.deepEqual(executed.result, result)
  assert.deepEqual(f.agent.session.snapshotEvents().filter(event => event.type.startsWith('command/')).map(event => ({ type: event.type, data: event.data })), [
    { type: 'command/run', data: { commandId: executed.commandId, name: 'agent-swarm', args: rawInput, source: { kind: 'user' } } },
    { type: 'command/done', data: { commandId: executed.commandId, kind: 'success', text: result.text } },
  ])
})

test('empty and oversized input cannot invoke planning or start workers', async t => {
  let starts = 0
  const f = await fixture(t, () => { starts += 1; return { kind: 'success' } }, { maxGoalChars: 10 })
  for (const line of ['/agent-swarm', '/agent-swarm \n\t', `/agent-swarm ${'x'.repeat(11)}`]) {
    const executed = await f.execute(line)
    assert.equal(executed.result.kind, 'error')
    assert.ok(executed.result.text.length > 0)
  }
  assert.equal(starts, 0)
  assert.equal((await f.execute(`/agent-swarm ${'x'.repeat(10)}`)).result.kind, 'success')
  assert.equal(starts, 1)
})

test('pre-admission cancellation cannot call the runtime', async t => {
  let starts = 0
  const f = await fixture(t, () => { starts += 1; return { kind: 'success' } })
  const controller = new AbortController()
  controller.abort(new Error('cancel before admission'))
  await assert.rejects(f.execute('/agent-swarm build search', controller.signal), /cancel before admission/)
  assert.equal(starts, 0)
  assert.equal(f.agent.session.snapshotEvents().filter(event => event.type.startsWith('command/')).length, 0)
})

test('runtime admission errors remain native UI errors and are durably recorded', async t => {
  const expected = { kind: 'error', text: '当前会话已有正在运行的协作任务。' }
  const f = await fixture(t, () => expected)
  const executed = await f.execute('/agent-swarm build search')
  assert.deepEqual(executed.result, expected)
  const done = f.agent.session.snapshotEvents().find(event => event.type === 'command/done')
  assert.equal(done.data.kind, 'error')
  assert.equal(done.data.text, expected.text)
})

test('native cancellation reaches asynchronous admission and settles the command as an error', async t => {
  const controller = new AbortController()
  let receivedSignal
  const f = await fixture(t, request => new Promise((_resolve, reject) => {
    receivedSignal = request.signal
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
  }))
  const pending = f.execute('/agent-swarm build search', controller.signal)
  assert.equal(receivedSignal, controller.signal)
  controller.abort(new Error('cancel pending admission'))
  await assert.rejects(pending, /cancel pending admission/)
  const done = f.agent.session.snapshotEvents().find(event => event.type === 'command/done')
  assert.equal(done.data.kind, 'error')
  assert.match(done.data.text, /cancel pending admission/)
})
