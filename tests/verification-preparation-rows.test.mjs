/**
 * A host that cannot prepare or confine a declared check defers the review; it
 * never makes `swarm_verify` throw.
 *
 * Before this pass the declared-check layer (`DeclaredChecks.execute`) turned a
 * thrown verification failure into a deferring row only for two error names and
 * eight errno codes. Three real shapes escaped it, so the review stayed running
 * with no durable record, no deferral and no guided exit:
 *
 *  - `git worktree add` exiting non-zero (`Workspaces.git` throws a codeless
 *    `Error`, for example exit 128 on a locked or corrupted repository);
 *  - a sandbox provider reporting partial enforcement (`confinedCheckArgv`
 *    refuses with a codeless `Error`: F-29, fail closed);
 *  - a dependency copy failing with a code outside the list (ENOSPC, EROFS,
 *    ENOTDIR) or with no code at all.
 *
 * `Workspaces.verifyArtifact` now returns such a failure as the same row shape
 * the declared-check layer already defers on: `(verification preparation)` (or
 * the command being confined), exit 125, `failureKind: 'infrastructure'`, and
 * `Host verification could not execute: <error>`. Authorization and ownership
 * refusals ahead of the preparation phase still throw, and so does
 * cancellation: an aborted operation is never recorded as a row.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { confinedCheckArgv } from '../lib/harness-workers.js'
import { MISSION_ACCEPTANCE, WorkspaceWorkers, Workspaces, eventually, events, makeRepo, setup, taskOf } from './faults/harness.mjs'
import { subprocessSeam } from './subprocess-seam.mjs'

const PREPARATION = '(verification preparation)'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const workspaceOptions = (root, extra = {}) => ({
  subprocess: subprocessSeam, workspacesRoot: join(root, 'worktrees'), checkTimeoutMs: 30_000, maxCheckOutputBytes: 32_000, confineCheck: argv => argv, ...extra,
})

/** `git worktree add` for a disposable verification checkout (never a member worktree). */
const verificationWorktreeAdd = argv => argv.includes('worktree') && argv.includes('add') && argv.some(part => part.includes(`${sep}verification${sep}`))

/**
 * The host's managed-process seam with one command substituted: every other
 * command (member worktrees, capture, cleanup) runs for real.
 */
function substitutingSeam(matches, argv, onSpawn = () => {}) {
  return () => {
    const real = subprocessSeam()
    return { spawn: spec => { if (!matches(spec.argv)) return real.spawn(spec); onSpawn(spec); return real.spawn({ ...spec, argv }) } }
  }
}

/** Every verification checkout this root ever held; a clean run leaves none behind. */
async function verificationCheckouts(root) {
  const missions = await readdir(join(root, 'worktrees')).catch(() => [])
  const found = []
  for (const mission of missions) found.push(...(await readdir(join(root, 'worktrees', mission, 'verification')).catch(() => [])))
  return found
}

/** A real Workspaces engine behind the real runtime, a submitted source and a claimed independent review. */
async function reviewFixture(t, { check = () => 'test -f src/answer.txt', options = {}, prepare = async () => {} } = {}) {
  const repo = await makeRepo('verification-preparation', { 'src/answer.txt': 'base\n', '.gitignore': 'node_modules/\n' })
  await prepare(repo)
  const workspaces = new Workspaces(workspaceOptions(repo.root, typeof options === 'function' ? options(repo) : options))
  const workers = new WorkspaceWorkers(workspaces)
  const f = await setup({ workers, workspace: repo.source, config: { tickMs: 60_000 } })
  t.after(async () => { await f.cleanup(); await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  const source = f.propose({ checks: [check(repo)] })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await writeFile(join(f.author.workspace, 'src/answer.txt'), 'candidate\n')
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Review', objective: 'Independently review the scoped change',
    kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  return { ...f, repo, workspaces, source, review,
    verify: () => f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason: 'Review against acceptance' }),
    runs: () => f.runtime.store.list('tool_runs', f.mission.id).filter(run => run.tool === 'swarm.host_verification'),
  }
}

/** The deferral contract every infrastructure shape below must meet. */
async function assertDeferred(f, command, output) {
  const verdict = await f.verify()
  assert.equal(verdict.status, 'blocked', 'the review is deferred, not thrown and not rejected')
  assert.equal(taskOf(f.runtime, f.source.id).status, 'submitted', 'the immutable source stays submitted')
  assert.equal(events(f.runtime, f.mission.id, 'task/verification-deferred').length, 1)
  assert.equal(events(f.runtime, f.mission.id, 'task/rejected').length, 0)
  assert.equal(events(f.runtime, f.mission.id, 'task/accepted').length, 0)
  assert.match(verdict.output, /swarm_control\(action: "resume"/, 'the guided exit is on the review')
  const runs = f.runs()
  assert.deepEqual(runs.map(run => run.arguments.attempt), [1, 2], 'both passes of the retry rule are durable')
  for (const run of runs) {
    assert.equal(run.result.command, command)
    assert.equal(run.result.exitCode, 125)
    assert.equal(run.result.failureKind, 'infrastructure')
    assert.equal(run.isError, true)
    assert.match(run.result.output, /^Host verification could not execute: /)
    assert.match(run.result.output, output)
  }
  assert.deepEqual(await verificationCheckouts(f.repo.root), [], 'the checkout is removed on the failure path')
  return verdict
}

test('a verification checkout whose git worktree add exits 128 defers the review', async t => {
  let substituted = 0
  const f = await reviewFixture(t, { options: { subprocess: substitutingSeam(verificationWorktreeAdd,
    ['/bin/sh', '-c', 'echo "fatal: simulated repository failure" >&2; exit 128'], () => { substituted++ }) } })
  await assertDeferred(f, PREPARATION, /git worktree failed \(128\): fatal: simulated repository failure/)
  assert.equal(substituted, 2, 'the worktree add really ran and failed on both passes')
  assert.equal(f.workspaces.checkEnvelope().completed, 0, 'no check slot was taken by a checkout that was never created')
})

test('a sandbox provider reporting partial enforcement defers the review and never runs the check', async t => {
  const partial = { confine: argv => ({ argv, enforcement: 'partial' }) }
  // Were the check ever run, it would leave a sentinel outside the verification checkout.
  const f = await reviewFixture(t, {
    check: () => 'touch "$SWARM_SENTINEL"',
    options: repo => ({ confineCheck: (argv, cwd) => confinedCheckArgv(partial, argv, cwd), checkEnv: { PATH: process.env.PATH, SWARM_SENTINEL: join(repo.root, 'ran-unconfined') } }),
  })
  await assertDeferred(f, 'touch "$SWARM_SENTINEL"', /full sandbox enforcement: the host provider reports "partial" enforcement/)
  assert.equal((await readdir(f.repo.root)).includes('ran-unconfined'), false, 'the refused check never ran')
  assert.equal(f.workspaces.checkEnvelope().completed, 2, 'each pass released the check slot it took')
})

for (const [label, error, output] of [
  ['an unknown errno code (ENOSPC)', () => Object.assign(new Error('ENOSPC: no space left on device, copyfile'), { code: 'ENOSPC', errno: -28, syscall: 'copyfile' }), /Error: ENOSPC: no space left on device, copyfile$/],
  ['no code at all', () => new Error('dependency copy failed without an errno code'), /Error: dependency copy failed without an errno code$/],
]) {
  test(`a dependency copy failing with ${label} defers the review`, async t => {
    const f = await reviewFixture(t, {
      prepare: async repo => {
        await mkdir(join(repo.source, 'node_modules', 'dep'), { recursive: true })
        await writeFile(join(repo.source, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
      },
    })
    let copies = 0
    f.workspaces.copyDependencyTree = async () => { copies++; throw error() }
    await assertDeferred(f, PREPARATION, output)
    assert.equal(copies, 2, 'the copy really ran and failed on both passes')
    assert.equal(f.workspaces.checkEnvelope().completed, 0, 'the copy lands before the slot, so no slot was taken')
  })
}

test('Workspaces.cancel during preparation still rejects instead of becoming a row', async t => {
  const repo = await makeRepo('verification-preparation-cancel', { 'src/answer.txt': 'base\n' })
  const started = []
  const holding = deferred()
  // The verification worktree add is held open, so the cancel lands in it.
  const workspaces = new Workspaces(workspaceOptions(repo.root, { checkConcurrency: 1,
    subprocess: substitutingSeam(argv => verificationWorktreeAdd(argv) && started.push(argv) === 1, ['/bin/sh', '-c', 'sleep 30'], () => holding.resolve()) }))
  t.after(async () => { await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  const mission = { id: 'mission-cancel', workspace: repo.source }
  const member = { id: 'member-cancel', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-cancel') }
  const task = { id: 'task-cancel', missionId: mission.id, epoch: 1, title: 'Work', kind: 'implementation', scope: ['src/'], checks: ['true'], status: 'running' }
  await workspaces.prepareTask(member, task, [])
  await writeFile(join(member.workspace, 'src', 'answer.txt'), 'changed\n')
  const artifact = await workspaces.captureArtifact(member, task)

  const inWorktreeAdd = workspaces.verifyArtifact(member, task, artifact)
  await holding.promise
  workspaces.cancel(member.id)
  await assert.rejects(inWorktreeAdd, /Execution cancelled/, 'a cancelled git worktree add is cancellation, not an infrastructure row')

  // Queued for the check slot: the only slot is held elsewhere.
  await workspaces.checks.acquire()
  try {
    const queued = workspaces.verifyArtifact(member, task, artifact)
    const settled = queued.then(value => ({ value }), reason => ({ reason }))
    await eventually(() => workspaces.checkEnvelope().queued === 1, 'the verification queues for the held slot')
    workspaces.cancel(member.id)
    const outcome = await settled
    assert.equal('value' in outcome, false, `a cancelled slot wait is cancellation, not a row: ${JSON.stringify(outcome.value)}`)
    assert.equal(outcome.reason, 'member stopped', 'the cancellation reason reaches the caller unchanged')
  } finally { workspaces.checks.release(0) }
  assert.equal(workspaces.checkEnvelope().queued, 0)
  assert.deepEqual(await verificationCheckouts(repo.root), [], 'cleanup still runs on the cancelled paths')
})
