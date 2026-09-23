/** Real subprocess deadlines must reach the same durable retry path as failed exits. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rm, writeFile } from 'node:fs/promises'
import { makeRepo, setup, Workspaces, WorkspaceWorkers, MISSION_ACCEPTANCE } from './faults/harness.mjs'
import { subprocessSeam } from './subprocess-seam.mjs'

async function fixture(t, checks, options = {}) {
  const repo = await makeRepo('check-timeout')
  const workspaces = new Workspaces({
    subprocess: subprocessSeam, workspacesRoot: join(repo.root, 'worktrees'),
    checkTimeoutMs: 500, maxCheckOutputBytes: 32000, confineCheck: argv => argv,
    // A fixture-owned marker injects a deadline on only the first pass when requested.
    checkEnv: { SWARM_TEST_MARKER: join(repo.root, 'first-pass') }, ...options,
  })
  const workers = new WorkspaceWorkers(workspaces)
  const f = await setup({ workers, workspace: repo.source, config: { tickMs: 60000 } })
  t.after(async () => { await f.cleanup(); await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  const source = f.propose({ checks, checkTimeoutMs: 500 })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await writeFile(join(f.author.workspace, 'src/answer.txt'), 'candidate\n')
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    outputs: [], workstreamId: f.stream.id, title: 'Review', objective: 'Independently review the scoped change',
    kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  return { ...f, source, review,
    verify: signal => f.runtime.verify({ ...f.actor(f.reviewer), signal }, f.mission.id, {
      taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason: 'Review against acceptance',
    }),
    runs: () => f.runtime.store.list('tool_runs', f.mission.id).filter(run => run.tool === 'swarm.host_verification'),
  }
}

for (const recovers of [false, true]) test(`real check deadline ${recovers ? 'recovers on retry' : 'defers same-artifact verification after retry'} with both passes durable`, async t => {
  const slow = 'printf "before-timeout\\nnot ok 1 - slow check\\n%02000d\\n" 0; sleep 60'
  const deadline = recovers
    ? `if test -f "$SWARM_TEST_MARKER"; then echo recovered; else : > "$SWARM_TEST_MARKER"; ${slow}; fi`
    : slow
  const f = await fixture(t, ['echo prior-success', deadline], { maxCheckOutputBytes: 1024 })
  const verdict = await f.verify()
  assert.equal(f.workers.verified.length, 2, 'a real timeout retries the same immutable artifact once')
  assert.equal(new Set(f.workers.verified.map(run => run.commit)).size, 1)
  assert.equal(verdict.status, recovers ? 'accepted' : 'blocked')
  assert.equal(f.runtime.store.get('tasks', f.source.id).status, recovers ? 'accepted' : 'submitted')
  if (!recovers) assert.equal(verdict.verificationRecovery.commit, f.runtime.store.get('tasks', f.source.id).artifact.commit)
  const runs = f.runs()
  assert.deepEqual(runs.map(run => run.arguments.attempt), [1, 1, 2, 2])
  assert.deepEqual(runs.map(run => run.result.exitCode), [0, 124, 0, recovers ? 0 : 124])
  assert.match(runs[0].result.output, /prior-success/, 'completed checks before the deadline are retained')
  assert.match(runs[1].result.output, /before-timeout/, 'partial output from the killed command is retained')
  assert.match(runs[1].result.output, /Execution timed out after 500ms/)
  assert.ok(Buffer.byteLength(runs[1].result.output) <= 1024, 'timeout diagnosis stays inside the output bound')
  assert.equal(runs[1].result.truncated, true)
  assert.ok(runs.every(run => run.result.environment?.sandboxPolicy.workspaceRoot), 'each completed or timed-out check records its environment')
  assert.equal(runs[1].result.attribution.command, deadline)
  assert.deepEqual(runs[1].result.attribution.failingTests, ['slow check'])
  assert.equal(runs[1].result.attribution.outputTruncated, true)
})

test('caller cancellation of a declared check remains cancellation and never starts a retry', async t => {
  const controller = new AbortController()
  const f = await fixture(t, ['echo before-cancel; sleep 60'], {
    confineCheck: argv => {
      setTimeout(() => controller.abort(new Error('owner stopped the check')), 50)
      return argv
    },
  })
  await assert.rejects(f.verify(controller.signal), /Execution cancelled/)
  assert.equal(f.workers.verified.length, 1, 'an explicit abort must not be retried as a failing check')
  assert.deepEqual(f.runs(), [], 'cancellation must not manufacture a verification verdict')
  assert.equal(f.runtime.store.get('tasks', f.source.id).status, 'submitted')
})
