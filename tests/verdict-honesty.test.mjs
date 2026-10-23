/**
 * Round-9 verdict-honesty regressions (F3), from the Round-8 Phase-A benchmark.
 *
 * Defect A: a rejected verification stored only the reviewer's prose as the
 * durable reason while the real failure lived in the host tool run. On the
 * benchmark the reviewer wrote "passed every acceptance criterion" while the
 * declared check had failed with exit 127. The durable `task/rejected` reason
 * and the owner notice must now name, per failing check, the command, the exit
 * code and a bounded output excerpt, alongside the reviewer's own reason; a
 * judgement rejection without a failing check keeps the prose unchanged.
 *
 * Defect B: one evidence record could be left both refuted and verified. A
 * rejection set `status: 'challenged'` while emitting `evidence/refuted`, the
 * supersede path emitted a second refutation, and the board then showed a
 * status that contradicted the durable verdict. A rejected verification must
 * refute the claim exactly once, and a superseding accepted verification must
 * link the predecessor without a second refutation; the board must never show
 * a status that contradicts the evidence's latest durable verdict event.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { durableVerdicts, shortId } from '../lib/types/client/projection.js'
import { SwarmBoard } from '../lib/types/client/SwarmBoard.js'
import { FakeWorkers, makeRuntime } from './faults/harness.mjs'

const MAX_MESSAGE_CHARS = 10000

async function fixture(t) {
  const { dir: directory, runtime, workers, budget } = await makeRuntime(t, {
    workers: new FakeWorkers({
      checks: [{ command: 'test', exitCode: 0, output: 'ok' }],
      artifact: { commit: 'c'.repeat(40), baseCommit: 'b'.repeat(40), workspace: '/isolated', changedPaths: ['src/a.ts'] },
      async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) },
    }),
    config: { tickMs: 60000, maxMessageChars: MAX_MESSAGE_CHARS, maxEvents: 500, maxTasksPerMember: 100, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 4, maxDurationMs: 3600000, maxTasks: 100 },
  })
  const owner = { sessionId: 'verdict-owner' }
  const mission = runtime.create(owner, { title: 'Verdict', objective: 'Honest verdicts', workspace: directory,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } }, { grantRoot: directory, source: 'session' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const actor = member => ({ sessionId: member.sessionId })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  const refutations = evidenceId => events('evidence/refuted').filter(event => event.data.evidenceId === evidenceId)
  const ownerNotices = () => runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner')
  const proposeSource = (title = 'Implement', extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: title,
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], ...extra })
  const proposeReview = (source, title = 'Review') => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title, objective: 'Independent review',
    kind: 'verification', scope: ['src/'], acceptance: ['works'], checks: [], reviewOf: source.id })
  async function publishEvidence(claimed, claim, outcome = 'supported', supersedes) {
    const runId = await workers.callbacks.toolRun(author.id, { tool: 'bash', arguments: { command: 'true' }, result: { exitCode: 0 }, isError: false })
    return runtime.publish(actor(author), mission.id, { taskId: claimed.id, attemptId: claimed.attempt.id, claim, outcome, toolRunIds: [runId],
      ...(supersedes === undefined ? {} : { supersedes }) })
  }
  async function submittedSourceWithEvidence(claim = 'The artifact satisfies the claim') {
    const source = proposeSource('Implement with evidence')
    const claimed = await runtime.claim(actor(author), mission.id, source.id)
    const evidence = await publishEvidence(claimed, claim)
    await runtime.submit(actor(author), mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
    return { source, evidence }
  }
  return { runtime, workers, owner, mission, stream, author, reviewer, actor, current, events, refutations, ownerNotices,
    proposeSource, proposeReview, publishEvidence, submittedSourceWithEvidence }
}

const VERDICT_FOR_STATUS = { verified: 'evidence/verified', refuted: 'evidence/refuted', challenged: 'evidence/challenged' }

/**
 * The board's contract: for every evidence id the rendered status badge and the
 * latest durable verdict event must agree, and the card must never carry the
 * opposite verdict event. Cards are located by their unique claim text because
 * `shortId` collapses every `evidence_*` id to the same prefix.
 */
function assertBoardIsConsistent(f, label) {
  const snapshot = f.runtime.snapshot(f.owner, f.mission.id)
  const verdicts = durableVerdicts(snapshot)
  const markup = renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, initialView: 'evidence' }))
  const cards = markup.split('<article class="sw-evidence">').slice(1)
  for (const evidence of snapshot.evidence) {
    const latest = verdicts.get(evidence.id)
    const latestRow = snapshot.events.find(event => event.seq === latest?.seq)
    const verdictType = latest?.type === 'evidence/verdict' ? `evidence/${latestRow.data.verdict}` : latest?.type
    assert.equal(verdictType, VERDICT_FOR_STATUS[evidence.status],
      `${label}: evidence ${evidence.id} is ${evidence.status} but its latest durable verdict is ${verdictType ?? 'none'}`)
    const card = cards.find(segment => segment.includes(evidence.claim))
    assert.ok(card, `${label}: the board renders the card for evidence ${evidence.id} (${shortId(evidence.id)})`)
    assert.match(card, new RegExp(`>${evidence.status}</span>`), `${label}: the card badge shows the stored status`)
    if (evidence.status === 'verified' || evidence.status === 'refuted') {
      assert.match(card, new RegExp(`Durable verdict event: ${latest.type}`), `${label}: the card names its durable verdict`)
      const opposite = evidence.status === 'verified' ? 'evidence/refuted' : 'evidence/verified'
      assert.doesNotMatch(card, new RegExp(`Durable verdict event: ${opposite}`), `${label}: the card never shows the opposite verdict`)
    }
  }
  return snapshot
}

test('an infrastructure-deferred verification names the actual failed check and same-task owner recovery', async t => {
  const f = await fixture(t)
  const { source } = await f.submittedSourceWithEvidence()
  const verdict = f.proposeReview(source, 'Verdict review')
  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, verdict.id)
  f.workers.checks = [{ command: 'npm run typecheck && npm run build', exitCode: 127, failureKind: 'infrastructure', output: 'sh: line 1: npm: command not found\nthe toolchain is absent' }]
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: verdict.id, attemptId: claimed.attempt.id,
    verdict: 'accept', reason: 'passed every acceptance criterion' })
  assert.equal(f.current(source.id).status, 'submitted')

  const [rejected] = f.events('task/verification-deferred')
  assert.ok(rejected, 'the deferred verdict is durable')
  assert.equal(f.events('task/rejected').length, 0)
  const reason = rejected.data.reason
  assert.match(reason, /passed every acceptance criterion/, 'the reviewer reason is retained')
  assert.match(reason, /npm run typecheck && npm run build/, 'the failing command is named')
  assert.match(reason, /exited 127/, 'the exit code is named')
  assert.match(reason, /npm: command not found/, 'an output excerpt is carried')
  assert.equal(rejected.data.checks.length, 1, 'the host run id is still recorded')
  const recorded = f.runtime.store.get('tool_runs', rejected.data.checks[0])
  assert.equal(recorded.result.exitCode, 127)
  assert.match(recorded.result.output, /npm: command not found/)
  const [notice] = f.ownerNotices().filter(delivery => /deferred its verdict on the immutable source/.test(delivery.content))
  assert.ok(notice, 'the owner is woken for repair of the host environment')
  assert.match(notice.content, /swarm_control/)
  assert.match(notice.content, /passed every acceptance criterion/, 'the notice keeps the reviewer reason')
  assert.match(notice.content, /npm run typecheck && npm run build/, 'the notice names the failing command')
  assert.match(notice.content, /exited 127/, 'the notice names the exit code')
  assert.match(notice.content, /npm: command not found/, 'the notice carries the output excerpt')
})

test('the durable rejection reason respects the message bound while naming the failing check', async t => {
  const f = await fixture(t)
  const { source } = await f.submittedSourceWithEvidence()
  const verdict = f.proposeReview(source, 'Verdict review')
  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, verdict.id)
  f.workers.checks = [{ command: 'npm test', exitCode: 1, output: 'x'.repeat(40000), truncated: true }]
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: verdict.id, attemptId: claimed.attempt.id,
    verdict: 'accept', reason: 'Checks failed' })
  const [rejected] = f.events('task/rejected')
  const reason = rejected.data.reason
  assert.ok(reason.length <= MAX_MESSAGE_CHARS, `the durable reason is bounded (${reason.length} > ${MAX_MESSAGE_CHARS})`)
  assert.match(reason, /npm test/, 'the failing command survives truncation')
  assert.match(reason, /exited 1/, 'the exit code survives truncation')
  assert.match(reason, /excerpt truncated|host output truncated/, 'the excerpt is explicitly bounded')
  assert.equal(f.current(verdict.id).output, reason, 'the verification task stores the same durable reason')
  assert.ok(f.current(verdict.id).output.length <= MAX_MESSAGE_CHARS, 'the stored rejection reason is bounded too')
})

test('a judgement rejection without a failing check keeps the reviewer reason as prose', async t => {
  const f = await fixture(t)
  const { source } = await f.submittedSourceWithEvidence()
  const verdict = f.proposeReview(source, 'Verdict review')
  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, verdict.id)
  f.workers.checks = [{ command: 'npm test', exitCode: 0, output: 'all green' }]
  const reason = 'The artifact does not cover the declared acceptance criterion'
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: verdict.id, attemptId: claimed.attempt.id, verdict: 'reject', reason })
  const [rejected] = f.events('task/rejected')
  assert.equal(rejected.data.reason, reason, 'a judgement rejection keeps the prose unchanged')
  assert.doesNotMatch(rejected.data.reason, /Host check/, 'no check-failure section is invented')
  const [notice] = f.ownerNotices().filter(delivery => /blocked by independent verification/.test(delivery.content))
  assert.match(notice.content, new RegExp(reason), 'the notice repeats the judgement reason')
  assert.doesNotMatch(notice.content, /Host check/, 'the notice invents no check failure')
})

test('a rejected verification refutes the claim once and a superseding acceptance does not refute it again', async t => {
  const f = await fixture(t)
  const { source, evidence } = await f.submittedSourceWithEvidence()
  const verdict = f.proposeReview(source, 'Verdict review')
  const claimed = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, verdict.id)
  f.workers.checks = [{ command: 'npm test', exitCode: 1, output: 'host check failed' }]
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: verdict.id, attemptId: claimed.attempt.id,
    verdict: 'accept', reason: 'Host checks reject the candidate' })
  assert.equal(f.current(source.id).status, 'blocked')
  const refuted = f.runtime.store.get('evidence', evidence.id)
  assert.equal(refuted.status, 'refuted', 'a rejected verification refutes the claim instead of leaving it challenged')
  assert.equal(f.refutations(evidence.id).length, 1, 'the rejection emits exactly one refutation')
  assertBoardIsConsistent(f, 'after the rejected verdict')

  // A replacement publishes superseding evidence; its acceptance links the
  // predecessor without a second refutation and without a stale verified signal.
  const replacement = f.proposeSource('Repair', { replaces: [source.id] })
  const claimedReplacement = await f.runtime.claim(f.actor(f.author), f.mission.id, replacement.id)
  const replacementEvidence = await f.publishEvidence(claimedReplacement, 'The repaired artifact satisfies the claim', 'supported', [evidence.id])
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: replacement.id, attemptId: claimedReplacement.attempt.id, output: 'repaired' })
  const repairReview = f.proposeReview(replacement, 'Repair review')
  const claimedRepairReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, repairReview.id)
  f.workers.checks = [{ command: 'npm test', exitCode: 0, output: 'ok' }]
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: repairReview.id, attemptId: claimedRepairReview.attempt.id,
    verdict: 'accept', reason: 'Repair verified' })

  assert.equal(f.runtime.store.get('evidence', replacementEvidence.id).status, 'verified')
  const superseded = f.runtime.store.get('evidence', evidence.id)
  assert.equal(superseded.status, 'refuted')
  assert.equal(superseded.refutedBy, replacementEvidence.id, 'the supersession link names the replacement evidence')
  assert.equal(f.refutations(evidence.id).length, 1, 'supersession does not refute an already-refuted claim a second time')
  assert.equal(f.events('evidence/verified').filter(event => event.data.evidenceId === evidence.id).length, 0,
    'the refuted claim is never marked verified')
  assertBoardIsConsistent(f, 'after the superseding acceptance')
})

test('evidence verified then challenged and rejected shows one refuted status on the board', async t => {
  const f = await fixture(t)
  const { source, evidence } = await f.submittedSourceWithEvidence()
  const firstReview = f.proposeReview(source, 'First review')
  const firstClaim = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, firstReview.id)
  f.workers.checks = [{ command: 'npm test', exitCode: 0, output: 'ok' }]
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: firstReview.id, attemptId: firstClaim.attempt.id,
    verdict: 'accept', reason: 'Checks pass' })
  assert.equal(f.runtime.store.get('evidence', evidence.id).status, 'verified')
  assertBoardIsConsistent(f, 'after acceptance')

  // Dissent revokes the accepted claim and returns the source for review.
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: evidence.id, reason: 'A counterexample invalidates the claim', toolRunIds: [] })
  assert.equal(f.runtime.store.get('evidence', evidence.id).status, 'challenged')
  assert.equal(f.current(source.id).status, 'submitted')

  const secondReview = f.proposeReview(source, 'Second review')
  const secondClaim = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, secondReview.id)
  f.workers.checks = [{ command: 'npm test', exitCode: 1, output: 'counterexample reproduced' }]
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: secondReview.id, attemptId: secondClaim.attempt.id,
    verdict: 'accept', reason: 'Host checks reject the challenged claim' })
  const refuted = f.runtime.store.get('evidence', evidence.id)
  assert.equal(refuted.status, 'refuted', 'the rejected re-review refutes the claim')
  assert.equal(f.events('evidence/verified').filter(event => event.data.evidenceId === evidence.id).length, 1,
    'the earlier acceptance stays historical and is not repeated')
  assert.equal(f.refutations(evidence.id).length, 1, 'the refutation is recorded exactly once')
  assertBoardIsConsistent(f, 'after the challenged claim was refuted')
})

test('a claim already refuted is neither verified again nor refuted twice when its source is re-reviewed', async t => {
  const f = await fixture(t)
  const source = f.proposeSource('Implement with a revised claim')
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  const first = await f.publishEvidence(claimed, 'The first attempt satisfies the claim')
  const revised = await f.publishEvidence(claimed, 'The revised attempt satisfies the claim', 'supported', [first.id])
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const accept = async title => {
    const review = f.proposeReview(source, title)
    const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    f.workers.checks = [{ command: 'npm test', exitCode: 0, output: 'ok' }]
    await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Checks pass' })
    return review
  }
  await accept('First review')
  assert.equal(f.runtime.store.get('evidence', first.id).status, 'refuted', 'the superseding claim refuted its predecessor')
  const verifiedOf = id => f.events('evidence/verified').filter(event => event.data.evidenceId === id).length
  const verdictsOf = id => f.events('evidence/verdict').filter(event => event.data.evidenceId === id).length
  const before = { verified: verifiedOf(first.id), refuted: f.refutations(first.id).length, verdicts: verdictsOf(first.id) }
  // F3-B at the first verdict too: the acceptance resolves supersession before
  // it verifies anything, so the predecessor is refuted once and never verified.
  assert.deepEqual(before, { verified: 0, refuted: 1, verdicts: 0 })
  assertBoardIsConsistent(f, 'after the first acceptance')

  // Dissent on the surviving claim returns the source for a second verdict.
  f.runtime.challenge(f.owner, f.mission.id, { evidenceId: revised.id, reason: 'A counterexample questions the revised claim', toolRunIds: [] })
  assert.equal(f.current(source.id).status, 'submitted')
  const second = await accept('Second review')

  const predecessor = f.runtime.store.get('evidence', first.id)
  assert.equal(predecessor.status, 'refuted', 'the refuted predecessor stays refuted')
  assert.equal(predecessor.refutedBy, revised.id)
  assert.equal(verifiedOf(first.id), before.verified, 'the second verdict does not verify the refuted claim again')
  assert.equal(f.refutations(first.id).length, before.refuted, 'nor refute it a second time')
  assert.equal(verdictsOf(first.id), before.verdicts, 'nor record a verdict row for it')
  assert.ok(f.events('evidence/verified').some(event => event.data.evidenceId === revised.id && event.data.verificationTaskId === second.id), 'the live claim is verified by the second verdict')
})

test('a chain of claims one acceptance supersedes is refuted link by link, and only its head is verified', async t => {
  const f = await fixture(t)
  const source = f.proposeSource('Implement with two revisions')
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  const first = await f.publishEvidence(claimed, 'The first attempt satisfies the claim')
  const second = await f.publishEvidence(claimed, 'The second attempt satisfies the claim', 'supported', [first.id])
  const third = await f.publishEvidence(claimed, 'The third attempt satisfies the claim', 'supported', [second.id])
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.proposeReview(source)
  const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Checks pass' })
  const verdictEvents = f.runtime.store.events(f.mission.id, 500).filter(event => ['evidence/verified', 'evidence/refuted'].includes(event.type))
  assert.deepEqual(verdictEvents.map(event => [event.type, event.data.evidenceId, event.data.refutedBy, event.data.reason]), [
    ['evidence/verified', third.id, undefined, undefined],
    ['evidence/refuted', second.id, third.id, `Superseded by verified evidence ${third.id}`],
    ['evidence/refuted', first.id, second.id, `Superseded by evidence ${second.id}, itself superseded by verified evidence ${third.id}`],
  ], 'the head is verified, then each claim it supersedes is refuted by the claim naming it, once')
  const row = claim => f.runtime.store.get('evidence', claim.id)
  assert.deepEqual([first, second, third].map(claim => [row(claim).status, row(claim).refutedBy]), [['refuted', second.id], ['refuted', third.id], ['verified', undefined]])
  assertBoardIsConsistent(f, 'after the chain was resolved')
  // A challenge of a link names the claim that refuted it, which a verdict
  // never verified for every link but the last, and moves the dispute to the
  // claim the acceptance did verify.
  const refusal = claim => {
    try { f.runtime.challenge(f.owner, f.mission.id, { evidenceId: claim.id, reason: 'Dispute a superseded link', toolRunIds: [] }) } catch (error) { return error }
    assert.fail(`a challenge of ${claim.id} is refused`)
  }
  for (const [link, by] of [[first, second], [second, third]]) {
    const { code, message } = refusal(link)
    assert.equal(code, 'evidence_not_judgeable')
    assert.ok(message.startsWith(`[evidence_not_judgeable] Evidence ${link.id} is refuted and superseded by evidence ${by.id}, so no verdict can judge it again`), message)
    assert.ok(!message.includes('verified'), `the refusal claims no verification of ${by.id}: ${message}`)
    assert.ok(message.endsWith(`a claim of task ${source.id} a verdict can still judge instead: ${third.id}.`), message)
  }
})

test('an inconclusive claim supersedes nothing: the claim it names is verified with it', async t => {
  const f = await fixture(t)
  const source = f.proposeSource('Implement with an inconclusive revision')
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  const first = await f.publishEvidence(claimed, 'The first attempt satisfies the claim')
  const unsure = await f.publishEvidence(claimed, 'The revision may not hold on every platform', 'inconclusive', [first.id])
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.proposeReview(source)
  const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Checks pass' })
  const row = claim => f.runtime.store.get('evidence', claim.id)
  assert.deepEqual([row(first).status, row(unsure).status], ['verified', 'unverified'], 'an inconclusive claim is never verified, so it refutes nothing')
  assert.deepEqual(f.refutations(first.id), [])
  assertBoardIsConsistent(f, 'after the inconclusive revision')
})

test('an inconclusive link passes no refutation on: a claim superseded only by an inconclusive claim is verified, and the inconclusive one is refuted by its own superseder', async t => {
  const f = await fixture(t)
  const source = f.proposeSource('Implement with an inconclusive link')
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  const first = await f.publishEvidence(claimed, 'The first attempt satisfies the claim')
  const unsure = await f.publishEvidence(claimed, 'The revision may not hold on every platform', 'inconclusive', [first.id])
  const settled = await f.publishEvidence(claimed, 'The final revision holds on every platform', 'supported', [unsure.id])
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.proposeReview(source)
  const claimedReview = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Checks pass' })
  const row = claim => f.runtime.store.get('evidence', claim.id)
  assert.deepEqual([first, unsure, settled].map(claim => [row(claim).status, row(claim).refutedBy]), [['verified', undefined], ['refuted', settled.id], ['verified', undefined]])
  assert.deepEqual(f.refutations(first.id), [], 'the verified claim is never refuted by the chain it heads')
  assert.equal(f.refutations(unsure.id).length, 1)
  assertBoardIsConsistent(f, 'after the chain with an inconclusive link')
})
