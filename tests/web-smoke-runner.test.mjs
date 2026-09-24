/**
 * scripts/web-smoke-browser.mjs run for real, --serve-only, from a scratch copy
 * of the smoke scripts against a fake Harness (tests/fixtures/fake-host.mjs as
 * its CLI, a throwaway git checkout whose commit the copy's compatibility.json
 * declares): no dsh, no browser, no live host, and only an ephemeral port.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withLocalImports } from './fixtures/local-imports.mjs'
import { trackOwnerCatalog } from '../scripts/web-smoke-browser.mjs'

const project = fileURLToPath(new URL('../', import.meta.url))

/** A scratch project holding copies of the smoke scripts, and a fake Harness it supports. */
async function scene(t) {
  const root = mkdtempSync(join(tmpdir(), 'web-smoke-runner-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const harness = join(root, 'harness')
  mkdirSync(join(harness, 'apps/cli/lib'), { recursive: true })
  mkdirSync(join(harness, 'apps/web/dist'), { recursive: true })
  copyFileSync(fileURLToPath(new URL('./fixtures/fake-host.mjs', import.meta.url)), join(harness, 'apps/cli/lib/bin.js'))
  writeFileSync(join(harness, 'apps/web/dist/index.html'), '')
  writeFileSync(join(harness, 'package.json'), JSON.stringify({ version: '0.0.0-fake' }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.invalid', ...args], { cwd: harness, encoding: 'utf8' }).trim()
  git('init', '--quiet'); git('add', '.'); git('commit', '--quiet', '-m', 'fake harness')
  const copy = join(root, 'project')
  for (const entry of ['scripts/smoke-web.mjs', 'scripts/smoke-command-web.mjs']) {
    for (const [path, source] of Object.entries(await withLocalImports(project, entry))) { mkdirSync(dirname(join(copy, path)), { recursive: true }); writeFileSync(join(copy, path), source) }
  }
  for (const entry of ['package.json', 'lib', 'tests']) symlinkSync(join(project, entry), join(copy, entry))
  writeFileSync(join(copy, 'compatibility.json'), JSON.stringify({ supportedHosts: [{ version: '0.0.0-fake', commit: git('rev-parse', 'HEAD') }] }))
  const artifacts = join(root, 'artifacts')
  return {
    artifacts,
    /** Run a smoke --serve-only until its host is ready, then stop it as a user would; resolves with the ready line and the exit. */
    serveOnly(script, env = {}) {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [join(copy, 'scripts', script), '--serve-only'], {
          env: { ...process.env, HOME: join(root, 'home'), TMPDIR: root, DSH_HARNESS_ROOT: harness, DSH_WEB_SMOKE_ARTIFACTS: artifacts, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = '', stderr = '', ready
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${script} --serve-only never became ready:\n${stdout}${stderr}`)) }, 60_000)
        child.stdout.on('data', chunk => {
          stdout += chunk
          const line = stdout.split('\n').find(text => text.includes('"baseUrl"'))
          if (line && !ready) {
            ready = JSON.parse(line)
            // The runner starts waiting for the signal once it has also written latest-server.json.
            const stop = () => existsSync(join(artifacts, 'latest-server.json')) ? setTimeout(() => child.kill('SIGINT'), 300) : setTimeout(stop, 50)
            stop()
          }
        })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ ready, code, signal, stderr }) })
      })
    },
  }
}

test('a --serve-only run labels its report serve-only, never as the full scenario it did not run', async t => {
  const s = await scene(t)
  const run = await s.serveOnly('smoke-web.mjs')
  assert.equal(run.code, 0, run.stderr)
  assert.ok(run.ready, run.stderr)
  const report = JSON.parse(readFileSync(join(s.artifacts, 'report.json'), 'utf8'))
  assert.equal(report.scenario, 'serve-only')
  assert.deepEqual(report.checks, [])
})

test('the command smoke gives the host a manual default below the generated allowance, so a clamp to it fails the budget assertion', async t => {
  const s = await scene(t)
  const run = await s.serveOnly('smoke-command-web.mjs', { DSH_SMOKE_KEEP: '1' })
  assert.equal(run.code, 0, run.stderr)
  const patch = JSON.parse(readFileSync(join(run.ready.root, 'smoke.patch.yml'), 'utf8'))
  const { defaultBudget } = patch.find(row => row.id === 'dsh-external-agent-swarm').config
  assert.ok(defaultBudget, 'the command smoke configures the plugin\'s manual default')
  // The allowance the scripted owner generates (tests/fixtures/web-scripted-llm.mjs), which the smoke asserts exactly.
  const generated = { maxTokens: 120_000, maxSteps: 60, maxWorkers: 2, maxDurationMs: 180_000, maxTasks: 8, maxExperiments: 2 }
  const clamped = Object.fromEntries(Object.entries(generated).map(([key, value]) => [key, Math.min(value, defaultBudget[key])]))
  assert.notDeepEqual(clamped, generated, 'a launch that clamps the generated allowance to the manual default must fail the smoke\'s deepEqual')
  assert.notEqual(defaultBudget.maxTokens, generated.maxTokens, 'and replacing it with the manual default must fail its notEqual')
})

/** A page that replays recorded native RPC responses to the runner's listeners. */
function replayPage() {
  const listeners = []
  return {
    on(event, listener) { if (event === 'response') listeners.push(listener) },
    async respond(method, args, result) {
      const response = {
        url: () => `http://127.0.0.1:1/api/${method}`,
        request: () => ({ postData: () => JSON.stringify({ type: 'client-request', method, payload: { args } }) }),
        json: async () => ({ type: 'server-response', result }),
      }
      await Promise.all(listeners.map(listener => listener(response)))
    },
  }
}

test('the web scenarios start only once the selected workspace\'s session has its command catalog, not the default workspace\'s', async () => {
  // The RPC order of a 0.1.7-rc.1 command-web run that failed under load: the runner
  // typed "/agent-sw" after the default workspace's catalog loaded but before the
  // selected workspace's session existed, and the "/" was lost in the switch.
  const workspace = '/private/tmp/smoke/workspace'
  const page = replayPage()
  const ready = trackOwnerCatalog(page, workspace)
  const catalog = { ok: true, value: [{ name: 'agent-swarm', description: 'Start an agent swarm' }] }
  await page.respond('workspace/initializeDefault', {}, { ok: true, value: { workspace: { workspaceId: 'default', path: '/Users/someone/Documents' } } })
  await page.respond('session/create', { request: { workspaceId: 'default' } }, { ok: true, value: { sessionId: 'session-default' } })
  await page.respond('commands/list', { agentId: 'session-default' }, catalog)
  await page.respond('workspace/create', { path: workspace }, { ok: true, value: { workspace: { workspaceId: 'selected', path: workspace } } })
  assert.equal(ready(), false, 'the default workspace\'s catalog is not the owner\'s (the failed run typed here)')
  await page.respond('session/create', { request: { workspaceId: 'selected' } }, { ok: true, value: { sessionId: 'session-selected' } })
  assert.equal(ready(), false, 'a session without its catalog is not ready')
  await page.respond('commands/list', { agentId: 'session-selected' }, { ok: false, error: { code: 'x', message: 'not open' } })
  assert.equal(ready(), false, 'a failed catalog load is not ready')
  await page.respond('commands/list', { agentId: 'session-selected' }, catalog)
  assert.equal(ready(), true)
})
