/**
 * W9 regressions: a lease-expiry checkpoint failure is non-fatal and re-pends
 * the task, but a different member then has to prepare that task. Pre-fix that
 * recovery called `captureArtifact` on the previous owner's dirty workspace,
 * threw on the out-of-scope partial work, and `schedule()` marked the task
 * `blocked` forever. The fix re-creates a clean baseline from the last durable
 * checkpoint (or the recorded task base) while leaving the previous owner's
 * worktree untouched, and records the fallback durably.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { Workspaces, runProcess } from '../lib/workspaces.js'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
/**
 * Deadline on hanging, not on speed. The predicates below wrap real git work
 * (`git init`, `worktree add`, commits) that the runtime performs between
 * scheduling ticks; the earlier 5 s default was an unstated performance
 * requirement that failed under load without any contract changing. 90 s is a
 * bound on a wedged runtime, not on a busy machine: on an idle host this test
 * finishes in a few seconds.
 */
async function eventually(read, message, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(message)
}
async function git(cwd, ...args) {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}

/** Real worktrees and real commits; only the worker lifecycle is inert. */
class RealWorkers {
  idle = new Set()
  stopped = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareBaseline(mission, signal) { return await this.workspaces.prepareBaseline(mission, signal) }
  async prepareWorkspace(mission, memberId) { return await this.workspaces.prepareWorkspace(mission, memberId) }
  async start() {}
  async deliver() {}
  async stop(memberId) { this.stopped.push(memberId) }
  isIdle(memberId) { return this.idle.has(memberId) }
  async prepareTask(member, task, dependencies, reviewSource) { await this.workspaces.prepareTask(member, task, dependencies, reviewSource) }
  async captureArtifact(member, task) { return await this.workspaces.captureArtifact(member, task) }
  async verifyArtifact(member, task, artifact, signal) { return await this.workspaces.verifyArtifact(member, task, artifact, signal) }
  async dispose() {}
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swarm-w9-')))
  const source = join(root, 'source')
  await mkdir(source)
  await git(source, 'init', '-b', 'main')
  await mkdir(join(source, 'src'))
  await writeFile(join(source, 'src', 'answer.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const workspaces = new Workspaces({ workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv })
  const workers = new RealWorkers()
  workers.workspaces = workspaces
  const runtime = new SwarmRuntime({ statePath: join(root, 'state.sqlite'), leaseMs: 60000, tickMs: 20,
    maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }, workers)
  t.after(async () => { await runtime.dispose(); await workspaces.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { sessionId: 'w9-owner' }
  const mission = runtime.create(owner, { title: 'W9', objective: 'Never dead-end on a dirty workspace', workspace: source,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  await runtime.start()
  const actor = member => ({ sessionId: member.sessionId })
  const current = task => runtime.store.get('tasks', typeof task === 'string' ? task : task.id)
  const events = type => runtime.store.events(mission.id, 500).filter(event => event.type === type)
  return { root, source, workspaces, workers, runtime, owner, mission, stream, author, reviewer, actor, current, events }
}

test('W9: a cross-member recovery from a dirty workspace re-creates a clean baseline instead of blocking', async t => {
  const f = await fixture(t)
  const task = f.runtime.propose(f.owner, f.mission.id, { workstreamId: f.stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['true'] })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  assert.equal(claimed.attempt.ownerId, f.author.id)
  const authorWorkspace = f.runtime.store.get('members', f.author.id).workspace
  const base = await git(authorWorkspace, 'rev-parse', 'HEAD')
  // Out-of-scope partial work: the lease-expiry checkpoint cannot capture it.
  await writeFile(join(authorWorkspace, 'outside.txt'), 'out of scope partial edit\n')
  // The plan intended the reviewer, so the non-fatal re-pend hands the task to a
  // different member while the previous owner's dirty record still names it.
  const planned = f.current(task.id)
  planned.plannedAssigneeId = f.reviewer.id
  planned.attempt.leaseUntil = Date.now() - 1
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', planned))
  f.workers.idle.add(f.author.id)
  f.workers.idle.add(f.reviewer.id)
  // The lease-expiry checkpoint really fired and failed.
  const failed = await eventually(() => f.events('task/checkpoint-failed')[0], 'the lease-expiry checkpoint failure is audited')
  assert.match(failed.data.reason, /outside task scope/)
  // Recovery succeeds on the reviewer instead of blocking the task forever.
  // The fallback that handed the task over is sampled in the same synchronous
  // read that observes the recovery: under load the runtime may later record
  // another recovery, and that is a different recovery, not this one. The count
  // and its reason are still asserted to be exactly one and this fallback's.
  let fallbacksAtRecovery
  const running = await eventually(() => {
    const current = f.current(task.id)
    if (!(current.status === 'running' && current.attempt?.ownerId === f.reviewer.id)) return undefined
    fallbacksAtRecovery = f.workspaces.recoveryFallbacks().slice()
    return current
  }, 'the task is recovered by the other member')
  assert.equal(f.current(task.id).status, 'running')
  // One distinct recovery fact, sampled at the observation above. The runtime may
  // re-derive the same fallback on each preparation retry (and the epoch is part of
  // the message), so the assertion is over the distinct fact, not the retry count:
  // a second, *different* fallback for this handover would still fail here.
  const distinctFallbacks = new Set(fallbacksAtRecovery.map(message => message.replace(/ \(epoch \d+\)/, '')))
  assert.equal(distinctFallbacks.size, 1, `one recovery fact, not several: ${[...distinctFallbacks].join(' | ')}`)
  const [fallback] = distinctFallbacks
  assert.match(fallback, /outside task scope/, 'the fallback names the real reason')
  assert.match(fallback, new RegExp(f.author.id), 'the fallback names the previous owner')
  assert.match(fallback, new RegExp(task.id), 'the fallback names the task')
  assert.match(fallback, new RegExp(base), 'the fallback names the recorded baseline it started from')
  assert.deepEqual(f.events('task/blocked'), [], 'preparation never dead-ends the task')
  const reviewerWorkspace = f.runtime.store.get('members', f.reviewer.id).workspace
  assert.equal(await git(reviewerWorkspace, 'rev-parse', 'HEAD'), base, 'the recovered attempt starts at the recorded task base')
  assert.equal(await git(reviewerWorkspace, 'status', '--porcelain'), '', 'the recovered baseline is clean')
  assert.equal(await readFile(join(authorWorkspace, 'outside.txt'), 'utf8'), 'out of scope partial edit\n', 'the previous owner worktree is preserved untouched')
  const recordPath = join(f.root, 'worktrees', f.mission.id, 'tasks', `${task.id}.json`)
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  assert.equal(record.memberId, f.reviewer.id)
  assert.equal(record.task.recovery.commit, base, 'the durable record names the fallback baseline')
  assert.equal(record.task.recovery.previousOwnerId, f.author.id)
  // The recovered attempt can still make progress and be submitted. The runtime may
  // legitimately re-pend and re-prepare the task while this test does real git work
  // (preparation under load, then the W18 bounded recovery), which bumps the attempt
  // epoch and rewrites the prepared workspace record together. Submitting against the
  // moved epoch is refused with the runtime's own documented recovery ("Retry the task
  // with `swarm_claim` and its `taskId`"), so this follows that instruction: re-observe
  // a live attempt whose prepared record matches it, and retry the documented
  // recovery, bounded. The assertion — the recovered attempt submits real work — is
  // unchanged; only the fixture stops racing the runtime's own recovery.
  let submitted
  for (let round = 1; ; round++) {
    const live = await eventually(() => {
      const current = f.current(task.id)
      if (!(current.status === 'running' && current.attempt?.ownerId === f.reviewer.id)) return undefined
      try {
        const prepared = JSON.parse(readFileSync(recordPath, 'utf8'))
        if (prepared.memberId !== f.reviewer.id || prepared.task?.taskId !== task.id || prepared.task.epoch !== current.attempt.epoch) return undefined
      } catch { return undefined }
      return current
    }, 'the reviewer to hold the prepared attempt that will submit')
    await writeFile(join(reviewerWorkspace, 'src', 'answer.txt'), `recovered work ${round}\n`)
    try {
      submitted = await f.runtime.submit(f.actor(f.reviewer), f.mission.id, { taskId: task.id, attemptId: live.attempt.id, output: 'recovered' })
      break
    } catch (error) {
      if (round >= 3 || !/workspace_baseline_missing/.test(String(error?.message ?? ''))) throw error
    }
  }
  assert.equal(submitted.status, 'submitted')
  assert.notEqual(submitted.artifact.commit, base)
})
