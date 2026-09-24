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
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { classifyCheck, loadPackageScripts } from '../lib/admission.js'
import { FakeWorkers, makeRuntime } from './faults/harness.mjs'

test('target script and file names alone never deny admission', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const [name, body] of Object.entries(manifest.scripts)) {
    assert.equal(classifyCheck(`npm run ${name}`, manifest.scripts).runnable, 'worker', `${name} (${body})`)
    assert.equal(classifyCheck(`npm run ${name}`).runnable, 'worker')
  }
  assert.equal(classifyCheck('node scripts/smoke-web.mjs').runnable, 'worker')
})

test('R11-06: runtime.propose refuses a host-only body behind a neutral script name', async t => {
  const { dir: directory, runtime, budget } = await makeRuntime(t, {
    workers: new FakeWorkers({ async prepareWorkspace(mission, id) { return join(mission.workspace, id) } }),
    config: { tickMs: 60000, maxMessageChars: 10000, maxEvents: 200, checkTimeoutMs: undefined },
    budget: { maxTokens: 100000, maxSteps: 200, maxTasks: 20 },
  })
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'host-scripts-fixture', private: true,
    scripts: { smoke: 'sandbox-exec -p rule node --test', unit: 'node --test tests/*.test.mjs', chain: 'npm run smoke' },
  }))
  assert.deepEqual(Object.keys(loadPackageScripts(directory) ?? {}), ['smoke', 'unit', 'chain'])
  const owner = { sessionId: 'host-scripts-owner' }
  const mission = runtime.create(owner, { title: 'Scripts', objective: 'Classify scripts', workspace: directory, scope: ['src/'], acceptance: ['works'], budget })
  const stream = runtime.workstream(owner, mission.id, { title: 'Main', objective: 'Main' })
  const propose = checks => runtime.propose(owner, mission.id, { outputs: [], workstreamId: stream.id, title: 'Fix', objective: 'Implement change',
    kind: 'implementation', scope: ['src/'], acceptance: ['works'], checks })
  assert.throws(() => propose(['npm run smoke']), error => {
    assert.match(error.message, /\[check_requires_host\]/)
    assert.match(error.message, /"smoke"/, 'the refusal names the script')
    assert.match(error.message, /sandbox-exec/, 'the refusal names the resolved body')
    return true
  })
  assert.throws(() => propose(['npm run chain']), /\[check_requires_host\]/, 'a script that chains a host-only script is refused too')
  assert.equal(propose(['npm run unit']).checks[0], 'npm run unit', 'a worker-runnable script is admitted')
  assert.equal(propose(['node --test tests/*.test.mjs']).checks[0], 'node --test tests/*.test.mjs')
})
