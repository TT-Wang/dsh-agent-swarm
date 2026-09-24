import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rm, readFile, writeFile } from 'node:fs/promises'
import { FakeWorkers, WorkspaceWorkers, setup, makeRepo, taskOf, events, eventually, makeWorkspaces } from './faults/harness.mjs'

const deferred = () => { let resolve; return { promise: new Promise(r => { resolve = r }), resolve: value => resolve(value) } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function fixture(options = {}) {
  const f = await setup({ ...options, config: { tickMs: 3_600_000, stallPassTimeoutMs: 50, stallPassLiveGraceMs: 0, ...options.config } })
  clearInterval(f.runtime.timer)
  f.runtime.config.tickMs = 10
  f.runtime.kick = () => {}
  await f.runtime.exclusive(f.mission.id, async () => {})
  await new Promise(resolve => setImmediate(resolve))
  const priorPass = f.runtime.scheduling.passes.get(f.mission.id)
  if (priorPass !== undefined) f.runtime.closePass(f.mission.id, priorPass)
  const keepAlive = setInterval(() => {}, 1000)
  const cleanup = f.cleanup
  f.cleanup = async () => { clearInterval(keepAlive); await cleanup() }
  return f
}

test('queue wait timeout refuses all successors until the actual operation returns, without blocking another mission', async () => {
  const f = await fixture()
  const gate = deferred()
  const nextGate = deferred()
  let first, next
  try {
    const calls = []
    first = f.runtime.exclusive(f.mission.id, async () => { calls.push('first'); await gate.promise })
    await assert.rejects(f.runtime.exclusive(f.mission.id, async () => { calls.push('second') }), /mission_operation_pending/)
    // A rejected wait must not release its predecessor through its finally.
    await assert.rejects(f.runtime.exclusive(f.mission.id, async () => { calls.push('third') }), /mission_operation_pending/)
    assert.equal(await f.runtime.exclusive('unrelated-mission', async () => 'available'), 'available')
    assert.deepEqual(calls, ['first'])
    const notice = f.runtime.store.list('deliveries', f.mission.id).filter(row => row.to === 'owner' && row.content.includes('mission_operation_pending'))
    assert.equal(notice.length, 1, 'one actionable notice, not one per refused waiter')
    gate.resolve(); await first
    await f.runtime.exclusive(f.mission.id, async () => { calls.push('after') })
    assert.deepEqual(calls, ['first', 'after'])
    next = f.runtime.exclusive(f.mission.id, async () => { await nextGate.promise })
    await assert.rejects(f.runtime.exclusive(f.mission.id, async () => {}), /mission_operation_pending/)
    const episodes = f.runtime.store.list('deliveries', f.mission.id).filter(row => row.to === 'owner' && row.content.includes('mission_operation_pending'))
    assert.equal(episodes.length, 2, 'a different physical operation gets a fresh warning')
    assert.notEqual(episodes[0].notice.dedupKey, episodes[1].notice.dedupKey)
  } finally { gate.resolve(); nextGate.resolve(); await Promise.allSettled([first, next]); await f.cleanup() }
})

test('a rejected second claim leaves real Git workspace ownership and working content untouched', async () => {
  const repo = await makeRepo('swarm-claim-ownership')
  const ws = makeWorkspaces(repo.root, { maxCheckOutputBytes: 100_000 })
  const workers = new WorkspaceWorkers(ws)
  const f = await fixture({ workers, workspace: repo.source })
  const gate = deferred(), entered = deferred()
  let first
  try {
    const one = f.propose({ title: 'First claim' }), two = f.propose({ title: 'Second claim' })
    const prepare = workers.prepareTask.bind(workers)
    workers.prepareTask = async (...args) => { entered.resolve(); await gate.promise; return prepare(...args) }
    first = f.runtime.claim(f.actor(f.author), f.mission.id, one.id)
    await entered.promise
    await assert.rejects(f.runtime.claim(f.actor(f.author), f.mission.id, two.id), /mission_operation_pending/)
    assert.equal(workers.prepared.length, 0)
    gate.resolve(); await first
    const metadataPath = join(repo.root, 'worktrees', f.mission.id, `${f.author.id}.workspace.json`)
    const before = await readFile(metadataPath, 'utf8')
    await writeFile(join(f.author.workspace, 'src/answer.txt'), 'private WIP\n')
    await assert.rejects(f.runtime.claim(f.actor(f.author), f.mission.id, two.id), /lease_conflict/)
    assert.equal(await readFile(metadataPath, 'utf8'), before)
    assert.equal(await readFile(join(f.author.workspace, 'src/answer.txt'), 'utf8'), 'private WIP\n')
    assert.equal(workers.prepared.length, 1)
    assert.equal(taskOf(f.runtime, two.id).status, 'pending')
  } finally { gate.resolve(); await first; await f.cleanup(); await ws.dispose(); await rm(repo.root, { recursive: true, force: true }) }
})

for (const resume of [false, true]) test(`challenge keeps the stop/checkpoint barrier and preserves owner resume intent: ${resume}`, async () => {
  const f = await fixture()
  const stop = deferred(), checkpoint = deferred(), enteredCheckpoint = deferred()
  try {
    const source = f.propose({ title: 'Previously accepted source' })
    Object.assign(source, { status: 'accepted', artifact: { ...f.workers.artifact }, evidenceIds: ['e-source'] })
    f.runtime.store.transaction(() => {
      f.runtime.store.put('tasks', source)
      f.runtime.store.put('evidence', { id: 'e-source', missionId: f.mission.id, taskId: source.id, workstreamId: f.stream.id,
        authorId: f.author.id, claim: 'previous finding', outcome: 'supported', status: 'verified', toolRunIds: [], supersedes: [], challenges: [], createdAt: Date.now() })
    })
    const task = f.propose({ title: 'Dependent', assigneeId: f.reviewer.id, dependencies: [source.id] })
    await f.runtime.claim(f.actor(f.reviewer), f.mission.id, task.id)
    const next = f.propose({ title: 'Independent work', assigneeId: f.reviewer.id })
    f.workers.stop = async () => { await stop.promise }
    f.workers.checkpointTask = async () => { enteredCheckpoint.resolve(); await checkpoint.promise }
    f.runtime.challenge(f.owner, f.mission.id, { evidenceId: 'e-source', reason: 'counterexample', toolRunIds: [] })
    assert.equal(taskOf(f.runtime, task.id).resumeAfterStop.reason, 'invalidated')
    await assert.rejects(f.runtime.claim(f.actor(f.reviewer), f.mission.id, next.id), /previous attempt to stop/)
    stop.resolve(); await enteredCheckpoint.promise
    await assert.rejects(f.runtime.claim(f.actor(f.reviewer), f.mission.id, next.id), /previous attempt to stop/)
    if (resume) {
      f.runtime.controlTask(f.owner, f.mission.id, task.id, 'resume', {}, 'Keep this dependent queued until its prerequisite is reviewed again')
      await assert.rejects(f.runtime.claim(f.actor(f.reviewer), f.mission.id, next.id), /previous attempt to stop/)
    }
    checkpoint.resolve()
    await eventually(() => !taskOf(f.runtime, task.id).resumeAfterStop, 'checkpoint must release the member')
    assert.equal(taskOf(f.runtime, task.id).status, resume ? 'pending' : 'blocked', 'quiescence changes the invalidated outcome only on an explicit owner recovery')
    assert.equal((await f.runtime.claim(f.actor(f.reviewer), f.mission.id, next.id)).status, 'running')
  } finally { stop.resolve(); checkpoint.resolve(); await f.cleanup() }
})

test('failed idle capture follows the same confirmed stop barrier', async () => {
  const f = await fixture({ config: { maxIdleCloseouts: 0 } })
  const stop = deferred()
  try {
    const task = f.propose(), next = f.propose({ title: 'Later work' })
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    f.workers.captureArtifact = async () => { throw new Error('fixture capture failed') }
    f.workers.stop = async () => { await stop.promise }
    let saved = false
    f.workers.checkpointTask = async () => { saved = true }
    await f.runtime.closeOutIdleAttempt(f.runtime.mission(f.mission.id), f.author, claimed)
    assert.equal(taskOf(f.runtime, task.id).resumeAfterStop.reason, 'invalidated')
    await assert.rejects(f.runtime.claim(f.actor(f.author), f.mission.id, next.id), /previous attempt to stop/)
    stop.resolve()
    await eventually(() => !taskOf(f.runtime, task.id).resumeAfterStop, 'cleanup must finish')
    assert.equal(saved, true)
    assert.equal(taskOf(f.runtime, task.id).status, 'blocked')
  } finally { stop.resolve(); await f.cleanup() }
})

test('a wedged pass body is the only pass body: no newer pass runs beside it, so its own error is the current outcome', async () => {
  // This replaces the released-pass fence. A newer pass could only overwrite a
  // wedged body's writes by running beside it; the mission queue refuses that
  // (and `openPass` does not even queue it), so the body that ran is the one
  // whose outcome stands, and the next pass starts from it.
  const f = await fixture()
  const enteredOld = deferred(), failOld = deferred()
  let old, oldPass
  try {
    const task = f.propose()
    f.workers.isIdle = () => true
    let count = 0
    f.workers.prepareTask = async () => {
      if (++count === 1) { enteredOld.resolve(); await failOld.promise; throw Object.assign(new Error('stale preparation failed'), { code: 'EBUSY' }) }
    }
    oldPass = f.runtime.openPass(f.mission.id)
    assert.ok(oldPass)
    old = f.runtime.exclusive(f.mission.id, () => f.runtime.scheduling.dispatch(f.runtime.mission(f.mission.id), f.mission.id))
    await enteredOld.promise
    await sleep(70); f.runtime.scheduling.checkSchedulingPasses()
    assert.equal(events(f.runtime, f.mission.id, 'mission/stalled').filter(item => item.data.wedged === true && item.data.runId === oldPass.operationId).length, 1, 'the watchdog names the wedged body')
    assert.equal(f.runtime.openPass(f.mission.id), undefined, 'no newer pass is opened while the wedged body is held')
    let ranBeside = false
    await assert.rejects(f.runtime.exclusive(f.mission.id, async () => { ranBeside = true }), /mission_operation_pending/)
    assert.equal(ranBeside, false, 'and the queue refuses any other body instead of running it beside the wedged one')
    assert.equal(count, 1)
    failOld.resolve(); await old
    f.runtime.closePass(f.mission.id, oldPass)
    const failed = taskOf(f.runtime, task.id)
    assert.equal(failed.preparationFailure?.attempts, 1, 'the wedged body records its own transient failure: it was the only body')
    assert.equal(failed.status, 'pending', 'and leaves the task for bounded retry')
    assert.equal(events(f.runtime, f.mission.id, 'task/preparation-failed').length, 1)
    assert.ok(f.runtime.openPass(f.mission.id), 'once it settled, the next pass opens')
  } finally { failOld.resolve(); await Promise.allSettled([old]); await f.cleanup() }
})

test('the wedge watchdog cannot discard the queue of a physical preparation still in flight', async () => {
  const f = await fixture()
  const entered = deferred(), finish = deferred()
  let operation
  try {
    f.propose()
    f.workers.isIdle = () => true
    f.workers.prepareTask = async () => { entered.resolve(); await finish.promise }
    const pass = f.runtime.openPass(f.mission.id)
    assert.ok(pass)
    operation = f.runtime.exclusive(f.mission.id, () => f.runtime.scheduling.dispatch(f.runtime.mission(f.mission.id), f.mission.id))
    await entered.promise
    await sleep(70); f.runtime.scheduling.checkSchedulingPasses()
    assert.equal(pass.escalatedAt !== undefined, true, 'the watchdog named the wedged pass')
    let changed = false
    await assert.rejects(f.runtime.exclusive(f.mission.id, async () => { changed = true }), /mission_operation_pending/)
    assert.equal(changed, false)
  } finally { finish.resolve(); await operation; await f.cleanup() }
})

test('deterministic cleanup failure is durable and quiet until owner resume retries the same cancelled task', async () => {
  const f = await fixture()
  try {
    const task = f.propose()
    await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    let checkpoints = 0, broken = true
    f.workers.checkpointTask = async () => {
      checkpoints++
      if (broken) throw Object.assign(new Error('Cannot checkpoint a workspace owned by another task'), { code: 'WORKSPACE_OWNERSHIP_CONFLICT' })
    }
    f.runtime.cancel(f.owner, f.mission.id, { taskId: task.id, reason: 'withdrawn work still needs preservation' })
    await eventually(() => taskOf(f.runtime, task.id).resumeAfterStop?.failure?.deterministic, 'conflict must persist')
    const notices = () => f.runtime.store.list('deliveries', f.mission.id).filter(row => row.notice?.dedupKey?.includes(`stop:${task.id}:`))
    assert.equal(notices().length, 1)
    for (let i = 0; i < 3; i++) {
      f.propose({ title: `Unrelated progress ${i}` })
      f.runtime.attempts.resumeStoppedAttempt(f.mission.id, taskOf(f.runtime, task.id))
    }
    await sleep(20)
    assert.equal(checkpoints, 1, 'deterministic conflict does not endlessly repeat')
    assert.equal(notices().length, 1, 'unrelated task changes cannot re-wake owner')
    broken = false
    f.runtime.controlTask(f.owner, f.mission.id, task.id, 'resume', {}, 'workspace preservation repaired')
    await eventually(() => !taskOf(f.runtime, task.id).resumeAfterStop, 'owner resume retries and clears cleanup debt')
    assert.equal(taskOf(f.runtime, task.id).status, 'cancelled', 'resume cleanup cannot resurrect withdrawn work')
    assert.equal(checkpoints, 2)
  } finally { await f.cleanup() }
})

test('claim refusal explains the actual source, dependency or assignment without preparing a workspace', async () => {
  const f = await fixture()
  try {
    const source = f.propose({ title: 'Unsubmitted source' })
    const review = f.propose({ title: 'Review source', kind: 'verification', checks: [], reviewOf: source.id, assigneeId: f.reviewer.id })
    await assert.rejects(f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id), error => error.message.startsWith('Task is not ready for this member:') && error.message.includes(`review source ${source.id} is pending`))
    const dependent = f.propose({ title: 'Wait for source', dependencies: [source.id] })
    await assert.rejects(f.runtime.claim(f.actor(f.author), f.mission.id, dependent.id), error => error.message.includes(`dependency ${source.id} is pending`))
    const bound = f.propose({ title: 'Other member work', assigneeId: f.reviewer.id })
    await assert.rejects(f.runtime.claim(f.actor(f.author), f.mission.id, bound.id), error => error.message.includes(`bound to member ${f.reviewer.id}`))
    assert.equal(f.workers.prepared.length, 0)
  } finally { await f.cleanup() }
})
