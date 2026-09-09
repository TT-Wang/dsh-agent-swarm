/**
 * R11-06 regression: every declared package.json script is classified by the
 * command it resolves to, the host-gate entry points are in the host-only set,
 * and a neutral script name cannot launder a host-only body through
 * `runtime.propose`.
 *
 * Pre-fix head: `classifyCheck` matched only a fixed name list, so
 * `npm run test:deepseek`, `test:sidebar-service`, `test:command-deepseek` and
 * `test:validation-repair-web` were admitted as worker checks.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyCheck, loadPackageScripts } from '../lib/admission.js'
import { SwarmRuntime } from '../lib/runtime.js'

const budget = { maxTokens: 100000, maxSteps: 200, maxWorkers: 3, maxDurationMs: 600000, maxTasks: 20, maxExperiments: 0 }
/** Declared scripts that cannot run under the worker workspace-write sandbox. */
const HOST_ONLY_SCRIPTS = new Set([
  'test:harness', 'test:pack', 'test:profile', 'test:web', 'test:isolation',
  'test:command-web', 'test:deepseek', 'test:command-deepseek', 'test:sidebar-service', 'test:validation-repair-web', 'verify',
])

test('R11-06: every declared npm script is classified by its resolved body', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const scripts = manifest.scripts
  assert.ok(Object.keys(scripts).length >= 20, 'the table covers every declared script')
  for (const [name, body] of Object.entries(scripts)) {
    const classification = classifyCheck(`npm run ${name}`, scripts)
    if (HOST_ONLY_SCRIPTS.has(name)) {
      assert.equal(classification.runnable, 'host-only', `${name} (${body})`)
      assert.equal(classification.code, 'check_requires_host')
      assert.ok(classification.requirement.length > 0)
    } else {
      assert.equal(classification.runnable, 'worker', `${name} (${body}) must stay worker-runnable`)
    }
  }
  // The three expose-internals smoke forms are host-only even without a manifest.
  for (const command of ['node --expose-internals scripts/smoke-deepseek.mjs', 'node --expose-internals scripts/smoke-command-deepseek.mjs', 'node scripts/smoke-better-sidebar.mjs']) {
    assert.equal(classifyCheck(command).runnable, 'host-only', command)
  }
  // Name-only classification still refuses the declared host gates (plans have no manifest).
  for (const name of HOST_ONLY_SCRIPTS) {
    if (name === 'verify') continue
    assert.equal(classifyCheck(`npm run ${name}`).runnable, 'host-only', `${name} by name`)
  }
})

test('R11-06: runtime.propose refuses a host-only body behind a neutral script name', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-host-scripts-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'host-scripts-fixture', private: true,
    scripts: { smoke: 'node scripts/smoke-web.mjs', unit: 'node --test tests/*.test.mjs', chain: 'npm run smoke' },
  }))
  assert.deepEqual(Object.keys(loadPackageScripts(directory) ?? {}), ['smoke', 'unit', 'chain'])
  const workers = {
    bind(callbacks) { this.callbacks = callbacks },
    async prepareWorkspace(mission, id) { return join(mission.workspace, id) },
    async start() {}, async prepareTask() {}, async deliver() {}, async stop() {},
    isIdle() { return false }, async dispose() {},
  }
  const runtime = new SwarmRuntime({ statePath: join(directory, 'swarm.sqlite'), leaseMs: 60000, tickMs: 60000, maxMessageChars: 10000, maxEvents: 200, maxTasksPerMember: 3 }, workers)
  t.after(async () => { await runtime.dispose() })
  const owner = { sessionId: 'host-scripts-owner' }
  const mission = runtime.create(owner, { title: 'Scripts', objective: 'Classify scripts', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const propose = checks => runtime.propose(owner, mission.id, { workstreamId: stream.id, title: 'Fix', objective: 'Implement change',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks })
  assert.throws(() => propose(['npm run smoke']), error => {
    assert.match(error.message, /\[check_requires_host\]/)
    assert.match(error.message, /"smoke"/, 'the refusal names the script')
    assert.match(error.message, /smoke-web\.mjs/, 'the refusal names the resolved body')
    return true
  })
  assert.throws(() => propose(['npm run chain']), /\[check_requires_host\]/, 'a script that chains a host-only script is refused too')
  assert.equal(propose(['npm run unit']).checks[0], 'npm run unit', 'a worker-runnable script is admitted')
  assert.equal(propose(['node --test tests/*.test.mjs']).checks[0], 'node --test tests/*.test.mjs')
})
