import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { validatePlan } from '../lib/plans.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 60000, maxTasks: 12, maxExperiments: 2 }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function eventually(read) {
  const until = Date.now() + 2500
  while (Date.now() < until) { const result = read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail('Expected runtime transition did not occur')
}
class Workers {
  prepared = []
  starts = []
  delivered = []
  onStart = async () => {}
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, id) { this.prepared.push(id); return join(mission.workspace, id) }
  async start(spec) { this.starts.push(spec); await this.onStart(spec) }
  async prepareTask() {}
  async deliver(member, message) { this.delivered.push({ member, message }) }
  async stop() {}
  isIdle() { return true }
  async dispose() {}
}
function plan(workspace) {
  return { title: 'Editable plan', objective: 'Deliver verified code', workspace, scope: ['src/'], acceptance: ['works'], budget,
    members: [{ key: 'builder', name: 'Builder', role: 'implementation', provider: 'test-provider', model: 'model-2', reasoningEffort: 'off' },
      { key: 'reviewer', name: 'Reviewer', role: 'verification' }],
    workstreams: [{ key: 'main', title: 'Delivery', objective: 'Complete the change' }],
    // Deliberately put review first: the runtime must topologically admit it.
    tasks: [{ key: 'review', workstreamKey: 'main', title: 'Review', objective: 'Verify artifact', kind: 'verification',
      scope: ['src/'], acceptance: ['works'], assigneeKey: 'reviewer', reviewOf: 'code' },
    { key: 'code', workstreamKey: 'main', title: 'Deliver', objective: 'Implement change', kind: 'integration',
      scope: ['src/'], acceptance: ['works'], assigneeKey: 'builder', checks: ['node check.cjs'] }] }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-plans-'))
  const config = { statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 3 }
  const workers = new Workers(), runtime = new SwarmRuntime(config, workers)
  const owner = { sessionId: 'plan-owner' }
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { directory, config, workers, runtime, owner, input: plan(directory) }
}

test('draft edits are durable, optimistic and cannot consume workers before launch', async t => {
  const f = await fixture(t)
  const draft = f.runtime.createDraft(f.owner, f.input)
  assert.equal(f.workers.prepared.length, 0)
  assert.equal(f.runtime.list(f.owner.sessionId).length, 0)
  const edited = f.runtime.updateDraft(f.owner, draft.id, 1, { ...f.input, title: 'Reviewed plan' })
  assert.equal(edited.revision, 2)
  assert.equal(f.runtime.drafts(f.owner)[0].input.title, 'Reviewed plan')
  assert.throws(() => f.runtime.updateDraft(f.owner, draft.id, 1, f.input), /changed/)
  assert.throws(() => f.runtime.discardDraft({ sessionId: 'stranger' }, draft.id, 2), /owned/)
  f.runtime.discardDraft(f.owner, draft.id, 2)
  assert.deepEqual(f.runtime.drafts(f.owner), [])
  assert.equal(f.workers.starts.length, 0)
})

test('launch holds execution until roster and dependency/review topology are complete', async t => {
  const f = await fixture(t)
  const gate = deferred(), entered = deferred()
  f.workers.onStart = async spec => { if (spec.member.name === 'Reviewer') { entered.resolve(); await gate.promise } }
  const draft = f.runtime.createDraft(f.owner, f.input)
  const launch = f.runtime.launchDraft(f.owner, draft.id, draft.revision)
  await entered.promise
  const assembling = f.runtime.list(f.owner.sessionId)[0]
  assert.equal(assembling.status, 'staged')
  assert.equal(f.workers.delivered.length, 0)
  assert.throws(() => f.runtime.control(f.owner, assembling.id, 'resume', 'Try to bypass plan launch'), /saved plan launch/)
  gate.resolve()
  const snapshot = await launch
  assert.equal(snapshot.mission.status, 'active')
  assert.equal(snapshot.members.length, 2)
  assert.equal(snapshot.tasks.length, 2)
  const builder = snapshot.members.find(member => member.name === 'Builder')
  assert.equal(builder.provider, 'test-provider')
  assert.equal(builder.model, 'model-2')
  assert.equal(builder.reasoningEffort, 'off')
  const review = snapshot.tasks.find(task => task.kind === 'verification')
  assert.equal(review.reviewOf, snapshot.tasks.find(task => task.kind === 'integration').id)
  assert.deepEqual(review.dependencies, [])
  await eventually(() => f.workers.delivered.some(({ message }) => message.kind === 'assignment'))
  const duplicate = await f.runtime.launchDraft(f.owner, draft.id, draft.revision)
  assert.equal(duplicate.mission.id, snapshot.mission.id)
  assert.equal(f.workers.prepared.length, 2)
})

test('failed launch resumes existing admissions without duplicating workers or releasing partial work', async t => {
  const f = await fixture(t)
  let fail = true
  f.workers.onStart = async spec => { if (spec.member.name === 'Reviewer' && fail) throw new Error('Temporary worker start failure') }
  const draft = f.runtime.createDraft(f.owner, f.input)
  await assert.rejects(f.runtime.launchDraft(f.owner, draft.id, draft.revision), /Temporary worker/)
  const failed = f.runtime.drafts(f.owner)[0]
  assert.equal(failed.status, 'failed')
  assert.equal(f.runtime.list(f.owner.sessionId)[0].status, 'staged')
  assert.equal(f.workers.delivered.length, 0)
  assert.throws(() => f.runtime.updateDraft(f.owner, failed.id, failed.revision, f.input), /unlaunched/)
  fail = false
  const snapshot = await f.runtime.launchDraft(f.owner, failed.id, failed.revision)
  assert.equal(snapshot.members.length, 2)
  assert.equal(f.workers.prepared.length, 2)
  assert.equal(f.runtime.list(f.owner.sessionId).length, 1)
})

test('stopping during plan assembly prevents activation and retry cannot revive the stopped mission', async t => {
  const f = await fixture(t)
  const gate = deferred(), entered = deferred()
  f.workers.onStart = async spec => { if (spec.member.name === 'Reviewer') { entered.resolve(); await gate.promise } }
  const draft = f.runtime.createDraft(f.owner, f.input)
  const launch = f.runtime.launchDraft(f.owner, draft.id, draft.revision)
  const rejected = assert.rejects(launch, /stopped/)
  await entered.promise
  const mission = f.runtime.list(f.owner.sessionId)[0]
  f.runtime.control(f.owner, mission.id, 'stop', 'Cancel assembly')
  gate.resolve()
  await rejected
  const failed = f.runtime.drafts(f.owner)[0]
  assert.equal(failed.status, 'failed')
  assert.equal(f.runtime.list(f.owner.sessionId)[0].status, 'stopped')
  assert.equal(f.workers.delivered.filter(({ message }) => message.kind === 'assignment').length, 0)
  await assert.rejects(f.runtime.launchDraft(f.owner, failed.id, failed.revision), /cannot be launched/)
  const latest = f.runtime.drafts(f.owner)[0]
  f.runtime.discardDraft(f.owner, latest.id, latest.revision)
  assert.deepEqual(f.runtime.drafts(f.owner), [])
})

test('wire plans reject cycles, invalid references, self-review, scope escape and resource excess', () => {
  const base = plan('/workspace')
  for (const mutate of [
    p => { p.tasks[1].dependencies = ['review'] },
    p => { p.tasks[1].assigneeKey = 'missing' },
    p => { p.tasks[0].assigneeKey = 'builder' },
    p => { p.tasks[1].scope = ['../secret'] },
    p => { p.budget.maxWorkers = 1 },
    p => { p.tasks[1].checks = [] },
    p => { p.members[0].provider = {} },
    p => { p.tasks[1].reviewOf = 'review' },
  ]) { const candidate = structuredClone(base); mutate(candidate); assert.throws(() => validatePlan(candidate)) }
  const input = { ...base, authority: 'ignored' }
  input.members[0].subscriptions = ['*']
  const clean = validatePlan(input)
  assert.equal(clean.authority, undefined)
  assert.equal(clean.members[0].subscriptions, undefined)
})

test('equivalent scope notation and duplicate review edges canonicalize without mutating the supplied plan', async t => {
  const f = await fixture(t)
  f.input.scope = ['./src/**']
  f.input.tasks[0].scope = ['./src/']
  f.input.tasks[1].scope = ['./src/value.cjs']
  f.input.tasks.push({ key: 'preparation', workstreamKey: 'main', title: 'Inspect', objective: 'Inspect the repository',
    kind: 'research', scope: ['src/**'], acceptance: ['context recorded'], assigneeKey: 'builder' })
  f.input.tasks[0].dependencies = ['code', 'preparation', 'code']
  const before = structuredClone(f.input)
  const canonical = validatePlan(f.input)
  assert.deepEqual(canonical.scope, ['src/'])
  assert.deepEqual(canonical.tasks.map(task => task.scope), [['src/'], ['src/value.cjs'], ['src/']])
  assert.deepEqual(canonical.tasks[0].dependencies, ['preparation'])
  assert.equal(canonical.tasks[0].reviewOf, 'code')
  assert.deepEqual(canonical.acceptance, before.acceptance)
  assert.deepEqual(canonical.budget, before.budget)
  assert.deepEqual(f.input, before)
  const draft = f.runtime.createDraft(f.owner, f.input)
  assert.deepEqual(f.runtime.drafts(f.owner)[0].input, JSON.parse(JSON.stringify(canonical)))
  assert.deepEqual(draft.input.tasks[0].dependencies, ['preparation'])
  assert.equal(f.workers.starts.length, 0)
})

test('scope normalization never guesses root, absolute paths, traversal or extension globs', () => {
  for (const selector of ['.', './', './**', '/workspace/src/', '../src/', './src/../secret', 'src/*.ts', '**/*.ts']) {
    const input = plan('/workspace')
    input.scope = [selector]
    const before = structuredClone(input)
    assert.throws(() => validatePlan(input), /scope\[0\].*is invalid/)
    assert.deepEqual(input, before)
  }
  const input = plan('/workspace')
  input.tasks[1].scope = ['./src-other/**']
  assert.throws(() => validatePlan(input), /tasks\[1\]\.scope exceeds mission scope/)
})

test('scope and missing code checks are diagnosed together before any admission, then the same corrected plan saves', async t => {
  const f = await fixture(t)
  f.input.tasks[1].scope = ['lib/value.cjs']
  f.input.tasks[1].checks = []
  const before = structuredClone(f.input)
  assert.throws(() => f.runtime.createDraft(f.owner, f.input), error => {
    assert.match(error.message, /tasks\[1\]\.scope exceeds mission scope/)
    assert.match(error.message, /tasks\[1\]\.checks \(task "code"\)/)
    assert.match(error.message, /same task\/request/)
    assert.match(error.message, /read-only audit or report synthesis/)
    assert.match(error.message, /Never change a code deliverable to research/)
    return true
  })
  assert.deepEqual(f.runtime.drafts(f.owner), [])
  assert.deepEqual(f.runtime.list(f.owner.sessionId), [])
  assert.equal(f.workers.starts.length, 0)
  assert.deepEqual(f.input, before)
  f.input.tasks[1].scope = ['src/value.cjs']
  f.input.tasks[1].checks = ['node check.cjs']
  const admitted = f.runtime.createDraft(f.owner, f.input)
  assert.equal(admitted.input.tasks[1].kind, before.tasks[1].kind)
  assert.deepEqual(admitted.input.acceptance, before.acceptance)
  assert.deepEqual(admitted.input.budget, before.budget)
})

test('missing plan keys identify the exact field and explain how to repair references', () => {
  for (const field of ['members', 'workstreams', 'tasks']) {
    const input = plan('/workspace')
    const originalKey = input[field][0].key
    delete input[field][0].key
    assert.throws(() => validatePlan(input), error => {
      assert.ok(error.message.includes(`${field}[0].key is required`))
      assert.match(error.message, /unique stable identifier/)
      assert.match(error.message, /name\/title is not the identifier/)
      assert.ok(error.message.includes(field === 'tasks' ? 'dependencies and reviewOf' : field === 'members' ? 'assigneeKey' : 'workstreamKey'))
      return true
    })
    input[field][0].key = originalKey
    assert.equal(validatePlan(input)[field][0].key, originalKey)
  }
})

test('large valid topology is bounded by the primary-selected budget rather than a fixed entry ceiling', () => {
  const input = structuredClone(plan('/workspace'))
  const size = 201
  input.budget = { ...input.budget, maxWorkers: size, maxTasks: size * 2 }
  input.members = Array.from({ length: size }, (_, index) => ({
    key: `member_${index}`, name: `Member ${index}`, role: 'Research and independently review peers', maxOutputTokens: 4096,
  }))
  input.workstreams = Array.from({ length: size }, (_, index) => ({
    key: `stream_${index}`, title: `Research ${index}`, objective: `Resolve question ${index}`,
  }))
  input.tasks = input.workstreams.flatMap((stream, index) => {
    const source = { key: `source_${index}`, workstreamKey: stream.key, title: stream.title, objective: stream.objective,
      kind: 'research', scope: ['src/'], acceptance: ['works'], assigneeKey: `member_${index}`, maxRecoveryAttempts: 2 }
    return [source, { ...source, key: `review_${index}`, kind: 'verification', reviewOf: source.key,
      assigneeKey: `member_${(index + 1) % size}` }]
  })
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 1048576)
  const accepted = validatePlan(input)
  assert.deepEqual([accepted.members.length, accepted.workstreams.length, accepted.tasks.length], [201, 201, 402])
  assert.throws(() => validatePlan({ ...input, budget: { ...input.budget, maxWorkers: size - 1 } }), /Roster exceeds worker budget/)
  assert.throws(() => validatePlan({ ...input, budget: { ...input.budget, maxTasks: size * 2 - 1 } }), /Plan exceeds task\/workstream budget/)
})

test('scope errors report the offending path and allowed selectors so the primary can correct its plan', () => {
  const input = plan('/workspace')
  input.tasks[1].scope = ['lib/value.cjs']
  assert.throws(() => validatePlan(input), error => {
    assert.match(error.message, /tasks\[1\]\.scope/)
    assert.ok(error.message.includes('"lib/value.cjs"'))
    assert.ok(error.message.includes('["src/"]'))
    assert.match(error.message, /literal workspace-relative paths/)
    assert.match(error.message, /not descriptive prose/)
    return true
  })
  input.tasks[1].scope = ['src/value.cjs']
  assert.deepEqual(validatePlan(input).tasks[1].scope, ['src/value.cjs'])
  input.scope = ['**/*.cjs']
  assert.throws(() => validatePlan(input), /scope\[0\].*"\*\*\/\*\.cjs".*directory prefixes/)
})

test('a saved draft survives a cold host restart without an owner or worker process', async t => {
  const f = await fixture(t)
  const draft = f.runtime.createDraft(f.owner, f.input)
  await f.runtime.dispose()
  const workers = new Workers(), recovered = new SwarmRuntime(f.config, workers)
  try {
    await recovered.start()
    assert.equal(recovered.drafts(f.owner)[0].id, draft.id)
    assert.equal(workers.starts.length, 0)
    assert.deepEqual(recovered.visibleSnapshots({ sessionId: 'stranger' }), [])
  } finally { await recovered.dispose() }
})

test('interrupted assembly journals recover without duplicating prior admissions', async t => {
  const f = await fixture(t)
  f.workers.onStart = async spec => { if (spec.member.name === 'Reviewer') throw new Error('Interrupted before topology') }
  const draft = f.runtime.createDraft(f.owner, f.input)
  await assert.rejects(f.runtime.launchDraft(f.owner, draft.id, 1), /Interrupted/)
  const interrupted = f.runtime.drafts(f.owner)[0]
  interrupted.status = 'launching'
  delete interrupted.error
  f.runtime.store.transaction(() => f.runtime.store.put('drafts', interrupted))
  await f.runtime.dispose()
  const workers = new Workers(), recovered = new SwarmRuntime(f.config, workers)
  try {
    await recovered.start()
    const retained = recovered.drafts(f.owner)[0]
    assert.equal(retained.status, 'failed')
    assert.match(retained.error, /restarted/)
    assert.equal(workers.delivered.length, 0)
    const result = await recovered.launchDraft(f.owner, retained.id, retained.revision)
    assert.equal(result.members.length, 2)
    assert.equal(result.tasks.length, 2)
    assert.equal(workers.prepared.length, 0, 'durable member workspaces must not be admitted twice')
    assert.equal(recovered.list(f.owner.sessionId).length, 1)
  } finally { await recovered.dispose() }
})
