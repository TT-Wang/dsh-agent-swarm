import { authenticatedLaunchUrl, publicBaseUrl, publicFailure, redactWebSecrets, openAuthenticatedWeb, selectWebWorkspace, composerFor, isolateWebModelFixture, writeComposerDraft } from './web-smoke-browser.mjs'
import { resolveHarnessRoot, assertSupportedHarness } from './harness-target.mjs'
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
const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-swarm-command-web-')))
const home = join(root, 'home')
const workspace = join(root, 'workspace')
const tracePath = join(root, 'model-trace.jsonl')
const releasePath = join(root, 'release-workers')
const releasePlanningPath = join(root, 'release-planning')
const releaseRepairPath = join(root, 'release-repair')
const validationRepair = process.argv.includes('--validation-repair')
const artifacts = resolve(process.env.DSH_WEB_SMOKE_ARTIFACTS ?? join(project, validationRepair ? 'artifacts/validation-repair-web' : 'artifacts/command-web'))
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
    passed: !failure, scenario: validationRepair ? 'native-slash-command-validation-repair' : 'native-slash-command-auto-start',
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
  const modelFixture = await isolateWebModelFixture(root, project, 'command-web-scripted-llm.mjs')
  const patchPath = join(root, 'smoke.patch.yml')
  await writeFile(patchPath, JSON.stringify([
    { id: 'llm-deepseek', disabled: true },
    { id: 'session-title-llm', disabled: true },
    { id: 'directory-picker', disabled: true },
    { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'swarm-web-primary' } },
    { id: 'dsh-external-agent-swarm', config: { statePath: join(root, 'swarm.sqlite'), workspacesRoot: join(root, 'worktrees'), tickMs: 100,
      defaultBudget: { maxTokens: 50_000, maxSteps: 60, maxWorkers: 2, maxDurationMs: 180_000, maxTasks: 6, maxExperiments: 1 } } },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
      { id: 'swarm-web-llm', name: modelFixture, config: { harnessRoot, workspace, tracePath, releasePath, releasePlanningPath, releaseRepairPath, validationRepair } },
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
    let stateRevision = 0
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('response', async response => {
      const endpoint = new URL(response.url()).pathname
      if (!endpoint.startsWith('/agent-swarm/')) return
      try {
        const body = await response.json()
        rpcResults.push({ endpoint, ...body.result })
        if (endpoint === '/agent-swarm/state' && body.result?.ok) { latestState = body.result.value; stateRevision++ }
      } catch { /* A cancelled navigation response does not overwrite the last observed state. */ }
    })
    await openAuthenticatedWeb(page, launchUrl, checks)
    assert((await page.evaluate(() => JSON.stringify(window.__DSH_BOOT__))).includes('@dsh-external/dsh-agent-swarm'), 'actual server must publish the external browser bundle in its boot graph')
    await selectWebWorkspace(page, workspace)
    const composer = composerFor(page)
    const panel = page.locator('[data-swarm-panel]')
    const dock = page.locator('[data-swarm-dock]')
    const goal = '把 value.cjs 的导出值改为 2，不要修改 check.cjs。运行 node check.cjs，并安排独立审查。'
    await writeComposerDraft(page, composer, '/agent-sw')
    const candidate = page.getByRole('option').filter({ hasText: 'agent-swarm' })
    await candidate.waitFor({ timeout: 30_000 })
    assert.match(await candidate.innerText(), /自动组织智能体协作完成任务/)
    await page.screenshot({ path: join(artifacts, 'autocomplete.png'), fullPage: true })
    await candidate.click()
    assert.equal(await composer.innerText(), '/agent-swarm ')
    assert.match(await composer.evaluate(element => element.style.getPropertyValue('--dsh-composer-hint')), /描述你想完成的任务/)
    checks.push('native slash catalog advertises /agent-swarm and its natural-language input hint')
    await writeComposerDraft(page, composer, `/agent-swarm ${goal}`)
    await composer.press('Enter')
    // The model-only planning gate preserves a measurable planning phase; there
    // are no additional user sends, draft edits, or launch/control clicks.
    await panel.waitFor({ timeout: 30_000 })
    await until(() => latestState?.starts?.some(request => request.status === 'planning'), 'automatic request planning state in native RPC')
    assert.equal(latestState.snapshots.length, 0)
    assert.equal(latestState.drafts.length, 0)
    await page.locator('[data-swarm-command]').filter({ hasText: goal }).waitFor()
    const planningText = await panel.innerText()
    assert.match(planningText, /planning|Planning|规划/)
    await page.screenshot({ path: join(artifacts, 'planning.png'), fullPage: true })
    await writeFile(join(artifacts, 'planning.aria.txt'), await page.locator('body').ariaSnapshot())
    checks.push('one natural-language send opens the sidebar automatically and exposes durable planning before workers exist')
    await writeFile(releasePlanningPath, 'release scripted model planning only')
    if (validationRepair) {
      const readTrace = async () => (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      const rejected = await until(async () => (await readTrace()).find(event => event.type === 'owner/validation-error'), 'invalid plan returned structured repair guidance to the real owner model loop')
      assert.match(rejected.message, /scope\[0\]/)
      assert.match(rejected.message, /tasks\[0\]\.checks/)
      const before = stateRevision
      await until(() => stateRevision > before, 'fresh native sidebar state after rejected launch')
      assert.equal(latestState.snapshots.length, 0, 'invalid plan must create no mission or workers')
      assert.equal(latestState.drafts.length, 0, 'invalid plan must create no partial draft')
      assert.equal(latestState.starts.length, 1)
      assert.equal(latestState.starts[0].id, rejected.requestId)
      assert.equal(latestState.starts[0].status, 'planning', 'tool validation must remain recoverable within the original command')
      assert((await readTrace()).filter(event => event.type === 'model/request').every(event => event.sessionId === rejected.sessionId), 'no worker model can run before a valid plan exists')
      await page.screenshot({ path: join(artifacts, 'validation-repair.png'), fullPage: true })
      await writeFile(join(artifacts, 'rejected-state.json'), JSON.stringify({ error: rejected.message, state: latestState }, null, 2) + '\n')
      checks.push('one invalid model plan returns indexed scope and verification guidance while the same request stays planning with zero missions, workers or drafts')
      await writeFile(releaseRepairPath, 'release scripted owner inspection and repair only')
    }
    await until(() => latestState?.snapshots.some(snapshot => snapshot.mission.status === 'active' && snapshot.members.length === 2), 'validated plan automatically launches two actual workers', 60_000)
    const running = latestState.snapshots.find(snapshot => snapshot.mission.status === 'active')
    const missionId = running.mission.id
    assert.deepEqual(running.mission.budget, { maxTokens: 120_000, maxSteps: 60, maxWorkers: 2, maxDurationMs: 180_000, maxTasks: 8, maxExperiments: 2 }, 'the primary agent chooses every automatic mission allowance')
    assert.notEqual(running.mission.budget.maxTokens, latestState.defaultBudget.maxTokens, 'manual-plan defaults must not replace the generated allowance')
    assert.equal(latestState.starts.find(request => request.missionId === missionId)?.status, 'running')
    assert.equal(running.tasks.length, 2)
    const implementation = running.tasks.find(task => task.kind === 'integration')
    const review = running.tasks.find(task => task.kind === 'verification')
    assert.equal(review.reviewOf, implementation.id)
    if (validationRepair) {
      assert.equal(latestState.snapshots.length, 1)
      assert.equal(latestState.starts.length, 1)
      assert.deepEqual(running.mission.scope, ['value.cjs'], 'the repaired plan uses the actual discovered file without widening its scope')
      assert.deepEqual(implementation.scope, ['value.cjs'])
      assert.deepEqual(implementation.checks, ['node check.cjs'])
      assert(!(review.dependencies ?? []).includes(implementation.id), 'the review target belongs only in reviewOf after safe canonicalization')
      checks.push('a corrected launch on the same request creates exactly one two-member mission; the redundant review dependency is canonicalized and the actual check is retained')
    }
    assert(running.tasks.every(task => task.maxRecoveryAttempts === 3), 'task recovery limits come from the generated plan')
    assert(running.tasks.every(task => task.checkTimeoutMs === 30_000), 'the primary agent sets every task check deadline')
    assert.equal(running.members.length, 2)
    assert(running.members.every(member => member.maxOutputTokens === 4096), 'the primary agent chooses each worker response allowance')
    const dockBox = await dock.boundingBox()
    const shellBox = await page.locator('#root').boundingBox()
    assert(dockBox && shellBox && shellBox.x + shellBox.width <= dockBox.x + 1, 'automatic opening reserves native conversation space')
    await page.screenshot({ path: join(artifacts, 'running.png'), fullPage: true })
    checks.push('swarm_launch admits the complete topology and primary-agent-selected budget; no configuration, Save or Launch gesture')
    await writeFile(releasePath, 'release scripted worker model only')
    await until(() => latestState?.snapshots.some(snapshot => snapshot.mission.id === missionId && snapshot.mission.status === 'completed'), 'worker acceptance automatically completes the mission', 120_000)
    await until(() => latestState?.snapshots.find(snapshot => snapshot.mission.id === missionId)?.members.every(member => member.status !== 'working'), 'completed workers settle to non-working durable status', 30_000)
    const completed = latestState.snapshots.find(snapshot => snapshot.mission.id === missionId)
    assert(completed.tasks.every(task => task.status === 'accepted'))
    assert(completed.evidence.length > 0 && completed.evidence.every(evidence => evidence.status === 'verified'))
    assert.equal(latestState.starts.find(request => request.missionId === missionId)?.status, 'completed')
    assert.equal(completed.members.length, 2)
    const artifact = completed.tasks.find(task => task.kind === 'integration').artifact
    assert.equal((await execute('git', ['show', `${artifact.commit}:value.cjs`], { cwd: workspace })).stdout, 'module.exports = 2\n')
    assert.equal(await readFile(join(workspace, 'value.cjs'), 'utf8'), 'module.exports = 1\n')
    await panel.locator('[data-swarm-status="completed"]').waitFor()
    await page.locator('[data-swarm-command]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, 'completed.png'), fullPage: true })
    await panel.getByRole('tab', { name: 'Dependency graph', exact: true }).click()
    await panel.getByRole('tabpanel', { name: 'Dependency graph', exact: true }).waitFor()
    await page.screenshot({ path: join(artifacts, 'dependency-graph.png'), fullPage: true })
    await writeFile(join(artifacts, 'completed.aria.txt'), await page.locator('body').ariaSnapshot())
    checks.push('real sandbox tools, immutable artifact, independent swarm_verify and automatic completed status require no manual Complete')
    const trace = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    const commandRuns = trace.filter(event => event.type === 'command/run' && event.data.name === 'agent-swarm')
    assert.equal(commandRuns.length, 1, 'exactly one user command is admitted')
    assert.equal(commandRuns[0].data.args.trim(), goal)
    const ownerId = commandRuns[0].sessionId
    assert.equal(trace.filter(event => event.type === 'tool/call' && event.name === 'swarm_launch').length, validationRepair ? 2 : 1)
    if (validationRepair) {
      const invalid = trace.filter(event => event.type === 'owner/invalid-plan')
      const repaired = trace.filter(event => event.type === 'owner/repair')
      const rejected = trace.filter(event => event.type === 'owner/validation-error')
      assert.equal(invalid.length, 1)
      assert.equal(repaired.length, 1)
      assert.equal(rejected.length, 1, 'exactly one expected error is handled by the model fixture; no tool error is silently swallowed')
      assert.equal(repaired[0].requestId, invalid[0].requestId)
      assert.equal(repaired[0].requestId, latestState.starts[0].id)
      assert.deepEqual(repaired[0].plan.budget, invalid[0].plan.budget, 'the model repair preserves all originally selected allowances')
      assert.deepEqual(repaired[0].plan.acceptance, invalid[0].plan.acceptance)
      assert.deepEqual(repaired[0].plan.tasks.map(task => task.acceptance), invalid[0].plan.tasks.map(task => task.acceptance))
      assert.deepEqual(completed.mission.budget, invalid[0].plan.budget)
      assert.deepEqual(completed.mission.acceptance, invalid[0].plan.acceptance)
      assert(completed.tasks.every(task => JSON.stringify(task.acceptance) === JSON.stringify(invalid[0].plan.acceptance)), 'host admission must preserve the generated acceptance criteria')
      assert.deepEqual(repaired[0].plan.tasks[1].dependencies, ['implement'], 'the scripted retry retains the redundant edge to test the actual host canonicalizer')
      assert(trace.some(event => event.type === 'tool/call' && event.name === 'bash' && event.sessionId === ownerId), 'the owner inspects real repository paths and check contents before repairing')
      assert.equal(latestState.snapshots.length, 1)
    }
    assert.equal(trace.filter(event => event.type === 'tool/call' && event.name === 'swarm_stage').length, 0)
    assert.equal(trace.filter(event => event.type === 'tool/call' && event.name === 'swarm_control').length, 0)
    assert(trace.some(event => event.type === 'tool/call' && event.name === 'bash' && event.sessionId !== ownerId))
    assert(trace.some(event => event.type === 'tool/call' && event.name === 'swarm_verify' && event.sessionId !== ownerId))
    assert(trace.filter(event => event.type === 'model/request' && event.sessionId !== ownerId).every(event => event.model === 'swarm-web-primary'), 'workers inherit the current conversation model without configuration')
    assert(trace.filter(event => event.type === 'model/request' && event.sessionId !== ownerId).every(event => event.maxTokens === 4096), 'real worker model requests carry the generated per-response allowance')
    assert(!trace.some(event => event.type === 'fixture/error'), 'the scripted provider must not conceal tool errors')
    assert(!rpcResults.some(result => ['/agent-swarm/create-draft', '/agent-swarm/update-draft', '/agent-swarm/launch-draft', '/agent-swarm/control'].includes(result.endpoint)), 'the browser must not secretly submit a manual draft or control flow')
    assert(trace.some(event => event.type === 'user/message' && event.sessionId === ownerId && event.sourceKind === 'swarm-start'))
    assert(!trace.some(event => event.type === 'user/message' && event.sessionId === ownerId && event.sourceKind === 'user'), 'planning guidance is attributed plugin context, never a forged user bubble')
    checks.push(validationRepair
      ? 'durable records prove one user command, an ordinary rejected tool call followed by one corrected launch with unchanged request identity, budgets and acceptance, and no manual lifecycle API calls'
      : 'durable command records prove one user command, one swarm_launch, attributed planning context and no manual lifecycle API calls')
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
