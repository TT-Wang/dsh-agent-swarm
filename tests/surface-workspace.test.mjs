/**
 * H4 regression: model planning tools bind the workspace to the calling
 * session (`exec.agent.session.header.cwd`), exactly like the browser path.
 * Without the fix, `swarm_stage`/`swarm_create` accept any absolute path.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTools } from '../lib/tools.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 10, maxExperiments: 2 }
const plan = workspace => ({
  title: 'Session-bound plan', objective: 'Prove the workspace is the session workspace', workspace, scope: ['src/'], acceptance: ['works'], budget,
  members: [{ key: 'analyst', name: 'Analyst', role: 'analysis' }],
  workstreams: [{ key: 'main', title: 'Main', objective: 'Do the work' }],
  tasks: [{ key: 'inspect', workstreamKey: 'main', title: 'Inspect', objective: 'Inspect the repository', kind: 'research', scope: ['src/'], acceptance: ['works'] }],
})
function definitions(runtime) {
  const registered = new Map()
  registerTools({ tools: { register: definition => registered.set(definition.name, definition) } }, runtime, budget)
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

test('swarm_stage/swarm_create reject a workspace whose realpath differs from exec.agent.session.header.cwd', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'swarm-surface-workspace-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'workspace'), other = join(directory, 'other')
  await mkdir(workspace); await mkdir(other)
  const runtime = fakeRuntime()
  const tools = definitions(runtime)
  await assert.rejects(tools.get('swarm_create').execute(plan(other), execution(workspace)), /Plan workspace must match the selected session workspace/)
  assert.deepEqual(runtime.calls.created, [], 'a mismatched workspace never reaches the runtime')
  await assert.rejects(tools.get('swarm_stage').execute(plan(other), execution(workspace)), /Plan workspace must match the selected session workspace/)
  assert.deepEqual(runtime.calls.staged, [], 'a mismatched draft is never saved')
})

test('swarm_create/swarm_stage accept a symlinked alias of the session workspace and record its canonical path', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'swarm-surface-alias-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'workspace'), alias = join(directory, 'workspace-alias')
  await mkdir(workspace); await symlink(workspace, alias)
  const canonical = await realpath(workspace)
  const runtime = fakeRuntime()
  const tools = definitions(runtime)
  const created = await tools.get('swarm_create').execute(plan(alias), execution(workspace))
  assert.equal(runtime.calls.created.length, 1)
  assert.equal(runtime.calls.created[0].workspace, canonical, 'the mission records the canonical workspace, not the alias')
  assert.equal(created.result.workspace, canonical)
  const staged = await tools.get('swarm_stage').execute(plan(alias), execution(alias))
  assert.equal(runtime.calls.staged.length, 1)
  assert.equal(runtime.calls.staged[0].workspace, canonical, 'a draft from a symlinked session cwd also canonicalizes')
  assert.equal(staged.result.input.workspace, canonical)
})

test('planning tools fail closed when the calling session exposes no workspace', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'swarm-surface-nocwd-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const runtime = fakeRuntime()
  const tools = definitions(runtime)
  await assert.rejects(tools.get('swarm_create').execute(plan(directory), execution(undefined)), /session workspace/)
  await assert.rejects(tools.get('swarm_stage').execute(plan(directory), execution(undefined)), /session workspace/)
  assert.deepEqual(runtime.calls.created, [])
  assert.deepEqual(runtime.calls.staged, [])
})
