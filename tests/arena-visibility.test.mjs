/**
 * T1c arena visibility (mission criterion 2: registry, arena view, R11-14).
 *
 * Contracts pinned here:
 *  - R11-14/A2-04: artifact and baseline refs are published into a per-mission
 *    private repository, never `refs/swarm/*` in the shared source repository,
 *    so a member of one mission cannot enumerate another mission's artifacts
 *    through the common git dir. Capture, review and dependency preparation
 *    keep working, and a pre-existing shared ref for the mission is removed the
 *    next time the mission publishes.
 *  - The cross-mission artifact registry is the sanctioned read path: it is
 *    mission-scoped, read-only (no store revision change), exposes commit, task,
 *    mission, acceptance state and review verdict, and refuses worker sessions.
 *  - The arena view exposes per-member presence, activity, current task, attempt
 *    age, next pending task and pending dependencies, plus the mission
 *    fingerprint and last witness class (docs/no-silent-state-spec.md §6).
 *
 * On the pre-fix head `8bb06a2` there is no `artifacts()` registry, no
 * `swarm_registry` tool and no per-mission artifact repository: refs are written
 * as `refs/swarm/<missionId>/...` in the shared source repo
 * (src/workspaces.ts), which is exactly the cross-tenant channel A2-04
 * confirmed (evidence_2f244c07; run_4294a7e1; A2v run_23261751).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { SwarmRuntime } from '../lib/runtime.js'
import { registerTools, SWARM_TOOLS, MANAGEMENT_TOOLS, hiddenToolsFor } from '../lib/tools.js'
import { TRACE_STEPS } from '../lib/trace.js'

const git = async (cwd, ...args) => {
  const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(result.exitCode, 0, result.output)
  return result.output.trim()
}
const gitFails = async (cwd, ...args) => {
  const result = await runProcess(['git', ...args], { cwd, timeoutMs: 30000, maxBytes: 10000 })
  return result.exitCode !== 0
}
async function gitFixture(t) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-arena-visibility-')))
  const source = path.join(temp, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await git(source, 'init', '-b', 'main')
  await writeFile(path.join(source, 'src', 'answer.txt'), 'base\n')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'initial')
  const workspaces = new Workspaces({ workspacesRoot: path.join(temp, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv })
  t.after(async () => { await workspaces.dispose(); await rm(temp, { recursive: true, force: true }) })
  return { temp, source, workspaces, artifactsOf: missionId => path.join(temp, 'worktrees', missionId, 'artifacts.git') }
}

test('R11-14: artifact and baseline refs live in the mission repository, never the shared source repo', async t => {
  const { source, workspaces, artifactsOf } = await gitFixture(t)
  const missionA = { id: 'mission-a', workspace: source }
  const baselineA = await workspaces.prepareBaseline(missionA)
  const memberA = { id: 'member-a', missionId: missionA.id, workspace: await workspaces.prepareWorkspace(missionA, 'member-a') }
  const taskA = { id: 'task-a', missionId: missionA.id, epoch: 1, title: 'A', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  await workspaces.prepareTask(memberA, taskA, [])
  await writeFile(path.join(memberA.workspace, 'src', 'a.txt'), 'a\n')
  const artifact = await workspaces.captureArtifact(memberA, taskA)

  const repoA = artifactsOf(missionA.id)
  assert.equal(await git(repoA, 'rev-parse', 'refs/artifacts/task-a/1'), artifact.commit, 'the artifact ref is published in the mission repository')
  assert.equal(await git(repoA, 'rev-parse', 'refs/baselines/baseline'), baselineA.snapshotCommit, 'the baseline ref is published in the mission repository')
  assert.deepEqual((await git(repoA, 'for-each-ref', '--format=%(refname)')).split('\n').sort(), ['refs/artifacts/task-a/1', 'refs/baselines/baseline'])
  assert.equal(await git(source, 'for-each-ref', '--format=%(refname)', 'refs/swarm/'), '', 'the shared cross-mission ref namespace stays empty')

  // A second mission on the same source repository cannot discover mission A's
  // artifact: the shared namespace is empty and its own repository has only its
  // baseline ref.
  const missionB = { id: 'mission-b', workspace: source }
  await workspaces.prepareBaseline(missionB)
  const memberB = { id: 'member-b', missionId: missionB.id, workspace: await workspaces.prepareWorkspace(missionB, 'member-b') }
  assert.equal(await git(memberB.workspace, 'for-each-ref', '--format=%(refname)', 'refs/swarm/'), '', 'no shared refs are visible from another mission worktree')
  assert.equal(await gitFails(memberB.workspace, 'rev-parse', '--verify', '--quiet', 'refs/artifacts/task-a/1'), true, 'mission A artifact ref is not in the shared repo')
  assert.deepEqual((await git(artifactsOf(missionB.id), 'for-each-ref', '--format=%(refname)')).split('\n'), ['refs/baselines/baseline'], 'mission B holds only its own baseline ref')

  // The review path still resolves the artifact from the source object store
  // (the member worktree keeps it reachable) without any shared ref.
  assert.deepEqual(await workspaces.verifyArtifact(memberA, taskA, artifact), [], 'review runs against the artifact with no shared ref')

  // A pre-existing shared ref for this mission is removed on the next publish,
  // so an upgraded host stops exposing the mission through the old channel.
  await git(source, 'update-ref', 'refs/swarm/mission-a/task-a/1', artifact.commit)
  assert.equal(await git(source, 'rev-parse', 'refs/swarm/mission-a/task-a/1'), artifact.commit)
  await workspaces.captureArtifact(memberA, taskA)
  assert.equal(await gitFails(source, 'rev-parse', '--verify', '--quiet', 'refs/swarm/mission-a/task-a/1'), true, 'the legacy shared ref is deleted')
  assert.equal(await git(repoA, 'rev-parse', 'refs/artifacts/task-a/1'), artifact.commit, 'the mission ref is unchanged')
})

/**
 * T1c2 durability repair. The T1cv probe disproved the earlier claim that a
 * push into an alternate-backed repository is durable: that repository owned 0
 * objects and could not resolve the artifact once the source pruned it. This
 * test pins the repaired contract: the per-mission repository is a
 * self-contained clone with its own objects and no alternate, so an artifact
 * stays readable after the member worktree is removed and the source runs
 * `gc --prune=now`.
 */
test('T1c2: the per-mission artifact repository is self-contained, so a source gc cannot orphan a recorded artifact', async t => {
  const { source, workspaces, artifactsOf } = await gitFixture(t)
  const mission = { id: 'mission-durable', workspace: source }
  await workspaces.prepareBaseline(mission)
  const member = { id: 'member-durable', missionId: mission.id, workspace: await workspaces.prepareWorkspace(mission, 'member-durable') }
  const task = { id: 'task-durable', missionId: mission.id, epoch: 1, title: 'Durable', kind: 'implementation', scope: ['src/'], checks: [], status: 'running' }
  await workspaces.prepareTask(member, task, [])
  await writeFile(path.join(member.workspace, 'src', 'durable.txt'), 'durable\n')
  const artifact = await workspaces.captureArtifact(member, task)
  const repo = artifactsOf(mission.id)

  // The mission repository owns its objects and borrows nothing.
  const counts = await git(repo, 'count-objects', '-v')
  const own = Number(/^count: (\d+)/m.exec(counts)?.[1] ?? 0) + Number(/^in-pack: (\d+)/m.exec(counts)?.[1] ?? 0)
  assert.ok(own > 0, `the mission repository owns objects: ${counts.split('\n').slice(0, 3).join('; ')}`)
  assert.equal(await lstat(path.join(repo, 'objects', 'info', 'alternates')).then(() => true, () => false), false, 'no alternate borrows the source object store')

  // Remove the member worktree and prune the source object store.
  const removed = await runProcess(['git', '-C', source, 'worktree', 'remove', '--force', member.workspace], { cwd: source, timeoutMs: 30000, maxBytes: 100000 })
  assert.equal(removed.exitCode, 0, removed.output)
  await git(source, 'worktree', 'prune')
  await git(source, 'gc', '--prune=now', '--quiet')
  assert.equal(await gitFails(source, 'cat-file', '-e', `${artifact.commit}^{commit}`), true, 'the source pruned the unreferenced artifact')

  // The mission repository still resolves the ref, the commit and the complete
  // tree, including blobs that are unchanged since the baseline.
  assert.equal(await git(repo, 'rev-parse', 'refs/artifacts/task-durable/1'), artifact.commit)
  assert.equal(await git(repo, 'cat-file', '-e', `${artifact.commit}^{commit}`), '')
  const tree = await git(repo, 'ls-tree', '-r', '--name-only', artifact.commit)
  assert.ok(tree.includes('src/durable.txt'), 'the changed blob is readable')
  assert.ok(tree.includes('src/answer.txt'), 'an unchanged base blob is readable without the source')
})

/** Fake adapter: deterministic artifacts, no auto-dispatch, no filesystem effects. */
class Workers {
  deliveries = []
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(_mission, memberId) { return `/isolated/${memberId}` }
  async start() {}
  async deliver(member, delivery) { this.deliveries.push({ memberId: member.id, delivery }) }
  async stop() {}
  isIdle() { return false }
  async captureArtifact() { return { commit: 'artifact-commit', baseCommit: 'base-commit', workspace: '/isolated', changedPaths: ['src/a.txt'] } }
  async verifyArtifact() { return [] }
  async prepareTask() {}
  async dispose() {}
}
async function runtimeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'swarm-arena-registry-'))
  const stateDirectory = path.join(root, 'state')
  const workspace = path.join(root, 'workspace')
  await mkdir(stateDirectory, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, 'marker.txt'), 'workspace marker\n')
  const workers = new Workers()
  const runtime = new SwarmRuntime({ statePath: path.join(stateDirectory, 'db.sqlite'), leaseMs: 60000, tickMs: 10, maxMessageChars: 16000, maxEvents: 500, maxTasksPerMember: 4 }, workers)
  t.after(async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }) })
  const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 8, maxExperiments: 1 }
  const owner = { sessionId: `owner-${randomUUID()}` }
  const mission = runtime.create(owner, { title: 'Arena visibility', objective: 'Exercise the registry and arena view', workspace, scope: ['src/'], acceptance: ['arena works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Arena work' })
  const alice = await runtime.addMember(owner, mission.id, { name: 'alice', role: 'implementation' })
  const bob = await runtime.addMember(owner, mission.id, { name: 'bob', role: 'reviewer' })
  const otherOwner = { sessionId: `owner-${randomUUID()}` }
  const other = runtime.create(otherOwner, { title: 'Other mission', objective: 'A different tenant', workspace, scope: ['src/'], acceptance: ['other works'], budget })
  const otherStream = runtime.workstream(otherOwner, other.id, { title: 'Other', objective: 'Other work' })
  const carol = await runtime.addMember(otherOwner, other.id, { name: 'carol', role: 'implementation' })
  return {
    runtime, workers, owner, mission, stream, alice, bob, otherOwner, other, otherStream, carol, budget,
    aliceActor: { sessionId: alice.sessionId }, bobActor: { sessionId: bob.sessionId }, carolActor: { sessionId: carol.sessionId },
  }
}
function definitions(runtime) {
  const registered = new Map()
  registerTools({ tools: { register: definition => registered.set(definition.name, definition) } }, runtime, { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 8, maxExperiments: 1 })
  return registered
}
const execution = sessionId => ({ signal: new AbortController().signal, agent: { id: sessionId } })

/** Submit one artifact-bearing task in a mission and return it. */
async function submitArtifact(f, actor, stream, title) {
  const source = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: stream.id, title, objective: 'Produce an artifact', kind: 'implementation',
    scope: ['src/'], acceptance: ['arena works'], checks: ['node --test'],
  })
  const claimed = await f.runtime.claim(actor, f.mission.id, source.id)
  await f.runtime.submit(actor, f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: `${title} candidate` })
  return source
}

test('the cross-mission artifact registry is the sanctioned read path: scoped, read-only and verdict-bearing', async t => {
  const f = await runtimeFixture(t)
  const source = await submitArtifact(f, f.aliceActor, f.stream, 'Implement the arena')
  // Deterministic independent review: proposed before submission, accepted after.
  const review = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Review the arena', objective: 'Independent review', kind: 'verification',
    reviewOf: source.id, assigneeId: f.bob.id, scope: ['src/'], acceptance: ['arena works'], checks: [],
  })
  const reviewClaim = await f.runtime.claim(f.bobActor, f.mission.id, review.id)
  // Independent verification requires the reviewer's own host-recorded run and
  // a published claim, exactly like a real review.
  const runId = await f.workers.callbacks.toolRun(f.bob.id, {
    tool: 'bash', arguments: { command: 'node --test' }, result: { exitCode: 0, output: 'ok' }, isError: false,
  })
  f.runtime.publish(f.bobActor, f.mission.id, {
    taskId: review.id, attemptId: reviewClaim.attempt.id, claim: 'The artifact passes its declared check',
    outcome: 'supported', toolRunIds: [runId],
  })
  await f.runtime.verify(f.bobActor, f.mission.id, { taskId: review.id, attemptId: reviewClaim.attempt.id, verdict: 'accept', reason: 'Independently checked the artifact' })
  assert.equal(f.runtime.store.get('tasks', source.id).status, 'accepted')

  // The other tenant has its own artifact.
  const otherSource = f.runtime.propose(f.otherOwner, f.other.id, {
    workstreamId: f.otherStream.id, title: 'Other artifact', objective: 'Other work', kind: 'implementation',
    scope: ['src/'], acceptance: ['other works'], checks: ['node --test'],
  })
  const otherClaim = await f.runtime.claim(f.carolActor, f.other.id, otherSource.id)
  await f.runtime.submit(f.carolActor, f.other.id, { taskId: otherSource.id, attemptId: otherClaim.attempt.id, output: 'other candidate' })

  const revision = f.runtime.store.revision()
  const registry = f.runtime.artifacts(f.owner)
  assert.deepEqual(registry.missions, [f.mission.id], 'only the caller-owned mission is listed')
  assert.equal(registry.total, 1)
  const row = registry.artifacts[0]
  assert.equal(row.missionId, f.mission.id)
  assert.equal(row.taskId, source.id)
  assert.equal(row.taskKind, 'implementation')
  assert.equal(row.taskStatus, 'accepted', 'acceptance state')
  assert.deepEqual(row.acceptance, ['arena works'])
  assert.deepEqual(row.missionAcceptance, ['arena works'], 'the mission acceptance state is exposed')
  assert.equal(row.artifact.commit, 'artifact-commit')
  assert.equal(row.artifact.baseCommit, 'base-commit')
  assert.deepEqual(row.artifact.changedPaths, ['src/a.txt'])
  assert.equal(row.review.taskId, review.id)
  assert.equal(row.review.status, 'accepted')
  assert.equal(row.review.verdict, 'verified', 'the independent review verdict')
  assert.equal(f.runtime.store.revision(), revision, 'reading the registry commits no state change')

  // Cross-tenant isolation: another owner's mission is invisible, and an explicit
  // filter cannot widen visibility.
  assert.throws(() => f.runtime.artifacts(f.owner, { missionId: f.other.id }), /Unknown mission or not visible/)
  const otherRegistry = f.runtime.artifacts(f.otherOwner)
  assert.deepEqual(otherRegistry.missions, [f.other.id])
  assert.ok(!otherRegistry.artifacts.some(item => item.missionId === f.mission.id), 'the other tenant sees only its own artifact')
  // Worker sessions cannot read the cross-mission registry at all.
  assert.throws(() => f.runtime.artifacts(f.aliceActor), /Only the primary user session/)
  assert.throws(() => f.runtime.artifacts(f.carolActor), /Only the primary user session/)
})

test('the arena view exposes presence, activity, current task, attempt age, pending dependencies, fingerprint and last witness', async t => {
  const f = await runtimeFixture(t)
  // A pending task assigned to alice whose dependency is not accepted: the arena
  // must show what she is waiting on even though she holds no attempt.
  const first = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'First', objective: 'Prerequisite', kind: 'research', scope: ['src/'], acceptance: ['arena works'],
  })
  const waiting = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Waiting', objective: 'Depends on first', kind: 'research',
    dependencies: [first.id], assigneeId: f.alice.id, scope: ['src/'], acceptance: ['arena works'],
  })
  let view = f.runtime.observe(f.owner, f.mission.id, { detail: 'full' })
  let row = view.arena.members.find(member => member.id === f.alice.id)
  assert.equal(row.status, 'idle')
  assert.equal(row.pendingTaskId, waiting.id, 'the next pending task is named')
  assert.deepEqual(row.pendingDependencies, [first.id], 'the unaccepted dependency is named')
  assert.equal(row.currentTaskId, undefined)
  assert.match(view.fingerprint, /^[a-f0-9]{32}$/, 'the owner sees the no-silent-state F(S), not the 64-hex ledger digest')
  assert.equal(view.fingerprint, f.runtime.fingerprint(f.mission.id), 'the exposed fingerprint is the runtime F(S) the witness record uses')

  // A live attempt shows the current task, its attempt id and an age.
  const running = f.runtime.propose(f.owner, f.mission.id, {
    workstreamId: f.stream.id, title: 'Running', objective: 'Give alice a live attempt', kind: 'research', scope: ['src/'], acceptance: ['arena works'],
  })
  const claimed = await f.runtime.claim(f.aliceActor, f.mission.id, running.id)
  f.runtime.escalate(f.aliceActor, f.mission.id, { body: 'Owner: the check command is ambiguous' })
  view = f.runtime.observe(f.owner, f.mission.id, { detail: 'full' })
  row = view.arena.members.find(member => member.id === f.alice.id)
  assert.equal(row.status, 'working')
  assert.equal(row.currentTaskId, running.id)
  assert.equal(row.attemptId, claimed.attempt.id)
  assert.ok(Number.isSafeInteger(row.attemptAgeMs) && row.attemptAgeMs >= 0, 'attempt age is exposed')
  assert.deepEqual(row.pendingDependencies, [], 'a running task has its dependencies accepted')
  assert.equal(view.lastWitness.class, 'escalation', 'the last witness class is exposed')
  assert.equal(view.lastWitness.dedupKey, view.noticeDedupKey, 'the witness carries the state fingerprint')
  assert.equal(typeof view.pendingDispatchable, 'number')
  assert.equal(view.escalations.length, 1)
  assert.equal(view.noticeLedger.find(entry => entry.class === 'escalation').escalation.taskId, running.id)
  // The compact owner view keeps the instruments small but still names the state.
  const compact = f.runtime.observe(f.owner, f.mission.id)
  assert.match(compact.fingerprint, /^[a-f0-9]{32}$/)
  assert.equal(compact.lastWitness.class, 'escalation')
  assert.equal(compact.noticeLedger, undefined)
  assert.equal(compact.arena, undefined)
})

test('swarm_registry joins the single registry as an owner-only read tool and a closed trace step', async t => {
  const f = await runtimeFixture(t)
  await submitArtifact(f, f.aliceActor, f.stream, 'Registry artifact')
  const tools = definitions(f.runtime)
  assert.deepEqual([...tools.keys()], [...SWARM_TOOLS], 'registration order is the cached schema prefix')
  for (const name of SWARM_TOOLS) assert(TRACE_STEPS.includes(name), `${name} must be a closed trace step`)
  assert(SWARM_TOOLS.includes('swarm_registry'))
  assert(MANAGEMENT_TOOLS.includes('swarm_registry'))
  assert(hiddenToolsFor('worker').includes('swarm_registry'), 'workers cannot see the cross-mission registry')
  assert(!hiddenToolsFor('owner').includes('swarm_registry'))
  const definition = tools.get('swarm_registry')
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(definition.parameters.required, [])
  assert.equal(definition.presentCall().kind, 'read', 'the registry is presented as a read')
  // The tool wrapper records its own trace span, so the assertion is that the
  // registry changes no mission state, not that the store revision is frozen.
  const before = JSON.stringify({
    mission: f.runtime.store.get('missions', f.mission.id),
    tasks: f.runtime.store.list('tasks', f.mission.id),
    members: f.runtime.store.list('members', f.mission.id),
    evidence: f.runtime.store.list('evidence', f.mission.id),
  })
  const called = await definition.execute({ missionId: f.mission.id }, execution(f.owner.sessionId))
  assert.equal(called.result.total, 1)
  assert.equal(called.result.artifacts[0].artifact.commit, 'artifact-commit')
  assert.equal(JSON.stringify({
    mission: f.runtime.store.get('missions', f.mission.id),
    tasks: f.runtime.store.list('tasks', f.mission.id),
    members: f.runtime.store.list('members', f.mission.id),
    evidence: f.runtime.store.list('evidence', f.mission.id),
  }), before, 'the tool path mutates no mission state')
  await assert.rejects(definition.execute({}, execution(f.alice.sessionId)), /Only the primary user session/)
})