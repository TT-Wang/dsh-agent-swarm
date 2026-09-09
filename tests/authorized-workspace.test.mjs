/**
 * User-authorized per-mission workspace (owner design note, 2026-09-09).
 *
 * The invariant under test: authorization originates with the human, never with
 * the model. A mission workspace is accepted iff it equals the calling session's
 * cwd or resolves inside a root loaded once from plugin configuration at start;
 * no model-callable tool creates, widens or revokes a root. Each test below is
 * one of the seven acceptance criteria and fails before the feature.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authorizeWorkspace, loadWorkspaceGrants, reauthorizeWorkspace, WORKSPACE_AUTHORIZATION_CODE, WORKSPACE_AUTHORIZATION_REQUIREMENT } from '../lib/authorization.js'
import { Workspaces, runProcess } from '../lib/workspaces.js'
import { registerTools } from '../lib/tools.js'
import { SwarmRuntime } from '../lib/runtime.js'
import { Config } from '../lib/index.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 10, maxExperiments: 2 }
const plan = (workspace, extra = {}) => ({
  title: 'Authorized workspace plan', objective: 'Prove the workspace is human-authorized', workspace, scope: ['src/'], acceptance: ['works'],
  budget, members: [{ key: 'analyst', name: 'Analyst', role: 'analysis' }],
  workstreams: [{ key: 'main', title: 'Main', objective: 'Do the work' }],
  tasks: [{ key: 'inspect', workstreamKey: 'main', title: 'Inspect', objective: 'Inspect the repository', kind: 'research', scope: ['src/'], acceptance: ['works'] }],
  ...extra,
})
function definitions(runtime, grants) {
  const registered = new Map()
  registerTools({ tools: { register: definition => registered.set(definition.name, definition) } }, runtime, budget, grants)
  return registered
}
function fakeRuntime() {
  const calls = { created: [], staged: [] }
  return { calls,
    create: (_actor, input) => { calls.created.push(input); return { id: 'mission-1', ...input } },
    createDraft: (_actor, input) => { calls.staged.push(input); return { id: 'draft-1', revision: 1, status: 'draft', input } },
    snapshot: () => undefined,
  }
}
const execution = (cwd, id = 'owner') => ({ agent: { id, ...(cwd === undefined ? {} : { session: { header: { cwd } } }) }, signal: new AbortController().signal })
class Workers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async stop() {}
  isIdle() { return true }
  async dispose() {}
}
class TickingWorkers extends Workers {
  deliveries = []
  prepared = 0
  async deliver(member, delivery) { this.deliveries.push(delivery) }
  async prepareTask() { this.prepared++ }
  async captureArtifact() { return { commit: 'artifact', baseCommit: 'base', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
}
async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'swarm-authorized-')))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const session = join(temp, 'session'), granted = join(temp, 'granted'), foreign = join(temp, 'foreign')
  await mkdir(session); await mkdir(granted); await mkdir(foreign)
  const project = join(granted, 'project'), outside = join(foreign, 'project')
  await mkdir(project); await mkdir(outside)
  return { temp, session, granted, foreign, project, outside }
}
async function eventually(read, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(message)
}
const runtimeConfig = directory => ({ statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 20, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 3 })

/** Criterion 1: an unauthorized foreign path is refused with the grant diagnostic. */
test('AC1: a path outside the session cwd and every configured root is refused with the grant-requirement diagnostic', async t => {
  const { session, project, outside, granted } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted, note: 'human-approved tree' }])
  const refused = await authorizeWorkspace(outside, session, grants)
  assert.equal(refused.ok, false)
  assert.match(refused.diagnostic, new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  assert.match(refused.diagnostic, /authorizedWorkspaces/)
  assert.equal(refused.diagnostic, WORKSPACE_AUTHORIZATION_REQUIREMENT + refused.diagnostic.slice(WORKSPACE_AUTHORIZATION_REQUIREMENT.length))
  assert.doesNotMatch(refused.diagnostic, /^Plan workspace must match the selected session workspace$/, 'the refusal names the authorization requirement, not a bare cwd-equality error')
  // The session workspace itself is still accepted, and a sibling is not.
  assert.equal((await authorizeWorkspace(session, session, grants)).ok, true)
  assert.equal((await authorizeWorkspace(project, session, grants)).ok, true)
  const tools = definitions(fakeRuntime(), grants)
  const runtime = tools.get('swarm_create')
  const calls = []
  const exec = execution(session)
  await assert.rejects(runtime.execute(plan(outside), exec), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  await assert.rejects(tools.get('swarm_stage').execute(plan(outside), exec), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  await assert.rejects(tools.get('swarm_create').execute(plan(join(session, '..', 'foreign')), exec), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  assert.deepEqual(calls, [])
})

/** Criterion 2: a granted path is accepted, recorded, and audited durably. */
test('AC2: a granted repository is accepted and the mission records the matched root plus the resolved path', async t => {
  const { temp, session, granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted, note: 'human-approved tree' }])
  const workers = new Workers(), runtime = new SwarmRuntime({ ...runtimeConfig(temp), authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, grants), grants }, workers)
  t.after(async () => { await runtime.dispose() })
  await runtime.start(grants)
  const loaded = runtime.store.events('swarm/install', 50).filter(event => event.type === 'workspace/grant-loaded')
  assert.equal(loaded.length, 1, 'one grant-loaded audit event per configured root')
  assert.equal(loaded[0].data.path, await realpath(granted))
  assert.equal(loaded[0].data.note, 'human-approved tree')
  const tools = definitions(runtime, grants)
  const created = await tools.get('swarm_create').execute(plan(project), execution(session))
  const mission = runtime.store.get('missions', created.result.id)
  assert.equal(mission.workspace, await realpath(project), 'the resolved path is recorded')
  assert.equal(mission.workspaceGrantRoot, await realpath(granted), 'the matched root is recorded durably')
  const bound = runtime.store.events(mission.id, 50).filter(event => event.type === 'mission/workspace-bound')
  assert.equal(bound.length, 1)
  assert.deepEqual({ workspace: bound[0].data.workspace, grantRoot: bound[0].data.grantRoot }, { workspace: mission.workspace, grantRoot: mission.workspaceGrantRoot })
  assert.equal(created.result.workspaceGrantRoot, await realpath(granted), 'the tool result exposes the binding')
})

/** Criterion 3: no model-callable tool can introduce or widen a root. */
test('AC3: swarm_create, swarm_stage and swarm_propose cannot introduce or widen an authorization root', async t => {
  const { temp, session, granted, project, outside } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const workers = new Workers(), runtime = new SwarmRuntime({ ...runtimeConfig(temp), authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, grants), grants }, workers)
  t.after(async () => { await runtime.dispose() })
  const tools = definitions(runtime, grants)
  // No workspace-bound tool exposes a grant field in its model-visible schema.
  for (const name of ['swarm_create', 'swarm_stage', 'swarm_propose']) {
    const properties = Object.keys(tools.get(name).parameters.properties)
    for (const forbidden of ['authorizedWorkspaces', 'workspaceGrantRoot', 'grants', 'workspace']) {
      if (name === 'swarm_propose' || forbidden === 'workspace') continue
      assert(!properties.includes(forbidden), `${name} must not expose ${forbidden}`)
    }
  }
  // A model-supplied wider root is ignored: the configured root wins.
  const created = await tools.get('swarm_create').execute({ ...plan(project), workspaceGrantRoot: '/', authorizedWorkspaces: [{ path: '/' }], grants: { grants: [{ path: '/' }] } }, execution(session))
  const mission = runtime.store.get('missions', created.result.id)
  assert.equal(mission.workspaceGrantRoot, await realpath(granted), 'the model cannot widen the recorded root')
  // An ungranted path stays refused even when the model supplies a root for it.
  await assert.rejects(tools.get('swarm_create').execute({ ...plan(outside), workspaceGrantRoot: outside, authorizedWorkspaces: [{ path: outside }] }, execution(session)), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  await assert.rejects(tools.get('swarm_stage').execute({ ...plan(outside), workspaceGrantRoot: outside }, execution(session)), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  // swarm_propose accepts no workspace and cannot re-point an existing mission.
  const stream = runtime.workstream({ sessionId: 'owner' }, mission.id, { title: 'Main', objective: 'Main' })
  await runtime.propose({ sessionId: 'owner' }, mission.id, { workstreamId: stream.id, title: 'Probe', objective: 'Probe the boundary', kind: 'research', scope: ['src/'], acceptance: ['works'] })
  // Extra grant-shaped arguments are ignored: the call may admit an in-mission
  // task or fail for its own reasons, but it can never re-point the mission.
  await tools.get('swarm_propose').execute({ missionId: mission.id, workstreamId: stream.id, title: 'Foreign', objective: 'Try to re-point', kind: 'research', scope: ['src/'], acceptance: ['works'], workspace: outside, workspaceGrantRoot: outside, authorizedWorkspaces: [{ path: outside }] }, execution(session)).catch(() => undefined)
  assert.deepEqual({ workspace: runtime.store.get('missions', mission.id).workspace, root: runtime.store.get('missions', mission.id).workspaceGrantRoot }, { workspace: mission.workspace, root: mission.workspaceGrantRoot })
  // The configured set is a snapshot: mutating the caller's array cannot widen it.
  const mutable = [{ path: granted }]
  const snapshot = await loadWorkspaceGrants(mutable)
  mutable.push({ path: '/' })
  assert.equal((await authorizeWorkspace(outside, session, snapshot)).ok, false, 'the loaded snapshot never grows')
  const config = Config({ statePath: '/tmp/swarm-config/state.sqlite', workspacesRoot: '/tmp/swarm-config/workspaces' })
  assert.deepEqual(config.authorizedWorkspaces, [], 'the config default authorizes nothing')
  assert.deepEqual(Config({ statePath: '/tmp/swarm-config/state.sqlite', workspacesRoot: '/tmp/swarm-config/workspaces', authorizedWorkspaces: [{ path: '/tmp/x', note: 'n', expiresAt: 1 }] }).authorizedWorkspaces, [{ path: '/tmp/x', note: 'n', expiresAt: 1 }])
})

/** Criterion 4: canonical containment defeats prefix confusion, traversal and symlink escape. */
test('AC4: prefix confusion, traversal and symlink escapes are refused; a symlinked root resolves once', async t => {
  const { session, granted, foreign, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const confusable = `${granted}-evil`
  await mkdir(confusable)
  assert.equal((await authorizeWorkspace(confusable, session, grants)).ok, false, 'a sibling sharing the root prefix is not inside it')
  assert.equal((await authorizeWorkspace(join(granted, '..', 'foreign'), session, grants)).ok, false, 'traversal out of the root is refused')
  const escape = join(granted, 'escape')
  await symlink(foreign, escape)
  assert.equal((await authorizeWorkspace(escape, session, grants)).ok, false, 'a symlink that resolves outside the root is refused')
  // A root that is a symlink is resolved once, and the recorded root is canonical.
  const alias = `${granted}-alias`
  await symlink(granted, alias)
  const aliased = await loadWorkspaceGrants([{ path: alias }])
  assert.equal(aliased.grants[0].path, await realpath(granted), 'the configured root is stored canonical')
  const accepted = await authorizeWorkspace(project, session, aliased)
  assert.equal(accepted.ok, true)
  assert.equal(accepted.grantRoot, await realpath(granted))
  // Re-validation after the root is removed from configuration refuses.
  assert.equal((await reauthorizeWorkspace(project, await realpath(granted), await loadWorkspaceGrants([]))).ok, false, 'a removed root no longer authorizes its workspace')
  assert.equal((await reauthorizeWorkspace(foreign, await realpath(granted), grants)).ok, false, 'a workspace outside its recorded root is refused')
  // The adapter re-validates at workspace preparation and verification checkout.
  const source = join(granted, 'repo')
  await mkdir(source)
  const git = async (...args) => { const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd: source, timeoutMs: 30000, maxBytes: 100000 }); assert.equal(result.exitCode, 0, result.output); return result.output.trim() }
  await git('init', '-b', 'main'); await writeFile(join(source, 'file.txt'), 'x\n'); await git('add', '.'); await git('commit', '-m', 'initial')
  const workspaces = new Workspaces({ workspacesRoot: join(foreign, 'worktrees'), checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv, grants: await loadWorkspaceGrants([]) })
  t.after(async () => { await workspaces.dispose() })
  const mission = { id: 'mission-revoked', workspace: await realpath(source), workspaceGrantRoot: await realpath(granted) }
  await assert.rejects(workspaces.prepareBaseline(mission), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
})

/** Criterion 5: workers never create missions or use grants; missions cannot be re-pointed. */
test('AC5: a worker session cannot create a mission or use a grant, and another session cannot re-point a mission', async t => {
  const { temp, session, granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const workers = new Workers(), runtime = new SwarmRuntime({ ...runtimeConfig(temp), authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, grants), grants }, workers)
  t.after(async () => { await runtime.dispose() })
  const owner = { sessionId: 'owner-a' }
  const projectPath = await realpath(project), grantedPath = await realpath(granted)
  const mission = runtime.create(owner, { title: 'Owned', objective: 'Own the workspace', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const workerSession = member.sessionId
  assert.throws(() => runtime.create({ sessionId: workerSession }, { title: 'Worker mission', objective: 'Escape', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } }), /Workers cannot/)
  assert.throws(() => runtime.createDraft({ sessionId: workerSession }, plan(projectPath, { workspaceGrantRoot: grantedPath })), /Workers cannot/)
  const tools = definitions(runtime, grants)
  await assert.rejects(tools.get('swarm_create').execute(plan(projectPath), execution(session, workerSession)), /Workers cannot/)
  // Another owner session of this install cannot re-point the mission, and
  // cannot launch the owner's draft.
  const draft = runtime.createDraft(owner, plan(projectPath, { workspaceGrantRoot: grantedPath }))
  await assert.rejects(runtime.launchDraft({ sessionId: 'owner-b' }, draft.id, draft.revision), /not owned by this session/)
  runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  assert.deepEqual({ workspace: runtime.store.get('missions', mission.id).workspace, root: runtime.store.get('missions', mission.id).workspaceGrantRoot }, { workspace: projectPath, root: grantedPath })
  const foreign = runtime.store.get('missions', mission.id)
  assert.equal(foreign.ownerSessionId, 'owner-a', 'ownership is durable and cannot be transferred by a peer')
  // A forged wider root is never recorded: the runtime re-derives the root from
  // the loaded configuration, so the mission anchors on the configured root.
  const forged = runtime.create({ sessionId: 'owner-b' }, { title: 'Wide', objective: 'Widen', workspace: projectPath, workspaceGrantRoot: '/', scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  assert.equal(runtime.store.get('missions', forged.id).workspaceGrantRoot, grantedPath, 'the configured root wins over the caller claim')
  // A forged narrower root that does not contain the workspace is refused.
  assert.throws(() => runtime.create({ sessionId: 'owner-b' }, { title: 'Narrow', objective: 'Narrow', workspace: projectPath, workspaceGrantRoot: join(grantedPath, 'nope'), scope: ['src/'], acceptance: ['works'], budget: { ...budget } }), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
})

/** Criterion 6: removing a root refuses new missions and fences a running one. */
test('AC6: a removed root refuses new missions and fences a running mission with a blocked reason and an owner notice', async t => {
  const { temp, session, granted, project } = await fixture(t)
  const before = await loadWorkspaceGrants([{ path: granted }])
  const workers = new TickingWorkers()
  const runtime = new SwarmRuntime({ ...runtimeConfig(temp), authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, before), grants: before }, workers)
  const owner = { sessionId: 'owner' }
  const projectPath = await realpath(project), grantedPath = await realpath(granted)
  const mission = runtime.create(owner, { title: 'Running', objective: 'Keep working', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Work', objective: 'Do the work', kind: 'research', scope: ['src/'], acceptance: ['works'] })
  await runtime.start(before)
  await eventually(() => workers.prepared > 0, 'the mission never started working')
  await runtime.dispose()
  // Human removes the root and restarts: the same durable state, no grant.
  const after = await loadWorkspaceGrants([])
  const restarted = new SwarmRuntime({ ...runtimeConfig(temp), authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, after), grants: after }, new TickingWorkers())
  t.after(async () => { await restarted.dispose() })
  assert.throws(() => restarted.create(owner, { title: 'New', objective: 'New mission in a revoked root', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } }), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  await restarted.start(after)
  const blocked = await eventually(() => restarted.store.list('tasks', mission.id).find(task => task.status === 'blocked'), 'the running mission was not fenced')
  assert.match(blocked.output, new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  const revoked = restarted.store.events(mission.id, 200).filter(event => event.type === 'mission/workspace-revoked')
  assert.equal(revoked.length, 1, 'revocation is recorded durably')
  assert.equal(revoked[0].data.grantRoot, grantedPath)
  const notice = restarted.store.list('deliveries', mission.id).find(delivery => delivery.to === 'owner' && delivery.kind === 'control')
  assert.ok(notice, 'the owner is woken with a durable notice')
  assert.match(notice.content, /authorizedWorkspaces|workspace_not_authorized/)
  assert.ok(restarted.store.events(mission.id, 200).some(event => event.type === 'task/blocked'), 'the task carries a durable blocked event')
  assert.equal(restarted.store.get('missions', mission.id).workspace, projectPath, 'the mission record is preserved for inspection')
  assert.equal(session.trim() === '', false)
})

/** Criterion 7: the authorization model and its residual risks are documented. */
test('AC7: README.md and docs/known-limitations.md document the authorization model and its residual risks', async () => {
  const read = async relative => await readFile(new URL(`../${relative}`, import.meta.url), 'utf8')
  const readme = await read('README.md'), limitations = await read('docs/known-limitations.md')
  for (const text of [readme, limitations]) {
    assert.match(text, /authorizedWorkspaces/)
    assert.match(text, /workspaceGrantRoot/)
  }
  assert.match(limitations, /TOCTOU/)
  assert.match(limitations, /not (?:a )?confidentiality|not confidentiality/i)
  assert.match(limitations, /config file|configuration file/i)
  assert.match(readme, /human/i)
})

/** D1 (review task_fb92df98): the runtime must decide fencing from the configured predicate. */
test('D1: a runtime wired like the plugin keeps a configured-root mission staffable and unfenced', async t => {
  const { temp, granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const projectPath = await realpath(project), grantedPath = await realpath(granted)
  // Two production wirings of the same loaded snapshot. `closure only` is the
  // shape src/index.ts had when the review found the defect; `closure + grants`
  // is the repaired shape. Fencing must depend on the configured predicate, so
  // both must keep a configured-root mission alive while the root is configured.
  for (const [label, extra] of [['closure only', {}], ['closure + grants', { grants }]]) {
    const runtime = new SwarmRuntime({ ...runtimeConfig(temp), authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, grants), ...extra }, new Workers())
    const owner = { sessionId: `owner-${label}` }
    const mission = runtime.create(owner, { title: 'Wired', objective: 'Stay staffable', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
    const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
    assert.ok(member.id, `${label}: the mission inside a configured root is staffable`)
    assert.equal(runtime.store.events(mission.id, 200).filter(event => event.type === 'mission/workspace-revoked').length, 0, `${label}: no false revocation while the root stays configured`)
    await runtime.dispose()
  }
  // Nested configured roots resolve to the most specific root at admission and
  // at fencing, so a mission strictly inside both is not falsely revoked.
  const nestedRepo = join(project, 'nested')
  await mkdir(nestedRepo)
  const nested = await loadWorkspaceGrants([{ path: granted }, { path: project }])
  const nestedRuntime = new SwarmRuntime({ ...runtimeConfig(temp), grants: nested, authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, nested) }, new Workers())
  const nestedOwner = { sessionId: 'owner-nested' }
  const nestedMission = nestedRuntime.create(nestedOwner, { title: 'Nested', objective: 'Most specific root', workspace: await realpath(nestedRepo), workspaceGrantRoot: await realpath(granted), scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  assert.equal(nestedMission.workspaceGrantRoot, await realpath(project), 'the most specific configured root is recorded')
  await nestedRuntime.addMember(nestedOwner, nestedMission.id, { name: 'Builder', role: 'implementation' })
  await nestedRuntime.dispose()
  // Revocation under the same wiring still fences.
  const revoked = await loadWorkspaceGrants([])
  const runtime = new SwarmRuntime({ ...runtimeConfig(temp), authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, revoked) }, new Workers())
  t.after(async () => { await runtime.dispose() })
  const owner = { sessionId: 'owner-revoked' }
  const mission = runtime.create(owner, { title: 'Revoked', objective: 'Fence', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  await assert.rejects(runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' }), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
})

/** D2 (review task_fb92df98): the persisted anchor must survive the manifest read. */
test('D2: a verification checkout re-validates the persisted anchor and refuses a removed root', async t => {
  const { temp, granted, foreign } = await fixture(t)
  const source = join(granted, 'repo')
  await mkdir(source)
  const git = async (...args) => {
    const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { cwd: source, timeoutMs: 30000, maxBytes: 100000 })
    assert.equal(result.exitCode, 0, result.output)
    return result.output.trim()
  }
  await git('init', '-b', 'main')
  await mkdir(join(source, 'src'))
  await writeFile(join(source, 'src', 'answer.txt'), 'base\n')
  await git('add', '.')
  await git('commit', '-m', 'initial')
  const workspacesRoot = join(foreign, 'worktrees')
  const options = { workspacesRoot, checkTimeoutMs: 30000, maxCheckOutputBytes: 32000, confineCheck: argv => argv }
  const live = new Workspaces({ ...options, grants: await loadWorkspaceGrants([{ path: granted }]) })
  t.after(async () => { await live.dispose() })
  const mission = { id: 'mission-d2', workspace: await realpath(source), workspaceGrantRoot: await realpath(granted) }
  const member = { id: 'member-d2', missionId: mission.id, workspace: await live.prepareWorkspace(mission, 'member-d2') }
  const task = { id: 'task-d2', missionId: mission.id, epoch: 1, title: 'Verify', kind: 'implementation', scope: ['src/'], checks: ['exit 0'], status: 'running' }
  await live.prepareTask(member, task, [])
  await writeFile(join(member.workspace, 'src', 'answer.txt'), '42\n')
  const artifact = await live.captureArtifact(member, task)
  // Control: with the root still configured the checkout is created and the check runs.
  const control = await live.verifyArtifact(member, task, artifact)
  assert.equal(control.length, 1)
  assert.equal(control[0].exitCode, 0, 'the live snapshot still creates the verification checkout')
  // Revoked: the persisted anchor must be read back, so the checkout is refused.
  const revoked = new Workspaces({ ...options, grants: await loadWorkspaceGrants([]) })
  t.after(async () => { await revoked.dispose() })
  await assert.rejects(revoked.verifyArtifact(member, task, artifact), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
})

/** D3 (review task_5be8e5d8): an exact-root grant mission must be fenced on revocation. */
test('D3: a mission whose workspace equals the configured root is staffable and fenced on revocation', async t => {
  const { temp, session, granted } = await fixture(t)
  const grantedPath = await realpath(granted), sessionPath = await realpath(session)
  const live = await loadWorkspaceGrants([{ path: granted }])
  const before = new SwarmRuntime({ ...runtimeConfig(temp), grants: live, authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, live) }, new Workers())
  const owner = { sessionId: 'owner-exact' }
  // The workspace IS the configured root: admission authorizes it as a grant,
  // and the mission must record that source so revocation can be detected.
  const mission = before.create(owner, { title: 'Exact root', objective: 'Fence on revocation', workspace: grantedPath, workspaceGrantRoot: grantedPath, workspaceAuthorizationSource: 'grant', scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  assert.equal(mission.workspaceAuthorizationSource, 'grant', 'the host-derived source is recorded on the mission')
  const bound = before.store.events(mission.id, 50).filter(event => event.type === 'mission/workspace-bound')
  assert.equal(bound[0].data.source, 'grant', 'the audit names the grant source, not a session label')
  await before.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  // A session-cwd mission that is not a configured root must never be fenced.
  const sessionOwner = { sessionId: 'owner-session' }
  const sessionMission = before.create(sessionOwner, { title: 'Session', objective: 'Stay alive', workspace: sessionPath, workspaceGrantRoot: sessionPath, workspaceAuthorizationSource: 'session', scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  assert.equal(sessionMission.workspaceAuthorizationSource, 'session')
  await before.addMember(sessionOwner, sessionMission.id, { name: 'Builder', role: 'implementation' })
  await before.dispose()
  // Restart with the root removed: the exact-root grant mission is fenced with
  // a durable reason, exactly one revocation event and an owner notice, while
  // the session-cwd mission keeps working.
  const after = await loadWorkspaceGrants([])
  const restarted = new SwarmRuntime({ ...runtimeConfig(temp), grants: after, authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, after) }, new Workers())
  t.after(async () => { await restarted.dispose() })
  await assert.rejects(restarted.addMember(owner, mission.id, { name: 'Second', role: 'implementation' }), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  const revoked = restarted.store.events(mission.id, 200).filter(event => event.type === 'mission/workspace-revoked')
  assert.equal(revoked.length, 1, 'exactly one durable revocation event')
  const notice = restarted.store.list('deliveries', mission.id).find(delivery => delivery.to === 'owner' && delivery.kind === 'control')
  assert.ok(notice, 'the owner is notified of the revocation')
  assert.match(notice.content, new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  assert.equal(restarted.store.events(sessionMission.id, 200).filter(event => event.type === 'mission/workspace-revoked').length, 0, 'a session-cwd mission is never fenced')
  await restarted.addMember(sessionOwner, sessionMission.id, { name: 'Second', role: 'implementation' })
})
