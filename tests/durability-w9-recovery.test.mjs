/**
 * W9 regressions: a lease-expiry checkpoint failure is non-fatal and re-pends
 * the task, but a different member then has to prepare that task. Pre-fix that
 * recovery called `captureArtifact` on the previous owner's dirty workspace,
 * threw on the out-of-scope partial work, and `schedule()` marked the task
 * `blocked` forever. The fix left the previous owner's worktree untouched and
 * re-created a clean baseline from the last durable checkpoint (or the recorded
 * task base). H-3 (round 19) goes further: that worktree is snapshotted into the
 * preservation refs and the replacement starts from the snapshot, so the
 * uncaptured work travels with the task, and the fallback is a durable event,
 * an owner notice and a `task.recovery` summary instead of a host-memory line.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { runProcess } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'
import { makeWorkspaces } from './faults/harness.mjs'

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
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 })
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
  const workers = new RealWorkers()
  // Every fallback report the host was handed, in order. `Workspaces` keeps no
  // in-memory mirror of its own: the callback is the whole channel.
  const reports = []
  // Production shape (src/harness-workers.ts): the fallback report reaches the bound runtime callbacks.
  const workspaces = makeWorkspaces(root, { onRecoveryFallback: info => { reports.push(info); workers.callbacks?.recoveryFallback?.(info) } })
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
  return { root, source, workspaces, workers, runtime, owner, mission, stream, author, reviewer, actor, current, events, reports }
}

test('W9: a cross-member recovery from a dirty workspace carries its preserved snapshot to the new owner instead of blocking', async t => {
  const f = await fixture(t)
  const task = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Implement', objective: 'Implement',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test -d .'] })
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
    fallbacksAtRecovery = f.reports.slice()
    return current
  }, 'the task is recovered by the other member')
  assert.equal(f.current(task.id).status, 'running')
  // One distinct recovery fact, sampled at the observation above. The runtime may
  // re-derive the same fallback on each preparation retry (and the epoch differs
  // between retries), so the assertion is over the distinct fact, not the retry
  // count: a second, *different* fallback for this handover would still fail here.
  const factOf = ({ epoch, ...rest }) => JSON.stringify(rest)
  const distinctFallbacks = new Map(fallbacksAtRecovery.map(info => [factOf(info), info]))
  assert.equal(distinctFallbacks.size, 1, `one recovery fact, not several: ${[...distinctFallbacks.keys()].join(' | ')}`)
  const [fallback] = distinctFallbacks.values()
  assert.match(fallback.reason, /outside task scope/, 'the fallback names the real reason')
  assert.equal(fallback.previousOwnerId, f.author.id, 'the fallback names the previous owner')
  assert.equal(fallback.memberId, f.reviewer.id, 'the fallback names the replacement')
  assert.equal(fallback.taskId, task.id, 'the fallback names the task')
  assert.equal(fallback.missionId, f.mission.id)
  assert.deepEqual(f.events('task/blocked'), [], 'preparation never dead-ends the task')
  const reviewerWorkspace = f.runtime.store.get('members', f.reviewer.id).workspace
  // H-3: the uncapturable worktree is snapshotted into the preservation refs and
  // the replacement starts from that snapshot, so the out-of-scope partial edit
  // travels with the task instead of staying behind in the old worktree.
  const snapshot = await git(reviewerWorkspace, 'rev-parse', 'HEAD')
  assert.notEqual(snapshot, base, 'the recovered attempt inherits the preserved snapshot, not the bare base')
  assert.equal(await git(reviewerWorkspace, 'rev-parse', 'HEAD^'), base, 'the inherited snapshot sits on the recorded task base')
  assert.equal(fallback.commit, snapshot, 'the fallback names the preserved snapshot the replacement inherited')
  assert.equal(fallback.preserved, true, 'and reports that the WIP really was preserved')
  assert.equal(await git(reviewerWorkspace, 'status', '--porcelain'), '', 'the inherited checkout is clean')
  assert.equal(await readFile(join(reviewerWorkspace, 'outside.txt'), 'utf8'), 'out of scope partial edit\n', 'the replacement inherits the uncaptured work')
  assert.equal(await readFile(join(authorWorkspace, 'outside.txt'), 'utf8'), 'out of scope partial edit\n', 'the previous owner worktree is preserved untouched')
  const recordPath = join(f.root, 'worktrees', f.mission.id, 'tasks', `${task.id}.json`)
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  assert.equal(record.memberId, f.reviewer.id)
  assert.equal(record.task.recovery.commit, snapshot, 'the durable record names the inherited snapshot')
  assert.equal(record.task.recovery.previousOwnerId, f.author.id)
  assert.equal(record.task.recovery.preserved, true)
  // The fallback is a durable, owner-visible fact, not only a host-memory line (H-3).
  assert.ok(f.events('task/recovery-fallback').length >= 1, 'the fallback is recorded in the mission log')
  assert.equal(f.current(task.id).recovery?.previousOwnerId, f.author.id, 'the task row carries the recovery summary')
  // The inherited snapshot carries the out-of-scope edit the artifact refused; a
  // real replacement decides what to do with it. Here it is dropped so the
  // submission below stays within scope.
  await rm(join(reviewerWorkspace, 'outside.txt'))
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
