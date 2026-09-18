/**
 * Round-20 control-path fencing regressions.
 *
 * Each test pins one defect the 2026-09-18 audit reproduced with a probe on the
 * unmodified head, and each fails there:
 *
 *  1. Every control path that stopped work in flight assembled the same five
 *     writes by hand and they disagreed. `fenceWorkspace` set a running task to
 *     blocked and bumped its epoch but left the attempt on the row, left its
 *     owner out of `priorOwnerIds`, installed no stop marker and never stopped
 *     the handle: the human withdrew the workspace authorization and the worker
 *     kept writing to it.
 *  2. Mission pause/stop and challenge closed attempts with only their own
 *     domain event, so the trace replay decoder refused — as truncated — a
 *     durable log this runtime had just written. `task/start-failed` drops the
 *     attempt too and had the same gap.
 *  3. Fresh input arriving while a stop barrier was in flight was admitted and
 *     charged a mission step, and a task cancelled after its ceiling barrier had
 *     settled left its member parked forever, because the barrier only ever
 *     releases a member named by a live marker or a running attempt.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { orchestratorCommands } from '../lib/trace.js'

const BUDGET = { maxTokens: 1000000, maxSteps: 5000, maxWorkers: 6, maxDurationMs: 3600000, maxTasks: 60, maxExperiments: 0 }
const artifact = commit => ({ commit, baseCommit: '0'.repeat(40), workspace: '/w', changedPaths: ['src/x.ts'] })

class StubWorkers {
  constructor() { this.idle = new Set(); this.stopped = [] }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return path.join(mission.workspace, memberId) }
  async start(member) { this.idle.add(member.id) }
  async deliver() {}
  async stop(memberId) { this.stopped.push(memberId); this.idle.delete(memberId) }
  async dispose() {}
  isIdle() { return true }
  async prepareTask() {}
  async captureArtifact(member) { return { ...artifact('a'.repeat(40)), workspace: member.workspace } }
  async verifyArtifact() { return [{ command: 'npm test', exitCode: 0, output: 'ok' }] }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'swarm-r20-'))
  const workers = new StubWorkers()
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 1000, maxTasksPerMember: 100 }, workers)
  runtime.kick = () => {}
  runtime.pumpOutbox = () => {}
  // A held stop is released before dispose whatever the test did, so a failed
  // assertion reports itself instead of wedging the runner on a pending barrier.
  const held = {}
  t.after(async () => { held.release?.(); await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const holdStop = () => {
    workers.stop = async memberId => { workers.stopped.push(memberId); await new Promise(resolve => { held.release = resolve }) }
    return () => held.release?.()
  }
  const owner = { sessionId: `r20-owner-${Math.random()}` }
  const mission = runtime.create(owner, { title: 'R20', objective: 'Deliver verified work', workspace: directory,
    scope: ['src/', 'docs/'], acceptance: ['done'], budget: { ...BUDGET } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Work' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  return { directory, runtime, workers, owner, mission, stream, author, holdStop, actor: member => ({ sessionId: member.sessionId }) }
}
const propose = (f, title, extra = {}) => f.runtime.propose(f.owner, f.mission.id, { workstreamId: f.stream.id, title, objective: title,
  kind: 'implementation', scope: ['src/'], acceptance: ['done'], checks: ['npm test'], ...extra })
const current = (f, id) => f.runtime.store.get('tasks', typeof id === 'string' ? id : id.id)
const memberStatus = (f, memberId) => f.runtime.snapshot(f.owner, f.mission.id).members.find(member => member.id === memberId).status
const replay = f => orchestratorCommands(f.runtime.store.events(f.mission.id, 2000))
async function until(predicate, what) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && !predicate()) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(predicate(), what)
}
const barrierSettled = (f, task) => until(() => current(f, task).resumeAfterStop === undefined, 'the stop barrier settled')

// ---------------------------------------------------------------------------

test('R20-1: fencing a revoked workspace drops the attempt, records the owner and stops the handle', async t => {
  const f = await fixture(t)
  const task = propose(f, 'Work under a revoked grant', { assigneeId: f.author.id })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  const epoch = current(f, task).epoch

  f.runtime.fenceWorkspace(f.mission.id, 'workspace_revoked: the authorized grant root was removed')

  const row = current(f, task)
  assert.equal(row.status, 'blocked', 'the task is blocked with the revocation reason')
  assert.equal(row.attempt, undefined, 'the fenced attempt is gone from the row')
  assert.deepEqual(row.priorOwnerIds, [f.author.id], 'the outgoing owner is durable, so a later review stays independent of it')
  assert.equal(row.epoch, epoch + 1, 'the epoch bump invalidates the outstanding lease')
  assert.equal(row.resumeAfterStop?.epoch, row.epoch, 'the stop obligation is recorded at the current epoch')
  assert.equal(row.resumeAfterStop?.memberId, f.author.id)
  assert.equal(row.resumeAfterStop?.reason, 'invalidated', 'revocation is terminal for this host process; the barrier must not re-pend it')
  await until(() => f.workers.stopped.includes(f.author.id), 'the fenced handle was actually stopped')
  await barrierSettled(f, task)
  assert.equal(current(f, task).status, 'blocked', 'the settled barrier leaves the revoked task blocked')
  // The fenced attempt can never resume against the revoked root.
  assert.throws(() => f.runtime.attempts.ownAttempt(f.actor(f.author), f.mission.id, task.id, claimed.attempt.id),
    /Stale or unauthorized/, 'the fenced attempt no longer owns the task')
})

test('R20-2: replay accepts the log a mission pause, resume and re-claim writes', async t => {
  const f = await fixture(t)
  const task = propose(f, 'Paused work', { assigneeId: f.author.id })
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.runtime.control(f.owner, f.mission.id, 'pause', 'Owner pauses the mission')
  await barrierSettled(f, task)
  f.runtime.control(f.owner, f.mission.id, 'resume', 'Owner resumes the mission')
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'Withdraw the work' })

  const replayed = replay(f)
  assert.deepEqual(replayed.unresolved, [], 'both dispatches reached a closing event')
  assert.equal(replayed.commands.filter(command => command.kind === 'dispatch').length, 2, 'the replay keeps both dispatches')
  const fenced = f.runtime.store.events(f.mission.id, 2000).filter(event => event.type === 'attempt/fenced')
  assert.deepEqual(fenced.map(event => event.data.cause), ['mission-pause', 'owner-cancel'], 'one uniform closer per fence, naming its cause')
  assert.equal(fenced[0].data.taskId, task.id)
})

test('R20-3: replay accepts the log an owner stop writes', async t => {
  const f = await fixture(t)
  const task = propose(f, 'Stopped work', { assigneeId: f.author.id })
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.runtime.control(f.owner, f.mission.id, 'stop', 'Owner stops the mission')

  const replayed = replay(f)
  assert.deepEqual(replayed.unresolved, [], 'the stopped attempt reached a closing event')
  assert.equal(current(f, task).status, 'cancelled')
  assert.deepEqual(f.runtime.store.events(f.mission.id, 2000).filter(event => event.type === 'attempt/fenced').map(event => event.data.cause), ['mission-stop'])
})

test('R20-4: replay accepts the log a failed worker start writes', async t => {
  const f = await fixture(t)
  const task = propose(f, 'Re-routed work', { assigneeId: f.author.id })
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.runtime.onStartFailure(f.runtime.mission(f.mission.id), f.runtime.store.get('members', f.author.id), new Error('worker could not start'))
  assert.equal(current(f, task).attempt, undefined, 'the start failure dropped the attempt')
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'Withdraw the work' })

  const replayed = replay(f)
  assert.deepEqual(replayed.unresolved, [], 'the attempt the start failure dropped reached a closing event')
  assert.equal(replayed.commands.filter(command => command.kind === 'dispatch').length, 2)
})
