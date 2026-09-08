/** Public runtime regressions for pre-existing dependency edges across independently accepted repairs. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function eventually(read, message) {
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}
class RepairWorkers {
  prepared = []
  stopped = []
  idle = new Set()
  prepare = async () => {}
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return path.join(mission.workspace, memberId) }
  async start() {}
  async deliver() {}
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle(memberId) { return this.idle.has(memberId) }
  async prepareTask(member, task, dependencies, reviewSource) {
    this.prepared.push(structuredClone({ member, task, dependencies, reviewSource }))
    await this.prepare(member, task, dependencies, reviewSource)
  }
  async captureArtifact(member, task) {
    return { commit: createHash('sha1').update(task.id).digest('hex'), baseCommit: 'b'.repeat(40), workspace: member.workspace, changedPaths: ['src/a.ts'] }
  }
  async verifyArtifact() { return [{ command: 'test', exitCode: 0, output: 'ok' }] }
  async dispose() {}
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'swarm-replacement-dependencies-'))
  const workers = new RepairWorkers()
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 100 }, workers)
  const owner = { sessionId: 'replacement-owner' }
  const mission = runtime.create(owner, { title: 'Repair existing plan', objective: 'Preserve accepted replacement obligations', workspace: directory,
    scope: ['src/'], acceptance: ['done'], budget: { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 10 } })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const integrator = await runtime.addMember(owner, mission.id, { name: 'Integrator', role: 'integration' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Complete the original graph' })
  const actor = member => ({ sessionId: member.sessionId })
  const propose = (title, extra = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title, objective: title,
    kind: 'implementation', assigneeId: author.id, scope: ['src/'], acceptance: ['done'], checks: ['test'], ...extra })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const integration = dependencies => propose('Existing integration', { kind: 'integration', assigneeId: integrator.id, dependencies: dependencies.map(task => task.id) })
  async function submit(task) {
    const claimed = await runtime.claim(actor(author), mission.id, task.id)
    await workers.callbacks.toolRun(author.id, { tool: 'bash', arguments: { command: 'test' }, result: { exitCode: 0 }, isError: false })
    const run = runtime.observe(actor(author), mission.id).toolRuns.find(run => run.taskId === task.id && run.attemptId === claimed.attempt.id)
    assert.ok(run, 'submission evidence uses a real adapter-recorded execution')
    runtime.publish(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, claim: 'Candidate behavior checked', outcome: 'supported', toolRunIds: [run.id] })
    return runtime.submit(actor(author), mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'Candidate artifact' })
  }
  async function review(task, verdict = 'accept') {
    const reviewTask = propose(`Review ${task.title}`, { kind: 'verification', assigneeId: reviewer.id, reviewOf: task.id, checks: [] })
    const claimed = await runtime.claim(actor(reviewer), mission.id, reviewTask.id)
    await runtime.verify(actor(reviewer), mission.id, { taskId: reviewTask.id, attemptId: claimed.attempt.id, verdict, reason: 'Independent review of this exact artifact' })
    return current(reviewTask)
  }
  const accept = async task => { await submit(task); await review(task); return current(task) }
  const reject = async task => { await submit(task); await review(task, 'reject'); return current(task) }
  const challenge = task => runtime.challenge(owner, mission.id, { evidenceId: current(task).evidenceIds[0], reason: 'A counterexample invalidates the accepted prerequisite', toolRunIds: [] })
  const preparedFor = task => workers.prepared.filter(call => call.task.id === task.id)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  return { runtime, workers, owner, mission, author, reviewer, integrator, actor, propose, current, integration, submit, review, accept, reject, challenge, preparedFor }
}

test('four accepted replacements unblock an existing integration and prepare their exact artifacts', async t => {
  const f = await fixture(t)
  const originals = Array.from({ length: 4 }, (_, index) => f.propose(`Original implementation ${index + 1}`))
  const integration = f.integration(originals)
  f.workers.idle.add(f.integrator.id)
  for (const original of originals) await f.reject(original)
  const replacements = originals.map((original, index) => f.propose(`Repair ${index + 1}`, { replaces: [original.id] }))
  for (const replacement of replacements.slice(0, -1)) await f.accept(replacement)
  await f.submit(replacements.at(-1))
  assert.equal(f.current(integration).status, 'pending', 'submission alone never substitutes for independent acceptance')
  assert.equal(f.preparedFor(integration).length, 0, 'workspace preparation waits for every accepted obligation')
  await f.review(replacements.at(-1))
  const running = await eventually(() => { const task = f.current(integration); return task.status === 'running' ? task : undefined }, 'existing integration remained pending after all four repairs were accepted')
  const prepared = f.preparedFor(integration).at(-1)
  assert.deepEqual(prepared.dependencies.map(task => task.id), replacements.map(task => task.id))
  assert.deepEqual(prepared.dependencies.map(task => task.artifact.commit), replacements.map(task => f.current(task).artifact.commit))
  assert.ok(originals.every(task => f.current(task).status === 'cancelled'))
  assert.equal(f.workers.callbacks.guard(f.integrator.id, 'write_file'), undefined, 'effective accepted prerequisites preserve tool authority')
  const submitted = await f.runtime.submit(f.actor(f.integrator), f.mission.id, { taskId: integration.id, attemptId: running.attempt.id, output: 'Integrated all repaired artifacts' })
  assert.equal(submitted.status, 'submitted', 'own-attempt validation resolves the same accepted prerequisites as scheduling')
})

test('explicit self-claim resolves the replacement artifact for a dependency created before rejection', async t => {
  const f = await fixture(t)
  const original = f.propose('Original implementation')
  const integration = f.integration([original])
  await f.reject(original)
  const replacement = f.propose('Replacement implementation', { replaces: [original.id] })
  await f.submit(replacement)
  await assert.rejects(f.runtime.claim(f.actor(f.integrator), f.mission.id, integration.id), /not ready/)
  await f.review(replacement)
  const claimed = await f.runtime.claim(f.actor(f.integrator), f.mission.id, integration.id)
  assert.equal(claimed.status, 'running')
  const { dependencies } = f.preparedFor(integration).at(-1)
  assert.deepEqual(dependencies.map(task => task.id), [replacement.id])
  assert.notEqual(dependencies[0].artifact.commit, f.current(original).artifact.commit)
})

test('replacement resolution follows a cancelled original through a later independently repaired replacement', async t => {
  const f = await fixture(t)
  const original = f.propose('Original implementation')
  const integration = f.integration([original])
  await f.reject(original)
  const first = f.propose('First repair', { replaces: [original.id] })
  await f.accept(first)
  f.challenge(first)
  await f.review(first, 'reject')
  const second = f.propose('Repair the repair', { replaces: [first.id] })
  await f.submit(second)
  await assert.rejects(f.runtime.claim(f.actor(f.integrator), f.mission.id, integration.id), /not ready/)
  await f.review(second)
  await f.runtime.claim(f.actor(f.integrator), f.mission.id, integration.id)
  assert.deepEqual(f.preparedFor(integration).at(-1).dependencies.map(task => task.id), [second.id])
  assert.equal(f.current(first).status, 'cancelled')
})

test('one accepted replacement for multiple original dependencies is prepared only once', async t => {
  const f = await fixture(t)
  const originals = [f.propose('First original'), f.propose('Second original')]
  const integration = f.integration(originals)
  for (const original of originals) await f.reject(original)
  const replacement = f.propose('Unified repair', { replaces: originals.map(task => task.id) })
  await f.accept(replacement)
  await f.runtime.claim(f.actor(f.integrator), f.mission.id, integration.id)
  assert.deepEqual(f.preparedFor(integration).at(-1).dependencies.map(task => task.id), [replacement.id], 'cherry-pick inputs must not repeat a shared accepted artifact')
})

test('ambiguous persisted accepted replacements fail closed instead of choosing an arbitrary artifact', async t => {
  const f = await fixture(t)
  const original = f.propose('Original implementation')
  const integration = f.integration([original])
  await f.reject(original)
  const first = f.propose('First candidate', { replaces: [original.id] })
  const second = f.propose('Second candidate', { replaces: [original.id] })
  await f.accept(first)
  await f.submit(second)
  // Historical or imported state can contain conflicting terminal candidates.
  // Normal current admission is intentionally not bypassed for the other tests.
  const ambiguous = f.current(second)
  ambiguous.status = 'accepted'
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', ambiguous))
  await assert.rejects(f.runtime.claim(f.actor(f.integrator), f.mission.id, integration.id), /not ready|ambiguous|replacement/i)
  assert.equal(f.preparedFor(integration).length, 0, 'ambiguity must be resolved before any workspace effect')
  assert.equal(f.current(integration).status, 'pending')
})

test('challenging an accepted replacement prevents a pending old dependency from being claimed', async t => {
  const f = await fixture(t)
  const original = f.propose('Original implementation')
  const integration = f.integration([original])
  await f.reject(original)
  const replacement = f.propose('Replacement implementation', { replaces: [original.id] })
  await f.accept(replacement)
  f.challenge(replacement)
  await assert.rejects(f.runtime.claim(f.actor(f.integrator), f.mission.id, integration.id), /not ready/)
  assert.equal(f.preparedFor(integration).length, 0)
})

test('challenging a replacement fences a running descendant whose stored dependency names the old task', async t => {
  const f = await fixture(t)
  const original = f.propose('Original implementation')
  const integration = f.integration([original])
  await f.reject(original)
  const replacement = f.propose('Replacement implementation', { replaces: [original.id] })
  await f.accept(replacement)
  const running = await f.runtime.claim(f.actor(f.integrator), f.mission.id, integration.id)
  f.challenge(replacement)
  assert.notEqual(f.current(integration).status, 'running', 'replacement challenges must invalidate semantic descendants')
  assert.notEqual(f.workers.callbacks.guard(f.integrator.id, 'write_file'), undefined)
  await assert.rejects(f.runtime.submit(f.actor(f.integrator), f.mission.id, { taskId: integration.id, attemptId: running.attempt.id, output: 'Stale integrated artifact' }), /Stale|prerequisite|invalidated/i)
  await eventually(() => f.workers.stopped.includes(f.integrator.id), 'invalidated descendant worker was not stopped')
})

test('a replacement challenge during preparation cannot dispatch an integration with obsolete trust', async t => {
  const f = await fixture(t)
  const original = f.propose('Original implementation')
  const integration = f.integration([original])
  await f.reject(original)
  const replacement = f.propose('Replacement implementation', { replaces: [original.id] })
  await f.accept(replacement)
  const entered = deferred(), release = deferred()
  f.workers.prepare = async (_member, task) => { if (task.id === integration.id) { entered.resolve(); await release.promise } }
  const claiming = f.runtime.claim(f.actor(f.integrator), f.mission.id, integration.id).then(result => ({ result }), error => ({ error }))
  assert.equal(await Promise.race([entered.promise.then(() => true), claiming.then(() => false)]), true, 'accepted replacement should reach workspace preparation')
  try { f.challenge(replacement) } finally { release.resolve() }
  const outcome = await claiming
  assert.ok(outcome.error, 'dispatch must recheck effective dependency trust after workspace preparation')
  assert.notEqual(f.current(integration).status, 'running')
})

test('accepting a replacement never silently retargets an old verification reviewOf edge', async t => {
  const f = await fixture(t)
  const original = f.propose('Original implementation')
  const oldReview = f.propose('Still-pending review of the original artifact', { kind: 'verification', assigneeId: f.reviewer.id, reviewOf: original.id, checks: [] })
  await f.reject(original)
  const replacement = f.propose('Replacement implementation', { replaces: [original.id] })
  await f.accept(replacement)
  assert.equal(f.current(oldReview).reviewOf, original.id, 'a review refers to one exact source artifact')
  await assert.rejects(f.runtime.claim(f.actor(f.reviewer), f.mission.id, oldReview.id), /not ready/)
  assert.equal(f.preparedFor(oldReview).length, 0, 'the old verifier cannot be dispatched against a different artifact')
})
