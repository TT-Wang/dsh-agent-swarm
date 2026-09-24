import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { HarnessWorkers } from '../lib/harness-workers.js'

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t, create) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-r12-native-'))
  const hooks = new Map(), nativeHooks = new Map(), calls = { guard: 0, beforeStep: 0, create: 0, disposed: 0, sent: 0, idle: 0, cancelled: 0, revoked: 0 }
  const on = map => (name, hook) => { map.set(name, hook); return () => map.delete(name) }
  let guard
  const agent = { id: 'worker-session', status: 'idle', inbox: { nextTurn: [], nextStep: [], remove() {} },
    session: { snapshotEvents: () => [], append() {} }, cancel() { calls.cancelled++ }, async whenIdle() {}, send() { calls.sent++ } }
  const handle = { agent, async dispose() { calls.disposed++ } }
  const agentCtx = { agent, on: on(nativeHooks), systemPrompt: { section() {} }, tools: { schemas: () => [], restrict() {}, guard(fn) { guard = fn } } }
  const ctx = { on: on(hooks), logger: { warn() {}, error() {} }, sessions: { async flush() {}, get: () => agent.session },
    get(name) { if (name === 'sessionPersistence') return { async stat() {} }; if (name === 'sandboxPolicy' || name === 'approval') return {}; if (name === 'sessions') return this.sessions },
    agents: { withoutInitiator: fn => fn(), async create(options) { calls.create++; await options.setup(agentCtx, agent); return create ? await create({ options, handle }) : handle } } }
  const adapter = new HarnessWorkers(ctx, { workspacesRoot: root, checkTimeoutMs: 1000, maxCheckOutputBytes: 1000, activityHeartbeatMs: 0 })
  adapter.workspaces = { prepareWorkspace: async () => '/worker', metadataPath: () => join(root, 'worker.json'), cancel() {}, async dispose() {} }
  adapter.composition = async () => ({ workspace: '/worker', options: {}, persona: 'Worker' })
  adapter.bind({ guard() { calls.guard++ }, async beforeStep() { calls.beforeStep++; return true }, async usageSnapshot() {}, idle() { calls.idle++ }, activity() {}, failure() {},
    admitDelivery() { calls.revoked++; return true }, async toolRun() {} })
  const member = { id: 'worker', missionId: 'm', sessionId: agent.id, workspace: '/worker' }
  const spec = { member, mission: { id: 'm' }, ownerSessionId: 'owner' }
  t.after(async () => { await adapter.dispose().catch(() => {}); await rm(root, { recursive: true, force: true }) })
  return { adapter, spec, member, calls, hooks, nativeHooks, agent, handle, guard: () => guard }
}

test('cancelled unpublished setup fences tool guards, steps, execution and provider streams before a late handle is released', async t => {
  const gate = deferred(), ready = deferred()
  const f = await fixture(t, async ({ handle }) => { ready.resolve(); await gate.promise; return handle })
  const controller = new AbortController()
  const opening = f.adapter.start(f.spec, controller.signal)
  const rejected = assert.rejects(opening, /startup expired/)
  await ready.promise
  controller.abort(new Error('startup expired'))
  const resident = f.adapter.residents.get(f.member.id)
  resident.observations.add(new Promise(() => {}))
  assert.match(f.guard()({ name: 'read' }), /stopping/)
  const decision = await f.nativeHooks.get('agent/pre-step')({ signal: new AbortController().signal, messages: [] }, () => assert.fail('cancelled step must not delegate'))
  assert.equal(decision.kind, 'reject', 'even stuck observation draining must not block an already cancelled pre-step')
  await assert.rejects(f.nativeHooks.get('tools/execute')({ name: 'read', signal: new AbortController().signal }, () => assert.fail('cancelled tool must not execute')), /startup expired/)
  const stream = f.hooks.get('llm/stream')({ sessionId: f.member.sessionId, signal: new AbortController().signal }, async function* () { assert.fail('cancelled request must not reach provider') })
  await assert.rejects(stream.next(), /startup expired/)
  assert.equal(f.calls.guard, 0)
  assert.equal(f.calls.beforeStep, 0)
  assert.equal(f.adapter.isIdle(f.member.id), false)
  resident.observations.clear()
  gate.resolve(); await rejected
  assert.equal(resident.handle, undefined, 'a late handle is never exposed as usable')
  assert.equal(f.calls.disposed, 1)
  assert.equal(f.calls.cancelled, 1)
})

test('abort fences an already opened resident against delivery, isIdle and fresh verification work', async t => {
  const f = await fixture(t)
  await f.adapter.start(f.spec)
  const resident = f.adapter.residents.get(f.member.id)
  resident.abort.abort(new Error('runtime revoked startup'))
  assert.equal(f.adapter.isIdle(f.member.id), false)
  await assert.rejects(f.adapter.deliver(f.member, { id: 'message', missionId: 'm', from: 'owner', to: f.member.id, kind: 'assignment', content: 'work', createdAt: 1 }), /runtime revoked startup/)
  await assert.rejects(f.adapter.verifyArtifact(f.member, {}, {}), /runtime revoked startup/)
  assert.equal(f.calls.sent, 0)
})

test('uncooperative pre-factory setup cannot hang disposal; timed-out disposal reports pending cleanup and keeps stop fenced', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await fixture(t)
  const gate = deferred(), ready = deferred()
  f.adapter.composition = async () => { ready.resolve(); await gate.promise; return { workspace: '/worker', options: {}, persona: 'Worker' } }
  const opening = f.adapter.start(f.spec)
  const openingRejected = assert.rejects(opening)
  await ready.promise
  let stopped = false
  const stop = f.adapter.stop(f.member.id).then(() => { stopped = true })
  const disposal = f.adapter.dispose()
  const rejected = assert.rejects(disposal, /disposal timed out.*still pending/)
  assert.equal(f.adapter.dispose(), disposal, 'concurrent dispose callers share its outcome')
  t.mock.timers.tick(5000); await rejected
  assert.equal(stopped, false, 'timeout is not an acknowledgement that the previous worker stopped')
  assert.equal(f.adapter.residents.get(f.member.id).abort.signal.aborted, true)
  assert.equal(f.calls.create, 0)
  gate.resolve(); await openingRejected; await stop
  assert.equal(f.calls.create, 0, 'late preparation cannot proceed into native creation after unload')
  assert.equal(f.adapter.residents.size, 0, 'late settlement completes the retained cleanup continuation')
})

test('late shutdown journal cleanup preserves pending messages without querying the closed runtime observer', async t => {
  const f = await fixture(t)
  await f.adapter.start(f.spec)
  const resident = f.adapter.residents.get(f.member.id)
  const pending = { id: 'assignment', role: 'user', content: [], source: { kind: 'swarm', deliveryKind: 'assignment', deliveryId: 'delivery' } }
  f.agent.inbox.nextTurn.push(pending)
  const idle = deferred()
  f.agent.whenIdle = () => idle.promise
  const disposing = f.adapter.dispose()
  f.adapter.callbacks = new Proxy({}, { get() { assert.fail('runtime observer was already closed') } })
  idle.resolve(); await disposing
  assert.equal(resident.recoveryInbox.has('assignment'), true, 'pending provenance is retained for validation on next activation')
  assert.equal(f.calls.disposed, 1)
})


test('native cancel rejection cannot escape the startup abort listener or skip handle disposal', async t => {
  const f = await fixture(t)
  const ready = deferred(), gate = deferred()
  f.adapter.ctx.sessions.flush = async () => { ready.resolve(); await gate.promise }
  f.agent.cancel = () => { throw new Error('native cancellation failed') }
  f.adapter.callbacks.failure = () => assert.fail('cancel errors must not double-charge startup failure')
  const controller = new AbortController()
  const starting = f.adapter.start(f.spec, controller.signal)
  const rejected = assert.rejects(starting, /startup expired/)
  await ready.promise
  assert.doesNotThrow(() => controller.abort(new Error('startup expired')))
  gate.resolve(); await rejected
  assert.equal(f.calls.disposed, 1, 'cleanup still releases the handle after cancel() throws')
})
