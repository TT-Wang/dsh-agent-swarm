/** Real native HTTP/Connection transport over the real runtime and SQLite. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdir, symlink } from 'node:fs/promises'
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
import { ObserveDetailRefusedError } from '../lib/runtime.js'
import { registerWebApi } from '../lib/web-api.js'
import { PolicyError } from '../lib/policy-error.js'
import { errorTypeFor } from '../lib/trace.js'
import { AdmissionError, TaskGraphAdmissionError } from '../lib/admission.js'
import { FakeWorkers, budget as defaultBudget, makeRuntime } from './faults/harness.mjs'

const budget = { ...defaultBudget, maxTokens: 100000, maxSteps: 100, maxTasks: 10, maxExperiments: 2 }
/** Records the members it started and the workspaces it prepared. */
class Workers extends FakeWorkers {
  starts = []
  workspaces = []
  async prepareWorkspace(mission, id) { this.workspaces.push(id); return path.join(mission.workspace, id) }
  async start(spec) { this.starts.push(spec.member.id) }
}
async function fixture(t) {
  // Registered before makeRuntime's cleanup, so the runtime and then the host
  // composition are disposed before the temp dir goes.
  const ctx = new Context()
  let runtime
  t.after(async () => { await runtime?.dispose(); await ctx.fiber.dispose() })
  const made = await makeRuntime(t, { workers: new Workers(), config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 100, checkTimeoutMs: undefined } })
  const { dir: directory, workers } = made
  const workspace = path.join(directory, 'workspace')
  await mkdir(workspace)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  // In-memory credential storage; authentication/token/cookie enforcement is
  // the actual modern Connection implementation, never a bypass.
  let credentialRecord
  ctx.provide('credentials', {
    readRecord: async () => credentialRecord,
    modifyRecord: async (_key, mutate) => (credentialRecord = await mutate(credentialRecord)),
    deleteRecord: async () => { credentialRecord = undefined },
  })
  // 0.1.5's connection registers its RPC route on the context the service was provided from,
  // and that context must itself inject webServer; compose it inside such a scope.
  await new Promise((resolve, reject) => ctx.inject(['webServer'], scope => {
    scope.plugin(Connection, { trustedHosts: ['lan.example'], maxRequestBodyBytes: 1048576 }).then(() => resolve(), reject)
  }))
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjection)
  await ctx.plugin(JsonlPersistence, { root: path.join(directory, 'sessions'), compression: 'none', writeBatchMaxDelayMs: 1 })
  await ctx.plugin(AgentRegistry)
  // Use the native cold inspection implementation with its real query service;
  // unrelated session mutation and Typert registration are outside this fixture.
  await ctx.plugin(class ExactReads extends SessionQueryEngine {})
  ctx.provide('sessionController', { inspect: SessionController.prototype.inspect.bind({ ctx }) })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentLoop, { agents: [] })
  class Catalog extends LlmAdapter {
    unavailable = false
    blockedModels = new Set()
    failedCatalogs = new Set()
    providerInfo(id) { return { id, name: 'Public provider' } }
    async listModels(provider) {
      if (this.failedCatalogs.has(provider)) throw new Error('Catalog failed at /Users/private/provider.env')
      return [{ provider, id: 'model-one', name: 'Model One', description: 'Public description' }]
    }
    async resolveModel(provider, model) {
      if (this.unavailable || model === 'unroutable' || this.blockedModels.has(model)) throw new Error('Model route is unavailable')
      return { provider, id: model, name: model, ...(model === 'reasoning-model' ? {
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'off' },
      } : {}) }
    }
  }
  const catalog = new Catalog()
  ctx.llm.registerAdapter(['public-provider'], catalog)
  runtime = made.runtime
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
  const allowed = ctx.connection.authorizeIndex({ method: 'GET', url: login.pathname + login.search, headers: { host: authority } }, {
    writeHead(status, headers) { assert.equal(status, 303); cookie = headers['set-cookie'].split(';', 1)[0] },
    end() {},
  })
  assert.equal(allowed, false)
  assert.ok(cookie)

  async function rpc(endpoint, payload, options = {}) {
    const body = options.raw ?? JSON.stringify({ type: 'client-request', rpcId: 'web-test', method: `agent-swarm/${endpoint}`, payload })
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', cookie, ...options.headers }
    return await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: `/api/agent-swarm/${endpoint}`, method: options.method ?? 'POST', headers }, res => {
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
  const input = { title: 'Browser plan', objective: 'Prepare reviewable work', workspace, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation' }],
    workstreams: [{ key: 'main', title: 'Main', objective: 'Build it' }],
    tasks: [{ key: 'build', workstreamKey: 'main', title: 'Build', objective: 'Make the change', kind: 'implementation', outputs: [], scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeKey: 'builder' }] }
  return { ctx, runtime, workers, catalog, ownerId, ownerFiber, bridge, rpc, workspace, directory, input }
}

test('web launch validates the native owner selection and clears effort on an explicit worker route', async t => {
  const f = await fixture(t)
  f.ctx.agents.get(SessionId(f.ownerId)).session.append('model/selection', {
    provider: 'public-provider', model: 'reasoning-model', reasoningEffort: 'high',
  })
  assert.equal(f.ctx.agents.get(SessionId(f.ownerId)).options.model, 'model-one')
  f.catalog.blockedModels.add('model-one')
  const created = await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input })
  assert.equal(created.result.ok, true)
  const draft = created.result.value.draft
  const launched = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision })
  assert.equal(launched.result.ok, true, JSON.stringify(launched.result))
  assert.equal(new Set(f.workers.starts).size, 1)

  const explicit = { ...f.input, members: [{ ...f.input.members[0], model: 'plain-model' }] }
  const route = await f.rpc('create-draft', { sessionId: f.ownerId, input: explicit })
  assert.equal(route.result.ok, true, 'high effort must not leak into a model without reasoning support')
  const invalid = await f.rpc('create-draft', { sessionId: f.ownerId, input: { ...explicit,
    members: [{ ...explicit.members[0], reasoningEffort: 'high' }] } })
  assert.equal(invalid.result.ok, false, 'an explicit unsupported effort is rejected by the actual resolver')
})

test('native trust fence rejects hostile origins, rebound Hosts, and unauthenticated authorities', async t => {
  const f = await fixture(t)
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' },
    { host: 'evil.example', origin: 'http://evil.example' }]) {
    const response = await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input }, { headers })
    assert.equal(response.status, 403)
  }
  const unauthenticated = await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input }, { headers: { cookie: '' } })
  assert.equal(unauthenticated.status, 401)
  const authorityMismatch = await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input }, {
    headers: { host: 'lan.example', origin: 'http://lan.example' },
  })
  assert.equal(authorityMismatch.status, 401, 'an otherwise trusted Host still requires its own authenticated cookie')
  assert.deepEqual(f.runtime.drafts({ sessionId: f.ownerId }), [])
})

test('native JSON envelope and swarm payload bounds reject malformed requests before mutation', async t => {
  const f = await fixture(t)
  assert.equal((await f.rpc('state', {}, { headers: { 'content-type': 'text/plain' } })).status, 415)
  assert.equal((await f.rpc('state', {}, { raw: '{' })).status, 400)
  const large = await f.rpc('create-draft', { sessionId: f.ownerId, input: { ...f.input, objective: 'x'.repeat(9000) } })
  assert.equal(large.result.ok, false)
  assert.match(large.result.error.message, /payload limit/)
  const missing = await f.rpc('create-draft', { sessionId: 'invented-owner', input: f.input })
  assert.equal(missing.result.error.code, 'session-not-found')
  assert.deepEqual(f.runtime.drafts({ sessionId: f.ownerId }), [])
})

test('draft API persists editable plans, enforces revision ownership and canonical session workspace', async t => {
  const f = await fixture(t)
  const alias = path.join(f.directory, 'workspace-alias')
  await symlink(f.workspace, alias)
  const created = await f.rpc('create-draft', { sessionId: f.ownerId, input: { ...f.input, workspace: alias } })
  assert.equal(created.result.ok, true, created.text)
  const draft = created.result.value.draft
  assert.equal(draft.input.workspace, f.workspace)
  const updated = await f.rpc('update-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision, input: { ...f.input, title: 'Edited in browser' } })
  assert.equal(updated.result.ok, true, updated.text)
  assert.equal(updated.result.value.draft.input.title, 'Edited in browser')
  const stale = await f.rpc('update-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision, input: f.input })
  assert.equal(stale.result.ok, false)
  const other = await f.rpc('update-draft', { sessionId: 'other-owner', draftId: draft.id, revision: updated.result.value.draft.revision, input: f.input })
  assert.equal(other.result.ok, false)
  const mismatch = await f.rpc('create-draft', { sessionId: f.ownerId, input: { ...f.input, workspace: f.directory } })
  assert.equal(mismatch.result.ok, false)
  assert.match(mismatch.result.error.message, /selected session workspace/)
  const state = await f.rpc('state', { sessionId: f.ownerId })
  assert.equal(state.result.value.drafts.length, 1)
  assert.equal(state.result.value.ownerSessionId, f.ownerId)
  assert.equal(state.result.value.workspace, f.workspace)
  assert.equal(state.result.value.writable, true)
  const outsider = await f.rpc('state', { sessionId: 'other-owner' })
  assert.deepEqual(outsider.result.value.drafts, [])
})

test('member state is visible without granting owner controls, and unrelated sessions see no missions', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  const member = await f.runtime.addMember(owner, mission.id, { name: 'Worker', role: 'implementation' })
  f.ctx.sessions.create(SessionId(member.sessionId), { meta: { cwd: f.workspace } })
  const state = await f.rpc('state', { sessionId: member.sessionId })
  assert.equal(state.result.value.snapshots[0].mission.id, mission.id)
  assert.equal(state.result.value.writable, false)
  const denied = await f.rpc('control', { sessionId: member.sessionId, missionId: mission.id, action: 'stop', reason: 'A member cannot stop the mission' })
  assert.equal(denied.result.ok, false)
  assert.equal(f.runtime.snapshot(owner, mission.id).mission.status, 'active')
  const outsider = await f.rpc('state', { sessionId: 'other-owner' })
  assert.deepEqual(outsider.result.value.snapshots, [])
  const paused = await f.rpc('control', { sessionId: f.ownerId, missionId: mission.id, action: 'pause', reason: 'Owner paused from browser' })
  assert.equal(paused.result.value.snapshot.mission.status, 'paused')
})

test('delivery routes require owner, completed acceptance and the exact session workspace', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  const member = await f.runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  f.ctx.sessions.create(SessionId(member.sessionId), { meta: { cwd: f.workspace } })
  let writes = 0
  f.workers.inspectDelivery = async (value, commit) => ({ baselineCommit: value.baseline.snapshotCommit, resultCommit: commit, changedPaths: ['src/fix.js'], diff: 'verified delta', truncated: false })
  f.workers.applyDelivery = async () => { writes++; return { status: 'applied', changedPaths: ['src/fix.js'], conflicts: [] } }
  for (const endpoint of ['delivery', 'apply-delivery']) {
    const before = await f.rpc(endpoint, { sessionId: f.ownerId, missionId: mission.id })
    assert.equal(before.result.ok, false, 'active work cannot be delivered')
    assert.equal(before.result.error.message, 'Complete independent acceptance before applying results')
    assert.deepEqual(before.result.error.details, { issues: [], policyCode: 'delivery_acceptance_required', category: 'tool_error' })
    for (const sessionId of ['other-owner', member.sessionId]) {
      const denied = await f.rpc(endpoint, { sessionId, missionId: mission.id })
      assert.equal(denied.result.ok, false)
    }
  }
  assert.equal(writes, 0)
  // Oversized content is refused typed, with the bound in its text.
  assert.throws(() => f.runtime.cancel(owner, mission.id, { taskId: 'any', reason: 'x'.repeat(10001) }),
    error => error instanceof PolicyError && error.code === 'content_too_long' && error.message === 'Content exceeds 10000 characters'
      && errorTypeFor(error) === errorTypeFor(new Error(error.message)))
  mission.status = 'completed'
  f.runtime.store.put('missions', mission)
  const historical = await f.rpc('delivery', { sessionId: f.ownerId, missionId: mission.id })
  assert.equal(historical.result.error.message, 'This historical mission has no saved delivery baseline; inspect its retained artifact')
  assert.deepEqual(historical.result.error.details, { issues: [], policyCode: 'delivery_baseline_missing', category: 'tool_error' })
  mission.baseline = { sourceHead: 'a'.repeat(40), snapshotCommit: 'b'.repeat(40), planningWorkspace: '/private/planning', changedPaths: ['user.txt'], createdAt: 1 }
  f.runtime.store.put('missions', mission)
  const source = { id: 'delivery-source', missionId: mission.id, kind: 'implementation', status: 'accepted', dependencies: [], artifact: { commit: 'c'.repeat(40) } }
  const final = { id: 'delivery-final', missionId: mission.id, kind: 'integration', status: 'accepted', dependencies: [source.id], artifact: { commit: 'd'.repeat(40) } }
  f.runtime.store.put('tasks', source); f.runtime.store.put('tasks', final)
  // A PolicyError the adapter throws reaches the browser typed, with its own code and category.
  const adapter = f.workers.inspectDelivery
  f.workers.inspectDelivery = async () => { throw new PolicyError('adapter_refused', 'tool_error', 'The adapter refused this inspection') }
  const refused = await f.rpc('delivery', { sessionId: f.ownerId, missionId: mission.id })
  assert.equal(refused.result.error.message, 'The adapter refused this inspection')
  assert.deepEqual(refused.result.error.details, { issues: [], policyCode: 'adapter_refused', category: 'tool_error' })
  f.workers.inspectDelivery = adapter
  const inspected = await f.rpc('delivery', { sessionId: f.ownerId, missionId: mission.id, resultCommit: 'forged' })
  assert.equal(inspected.result.value.delivery.resultCommit, final.artifact.commit, 'caller cannot choose an unaccepted commit')
  const applied = await f.rpc('apply-delivery', { sessionId: f.ownerId, missionId: mission.id })
  assert.equal(applied.result.value.result.status, 'applied'); assert.equal(writes, 1)
  mission.workspace = f.directory; f.runtime.store.put('missions', mission)
  assert.equal((await f.rpc('apply-delivery', { sessionId: f.ownerId, missionId: mission.id })).result.ok, false)
  assert.equal(writes, 1, 'a changed native workspace cannot redirect delivery')
})

test('a stopped historical member session stays readonly even when active mission views are absent', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  f.workers.start = async () => { throw new Error('Worker failed to start') }
  await assert.rejects(f.runtime.addMember(owner, mission.id, { name: 'Stopped worker', role: 'implementation' }), /Worker failed to start/)
  const member = f.runtime.snapshot(owner, mission.id).members[0]
  assert.equal(member.status, 'stopped')
  f.ctx.sessions.create(SessionId(member.sessionId), { meta: { cwd: f.workspace } })
  const state = await f.rpc('state', { sessionId: member.sessionId })
  assert.equal(state.result.ok, true, state.text)
  assert.deepEqual(state.result.value.snapshots, [])
  assert.equal(state.result.value.writable, false)
  assert.equal(state.result.value.ownerLive, false)
  const denied = await f.rpc('create-draft', { sessionId: member.sessionId, input: f.input })
  assert.equal(denied.result.ok, false)
})

test('model validation rejects unknown routes before saving but accepts routable models outside the catalog', async t => {
  const f = await fixture(t)
  const withModel = (provider, model) => ({ ...f.input, members: [{ ...f.input.members[0], provider, model }] })
  const unknown = await f.rpc('create-draft', { sessionId: f.ownerId, input: withModel('unknown-provider', 'model-one') })
  assert.equal(unknown.result.ok, false)
  assert.match(unknown.result.error.message, /Unknown model provider/)
  const invalid = await f.rpc('create-draft', { sessionId: f.ownerId, input: withModel('public-provider', 'unroutable') })
  assert.equal(invalid.result.ok, false)
  assert.deepEqual(f.runtime.drafts({ sessionId: f.ownerId }), [])
  const valid = await f.rpc('create-draft', { sessionId: f.ownerId, input: withModel('public-provider', 'routable-unlisted-model') })
  assert.equal(valid.result.ok, true, valid.text)
  assert.equal(valid.result.value.draft.input.members[0].model, 'routable-unlisted-model')
})

test('persisted owner state remains readable while launch requires its live composition', async t => {
  const f = await fixture(t)
  const created = await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input })
  const draft = created.result.value.draft
  await f.ctx.sessions.flush(f.ctx.sessions.get(SessionId(f.ownerId)))
  await f.ownerFiber.dispose()
  const state = await f.rpc('state', { sessionId: f.ownerId })
  assert.equal(state.result.ok, true, state.text)
  assert.equal(state.result.value.drafts[0].id, draft.id)
  assert.equal(state.result.value.ownerLive, false)
  const launch = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision })
  assert.equal(launch.result.ok, false)
  assert.match(launch.result.error.message, /Open the owner session/)
})

test('launch revalidates current model routing before side effects and activates one complete plan', async t => {
  const f = await fixture(t)
  const created = await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input })
  const draft = created.result.value.draft
  f.catalog.unavailable = true
  const invalid = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision })
  assert.equal(invalid.result.ok, false)
  assert.match(invalid.result.error.message, /Model route is unavailable/)
  assert.deepEqual(f.workers.workspaces, [], 'no workspace is prepared before route admission')
  assert.deepEqual(f.workers.starts, [], 'no worker is started before route admission')
  f.catalog.unavailable = false
  const launched = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision })
  assert.equal(launched.result.ok, true, launched.text)
  const snapshot = launched.result.value.snapshot
  assert.equal(snapshot.mission.status, 'active')
  assert.equal(snapshot.members.length, 1)
  assert.equal(snapshot.workstreams.length, 1)
  // The deliverable and the independent review the host added for it when the draft was saved.
  assert.deepEqual(snapshot.tasks.map(task => task.kind).sort(), ['implementation', 'verification'])
  const retried = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision })
  assert.equal(retried.result.ok, true, retried.text)
  assert.equal(retried.result.value.snapshot.mission.id, snapshot.mission.id)
  assert.equal(f.workers.workspaces.length, 1)
  f.catalog.unavailable = true
  await f.ctx.sessions.flush(f.ctx.sessions.get(SessionId(f.ownerId)))
  await f.ownerFiber.dispose()
  const coldRetry = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision })
  assert.equal(coldRetry.result.ok, true, coldRetry.text)
  assert.equal(coldRetry.result.value.snapshot.mission.id, snapshot.mission.id, 'an idempotent response does not require recreating the old model composition')
  assert.equal(f.workers.workspaces.length, 1)
})

test('public model response and native route registration contain no configuration and dispose cleanly', async t => {
  const f = await fixture(t)
  // L2: the catalog is no longer the one RPC that skips session resolution.
  const unbound = await f.rpc('models', {})
  assert.equal(unbound.result.ok, false, 'models must bind to an authenticated session')
  assert.match(unbound.result.error.message, /sessionId/)
  const unknown = await f.rpc('models', { sessionId: 'invented-owner' })
  assert.equal(unknown.result.ok, false)
  assert.equal(unknown.result.error.code, 'session-not-found')
  const models = await f.rpc('models', { sessionId: f.ownerId })
  assert.equal(models.result.ok, true, models.text)
  assert.deepEqual(models.result.value, { providers: [{ id: 'public-provider', name: 'Public provider' }],
    models: [{ provider: 'public-provider', id: 'model-one', name: 'Model One', description: 'Public description' }] })
  await f.bridge.dispose()
  assert.equal((await f.rpc('state', { sessionId: f.ownerId })).status, 404)
})


test('unexpected web API failures are sanitized while validation messages stay actionable', async t => {
  const f = await fixture(t)
  // A known validation failure keeps its actionable message.
  const validation = await f.rpc('watch', { sessionId: f.ownerId, afterRevision: -1 })
  assert.equal(validation.result.ok, false)
  assert.match(validation.result.error.message, /afterRevision must be a nonnegative safe integer/)
  // L3: an unexpected internal failure must not leak paths or store schema text.
  f.runtime.visibleMissions = () => [{ id: 'internal-mission' }]
  f.runtime.snapshot = () => { throw new TypeError('SQLITE_ERROR: no such table tasks at /private/var/secret/swarm.sqlite') }
  const internal = await f.rpc('state', { sessionId: f.ownerId })
  assert.equal(internal.result.ok, false)
  assert.equal(internal.result.error.code, 'internal-error')
  assert.doesNotMatch(internal.result.error.message, /secret|SQLITE|private|sqlite/)
  assert.match(internal.result.error.message, /logged/)
})

test('replacement cycles return an actionable bad-request through native RPC without admitting work', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  const stream = f.runtime.workstream(owner, mission.id, { title: 'Graph', objective: 'Repair dependencies' })
  const input = { workstreamId: stream.id, title: 'Original', objective: 'Implement', kind: 'implementation', scope: ['src/'], acceptance: ['works'], outputs: [], checks: ['test -d .'] }
  const original = f.runtime.propose(owner, mission.id, input)
  const dependent = f.runtime.propose(owner, mission.id, { ...input, title: 'Dependent', dependencies: [original.id] })
  f.runtime.cancel(owner, mission.id, { taskId: original.id, reason: 'Revise implementation' })
  const before = f.runtime.store.list('tasks', mission.id)
  const cyclic = { ...input, title: 'Repair', replaces: [original.id], dependencies: [dependent.id] }
  const rejected = await f.rpc('propose', { sessionId: f.ownerId, missionId: mission.id, input: cyclic })
  assert.equal(rejected.result.ok, false)
  assert.equal(rejected.result.error.code, 'bad-request')
  assert.match(rejected.result.error.message, /\[task_graph_cycle\]/)
  assert.match(rejected.result.error.message, /dependencies.*reviewOf.*swarm_propose/)
  assert.deepEqual(rejected.result.error.details, { issues: [], policyCode: 'task_graph_invalid', category: 'validation_error' })
  assert.deepEqual(f.runtime.store.list('tasks', mission.id), before)
  const message = rejected.result.error.message
  f.runtime.propose = () => { throw new Error(message) }
  const imitation = await f.rpc('propose', { sessionId: f.ownerId, missionId: mission.id, input: cyclic })
  assert.equal(imitation.result.error.code, 'internal-error', 'a matching message alone is not a typed validation failure')
  assert.doesNotMatch(imitation.result.error.message, /task_graph_cycle/)
  // A graph refusal naming host detail keeps its fixed repair text instead of being hidden.
  const hosted = { code: 'task_graph_cycle', taskId: '/Users/secret/a', target: 'b', message: 'task "/Users/secret/a" depends on "b". Remove one edge.' }
  f.runtime.propose = () => { throw new TaskGraphAdmissionError([hosted]) }
  const fallback = await f.rpc('propose', { sessionId: f.ownerId, missionId: mission.id, input: cyclic })
  assert.equal(fallback.result.error.code, 'bad-request')
  assert.match(fallback.result.error.message, /^\[task_graph_invalid\] Task dependencies or review sources form an invalid graph/)
  assert.doesNotMatch(fallback.text, /secret/)
})

test('admission refusals are typed policy errors carrying their diagnostics, with the legacy bytes', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, { ...f.input, scope: ['src/'] })
  const stream = f.runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Build it' })
  let refused
  try { f.runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Wide', objective: 'Edit docs', kind: 'research', scope: ['docs/'], acceptance: ['works'] }) } catch (error) { refused = error }
  assert.ok(refused instanceof AdmissionError && refused instanceof PolicyError)
  assert.equal(refused.code, 'scope_selector_out_of_scope')
  assert.equal(errorTypeFor(refused), 'budget_error', 'the category the trace already gave this text')
  assert.equal(refused.message, 'task.scope exceeds mission scope: "docs/" is not covered by allowed mission selectors ["src/"]. Use literal workspace-relative paths or directory prefixes ending in "/", not descriptive prose. Each task selector must match or narrow a mission selector. Narrow `scope` to a subset of the mission `scope` and retry the same task/request, preserving its kind, acceptance criteria and budget; never broaden scope just to pass validation. [scope_selector_out_of_scope]')
  assert.deepEqual(refused.diagnostics, [{ code: 'scope_selector_out_of_scope', location: 'task.scope', message: refused.message }])
  const defects = [{ code: 'task_graph_self_edge', taskId: 'a', target: 'a', message: 'task "a" declares an edge to itself.' }, { code: 'task_graph_unknown_edge', taskId: 'b', target: 'z', message: 'task "b" declares edge "z".' }]
  const graph = new TaskGraphAdmissionError(defects)
  assert.ok(graph instanceof AdmissionError && graph instanceof PolicyError)
  assert.equal(graph.name, 'TaskGraphAdmissionError')
  assert.equal(graph.message, '[task_graph_self_edge] task: task "a" declares an edge to itself.\n[task_graph_unknown_edge] task: task "b" declares edge "z".')
  assert.deepEqual(graph.diagnostics.map(diagnostic => diagnostic.code), ['task_graph_self_edge', 'task_graph_unknown_edge'])
  assert.deepEqual(graph.defects, defects)
})

test('plan refusals reach the browser by type at the validator and at the launch boundary', async t => {
  const f = await fixture(t)
  const several = structuredClone(f.input)
  several.tasks[0].priority = 101
  several.tasks[0].scope = ['lib/']
  const staged = await f.rpc('create-draft', { sessionId: f.ownerId, input: several })
  assert.equal(staged.result.error.code, 'bad-request', staged.text)
  assert.match(staged.result.error.message, /^tasks\[0\]\.scope exceeds mission scope: "lib\/"[^\n]+\[scope_selector_out_of_scope\]\ntasks\[0\] \(build\)\.priority must be 0–100$/)
  assert.deepEqual(staged.result.error.details, { issues: [], policyCode: 'plan_invalid', category: 'budget_error' })
  // Launch revalidates the saved plan outside the scrub-exempt validator call.
  const draft = (await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input })).result.value.draft
  f.runtime.store.transaction(() => f.runtime.store.put('drafts', { ...draft, input: { ...draft.input, title: '' } }))
  const launch = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision })
  assert.equal(launch.result.error.code, 'bad-request', launch.text)
  assert.equal(launch.result.error.message, 'Title must be nonempty text of at most 16000 characters')
  assert.deepEqual(launch.result.error.details, { issues: [], policyCode: 'plan_text_invalid', category: 'validation_error' })
  // Several undeclared tasks reach the browser as one [outputs_required]
  // refusal with that policy code, not as plan_invalid with a token per task.
  const { outputs: _outputs, ...build } = f.input.tasks[0]
  const undeclared = { ...f.input, members: [...f.input.members, { key: 'reviewer', name: 'Reviewer', role: 'verification' }],
    tasks: [build, { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Review the build', kind: 'verification', scope: ['src/'], acceptance: ['works'], reviewOf: 'build', assigneeKey: 'reviewer' }] }
  const stagedUndeclared = (await f.rpc('create-draft', { sessionId: f.ownerId, input: undeclared })).result.value.draft
  const refusedLaunch = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: stagedUndeclared.id, revision: stagedUndeclared.revision })
  assert.equal(refusedLaunch.result.error.code, 'bad-request', refusedLaunch.text)
  assert.deepEqual(refusedLaunch.result.error.details, { issues: [], policyCode: 'outputs_required', category: 'validation_error' })
  assert.equal(refusedLaunch.result.error.message, '[outputs_required] tasks[0] (build).outputs, tasks[1] (review).outputs are required to launch. Set `outputs` on each of those tasks to the repository-relative files it writes, or to [] for analysis-only work, and relaunch the complete plan.')
  assert.deepEqual(f.runtime.store.list('missions'), [], 'a refused launch admits nothing')
})

test('mission authority, lifecycle and budget refusals reach the browser by their policy code, with the legacy wording', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, { ...f.input, budget: { ...budget, maxWorkers: 1 } })
  const stream = f.runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Build it' })
  const propose = { workstreamId: stream.id, title: 'Research', objective: 'Read it', kind: 'research', scope: ['src/'], acceptance: ['works'], outputs: [] }
  await f.runtime.addMember(owner, mission.id, { name: 'Worker', role: 'implementation' })
  const refused = async (endpoint, payload, message, policyCode, category) => {
    const response = await f.rpc(endpoint, { sessionId: f.ownerId, ...payload })
    assert.equal(response.result.error.code, 'bad-request', response.text)
    assert.equal(response.result.error.message, message)
    assert.deepEqual(response.result.error.details, { issues: [], policyCode, category })
    assert.equal(category, errorTypeFor(new Error(message)), `${policyCode} keeps the trace category its text had`)
  }
  await refused('cancel', { missionId: 'mission-missing', taskId: 'x', reason: 'x' }, 'Unknown mission', 'mission_unknown', 'validation_error')
  await refused('propose', { missionId: mission.id, input: { ...propose, workstreamId: 'stream-missing' } }, 'Unknown workstream', 'workstream_unknown', 'validation_error')
  await refused('add-member', { missionId: mission.id, input: { name: 'Second', role: 'implementation' } }, 'Mission worker budget exhausted', 'mission_worker_budget_exhausted', 'budget_error')
  f.runtime.control(owner, mission.id, 'pause', 'Hold')
  await refused('propose', { missionId: mission.id, input: propose }, 'Mission is paused', 'mission_not_active', 'tool_error')
  f.runtime.control(owner, mission.id, 'stop', 'Done')
  await refused('cancel', { missionId: mission.id, taskId: 'x', reason: 'x' }, 'Mission is terminal; create a new mission to continue', 'mission_terminal', 'conflict_error')
  // The observe detail refusal is typed and still recorded under its own name.
  const detail = new ObserveDetailRefusedError()
  assert.ok(detail instanceof PolicyError)
  assert.equal(detail.code, 'observe_detail_full_owner_only')
  assert.equal(errorTypeFor(detail), errorTypeFor(new Error(detail.message)))
  assert.equal(String(detail), `ObserveDetailRefusedError: ${detail.message}`)
})

test('task admission refusals reach the browser by their policy code, with the legacy wording', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  const stream = f.runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Build it' })
  const research = { workstreamId: stream.id, title: 'Research', objective: 'Read it', kind: 'research', scope: ['src/'], acceptance: ['works'], outputs: [] }
  const pending = f.runtime.propose(owner, mission.id, research)
  const before = f.runtime.store.list('tasks', mission.id)
  const refused = async (input, message, policyCode, category) => {
    const response = await f.rpc('propose', { sessionId: f.ownerId, missionId: mission.id, input })
    assert.equal(response.result.error.code, 'bad-request', response.text)
    assert.equal(response.result.error.message, message)
    assert.deepEqual(response.result.error.details, { issues: [], policyCode, category })
    assert.equal(category, errorTypeFor(new Error(message)), `${policyCode} keeps the trace category its text had`)
  }
  await refused({ ...research, kind: 'verification' }, 'Verification requires reviewOf', 'verification_review_source_required', 'validation_error')
  await refused({ ...research, reviewOf: pending.id }, 'Only verification tasks may set reviewOf', 'review_source_not_verification', 'tool_error')
  await refused({ ...research, replaces: [pending.id] },
    `replaces ${pending.id}: that task is pending, and only blocked or cancelled work can be replaced; wait for its verdict or use swarm_handoff/challenge`,
    'replacement_source_not_blocked', 'tool_error')
  await refused({ ...research, maxRecoveryAttempts: 0 }, 'maxRecoveryAttempts must be a positive safe integer', 'task_recovery_limit_invalid', 'validation_error')
  // No tool schema types the RPC input: a string priority or experiment used to
  // be stored, and the client then rejected the whole mission snapshot.
  await refused({ ...research, priority: '3' }, '[task_priority_invalid] `priority` must be an integer. Pass `priority` as an integer with `swarm_propose`, or omit it for the default, then retry.', 'task_priority_invalid', 'validation_error')
  await refused({ ...research, priority: 2.5 }, '[task_priority_invalid] `priority` must be an integer. Pass `priority` as an integer with `swarm_propose`, or omit it for the default, then retry.', 'task_priority_invalid', 'validation_error')
  await refused({ ...research, assigneeId: '' }, "[task_assignee_empty] `assigneeId` must be a member id; an empty string names no member and would bind the task to nobody. Omit `assigneeId` to leave the task unassigned, or pass a live member's id as `assigneeId`, then retry `swarm_propose`.", 'task_assignee_empty', 'validation_error')
  await refused({ ...research, experiment: 'false' }, '[task_experiment_invalid] `experiment` must be a boolean. Pass `experiment` as true or false with `swarm_propose`, or omit it, then retry.', 'task_experiment_invalid', 'validation_error')
  // The browser RPC is a direct runtime caller with no tool schema in front of
  // it: a task without outputs is refused, typed, instead of being stored.
  const { outputs: _outputs, ...undeclared } = research
  await refused(undeclared, '[outputs_required] `outputs` is required: a new task must declare the files it writes. Pass `outputs` with `swarm_propose` as the repository-relative files this task writes inside its `scope`, or [] for analysis-only work, then retry.', 'outputs_required', 'validation_error')
  assert.deepEqual(f.runtime.store.list('tasks', mission.id), before, 'a refused proposal admits nothing')
})

test('an automatic mission refuses an unbounded propose RPC as a typed bad-request, not an internal error', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  const stream = f.runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Build it' })
  f.runtime.store.transaction(() => f.runtime.store.put('starts', { id: 'start_typed', ownerSessionId: f.ownerId,
    commandId: 'typed', goal: 'g', workspace: f.workspace, status: 'running', createdAt: Date.now(), updatedAt: Date.now(), missionId: mission.id }))
  const before = f.runtime.store.list('tasks', mission.id)
  const input = { workstreamId: stream.id, title: 'Unbounded', objective: 'Implement it', kind: 'implementation', scope: ['src/'], acceptance: ['works'], outputs: [], checks: ['test -d .'] }
  const recovery = await f.rpc('propose', { sessionId: f.ownerId, missionId: mission.id, input })
  assert.equal(recovery.result.ok, false)
  assert.equal(recovery.result.error.code, 'bad-request', recovery.text)
  assert.deepEqual(recovery.result.error.details, { issues: [], policyCode: 'task_recovery_limit_required', category: 'validation_error' })
  assert.match(recovery.result.error.message, /^\[task_recovery_limit_required\] Automatic tasks require a recovery limit chosen by the primary agent\. Pass `maxRecoveryAttempts`/)
  const timeout = await f.rpc('propose', { sessionId: f.ownerId, missionId: mission.id, input: { ...input, maxRecoveryAttempts: 2 } })
  assert.equal(timeout.result.error.code, 'bad-request', timeout.text)
  assert.deepEqual(timeout.result.error.details, { issues: [], policyCode: 'task_check_timeout_required', category: 'validation_error' })
  assert.match(timeout.result.error.message, /^\[task_check_timeout_required\] Automatic task checks require a timeout chosen by the primary agent\. Pass `checkTimeoutMs`/)
  assert.deepEqual(f.runtime.store.list('tasks', mission.id), before, 'a refused proposal admits nothing')
})

test('add-member validates subscriptions as a string array before admitting a worker', async t => {
  const f = await fixture(t)
  const mission = f.runtime.create({ sessionId: f.ownerId }, f.input)
  // M9(c): a bare string would be stored and make topic matching substring-based.
  const rejected = await f.rpc('add-member', { sessionId: f.ownerId, missionId: mission.id,
    input: { name: 'Worker', role: 'implementation', subscriptions: 'topic-a' } })
  assert.equal(rejected.result.ok, false, 'a non-array subscriptions value must be rejected')
  assert.match(rejected.result.error.message, /subscriptions must be a string array/)
  assert.deepEqual(f.runtime.snapshot({ sessionId: f.ownerId }, mission.id).members, [], 'no worker is admitted on a rejected request')
  const invalidItem = await f.rpc('add-member', { sessionId: f.ownerId, missionId: mission.id,
    input: { name: 'Worker', role: 'implementation', subscriptions: ['topic-a', 7] } })
  assert.equal(invalidItem.result.ok, false)
  assert.match(invalidItem.result.error.message, /subscriptions must be a string array/)
  const accepted = await f.rpc('add-member', { sessionId: f.ownerId, missionId: mission.id,
    input: { name: 'Worker', role: 'implementation', subscriptions: ['topic-a', 'topic-b'] } })
  assert.equal(accepted.result.ok, true, accepted.text)
  assert.deepEqual(accepted.result.value.member.subscriptions, ['topic-a', 'topic-b'])
})

test('worker history pages retain message source groups and cold sessions without activating workers', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  const member = await f.runtime.addMember(owner, mission.id, { name: 'History worker', role: 'research' })
  let worker
  const workerScope = f.ctx.plugin({ name: 'history-worker-fixture', inject: ['agents'], async apply(scope) {
    // Use the native factory so the host binds its persistence write handle.
    // No wake is sent; history inspection after disposal must keep it cold.
    const handle = await scope.agents.create({ sessionId: SessionId(member.sessionId), meta: { cwd: f.workspace }, agentOptions: { provider: 'public-provider', model: 'model-one' } })
    worker = handle.agent.session
  } })
  await workerScope
  for (let turn = 1; turn <= 3; turn++) {
    const source = worker.append('turn/start', { turn })
    worker.append('user/message', { id: `message-${turn}`, role: 'user', content: [{ type: 'text', text: `History message ${turn}` }], source: { kind: 'user' } }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
    worker.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  await f.ctx.sessions.flush(worker)
  await workerScope.dispose()
  assert.equal(f.ctx.sessions.get(SessionId(member.sessionId)), undefined)
  assert.equal(f.ctx.agents.get(SessionId(member.sessionId)), undefined)
  const page = await f.rpc('worker-history', { sessionId: f.ownerId, workerSessionId: member.sessionId, maxMessages: 1 })
  assert.equal(page.result.ok, true, page.text)
  assert.equal(page.result.value.hasMore, true)
  assert.equal(page.result.value.events[0].event.type, 'turn/start', 'page retains the source event cited by its first message')
  assert.equal(page.result.value.events.filter(row => row.event.type === 'user/message').length, 1)
  assert.equal(page.result.value.events.find(row => row.event.type === 'user/message').event.data.id, 'message-3')
  const earlier = await f.rpc('worker-history', { sessionId: f.ownerId, workerSessionId: member.sessionId,
    maxMessages: 2, beforeSeq: page.result.value.events[0].event.seq })
  assert.equal(earlier.result.ok, true, earlier.text)
  assert.deepEqual(earlier.result.value.events.filter(row => row.event.type === 'user/message').map(row => row.event.data.id), ['message-1', 'message-2'])
  assert.ok(earlier.result.value.events.at(-1).event.seq < page.result.value.events[0].event.seq)
  assert.equal(f.ctx.sessions.get(SessionId(member.sessionId)), undefined, 'inspection must not publish a cold Session')
  assert.equal(f.ctx.agents.get(SessionId(member.sessionId)), undefined, 'history must not promote a worker Agent')
  const outsider = await f.rpc('worker-history', { sessionId: 'other-owner', workerSessionId: member.sessionId })
  assert.equal(outsider.result.ok, false)
  assert.match(outsider.result.error.message, /Only the mission owner/)
  const unrelated = await f.rpc('worker-history', { sessionId: f.ownerId, workerSessionId: 'other-owner' })
  assert.equal(unrelated.result.ok, false)
  for (const input of [{ maxMessages: 101 }, { maxMessages: 0 }, { beforeSeq: -1 }]) {
    assert.equal((await f.rpc('worker-history', { sessionId: f.ownerId, workerSessionId: member.sessionId, ...input })).result.ok, false)
  }
  f.runtime.control(owner, mission.id, 'stop', 'Preserve historical review access')
  const historical = await f.rpc('worker-history', { sessionId: f.ownerId, workerSessionId: member.sessionId })
  assert.equal(historical.result.ok, true, historical.text)
})

test('watch returns only authorized changed missions and includes eventless state updates', async t => {
  const f = await fixture(t)
  const initial = (await f.rpc('state', { sessionId: f.ownerId })).result.value
  assert.equal(typeof initial.revision, 'number')
  const mission = f.runtime.create({ sessionId: f.ownerId }, f.input)
  const first = (await f.rpc('watch', { sessionId: f.ownerId, afterRevision: initial.revision, waitMs: 0 })).result.value
  assert.equal(first.kind, 'delta')
  assert.deepEqual(first.missionIds, [mission.id])
  assert.equal(first.state.snapshots[0].mission.id, mission.id)
  const previous = first.revision
  f.runtime.store.transaction(() => {
    const current = f.runtime.store.get('missions', mission.id)
    current.usedTokens = 42
    f.runtime.store.put('missions', current)
  })
  const updated = (await f.rpc('watch', { sessionId: f.ownerId, afterRevision: previous, waitMs: 0 })).result.value
  assert.equal(updated.kind, 'delta')
  assert.equal(updated.state.snapshots[0].mission.usedTokens, 42)
  const other = (await f.rpc('watch', { sessionId: 'other-owner', afterRevision: initial.revision, waitMs: 0 })).result.value
  assert.equal(other.kind, 'heartbeat')
  assert.equal(other.state, undefined)
  const reset = (await f.rpc('watch', { sessionId: f.ownerId, afterRevision: updated.revision + 100, waitMs: 0 })).result.value
  assert.equal(reset.kind, 'snapshot')
  assert.deepEqual(reset.missionIds, [mission.id])
  const unauthenticated = await f.rpc('watch', { sessionId: f.ownerId, waitMs: 0 }, { headers: { cookie: '' } })
  assert.equal(unauthenticated.status, 401)
})

test('watch observes draft-only planning changes and validates its bounded wait/cursor', async t => {
  const f = await fixture(t)
  const initial = (await f.rpc('state', { sessionId: f.ownerId })).result.value
  const created = (await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input })).result.value.draft
  const draftUpdate = (await f.rpc('watch', { sessionId: f.ownerId, afterRevision: initial.revision, waitMs: 0 })).result.value
  assert.equal(draftUpdate.kind, 'delta')
  assert.deepEqual(draftUpdate.state.snapshots, [])
  assert.equal(draftUpdate.state.drafts[0].id, created.id)
  for (const payload of [{ afterRevision: -1 }, { afterRevision: 0.5 }, { waitMs: 20001 }]) {
    assert.equal((await f.rpc('watch', { sessionId: f.ownerId, ...payload })).result.ok, false)
  }
  const idle = (await f.rpc('watch', { sessionId: f.ownerId, afterRevision: draftUpdate.revision, waitMs: 5 })).result.value
  assert.equal(idle.kind, 'heartbeat')
})

test('native watch wakes on commit and releases observers when its plugin unloads', async t => {
  const f = await fixture(t)
  const initial = (await f.rpc('state', { sessionId: f.ownerId })).result.value
  const pending = f.rpc('watch', { sessionId: f.ownerId, afterRevision: initial.revision, waitMs: 1000 })
  await new Promise(resolve => setTimeout(resolve, 25))
  f.runtime.create({ sessionId: f.ownerId }, f.input)
  const response = await pending
  assert.equal(response.result.value.kind, 'delta')
  const unloading = f.rpc('watch', { sessionId: f.ownerId, afterRevision: response.result.value.revision, waitMs: 1000 })
  await new Promise(resolve => setTimeout(resolve, 25))
  await f.bridge.dispose()
  const cancelled = await unloading
  assert.equal(cancelled.result.ok, false)
  assert.match(cancelled.result.error.message, /unloaded|cancelled/)
})

test('watch removes mission data when a worker loses read membership', async t => {
  const f = await fixture(t)
  const mission = f.runtime.create({ sessionId: f.ownerId }, f.input)
  const member = await f.runtime.addMember({ sessionId: f.ownerId }, mission.id, { name: 'Worker', role: 'Builder' })
  f.ctx.sessions.create(SessionId(member.sessionId), { meta: { cwd: f.workspace } })
  const initial = (await f.rpc('state', { sessionId: member.sessionId })).result.value
  assert.equal(initial.snapshots.length, 1)
  // R17-G7: the durable phase is what stops a member; the live status is derived.
  f.runtime.store.transaction(() => f.runtime.store.put('members', { ...member, phase: 'stopped' }))
  const removed = (await f.rpc('watch', { sessionId: member.sessionId, afterRevision: initial.revision, waitMs: 0 })).result.value
  assert.equal(removed.kind, 'delta')
  assert.deepEqual(removed.missionIds, [])
  assert.deepEqual(removed.state.snapshots, [])
  assert.equal(removed.state.writable, false)
})

test('watch wakes for native owner lifecycle without inventing a swarm revision', async t => {
  const f = await fixture(t)
  const initial = (await f.rpc('state', { sessionId: f.ownerId })).result.value
  assert.equal(initial.ownerLive, true)
  // Explicit durability and subscription admission avoid racing persistence/HTTP setup with resume.
  await f.ctx.sessions.flush(f.ctx.agents.get(SessionId(f.ownerId)).session)
  const subscribe = f.runtime.store.subscribe.bind(f.runtime.store)
  let admitted
  f.runtime.store.subscribe = listener => { const remove = subscribe(listener); admitted?.(); return remove }
  const watch = () => {
    const ready = new Promise(resolve => { admitted = resolve })
    const response = f.rpc('watch', { sessionId: f.ownerId, afterRevision: initial.revision, waitMs: 1000 })
    return { response, ready: Promise.race([ready, response.then(reply => { throw new Error(`Watch ended before lifecycle action: ${JSON.stringify(reply.result)}`) })]) }
  }
  const watching = watch()
  await watching.ready
  await f.ownerFiber.dispose()
  const dormantReply = await watching.response
  assert.equal(dormantReply.result.ok, true, JSON.stringify(dormantReply.result))
  const dormant = dormantReply.result.value
  assert.equal(dormant.kind, 'heartbeat')
  assert.equal(dormant.ownerLive, false)
  assert.equal(dormant.revision, initial.revision)
  assert.deepEqual(dormant.defaultBudget, initial.defaultBudget)
  const resumedWatch = watch()
  await resumedWatch.ready
  const resumed = await f.ctx.agents.resume({ resumeSessionId: SessionId(f.ownerId), agentOptions: { provider: 'public-provider', model: 'model-one' } })
  t.after(() => resumed.dispose())
  const resumedReply = await resumedWatch.response
  assert.equal(resumedReply.result.ok, true, JSON.stringify(resumedReply.result))
  const live = resumedReply.result.value
  assert.equal(live.kind, 'heartbeat')
  assert.equal(live.ownerLive, true)
  assert.equal(live.revision, initial.revision)
})

test('web request controls recover and stop prelaunch work with native session authorization', async t => {
  const f = await fixture(t)
  const actor = { sessionId: f.ownerId }
  const request = f.runtime.requestStart(actor, { commandId: 'web-planning', workspace: f.workspace, goal: 'Inspect this repository' })
  f.runtime.failStart(actor, request.id, 'Interrupted planning')
  const denied = await f.rpc('control', { sessionId: 'other-owner', requestId: request.id, action: 'retry', reason: 'Retry' })
  assert.equal(denied.result.ok, false)
  const ambiguous = await f.rpc('control', { sessionId: f.ownerId, requestId: request.id, missionId: 'unknown', action: 'retry', reason: 'Retry' })
  assert.equal(ambiguous.result.ok, false)
  const retry = await f.rpc('control', { sessionId: f.ownerId, requestId: request.id, action: 'retry', reason: 'Retry' })
  assert.equal(retry.result.ok, true, JSON.stringify(retry.result))
  assert.equal(retry.result.value.request.planningEpoch, 2)
  assert.equal(retry.result.value.request.planningDispatchPending, true)
  const stop = await f.rpc('control', { sessionId: f.ownerId, requestId: request.id, action: 'stop', reason: 'User cancelled' })
  assert.equal(stop.result.ok, true)
  assert.equal(stop.result.value.request.status, 'stopped')
})


test('M4-F3: authenticated catalog RPC retains healthy providers when another real adapter catalog fails', async t => {
  const f = await fixture(t)
  f.ctx.llm.registerAdapter(['failed-provider'], f.catalog)
  f.catalog.failedCatalogs.add('failed-provider')
  const response = await f.rpc('models', { sessionId: f.ownerId })
  assert.equal(response.status, 200)
  assert.equal(response.result.ok, true)
  assert.deepEqual(response.result.value.models.map(model => [model.provider, model.id]), [['public-provider', 'model-one']])
  assert.deepEqual(response.result.value.providerErrors, [{ provider: 'failed-provider', code: 'catalog-unavailable', message: 'Model catalog is temporarily unavailable' }])
  assert.doesNotMatch(response.text, /private|provider\.env|Catalog failed/)
  await f.bridge.dispose()
  const unmounted = await f.rpc('models', { sessionId: f.ownerId })
  assert.equal(unmounted.status, 404, 'the real route disposer completed before plugin unload resolves')
})

test('native web task controls revise the original policy and preserve session authority', async t => {
  const f = await fixture(t)
  const draft = (await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input })).result.value.draft
  const launched = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision })
  assert.equal(launched.result.ok, true, launched.text)
  const snapshot = launched.result.value.snapshot
  const task = snapshot.tasks[0]
  const payload = { missionId: snapshot.mission.id, taskId: task.id, action: 'amend', changes: { maxSteps: 20, maxRecoveryAttempts: 4 }, reason: 'Review estimates' }
  const denied = await f.rpc('control', { ...payload, sessionId: 'other-owner' })
  assert.equal(denied.result.ok, false)
  const amended = await f.rpc('control', { ...payload, sessionId: f.ownerId })
  assert.equal(amended.result.ok, true, amended.text)
  const current = amended.result.value.snapshot.tasks.find(row => row.id === task.id)
  assert.equal(current.maxSteps, 20)
  assert.equal(current.maxRecoveryAttempts, 4)
  assert.deepEqual(current.acceptance, task.acceptance)
  assert.equal(amended.result.value.snapshot.tasks.length, snapshot.tasks.length)
  const invalid = await f.rpc('control', { ...payload, sessionId: f.ownerId, changes: { scope: ['../escape'] } })
  assert.equal(invalid.result.ok, false)
  assert.match(invalid.result.error.message, /scope|relative|invalid/i)
  // An amendment naming no field used to write task/amended {} and a handoff line.
  const amendedEvents = () => f.runtime.store.events(snapshot.mission.id, 5000).filter(event => event.type === 'task/amended').length
  const recorded = amendedEvents()
  for (const changes of [{}, undefined]) {
    const empty = await f.rpc('control', { ...payload, sessionId: f.ownerId, changes })
    assert.equal(empty.result.ok, false, empty.text)
    assert.equal(empty.result.error.details.policyCode, 'task_amendment_empty')
  }
  assert.equal(amendedEvents(), recorded, 'nothing was recorded')
})

test('authored draft refusals keep a stable category through native RPC when wording changes', async t => {
  const f = await fixture(t)
  const draft = (await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input })).result.value.draft
  f.runtime.store.transaction(() => f.runtime.store.put('drafts', { ...draft, status: 'launched' }))
  const payload = { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision, input: f.input }
  const response = await f.rpc('update-draft', payload)
  assert.equal(response.result.ok, false)
  assert.equal(response.result.error.code, 'bad-request')
  assert.match(response.result.error.message, /Only draft or failed plans/)
  assert.deepEqual(response.result.error.details, { issues: [], policyCode: 'draft_not_editable', category: 'conflict_error' })
  assert.equal(f.runtime.store.get('drafts', draft.id).revision, draft.revision)
  const refusal = new PolicyError('draft_not_editable', 'conflict_error', '请重新打开可编辑的草稿。')
  f.runtime.updateDraft = () => { throw refusal }
  const translated = await f.rpc('update-draft', payload)
  assert.equal(translated.result.error.message, refusal.message)
  assert.equal(translated.result.error.details.policyCode, refusal.code)
  assert.equal(errorTypeFor(refusal), 'conflict_error', 'trace reads the same category without parsing the new prose')
  for (const failure of [
    new PolicyError('draft_not_editable', 'conflict_error', 'Cannot read /Users/private/secret.sqlite'),
    new PolicyError('draft_not_editable', 'conflict_error', 'x'.repeat(4001)),
    Object.assign(new Error('host operation failed unexpectedly'), { code: 'draft_not_editable', category: 'conflict_error' }),
  ]) {
    f.runtime.updateDraft = () => { throw failure }
    const hidden = await f.rpc('update-draft', payload)
    assert.equal(hidden.result.error.code, 'internal-error')
    assert.doesNotMatch(hidden.result.error.message, /secret|private|host operation/)
    assert.equal(hidden.result.error.details.policyCode, undefined, 'an untrusted shape or unsafe detail is not an authored public refusal')
  }
})

test('launch refusals reach the browser by their policy code, with the legacy wording unchanged', async t => {
  const f = await fixture(t)
  const draft = (await f.rpc('create-draft', { sessionId: f.ownerId, input: f.input })).result.value.draft
  const stale = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision + 1 })
  assert.equal(stale.result.error.code, 'bad-request', stale.text)
  assert.equal(stale.result.error.message, 'Draft changed; reload before launching')
  assert.deepEqual(stale.result.error.details, { issues: [], policyCode: 'draft_revision_conflict', category: 'conflict_error' })
  f.runtime.store.transaction(() => f.runtime.store.put('drafts', { ...draft, status: 'launching' }))
  const busy = await f.rpc('launch-draft', { sessionId: f.ownerId, draftId: draft.id, revision: draft.revision })
  assert.equal(busy.result.error.message, 'Draft cannot be launched in its current state')
  assert.deepEqual(busy.result.error.details, { issues: [], policyCode: 'draft_not_launchable', category: 'conflict_error' })
  assert.equal(f.runtime.store.get('drafts', draft.id).status, 'launching', 'a refused launch changes nothing')
})

test('a shutting-down runtime refuses control RPCs with a typed conflict', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  f.runtime.shuttingDown = true
  const refused = await f.rpc('cancel', { sessionId: f.ownerId, missionId: mission.id, taskId: 'any', reason: 'x' })
  assert.equal(refused.result.error.code, 'bad-request', refused.text)
  assert.equal(refused.result.error.message, 'Swarm runtime is shutting down')
  assert.deepEqual(refused.result.error.details, { issues: [], policyCode: 'runtime_shutting_down', category: 'conflict_error' })
})

test('mission owner refusals carry authorization even when the wording has no legacy match', async t => {
  const f = await fixture(t)
  const mission = f.runtime.create({ sessionId: f.ownerId }, { ...f.input, workspace: f.workspace })
  const member = await f.runtime.addMember({ sessionId: f.ownerId }, mission.id, { role: 'implementation' })
  let refused
  try { f.runtime.control({ sessionId: member.sessionId }, mission.id, 'pause', 'Pause') } catch (error) { refused = error }
  assert.ok(refused instanceof PolicyError)
  assert.equal(refused.code, 'mission_owner_required')
  assert.equal(errorTypeFor(refused), 'authorization_error')
  assert.equal(f.runtime.mission(mission.id).status, 'active')
})

test('task and scope controls distinguish owner lifecycle conflicts from member authorization refusals', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, { ...f.input, workspace: f.workspace })
  const member = await f.runtime.addMember(owner, mission.id, { role: 'implementation' })
  const actor = { sessionId: member.sessionId }
  const taskPayload = { missionId: mission.id, taskId: 'guarded-task', action: 'resume', reason: 'Resume saved work' }
  const scopePayload = { missionId: mission.id, action: 'amend', changes: { scope: mission.scope }, reason: 'Keep scope' }
  const checkMember = () => {
    for (const [call, code] of [
      [() => f.runtime.controlTask(actor, mission.id, taskPayload.taskId, 'resume', {}, taskPayload.reason), 'task_owner_required'],
      [() => f.runtime.amendScope(actor, mission.id, mission.scope, scopePayload.reason), 'mission_scope_owner_required'],
    ]) assert.throws(call, error => error instanceof PolicyError && error.code === code && errorTypeFor(error) === 'authorization_error')
  }
  for (const status of ['staged', 'completed', 'stopped']) {
    f.runtime.store.put('missions', { ...f.runtime.mission(mission.id), status })
    checkMember()
    for (const [payload, code] of [[taskPayload, 'mission_not_running'], [scopePayload, 'mission_scope_not_running']]) {
      const response = await f.rpc('control', { sessionId: f.ownerId, ...payload })
      assert.equal(response.result.ok, false)
      assert.equal(response.result.error.code, 'bad-request')
      assert.equal(response.result.error.details.policyCode, code)
      assert.equal(response.result.error.details.category, 'conflict_error', `${status} is a lifecycle conflict for the owner`)
    }
    assert.equal(f.runtime.mission(mission.id).status, status)
    assert.deepEqual(f.runtime.mission(mission.id).scope, mission.scope)
  }
  f.runtime.store.put('missions', { ...f.runtime.mission(mission.id), status: 'active' })
  f.runtime.shuttingDown = true
  try {
    checkMember()
    const response = await f.rpc('control', { sessionId: f.ownerId, ...taskPayload })
    assert.equal(response.result.error.details.policyCode, 'runtime_shutting_down')
    assert.equal(response.result.error.details.category, 'conflict_error')
  } finally { f.runtime.shuttingDown = false }
})
