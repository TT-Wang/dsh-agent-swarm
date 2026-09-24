/**
 * The host owns review pairing. A plan names its deliverables; the one
 * independent review each needs is added by `pairReviews` (src/plans.ts)
 * unless the plan names one itself, on every launch path: `swarm_launch`
 * (`startPlan`), a staged draft (`createDraft`/`updateDraft`, so the editor
 * shows the row before launch) and `launchDraft`. The added review counts
 * against `maxTasks`, a source's nested `review` override supplies its
 * planner-chosen fields, and an authored review suppresses the synthesis.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { pairReviews, validatePlan } from '../lib/plans.js'
import { registerTools } from '../lib/tools.js'
import { DraftEditor } from '../lib/types/client/DraftEditor.js'
import { FakeClock, FakeWorkers, makeRuntime, makeRuntimeStub, taskOf } from './faults/harness.mjs'

class PairingWorkers extends FakeWorkers {
  checks = [{ command: 'node check.cjs', exitCode: 0, output: 'ok' }]
  async prepareWorkspace(mission, id) { return join(mission.workspace, id) }
}

const deliverable = extra => ({ key: 'deliver', workstreamKey: 'main', title: 'Deliver', objective: 'Implement the change', kind: 'implementation', outputs: [],
  scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'], maxRecoveryAttempts: 4, checkTimeoutMs: 45_000, priority: 70, ...extra })

function plan(workspace, { tasks = [deliverable()], maxTasks = 12 } = {}) {
  return {
    title: 'Paired delivery', objective: 'Deliver reviewed code', workspace, scope: ['src/'], acceptance: ['works'],
    budget: { maxTokens: 100_000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 3_600_000, maxTasks, maxExperiments: 0 },
    members: [{ key: 'builder', name: 'Builder', role: 'implementation', maxOutputTokens: 4096 }, { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    tasks,
  }
}

async function fixture(t) {
  const { dir, runtime, workers } = await makeRuntime(t, { clock: new FakeClock(), workers: new PairingWorkers(), config: { checkTimeoutMs: undefined } })
  const owner = { sessionId: 'pairing-owner' }
  let commands = 0
  // One owner session per launch: a session holds one running automatic request.
  const launch = input => {
    const session = { sessionId: `pairing-owner-${++commands}` }
    return runtime.startPlan(session, runtime.requestStart(session, { commandId: `command-${commands}`, goal: 'Deliver reviewed code', workspace: dir }).id, input)
  }
  const member = (snapshot, key) => snapshot.members.find(row => row.id.endsWith(`_${key}`))
  return { dir, runtime, workers, owner, launch, member }
}

const reviewsOf = (tasks, source) => tasks.filter(task => task.kind === 'verification' && task.reviewOf === source.id)

test('a launched plan with a deliverable and no review gets exactly one synthesized independent review that runs and gates acceptance', async t => {
  const f = await fixture(t)
  const snapshot = await f.launch(plan(f.dir))
  assert.equal(snapshot.mission.status, 'active')
  const source = snapshot.tasks.find(task => task.kind === 'implementation')
  const [review, ...extra] = reviewsOf(snapshot.tasks, source)
  assert.equal(extra.length, 0, 'exactly one review')
  assert.equal(snapshot.tasks.length, 2)
  assert.match(review.id, /_deliver-review$/)
  assert.equal(review.assigneeId, undefined, 'unassigned: any independent member may take it')
  assert.deepEqual(review.scope, source.scope)
  assert.deepEqual(review.acceptance, source.acceptance)
  assert.equal(review.checkTimeoutMs, source.checkTimeoutMs)
  assert.equal(review.maxRecoveryAttempts, source.maxRecoveryAttempts)
  assert.equal(review.priority, source.priority)
  assert.deepEqual(review.outputs, [])
  assert.equal(review.workstreamId, source.workstreamId)
  const draft = f.runtime.store.get('drafts', snapshot.mission.id.replace(/^mission_/, ''))
  assert.deepEqual(draft.input.tasks.map(task => task.key), ['deliver', 'deliver-review'], 'the saved plan carries the synthesized row')

  const builder = f.member(snapshot, 'builder'), reviewer = f.member(snapshot, 'reviewer')
  const claimed = await f.runtime.claim({ sessionId: builder.sessionId }, snapshot.mission.id, source.id)
  await f.runtime.submit({ sessionId: builder.sessionId }, snapshot.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  assert.equal(taskOf(f.runtime, source.id).status, 'submitted', 'submission alone does not accept the deliverable')
  await assert.rejects(f.runtime.claim({ sessionId: builder.sessionId }, snapshot.mission.id, review.id), /authored review source/, 'the author cannot take its own review')
  const reviewing = await f.runtime.claim({ sessionId: reviewer.sessionId }, snapshot.mission.id, review.id)
  await f.runtime.verify({ sessionId: reviewer.sessionId }, snapshot.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'accept', reason: 'Independent host checks pass on the artifact' })
  assert.equal(taskOf(f.runtime, review.id).status, 'accepted')
  assert.equal(taskOf(f.runtime, source.id).status, 'accepted', 'the synthesized review\'s verdict accepts the deliverable')
})

test('a nested review override on the deliverable is honoured and consumed', async t => {
  const f = await fixture(t)
  const override = { assigneeKey: 'reviewer', objective: 'Re-run the reproduction from your own attempt', acceptance: ['works', 'reproduced independently'], maxSteps: 7, maxRecoveryAttempts: 2 }
  const snapshot = await f.launch(plan(f.dir, { tasks: [deliverable({ review: override })] }))
  const source = snapshot.tasks.find(task => task.kind === 'implementation')
  const [review, ...extra] = reviewsOf(snapshot.tasks, source)
  assert.equal(extra.length, 0)
  assert.equal(review.assigneeId, f.member(snapshot, 'reviewer').id)
  assert.equal(review.assignmentMode, 'preferred', 'an automatic plan\'s assignee is a preference, as on an authored row')
  assert.equal(review.objective, override.objective)
  assert.deepEqual(review.acceptance, override.acceptance)
  assert.equal(review.maxSteps, 7)
  assert.equal(review.ceilingProvenance.maxSteps.source, 'agent')
  assert.equal(review.maxRecoveryAttempts, 2)
  assert.deepEqual(review.scope, source.scope, 'fields the override leaves out still derive from the source')
  assert.equal(review.checkTimeoutMs, source.checkTimeoutMs)
  const draft = f.runtime.store.get('drafts', snapshot.mission.id.replace(/^mission_/, ''))
  assert.equal(draft.input.tasks[0].review, undefined, 'the override is consumed into the review row')
})

test('a review override is refused where it cannot apply, with a coded exit', () => {
  const refused = (tasks, code, pattern) => assert.throws(() => validatePlan(plan('/workspace', { tasks }), { launch: true }), error => {
    assert.equal(error.code, code); assert.match(error.message, pattern); return true
  })
  refused([deliverable({ review: { assigneeKey: 'builder' } })], 'plan_review_independence_required', /^\[plan_review_independence_required\] tasks\[0\] \(deliver\)\.review\.assigneeKey names this task's own assignee/)
  refused([deliverable({ review: { assigneeKey: 'nobody' } })], 'plan_review_override_invalid', /review\.assigneeKey must name an existing member key/)
  refused([deliverable({ review: { maxSteps: 101 } })], 'plan_review_override_invalid', /review\.maxSteps must be a positive safe integer no greater than the mission `maxSteps` budget/)
  refused([deliverable({ review: { maxRecoveryAttempts: 0 } })], 'plan_review_override_invalid', /review\.maxRecoveryAttempts must be a positive safe integer/)
  const named = { key: 'check', workstreamKey: 'main', title: 'Check', objective: 'Verify', kind: 'verification', outputs: [], scope: ['src/'], acceptance: ['works'], reviewOf: 'deliver', maxRecoveryAttempts: 2 }
  refused([deliverable({ review: { objective: 'Mine' } }), named], 'plan_review_override_invalid', /already names this task in `reviewOf`/)
  refused([deliverable(), { ...named, review: { objective: 'Mine' } }], 'plan_review_override_invalid', /belongs on the deliverable a verification reviews/)
})

test('pairing is stable: revalidating or re-pairing a paired plan changes nothing', () => {
  const taken = deliverable({ key: 'deliver', review: { objective: 'Mine' } })
  const clash = { ...deliverable(), key: 'deliver-review', title: 'A deliverable that already holds the natural key', review: undefined }
  const paired = pairReviews(validatePlan(plan('/workspace', { tasks: [taken, clash] }), { launch: true }))
  assert.deepEqual(paired.tasks.map(task => [task.key, task.reviewOf ?? null]), [['deliver', null], ['deliver-review2', 'deliver'], ['deliver-review', null], ['deliver-review-review', 'deliver-review']])
  const json = JSON.stringify(paired)
  assert.equal(JSON.stringify(validatePlan(paired, { launch: true })), json, 'the added rows are canonical admitted rows')
  assert.equal(JSON.stringify(pairReviews(validatePlan(paired, { launch: true }))), json, 'a paired plan gains nothing more')
})

test('an explicit review suppresses synthesis, assigned or not', async t => {
  const f = await fixture(t)
  const authored = { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify the immutable artifact', kind: 'verification', outputs: [], scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'deliver', maxRecoveryAttempts: 5 }
  const assigned = await f.launch(plan(f.dir, { tasks: [deliverable(), authored] }))
  assert.deepEqual(assigned.tasks.map(task => task.id.slice(task.id.lastIndexOf('_') + 1)).sort(), ['deliver', 'review'], 'exactly the authored rows')
  const { assigneeKey: _assignee, ...unassigned } = authored
  const open = await f.launch(plan(f.dir, { tasks: [{ ...deliverable(), key: 'deliver' }, unassigned] }))
  const source = open.tasks.find(task => task.kind === 'implementation')
  const [review, ...extra] = reviewsOf(open.tasks, source)
  assert.equal(extra.length, 0, 'an unassigned authored review is not doubled')
  assert.equal(review.objective, 'Verify the immutable artifact')
  assert.equal(review.assigneeId, undefined)
})

test('the synthesized review counts against maxTasks at launch', async t => {
  const f = await fixture(t)
  await assert.rejects(f.launch(plan(f.dir, { maxTasks: 1 })), error => {
    assert.equal(error.code, 'plan_tasks_exceed_budget')
    assert.match(error.message, /^\[plan_tasks_exceed_budget\] The plan needs 2 tasks, including 1 independent review\(s\) the host adds .* but `maxTasks` is 1\. Raise `maxTasks` in `budget` to at least 2/)
    return true
  })
  const snapshot = await f.launch(plan(f.dir, { maxTasks: 2 }))
  assert.equal(snapshot.tasks.length, 2)
  assert.equal(snapshot.mission.budget.maxTasks, 2)
})

test('a staged draft shows the synthesized review in the editor before launch, and launches it', async t => {
  const f = await fixture(t)
  const { members: _members, ...rest } = plan(f.dir)
  const staged = { ...rest, members: plan(f.dir).members.map(({ maxOutputTokens: _tokens, ...member }) => member) }
  const draft = f.runtime.createDraft(f.owner, staged)
  const row = draft.input.tasks.find(task => task.kind === 'verification')
  assert.deepEqual({ key: row.key, reviewOf: row.reviewOf, assigneeKey: row.assigneeKey }, { key: 'deliver-review', reviewOf: 'deliver', assigneeKey: undefined })
  const editor = renderToStaticMarkup(React.createElement(DraftEditor, { sessionId: f.owner.sessionId, workspace: f.dir, budget: draft.input.budget, draft,
    request: async () => ({}), onSaved() {}, onLaunched() {}, onDiscarded() {} }))
  assert.match(editor, /<summary>Independent review of Deliver · verification<\/summary>/, 'the editor lists it like an authored review')
  const withoutRow = f.runtime.updateDraft(f.owner, draft.id, draft.revision, { ...draft.input, tasks: draft.input.tasks.filter(task => task.kind !== 'verification') })
  assert.equal(withoutRow.input.tasks.filter(task => task.kind === 'verification').length, 1, 'a saved edit that drops it gets it back')
  const launched = await f.runtime.launchDraft(f.owner, withoutRow.id, withoutRow.revision)
  const source = launched.tasks.find(task => task.kind === 'implementation')
  assert.equal(reviewsOf(launched.tasks, source).length, 1)
})

test('swarm_stage and swarm_launch declare the review override, and the registered launch forwards it', async () => {
  const definitions = new Map(), launched = []
  const runtime = makeRuntimeStub({
    config: {}, starts: () => [{ id: 'request', workspace: '/workspace' }], snapshot: () => ({ mission: { id: 'mission' } }),
    async startPlan(_actor, requestId, input) { launched.push(input); return { mission: { id: 'mission' } } },
  })
  const budget = plan('/workspace').budget
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, runtime, budget)
  for (const name of ['swarm_stage', 'swarm_launch']) {
    const review = definitions.get(name).parameters.properties.tasks.items.properties.review
    assert.equal(review.type, 'object', name)
    assert.equal(review.additionalProperties, false, name)
    assert.deepEqual(Object.keys(review.properties), ['assigneeKey', 'objective', 'acceptance', 'maxSteps', 'maxRecoveryAttempts'], name)
  }
  const execution = { agent: { id: 'owner' }, signal: new AbortController().signal }
  const { workspace: _workspace, ...input } = plan('/workspace', { tasks: [deliverable({ review: { assigneeKey: 'reviewer', maxRecoveryAttempts: 2 } })] })
  await definitions.get('swarm_launch').execute({ ...input, requestId: 'request' }, execution)
  assert.deepEqual(launched[0].tasks[0].review, { assigneeKey: 'reviewer', maxRecoveryAttempts: 2 }, 'the override reaches the launch intact')
  const unknown = plan('/workspace', { tasks: [deliverable({ review: { reviewer: 'reviewer' } })] })
  await assert.rejects(definitions.get('swarm_launch').execute({ ...unknown, requestId: 'request' }, execution), /\[tool_arguments_invalid\]/)
})
