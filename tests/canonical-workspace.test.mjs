/**
 * V2 regression: a mission created through the model tool surface records a
 * canonical `mission.workspace`, so `applyDelivery` (delivery.ts:65 requires
 * `realpath(source) === source`) can ever apply its result for projects under
 * symlinked paths such as macOS /tmp or a symlinked home.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwarmRuntime } from '../lib/runtime.js'
import { registerTools } from '../lib/tools.js'

const budget = { maxTokens: 100000, maxSteps: 100, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 10, maxExperiments: 2 }
class Workers {
  bind(callbacks) { this.callbacks = callbacks }
  async prepareWorkspace(mission, id) { return join(mission.workspace, id) }
  async start() {}
  async stop() {}
  isIdle() { return true }
  async dispose() {}
}
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

test('swarm_create/swarm_stage canonicalize the workspace so delivery can apply the result', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'swarm-canonical-')))
  const workspace = join(directory, 'workspace'), alias = join(directory, 'workspace-alias')
  await mkdir(workspace); await symlink(workspace, alias)
  const runtime = new SwarmRuntime({ statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 60000,
    maxMessageChars: 10000, maxEvents: 100, maxTasksPerMember: 3 }, new Workers())
  t.after(async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }) })
  const tools = definitions(runtime)
  const exec = { agent: { id: 'canonical-owner', session: { header: { cwd: workspace } } }, signal: new AbortController().signal }
  const created = await tools.get('swarm_create').execute(plan(alias), exec)
  const mission = created.result
  assert.equal(mission.workspace, await realpath(workspace), 'the mission stores the realpath, not the model-supplied alias')
  assert.equal(await realpath(mission.workspace), mission.workspace, 'delivery.ts:65 requires a canonical source')
  assert.equal(runtime.store.get('missions', mission.id).workspace, mission.workspace, 'the durable record is canonical')
  const staged = await tools.get('swarm_stage').execute(plan(alias), exec)
  assert.equal(staged.result.input.workspace, await realpath(workspace), 'a staged draft is canonical before launch')
  assert.equal(runtime.drafts({ sessionId: 'canonical-owner' })[0].input.workspace, await realpath(workspace))
})
