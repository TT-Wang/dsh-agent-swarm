/**
 * T1d real-composition projection (R11-08 / R11-09).
 *
 * The client is a projection of durable state, so the new event families must
 * reach the compact panel through the composition the host builds — the real
 * `SwarmRuntime` store, its real snapshot, the real client projection and the
 * real render — not through a hand-supplied fixture. This file proves:
 *   1. the promoted authorized-workspace feature's binding event renders;
 *   2. its revocation event renders with the owner-facing reason after a real
 *      restart with the human root removed;
 *   3. the sanctioned board stays model-tool-only in the client and the
 *      declared gap is documented and held by this test.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { authorizeWorkspace, loadWorkspaceGrants } from '../lib/authorization.js'
import { SwarmRuntime } from '../lib/runtime.js'
import { recentProgress } from '../lib/types/client/progress.js'
import { RecentProgress } from '../lib/types/client/MissionProgress.js'
import { SwarmBoard } from '../lib/types/client/SwarmBoard.js'
import { eventSummary } from '../lib/types/client/projection.js'
import { CopyContext, zh } from '../lib/types/client/locale.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 10, maxExperiments: 2 }
const renderChinese = (component, props) => renderToStaticMarkup(
  React.createElement(CopyContext.Provider, { value: text => zh[text] ?? text }, React.createElement(component, props)))
class Workers {
  bind() {}
  async prepareWorkspace(mission, memberId) { return join(mission.workspace, memberId) }
  async start() {}
  async stop() {}
  isIdle() { return true }
  async dispose() {}
}
class TickingWorkers extends Workers {
  prepared = 0
  async deliver() {}
  async prepareTask() { this.prepared++ }
  async captureArtifact() { return { commit: 'artifact', baseCommit: 'base', workspace: '/isolated', changedPaths: [] } }
  async verifyArtifact() { return [] }
}
async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'swarm-client-projection-')))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const session = join(temp, 'session'), granted = join(temp, 'granted')
  await mkdir(session); await mkdir(granted)
  const project = join(granted, 'project'); await mkdir(project)
  return { temp, session, granted, project }
}
async function eventually(read, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(message)
}
const runtimeConfig = directory => ({ statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 20, maxMessageChars: 10000, maxEvents: 500, maxTasksPerMember: 3 })

test('the real runtime snapshot projects the workspace binding into the compact panel with its payload', async t => {
  const { temp, granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted, note: 'human-approved tree' }])
  const runtime = new SwarmRuntime({ ...runtimeConfig(temp), grants,
    authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, grants) }, new Workers())
  t.after(async () => { await runtime.dispose() })
  await runtime.start(grants)
  const owner = { sessionId: 'owner-bound' }
  const mission = runtime.create(owner, { title: 'Bound mission', objective: 'Work inside a human-authorized root',
    workspace: await realpath(project), workspaceGrantRoot: await realpath(granted), scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const snapshot = runtime.snapshot(owner, mission.id)
  const bound = snapshot.events.find(event => event.type === 'mission/workspace-bound')
  assert.ok(bound, 'the mission snapshot carries the durable binding event')
  const progress = recentProgress(snapshot, 20).find(event => event.label === 'Mission bound to an authorized workspace')
  assert.ok(progress, 'the compact panel labels the binding event')
  assert.equal(progress.detail, mission.workspace, 'the resolved workspace is the owner-facing detail')
  // The Activity view reconstructs the authorization payload without raw keys.
  const summary = eventSummary(bound.data)
  assert.match(summary, /workspace: /)
  assert.match(summary, /grantRoot: /)
  assert.match(summary, /source: grant/)
  // The panel translates the label through the real zh table.
  const chinese = renderChinese(RecentProgress, { snapshot })
  assert.match(chinese, /任务已绑定到授权工作目录/)
  assert.doesNotMatch(chinese, />Mission bound to an authorized workspace</)
})

test('a real restart with the human root removed projects the revocation with its reason', async t => {
  const { temp, granted, project } = await fixture(t)
  const grants = await loadWorkspaceGrants([{ path: granted }])
  const workers = new TickingWorkers()
  const before = new SwarmRuntime({ ...runtimeConfig(temp), grants,
    authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, grants) }, workers)
  const owner = { sessionId: 'owner-revoked' }
  const projectPath = await realpath(project), grantedPath = await realpath(granted)
  const mission = before.create(owner, { title: 'Running', objective: 'Keep working', workspace: projectPath,
    workspaceGrantRoot: grantedPath, scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  await before.addMember(owner, mission.id, { name: 'Builder', role: 'implementation' })
  const stream = before.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  before.propose(owner, mission.id, { workstreamId: stream.id, title: 'Work', objective: 'Do the work', kind: 'research', scope: ['src/'], acceptance: ['works'] })
  await before.start(grants)
  await eventually(() => workers.prepared > 0, 'the mission never started working')
  await before.dispose()
  // A human removes the root and restarts the host: the same durable state, no grant.
  const after = await loadWorkspaceGrants([])
  const restarted = new SwarmRuntime({ ...runtimeConfig(temp), grants: after,
    authorizeWorkspace: (workspace, cwd) => authorizeWorkspace(workspace, cwd, after) }, new TickingWorkers())
  t.after(async () => { await restarted.dispose() })
  await restarted.start(after)
  await eventually(() => restarted.store.list('tasks', mission.id).find(task => task.status === 'blocked'), 'the running mission was not fenced')
  const snapshot = restarted.snapshot(owner, mission.id)
  const revoked = recentProgress(snapshot, 20).find(event => event.label === 'Mission workspace authorization revoked')
  assert.ok(revoked, 'the compact panel labels the revocation')
  assert.match(revoked.detail, /workspace_not_authorized|authorizedWorkspaces/, 'the owner-facing reason is the detail')
  const event = snapshot.events.find(item => item.type === 'mission/workspace-revoked')
  assert.ok(event, 'the revocation is durable in the mission snapshot')
  const summary = eventSummary(event.data)
  assert.match(summary, /grantRoot: /)
  assert.match(summary, /blockedTasks: /)
  assert.match(renderChinese(RecentProgress, { snapshot }), /任务工作目录授权已撤销/)
})

test('the sanctioned board stays model-tool-only in the client and the declared gap is documented', async t => {
  const { temp, session } = await fixture(t)
  const runtime = new SwarmRuntime({ ...runtimeConfig(temp) }, new Workers())
  t.after(async () => { await runtime.dispose() })
  const owner = { sessionId: 'owner-board' }
  const mission = runtime.create(owner, { title: 'Board mission', objective: 'Post a durable note', workspace: session,
    scope: ['src/'], acceptance: ['works'], budget: { ...budget } })
  const marker = 'BOARD-ONLY-MARKER-9f2c'
  runtime.post(owner, mission.id, { kind: 'IDEA', body: `cross-task note ${marker}`, to: 'owner' })
  // The post is readable through the model tool surface...
  const board = runtime.board(owner, mission.id, { to: 'me' })
  assert.equal(JSON.stringify(board).includes(marker), true, 'swarm_board returns the post to a model session')
  // ...but the client snapshot carries no board projection and no event row.
  const snapshot = runtime.snapshot(owner, mission.id)
  assert.equal(Object.hasOwn(snapshot, 'posts'), false, 'the client snapshot must not claim a posts projection')
  assert.equal(Object.hasOwn(snapshot, 'inbox'), false, 'the client snapshot must not claim an inbox projection')
  assert.equal(JSON.stringify(snapshot.events).includes(marker), false, 'posting emits no event row of its own')
  const html = renderToStaticMarkup(React.createElement(SwarmBoard, { snapshot, initialView: 'activity' }))
  assert.equal(html.includes(marker), false, 'the panel renders no board posts')
  // The chosen R11-09 path is explicit in the packaged limitations document.
  const limitations = await readFile(new URL('../docs/known-limitations.md', import.meta.url), 'utf8')
  assert.ok(limitations.includes('model-tool-only'), 'docs/known-limitations.md must state the board is model-tool-only')
  assert.ok(limitations.includes('carries no `posts`/`inbox` field'), 'the exact projection gap must be named')
  assert.ok(limitations.includes('mission/workspace-bound') && limitations.includes('mission/workspace-revoked'),
    'the document names the projected workspace events')
})
