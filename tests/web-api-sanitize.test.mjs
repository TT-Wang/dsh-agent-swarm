/**
 * SURFACE-R3-01 / F-08: every wrapped collaborator failure returns a sanitized
 * HTTP body, while authored validation/policy refusals stay actionable. Real
 * native HTTP/Connection transport over the real runtime and SQLite.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionProjection from '@deepseek-ai/dsh-session-projection'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SwarmRuntime } from '../lib/runtime.js'
import { registerWebApi } from '../lib/web-api.js'
import { PolicyError } from '../lib/policy-error.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 10, maxExperiments: 2 }
class Workers {
  starts = []
  workspaces = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, id) { this.workspaces.push(id); return path.join(mission.workspace, id) }
  async start(spec) { this.starts.push(spec.member.id) }
  async stop() {}
  async deliver() {}
  isIdle() { return false }
  async dispose() {}
}
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-web-sanitize-')))
  const workspace = path.join(directory, 'workspace')
  await mkdir(workspace)
  const ctx = new Context()
  let runtime
  t.after(async () => { await runtime?.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  let credentialRecord
  ctx.provide('credentials', {
    readRecord: async () => credentialRecord,
    modifyRecord: async (_key, mutate) => (credentialRecord = await mutate(credentialRecord)),
    deleteRecord: async () => { credentialRecord = undefined },
  })
  // rc.1: connection registers its RPC route on the context the service was provided from,
  // and that context must itself inject webServer; compose it inside such a scope.
  await new Promise((resolve, reject) => ctx.inject(['webServer'], scope => {
    scope.plugin(Connection, { trustedHosts: ['lan.example'], maxRequestBodyBytes: 1048576 }).then(() => resolve(), reject)
  }))
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(JsonlPersistence, { root: path.join(directory, 'sessions'), compression: 'none', writeBatchMaxDelayMs: 1 })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(class ExactReads extends SessionQueryEngine {})
  ctx.provide('sessionController', { inspect: SessionController.prototype.inspect.bind({ ctx }) })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentLoop, { agents: [] })
  class Catalog extends LlmAdapter {
    routeError
    providerInfo(id) { return { id, name: 'Public provider' } }
    async listModels(provider) { return [{ provider, id: 'model-one', name: 'Model One' }] }
    async resolveModel(provider, model) {
      if (this.routeError) throw this.routeError
      return { provider, id: model, name: model }
    }
  }
  const catalog = new Catalog()
  ctx.llm.registerAdapter(['public-provider'], catalog)
  const workers = new Workers()
  runtime = new SwarmRuntime({ statePath: path.join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  const ownerId = 'web-owner'
  const ownerFiber = ctx.plugin({ name: 'test-web-owner', inject: ['agents'], async apply(scope) {
    const handle = await scope.agents.create({ sessionId: SessionId(ownerId), meta: { cwd: workspace }, agentOptions: { provider: 'public-provider', model: 'model-one' } })
    const session = handle.agent.session
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  } })
  await ownerFiber
  ctx.sessions.create(SessionId('other-owner'), { meta: { cwd: workspace } })
  const bridge = ctx.plugin({ name: 'test-swarm-web', inject: ['connection', 'webServer', 'sessions', 'sessionPersistence', 'agents', 'llm'], apply(scope) { registerWebApi(scope, runtime, { defaultBudget: budget, maxPayloadBytes: 8192 }) } })
  await bridge
  const port = ctx.webServer.port
  const authority = `127.0.0.1:${port}`
  const login = new URL(ctx.connection.authenticatedUrl(`http://${authority}`))
  let cookie
  ctx.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: authority } }, {
    writeHead(status, headers) { assert.equal(status, 303); cookie = headers['set-cookie'].split(';', 1)[0] },
    end() {},
  })
  async function rpc(endpoint, payload) {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'web-test', method: `agent-swarm/${endpoint}`, payload })
    return await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: `/api/agent-swarm/${endpoint}`, method: 'POST',
        headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', cookie } }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString()
          let json
          try { json = JSON.parse(text) } catch { /* Native HTTP denials return plain text. */ }
          resolve({ status: res.statusCode, text, json, result: json?.result })
        })
      })
      req.on('error', reject)
      req.end(body)
    })
  }
  const input = { title: 'Browser plan', objective: 'Prepare reviewable work', workspace, scope: ['src/'], acceptance: ['works'],
    budget, members: [{ key: 'builder', name: 'Builder', role: 'implementation' }],
    workstreams: [{ key: 'main', title: 'Main', objective: 'Build it' }],
    tasks: [{ key: 'build', workstreamKey: 'main', title: 'Build', objective: 'Make the change', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeKey: 'builder' }] }
  return { ctx, runtime, catalog, ownerId, rpc, workspace, input }
}

const leaks = /SQLITE|secret|private|sqlite|LLM_ROUTE_LEAK|\/opt\/|internal route/

test('wrapped runtime and LLM failures return sanitized internal errors, never raw host detail', async t => {
  const f = await fixture(t)
  // A wrapped runtime mutation that fails unexpectedly must not echo its message.
  f.runtime.control = () => { throw new Error('SQLITE_IOERR: disk I/O error at /private/var/secret/swarm.sqlite') }
  const control = await f.rpc('control', { sessionId: f.ownerId, missionId: 'mission-1', action: 'pause', reason: 'test' })
  assert.equal(control.result.ok, false)
  assert.equal(control.result.error.code, 'internal-error')
  assert.doesNotMatch(control.result.error.message, leaks)
  assert.match(control.result.error.message, /logged/)
  assert.doesNotMatch(control.text, /SQLITE_IOERR|secret|swarm\.sqlite/)

  // A wrapped plan/draft operation that fails unexpectedly is sanitized too.
  f.runtime.createDraft = () => { throw new Error('SQLITE_IOERR: /private/var/secret/swarm.sqlite') }
  const draft = await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input })
  assert.equal(draft.result.error.code, 'internal-error')
  assert.doesNotMatch(draft.text, leaks)

  // A wrapped LLM route failure is reported as a stable selection error; the
  // adapter's internal code and any host path never reach the browser.
  const routeRuntime = await fixture(t)
  routeRuntime.catalog.routeError = new Error('LLM_ROUTE_LEAK at /opt/host/secret')
  const route = await routeRuntime.rpc('create-draft', { sessionId: routeRuntime.ownerId,
    input: { ...routeRuntime.input, members: [{ ...routeRuntime.input.members[0], provider: 'public-provider', model: 'model-one' }] } })
  assert.equal(route.result.ok, false)
  assert.doesNotMatch(route.text, leaks)
  assert.match(route.result.error.message, /Model route is unavailable: public-provider\/model-one/)
})

test('authored validation and policy refusals stay actionable', async t => {
  const f = await fixture(t)
  const validation = await f.rpc('watch', { sessionId: f.ownerId, afterRevision: -1 })
  assert.equal(validation.result.error.code, 'bad-request')
  assert.match(validation.result.error.message, /afterRevision must be a nonnegative safe integer/)
  const plan = await f.rpc('create-draft', { sessionId: f.ownerId, input: { ...f.input, scope: ['/etc/passwd'] } })
  assert.equal(plan.result.error.code, 'bad-request')
  assert.match(plan.result.error.message, /scope\[0\] is invalid/)
  // A runtime policy refusal authored by the runtime remains visible.
  const mission = f.runtime.create({ sessionId: f.ownerId }, f.input)
  const member = await f.runtime.addMember({ sessionId: f.ownerId }, mission.id, { name: 'Worker', role: 'implementation' })
  f.ctx.sessions.create(SessionId(member.sessionId), { meta: { cwd: f.workspace } })
  const denied = await f.rpc('control', { sessionId: member.sessionId, missionId: mission.id, action: 'stop', reason: 'member attempt' })
  assert.equal(denied.result.ok, false)
  assert.equal(denied.result.error.code, 'bad-request')
  assert.match(denied.result.error.message, /Only the user session controls mission lifecycle/)
  assert.equal(f.runtime.snapshot({ sessionId: f.ownerId }, mission.id).mission.status, 'active')
})

test('the cancel RPC withdraws one task for the owner and refuses other sessions', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  const stream = f.runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Build it' })
  const task = f.runtime.propose(owner, mission.id, { workstreamId: stream.id,
    title: 'Withdrawable', objective: 'A task the owner withdraws', kind: 'research', scope: ['src/'], acceptance: ['works'] })
  const member = await f.runtime.addMember(owner, mission.id, { name: 'Worker', role: 'implementation' })
  f.ctx.sessions.create(SessionId(member.sessionId), { meta: { cwd: f.workspace } })
  const refused = await f.rpc('cancel', { sessionId: member.sessionId, missionId: mission.id, taskId: task.id, reason: 'not mine' })
  assert.equal(refused.result.ok, false)
  assert.equal(refused.result.error.code, 'bad-request')
  assert.equal(refused.result.error.message, 'Only the mission owner can cancel admitted work')
  assert.deepEqual(refused.result.error.details, { issues: [], policyCode: 'task_cancel_owner_required', category: 'authorization_error' })
  const cancelled = await f.rpc('cancel', { sessionId: f.ownerId, missionId: mission.id, taskId: task.id, reason: 'Owner withdrew it' })
  assert.equal(cancelled.result.ok, true, cancelled.text)
  assert.equal(cancelled.result.value.task.status, 'cancelled')
  const snapshot = cancelled.result.value.snapshot
  assert.equal(snapshot.tasks.find(candidate => candidate.id === task.id).status, 'cancelled')
  const event = snapshot.events.find(candidate => candidate.type === 'task/cancelled' && candidate.data.taskId === task.id)
  assert.ok(event, 'the withdrawal is durable and named')
  assert.equal(event.data.reason, 'Owner withdrew it')
  // Unknown tasks fail with an authored policy message, not a raw store error.
  const unknown = await f.rpc('cancel', { sessionId: f.ownerId, missionId: mission.id, taskId: 'invented', reason: 'x' })
  assert.equal(unknown.result.error.code, 'bad-request')
  assert.equal(unknown.result.error.message, 'Task is not in this mission')
  // Typed, so its visibility no longer depends on the allowlist matching its prose.
  assert.deepEqual(unknown.result.error.details, { issues: [], policyCode: 'task_not_in_mission', category: 'validation_error' })
})

test('T2 W8/F7 owner-actionable refusals stay actionable over the RPCs', async t => {
  const f = await fixture(t)
  // Byte-for-byte messages agreed with the governance task (member_9e7abaca).
  const w8 = 'Member Builder cannot start: provider "public-provider" model "model-one" does not support reasoning effort "high". Clearing reasoningEffort and retrying also failed: Error: route rejected. Admit a replacement member without reasoningEffort, or with an effort this provider/model supports.'
  f.runtime.addMember = () => { throw new PolicyError('member_reasoning_effort_unsupported', 'tool_error', w8) }
  const member = await f.rpc('add-member', { sessionId: f.ownerId, missionId: 'mission-x', input: { name: 'Builder', role: 'implementation' } })
  assert.equal(member.result.ok, false)
  assert.equal(member.result.error.code, 'bad-request')
  assert.equal(member.result.error.message, w8, 'the W8 refusal is not sanitized')
  assert.deepEqual(member.result.error.details, { issues: [], policyCode: 'member_reasoning_effort_unsupported', category: 'tool_error' })
  // F7 from the real runtime: a deterministic retry of a withdrawn record is a typed refusal.
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  const stream = f.runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Build it' })
  const input = { workstreamId: stream.id, title: 'Withdrawn', objective: 'Read it', kind: 'research', scope: ['src/'], acceptance: ['works'] }
  f.runtime.propose(owner, mission.id, input, 'task_1')
  f.runtime.cancel(owner, mission.id, { taskId: 'task_1', reason: 'Withdrawn' })
  const f7 = 'Task task_1 was cancelled by the owner; a cancelled record cannot be re-admitted. Propose a new task, or a repair with a new id.'
  let readmitted
  try { f.runtime.propose(owner, mission.id, input, 'task_1') } catch (error) { readmitted = error }
  assert.ok(readmitted instanceof PolicyError, 'the runtime types the F7 refusal')
  assert.equal(readmitted.message, f7)
  f.runtime.propose = () => { throw readmitted }
  const propose = await f.rpc('propose', { sessionId: f.ownerId, missionId: 'mission-x', input: { workstreamId: 'stream-x' } })
  assert.equal(propose.result.ok, false)
  assert.equal(propose.result.error.code, 'bad-request')
  assert.equal(propose.result.error.message, f7, 'the F7 refusal is not sanitized')
  assert.deepEqual(propose.result.error.details, { issues: [], policyCode: 'task_cancelled_readmission', category: 'tool_error' })
  // Fail closed: the same text on a plain Error, or the typed refusal with host detail appended, is sanitized.
  for (const failure of [new Error(f7), new PolicyError('task_cancelled_readmission', 'tool_error', `${f7} /private/var/secret/swarm.sqlite`)]) {
    f.runtime.propose = () => { throw failure }
    const leaked = await f.rpc('propose', { sessionId: f.ownerId, missionId: 'mission-x', input: { workstreamId: 'stream-x' } })
    assert.equal(leaked.result.error.code, 'internal-error')
    assert.doesNotMatch(leaked.text, /private|secret|sqlite|cancelled by the owner/)
  }
})

test('a refusal text on a plain Error grants no visibility: only the typed refusal reaches the browser', async t => {
  const f = await fixture(t)
  // Texts the retired message allowlist used to expose by wording alone.
  for (const text of ['Mission is paused', 'Unknown mission', 'Only the mission owner can cancel admitted work',
    'tasks[0] (build).priority must be 0–100', 'Complete independent acceptance before applying results']) {
    f.runtime.control = () => { throw new Error(text) }
    const plain = await f.rpc('control', { sessionId: f.ownerId, missionId: 'mission-1', action: 'pause', reason: 'test' })
    assert.equal(plain.result.error.code, 'internal-error', `${text} on a plain Error is not an authored refusal`)
    assert.doesNotMatch(plain.text, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    f.runtime.control = () => { throw new PolicyError('probe_refusal', 'tool_error', text) }
    const typed = await f.rpc('control', { sessionId: f.ownerId, missionId: 'mission-1', action: 'pause', reason: 'test' })
    assert.equal(typed.result.error.code, 'bad-request')
    assert.equal(typed.result.error.message, text)
    assert.deepEqual(typed.result.error.details, { issues: [], policyCode: 'probe_refusal', category: 'tool_error' })
  }
})

test('a typed refusal naming an absolute host path under any system root is an internal error', async t => {
  const f = await fixture(t)
  const control = { sessionId: f.ownerId, missionId: 'mission-1', action: 'pause', reason: 'test' }
  for (const hostPath of ['/Volumes/External/secret.db', '/srv/swarm/secret.db', '/mnt/disk/secret.db', '/data/swarm/secret.db', '/root/.ssh/secret',
    '/Library/Application Support/secret', '/System/Volumes/Data/secret', '/Applications/Secret.app', '/proc/1/environ', '/run/secrets/token',
    '/media/usb/secret', '/snap/bin/secret', '/nix/store/secret', '/dev/shm/secret', '/sys/kernel/secret', '/boot/secret', '/bin/secret',
    '/sbin/secret', '/lib/secret.so', '/lib64/secret.so', '/workspace/secret', '/workspaces/secret', '~/.dsh/secret', 'C:\\Users\\secret']) {
    f.runtime.control = () => { throw new PolicyError('probe_refusal', 'conflict_error', `Cannot open "${hostPath}" for this mission`) }
    const response = await f.rpc('control', control)
    assert.equal(response.result.error.code, 'internal-error', `${hostPath} is host detail`)
    assert.doesNotMatch(response.text, /secret/i)
  }
  // The same names inside a relative repository path are not host detail.
  f.runtime.control = () => { throw new PolicyError('probe_refusal', 'conflict_error', 'tests/data/fixture.json and src/lib/run/x.ts are outside the task scope') }
  const relative = await f.rpc('control', control)
  assert.equal(relative.result.error.code, 'bad-request', relative.text)
  assert.equal(relative.result.error.details.policyCode, 'probe_refusal')
})
