/** Shutdown is a recoverable lifecycle transition, even inside an awaited dispatch. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { SwarmStore } from '../lib/store.js'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
async function eventually(read, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    if (read()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

class ShutdownWorkers {
  gate
  disposed = false
  interrupted = []
  starts = 0
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return `${mission.workspace}/${memberId}` }
  async start() { this.starts++; await this.wait('start') }
  async prepareTask() { await this.wait('prepare') }
  async wait(stage) {
    if (this.gate?.stage === stage) {
      this.gate.entered.resolve()
      await this.gate.release.promise
    }
    if (this.disposed) {
      this.interrupted.push(stage)
      throw new Error('Worker adapter is disposed')
    }
  }
  async deliver() {}
  async stop() {}
  isIdle() { return true }
  async dispose() {
    this.disposed = true
    this.gate?.release.resolve()
  }
}

for (const scenario of [
  { name: 'interrupted handoff', reason: 'handoff', epoch: 4, markerEpoch: 4, recoveryCount: 0, resumes: true },
  { name: 'interrupted lease recovery', reason: 'lease-expired', epoch: 4, markerEpoch: 4, recoveryCount: 1, resumes: true },
  { name: 'handoff superseded by a challenge', reason: 'handoff', epoch: 5, markerEpoch: 4, recoveryCount: 0, resumes: false },
  { name: 'exhausted lease recovery', reason: 'lease-expired', epoch: 4, markerEpoch: 4, recoveryCount: 3, resumes: false },
]) {
  test(`restart handles ${scenario.name} using its durable stop marker`, { timeout: 10000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'swarm-stop-recovery-'))
    const config = { statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
      maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 3 }
    const runtime = new SwarmRuntime(config, new ShutdownWorkers())
    let recovered
    t.after(async () => {
      await runtime.dispose()
      await recovered?.dispose()
      await rm(directory, { recursive: true, force: true })
    })
    const owner = { sessionId: 'crash-owner' }
    const mission = runtime.create(owner, { title: 'Interrupted stop', objective: 'Recover task ownership',
      workspace: directory, scope: ['src/'], acceptance: ['done'],
      budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 10 } })
    const previousOwner = await runtime.addMember(owner, mission.id, { name: 'previous', role: 'implementation' })
    const nextOwner = await runtime.addMember(owner, mission.id, { name: 'next', role: 'implementation' })
    const stream = runtime.workstream(owner, mission.id, { title: 'Work', objective: 'Continue checkpoint' })
    const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Interrupted task', objective: 'Continue checkpoint',
      kind: 'implementation', assigneeId: previousOwner.id, scope: ['src/'], acceptance: ['done'], checks: ['test'] })
    await runtime.dispose()

    // Reconstruct the committed state between ownership revocation and the
    // old worker's quiescence acknowledgement, without a live owner or handle.
    const persisted = new SwarmStore(config.statePath)
    try {
      const interrupted = persisted.get('tasks', task.id)
      interrupted.status = 'blocked'
      interrupted.epoch = scenario.epoch
      interrupted.assigneeId = nextOwner.id
      interrupted.handoff = 'Preserve the prior worktree checkpoint and finish the task.'
      interrupted.recoveryCount = scenario.recoveryCount
      interrupted.resumeAfterStop = { epoch: scenario.markerEpoch, reason: scenario.reason }
      delete interrupted.attempt
      persisted.transaction(() => persisted.put('tasks', interrupted))
    } finally { persisted.close() }

    const recoveryWorkers = new ShutdownWorkers()
    recovered = new SwarmRuntime(config, recoveryWorkers)
    await recovered.start()
    if (scenario.resumes) {
      await eventually(() => recovered.store.get('tasks', task.id)?.status === 'running', 'matching stop marker did not release the interrupted dispatch')
      const running = recovered.store.get('tasks', task.id)
      assert.equal(running.attempt.ownerId, nextOwner.id, 'the durable handoff destination owns the fresh attempt')
      assert.equal(running.epoch, scenario.epoch + 1)
      assert.equal(running.resumeAfterStop, undefined)
      assert.match(running.handoff, /prior worktree checkpoint/)
    } else {
      await eventually(() => recoveryWorkers.starts >= 4, 'recovery scheduler did not inspect the members')
      assert.equal(recovered.store.get('tasks', task.id).status, 'blocked', 'a newer revocation or exhausted retry budget must retain its block')
      assert.equal(recovered.store.get('tasks', task.id).attempt, undefined)
    }
  })
}

for (const stage of ['start', 'prepare']) {
  test(`shutdown during scheduler ${stage} preserves durable membership and dispatch for recovery`, { timeout: 10000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'swarm-shutdown-'))
    const config = { statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
      maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 100 }
    const workers = new ShutdownWorkers()
    const runtime = new SwarmRuntime(config, workers)
    let recovered
    t.after(async () => {
      await runtime.dispose()
      await recovered?.dispose()
      await rm(directory, { recursive: true, force: true })
    })
    const owner = { sessionId: 'shutdown-owner' }
    const mission = runtime.create(owner, { title: 'Resume after shutdown', objective: 'Preserve unfinished work',
      workspace: directory, scope: ['src/'], acceptance: ['done'],
      budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 10 } })
    const member = await runtime.addMember(owner, mission.id, { name: 'author', role: 'implementation' })
    const stream = runtime.workstream(owner, mission.id, { title: 'Work', objective: 'Recover this dispatch' })
    workers.gate = { stage, entered: deferred(), release: deferred() }
    const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Interrupted dispatch',
      objective: 'Continue after restart', kind: 'implementation', assigneeId: member.id,
      scope: ['src/'], acceptance: ['done'], checks: ['test'] })
    await workers.gate.entered.promise
    await runtime.dispose()
    assert.deepEqual(workers.interrupted, [stage], 'the worker rejects the operation only after disposal starts')

    const persisted = new SwarmStore(config.statePath)
    try {
      assert.equal(persisted.get('members', member.id).status, 'idle', 'shutdown must not durably stop a resumable member')
      assert.equal(persisted.get('tasks', task.id).status, 'pending', 'shutdown must not turn unfinished preparation into a task failure')
      assert.equal(persisted.get('tasks', task.id).attempt, undefined)
      const failures = persisted.events(mission.id, 100).filter(event => ['member/resume-failed', 'member/failed', 'task/blocked'].includes(event.type))
      assert.deepEqual(failures, [], 'shutdown is not a durable worker or workspace failure')
    } finally { persisted.close() }

    recovered = new SwarmRuntime(config, new ShutdownWorkers())
    await recovered.start()
    await eventually(() => recovered.store.get('tasks', task.id)?.status === 'running', 'the unchanged pending task did not resume without its owner session')
    assert.equal(recovered.store.get('tasks', task.id).attempt.ownerId, member.id)
    assert.notEqual(recovered.store.get('members', member.id).status, 'stopped')
  })
}

test('pausing an in-flight worker start preserves membership for resume', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'swarm-pause-dispatch-'))
  const workers = new ShutdownWorkers()
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'pause-owner' }
  const mission = runtime.create(owner, { title: 'Pause dispatch', objective: 'Resume the same worker', workspace: directory,
    scope: ['src/'], acceptance: ['done'], budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2,
      maxDurationMs: 3600000, maxTasks: 10, maxExperiments: 1 } })
  const member = await runtime.addMember(owner, mission.id, { name: 'author', role: 'implementation' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Work', objective: 'Resume dispatch' })
  workers.gate = { stage: 'start', entered: deferred(), release: deferred() }
  const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Paused task', objective: 'Continue after pause',
    kind: 'implementation', assigneeId: member.id, scope: ['src/'], acceptance: ['done'], checks: ['test'] })
  await workers.gate.entered.promise
  workers.stop = async () => { workers.disposed = true; workers.gate.release.resolve() }
  runtime.control(owner, mission.id, 'pause', 'Pause during start')
  await eventually(() => workers.interrupted.length === 1, 'pause did not interrupt the in-flight start')
  assert.equal(runtime.store.get('members', member.id).status, 'idle')
  assert.equal(runtime.store.get('tasks', task.id).status, 'pending')
  assert.equal(runtime.store.events(mission.id, 100).some(event => event.type === 'member/resume-failed'), false)
  workers.disposed = false
  workers.gate = undefined
  runtime.control(owner, mission.id, 'resume', 'Continue the same mission')
  await eventually(() => runtime.store.get('tasks', task.id).status === 'running', 'worker did not resume after pause')
})

/** A committed budget pause with a preserved running attempt, ready to resume or restart. */
async function budgetFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'swarm-budget-'))
  const config = { statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 3 }
  const runtime = new SwarmRuntime(config, new ShutdownWorkers())
  const owner = { sessionId: 'budget-owner' }
  const mission = runtime.create(owner, { title: 'Pause', objective: 'Resume the same attempt', workspace: directory, scope: ['src/'], acceptance: ['done'],
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2, maxDurationMs: 3600000, maxTasks: 10, maxExperiments: 1 } })
  const member = await runtime.addMember(owner, mission.id, { name: 'author', role: 'implementation' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Work', objective: 'Resume' })
  const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Paused task', objective: 'Resume', kind: 'implementation',
    assigneeId: member.id, scope: ['src/'], acceptance: ['done'], checks: ['test'] })
  const claimed = await runtime.claim({ sessionId: member.sessionId }, mission.id, task.id)
  const pause = () => {
    const missionRecord = runtime.store.get('missions', mission.id)
    missionRecord.status = 'blocked'; missionRecord.reason = 'Aggregate mission budget exhausted: maxTokens'; missionRecord.budgetPause = { id: 'pause-1', quiesced: true }
    runtime.store.put('missions', missionRecord)
  }
  const preserve = attemptId => {
    const taskRecord = runtime.store.get('tasks', task.id)
    taskRecord.budgetResume = { pauseId: 'pause-1', attemptId, epoch: taskRecord.epoch }
    runtime.store.put('tasks', taskRecord)
  }
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { directory, config, runtime, owner, mission, member, task, claimed, pause, preserve }
}

test('budget resume keeps the preserved attempt and spends no recovery credit', { timeout: 10000 }, async t => {
  const f = await budgetFixture(t)
  f.pause(); f.preserve(f.claimed.attempt.id)
  f.runtime.control(f.owner, f.mission.id, 'resume', 'Budget raised')
  await eventually(() => f.runtime.store.get('missions', f.mission.id).budgetPause === undefined, 'the pause must clear on resume')
  const resumed = f.runtime.store.get('tasks', f.task.id)
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.attempt.id, f.claimed.attempt.id, 'the preserved attempt survives the pause')
  assert.equal(resumed.recoveryCount, undefined, 'a budget pause spends no recovery credit')
  assert.equal(f.runtime.store.get('missions', f.mission.id).status, 'active')
})

test('a stale budget resume marker re-pends without charging a recovery attempt', { timeout: 10000 }, async t => {
  const f = await budgetFixture(t)
  f.pause(); f.preserve('stale-attempt')
  f.runtime.control(f.owner, f.mission.id, 'resume', 'Budget raised')
  await eventually(() => f.runtime.store.events(f.mission.id, 100).some(event => event.type === 'task/budget-resume-skipped'), 'the stale marker must be reported')
  const current = f.runtime.store.get('tasks', f.task.id)
  assert.equal(current.recoveryCount, undefined, 'a stale marker is not a recovery failure')
  assert.notEqual(current.attempt?.id, 'stale-attempt')
  assert.notEqual(current.status, 'blocked')
})

test('a host restart during a budget pause spends no recovery credit', { timeout: 10000 }, async t => {
  const f = await budgetFixture(t)
  f.pause(); f.preserve(f.claimed.attempt.id)
  await f.runtime.dispose()
  const recovered = new SwarmRuntime(f.config, new ShutdownWorkers())
  try {
    await recovered.start()
    const restored = recovered.store.get('tasks', f.task.id)
    assert.equal(restored.recoveryCount, undefined, 'a pause-induced stop spends no recovery credit')
    assert.equal(restored.status, 'pending')
    assert.equal(restored.attempt, undefined)
  } finally { await recovered.dispose() }
})
