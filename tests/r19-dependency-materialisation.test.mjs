/**
 * Round-19 H-2 / M-d: dependency materialisation is host infrastructure.
 *
 * H-2. `Workspaces.verifyArtifact` copies the source's ignored dependency
 * directories into the clean checkout before the first declared command runs
 * (the effective default mode is `copy`, R11-13). A pnpm/npm workspace symlink
 * farm, or a dangling install link, made that copy throw a plain `Error` with
 * no errno `code`, which the declared-check classifier could not recognise:
 * every `swarm_verify` on a task with checks escaped as a throw, the review
 * stayed running, nothing durable was written and there was no deferral and no
 * guided exit. On this repository (288 escaping symlinks) the check pipeline
 * was unusable under the default configuration. Both sites now throw
 * `DependencyMaterialisationError`, which the declared-check layer treats like
 * a coded I/O failure: a `(verification preparation)` row with exit 125 and
 * `failureKind: 'infrastructure'`, the retry rule, and a deferred review whose
 * output names the two documented ways out.
 *
 * M-d. The copy ran after the check slot was taken and before the timed
 * command, so a slow copy held a slot other verifications were queued for. It
 * now runs before `acquire`; the measured run time and the check deadline start
 * with the command.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DependencyMaterialisationError } from '../lib/workspaces.js'
import { MISSION_ACCEPTANCE, WorkspaceWorkers, Workspaces, eventually, events, git, makeRepo, setup, taskOf } from './faults/harness.mjs'
import { subprocessSeam } from './subprocess-seam.mjs'

const CHECK = 'test -f node_modules/dep/index.js'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const workspaceOptions = (root, extra = {}) => ({
  subprocess: subprocessSeam, workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv, ...extra,
})

/** The pnpm/npm workspace shape: a gitignored `node_modules` whose package entry links out of the checkout. */
async function escapingInstall(repo) {
  await mkdir(join(repo.root, 'external', 'dep-package'), { recursive: true })
  await writeFile(join(repo.root, 'external', 'dep-package', 'index.js'), 'module.exports = 1\n')
  await mkdir(join(repo.source, 'node_modules'))
  await symlink(join(repo.root, 'external', 'dep-package'), join(repo.source, 'node_modules', 'dep'))
}

/** Every verification checkout this root ever held; a clean run leaves none behind. */
async function verificationCheckouts(root) {
  const missions = await readdir(join(root, 'worktrees')).catch(() => [])
  const found = []
  for (const mission of missions) found.push(...(await readdir(join(root, 'worktrees', mission, 'verification')).catch(() => [])))
  return found
}

/** A real Workspaces engine behind the real runtime, so the copy is the real copy. */
async function reviewFixture(t, install = escapingInstall) {
  const repo = await makeRepo('r19-h2', { 'src/answer.txt': 'base\n', '.gitignore': 'node_modules/\n' })
  await install(repo)
  const workspaces = new Workspaces(workspaceOptions(repo.root))
  const workers = new WorkspaceWorkers(workspaces)
  const f = await setup({ workers, workspace: repo.source, config: { tickMs: 60_000 } })
  const disposals = [workspaces]
  t.after(async () => { await f.cleanup(); for (const engine of disposals) await engine.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  const source = f.propose({ checks: [CHECK] })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await writeFile(join(f.author.workspace, 'src/answer.txt'), 'candidate\n')
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Review', objective: 'Independently review the scoped change',
    kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  return { ...f, repo, workspaces, source, review, disposals,
    verify: (attemptId = taken.attempt.id) => f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId, verdict: 'accept', reason: 'Review against acceptance' }),
    runs: () => f.runtime.store.list('tool_runs', f.mission.id).filter(run => run.tool === 'swarm.host_verification'),
    events: type => events(f.runtime, f.mission.id, type),
  }
}

test('R19-H2: an escaping dependency link defers the review as infrastructure, and the documented link opt-in repairs it', async t => {
  const f = await reviewFixture(t)
  const verdict = await f.verify()
  assert.equal(verdict.status, 'blocked', 'the review is deferred, not rejected')
  assert.equal(taskOf(f.runtime, f.source.id).status, 'submitted', 'the immutable source stays submitted')
  assert.equal(verdict.verificationRecovery.commit, taskOf(f.runtime, f.source.id).artifact.commit)
  assert.equal(f.events('task/verification-deferred').length, 1)
  assert.equal(f.events('task/rejected').length, 0)
  assert.equal(f.events('task/accepted').length, 0)
  assert.equal(f.workers.verified.length, 2, 'the retry rule ran the preparation twice on the same artifact')
  const runs = f.runs()
  assert.deepEqual(runs.map(run => run.arguments.attempt), [1, 2], 'both passes are durable')
  for (const run of runs) {
    assert.equal(run.result.command, '(verification preparation)', 'no declared command is pretended to have run')
    assert.equal(run.result.exitCode, 125)
    assert.equal(run.result.failureKind, 'infrastructure')
    assert.equal(run.isError, true)
    assert.match(run.result.output, /Host verification could not execute: .*\[dependency_copy_escape\]/)
    assert.match(run.result.output, /node_modules\/dep/, 'the offending link is named')
    assert.match(run.result.output, /verificationDependencyMode.*link.*allowDependencyLinkReads/, 'the first documented way out')
    assert.match(run.result.output, /verificationDependencyDirs/, 'the second documented way out')
  }
  assert.match(verdict.output, /swarm_control\(action: "resume"/, 'the guided exit is on the review')
  assert.match(verdict.output, /allowDependencyLinkReads/, 'the repair path reaches the reviewer and the owner')
  assert.deepEqual(await verificationCheckouts(f.repo.root), [], 'the refused checkout is removed on the failure path')

  // The host operator takes the first way out: a restart with the explicit
  // link-read opt-in. The same review resumes against the same artifact.
  const repaired = new Workspaces(workspaceOptions(f.repo.root, { verificationDependencyMode: 'link', allowDependencyLinkReads: true }))
  f.disposals.push(repaired)
  f.workers.workspaces = repaired
  await f.runtime.controlTask(f.owner, f.mission.id, f.review.id, 'resume', {}, 'host enabled dependency link reads')
  await eventually(() => taskOf(f.runtime, f.review.id).status === 'pending', 'owner recovery re-pends the same review')
  const retry = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, f.review.id)
  const accepted = await f.verify(retry.attempt.id)
  assert.equal(accepted.status, 'accepted')
  assert.equal(taskOf(f.runtime, f.source.id).status, 'accepted')
  const later = f.runs().filter(run => run.attemptId === retry.attempt.id)
  assert.deepEqual(later.map(run => [run.result.command, run.result.exitCode]), [[CHECK, 0]], 'the declared check really ran through the link')
  assert.equal(later[0].result.environment.dependencyLinks.mode, 'link')
  assert.deepEqual(later[0].result.environment.dependencyLinks.materializedPaths, ['node_modules'])
  assert.deepEqual(await verificationCheckouts(f.repo.root), [])
})

test('R19-H2: a dangling dependency root is the same typed error, and the checkout is cleaned up', async t => {
  const repo = await makeRepo('r19-h2-dangling', { 'src/answer.txt': 'base\n', '.gitignore': 'node_modules\n' })
  await symlink(join(repo.root, 'missing-installation'), join(repo.source, 'node_modules'))
  const workspaces = new Workspaces(workspaceOptions(repo.root))
  t.after(async () => { await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  const mission = { id: 'mission-dangling', workspace: repo.source }
  const member = { id: 'member-dangling', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-dangling') }
  const task = { id: 'task-dangling', missionId: mission.id, epoch: 1, title: 'Work', kind: 'implementation', scope: ['src/'], checks: [CHECK], status: 'running' }
  await workspaces.prepareTask(member, task, [])
  await writeFile(join(member.workspace, 'src', 'answer.txt'), 'changed\n')
  const artifact = await workspaces.captureArtifact(member, task)
  await assert.rejects(workspaces.verifyArtifact(member, task, artifact), error => {
    assert.ok(error instanceof DependencyMaterialisationError)
    assert.equal(error.name, 'DependencyMaterialisationError')
    assert.match(error.message, /^\[dependency_directory_unavailable\]/)
    assert.match(error.message, /verificationDependencyDirs/)
    assert.deepEqual(error.cause, { dependency: 'node_modules' })
    return true
  })
  assert.deepEqual(await verificationCheckouts(repo.root), [], 'the checkout is removed on the failure path')
  assert.equal(workspaces.checkEnvelope().completed, 0, 'no check slot was consumed by the refused preparation')
})

test('R19-H2: the declared-check layer classifies the typed error as infrastructure without a real engine', async () => {
  const f = await setup({ checks: [CHECK] })
  try {
    f.workers.verifyArtifact = async () => { throw new DependencyMaterialisationError('dependency_copy_escape', 'A dependency link leaves its dependency directory.', 'node_modules/@scope/pkg') }
    const task = f.propose()
    const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
    await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: task.id, attemptId: claimed.attempt.id, output: 'candidate' })
    const review = f.runtime.propose(f.owner, f.mission.id, {
      workstreamId: f.stream.id, title: 'Review', objective: 'Independent review', kind: 'verification',
      reviewOf: task.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
    })
    const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    const verdict = await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason: 'Review against acceptance' })
    assert.equal(verdict.status, 'blocked')
    assert.equal(taskOf(f.runtime, task.id).status, 'submitted')
    const runs = f.runtime.store.list('tool_runs', f.mission.id).filter(run => run.taskId === review.id)
    assert.deepEqual(runs.map(run => [run.result.command, run.result.exitCode, run.result.failureKind]),
      [['(verification preparation)', 125, 'infrastructure'], ['(verification preparation)', 125, 'infrastructure']])
    assert.match(runs[0].result.output, /node_modules\/@scope\/pkg/)
    assert.equal(events(f.runtime, f.mission.id, 'task/verification-deferred').length, 1)
  } finally { await f.cleanup() }
})

test('R19-M-d: dependency materialisation runs before the check slot is taken and outside the check deadline', async t => {
  const HOLD_MS = 1_000
  const repo = await makeRepo('r19-md', { 'src/answer.txt': 'base\n', '.gitignore': 'node_modules/\n' })
  await mkdir(join(repo.source, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(repo.source, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  // One slot, and a check deadline shorter than the hold on the copy below.
  const workspaces = new Workspaces(workspaceOptions(repo.root, { checkConcurrency: 1, checkTimeoutMs: HOLD_MS / 2 }))
  t.after(async () => { await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  const mission = { id: 'mission-slot', workspace: repo.source }
  const prepared = []
  for (const id of ['slow', 'fast']) {
    const member = { id: `member-${id}`, missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, `member-${id}`) }
    const task = { id: `task-${id}`, missionId: mission.id, epoch: 1, title: 'Work', kind: 'implementation', scope: ['src/'], checks: [CHECK], status: 'running' }
    await workspaces.prepareTask(member, task, [])
    await writeFile(join(member.workspace, 'src', 'answer.txt'), `changed by ${id}\n`)
    prepared.push({ member, task, artifact: await workspaces.captureArtifact(member, task) })
  }
  const [slow, fast] = prepared
  // Instrument the two seams whose order is the contract: the first
  // materialisation holds until released, the semaphore logs every slot change.
  const log = []
  const gate = deferred(), reached = deferred()
  const materialise = workspaces.linkDependencyDirs
  let materialisations = 0
  workspaces.linkDependencyDirs = async function (...args) {
    const index = ++materialisations
    log.push(`materialise-start ${index}`)
    if (index === 1) { reached.resolve(); await gate.promise }
    const linked = await materialise.apply(this, args)
    log.push(`materialise-end ${index}`)
    return linked
  }
  const semaphore = workspaces.checks
  const acquire = semaphore.acquire.bind(semaphore), release = semaphore.release.bind(semaphore)
  semaphore.acquire = async signal => { const waited = await acquire(signal); log.push('slot-acquired'); return waited }
  semaphore.release = runMs => { log.push('slot-released'); release(runMs) }
  try {
    const first = workspaces.verifyArtifact(slow.member, slow.task, slow.artifact)
    await reached.promise
    const second = workspaces.verifyArtifact(fast.member, fast.task, fast.artifact)
    const outcome = await Promise.race([second.then(() => 'completed'), new Promise(resolve => setTimeout(() => resolve('still queued'), 8_000))])
    assert.equal(outcome, 'completed', 'the second verification took the only slot while the first was still materialising')
    assert.deepEqual(log, ['materialise-start 1', 'materialise-start 2', 'materialise-end 2', 'slot-acquired', 'slot-released'], 'no slot was held during the first materialisation')
    await new Promise(resolve => setTimeout(resolve, HOLD_MS))
    gate.resolve()
    const results = await first
    assert.deepEqual(log.slice(5), ['materialise-end 1', 'slot-acquired', 'slot-released'], 'the slot is taken only after the copy has landed')
    assert.deepEqual(results.map(result => result.exitCode), [0], 'a deadline shorter than the copy hold did not fire: it starts with the command')
    assert.deepEqual((await second).map(result => result.exitCode), [0])
    const envelope = workspaces.checkEnvelope()
    assert.equal(envelope.maxActive, 1)
    assert.equal(envelope.completed, 2)
    assert.ok(envelope.maxRunMs < HOLD_MS, `the measured run time excludes materialisation, saw maxRunMs=${envelope.maxRunMs}`)
  } finally { gate.resolve() }
})
