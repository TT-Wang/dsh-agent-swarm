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
