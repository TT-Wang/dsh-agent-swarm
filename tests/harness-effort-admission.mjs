/**
 * Real Harness Loader composition: W8, a member's reasoning effort the route
 * does not take is decided at admission, by one rule, and a step the route
 * refuses after admission retires the member once.
 *
 * Only the model boundary is scripted. Its route `swarm-smoke` / `reasoning`
 * declares the efforts "off" and "high" (`reasoning` in
 * tests/fixtures/scripted-llm.mjs); the host's own LLM service decides every
 * refusal, at admission (`llm.resolveCallConfig`) and at a step (`prepareCall`).
 * The owner's model calls the swarm tools through its real tool loop.
 *  1. `swarm_launch` with a member effort the route does not take is refused
 *     before any effect, naming the members and the efforts it accepts; the
 *     same request relaunches with the repaired plan, on the chosen efforts.
 *  2. `swarm_add_member` with one is refused the same way; the repaired
 *     admission runs on the effort the owner chose.
 *  3. The route stops taking an admitted member's effort. Its next step is
 *     refused by the host before any provider request, and the member is
 *     retired once: its work is released to a live member and the owner's
 *     model is told, with no loop of failures.
 */
import { resolveHarnessRoot, assertSupportedHarness } from '../scripts/harness-target.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { bootHarness, importHarness } from './fixtures/built-harness.mjs'
import { reasoning, requests, setResponder } from './fixtures/scripted-llm.mjs'

const execute = promisify(execFile)
const project = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const argument = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback
const artifactRoot = resolve(argument('--artifact', project))
const harnessRoot = resolveHarnessRoot(argument('--harness', undefined))
assertSupportedHarness(harnessRoot)
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dsh-swarm-effort-')))
const workspace = join(temporary, 'workspace')
const runRoot = join(temporary, 'runtime')
const ownerId = 'swarm-effort-owner'
const ROUTE = { provider: 'swarm-smoke', model: 'reasoning' }
const effort = (id, name) => ({ id, name })
const texts = message => message.content.filter(block => block.type === 'text').map(block => block.text)
const handledOwnerCommands = new Set()
let ctx
let ownerHandle
let commandCounter = 0

setResponder(options => {
  if (options.sessionId === ownerId) {
    const command = options.messages.flatMap(texts).findLast(text => text.startsWith('SMOKE_OWNER '))
    if (command && !handledOwnerCommands.has(command)) {
      handledOwnerCommands.add(command)
      const { name, args } = JSON.parse(command.slice(command.indexOf('{')))
      return { kind: 'tool', name, args }
    }
    return { kind: 'text', text: 'Owner turn complete.' }
  }
  // A worker holds its model request open until it is stopped: this
  // composition is about which steps reach the provider, not what they do.
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
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out after ${timeout}ms: ${description}`)
}

const budget = { maxTokens: 50_000, maxSteps: 100, maxWorkers: 4, maxDurationMs: 90_000, maxTasks: 20, maxExperiments: 0 }
const config = {
  statePath: join(runRoot, 'swarm.sqlite'), workspacesRoot: join(runRoot, 'worktrees'),
  tickMs: 20, leaseMs: 30_000, checkTimeoutMs: 30_000, maxCheckOutputBytes: 16_000,
}
const workerAgents = () => ctx.agents.list().filter(agent => agent.id !== ownerId)
const snapshot = missionId => ctx.swarm.snapshot({ sessionId: ownerId }, missionId)
const eventsOf = (missionId, type) => ctx.swarm.store.events(missionId, 500).filter(event => event.type === type)

try {
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'value.cjs'), 'module.exports = 1\n')
  await writeFile(join(workspace, 'check.cjs'), "require('node:assert/strict').equal(require('./value.cjs'), 2); console.log('VERIFIED_TWO')\n")
  for (const gitArgs of [
    ['init', '--quiet'], ['config', 'user.name', 'Swarm Smoke'], ['config', 'user.email', 'swarm-smoke@example.invalid'],
    ['add', '.'], ['commit', '--quiet', '-m', 'fixture baseline'],
  ]) await execute('git', gitArgs, { cwd: workspace })
  reasoning.set(ROUTE.model, { efforts: [effort('off', 'Off'), effort('high', 'High')], defaultEffort: 'off' })
  ctx = await bootHarness({ harnessRoot, artifactRoot, runRoot, workspace, swarmConfig: config })
  const { SessionId } = await importHarness(harnessRoot, '@deepseek-ai/dsh-session')
  ownerHandle = await ctx.agents.create({ sessionId: SessionId(ownerId), meta: { cwd: workspace }, agentOptions: { ...ROUTE } })

  // 1. A launch plan whose member effort the route does not take.
  // The command layer is not part of this composition; the saved request is the one /agent-swarm records.
  const owner = { sessionId: ownerId }
  let request = ctx.swarm.requestStart(owner, { commandId: 'effort-admission', goal: 'Make value.cjs export 2.', workspace }, { grantRoot: workspace, source: 'session' })
  request = await ctx.swarm.prepareStart(owner, request.id, 1)
  const plan = efforts => ({
    requestId: request.id, planningEpoch: 1,
    title: 'Value two', objective: 'Make value.cjs export 2 and keep node check.cjs passing.', scope: ['value.cjs'], acceptance: ['node check.cjs passes'], budget,
    members: [
      { key: 'fixer', role: 'Change value.cjs.', reasoningEffort: efforts[0], maxOutputTokens: 2000 },
      { key: 'checker', role: 'Review the change.', reasoningEffort: efforts[1], maxOutputTokens: 2000 },
    ],
    workstreams: [{ key: 'w', title: 'Value', objective: 'Change and review value.cjs.' }],
    tasks: [{ key: 't', workstreamKey: 'w', title: 'Export two', objective: 'Change value.cjs to export 2.', kind: 'implementation',
      scope: ['value.cjs'], outputs: ['value.cjs'], covers: ['c1'], checks: ['node check.cjs'], assigneeKey: 'fixer', maxRecoveryAttempts: 1, checkTimeoutMs: 30_000 }],
  })
  const refusedLaunch = await ownerCall('swarm_launch', plan(['low', 'max']))
  assert(refusedLaunch.isError, `the launch must be refused: ${refusedLaunch.text}`)
  const accepts = '; it accepts "off", "high". Set `reasoningEffort` to one it accepts, or omit it and name the member\'s own `provider` and `model` to run that route\'s default, and relaunch the complete plan.'
  for (const [key, chosen] of [['fixer', 'low'], ['checker', 'max']]) {
    const line = `[member_reasoning_effort_unsupported] members[${key}].reasoningEffort: provider "swarm-smoke" model "reasoning" does not accept reasoning effort "${chosen}"${accepts}`
    assert(refusedLaunch.text.includes(line), `the refusal names ${key} and the efforts the route accepts:\n${refusedLaunch.text}`)
  }
  assert.equal(ctx.swarm.store.list('missions').length, 0, 'a refused launch creates no mission')
  assert.equal(ctx.swarm.store.list('members').length, 0, 'a refused launch admits no member')
  assert.deepEqual(workerAgents(), [], 'a refused launch starts no worker session')
  // One retry of the same request with the repaired plan launches, on exactly the efforts the owner chose.
  const launch = await ownerCall('swarm_launch', plan(['high', 'off']))
  assert(!launch.isError, `the repaired launch must succeed: ${launch.text}`)
  const launchedId = ctx.swarm.store.get('starts', request.id).missionId
  assert.equal(snapshot(launchedId).mission.status, 'active')
  const launched = snapshot(launchedId).members
  assert.deepEqual(launched.map(member => member.reasoningEffort), ['high', 'off'])
  const fixer = launched[0]
  await waitUntil(() => requests.some(entry => entry.sessionId === fixer.sessionId), 'the fixer reaches the provider')
  assert.equal(requests.find(entry => entry.sessionId === fixer.sessionId).reasoningEffort, 'high', 'the provider receives the effort the owner chose, not a downgrade')
  await ownerCall('swarm_control', { missionId: launchedId, action: 'stop', reason: 'The launch path has been demonstrated.' })
  await waitUntil(() => workerAgents().length === 0, 'the launched workers stop')

  // 2. A member added on its own, with an effort the route does not take.
  const missionId = (await ownerCall('swarm_create', {
    title: 'Route change', objective: 'Keep working when a member route stops taking its effort.',
    workspace, scope: ['value.cjs'], acceptance: ['node check.cjs passes'], budget,
  })).body.result.id
  const stream = (await ownerCall('swarm_workstream', { missionId, title: 'Value', objective: 'Change value.cjs.' })).body.result
  const refusedMember = await ownerCall('swarm_add_member', { missionId, name: 'Ada', role: 'Change value.cjs.', reasoningEffort: 'low' })
  assert(refusedMember.isError, `the admission must be refused: ${refusedMember.text}`)
  assert(refusedMember.text.includes('[member_reasoning_effort_unsupported] member.reasoningEffort: provider "swarm-smoke" model "reasoning" does not accept reasoning effort "low"; it accepts "off", "high".'), refusedMember.text)
  assert(refusedMember.text.includes('and add the member again.'), refusedMember.text)
  assert.deepEqual(snapshot(missionId).members, [], 'a refused admission leaves no member behind')
  assert.deepEqual(workerAgents(), [])
  const ada = (await ownerCall('swarm_add_member', { missionId, name: 'Ada', role: 'Change value.cjs.', reasoningEffort: 'high', maxOutputTokens: 2000 })).body.result
  assert.equal(ada.reasoningEffort, 'high')
  const alan = (await ownerCall('swarm_add_member', { missionId, name: 'Alan', role: 'Change value.cjs.', maxOutputTokens: 2000 })).body.result

  // 3. The route stops taking Ada's effort after her admission: her next step is refused by the host.
  reasoning.set(ROUTE.model, { efforts: [effort('off', 'Off')], defaultEffort: 'off' })
  const task = (await ownerCall('swarm_propose', {
    missionId, workstreamId: stream.id, title: 'Export two', objective: 'Change value.cjs to export 2.', kind: 'implementation',
    scope: ['value.cjs'], outputs: ['value.cjs'], covers: ['c1'], checks: ['node check.cjs'], assigneeId: ada.id,
  })).body.result
  const refused = await waitUntil(() => eventsOf(missionId, 'member/route-refused')[0], 'the refused step retires Ada')
  assert.equal(refused.data.memberId, ada.id)
  assert.equal(refused.data.code, 'UNSUPPORTED_REASONING_EFFORT')
  assert.match(refused.data.error, /does not support reasoning effort "high"/)
  assert.equal(snapshot(missionId).members.find(member => member.id === ada.id).status, 'stopped')
  // The released task runs on Alan, whose route takes his (default) effort.
  await waitUntil(() => {
    const current = snapshot(missionId).tasks.find(item => item.id === task.id)
    return current.status === 'running' && current.attempt?.ownerId === alan.id
  }, 'the released task runs on the live member')
  await waitUntil(() => requests.some(entry => entry.sessionId === alan.sessionId), 'Alan reaches the provider')
  // The owner's model reads the typed notice with its exit.
  await waitUntil(() => requests.some(entry => entry.sessionId === ownerId && entry.messages.some(message => texts(message).some(text => text.includes(`[member_route_refused] Ada (${ada.id}) was stopped`)))),
    'the owner model is told')
  const notice = ctx.swarm.store.list('deliveries', missionId).filter(delivery => delivery.to === 'owner' && delivery.content.startsWith('[member_route_refused]'))
  assert.equal(notice.length, 1)
  assert.match(notice[0].content, /refused a model step with UNSUPPORTED_REASONING_EFFORT/)
  assert.match(notice[0].content, /Admit a replacement with `swarm_add_member`/)
  // No loop: the refusal reached no provider, was reported once, and nothing retries Ada.
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal(requests.filter(entry => entry.sessionId === ada.sessionId).length, 0, 'the host refused the step before any provider request')
  assert.equal(eventsOf(missionId, 'member/route-refused').length, 1)
  assert.deepEqual(eventsOf(missionId, 'member/failure'), [], 'the refusal is reported as itself, never also as a member failure')
  assert.equal(ctx.agents.get(SessionId(ada.sessionId)), undefined, 'the retired member\'s session is stopped')
  await ownerCall('swarm_control', { missionId, action: 'stop', reason: 'The route refusal has been demonstrated.' })
  process.stdout.write('Real Harness Loader composition passed: a launch and an admission refuse an effort the route does not take, naming the efforts it accepts; a step the route refuses after admission retires the member once and releases its work.\n')
} finally {
  await ownerHandle?.dispose()
  await ctx?.fiber.dispose()
  await rm(temporary, { recursive: true, force: true })
}
