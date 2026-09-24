/** Focused functional audit regressions: dependency trust and async admission boundaries. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeWorkers, eventually, makeRuntime } from './faults/harness.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
class AuditWorkers extends FakeWorkers {
  autoIdle = true
  prepare = async () => {}
  verify = async () => [{ command: 'test', exitCode: 0, output: 'ok' }]
  async prepareWorkspace(mission, memberId) { return `${mission.workspace}/${memberId}` }
  async prepareTask(member, task, dependencies) { await this.prepare(member, task, dependencies) }
  async captureArtifact(member) { return { commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), workspace: member.workspace, changedPaths: [] } }
  async verifyArtifact(member, task, artifact) { return await this.verify(member, task, artifact) }
}
async function fixture(t) {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, { workers: new AuditWorkers(),
    config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 100, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 10 } })
  const owner = { sessionId: 'owner-audit' }
  const mission = runtime.create(owner, { title: 'Audit', objective: 'Verify exact artifacts', workspace: directory, scope: ['src/'], acceptance: ['done'], budget })
  const a = await runtime.addMember(owner, mission.id, { name: 'author', role: 'implementation' })
  const b = await runtime.addMember(owner, mission.id, { name: 'reviewer', role: 'verification' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Audit paths' })
  const propose = (title, extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title,
    kind: 'implementation', scope: ['src/'], acceptance: ['done'], checks: ['test'], ...extra })
  return { runtime, workers, owner, mission, a, b, stream, propose }
}
function seedSource(f, status = 'accepted') {
  const source = f.propose('Source artifact', { assigneeId: f.a.id })
  source.status = status
  source.epoch = 1
  source.attempt = { id: 'source-attempt', epoch: 1, ownerId: f.a.id, leaseUntil: Date.now() + 60000 }
  source.artifact = { commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40), workspace: f.a.workspace, changedPaths: ['src/a.ts'] }
  source.evidenceIds = ['evidence-source']
  f.runtime.store.transaction(() => {
    f.runtime.store.put('tasks', source)
    f.runtime.store.put('evidence', { id: 'evidence-source', missionId: f.mission.id, workstreamId: f.stream.id, taskId: source.id,
      authorId: f.a.id, claim: 'The artifact is valid', outcome: 'supported', status: status === 'accepted' ? 'verified' : 'unverified',
      toolRunIds: ['historical-run'], artifact: source.artifact, challenges: [], supersedes: [], createdAt: Date.now() })
  })
  return source
}

test('challenging accepted evidence fences running descendants before their next effectful tool', async t => {
  const f = await fixture(t)
  const source = seedSource(f)
  const downstream = f.propose('Dependent implementation', { dependencies: [source.id], assigneeId: f.b.id })
  await eventually(() => f.runtime.store.get('tasks', downstream.id)?.status === 'running', 'dependent was not scheduled', 2500)
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'evidence-source', reason: 'Prerequisite correctness is disputed', toolRunIds: [] })
  assert.notEqual(f.workers.callbacks.guard(f.b.id, 'write_file'), undefined, 'effectful tools must be fenced as soon as the prerequisite is challenged')
  assert.notEqual(f.runtime.store.get('tasks', downstream.id).status, 'running', 'the descendant cannot retain a valid running attempt')
  await eventually(() => f.workers.stopped.includes(f.b.id), 'challenged dependent worker was not stopped', 2500)
})

test('a challenge during workspace preparation cannot be overwritten by a stale dispatch snapshot', async t => {
  const f = await fixture(t)
  const source = seedSource(f)
  const entered = deferred(), release = deferred()
  let target
  f.workers.prepare = async (_member, task) => { if (task.id === target) { entered.resolve(); await release.promise } }
  const downstream = f.propose('Dependency-sensitive dispatch', { dependencies: [source.id], assigneeId: f.b.id })
  target = downstream.id
  await entered.promise
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'evidence-source', reason: 'Dependency became untrusted during preparation', toolRunIds: [] })
  release.resolve()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.notEqual(f.runtime.store.get('tasks', downstream.id).status, 'running', 'dispatch must revalidate current dependencies after awaiting preparation')
})

test('independent verification cannot silently accept evidence challenged during its host checks', async t => {
  const f = await fixture(t)
  const source = seedSource(f, 'submitted')
  const review = f.propose('Independent review', { kind: 'verification', reviewOf: source.id, assigneeId: f.b.id })
  const running = await eventually(() => { const task = f.runtime.store.get('tasks', review.id); return task?.status === 'running' ? task : undefined }, 'review was not scheduled', 2500)
  const entered = deferred(), release = deferred()
  f.workers.verify = async () => { entered.resolve(); await release.promise; return [{ command: 'test', exitCode: 0, output: 'ok' }] }
  const verification = f.runtime.verify({ sessionId: f.b.sessionId }, f.mission.id, { taskId: review.id, attemptId: running.attempt.id, verdict: 'accept', reason: 'Checks passed before new challenge' })
    .then(result => ({ result }), error => ({ error }))
  await entered.promise
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'evidence-source', reason: 'New counterexample arrived while checks were executing', toolRunIds: [] })
  release.resolve()
  const outcome = await verification
  assert.ok(outcome.error || outcome.result.status !== 'accepted', 'verification must require a fresh review when its evidence changed')
  assert.equal(f.runtime.store.get('evidence', 'evidence-source').status, 'challenged', 'new dissent must not be promoted away')
})

test('challenge invalidation follows reviewOf edges as well as ordinary task dependencies', async t => {
  const f = await fixture(t)
  const source = seedSource(f)
  const dependent = f.propose('Submitted dependent artifact', { dependencies: [source.id], assigneeId: f.a.id })
  dependent.status = 'submitted'
  dependent.epoch = 1
  dependent.attempt = { id: 'dependent-attempt', epoch: 1, ownerId: f.a.id, leaseUntil: Date.now() + 60000 }
  dependent.artifact = { ...source.artifact, commit: 'c'.repeat(40) }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', dependent))
  const review = f.propose('Review dependent artifact', { kind: 'verification', reviewOf: dependent.id, assigneeId: f.b.id })
  await eventually(() => f.runtime.store.get('tasks', review.id)?.status === 'running', 'dependent review was not scheduled', 2500)
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'evidence-source', reason: 'The root prerequisite is invalid', toolRunIds: [] })
  assert.notEqual(f.runtime.store.get('tasks', review.id).status, 'running', 'reviewOf is a semantic dependency and must be fenced too')
  assert.notEqual(f.workers.callbacks.guard(f.b.id, 'write_file'), undefined, 'the obsolete verifier cannot retain workspace tool authority')
})
