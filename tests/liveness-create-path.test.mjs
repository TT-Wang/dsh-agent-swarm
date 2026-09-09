/**
 * F1 liveness regressions on the create path.
 *
 * Pre-fix `completeAutomatic` returned false unless the mission had a `starts`
 * journal row, and only the automatic launch path wrote one. A mission created
 * through `swarm_create` could therefore never emit a stall notice and never
 * complete a stalled board, so the owner was not woken when the board parked
 * forever. `stalled()` also counted any submitted task as progress, so a
 * submission whose review was never admitted (or was retired) was reported as a
 * live board instead of a stalled one. Finally, a ceiling-parked member only
 * wakes when a follow-up task is admitted; these tests prove that admission
 * wakes it.
 *
 * A covered board with no unschedulable work still completes explicitly on the
 * owner-assembled path: the owner may be extending the mission, and
 * tests/automatic.test.mjs pins that contract. The automatic launch path, whose
 * plan is fixed, keeps completing a covered board.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
async function eventually(read, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}
class Workers {
  prepared = []; started = []; stopped = []; deliveries = []; idle = new Set()
  checks = [{ command: 'node check.cjs', exitCode: 0, output: 'ok' }]
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/value.cjs'] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, id) { this.prepared.push(id); return join(mission.workspace, id) }
  async start(spec) { this.started.push(spec.member.id) }
  async deliver(member, delivery) { this.deliveries.push({ member, delivery }) }
  async stop(id) { this.stopped.push(id) }
  isIdle(id) { return this.idle.has(id) }
  async prepareTask(member, task) { this.prepared.push(`${member.id}:${task.id}`) }
  async captureArtifact(member) { return { ...this.artifact, workspace: member.workspace } }
  async verifyArtifact() { return this.checks }
  async dispose() {}
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-liveness-'))
  const workers = new Workers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 10,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'liveness-owner' }
  // The create path: no `starts` journal row, exactly like swarm_create.
  const mission = runtime.create(owner, { title: 'Liveness', objective: 'Reach automatic completion and stall notices',
    workspace: directory, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  await runtime.start()
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Deliver',
    objective: 'Deliver the change', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['node check.cjs'], ...extra })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  const control = pattern => workers.deliveries.filter(item => item.delivery.kind === 'control' && pattern.test(item.delivery.content))
  // An automatic journal row isolates the stall classifier from the create-path
  // completion gate: it is the state a launch-path mission would already have.
  const markAutomatic = () => runtime.store.transaction(() => runtime.store.put('starts', {
    id: 'start_liveness', ownerSessionId: owner.sessionId, commandId: 'liveness', goal: 'isolate the stall classifier',
    workspace: directory, status: 'running', createdAt: Date.now(), updatedAt: Date.now(), missionId: mission.id,
  }))
  return { runtime, workers, owner, mission, stream, author, reviewer, actor, propose, current, events, control, markAutomatic }
}

test('a swarm_create mission auto-completes a stalled board once independent verification covers every criterion', async t => {
  const f = await fixture(t)
  assert.deepEqual(f.runtime.starts(f.owner), [], 'the create path writes no starts journal row')
  // A ceiling-parked task can never be dispatched again. Its obligation is
  // covered by new reviewed work instead of a repair, so the mission is left
  // with an unschedulable leftover and complete acceptance coverage.
  const blocked = f.propose({ title: 'Ceiling-bound work', maxSteps: 1 })
  await f.runtime.claim(f.actor(f.author), f.mission.id, blocked.id)
  await f.workers.callbacks.beforeStep(f.author.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.author.id), false, 'the task blocks at its own ceiling')
  assert.equal(f.current(blocked.id).status, 'blocked')
  const cover = f.propose({ title: 'Cover the criterion' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, cover.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: cover.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.propose({ kind: 'verification', reviewOf: cover.id, checks: [], title: 'Review' })
  const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
  const completed = await eventually(() => {
    const mission = f.runtime.store.get('missions', f.mission.id)
    return mission.status === 'completed' ? mission : undefined
  }, 'a swarm_create mission must reach automatic completion without owner action')
  assert.match(completed.reason, /remaining tasks could no longer be scheduled/)
  assert.equal(f.current(cover.id).status, 'accepted')
  assert.equal(f.current(blocked.id).status, 'cancelled')
  assert.match(f.current(blocked.id).output, /Cancelled at completion/)
  assert.equal(f.events('automatic/completed').length, 1)
  assert.equal(f.events('task/cancelled-at-completion').length, 1)
  const notice = await eventually(() => f.control(/Completed/)[0], 'completion wakes the owner')
  assert.equal(notice.delivery.to, 'owner')
  assert.match(notice.delivery.content, /independently accepted/)
})

test('a submitted task with no live review is reported stalled with its exact task id', async t => {
  const f = await fixture(t)
  const source = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  // No review is ever admitted: the submission is unreviewable forever.
  f.markAutomatic()
  const stall = await eventually(() => f.control(/Mission stalled/)[0], 'an unreviewable submission must be reported stalled')
  assert.match(stall.delivery.content, new RegExp(source.id))
  const event = f.events('mission/stalled').at(-1)
  assert.ok(event, 'the stall is durable')
  assert.match(event.data.reason, new RegExp(source.id))
  assert.equal(f.current(source.id).status, 'submitted', 'the unreviewable submission stays repairable')
  assert.equal(f.runtime.store.get('missions', f.mission.id).status, 'active')
})

test('a create-path stall notice names the parked work, and admitting the follow-up wakes the parked member', async t => {
  const f = await fixture(t)
  const parked = f.propose({ title: 'Ceiling-bound work', maxSteps: 1 })
  await f.runtime.claim(f.actor(f.author), f.mission.id, parked.id)
  await f.workers.callbacks.beforeStep(f.author.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.author.id), false, 'the parked member takes no step without fresh input')
  assert.equal(f.current(parked.id).status, 'blocked')
  assert.equal(f.runtime.store.get('members', f.author.id).status, 'waiting')
  // Nothing is dispatchable: the create-path mission must wake the owner.
  const stall = await eventually(() => f.control(/Mission stalled/)[0], 'a parked create-path mission is reported stalled')
  assert.match(stall.delivery.content, new RegExp(parked.id))
  // Without a new assignment the park persists: no assignment was delivered.
  assert.deepEqual(f.workers.deliveries.filter(item => item.delivery.kind === 'assignment'), [])
  // The owner admits the repair the notice asked for; the scheduler wakes the parked member.
  f.workers.idle.add(f.author.id)
  const repair = f.propose({ title: 'Repair', replaces: [parked.id], assigneeId: f.author.id })
  const running = await eventually(() => f.current(repair.id).status === 'running' ? f.current(repair.id) : undefined,
    'the follow-up task must be assigned to the parked member')
  assert.equal(running.attempt.ownerId, f.author.id)
  assert.equal(f.runtime.store.get('members', f.author.id).status, 'working')
  const assignment = f.workers.deliveries.find(item => item.delivery.kind === 'assignment' && item.delivery.taskId === repair.id)
  assert.ok(assignment, 'the wake is a durable assignment delivery')
  assert.equal(assignment.member.id, f.author.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.author.id, true), undefined, 'fresh input lets the woken member take its next step')
})
