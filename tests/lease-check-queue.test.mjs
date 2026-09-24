/**
 * R11-05/R11-19 regression: a long declared check runs outside the per-mission
 * queue. The queued attempt's lease keeps being renewed from its live
 * `verification` activity, and dispatch for the mission is not delayed by the
 * check.
 *
 * Pre-fix head: `verify()` held the mission queue for the whole check, so the
 * scheduler tick could neither renew the lease (the attempt expired and the
 * verdict failed closed) nor dispatch other ready work (616 ms vs 6 ms in the
 * round-10 measurement).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { FakeWorkers, eventually, makeRuntime } from './faults/harness.mjs'

class SlowCheckWorkers extends FakeWorkers {
  checks = []
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async captureArtifact(member, task) { return { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: `/isolated/${member.id}`, changedPaths: ['src/a.ts'] } }
  async verifyArtifact(member, source, artifact, signal) {
    this.checks.push({ memberId: member.id, sourceId: source.id, startedAt: Date.now() })
    this.reportActivity(member.id, { id: `verification-${member.id}`, kind: 'verification', startedAt: Date.now(), updatedAt: Date.now() })
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs)
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')) }, { once: true })
      })
      return [{ command: source.checks[0] ?? 'check', exitCode: 0, output: 'ok' }]
    } finally {
      this.reportActivity(member.id, undefined)
    }
  }
}

test('R11-05: a long queued check keeps its attempt lease alive and does not delay dispatch', async t => {
  const workers = new SlowCheckWorkers()
  workers.delayMs = 1500
  const { dir: directory, runtime, budget } = await makeRuntime(t, { workers,
    config: { leaseMs: 300, tickMs: 15, maxMessageChars: 10000, maxEvents: 500, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxDurationMs: 3600000, maxTasks: 100 } })
  await runtime.start()
  const owner = { sessionId: 'lease-owner' }
  const mission = runtime.create(owner, { title: 'Long check', objective: 'Keep the lease', workspace: directory, scope: ['**'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const other = await runtime.addMember(owner, mission.id, { name: 'Other', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const source = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Source', objective: 'Source', kind: 'implementation',
    scope: ['**'], acceptance: ['works'], checks: ['test -d .'], assigneeId: author.id })
  const sourceClaim = await runtime.claim({ sessionId: author.sessionId }, mission.id, source.id)
  await runtime.submit({ sessionId: author.sessionId }, mission.id, { taskId: source.id, attemptId: sourceClaim.attempt.id, output: 'ready for review' })
  const review = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Review', objective: 'Review', kind: 'verification',
    reviewOf: source.id, scope: ['**'], acceptance: ['works'], checks: ['test -d .'], checkTimeoutMs: 100, assigneeId: reviewer.id })
  const reviewClaim = await runtime.claim({ sessionId: reviewer.sessionId }, mission.id, review.id)
  const initialLease = runtime.store.get('tasks', review.id).attempt.leaseUntil
  const verification = runtime.verify({ sessionId: reviewer.sessionId }, mission.id, { taskId: review.id, attemptId: reviewClaim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  await eventually(() => workers.checks.length === 1, 'the declared check never started', 4000)
  const startedAt = workers.checks[0].startedAt
  // R11-05: the queued attempt's lease is renewed from live verification
  // activity while the check runs, so it never expires mid-check.
  const renewed = await eventually(() => {
    const task = runtime.store.get('tasks', review.id)
    if (task.status !== 'running') return undefined
    const leaseUntil = task.attempt?.leaseUntil ?? 0
    return leaseUntil > initialLease ? leaseUntil : undefined
  }, 'the lease was not renewed while the check was running', 4000)
  assert.ok(renewed > Date.now(), 'the renewed lease covers the present')
  // R11-05: dispatch is not delayed behind the check: a second ready task is
  // claimed while the first check is still in flight.
  workers.idle.add(other.id)
  const parallel = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Parallel', objective: 'Dispatch during the check', kind: 'implementation',
    scope: ['**'], acceptance: ['works'], checks: ['test -d .'], assigneeId: other.id })
  const dispatched = await eventually(() => {
    const task = runtime.store.get('tasks', parallel.id)
    return task.status === 'running' ? task : undefined
  }, 'dispatch was delayed behind the long check', 1000)
  assert.ok(Date.now() - startedAt < workers.delayMs, 'the second task was dispatched before the check finished')
  assert.equal(dispatched.assigneeId, other.id)
  const verdict = await verification
  assert.equal(verdict.status, 'accepted', 'the verdict applied after the check')
  assert.equal(runtime.store.get('tasks', source.id).status, 'accepted')
})
