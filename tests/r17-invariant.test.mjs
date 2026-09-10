/**
 * R17-G9 — the pre-append invariant pilot.
 *
 * WHAT THIS FILE PROVES, against mission acceptance 7:
 *
 * 1. The companion registers through the HOST facility (`ctx.invariants.register`,
 *    `@deepseek-ai/dsh-invariants`, the same facility twelve host packages use)
 *    and its check runs on `internal/dispatch` BEFORE publication: a refused
 *    `session/event` never reaches its listeners, measured on a real registry.
 * 2. The judgement is the shared lineage rule, not a second opinion: a candidate
 *    `stall-root`/`fallthrough` decision naming a subject whose lineage still has
 *    a live path is refused, while the classifiers' own legal candidates pass.
 * 3. The emission site refuses BEFORE anything durable is written — no delivery
 *    row, no board witness, no dedup key consumed — and records the refusal as a
 *    measurement (`decisionRefusals`) instead of a silent no-op.
 * 4. The adapter acknowledges an append-refused delivery, so the durable outbox
 *    cannot retry a decision the invariant will refuse again.
 * 5. Pair tests name the guards the invariant can co-fire with: the fall-through
 *    and stall-root classifiers, the fact-keyed dedup, the per-owner wake budget,
 *    the transition-driven publication and the close-out nudge.
 * 6. A deployment that does not mount the registry is NAMED, not assumed: the
 *    companion installs through `ctx.inject(['invariants'])`, keeps working, and
 *    reports the pilot as not landed through `swarmInvariantStatus`.
 *
 * PRE-CHANGE FAILURE: on the pre-change tree this file fails at import —
 * `installSwarmInvariant`, `decisionRefusals`, `relayedSwarmMessages`,
 * `recordAppendRefusal`, `swarmInvariantStatus` and `liveLineageSubject` do not
 * exist there.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { SwarmRuntime } from '../lib/runtime.js'
import { HarnessWorkers } from '../lib/harness-workers.js'
import {
  decisionRefusals, installSwarmInvariant, recordAppendRefusal, relayedSwarmMessages,
  SWARM_INVARIANT_PACKAGE, swarmInvariantStatus,
} from '../lib/invariant.js'
import { liveLineageSubject, noticeFamily, taskSubject } from '../lib/notices.js'
import { tempDirectory } from './temp-root.mjs'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

class Workers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return true }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}

/** A minimal real runtime, so the emission refusal is judged against durable rows. */
async function scenario(t) {
  const root = await tempDirectory('swarm-r17-invariant-')
  const workspace = await realpath(await mkdtemp(join(root, 'ws-')))
  const runtime = new SwarmRuntime({ statePath: join(root, 'db.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 9 }, new Workers())
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { sessionId: 'r17-invariant-owner' }
  const mission = runtime.create(owner, { title: 'Invariant', objective: 'Prove the pilot', workspace, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const addMember = name => runtime.addMember(owner, mission.id, { name, role: 'implementation' })
  const actorFor = member => ({ sessionId: member.sessionId })
  const propose = (title, input = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title, objective: title, kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...input })
  const notices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
  const block = (task, extra = {}) => {
    const row = runtime.store.get('tasks', task.id)
    row.status = 'blocked'; row.epoch++; row.output = 'blocked for repair'
    Object.assign(row, extra)
    runtime.store.put('tasks', row)
    return runtime.store.get('tasks', row.id)
  }
  return { root, runtime, owner, mission, stream, addMember, actorFor, propose, notices, block }
}

test('R17-G9: an unmounted invariant registry is named, not assumed', async () => {
  decisionRefusals.clear()
  // A deployment without @deepseek-ai/dsh-invariants keeps working: the companion
  // simply never installs, and the status says so instead of claiming the pilot.
  const bare = new Context()
  installSwarmInvariant(bare, () => undefined)
  await sleep(10)
  assert.equal(swarmInvariantStatus.registered, false, 'no registry mounted: the pilot is reported as not landed')
  assert.equal(swarmInvariantStatus.packageName, SWARM_INVARIANT_PACKAGE)
})

test('R17-G9: the host registry refuses an illegal candidate before publication', async () => {
  decisionRefusals.clear()
  const ctx = new Context()
  const judge = message => message.source?.deliveryId === 'delivery-illegal'
    ? { missionId: 'mission-1', family: 'fallthrough', subjects: ['task-1@1'], reason: 'fallthrough names task-1@1, whose lineage still has a live path', deliveryId: 'delivery-illegal' }
    : undefined
  // The companion is installed inside a disposable fiber, so the test can prove
  // the registration is released on unload instead of leaking into the host.
  const companion = ctx.plugin({ inject: ['invariants'], apply: scoped => { installSwarmInvariant(scoped, judge) } })
  await companion
  await ctx.plugin(InvariantRegistry, {})
  for (let attempt = 0; attempt < 100 && !swarmInvariantStatus.registered; attempt++) await sleep(5)
  assert.equal(swarmInvariantStatus.registered, true, 'the companion registered through the host facility')

  // Publication probe: this listener must never see a refused event.
  const appended = []
  ctx.on('session/event', (_session, event) => { appended.push(event.data?.id ?? event.type) })
  const relay = (deliveryId) => ({ id: `swarm:${deliveryId}`, source: { kind: 'swarm', deliveryId, missionId: 'mission-1' } })

  assert.throws(
    () => ctx.emit('session/event', { tag: 'owner-session' }, { type: 'user/message', data: relay('delivery-illegal') }),
    error => {
      assert.equal(error.name, 'InvariantError', 'the host facility names the refusal')
      assert.match(error.message, new RegExp(SWARM_INVARIANT_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      assert.match(error.message, /refusing an owner-facing fallthrough decision naming task-1@1/)
      return true
    },
  )
  assert.deepEqual(appended, [], 'the refused session event never reached its listeners')
  const refusals = decisionRefusals.list()
  assert.equal(refusals.length, 1, 'the append refusal is a recorded measurement')
  assert.equal(refusals[0].stage, 'append')
  assert.equal(refusals[0].deliveryId, 'delivery-illegal')
  assert.deepEqual(refusals[0].subjects, ['task-1@1'])

  // The same relay shape with a legal delivery is appended unchanged.
  ctx.emit('session/event', { tag: 'owner-session' }, { type: 'user/message', data: relay('delivery-legal') })
  assert.deepEqual(appended, ['swarm:delivery-legal'])
  assert.equal(decisionRefusals.count(), 1, 'a legal candidate is not a refusal')

  // An inbox splice is judged the same way, message by message.
  assert.throws(
    () => ctx.emit('session/event', { tag: 'owner-session' }, { type: 'agent/inbox/spliced', data: { inserted: [relay('delivery-legal'), relay('delivery-illegal')] } }),
    /InvariantError|invariant violated/,
  )
  assert.equal(decisionRefusals.count(), 2, 'the splice candidate was judged before publication')

  // Disposal: unloading the companion releases the registration, and the same
  // relay is published again instead of being judged by a leaked check.
  await companion.dispose()
  assert.equal(swarmInvariantStatus.registered, false, 'unload releases the host registration')
  ctx.emit('session/event', { tag: 'owner-session' }, { type: 'user/message', data: relay('delivery-illegal') })
  assert.deepEqual(appended, ['swarm:delivery-legal', 'swarm:delivery-illegal'], 'after unload the relay is no longer judged')
})

test('R17-G9: the emission site refuses an illegal decision before anything durable is written', async t => {
  decisionRefusals.clear()
  const f = await scenario(t)
  const builder = await f.addMember('Builder')
  const original = f.block(f.propose('Blocked original', { assigneeId: builder.id }))
  const repair = f.propose('Repair', { replaces: [original.id], assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, repair.id)
  const subject = taskSubject(f.runtime.store.get('tasks', original.id))
  // The live-lineage predicate is the classifier's own rule: the repair covers
  // the original, so the original waits legitimately.
  assert.equal(f.runtime.notices.waitsLegitimately(f.runtime.store.get('tasks', original.id), f.runtime.store.list('tasks', f.mission.id)), true)

  const before = { deliveries: f.notices().length, witness: f.runtime.store.get('missions', f.mission.id).witness }
  f.runtime.notify(f.mission.id, 'illegal fall-through', [subject], { family: 'fallthrough', dedupKey: `fallthrough:${f.mission.id}:${subject}`, reason: 'no live path advances it' })
  assert.equal(f.notices().length, before.deliveries, 'no owner delivery was written for the illegal candidate')
  assert.deepEqual(f.runtime.store.get('missions', f.mission.id).witness, before.witness, 'the board witness was not stamped')
  const refusals = decisionRefusals.list()
  assert.equal(refusals.length, 1, 'the emission refusal is recorded')
  assert.equal(refusals[0].stage, 'emission')
  assert.equal(refusals[0].family, 'fallthrough')
  assert.deepEqual(refusals[0].subjects, [subject])
  assert.match(refusals[0].reason, /live path/)

  // Pair (the fact-keyed dedup and the wake budget): the refusal consumed nothing,
  // so closing the whole lineage lets the SAME fact through, once.
  const repairRow = f.runtime.store.get('tasks', repair.id)
  repairRow.status = 'cancelled'
  f.runtime.store.put('tasks', repairRow)
  f.runtime.notify(f.mission.id, 'legal fall-through', [subject], { family: 'fallthrough', dedupKey: `fallthrough:${f.mission.id}:${subject}`, reason: 'no live path advances it' })
  const delivered = f.notices().filter(delivery => delivery.notice?.dedupKey === `fallthrough:${f.mission.id}:${subject}`)
  assert.equal(delivered.length, 1, 'the fact is admitted once the lineage is terminal')
  assert.equal(delivered[0].content, 'legal fall-through')
  assert.equal(noticeFamily(delivered[0]), 'fallthrough')
  assert.equal(decisionRefusals.count(), 1, 'only the illegal candidate was refused')
})

test('R17-G9 pair: the classifiers\' own candidates pass and a blocked non-root is refused', async t => {
  decisionRefusals.clear()
  const f = await scenario(t)
  const builder = await f.addMember('Builder')
  const blocked = f.block(f.propose('Blocked root', { assigneeId: builder.id }))
  const dependent = f.propose('Waiting dependent', { assigneeId: builder.id })
  const dependentRow = f.runtime.store.get('tasks', dependent.id)
  dependentRow.dependencies = [blocked.id]
  f.runtime.store.put('tasks', dependentRow)

  const view = f.runtime.notices.interpretation(f.mission.id)
  assert(view.stallRoots.some(task => task.id === blocked.id), 'the blocked task is a stall root (no live path)')
  // The classifier's legal output — the root plus its pending dependent — passes.
  assert.equal(liveLineageSubject(f.runtime, {
    missionId: f.mission.id, family: 'stall-root',
    subjects: [taskSubject(blocked), taskSubject(f.runtime.store.get('tasks', dependent.id))],
  }), undefined, 'the stall-root classifier output is admitted')

  // The illegal shape: a blocked subject that is NOT a root because a live repair
  // covers it (the measured class the pilot refuses).
  const original = f.block(f.propose('Blocked original', { assigneeId: builder.id }))
  const repair = f.propose('Repair', { replaces: [original.id], assigneeId: builder.id })
  await f.runtime.claim(f.actorFor(builder), f.mission.id, repair.id)
  const refusal = liveLineageSubject(f.runtime, { missionId: f.mission.id, family: 'stall-root', subjects: [taskSubject(f.runtime.store.get('tasks', original.id))] })
  assert.match(String(refusal), /live path/, 'a blocked non-root subject is refused')

  // Pair (the close-out nudge / transition-driven publication): a family that
  // makes a different claim is never judged by this predicate.
  assert.equal(liveLineageSubject(f.runtime, { missionId: f.mission.id, family: 'closeout', subjects: [taskSubject(f.runtime.store.get('tasks', original.id))] }), undefined)
  assert.equal(liveLineageSubject(f.runtime, { missionId: f.mission.id, family: undefined, subjects: [taskSubject(f.runtime.store.get('tasks', original.id))] }), undefined, 'an unclassified notice is not judged')
})

test('R17-G9: an append refusal is recorded and acknowledged, never retried as an unknown failure', async t => {
  decisionRefusals.clear()
  const ctx = new Context()
  const ownerSession = { snapshotEvents: () => [] }
  const refusal = Object.assign(new Error(`invariant violated by "${SWARM_INVARIANT_PACKAGE}": refusing an owner-facing fallthrough decision`), { name: 'InvariantError', code: 'INVARIANT' })
  const owner = { session: ownerSession, send: () => { throw refusal } }
  ctx.provide('agents', { get: () => owner })
  ctx.provide('sessions', { flush: async () => {} })
  const workers = new HarnessWorkers(ctx, { workspacesRoot: await tempDirectory('swarm-r17-invariant-ws-'), checkTimeoutMs: 1000, maxCheckOutputBytes: 1024 })
  t.after(async () => { await workers.dispose() })
  const delivery = {
    id: 'delivery-refused', missionId: 'mission-1', from: 'runtime', to: 'owner', kind: 'question', content: 'refused content',
    createdAt: Date.now(), subjects: ['task-1@1'], notice: { class: 'decision', dedupKey: 'fallthrough:mission-1:task-1@1' },
  }
  const member = { id: 'owner', missionId: 'mission-1', name: 'owner', role: 'owner', sessionId: 'owner-session', workspace: '/w', status: 'idle', subscriptions: [] }
  // The adapter resolves (acknowledges) instead of rejecting: the durable outbox
  // must not retry a decision the invariant will refuse again.
  await workers.deliver(member, delivery)
  const recorded = decisionRefusals.list()
  assert.equal(recorded.length, 1, 'the append refusal is recorded')
  assert.equal(recorded[0].stage, 'append')
  assert.equal(recorded[0].deliveryId, 'delivery-refused')
  assert.equal(recorded[0].family, 'fallthrough')
  assert.deepEqual(recorded[0].subjects, ['task-1@1'])

  // An unrelated failure is NOT a refusal: it is left to the outbox retry path.
  assert.equal(recordAppendRefusal(new Error('Mission owner is offline'), { id: 'd2', missionId: 'mission-1', family: 'fallthrough', subjects: [] }), false)
  assert.equal(decisionRefusals.count(), 1)
})

test('R17-G9: only swarm relays are judged, and both relay shapes are seen', () => {
  const swarm = { id: 'swarm:d1', source: { kind: 'swarm', deliveryId: 'd1' } }
  const human = { id: 'human-1', source: { kind: 'user', deliveryId: undefined } }
  assert.deepEqual(relayedSwarmMessages({ type: 'user/message', data: swarm }), [swarm])
  assert.deepEqual(relayedSwarmMessages({ type: 'user/message', data: human }), [], 'a human prompt is not a swarm decision')
  assert.deepEqual(relayedSwarmMessages({ type: 'agent/inbox/spliced', data: { inserted: [human, swarm] } }), [swarm])
  assert.deepEqual(relayedSwarmMessages({ type: 'turn/start', data: { turn: 1 } }), [])
  assert.deepEqual(relayedSwarmMessages(undefined), [])
})
