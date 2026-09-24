import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { validatePlan } from '../lib/plans.js'
import { FakeWorkers, SwarmRuntime, budget as sharedBudget, makeRuntime } from './faults/harness.mjs'

const budget = { ...sharedBudget, maxTokens: 100000, maxSteps: 100, maxWorkers: 2, maxDurationMs: 60000, maxTasks: 8 }
function plan(workspace = '/fixture') {
  return { title: 'Research', objective: 'Investigate the question', workspace, scope: ['**'], acceptance: ['question answered'], budget: { ...budget },
    members: [{ key: 'author', name: 'Author', role: 'research' }, { key: 'reviewer', name: 'Reviewer', role: 'verification' }],
    workstreams: [{ key: 'main', title: 'Research', objective: 'Investigate the question' }],
    tasks: [{ key: 'research', workstreamKey: 'main', title: 'Research', objective: 'Investigate the question', kind: 'research', outputs: [], scope: ['**'], acceptance: ['question answered'], assigneeKey: 'author' },
      { key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Review the answer', kind: 'verification', outputs: [], reviewOf: 'research', scope: ['**'], acceptance: ['question answered'], assigneeKey: 'reviewer' }] }
}

test('canonical plans preserve explicit and default ceiling origins through repeated validation', () => {
  const input = plan()
  input.tasks[0].maxSteps = 100 // An explicit choice equal to the fallback is still a choice.
  const canonical = validatePlan(input)
  assert.deepEqual(canonical.tasks[0].ceilingProvenance, {
    maxSteps: { source: 'agent', value: 100 }, maxFindings: { source: 'default', value: 50 },
  })
  assert.deepEqual(canonical.tasks[1].ceilingProvenance, {
    maxSteps: { source: 'default', value: 100 }, maxFindings: { source: 'default', value: 50 },
  })
  assert.deepEqual(validatePlan(JSON.parse(JSON.stringify(canonical))), canonical, 'saving and revalidating a plan must not recast fallback values as choices')
  assert.equal(input.tasks[0].ceilingProvenance, undefined, 'the caller draft remains unchanged')
  assert.equal(input.tasks[0].maxFindings, undefined)
})

test('editing a canonical ceiling updates its origin without relabeling unchanged defaults', () => {
  const canonical = validatePlan(plan())
  canonical.budget.maxSteps = 300
  canonical.tasks[0].maxFindings = 7
  const edited = validatePlan(canonical)
  assert.deepEqual(edited.tasks[0].ceilingProvenance, {
    maxSteps: { source: 'default', value: 100 }, maxFindings: { source: 'agent', value: 7 },
  }, 'raising the mission budget does not relabel a previously admitted fallback')
  assert.equal(edited.tasks[0].maxSteps, 100, 'revalidation preserves the saved effective ceiling')
  delete edited.tasks[0].maxSteps
  const defaultedAgain = validatePlan(edited)
  assert.equal(defaultedAgain.tasks[0].maxSteps, 150)
  assert.deepEqual(defaultedAgain.tasks[0].ceilingProvenance.maxSteps, { source: 'default', value: 150 })
})

test('invalid optional provenance is replaced without introducing an admission refusal', () => {
  const input = plan()
  input.tasks[0].maxSteps = 9
  input.tasks[0].ceilingProvenance = { maxSteps: { source: 'unknown', value: 9 }, maxFindings: { source: 'agent', value: 50 } }
  const canonical = validatePlan(input)
  assert.deepEqual(canonical.tasks[0].ceilingProvenance, {
    maxSteps: { source: 'agent', value: 9 }, maxFindings: { source: 'default', value: 50 },
  })
})

const workers = () => new FakeWorkers({ async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) } })
const config = { tickMs: 60000, maxMessageChars: 10000, maxEvents: 100, checkTimeoutMs: undefined }

test('draft launch and subsequent proposals durably retain ceiling provenance', async t => {
  // The reopened runtime is disposed first; makeRuntime's own cleanup then removes the state directory.
  t.after(async () => { await runtime.dispose() })
  let { dir: directory, config: settings, runtime } = await makeRuntime(t, { workers: workers(), config })
  const owner = { sessionId: 'owner' }
  const input = plan(directory)
  input.tasks[0].maxSteps = 17
  const draft = runtime.createDraft(owner, input)
  const canonical = validatePlan(draft.input)
  const launched = await runtime.launchDraft(owner, draft.id, draft.revision)
  const source = launched.tasks.find(task => task.kind === 'research')
  const expected = { maxSteps: { source: 'agent', value: 17 }, maxFindings: { source: 'default', value: 50 } }
  assert.deepEqual(canonical.tasks[0].ceilingProvenance, expected)
  assert.deepEqual(source.ceilingProvenance, expected, 'launch carries the canonical origin through propose')
  const proposed = runtime.propose(owner, launched.mission.id, { outputs: [], workstreamId: source.workstreamId,
    title: 'Follow-up', objective: 'Investigate a separate question', kind: 'research', scope: ['**'], acceptance: ['question answered'], maxFindings: 6 })
  const proposalExpected = { maxSteps: { source: 'default', value: 100 }, maxFindings: { source: 'agent', value: 6 } }
  assert.deepEqual(proposed.ceilingProvenance, proposalExpected)
  await runtime.dispose()
  runtime = new SwarmRuntime(settings, workers())
  assert.deepEqual(runtime.store.get('tasks', source.id).ceilingProvenance, expected)
  assert.deepEqual(runtime.store.get('tasks', proposed.id).ceilingProvenance, proposalExpected)
})

test('automatic worker proposals preserve inherited defaults and identify explicit overrides', async t => {
  const { dir: directory, runtime } = await makeRuntime(t, { workers: workers(), config })
  const owner = { sessionId: 'owner' }
  const input = plan(directory)
  for (const member of input.members) member.maxOutputTokens = 1000
  for (const task of input.tasks) task.maxRecoveryAttempts = 3
  const request = runtime.requestStart(owner, { commandId: 'research-command', goal: input.objective, workspace: directory })
  const launched = await runtime.startPlan(owner, request.id, input)
  const source = launched.tasks.find(task => task.kind === 'research')
  const author = launched.members.find(member => member.name === 'Author')
  const inherited = runtime.propose({ sessionId: author.sessionId }, launched.mission.id, { outputs: [], workstreamId: source.workstreamId,
    title: 'Related research', objective: 'Investigate a separate question', kind: 'research', dependencies: [source.id],
    scope: ['**'], acceptance: ['question answered'], maxFindings: 7 })
  assert.deepEqual(inherited.ceilingProvenance, {
    maxSteps: { source: 'default', value: 100 }, maxFindings: { source: 'agent', value: 7 },
  })
})
