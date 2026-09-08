/** Real native HTTP/Connection transport over the real runtime and SQLite. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
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
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-web-api-')))
  const workspace = path.join(directory, 'workspace')
  await mkdir(workspace)
  const ctx = new Context()
  let runtime
  t.after(async () => { await runtime?.dispose(); await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  // In-memory credential storage; authentication/token/cookie enforcement is
  // the actual modern Connection implementation, never a bypass.
  let credentialRecord
  ctx.provide('credentials', {
    readRecord: async () => credentialRecord,
    modifyRecord: async (_key, mutate) => (credentialRecord = await mutate(credentialRecord)),
    deleteRecord: async () => { credentialRecord = undefined },
  })
  await ctx.plugin(Connection, { trustedHosts: ['lan.example'], maxRequestBodyBytes: 1048576 })
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
    providerInfo(id) { return { id, name: 'Public provider' } }
    async listModels(provider) { return [{ provider, id: 'model-one', name: 'Model One', description: 'Public description' }] }
    async resolveModel(provider, model) {
      if (this.unavailable || model === 'unroutable' || this.blockedModels.has(model)) throw new Error('Model route is unavailable')
      return { provider, id: model, name: model, ...(model === 'reasoning-model' ? {
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'off' },
      } : {}) }
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
  const bridge = ctx.plugin({ name: 'test-swarm-web', inject: ['connection', 'sessions', 'sessionPersistence', 'agents', 'llm'], apply(scope) { registerWebApi(scope, runtime, { defaultBudget: budget, maxPayloadBytes: 8192 }) } })
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
    const body = options.raw ?? JSON.stringify({ type: 'client-request', rpcId: 'web-test', method: endpoint, payload })
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', cookie, ...options.headers }
    return await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, path: `/agent-swarm/${endpoint}`, method: options.method ?? 'POST', headers }, res => {
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
    tasks: [{ key: 'build', workstreamKey: 'main', title: 'Build', objective: 'Make the change', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeKey: 'builder' }] }
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
    for (const sessionId of ['other-owner', member.sessionId]) {
      const denied = await f.rpc(endpoint, { sessionId, missionId: mission.id })
      assert.equal(denied.result.ok, false)
    }
  }
  assert.equal(writes, 0)
  mission.status = 'completed'
  mission.baseline = { sourceHead: 'a'.repeat(40), snapshotCommit: 'b'.repeat(40), planningWorkspace: '/private/planning', changedPaths: ['user.txt'], createdAt: 1 }
  f.runtime.store.put('missions', mission)
  const source = { id: 'delivery-source', missionId: mission.id, kind: 'implementation', status: 'accepted', dependencies: [], artifact: { commit: 'c'.repeat(40) } }
  const final = { id: 'delivery-final', missionId: mission.id, kind: 'integration', status: 'accepted', dependencies: [source.id], artifact: { commit: 'd'.repeat(40) } }
  f.runtime.store.put('tasks', source); f.runtime.store.put('tasks', final)
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
  assert.equal(snapshot.tasks.length, 1)
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
  const models = await f.rpc('models', {})
  assert.equal(models.result.ok, true, models.text)
  assert.deepEqual(models.result.value, { providers: [{ id: 'public-provider', name: 'Public provider' }],
    models: [{ provider: 'public-provider', id: 'model-one', name: 'Model One', description: 'Public description' }] })
  await f.bridge.dispose()
  assert.equal((await f.rpc('state', { sessionId: f.ownerId })).status, 404)
})


test('worker history pages retain message source groups and cold sessions without activating workers', async t => {
  const f = await fixture(t)
  const owner = { sessionId: f.ownerId }
  const mission = f.runtime.create(owner, f.input)
  const member = await f.runtime.addMember(owner, mission.id, { name: 'History worker', role: 'research' })
  let worker
  const workerScope = f.ctx.plugin({ name: 'history-worker-fixture', inject: ['agents'], async apply(scope) {
    // Use the native factory so alpha.2 binds its persistence write handle.
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
  f.runtime.store.transaction(() => f.runtime.store.put('members', { ...member, status: 'stopped' }))
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
