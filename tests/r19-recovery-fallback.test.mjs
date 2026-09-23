/**
 * R19 H-3: a cross-owner recovery whose `captureArtifact` refuses the previous
 * owner's worktree (out-of-scope WIP) used to start the replacement from the
 * last durable checkpoint or the task base, leave every uncaptured change in
 * the old worktree, and report that only into an in-memory list nobody read:
 * no durable event, no owner notice, nothing in `swarm_observe`. The
 * production stop barrier (lease expiry, handoff, close-out) preserves WIP
 * first, so only the paths without one were silent: a host restart re-pend and
 * the start-failure re-route or owner amend that follows it.
 *
 * Now recovery snapshots the old worktree into the preservation refs exactly
 * as the stop barrier does and the replacement inherits that snapshot; when
 * even preservation fails, the fallback is a durable `task/recovery-fallback`
 * event, an owner notice and a `task.recovery` summary the owner can observe.
 *
 * End-to-end through SwarmRuntime with a PRODUCTION-SHAPED Workers adapter
 * (checkpointTask wired, exactly like HarnessWorkers) and Workspaces
 * constructed as src/harness-workers.ts constructs it, with the callbacks the
 * adapter now forwards.
 *
 * Follow-ups (E, F): a repeated report of the same fallback (same previous
 * owner, same commit) is not a second event or notice, and the sibling silent
 * channel, a verification checkout the host could not remove, is a durable
 * `task/verification-cleanup-failed` event and an owner notice while the
 * verdict itself still completes.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 3, maxDurationMs: 3600000, maxTasks: 100, maxExperiments: 0 }
/** A bound on a wedged runtime, not on a busy machine (real git work runs between ticks). */
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
const exists = file => stat(file).then(() => true, () => false)

/**
 * The production seam with `git worktree remove` refused for verification
 * checkouts only: the disposable tree stays registered and present after the
 * checks ran, which is the cleanup failure the adapter must report. Every other
 * command (member worktrees, capture, the checks themselves) runs unchanged.
 */
const refusingVerificationRemoval = () => {
  const real = subprocessSeam()
  const refused = argv => argv[0] === 'git' && argv.includes('worktree') && argv.includes('remove') && argv.some(arg => arg.includes('/verification/'))
  return { spawn: spec => real.spawn(refused(spec.argv) ? { ...spec, argv: ['/bin/sh', '-c', 'echo "fatal: simulated: worktree remove refused" >&2; exit 128'] } : spec) }
}

/** Production-shaped: every Workers method HarnessWorkers forwards to Workspaces, including checkpointTask and both Workspaces report callbacks. */
class ProdShapeWorkers {
  idle = new Set()
  failStart = new Map()
  constructor(root, subprocess = subprocessSeam) {
    // Same option shape as src/harness-workers.ts: the fallback and cleanup
    // reports reach the bound runtime callbacks, nothing else is wired. The
    // callbacks are the whole channel (`Workspaces` keeps no in-memory mirror),
    // so the test also records every report it was handed, in order.
    this.reports = { fallbacks: [], cleanups: [] }
    this.workspaces = new Workspaces({ subprocess, workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv,
      onRecoveryFallback: info => { this.reports.fallbacks.push(info); this.callbacks?.recoveryFallback?.(info) },
      onCleanupFailure: info => { this.reports.cleanups.push(info); this.callbacks?.verificationCleanupFailure?.(info) } })
  }
  bind(callbacks) { this.callbacks = callbacks }
  async prepareBaseline(mission, signal) { return await this.workspaces.prepareBaseline(mission, signal) }
  async prepareWorkspace(mission, memberId) { return await this.workspaces.prepareWorkspace(mission, memberId) }
  async start(spec) { const error = this.failStart.get(spec.member.id); if (error) throw error }
  async deliver() {}
  async stop() {}
  isIdle(memberId) { return this.idle.has(memberId) }
  async prepareTask(member, task, dependencies, reviewSource) { await this.workspaces.prepareTask(member, task, dependencies, reviewSource) }
  checkpointTask(member, task, options) { return this.workspaces.checkpointTask(member, task, options) }
  async captureArtifact(member, task, deliverables) { return await this.workspaces.captureArtifact(member, task, deliverables) }
  async verifyArtifact(member, task, artifact, signal) { return await this.workspaces.verifyArtifact(member, task, artifact, signal) }
  async dispose() { await this.workspaces.dispose() }
}
const makeRuntime = (root, workers) => new SwarmRuntime({ statePath: join(root, 'state.sqlite'), leaseMs: 60000, tickMs: 20, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 100 }, workers)

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'swarm-r19-h3-')))
  const source = join(root, 'source')
  await mkdir(join(source, 'src'), { recursive: true })
  await git(source, 'init', '-b', 'main')
  await writeFile(join(source, 'src', 'answer.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const workers = new ProdShapeWorkers(root, options.subprocess)
  const runtime = makeRuntime(root, workers)
  const owner = { sessionId: 'r19-h3-owner' }
  const mission = runtime.create(owner, { title: 'H3', objective: 'recovery fallback is preserved and surfaced', workspace: source, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  await runtime.start()
  const f = { root, source, workers, runtime, owner, mission, stream, author, reviewer }
  f.actor = member => ({ sessionId: member.sessionId })
  f.current = rt => taskId => rt.store.get('tasks', taskId)
  f.events = rt => rt.store.events(mission.id, 500)
  f.taskRecord = taskId => readFile(join(root, 'worktrees', mission.id, 'tasks', `${taskId}.json`), 'utf8').then(JSON.parse)
  f.propose = (overrides = {}) => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Implement', objective: 'Implement', kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks: ['test -d .'], ...overrides })
  /** Author claims, then leaves in-scope and out-of-scope WIP in its worktree. */
  f.claimWithWip = async task => {
    await runtime.claim(f.actor(author), mission.id, task.id)
    const authorWs = runtime.store.get('members', author.id).workspace
    const base = await git(authorWs, 'rev-parse', 'HEAD')
    await writeFile(join(authorWs, 'src', 'answer.txt'), 'in-scope partial\n')
    await writeFile(join(authorWs, 'outside.txt'), 'out of scope partial edit\n')
    return { authorWs, base }
  }
  /** The host dies without a stop barrier; a new host process recovers the same state. */
  f.restart = async () => {
    await runtime.dispose(); await workers.dispose()
    f.workers2 = new ProdShapeWorkers(root)
    f.workers2.idle.add(author.id); f.workers2.idle.add(reviewer.id)
    f.runtime2 = makeRuntime(root, f.workers2)
    return f
  }
  f.reviewerTookOver = rt => taskId => eventually(() => { const c = f.current(rt)(taskId); return c.status === 'running' && c.attempt?.ownerId === reviewer.id ? c : undefined }, 'reviewer took over')
  t.after(async () => {
    for (const rt of [f.runtime2, runtime]) { try { await rt?.dispose() } catch { /* already disposed */ } }
    for (const w of [f.workers2, workers]) { try { await w?.dispose() } catch { /* already disposed */ } }
    await rm(root, { recursive: true, force: true })
  })
  return f
}

/** What the owner can see of a fallback: the durable event, the owner notice and the observe projection. */
function surfacing(rt, missionId, taskId, owner) {
  const events = rt.store.events(missionId, 500).filter(event => event.type === 'task/recovery-fallback')
  const needle = /uncaptured work/
  const notices = rt.store.list('deliveries', missionId).filter(delivery => delivery.to === 'owner' && delivery.from === 'runtime'
    && (needle.test(delivery.content ?? '') || needle.test(JSON.stringify(delivery.notice ?? {}))))
  const observed = rt.observe(owner, missionId, { taskId, detail: 'full' })
  return { events, notices, recovery: observed.task.recovery, board: rt.observe(owner, missionId).board.find(item => item.id === taskId)?.recovery }
}

function assertSurfaced(s, { taskId, from, to, preserved, commit }) {
  assert.equal(s.events.length, 1, 'exactly one durable recovery-fallback event')
  const [event] = s.events
  assert.equal(event.actor, 'runtime')
  assert.equal(event.data.taskId, taskId)
  assert.equal(event.data.from, from, 'the event names the previous owner')
  assert.equal(event.data.to, to, 'the event names the replacement')
  assert.equal(event.data.preserved, preserved)
  assert.equal(event.data.commit, commit)
  assert.match(event.data.reason, /outside task scope/, 'the event carries the capture refusal')
  assert.ok(s.notices.length >= 1, 'the owner was notified through the notice path')
  assert.ok(s.recovery, 'swarm_observe projects task.recovery')
  assert.equal(s.recovery.previousOwnerId, from)
  assert.equal(s.recovery.preserved, preserved)
  assert.equal(s.recovery.commit, commit)
  assert.match(s.recovery.reason, /outside task scope/)
  assert.deepEqual(s.board, s.recovery, 'the compact board record carries the same summary')
}

test('A. lease expiry (production stop barrier): no fallback, the replacement inherits in-scope and out-of-scope WIP', async t => {
  const f = await fixture(t)
  const task = f.propose()
  const { base } = await f.claimWithWip(task)
  const planned = f.current(f.runtime)(task.id)
  planned.plannedAssigneeId = f.reviewer.id
  planned.attempt.leaseUntil = Date.now() - 1
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', planned))
  f.workers.idle.add(f.author.id); f.workers.idle.add(f.reviewer.id)
  await eventually(() => f.events(f.runtime).find(e => e.type === 'task/checkpoint-failed'), 'lease-expiry checkpoint failure audited')
  await f.reviewerTookOver(f.runtime)(task.id)
  const reviewerWs = f.runtime.store.get('members', f.reviewer.id).workspace
  assert.equal(f.workers.reports.fallbacks.length, 0, 'the stop barrier preserved WIP first; the fallback is never reached')
  assert.deepEqual(f.events(f.runtime).filter(e => e.type === 'task/recovery-fallback'), [])
  assert.equal(f.current(f.runtime)(task.id).recovery, undefined)
  assert.equal(await readFile(join(reviewerWs, 'src', 'answer.txt'), 'utf8'), 'in-scope partial\n')
  assert.equal(await readFile(join(reviewerWs, 'outside.txt'), 'utf8'), 'out of scope partial edit\n')
  assert.equal(await git(reviewerWs, 'rev-parse', 'HEAD^'), base, 'the inherited snapshot sits on the task base')
})

test('B. host restart + provider outage re-route: the replacement inherits the preserved WIP and the fallback is surfaced', async t => {
  const f = await fixture(t)
  const task = f.propose()
  const { authorWs, base } = await f.claimWithWip(task)
  await f.restart()
  f.workers2.failStart.set(f.author.id, Object.assign(new Error('provider rate limit exceeded'), { status: 429 }))
  await f.runtime2.start()
  await eventually(() => f.events(f.runtime2).find(e => e.type === 'task/restart-repended'), 'restart re-pend')
  await eventually(() => f.events(f.runtime2).find(e => e.type === 'task/reassigned'), 'automatic re-route to another member')
  await f.reviewerTookOver(f.runtime2)(task.id)
  const reviewerWs = f.runtime2.store.get('members', f.reviewer.id).workspace
  const snapshot = await git(reviewerWs, 'rev-parse', 'HEAD')
  assert.notEqual(snapshot, base, 'the replacement starts from the preservation snapshot, not the bare base')
  assert.equal(await git(reviewerWs, 'rev-parse', 'HEAD^'), base, 'the snapshot sits on the task base')
  assert.equal(await git(reviewerWs, 'status', '--porcelain'), '', 'the inherited checkout is clean')
  assert.equal(await readFile(join(reviewerWs, 'src', 'answer.txt'), 'utf8'), 'in-scope partial\n', 'in-scope WIP carried')
  assert.equal(await readFile(join(reviewerWs, 'outside.txt'), 'utf8'), 'out of scope partial edit\n', 'out-of-scope WIP carried too')
  assert.equal(await readFile(join(authorWs, 'outside.txt'), 'utf8'), 'out of scope partial edit\n', 'the previous owner worktree is untouched')
  const record = await f.taskRecord(task.id)
  assert.equal(record.memberId, f.reviewer.id)
  assert.equal(record.task.recovery.commit, snapshot)
  assert.equal(record.task.recovery.preserved, true)
  const fallbacks = f.workers2.reports.fallbacks
  assert.equal(fallbacks.length, 1)
  assert.match(fallbacks[0].reason, /outside task scope/)
  assertSurfaced(surfacing(f.runtime2, f.mission.id, task.id, f.owner), { taskId: task.id, from: f.author.id, to: f.reviewer.id, preserved: true, commit: snapshot })
  const [notice] = surfacing(f.runtime2, f.mission.id, task.id, f.owner).notices
  assert.match(notice.content ?? JSON.stringify(notice.notice), /out-of-scope/, 'the notice tells the owner the inherited work includes what the artifact refused')
  // The new owner sees the summary in its own assignment.
  const assignment = f.runtime2.store.list('deliveries', f.mission.id).filter(d => d.kind === 'assignment' && d.to === f.reviewer.id).at(-1)
  assert.equal(JSON.parse(assignment.content).task.recovery.previousOwnerId, f.author.id)
})

test('C. host restart + owner amend assigneeId: same inheritance, same surfacing', async t => {
  const f = await fixture(t)
  const task = f.propose()
  const { base } = await f.claimWithWip(task)
  await f.restart()
  // The old owner never comes back (retired session): block its start so the task stays pending on it.
  f.workers2.failStart.set(f.author.id, new Error('worker bootstrap failed'))
  await f.runtime2.start()
  await eventually(() => f.events(f.runtime2).find(e => e.type === 'task/restart-repended'), 'restart re-pend')
  await eventually(() => f.current(f.runtime2)(task.id).status === 'pending', 'pending after restart')
  f.runtime2.controlTask(f.owner, f.mission.id, task.id, 'amend', { assigneeId: f.reviewer.id }, 'route to reviewer')
  await f.reviewerTookOver(f.runtime2)(task.id)
  const reviewerWs = f.runtime2.store.get('members', f.reviewer.id).workspace
  const snapshot = await git(reviewerWs, 'rev-parse', 'HEAD')
  assert.equal(await git(reviewerWs, 'rev-parse', 'HEAD^'), base)
  assert.equal(await readFile(join(reviewerWs, 'src', 'answer.txt'), 'utf8'), 'in-scope partial\n')
  assert.equal(await readFile(join(reviewerWs, 'outside.txt'), 'utf8'), 'out of scope partial edit\n')
  assertSurfaced(surfacing(f.runtime2, f.mission.id, task.id, f.owner), { taskId: task.id, from: f.author.id, to: f.reviewer.id, preserved: true, commit: snapshot })
})

test('D. preservation impossible: the replacement starts from the task base and the fallback is still surfaced', async t => {
  const f = await fixture(t)
  const task = f.propose()
  const { authorWs, base } = await f.claimWithWip(task)
  await f.restart()
  // The preservation store cannot be written (a file squats on its directory),
  // so neither capture nor the snapshot can carry the WIP.
  const preservation = join(f.root, 'worktrees', f.mission.id, 'preservation')
  await rm(preservation, { recursive: true, force: true })
  await writeFile(preservation, 'not a directory\n')
  f.workers2.failStart.set(f.author.id, new Error('worker bootstrap failed'))
  await f.runtime2.start()
  await eventually(() => f.current(f.runtime2)(task.id).status === 'pending', 'pending after restart')
  f.runtime2.controlTask(f.owner, f.mission.id, task.id, 'amend', { assigneeId: f.reviewer.id }, 'route to reviewer')
  await f.reviewerTookOver(f.runtime2)(task.id)
  const reviewerWs = f.runtime2.store.get('members', f.reviewer.id).workspace
  assert.equal(await git(reviewerWs, 'rev-parse', 'HEAD'), base, 'without a snapshot the replacement starts from the recorded base')
  assert.equal(await readFile(join(reviewerWs, 'src', 'answer.txt'), 'utf8'), 'base\n')
  assert.equal(await exists(join(reviewerWs, 'outside.txt')), false)
  assert.equal(await readFile(join(authorWs, 'outside.txt'), 'utf8'), 'out of scope partial edit\n', 'the previous owner worktree still holds the WIP')
  const s = surfacing(f.runtime2, f.mission.id, task.id, f.owner)
  assertSurfaced(s, { taskId: task.id, from: f.author.id, to: f.reviewer.id, preserved: false, commit: base })
  assert.match(s.events[0].data.reason, /preservation failed/, 'the event says why the WIP could not be carried')
  assert.match(s.notices[0].content ?? JSON.stringify(s.notices[0].notice), /worktree/, 'the notice tells the owner where the work still is')
})

test('E. a second recovery of the same previous owner and commit records no second event or notice', async t => {
  // A re-preparation (the replacement's own start failed, or the same task was
  // re-pended and re-routed) re-trips capture on the same untouched worktree
  // and reports the same fallback again, under a new attempt epoch.
  const f = await fixture(t)
  const task = f.propose()
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  const base = await git(f.source, 'rev-parse', 'HEAD')
  const info = { missionId: f.mission.id, taskId: task.id, epoch: 1, memberId: f.reviewer.id, previousOwnerId: f.author.id, commit: base, preserved: false, reason: 'outside task scope: outside.txt; preservation failed: no snapshot commit was recorded' }
  f.runtime.onRecoveryFallback(info)
  f.runtime.onRecoveryFallback({ ...info, epoch: 2 })
  const s = surfacing(f.runtime, f.mission.id, task.id, f.owner)
  assertSurfaced(s, { taskId: task.id, from: f.author.id, to: f.reviewer.id, preserved: false, commit: base })
  assert.equal(s.notices.length, 1, 'the repeated fallback is not a new owner fact')
  assert.equal(s.recovery.epoch, 1, 'the recorded summary is the first report')
  // A different snapshot is a new fact: the WIP was carried this time.
  const snapshot = await git(f.source, 'rev-parse', 'HEAD')
  f.runtime.onRecoveryFallback({ ...info, epoch: 3, commit: `${snapshot.slice(0, -1)}${snapshot.endsWith('0') ? '1' : '0'}`, preserved: true, reason: 'outside task scope: outside.txt' })
  const after = surfacing(f.runtime, f.mission.id, task.id, f.owner)
  assert.equal(after.events.length, 2, 'a fallback onto a different commit is recorded')
  assert.equal(after.notices.length, 2)
  assert.equal(after.recovery.epoch, 3)
})

test('F. a verification checkout that cannot be removed is a durable event and an owner notice; the verdict stands', async t => {
  const f = await fixture(t, { subprocess: refusingVerificationRemoval })
  const source = f.propose({ checks: ['test -f src/answer.txt && echo checked'] })
  const claim = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await writeFile(join(f.runtime.store.get('members', f.author.id).workspace, 'src', 'answer.txt'), 'answer\n')
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claim.attempt.id, output: 'ready for review' })
  const review = f.runtime.propose(f.owner, f.mission.id, { workstreamId: f.stream.id, title: 'Review', objective: 'Review', kind: 'verification', reviewOf: source.id, scope: ['src/'], acceptance: ['works'], checks: ['test -f src/answer.txt && echo checked'], assigneeId: f.reviewer.id })
  const reviewClaim = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  const verdict = await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewClaim.attempt.id, verdict: 'accept', reason: 'Independent review' })
  assert.equal(verdict.status, 'accepted', 'the cleanup failure never masks the check result')
  assert.equal(f.current(f.runtime)(source.id).status, 'accepted')
  const failures = f.workers.reports.cleanups
  assert.equal(failures.length, 1, JSON.stringify(failures))
  assert.match(failures[0].reason, /worktree remove refused/)
  const verification = join(f.root, 'worktrees', f.mission.id, 'verification')
  assert.deepEqual(await readdir(verification), [], 'the fallback removal still reclaimed the checkout')
  const events = f.events(f.runtime).filter(event => event.type === 'task/verification-cleanup-failed')
  assert.equal(events.length, 1, 'exactly one durable cleanup-failure event')
  const [event] = events
  assert.equal(event.actor, 'runtime')
  assert.equal(event.data.taskId, source.id, 'the event names the task whose checks ran')
  assert.equal(event.data.memberId, f.reviewer.id, 'and the verifying member')
  assert.ok(typeof event.data.checkout === 'string' && event.data.checkout.startsWith(`${verification}/`), `the event names the checkout: ${event.data.checkout}`)
  assert.match(event.data.reason, /worktree remove refused/, 'the event carries the removal failure')
  const notices = f.runtime.store.list('deliveries', f.mission.id).filter(delivery => delivery.to === 'owner' && delivery.from === 'runtime' && delivery.notice?.trigger === 'task/verification-cleanup-failed')
  assert.equal(notices.length, 1, 'one owner notice')
  assert.match(notices[0].content, /could not be removed/)
  assert.match(notices[0].content, /worktree remove refused/)
  assert.ok(notices[0].content.includes(event.data.checkout), 'the notice names the checkout the owner has to look at')
  assert.ok(notices[0].notice.subjects.some(subject => subject.startsWith(`${source.id}@`)), 'the notice is attributed to the verified task')
})
