import { authenticatedLaunchUrl, publicBaseUrl, publicFailure, redactWebSecrets, openAuthenticatedWeb, selectWebWorkspace, composerFor, isolateWebModelFixture, writeComposerDraft } from './web-smoke-browser.mjs'
import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
import { assertSimplifiedSwarm, observedSwarmState, openSwarmDetails } from './swarm-smoke-checks.mjs'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const harnessRoot = resolveHarnessRoot()
const bin = join(harnessRoot, 'apps/cli/lib/bin.js')
await access(join(harnessRoot, 'apps/web/dist/index.html'))
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-swarm-web-')))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const tracePath = join(root, 'model-trace.jsonl')
const releasePath = join(root, 'release-workers')
const artifacts = resolve(process.env.DSH_WEB_SMOKE_ARTIFACTS ?? join(project, 'artifacts/sidebar'))
const env = {
  ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(root, 'agents-home'),
  DSH_BUNDLED_SKILL_DIR: join(root, 'bundled-skills'), DSH_TELEMETRY_DISABLED: '1',
  COREPACK_ENABLE_NETWORK: '0', npm_config_registry: 'http://127.0.0.1:9',
}
delete env.DEEPSEEK_API_KEY
delete env.DEEPSEEK_BASE_URL
let child
let browser
let page
let output = ''
let failure
let build
const started = Date.now()
let validatedAt
const checks = []
const rpcResults = []

async function writeReport() {
  const modelTrace = await readFile(tracePath, 'utf8')
  const events = modelTrace.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({
    modelBoundary: 'Scripted LLM adapter only; actual CLI web product, browser, native transport, worker lifecycle and sandbox tools.',
    modelRequests: events.filter(event => event.type === 'model/request').length,
    toolCalls: events.filter(event => event.type === 'tool/call').length,
    passed: !failure, scenario: process.argv.includes('--serve-only') ? 'serve-only' : process.argv.includes('--boot-only') ? 'boot-only' : process.argv.includes('--stage-only') ? 'stage-only' : 'full',
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
  ]) await execute('git', args, { cwd: workspace })
  const compatibility = JSON.parse(await readFile(join(project, 'compatibility.json'), 'utf8'))
  const harnessHead = (await execute('git', ['rev-parse', 'HEAD'], { cwd: harnessRoot })).stdout.trim()
  assertSupportedHarness(harnessRoot)
  await execute(process.execPath, [
    bin, 'plugin', '--profile', 'web', 'add', `link:${project}`, '--offline', '--ignore-scripts', '--store-dir', join(root, 'pnpm-store'),
  ], { cwd: workspace, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
  const profile = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'))
  assert(profile.dsh.profile.bundles.includes('@dsh-external/dsh-agent-swarm'))
  await writeFile(join(home, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: "2026-08-13.1"\n')
  const modelFixture = await isolateWebModelFixture(root, project, 'web-scripted-llm.mjs')
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
      { id: 'swarm-web-llm', name: modelFixture, config: { harnessRoot, workspace, tracePath, releasePath } },
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
  const baseUrl = publicBaseUrl(launchUrl)
  await until(async () => { try { return (await fetch(baseUrl)).status === 401 } catch { return false } }, 'protected web HTTP readiness')
  process.stdout.write(JSON.stringify({ baseUrl, root, workspace, pid: process.pid, profile: 'web', plugin: '@dsh-external/dsh-agent-swarm' }) + '\n')
  await writeFile(join(artifacts, 'latest-server.json'), JSON.stringify({ baseUrl, root, workspace, pid: process.pid }, null, 2) + '\n')
  if (process.argv.includes('--serve-only')) {
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  } else {
    const { chromium } = await import(pathToFileURL(join(harnessRoot, 'apps/web/node_modules/playwright/index.mjs')).href)
    const browserChannel = process.env.DSH_SMOKE_BROWSER ?? 'chrome'
    browser = await chromium.launch({ headless: true, ...(browserChannel === 'chromium' ? {} : { channel: browserChannel }) })
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    const pageErrors = []
    let latestState
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('response', async response => {
      const endpoint = new URL(response.url()).pathname
      if (!endpoint.startsWith('/agent-swarm/')) return
      try {
        const body = await response.json()
        rpcResults.push({ endpoint, ...body.result })
        if (body.result?.ok) latestState = observedSwarmState(latestState, endpoint, body.result.value) ?? latestState
      } catch { /* A cancelled navigation response does not overwrite the last observed state. */ }
    })
    async function clickRpc(locator, endpoint) {
      const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === `/agent-swarm/${endpoint}` && response.request().method() === 'POST'),
        locator.click(),
      ])
      assert.equal(response.status(), 200)
      const result = (await response.json()).result
      assert.equal(result.ok, true, `native ${endpoint} RPC failed: ${JSON.stringify(result)}`)
      return result.value
    }
    await openAuthenticatedWeb(page, launchUrl, checks)
    assert((await page.evaluate(() => JSON.stringify(window.__DSH_BOOT__))).includes('@dsh-external/dsh-agent-swarm'), 'actual server must publish the external browser bundle in its boot graph')
    await selectWebWorkspace(page, workspace)
    const composer = composerFor(page)
    if (process.argv.includes('--boot-only')) {
      await writeComposerDraft(page, composer, 'Connect the actual web model loop.')
      await composer.press('Enter')
      await page.getByText('The real web model loop is connected.', { exact: true }).waitFor({ timeout: 30_000 })
      checks.push('actual CLI profile, browser bundle, workspace picker, session transport, model loop')
      await page.screenshot({ path: join(artifacts, 'actual-web-boot.png'), fullPage: true })
      await writeFile(join(artifacts, 'actual-web-boot.aria.txt'), await page.locator('body').ariaSnapshot())
    } else {
      await writeComposerDraft(page, composer, 'Prepare a staged swarm for browser validation. Change value.cjs to two and have an independent reviewer verify it.')
      await composer.press('Enter')
      await page.getByText('Draft ready for review. Edit the workers and launch when ready.', { exact: true }).waitFor({ timeout: 30_000 })
      if (process.argv.includes('--stage-only')) {
        const events = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
        const ownerSessionId = events.find(event => event.type === 'owner/session').sessionId
        assert(events.some(event => event.type === 'tool/call' && event.name === 'swarm_stage'))
        assert(!events.some(event => event.type === 'fixture/error'))
        assert(events.filter(event => event.type === 'model/request').every(event => event.sessionId === ownerSessionId))
        const state = await page.evaluate(async sessionId => {
          const response = await fetch('/agent-swarm/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            type: 'client-request', rpcId: 'web-smoke-read-only', method: 'state', payload: { sessionId },
          }) })
          return (await response.json()).result
        }, ownerSessionId)
        assert.equal(state.ok, true)
        assert.equal(state.value.drafts.length, 1)
        assert.equal(state.value.snapshots.length, 0, 'staging must not launch a mission')
        checks.push('real browser model swarm_stage creates editable draft without worker execution; native read-only RPC confirms state')
        await page.screenshot({ path: join(artifacts, 'stage-only.png'), fullPage: true })
      } else {
      const panel = page.locator('[data-swarm-panel]')
      const dock = page.locator('[data-swarm-dock]')
      const shell = page.locator('#root')
      if (!await panel.isVisible()) await page.locator('[data-swarm-launcher]').click()
      await panel.waitFor()
      await until(() => latestState?.drafts.length === 1, 'staged draft visible through native state transport')
      assert.equal(latestState.snapshots.length, 0, 'staging a plan must not create an executing mission')
      const stagedTrace = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      const stagedOwner = stagedTrace.find(event => event.type === 'owner/session').sessionId
      assert(stagedTrace.filter(event => event.type === 'model/request').every(event => event.sessionId === stagedOwner), 'workers must not execute before browser launch')
      checks.push('model-staged topology is visible before launch with no worker execution')
      await assertSimplifiedSwarm(panel)
      await openSwarmDetails(panel, 'editor')
      checks.push('default staged view hides technical tabs, budgets and manual plan fields until its advanced disclosure is opened')
      await page.getByTestId('draft-title').fill('Unsaved sidebar draft')
      await until(async () => {
        const box = await dock.boundingBox()
        const main = await shell.boundingBox()
        return box && main && box.y === 0 && Math.abs(box.height - 1000) <= 1 && Math.abs(box.x + box.width - 1440) <= 1 && main.x + main.width <= box.x + 1
      }, 'right sidebar docks at full viewport height and reserves conversation space')
      assert(await page.locator('body[data-swarm-docked]').count(), 'the native shell must be marked while sidebar space is reserved')
      const originalBox = await dock.boundingBox()
      await dock.getByRole('separator', { name: 'Resize sidebar', exact: true }).focus()
      await page.keyboard.press('ArrowLeft')
      await until(async () => (await dock.boundingBox()).width > originalBox.width, 'left edge keyboard resize increases sidebar width')
      const enlargedBox = await dock.boundingBox()
      await page.keyboard.press('ArrowLeft')
      await until(async () => (await dock.boundingBox()).width > enlargedBox.width, 'second left edge resize increases sidebar width')
      const widestBox = await dock.boundingBox()
      await page.keyboard.press('ArrowRight')
      await until(async () => (await dock.boundingBox()).width < widestBox.width, 'right arrow shrinks the sidebar')
      const resizedBox = await dock.boundingBox()
      const dockedShellBox = await shell.boundingBox()
      assert(dockedShellBox.x + dockedShellBox.width <= resizedBox.x + 1, 'resizing must continue to reserve non-overlapping conversation space')
      await panel.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      await until(async () => !await panel.isVisible() && (await shell.boundingBox()).width > dockedShellBox.width, 'collapsing restores conversation width')
      const launcher = page.locator('[data-swarm-launcher]')
      assert.equal(await launcher.getAttribute('aria-label'), 'Open swarm sidebar')
      const launcherBox = await launcher.boundingBox()
      assert(launcherBox.width <= 60, 'collapsed sidebar toggle must occupy a slim rail')
      await launcher.click()
      await until(async () => {
        const box = await dock.boundingBox()
        const main = await shell.boundingBox()
        return box && main && Math.abs(box.width - resizedBox.width) <= 1 && main.x + main.width <= box.x + 1
      }, 'reopening preserves sidebar width and restores reserved conversation space')
      assert.equal(await page.getByTestId('draft-title').inputValue(), 'Unsaved sidebar draft', 'collapse and reopen must preserve unsaved plan edits')
      checks.push('full-height right sidebar reserves conversation space; accessible resizing, collapse and reopen preserve width and unsaved plan edits')
      await page.getByTestId('draft-title').fill('Browser-confirmed delivery')
      await page.locator('[data-testid="worker-model-builder"]').selectOption(JSON.stringify(['deepseek-official', 'swarm-web-review']))
      await page.getByRole('combobox', { name: 'builder Reasoning', exact: true }).selectOption('high')
      const saved = await clickRpc(page.locator('[data-action="save-draft"]'), 'update-draft')
      assert.equal(saved.draft.input.title, 'Browser-confirmed delivery')
      assert.equal(saved.draft.input.members.find(member => member.key === 'builder').model, 'swarm-web-review')
      assert.equal(saved.draft.input.members.find(member => member.key === 'builder').reasoningEffort, 'high')
      checks.push('model-staged draft edited and saved through native browser RPC; worker model and reasoning choice persisted')
      await page.screenshot({ path: join(artifacts, 'draft.png'), fullPage: true })
      const launched = await clickRpc(page.locator('[data-action="launch-draft"]'), 'launch-draft')
      const missionId = launched.snapshot.mission.id
      const ownerSessionId = launched.snapshot.mission.ownerSessionId
      const builder = launched.snapshot.members.find(member => member.name === 'builder')
      const reviewer = launched.snapshot.members.find(member => member.name === 'reviewer')
      assert(builder && reviewer)
      await until(() => latestState?.snapshots.some(snapshot => snapshot.mission.id === missionId && snapshot.tasks.some(task => task.status === 'running')), 'live running assignment in browser transport')
      const paused = await clickRpc(page.locator('[data-action="pause"]'), 'control')
      assert.equal(paused.snapshot.mission.status, 'paused')
      await panel.locator('[data-swarm-status="paused"]').waitFor()
      await page.locator('[data-action="resume"]').waitFor()
      await page.screenshot({ path: join(artifacts, 'paused.png'), fullPage: true })
      await writeFile(releasePath, 'release deterministic model responses\n')
      const resumed = await clickRpc(page.locator('[data-action="resume"]'), 'control')
      assert.equal(resumed.snapshot.mission.status, 'active')
      checks.push('live mission Pause/Resume controls, cancellation and reassignment')
      await until(() => latestState?.snapshots.find(snapshot => snapshot.mission.id === missionId)?.tasks.every(task => task.status === 'accepted'), 'live accepted task state without owner swarm_observe', 45_000)
      // Live sessions can use the native conversation selector before mission disposal.
      await openSwarmDetails(panel, 'team')
      await page.locator(`[data-worker-session="${builder.sessionId}"]`).click()
      await until(() => latestState?.ownerSessionId === builder.sessionId && latestState.writable === false, 'native active worker conversation navigation and read-only swarm view')
      await panel.getByText('Mission controls are read-only in worker conversations. Open the owner conversation to manage this mission.', { exact: true }).waitFor()
      await page.getByText('Assignment finished; awaiting further work.', { exact: true }).first().waitFor()
      await page.screenshot({ path: join(artifacts, 'worker-conversation.png'), fullPage: true })
      assert.equal(await panel.locator('[data-action="complete"]').count(), 0, 'worker view must not expose mission mutation controls')
      checks.push('active worker conversation opened through native navigation with read-only swarm context')
      const sessions = page.getByRole('tree', { name: 'Sessions', exact: true })
      if (!await sessions.isVisible()) await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
      await sessions.getByRole('treeitem', { name: /^Prepare a staged swarm for / }).click()
      await until(() => latestState?.ownerSessionId === ownerSessionId && latestState.writable === true, 'native sidebar returns to the owner conversation')
      await openSwarmDetails(panel, 'technical')
      const completed = await clickRpc(page.locator('[data-action="complete"]'), 'control')
      assert.equal(completed.snapshot.mission.status, 'completed')
      await panel.locator('[data-swarm-status="completed"]').waitFor()
      assert(completed.snapshot.evidence.every(evidence => evidence.status === 'verified'))
      const artifact = completed.snapshot.tasks.find(task => task.kind === 'integration').artifact
      assert.equal((await execute('git', ['show', `${artifact.commit}:value.cjs`], { cwd: workspace })).stdout, 'module.exports = 2\n')
      assert.equal(await readFile(join(workspace, 'value.cjs'), 'utf8'), 'module.exports = 1\n')
      checks.push('actual sandboxed worker tools, host evidence, independent verification and immutable artifact')
      await page.screenshot({ path: join(artifacts, 'completed.png'), fullPage: true })
      await writeFile(join(artifacts, 'completed.aria.txt'), await page.locator('body').ariaSnapshot())
      await openSwarmDetails(panel, 'technical')
      await panel.getByRole('tab', { name: 'Dependency graph', exact: true }).click()
      await panel.getByRole('tabpanel', { name: 'Dependency graph', exact: true }).waitFor()
      await page.screenshot({ path: join(artifacts, 'dependency-graph.png'), fullPage: true })
      await writeFile(join(artifacts, 'dependency-graph.aria.txt'), await panel.ariaSnapshot())
      checks.push('dependency graph tab exposes its correctly named accessible tabpanel')
      await panel.getByRole('tab', { name: 'Work board', exact: true }).click()
      await panel.getByRole('tabpanel', { name: 'Work board', exact: true }).waitFor()
      await page.setViewportSize({ width: 390, height: 844 })
      const collapseNavigation = page.locator('button[aria-label="Collapse sidebar"]:not([data-swarm-dock] button)')
      if (await collapseNavigation.isVisible()) await collapseNavigation.click()
      await until(async () => {
        const box = await dock.boundingBox()
        const main = await shell.boundingBox()
        return box && main && Math.abs(box.x) <= 1 && Math.abs(box.width - 390) <= 1 && Math.abs(box.y + box.height - 844) <= 1 && Math.abs(box.height - 844 * 0.45) <= 2 && main.y + main.height <= box.y + 1
      }, 'at 390px the sidebar occupies a lower row without covering the conversation')
      await page.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: true })
      checks.push('390px layout places swarm in a full-width lower row and preserves the visible conversation above it')
      await page.setViewportSize({ width: 1440, height: 1000 })
      await until(async () => {
        const box = await dock.boundingBox()
        const main = await shell.boundingBox()
        return box && main && Math.abs(box.width - resizedBox.width) <= 1 && box.y === 0 && main.x + main.width <= box.x + 1
      }, 'desktop sidebar width restored after responsive layout')
      const trace = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert(!trace.some(event => event.type === 'fixture/error'), 'model fixture must not hide tool errors')
      assert(trace.some(event => event.type === 'tool/call' && event.sessionId === builder.sessionId && event.name === 'bash'))
      assert(trace.some(event => event.type === 'tool/call' && event.sessionId === reviewer.sessionId && event.name === 'swarm_verify'))
      assert(!trace.some(event => event.type === 'tool/call' && event.sessionId === ownerSessionId && event.name === 'swarm_observe'), 'browser state must update without an owner model observation')
      assert(trace.filter(event => event.type === 'model/request' && event.sessionId === builder.sessionId).every(event => event.model === 'swarm-web-review'), 'launched worker must actually use the browser-selected model')
      assert(trace.filter(event => event.type === 'model/request' && event.sessionId === builder.sessionId).every(event => event.reasoningEffort === 'high'), 'launched worker must actually use the browser-selected reasoning effort')
      checks.push('live board updates without owner observation; selected model and reasoning used by actual worker loop')
      // A second bounded plan covers Stop without replacing the completed deliverable above.
      await rm(releasePath)
      await panel.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      const messageBox = composerFor(page)
      await writeComposerDraft(page, messageBox, 'Prepare a staged swarm for browser validation. This second mission is for the Stop control check.')
      await messageBox.press('Enter')
      if (!await panel.isVisible()) await page.locator('[data-swarm-launcher]').click()
      await until(() => latestState?.drafts.find(draft => draft.status === 'draft' && draft.id !== saved.draft.id), 'second model-staged draft')
      const secondDraft = latestState.drafts.find(draft => draft.status === 'draft' && draft.id !== saved.draft.id)
      await panel.getByRole('combobox', { name: 'Missions', exact: true }).selectOption(`draft:${secondDraft.id}`)
      await openSwarmDetails(panel, 'editor')
      const secondLaunch = await clickRpc(page.locator('[data-action="launch-draft"]'), 'launch-draft')
      assert.notEqual(secondLaunch.snapshot.mission.id, missionId)
      await openSwarmDetails(panel, 'technical')
      await page.locator('[data-action="stop"]').click()
      const stopped = await clickRpc(page.locator('[data-action="stop"]'), 'control')
      assert.equal(stopped.snapshot.mission.status, 'stopped')
      await panel.locator('[data-swarm-status="stopped"]').waitFor()
      await page.screenshot({ path: join(artifacts, 'stopped.png'), fullPage: true })
      checks.push('confirmed Stop control cancels a separately staged mission')
      await panel.getByRole('combobox', { name: 'Missions', exact: true }).selectOption(`mission:${missionId}`)
      const beforeHistory = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      const workerRequests = events => events.filter(event => event.type === 'model/request' && [builder.sessionId, reviewer.sessionId].includes(event.sessionId)).length
      await openSwarmDetails(panel, 'team')
      await page.locator(`[data-worker-session="${builder.sessionId}"]`).click()
      const transcript = panel.locator(`[data-swarm-transcript="${builder.sessionId}"]`)
      await transcript.waitFor()
      await until(async () => (await transcript.innerText()).includes('VERIFIED_TWO'), 'persisted worker transcript contains the actual host tool output')
      assert.equal(latestState.ownerSessionId, ownerSessionId, 'cold history must leave the native owner conversation selected')
      await page.screenshot({ path: join(artifacts, 'completed-worker-history.png'), fullPage: true })
      await panel.locator('[data-action="close-transcript"]').click()
      const finalTrace = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      assert.equal(workerRequests(finalTrace), workerRequests(beforeHistory), 'viewing persisted history must not reactivate model workers')
      checks.push('completed worker transcript opens from native persisted history without model worker activation')
      assert.equal(finalTrace.filter(event => event.type === 'tool/call' && event.name === 'swarm_stage').length, 2, 'only the two explicit user requests may stage plans')
      }
    }
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
  }
} catch (error) {
  failure = publicFailure(error)
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
  await writeFile(join(artifacts, 'server.log'), redactWebSecrets(output))
  await writeReport()
  if (failure || process.env.DSH_SMOKE_KEEP === '1') process.stderr.write(`Retained web smoke: ${root}\n`)
  else await rm(root, { recursive: true, force: true })
}
