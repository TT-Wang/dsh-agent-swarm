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
import { subprocessSeam, SubprocessLocal } from './subprocess-seam.mjs'
const budget = { maxTokens: 10000, maxSteps: 50, maxWorkers: 3, maxDurationMs: 60000, maxTasks: 10, maxExperiments: 1 }
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swarm-planner-')))
  const snapshotRoot = await realpath(await mkdtemp(join(tmpdir(), 'swarm-planner-snapshots-')))
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git(['init', '-q']); git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'initial'])
  const ctx = new Context()
  await ctx.plugin(SessionStore); await ctx.plugin(CommandRuntime); await ctx.plugin(SubprocessLocal)
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: snapshotRoot, checkTimeoutMs: 10000, maxCheckOutputBytes: 100000, confineCheck: argv => argv })
  const runtime = new SwarmRuntime({ statePath: join(root, '.git', 'swarm.sqlite'), tickMs: 60000, leaseMs: 60000, maxMessageChars: 16000, maxEvents: 100, maxTasksPerMember: 3 }, { bind() {}, prepareBaseline: (mission, signal) => workspaces.prepareBaseline(mission, signal), dispose: () => workspaces.dispose() })
  await runtime.start()
  const session = await ctx.sessions.create(SessionId('planner-owner'), { meta: { cwd: root } })
  const pending = Promise.withResolvers()
  const messages = []
  const agent = { id: session.id, session, options: { provider: 'current', model: 'current-model' }, followup(message) { messages.push(message) }, whenIdle() { return pending.promise } }
  ctx.provide('agents', { get: id => id === agent.id ? agent : undefined })
  ctx.provide('llm', { async resolveCallConfig(selection) { assert.equal(selection.provider, 'current'); assert.equal(selection.model, 'current-model'); if (options.resolve) await options.resolve(); return selection } })
  const fiber = ctx.plugin({ name: 'planner-test', inject: ['commands', 'agents', 'llm'], apply(scope) { registerAutomaticStart(scope, runtime) } })
  await fiber
  t.after(async () => { await fiber.dispose(); pending.resolve(); await runtime.dispose(); await ctx.fiber.dispose(); await rm(snapshotRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) })
  return { root, ctx, runtime, agent, messages, pending, fiber, execute: (line, signal = new AbortController().signal) => ctx.commands.execute(agent, line, [], signal) }
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
