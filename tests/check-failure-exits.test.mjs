/**
 * Review M-9: a check failure is classified once, where the host produces its
 * row, and its exit comes from one table keyed by that kind.
 *
 * At a65f837 a command that could not run (exit 126/127) was stored as
 * `infrastructure`, the same kind as a host that could not execute the check;
 * the exit-127 guidance was prose appended to the command's own output; and
 * every deferral told the owner the same thing whatever the kind: "Fix the
 * reported environment or amend checkTimeoutMs with swarm_budget, then resume".
 * For a command that cannot run, raising checkTimeoutMs is no exit, and the
 * exit that does work when the command itself is wrong (withdraw the source
 * and propose a repair with corrected checks) was never named.
 *
 * Now `timeout` names swarm_budget's checkTimeoutMs, `infrastructure` names
 * the host repair, and `unrunnable` names the dependency directories the
 * checkout received (from the row's own environment record); `timeout` and
 * `unrunnable` also name the cancel-plus-replacement exit with its real tool
 * parameters, for a command that is itself wrong. The deferral
 * reason and the review-path blocker compose from the last classified failure
 * of the deciding pass, the one that ended it (the host stops a pass at its
 * first failing check): the blocker reads exactly the rows the deferral named
 * (`verificationRecovery.toolRunIds`), never the review's newest rows. An exit names no id: the text around it
 * names the source and the review once, so the reason has a fixed maximum
 * whatever the ids and the row carry. Each exit is performed here through the
 * registered tools, so a named parameter that the published schema does not
 * declare is refused.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertNamedCalls, ownerTools } from './refusal-inventory.mjs'
import { DatabaseSync } from 'node:sqlite'
import { FakeWorkers, MISSION_ACCEPTANCE, SwarmRuntime, WorkspaceWorkers, events, makeRepo, makeWorkspaces, setup, taskOf } from './faults/harness.mjs'
import { reviewNeed, reviewPathBlocker } from '../lib/board.js'

const deferredReason = f => events(f.runtime, f.mission.id, 'task/verification-deferred').at(-1)?.data.reason
const hostRuns = f => f.runtime.store.list('tool_runs', f.mission.id).filter(run => run.tool === 'swarm.host_verification')

/** Submit `source` as the author, then claim an independent review of it (admitted as `reviewId` when given, with no criteria of its own) as the reviewer. */
async function submitForReview(f, source, write = async () => {}, reviewId = undefined) {
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await write(claimed)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    outputs: [], workstreamId: f.stream.id, title: 'Review the source', objective: 'Independently review the scoped change',
    kind: 'verification', reviewOf: source.id, scope: ['**'], assigneeId: f.reviewer.id,
  }, reviewId)
  const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  return { review, verify: (reason = 'Review against acceptance') => f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason }) }
}

/** Resume a deferred review through swarm_control (it re-pends at once: its reviewer owes no stop), let the pass it kicks settle, and accept it on passing checks. */
async function resumeAndAccept(f, tool, review) {
  await tool('swarm_control', { action: 'resume', taskId: review.id, reason: 'condition repaired' })
  await f.runtime.settle(f.mission.id)
  assert.equal(taskOf(f.runtime, review.id).status, 'pending', 'the resumed review re-pends')
  const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  return await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason: 'Host checks pass after the exit' })
}

/** A real Workspaces engine behind the real runtime; the source project carries an installed, ignored `node_modules`. */
async function realFixture(t, files = {}) {
  const repo = await makeRepo('check-failure-exits', { 'src/answer.txt': 'base\n', '.gitignore': 'node_modules/\n', ...files })
  await mkdir(join(repo.source, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(repo.source, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  const workspaces = makeWorkspaces(repo.root)
  const f = await setup({ workers: new WorkspaceWorkers(workspaces), workspace: repo.source, config: { tickMs: 60_000 } })
  t.after(async () => { await f.cleanup(); await workspaces.dispose(); await rm(repo.root, { recursive: true, force: true }) })
  return { ...f, repo, tool: await ownerTools(f) }
}

const answer = f => async () => { await writeFile(join(f.author.workspace, 'src/answer.txt'), 'candidate\n') }

test('exit 127: the row is unrunnable with the command\'s own output, and the environment exit really works', async t => {
  const f = await realFixture(t)
  // The source only cites the mission criterion and the review has no criteria of its own, so neither row holds its text.
  const source = f.propose({ acceptance: [], checks: ['PATH="$PWD/node_modules/.bin:$PATH" swarm-toolchain'] })
  const { review, verify } = await submitForReview(f, source, answer(f))
  const deferred = await verify()
  assert.equal(deferred.status, 'blocked', 'the review defers')
  assert.deepEqual([deferred.acceptance, 'covers' in deferred, taskOf(f.runtime, review.id).acceptance], [MISSION_ACCEPTANCE, false, []], 'the reviewer reads its checklist in the deferred result, as in its assignment')
  assert.equal(taskOf(f.runtime, source.id).status, 'submitted', 'the source stays submitted')
  const runs = hostRuns(f)
  assert.deepEqual(runs.map(run => [run.result.exitCode, run.result.failureKind]), [[127, 'unrunnable'], [127, 'unrunnable']], 'both passes are unrunnable rows')
  for (const { result } of runs) {
    assert.match(result.output, /swarm-toolchain/, 'the shell\'s own diagnostic')
    assert.doesNotMatch(result.output, /\[swarm\]/, 'nothing is appended to the command\'s output')
    assert.deepEqual(result.environment.dependencyLinks.materializedPaths, ['node_modules'], 'the environment record says what the checkout received')
  }
  const reason = deferredReason(f)
  assert.equal(deferred.output, reason)
  assert.ok(reason.includes('a command could not run in the clean verification checkout (dependency directories copied from the source: node_modules)'), reason)
  assert.ok(reason.includes(`\nReview ${review.id} deferred its verdict on the immutable source ${source.id} at ${taskOf(f.runtime, source.id).artifact.commit}, which remains submitted: `), reason)
  assert.ok(reason.includes('then resume the review with swarm_control(action: "resume", taskId, reason)'), 'the environment exit resumes the same review')
  assert.ok(reason.includes('cancel the source with swarm_cancel(taskId, reason) and repair its checks with swarm_propose(replaces, checks, maxRecoveryAttempts, checkTimeoutMs)'), 'the replacement exit is named')
  assert.doesNotMatch(reason, /reached its deadline|swarm_budget/, 'a deadline is not this failure\'s exit')
  await assertNamedCalls(reason, ['swarm_control', 'swarm_cancel', 'swarm_propose'])

  // The environment exit: install the toolchain in the source project, then resume the same review.
  await mkdir(join(f.repo.source, 'node_modules', '.bin'))
  await writeFile(join(f.repo.source, 'node_modules', '.bin', 'swarm-toolchain'), '#!/bin/sh\ntest -f src/answer.txt\n')
  await chmod(join(f.repo.source, 'node_modules', '.bin', 'swarm-toolchain'), 0o755)
  const accepted = await resumeAndAccept(f, f.tool, review)
  assert.equal(accepted.status, 'accepted')
  assert.equal(taskOf(f.runtime, source.id).status, 'accepted', 'the same immutable source is accepted')
})

test('exit 126: the replacement exit named in the reason really works end to end', async t => {
  const f = await realFixture(t, { 'check.sh': '#!/bin/sh\ntest -f src/answer.txt\n' })
  const source = f.propose({ checks: ['./check.sh'] })
  const { review, verify } = await submitForReview(f, source, answer(f))
  await verify()
  assert.deepEqual(hostRuns(f).map(run => [run.result.exitCode, run.result.failureKind]), [[126, 'unrunnable'], [126, 'unrunnable']])
  const reason = deferredReason(f)
  assert.ok(reason.includes('dependency directories copied from the source: node_modules'), reason)
  assert.ok(reason.includes('or, if a command is wrong, cancel the source with swarm_cancel(taskId, reason) and repair its checks with swarm_propose(replaces, checks, maxRecoveryAttempts, checkTimeoutMs)'), reason)
  await assertNamedCalls(reason, ['swarm_control', 'swarm_cancel', 'swarm_propose'])

  // The command itself is wrong (the script is not executable): withdraw, then repair with corrected checks, naming every parameter the exit names.
  await f.tool('swarm_cancel', { taskId: source.id, reason: 'the declared check cannot run as written' })
  assert.equal(taskOf(f.runtime, source.id).status, 'cancelled')
  assert.equal(taskOf(f.runtime, review.id).status, 'cancelled', 'the deferred review is retired with its source')
  const repair = await f.tool('swarm_propose', { workstreamId: f.stream.id, title: 'Repair', objective: 'Implement the scoped change',
    kind: 'implementation', scope: ['**'], replaces: [source.id], checks: ['sh ./check.sh'], maxRecoveryAttempts: 2, checkTimeoutMs: 30_000, assigneeId: f.author.id })
  assert.deepEqual(repair.checks, ['sh ./check.sh'])
  const next = await submitForReview(f, taskOf(f.runtime, repair.id), answer(f))
  assert.equal((await next.verify()).status, 'accepted')
  assert.equal(taskOf(f.runtime, repair.id).status, 'accepted', 'the repair carries the obligation to acceptance')
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'The repaired work is accepted').status, 'completed')
})

/** The shared fixture with a controlled adapter: the rows are what a host returned (or stored) for one pass. */
async function fakeFixture(t, config = {}) {
  const f = await setup({ workers: new FakeWorkers(), config: { tickMs: 60_000, ...config } })
  t.after(f.cleanup)
  return { ...f, tool: await ownerTools(f) }
}

async function deferOn(f, rows, reason, ids = {}) {
  const source = f.runtime.propose(f.owner, f.mission.id, { outputs: [], workstreamId: f.stream.id, title: 'Implement', objective: 'Implement the scoped change',
    kind: 'implementation', scope: ['**'], acceptance: MISSION_ACCEPTANCE, checks: ['test -d .'], assigneeId: f.author.id }, ids.source)
  const { review, verify } = await submitForReview(f, source, undefined, ids.review)
  f.workers.checks = rows
  const verdict = await verify(reason)
  f.workers.checks = [{ command: 'test -d .', exitCode: 0, output: 'ok' }]
  return { source, review, verdict }
}

const blocker = (f, source) => { const board = f.runtime.boardOf(f.mission.id), row = taskOf(f.runtime, source.id); return reviewPathBlocker(board, row, reviewNeed(board, row)) }

test('exit 124: the reason names checkTimeoutMs through swarm_budget, and that exit really works', async t => {
  const f = await fakeFixture(t)
  const { source, review, verdict } = await deferOn(f, [{ command: 'test -d .', exitCode: 124, failureKind: 'timeout', output: '[swarm] Execution timed out after 30000ms' }])
  assert.equal(verdict.status, 'blocked')
  const reason = deferredReason(f)
  assert.ok(reason.includes(`\nReview ${review.id} deferred its verdict on the immutable source ${source.id} at ${'a'.repeat(40)}, which remains submitted: a check reached its deadline: raise the source's checkTimeoutMs with swarm_budget(taskId, taskBudget: { checkTimeoutMs }, reason), then resume the review with swarm_control(action: "resume", taskId, reason); or, if a command is wrong, cancel the source with swarm_cancel(taskId, reason) and repair its checks with swarm_propose(replaces, checks, maxRecoveryAttempts, checkTimeoutMs).`), reason)
  await assertNamedCalls(reason, ['swarm_budget', 'swarm_control', 'swarm_cancel', 'swarm_propose'])
  await f.tool('swarm_budget', { taskId: source.id, taskBudget: { checkTimeoutMs: 90_000 }, reason: 'The suite needs a longer deadline' })
  assert.equal(taskOf(f.runtime, source.id).checkTimeoutMs, 90_000)
  assert.equal(taskOf(f.runtime, source.id).status, 'submitted')
  assert.equal((await resumeAndAccept(f, f.tool, review)).status, 'accepted')
})

/**
 * A command that exits 124 itself (an inner `timeout`, or `exit 124`) ran and
 * failed: only the host's own deadline is a timeout, classified where it fires.
 * Its review therefore decides: the source is rejected like any assertion
 * failure, never deferred with a checkTimeoutMs exit that could not help it.
 */
test('a command\'s own exit 124 is its verdict: the source is rejected, never deferred', async t => {
  const f = await realFixture(t)
  const source = f.propose({ checks: ['exit 124'] })
  const { verify } = await submitForReview(f, source, answer(f))
  await verify()
  assert.deepEqual(hostRuns(f).map(run => [run.result.exitCode, run.result.failureKind, /\[swarm\] Execution timed out/.test(run.result.output)]), [[124, undefined, false], [124, undefined, false]], 'both attempts ran to their own exit: no host deadline fired, so no failure kind')
  assert.equal(taskOf(f.runtime, source.id).status, 'blocked', 'the source is rejected')
  assert.equal(events(f.runtime, f.mission.id, 'task/verification-deferred').length, 0)
  assert.equal(events(f.runtime, f.mission.id, 'task/rejected').length, 1)
})

test('a host that could not execute the check names the host repair, never checkTimeoutMs or a replacement', async t => {
  const f = await fakeFixture(t)
  const { source, review } = await deferOn(f, [{ command: '(verification preparation)', exitCode: 125, failureKind: 'infrastructure', output: 'Host verification could not execute: Error: git worktree failed (128)' }])
  const reason = deferredReason(f)
  assert.ok(reason.includes('the host could not execute a check: repair the host condition its output reports, then resume the review with swarm_control(action: "resume", taskId, reason)'), reason)
  assert.doesNotMatch(reason, /checkTimeoutMs|swarm_cancel/)
  assert.equal(blocker(f, source), `review ${review.id} deferred its verdict on this artifact: ${reason.slice(reason.indexOf('the host could not'), -1)}`, 'the blocker composes from the same table')
})

test('an exit-1 check is an assertion failure: the source is rejected, never deferred', async t => {
  const f = await fakeFixture(t)
  const { source, verdict } = await deferOn(f, [{ command: 'test -d .', exitCode: 1, output: 'assertion failed' }])
  assert.equal(verdict.status, 'blocked')
  assert.equal(taskOf(f.runtime, source.id).status, 'blocked', 'the source is rejected')
  assert.equal(events(f.runtime, f.mission.id, 'task/verification-deferred').length, 0)
  assert.equal(events(f.runtime, f.mission.id, 'task/rejected').length, 1)
})

test('a 127 row a 75b765a host stored as infrastructure still defers, with the infrastructure exit', async t => {
  const f = await fakeFixture(t)
  const { source, review } = await deferOn(f, [{ command: 'test -d .', exitCode: 127, failureKind: 'infrastructure', output: 'sh: test: command not found\n[swarm] exit 127: a command in this check was not found in the clean verification checkout.' }])
  assert.equal(taskOf(f.runtime, source.id).status, 'submitted')
  const reason = deferredReason(f)
  assert.ok(reason.includes('the host could not execute a check'), reason)
  assert.doesNotMatch(reason, /a command could not run/, 'the stored kind, not the exit code, picks the exit')
  assert.match(blocker(f, source), new RegExp(`^review ${review.id} deferred its verdict on this artifact: the host could not execute a check`))
})

const unrunnable = environment => ({ command: 'test -d .', exitCode: 127, failureKind: 'unrunnable', output: 'sh: tool: command not found', environment })

/** The longest task id a launch admits: `task_<draft>_<key>`, an automatic request's draft and a 100-character plan key. */
const planTaskId = key => `task_draft_start_${randomUUID()}_${key}${'k'.repeat(100 - key.length)}`

test('the reason fits the smallest message bound with the longest ids, and the blocker composes the same exit from the stored rows', async t => {
  const f = await fakeFixture(t, { maxMessageChars: 1_000 })
  f.workers.artifact = { ...f.workers.artifact, commit: 'a'.repeat(64) }
  const ids = { source: planTaskId('implement-'), review: planTaskId('implement-review-') }
  assert.deepEqual([ids.source.length, ids.review.length], [154, 154])
  // Enough materialized paths that the bounded list's own marker carries a seven-digit count.
  const materializedPaths = Array.from({ length: 50_000 }, (_, index) => `packages/p${index}/node_modules`)
  const { source, review, verdict } = await deferOn(f, [unrunnable({ dependencyLinks: { mode: 'copy', dirs: ['node_modules'], materializedPaths } })], 'r'.repeat(990), ids)
  assert.equal(verdict.status, 'blocked', 'the review defers instead of throwing content_too_long')
  assert.equal(taskOf(f.runtime, source.id).status, 'submitted')
  const reason = deferredReason(f)
  assert.equal(verdict.output, reason)
  assert.ok(reason.length <= 1_000, `the composed reason stays within maxMessageChars: ${reason.length}`)
  assert.ok(reason.includes('dependency directories copied from the source: packages/p0/node_modules, '), reason)
  assert.match(reason, /… \[\d{7} more chars\]\): provide what it needs/)
  assert.ok(reason.endsWith('swarm_propose(replaces, checks, maxRecoveryAttempts, checkTimeoutMs).'), 'measured on the one repair text every mission names')
  const deferral = reason.slice(reason.lastIndexOf('\nReview '))
  assert.deepEqual([deferral.split(source.id).length - 1, deferral.split(review.id).length - 1], [1, 1], `each id is named once: ${deferral}`)
  await assertNamedCalls(reason, ['swarm_control', 'swarm_cancel', 'swarm_propose'])
  assert.equal(blocker(f, source), `review ${review.id} deferred its verdict on this artifact: ${reason.slice(reason.indexOf('a command could not run'), -1)}`)

  const empty = await fakeFixture(t)
  await deferOn(empty, [unrunnable({ dependencyLinks: { mode: 'copy', dirs: ['node_modules', '.venv'], materializedPaths: [] } })])
  assert.ok(deferredReason(empty).includes('(dependency directories copied from the source: none of verificationDependencyDirs ["node_modules",".venv"])'), deferredReason(empty))

  // Nothing materialized and a long configured list: the list is rendered through the same bound.
  const configured = await fakeFixture(t, { maxMessageChars: 1_000 })
  configured.workers.artifact = { ...configured.workers.artifact, commit: 'a'.repeat(64) }
  const dirs = Array.from({ length: 30 }, (_, index) => `vendor-bundle-${index}`)
  const listed = await deferOn(configured, [unrunnable({ dependencyLinks: { mode: 'copy', dirs, materializedPaths: [] } })], 'r'.repeat(990),
    { source: planTaskId('build-'), review: planTaskId('build-review-') })
  assert.equal(listed.verdict.status, 'blocked', 'the review defers')
  assert.equal(taskOf(configured.runtime, listed.source.id).status, 'submitted')
  const bounded = deferredReason(configured)
  assert.ok(bounded.length <= 1_000, `${bounded.length}: ${bounded}`)
  assert.match(bounded, /\(dependency directories copied from the source: none of verificationDependencyDirs \["vendor-bundle-0",[^)]*… \[\d+ more chars\]\): provide what it needs/)

  // One adapter pass holding a failure of every kind: the last failure is the one that ended the pass.
  const mixed = await fakeFixture(t, { maxMessageChars: 1_000 })
  const every = await deferOn(mixed, [
    { command: 'test -d .', exitCode: 124, failureKind: 'timeout', output: '[swarm] Execution timed out after 30000ms' },
    { command: '(verification preparation)', exitCode: 125, failureKind: 'infrastructure', output: 'Host verification could not execute: Error: EMFILE' },
    unrunnable({ dependencyLinks: { mode: 'copy', dirs: ['node_modules'], materializedPaths: ['node_modules'] } }),
  ], 'r'.repeat(990))
  assert.equal(every.verdict.status, 'blocked', 'the review defers')
  const last = deferredReason(mixed)
  assert.ok(last.length <= 1_000, `${last.length}: ${last}`)
  assert.ok(last.includes('a command could not run in the clean verification checkout (dependency directories copied from the source: node_modules)'), last)
  assert.doesNotMatch(last, /could not execute a check|reached its deadline/, 'one exit, the last failure\'s')
  assert.equal(blocker(mixed, every.source), `review ${every.review.id} deferred its verdict on this artifact: ${last.slice(last.indexOf('a command could not run'), -1)}`)
})

/**
 * 75b765a deferred on a bare exit code 124/126/127 (`DeclaredChecks.recoveryRequired`), so a
 * WorkerAdapter that returned such rows without a kind left a stored deferral whose rows carry
 * none. That review still decided to defer, so its blocker still names its resume exit.
 */
test('a stored deferral whose rows carry no kind still names the review\'s resume exit', async t => {
  const f = await fakeFixture(t)
  const { source, review } = await deferOn(f, [{ command: 'test -d .', exitCode: 127, failureKind: 'unrunnable', output: 'sh: npm: command not found' }])
  f.runtime.store.transaction(() => { for (const run of hostRuns(f)) f.runtime.store.put('tool_runs', { ...run, result: { command: run.result.command, exitCode: 127, output: run.result.output } }) })
  assert.ok(hostRuns(f).every(run => run.result.failureKind === undefined), 'the rows are what 75b765a stored')
  const path = blocker(f, source)
  assert.match(path, /swarm_control\(action: "resume"/, path)
  assert.equal(path, `review ${review.id} deferred its verdict on this artifact: resume the review with swarm_control(action: "resume", taskId, reason)`)
  await assertNamedCalls(path, ['swarm_control'])
})

test('the reason and the blocker take the exit from the deciding pass: the retry, and after a resume the latest deferral', async t => {
  const f = await fakeFixture(t)
  const passes = [
    [{ command: 'test -d .', exitCode: 124, failureKind: 'timeout', output: '[swarm] Execution timed out after 30000ms' }],
    [unrunnable({ dependencyLinks: { mode: 'copy', dirs: ['node_modules'], materializedPaths: ['node_modules'] } })],
  ]
  f.workers.verifyArtifact = async () => passes.shift() ?? [{ command: 'test -d .', exitCode: 0, output: 'ok' }]
  const source = f.propose()
  const { review, verify } = await submitForReview(f, source)
  await verify()
  assert.deepEqual(hostRuns(f).map(run => [run.arguments.attempt, run.result.failureKind]), [[1, 'timeout'], [2, 'unrunnable']], 'both passes are durable')
  const reason = deferredReason(f)
  assert.ok(reason.includes('a command could not run in the clean verification checkout'), reason)
  assert.doesNotMatch(reason, /reached its deadline|swarm_budget/, 'the retry decided, not the first pass')
  assert.equal(blocker(f, source), `review ${review.id} deferred its verdict on this artifact: ${reason.slice(reason.indexOf('a command could not run'), -1)}`)

  // Resumed, the review defers again on a new kind: the blocker follows the latest deferral only.
  await f.tool('swarm_control', { action: 'resume', taskId: review.id, reason: 'condition repaired' })
  await f.runtime.settle(f.mission.id)
  passes.push(...Array.from({ length: 2 }, () => [{ command: '(verification preparation)', exitCode: 125, failureKind: 'infrastructure', output: 'Host verification could not execute: Error: EMFILE' }]))
  const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  assert.equal((await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason: 'Review again' })).status, 'blocked')
  assert.equal(hostRuns(f).length, 4)
  const again = deferredReason(f)
  assert.ok(again.includes('the host could not execute a check'), again)
  assert.deepEqual(taskOf(f.runtime, review.id).verificationRecovery.toolRunIds, [hostRuns(f)[3].id], 'the deferral names its own deciding pass, the latest retry')
  assert.equal(blocker(f, source), `review ${review.id} deferred its verdict on this artifact: ${again.slice(again.indexOf('the host could not'), -1)}`)
})

/**
 * Schema 8: a build before it stored a deferral without naming the rows of the
 * pass that decided it, and the blocker composed the exit from the review's
 * newest rows. Opening such a store names them once, from the rows the
 * deferral's own `task/verification-deferred` event names as `checks`, which
 * every build that defers writes in the same transaction.
 */
test('a deferral an older build stored names its deciding pass\'s rows once, at open, from the rows its event names (schema 8)', async t => {
  const f = await fakeFixture(t)
  const passes = [
    [{ command: 'test -d .', exitCode: 124, failureKind: 'timeout', output: '[swarm] Execution timed out after 30000ms' }],
    [{ command: '(verification preparation)', exitCode: 125, failureKind: 'infrastructure', output: 'Host verification could not execute: Error: EMFILE' }],
  ]
  f.workers.verifyArtifact = async () => passes.shift() ?? [{ command: 'test -d .', exitCode: 0, output: 'ok' }]
  const source = f.propose()
  const untouched = f.propose({ title: 'Never reviewed' })
  const { review, verify } = await submitForReview(f, source)
  await verify()
  const deferred = taskOf(f.runtime, review.id), plain = taskOf(f.runtime, untouched.id)
  assert.deepEqual(deferred.verificationRecovery.toolRunIds, hostRuns(f).filter(run => run.arguments.attempt === 2).map(run => run.id), 'this build names the deciding pass, the retry')
  const path = blocker(f, source)
  assert.match(path, /the host could not execute a check/)
  await f.runtime.dispose()

  const { statePath } = f.runtime.config
  const { toolRunIds: _named, ...stored } = deferred.verificationRecovery
  const write = (schema, sql = '') => {
    const db = new DatabaseSync(statePath)
    try { db.prepare('UPDATE tasks SET value=? WHERE id=?').run(JSON.stringify({ ...deferred, verificationRecovery: stored }), review.id); db.exec(`${sql}PRAGMA user_version=${schema}`) } finally { db.close() }
  }
  const read = sql => { const db = new DatabaseSync(statePath, { readOnly: true }); try { return Object.values(db.prepare(sql).get())[0] } finally { db.close() } }
  const open = () => { const opened = new SwarmRuntime(f.runtime.config, new FakeWorkers()); t.after(() => opened.dispose()); return opened }
  const blockerOf = runtime => { const board = runtime.boardOf(f.mission.id), row = taskOf(runtime, source.id); return reviewPathBlocker(board, row, reviewNeed(board, row)) }

  write(7)
  const before = read('SELECT revision FROM state_revision WHERE id=1')
  const opened = open()
  assert.deepEqual(taskOf(opened, review.id), deferred, 'the deferral names the rows its event names, as this build records it')
  assert.deepEqual(taskOf(opened, untouched.id), plain, 'a row holding no deferral keeps its value')
  assert.deepEqual(opened.store.changesSince(before).map(change => change.scopes), [[f.mission.id]], 'the upgrade is one recorded change')
  assert.equal(blockerOf(opened), path, 'the blocker names the same exit')
  await opened.dispose()
  assert.equal(read('PRAGMA user_version'), 8)

  // Once: a schema 8 store is not upgraded again, and reopening writes nothing.
  const revision = read('SELECT revision FROM state_revision WHERE id=1')
  const reopened = open()
  assert.deepEqual([taskOf(reopened, review.id), reopened.store.revision()], [deferred, revision], 'reopening rewrites nothing and moves no state revision')
  await reopened.dispose()

  // A stored deferral no event names (no build wrote one) names no rows: its exit is the resume every deferral offers.
  write(7, "DELETE FROM events WHERE type='task/verification-deferred'; ")
  const unnamed = open()
  assert.deepEqual(taskOf(unnamed, review.id).verificationRecovery.toolRunIds, [])
  assert.equal(blockerOf(unnamed), `review ${review.id} deferred its verdict on this artifact: resume the review with swarm_control(action: "resume", taskId, reason)`)
})
