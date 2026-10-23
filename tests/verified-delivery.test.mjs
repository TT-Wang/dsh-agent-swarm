/**
 * What a mission delivers, as one rule: `verifiedDelivery` (src/task-graph.ts)
 * is the delivery `selectAcceptedDelivery` names, the one completion, the
 * snapshot's `deliveryTarget` and the owner's inspect/apply use, plus the
 * accepted independent verification of its exact artifact. The live command
 * smoke asserts this on the completed board. It used to require an accepted
 * integration task of its own accord, which the owner protocol asks for only
 * when several implementation branches exist, so a correct mission of one
 * reviewed implementation failed it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { verifiedDelivery } from '../lib/task-graph.js'
import { FakeWorkers, makeRuntime } from './faults/harness.mjs'

const sha = digit => digit.repeat(40)
const artifact = commit => ({ commit, baseCommit: sha('0'), workspace: '/w', changedPaths: ['src/x.ts'] })
function row(id, kind, status, extra = {}) {
  return { id, missionId: 'm', workstreamId: 'w', title: id, objective: id, kind, status, dependencies: [], scope: ['src/'],
    acceptance: ['done'], checks: kind === 'verification' ? [] : ['npm test'], priority: 50, experiment: false, epoch: 1, priorOwnerIds: [],
    proposedBy: 'owner', evidenceIds: [], createdAt: 1, ...extra }
}
/** An accepted code task, authored by `author`. */
const code = (id, kind, commit, extra = {}) => row(id, kind, 'accepted', { artifact: artifact(commit), assigneeId: 'author', attempt: { id: `${id}-a`, ownerId: 'author' }, ...extra })
/** The verdict `verify` leaves on a review: accepted, with the commit it judged. */
const review = (source, commit, extra = {}) => row(`review-${source}`, 'verification', 'accepted',
  { reviewOf: source, reviewedCommit: commit, assigneeId: 'reviewer', attempt: { id: `review-${source}-a`, ownerId: 'reviewer' }, ...extra })

test('one reviewed implementation is the delivery, read from what verify records', async t => {
  const { dir, runtime, budget } = await makeRuntime(t, {
    workers: new FakeWorkers({
      checks: [{ command: 'test', exitCode: 0, output: 'ok' }],
      artifact: { commit: sha('c'), baseCommit: sha('b'), workspace: '/isolated', changedPaths: ['src/a.ts'] },
      async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) },
    }),
    config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 500, checkTimeoutMs: undefined },
  })
  const owner = { sessionId: 'delivery-owner' }
  const mission = runtime.create(owner, { title: 'Deliver', objective: 'One change', workspace: dir, scope: ['src/'], acceptance: ['works'], budget },
    { grantRoot: dir, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const as = member => ({ sessionId: member.sessionId })
  const implementation = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], covers: ['c1'], checks: ['test'] })
  const claimed = await runtime.claim(as(author), mission.id, implementation.id)
  await runtime.submit(as(author), mission.id, { taskId: implementation.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const check = runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Review', objective: 'Independent review',
    kind: 'verification', scope: ['src/'], checks: [], reviewOf: implementation.id })
  const reviewing = await runtime.claim(as(reviewer), mission.id, check.id)
  await runtime.verify(as(reviewer), mission.id, { taskId: check.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Independent host checks pass' })

  const snapshot = runtime.snapshot(owner, mission.id)
  assert.equal(snapshot.tasks.some(task => task.kind === 'integration'), false, 'the plan has no integration task')
  assert.deepEqual(snapshot.completion, { eligible: true }, 'the runtime completes on one reviewed implementation')
  const delivered = verifiedDelivery(snapshot.tasks)
  assert.equal(delivered.delivery.id, implementation.id)
  assert.equal(delivered.review.id, check.id)
  assert.deepEqual(snapshot.deliveryTarget, { taskId: delivered.delivery.id, commit: delivered.delivery.artifact.commit }, 'it is the delivery the snapshot projects')
})

test('a delivery without an accepted independent verification of its exact artifact is refused', () => {
  const delivery = code('impl', 'implementation', sha('1'))
  assert.throws(() => verifiedDelivery([delivery]), /Delivery impl has no accepted verification of its artifact 1{40}/, 'no review at all')
  for (const status of ['pending', 'running', 'blocked', 'cancelled']) {
    assert.throws(() => verifiedDelivery([delivery, review('impl', sha('1'), { status })]), /no accepted verification/, `a ${status} review`)
  }
  assert.throws(() => verifiedDelivery([delivery, review('impl', sha('9'))]), /no accepted verification/, 'a verdict on another commit')
  assert.throws(() => verifiedDelivery([delivery, review('other', sha('1'))]), /no accepted verification/, 'a verdict on another task')
  assert.throws(() => verifiedDelivery([delivery, review('impl', sha('1'), { attempt: { id: 'x', ownerId: 'author' } })]), /not made by a member independent/, 'the author reviewed its own work')
  assert.throws(() => verifiedDelivery([{ ...delivery, priorOwnerIds: ['reviewer'] }, review('impl', sha('1'))]), /not made by a member independent/, 'the reviewer once owned the work')
  const verified = review('impl', sha('1'))
  assert.deepEqual(verifiedDelivery([delivery, verified]), { delivery, review: verified })
})

test('several implementation branches deliver only the reviewed integration covering all of them', () => {
  const branches = [code('a', 'implementation', sha('a')), review('a', sha('a')), code('b', 'implementation', sha('b')), review('b', sha('b'))]
  assert.throws(() => verifiedDelivery(branches), /unique independently accepted implementation artifact is required/, 'two branches and no integration')
  const partial = code('int', 'integration', sha('c'), { dependencies: ['a'] })
  assert.throws(() => verifiedDelivery([...branches, partial, review('int', sha('c'))]), /unique accepted integration of all implementation results/, 'an integration missing branch b')
  const integration = code('int', 'integration', sha('c'), { dependencies: ['a', 'b'] })
  assert.throws(() => verifiedDelivery([...branches, integration]), /Delivery int has no accepted verification/, 'an unreviewed integration')
  const verified = review('int', sha('c'))
  assert.deepEqual(verifiedDelivery([...branches, integration, verified]), { delivery: integration, review: verified })
  // One implementation with an integration obligation still delivers that integration.
  const single = [branches[0], branches[1], code('int', 'integration', sha('c'), { dependencies: ['a'] }), verified]
  assert.equal(verifiedDelivery(single).delivery.id, 'int')
})
