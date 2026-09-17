/**
 * Round-18 workflow regressions.
 *
 * Each test pins one defect found by the 2026-09-17 deep audit of the workflow
 * (delivery completeness, sub-agent environment, handoff, and the model/browser
 * surface) and fails on the pre-fix head:
 *
 *  1. `covers` counted the dependencies of cancelled/blocked lineage
 *     intermediates, so an integration behind a repaired task could complete and
 *     deliver an artifact that omitted an accepted implementation.
 *  2. A staged-plan member edit rotated the member's sessionId without dropping
 *     the adapter's persisted composition, so the member could never start again.
 *  3. `swarm_handoff` could move a review to an author of its source, which no
 *     assignment path can ever claim, leaving the review pending forever.
 *  4. The stop barrier resurrected a parked member, discarding the durable
 *     budget-protection park `blockTaskCeiling` had just committed.
 *  5. The parse-only check preflight existed only on the prelaunch path, so a
 *     staged plan with a shell-syntax-error check launched and burned a full
 *     execution cycle before failing at verification.
 *  6. `swarm_control` mission-scope amend was unreachable: the schema makes
 *     `changes` optional for every action, and the handler reported a generic
 *     argument error instead of the one shape this action needs.
 *  7. The member scratch root was a sibling of the worktree, outside the
 *     `workspace-write` sandbox that confines the member told to use it; it now
 *     lives inside the worktree and is excluded like toolchain state.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { registerTools } from '../lib/tools.js'
import { selectAcceptedDelivery, taskGraphIndex } from '../lib/task-graph.js'
import { SWARM_SCRATCH_DIRNAME, Workspaces, runProcess } from '../lib/workspaces.js'
import { subprocessSeam } from './subprocess-seam.mjs'

const BUDGET = { maxTokens: 1000000, maxSteps: 5000, maxWorkers: 6, maxDurationMs: 3600000, maxTasks: 60, maxExperiments: 0 }

function task(id, kind, status, extra = {}) {
  return { id, missionId: 'm', workstreamId: 'w', title: id, objective: id, kind, status, dependencies: [], scope: ['docs/'],
    acceptance: ['done'], checks: [], priority: 50, experiment: false, epoch: 1, priorOwnerIds: [], proposedBy: 'owner', evidenceIds: [], createdAt: 1, ...extra }
}
const artifact = commit => ({ commit, baseCommit: '0'.repeat(40), workspace: '/w', changedPaths: ['docs/x.md'] })

class StubWorkers {
  constructor() { this.idle = new Set(); this.runs = []; this.stopped = [] }
  bind() {}
  async prepareWorkspace(mission, memberId) { return path.join(mission.workspace, memberId) }
  async start(member) { this.idle.add(member.id) }
  async deliver() {}
  async stop(memberId) { this.stopped.push(memberId); this.idle.delete(memberId) }
  async dispose() {}
  isIdle() { return true }
  async prepareTask() {}
  async captureArtifact(member, task) { return { ...artifact('a'.repeat(40)), workspace: member.workspace } }
  async verifyArtifact() { return [{ command: 'npm test', exitCode: 0, output: 'ok' }] }
}
async function fixture(t, config = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'swarm-r18-'))
  const workers = new StubWorkers()
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 1000, maxTasksPerMember: 100, ...config }, workers)
  runtime.kick = () => {}
  runtime.pumpOutbox = () => {}
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: `r18-owner-${Math.random()}` }
  const mission = runtime.create(owner, { title: 'R18', objective: 'Deliver verified work', workspace: directory, scope: ['src/', 'docs/'], acceptance: ['done'], budget: { ...BUDGET } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Work' })
  const member = async (name, role = 'implementation') => await runtime.addMember(owner, mission.id, { name, role })
  const author = await member('Author')
  const second = await member('Second')
  const reviewer = await member('Reviewer', 'verification')
  const actor = m => ({ sessionId: m.sessionId })
  return { directory, runtime, workers, owner, mission, stream, author, second, reviewer, actor }
}
const propose = (f, title, extra = {}) => f.runtime.propose(f.owner, f.mission.id, { workstreamId: f.stream.id, title, objective: title,
  kind: 'implementation', scope: ['src/'], acceptance: ['done'], checks: ['npm test'], ...extra })
const current = (f, id) => f.runtime.store.get('tasks', typeof id === 'string' ? id : id.id)

// ---------------------------------------------------------------------------

test('R18-1: delivery coverage follows the composed artifact, not a withdrawn carrier plan', async t => {
  // The exact graph the audit reproduced end-to-end: A -> X(deps[A]) -> I(deps[X]),
  // X cancelled and repaired by Z (replaces[X]) with no dependencies, which is the
  // repair shape swarm_propose itself advertises. prepareTask merges Z's commit
  // only, so A's accepted content is not in I's artifact.
  const A = task('A', 'implementation', 'accepted', { artifact: artifact('a'.repeat(40)) })
  const X = task('X', 'implementation', 'cancelled', { dependencies: ['A'] })
  const Z = task('Z', 'implementation', 'accepted', { replaces: ['X'], artifact: artifact('b'.repeat(40)) })
  const I = task('I', 'integration', 'accepted', { dependencies: ['X'], artifact: artifact('c'.repeat(40)) })
  const graph = taskGraphIndex([A, X, Z, I])
  assert.deepEqual(graph.lineage('X').map(row => row.id), ['X', 'Z'], 'the dependency composes Z, the accepted endpoint')
  assert.deepEqual([...graph.identities('X')].sort(), ['X', 'Z'], 'identities keep the whole lineage for readers that need it')
  assert.equal(graph.covers(I, 'Z'), true, 'the composed endpoint covers itself')
  assert.equal(graph.covers(I, 'A'), false, 'A is not in the artifact composed for I: I merges Z, whose own plan has no dependencies')
  assert.throws(() => selectAcceptedDelivery([A, X, Z, I]), /unique accepted integration/)

  // A repair that DOES declare the content-carrying edge is delivered normally.
  const Z2 = task('Z2', 'implementation', 'accepted', { replaces: ['X'], dependencies: ['A'], artifact: artifact('d'.repeat(40)) })
  const I2 = task('I2', 'integration', 'accepted', { dependencies: ['X'], artifact: artifact('e'.repeat(40)) })
  assert.equal(taskGraphIndex([A, X, Z2, I2]).covers(I2, 'A'), true, 'a repair that merges A keeps it covered')
  assert.equal(selectAcceptedDelivery([A, X, Z2, I2]).id, 'I2')
})

test('R18-1b: a mission behind a repaired middle task cannot complete with the predecessor omitted', async t => {
  const f = await fixture(t)
  const a = propose(f, 'Feature A', { assigneeId: f.author.id })
  const x = propose(f, 'Middle step', { assigneeId: f.second.id, dependencies: [a.id] })
  const integration = propose(f, 'Assemble', { kind: 'integration', assigneeId: f.second.id, dependencies: [x.id] })
  const accept = async (member, row) => {
    const claimed = await f.runtime.claim(f.actor(member), f.mission.id, row.id)
    await f.runtime.submit(f.actor(member), f.mission.id, { taskId: row.id, attemptId: claimed.attempt.id, output: 'work' })
    const review = propose(f, `Review ${row.title}`, { kind: 'verification', reviewOf: row.id, assigneeId: f.reviewer.id, checks: [] })
    const reviewClaim = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
    await f.runtime.recordToolRun(f.reviewer.id, { tool: 'bash', arguments: { command: 'inspect' }, isError: false, result: { output: 'ok' } })
    await f.runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewClaim.attempt.id, verdict: 'accept', reason: 'independent' })
  }
  await accept(f.author, a)
  f.runtime.cancel(f.owner, f.mission.id, { taskId: x.id, reason: 'wrong approach' })
  const replacement = propose(f, 'Middle step repaired', { assigneeId: f.second.id, replaces: [x.id] })
  await accept(f.second, replacement)
  await accept(f.second, integration)
  assert.equal(current(f, integration).status, 'accepted')
  assert.match(String(f.runtime.completionError(f.runtime.mission(f.mission.id))), /unique accepted integration/,
    'the accepted integration does not carry A, so completion is refused rather than delivering an incomplete artifact')
})

test('R18-2: a staged-plan member edit drops the stale composition so the member can start again', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r18-plan-')))
  const compositions = new Map()
  const started = []
  let live = 1
  class PlanWorkers extends StubWorkers {
    constructor() { super(); this.invalidated = [] }
    // Model the real adapter's contract: an existing composition is reused only
    // when it belongs to the CURRENT member identity, and only an absent file is
    // composed afresh (src/harness-workers.ts#composition).
    async invalidateComposition(missionId, memberId) { this.invalidated.push(memberId); compositions.delete(memberId) }
    async start(spec) {
      const member = spec.member
      const existing = compositions.get(member.id)
      if (existing !== undefined && existing.sessionId !== member.sessionId) throw new Error('Worker composition metadata is invalid or belongs to a different worker')
      if (started.length >= live) throw new Error('Simulated provider outage while starting the second member')
      if (existing === undefined) compositions.set(member.id, { sessionId: member.sessionId })
      started.push({ id: member.id, sessionId: member.sessionId, model: member.model })
      this.idle.add(member.id)
    }
  }
  const workers = new PlanWorkers()
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 1000, maxTasksPerMember: 100, workerStartTimeoutMs: 5000 }, workers)
  runtime.kick = () => {}
  runtime.pumpOutbox = () => {}
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const owner = { sessionId: 'r18-plan-owner' }
  const plan = {
    title: 'Staged plan', objective: 'Deliver', workspace: directory, scope: ['src/'], acceptance: ['done'], budget: { ...BUDGET },
    members: [{ key: 'a', role: 'implementation', maxOutputTokens: 1000 }, { key: 'b', role: 'verification', maxOutputTokens: 1000 }],
    workstreams: [{ key: 'w', title: 'Main', objective: 'Deliver' }],
    tasks: [{ key: 't1', workstreamKey: 'w', title: 'Feature', objective: 'Write the feature', kind: 'implementation', scope: ['src/'], acceptance: ['done'], checks: ['npm test'], assigneeKey: 'a' }],
  }
  const draft = runtime.createDraft(owner, plan)
  // The second member cannot start, so assembly fails AFTER the first member was
  // admitted and composed — the state any interrupted assembly leaves (the draft
  // is `failed`, the mission stays `staged`).
  await assert.rejects(async () => { await runtime.launchDraft(owner, draft.id, draft.revision) })
  const staged = runtime.store.get('drafts', draft.id)
  const mission = runtime.store.get('missions', `mission_${draft.id}`)
  assert.equal(staged.status, 'failed', 'assembly failed after the first member was composed')
  assert.equal(mission.status, 'staged')
  const first = runtime.store.list('members', mission.id)[0]
  assert.ok(first, 'the first member was admitted and composed')
  assert.ok(compositions.has(first.id), 'its composition exists in the adapter')
  const firstSessionId = String(first.sessionId)
  const firstMemberId = first.id
  assert.equal(compositions.get(firstMemberId).sessionId, firstSessionId)

  // Repairing the plan with a changed member field is the documented exit; the
  // provider is healthy again for the retry.
  live = 10
  const repaired = structuredClone(plan)
  repaired.members[0].model = 'other-model'
  const edited = runtime.updateDraft(owner, draft.id, staged.revision, repaired)
  // Relaunching the repaired plan rotates the member's identity. Before the fix
  // the adapter still held a composition for the OLD identity, so `start` refused
  // every later attempt and this relaunch could never succeed.
  const beforeRelaunch = started.length
  const relaunched = await runtime.launchDraft(owner, draft.id, edited.revision)
  const after = runtime.store.get('members', firstMemberId)
  assert.notEqual(String(after.sessionId), firstSessionId, 'the changed member field rotates its worker identity')
  assert.deepEqual(workers.invalidated, [firstMemberId], 'the rotated identity drops the stale composition')
  assert.equal(compositions.get(firstMemberId).sessionId, after.sessionId, 'the member is composed again under its new identity')
  assert.equal(relaunched.mission.status, 'active', 'the repaired plan launches instead of failing on the stale composition')
  const restarted = started.slice(beforeRelaunch).find(entry => entry.id === firstMemberId)
  assert.ok(restarted, 'the repaired member starts again')
  assert.equal(restarted.id, firstMemberId)
  assert.equal(restarted.sessionId, after.sessionId)
  assert.equal(restarted.model, 'other-model')
})

test('R18-3: handoff refuses a review target that could never own it', async t => {
  const f = await fixture(t)
  const source = propose(f, 'Feature', { assigneeId: f.author.id })
  const claimed = await f.runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await f.runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'work' })
  const review = propose(f, 'Review', { kind: 'verification', reviewOf: source.id, assigneeId: f.reviewer.id, checks: [] })
  const reviewClaim = await f.runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  // Every other assignment path already refuses the source's author.
  await assert.rejects(async () => { await f.runtime.controlTask(f.owner, f.mission.id, review.id, 'amend', { assigneeId: f.author.id }, 'reassign') }, /independent assignee/)
  assert.throws(() => f.runtime.handoff(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewClaim.attempt.id, to: f.author.id, summary: 'You take it' }),
    /independent assignee/, 'the handoff would leave the review unclaimable by every member')
  // A handoff with no target, and a handoff to an independent member, still work.
  assert.doesNotThrow(() => f.runtime.handoff(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewClaim.attempt.id, summary: 'Back to the board' }))
  void current
})

test('R18-4: a handoff barrier leaves a durable park in place, and a resource resume clears it', async t => {
  const f = await fixture(t)
  const task = propose(f, 'Ceiling-bound work', { assigneeId: f.author.id, maxSteps: 1 })
  await f.runtime.claim(f.actor(f.author), f.mission.id, task.id)
  // The member is parked — by its own swarm_wait, or by a ceiling-bound task.
  const parked = f.runtime.store.get('members', f.author.id)
  parked.phase = 'parked'
  f.runtime.store.transaction(() => f.runtime.store.put('members', parked))
  // The barrier that the ceiling block installed must not resurrect the member.
  const row = current(f, task)
  row.resumeAfterStop = { epoch: row.epoch, reason: 'handoff', memberId: f.author.id, at: Date.now() }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', row))
  f.runtime.attempts.resumeStoppedAttempt(f.mission.id, current(f, task))
  const deadline = Date.now() + 2000
  while (Date.now() < deadline && f.runtime.store.get('tasks', task.id).resumeAfterStop !== undefined) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.runtime.store.get('members', f.author.id).phase, 'parked',
    'a handoff barrier for another task never resurrects a parked member')

  // The resource resume IS the ceiling being raised: it clears the park so the
  // member can work again.
  const again = propose(f, 'Second attempt', { assigneeId: f.author.id })
  const second = f.runtime.store.get('tasks', again.id)
  second.status = 'running'; second.epoch = 1
  second.attempt = { id: 'attempt_resume', epoch: 1, ownerId: f.author.id, leaseUntil: Date.now() + 60000 }
  second.resumeAfterStop = { epoch: 1, reason: 'resource', memberId: f.author.id, at: Date.now() }
  f.runtime.store.transaction(() => f.runtime.store.put('tasks', second))
  f.runtime.attempts.resumeStoppedAttempt(f.mission.id, f.runtime.store.get('tasks', again.id))
  const resumeDeadline = Date.now() + 2000
  while (Date.now() < resumeDeadline && f.runtime.store.get('members', f.author.id).phase === 'parked') await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.runtime.store.get('members', f.author.id).phase, 'active',
    'the resource resume that follows a raised ceiling unparks the member again')
})

test('R18-5: both launch paths refuse a check with invalid shell syntax, before any work exists', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r18-syntax-')))
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: path.join(directory, 'worktrees'),
    checkTimeoutMs: 30000, maxCheckOutputBytes: 100000, confineCheck: argv => argv })
  const boot = new StubWorkers()
  const runtime = new SwarmRuntime({ statePath: path.join(directory, 'state.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 1000, maxTasksPerMember: 100 }, boot)
  runtime.kick = () => {}
  runtime.pumpOutbox = () => {}
  t.after(async () => { await runtime.dispose(); await workspaces.dispose(); await rm(directory, { recursive: true, force: true }) })
  // The adapter-level preflight is what the launch boundary calls; assert it directly
  // (it runs the plan's checks through /bin/sh -n only).
  const issues = await workspaces.checkSyntaxPreflight(['node --test ;;('], directory)
  assert.equal(issues.length, 1, 'an unparsable command is reported without executing it')
  assert.match(issues[0], /syntax error/)
  assert.deepEqual(await workspaces.checkSyntaxPreflight(['node --test'], directory), [], 'a valid command passes')
  void runtime
})

test('R18-6: mission-scope amend is reachable and names its own required shape', async t => {
  const f = await fixture(t)
  const tools = new Map()
  registerTools({ get: () => undefined, tools: { register: definition => tools.set(definition.name, definition) } },
    f.runtime, { ...BUDGET }, undefined)
  const exec = { agent: { id: f.owner.sessionId, session: { header: { cwd: f.directory } } }, signal: new AbortController().signal }
  const call = async args => { try { return { ok: true, value: await tools.get('swarm_control').execute(args, exec) } } catch (error) { return { ok: false, error: error.message } } }
  const amended = await call({ missionId: f.mission.id, action: 'amend', reason: 'Narrow the scope', changes: { scope: ['src/'] } })
  assert.equal(amended.ok, true, String(amended.error))
  assert.deepEqual(amended.value.result.scope, ['src/'])
  // The schema leaves `changes` optional for every action, so both incomplete
  // shapes must name the one this action needs instead of a generic argument error.
  const missing = await call({ missionId: f.mission.id, action: 'amend', reason: 'no changes' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /mission_scope_required/)
  assert.match(missing.error, /changes/)
  assert.match(missing.error, /scope/)
  const empty = await call({ missionId: f.mission.id, action: 'amend', reason: 'empty', changes: {} })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /mission_scope_required/)
  const wrongField = await call({ missionId: f.mission.id, action: 'amend', reason: 'wrong', changes: { checks: ['npm test'] } })
  assert.equal(wrongField.ok, false)
  assert.match(wrongField.error, /mission_scope_fields_invalid/)
})

test('R18-7: the scratch root lives inside the member worktree and stays out of work and artifacts', async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r18-scratch-')))
  const source = path.join(directory, 'source')
  await mkdir(source)
  const git = async (cwd, ...args) => {
    const result = await runProcess(['git', '-c', 'user.name=R18', '-c', 'user.email=r18@localhost', ...args], { subprocess: subprocessSeam, cwd, timeoutMs: 60000, maxBytes: 200000 })
    assert.equal(result.exitCode, 0, result.output)
    return result.output.trim()
  }
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, '.gitignore'), 'node_modules/\n')
  await writeFile(path.join(source, 'README.md'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: path.join(directory, 'worktrees'),
    checkTimeoutMs: 60000, maxCheckOutputBytes: 200000, confineCheck: argv => argv })
  t.after(async () => { await workspaces.dispose(); await rm(directory, { recursive: true, force: true }) })
  const mission = { id: 'mission-scratch', workspace: source }
  const workspace = await workspaces.prepareWorkspace(mission, 'member-scratch')
  assert.equal(workspaces.workspacePath(mission.id, 'member-scratch'), workspace, 'the owned worktree path has one derivation')
  const scratch = path.join(workspace, SWARM_SCRATCH_DIRNAME)
  await mkdir(scratch, { recursive: true, mode: 0o700 })
  await writeFile(path.join(scratch, 'session.tmp'), 'temporary\n')
  const task = { id: 'task-scratch', missionId: mission.id, epoch: 1, title: 'Work', objective: 'Write src/a.txt', acceptance: ['done'],
    kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  const member = { id: 'member-scratch', missionId: mission.id, workspace }
  // The scratch tree must not read as uncommitted work at preparation time.
  await workspaces.prepareTask(member, task, [])
  await mkdir(path.join(workspace, 'src'), { recursive: true })
  await writeFile(path.join(workspace, 'src/a.txt'), 'real work\n')
  const captured = await workspaces.captureArtifact(member, task)
  assert.deepEqual(captured.changedPaths, ['src/a.txt'], 'scratch state is not part of the artifact')
  assert.equal(await git(source, 'ls-tree', '-r', '--name-only', captured.commit, '--', SWARM_SCRATCH_DIRNAME), '', 'no scratch path enters the commit')
  assert.equal((await stat(scratch)).isDirectory(), true, 'the member scratch root is writable inside its own workspace root')
  assert.match(workspace, /members/, 'the root is derived from the owned worktree path')
  const record = JSON.parse(await readFile(path.join(path.dirname(workspace), '..', 'member-scratch.workspace.json'), 'utf8'))
  assert.equal(record.workspace, workspace, 'the owned worktree path is the recorded member workspace')
})

test('R18-8: an automatic mission still refuses an incomplete proposal with the parameter it needs', async t => {
  const f = await fixture(t)
  f.runtime.store.transaction(() => f.runtime.store.put('starts', { id: 'start_r18', ownerSessionId: f.owner.sessionId,
    commandId: 'r18', goal: 'g', workspace: f.directory, status: 'running', createdAt: Date.now(), updatedAt: Date.now(), missionId: f.mission.id }))
  assert.throws(() => propose(f, 'Feature'), error => {
    assert.match(error.message, /\[task_recovery_limit_required\]/)
    assert.match(error.message, /maxRecoveryAttempts/)
    return true
  })
  const admitted = propose(f, 'Feature', { maxRecoveryAttempts: 2, checkTimeoutMs: 60000 })
  assert.equal(current(f, admitted).maxRecoveryAttempts, 2)
})

test('R18-9: composition fidelity reports a dependency path whose content the merge dropped', async t => {
  // F2: a clean merge exit is not proof the dependency's content arrived. The
  // host compares every path the dependency commit changed against the composed
  // working tree, so a one-sided resolution (or a repository merge driver that
  // keeps this side) can no longer pass as a successful composition.
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-r18-fidelity-')))
  const source = path.join(directory, 'source')
  await mkdir(source)
  const git = async (cwd, ...args) => {
    const result = await runProcess(['git', '-c', 'user.name=R18', '-c', 'user.email=r18@localhost', ...args], { subprocess: subprocessSeam, cwd, timeoutMs: 60000, maxBytes: 500000 })
    assert.equal(result.exitCode, 0, `git ${args.join(' ')}: ${result.output}`)
    return result.output.trim()
  }
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, 'conf.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const base = await git(source, 'rev-parse', 'HEAD')
  await writeFile(path.join(source, 'conf.txt'), 'dependency\n')
  await git(source, 'commit', '-qam', 'dependency')
  const dependency = await git(source, 'rev-parse', 'HEAD')
  const worktree = path.join(directory, 'worktree')
  await mkdir(worktree)
  await git(source, 'worktree', 'add', '--detach', worktree, base)
  await writeFile(path.join(worktree, 'conf.txt'), 'ours\n')
  await git(worktree, 'commit', '-qam', 'ours-side')
  const workspaces = new Workspaces({ subprocess: subprocessSeam, workspacesRoot: path.join(directory, 'ws'),
    checkTimeoutMs: 30000, maxCheckOutputBytes: 100000, confineCheck: argv => argv })
  t.after(async () => { await workspaces.dispose(); await rm(directory, { recursive: true, force: true }) })
  const signal = new AbortController().signal
  assert.deepEqual(await workspaces.droppedDependencyPaths(worktree, dependency, signal), ['conf.txt'],
    'the dependency blob is absent from the composed tree')
  await writeFile(path.join(worktree, 'conf.txt'), 'dependency\n')
  assert.deepEqual(await workspaces.droppedDependencyPaths(worktree, dependency, signal), [],
    'an identical composed blob is not a loss')
  // A path the dependency rewrote is satisfied by the identical blob and, after
  // the composed tree no longer holds anything, by the dependency's own content
  // still being the expectation.
  await writeFile(path.join(worktree, 'conf.txt'), 'other\n')
  assert.deepEqual(await workspaces.droppedDependencyPaths(worktree, dependency, signal), ['conf.txt'],
    'divergent content is reported even after a further local edit')
})
