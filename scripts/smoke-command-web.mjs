import assert from 'node:assert/strict'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { composerFor, runWebSmoke, writeComposerDraft } from './web-smoke-browser.mjs'
import { assertSimplifiedSwarm, openSwarmDetails } from './swarm-smoke-checks.mjs'

const validationRepair = process.argv.includes('--validation-repair')
const watchTimings = []
const stateRequests = []
const seenEvents = new Set()
const sampleEligible = new WeakMap()
let continuousObserver = false
let latestObserverRequest
let watchResponses = 0
let sourceHead
let sourceIndex

/** One /agent-swarm send plans, launches, verifies and completes a mission; the browser only applies the result. */
await runWebSmoke({
  name: validationRepair ? 'validation-repair-web' : 'command-web',
  scriptedLlm: { owner: 'command', validationRepair },
  // A manual-plan default below the generated allowance, so a generated field
  // clamped to it fails the budget assertion below.
  pluginConfig: { defaultBudget: { maxTokens: 50_000, maxSteps: 60, maxWorkers: 2, maxDurationMs: 180_000, maxTasks: 6, maxExperiments: 1 } },
  report: {
    watchTimingMethod: 'Each previously unseen mission/event sequence delivered in a delta on an uninterrupted observer is sampled once. Full snapshots, eventless deltas and the first response after interruption are excluded.',
    watchTimings,
  },
  /** Existing staged and untracked user work that the mission must neither capture nor disturb. */
  async prepare({ workspace, git }) {
    sourceHead = (await git('rev-parse', 'HEAD')).trim()
    await appendFile(join(workspace, 'check.cjs'), '// Existing staged user work\n')
    await git('add', 'check.cjs')
    await writeFile(join(workspace, 'user-notes.txt'), 'Existing untracked user work\n')
    sourceIndex = await readFile(join(workspace, '.git/index'))
  },
  observe({ endpoint, value, state, response }) {
    if (endpoint === '/api/agent-swarm/watch') watchResponses++
    if (!state) return
    const receivedAt = Date.now()
    // State reopens/reconnects and eventless lease updates are not
    // real-time latency samples. Each committed event is measured once.
    for (const snapshot of state.snapshots) for (const event of snapshot.events) {
      const key = `${snapshot.mission.id}:${event.seq}`
      if (!seenEvents.has(key) && sampleEligible.get(response.request()) && value.kind === 'delta') {
        watchTimings.push({ revision: value.revision, receivedAt, eventCreatedAt: event.createdAt,
          kind: 'delta', missionId: snapshot.mission.id, eventSeq: event.seq })
      }
      seenEvents.add(key)
    }
    if (response.request() === latestObserverRequest) continuousObserver = true
  },
  async scenario(page, ctx) {
    const { artifacts, checks, git, readTrace, releasePath, releasePlanningPath, releaseRepairPath, rpcResults, tracePath, until, workspace } = ctx
    page.on('request', request => {
      const endpoint = new URL(request.url()).pathname
      if (['/api/agent-swarm/state', '/api/agent-swarm/watch'].includes(endpoint)) {
        latestObserverRequest = request
        stateRequests.push({ endpoint, at: Date.now() })
        sampleEligible.set(request, endpoint === '/api/agent-swarm/watch' && continuousObserver)
      }
    })
    page.on('requestfailed', request => { if (request === latestObserverRequest) continuousObserver = false })
    const composer = composerFor(page)
    // The host's right sidebar carries the panel as a native tab; its footer launcher reopens it.
    const panel = page.locator('[data-swarm-panel]').filter({ visible: true })
    const launcher = page.locator('[data-swarm-native-launcher]')
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
    await until(() => ctx.state?.starts?.some(request => request.status === 'planning'), 'automatic request planning state in native RPC')
    assert.equal(ctx.state.snapshots.length, 0)
    assert.equal(ctx.state.drafts.length, 0)
    await page.locator('[data-swarm-command]').filter({ hasText: goal }).waitFor()
    const planningText = await panel.innerText()
    assert.match(planningText, /planning|Planning|规划/)
    await assertSimplifiedSwarm(panel)
    await page.screenshot({ path: join(artifacts, 'planning.png'), fullPage: true })
    await writeFile(join(artifacts, 'planning.aria.txt'), await page.locator('body').ariaSnapshot())
    checks.push('one natural-language send opens the sidebar automatically and exposes durable planning before workers exist')
    await writeFile(releasePlanningPath, 'release scripted model planning only')
    if (validationRepair) {
      const rejected = await until(async () => (await readTrace()).find(event => event.type === 'owner/validation-error'), 'invalid plan returned structured repair guidance to the real owner model loop')
      assert.match(rejected.message, /scope\[0\]/)
      assert.match(rejected.message, /tasks\[0\]\.checks/)
      const before = ctx.revision
      // A rejected plan has no committed mutation to wake an event watch.
      // Request an explicit read to verify that its durable state stayed empty.
      await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
      await until(() => ctx.revision > before, 'fresh native sidebar state after rejected launch')
      assert.equal(ctx.state.snapshots.length, 0, 'invalid plan must create no mission or workers')
      assert.equal(ctx.state.drafts.length, 0, 'invalid plan must create no partial draft')
      assert.equal(ctx.state.starts.length, 1)
      assert.equal(ctx.state.starts[0].id, rejected.requestId)
      assert.equal(ctx.state.starts[0].status, 'planning', 'tool validation must remain recoverable within the original command')
      assert((await readTrace()).filter(event => event.type === 'model/request').every(event => event.sessionId === rejected.sessionId), 'no worker model can run before a valid plan exists')
      await page.screenshot({ path: join(artifacts, 'validation-repair.png'), fullPage: true })
      await writeFile(join(artifacts, 'rejected-state.json'), JSON.stringify({ error: rejected.message, state: ctx.state }, null, 2) + '\n')
      checks.push('one invalid model plan returns indexed scope and verification guidance while the same request stays planning with zero missions, workers or drafts')
      await writeFile(releaseRepairPath, 'release scripted owner inspection and repair only')
    }
    await until(() => ctx.state?.snapshots.some(snapshot => snapshot.mission.status === 'active' && snapshot.members.length === 2), 'validated plan automatically launches two actual workers', 60_000)
    const running = ctx.state.snapshots.find(snapshot => snapshot.mission.status === 'active')
    const missionId = running.mission.id
    assert.deepEqual(running.mission.budget, { maxTokens: 120_000, maxSteps: 60, maxWorkers: 2, maxDurationMs: 180_000, maxTasks: 8, maxExperiments: 2 }, 'the primary agent chooses every automatic mission allowance')
    assert.notEqual(running.mission.budget.maxTokens, ctx.state.defaultBudget.maxTokens, 'manual-plan defaults must not replace the generated allowance')
    assert.equal(ctx.state.starts.find(request => request.missionId === missionId)?.status, 'running')
    assert.equal(running.tasks.length, 2)
    const implementation = running.tasks.find(task => task.kind === 'integration')
    const review = running.tasks.find(task => task.kind === 'verification')
    assert.equal(review.reviewOf, implementation.id)
    if (validationRepair) {
      assert.equal(ctx.state.snapshots.length, 1)
      assert.equal(ctx.state.starts.length, 1)
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
    const panelBox = await panel.boundingBox()
    const composerBox = await composer.boundingBox()
    assert(panelBox && composerBox && composerBox.x + composerBox.width <= panelBox.x + 1, 'automatic opening places the panel beside the conversation without covering its input')
    await assertSimplifiedSwarm(panel)
    await page.screenshot({ path: join(artifacts, 'running.png'), fullPage: true })
    checks.push('swarm_launch admits the complete topology and primary-agent-selected budget; no configuration, Save or Launch gesture')
    await until(() => ctx.state?.snapshots.find(snapshot => snapshot.mission.id === missionId)?.members.some(member => member.activity?.kind === 'model'), 'native worker stream exposes its actual pending model activity')
    await panel.locator('[data-swarm-current="model"]').waitFor()
    assert.match(await panel.locator('[data-swarm-current="model"]').innerText(), /Agent is thinking/)
    const currentActivity = ctx.state.snapshots.find(snapshot => snapshot.mission.id === missionId).members.find(member => member.activity?.kind === 'model').activity
    assert.equal(typeof currentActivity.id, 'string')
    assert(currentActivity.startedAt <= currentActivity.updatedAt)
    const elapsed = panel.locator('[data-swarm-elapsed]')
    const firstElapsed = await elapsed.innerText()
    await until(async () => (await elapsed.innerText()) !== firstElapsed, 'connected activity elapsed time advances from the real operation start', 3000)
    assert.equal(Number(await elapsed.getAttribute('data-swarm-elapsed')), currentActivity.startedAt)
    assert(watchTimings.some(item => item.receivedAt - item.eventCreatedAt < 1500), 'a new committed event must reach the browser through watch before the former two-second polling interval')
    await page.screenshot({ path: join(artifacts, 'thinking.png'), fullPage: true })
    checks.push('actual pending Harness model activity is visible with a real elapsed clock; watch includes a committed update below 1.5 seconds, with all timing samples retained and no latency guarantee')
    await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
    await until(async () => !await panel.isVisible(), 'collapsed sidebar is hidden')
    // Let a cancelled request settle, then complete actual worker activity while
    // no user-visible panel is subscribed. Native model execution keeps running.
    await new Promise(resolve => setTimeout(resolve, 250))
    const hiddenRequestCount = stateRequests.length
    await writeFile(releasePath, 'release scripted worker model only')
    await until(async () => (await readFile(tracePath, 'utf8')).includes('"name":"swarm_verify"'), 'workers continue to independent verification while the sidebar is hidden', 120_000)
    await new Promise(resolve => setTimeout(resolve, 2300))
    assert.equal(stateRequests.length, hiddenRequestCount, 'hidden sidebar must not maintain a polling or watch request loop')
    await launcher.click()
    await panel.waitFor()
    await until(() => ctx.state?.snapshots.some(snapshot => snapshot.mission.id === missionId && snapshot.mission.status === 'completed'), 'worker acceptance automatically completes the mission', 120_000)
    await until(() => ctx.state?.snapshots.find(snapshot => snapshot.mission.id === missionId)?.members.every(member => member.status !== 'working'), 'completed workers settle to non-working durable status', 30_000)
    const completed = ctx.state.snapshots.find(snapshot => snapshot.mission.id === missionId)
    assert(completed.tasks.every(task => task.status === 'accepted'))
    assert(completed.evidence.length > 0 && completed.evidence.every(evidence => evidence.status === 'verified'))
    assert.equal(ctx.state.starts.find(request => request.missionId === missionId)?.status, 'completed')
    assert.equal(completed.members.length, 2)
    assert(completed.members.every(member => !member.activity), 'completed workers do not retain a fabricated active operation')
    assert.equal(await panel.getAttribute('data-swarm-session'), completed.mission.ownerSessionId, 'reopening retains the selected owner')
    await assertSimplifiedSwarm(panel)
    checks.push('hidden sidebar suspends state requests while workers finish; reopening catches up with the same owner and clears finished activity')
    assert.equal(completed.mission.baseline.sourceHead, sourceHead)
    assert.notEqual(completed.mission.baseline.snapshotCommit, sourceHead)
    assert.deepEqual(completed.mission.baseline.changedPaths.sort(), ['check.cjs', 'user-notes.txt'])
    assert.deepEqual(await readFile(join(workspace, '.git/index')), sourceIndex)
    const artifact = completed.tasks.find(task => task.kind === 'integration').artifact
    assert.equal(await git('show', `${artifact.commit}:value.cjs`), 'module.exports = 2\n')
    assert.equal(await readFile(join(workspace, 'value.cjs'), 'utf8'), 'module.exports = 1\n')
    await panel.locator('[data-swarm-status="completed"]').waitFor()
    await page.locator('[data-swarm-command]').scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(artifacts, 'completed.png'), fullPage: true })
    let failedWatch = false
    const transientFailure = async route => {
      if (!failedWatch) { failedWatch = true; await route.abort('failed') }
      else await route.continue()
    }
    await page.route('**/api/agent-swarm/watch', transientFailure)
    await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
    await until(() => failedWatch, 'a single native watch request is interrupted')
    await panel.locator('[data-swarm-connection="reconnecting"]').waitFor()
    await page.screenshot({ path: join(artifacts, 'reconnecting.png'), fullPage: true })
    const successfulBefore = watchResponses
    await until(() => watchResponses > successfulBefore, 'native watch recovers after transient network failure', 45_000)
    await panel.locator('[data-swarm-connection="connected"]').waitFor()
    await page.unroute('**/agent-swarm/watch', transientFailure)
    assert.equal(ctx.state.ownerSessionId, completed.mission.ownerSessionId)
    assert.equal(ctx.state.snapshots.find(snapshot => snapshot.mission.id === missionId)?.mission.status, 'completed')
    assert.equal(await panel.getAttribute('data-swarm-session'), completed.mission.ownerSessionId)
    checks.push('one failed native watch exposes reconnecting, then resumes without losing the completed mission or changing owner')
    await openSwarmDetails(panel, 'technical')
    await panel.getByRole('tab', { name: /Dependency graph/ }).click()
    await panel.getByRole('tabpanel', { name: 'Dependency graph', exact: true }).waitFor()
    await page.screenshot({ path: join(artifacts, 'dependency-graph.png'), fullPage: true })
    await writeFile(join(artifacts, 'completed.aria.txt'), await page.locator('body').ariaSnapshot())
    checks.push('real sandbox tools, immutable artifact, independent swarm_verify and automatic completed status require no manual Complete')
    await writeFile(join(workspace, 'user-notes.txt'), 'User continued editing during the mission\n')
    const delivery = panel.getByRole('region', { name: 'Collaboration result', exact: true })
    await delivery.getByRole('button', { name: 'View changes', exact: true }).click()
    await delivery.locator('pre').waitFor()
    const diff = await delivery.locator('pre').innerText()
    assert.match(diff, /value\.cjs/)
    assert.doesNotMatch(diff, /Existing staged user work|Existing untracked user work/)
    await delivery.getByRole('button', { name: 'Apply result', exact: true }).click()
    await until(async () => /Result applied/.test(await delivery.innerText()), 'one-click delivery applies only the swarm delta')
    assert.equal(await readFile(join(workspace, 'value.cjs'), 'utf8'), 'module.exports = 2\n')
    assert.equal(await readFile(join(workspace, 'user-notes.txt'), 'utf8'), 'User continued editing during the mission\n')
    assert.deepEqual(await readFile(join(workspace, '.git/index')), sourceIndex)
    assert.equal((await git('rev-parse', 'HEAD')).trim(), sourceHead)
    await page.screenshot({ path: join(artifacts, 'applied.png'), fullPage: true })
    checks.push('dirty source snapshot preserves staged/untracked work; UI previews snapshot-only delta and applies verified result without moving HEAD/index or losing later edits')
    const trace = await readTrace()
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
      assert.equal(repaired[0].requestId, ctx.state.starts[0].id)
      assert.deepEqual(repaired[0].plan.budget, invalid[0].plan.budget, 'the model repair preserves all originally selected allowances')
      assert.deepEqual(repaired[0].plan.acceptance, invalid[0].plan.acceptance)
      assert.deepEqual(repaired[0].plan.tasks.map(task => task.acceptance), invalid[0].plan.tasks.map(task => task.acceptance))
      assert.deepEqual(completed.mission.budget, invalid[0].plan.budget)
      assert.deepEqual(completed.mission.acceptance, invalid[0].plan.acceptance)
      assert(completed.tasks.every(task => JSON.stringify(task.acceptance) === JSON.stringify(invalid[0].plan.acceptance)), 'host admission must preserve the generated acceptance criteria')
      assert.deepEqual(repaired[0].plan.tasks[1].dependencies, ['implement'], 'the scripted retry retains the redundant edge to test the actual host canonicalizer')
      assert(trace.some(event => event.type === 'tool/call' && event.name === 'bash' && event.sessionId === ownerId), 'the owner inspects real repository paths and check contents before repairing')
      assert.equal(ctx.state.snapshots.length, 1)
    }
    assert.equal(trace.filter(event => event.type === 'tool/call' && event.name === 'swarm_stage').length, 0)
    assert.equal(trace.filter(event => event.type === 'tool/call' && event.name === 'swarm_control').length, 0)
    assert(trace.some(event => event.type === 'tool/call' && event.name === 'bash' && event.sessionId !== ownerId))
    assert(trace.some(event => event.type === 'tool/call' && event.name === 'swarm_verify' && event.sessionId !== ownerId))
    assert(trace.filter(event => event.type === 'model/request' && event.sessionId !== ownerId).every(event => event.model === 'swarm-web-primary'), 'workers inherit the current conversation model without configuration')
    assert(trace.filter(event => event.type === 'model/request' && event.sessionId !== ownerId).every(event => event.maxTokens === 4096), 'real worker model requests carry the generated per-response allowance')
    assert(!trace.some(event => event.type === 'fixture/error'), 'the scripted provider must not conceal tool errors')
    assert(!rpcResults.some(result => ['/api/agent-swarm/create-draft', '/api/agent-swarm/update-draft', '/api/agent-swarm/launch-draft', '/api/agent-swarm/control'].includes(result.endpoint)), 'the browser must not secretly submit a manual draft or control flow')
    assert(trace.some(event => event.type === 'user/message' && event.sessionId === ownerId && event.sourceKind === 'swarm-start'))
    assert(!trace.some(event => event.type === 'user/message' && event.sessionId === ownerId && event.sourceKind === 'user'), 'planning guidance is attributed plugin context, never a forged user bubble')
    checks.push(validationRepair
      ? 'durable records prove one user command, an ordinary rejected tool call followed by one corrected launch with unchanged request identity, budgets and acceptance, and no manual lifecycle API calls'
      : 'durable command records prove one user command, one swarm_launch, attributed planning context and no manual lifecycle API calls')
  },
})
