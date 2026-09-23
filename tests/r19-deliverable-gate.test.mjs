/**
 * Round-19 H-1 (reworked after review): the undeclared-deliverable gate fires
 * on a precise signal and never strands a mission.
 *
 * Pre-fix, a research task whose text named `docs/report.md` (hidden by a
 * `docs/.gitignore` of `*`) was accepted with an artifact that omitted the
 * report when the member left `deliverables` empty. The first gate (dc8d0f5)
 * over-corrected: every in-scope path token after a write verb became an
 * obligation, so a directory token (`src/`) could never be satisfied, an
 * ignored input (`.env`) was refused with advice to force-capture it, a
 * tracked input that was only read had to be declared as delivered, and the
 * completion-time re-check stranded rows accepted before the gate.
 *
 * Now `Workspaces.captureArtifact` lists only an in-scope, ignored, undeclared
 * name that is a regular file in the member worktree; `submit()` refuses on
 * that list for every task kind with two repairs (declare or remove);
 * completion never re-checks, and the coverage / completion notice names any
 * legacy accepted row that still carries `uncapturedPaths`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'
import { assessRefusal, assessText, diagnosticProducers, refusalSites, toolSchemaIndex } from './refusal-inventory.mjs'

const schemaIndex = await toolSchemaIndex()

const budget = { maxTokens: 100000, maxSteps: 1000, maxWorkers: 2, maxTasks: 12, maxExperiments: 0, maxDurationMs: 600000 }
async function eventually(read, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = read()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(message)
}
const ownerNotices = (runtime, missionId) => runtime.store.list('deliveries', missionId).filter(delivery => delivery.to === 'owner' && delivery.kind === 'control')

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r19-deliverable-')))
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'docs'), { recursive: true })
  await mkdir(path.join(source, 'notes'), { recursive: true })
  await mkdir(path.join(source, 'src'), { recursive: true })
  const run = (cwd, argv) => runProcess(argv, { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 })
  const command = async (cwd, argv) => {
    const result = await run(cwd, argv)
    assert.equal(result.exitCode, 0, result.output)
    return result.output.trim()
  }
  await command(source, ['git', 'init', '-b', 'main'])
  await writeFile(path.join(source, 'README.md'), 'Fixture\n')
  // The shape this repository ships: docs/ ignores everything but named files,
  // and the root ignores the local environment file.
  await writeFile(path.join(source, '.gitignore'), '.env\n')
  await writeFile(path.join(source, 'docs', '.gitignore'), '*\n!.gitignore\n')
  await writeFile(path.join(source, 'notes', '.gitkeep'), '')
  await writeFile(path.join(source, 'src', 'index.js'), 'export const answer = 42\n')
  await command(source, ['git', 'add', '.'])
  await command(source, ['git', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', 'baseline'])
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: path.join(root, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv })
  const workers = {
    bind(callbacks) { this.callbacks = callbacks },
    prepareBaseline: (...args) => workspaces.prepareBaseline(...args),
    prepareWorkspace: (...args) => workspaces.prepareWorkspace(...args),
    prepareTask: (...args) => workspaces.prepareTask(...args),
    captureArtifact: (...args) => workspaces.captureArtifact(...args),
    inspectArtifact: (...args) => workspaces.inspectArtifact(...args),
    verifyArtifact: (...args) => workspaces.verifyArtifact(...args),
    start: async () => {}, stop: async () => {}, deliver: async () => {}, isIdle: () => false,
    dispose: () => workspaces.dispose(),
  }
  const runtime = new SwarmRuntime({ statePath: path.join(root, 'state.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 16000, maxEvents: 200, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const owner = { sessionId: 'owner' }
  const mission = runtime.create(owner, { title: 'Report', objective: 'Report on the project', workspace: source, scope: ['**'], acceptance: ['Reviewed'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Report', objective: 'Report on the project' })
  const author = await runtime.addMember(owner, mission.id, { role: 'research' })
  const reviewer = await runtime.addMember(owner, mission.id, { role: 'verification' })
  const a = { sessionId: author.sessionId }, b = { sessionId: reviewer.sessionId }
  const propose = extra => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Report', objective: 'Inspect the repository', scope: ['docs/', 'notes/'], acceptance: ['Reviewed'], kind: 'research', checks: [], ...extra })
  const readEvidence = async (member, actor, task, file) => {
    const result = await readFile(path.join(member.workspace, file), 'utf8')
    await workers.callbacks.toolRun(member.id, { tool: 'read', arguments: { path: file }, result, isError: false })
    const runs = runtime.observe(actor, mission.id, { taskId: task.id }).toolRuns
    return runtime.publish(actor, mission.id, { taskId: task.id, attemptId: task.attempt.id, claim: `Read ${file}`, outcome: 'supported', toolRunIds: [runs.at(-1).id] })
  }
  const submit = (task, input) => runtime.submit(a, mission.id, { taskId: task.id, attemptId: task.attempt.id, output: 'Done', ...input })
  const accept = async (task, file) => {
    const review = await runtime.claim(b, mission.id, propose({ kind: 'verification', reviewOf: task.id, scope: ['**'] }).id)
    await readEvidence(reviewer, b, review, file)
    await runtime.verify(b, mission.id, { taskId: review.id, attemptId: review.attempt.id, verdict: 'accept', reason: 'Read the immutable artifact' })
    return runtime.snapshot(owner, mission.id)
  }
  const taskRow = id => runtime.snapshot(owner, mission.id).tasks.find(row => row.id === id)
  const inCommit = async (commit, file) => (await run(author.workspace, ['git', 'cat-file', '-e', `${commit}:${file}`])).exitCode === 0
  const refused = (error, paths) => {
    assert.equal(error.name, 'PolicyError')
    assert.equal(error.code, 'deliverable_uncaptured')
    assert.ok(error.message.startsWith('[deliverable_uncaptured]'), error.message)
    for (const name of paths) assert.ok(error.message.includes(JSON.stringify(name)), `${error.message} names ${name}`)
    assert.ok(error.message.includes(`retry \`swarm_submit\` with \`deliverables\`: ${JSON.stringify(paths)}`), `${error.message} offers the declare repair`)
    assert.match(error.message, /remove them from your worktree and retry `swarm_submit`/, 'the second repair is removal')
    assert.doesNotMatch(error.message, /input/i, 'the refusal never suggests declaring an input')
    assert.deepEqual(assessText(error.message, schemaIndex), [], `the rendered refusal satisfies the refusal contract: ${error.message}`)
    return true
  }
  return { root, source, runtime, workers, workspaces, owner, mission, author, reviewer, a, b, propose, readEvidence, submit, accept, taskRow, inCommit, refused }
}

test('both typed deliverable_uncaptured refusals are in the refusal inventory and satisfy its contract', async () => {
  const file = 'src/runtime.ts'
  const sites = refusalSites(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), file)
  const typed = sites.filter(site => site.code === 'deliverable_uncaptured')
  assert.deepEqual(typed.map(site => [site.kind, site.errorClass, site.codes]), [
    ['coded-throw', 'PolicyError', ['deliverable_uncaptured']], ['coded-throw', 'PolicyError', ['deliverable_uncaptured']],
  ], 'the submit and the verify refusal are both walked')
  assert.deepEqual(typed.map(site => site.tools), [['swarm_submit'], ['swarm_verify']])
  const producers = diagnosticProducers([sites])
  for (const site of typed) assert.deepEqual(assessRefusal(site, { ...schemaIndex, diagnosticProducers: producers }), [], site.text)
})

test('a legacy accepted artifact that still lists uncapturedPaths keeps the mission eligible, and the coverage notice names the task and paths', async t => {
  const f = await fixture(t)
  // A row accepted before the submit gate (or through a foreign adapter) is immutable: no amend, replace or cancel.
  const row = { id: 'task_legacy_report', missionId: f.mission.id, workstreamId: 'stream', title: 'Legacy report', objective: 'Write docs/report.md', kind: 'research',
    dependencies: [], scope: ['docs/'], acceptance: ['Reviewed'], checks: [], status: 'accepted', priority: 50, experiment: false, epoch: 1, evidenceIds: [],
    artifact: { commit: 'a'.repeat(40), baseCommit: 'a'.repeat(40), workspace: '/isolated', changedPaths: [], uncapturedPaths: ['docs/report.md'] } }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', row))
  const completion = f.runtime.snapshot(f.owner, f.mission.id).completion
  assert.equal(completion.eligible, true, completion.reason)
  f.runtime.notifyCoverageComplete(f.runtime.store.get('missions', f.mission.id))
  const notice = ownerNotices(f.runtime, f.mission.id).find(delivery => /ready to complete/.test(delivery.content))
  assert.ok(notice, 'the coverage-complete notice is written')
  assert.match(notice.content, /task_legacy_report/)
  assert.match(notice.content, /"docs\/report\.md"/)
  assert.equal(f.runtime.control(f.owner, f.mission.id, 'complete', 'Report accepted').status, 'completed')
})

test('automatic completion names a legacy accepted artifact that still lists uncapturedPaths instead of stranding the mission', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'swarm-r19-legacy-'))
  const workers = {
    bind(callbacks) { this.callbacks = callbacks },
    async prepareBaseline() { return { sourceHead: 'b'.repeat(40), snapshotCommit: 'b'.repeat(40), planningWorkspace: '/planning', changedPaths: [], createdAt: Date.now() } },
    async prepareWorkspace(mission, id) { return path.join(mission.workspace, id) },
    async prepareTask() {}, async start() {}, async stop() {}, async dispose() {}, async deliver() {}, isIdle: () => false,
    async captureArtifact(member, task) { return { commit: `captured-${task.id}`, baseCommit: 'b'.repeat(40), workspace: member.workspace, changedPaths: [] } },
    async verifyArtifact() { return [] },
  }
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'swarm.sqlite'), tickMs: 10, leaseMs: 60000, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 20 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'legacy-owner' }
  const common = { workstreamKey: 'report', scope: ['docs/'], acceptance: ['Reviewed'], maxRecoveryAttempts: 3 }
  const request = runtime.requestStart(owner, { commandId: 'legacy-command', goal: 'Write the report', workspace: directory })
  const snapshot = await runtime.startPlan(owner, request.id, {
    title: 'Legacy report', objective: 'Write the report', workspace: directory, scope: ['docs/'], acceptance: ['Reviewed'], budget,
    members: [{ key: 'author', name: 'Author', role: 'research', maxOutputTokens: 2048 }, { key: 'reviewer', name: 'Reviewer', role: 'verification', maxOutputTokens: 2048 }],
    workstreams: [{ key: 'report', title: 'Report', objective: 'Write the report' }],
    tasks: [{ ...common, key: 'r_report', title: 'Report', objective: 'Write docs/report.md', kind: 'research', assigneeKey: 'author', dependencies: [] },
      { ...common, key: 'v_report', title: 'Review', objective: 'Review the report', kind: 'verification', assigneeKey: 'reviewer', reviewOf: 'r_report' }],
  })
  const missionId = snapshot.mission.id
  const actor = name => ({ sessionId: snapshot.members.find(member => member.name === name).sessionId })
  const memberId = name => snapshot.members.find(member => member.name === name).id
  const task = key => runtime.store.list('tasks', missionId).find(item => item.id.endsWith(`_${key}`))
  const source = task('r_report')
  const claimed = await runtime.claim(actor('Author'), missionId, source.id)
  const runId = await workers.callbacks.toolRun(memberId('Author'), { tool: 'read_file', arguments: { path: 'docs/report.md' }, result: 'Recorded findings', isError: false })
  runtime.publish(actor('Author'), missionId, { taskId: source.id, attemptId: claimed.attempt.id, claim: 'Host-backed findings', outcome: 'supported', toolRunIds: [runId] })
  await runtime.submit(actor('Author'), missionId, { taskId: source.id, attemptId: claimed.attempt.id, output: 'Report' })
  // The stored artifact of a pre-gate row still carries the omission.
  runtime.store.transaction(() => {
    const current = runtime.store.get('tasks', source.id)
    runtime.store.put('tasks', { ...current, artifact: { ...current.artifact, uncapturedPaths: ['docs/report.md'] } })
  })
  const review = task('v_report')
  const claimedReview = await runtime.claim(actor('Reviewer'), missionId, review.id)
  await workers.callbacks.toolRun(memberId('Reviewer'), { tool: 'read_file', arguments: { path: 'docs/report.md' }, result: 'Independently checked', isError: false })
  await runtime.verify(actor('Reviewer'), missionId, { taskId: review.id, attemptId: claimedReview.attempt.id, verdict: 'accept', reason: 'Independent evidence supports the artifact' })
  await eventually(() => runtime.store.get('missions', missionId).status === 'completed', 'the legacy omission must not strand completion')
  assert.equal(runtime.store.events(missionId, 500).filter(event => event.type === 'automatic/completed').length, 1)
  const notice = await eventually(() => ownerNotices(runtime, missionId).find(delivery => /^Completed /.test(delivery.content)), 'the completion notice is written')
  assert.match(notice.content, new RegExp(source.id))
  assert.match(notice.content, /"docs\/report\.md"/)
})
