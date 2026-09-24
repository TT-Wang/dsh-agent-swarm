/**
 * V2 regression: a mission created through the model tool surface records a
 * canonical `mission.workspace`, so `applyDelivery` (delivery.ts:65 requires
 * `realpath(source) === source`) can ever apply its result for projects under
 * symlinked paths such as macOS /tmp or a symlinked home.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { registerTools } from '../lib/tools.js'
import { FakeWorkers, budget as sharedBudget, makeRuntime } from './faults/harness.mjs'

const budget = { ...sharedBudget, maxTokens: 100000, maxSteps: 100, maxTasks: 10, maxExperiments: 2 }
function definitions(runtime) {
  const registered = new Map()
  registerTools({ tools: { register: definition => registered.set(definition.name, definition) } }, runtime, budget)
  return registered
}
const plan = workspace => ({
  title: 'Canonical workspace plan', objective: 'Record a canonical mission workspace', workspace, scope: ['src/'], acceptance: ['works'], budget,
  members: [{ key: 'analyst', name: 'Analyst', role: 'analysis' }],
  workstreams: [{ key: 'main', title: 'Main', objective: 'Do the work' }],
  tasks: [{ key: 'inspect', workstreamKey: 'main', title: 'Inspect', objective: 'Inspect the repository', kind: 'research', scope: ['src/'], acceptance: ['works'] }],
})
/** swarm_create takes the mission fields only; members, workstreams and tasks are not its parameters. */
const missionFields = workspace => { const { members: _m, workstreams: _w, tasks: _t, ...fields } = plan(workspace); return fields }

test('swarm_create/swarm_stage canonicalize the workspace so delivery can apply the result', async t => {
  const { dir: directory, runtime } = await makeRuntime(t, {
    workers: new FakeWorkers({ autoIdle: true, async prepareWorkspace(mission, id) { return join(mission.workspace, id) } }),
    config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 100, checkTimeoutMs: undefined },
  })
  const workspace = join(directory, 'workspace'), alias = join(directory, 'workspace-alias')
  await mkdir(workspace); await symlink(workspace, alias)
  const tools = definitions(runtime)
  const exec = { agent: { id: 'canonical-owner', session: { header: { cwd: workspace } } }, signal: new AbortController().signal }
  const created = await tools.get('swarm_create').execute(missionFields(alias), exec)
  const mission = created.result
  assert.equal(mission.workspace, await realpath(workspace), 'the mission stores the realpath, not the model-supplied alias')
  assert.equal(await realpath(mission.workspace), mission.workspace, 'delivery.ts:65 requires a canonical source')
  assert.equal(runtime.store.get('missions', mission.id).workspace, mission.workspace, 'the durable record is canonical')
  const staged = await tools.get('swarm_stage').execute(plan(alias), exec)
  assert.equal(staged.result.input.workspace, await realpath(workspace), 'a staged draft is canonical before launch')
  assert.equal(runtime.drafts({ sessionId: 'canonical-owner' })[0].input.workspace, await realpath(workspace))
})
