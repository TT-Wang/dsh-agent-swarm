/**
 * Real Harness Loader composition: the live drop3 sequence (2026-10-23,
 * scripts/smoke-command-deepseek.mjs on deepseek-official with thinking
 * disabled). The owner's third swarm_launch named member reasoning efforts its
 * route does not declare; the smoke, reading the saved request's mission link
 * every 250 ms, met "Unknown mission", tore the host down mid-launch, and the
 * tool result read "Error: [object Object]" while the planner's recovery
 * notice woke the owner being disposed ("cannot create effect on inactive
 * context", INACTIVE_EFFECT from the working-directory service).
 *
 * Only the model boundary is scripted. Its route `swarm-smoke` / `flash`
 * declares the one effort "off", as the DeepSeek route does with thinking
 * disabled; the host's own LLM service decides the refusal. The owner plans
 * through the native /agent-swarm command and its real tool loop.
 *  1. The launch is refused by the typed W8 refusal naming the efforts the
 *     route declares, with no effect: no mission, member or worker session,
 *     and the saved request names no mission, so a reader following its link
 *     never meets "Unknown mission". The corrected relaunch, in the same turn,
 *     launches on the chosen efforts and links the mission.
 *  2. swarm_add_member with an undeclared effort is refused the same way.
 *  3. A tool whose runtime call throws a value that is not an Error answers
 *     a readable [tool_failed] refusal, never "[object Object]".
 *  4. A mission notice is not delivered into an owner its disposal cancelled;
 *     it reaches the session's next agent.
 *  5. A launch cancelled by the owner's disposal answers a readable
 *     [tool_cancelled] refusal; the planning failure is recorded with that
 *     text, links no mission, and is not delivered into the disposing owner:
 *     no turn starts on it and no effect meets its unwound scope.
 */
import { resolveHarnessRoot, assertSupportedHarness } from '../scripts/harness-target.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bootHarness, harnessEntry, importHarness } from './fixtures/built-harness.mjs'
import { reasoning, requests, setResponder } from './fixtures/scripted-llm.mjs'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const artifactRoot = resolve(argument('--artifact', project))
const harnessRoot = resolveHarnessRoot(argument('--harness', undefined))
assertSupportedHarness(harnessRoot)
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-swarm-launch-refusal-')))
const workspace = join(temporary, 'workspace')
const runRoot = join(temporary, 'runtime')
const ownerId = 'swarm-refusal-owner'
const teardownOwnerId = 'swarm-teardown-owner'
const ROUTE = { provider: 'swarm-smoke', model: 'flash' }
const DISPOSED = Object.freeze({ kind: 'disposed' })
const texts = message => message.content.filter(block => block.type === 'text').map(block => block.text)
const handledOwnerCommands = new Set()
const modelErrors = []
const sessionEvents = new Map()
let ctx
let ownerHandle
let teardownHandle
let commandCounter = 0
let launchStep = 0
let refusedCheckpoint
let teardownLaunched = false

const budget = { maxTokens: 50_000, maxSteps: 100, maxWorkers: 4, maxDurationMs: 90_000, maxTasks: 20, maxExperiments: 0 }
const plan = (requestId, efforts) => ({
  requestId, planningEpoch: 1,
  title: 'Value two', objective: 'Make value.cjs export 2 and keep node check.cjs passing.', scope: ['value.cjs'], acceptance: ['node check.cjs passes'], budget,
  members: [
    { key: 'impl', role: 'Change value.cjs.', ...(efforts[0] === undefined ? {} : { reasoningEffort: efforts[0] }), maxOutputTokens: 2000 },
    { key: 'rev', role: 'Review the change.', ...(efforts[1] === undefined ? {} : { reasoningEffort: efforts[1] }), maxOutputTokens: 2000 },
  ],
  workstreams: [{ key: 'w', title: 'Value', objective: 'Change and review value.cjs.' }],
  tasks: [{ key: 't', workstreamKey: 'w', title: 'Export two', objective: 'Change value.cjs to export 2.', kind: 'implementation',
    scope: ['value.cjs'], outputs: ['value.cjs'], covers: ['c1'], checks: ['node check.cjs'], assigneeKey: 'impl', maxRecoveryAttempts: 1, checkTimeoutMs: 30_000 }],
})
const requestIdIn = options => options.messages.flatMap(texts).map(text => /^Request id: (\S+)$/m.exec(text)?.[1]).findLast(id => id !== undefined)
const workerAgents = () => ctx.agents.list().filter(agent => agent.id !== ownerId && agent.id !== teardownOwnerId)
const eventsOf = sessionId => sessionEvents.get(sessionId) ?? []

/** What the refused launch left, read while the owner's model decides its repair. */
function refusalState(requestId) {
  return {
    start: ctx.swarm.store.get('starts', requestId),
    missions: ctx.swarm.store.list('missions').length,
    members: ctx.swarm.store.list('members').length,
    workers: workerAgents().length,
  }
}

setResponder(options => {
  if (options.sessionId === ownerId) {
    const command = options.messages.flatMap(texts).findLast(text => text.startsWith('SMOKE_OWNER '))
    if (command && !handledOwnerCommands.has(command)) {
      handledOwnerCommands.add(command)
      const { name, args } = JSON.parse(command.slice(command.indexOf('{')))
      return name === 'hold' ? { kind: 'wait' } : { kind: 'tool', name, args }
    }
    const requestId = requestIdIn(options)
    if (requestId !== undefined && launchStep < 2) {
      // The live owner's plan, then its repair in one retry of the same request.
      if (++launchStep === 2) refusedCheckpoint = refusalState(requestId)
      return { kind: 'tool', name: 'swarm_launch', args: plan(requestId, launchStep === 1 ? ['low', 'medium'] : ['off', undefined]) }
    }
    return { kind: 'text', text: 'Owner turn complete.' }
  }
  if (options.sessionId === teardownOwnerId) {
    const requestId = requestIdIn(options)
    if (requestId !== undefined && !teardownLaunched) {
      teardownLaunched = true
      return { kind: 'tool', name: 'swarm_launch', args: plan(requestId, ['off', 'off']) }
    }
    return { kind: 'text', text: 'Teardown owner turn complete.' }
  }
  // A worker holds its model request open until it is stopped.
  return { kind: 'wait' }
})

/** One owner tool call through the owner's real model and tool loop, and its model-facing result. */
async function ownerCall(name, args) {
  const firstSeq = ownerHandle.agent.session.snapshotEvents().length
  const { createUserMessage } = await importHarness(harnessRoot, '@deepseek-ai/dsh-llm')
  ownerHandle.agent.followup(createUserMessage({
    content: [{ type: 'text', text: `SMOKE_OWNER ${++commandCounter} ${JSON.stringify({ name, args })}` }],
    source: { kind: 'user' },
  }))
  await ownerHandle.agent.whenIdle()
  const events = ownerHandle.agent.session.snapshotEvents().slice(firstSeq)
  assert(events.some(event => event.type === 'tool/call' && event.data.name === name), `${name} must execute through the owner's model and tool loop`)
  const result = events.find(event => event.type === 'tool/result')?.data.message
  assert(result, `${name} must be logged with its model-facing result`)
  const text = texts(result).join('\n')
  return { isError: Boolean(result.isError), text, body: result.isError ? undefined : JSON.parse(text) }
}

async function waitUntil(predicate, description, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out after ${timeout}ms: ${description}`)
}

/** The tool results of one session, in order, with their model-facing text. */
const toolResults = sessionId => eventsOf(sessionId).filter(event => event.type === 'tool/result').map(event => ({ isError: Boolean(event.data.message.isError), text: texts(event.data.message).join('\n') }))
const turnStarts = sessionId => eventsOf(sessionId).filter(event => event.type === 'turn/start')

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'value.cjs'), 'module.exports = 1\n')
  await writeFile(join(workspace, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2); console.log('VERIFIED_TWO')\n")
  for (const gitArgs of [
    ['init', '--quiet'], ['config', 'user.name', 'Swarm Smoke'], ['config', 'user.email', 'swarm-smoke@example.invalid'],
    ['add', '.'], ['commit', '--quiet', '-m', 'fixture baseline'],
  ]) await execute('git', gitArgs, { cwd: workspace })
  reasoning.set(ROUTE.model, { efforts: [{ id: 'off', name: 'Off' }], defaultEffort: 'off' })
  ctx = await bootHarness({ harnessRoot, artifactRoot, runRoot, workspace, swarmConfig: {
    statePath: join(runRoot, 'swarm.sqlite'), workspacesRoot: join(runRoot, 'worktrees'),
    tickMs: 20, leaseMs: 30_000, checkTimeoutMs: 30_000, maxCheckOutputBytes: 16_000,
  } })
  // The exact native command registry, as the live smoke composes it.
  await ctx.loader.create({ id: 'native-commands', name: await harnessEntry(harnessRoot, '@deepseek-ai/dsh-commands') })
  await ctx.loader.await()
  ctx.on('session/event', (session, event) => {
    const id = session.header.id
    if (!sessionEvents.has(id)) sessionEvents.set(id, [])
    sessionEvents.get(id).push(event)
  })
  ctx.on('agent/error', ({ agent, error }) => modelErrors.push({ sessionId: agent.id, code: error?.code, message: error instanceof Error ? error.message : String(error) }))
  const { SessionId } = await importHarness(harnessRoot, '@deepseek-ai/dsh-session')
  ownerHandle = await ctx.agents.create({ sessionId: SessionId(ownerId), meta: { cwd: workspace }, agentOptions: { ...ROUTE } })
  const owner = { sessionId: ownerId }

  // 1. The live owner's launch, through the native command.
  // A reader follows the saved request's mission link the whole time, as the
  // live smoke's poll does; every link it reads must name a readable mission.
  const unreadable = []
  let reading = true
  const reader = (async () => {
    while (reading) {
      for (const start of ctx.swarm.starts(owner)) {
        if (start.missionId === undefined) continue
        try { ctx.swarm.snapshot(owner, start.missionId) } catch (error) { unreadable.push({ status: start.status, missionId: start.missionId, error: error.message }) }
      }
      await new Promise(resolve => setTimeout(resolve, 2))
    }
  })()
  const command = await ctx.commands.execute(ownerHandle.agent, '/agent-swarm Make value.cjs export 2 and keep node check.cjs passing.', [], AbortSignal.timeout(15_000))
  assert.equal(command?.result.kind, 'success', `the native command must accept the request: ${command?.result.text}`)
  const requestId = ctx.swarm.starts(owner)[0].id
  await waitUntil(() => launchStep === 2 && toolResults(ownerId).length === 2 && ownerHandle.agent.status === 'idle', 'the owner launches, is refused and relaunches in one turn')
  reading = false
  await reader
  const [refusedLaunch, relaunch] = toolResults(ownerId)
  assert(refusedLaunch.isError, `the launch must be refused: ${refusedLaunch.text}`)
  assert(!refusedLaunch.text.includes('[object Object]'), refusedLaunch.text)
  for (const [key, chosen] of [['impl', 'low'], ['rev', 'medium']]) {
    const line = `[member_reasoning_effort_unsupported] members[${key}].reasoningEffort: provider "swarm-smoke" model "flash" does not accept reasoning effort "${chosen}"; it accepts "off". Set \`reasoningEffort\` to one it accepts, or omit it and name the member's own \`provider\` and \`model\` to run that route's default, and relaunch the complete plan.`
    assert(refusedLaunch.text.includes(line), `the refusal names ${key} and the effort the route declares:\n${refusedLaunch.text}`)
  }
  // The refusal had no effect, read before the owner's repair ran.
  assert(refusedCheckpoint, 'the owner model must decide its repair after the refusal')
  assert.equal(refusedCheckpoint.missions, 0, 'a refused launch creates no mission')
  assert.equal(refusedCheckpoint.members, 0, 'a refused launch admits no member')
  assert.equal(refusedCheckpoint.workers, 0, 'a refused launch starts no worker session')
  assert.equal(refusedCheckpoint.start.status, 'failed')
  assert.equal(refusedCheckpoint.start.missionId, undefined, 'a refused launch leaves the request naming no mission')
  assert.match(refusedCheckpoint.start.error, /^Error: \[member_reasoning_effort_unsupported\] members\[impl\]\.reasoningEffort/)
  assert.deepEqual(unreadable, [], 'every mission link a reader follows names a readable mission')
  // The corrected relaunch in the same turn launches on the efforts the owner chose.
  assert(!relaunch.isError, `the corrected relaunch must succeed: ${relaunch.text}`)
  const launchedId = ctx.swarm.store.get('starts', requestId).missionId
  assert.equal(launchedId, JSON.parse(relaunch.text).result.mission.id, 'the request links the mission it launched')
  const launched = ctx.swarm.snapshot(owner, launchedId)
  assert.equal(launched.mission.status, 'active')
  assert.deepEqual(launched.members.map(member => member.reasoningEffort), ['off', undefined])
  assert.deepEqual(turnStarts(ownerId).map(event => event.data.turn), [1], 'the refusal and its repair stay in the owner\'s one planning turn')
  await ownerCall('swarm_control', { missionId: launchedId, action: 'stop', reason: 'The launch path has been demonstrated.' })
  await waitUntil(() => workerAgents().length === 0, 'the launched workers stop')

  // 2. A member added on its own, with an effort the route does not declare.
  const missionId = (await ownerCall('swarm_create', {
    title: 'Notices', objective: 'Admit members on the route rule.', workspace, scope: ['value.cjs'], acceptance: ['node check.cjs passes'], budget,
  })).body.result.id
  const refusedMember = await ownerCall('swarm_add_member', { missionId, name: 'Ada', role: 'Change value.cjs.', reasoningEffort: 'low', maxOutputTokens: 2000 })
  assert(refusedMember.isError, `the admission must be refused: ${refusedMember.text}`)
  assert(refusedMember.text.includes('[member_reasoning_effort_unsupported] member.reasoningEffort: provider "swarm-smoke" model "flash" does not accept reasoning effort "low"; it accepts "off".'), refusedMember.text)
  assert(refusedMember.text.endsWith('and add the member again.'), refusedMember.text)
  assert.deepEqual(ctx.swarm.snapshot(owner, missionId).members, [], 'a refused admission leaves no member')
  assert.deepEqual(workerAgents(), [], 'a refused admission starts no worker session')
  const ada = (await ownerCall('swarm_add_member', { missionId, name: 'Ada', role: 'Change value.cjs.', reasoningEffort: 'off', maxOutputTokens: 2000 })).body.result
  assert.equal(ada.reasoningEffort, 'off')

  // 3. A runtime call that throws a value that is not an Error.
  for (const [thrown, text] of [
    [Object.freeze({ kind: 'store-offline' }), '{"kind":"store-offline"}'],
    [(() => { const cyclic = { kind: 'cyclic' }; cyclic.self = cyclic; return cyclic })(), 'a thrown value that cannot be read'],
    [undefined, 'undefined'],
  ]) {
    ctx.swarm.observe = () => { throw thrown }
    let failed
    try { failed = await ownerCall('swarm_observe', { missionId }) } finally { delete ctx.swarm.observe }
    assert(failed.isError)
    assert.equal(failed.text, `Error: [tool_failed] swarm_observe failed with a thrown value that is not an Error: ${text}. Read the current state with swarm_observe before calling swarm_observe again.`)
  }

  // 4. A mission notice while the owner's disposal has cancelled it: the
  // Harness cancels an agent it disposes with cause `disposed`, then awaits
  // its quiescence before unwinding it. The owner is held in a model request
  // and cancelled the same way; its disposal has not run yet.
  const { createUserMessage } = await importHarness(harnessRoot, '@deepseek-ai/dsh-llm')
  ownerHandle.agent.followup(createUserMessage({ content: [{ type: 'text', text: `SMOKE_OWNER ${++commandCounter} ${JSON.stringify({ name: 'hold' })}` }], source: { kind: 'user' } }))
  await waitUntil(() => requests.some(entry => entry.sessionId === ownerId && entry.messages.flatMap(texts).some(text => text.includes('"hold"'))), 'the owner holds a model request')
  ownerHandle.agent.cancel(DISPOSED)
  await ownerHandle.agent.whenIdle()
  const cancelledTurns = turnStarts(ownerId).length
  assert.deepEqual(eventsOf(ownerId).findLast(event => event.type === 'turn/end').data.reason, { kind: 'aborted', reason: { kind: 'disposed' } })
  const adaSession = ctx.swarm.snapshot(owner, missionId).members[0].sessionId
  ctx.swarm.message({ sessionId: adaSession }, missionId, { to: 'owner', kind: 'finding', content: 'value.cjs exports 1 today.' })
  const finding = () => ctx.swarm.store.list('deliveries', missionId).find(delivery => delivery.to === 'owner' && delivery.content === 'value.cjs exports 1 today.')
  assert(finding(), 'the finding is queued for the owner')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(turnStarts(ownerId).length, cancelledTurns, 'no turn starts on an owner its disposal cancelled')
  assert.equal(finding().deliveredAt, undefined, 'the notice stays in the durable outbox')
  await ownerHandle.dispose()
  // The session's next agent receives it.
  ownerHandle = await ctx.agents.resume({ resumeSessionId: SessionId(ownerId), agentOptions: { ...ROUTE } })
  await waitUntil(() => finding().deliveredAt !== undefined, 'the notice reaches the session\'s next agent')
  await waitUntil(() => requests.some(entry => entry.sessionId === ownerId && entry.messages.flatMap(texts).some(text => text.includes('value.cjs exports 1 today.'))), 'the next agent\'s model reads the notice')
  await ownerHandle.agent.whenIdle()
  await ownerCall('swarm_control', { missionId, action: 'stop', reason: 'The notice path has been demonstrated.' })
  await waitUntil(() => workerAgents().length === 0, 'the mission workers stop')

  // 5. The live teardown, as the smoke tore its host down: while swarm_launch
  // runs, the owner is cancelled for disposal and disposed at once.
  teardownHandle = await ctx.agents.create({ sessionId: SessionId(teardownOwnerId), meta: { cwd: workspace }, agentOptions: { ...ROUTE } })
  const teardownOwner = { sessionId: teardownOwnerId }
  let cancelledAt, disposal
  const unsubscribe = ctx.swarm.subscribe(() => {
    const start = ctx.swarm.starts(teardownOwner)[0]
    if (start?.status === 'launching' && disposal === undefined) {
      cancelledAt = start.status
      teardownHandle.agent.cancel(DISPOSED)
      disposal = teardownHandle.dispose()
    }
  })
  try {
    const started = await ctx.commands.execute(teardownHandle.agent, '/agent-swarm Make value.cjs export 2.', [], AbortSignal.timeout(15_000))
    assert.equal(started?.result.kind, 'success')
    await waitUntil(() => disposal !== undefined, 'the owner is disposed while its launch runs')
    await disposal
  } finally { unsubscribe() }
  teardownHandle = undefined
  assert.equal(cancelledAt, 'launching', 'the disposal cancelled the owner while its launch ran')
  const [cancelled, ...later] = toolResults(teardownOwnerId)
  assert.deepEqual(later, [])
  assert(cancelled.isError)
  assert.equal(cancelled.text, 'Error: [tool_cancelled] swarm_launch was cancelled by its session ({"kind":"disposed"}) before it returned. What it committed before the cancellation stands: read the current state with swarm_observe before calling swarm_launch again.')
  assert.deepEqual(turnStarts(teardownOwnerId).map(event => event.data.turn), [1], 'the planning failure opens no turn on the disposing owner')
  assert.deepEqual(modelErrors, [], 'no turn met an unwound scope (INACTIVE_EFFECT), and no model step failed')
  const recorded = ctx.swarm.starts(teardownOwner)[0]
  assert.equal(recorded.status, 'failed')
  assert.equal(recorded.missionId, undefined, 'a launch cancelled before its mission existed links none')
  assert(recorded.error.includes('[tool_cancelled] swarm_launch was cancelled by its session ({"kind":"disposed"})'), recorded.error)
  assert.equal(recorded.recoveryNoticePending, true, 'the recovery notice stays pending for the session\'s next agent')
  assert.equal(ctx.swarm.store.list('missions').length, 2, 'the cancelled launch created no mission')
  process.stdout.write('Real Harness Loader composition passed: a launch and an admission on undeclared efforts are refused with the efforts the route declares and no effect, the request links only a mission that exists, a non-Error tool failure and a cancelled launch answer readable typed refusals, and no notice wakes an owner its disposal cancelled.\n')
} finally {
  await teardownHandle?.dispose().catch(() => {})
  await ownerHandle?.dispose()
  await ctx?.fiber.dispose()
  await rm(temporary, { recursive: true, force: true })
}
