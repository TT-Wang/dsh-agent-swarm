import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
import { observedSwarmState } from './swarm-smoke-checks.mjs'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))

/** Keep the native launch credential only in memory, never in saved evidence. */
function redactWebSecrets(value) {
  return String(value).replace(/([?&]token=)[^\s)"'<>]+/g, '$1[REDACTED]')
}
export function authenticatedLaunchUrl(output) {
  return output.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s)]+/)?.[0]
}

/** Exchange the product's native launch token for its HttpOnly browser cookie. */
async function openAuthenticatedWeb(page, launchUrl, checks) {
  const baseUrl = new URL(launchUrl).origin
  assert.equal((await fetch(baseUrl)).status, 401, 'unauthenticated index stays protected')
  await page.goto(launchUrl, { waitUntil: 'load' })
  assert.equal(new URL(page.url()).searchParams.has('token'), false, 'native token exchange redirects to a clean URL')
  assert((await page.context().cookies(baseUrl)).some(cookie => cookie.httpOnly), 'native login issues an HttpOnly cookie')
  assert.equal((await page.request.get(baseUrl)).status(), 200, 'authenticated browser can fetch the native web app')
  checks.push('native launch authentication remains enabled: unauthenticated index401, token exchange, HttpOnly cookie, authenticated index200')
}

/** Current Harness has a resident Lexical contenteditable composer. */
export function composerFor(page) { return page.locator('[data-composer-input][contenteditable="true"]').first() }

async function selectWebWorkspace(page, workspace) {
  const trigger = page.getByRole('textbox', { name: 'Choose workspace', exact: true })
  const welcome = page.getByRole('button', { name: 'Continue', exact: true })
  await Promise.race([trigger.waitFor(), welcome.waitFor()])
  if (await welcome.isVisible()) await welcome.click()
  await trigger.click()
  const picker = page.getByRole('dialog', { name: 'Select Workspace Directory' })
  await picker.getByRole('button', { name: 'Edit path' }).click()
  const path = picker.getByRole('textbox', { name: 'Edit path' })
  await path.fill(workspace)
  await path.press('Enter')
  await picker.getByRole('button', { name: 'Open', exact: true }).click()
  await composerFor(page).waitFor()
}

/** Isolate the scripted Host adapter from the real browser plugin's package identity. */
async function isolateWebModelFixture(root) {
  const directory = join(root, 'scripted-model-fixture')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-swarm-web-test-model', version: '0.0.0', type: 'module' }))
  const helper = pathToFileURL(join(project, 'tests/fixtures/built-harness.mjs')).href
  const source = (await readFile(join(project, 'tests/fixtures/web-scripted-llm.mjs'), 'utf8')).replace("from './built-harness.mjs'", `from ${JSON.stringify(helper)}`)
  const entry = join(directory, 'index.mjs')
  await writeFile(entry, source)
  return pathToFileURL(entry).href
}

/** Mirror Harness's public browser-test gesture: Lexical must absorb selection between keys. */
export async function writeComposerDraft(page, input, text) {
  await input.and(page.locator('[contenteditable="true"]')).waitFor({ timeout: 15_000 })
  await input.click()
  await page.keyboard.press('ControlOrMeta+A')
  if (text === '') await page.keyboard.press('Backspace')
  else await page.keyboard.type(text)
}

/**
 * One browser smoke against the actual CLI web product with only the model scripted.
 * The runner owns the isolated DSH home and git fixture, the host process on a free
 * port, native login and workspace selection, the evidence report and teardown; a
 * smoke supplies its scenario.
 *
 * - `scriptedLlm`: config for tests/fixtures/web-scripted-llm.mjs beyond the paths
 *   supplied here (`owner` picks the owner script).
 * - `prepare(ctx)`: optional workspace changes after the baseline commit, before the host starts.
 * - `observe({ endpoint, value, state, response })`: optional hook on every successful
 *   /api/agent-swarm response, before `ctx.state` takes `state`.
 * - `report`: extra report.json fields; arrays in it are serialized when the report is written.
 * - `scenario(page, ctx)`: runs once the owner workspace is open. `ctx.state` is the
 *   latest state observed on the wire and `ctx.revision` counts its updates.
 *
 * `--serve-only` stops after the host is ready; `--keep-alive` keeps a verified host
 * until SIGINT or SIGTERM.
 */
export async function runWebSmoke({ name, scriptedLlm, prepare, observe, report = {}, scenario }) {
  const harnessRoot = resolveHarnessRoot()
  const bin = join(harnessRoot, 'apps/cli/lib/bin.js')
  await access(join(harnessRoot, 'apps/web/dist/index.html'))
  const root = await realpath(await mkdtemp(join(tmpdir(), `dsh-swarm-${name}-`)))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const tracePath = join(root, 'model-trace.jsonl')
  const artifacts = resolve(process.env.DSH_WEB_SMOKE_ARTIFACTS ?? join(project, 'artifacts', name))
  const env = {
    ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents-home'),
    DSH_BUNDLED_SKILL_DIR: join(root, 'bundled-skills'), DSH_TELEMETRY_DISABLED: '1',
    COREPACK_ENABLE_NETWORK: '0', npm_config_registry: 'http://127.0.0.1:9',
  }
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEEK_BASE_URL
  let child, browser, page, failure, build, validatedAt
  let output = ''
  const started = Date.now()
  const checks = []
  const rpcResults = []
  const parseTrace = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  const readTrace = async () => parseTrace(await readFile(tracePath, 'utf8'))

  async function writeReport() {
    const modelTrace = await readFile(tracePath, 'utf8')
    const events = parseTrace(modelTrace)
    await writeFile(join(artifacts, 'report.json'), JSON.stringify({
      modelBoundary: 'Scripted LLM adapter only; actual CLI web product, browser, native transport, worker lifecycle and sandbox tools.',
      modelRequests: events.filter(event => event.type === 'model/request').length,
      toolCalls: events.filter(event => event.type === 'tool/call').length,
      passed: !failure, scenario: name, ...report,
      ...(failure ? { failure: String(failure) } : {}), build, elapsedMs: (validatedAt ?? Date.now()) - started, checks, rpcResults,
    }, null, 2) + '\n')
    await writeFile(join(artifacts, 'model-trace.jsonl'), modelTrace)
    await writeFile(join(artifacts, 'server.log'), redactWebSecrets(output))
  }

  async function until(fn, label, timeout = 30_000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await fn()
      if (value) return value
      if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`DSH web exited (${child.exitCode}): ${redactWebSecrets(output.slice(-8000))}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`Timed out: ${label}\n${redactWebSecrets(output.slice(-8000))}`)
  }

  const ctx = {
    workspace, tracePath, artifacts, checks, rpcResults, until, readTrace, state: undefined, revision: 0,
    releasePath: join(root, 'release-workers'), releasePlanningPath: join(root, 'release-planning'), releaseRepairPath: join(root, 'release-repair'),
    git: async (...args) => (await execute('git', args, { cwd: workspace })).stdout,
  }
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(home, { recursive: true })
    await mkdir(artifacts, { recursive: true })
    await writeFile(tracePath, '')
    await writeFile(join(workspace, 'value.cjs'), 'module.exports = 1\n')
    await writeFile(join(workspace, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2); console.log('VERIFIED_TWO')\n")
    for (const args of [
      ['init', '--quiet'], ['config', 'user.name', 'Swarm Web Smoke'], ['config', 'user.email', 'swarm-smoke@example.invalid'],
      ['add', '.'], ['commit', '--quiet', '-m', 'fixture baseline'],
    ]) await ctx.git(...args)
    await prepare?.(ctx)
    const harnessHead = (await execute('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot })).stdout.trim()
    assertSupportedHarness(harnessRoot)
    await execute(process.execPath, [
      bin, 'plugin', '--profile', 'web', 'add', `link:${project}`, '--offline', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store'),
    ], { cwd: workspace, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
    const profile = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'))
    assert(profile.dsh.profile.bundles.includes('@dsh-external/dsh-agent-swarm'))
    await writeFile(join(home, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: "2026-08-13.1"\n')
    const modelFixture = await isolateWebModelFixture(root)
    const patchPath = join(root, 'smoke.patch.yml')
    await writeFile(patchPath, JSON.stringify([
      { id: 'llm-deepseek', disabled: true },
      { id: 'session-title-llm', disabled: true },
      { id: 'directory-picker', disabled: true },
      { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'swarm-web-primary' } },
      { id: 'dsh-external-agent-swarm', config: { statePath: join(root, 'swarm.sqlite'), workspacesRoot: join(root, 'worktrees'), tickMs: 100 } },
      { insert: [
        { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
        { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
        { id: 'swarm-web-llm', name: modelFixture, config: {
          harnessRoot, workspace, tracePath, releasePath: ctx.releasePath, releasePlanningPath: ctx.releasePlanningPath, releaseRepairPath: ctx.releaseRepairPath, ...scriptedLlm,
        } },
      ] },
    ], null, 2) + '\n')
    const builtFiles = (await readdir(join(project, 'lib'), { recursive: true })).filter(path => path.endsWith('.js')).sort()
    const digest = createHash('sha256')
    for (const path of builtFiles) { digest.update(path + '\0'); digest.update(await readFile(join(project, 'lib', path))) }
    build = { packageVersion: JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version, harnessHead, pluginJavaScriptSHA256: digest.digest('hex'), javaScriptFileCount: builtFiles.length }
    child = spawn(process.execPath, ['--expose-internals', bin, '--profile', 'web', '--patch', patchPath, '--port', '0', '--no-open'], {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const launchUrl = await until(() => authenticatedLaunchUrl(output), 'native authenticated dsh web launch URL', 90_000)
    const baseUrl = new URL(launchUrl).origin
    await until(async () => { try { return (await fetch(baseUrl)).status === 401 } catch { return false } }, 'protected web HTTP readiness')
    process.stdout.write(JSON.stringify({ baseUrl, root, workspace, pid: process.pid, profile: 'web', plugin: '@dsh-external/dsh-agent-swarm' }) + '\n')
    await writeFile(join(artifacts, 'latest-server.json'), JSON.stringify({ baseUrl, root, workspace, pid: process.pid }, null, 2) + '\n')
    if (process.argv.includes('--serve-only')) {
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
      return
    }
    const { chromium } = await import(pathToFileURL(join(harnessRoot, 'apps/web/node_modules/playwright/index.mjs')).href)
    const browserChannel = process.env.DSH_SMOKE_BROWSER ?? 'chrome'
    browser = await chromium.launch({ headless: true, ...(browserChannel === 'chromium' ? {} : { channel: browserChannel }) })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('response', async response => {
      const endpoint = new URL(response.url()).pathname
      if (!endpoint.startsWith('/api/agent-swarm/')) return
      try {
        const body = await response.json()
        rpcResults.push({ endpoint, ...body.result })
        if (!body.result?.ok) return
        const state = observedSwarmState(ctx.state, endpoint, body.result.value)
        observe?.({ endpoint, value: body.result.value, state, response })
        if (state) { ctx.state = state; ctx.revision++ }
      } catch { /* A cancelled navigation response does not overwrite the last observed state. */ }
    })
    await openAuthenticatedWeb(page, launchUrl, checks)
    assert((await page.evaluate(() => JSON.stringify(window.__DSH_BOOT__))).includes('@dsh-external/dsh-agent-swarm'), 'actual server must publish the external browser bundle in its boot graph')
    await selectWebWorkspace(page, workspace)
    await scenario(page, ctx)
    assert.deepEqual(pageErrors, [])
    validatedAt = Date.now()
    await writeReport()
    process.stdout.write(JSON.stringify({ passed: true, checks, build }) + '\n')
    if (process.argv.includes('--keep-alive')) {
      await browser.close()
      browser = undefined
      page = undefined
      process.stdout.write('Verified temporary web server remains available until this smoke receives SIGINT or SIGTERM.\n')
      await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
    }
  } catch (error) {
    failure = new Error(redactWebSecrets(error instanceof Error ? error.stack ?? error.message : error))
    if (page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
    if (page) await writeFile(join(artifacts, 'failure.aria.txt'), await page.locator('body').ariaSnapshot()).catch(() => {})
    throw failure
  } finally {
    await browser?.close()
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 10_000))])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    await writeReport()
    if (failure || process.env.DSH_SMOKE_KEEP === '1') process.stderr.write(`Retained web smoke: ${root}\n`)
    else await rm(root, { recursive: true, force: true })
  }
}
