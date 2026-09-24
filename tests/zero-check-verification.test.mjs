/** Empty declared-check lists still validate trust boundaries, but need no execution slot or checkout. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { makeRepo, makeWorkspaces } from './faults/harness.mjs'
import { loadWorkspaceGrants, WORKSPACE_AUTHORIZATION_CODE } from '../lib/authorization.js'

async function fixture(t) {
  const repo = await makeRepo('zero-check-verification', { '.gitignore': 'node_modules/\n', 'research.md': 'baseline\n' })
  const grants = await loadWorkspaceGrants([{ path: repo.source }])
  const workspaces = makeWorkspaces(repo.root, { checkConcurrency: 1, grants })
  t.after(async () => { await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  await mkdir(join(repo.source, 'node_modules'))
  await writeFile(join(repo.source, 'node_modules', 'fixture-dependency'), 'installed\n')
  const mission = { id: 'mission-one', workspace: repo.source, workspaceGrantRoot: repo.source, workspaceAuthorizationSource: 'grant' }
  const member = { id: 'member-one', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-one') }
  const task = { id: 'research-one', missionId: mission.id, epoch: 1, title: 'Research', kind: 'research',
    scope: ['research.md'], checks: [], status: 'running' }
  await workspaces.prepareTask(member, task, [])
  const artifact = await workspaces.captureArtifact(member, task)
  const checkout = t.mock.method(workspaces, 'worktreeAdd')
  const dependencies = t.mock.method(workspaces, 'linkDependencyDirs')
  const envelope = workspaces.checkEnvelope()
  return { ...repo, grants, workspaces, mission, member, task, artifact,
    verify: (signal, selectedArtifact = artifact, selectedMember = member) => workspaces.verifyArtifact(selectedMember, task, selectedArtifact, signal),
    async assertNoExecution() {
      assert.equal(checkout.mock.callCount(), 0, 'empty checks must not create a disposable worktree')
      assert.equal(dependencies.mock.callCount(), 0, 'empty checks must not materialize dependencies')
      // The envelope is the whole measured record (limit/active/queued/completed
      // and the wait and run totals): unchanged means nothing was measured either.
      assert.deepEqual(workspaces.checkEnvelope(), envelope, 'empty checks must not consume or record check capacity')
      await assert.rejects(access(join(repo.root, 'worktrees', mission.id, 'verification')), { code: 'ENOENT' })
    },
  }
}

test('zero-check verification validates a real artifact without checkout, dependencies or check capacity', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.verify(), [])
  await f.assertNoExecution()
})

test('zero-check verification completes while all declared-check capacity is occupied', async t => {
  const f = await fixture(t)
  // Hold the real semaphore slot. Observe a queue attempt directly so the
  // pre-fix regression fails without relying on a sleep or elapsed-time limit.
  await f.workspaces.checks.acquire()
  const acquire = f.workspaces.checks.acquire.bind(f.workspaces.checks)
  let attempted
  const queued = new Promise(resolve => { attempted = resolve })
  t.mock.method(f.workspaces.checks, 'acquire', signal => {
    const result = acquire(signal)
    attempted('queued')
    return result
  })
  const controller = new AbortController()
  const verification = f.verify(controller.signal)
  try {
    const result = await Promise.race([verification.then(checks => ({ checks })), queued])
    assert.deepEqual(result, { checks: [] }, 'empty verification must finish without entering the occupied queue')
    assert.equal(f.workspaces.checkEnvelope().active, 1, 'the existing execution retains its slot')
    assert.equal(f.workspaces.checkEnvelope().queued, 0)
    assert.equal(f.workspaces.checkEnvelope().completed, 0, 'empty verification is not counted as an execution')
  } finally {
    controller.abort(new Error('fixture cleanup'))
    await verification.catch(() => undefined)
    f.workspaces.checks.release(0)
  }
})

test('zero-check verification still rejects a member outside its owned workspace', async t => {
  const f = await fixture(t)
  await assert.rejects(f.verify(undefined, f.artifact, { ...f.member, workspace: f.source }), /workspace_not_owned/)
  await f.assertNoExecution()
})

test('zero-check verification still rejects malformed and nonexistent artifact commits', async t => {
  const f = await fixture(t)
  await assert.rejects(f.verify(undefined, { ...f.artifact, commit: 'HEAD' }), /exact commit hashes/)
  await assert.rejects(f.verify(undefined, { ...f.artifact, commit: 'f'.repeat(40) }), /git cat-file failed/)
  await f.assertNoExecution()
})

test('zero-check verification still rejects a revoked workspace grant', async t => {
  const f = await fixture(t)
  f.grants.grants.length = 0
  await assert.rejects(f.verify(), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  await f.assertNoExecution()
})

test('zero-check verification preserves caller cancellation before and during authorization', async t => {
  const f = await fixture(t)
  const before = new AbortController()
  const beforeReason = new Error('cancelled before verification')
  before.abort(beforeReason)
  await assert.rejects(f.verify(before.signal), error => error === beforeReason)
  const during = new AbortController()
  const duringReason = new Error('cancelled during authorization')
  const authorize = f.workspaces.assertWorkspaceAuthorized.bind(f.workspaces)
  t.mock.method(f.workspaces, 'assertWorkspaceAuthorized', async (...args) => {
    await authorize(...args)
    during.abort(duringReason)
  })
  await assert.rejects(f.verify(during.signal), error => error === duringReason)
  await f.assertNoExecution()
})
