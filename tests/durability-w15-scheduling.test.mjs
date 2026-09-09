/**
 * W15 regressions: a durable stop transition (handoff, worker close-out or lease
 * expiry) holds a live task at `blocked` + `resumeAfterStop` only until the old
 * worker handle acknowledges the stop. Completion, stall detection and
 * unschedulable reporting must treat that task as live work, not as a dead
 * leftover. Pre-fix `unschedulable()` seeded every blocked task as dead and
 * `stalled()` ignored the stop marker, so `control complete` cancelled the live
 * task and the close-out then dropped it silently.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function eventually(read, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

class QuietWorkers {
  prepared = []; stopped = []; stopGate
  checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop(memberId) { if (this.stopGate) await this.stopGate; this.stopped.push(memberId) }
  isIdle() { return false }
  async prepareTask(member, task) { this.prepared.push(structuredClone({ member: member.id, task })) }
  async captureArtifact() { return this.artifact }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-w15-'))
  const workers = new QuietWorkers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 10,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100, ...config }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'w15-owner' }
  const mission = runtime.create(owner, { title: 'W15', objective: 'Never cancel live quiescence', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  // The real tick loop drives automatic completion while the stop is parked.
  await runtime.start()
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  async function accept(task) {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    await runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: `Review ${task.title}`, objective: 'Independent review',
      kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: task.id })
    const claimedReview = await runtime.claim(actor(reviewer), mission.id, review.id)
    await runtime.verify(actor(reviewer), mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
    return current(task)
  }
  // An automatic request makes the runtime consider automatic completion on
  // every scheduling pass, which is the path that cancelled live work pre-fix.
  const markAutomatic = () => runtime.store.transaction(() => runtime.store.put('starts', {
    id: 'start_w15', ownerSessionId: owner.sessionId, commandId: 'w15', goal: 'automatic completion', workspace: directory,
    status: 'running', createdAt: Date.now(), updatedAt: Date.now(), missionId: mission.id,
  }))
  return { runtime, workers, owner, mission, stream, author, reviewer, actor, propose, current, events, accept, markAutomatic }
}

test('W15: a live handoff is neither reported stalled nor cancelled by completion', async t => {
  const f = await fixture(t)
  const first = f.propose({ title: 'Covered work' })
  await f.accept(first)
  assert.equal(f.current(first.id).status, 'accepted')
  const live = f.propose({ title: 'Handed off work' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, live.id)
  const gate = deferred()
  f.workers.stopGate = gate.promise
  f.runtime.handoff(f.actor(f.author), f.mission.id, { taskId: live.id, attemptId: claimed.attempt.id, to: f.reviewer.id, summary: 'Reassign' })
  const parked = f.current(live.id)
  assert.equal(parked.status, 'blocked')
  assert.equal(parked.resumeAfterStop.reason, 'handoff')
  assert.equal(parked.epoch, parked.resumeAfterStop.epoch)
  // The injected automatic request makes every tick attempt completion; pre-fix
  // the parked task counted as dead and the mission completed here.
  f.markAutomatic()
  await new Promise(resolve => setTimeout(resolve, 60))
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  assert.equal(snapshot.mission.status, 'active', 'the mission is not completed while live work is parked')
  assert.equal(f.current(live.id).status, 'blocked', 'the live task is not cancelled as a leftover')
  assert.equal(f.current(live.id).resumeAfterStop.reason, 'handoff')
  assert.deepEqual(f.events('task/cancelled-at-completion'), [], 'no live task is cancelled at completion')
  assert.deepEqual(f.events('mission/stalled'), [], 'a live stop transition is not a stalled board')
  assert.equal(snapshot.completion.eligible, false)
  assert.match(snapshot.completion.reason, /unfinished or blocked required work/)
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id).unschedulable, [], 'live quiescence is not unschedulable')
  assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'too early'), /unfinished or blocked required work/)
  // The transition completes normally: the task re-pends and the destination owns it.
  gate.resolve()
  const ready = await eventually(() => f.current(live.id).status === 'pending' ? f.current(live.id) : undefined, 'the handoff completes')
  assert.equal(ready.resumeAfterStop, undefined)
  const next = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, live.id)
  assert.equal(next.attempt.ownerId, f.reviewer.id)
  assert.equal(f.current(live.id).status, 'running')
})

test('W15: a lease-expiry marker is live work, while a genuinely dead blocked task is still reported', async t => {
  const f = await fixture(t)
  const task = f.propose({ title: 'Lease recovery' })
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  // Model the durable window between the lease-expiry transition and the stop
  // acknowledgement exactly as the scheduler commits it.
  const record = f.current(task.id)
  record.status = 'blocked'; record.epoch++; record.recoveryCount = 1
  delete record.attempt
  record.resumeAfterStop = { epoch: record.epoch, reason: 'lease-expired' }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', record))
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id).unschedulable, [], 'a lease-expiry transition is not dead work')
  // A genuinely dead blocked task (no matching stop marker) is still reported;
  // the fix must not weaken that contract.
  const dead = f.propose({ title: 'Dead work' })
  const deadRecord = f.current(dead.id)
  deadRecord.status = 'blocked'; deadRecord.epoch++; delete deadRecord.attempt
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', deadRecord))
  assert.deepEqual(f.runtime.observe(f.owner, f.mission.id).unschedulable, [dead.id])
})
