/**
 * CORE-01: an acceptance records what it rests on (`AcceptanceBasis`,
 * src/types.ts), and an acceptance of a source that declares no host checks
 * rests on review evidence.
 *
 * A source with declared checks is accepted on the rows of the pass the
 * verdict classified: `{ kind: 'checks', runIds }`. A source without them is
 * accepted only on the reviewer's judgement, backed by at least one claim the
 * reviewer published with `swarm_publish` on the accepting attempt
 * (`reviewEvidence`, src/task-graph.ts): `{ kind: 'review-evidence',
 * evidenceIds }`. That is the rule a research submission already applies to
 * its own claims, mirrored for review. It replaced a count of the attempt's
 * non-error tool runs, which accepted on one unrelated `bash` call and named
 * none of it: `task/accepted.checks` was empty and no verdict row named the
 * reviewer's runs, so the basis of the acceptance was never recorded.
 *
 * What backs nothing: a recorded run with no claim, a claim of an earlier
 * attempt of the same review, and a reading through `swarm_observe`, which is
 * never a recorded run. The refusal, `[review_evidence_required]`, records
 * nothing and leaves the attempt running. A rejection needs no basis and
 * records none. The basis is written on `task/accepted`, on every
 * `evidence/verdict` row of the acceptance, on the accepting review
 * (`acceptanceBasis`) and in the artifact registry.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { PolicyError } from '../lib/policy-error.js'
import { reviewEvidence } from '../lib/task-graph.js'
import { assessText, toolSchemaIndex } from './refusal-inventory.mjs'
import { FakeClock, FakeWorkers, makeRuntime } from './faults/harness.mjs'

/** An owner, an author and the only independent reviewer of the author's work. */
async function fixture(t) {
  const { dir, runtime, workers, budget } = await makeRuntime(t, { workers: new FakeWorkers(), clock: new FakeClock(),
    config: { maxEvents: 5000, maxTasksPerMember: 100, checkTimeoutMs: undefined }, budget: { maxTasks: 100 } })
  await runtime.start()
  const owner = { sessionId: 'basis-owner' }
  const mission = runtime.create(owner, { title: 'Basis', objective: 'Record what an acceptance rests on', workspace: dir, scope: ['src/'], acceptance: ['works'], budget }, { grantRoot: dir, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'research' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const current = task => runtime.store.get('tasks', task.id)
  const events = type => runtime.store.events(mission.id, 5000).filter(event => event.type === type)
  /** Research by default: its report artifact (src/answer.txt) needs no checks. */
  const propose = (title, extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title,
    kind: 'research', scope: ['src/'], acceptance: ['works'], covers: ['c1'], checks: [], assigneeId: author.id, ...extra })
  const proposeReview = source => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: `Review ${source.title}`,
    objective: 'Independent review', kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: source.id })
  const claim = (member, task) => runtime.claim(actor(member), mission.id, task.id)
  /** One non-swarm tool run of `member`'s open attempt; returns its id. */
  const run = (member, command) => workers.callbacks.toolRun(member.id, { tool: 'bash', arguments: { command }, result: { exitCode: 0, output: 'ok' }, isError: false })
  /** One host-backed claim on `claimed`'s attempt. */
  async function publish(member, claimed, text) {
    const runId = await run(member, `inspect ${text}`)
    return runtime.publish(actor(member), mission.id, { taskId: claimed.id, attemptId: claimed.attempt.id, claim: text, outcome: 'supported', toolRunIds: [runId] })
  }
  /** Claim, publish one claim and submit, as the author; returns the claim. */
  async function submit(task) {
    const claimed = await claim(author, task)
    const published = await publish(author, claimed, 'The report answers the question')
    await runtime.submit(actor(author), mission.id, { taskId: claimed.id, attemptId: claimed.attempt.id, output: 'report' })
    return published
  }
  const verify = (claimed, verdict, reason = verdict === 'accept' ? 'The report meets the criterion' : 'The report misses the criterion') =>
    runtime.verify(actor(reviewer), mission.id, { taskId: claimed.id, attemptId: claimed.attempt.id, verdict, reason })
  /** The registry's review of `source`'s current artifact. */
  const registered = source => runtime.artifacts(owner, { missionId: mission.id }).artifacts.find(row => row.taskId === source.id && row.archived !== true).review
  /** Assert the [review_evidence_required] refusal, which records nothing. */
  async function refused(claimed, source) {
    const index = await toolSchemaIndex()
    const before = { source: current(source).status, review: current(claimed).attempt?.id, accepted: events('task/accepted').length, verdicts: events('evidence/verdict').length }
    await assert.rejects(verify(claimed, 'accept'), error => {
      assert.ok(error instanceof PolicyError)
      assert.equal(error.code, 'review_evidence_required')
      assert.equal(error.category, 'validation_error')
      assert.ok(error.message.startsWith(`[review_evidence_required] Source ${source.id} declares no host checks, so accepting it is your judgement as its reviewer`), error.message)
      assert.deepEqual(assessText(error.message, index), [], 'the exit resolves in the published tool schema')
      return true
    })
    assert.deepEqual({ source: current(source).status, review: current(claimed).attempt?.id, accepted: events('task/accepted').length, verdicts: events('evidence/verdict').length }, before, 'nothing was recorded')
    assert.equal(current(claimed).status, 'running', 'the attempt stays running')
  }
  return { runtime, workers, owner, mission, author, reviewer, actor, current, events, propose, proposeReview, claim, run, publish, submit, verify, registered, refused }
}

test('a source without checks is accepted only on review evidence published on the accepting attempt, and records it as the basis', async t => {
  const f = await fixture(t)
  const source = f.propose('Research')
  const claim = await f.submit(source)
  const claimed = await f.claim(f.reviewer, f.proposeReview(source))
  f.workers.checks = []
  // One recorded run used to accept: it named no artifact, and no record named it.
  await f.run(f.reviewer, 'pwd')
  await f.refused(claimed, source)
  // Reading the author's cited run through swarm_observe is not a run of the
  // reviewer's: swarm_* calls are never recorded, so it backs no claim either.
  const runs = f.runtime.store.list('tool_runs', f.mission.id).length
  f.runtime.observe(f.actor(f.reviewer), f.mission.id, { runId: f.runtime.store.get('evidence', claim.id).toolRunIds[0] })
  assert.equal(f.runtime.store.list('tool_runs', f.mission.id).length, runs, 'an observe records no run')
  await f.refused(claimed, source)
  const review = await f.publish(f.reviewer, claimed, 'The report states its finding and the cited run supports it')
  await f.verify(claimed, 'accept')
  const basis = { kind: 'review-evidence', evidenceIds: [review.id] }
  assert.deepEqual([f.current(source).status, f.runtime.store.get('evidence', claim.id).status], ['accepted', 'verified'])
  const [accepted] = f.events('task/accepted')
  assert.deepEqual(accepted.data.basis, basis, 'task/accepted names the claims the judgement rests on')
  assert.deepEqual(accepted.data.checks, [], 'no host check ran')
  assert.deepEqual(f.events('evidence/verdict').map(event => [event.data.evidenceId, event.data.verdict, event.data.basis]), [[claim.id, 'verified', basis]])
  assert.deepEqual(f.current(claimed).acceptanceBasis, basis, 'the accepting review carries it')
  assert.deepEqual(f.registered(source), { taskId: claimed.id, status: 'accepted', verdict: 'verified', reason: 'The report meets the criterion', basis }, 'the registry projects it')
  assert.equal(f.runtime.store.get('evidence', review.id).status, 'unverified', 'no verdict judges the review\'s own claim')
})

test('a claim of an earlier attempt of the same review backs no acceptance by a later attempt', async t => {
  const f = await fixture(t)
  const source = f.propose('Research')
  await f.submit(source)
  const review = f.proposeReview(source)
  const first = await f.claim(f.reviewer, review)
  f.workers.checks = []
  const earlier = await f.publish(f.reviewer, first, 'Read on the first attempt')
  f.runtime.handoff(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: first.attempt.id, summary: 'Releasing the review' })
  await f.runtime.settle(f.mission.id)
  const second = await f.claim(f.reviewer, review)
  assert.notEqual(second.attempt.id, first.attempt.id)
  assert.deepEqual(f.current(review).evidenceIds, [earlier.id], 'the earlier claim is still a current claim of the review')
  await f.refused(second, source)
  const own = await f.publish(f.reviewer, second, 'Read again on this attempt')
  await f.verify(second, 'accept')
  assert.deepEqual(f.current(review).acceptanceBasis, { kind: 'review-evidence', evidenceIds: [own.id] }, 'only this attempt\'s claim backs it')
})

test('a source with declared checks is accepted on its deciding pass, with or without review evidence', async t => {
  const f = await fixture(t)
  const source = f.propose('Implement', { kind: 'implementation', checks: ['test'] })
  const claim = await f.submit(source)
  const claimed = await f.claim(f.reviewer, f.proposeReview(source))
  f.workers.checks = [{ command: 'test', exitCode: 0, output: 'ok' }]
  await f.verify(claimed, 'accept')
  const [accepted] = f.events('task/accepted')
  assert.equal(accepted.data.checks.length, 1)
  const basis = { kind: 'checks', runIds: accepted.data.checks }
  assert.equal(f.runtime.store.get('tool_runs', basis.runIds[0]).tool, 'swarm.host_verification', 'the basis is the host check row')
  assert.deepEqual(accepted.data.basis, basis)
  assert.deepEqual(f.events('evidence/verdict').map(event => [event.data.evidenceId, event.data.basis]), [[claim.id, basis]])
  assert.deepEqual(f.current(claimed).acceptanceBasis, basis)
  assert.deepEqual(f.registered(source).basis, basis)
})

test('a rejection needs no review evidence and records no basis', async t => {
  const f = await fixture(t)
  const source = f.propose('Research')
  const claim = await f.submit(source)
  const claimed = await f.claim(f.reviewer, f.proposeReview(source))
  f.workers.checks = []
  await f.verify(claimed, 'reject')
  const [rejected] = f.events('task/rejected')
  assert.equal('basis' in rejected.data, false)
  assert.deepEqual(f.events('evidence/verdict').map(event => [event.data.evidenceId, event.data.verdict, 'basis' in event.data]), [[claim.id, 'refuted', false]])
  assert.equal(f.current(claimed).acceptanceBasis, undefined)
  const review = f.registered(source)
  assert.deepEqual([review.verdict, 'basis' in review], ['refuted', false])
})

test('the rule: the standing claims of the review attempt, as the runs they cite name it', () => {
  const runs = new Map([['r1', { attemptId: 'a1' }], ['r2', { attemptId: 'a2' }]])
  const claims = new Map([
    ['mine', { id: 'mine', status: 'unverified', toolRunIds: ['r1'] }],
    ['earlier', { id: 'earlier', status: 'unverified', toolRunIds: ['r2'] }],
    ['archived', { id: 'archived', status: 'unverified', toolRunIds: ['r1'] }],
    ['uncited', { id: 'uncited', status: 'unverified', toolRunIds: [] }],
  ])
  const review = { kind: 'verification', status: 'running', evidenceIds: ['mine', 'earlier', 'archived', 'uncited', 'missing'],
    rejections: [{ commit: 'c', epoch: 1, reviewTaskId: 'review', reason: 'misses it', evidenceIds: ['archived'] }] }
  const of = (task, attemptId) => reviewEvidence(task, attemptId, id => claims.get(id), id => runs.get(id)).map(claim => claim.id)
  assert.deepEqual(of(review, 'a1'), ['mine'], 'a claim of another attempt, an archived one and one citing no run back nothing')
  assert.deepEqual(of(review, 'a2'), ['earlier'])
  assert.deepEqual(of({ ...review, status: 'cancelled' }, 'a1'), [], 'a cancelled review\'s claims stand for nothing')
  assert.deepEqual(of({ ...review, kind: 'research' }, 'a1'), [], 'only a review has review evidence')
})
