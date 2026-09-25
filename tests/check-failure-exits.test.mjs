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
 * checkout received (from the row's own environment record) and the
 * cancel-plus-replacement exit with its real tool parameters. The deferral
 * reason and the review-path blocker compose from the failure that ended the
 * deciding pass (the host stops a pass at its first failing check), so the
 * reason has a fixed maximum whatever the row carries. Each exit is performed
 * here through the registered tools, so a named parameter that the published
 * schema does not declare is refused.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerTools } from '../lib/tools.js'
import { toolSchemaIndex } from './refusal-inventory.mjs'
import { FakeWorkers, MISSION_ACCEPTANCE, WorkspaceWorkers, events, makeRepo, makeWorkspaces, setup, taskOf } from './faults/harness.mjs'

/** The owner's registered tools on the fixture's real runtime: every call is checked against its published schema. */
function ownerTools(f) {
  const definitions = new Map()
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, f.runtime, f.mission.budget)
  return async (name, args) => (await definitions.get(name).execute({ missionId: f.mission.id, ...args }, { signal: new AbortController().signal, agent: { id: f.owner.sessionId } })).result
}

/** Every `swarm_*(...)` call the text names, with each parameter it names checked against that tool's own schema. */
async function assertNamedCalls(text, expected) {
  const index = await toolSchemaIndex()
  const calls = [...text.matchAll(/(swarm_\w+)\(([^()]*)\)/g)].map(([, tool, args]) => [tool, args.replace(/"[^"]*"/g, '').match(/[A-Za-z]\w*/g) ?? []])
  assert.deepEqual(calls.map(([tool]) => tool).sort(), [...expected].sort(), `the exits named: ${text}`)
  for (const [tool, params] of calls) {
    assert.ok(index.toolNames.has(tool), `${tool} is a registered tool`)
    for (const param of params) assert.ok(index.ownProperties.get(tool).has(param), `${tool} declares ${param}`)
  }
}

const deferredReason = f => events(f.runtime, f.mission.id, 'task/verification-deferred').at(-1)?.data.reason
const hostRuns = f => f.runtime.store.list('tool_runs', f.mission.id).filter(run => run.tool === 'swarm.host_verification')

/** Submit `source` as the author, then claim an independent review of it as the reviewer. */
async function submitForReview(f, source, write = async () => {}) {
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await write(claimed)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'candidate' })
  const review = f.runtime.propose(f.owner, f.mission.id, {
    outputs: [], workstreamId: f.stream.id, title: `Review ${source.id}`, objective: 'Independently review the scoped change',
    kind: 'verification', reviewOf: source.id, scope: ['**'], acceptance: MISSION_ACCEPTANCE, assigneeId: f.reviewer.id,
  })
  const taken = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  return { review, verify: (reason = 'Review against acceptance') => f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: taken.attempt.id, verdict: 'accept', reason }) }
}

/** Resume a deferred review through swarm_control, let its stop barrier settle, and accept it on passing checks. */
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
  return { ...f, repo, tool: ownerTools(f) }
}

const answer = f => async () => { await writeFile(join(f.author.workspace, 'src/answer.txt'), 'candidate\n') }

test('exit 127: the row is unrunnable with the command\'s own output, and the environment exit really works', async t => {
  const f = await realFixture(t)
  const source = f.propose({ checks: ['PATH="$PWD/node_modules/.bin:$PATH" swarm-toolchain'] })
  const { review, verify } = await submitForReview(f, source, answer(f))
  const deferred = await verify()
  assert.equal(deferred.status, 'blocked', 'the review defers')
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
  assert.ok(reason.includes(`swarm_control(action: "resume", taskId: "${review.id}", reason: "condition repaired")`), 'the environment exit resumes the same review')
  assert.ok(reason.includes(`swarm_cancel(taskId: "${source.id}", reason)`) && reason.includes(`swarm_propose(replaces: ["${source.id}"], checks)`), 'the replacement exit is named')
  assert.doesNotMatch(reason, /checkTimeoutMs/, 'a deadline is not this failure\'s exit')
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
  assert.ok(reason.includes(`or, if the command itself is wrong, cancel the source with swarm_cancel(taskId: "${source.id}", reason) and repair it with swarm_propose(replaces: ["${source.id}"], checks) holding corrected commands`), reason)
  await assertNamedCalls(reason, ['swarm_control', 'swarm_cancel', 'swarm_propose'])

  // The command itself is wrong (the script is not executable): withdraw, then repair with corrected checks.
  await f.tool('swarm_cancel', { taskId: source.id, reason: 'the declared check cannot run as written' })
  assert.equal(taskOf(f.runtime, source.id).status, 'cancelled')
  assert.equal(taskOf(f.runtime, review.id).status, 'cancelled', 'the deferred review is retired with its source')
  const repair = await f.tool('swarm_propose', { workstreamId: f.stream.id, title: 'Repair', objective: 'Implement the scoped change',
    kind: 'implementation', scope: ['**'], replaces: [source.id], checks: ['sh ./check.sh'], assigneeId: f.author.id })
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
  return { ...f, tool: ownerTools(f) }
}

async function deferOn(f, rows, reason) {
  const source = f.propose()
  const { review, verify } = await submitForReview(f, source)
  f.workers.checks = rows
  const verdict = await verify(reason)
  f.workers.checks = [{ command: 'test -d .', exitCode: 0, output: 'ok' }]
  return { source, review, verdict }
}

const blocker = (f, source) => f.runtime.reviewPathBlocker(f.runtime.mission(f.mission.id), taskOf(f.runtime, source.id), f.runtime.store.list('members', f.mission.id))

test('exit 124: the reason names checkTimeoutMs through swarm_budget, and that exit really works', async t => {
  const f = await fakeFixture(t)
  const { source, review, verdict } = await deferOn(f, [{ command: 'test -d .', exitCode: 124, failureKind: 'timeout', output: '[swarm] Execution timed out after 30000ms' }])
  assert.equal(verdict.status, 'blocked')
  const reason = deferredReason(f)
  assert.ok(reason.includes(`a check reached its deadline: raise it with swarm_budget(taskId: "${source.id}", taskBudget: { checkTimeoutMs }, reason), then resume review ${review.id}`), reason)
  assert.doesNotMatch(reason, /swarm_cancel/)
  await assertNamedCalls(reason, ['swarm_budget', 'swarm_control'])
  await f.tool('swarm_budget', { taskId: source.id, taskBudget: { checkTimeoutMs: 90_000 }, reason: 'The suite needs a longer deadline' })
  assert.equal(taskOf(f.runtime, source.id).checkTimeoutMs, 90_000)
  assert.equal(taskOf(f.runtime, source.id).status, 'submitted')
  assert.equal((await resumeAndAccept(f, f.tool, review)).status, 'accepted')
})

test('a host that could not execute the check names the host repair, never checkTimeoutMs or a replacement', async t => {
  const f = await fakeFixture(t)
  const { source, review } = await deferOn(f, [{ command: '(verification preparation)', exitCode: 125, failureKind: 'infrastructure', output: 'Host verification could not execute: Error: git worktree failed (128)' }])
  const reason = deferredReason(f)
  assert.ok(reason.includes(`the host could not execute a check: repair the host condition its output reports, then resume review ${review.id}`), reason)
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

test('the review-path blocker composes the unrunnable exits from the stored row, and the reason fits the smallest message bound whatever the row carries', async t => {
  const f = await fakeFixture(t, { maxMessageChars: 1_000 })
  f.workers.artifact = { ...f.workers.artifact, commit: 'a'.repeat(64) }
  const materializedPaths = Array.from({ length: 40 }, (_, index) => `packages/p${index}/node_modules`)
  const { source, review } = await deferOn(f, [unrunnable({ dependencyLinks: { mode: 'copy', dirs: ['node_modules'], materializedPaths } })], 'r'.repeat(990))
  const reason = deferredReason(f)
  assert.ok(reason.length <= 1_000, `the composed reason stays within maxMessageChars: ${reason.length}`)
  assert.ok(reason.includes('dependency directories copied from the source: packages/p0/node_modules, '), reason)
  assert.ok(reason.includes(`swarm_propose(replaces: ["${source.id}"], checks)`), reason)
  const path = blocker(f, source)
  assert.ok(path.startsWith(`review ${review.id} deferred its verdict on this artifact: a command could not run`), path)
  assert.ok(path.includes(`swarm_cancel(taskId: "${source.id}", reason)`) && path.includes(`swarm_control(action: "resume", taskId: "${review.id}"`), path)

  const empty = await fakeFixture(t)
  await deferOn(empty, [unrunnable({ dependencyLinks: { mode: 'copy', dirs: ['node_modules', '.venv'], materializedPaths: [] } })])
  assert.ok(deferredReason(empty).includes('(dependency directories copied from the source: none of verificationDependencyDirs ["node_modules",".venv"])'), deferredReason(empty))

  // Nothing materialized and a long configured list: the list is rendered through the same bound
  // (unbounded, it made the deferral itself longer than maxMessageChars and swarm_verify threw).
  const configured = await fakeFixture(t, { maxMessageChars: 1_000 })
  const dirs = Array.from({ length: 30 }, (_, index) => `vendor-bundle-${index}`)
  const listed = await deferOn(configured, [unrunnable({ dependencyLinks: { mode: 'copy', dirs, materializedPaths: [] } })], 'r'.repeat(990))
  assert.equal(listed.verdict.status, 'blocked', 'the review defers')
  assert.equal(taskOf(configured.runtime, listed.source.id).status, 'submitted')
  const bounded = deferredReason(configured)
  assert.ok(bounded.length <= 1_000, `${bounded.length}: ${bounded}`)
  assert.match(bounded, /\(dependency directories copied from the source: none of verificationDependencyDirs \["vendor-bundle-0",[^)]*… \[\d+ more chars\]\): provide what it needs/)

  // One adapter pass holding a failure of every kind: the failure that ended the pass gives the one exit.
  const mixed = await fakeFixture(t, { maxMessageChars: 1_000 })
  const every = await deferOn(mixed, [
    { command: 'test -d .', exitCode: 124, failureKind: 'timeout', output: '[swarm] Execution timed out after 30000ms' },
    { command: '(verification preparation)', exitCode: 125, failureKind: 'infrastructure', output: 'Host verification could not execute: Error: EMFILE' },
    unrunnable({ dependencyLinks: { mode: 'copy', dirs: ['node_modules'], materializedPaths } }),
  ], 'r'.repeat(990))
  assert.equal(every.verdict.status, 'blocked', 'the review defers')
  const first = deferredReason(mixed)
  assert.ok(first.length <= 1_000, `${first.length}: ${first}`)
  assert.ok(first.includes(`a check reached its deadline: raise it with swarm_budget(taskId: "${every.source.id}", taskBudget: { checkTimeoutMs }, reason)`), first)
  assert.doesNotMatch(first, /could not execute a check|could not run in the clean/, 'one exit, the first failure\'s')
  assert.equal(blocker(mixed, every.source), `review ${every.review.id} deferred its verdict on this artifact: ${first.slice(first.indexOf('a check reached'), -1)}`)
})
