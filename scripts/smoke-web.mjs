import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { composerFor, runWebSmoke, writeComposerDraft } from './web-smoke-browser.mjs'
import { assertSimplifiedSwarm, openSwarmDetails } from './swarm-smoke-checks.mjs'

/** A member's conversation button in the overview, expanding the team roster as a user would. */
async function memberButton(panel, member) {
  const roster = panel.locator('[data-swarm-team] > button[aria-expanded]')
  if (await roster.getAttribute('aria-expanded') !== 'true') await roster.click()
  const button = panel.locator(`button[data-swarm-member="${member.id}"]`)
  await button.waitFor()
  return button
}

/** The model stages a plan; the browser edits, launches, pauses, completes and stops missions through the sidebar. */
await runWebSmoke({ name: 'web', scriptedLlm: { owner: 'stage' }, async scenario(page, ctx) {
  const { artifacts, checks, git, readTrace, releasePath, until, workspace } = ctx
  async function clickRpc(locator, endpoint) {
    const [response] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === `/api/agent-swarm/${endpoint}` && response.request().method() === 'POST'),
      locator.click(),
    ])
    assert.equal(response.status(), 200)
    const result = (await response.json()).result
    assert.equal(result.ok, true, `native ${endpoint} RPC failed: ${JSON.stringify(result)}`)
    return result.value
  }
  const composer = composerFor(page)
  await writeComposerDraft(page, composer, 'Prepare a staged swarm for browser validation. Change value.cjs to two and have an independent reviewer verify it.')
  await composer.press('Enter')
  await page.getByText('Draft ready for review. Edit the workers and launch when ready.', { exact: true }).waitFor({ timeout: 30_000 })
  // The host's right sidebar carries the panel as a native tab; its footer launcher opens it.
  const panel = page.locator('[data-swarm-panel]').filter({ visible: true })
  const launcher = page.locator('[data-swarm-native-launcher]')
  if (!await panel.isVisible()) await launcher.click()
  await panel.waitFor()
  await until(() => ctx.state?.drafts.length === 1, 'staged draft visible through native state transport')
  assert.equal(ctx.state.snapshots.length, 0, 'staging a plan must not create an executing mission')
  const stagedTrace = await readTrace()
  const stagedOwner = stagedTrace.find(event => event.type === 'owner/session').sessionId
  assert(stagedTrace.filter(event => event.type === 'model/request').every(event => event.sessionId === stagedOwner), 'workers must not execute before browser launch')
  checks.push('model-staged topology is visible before launch with no worker execution')
  await assertSimplifiedSwarm(panel)
  await openSwarmDetails(panel, 'editor')
  checks.push('default staged view hides technical tabs, budgets and manual plan fields until its advanced disclosure is opened')
  await page.getByTestId('draft-title').fill('Unsaved sidebar draft')
  assert.equal(await page.locator('[data-swarm-dock]').count(), 0, 'no plugin-owned dock renders beside the host right sidebar')
  await until(async () => {
    const box = await panel.boundingBox()
    const input = await composer.boundingBox()
    return box && input && input.x + input.width <= box.x + 1
  }, 'the host right sidebar places the panel beside the conversation without covering its input')
  await page.getByRole('button', { name: 'Collapse right sidebar', exact: true }).click()
  await until(async () => !await panel.isVisible(), 'collapsing the host right sidebar hides the panel')
  assert.equal(await launcher.getAttribute('aria-label'), 'Open swarm sidebar')
  await launcher.click()
  await panel.waitFor()
  assert.equal(await page.getByTestId('draft-title').inputValue(), 'Unsaved sidebar draft', 'collapse and reopen must preserve unsaved plan edits')
  checks.push('the host right sidebar carries the panel beside the conversation; collapsing it and reopening through the native launcher preserve unsaved plan edits')
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
  await until(() => ctx.state?.snapshots.some(snapshot => snapshot.mission.id === missionId && snapshot.tasks.some(task => task.status === 'running')), 'live running assignment in browser transport')
  const paused = await clickRpc(page.locator('[data-action="pause"]'), 'control')
  assert.equal(paused.snapshot.mission.status, 'paused')
  await panel.locator('[data-swarm-status="paused"]').waitFor()
  await page.locator('[data-action="resume"]').waitFor()
  await page.screenshot({ path: join(artifacts, 'paused.png'), fullPage: true })
  await writeFile(releasePath, 'release deterministic model responses\n')
  const resumed = await clickRpc(page.locator('[data-action="resume"]'), 'control')
  assert.equal(resumed.snapshot.mission.status, 'active')
  checks.push('live mission Pause/Resume controls, cancellation and reassignment')
  await until(() => ctx.state?.snapshots.find(snapshot => snapshot.mission.id === missionId)?.tasks.every(task => task.status === 'accepted'), 'live accepted task state without owner swarm_observe', 45_000)
  // Idle members sit in the overview's collapsed roster, working members in the
  // live lanes; every row is a button that opens that member's conversation.
  const builderButton = await memberButton(panel, builder)
  assert.equal(await panel.locator('button[data-swarm-member]').count(), launched.snapshot.members.length, 'the overview lists every member exactly once')
  await builderButton.click()
  const workerPanel = page.locator(`[data-swarm-panel][data-swarm-session="${builder.sessionId}"]`).filter({ visible: true })
  await until(async () => await workerPanel.isVisible() || !await panel.isVisible(), 'native navigation to the worker conversation')
  // The host right sidebar is per conversation: the worker's opens from the same native launcher.
  if (!await workerPanel.isVisible()) await launcher.click()
  await workerPanel.waitFor()
  await until(() => ctx.state?.ownerSessionId === builder.sessionId && ctx.state.writable === false, 'native active worker conversation navigation and read-only swarm view')
  await panel.getByText('Mission controls are read-only in worker conversations. Open the owner conversation to manage this mission.', { exact: true }).waitFor()
  await page.getByText('Assignment finished; awaiting further work.', { exact: true }).first().waitFor()
  await page.screenshot({ path: join(artifacts, 'worker-conversation.png'), fullPage: true })
  assert.equal(await panel.locator('[data-action="complete"]').count(), 0, 'worker view must not expose mission mutation controls')
  checks.push('active worker conversation opened through native navigation with read-only swarm context')
  const sessions = page.getByRole('tree', { name: 'Sessions', exact: true })
  if (!await sessions.isVisible()) await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  await sessions.getByRole('treeitem', { name: /^Prepare a staged swarm for / }).click()
  await until(() => ctx.state?.ownerSessionId === ownerSessionId && ctx.state.writable === true, 'native sidebar returns to the owner conversation')
  await openSwarmDetails(panel, 'technical')
  const completed = await clickRpc(page.locator('[data-action="complete"]'), 'control')
  assert.equal(completed.snapshot.mission.status, 'completed')
  await panel.locator('[data-swarm-status="completed"]').waitFor()
  assert(completed.snapshot.evidence.every(evidence => evidence.status === 'verified'))
  const artifact = completed.snapshot.tasks.find(task => task.kind === 'integration').artifact
  assert.equal(await git('show', `${artifact.commit}:value.cjs`), 'module.exports = 2\n')
  assert.equal(await readFile(join(workspace, 'value.cjs'), 'utf8'), 'module.exports = 1\n')
  checks.push('actual sandboxed worker tools, host evidence, independent verification and immutable artifact')
  await page.screenshot({ path: join(artifacts, 'completed.png'), fullPage: true })
  await writeFile(join(artifacts, 'completed.aria.txt'), await page.locator('body').ariaSnapshot())
  await openSwarmDetails(panel, 'technical')
  await panel.getByRole('tab', { name: /Dependency graph/ }).click()
  await panel.getByRole('tabpanel', { name: 'Dependency graph', exact: true }).waitFor()
  await page.screenshot({ path: join(artifacts, 'dependency-graph.png'), fullPage: true })
  await writeFile(join(artifacts, 'dependency-graph.aria.txt'), await panel.ariaSnapshot())
  checks.push('dependency graph tab exposes its correctly named accessible tabpanel')
  await panel.getByRole('tab', { name: /Work board/ }).click()
  await panel.getByRole('tabpanel', { name: 'Work board', exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await until(async () => {
    const box = await panel.boundingBox()
    return box && box.x >= -1 && box.x + box.width <= 391
  }, 'at 390px the host right sidebar keeps the panel inside the viewport')
  await page.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: true })
  checks.push('390px layout keeps the native swarm tab inside the viewport')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await until(async () => {
    const box = await panel.boundingBox()
    const input = await composer.boundingBox()
    return box && input && input.x + input.width <= box.x + 1
  }, 'desktop layout restores the panel beside the conversation')
  const trace = await readTrace()
  assert(!trace.some(event => event.type === 'fixture/error'), 'model fixture must not hide tool errors')
  assert(trace.some(event => event.type === 'tool/call' && event.sessionId === builder.sessionId && event.name === 'bash'))
  assert(trace.some(event => event.type === 'tool/call' && event.sessionId === reviewer.sessionId && event.name === 'swarm_verify'))
  assert(!trace.some(event => event.type === 'tool/call' && event.sessionId === ownerSessionId && event.name === 'swarm_observe'), 'browser state must update without an owner model observation')
  assert(trace.filter(event => event.type === 'model/request' && event.sessionId === builder.sessionId).every(event => event.model === 'swarm-web-review'), 'launched worker must actually use the browser-selected model')
  assert(trace.filter(event => event.type === 'model/request' && event.sessionId === builder.sessionId).every(event => event.reasoningEffort === 'high'), 'launched worker must actually use the browser-selected reasoning effort')
  checks.push('live board updates without owner observation; selected model and reasoning used by actual worker loop')
  // A second bounded plan covers Stop without replacing the completed deliverable above.
  await rm(releasePath)
  const messageBox = composerFor(page)
  await writeComposerDraft(page, messageBox, 'Prepare a staged swarm for browser validation. This second mission is for the Stop control check.')
  await messageBox.press('Enter')
  if (!await panel.isVisible()) await launcher.click()
  await until(() => ctx.state?.drafts.find(draft => draft.status === 'draft' && draft.id !== saved.draft.id), 'second model-staged draft')
  const secondDraft = ctx.state.drafts.find(draft => draft.status === 'draft' && draft.id !== saved.draft.id)
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
  const beforeHistory = await readTrace()
  const workerRequests = events => events.filter(event => event.type === 'model/request' && [builder.sessionId, reviewer.sessionId].includes(event.sessionId)).length
  await (await memberButton(panel, builder)).click()
  const transcript = panel.locator(`[data-swarm-transcript="${builder.sessionId}"]`)
  await transcript.waitFor()
  await until(async () => (await transcript.innerText()).includes('VERIFIED_TWO'), 'persisted worker transcript contains the actual host tool output')
  assert.equal(ctx.state.ownerSessionId, ownerSessionId, 'cold history must leave the native owner conversation selected')
  await page.screenshot({ path: join(artifacts, 'completed-worker-history.png'), fullPage: true })
  await panel.locator('[data-action="close-transcript"]').click()
  const finalTrace = await readTrace()
  assert.equal(workerRequests(finalTrace), workerRequests(beforeHistory), 'viewing persisted history must not reactivate model workers')
  checks.push('completed worker transcript opens from native persisted history without model worker activation')
  assert.equal(finalTrace.filter(event => event.type === 'tool/call' && event.name === 'swarm_stage').length, 2, 'only the two explicit user requests may stage plans')
} })
