/**
 * F1 liveness regressions on the create path.
 *
 * Pre-fix `completeAutomatic` returned false unless the mission had a `starts`
 * journal row, and only the automatic launch path wrote one. A mission created
 * through `swarm_create` could therefore never emit a stall notice,
 * so the owner was not woken when the board parked
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
import { join } from 'node:path'
import { FakeWorkers, eventually, makeRuntime } from './faults/harness.mjs'

class Workers extends FakeWorkers {
  checks = [{ command: 'node check.cjs', exitCode: 0, output: 'ok' }]
  artifact = { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/value.cjs'] }
  async prepareWorkspace(mission, id) { return join(mission.workspace, id) }
  async deliver(member, delivery) { this.deliveries.push({ member, delivery }) }
  async captureArtifact(member) { return { ...this.artifact, workspace: member.workspace } }
}
async function fixture(t) {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, { workers: new Workers(),
    config: { maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxDurationMs: 3600000, maxTasks: 100 } })
  const owner = { sessionId: 'liveness-owner' }
  // The create path: no `starts` journal row, exactly like swarm_create.
  const mission = runtime.create(owner, { title: 'Liveness', objective: 'Reach automatic completion and stall notices',
    workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  await runtime.start()
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Deliver',
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

test('a covered swarm_create mission retains blocked work until the owner explicitly withdraws it', async t => {
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
  await eventually(() => !f.current(blocked.id).resumeAfterStop, 'old worker must stop before other work', 2500)
  const cover = f.propose({ title: 'Cover the criterion' })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, cover.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: cover.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.propose({ kind: 'verification', reviewOf: cover.id, checks: [], title: 'Review' })
  const reviewing = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })
  const notice = await eventually(() => f.control(/Mission stalled/).find(item => item.delivery.content.includes(blocked.id)), 'blocked required work wakes the owner', 2500)
  assert.equal(notice.delivery.to, 'owner')
  assert.equal(f.current(cover.id).status, 'accepted')
  assert.equal(f.current(blocked.id).status, 'blocked')
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).completion.eligible, false)
  assert.throws(() => f.runtime.control(f.owner, f.mission.id, 'complete', 'Coverage alone is insufficient'), /unfinished or blocked required work/)
  assert.equal(f.events('automatic/completed').length, 0)
  assert.equal(f.events('task/cancelled-at-completion').length, 0)
  f.runtime.cancel(f.owner, f.mission.id, { taskId: blocked.id, reason: 'Owner withdraws the redundant attempt after reviewing the accepted alternative' })
  await eventually(() => f.control(/ready to complete/)[0], 'explicit withdrawal makes the owner-assembled board ready', 2500)
  assert.equal(f.runtime.snapshot(f.owner, f.mission.id).completion.eligible, true)
  assert.equal(f.runtime.store.get('missions', f.mission.id).status, 'active', 'create-path completion remains an explicit owner decision')
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'All remaining required work was accepted').status, 'completed')
  assert.match(f.current(blocked.id).output, /Cancelled by the mission owner/)
})

test('a submitted task with no live review is reported stalled with its exact task id', async t => {
  const f = await fixture(t)
  const source = f.propose()
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  // No review is ever admitted: the submission is unreviewable forever.
  f.markAutomatic()
  const stall = await eventually(() => f.control(/Mission stalled/)[0], 'an unreviewable submission must be reported stalled', 2500)
  assert.match(stall.delivery.content, new RegExp(source.id))
  const event = f.events('mission/stalled').at(-1)
  assert.ok(event, 'the stall is durable')
  assert.match(event.data.reason, new RegExp(source.id))
  assert.equal(f.current(source.id).status, 'submitted', 'the unreviewable submission stays repairable')
  assert.equal(f.runtime.store.get('missions', f.mission.id).status, 'active')
})

test('a create-path stall notice names the parked work, and admitting the follow-up wakes its member', async t => {
  const f = await fixture(t)
  const parked = f.propose({ title: 'Ceiling-bound work', maxSteps: 1 })
  await f.runtime.claim(f.actor(f.author), f.mission.id, parked.id)
  await f.workers.callbacks.beforeStep(f.author.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.author.id), false, 'the ceiling-bound member takes no further step')
  assert.equal(f.current(parked.id).status, 'blocked')
  // R20: the host no longer parks the member; the stop the fenced handle owes is
  // what refuses its steps, and the member itself reads idle between attempts.
  assert.equal(f.runtime.store.get('members', f.author.id).status, 'idle')
  // Nothing is dispatchable: the create-path mission must wake the owner.
  const stall = await eventually(() => f.control(/Mission stalled/)[0], 'a parked create-path mission is reported stalled', 2500)
  assert.match(stall.delivery.content, new RegExp(parked.id))
  // Without a new assignment the park persists: no assignment was delivered.
  assert.deepEqual(f.workers.deliveries.filter(item => item.delivery.kind === 'assignment'), [])
  // The owner admits the repair the notice asked for; the scheduler wakes the parked member.
  f.workers.idle.add(f.author.id)
  await eventually(() => !f.current(parked.id).resumeAfterStop, 'resource stop must be confirmed', 2500)
  const repair = f.runtime.controlTask(f.owner, f.mission.id, parked.id, 'amend', { maxSteps: 5 }, 'Review estimate and continue the same work')
  const running = await eventually(() => f.current(repair.id).status === 'running' ? f.current(repair.id) : undefined,
    'the follow-up task must be assigned to the parked member', 2500)
  assert.equal(running.attempt.ownerId, f.author.id)
  // R17-G7: the live status is derived from the phase and the attempt, never
  // written, so the new attempt alone makes its owner `working`.
  assert.equal(f.runtime.store.get('members', f.author.id).status, 'working', 'the member has a confirmed stopped predecessor and a new assignment')
  const assignment = f.workers.deliveries.find(item => item.delivery.kind === 'assignment' && item.delivery.taskId === repair.id)
  assert.ok(assignment, 'the wake is a durable assignment delivery')
  assert.equal(assignment.member.id, f.author.id)
  assert.equal(await f.workers.callbacks.beforeStep(f.author.id, true), undefined, 'the woken member takes its next step')
  assert.equal(f.runtime.store.get('members', f.author.id).status, 'working', 'and the derived status follows the live attempt')
})
