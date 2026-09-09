/**
 * S1 (P0): the scheduler must never write a pre-await task snapshot back.
 *
 * `schedule()` iterates tasks and awaits `captureArtifact`/`stop` for an expired
 * lease. Cancel, challenge, handoff, publish, beforeStep and recordToolRun
 * commit directly during those awaits. Before the fix, every later iteration
 * still held the snapshot taken before the await, so it wrote a stale full row
 * back: an owner's `swarm_cancel` was silently undone (task resurrected at the
 * old epoch with a cancelled attempt and a stopped owner) and a latched
 * git-write denial disappeared. This test gates the capture, performs both
 * concurrent transitions, and asserts neither is reverted.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 50, maxExperiments: 0 }

async function eventually(read, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

class SnapshotWorkers {
  callbacks
  deliveries = []
  stopped = []
  captureStarted = false
  captureGate
  /** Flipped off before the gate releases so the member loop cannot re-dispatch. */
  idleNow = true
  /** Live adapter operation reported for lease renewal, when set. */
  current
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, delivery }) }
  async stop(id) { this.stopped.push(id) }
  isIdle() { return this.idleNow }
  async captureArtifact(member, task) {
    this.captureStarted = true
    if (this.captureGate) await this.captureGate
    return { ...this.artifact, workspace: member.workspace ?? '/isolated' }
  }
  async verifyArtifact() { return [{ command: 'test', exitCode: 0, output: 'ok' }] }
  async prepareTask() {}
  currentActivity() { return this.current }
  async dispose() {}
}

test('S1: a cancel committed during a lease-expiry await is not reverted by a stale snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-s1-snapshot-'))
  const workers = new SnapshotWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60_000, tickMs: 10,
    maxMessageChars: 16_000, maxEvents: 500, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.start()
  const owner = { sessionId: 's1-owner' }
  const mission = runtime.create(owner, { title: 'S1', objective: 'No stale snapshot write', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation', maxOutputTokens: 5000 })
  const other = await runtime.addMember(owner, mission.id, { name: 'Other', role: 'implementation', maxOutputTokens: 5000 })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = title => runtime.propose(owner, mission.id, { workstreamId: stream.id, title, objective: title,
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: undefined })
  const taskOf = id => runtime.store.get('tasks', id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)

  // T1 owns an expired lease; T2 is inside the renewal window. Both are running.
  const first = propose('Expired lease')
  const firstClaim = await runtime.claim(actor(author), mission.id, first.id)
  const second = propose('Renewal window')
  const secondClaim = await runtime.claim(actor(other), mission.id, second.id)
  runtime.store.transaction(() => {
    const t1 = runtime.store.get('tasks', first.id)
    t1.attempt.leaseUntil = Date.now() - 1
    runtime.store.put('tasks', t1)
    const t2 = runtime.store.get('tasks', second.id)
    t2.attempt.leaseUntil = Date.now() + 1000
    runtime.store.put('tasks', t2)
  })
  assert.equal(taskOf(first.id).attempt.id, firstClaim.attempt.id)
  assert.equal(taskOf(second.id).attempt.id, secondClaim.attempt.id)

  // Gate the capture the scheduler awaits for T1.
  let release
  workers.captureGate = new Promise(resolve => { release = resolve })
  await eventually(() => workers.captureStarted, 'the scheduler must reach the gated checkpoint capture')
  const secondEpoch = taskOf(second.id).epoch
  // Injection 1: a host tool run during the await latches the git-write denial on T1.
  const runId = await workers.callbacks.toolRun(author.id, { tool: 'bash', arguments: { command: 'git commit -m "work"' }, result: { exitCode: 128, output: 'index.lock: Operation not permitted' }, isError: true })
  assert.ok(runId, 'the tool run is recorded')
  assert.match(taskOf(first.id).gitWriteDenied.command, /git commit/, 'the denial is latched on the running row')
  // Injection 2: the owner withdraws T2 during the same await.
  runtime.cancel(owner, mission.id, { taskId: second.id, reason: 'withdrawn while the scheduler awaited' })
  assert.equal(taskOf(second.id).status, 'cancelled')
  const cancelledEpoch = taskOf(second.id).epoch
  assert.equal(cancelledEpoch, secondEpoch + 1)

  // Stop the member loop from re-dispatching, then let the scheduler continue.
  workers.idleNow = false
  release()
  await eventually(() => taskOf(first.id).status !== 'running', 'the expired task completes its lease transition')
  assert.equal(taskOf(first.id).status, 'pending', 'the expired attempt re-pends within its recovery limit')

  const after = taskOf(second.id)
  assert.equal(after.status, 'cancelled', 'the owner withdrawal must survive the scheduler pass')
  assert.equal(after.epoch, cancelledEpoch, 'the cancelled epoch must not be rolled back')
  assert.equal(after.attempt, undefined, 'the cancelled attempt must not be resurrected')
  assert.equal(after.assigneeId, other.id, 'the cancelled row is otherwise unchanged')
  assert.equal(events('task/lease-expired').filter(event => event.data.taskId === second.id).length, 0, 'a cancelled task never expires its lease')
  assert.match(taskOf(first.id).gitWriteDenied?.command ?? '', /git commit/, 'the latched git-write denial must survive the interleaving')
  assert.ok(events('task/git-write-denied').some(event => event.data.taskId === first.id), 'the denial is durable')
  assert.equal(taskOf(first.id).checkpoint?.commit, 'c'.repeat(40), 'the checkpoint was captured and committed')
})

test('S1r: a live operation whose lease already expired is renewed, not expired, in the same pass', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-s1r-renewal-'))
  const workers = new SnapshotWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 60_000, tickMs: 10,
    maxMessageChars: 16_000, maxEvents: 500, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  await runtime.start()
  const owner = { sessionId: 's1r-owner' }
  const mission = runtime.create(owner, { title: 'S1r', objective: 'Renew before expiring', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation', maxOutputTokens: 5000 })
  const actor = { sessionId: member.sessionId }
  const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Long verification', objective: 'Long host verification',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: member.id, maxRecoveryAttempts: 3 })
  const claimed = await runtime.claim(actor, mission.id, task.id)
  // A live operation (verification activity) with an already-expired lease: the
  // renewal must win, and the caller must not expire the row in the same pass.
  const activity = { id: 'live-verification', kind: 'verification', startedAt: Date.now(), updatedAt: Date.now() }
  workers.current = activity
  workers.callbacks.activity(member.id, activity)
  runtime.store.transaction(() => {
    const row = runtime.store.get('tasks', task.id)
    row.attempt.leaseUntil = Date.now() - 5
    runtime.store.put('tasks', row)
  })
  await eventually(() => (runtime.store.get('tasks', task.id).attempt?.leaseUntil ?? 0) > Date.now() + 30_000,
    'the live operation must renew the already-expired lease')
  await new Promise(resolve => setTimeout(resolve, 120))
  const current = runtime.store.get('tasks', task.id)
  assert.equal(current.status, 'running', 'the live attempt stays running')
  assert.equal(current.attempt.id, claimed.attempt.id, 'the attempt id is unchanged')
  assert.equal(current.epoch, 1, 'no re-pend transition occurred')
  assert.equal(current.recoveryCount ?? 0, 0, 'no recovery credit was spent')
  assert.equal(runtime.store.events(mission.id, 500).filter(event => event.type === 'task/lease-expired' && event.data.taskId === task.id).length, 0,
    'no task/lease-expired is emitted for a live operation')
  assert.equal(runtime.store.events(mission.id, 500).filter(event => event.type === 'task/checkpointed' && event.data.taskId === task.id).length, 0,
    'a live operation is never checkpointed away')
})
