/** Lean allocation exercises the durable runtime; only worker execution is controlled. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { assignmentAllows, canBorrowTask } from '../lib/assignment.js'
import { pendingReadiness } from '../lib/arena.js'

class Workers {
  prepared = []
  stopped = []
  busy = new Set()
  onPrepare = async () => {}
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, id) { return join(mission.workspace, id) }
  async start() {}
  async stop(id) { this.stopped.push(id) }
  async dispose() {}
  isIdle(id) { return !this.busy.has(id) }
  async prepareTask(member, task) { this.prepared.push({ memberId: member.id, taskId: task.id }); await this.onPrepare(member, task) }
  async deliver() {}
  async captureArtifact(member) { return { commit: 'verified', baseCommit: 'base', workspace: member.workspace, changedPaths: ['src/value.js'] } }
  async verifyArtifact() { return [{ command: 'node check.cjs', exitCode: 0, output: 'ok' }] }
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-lean-assignment-'))
  const config = { statePath: join(root, 'state.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 20000, maxEvents: 100, maxTasksPerMember: 3 }
  const workers = new Workers(), runtime = new SwarmRuntime(config, workers)
  runtime.kick = () => {}
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Parallel work', objective: 'Deliver independent work', workspace: root, scope: ['src/'], acceptance: ['works'], budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 30, maxExperiments: 3 } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Delivery', objective: 'Complete the work' })
  // Spare comes first in the real dispatch order: preference must not depend on member order.
  const spare = await runtime.addMember(owner, mission.id, { name: 'Spare', role: 'general' })
  const preferred = await runtime.addMember(owner, mission.id, { name: 'Preferred', role: 'general' })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = extra => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Change', objective: 'Implement an independent change', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['node check.cjs'], assigneeId: preferred.id, assignmentMode: 'preferred', ...extra })
  const runtimes = [runtime]
  t.after(async () => { for (const rt of runtimes) await rt.dispose(); await rm(root, { recursive: true, force: true }) })
  const restart = async () => {
    await runtimes.at(-1).dispose()
    const rt = new SwarmRuntime(config, workers); rt.kick = () => {}; runtimes.push(rt)
    await rt.start()
    return rt
  }
  return { runtime, workers, owner, mission, preferred, spare, actor, propose, restart }
}

async function occupy(f, member = f.preferred) {
  const task = f.propose({ title: 'Existing work', assigneeId: member.id, assignmentMode: 'pinned' })
  await f.runtime.claim(f.actor(member), f.mission.id, task.id)
  f.workers.busy.add(member.id)
  return task
}

const row = (f, task) => f.runtime.task(f.mission.id, task.id)
async function confirmedStop(f, task) {
  const deadline = Date.now() + 2500
  while (row(f, task).resumeAfterStop && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(row(f, task).resumeAfterStop, undefined, 'the previous execution must confirm its stop before member reuse')
}

test('an idle member borrows untouched work from a busy preference without inventing a prior author', async t => {
  const f = await fixture(t); await occupy(f)
  const task = f.propose({ title: 'Parallel change' })
  await f.runtime.scheduling.dispatch(f.mission, f.mission.id)
  const claimed = row(f, task)
  assert.equal(claimed.status, 'running')
  assert.equal(claimed.assigneeId, f.spare.id)
  assert.equal(claimed.attempt.ownerId, f.spare.id)
  assert.equal(claimed.plannedAssigneeId, f.spare.id, 'recovery keeps the actual workspace owner')
  assert.deepEqual([...f.runtime.authorIds(claimed)], [f.spare.id])
  assert.equal(f.runtime.store.events(f.mission.id, 100).find(event => event.type === 'task/proposed' && event.data.id === task.id).data.assigneeId, f.preferred.id)
})

test('an available preferred member keeps its work even when the spare appears first in dispatch', async t => {
  const f = await fixture(t), task = f.propose()
  await f.runtime.scheduling.dispatch(f.mission, f.mission.id)
  assert.equal(row(f, task).attempt.ownerId, f.preferred.id)
  assert.deepEqual(f.workers.prepared, [{ taskId: task.id, memberId: f.preferred.id }])
})

test('an unfinished non-task worker turn does not reserve preferred pending work', async t => {
  const f = await fixture(t), task = f.propose()
  f.workers.busy.add(f.preferred.id)
  assert.equal(f.runtime.store.list('tasks', f.mission.id).some(task => task.status === 'running'), false)
  await f.runtime.scheduling.dispatch(f.mission, f.mission.id)
  assert.equal(row(f, task).attempt.ownerId, f.spare.id)
})

test('pinned and legacy assignments never become spare-member work', async t => {
  const f = await fixture(t); await occupy(f)
  for (const assignmentMode of ['pinned', undefined]) {
    const task = f.propose({ assignmentMode })
    assert.equal(f.runtime.ready(row(f, task), f.spare), false)
    await assert.rejects(f.runtime.claim(f.actor(f.spare), f.mission.id, task.id), /not ready/)
  }
  await f.runtime.scheduling.dispatch(f.mission, f.mission.id)
  assert.equal(f.runtime.store.list('tasks', f.mission.id).filter(task => task.status === 'pending').length, 2)
})

test('borrowed implementation can be independently reviewed by its unused original preference', async t => {
  const f = await fixture(t), blocker = await occupy(f)
  const source = f.propose()
  const review = f.propose({ title: 'Independent review', kind: 'verification', reviewOf: source.id, assigneeId: f.spare.id, checks: [] })
  const claimed = await f.runtime.claim(f.actor(f.spare), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.spare), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'Immutable change' })
  assert.equal(f.runtime.reviewable(row(f, source), f.runtime.store.list('tasks', f.mission.id)), true)
  await assert.rejects(f.runtime.claim(f.actor(f.spare), f.mission.id, review.id), /not ready/)
  f.runtime.cancel(f.owner, f.mission.id, { taskId: blocker.id, reason: 'No longer needed' })
  f.workers.busy.delete(f.preferred.id)
  await confirmedStop(f, blocker)
  assert.ok(f.workers.stopped.includes(f.preferred.id))
  assert.equal(row(f, blocker).status, 'cancelled')
  const reviewAttempt = await f.runtime.claim(f.actor(f.preferred), f.mission.id, review.id)
  assert.equal(reviewAttempt.attempt.ownerId, f.preferred.id)
  await f.runtime.verify(f.actor(f.preferred), f.mission.id, { taskId: review.id, attemptId: reviewAttempt.attempt.id, verdict: 'accept', reason: 'Verified exact artifact' })
  assert.equal(row(f, source).status, 'accepted')
})

test('borrowing cannot consume an explicitly pinned independent reviewer', async t => {
  const f = await fixture(t); await occupy(f)
  const source = f.propose()
  f.propose({ kind: 'verification', reviewOf: source.id, assigneeId: f.spare.id, assignmentMode: 'pinned', checks: [] })
  assert.equal(f.runtime.ready(row(f, source), f.spare), false)
  await assert.rejects(f.runtime.claim(f.actor(f.spare), f.mission.id, source.id), /not ready/)
  const third = await f.runtime.addMember(f.owner, f.mission.id, { name: 'Third', role: 'general' })
  const claimed = await f.runtime.claim(f.actor(third), f.mission.id, source.id)
  assert.equal(claimed.assigneeId, third.id)
})

test('attempted work, budget resumes and stop transitions cannot be borrowed', async t => {
  const f = await fixture(t); await occupy(f)
  for (const extra of [{ epoch: 1, priorOwnerIds: [f.preferred.id] }, { epoch: 1, priorOwnerIds: undefined }, { attempt: { ownerId: f.preferred.id } }, { budgetResume: { epoch: 0 } }, { resumeAfterStop: { epoch: 0 } }]) {
    const task = { ...f.propose(), ...extra }
    f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', task))
    assert.equal(canBorrowTask(task), false)
    assert.equal(assignmentAllows(task, f.spare.id), false)
    await assert.rejects(f.runtime.claim(f.actor(f.spare), f.mission.id, task.id), /not ready|previous attempt to stop/)
  }
  const held = f.propose({ assigneeId: f.spare.id, assignmentMode: 'pinned' })
  held.status = 'blocked'; held.epoch = 3; held.resumeAfterStop = { epoch: 3, reason: 'handoff', memberId: f.spare.id }
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', held))
  const untouched = f.propose()
  await assert.rejects(f.runtime.claim(f.actor(f.spare), f.mission.id, untouched.id), /previous attempt to stop/)
})

test('a retired preference does not make untouched work dead or invisible in the arena', async t => {
  const f = await fixture(t), task = f.propose()
  const preferred = f.runtime.store.get('members', f.preferred.id); preferred.phase = 'stopped'
  f.runtime.commit(f.mission.id, () => f.runtime.store.put('members', preferred))
  const tasks = f.runtime.store.list('tasks', f.mission.id), members = f.runtime.store.list('members', f.mission.id)
  assert.deepEqual(f.runtime.unschedulable(f.mission, tasks, members), [])
  assert.deepEqual(pendingReadiness(tasks, members), { ready: 1, notReady: 0 })
  const claimed = await f.runtime.claim(f.actor(f.spare), f.mission.id, task.id)
  assert.equal(claimed.assigneeId, f.spare.id)
})

test('dispatch cannot overwrite cancellation or reassignment during workspace preparation', async t => {
  for (const change of ['cancel', 'assignee', 'mode']) {
    await t.test(change, async t => {
      const f = await fixture(t); await occupy(f)
      const task = f.propose()
      f.workers.onPrepare = async (_member, preparing) => {
        if (preparing.id !== task.id) return
        const fresh = row(f, task)
        if (change === 'cancel') { fresh.status = 'cancelled'; fresh.epoch++ }
        else if (change === 'assignee') { fresh.assigneeId = f.spare.id; fresh.plannedAssigneeId = f.spare.id }
        else fresh.assignmentMode = 'pinned'
        f.runtime.commit(f.mission.id, () => f.runtime.store.put('tasks', fresh))
      }
      await f.runtime.scheduling.dispatch(f.mission, f.mission.id)
      assert.equal(row(f, task).attempt, undefined)
      assert.equal(row(f, task).status, change === 'cancel' ? 'cancelled' : 'pending')
    })
  }
})

test('restart preserves untouched flexibility and fences recovery to the actual borrowed owner', async t => {
  const f = await fixture(t); await occupy(f)
  const task = f.propose()
  const resumed = await f.restart(); f.runtime = resumed
  f.workers.busy.add(f.preferred.id)
  assert.equal(canBorrowTask(row(f, task)), true)
  const claimed = await resumed.claim(f.actor(f.spare), f.mission.id, task.id)
  assert.equal(claimed.plannedAssigneeId, f.spare.id)
  const recovered = await f.restart(); f.runtime = recovered
  const pending = row(f, task)
  assert.equal(pending.status, 'pending')
  assert.ok(pending.epoch > 0)
  assert.equal(pending.assigneeId, f.spare.id)
  assert.equal(pending.plannedAssigneeId, f.spare.id)
  await assert.rejects(recovered.claim(f.actor(f.preferred), f.mission.id, task.id), /not ready/)
  assert.equal((await recovered.claim(f.actor(f.spare), f.mission.id, task.id)).attempt.ownerId, f.spare.id)
})
