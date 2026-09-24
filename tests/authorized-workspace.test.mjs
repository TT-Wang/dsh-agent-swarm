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
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { authorizeWorkspace, loadWorkspaceGrants, reauthorizeWorkspace, WorkspaceRevokedError, WORKSPACE_AUTHORIZATION_CODE, WORKSPACE_AUTHORIZATION_REQUIREMENT } from '../lib/authorization.js'
import { runProcess } from '../lib/workspaces.js'
import { registerTools } from '../lib/tools.js'
import { Config } from '../lib/index.js'
import { subprocessSeam } from './subprocess-seam.mjs'
import { FakeClock, FakeWorkers, SwarmRuntime, WorkspaceWorkers, budget as sharedBudget, eventually, makeRepo, makeRuntime, makeWorkspaces, makeRuntimeStub } from './faults/harness.mjs'
import { tempDirectory } from './temp-root.mjs'

const budget = { ...sharedBudget, maxTokens: 100000, maxSteps: 100, maxTasks: 10, maxExperiments: 2 }
const plan = (workspace, extra = {}) => ({
  title: 'Authorized workspace plan', objective: 'Prove the workspace is human-authorized', workspace, scope: ['src/'], acceptance: ['works'],
  budget, members: [{ key: 'analyst', name: 'Analyst', role: 'analysis' }],
  workstreams: [{ key: 'main', title: 'Main', objective: 'Do the work' }],
  tasks: [{ key: 'inspect', workstreamKey: 'main', title: 'Inspect', objective: 'Inspect the repository', kind: 'research', scope: ['src/'], acceptance: ['works'] }],
  ...extra,
})
/** swarm_create takes the mission fields only; members, workstreams and tasks are not its parameters. */
const missionFields = workspace => { const { members: _m, workstreams: _w, tasks: _t, ...fields } = plan(workspace); return fields }
function definitions(runtime, grants) {
  const registered = new Map()
  registerTools({ tools: { register: definition => registered.set(definition.name, definition) } }, runtime, budget, grants)
  return registered
}
function fakeRuntime() {
  const calls = { created: [], staged: [] }
  return makeRuntimeStub({ calls,
    create: (_actor, input) => { calls.created.push(input); return { id: 'mission-1', ...input } },
    createDraft: (_actor, input) => { calls.staged.push(input); return { id: 'draft-1', revision: 1, status: 'draft', input } },
    snapshot: () => undefined,
  })
}
const execution = (cwd, id = 'owner') => ({ agent: { id, ...(cwd === undefined ? {} : { session: { header: { cwd } } }) }, signal: new AbortController().signal })
const workspaceWorkers = (autoIdle = true) => new FakeWorkers({ autoIdle, artifact: { commit: 'artifact', baseCommit: 'base', workspace: '/isolated', changedPaths: [] }, checks: [],
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) } })
/** Busy members: the dispatcher leaves the work to an explicit claim, so one path is exercised alone. */
const claimingWorkers = () => workspaceWorkers(false)
async function fixture(t) {
  // fixture gap: a temp tree that exists before the runtime, whose grants name paths inside it.
  const temp = await realpath(await tempDirectory('swarm-authorized-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const session = join(temp, 'session'), granted = join(temp, 'granted'), foreign = join(temp, 'foreign')
  await mkdir(session); await mkdir(granted); await mkdir(foreign)
  const project = join(granted, 'project'), outside = join(foreign, 'project')
  await mkdir(project); await mkdir(outside)
  return { temp, session, granted, foreign, project, outside }
}
const runtimeConfig = { tickMs: 20, maxMessageChars: 10000, maxEvents: 500, checkTimeoutMs: undefined }
/** A runtime wired as src/index.ts wires the plugin: the loaded snapshot is the one representation it reads. */
const wired = grants => ({ ...runtimeConfig, grants })
const revokedEvents = (runtime, missionId) => runtime.store.events(missionId, 500).filter(event => event.type === 'mission/workspace-revoked')
const workspaceNotices = (runtime, missionId) => runtime.store.list('deliveries', missionId).filter(delivery => delivery.to === 'owner' && /\[workspace_terminal\]/.test(delivery.content))
/** The typed revocation every path throws: the error the runtime fences on, never a bare preparation failure. */
const revokedError = error => error.code === 'workspace_revoked' && error.name === 'WorkspaceRevokedError' && new RegExp(WORKSPACE_AUTHORIZATION_CODE).test(error.message)
/** A granted mission with an author, a reviewer and one stream. */
async function grantedMission(runtime, project, granted, ownerId) {
  const owner = { sessionId: ownerId }
  const mission = runtime.create(owner, { title: 'Granted work', objective: 'Work inside a human-authorized root', workspace: await realpath(project), workspaceGrantRoot: await realpath(granted), workspaceAuthorizationSource: 'grant', scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const author = await runtime.addMember(owner, mission.id, { name: 'Author', role: 'implementation' })
  const reviewer = await runtime.addMember(owner, mission.id, { name: 'Reviewer', role: 'verification' })
  const propose = (extra = {}) => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Work', objective: 'Do the work', kind: 'research', scope: ['src/'], acceptance: ['works'], ...extra })
  return { owner, mission, author, reviewer, propose, actor: member => ({ sessionId: member.sessionId }) }
}

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
  await assert.rejects(runtime.execute(missionFields(outside), exec), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  await assert.rejects(tools.get('swarm_stage').execute(plan(outside), exec), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  await assert.rejects(tools.get('swarm_create').execute(missionFields(join(session, '..', 'foreign')), exec), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  assert.deepEqual(calls, [])
})

/** Criterion 2: a granted path is accepted, recorded, and audited durably. */
test('AC2: a granted repository is accepted and the mission records the matched root plus the resolved path', async t => {
  const { session, granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted, note: 'human-approved tree' }])
  const { runtime } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(grants) })
  await runtime.start(grants)
  const loaded = runtime.store.events('swarm/install', 50).filter(event => event.type === 'workspace/grant-loaded')
  assert.equal(loaded.length, 1, 'one grant-loaded audit event per configured root')
  assert.equal(loaded[0].data.path, await realpath(granted))
  assert.equal(loaded[0].data.note, 'human-approved tree')
  const tools = definitions(runtime, grants)
  const created = await tools.get('swarm_create').execute(missionFields(project), execution(session))
  const recorded = runtime.store.get('missions', created.result.id)
  assert.equal(recorded.workspace, await realpath(project), 'the resolved path is recorded')
  assert.equal(recorded.workspaceGrantRoot, await realpath(granted), 'the matched root is recorded durably')
  const bound = runtime.store.events(recorded.id, 50).filter(event => event.type === 'mission/workspace-bound')
  assert.equal(bound.length, 1)
  assert.deepEqual({ workspace: bound[0].data.workspace, grantRoot: bound[0].data.grantRoot }, { workspace: recorded.workspace, grantRoot: recorded.workspaceGrantRoot })
  assert.equal(created.result.workspaceGrantRoot, await realpath(granted), 'the tool result exposes the binding')
})

/** Criterion 3: no model-callable tool can introduce or widen a root. */
test('AC3: swarm_create, swarm_stage and swarm_propose cannot introduce or widen an authorization root', async t => {
  const { session, granted, project, outside } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const { runtime } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(grants) })
  const tools = definitions(runtime, grants)
  // No workspace-bound tool exposes a grant field in its model-visible schema.
  for (const name of ['swarm_create', 'swarm_stage', 'swarm_propose']) {
    const properties = Object.keys(tools.get(name).parameters.properties)
    for (const forbidden of ['authorizedWorkspaces', 'workspaceGrantRoot', 'grants', 'workspace']) {
      if (name === 'swarm_propose' || forbidden === 'workspace') continue
      assert(!properties.includes(forbidden), `${name} must not expose ${forbidden}`)
    }
  }
  // A model-supplied root is not a parameter: the schema check refuses it by
  // name before the workspace is bound, and nothing is created.
  await assert.rejects(tools.get('swarm_create').execute({ ...missionFields(project), workspaceGrantRoot: '/', authorizedWorkspaces: [{ path: '/' }], grants: { grants: [{ path: '/' }] } }, execution(session)),
    /\[tool_arguments_invalid\] swarm_create was called with arguments its parameters schema refuses: "workspaceGrantRoot", "authorizedWorkspaces", "grants" are not parameters/)
  assert.deepEqual(runtime.store.list('missions'), [])
  // Without them the configured root wins.
  const created = await tools.get('swarm_create').execute(missionFields(project), execution(session))
  const recorded = runtime.store.get('missions', created.result.id)
  assert.equal(recorded.workspaceGrantRoot, await realpath(granted), 'the model cannot widen the recorded root')
  // An ungranted path stays refused, and a root supplied for it never reaches the binding.
  await assert.rejects(tools.get('swarm_create').execute(missionFields(outside), execution(session)), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  await assert.rejects(tools.get('swarm_create').execute({ ...missionFields(outside), workspaceGrantRoot: outside, authorizedWorkspaces: [{ path: outside }] }, execution(session)), /\[tool_arguments_invalid\]/)
  await assert.rejects(tools.get('swarm_stage').execute(plan(outside), execution(session)), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  await assert.rejects(tools.get('swarm_stage').execute({ ...plan(outside), workspaceGrantRoot: outside }, execution(session)), /\[tool_arguments_invalid\]/)
  // swarm_propose accepts no workspace and cannot re-point an existing mission.
  const stream = runtime.workstream({ sessionId: 'owner' }, recorded.id, { title: 'Main', objective: 'Main' })
  await runtime.propose({ sessionId: 'owner' }, recorded.id, { outputs: [], workstreamId: stream.id, title: 'Probe', objective: 'Probe the boundary', kind: 'research', scope: ['src/'], acceptance: ['works'] })
  // Extra grant-shaped arguments are ignored: the call may admit an in-mission
  // task or fail for its own reasons, but it can never re-point the mission.
  await tools.get('swarm_propose').execute({ missionId: recorded.id, workstreamId: stream.id, title: 'Foreign', objective: 'Try to re-point', kind: 'research', scope: ['src/'], acceptance: ['works'], outputs: [], workspace: outside, workspaceGrantRoot: outside, authorizedWorkspaces: [{ path: outside }] }, execution(session)).catch(() => undefined)
  assert.deepEqual({ workspace: runtime.store.get('missions', recorded.id).workspace, root: runtime.store.get('missions', recorded.id).workspaceGrantRoot }, { workspace: recorded.workspace, root: recorded.workspaceGrantRoot })
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
  assert.equal((await reauthorizeWorkspace({ workspace: project, workspaceGrantRoot: await realpath(granted) }, await loadWorkspaceGrants([]))).ok, false, 'a removed root no longer authorizes its workspace')
  assert.equal((await reauthorizeWorkspace({ workspace: foreign, workspaceGrantRoot: await realpath(granted) }, grants)).ok, false, 'a workspace outside its recorded root is refused')
  // The adapter re-validates at baseline preparation, the entry every worker start reaches, with the same typed error.
  const source = join(granted, 'repo')
  await mkdir(source)
  const git = async (...args) => { const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { subprocess: subprocessSeam, cwd: source, timeoutMs: 30000, maxBytes: 100000 }); assert.equal(result.exitCode, 0, result.output); return result.output.trim() }
  await git('init', '-b', 'main'); await writeFile(join(source, 'file.txt'), 'x\n'); await git('add', '.'); await git('commit', '-m', 'initial')
  const workspaces = makeWorkspaces(foreign, { grants: await loadWorkspaceGrants([]) })
  t.after(async () => { await workspaces.dispose() })
  const mission = { id: 'mission-revoked', workspace: await realpath(source), workspaceGrantRoot: await realpath(granted) }
  await assert.rejects(workspaces.prepareBaseline(mission), error => error instanceof WorkspaceRevokedError && new RegExp(WORKSPACE_AUTHORIZATION_CODE).test(error.message))
})

/**
 * T3e: the native /agent-swarm request path. `prepareStart` snapshots the
 * request workspace through a synthetic baseline record; that record must carry
 * the authorization source and root the request recorded, or the X3 fail-closed
 * rule fences a session-cwd request before planning. The control proves X3 is
 * not weakened: a granted request whose root the human removed still fences.
 */
test('T3e: prepareStart authorizes a session-cwd baseline and still fences a removed grant root', async t => {
  const { temp, session, granted, project } = await fixture(t)
  const initRepo = async cwd => {
    const run = async (...args) => { const result = await runProcess(['git', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm-test@localhost', ...args], { subprocess: subprocessSeam, cwd, timeoutMs: 30000, maxBytes: 100000 }); assert.equal(result.exitCode, 0, result.output) }
    await run('init', '-q'); await run('commit', '-q', '--allow-empty', '-m', 'initial')
  }
  await initRepo(session); await initRepo(project)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const workspaces = makeWorkspaces(temp, { workspacesRoot: join(temp, 'snapshots'), maxCheckOutputBytes: 100000, grants })
  const adapter = new FakeWorkers({ prepareBaseline: (mission, signal) => workspaces.prepareBaseline(mission, signal), dispose: () => workspaces.dispose() })
  const { runtime } = await makeRuntime(t, { workers: adapter, config: wired(grants) })

  // The native command path records a session authorization for the session cwd.
  const owner = { sessionId: 'owner-t3e', agent: { id: 'owner-t3e', session: { header: { cwd: session } } } }
  const request = runtime.requestStart(owner, { commandId: 't3e-session', goal: 'Plan the change', workspace: session, workspaceAuthorizationSource: 'session' })
  assert.equal(request.workspaceAuthorizationSource, 'session', 'a session-cwd request records source session')
  assert.equal(request.workspaceGrantRoot, session)
  const prepared = await runtime.prepareStart(owner, request.id)
  assert.ok(prepared.baseline.planningWorkspace.startsWith(join(temp, 'snapshots')), 'the baseline snapshot is prepared instead of fenced')
  assert.equal(runtime.store.events(request.id, 500).filter(event => event.type === 'mission/workspace-revoked').length, 0, 'a session baseline is not revoked')
  assert.equal(runtime.store.get('starts', request.id).status, 'planning')

  // Control: the human removed the granted root, so the granted request still
  // fails closed at baseline preparation (X3 preserved).
  const owner2 = { sessionId: 'owner-t3e-2', agent: { id: 'owner-t3e-2', session: { header: { cwd: session } } } }
  const grantedRequest = runtime.requestStart(owner2, { commandId: 't3e-granted', goal: 'Plan granted work', workspace: project })
  assert.equal(grantedRequest.workspaceAuthorizationSource, 'grant')
  assert.equal(grantedRequest.workspaceGrantRoot, await realpath(granted))
  grants.grants.length = 0
  await assert.rejects(runtime.prepareStart(owner2, grantedRequest.id), revokedError)
  assert.equal(runtime.store.get('starts', grantedRequest.id).baseline, undefined, 'a fenced baseline records no snapshot')
})

/**
 * A missing authorization source means the same at admission as at
 * re-validation (X3): it never takes the session branch. A workspace outside
 * every configured root is admitted only as an explicit session workspace.
 */
test('Admission never reads a missing source as a session authorization', async t => {
  const { session, granted } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const { runtime } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(grants) })
  const sessionPath = await realpath(session)
  const input = extra => ({ title: 'Session work', objective: 'Work in the session cwd', workspace: sessionPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget }, ...extra })
  assert.throws(() => runtime.create({ sessionId: 'owner-no-source' }, input({})), new RegExp(WORKSPACE_AUTHORIZATION_CODE), 'create refuses a source-less workspace no root contains')
  assert.throws(() => runtime.create({ sessionId: 'owner-grant-source' }, input({ workspaceAuthorizationSource: 'grant' })), new RegExp(WORKSPACE_AUTHORIZATION_CODE), 'a grant source needs a configured root')
  assert.throws(() => runtime.requestStart({ sessionId: 'owner-no-source' }, { commandId: 'no-source', goal: 'Plan', workspace: sessionPath }), new RegExp(WORKSPACE_AUTHORIZATION_CODE), 'requestStart refuses it too')
  const admitted = runtime.create({ sessionId: 'owner-session' }, input({ workspaceAuthorizationSource: 'session' }))
  assert.deepEqual({ root: admitted.workspaceGrantRoot, source: admitted.workspaceAuthorizationSource }, { root: sessionPath, source: 'session' })
  const request = runtime.requestStart({ sessionId: 'owner-session-start' }, { commandId: 'session', goal: 'Plan', workspace: sessionPath, workspaceAuthorizationSource: 'session' })
  assert.equal(request.workspaceAuthorizationSource, 'session')
})

/** Criterion 5: workers never create missions or use grants; missions cannot be re-pointed. */
test('AC5: a worker session cannot create a mission or use a grant, and another session cannot re-point a mission', async t => {
  const { session, granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const { runtime } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(grants) })
  const owner = { sessionId: 'owner-a' }
  const projectPath = await realpath(project), grantedPath = await realpath(granted)
  const mission = runtime.create(owner, { title: 'Owned', objective: 'Own the workspace', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const member = await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const workerSession = member.sessionId
  assert.throws(() => runtime.create({ sessionId: workerSession }, { title: 'Worker mission', objective: 'Escape', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } }), /Workers cannot/)
  assert.throws(() => runtime.createDraft({ sessionId: workerSession }, plan(projectPath, { workspaceGrantRoot: grantedPath })), /Workers cannot/)
  const tools = definitions(runtime, grants)
  await assert.rejects(tools.get('swarm_create').execute(missionFields(projectPath), execution(session, workerSession)), /Workers cannot/)
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
  const { session, granted, project } = await fixture(t)
  const before = await loadWorkspaceGrants([{ path: granted }])
  const { config, runtime, workers } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(before) })
  const owner = { sessionId: 'owner' }
  const projectPath = await realpath(project), grantedPath = await realpath(granted)
  const mission = runtime.create(owner, { title: 'Running', objective: 'Keep working', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  await runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Work', objective: 'Do the work', kind: 'research', scope: ['src/'], acceptance: ['works'] })
  await runtime.start(before)
  await eventually(() => workers.prepared.length > 0, 'the mission never started working', 15000)
  await runtime.dispose()
  // Human removes the root and restarts: the same durable state, no grant.
  const after = await loadWorkspaceGrants([])
  const restarted = new SwarmRuntime({ ...config, grants: after }, workspaceWorkers())
  t.after(async () => { await restarted.dispose() })
  assert.throws(() => restarted.create(owner, { title: 'New', objective: 'New mission in a revoked root', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } }), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  await restarted.start(after)
  const blocked = await eventually(() => restarted.store.list('tasks', mission.id).find(task => task.status === 'blocked'), 'the running mission was not fenced', 15000)
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

/** D1 (review task_fb92df98): the runtime must decide fencing from the loaded roots. */
test('D1: a runtime wired like the plugin keeps a configured-root mission staffable and unfenced', async t => {
  const { granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const projectPath = await realpath(project), grantedPath = await realpath(granted)
  const { runtime: live } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(grants) })
  const liveOwner = { sessionId: 'owner-wired' }
  const liveMission = live.create(liveOwner, { title: 'Wired', objective: 'Stay staffable', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const member = await live.addMember(liveOwner, liveMission.id, { name: 'Builder', role: 'implementation' })
  assert.ok(member.id, 'the mission inside a configured root is staffable')
  assert.equal(live.store.events(liveMission.id, 200).filter(event => event.type === 'mission/workspace-revoked').length, 0, 'no false revocation while the root stays configured')
  await live.dispose()
  // Nested configured roots resolve to the most specific root at admission and
  // at fencing, so a mission strictly inside both is not falsely revoked.
  const nestedRepo = join(project, 'nested')
  await mkdir(nestedRepo)
  const nested = await loadWorkspaceGrants([{ path: granted }, { path: project }])
  const { runtime: nestedRuntime } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(nested) })
  const nestedOwner = { sessionId: 'owner-nested' }
  const nestedMission = nestedRuntime.create(nestedOwner, { title: 'Nested', objective: 'Most specific root', workspace: await realpath(nestedRepo), workspaceGrantRoot: await realpath(granted), scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  assert.equal(nestedMission.workspaceGrantRoot, await realpath(project), 'the most specific configured root is recorded')
  await nestedRuntime.addMember(nestedOwner, nestedMission.id, { name: 'Builder', role: 'implementation' })
  await nestedRuntime.dispose()
  // Revocation under the same wiring still fences.
  const revocable = await loadWorkspaceGrants([{ path: granted }])
  const { runtime } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(revocable) })
  const owner = { sessionId: 'owner-revoked' }
  const mission = runtime.create(owner, { title: 'Revoked', objective: 'Fence', workspace: projectPath, workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  revocable.grants.length = 0
  await assert.rejects(runtime.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' }), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
})

/**
 * D2 (review task_fb92df98) once re-validated a persisted manifest anchor at the
 * adapter's verification checkout. The runtime re-validates the durable
 * mission record before it asks the adapter for any checkout, so a removed
 * root fences the verification there, once, with the typed error.
 */
test('D2: verification re-validates before the adapter is asked for a checkout; a removed root fences it once', async t => {
  const { granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const { runtime, workers } = await makeRuntime(t, { workers: claimingWorkers(), config: wired(grants), clock: new FakeClock() })
  const f = await grantedMission(runtime, project, granted, 'owner-verify')
  const source = f.propose({ kind: 'implementation', checks: ['test -d .'], assigneeId: f.author.id })
  const claimed = await runtime.claim(f.actor(f.author), f.mission.id, source.id)
  await runtime.submit(f.actor(f.author), f.mission.id, { taskId: source.id, attemptId: claimed.attempt.id, output: 'done' })
  const review = f.propose({ title: 'Review', objective: 'Independent review', kind: 'verification', reviewOf: source.id, assigneeId: f.reviewer.id })
  const reviewing = await runtime.claim(f.actor(f.reviewer), f.mission.id, review.id)
  grants.grants.length = 0
  await assert.rejects(runtime.verify(f.actor(f.reviewer), f.mission.id, { taskId: review.id, attemptId: reviewing.attempt.id, verdict: 'reject', reason: 'reviewed' }), revokedError)
  assert.deepEqual(workers.verified, [], 'the adapter is never asked for a verification checkout')
  assert.equal(runtime.store.get('tasks', review.id).status, 'blocked', 'the running review is fenced')
  assert.equal(revokedEvents(runtime, f.mission.id).length, 1, 'exactly one revocation event')
})

/** D3 (review task_5be8e5d8): an exact-root grant mission must be fenced on revocation. */
test('D3: a mission whose workspace equals the configured root is staffable and fenced on revocation', async t => {
  const { session, granted } = await fixture(t)
  const grantedPath = await realpath(granted), sessionPath = await realpath(session)
  const live = await loadWorkspaceGrants([{ path: granted }])
  const { config, runtime: before } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(live) })
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
  const restarted = new SwarmRuntime({ ...config, grants: after }, workspaceWorkers())
  t.after(async () => { await restarted.dispose() })
  await assert.rejects(restarted.addMember(owner, mission.id, { name: 'Second', role: 'implementation' }), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  const revoked = restarted.store.events(mission.id, 200).filter(event => event.type === 'mission/workspace-revoked')
  assert.equal(revoked.length, 1, 'exactly one durable revocation event')
  const notice = restarted.store.list('deliveries', mission.id).find(delivery => delivery.to === 'owner' && delivery.kind === 'control')
  assert.ok(notice, 'the owner is notified of the revocation')
  await restarted.settle(mission.id)
  assert.ok(restarted.store.get('deliveries', notice.id).deliveredAt, 'the adapter delivered the revocation notice to the owner')
  // S4b: `fenceWorkspace` now emits the shared coded workspace terminal, so the
  // owner notice carries that stable code plus the substantive revocation
  // reason; the underlying authorization code stays in the durable event detail.
  assert.match(notice.content, /\[workspace_terminal\]/, 'the owner notice carries the shared coded terminal')
  assert.match(notice.content, /removed from authorizedWorkspaces/, 'the notice still names why the root was revoked')
  assert.equal(restarted.store.events(sessionMission.id, 200).filter(event => event.type === 'mission/workspace-revoked').length, 0, 'a session-cwd mission is never fenced')
  await restarted.addMember(sessionOwner, sessionMission.id, { name: 'Second', role: 'implementation' })
})

/**
 * X3 (external review): revocation fencing must fail closed when the recorded
 * authorization source is absent. `workspace === root` with `source` omitted
 * must be judged by the configured set, never by the permissive session
 * shortcut, at both the module and the runtime site.
 */
test('X3: a recorded root equal to the workspace fails closed when its source is missing and the root is revoked', async t => {
  const { granted } = await fixture(t)
  const grantedPath = await realpath(granted)
  const live = await loadWorkspaceGrants([{ path: granted }])
  const removed = await loadWorkspaceGrants([])

  // Direct module, workspace === root, source omitted.
  const liveControl = await reauthorizeWorkspace({ workspace: grantedPath, workspaceGrantRoot: grantedPath }, live)
  assert.equal(liveControl.ok, true, 'a still-configured root authorizes an exact-root record with no source')
  assert.equal(liveControl.source, 'grant', 'the configured set decides before any session shortcut')
  const revokedControl = await reauthorizeWorkspace({ workspace: grantedPath, workspaceGrantRoot: grantedPath }, removed)
  assert.equal(revokedControl.ok, false, 'a missing source must not pick the permissive session branch')
  assert.match(revokedControl.diagnostic, new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  const explicitSession = await reauthorizeWorkspace({ workspace: grantedPath, workspaceGrantRoot: grantedPath, workspaceAuthorizationSource: 'session' }, removed)
  assert.equal(explicitSession.ok, true, 'an explicit session record stays authorized when its root is not configured')
  assert.equal(explicitSession.source, 'session')
  assert.equal((await reauthorizeWorkspace({ workspace: grantedPath, workspaceGrantRoot: grantedPath, workspaceAuthorizationSource: 'grant' }, removed)).ok, false, 'an explicit grant record is refused once the root is revoked')

  // Runtime path: a durable record that carries the anchor but no source must
  // fence on revocation, and must stay staffable while the root is configured.
  const { config, runtime: before } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(live) })
  const owner = { sessionId: 'owner-x3' }
  const mission = before.create(owner, { title: 'Missing source', objective: 'Fail closed on revocation', workspace: grantedPath, workspaceGrantRoot: grantedPath, workspaceAuthorizationSource: 'grant', scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  await before.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const stored = before.store.get('missions', mission.id)
  delete stored.workspaceAuthorizationSource
  before.store.transaction(() => before.store.put('missions', stored))
  assert.equal(before.store.get('missions', mission.id).workspaceAuthorizationSource, undefined, 'the simulated record has no source')
  await before.addMember(owner, mission.id, { name: 'Live control', role: 'implementation' })
  assert.equal(before.store.events(mission.id, 200).filter(event => event.type === 'mission/workspace-revoked').length, 0, 'the live root keeps the source-less record authorized')
  await before.dispose()

  const restarted = new SwarmRuntime({ ...config, grants: removed }, workspaceWorkers())
  t.after(async () => { await restarted.dispose() })
  await assert.rejects(restarted.addMember(owner, mission.id, { name: 'Second', role: 'implementation' }), new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  const revoked = restarted.store.events(mission.id, 200).filter(event => event.type === 'mission/workspace-revoked')
  assert.equal(revoked.length, 1, 'the source-less record is fenced exactly once on revocation')
  assert.match(revoked[0].data.reason, new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  const notice = restarted.store.list('deliveries', mission.id).find(delivery => delivery.to === 'owner' && delivery.kind === 'control')
  assert.ok(notice, 'the owner is notified of the revocation')
  await restarted.settle(mission.id)
  assert.ok(restarted.store.get('deliveries', notice.id).deliveredAt, 'the adapter delivered the revocation notice to the owner')
})

test('G1: grant expiry is judged at the runtime clock\'s instant by admission and by the dispatch fence alike', async t => {
  // Admission read the runtime clock, but the dispatch and verification fence
  // once called a config closure that judged expiry on the wall clock. With
  // the runtime clock past expiresAt, admission refused a new mission under the
  // grant while the fence kept the admitted one live.
  const { granted, project } = await fixture(t)
  const second = join(granted, 'second')
  await mkdir(second)
  const grants = await loadWorkspaceGrants([{ path: granted, expiresAt: Date.now() + 5_000 }])
  const clock = new FakeClock()
  // Wired as src/index.ts wires the plugin runtime.
  const { runtime } = await makeRuntime(t, { workers: workspaceWorkers(), config: { ...wired(grants), manualTick: true, now: clock.now } })
  const owner = { sessionId: 'owner-expiry' }
  const grantedPath = await realpath(granted), projectPath = await realpath(project), secondPath = await realpath(second)
  const input = workspace => ({ title: 'Expiring grant', objective: 'Fence at expiry', workspace, workspaceGrantRoot: grantedPath, workspaceAuthorizationSource: 'grant', scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const mission = runtime.create(owner, input(projectPath))
  await runtime.assertWorkspaceAuthorized(runtime.mission(mission.id))
  clock.advance(10_000)
  assert.throws(() => runtime.create(owner, input(secondPath)), /not inside a currently authorizedWorkspaces root/, 'admission refuses the expired grant')
  await assert.rejects(runtime.assertWorkspaceAuthorized(runtime.mission(mission.id)), /was removed from authorizedWorkspaces or has expired/, 'the dispatch fence refuses it at the same instant')
  assert.equal(runtime.store.events(mission.id, 200).filter(event => event.type === 'mission/workspace-revoked').length, 1, 'the admitted mission is fenced once')
})

/**
 * H-1 (review 2026-09-24): re-validation selected the longest configured root
 * and demanded it equal the recorded one, so configuring a narrower root later
 * fenced a healthy mission with "Authorized root … was removed". Admission and
 * re-validation now share one selector: a workspace any active configured root
 * contains stays authorized, whichever root was recorded.
 */
test('H-1: a narrower root configured after admission keeps the mission authorized, and so does removing it again', async t => {
  const { granted, project } = await fixture(t)
  const grantedPath = await realpath(granted), projectPath = await realpath(project)
  const input = (title, workspaceGrantRoot) => ({ title, objective: 'Stay authorized', workspace: projectPath, workspaceGrantRoot, workspaceAuthorizationSource: 'grant', scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const outer = await loadWorkspaceGrants([{ path: granted }])
  const { config, runtime: before } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(outer) })
  const owner = { sessionId: 'owner-h1' }
  const mission = before.create(owner, input('Outer root', grantedPath))
  assert.equal(mission.workspaceGrantRoot, grantedPath)
  await before.dispose()
  // The human adds /granted/project and keeps /granted.
  const both = await loadWorkspaceGrants([{ path: granted }, { path: project }])
  const widened = new SwarmRuntime({ ...config, grants: both }, workspaceWorkers())
  t.after(async () => { await widened.dispose() })
  await widened.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  assert.equal(revokedEvents(widened, mission.id).length, 0, 'a healthy mission is not fenced when a nested root is added')
  // Mirror: admitted under the narrower root, which the human removes while the outer root still contains the workspace.
  const nested = widened.create(owner, input('Inner root', grantedPath))
  assert.equal(nested.workspaceGrantRoot, projectPath, 'admission records the most specific root')
  await widened.dispose()
  const narrowed = new SwarmRuntime({ ...config, grants: await loadWorkspaceGrants([{ path: granted }]) }, workspaceWorkers())
  t.after(async () => { await narrowed.dispose() })
  await narrowed.addMember(owner, nested.id, { name: 'Builder', role: 'implementation' })
  assert.equal(revokedEvents(narrowed, nested.id).length, 0, 'a workspace the outer root still contains is not fenced')
})

/** The one rule, shape by shape: every difference the three former implementations had, decided once. */
test('One rule: reauthorizeWorkspace judges every recorded shape with the admission selector', async t => {
  const { temp, session, granted, foreign, project } = await fixture(t)
  const alias = join(temp, 'granted-alias')
  await symlink(granted, alias)
  const at = Date.now()
  const load = roots => loadWorkspaceGrants(roots.map(root => typeof root === 'string' ? { path: root } : root), at)
  const outer = await load([granted]), inner = await load([project]), both = await load([granted, project]), none = await load([])
  const expiring = await load([{ path: granted, expiresAt: at + 1_000 }]), aliased = await load([alias])
  const grant = (workspace, workspaceGrantRoot) => ({ workspace, workspaceGrantRoot, workspaceAuthorizationSource: 'grant' })
  const cases = [
    ['a session workspace with no root configured', { workspace: session, workspaceGrantRoot: session, workspaceAuthorizationSource: 'session' }, none, at, 'session'],
    ['a grant whose root is configured', grant(project, granted), outer, at, 'grant'],
    ['a grant whose root was removed', grant(project, granted), none, at, /was removed from authorizedWorkspaces/],
    ['a missing source whose root is configured', { workspace: granted, workspaceGrantRoot: granted }, outer, at, 'grant'],
    ['a missing source whose root was removed (X3 fails closed)', { workspace: granted, workspaceGrantRoot: granted }, none, at, /was removed from authorizedWorkspaces/],
    ['a missing anchor inside a configured root', { workspace: project }, outer, at, 'grant'],
    ['a missing anchor outside every configured root', { workspace: session }, outer, at, /was removed from authorizedWorkspaces/],
    ['a grant before its expiresAt', grant(project, granted), expiring, at, 'grant'],
    ['a grant at its expiresAt', grant(project, granted), expiring, at + 1_000, /has expired/],
    ['a nested root configured after admission (H-1)', grant(project, granted), both, at, 'grant'],
    ['a recorded nested root removed while the outer root stays', grant(project, project), outer, at, 'grant'],
    ['a recorded outer root removed while a nested root contains the workspace', grant(project, granted), inner, at, 'grant'],
    ['a root configured through a symlink', grant(project, granted), aliased, at, 'grant'],
    ['a workspace that no longer resolves', grant(join(granted, 'gone'), granted), outer, at, /no longer exists or cannot be resolved/],
    ['a workspace outside its recorded root', grant(foreign, granted), outer, at, /escaped its recorded authorized root/],
  ]
  for (const [shape, record, roots, now, expected] of cases) {
    const result = await reauthorizeWorkspace(record, roots, now)
    if (typeof expected === 'string') {
      assert.equal(result.ok, true, `${shape} is authorized`)
      assert.equal(result.source, expected, `${shape} is authorized as ${expected}`)
    } else {
      assert.equal(result.ok, false, `${shape} is refused`)
      assert.match(result.diagnostic, expected, shape)
      assert.match(result.diagnostic, new RegExp(WORKSPACE_AUTHORIZATION_CODE), shape)
    }
  }
})

test('Revocation on the dispatch path fences exactly once, and work resumed afterwards is fenced again', async t => {
  const { granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const { runtime } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(grants), clock: new FakeClock() })
  await runtime.start()
  const f = await grantedMission(runtime, project, granted, 'owner-dispatch')
  grants.grants.length = 0
  const task = f.propose({ assigneeId: f.author.id })
  for (let pass = 0; pass < 3; pass++) { await runtime.tick(); await runtime.settle(f.mission.id) }
  assert.equal(runtime.store.get('tasks', task.id).status, 'blocked', 'dispatch fences the pending task')
  assert.match(runtime.store.get('tasks', task.id).output, new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  assert.equal(revokedEvents(runtime, f.mission.id).length, 1, 'exactly one revocation event')
  assert.equal(workspaceNotices(runtime, f.mission.id).length, 1, 'exactly one owner notice')
  // The owner resumes it before the human restores the root: the fence blocks it again instead of leaving it pending.
  runtime.controlTask(f.owner, f.mission.id, task.id, 'resume', {}, 'retry the work')
  for (let pass = 0; pass < 3; pass++) { await runtime.tick(); await runtime.settle(f.mission.id) }
  assert.equal(runtime.store.get('tasks', task.id).status, 'blocked', 'work that became schedulable again is fenced again')
})

test('Revocation on the claim path refuses with the typed error and fences once', async t => {
  const { granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const { runtime } = await makeRuntime(t, { workers: claimingWorkers(), config: wired(grants), clock: new FakeClock() })
  const f = await grantedMission(runtime, project, granted, 'owner-claim')
  const task = f.propose({ assigneeId: f.author.id })
  grants.grants.length = 0
  await assert.rejects(runtime.claim(f.actor(f.author), f.mission.id, task.id), revokedError)
  assert.equal(runtime.store.get('tasks', task.id).status, 'blocked')
  assert.equal(revokedEvents(runtime, f.mission.id).length, 1, 'exactly one revocation event')
})

/** A Workspaces-backed adapter whose worker start adopts the member worktree, as `HarnessWorkers.open` does. */
class OpeningWorkers extends WorkspaceWorkers {
  async start(spec) { this.started.push(spec.member.id); await this.workspaces.prepareWorkspace(spec.mission, spec.member.id) }
}

/**
 * A worker start reaches the adapter's baseline preparation with no runtime
 * check before it. The adapter refuses with the typed error, and the runtime
 * fences on it instead of counting a start failure against the member.
 */
test('Revocation found by the adapter at a worker start fences once with the typed error and spends no start credit', async t => {
  const repo = await makeRepo('authorized-start')
  t.after(() => rm(repo.root, { recursive: true, force: true }))
  const opening = grants => {
    const workspaces = makeWorkspaces(repo.root, { grants })
    t.after(async () => { await workspaces.dispose() })
    return new OpeningWorkers(workspaces)
  }
  const live = await loadWorkspaceGrants([{ path: repo.root }])
  const { config, runtime: before } = await makeRuntime(t, { workers: opening(live), config: wired(live) })
  const owner = { sessionId: 'owner-start' }
  const mission = before.create(owner, { title: 'Started work', objective: 'Start workers in a granted repository', workspace: repo.source, workspaceGrantRoot: repo.root, workspaceAuthorizationSource: 'grant', scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const member = await before.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const stream = before.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const task = before.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Work', objective: 'Do the work', kind: 'research', scope: ['src/'], acceptance: ['works'], assigneeId: member.id })
  await before.dispose()
  const removed = await loadWorkspaceGrants([])
  const workers = opening(removed)
  const restarted = new SwarmRuntime({ ...config, grants: removed }, workers)
  t.after(async () => { await restarted.dispose() })
  await restarted.start(removed)
  await eventually(() => restarted.store.get('tasks', task.id).status === 'blocked', 'the worker start fenced the mission', 15000)
  const attempts = workers.started.length
  await eventually(() => workers.started.length >= attempts + 2, 'the start is retried against the revoked root', 15000)
  assert.equal(revokedEvents(restarted, mission.id).length, 1, 'exactly one revocation event across the retried starts')
  assert.equal(workspaceNotices(restarted, mission.id).length, 1, 'exactly one owner notice')
  assert.match(restarted.store.get('tasks', task.id).output, new RegExp(WORKSPACE_AUTHORIZATION_CODE))
  const row = restarted.store.get('members', member.id)
  assert.equal(row.startFailures, undefined, 'a revoked root spends no start credit')
  assert.notEqual(row.phase, 'stopped', 'the member is not retired')
})

test('A record from before the anchor existed is judged by the configured roots alone', async t => {
  const { session, granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const { runtime } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(grants) })
  const legacy = (owner, workspace, source) => {
    const mission = runtime.create(owner, { title: 'Legacy', objective: 'Predates the anchor', workspace, ...(source === undefined ? {} : { workspaceAuthorizationSource: source }), scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
    const stored = runtime.store.get('missions', mission.id)
    delete stored.workspaceGrantRoot; delete stored.workspaceAuthorizationSource
    runtime.store.transaction(() => runtime.store.put('missions', stored))
    return mission
  }
  const insideOwner = { sessionId: 'owner-legacy-inside' }, outsideOwner = { sessionId: 'owner-legacy-outside' }
  const inside = legacy(insideOwner, await realpath(project))
  await runtime.addMember(insideOwner, inside.id, { name: 'Builder', role: 'implementation' })
  assert.equal(revokedEvents(runtime, inside.id).length, 0, 'a configured root still contains it')
  const outside = legacy(outsideOwner, await realpath(session), 'session')
  await assert.rejects(runtime.addMember(outsideOwner, outside.id, { name: 'Builder', role: 'implementation' }), revokedError)
  assert.equal(revokedEvents(runtime, outside.id).length, 1, 'no configured root contains it, and it records no session source')
})

test('A restart with the same configuration, and a root configured through a symlink, keep the mission authorized', async t => {
  const { temp, granted, project } = await fixture(t)
  const alias = join(temp, 'granted-alias')
  await symlink(granted, alias)
  const configured = [{ path: alias, note: 'configured through a symlink' }]
  const first = await loadWorkspaceGrants(configured)
  const admitted = await authorizeWorkspace(join(alias, 'project'), undefined, first)
  assert.equal(admitted.grantRoot, await realpath(granted), 'the recorded root is canonical')
  assert.equal(admitted.workspace, await realpath(project), 'the recorded workspace is canonical')
  const { config, runtime: before } = await makeRuntime(t, { workers: workspaceWorkers(), config: wired(first) })
  const owner = { sessionId: 'owner-restart' }
  const mission = before.create(owner, { title: 'Restarted', objective: 'Survive a restart', workspace: admitted.workspace, workspaceGrantRoot: admitted.grantRoot, workspaceAuthorizationSource: admitted.source, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  await before.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  await before.dispose()
  const restarted = new SwarmRuntime({ ...config, grants: await loadWorkspaceGrants(configured) }, workspaceWorkers())
  t.after(async () => { await restarted.dispose() })
  await restarted.addMember(owner, mission.id, { name: 'Second', role: 'implementation' })
  await restarted.assertWorkspaceAuthorized(restarted.mission(mission.id))
  assert.equal(revokedEvents(restarted, mission.id).length, 0)
})
