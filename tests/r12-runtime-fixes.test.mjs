import test from 'node:test'
import assert from 'node:assert/strict'
import { makeRuntime } from './faults/harness.mjs'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(t) {
  const { dir: root, runtime, workers, budget } = await makeRuntime(t, {
    config: { workerStartTimeoutMs: 40, maxEvents: 2, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxTasks: 20 },
  })
  // These tests drive dispatch explicitly so incidental scheduling cannot mask a race.
  runtime.kick = () => {}
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Recovery', objective: 'Recover safely', workspace: root, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const a = await runtime.addMember(owner, mission.id, { name: 'A', role: 'implementation' })
  const b = await runtime.addMember(owner, mission.id, { name: 'B', role: 'implementation' })
  const propose = extra => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Task', objective: 'Task', kind: 'research', scope: ['src/'], acceptance: ['works'], ...extra })
  return { runtime, workers, budget, owner, mission, a, b, propose }
}

test('a failed tick guard and one failed mission do not suppress other guards or missions', async t => {
  const f = await fixture(t), calls = []
  const second = f.runtime.create(f.owner, { title: 'Other', objective: 'Continue', workspace: f.mission.workspace, scope: ['src/'], acceptance: ['works'], budget: f.budget })
  f.runtime.pumpOutbox = () => { calls.push('outbox'); throw new Error('injected write contention') }
  f.runtime.sweepStarts = () => calls.push('starts')
  f.runtime.checkSchedulingPasses = () => calls.push('passes')
  f.runtime.sweepDecisions = () => calls.push('decisions')
  f.runtime.warnBudget = mission => { calls.push(mission.id); if (mission.id === f.mission.id) throw new Error('injected mission failure') }
  f.runtime.startTicker()
  await delay(25)
  assert.ok(calls.includes('starts') && calls.includes('passes') && calls.includes('decisions'))
  assert.ok(calls.includes(second.id), 'one mission failure must not skip the next mission')
})

test('failure after an awaited startup preserves newly committed member fields and park intent', async t => {
  const f = await fixture(t)
  let reject
  f.workers.start = () => new Promise((_resolve, fail) => { reject = fail })
  const pending = f.runtime.startWorker(f.mission, f.a)
  await delay(0)
  f.runtime.store.transaction(() => {
    const member = f.runtime.store.get('members', f.a.id)
    member.phase = 'parked'; member.role = 'updated while starting'; member.activity = { sentinel: 'fresh' }
    f.runtime.store.put('members', member)
  })
  reject(new Error('bootstrap failed'))
  await assert.rejects(pending, /bootstrap failed/)
  const current = f.runtime.store.get('members', f.a.id)
  assert.equal(current.phase, 'parked'); assert.equal(current.role, 'updated while starting')
  assert.equal(current.activity.sentinel, 'fresh')
})

test('recovery returns with a stuck startup, starts siblings, and records one shared timeout', async t => {
  const f = await fixture(t), started = [], signals = []
  f.workers.start = async (spec, signal) => {
    started.push(spec.member.id)
    if (spec.member.id === f.a.id) { signals.push(signal); await new Promise(() => {}) }
  }
  await f.runtime.start()
  await delay(5)
  assert.ok(started.includes(f.b.id), 'healthy sibling recovers independently')
  const same = f.runtime.startWorker(f.mission, f.a)
  const duplicate = f.runtime.startWorker(f.mission, f.a)
  assert.equal(same, duplicate)
  await assert.rejects(same, /timed out/)
  assert.equal(signals.length, 1); assert.equal(signals[0].aborted, true)
  const failures = f.runtime.store.events(f.mission.id, 100).filter(e => e.type === 'member/resume-failed' && e.data.memberId === f.a.id)
  assert.equal(failures.length, 1, 'multiple startup waiters spend one failure credit')
  await delay(25)
  await assert.rejects(f.runtime.startWorker(f.mission, f.a), /timed out/)
  assert.equal(started.filter(id => id === f.a.id).length, 1, 'a native opening still cleaning up cannot be restarted')
  assert.equal(f.runtime.store.events(f.mission.id, 100).filter(e => e.type === 'member/resume-failed').length, 1)
})

test('successful startup bookkeeping failures do not cancel the handle or spend recovery credit', async t => {
  const f = await fixture(t)
  let signal
  f.workers.start = async (_spec, value) => { signal = value }
  f.runtime.clearProviderOutage = () => { throw new Error('injected bookkeeping failure') }
  await assert.rejects(f.runtime.startWorker(f.mission, f.a), /bookkeeping/)
  assert.equal(signal.aborted, false)
  assert.equal(f.runtime.store.events(f.mission.id, 100).filter(e => e.type === 'member/resume-failed').length, 0)
})

test('initial member admission obeys cancellation and timeout bounds', async t => {
  const f = await fixture(t)
  let signal
  f.workers.start = async (_spec, value) => { signal = value; await new Promise(() => {}) }
  await assert.rejects(f.runtime.addMember(f.owner, f.mission.id, { name: 'Stuck', role: 'research' }), /timed out/)
  assert.equal(signal.aborted, true)
  const controller = new AbortController()
  const pending = f.runtime.addMember({ ...f.owner, signal: controller.signal }, f.mission.id, { name: 'Cancelled', role: 'research' })
  await delay(0)
  controller.abort(new Error('owner cancelled admission'))
  await assert.rejects(pending, /owner cancelled/)
})

test('pending quiescence blocks manual claim and native startup without spending recovery credit', async t => {
  const f = await fixture(t), old = f.propose({ assigneeId: f.a.id }), next = f.propose({ assigneeId: f.a.id })
  f.runtime.store.transaction(() => {
    const task = f.runtime.store.get('tasks', old.id)
    task.status = 'blocked'; task.resumeAfterStop = { epoch: task.epoch, memberId: f.a.id, reason: 'lease-expired', at: Date.now() }
    f.runtime.store.put('tasks', task)
  })
  await assert.rejects(f.runtime.claim({ sessionId: f.a.sessionId }, f.mission.id, next.id), /previous attempt to stop/)
  await assert.rejects(f.runtime.startWorker(f.mission, f.a), /previous attempt to stop/)
  assert.equal(f.runtime.store.events(f.mission.id, 100).filter(e => e.type === 'member/resume-failed').length, 0)
})

test('retired members and late start failures cannot resurrect membership', async t => {
  const f = await fixture(t)
  f.runtime.store.transaction(() => { const member = f.runtime.store.get('members', f.a.id); member.phase = 'stopped'; f.runtime.store.put('members', member) })
  f.runtime.onStartFailure(f.mission, f.a, new Error('late bootstrap failure'))
  assert.equal(f.runtime.store.get('members', f.a.id).phase, 'stopped')
  assert.equal(f.runtime.updateBudget(f.owner, f.mission.id, { ...f.budget, maxWorkers: 1 }).maxWorkers, 1)
})

test('submission and missing-review identity survive event-window truncation and cache loss', async t => {
  const f = await fixture(t), task = f.propose({})
  f.runtime.store.transaction(() => f.runtime.store.event(f.mission.id, 'task/submitted', f.a.id, { taskId: task.id }))
  const submitted = f.runtime.latestSubmission(f.mission.id, task.id)
  assert.ok(submitted)
  assert.equal(f.runtime.reportMissingReview(f.mission, task, submitted.seq), true)
  f.runtime.store.transaction(() => { for (let i = 0; i < 5; i++) f.runtime.store.event(f.mission.id, 'noise', 'runtime', {}) })
  assert.equal(f.runtime.latestSubmission(f.mission.id, task.id).seq, submitted.seq)
  assert.equal(f.runtime.reportMissingReview(f.mission, task, submitted.seq), false)
})

test('owner can settle receipts after stop without queuing work or reactivating the mission', async t => {
  const f = await fixture(t)
  f.runtime.message({ sessionId: f.a.sessionId }, f.mission.id, { to: 'owner', kind: 'question', content: 'Proceed?' })
  const question = f.runtime.store.list('deliveries', f.mission.id).find(row => row.kind === 'question')
  f.runtime.control(f.owner, f.mission.id, 'stop', 'User stopped')
  const before = f.runtime.store.list('deliveries', f.mission.id).length
  assert.deepEqual(f.runtime.message(f.owner, f.mission.id, { to: f.a.id, kind: 'finding', content: 'No longer needed', replyTo: question.id, dismiss: true }), { queued: false, dismissed: question.id })
  assert.equal(f.runtime.store.list('deliveries', f.mission.id).length, before)
  assert.equal(f.runtime.store.get('missions', f.mission.id).status, 'stopped')
  assert.equal(f.runtime.store.get('deliveries', question.id).state, 'dismissed')
})

test('escalation without attemptId still verifies the task owner', async t => {
  const f = await fixture(t), task = f.propose({ assigneeId: f.b.id })
  assert.throws(() => f.runtime.escalate({ sessionId: f.a.sessionId }, f.mission.id, { body: 'Not my task', taskId: task.id }), /not owned/)
})

test('lease starts within mission deadline and unrelated tool names are not substring-denied', async t => {
  const f = await fixture(t), task = f.propose({ assigneeId: f.a.id })
  f.runtime.store.transaction(() => { const mission = f.runtime.store.get('missions', f.mission.id); mission.deadline = Date.now() + 10000; f.runtime.store.put('missions', mission) })
  const claimed = await f.runtime.claim({ sessionId: f.a.sessionId }, f.mission.id, task.id)
  assert.ok(claimed.attempt.leaseUntil <= f.runtime.store.get('missions', f.mission.id).deadline)
  assert.equal(f.workers.callbacks.guard(f.a.id, 'render_plugin_documentation'), undefined)
  assert.match(f.workers.callbacks.guard(f.a.id, 'cordis_run'), /alternate delegation/)
})

test('concurrent dispose callers observe the same completed teardown', async t => {
  const f = await fixture(t)
  let release
  f.workers.dispose = () => new Promise(resolve => { release = resolve })
  const first = f.runtime.dispose(), second = f.runtime.dispose()
  assert.equal(first, second)
  assert.equal(f.runtime.closed, false)
  release(); await Promise.all([first, second]); assert.equal(f.runtime.closed, true)
})
