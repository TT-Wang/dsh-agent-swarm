/**
 * F1 — an in-flight operation that records nothing beyond its declared bound
 * escalates: a durable witness (the no-silent-state W2 row plus the durable
 * owner delivery) and an owner notice naming the member, the task, the tool
 * and the elapsed time, and the operation stops counting as lease liveness so
 * the existing expiry path frees the attempt. The lease-renewal rule is kept:
 * inside the bound a live operation still renews.
 *
 * The bound applies to operations that declare no end of their own — a model
 * stream and a tool call. A declared check is explicitly NOT judged by it: the
 * adapter reports ONE `verification` activity for the whole `verifyArtifact`
 * call (queue wait plus check), so the runtime cannot see where the check
 * begins, and the wait is bounded by other checks' declared timeouts rather
 * than by anything this attempt declares. Both halves are pinned below against
 * a real `Workspaces` check semaphore — a running check and a queued check —
 * because a wall-clock bound there escalated a healthy in-bound check and a
 * verification that had not yet started (F1v D1/D2).
 *
 * F3 — each member composes its own scratch root; TMPDIR is scoped to the
 * mission and member at composition time, and the declared-check environment
 * resolves per member even while two verifications run at once.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SwarmRuntime } from '../lib/runtime.js'
import { HarnessWorkers, ScopedEnvironment, assertCompositionScratch } from '../lib/harness-workers.js'
import { Workspaces, runProcess } from '../lib/workspaces.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 2 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const eventually = async (read, message, timeoutMs = 3000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) { const value = read(); if (value) return value; await sleep(5) }
  assert.fail(message)
}

/**
 * F1rv: a declared check that CANNOT finish until the test creates its sentinel
 * file. The F1 pair tests used a fixed `sleep 0.6` as the hold, so "the check is
 * still running" raced the test's own assertions and failed under full-suite
 * load; a longer sleep is the same race with a bigger constant. The hold makes
 * the observation structural: the test writes the sentinel only after every
 * queue, lease and escalation assertion has run, and the host check timeout
 * (30 s in the fixture) is comfortably above the test's own duration.
 */
const sentinelHold = sentinel => `until [ -f '${sentinel}' ]; do sleep 0.05; done`

/** The only external boundary the runtime talks to; every host operation is controlled by the test. */
class Workers {
  activities = new Map()
  stopped = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, id) { return `/isolated/${id}` }
  async start() {}
  async deliver() {}
  async stop(id) { this.stopped.push(id) }
  isIdle() { return false }
  async captureArtifact() { return { commit: 'c', baseCommit: 'b', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  currentActivity(memberId) { return this.activities.get(memberId) }
  async dispose() {}
}

async function fixture(t, config, taskInput = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-operation-bound-'))
  const workers = new Workers()
  const runtime = new SwarmRuntime({ statePath: join(directory, 'db.sqlite'), leaseMs: 400, tickMs: 10, maxMessageChars: 16000, maxEvents: 200, maxTasksPerMember: 3, ...config }, workers)
  await runtime.start()
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner-session' }
  const mission = runtime.create(owner, { title: 'Bound', objective: 'Escalate a silent operation', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Bound the operation' })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const actor = { sessionId: member.sessionId }
  const task = runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Stuck call', objective: 'Hold one operation', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test'], assigneeId: member.id, ...taskInput })
  await runtime.claim(actor, mission.id, task.id)
  return { directory, workers, runtime, owner, mission, member, task }
}

/** The durable owner escalations this guard records, in order. */
const silentEscalations = (runtime, missionId) => runtime.store.list('deliveries', missionId)
  .filter(delivery => delivery.to === 'owner' && typeof delivery.notice?.dedupKey === 'string' && delivery.notice.dedupKey.startsWith('operation-silent:'))

/**
 * A real check-semaphore fixture: one check slot, `members` prepared member
 * worktrees over one real git repository, and a check the caller controls (the
 * F1 pair tests pass `sentinelHold`, so the semaphore state `active` / `queued`
 * / `maxWaitMs` is observable for exactly as long as the test needs it). The
 * declared-check path is what the F1 bound must leave alone, so the pair tests
 * exercise the engine itself rather than a stub.
 */
async function realCheckFixture(t, members = 2, checkCommand = 'sleep 0.6') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swarm-operation-bound-checks-')))
  const source = join(root, 'source')
  await mkdir(join(source, 'src'), { recursive: true })
  const git = async (...args) => {
    const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd: source, timeoutMs: 30000, maxBytes: 100000 })
    assert.equal(result.exitCode, 0, result.output)
    return result.output.trim()
  }
  await git('init', '-b', 'main')
  await writeFile(join(source, 'src', 'answer.txt'), 'base\n')
  await git('add', '.')
  await git('commit', '-m', 'fixture baseline')
  const workspaces = new Workspaces({ workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000,
    checkConcurrency: 1, confineCheck: argv => argv })
  t.after(async () => { await workspaces.dispose(); await rm(root, { recursive: true, force: true }) })
  const mission = { id: 'mission-operation-bound-checks', workspace: source }
  const prepared = []
  for (let index = 0; index < members; index += 1) {
    const member = { id: `check-member-${index}`, missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, `check-member-${index}`) }
    const task = { id: `check-task-${index}`, missionId: mission.id, epoch: 1, title: 'Check', kind: 'implementation', scope: ['**'], checks: [], status: 'running' }
    await workspaces.prepareTask(member, task, [])
    await mkdir(join(member.workspace, 'src'), { recursive: true })
    await writeFile(join(member.workspace, 'src', 'answer.txt'), `answer ${index}\n`)
    prepared.push({ member, task: { ...task, checks: [checkCommand] }, artifact: await workspaces.captureArtifact(member, task) })
  }
  return { workspaces, prepared }
}

test('F1: a silent in-flight operation escalates with a durable witness naming member, task, tool and elapsed time', async t => {
  const f = await fixture(t, { operationBoundMs: 50 })
  const { runtime, workers, member, task, mission } = f
  const startedAt = Date.now() - 5000
  const activity = { id: 'op-stuck', kind: 'tool', tool: 'job_output', startedAt, updatedAt: Date.now() }
  workers.activities.set(member.id, activity)
  workers.callbacks.activity(member.id, activity)

  const escalation = await eventually(() => silentEscalations(runtime, mission.id)[0], 'a silent operation past the bound must escalate')
  assert.equal(escalation.from, 'runtime')
  assert.equal(escalation.to, 'owner')
  assert.equal(escalation.notice.class, 'stall')
  assert.equal(escalation.notice.sentAt > 0, true)
  for (const needle of [member.name, member.id, task.id, task.title, 'job_output', 'without recording anything', 'operationBoundMs', 'swarm_cancel', 'swarm_observe']) {
    assert.ok(escalation.content.includes(needle), `the owner notice must name ${needle}: ${escalation.content}`)
  }
  assert.match(escalation.content, /for \d+m? ?\d*s \(\d+ms\)/, 'the notice states the elapsed time')
  assert.match(escalation.content, new RegExp(`\\[witness: activity op-stuck, kind tool, tool job_output, attempt attempt_[^,]+, startedAt ${startedAt}, lastRecordedAt 0, elapsedMs \\d+, boundMs 50\\]`), 'the durable record carries the operation identity, the tool and the elapsed silence')

  // The no-silent-state witness: durable on the mission row, for the board the
  // notice was emitted for.
  const witness = runtime.store.get('missions', mission.id).witness
  assert.equal(witness?.kind, 'W2')
  assert.equal(typeof witness.fingerprint, 'string')
  assert.ok(witness.at >= escalation.createdAt - 1000 && witness.at <= escalation.createdAt + 1000, 'the witness and the notice describe the same state')

  // The board-level stall notice stays silent: a named in-flight operation is
  // the whole story, and `stalled` must not claim the board while it holds a
  // running attempt. This is the pair with the stall detector.
  assert.equal(runtime.store.events(mission.id, 500).some(event => event.type === 'mission/stalled'), false, 'no board stall while the named operation holds the attempt')
})

test('F1: the same silence never repeats, and the attempt stops being renewed until the lease expires', async t => {
  const f = await fixture(t, { operationBoundMs: 50 })
  const { runtime, workers, member, task, mission } = f
  const activity = { id: 'op-stuck', kind: 'tool', tool: 'job_output', startedAt: Date.now() - 5000, updatedAt: Date.now() }
  workers.activities.set(member.id, activity)
  workers.callbacks.activity(member.id, activity)
  await eventually(() => silentEscalations(runtime, mission.id)[0], 'the silent operation must escalate')

  // Many passes with the same silence: one witness, one notice (no repeat).
  await sleep(150)
  assert.equal(silentEscalations(runtime, mission.id).length, 1, 'an unchanged silence must not repeat')
  assert.equal(new Set(silentEscalations(runtime, mission.id).map(delivery => delivery.notice.dedupKey)).size, 1)

  // Pair with lease expiry: the operation no longer renews the lease, so the
  // existing recovery path fires and the stuck worker is stopped.
  const expired = await eventually(() => runtime.store.events(mission.id, 500).find(event => event.type === 'task/lease-expired'), 'the lease must expire once the operation stops counting as liveness')
  assert.equal(expired.data.oldOwner, member.id)
  assert.notEqual(runtime.store.get('tasks', task.id).status, 'running')
  assert.ok(workers.stopped.includes(member.id), 'the stuck worker is actually stopped')
})

test('F1: a bounded operation that is still progressing neither escalates nor loses its lease renewal', async t => {
  const f = await fixture(t, { operationBoundMs: 60000 })
  const { runtime, workers, member, task, mission } = f
  const activity = { id: 'op-live', kind: 'tool', tool: 'bash', startedAt: Date.now(), updatedAt: Date.now() }
  workers.activities.set(member.id, activity)
  workers.callbacks.activity(member.id, activity)

  // Shorten the stored lease so a renewal is observable, exactly as the lease
  // liveness test does: the renewal rule for a bounded operation is unchanged.
  const before = Date.now()
  const stored = runtime.store.get('tasks', task.id)
  stored.attempt.leaseUntil = Date.now() + 10
  runtime.store.transaction(() => runtime.store.put('tasks', stored))
  const renewed = await eventually(() => {
    const value = runtime.store.get('tasks', task.id).attempt?.leaseUntil ?? 0
    return value > before + 400 ? value : undefined
  }, 'a bounded live operation must keep renewing its lease')

  await sleep(200)
  assert.ok(renewed > before + 400)
  assert.equal(runtime.store.get('tasks', task.id).status, 'running')
  assert.equal(silentEscalations(runtime, mission.id).length, 0, 'a bounded operation must not escalate')
  assert.equal(runtime.store.events(mission.id, 500).some(event => event.type === 'mission/stalled'), false)
})

test('F1: a recording re-arms the silence clock, and the renewed silence escalates under a new key', async t => {
  const f = await fixture(t, { operationBoundMs: 50, leaseMs: 5000 })
  const { runtime, workers, member, task, mission } = f
  const activity = { id: 'op-stuck', kind: 'tool', tool: 'job_output', startedAt: Date.now() - 5000, updatedAt: Date.now() }
  workers.activities.set(member.id, activity)
  workers.callbacks.activity(member.id, activity)
  const first = await eventually(() => silentEscalations(runtime, mission.id)[0], 'the first silence must escalate')
  const attemptId = runtime.store.get('tasks', task.id).attempt.id

  // A durable recording on this attempt proves the operation is producing
  // again; the clock restarts from it rather than staying at the first breach.
  const recordedAt = Date.now()
  runtime.store.put('tool_runs', { id: 'run_progress', seq: 1, missionId: mission.id, memberId: member.id, taskId: task.id, attemptId, tool: 'job_output', arguments: {}, result: {}, isError: false, createdAt: recordedAt })
  const second = await eventually(() => silentEscalations(runtime, mission.id)[1], 'a renewed silence after a recording is a new actionable state')
  assert.notEqual(second.notice.dedupKey, first.notice.dedupKey, 'the dedup key is derived from the operation and the instant its silence began')
  assert.ok(second.content.includes(`lastRecordedAt ${recordedAt}`), `the renewed silence measures from the recording: ${second.content}`)
  await sleep(120)
  assert.equal(silentEscalations(runtime, mission.id).length, 2, 'each distinct silence escalates exactly once')
})

/**
 * F1 pair: a declared check RUNNING inside its own declared task timeout is not
 * judged by the runtime's wall-clock operation bound. The queue and the check
 * are real (`Workspaces` with one check slot); the runtime holds exactly the
 * single `verification` activity the composed adapter publishes for the whole
 * `verifyArtifact` call — the activity that exists to keep a queued attempt's
 * lease alive — so this is the state F1v falsified (a healthy 4.06 s check
 * inside its declared 30 s bound escalated at 2835 ms).
 */
test('F1 pair: a declared check running inside its own declared task timeout does not escalate', async t => {
  const f = await fixture(t, { operationBoundMs: 50, checkTimeoutMs: 1000, leaseMs: 400 }, { checkTimeoutMs: 30000 })
  const { runtime, workers, member, task, mission } = f
  assert.equal(runtime.store.get('tasks', task.id).checkTimeoutMs, 30000, 'the task declares its own host bound')
  // The live operation the adapter reports while the check runs: started far
  // past the generic 50 ms bound, still inside the task's declared 30 s. It is
  // published before the real checks are built (a repository takes longer than
  // the 400 ms lease), because a live operation is exactly what keeps the
  // attempt alive.
  const startedAt = Date.now() - 20000
  const activity = { id: 'op-check-running', kind: 'verification', startedAt, updatedAt: Date.now() }
  workers.activities.set(member.id, activity)
  workers.callbacks.activity(member.id, activity)
  // F1rv: the check is held by a sentinel the test writes LAST, so "the check is
  // still running" is structural rather than a race against a fixed sleep.
  const sentinel = join(f.directory, 'hold-running-check')
  const checks = await realCheckFixture(t, 1, sentinelHold(sentinel))

  const running = checks.workspaces.verifyArtifact(checks.prepared[0].member, checks.prepared[0].task, checks.prepared[0].artifact)
  await eventually(() => checks.workspaces.checkEnvelope().active === 1 ? true : undefined, 'the declared check must be running')
  assert.equal(existsSync(sentinel), false, 'the hold is in place: the check cannot finish before the sentinel exists')

  // Shorten the stored lease so the renewal rule is observable while the check runs.
  const before = Date.now()
  const stored = runtime.store.get('tasks', task.id)
  assert.ok(stored.attempt, 'the live operation kept the attempt alive instead of letting it expire')
  stored.attempt.leaseUntil = Date.now() + 10
  runtime.store.transaction(() => runtime.store.put('tasks', stored))
  const renewed = await eventually(() => {
    const value = runtime.store.get('tasks', task.id).attempt?.leaseUntil ?? 0
    return value > before + 400 ? value : undefined
  }, 'a bounded live declared check must keep renewing its lease')

  try {
    await sleep(200)
    assert.equal(existsSync(sentinel), false, 'the sentinel is still absent, so the held check cannot have finished')
    assert.equal(checks.workspaces.checkEnvelope().active, 1, 'the check is still genuinely running at the moment of assertion')
    assert.ok(renewed > before + 400)
    assert.equal(silentEscalations(runtime, mission.id).length, 0,
      'a check inside its own declared bound must never be judged by the generic operation bound')
    assert.equal(runtime.store.get('tasks', task.id).status, 'running', 'the attempt is untouched')
    assert.equal(workers.stopped.includes(member.id), false, 'no worker was stopped for a live declared check')
  } finally {
    // Released last: every assertion above ran while the check was provably held.
    await writeFile(sentinel, 'release')
  }
  const checksRun = await running
  assert.deepEqual(checksRun.map(check => check.exitCode), [0], 'the real check completed normally')
})

/**
 * F1 pair: a QUEUED verification is inside its own queue wait, not silent. The
 * queue is the real check-semaphore (`checkConcurrency: 1`): the second check
 * waits behind the first, and the runtime's single `verification` activity
 * covers the whole wait. F1v's D2 measured the old arithmetic escalating a
 * queued verification 5.2 s before its check could start.
 */
test('F1 pair: a queued verification inside its own queue wait does not escalate, with the queue visible', async t => {
  const f = await fixture(t, { operationBoundMs: 50, checkTimeoutMs: 1000, leaseMs: 400 }, { checkTimeoutMs: 30000 })
  const { runtime, workers, member, task, mission } = f
  // One `verification` activity covers the whole adapter call (queue + check),
  // published before the real repository fixture is built, exactly as the
  // composed adapter publishes it.
  const activity = { id: 'op-check-queued', kind: 'verification', startedAt: Date.now() - 20000, updatedAt: Date.now() }
  workers.activities.set(member.id, activity)
  workers.callbacks.activity(member.id, activity)
  // F1rv: the first check is held by a sentinel the test writes LAST, so it
  // cannot finish while the second check is being queued or while the lease and
  // escalation assertions run. The old fixture's fixed `sleep 0.6` raced the
  // second call's own checkout setup under load, which is the defect repaired
  // here; a longer sleep would be the same race with a bigger constant.
  const sentinel = join(f.directory, 'hold-queued-check')
  const checks = await realCheckFixture(t, 2, sentinelHold(sentinel))

  const first = checks.workspaces.verifyArtifact(checks.prepared[0].member, checks.prepared[0].task, checks.prepared[0].artifact)
  await eventually(() => checks.workspaces.checkEnvelope().active === 1 ? true : undefined, 'the first declared check must be running')
  const second = checks.workspaces.verifyArtifact(checks.prepared[1].member, checks.prepared[1].task, checks.prepared[1].artifact)
  // The hold makes this observation structural; only the second call's own
  // checkout setup can be slow under load, which a longer deadline tolerates
  // without weakening any assertion.
  await eventually(() => checks.workspaces.checkEnvelope().queued === 1 ? true : undefined,
    'the second declared check must be queued behind the first: that wait is what the old bound mistook for silence', 15000)
  assert.equal(existsSync(sentinel), false, 'the hold is in place while the queue is observed')

  const before = Date.now()
  const stored = runtime.store.get('tasks', task.id)
  assert.ok(stored.attempt, 'the queued verification kept the attempt alive instead of letting it expire')
  stored.attempt.leaseUntil = Date.now() + 10
  runtime.store.transaction(() => runtime.store.put('tasks', stored))
  const renewed = await eventually(() => {
    const value = runtime.store.get('tasks', task.id).attempt?.leaseUntil ?? 0
    return value > before + 400 ? value : undefined
  }, 'a queued verification must keep renewing its lease while it waits')

  try {
    await sleep(200)
    assert.equal(existsSync(sentinel), false, 'the sentinel is still absent, so the first check cannot have finished')
    assert.equal(checks.workspaces.checkEnvelope().queued, 1, 'the second check is still queued at the moment of assertion')
    assert.equal(silentEscalations(runtime, mission.id).length, 0,
      'a verification inside its own queue wait must never be escalated by the operation bound')
    assert.equal(runtime.store.get('tasks', task.id).status, 'running', 'the queued attempt stays running, never re-pended')
    assert.equal(workers.stopped.includes(member.id), false, 'no worker was stopped for a queued verification')
    assert.ok(renewed > before + 400)
  } finally {
    // Released last: every assertion above ran while the queue was held open.
    await writeFile(sentinel, 'release')
  }
  const [firstRun, secondRun] = await Promise.all([first, second])
  assert.deepEqual([...firstRun, ...secondRun].map(check => check.exitCode), [0, 0], 'both real checks completed normally')
  const envelope = checks.workspaces.checkEnvelope()
  assert.equal(envelope.limit, 1)
  assert.equal(envelope.maxActive, 1, 'the semaphore really serialized the checks')
  assert.ok(envelope.maxWaitMs > 0, 'the second check really waited in the queue')
})

test('F3: the adapter composes one scratch root per member as TMPDIR, private and inside the mission directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-scratch-'))
  const workers = new HarnessWorkers(new Context(), { workspacesRoot: root, checkTimeoutMs: 1000, maxCheckOutputBytes: 1024 })
  t.after(async () => { await workers.dispose(); await rm(root, { recursive: true, force: true }) })
  const first = await workers.sessionEnvironment('mission_alpha', 'member_one')
  const second = await workers.sessionEnvironment('mission_alpha', 'member_two')
  const otherMission = await workers.sessionEnvironment('mission_beta', 'member_one')

  assert.notEqual(first.TMPDIR, second.TMPDIR, 'two members never share a scratch root')
  assert.notEqual(first.TMPDIR, otherMission.TMPDIR, 'two missions never share a scratch root')
  assert.equal(first.TMPDIR, workers.scratchRoot('mission_alpha', 'member_one'), 'the composed root is deterministic')
  assert.ok(first.TMPDIR.startsWith(join(root, 'mission_alpha')), `the root stays inside the mission directory: ${first.TMPDIR}`)
  assert.equal(first.TMP, first.TMPDIR)
  assert.equal(first.TEMP, first.TMPDIR)
  const created = await stat(first.TMPDIR)
  assert.ok(created.isDirectory())
  assert.equal(created.mode & 0o777, 0o700, 'the scratch root is private to its member')

  // The resume fence: a persisted composition may only name this member's root.
  assert.doesNotThrow(() => { assertCompositionScratch({ environment: { TMPDIR: first.TMPDIR } }, first.TMPDIR) })
  assert.throws(() => { assertCompositionScratch({ environment: { TMPDIR: second.TMPDIR } }, first.TMPDIR) }, /belongs to a different member/)
  assert.throws(() => { assertCompositionScratch({ environment: { TMPDIR: 7 } }, first.TMPDIR) }, /belongs to a different member/)
  assert.doesNotThrow(() => { assertCompositionScratch({}, first.TMPDIR) }, 'a composition written before the field existed completes from the computed root')
})

test('F3: the declared-check environment resolves per member under concurrency', async () => {
  const scope = new ScopedEnvironment({ TMPDIR: '/ambient/tmp', PATH: '/bin' })
  const map = scope.map()
  assert.equal(map.TMPDIR, '/ambient/tmp', 'outside a scope the ambient environment is unchanged')
  assert.equal(map.PATH, '/bin')
  const seen = await Promise.all([
    scope.run({ TMPDIR: '/scratch/one' }, async () => { await sleep(25); return { ...map } }),
    scope.run({ TMPDIR: '/scratch/two' }, async () => { await sleep(5); return { ...map } }),
  ])
  assert.deepEqual(seen.map(environment => environment.TMPDIR), ['/scratch/one', '/scratch/two'])
  assert.deepEqual(seen.map(environment => environment.PATH), ['/bin', '/bin'])
  assert.equal(map.TMPDIR, '/ambient/tmp', 'one member\'s scope never leaks into another read')

  // A host whose ambient environment has no TMPDIR at all still gets the
  // member's root: a launcher spreads the map and the scope contributes it.
  const without = new ScopedEnvironment({ PATH: '/bin' })
  const bare = without.map()
  assert.equal('TMPDIR' in { ...bare }, false)
  const scoped = await without.run({ TMPDIR: '/scratch/bare', TMP: '/scratch/bare' }, async () => ({ ...bare }))
  assert.equal(scoped.TMPDIR, '/scratch/bare')
  assert.equal(scoped.TMP, '/scratch/bare')
  assert.equal(scoped.PATH, '/bin')
})

test('F1: the guard co-fires with the task ceiling path and never re-reports the attempt it dropped', async t => {
  const f = await fixture(t, { operationBoundMs: 50, leaseMs: 5000 }, { maxSteps: 1 })
  const { runtime, workers, member, task, mission } = f
  // One model step is charged, then the operation goes silent past the bound.
  await workers.callbacks.beforeStep(member.id, true)
  const activity = { id: 'op-stuck', kind: 'tool', tool: 'job_output', startedAt: Date.now() - 5000, updatedAt: Date.now() }
  workers.activities.set(member.id, activity)
  workers.callbacks.activity(member.id, activity)
  await eventually(() => silentEscalations(runtime, mission.id)[0], 'the silent operation must escalate')

  // The next step hits the task's own ceiling. The attempt is dropped, so a
  // later pass has no running attempt to watch: the ceiling path owns the exit
  // and the operation-bound guard must not re-report the same stuck call.
  assert.equal(await workers.callbacks.beforeStep(member.id, true), false, 'the ceiling must refuse the next step')
  const ceiling = runtime.store.events(mission.id, 500).find(event => event.type === 'task/ceiling-exhausted')
  assert.equal(ceiling.data.taskId, task.id)
  assert.equal(ceiling.data.dimension, 'maxSteps')
  assert.equal(runtime.store.get('tasks', task.id).attempt, undefined)
  assert.equal(runtime.store.list('deliveries', mission.id).filter(delivery => delivery.to === 'owner' && delivery.content.includes('exhausted its own')).length, 1, 'the ceiling path emits its own owner notice')
  await sleep(150)
  assert.equal(silentEscalations(runtime, mission.id).length, 1, 'a dropped attempt is not re-reported by the operation bound')
})
