/**
 * R11-15 regression: the shared temp roots are a cross-member channel, and the
 * runtime records a bounded rendezvous when two members name the same shared
 * temp path inside the window.
 *
 * Pre-fix head: no detector and no event existed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime, TEMP_RENDEZVOUS_WINDOW_MS, sharedTempPaths, tempRendezvousDecision } from '../lib/runtime.js'
import { EVENT_VOCABULARY } from '../lib/trace.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }

class Workers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop() {}
  isIdle() { return false }
  async prepareTask() {}
  async captureArtifact() { return { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] } }
  async verifyArtifact() { return [] }
  async dispose() {}
}

test('R11-15: sharedTempPaths extracts only shared-temp absolute paths from host-recorded input', () => {
  assert.deepEqual(sharedTempPaths({ tool: 'bash', arguments: { command: 'cat /tmp/swarm-probe-one' } }), ['/tmp/swarm-probe-one'])
  assert.deepEqual(sharedTempPaths({ tool: 'bash', arguments: { command: 'echo x > /var/tmp/swarm-probe-two' } }), ['/var/tmp/swarm-probe-two'])
  assert.deepEqual(sharedTempPaths({ tool: 'write', arguments: { file_path: '/tmp/swarm-probe-three' } }), ['/tmp/swarm-probe-three'])
  assert.deepEqual(sharedTempPaths({ tool: 'bash', arguments: { command: 'cat src/answer.txt' } }), [], 'a workspace path is not the shared channel')
  assert.deepEqual(sharedTempPaths({ tool: 'bash', arguments: { command: 'cat /tmpfoo/bar' } }), [], 'a prefix match is not a temp path')
  assert.deepEqual(sharedTempPaths({ tool: 'bash', arguments: { command: 'cat /etc/hosts' } }), [], 'a non-temp absolute path is not the shared channel')
  assert.deepEqual(sharedTempPaths({ tool: 'bash', arguments: { command: `cat ${join(tmpdir(), 'swarm-probe-four')}` } }), [join(tmpdir(), 'swarm-probe-four')])
  assert.equal(EVENT_VOCABULARY['isolation/temp-rendezvous'] !== undefined, true, 'the event type is registered')
})

test('R11-15: the rendezvous decision needs a different member inside the window', () => {
  const now = 1_000_000
  const mentions = [{ memberId: 'a', taskId: 't1', at: now - 1000 }]
  assert.equal(tempRendezvousDecision(mentions, 'a', now), undefined, 'the same member is not a rendezvous')
  assert.equal(tempRendezvousDecision(mentions, 'b', now)?.memberId, 'a')
  assert.equal(tempRendezvousDecision(mentions, 'b', now + TEMP_RENDEZVOUS_WINDOW_MS + 1), undefined, 'a mention outside the window does not count')
})

test('R11-15: two members naming the same temp path emit one durable event and one observe row', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-temp-rendezvous-'))
  const workers = new Workers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 3 }, workers)
  await runtime.start()
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'temp-owner' }
  const mission = runtime.create(owner, { title: 'Temp channel', objective: 'Detect a rendezvous', workspace: directory, scope: ['**'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const first = await runtime.addMember(owner, mission.id, { name: 'First', role: 'implementation' })
  const second = await runtime.addMember(owner, mission.id, { name: 'Second', role: 'implementation' })
  const propose = assigneeId => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Work', objective: 'Work', kind: 'implementation',
    scope: ['**'], acceptance: ['works'], checks: ['test'], assigneeId })
  await runtime.claim({ sessionId: first.sessionId }, mission.id, propose(first.id).id)
  await runtime.claim({ sessionId: second.sessionId }, mission.id, propose(second.id).id)
  const probe = 'cat /tmp/swarm-rendezvous-e2e'
  await workers.callbacks.toolRun(first.id, { tool: 'bash', arguments: { command: probe }, result: { exitCode: 0 }, isError: false })
  assert.equal(runtime.store.events(mission.id, 500).filter(event => event.type === 'isolation/temp-rendezvous').length, 0, 'one member alone is not a rendezvous')
  await workers.callbacks.toolRun(second.id, { tool: 'bash', arguments: { command: probe }, result: { exitCode: 0 }, isError: false })
  const events = runtime.store.events(mission.id, 500).filter(event => event.type === 'isolation/temp-rendezvous')
  assert.equal(events.length, 1, 'the rendezvous is recorded exactly once')
  assert.equal(events[0].data.path, '/tmp/swarm-rendezvous-e2e')
  assert.equal(events[0].data.firstMemberId, first.id)
  assert.equal(events[0].data.secondMemberId, second.id)
  assert.equal(events[0].data.windowMs, TEMP_RENDEZVOUS_WINDOW_MS)
  assert.equal(events[0].data.detection, 'command-mention')
  assert.ok(runtime.store.list('deliveries', mission.id).some(delivery => delivery.to === 'owner' && /shared temp path/.test(delivery.content)), 'the owner is woken once')
  // The bounded observe window surfaces the row.
  const observed = runtime.observe(owner, mission.id)
  assert.ok(observed.events.some(event => event.type === 'isolation/temp-rendezvous'), 'observe returns the rendezvous row')
  // A repeat by the same pair does not duplicate the durable row.
  await workers.callbacks.toolRun(first.id, { tool: 'bash', arguments: { command: probe }, result: { exitCode: 0 }, isError: false })
  await workers.callbacks.toolRun(second.id, { tool: 'bash', arguments: { command: probe }, result: { exitCode: 0 }, isError: false })
  assert.equal(runtime.store.events(mission.id, 500).filter(event => event.type === 'isolation/temp-rendezvous').length, 1, 'the pair and window are deduplicated')
  // A workspace-relative path never counts.
  await workers.callbacks.toolRun(first.id, { tool: 'bash', arguments: { command: 'cat src/answer.txt' }, result: { exitCode: 0 }, isError: false })
  await workers.callbacks.toolRun(second.id, { tool: 'bash', arguments: { command: 'cat src/answer.txt' }, result: { exitCode: 0 }, isError: false })
  assert.equal(runtime.store.events(mission.id, 500).filter(event => event.type === 'isolation/temp-rendezvous').length, 1)
})
