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
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { HarnessWorkers } from '../lib/harness-workers.js'
import { Config } from '../lib/index.js'

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}

async function semaphoreFixture(t, options = {}, members = 3, checkCommand = 'sleep 0.15') {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-semaphore-')))
  const source = path.join(temp, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'fixture baseline')
  const checkStarts = []
  const workspaces = new Workspaces({ workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000,
    confineCheck: (argv) => { checkStarts.push(Date.now()); return argv }, ...options })
  const mission = { id: 'mission-one', workspace: source }
  const prepared = []
  for (let index = 0; index < members; index++) {
    const member = { id: `member-${index}`, missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, `member-${index}`) }
    const task = { id: `task-${index}`, missionId: mission.id, epoch: 1, title: 'Check', kind: 'implementation', scope: ['**'], checks: [], status: 'running' }
    await workspaces.prepareTask(member, task, [])
    await mkdir(path.join(member.workspace, 'src'), { recursive: true })
    await writeFile(path.join(member.workspace, 'src', 'answer.txt'), `answer ${index}\n`)
    const artifact = await workspaces.captureArtifact(member, task)
    prepared.push({ member, task: { ...task, checks: [checkCommand] }, artifact })
  }
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, workspaces, prepared, checkStarts }
}

const eventually = async (read, message, timeoutMs = 4000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.fail(message)
}

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
  const samples = f.workspaces.checkEnvelopeSamples()
  assert.equal(samples.length, 3)
  for (const sample of samples) { assert.equal(sample.limit, 1); assert.ok(sample.active <= 1) }
  assert.ok(samples.some(sample => sample.waitMs > 0), 'the queue wait is measured per check')
})

test('R11-19: checkConcurrency 3 lets checks overlap and records the envelope', async t => {
  const f = await semaphoreFixture(t, { checkConcurrency: 3 })
  const results = await Promise.all(f.prepared.map(entry => f.workspaces.verifyArtifact(entry.member, entry.task, entry.artifact)))
  for (const result of results) assert.deepEqual(result.map(check => check.exitCode), [0])
  const envelope = f.workspaces.checkEnvelope()
  assert.equal(envelope.limit, 3)
  assert.equal(envelope.maxActive, 3, 'all three checks overlapped')
  assert.equal(envelope.completed, 3)
  const samples = f.workspaces.checkEnvelopeSamples()
  assert.equal(samples.length, 3)
  assert.ok(samples.some(sample => sample.active > 1), 'at least two declared checks executed concurrently')
  assert.equal(samples.filter(sample => sample.waitMs > 0).length, 0, 'no check waited below the limit')
})

test('R11-19: an aborted queued verification leaves the queue instead of running', async t => {
  const f = await semaphoreFixture(t, { checkConcurrency: 1 }, 2, 'sleep 0.6')
  const [first, second] = f.prepared
  const running = f.workspaces.verifyArtifact(first.member, first.task, first.artifact)
  await eventually(() => f.checkStarts.length === 1, 'the first check never started')
  const controller = new AbortController()
  const queued = f.workspaces.verifyArtifact(second.member, second.task, second.artifact, controller.signal)
  await eventually(() => f.workspaces.checkEnvelope().queued === 1, 'the second check was not queued')
  controller.abort(new Error('reviewer cancelled'))
  await assert.rejects(queued, /reviewer cancelled/)
  await running
  const envelope = f.workspaces.checkEnvelope()
  assert.equal(envelope.queued, 0)
  assert.equal(envelope.completed, 1, 'the aborted check never acquired a slot')
})

test('R11-19: the plugin config declares the limit and the composition passes it to the owned Workspaces', async t => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-semaphore-config-')))
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
