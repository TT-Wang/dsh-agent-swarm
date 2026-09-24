/**
 * R11-19 regression: declared-check executions are bounded per host by a
 * configurable semaphore, the queue is FIFO and abort-aware, and the measured
 * envelope (single check vs N concurrent) is recorded.
 *
 * Pre-fix head: `Workspaces` had no `checkConcurrency` option and every
 * verification ran unbounded.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HarnessWorkers } from '../lib/harness-workers.js'
import { Config } from '../lib/index.js'
import { tempDirectory } from './temp-root.mjs'
import { eventually, makeRepo, makeWorkspaces } from './faults/harness.mjs'

async function semaphoreFixture(t, options = {}, members = 3, checkCommand = 'sleep 0.15') {
  const { root: temp, source } = await makeRepo('swarm-semaphore')
  const checkStarts = []
  const workspaces = makeWorkspaces(temp, { confineCheck: (argv) => { checkStarts.push(Date.now()); return argv }, ...options })
  const mission = { id: 'mission-one', workspace: source }
  const prepared = []
  for (let index = 0; index < members; index++) {
    const member = { id: `member-${index}`, missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, `member-${index}`) }
    const task = { id: `task-${index}`, missionId: mission.id, epoch: 1, title: 'Check', kind: 'implementation', scope: ['**'], checks: [], status: 'running' }
    await workspaces.prepareTask(member, task, [])
    await mkdir(path.join(member.workspace, 'src'), { recursive: true })
    await writeFile(path.join(member.workspace, 'src', 'answer.txt'), `answer ${index}\n`)
    const artifact = await workspaces.captureArtifact(member, task)
    prepared.push({ member, task: { ...task, checks: [typeof checkCommand === 'function' ? checkCommand(temp) : checkCommand] }, artifact })
  }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, workspaces, prepared, checkStarts }
}

/**
 * Deadline on hanging, not on speed: the predicates below wait for real check work
 * (git checkout, process spawn, the FIFO slot), so each passes a 30 s bound. The
 * former 4 s default assumed an unloaded host; the assertions are unchanged.
 */

test('R11-19: checkConcurrency 1 serializes declared checks and records the measured envelope', async t => {
  const f = await semaphoreFixture(t, { checkConcurrency: 1 })
  const results = await Promise.all(f.prepared.map(entry => f.workspaces.verifyArtifact(entry.member, entry.task, entry.artifact)))
  for (const result of results) assert.deepEqual(result.map(check => check.exitCode), [0])
  const envelope = f.workspaces.checkEnvelope()
  assert.equal(envelope.limit, 1)
  assert.equal(envelope.maxActive, 1, 'no two checks ran at once')
  assert.equal(envelope.completed, 3)
  assert.ok(envelope.maxWaitMs >= 100, `two checks had to wait, saw maxWaitMs=${envelope.maxWaitMs}`)
  assert.ok(envelope.totalRunMs >= 400, 'the checks really ran serially')
  // The measured envelope is the whole record: `maxActive === 1` is the per-check
  // "never more than the limit was active", and `maxWaitMs >= 100` is the per-check
  // "the queue wait is really measured", both maximised over the same three checks.
  assert.ok(envelope.totalWaitMs >= envelope.maxWaitMs, 'the wait total accumulates every check, not only the longest')
  assert.equal(envelope.active, 0, 'every slot was released: a leak here would queue every later check forever')
  assert.equal(envelope.queued, 0, 'no check is left waiting for a slot')
})

test('R11-19: checkConcurrency 3 lets checks overlap and records the envelope', async t => {
  // Deterministic overlap instead of a race against a 150 ms sleep: every check
  // holds until this test releases it, so "three ran at once" is observed by
  // construction even when process spawn takes longer than the hold. The previous
  // form asserted `maxActive === 3` against `sleep 0.15` and went red under load
  // (FLK-R2v heavy window, tests/check-semaphore.test.mjs:83).
  const f = await semaphoreFixture(t, { checkConcurrency: 3 }, 3, temp => {
    const sentinel = path.join(temp, 'overlap-release')
    return `node -e "const fs=require('fs');const d=Date.now()+30000;while(!fs.existsSync('${sentinel}')&&Date.now()<d){}"`
  })
  const results = f.prepared.map(entry => f.workspaces.verifyArtifact(entry.member, entry.task, entry.artifact))
  await eventually(() => f.workspaces.checkEnvelope().maxActive === 3, 'all three declared checks were never active at once', 30000)
  await writeFile(path.join(f.temp, 'overlap-release'), 'release\n')
  for (const result of await Promise.all(results)) assert.deepEqual(result.map(check => check.exitCode), [0])
  const envelope = f.workspaces.checkEnvelope()
  assert.equal(envelope.limit, 3)
  assert.equal(envelope.maxActive, 3, 'all three checks overlapped')
  assert.equal(envelope.completed, 3)
  // `maxActive === 3` above is the concurrency observation: at least two declared
  // checks executed at once, measured over the same three completed checks.
  // `CheckSemaphore.acquire` reports `waitMs` as the elapsed time of its whole
  // prologue, not only a real queue wait, so a busy event loop can report 1 ms for a
  // check that never queued: the exact-zero form of this assertion was an unstated
  // "the clock never advances during a synchronous call". The property is that no
  // check queued behind another below the limit, which is stated in the units of the
  // hold itself: the default check sleeps 0.15 s, so a genuinely queued check waits
  // at least that long, while the measurement artefact is a millisecond.
  // `maxWaitMs` is the maximum over every check, so this is exactly "no check
  // waited for a slot below the limit" — stated once, over all three.
  assert.ok(envelope.maxWaitMs < 100, `no check queued below the limit, saw maxWaitMs=${envelope.maxWaitMs}`)
})

test('R11-19: an aborted queued verification leaves the queue instead of running', async t => {
  // The first check holds the only slot while the second verification does its
  // pre-queue work (store reads, artifact validation, authorization) and then waits.
  // A 0.6 s hold assumed that pre-queue work finishes in under 0.6 s on an unloaded
  // host; when it did not, the first check ended before the second reached the queue,
  // `queued` stayed 0 and the second acquired the slot instead of waiting — a
  // scheduling artefact, not a contract change. The hold is now long enough that the
  // queue observation is about the semaphore, not about how fast the host is.
  const f = await semaphoreFixture(t, { checkConcurrency: 1 }, 2, 'sleep 5')
  const [first, second] = f.prepared
  const running = f.workspaces.verifyArtifact(first.member, first.task, first.artifact)
  await eventually(() => f.checkStarts.length === 1, 'the first check never started', 30000)
  const controller = new AbortController()
  const queued = f.workspaces.verifyArtifact(second.member, second.task, second.artifact, controller.signal)
  await eventually(() => f.workspaces.checkEnvelope().queued === 1, 'the second check was not queued', 30000)
  controller.abort(new Error('reviewer cancelled'))
  await assert.rejects(queued, /reviewer cancelled/)
  await running
  const envelope = f.workspaces.checkEnvelope()
  assert.equal(envelope.queued, 0)
  assert.equal(envelope.completed, 1, 'the aborted check never acquired a slot')
})

test('R11-19: the plugin config declares the limit and the composition passes it to the owned Workspaces', async t => {
  const temp = await realpath(await tempDirectory('swarm-semaphore-config-'))
  t.after(async () => rm(temp, { recursive: true, force: true }))
  const base = { statePath: path.join(temp, 'state.sqlite'), workspacesRoot: path.join(temp, 'worktrees') }
  assert.equal(Config(base).checkConcurrency, 2, 'the production default bounds the host')
  assert.equal(Config({ ...base, checkConcurrency: 1 }).checkConcurrency, 1)
  assert.throws(() => Config({ ...base, checkConcurrency: 0 }))
  // `apply()` builds HarnessWorkers from exactly this config object.
  const config = Config({ ...base, checkConcurrency: 1 })
  const ctx = { on: () => () => {}, get: () => undefined, logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} } }
  const workers = new HarnessWorkers(ctx, { ...config, grants: undefined })
  t.after(async () => { await workers.dispose() })
  assert.equal(workers.checkEnvelope().limit, 1, 'the configured limit reaches the semaphore, not a hand-supplied fixture')
})
