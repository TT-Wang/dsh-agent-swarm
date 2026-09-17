/** Admission uses native commands, real Git status, durable runtime and the owner inbox boundary. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SwarmRuntime } from '../lib/runtime.js'
import { registerAutomaticStart } from '../lib/planner.js'
import { Workspaces } from '../lib/workspaces.js'

/**
 * The slice of an Agent inbox the planner's owner fixtures exercise. 0.1.3 exported a runtime Inbox from
 * dsh-agent; 0.1.6 keeps it inside the loop (ReactLoopInbox), so the fixture models the contract itself:
 * every insertion is the durable `agent/inbox/spliced` record the planner reads back to decide whether a
 * recovery notice was already delivered (src/planner.ts), and the queues mirror what the record says.
 */
function fakeInbox(session) {
  const queues = { 'next-turn': [], 'next-step': [] }
  return {
    get nextTurn() { return queues['next-turn'] },
    get nextStep() { return queues['next-step'] },
    append(target, message) {
      const event = session.append('agent/inbox/spliced', { target, start: queues[target].length, inserted: [message] })
      queues[target].push(...event.data.inserted)
    },
    remove(id) {
      for (const [target, queue] of Object.entries(queues)) {
        const at = queue.findIndex(message => message.id === id)
        if (at < 0) continue
        session.append('agent/inbox/spliced', { target, start: at, removedCount: 1, inserted: [], outcome: 'canceled' })
        queue.splice(at, 1)
      }
    },
  }
}
import { subprocessSeam, SubprocessLocal } from './subprocess-seam.mjs'
const budget = { maxTokens: 10000, maxSteps: 50, maxWorkers: 3, maxDurationMs: 60000, maxTasks: 10, maxExperiments: 1 }
async function eventually(read) {
  const until = Date.now() + 3000
  while (Date.now() < until) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail('Expected native planner recovery transition did not occur')
}
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swarm-planner-')))
  const snapshotRoot = await realpath(await mkdtemp(join(tmpdir(), 'swarm-planner-snapshots-')))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git(['init', '-q']); git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'initial'])
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(CommandRuntime); await ctx.plugin(SubprocessLocal)
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: snapshotRoot, checkTimeoutMs: 10000, maxCheckOutputBytes: 100000, confineCheck: argv => argv })
  const runtime = new SwarmRuntime({ statePath: join(root, '.git', 'swarm.sqlite'), tickMs: 60000, leaseMs: 60000, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3, ...options.config }, { bind() {}, async prepareBaseline(mission, signal) { await options.beforeSnapshot?.(signal); return workspaces.prepareBaseline(mission, signal) }, dispose: () => workspaces.dispose() })
  await runtime.start()
  const session = await ctx.sessions.create(SessionId('planner-owner'), { meta: { cwd: root } })
  const pending = Promise.withResolvers()
  const idleGates = [pending]
  const messages = []
  const inbox = fakeInbox(session)
  const agent = { id: session.id, session, inbox, options: { provider: 'current', model: 'current-model' },
    send(message, target) { inbox.append(target, message); messages.push(message) },
    followup(message) { this.send(message, 'next-turn') }, whenIdle() { return idleGates.at(-1).promise },
  }
  const agents = new Map([[agent.id, agent]])
  ctx.provide('agents', { get: id => agents.get(id) })
  ctx.provide('llm', { async resolveCallConfig(selection) { assert.equal(selection.provider, 'current'); assert.equal(selection.model, 'current-model'); if (options.resolve) await options.resolve(); return selection } })
  if (options.flush) ctx.on('session/flush', options.flush)
  const plugin = { name: 'planner-test', inject: ['commands', 'agents', 'llm', 'sessions'], apply(scope) { registerAutomaticStart(scope, runtime) } }
  let fiber = ctx.plugin(plugin)
  await fiber
  t.after(async () => { await fiber.dispose(); for (const gate of idleGates) gate.resolve(); await runtime.dispose(); await ctx.fiber.dispose(); await rm(snapshotRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) })
  return { root, ctx, runtime, agent, agents, messages, pending, get fiber() { return fiber },
    nextIdle() { const gate = Promise.withResolvers(); idleGates.push(gate); return gate },
    async reload() { await fiber.dispose(); fiber = ctx.plugin(plugin); await fiber },
    execute: (line, signal = new AbortController().signal) => ctx.commands.execute(agent, line, [], signal),
  }
}
test('one natural-language command saves bounded request and wakes exact owner with typed planning context', async t => {
  const f = await fixture(t)
  const goal = '修复搜索结果，保留现有 API\n检查错误处理。'
  const executed = await f.execute(`/agent-swarm ${goal}`)
  assert.equal(executed.result.kind, 'success')
  const [request] = f.runtime.starts({ sessionId: f.agent.id })
  assert.equal(request.goal, goal); assert.equal(request.workspace, f.root); assert.equal(request.budget, undefined, 'resource budgets are chosen by the primary planner, not preset at admission')
  assert.equal(f.messages.length, 1)
  const message = f.messages[0]
  assert.equal(message.source.kind, 'swarm-start'); assert.equal(message.source.requestId, request.id)
  assert.equal(message.source.commandId, executed.commandId)
  assert.ok(message.content[0].text.includes(JSON.stringify(goal)))
  assert.match(message.content[0].text, /swarm_launch/)
  assert.equal(message.source.planningEpoch, 1)
  assert.match(message.content[0].text, /planningEpoch: 1/)
  assert.match(message.content[0].text, /Planning deadline:/)
  assert.match(message.content[0].text, /maxSteps, maxFindings/)
  assert.equal(f.runtime.list(f.agent.id).length, 0, 'planning has not yet admitted workers')
  f.pending.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.runtime.starts({ sessionId: f.agent.id })[0].status, 'failed', 'idle without a launch is a durable actionable failure')
})
test('a second command cannot silently start another overlapping automatic mission', async t => {
  const f = await fixture(t)
  await f.execute('/agent-swarm first goal')
  await assert.rejects(f.execute('/agent-swarm second goal'), /automatic|request|协作|outstanding|progress/i)
  assert.equal(f.messages.length, 1); assert.equal(f.runtime.starts({ sessionId: f.agent.id }).length, 1)
})
test('dirty repository is frozen before the primary reads it; source edits and HEAD remain independent', async t => {
  const f = await fixture(t)
  const git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim()
  const head = git(['rev-parse', 'HEAD'])
  await writeFile(join(f.root, 'user-work.txt'), 'keep this')
  const result = await f.execute('/agent-swarm make change')
  assert.equal(result.result.kind, 'success')
  const [request] = f.runtime.starts({ sessionId: f.agent.id })
  assert.equal(request.baseline.sourceHead, head)
  assert.notEqual(request.baseline.snapshotCommit, head)
  assert.match(f.messages[0].content[0].text, /Frozen planning workspace/)
  assert.ok(f.messages[0].content[0].text.includes(request.baseline.planningWorkspace))
  assert.equal(await readFile(join(request.baseline.planningWorkspace, 'user-work.txt'), 'utf8'), 'keep this')
  await writeFile(join(f.root, 'user-work.txt'), 'later edit')
  assert.equal(await readFile(join(request.baseline.planningWorkspace, 'user-work.txt'), 'utf8'), 'keep this')
  assert.equal(git(['rev-parse', 'HEAD']), head)
  assert.equal(git(['status', '--porcelain']), '?? user-work.txt')
  const resumed = await f.runtime.prepareStart({ sessionId: f.agent.id }, request.id)
  assert.equal(resumed.baseline.snapshotCommit, request.baseline.snapshotCommit)
})
test('cancellation while resolving owner model cannot enqueue planning', async t => {
  const reached = Promise.withResolvers(), release = Promise.withResolvers()
  const f = await fixture(t, { resolve: async () => { reached.resolve(); await release.promise } })
  const controller = new AbortController()
  const started = f.execute('/agent-swarm make change', controller.signal)
  await reached.promise; controller.abort(new Error('cancelled before planning')); release.resolve()
  await assert.rejects(started, /cancelled before planning/)
  assert.equal(f.messages.length, 0); assert.equal(f.runtime.starts({ sessionId: f.agent.id }).length, 0)
})
test('unloading removes native command and late idle callback cannot touch disposed runtime', async t => {
  const f = await fixture(t)
  await f.execute('/agent-swarm make change')
  await f.fiber.dispose(); await f.runtime.dispose(); f.pending.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.ctx.commands.list(f.agent).find(command => command.name === 'agent-swarm'), undefined)
})

test('an offline owner keeps a durable planning failure and receives it on agent creation', async t => {
  const f = await fixture(t)
  await f.execute('/agent-swarm retained goal')
  const [request] = f.runtime.starts({ sessionId: f.agent.id })
  f.agents.delete(f.agent.id)
  f.pending.resolve()
  await eventually(() => f.runtime.store.get('starts', request.id).recoveryNoticePending)
  assert.equal(f.messages.length, 1, 'an unavailable owner must not consume the recovery obligation')
  f.agents.set(f.agent.id, f.agent)
  f.ctx.emit('agent/created', { agent: f.agent })
  await eventually(() => !f.runtime.store.get('starts', request.id).recoveryNoticePending)
  const messages = f.messages.filter(message => message.source.phase === 'failure')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, `swarm-start:${request.id}:1:failure`)
  assert.match(messages[0].content[0].text, /swarm_control\(\{ requestId:/)
  assert.match(messages[0].content[0].text, /action: "retry"/)
  assert.equal(f.runtime.list(f.agent.id).length, 0, 'prelaunch recovery needs no mission or worker')
})

test('a failed native flush retries without inserting the recovery message twice', async t => {
  let flushes = 0
  const f = await fixture(t, { config: { tickMs: 10 }, flush: () => { if (++flushes === 1) throw new Error('temporary persistence failure') } })
  await f.execute('/agent-swarm flush recovery')
  const [request] = f.runtime.starts({ sessionId: f.agent.id })
  f.runtime.failStart({ sessionId: f.agent.id }, request.id, 'planning interrupted', 1)
  await eventually(() => flushes >= 2 && !f.runtime.store.get('starts', request.id).recoveryNoticePending)
  assert.equal(f.messages.filter(message => message.source.phase === 'failure').length, 1)
  assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced'
    && event.data.inserted.some(message => message.id === `swarm-start:${request.id}:1:failure`)).length, 1)
})

test('plugin reload reuses the native inbox identity when its durable request acknowledgement was interrupted', async t => {
  const flushGate = Promise.withResolvers()
  let flushes = 0
  const f = await fixture(t, { flush: () => ++flushes === 1 ? flushGate.promise : undefined })
  t.after(() => flushGate.resolve())
  await f.execute('/agent-swarm reload recovery')
  const [request] = f.runtime.starts({ sessionId: f.agent.id })
  f.runtime.failStart({ sessionId: f.agent.id }, request.id, 'recover after reload', 1)
  await eventually(() => flushes === 1)
  assert.equal(f.runtime.store.get('starts', request.id).recoveryNoticePending, true)
  await f.reload()
  await eventually(() => !f.runtime.store.get('starts', request.id).recoveryNoticePending)
  assert.equal(f.messages.filter(message => message.source.phase === 'failure').length, 1)
  flushGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.runtime.store.get('starts', request.id).recoveryNoticePending, undefined)
})

test('retry keeps the snapshot and fences both a late flush acknowledgement and the old idle callback', async t => {
  const flushGate = Promise.withResolvers()
  let flushes = 0
  const f = await fixture(t, { flush: () => ++flushes === 1 ? flushGate.promise : undefined })
  t.after(() => flushGate.resolve())
  await f.execute('/agent-swarm retry the preserved plan')
  const [request] = f.runtime.starts({ sessionId: f.agent.id })
  const actor = { sessionId: f.agent.id }
  f.runtime.failStart(actor, request.id, 'old planning stalled', 1)
  await eventually(() => flushes === 1)
  const retryIdle = f.nextIdle()
  f.runtime.controlStart(actor, request.id, 'retry', 'continue from the saved snapshot')
  await eventually(() => f.messages.some(message => message.source.phase === 'planning' && message.source.planningEpoch === 2)
    && !f.runtime.store.get('starts', request.id).planningDispatchPending)
  f.pending.resolve()
  flushGate.resolve()
  await new Promise(resolve => setImmediate(resolve))
  const retried = f.runtime.store.get('starts', request.id)
  assert.equal(retried.status, 'planning')
  assert.equal(retried.planningEpoch, 2)
  assert.deepEqual(retried.baseline, request.baseline)
  assert.equal(retried.recoveryNoticePending, undefined)
  retryIdle.resolve()
  await eventually(() => f.runtime.store.get('starts', request.id).status === 'failed')
  assert.equal(f.runtime.store.get('starts', request.id).planningEpoch, 2, 'only the current idle callback closes the new planning generation')
})

test('one owner with a hung flush cannot block another owner recovery notice', async t => {
  const flushGate = Promise.withResolvers()
  const f = await fixture(t, { flush: session => session.id === 'planner-owner' ? flushGate.promise : undefined })
  t.after(() => flushGate.resolve())
  await f.execute('/agent-swarm first owner goal')
  const [request] = f.runtime.starts({ sessionId: f.agent.id })
  f.runtime.failStart({ sessionId: f.agent.id }, request.id, 'first owner needs recovery', 1)
  const session = await f.ctx.sessions.create(SessionId('other-planner-owner'), { meta: { cwd: f.root } })
  const inbox = fakeInbox(session)
  const received = []
  const other = { id: session.id, session, inbox, send(message, target) { inbox.append(target, message); received.push(message) } }
  f.agents.set(other.id, other)
  const actor = { sessionId: other.id }
  const second = f.runtime.requestStart(actor, { commandId: 'other-command', goal: 'other owner goal', workspace: f.root })
  f.runtime.failStart(actor, second.id, 'second owner needs recovery', 1)
  await eventually(() => !f.runtime.store.get('starts', second.id).recoveryNoticePending)
  assert.equal(received.length, 1)
  assert.equal(f.runtime.store.get('starts', request.id).recoveryNoticePending, true)
})

test('unload removes pending-recovery subscriptions and the retry timer', async t => {
  const f = await fixture(t, { config: { tickMs: 10 } })
  await f.execute('/agent-swarm retained during unload')
  const [request] = f.runtime.starts({ sessionId: f.agent.id })
  f.agents.delete(f.agent.id)
  f.runtime.failStart({ sessionId: f.agent.id }, request.id, 'retry after reload', 1)
  await f.fiber.dispose()
  f.agents.set(f.agent.id, f.agent)
  f.ctx.emit('agent/created', { agent: f.agent })
  f.runtime.commit(request.id, () => {})
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(f.messages.length, 1)
  assert.equal(f.runtime.store.get('starts', request.id).recoveryNoticePending, true)
})

test('an unrepaired validation failure becomes one fenced recovery notice when planning goes idle', async t => {
  const f = await fixture(t)
  await f.execute('/agent-swarm repair invalid plan')
  const actor = { sessionId: f.agent.id }
  const [request] = f.runtime.starts(actor)
  await assert.rejects(f.runtime.startPlan(actor, request.id, {}, 1))
  const invalid = f.runtime.store.get('starts', request.id)
  assert.equal(invalid.status, 'failed')
  assert.notEqual(invalid.planningFenced, true, 'same-turn validation repair remains allowed')
  assert.equal(f.messages.filter(message => message.source.phase === 'failure').length, 0)
  f.pending.resolve()
  await eventually(() => f.runtime.store.get('starts', request.id).planningFenced)
  await eventually(() => !f.runtime.store.get('starts', request.id).recoveryNoticePending)
  assert.equal(f.runtime.store.get('starts', request.id).error, invalid.error)
  assert.equal(f.messages.filter(message => message.source.phase === 'failure').length, 1)
  f.runtime.commit(request.id, () => {})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.messages.filter(message => message.source.phase === 'failure').length, 1)
})

test('retry snapshot preparation uses the planning deadline rather than the shorter outbox timeout', async t => {
  let snapshots = 0
  const f = await fixture(t, { config: { tickMs: 10, stallPassTimeoutMs: 20, planningTimeoutMs: 10000 },
    async beforeSnapshot(signal) { snapshots++; await new Promise(resolve => setTimeout(resolve, 60)); signal.throwIfAborted() },
  })
  const actor = { sessionId: f.agent.id }
  const request = f.runtime.requestStart(actor, { commandId: 'slow-snapshot', goal: 'finish a slow snapshot', workspace: f.root })
  f.runtime.failStart(actor, request.id, 'snapshot needs a retry', 1)
  f.runtime.controlStart(actor, request.id, 'retry', 'allow the snapshot to finish')
  await eventually(() => f.messages.some(message => message.source.phase === 'planning' && message.source.planningEpoch === 2)
    && !f.runtime.store.get('starts', request.id).planningDispatchPending)
  assert.equal(snapshots, 1, 'the short transport timeout must not repeatedly abort a healthy preparation')
  assert.ok(f.runtime.store.get('starts', request.id).baseline)
  assert.equal(f.runtime.store.get('starts', request.id).status, 'planning')
})
